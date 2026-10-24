//! Shared tile loading: cache-first with conditional network refresh.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use mappa_core::Provider;
use mappa_net::{Conditional, FetchOutcome};
use mappa_storage::{Tile, TileKey, now_unix};

use crate::state::AppState;

/// Loads a tile from cache or network.
///
/// Duplicate requests for one key are coalesced. A stale cached tile is kept
/// if revalidation fails, which is what makes offline panning work.
pub(crate) async fn load_tile(
    state: &Arc<AppState>,
    provider: &Provider,
    key: &TileKey,
) -> Result<Tile, String> {
    let lock = state.key_lock(&key.label()).await;
    let _guard = lock.lock().await;

    let cache = Arc::clone(&state.cache);
    let probe = key.clone();
    let cached = tauri::async_runtime::spawn_blocking(move || cache.peek(&probe))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    let now = now_unix();
    if let Some(tile) = &cached
        && !tile.is_expired(now)
    {
        return Ok(tile.clone());
    }

    let conditional = Conditional {
        etag: cached.as_ref().and_then(|tile| tile.etag.clone()),
        last_modified: cached.as_ref().and_then(|tile| tile.last_modified.clone()),
    };
    let net = state.net.read().await.clone();
    let started = std::time::Instant::now();
    match net
        .fetch_conditional(provider, key.z, key.x, key.y, &conditional)
        .await
    {
        Ok(FetchOutcome::Fetched(fetched)) => {
            log::debug!(
                "fetched {} ({} bytes, cacheable={}) in {} ms",
                key.label(),
                fetched.data.len(),
                fetched.cacheable,
                started.elapsed().as_millis()
            );
            let mut tile = Tile::new(key.clone(), fetched.data);
            tile.etag = fetched.etag;
            tile.last_modified = fetched.last_modified;
            tile.content_type = fetched.content_type;
            tile.expires_at = fetched.expires_at;
            if fetched.cacheable {
                store_tile(state, &tile).await?;
            }
            Ok(tile)
        }
        Ok(FetchOutcome::NotModified {
            expires_at,
            etag,
            last_modified,
        }) => {
            let Some(mut tile) = cached else {
                return Err("server returned 304 without a cached tile".to_owned());
            };
            tile.fetched_at = now;
            tile.last_used = now;
            tile.expires_at = expires_at;
            tile.etag = etag;
            tile.last_modified = last_modified;
            store_tile(state, &tile).await?;
            Ok(tile)
        }
        Err(error) => match cached {
            Some(tile) => {
                log::warn!("keeping stale tile {}: {error}", key.label());
                Ok(tile)
            }
            None => Err(error.to_string()),
        },
    }
}

/// Checks for a cached tile without loading its bytes.
///
/// Resuming a large download walks thousands of already cached keys; reading
/// every blob just to skip it would waste gigabytes of memory bandwidth.
pub(crate) async fn has_tile(state: &Arc<AppState>, key: &TileKey) -> Result<bool, String> {
    let cache = Arc::clone(&state.cache);
    let key = key.clone();
    tauri::async_runtime::spawn_blocking(move || cache.contains(&key))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// Persists a tile and periodically enforces the cache budget.
///
/// Eviction is deliberately off the hot path: a transaction per tile would
/// serialize every write behind an extra `cache_totals` read.
pub(crate) async fn store_tile(state: &Arc<AppState>, tile: &Tile) -> Result<(), String> {
    const EVICT_EVERY: u64 = 64;
    let cache = Arc::clone(&state.cache);
    let tile = tile.clone();
    let limit = state.cache_limit();
    let evict = state
        .tile_writes
        .fetch_add(1, Ordering::Relaxed)
        .is_multiple_of(EVICT_EVERY);
    tauri::async_runtime::spawn_blocking(move || {
        cache.put(&tile).map_err(|error| error.to_string())?;
        if evict {
            cache
                .enforce_limit(limit)
                .map_err(|error| error.to_string())?;
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Revalidates a stale tile in the background, at most once per key.
pub(crate) fn schedule_refresh(state: Arc<AppState>, provider: Provider, key: TileKey) {
    tauri::async_runtime::spawn(async move {
        let label = key.label();
        {
            let mut refreshing = state.refresh_guard().await;
            if !refreshing.insert(label.clone()) {
                return;
            }
        }
        match load_tile(&state, &provider, &key).await {
            Ok(tile) => log::debug!("revalidated {} ({} bytes)", label, tile.data.len()),
            Err(error) => log::warn!("cannot revalidate {label}: {error}"),
        }
        state.refresh_guard().await.remove(&label);
    });
}
