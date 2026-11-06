//! Creates BitTorrent v1 metainfo for a finished pack.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use ring::digest;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentInfo {
    pub name: String,
    pub bytes: u64,
    pub piece_length: u32,
    pub info_hash: String,
    pub magnet: String,
    pub torrent: String,
}

fn be_bytes(out: &mut Vec<u8>, value: &[u8]) {
    out.extend(value.len().to_string().as_bytes());
    out.push(b':');
    out.extend(value);
}

fn be_int(out: &mut Vec<u8>, value: u64) {
    out.push(b'i');
    out.extend(value.to_string().as_bytes());
    out.push(b'e');
}

fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn piece_length(size: u64) -> u32 {
    if size <= 16 * 1024 * 1024 {
        256 * 1024
    } else {
        1024 * 1024
    }
}

fn create(source: &Path, destination: &Path) -> Result<TorrentInfo, String> {
    if !source.is_file() {
        return Err(format!("not a file: {}", source.display()));
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "mbtiles" && extension != "pmtiles" {
        return Err("only .mbtiles and .pmtiles can be shared".to_owned());
    }
    if destination
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| !value.eq_ignore_ascii_case("torrent"))
        .unwrap_or(true)
    {
        return Err("destination must end in .torrent".to_owned());
    }
    let metadata =
        fs::metadata(source).map_err(|error| format!("cannot stat the pack: {error}"))?;
    let bytes = metadata.len();
    if bytes == 0 {
        return Err("the pack is empty".to_owned());
    }
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "the pack has no valid name".to_owned())?
        .to_owned();
    let piece = piece_length(bytes);
    let mut file = File::open(source).map_err(|error| format!("cannot open the pack: {error}"))?;
    let mut pieces = Vec::new();
    let mut buffer = vec![0_u8; piece as usize];
    loop {
        let mut filled = 0;
        while filled < buffer.len() {
            let read = file
                .read(&mut buffer[filled..])
                .map_err(|error| format!("cannot read the pack: {error}"))?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        if filled == 0 {
            break;
        }
        let mut context = digest::Context::new(&digest::SHA1_FOR_LEGACY_USE_ONLY);
        context.update(&buffer[..filled]);
        pieces.extend_from_slice(context.finish().as_ref());
        if filled < buffer.len() {
            break;
        }
    }

    let mut info = Vec::new();
    info.push(b'd');
    be_bytes(&mut info, b"length");
    be_int(&mut info, bytes);
    be_bytes(&mut info, b"name");
    be_bytes(&mut info, name.as_bytes());
    be_bytes(&mut info, b"piece length");
    be_int(&mut info, u64::from(piece));
    be_bytes(&mut info, b"pieces");
    be_bytes(&mut info, &pieces);
    info.push(b'e');

    let mut context = digest::Context::new(&digest::SHA1_FOR_LEGACY_USE_ONLY);
    context.update(&info);
    let hash = context.finish();
    let info_hash = hash
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    let mut torrent = Vec::new();
    torrent.push(b'd');
    be_bytes(&mut torrent, b"created by");
    be_bytes(&mut torrent, b"Mappa");
    be_bytes(&mut torrent, b"info");
    torrent.extend_from_slice(&info);
    torrent.push(b'e');

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    let mut output = File::create(destination)
        .map_err(|error| format!("cannot create {}: {error}", destination.display()))?;
    output
        .write_all(&torrent)
        .map_err(|error| format!("cannot write {}: {error}", destination.display()))?;

    let magnet = format!(
        "magnet:?xt=urn:btih:{info_hash}&dn={}&xl={bytes}",
        percent_encode(&name)
    );
    Ok(TorrentInfo {
        name,
        bytes,
        piece_length: piece,
        info_hash,
        magnet,
        torrent: destination.display().to_string(),
    })
}

#[tauri::command]
pub async fn create_pack_torrent(
    source: String,
    destination: String,
) -> Result<TorrentInfo, String> {
    let source = PathBuf::from(source);
    let destination = PathBuf::from(destination);
    tauri::async_runtime::spawn_blocking(move || create(&source, &destination))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.len() > 8192 {
        return Err("invalid URL".to_owned());
    }
    #[cfg(windows)]
    let status = Command::new("cmd").args(["/C", "start", "", &url]).status();
    #[cfg(not(windows))]
    let status = Command::new("xdg-open").arg(&url).status();
    status
        .map_err(|error| format!("cannot open the browser: {error}"))?
        .success()
        .then_some(())
        .ok_or_else(|| "the browser rejected the URL".to_owned())
}

#[tauri::command]
pub fn open_magnet(magnet: String) -> Result<(), String> {
    if !magnet.starts_with("magnet:?") || magnet.len() > 4096 {
        return Err("invalid magnet link".to_owned());
    }
    #[cfg(windows)]
    let status = Command::new("cmd")
        .args(["/C", "start", "", &magnet])
        .status();
    #[cfg(not(windows))]
    let status = Command::new("xdg-open").arg(&magnet).status();
    status
        .map_err(|error| format!("cannot open a torrent client: {error}"))?
        .success()
        .then_some(())
        .ok_or_else(|| "the torrent client rejected the link".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mappa-torrent-{name}-{}", std::process::id()))
    }

    #[test]
    fn creates_v1_metainfo_and_magnet() {
        let root = temp("create");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let pack = root.join("region.mbtiles");
        fs::write(&pack, b"0123456789").unwrap();
        let target = root.join("region.torrent");
        let info = create(&pack, &target).unwrap();
        assert_eq!(info.info_hash.len(), 40);
        assert_eq!(info.bytes, 10);
        assert!(info.magnet.starts_with("magnet:?xt=urn:btih:"));
        assert!(info.magnet.contains("dn=region.mbtiles"));
        let data = fs::read(&target).unwrap();
        assert_eq!(data.first(), Some(&b'd'));
        assert!(data.windows(6).any(|window| window == b"4:info"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_non_pack_files() {
        let root = temp("reject");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let file = root.join("notes.txt");
        fs::write(&file, b"x").unwrap();
        assert!(create(&file, &root.join("notes.torrent")).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
