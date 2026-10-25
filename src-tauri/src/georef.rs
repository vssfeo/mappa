//! Georeferencing of scanned maps.
//!
//! The user marks ground control points (GCPs): a pixel on the scan and the
//! same place on the map. An affine transform maps pixels to EPSG:3857
//! metres; the scan is then resampled into a north-up COG that QGIS and the
//! rest of the GIS world can open.

use std::path::Path;

use image::RgbImage;
use serde::{Deserialize, Serialize};

/// One ground control point: scan pixel and its real-world position.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gcp {
    /// Pixel column on the scan.
    pub px: f64,
    /// Pixel row on the scan.
    pub py: f64,
    pub lon: f64,
    pub lat: f64,
}

/// `x = a*px + b*py + c`, `y = d*px + e*py + f`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Affine {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

/// Result of fitting, shown in the UI before the warp.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeorefSolution {
    pub affine: Affine,
    /// Root mean square error in metres on the ground.
    pub rmse: f64,
    /// Per-point error in metres, same order as the input.
    pub residuals: Vec<f64>,
    /// EPSG:3857 bounding box of the whole scan: west, south, east, north.
    pub bounds: [f64; 4],
    /// Non-linear transform; `None` means the affine field is exact.
    pub transform: Option<Transform>,
}

/// Non-linear pixel-to-mercator transforms.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Transform {
    Poly {
        cx: [f64; 6],
        cy: [f64; 6],
        hint: Affine,
    },
    Tps {
        points: Vec<[f64; 2]>,
        wx: Vec<f64>,
        wy: Vec<f64>,
        ax: [f64; 3],
        ay: [f64; 3],
        hint: Affine,
    },
}

fn poly_terms(px: f64, py: f64) -> [f64; 6] {
    [1.0, px, py, px * px, px * py, py * py]
}

fn dot(coefficients: &[f64; 6], terms: &[f64; 6]) -> f64 {
    (0..6).map(|i| coefficients[i] * terms[i]).sum()
}

fn tps_basis(r2: f64) -> f64 {
    if r2 <= 0.0 { 0.0 } else { 0.5 * r2 * r2.ln() }
}

impl Transform {
    pub fn apply(&self, px: f64, py: f64) -> (f64, f64) {
        match self {
            Transform::Poly { cx, cy, .. } => {
                let terms = poly_terms(px, py);
                (dot(cx, &terms), dot(cy, &terms))
            }
            Transform::Tps {
                points,
                wx,
                wy,
                ax,
                ay,
                ..
            } => {
                let mut x = ax[0] + ax[1] * px + ax[2] * py;
                let mut y = ay[0] + ay[1] * px + ay[2] * py;
                for (index, point) in points.iter().enumerate() {
                    let r2 = (px - point[0]).powi(2) + (py - point[1]).powi(2);
                    let basis = tps_basis(r2);
                    x += wx[index] * basis;
                    y += wy[index] * basis;
                }
                (x, y)
            }
        }
    }

    /// Inverse via Newton iterations; the affine hint gives the first guess.
    pub fn inverse(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let hint = match self {
            Transform::Poly { hint, .. } | Transform::Tps { hint, .. } => *hint,
        };
        let (mut px, mut py) = hint.inverse_point(x, y);
        for _ in 0..40 {
            let (fx, fy) = self.apply(px, py);
            let ex = fx - x;
            let ey = fy - y;
            if ex * ex + ey * ey < 1e-4 {
                return Some((px, py));
            }
            let step = 0.5;
            let (gx, gy) = self.apply(px + step, py);
            let (hx, hy) = self.apply(px, py + step);
            let j11 = (gx - fx) / step;
            let j21 = (gy - fy) / step;
            let j12 = (hx - fx) / step;
            let j22 = (hy - fy) / step;
            let determinant = j11 * j22 - j12 * j21;
            if determinant.abs() < 1e-12 {
                return None;
            }
            let dx = (j22 * ex - j12 * ey) / determinant;
            let dy = (-j21 * ex + j11 * ey) / determinant;
            px -= dx;
            py -= dy;
            if !px.is_finite() || !py.is_finite() {
                return None;
            }
        }
        None
    }
}

