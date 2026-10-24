//! Persistent download queue.
//!
//! Jobs store only the requested region and counters; tile rows live in the
//! cache. Resuming a job therefore means re-walking the range and skipping
//! tiles that are already cached, which is fast and avoids a second index.

use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use mappa_core::{Bbox, TileRange, normalize_ring, ring_bounds, tile_intersects_ring_with_bounds};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::error::{StorageError, StorageResult};

static JOB_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Lifecycle of a download job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    /// Waiting for a worker.
    Queued,
    /// Actively downloading.
    Running,
    /// Stopped by the user, resumable.
    Paused,
    /// All tiles were processed (some may have failed).
    Completed,
    /// Stopped by the user and not resumable.
    Cancelled,
    /// Fatal error.
    Failed,
}

impl JobStatus {
    /// Stable database representation.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }

    /// Terminal states cannot be resumed.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }
}

impl FromStr for JobStatus {
    type Err = StorageError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "paused" => Ok(Self::Paused),
            "completed" => Ok(Self::Completed),
            "cancelled" => Ok(Self::Cancelled),
            "failed" => Ok(Self::Failed),
            other => Err(StorageError::InvalidJob(format!(
                "unknown job status {other:?}"
            ))),
        }
    }
}

/// Input for a new download job.
#[derive(Debug, Clone)]
pub struct NewJob {
    /// Display name.
    pub name: String,
    /// Provider id.
    pub provider_id: String,
    /// West bound.
    pub west: f64,
    /// South bound.
    pub south: f64,
    /// East bound.
    pub east: f64,
    /// North bound.
    pub north: f64,
    /// First zoom.
    pub min_zoom: u8,
    /// Last zoom.
    pub max_zoom: u8,
    /// Optional polygon mask in WGS84; `None` downloads the whole bbox.
    pub polygon: Option<Vec<[f64; 2]>>,
    /// Additional providers tried when the primary source fails a tile.
    pub source_ids: Vec<String>,
}

/// Persisted download job.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    /// Stable id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Provider id.
    pub provider_id: String,
    /// West bound.
    pub west: f64,
    /// South bound.
    pub south: f64,
    /// East bound.
    pub east: f64,
    /// North bound.
    pub north: f64,
    /// First zoom.
    pub min_zoom: u8,
    /// Last zoom.
    pub max_zoom: u8,
    /// Optional polygon mask; `None` downloads the whole bbox.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polygon: Option<Vec<[f64; 2]>>,
    /// Fallback providers in priority order.
    pub source_ids: Vec<String>,
    /// Current state.
    pub status: JobStatus,
    /// Tiles in the requested range.
    pub total_tiles: u64,
    /// Tiles processed in the current run.
    pub done_tiles: u64,
    /// Tiles that failed in the current run.
    pub failed_tiles: u64,
    /// Bytes downloaded in the current run.
    pub bytes: u64,
    /// Range positions already consumed; resuming skips this prefix.
    pub cursor_tiles: u64,
    /// Creation timestamp, Unix seconds.
    pub created_at: i64,
    /// Last update timestamp, Unix seconds.
    pub updated_at: i64,
    /// Last fatal error.
    pub error: Option<String>,
}

impl DownloadJob {
    /// Geographic coverage.
    pub fn bbox(&self) -> Option<Bbox> {
        Bbox::new(self.west, self.south, self.east, self.north).ok()
    }

    /// Fraction complete in `0.0..=1.0`.
    pub fn progress(&self) -> f64 {
        if self.total_tiles == 0 {
            0.0
        } else {
            (self.done_tiles + self.failed_tiles) as f64 / self.total_tiles as f64
        }
    }
}

/// SQLite-backed queue.
#[derive(Debug)]
pub struct DownloadStore {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
}

