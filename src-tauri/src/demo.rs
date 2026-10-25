//! The synthetic demo pack shipped inside the binary.
//!
//! Keeping the archive in the binary (instead of a bundle resource) makes the
//! first run identical in `tauri dev` and in the installed `.deb`: the command
//! materialises the file in the app data directory and returns its path.

use std::path::{Path, PathBuf};

const DEMO_PACK: &[u8] = include_bytes!("../../assets/demo/demo.mbtiles");
const DEMO_NAME: &str = "demo.mbtiles";

/// Writes the bundled demo pack to the app data directory and returns the path.
#[tauri::command]
pub async fn demo_pack(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("cannot resolve the app data directory: {error}"))?;
    let path = materialise(&directory)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Puts the embedded archive into `directory`, rewriting a stale copy.
fn materialise(directory: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
    let path = directory.join(DEMO_NAME);
    // A stale copy after a version upgrade would be confusing, so rewrite it
    // whenever the size differs from the embedded archive.
    let current = std::fs::metadata(&path).ok().map(|meta| meta.len());
    if current != Some(DEMO_PACK.len() as u64) {
        write_pack(&path, DEMO_PACK)?;
    }
    Ok(path)
}

fn write_pack(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("mbtiles.part");
    std::fs::write(&temporary, bytes)
        .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
    std::fs::rename(&temporary, path)
        .map_err(|error| format!("cannot move {} into place: {error}", temporary.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory(suffix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mappa-demo-{suffix}-{}", std::process::id()))
    }

    #[test]
    fn embedded_pack_is_a_sqlite_database_with_tiles() {
        assert_eq!(&DEMO_PACK[..16], b"SQLite format 3\0");
        assert!(DEMO_PACK.len() > 512 * 1024, "demo pack looks truncated");
    }

    #[test]
    fn embedded_pack_reads_as_mbtiles() {
        let directory = temporary_directory("open");
        let path = materialise(&directory).unwrap();
        let pack = mappa_storage::Mbtiles::open(&path).unwrap();
        assert_eq!(pack.metadata().format, "png");
        assert_eq!(pack.min_zoom().unwrap(), Some(10));
        assert_eq!(pack.max_zoom().unwrap(), Some(13));
        assert!(pack.tile_count().unwrap() > 100);
        let tile = pack
            .get_tile(10, 608, 369)
            .unwrap()
            .expect("tile 10/608/369");
        assert_eq!(&tile[..8], b"\x89PNG\r\n\x1a\n");
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn materialise_is_idempotent_and_repairs_a_stale_file() {
        let directory = temporary_directory("materialise");
        let path = materialise(&directory).unwrap();
        let written = std::fs::metadata(&path).unwrap().len();
        assert_eq!(written, DEMO_PACK.len() as u64);

        std::fs::write(&path, b"stale").unwrap();
        materialise(&directory).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            DEMO_PACK.len() as u64
        );
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn writes_and_rewrites_the_pack() {
        let directory = temporary_directory("write");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(DEMO_NAME);
        write_pack(&path, b"first").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"first");
        write_pack(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        std::fs::remove_dir_all(&directory).ok();
    }
}
