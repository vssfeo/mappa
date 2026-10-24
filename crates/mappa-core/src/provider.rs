//! Provider catalog: YAML descriptions of tile sources.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Default lowest zoom served by a provider.
pub const DEFAULT_MIN_ZOOM: u8 = 0;
/// Default highest zoom served by a provider.
pub const DEFAULT_MAX_ZOOM: u8 = 19;
/// Default tile edge in pixels.
pub const DEFAULT_TILE_SIZE: u16 = 256;

/// Protocol family of a provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    /// Plain XYZ/TMS tile template.
    Xyz,
    /// TMS tile template with a flipped Y axis.
    Tms,
    /// OGC WMTS.
    Wmts,
    /// OGC WMS.
    Wms,
}

/// Tile addressing scheme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TileScheme {
    /// Y grows from north to south.
    Xyz,
    /// Y grows from south to north.
    Tms,
}

/// Per-provider request budget.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
pub struct RateLimit {
    /// Sustained requests per second.
    pub rps: f32,
    /// Maximum burst size.
    pub burst: u32,
}

/// Placeholder style for a required API key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    /// No authentication.
    None,
    /// Key is sent in a header.
    Header,
    /// Key is appended to the query string.
    Query,
    /// HTTP basic authentication.
    Basic,
}

/// Authentication description. Secrets are never stored in the catalog.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Auth {
    /// Authentication mechanism.
    pub kind: AuthKind,
    /// Header or query parameter name.
    pub name: Option<String>,
}

/// A single tile source.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Provider {
    /// Stable identifier used in cache keys and URLs.
    pub id: String,
    /// Human-readable name.
    pub name: String,
    /// Protocol family.
    #[serde(rename = "type")]
    pub kind: ProviderKind,
    /// URL template with `{z}`, `{x}`, `{y}` placeholders.
    pub url: String,
    /// Tile addressing scheme.
    pub scheme: TileScheme,
    /// Lowest supported zoom.
    #[serde(default = "default_min_zoom")]
    pub min_zoom: u8,
    /// Highest supported zoom.
    #[serde(default = "default_max_zoom")]
    pub max_zoom: u8,
    /// Tile edge in pixels.
    #[serde(default = "default_tile_size")]
    pub tile_size: u16,
    /// Tile image format (`png`, `jpg`, `webp`).
    #[serde(default = "default_format")]
    pub format: String,
    /// Attribution shown in the UI and stored in packs.
    pub attribution: String,
    /// Link to the provider's terms.
    #[serde(default)]
    pub terms: Option<String>,
    /// Optional request budget.
    #[serde(default)]
    pub rate_limit: Option<RateLimit>,
    /// Extra request headers.
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Optional authentication description.
    #[serde(default)]
    pub auth: Option<Auth>,
    /// Whether the provider permits pre-fetching tiles for offline use.
    ///
    /// OpenStreetMap's tile policy explicitly forbids offline downloads, so
    /// this defaults to `false`; bulk download requires a provider that
    /// grants it.
    #[serde(default)]
    pub offline_allowed: bool,
}

fn default_min_zoom() -> u8 {
    DEFAULT_MIN_ZOOM
}

fn default_max_zoom() -> u8 {
    DEFAULT_MAX_ZOOM
}

fn default_tile_size() -> u16 {
    DEFAULT_TILE_SIZE
}

fn default_format() -> String {
    "png".to_owned()
}

impl Provider {
    /// Parses and validates one YAML document.
    pub fn from_yaml(yaml: &str) -> Result<Self, ProviderError> {
        let mut provider: Self = serde_yaml_ng::from_str(yaml)?;
        provider.format = match provider.format.to_ascii_lowercase().as_str() {
            "jpeg" | "jpg" => "jpg".to_owned(),
            "png" => "png".to_owned(),
            "webp" => "webp".to_owned(),
            _ => provider.format,
        };
        provider.validate()?;
        Ok(provider)
    }

