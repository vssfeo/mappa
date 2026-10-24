//! `mappa-cli`: download, pack and inspect the same cache as the desktop app.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use mappa_core::{Bbox, ProviderCatalog, TileRange};
use mappa_net::{NetConfig, TileClient};
use mappa_storage::{ExportSpec, SqliteCache, Tile, TileKey, export_region, export_region_pmtiles};

/// A failed tile message printed after the last task settles.
type TileTask = Option<String>;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

#[derive(Debug, Parser)]
#[command(
    name = "mappa-cli",
    version,
    about = "Офлайн-карты Mappa: загрузка, MBTiles, диагностика"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Список встроенных или локальных провайдеров.
    Providers(CatalogArgs),
    /// Скачать район в общий дисковый кэш.
    Download(DownloadArgs),
    /// Упаковать кэш района в MBTiles.
    Pack(PackArgs),
    /// Проверить и при необходимости сжать кэш.
    Doctor(DoctorArgs),
    /// Показать статистику кэша.
    Stats(CacheArgs),
}

#[derive(Debug, Args)]
struct CatalogArgs {
    /// Каталог с provider YAML; по умолчанию встроенный.
    #[arg(long)]
    providers_dir: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct CacheArgs {
    /// Путь к tiles.sqlite3; по умолчанию кэш приложения.
    #[arg(long)]
    cache: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct DownloadArgs {
    /// Provider id, например usgs.
    #[arg(long)]
    provider: String,
    /// Границы: west,south,east,north.
    #[arg(long)]
    bbox: String,
    /// Зумы: 10, 10-13 или 10..13.
    #[arg(long)]
    zoom: String,
    /// Путь к tiles.sqlite3; по умолчанию кэш приложения.
    #[arg(long)]
    cache: Option<PathBuf>,
    /// Каталог с provider YAML; по умолчанию встроенный.
    #[arg(long)]
    providers_dir: Option<PathBuf>,
    /// Предохранитель от случайной мировой загрузки.
    #[arg(long, default_value_t = 2_000_000)]
    max_tiles: u64,
    /// Лимит кэша в мегабайтах.
    #[arg(long, default_value_t = 2048)]
    limit_mb: u64,
    /// Только показать оценку.
    #[arg(long)]
    dry_run: bool,
}

#[derive(Debug, Args)]
struct PackArgs {
    /// Provider id.
    #[arg(long)]
    provider: String,
    /// Границы: west,south,east,north.
    #[arg(long)]
    bbox: String,
    /// Зумы: 10, 10-13 или 10..13.
    #[arg(long)]
    zoom: String,
    /// Куда записать .mbtiles.
    #[arg(long)]
    output: PathBuf,
    /// Имя пака.
    #[arg(long)]
    name: Option<String>,
    /// Лицензия данных (записывается в метаданные и манифест).
    #[arg(long)]
    license: Option<String>,
    /// Путь к tiles.sqlite3; по умолчанию кэш приложения.
    #[arg(long)]
    cache: Option<PathBuf>,
    /// Каталог с provider YAML; по умолчанию встроенный.
    #[arg(long)]
    providers_dir: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct DoctorArgs {
    /// Путь к tiles.sqlite3; по умолчанию кэш приложения.
    #[arg(long)]
    cache: Option<PathBuf>,
    /// Выполнить VACUUM и checkpoint.
    #[arg(long)]
    vacuum: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Providers(args) => providers(args),
        Command::Download(args) => download(args).await,
        Command::Pack(args) => pack(args),
        Command::Doctor(args) => doctor(args),
        Command::Stats(args) => stats(args),
    }
}

fn providers(args: CatalogArgs) -> Result<()> {
    let catalog = load_catalog(args.providers_dir.as_deref())?;
    println!(
        "{:<8} {:<18} {:<8} {:<9} FORMAT",
        "ID", "NAME", "ZOOM", "OFFLINE"
    );
    for provider in catalog.iter() {
        println!(
            "{:<8} {:<18} z{}-{:<6} {:<9} {}",
            provider.id,
            truncate(&provider.name, 18),
            provider.min_zoom,
            provider.max_zoom,
            if provider.offline_allowed {
                "yes"
            } else {
                "no"
            },
            provider.format
        );
    }
    Ok(())
}

async fn download(args: DownloadArgs) -> Result<()> {
    let (west, south, east, north) = parse_bbox(&args.bbox)?;
    let (min_zoom, max_zoom) = parse_zoom(&args.zoom)?;
    let bbox = Bbox::new(west, south, east, north).map_err(anyhow::Error::msg)?;
    let catalog = load_catalog(args.providers_dir.as_deref())?;
    let provider = catalog
        .get(&args.provider)
        .with_context(|| format!("unknown provider {:?}", args.provider))?
        .clone();
    if !provider.offline_allowed {
        bail!(
            "{} запрещает офлайн-скачивание; выберите источник с offline_allowed: true",
            provider.name
        );
    }
    if min_zoom < provider.min_zoom || max_zoom > provider.max_zoom {
        bail!(
            "{} поддерживает z{}–z{}",
            provider.name,
            provider.min_zoom,
            provider.max_zoom
        );
    }

    let ranges = zoom_ranges(&bbox, min_zoom, max_zoom)?;
    let total: u64 = ranges.iter().map(TileRange::count).sum();
    if total > args.max_tiles {
        bail!(
            "слишком большой район: {total} тайлов, лимит {} (--max-tiles)",
            args.max_tiles
        );
    }
    let cache_path = cache_path(args.cache.as_deref());
    println!(
        "{}: {} тайлов z{}–z{} → {}",
        provider.name,
        total,
        min_zoom,
        max_zoom,
        cache_path.display()
    );
    if args.dry_run {
        return Ok(());
    }

    let cache = Arc::new(SqliteCache::open(&cache_path)?);
    let client = Arc::new(TileClient::new(NetConfig {
        // The per-provider token bucket still enforces politeness.
        max_concurrent_per_provider: 12,
        ..NetConfig::default()
    })?);
    let provider = Arc::new(provider.clone());
    let permits = Arc::new(Semaphore::new(12));
    let started = Instant::now();
    let mut processed = 0_u64;
    let mut skipped = 0_u64;
    let downloaded = Arc::new(AtomicU64::new(0));
    let failed = Arc::new(AtomicU64::new(0));
    let bytes = Arc::new(AtomicU64::new(0));
    let mut last_report = Instant::now();
    let limit_bytes = args.limit_mb.saturating_mul(1024 * 1024);
    let mut tasks: JoinSet<TileTask> = JoinSet::new();

    for zoom in min_zoom..=max_zoom {
        let range = TileRange::new(&bbox, zoom).map_err(anyhow::Error::msg)?;
        for coord in range.iter() {
            let key = TileKey::new(&provider.id, zoom, coord.x(), coord.y(), &provider.format);
            processed += 1;
            if cache.peek(&key)?.is_some() {
                skipped += 1;
            } else {
                let permit = Arc::clone(&permits).acquire_owned().await?;
                let client = Arc::clone(&client);
                let provider = Arc::clone(&provider);
                let cache = Arc::clone(&cache);
                let downloaded = Arc::clone(&downloaded);
                let failed = Arc::clone(&failed);
                let bytes = Arc::clone(&bytes);
                let (x, y) = (coord.x(), coord.y());
                tasks.spawn(async move {
                    let _permit = permit;
                    match client.fetch(&provider, zoom, x, y).await {
                        Ok(fetched) => {
                            let size = fetched.data.len() as u64;
                            let mut tile = Tile::new(key, fetched.data);
                            tile.etag = fetched.etag;
                            tile.last_modified = fetched.last_modified;
                            tile.content_type = fetched.content_type;
                            tile.expires_at = fetched.expires_at;
                            if fetched.cacheable {
                                let cache = Arc::clone(&cache);
                                match tokio::task::spawn_blocking(move || cache.put(&tile)).await {
                                    Ok(Ok(())) => {
                                        downloaded.fetch_add(1, Ordering::Relaxed);
                                        bytes.fetch_add(size, Ordering::Relaxed);
                                    }
                                    Ok(Err(error)) => {
                                        failed.fetch_add(1, Ordering::Relaxed);
                                        return Some(format!(
                                            "{zoom}/{x}/{y}: cache write failed: {error}"
                                        ));
                                    }
                                    Err(error) => {
                                        failed.fetch_add(1, Ordering::Relaxed);
                                        return Some(format!(
                                            "{zoom}/{x}/{y}: cache task failed: {error}"
                                        ));
                                    }
                                }
                            } else {
                                downloaded.fetch_add(1, Ordering::Relaxed);
                                bytes.fetch_add(size, Ordering::Relaxed);
                            }
                            None
                        }
                        Err(error) => {
                            failed.fetch_add(1, Ordering::Relaxed);
                            Some(format!("{zoom}/{x}/{y}: {error}"))
                        }
                    }
                });
            }
            // Reap finished tasks inside the loop; otherwise a large run
            // accumulates millions of completed JoinHandles in memory.
            while let Some(joined) = tasks.try_join_next() {
                match joined {
                    Ok(Some(message)) => eprintln!("\n{message}"),
                    Ok(None) => {}
                    Err(error) => {
                        failed.fetch_add(1, Ordering::Relaxed);
                        eprintln!("\nзадача загрузки упала: {error}");
                    }
                }
            }
            if last_report.elapsed() >= Duration::from_millis(200) || processed == total {
                report_progress(
                    processed,
                    total,
                    downloaded.load(Ordering::Relaxed),
                    skipped,
                    failed.load(Ordering::Relaxed),
                    bytes.load(Ordering::Relaxed),
                    started,
                );
                last_report = Instant::now();
            }
        }
    }

    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok(Some(message)) => eprintln!("\n{message}"),
            Ok(None) => {}
            Err(error) => {
                failed.fetch_add(1, Ordering::Relaxed);
                eprintln!("\nзадача загрузки упала: {error}");
            }
        }
        if last_report.elapsed() >= Duration::from_millis(200) || tasks.is_empty() {
            report_progress(
                processed,
                total,
                downloaded.load(Ordering::Relaxed),
                skipped,
                failed.load(Ordering::Relaxed),
                bytes.load(Ordering::Relaxed),
                started,
            );
            last_report = Instant::now();
        }
    }
    let downloaded = downloaded.load(Ordering::Relaxed);
    let failed = failed.load(Ordering::Relaxed);
    let bytes = bytes.load(Ordering::Relaxed);
    println!();
    if limit_bytes > 0 {
        let evicted = cache.enforce_limit(limit_bytes)?;
        if evicted > 0 {
            println!("вытеснено по лимиту кэша: {evicted}");
        }
    }
    println!(
        "готово: скачано {downloaded}, пропущено {skipped}, ошибок {failed}, {} за {:.1} с",
        human_bytes(bytes),
        started.elapsed().as_secs_f64()
    );
    if failed > 0 {
        bail!("{failed} тайлов не скачались");
    }
    Ok(())
}

