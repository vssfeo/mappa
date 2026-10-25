//! Import a plain XYZ tile folder into an MBTiles pack.
//!
//! Expected layout: `<root>/<z>/<x>/<y>.<png|jpg|webp>`. Folders are scanned
//! with depth and tile-count limits; symlinks and unknown image signatures are
//! skipped so a hand-made directory cannot turn into an unbounded import.

use std::path::{Path, PathBuf};

use mappa_core::Bbox;
use mappa_storage::{MbtilesMetadata, MbtilesWriter};
use serde::Serialize;

const MAX_TILES: u64 = 500_000;
const MAX_TILE_BYTES: u64 = 8 * 1024 * 1024;

/// Summary of an imported XYZ folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XyzImport {
    /// Written MBTiles path.
    pub path: PathBuf,
    /// Layer name.
    pub name: String,
    /// Tiles copied.
    pub tiles: u64,
    /// Tiles skipped because of naming or image signature.
    pub skipped: u64,
    /// Lowest zoom.
    pub min_zoom: u8,
    /// Highest zoom.
    pub max_zoom: u8,
    /// West bound.
    pub west: f64,
    /// South bound.
    pub south: f64,
    /// East bound.
    pub east: f64,
    /// North bound.
    pub north: f64,
    /// Raster format stored in metadata.
    pub format: String,
}