    /// Validates catalog invariants.
    pub fn validate(&self) -> Result<(), ProviderError> {
        if self.id.is_empty()
            || !self.id.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
            })
        {
            return Err(ProviderError::InvalidId(self.id.clone()));
        }
        if self.name.trim().is_empty() {
            return Err(ProviderError::InvalidName(self.id.clone()));
        }
        if self.min_zoom > self.max_zoom {
            return Err(ProviderError::InvalidZoomRange {
                min: self.min_zoom,
                max: self.max_zoom,
            });
        }
        if !matches!(self.tile_size, 256 | 512) {
            return Err(ProviderError::InvalidTileSize(self.tile_size));
        }
        if !matches!(self.format.as_str(), "png" | "jpg" | "jpeg" | "webp") {
            return Err(ProviderError::InvalidFormat(self.format.clone()));
        }
        match self.kind {
            ProviderKind::Xyz | ProviderKind::Tms => {
                for placeholder in ["{z}", "{x}"] {
                    if !self.url.contains(placeholder) {
                        return Err(ProviderError::MissingPlaceholder {
                            id: self.id.clone(),
                            placeholder,
                        });
                    }
                }
                // `{-y}` is the common TMS spelling and is substituted directly.
                if !self.url.contains("{y}") && !self.url.contains("{-y}") {
                    return Err(ProviderError::MissingPlaceholder {
                        id: self.id.clone(),
                        placeholder: "{y}",
                    });
                }
            }
            ProviderKind::Wms => {
                if !self.url.contains("{bbox}") && !self.url.contains("{bbox-epsg-3857}") {
                    return Err(ProviderError::MissingPlaceholder {
                        id: self.id.clone(),
                        placeholder: "{bbox-epsg-3857}",
                    });
                }
            }
            ProviderKind::Wmts => {
                let wmts = self.url.contains("{TileMatrix}")
                    && self.url.contains("{TileCol}")
                    && self.url.contains("{TileRow}");
                let xyz = self.url.contains("{z}")
                    && self.url.contains("{x}")
                    && self.url.contains("{y}");
                if !wmts && !xyz {
                    return Err(ProviderError::MissingPlaceholder {
                        id: self.id.clone(),
                        placeholder: "{TileMatrix}/{TileCol}/{TileRow}",
                    });
                }
            }
        }
        if !self.url.starts_with("https://") && !self.url.starts_with("http://") {
            return Err(ProviderError::InvalidUrl(self.url.clone()));
        }
        if let Some(limit) = self.rate_limit
            && (!limit.rps.is_finite() || limit.rps <= 0.0 || limit.burst == 0)
        {
            return Err(ProviderError::InvalidRateLimit(self.id.clone()));
        }
        Ok(())
    }

    /// Builds the URL for one tile.
    ///
    /// Returns [`ProviderError::ZoomOutOfRange`] when the zoom is outside the
    /// provider's declared range.
    pub fn tile_url(&self, z: u8, x: u32, y: u32) -> Result<String, ProviderError> {
        if z < self.min_zoom || z > self.max_zoom {
            return Err(ProviderError::ZoomOutOfRange {
                id: self.id.clone(),
                z,
                min: self.min_zoom,
                max: self.max_zoom,
            });
        }
        let side = 1_u32.checked_shl(u32::from(z)).unwrap_or(0);
        if side == 0 || x >= side || y >= side {
            return Err(ProviderError::TileOutOfRange { z, x, y });
        }
        let flipped = side - 1 - y;
        let y_value = match self.scheme {
            TileScheme::Xyz => y,
            TileScheme::Tms => flipped,
        };
        let mut url = self
            .url
            .replace("{z}", &z.to_string())
            .replace("{x}", &x.to_string())
            .replace("{y}", &y_value.to_string())
            .replace("{-y}", &flipped.to_string());
        if self.kind == ProviderKind::Wmts {
            url = url
                .replace("{TileMatrix}", &z.to_string())
                .replace("{TileCol}", &x.to_string())
                .replace("{TileRow}", &y.to_string());
        }
        if self.kind == ProviderKind::Wms {
            let bbox = wms_bbox_3857(z, x, y);
            url = url
                .replace("{bbox-epsg-3857}", &bbox)
                .replace("{bbox}", &bbox);
        }
        if url.contains('{') || url.contains('}') {
            return Err(ProviderError::UnknownPlaceholder(url));
        }
        Ok(url)
    }
}

/// Web Mercator tile bounds in WMS `minx,miny,maxx,maxy` order.
fn wms_bbox_3857(z: u8, x: u32, y: u32) -> String {
    const HALF_WORLD: f64 = 20_037_508.342_789_244;
    let tiles = f64::from(1_u32 << z);
    let size = 2.0 * HALF_WORLD / tiles;
    let min_x = -HALF_WORLD + f64::from(x) * size;
    let max_y = HALF_WORLD - f64::from(y) * size;
    format!("{},{},{},{}", min_x, max_y - size, min_x + size, max_y)
}

/// In-memory catalog of providers keyed by id.
#[derive(Debug, Clone, Default)]
pub struct ProviderCatalog {
    providers: BTreeMap<String, Provider>,
}

impl ProviderCatalog {
    /// Creates an empty catalog.
    pub fn new() -> Self {
        Self::default()
    }

    /// Loads the providers shipped with Mappa.
    ///
    /// The YAML is embedded so the desktop app and CLI work outside the
    /// source tree.
    pub fn builtin() -> Result<Self, ProviderError> {
        let mut catalog = Self::new();
        for yaml in [
            include_str!("../../../providers/osm.yaml"),
            include_str!("../../../providers/opentopomap.yaml"),
            include_str!("../../../providers/carto-dark.yaml"),
            include_str!("../../../providers/usgs-imagery.yaml"),
            include_str!("../../../providers/osm-de.yaml"),
        ] {
            catalog.insert(Provider::from_yaml(yaml)?)?;
        }
        Ok(catalog)
    }