fn pack(args: PackArgs) -> Result<()> {
    let (west, south, east, north) = parse_bbox(&args.bbox)?;
    let (min_zoom, max_zoom) = parse_zoom(&args.zoom)?;
    let bbox = Bbox::new(west, south, east, north).map_err(anyhow::Error::msg)?;
    let catalog = load_catalog(args.providers_dir.as_deref())?;
    let provider = catalog
        .get(&args.provider)
        .with_context(|| format!("unknown provider {:?}", args.provider))?;
    let cache_path = cache_path(args.cache.as_deref());
    let cache = SqliteCache::open(&cache_path)?;
    let name = args
        .name
        .unwrap_or_else(|| format!("{} z{}–z{}", provider.name, min_zoom, max_zoom));
    let spec = ExportSpec {
        provider_id: provider.id.clone(),
        name: name.clone(),
        west: bbox.west(),
        south: bbox.south(),
        east: bbox.east(),
        north: bbox.north(),
        min_zoom,
        max_zoom,
        polygon: None,
        format: provider.format.clone(),
        attribution: Some(provider.attribution.clone()),
        license: args.license.clone(),
        output: args.output.clone(),
    };
    let extension = args
        .output
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let started = Instant::now();
    let progress = |processed: u64, written: u64| {
        if processed.is_multiple_of(200) {
            eprint!("\rобработано {processed}, записано {written}");
        }
    };
    let report = match extension.as_str() {
        "pmtiles" => export_region_pmtiles(&cache, &spec, progress)?,
        "mbtiles" => export_region(&cache, &spec, progress)?,
        other => bail!("output must end in .mbtiles or .pmtiles, got {other:?}"),
    };
    println!();
    let key_path = cache_path.with_file_name("pack-signing.key");
    let manifest = mappa_storage::write_manifest(&report.path, args.license.as_deref(), &key_path)?;
    println!(
        "{}: {} тайлов, {}, не хватает {}",
        report.path.display(),
        report.tiles,
        human_bytes(report.bytes),
        report.missing
    );
    println!(
        "манифест: {} (sha256 {}, подпись Ed25519)",
        mappa_storage::manifest::manifest_path(&report.path).display(),
        &manifest.sha256[..16]
    );
    println!("за {:.1} с", started.elapsed().as_secs_f64());
    Ok(())
}

