//! Small text-file bridge for marker, feature and project import/export.

use std::path::{Path, PathBuf};

/// Refuse to load or write unexpectedly large documents.
const MAX_TEXT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_BINARY_BYTES: u64 = 128 * 1024 * 1024;
const MAX_WRITE_BYTES: usize = 128 * 1024 * 1024;

/// Only user documents cross this bridge; never app state or SSH keys.
const ALLOWED_EXTENSIONS: &[&str] = &[
    "csv", "dbf", "geojson", "gpkg", "gpx", "jpeg", "jpg", "json", "kml", "kmz", "mappa", "pdf",
    "pgw", "png", "prj", "shp", "tfw", "tif", "tiff", "txt", "wld",
];

fn allowed_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ALLOWED_EXTENSIONS
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}

/// App configuration and cache directories must never be reachable through
/// the generic text bridge, even with a `.json` extension.
fn protected_directory(path: &Path) -> bool {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        roots.push(home.join(".config"));
        roots.push(home.join(".cache"));
    }
    if let Some(config) = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from) {
        roots.push(config);
    }
    if let Some(cache) = std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from) {
        roots.push(cache);
    }
    roots.iter().any(|root| path.starts_with(root))
}

fn resolve(path: &str, must_exist: bool) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("path must be absolute".to_owned());
    }
    if !allowed_extension(&path) {
        return Err("unsupported file extension".to_owned());
    }
    // Check before creating parents: a rejected write must not leave fresh
    // directories inside the app config/cache tree.
    if protected_directory(&path) {
        return Err("refusing to access the application configuration".to_owned());
    }
    let resolved = if path.exists() {
        std::fs::canonicalize(&path)
            .map_err(|error| format!("cannot resolve {}: {error}", path.display()))?
    } else if must_exist {
        return Err(format!("file does not exist: {}", path.display()));
    } else {
        let parent = path
            .parent()
            .ok_or_else(|| "path has no parent directory".to_owned())?;
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
        let parent = std::fs::canonicalize(parent)
            .map_err(|error| format!("cannot resolve {}: {error}", parent.display()))?;
        let name = path
            .file_name()
            .ok_or_else(|| "path has no file name".to_owned())?;
        parent.join(name)
    };
    if !allowed_extension(&resolved) {
        return Err("unsupported file extension".to_owned());
    }
    if protected_directory(&resolved) {
        return Err("refusing to access the application configuration".to_owned());
    }
    Ok(resolved)
}

/// Resolves an existing path through the same allowlist used by the bridge.
pub(crate) fn resolve_for_read(path: &str) -> Result<PathBuf, String> {
    resolve(path, true)
}

/// Resolves a new export path through the bridge allowlist.
pub(crate) fn resolve_for_write(path: &str) -> Result<PathBuf, String> {
    resolve(path, false)
}

/// Reads a UTF-8 text file chosen by the user.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    let path = resolve(&path, true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
        if metadata.len() > MAX_TEXT_BYTES {
            return Err(format!(
                "file is too large: {:.1} MiB (limit {} MiB)",
                metadata.len() as f64 / 1024.0 / 1024.0,
                MAX_TEXT_BYTES / 1024 / 1024
            ));
        }
        std::fs::read_to_string(&path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Reads a binary user document (KMZ, and later SHP/GeoPackage).
///
/// Raw IPC keeps multi-megabyte archives out of JSON/base64 overhead.
#[tauri::command]
pub async fn read_binary_file(path: String) -> Result<tauri::ipc::Response, String> {
    let path = resolve(&path, true)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || read_bytes(&path, MAX_BINARY_BYTES))
        .await
        .map_err(|error| error.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

fn read_bytes(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > limit {
        return Err(format!(
            "file is too large: {:.1} MiB (limit {} MiB)",
            metadata.len() as f64 / 1024.0 / 1024.0,
            limit / 1024 / 1024
        ));
    }
    std::fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))
}

