//! Persisted user settings: disk budget and optional HTTP proxy.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use mappa_net::TileClient;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::{AppState, DEFAULT_CACHE_LIMIT_BYTES, net_config};

/// Smallest cache budget accepted from the UI.
pub const MIN_CACHE_LIMIT_BYTES: u64 = 64 * 1024 * 1024;
/// Largest cache budget accepted from the UI.
pub const MAX_CACHE_LIMIT_BYTES: u64 = 1024 * 1024 * 1024 * 1024;

type SharedState<'a> = State<'a, Arc<AppState>>;

/// User-tunable settings persisted as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Disk budget in bytes.
    pub cache_limit_bytes: u64,
    /// HTTP proxy URL, empty means direct connection.
    pub proxy: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            cache_limit_bytes: DEFAULT_CACHE_LIMIT_BYTES,
            proxy: None,
        }
    }
}

impl AppSettings {
    /// Trims the proxy and clamps the budget into the supported range.
    pub fn sanitized(mut self) -> Self {
        self.cache_limit_bytes = self
            .cache_limit_bytes
            .clamp(MIN_CACHE_LIMIT_BYTES, MAX_CACHE_LIMIT_BYTES);
        self.proxy = self
            .proxy
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        self
    }
}

/// Reads settings, falling back to defaults when the file is missing or broken.
pub fn load(path: &Path) -> AppSettings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<AppSettings>(&text).ok())
        .unwrap_or_default()
        .sanitized()
}

/// Writes settings through an atomic replacement.
pub fn save(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    crate::atomic::write(path, text.as_bytes(), false)
        .map_err(|error| format!("cannot save {}: {error}", path.display()))
}

/// Returns the settings currently in effect.
#[tauri::command]
pub async fn get_settings(state: SharedState<'_>) -> Result<AppSettings, String> {
    Ok(AppSettings {
        cache_limit_bytes: state.cache_limit(),
        proxy: state.proxy.read().await.clone(),
    })
}

/// Applies and persists new settings. The proxy is validated by rebuilding the
/// HTTP client before anything is stored.
#[tauri::command]
pub async fn update_settings(
    state: SharedState<'_>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let settings = settings.sanitized();
    let client = TileClient::new(net_config(settings.proxy.clone()))
        .map_err(|error| format!("прокси не подходит: {error}"))?;
    save(&state.settings_path, &settings)?;

    *state.net.write().await = Arc::new(client);
    state
        .cache_limit_bytes
        .store(settings.cache_limit_bytes, Ordering::Relaxed);
    *state.proxy.write().await = settings.proxy.clone();

    let cache = Arc::clone(&state.cache);
    let limit = settings.cache_limit_bytes;
    tauri::async_runtime::spawn_blocking(move || cache.enforce_limit(limit))
        .await
        .map_err(|error| format!("не удалось применить лимит: {error}"))?
        .map_err(|error| format!("не удалось применить лимит: {error}"))?;

    log::info!(
        "settings updated: limit {:.0} MiB, proxy {}",
        settings.cache_limit_bytes as f64 / 1024.0 / 1024.0,
        if settings.proxy.is_some() {
            "enabled"
        } else {
            "disabled"
        }
    );
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_limits_and_proxy() {
        let low = AppSettings {
            cache_limit_bytes: 1,
            proxy: Some("  http://127.0.0.1:3128  ".to_owned()),
        }
        .sanitized();
        assert_eq!(low.cache_limit_bytes, MIN_CACHE_LIMIT_BYTES);
        assert_eq!(low.proxy.as_deref(), Some("http://127.0.0.1:3128"));

        let high = AppSettings {
            cache_limit_bytes: u64::MAX,
            proxy: Some("   ".to_owned()),
        }
        .sanitized();
        assert_eq!(high.cache_limit_bytes, MAX_CACHE_LIMIT_BYTES);
        assert!(high.proxy.is_none());
    }

    #[test]
    fn persists_and_restores() {
        let directory = std::env::temp_dir().join(format!("mappa-settings-{}", std::process::id()));
        let path = directory.join("settings.json");
        let settings = AppSettings {
            cache_limit_bytes: 512 * 1024 * 1024,
            proxy: Some("http://proxy.local:8080".to_owned()),
        }
        .sanitized();
        save(&path, &settings).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.cache_limit_bytes, settings.cache_limit_bytes);
        assert_eq!(loaded.proxy, settings.proxy);
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn missing_file_uses_defaults() {
        let loaded = load(Path::new("/nonexistent/mappa/settings.json"));
        assert_eq!(loaded.cache_limit_bytes, DEFAULT_CACHE_LIMIT_BYTES);
        assert!(loaded.proxy.is_none());
    }
}
