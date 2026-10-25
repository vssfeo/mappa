//! Single-band GeoTIFF/COG reader for elevation models.
//!
//! This is deliberately a DEM reader, not a general TIFF decoder. It accepts
//! classic little- or big-endian TIFF files with one 8/16/32-bit sample,
//! strips or tiles, and uncompressed, DEFLATE or PackBits blocks. GeoTIFF
//! geokeys must describe WGS84 geographic coordinates.
//!
//! The implementation avoids a TIFF dependency: the only compression needed
//! for common elevation COGs is DEFLATE, handled by `inflate.rs`. LZW, JPEG,
//! BigTIFF and multiple samples are rejected with a readable error.

use std::collections::BTreeMap;
use std::path::Path;

use crate::inflate::zlib_decompress;

const TAG_IMAGE_WIDTH: u16 = 256;
const TAG_IMAGE_LENGTH: u16 = 257;
const TAG_BITS_PER_SAMPLE: u16 = 258;
const TAG_COMPRESSION: u16 = 259;
const TAG_PHOTOMETRIC: u16 = 262;
const TAG_STRIP_OFFSETS: u16 = 273;
const TAG_ORIENTATION: u16 = 274;
const TAG_SAMPLES_PER_PIXEL: u16 = 277;
const TAG_ROWS_PER_STRIP: u16 = 278;
const TAG_STRIP_BYTE_COUNTS: u16 = 279;
const TAG_PLANAR_CONFIG: u16 = 284;
const TAG_PREDICTOR: u16 = 317;
const TAG_TILE_WIDTH: u16 = 322;
const TAG_TILE_LENGTH: u16 = 323;
const TAG_TILE_OFFSETS: u16 = 324;
const TAG_TILE_BYTE_COUNTS: u16 = 325;
const TAG_SAMPLE_FORMAT: u16 = 339;
const TAG_PIXEL_SCALE: u16 = 33550;
const TAG_TIEPOINT: u16 = 33922;
const TAG_TRANSFORMATION: u16 = 34264;
const TAG_GEOKEYS: u16 = 34735;
const TAG_NODATA: u16 = 42113;

const COMPRESSION_NONE: u32 = 1;
const COMPRESSION_DEFLATE: u32 = 8;
const COMPRESSION_DEFLATE_OLD: u32 = 32946;
const COMPRESSION_PACKBITS: u32 = 32773;

/// A decoded elevation grid with its WGS84 bounds.
pub(crate) struct Raster {
    pub ncols: usize,
    pub nrows: usize,
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
    pub cell_size: f64,
    pub elevations: Vec<f32>,
}

/// Loads and decodes a GeoTIFF from disk.
pub(crate) fn load(path: &Path, max_cells: usize) -> Result<Raster, String> {
    let data = std::fs::read(path)
        .map_err(|error| format!("cannot read {} as GeoTIFF: {error}", path.display()))?;
    parse(&data, max_cells)
}

