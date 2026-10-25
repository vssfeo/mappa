//! Batch JSON jobs for headless download and pack runs.
//!
//! The input is a small, versioned JSON document. Jobs run in order and can be
//! repeated safely: downloads reuse cached tiles, and packs with a valid
//! manifest are reported as skipped instead of being overwritten.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use clap::Args;
use mappa_storage::verify_manifest;
use serde::{Deserialize, Serialize};

use crate::{
    DownloadArgs, DownloadReport, PackArgs, PackReport, print_json, run_download, run_pack,
};

#[derive(Debug, Args)]
pub struct BatchArgs {
    /// JSON-файл с массивом заданий.
    pub file: PathBuf,
    /// Остановиться после первого неудачного задания.
    #[arg(long)]
    pub fail_fast: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BatchFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    cache: Option<PathBuf>,
    #[serde(default)]
    providers_dir: Option<PathBuf>,
    jobs: Vec<JobSpec>,
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum JobSpec {
    Download {
        id: String,
        provider: String,
        bbox: [f64; 4],
        zoom: ZoomSpec,
        #[serde(default)]
        cache: Option<PathBuf>,
        #[serde(default)]
        providers_dir: Option<PathBuf>,
        #[serde(default)]
        max_tiles: Option<u64>,
        #[serde(default)]
        limit_mb: Option<u64>,
    },
    Pack {
        id: String,
        provider: String,
        bbox: [f64; 4],
        zoom: ZoomSpec,
        output: PathBuf,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        license: Option<String>,
        #[serde(default)]
        cache: Option<PathBuf>,
        #[serde(default)]
        providers_dir: Option<PathBuf>,
    },
}

impl JobSpec {
    fn id(&self) -> &str {
        match self {
            Self::Download { id, .. } | Self::Pack { id, .. } => id,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::Download { .. } => "download",
            Self::Pack { .. } => "pack",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ZoomSpec {
    Pair([u8; 2]),
    Single(u8),
    Text(String),
}

impl ZoomSpec {
    fn to_arg(&self) -> Result<String> {
        match self {
            Self::Pair([min, max]) => {
                if min > max {
                    bail!("min zoom {min} is greater than max zoom {max}");
                }
                if *max > 30 {
                    bail!("max zoom {max} is above 30");
                }
                Ok(if min == max {
                    min.to_string()
                } else {
                    format!("{min}-{max}")
                })
            }
            Self::Single(zoom) => Ok(zoom.to_string()),
            Self::Text(text) => Ok(text.clone()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobReport {
    index: usize,
    id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    download: Option<DownloadReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pack: Option<PackReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchReport {
    file: PathBuf,
    total: usize,
    completed: usize,
    skipped: usize,
    failed: usize,
    not_run: usize,
    seconds: f64,
    jobs: Vec<JobReport>,
}

pub async fn run(args: BatchArgs, json: bool) -> Result<()> {
    let started = Instant::now();
    let text = std::fs::read_to_string(&args.file)
        .with_context(|| format!("cannot read batch file {}", args.file.display()))?;
    let batch: BatchFile = serde_json::from_str(&text)
        .with_context(|| format!("cannot parse batch file {}", args.file.display()))?;
    validate(&batch)?;
    let base = args
        .file
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut jobs = Vec::with_capacity(batch.jobs.len());
    let mut completed = 0_usize;
    let mut skipped = 0_usize;
    let mut failed = 0_usize;
    let mut not_run = 0_usize;
    let mut stop = false;
    for (offset, job) in batch.jobs.iter().enumerate() {
        let index = offset + 1;
        if stop {
            not_run += 1;
            jobs.push(JobReport {
                index,
                id: job.id().to_owned(),
                kind: job.kind(),
                status: "notRun",
                reason: Some("остановлено после ошибки".to_owned()),
                error: None,
                download: None,
                pack: None,
            });
            continue;
        }
        let report = execute(index, job, &batch, base).await;
        match report.status {
            "completed" => completed += 1,
            "skipped" => skipped += 1,
            "failed" => {
                failed += 1;
                if args.fail_fast {
                    stop = true;
                }
            }
            _ => {}
        }
        jobs.push(report);
    }
    let report = BatchReport {
        file: args.file,
        total: jobs.len(),
        completed,
        skipped,
        failed,
        not_run,
        seconds: started.elapsed().as_secs_f64(),
        jobs,
    };
    if json {
        print_json(&report)?;
    } else {
        print_human(&report);
    }
    if failed > 0 {
        bail!("{failed} заданий завершились с ошибкой");
    }
    Ok(())
}

fn validate(batch: &BatchFile) -> Result<()> {
    if batch.version != 1 {
        bail!("unsupported batch version {} (expected 1)", batch.version);
    }
    if batch.jobs.is_empty() {
        bail!("batch file has no jobs");
    }
    let mut ids = HashSet::new();
    for job in &batch.jobs {
        if job.id().trim().is_empty() {
            bail!("every batch job needs a non-empty id");
        }
        if !ids.insert(job.id()) {
            bail!("duplicate batch job id {:?}", job.id());
        }
        match job {
            JobSpec::Download { zoom, .. } | JobSpec::Pack { zoom, .. } => {
                zoom.to_arg()?;
            }
        }
        match job {
            JobSpec::Download { bbox, .. } | JobSpec::Pack { bbox, .. } => {
                mappa_core::Bbox::new(bbox[0], bbox[1], bbox[2], bbox[3])
                    .map_err(anyhow::Error::msg)?;
            }
        }
    }
    Ok(())
}

async fn execute(index: usize, job: &JobSpec, batch: &BatchFile, base: &Path) -> JobReport {
    let id = job.id().to_owned();
    let kind = job.kind();
    match job {
        JobSpec::Download {
            provider,
            bbox,
            zoom,
            cache,
            providers_dir,
            max_tiles,
            limit_mb,
            ..
        } => {
            let zoom = match zoom.to_arg() {
                Ok(zoom) => zoom,
                Err(error) => return failed(index, id, kind, format!("{error:#}")),
            };
            let args = DownloadArgs {
                provider: provider.clone(),
                bbox: bbox_arg(bbox),
                zoom,
                cache: resolve(base, cache.as_deref().or(batch.cache.as_deref())),
                providers_dir: resolve(
                    base,
                    providers_dir.as_deref().or(batch.providers_dir.as_deref()),
                ),
                max_tiles: max_tiles.unwrap_or(2_000_000),
                limit_mb: limit_mb.unwrap_or(2048),
                dry_run: false,
            };
            match run_download(&args, true).await {
                Ok(report) => {
                    let failed_tiles = report.failed;
                    JobReport {
                        index,
                        id,
                        kind,
                        status: if failed_tiles == 0 {
                            "completed"
                        } else {
                            "failed"
                        },
                        reason: None,
                        error: (failed_tiles > 0)
                            .then(|| format!("{failed_tiles} тайлов не скачались")),
                        download: Some(report),
                        pack: None,
                    }
                }
                Err(error) => failed(index, id, kind, format!("{error:#}")),
            }
        }
        JobSpec::Pack {
            provider,
            bbox,
            zoom,
            output,
            name,
            license,
            cache,
            providers_dir,
            ..
        } => {
            let zoom = match zoom.to_arg() {
                Ok(zoom) => zoom,
                Err(error) => return failed(index, id, kind, format!("{error:#}")),
            };
            let output = resolve_required(base, output);
            if output.exists() {
                return match verify_manifest(&output) {
                    Ok(_) => JobReport {
                        index,
                        id,
                        kind,
                        status: "skipped",
                        reason: Some(format!(
                            "{} уже существует и подпись манифеста верна",
                            output.display()
                        )),
                        error: None,
                        download: None,
                        pack: None,
                    },
                    Err(error) => failed(
                        index,
                        id,
                        kind,
                        format!(
                            "{} существует, но манифест не проходит проверку: {error}; \
                             удалите пак, чтобы пересобрать его",
                            output.display()
                        ),
                    ),
                };
            }
            let args = PackArgs {
                provider: provider.clone(),
                bbox: bbox_arg(bbox),
                zoom,
                output,
                name: name.clone(),
                license: license.clone(),
                cache: resolve(base, cache.as_deref().or(batch.cache.as_deref())),
                providers_dir: resolve(
                    base,
                    providers_dir.as_deref().or(batch.providers_dir.as_deref()),
                ),
            };
            match run_pack(&args, true) {
                Ok(report) => JobReport {
                    index,
                    id,
                    kind,
                    status: "completed",
                    reason: None,
                    error: None,
                    download: None,
                    pack: Some(report),
                },
                Err(error) => failed(index, id, kind, format!("{error:#}")),
            }
        }
    }
}

fn failed(index: usize, id: String, kind: &'static str, error: String) -> JobReport {
    JobReport {
        index,
        id,
        kind,
        status: "failed",
        reason: None,
        error: Some(error),
        download: None,
        pack: None,
    }
}

fn bbox_arg(bbox: &[f64; 4]) -> String {
    format!("{},{},{},{}", bbox[0], bbox[1], bbox[2], bbox[3])
}

fn resolve(base: &Path, path: Option<&Path>) -> Option<PathBuf> {
    path.map(|path| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            base.join(path)
        }
    })
}

fn resolve_required(base: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    }
}

fn print_human(report: &BatchReport) {
    for job in &report.jobs {
        let detail = if let Some(error) = &job.error {
            format!(": {error}")
        } else if let Some(reason) = &job.reason {
            format!(": {reason}")
        } else if let Some(download) = &job.download {
            format!(
                ": скачано {}, пропущено {}, ошибок {}",
                download.downloaded, download.skipped, download.failed
            )
        } else if let Some(pack) = &job.pack {
            format!(
                ": {} тайлов, {}",
                pack.tiles,
                crate::human_bytes(pack.bytes)
            )
        } else {
            String::new()
        };
        let label = match job.status {
            "completed" => "готово",
            "skipped" => "пропущено",
            "failed" => "ошибка",
            _ => "не запускалось",
        };
        println!(
            "[{}/{}] {} {} — {label}{detail}",
            job.index, report.total, job.kind, job.id
        );
    }
    println!(
        "итог: готово {}, пропущено {}, ошибок {}, не запускалось {}, {:.1} с",
        report.completed, report.skipped, report.failed, report.not_run, report.seconds
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<BatchFile> {
        Ok(serde_json::from_str(text)?)
    }

    #[test]
    fn parses_download_and_pack_jobs() {
        let batch = parse(
            r#"{
                "version": 1,
                "cache": "state/tiles.sqlite3",
                "jobs": [
                    {
                        "type": "download",
                        "id": "crimea-topo",
                        "provider": "topo",
                        "bbox": [33.0, 44.0, 36.0, 46.0],
                        "zoom": [10, 12],
                        "maxTiles": 1000
                    },
                    {
                        "type": "pack",
                        "id": "crimea-pack",
                        "provider": "topo",
                        "bbox": [33.0, 44.0, 36.0, 46.0],
                        "zoom": "10-12",
                        "output": "out/crimea.mbtiles",
                        "license": "ODbL"
                    }
                ]
            }"#,
        )
        .unwrap();
        validate(&batch).unwrap();
        assert_eq!(batch.jobs.len(), 2);
        assert_eq!(batch.jobs[0].id(), "crimea-topo");
        assert_eq!(batch.jobs[1].kind(), "pack");
        match &batch.jobs[0] {
            JobSpec::Download {
                zoom, max_tiles, ..
            } => {
                assert_eq!(zoom.to_arg().unwrap(), "10-12");
                assert_eq!(*max_tiles, Some(1000));
            }
            _ => panic!("expected download"),
        }
    }

    #[test]
    fn accepts_single_zoom_and_rejects_duplicate_ids() {
        let batch = parse(
            r#"{"jobs": [
                {"type":"download","id":"a","provider":"usgs","bbox":[0,0,1,1],"zoom":12},
                {"type":"download","id":"a","provider":"usgs","bbox":[0,0,1,1],"zoom":"12"}
            ]}"#,
        )
        .unwrap();
        let error = validate(&batch).unwrap_err().to_string();
        assert!(error.contains("duplicate"));
    }

    #[test]
    fn resolves_paths_relative_to_batch_file() {
        let base = Path::new("/tmp/maps");
        assert_eq!(
            resolve(base, Some(Path::new("cache/tiles.sqlite3"))).unwrap(),
            PathBuf::from("/tmp/maps/cache/tiles.sqlite3")
        );
        assert_eq!(
            resolve(base, Some(Path::new("/var/lib/mappa/tiles.sqlite3"))).unwrap(),
            PathBuf::from("/var/lib/mappa/tiles.sqlite3")
        );
        assert_eq!(resolve(base, None), None);
    }

    #[test]
    fn rejects_bad_zoom_ranges() {
        let batch = parse(
            r#"{"jobs": [
                {"type":"download","id":"a","provider":"usgs","bbox":[0,0,1,1],"zoom":[13,10]}
            ]}"#,
        )
        .unwrap();
        assert!(validate(&batch).is_err());
    }
}
