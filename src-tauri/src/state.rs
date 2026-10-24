//! Shared application state and embedded provider catalog.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use mappa_core::{Provider, ProviderCatalog, ProviderError};
use mappa_net::{NetConfig, TileClient};
use mappa_storage::SqliteCache;
use tokio::sync::{Mutex, MutexGuard, RwLock, watch};

use crate::custom::{self, CustomSource};
use crate::packs::Packs;
use crate::settings::AppSettings;

/// Default disk budget for the tile cache.
pub const DEFAULT_CACHE_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// State shared by every Tauri command.
pub struct AppState {
    /// Durable tile cache.
    pub cache: Arc<SqliteCache>,
    /// Providers compiled into the binary.
    pub providers: ProviderCatalog,
    /// User-defined sources, keyed by id.
    custom: RwLock<HashMap<String, Provider>>,
    /// Persisted descriptions of user-defined sources.
    custom_sources: RwLock<Vec<CustomSource>>,
    /// Where custom sources are stored.
    custom_path: PathBuf,
    /// Polite HTTP client, rebuilt when the proxy changes.
    pub net: RwLock<Arc<TileClient>>,
    /// Per-tile locks that coalesce duplicate requests.
    pub inflight: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    /// Keys with a background revalidation in progress.
    pub refreshing: Mutex<std::collections::HashSet<String>>,
    /// Cancellation channels plus cancellations that raced ahead of them.
    cancels: Mutex<CancelState>,
    /// SQLite file path shown in diagnostics.
    pub cache_path: PathBuf,
    /// Configured cache budget.
    pub cache_limit_bytes: AtomicU64,
    /// Counts stored tiles so eviction runs off the request hot path.
    pub tile_writes: AtomicU64,
    /// Active HTTP proxy, if any.
    pub proxy: RwLock<Option<String>>,
    /// Where user settings are persisted.
    pub settings_path: PathBuf,
    /// Open MBTiles/PMTiles packs.
    pub packs: Packs,
}

impl AppState {
    /// Builds state around an open cache.
    pub fn new(
        cache: SqliteCache,
        cache_path: PathBuf,
        settings: AppSettings,
        settings_path: PathBuf,
        custom_path: PathBuf,
    ) -> Result<Self, AppError> {
        let providers = embedded_providers()?;
        let net = match TileClient::new(net_config(settings.proxy.clone())) {
            Ok(net) => net,
            Err(error) if settings.proxy.is_some() => {
                log::warn!("stored proxy is unusable ({error}); connecting directly");
                TileClient::new(net_config(None))?
            }
            Err(error) => return Err(error.into()),
        };
        let custom_sources = custom::load(&custom_path);
        let custom = custom_sources
            .iter()
            .filter_map(|source| {
                source
                    .to_provider()
                    .ok()
                    .map(|provider| (provider.id.clone(), provider))
            })
            .collect();
        Ok(Self {
            cache: Arc::new(cache),
            providers,
            custom: RwLock::new(custom),
            custom_sources: RwLock::new(custom_sources),
            custom_path,
            net: RwLock::new(Arc::new(net)),
            inflight: Mutex::new(HashMap::new()),
            refreshing: Mutex::new(std::collections::HashSet::new()),
            cancels: Mutex::new(CancelState::default()),
            cache_path,
            cache_limit_bytes: AtomicU64::new(settings.cache_limit_bytes),
            tile_writes: AtomicU64::new(0),
            proxy: RwLock::new(settings.proxy),
            settings_path,
            packs: Packs::new(),
        })
    }

    /// Current disk budget.
    pub fn cache_limit(&self) -> u64 {
        self.cache_limit_bytes.load(Ordering::Relaxed)
    }

    /// Returns the per-tile lock, pruning dead entries as the map grows.
    pub async fn key_lock(&self, label: &str) -> Arc<Mutex<()>> {
        let mut inflight = self.inflight.lock().await;
        if let Some(lock) = inflight.get(label).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        inflight.insert(label.to_owned(), Arc::downgrade(&lock));
        if inflight.len() > 4096 {
            inflight.retain(|_, weak| weak.strong_count() > 0);
        }
        lock
    }

