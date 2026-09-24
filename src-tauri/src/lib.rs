//! DSH Desktop — DeepSeek Harness desktop launcher.
//!
//! Launch flow (strict ordering — nothing starts before detection passes):
//!   1. 检测运行环境  — discover node / dsh CLI / DSH_HOME; failure → error UI, no spawn.
//!   2. 启动服务      — attach to an already-running host (port probe), or spawn
//!                      `dsh --profile web` with the detected environment.
//!   3. 等待就绪      — parse the `dsh web: http://127.0.0.1:<port>` readiness line
//!                      and health-check it.
//!   4. 进入界面      — only now attach the DSH UI child WebView and show the main
//!                      window (splash hides).

mod bridge;
mod discover;
mod host;
mod pet;
mod pet_files;
mod plugin_state;
mod plugins;
mod provision;
mod registry;
mod settings;
mod skills;
mod store;
mod update;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use tauri::{
    tray::TrayIconBuilder,
    webview::{Color, NewWindowResponse},
    Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, RunEvent, Url, WebviewBuilder,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::bridge::Bridge;
use crate::discover::{discover, EnvironmentSnapshot};
use crate::plugins::PluginManager;
use crate::settings::AppSettings;
use crate::host::{http_get_ok, probe_existing, HostEvent, HostProcess};
use crate::provision::provision;
use crate::update::{
    check_updates, download_client_update, install_client_update, install_harness_update,
};

/// Height of the custom title bar in the shell page (must match `--titlebar-height`).
const TITLEBAR_HEIGHT: f64 = 46.0;
/// Corner radius of the main window (must match `--corner-radius`).
const CORNER_RADIUS: f64 = 12.0;
/// Ports probed for an already-running host (attach mode).
const ATTACH_PORTS: [u16; 2] = [17890, 3080];
/// How long to wait for the readiness line.
const BOOT_TIMEOUT: Duration = Duration::from_secs(45);
/// Update popup window geometry (must match `--popup-*` in styles.css).
const POPUP_WIDTH: f64 = 372.0;
const POPUP_HEIGHT: f64 = 424.0;
const POPUP_MIN_HEIGHT: f64 = 120.0;
const POPUP_RADIUS: f64 = 12.0;

/// Launch sequence state, polled by the splash page and the shell title bar.
#[derive(Clone, Serialize)]
struct LaunchState {
    /// 0..2 = steps, 3 = ready; -1 = not started.
    step: i32,
    label: String,
    done: bool,
    port: Option<u16>,
    url: Option<String>,
    error: Option<String>,
    /// Live output tail of the host process (diagnostics).
    log: Vec<String>,
    /// True when attached to an already-running host instead of spawning one.
    attached: bool,
}

impl Default for LaunchState {
    fn default() -> Self {
        Self {
            step: -1,
            label: String::new(),
            done: false,
            port: None,
            url: None,
            error: None,
            log: Vec::new(),
            attached: false,
        }
    }
}

type SharedState = Arc<Mutex<LaunchState>>;
type SharedHost = Arc<Mutex<Option<HostProcess>>>;

#[tauri::command]
fn get_launch_state(state: tauri::State<SharedState>) -> LaunchState {
    state.lock().unwrap().clone()
}

/// Current desktop plugin manifest (for the shell UI / diagnostics).
#[tauri::command]
fn get_desktop_plugins(bridge: tauri::State<Arc<Bridge>>) -> crate::plugins::PluginState {
    let handle = bridge.plugins.state();
    let state = handle.lock().unwrap().clone();
    state
}

/// Current shell settings.
#[tauri::command]
fn get_settings(state: tauri::State<Arc<Mutex<AppSettings>>>) -> AppSettings {
    let mut settings = state.lock().unwrap().clone();
    // 开机自启以注册表实际状态为准，避免本地 JSON 与系统状态不一致。
    settings.auto_start = settings::auto_start_enabled();
    settings
}

/// Toggle close-to-tray behavior.
#[tauri::command]
fn set_close_to_tray(
    state: tauri::State<Arc<Mutex<AppSettings>>>,
    value: bool,
) -> Result<AppSettings, String> {
    let mut settings = state.lock().unwrap();
    settings.close_to_tray = value;
    settings::save(&settings).map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

/// Toggle Windows auto-start (HKCU Run key).
#[tauri::command]
fn set_auto_start(
    state: tauri::State<Arc<Mutex<AppSettings>>>,
    value: bool,
) -> Result<AppSettings, String> {
    settings::set_auto_start(value).map_err(|e| e.to_string())?;
    let mut settings = state.lock().unwrap();
    settings.auto_start = value;
    settings::save(&settings).map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

/// Set the selected workspace folder (stored in settings).
#[tauri::command]
fn set_workspace_folder(
    state: tauri::State<Arc<Mutex<AppSettings>>>,
    path: String,
) -> Result<AppSettings, String> {
    let mut settings = state.lock().unwrap();
    settings.workspace_folder = Some(path);
    settings::save(&settings).map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

/// Pick which npm dist-tag the harness update check follows. An empty string
/// clears it, so `Option::is_none` keeps meaning "not set" (and the check falls
/// back to the default channel).
#[tauri::command]
fn set_harness_channel(
    state: tauri::State<Arc<Mutex<AppSettings>>>,
    channel: String,
) -> Result<AppSettings, String> {
    let channel = channel.trim().to_string();
    let mut settings = state.lock().unwrap();
    settings.harness_channel = (!channel.is_empty()).then_some(channel);
    settings::save(&settings).map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

/// The last theme the DSH page reported, for windows created after the page
/// started watching it — they missed the only `theme-changed` event there was.
/// `None` before the page has reported anything.
#[tauri::command]
fn get_theme(bridge: tauri::State<Arc<Bridge>>) -> Option<crate::bridge::ThemeSnapshot> {
    bridge.theme.lock().unwrap().clone()
}

/// Version this build reports, from tauri.conf.json — the number the update
/// check compares against, so the title bar and the updater cannot disagree.
#[tauri::command]
fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Restart the shell so a version just installed is the one that comes up.
///
/// The host process we spawned is killed first: left alive it would outlive the
/// shell, and the next launch would find it answering on its port and attach to
/// it — running the very version the user just replaced.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    if let Some(slot) = app.try_state::<SharedHost>() {
        if let Some(mut process) = slot.lock().unwrap().take() {
            process.kill();
        }
    }
    app.request_restart()
}

/// Export a diagnostics report to `%APPDATA%\dsh-desktop\diagnostics`.
#[tauri::command]
fn export_diagnostics(
    state: tauri::State<SharedState>,
    bridge: tauri::State<Arc<Bridge>>,
    settings_state: tauri::State<Arc<Mutex<AppSettings>>>,
) -> Result<String, String> {
    let launch = state.lock().unwrap();
    let settings = settings_state.lock().unwrap();
    let plugins_handle = bridge.plugins.state();
    let plugins = plugins_handle.lock().unwrap();
    let current_session = bridge.plugins.current_session();

    let mut report = String::new();
    report.push_str("DSH Desktop Diagnostics\n");
    report.push_str("========================\n");
    report.push_str(&format!(
        "Time: {:?}\n",
        SystemTime::now().duration_since(UNIX_EPOCH)
    ));
    report.push_str(&format!(
        "Settings: {}\n",
        serde_json::to_string_pretty(&*settings).unwrap_or_else(|_| "{}".into())
    ));
    report.push_str(&format!(
        "Launch: step={} done={} port={:?} url={:?} attached={} error={:?}\n",
        launch.step, launch.done, launch.port, launch.url, launch.attached, launch.error
    ));
    report.push_str("\nLog tail:\n");
    for line in &launch.log {
        report.push_str(line);
        report.push('\n');
    }
    report.push_str(&format!(
        "\nPlugins: {}\n",
        serde_json::to_string_pretty(&*plugins).unwrap_or_else(|_| "{}".into())
    ));
    report.push_str(&format!("Current session: {current_session:?}\n"));

    let dir = std::env::var("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("dsh-desktop")
        .join("diagnostics");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("diagnostics-{stamp}.txt"));
    std::fs::write(&path, report).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// The command must be async and must not touch the window itself: this runs on
/// the async runtime, and every window call from there is a dispatch to the main
/// thread that blocks until it is served. A synchronous command would run *on*
/// the main thread, where that same dispatch waits for the thread it is already
/// on — which deadlocks the whole app (no paint, and every later IPC call hangs).
/// So the work is handed to the main thread and this returns immediately.
#[tauri::command]
async fn open_update_popup(
    app: tauri::AppHandle,
    anchor_x: Option<f64>,
    anchor_bottom: Option<f64>,
) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = show_update_popup(&handle, anchor_x, anchor_bottom) {
            eprintln!("dsh-desktop: open update popup failed: {error}");
        }
    })
    .map_err(|e| e.to_string())
}

/// Hide the update popup if it is up.
///
/// A press anywhere in the shell dismisses it, the same as a press outside any
/// other popover. The shell page calls this on its own mouse-downs; presses that
/// land on the DSH content are handled in Rust, since that is a separate child
/// webview the shell page never sees.
#[tauri::command]
async fn close_update_popup(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || hide_update_popup(&handle)).map_err(|e| e.to_string())
}

/// 排空 host 进程事件通道里开机之后积压的 stdout/stderr 行。
///
/// 开机就绪循环拿到 Ready 行后就退出,此后 host 的所有输出(含 cordis HMR
/// 热挂/热卸触发的插件 apply()/dispose 日志)一直堆在 mpsc 通道里没人取,
/// `export_diagnostics` 只读 `launch.log` 环形缓冲,自然看不到这些行。
/// 本命令排空通道并返回积压内容,用于核实 fiber 级热暂停/热加载是否真的发生。
#[tauri::command]
fn drain_host_log(host: tauri::State<SharedHost>) -> Vec<String> {
    let mut slot = host.lock().unwrap();
    let Some(process) = slot.as_mut() else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    loop {
        match process.try_event() {
            Ok(HostEvent::Log(line)) => lines.push(line),
            Ok(HostEvent::Ready(_)) => {}
            Err(std::sync::mpsc::TryRecvError::Empty) => break,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
        }
    }
    lines
}

/// List installed plugins (for the Settings > Plugins management page).
#[tauri::command]
fn get_installed_plugins(bridge: tauri::State<Arc<Bridge>>) -> Vec<store::InstalledPluginInfo> {
    let disabled = bridge.plugins.disabled_snapshot();
    let migrated: std::collections::HashSet<String> =
        bridge.plugins.managed_externals().into_iter().collect();
    store::list_installed(&disabled, &migrated)
}

