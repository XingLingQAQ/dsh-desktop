//! Built-in plugin store: a local catalog under `<project>/store/`.
//!
//! Each subdirectory is a plugin package that can be installed into the
//! desktop plugins directory (default `<project>/plugins/`).

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct StorePluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub installed: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct InstalledPluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub has_client: bool,
    pub has_server: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Root holding the desktop's plugin directories.
///
/// Dev builds use the repo root so `npm run tauri dev` finds the checked-in
/// `plugins/` and `store/` no matter the cwd. `CARGO_MANIFEST_DIR` resolves at
/// compile time, though — in a packaged build it names the *build machine's*
/// path, which does not exist on the user's disk. So the two builds get
/// separate `cfg` bodies rather than a runtime branch: that keeps the build
/// path out of the shipped binary entirely.
#[cfg(debug_assertions)]
fn data_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}

/// Release: user-writable data, alongside `settings.json`.
#[cfg(not(debug_assertions))]
fn data_root() -> PathBuf {
    std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("dsh-desktop")
}

pub fn store_root() -> PathBuf {
    data_root().join("store")
}

pub fn plugins_root() -> PathBuf {
    std::env::var("DSH_DESKTOP_PLUGINS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_root().join("plugins"))
}

fn read_pkg_meta(dir: &Path, id: &str) -> (String, String, String) {
    let pkg_path = dir.join("package.json");
    if let Ok(text) = fs::read_to_string(&pkg_path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            let name = value
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(id)
                .to_string();
            let version = value
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or("0.0.0")
                .to_string();
            let description = value
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            return (name, version, description);
        }
    }
    (id.to_string(), "0.0.0".to_string(), String::new())
}

/// List all plugin packages available in the store.
pub fn list_store() -> Vec<StorePluginInfo> {
    let root = store_root();
    let plugins = plugins_root();
    let mut out = Vec::new();
    if let Ok(read_dir) = fs::read_dir(&root) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            let (name, version, description) = read_pkg_meta(&path, &id);
            let installed = plugins.join(&id).is_dir();
            out.push(StorePluginInfo {
                id,
                name,
                version,
                description,
                installed,
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Install a plugin from the store into the desktop plugins directory.
pub fn install_store_plugin(id: &str) -> Result<(), String> {
    let src = store_root().join(id);
    if !src.is_dir() {
        return Err(format!("store plugin not found: {id}"));
    }
    let dst = plugins_root().join(id);
    if dst.exists() {
        return Err(format!("plugin already installed: {id}"));
    }
    copy_dir(&src, &dst).map_err(|e| e.to_string())
}

/// List installed plugins in the desktop plugins directory.
pub fn list_installed() -> Vec<InstalledPluginInfo> {
    let root = plugins_root();
    let mut out = Vec::new();
    if let Ok(read_dir) = fs::read_dir(&root) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('@') {
                if let Ok(scoped) = fs::read_dir(&path) {
                    for sub in scoped.flatten() {
                        let sub_path = sub.path();
                        if sub_path.is_dir() {
                            let sub_name = sub.file_name().to_string_lossy().into_owned();
                            let id = format!("{name}/{sub_name}");
                            out.push(read_installed(&sub_path, &id));
                        }
                    }
                }
            } else {
                out.push(read_installed(&path, &name));
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn read_installed(dir: &Path, id: &str) -> InstalledPluginInfo {
    let (name, version, description) = read_pkg_meta(dir, id);
    InstalledPluginInfo {
        id: id.to_string(),
        name,
        version,
        description,
        has_client: dir.join("client.js").is_file(),
        has_server: ["server.js", "index.mjs", "index.js"]
            .iter()
            .any(|f| dir.join(f).is_file()),
    }
}

/// Uninstall a plugin from the desktop plugins directory.
pub fn uninstall_plugin(id: &str) -> Result<(), String> {
    let root = plugins_root();
    let target = root.join(id);
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    let canonical_target = target.canonicalize().map_err(|_| format!("plugin not found: {id}"))?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err("invalid plugin path".into());
    }
    fs::remove_dir_all(&canonical_target).map_err(|e| e.to_string())
}

/// List a directory for the custom workspace-folder picker.
pub fn list_directory(path: &str) -> Result<Vec<DirEntry>, String> {
    let dir = PathBuf::from(path);
    let read_dir = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        out.push(DirEntry {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir: path.is_dir(),
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}
