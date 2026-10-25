//! Remote routing through OSRM and BRouter.
//!
//! Offline routing over imported lines stays in the WebView. This module only
//! talks to user-configured HTTP servers and returns a small, UI-friendly
//! subset of their response. Requests go through the shared HTTP client so the
//! configured proxy, retries and size limits apply.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::state::AppState;

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_STEPS: usize = 500;
const OSRM_DEFAULT: &str = "https://router.project-osrm.org";
const BROUTER_DEFAULT: &str = "https://brouter.de/brouter";

/// One maneuver returned by a remote router.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStep {
    /// OSRM maneuver type or `turn` for derived hints.
    pub kind: String,
    /// `left`, `right`, `slight left`, `sharp right`, or empty.
    pub modifier: String,
    /// Road name, when the router provides one.
    pub name: String,
    /// Distance in metres until the next maneuver.
    pub distance: f64,
    /// Duration in seconds.
    pub duration: f64,
    /// Maneuver location `[lon, lat]`.
    pub location: [f64; 2],
}

/// Route geometry and guidance returned to the WebView.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRoute {
    /// `osrm` or `brouter`.
    pub engine: String,
    /// Route geometry as `[lon, lat]` pairs.
    pub coordinates: Vec<[f64; 2]>,
    /// Total distance in metres.
    pub distance: f64,
    /// Total duration in seconds.
    pub duration: f64,
    /// Turn-by-turn maneuvers; empty when the server returns none.
    pub steps: Vec<RemoteStep>,
}

/// Builds a route on an external OSRM or BRouter server.
#[tauri::command]
pub async fn route_remote(
    state: State<'_, Arc<AppState>>,
    engine: String,
    url: Option<String>,
    profile: Option<String>,
    start: [f64; 2],
    end: [f64; 2],
) -> Result<RemoteRoute, String> {
    if !valid_point(start) || !valid_point(end) {
        return Err("route coordinates are outside WGS84".to_owned());
    }
    if start == end {
        return Err("start and finish are the same point".to_owned());
    }
    let profile = clean_profile(profile.as_deref(), &engine);
    let base = url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(match engine.as_str() {
            "osrm" => OSRM_DEFAULT,
            "brouter" => BROUTER_DEFAULT,
            other => return Err(format!("unsupported route engine {other:?}")),
        });
    let request_url = match engine.as_str() {
        "osrm" => osrm_url(base, &profile, start, end)?,
        "brouter" => brouter_url(base, &profile, start, end)?,
        other => return Err(format!("unsupported route engine {other:?}")),
    };
    let net = state.net.read().await.clone();
    let body = net
        .fetch_document(&request_url, &Default::default(), MAX_RESPONSE_BYTES)
        .await
        .map_err(|error| format!("routing server: {error}"))?;
    let value: Value =
        serde_json::from_str(&body).map_err(|error| format!("invalid routing JSON: {error}"))?;
    match engine.as_str() {
        "osrm" => parse_osrm(&value),
        "brouter" => parse_brouter(&value),
        _ => unreachable!(),
    }
}

fn clean_profile(profile: Option<&str>, engine: &str) -> String {
    let fallback = match engine {
        "brouter" => "trekking",
        _ => "driving",
    };
    let Some(profile) = profile.map(str::trim).filter(|value| !value.is_empty()) else {
        return fallback.to_owned();
    };
    if profile.len() <= 40
        && profile
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        profile.to_owned()
    } else {
        fallback.to_owned()
    }
}

fn osrm_url(base: &str, profile: &str, start: [f64; 2], end: [f64; 2]) -> Result<String, String> {
    let base = base.trim_end_matches('/');
    let url = format!(
        "{base}/route/v1/{profile}/{:.6},{:.6};{:.6},{:.6}?overview=full&geometries=geojson&steps=true",
        start[0], start[1], end[0], end[1]
    );
    validate_url(&url)?;
    Ok(url)
}

