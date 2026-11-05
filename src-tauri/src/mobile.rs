//! Starts the CLI tile server for the phone page and returns its QR code.

use std::fs;
use std::net::{TcpListener, UdpSocket};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

#[derive(Default, Clone)]
pub struct MobileServer {
    child: Arc<Mutex<Option<Child>>>,
}

impl Drop for MobileServer {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            stop(child.as_mut());
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileInfo {
    pub url: String,
    pub qr_svg: String,
    pub port: u16,
}

fn stop(child: Option<&mut Child>) {
    if let Some(child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn token() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_nanos());
    let seed = format!("{}-{stamp}", std::process::id());
    blake3::hash(seed.as_bytes()).to_hex().to_string()[..24].to_owned()
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("cannot reserve a port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("cannot read the port: {error}"))
}

fn lan_ip() -> String {
    UdpSocket::bind(("0.0.0.0", 0))
        .and_then(|socket| {
            socket.connect(("8.8.8.8", 80))?;
            socket.local_addr()
        })
        .map(|address| address.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_owned())
}

fn cli_path(app: &AppHandle) -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("MAPPA_CLI") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    let name = if cfg!(windows) {
        "mappa-cli.exe"
    } else {
        "mappa-cli"
    };
    let mut candidates = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("binaries").join(name));
        candidates.push(resource.join(name));
    }
    for base in ["target/release", "target/debug"] {
        candidates.push(PathBuf::from(base).join(name));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn start(
    app: &AppHandle,
    child_state: &Arc<Mutex<Option<Child>>>,
    packs: &[String],
    tls: bool,
) -> Result<MobileInfo, String> {
    let cli = cli_path(app).ok_or_else(|| {
        "mappa-cli not found: set MAPPA_CLI or install the CLI next to the app".to_owned()
    })?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("cannot resolve the cache directory: {error}"))?;
    fs::create_dir_all(&cache).map_err(|error| format!("cannot create the cache: {error}"))?;
    let qr_path = cache.join("mobile-qr.svg");
    let log_path = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("cannot resolve the log directory: {error}"))?
        .join("mobile-server.log");
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::remove_file(&qr_path);
    let port = free_port()?;
    let token = token();

    let mut guard = child_state
        .lock()
        .map_err(|_| "mobile server mutex is poisoned".to_owned())?;
    stop(guard.as_mut());
    let log = fs::File::create(&log_path)
        .map_err(|error| format!("cannot create {}: {error}", log_path.display()))?;
    let error_log = log
        .try_clone()
        .map_err(|error| format!("cannot duplicate the log: {error}"))?;
    let mut command = Command::new(&cli);
    command
        .arg("serve")
        .arg("--host")
        .arg("0.0.0.0")
        .arg("--port")
        .arg(port.to_string())
        .arg("--token")
        .arg(&token)
        .arg("--qr-svg")
        .arg(&qr_path)
        .arg("--no-worker")
        .arg("--cache")
        .arg(cache.join("tiles.sqlite3"))
        .arg("--tracks-dir")
        .arg(cache.join("tracks"))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log));
    if tls {
        command.arg("--tls");
    }
    for pack in packs {
        command.arg("--pack").arg(pack);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("cannot start {}: {error}", cli.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = fs::metadata(&cli) {
            let mut permissions = metadata.permissions();
            if permissions.mode() & 0o111 == 0 {
                permissions.set_mode(0o755);
                let _ = fs::set_permissions(&cli, permissions);
            }
        }
    }

    for _ in 0..60 {
        if qr_path.is_file() {
            let qr_svg = fs::read_to_string(&qr_path)
                .map_err(|error| format!("cannot read the QR code: {error}"))?;
            let scheme = if tls { "https" } else { "http" };
            let url = format!("{scheme}://{}:{port}/m?token={token}", lan_ip());
            *guard = Some(child);
            return Ok(MobileInfo { url, qr_svg, port });
        }
        if let Ok(Some(status)) = child.try_wait() {
            let detail = fs::read_to_string(&log_path).unwrap_or_default();
            return Err(format!(
                "mobile server exited with {status}: {}",
                detail.lines().last().unwrap_or("see the log")
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("mobile server did not produce a QR code within 6 seconds".to_owned())
}

#[tauri::command]
pub async fn start_mobile_server(
    app: AppHandle,
    state: State<'_, MobileServer>,
    packs: Vec<String>,
    tls: bool,
) -> Result<MobileInfo, String> {
    let app_handle = app.clone();
    let child = state.child.clone();
    tauri::async_runtime::spawn_blocking(move || start(&app_handle, &child, &packs, tls))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn stop_mobile_server(state: State<'_, MobileServer>) -> Result<(), String> {
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "mobile server mutex is poisoned".to_owned())?;
    stop(guard.as_mut());
    *guard = None;
    Ok(())
}