/// Decodes an in-memory GeoTIFF. Exposed separately for unit tests.
pub(crate) fn parse(data: &[u8], max_cells: usize) -> Result<Raster, String> {
    let tiff = Tiff::new(data)?;
    let width = tiff.integer(TAG_IMAGE_WIDTH)? as usize;
    let height = tiff.integer(TAG_IMAGE_LENGTH)? as usize;
    if width == 0 || height == 0 {
        return Err("GeoTIFF has empty dimensions".to_owned());
    }
    let cells = width
        .checked_mul(height)
        .ok_or_else(|| "GeoTIFF dimensions overflow".to_owned())?;
    if cells > max_cells {
        return Err(format!("GeoTIFF is too large: {cells} cells"));
    }

    let samples = tiff.optional_integer(TAG_SAMPLES_PER_PIXEL)?.unwrap_or(1);
    if samples != 1 {
        return Err("only single-band elevation GeoTIFFs are supported".to_owned());
    }
    let planar = tiff.optional_integer(TAG_PLANAR_CONFIG)?.unwrap_or(1);
    if planar != 1 {
        return Err("planar GeoTIFF layouts are not supported".to_owned());
    }
    let photometric = tiff.optional_integer(TAG_PHOTOMETRIC)?.unwrap_or(1);
    if photometric != 1 {
        return Err("GeoTIFF is not a grayscale elevation band".to_owned());
    }
    let orientation = tiff.optional_integer(TAG_ORIENTATION)?.unwrap_or(1);
    if orientation != 1 {
        return Err("rotated or flipped GeoTIFF orientation is not supported".to_owned());
    }

    let bits = tiff
        .integers(TAG_BITS_PER_SAMPLE)?
        .ok_or_else(|| "GeoTIFF has no BitsPerSample".to_owned())?;
    let bits = *bits
        .first()
        .ok_or_else(|| "GeoTIFF has empty BitsPerSample".to_owned())?;
    if bits != 8 && bits != 16 && bits != 32 {
        return Err(format!(
            "GeoTIFF sample width {bits} is not supported (use 8, 16 or 32 bits)"
        ));
    }
    if bits % 8 != 0 {
        return Err("GeoTIFF sample width must be byte-aligned".to_owned());
    }
    let sample_format = tiff.optional_integer(TAG_SAMPLE_FORMAT)?.unwrap_or(1);
    if !matches!(sample_format, 1..=3) {
        return Err(format!(
            "GeoTIFF sample format {sample_format} is not supported"
        ));
    }
    if sample_format == 3 && bits != 32 {
        return Err("only 32-bit floating-point GeoTIFF samples are supported".to_owned());
    }
    let compression = tiff.optional_integer(TAG_COMPRESSION)?.unwrap_or(1);
    if !matches!(
        compression,
        COMPRESSION_NONE | COMPRESSION_DEFLATE | COMPRESSION_DEFLATE_OLD | COMPRESSION_PACKBITS
    ) {
        return Err(format!(
            "GeoTIFF compression {compression} is not supported; use DEFLATE, PackBits or uncompressed"
        ));
    }
    let predictor = tiff.optional_integer(TAG_PREDICTOR)?.unwrap_or(1);
    if !matches!(predictor, 1..=3) {
        return Err(format!("GeoTIFF predictor {predictor} is not supported"));
    }
    if predictor == 2 && sample_format == 3 {
        return Err("floating-point GeoTIFF uses predictor 3, not 2".to_owned());
    }
    if predictor == 3 && (sample_format != 3 || bits != 32) {
        return Err("floating-point predictor requires 32-bit float samples".to_owned());
    }

    let (west, south, east, north, cell_size) = georeference(&tiff, width, height)?;
    let nodata = tiff
        .optional_ascii(TAG_NODATA)?
        .and_then(|value| value.trim_matches(char::from(0)).trim().parse::<f64>().ok());
    let bytes_per_sample = (bits / 8) as usize;

    let layout = BlockLayout::new(&tiff, width, height)?;
    let mut elevations = vec![f32::NAN; cells];
    for (index, (offset, count)) in layout.blocks.iter().enumerate() {
        let start = *offset as usize;
        let end = start
            .checked_add(*count as usize)
            .ok_or_else(|| "GeoTIFF block range overflow".to_owned())?;
        let compressed = data
            .get(start..end)
            .ok_or_else(|| format!("GeoTIFF block {index} is outside the file"))?;
        let y0 = (index / layout.across) * layout.block_height;
        let x0 = (index % layout.across) * layout.block_width;
        let rows = if layout.tiled {
            layout.block_height
        } else {
            (height - y0).min(layout.block_height)
        };
        let expected = layout
            .block_width
            .checked_mul(rows)
            .and_then(|value| value.checked_mul(bytes_per_sample))
            .ok_or_else(|| "GeoTIFF block size overflow".to_owned())?;
        let mut raw = decompress(compression, compressed, expected)?;
        undo_predictor(
            &mut raw,
            layout.block_width,
            rows,
            bytes_per_sample,
            predictor,
            sample_format,
            tiff.endian,
        )?;

        for row in 0..rows {
            let y = y0 + row;
            if y >= height {
                break;
            }
            for col in 0..layout.block_width {
                let x = x0 + col;
                if x >= width {
                    break;
                }
                let sample_offset = (row * layout.block_width + col) * bytes_per_sample;
                let value = sample_value(
                    &raw[sample_offset..sample_offset + bytes_per_sample],
                    bits,
                    sample_format,
                    tiff.endian,
                );
                let ground = if value.is_finite()
                    && nodata.is_some_and(|void| (f64::from(value) - void).abs() <= 1e-6)
                {
                    f32::NAN
                } else {
                    value
                };
                elevations[y * width + x] = ground;
            }
        }
    }

    Ok(Raster {
        ncols: width,
        nrows: height,
        west,
        south,
        east,
        north,
        cell_size,
        elevations,
    })
}