fn brouter_url(
    base: &str,
    profile: &str,
    start: [f64; 2],
    end: [f64; 2],
) -> Result<String, String> {
    let separator = if base.contains('?') { '&' } else { '?' };
    let url = format!(
        "{base}{separator}lonlats={:.6},{:.6}|{:.6},{:.6}&profile={profile}&alternativeidx=0&format=geojson",
        start[0], start[1], end[0], end[1]
    );
    validate_url(&url)?;
    Ok(url)
}

fn validate_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Ok(())
    } else {
        Err("routing URL must start with http:// or https://".to_owned())
    }
}

fn parse_osrm(value: &Value) -> Result<RemoteRoute, String> {
    if value.get("code").and_then(Value::as_str) != Some("Ok") {
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("OSRM did not return a route");
        return Err(message.chars().take(300).collect());
    }
    let route = value
        .get("routes")
        .and_then(Value::as_array)
        .and_then(|routes| routes.first())
        .ok_or_else(|| "OSRM response has no routes".to_owned())?;
    let coordinates = coordinates(route.pointer("/geometry/coordinates"))?;
    let distance = number(route.get("distance")).unwrap_or_default();
    let duration = number(route.get("duration")).unwrap_or_default();
    let mut steps = Vec::new();
    if let Some(legs) = route.get("legs").and_then(Value::as_array) {
        for leg in legs {
            let Some(items) = leg.get("steps").and_then(Value::as_array) else {
                continue;
            };
            for step in items {
                if steps.len() >= MAX_STEPS {
                    break;
                }
                let location = point(step.pointer("/maneuver/location"))?;
                steps.push(RemoteStep {
                    kind: text(step.pointer("/maneuver/type"), 40),
                    modifier: text(step.pointer("/maneuver/modifier"), 40),
                    name: text(step.get("name"), 120),
                    distance: number(step.get("distance")).unwrap_or_default(),
                    duration: number(step.get("duration")).unwrap_or_default(),
                    location,
                });
            }
        }
    }
    Ok(RemoteRoute {
        engine: "osrm".to_owned(),
        coordinates,
        distance,
        duration,
        steps,
    })
}

fn parse_brouter(value: &Value) -> Result<RemoteRoute, String> {
    let feature = value
        .get("features")
        .and_then(Value::as_array)
        .and_then(|features| features.first())
        .ok_or_else(|| "BRouter response has no features".to_owned())?;
    let coordinates = coordinates(feature.pointer("/geometry/coordinates"))?;
    let properties = feature.get("properties").unwrap_or(&Value::Null);
    let distance = number(properties.get("track-length")).unwrap_or_else(|| {
        coordinates
            .windows(2)
            .map(|pair| haversine(pair[0], pair[1]))
            .sum()
    });
    let duration = number(properties.get("total-time")).unwrap_or_else(|| distance / 3.0);
    Ok(RemoteRoute {
        engine: "brouter".to_owned(),
        coordinates,
        distance,
        duration,
        steps: Vec::new(),
    })
}

fn point(value: Option<&Value>) -> Result<[f64; 2], String> {
    let pair = value
        .and_then(Value::as_array)
        .filter(|pair| pair.len() >= 2)
        .ok_or_else(|| "route point is malformed".to_owned())?;
    let point = [
        number(pair.first()).ok_or_else(|| "route longitude is missing".to_owned())?,
        number(pair.get(1)).ok_or_else(|| "route latitude is missing".to_owned())?,
    ];
    if valid_point(point) {
        Ok(point)
    } else {
        Err("route coordinate is outside WGS84".to_owned())
    }
}

