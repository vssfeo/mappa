//! Mappa desktop shell: cache-backed map viewer.

mod atomic;
mod commands;
mod custom;
mod downloads;
mod export;
mod files;
mod gpkg;
mod packs;
mod settings;
mod state;
mod tiles;
mod wmts;
mod xyz;

use std::sync::Arc;

use tauri::Manager;

use crate::downloads::Downloads;
use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_permission_request(|_, kind| match kind {
            tauri::webview::PermissionKind::Geolocation => {
                tauri::webview::PermissionResponse::Allow
            }
            _ => tauri::webview::PermissionResponse::Default,
        })
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // `MAPPA_LOG=debug` makes release builds diagnosable without a rebuild.
            let level = std::env::var("MAPPA_LOG")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Warn
                });
            app.handle()
                .plugin(tauri_plugin_log::Builder::default().level(level).build())?;

            let cache_dir = app.path().app_cache_dir()?;
            let cache_path = cache_dir.join("tiles.sqlite3");
            let cache = mappa_storage::SqliteCache::open(&cache_path)?;
            let config_dir = app.path().app_config_dir()?;
            let settings_path = config_dir.join("settings.json");
            let custom_path = custom::path(&config_dir);
            let mut settings = settings::load(&settings_path);
            let limit_env = cache_limit_from_env();
            if let Some(limit) = limit_env {
                settings.cache_limit_bytes = limit;
            }
            let limit = settings.cache_limit_bytes;

            let state = Arc::new(AppState::new(
                cache,
                cache_path.clone(),
                settings,
                settings_path,
                custom_path,
            )?);
            app.manage(Arc::clone(&state));

            let queue_path = cache_dir.join("downloads.sqlite3");
            let queue = mappa_storage::DownloadStore::open(&queue_path)?;
            let downloads = Downloads::new(queue, Arc::clone(&state), app.handle().clone());
            app.manage(downloads);

            log::info!(
                "cache {} (limit {:.1} GiB, {} providers)",
                cache_path.display(),
                limit as f64 / 1024.0 / 1024.0 / 1024.0,
                state.providers.len()
            );
            log::info!("download queue {}", queue_path.display());

            let cache = Arc::clone(&state.cache);
            tauri::async_runtime::spawn(async move {
                match tauri::async_runtime::spawn_blocking(move || cache.enforce_limit(limit)).await
                {
                    Ok(Ok(evicted)) if evicted > 0 => log::info!("evicted {evicted} old tiles"),
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => log::warn!("cache budget check failed: {error}"),
                    Err(error) => log::warn!("cache budget task failed: {error}"),
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_providers,
            commands::crs_presets,
            commands::transform_points,
            commands::list_custom_sources,
            commands::save_custom_source,
            commands::delete_custom_source,
            commands::wmts_capabilities,
            commands::cache_stats,
            commands::cache_stats_by_provider,
            commands::coverage_tiles,
            commands::cache_path,
            commands::clear_cache,
            commands::enforce_cache_limit,
            commands::read_tile,
            commands::cancel_tile,
            settings::get_settings,
            settings::update_settings,
            downloads::create_download,
            downloads::list_downloads,
            downloads::pause_download,
            downloads::resume_download,
            downloads::cancel_download,
            downloads::delete_download,
            downloads::clear_finished_downloads,
            downloads::export_job_pack,
            packs::open_pack,
            packs::list_packs,
            packs::close_pack,
            packs::read_pack_tile,
            files::read_text_file,
            files::read_binary_file,
            files::write_binary_file,
            export::export_geotiff,
            commands::import_xyz_folder,
            commands::verify_cache,
            commands::list_geopackage_layers,
            commands::import_geopackage,
            commands::autosave_path,
            commands::open_log_directory,
            files::write_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

fn cache_limit_from_env() -> Option<u64> {
    std::env::var("MAPPA_CACHE_LIMIT_MB")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|megabytes| *megabytes > 0)
        .map(|megabytes| megabytes.saturating_mul(1024 * 1024))
}
