//! Offline place search with a cached online fallback.
//!
//! Queries first match the local gazetteer (`geocode.json` in the app config
//! directory). When online search is enabled, Photon is asked first and
//! Nominatim is used as a fallback; successful results are merged into the
//! local file, so repeated searches work without a network connection.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use mappa_net::TileClient;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use tokio::sync::Mutex;

use crate::state::AppState;

const PHOTON_ENDPOINT: &str = "https://photon.komoot.io/api/";
const NOMINATIM_ENDPOINT: &str = "https://nominatim.openstreetmap.org/search";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PLACES: usize = 50_000;
const MAX_RESULTS: usize = 20;
const MIN_QUERY_CHARS: usize = 2;
const MIN_ONLINE_CHARS: usize = 3;
const ONLINE_INTERVAL: Duration = Duration::from_millis(1100);

/// One place returned by the local index or an online geocoder.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeocodePlace {
    /// Stable id within the cache; generated when absent in a local file.
    #[serde(default)]
    pub id: String,
    /// Short place name.
    pub name: String,
    /// Full display label.
    pub label: String,
    /// Longitude, WGS84.
    pub lon: f64,
    /// Latitude, WGS84.
    pub lat: f64,
    /// Place category, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// `local`, `photon` or `nominatim`.
    #[serde(default = "local_source")]
    pub source: String,
}

fn local_source() -> String {
    "local".to_owned()
}

/// Result of one palette search.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeocodeResponse {
    /// Matching places, local results first.
    pub places: Vec<GeocodePlace>,
    /// Whether an online service answered.
    pub online: bool,
    /// Stable warning code for the UI, e.g. `online_unavailable`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<&'static str>,
}

/// Local gazetteer plus a small online result cache.
pub struct Geocoder {
    path: PathBuf,
    places: Mutex<Vec<GeocodePlace>>,
    online_slot: Mutex<Option<Instant>>,
}

impl Geocoder {
    /// Loads the cache, tolerating a missing or corrupt file.
    pub fn load(path: PathBuf) -> Self {
        let places = load_places(&path);
        if !places.is_empty() {
            log::info!("geocoder: {} local places", places.len());
        }
        Self {
            path,
            places: Mutex::new(places),
            online_slot: Mutex::new(None),
        }
    }

    /// Searches locally and, when allowed, refreshes from Photon/Nominatim.
    pub async fn search(
        &self,
        net: Arc<TileClient>,
        query: &str,
        lang: &str,
        limit: usize,
        online_enabled: bool,
    ) -> GeocodeResponse {
        let query = query.trim();
        let limit = limit.clamp(1, MAX_RESULTS);
        if query.chars().count() < MIN_QUERY_CHARS {
            return GeocodeResponse {
                places: Vec::new(),
                online: false,
                warning: None,
            };
        }
        let local = self.local_search(query, limit).await;
        if !online_enabled || query.chars().count() < MIN_ONLINE_CHARS {
            return GeocodeResponse {
                places: local,
                online: false,
                warning: None,
            };
        }

        // Serialize online requests and respect the public services' rate
        // limits. The guard is held across the request on purpose.
        let mut slot = self.online_slot.lock().await;
        if let Some(last) = *slot {
            let elapsed = last.elapsed();
            if elapsed < ONLINE_INTERVAL {
                tokio::time::sleep(ONLINE_INTERVAL - elapsed).await;
            }
        }
        let lang = if lang.eq_ignore_ascii_case("ru") {
            "ru"
        } else {
            "en"
        };
        let mut online_places = Vec::new();
        let mut online = false;
        match fetch_photon(net.as_ref(), query, lang, limit).await {
            Ok(places) => {
                online = true;
                online_places = places;
            }
            Err(error) => log::warn!("photon geocoding failed: {error}"),
        }
        if online_places.is_empty() {
            match fetch_nominatim(net.as_ref(), query, lang, limit).await {
                Ok(places) => {
                    online = true;
                    online_places = places;
                }
                Err(error) => log::warn!("nominatim geocoding failed: {error}"),
            }
        }
        *slot = Some(Instant::now());
        drop(slot);

        if !online_places.is_empty()
            && let Err(error) = self.merge_online(&online_places).await
        {
            log::warn!("cannot save geocoder cache: {error}");
        }

        let mut places = local;
        for place in online_places {
            if !places.iter().any(|item| item.id == place.id) {
                places.push(place);
            }
        }
        places.truncate(limit);
        GeocodeResponse {
            places,
            online,
            warning: (!online).then_some("online_unavailable"),
        }
    }