fn coordinates(value: Option<&Value>) -> Result<Vec<[f64; 2]>, String> {
    let items = value
        .and_then(Value::as_array)
        .ok_or_else(|| "route geometry is missing".to_owned())?;
    let mut points = Vec::with_capacity(items.len());
    for item in items {
        let pair = item
            .as_array()
            .filter(|pair| pair.len() >= 2)
            .ok_or_else(|| "route coordinate is malformed".to_owned())?;
        let point = [
            number(pair.first()).ok_or_else(|| "route longitude is missing".to_owned())?,
            number(pair.get(1)).ok_or_else(|| "route latitude is missing".to_owned())?,
        ];
        if !valid_point(point) {
            return Err("route coordinate is outside WGS84".to_owned());
        }
        points.push(point);
    }
    if points.len() < 2 {
        return Err("route geometry has fewer than two points".to_owned());
    }
    Ok(points)
}

fn number(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse::<f64>().ok())
        .filter(|value| value.is_finite())
}

fn text(value: Option<&Value>, limit: usize) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(limit)
        .collect()
}

fn valid_point(point: [f64; 2]) -> bool {
    point[0] >= -180.0
        && point[0] <= 180.0
        && point[1] >= -90.0
        && point[1] <= 90.0
        && point[0].is_finite()
        && point[1].is_finite()
}

fn haversine(a: [f64; 2], b: [f64; 2]) -> f64 {
    const RADIUS: f64 = 6_371_008.8;
    let lat1 = a[1].to_radians();
    let lat2 = b[1].to_radians();
    let delta_lat = (b[1] - a[1]).to_radians();
    let delta_lon = (b[0] - a[0]).to_radians();
    let h =
        (delta_lat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (delta_lon / 2.0).sin().powi(2);
    2.0 * RADIUS * h.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_osrm_and_brouter_urls() {
        let start = [37.6173, 55.7558];
        let end = [37.6300, 55.7600];
        let osrm = osrm_url("https://router.example.org/", "driving", start, end).unwrap();
        assert!(
            osrm.starts_with("https://router.example.org/route/v1/driving/37.617300,55.755800;")
        );
        assert!(osrm.contains("steps=true"));
        let brouter = brouter_url(
            "https://brouter.example.org/brouter",
            "trekking",
            start,
            end,
        )
        .unwrap();
        assert!(brouter.contains("lonlats=37.617300,55.755800|37.630000,55.760000"));
        assert!(brouter.contains("profile=trekking"));
        assert!(osrm_url("ftp://example.org", "driving", start, end).is_err());
    }

    #[test]
    fn parses_osrm_route_and_steps() {
        let value = json!({
            "code": "Ok",
            "routes": [{
                "distance": 1234.5,
                "duration": 321.0,
                "geometry": {"coordinates": [[37.0, 55.0], [37.1, 55.1]]},
                "legs": [{"steps": [
                    {
                        "distance": 100.0,
                        "duration": 30.0,
                        "name": "Main street",
                        "maneuver": {"type": "turn", "modifier": "left", "location": [37.0, 55.0]}
                    },
                    {
                        "distance": 0.0,
                        "duration": 0.0,
                        "name": "",
                        "maneuver": {"type": "arrive", "location": [37.1, 55.1]}
                    }
                ]}]
            }]
        });
        let route = parse_osrm(&value).unwrap();
        assert_eq!(route.coordinates.len(), 2);
        assert_eq!(route.distance, 1234.5);
        assert_eq!(route.steps.len(), 2);
        assert_eq!(route.steps[0].modifier, "left");
    }

    #[test]
    fn parses_brouter_geojson() {
        let value = json!({
            "features": [{
                "geometry": {"coordinates": [[37.0, 55.0], [37.1, 55.1]]},
                "properties": {"track-length": "2000", "total-time": "600"}
            }]
        });
        let route = parse_brouter(&value).unwrap();
        assert_eq!(route.engine, "brouter");
        assert_eq!(route.distance, 2000.0);
        assert_eq!(route.duration, 600.0);
    }

    #[test]
    fn rejects_bad_remote_responses() {
        assert!(parse_osrm(&json!({"code": "NoRoute"})).is_err());
        assert!(parse_brouter(&json!({"features": []})).is_err());
        assert!(coordinates(Some(&json!([[200.0, 10.0], [1.0, 2.0]]))).is_err());
    }
}
