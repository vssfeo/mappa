//! SQLite tile cache with WAL, metadata, hit counters and LRU eviction.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mappa_core::TileRange;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::error::{StorageError, StorageResult};

const SCHEMA_VERSION: i64 = 1;
const EVICTION_BATCH: usize = 256;
/// Hits/misses buffered before touching SQLite.
const COUNTER_FLUSH: u64 = 64;
/// LRU timestamps are refreshed at most this often per tile.
const TOUCH_INTERVAL_SECS: i64 = 300;

/// Current Unix time in seconds.
pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// Cache address of one tile.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct TileKey {
    /// Provider id from the catalog.
    pub provider_id: String,
    /// Zoom level.
    pub z: u8,
    /// Tile column.
    pub x: u32,
    /// Tile row, XYZ scheme.
    pub y: u32,
    /// Tile image format (`png`, `jpg`, `webp`).
    pub format: String,
    /// Layer parameters that make two requests distinct.
    pub variant: String,
}

impl TileKey {
    /// Builds a key with an empty variant.
    pub fn new(
        provider_id: impl Into<String>,
        z: u8,
        x: u32,
        y: u32,
        format: impl Into<String>,
    ) -> Self {
        Self {
            provider_id: provider_id.into(),
            z,
            x,
            y,
            format: format.into(),
            variant: String::new(),
        }
    }

    /// Returns a key with the given layer variant.
    pub fn with_variant(mut self, variant: impl Into<String>) -> Self {
        self.variant = variant.into();
        self
    }

    /// Short human-readable form used in logs.
    pub fn label(&self) -> String {
        format!(
            "{}/{}/{}/{}.{}",
            self.provider_id, self.z, self.x, self.y, self.format
        )
    }
}

/// A tile and its HTTP metadata.
#[derive(Debug, Clone)]
pub struct Tile {
    /// Cache address.
    pub key: TileKey,
    /// Encoded image bytes.
    pub data: Vec<u8>,
    /// `ETag` response header.
    pub etag: Option<String>,
    /// `Last-Modified` response header.
    pub last_modified: Option<String>,
    /// `Content-Type` response header.
    pub content_type: Option<String>,
    /// When the tile was fetched, Unix seconds.
    pub fetched_at: i64,
    /// When the tile should be refreshed, Unix seconds.
    pub expires_at: Option<i64>,
    /// When the tile was last served, Unix seconds.
    pub last_used: i64,
    /// BLAKE3 hash of `data`.
    pub hash: String,
}

/// Alias kept for call sites that care about cache semantics.
pub type CachedTile = Tile;

impl Tile {
    /// Creates a tile with the current timestamp and a content hash.
    pub fn new(key: TileKey, data: Vec<u8>) -> Self {
        let now = now_unix();
        let hash = blake3::hash(&data).to_hex().to_string();
        Self {
            key,
            data,
            etag: None,
            last_modified: None,
            content_type: None,
            fetched_at: now,
            expires_at: None,
            last_used: now,
            hash,
        }
    }

    /// Returns `true` when `expires_at` is in the past.
    pub fn is_expired(&self, at: i64) -> bool {
        self.expires_at.is_some_and(|expires| expires <= at)
    }

    /// Encoded size in bytes.
    pub fn len(&self) -> usize {
        self.data.len()
    }

    /// Returns `true` for an empty tile.
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }
}

/// Result of a cache integrity scan.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    /// Tiles whose bytes and hash were inspected.
    pub checked: u64,
    /// Tiles with a hash mismatch, empty blob or unknown image signature.
    pub corrupt: u64,
    /// Tiles deleted by a repair run.
    pub removed: u64,
    /// Bytes reclaimed by a repair run.
    pub bytes: u64,
    /// First few damaged keys, for diagnostics.
    pub examples: Vec<String>,
}

/// Aggregate cache counters.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct CacheStats {
    /// Stored tiles.
    pub tiles: u64,
    /// Stored encoded bytes.
    pub bytes: u64,
    /// Successful reads.
    pub hits: u64,
    /// Reads that found nothing.
    pub misses: u64,
}

impl CacheStats {
    /// Hit ratio in `0.0..=1.0`.
    pub fn hit_ratio(&self) -> f64 {
        let total = self.hits + self.misses;
        if total == 0 {
            0.0
        } else {
            self.hits as f64 / total as f64
        }
    }
}

/// Per-provider cache usage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderCacheStats {
    /// Provider id.
    pub provider_id: String,
    /// Stored tiles.
    pub tiles: u64,
    /// Stored encoded bytes.
    pub bytes: u64,
}

/// Thread-safe SQLite tile cache.
#[derive(Debug)]
pub struct SqliteCache {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
    /// Hit/miss counters buffered in memory to keep reads off the write path.
    hits_pending: AtomicU64,
    misses_pending: AtomicU64,
}

