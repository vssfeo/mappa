//! Resumable download workers and their Tauri commands.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use mappa_core::TileRange;
use mappa_storage::{
    DownloadJob, DownloadStore, ExportReport, ExportSpec, JobStatus, NewJob, TileKey,
    export_region, export_region_pmtiles, pack_file_name,
};
use serde::Deserialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;
use crate::tiles::{has_tile, load_tile};

/// Event emitted whenever a job changes.
pub const JOB_EVENT: &str = "downloads://job";
/// Event emitted when a job is deleted by id.
pub const REMOVED_EVENT: &str = "downloads://removed";
/// Guard rail against accidental world-scale downloads.
pub const MAX_JOB_TILES: u64 = 2_000_000;

const EMIT_INTERVAL: Duration = Duration::from_millis(120);

/// Queue runtime shared by commands and workers.
pub struct Downloads {
    store: Arc<DownloadStore>,
    state: Arc<AppState>,
    app: AppHandle,
    running: Mutex<HashMap<String, Arc<JobControl>>>,
}

#[derive(Debug, Default)]
struct JobControl {
    paused: AtomicBool,
    cancelled: AtomicBool,
    /// Wakes the worker out of an in-flight tile fetch.
    notify: tokio::sync::Notify,
}

/// Request from the download sheet.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewDownloadRequest {
    /// Optional display name.
    pub name: Option<String>,
    /// Provider id.
    pub provider_id: String,
    /// West bound.
    pub west: f64,
    /// South bound.
    pub south: f64,
    /// East bound.
    pub east: f64,
    /// North bound.
    pub north: f64,
    /// First zoom.
    pub min_zoom: u8,
    /// Last zoom.
    pub max_zoom: u8,
    /// Optional polygon mask in WGS84.
    #[serde(default)]
    pub polygon: Option<Vec<[f64; 2]>>,
    /// Additional providers used when the primary source fails.
    #[serde(default)]
    pub source_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    Pause,
    Cancel,
}

impl Downloads {
    /// Wraps the queue and starts jobs left over from a previous run.
    pub fn new(store: DownloadStore, state: Arc<AppState>, app: AppHandle) -> Arc<Self> {
        let downloads = Arc::new(Self {
            store: Arc::new(store),
            state,
            app,
            running: Mutex::new(HashMap::new()),
        });
        match downloads.store.recover_interrupted() {
            Ok(recovered) if recovered > 0 => {
                log::info!("recovered {recovered} interrupted download job(s)")
            }
            Ok(_) => {}
            Err(error) => log::warn!("cannot recover download queue: {error}"),
        }
        match downloads.store.list() {
            Ok(jobs) => {
                for job in jobs
                    .into_iter()
                    .filter(|job| job.status == JobStatus::Queued)
                {
                    downloads.start(job.id);
                }
            }
            Err(error) => log::warn!("cannot list download queue: {error}"),
        }
        downloads
    }

    fn emit(&self, job: &DownloadJob) {
        if let Err(error) = self.app.emit(JOB_EVENT, job) {
            log::warn!("cannot emit download progress: {error}");
        }
    }

    fn emit_current(&self, id: &str) {
        if let Ok(Some(job)) = self.store.get(id) {
            self.emit(&job);
        }
    }

    /// Writes a terminal/worker status without overwriting a user cancel.
    fn publish_if_running(&self, id: &str, status: JobStatus, error: Option<&str>) {
        match self.store.set_status_if_running(id, status, error) {
            Ok(_) => self.emit_current(id),
            Err(problem) => log::warn!("cannot update job {id}: {problem}"),
        }
    }

    fn publish_unless_terminal(&self, id: &str, status: JobStatus, error: Option<&str>) {
        match self.store.set_status_unless_terminal(id, status, error) {
            Ok(_) => self.emit_current(id),
            Err(problem) => log::warn!("cannot update job {id}: {problem}"),
        }
    }

    fn publish_progress(
        &self,
        id: &str,
        done: u64,
        failed: u64,
        bytes: u64,
        cursor: u64,
    ) -> Option<DownloadJob> {
        if let Err(error) = self.store.update_progress(id, done, failed, bytes, cursor) {
            log::warn!("cannot store progress for {id}: {error}");
        }
        match self.store.get(id) {
            Ok(Some(job)) => {
                self.emit(&job);
                Some(job)
            }
            Ok(None) => None,
            Err(error) => {
                log::warn!("cannot read job {id}: {error}");
                None
            }
        }
    }

