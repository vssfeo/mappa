//! Source-agnostic telemetry fixes: JSON from MQTT or a ROS2 bridge.
//!
//! The receiver accepts a small, forgiving JSON shape so a vehicle, a ground
//! station or `scripts/ros2_bridge.py` can publish without a schema library:
//!
//! ```json
//! {"lat": 44.95, "lon": 34.10, "alt_m": 120.5, "heading_deg": 271}
//! ```
//!
//! `latitude`/`longitude`/`altitude`/`heading` are accepted as aliases, as is
//! a nested `position` object. Coordinates are validated; a bad fix is
//! rejected instead of being drawn on the map.

use serde::Serialize;
use serde_json::Value;

/// A single validated position.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonFix {
    pub lat: f64,
    pub lon: f64,
    pub alt_m: f64,
    pub heading_deg: f64,
    pub at_ms: u64,
}

fn number(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_f64))
}

fn normalized_heading(value: f64) -> f64 {
    if value.is_finite() {
        value.rem_euclid(360.0)
    } else {
        0.0
    }
}

/// Parses a telemetry JSON payload. `now_ms` stamps fixes without a timestamp.
pub fn parse_json_fix(payload: &str, now_ms: u64) -> Result<JsonFix, String> {
    let value: Value =
        serde_json::from_str(payload).map_err(|error| format!("invalid JSON: {error}"))?;
    if !value.is_object() {
        return Err("telemetry must be a JSON object".to_owned());
    }
    let position = value
        .get("position")
        .or_else(|| value.get("pose").and_then(|pose| pose.get("position")))
        .unwrap_or(&value);

    // ROS2 Odometry carries local x/y metres, not WGS84. Reject it clearly
    // instead of drawing a point near the equator.
    if position.get("lat").is_none()
        && position.get("latitude").is_none()
        && position.get("x").is_some()
    {
        return Err(
            "local x/y is not WGS84; run scripts/ros2_bridge.py to convert /odom".to_owned(),
        );
    }

    let lat =
        number(position, &["lat", "latitude"]).ok_or_else(|| "missing latitude".to_owned())?;
    let lon = number(position, &["lon", "lng", "longitude"])
        .ok_or_else(|| "missing longitude".to_owned())?;
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return Err(format!("coordinates out of range: {lat}, {lon}"));
    }
    let alt_m = number(position, &["alt_m", "alt", "altitude"]).unwrap_or(0.0);
    if !alt_m.is_finite() {
        return Err("altitude is not a finite number".to_owned());
    }
    let heading_deg = normalized_heading(
        number(&value, &["heading_deg", "heading", "yaw", "course"])
            .or_else(|| number(position, &["heading_deg", "heading"]))
            .unwrap_or(0.0),
    );
    let at_ms = number(&value, &["at_ms", "timestamp_ms"])
        .filter(|stamp| *stamp >= 0.0)
        .map(|stamp| stamp as u64)
        .unwrap_or(now_ms);

    Ok(JsonFix {
        lat,
        lon,
        alt_m,
        heading_deg,
        at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flat_payload_and_aliases() {
        let fix = parse_json_fix(
            r#"{"latitude":44.95,"longitude":34.10,"altitude":120.5,"heading":-90}"#,
            7,
        )
        .expect("fix");
        assert!((fix.lat - 44.95).abs() < 1e-12);
        assert!((fix.alt_m - 120.5).abs() < 1e-12);
        assert!((fix.heading_deg - 270.0).abs() < 1e-12);
        assert_eq!(fix.at_ms, 7);
    }

    #[test]
    fn parses_nested_position_and_timestamp() {
        let fix = parse_json_fix(
            r#"{"position":{"lat":1.5,"lon":2.5,"alt":3},"heading_deg":10,"timestamp_ms":99}"#,
            0,
        )
        .expect("fix");
        assert_eq!(fix.lat, 1.5);
        assert_eq!(fix.lon, 2.5);
        assert_eq!(fix.alt_m, 3.0);
        assert_eq!(fix.at_ms, 99);
    }

    #[test]
    fn rejects_bad_coordinates_and_json() {
        assert!(parse_json_fix(r#"{"lat":91,"lon":0}"#, 0).is_err());
        assert!(parse_json_fix(r#"{"lat":44.9}"#, 0).is_err());
        assert!(parse_json_fix("not json", 0).is_err());
    }

    #[test]
    fn rejects_ros2_local_metres_with_a_hint() {
        let error = parse_json_fix(r#"{"position":{"x":10,"y":20}}"#, 0).unwrap_err();
        assert!(error.contains("ros2_bridge"));
    }
}
