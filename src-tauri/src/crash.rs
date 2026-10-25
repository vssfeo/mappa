//! Opt-in crash reports.
//!
//! Nothing is collected until the user enables the feature. When enabled, a
//! panic or an unhandled JavaScript error writes a small JSON report into the
//! app data directory. Reports never leave the machine by themselves: the UI
//! shows them and the user copies the text or opens a prefilled GitHub issue.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};

/// Longest report body kept on disk; a stack trace beyond this is truncated.
const MAX_BODY: usize = 16 * 1024;

#[derive(Clone)]
struct Config {
    directory: PathBuf,
    version: String,
}

static CONFIG: OnceLock<RwLock<Option<Config>>> = OnceLock::new();
static ENABLED: AtomicBool = AtomicBool::new(false);

fn config() -> Option<Config> {
    CONFIG
        .get()
        .and_then(|slot| slot.read().ok())
        .and_then(|guard| guard.clone())
}

/// One stored crash report.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    pub id: String,
    /// ISO-8601 UTC timestamp.
    pub at: String,
    /// `panic` or `javascript`.
    pub kind: String,
    pub message: String,
    pub version: String,
    pub os: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub stack: String,
}

/// Enables collection (if requested) and installs the panic hook.
pub fn install(directory: &Path, enabled: bool, version: &str) {
    let slot = CONFIG.get_or_init(|| RwLock::new(None));
    if let Ok(mut guard) = slot.write() {
        *guard = Some(Config {
            directory: directory.join("crashes"),
            version: version.to_owned(),
        });
    }
    ENABLED.store(enabled, Ordering::Relaxed);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = if let Some(payload) = info.payload().downcast_ref::<&str>() {
            (*payload).to_owned()
        } else if let Some(payload) = info.payload().downcast_ref::<String>() {
            payload.clone()
        } else {
            "unknown panic payload".to_owned()
        };
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_default();
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        record("panic", &message, &location, &backtrace);
        previous(info);
    }));
}

/// Turns collection on or off at runtime.
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// Whether the user allowed crash reports.
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Writes a report when collection is enabled; returns its id.
pub fn record(kind: &str, message: &str, location: &str, stack: &str) -> Option<String> {
    if !ENABLED.load(Ordering::Relaxed) {
        return None;
    }
    let config = config()?;
    std::fs::create_dir_all(&config.directory).ok()?;
    let at = timestamp();
    let id = format!(
        "{}-{}",
        at.replace([':', '.', 'T', 'Z'], ""),
        std::process::id()
    );
    let report = CrashReport {
        id: id.clone(),
        at,
        kind: kind.to_owned(),
        message: sanitize(message, 4000),
        version: config.version.clone(),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        location: sanitize(location, 500),
        stack: sanitize(stack, MAX_BODY),
    };
    let text = serde_json::to_string_pretty(&report).ok()?;
    std::fs::write(config.directory.join(format!("{id}.json")), text).ok()?;
    Some(id)
}

/// Newest first.
pub fn list() -> Vec<CrashReport> {
    let Some(config) = config() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&config.directory) else {
        return Vec::new();
    };
    let mut reports: Vec<CrashReport> = entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .filter_map(|text| serde_json::from_str(&text).ok())
        .collect();
    reports.sort_by(|a, b| b.at.cmp(&a.at));
    reports
}

/// Text of one report, as shown to the user before copying.
pub fn read(id: &str) -> Result<String, String> {
    let config = config().ok_or("crash reporting is not initialised")?;
    if !valid_id(id) {
        return Err("invalid report id".to_owned());
    }
    let path = config.directory.join(format!("{id}.json"));
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("cannot read the report: {error}"))?;
    let report: CrashReport =
        serde_json::from_str(&text).map_err(|error| format!("broken report: {error}"))?;
    Ok(render(&report))
}

