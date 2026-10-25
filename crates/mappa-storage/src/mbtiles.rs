//! MBTiles 1.3 reader and writer.
//!
//! MBTiles stores rows in TMS order, so this module flips Y on every read and
//! write. Both plain `tiles` tables and views over `map`/`images` are accepted.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use mappa_core::Bbox;
use mappa_core::inflate::gzip_decompress;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use crate::cache::{SqliteCache, Tile, TileKey, now_unix};
use crate::error::{StorageError, StorageResult};

/// Metadata advertised by an MBTiles pack.
#[derive(Debug, Clone, Default)]
pub struct MbtilesMetadata {
    /// Pack name.
    pub name: Option<String>,
    /// Tile image format (`png`, `jpg`, `webp`).
    pub format: String,
    /// Geographic coverage.
    pub bounds: Option<Bbox>,
    /// Lowest zoom in the pack.
    pub minzoom: Option<u8>,
    /// Highest zoom in the pack.
    pub maxzoom: Option<u8>,
    /// Attribution text.
    pub attribution: Option<String>,
    /// Free-form description.
    pub description: Option<String>,
    /// `overlay` or `baselayer`.
    pub kind: Option<String>,
    /// Pack version.
    pub version: Option<String>,
    /// Metadata keys this build does not model.
    pub extra: BTreeMap<String, String>,
}

impl MbtilesMetadata {
    /// Metadata with the required fields filled in.
    pub fn new(name: impl Into<String>, format: impl Into<String>) -> Self {
        Self {
            name: Some(name.into()),
            format: format.into(),
            ..Self::default()
        }
    }

    fn as_pairs(&self) -> Vec<(&'static str, String)> {
        let mut pairs = Vec::new();
        if let Some(name) = &self.name {
            pairs.push(("name", name.clone()));
        }
        if !self.format.is_empty() {
            pairs.push(("format", self.format.clone()));
        }
        if let Some(bounds) = self.bounds {
            pairs.push((
                "bounds",
                format!(
                    "{},{},{},{}",
                    bounds.west(),
                    bounds.south(),
                    bounds.east(),
                    bounds.north()
                ),
            ));
        }
        if let Some(minzoom) = self.minzoom {
            pairs.push(("minzoom", minzoom.to_string()));
        }
        if let Some(maxzoom) = self.maxzoom {
            pairs.push(("maxzoom", maxzoom.to_string()));
        }
        if let Some(attribution) = &self.attribution {
            pairs.push(("attribution", attribution.clone()));
        }
        if let Some(description) = &self.description {
            pairs.push(("description", description.clone()));
        }
        if let Some(kind) = &self.kind {
            pairs.push(("type", kind.clone()));
        }
        if let Some(version) = &self.version {
            pairs.push(("version", version.clone()));
        }
        pairs
    }
}

/// Upper bound for one decompressed tile.
const MAX_TILE_BYTES: usize = 64 * 1024 * 1024;

/// Read-only MBTiles pack.
#[derive(Debug)]
pub struct Mbtiles {
    conn: Connection,
    path: PathBuf,
    metadata: MbtilesMetadata,
}

impl Mbtiles {
    /// Opens a pack in read-only mode and validates its schema.
    pub fn open(path: impl AsRef<Path>) -> StorageResult<Self> {
        let path = path.as_ref().to_path_buf();
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Self::require_table(&conn, "tiles")?;
        Self::require_table(&conn, "metadata")?;
        let metadata = read_metadata(&conn)?;
        Ok(Self {
            conn,
            path,
            metadata,
        })
    }

    /// Pack path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Parsed metadata.
    pub fn metadata(&self) -> &MbtilesMetadata {
        &self.metadata
    }

