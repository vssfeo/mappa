//! Local storage benchmark: cache, queue and pack read paths.
//!
//! ```bash
//! cargo run --release -p mappa-storage --example bench -- --tiles 10000
//! cargo run --release -p mappa-storage --example bench -- \
//!   --tiles 250000 --tile-size 48 --with-packs
//! ```
//!
//! The benchmark is deliberately network-free: it measures the parts that
//! Mappa controls (SQLite, hashing, pack export and first-tile latency).

use std::io::Cursor;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use mappa_core::{Bbox, TileRange};
use mappa_storage::{
    DownloadStore, ExportSpec, JobStatus, Mbtiles, NewJob, PmtilesPack, SqliteCache, Tile, TileKey,
    export_region, export_region_pmtiles,
};

struct Options {
    tiles: usize,
    tile_size: u32,
    reads: usize,
    with_packs: bool,
    queue_updates: usize,
}

fn value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn parse(args: &[String]) -> Options {
    Options {
        tiles: value(args, "--tiles")
            .and_then(|value| value.parse().ok())
            .unwrap_or(10_000),
        tile_size: value(args, "--tile-size")
            .and_then(|value| value.parse().ok())
            .unwrap_or(48),
        reads: value(args, "--reads")
            .and_then(|value| value.parse().ok())
            .unwrap_or(20_000),
        with_packs: args.iter().any(|arg| arg == "--with-packs"),
        queue_updates: value(args, "--queue-updates")
            .and_then(|value| value.parse().ok())
            .unwrap_or(10_000),
    }
}

fn png_tile(size: u32, seed: u32) -> Vec<u8> {
    let image = RgbImage::from_fn(size, size, |x, y| {
        let seed = seed
            .wrapping_mul(2_246_822_519)
            .wrapping_add(x.wrapping_mul(73_856_093))
            .wrapping_add(y.wrapping_mul(19_349_663));
        let mut value = seed ^ 0x9e37_79b9;
        value ^= value >> 16;
        value = value.wrapping_mul(0x85eb_ca6b);
        value ^= value >> 13;
        Rgb([
            (value & 0xff) as u8,
            ((value >> 8) & 0xff) as u8,
            ((value >> 16) & 0xff) as u8,
        ])
    });
    let mut bytes = Vec::new();
    DynamicImage::ImageRgb8(image)
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .expect("encode benchmark PNG");
    bytes
}

const BENCH_ZOOM: u8 = 14;
const BENCH_WEST: f64 = 0.0;
const BENCH_SOUTH: f64 = 0.0;
const BENCH_EAST: f64 = 12.0;
const BENCH_NORTH: f64 = 12.0;

fn coordinates(count: usize) -> Vec<(u8, u32, u32)> {
    let bbox =
        Bbox::new(BENCH_WEST, BENCH_SOUTH, BENCH_EAST, BENCH_NORTH).expect("valid bench bbox");
    let range = TileRange::new(&bbox, BENCH_ZOOM).expect("valid range");
    let coords = range
        .iter()
        .take(count)
        .map(|coord| (BENCH_ZOOM, coord.x(), coord.y()))
        .collect::<Vec<_>>();
    assert_eq!(coords.len(), count, "bbox cannot hold enough tiles");
    coords
}

fn percentile(sorted: &[Duration], fraction: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    let index = ((sorted.len() - 1) as f64 * fraction).round() as usize;
    sorted[index]
}

