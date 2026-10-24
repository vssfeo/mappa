//! Local MBTiles/PMTiles packs served as MapLibre raster layers.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use mappa_storage::{Mbtiles, PmtilesPack, StorageError, StorageResult};
use serde::Serialize;
use serde_json::Value;
use tauri::State;
use tokio::sync::Mutex;

use crate::state::AppState;

/// Pack metadata exposed to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInfo {
    /// Deterministic id derived from the canonical path.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Absolute path.
    pub path: String,
    /// `mbtiles` or `pmtiles`.
    pub kind: String,
    /// Raster format.
    pub format: String,
    /// Minimum zoom.
    pub min_zoom: u8,
    /// Maximum zoom.
    pub max_zoom: u8,
    /// West bound.
    pub west: f64,
    /// South bound.
    pub south: f64,
    /// East bound.
    pub east: f64,
    /// North bound.
    pub north: f64,
    /// Attribution.
    pub attribution: Option<String>,
    /// Known tile count (MBTiles only).
    pub tiles: Option<u64>,
}

/// Open pack readers keyed by id.
#[derive(Default)]
pub struct Packs {
    entries: Mutex<HashMap<String, Arc<PackEntry>>>,
}

struct PackEntry {
    info: PackInfo,
    reader: PackReader,
}

enum PackReader {
    Mbtiles(Arc<std::sync::Mutex<Mbtiles>>),
    Pmtiles(Box<PmtilesPack>),
}

impl PackReader {
    async fn get_tile(&self, z: u8, x: u32, y: u32) -> StorageResult<Option<Vec<u8>>> {
        match self {
            Self::Mbtiles(pack) => {
                // rusqlite is blocking; keep large packs from occupying the
                // async workers that also serve the rest of the UI.
                let pack = Arc::clone(pack);
                tauri::async_runtime::spawn_blocking(move || {
                    pack.lock()
                        .map_err(|_| StorageError::InvalidMbtiles("pack mutex poisoned".into()))?
                        .get_tile(z, x, y)
                })
                .await
                .map_err(|error| {
                    StorageError::InvalidMbtiles(format!("pack task failed: {error}"))
                })?
            }
            Self::Pmtiles(pack) => pack.get_tile(z, x, y).await,
        }
    }
}

impl Packs {
    /// Registry with no open packs.
    pub fn new() -> Self {
        Self::default()
    }

    async fn get(&self, id: &str) -> Option<Arc<PackEntry>> {
        self.entries.lock().await.get(id).cloned()
    }

    async fn insert(&self, id: String, entry: Arc<PackEntry>) {
        self.entries.lock().await.insert(id, entry);
    }

    async fn list(&self) -> Vec<PackInfo> {
        self.entries
            .lock()
            .await
            .values()
            .map(|entry| entry.info.clone())
            .collect()
    }

    async fn remove(&self, id: &str) {
        self.entries.lock().await.remove(id);
    }
}

/// Opens an MBTiles or PMTiles file and registers it as a raster layer.
#[tauri::command]
pub async fn open_pack(state: State<'_, Arc<AppState>>, path: String) -> Result<PackInfo, String> {
    let path =
        std::fs::canonicalize(&path).map_err(|error| format!("cannot open {path:?}: {error}"))?;
    let id = pack_id(&path);
    if let Some(entry) = state.packs.get(&id).await {
        return Ok(entry.info.clone());
    }

    let (info, reader) = open_reader(&path, id.clone()).await?;

    let entry = Arc::new(PackEntry {
        info: info.clone(),
        reader,
    });
    state.packs.insert(id, Arc::clone(&entry)).await;
    log::info!(
        "opened {} pack {} ({} z{}–z{})",
        info.kind,
        info.path,
        info.name,
        info.min_zoom,
        info.max_zoom
    );
    Ok(entry.info.clone())
}

/// Lists packs opened in this session.
#[tauri::command]
pub async fn list_packs(state: State<'_, Arc<AppState>>) -> Result<Vec<PackInfo>, String> {
    Ok(state.packs.list().await)
}

/// Unregisters a pack.
#[tauri::command]
pub async fn close_pack(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.packs.remove(&id).await;
    Ok(())
}

/// Returns one tile from an open pack.
#[tauri::command]
pub async fn read_pack_tile(
    state: State<'_, Arc<AppState>>,
    pack_id: String,
    z: u8,
    x: u32,
    y: u32,
) -> Result<tauri::ipc::Response, String> {
    let entry = state
        .packs
        .get(&pack_id)
        .await
        .ok_or_else(|| format!("pack {pack_id:?} is not open"))?;
    match entry.reader.get_tile(z, x, y).await {
        Ok(Some(data)) => Ok(tauri::ipc::Response::new(data)),
        Ok(None) => Err(format!("{pack_id}: no tile {z}/{x}/{y}")),
        Err(error) => Err(error.to_string()),
    }
}

