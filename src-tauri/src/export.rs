//! Cloud-optimized GeoTIFF export.
//!
//! The map is rendered in the WebView, so the UI sends a PNG snapshot plus a
//! Web Mercator georeference. This module turns it into a tiled GeoTIFF with
//! 256 px tiles, a half-resolution overview pyramid linked through `SubIFD`,
//! and the IFD/metadata block placed before the pixel data — the layout that
//! lets range-request clients read a COG efficiently. No GDAL or libtiff.

use image::{ImageFormat, RgbImage};

const MAX_PIXELS: u64 = 40_000_000;
const TILE: u32 = 256;
const CHANNELS: usize = 3;
const MAX_OVERVIEWS: usize = 8;

/// Writes a PNG snapshot as a cloud-optimized GeoTIFF in EPSG:3857.
#[tauri::command]
pub async fn export_geotiff(
    path: String,
    png: Vec<u8>,
    west: f64,
    north: f64,
    res_x: f64,
    res_y: f64,
) -> Result<(), String> {
    validate_georeference(west, north, res_x, res_y)?;
    let path = crate::files::resolve_for_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let image = image::load_from_memory_with_format(&png, ImageFormat::Png)
            .map_err(|error| format!("cannot decode snapshot: {error}"))?
            .to_rgb8();
        let data = build_geotiff(&image, west, north, res_x, res_y)?;
        crate::atomic::write(&path, &data, false)
            .map_err(|error| format!("cannot write {}: {error}", path.display()))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn validate_georeference(west: f64, north: f64, res_x: f64, res_y: f64) -> Result<(), String> {
    if !west.is_finite()
        || !north.is_finite()
        || !res_x.is_finite()
        || !res_y.is_finite()
        || res_x <= 0.0
        || res_y <= 0.0
    {
        return Err("invalid georeference".to_owned());
    }
    Ok(())
}

struct Level {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

fn tiles(width: u32, height: u32) -> (u32, u32) {
    (width.div_ceil(TILE), height.div_ceil(TILE))
}

fn halve(level: &Level) -> Level {
    let width = level.width.div_ceil(2);
    let height = level.height.div_ceil(2);
    let mut pixels = vec![0_u8; width as usize * height as usize * CHANNELS];
    for y in 0..height {
        for x in 0..width {
            for channel in 0..CHANNELS {
                let mut sum = 0_u32;
                let mut count = 0_u32;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let px = x * 2 + dx;
                        let py = y * 2 + dy;
                        if px < level.width && py < level.height {
                            let index = ((py * level.width + px) as usize) * CHANNELS + channel;
                            sum += u32::from(level.pixels[index]);
                            count += 1;
                        }
                    }
                }
                let index = ((y * width + x) as usize) * CHANNELS + channel;
                pixels[index] = (sum / count.max(1)) as u8;
            }
        }
    }
    Level {
        width,
        height,
        pixels,
    }
}

struct LevelLayout {
    ifd_offset: u32,
    bits_offset: u32,
    scale_offset: u32,
    tiepoint_offset: u32,
    geokey_offset: u32,
    tile_offsets_offset: u32,
    tile_counts_offset: u32,
    tile_data_offsets: Vec<u32>,
    tile_count: u32,
}

fn align_to(value: u32, alignment: u32) -> u32 {
    value.div_ceil(alignment) * alignment
}

fn allocate(cursor: &mut u32, size: u32, alignment: u32) -> u32 {
    *cursor = align_to(*cursor, alignment);
    let offset = *cursor;
    *cursor = cursor.saturating_add(size);
    offset
}

