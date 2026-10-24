//! Read-only GeoPackage feature import.
//!
//! GeoPackage stores geometry as a small binary header followed by ISO WKB.
//! Reading it directly through the SQLite driver already used by the tile
//! cache avoids a GDAL dependency. Coordinates are transformed to WGS84 with
//! the same proj4 engine as the rest of the app.

use std::path::Path;

use mappa_core::{Crs, CrsSpec};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{Map, Value, json};

const MAX_FEATURES: usize = 50_000;
const MAX_POINTS: usize = 2_000_000;
const MAX_PROPERTIES: usize = 64;
const MAX_DEPTH: usize = 48;

/// Features read from one GeoPackage table.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoPackageImport {
    /// Table name, used as the layer name.
    pub name: String,
    /// Human-readable coordinate reference system.
    pub srs: String,
    /// GeoJSON features.
    pub features: Vec<Value>,
    /// Rows with an unreadable or empty geometry.
    pub skipped: usize,
    /// True when the feature limit stopped the scan.
    pub truncated: bool,
}

/// A feature table offered in the import dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoPackageLayer {
    /// Table name.
    pub name: String,
    /// Human-readable coordinate reference system.
    pub srs: String,
    /// Declared geometry type (`POINT`, `MULTIPOLYGON`, …).
    pub geometry_type: String,
    /// Approximate row count.
    pub features: i64,
}

fn open(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("cannot open GeoPackage: {error}"))
}

/// Lists feature tables so the user can choose one before importing.
pub fn layers(path: &Path) -> Result<Vec<GeoPackageLayer>, String> {
    let connection = open(path)?;
    let mut statement = connection
        .prepare(
            "SELECT c.table_name, g.srs_id, g.geometry_type_name
             FROM gpkg_contents c
             JOIN gpkg_geometry_columns g ON g.table_name = c.table_name
             WHERE c.data_type = 'features'
             ORDER BY c.table_name
             LIMIT 64",
        )
        .map_err(|error| format!("no feature layer in GeoPackage: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let name: String = row.get(0)?;
            let srs_id: i64 = row.get(1)?;
            let geometry_type: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
            Ok((name, srs_id, geometry_type))
        })
        .map_err(|error| format!("cannot read GeoPackage layers: {error}"))?;
    let mut result = Vec::new();
    for row in rows {
        let (name, srs_id, geometry_type) =
            row.map_err(|error| format!("cannot read GeoPackage layers: {error}"))?;
        let features = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM {}", quote_ident(&name)),
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0);
        result.push(GeoPackageLayer {
            name,
            srs: srs_label(&connection, srs_id),
            geometry_type: if geometry_type.is_empty() {
                "GEOMETRY".to_owned()
            } else {
                geometry_type
            },
            features,
        });
    }
    Ok(result)
}

/// Reads the first feature table in a GeoPackage.
#[cfg(test)]
pub fn import(path: &Path) -> Result<GeoPackageImport, String> {
    import_layer(path, None)
}