const MAX_OUTPUT_PIXELS: u64 = 120_000_000;
const EARTH_RADIUS: f64 = 6_378_137.0;
const ORIGIN_SHIFT: f64 = std::f64::consts::PI * EARTH_RADIUS;

/// Longitude/latitude to EPSG:3857 metres.
pub fn mercator(lon: f64, lat: f64) -> (f64, f64) {
    let x = lon * ORIGIN_SHIFT / 180.0;
    let clamped = lat.clamp(-85.051_128_78, 85.051_128_78);
    let phi = std::f64::consts::PI * clamped / 180.0;
    let y = (std::f64::consts::FRAC_PI_4 + phi / 2.0).tan().ln() * EARTH_RADIUS;
    (x, y)
}

/// EPSG:3857 metres back to longitude/latitude.
#[allow(dead_code)] // Kept for callers that report bounds in degrees.
pub fn lonlat(x: f64, y: f64) -> (f64, f64) {
    let lon = x / ORIGIN_SHIFT * 180.0;
    let lat = (2.0 * (y / EARTH_RADIUS).exp().atan() - std::f64::consts::FRAC_PI_2).to_degrees();
    (lon, lat)
}

/// Which transform to fit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GeorefModel {
    /// Full affine transform: six parameters.
    Affine,
    /// Similarity (Helmert): scale, rotation and translation, four parameters.
    Helmert,
    /// Second-order polynomial: twelve parameters, for slightly warped scans.
    Poly,
    /// Thin plate spline: exact through control points, for rubber-sheet scans.
    Tps,
}

/// Fits an affine transform by least squares. Needs at least three points
/// that are not collinear on the scan.
pub fn solve(gcps: &[Gcp]) -> Result<GeorefSolution, String> {
    solve_model(gcps, GeorefModel::Affine)
}

/// Fits the requested transform by least squares.
pub fn solve_model(gcps: &[Gcp], model: GeorefModel) -> Result<GeorefSolution, String> {
    let required = match model {
        GeorefModel::Affine => 3,
        GeorefModel::Helmert => 2,
        GeorefModel::Poly => 6,
        GeorefModel::Tps => 3,
    };
    if gcps.len() < required {
        return Err(format!(
            "at least {required} ground control points are required"
        ));
    }
    if gcps
        .iter()
        .any(|gcp| !gcp.lon.is_finite() || !gcp.lat.is_finite())
    {
        return Err("a control point has invalid coordinates".to_owned());
    }

    let (affine, transform) = match model {
        GeorefModel::Affine => (fit_affine(gcps)?, None),
        GeorefModel::Helmert => (fit_helmert(gcps)?, None),
        GeorefModel::Poly => {
            let hint = fit_affine(gcps)?;
            (hint, Some(fit_poly(gcps, hint)?))
        }
        GeorefModel::Tps => {
            let hint = fit_affine(gcps)?;
            (hint, Some(fit_tps(gcps, hint)?))
        }
    };

    let mut squares = 0.0;
    let mut residuals = Vec::with_capacity(gcps.len());
    for gcp in gcps {
        let (x, y) = mercator(gcp.lon, gcp.lat);
        let (fx, fy) = match &transform {
            Some(transform) => transform.apply(gcp.px, gcp.py),
            None => affine.apply(gcp.px, gcp.py),
        };
        let error = ((fx - x).powi(2) + (fy - y).powi(2)).sqrt();
        squares += error * error;
        residuals.push(error);
    }
    let rmse = (squares / gcps.len() as f64).sqrt();

    Ok(GeorefSolution {
        affine,
        rmse,
        residuals,
        bounds: [0.0; 4],
        transform,
    })
}