/// Uninstall a plugin from the desktop plugins directory.
#[tauri::command]
fn uninstall_plugin(id: String) -> Result<(), String> {
    store::uninstall_plugin(&id)
}

/// List a directory for the custom workspace-folder picker.
#[tauri::command]
fn list_directory(path: String) -> Result<Vec<store::DirEntry>, String> {
    store::list_directory(&path)
}

/// Hide the splash window and bring the main window to the front.
#[tauri::command]
fn finish_splash(app: tauri::AppHandle) {
    enter_main(&app);
}

/// Show the main window (used by the custom tray menu).
#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Open the settings panel and show the main window.
#[tauri::command]
fn open_settings(app: tauri::AppHandle) {
    if let Some(win) = app.get_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    let _ = app.emit("open-settings", ());
}

/// Show or hide the desktop pet.
///
/// Returns the state that actually took effect rather than the one requested, so
/// a caller that asked to show a pet which then failed to appear is told so
/// instead of rendering a toggle that disagrees with the desktop.
#[tauri::command]
fn set_pet_visible(app: tauri::AppHandle, visible: bool) -> Result<bool, String> {
    if visible {
        pet::show(&app)?;
    } else {
        pet::hide(&app)?;
        // The bubble is anchored to the pet, so leaving it behind would strand a
        // card pointing at nothing.
        hide_pet_bubble(app.clone());
    }
    Ok(pet::load().enabled)
}

/// Whether the pet is currently shown.
#[tauri::command]
fn pet_visible() -> bool {
    pet::load().enabled
}

/// Remember where the pet is. Called after a drag settles.
#[tauri::command]
fn pet_save_position(app: tauri::AppHandle) {
    pet::remember_position_now(&app);
}

/// How often the pet asks the host what the current session is doing.
///
/// Polling rather than a push channel: the state is a few hundred bytes from a
/// server on the same machine, and a pet's expression does not need to be
/// frame-accurate. An SSE route would remove the interval, and is worth doing if
/// the bubble ever shows streaming text.
const PET_STATE_INTERVAL: Duration = Duration::from_millis(600);

/// `http://127.0.0.1:59262/?token=…` → `http://127.0.0.1:59262`
///
/// The token in the readiness URL authenticates the app shell, not the plugin
/// routes, and carrying it into a polled URL would put it in the host's logs for
/// no benefit.
fn origin_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("http://")?;
    let authority = match rest.find('/') {
        Some(index) => &rest[..index],
        None => rest,
    };
    if authority.is_empty() {
        return None;
    }
    Some(format!("http://{authority}"))
}

/// Watch the host's session state and tell the pet window about changes.
///
/// The pet cannot fetch this itself. It is a shell window on a different origin
/// from the DSH host, and the shell is the only party that knows where the host
/// is listening — so the shell fetches and re-emits over Tauri's own event
/// channel, which the pet window already has permission to listen on.
///
/// The loop idles while the pet is hidden, and forgets the last value when it
/// goes away so the pet is told the state again the moment it comes back, rather
/// than waiting for something to change.
fn start_pet_state_watch(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last = String::new();
        // The last turn end this loop has already reacted to. `None` means it has
        // not seen one yet, which is what stops the very first poll — which reads
        // whatever the previous run left behind — from announcing a turn that
        // finished before the pet existed.
        let mut last_end_at: Option<u64> = None;
        loop {
            std::thread::sleep(PET_STATE_INTERVAL);
            if !pet::is_visible() {
                last.clear();
                continue;
            }
            let url = match app.try_state::<SharedState>() {
                Some(state) => state.lock().unwrap().url.clone(),
                None => None,
            };
            let Some(origin) = url.as_deref().and_then(origin_of) else { continue };
            let target = format!("{origin}/dsh-desktop-pet/state");
            let Some(body) = host::http_get_body(&target) else { continue };
            if body != last {
                last = body.clone();
                *LAST_PET_STATE.lock().unwrap() = Some(body.clone());
                let _ = app.emit("pet-state", body.clone());
            }
            // A turn ending is worth interrupting for only when nobody is looking.
            // With the main window up, the transcript is right there and the pet's
            // face is enough; with it hidden, a 132px face in a corner is easy to
            // miss and the whole reason the pet exists is that case.
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) {
                let end = value.get("lastEnd");
                let at = end.and_then(|e| e.get("at")).and_then(|a| a.as_u64());
                if let Some(at) = at {
                    let first = last_end_at.is_none();
                    if last_end_at != Some(at) {
                        last_end_at = Some(at);
                        if !first && !main_window_visible(&app) {
                            let kind = end
                                .and_then(|e| e.get("kind"))
                                .and_then(|k| k.as_str())
                                .unwrap_or("completed");
                            let title = value
                                .get("title")
                                .and_then(|t| t.as_str())
                                .unwrap_or_default();
                            let _ = app.emit(
                                "pet-notify",
                                json!({ "kind": kind, "title": title }).to_string(),
                            );
                        }
                    }
                }
            }
        }
    });
}

/// Whether the main window is on screen.
///
/// `get_window` rather than `get_webview_window`: once the DSH content is
/// attached as a child webview, the latter fails its `is_webview_window` check
/// and returns `None` for a window that is very much still there — which would
/// read as "not visible" and make the pet announce every turn.
fn main_window_visible(app: &tauri::AppHandle) -> bool {
    app.get_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// Logical size of the pet's bubble.
///
/// Wide enough for a session title and two short lines; deliberately not a chat
/// transcript. The bubble answers "what is it doing", and anything that needs
/// scrolling belongs in the main window.
///
/// The height is the **worst case**, not the common one. The card inside is
/// bottom-anchored and `min-height: 172px`, so an empty bubble renders exactly as
/// it did before this grew — and when files are queued the card grows *upward*
/// into the top of the window, away from the pet. 235 is what it takes for a
/// three-row file list plus a two-line refusal to fit without clipping; at 172 the
/// top 63px would be cut off by the page's `overflow: hidden`.
///
/// The cost is that the top of the window is transparent but still swallows
/// clicks, since these windows do not click through. Resizing on demand would
/// avoid that and needs new Rust; a fixed size that is always big enough does not.
const PET_BUBBLE_WIDTH: f64 = 268.0;
const PET_BUBBLE_HEIGHT: f64 = 235.0;

/// The most recent session-state document.
///
/// Cached so a window that opens between two polls can render immediately rather
/// than showing an empty card for up to one interval. Without it, opening the
/// bubble always looks like a flicker before it fills in.
static LAST_PET_STATE: Mutex<Option<String>> = Mutex::new(None);

/// The last session-state document the host sent, if any.
#[tauri::command]
fn pet_session_state() -> Option<String> {
    LAST_PET_STATE.lock().unwrap().clone()
}

/// Create the pet's bubble window if it does not exist yet, hidden.
///
/// Pre-created for the same reason as the other auxiliary windows, and here the
/// reason is sharpest: the bubble opens on a *click*, and a webview build on that
/// click is a visible stall in the middle of a gesture.
fn prepare_pet_bubble(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = app.get_webview_window("pet-bubble") {
        return Ok(existing);
    }
    WebviewWindowBuilder::new(app, "pet-bubble", WebviewUrl::App("pet-bubble.html".into()))
        .title("DSH Desktop Pet")
        .inner_size(PET_BUBBLE_WIDTH, PET_BUBBLE_HEIGHT)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .transparent(true)
        .visible(false)
        .build()
}

/// The bubble's visible size in physical pixels.
fn pet_bubble_inner_size(app: &tauri::AppHandle) -> (i32, i32) {
    let Some(window) = app.get_webview_window("pet-bubble") else {
        return (PET_BUBBLE_WIDTH as i32, PET_BUBBLE_HEIGHT as i32);
    };
    match (window.inner_size(), window.scale_factor()) {
        (Ok(size), _) if size.width > 0 => (size.width as i32, size.height as i32),
        (_, Ok(scale)) => (
            (PET_BUBBLE_WIDTH * scale).round() as i32,
            (PET_BUBBLE_HEIGHT * scale).round() as i32,
        ),
        _ => (PET_BUBBLE_WIDTH as i32, PET_BUBBLE_HEIGHT as i32),
    }
}

/// Open the pet's bubble, or close it if it is already open.
///
/// A toggle rather than show-only, because clicking the pet is the gesture that
/// both opens and dismisses it: the bubble is anchored to the pet, so the pet is
/// the natural place to click it away. (Clicking elsewhere does not dismiss it
/// yet — the update popup needed Raw Input to notice that, and this reuses none
/// of that machinery. See the note in the phase 2 write-up.)
#[tauri::command]
fn show_pet_bubble(app: tauri::AppHandle) {
    let Some(bubble) = app.get_webview_window("pet-bubble") else {
        eprintln!("dsh-desktop: pet bubble window is missing");
        return;
    };
    if bubble.is_visible().unwrap_or(false) {
        let _ = bubble.hide();
        return;
    }
    let Some(pet_window) = app.get_webview_window(pet::PET_LABEL) else { return };
    let Ok(position) = pet_window.outer_position() else { return };
    let Ok(size) = pet_window.outer_size() else { return };
    let (width, height) = pet_bubble_inner_size(&app);
    // Above the pet by preference: the pet's default home is the bottom-right
    // corner, so below is usually off-screen. Falls back to below when there is
    // genuinely no room above.
    let above = position.y - height;
    let y = match work_area() {
        Some((_, top, _, _)) if above >= top => above,
        _ => position.y + size.height as i32,
    };
    place_card(&bubble, position.x, y, width, height);
    let _ = bubble.show();
    // No `set_focus`: the bubble is informational, and stealing focus from
    // whatever the user is typing in would be a rude way to answer a click.
}

/// Close the pet's bubble.
#[tauri::command]
fn hide_pet_bubble(app: tauri::AppHandle) {
    if let Some(bubble) = app.get_webview_window("pet-bubble") {
        let _ = bubble.hide();
    }
}

/// The pet bubble's view of every session, straight from the host.
///
/// Returned as the host's own JSON string rather than a typed struct: the shape
/// is the plugin's, and mirroring it in Rust would be a second definition to keep
/// in step for no benefit — the only consumer is the bubble, which parses it.
#[tauri::command]
fn pet_sessions(app: tauri::AppHandle) -> Result<String, String> {
    let url = format!("{}/dsh-desktop-pet/sessions", pet_host_origin(&app)?);
    host::http_get_body(&url).ok_or_else(|| "取不到会话列表".to_string())
}

/// Point the pet at one session.
#[tauri::command]
fn pet_select_session(app: tauri::AppHandle, session_id: String) -> Result<String, String> {
    let url = format!("{}/dsh-desktop-pet/select", pet_host_origin(&app)?);
    let body = json!({ "sessionId": session_id }).to_string();
    let answer = host::http_post_json(&url, &body).ok_or_else(|| "切换会话失败".to_string())?;
    // The command returns the new current id, or null when the host refused. The
    // bubble applies it immediately so the title answers the click instead of
    // waiting a poll interval.
    let parsed: serde_json::Value =
        serde_json::from_str(&answer).map_err(|e| format!("切换会话返回无法解析：{e}"))?;
    if parsed.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(parsed
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("切换会话失败")
            .to_string());
    }
    Ok(parsed
        .get("current")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string())
}

