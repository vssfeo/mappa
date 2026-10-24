//! Polygon helpers for polygon-scoped downloads.
//!
//! Rings are open (the last vertex is not repeated) and expressed as
//! `[longitude, latitude]` pairs. Antimeridian-crossing rings are not
//! supported and must be split by the caller.

/// Distance below which a point is considered to lie on a segment.
const EPSILON: f64 = 1e-12;

fn same_point(left: [f64; 2], right: [f64; 2]) -> bool {
    (left[0] - right[0]).abs() <= EPSILON && (left[1] - right[1]).abs() <= EPSILON
}

/// Validates and normalizes a ring: finite WGS84 coordinates, no repeated
/// consecutive vertices, no repeated closing vertex, at least three points.
pub fn normalize_ring(points: &[[f64; 2]]) -> Option<Vec<[f64; 2]>> {
    let mut ring: Vec<[f64; 2]> = Vec::with_capacity(points.len());
    for point in points {
        if !point[0].is_finite() || !point[1].is_finite() {
            return None;
        }
        if !(-180.0..=180.0).contains(&point[0]) || !(-90.0..=90.0).contains(&point[1]) {
            return None;
        }
        if ring.last().is_none_or(|last| !same_point(*last, *point)) {
            ring.push(*point);
        }
    }
    if ring.len() >= 2 && same_point(ring[0], ring[ring.len() - 1]) {
        ring.pop();
    }
    if ring.len() < 3 {
        return None;
    }
    // Reject collinear "rings": they would act as a near-zero-width mask.
    let mut doubled_area = 0.0;
    let mut previous = ring[ring.len() - 1];
    for &current in &ring {
        doubled_area += previous[0] * current[1] - current[0] * previous[1];
        previous = current;
    }
    ((doubled_area / 2.0).abs() > EPSILON).then_some(ring)
}

/// Bounding box of a normalized ring as `(west, south, east, north)`.
pub fn ring_bounds(ring: &[[f64; 2]]) -> (f64, f64, f64, f64) {
    let mut west = f64::INFINITY;
    let mut south = f64::INFINITY;
    let mut east = f64::NEG_INFINITY;
    let mut north = f64::NEG_INFINITY;
    for point in ring {
        west = west.min(point[0]);
        east = east.max(point[0]);
        south = south.min(point[1]);
        north = north.max(point[1]);
    }
    (west, south, east, north)
}

