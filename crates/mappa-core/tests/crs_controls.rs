use mappa_core::{Crs, CrsSpec, crs::local_presets};

fn epsg(code: u16) -> Crs {
    Crs::new(&CrsSpec::from_epsg(code)).unwrap()
}

#[test]
fn sk42_projection_controls_in_both_directions() {
    let controls: Vec<(String, f64, f64, f64, f64)> = serde_yaml_ng::from_str(include_str!(
        "../../../testdata/crs/projection-controls.yaml"
    ))
    .unwrap();
    assert_eq!(controls.len(), 11);
    let geographic = epsg(4284);
    let presets = local_presets();
    for (id, lat, lon, north, east) in controls {
        let target = match id.parse::<u16>() {
            Ok(code) => epsg(code),
            Err(_) => {
                let preset = presets.iter().find(|preset| preset.id == id).unwrap();
                Crs::new(&CrsSpec::from_proj(&preset.proj)).unwrap()
            }
        };
        let (e, n) = geographic.transform_to(&target, lon, lat).unwrap();
        assert!(
            (e - east).hypot(n - north) < 0.01,
            "{id} at ({lon}, {lat}): ({e}, {n})"
        );
        let (l, b) = target.transform_to(&geographic, east, north).unwrap();
        assert!(
            (l - lon).abs() < 1e-7 && (b - lat).abs() < 1e-7,
            "{id}: ({l}, {b})"
        );
    }
}

#[test]
fn ziminskoe_msk90_to_sk42_zone_6() {
    let preset = Crs::new(&CrsSpec::from_proj(mappa_core::crs::MSK90_ZONE_1)).unwrap();
    let (e, n) = preset
        .transform_to(&epsg(28406), 4_380_186.30, 5_041_865.80)
        .unwrap();
    assert!(
        (e - 6_541_168.76).hypot(n - 5_050_702.21) < 0.02,
        "{e}, {n}"
    );
}

#[test]
fn photomod_sk42_to_wgs84_horizontal_control() {
    // ECEF triples and their ellipsoid-specific conversion are documented in the source notes.
    let crs = epsg(4284);
    let (lon, lat) = crs.to_wgs84(37.61743426529546, 55.75217739490631).unwrap();
    assert!(
        (lon - 37.615559994662824).abs() < 1e-6 && (lat - 55.752219996288474).abs() < 1e-6,
        "{lon}, {lat}"
    );
}

#[test]
fn sk42_antimeridian_matches_proj_epsg_5044_control() {
    let sk42 = epsg(4284);
    // PROJ's cs2cs test reports WGS84 in DMS, rounded to the last shown digit.
    let expected_lon = -(179.0 + 59.0 / 60.0 + 52.133 / 3600.0);
    let expected_lat = 49.0 + 59.0 / 60.0 + 59.36 / 3600.0;
    for lon in [179.999999999, -179.999999999] {
        let (longitude, latitude) = sk42.to_wgs84(lon, 50.0).unwrap();
        assert!((longitude - expected_lon).abs() < 0.001 / 3600.0);
        assert!((latitude - expected_lat).abs() < 0.01 / 3600.0);
    }
}