impl DownloadStore {
    /// Opens or creates a queue database.
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
        })
    }

    /// Opens a transient queue for tests.
    pub fn open_in_memory() -> StorageResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::configure(&conn, false)?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: None,
        })
    }

    /// Queue database path.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    fn configure(conn: &Connection, wal: bool) -> StorageResult<()> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        if wal {
            let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
            if !mode.eq_ignore_ascii_case("wal") {
                return Err(StorageError::Pragma(format!(
                    "journal_mode is {mode}, expected wal"
                )));
            }
        }
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(())
    }

    fn migrate(conn: &Connection) -> StorageResult<()> {
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version == 0 {
            conn.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS jobs (
                   id           TEXT PRIMARY KEY,
                   name         TEXT NOT NULL,
                   provider_id  TEXT NOT NULL,
                   west         REAL NOT NULL,
                   south        REAL NOT NULL,
                   east         REAL NOT NULL,
                   north        REAL NOT NULL,
                   min_zoom     INTEGER NOT NULL,
                   max_zoom     INTEGER NOT NULL,
                   status       TEXT NOT NULL,
                   total_tiles  INTEGER NOT NULL,
                   done_tiles   INTEGER NOT NULL DEFAULT 0,
                   failed_tiles INTEGER NOT NULL DEFAULT 0,
                   bytes        INTEGER NOT NULL DEFAULT 0,
                   created_at   INTEGER NOT NULL,
                   updated_at   INTEGER NOT NULL,
                   error        TEXT,
                   polygon      TEXT,
                   cursor_tiles INTEGER NOT NULL DEFAULT 0,
                   source_ids   TEXT NOT NULL DEFAULT '[]'
                 );
                 CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
                 PRAGMA user_version = 4;
                 COMMIT;",
            )?;
        } else if version == 1 {
            conn.execute_batch(
                "BEGIN;
                 ALTER TABLE jobs ADD COLUMN polygon TEXT;
                 ALTER TABLE jobs ADD COLUMN cursor_tiles INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE jobs ADD COLUMN source_ids TEXT NOT NULL DEFAULT '[]';
                 PRAGMA user_version = 4;
                 COMMIT;",
            )?;
        } else if version == 2 {
            conn.execute_batch(
                "BEGIN;
                 ALTER TABLE jobs ADD COLUMN cursor_tiles INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE jobs ADD COLUMN source_ids TEXT NOT NULL DEFAULT '[]';
                 PRAGMA user_version = 4;
                 COMMIT;",
            )?;
        } else if version == 3 {
            conn.execute_batch(
                "BEGIN;
                 ALTER TABLE jobs ADD COLUMN source_ids TEXT NOT NULL DEFAULT '[]';
                 PRAGMA user_version = 4;
                 COMMIT;",
            )?;
        } else if version > 4 {
            return Err(StorageError::UnsupportedSchema(version));
        }
        Ok(())
    }

    /// Validates and inserts a job.
    pub fn create(&self, job: NewJob) -> StorageResult<DownloadJob> {
        if job.name.trim().is_empty() {
            return Err(StorageError::InvalidJob("name is empty".to_owned()));
        }
        if job.provider_id.trim().is_empty() {
            return Err(StorageError::InvalidJob("provider is empty".to_owned()));
        }
        if job.min_zoom > job.max_zoom {
            return Err(StorageError::InvalidJob(
                "min_zoom is greater than max_zoom".to_owned(),
            ));
        }
        let bbox = Bbox::new(job.west, job.south, job.east, job.north)
            .map_err(|error| StorageError::InvalidJob(error.to_string()))?;
        let polygon = match job.polygon.as_deref() {
            Some(points) => Some(normalize_ring(points).ok_or_else(|| {
                StorageError::InvalidJob(
                    "polygon must have at least 3 valid WGS84 vertices".to_owned(),
                )
            })?),
            None => None,
        };
        if let Some(ring) = &polygon
            && let Some(point) = ring.iter().find(|point| !bbox.contains(point[0], point[1]))
        {
            return Err(StorageError::InvalidJob(format!(
                "polygon vertex {},{} is outside the download bounds",
                point[0], point[1]
            )));
        }
        // Tighten the stored bbox to the polygon so the worker and exports
        // never walk empty space around a hand-written request.
        let draw_bbox = match &polygon {
            Some(ring) => {
                let (west, south, east, north) = ring_bounds(ring);
                Bbox::new(
                    bbox.west().max(west),
                    bbox.south().max(south),
                    bbox.east().min(east),
                    bbox.north().min(north),
                )
                .map_err(|error| StorageError::InvalidJob(error.to_string()))?
            }
            None => bbox,
        };
        let total_tiles = match &polygon {
            Some(ring) => tile_count_ring(&draw_bbox, job.min_zoom, job.max_zoom, ring)?,
            None => tile_count(&draw_bbox, job.min_zoom, job.max_zoom)?,
        };
        let now = now_secs();
        let id = new_job_id();
        let record = DownloadJob {
            id: id.clone(),
            name: job.name.trim().to_owned(),
            provider_id: job.provider_id,
            west: draw_bbox.west(),
            south: draw_bbox.south(),
            east: draw_bbox.east(),
            north: draw_bbox.north(),
            min_zoom: job.min_zoom,
            max_zoom: job.max_zoom,
            polygon: polygon.clone(),
            source_ids: job.source_ids.clone(),
            status: JobStatus::Queued,
            total_tiles,
            done_tiles: 0,
            failed_tiles: 0,
            bytes: 0,
            cursor_tiles: 0,
            created_at: now,
            updated_at: now,
            error: None,
        };
        let polygon_json = record
            .polygon
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| StorageError::InvalidJob(error.to_string()))?;
        let sources_json = serde_json::to_string(&record.source_ids)
            .map_err(|error| StorageError::InvalidJob(error.to_string()))?;
        let conn = self.conn.lock().expect("jobs mutex poisoned");
        conn.execute(
            "INSERT INTO jobs
               (id, name, provider_id, west, south, east, north, min_zoom, max_zoom,
                status, total_tiles, done_tiles, failed_tiles, bytes, created_at,
                updated_at, error, polygon, source_ids)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 0, 0, ?12, ?12, NULL, ?13, ?14)",
            params![
                record.id,
                record.name,
                record.provider_id,
                record.west,
                record.south,
                record.east,
                record.north,
                i64::from(record.min_zoom),
                i64::from(record.max_zoom),
                record.status.as_str(),
                i64::try_from(record.total_tiles).unwrap_or(i64::MAX),
                record.created_at,
                polygon_json,
                sources_json
            ],
        )?;
        Ok(record)
    }

    /// Returns one job.
    pub fn get(&self, id: &str) -> StorageResult<Option<DownloadJob>> {
        let conn = self.conn.lock().expect("jobs mutex poisoned");
        conn.query_row(
            "SELECT id, name, provider_id, west, south, east, north, min_zoom,
                    max_zoom, status, total_tiles, done_tiles, failed_tiles,
                    bytes, created_at, updated_at, error, polygon, cursor_tiles,
                    source_ids
             FROM jobs WHERE id = ?1",
            [id],
            row_to_job,
        )
        .optional()
        .map_err(Into::into)
    }

    /// Returns all jobs in display order.
    pub fn list(&self) -> StorageResult<Vec<DownloadJob>> {
        let conn = self.conn.lock().expect("jobs mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, name, provider_id, west, south, east, north, min_zoom,
                    max_zoom, status, total_tiles, done_tiles, failed_tiles,
                    bytes, created_at, updated_at, error, polygon, cursor_tiles,
                    source_ids
             FROM jobs
             ORDER BY CASE status
                        WHEN 'running' THEN 0
                        WHEN 'paused' THEN 1
                        WHEN 'queued' THEN 2
                        ELSE 3
                      END,
                      created_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_job)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Sets status and optional error.
    pub fn set_status(
        &self,
        id: &str,
        status: JobStatus,
        error: Option<&str>,
    ) -> StorageResult<()> {
        let conn = self.conn.lock().expect("jobs mutex poisoned");
        conn.execute(
            "UPDATE jobs SET status = ?1, error = ?2, updated_at = ?3 WHERE id = ?4",
            params![status.as_str(), error, now_secs(), id],
        )?;
        Ok(())
    }

    /// Sets status only while the job is not already terminal.
    pub fn set_status_unless_terminal(
        &self,
        id: &str,
        status: JobStatus,
        error: Option<&str>,
    ) -> StorageResult<bool> {
        let conn = self.conn.lock().expect("jobs mutex poisoned");
        let changed = conn.execute(
            "UPDATE jobs SET status = ?1, error = ?2, updated_at = ?3
             WHERE id = ?4 AND status NOT IN ('completed', 'cancelled', 'failed')",
            params![status.as_str(), error, now_secs(), id],
        )?;
        Ok(changed > 0)
    }

    /// Worker lifecycle transition: only a running job may finish.
    pub fn set_status_if_running(
        &self,
        id: &str,
        status: JobStatus,
        error: Option<&str>,
    ) -> StorageResult<bool> {
        let conn = self.conn.lock().expect("jobs mutex poisoned");
        let changed = conn.execute(
            "UPDATE jobs SET status = ?1, error = ?2, updated_at = ?3
             WHERE id = ?4 AND status = 'running'",
            params![status.as_str(), error, now_secs(), id],
        )?;
        Ok(changed > 0)
    }

    /// Starts a worker only from the queued state.
    ///
    /// A pause that landed before the worker got here has already moved the
    /// job to `paused`, so it must win over the stale `queued` snapshot.
    pub fn set_running_if_queued(&self, id: &str) -> StorageResult<bool> {
        let conn = self.conn.lock().expect("jobs mutex poisoned");
        let changed = conn.execute(
            "UPDATE jobs SET status = 'running', error = NULL, updated_at = ?1
             WHERE id = ?2 AND status = 'queued'",
            params![now_secs(), id],
        )?;
        Ok(changed > 0)
    }

    /// Stores the counters and resume cursor of the current run.
    ///
    /// `done` and `cursor_tiles` are monotonic: a resumed worker skips the
    /// consumed prefix and must not roll the visible progress backwards.
    pub fn update_progress(
        &self,
        id: &str,
        done_tiles: u64,
        failed_tiles: u64,
        bytes: u64,
        cursor_tiles: u64,
    ) -> StorageResult<()> {
        let conn = self.conn.lock().expect("jobs mutex poisoned");
        conn.execute(
            "UPDATE jobs
             SET done_tiles = MAX(done_tiles, ?1),
                 failed_tiles = ?2,
                 bytes = ?3,
                 cursor_tiles = MAX(cursor_tiles, ?4),
                 updated_at = ?5
             WHERE id = ?6",
            params![
                i64::try_from(done_tiles).unwrap_or(i64::MAX),
                i64::try_from(failed_tiles).unwrap_or(i64::MAX),
                i64::try_from(bytes).unwrap_or(i64::MAX),
                i64::try_from(cursor_tiles).unwrap_or(i64::MAX),
                now_secs(),
                id
            ],
        )?;
        Ok(())
    }

    /// Deletes a job; active workers must be stopped by the caller.
    pub fn delete(&self, id: &str) -> StorageResult<bool> {
        let conn = self.conn.lock().expect("jobs mutex poisoned");
        Ok(conn.execute("DELETE FROM jobs WHERE id = ?1", [id])? > 0)
    }

    /// Converts jobs interrupted by a crash back into the queue.
    pub fn recover_interrupted(&self) -> StorageResult<u64> {
        let conn = self.conn.lock().expect("jobs mutex poisoned");
        let changed = conn.execute(
            "UPDATE jobs SET status = 'queued', updated_at = ?1 WHERE status = 'running'",
            [now_secs()],
        )?;
        Ok(u64::try_from(changed).unwrap_or(0))
    }

    /// Removes completed and cancelled jobs.
    pub fn clear_finished(&self) -> StorageResult<u64> {
        let conn = self.conn.lock().expect("jobs mutex poisoned");
        let changed = conn.execute(
            "DELETE FROM jobs WHERE status IN ('completed', 'cancelled')",
            [],
        )?;
        Ok(u64::try_from(changed).unwrap_or(0))
    }
}

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<DownloadJob> {
    let status: String = row.get(9)?;
    let status = JobStatus::from_str(&status).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            9,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unknown job status",
            )),
        )
    })?;
    Ok(DownloadJob {
        id: row.get(0)?,
        name: row.get(1)?,
        provider_id: row.get(2)?,
        west: row.get(3)?,
        south: row.get(4)?,
        east: row.get(5)?,
        north: row.get(6)?,
        min_zoom: u8::try_from(row.get::<_, i64>(7)?).unwrap_or(0),
        max_zoom: u8::try_from(row.get::<_, i64>(8)?).unwrap_or(0),
        polygon: row
            .get::<_, Option<String>>(17)?
            .map(|json| {
                serde_json::from_str(&json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        17,
                        rusqlite::types::Type::Text,
                        Box::new(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            format!("invalid polygon: {error}"),
                        )),
                    )
                })
            })
            .transpose()?,
        source_ids: row
            .get::<_, Option<String>>(19)?
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default(),
        status,
        total_tiles: u64::try_from(row.get::<_, i64>(10)?).unwrap_or(0),
        done_tiles: u64::try_from(row.get::<_, i64>(11)?).unwrap_or(0),
        failed_tiles: u64::try_from(row.get::<_, i64>(12)?).unwrap_or(0),
        bytes: u64::try_from(row.get::<_, i64>(13)?).unwrap_or(0),
        cursor_tiles: u64::try_from(row.get::<_, i64>(18)?).unwrap_or(0),
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        error: row.get(16)?,
    })
}

