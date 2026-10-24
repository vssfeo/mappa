//! Sidecar manifests for exported MBTiles/PMTiles packs.
//!
//! A manifest records the SHA-256 of the pack and an Ed25519 signature made by
//! the local Mappa key. The key is generated on first use and kept next to the
//! app data, so a pack can be traced back to the machine that produced it.

use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use ring::rand::SystemRandom;
use ring::signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{StorageError, StorageResult};

/// Manifest stored as `<pack>.<ext>.manifest.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackManifest {
    /// Format marker.
    pub format: String,
    /// Format version.
    pub version: u32,
    /// File name the manifest belongs to.
    pub file: String,
    /// Pack size in bytes.
    pub bytes: u64,
    /// Lowercase SHA-256 of the pack.
    pub sha256: String,
    /// Creation time, Unix seconds.
    pub created: u64,
    /// License declared by the exporter, when known.
    pub license: Option<String>,
    /// Signature algorithm.
    pub algorithm: String,
    /// Hex-encoded Ed25519 public key.
    pub public_key: String,
    /// Hex-encoded signature over the canonical payload.
    pub signature: String,
}

/// Returns the sidecar path for a pack file.
pub fn manifest_path(pack: &Path) -> PathBuf {
    let name = pack
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("pack");
    pack.with_file_name(format!("{name}.manifest.json"))
}

/// Computes the SHA-256 of a file in bounded chunks.
pub fn sha256_file(path: &Path) -> StorageResult<String> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 256 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(to_hex(&digest.finalize()))
}

fn payload(sha256: &str, bytes: u64, created: u64, license: Option<&str>) -> String {
    format!(
        "mappa-pack-v1\n{sha256}\n{bytes}\n{created}\n{}",
        license.unwrap_or("")
    )
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(DIGITS[usize::from(byte >> 4)] as char);
        text.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    text
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let mut bytes = Vec::with_capacity(text.len() / 2);
    let mut index = 0;
    while index < text.len() {
        bytes.push(u8::from_str_radix(&text[index..index + 2], 16).ok()?);
        index += 2;
    }
    Some(bytes)
}

/// Loads the persistent signing seed, creating it on first use.
fn load_or_create_key(path: &Path) -> StorageResult<Vec<u8>> {
    if let Ok(text) = std::fs::read_to_string(path) {
        let seed = from_hex(&text)
            .ok_or_else(|| StorageError::InvalidJob("corrupt pack signing key".to_owned()))?;
        if seed.len() == 32 {
            return Ok(seed);
        }
        return Err(StorageError::InvalidJob(
            "pack signing key must be 32 bytes".to_owned(),
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let random = SystemRandom::new();
    let mut bytes = [0_u8; 32];
    ring::rand::SecureRandom::fill(&random, &mut bytes)
        .map_err(|_| StorageError::InvalidJob("cannot generate signing key".to_owned()))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(to_hex(&bytes).as_bytes())?;
    file.write_all(b"\n")?;
    Ok(bytes.to_vec())
}

/// Writes a signed manifest next to the pack and returns it.
pub fn write_manifest(
    pack: &Path,
    license: Option<&str>,
    key_path: &Path,
) -> StorageResult<PackManifest> {
    let bytes = std::fs::metadata(pack)?.len();
    let sha256 = sha256_file(pack)?;
    let created = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let license = license
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(200).collect::<String>());
    let payload = payload(&sha256, bytes, created, license.as_deref());
    let seed = load_or_create_key(key_path)?;
    let pair = Ed25519KeyPair::from_seed_unchecked(&seed)
        .map_err(|_| StorageError::InvalidJob("invalid signing key".to_owned()))?;
    let signature = to_hex(pair.sign(payload.as_bytes()).as_ref());
    let manifest = PackManifest {
        format: "mappa-pack-manifest".to_owned(),
        version: 1,
        file: pack
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_owned(),
        bytes,
        sha256,
        created,
        license,
        algorithm: "Ed25519".to_owned(),
        public_key: to_hex(pair.public_key().as_ref()),
        signature,
    };
    let encoded = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| StorageError::InvalidJob(format!("cannot encode manifest: {error}")))?;
    let destination = manifest_path(pack);
    let temporary = destination.with_extension("json.tmp");
    std::fs::write(&temporary, encoded)?;
    std::fs::rename(&temporary, &destination)?;
    Ok(manifest)
}

/// Verifies the SHA-256 and signature of an existing pack manifest.
pub fn verify_manifest(pack: &Path) -> StorageResult<PackManifest> {
    let data = std::fs::read(manifest_path(pack))?;
    let manifest: PackManifest = serde_json::from_slice(&data)
        .map_err(|error| StorageError::InvalidJob(format!("corrupt manifest: {error}")))?;
    if manifest.format != "mappa-pack-manifest" || manifest.version != 1 {
        return Err(StorageError::InvalidJob(
            "unsupported manifest format".to_owned(),
        ));
    }
    let bytes = std::fs::metadata(pack)?.len();
    if bytes != manifest.bytes {
        return Err(StorageError::InvalidJob(format!(
            "pack size changed: {} != {}",
            bytes, manifest.bytes
        )));
    }
    let sha256 = sha256_file(pack)?;
    if sha256 != manifest.sha256 {
        return Err(StorageError::InvalidJob("pack SHA-256 mismatch".to_owned()));
    }
    let public_key = from_hex(&manifest.public_key)
        .ok_or_else(|| StorageError::InvalidJob("invalid public key".to_owned()))?;
    let signature = from_hex(&manifest.signature)
        .ok_or_else(|| StorageError::InvalidJob("invalid signature".to_owned()))?;
    let payload = payload(
        &manifest.sha256,
        manifest.bytes,
        manifest.created,
        manifest.license.as_deref(),
    );
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(payload.as_bytes(), &signature)
        .map_err(|_| StorageError::InvalidJob("pack signature mismatch".to_owned()))?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signs_and_verifies_a_pack() {
        let dir = tempfile::tempdir().unwrap();
        let pack = dir.path().join("crimea.mbtiles");
        std::fs::write(&pack, b"not really sqlite but deterministic").unwrap();
        let key = dir.path().join("signing.key");
        let manifest = write_manifest(&pack, Some("ODbL-1.0"), &key).unwrap();
        assert_eq!(manifest.sha256.len(), 64);
        assert_eq!(manifest.license.as_deref(), Some("ODbL-1.0"));
        let verified = verify_manifest(&pack).unwrap();
        assert_eq!(verified.signature, manifest.signature);
        assert_eq!(
            std::fs::read_to_string(manifest_path(&pack))
                .unwrap()
                .matches("sha256")
                .count(),
            1
        );
    }

    #[test]
    fn detects_tampering() {
        let dir = tempfile::tempdir().unwrap();
        let pack = dir.path().join("pack.pmtiles");
        std::fs::write(&pack, b"first").unwrap();
        write_manifest(&pack, None, &dir.path().join("key")).unwrap();
        std::fs::write(&pack, b"second").unwrap();
        assert!(verify_manifest(&pack).is_err());
    }
}
