//! Local digital elevation models rendered as MapLibre terrain tiles.
//!
//! Three open, tool-friendly formats are accepted without GDAL:
//!
//! * SRTM `.hgt` — 3601² (1″) or 1201² (3″) big-endian `i16`, named
//!   `N55E037.hgt`;
//! * ESRI ASCII Grid `.asc` — header plus row-major elevations;
//! * GeoTIFF/COG `.tif` or `.tiff` — single-band elevation in WGS84 with
//!   strips or tiles, uncompressed or DEFLATE/PackBits compressed.
//!
//! The DEM stays in memory. MapLibre requests `mappa://dem/<id>/z/x/y`;
//! Rust samples it bilinearly and returns a Mapbox terrain-RGB PNG, so
//! hillshade, 3D terrain and point elevation all share one source.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Arc;

use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder, RgbImage};
use serde::Serialize;
use tauri::State;
use tokio::sync::RwLock;

use crate::state::AppState;

const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CELLS: usize = 40_000_000;
const TILE_SIZE: u32 = 256;
const HGT_VOID: i16 = -32768;

/// Metadata returned after a DEM has been opened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DemInfo {
    /// Stable id for the `mappa://dem/<id>/…` URL template.
    pub id: String,
    /// File stem shown in the UI.
    pub name: String,
    /// Absolute path.
    pub path: String,
    /// `hgt`, `asc` or `tif`.
    pub format: String,
    /// West bound in WGS84.
    pub west: f64,
    /// South bound in WGS84.
    pub south: f64,
    /// East bound in WGS84.
    pub east: f64,
    /// North bound in WGS84.
    pub north: f64,
    /// Columns in the source grid.
    pub ncols: usize,
    /// Rows in the source grid.
    pub nrows: usize,
    /// Source cell size in degrees.
    pub cell_size: f64,
    /// Approximate ground resolution at the centre latitude.
    pub resolution_meters: f64,
    /// Lowest valid elevation.
    pub min_elevation: f64,
    /// Highest valid elevation.
    pub max_elevation: f64,
    /// Highest zoom worth requesting from the source.
    pub max_zoom: u8,
}

/// Elevation, slope and aspect at one point.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DemSample {
    /// DEM id, so a stale UI response can be ignored.
    pub id: String,
    /// Elevation in metres.
    pub elevation: f64,
    /// Slope in degrees.
    pub slope: f64,
    /// Downslope azimuth in degrees clockwise from north.
    pub aspect: f64,
}

/// One contour polyline and its elevation level.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContourLine {
    pub level: f64,
    pub coordinates: Vec<[f64; 2]>,
}

/// Contours generated from the active DEM grid.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContourResult {
    pub interval: f64,
    pub levels: usize,
    pub lines: Vec<ContourLine>,
    pub points: usize,
    pub truncated: bool,
}

/// A loaded elevation grid plus its georeference.
pub struct Dem {
    info: DemInfo,
    elevations: Vec<f32>,
}

#[derive(Clone, Copy)]
struct Segment {
    a: [f64; 2],
    b: [f64; 2],
}

type PointKey = (i64, i64);

fn point_key(point: [f64; 2]) -> PointKey {
    (
        (point[0] * 10_000_000.0).round() as i64,
        (point[1] * 10_000_000.0).round() as i64,
    )
}

fn level_key(level: f64) -> i64 {
    (level * 1000.0).round() as i64
}

fn crosses(left: f64, right: f64, level: f64) -> bool {
    (left < level && right >= level) || (right < level && left >= level)
}

fn interpolate(a: [f64; 2], b: [f64; 2], za: f64, zb: f64, level: f64) -> [f64; 2] {
    let t = ((level - za) / (zb - za)).clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

fn chain_segments(segments: &[Segment], level: f64) -> Vec<ContourLine> {
    let mut adjacency: HashMap<PointKey, Vec<usize>> = HashMap::new();
    for (index, segment) in segments.iter().enumerate() {
        adjacency
            .entry(point_key(segment.a))
            .or_default()
            .push(index);
        adjacency
            .entry(point_key(segment.b))
            .or_default()
            .push(index);
    }
    let mut used = vec![false; segments.len()];
    let mut lines = Vec::new();
    for start in 0..segments.len() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let first = segments[start];
        let mut points = vec![first.a, first.b];
        let mut end_key = point_key(first.b);
        while let Some(candidates) = adjacency.get(&end_key) {
            let Some(&next) = candidates.iter().find(|&&index| !used[index]) else {
                break;
            };
            used[next] = true;
            let segment = segments[next];
            let next_point = if point_key(segment.a) == end_key {
                segment.b
            } else if point_key(segment.b) == end_key {
                segment.a
            } else {
                break;
            };
            let next_key = point_key(next_point);
            if next_key == end_key {
                break;
            }
            points.push(next_point);
            end_key = next_key;
        }
        let mut start_key = point_key(points[0]);
        while let Some(candidates) = adjacency.get(&start_key) {
            let Some(&next) = candidates.iter().find(|&&index| !used[index]) else {
                break;
            };
            used[next] = true;
            let segment = segments[next];
            let next_point = if point_key(segment.a) == start_key {
                segment.b
            } else if point_key(segment.b) == start_key {
                segment.a
            } else {
                break;
            };
            let next_key = point_key(next_point);
            if next_key == start_key {
                break;
            }
            points.insert(0, next_point);
            start_key = next_key;
        }
        points.dedup_by(|left, right| point_key(*left) == point_key(*right));
        if points.len() >= 2 {
            lines.push(ContourLine {
                level,
                coordinates: points,
            });
        }
    }
    lines
}