    /// Spawns a worker unless one already exists for the job.
    ///
    /// The control handle is registered before the task is spawned so a
    /// pause/cancel that arrives immediately after `create_download` can
    /// always reach it.
    pub fn start(self: &Arc<Self>, job_id: String) {
        let control = {
            let mut running = self.running.lock().expect("downloads mutex poisoned");
            if running.contains_key(&job_id) {
                return;
            }
            let control = Arc::new(JobControl::default());
            running.insert(job_id.clone(), Arc::clone(&control));
            control
        };
        let downloads = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            downloads.run(job_id, control).await;
        });
    }

    async fn run(self: Arc<Self>, job_id: String, control: Arc<JobControl>) {
        let job = match self.store.get(&job_id) {
            Ok(Some(job)) => job,
            Ok(None) => {
                self.running
                    .lock()
                    .expect("downloads mutex poisoned")
                    .remove(&job_id);
                return;
            }
            Err(error) => {
                log::warn!("cannot load job {job_id}: {error}");
                self.running
                    .lock()
                    .expect("downloads mutex poisoned")
                    .remove(&job_id);
                return;
            }
        };
        if matches!(
            job.status,
            JobStatus::Completed | JobStatus::Cancelled | JobStatus::Failed
        ) {
            self.running
                .lock()
                .expect("downloads mutex poisoned")
                .remove(&job_id);
            return;
        }
        let Some(provider) = self.state.provider(&job.provider_id).await else {
            self.publish_unless_terminal(
                &job_id,
                JobStatus::Failed,
                Some("provider is no longer available"),
            );
            self.running
                .lock()
                .expect("downloads mutex poisoned")
                .remove(&job_id);
            return;
        };
        if !provider.offline_allowed {
            self.publish_unless_terminal(
                &job_id,
                JobStatus::Failed,
                Some("provider does not allow offline downloads"),
            );
            self.running
                .lock()
                .expect("downloads mutex poisoned")
                .remove(&job_id);
            return;
        }
        // Fallback sources are optional; a broken one must not prevent the
        // primary provider from doing the work.
        let mut fallbacks = Vec::new();
        for id in &job.source_ids {
            if id == &job.provider_id {
                continue;
            }
            match self.state.provider(id).await {
                Some(candidate) if candidate.offline_allowed => {
                    log::info!("download {job_id}: fallback source {id}");
                    fallbacks.push(candidate);
                }
                Some(_) => log::warn!("download {job_id}: {id} forbids offline downloads"),
                None => log::warn!("download {job_id}: unknown fallback source {id}"),
            }
        }
        let mut fallbacks = Vec::new();
        for id in job.source_ids.iter().take(4) {
            if let Some(fallback) = self.state.provider(id).await
                && fallback.offline_allowed
            {
                fallbacks.push(fallback);
            }
        }
        let Some(bbox) = job.bbox() else {
            self.publish_unless_terminal(&job_id, JobStatus::Failed, Some("invalid bounds"));
            self.running
                .lock()
                .expect("downloads mutex poisoned")
                .remove(&job_id);
            return;
        };

        // A pause/cancel may have landed between loading the job and here.
        match self.store.set_running_if_queued(&job_id) {
            Ok(true) => self.emit_current(&job_id),
            Ok(false) => {
                self.running
                    .lock()
                    .expect("downloads mutex poisoned")
                    .remove(&job_id);
                return;
            }
            Err(error) => {
                log::warn!("cannot start job {job_id}: {error}");
                self.publish_unless_terminal(&job_id, JobStatus::Failed, Some(&error.to_string()));
                self.running
                    .lock()
                    .expect("downloads mutex poisoned")
                    .remove(&job_id);
                return;
            }
        }
        log::info!(
            "download {job_id} started: {} z{}–z{} ({} tiles)",
            job.provider_id,
            job.min_zoom,
            job.max_zoom,
            job.total_tiles
        );

        let mut done = job.done_tiles;
        let mut failed = 0_u64;
        // Resumed workers start from the bytes already attributed to the job;
        // the consumed range prefix is skipped entirely.
        let mut bytes = job.bytes;
        let mut position = 0_u64;
        let mut stop: Option<Stop> = None;
        let mut last_emit = Instant::now();
        let started = Instant::now();
        let mask = job
            .polygon
            .as_deref()
            .map(|ring| (ring, mappa_core::ring_bounds(ring)));

        'zoom: for zoom in job.min_zoom..=job.max_zoom {
            let range = match TileRange::new(&bbox, zoom) {
                Ok(range) => range,
                Err(error) => {
                    self.publish_if_running(
                        &job_id,
                        JobStatus::Failed,
                        Some(&format!("z{zoom}: {error}")),
                    );
                    self.running
                        .lock()
                        .expect("downloads mutex poisoned")
                        .remove(&job_id);
                    return;
                }
            };
            for coord in range.iter() {
                if position < job.cursor_tiles {
                    position += 1;
                    continue;
                }
                if control.cancelled.load(Ordering::Relaxed) {
                    stop = Some(Stop::Cancel);
                    break 'zoom;
                }
                if control.paused.load(Ordering::Relaxed) {
                    stop = Some(Stop::Pause);
                    break 'zoom;
                }
                if let Some((ring, bounds)) = &mask {
                    let (west, south, east, north) = coord.bounds();
                    if !mappa_core::tile_intersects_ring_with_bounds(
                        west, south, east, north, ring, *bounds,
                    ) {
                        position += 1;
                        continue;
                    }
                }

                let key = TileKey::new(
                    &job.provider_id,
                    zoom,
                    coord.x(),
                    coord.y(),
                    &provider.format,
                );
                match has_tile(&self.state, &key).await {
                    Ok(true) => done += 1,
                    Ok(false) => {
                        if control.cancelled.load(Ordering::Relaxed) {
                            stop = Some(Stop::Cancel);
                            break 'zoom;
                        }
                        if control.paused.load(Ordering::Relaxed) {
                            stop = Some(Stop::Pause);
                            break 'zoom;
                        }
                        // Dropping the fetch future on pause/cancel releases
                        // the provider permit immediately. A wake-up whose
                        // flag was already cleared by resume restarts the
                        // fetch instead of pausing spuriously.
                        let loaded = loop {
                            tokio::select! {
                                biased;
                                _ = control.notify.notified() => {
                                    if control.cancelled.load(Ordering::Relaxed) {
                                        stop = Some(Stop::Cancel);
                                        break 'zoom;
                                    }
                                    if control.paused.load(Ordering::Relaxed) {
                                        stop = Some(Stop::Pause);
                                        break 'zoom;
                                    }
                                }
                                result = load_tile(&self.state, &provider, &key) => {
                                    break result;
                                }
                            }
                        };
                        match loaded {
                            Ok(tile) => {
                                done += 1;
                                bytes = bytes.saturating_add(tile.data.len() as u64);
                            }
                            Err(error) => {
                                let mut recovered = false;
                                for fallback in &fallbacks {
                                    if zoom < fallback.min_zoom || zoom > fallback.max_zoom {
                                        continue;
                                    }
                                    match load_tile(&self.state, fallback, &key).await {
                                        Ok(tile) => {
                                            done += 1;
                                            bytes = bytes.saturating_add(tile.data.len() as u64);
                                            recovered = true;
                                            log::info!(
                                                "download {job_id}: {} recovered from {}",
                                                key.label(),
                                                fallback.id
                                            );
                                            break;
                                        }
                                        Err(fallback_error) => log::debug!(
                                            "download {job_id}: fallback {} for {}: {fallback_error}",
                                            fallback.id,
                                            key.label()
                                        ),
                                    }
                                }
                                if !recovered {
                                    failed += 1;
                                    log::warn!("download {job_id}: {}: {error}", key.label());
                                }
                            }
                        }
                    }
                    Err(error) => {
                        failed += 1;
                        log::warn!("download {job_id}: cache {}: {error}", key.label());
                    }
                }

                position += 1;
                if last_emit.elapsed() >= EMIT_INTERVAL {
                    self.publish_progress(&job_id, done, failed, bytes, position);
                    last_emit = Instant::now();
                }
            }
        }

        self.publish_progress(&job_id, done, failed, bytes, position);
        match stop {
            Some(Stop::Pause) => {
                self.publish_unless_terminal(&job_id, JobStatus::Paused, None);
                log::info!("download {job_id} paused at {done}/{}", job.total_tiles);
            }
            Some(Stop::Cancel) => {
                self.publish_unless_terminal(&job_id, JobStatus::Cancelled, None);
                log::info!("download {job_id} cancelled at {done}/{}", job.total_tiles);
            }
            None => {
                let elapsed = started.elapsed();
                let message = (failed > 0).then(|| format!("{failed} tiles failed"));
                self.publish_if_running(&job_id, JobStatus::Completed, message.as_deref());
                log::info!(
                    "download {job_id} completed: {done} done, {failed} failed, {} bytes in {:.1}s",
                    bytes,
                    elapsed.as_secs_f64()
                );
            }
        }
        self.running
            .lock()
            .expect("downloads mutex poisoned")
            .remove(&job_id);
    }

    async fn control(&self, id: &str) -> Option<Arc<JobControl>> {
        self.running
            .lock()
            .expect("downloads mutex poisoned")
            .get(id)
            .cloned()
    }
}

