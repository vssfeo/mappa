//! Web Mercator tile coordinates.
//!
//! The math follows the XYZ convention used by OpenStreetMap, MapLibre and
//! most raster providers: `x` grows east, `y` grows south, zoom 0 is one tile.
//! TMS (y grows north) is available through explicit conversion helpers.

use std::f64::consts::PI;
use std::fmt;

use crate::bbox::Bbox;

/// Maximum latitude covered by the square Web Mercator world.
pub const MAX_LAT: f64 = 85.051_128_779_806_59;
/// Highest zoom that still fits in `u32` tile indices.
pub const MAX_ZOOM: u8 = 30;
/// Nominal raster tile size in pixels.
pub const TILE_SIZE: u32 = 256;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TileError {
    ZoomOutOfRange { zoom: u8 },
    LongitudeOutOfRange { lon: f64 },
    LatitudeOutOfRange { lat: f64 },
    TileOutOfRange { z: u8, x: u32, y: u32 },
}

impl fmt::Display for TileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZoomOutOfRange { zoom } => {
                write!(f, "zoom {zoom} is outside 0..={MAX_ZOOM}")
            }
            Self::LongitudeOutOfRange { lon } => {
                write!(f, "longitude {lon} is outside [-180, 180]")
            }
            Self::LatitudeOutOfRange { lat } => {
                write!(f, "latitude {lat} is outside [-90, 90]")
            }
            Self::TileOutOfRange { z, x, y } => {
                write!(f, "tile {z}/{x}/{y} is outside the zoom {z} grid")
            }
        }
    }
}

impl std::error::Error for TileError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TileCoord {
    z: u8,
    x: u32,
    y: u32,
}

impl TileCoord {
    pub fn new(z: u8, x: u32, y: u32) -> Result<Self, TileError> {
        let n = zoom_tiles(z)?;
        if x >= n || y >= n {
            return Err(TileError::TileOutOfRange { z, x, y });
        }
        Ok(Self { z, x, y })
    }

    fn new_unchecked(z: u8, x: u32, y: u32) -> Self {
        Self { z, x, y }
    }

    /// Tile containing the given WGS84 point at `z`.
    pub fn from_lonlat(lon: f64, lat: f64, z: u8) -> Result<Self, TileError> {
        if !lon.is_finite() || !(-180.0..=180.0).contains(&lon) {
            return Err(TileError::LongitudeOutOfRange { lon });
        }
        if !lat.is_finite() || !(-90.0..=90.0).contains(&lat) {
            return Err(TileError::LatitudeOutOfRange { lat });
        }

        let n = zoom_tiles(z)?;
        let n_f = f64::from(n);
        let x = ((lon + 180.0) / 360.0 * n_f).floor();
        let lat_rad = lat.clamp(-MAX_LAT, MAX_LAT).to_radians();
        let y = ((1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / PI) / 2.0 * n_f).floor();
        let max = n - 1;

        Ok(Self {
            z,
            x: (x as i64).clamp(0, i64::from(max)) as u32,
            y: (y as i64).clamp(0, i64::from(max)) as u32,
        })
    }

    pub fn z(&self) -> u8 {
        self.z
    }

    pub fn x(&self) -> u32 {
        self.x
    }

    pub fn y(&self) -> u32 {
        self.y
    }

    /// North-west corner of the tile.
    pub fn north_west(&self) -> (f64, f64) {
        let n = f64::from(1u32 << self.z);
        let lon = f64::from(self.x) / n * 360.0 - 180.0;
        let lat = (PI * (1.0 - 2.0 * f64::from(self.y) / n))
            .sinh()
            .atan()
            .to_degrees();
        (lon, lat)
    }

    /// Tile edges as `(west, south, east, north)` in WGS84 degrees.
    pub fn bounds(&self) -> (f64, f64, f64, f64) {
        let n = f64::from(1u32 << self.z);
        let west = f64::from(self.x) / n * 360.0 - 180.0;
        let east = (f64::from(self.x) + 1.0) / n * 360.0 - 180.0;
        let north = (PI * (1.0 - 2.0 * f64::from(self.y) / n))
            .sinh()
            .atan()
            .to_degrees();
        let south = (PI * (1.0 - 2.0 * (f64::from(self.y) + 1.0) / n))
            .sinh()
            .atan()
            .to_degrees();
        (west, south, east, north)
    }

    /// Centre of the tile.
    pub fn center(&self) -> (f64, f64) {
        let n = f64::from(1u32 << self.z);
        let lon = (f64::from(self.x) + 0.5) / n * 360.0 - 180.0;
        let lat = (PI * (1.0 - 2.0 * (f64::from(self.y) + 0.5) / n))
            .sinh()
            .atan()
            .to_degrees();
        (lon, lat)
    }

    /// TMS row for the same tile.
    pub fn tms_y(&self) -> u32 {
        let n = 1u32 << self.z;
        n - 1 - self.y
    }