impl Dem {
    /// Loads `.hgt`, `.asc` or GeoTIFF and validates its dimensions.
    fn load(path: &Path) -> Result<Self, String> {
        let metadata = std::fs::metadata(path)
            .map_err(|error| format!("cannot stat {}: {error}", path.display()))?;
        if !metadata.is_file() {
            return Err(format!("not a file: {}", path.display()));
        }
        if metadata.len() > MAX_FILE_BYTES {
            return Err(format!(
                "DEM is too large: {:.1} MiB (limit {} MiB)",
                metadata.len() as f64 / 1024.0 / 1024.0,
                MAX_FILE_BYTES / 1024 / 1024
            ));
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        match extension.as_str() {
            "hgt" => load_hgt(path, &metadata),
            "asc" => load_ascii(path, &metadata),
            "tif" | "tiff" => load_geotiff(path, &metadata),
            _ => Err("supported DEM formats: .hgt, .asc, .tif and .tiff".to_owned()),
        }
    }

    /// Bilinear elevation at a WGS84 coordinate, if it falls inside the grid.
    fn elevation(&self, lon: f64, lat: f64) -> Option<f64> {
        let info = &self.info;
        let width = info.east - info.west;
        let height = info.north - info.south;
        if !(width > 0.0 && height > 0.0) || !lon.is_finite() || !lat.is_finite() {
            return None;
        }
        let fx = (lon - info.west) / width * info.ncols as f64 - 0.5;
        let fy = (info.north - lat) / height * info.nrows as f64 - 0.5;
        if fx < -0.5 || fy < -0.5 || fx > info.ncols as f64 - 0.5 || fy > info.nrows as f64 - 0.5 {
            return None;
        }
        let x = fx.clamp(0.0, (info.ncols - 1) as f64);
        let y = fy.clamp(0.0, (info.nrows - 1) as f64);
        let x0 = x.floor() as usize;
        let y0 = y.floor() as usize;
        let x1 = (x0 + 1).min(info.ncols - 1);
        let y1 = (y0 + 1).min(info.nrows - 1);
        let tx = x - x0 as f64;
        let ty = y - y0 as f64;
        let mut sum = 0.0;
        let mut weight = 0.0;
        for (row, wx, wy) in [
            (y0, x0, (1.0 - tx) * (1.0 - ty)),
            (y0, x1, tx * (1.0 - ty)),
            (y1, x0, (1.0 - tx) * ty),
            (y1, x1, tx * ty),
        ] {
            let value = self.elevations[row * info.ncols + wx];
            if value.is_finite() {
                sum += f64::from(value) * wy;
                weight += wy;
            }
        }
        (weight > 0.0).then_some(sum / weight)
    }

    /// Elevation plus terrain derivatives at a coordinate.
    fn point(&self, lon: f64, lat: f64) -> Option<DemSample> {
        let elevation = self.elevation(lon, lat)?;
        let info = &self.info;
        let cell_lon = (info.east - info.west) / info.ncols as f64;
        let cell_lat = (info.north - info.south) / info.nrows as f64;
        let dx = (cell_lon * 111_320.0 * lat.to_radians().cos())
            .abs()
            .max(0.01);
        let dy = (cell_lat * 110_540.0).abs().max(0.01);
        let east = self.elevation(lon + cell_lon, lat).unwrap_or(elevation);
        let west = self.elevation(lon - cell_lon, lat).unwrap_or(elevation);
        let north = self.elevation(lon, lat + cell_lat).unwrap_or(elevation);
        let south = self.elevation(lon, lat - cell_lat).unwrap_or(elevation);
        let dzdx = (east - west) / (2.0 * dx);
        let dzdy = (north - south) / (2.0 * dy);
        let slope = dzdx.hypot(dzdy).atan().to_degrees();
        let mut aspect = (-dzdx).atan2(-dzdy).to_degrees();
        if aspect < 0.0 {
            aspect += 360.0;
        }
        Some(DemSample {
            id: info.id.clone(),
            elevation,
            slope,
            aspect,
        })
    }

    /// Elevations at the supplied WGS84 points.
    fn profile(&self, points: &[[f64; 2]]) -> Vec<Option<f64>> {
        points
            .iter()
            .map(|point| self.elevation(point[0], point[1]))
            .collect()
    }

    /// Marching-squares contours at `interval` metres.
    ///
    /// `step` skips source cells, keeping the segment count and payload
    /// bounded for large SRTM tiles. Each cell only visits levels between its
    /// own corner values, so flat areas do not scan every level.
    fn contours(&self, interval: f64, step: usize) -> Result<ContourResult, String> {
        const MAX_POINTS: usize = 500_000;
        const MAX_SEGMENTS: usize = 500_000;
        const MAX_LEVELS_PER_CELL: usize = 500;

        if !interval.is_finite() || interval <= 0.0 {
            return Err("contour interval must be positive".to_owned());
        }
        let info = &self.info;
        if info.ncols < 2 || info.nrows < 2 {
            return Err("DEM grid is too small for contours".to_owned());
        }
        let step = step.clamp(1, 32);
        let xs = sample_indices(info.ncols, step);
        let ys = sample_indices(info.nrows, step);
        let cell_lon = (info.east - info.west) / info.ncols as f64;
        let cell_lat = (info.north - info.south) / info.nrows as f64;
        let mut by_level: BTreeMap<i64, (f64, Vec<Segment>)> = BTreeMap::new();
        let mut segment_count = 0_usize;
        let mut truncated = false;

        'cells: for y in 0..ys.len() - 1 {
            let row0 = ys[y];
            let row1 = ys[y + 1];
            for x in 0..xs.len() - 1 {
                let col0 = xs[x];
                let col1 = xs[x + 1];
                let z00 = self.elevations[row0 * info.ncols + col0];
                let z10 = self.elevations[row0 * info.ncols + col1];
                let z11 = self.elevations[row1 * info.ncols + col1];
                let z01 = self.elevations[row1 * info.ncols + col0];
                if !(z00.is_finite() && z10.is_finite() && z11.is_finite() && z01.is_finite()) {
                    continue;
                }
                let low = z00.min(z10).min(z11).min(z01) as f64;
                let high = z00.max(z10).max(z11).max(z01) as f64;
                if high <= low {
                    continue;
                }
                let p00 = [
                    info.west + (col0 as f64 + 0.5) * cell_lon,
                    info.north - (row0 as f64 + 0.5) * cell_lat,
                ];
                let p10 = [
                    info.west + (col1 as f64 + 0.5) * cell_lon,
                    info.north - (row0 as f64 + 0.5) * cell_lat,
                ];
                let p11 = [
                    info.west + (col1 as f64 + 0.5) * cell_lon,
                    info.north - (row1 as f64 + 0.5) * cell_lat,
                ];
                let p01 = [
                    info.west + (col0 as f64 + 0.5) * cell_lon,
                    info.north - (row1 as f64 + 0.5) * cell_lat,
                ];

                let mut first = (low / interval).ceil() as i64;
                if first as f64 * interval <= low {
                    first += 1;
                }
                let mut level = first as f64 * interval;
                let mut per_cell = 0_usize;
                while level < high {
                    per_cell += 1;
                    if per_cell > MAX_LEVELS_PER_CELL {
                        truncated = true;
                        break 'cells;
                    }
                    let mut hits: Vec<[f64; 2]> = Vec::with_capacity(4);
                    for (a, b, za, zb) in [
                        (p00, p10, z00 as f64, z10 as f64),
                        (p10, p11, z10 as f64, z11 as f64),
                        (p11, p01, z11 as f64, z01 as f64),
                        (p01, p00, z01 as f64, z00 as f64),
                    ] {
                        if crosses(za, zb, level) {
                            hits.push(interpolate(a, b, za, zb, level));
                        }
                    }
                    let group = by_level
                        .entry(level_key(level))
                        .or_insert_with(|| (level, Vec::new()));
                    match hits.len() {
                        2 => {
                            group.1.push(Segment {
                                a: hits[0],
                                b: hits[1],
                            });
                            segment_count += 1;
                        }
                        4 => {
                            group.1.push(Segment {
                                a: hits[0],
                                b: hits[1],
                            });
                            group.1.push(Segment {
                                a: hits[2],
                                b: hits[3],
                            });
                            segment_count += 2;
                        }
                        _ => {}
                    }
                    if segment_count >= MAX_SEGMENTS {
                        truncated = true;
                        break 'cells;
                    }
                    level += interval;
                }
            }
        }

        let levels = by_level.len();
        let mut lines = Vec::new();
        let mut points = 0_usize;
        for (_, (level, segments)) in by_level {
            for line in chain_segments(&segments, level) {
                points += line.coordinates.len();
                lines.push(line);
                if points >= MAX_POINTS {
                    truncated = true;
                    break;
                }
            }
            if points >= MAX_POINTS {
                break;
            }
        }
        Ok(ContourResult {
            interval,
            levels,
            lines,
            points,
            truncated,
        })
    }