    /// Loads every `*.yaml`/`*.yml` file from a directory.
    pub fn load_dir(path: impl AsRef<Path>) -> Result<Self, ProviderError> {
        let mut catalog = Self::new();
        let mut entries = fs::read_dir(path)?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| {
                        ext.eq_ignore_ascii_case("yaml") || ext.eq_ignore_ascii_case("yml")
                    })
            })
            .collect::<Vec<_>>();
        entries.sort();
        for path in entries {
            let yaml = fs::read_to_string(&path)?;
            catalog.insert(Provider::from_yaml(&yaml)?)?;
        }
        Ok(catalog)
    }

    /// Adds a provider, rejecting duplicate ids.
    pub fn insert(&mut self, provider: Provider) -> Result<(), ProviderError> {
        if self.providers.contains_key(&provider.id) {
            return Err(ProviderError::DuplicateId(provider.id));
        }
        self.providers.insert(provider.id.clone(), provider);
        Ok(())
    }

    /// Looks up a provider by id.
    pub fn get(&self, id: &str) -> Option<&Provider> {
        self.providers.get(id)
    }

    /// Iterates over providers sorted by id.
    pub fn iter(&self) -> impl Iterator<Item = &Provider> {
        self.providers.values()
    }

    /// Number of providers in the catalog.
    pub fn len(&self) -> usize {
        self.providers.len()
    }

    /// Returns `true` when the catalog has no providers.
    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }
}

/// Catalog and provider errors.
#[derive(Debug)]
pub enum ProviderError {
    /// Filesystem error while loading a catalog.
    Io(std::io::Error),
    /// YAML syntax or shape error.
    Yaml(serde_yaml_ng::Error),
    /// Two providers share an id.
    DuplicateId(String),
    /// Provider id contains unsupported characters.
    InvalidId(String),
    /// Provider has no display name.
    InvalidName(String),
    /// Zoom range is inverted.
    InvalidZoomRange { min: u8, max: u8 },
    /// Tile size is not 256 or 512.
    InvalidTileSize(u16),
    /// Unsupported image format.
    InvalidFormat(String),
    /// URL template lacks a required placeholder.
    MissingPlaceholder {
        id: String,
        placeholder: &'static str,
    },
    /// Protocol family is not implemented yet.
    UnsupportedKind { id: String, kind: ProviderKind },
    /// URL is not HTTP(S).
    InvalidUrl(String),
    /// Rate limit values are nonsensical.
    InvalidRateLimit(String),
    /// Requested zoom is outside the provider range.
    ZoomOutOfRange { id: String, z: u8, min: u8, max: u8 },
    /// Tile coordinate is outside the pyramid.
    TileOutOfRange { z: u8, x: u32, y: u32 },
    /// URL still contains an unknown placeholder.
    UnknownPlaceholder(String),
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "cannot read provider catalog: {error}"),
            Self::Yaml(error) => write!(f, "invalid provider YAML: {error}"),
            Self::DuplicateId(id) => write!(f, "duplicate provider id: {id}"),
            Self::InvalidId(id) => write!(f, "invalid provider id: {id:?}"),
            Self::InvalidName(id) => write!(f, "provider {id:?} has an empty name"),
            Self::InvalidZoomRange { min, max } => {
                write!(f, "invalid zoom range: min_zoom {min} > max_zoom {max}")
            }
            Self::InvalidTileSize(size) => {
                write!(f, "invalid tile_size {size}, expected 256 or 512")
            }
            Self::InvalidFormat(format) => write!(f, "unsupported tile format {format:?}"),
            Self::MissingPlaceholder { id, placeholder } => {
                write!(f, "provider {id:?} URL lacks {placeholder}")
            }
            Self::UnsupportedKind { id, kind } => {
                write!(f, "provider {id:?} uses unsupported type {kind:?}")
            }
            Self::InvalidUrl(url) => write!(f, "provider URL must be HTTP(S): {url:?}"),
            Self::InvalidRateLimit(id) => write!(f, "provider {id:?} has an invalid rate limit"),
            Self::ZoomOutOfRange { id, z, min, max } => {
                write!(f, "provider {id:?} supports zooms {min}..={max}, got {z}")
            }
            Self::TileOutOfRange { z, x, y } => {
                write!(f, "tile {z}/{x}/{y} is outside the pyramid")
            }
            Self::UnknownPlaceholder(url) => write!(f, "unknown placeholder left in {url:?}"),
        }
    }
}

