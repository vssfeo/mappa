//! Line-of-sight, first Fresnel zone and terrain viewshed.
//!
//! The pure functions take a terrain sampler so they can be tested without a
//! DEM file; the Tauri commands bind them to the active elevation model.

use serde::{Deserialize, Serialize};

const EARTH_RADIUS: f64 = 6_371_000.0;
/// Effective earth radius factor (standard refraction).
const K_FACTOR: f64 = 4.0 / 3.0;

/// One sample along a radio link.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LosPoint {
    pub distance_m: f64,
    /// Terrain height above sea level.
    pub terrain_m: f64,
    /// Straight line between the two antennas.
    pub los_m: f64,
    /// First Fresnel zone radius at this point.
    pub fresnel_m: f64,
    /// LOS altitude minus the terrain (negative means the ground blocks).
    pub clearance_m: f64,
}

/// Result of a line-of-sight check.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LosReport {
    pub points: Vec<LosPoint>,
    pub distance_m: f64,
    /// The link is blocked when any interior sample has no clearance.
    pub blocked: bool,
    /// Smallest clearance over the interior samples, metres.
    pub min_clearance_m: f64,
    /// Fraction of the first Fresnel zone that is free at the tightest point.
    pub fresnel_fraction: f64,
    pub frequency_ghz: f64,
}

/// Visible area around an observer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewshedResult {
    /// Closed ring of [lon, lat] points, one per azimuth.
    pub polygon: Vec<[f64; 2]>,
    pub area_km2: f64,
    pub max_distance_m: f64,
    pub rays: u32,
}

/// Sample count used by [`los`] when the caller has no preference.
pub const DEFAULT_SAMPLES: usize = 256;

fn destination(lon: f64, lat: f64, bearing: f64, distance: f64) -> (f64, f64) {
    let delta = distance / EARTH_RADIUS;
    let phi1 = lat.to_radians();
    let theta = bearing.to_radians();
    let sin_phi2 =
        (phi1.sin() * delta.cos() + phi1.cos() * delta.sin() * theta.cos()).clamp(-1.0, 1.0);
    let phi2 = sin_phi2.asin();
    let y = theta.sin() * delta.sin() * phi1.cos();
    let x = delta.cos() - phi1.sin() * sin_phi2;
    let lon2 = lon.to_radians() + y.atan2(x);
    (lon2.to_degrees(), phi2.to_degrees())
}

/// Great-circle distance in metres.
pub fn distance_m(from: (f64, f64), to: (f64, f64)) -> f64 {
    let (lon1, lat1) = (from.0.to_radians(), from.1.to_radians());
    let (lon2, lat2) = (to.0.to_radians(), to.1.to_radians());
    let dlat = lat2 - lat1;
    let dlon = lon2 - lon1;
    let a = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS * a.sqrt().asin()
}

/// First Fresnel zone radius in metres; distances in metres, frequency in GHz.
pub fn fresnel_radius(d1_m: f64, d2_m: f64, frequency_ghz: f64) -> f64 {
    if frequency_ghz <= 0.0 {
        return 0.0;
    }
    17.32
        * ((d1_m * d2_m) / (frequency_ghz * (d1_m + d2_m)))
            .max(0.0)
            .sqrt()
}

/// Terrain bulge caused by earth curvature between the two ends.
fn curvature_drop(d1_m: f64, d2_m: f64) -> f64 {
    (d1_m * d2_m) / (2.0 * EARTH_RADIUS * K_FACTOR)
}