    /// Encodes a Web Mercator tile as Mapbox terrain-RGB PNG.
    fn tile(&self, z: u8, x: u32, y: u32) -> Result<Vec<u8>, String> {
        if z > 18 {
            return Err(format!("zoom {z} is too high for a DEM tile"));
        }
        let side = 1_u32 << z;
        if x >= side || y >= side {
            return Err(format!("tile {z}/{x}/{y} is out of range"));
        }
        let mut pixels = vec![0_u8; (TILE_SIZE * TILE_SIZE * 3) as usize];
        let scale = f64::from(side);
        for py in 0..TILE_SIZE {
            let world_y = (f64::from(y) + (f64::from(py) + 0.5) / f64::from(TILE_SIZE)) / scale;
            let lat = (std::f64::consts::PI * (1.0 - 2.0 * world_y))
                .sinh()
                .atan()
                .to_degrees();
            for px in 0..TILE_SIZE {
                let world_x = (f64::from(x) + (f64::from(px) + 0.5) / f64::from(TILE_SIZE)) / scale;
                let lon = world_x * 360.0 - 180.0;
                let elevation = self.elevation(lon, lat).unwrap_or(0.0);
                let [red, green, blue] = terrain_rgb(elevation);
                let offset = ((py * TILE_SIZE + px) * 3) as usize;
                pixels[offset] = red;
                pixels[offset + 1] = green;
                pixels[offset + 2] = blue;
            }
        }
        let image = RgbImage::from_raw(TILE_SIZE, TILE_SIZE, pixels)
            .ok_or_else(|| "cannot allocate DEM tile".to_owned())?;
        let mut png = Vec::with_capacity(24 * 1024);
        PngEncoder::new(&mut png)
            .write_image(
                image.as_raw(),
                TILE_SIZE,
                TILE_SIZE,
                ExtendedColorType::Rgb8,
            )
            .map_err(|error| format!("cannot encode DEM tile: {error}"))?;
        Ok(png)
    }
}