fn fit_affine(gcps: &[Gcp]) -> Result<Affine, String> {
    let mut normal = [[0.0_f64; 3]; 3];
    let mut rhs_x = [0.0_f64; 3];
    let mut rhs_y = [0.0_f64; 3];
    for gcp in gcps {
        let (x, y) = mercator(gcp.lon, gcp.lat);
        let row = [gcp.px, gcp.py, 1.0];
        for (i, value) in row.iter().enumerate() {
            for (j, other) in row.iter().enumerate() {
                normal[i][j] += value * other;
            }
            rhs_x[i] += value * x;
            rhs_y[i] += value * y;
        }
    }
    let [a, b, c] =
        solve_linear(normal, rhs_x).ok_or("control points are collinear on the scan")?;
    let [d, e, f] =
        solve_linear(normal, rhs_y).ok_or("control points are collinear on the scan")?;
    Ok(Affine { a, b, c, d, e, f })
}

fn fit_helmert(gcps: &[Gcp]) -> Result<Affine, String> {
    // x = a*px - b*py + c, y = b*px + a*py + f.
    let mut normal = [[0.0_f64; 4]; 4];
    let mut rhs = [0.0_f64; 4];
    for gcp in gcps {
        let (x, y) = mercator(gcp.lon, gcp.lat);
        for (row, target) in [
            ([gcp.px, -gcp.py, 1.0, 0.0], x),
            ([gcp.py, gcp.px, 0.0, 1.0], y),
        ] {
            for (i, value) in row.iter().enumerate() {
                for (j, other) in row.iter().enumerate() {
                    normal[i][j] += value * other;
                }
                rhs[i] += value * target;
            }
        }
    }
    let parameters = solve_linear(normal, rhs).ok_or("control points are collinear on the scan")?;
    Ok(Affine {
        a: parameters[0],
        b: -parameters[1],
        c: parameters[2],
        d: parameters[1],
        e: parameters[0],
        f: parameters[3],
    })
}

fn fit_poly(gcps: &[Gcp], hint: Affine) -> Result<Transform, String> {
    let mut normal = [[0.0_f64; 6]; 6];
    let mut rhs_x = [0.0_f64; 6];
    let mut rhs_y = [0.0_f64; 6];
    for gcp in gcps {
        let (x, y) = mercator(gcp.lon, gcp.lat);
        let terms = poly_terms(gcp.px, gcp.py);
        for (i, value) in terms.iter().enumerate() {
            for (j, other) in terms.iter().enumerate() {
                normal[i][j] += value * other;
            }
            rhs_x[i] += value * x;
            rhs_y[i] += value * y;
        }
    }
    let matrix: Vec<Vec<f64>> = normal.iter().map(|row| row.to_vec()).collect();
    let cx = solve_dense(matrix.clone(), rhs_x.to_vec())
        .ok_or("control points do not define a polynomial")?;
    let cy =
        solve_dense(matrix, rhs_y.to_vec()).ok_or("control points do not define a polynomial")?;
    Ok(Transform::Poly {
        cx: [cx[0], cx[1], cx[2], cx[3], cx[4], cx[5]],
        cy: [cy[0], cy[1], cy[2], cy[3], cy[4], cy[5]],
        hint,
    })
}

