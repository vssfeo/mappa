//! MBTiles export for a geographic region.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageFormat};
use mappa_core::{Bbox, TileRange, ring_bounds, tile_intersects_ring_with_bounds};
use serde::Serialize;

use crate::cache::{SqliteCache, TileKey};
use crate::error::{StorageError, StorageResult};
use crate::mbtiles::{MbtilesMetadata, MbtilesWriter};

/// Region and metadata for an MBTiles export.
#[derive(Debug, Clone)]
pub struct ExportSpec {
    /// Provider whose cache entries are packed.
    pub provider_id: String,
    /// Pack name.
    pub name: String,
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
    /// Optional polygon mask; `None` packs the whole bbox.
    pub polygon: Option<Vec<[f64; 2]>>,
    /// Target image format (`png` or `jpg`).
    pub format: String,
    /// Attribution stored in metadata.
    pub attribution: Option<String>,
    /// License written into the pack metadata and the manifest.
    pub license: Option<String>,
    /// Output file path.
    pub output: PathBuf,
    /// Set by the UI to abort a long export; the temporary file is removed.
    pub cancel: Option<Arc<AtomicBool>>,
}

/// Export stage reported to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportPhase {
    /// Counting or sorting the requested tiles.
    Scanning,
    /// Encoding and writing tiles.
    Writing,
    /// Closing the archive and its indexes.
    Finalizing,
    /// Hashing and signing the manifest.
    Signing,
}

/// One progress sample from an export.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    /// Current stage.
    pub phase: ExportPhase,
    /// Completed units in the current stage.
    pub done: u64,
    /// Units expected in the current stage.
    pub total: u64,
    /// Tiles already written.
    pub written_tiles: u64,
    /// Encoded bytes already written.
    pub written_bytes: u64,
}

/// Result of a pack operation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    /// Written file.
    pub path: PathBuf,
    /// Number of tiles written.
    pub tiles: u64,
    /// Encoded bytes in the pack.
    pub bytes: u64,
    /// Tiles requested by the region but missing from the cache.
    pub missing: u64,
}