fn file_bytes(path: &PathBuf) -> u64 {
    std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().collect::<Vec<_>>();
    let options = parse(&args);
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let directory =
        std::env::temp_dir().join(format!("mappa-bench-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&directory)?;

    let sample = png_tile(options.tile_size, 0);
    let coords = coordinates(options.tiles);
    println!(
        "benchmark: {} tiles, ~{} B/tile (PNG {}x{}), cache {}",
        options.tiles,
        sample.len(),
        options.tile_size,
        options.tile_size,
        directory.display()
    );

    let cache_path = directory.join("tiles.sqlite3");
    let cache = SqliteCache::open(&cache_path)?;

    let started = Instant::now();
    for (zoom, x, y) in &coords {
        let key = TileKey::new("bench", *zoom, *x, *y, "png");
        let seed = (u32::from(*zoom) << 28) ^ (*x << 14) ^ *y;
        cache.put(&Tile::new(key, png_tile(options.tile_size, seed)))?;
    }
    let insert = started.elapsed();
    let stats = cache.stats()?;
    println!(
        "cache insert: {:.2?} ({:.0} tiles/s), db {:.1} MiB, {} tiles, {} bytes",
        insert,
        options.tiles as f64 / insert.as_secs_f64(),
        file_bytes(&cache_path) as f64 / 1_048_576.0,
        stats.tiles,
        stats.bytes
    );

    let mut state = 0x1234_5678_u64;
    let mut timings = Vec::with_capacity(options.reads);
    for _ in 0..options.reads {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        let (zoom, x, y) = coords[(state as usize) % coords.len()];
        let key = TileKey::new("bench", zoom, x, y, "png");
        let started = Instant::now();
        let found = cache.get(&key)?;
        timings.push(started.elapsed());
        assert!(found.is_some());
    }
    timings.sort_unstable();
    println!(
        "cache read: p50 {:.2?}, p95 {:.2?}, max {:.2?} ({} reads)",
        percentile(&timings, 0.50),
        percentile(&timings, 0.95),
        timings.last().copied().unwrap_or_default(),
        options.reads
    );

    let queue_path = directory.join("downloads.sqlite3");
    let queue = DownloadStore::open(&queue_path)?;
    let job = queue.create(NewJob {
        name: "bench".to_owned(),
        provider_id: "bench".to_owned(),
        west: BENCH_WEST,
        south: BENCH_SOUTH,
        east: BENCH_EAST,
        north: BENCH_NORTH,
        min_zoom: BENCH_ZOOM,
        max_zoom: BENCH_ZOOM,
        polygon: None,
        source_ids: Vec::new(),
    })?;
    queue.set_status(&job.id, JobStatus::Running, None)?;
    let updates = options.queue_updates.min(job.total_tiles as usize);
    let started = Instant::now();
    for index in 0..updates {
        queue.update_progress(
            &job.id,
            index as u64 + 1,
            0,
            (index as u64 + 1) * 1024,
            index as u64 + 1,
        )?;
    }
    queue.set_status(&job.id, JobStatus::Completed, None)?;
    let elapsed = started.elapsed();
    println!(
        "queue: {} progress updates in {:.2?} ({:.0} updates/s), job total {}",
        updates,
        elapsed,
        updates as f64 / elapsed.as_secs_f64(),
        job.total_tiles
    );

    if options.with_packs {
        let first = coords[0];
        let last = *coords.last().expect("at least one tile");
        let export = ExportSpec {
            provider_id: "bench".to_owned(),
            name: "bench".to_owned(),
            west: BENCH_WEST,
            south: BENCH_SOUTH,
            east: BENCH_EAST,
            north: BENCH_NORTH,
            min_zoom: BENCH_ZOOM,
            max_zoom: BENCH_ZOOM,
            polygon: None,
            format: "png".to_owned(),
            attribution: Some("bench".to_owned()),
            license: None,
            cancel: None,
            output: directory.join("bench.mbtiles"),
        };
        let started = Instant::now();
        let report = export_region(&cache, &export, |_| {})?;
        let elapsed = started.elapsed();
        let mbtiles_path = export.output.clone();
        let size = file_bytes(&mbtiles_path);
        let started = Instant::now();
        let pack = Mbtiles::open(&mbtiles_path)?;
        let opened = started.elapsed();
        let started = Instant::now();
        let read = pack.get_tile(first.0, first.1, first.2)?;
        let first_tile = started.elapsed();
        println!(
            "mbtiles: {:.1} MiB, {} tiles, export {:.2?}, open {:.2?}, first tile {:.2?}, read {} B",
            size as f64 / 1_048_576.0,
            report.tiles,
            elapsed,
            opened,
            first_tile,
            read.map(|value| value.len()).unwrap_or(0)
        );

        let pmtiles_spec = ExportSpec {
            output: directory.join("bench.pmtiles"),
            ..export
        };
        let started = Instant::now();
        let report = export_region_pmtiles(&cache, &pmtiles_spec, |_| {})?;
        let elapsed = started.elapsed();
        let size = file_bytes(&pmtiles_spec.output);
        let started = Instant::now();
        let pack = PmtilesPack::open(&pmtiles_spec.output).await?;
        let opened = started.elapsed();
        let started = Instant::now();
        let read = pack.get_tile(first.0, first.1, first.2).await?;
        let first_tile = started.elapsed();
        let started = Instant::now();
        let last_read = pack.get_tile(last.0, last.1, last.2).await?;
        let last_tile = started.elapsed();
        println!(
            "pmtiles: {:.1} MiB, {} tiles, export {:.2?}, open {:.2?}, first tile {:.2?}, \
             last tile {:.2?}, read {} B",
            size as f64 / 1_048_576.0,
            report.tiles,
            elapsed,
            opened,
            first_tile,
            last_tile,
            read.map(|value| value.len()).unwrap_or(0)
        );
        let _ = last_read;
    }

    if args.iter().any(|arg| arg == "--keep") {
        println!("keeping {}", directory.display());
    } else {
        std::fs::remove_dir_all(&directory)?;
    }
    Ok(())
}