impl std::error::Error for ProviderError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Yaml(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for ProviderError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_yaml_ng::Error> for ProviderError {
    fn from(error: serde_yaml_ng::Error) -> Self {
        Self::Yaml(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OSM: &str = include_str!("../../../providers/osm.yaml");
    const OSM_DE: &str = include_str!("../../../providers/osm-de.yaml");
    const TOPO: &str = include_str!("../../../providers/opentopomap.yaml");
    const CARTO: &str = include_str!("../../../providers/carto-dark.yaml");
    const USGS: &str = include_str!("../../../providers/usgs-imagery.yaml");

    #[test]
    fn parses_shipped_providers() {
        let mut catalog = ProviderCatalog::new();
        for yaml in [OSM, OSM_DE, TOPO, CARTO, USGS] {
            catalog
                .insert(Provider::from_yaml(yaml).expect("valid provider"))
                .unwrap();
        }
        assert_eq!(catalog.len(), 5);
        assert_eq!(catalog.get("osm").unwrap().max_zoom, 19);
        assert_eq!(catalog.get("carto").unwrap().max_zoom, 20);
        assert!(!catalog.get("osm").unwrap().offline_allowed);
        assert!(catalog.get("usgs").unwrap().offline_allowed);
    }

    #[test]
    fn canonicalizes_image_format() {
        let yaml = OSM.replace("format: png", "format: JPEG");
        let provider = Provider::from_yaml(&yaml).unwrap();
        assert_eq!(provider.format, "jpg");
    }

    #[test]
    fn builds_xyz_url() {
        let provider = Provider::from_yaml(OSM).unwrap();
        assert_eq!(
            provider.tile_url(5, 10, 12).unwrap(),
            "https://tile.openstreetmap.org/5/10/12.png"
        );
    }

    #[test]
    fn flips_y_for_tms() {
        let mut provider = Provider::from_yaml(OSM).unwrap();
        provider.scheme = TileScheme::Tms;
        assert_eq!(
            provider.tile_url(2, 1, 0).unwrap(),
            "https://tile.openstreetmap.org/2/1/3.png"
        );
    }

    #[test]
    fn supports_negative_y_placeholder() {
        let mut provider = Provider::from_yaml(OSM).unwrap();
        provider.url = "https://example.test/{z}/{x}/{-y}.png".to_owned();
        assert!(provider.validate().is_ok());
        assert_eq!(
            provider.tile_url(2, 1, 0).unwrap(),
            "https://example.test/2/1/3.png"
        );
    }

    #[test]
    fn rejects_zoom_outside_range() {
        let provider = Provider::from_yaml(OSM).unwrap();
        assert!(matches!(
            provider.tile_url(20, 1, 1),
            Err(ProviderError::ZoomOutOfRange { .. })
        ));
    }

    #[test]
    fn rejects_out_of_range_tile() {
        let provider = Provider::from_yaml(OSM).unwrap();
        assert!(matches!(
            provider.tile_url(2, 4, 0),
            Err(ProviderError::TileOutOfRange { .. })
        ));
    }

    #[test]
    fn rejects_missing_placeholder() {
        let yaml = OSM.replace("{y}", "0");
        assert!(matches!(
            Provider::from_yaml(&yaml),
            Err(ProviderError::MissingPlaceholder { .. })
        ));
    }

    #[test]
    fn builds_wms_getmap_url() {
        let yaml = OSM
            .replace("type: xyz", "type: wms")
            .replace(
                "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
                "https://wms.example.org/?service=WMS&request=GetMap&layers=demo&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256",
            );
        let provider = Provider::from_yaml(&yaml).unwrap();
        assert!(provider.validate().is_ok());
        assert_eq!(
            provider.tile_url(0, 0, 0).unwrap(),
            "https://wms.example.org/?service=WMS&request=GetMap&layers=demo&crs=EPSG:3857&bbox=-20037508.342789244,-20037508.342789244,20037508.342789244,20037508.342789244&width=256&height=256"
        );
        assert_eq!(
            provider.tile_url(1, 0, 0).unwrap(),
            "https://wms.example.org/?service=WMS&request=GetMap&layers=demo&crs=EPSG:3857&bbox=-20037508.342789244,0,0,20037508.342789244&width=256&height=256"
        );
    }

    #[test]
    fn rejects_wms_without_bbox() {
        let yaml = OSM.replace("type: xyz", "type: wms");
        assert!(matches!(
            Provider::from_yaml(&yaml),
            Err(ProviderError::MissingPlaceholder { .. })
        ));
    }

    #[test]
    fn rejects_duplicate_ids() {
        let mut catalog = ProviderCatalog::new();
        catalog.insert(Provider::from_yaml(OSM).unwrap()).unwrap();
        assert!(matches!(
            catalog.insert(Provider::from_yaml(OSM).unwrap()),
            Err(ProviderError::DuplicateId(_))
        ));
    }
}