    /// Finds a built-in or user-defined provider.
    pub async fn provider(&self, id: &str) -> Option<Provider> {
        if let Some(provider) = self.custom.read().await.get(id) {
            return Some(provider.clone());
        }
        self.providers.get(id).cloned()
    }

    /// Every built-in and user-defined provider.
    pub async fn all_providers(&self) -> Vec<Provider> {
        let mut providers = self.providers.iter().cloned().collect::<Vec<_>>();
        providers.extend(self.custom.read().await.values().cloned());
        providers.sort_by(|left, right| left.name.cmp(&right.name));
        providers
    }

    /// Current custom source descriptions.
    pub async fn custom_sources(&self) -> Vec<CustomSource> {
        self.custom_sources.read().await.clone()
    }

    /// Validates, persists and activates a custom source.
    pub async fn save_custom_source(&self, source: CustomSource) -> Result<CustomSource, String> {
        let mut sources = self.custom_sources.write().await;
        let mut source = source;
        // The list command strips headers before they reach the WebView.
        // Merge by name so editing other fields cannot wipe a stored API key,
        // while the explicit `replaceHeaders` flag still allows a clean set.
        let normalized_id = source.id.trim().to_ascii_lowercase();
        if let Some(existing) = sources.iter().find(|item| item.id == normalized_id) {
            if !source.replace_headers {
                let mut merged = existing.headers.clone();
                for (name, value) in source.headers {
                    merged.insert(name, value);
                }
                source.headers = merged;
            }
            if source.terms.is_none() {
                source.terms = existing.terms.clone();
            }
        }
        let provider = source.to_provider()?;
        if self.providers.get(&provider.id).is_some() {
            return Err(format!(
                "id {:?} is reserved by a built-in source",
                provider.id
            ));
        }
        let (stored, next) = custom::merge(&sources, &provider);
        custom::save(&self.custom_path, &next)?;
        *sources = next;
        self.custom
            .write()
            .await
            .insert(provider.id.clone(), provider);
        Ok(stored)
    }

    /// Removes a custom source from disk and from the active catalog.
    pub async fn delete_custom_source(&self, id: &str) -> Result<(), String> {
        if self.providers.get(id).is_some() {
            return Err("built-in sources cannot be deleted".to_owned());
        }
        let mut sources = self.custom_sources.write().await;
        let next = sources
            .iter()
            .filter(|source| source.id != id)
            .cloned()
            .collect::<Vec<_>>();
        if next.len() == sources.len() {
            return Err("source not found".to_owned());
        }
        // Persist first: a failed write must not drop the source from memory.
        custom::save(&self.custom_path, &next)?;
        *sources = next;
        self.custom.write().await.remove(id);
        Ok(())
    }

    /// Locks the set of background refreshes.
    pub async fn refresh_guard(&self) -> MutexGuard<'_, std::collections::HashSet<String>> {
        self.refreshing.lock().await
    }

    /// Registers a cancellable tile request.
    ///
    /// The returned receiver resolves as soon as [`cancel_tile`](Self::cancel_tile)
    /// is called for this id, including cancellations that raced ahead of the
    /// registration itself.
    pub async fn register_tile(&self, id: u64) -> watch::Receiver<bool> {
        let (sender, receiver) = watch::channel(false);
        let early = {
            let mut state = self.cancels.lock().await;
            state.channels.insert(id, sender.clone());
            state.early.remove(&id)
        };
        if early {
            let _ = sender.send(true);
        }
        receiver
    }

    /// Releases the cancellation slot once a request finishes.
    pub async fn finish_tile(&self, id: u64) {
        let mut state = self.cancels.lock().await;
        state.channels.remove(&id);
        state.early.remove(&id);
    }

    /// Signals a request to stop; the HTTP future is dropped by the caller.
    pub async fn cancel_tile(&self, id: u64) {
        let mut state = self.cancels.lock().await;
        if let Some(sender) = state.channels.get(&id) {
            let _ = sender.send(true);
            return;
        }
        // Bound the early set without throwing away unrelated cancels.
        if state.early.len() >= 4096
            && let Some(stale) = state.early.iter().next().copied()
        {
            state.early.remove(&stale);
        }
        state.early.insert(id);
    }
}

