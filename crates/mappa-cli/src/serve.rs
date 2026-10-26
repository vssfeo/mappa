//! Local tile server and read-only REST API for the shared cache and packs.

use std::io::IsTerminal;
use std::net::{IpAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use clap::Args;
use mappa_core::{Bbox, ProviderCatalog};
use mappa_storage::{DownloadStore, Mbtiles, PmtilesPack, SqliteCache, TileKey};

use crate::sync::{self, SaveOutcome};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Args)]
pub struct ServeArgs {
    /// Интерфейс: 127.0.0.1 для локального доступа, 0.0.0.0 для LAN.
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,
    /// TCP-порт; 0 выбирает свободный.
    #[arg(long, default_value_t = 8080)]
    pub port: u16,
    /// Путь к tiles.sqlite3; по умолчанию кэш приложения.
    #[arg(long)]
    pub cache: Option<PathBuf>,
    /// Каталог с provider YAML; по умолчанию встроенный.
    #[arg(long)]
    pub providers_dir: Option<PathBuf>,
    /// MBTiles или PMTiles для раздачи; можно указать несколько раз.
    #[arg(long = "pack")]
    pub packs: Vec<PathBuf>,
    /// Путь к downloads.sqlite3; по умолчанию рядом с кэшем.
    #[arg(long)]
    pub queue: Option<PathBuf>,
    /// Необязательный токен для API и тайлов (?token=...).
    #[arg(long)]
    pub token: Option<String>,
    /// Каталог для синхронизированных проектов; по умолчанию рядом с кэшем.
    #[arg(long)]
    pub sync_dir: Option<PathBuf>,
    /// Не печатать QR-код для подключения в терминале.
    #[arg(long)]
    pub no_qr: bool,
    /// Сохранить QR-код подключения в SVG.
    #[arg(long, value_name = "PATH")]
    pub qr_svg: Option<PathBuf>,
}

struct ServeState {
    cache: Arc<SqliteCache>,
    catalog: Arc<ProviderCatalog>,
    packs: Vec<Arc<ServePack>>,
    queue: Option<Arc<DownloadStore>>,
    token: Option<String>,
    started: Instant,
    base_url: String,
    sync_dir: PathBuf,
}

struct ServePack {
    id: String,
    name: String,
    path: PathBuf,
    kind: &'static str,
    format: String,
    vector_layers: Vec<String>,
    min_zoom: u8,
    max_zoom: u8,
    bounds: Bbox,
    tiles: Option<u64>,
    reader: PackReader,
}

enum PackReader {
    Mbtiles(Mutex<Mbtiles>),
    Pmtiles(PmtilesPack),
}

#[derive(Debug, PartialEq, Eq)]
enum Route {
    Index,
    Health,
    Status,
    Providers,
    Packs,
    Jobs,
    SyncList,
    SyncProject(String),
    Style(String),
    CacheTile {
        provider: String,
        z: u8,
        x: u32,
        y: u32,
    },
    PackTile {
        id: String,
        z: u8,
        x: u32,
        y: u32,
    },
    NotFound,
    BadRequest,
}

struct Response {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
    headers: Vec<(String, String)>,
}

impl Response {
    fn json(status: u16, body: String) -> Self {
        Self {
            status,
            content_type: "application/json; charset=utf-8",
            body: body.into_bytes(),
            headers: Vec::new(),
        }
    }

    fn text(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8",
            body: body.into().into_bytes(),
            headers: Vec::new(),
        }
    }

    fn tile(data: Vec<u8>, content_type: &'static str) -> Self {
        Self {
            status: 200,
            content_type,
            body: data,
            headers: vec![
                (
                    "Cache-Control".to_owned(),
                    "public, max-age=3600".to_owned(),
                ),
                ("X-Content-Type-Options".to_owned(), "nosniff".to_owned()),
            ],
        }
    }
}

