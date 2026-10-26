//! GPS tracks uploaded by the mobile companion.

use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: u64,
}

fn list_in(dir: &Path) -> Result<Vec<TrackFile>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("cannot read {}: {error}", dir.display())),
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("gpx") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        files.push(TrackFile {
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("track.gpx")
                .to_owned(),
            path: path.display().to_string(),
            size: metadata.len(),
            modified,
        });
    }
    files.sort_by_key(|file| std::cmp::Reverse(file.modified));
    files.truncate(200);
    Ok(files)
}

/// Lists GPX tracks in the app cache `tracks/` directory.
#[tauri::command]
pub fn list_tracks(app: tauri::AppHandle) -> Result<Vec<TrackFile>, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("cannot resolve the cache directory: {error}"))?
        .join("tracks");
    list_in(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_gpx_newest_first() {
        let dir = std::env::temp_dir().join(format!(
            "mappa-tracks-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("old.gpx"), b"<gpx/>").unwrap();
        std::fs::write(dir.join("note.txt"), b"x").unwrap();
        std::fs::write(dir.join("new.gpx"), b"<gpx/>").unwrap();
        let files = list_in(&dir).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|file| file.name.ends_with(".gpx")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_directory_is_empty() {
        let dir = std::env::temp_dir().join("mappa-tracks-missing");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(list_in(&dir).unwrap().is_empty());
    }
}