    pub fn from_tms(z: u8, x: u32, y: u32) -> Result<Self, TileError> {
        let n = zoom_tiles(z)?;
        if x >= n || y >= n {
            return Err(TileError::TileOutOfRange { z, x, y });
        }
        Ok(Self { z, x, y: n - 1 - y })
    }

    pub fn parent(&self) -> Option<Self> {
        if self.z == 0 {
            return None;
        }
        Some(Self {
            z: self.z - 1,
            x: self.x / 2,
            y: self.y / 2,
        })
    }

    /// Four children in `[NW, NE, SW, SE]` order.
    pub fn children(&self) -> Option<[Self; 4]> {
        if self.z >= MAX_ZOOM {
            return None;
        }
        let z = self.z + 1;
        let x = self.x * 2;
        let y = self.y * 2;
        Some([
            Self { z, x, y },
            Self { z, x: x + 1, y },
            Self { z, x, y: y + 1 },
            Self {
                z,
                x: x + 1,
                y: y + 1,
            },
        ])
    }

    /// Bing-style quadkey (also useful as a stable string key).
    pub fn quadkey(&self) -> String {
        let mut key = String::with_capacity(usize::from(self.z));
        for i in (0..self.z).rev() {
            let mask = 1u32 << i;
            let digit = u8::from(self.x & mask != 0) | (u8::from(self.y & mask != 0) << 1);
            key.push(char::from(b'0' + digit));
        }
        key
    }
}

impl fmt::Display for TileCoord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}/{}", self.z, self.x, self.y)
    }
}

/// Inclusive rectangle of tiles at one zoom.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileRange {
    z: u8,
    min_x: u32,
    max_x: u32,
    min_y: u32,
    max_y: u32,
}

impl TileRange {
    pub fn new(bbox: &Bbox, z: u8) -> Result<Self, TileError> {
        let n = zoom_tiles(z)?;
        let max = n - 1;

        let min_x = lon_to_x(bbox.west(), n).clamp(0, i64::from(max)) as u32;
        let min_y = lat_to_y(bbox.north(), n).clamp(0, i64::from(max)) as u32;
        // East/south are exclusive edges: a bbox ending exactly on a tile
        // boundary must not pull in the next column/row. `ceil - 1` yields the
        // tile that contains the interior side of the edge.
        let max_x = lon_to_x_ceil(bbox.east(), n).clamp(i64::from(min_x), i64::from(max)) as u32;
        let max_y = lat_to_y_ceil(bbox.south(), n).clamp(i64::from(min_y), i64::from(max)) as u32;

        Ok(Self {
            z,
            min_x,
            max_x,
            min_y,
            max_y,
        })
    }

    pub fn z(&self) -> u8 {
        self.z
    }

    pub fn min_x(&self) -> u32 {
        self.min_x
    }

    pub fn max_x(&self) -> u32 {
        self.max_x
    }

    pub fn min_y(&self) -> u32 {
        self.min_y
    }

    pub fn max_y(&self) -> u32 {
        self.max_y
    }

    pub fn count(&self) -> u64 {
        let width = u64::from(self.max_x - self.min_x) + 1;
        let height = u64::from(self.max_y - self.min_y) + 1;
        width * height
    }

    pub fn contains(&self, tile: TileCoord) -> bool {
        tile.z == self.z
            && (self.min_x..=self.max_x).contains(&tile.x)
            && (self.min_y..=self.max_y).contains(&tile.y)
    }

    pub fn iter(&self) -> TileIter {
        TileIter {
            range: *self,
            next_x: self.min_x,
            next_y: self.min_y,
            done: false,
        }
    }
}

pub struct TileIter {
    range: TileRange,
    next_x: u32,
    next_y: u32,
    done: bool,
}

impl Iterator for TileIter {
    type Item = TileCoord;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }

        let tile = TileCoord::new_unchecked(self.range.z, self.next_x, self.next_y);

        if self.next_x == self.range.max_x {
            self.next_x = self.range.min_x;
            if self.next_y == self.range.max_y {
                self.done = true;
            } else {
                self.next_y += 1;
            }
        } else {
            self.next_x += 1;
        }

        Some(tile)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        if self.done {
            return (0, Some(0));
        }
        let remaining = (u64::from(self.range.max_x - self.next_x) + 1)
            * (u64::from(self.range.max_y - self.next_y) + 1);
        let remaining = usize::try_from(remaining).unwrap_or(usize::MAX);
        (remaining, Some(remaining))
    }
}

fn zoom_tiles(z: u8) -> Result<u32, TileError> {
    if z > MAX_ZOOM {
        return Err(TileError::ZoomOutOfRange { zoom: z });
    }
    Ok(1u32 << z)
}

fn lon_to_x(lon: f64, n: u32) -> i64 {
    let n_f = f64::from(n);
    ((lon + 180.0) / 360.0 * n_f).floor() as i64
}

fn lon_to_x_ceil(lon: f64, n: u32) -> i64 {
    let n_f = f64::from(n);
    (((lon + 180.0) / 360.0 * n_f).ceil() as i64) - 1
}

fn lat_to_y(lat: f64, n: u32) -> i64 {
    lat_to_y_exact(lat, n).floor() as i64
}

