//! Update checks for the two things this app is made of: the DeepSeek Harness
//! CLI it runs, and the desktop shell itself.
//!
//! They are deliberately different mechanisms, because the two have different
//! owners:
//!
//! * **The harness** is an ordinary npm package. `@deepseek-ai/dsh` is published
//!   to npmmirror with `latest` / `next` dist-tags, which is where provision.rs
//!   already installs it from, so the check is a registry read and the install is
//!   the same npm call with a version pinned. Updates land under this desktop's
//!   own `runtime\dsh` and never in the official launcher's `harness-versions`
//!   tree — that tree is `dsh.exe`'s, and overwriting one of its revisions would
//!   leave its manifest describing a bundle that is no longer there.
//!
//! * **The shell** is a Tauri app, so it follows the Tauri updater contract: a
//!   release manifest (`{version, notes, pub_date, platforms}`) served over
//!   HTTPS, per-platform `url` + minisign `signature`, verified against a public
//!   key compiled into this build. Tauri's own updater does the download,
//!   verification, silent install and relaunch; nothing here reimplements it.

use std::cmp::Ordering;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::provision::install_dsh_version;
use crate::settings::AppSettings;

/// The registry provision.rs installs from; the update check reads the same one
/// so "there is a newer version" and "here it is" can never disagree.
const REGISTRY: &str = "https://registry.npmmirror.com";
const HARNESS_PACKAGE: &str = "@deepseek-ai/dsh";

/// Where shell updates are fetched from. GitHub serves the newest published
/// release's asset at this fixed path, so a build knows its own release host
/// without being told. It does not cover releases marked as pre-releases —
/// GitHub's "latest" skips those — but a build that needs one is a build that
/// should be pointed at a different repository, not a build that asks the user
/// to paste a URL.
const UPDATE_ENDPOINT: &str =
    "https://github.com/XingLingQAQ/dsh-desktop/releases/latest/download/latest.json";

/// Channels offered for the harness. npm has an `alpha` tag too; it trails both
/// of these right now, so offering it would only be a way to downgrade.
pub const HARNESS_CHANNELS: [&str; 2] = ["latest", "next"];

/// The two Windows status codes this actually hits, neither of which means
/// anything to a reader: the process could not start at all, or it was killed.
/// Anything else is reported as the raw code.
fn explain_exit(code: i32) -> String {
    match code {
        // 0xC0000142 STATUS_DLL_INIT_FAILED — seen when the machine is out of
        // memory and the loader cannot initialise a new process.
        -1073741502 => "子进程无法启动（通常是内存不足）".to_string(),
        // 0xC000013A STATUS_CONTROL_C_EXIT
        -1073741510 => "下载被中断".to_string(),
        other => format!("退出码 {other}"),
    }
}