/// Tell every window what the file queue now holds.
///
/// Broadcast rather than sent to the bubble alone: the pet window also shows a
/// count, and it is visible when the bubble is not.
fn emit_queue(app: &tauri::AppHandle, view: &pet_files::QueueView) {
    if let Ok(text) = serde_json::to_string(view) {
        let _ = app.emit("pet-queue", text);
    }
}

/// Add dropped paths to the pet's file queue.
#[tauri::command]
fn pet_add_files(app: tauri::AppHandle, paths: Vec<String>) -> usize {
    let view = pet_files::add(&paths);
    emit_queue(&app, &view);
    view.count
}

/// The pet's file queue.
#[tauri::command]
fn pet_queue() -> String {
    serde_json::to_string(&pet_files::view())
        .unwrap_or_else(|_| "{\"count\":0,\"files\":[]}".to_string())
}

/// Drop one path from the queue.
#[tauri::command]
fn pet_remove_file(app: tauri::AppHandle, path: String) -> usize {
    let view = pet_files::remove(&path);
    emit_queue(&app, &view);
    view.count
}

/// Empty the queue.
#[tauri::command]
fn pet_clear_files(app: tauri::AppHandle) -> usize {
    let view = pet_files::clear();
    emit_queue(&app, &view);
    view.count
}

/// Send a prompt into a session from the pet's bubble.
///
/// Always resolves with the host's own JSON (`{"ok":true}` or
/// `{"ok":false,"error":{…}}`) rather than turning a refusal into a rejected
/// promise. The refusal carries the reason — a real one is
/// `SessionAlreadyOwnedError` — and the bubble renders that text, so it has to
/// survive the trip. Only a transport failure becomes an `Err`.
///
/// `files` are absolute local paths; the host turns them into prompt content
/// parts. The queue is emptied **only** on acceptance: a refusal usually has a
/// fixable cause, and clearing first would throw the user's files away in
/// exchange for an error message.
#[tauri::command]
fn pet_send_prompt(
    app: tauri::AppHandle,
    session_id: String,
    text: String,
    files: Option<Vec<String>>,
) -> Result<String, String> {
    let files = files.unwrap_or_default();
    let url = format!("{}/dsh-desktop-pet/prompt", pet_host_origin(&app)?);
    let body = json!({ "sessionId": session_id, "text": text, "files": files }).to_string();
    let answer =
        host::http_post_json(&url, &body).ok_or_else(|| "发不出去：宿主没有响应".to_string())?;
    let accepted = serde_json::from_str::<serde_json::Value>(&answer)
        .ok()
        .and_then(|value| value.get("ok").and_then(|ok| ok.as_bool()))
        == Some(true);
    if accepted && !files.is_empty() {
        let view = pet_files::clear();
        emit_queue(&app, &view);
    }
    Ok(answer)
}

/// Where the DSH host is listening, without the auth token.
fn pet_host_origin(app: &tauri::AppHandle) -> Result<String, String> {
    let state = app
        .try_state::<SharedState>()
        .ok_or_else(|| "启动状态不可用".to_string())?;
    let url = state.lock().unwrap().url.clone();
    url.as_deref()
        .and_then(origin_of)
        .ok_or_else(|| "宿主还没就绪".to_string())
}

/// Open the pet's own small menu, anchored to the pet window.
///
/// The pet usually sits at the bottom of the screen, so a menu anchored below it
/// would hang off the desktop — the same trap the update popup hit, and the
/// reason it opens upward. Horizontal overflow is handled by the clamp inside
/// `show_tray_menu`, because the menu is wider than the pet.
#[tauri::command]
fn show_pet_menu(app: tauri::AppHandle) {
    let Some(pet_window) = app.get_webview_window(pet::PET_LABEL) else { return };
    let Ok(position) = pet_window.outer_position() else { return };
    let Ok(size) = pet_window.outer_size() else { return };
    let (_, menu_height) = tray_menu_inner_size(&app);
    let below = position.y + size.height as i32;
    let fits_below = match work_area() {
        Some((_, _, _, area_bottom)) => below + menu_height <= area_bottom,
        None => true,
    };
    let y = if fits_below { below } else { position.y - menu_height };
    show_tray_menu(&app, position.x, y);
}

/// Quit the application (used by the custom tray menu).
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    if let Some(quitting) = app.try_state::<Arc<AtomicBool>>() {
        quitting.store(true, Ordering::SeqCst);
    }
    app.exit(0);
}

/// Re-run the launch sequence after a detection/spawn failure.
#[tauri::command]
fn retry_launch(
    app: tauri::AppHandle,
    state: tauri::State<SharedState>,
    host: tauri::State<SharedHost>,
    guard: tauri::State<Arc<AtomicBool>>,
    bridge: tauri::State<Arc<Bridge>>,
) {
    if guard.load(Ordering::SeqCst) {
        return;
    }
    {
        let mut s = state.lock().unwrap();
        *s = LaunchState::default();
    }
    {
        let mut slot = host.lock().unwrap();
        if let Some(mut process) = slot.take() {
            process.kill();
        }
    }
    start_launch(
        app,
        state.inner().clone(),
        host.inner().clone(),
        guard.inner().clone(),
        bridge.inner().clone(),
    );
}

fn enter_main(app: &tauri::AppHandle) {
    // 注意：主窗口加了 content 子 webview 后，get_webview_window("main")
    // 会因 is_webview_window() 判定失败而返回 None（窗口仍在），
    // 必须用窗口级 get_window()。
    // 销毁 splash（而不是隐藏）：保证主窗口是唯一窗口，
    // 关闭主窗口即触发默认退出逻辑（RunEvent::Exit 清理 host）。
    if let Some(splash) = app.get_window("splash") {
        match splash.close() {
            Ok(()) => eprintln!("dsh-desktop: splash closed"),
            Err(e) => eprintln!("dsh-desktop: splash close failed: {e}"),
        }
    } else {
        eprintln!("dsh-desktop: splash window not found in enter_main");
    }
    if let Some(main) = app.get_window("main") {
        // 显式恢复（unminimize 对未最小化窗口是空操作，防止任何异常状态）。
        let _ = main.unminimize();
        match main.show() {
            Ok(()) => eprintln!("dsh-desktop: main shown"),
            Err(e) => eprintln!("dsh-desktop: main show FAILED: {e}"),
        }
        let _ = main.set_size(LogicalSize::new(1280.0, 820.0));
        let _ = main.set_position(LogicalPosition::new(200.0, 100.0));
        let _ = main.set_focus();
    } else {
        eprintln!("dsh-desktop: main window NOT FOUND in enter_main");
    }
}

/// 更新弹窗当前是否打开。
///
/// 唯一的状态来源：不管从哪条路关掉（点遮罩、点壳页面、点 DSH 页面、按 Esc），
/// 都走 \ref hide_update_popup 把它清掉。这样"点版本号"的开关判断就永远和实际
/// 一致，不会再出现"关掉之后再也打不开"。
static POPUP_OPEN: AtomicBool = AtomicBool::new(false);

/// 关掉更新弹窗：窗口和遮罩一起收，并清掉状态标志。
///
/// 所有关闭路径都必须经过这里——直接 `popup.hide()` 会让标志留在打开状态，
/// 下一次点版本号就会被当成"要关闭"。
fn hide_update_popup(app: &tauri::AppHandle) {
    POPUP_OPEN.store(false, Ordering::SeqCst);
    // 停止接收鼠标消息：留着的话弹窗关了之后每条鼠标事件还会往一个隐藏窗口投，
    // 白白唤醒事件循环（上一版钩子"变僵尸"就是这么来的）。
    stop_watching_presses();
    if let Some(popup) = app.get_webview_window("update-popup") {
        let _ = popup.hide();
    }
}