fn decompress(compression: u32, input: &[u8], expected: usize) -> Result<Vec<u8>, String> {
    match compression {
        COMPRESSION_NONE => {
            if input.len() < expected {
                return Err(format!(
                    "GeoTIFF block has {} bytes, expected {expected}",
                    input.len()
                ));
            }
            Ok(input[..expected].to_vec())
        }
        COMPRESSION_DEFLATE | COMPRESSION_DEFLATE_OLD => {
            let output = zlib_decompress(input, expected)?;
            if output.len() != expected {
                return Err(format!(
                    "GeoTIFF DEFLATE block has {} bytes, expected {expected}",
                    output.len()
                ));
            }
            Ok(output)
        }
        COMPRESSION_PACKBITS => packbits(input, expected),
        _ => Err(format!("unsupported GeoTIFF compression {compression}")),
    }
}

fn packbits(input: &[u8], expected: usize) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(expected);
    let mut index = 0usize;
    while index < input.len() {
        let control = input[index] as i8;
        index += 1;
        if control >= 0 {
            let count = control as usize + 1;
            let end = index
                .checked_add(count)
                .ok_or_else(|| "PackBits run overflow".to_owned())?;
            let bytes = input
                .get(index..end)
                .ok_or_else(|| "truncated PackBits literal run".to_owned())?;
            if output.len() + bytes.len() > expected {
                return Err("PackBits output exceeds the block size".to_owned());
            }
            output.extend_from_slice(bytes);
            index = end;
        } else if control != -128 {
            let count = 1 - i32::from(control);
            let value = *input
                .get(index)
                .ok_or_else(|| "truncated PackBits repeat run".to_owned())?;
            index += 1;
            if output.len() + count as usize > expected {
                return Err("PackBits output exceeds the block size".to_owned());
            }
            output.extend(std::iter::repeat_n(value, count as usize));
        }
    }
    if output.len() != expected {
        return Err(format!(
            "PackBits block has {} bytes, expected {expected}",
            output.len()
        ));
    }
    Ok(output)
}

fn undo_predictor(
    bytes: &mut [u8],
    width: usize,
    height: usize,
    bytes_per_sample: usize,
    predictor: u32,
    sample_format: u32,
    endian: Endian,
) -> Result<(), String> {
    let row_bytes = width
        .checked_mul(bytes_per_sample)
        .ok_or_else(|| "GeoTIFF row size overflow".to_owned())?;
    if row_bytes == 0 || bytes.len() != row_bytes * height {
        return Err("GeoTIFF block has an unexpected byte count".to_owned());
    }
    match predictor {
        1 => Ok(()),
        2 => {
            if sample_format == 3 {
                return Err("integer predictor on floating-point samples".to_owned());
            }
            for row in bytes.chunks_exact_mut(row_bytes) {
                match bytes_per_sample {
                    1 => {
                        for index in 1..row.len() {
                            row[index] = row[index].wrapping_add(row[index - 1]);
                        }
                    }
                    2 => {
                        let mut previous = read_u16(&row[..2], endian);
                        for sample in 1..width {
                            let offset = sample * 2;
                            let current = read_u16(&row[offset..offset + 2], endian);
                            let value = current.wrapping_add(previous);
                            write_u16(&mut row[offset..offset + 2], value, endian);
                            previous = value;
                        }
                    }
                    4 => {
                        let mut previous = read_u32(&row[..4], endian);
                        for sample in 1..width {
                            let offset = sample * 4;
                            let current = read_u32(&row[offset..offset + 4], endian);
                            let value = current.wrapping_add(previous);
                            write_u32(&mut row[offset..offset + 4], value, endian);
                            previous = value;
                        }
                    }
                    _ => return Err("unsupported predictor sample width".to_owned()),
                }
            }
            Ok(())
        }
        3 => {
            if sample_format != 3 || bytes_per_sample != 4 {
                return Err("floating-point predictor requires 32-bit floats".to_owned());
            }
            for row in bytes.chunks_exact_mut(row_bytes) {
                for index in 1..row.len() {
                    row[index] = row[index].wrapping_add(row[index - 1]);
                }
                let split = row.to_vec();
                for sample in 0..width {
                    let bits = (u32::from(split[sample]) << 24)
                        | (u32::from(split[width + sample]) << 16)
                        | (u32::from(split[2 * width + sample]) << 8)
                        | u32::from(split[3 * width + sample]);
                    let value = f32::from_bits(bits);
                    let offset = sample * 4;
                    write_u32(&mut row[offset..offset + 4], value.to_bits(), endian);
                }
            }
            Ok(())
        }
        _ => Err(format!("unsupported GeoTIFF predictor {predictor}")),
    }
}

