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

/// Channels offered for the harness. Anything npm's registry actually publishes
/// as a dist-tag is fair game here; the picker offers exactly what this list
/// holds, so a channel that is missing from it is not "unavailable", it is
/// invisible — the entry never appears and the choice cannot be made.
///
/// `alpha` used to be left out on the grounds that it trailed `latest`. It does
/// not: the registry has run `latest` = `0.1.5-rc.2` alongside `alpha` =
/// `0.1.6-alpha.2`, so omitting it hid the only channel with something newer on
/// it, and the popup said "已是最新" while a later release sat there unreachable.
pub const HARNESS_CHANNELS: [&str; 3] = ["latest", "next", "alpha"];

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

#[derive(Serialize, Default, Clone)]
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

#[derive(Serialize, Default, Clone)]
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

#[derive(Serialize, Default, Clone)]
pub struct UpdateReport {
    pub harness: HarnessUpdate,
    pub client: ClientUpdate,
}

/// The last report any check produced.
///
/// A check takes seconds — it is a registry read plus a signed manifest over the
/// network — and the popup would otherwise open onto "尚未检查" and fill in later,
/// which reads as the window being slow when it is really the network. The shell
/// already checks on startup for the version chip's dot, so by the time anyone
/// clicks there is almost always an answer waiting here; the popup paints that
/// and refreshes behind it.
pub type SharedReport = Arc<Mutex<Option<UpdateReport>>>;

pub fn new_shared_report() -> SharedReport {
    Arc::new(Mutex::new(None))
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

/// Check the shell's own release manifest.
async fn check_client(app: &tauri::AppHandle) -> ClientUpdate {
    let current = app.package_info().version.to_string();
    match build_updater(app) {
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
    }
}

/// Check both halves, newest result wins, and remember it for the next reader.
/// One being unreachable never hides the other: each reports its own error.
///
/// The harness probe is started first and left to run on a blocking thread while
/// the client check is awaited, so the two network round trips overlap instead of
/// queueing — they have nothing to do with each other, and in sequence the whole
/// thing took as long as both.
#[tauri::command]
pub async fn check_updates(app: tauri::AppHandle, refresh: bool) -> UpdateReport {
    let cached = app.state::<SharedReport>().lock().unwrap().clone();
    if !refresh {
        if let Some(report) = cached {
            return report;
        }
    }

    let settings = settings_snapshot(&app);
    let channel = settings
        .harness_channel
        .clone()
        .filter(|c| HARNESS_CHANNELS.contains(&c.as_str()))
        .unwrap_or_else(|| HARNESS_CHANNELS[0].to_string());

    // curl is a blocking subprocess; keep it off the async worker. Started here
    // so it is already running when the client check below awaits.
    let harness_job = tauri::async_runtime::spawn_blocking(move || check_harness(&channel));
    let client = check_client(&app).await;
    let harness = harness_job.await.unwrap_or_else(|e| HarnessUpdate {
        error: Some(e.to_string()),
        ..Default::default()
    });

    let report = UpdateReport { harness, client };
    *app.state::<SharedReport>().lock().unwrap() = Some(report.clone());
    report
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

/// A shell update that has been fetched and verified, waiting to be applied.
///
/// Download and apply are separate commands so the fetch can run while the app
/// stays usable: the popup shows a progress bar, and applying it — which ends
/// this process — is a second, deliberate click rather than something that
/// happens the moment the bytes land. Both halves of the pair are kept, because
/// applying needs the manifest entry the bytes were verified against.
pub struct DownloadedShell {
    update: Update,
    bytes: Vec<u8>,
    version: String,
}

pub type SharedShellDownload = Arc<Mutex<Option<DownloadedShell>>>;

pub fn new_shared_shell_download() -> SharedShellDownload {
    Arc::new(Mutex::new(None))
}

/// Fetch the shell update and hold it, verified, until it is applied.
///
/// Verification happens inside Tauri's own download: the signature from the
/// release manifest is checked against the public key baked into this build
/// before anything is kept. The bytes stay in memory rather than going out to a
/// temp file — they are a few megabytes and the process that will run them is
/// this one, so a file would only be a second copy to clean up.
///
/// "Nothing to fetch" is an `Ok` carrying `available: false`, not an error: it
/// is the ordinary answer most days, and the caller is a button that has to
/// stay usable either way.
#[tauri::command]
pub async fn download_client_update(app: tauri::AppHandle) -> Result<ClientUpdate, String> {
    let updater = build_updater(&app)?;
    let update = match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => update,
        None => {
            return Ok(ClientUpdate {
                current: app.package_info().version.to_string(),
                ..Default::default()
            })
        }
    };

    let handle = app.clone();
    let bytes = update
        .download(
            move |chunk: usize, total: Option<u64>| {
                let _ = handle.emit(
                    "update-progress",
                    serde_json::json!({ "chunk": chunk, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    let version = update.version.clone();
    let body = update.body.clone();
    *app.state::<SharedShellDownload>().lock().unwrap() = Some(DownloadedShell {
        update,
        bytes,
        version: version.clone(),
    });

    Ok(ClientUpdate {
        current: app.package_info().version.to_string(),
        latest: Some(version),
        notes: body,
        available: true,
        error: None,
    })
}

/// Apply the update fetched by \ref download_client_update.
///
/// Nothing is fetched here, so this needs no network and cannot fail on one —
/// the bytes were verified when they were downloaded. On Windows Tauri hands
/// the installer to the shell and exits this process; the installer puts the
/// new version in place and relaunches the app. That is why this does not
/// return on success, and why "nothing downloaded yet" is a real error rather
/// than a reason to go and fetch one now.
#[tauri::command]
pub async fn install_client_update(app: tauri::AppHandle) -> Result<(), String> {
    let downloaded = app
        .state::<SharedShellDownload>()
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "更新还没有下载完成".to_string())?;

    downloaded
        .update
        .install(&downloaded.bytes)
        .map_err(|e| format!("安装 {} 失败: {e}", downloaded.version))
}