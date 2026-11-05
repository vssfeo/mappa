//! Builds a portable folder with the current project, packs and DEM.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldKitRequest {
    pub directory: String,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub packs: Vec<String>,
    #[serde(default)]
    pub dem: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldKitFile {
    pub path: String,
    pub bytes: u64,
    pub blake3: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldKitSummary {
    pub directory: String,
    pub files: Vec<FieldKitFile>,
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_secs())
}

fn unique_dir(parent: &Path) -> Result<PathBuf, String> {
    let base = parent.join("Mappa-field");
    if !base.exists() {
        return Ok(base);
    }
    for index in 2..1000 {
        let candidate = parent.join(format!("Mappa-field-{index}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("cannot find a free field-kit folder name".to_owned())
}

fn file_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("invalid file name: {}", path.display()))
}

fn copy_one(source: &Path, target: &Path, relative: &str) -> Result<FieldKitFile, String> {
    if !source.is_file() {
        return Err(format!("not a file: {}", source.display()));
    }
    let bytes = fs::copy(source, target)
        .map_err(|error| format!("cannot copy {}: {error}", source.display()))?;
    let data =
        fs::read(target).map_err(|error| format!("cannot read {}: {error}", target.display()))?;
    Ok(FieldKitFile {
        path: relative.to_owned(),
        bytes,
        blake3: blake3::hash(&data).to_hex().to_string(),
    })
}

fn build(request: FieldKitRequest) -> Result<FieldKitSummary, String> {
    let parent = PathBuf::from(request.directory.trim());
    if !parent.is_absolute() {
        return Err("field-kit directory must be absolute".to_owned());
    }
    fs::create_dir_all(&parent)
        .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    let directory = unique_dir(&parent)?;
    fs::create_dir_all(directory.join("packs"))
        .map_err(|error| format!("cannot create the field kit: {error}"))?;
    fs::create_dir_all(directory.join("dem"))
        .map_err(|error| format!("cannot create the field kit: {error}"))?;

    let mut files = Vec::new();
    if let Some(project) = request.project {
        let target = directory.join("project.mappa");
        let mut file = fs::File::create(&target)
            .map_err(|error| format!("cannot write project.mappa: {error}"))?;
        file.write_all(project.as_bytes())
            .map_err(|error| format!("cannot write project.mappa: {error}"))?;
        files.push(FieldKitFile {
            path: "project.mappa".to_owned(),
            bytes: project.len() as u64,
            blake3: blake3::hash(project.as_bytes()).to_hex().to_string(),
        });
    }
    for (index, path) in request.packs.iter().enumerate() {
        let source = Path::new(path);
        let name = file_name(source)?;
        let relative = format!("packs/{index:02}-{name}");
        files.push(copy_one(source, &directory.join(&relative), &relative)?);
    }
    if let Some(path) = request.dem {
        let source = Path::new(&path);
        let name = file_name(source)?;
        let relative = format!("dem/{name}");
        files.push(copy_one(source, &directory.join(&relative), &relative)?);
    }

    let manifest = serde_json::json!({
        "format": "mappa-field-kit",
        "version": 1,
        "createdAt": timestamp(),
        "files": files,
    });
    fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("cannot write manifest.json: {error}"))?;
    fs::write(
        directory.join("README.txt"),
        "Mappa field kit\n\nproject.mappa  open in Mappa\npacks/        offline MBTiles/PMTiles\ndem/          elevation model\nmanifest.json BLAKE3 checksums\n",
    )
    .map_err(|error| format!("cannot write README.txt: {error}"))?;

    Ok(FieldKitSummary {
        directory: directory.display().to_string(),
        files,
    })
}

#[tauri::command]
pub async fn export_field_kit(request: FieldKitRequest) -> Result<FieldKitSummary, String> {
    tauri::async_runtime::spawn_blocking(move || build(request))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mappa-fieldkit-{name}-{}", std::process::id()))
    }

    #[test]
    fn builds_a_folder_with_a_manifest() {
        let root = temp_dir("build");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let pack = root.join("region.mbtiles");
        fs::write(&pack, b"pack-bytes").unwrap();
        let summary = build(FieldKitRequest {
            directory: root.display().to_string(),
            project: Some("{\"format\":\"mappa-project\"}".to_owned()),
            packs: vec![pack.display().to_string()],
            dem: None,
        })
        .unwrap();
        assert!(Path::new(&summary.directory).is_dir());
        assert_eq!(summary.files.len(), 2);
        let manifest =
            fs::read_to_string(Path::new(&summary.directory).join("manifest.json")).unwrap();
        assert!(manifest.contains("mappa-field-kit"));
        assert!(manifest.contains("packs/00-region.mbtiles"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_a_relative_destination() {
        let error = build(FieldKitRequest {
            directory: "relative".to_owned(),
            project: None,
            packs: Vec::new(),
            dem: None,
        })
        .unwrap_err();
        assert!(error.contains("absolute"));
    }
}