/// Hide the update popup under the version chip.
///
/// It is a window of its own rather than a layer in the shell page because the
/// DSH UI is a second, native webview placed over the shell's from the title bar
/// down: anything the shell draws below the title bar is behind it. A separate
/// always-on-top window is above both, the same trick the tray menu uses.
///
/// The window hides itself when it loses focus, which is what stands in for the
/// scrim a popover would normally use to catch clicks outside it.
///
/// It is built at startup rather than here (\ref prepare_update_popup), so this
/// path only positions and shows it. Building it on the first click made that
/// click pay for a webview, a page load and a React mount — seconds in dev,
/// where the modules arrive unbundled.
///
/// `anchor_x` and `anchor_bottom` are the version chip's edges in the shell
/// page, so the panel opens under the thing that was clicked rather than at a
/// guessed offset. The horizontal one is clamped to the monitor: a window near
/// the right edge would otherwise hang its panel off-screen.
fn show_update_popup(
    app: &tauri::AppHandle,
    anchor_x: Option<f64>,
    anchor_bottom: Option<f64>,
) -> Result<(), String> {
    let main = app.get_window("main").ok_or("主窗口不存在")?;
    let scale = main.scale_factor().unwrap_or(1.0);
    let origin = main.outer_position().map_err(|e| e.to_string())?;

    let Some(popup) = app.get_webview_window("update-popup") else {
        return Err("更新窗口未创建".into());
    };
    // 开关状态记在我们自己这里，不靠 is_visible() 反推。
    //
    // 弹窗的隐藏有好几条路（点遮罩、点壳页面、点 DSH 页面、按 Esc），其中遮罩那条
    // 走的是原生窗口流程。用 is_visible() 反推曾经导致"关掉之后再点打不开"：窗口
    // 已经是隐藏状态，但判断读到的不是这个结论，于是走进了"隐藏"分支——越点越关。
    // 自己维护一个标志，谁关的都把它清掉，就不会出现两边认知不一致。
    if POPUP_OPEN.swap(false, Ordering::SeqCst) {
        hide_update_popup(app);
        return Ok(());
    }

    // The page does not start at the window's top-left on Windows — even a
    // frameless window carries a non-client frame — so a position taken
    // straight from the chip's coordinates lands the panel a few pixels off.
    // The window knows both corners, so ask it instead of guessing a constant.
    let frame = match (popup.outer_position(), popup.inner_position()) {
        (Ok(outer), Ok(inner)) => (inner.x - outer.x, inner.y - outer.y),
        _ => (0, 0),
    };
    let outer_width = popup
        .inner_size()
        .map(|size| size.width as f64)
        .unwrap_or(POPUP_WIDTH * scale)
        + frame.0 as f64;

    let mut left = origin.x as f64 + anchor_x.unwrap_or(12.0) * scale;
    let top = origin.y as f64 + anchor_bottom.unwrap_or(TITLEBAR_HEIGHT) * scale + 6.0 * scale;
    if let Ok(Some(monitor)) = main.current_monitor() {
        let area = monitor.work_area();
        let margin = 8.0 * scale;
        let min = area.position.x as f64 + margin;
        let max = area.position.x as f64 + area.size.width as f64 - outer_width - margin;
        left = left.clamp(min, max.max(min));
    }
    let position = tauri::PhysicalPosition::new(
        left.round() as i32 - frame.0,
        top.round() as i32 - frame.1,
    );

    let _ = popup.set_position(position);
    // The rounded region is set once when the window is built and lives on the
    // HWND across hide/show, so it is deliberately NOT re-applied here:
    // SetWindowRgn invalidates the whole window and forces a repaint at exactly
    // the moment it is supposed to appear.
    let _ = popup.show();
    // 在弹窗下面铺一层全屏透明遮罩，专门接住"点在外面"这一下。
    //
    // 这是这个功能唯一站得住的做法：本机（RDP 非交互会话）里应用**从未获得过前台**
    // ——前台恒定是远程桌面客户端，所以失焦消息永远不来、轮询前台永远判成"别人"。
    // 全局鼠标钩子也试过，问题更多：回调跑在主线程上，里面做任何同步窗口操作都会
    // 重入/自锁，取坐标还要跟 Tauri 的异步布局抢时间（实测取到的矩形偏了 40px，
    // 把点弹窗自己判成了点外面）。
    //
    // Raw Input 是 Windows 为"后台、无焦点也能收输入"提供的正规机制，只往我们
    // 投一条普通消息，不拦截系统消息链、不会被超时强杀、也不消费事件——点外面那
    // 一下照常传给底下的程序。
    watch_presses(popup.clone());
    POPUP_OPEN.store(true, Ordering::SeqCst);
    force_foreground(&popup);
    let _ = app.emit_to(
        tauri::EventTarget::webview_window("update-popup"),
        "update-popup-shown",
        (),
    );
    Ok(())
}

/// 弹窗打开期间，用 Raw Input 监听全局鼠标按下：按在弹窗外面就把它收起来。
///
/// **为什么是这个方案**。前面几版依次试过、都栽了：
///   * 焦点类（弹窗失焦、主窗口失焦）——这台 RDP 会话里应用从未获得前台，
///     消息根本不来；
///   * 轮询前台窗口——前台恒为远程桌面客户端，判不出"用户走了"；
///   * 全局鼠标钩子（WH_MOUSE_LL）——回调跑在主线程上，里面做任何同步窗口操作都会
///     重入/自锁；取坐标还要和 Tauri 的异步布局抢时间，实测取到偏 40px 的矩形；
///     关闭后钩子没摘干净还会变成僵尸继续吞点击。
///
/// `RIDEV_INPUTSINK` 是 Windows 为"后台、无焦点也能收输入"设计的正规机制：
/// 系统在驱动层拿到鼠标动作后，往我们指定的窗口投一条普通的 `WM_INPUT` 消息。
/// 走的是正常消息队列，所以**不拦截系统消息链、不会被 LowLevelHooksTimeout 强杀、
/// 也不存在重入**；而且它不消费事件——点外面那一下照常传给底下的程序。
///
/// 判定坐标一律用**物理像素**：`GetCursorPos` 拿到的和 `DwmGetWindowAttribute`
/// 拿到的同属一套屏幕坐标，直接可比；不去碰 Tauri 的逻辑像素（DPI 缩放时会
/// 差一个系数，那正是之前"矩形偏移"的来源）。
#[cfg(target_os = "windows")]
fn watch_presses(popup: tauri::WebviewWindow) {
    use windows_sys::Win32::UI::Input::{
        RegisterRawInputDevices, RAWINPUTDEVICE, RIDEV_INPUTSINK,
    };

    let Ok(hwnd) = popup.hwnd() else {
        return;
    };
    // 子类过程里要关弹窗，得能拿到 app。
    let _ = SUBCLASS_APP.set(
        popup
            .app_handle()
            .clone(),
    );
    OPENED_AT.store(
        unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount() },
        Ordering::SeqCst,
    );

    // 挂子类过程接 WM_INPUT。用 SetWindowSubclass 而不是替换 WNDPROC：它可以叠加，
    // 不会把 Tauri 自己的窗口过程丢掉（丢掉会让整个窗口失灵）。
    unsafe {
        windows_sys::Win32::UI::Shell::SetWindowSubclass(
            hwnd.0 as *mut core::ffi::c_void,
            Some(press_subclass),
            0x4453_4831, // 子类 id，随便取一个不冲突的
            0,
        );
    }

    let device = RAWINPUTDEVICE {
        usUsagePage: 0x01, // Generic Desktop Controls
        usUsage: 0x02,     // Mouse
        dwFlags: RIDEV_INPUTSINK,
        // 目标窗口：消息投给它，而它不需要在前台。
        hwndTarget: hwnd.0 as *mut core::ffi::c_void,
    };
    let ok = unsafe {
        RegisterRawInputDevices(&device, 1, std::mem::size_of::<RAWINPUTDEVICE>() as u32)
    };
    if ok == 0 {
        eprintln!("dsh-desktop: raw input registration failed");
    }
}

