//! File-backed project sync for the local server.
//!
//! Each project is a JSON envelope on disk. Conflicts are resolved by the
//! project's `savedAt` timestamp: the newer snapshot wins unless the caller
//! explicitly forces a write.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A project snapshot as stored on the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEnvelope {
    pub name: String,
    pub saved_at: String,
    pub updated_at: i64,
    pub version: u64,
    pub project: Value,
}

/// Result of a write attempt.
#[derive(Debug)]
pub enum SaveOutcome {
    Saved(SyncEnvelope),
    /// The stored snapshot is newer or equal; nothing was written.
    Conflict(SyncEnvelope),
}

/// Project names are file names: ASCII letters, digits, dot, dash, underscore.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
}

fn path_for(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.json"))
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// Reads a stored project, or `None` when it does not exist.
pub fn load(dir: &Path, name: &str) -> io::Result<Option<SyncEnvelope>> {
    if !valid_name(name) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid name"));
    }
    let path = path_for(dir, name);
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Stores a project snapshot, applying last-write-wins by `savedAt`.
pub fn save(dir: &Path, name: &str, project: Value, force: bool) -> io::Result<SaveOutcome> {
    if !valid_name(name) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid name"));
    }
    let saved_at = project
        .get("savedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "project has no savedAt"))?
        .to_owned();
    let current = load(dir, name)?;
    if !force
        && let Some(current) = &current
        && saved_at <= current.saved_at
    {
        return Ok(SaveOutcome::Conflict(current.clone()));
    }
    let version = current.map(|it| it.version).unwrap_or(0) + 1;
    let envelope = SyncEnvelope {
        name: name.to_owned(),
        saved_at,
        updated_at: now_secs(),
        version,
        project,
    };
    fs::create_dir_all(dir)?;
    let path = path_for(dir, name);
    let temporary = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let text = serde_json::to_string(&envelope)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    fs::write(&temporary, text)?;
    fs::rename(&temporary, &path)?;
    Ok(SaveOutcome::Saved(envelope))
}

/// Lists stored snapshots, newest first.
pub fn list(dir: &Path) -> io::Result<Vec<SyncEnvelope>> {
    let mut items = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(items),
        Err(error) => return Err(error),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(envelope) = serde_json::from_str::<SyncEnvelope>(&text) {
            items.push(envelope);
        }
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "mappa-sync-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn project(saved_at: &str) -> Value {
        serde_json::json!({"format":"mappa-project","savedAt":saved_at,"name":"test"})
    }

    #[test]
    fn saves_and_loads_a_project() {
        let dir = temp_dir("save");
        let outcome = save(&dir, "team", project("2026-10-26T10:00:00.000Z"), false).unwrap();
        let SaveOutcome::Saved(saved) = outcome else {
            panic!("expected save");
        };
        assert_eq!(saved.version, 1);
        let loaded = load(&dir, "team").unwrap().unwrap();
        assert_eq!(loaded.saved_at, "2026-10-26T10:00:00.000Z");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_an_older_snapshot() {
        let dir = temp_dir("conflict");
        save(&dir, "team", project("2026-10-26T12:00:00.000Z"), false).unwrap();
        let outcome = save(&dir, "team", project("2026-10-26T11:00:00.000Z"), false).unwrap();
        let SaveOutcome::Conflict(current) = outcome else {
            panic!("expected conflict");
        };
        assert_eq!(current.saved_at, "2026-10-26T12:00:00.000Z");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn force_overwrites_an_older_snapshot() {
        let dir = temp_dir("force");
        save(&dir, "team", project("2026-10-26T12:00:00.000Z"), false).unwrap();
        let outcome = save(&dir, "team", project("2026-10-26T11:00:00.000Z"), true).unwrap();
        let SaveOutcome::Saved(saved) = outcome else {
            panic!("expected save");
        };
        assert_eq!(saved.version, 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_names_that_escape_the_directory() {
        assert!(!valid_name("../etc/passwd"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name(""));
        assert!(valid_name("team-1"));
        let dir = temp_dir("names");
        assert!(save(&dir, "../x", project("2026-10-26T10:00:00.000Z"), false).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lists_projects_newest_first() {
        let dir = temp_dir("list");
        save(&dir, "a", project("2026-10-26T10:00:00.000Z"), false).unwrap();
        save(&dir, "b", project("2026-10-26T11:00:00.000Z"), false).unwrap();
        let items = list(&dir).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "b");
        let _ = fs::remove_dir_all(&dir);
    }
}
