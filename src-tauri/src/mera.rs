//! MERA GNSS RTK/PPK sidecar bridge (zero unsafe, process-isolated).
//!
//! Invokes the standalone `mera-rtk` C++20 binary (built from the sibling Mera
//! repository with `-DMERA_NATIVE=OFF`), streams JSONL progress events to the
//! UI on `mera://progress`, and returns the generated `.pos`, GeoJSON and NMEA
//! artifact paths plus the parsed run summary.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

const VALID_PROFILES: &[&str] = &[
    "core-causal",
    "core-causal-tuned",
    "core-lag10",
    "core-postprocess",
];

#[derive(Default)]
pub struct MeraRunner {
    running: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeraStatus {
    pub available: bool,
    pub binary_path: Option<String>,
    pub running: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeraPpkRequest {
    pub rover_path: String,
    pub base_path: String,
    pub nav_path: String,
    pub atx_path: Option<String>,
    pub ant_base: Option<String>,
    pub profile: Option<String>,
    pub elev_mask_deg: Option<f64>,
    pub cn0_min_db_hz: Option<f64>,
    pub out_dir: String,
    pub emit_nmea: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeraProgressEvent {
    pub epoch: usize,
    pub total: usize,
    pub fixed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeraSummary {
    pub solver: String,
    pub profile: String,
    pub causality_mode: String,
    pub epochs: usize,
    pub fixed_epochs: usize,
    pub fixed_share_pct: f64,
    #[serde(rename = "medianSigmaH_m")]
    pub median_sigma_h_m: f64,
    pub wall_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeraPpkResult {
    pub summary: MeraSummary,
    pub out_pos: String,
    pub out_geojson: String,
    pub out_nmea: Option<String>,
    pub out_summary: String,
}

fn sidecar_filename() -> String {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    format!("mera-rtk{ext}")
}

/// Locate the `mera-rtk` sidecar binary:
/// 1. Explicit `MERA_RTK_BIN` environment override;
/// 2. Sibling `binaries/mera-rtk*` next to the current executable or manifest;
/// 3. `mera-rtk` on `PATH`.
pub fn resolve_binary() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("MERA_RTK_BIN") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
    }
    let name = sidecar_filename();
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let direct = dir.join(&name);
        if direct.is_file() {
            return Some(direct);
        }
        let binaries_dir = dir.join("binaries");
        if let Some(found) = find_prefixed_binary(&binaries_dir) {
            return Some(found);
        }
    }
    let dev_binaries = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    if let Some(found) = find_prefixed_binary(&dev_binaries) {
        return Some(found);
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for entry in std::env::split_paths(&path_var) {
            let candidate = entry.join(&name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn find_prefixed_binary(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some(fname) = path.file_name().and_then(|s| s.to_str())
            && fname.starts_with("mera-rtk")
        {
            return Some(path);
        }
    }
    None
}

fn build_cli_args(
    req: &MeraPpkRequest,
    out_pos: &Path,
    out_geojson: &Path,
    out_nmea: Option<&Path>,
    out_summary: &Path,
) -> Result<Vec<String>, String> {
    let profile = req.profile.as_deref().unwrap_or("core-causal");
    if !VALID_PROFILES.contains(&profile) {
        return Err(format!("unsupported MERA profile: {profile}"));
    }
    if req.rover_path.trim().is_empty()
        || req.base_path.trim().is_empty()
        || req.nav_path.trim().is_empty()
    {
        return Err("rover, base and nav paths are required".to_owned());
    }
    let mut args = vec![
        "--rover".to_owned(),
        req.rover_path.clone(),
        "--base".to_owned(),
        req.base_path.clone(),
        "--nav".to_owned(),
        req.nav_path.clone(),
        "--profile".to_owned(),
        profile.to_owned(),
        "--solver".to_owned(),
        "ekf".to_owned(),
        "--progress".to_owned(),
        "--out-pos".to_owned(),
        out_pos.to_string_lossy().into_owned(),
        "--out-geojson".to_owned(),
        out_geojson.to_string_lossy().into_owned(),
        "--out-summary".to_owned(),
        out_summary.to_string_lossy().into_owned(),
    ];
    if let Some(atx) = req.atx_path.as_deref().filter(|s| !s.trim().is_empty()) {
        args.push("--atx".to_owned());
        args.push(atx.to_owned());
    }
    if let Some(ant) = req.ant_base.as_deref().filter(|s| !s.trim().is_empty()) {
        args.push("--ant-base".to_owned());
        args.push(ant.to_owned());
    }
    if let Some(el) = req.elev_mask_deg {
        args.push("--elev-mask".to_owned());
        args.push(format!("{el:.2}"));
    }
    if let Some(cn0) = req.cn0_min_db_hz {
        args.push("--cn0-min".to_owned());
        args.push(format!("{cn0:.2}"));
    }
    if let Some(nmea_path) = out_nmea {
        args.push("--out-nmea".to_owned());
        args.push(nmea_path.to_string_lossy().into_owned());
    }
    Ok(args)
}

fn parse_progress_line(line: &str) -> Option<MeraProgressEvent> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("event").and_then(|v| v.as_str()) != Some("progress") {
        return None;
    }
    Some(MeraProgressEvent {
        epoch: value.get("epoch")?.as_u64()? as usize,
        total: value.get("total")?.as_u64()? as usize,
        fixed: value.get("fixed")?.as_u64()? as usize,
    })
}

#[tauri::command]
pub fn mera_ppk_status(state: State<'_, MeraRunner>) -> MeraStatus {
    let binary = resolve_binary();
    MeraStatus {
        available: binary.is_some(),
        binary_path: binary.map(|p| p.to_string_lossy().into_owned()),
        running: state.running.load(Ordering::SeqCst),
    }
}

#[tauri::command]
pub fn mera_ppk_cancel(state: State<'_, MeraRunner>) -> bool {
    if state.running.load(Ordering::SeqCst) {
        state.cancel.store(true, Ordering::SeqCst);
        true
    } else {
        false
    }
}

#[tauri::command]
pub async fn mera_ppk_run(
    app: AppHandle,
    state: State<'_, MeraRunner>,
    request: MeraPpkRequest,
) -> Result<MeraPpkResult, String> {
    let binary = resolve_binary().ok_or_else(|| {
        "mera-rtk sidecar binary not found; run scripts/build_mera_sidecar.sh".to_owned()
    })?;
    if state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("another MERA PPK run is already in progress".to_owned());
    }
    state.cancel.store(false, Ordering::SeqCst);

    let out_dir = PathBuf::from(&request.out_dir);
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("cannot create output directory {}: {e}", out_dir.display()))?;
    let out_pos = out_dir.join("solution.pos");
    let out_geojson = out_dir.join("solution.geojson");
    let out_nmea = request
        .emit_nmea
        .unwrap_or(true)
        .then(|| out_dir.join("solution.nmea"));
    let out_summary = out_dir.join("summary.json");

    let args = build_cli_args(
        &request,
        &out_pos,
        &out_geojson,
        out_nmea.as_deref(),
        &out_summary,
    );
    let args = match args {
        Ok(a) => a,
        Err(e) => {
            state.running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };

    let running = Arc::clone(&state.running);
    let cancel = Arc::clone(&state.cancel);
    let out_pos_s = out_pos.to_string_lossy().into_owned();
    let out_geojson_s = out_geojson.to_string_lossy().into_owned();
    let out_nmea_s = out_nmea
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    let out_summary_s = out_summary.to_string_lossy().into_owned();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new(&binary)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to launch {}: {e}", binary.display()))?;

        if let Some(stderr) = child.stderr.take() {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if cancel.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("MERA PPK run cancelled".to_owned());
                }
                if let Some(progress) = parse_progress_line(&line) {
                    let _ = app.emit("mera://progress", progress);
                }
            }
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("failed waiting for mera-rtk: {e}"))?;
        if cancel.load(Ordering::SeqCst) {
            return Err("MERA PPK run cancelled".to_owned());
        }
        if !output.status.success() {
            return Err(format!(
                "mera-rtk exited with status {}",
                output.status
            ));
        }

        let summary_bytes = std::fs::read_to_string(&out_summary)
            .map_err(|e| format!("cannot read summary {}: {e}", out_summary.display()))?;
        let summary: MeraSummary = serde_json::from_str(&summary_bytes)
            .map_err(|e| format!("invalid mera-rtk summary JSON: {e}"))?;

        Ok(MeraPpkResult {
            summary,
            out_pos: out_pos_s,
            out_geojson: out_geojson_s,
            out_nmea: out_nmea_s,
            out_summary: out_summary_s,
        })
    })
    .await
    .map_err(|e| format!("MERA PPK worker panicked: {e}"))?;

    running.store(false, Ordering::SeqCst);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_valid_cli_args_and_rejects_unknown_profile() {
        let mut req = MeraPpkRequest {
            rover_path: "/tmp/rover.obs".into(),
            base_path: "/tmp/base.obs".into(),
            nav_path: "/tmp/base.nav".into(),
            atx_path: Some("/tmp/igs20.atx".into()),
            ant_base: Some("TRM57971.00".into()),
            profile: Some("core-causal".into()),
            elev_mask_deg: Some(15.0),
            cn0_min_db_hz: None,
            out_dir: "/tmp/out".into(),
            emit_nmea: Some(true),
        };
        let args = build_cli_args(
            &req,
            Path::new("/tmp/out/solution.pos"),
            Path::new("/tmp/out/solution.geojson"),
            Some(Path::new("/tmp/out/solution.nmea")),
            Path::new("/tmp/out/summary.json"),
        )
        .expect("args");
        assert!(args.contains(&"--profile".to_owned()));
        assert!(args.contains(&"core-causal".to_owned()));
        assert!(args.contains(&"--out-nmea".to_owned()));

        req.profile = Some("invalid-profile".into());
        assert!(
            build_cli_args(
                &req,
                Path::new("/tmp/a.pos"),
                Path::new("/tmp/a.geojson"),
                None,
                Path::new("/tmp/s.json"),
            )
            .is_err()
        );
    }

    #[test]
    fn parses_jsonl_progress_and_summary() {
        let ev = parse_progress_line(
            r#"{"event":"progress","epoch":250,"total":5201,"fixed":120}"#,
        )
        .expect("progress");
        assert_eq!(
            ev,
            MeraProgressEvent {
                epoch: 250,
                total: 5201,
                fixed: 120
            }
        );
        assert!(parse_progress_line("HOLDPERSIST tow=123.4").is_none());

        let summary: MeraSummary = serde_json::from_str(
            r#"{"solver":"ekf","profile":"core-causal","causalityMode":"causal","epochs":5201,"fixedEpochs":2465,"fixedSharePct":47.39,"medianSigmaH_m":0.0264,"wallSeconds":17.68}"#,
        )
        .expect("summary");
        assert_eq!(summary.causality_mode, "causal");
        assert_eq!(summary.fixed_epochs, 2465);
    }
}