/// Mapbox terrain-RGB: `height = -10000 + value * 0.1`.
fn terrain_rgb(elevation: f64) -> [u8; 3] {
    let elevation = if elevation.is_finite() {
        elevation
    } else {
        0.0
    };
    let value = ((elevation + 10_000.0) / 0.1)
        .round()
        .clamp(0.0, 16_777_215.0) as u32;
    [
        (value >> 16) as u8,
        ((value >> 8) & 0xFF) as u8,
        (value & 0xFF) as u8,
    ]
}

/// Open DEMs keyed by the active model. Terrain supports one source, so a
/// second import intentionally replaces the first.
#[derive(Default)]
pub struct DemStore {
    current: RwLock<Option<Arc<Dem>>>,
}

impl DemStore {
    /// Registry with no DEM loaded.
    pub fn new() -> Self {
        Self::default()
    }

    /// Canonicalises and loads a DEM, replacing the active one only on success.
    pub async fn open(&self, path: &Path) -> Result<DemInfo, String> {
        let path = std::fs::canonicalize(path)
            .map_err(|error| format!("cannot open {}: {error}", path.display()))?;
        let dem = tauri::async_runtime::spawn_blocking(move || Dem::load(&path))
            .await
            .map_err(|error| format!("DEM task failed: {error}"))??;
        let info = dem.info.clone();
        *self.current.write().await = Some(Arc::new(dem));
        Ok(info)
    }

    /// Returns the active model only when the id still matches.
    async fn get(&self, id: &str) -> Option<Arc<Dem>> {
        self.current
            .read()
            .await
            .as_ref()
            .filter(|dem| dem.info.id == id)
            .cloned()
    }

    /// Removes the active model when its id matches.
    pub async fn close(&self, id: &str) -> bool {
        let mut current = self.current.write().await;
        if current.as_ref().is_some_and(|dem| dem.info.id == id) {
            *current = None;
            true
        } else {
            false
        }
    }

    async fn sample(&self, lon: f64, lat: f64) -> Option<DemSample> {
        self.current
            .read()
            .await
            .as_ref()
            .and_then(|dem| dem.point(lon, lat))
    }

    async fn active(&self) -> Option<Arc<Dem>> {
        self.current.read().await.clone()
    }
}

/// Opens a `.hgt`, `.asc` or GeoTIFF DEM and makes it the active terrain source.
#[tauri::command]
pub async fn open_dem(state: State<'_, Arc<AppState>>, path: String) -> Result<DemInfo, String> {
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute() {
        return Err("path must be absolute".to_owned());
    }
    let info = state.dem.open(&path).await?;
    log::info!(
        "opened DEM {} ({}×{}, {:.0}–{:.0} m, z0–z{})",
        info.path,
        info.ncols,
        info.nrows,
        info.min_elevation,
        info.max_elevation,
        info.max_zoom
    );
    Ok(info)
}

/// Closes the active DEM if its id matches.
#[tauri::command]
pub async fn close_dem(state: State<'_, Arc<AppState>>, id: String) -> Result<bool, String> {
    let closed = state.dem.close(&id).await;
    if closed {
        log::info!("closed DEM {id}");
    }
    Ok(closed)
}

