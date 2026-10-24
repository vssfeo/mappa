//! Tauri commands for providers, the tile cache and tile delivery.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

use mappa_core::{Bbox, Crs, CrsPreset, CrsSpec, Provider, ProviderKind, TileRange};
use mappa_storage::{CacheStats, ProviderCacheStats, TileKey, now_unix};
use serde::Serialize;
use tauri::State;

use crate::state::AppState;
use crate::tiles::{load_tile, schedule_refresh};

type SharedState<'a> = State<'a, Arc<AppState>>;

/// Provider fields safe to expose to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    /// Stable id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Protocol family.
    pub kind: ProviderKind,
    /// Lowest zoom.
    pub min_zoom: u8,
    /// Highest zoom.
    pub max_zoom: u8,
    /// Tile edge in pixels.
    pub tile_size: u16,
    /// Image format.
    pub format: String,
    /// Attribution text.
    pub attribution: String,
    /// Terms link.
    pub terms: Option<String>,
    /// Whether offline pre-fetching is permitted.
    pub offline_allowed: bool,
}

impl From<&Provider> for ProviderInfo {
    fn from(provider: &Provider) -> Self {
        Self {
            id: provider.id.clone(),
            name: provider.name.clone(),
            kind: provider.kind,
            min_zoom: provider.min_zoom,
            max_zoom: provider.max_zoom,
            tile_size: provider.tile_size,
            format: provider.format.clone(),
            attribution: provider.attribution.clone(),
            terms: provider.terms.clone(),
            offline_allowed: provider.offline_allowed,
        }
    }
}

/// Lists built-in and user-defined providers.
#[tauri::command]
pub async fn list_providers(state: SharedState<'_>) -> Result<Vec<ProviderInfo>, String> {
    Ok(state
        .all_providers()
        .await
        .iter()
        .map(ProviderInfo::from)
        .collect())
}

/// Lists user-defined sources without their secret headers.
#[tauri::command]
pub async fn list_custom_sources(
    state: SharedState<'_>,
) -> Result<Vec<crate::custom::CustomSource>, String> {
    let mut sources = state.custom_sources().await;
    for source in &mut sources {
        source.headers.clear();
    }
    Ok(sources)
}

/// Validates and saves a user-defined source.
#[tauri::command]
pub async fn save_custom_source(
    state: SharedState<'_>,
    source: crate::custom::CustomSource,
) -> Result<crate::custom::CustomSource, String> {
    let mut stored = state.save_custom_source(source).await?;
    // Secrets must not travel back to the WebView.
    stored.headers.clear();
    Ok(stored)
}

/// Deletes a user-defined source.
#[tauri::command]
pub async fn delete_custom_source(state: SharedState<'_>, id: String) -> Result<(), String> {
    state.delete_custom_source(&id).await
}

/// Reads a WMTS `GetCapabilities` document and lists usable raster layers.
///
/// `headers` never travel back to the WebView. When `sourceId` names an
/// existing source, its stored secret headers are merged in server-side so
/// editing a URL does not lose an API key.
#[tauri::command]
pub async fn wmts_capabilities(
    state: SharedState<'_>,
    url: String,
    headers: Option<BTreeMap<String, String>>,
    source_id: Option<String>,
) -> Result<crate::wmts::WmtsCapabilities, String> {
    let url = url.trim();
    if url.is_empty() || url.len() > 4096 {
        return Err("URL must be 1–4096 characters".to_owned());
    }
    let mut merged = BTreeMap::new();
    if let Some(source_id) = source_id
        && let Some(source) = state
            .custom_sources()
            .await
            .into_iter()
            .find(|source| source.id == source_id)
    {
        merged.extend(source.headers);
    }
    if let Some(headers) = headers {
        merged.extend(headers);
    }
    let client = state.net.read().await.clone();
    let document = client
        .fetch_document(url, &merged, crate::wmts::MAX_CAPABILITIES_BYTES)
        .await
        .map_err(|error| error.to_string())?;
    let capabilities = crate::wmts::parse(&document)?;
    if capabilities.layers.is_empty() {
        return Err(
            "no raster WMTS layers with a Web Mercator tile matrix set were found".to_owned(),
        );
    }
    Ok(capabilities)
}

/// Lists feature tables in a GeoPackage so the user can pick one.
#[tauri::command]
pub async fn list_geopackage_layers(
    path: String,
) -> Result<Vec<crate::gpkg::GeoPackageLayer>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::files::resolve_for_read(&path)?;
        crate::gpkg::layers(&path)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Imports one feature layer from a GeoPackage (the first by default).