    async fn local_search(&self, query: &str, limit: usize) -> Vec<GeocodePlace> {
        let needle = query.to_lowercase();
        let places = self.places.lock().await;
        let mut scored = places
            .iter()
            .filter_map(|place| match_score(place, &needle).map(|score| (score, place.clone())))
            .collect::<Vec<_>>();
        scored.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.name.len().cmp(&right.1.name.len()))
                .then_with(|| left.1.name.cmp(&right.1.name))
        });
        scored
            .into_iter()
            .take(limit)
            .map(|(_, place)| place)
            .collect()
    }

    async fn merge_online(&self, incoming: &[GeocodePlace]) -> Result<(), String> {
        let mut merged = Vec::with_capacity(incoming.len());
        let mut seen = HashSet::new();
        for place in incoming
            .iter()
            .filter_map(|place| sanitize_place(place.clone()))
        {
            if seen.insert(place.id.clone()) {
                merged.push(place);
            }
        }
        let mut places = self.places.lock().await;
        for place in places.iter() {
            if !seen.contains(&place.id) {
                merged.push(place.clone());
            }
        }
        merged.truncate(MAX_PLACES);
        if *places == merged {
            return Ok(());
        }
        let data = serde_json::to_vec(&merged)
            .map_err(|error| format!("cannot encode geocoder cache: {error}"))?;
        crate::atomic::write(&self.path, &data, true)
            .map_err(|error| format!("cannot write {}: {error}", self.path.display()))?;
        *places = merged;
        Ok(())
    }
}

/// Tauri command used by the command palette.
#[tauri::command]
pub async fn geocode_search(
    state: State<'_, Arc<AppState>>,
    query: String,
    lang: Option<String>,
    limit: Option<usize>,
) -> Result<GeocodeResponse, String> {
    if query.chars().count() > 200 {
        return Err("geocoder query is longer than 200 characters".to_owned());
    }
    let online = state.geocode_online.load(Ordering::Relaxed);
    let net = state.net.read().await.clone();
    Ok(state
        .geocoder
        .search(
            net,
            &query,
            lang.as_deref().unwrap_or("en"),
            limit.unwrap_or(6),
            online,
        )
        .await)
}

fn match_score(place: &GeocodePlace, needle: &str) -> Option<u8> {
    let name = place.name.to_lowercase();
    let label = place.label.to_lowercase();
    if name == needle {
        Some(0)
    } else if name.starts_with(needle) {
        Some(1)
    } else if label.starts_with(needle) {
        Some(2)
    } else if name.split_whitespace().any(|word| word.starts_with(needle)) {
        Some(3)
    } else if label
        .split_whitespace()
        .any(|word| word.starts_with(needle))
    {
        Some(4)
    } else if label.contains(needle) || name.contains(needle) {
        Some(5)
    } else {
        None
    }
}