pub async fn run(args: ServeArgs) -> Result<()> {
    let cache_file = crate::cache_path(args.cache.as_deref());
    let cache = Arc::new(
        SqliteCache::open(&cache_file)
            .with_context(|| format!("cannot open cache {}", cache_file.display()))?,
    );
    let catalog = Arc::new(crate::load_catalog(args.providers_dir.as_deref())?);
    let mut packs = Vec::new();
    for (index, path) in args.packs.iter().enumerate() {
        packs.push(Arc::new(open_pack(index, path).await?));
    }
    let queue_file = args.queue.clone().unwrap_or_else(|| {
        cache_file
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("downloads.sqlite3")
    });
    let queue = match DownloadStore::open(&queue_file) {
        Ok(queue) => Some(Arc::new(queue)),
        Err(error) => {
            eprintln!(
                "warning: queue {} is unavailable: {error}",
                queue_file.display()
            );
            None
        }
    };
    let sync_dir = args.sync_dir.clone().unwrap_or_else(|| {
        cache_file
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("sync")
    });
    let token = args
        .token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let listener = TcpListener::bind((args.host.as_str(), args.port))
        .await
        .with_context(|| format!("cannot bind {}:{}", args.host, args.port))?;
    let address = listener.local_addr()?;
    let display_host = if address.ip().is_unspecified() {
        "127.0.0.1".to_owned()
    } else {
        address.ip().to_string()
    };
    let base_url = format!("http://{display_host}:{}", address.port());
    let state = Arc::new(ServeState {
        cache,
        catalog,
        packs,
        queue,
        token,
        started: Instant::now(),
        base_url,
        sync_dir,
    });

    println!("Mappa tile server {VERSION}");
    println!("  cache: {}", cache_file.display());
    println!("  packs: {}", state.packs.len());
    println!("  local: {}/", state.base_url);
    let lan_hosts = if address.ip().is_unspecified() {
        local_addresses()
    } else {
        Vec::new()
    };
    if address.ip().is_unspecified() {
        for ip in &lan_hosts {
            println!("  LAN:   http://{ip}:{}/", address.port());
        }
        if state.token.is_none() {
            println!("  warning: LAN access is open; use --token to restrict it");
        }
    }
    println!("  API:   /api/status, /api/providers, /api/packs, /api/jobs, /api/sync");
    println!("  tiles: /tiles/{{provider}}/{{z}}/{{x}}/{{y}}");
    println!("  packs: /packs/{{id}}/{{z}}/{{x}}/{{y}}");
    if state.token.is_some() {
        println!("  token: required as ?token=... or Authorization: Bearer ...");
    }

    let qr_host = if address.ip().is_unspecified() {
        lan_hosts.first().copied()
    } else if address.ip().is_loopback() {
        args.qr_svg.is_some().then_some(address.ip())
    } else {
        Some(address.ip())
    };
    if let Some(host) = qr_host {
        let qr_url = match state.token.as_deref() {
            Some(token) => format!(
                "http://{host}:{}/?token={}",
                address.port(),
                percent_encode(token)
            ),
            None => format!("http://{host}:{}/", address.port()),
        };
        match crate::qr::encode(&qr_url) {
            Ok(code) => {
                if let Some(path) = args.qr_svg.as_deref() {
                    std::fs::write(path, code.svg())
                        .with_context(|| format!("cannot write QR SVG {}", path.display()))?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                            .with_context(|| {
                                format!("cannot restrict QR SVG {}", path.display())
                            })?;
                    }
                    println!("  QR SVG: {}", path.display());
                }
                if !args.no_qr && std::io::stdout().is_terminal() {
                    println!(
                        "  QR:    отсканируйте для подключения (v{}, mask {})",
                        code.version, code.mask
                    );
                    println!("{}", code.terminal());
                }
            }
            Err(error) => eprintln!("warning: QR code is unavailable: {error}"),
        }
    } else if !args.no_qr && address.ip().is_unspecified() {
        println!("  QR:    LAN-адрес не найден; подключение по QR недоступно");
    }

    let connections = Arc::new(Semaphore::new(64));
    loop {
        let (stream, _peer) = listener.accept().await?;
        let permit = Arc::clone(&connections).acquire_owned().await?;
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(error) = handle_connection(stream, state).await {
                eprintln!("request failed: {error}");
            }
        });
    }
}