#[tauri::command]
pub async fn import_geopackage(
    path: String,
    layer: Option<String>,
) -> Result<crate::gpkg::GeoPackageImport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::files::resolve_for_read(&path)?;
        crate::gpkg::import_layer(&path, layer.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Returns the recovery-project path used by the UI autosave loop.
#[tauri::command]
pub async fn autosave_path(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("cannot locate app data: {error}"))?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
    Ok(directory.join("autosave.mappa").display().to_string())
}

/// Opens the application log directory in the desktop file manager.
#[tauri::command]
pub async fn open_log_directory(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("cannot locate log directory: {error}"))?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
    let display = directory.display().to_string();
    let target = directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("xdg-open")
            .arg(&target)
            .status()
            .map_err(|error| format!("cannot open {}: {error}", target.display()))
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(display)
}

/// Curated CRS presets that are guaranteed to load offline.
#[tauri::command]
pub fn crs_presets() -> Vec<CrsPreset> {
    mappa_core::crs::presets()
}

const CRS_CACHE_LIMIT: usize = 32;

/// Resolves a CRS once per spec; cursor updates transform every 80 ms and
/// must not re-parse an EPSG definition each time.
fn cached_crs(spec: &CrsSpec) -> Result<Arc<Crs>, String> {
    static CACHE: OnceLock<Mutex<HashMap<CrsSpec, Arc<Crs>>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(crs) = cache.get(spec) {
        return Ok(Arc::clone(crs));
    }
    let crs = Arc::new(Crs::new(spec)?);
    if cache.len() >= CRS_CACHE_LIMIT {
        cache.clear();
    }
    cache.insert(spec.clone(), Arc::clone(&crs));
    Ok(crs)
}

/// Converts a batch of points between two coordinate reference systems.
///
/// The batch form keeps the proj4 parsing cost out of per-vertex loops when
/// drawing a grid or exporting coordinates.
#[tauri::command]
pub fn transform_points(
    from: CrsSpec,
    to: CrsSpec,
    points: Vec<[f64; 2]>,
) -> Result<Vec<[f64; 2]>, String> {
    let from = cached_crs(&from)?;
    let to = cached_crs(&to)?;
    points
        .into_iter()
        .map(|point| {
            from.transform_to(&to, point[0], point[1])
                .map(|(x, y)| [x, y])
        })
        .collect()
}