    /// Reads one tile using XYZ coordinates.
    pub fn get_tile(&self, z: u8, x: u32, y: u32) -> StorageResult<Option<Vec<u8>>> {
        let tms_y = tms_y(z, x, y)?;
        let data = self
            .conn
            .query_row(
                "SELECT tile_data FROM tiles
                 WHERE zoom_level = ?1 AND tile_column = ?2 AND tile_row = ?3",
                params![i64::from(z), i64::from(x), tms_y],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()?;
        data.map(|data| {
            // Vector MBTiles stores MVT gzipped; MapLibre requires raw MVT.
            if data.starts_with(&[0x1f, 0x8b]) {
                gzip_decompress(&data, MAX_TILE_BYTES).map_err(|error| {
                    StorageError::InvalidMbtiles(format!("cannot decompress gzip tile: {error}"))
                })
            } else {
                Ok(data)
            }
        })
        .transpose()
    }

    /// Number of stored tiles.
    pub fn tile_count(&self) -> StorageResult<u64> {
        let count: i64 = self
            .conn
            .query_row("SELECT count(*) FROM tiles", [], |row| row.get(0))?;
        Ok(u64::try_from(count).unwrap_or(0))
    }

    /// Lowest zoom present, from metadata or a table scan.
    pub fn min_zoom(&self) -> StorageResult<Option<u8>> {
        if let Some(zoom) = self.metadata.minzoom {
            return Ok(Some(zoom));
        }
        let zoom: Option<i64> = self
            .conn
            .query_row("SELECT min(zoom_level) FROM tiles", [], |row| row.get(0))
            .optional()?
            .flatten();
        Ok(zoom.and_then(|value| u8::try_from(value).ok()))
    }

    /// Highest zoom present, from metadata or a table scan.
    pub fn max_zoom(&self) -> StorageResult<Option<u8>> {
        if let Some(zoom) = self.metadata.maxzoom {
            return Ok(Some(zoom));
        }
        let zoom: Option<i64> = self
            .conn
            .query_row("SELECT max(zoom_level) FROM tiles", [], |row| row.get(0))
            .optional()?
            .flatten();
        Ok(zoom.and_then(|value| u8::try_from(value).ok()))
    }

    /// Visits every tile in XYZ order.
    pub fn for_each_tile<F>(&self, mut visit: F) -> StorageResult<u64>
    where
        F: FnMut(u8, u32, u32, &[u8]) -> StorageResult<()>,
    {
        let mut stmt = self.conn.prepare(
            "SELECT zoom_level, tile_column, tile_row, tile_data
             FROM tiles ORDER BY zoom_level, tile_column, tile_row DESC",
        )?;
        let mut rows = stmt.query([])?;
        let mut count = 0_u64;
        while let Some(row) = rows.next()? {
            let z = u8::try_from(row.get::<_, i64>(0)?)
                .map_err(|_| StorageError::ValueOutOfRange("zoom_level"))?;
            let x = u32::try_from(row.get::<_, i64>(1)?)
                .map_err(|_| StorageError::ValueOutOfRange("tile_column"))?;
            let tms_y = u32::try_from(row.get::<_, i64>(2)?)
                .map_err(|_| StorageError::ValueOutOfRange("tile_row"))?;
            let side = 1_u32
                .checked_shl(u32::from(z))
                .ok_or(StorageError::CoordinateOutOfRange { z, x, y: tms_y })?;
            if x >= side || tms_y >= side {
                return Err(StorageError::CoordinateOutOfRange { z, x, y: tms_y });
            }
            let data: Vec<u8> = row.get(3)?;
            visit(z, x, side - 1 - tms_y, &data)?;
            count += 1;
        }
        Ok(count)
    }

    /// Copies every tile into a cache under `provider_id`.
    pub fn import_into(
        &self,
        cache: &SqliteCache,
        provider_id: &str,
        variant: &str,
    ) -> StorageResult<u64> {
        let format = self.metadata.format.clone();
        self.for_each_tile(|z, x, y, data| {
            let key = TileKey::new(provider_id, z, x, y, format.clone()).with_variant(variant);
            let mut tile = Tile::new(key, data.to_vec());
            tile.content_type = Some(content_type(&format).to_owned());
            cache.put(&tile)
        })
    }

    fn require_table(conn: &Connection, name: &str) -> StorageResult<()> {
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM sqlite_master
               WHERE type IN ('table', 'view') AND name = ?1)",
            [name],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(StorageError::InvalidMbtiles(format!(
                "missing {name} table"
            )));
        }
        Ok(())
    }
}

/// Streaming MBTiles writer.
///
/// Rows are inserted inside one transaction; call [`finish`](Self::finish) to
/// build the index and commit. Dropping an unfinished writer rolls back.
#[derive(Debug)]
pub struct MbtilesWriter {
    conn: Option<Connection>,
    path: PathBuf,
    metadata: MbtilesMetadata,
    count: u64,
}