fn image_format(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("png");
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

fn tile_bounds(z: u8, x: u32, y: u32) -> (f64, f64, f64, f64) {
    let scale = 2_f64.powi(i32::from(z));
    let west = f64::from(x) / scale * 360.0 - 180.0;
    let east = f64::from(x + 1) / scale * 360.0 - 180.0;
    let north = (std::f64::consts::PI * (1.0 - 2.0 * f64::from(y) / scale))
        .sinh()
        .atan()
        .to_degrees();
    let south = (std::f64::consts::PI * (1.0 - 2.0 * f64::from(y + 1) / scale))
        .sinh()
        .atan()
        .to_degrees();
    (west, south, east, north)
}

fn file_stem_number(name: &str) -> Option<u32> {
    name.parse::<u32>().ok()
}

fn directory_name_number(name: &str) -> Option<u32> {
    name.parse::<u32>().ok()
}

/// Writes the folder contents into a new MBTiles file at `output`.
pub fn import_folder(
    root: &Path,
    output: &Path,
    name: Option<&str>,
    license: Option<&str>,
) -> Result<XyzImport, String> {
    let metadata = std::fs::symlink_metadata(root)
        .map_err(|error| format!("cannot read {}: {error}", root.display()))?;
    if !metadata.is_dir() {
        return Err("XYZ import expects a directory".to_owned());
    }
    if output.exists() {
        return Err(format!("refusing to overwrite {}", output.display()));
    }
    let name = name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(120).collect::<String>())
        .or_else(|| {
            root.file_name()
                .and_then(|value| value.to_str())
                .map(|value| value.chars().take(120).collect())
        })
        .unwrap_or_else(|| "XYZ import".to_owned());

    let mut entries: Vec<(u8, u32, u32, PathBuf)> = Vec::new();
    let mut skipped = 0_u64;
    let mut format: Option<&'static str> = None;
    let mut walk_error = None;
    let zooms = match std::fs::read_dir(root) {
        Ok(zooms) => zooms,
        Err(error) => {
            return Err(format!("cannot list {}: {error}", root.display()));
        }
    };
    'zoom: for zoom_entry in zooms.flatten() {
        let Some(zoom) = zoom_entry
            .file_name()
            .to_str()
            .and_then(directory_name_number)
            .and_then(|value| u8::try_from(value).ok())
            .filter(|value| *value <= 24)
        else {
            continue;
        };
        let zoom_path = zoom_entry.path();
        if !zoom_path.is_dir() {
            continue;
        }
        let Ok(columns) = std::fs::read_dir(&zoom_path) else {
            skipped += 1;
            continue;
        };
        for column_entry in columns.flatten() {
            let Some(x) = column_entry
                .file_name()
                .to_str()
                .and_then(directory_name_number)
            else {
                continue;
            };
            let column_path = column_entry.path();
            if !column_path.is_dir() {
                continue;
            }
            let Ok(rows) = std::fs::read_dir(&column_path) else {
                skipped += 1;
                continue;
            };
            for row_entry in rows.flatten() {
                let path = row_entry.path();
                let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                let stem = file_name.split('.').next().unwrap_or_default();
                let extension = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if !["png", "jpg", "jpeg", "webp"].contains(&extension.as_str()) {
                    continue;
                }
                let Some(y) = file_stem_number(stem) else {
                    skipped += 1;
                    continue;
                };
                if entries.len() as u64 >= MAX_TILES {
                    walk_error = Some(format!("more than {MAX_TILES} tiles"));
                    break 'zoom;
                }
                entries.push((zoom, x, y, path));
            }
        }
    }
    if let Some(error) = walk_error {
        return Err(error);
    }
    if entries.is_empty() {
        return Err("no z/x/y image files found".to_owned());
    }

    // Header-only pass: validate signatures and derive the pack metadata
    // before the writer is created (MBTiles metadata is not editable later).
    let mut valid: Vec<(u8, u32, u32, PathBuf)> = Vec::with_capacity(entries.len());
    let (mut west, mut south, mut east, mut north) = (180.0_f64, 90.0_f64, -180.0_f64, -90.0_f64);
    let mut min_zoom = 24_u8;
    let mut max_zoom = 0_u8;
    for (z, x, y, path) in entries {
        let info = match std::fs::symlink_metadata(&path) {
            Ok(info) if info.is_file() && info.len() <= MAX_TILE_BYTES => info,
            _ => {
                skipped += 1;
                continue;
            }
        };
        let mut header = [0_u8; 16];
        let detected = std::fs::File::open(&path)
            .and_then(|mut file| {
                use std::io::Read;
                file.read_exact(&mut header).map(|_| header)
            })
            .ok()
            .and_then(|header| image_format(&header));
        let Some(detected) = detected else {
            skipped += 1;
            continue;
        };
        if info.len() < 16 {
            skipped += 1;
            continue;
        }
        if format.is_none() {
            format = Some(detected);
        }
        min_zoom = min_zoom.min(z);
        max_zoom = max_zoom.max(z);
        let bounds = tile_bounds(z, x, y);
        west = west.min(bounds.0);
        south = south.min(bounds.1);
        east = east.max(bounds.2);
        north = north.max(bounds.3);
        valid.push((z, x, y, path));
    }
    if valid.is_empty() {
        return Err("no readable image tiles in the folder".to_owned());
    }
    let format = format.unwrap_or("png");
    let bbox = Bbox::new(west, south, east, north)
        .map_err(|error| format!("invalid XYZ coverage: {error}"))?;
    let mut metadata = MbtilesMetadata {
        name: Some(name.clone()),
        format: format.to_owned(),
        bounds: Some(bbox),
        minzoom: Some(min_zoom),
        maxzoom: Some(max_zoom),
        kind: Some("baselayer".to_owned()),
        ..MbtilesMetadata::default()
    };
    if let Some(license) = license.map(str::trim).filter(|value| !value.is_empty()) {
        metadata
            .extra
            .insert("license".to_owned(), license.chars().take(200).collect());
    }

    let temporary = output.with_extension("mbtiles.tmp");
    let result = (|| -> Result<XyzImport, String> {
        let mut writer =
            MbtilesWriter::create(&temporary, metadata).map_err(|error| error.to_string())?;
        let mut tiles = 0_u64;
        for (z, x, y, path) in &valid {
            let data = match std::fs::read(path) {
                Ok(data) => data,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            if image_format(&data).is_none() {
                skipped += 1;
                continue;
            }
            writer
                .put_tile(*z, *x, *y, &data)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            tiles += 1;
        }
        writer.finish().map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, output)
            .map_err(|error| format!("cannot publish {}: {error}", output.display()))?;
        Ok(XyzImport {
            path: output.to_path_buf(),
            name,
            tiles,
            skipped,
            min_zoom,
            max_zoom,
            west: bbox.west(),
            south: bbox.south(),
            east: bbox.east(),
            north: bbox.north(),
            format: format.to_owned(),
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, RgbImage};
    use std::io::Cursor;

    fn scratch() -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("mappa-xyz-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn png() -> Vec<u8> {
        let image = RgbImage::from_pixel(2, 2, image::Rgb([10, 20, 30]));
        let mut buffer = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut buffer, ImageFormat::Png)
            .unwrap();
        buffer.into_inner()
    }

    #[test]
    fn imports_standard_xyz_layout() {
        let dir = scratch();
        let tile = dir.join("10/618/327.png");
        std::fs::create_dir_all(tile.parent().unwrap()).unwrap();
        std::fs::write(&tile, png()).unwrap();
        let output = dir.join("import.mbtiles");
        let report = import_folder(&dir, &output, Some("Demo"), Some("ODbL")).unwrap();
        assert_eq!(report.tiles, 1);
        assert_eq!(report.min_zoom, 10);
        assert_eq!(report.max_zoom, 10);
        assert!(output.exists());
        assert!(report.west > 30.0 && report.east < 40.0);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn rejects_empty_or_foreign_folders() {
        let dir = scratch();
        let output = dir.join("out.mbtiles");
        assert!(import_folder(&dir, &output, None, None).is_err());
        let file = dir.join("10/1/2.png");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"<html>error</html>").unwrap();
        assert!(import_folder(&dir, &output, None, None).is_err());
        std::fs::remove_dir_all(dir).ok();
    }
}