/// Computes the radio profile between two points.
pub fn los(
    sample: &dyn Fn(f64, f64) -> Option<f64>,
    from: [f64; 2],
    to: [f64; 2],
    observer_height: f64,
    target_height: f64,
    frequency_ghz: f64,
    samples: usize,
) -> Result<LosReport, String> {
    let samples = samples.clamp(16, 2048);
    if !from.iter().chain(to.iter()).all(|value| value.is_finite()) {
        return Err("the link has invalid coordinates".to_owned());
    }
    if !(0.0..=1000.0).contains(&observer_height) || !(0.0..=1000.0).contains(&target_height) {
        return Err("antenna heights must be between 0 and 1000 m".to_owned());
    }
    if !(0.1..=100.0).contains(&frequency_ghz) {
        return Err("frequency must be between 0.1 and 100 GHz".to_owned());
    }

    let total = distance_m((from[0], from[1]), (to[0], to[1]));
    if total < 1.0 {
        return Err("the two points are too close".to_owned());
    }

    let mut terrain = Vec::with_capacity(samples);
    for index in 0..samples {
        let t = index as f64 / (samples - 1) as f64;
        let (lon, lat) = if index == 0 {
            (from[0], from[1])
        } else if index == samples - 1 {
            (to[0], to[1])
        } else {
            let bearing = initial_bearing((from[0], from[1]), (to[0], to[1]));
            destination(from[0], from[1], bearing, total * t)
        };
        let height =
            sample(lon, lat).ok_or_else(|| "the link leaves the elevation model".to_owned())?;
        terrain.push(height);
    }

    let observer_alt = terrain[0] + observer_height;
    let target_alt = terrain[samples - 1] + target_height;

    let mut points = Vec::with_capacity(samples);
    let mut blocked = false;
    let mut min_clearance = f64::INFINITY;
    let mut fresnel_fraction = 1.0;
    for (index, height) in terrain.iter().enumerate() {
        let t = index as f64 / (samples - 1) as f64;
        let d1 = total * t;
        let d2 = total - d1;
        let los_alt = observer_alt + (target_alt - observer_alt) * t;
        let bulge = curvature_drop(d1, d2);
        let fresnel = fresnel_radius(d1, d2, frequency_ghz);
        let terrain_effective = height + bulge;
        let clearance = los_alt - terrain_effective;
        if index > 0 && index + 1 < samples {
            if clearance <= 0.0 {
                blocked = true;
            }
            if clearance < min_clearance {
                min_clearance = clearance;
                fresnel_fraction = if fresnel > 0.0 {
                    (clearance / fresnel).clamp(-1.0, 1.0)
                } else {
                    1.0
                };
            }
        }
        points.push(LosPoint {
            distance_m: d1,
            terrain_m: *height,
            los_m: los_alt,
            fresnel_m: fresnel,
            clearance_m: clearance,
        });
    }

    Ok(LosReport {
        points,
        distance_m: total,
        blocked,
        min_clearance_m: if min_clearance.is_finite() {
            min_clearance
        } else {
            0.0
        },
        fresnel_fraction,
        frequency_ghz,
    })
}

fn initial_bearing(from: (f64, f64), to: (f64, f64)) -> f64 {
    let phi1 = from.1.to_radians();
    let phi2 = to.1.to_radians();
    let dlon = (to.0 - from.0).to_radians();
    let y = dlon.sin() * phi2.cos();
    let x = phi1.cos() * phi2.sin() - phi1.sin() * phi2.cos() * dlon.cos();
    y.atan2(x).to_degrees().rem_euclid(360.0)
}

/// Approximate visible area: one ray per azimuth, stopped by the terrain.
pub fn viewshed(
    sample: &dyn Fn(f64, f64) -> Option<f64>,
    center: [f64; 2],
    radius_m: f64,
    observer_height: f64,
    rays: u32,
) -> Result<ViewshedResult, String> {
    if !(100.0..=100_000.0).contains(&radius_m) {
        return Err("radius must be between 100 m and 100 km".to_owned());
    }
    if !(0.0..=1000.0).contains(&observer_height) {
        return Err("observer height must be between 0 and 1000 m".to_owned());
    }
    let rays = rays.clamp(36, 1440);
    let observer_terrain =
        sample(center[0], center[1]).ok_or_else(|| "the centre is outside the DEM".to_owned())?;
    let observer_alt = observer_terrain + observer_height;

    let steps = 220_usize;
    let mut ring = Vec::with_capacity(rays as usize + 1);
    let mut max_distance: f64 = 0.0;
    for ray in 0..rays {
        let bearing = 360.0 * ray as f64 / rays as f64;
        let mut max_angle = f64::NEG_INFINITY;
        let mut last = radius_m;
        let mut reached_edge = true;
        for step in 1..=steps {
            let distance = radius_m * step as f64 / steps as f64;
            let (lon, lat) = destination(center[0], center[1], bearing, distance);
            let Some(height) = sample(lon, lat) else {
                reached_edge = false;
                break;
            };
            let angle = (height - observer_alt) / distance;
            if angle > max_angle {
                max_angle = angle;
                last = distance;
            }
        }
        if !reached_edge {
            last = last.min(radius_m);
        }
        max_distance = max_distance.max(last);
        let (lon, lat) = destination(center[0], center[1], bearing, last);
        ring.push([lon, lat]);
    }
    if let Some(first) = ring.first().copied() {
        ring.push(first);
    }

    let area_km2 = ring_area_km2(&ring);
    Ok(ViewshedResult {
        polygon: ring,
        area_km2,
        max_distance_m: max_distance,
        rays,
    })
}

