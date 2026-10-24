//! Coordinate reference systems backed by pure-Rust PROJ.
//!
//! Angles cross this API in degrees; projected coordinates are in the units
//! declared by the CRS (normally metres). `proj4rs` works in radians
//! internally, so the conversion happens here.

use std::sync::OnceLock;

use proj4rs::proj::Proj as ProjImpl;
use serde::{Deserialize, Serialize};

/// A CRS selected by EPSG code or by a raw proj4 string.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct CrsSpec {
    /// EPSG code, when the CRS comes from the bundled catalog.
    #[serde(default)]
    pub epsg: Option<u16>,
    /// Raw proj4 string, used for local systems (СК-42/МСК, custom grids).
    #[serde(default)]
    pub proj: Option<String>,
}

impl CrsSpec {
    /// Builds a spec from an EPSG code.
    pub fn from_epsg(code: u16) -> Self {
        Self {
            epsg: Some(code),
            proj: None,
        }
    }

    /// Builds a spec from a proj4 string.
    pub fn from_proj(proj: impl Into<String>) -> Self {
        Self {
            epsg: None,
            proj: Some(proj.into()),
        }
    }

    fn key(&self) -> Result<String, String> {
        match (self.epsg, &self.proj) {
            (Some(code), _) => Ok(format!("EPSG:{code}")),
            (None, Some(proj)) if !proj.trim().is_empty() => Ok(format!("PROJ:{}", proj.trim())),
            _ => Err("CRS must provide an EPSG code or a proj4 string".to_owned()),
        }
    }
}

/// A resolved coordinate reference system.
pub struct Crs {
    /// Stable human-readable code (`EPSG:3857` or `PROJ:...`).
    pub code: String,
    /// Units shown in the UI.
    pub units: String,
    /// True for angular systems such as EPSG:4326.
    pub geographic: bool,
    projection: ProjImpl,
}

impl std::fmt::Debug for Crs {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Crs")
            .field("code", &self.code)
            .field("units", &self.units)
            .field("geographic", &self.geographic)
            .finish_non_exhaustive()
    }
}

impl Crs {
    /// Resolves a spec.
    pub fn new(spec: &CrsSpec) -> Result<Self, String> {
        let code = spec.key()?;
        let projection = if let Some(epsg) = spec.epsg {
            ProjImpl::from_epsg_code(epsg)
                .map_err(|error| format!("EPSG:{epsg} is not available: {error}"))?
        } else {
            ProjImpl::from_proj_string(spec.proj.as_deref().unwrap_or_default())
                .map_err(|error| format!("invalid proj4 string: {error}"))?
        };
        let geographic = projection.is_latlong();
        let units = if geographic {
            "deg".to_owned()
        } else {
            projection.units().to_owned()
        };
        Ok(Self {
            code,
            units,
            geographic,
            projection,
        })
    }

    /// Converts a point in this CRS to WGS84 longitude/latitude in degrees.
    pub fn to_wgs84(&self, x: f64, y: f64) -> Result<(f64, f64), String> {
        let mut point = if self.geographic {
            (x.to_radians(), y.to_radians(), 0.0)
        } else {
            (x, y, 0.0)
        };
        proj4rs::transform::transform(&self.projection, wgs84()?, &mut point)
            .map_err(|error| error.to_string())?;
        Ok((point.0.to_degrees(), point.1.to_degrees()))
    }

    /// Converts WGS84 longitude/latitude in degrees to this CRS.
    pub fn from_wgs84(&self, lon: f64, lat: f64) -> Result<(f64, f64), String> {
        let mut point = (lon.to_radians(), lat.to_radians(), 0.0);
        proj4rs::transform::transform(wgs84()?, &self.projection, &mut point)
            .map_err(|error| error.to_string())?;
        if self.geographic {
            Ok((point.0.to_degrees(), point.1.to_degrees()))
        } else {
            Ok((point.0, point.1))
        }
    }

    /// Converts a point from this CRS into another one.
    pub fn transform_to(&self, target: &Crs, x: f64, y: f64) -> Result<(f64, f64), String> {
        let (lon, lat) = self.to_wgs84(x, y)?;
        target.from_wgs84(lon, lat)
    }

    /// True for angular systems such as EPSG:4326.
    pub fn is_geographic(&self) -> bool {
        self.geographic
    }
}

/// One entry of the bundled CRS catalog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrsPreset {
    /// EPSG code.
    pub epsg: u16,
    /// Human label.
    pub label: String,
    /// `deg` or metres.
    pub units: String,
    /// True for geographic systems.
    pub geographic: bool,
}