impl SqliteCache {
    /// Opens or creates a cache at `path`, enabling WAL.
    pub fn open(path: impl AsRef<Path>) -> StorageResult<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&path)?;
        Self::configure(&conn, true)?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: Some(path),
            hits_pending: AtomicU64::new(0),
            misses_pending: AtomicU64::new(0),
        })
    }

    /// Opens a transient cache, primarily for tests.
    pub fn open_in_memory() -> StorageResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::configure(&conn, false)?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: None,
            hits_pending: AtomicU64::new(0),
            misses_pending: AtomicU64::new(0),
        })
    }

    /// Filesystem path of the database, if it is not in-memory.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    fn configure(conn: &Connection, wal: bool) -> StorageResult<()> {
        conn.busy_timeout(Duration::from_secs(5))?;
        if wal {
            let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
            if !mode.eq_ignore_ascii_case("wal") {
                return Err(StorageError::Pragma(format!(
                    "journal_mode is {mode}, expected wal"
                )));
            }
        }
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "temp_store", "MEMORY")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // Keep the hot B-tree pages in SQLite and map the rest; random tile
        // reads are the common case while panning.
        conn.pragma_update(None, "cache_size", -32_768_i64)?;
        if wal {
            conn.pragma_update(None, "mmap_size", 134_217_728_i64)?;
        }
        Ok(())
    }

    fn migrate(conn: &Connection) -> StorageResult<()> {
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version == 0 {
            conn.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS tiles (
                   id            INTEGER PRIMARY KEY,
                   provider_id   TEXT NOT NULL,
                   z             INTEGER NOT NULL,
                   x             INTEGER NOT NULL,
                   y             INTEGER NOT NULL,
                   format        TEXT NOT NULL,
                   variant       TEXT NOT NULL DEFAULT '',
                   etag          TEXT,
                   last_modified TEXT,
                   content_type  TEXT,
                   fetched_at    INTEGER NOT NULL,
                   expires_at    INTEGER,
                   last_used     INTEGER NOT NULL,
                   data          BLOB NOT NULL,
                   hash          TEXT NOT NULL,
                   UNIQUE(provider_id, z, x, y, format, variant)
                 );
                 CREATE INDEX IF NOT EXISTS tiles_last_used ON tiles(last_used);
                 CREATE INDEX IF NOT EXISTS tiles_provider ON tiles(provider_id);
                 CREATE INDEX IF NOT EXISTS tiles_expires
                   ON tiles(expires_at) WHERE expires_at IS NOT NULL;
                 CREATE TABLE IF NOT EXISTS cache_totals (
                   id     INTEGER PRIMARY KEY CHECK (id = 1),
                   tiles  INTEGER NOT NULL DEFAULT 0,
                   bytes  INTEGER NOT NULL DEFAULT 0,
                   hits   INTEGER NOT NULL DEFAULT 0,
                   misses INTEGER NOT NULL DEFAULT 0
                 );
                 INSERT OR IGNORE INTO cache_totals(id) VALUES (1);
                 PRAGMA user_version = 1;
                 COMMIT;",
            )?;
        } else if version > SCHEMA_VERSION {
            return Err(StorageError::UnsupportedSchema(version));
        }
        Ok(())
    }

    /// Checks every cached blob against its stored BLAKE3 hash and image
    /// signature. With `repair`, damaged rows are deleted and the byte
    /// counters are corrected so the next view simply re-downloads them.
    pub fn verify_integrity(
        &self,
        repair: bool,
        provider: Option<&str>,
    ) -> StorageResult<IntegrityReport> {
        let conn = self.conn.lock().expect("cache mutex poisoned");
        let mut report = IntegrityReport::default();
        let mut damaged: Vec<(i64, u64)> = Vec::new();
        {
            let sql = if provider.is_some() {
                "SELECT id, provider_id, z, x, y, format, hash, data FROM tiles
                 WHERE provider_id = ?1"
            } else {
                "SELECT id, provider_id, z, x, y, format, hash, data FROM tiles"
            };
            let mut statement = conn.prepare(sql)?;
            let mut rows = if let Some(provider) = provider {
                statement.query([provider])?
            } else {
                statement.query([])?
            };
            while let Some(row) = rows.next()? {
                report.checked += 1;
                let id: i64 = row.get(0)?;
                let provider_id: String = row.get(1)?;
                let z: i64 = row.get(2)?;
                let x: i64 = row.get(3)?;
                let y: i64 = row.get(4)?;
                let format: String = row.get(5)?;
                let hash: String = row.get(6)?;
                let data: Vec<u8> = row.get(7)?;
                let actual = blake3::hash(&data).to_hex().to_string();
                let intact = actual == hash && image_signature_ok(&data, &format);
                if !intact {
                    report.corrupt += 1;
                    let label = format!("{provider_id}/{z}/{x}/{y}.{format}");
                    if report.examples.len() < 8 {
                        report.examples.push(label);
                    }
                    damaged.push((id, u64::try_from(data.len()).unwrap_or(0)));
                }
            }
        }
        if repair && !damaged.is_empty() {
            let mut conn = conn;
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let mut removed_bytes = 0_u64;
            for (id, bytes) in &damaged {
                tx.execute("DELETE FROM tiles WHERE id = ?1", [id])?;
                removed_bytes = removed_bytes.saturating_add(*bytes);
            }
            tx.execute(
                "UPDATE cache_totals
                 SET tiles = max(0, tiles - ?1), bytes = max(0, bytes - ?2)
                 WHERE id = 1",
                params![
                    i64::try_from(damaged.len()).unwrap_or(i64::MAX),
                    i64::try_from(removed_bytes).unwrap_or(i64::MAX)
                ],
            )?;
            tx.commit()?;
            report.removed = damaged.len() as u64;
            report.bytes = removed_bytes;
        }
        Ok(report)
    }

    /// Stores or replaces a tile and updates size counters atomically.
    pub fn put(&self, tile: &Tile) -> StorageResult<()> {
        let mut conn = self.conn.lock().expect("cache mutex poisoned");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let old_len: Option<i64> = {
            let mut stmt = tx.prepare_cached(
                "SELECT length(data) FROM tiles
                 WHERE provider_id = ?1 AND z = ?2 AND x = ?3 AND y = ?4
                   AND format = ?5 AND variant = ?6",
            )?;
            stmt.query_row(
                params![
                    tile.key.provider_id,
                    i64::from(tile.key.z),
                    i64::from(tile.key.x),
                    i64::from(tile.key.y),
                    tile.key.format,
                    tile.key.variant
                ],
                |row| row.get(0),
            )
            .optional()?
        };
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO tiles
                   (provider_id, z, x, y, format, variant, etag, last_modified,
                    content_type, fetched_at, expires_at, last_used, data, hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(provider_id, z, x, y, format, variant) DO UPDATE SET
                   etag = excluded.etag,
                   last_modified = excluded.last_modified,
                   content_type = excluded.content_type,
                   fetched_at = excluded.fetched_at,
                   expires_at = excluded.expires_at,
                   last_used = excluded.last_used,
                   data = excluded.data,
                   hash = excluded.hash",
            )?;
            stmt.execute(params![
                tile.key.provider_id,
                i64::from(tile.key.z),
                i64::from(tile.key.x),
                i64::from(tile.key.y),
                tile.key.format,
                tile.key.variant,
                tile.etag,
                tile.last_modified,
                tile.content_type,
                tile.fetched_at,
                tile.expires_at,
                tile.last_used,
                tile.data,
                tile.hash
            ])?;
        }
        let tile_delta = i64::from(old_len.is_none());
        let byte_delta = tile.data.len() as i64 - old_len.unwrap_or(0);
        {
            let mut stmt = tx.prepare_cached(
                "UPDATE cache_totals SET tiles = tiles + ?1, bytes = bytes + ?2 WHERE id = 1",
            )?;
            stmt.execute(params![tile_delta, byte_delta])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Reads a tile and refreshes its LRU timestamp when it has gone cold.
    ///
    /// Panning hits the same tiles repeatedly, so both the `last_used` write
    /// and the statistics counters are batched instead of doing two SQL
    /// statements per decoded tile.
    pub fn get(&self, key: &TileKey) -> StorageResult<Option<Tile>> {
        let conn = self.conn.lock().expect("cache mutex poisoned");
        let tile = Self::select_tile(&conn, key)?;
        match &tile {
            Some(tile) => {
                let now = now_unix();
                if now.saturating_sub(tile.last_used) >= TOUCH_INTERVAL_SECS {
                    let mut stmt = conn.prepare_cached(
                        "UPDATE tiles SET last_used = ?1
                         WHERE provider_id = ?2 AND z = ?3 AND x = ?4 AND y = ?5
                           AND format = ?6 AND variant = ?7",
                    )?;
                    stmt.execute(params![
                        now,
                        key.provider_id,
                        i64::from(key.z),
                        i64::from(key.x),
                        i64::from(key.y),
                        key.format,
                        key.variant
                    ])?;
                }
                if self.hits_pending.fetch_add(1, Ordering::Relaxed) + 1 >= COUNTER_FLUSH {
                    self.flush_counters(&conn)?;
                }
            }
            None => {
                if self.misses_pending.fetch_add(1, Ordering::Relaxed) + 1 >= COUNTER_FLUSH {
                    self.flush_counters(&conn)?;
                }
            }
        }
        Ok(tile)
    }

    /// Writes buffered hit/miss counters in one statement.
    fn flush_counters(&self, conn: &Connection) -> StorageResult<()> {
        let hits = self.hits_pending.swap(0, Ordering::Relaxed);
        let misses = self.misses_pending.swap(0, Ordering::Relaxed);
        if hits > 0 || misses > 0 {
            conn.execute(
                "UPDATE cache_totals SET hits = hits + ?1, misses = misses + ?2 WHERE id = 1",
                params![
                    i64::try_from(hits).unwrap_or(i64::MAX),
                    i64::try_from(misses).unwrap_or(i64::MAX)
                ],
            )?;
        }
        Ok(())
    }

    /// Reads a tile without touching counters or `last_used`.
    pub fn peek(&self, key: &TileKey) -> StorageResult<Option<Tile>> {
        let conn = self.conn.lock().expect("cache mutex poisoned");
        Self::select_tile(&conn, key)
    }

    /// Reads a tile only when it has not expired at `at`.
    pub fn get_fresh(&self, key: &TileKey, at: i64) -> StorageResult<Option<Tile>> {
        Ok(self.get(key)?.filter(|tile| !tile.is_expired(at)))
    }

    /// Returns `true` when the key exists, regardless of TTL.
    pub fn contains(&self, key: &TileKey) -> StorageResult<bool> {
        let conn = self.conn.lock().expect("cache mutex poisoned");
        let mut stmt = conn.prepare_cached(
            "SELECT EXISTS(
               SELECT 1 FROM tiles
               WHERE provider_id = ?1 AND z = ?2 AND x = ?3 AND y = ?4
                 AND format = ?5 AND variant = ?6)",
        )?;
        let exists: i64 = stmt.query_row(
            params![
                key.provider_id,
                i64::from(key.z),
                i64::from(key.x),
                i64::from(key.y),
                key.format,
                key.variant
            ],
            |row| row.get(0),
        )?;
        Ok(exists != 0)
    }

    /// Lists cached tile coordinates inside a range.
    ///
    /// Returns `(coords, truncated)`. The result is capped so a large viewport
    /// cannot flood the WebView with geometry.
    pub fn coverage(
        &self,
        provider_id: &str,
        z: u8,
        range: &TileRange,
        limit: usize,
    ) -> StorageResult<(Vec<(u32, u32)>, bool)> {
        let conn = self.conn.lock().expect("cache mutex poisoned");
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT x, y FROM tiles
             WHERE provider_id = ?1 AND z = ?2
               AND x BETWEEN ?3 AND ?4 AND y BETWEEN ?5 AND ?6
             ORDER BY x, y
             LIMIT ?7",
        )?;
        let rows = stmt.query_map(
            params![
                provider_id,
                i64::from(z),
                i64::from(range.min_x()),
                i64::from(range.max_x()),
                i64::from(range.min_y()),
                i64::from(range.max_y()),
                i64::try_from(limit.saturating_add(1)).unwrap_or(i64::MAX),
            ],
            |row| Ok((row.get::<_, i64>(0)? as u32, row.get::<_, i64>(1)? as u32)),
        )?;
        let mut coords = Vec::new();
        for row in rows {
            coords.push(row?);
        }
        let truncated = coords.len() > limit;
        coords.truncate(limit);
        Ok((coords, truncated))
    }

    /// Removes one tile, returning whether it existed.
    pub fn remove(&self, key: &TileKey) -> StorageResult<bool> {
        let mut conn = self.conn.lock().expect("cache mutex poisoned");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let len: Option<i64> = tx
            .query_row(
                "SELECT length(data) FROM tiles
                 WHERE provider_id = ?1 AND z = ?2 AND x = ?3 AND y = ?4
                   AND format = ?5 AND variant = ?6",
                params![
                    key.provider_id,
                    i64::from(key.z),
                    i64::from(key.x),
                    i64::from(key.y),
                    key.format,
                    key.variant
                ],
                |row| row.get(0),
            )
            .optional()?;
        let Some(len) = len else {
            return Ok(false);
        };
        tx.execute(
            "DELETE FROM tiles
             WHERE provider_id = ?1 AND z = ?2 AND x = ?3 AND y = ?4
               AND format = ?5 AND variant = ?6",
            params![
                key.provider_id,
                i64::from(key.z),
                i64::from(key.x),
                i64::from(key.y),
                key.format,
                key.variant
            ],
        )?;
        tx.execute(
            "UPDATE cache_totals SET tiles = tiles - 1, bytes = bytes - ?1 WHERE id = 1",
            [len],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Deletes every tile of one provider.
    pub fn clear_provider(&self, provider_id: &str) -> StorageResult<u64> {
        let mut conn = self.conn.lock().expect("cache mutex poisoned");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let (count, bytes): (i64, i64) = tx.query_row(
            "SELECT count(*), coalesce(sum(length(data)), 0) FROM tiles WHERE provider_id = ?1",
            [provider_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        tx.execute("DELETE FROM tiles WHERE provider_id = ?1", [provider_id])?;
        tx.execute(
            "UPDATE cache_totals SET tiles = tiles - ?1, bytes = bytes - ?2 WHERE id = 1",
            params![count, bytes],
        )?;
        tx.commit()?;
        Ok(u64::try_from(count).unwrap_or(0))
    }

    /// Removes all tiles. Lifetime hit/miss counters are preserved.
    pub fn clear(&self) -> StorageResult<u64> {
        let mut conn = self.conn.lock().expect("cache mutex poisoned");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let count: i64 = tx.query_row("SELECT count(*) FROM tiles", [], |row| row.get(0))?;
        tx.execute("DELETE FROM tiles", [])?;
        tx.execute(
            "UPDATE cache_totals SET tiles = 0, bytes = 0 WHERE id = 1",
            [],
        )?;
        tx.commit()?;
        Ok(u64::try_from(count).unwrap_or(0))
    }

    /// Aggregate counters.
    pub fn stats(&self) -> StorageResult<CacheStats> {
        let conn = self.conn.lock().expect("cache mutex poisoned");
        self.flush_counters(&conn)?;
        let stats = conn.query_row(
            "SELECT tiles, bytes, hits, misses FROM cache_totals WHERE id = 1",
            [],
            |row| {
                Ok(CacheStats {
                    tiles: u64::try_from(row.get::<_, i64>(0)?).unwrap_or(0),
                    bytes: u64::try_from(row.get::<_, i64>(1)?).unwrap_or(0),
                    hits: u64::try_from(row.get::<_, i64>(2)?).unwrap_or(0),
                    misses: u64::try_from(row.get::<_, i64>(3)?).unwrap_or(0),
                })
            },
        )?;
        Ok(stats)
    }

    /// Cache usage grouped by provider.
    pub fn provider_stats(&self) -> StorageResult<Vec<ProviderCacheStats>> {
        let conn = self.conn.lock().expect("cache mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT provider_id, count(*), coalesce(sum(length(data)), 0)
             FROM tiles GROUP BY provider_id ORDER BY 3 DESC, 1 ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ProviderCacheStats {
                provider_id: row.get(0)?,
                tiles: u64::try_from(row.get::<_, i64>(1)?).unwrap_or(0),
                bytes: u64::try_from(row.get::<_, i64>(2)?).unwrap_or(0),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Visits every cached tile of one provider in key order.
    ///
    /// The cache lock is held for the whole scan, so the visitor must not call
    /// back into this cache.
    pub fn for_each_provider_tile<F>(&self, provider_id: &str, mut visit: F) -> StorageResult<u64>
    where
        F: FnMut(&Tile) -> StorageResult<()>,
    {
        let conn = self.conn.lock().expect("cache mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT z, x, y, format, variant, etag, last_modified, content_type,
                    fetched_at, expires_at, last_used, data, hash
             FROM tiles WHERE provider_id = ?1
             ORDER BY z, x, y, format, variant",
        )?;
        let mut rows = stmt.query([provider_id])?;
        let mut count = 0_u64;
        while let Some(row) = rows.next()? {
            let z = u8::try_from(row.get::<_, i64>(0)?)
                .map_err(|_| StorageError::ValueOutOfRange("z"))?;
            let x = u32::try_from(row.get::<_, i64>(1)?)
                .map_err(|_| StorageError::ValueOutOfRange("x"))?;
            let y = u32::try_from(row.get::<_, i64>(2)?)
                .map_err(|_| StorageError::ValueOutOfRange("y"))?;
            let tile = Tile {
                key: TileKey {
                    provider_id: provider_id.to_owned(),
                    z,
                    x,
                    y,
                    format: row.get(3)?,
                    variant: row.get(4)?,
                },
                data: row.get(11)?,
                etag: row.get(5)?,
                last_modified: row.get(6)?,
                content_type: row.get(7)?,
                fetched_at: row.get(8)?,
                expires_at: row.get(9)?,
                last_used: row.get(10)?,
                hash: row.get(12)?,
            };
            visit(&tile)?;
            count += 1;
        }
        Ok(count)
    }

    /// Evicts least recently used tiles until the cache fits `max_bytes`.
    ///
    /// Eviction aims for 95% of the limit to avoid deleting one tile at a
    /// time. Returns the number of removed tiles.
    pub fn enforce_limit(&self, max_bytes: u64) -> StorageResult<u64> {
        let mut conn = self.conn.lock().expect("cache mutex poisoned");
        let total: i64 =
            conn.query_row("SELECT bytes FROM cache_totals WHERE id = 1", [], |row| {
                row.get(0)
            })?;
        let total = u64::try_from(total).unwrap_or(0);
        if total <= max_bytes {
            return Ok(0);
        }
        let target = max_bytes.saturating_mul(95) / 100;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut removed_tiles = 0_u64;
        let mut removed_bytes = 0_u64;
        loop {
            if total.saturating_sub(removed_bytes) <= target {
                break;
            }
            let batch: Vec<(i64, i64)> = {
                let mut stmt = tx.prepare(
                    "SELECT id, length(data) FROM tiles ORDER BY last_used ASC, id ASC LIMIT ?1",
                )?;
                let rows = stmt.query_map([EVICTION_BATCH as i64], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            if batch.is_empty() {
                break;
            }
            for (id, len) in batch {
                if total.saturating_sub(removed_bytes) <= target {
                    break;
                }
                tx.execute("DELETE FROM tiles WHERE id = ?1", [id])?;
                removed_tiles += 1;
                removed_bytes += u64::try_from(len).unwrap_or(0);
            }
        }
        if removed_tiles > 0 {
            tx.execute(
                "UPDATE cache_totals
                 SET tiles = tiles - ?1, bytes = max(0, bytes - ?2)
                 WHERE id = 1",
                params![
                    i64::try_from(removed_tiles).unwrap_or(i64::MAX),
                    i64::try_from(removed_bytes).unwrap_or(i64::MAX)
                ],
            )?;
        }
        tx.commit()?;
        Ok(removed_tiles)
    }

    /// Deletes tiles whose TTL ended at or before `at`.
    pub fn clear_expired(&self, at: i64) -> StorageResult<u64> {
        let mut conn = self.conn.lock().expect("cache mutex poisoned");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let (count, bytes): (i64, i64) = tx.query_row(
            "SELECT count(*), coalesce(sum(length(data)), 0)
             FROM tiles WHERE expires_at IS NOT NULL AND expires_at <= ?1",
            [at],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        tx.execute(
            "DELETE FROM tiles WHERE expires_at IS NOT NULL AND expires_at <= ?1",
            [at],
        )?;
        tx.execute(
            "UPDATE cache_totals SET tiles = tiles - ?1, bytes = max(0, bytes - ?2) WHERE id = 1",
            params![count, bytes],
        )?;
        tx.commit()?;
        Ok(u64::try_from(count).unwrap_or(0))
    }

    /// Recomputes size counters from the tile table.
    pub fn recount(&self) -> StorageResult<CacheStats> {
        let conn = self.conn.lock().expect("cache mutex poisoned");
        let (count, bytes): (i64, i64) = conn.query_row(
            "SELECT count(*), coalesce(sum(length(data)), 0) FROM tiles",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        conn.execute(
            "UPDATE cache_totals SET tiles = ?1, bytes = ?2 WHERE id = 1",
            params![count, bytes],
        )?;
        self.flush_counters(&conn)?;
        self.stats_locked(&conn)
    }

    /// Runs `PRAGMA quick_check` and returns the SQLite verdict.
    pub fn quick_check(&self) -> StorageResult<String> {
        let conn = self.conn.lock().expect("cache mutex poisoned");
        let verdict: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        Ok(verdict)
    }

    /// Compacts the database file.
    pub fn vacuum(&self) -> StorageResult<()> {
        let conn = self.conn.lock().expect("cache mutex poisoned");
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")?;
        Ok(())
    }

    fn stats_locked(&self, conn: &Connection) -> StorageResult<CacheStats> {
        let stats = conn.query_row(
            "SELECT tiles, bytes, hits, misses FROM cache_totals WHERE id = 1",
            [],
            |row| {
                Ok(CacheStats {
                    tiles: u64::try_from(row.get::<_, i64>(0)?).unwrap_or(0),
                    bytes: u64::try_from(row.get::<_, i64>(1)?).unwrap_or(0),
                    hits: u64::try_from(row.get::<_, i64>(2)?).unwrap_or(0),
                    misses: u64::try_from(row.get::<_, i64>(3)?).unwrap_or(0),
                })
            },
        )?;
        Ok(stats)
    }

    fn select_tile(conn: &Connection, key: &TileKey) -> StorageResult<Option<Tile>> {
        let mut stmt = conn.prepare_cached(
            "SELECT etag, last_modified, content_type, fetched_at, expires_at,
                    last_used, data, hash, format, variant
             FROM tiles
             WHERE provider_id = ?1 AND z = ?2 AND x = ?3 AND y = ?4
               AND format = ?5 AND variant = ?6",
        )?;
        let tile = stmt
            .query_row(
                params![
                    key.provider_id,
                    i64::from(key.z),
                    i64::from(key.x),
                    i64::from(key.y),
                    key.format,
                    key.variant
                ],
                |row| {
                    Ok(Tile {
                        key: TileKey {
                            provider_id: key.provider_id.clone(),
                            z: key.z,
                            x: key.x,
                            y: key.y,
                            format: row.get(8)?,
                            variant: row.get(9)?,
                        },
                        data: row.get(6)?,
                        etag: row.get(0)?,
                        last_modified: row.get(1)?,
                        content_type: row.get(2)?,
                        fetched_at: row.get(3)?,
                        expires_at: row.get(4)?,
                        last_used: row.get(5)?,
                        hash: row.get(7)?,
                    })
                },
            )
            .optional()?;
        Ok(tile)
    }
}

/// True when the blob starts with a raster signature Mappa can render.
fn image_signature_ok(data: &[u8], _format: &str) -> bool {
    if data.len() < 12 {
        return false;
    }
    if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return true;
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return true;
    }
    if data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        return true;
    }
    if &data[4..8] == b"ftyp" {
        let brand = &data[8..12];
        return brand == b"avif" || brand == b"avis";
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    fn key(x: u32) -> TileKey {
        TileKey::new("test", 5, x, 10, "png")
    }

    fn tile(x: u32, data: &[u8]) -> Tile {
        Tile::new(key(x), data.to_vec())
    }

    #[test]
    fn stores_and_reads_tile() {
        let cache = SqliteCache::open_in_memory().unwrap();
        let mut tile = tile(1, b"png-data");
        tile.etag = Some("\"abc\"".into());
        tile.content_type = Some("image/png".into());
        tile.expires_at = Some(now_unix() + 3600);
        cache.put(&tile).unwrap();

        let read = cache.get(&key(1)).unwrap().unwrap();
        assert_eq!(read.data, b"png-data");
        assert_eq!(read.etag.as_deref(), Some("\"abc\""));
        assert!(!read.is_expired(now_unix()));
        assert_eq!(cache.stats().unwrap().hits, 1);
    }

    #[test]
    fn integrity_scan_finds_and_repairs_broken_tiles() {
        let cache = SqliteCache::open_in_memory().unwrap();
        let png = [
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        cache.put(&tile(1, &png)).unwrap();
        cache.put(&tile(2, b"<html>not an image</html>")).unwrap();
        let report = cache.verify_integrity(false, None).unwrap();
        assert_eq!(report.checked, 2);
        assert_eq!(report.corrupt, 1);
        assert_eq!(report.examples.len(), 1);
        assert_eq!(report.removed, 0);
        let repaired = cache.verify_integrity(true, None).unwrap();
        assert_eq!(repaired.removed, 1);
        assert!(repaired.bytes > 0);
        assert!(cache.get(&key(1)).unwrap().is_some());
        assert!(cache.get(&key(2)).unwrap().is_none());
        assert_eq!(cache.stats().unwrap().tiles, 1);
    }

    #[test]
    fn coverage_lists_matching_tiles_and_truncates() {
        let cache = SqliteCache::open_in_memory().unwrap();
        let bbox = mappa_core::Bbox::new(0.0, 0.0, 90.0, 90.0).unwrap();
        let range = TileRange::new(&bbox, 5).unwrap();
        let y = range.min_y();
        for x in range.min_x()..range.min_x() + 4 {
            cache
                .put(&Tile::new(
                    TileKey::new("test", 5, x, y, "png"),
                    b"tile".to_vec(),
                ))
                .unwrap();
        }
        let (coords, truncated) = cache.coverage("test", 5, &range, 10).unwrap();
        let expected = (range.min_x()..range.min_x() + 4)
            .map(|x| (x, y))
            .collect::<Vec<_>>();
        assert_eq!(coords, expected);
        assert!(!truncated);

        let (coords, truncated) = cache.coverage("test", 5, &range, 2).unwrap();
        assert_eq!(coords, expected[..2].to_vec());
        assert!(truncated);
        assert!(cache.coverage("other", 5, &range, 2).unwrap().0.is_empty());
    }

    #[test]
    fn contains_reports_presence_without_reading_data() {
        let cache = SqliteCache::open_in_memory().unwrap();
        assert!(!cache.contains(&key(3)).unwrap());
        cache.put(&tile(3, b"present")).unwrap();
        assert!(cache.contains(&key(3)).unwrap());
        assert_eq!(cache.stats().unwrap().hits, 0);
        assert_eq!(cache.stats().unwrap().misses, 0);
    }

    #[test]
    fn miss_increments_counter() {
        let cache = SqliteCache::open_in_memory().unwrap();
        assert!(cache.get(&key(7)).unwrap().is_none());
        let stats = cache.stats().unwrap();
        assert_eq!(stats.misses, 1);
        assert_eq!(stats.hits, 0);
    }

    #[test]
    fn replacing_tile_updates_size_not_count() {
        let cache = SqliteCache::open_in_memory().unwrap();
        cache.put(&tile(1, b"short")).unwrap();
        cache.put(&tile(1, b"a much longer payload")).unwrap();
        let stats = cache.stats().unwrap();
        assert_eq!(stats.tiles, 1);
        assert_eq!(stats.bytes, "a much longer payload".len() as u64);
        assert_eq!(cache.get(&key(1)).unwrap().unwrap().data.len(), 21);
    }

    #[test]
    fn evicts_least_recently_used() {
        let cache = SqliteCache::open_in_memory().unwrap();
        for x in 0..5 {
            let mut tile = tile(x, &[x as u8; 100]);
            tile.last_used = 100 + i64::from(x);
            cache.put(&tile).unwrap();
        }
        let removed = cache.enforce_limit(250).unwrap();
        assert_eq!(removed, 3);
        assert!(cache.peek(&key(0)).unwrap().is_none());
        assert!(cache.peek(&key(4)).unwrap().is_some());
        let stats = cache.stats().unwrap();
        assert_eq!(stats.tiles, 2);
        assert_eq!(stats.bytes, 200);
    }

    #[test]
    fn clear_provider_keeps_other_providers() {
        let cache = SqliteCache::open_in_memory().unwrap();
        cache.put(&tile(1, b"a")).unwrap();
        cache
            .put(&Tile::new(
                TileKey::new("other", 5, 1, 10, "png"),
                b"b".to_vec(),
            ))
            .unwrap();
        assert_eq!(cache.clear_provider("test").unwrap(), 1);
        assert_eq!(cache.stats().unwrap().tiles, 1);
        assert!(cache.peek(&key(1)).unwrap().is_none());
    }

    #[test]
    fn remove_updates_totals() {
        let cache = SqliteCache::open_in_memory().unwrap();
        cache.put(&tile(1, b"abc")).unwrap();
        assert!(cache.remove(&key(1)).unwrap());
        assert!(!cache.remove(&key(1)).unwrap());
        assert_eq!(cache.stats().unwrap().tiles, 0);
        assert_eq!(cache.stats().unwrap().bytes, 0);
    }

    #[test]
    fn expires_and_prunes() {
        let cache = SqliteCache::open_in_memory().unwrap();
        let mut tile = tile(1, b"abc");
        tile.expires_at = Some(50);
        cache.put(&tile).unwrap();
        assert!(cache.get_fresh(&key(1), 60).unwrap().is_none());
        assert_eq!(cache.clear_expired(60).unwrap(), 1);
    }

    #[test]
    fn persists_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite");
        {
            let cache = SqliteCache::open(&path).unwrap();
            cache.put(&tile(3, b"persistent")).unwrap();
        }
        let cache = SqliteCache::open(&path).unwrap();
        assert_eq!(cache.get(&key(3)).unwrap().unwrap().data, b"persistent");
        let mode: String = cache
            .conn
            .lock()
            .unwrap()
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
    }

    #[test]
    fn survives_concurrent_writers() {
        let cache = Arc::new(SqliteCache::open_in_memory().unwrap());
        let mut handles = Vec::new();
        for thread_index in 0..4 {
            let cache = Arc::clone(&cache);
            handles.push(thread::spawn(move || {
                for item in 0..100 {
                    let x = thread_index * 100 + item;
                    cache
                        .put(&Tile::new(key(x), vec![thread_index as u8; 64]))
                        .unwrap();
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        let stats = cache.stats().unwrap();
        assert_eq!(stats.tiles, 400);
        assert_eq!(stats.bytes, 400 * 64);
        assert_eq!(cache.quick_check().unwrap(), "ok");
    }

    #[test]
    fn recount_repairs_totals() {
        let cache = SqliteCache::open_in_memory().unwrap();
        cache.put(&tile(1, b"abc")).unwrap();
        cache
            .conn
            .lock()
            .unwrap()
            .execute("UPDATE cache_totals SET bytes = 9999", [])
            .unwrap();
        let stats = cache.recount().unwrap();
        assert_eq!(stats.bytes, 3);
        assert_eq!(stats.tiles, 1);
    }

    #[test]
    fn variant_separates_layers() {
        let cache = SqliteCache::open_in_memory().unwrap();
        let base = key(1);
        let variant = base.clone().with_variant("satellite");
        cache
            .put(&Tile::new(base.clone(), b"base".to_vec()))
            .unwrap();
        cache
            .put(&Tile::new(variant.clone(), b"sat".to_vec()))
            .unwrap();
        assert_eq!(cache.get(&base).unwrap().unwrap().data, b"base");
        assert_eq!(cache.get(&variant).unwrap().unwrap().data, b"sat");
        assert_eq!(cache.stats().unwrap().tiles, 2);
    }

    #[test]
    fn hit_ratio_handles_empty_cache() {
        assert_eq!(CacheStats::default().hit_ratio(), 0.0);
        assert_eq!(
            CacheStats {
                hits: 1,
                misses: 3,
                ..CacheStats::default()
            }
            .hit_ratio(),
            0.25
        );
    }
}