/// Reads one feature table; `layer` defaults to the first table.
pub fn import_layer(path: &Path, layer: Option<&str>) -> Result<GeoPackageImport, String> {
    let connection = open(path)?;

    let (table, column, srs_id): (String, String, i64) = connection
        .query_row(
            "SELECT c.table_name, g.column_name, g.srs_id
             FROM gpkg_contents c
             JOIN gpkg_geometry_columns g ON g.table_name = c.table_name
             WHERE c.data_type = 'features'
               AND (?1 IS NULL OR c.table_name = ?1)
             ORDER BY c.table_name
             LIMIT 1",
            [layer],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| match layer {
            Some(layer) => format!("no GeoPackage layer {layer:?}: {error}"),
            None => format!("no feature layer in GeoPackage: {error}"),
        })?;

    let srs = srs_label(&connection, srs_id);
    let crs = if srs_id == 4326 {
        None
    } else {
        let code = u16::try_from(srs_id)
            .map_err(|_| format!("GeoPackage SRS {srs_id} is not supported"))?;
        if code == 0 {
            return Err("GeoPackage uses an undefined Cartesian SRS".to_owned());
        }
        Some(Crs::new(&CrsSpec::from_epsg(code))?)
    };

    let sql = format!("SELECT * FROM {}", quote_ident(&table));
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("cannot read {table}: {error}"))?;
    let columns = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    let geometry_index = columns
        .iter()
        .position(|name| name.eq_ignore_ascii_case(&column))
        .ok_or_else(|| format!("geometry column {column:?} is missing"))?;

    let mut rows = statement
        .query([])
        .map_err(|error| format!("cannot query {table}: {error}"))?;
    let mut features = Vec::new();
    let mut skipped = 0;
    let mut truncated = false;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("cannot read {table}: {error}"))?
    {
        if features.len() >= MAX_FEATURES {
            truncated = true;
            break;
        }
        let geometry = match row.get_ref(geometry_index) {
            Ok(ValueRef::Blob(blob)) => parse_geometry(blob, crs.as_ref()),
            _ => None,
        };
        let Some(geometry) = geometry else {
            skipped += 1;
            continue;
        };
        let mut properties = Map::new();
        for (index, name) in columns.iter().enumerate() {
            if index == geometry_index || properties.len() >= MAX_PROPERTIES {
                continue;
            }
            let value = match row.get_ref(index) {
                Ok(ValueRef::Null) | Err(_) => continue,
                Ok(ValueRef::Integer(value)) => json!(value),
                Ok(ValueRef::Real(value)) if value.is_finite() => json!(value),
                Ok(ValueRef::Text(value)) => {
                    let text = String::from_utf8_lossy(value);
                    json!(text.chars().take(2000).collect::<String>())
                }
                Ok(ValueRef::Blob(_)) => continue,
                Ok(_) => continue,
            };
            properties.insert(name.clone(), value);
        }
        features.push(json!({
            "type": "Feature",
            "geometry": geometry,
            "properties": Value::Object(properties),
        }));
    }

    Ok(GeoPackageImport {
        name: table,
        srs,
        features,
        skipped,
        truncated,
    })
}

fn srs_label(connection: &Connection, srs_id: i64) -> String {
    connection
        .query_row(
            "SELECT organization || ':' || organization_coordsys_id
             FROM gpkg_spatial_ref_sys WHERE srs_id = ?1",
            [srs_id],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| format!("EPSG:{srs_id}"))
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Strips the GeoPackage binary header and parses the WKB payload.
fn parse_geometry(blob: &[u8], crs: Option<&Crs>) -> Option<Value> {
    if blob.len() < 8 || &blob[0..2] != b"GP" {
        return None;
    }
    let flags = blob[3];
    if flags & 0x10 != 0 {
        return None; // empty geometry
    }
    let envelope = match (flags >> 1) & 0x07 {
        0 => 0,
        1 => 32,
        2 | 3 => 48,
        4 => 64,
        _ => return None,
    };
    let start = 8 + envelope;
    if start > blob.len() {
        return None;
    }
    let mut reader = Wkb {
        data: &blob[start..],
        pos: 0,
        points: 0,
        crs,
    };
    let geometry = reader.geometry(0)?;
    if reader.points > MAX_POINTS {
        return None;
    }
    Some(geometry)
}

struct Wkb<'a> {
    data: &'a [u8],
    pos: usize,
    points: usize,
    crs: Option<&'a Crs>,
}