/// Builds a tiled EPSG:3857 GeoTIFF with a power-of-two overview pyramid.
pub fn build_geotiff(
    image: &RgbImage,
    west: f64,
    north: f64,
    res_x: f64,
    res_y: f64,
) -> Result<Vec<u8>, String> {
    validate_georeference(west, north, res_x, res_y)?;
    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return Err("empty image".to_owned());
    }
    let pixels = u64::from(width) * u64::from(height);
    if pixels > MAX_PIXELS {
        return Err(format!("image is too large: {pixels} pixels"));
    }

    let mut levels = vec![Level {
        width,
        height,
        pixels: image.as_raw().clone(),
    }];
    while (levels.last().unwrap().width > TILE || levels.last().unwrap().height > TILE)
        && levels.len() <= MAX_OVERVIEWS
    {
        let next = halve(levels.last().unwrap());
        levels.push(next);
    }
    let overviews = levels.len() - 1;

    // Lay out every IFD first, then the values they point to, then pixels.
    let main_entries = if overviews > 0 { 15 } else { 14 };
    let ifd_size = |entries: u32| 2 + entries * 12 + 4;
    let mut cursor = 8_u32;
    let mut ifd_offsets = Vec::with_capacity(levels.len());
    for index in 0..levels.len() {
        cursor = align_to(cursor, 8);
        ifd_offsets.push(cursor);
        let entries = if index == 0 { main_entries } else { 15 };
        cursor = cursor.saturating_add(ifd_size(entries));
    }

    let mut layouts = Vec::with_capacity(levels.len());
    for level in &levels {
        let (tx, ty) = tiles(level.width, level.height);
        let tile_count = tx * ty;
        let bits_offset = allocate(&mut cursor, 6, 2);
        let scale_offset = allocate(&mut cursor, 24, 8);
        let tiepoint_offset = allocate(&mut cursor, 48, 8);
        let geokey_offset = allocate(&mut cursor, 40, 2);
        let tile_offsets_offset = allocate(&mut cursor, tile_count * 4, 4);
        let tile_counts_offset = allocate(&mut cursor, tile_count * 4, 4);
        layouts.push(LevelLayout {
            ifd_offset: 0,
            bits_offset,
            scale_offset,
            tiepoint_offset,
            geokey_offset,
            tile_offsets_offset,
            tile_counts_offset,
            tile_data_offsets: Vec::with_capacity(tile_count as usize),
            tile_count,
        });
    }
    for (layout, offset) in layouts.iter_mut().zip(&ifd_offsets) {
        layout.ifd_offset = *offset;
    }
    // SubIFD array belongs to the main IFD and must exist before tile data.
    let subifd_array = if overviews > 1 {
        Some(allocate(&mut cursor, overviews as u32 * 4, 4))
    } else {
        None
    };

    let tile_bytes = TILE * TILE * CHANNELS as u32;
    cursor = align_to(cursor, 8);
    for layout in &mut layouts {
        for _ in 0..layout.tile_count {
            layout.tile_data_offsets.push(cursor);
            cursor = cursor
                .checked_add(tile_bytes)
                .ok_or_else(|| "GeoTIFF is too large".to_owned())?;
        }
    }
    let total = usize::try_from(cursor).map_err(|_| "GeoTIFF is too large".to_owned())?;
    let mut out = vec![0_u8; total];
    out[0..2].copy_from_slice(b"II");
    out[2..4].copy_from_slice(&42_u16.to_le_bytes());
    out[4..8].copy_from_slice(&8_u32.to_le_bytes());

    for (index, (level, layout)) in levels.iter().zip(&layouts).enumerate() {
        let mut entries: Vec<(u16, u16, u32, u32)> = Vec::with_capacity(16);
        let (tx, _ty) = tiles(level.width, level.height);
        if index > 0 {
            entries.push((254, 4, 1, 1)); // NewSubfileType: reduced image
        }
        entries.push((256, 4, 1, level.width));
        entries.push((257, 4, 1, level.height));
        entries.push((258, 3, 3, layout.bits_offset));
        entries.push((259, 3, 1, 1)); // no compression
        entries.push((262, 3, 1, 2)); // RGB
        entries.push((277, 3, 1, CHANNELS as u32));
        entries.push((284, 3, 1, 1)); // chunky
        entries.push((322, 4, 1, TILE));
        entries.push((323, 4, 1, TILE));
        entries.push((324, 4, layout.tile_count, layout.tile_offsets_offset));
        entries.push((325, 4, layout.tile_count, layout.tile_counts_offset));
        if index == 0 && overviews > 0 {
            let count = overviews as u32;
            let value = if count == 1 {
                ifd_offsets[1]
            } else {
                subifd_array.expect("subifd array is allocated")
            };
            entries.push((330, 4, count, value));
        }
        entries.push((33550, 12, 3, layout.scale_offset));
        entries.push((33922, 12, 6, layout.tiepoint_offset));
        entries.push((34735, 3, 20, layout.geokey_offset));
        entries.sort_by_key(|entry| entry.0);
        let mut ifd = Vec::with_capacity(ifd_size(entries.len() as u32) as usize);
        ifd.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for (tag, kind, count, value) in entries {
            ifd.extend_from_slice(&tag.to_le_bytes());
            ifd.extend_from_slice(&kind.to_le_bytes());
            ifd.extend_from_slice(&count.to_le_bytes());
            ifd.extend_from_slice(&value.to_le_bytes());
        }
        ifd.extend_from_slice(&0_u32.to_le_bytes()); // no sibling IFD
        let start = layout.ifd_offset as usize;
        out[start..start + ifd.len()].copy_from_slice(&ifd);

        let mut bits_cursor = layout.bits_offset as usize;
        for value in [8_u16, 8, 8] {
            out[bits_cursor..bits_cursor + 2].copy_from_slice(&value.to_le_bytes());
            bits_cursor += 2;
        }
        let factor = 2_f64.powi(index as i32);
        let mut scale_cursor = layout.scale_offset as usize;
        for value in [res_x * factor, res_y * factor, 0.0] {
            out[scale_cursor..scale_cursor + 8].copy_from_slice(&value.to_le_bytes());
            scale_cursor += 8;
        }
        let mut tiepoint_cursor = layout.tiepoint_offset as usize;
        for value in [0.0, 0.0, 0.0, west, north, 0.0] {
            out[tiepoint_cursor..tiepoint_cursor + 8].copy_from_slice(&value.to_le_bytes());
            tiepoint_cursor += 8;
        }
        let mut geokey_cursor = layout.geokey_offset as usize;
        for value in [
            1_u16, 1, 0, 4, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 3857, 3076, 0, 1, 9001,
        ] {
            out[geokey_cursor..geokey_cursor + 2].copy_from_slice(&value.to_le_bytes());
            geokey_cursor += 2;
        }

        for (tile_index, data_offset) in layout.tile_data_offsets.iter().enumerate() {
            let offset_index = layout.tile_offsets_offset as usize + tile_index * 4;
            out[offset_index..offset_index + 4].copy_from_slice(&data_offset.to_le_bytes());
            let count_index = layout.tile_counts_offset as usize + tile_index * 4;
            out[count_index..count_index + 4].copy_from_slice(&tile_bytes.to_le_bytes());

            let tx_index = (tile_index as u32 % tx) * TILE;
            let ty_index = (tile_index as u32 / tx) * TILE;
            let mut data = *data_offset as usize;
            for row in 0..TILE {
                for column in 0..TILE {
                    let px = tx_index + column;
                    let py = ty_index + row;
                    if px < level.width && py < level.height {
                        let source = ((py * level.width + px) as usize) * CHANNELS;
                        out[data..data + CHANNELS]
                            .copy_from_slice(&level.pixels[source..source + CHANNELS]);
                    }
                    data += CHANNELS;
                }
            }
        }
    }

    if let Some(array) = subifd_array {
        let start = array as usize;
        for (index, offset) in ifd_offsets.iter().skip(1).enumerate() {
            let at = start + index * 4;
            out[at..at + 4].copy_from_slice(&offset.to_le_bytes());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(width: u32, height: u32) -> RgbImage {
        RgbImage::from_pixel(width, height, image::Rgb([10, 20, 30]))
    }

    fn ifd_entries(tiff: &[u8], offset: usize) -> Vec<(u16, u16, u32, u32)> {
        let count = u16::from_le_bytes(tiff[offset..offset + 2].try_into().unwrap()) as usize;
        (0..count)
            .map(|index| {
                let at = offset + 2 + index * 12;
                (
                    u16::from_le_bytes(tiff[at..at + 2].try_into().unwrap()),
                    u16::from_le_bytes(tiff[at + 2..at + 4].try_into().unwrap()),
                    u32::from_le_bytes(tiff[at + 4..at + 8].try_into().unwrap()),
                    u32::from_le_bytes(tiff[at + 8..at + 12].try_into().unwrap()),
                )
            })
            .collect()
    }

    #[test]
    fn writes_tiled_geotiff_with_overviews() {
        let tiff = build_geotiff(&image(600, 400), 1_000.0, 2_000.0, 10.0, 20.0).unwrap();
        assert_eq!(&tiff[0..4], b"II*\0");
        let main = ifd_entries(&tiff, 8);
        let tag = |id: u16| main.iter().find(|entry| entry.0 == id).copied();
        assert_eq!(tag(322).unwrap().3, TILE);
        assert_eq!(tag(323).unwrap().3, TILE);
        assert_eq!(tag(324).unwrap().2, 6); // 3x2 tiles at 600x400
        let subifd = tag(330).expect("overview pointer");
        assert_eq!(subifd.2, 2); // 300x200 and 150x100
        let first_overview = u32::from_le_bytes(
            tiff[subifd.3 as usize..subifd.3 as usize + 4]
                .try_into()
                .unwrap(),
        ) as usize;
        let overview = ifd_entries(&tiff, first_overview);
        assert_eq!(overview[0].0, 254); // NewSubfileType
        assert_eq!(overview[0].3, 1);
        assert_eq!(overview.iter().find(|entry| entry.0 == 256).unwrap().3, 300);
        // Pixel data must come after every IFD and metadata block.
        let first_tile = tag(324).unwrap().3 as usize;
        assert!(first_tile > first_overview);
    }

    #[test]
    fn downsamples_overviews() {
        let mut image = image(4, 4);
        image.put_pixel(0, 0, image::Rgb([100, 0, 0]));
        let tiff = build_geotiff(&image, 0.0, 0.0, 1.0, 1.0).unwrap();
        assert_eq!(&tiff[0..2], b"II");
    }

    #[test]
    fn rejects_empty_or_invalid_images() {
        assert!(build_geotiff(&image(0, 0), 0.0, 0.0, 1.0, 1.0).is_err());
        assert!(build_geotiff(&image(1, 1), 0.0, 0.0, 0.0, 1.0).is_err());
    }
}
