//! Desktop plugin state persistence: the disabled list and per-plugin config
//! values. Stored as JSON under `%APPDATA%\dsh-desktop\plugin-state.json`,
//! alongside `settings.json`.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Persisted desktop plugin state: which plugins are paused and their config
/// values. Both fields are optional on disk (`#[serde(default)]`), so a missing
/// or partial file degrades gracefully to defaults.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct PluginStateData {
    /// Paused plugin ids. Built-in plugins never appear here.
    pub disabled: Vec<String>,
    /// Plugin id -> config values object (free-form JSON from the management UI).
    pub configs: BTreeMap<String, serde_json::Value>,
    /// DSH-profile bundle plugins (`dsh plugin add`) that have been taken over
    /// by the desktop. A migrated id's files live in the desktop plugins
    /// directory and its profile dependency is gone; the flag drives the
    /// 「dsh 迁移」 provenance pill in the management UI.
    pub managed_externals: Vec<String>,
}

impl Default for PluginStateData {
    fn default() -> Self {
        Self {
            disabled: Vec::new(),
            configs: BTreeMap::new(),
            managed_externals: Vec::new(),
        }
    }
}

fn settings_dir() -> PathBuf {
    std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("dsh-desktop")
}

fn plugin_state_path() -> PathBuf {
    settings_dir().join("plugin-state.json")
}

pub fn load() -> PluginStateData {
    let path = plugin_state_path();
    fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(data: &PluginStateData) -> std::io::Result<()> {
    let dir = settings_dir();
    fs::create_dir_all(&dir)?;
    let text = serde_json::to_string_pretty(data).map_err(std::io::Error::other)?;
    fs::write(plugin_state_path(), text)
}