async fn open_pack(index: usize, path: &std::path::Path) -> Result<ServePack> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let fallback_name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("pack")
        .to_owned();
    let id = format!("pack-{}", index + 1);
    match extension.as_str() {
        "mbtiles" => {
            let pack =
                Mbtiles::open(path).with_context(|| format!("cannot open {}", path.display()))?;
            let metadata = pack.metadata();
            let bounds = metadata.bounds.unwrap_or_else(Bbox::world);
            let min_zoom = pack.min_zoom()?.unwrap_or(0);
            let max_zoom = pack.max_zoom()?.unwrap_or(20);
            let tiles = pack.tile_count().ok();
            let format = normalize_pack_format(&metadata.format);
            let vector_layers = if format == "mvt" {
                let value = metadata
                    .extra
                    .get("json")
                    .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok());
                vector_layer_names(value.as_ref())
            } else {
                Vec::new()
            };
            Ok(ServePack {
                id,
                name: metadata.name.clone().unwrap_or(fallback_name),
                path: path.to_path_buf(),
                kind: "mbtiles",
                format,
                vector_layers,
                min_zoom,
                max_zoom,
                bounds,
                tiles,
                reader: PackReader::Mbtiles(Mutex::new(pack)),
            })
        }
        "pmtiles" => {
            let pack = PmtilesPack::open(path)
                .await
                .with_context(|| format!("cannot open {}", path.display()))?;
            let info = pack.info().clone();
            let metadata = pack
                .metadata()
                .await
                .ok()
                .flatten()
                .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok());
            let vector_layers = vector_layer_names(metadata.as_ref());
            let bounds = Bbox::new(info.west, info.south, info.east, info.north)
                .unwrap_or_else(|_| Bbox::world());
            Ok(ServePack {
                id,
                name: fallback_name,
                path: path.to_path_buf(),
                kind: "pmtiles",
                format: info.format.clone(),
                vector_layers,
                min_zoom: info.min_zoom,
                max_zoom: info.max_zoom,
                bounds,
                tiles: None,
                reader: PackReader::Pmtiles(pack),
            })
        }
        _ => bail!(
            "unsupported pack {}: expected .mbtiles or .pmtiles",
            path.display()
        ),
    }
}

async fn handle_connection(mut stream: TcpStream, state: Arc<ServeState>) -> Result<()> {
    let mut buffer = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 4096];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = find_header_end(&buffer) {
            let head = String::from_utf8_lossy(&buffer[..end]);
            let (method, target, headers) = match parse_request(&head) {
                Some(parts) => parts,
                None => {
                    write_response(&mut stream, Response::text(400, "bad request"), true).await?;
                    return Ok(());
                }
            };
            let content_length = headers
                .iter()
                .find(|(name, _)| name == "content-length")
                .and_then(|(_, value)| value.parse::<usize>().ok())
                .unwrap_or(0);
            if content_length > MAX_BODY_BYTES {
                write_response(&mut stream, Response::text(413, "body too large"), true).await?;
                return Ok(());
            }
            let body_start = end + 4;
            while buffer.len() < body_start + content_length {
                let read = stream.read(&mut chunk).await?;
                if read == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..read]);
            }
            if buffer.len() < body_start + content_length {
                write_response(&mut stream, Response::text(400, "incomplete body"), true).await?;
                return Ok(());
            }
            let body = buffer[body_start..body_start + content_length].to_vec();
            let response =
                handle_request_with_body(&state, &method, &target, &headers, &body).await;
            write_response(&mut stream, response, method != "HEAD").await?;
            return Ok(());
        }
        if buffer.len() > MAX_HEADER_BYTES + MAX_BODY_BYTES {
            write_response(&mut stream, Response::text(431, "headers too large"), true).await?;
            return Ok(());
        }
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

type RequestHead = (String, String, Vec<(String, String)>);

fn parse_request(head: &str) -> Option<RequestHead> {
    let mut lines = head.lines();
    let mut first = lines.next()?.split_whitespace();
    let method = first.next()?.to_ascii_uppercase();
    let target = first.next()?.to_owned();
    let version = first.next()?;
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return None;
    }
    let headers = lines
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        })
        .collect();
    Some((method, target, headers))
}

#[cfg(test)]
async fn handle_request(
    state: &ServeState,
    method: &str,
    target: &str,
    headers: &[(String, String)],
) -> Response {
    handle_request_with_body(state, method, target, headers, &[]).await
}

