//! Geographic bounding boxes in WGS84 degrees.

use std::fmt;

/// A geographic rectangle. Longitudes increase east, latitudes north.
///
/// Antimeridian-crossing boxes are intentionally not represented: split them
/// into two boxes at the caller. This keeps every operation total and cheap.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bbox {
    west: f64,
    south: f64,
    east: f64,
    north: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BboxError {
    NonFinite,
    InvalidLongitude,
    InvalidLatitude,
    Inverted,
}

impl fmt::Display for BboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let msg = match self {
            Self::NonFinite => "coordinate is not finite",
            Self::InvalidLongitude => "longitude must be within [-180, 180]",
            Self::InvalidLatitude => "latitude must be within [-90, 90]",
            Self::Inverted => "west must be <= east and south must be <= north",
        };
        f.write_str(msg)
    }
}

impl std::error::Error for BboxError {}

impl Bbox {
    pub fn new(west: f64, south: f64, east: f64, north: f64) -> Result<Self, BboxError> {
        if !west.is_finite() || !south.is_finite() || !east.is_finite() || !north.is_finite() {
            return Err(BboxError::NonFinite);
        }
        if !(-180.0..=180.0).contains(&west) || !(-180.0..=180.0).contains(&east) {
            return Err(BboxError::InvalidLongitude);
        }
        if !(-90.0..=90.0).contains(&south) || !(-90.0..=90.0).contains(&north) {
            return Err(BboxError::InvalidLatitude);
        }
        if west > east || south > north {
            return Err(BboxError::Inverted);
        }
        Ok(Self {
            west,
            south,
            east,
            north,
        })
    }

    /// A box covering the whole world, useful for tests and world views.
    pub fn world() -> Self {
        Self {
            west: -180.0,
            south: -90.0,
            east: 180.0,
            north: 90.0,
        }
    }

    pub fn from_points<I>(points: I) -> Option<Self>
    where
        I: IntoIterator<Item = (f64, f64)>,
    {
        let mut iter = points.into_iter();
        let (first_lon, first_lat) = iter.next()?;
        let mut west = first_lon;
        let mut east = first_lon;
        let mut south = first_lat;
        let mut north = first_lat;

        for (lon, lat) in iter {
            west = west.min(lon);
            east = east.max(lon);
            south = south.min(lat);
            north = north.max(lat);
        }

        Self::new(west, south, east, north).ok()
    }

    pub fn west(&self) -> f64 {
        self.west
    }

    pub fn south(&self) -> f64 {
        self.south
    }

    pub fn east(&self) -> f64 {
        self.east
    }

    pub fn north(&self) -> f64 {
        self.north
    }

    pub fn width(&self) -> f64 {
        self.east - self.west
    }

    pub fn height(&self) -> f64 {
        self.north - self.south
    }

    pub fn center(&self) -> (f64, f64) {
        (
            (self.west + self.east) / 2.0,
            (self.south + self.north) / 2.0,
        )
    }

    pub fn contains(&self, lon: f64, lat: f64) -> bool {
        (self.west..=self.east).contains(&lon) && (self.south..=self.north).contains(&lat)
    }

    pub fn intersects(&self, other: &Self) -> bool {
        self.west <= other.east
            && other.west <= self.east
            && self.south <= other.north
            && other.south <= self.north
    }

    pub fn union(&self, other: &Self) -> Self {
        Self {
            west: self.west.min(other.west),
            south: self.south.min(other.south),
            east: self.east.max(other.east),
            north: self.north.max(other.north),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_coordinates() {
        assert!(Bbox::new(-180.0, -90.0, 180.0, 90.0).is_ok());
        assert_eq!(
            Bbox::new(f64::NAN, 0.0, 1.0, 1.0),
            Err(BboxError::NonFinite)
        );
        assert_eq!(
            Bbox::new(-181.0, 0.0, 1.0, 1.0),
            Err(BboxError::InvalidLongitude)
        );
        assert_eq!(
            Bbox::new(0.0, -91.0, 1.0, 1.0),
            Err(BboxError::InvalidLatitude)
        );
        assert_eq!(Bbox::new(10.0, 0.0, 1.0, 1.0), Err(BboxError::Inverted));
    }

    #[test]
    fn builds_from_points() {
        let bbox = Bbox::from_points([(37.0, 55.0), (38.0, 56.0), (37.5, 55.5)]).unwrap();
        assert_eq!(bbox.west(), 37.0);
        assert_eq!(bbox.east(), 38.0);
        assert_eq!(bbox.south(), 55.0);
        assert_eq!(bbox.north(), 56.0);
        assert_eq!(bbox.center(), (37.5, 55.5));
    }

    #[test]
    fn intersects_and_contains() {
        let a = Bbox::new(0.0, 0.0, 10.0, 10.0).unwrap();
        let b = Bbox::new(5.0, 5.0, 15.0, 15.0).unwrap();
        let c = Bbox::new(20.0, 20.0, 30.0, 30.0).unwrap();
        assert!(a.intersects(&b));
        assert!(!a.intersects(&c));
        assert!(a.contains(5.0, 5.0));
        assert!(!a.contains(15.0, 5.0));
    }
}