fn doctor(args: DoctorArgs) -> Result<()> {
    let path = cache_path(args.cache.as_deref());
    let cache = SqliteCache::open(&path)?;
    let stats = cache.stats()?;
    println!("cache: {}", path.display());
    if let Ok(metadata) = std::fs::metadata(&path) {
        println!("file: {}", human_bytes(metadata.len()));
    }
    println!(
        "tiles: {}, bytes: {}, hits: {}, misses: {}, hit ratio: {:.1}%",
        stats.tiles,
        human_bytes(stats.bytes),
        stats.hits,
        stats.misses,
        stats.hit_ratio() * 100.0
    );
    println!("quick_check: {}", cache.quick_check()?);
    if args.vacuum {
        cache.vacuum()?;
        println!("vacuum: ok");
    }
    Ok(())
}

fn stats(args: CacheArgs) -> Result<()> {
    let path = cache_path(args.cache.as_deref());
    let cache = SqliteCache::open(&path)?;
    let stats = cache.stats()?;
    println!("{}", path.display());
    println!(
        "{} тайлов, {}, hit ratio {:.1}%",
        stats.tiles,
        human_bytes(stats.bytes),
        stats.hit_ratio() * 100.0
    );
    for provider in cache.provider_stats()? {
        println!(
            "  {:<10} {:>7} тайлов  {}",
            provider.provider_id,
            provider.tiles,
            human_bytes(provider.bytes)
        );
    }
    Ok(())
}