/// Creates a job and starts its worker.
#[tauri::command]
pub async fn create_download(
    downloads: State<'_, Arc<Downloads>>,
    request: NewDownloadRequest,
) -> Result<DownloadJob, String> {
    let provider = downloads
        .state
        .provider(&request.provider_id)
        .await
        .ok_or_else(|| format!("unknown provider {:?}", request.provider_id))?;
    if request.min_zoom > request.max_zoom {
        return Err("минимальный зум больше максимального".to_owned());
    }
    if request.min_zoom < provider.min_zoom || request.max_zoom > provider.max_zoom {
        return Err(format!(
            "{} поддерживает z{}–z{}",
            provider.name, provider.min_zoom, provider.max_zoom
        ));
    }
    if !provider.offline_allowed {
        return Err(format!(
            "{} не разрешает офлайн-скачивание тайлов. Используйте источник с разрешённым bulk-доступом или собственный сервер.",
            provider.name
        ));
    }

    let mut fallback_ids: Vec<String> = Vec::new();
    for id in request.source_ids.iter().take(4) {
        if id == &request.provider_id || fallback_ids.contains(id) {
            continue;
        }
        let Some(fallback) = downloads.state.provider(id).await else {
            continue;
        };
        if !fallback.offline_allowed {
            continue;
        }
        fallback_ids.push(id.clone());
    }

    let name = request
        .name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| {
            format!(
                "{} · z{}–z{}",
                provider.name, request.min_zoom, request.max_zoom
            )
        });
    let job = downloads
        .store
        .create(NewJob {
            name,
            provider_id: request.provider_id,
            west: request.west,
            south: request.south,
            east: request.east,
            north: request.north,
            min_zoom: request.min_zoom,
            max_zoom: request.max_zoom,
            polygon: request.polygon,
            source_ids: fallback_ids,
        })
        .map_err(|error| error.to_string())?;

    if job.total_tiles > MAX_JOB_TILES {
        let _ = downloads.store.delete(&job.id);
        return Err(format!(
            "слишком большой район: {} тайлов, лимит {}",
            job.total_tiles, MAX_JOB_TILES
        ));
    }

    downloads.emit(&job);
    downloads.start(job.id.clone());
    Ok(job)
}