fn fit_tps(gcps: &[Gcp], hint: Affine) -> Result<Transform, String> {
    let n = gcps.len();
    let size = n + 3;
    let mut matrix = vec![vec![0.0_f64; size]; size];
    let mut rhs_x = vec![0.0_f64; size];
    let mut rhs_y = vec![0.0_f64; size];
    for (i, gcp) in gcps.iter().enumerate() {
        let (x, y) = mercator(gcp.lon, gcp.lat);
        rhs_x[i] = x;
        rhs_y[i] = y;
        for (j, other) in gcps.iter().enumerate() {
            let r2 = (gcp.px - other.px).powi(2) + (gcp.py - other.py).powi(2);
            matrix[i][j] = tps_basis(r2);
        }
        matrix[i][n] = 1.0;
        matrix[i][n + 1] = gcp.px;
        matrix[i][n + 2] = gcp.py;
        matrix[n][i] = 1.0;
        matrix[n + 1][i] = gcp.px;
        matrix[n + 2][i] = gcp.py;
    }
    let solution_x = solve_dense(matrix.clone(), rhs_x)
        .ok_or("control points do not define a thin plate spline")?;
    let solution_y =
        solve_dense(matrix, rhs_y).ok_or("control points do not define a thin plate spline")?;
    Ok(Transform::Tps {
        points: gcps.iter().map(|gcp| [gcp.px, gcp.py]).collect(),
        wx: solution_x[..n].to_vec(),
        wy: solution_y[..n].to_vec(),
        ax: [solution_x[n], solution_x[n + 1], solution_x[n + 2]],
        ay: [solution_y[n], solution_y[n + 1], solution_y[n + 2]],
        hint,
    })
}

/// Extent of a non-linear transform across the whole scan.
fn extent_with(transform: &Transform, width: f64, height: f64) -> [f64; 4] {
    let corners = [
        transform.apply(0.0, 0.0),
        transform.apply(width, 0.0),
        transform.apply(width, height),
        transform.apply(0.0, height),
    ];
    [
        corners
            .iter()
            .map(|corner| corner.0)
            .fold(f64::INFINITY, f64::min),
        corners
            .iter()
            .map(|corner| corner.1)
            .fold(f64::INFINITY, f64::min),
        corners
            .iter()
            .map(|corner| corner.0)
            .fold(f64::NEG_INFINITY, f64::max),
        corners
            .iter()
            .map(|corner| corner.1)
            .fold(f64::NEG_INFINITY, f64::max),
    ]
}

/// Bounding box of the transformed scan: west, south, east, north.
pub fn extent(affine: &Affine, width: f64, height: f64) -> [f64; 4] {
    let corners = [
        affine.apply(0.0, 0.0),
        affine.apply(width, 0.0),
        affine.apply(width, height),
        affine.apply(0.0, height),
    ];
    [
        corners
            .iter()
            .map(|corner| corner.0)
            .fold(f64::INFINITY, f64::min),
        corners
            .iter()
            .map(|corner| corner.1)
            .fold(f64::INFINITY, f64::min),
        corners
            .iter()
            .map(|corner| corner.0)
            .fold(f64::NEG_INFINITY, f64::max),
        corners
            .iter()
            .map(|corner| corner.1)
            .fold(f64::NEG_INFINITY, f64::max),
    ]
}

/// Solves a dense system with partial pivoting; `None` when singular.
fn solve_dense(mut matrix: Vec<Vec<f64>>, mut rhs: Vec<f64>) -> Option<Vec<f64>> {
    let n = rhs.len();
    if matrix.len() != n || matrix.iter().any(|row| row.len() != n) {
        return None;
    }
    for column in 0..n {
        let mut pivot = column;
        for row in column + 1..n {
            if matrix[row][column].abs() > matrix[pivot][column].abs() {
                pivot = row;
            }
        }
        if matrix[pivot][column].abs() < 1e-12 {
            return None;
        }
        matrix.swap(column, pivot);
        rhs.swap(column, pivot);
        let pivot_row = matrix[column].clone();
        for row in column + 1..n {
            let factor = matrix[row][column] / pivot_row[column];
            for cell in column..n {
                matrix[row][cell] -= factor * pivot_row[cell];
            }
            rhs[row] -= factor * rhs[column];
        }
    }
    let mut result = vec![0.0_f64; n];
    for row in (0..n).rev() {
        let mut sum = rhs[row];
        for column in row + 1..n {
            sum -= matrix[row][column] * result[column];
        }
        result[row] = sum / matrix[row][row];
    }
    Some(result)
}