/// Curated presets for geodesists working in the post-Soviet space.
pub fn presets() -> Vec<CrsPreset> {
    const CODES: &[(u16, &str)] = &[
        (4326, "WGS 84 · широта/долгота"),
        (3857, "Web Mercator"),
        (3395, "World Mercator"),
        (4269, "NAD83"),
        (4267, "NAD27"),
        (4258, "ETRS89"),
        (25832, "ETRS89 / UTM 32N"),
        (32636, "WGS 84 / UTM 36N"),
        (32637, "WGS 84 / UTM 37N"),
        (32638, "WGS 84 / UTM 38N"),
        (32736, "WGS 84 / UTM 36S"),
        (32737, "WGS 84 / UTM 37S"),
        (28404, "Pulkovo 1942 / Gauss-Kruger zone 4"),
        (28405, "Pulkovo 1942 / Gauss-Kruger zone 5"),
        (28406, "Pulkovo 1942 / Gauss-Kruger zone 6"),
        (28407, "Pulkovo 1942 / Gauss-Kruger zone 7"),
        (28408, "Pulkovo 1942 / Gauss-Kruger zone 8"),
        (28409, "Pulkovo 1942 / Gauss-Kruger zone 9"),
        (28410, "Pulkovo 1942 / Gauss-Kruger zone 10"),
        (28411, "Pulkovo 1942 / Gauss-Kruger zone 11"),
        (20006, "Pulkovo 1995 / Gauss-Kruger zone 6"),
        (20007, "Pulkovo 1995 / Gauss-Kruger zone 7"),
        (20008, "Pulkovo 1995 / Gauss-Kruger zone 8"),
    ];
    CODES
        .iter()
        .filter_map(|(epsg, label)| {
            let crs = Crs::new(&CrsSpec::from_epsg(*epsg)).ok()?;
            Some(CrsPreset {
                epsg: *epsg,
                label: (*label).to_owned(),
                units: crs.units,
                geographic: crs.geographic,
            })
        })
        .collect()
}

/// Reusable WGS84 target; `Proj` parsing is not free.
fn wgs84() -> Result<&'static ProjImpl, String> {
    static WGS84: OnceLock<Result<ProjImpl, String>> = OnceLock::new();
    WGS84
        .get_or_init(|| {
            ProjImpl::from_proj_string("+proj=longlat +datum=WGS84 +no_defs")
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(spec: CrsSpec, lon: f64, lat: f64, tolerance: f64) {
        let crs = Crs::new(&spec).unwrap();
        let (x, y) = crs.from_wgs84(lon, lat).unwrap();
        let (back_lon, back_lat) = crs.to_wgs84(x, y).unwrap();
        assert!(
            (back_lon - lon).abs() < tolerance && (back_lat - lat).abs() < tolerance,
            "{:?}: {lon},{lat} -> {x},{y} -> {back_lon},{back_lat}",
            spec
        );
    }

    #[test]
    fn web_mercator_matches_reference() {
        let crs = Crs::new(&CrsSpec::from_epsg(3857)).unwrap();
        let (x, y) = crs.from_wgs84(37.6173, 55.7558).unwrap();
        assert!((x - 4_187_538.68).abs() < 1.0, "x={x}");
        assert!((y - 7_509_955.14).abs() < 1.0, "y={y}");
        round_trip(CrsSpec::from_epsg(3857), 37.6173, 55.7558, 1e-7);
    }

    #[test]
    fn utm_round_trips() {
        round_trip(CrsSpec::from_epsg(32637), 34.1, 44.95, 1e-7);
        round_trip(CrsSpec::from_epsg(32737), 151.2, -33.87, 1e-7);
    }

    #[test]
    fn pulkovo_round_trips() {
        round_trip(CrsSpec::from_epsg(28406), 34.1, 44.95, 1e-5);
    }

    #[test]
    fn geographic_axis_is_degrees() {
        let crs = Crs::new(&CrsSpec::from_epsg(4326)).unwrap();
        assert!(crs.is_geographic());
        let (x, y) = crs.from_wgs84(37.6173, 55.7558).unwrap();
        assert!((x - 37.6173).abs() < 1e-9);
        assert!((y - 55.7558).abs() < 1e-9);
        let (lon, lat) = crs.to_wgs84(37.6173, 55.7558).unwrap();
        assert!((lon - 37.6173).abs() < 1e-9);
        assert!((lat - 55.7558).abs() < 1e-9);
    }

    #[test]
    fn custom_proj_string_works() {
        // EPSG:32637 expressed as proj4, as a user would configure a local grid.
        let spec = CrsSpec::from_proj("+proj=utm +zone=37 +datum=WGS84 +units=m +no_defs");
        round_trip(spec, 34.1, 44.95, 1e-7);
    }

    #[test]
    fn rejects_unknown_epsg_and_empty_spec() {
        assert!(Crs::new(&CrsSpec::from_epsg(9999)).is_err());
        assert!(
            Crs::new(&CrsSpec {
                epsg: None,
                proj: None
            })
            .is_err()
        );
        assert!(Crs::new(&CrsSpec::from_proj("not a proj string")).is_err());
    }

    #[test]
    fn sk42_gauss_kruger_zone_7() {
        // Pulkovo 1942 / GK zone 7: Y includes the zone prefix.
        let crs = Crs::new(&CrsSpec::from_epsg(28407)).unwrap();
        let (y, x) = crs.from_wgs84(37.6173, 55.7558).unwrap();
        assert!((y - 7_413_187.97).abs() < 0.5, "y={y}");
        assert!((x - 6_182_348.17).abs() < 0.5, "x={x}");
        let (lon, lat) = crs.to_wgs84(y, x).unwrap();
        assert!((lon - 37.6173).abs() < 1e-8);
        assert!((lat - 55.7558).abs() < 1e-8);
    }

    #[test]
    fn presets_are_resolvable() {
        let presets = presets();
        assert!(presets.len() >= 12);
        assert!(presets.iter().any(|item| item.epsg == 28406));
        assert!(presets.iter().any(|item| item.geographic));
    }
}