/// Returns one terrain-RGB tile for `mappa://dem/<id>/{z}/{x}/{y}`.
#[tauri::command]
pub async fn read_dem_tile(
    state: State<'_, Arc<AppState>>,
    id: String,
    z: u8,
    x: u32,
    y: u32,
) -> Result<tauri::ipc::Response, String> {
    let dem = state
        .dem
        .get(&id)
        .await
        .ok_or_else(|| format!("DEM {id:?} is not open"))?;
    log::trace!("DEM {id} tile {z}/{x}/{y}");
    let png = tauri::async_runtime::spawn_blocking(move || dem.tile(z, x, y))
        .await
        .map_err(|error| format!("DEM tile task failed: {error}"))??;
    Ok(tauri::ipc::Response::new(png))
}

/// Elevation, slope and aspect at a coordinate, if a DEM is open.
#[tauri::command]
pub async fn dem_sample(
    state: State<'_, Arc<AppState>>,
    lon: f64,
    lat: f64,
) -> Result<Option<DemSample>, String> {
    if !(-180.0..=180.0).contains(&lon) || !(-90.0..=90.0).contains(&lat) {
        return Ok(None);
    }
    Ok(state.dem.sample(lon, lat).await)
}

/// Samples the active DEM at each line vertex for elevation profiles.
#[tauri::command]
pub async fn dem_profile(
    state: State<'_, Arc<AppState>>,
    points: Vec<[f64; 2]>,
) -> Result<Vec<Option<f64>>, String> {
    if points.is_empty() || points.len() > 20_000 {
        return Err("profile needs 1–20 000 points".to_owned());
    }
    if points.iter().any(|point| {
        !point[0].is_finite()
            || !point[1].is_finite()
            || !(-180.0..=180.0).contains(&point[0])
            || !(-90.0..=90.0).contains(&point[1])
    }) {
        return Err("profile contains an invalid coordinate".to_owned());
    }
    let dem = state
        .dem
        .active()
        .await
        .ok_or_else(|| "no DEM is open".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || dem.profile(&points))
        .await
        .map_err(|error| format!("DEM profile task failed: {error}"))
}

/// Builds contour lines from the active DEM.
#[tauri::command]
pub async fn dem_contours(
    state: State<'_, Arc<AppState>>,
    interval: f64,
    step: usize,
) -> Result<ContourResult, String> {
    if !interval.is_finite() || interval <= 0.0 {
        return Err("contour interval must be positive".to_owned());
    }
    let dem = state
        .dem
        .active()
        .await
        .ok_or_else(|| "no DEM is open".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || dem.contours(interval, step))
        .await
        .map_err(|error| format!("DEM contour task failed: {error}"))?
}

fn load_hgt(path: &Path, metadata: &std::fs::Metadata) -> Result<Dem, String> {
    let side = match metadata.len() {
        value if value == 3601 * 3601 * 2 => 3601_usize,
        value if value == 1201 * 1201 * 2 => 1201_usize,
        _ => {
            return Err("SRTM .hgt must be a 3601×3601 or 1201×1201 big-endian grid".to_owned());
        }
    };
    let (west, south) = hgt_bounds(path)?;
    let bytes =
        std::fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let mut elevations = Vec::with_capacity(side * side);
    for pair in bytes.as_chunks::<2>().0 {
        let value = i16::from_be_bytes(*pair);
        elevations.push(if value == HGT_VOID {
            f32::NAN
        } else {
            f32::from(value)
        });
    }
    let (min_elevation, max_elevation) = elevation_range(&elevations)?;
    let cell_size = 1.0 / side as f64;
    let info = DemInfo {
        id: dem_id(path, metadata),
        name: file_stem(path),
        path: path.display().to_string(),
        format: "hgt".to_owned(),
        west,
        south,
        east: west + 1.0,
        north: south + 1.0,
        ncols: side,
        nrows: side,
        cell_size,
        resolution_meters: resolution_meters(cell_size, south + 0.5),
        min_elevation,
        max_elevation,
        max_zoom: max_zoom(cell_size, south + 0.5),
    };
    Ok(Dem { info, elevations })
}

fn load_geotiff(path: &Path, metadata: &std::fs::Metadata) -> Result<Dem, String> {
    let raster = crate::geotiff::load(path, MAX_CELLS)?;
    let (min_elevation, max_elevation) = elevation_range(&raster.elevations)?;
    let latitude = (raster.south + raster.north) / 2.0;
    let info = DemInfo {
        id: dem_id(path, metadata),
        name: file_stem(path),
        path: path.display().to_string(),
        format: "tif".to_owned(),
        west: raster.west,
        south: raster.south,
        east: raster.east,
        north: raster.north,
        ncols: raster.ncols,
        nrows: raster.nrows,
        cell_size: raster.cell_size,
        resolution_meters: resolution_meters(raster.cell_size, latitude),
        min_elevation,
        max_elevation,
        max_zoom: max_zoom(raster.cell_size, latitude),
    };
    Ok(Dem {
        info,
        elevations: raster.elevations,
    })
}