/// Deletes one report; a missing file is not an error.
pub fn delete(id: &str) -> Result<(), String> {
    let config = config().ok_or("crash reporting is not initialised")?;
    if !valid_id(id) {
        return Err("invalid report id".to_owned());
    }
    let path = config.directory.join(format!("{id}.json"));
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("cannot delete the report: {error}")),
    }
}

/// Human-readable text used for the clipboard and for GitHub issues.
pub fn render(report: &CrashReport) -> String {
    let mut text = format!(
        "Mappa {version} crash report\n\
         time: {at}\n\
         kind: {kind}\n\
         os: {os}\n\
         location: {location}\n\
         message: {message}\n",
        version = report.version,
        at = report.at,
        kind = report.kind,
        os = report.os,
        location = if report.location.is_empty() {
            "-"
        } else {
            &report.location
        },
        message = report.message,
    );
    if !report.stack.is_empty() {
        text.push_str("\nstack:\n");
        text.push_str(&report.stack);
    }
    text
}

/// Replaces the home directory and user name so a report carries no PII.
fn sanitize(text: &str, limit: usize) -> String {
    let mut result = match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => text.replace(&home, "~"),
        _ => text.to_owned(),
    };
    if let Ok(user) = std::env::var("USER")
        && user.len() > 2
    {
        result = result.replace(&format!("/home/{user}"), "~");
    }
    if result.len() > limit {
        result.truncate(limit);
        result.push_str("\n…truncated");
    }
    result
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_digit() || c == '-')
}

fn timestamp() -> String {
    // Seconds since the epoch formatted as UTC without pulling a date crate.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = now / 86_400;
    let seconds = now % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    )
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[tauri::command]
pub async fn crash_list() -> Vec<CrashReport> {
    list()
}

#[tauri::command]
pub async fn crash_read(id: String) -> Result<String, String> {
    read(&id)
}

#[tauri::command]
pub async fn crash_delete(id: String) -> Result<(), String> {
    delete(&id)
}

#[tauri::command]
pub async fn crash_report_js(message: String, stack: String) -> Result<(), String> {
    record("javascript", &message, "webview", &stack);
    Ok(())
}

#[tauri::command]
pub async fn crash_enabled() -> bool {
    enabled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mappa-crash-{name}-{}", std::process::id()))
    }

    #[test]
    fn sanitize_hides_the_home_directory() {
        let _guard = TEST_LOCK.lock().unwrap();
        let home = std::env::var("HOME").unwrap_or_default();
        let text = sanitize(&format!("failed to open {home}/maps/a.mbtiles"), 1000);
        assert!(!text.contains(&home), "home directory leaked: {text}");
        assert!(text.contains("~/maps/a.mbtiles"));
    }

    #[test]
    fn sanitize_truncates_long_text() {
        let _guard = TEST_LOCK.lock().unwrap();
        let text = sanitize(&"x".repeat(100), 10);
        assert!(text.len() < 40);
        assert!(text.ends_with("truncated"));
    }

    #[test]
    fn records_lists_and_deletes() {
        let _guard = TEST_LOCK.lock().unwrap();
        let dir = directory("roundtrip");
        install(&dir, true, "1.0.1");
        let id = record("panic", "boom", "src/main.rs:1", "stack").expect("report written");
        let reports = list();
        assert!(reports.iter().any(|report| report.id == id));
        let text = read(&id).unwrap();
        assert!(text.contains("boom"));
        delete(&id).unwrap();
        assert!(!list().iter().any(|report| report.id == id));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ignores_records_when_disabled() {
        let _guard = TEST_LOCK.lock().unwrap();
        let dir = directory("disabled");
        install(&dir, false, "1.0.1");
        set_enabled(false);
        assert!(record("panic", "boom", "", "").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_path_traversal_ids() {
        let _guard = TEST_LOCK.lock().unwrap();
        assert!(!valid_id("../etc/passwd"));
        assert!(!valid_id(""));
        assert!(valid_id("20261025-1234"));
    }

    #[test]
    fn formats_known_dates() {
        let _guard = TEST_LOCK.lock().unwrap();
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_000), (2024, 10, 4));
    }
}