/// 子类过程：只关心 `WM_INPUT`（Raw Input 的鼠标按键），其余原样交回。
///
/// 这里可以安全地做判断和隐藏——它跑在普通的窗口消息队列里，不是系统钩子回调，
/// 没有 LowLevelHooksTimeout 那一套，也不会像钩子那样在主线程上被强行插入执行。
#[cfg(target_os = "windows")]
unsafe extern "system" fn press_subclass(
    hwnd: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows_sys::Win32::UI::Input::{
        GetRawInputData, HRAWINPUT, RAWINPUT, RAWINPUTHEADER, RID_INPUT, RIM_TYPEMOUSE,
    };
    use windows_sys::Win32::UI::Shell::DefSubclassProc;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, RI_MOUSE_LEFT_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_DOWN, WM_INPUT,
    };

    if msg != WM_INPUT {
        return unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
    }

    // 打开弹窗的那一次点击也会走到这里。不等一下的话，弹窗会在显示的同一瞬间被
    // 自己关掉——这是前面几版都踩过的坑。
    let now = unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount() };
    if now.wrapping_sub(OPENED_AT.load(Ordering::SeqCst)) < 250 {
        return unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
    }

    // 取出这次输入事件，只看鼠标按键按下。
    let mut raw: RAWINPUT = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of::<RAWINPUT>() as u32;
    let header = std::mem::size_of::<RAWINPUTHEADER>() as u32;
    let read = unsafe {
        GetRawInputData(
            lparam as HRAWINPUT,
            RID_INPUT,
            &mut raw as *mut _ as *mut core::ffi::c_void,
            &mut size,
            header,
        )
    };
    if read == u32::MAX || raw.header.dwType != RIM_TYPEMOUSE {
        return unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
    }
    let flags = unsafe { raw.data.mouse.Anonymous.Anonymous.usButtonFlags } as u32;
    let pressed = flags & (RI_MOUSE_LEFT_BUTTON_DOWN | RI_MOUSE_RIGHT_BUTTON_DOWN);
    if pressed == 0 {
        return unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
    }

    // 坐标一律用物理像素：GetCursorPos 和 DWM 的边框同属一套屏幕坐标，直接可比。
    // 不去用 Tauri 的逻辑像素——DPI 缩放时两者差一个系数，那正是之前"矩形偏移"
    // 40px 的来源。
    let mut point = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut point) };

    let mut rect: RECT = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            &mut rect as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
    };
    // DWM 不给（比如旧系统）就退回 GetWindowRect：差一圈看不见的阴影边，但能用。
    if ok != 0 {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect(
                hwnd,
                &mut rect as *mut _,
            )
        };
    }

    let inside = point.x >= rect.left
        && point.y >= rect.top
        && point.x < rect.right
        && point.y < rect.bottom;
    if !inside {
        // 点在外面：收掉弹窗。这里不直接调 Tauri 的窗口 API（会派发回本线程），
        // 而是投一条消息让事件循环去处理，本回调立刻返回。
        if let Some(app) = SUBCLASS_APP.get() {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || hide_update_popup(&handle));
        }
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// 子类过程是裸函数指针、不能捕获环境，需要的东西放这儿。
#[cfg(target_os = "windows")]
static SUBCLASS_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// 打开弹窗的时刻（毫秒时间戳），用来忽略"打开它的那一次点击"。
/// 打开弹窗的点击本身也会经过子类过程，不挡住它，弹窗会在显示的同一瞬间被关掉。
#[cfg(target_os = "windows")]
static OPENED_AT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// 停止接收 Raw Input（弹窗关闭时调用）。
///
/// 不注销的话，弹窗关掉之后每条鼠标消息还会往一个已经隐藏的窗口投，白白唤醒事件
/// 循环——这正是上一版"钩子变僵尸"的教训。子类过程一并摘掉，让它彻底回到原样。
#[cfg(target_os = "windows")]
fn stop_watching_presses() {
    use windows_sys::Win32::UI::Input::{RegisterRawInputDevices, RAWINPUTDEVICE, RIDEV_REMOVE};
    let device = RAWINPUTDEVICE {
        usUsagePage: 0x01,
        usUsage: 0x02,
        dwFlags: RIDEV_REMOVE,
        hwndTarget: std::ptr::null_mut(),
    };
    unsafe { RegisterRawInputDevices(&device, 1, std::mem::size_of::<RAWINPUTDEVICE>() as u32) };
    // 摘子类。id 必须和挂上去时一致；找不到就说明本来没挂，不用管。
    if let Some(app) = SUBCLASS_APP.get() {
        if let Some(popup) = app.get_webview_window("update-popup") {
            if let Ok(hwnd) = popup.hwnd() {
                unsafe {
                    windows_sys::Win32::UI::Shell::RemoveWindowSubclass(
                        hwnd.0 as *mut core::ffi::c_void,
                        Some(press_subclass),
                        0x4453_4831,
                    );
                }
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn watch_presses(_popup: tauri::WebviewWindow) {}

#[cfg(not(target_os = "windows"))]
fn stop_watching_presses() {}

/// 让窗口不抢激活、但能接收鼠标（WS_EX_NOACTIVATE，系统菜单就是这么做的）。
///
/// 这个窗口是置顶 + 不在任务栏的，Windows 本来就不给它前台；强行要它激活会
/// 掉进一个死循环：拿到激活 → 立刻又被系统收回 → 收到"失活"消息 → 于是关掉
/// 自己。既然它不需要键盘（Escape 由页面处理），那就干脆不要激活权——不激活
/// 就没有失活，弹窗就不会自己消失。
#[cfg(target_os = "windows")]
fn make_non_activating(hwnd: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd as *mut core::ffi::c_void, GWL_EXSTYLE);
        SetWindowLongPtrW(
            hwnd as *mut core::ffi::c_void,
            GWL_EXSTYLE,
            ex | WS_EX_NOACTIVATE as isize,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn make_non_activating(_hwnd: isize) {}

/// Ask the window manager to make `window` the foreground window.
///
/// Best effort on purpose: `set_focus` is refused for a window that is topmost
/// and absent from the taskbar, and this is the direct equivalent. Nothing
/// depends on it succeeding — the dismissal path does not use focus.
#[cfg(target_os = "windows")]
fn force_foreground(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{BringWindowToTop, SetForegroundWindow};
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as *mut core::ffi::c_void;
    unsafe {
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
    }
}

#[cfg(not(target_os = "windows"))]
fn force_foreground(_window: &tauri::WebviewWindow) {}

/// Build the update popup window, hidden, so the first click only has to show it.
///
/// A window of its own rather than a layer in the shell page: the DSH UI is a
/// second, native webview placed over the shell's from the title bar down, so
/// anything the shell draws below the title bar is behind it. An always-on-top
/// window is above both, the same trick the tray menu uses.
fn prepare_update_popup(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("update-popup").is_some() {
        return Ok(());
    }
    let built = WebviewWindowBuilder::new(
        app,
        "update-popup",
        WebviewUrl::App("update-popup.html".into()),
    )
    .inner_size(POPUP_WIDTH, POPUP_HEIGHT)
    // Left non-resizable on purpose: the height follows the content, and a
    // window whose edges can be dragged would let the two disagree.
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .transparent(false)
    .build()
    .map_err(|e| format!("创建更新窗口失败: {e}"))?;

    // 透明渲染在软件合成下不可靠，所以窗口不透明、圆角交给区域裁剪。
    let frame = app.get_window("update-popup");
    // 置顶 + 不在任务栏的窗口本来就拿不到前台，所以干脆不要激活权：不激活就
    // 不会被"失活"消息波及，弹窗不会自己消失，主窗口的焦点也不会被打断。
    if let Ok(hwnd) = built.hwnd() {
        make_non_activating(hwnd.0 as isize);
    }
    if let Some(window) = &frame {
        apply_rounded_region_r(window, POPUP_RADIUS);
    }
    built.on_window_event(move |event| match event {
        // The popup is sized to its content, so its height changes as sections
        // open and notes appear. The rounded region is in window coordinates and
        // does not follow a resize on its own — without this the corners would
        // keep the old clip and cut into the content.
        WindowEvent::Resized(_) => {
            if let Some(window) = &frame {
                apply_rounded_region_r(window, POPUP_RADIUS);
            }
        }
        // Deliberately no blur handler. Closing on focus loss was the original
        // approach and it never worked — the window is topmost and taskbar-less,
        // so Windows does not activate it and it can be visible without ever
        // being focused. What it *did* do was close the popup on the focus
        // changes it does receive, which is what made it vanish right after
        // opening. Dismissal is the outside-press watch in show_update_popup.
        _ => {}
    });
    Ok(())
}

/// Size the popup to what it currently holds.
///
/// It is a fixed-size window that is usually mostly empty (collapsed sections,
/// no notes), and a panel that is taller than its content is both dead space and
/// — once the scroll container can scroll — a scrollbar for nothing. The page
/// measures its own card and calls this whenever that changes, so the window
/// hugs the content and only scrolls when it genuinely cannot fit.
///
/// Width is fixed, height is clamped: never below the smallest useful panel, and
/// never past the monitor's work area. Same main-thread rule as the open command.
#[tauri::command]
async fn resize_update_popup(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let Some(popup) = handle.get_webview_window("update-popup") else {
            return;
        };
        let scale = popup.scale_factor().unwrap_or(1.0);
        let max = popup
            .current_monitor()
            .ok()
            .flatten()
            .map(|monitor| (monitor.work_area().size.height as f64 / scale) - 140.0)
            .unwrap_or(640.0)
            .max(POPUP_MIN_HEIGHT);
        let height = height.clamp(POPUP_MIN_HEIGHT, max);
        // Skip the churn when it is already that size: set_size reports the same
        // logical size for a fractionally-scaled window slightly differently, and
        // a resize per measurement would be a loop.
        if let Ok(current) = popup.inner_size() {
            if (current.height as f64 / scale - height).abs() < 2.0 {
                return;
            }
        }
        let _ = popup.set_size(tauri::LogicalSize::new(POPUP_WIDTH, height));
    })
    .map_err(|e| e.to_string())
}

/// Logical size the tray menu is built at.
///
/// Named because the placement math needs a size before the window has ever been
/// shown; the window's own report is preferred when it is available.
const TRAY_MENU_WIDTH: f64 = 200.0;
const TRAY_MENU_HEIGHT: f64 = 186.0;

/// The primary monitor's work area in physical pixels — the screen minus the
/// taskbar and any other appbars — as `(left, top, right, bottom)`.
///
/// This asks Windows directly instead of going through the windowing library's
/// monitor list. The work area is exactly the rectangle "bottom-right, clear of
/// the taskbar" means, and unlike an enumerated monitor it cannot come back
/// empty in a remote session, which is what left the pet's first-run default
/// unpositioned and let Windows cascade it into the top-left corner.
#[cfg(windows)]
pub(crate) fn work_area() -> Option<(i32, i32, i32, i32)> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SystemParametersInfoW, SM_CXSCREEN, SM_CYSCREEN, SPI_GETWORKAREA,
    };

    let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            &mut rect as *mut RECT as *mut core::ffi::c_void,
            0,
        )
    };
    if ok != 0 && rect.right > rect.left && rect.bottom > rect.top {
        return Some((rect.left, rect.top, rect.right, rect.bottom));
    }
    // A session that reports no work area still has a screen. Plain metrics are
    // a worse answer than the work area but a far better one than giving up.
    let width = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    if width > 0 && height > 0 {
        return Some((0, 0, width, height));
    }
    None
}

#[cfg(not(windows))]
pub(crate) fn work_area() -> Option<(i32, i32, i32, i32)> {
    None
}

/// The tray menu's visible size in physical pixels.
fn tray_menu_inner_size(app: &tauri::AppHandle) -> (i32, i32) {
    let Some(window) = app.get_webview_window("tray-menu") else {
        return (TRAY_MENU_WIDTH as i32, TRAY_MENU_HEIGHT as i32);
    };
    match (window.inner_size(), window.scale_factor()) {
        (Ok(size), _) if size.width > 0 => (size.width as i32, size.height as i32),
        (_, Ok(scale)) => (
            (TRAY_MENU_WIDTH * scale).round() as i32,
            (TRAY_MENU_HEIGHT * scale).round() as i32,
        ),
        _ => (TRAY_MENU_WIDTH as i32, TRAY_MENU_HEIGHT as i32),
    }
}

/// Create the tray menu window if it does not exist yet, hidden.
///
/// Pre-created at startup for the same reason the update popup and the pet are —
/// a webview build is a visible pause — but here it is not only about latency.
/// Building a webview dispatches to the main thread and waits for it, and both
/// callers of the menu (the tray icon's event handler and the pet's own menu
/// command) already run on that thread. Building it from either one deadlocks
/// the app instead of showing a menu, which is exactly what happened.
fn prepare_tray_menu(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = app.get_webview_window("tray-menu") {
        return Ok(existing);
    }
    WebviewWindowBuilder::new(app, "tray-menu", WebviewUrl::App("tray-menu.html".into()))
        // Height fits four rows (显示/隐藏宠物 added later); the menu is
        // clipped rather than scrolled, so a short window silently hides the
        // last entry.
        .inner_size(TRAY_MENU_WIDTH, TRAY_MENU_HEIGHT)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .transparent(true)
        .build()
}

/// Move a small card window so its **visible** rectangle sits at `(x, y)`, pulled
/// back inside the work area.
///
/// Clamps the visible rectangle rather than the window rectangle: these windows
/// carry an invisible resize frame (8px per side here, plus 1px at the top), so
/// clamping the frame leaves the card hanging over the screen edge by exactly
/// that much — which is what the first version of the tray menu placement did.
fn place_card(window: &WebviewWindow, x: i32, y: i32, width: i32, height: i32) {
    let (frame_x, frame_y) = match (window.outer_position(), window.inner_position()) {
        (Ok(outer), Ok(inner)) => (inner.x - outer.x, inner.y - outer.y),
        _ => (0, 0),
    };
    let (inner_x, inner_y) = match work_area() {
        Some((left, top, right, bottom)) => (
            x.clamp(left, (right - width).max(left)),
            y.clamp(top, (bottom - height).max(top)),
        ),
        None => (x, y),
    };
    let _ = window.set_position(PhysicalPosition::new(inner_x - frame_x, inner_y - frame_y));
}

/// Show the custom tray menu popup near the tray icon or the pet.
///
/// `x`/`y` are the desired position of the menu's **visible** top-left, in
/// physical screen pixels — matching what [`work_area`] and the window APIs
/// report, so no scale factor enters the arithmetic.
///
/// Deliberately never builds the window: see [`prepare_tray_menu`]. If it is
/// missing the menu is skipped and logged, because a missing menu is a nuisance
/// while a deadlocked shell is a lost session.
fn show_tray_menu(app: &tauri::AppHandle, x: i32, y: i32) {
    let Some(menu_window) = app.get_webview_window("tray-menu") else {
        eprintln!("dsh-desktop: tray menu window is missing; not building it from here");
        return;
    };
    let (width, height) = tray_menu_inner_size(app);
    place_card(&menu_window, x, y, width, height);
    let _ = menu_window.show();
    let _ = menu_window.set_focus();
}

