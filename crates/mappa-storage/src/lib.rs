//! Durable tile storage: SQLite cache and MBTiles packs.
//!
//! The cache is safe to use from several threads: every operation takes the
//! connection mutex. Callers running inside an async runtime should wrap
//! blocking calls in `spawn_blocking`.

pub mod cache;
pub mod error;
pub mod jobs;
pub mod manifest;
pub mod mbtiles;
pub mod pack;
pub mod pmtiles_pack;

pub use cache::{
    CacheStats, CachedTile, IntegrityReport, ProviderCacheStats, SqliteCache, Tile, TileKey,
    now_unix,
};
pub use error::{StorageError, StorageResult};
pub use jobs::{DownloadJob, DownloadStore, JobStatus, NewJob};
pub use manifest::{PackManifest, verify_manifest, write_manifest};
pub use mbtiles::{Mbtiles, MbtilesMetadata, MbtilesWriter};
pub use pack::{
    ExportPhase, ExportProgress, ExportReport, ExportSpec, export_region, pack_file_name,
};
pub use pmtiles_pack::{PmtilesPack, PmtilesPackInfo, export_region_pmtiles};
