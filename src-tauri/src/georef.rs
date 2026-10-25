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
}

const MAX_OUTPUT_PIXELS: u64 = 120_000_000;
const EARTH_RADIUS: f64 = 6_378_137.0;
const ORIGIN_SHIFT: f64 = std::f64::consts::PI * EARTH_RADIUS;

/// Longitude/latitude to EPSG:3857 metres.
pub fn mercator(lon: f64, lat: f64) -> (f64, f64) {
    let x = lon * ORIGIN_SHIFT / 180.0;
    let clamped = lat.clamp(-85.051_128_78, 85.051_128_78);
    let y = (std::f64::consts::PI * clamped / 180.0).tan().ln() * EARTH_RADIUS;
    (x, y)
}

/// EPSG:3857 metres back to longitude/latitude.
#[allow(dead_code)] // Kept for callers that report bounds in degrees.
pub fn lonlat(x: f64, y: f64) -> (f64, f64) {
    let lon = x / ORIGIN_SHIFT * 180.0;
    let lat = (2.0 * (y / EARTH_RADIUS).exp().atan() - std::f64::consts::FRAC_PI_2).to_degrees();
    (lon, lat)
}

/// Fits an affine transform by least squares. Needs at least three points
/// that are not collinear on the scan.
pub fn solve(gcps: &[Gcp]) -> Result<GeorefSolution, String> {
    if gcps.len() < 3 {
        return Err("at least three ground control points are required".to_owned());
    }
    if gcps
        .iter()
        .any(|gcp| !gcp.lon.is_finite() || !gcp.lat.is_finite())
    {
        return Err("a control point has invalid coordinates".to_owned());
    }

    let mut normal = [[0.0_f64; 3]; 3];
    let mut rhs_x = [0.0_f64; 3];
    let mut rhs_y = [0.0_f64; 3];
    for gcp in gcps {
        let (x, y) = mercator(gcp.lon, gcp.lat);
        let row = [gcp.px, gcp.py, 1.0];
        for i in 0..3 {
            for j in 0..3 {
                normal[i][j] += row[i] * row[j];
            }
            rhs_x[i] += row[i] * x;
            rhs_y[i] += row[i] * y;
        }
    }

    let (a, b, c) = solve3(normal, rhs_x).ok_or("control points are collinear on the scan")?;
    let (d, e, f) = solve3(normal, rhs_y).ok_or("control points are collinear on the scan")?;
    let affine = Affine { a, b, c, d, e, f };

    let mut squares = 0.0;
    let mut residuals = Vec::with_capacity(gcps.len());
    for gcp in gcps {
        let (x, y) = mercator(gcp.lon, gcp.lat);
        let dx = affine.a * gcp.px + affine.b * gcp.py + affine.c - x;
        let dy = affine.d * gcp.px + affine.e * gcp.py + affine.f - y;
        let error = (dx * dx + dy * dy).sqrt();
        squares += error * error;
        residuals.push(error);
    }
    let rmse = (squares / gcps.len() as f64).sqrt();

    Ok(GeorefSolution {
        affine,
        rmse,
        residuals,
        bounds: [0.0; 4],
    })
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

/// Solves a 3x3 system with partial pivoting; `None` when singular.
fn solve3(mut matrix: [[f64; 3]; 3], mut rhs: [f64; 3]) -> Option<(f64, f64, f64)> {
    for column in 0..3 {
        let mut pivot = column;
        for row in column + 1..3 {
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
        for row in column + 1..3 {
            let factor = matrix[row][column] / pivot_row[column];
            for (cell, value) in matrix[row].iter_mut().enumerate().skip(column) {
                *value -= factor * pivot_row[cell];
            }
            rhs[row] -= factor * rhs[column];
        }
    }
    let mut result = [0.0_f64; 3];
    for row in (0..3).rev() {
        let mut sum = rhs[row];
        for column in row + 1..3 {
            sum -= matrix[row][column] * result[column];
        }
        result[row] = sum / matrix[row][row];
    }
    Some((result[0], result[1], result[2]))
}

impl Affine {
    /// Applies the transform to a scan pixel.
    pub fn apply(&self, px: f64, py: f64) -> (f64, f64) {
        (
            self.a * px + self.b * py + self.c,
            self.d * px + self.e * py + self.f,
        )
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
    output: &Path,
    resolution: Option<f64>,
) -> Result<WarpReport, String> {
    let solution = solve(gcps)?;
    let width = image.width() as f64;
    let height = image.height() as f64;

    let [west, south, east, north] = extent(&solution.affine, width, height);
    if !(west.is_finite() && east.is_finite() && south.is_finite() && north.is_finite()) {
        return Err("the transform produced an invalid extent".to_owned());
    }

    let det = (solution.affine.a * solution.affine.e - solution.affine.b * solution.affine.d).abs();
    let natural = det.sqrt().max(1e-6);
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

    let inverse = solution
        .affine
        .invert()
        .ok_or("the affine transform is not invertible")?;
    let mut canvas = RgbImage::from_pixel(out_width, out_height, image::Rgb([0, 0, 0]));
    let source = image.as_raw();
    let source_width = image.width() as i64;
    let source_height = image.height() as i64;

    for row in 0..out_height {
        let y = north - (row as f64 + 0.5) * resolution;
        for column in 0..out_width {
            let x = west + (column as f64 + 0.5) * resolution;
            let (px, py) = inverse.apply(x, y);
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
        let report = warp_to_cog(&image, &exact_gcps(), &output, None).unwrap();
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
) -> Result<WarpReport, String> {
    let image = image::open(&input).map_err(|error| format!("cannot open {input}: {error}"))?;
    let rgb = image.to_rgb8();
    if u64::from(rgb.width()) * u64::from(rgb.height()) > 200_000_000 {
        return Err("the scan is larger than 200 megapixels".to_owned());
    }
    if !output.ends_with(".tif") && !output.ends_with(".tiff") {
        return Err("the output must end with .tif or .tiff".to_owned());
    }
    warp_to_cog(&rgb, &gcps, Path::new(&output), resolution)
}