/// Solves a square system with partial pivoting; `None` when singular.
fn solve_linear<const N: usize>(mut matrix: [[f64; N]; N], mut rhs: [f64; N]) -> Option<[f64; N]> {
    for column in 0..N {
        let mut pivot = column;
        for row in column + 1..N {
            if matrix[row][column].abs() > matrix[pivot][column].abs() {
                pivot = row;
            }
        }
        if matrix[pivot][column].abs() < 1e-12 {
            return None;
        }
        matrix.swap(column, pivot);
        rhs.swap(column, pivot);
        let pivot_row = matrix[column];
        for row in column + 1..N {
            let factor = matrix[row][column] / pivot_row[column];
            for (cell, value) in matrix[row].iter_mut().enumerate().skip(column) {
                *value -= factor * pivot_row[cell];
            }
            rhs[row] -= factor * rhs[column];
        }
    }
    let mut result = [0.0_f64; N];
    for row in (0..N).rev() {
        let mut sum = rhs[row];
        for column in row + 1..N {
            sum -= matrix[row][column] * result[column];
        }
        result[row] = sum / matrix[row][row];
    }
    Some(result)
}

impl Affine {
    /// Applies the transform to a scan pixel.
    pub fn apply(&self, px: f64, py: f64) -> (f64, f64) {
        (
            self.a * px + self.b * py + self.c,
            self.d * px + self.e * py + self.f,
        )
    }

    /// Applies the inverse transform, falling back to the input on failure.
    pub fn inverse_point(&self, x: f64, y: f64) -> (f64, f64) {
        match self.invert() {
            Some(inverse) => inverse.apply(x, y),
            None => (x, y),
        }
    }

    /// Inverse transform, used when resampling the output grid.
    fn invert(&self) -> Option<Affine> {
        let determinant = self.a * self.e - self.b * self.d;
        if determinant.abs() < 1e-12 {
            return None;
        }
        let a = self.e / determinant;
        let b = -self.b / determinant;
        let d = -self.d / determinant;
        let e = self.a / determinant;
        let c = -(a * self.c + b * self.f);
        let f = -(d * self.c + e * self.f);
        Some(Affine { a, b, c, d, e, f })
    }
}

