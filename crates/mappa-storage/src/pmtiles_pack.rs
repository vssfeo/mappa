//! PMTiles v3 export and local reading.

use std::path::{Path, PathBuf};

use mappa_core::{Bbox, TileRange, ring_bounds, tile_intersects_ring_with_bounds};
use pmtiles::{
    AsyncPmTilesReader, MmapBackend, PmTilesWriter, TileCoord as PmtTileCoord, TileId, TileType,
};
use serde::Serialize;
use serde_json::json;

use crate::cache::{SqliteCache, TileKey};
use crate::error::{StorageError, StorageResult};
use crate::pack::{ExportReport, ExportSpec, normalize_format, temporary_output, to_format};

/// Public metadata of a local PMTiles pack.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmtilesPackInfo {
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
    /// Tile format (`png`, `jpg`, `webp`, `avif`) or `unknown`.
    pub format: String,
    /// PMTiles tile type as a debug label.
    pub tile_type: String,
}

/// A memory-mapped local PMTiles reader.
pub struct PmtilesPack {
    reader: AsyncPmTilesReader<MmapBackend>,
    path: PathBuf,
    info: PmtilesPackInfo,
}

impl PmtilesPack {
    /// Opens and validates a PMTiles v3 archive.
    pub async fn open(path: impl AsRef<Path>) -> StorageResult<Self> {
        let path = path.as_ref().to_path_buf();
        let backend = MmapBackend::try_from(&path).await?;
        let reader = AsyncPmTilesReader::try_from_source(backend).await?;
        let header = reader.get_header();
        let info = PmtilesPackInfo {
            min_zoom: header.min_zoom,
            max_zoom: header.max_zoom,
            west: header.min_longitude,
            south: header.min_latitude,
            east: header.max_longitude,
            north: header.max_latitude,
            format: format_for(header.tile_type),
            tile_type: format!("{:?}", header.tile_type),
        };
        Ok(Self { reader, path, info })
    }

    /// Archive path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Header-derived metadata.
    pub fn info(&self) -> &PmtilesPackInfo {
        &self.info
    }

    /// JSON metadata, if present.
    pub async fn metadata(&self) -> StorageResult<Option<String>> {
        Ok(Some(self.reader.get_metadata().await?))
    }

    /// Reads and decompresses one tile.
    pub async fn get_tile(&self, z: u8, x: u32, y: u32) -> StorageResult<Option<Vec<u8>>> {
        let coord = PmtTileCoord::new(z, x, y).map_err(|error| {
            StorageError::InvalidJob(format!("invalid PMTiles coordinate: {error}"))
        })?;
        Ok(self
            .reader
            .get_tile_decompressed(coord)
            .await?
            .map(|bytes| bytes.to_vec()))
    }

    /// Raster tile format for MapLibre.
    pub fn format(&self) -> &str {
        &self.info.format
    }
}