impl MbtilesWriter {
    /// Creates a new pack. Fails when the path already exists.
    pub fn create(path: impl AsRef<Path>, metadata: MbtilesMetadata) -> StorageResult<Self> {
        let path = path.as_ref().to_path_buf();
        if metadata.format.is_empty() {
            return Err(StorageError::InvalidMbtiles("format is required".into()));
        }
        if path.exists() {
            return Err(StorageError::Io(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("refusing to overwrite {}", path.display()),
            )));
        }
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE metadata (name TEXT NOT NULL, value TEXT);
             CREATE TABLE tiles (
               zoom_level  INTEGER NOT NULL,
               tile_column INTEGER NOT NULL,
               tile_row    INTEGER NOT NULL,
               tile_data   BLOB NOT NULL
             );",
        )?;
        Ok(Self {
            conn: Some(conn),
            path,
            metadata,
            count: 0,
        })
    }

    /// Path of the pack being written.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Number of tiles written so far.
    pub fn count(&self) -> u64 {
        self.count
    }

    /// Appends one tile, converting XYZ Y to TMS.
    pub fn put_tile(&mut self, z: u8, x: u32, y: u32, data: &[u8]) -> StorageResult<()> {
        let tms_y = tms_y(z, x, y)?;
        let conn = self
            .conn
            .as_mut()
            .ok_or_else(|| StorageError::InvalidMbtiles("writer already finished".into()))?;
        conn.execute(
            "INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data)
             VALUES (?1, ?2, ?3, ?4)",
            params![i64::from(z), i64::from(x), tms_y, data],
        )?;
        self.count += 1;
        Ok(())
    }

    /// Copies every cached tile of one provider into the pack.
    ///
    /// The cache lock is held while rows stream, so the visitor must not call
    /// back into the same cache.
    pub fn put_provider_cache(
        &mut self,
        cache: &SqliteCache,
        provider_id: &str,
    ) -> StorageResult<u64> {
        let format = self.metadata.format.clone();
        cache.for_each_provider_tile(provider_id, |tile| {
            if tile.key.format == format {
                self.put_tile(tile.key.z, tile.key.x, tile.key.y, &tile.data)?;
            }
            Ok(())
        })
    }

    /// Writes metadata, builds the index and commits.
    pub fn finish(mut self) -> StorageResult<PathBuf> {
        let conn = self
            .conn
            .take()
            .ok_or_else(|| StorageError::InvalidMbtiles("writer already finished".into()))?;
        for (key, value) in self.metadata.as_pairs() {
            conn.execute(
                "INSERT INTO metadata (name, value) VALUES (?1, ?2)",
                params![key, value],
            )?;
        }
        for (key, value) in &self.metadata.extra {
            if !matches!(
                key.as_str(),
                "name"
                    | "format"
                    | "bounds"
                    | "minzoom"
                    | "maxzoom"
                    | "attribution"
                    | "description"
                    | "type"
                    | "version"
            ) {
                conn.execute(
                    "INSERT OR REPLACE INTO metadata (name, value) VALUES (?1, ?2)",
                    params![key, value],
                )?;
            }
        }
        conn.execute_batch(
            "CREATE UNIQUE INDEX tile_index
               ON tiles (zoom_level, tile_column, tile_row);
             COMMIT;
             PRAGMA synchronous = NORMAL;
             PRAGMA optimize;",
        )?;
        Ok(self.path)
    }
}

fn tms_y(z: u8, x: u32, y: u32) -> StorageResult<i64> {
    let side = 1_u32
        .checked_shl(u32::from(z))
        .ok_or(StorageError::CoordinateOutOfRange { z, x, y })?;
    if x >= side || y >= side {
        return Err(StorageError::CoordinateOutOfRange { z, x, y });
    }
    Ok(i64::from(side - 1 - y))
}

fn content_type(format: &str) -> &'static str {
    match format {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "mvt" | "pbf" => "application/vnd.mapbox-vector-tile",
        _ => "image/png",
    }
}

fn read_metadata(conn: &Connection) -> StorageResult<MbtilesMetadata> {
    let mut stmt = conn.prepare("SELECT name, value FROM metadata")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut raw = BTreeMap::new();
    for row in rows {
        let (key, value) = row?;
        raw.insert(key, value);
    }
    let mut metadata = MbtilesMetadata {
        format: raw.remove("format").unwrap_or_default(),
        ..MbtilesMetadata::default()
    };
    metadata.name = raw.remove("name");
    metadata.attribution = raw.remove("attribution");
    metadata.description = raw.remove("description");
    metadata.kind = raw.remove("type");
    metadata.version = raw.remove("version");
    metadata.minzoom = raw.remove("minzoom").and_then(|value| value.parse().ok());
    metadata.maxzoom = raw.remove("maxzoom").and_then(|value| value.parse().ok());
    metadata.bounds = raw.remove("bounds").and_then(|value| {
        let mut parts = value.split(',');
        let west = parts.next()?.trim().parse().ok()?;
        let south = parts.next()?.trim().parse().ok()?;
        let east = parts.next()?.trim().parse().ok()?;
        let north = parts.next()?.trim().parse().ok()?;
        Bbox::new(west, south, east, north).ok()
    });
    metadata.extra = raw;
    Ok(metadata)
}

/// Formats an MBTiles `bounds` value.
pub fn format_bounds(bounds: Bbox) -> String {
    format!(
        "{},{},{},{}",
        bounds.west(),
        bounds.south(),
        bounds.east(),
        bounds.north()
    )
}

