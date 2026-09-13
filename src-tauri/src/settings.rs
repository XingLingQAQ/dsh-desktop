//! Desktop shell settings (close-to-tray, auto-start) and persistence.
//!
//! Settings are stored as JSON under `%APPDATA%\dsh-desktop\settings.json`.
//! Auto-start is implemented through the Windows HKCU Run registry key.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    /// Close button hides to tray instead of quitting.
    pub close_to_tray: bool,
    /// Launch DSH Desktop at Windows sign-in.
    pub auto_start: bool,
    /// Last selected workspace folder (custom picker).
    pub workspace_folder: Option<String>,
    /// npm dist-tag the harness update check follows (`latest` / `next`).
    pub harness_channel: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_to_tray: false,
            auto_start: false,
            workspace_folder: None,
            harness_channel: None,
        }
    }
}

fn settings_dir() -> PathBuf {
    std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("dsh-desktop")
}

pub fn settings_path() -> PathBuf {
    settings_dir().join("settings.json")
}

pub fn load() -> AppSettings {
    let path = settings_path();
    fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(settings: &AppSettings) -> std::io::Result<()> {
    let dir = settings_dir();
    fs::create_dir_all(&dir)?;
    let text = serde_json::to_string_pretty(settings).map_err(std::io::Error::other)?;
    fs::write(settings_path(), text)
}

/// Set the Windows auto-start registry entry.
pub fn set_auto_start(enabled: bool) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let exe = std::env::current_exe()?;
        let exe = exe.to_string_lossy();
        if enabled {
            let status = std::process::Command::new("reg")
                .args([
                    "add",
                    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                    "/v",
                    "DSHDesktop",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &format!("\"{exe}\""),
                    "/f",
                ])
                .status()?;
            if !status.success() {
                return Err(std::io::Error::other("reg add failed"));
            }
        } else {
            let status = std::process::Command::new("reg")
                .args([
                    "delete",
                    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                    "/v",
                    "DSHDesktop",
                    "/f",
                ])
                .status()?;
            if !status.success() {
                return Err(std::io::Error::other("reg delete failed"));
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Ok(())
    }
}

/// Query whether auto-start is currently enabled in the registry.
pub fn auto_start_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("reg")
            .args([
                "query",
                "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                "/v",
                "DSHDesktop",
            ])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}
