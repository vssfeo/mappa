//! User-defined XYZ/TMS sources, persisted outside the embedded catalog.
//!
//! Custom sources may carry API headers, so the file is written with owner-only
//! permissions on Unix. Secrets are never logged.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use mappa_core::{Provider, ProviderKind, RateLimit, TileScheme};
use serde::{Deserialize, Serialize};

const DEFAULT_RPS: f32 = 4.0;
const DEFAULT_BURST: u32 = 8;
const MAX_ID_LEN: usize = 48;

fn default_kind() -> String {
    "xyz".to_owned()
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn default_scheme() -> String {
    "xyz".to_owned()
}

fn default_tile_size() -> u16 {
    256
}

fn default_format() -> String {
    "png".to_owned()
}

fn default_rps() -> f32 {
    DEFAULT_RPS
}

fn default_burst() -> u32 {
    DEFAULT_BURST
}

/// Source description sent by the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSource {
    /// Stable id, also used in cache keys and map URLs.
    pub id: String,
    /// Display name.
    pub name: String,
    /// `xyz` (default) or `wms`.
    #[serde(default = "default_kind")]
    pub kind: String,
    /// XYZ/TMS template with `{z}`, `{x}`, `{y}` (`{-y}` is supported) or a
    /// WMS GetMap URL with `{bbox-epsg-3857}`.
    pub url: String,
    /// `xyz` (north-up) or `tms` (flipped Y).
    #[serde(default = "default_scheme")]
    pub scheme: String,
    /// Lowest zoom.
    pub min_zoom: u8,
    /// Highest zoom.
    pub max_zoom: u8,
    /// Tile edge in pixels.
    #[serde(default = "default_tile_size")]
    pub tile_size: u16,
    /// Image format.
    #[serde(default = "default_format")]
    pub format: String,
    /// Attribution text.
    #[serde(default)]
    pub attribution: String,
    /// Optional terms link.
    #[serde(default)]
    pub terms: Option<String>,
    /// Extra request headers, including API keys.
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// When true, `headers` replaces the stored set instead of merging into
    /// it. The UI leaves this false so editing other fields cannot wipe keys
    /// that were deliberately hidden from the WebView.
    #[serde(default, skip_serializing_if = "is_false")]
    pub replace_headers: bool,
    /// Sustained requests per second.
    #[serde(default = "default_rps")]
    pub rps: f32,
    /// Burst size.
    #[serde(default = "default_burst")]
    pub burst: u32,
    /// Whether the source permits offline pre-fetching.
    #[serde(default)]
    pub offline_allowed: bool,
}

impl CustomSource {
    /// Validates the source and converts it to the runtime provider type.
    pub fn to_provider(&self) -> Result<Provider, String> {
        let id = self.id.trim().to_ascii_lowercase();
        if id.is_empty() || id.len() > MAX_ID_LEN {
            return Err("id must be 1–48 characters".to_owned());
        }
        if !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        {
            return Err("id may contain only latin letters, digits, '-' and '_'".to_owned());
        }
        let kind = match self.kind.to_ascii_lowercase().as_str() {
            "" | "xyz" => ProviderKind::Xyz,
            "wms" => ProviderKind::Wms,
            "wmts" => ProviderKind::Wmts,
            other => {
                return Err(format!(
                    "unknown source kind {other:?}; use xyz, wms or wmts"
                ));
            }
        };
        let scheme = match self.scheme.to_ascii_lowercase().as_str() {
            "xyz" => TileScheme::Xyz,
            "tms" => TileScheme::Tms,
            other => return Err(format!("unknown scheme {other:?}; use xyz or tms")),
        };
        let format = match self.format.to_ascii_lowercase().as_str() {
            "jpeg" => "jpg".to_owned(),
            other => other.to_owned(),
        };
        let attribution = if self.attribution.trim().is_empty() {
            self.name.clone()
        } else {
            self.attribution.clone()
        };
        let headers = self
            .headers
            .iter()
            .map(|(name, value)| {
                if name.contains(['\r', '\n']) || value.contains(['\r', '\n']) {
                    Err("headers must not contain line breaks".to_owned())
                } else {
                    Ok((name.trim().to_owned(), value.trim().to_owned()))
                }
            })
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        let provider = Provider {
            id,
            name: self.name.trim().to_owned(),
            kind,
            url: self.url.trim().to_owned(),
            scheme,
            min_zoom: self.min_zoom,
            max_zoom: self.max_zoom,
            tile_size: self.tile_size,
            format,
            attribution,
            terms: self.terms.clone().filter(|value| !value.trim().is_empty()),
            rate_limit: Some(RateLimit {
                rps: self.rps.clamp(1.0, 20.0),
                burst: self.burst.clamp(1, 64),
            }),
            headers,
            auth: None,
            offline_allowed: self.offline_allowed,
        };
        provider
            .validate()
            .map_err(|error| format!("invalid source: {error}"))?;
        Ok(provider)
    }

    /// Snapshot of a validated provider for persistence.
    fn from_provider(provider: &Provider) -> Self {
        Self {
            id: provider.id.clone(),
            name: provider.name.clone(),
            kind: match provider.kind {
                ProviderKind::Wms => "wms".to_owned(),
                ProviderKind::Wmts => "wmts".to_owned(),
                _ => "xyz".to_owned(),
            },
            url: provider.url.clone(),
            scheme: match provider.scheme {
                TileScheme::Xyz => "xyz".to_owned(),
                TileScheme::Tms => "tms".to_owned(),
            },
            min_zoom: provider.min_zoom,
            max_zoom: provider.max_zoom,
            tile_size: provider.tile_size,
            format: provider.format.clone(),
            attribution: provider.attribution.clone(),
            terms: provider.terms.clone(),
            headers: provider.headers.clone(),
            replace_headers: false,
            rps: provider.rate_limit.map_or(DEFAULT_RPS, |limit| limit.rps),
            burst: provider
                .rate_limit
                .map_or(DEFAULT_BURST, |limit| limit.burst),
            offline_allowed: provider.offline_allowed,
        }
    }
}