/// Writes a binary export (PNG, PDF, world file) atomically.
#[tauri::command]
pub async fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    if data.len() > MAX_WRITE_BYTES {
        return Err("document is too large".to_owned());
    }
    let path = resolve(&path, false)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::atomic::write(&path, &data, false)
            .map_err(|error| format!("cannot write {}: {error}", path.display()))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Writes UTF-8 text to a path chosen in the save dialog.
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if contents.len() as u64 > MAX_TEXT_BYTES {
        return Err(format!(
            "document is too large: {:.1} MiB (limit {} MiB)",
            contents.len() as f64 / 1024.0 / 1024.0,
            MAX_TEXT_BYTES / 1024 / 1024
        ));
    }
    let path = resolve(&path, false)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::atomic::write(&path, contents.as_bytes(), false)
            .map_err(|error| format!("cannot write {}: {error}", path.display()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_reads_utf8_text() {
        let directory = std::env::temp_dir().join(format!("mappa-files-{}", std::process::id()));
        let path = directory.join("markers.csv");
        let display = path.display().to_string();
        tauri::async_runtime::block_on(write_text_file(
            display.clone(),
            "name;lat;lon\nточка;55.7;37.6\n".to_owned(),
        ))
        .unwrap();
        let text = tauri::async_runtime::block_on(read_text_file(display.clone())).unwrap();
        assert!(text.contains("точка"));

        tauri::async_runtime::block_on(write_text_file(
            display,
            "name;lat;lon\nновая;55.8;37.7\n".to_owned(),
        ))
        .unwrap();
        let text = tauri::async_runtime::block_on(read_text_file(
            directory.join("markers.csv").display().to_string(),
        ))
        .unwrap();
        assert!(text.contains("новая"));
        assert!(!text.contains("точка"));
        let leftovers = std::fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn writes_binary_exports_and_sidecars() {
        let directory = std::env::temp_dir().join(format!(
            "mappa-binary-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for name in ["map.png", "map.pgw", "map.tif", "map.tfw", "map.pdf"] {
            let path = directory.join(name);
            tauri::async_runtime::block_on(write_binary_file(
                path.display().to_string(),
                vec![1, 2, 3],
            ))
            .unwrap();
            assert_eq!(std::fs::read(path).unwrap(), vec![1, 2, 3]);
        }
        let rejected = directory.join("payload.exe");
        assert!(
            tauri::async_runtime::block_on(write_binary_file(
                rejected.display().to_string(),
                vec![1],
            ))
            .is_err()
        );
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn missing_file_is_an_error() {
        let path = std::env::temp_dir().join("mappa-missing-markers.csv");
        let error =
            tauri::async_runtime::block_on(read_text_file(path.display().to_string())).unwrap_err();
        assert!(!error.is_empty());
    }

    #[test]
    fn rejects_unexpected_files() {
        let directory =
            std::env::temp_dir().join(format!("mappa-files-reject-{}", std::process::id()));
        let key = directory.join("id_rsa");
        let script = directory.join("payload.exe");
        assert!(
            tauri::async_runtime::block_on(write_text_file(
                key.display().to_string(),
                "secret".to_owned()
            ))
            .is_err()
        );
        assert!(
            tauri::async_runtime::block_on(write_text_file(
                script.display().to_string(),
                "payload".to_owned()
            ))
            .is_err()
        );
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn rejects_relative_paths() {
        assert!(resolve("markers.csv", true).is_err());
    }

    #[test]
    fn does_not_create_directories_in_the_config_tree() {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let parent = PathBuf::from(home)
            .join(".config")
            .join(format!("mappa-forbidden-{}", std::process::id()));
        let path = parent.join("markers.csv");
        let error =
            tauri::async_runtime::block_on(write_text_file(path.display().to_string(), "x".into()))
                .unwrap_err();
        assert!(error.contains("configuration"));
        assert!(!parent.exists());
    }
}