/// Aggregate cache counters.
#[tauri::command]
pub async fn cache_stats(state: SharedState<'_>) -> Result<CacheStats, String> {
    let cache = Arc::clone(&state.cache);
    tauri::async_runtime::spawn_blocking(move || cache.stats().map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

/// Cache usage grouped by provider.
#[tauri::command]
pub async fn cache_stats_by_provider(
    state: SharedState<'_>,
) -> Result<Vec<ProviderCacheStats>, String> {
    let cache = Arc::clone(&state.cache);
    tauri::async_runtime::spawn_blocking(move || {
        cache.provider_stats().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

const MAX_COVERAGE_TILES: usize = 50_000;

/// Cached tile coordinates for one provider and zoom.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageResponse {
    /// `[z, x, y]` triples.
    pub tiles: Vec<[u32; 3]>,
    /// True when the viewport holds more cached tiles than the response cap.
    pub truncated: bool,
}

/// Returns cached tiles intersecting a viewport at one zoom.
#[tauri::command]
pub async fn coverage_tiles(
    state: SharedState<'_>,
    provider_id: String,
    z: u8,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
) -> Result<CoverageResponse, String> {
    let bbox = Bbox::new(west, south, east, north).map_err(|error| error.to_string())?;
    let range = TileRange::new(&bbox, z).map_err(|error| error.to_string())?;
    let cache = Arc::clone(&state.cache);
    let provider = provider_id.clone();
    let (coords, truncated) = tauri::async_runtime::spawn_blocking(move || {
        cache.coverage(&provider, z, &range, MAX_COVERAGE_TILES)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    Ok(CoverageResponse {
        tiles: coords
            .into_iter()
            .map(|(x, y)| [u32::from(z), x, y])
            .collect(),
        truncated,
    })
}

/// SQLite path for diagnostics.
#[tauri::command]
pub fn cache_path(state: SharedState<'_>) -> String {
    state.cache_path.display().to_string()
}

/// Removes all tiles or only one provider's tiles.
#[tauri::command]
pub async fn clear_cache(
    state: SharedState<'_>,
    provider_id: Option<String>,
) -> Result<u64, String> {
    let cache = Arc::clone(&state.cache);
    tauri::async_runtime::spawn_blocking(move || match provider_id {
        Some(provider_id) => cache
            .clear_provider(&provider_id)
            .map_err(|error| error.to_string()),
        None => cache.clear().map_err(|error| error.to_string()),
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Converts a standard `z/x/y` folder into an MBTiles pack in app data.
#[tauri::command]
pub async fn import_xyz_folder(
    app: tauri::AppHandle,
    path: String,
    name: Option<String>,
    license: Option<String>,
) -> Result<crate::xyz::XyzImport, String> {
    use tauri::Manager;
    let root =
        std::fs::canonicalize(&path).map_err(|error| format!("cannot open {path:?}: {error}"))?;
    if !root.is_dir() {
        return Err("XYZ import expects a directory".to_owned());
    }
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("cannot locate app data: {error}"))?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
    let output = directory.join(format!("xyz-{}.mbtiles", mappa_storage::now_unix()));
    tauri::async_runtime::spawn_blocking(move || {
        crate::xyz::import_folder(&root, &output, name.as_deref(), license.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Scans cached image blobs and optionally deletes damaged tiles.
#[tauri::command]
pub async fn verify_cache(
    state: SharedState<'_>,
    repair: bool,
    provider_id: Option<String>,
) -> Result<mappa_storage::IntegrityReport, String> {
    let cache = Arc::clone(&state.cache);
    tauri::async_runtime::spawn_blocking(move || {
        cache
            .verify_integrity(repair, provider_id.as_deref())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Enforces the disk budget and returns the number of evicted tiles.
#[tauri::command]
pub async fn enforce_cache_limit(
    state: SharedState<'_>,
    max_bytes: Option<u64>,
) -> Result<u64, String> {
    let cache = Arc::clone(&state.cache);
    let limit = max_bytes.unwrap_or_else(|| state.cache_limit());
    tauri::async_runtime::spawn_blocking(move || {
        cache
            .enforce_limit(limit)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Returns raw image bytes for MapLibre's `mappa://` protocol.
///
/// Cached tiles are served immediately. Expired tiles are revalidated in the
/// background, so panning stays fast and offline use keeps working.
#[tauri::command]
pub async fn read_tile(
    state: SharedState<'_>,
    provider_id: String,
    z: u8,
    x: u32,
    y: u32,
    variant: Option<String>,
    request_id: Option<u64>,
) -> Result<tauri::ipc::Response, String> {
    let state = Arc::clone(&state);
    let result = match request_id {
        Some(id) => {
            let mut cancelled = state.register_tile(id).await;
            tokio::select! {
                biased;
                _ = cancelled.changed() => Err("tile request cancelled".to_owned()),
                result = read_tile_inner(&state, provider_id, z, x, y, variant) => result,
            }
        }
        None => read_tile_inner(&state, provider_id, z, x, y, variant).await,
    };
    if let Some(id) = request_id {
        state.finish_tile(id).await;
    }
    result
}

/// Cancels a tile request that MapLibre no longer needs.
#[tauri::command]
pub async fn cancel_tile(state: SharedState<'_>, request_id: u64) -> Result<(), String> {
    state.cancel_tile(request_id).await;
    Ok(())
}

async fn read_tile_inner(
    state: &Arc<AppState>,
    provider_id: String,
    z: u8,
    x: u32,
    y: u32,
    variant: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let state = Arc::clone(state);
    let provider = state
        .provider(&provider_id)
        .await
        .ok_or_else(|| format!("unknown provider {provider_id:?}"))?;
    provider
        .tile_url(z, x, y)
        .map_err(|error| error.to_string())?;
    let key = TileKey::new(&provider_id, z, x, y, &provider.format)
        .with_variant(variant.unwrap_or_default());

    let cache = Arc::clone(&state.cache);
    let probe = key.clone();
    let cached = tauri::async_runtime::spawn_blocking(move || cache.get(&probe))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    if let Some(tile) = cached {
        if tile.is_expired(now_unix()) {
            schedule_refresh(Arc::clone(&state), provider, key);
        }
        return Ok(tauri::ipc::Response::new(tile.data));
    }

    let tile = load_tile(&state, &provider, &key).await?;
    Ok(tauri::ipc::Response::new(tile.data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuses_resolved_crs() {
        let first = cached_crs(&CrsSpec::from_epsg(3857)).unwrap();
        let second = cached_crs(&CrsSpec::from_epsg(3857)).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn rejects_empty_spec() {
        let empty = CrsSpec {
            epsg: None,
            proj: None,
        };
        assert!(cached_crs(&empty).is_err());
    }
}