impl Wkb<'_> {
    fn byte(&mut self) -> Option<u8> {
        let value = *self.data.get(self.pos)?;
        self.pos += 1;
        Some(value)
    }

    fn u32(&mut self, little: bool) -> Option<u32> {
        let bytes = self.data.get(self.pos..self.pos + 4)?;
        self.pos += 4;
        Some(if little {
            u32::from_le_bytes(bytes.try_into().ok()?)
        } else {
            u32::from_be_bytes(bytes.try_into().ok()?)
        })
    }

    fn f64(&mut self, little: bool) -> Option<f64> {
        let bytes = self.data.get(self.pos..self.pos + 8)?;
        self.pos += 8;
        Some(if little {
            f64::from_le_bytes(bytes.try_into().ok()?)
        } else {
            f64::from_be_bytes(bytes.try_into().ok()?)
        })
    }

    fn position(&mut self, little: bool, z: bool, m: bool) -> Option<Value> {
        let x = self.f64(little)?;
        let y = self.f64(little)?;
        if z {
            self.f64(little)?;
        }
        if m {
            self.f64(little)?;
        }
        self.points += 1;
        if self.points > MAX_POINTS {
            return None;
        }
        let (lon, lat) = match self.crs {
            Some(crs) => crs.to_wgs84(x, y).ok()?,
            None => (x, y),
        };
        if !lon.is_finite()
            || !lat.is_finite()
            || !(-180.0..=180.0).contains(&lon)
            || !(-90.0..=90.0).contains(&lat)
        {
            return None;
        }
        Some(json!([lon, lat]))
    }

    fn positions(&mut self, little: bool, count: u32, z: bool, m: bool) -> Option<Vec<Value>> {
        let width = 16 + if z { 8 } else { 0 } + if m { 8 } else { 0 };
        if count as usize > MAX_POINTS
            || count as usize * width > self.data.len().saturating_sub(self.pos)
        {
            return None;
        }
        let mut positions = Vec::with_capacity(count as usize);
        for _ in 0..count {
            positions.push(self.position(little, z, m)?);
        }
        Some(positions)
    }

    fn ring(&mut self, little: bool, z: bool, m: bool) -> Option<Vec<Value>> {
        let count = self.u32(little)?;
        let mut positions = self.positions(little, count, z, m)?;
        if let (Some(first), Some(last)) = (positions.first(), positions.last())
            && first != last
        {
            positions.push(first.clone());
        }
        Some(positions)
    }

    fn geometry(&mut self, depth: usize) -> Option<Value> {
        if depth > MAX_DEPTH {
            return None;
        }
        let order = self.byte()?;
        let little = match order {
            0 => false,
            1 => true,
            _ => return None,
        };
        let raw = self.u32(little)?;
        let ewkb_z = raw & 0x8000_0000 != 0;
        let ewkb_m = raw & 0x4000_0000 != 0;
        let variant = (raw & 0x0fff_ffff) / 1000;
        let base = (raw & 0x0fff_ffff) % 1000;
        let z = ewkb_z || matches!(variant, 1 | 3);
        let m = ewkb_m || matches!(variant, 2 | 3);
        match base {
            1 => self
                .position(little, z, m)
                .map(|point| json!({ "type": "Point", "coordinates": point })),
            2 => {
                let count = self.u32(little)?;
                self.positions(little, count, z, m)
                    .map(|coordinates| json!({ "type": "LineString", "coordinates": coordinates }))
            }
            3 => {
                let count = self.u32(little)?;
                if count as usize > MAX_POINTS {
                    return None;
                }
                let mut rings = Vec::with_capacity(count as usize);
                for _ in 0..count {
                    rings.push(self.ring(little, z, m)?);
                }
                Some(json!({ "type": "Polygon", "coordinates": rings }))
            }
            4 => {
                let count = self.u32(little)?;
                self.positions(little, count, z, m)
                    .map(|coordinates| json!({ "type": "MultiPoint", "coordinates": coordinates }))
            }
            5 => {
                let count = self.u32(little)?;
                if count as usize > MAX_POINTS {
                    return None;
                }
                let mut lines = Vec::with_capacity(count as usize);
                for _ in 0..count {
                    let points = self.u32(little)?;
                    lines.push(self.positions(little, points, z, m)?);
                }
                Some(json!({ "type": "MultiLineString", "coordinates": lines }))
            }
            6 => {
                let count = self.u32(little)?;
                if count as usize > MAX_POINTS {
                    return None;
                }
                let mut polygons = Vec::with_capacity(count as usize);
                for _ in 0..count {
                    let rings = self.u32(little)?;
                    if rings as usize > MAX_POINTS {
                        return None;
                    }
                    let mut polygon = Vec::with_capacity(rings as usize);
                    for _ in 0..rings {
                        polygon.push(self.ring(little, z, m)?);
                    }
                    polygons.push(polygon);
                }
                Some(json!({ "type": "MultiPolygon", "coordinates": polygons }))
            }
            7 => {
                let count = self.u32(little)?;
                if count as usize > MAX_POINTS {
                    return None;
                }
                let mut geometries = Vec::with_capacity(count as usize);
                for _ in 0..count {
                    geometries.push(self.geometry(depth + 1)?);
                }
                Some(json!({
                    "type": "GeometryCollection",
                    "geometries": geometries,
                }))
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn point_blob(srs: i32, lon: f64, lat: f64) -> Vec<u8> {
        let mut blob = Vec::new();
        blob.extend_from_slice(b"GP");
        blob.push(0); // version
        blob.push(1); // little endian, no envelope, not empty
        blob.extend_from_slice(&srs.to_le_bytes());
        blob.push(1); // little-endian WKB
        blob.extend_from_slice(&1_u32.to_le_bytes());
        blob.extend_from_slice(&lon.to_le_bytes());
        blob.extend_from_slice(&lat.to_le_bytes());
        blob
    }

    fn database() -> (std::path::PathBuf, Connection) {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("mappa-gpkg-{}-{stamp}.gpkg", std::process::id()));
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE gpkg_contents (table_name TEXT, data_type TEXT);
                 CREATE TABLE gpkg_geometry_columns
                   (table_name TEXT, column_name TEXT, srs_id INTEGER,
                    geometry_type_name TEXT NOT NULL DEFAULT 'POINT');
                 CREATE TABLE gpkg_spatial_ref_sys
                   (srs_id INTEGER, organization TEXT, organization_coordsys_id INTEGER);
                 CREATE TABLE places (fid INTEGER PRIMARY KEY, geom BLOB, name TEXT, height REAL);
                 INSERT INTO gpkg_spatial_ref_sys VALUES (4326, 'EPSG', 4326);
                 INSERT INTO gpkg_contents VALUES ('places', 'features');
                 INSERT INTO gpkg_geometry_columns (table_name, column_name, srs_id) VALUES ('places', 'geom', 4326);",
            )
            .unwrap();
        (path, connection)
    }

    #[test]
    fn imports_points_and_attributes() {
        let (path, connection) = database();
        connection
            .execute(
                "INSERT INTO places (geom, name, height) VALUES (?1, 'Москва', 156)",
                [point_blob(4326, 37.6, 55.7)],
            )
            .unwrap();
        drop(connection);
        let imported = import(&path).unwrap();
        assert_eq!(imported.name, "places");
        assert_eq!(imported.srs, "EPSG:4326");
        assert_eq!(imported.features.len(), 1);
        assert_eq!(imported.skipped, 0);
        let feature = &imported.features[0];
        assert_eq!(feature["geometry"]["type"], "Point");
        assert_eq!(feature["geometry"]["coordinates"][0], 37.6);
        assert_eq!(feature["properties"]["name"], "Москва");
        assert_eq!(feature["properties"]["height"], 156.0);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn transforms_web_mercator_and_skips_empty_geometries() {
        let (path, connection) = database();
        connection
            .execute(
                "UPDATE gpkg_spatial_ref_sys SET srs_id = 3857, organization_coordsys_id = 3857",
                [],
            )
            .unwrap();
        connection
            .execute("UPDATE gpkg_geometry_columns SET srs_id = 3857", [])
            .unwrap();
        let radius = 6_378_137.0_f64;
        connection
            .execute(
                "INSERT INTO places (geom, name) VALUES (?1, 'Null island')",
                [point_blob(3857, 0.0, 0.0)],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO places (geom, name) VALUES (?1, 'Empty')",
                [Vec::<u8>::new()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO places (geom, name) VALUES (?1, 'East')",
                [point_blob(3857, radius * std::f64::consts::FRAC_PI_4, 0.0)],
            )
            .unwrap();
        drop(connection);
        let imported = import(&path).unwrap();
        assert_eq!(imported.features.len(), 2);
        assert_eq!(imported.skipped, 1);
        let east = imported.features[1]["geometry"]["coordinates"]
            .as_array()
            .unwrap();
        assert!((east[0].as_f64().unwrap() - 45.0).abs() < 1e-9);
        assert!(east[1].as_f64().unwrap().abs() < 1e-9);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn lists_and_selects_feature_tables() {
        let (path, connection) = database();
        connection
            .execute_batch(
                "CREATE TABLE tracks (fid INTEGER PRIMARY KEY, geom BLOB, label TEXT);
                 INSERT INTO gpkg_contents VALUES ('tracks', 'features');
                 INSERT INTO gpkg_geometry_columns (table_name, column_name, srs_id) VALUES ('tracks', 'geom', 4326);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO tracks (geom, label) VALUES (?1, 'route')",
                [point_blob(4326, 34.1, 44.9)],
            )
            .unwrap();
        let listed = layers(&path).unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|layer| layer.name.as_str())
                .collect::<Vec<_>>(),
            vec!["places", "tracks"]
        );
        assert_eq!(listed[1].features, 1);
        let selected = import_layer(&path, Some("tracks")).unwrap();
        assert_eq!(selected.name, "tracks");
        assert_eq!(selected.features.len(), 1);
        assert!(import_layer(&path, Some("missing")).is_err());
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn parses_polygon_and_geometry_collection() {
        let mut wkb = Vec::new();
        // GeometryCollection with a polygon and a point.
        wkb.push(1); // little-endian WKB
        wkb.extend_from_slice(&7_u32.to_le_bytes());
        wkb.extend_from_slice(&2_u32.to_le_bytes());
        // Polygon with one ring of four points.
        wkb.push(1);
        wkb.extend_from_slice(&3_u32.to_le_bytes());
        wkb.extend_from_slice(&1_u32.to_le_bytes());
        wkb.extend_from_slice(&4_u32.to_le_bytes());
        for point in [(0.0_f64, 0.0_f64), (1.0, 0.0), (1.0, 1.0), (0.0, 0.0)] {
            wkb.extend_from_slice(&point.0.to_le_bytes());
            wkb.extend_from_slice(&point.1.to_le_bytes());
        }
        // Point.
        wkb.push(1);
        wkb.extend_from_slice(&1_u32.to_le_bytes());
        wkb.extend_from_slice(&2.0_f64.to_le_bytes());
        wkb.extend_from_slice(&3.0_f64.to_le_bytes());
        let mut blob = Vec::new();
        blob.extend_from_slice(b"GP");
        blob.push(0);
        blob.push(1);
        blob.extend_from_slice(&4326_i32.to_le_bytes());
        blob.extend_from_slice(&wkb);
        let geometry = parse_geometry(&blob, None).unwrap();
        assert_eq!(geometry["type"], "GeometryCollection");
        assert_eq!(geometry["geometries"][0]["type"], "Polygon");
        assert_eq!(geometry["geometries"][1]["coordinates"][1], 3.0);
    }

    #[test]
    fn rejects_files_without_feature_layers() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "mappa-gpkg-empty-{}-{stamp}.gpkg",
            std::process::id()
        ));
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("CREATE TABLE unrelated (id INTEGER);")
            .unwrap();
        drop(connection);
        assert!(import(&path).is_err());
        std::fs::remove_file(path).ok();
    }
}