/// Spherical polygon area in square kilometres (shoelace on a sphere).
fn ring_area_km2(ring: &[[f64; 2]]) -> f64 {
    if ring.len() < 3 {
        return 0.0;
    }
    let mut sum = 0.0;
    for index in 0..ring.len() - 1 {
        let [lon1, lat1] = ring[index];
        let [lon2, lat2] = ring[index + 1];
        sum +=
            (lon2 - lon1).to_radians() * (2.0 + lat1.to_radians().sin() + lat2.to_radians().sin());
    }
    (sum.abs() * EARTH_RADIUS * EARTH_RADIUS / 2.0) / 1_000_000.0
}

/// Computes the radio profile between two points on the active DEM.
#[tauri::command]
pub async fn los_compute(
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
    from: [f64; 2],
    to: [f64; 2],
    observer_height: f64,
    target_height: f64,
    frequency_ghz: f64,
) -> Result<LosReport, String> {
    let dem = state
        .dem
        .active()
        .await
        .ok_or_else(|| "no DEM is open".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let sampler = |lon: f64, lat: f64| dem.height(lon, lat);
        los(
            &sampler,
            from,
            to,
            observer_height,
            target_height,
            frequency_ghz,
            DEFAULT_SAMPLES,
        )
    })
    .await
    .map_err(|error| format!("viewshed task failed: {error}"))?
}

/// Computes the visible area around a point on the active DEM.
#[tauri::command]
pub async fn viewshed_compute(
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
    center: [f64; 2],
    radius_m: f64,
    observer_height: f64,
    rays: Option<u32>,
) -> Result<ViewshedResult, String> {
    let dem = state
        .dem
        .active()
        .await
        .ok_or_else(|| "no DEM is open".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let sampler = |lon: f64, lat: f64| dem.height(lon, lat);
        viewshed(
            &sampler,
            center,
            radius_m,
            observer_height,
            rays.unwrap_or(720),
        )
    })
    .await
    .map_err(|error| format!("viewshed task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(_lon: f64, _lat: f64) -> Option<f64> {
        Some(100.0)
    }

    fn ridge(lon: f64, _lat: f64) -> Option<f64> {
        // A 300 m wall around 10.05E.
        Some(if (lon - 10.05).abs() < 0.002 {
            400.0
        } else {
            100.0
        })
    }

    #[test]
    fn flat_terrain_has_a_clear_link() {
        let report = los(&flat, [10.0, 50.0], [10.1, 50.0], 10.0, 10.0, 5.8, 128).unwrap();
        assert!(!report.blocked);
        assert!(report.min_clearance_m > 0.0);
        assert!(report.fresnel_fraction > 0.0);
        assert!((report.distance_m - 7130.0).abs() < 100.0);
    }

    #[test]
    fn a_ridge_blocks_the_link() {
        let report = los(&ridge, [10.0, 50.0], [10.1, 50.0], 2.0, 2.0, 5.8, 256).unwrap();
        assert!(report.blocked);
        assert!(report.min_clearance_m < 0.0);
    }

    #[test]
    fn fresnel_radius_grows_towards_the_middle() {
        let edge = fresnel_radius(100.0, 900.0, 5.8);
        let middle = fresnel_radius(500.0, 500.0, 5.8);
        assert!(middle > edge);
        // 500 m halves at 5.8 GHz: 17.32 * sqrt(250000 / (5.8 * 1000)) ≈ 113 m.
        assert!((middle - 113.7).abs() < 1.0, "{middle}");
    }

    #[test]
    fn viewshed_returns_a_closed_ring() {
        let result = viewshed(&flat, [10.0, 50.0], 5000.0, 10.0, 180).unwrap();
        assert_eq!(result.polygon.len(), 181);
        assert!(
            result.area_km2 > 50.0 && result.area_km2 < 100.0,
            "{}",
            result.area_km2
        );
        assert!((result.max_distance_m - 5000.0).abs() < 1.0);
    }

    #[test]
    fn viewshed_rejects_bad_input() {
        assert!(viewshed(&flat, [10.0, 50.0], 10.0, 10.0, 180).is_err());
        assert!(viewshed(&flat, [10.0, 50.0], 1000.0, 5000.0, 180).is_err());
    }

    #[test]
    fn distance_matches_known_degree() {
        let d = distance_m((10.0, 50.0), (11.0, 50.0));
        assert!((d - 71_300.0).abs() < 500.0, "{d}");
    }
}