/// Attach the DSH web UI as a child WebView of the main window, full-width below
/// the title bar (rounded corners come from the window region, which clips the
/// child webview too). The theme-observer script is injected so the shell
/// follows the DSH theme.
fn attach_content_webview(app: &tauri::AppHandle, url: Url, bridge: &Bridge) -> tauri::Result<()> {
    // 窗口级 API：加了子 webview 后 get_webview_window("main") 会因
    // is_webview_window() 判定失败而返回 None（窗口仍在）。
    let Some(window) = app.get_window("main") else {
        return Ok(());
    };
    // 幂等：已挂载过就不再重复。
    if window.webviews().iter().any(|w| w.label() == "content") {
        return Ok(());
    }

    let init_script = format!(
        "{}\n{}",
        bridge.theme_observer_script(),
        bridge.plugin_proxy_script()
    );
    // 克隆一份 app 句柄给 on_new_window 闭包使用：window.open(url) 触发时，
    // 需要靠它拿到 content webview 并 navigate(url)，把外部新窗口请求重定向
    // 回当前 WebView，而不是让 WebView2 委托给系统浏览器。
    let app_for_new_window = app.clone();
    let builder = WebviewBuilder::new("content", WebviewUrl::External(url))
        // 白色背景：DSH 页面布局瞬间未铺满时，露出的底色与浅色页面一致
        .background_color(Color(255, 255, 255, 255))
        .initialization_script(&init_script)
        // 导航白名单：只放行 loopback（127.0.0.1 / localhost）与 about:blank，
        // 其余一律取消。防止 DSH 页面被劫持或跳到外部域脱离 WebView。
        .on_navigation(|nav_url| is_loopback_or_blank(nav_url))
        // 新窗口拦截：DSH 页面里任何 window.open(url) 都不再委托给系统浏览器，
        // 而是把 url 重定向回当前 content webview 导航过去，并拒绝弹新窗口。
        // 这样既能拦住“启动即弹系统浏览器”，又不破坏页面内部的跳转意图。
        .on_new_window(move |opened_url, _features| {
            // 只处理 loopback 目标：把它导航回当前 content webview。
            // 外部域直接 Deny，不在 WebView 内跳转，避免被钓鱼/劫持。
            if is_loopback_or_blank(&opened_url) {
                if let Some(content) = app_for_new_window.get_webview("content") {
                    let _ = content.navigate(opened_url);
                }
            }
            NewWindowResponse::Deny
        });

    let child = window.add_child(
        builder,
        LogicalPosition::new(0.0, TITLEBAR_HEIGHT),
        LogicalSize::new(800.0, 600.0),
    )?;

    // 圆角裁剪：窗口区域裁成圆角矩形（连带裁剪子 WebView 的方角），
    // 页面因此可以全宽铺满，不再需要左右内缩。
    apply_rounded_region(&window);

    // 初始摆放：Resized 事件只在尺寸变化时触发，创建后尺寸不变的话
    // 永远不会收到，因此必须主动按当前窗口大小放置一次。
    if let Ok(size) = window.inner_size() {
        let w = size.width as f64;
        let h = size.height as f64 - TITLEBAR_HEIGHT;
        if w > 0.0 && h > 0.0 {
            let _ = child.set_position(LogicalPosition::new(0.0, TITLEBAR_HEIGHT));
            let _ = child.set_size(LogicalSize::new(w, h));
        }
    }

    // 克隆句柄供闭包使用（&self 接收者借用与闭包 move 冲突）
    let window_handle = window.clone();
    window.on_window_event(move |event| {
        match event {
            WindowEvent::Resized(size) => {
                apply_rounded_region(&window_handle);
                let w = size.width as f64;
                let h = size.height as f64 - TITLEBAR_HEIGHT;
                if w > 0.0 && h > 0.0 {
                    let _ = child.set_position(LogicalPosition::new(0.0, TITLEBAR_HEIGHT));
                    let _ = child.set_size(LogicalSize::new(w, h));
                }
            }
            // 主窗口失去焦点。这是"用户切到别的程序"能拿到的最早信号：系统在切换
            // 的同一刻就送出来，比轮询快一个数量级（实测切换与消息之间只有毫秒）。
            //
            // 光有消息不够——启动阶段、应用内部换窗口也会让它响。所以收到消息后
            // 立刻同步问一句"现在前台是谁"，答案不是我们这个进程才关。两个条件都
            // 满足才动手，整个判断在同一瞬间完成，不需要等任何周期。
            // 主窗口失去焦点 = 用户切到别的程序。系统在切换的同一刻就把这条消息
            // 送出来，所以它比轮询快一个数量级，是这里的主路径。
            //
            // 只收到消息还不够：启动阶段、应用内部换窗口也会让它响。所以收到后
            // 立刻同步问一句"现在前台是谁"，答案不是我们这个进程才关。两步都在
            // 同一瞬间完成，不等待任何周期。
            // 这里**刻意不处理**失焦。实测：这台环境里应用从未获得前台（前台恒为
            // 远程桌面客户端），点 Edge、点桌面都不会让主窗口收到失焦消息，点弹窗
            // 外面这件事只能靠鼠标钩子（见 watch_presses）。
            _ => {}
            _ => {}
        }
    });
    Ok(())
}

/// 判断一个 URL 是否应该被 content webview 放行：
/// `127.0.0.1` / `localhost`（DSH 自己的 web UI 与其内部跳转）
/// 与 `about:blank`（WebView2 临时文档）一律放行；其余全部拒绝。
/// 防止页面被劫持或跳到外部域脱离 WebView、以及 window.open 弹系统浏览器。
fn is_loopback_or_blank(url: &Url) -> bool {
    if url.scheme() == "about" {
        return true;
    }
    match url.host_str() {
        Some("127.0.0.1") | Some("localhost") | Some("::1") => true,
        _ => false,
    }
}