/// Creates a tile with a content type inferred from `format`.
pub fn tile_from_mbtiles(
    provider_id: &str,
    variant: &str,
    format: &str,
    z: u8,
    x: u32,
    y: u32,
    data: Vec<u8>,
) -> Tile {
    let key = TileKey::new(provider_id, z, x, y, format).with_variant(variant);
    let mut tile = Tile::new(key, data);
    tile.content_type = Some(content_type(format).to_owned());
    tile.last_used = now_unix();
    tile
}

#[cfg(test)]
mod tests {
    use super::*;
    use mappa_core::Bbox;

    #[test]
    fn writes_and_reads_pack() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.mbtiles");
        let metadata = MbtilesMetadata {
            name: Some("Sample".into()),
            format: "png".into(),
            bounds: Some(Bbox::new(10.0, 20.0, 30.0, 40.0).unwrap()),
            minzoom: Some(1),
            maxzoom: Some(2),
            attribution: Some("© test".into()),
            ..MbtilesMetadata::default()
        };
        let mut writer = MbtilesWriter::create(&path, metadata).unwrap();
        writer.put_tile(1, 0, 0, b"north-west").unwrap();
        writer.put_tile(1, 0, 1, b"south-west").unwrap();
        assert_eq!(writer.count(), 2);
        writer.finish().unwrap();

        let pack = Mbtiles::open(&path).unwrap();
        assert_eq!(pack.metadata().name.as_deref(), Some("Sample"));
        assert_eq!(pack.metadata().format, "png");
        assert_eq!(pack.metadata().bounds.unwrap().west(), 10.0);
        assert_eq!(pack.tile_count().unwrap(), 2);
        assert_eq!(pack.get_tile(1, 0, 0).unwrap().unwrap(), b"north-west");
        assert_eq!(pack.get_tile(1, 0, 1).unwrap().unwrap(), b"south-west");
        assert!(pack.get_tile(2, 0, 0).unwrap().is_none());
    }

    #[test]
    fn flips_y_on_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("flip.mbtiles");
        let mut writer = MbtilesWriter::create(&path, MbtilesMetadata::new("Flip", "png")).unwrap();
        writer.put_tile(2, 1, 0, b"north").unwrap();
        writer.finish().unwrap();

        let conn = Connection::open(&path).unwrap();
        let stored_y: i64 = conn
            .query_row(
                "SELECT tile_row FROM tiles WHERE zoom_level = 2 AND tile_column = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_y, 3);
    }

    #[test]
    fn iterates_in_xyz_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("iter.mbtiles");
        let mut writer = MbtilesWriter::create(&path, MbtilesMetadata::new("Iter", "jpg")).unwrap();
        for y in 0..2 {
            for x in 0..2 {
                writer
                    .put_tile(1, x, y, format!("{x},{y}").as_bytes())
                    .unwrap();
            }
        }
        writer.finish().unwrap();
        let pack = Mbtiles::open(&path).unwrap();
        let mut seen = Vec::new();
        let count = pack
            .for_each_tile(|z, x, y, data| {
                seen.push((z, x, y, String::from_utf8(data.to_vec()).unwrap()));
                Ok(())
            })
            .unwrap();
        assert_eq!(count, 4);
        assert_eq!(
            seen,
            vec![
                (1, 0, 0, "0,0".to_owned()),
                (1, 0, 1, "0,1".to_owned()),
                (1, 1, 0, "1,0".to_owned()),
                (1, 1, 1, "1,1".to_owned()),
            ]
        );
    }

    #[test]
    fn imports_into_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("import.mbtiles");
        let mut writer =
            MbtilesWriter::create(&path, MbtilesMetadata::new("Import", "png")).unwrap();
        writer.put_tile(3, 2, 1, b"tile-data").unwrap();
        writer.finish().unwrap();

        let cache = SqliteCache::open_in_memory().unwrap();
        let pack = Mbtiles::open(&path).unwrap();
        assert_eq!(pack.import_into(&cache, "demo", "").unwrap(), 1);
        let stored = cache
            .peek(&TileKey::new("demo", 3, 2, 1, "png"))
            .unwrap()
            .unwrap();
        assert_eq!(stored.data, b"tile-data");
        assert_eq!(stored.content_type.as_deref(), Some("image/png"));
    }

    #[test]
    fn refuses_to_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existing.mbtiles");
        std::fs::write(&path, b"not a database").unwrap();
        assert!(matches!(
            MbtilesWriter::create(&path, MbtilesMetadata::new("X", "png")),
            Err(StorageError::Io(_))
        ));
    }

    #[test]
    fn rejects_out_of_range_tiles() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("range.mbtiles");
        let mut writer = MbtilesWriter::create(&path, MbtilesMetadata::new("X", "png")).unwrap();
        assert!(matches!(
            writer.put_tile(1, 2, 0, b"x"),
            Err(StorageError::CoordinateOutOfRange { .. })
        ));
    }
}