/// Returns all jobs in display order.
#[tauri::command]
pub async fn list_downloads(
    downloads: State<'_, Arc<Downloads>>,
) -> Result<Vec<DownloadJob>, String> {
    downloads.store.list().map_err(|error| error.to_string())
}

/// Pauses a queued or running job.
#[tauri::command]
pub async fn pause_download(
    downloads: State<'_, Arc<Downloads>>,
    id: String,
) -> Result<(), String> {
    if let Some(control) = downloads.control(&id).await {
        control.paused.store(true, Ordering::Relaxed);
        control.notify.notify_one();
    }
    let job = downloads
        .store
        .get(&id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "job not found".to_owned())?;
    if job.status.is_terminal() {
        return Err("job is already finished".to_owned());
    }
    downloads.publish_unless_terminal(&id, JobStatus::Paused, None);
    Ok(())
}

/// Resumes a paused or queued job, or adopts an orphaned worker.
#[tauri::command]
pub async fn resume_download(
    downloads: State<'_, Arc<Downloads>>,
    id: String,
) -> Result<(), String> {
    let job = downloads
        .store
        .get(&id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "job not found".to_owned())?;
    if job.status.is_terminal() {
        return Err("job is already finished".to_owned());
    }
    if let Some(control) = downloads.control(&id).await {
        control.paused.store(false, Ordering::Relaxed);
        control.cancelled.store(false, Ordering::Relaxed);
        match downloads
            .store
            .set_status_unless_terminal(&id, JobStatus::Running, None)
        {
            Ok(true) => downloads.emit_current(&id),
            Ok(false) => return Err("job is already finished".to_owned()),
            Err(error) => return Err(error.to_string()),
        }
    } else {
        match downloads
            .store
            .set_status_unless_terminal(&id, JobStatus::Queued, None)
        {
            Ok(true) => downloads.emit_current(&id),
            Ok(false) => return Err("job is already finished".to_owned()),
            Err(error) => return Err(error.to_string()),
        }
        downloads.start(id);
    }
    Ok(())
}

