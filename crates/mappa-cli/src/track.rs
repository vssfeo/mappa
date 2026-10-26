//! GPX tracks uploaded by the mobile companion.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

const MAX_POINTS: usize = 100_000;

#[derive(Debug, Deserialize)]
struct Payload {
    name: Option<String>,
    points: Vec<Point>,
}

#[derive(Debug, Deserialize)]
struct Point {
    lat: f64,
    lon: f64,
    alt: Option<f64>,
    time: Option<String>,
}

/// A validated track point.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackPoint {
    pub lat: f64,
    pub lon: f64,
    pub alt: Option<f64>,
    pub time: Option<String>,
}

/// A parsed upload.
#[derive(Debug)]
pub struct Track {
    pub name: String,
    pub points: Vec<TrackPoint>,
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// A safe file stem for a track name.
pub fn safe_name(name: &str) -> String {
    let value: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let value = value.trim_matches(['-', '.']).to_owned();
    if value.is_empty() {
        "track".to_owned()
    } else {
        value.chars().take(60).collect()
    }
}

/// Parses and validates a JSON track upload.
pub fn parse(body: &[u8]) -> Result<Track, String> {
    let payload: Payload =
        serde_json::from_slice(body).map_err(|error| format!("invalid JSON: {error}"))?;
    if payload.points.is_empty() {
        return Err("track has no points".to_owned());
    }
    if payload.points.len() > MAX_POINTS {
        return Err(format!("track has more than {MAX_POINTS} points"));
    }
    let mut points = Vec::with_capacity(payload.points.len());
    for (index, point) in payload.points.into_iter().enumerate() {
        if !(-90.0..=90.0).contains(&point.lat) || !(-180.0..=180.0).contains(&point.lon) {
            return Err(format!("point {index} is outside WGS84"));
        }
        points.push(TrackPoint {
            lat: point.lat,
            lon: point.lon,
            alt: point.alt,
            time: point.time,
        });
    }
    let name: String = payload
        .name
        .as_deref()
        .unwrap_or("phone")
        .chars()
        .filter(|ch| !ch.is_control())
        .take(120)
        .collect();
    Ok(Track {
        name: if name.trim().is_empty() {
            "phone".to_owned()
        } else {
            name
        },
        points,
    })
}

/// Renders GPX 1.1.
pub fn to_gpx(track: &Track) -> String {
    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <gpx version=\"1.1\" creator=\"Mappa\" xmlns=\"http://www.topografix.com/GPX/1/1\">\n  <trk>\n",
    );
    out.push_str(&format!(
        "    <name>{}</name>\n    <trkseg>\n",
        escape(&track.name)
    ));
    for point in &track.points {
        out.push_str(&format!(
            "      <trkpt lat=\"{:.7}\" lon=\"{:.7}\">",
            point.lat, point.lon
        ));
        if let Some(alt) = point.alt {
            out.push_str(&format!("<ele>{alt:.1}</ele>"));
        }
        if let Some(time) = &point.time {
            out.push_str(&format!("<time>{}</time>", escape(time)));
        }
        out.push_str("</trkpt>\n");
    }
    out.push_str("    </trkseg>\n  </trk>\n</gpx>\n");
    out
}

/// A unique file name for a new upload.
pub fn file_name(name: &str) -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{}-{stamp}.gpx", safe_name(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_validates_a_track() {
        let body = br#"{"name":"Phone","points":[
            {"lat":53.1,"lon":-9.6,"alt":12.5,"time":"2026-10-26T10:00:00.000Z"},
            {"lat":53.2,"lon":-9.7}
        ]}"#;
        let track = parse(body).unwrap();
        assert_eq!(track.name, "Phone");
        assert_eq!(track.points.len(), 2);
        assert_eq!(track.points[0].alt, Some(12.5));
    }

    #[test]
    fn rejects_empty_or_out_of_range_tracks() {
        assert!(parse(br#"{"points":[]}"#).is_err());
        assert!(parse(br#"{"points":[{"lat":95,"lon":0}]}"#).is_err());
        assert!(parse(br#"{"points":[{"lat":0,"lon":200}]}"#).is_err());
        assert!(parse(b"not json").is_err());
    }

    #[test]
    fn renders_gpx_with_escaped_name() {
        let track = parse(br#"{"name":"A & B","points":[{"lat":1,"lon":2,"alt":3}]}"#).unwrap();
        let gpx = to_gpx(&track);
        assert!(gpx.contains("<name>A &amp; B</name>"));
        assert!(gpx.contains("lat=\"1.0000000\" lon=\"2.0000000\""));
        assert!(gpx.contains("<ele>3.0</ele>"));
    }

    #[test]
    fn sanitizes_file_names() {
        assert_eq!(safe_name("../../etc/passwd"), "etc-passwd");
        assert_eq!(safe_name("   "), "track");
    }
}