fn load_catalog(directory: Option<&Path>) -> Result<ProviderCatalog> {
    if let Some(directory) = directory {
        return ProviderCatalog::load_dir(directory)
            .with_context(|| format!("cannot load {}", directory.display()));
    }
    let local = Path::new("providers");
    if local.is_dir() {
        return ProviderCatalog::load_dir(local).context("cannot load ./providers");
    }
    ProviderCatalog::builtin().context("built-in provider catalog is invalid")
}

fn cache_path(argument: Option<&Path>) -> PathBuf {
    if let Some(path) = argument {
        return path.to_path_buf();
    }
    if let Some(path) = std::env::var_os("MAPPA_CACHE") {
        return PathBuf::from(path);
    }
    if let Some(base) = std::env::var_os("XDG_CACHE_HOME") {
        return PathBuf::from(base).join("dev.mappa.desktop/tiles.sqlite3");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".cache/dev.mappa.desktop/tiles.sqlite3");
    }
    PathBuf::from("mappa-tiles.sqlite3")
}

fn zoom_ranges(bbox: &Bbox, min_zoom: u8, max_zoom: u8) -> Result<Vec<TileRange>> {
    (min_zoom..=max_zoom)
        .map(|zoom| TileRange::new(bbox, zoom).map_err(anyhow::Error::msg))
        .collect()
}