/// Runs the whole pipeline: fits the transform, resamples the scan and writes
/// a tiled EPSG:3857 GeoTIFF with overviews.
pub fn warp_to_cog(
    image: &RgbImage,
    gcps: &[Gcp],
    model: GeorefModel,
    output: &Path,
    resolution: Option<f64>,
) -> Result<WarpReport, String> {
    let solution = solve_model(gcps, model)?;
    let width = image.width() as f64;
    let height = image.height() as f64;

    let [west, south, east, north] = match &solution.transform {
        Some(transform) => extent_with(transform, width, height),
        None => extent(&solution.affine, width, height),
    };
    if !(west.is_finite() && east.is_finite() && south.is_finite() && north.is_finite()) {
        return Err("the transform produced an invalid extent".to_owned());
    }

    let natural = match &solution.transform {
        Some(transform) => {
            let (x0, y0) = transform.apply(0.0, 0.0);
            let (x1, y1) = transform.apply(1.0, 0.0);
            let (x2, y2) = transform.apply(0.0, 1.0);
            let det = ((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)).abs();
            det.sqrt().max(1e-6)
        }
        None => (solution.affine.a * solution.affine.e - solution.affine.b * solution.affine.d)
            .abs()
            .sqrt()
            .max(1e-6),
    };
    let resolution = resolution.filter(|value| *value > 0.0).unwrap_or(natural);
    let out_width = ((east - west) / resolution).ceil().max(1.0);
    let out_height = ((north - south) / resolution).ceil().max(1.0);
    if out_width * out_height > MAX_OUTPUT_PIXELS as f64 {
        return Err(format!(
            "the resampled scan would be {out_width}x{out_height} pixels; increase the resolution"
        ));
    }
    let out_width = out_width as u32;
    let out_height = out_height as u32;

    let transform = solution.transform.clone();
    if transform.is_none() && solution.affine.invert().is_none() {
        return Err("the affine transform is not invertible".to_owned());
    }
    let mut canvas = RgbImage::from_pixel(out_width, out_height, image::Rgb([0, 0, 0]));
    let source = image.as_raw();
    let source_width = image.width() as i64;
    let source_height = image.height() as i64;

    for row in 0..out_height {
        let y = north - (row as f64 + 0.5) * resolution;
        for column in 0..out_width {
            let x = west + (column as f64 + 0.5) * resolution;
            let (px, py) = match &transform {
                Some(transform) => match transform.inverse(x, y) {
                    Some(point) => point,
                    None => continue,
                },
                None => solution.affine.inverse_point(x, y),
            };
            if px < -0.5 || py < -0.5 || px > width - 0.5 || py > height - 0.5 {
                continue;
            }
            let color = sample_bilinear(source, source_width, source_height, px, py);
            canvas.put_pixel(column, row, color);
        }
    }

    let bytes = crate::export::build_geotiff(&canvas, west, north, resolution, resolution)?;
    std::fs::write(output, bytes)
        .map_err(|error| format!("cannot write {}: {error}", output.display()))?;

    Ok(WarpReport {
        solution,
        width: out_width,
        height: out_height,
        resolution,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarpReport {
    pub solution: GeorefSolution,
    pub width: u32,
    pub height: u32,
    pub resolution: f64,
}

fn sample_bilinear(source: &[u8], width: i64, height: i64, px: f64, py: f64) -> image::Rgb<u8> {
    let x0 = px.floor() as i64;
    let y0 = py.floor() as i64;
    let fx = px - x0 as f64;
    let fy = py - y0 as f64;
    let at = |x: i64, y: i64| -> [f64; 3] {
        let x = x.clamp(0, width - 1);
        let y = y.clamp(0, height - 1);
        let index = ((y * width + x) * 3) as usize;
        [
            f64::from(source[index]),
            f64::from(source[index + 1]),
            f64::from(source[index + 2]),
        ]
    };
    let top_left = at(x0, y0);
    let top_right = at(x0 + 1, y0);
    let bottom_left = at(x0, y0 + 1);
    let bottom_right = at(x0 + 1, y0 + 1);
    let mut channels = [0_u8; 3];
    for channel in 0..3 {
        let top = top_left[channel] * (1.0 - fx) + top_right[channel] * fx;
        let bottom = bottom_left[channel] * (1.0 - fx) + bottom_right[channel] * fx;
        channels[channel] = (top * (1.0 - fy) + bottom * fy).round().clamp(0.0, 255.0) as u8;
    }
    image::Rgb(channels)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scan covering exactly one degree around 10E/50N.
    fn exact_gcps() -> Vec<Gcp> {
        vec![
            Gcp {
                px: 0.0,
                py: 0.0,
                lon: 10.0,
                lat: 50.0,
            },
            Gcp {
                px: 100.0,
                py: 0.0,
                lon: 11.0,
                lat: 50.0,
            },
            Gcp {
                px: 0.0,
                py: 100.0,
                lon: 10.0,
                lat: 49.0,
            },
            Gcp {
                px: 100.0,
                py: 100.0,
                lon: 11.0,
                lat: 49.0,
            },
        ]
    }

    #[test]
    fn fits_an_exact_affine_with_zero_error() {
        let solution = solve(&exact_gcps()).unwrap();
        assert!(solution.rmse < 1.0, "rmse {}", solution.rmse);
        let (x, y) = solution.affine.apply(50.0, 50.0);
        let (x0, y0) = mercator(10.0, 50.0);
        let (x1, y1) = mercator(11.0, 49.0);
        assert!((x - (x0 + x1) / 2.0).abs() < 1.0);
        assert!((y - (y0 + y1) / 2.0).abs() < 1.0);
    }

    #[test]
    fn reports_the_error_of_noisy_points() {
        let mut gcps = exact_gcps();
        gcps[0].lon += 0.001; // ~70 m at this latitude
        let solution = solve(&gcps).unwrap();
        assert!(
            solution.rmse > 1.0 && solution.rmse < 200.0,
            "rmse {}",
            solution.rmse
        );
        assert_eq!(solution.residuals.len(), 4);
    }

    #[test]
    fn fits_a_similarity_exactly() {
        // Scale 2, rotation 30 degrees, translation; 2 points suffice.
        let angle: f64 = 30.0_f64.to_radians();
        let (a, b) = (2.0 * angle.cos(), 2.0 * angle.sin());
        let gcps: Vec<Gcp> = [(0.0, 0.0), (60.0, 20.0)]
            .into_iter()
            .map(|(px, py)| {
                let x = 1_000_000.0 + a * px - b * py + 500.0;
                let y = 6_000_000.0 + b * px + a * py - 200.0;
                let (lon, lat) = lonlat(x, y);
                Gcp { px, py, lon, lat }
            })
            .collect();
        let solution = solve_model(&gcps, GeorefModel::Helmert).unwrap();
        assert!(solution.rmse < 0.5, "rmse {}", solution.rmse);
        assert!((solution.affine.a - a).abs() < 1e-6);
        assert!((solution.affine.b + b).abs() < 1e-6);
        assert!((solution.affine.d - b).abs() < 1e-6);
    }

    #[test]
    fn helmert_needs_two_points_and_affine_three() {
        let one = [Gcp {
            px: 0.0,
            py: 0.0,
            lon: 10.0,
            lat: 50.0,
        }];
        assert!(solve_model(&one, GeorefModel::Helmert).is_err());
        let two = [
            Gcp {
                px: 0.0,
                py: 0.0,
                lon: 10.0,
                lat: 50.0,
            },
            Gcp {
                px: 10.0,
                py: 10.0,
                lon: 10.1,
                lat: 50.1,
            },
        ];
        assert!(solve_model(&two, GeorefModel::Helmert).is_ok());
        assert!(solve_model(&two, GeorefModel::Affine).is_err());
    }

    fn quadratic_gcps() -> Vec<Gcp> {
        let (bx, by) = mercator(10.0, 50.0);
        [
            (0.0, 0.0),
            (100.0, 0.0),
            (0.0, 100.0),
            (100.0, 100.0),
            (50.0, 0.0),
            (0.0, 50.0),
            (100.0, 50.0),
            (50.0, 100.0),
        ]
        .into_iter()
        .map(|(px, py)| {
            let x = bx + 80.0 * px + 0.02 * py * py;
            let y = by - 80.0 * py + 0.01 * px * py;
            let (lon, lat) = lonlat(x, y);
            Gcp { px, py, lon, lat }
        })
        .collect()
    }

    #[test]
    fn polynomial_fits_a_quadratic_warp() {
        let gcps = quadratic_gcps();
        let solution = solve_model(&gcps, GeorefModel::Poly).unwrap();
        assert!(solution.rmse < 0.01, "rmse {}", solution.rmse);
        assert!(solution.transform.is_some());
        let (x, y) = solution.transform.as_ref().unwrap().apply(25.0, 25.0);
        let expected = lonlat_to_mercator_for_test(10.0, 50.0, 25.0, 25.0);
        assert!((x - expected.0).abs() < 1.0);
        assert!((y - expected.1).abs() < 1.0);
    }

    fn lonlat_to_mercator_for_test(base_lon: f64, base_lat: f64, px: f64, py: f64) -> (f64, f64) {
        let (bx, by) = mercator(base_lon, base_lat);
        (
            bx + 80.0 * px + 0.02 * py * py,
            by - 80.0 * py + 0.01 * px * py,
        )
    }

    #[test]
    fn polynomial_needs_six_points() {
        let gcps = &quadratic_gcps()[..5];
        assert!(solve_model(gcps, GeorefModel::Poly).is_err());
    }

    #[test]
    fn thin_plate_spline_passes_through_points() {
        let gcps = quadratic_gcps();
        let solution = solve_model(&gcps, GeorefModel::Tps).unwrap();
        assert!(solution.rmse < 0.5, "rmse {}", solution.rmse);
        let transform = solution.transform.as_ref().unwrap();
        let (x, y) = transform.apply(50.0, 50.0);
        let (px, py) = transform.inverse(x, y).unwrap();
        assert!((px - 50.0).abs() < 0.05, "px {px}");
        assert!((py - 50.0).abs() < 0.05, "py {py}");
    }

    #[test]
    fn thin_plate_spline_needs_three_points() {
        let gcps = &quadratic_gcps()[..2];
        assert!(solve_model(gcps, GeorefModel::Tps).is_err());
    }

    #[test]
    fn rejects_collinear_points() {
        let gcps = vec![
            Gcp {
                px: 0.0,
                py: 0.0,
                lon: 10.0,
                lat: 50.0,
            },
            Gcp {
                px: 10.0,
                py: 10.0,
                lon: 10.1,
                lat: 50.1,
            },
            Gcp {
                px: 20.0,
                py: 20.0,
                lon: 10.2,
                lat: 50.2,
            },
        ];
        assert!(solve(&gcps).is_err());
    }

    #[test]
    fn rejects_too_few_points() {
        assert!(
            solve(&[Gcp {
                px: 0.0,
                py: 0.0,
                lon: 10.0,
                lat: 50.0
            }])
            .is_err()
        );
    }

    #[test]
    fn inverts_the_transform() {
        let affine = Affine {
            a: 2.0,
            b: 0.5,
            c: 10.0,
            d: -0.3,
            e: 3.0,
            f: -5.0,
        };
        let inverse = affine.invert().unwrap();
        let (x, y) = affine.apply(12.0, 34.0);
        let (px, py) = inverse.apply(x, y);
        assert!((px - 12.0).abs() < 1e-9);
        assert!((py - 34.0).abs() < 1e-9);
    }

    #[test]
    fn warps_a_scan_into_a_geotiff() {
        let directory = std::env::temp_dir().join(format!("mappa-georef-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let output = directory.join("scan.tif");
        let image = RgbImage::from_fn(100, 100, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        let report =
            warp_to_cog(&image, &exact_gcps(), GeorefModel::Affine, &output, None).unwrap();
        assert!(report.width > 0 && report.height > 0);
        let bytes = std::fs::read(&output).unwrap();
        assert!(bytes.starts_with(b"II*\0"), "not a TIFF: {:?}", &bytes[..4]);
        assert!(report.solution.rmse < 1.0);
        std::fs::remove_dir_all(&directory).ok();
    }
}

/// Fits the transform and reports the error without touching the scan.
#[tauri::command]
pub async fn georef_solve(
    gcps: Vec<Gcp>,
    width: u32,
    height: u32,
) -> Result<GeorefSolution, String> {
    let mut solution = solve(&gcps)?;
    solution.bounds = extent(&solution.affine, f64::from(width), f64::from(height));
    Ok(solution)
}

/// Resamples the scan and writes a GeoTIFF/COG.
#[tauri::command]
pub async fn georef_warp(
    input: String,
    output: String,
    gcps: Vec<Gcp>,
    resolution: Option<f64>,
    model: Option<GeorefModel>,
) -> Result<WarpReport, String> {
    let image = image::open(&input).map_err(|error| format!("cannot open {input}: {error}"))?;
    let rgb = image.to_rgb8();
    if u64::from(rgb.width()) * u64::from(rgb.height()) > 200_000_000 {
        return Err("the scan is larger than 200 megapixels".to_owned());
    }
    if !output.ends_with(".tif") && !output.ends_with(".tiff") {
        return Err("the output must end with .tif or .tiff".to_owned());
    }
    warp_to_cog(
        &rgb,
        &gcps,
        model.unwrap_or(GeorefModel::Affine),
        Path::new(&output),
        resolution,
    )
}