fn tile_count(bbox: &Bbox, min_zoom: u8, max_zoom: u8) -> StorageResult<u64> {
    let mut total = 0_u64;
    for zoom in min_zoom..=max_zoom {
        let range = TileRange::new(bbox, zoom)
            .map_err(|error| StorageError::InvalidJob(error.to_string()))?;
        total = total.saturating_add(range.count());
    }
    Ok(total)
}

/// Counts only tiles that overlap the polygon. Stops just above the desktop
/// queue limit so an absurd request cannot spend minutes counting.
fn tile_count_ring(
    bbox: &Bbox,
    min_zoom: u8,
    max_zoom: u8,
    ring: &[[f64; 2]],
) -> StorageResult<u64> {
    const COUNT_LIMIT: u64 = 2_000_001;
    // Bound wasted work on sparse rings whose bbox is much larger than the
    // mask. Such jobs would also make the worker crawl for hours.
    const EXAMINED_LIMIT: u64 = 4_000_000;
    // The UI always sends a tight bbox, but a hand-written queue request may
    // not. Clip to the polygon bounds so counting never walks empty space.
    let (ring_west, ring_south, ring_east, ring_north) = ring_bounds(ring);
    let region = Bbox::new(
        bbox.west().max(ring_west),
        bbox.south().max(ring_south),
        bbox.east().min(ring_east),
        bbox.north().min(ring_north),
    )
    .map_err(|error| StorageError::InvalidJob(error.to_string()))?;
    let mut total = 0_u64;
    let mut examined = 0_u64;
    let bounds = ring_bounds(ring);
    for zoom in min_zoom..=max_zoom {
        let range = TileRange::new(&region, zoom)
            .map_err(|error| StorageError::InvalidJob(error.to_string()))?;
        for coord in range.iter() {
            examined += 1;
            if examined > EXAMINED_LIMIT {
                return Err(StorageError::InvalidJob(
                    "polygon is too sparse for its bounding box; simplify it or split the download"
                        .to_owned(),
                ));
            }
            let (west, south, east, north) = coord.bounds();
            if tile_intersects_ring_with_bounds(west, south, east, north, ring, bounds) {
                total += 1;
                if total >= COUNT_LIMIT {
                    return Ok(total);
                }
            }
        }
    }
    Ok(total)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn new_job_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let sequence = JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("job-{nanos:x}-{sequence:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job() -> NewJob {
        NewJob {
            name: "Moscow".into(),
            provider_id: "osm".into(),
            west: 37.0,
            south: 55.0,
            east: 38.0,
            north: 56.0,
            min_zoom: 10,
            max_zoom: 11,
            polygon: None,
            source_ids: Vec::new(),
        }
    }

    #[test]
    fn creates_and_lists_jobs() {
        let store = DownloadStore::open_in_memory().unwrap();
        let created = store.create(job()).unwrap();
        assert_eq!(created.status, JobStatus::Queued);
        assert!(created.total_tiles > 0);
        assert!(created.id.starts_with("job-"));
        let jobs = store.list().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, created.id);
        assert_eq!(jobs[0].provider_id, "osm");
    }

    #[test]
    fn updates_progress_and_status() {
        let store = DownloadStore::open_in_memory().unwrap();
        let created = store.create(job()).unwrap();
        store.update_progress(&created.id, 5, 1, 1234, 7).unwrap();
        store
            .set_status(&created.id, JobStatus::Paused, Some("test"))
            .unwrap();
        let job = store.get(&created.id).unwrap().unwrap();
        assert_eq!(job.done_tiles, 5);
        assert_eq!(job.failed_tiles, 1);
        assert_eq!(job.bytes, 1234);
        assert_eq!(job.status, JobStatus::Paused);
        assert_eq!(job.error.as_deref(), Some("test"));
        assert!((job.progress() - 6.0 / job.total_tiles as f64).abs() < 1e-9);

        // A resumed worker restarts its counters at zero; progress must not
        // jump backwards while it rescans already downloaded tiles.
        store.update_progress(&created.id, 2, 0, 1500, 3).unwrap();
        let job = store.get(&created.id).unwrap().unwrap();
        assert_eq!(job.done_tiles, 5);
        assert_eq!(job.failed_tiles, 0);
        assert_eq!(job.bytes, 1500);
        assert_eq!(job.cursor_tiles, 7);
    }

    #[test]
    fn persists_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("jobs.sqlite3");
        let id = {
            let store = DownloadStore::open(&path).unwrap();
            store.create(job()).unwrap().id
        };
        let store = DownloadStore::open(&path).unwrap();
        assert!(store.get(&id).unwrap().is_some());
    }

    #[test]
    fn recovers_running_jobs() {
        let store = DownloadStore::open_in_memory().unwrap();
        let created = store.create(job()).unwrap();
        store
            .set_status(&created.id, JobStatus::Running, None)
            .unwrap();
        assert_eq!(store.recover_interrupted().unwrap(), 1);
        assert_eq!(
            store.get(&created.id).unwrap().unwrap().status,
            JobStatus::Queued
        );
    }

    #[test]
    fn deletes_and_clears() {
        let store = DownloadStore::open_in_memory().unwrap();
        let first = store.create(job()).unwrap();
        let second = store.create(job()).unwrap();
        store
            .set_status(&first.id, JobStatus::Completed, None)
            .unwrap();
        assert!(store.delete(&second.id).unwrap());
        assert!(!store.delete(&second.id).unwrap());
        assert_eq!(store.clear_finished().unwrap(), 1);
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn rejects_invalid_jobs() {
        let store = DownloadStore::open_in_memory().unwrap();
        let mut invalid = job();
        invalid.min_zoom = 12;
        invalid.max_zoom = 10;
        assert!(matches!(
            store.create(invalid),
            Err(StorageError::InvalidJob(_))
        ));

        let mut invalid = job();
        invalid.west = 10.0;
        invalid.east = 9.0;
        assert!(matches!(
            store.create(invalid),
            Err(StorageError::InvalidJob(_))
        ));

        let mut invalid = job();
        invalid.name = "   ".into();
        assert!(matches!(
            store.create(invalid),
            Err(StorageError::InvalidJob(_))
        ));
    }

    #[test]
    fn total_counts_all_zooms() {
        assert!(tile_count(&Bbox::new(37.0, 55.0, 38.0, 56.0).unwrap(), 10, 11).unwrap() > 2);
    }

    #[test]
    fn polygon_jobs_count_and_persist_only_masked_tiles() {
        let store = DownloadStore::open_in_memory().unwrap();
        let mut masked = job();
        masked.polygon = Some(vec![[37.2, 55.2], [37.4, 55.2], [37.4, 55.4], [37.2, 55.4]]);
        let created = store.create(masked).unwrap();
        assert!(created.polygon.is_some());
        assert!(created.west >= 37.2 - 1e-12);
        assert!(created.south >= 55.2 - 1e-12);
        assert!(created.east <= 37.4 + 1e-12);
        assert!(created.north <= 55.4 + 1e-12);
        assert!(created.total_tiles > 0);
        assert!(
            created.total_tiles
                < tile_count(&Bbox::new(37.0, 55.0, 38.0, 56.0).unwrap(), 10, 11).unwrap()
        );
        let loaded = store.get(&created.id).unwrap().unwrap();
        assert_eq!(loaded.polygon.as_ref().map(Vec::len), Some(4));
        assert_eq!(loaded.total_tiles, created.total_tiles);
    }

    #[test]
    fn status_transitions_respect_pause_and_cancel() {
        let store = DownloadStore::open_in_memory().unwrap();
        let created = store.create(job()).unwrap();

        // A pause before the worker starts must win over the stale queue row.
        assert!(
            store
                .set_status_unless_terminal(&created.id, JobStatus::Paused, None)
                .unwrap()
        );
        assert!(!store.set_running_if_queued(&created.id).unwrap());
        assert_eq!(
            store.get(&created.id).unwrap().unwrap().status,
            JobStatus::Paused
        );

        // Resume, then a user cancel must not be overwritten by completion.
        assert!(
            store
                .set_status_unless_terminal(&created.id, JobStatus::Queued, None)
                .unwrap()
        );
        assert!(store.set_running_if_queued(&created.id).unwrap());
        assert!(
            store
                .set_status_unless_terminal(&created.id, JobStatus::Cancelled, None)
                .unwrap()
        );
        assert!(
            !store
                .set_status_if_running(&created.id, JobStatus::Completed, None)
                .unwrap()
        );
        assert_eq!(
            store.get(&created.id).unwrap().unwrap().status,
            JobStatus::Cancelled
        );
    }

    #[test]
    fn migrates_version_one_queues() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("jobs.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE jobs (
                   id TEXT PRIMARY KEY, name TEXT NOT NULL, provider_id TEXT NOT NULL,
                   west REAL NOT NULL, south REAL NOT NULL, east REAL NOT NULL,
                   north REAL NOT NULL, min_zoom INTEGER NOT NULL, max_zoom INTEGER NOT NULL,
                   status TEXT NOT NULL, total_tiles INTEGER NOT NULL,
                   done_tiles INTEGER NOT NULL DEFAULT 0,
                   failed_tiles INTEGER NOT NULL DEFAULT 0,
                   bytes INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                   error TEXT
                 );
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        }
        let store = DownloadStore::open(&path).unwrap();
        let created = store.create(job()).unwrap();
        assert!(created.polygon.is_none());
        assert_eq!(created.cursor_tiles, 0);
        assert!(store.get(&created.id).unwrap().is_some());
    }

    #[test]
    fn migrates_version_two_queues_with_a_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("jobs.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE jobs (
                   id TEXT PRIMARY KEY, name TEXT NOT NULL, provider_id TEXT NOT NULL,
                   west REAL NOT NULL, south REAL NOT NULL, east REAL NOT NULL,
                   north REAL NOT NULL, min_zoom INTEGER NOT NULL, max_zoom INTEGER NOT NULL,
                   status TEXT NOT NULL, total_tiles INTEGER NOT NULL,
                   done_tiles INTEGER NOT NULL DEFAULT 0,
                   failed_tiles INTEGER NOT NULL DEFAULT 0,
                   bytes INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                   error TEXT, polygon TEXT
                 );
                 PRAGMA user_version = 2;",
            )
            .unwrap();
        }
        let store = DownloadStore::open(&path).unwrap();
        let created = store.create(job()).unwrap();
        assert_eq!(created.cursor_tiles, 0);
        assert!(store.get(&created.id).unwrap().is_some());
    }

    #[test]
    fn rejects_invalid_polygons() {
        let store = DownloadStore::open_in_memory().unwrap();
        let mut invalid = job();
        invalid.polygon = Some(vec![[37.2, 55.2], [37.4, 55.4]]);
        assert!(matches!(
            store.create(invalid),
            Err(StorageError::InvalidJob(_))
        ));

        let mut outside = job();
        outside.polygon = Some(vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]);
        assert!(matches!(
            store.create(outside),
            Err(StorageError::InvalidJob(_))
        ));
    }
}