async fn handle_request_with_body(
    state: &ServeState,
    method: &str,
    target: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> Response {
    if method == "OPTIONS" {
        return Response {
            status: 204,
            content_type: "text/plain; charset=utf-8",
            body: Vec::new(),
            headers: allow_headers(),
        };
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let route = route(path);
    let allowed = match method {
        "GET" | "HEAD" => true,
        "PUT" => matches!(route, Route::SyncProject(_)),
        _ => false,
    };
    if !allowed {
        let mut response = Response::text(405, "method not allowed");
        response
            .headers
            .push(("Allow".to_owned(), "GET, HEAD, PUT, OPTIONS".to_owned()));
        return response;
    }
    if route == Route::Health {
        return Response::text(200, "ok");
    }
    if !authorized(state, query, headers) {
        return Response::json(
            401,
            "{\"error\":\"unauthorized; pass ?token=... or Authorization: Bearer ...\"}".to_owned(),
        );
    }
    match route {
        Route::Index => Response::text(200, index_text(state)),
        Route::Health => Response::text(200, "ok"),
        Route::Status => match status_json(state) {
            Ok(body) => Response::json(200, body),
            Err(error) => Response::json(500, format!("{{\"error\":\"{}\"}}", json_escape(&error))),
        },
        Route::Providers => Response::json(200, providers_json(state)),
        Route::Packs => Response::json(200, packs_json(state)),
        Route::Jobs => Response::json(200, jobs_json(state)),
        Route::SyncList => Response::json(200, sync_list_json(state)),
        Route::SyncProject(name) => {
            if method == "PUT" {
                sync_project_put(state, &name, query, body)
            } else {
                sync_project_get(state, &name)
            }
        }
        Route::Style(provider) => match style_json(state, &provider) {
            Some(body) => Response::json(200, body),
            None => Response::json(404, "{\"error\":\"unknown provider\"}".to_owned()),
        },
        Route::CacheTile { provider, z, x, y } => {
            cache_tile_response(state, &provider, z, x, y).await
        }
        Route::PackTile { id, z, x, y } => pack_tile_response(state, &id, z, x, y).await,
        Route::BadRequest => Response::text(400, "bad tile coordinates"),
        Route::NotFound => Response::text(404, "not found"),
    }
}

fn sync_list_json(state: &ServeState) -> String {
    match sync::list(&state.sync_dir) {
        Ok(items) => {
            let projects: Vec<serde_json::Value> = items
                .iter()
                .map(|item| {
                    serde_json::json!({
                        "name": item.name,
                        "savedAt": item.saved_at,
                        "updatedAt": item.updated_at,
                        "version": item.version,
                    })
                })
                .collect();
            serde_json::json!({"projects": projects}).to_string()
        }
        Err(error) => format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
    }
}

fn sync_project_get(state: &ServeState, name: &str) -> Response {
    match sync::load(&state.sync_dir, name) {
        Ok(Some(envelope)) => {
            Response::json(200, serde_json::to_string(&envelope).unwrap_or_default())
        }
        Ok(None) => Response::json(404, "{\"error\":\"project not found\"}".to_owned()),
        Err(error) => Response::json(
            400,
            format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn sync_project_put(state: &ServeState, name: &str, query: &str, body: &[u8]) -> Response {
    if body.is_empty() {
        return Response::json(400, "{\"error\":\"empty body\"}".to_owned());
    }
    if body.len() > MAX_BODY_BYTES {
        return Response::json(413, "{\"error\":\"body too large\"}".to_owned());
    }
    let project: serde_json::Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(error) => {
            return Response::json(
                400,
                format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    };
    if !project.is_object() {
        return Response::json(
            400,
            "{\"error\":\"project must be a JSON object\"}".to_owned(),
        );
    }
    let force = query.split('&').any(|part| part == "force=1");
    match sync::save(&state.sync_dir, name, project, force) {
        Ok(SaveOutcome::Saved(envelope)) => {
            Response::json(200, serde_json::to_string(&envelope).unwrap_or_default())
        }
        Ok(SaveOutcome::Conflict(envelope)) => {
            Response::json(409, serde_json::to_string(&envelope).unwrap_or_default())
        }
        Err(error) => Response::json(
            400,
            format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn route(target: &str) -> Route {
    let path = target.trim_start_matches('/');
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    match segments.as_slice() {
        [] => Route::Index,
        ["health"] => Route::Health,
        ["api", "status"] => Route::Status,
        ["api", "providers"] => Route::Providers,
        ["api", "packs"] => Route::Packs,
        ["api", "jobs"] => Route::Jobs,
        ["api", "sync"] => Route::SyncList,
        ["api", "sync", name] => Route::SyncProject(percent_decode(name)),
        ["style", name] => match name.strip_suffix(".json") {
            Some(provider) if !provider.is_empty() && provider.len() <= 64 => {
                Route::Style(provider.to_owned())
            }
            _ => Route::NotFound,
        },
        ["tiles", provider, z, x, y] if provider.len() <= 64 => match parse_tile(z, x, y) {
            Some((z, x, y)) => Route::CacheTile {
                provider: (*provider).to_owned(),
                z,
                x,
                y,
            },
            None => Route::BadRequest,
        },
        ["packs", id, z, x, y] if id.len() <= 64 => match parse_tile(z, x, y) {
            Some((z, x, y)) => Route::PackTile {
                id: (*id).to_owned(),
                z,
                x,
                y,
            },
            None => Route::BadRequest,
        },
        _ => Route::NotFound,
    }
}

fn parse_tile(z: &str, x: &str, y: &str) -> Option<(u8, u32, u32)> {
    let z: u8 = z.parse().ok()?;
    if z > 30 {
        return None;
    }
    let x: u32 = x.parse().ok()?;
    let y = y.split_once('.').map_or(y, |(value, _)| value);
    let y: u32 = y.parse().ok()?;
    let max = 1_u32.checked_shl(u32::from(z))?.saturating_sub(1);
    (x <= max && y <= max).then_some((z, x, y))
}

fn authorized(state: &ServeState, query: &str, headers: &[(String, String)]) -> bool {
    let Some(token) = state.token.as_deref() else {
        return true;
    };
    if query.split('&').any(|part| {
        let (name, value) = part.split_once('=').unwrap_or((part, ""));
        name == "token" && percent_decode(value) == token
    }) {
        return true;
    }
    headers.iter().any(|(name, value)| {
        name == "authorization"
            && value
                .strip_prefix("Bearer ")
                .is_some_and(|value| value == token)
    })
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for &byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = |byte: u8| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                decoded.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

async fn cache_tile_response(
    state: &ServeState,
    provider_id: &str,
    z: u8,
    x: u32,
    y: u32,
) -> Response {
    let provider = match state.catalog.get(provider_id) {
        Some(provider) => provider,
        None => return Response::json(404, "{\"error\":\"unknown provider\"}".to_owned()),
    };
    let key = TileKey::new(provider.id.clone(), z, x, y, provider.format.clone());
    match state.cache.get(&key) {
        Ok(Some(tile)) => {
            let content_type = tile
                .content_type
                .as_deref()
                .and_then(mime_for)
                .unwrap_or_else(|| {
                    mime_for(&provider.format).unwrap_or("application/octet-stream")
                });
            let mut response = Response::tile(tile.data, content_type);
            if let Some(etag) = tile.etag {
                response.headers.push(("ETag".to_owned(), etag));
            }
            response
        }
        Ok(None) => Response::json(
            404,
            "{\"error\":\"tile is not cached; run mappa-cli download\"}".to_owned(),
        ),
        Err(error) => Response::json(
            500,
            format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

async fn pack_tile_response(state: &ServeState, pack_id: &str, z: u8, x: u32, y: u32) -> Response {
    let Some(pack) = state.packs.iter().find(|pack| pack.id == pack_id) else {
        return Response::json(404, "{\"error\":\"unknown pack\"}".to_owned());
    };
    let data = match &pack.reader {
        PackReader::Mbtiles(pack) => {
            let pack = match pack.lock() {
                Ok(pack) => pack,
                Err(_) => return Response::text(500, "pack lock poisoned"),
            };
            pack.get_tile(z, x, y)
        }
        PackReader::Pmtiles(pack) => pack.get_tile(z, x, y).await,
    };
    match data {
        Ok(Some(data)) => Response::tile(
            data,
            mime_for(&pack.format).unwrap_or("application/octet-stream"),
        ),
        Ok(None) => Response::json(404, "{\"error\":\"tile not found in pack\"}".to_owned()),
        Err(error) => Response::json(
            500,
            format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn status_json(state: &ServeState) -> Result<String, String> {
    let stats = state.cache.stats().map_err(|error| error.to_string())?;
    let jobs = state
        .queue
        .as_ref()
        .and_then(|queue| queue.list().ok())
        .unwrap_or_default();
    let cache_path = state
        .cache
        .path()
        .map(|path| format!("\"{}\"", json_escape(&path.display().to_string())))
        .unwrap_or_else(|| "null".to_owned());
    Ok(format!(
        "{{\"name\":\"mappa\",\"version\":\"{}\",\"uptimeSeconds\":{},\"cache\":{{\"path\":{},\"tiles\":{},\"bytes\":{},\"hits\":{},\"misses\":{}}},\"providers\":{},\"packs\":{},\"jobs\":{{\"total\":{},\"running\":{}}}}}",
        json_escape(VERSION),
        state.started.elapsed().as_secs(),
        cache_path,
        stats.tiles,
        stats.bytes,
        stats.hits,
        stats.misses,
        state.catalog.len(),
        state.packs.len(),
        jobs.len(),
        jobs.iter()
            .filter(|job| job.status.as_str() == "running")
            .count(),
    ))
}

fn providers_json(state: &ServeState) -> String {
    let entries = state
        .catalog
        .iter()
        .map(|provider| {
            format!(
                "{{\"id\":\"{}\",\"name\":\"{}\",\"minZoom\":{},\"maxZoom\":{},\"tileSize\":{},\"format\":\"{}\",\"offlineAllowed\":{},\"attribution\":\"{}\",\"tileUrl\":\"{}/tiles/{}/{{z}}/{{x}}/{{y}}\"}}",
                json_escape(&provider.id),
                json_escape(&provider.name),
                provider.min_zoom,
                provider.max_zoom,
                provider.tile_size,
                json_escape(&provider.format),
                provider.offline_allowed,
                json_escape(&provider.attribution),
                state.base_url,
                provider.id,
            )
        })
        .collect::<Vec<_>>();
    format!("[{}]", entries.join(","))
}

fn packs_json(state: &ServeState) -> String {
    let entries = state
        .packs
        .iter()
        .map(|pack| pack_json(pack, &state.base_url))
        .collect::<Vec<_>>();
    format!("[{}]", entries.join(","))
}

fn pack_json(pack: &ServePack, base_url: &str) -> String {
    format!(
        "{{\"id\":\"{}\",\"name\":\"{}\",\"kind\":\"{}\",\"path\":\"{}\",\"format\":\"{}\",\"vectorLayers\":[{}],\"minZoom\":{},\"maxZoom\":{},\"bounds\":[{},{},{},{}],\"tiles\":{},\"tileUrl\":\"{}/packs/{}/{{z}}/{{x}}/{{y}}\"}}",
        json_escape(&pack.id),
        json_escape(&pack.name),
        pack.kind,
        json_escape(&pack.path.display().to_string()),
        json_escape(&pack.format),
        pack.vector_layers
            .iter()
            .map(|layer| format!("\"{}\"", json_escape(layer)))
            .collect::<Vec<_>>()
            .join(","),
        pack.min_zoom,
        pack.max_zoom,
        pack.bounds.west(),
        pack.bounds.south(),
        pack.bounds.east(),
        pack.bounds.north(),
        pack.tiles
            .map(|value| value.to_string())
            .unwrap_or_else(|| "null".to_owned()),
        base_url,
        pack.id,
    )
}

fn jobs_json(state: &ServeState) -> String {
    let Some(queue) = &state.queue else {
        return "[]".to_owned();
    };
    let jobs = match queue.list() {
        Ok(jobs) => jobs,
        Err(error) => {
            return format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string()));
        }
    };
    let entries = jobs
        .iter()
        .map(|job| {
            format!(
                "{{\"id\":\"{}\",\"name\":\"{}\",\"providerId\":\"{}\",\"status\":\"{}\",\"totalTiles\":{},\"doneTiles\":{},\"failedTiles\":{},\"bytes\":{},\"progress\":{:.4},\"createdAt\":{},\"updatedAt\":{},\"error\":{}}}",
                json_escape(&job.id),
                json_escape(&job.name),
                json_escape(&job.provider_id),
                job.status.as_str(),
                job.total_tiles,
                job.done_tiles,
                job.failed_tiles,
                job.bytes,
                job.progress(),
                job.created_at,
                job.updated_at,
                job.error
                    .as_deref()
                    .map(|value| format!("\"{}\"", json_escape(value)))
                    .unwrap_or_else(|| "null".to_owned()),
            )
        })
        .collect::<Vec<_>>();
    format!("[{}]", entries.join(","))
}

fn style_json(state: &ServeState, provider_id: &str) -> Option<String> {
    let provider = state.catalog.get(provider_id)?;
    Some(format!(
        "{{\"version\":8,\"name\":\"{}\",\"sources\":{{\"mappa\":{{\"type\":\"raster\",\"tiles\":[\"{}/tiles/{}/{{z}}/{{x}}/{{y}}\"],\"tileSize\":{},\"minzoom\":{},\"maxzoom\":{},\"attribution\":\"{}\"}}}},\"layers\":[{{\"id\":\"background\",\"type\":\"background\",\"paint\":{{\"background-color\":\"#0e1116\"}}}},{{\"id\":\"mappa\",\"type\":\"raster\",\"source\":\"mappa\"}}]}}",
        json_escape(&provider.name),
        state.base_url,
        provider.id,
        provider.tile_size,
        provider.min_zoom,
        provider.max_zoom,
        json_escape(&provider.attribution),
    ))
}

fn index_text(state: &ServeState) -> String {
    format!(
        "Mappa tile server {VERSION}\n\n\
         GET /api/status\n\
         GET /api/providers\n\
         GET /api/packs\n\
         GET /api/jobs\n\
         GET /style/{{provider}}.json\n\
         GET /tiles/{{provider}}/{{z}}/{{x}}/{{y}}\n\
         GET /packs/{{id}}/{{z}}/{{x}}/{{y}}\n\n\
         base: {}\n\
         packs: {}\n",
        state.base_url,
        state.packs.len()
    )
}

async fn write_response(
    stream: &mut TcpStream,
    response: Response,
    include_body: bool,
) -> Result<()> {
    let reason = match response.status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        409 => "Conflict",
        413 => "Payload Too Large",
        404 => "Not Found",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    };
    let mut head = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nServer: mappa/{VERSION}\r\nAccess-Control-Allow-Origin: *\r\n",
        response.status,
        response.content_type,
        response.body.len(),
    );
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if response.status == 405 {
        head.push_str("Allow: GET, HEAD, OPTIONS\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await?;
    if include_body && response.status != 204 {
        stream.write_all(&response.body).await?;
    }
    stream.shutdown().await?;
    Ok(())
}

fn allow_headers() -> Vec<(String, String)> {
    vec![
        (
            "Access-Control-Allow-Methods".to_owned(),
            "GET, HEAD, PUT, OPTIONS".to_owned(),
        ),
        (
            "Access-Control-Allow-Headers".to_owned(),
            "Authorization, Content-Type".to_owned(),
        ),
        ("Access-Control-Max-Age".to_owned(), "86400".to_owned()),
    ]
}

fn normalize_pack_format(format: &str) -> String {
    match format.trim().to_ascii_lowercase().as_str() {
        "pbf" | "mvt" => "mvt".to_owned(),
        other => other.to_owned(),
    }
}

fn vector_layer_names(metadata: Option<&serde_json::Value>) -> Vec<String> {
    let mut layers = Vec::new();
    let Some(items) = metadata
        .and_then(|value| value.get("vector_layers"))
        .and_then(serde_json::Value::as_array)
    else {
        return layers;
    };
    for item in items {
        let Some(id) = item.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let id = id.trim();
        if id.is_empty() || id.len() > 200 || layers.iter().any(|layer| layer == id) {
            continue;
        }
        layers.push(id.to_owned());
        if layers.len() == 128 {
            break;
        }
    }
    layers
}

fn mime_for(format: &str) -> Option<&'static str> {
    match format.trim().to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "mvt" | "pbf" => Some("application/vnd.mapbox-vector-tile"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "json" => Some("application/json; charset=utf-8"),
        _ => None,
    }
}

fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            character if character < ' ' => {
                out.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => out.push(character),
        }
    }
    out
}

fn local_addresses() -> Vec<IpAddr> {
    let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else {
        return Vec::new();
    };
    // Connecting a UDP socket does not send a packet; it only selects a route.
    if socket.connect("8.8.8.8:80").is_err() {
        return Vec::new();
    }
    socket
        .local_addr()
        .ok()
        .map(|address| vec![address.ip()])
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> ServeState {
        ServeState {
            cache: Arc::new(SqliteCache::open_in_memory().unwrap()),
            catalog: Arc::new(ProviderCatalog::builtin().unwrap()),
            packs: Vec::new(),
            queue: None,
            token: None,
            started: Instant::now(),
            base_url: "http://127.0.0.1:8080".to_owned(),
            sync_dir: std::env::temp_dir().join("mappa-serve-sync-tests"),
        }
    }

    #[test]
    fn routes_tiles_api_and_styles() {
        assert_eq!(route("/health"), Route::Health);
        assert_eq!(route("/api/status"), Route::Status);
        assert_eq!(route("/api/sync"), Route::SyncList);
        assert_eq!(
            route("/api/sync/team"),
            Route::SyncProject("team".to_owned())
        );
        assert_eq!(
            route("/tiles/osm/10/1/2.png"),
            Route::CacheTile {
                provider: "osm".to_owned(),
                z: 10,
                x: 1,
                y: 2
            }
        );
        assert_eq!(
            route("/packs/pack-1/3/4/5"),
            Route::PackTile {
                id: "pack-1".to_owned(),
                z: 3,
                x: 4,
                y: 5
            }
        );
        assert_eq!(route("/style/osm.json"), Route::Style("osm".to_owned()));
        assert_eq!(route("/tiles/osm/10/1024/2"), Route::BadRequest);
        assert_eq!(route("/tiles/osm/10/0"), Route::NotFound);
        assert_eq!(route("/../etc/passwd"), Route::NotFound);
    }

    #[test]
    fn escapes_json_strings() {
        assert_eq!(json_escape("a\"b\\c\n"), "a\\\"b\\\\c\\n");
        assert_eq!(json_escape("\u{1}"), "\\u0001");
    }

    #[test]
    fn token_query_is_percent_encoded() {
        let token = "mappa lan+/?#%";
        let encoded = percent_encode(token);
        assert_eq!(encoded, "mappa%20lan%2B%2F%3F%23%25");
        assert_eq!(percent_decode(&encoded), token);
        assert_eq!(percent_decode("plain"), "plain");
    }

    #[tokio::test]
    async fn accepts_percent_encoded_token() {
        let mut state = state();
        state.token = Some("mappa lan+/".to_owned());
        let authorized =
            handle_request(&state, "GET", "/api/status?token=mappa%20lan%2B%2F", &[]).await;
        assert_eq!(authorized.status, 200);
    }

    #[tokio::test]
    async fn serves_health_status_and_providers() {
        let state = state();
        let health = handle_request(&state, "GET", "/health", &[]).await;
        assert_eq!(health.status, 200);
        assert_eq!(health.body, b"ok");

        let status = handle_request(&state, "GET", "/api/status", &[]).await;
        assert_eq!(status.status, 200);
        let status = String::from_utf8(status.body).unwrap();
        assert!(status.contains("\"name\":\"mappa\""));
        assert!(status.contains("\"providers\":7"));

        let providers = handle_request(&state, "GET", "/api/providers", &[]).await;
        let providers = String::from_utf8(providers.body).unwrap();
        assert!(providers.contains("\"id\":\"osm\""));
        assert!(providers.contains("/tiles/osm/{z}/{x}/{y}"));

        let style = handle_request(&state, "GET", "/style/topo.json", &[]).await;
        assert_eq!(style.status, 200);
        let style = String::from_utf8(style.body).unwrap();
        assert!(style.contains("\"type\":\"raster\""));
        assert!(style.contains("/tiles/topo/"));
    }

    #[tokio::test]
    async fn rejects_unknown_routes_and_tokens() {
        let mut state = state();
        state.token = Some("secret".to_owned());
        let unauthorized = handle_request(&state, "GET", "/api/status", &[]).await;
        assert_eq!(unauthorized.status, 401);
        let authorized = handle_request(&state, "GET", "/api/status?token=secret", &[]).await;
        assert_eq!(authorized.status, 200);
        let header = handle_request(
            &state,
            "GET",
            "/api/status",
            &[("authorization".to_owned(), "Bearer secret".to_owned())],
        )
        .await;
        assert_eq!(header.status, 200);
        let missing = handle_request(&state, "GET", "/tiles/osm/10/1/2?token=secret", &[]).await;
        assert_eq!(missing.status, 404);
    }
}

#[cfg(test)]
mod sync_tests {
    use super::*;

    fn unique_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "mappa-serve-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn state(dir: PathBuf) -> ServeState {
        ServeState {
            cache: Arc::new(SqliteCache::open_in_memory().unwrap()),
            catalog: Arc::new(ProviderCatalog::builtin().unwrap()),
            packs: Vec::new(),
            queue: None,
            token: None,
            started: Instant::now(),
            base_url: "http://127.0.0.1:8080".to_owned(),
            sync_dir: dir,
        }
    }

    #[tokio::test]
    async fn put_get_and_conflict() {
        let dir = unique_dir("put");
        let state = state(dir.clone());
        let body = serde_json::json!({
            "format": "mappa-project",
            "savedAt": "2026-10-26T10:00:00.000Z",
            "name": "team",
        })
        .to_string();
        let put =
            handle_request_with_body(&state, "PUT", "/api/sync/team", &[], body.as_bytes()).await;
        assert_eq!(put.status, 200);
        let get = handle_request(&state, "GET", "/api/sync/team", &[]).await;
        assert_eq!(get.status, 200);
        let older = serde_json::json!({
            "format": "mappa-project",
            "savedAt": "2026-10-26T09:00:00.000Z",
        })
        .to_string();
        let conflict =
            handle_request_with_body(&state, "PUT", "/api/sync/team", &[], older.as_bytes()).await;
        assert_eq!(conflict.status, 409);
        let forced = handle_request_with_body(
            &state,
            "PUT",
            "/api/sync/team?force=1",
            &[],
            older.as_bytes(),
        )
        .await;
        assert_eq!(forced.status, 200);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn rejects_bad_names_and_methods() {
        let dir = unique_dir("bad");
        let state = state(dir.clone());
        let bad = handle_request_with_body(&state, "PUT", "/api/sync/bad/name", &[], b"{}").await;
        assert_eq!(bad.status, 405);
        let missing = handle_request(&state, "GET", "/api/sync/absent", &[]).await;
        assert_eq!(missing.status, 404);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