/// Run a program and hand back its stdout. Failures carry the stderr tail,
/// which is where curl and npm put the part that explains what went wrong.
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("无法执行 {program}: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail = stderr.lines().rev().take(3).collect::<Vec<_>>().join(" ");
        let reason = match output.status.code() {
            Some(code) => explain_exit(code),
            None => "被信号终止".to_string(),
        };
        return Err(format!(
            "{program} {reason}{}",
            if tail.is_empty() { String::new() } else { format!(": {tail}") }
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

// ── version ordering ─────────────────────────────────────────────────────────

/// Compare dotted numeric cores ("0.1.5" vs "0.1.1"); absent parts are zero.
fn core_cmp(a: &str, b: &str) -> Ordering {
    let left: Vec<u64> = a.split('.').map(|p| p.parse().unwrap_or(0)).collect();
    let right: Vec<u64> = b.split('.').map(|p| p.parse().unwrap_or(0)).collect();
    for index in 0..left.len().max(right.len()) {
        let l = left.get(index).copied().unwrap_or(0);
        let r = right.get(index).copied().unwrap_or(0);
        if l != r {
            return l.cmp(&r);
        }
    }
    Ordering::Equal
}

/// Identifier-wise pre-release comparison: numeric identifiers compare
/// numerically and rank below alphanumeric ones (SemVer 2.0.0 §11).
fn pre_cmp(a: &str, b: &str) -> Ordering {
    let mut left = a.split('.');
    let mut right = b.split('.');
    loop {
        match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(a), Some(b)) => {
                let order = match (a.parse::<u64>(), b.parse::<u64>()) {
                    (Ok(a), Ok(b)) => a.cmp(&b),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => a.cmp(b),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

/// SemVer precedence for the shapes npm publishes here (`0.1.5-rc.1` against
/// `0.1.1-rc.1`), pre-release included: a version with a pre-release ranks below
/// the same version without one.
fn version_cmp(a: &str, b: &str) -> Ordering {
    let (a_core, a_pre) = a.split_once('-').map_or((a, None), |(c, p)| (c, Some(p)));
    let (b_core, b_pre) = b.split_once('-').map_or((b, None), |(c, p)| (c, Some(p)));
    match core_cmp(a_core.trim(), b_core.trim()) {
        Ordering::Equal => match (a_pre, b_pre) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(a), Some(b)) => pre_cmp(a, b),
        },
        other => other,
    }
}

// ── harness ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Default)]
pub struct HarnessUpdate {
    /// Version of the bundle the app is currently running.
    pub current: Option<String>,
    /// Where that bundle was found (diagnostics).
    pub source: String,
    /// npm dist-tag the check followed.
    pub channel: String,
    /// Version that channel points at.
    pub latest: Option<String>,
    pub available: bool,
    /// Why the check could not answer; `None` on success.
    pub error: Option<String>,
}

/// Version of the CLI bundle at `cli`, read from the manifest that ships beside
/// it. Both layouts discovery can produce (`runtime\dsh\node_modules\@deepseek-ai
/// \dsh\...` and `harness-versions\<rev>\apps\cli\...`) keep one in an ancestor
/// directory, so the walk covers both without knowing which is in play.
pub fn harness_version(cli: &str) -> Option<String> {
    for dir in Path::new(cli).ancestors() {
        let manifest = dir.join("package.json");
        if !manifest.is_file() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&manifest) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if value.get("name").and_then(|v| v.as_str()) == Some(HARNESS_PACKAGE) {
            return value
                .get("version")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
    }
    None
}

/// Read the registry's dist-tags for the harness. The abbreviated packument
/// (`application/vnd.npm.install-v1+json`) is a fraction of the full one: it
/// carries versions and dist-tags without every release's dependency list.
fn registry_tags() -> Result<serde_json::Value, String> {
    let body = run(
        "curl.exe",
        &[
            "-sL",
            "--fail",
            "--max-time",
            "60",
            "-H",
            "Accept: application/vnd.npm.install-v1+json",
            &format!("{REGISTRY}/{HARNESS_PACKAGE}"),
        ],
    )?;
    serde_json::from_str(&body).map_err(|e| format!("注册表返回的内容无法解析: {e}"))
}

fn check_harness(channel: &str) -> HarnessUpdate {
    let snapshot = crate::discover::discover();
    let current = snapshot
        .cli
        .as_deref()
        .and_then(|cli| harness_version(cli));

    let mut report = HarnessUpdate {
        current: current.clone(),
        source: snapshot.source.clone(),
        channel: channel.to_string(),
        ..Default::default()
    };

    let tags = match registry_tags() {
        Ok(tags) => tags,
        Err(message) => {
            report.error = Some(message);
            return report;
        }
    };
    let latest = tags
        .pointer(&format!("/dist-tags/{channel}"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let Some(latest) = latest else {
        report.error = Some(format!("注册表里没有 {channel} 通道"));
        return report;
    };
    report.available = match &current {
        Some(current) => version_cmp(&latest, current) == Ordering::Greater,
        // Nothing to compare against: report the channel's version and let the
        // UI present it as the one on offer rather than claiming an update.
        None => false,
    };
    report.latest = Some(latest);
    report
}

// ── shell ────────────────────────────────────────────────────────────────────

#[derive(Serialize, Default)]
pub struct ClientUpdate {
    /// Version this build reports (tauri.conf.json), which is what the manifest
    /// is compared against.
    pub current: String,
    pub latest: Option<String>,
    /// Release notes from the manifest, shown when an update is available.
    pub notes: Option<String>,
    pub available: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Default)]
pub struct UpdateReport {
    pub harness: HarnessUpdate,
    pub client: ClientUpdate,
}

/// Build Tauri's updater. Both halves come from the build itself: the address
/// from this file's constant, the verification key from the configuration the
/// bundler signed against — one place to rotate it, and no second copy to drift.
fn build_updater(app: &tauri::AppHandle) -> Result<Updater, String> {
    let url = tauri::Url::parse(UPDATE_ENDPOINT).map_err(|e| format!("更新地址无效: {e}"))?;
    let pubkey = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if pubkey.is_empty() {
        return Err("这个构建里没有更新公钥，无法校验更新包".into());
    }

    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .pubkey(pubkey)
        .build()
        .map_err(|e| e.to_string())
}

// ── commands ─────────────────────────────────────────────────────────────────

/// Read the settings out of managed state without holding the lock across an
/// await (the guard is not `Send`, and every command here is async).
fn settings_snapshot(app: &tauri::AppHandle) -> AppSettings {
    let state = app.state::<Arc<Mutex<AppSettings>>>();
    let guard = state.lock().unwrap();
    guard.clone()
}

/// Check both update sources. One being unreachable never hides the other: each
/// half reports its own error.
#[tauri::command]
pub async fn check_updates(app: tauri::AppHandle) -> UpdateReport {
    let settings = settings_snapshot(&app);
    let channel = settings
        .harness_channel
        .clone()
        .filter(|c| HARNESS_CHANNELS.contains(&c.as_str()))
        .unwrap_or_else(|| HARNESS_CHANNELS[0].to_string());

    // curl is a blocking subprocess; keep it off the async worker.
    let harness = tauri::async_runtime::spawn_blocking(move || check_harness(&channel))
        .await
        .unwrap_or_else(|e| HarnessUpdate {
            error: Some(e.to_string()),
            ..Default::default()
        });

    let current = app.package_info().version.to_string();
    let client = match build_updater(&app) {
        Err(message) => ClientUpdate {
            current,
            error: Some(message),
            ..Default::default()
        },
        Ok(updater) => match updater.check().await {
            Err(error) => ClientUpdate {
                current,
                error: Some(error.to_string()),
                ..Default::default()
            },
            Ok(None) => ClientUpdate {
                current,
                ..Default::default()
            },
            Ok(Some(update)) => ClientUpdate {
                current,
                latest: Some(update.version.clone()),
                notes: update.body.clone(),
                available: true,
                error: None,
            },
        },
    };

    UpdateReport { harness, client }
}

/// Install a harness version into this desktop's own runtime. Long (an npm
/// resolve plus a download), so progress is streamed as `update-log` lines.
#[tauri::command]
pub async fn install_harness_update(
    app: tauri::AppHandle,
    version: String,
) -> Result<String, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = crate::discover::discover();
        install_dsh_version(&snapshot, &version, &|line| {
            let _ = handle.emit("update-log", line);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Download and install a shell update, then let the installer relaunch the app.
///
/// Tauri's updater verifies the manifest signature before installing and, on
/// Windows, exits the process once the installer is running — so this command
/// does not return on success.
#[tauri::command]
pub async fn install_client_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = build_updater(&app)?;
    let update: Update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "当前已是最新版本".to_string())?;
    let handle = app.clone();
    update
        .download_and_install(
            move |chunk: usize, total: Option<u64>| {
                let _ = handle.emit(
                    "update-progress",
                    serde_json::json!({ "chunk": chunk, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}
