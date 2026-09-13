//! Desktop plugin directory: what is installed, and where installs land.
//!
//! The catalog of installable plugins is not here — it comes from the registry
//! (see `registry.rs`). This module owns the local side: the plugins root, the
//! installed inventory, uninstall, and the directory listing the workspace
//! picker walks.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct InstalledPluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub has_client: bool,
    pub has_server: bool,
    /// Whether the plugin is currently paused (excluded from the boot graph).
    pub disabled: bool,
    /// True when this plugin was migrated out of the DSH profile (`dsh plugin
    /// add` → desktop takeover). Drives the provenance pill in the manager UI.
    #[serde(rename = "fromProfile")]
    pub from_profile: bool,
    /// Config schema from `package.json`'s `dsh.config` array, passed through
    /// verbatim. Each element is `{field,label,type,hint?,default?,options?}`.
    /// Empty when the plugin declares no config. Serialized as `configSchema` to
    /// match the management UI's expected wire shape.
    #[serde(rename = "configSchema")]
    pub config_schema: Vec<serde_json::Value>,
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

pub fn plugins_root() -> PathBuf {
    std::env::var("DSH_DESKTOP_PLUGINS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_root().join("plugins"))
}

fn read_pkg_meta(dir: &Path, id: &str) -> (String, String, String, Vec<serde_json::Value>) {
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
            // `dsh.config` is an array of field descriptors; pass it through
            // verbatim so the management UI can render the form.
            let config_schema = value
                .get("dsh")
                .and_then(|dsh| dsh.get("config"))
                .and_then(|c| c.as_array())
                .cloned()
                .unwrap_or_default();
            return (name, version, description, config_schema);
        }
    }
    (id.to_string(), "0.0.0".to_string(), String::new(), Vec::new())
}

/// List installed plugins in the desktop plugins directory.
pub fn list_installed(disabled: &HashSet<String>, migrated: &HashSet<String>) -> Vec<InstalledPluginInfo> {
    let root = plugins_root();
    let mut out = Vec::new();
    if let Ok(read_dir) = fs::read_dir(&root) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "node_modules" || name.starts_with('.') {
                continue;
            }
            if name.starts_with('@') {
                if let Ok(scoped) = fs::read_dir(&path) {
                    for sub in scoped.flatten() {
                        let sub_path = sub.path();
                        if sub_path.is_dir() {
                            let sub_name = sub.file_name().to_string_lossy().into_owned();
                            let id = format!("{name}/{sub_name}");
                            out.push(read_installed(&sub_path, &id, disabled, migrated));
                        }
                    }
                }
            } else {
                out.push(read_installed(&path, &name, disabled, migrated));
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn read_installed(
    dir: &Path,
    id: &str,
    disabled: &HashSet<String>,
    migrated: &HashSet<String>,
) -> InstalledPluginInfo {
    let (name, version, description, config_schema) = read_pkg_meta(dir, id);
    InstalledPluginInfo {
        id: id.to_string(),
        name,
        version,
        description,
        has_client: client_js_path(dir).is_some(),
        // Bundle-patched host halves live at `main` / `exports["."]` (often
        // `lib/index.js`), not a conventional root file. Match the overlay
        // scan so the 后端 pill is honest.
        has_server: crate::registry::dir_has_bundle_patch(dir)
            || crate::registry::dir_has_backend_entry(dir),
        disabled: disabled.contains(id),
        from_profile: migrated.contains(id),
        config_schema,
    }
}

/// Resolve a plugin's client bundle path: the conventional `client.js`, or
/// the path named by `exports["./client"]` in `package.json` — which may be a
/// string or `{"default": "./lib/client.js"}`. Mirrors `PluginManager::client_path`.
fn client_js_path(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let conventional = dir.join("client.js");
    if conventional.is_file() {
        return Some(conventional);
    }
    let pkg_path = dir.join("package.json");
    if pkg_path.is_file() {
        if let Ok(text) = std::fs::read_to_string(&pkg_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(client) = value.get("exports").and_then(|e| e.get("./client")) {
                    if let Some(rel) = client
                        .as_str()
                        .or_else(|| client.get("default").and_then(|d| d.as_str()))
                    {
                        let candidate = dir.join(rel);
                        if candidate.is_file() {
                            return Some(candidate);
                        }
                    }
                }
            }
        }
    }
    None
}

/// Read the `dsh.config` schema array for a plugin id, or an empty vec when
/// the plugin has no config or no `package.json`. Used by the bridge's
/// `GET /plugins/config` route to return the schema alongside stored values.
pub fn config_schema_for(id: &str) -> Vec<serde_json::Value> {
    let dir = plugins_root().join(id);
    if !dir.is_dir() {
        return Vec::new();
    }
    let (_name, _version, _description, schema) = read_pkg_meta(&dir, id);
    schema
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
