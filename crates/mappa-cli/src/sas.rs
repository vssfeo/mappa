//! Best-effort import of a SAS.Planet tile cache into MBTiles.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::Args;
use mappa_core::{Bbox, TileCoord};
use mappa_storage::{MbtilesMetadata, MbtilesWriter};
use serde::Serialize;

#[derive(Debug, Args)]
pub struct SasArgs {
    /// Каталог кэша SAS.Planet (Cache/…).
    #[arg(long)]
    pub source: PathBuf,
    /// Куда записать .mbtiles.
    #[arg(long)]
    pub output: PathBuf,
    /// Слой по имени каталога; по умолчанию самый большой.
    #[arg(long)]
    pub layer: Option<String>,
    /// Имя пака; по умолчанию имя слоя.
    #[arg(long)]
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SasReport {
    pub path: PathBuf,
    pub name: String,
    pub layer: String,
    pub format: String,
    pub tiles: u64,
    pub skipped: u64,
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub bounds: (f64, f64, f64, f64),
    pub layers: usize,
}

struct Tile {
    key: TileCoord,
    path: PathBuf,
    extension: String,
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(dir).with_context(|| format!("cannot read {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            walk(&path, out)?;
        } else if path.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

fn tile_from_path(path: &Path) -> Option<Tile> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return None;
    }
    let y: u32 = path.file_stem()?.to_str()?.parse().ok()?;
    let x: u32 = path.parent()?.file_name()?.to_str()?.parse().ok()?;
    let z: u8 = path
        .parent()?
        .parent()?
        .file_name()?
        .to_str()?
        .parse()
        .ok()?;
    let key = TileCoord::new(z, x, y).ok()?;
    Some(Tile {
        key,
        path: path.to_path_buf(),
        extension: if extension == "jpeg" {
            "jpg".to_owned()
        } else {
            extension
        },
    })
}

fn layer_of(path: &Path) -> Option<String> {
    path.parent()?
        .parent()?
        .parent()?
        .file_name()
        .and_then(|value| value.to_str())
        .map(ToOwned::to_owned)
}

/// Imports the selected layer and returns a report.
pub fn import(args: &SasArgs) -> Result<SasReport> {
    if !args.source.is_dir() {
        bail!("{} is not a directory", args.source.display());
    }
    if args.output.exists() {
        bail!("{} already exists", args.output.display());
    }
    let mut files = Vec::new();
    walk(&args.source, &mut files)?;
    let mut by_layer: BTreeMap<String, Vec<Tile>> = BTreeMap::new();
    let mut skipped = 0_u64;
    for path in files {
        match (tile_from_path(&path), layer_of(&path)) {
            (Some(tile), Some(layer)) => by_layer.entry(layer).or_default().push(tile),
            _ => skipped += 1,
        }
    }
    if by_layer.is_empty() {
        bail!("no z/x/y tiles found under {}", args.source.display());
    }
    let layers = by_layer.len();
    let layer = match args.layer.as_deref() {
        Some(wanted) => by_layer
            .keys()
            .find(|name| name.eq_ignore_ascii_case(wanted) || name.ends_with(wanted))
            .with_context(|| format!("layer {wanted:?} not found"))?
            .clone(),
        None => by_layer
            .iter()
            .max_by_key(|(_, tiles)| tiles.len())
            .map(|(name, _)| name.clone())
            .expect("non-empty"),
    };
    let tiles = by_layer.remove(&layer).expect("selected layer");
    let mut formats: BTreeMap<&str, usize> = BTreeMap::new();
    for tile in &tiles {
        *formats.entry(tile.extension.as_str()).or_default() += 1;
    }
    let format = formats
        .iter()
        .max_by_key(|(_, count)| *count)
        .map(|(name, _)| (*name).to_owned())
        .unwrap_or_else(|| "png".to_owned());
    let mut min_zoom = u8::MAX;
    let mut max_zoom = 0_u8;
    let mut west = f64::INFINITY;
    let mut south = f64::INFINITY;
    let mut east = f64::NEG_INFINITY;
    let mut north = f64::NEG_INFINITY;
    for tile in &tiles {
        if tile.extension != format {
            continue;
        }
        let (w, s, e, n) = tile.key.bounds();
        west = west.min(w);
        south = south.min(s);
        east = east.max(e);
        north = north.max(n);
        min_zoom = min_zoom.min(tile.key.z());
        max_zoom = max_zoom.max(tile.key.z());
    }
    let bounds = Bbox::new(west, south, east, north).map_err(anyhow::Error::msg)?;
    let name = args.name.clone().unwrap_or_else(|| layer.clone());
    let mut metadata = MbtilesMetadata::new(name.clone(), format.clone());
    metadata.bounds = Some(bounds);
    metadata.minzoom = Some(min_zoom);
    metadata.maxzoom = Some(max_zoom);
    metadata.attribution = Some("Imported from SAS.Planet cache".to_owned());
    metadata.description = Some(format!("SAS.Planet layer {layer}"));
    let mut writer = MbtilesWriter::create(&args.output, metadata)?;
    let mut written = 0_u64;
    for tile in &tiles {
        if tile.extension != format {
            skipped += 1;
            continue;
        }
        let data =
            fs::read(&tile.path).with_context(|| format!("cannot read {}", tile.path.display()))?;
        writer.put_tile(tile.key.z(), tile.key.x(), tile.key.y(), &data)?;
        written += 1;
    }
    writer.finish()?;
    Ok(SasReport {
        path: args.output.clone(),
        name,
        layer,
        format,
        tiles: written,
        skipped,
        min_zoom,
        max_zoom,
        bounds: (west, south, east, north),
        layers,
    })
}

/// CLI entry point.
pub fn run(args: SasArgs, json: bool) -> Result<()> {
    let report = import(&args)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }
    println!(
        "{}: {} тайлов z{}–z{}, пропущено {}, слой {} из {}",
        report.path.display(),
        report.tiles,
        report.min_zoom,
        report.max_zoom,
        report.skipped,
        report.layer,
        report.layers
    );
    println!(
        "bounds {:.5},{:.5},{:.5},{:.5}",
        report.bounds.0, report.bounds.1, report.bounds.2, report.bounds.3
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mappa_storage::Mbtiles;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "mappa-sas-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn write_tile(root: &Path, layer: &str, z: u8, x: u32, y: u32, bytes: &[u8]) -> PathBuf {
        let dir = root.join(layer).join(z.to_string()).join(x.to_string());
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{y}.png"));
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn imports_a_synthetic_cache() {
        let dir = temp_dir("import");
        write_tile(&dir, "Google", 10, 512, 340, b"one");
        write_tile(&dir, "Google", 10, 513, 340, b"two");
        write_tile(&dir, "Google", 11, 1024, 680, b"three");
        write_tile(&dir, "Bing", 5, 1, 2, b"other");
        let out = dir.join("out.mbtiles");
        let report = import(&SasArgs {
            source: dir.clone(),
            output: out.clone(),
            layer: Some("Google".to_owned()),
            name: None,
        })
        .unwrap();
        assert_eq!(report.layer, "Google");
        assert_eq!(report.tiles, 3);
        assert_eq!(report.min_zoom, 10);
        assert_eq!(report.max_zoom, 11);
        assert_eq!(report.format, "png");
        let pack = Mbtiles::open(&out).unwrap();
        assert_eq!(pack.tile_count().unwrap(), 3);
        assert_eq!(pack.metadata().format, "png");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_an_empty_cache_and_existing_output() {
        let dir = temp_dir("empty");
        fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.mbtiles");
        assert!(
            import(&SasArgs {
                source: dir.clone(),
                output: out.clone(),
                layer: None,
                name: None,
            })
            .is_err()
        );
        write_tile(&dir, "Google", 3, 1, 1, b"x");
        fs::write(&out, b"exists").unwrap();
        assert!(
            import(&SasArgs {
                source: dir.clone(),
                output: out,
                layer: None,
                name: None,
            })
            .is_err()
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