/// Writes cached tiles into a PMTiles v3 archive.
///
/// Tiles are ordered by PMTiles' Hilbert tile id and images are normalized to
/// `spec.format` before writing.
pub fn export_region_pmtiles<F>(
    cache: &SqliteCache,
    spec: &ExportSpec,
    mut progress: F,
) -> StorageResult<ExportReport>
where
    F: FnMut(u64, u64),
{
    let bbox = Bbox::new(spec.west, spec.south, spec.east, spec.north)
        .map_err(|error| StorageError::InvalidJob(error.to_string()))?;
    if spec.min_zoom > spec.max_zoom {
        return Err(StorageError::InvalidJob(
            "min_zoom is greater than max_zoom".to_owned(),
        ));
    }
    if spec.output.exists() {
        return Err(StorageError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("refusing to overwrite {}", spec.output.display()),
        )));
    }
    let format = normalize_format(&spec.format)?;
    let tile_type = match format {
        "png" => TileType::Png,
        "jpg" => TileType::Jpeg,
        _ => {
            return Err(StorageError::InvalidJob(format!(
                "unsupported PMTiles format {format:?}"
            )));
        }
    };

    // PMTiles requires Hilbert tile-id order. Keep only coordinates in memory
    // during the scan; data is fetched again in the write pass.
    let mask = spec
        .polygon
        .as_deref()
        .map(|ring| (ring, ring_bounds(ring)));
    let mut coords = Vec::new();
    let mut total = 0_u64;
    for zoom in spec.min_zoom..=spec.max_zoom {
        let range = TileRange::new(&bbox, zoom)
            .map_err(|error| StorageError::InvalidJob(error.to_string()))?;
        for coord in range.iter() {
            if let Some((ring, bounds)) = mask {
                let (west, south, east, north) = coord.bounds();
                if !tile_intersects_ring_with_bounds(west, south, east, north, ring, bounds) {
                    continue;
                }
            }
            total += 1;
            let key = TileKey::new(&spec.provider_id, zoom, coord.x(), coord.y(), format);
            if cache.peek(&key)?.is_some() {
                let pmt = PmtTileCoord::new(zoom, coord.x(), coord.y())
                    .map_err(|error| StorageError::InvalidJob(error.to_string()))?;
                let id: TileId = pmt.into();
                coords.push((id.value(), zoom, coord.x(), coord.y()));
            }
        }
        progress(total, 0);
    }
    let found = coords.len() as u64;
    coords.sort_unstable_by_key(|entry| entry.0);

    let center_lon = (spec.west + spec.east) / 2.0;
    let center_lat = (spec.south + spec.north) / 2.0;
    let metadata = json!({
        "name": spec.name,
        "attribution": spec.attribution,
        "format": format,
        "bounds": [spec.west, spec.south, spec.east, spec.north],
        "minzoom": spec.min_zoom,
        "maxzoom": spec.max_zoom,
        "license": spec.license,
    })
    .to_string();
    let temporary = temporary_output(&spec.output);
    let result = (|| -> StorageResult<ExportReport> {
        let file = std::fs::File::create(&temporary)?;
        let mut writer = PmTilesWriter::new(tile_type)
            .min_zoom(spec.min_zoom)
            .max_zoom(spec.max_zoom)
            .bounds(spec.west, spec.south, spec.east, spec.north)
            .center(center_lon, center_lat)
            .center_zoom(spec.min_zoom)
            .metadata(metadata)
            .create(file)?;

        let mut written = 0_u64;
        let mut bytes = 0_u64;
        for (index, (_, zoom, x, y)) in coords.iter().enumerate() {
            let key = TileKey::new(&spec.provider_id, *zoom, *x, *y, format);
            let Some(tile) = cache.peek(&key)? else {
                continue;
            };
            let data = to_format(&tile.data, format)?;
            let coord = PmtTileCoord::new(*zoom, *x, *y)
                .map_err(|error| StorageError::InvalidJob(error.to_string()))?;
            writer.add_tile(coord, &data)?;
            written += 1;
            bytes = bytes.saturating_add(data.len() as u64);
            progress(total + index as u64 + 1, written);
        }
        writer.finalize()?;
        std::fs::rename(&temporary, &spec.output)?;
        Ok(ExportReport {
            path: spec.output.clone(),
            tiles: written,
            bytes,
            missing: total.saturating_sub(found),
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn format_for(tile_type: TileType) -> String {
    match tile_type {
        TileType::Png => "png",
        TileType::Jpeg => "jpg",
        TileType::Webp => "webp",
        TileType::Avif => "avif",
        _ => "unknown",
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::Tile;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;

    fn sample(format: ImageFormat) -> Vec<u8> {
        let image = RgbImage::from_pixel(2, 2, Rgb([10, 120, 200]));
        let mut buffer = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image)
            .write_to(&mut buffer, format)
            .unwrap();
        buffer.into_inner()
    }

    #[tokio::test]
    async fn exports_and_reads_pmtiles() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SqliteCache::open_in_memory().unwrap();
        for (x, format) in [(0, ImageFormat::Png), (1, ImageFormat::Jpeg)] {
            cache
                .put(&Tile::new(
                    TileKey::new("usgs", 1, x, 0, "jpg"),
                    sample(format),
                ))
                .unwrap();
        }
        let output = dir.path().join("mixed.pmtiles");
        let report = export_region_pmtiles(
            &cache,
            &ExportSpec {
                provider_id: "usgs".into(),
                name: "PMTiles test".into(),
                west: -180.0,
                south: -85.0,
                east: 180.0,
                north: 85.0,
                min_zoom: 1,
                max_zoom: 1,
                polygon: None,
                format: "jpg".into(),
                attribution: Some("test".into()),
                license: None,
                output: output.clone(),
            },
            |_, _| {},
        )
        .unwrap();
        assert_eq!(report.tiles, 2);
        assert_eq!(report.missing, 2);

        let pack = PmtilesPack::open(&output).await.unwrap();
        assert_eq!(pack.info().format, "jpg");
        assert_eq!(pack.info().min_zoom, 1);
        let tile = pack.get_tile(1, 0, 0).await.unwrap().unwrap();
        assert_eq!(&tile[0..3], &[0xFF, 0xD8, 0xFF]);
        let tile = pack.get_tile(1, 1, 0).await.unwrap().unwrap();
        assert_eq!(&tile[0..3], &[0xFF, 0xD8, 0xFF]);
        assert!(pack.metadata().await.unwrap().is_some());
    }
}