fn sample_value(bytes: &[u8], bits: u32, sample_format: u32, endian: Endian) -> f32 {
    match (sample_format, bits) {
        (1, 8) => f32::from(bytes[0]),
        (2, 8) => f32::from(bytes[0] as i8),
        (1, 16) => f32::from(read_u16(bytes, endian)),
        (2, 16) => f32::from(read_u16(bytes, endian) as i16),
        (1, 32) => read_u32(bytes, endian) as f32,
        (2, 32) => read_u32(bytes, endian) as i32 as f32,
        (3, 32) => f32::from_bits(read_u32(bytes, endian)),
        _ => f32::NAN,
    }
}

fn georeference(
    tiff: &Tiff<'_>,
    width: usize,
    height: usize,
) -> Result<(f64, f64, f64, f64, f64), String> {
    let (pixel_is_point, model_type, geographic_type) = tiff.geo_keys()?;
    if let Some(model_type) = model_type
        && model_type != 2
    {
        return Err("GeoTIFF is not in a geographic (latitude/longitude) CRS".to_owned());
    }
    if let Some(geographic_type) = geographic_type
        && geographic_type != 4326
    {
        return Err("GeoTIFF CRS is not WGS84 (EPSG:4326)".to_owned());
    }

    let (west, north, cell_x, cell_y) = if let Some(matrix) = tiff.floats(TAG_TRANSFORMATION)? {
        if matrix.len() < 16 {
            return Err("GeoTIFF transformation matrix is incomplete".to_owned());
        }
        if matrix[1].abs() > 1e-12 || matrix[4].abs() > 1e-12 {
            return Err("rotated GeoTIFF transforms are not supported".to_owned());
        }
        if !(matrix[0] > 0.0 && matrix[5] < 0.0) {
            return Err("GeoTIFF transform has unsupported axis directions".to_owned());
        }
        (matrix[3], matrix[7], matrix[0], -matrix[5])
    } else {
        let scale = tiff
            .floats(TAG_PIXEL_SCALE)?
            .ok_or_else(|| "GeoTIFF has no ModelPixelScale".to_owned())?;
        let tiepoint = tiff
            .floats(TAG_TIEPOINT)?
            .ok_or_else(|| "GeoTIFF has no ModelTiepoint".to_owned())?;
        if scale.len() < 2 || tiepoint.len() < 6 {
            return Err("GeoTIFF georeferencing tags are incomplete".to_owned());
        }
        if !(scale[0] > 0.0 && scale[1] > 0.0) {
            return Err("GeoTIFF pixel scale must be positive".to_owned());
        }
        (
            tiepoint[3] - tiepoint[0] * scale[0],
            tiepoint[4] + tiepoint[1] * scale[1],
            scale[0],
            scale[1],
        )
    };

    let (west, north) = if pixel_is_point {
        (west - cell_x / 2.0, north + cell_y / 2.0)
    } else {
        (west, north)
    };
    let east = west + cell_x * width as f64;
    let south = north - cell_y * height as f64;
    if !west.is_finite()
        || !south.is_finite()
        || !east.is_finite()
        || !north.is_finite()
        || west < -180.0
        || east > 180.0
        || south < -90.0
        || north > 90.0
    {
        return Err("GeoTIFF bounds are outside WGS84".to_owned());
    }
    Ok((west, south, east, north, cell_x))
}

