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
    Emitter, LogicalPosition, LogicalSize, Manager, RunEvent, Url, WebviewBuilder, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
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
    app.run_on_main_thread(move || {
        if let Some(popup) = handle.get_webview_window("update-popup") {
            if popup.is_visible().unwrap_or(false) {
                let _ = popup.hide();
            }
        }
    })
    .map_err(|e| e.to_string())
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

/// Show the update popup under the version chip.
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
    // The chip toggles: a second click closes it. The window also hides itself
    // when it loses focus, but a toggle that does not depend on focus events is
    // what makes the chip's behaviour predictable.
    if popup.is_visible().unwrap_or(false) {
        let _ = popup.hide();
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
    force_foreground(&popup);
    let _ = app.emit_to(
        tauri::EventTarget::webview_window("update-popup"),
        "update-popup-shown",
        (),
    );
    Ok(())
}

/// 让窗口不抢激活、但能接收鼠标（WS_EX_NOACTIVATE，系统菜单就是这么做的）。
///
/// 这个窗口是置顶 + 不在任务栏的，Windows 本来就不给它前台；强行要它激活会
/// 掉进一个死循环：拿到激活 → 立刻又被系统收回 → 收到"失活"消息 → 于是关掉
/// 自己。既然它不需要键盘（Escape 由页面处理），那就干脆不要激活权——不激活
/// 就没有失活，弹窗就不会自己消失；焦点始终留在主窗口上，点别处时主窗口照样
/// 收到点击，由那边负责把弹窗关掉。
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

/// Show the custom tray menu popup near the tray icon.
fn show_tray_menu(app: &tauri::AppHandle, x: f64, y: f64) {
    let menu_window = if let Some(win) = app.get_webview_window("tray-menu") {
        win
    } else {
        let builder = WebviewWindowBuilder::new(
            app,
            "tray-menu",
            WebviewUrl::App("tray-menu.html".into()),
        )
        .inner_size(200.0, 140.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .transparent(true);
        match builder.build() {
            Ok(win) => win,
            Err(e) => {
                eprintln!("dsh-desktop: create tray-menu window failed: {e}");
                return;
            }
        }
    };
    let _ = menu_window.set_position(LogicalPosition::new(x, y));
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
        if let WindowEvent::Resized(size) = event {
            apply_rounded_region(&window_handle);
            let w = size.width as f64;
            let h = size.height as f64 - TITLEBAR_HEIGHT;
            if w > 0.0 && h > 0.0 {
                let _ = child.set_position(LogicalPosition::new(0.0, TITLEBAR_HEIGHT));
                let _ = child.set_size(LogicalSize::new(w, h));
            }
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
                move || {
                    if let Some(popup) = press_handle.get_webview_window("update-popup") {
                        if popup.is_visible().unwrap_or(false) {
                            let _ = popup.hide();
                        }
                    }
                },
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
                            let (x, y) = match rect.position {
                                tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
                                tauri::Position::Logical(p) => (p.x, p.y),
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

            // 关闭主窗口时：若开启“关闭到托盘”，则隐藏而不是退出。
            if let Some(main) = app.get_window("main") {
                let settings_state = settings_state.clone();
                let quitting = quitting.clone();
                let main_handle = main.clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let close_to_tray = settings_state.lock().unwrap().close_to_tray;
                        if close_to_tray && !quitting.load(Ordering::SeqCst) {
                            api.prevent_close();
                            let _ = main_handle.hide();
                        }
                    }
                });
            }

            let handle = app.handle().clone();
            start_launch(handle, state, host, guard, bridge);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building dsh-desktop")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // 退出时清理我们 spawn 的 host 进程树。
                if let Some(slot) = app.try_state::<SharedHost>() {
                    if let Some(mut process) = slot.lock().unwrap().take() {
                        process.kill();
                    }
                }
            }
        });
}