/// Packs cached tiles in `spec` into a new MBTiles file.
///
/// Tiles whose actual encoding differs from the target format (USGS mixes PNG
/// and JPEG) are transcoded.
pub fn export_region<F>(
    cache: &SqliteCache,
    spec: &ExportSpec,
    mut progress: F,
) -> StorageResult<ExportReport>
where
    F: FnMut(ExportProgress),
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
    let expected = count_masked_tiles(spec, &bbox)?;
    let mut metadata = MbtilesMetadata {
        name: Some(spec.name.clone()),
        format: format.to_owned(),
        bounds: Some(bbox),
        minzoom: Some(spec.min_zoom),
        maxzoom: Some(spec.max_zoom),
        attribution: spec.attribution.clone(),
        kind: Some("baselayer".to_owned()),
        ..MbtilesMetadata::default()
    };
    if let Some(license) = spec
        .license
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        metadata
            .extra
            .insert("license".to_owned(), license.chars().take(200).collect());
    }
    // Build next to the destination and publish atomically; a failed export
    // must not leave a plausible-looking partial pack behind.
    let temporary = temporary_output(&spec.output);
    let result = (|| -> StorageResult<ExportReport> {
        let mut writer = MbtilesWriter::create(&temporary, metadata)?;
        let mut processed = 0_u64;
        let mut missing = 0_u64;
        let mut bytes = 0_u64;
        let mask = spec
            .polygon
            .as_deref()
            .map(|ring| (ring, ring_bounds(ring)));

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
                check_cancelled(spec)?;
                let key = TileKey::new(&spec.provider_id, zoom, coord.x(), coord.y(), format);
                match cache.peek(&key)? {
                    Some(tile) => {
                        let data = to_format(&tile.data, format)?;
                        bytes = bytes.saturating_add(data.len() as u64);
                        writer.put_tile(zoom, coord.x(), coord.y(), &data)?;
                    }
                    None => missing += 1,
                }
                processed += 1;
                progress(ExportProgress {
                    phase: ExportPhase::Writing,
                    done: processed,
                    total: expected.max(1),
                    written_tiles: writer.count(),
                    written_bytes: bytes,
                });
            }
        }
        check_cancelled(spec)?;
        progress(ExportProgress {
            phase: ExportPhase::Finalizing,
            done: expected,
            total: expected.max(1),
            written_tiles: writer.count(),
            written_bytes: bytes,
        });
        writer.finish()?;
        check_cancelled(spec)?;
        std::fs::rename(&temporary, &spec.output)?;
        Ok(ExportReport {
            path: spec.output.clone(),
            tiles: processed - missing,
            bytes,
            missing,
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn check_cancelled(spec: &ExportSpec) -> StorageResult<()> {
    if spec
        .cancel
        .as_ref()
        .is_some_and(|flag| flag.load(Ordering::Relaxed))
    {
        Err(StorageError::InvalidJob("export cancelled".to_owned()))
    } else {
        Ok(())
    }
}

/// Counts tiles selected by the bbox and optional polygon mask.
pub(crate) fn count_masked_tiles(spec: &ExportSpec, bbox: &Bbox) -> StorageResult<u64> {
    let mask = spec
        .polygon
        .as_deref()
        .map(|ring| (ring, ring_bounds(ring)));
    let mut total = 0_u64;
    for zoom in spec.min_zoom..=spec.max_zoom {
        let range = TileRange::new(bbox, zoom)
            .map_err(|error| StorageError::InvalidJob(error.to_string()))?;
        for coord in range.iter() {
            if let Some((ring, bounds)) = mask {
                let (west, south, east, north) = coord.bounds();
                if !tile_intersects_ring_with_bounds(west, south, east, north, ring, bounds) {
                    continue;
                }
            }
            total += 1;
        }
    }
    Ok(total)
}

/// Unique sibling path so concurrent exports cannot truncate each other.
pub(crate) fn temporary_output(output: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("pack");
    output.with_file_name(format!(".{name}.{nanos}.tmp"))
}

/// Returns the target format after validating it is supported.
pub fn normalize_format(format: &str) -> StorageResult<&'static str> {
    match format.to_ascii_lowercase().as_str() {
        "png" => Ok("png"),
        "jpg" | "jpeg" => Ok("jpg"),
        other => Err(StorageError::InvalidJob(format!(
            "unsupported pack format {other:?}; use png or jpg"
        ))),
    }
}

fn actual_format(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("png");
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    None
}

pub(crate) fn to_format(data: &[u8], target: &str) -> StorageResult<Vec<u8>> {
    match actual_format(data) {
        Some(actual) if actual == target => Ok(data.to_vec()),
        Some(_) => {
            let image = image::load_from_memory(data)
                .map_err(|error| StorageError::Image(error.to_string()))?;
            encode(&image, target)
        }
        None => Err(StorageError::Image(
            "tile is neither PNG nor JPEG".to_owned(),
        )),
    }
}

fn encode(image: &DynamicImage, target: &str) -> StorageResult<Vec<u8>> {
    let mut buffer = Cursor::new(Vec::new());
    match target {
        "png" => {
            image
                .write_to(&mut buffer, ImageFormat::Png)
                .map_err(|error| StorageError::Image(error.to_string()))?;
        }
        "jpg" => {
            // Satellite imagery tolerates a mild quality reduction and JPEG
            // keeps packs several times smaller than lossless PNG.
            JpegEncoder::new_with_quality(&mut buffer, 88)
                .encode_image(image)
                .map_err(|error| StorageError::Image(error.to_string()))?;
        }
        other => {
            return Err(StorageError::InvalidJob(format!(
                "unsupported target format {other:?}"
            )));
        }
    }
    Ok(buffer.into_inner())
}

/// Builds a filesystem-safe pack name.
pub fn pack_file_name(name: &str, id: &str, extension: &str) -> String {
    let slug = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = if slug.is_empty() {
        "mappa".to_owned()
    } else {
        slug
    };
    format!("{slug}-{id}.{extension}")
}

/// Default directory for exports: `$MAPPA_EXPORTS`, else the given fallback.
pub fn export_dir(fallback: impl AsRef<Path>) -> PathBuf {
    std::env::var_os("MAPPA_EXPORTS")
        .map(PathBuf::from)
        .unwrap_or_else(|| fallback.as_ref().to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::Tile;
    use image::{ImageFormat, Rgb, RgbImage};

    fn sample(format: ImageFormat) -> Vec<u8> {
        let image = RgbImage::from_pixel(2, 2, Rgb([220, 40, 10]));
        let mut buffer = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image)
            .write_to(&mut buffer, format)
            .unwrap();
        buffer.into_inner()
    }

    #[test]
    fn masked_export_skips_tiles_outside_the_polygon() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SqliteCache::open_in_memory().unwrap();
        cache
            .put(&Tile::new(
                TileKey::new("usgs", 1, 1, 0, "png"),
                sample(ImageFormat::Png),
            ))
            .unwrap();
        let output = dir.path().join("masked.mbtiles");
        let report = export_region(
            &cache,
            &ExportSpec {
                provider_id: "usgs".into(),
                name: "Masked".into(),
                west: 0.0,
                south: 0.0,
                east: 180.0,
                north: 85.0,
                min_zoom: 1,
                max_zoom: 1,
                polygon: Some(vec![[10.0, 10.0], [20.0, 10.0], [20.0, 20.0], [10.0, 20.0]]),
                format: "png".into(),
                attribution: None,
                license: None,
                cancel: None,
                output,
            },
            |_| {},
        )
        .unwrap();
        assert_eq!(report.tiles, 1);
        assert_eq!(report.missing, 0);
    }

    #[test]
    fn failed_export_leaves_no_partial_pack() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SqliteCache::open_in_memory().unwrap();
        cache
            .put(&Tile::new(
                TileKey::new("usgs", 1, 0, 0, "png"),
                b"not an image".to_vec(),
            ))
            .unwrap();
        let output = dir.path().join("broken.mbtiles");
        let result = export_region(
            &cache,
            &ExportSpec {
                provider_id: "usgs".into(),
                name: "Broken".into(),
                west: -180.0,
                south: -85.0,
                east: 180.0,
                north: 85.0,
                min_zoom: 1,
                max_zoom: 1,
                polygon: None,
                format: "png".into(),
                attribution: None,
                license: None,
                cancel: None,
                output: output.clone(),
            },
            |_| {},
        );
        assert!(result.is_err());
        assert!(!output.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn reports_progress_and_honours_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SqliteCache::open_in_memory().unwrap();
        cache
            .put(&Tile::new(
                TileKey::new("usgs", 1, 0, 0, "png"),
                sample(ImageFormat::Png),
            ))
            .unwrap();
        let output = dir.path().join("progress.mbtiles");
        let mut phases = Vec::new();
        let report = export_region(
            &cache,
            &ExportSpec {
                provider_id: "usgs".into(),
                name: "Progress".into(),
                west: -180.0,
                south: -85.0,
                east: 180.0,
                north: 85.0,
                min_zoom: 1,
                max_zoom: 1,
                polygon: None,
                format: "png".into(),
                attribution: None,
                license: None,
                cancel: None,
                output: output.clone(),
            },
            |progress| phases.push(progress.phase),
        )
        .unwrap();
        assert_eq!(report.tiles, 1);
        assert!(phases.contains(&ExportPhase::Writing));
        assert_eq!(phases.last(), Some(&ExportPhase::Finalizing));

        let cancelled_output = dir.path().join("cancelled.mbtiles");
        let cancel = Arc::new(AtomicBool::new(true));
        let result = export_region(
            &cache,
            &ExportSpec {
                provider_id: "usgs".into(),
                name: "Cancelled".into(),
                west: -180.0,
                south: -85.0,
                east: 180.0,
                north: 85.0,
                min_zoom: 1,
                max_zoom: 1,
                polygon: None,
                format: "png".into(),
                attribution: None,
                license: None,
                cancel: Some(cancel),
                output: cancelled_output.clone(),
            },
            |_| {},
        );
        assert!(result.is_err());
        assert!(!cancelled_output.exists());
    }

    #[test]
    fn exports_mixed_formats_as_png() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SqliteCache::open_in_memory().unwrap();
        let png_key = TileKey::new("usgs", 1, 0, 0, "png");
        let jpg_key = TileKey::new("usgs", 1, 1, 0, "png");
        cache
            .put(&Tile::new(png_key.clone(), sample(ImageFormat::Png)))
            .unwrap();
        cache
            .put(&Tile::new(jpg_key.clone(), sample(ImageFormat::Jpeg)))
            .unwrap();

        let output = dir.path().join("mixed.mbtiles");
        let report = export_region(
            &cache,
            &ExportSpec {
                provider_id: "usgs".into(),
                name: "Mixed".into(),
                west: -180.0,
                south: -85.0,
                east: 180.0,
                north: 85.0,
                min_zoom: 1,
                max_zoom: 1,
                polygon: None,
                format: "png".into(),
                attribution: Some("USGS".into()),
                license: Some("public-domain".into()),
                cancel: None,
                output: output.clone(),
            },
            |_| {},
        )
        .unwrap();

        assert_eq!(report.tiles, 2);
        assert_eq!(report.missing, 2);
        assert!(report.bytes > 0);
        let pack = crate::mbtiles::Mbtiles::open(&output).unwrap();
        assert_eq!(pack.metadata().format, "png");
        assert_eq!(pack.metadata().name.as_deref(), Some("Mixed"));
        for (x, y) in [(0, 0), (1, 0)] {
            let data = pack.get_tile(1, x, y).unwrap().unwrap();
            assert_eq!(actual_format(&data), Some("png"));
        }
    }

    #[test]
    fn exports_mixed_formats_as_jpg() {
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
        let output = dir.path().join("mixed-jpg.mbtiles");
        let report = export_region(
            &cache,
            &ExportSpec {
                provider_id: "usgs".into(),
                name: "Mixed JPEG".into(),
                west: -180.0,
                south: -85.0,
                east: 180.0,
                north: 85.0,
                min_zoom: 1,
                max_zoom: 1,
                polygon: None,
                format: "jpg".into(),
                attribution: None,
                license: None,
                cancel: None,
                output: output.clone(),
            },
            |_| {},
        )
        .unwrap();
        assert_eq!(report.tiles, 2);
        let pack = crate::mbtiles::Mbtiles::open(&output).unwrap();
        assert_eq!(pack.metadata().format, "jpg");
        for (x, y) in [(0, 0), (1, 0)] {
            let data = pack.get_tile(1, x, y).unwrap().unwrap();
            assert_eq!(actual_format(&data), Some("jpg"));
        }
    }

    #[test]
    fn rejects_unknown_formats() {
        assert!(normalize_format("gif").is_err());
        assert!(normalize_format("jpeg").is_ok());
    }

    #[test]
    fn slugifies_names() {
        assert_eq!(
            pack_file_name("USGS / San Francisco", "job-abc", "mbtiles"),
            "usgs-san-francisco-job-abc.mbtiles"
        );
        assert_eq!(pack_file_name("///", "id", "pmtiles"), "mappa-id.pmtiles");
    }
}