/// 用圆角窗口区域裁剪窗口（含子 WebView），实现四角圆角。
/// 最大化时跳过：最大化过程中 inner_size 可能返回过渡尺寸，
/// 按错尺寸裁剪会把窗口裁出一圈"桌面黑边"；最大化圆角交给系统处理。
#[cfg(target_os = "windows")]
fn apply_rounded_region_r(window: &tauri::Window, radius: f64) {
    use windows_sys::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
    // 最大化时：清除旧区域（还原态的圆角区域若残留会把最大化窗口裁成小块），
    // 最大化圆角交给系统处理。
    if window.is_maximized().unwrap_or(false) {
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                SetWindowRgn(hwnd.0 as *mut core::ffi::c_void, std::ptr::null_mut(), 1);
            }
        }
        return;
    }
    if let Ok(size) = window.inner_size() {
        let w = size.width as i32;
        let h = size.height as i32;
        // 尺寸无效或过小时跳过：隐藏/最小化窗口可能报告 160x28 之类的尺寸，
        // 此时建区域会把窗口裁没。
        if w < 100 || h < 100 {
            eprintln!("dsh-desktop: skip region (suspicious size {w}x{h})");
            return;
        }
        // 区域是按窗口坐标裁的，而 inner_size 量的是客户区：Windows 上两者
        // 左上角并不重合（无边框窗口也带一圈非客户区，系统会把它画成灰边）。
        // 不加这个偏移，区域就会把左边/上边的灰边留在可见范围里、又把右边/
        // 下边的页面裁掉一截。
        let frame = match (window.outer_position(), window.inner_position()) {
            (Ok(outer), Ok(inner)) => (inner.x - outer.x, inner.y - outer.y),
            _ => (0, 0),
        };
        let r = radius as i32 * 2; // 椭圆直径 = 2 × 半径
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        unsafe {
            let rgn = CreateRoundRectRgn(
                frame.0,
                frame.1,
                frame.0 + w + 1,
                frame.1 + h + 1,
                r,
                r,
            );
            if !rgn.is_null() {
                SetWindowRgn(hwnd.0 as *mut core::ffi::c_void, rgn, 1);
                eprintln!("dsh-desktop: rounded region applied ({w}x{h}, r={r}, +{},{})", frame.0, frame.1);
            } else {
                eprintln!("dsh-desktop: CreateRoundRectRgn failed");
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn apply_rounded_region(window: &tauri::Window) {
    apply_rounded_region_r(window, CORNER_RADIUS);
}

#[cfg(not(target_os = "windows"))]
fn apply_rounded_region(_window: &tauri::Window) {}

#[cfg(not(target_os = "windows"))]
fn apply_rounded_region_r(_window: &tauri::Window, _radius: f64) {}

fn push_log(state: &SharedState, line: String) {
    let mut s = state.lock().unwrap();
    s.log.push(line);
    if s.log.len() > 200 {
        let excess = s.log.len() - 200;
        s.log.drain(0..excess);
    }
}

fn fail(state: &SharedState, handle: &tauri::AppHandle, message: String) {
    {
        let mut s = state.lock().unwrap();
        s.error = Some(message.clone());
    }
    let _ = handle.emit("launch-error", json!({ "message": message }));
}

fn set_step(state: &SharedState, handle: &tauri::AppHandle, index: i32, label: &str) {
    {
        let mut s = state.lock().unwrap();
        s.step = index;
        s.label = label.to_string();
    }
    let _ = handle.emit("splash-step", json!({ "index": index, "label": label }));
}

/// The launch sequence: detect → attach/spawn → ready → enter.
fn start_launch(
    handle: tauri::AppHandle,
    state: SharedState,
    host_slot: SharedHost,
    guard: Arc<AtomicBool>,
    bridge: Arc<Bridge>,
) {
    guard.store(true, Ordering::SeqCst);
    std::thread::spawn(move || {
        // 1. 检测运行环境（node / npm / pnpm / dsh / 依赖）
        set_step(&state, &handle, 0, "检测运行环境");
        let mut snapshot: EnvironmentSnapshot = discover();
        push_log(
            &state,
            format!(
                "检测: node={} npm={} pnpm={} dsh={} 依赖={} 来源={}",
                snapshot.node.as_deref().unwrap_or("缺失"),
                snapshot.npm_cli.as_deref().unwrap_or("缺失"),
                snapshot.pnpm_cjs.as_deref().unwrap_or("缺失"),
                snapshot.cli.as_deref().unwrap_or("缺失"),
                if snapshot.deps_ok { "完整" } else { "缺失" },
                snapshot.source,
            ),
        );

        // 1.5 缺失组件 → 真实自动安装
        if !snapshot.missing.is_empty() {
            set_step(&state, &handle, 1, "安装缺失组件");
            if let Err(message) = provision(&mut snapshot, &|line| push_log(&state, line)) {
                fail(&state, &handle, format!("自动安装失败: {message}"));
                guard.store(false, Ordering::SeqCst);
                return;
            }
            push_log(
                &state,
                format!(
                    "安装完成: node={} pnpm={} dsh={} 依赖={}",
                    snapshot.node.as_deref().unwrap_or("-"),
                    snapshot.pnpm_cjs.as_deref().unwrap_or("-"),
                    snapshot.cli.as_deref().unwrap_or("-"),
                    if snapshot.deps_ok { "完整" } else { "缺失" },
                ),
            );
        }
        if let Some(error) = &snapshot.error {
            fail(&state, &handle, format!("{error}（来源: {}）", snapshot.source));
            guard.store(false, Ordering::SeqCst);
            return;
        }
        push_log(
            &state,
            format!(
                "检测通过: node={} cli={} home={}",
                snapshot.node.as_deref().unwrap_or("-"),
                snapshot.cli.as_deref().unwrap_or("-"),
                snapshot.dsh_home.as_deref().unwrap_or("-"),
            ),
        );
        // 步骤节奏：检测步骤展示约 1 秒
        std::thread::sleep(Duration::from_millis(1000));

        // 2a. 附着已运行实例
        let mut attached_port: Option<u16> = None;
        for port in ATTACH_PORTS {
            if probe_existing(port) {
                attached_port = Some(port);
                break;
            }
        }
        if let Some(port) = attached_port {
            set_step(&state, &handle, 1, "检测到运行中的实例");
            push_log(&state, format!("附着已运行的 host: http://127.0.0.1:{port}"));
            {
                let mut s = state.lock().unwrap();
                s.attached = true;
            }
            // 步骤节奏：每步最短展示时间，避免动画瞬间闪完
            std::thread::sleep(Duration::from_millis(900));
            // 3. 就绪
            set_step(&state, &handle, 2, "连接就绪");
            std::thread::sleep(Duration::from_millis(800));
            let url = format!("http://127.0.0.1:{port}");
            {
                let mut s = state.lock().unwrap();
                s.port = Some(port);
                s.url = Some(url.clone());
                s.done = true;
                s.step = 3;
            }
            finish_launch(&handle, &state, &url, &bridge);
            guard.store(false, Ordering::SeqCst);
            return;
        }

        // 2b. 启动 host
        set_step(&state, &handle, 1, "启动 DeepSeek Harness");
        let port_arg = None; // M1/M2: OS-assigned port via --port 0
        let mut process = match HostProcess::spawn(&snapshot, port_arg) {
            Ok(process) => process,
            Err(message) => {
                fail(&state, &handle, format!("启动失败: {message}"));
                guard.store(false, Ordering::SeqCst);
                return;
            }
        };
        push_log(&state, format!("host 进程已启动 (pid={})", process.pid().unwrap_or(0)));

        // 3. 等待就绪
        set_step(&state, &handle, 2, "等待服务就绪");
        let mut ready_url: Option<String> = None;
        let deadline = std::time::Instant::now() + BOOT_TIMEOUT;
        loop {
            match process.wait_event(Duration::from_millis(500)) {
                Ok(HostEvent::Ready(line)) => {
                    // `dsh web: http://127.0.0.1:<port>`
                    if let Some(start) = line.find("http://") {
                        let url = line[start..].trim().to_string();
                        push_log(&state, format!("就绪: {url}"));
                        ready_url = Some(url);
                        break;
                    }
                }
                Ok(HostEvent::Log(line)) => push_log(&state, line),
                // A silent poll is the normal case: the host prints nothing at
                // all until its readiness line (~5s). Only an exited process or
                // the real deadline below ends the wait — failing here made
                // BOOT_TIMEOUT dead code and gave up after 500ms.
                Err(()) => {
                    if let Some(message) = check_exited(&mut process) {
                        fail(&state, &handle, message);
                        guard.store(false, Ordering::SeqCst);
                        return;
                    }
                    // The channel also reports Err once both readers hit EOF,
                    // which returns instantly; don't spin on it.
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            if std::time::Instant::now() >= deadline {
                fail(&state, &handle, "启动超时：未在预期时间内就绪（查看日志）".into());
                guard.store(false, Ordering::SeqCst);
                return;
            }
        }

        let Some(url) = ready_url else {
            fail(&state, &handle, "未解析到服务地址".into());
            guard.store(false, Ordering::SeqCst);
            return;
        };

        // 健康检查（短暂重试，等待 HTTP 真正可服务）
        let mut healthy = false;
        for _ in 0..10 {
            if http_get_ok(&url) {
                healthy = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        if !healthy {
            fail(&state, &handle, format!("服务未通过健康检查: {url}"));
            guard.store(false, Ordering::SeqCst);
            return;
        }

        let port = url
            .trim_end_matches('/')
            .rsplit(':')
            .next()
            .and_then(|p| p.parse::<u16>().ok());
        set_step(&state, &handle, 2, "连接就绪");
        {
            let mut s = state.lock().unwrap();
            s.port = port;
            s.url = Some(url.clone());
            s.done = true;
            s.step = 3;
        }

        // 移交进程给退出清理（此后本线程不再借用）。
        {
            let mut slot = host_slot.lock().unwrap();
            *slot = Some(process);
        }

        finish_launch(&handle, &state, &url, &bridge);
        guard.store(false, Ordering::SeqCst);
    });
}

/// Delete the auth cookies left behind by previous launches.
///
/// The DSH host authenticates its web UI with a cookie named for the launch's
/// token — `dsh-auth-<token>` — and gives it a 30-day life. Nothing ever removes
/// them, so every launch adds another ~173 bytes to the `Cookie` header of every
/// request this webview makes. Chromium refuses to *send* a request whose headers
/// exceed roughly 2 KB, and its own baseline headers already use most of that, so
/// after enough restarts the app's own page fails with `431 Request Header Fields
/// Too Large` before a line of it runs. Measured here: **69 cookies, ~15.6 KB**,
/// and a page that would not load at all.
///
/// Only this launch's cookie is kept. Every cookie in this webview is one of
/// these — 69 of 69 when this was written — so there is nothing else to preserve,
/// and keeping the current one matters because the page's own API calls rely on it.
///
/// Must run **before** the content webview makes its first request, and on a
/// thread that is not a synchronous command or an event handler: Tauri documents
/// these cookie calls as deadlocking in those contexts on Windows. The caller
/// joins the thread rather than firing and forgetting, because the request that
/// fails is the very next one.
fn prune_stale_auth_cookies(window: &WebviewWindow, origin: &str, keep_token: &str) -> usize {
    let Ok(url) = Url::parse(origin) else { return 0 };
    let Ok(cookies) = window.cookies_for_url(url) else { return 0 };
    let keep = format!("dsh-auth-{keep_token}");
    let mut removed = 0usize;
    for cookie in cookies {
        if !cookie.name().starts_with("dsh-auth-") || cookie.name() == keep {
            continue;
        }
        if window.delete_cookie(cookie).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// The `token` query value from the host's readiness URL, if present.
fn token_of(url: &str) -> Option<&str> {
    let rest = url.split_once("token=")?.1;
    let token = rest.split(['&', '#']).next()?;
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

fn check_exited(process: &mut HostProcess) -> Option<String> {
    if process.is_alive() {
        return None;
    }
    let tail = {
        // Best effort: last lines were pushed to state via the other path; here we
        // only know the process died.
        String::new()
    };
    Some(format!("host 进程意外退出{tail}"))
}

/// Everything is ready: notify the UI, attach the DSH webview, enter the main window.
fn finish_launch(handle: &tauri::AppHandle, state: &SharedState, url: &str, bridge: &Bridge) {
    let _ = handle.emit("splash-done", json!({}));
    {
        let s = state.lock().unwrap();
        let _ = handle.emit(
            "host-status",
            json!({
                "status": "running",
                "port": s.port,
                "url": s.url,
                "attached": s.attached,
            }),
        );
    }
    // "就绪"状态停留一下再关闭 splash（DSH_SPLASH_HOLD_MS 可调，默认 1200ms）
    let hold_ms = std::env::var("DSH_SPLASH_HOLD_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(1200);
    std::thread::sleep(Duration::from_millis(hold_ms));
    // 时序：splash 动画播完 → splash 完全消失 → 停顿 → 显示壳界面并立即挂载 DSH。
    // 1. splash 关闭（完全消失）
    if let Some(splash) = handle.get_window("splash") {
        let _ = splash.close();
    }
    // 2. 停顿（动画消失与界面出现之间的间隙）
    let pause_ms = std::env::var("DSH_TRANSITION_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(600);
    std::thread::sleep(Duration::from_millis(pause_ms));
    // 3. 显示壳界面（恢复尺寸位置）
    if let Some(main) = handle.get_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_size(LogicalSize::new(1280.0, 820.0));
        let _ = main.set_position(LogicalPosition::new(200.0, 100.0));
        let _ = main.set_focus();
    }
    // 4. 立即挂载 DSH（子控制器在可见窗口上初始化）
    //
    // 挂载之前先清掉历史登录 cookie，而且要等它做完：会撞上 431 的正是子
    // webview 的第一个请求，清理晚一步就没有意义。见 prune_stale_auth_cookies。
    if let Some(token) = token_of(url) {
        if let Some(main_webview) = handle.get_webview_window("main") {
            let origin = origin_of(url).unwrap_or_else(|| url.to_string());
            let token = token.to_string();
            let removed = std::thread::spawn(move || {
                prune_stale_auth_cookies(&main_webview, &origin, &token)
            })
            .join()
            .unwrap_or(0);
            if removed > 0 {
                eprintln!("dsh-desktop: 清理了 {removed} 个上次启动留下的登录 cookie");
            }
        }
    }
    if let Ok(parsed) = url.parse::<Url>() {
        if let Err(error) = attach_content_webview(handle, parsed, bridge) {
            eprintln!("dsh-desktop: attach content webview failed: {error}");
        }
    }
    // 5. 兜底恢复一次
    if let Some(main) = handle.get_window("main") {
        let _ = main.unminimize();
        let _ = main.set_size(LogicalSize::new(1280.0, 820.0));
        let _ = main.set_position(LogicalPosition::new(200.0, 100.0));
        let _ = main.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_launch_state,
            get_desktop_plugins,
            get_settings,
            set_close_to_tray,
            set_auto_start,
            set_workspace_folder,
            set_harness_channel,
            get_theme,
            get_app_version,
            open_update_popup,
            close_update_popup,
            resize_update_popup,
            check_updates,
            install_harness_update,
            download_client_update,
            install_client_update,
            restart_app,
            export_diagnostics,
            drain_host_log,
            get_installed_plugins,
            uninstall_plugin,
            list_directory,
            finish_splash,
            show_main_window,
            set_pet_visible,
            pet_visible,
            pet_save_position,
            show_pet_menu,
            show_pet_bubble,
            hide_pet_bubble,
            pet_session_state,
            pet_sessions,
            pet_select_session,
            pet_send_prompt,
            pet_add_files,
            pet_queue,
            pet_remove_file,
            pet_clear_files,
            open_settings,
            quit_app,
            retry_launch
        ])
        .setup(|app| {
            let state: SharedState = Arc::new(Mutex::new(LaunchState::default()));
            let host: SharedHost = Arc::new(Mutex::new(None));
            let guard = Arc::new(AtomicBool::new(false));
            let settings_state = Arc::new(Mutex::new(settings::load()));
            let quitting = Arc::new(AtomicBool::new(false));
            let report_cache = update::new_shared_report();
            app.manage(state.clone());
            app.manage(host.clone());
            app.manage(guard.clone());
            app.manage(settings_state.clone());
            app.manage(quitting.clone());
            app.manage(report_cache);
            app.manage(update::new_shared_shell_download());

            // 桌面插件目录：插件像 U 盘一样放入该目录即可被扫描。解析规则见
            // `store::plugins_root`（开发用仓库根，打包用 APPDATA）——插件商店
            // 必须与这里指向同一个目录，所以两边共用同一个函数。
            let plugins_root = store::plugins_root();
            let plugins = Arc::new(PluginManager::new(plugins_root.clone(), String::new()));
            eprintln!("dsh-desktop: plugins_root={}", plugins_root.display());

            // 后端 overlay 必须指向 host 实际使用的 DSH_HOME。discover() 读
            // dsh-launch.json 的 dshHome 字段(优先级最高,host.rs 也用它设 DSH_HOME
            // 并作为 --patch 的基目录),所以这里直接复用 discover 的解析结果,
            // 而不是另起一套 env→APPDATA 回退——否则 write_native_disable 会写进
            // 回退目录而 host 的 watchUserPatches 看的是另一份,两边永远对不上。
            let snapshot = discover();
            let dsh_home = snapshot
                .dsh_home
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::var("DSH_HOME")
                        .map(PathBuf::from)
                        .unwrap_or_else(|_| {
                            std::env::var("APPDATA")
                                .map(|appdata| {
                                    PathBuf::from(appdata)
                                        .join("DeepSeek Harness")
                                        .join("dsh-home")
                                })
                                .unwrap_or_else(|_| PathBuf::from("dsh-home"))
                        })
                });
            eprintln!(
                "dsh-desktop: backend home={} (discover source={})",
                dsh_home.display(),
                snapshot.source
            );
            plugins.set_backend_home(dsh_home, "web".into());

            // 本地主题桥 + 插件桥：注入脚本把 DSH 页面的主题快照上报到这里，
            // 再以 Tauri 事件转发给壳页面与启动动画；插件状态/插件 bundle 也由
            // 同一个回环 HTTP 服务提供。
            let handle = app.handle().clone();
            // 按在 DSH 内容区时把更新弹窗关掉。那个页面是独立的子 webview，
            // 壳页面收不到它的点击；弹窗自己又是刻意不抢激活的（见
            // make_non_activating），所以也不会因为焦点变化而收到通知。这条
            // 回环上报是唯一能看到"用户点了 DSH 界面"的地方。
            let press_handle = app.handle().clone();
            let bridge = bridge::start(
                move |snapshot| {
                    let _ = handle.emit("theme-changed", snapshot);
                },
                plugins.clone(),
                move || hide_update_popup(&press_handle),
            )
            .map_err(|e| format!("bridge 启动失败: {e}"))?;
            plugins.set_bridge_base(bridge.base_url.clone());
            let bridge = Arc::new(bridge);
            app.manage(bridge.clone());

            // 插件目录轮询（1s）：新增/删除/改代码都会反映到 `/plugins/state`。
            // 前端代理层据此更新 graph row 并把变更推给 `@dsh-desktop/hmr`
            // 插件，由它在 cordis 里换 fiber，完成免刷新热更新。
            plugins.clone().start_watcher();

            // splash 窗口：不透明 + 圆角区域裁剪（透明渲染在软件合成下不可靠）。
            if let Some(splash) = app.get_window("splash") {
                apply_rounded_region_r(&splash, 18.0);
            }

            // 托盘图标：左键显示主窗口；右键弹出自定义 UI 菜单（不再是系统原生菜单）。
            let tray = TrayIconBuilder::with_id("main-tray")
                .icon(
                    app.default_window_icon()
                        .ok_or("缺少应用图标")?
                        .clone(),
                )
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button,
                        button_state,
                        rect,
                        ..
                    } = event
                    {
                        if button == tauri::tray::MouseButton::Right
                            && button_state == tauri::tray::MouseButtonState::Up
                        {
                            // The tray rect arrives in either unit depending on
                            // platform, and the menu is placed in physical
                            // pixels. Mixing the two puts the menu in the wrong
                            // place on any scaled display.
                            let (x, y) = match rect.position {
                                tauri::Position::Physical(p) => (p.x, p.y),
                                tauri::Position::Logical(p) => {
                                    let scale = tray
                                        .app_handle()
                                        .primary_monitor()
                                        .ok()
                                        .flatten()
                                        .map(|m| m.scale_factor())
                                        .unwrap_or(1.0);
                                    ((p.x * scale).round() as i32, (p.y * scale).round() as i32)
                                }
                            };
                            show_tray_menu(tray.app_handle(), x, y);
                        } else if button == tauri::tray::MouseButton::Left
                            && button_state == tauri::tray::MouseButtonState::Up
                        {
                            if let Some(win) = tray.app_handle().get_window("main") {
                                let _ = win.show();
                                let _ = win.unminimize();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)
                .map_err(|e| format!("托盘创建失败: {e}"))?;
            app.manage(tray);

            // 更新弹窗在这里就建好（隐藏），别等第一次点击再建：那一次点击会
            // 付掉整个 webview 构建 + 页面加载 + React 挂载的代价，开发模式下
            // 模块是逐个请求的，能卡好几秒。
            if let Err(error) = prepare_update_popup(app.handle()) {
                eprintln!("dsh-desktop: prepare update popup failed: {error}");
            }

            // 宠物窗口同样先建好（隐藏）。它比更新弹窗更值得预热：宠物是用户
            // 在"关掉主窗口"那一刻要的东西，而那正是最不该等两秒的时候。
            if let Err(error) = pet::prepare(app.handle()) {
                eprintln!("dsh-desktop: prepare pet failed: {error}");
            }
            if pet::load().enabled {
                if let Err(error) = pet::show(app.handle()) {
                    eprintln!("dsh-desktop: restore pet failed: {error}");
                }
            }

            // 托盘菜单也先建好。这里不只是为了快：建 webview 会派发到主线程并
            // 等待，而菜单的两个入口（托盘图标事件、宠物自己的菜单命令）本来
            // 就跑在主线程上——在里面建窗口会把整个应用锁死，而不是弹出一个菜单。
            if let Err(error) = prepare_tray_menu(app.handle()) {
                eprintln!("dsh-desktop: prepare tray menu failed: {error}");
            }
            // 宠物的气泡同理：它在一次**点击**里打开，而那正是最不该等建 webview
            // 的时候。
            if let Err(error) = prepare_pet_bubble(app.handle()) {
                eprintln!("dsh-desktop: prepare pet bubble failed: {error}");
            }
            // 上次没发出去的文件还在队列里——先读回来，并顺手丢掉已经被移动或删除的
            // 那些（留着只会让"发送"以一个用户看不到的文件为由失败）。
            pet_files::load();

            // 关闭主窗口时：若开启“关闭到托盘”，则隐藏而不是退出。
            if let Some(main) = app.get_window("main") {
                let settings_state = settings_state.clone();
                let quitting = quitting.clone();
                let main_handle = main.clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        // Two reasons to survive a close: the user asked for
                        // close-to-tray, or the pet is on — and a pet on the
                        // desktop with its window gone is the whole point of the
                        // feature, so quitting here would take it away at the
                        // exact moment it was wanted.
                        let to_tray = settings_state.lock().unwrap().close_to_tray || pet::load().enabled;
                        if to_tray && !quitting.load(Ordering::SeqCst) {
                            api.prevent_close();
                            let _ = main_handle.hide();
                        }
                    }
                });
            }

            // 宠物被拖动之后把新位置记下来。用 Moved 而不是在页面里算：位置是
            // 窗口的属性，OS 拖动结束时会报到这个事件，而页面在拖动过程中收不
            // 到任何回调。
            if let Some(pet_window) = app.get_webview_window(pet::PET_LABEL) {
                let pet_handle = app.handle().clone();
                pet_window.on_window_event(move |event| {
                    match event {
                        WindowEvent::Moved(_) => pet::remember_position(&pet_handle),
                        // Files dropped on the pet. This arrives in Rust rather
                        // than in the page because the window is transparent and
                        // 132px wide: a drop target that small is easier to get
                        // right at the window level, and it keeps working when
                        // the page is busy re-rendering the pet's face.
                        WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                            let paths: Vec<String> = paths
                                .iter()
                                .map(|p| p.to_string_lossy().into_owned())
                                .collect();
                            let view = pet_files::add(&paths);
                            emit_queue(&pet_handle, &view);
                            let _ = pet_handle.emit("pet-drag", false);
                        }
                        // A 132px target needs to say it noticed the drag, or
                        // the gesture feels like aiming at nothing.
                        WindowEvent::DragDrop(tauri::DragDropEvent::Enter { .. }) => {
                            let _ = pet_handle.emit("pet-drag", true);
                        }
                        WindowEvent::DragDrop(tauri::DragDropEvent::Leave) => {
                            let _ = pet_handle.emit("pet-drag", false);
                        }
                        _ => {}
                    }
                });
            }

            let handle = app.handle().clone();
            start_launch(handle, state, host, guard, bridge);
            start_pet_state_watch(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building dsh-desktop")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // 退出前把宠物位置落盘：拖动结束后的延迟保存可能还没触发，而
                // 这是最后一次能读到窗口位置的机会。
                pet::remember_position_now(app);
                // 退出时清理我们 spawn 的 host 进程树。
                if let Some(slot) = app.try_state::<SharedHost>() {
                    if let Some(mut process) = slot.lock().unwrap().take() {
                        process.kill();
                    }
                }
            }
        });
}