struct BlockLayout {
    across: usize,
    block_width: usize,
    block_height: usize,
    tiled: bool,
    blocks: Vec<(u32, u32)>,
}

impl BlockLayout {
    fn new(tiff: &Tiff<'_>, width: usize, height: usize) -> Result<Self, String> {
        let tiled = tiff.optional_integer(TAG_TILE_WIDTH)?.is_some()
            || tiff.optional_integer(TAG_TILE_OFFSETS)?.is_some();
        if tiled {
            let tile_width = tiff.integer(TAG_TILE_WIDTH)? as usize;
            let tile_height = tiff.integer(TAG_TILE_LENGTH)? as usize;
            if tile_width == 0 || tile_height == 0 {
                return Err("GeoTIFF has empty tile dimensions".to_owned());
            }
            let across = width.div_ceil(tile_width);
            let down = height.div_ceil(tile_height);
            let blocks = tiff.blocks(TAG_TILE_OFFSETS, TAG_TILE_BYTE_COUNTS)?;
            if blocks.len() < across * down {
                return Err("GeoTIFF has fewer tiles than its dimensions require".to_owned());
            }
            Ok(Self {
                across,
                block_width: tile_width,
                block_height: tile_height,
                tiled: true,
                blocks: blocks[..across * down].to_vec(),
            })
        } else {
            let rows_per_strip = tiff
                .optional_integer(TAG_ROWS_PER_STRIP)?
                .unwrap_or(height as u32)
                .max(1) as usize;
            let across = 1usize;
            let down = height.div_ceil(rows_per_strip);
            let blocks = tiff.blocks(TAG_STRIP_OFFSETS, TAG_STRIP_BYTE_COUNTS)?;
            if blocks.len() < down {
                return Err("GeoTIFF has fewer strips than its dimensions require".to_owned());
            }
            let block_height = rows_per_strip.min(height);
            Ok(Self {
                across,
                block_width: width,
                block_height,
                tiled: false,
                blocks: blocks[..down].to_vec(),
            })
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Endian {
    Little,
    Big,
}

impl Endian {
    fn u16(self, bytes: &[u8]) -> u16 {
        match self {
            Self::Little => u16::from_le_bytes([bytes[0], bytes[1]]),
            Self::Big => u16::from_be_bytes([bytes[0], bytes[1]]),
        }
    }

    fn u32(self, bytes: &[u8]) -> u32 {
        match self {
            Self::Little => u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            Self::Big => u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        }
    }
}

fn read_u16(bytes: &[u8], endian: Endian) -> u16 {
    endian.u16(bytes)
}

fn read_u32(bytes: &[u8], endian: Endian) -> u32 {
    endian.u32(bytes)
}

fn write_u16(bytes: &mut [u8], value: u16, endian: Endian) {
    let data = match endian {
        Endian::Little => value.to_le_bytes(),
        Endian::Big => value.to_be_bytes(),
    };
    bytes.copy_from_slice(&data);
}

fn write_u32(bytes: &mut [u8], value: u32, endian: Endian) {
    let data = match endian {
        Endian::Little => value.to_le_bytes(),
        Endian::Big => value.to_be_bytes(),
    };
    bytes.copy_from_slice(&data);
}

#[derive(Clone, Copy)]
struct Entry {
    kind: u16,
    count: usize,
    offset: usize,
}

struct Tiff<'a> {
    data: &'a [u8],
    endian: Endian,
    entries: BTreeMap<u16, Entry>,
}

impl<'a> Tiff<'a> {
    fn new(data: &'a [u8]) -> Result<Self, String> {
        if data.len() < 8 {
            return Err("GeoTIFF header is truncated".to_owned());
        }
        let endian = match &data[..2] {
            b"II" => Endian::Little,
            b"MM" => Endian::Big,
            _ => return Err("not a TIFF file".to_owned()),
        };
        let magic = endian.u16(&data[2..4]);
        if magic == 43 {
            return Err("BigTIFF is not supported; save a classic GeoTIFF".to_owned());
        }
        if magic != 42 {
            return Err("invalid TIFF magic".to_owned());
        }
        let ifd = endian.u32(&data[4..8]) as usize;
        if ifd < 8 {
            return Err("TIFF directory offset is invalid".to_owned());
        }
        let count_offset = ifd
            .checked_add(2)
            .ok_or_else(|| "TIFF directory offset overflow".to_owned())?;
        let count = endian.u16(
            data.get(ifd..count_offset)
                .ok_or_else(|| "TIFF directory is outside the file".to_owned())?,
        ) as usize;
        let entries_end = count_offset
            .checked_add(count * 12)
            .ok_or_else(|| "TIFF directory size overflow".to_owned())?;
        if entries_end > data.len() {
            return Err("TIFF directory is truncated".to_owned());
        }
        let mut entries = BTreeMap::new();
        for index in 0..count {
            let offset = count_offset + index * 12;
            let entry = &data[offset..offset + 12];
            let tag = endian.u16(&entry[..2]);
            let kind = endian.u16(&entry[2..4]);
            let count = endian.u32(&entry[4..8]) as usize;
            let Some(size) = type_size(kind) else {
                continue;
            };
            let bytes = count
                .checked_mul(size)
                .ok_or_else(|| "TIFF tag size overflow".to_owned())?;
            let field = if bytes <= 4 {
                offset + 8
            } else {
                endian.u32(&entry[8..12]) as usize
            };
            let end = field
                .checked_add(bytes)
                .ok_or_else(|| "TIFF tag range overflow".to_owned())?;
            if end > data.len() {
                return Err(format!("TIFF tag {tag} points outside the file"));
            }
            entries.insert(
                tag,
                Entry {
                    kind,
                    count,
                    offset: field,
                },
            );
        }
        Ok(Self {
            data,
            endian,
            entries,
        })
    }

    fn entry(&self, tag: u16) -> Option<&Entry> {
        self.entries.get(&tag)
    }

    fn slice(&self, entry: &Entry) -> &'a [u8] {
        &self.data[entry.offset..entry.offset + entry.count * type_size(entry.kind).unwrap_or(0)]
    }

    fn integers(&self, tag: u16) -> Result<Option<Vec<u32>>, String> {
        let Some(entry) = self.entry(tag) else {
            return Ok(None);
        };
        let slice = self.slice(entry);
        let mut values = Vec::with_capacity(entry.count);
        match entry.kind {
            1 | 7 => values.extend(slice.iter().map(|value| u32::from(*value))),
            3 => {
                for pair in slice.as_chunks::<2>().0 {
                    values.push(u32::from(self.endian.u16(pair)));
                }
            }
            4 => {
                for word in slice.as_chunks::<4>().0 {
                    values.push(self.endian.u32(word));
                }
            }
            _ => return Err(format!("TIFF tag {tag} is not an integer array")),
        }
        Ok(Some(values))
    }

    fn integer(&self, tag: u16) -> Result<u32, String> {
        self.integers(tag)?
            .and_then(|values| values.first().copied())
            .ok_or_else(|| format!("GeoTIFF has no required tag {tag}"))
    }

    fn optional_integer(&self, tag: u16) -> Result<Option<u32>, String> {
        Ok(self
            .integers(tag)?
            .and_then(|values| values.first().copied()))
    }

    fn floats(&self, tag: u16) -> Result<Option<Vec<f64>>, String> {
        let Some(entry) = self.entry(tag) else {
            return Ok(None);
        };
        let slice = self.slice(entry);
        let mut values = Vec::with_capacity(entry.count);
        match entry.kind {
            11 => {
                for word in slice.as_chunks::<4>().0 {
                    values.push(f64::from(f32::from_bits(self.endian.u32(word))));
                }
            }
            12 => {
                for word in slice.as_chunks::<8>().0 {
                    let bits = match self.endian {
                        Endian::Little => u64::from_le_bytes(*word),
                        Endian::Big => u64::from_be_bytes(*word),
                    };
                    values.push(f64::from_bits(bits));
                }
            }
            _ => return Err(format!("TIFF tag {tag} is not a floating-point array")),
        }
        Ok(Some(values))
    }

    fn optional_ascii(&self, tag: u16) -> Result<Option<String>, String> {
        let Some(entry) = self.entry(tag) else {
            return Ok(None);
        };
        if entry.kind != 2 {
            return Err(format!("TIFF tag {tag} is not ASCII"));
        }
        let slice = self.slice(entry);
        let end = slice
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(slice.len());
        Ok(Some(String::from_utf8_lossy(&slice[..end]).into_owned()))
    }

    fn blocks(&self, offsets_tag: u16, counts_tag: u16) -> Result<Vec<(u32, u32)>, String> {
        let offsets = self
            .integers(offsets_tag)?
            .ok_or_else(|| "GeoTIFF has no data block offsets".to_owned())?;
        let counts = self
            .integers(counts_tag)?
            .ok_or_else(|| "GeoTIFF has no data block byte counts".to_owned())?;
        if offsets.len() != counts.len() {
            return Err("GeoTIFF block offsets and byte counts differ in length".to_owned());
        }
        Ok(offsets.into_iter().zip(counts).collect())
    }

    fn geo_keys(&self) -> Result<(bool, Option<u32>, Option<u32>), String> {
        let Some(keys) = self.integers(TAG_GEOKEYS)? else {
            return Ok((false, None, None));
        };
        if keys.len() < 4 {
            return Err("GeoTIFF geokey directory is truncated".to_owned());
        }
        let count = keys[3] as usize;
        if keys.len() < 4 + count * 4 {
            return Err("GeoTIFF geokey directory is incomplete".to_owned());
        }
        let mut pixel_is_point = false;
        let mut model_type = None;
        let mut geographic_type = None;
        for index in 0..count {
            let base = 4 + index * 4;
            let key = keys[base];
            let value = keys[base + 3];
            match key {
                1024 => model_type = Some(value),
                1025 => pixel_is_point = value == 2,
                2048 => geographic_type = Some(value),
                3072 => {
                    return Err("projected GeoTIFF CRS is not supported".to_owned());
                }
                _ => {}
            }
        }
        Ok((pixel_is_point, model_type, geographic_type))
    }
}

fn type_size(kind: u16) -> Option<usize> {
    match kind {
        1 | 2 | 6 | 7 => Some(1),
        3 | 8 => Some(2),
        4 | 9 | 11 => Some(4),
        5 | 10 | 12 => Some(8),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    fn assert_grid(raster: &Raster, expected: &[[f32; 4]; 4]) {
        assert_eq!(raster.ncols, 4);
        assert_eq!(raster.nrows, 4);
        assert!((raster.west - 37.0).abs() < 1e-9);
        assert!((raster.south - 55.96).abs() < 1e-9);
        assert!((raster.east - 37.04).abs() < 1e-9);
        assert!((raster.north - 56.0).abs() < 1e-9);
        assert!((raster.cell_size - 0.01).abs() < 1e-12);
        for (row, values) in expected.iter().enumerate() {
            for (col, value) in values.iter().enumerate() {
                let actual = raster.elevations[row * 4 + col];
                assert!(
                    (actual - value).abs() < 1e-5,
                    "cell {row},{col}: {actual} != {value}"
                );
            }
        }
    }

    #[test]
    fn reads_uncompressed_striped_geotiff() {
        let data = hex(
            "49492a0008000000100000010400010000000400000001010400010000000400000002010300010000001000000003010300010000000100000006010300010000000100000011010400010000003c0100001501030001000000010000001601030001000000040000001701040001000000200000001c01030001000000010000003d01030001000000010000005301030001000000020000000e830c0003000000ce00000082840c0006000000e6000000af870300100000001601000081a402000600000036010000000000007b14ae47e17a843f7b14ae47e17a843f000000000000000000000000000000000000000000000000000000000000000000000000008042400000000000004c400000000000000000010001000000030000040000010002000104000001000100000800000100e6102d39393939006400650066006700c800c900ca00cb002c012d012e012f019001910192019301",
        );
        let raster = parse(&data, 1024).unwrap();
        assert_grid(
            &raster,
            &[
                [100.0, 101.0, 102.0, 103.0],
                [200.0, 201.0, 202.0, 203.0],
                [300.0, 301.0, 302.0, 303.0],
                [400.0, 401.0, 402.0, 403.0],
            ],
        );
    }

    #[test]
    fn reads_big_endian_striped_geotiff() {
        let data = hex(
            "4d4d002a00000008001001000004000000010000000401010004000000010000000401020003000000010010000001030003000000010001000001060003000000010001000001110004000000010000013c011500030000000100010000011600030000000100040000011700040000000100000020011c00030000000100010000013d00030000000100010000015300030000000100020000830e000c00000003000000ce8482000c00000006000000e687af00030000001000000116a48100020000000600000136000000003f847ae147ae147b3f847ae147ae147b00000000000000000000000000000000000000000000000000000000000000004042800000000000404c000000000000000000000000000000010001000000030400000000010002040100000001000108000000000110e62d3939393900006400650066006700c800c900ca00cb012c012d012e012f0190019101920193",
        );
        let raster = parse(&data, 1024).unwrap();
        assert_grid(
            &raster,
            &[
                [100.0, 101.0, 102.0, 103.0],
                [200.0, 201.0, 202.0, 203.0],
                [300.0, 301.0, 302.0, 303.0],
                [400.0, 401.0, 402.0, 403.0],
            ],
        );
    }

    #[test]
    fn reads_tiled_deflate_and_integer_predictor() {
        let data = hex(
            "49492a000800000011000001040001000000040000000101040001000000040000000201030001000000100000000301030001000000080000000601030001000000010000001501030001000000010000001c01030001000000010000003d01030001000000020000004201030001000000020000004301030001000000020000004401040004000000da0000004501040004000000ea0000005301030001000000020000000e830c0003000000fa00000082840c000600000012010000af870300100000004201000081a40200060000006201000000000000680100007601000084010000920100000e0000000e0000000e0000000e0000007b14ae47e17a843f7b14ae47e17a843f000000000000000000000000000000000000000000000000000000000000000000000000008042400000000000004c400000000000000000010001000000030000040000010002000104000001000100000800000100e6102d393939390078da4b6160643801c4000650012f78da4b6360643805c4000668013378dad36164649800c40003ba00c178dad36364649804c40003d200c5",
        );
        let raster = parse(&data, 1024).unwrap();
        assert_grid(
            &raster,
            &[
                [100.0, 101.0, 102.0, 103.0],
                [200.0, 201.0, 202.0, 203.0],
                [300.0, 301.0, 302.0, 303.0],
                [400.0, 401.0, 402.0, 403.0],
            ],
        );
    }

    #[test]
    fn reads_tiled_deflate_and_float_predictor() {
        let data = hex(
            "49492a000800000011000001040001000000040000000101040001000000040000000201030001000000200000000301030001000000080000000601030001000000010000001501030001000000010000001c01030001000000010000003d01030001000000030000004201030001000000020000004301030001000000020000004401040004000000da0000004501040004000000ea0000005301030001000000030000000e830c0003000000fa00000082840c000600000012010000af870300100000004201000081a40200060000006201000000000000680100008001000098010000ae010000180000001800000016000000160000007b14ae47e17a843f7b14ae47e17a843f000000000000000000000000000000000000000000000000000000000000000000000000008042400000000000004c400000000000000000010001000000030000040000010002000104000001000100000800000100e6102d393939390078da736268673265606070666065346768600000123f020178da7362e8663264606070666067346568600000124b020178da7366086658d5e0c0e0ccd0ca5001a40121d8040178da7366086158d9e0c0e0ccd0c6500ea40121dc0401",
        );
        let raster = parse(&data, 1024).unwrap();
        assert_grid(
            &raster,
            &[
                [100.5, 101.5, 102.5, 103.5],
                [200.5, 201.5, 202.5, 203.5],
                [300.5, 301.5, 302.5, 303.5],
                [400.5, 401.5, 402.5, 403.5],
            ],
        );
    }

    #[test]
    fn expands_packbits_runs() {
        let packed = [0x02, 1, 2, 3, 0xfc, 9];
        assert_eq!(packbits(&packed, 8).unwrap(), [1, 2, 3, 9, 9, 9, 9, 9]);
    }
}