fn load_ascii(path: &Path, metadata: &std::fs::Metadata) -> Result<Dem, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("cannot read {} as ASCII grid: {error}", path.display()))?;
    let mut tokens = text.split_whitespace();
    let mut ncols = None;
    let mut nrows = None;
    let mut xllcorner = None;
    let mut yllcorner = None;
    let mut xllcenter = None;
    let mut yllcenter = None;
    let mut cell_size = None;
    let mut nodata = None;
    let mut first_data = None;

    while let Some(token) = tokens.next() {
        let key = token.to_ascii_lowercase();
        match key.as_str() {
            "ncols" => ncols = Some(next_usize(&mut tokens, "ncols")?),
            "nrows" => nrows = Some(next_usize(&mut tokens, "nrows")?),
            "xllcorner" => xllcorner = Some(next_f64(&mut tokens, "xllcorner")?),
            "yllcorner" => yllcorner = Some(next_f64(&mut tokens, "yllcorner")?),
            "xllcenter" => xllcenter = Some(next_f64(&mut tokens, "xllcenter")?),
            "yllcenter" => yllcenter = Some(next_f64(&mut tokens, "yllcenter")?),
            "cellsize" => cell_size = Some(next_f64(&mut tokens, "cellsize")?),
            "nodata_value" => nodata = Some(next_f64(&mut tokens, "nodata_value")?),
            _ => {
                if token.parse::<f64>().is_err() {
                    return Err(format!("unsupported ASCII grid header: {token}"));
                }
                first_data = Some(token);
                break;
            }
        }
    }

    let ncols = ncols.ok_or_else(|| "ASCII grid has no ncols".to_owned())?;
    let nrows = nrows.ok_or_else(|| "ASCII grid has no nrows".to_owned())?;
    let cell_size = cell_size.ok_or_else(|| "ASCII grid has no cellsize".to_owned())?;
    if ncols == 0 || nrows == 0 || !cell_size.is_finite() || cell_size <= 0.0 {
        return Err("ASCII grid has invalid dimensions".to_owned());
    }
    let cells = ncols
        .checked_mul(nrows)
        .ok_or_else(|| "ASCII grid dimensions overflow".to_owned())?;
    if cells > MAX_CELLS {
        return Err(format!("ASCII grid is too large: {cells} cells"));
    }
    let (west, south) = match (xllcorner, yllcorner, xllcenter, yllcenter) {
        (Some(x), Some(y), _, _) => (x, y),
        (_, _, Some(x), Some(y)) => (x - cell_size / 2.0, y - cell_size / 2.0),
        _ => return Err("ASCII grid needs xllcorner/yllcorner or xllcenter/yllcenter".to_owned()),
    };
    let east = west + cell_size * ncols as f64;
    let north = south + cell_size * nrows as f64;
    if !west.is_finite()
        || !south.is_finite()
        || west < -180.0
        || east > 180.0
        || south < -90.0
        || north > 90.0
    {
        return Err("ASCII grid bounds are outside WGS84".to_owned());
    }

    let mut elevations = Vec::with_capacity(cells);
    if let Some(token) = first_data {
        elevations.push(parse_ascii_value(token, nodata)?);
    }
    for token in tokens {
        if elevations.len() >= cells {
            return Err("ASCII grid has more values than ncols × nrows".to_owned());
        }
        elevations.push(parse_ascii_value(token, nodata)?);
    }
    if elevations.len() != cells {
        return Err(format!(
            "ASCII grid has {} values, expected {cells}",
            elevations.len()
        ));
    }
    let (min_elevation, max_elevation) = elevation_range(&elevations)?;
    let info = DemInfo {
        id: dem_id(path, metadata),
        name: file_stem(path),
        path: path.display().to_string(),
        format: "asc".to_owned(),
        west,
        south,
        east,
        north,
        ncols,
        nrows,
        cell_size,
        resolution_meters: resolution_meters(cell_size, (south + north) / 2.0),
        min_elevation,
        max_elevation,
        max_zoom: max_zoom(cell_size, (south + north) / 2.0),
    };
    Ok(Dem { info, elevations })
}

fn next_usize<'a>(tokens: &mut impl Iterator<Item = &'a str>, key: &str) -> Result<usize, String> {
    tokens
        .next()
        .ok_or_else(|| format!("ASCII grid header {key} has no value"))?
        .parse()
        .map_err(|_| format!("ASCII grid header {key} is not an integer"))
}

fn next_f64<'a>(tokens: &mut impl Iterator<Item = &'a str>, key: &str) -> Result<f64, String> {
    tokens
        .next()
        .ok_or_else(|| format!("ASCII grid header {key} has no value"))?
        .parse()
        .map_err(|_| format!("ASCII grid header {key} is not a number"))
}