fn orientation(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

fn on_segment(a: [f64; 2], b: [f64; 2], point: [f64; 2]) -> bool {
    point[0] >= a[0].min(b[0]) - EPSILON
        && point[0] <= a[0].max(b[0]) + EPSILON
        && point[1] >= a[1].min(b[1]) - EPSILON
        && point[1] <= a[1].max(b[1]) + EPSILON
}

fn segments_intersect(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let d1 = orientation(c, d, a);
    let d2 = orientation(c, d, b);
    let d3 = orientation(a, b, c);
    let d4 = orientation(a, b, d);
    if ((d1 > EPSILON && d2 < -EPSILON) || (d1 < -EPSILON && d2 > EPSILON))
        && ((d3 > EPSILON && d4 < -EPSILON) || (d3 < -EPSILON && d4 > EPSILON))
    {
        return true;
    }
    (d1.abs() <= EPSILON && on_segment(c, d, a))
        || (d2.abs() <= EPSILON && on_segment(c, d, b))
        || (d3.abs() <= EPSILON && on_segment(a, b, c))
        || (d4.abs() <= EPSILON && on_segment(a, b, d))
}

/// Returns `true` when the point lies inside the ring or on its boundary.
pub fn point_in_ring(lon: f64, lat: f64, ring: &[[f64; 2]]) -> bool {
    if ring.len() < 3 {
        return false;
    }
    let point = [lon, lat];
    let mut inside = false;
    let mut previous = ring[ring.len() - 1];
    for &current in ring {
        if orientation(previous, current, point).abs() <= EPSILON
            && on_segment(previous, current, point)
        {
            return true;
        }
        if (previous[1] > lat) != (current[1] > lat) {
            let crossing = previous[0]
                + (lat - previous[1]) * (current[0] - previous[0]) / (current[1] - previous[1]);
            if lon < crossing {
                inside = !inside;
            }
        }
        previous = current;
    }
    inside
}

/// Returns `true` when a WGS84 tile rectangle overlaps the ring.
///
/// A tile is selected when the polygon has a vertex inside it, when a tile
/// corner is inside the polygon, or when any edges cross.
pub fn tile_intersects_ring(
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    ring: &[[f64; 2]],
) -> bool {
    tile_intersects_ring_with_bounds(west, south, east, north, ring, ring_bounds(ring))
}

/// Same as [`tile_intersects_ring`] with precomputed ring bounds, for callers
/// that test many tiles against one polygon.
pub fn tile_intersects_ring_with_bounds(
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    ring: &[[f64; 2]],
    bounds: (f64, f64, f64, f64),
) -> bool {
    if ring.len() < 3 {
        return false;
    }
    let (ring_west, ring_south, ring_east, ring_north) = bounds;
    if ring_east < west || ring_west > east || ring_north < south || ring_south > north {
        return false;
    }
    // The polygon is completely inside the tile.
    if ring
        .iter()
        .any(|point| (west..=east).contains(&point[0]) && (south..=north).contains(&point[1]))
    {
        return true;
    }
    // The tile is completely inside the polygon.
    for (lon, lat) in [(west, south), (east, south), (east, north), (west, north)] {
        if point_in_ring(lon, lat, ring) {
            return true;
        }
    }
    // Partial overlap: some polygon and tile edges cross.
    let corners = [[west, south], [east, south], [east, north], [west, north]];
    let mut previous = ring[ring.len() - 1];
    for &current in ring {
        for index in 0..4 {
            if segments_intersect(previous, current, corners[index], corners[(index + 1) % 4]) {
                return true;
            }
        }
        previous = current;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square() -> Vec<[f64; 2]> {
        normalize_ring(&[[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]]).unwrap()
    }

    #[test]
    fn normalizes_rings() {
        let ring = normalize_ring(&[
            [0.0, 0.0],
            [0.0, 0.0],
            [1.0, 0.0],
            [1.0, 1.0],
            [0.0, 1.0],
            [0.0, 0.0],
        ])
        .unwrap();
        assert_eq!(ring.len(), 4);
        assert!(normalize_ring(&[[0.0, 0.0], [1.0, 1.0]]).is_none());
        assert!(normalize_ring(&[[0.0, 0.0], [1.0, 0.0], [f64::NAN, 1.0]]).is_none());
        assert!(normalize_ring(&[[0.0, 0.0], [181.0, 0.0], [1.0, 1.0]]).is_none());
        // Collinear vertices enclose no area.
        assert!(normalize_ring(&[[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]]).is_none());
    }

    #[test]
    fn tests_points_inside_and_on_boundary() {
        let ring = square();
        assert!(point_in_ring(1.0, 1.0, &ring));
        assert!(point_in_ring(0.0, 1.0, &ring));
        assert!(point_in_ring(2.0, 2.0, &ring));
        assert!(!point_in_ring(3.0, 1.0, &ring));
        assert!(!point_in_ring(-0.1, 1.0, &ring));
    }

    #[test]
    fn selects_tiles_that_overlap_polygon() {
        let ring = square();
        // Tile fully inside the polygon.
        assert!(tile_intersects_ring(0.5, 0.5, 1.5, 1.5, &ring));
        // Polygon fully inside the tile.
        assert!(tile_intersects_ring(-1.0, -1.0, 3.0, 3.0, &ring));
        // Edge crosses the tile, but no vertices are inside it.
        assert!(tile_intersects_ring(1.5, -0.5, 3.0, 0.5, &ring));
        // Vertex inside the tile.
        assert!(tile_intersects_ring(-0.5, -0.5, 0.5, 0.5, &ring));
        // Touch on the boundary counts.
        assert!(tile_intersects_ring(2.0, 0.5, 3.0, 1.5, &ring));
        // Disjoint tile.
        assert!(!tile_intersects_ring(3.0, 3.0, 4.0, 4.0, &ring));
    }

    #[test]
    fn reports_ring_bounds() {
        assert_eq!(ring_bounds(&square()), (0.0, 0.0, 2.0, 2.0));
    }
}