/// Reads the persisted sources; malformed entries are skipped.
pub fn load(path: &Path) -> Vec<CustomSource> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<CustomSource>>(&text) {
        Ok(sources) => sources
            .into_iter()
            .filter(|source| {
                if let Err(error) = source.to_provider() {
                    log::warn!("skipping custom source {:?}: {error}", source.id);
                    false
                } else {
                    true
                }
            })
            .collect(),
        Err(error) => {
            log::warn!("cannot parse {}: {error}", path.display());
            Vec::new()
        }
    }
}

/// Writes sources atomically with owner-only permissions when supported.
pub fn save(path: &Path, sources: &[CustomSource]) -> Result<(), String> {
    let data =
        serde_json::to_vec_pretty(sources).map_err(|error| format!("cannot serialize: {error}"))?;
    crate::atomic::write(path, &data, true)
        .map_err(|error| format!("cannot save {}: {error}", path.display()))
}

/// Builds the source list stored on disk from validated providers.
pub fn merge(existing: &[CustomSource], provider: &Provider) -> (CustomSource, Vec<CustomSource>) {
    let source = CustomSource::from_provider(provider);
    let mut next = existing
        .iter()
        .filter(|item| item.id != source.id)
        .cloned()
        .collect::<Vec<_>>();
    next.push(source.clone());
    next.sort_by(|left, right| left.name.cmp(&right.name));
    (source, next)
}

/// File that stores the custom catalog.
pub fn path(config_dir: &Path) -> PathBuf {
    config_dir.join("custom-providers.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> CustomSource {
        CustomSource {
            id: "custom-demo".to_owned(),
            name: "Demo".to_owned(),
            kind: "xyz".to_owned(),
            url: "https://tiles.example.org/{z}/{x}/{y}.png".to_owned(),
            scheme: "xyz".to_owned(),
            min_zoom: 0,
            max_zoom: 18,
            tile_size: 256,
            format: "png".to_owned(),
            attribution: "Demo".to_owned(),
            terms: None,
            headers: BTreeMap::from([("Authorization".to_owned(), "Bearer secret".to_owned())]),
            replace_headers: false,
            rps: 4.0,
            burst: 8,
            offline_allowed: true,
        }
    }

    #[test]
    fn validates_and_normalizes_sources() {
        let provider = source().to_provider().unwrap();
        assert_eq!(provider.id, "custom-demo");
        assert_eq!(provider.rate_limit.unwrap().burst, 8);
        assert!(provider.offline_allowed);
    }

    #[test]
    fn rejects_bad_ids_and_urls() {
        let mut bad = source();
        bad.id = "bad id".to_owned();
        assert!(bad.to_provider().is_err());
        bad = source();
        bad.url = "ftp://example.org/{z}/{x}/{y}.png".to_owned();
        assert!(bad.to_provider().is_err());
        bad = source();
        bad.scheme = "wms".to_owned();
        assert!(bad.to_provider().is_err());
    }

    #[test]
    fn accepts_wms_sources() {
        let mut wms = source();
        wms.kind = "wms".to_owned();
        wms.url = "https://wms.example.org/?service=WMS&request=GetMap&layers=demo&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256".to_owned();
        let provider = wms.to_provider().unwrap();
        assert_eq!(provider.kind, ProviderKind::Wms);
        assert!(
            provider
                .tile_url(0, 0, 0)
                .unwrap()
                .contains("bbox=-20037508")
        );
    }

    #[test]
    fn accepts_wmts_sources() {
        let mut wmts = source();
        wmts.kind = "wmts".to_owned();
        wmts.url = "https://tiles.example.org/wmts?layer=base&tilematrix={TileMatrix}&tilecol={TileCol}&tilerow={TileRow}&format=image/png".to_owned();
        let provider = wmts.to_provider().unwrap();
        assert_eq!(provider.kind, ProviderKind::Wmts);
        assert_eq!(
            provider.tile_url(1, 0, 1).unwrap(),
            "https://tiles.example.org/wmts?layer=base&tilematrix=1&tilecol=0&tilerow=1&format=image/png"
        );
    }

    #[test]
    fn rejects_unknown_source_kind() {
        let mut bad = source();
        bad.kind = "wms2".to_owned();
        assert!(bad.to_provider().is_err());
    }

    #[test]
    fn rejects_header_injection() {
        let mut bad = source();
        bad.headers
            .insert("X-Test".to_owned(), "value\r\nInjected: yes".to_owned());
        assert!(bad.to_provider().is_err());
    }

    #[test]
    fn round_trips_through_disk() {
        let directory =
            std::env::temp_dir().join(format!("mappa-custom-test-{}", std::process::id()));
        let file = path(&directory);
        let (stored, sources) = merge(&[], &source().to_provider().unwrap());
        save(&file, &sources).unwrap();
        let loaded = load(&file);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, stored.id);
        assert_eq!(
            loaded[0].headers.get("Authorization").map(String::as_str),
            Some("Bearer secret")
        );
        let _ = std::fs::remove_dir_all(directory);
    }
}