fn parse_ascii_value(token: &str, nodata: Option<f64>) -> Result<f32, String> {
    let value: f64 = token
        .parse()
        .map_err(|_| format!("invalid ASCII grid value {token:?}"))?;
    let is_void = !value.is_finite() || nodata.is_some_and(|void| (value - void).abs() < 1e-6);
    Ok(if is_void { f32::NAN } else { value as f32 })
}

fn sample_indices(size: usize, step: usize) -> Vec<usize> {
    let mut values: Vec<usize> = (0..size).step_by(step).collect();
    if values.last() != Some(&(size - 1)) {
        values.push(size - 1);
    }
    values
}

fn elevation_range(values: &[f32]) -> Result<(f64, f64), String> {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for value in values.iter().filter(|value| value.is_finite()) {
        min = min.min(f64::from(*value));
        max = max.max(f64::from(*value));
    }
    if !min.is_finite() {
        return Err("DEM contains no valid elevations".to_owned());
    }
    Ok((min, max))
}

/// Parses `N55E037` / `S01W002` from an SRTM filename.
fn hgt_bounds(path: &Path) -> Result<(f64, f64), String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_uppercase();
    parse_hgt_name(&name).ok_or_else(|| {
        format!(
            "cannot read SRTM tile coordinates from {}; expected N55E037.hgt",
            path.display()
        )
    })
}

fn parse_hgt_name(name: &str) -> Option<(f64, f64)> {
    let chars: Vec<char> = name.chars().collect();
    if chars.len() < 7 {
        return None;
    }
    let lat_sign = match chars[0] {
        'N' => 1.0,
        'S' => -1.0,
        _ => return None,
    };
    let lon_sign = match chars[3] {
        'E' => 1.0,
        'W' => -1.0,
        _ => return None,
    };
    let lat = chars[1].to_digit(10)? * 10 + chars[2].to_digit(10)?;
    let lon = chars[4].to_digit(10)? * 100 + chars[5].to_digit(10)? * 10 + chars[6].to_digit(10)?;
    Some((lon_sign * f64::from(lon), lat_sign * f64::from(lat)))
}

fn dem_id(path: &Path, metadata: &std::fs::Metadata) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(&metadata.len().to_le_bytes());
    if let Ok(modified) = metadata.modified()
        && let Ok(age) = modified.duration_since(std::time::UNIX_EPOCH)
    {
        hasher.update(&age.as_nanos().to_le_bytes());
    }
    format!("dem-{}", &hasher.finalize().to_hex()[..16])
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(str::to_owned)
        .unwrap_or_else(|| "DEM".to_owned())
}

fn resolution_meters(cell_size: f64, latitude: f64) -> f64 {
    cell_size * 111_320.0 * latitude.to_radians().cos().abs().max(0.01)
}

