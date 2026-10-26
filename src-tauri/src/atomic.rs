//! Atomic document writes shared by settings, sources and the file bridge.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_TEMP_ATTEMPTS: u32 = 16;

/// Replaces `path` with `data` through a unique sibling temp file.
///
/// `private` creates the file with owner-only permissions on Unix. A crash
/// leaves either the old contents or the new ones, never a truncated file.
pub fn write(path: &Path, data: &[u8], private: bool) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "path has no parent directory")
    })?;
    std::fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("mappa");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);

    let (temporary, mut file) = create_temp(parent, name, stamp, private)?;
    let written = file.write_all(data).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    // Best-effort directory fsync: some filesystems reject it, and the data
    // itself is already durable.
    if let Ok(directory) = std::fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn create_temp(
    parent: &Path,
    name: &str,
    stamp: u128,
    private: bool,
) -> io::Result<(PathBuf, std::fs::File)> {
    #[cfg(not(unix))]
    let _ = private;
    let mut attempt = 0;
    loop {
        let temporary = parent.join(format!(
            ".{name}.{}.{stamp}.{attempt}.tmp",
            std::process::id()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            if private {
                options.mode(0o600);
            }
        }
        match options.open(&temporary) {
            Ok(file) => return Ok((temporary, file)),
            Err(error)
                if error.kind() == io::ErrorKind::AlreadyExists
                    && attempt + 1 < MAX_TEMP_ATTEMPTS =>
            {
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mappa-{name}-{}", std::process::id()))
    }

    fn leftovers(directory: &Path) -> usize {
        std::fs::read_dir(directory)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                    .count()
            })
            .unwrap_or(0)
    }

    #[test]
    fn replaces_contents_without_temp_files() {
        let directory = directory("atomic-write");
        let path = directory.join("state.json");
        write(&path, b"first", false).unwrap();
        write(&path, b"second", false).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        assert_eq!(leftovers(&directory), 0);
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn creates_missing_parent_directories() {
        let directory = directory("atomic-parent");
        let path = directory.join("nested").join("state.json");
        write(&path, b"value", false).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"value");
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn concurrent_writes_leave_one_complete_file() {
        let directory = directory("atomic-race");
        let path = directory.join("state.json");
        let handles = (0..8)
            .map(|index| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let value = format!("value-{index}-{}", "x".repeat(4096));
                    write(&path, value.as_bytes(), false).unwrap();
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("value-"));
        assert_eq!(text.len(), "value-0-".len() + 4096);
        assert_eq!(leftovers(&directory), 0);
        std::fs::remove_dir_all(&directory).ok();
    }

    #[cfg(unix)]
    #[test]
    fn private_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = directory("atomic-private");
        let path = directory.join("secrets.json");
        write(&path, b"{}", true).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_dir_all(&directory).ok();
    }
}