fn load_places(path: &Path) -> Vec<GeocodePlace> {
    let Ok(metadata) = std::fs::metadata(path) else {
        return Vec::new();
    };
    if metadata.len() > MAX_CACHE_BYTES {
        log::warn!("geocoder cache is larger than {MAX_CACHE_BYTES} bytes; ignoring it");
        return Vec::new();
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let parsed = serde_json::from_str::<CacheFile>(&text);
    let raw = match parsed {
        Ok(CacheFile::List(places)) => places,
        Ok(CacheFile::Wrapped { places }) => places,
        Err(error) => {
            log::warn!("cannot parse {}: {error}", path.display());
            return Vec::new();
        }
    };
    dedupe(raw)
}

fn dedupe(raw: Vec<GeocodePlace>) -> Vec<GeocodePlace> {
    let mut seen = HashSet::new();
    raw.into_iter()
        .filter_map(sanitize_place)
        .filter(|place| seen.insert(place.id.clone()))
        .take(MAX_PLACES)
        .collect()
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CacheFile {
    List(Vec<GeocodePlace>),
    Wrapped { places: Vec<GeocodePlace> },
}

fn sanitize_place(mut place: GeocodePlace) -> Option<GeocodePlace> {
    if !place.lon.is_finite()
        || !place.lat.is_finite()
        || !(-180.0..=180.0).contains(&place.lon)
        || !(-90.0..=90.0).contains(&place.lat)
    {
        return None;
    }
    place.name = truncate(place.name.trim(), 200);
    place.label = truncate(place.label.trim(), 300);
    place.id = truncate(place.id.trim(), 200);
    if place.name.is_empty() {
        place.name = place.label.clone();
    }
    if place.label.is_empty() {
        place.label = place.name.clone();
    }
    if place.name.is_empty() {
        place.name = format!("{:.5}, {:.5}", place.lat, place.lon);
        place.label = place.name.clone();
    }
    if place.id.is_empty() {
        place.id = format!("local:{:.5},{:.5}:{}", place.lat, place.lon, place.name);
    }
    place.source = truncate(place.source.trim(), 32);
    if place.source.is_empty() {
        place.source = local_source();
    }
    place.kind = place
        .kind
        .map(|kind| truncate(kind.trim(), 60))
        .filter(|kind| !kind.is_empty());
    Some(place)
}

fn truncate(value: &str, width: usize) -> String {
    value.chars().take(width).collect()
}

async fn fetch_photon(
    net: &TileClient,
    query: &str,
    lang: &str,
    limit: usize,
) -> Result<Vec<GeocodePlace>, String> {
    // Photon only accepts a small language set; other locales use its
    // default labels, while Nominatim still gets the requested language.
    let photon_lang = match lang {
        "de" => "de",
        "fr" => "fr",
        "en" => "en",
        _ => "default",
    };
    let url = format!(
        "{PHOTON_ENDPOINT}?q={}&limit={limit}&lang={}",
        encode_query(query),
        encode_query(photon_lang)
    );
    let text = net
        .fetch_document(&url, &BTreeMap::new(), MAX_RESPONSE_BYTES)
        .await
        .map_err(|error| error.to_string())?;
    parse_photon(&text)
}

async fn fetch_nominatim(
    net: &TileClient,
    query: &str,
    lang: &str,
    limit: usize,
) -> Result<Vec<GeocodePlace>, String> {
    let url = format!(
        "{NOMINATIM_ENDPOINT}?format=jsonv2&addressdetails=0&limit={limit}&q={}&accept-language={}",
        encode_query(query),
        encode_query(lang)
    );
    let text = net
        .fetch_document(&url, &BTreeMap::new(), MAX_RESPONSE_BYTES)
        .await
        .map_err(|error| error.to_string())?;
    parse_nominatim(&text)
}

fn encode_query(value: &str) -> String {
    let mut encoded = String::new();
    for &byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[derive(Deserialize)]
struct PhotonResponse {
    #[serde(default)]
    features: Vec<PhotonFeature>,
}

#[derive(Deserialize)]
struct PhotonFeature {
    geometry: Option<PhotonGeometry>,
    #[serde(default)]
    properties: PhotonProperties,
}

#[derive(Deserialize)]
struct PhotonGeometry {
    #[serde(default)]
    coordinates: Vec<f64>,
}

#[derive(Deserialize, Default)]
struct PhotonProperties {
    name: Option<String>,
    housenumber: Option<String>,
    street: Option<String>,
    city: Option<String>,
    district: Option<String>,
    state: Option<String>,
    country: Option<String>,
    osm_id: Option<Value>,
    osm_type: Option<String>,
    osm_key: Option<String>,
    osm_value: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

fn parse_photon(text: &str) -> Result<Vec<GeocodePlace>, String> {
    let response: PhotonResponse =
        serde_json::from_str(text).map_err(|error| format!("invalid Photon JSON: {error}"))?;
    let mut places = Vec::new();
    for feature in response.features {
        let Some(geometry) = feature.geometry else {
            continue;
        };
        if geometry.coordinates.len() < 2 {
            continue;
        }
        let lon = geometry.coordinates[0];
        let lat = geometry.coordinates[1];
        let properties = feature.properties;
        let street = match (
            properties
                .street
                .as_deref()
                .filter(|value| !value.is_empty()),
            properties
                .housenumber
                .as_deref()
                .filter(|value| !value.is_empty()),
        ) {
            (Some(street), Some(number)) => format!("{street} {number}"),
            (Some(street), None) => street.to_owned(),
            _ => String::new(),
        };
        let parts = [
            properties.name.as_deref(),
            (!street.is_empty()).then_some(street.as_str()),
            properties.city.as_deref(),
            properties.district.as_deref(),
            properties.state.as_deref(),
            properties.country.as_deref(),
        ];
        let label = join_label(&parts);
        let name = properties
            .name
            .filter(|value| !value.trim().is_empty())
            .or_else(|| properties.city.clone())
            .or_else(|| properties.street.clone())
            .unwrap_or_else(|| label.clone());
        let osm_id = properties.osm_id.as_ref().and_then(value_text);
        let id = match (properties.osm_type.as_deref(), osm_id) {
            (Some(kind), Some(id)) => format!("photon:{kind}:{id}"),
            _ => format!("photon:{lat:.5}:{lon:.5}:{name}"),
        };
        let kind = properties
            .osm_value
            .or(properties.osm_key)
            .or(properties.kind);
        places.push(GeocodePlace {
            id,
            name,
            label,
            lon,
            lat,
            kind,
            source: "photon".to_owned(),
        });
    }
    Ok(places
        .into_iter()
        .filter_map(sanitize_place)
        .collect::<Vec<_>>())
}

#[derive(Deserialize)]
struct NominatimPlace {
    place_id: Option<Value>,
    osm_type: Option<String>,
    osm_id: Option<Value>,
    lat: String,
    lon: String,
    display_name: Option<String>,
    name: Option<String>,
    category: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

fn parse_nominatim(text: &str) -> Result<Vec<GeocodePlace>, String> {
    let response: Vec<NominatimPlace> =
        serde_json::from_str(text).map_err(|error| format!("invalid Nominatim JSON: {error}"))?;
    let mut places = Vec::new();
    for item in response {
        let (Ok(lat), Ok(lon)) = (item.lat.parse::<f64>(), item.lon.parse::<f64>()) else {
            continue;
        };
        let label = item
            .display_name
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("{lat:.5}, {lon:.5}"));
        let name = item
            .name
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                label
                    .split(',')
                    .next()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
            })
            .unwrap_or_else(|| format!("{lat:.5}, {lon:.5}"));
        let id = item
            .place_id
            .as_ref()
            .and_then(value_text)
            .map(|id| format!("nominatim:{id}"))
            .or_else(|| {
                item.osm_id.as_ref().and_then(value_text).map(|id| {
                    format!(
                        "nominatim:{}:{id}",
                        item.osm_type.as_deref().unwrap_or("osm")
                    )
                })
            })
            .unwrap_or_else(|| format!("nominatim:{lat:.5}:{lon:.5}:{name}"));
        places.push(GeocodePlace {
            id,
            name,
            label,
            lon,
            lat,
            kind: item.kind.or(item.category),
            source: "nominatim".to_owned(),
        });
    }
    Ok(places
        .into_iter()
        .filter_map(sanitize_place)
        .collect::<Vec<_>>())
}

fn join_label(parts: &[Option<&str>]) -> String {
    let mut label = Vec::new();
    for part in parts.iter().flatten() {
        let value = part.trim();
        if !value.is_empty()
            && !label
                .iter()
                .any(|item: &String| item.eq_ignore_ascii_case(value))
        {
            label.push(value.to_owned());
        }
    }
    label.join(", ")
}

fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(name: &str, label: &str, lon: f64, lat: f64) -> GeocodePlace {
        GeocodePlace {
            id: format!("test:{name}"),
            name: name.to_owned(),
            label: label.to_owned(),
            lon,
            lat,
            kind: None,
            source: "local".to_owned(),
        }
    }

    #[test]
    fn encodes_query_values() {
        assert_eq!(
            encode_query("Санкт-Петербург"),
            "%D0%A1%D0%B0%D0%BD%D0%BA%D1%82-%D0%9F%D0%B5%D1%82%D0%B5%D1%80%D0%B1%D1%83%D1%80%D0%B3"
        );
        assert_eq!(encode_query("a b&c"), "a%20b%26c");
    }

    #[test]
    fn parses_photon_results() {
        let places = parse_photon(
            r#"{
              "features": [
                {
                  "geometry": {"coordinates": [37.6173, 55.7558]},
                  "properties": {
                    "name": "Москва",
                    "city": "Москва",
                    "state": "Москва",
                    "country": "Россия",
                    "osm_id": 123,
                    "osm_type": "R",
                    "osm_value": "city"
                  }
                }
              ]
            }"#,
        )
        .unwrap();
        assert_eq!(places.len(), 1);
        assert_eq!(places[0].name, "Москва");
        assert_eq!(places[0].label, "Москва, Россия");
        assert_eq!(places[0].id, "photon:R:123");
        assert_eq!(places[0].source, "photon");
    }

    #[test]
    fn parses_nominatim_results() {
        let places = parse_nominatim(
            r#"[
              {
                "place_id": 42,
                "lat": "59.9391",
                "lon": "30.3159",
                "display_name": "Санкт-Петербург, Россия",
                "type": "city",
                "category": "place"
              }
            ]"#,
        )
        .unwrap();
        assert_eq!(places.len(), 1);
        assert_eq!(places[0].name, "Санкт-Петербург");
        assert_eq!(places[0].id, "nominatim:42");
        assert_eq!(places[0].kind.as_deref(), Some("city"));
    }

    #[tokio::test]
    async fn local_search_ranks_prefixes() {
        let path =
            std::env::temp_dir().join(format!("mappa-geocode-test-{}.json", std::process::id()));
        let geocoder = Geocoder {
            path,
            places: Mutex::new(vec![
                place("Санкт-Петербург", "Санкт-Петербург, Россия", 30.3, 59.9),
                place("Санкт-Петербургский район", "Район, Россия", 30.4, 59.8),
                place("Москва", "Москва, Россия", 37.6, 55.7),
            ]),
            online_slot: Mutex::new(None),
        };
        let found = geocoder.local_search("Санкт", 5).await;
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].name, "Санкт-Петербург");
        assert!(geocoder.local_search("Мос", 5).await[0].name == "Москва");
    }

    #[tokio::test]
    async fn merges_online_results_and_keeps_local() {
        let directory =
            std::env::temp_dir().join(format!("mappa-geocode-merge-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("geocode.json");
        let geocoder = Geocoder {
            path: path.clone(),
            places: Mutex::new(vec![place("Москва", "Москва, Россия", 37.6, 55.7)]),
            online_slot: Mutex::new(None),
        };
        geocoder
            .merge_online(&[GeocodePlace {
                id: "photon:N:1".to_owned(),
                name: "Тверь".to_owned(),
                label: "Тверь, Россия".to_owned(),
                lon: 35.9,
                lat: 56.8,
                kind: None,
                source: "photon".to_owned(),
            }])
            .await
            .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("Тверь") && text.contains("Москва"));
        let loaded = Geocoder::load(path);
        let places = loaded.places.lock().await;
        assert_eq!(places.len(), 2);
        std::fs::remove_dir_all(directory).ok();
    }
}