fn lat_to_y_ceil(lat: f64, n: u32) -> i64 {
    (lat_to_y_exact(lat, n).ceil() as i64) - 1
}

fn lat_to_y_exact(lat: f64, n: u32) -> f64 {
    let n_f = f64::from(n);
    let lat_rad = lat.clamp(-MAX_LAT, MAX_LAT).to_radians();
    (1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / PI) / 2.0 * n_f
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn world_at_zoom_zero_is_one_tile() {
        let tile = TileCoord::from_lonlat(0.0, 0.0, 0).unwrap();
        assert_eq!(tile, TileCoord::new(0, 0, 0).unwrap());
        assert_eq!(tile.quadkey(), "");
        let (west, north) = tile.north_west();
        assert!((west + 180.0).abs() < 1e-12);
        assert!((north - MAX_LAT).abs() < 1e-12);
    }

    #[test]
    fn moscow_lands_in_expected_tile() {
        let tile = TileCoord::from_lonlat(37.6173, 55.7558, 10).unwrap();
        assert_eq!((tile.z(), tile.x(), tile.y()), (10, 619, 320));

        let (west, north) = tile.north_west();
        let (east, _) = TileCoord::new(10, 620, 320).unwrap().north_west();
        let (_, south) = TileCoord::new(10, 619, 321).unwrap().north_west();
        assert!(west <= 37.6173 && 37.6173 < east);
        assert!(south < 55.7558 && 55.7558 <= north);
    }

    #[test]
    fn bounds_match_neighbouring_corners() {
        let tile = TileCoord::new(10, 619, 320).unwrap();
        let (west, south, east, north) = tile.bounds();
        let (nw_west, nw_north) = tile.north_west();
        let (ne_east, _) = TileCoord::new(10, 620, 320).unwrap().north_west();
        let (_, sw_south) = TileCoord::new(10, 619, 321).unwrap().north_west();
        assert!((west - nw_west).abs() < 1e-12);
        assert!((north - nw_north).abs() < 1e-12);
        assert!((east - ne_east).abs() < 1e-12);
        assert!((south - sw_south).abs() < 1e-12);
        assert!(south < north && west < east);
    }

    #[test]
    fn tms_round_trip() {
        let tile = TileCoord::new(5, 7, 9).unwrap();
        let tms = TileCoord::from_tms(5, 7, tile.tms_y()).unwrap();
        assert_eq!(tile, tms);
        assert_eq!(tile.tms_y(), 31 - 9);
    }

    #[test]
    fn parent_and_children_round_trip() {
        let tile = TileCoord::new(10, 619, 319).unwrap();
        let parent = tile.parent().unwrap();
        assert_eq!(parent, TileCoord::new(9, 309, 159).unwrap());
        assert!(parent.children().unwrap().contains(&tile));
        assert!(TileCoord::new(0, 0, 0).unwrap().parent().is_none());
    }

    #[test]
    fn quadkey_matches_bing_convention() {
        assert_eq!(TileCoord::new(1, 1, 1).unwrap().quadkey(), "3");
        assert_eq!(TileCoord::new(2, 0, 0).unwrap().quadkey(), "00");
        assert_eq!(TileCoord::new(2, 3, 3).unwrap().quadkey(), "33");
    }

    #[test]
    fn ranges_exclude_the_tile_beyond_an_exact_edge() {
        let range = TileRange::new(&Bbox::new(-10.0, 0.0, 0.0, 10.0).unwrap(), 2).unwrap();
        // 0° east and 0° south are tile boundaries; the next tile is outside.
        assert_eq!((range.min_x, range.max_x), (1, 1));
        assert_eq!((range.min_y, range.max_y), (1, 1));
        let world = TileRange::new(&Bbox::world(), 2).unwrap();
        assert_eq!((world.min_x, world.max_x), (0, 3));
        assert_eq!((world.min_y, world.max_y), (0, 3));
    }

    #[test]
    fn world_ranges_have_expected_counts() {
        let world = Bbox::world();
        assert_eq!(TileRange::new(&world, 0).unwrap().count(), 1);
        assert_eq!(TileRange::new(&world, 1).unwrap().count(), 4);
        assert_eq!(TileRange::new(&world, 10).unwrap().count(), 1_048_576);
    }

    #[test]
    fn range_iterator_visits_every_tile_once() {
        let bbox = Bbox::new(37.5, 55.7, 37.7, 55.8).unwrap();
        let range = TileRange::new(&bbox, 10).unwrap();
        let tiles: Vec<_> = range.iter().collect();
        assert_eq!(tiles.len() as u64, range.count());
        assert!(tiles.iter().all(|tile| range.contains(*tile)));
    }

    #[test]
    fn rejects_invalid_input() {
        assert!(TileCoord::new(31, 0, 0).is_err());
        assert!(TileCoord::new(1, 2, 0).is_err());
        assert!(TileCoord::from_lonlat(181.0, 0.0, 1).is_err());
        assert!(TileCoord::from_lonlat(0.0, 91.0, 1).is_err());
    }
}