/// Cancellation channels and requests cancelled before registration.
#[derive(Default)]
struct CancelState {
    channels: HashMap<u64, watch::Sender<bool>>,
    early: HashSet<u64>,
}

/// Combined setup failure.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// Provider catalog is invalid.
    #[error("provider catalog: {0}")]
    Providers(#[from] ProviderError),
    /// HTTP client could not be built.
    #[error("network: {0}")]
    Net(#[from] mappa_net::NetError),
}

/// HTTP tuning shared by startup and settings updates.
pub(crate) fn net_config(proxy: Option<String>) -> NetConfig {
    NetConfig {
        timeout: Duration::from_secs(20),
        connect_timeout: Duration::from_secs(8),
        max_concurrent_per_provider: 12,
        proxy,
        ..NetConfig::default()
    }
}

/// Loads the providers shipped with the app.
pub fn embedded_providers() -> Result<ProviderCatalog, ProviderError> {
    ProviderCatalog::builtin()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn source() -> CustomSource {
        CustomSource {
            id: "custom-test".to_owned(),
            name: "Test API".to_owned(),
            kind: "xyz".to_owned(),
            url: "https://tiles.example.org/{z}/{x}/{y}.png".to_owned(),
            scheme: "xyz".to_owned(),
            min_zoom: 0,
            max_zoom: 17,
            tile_size: 256,
            format: "png".to_owned(),
            attribution: "Test".to_owned(),
            terms: None,
            headers: BTreeMap::from([("X-Api-Key".to_owned(), "secret".to_owned())]),
            replace_headers: false,
            rps: 4.0,
            burst: 8,
            offline_allowed: true,
        }
    }

    #[tokio::test]
    async fn custom_sources_are_persisted_and_resolved() {
        let directory =
            std::env::temp_dir().join(format!("mappa-state-test-{}", std::process::id()));
        let custom_path = crate::custom::path(&directory);
        let state = AppState::new(
            SqliteCache::open_in_memory().unwrap(),
            directory.join("tiles.sqlite3"),
            AppSettings::default(),
            directory.join("settings.json"),
            custom_path.clone(),
        )
        .unwrap();

        let saved = state.save_custom_source(source()).await.unwrap();
        assert_eq!(saved.id, "custom-test");
        let provider = state.provider("custom-test").await.unwrap();
        assert_eq!(provider.url, "https://tiles.example.org/{z}/{x}/{y}.png");
        assert_eq!(
            provider.headers.get("X-Api-Key").map(String::as_str),
            Some("secret")
        );
        assert!(
            state
                .all_providers()
                .await
                .iter()
                .any(|item| item.id == "custom-test")
        );

        // Editing without re-entering the secret must keep the stored header,
        // even when the user adds another header in the same save.
        let mut edited = source();
        edited.name = "Edited API".to_owned();
        edited.headers.clear();
        edited
            .headers
            .insert("Referer".to_owned(), "https://example.org".to_owned());
        state.save_custom_source(edited).await.unwrap();
        let provider = state.provider("custom-test").await.unwrap();
        assert_eq!(
            provider.headers.get("X-Api-Key").map(String::as_str),
            Some("secret")
        );
        assert_eq!(
            provider.headers.get("Referer").map(String::as_str),
            Some("https://example.org")
        );

        // A cancellation that arrives before registration is not lost.
        state.cancel_tile(7).await;
        let receiver = state.register_tile(7).await;
        assert!(*receiver.borrow());
        state.finish_tile(7).await;
        let mut receiver = state.register_tile(8).await;
        state.cancel_tile(8).await;
        receiver.changed().await.unwrap();
        assert!(*receiver.borrow());
        assert!(
            state
                .save_custom_source(CustomSource {
                    id: "osm".to_owned(),
                    ..source()
                })
                .await
                .is_err()
        );

        let reloaded = AppState::new(
            SqliteCache::open_in_memory().unwrap(),
            directory.join("tiles.sqlite3"),
            AppSettings::default(),
            directory.join("settings.json"),
            custom_path,
        )
        .unwrap();
        assert!(reloaded.provider("custom-test").await.is_some());
        reloaded.delete_custom_source("custom-test").await.unwrap();
        assert!(reloaded.provider("custom-test").await.is_none());

        let _ = std::fs::remove_dir_all(directory);
    }
}