async fn open_reader(path: &Path, id: String) -> Result<(PackInfo, PackReader), String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("pack")
        .to_owned();

    match extension.as_str() {
        "mbtiles" => {
            // SQLite metadata, min/max and count(*) can scan a large pack;
            // keep that off the async runtime.
            let path = path.to_path_buf();
            let (info, pack) = tauri::async_runtime::spawn_blocking(
                move || -> Result<(PackInfo, Mbtiles), String> {
                    let pack = Mbtiles::open(&path).map_err(|error| error.to_string())?;
                    let metadata = pack.metadata().clone();
                    let format = if metadata.format.is_empty() {
                        "png".to_owned()
                    } else {
                        metadata.format.clone()
                    };
                    ensure_raster(&format)?;
                    let bounds = metadata.bounds;
                    let info = PackInfo {
                        id,
                        name: metadata.name.clone().unwrap_or(stem),
                        path: path.display().to_string(),
                        kind: "mbtiles".to_owned(),
                        format,
                        min_zoom: pack
                            .min_zoom()
                            .map_err(|error| error.to_string())?
                            .unwrap_or(0),
                        max_zoom: pack
                            .max_zoom()
                            .map_err(|error| error.to_string())?
                            .unwrap_or(19),
                        west: bounds.map_or(-180.0, |value| value.west()),
                        south: bounds.map_or(-85.0, |value| value.south()),
                        east: bounds.map_or(180.0, |value| value.east()),
                        north: bounds.map_or(85.0, |value| value.north()),
                        attribution: metadata.attribution.clone(),
                        tiles: Some(pack.tile_count().map_err(|error| error.to_string())?),
                    };
                    Ok((info, pack))
                },
            )
            .await
            .map_err(|error| error.to_string())??;
            Ok((
                info,
                PackReader::Mbtiles(Arc::new(std::sync::Mutex::new(pack))),
            ))
        }
        "pmtiles" => {
            let pack = PmtilesPack::open(path)
                .await
                .map_err(|error| error.to_string())?;
            let header = pack.info().clone();
            ensure_raster(&header.format)?;
            let metadata = pack
                .metadata()
                .await
                .ok()
                .flatten()
                .and_then(|value| serde_json::from_str::<Value>(&value).ok());
            let name = metadata
                .as_ref()
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str)
                .unwrap_or(&stem)
                .to_owned();
            let attribution = metadata
                .as_ref()
                .and_then(|value| value.get("attribution"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let info = PackInfo {
                id,
                name,
                path: path.display().to_string(),
                kind: "pmtiles".to_owned(),
                format: header.format,
                min_zoom: header.min_zoom,
                max_zoom: header.max_zoom,
                west: header.west,
                south: header.south,
                east: header.east,
                north: header.north,
                attribution,
                tiles: None,
            };
            Ok((info, PackReader::Pmtiles(Box::new(pack))))
        }
        other => Err(format!(
            "unsupported pack extension {other:?}; expected .mbtiles or .pmtiles"
        )),
    }
}

fn ensure_raster(format: &str) -> Result<(), String> {
    if matches!(format, "png" | "jpg" | "jpeg" | "webp" | "avif") {
        Ok(())
    } else {
        Err(format!(
            "pack format {format:?} is not a raster image; Mappa currently opens raster packs only"
        ))
    }
}

fn pack_id(path: &Path) -> String {
    let hash = blake3::hash(path.to_string_lossy().as_bytes());
    format!("pack-{}", &hash.to_hex()[..16])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_stable_and_path_specific() {
        let first = pack_id(Path::new("/tmp/a.mbtiles"));
        let second = pack_id(Path::new("/tmp/a.mbtiles"));
        let other = pack_id(Path::new("/tmp/b.mbtiles"));
        assert_eq!(first, second);
        assert_ne!(first, other);
        assert!(first.starts_with("pack-"));
    }

    #[test]
    fn rejects_vector_formats() {
        assert!(ensure_raster("mvt").is_err());
        assert!(ensure_raster("png").is_ok());
        assert!(ensure_raster("avif").is_ok());
    }

    #[test]
    fn storage_error_is_displayable() {
        let error = StorageError::InvalidMbtiles("test".into());
        assert!(error.to_string().contains("test"));
    }

    #[test]
    fn imports_mbtiles_as_layer() {
        use mappa_storage::{MbtilesMetadata, MbtilesWriter};

        let directory = std::env::temp_dir().join(format!("mappa-pack-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("sample.mbtiles");
        let metadata = MbtilesMetadata {
            name: Some("Sample pack".to_owned()),
            format: "png".to_owned(),
            minzoom: Some(1),
            maxzoom: Some(2),
            attribution: Some("© test".to_owned()),
            ..MbtilesMetadata::default()
        };
        let mut writer = MbtilesWriter::create(&path, metadata).unwrap();
        writer.put_tile(1, 0, 0, b"tile-bytes").unwrap();
        writer.finish().unwrap();

        let (info, reader) =
            tauri::async_runtime::block_on(open_reader(&path, pack_id(&path))).unwrap();
        assert_eq!(info.kind, "mbtiles");
        assert_eq!(info.name, "Sample pack");
        assert_eq!(info.format, "png");
        assert_eq!(info.tiles, Some(1));
        assert_eq!(info.min_zoom, 1);
        assert_eq!(info.max_zoom, 2);
        assert_eq!(info.attribution.as_deref(), Some("© test"));

        let data = tauri::async_runtime::block_on(reader.get_tile(1, 0, 0))
            .unwrap()
            .unwrap();
        assert_eq!(data, b"tile-bytes");
        std::fs::remove_dir_all(&directory).ok();
    }
}