/// Cancels a job and stops its worker after the current request.
#[tauri::command]
pub async fn cancel_download(
    downloads: State<'_, Arc<Downloads>>,
    id: String,
) -> Result<(), String> {
    if let Some(control) = downloads.control(&id).await {
        control.cancelled.store(true, Ordering::Relaxed);
        control.notify.notify_one();
    }
    downloads.publish_unless_terminal(&id, JobStatus::Cancelled, None);
    Ok(())
}

/// Deletes a finished job.
#[tauri::command]
pub async fn delete_download(
    downloads: State<'_, Arc<Downloads>>,
    id: String,
) -> Result<(), String> {
    if downloads.control(&id).await.is_some() {
        return Err("сначала остановите загрузку".to_owned());
    }
    downloads
        .store
        .delete(&id)
        .map_err(|error| error.to_string())?;
    if let Err(error) = downloads.app.emit(REMOVED_EVENT, id) {
        log::warn!("cannot emit download removal: {error}");
    }
    Ok(())
}

/// Removes completed and cancelled jobs.
#[tauri::command]
pub async fn clear_finished_downloads(downloads: State<'_, Arc<Downloads>>) -> Result<u64, String> {
    downloads
        .store
        .clear_finished()
        .map_err(|error| error.to_string())
}

/// Packs the cached tiles of a job into an MBTiles or PMTiles file.
#[tauri::command]
pub async fn export_job_pack(
    downloads: State<'_, Arc<Downloads>>,
    id: String,
    kind: String,
    license: Option<String>,
) -> Result<ExportReport, String> {
    let extension = match kind.as_str() {
        "mbtiles" => "mbtiles",
        "pmtiles" => "pmtiles",
        other => return Err(format!("unknown pack kind {other:?}")),
    };
    let job = downloads
        .store
        .get(&id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "job not found".to_owned())?;
    if job.status == JobStatus::Running {
        return Err("поставьте загрузку на паузу перед экспортом".to_owned());
    }
    let provider = downloads
        .state
        .provider(&job.provider_id)
        .await
        .ok_or_else(|| "provider is no longer available".to_owned())?;
    let bbox = job.bbox().ok_or_else(|| "invalid bounds".to_owned())?;
    let directory = downloads
        .app
        .path()
        .download_dir()
        .or_else(|_| downloads.app.path().home_dir())
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let file_name = pack_file_name(&job.name, &job.id, extension);
    let mut output = directory.join(&file_name);
    if output.exists() {
        let stem = file_name.trim_end_matches(&format!(".{extension}"));
        output = directory.join(format!("{stem}-{}.{extension}", mappa_storage::now_unix()));
    }

    let spec = ExportSpec {
        provider_id: job.provider_id.clone(),
        name: job.name.clone(),
        west: bbox.west(),
        south: bbox.south(),
        east: bbox.east(),
        north: bbox.north(),
        min_zoom: job.min_zoom,
        max_zoom: job.max_zoom,
        polygon: job.polygon.clone(),
        format: provider.format.clone(),
        attribution: Some(provider.attribution.clone()),
        license: license.clone(),
        output: output.clone(),
    };
    let cache = Arc::clone(&downloads.state.cache);
    log::info!("export {id} -> {}", output.display());
    let report = tauri::async_runtime::spawn_blocking(move || {
        let result = if extension == "pmtiles" {
            export_region_pmtiles(&cache, &spec, |_, _| {})
        } else {
            export_region(&cache, &spec, |_, _| {})
        };
        result.map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;

    // The manifest lives next to the pack; its signing key belongs to the
    // application data directory and never travels with an exported pack.
    let key_path = downloads
        .app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("pack-signing.key");
    let pack_path = report.path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        mappa_storage::write_manifest(&pack_path, license.as_deref(), &key_path)
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(report)
}