fn max_zoom(_cell_size: f64, _latitude: f64) -> u8 {
    // Terrain meshes are built from tiles at the current map zoom. Capping the
    // source near the map's own maximum avoids the empty render-to-texture
    // pass MapLibre produces when a DEM is overzoomed by many levels.
    18
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(extension: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "mappa-dem-{}-{}.{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            extension
        ))
    }

    #[test]
    fn parses_srtm_names() {
        assert_eq!(parse_hgt_name("N55E037.hgt"), Some((37.0, 55.0)));
        assert_eq!(parse_hgt_name("S01W002.hgt"), Some((-2.0, -1.0)));
        assert_eq!(parse_hgt_name("N00E000.SRTMGL1.hgt"), Some((0.0, 0.0)));
        assert_eq!(parse_hgt_name("bogus.hgt"), None);
    }

    #[test]
    fn reads_ascii_grid_and_samples_it() {
        let path = temp_path("asc");
        std::fs::write(
            &path,
            "ncols 3\nnrows 2\nxllcorner 10\nyllcorner 50\ncellsize 1\nNODATA_value -9999\n10 20 30\n40 50 60\n",
        )
        .unwrap();
        let dem = Dem::load(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(dem.info.format, "asc");
        assert_eq!(dem.info.ncols, 3);
        assert_eq!(dem.info.nrows, 2);
        assert_eq!(dem.info.west, 10.0);
        assert_eq!(dem.info.east, 13.0);
        assert_eq!(dem.info.south, 50.0);
        assert_eq!(dem.info.north, 52.0);
        assert_eq!(dem.info.min_elevation, 10.0);
        assert_eq!(dem.info.max_elevation, 60.0);
        assert_eq!(dem.elevation(10.5, 51.5), Some(10.0));
        assert_eq!(dem.elevation(11.5, 50.5), Some(50.0));
        assert!(dem.elevation(9.0, 51.0).is_none());
        let point = dem.point(11.5, 51.0).unwrap();
        assert!(point.slope > 0.0);
        assert!((0.0..360.0).contains(&point.aspect));
        let png = dem.tile(8, 136, 85).unwrap();
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
        let image = image::load_from_memory(&png).unwrap().to_rgb8();
        assert_eq!(image.dimensions(), (TILE_SIZE, TILE_SIZE));
        assert!(
            image
                .pixels()
                .any(|pixel| pixel.0 != [0, 0, 0] && pixel.0 != [1, 134, 160])
        );
    }

    #[test]
    fn treats_nodata_as_missing() {
        let path = temp_path("asc");
        std::fs::write(
            &path,
            "ncols 2\nnrows 1\nxllcorner 0\nyllcorner 0\ncellsize 1\nNODATA_value -9999\n-9999 25\n",
        )
        .unwrap();
        let dem = Dem::load(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(dem.info.min_elevation, 25.0);
        assert!(dem.elevation(0.25, 0.5).is_none());
        assert_eq!(dem.elevation(0.75, 0.5), Some(25.0));
    }

    #[test]
    fn reads_srtm_hgt() {
        let side = 1201;
        let mut bytes = Vec::with_capacity(side * side * 2);
        for row in 0..side {
            for _ in 0..side {
                bytes.extend_from_slice(&(row as i16).to_be_bytes());
            }
        }
        let path = std::env::temp_dir().join(format!(
            "N00E000-{}-{}.hgt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, &bytes).unwrap();
        let dem = Dem::load(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(dem.info.format, "hgt");
        assert_eq!(dem.info.ncols, side);
        assert_eq!(dem.info.west, 0.0);
        assert_eq!(dem.info.south, 0.0);
        assert_eq!(dem.info.east, 1.0);
        assert_eq!(dem.info.north, 1.0);
        assert_eq!(dem.info.max_elevation, 1200.0);
        let middle = dem.elevation(0.5, 0.5).unwrap();
        assert!((middle - 600.0).abs() < 2.0, "{middle}");
    }

    #[test]
    fn reads_geotiff_dem() {
        let hex = "49492a0008000000100000010400010000000400000001010400010000000400000002010300010000001000000003010300010000000100000006010300010000000100000011010400010000003c0100001501030001000000010000001601030001000000040000001701040001000000200000001c01030001000000010000003d01030001000000010000005301030001000000020000000e830c0003000000ce00000082840c0006000000e6000000af870300100000001601000081a402000600000036010000000000007b14ae47e17a843f7b14ae47e17a843f000000000000000000000000000000000000000000000000000000000000000000000000008042400000000000004c400000000000000000010001000000030000040000010002000104000001000100000800000100e6102d39393939006400650066006700c800c900ca00cb002c012d012e012f019001910192019301";
        let bytes: Vec<u8> = hex
            .as_bytes()
            .chunks(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect();
        let path = temp_path("tif");
        std::fs::write(&path, &bytes).unwrap();
        let dem = Dem::load(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(dem.info.format, "tif");
        assert_eq!(dem.info.ncols, 4);
        assert_eq!(dem.info.nrows, 4);
        assert!((dem.info.west - 37.0).abs() < 1e-9);
        assert!((dem.info.east - 37.04).abs() < 1e-9);
        assert!((dem.info.south - 55.96).abs() < 1e-9);
        assert!((dem.info.north - 56.0).abs() < 1e-9);
        assert_eq!(dem.info.min_elevation, 100.0);
        assert_eq!(dem.info.max_elevation, 403.0);
        let middle = dem.elevation(37.015, 55.985).unwrap();
        assert!((middle - 201.0).abs() < 1e-6, "{middle}");
        let corner = dem.elevation(37.035, 55.965).unwrap();
        assert!((corner - 403.0).abs() < 1e-6, "{corner}");
    }

    #[test]
    fn generates_contours_and_samples_a_profile() {
        let path = temp_path("asc");
        std::fs::write(
            &path,
            "ncols 4\nnrows 4\nxllcorner 10\nyllcorner 50\ncellsize 1\nNODATA_value -9999\n0 10 20 30\n10 20 30 40\n20 30 40 50\n30 40 50 60\n",
        )
        .unwrap();
        let dem = Dem::load(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        let profile = dem.profile(&[[10.5, 53.5], [13.5, 50.5], [20.0, 20.0]]);
        assert_eq!(profile.len(), 3);
        assert_eq!(profile[0], Some(0.0));
        assert_eq!(profile[1], Some(60.0));
        assert_eq!(profile[2], None);

        let contours = dem.contours(10.0, 1).unwrap();
        assert_eq!(contours.interval, 10.0);
        assert!(contours.levels >= 5);
        assert!(!contours.lines.is_empty());
        assert!(contours.points > 0);
        assert!(!contours.truncated);
        for line in &contours.lines {
            assert!(line.coordinates.len() >= 2);
            for point in &line.coordinates {
                assert!((10.0..=14.0).contains(&point[0]));
                assert!((50.0..=54.0).contains(&point[1]));
            }
        }
        assert!(dem.contours(0.0, 1).is_err());
    }

    #[test]
    fn terrain_rgb_matches_mapbox_encoding() {
        assert_eq!(terrain_rgb(0.0), [1, 134, 160]);
        assert_eq!(terrain_rgb(-10_000.0), [0, 0, 0]);
        assert_eq!(terrain_rgb(f64::NAN), [1, 134, 160]);
    }
}