fn parse_bbox(value: &str) -> Result<(f64, f64, f64, f64)> {
    let parts = value
        .split(',')
        .map(|part| part.trim().parse::<f64>())
        .collect::<Result<Vec<_>, _>>()
        .with_context(|| format!("bbox must be west,south,east,north: {value:?}"))?;
    if parts.len() != 4 {
        bail!("bbox must have four numbers: {value:?}");
    }
    Ok((parts[0], parts[1], parts[2], parts[3]))
}

fn parse_zoom(value: &str) -> Result<(u8, u8)> {
    let value = value.trim();
    let (min, max) = if let Some((min, max)) = value.split_once("..") {
        (min, max)
    } else if let Some((min, max)) = value.split_once('-') {
        (min, max)
    } else {
        (value, value)
    };
    let min: u8 = min.trim().parse().context("invalid min zoom")?;
    let max: u8 = max.trim().parse().context("invalid max zoom")?;
    if min > max {
        bail!("min zoom {min} is greater than max zoom {max}");
    }
    if max > 30 {
        bail!("max zoom {max} is above 30");
    }
    Ok((min, max))
}

fn report_progress(
    processed: u64,
    total: u64,
    downloaded: u64,
    skipped: u64,
    failed: u64,
    bytes: u64,
    started: Instant,
) {
    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    let rate = processed as f64 / elapsed;
    let eta = if rate > 0.0 {
        (total.saturating_sub(processed)) as f64 / rate
    } else {
        0.0
    };
    eprint!(
        "\r{processed}/{total}  +{downloaded} ={skipped} !{failed}  {}  {:.0}/s  ETA {:.0}с   ",
        human_bytes(bytes),
        rate,
        eta
    );
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["Б", "КБ", "МБ", "ГБ"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn truncate(value: &str, width: usize) -> String {
    if value.chars().count() <= width {
        value.to_owned()
    } else {
        value
            .chars()
            .take(width.saturating_sub(1))
            .collect::<String>()
            + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bbox() {
        assert_eq!(
            parse_bbox("-122.5,37.7,-122.4,37.8").unwrap(),
            (-122.5, 37.7, -122.4, 37.8)
        );
        assert!(parse_bbox("1,2,3").is_err());
        assert!(parse_bbox("a,b,c,d").is_err());
    }

    #[test]
    fn parses_zoom_ranges() {
        assert_eq!(parse_zoom("12").unwrap(), (12, 12));
        assert_eq!(parse_zoom("10-13").unwrap(), (10, 13));
        assert_eq!(parse_zoom("10..13").unwrap(), (10, 13));
        assert!(parse_zoom("13-10").is_err());
        assert!(parse_zoom("31").is_err());
    }

    #[test]
    fn formats_bytes() {
        assert_eq!(human_bytes(512), "512 Б");
        assert_eq!(human_bytes(2048), "2.0 КБ");
        assert_eq!(human_bytes(5 * 1024 * 1024), "5.0 МБ");
    }

    #[test]
    fn builds_zoom_ranges() {
        let bbox = Bbox::new(-122.5, 37.7, -122.4, 37.8).unwrap();
        let ranges = zoom_ranges(&bbox, 10, 12).unwrap();
        assert_eq!(ranges.len(), 3);
        assert!(ranges[0].count() > 0);
    }

    #[test]
    fn builtin_catalog_is_valid() {
        let catalog = ProviderCatalog::builtin().unwrap();
        assert!(catalog.get("usgs").unwrap().offline_allowed);
        assert!(!catalog.get("osm").unwrap().offline_allowed);
    }
}
