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
mod plugins;
mod provision;
mod registry;
mod settings;
mod store;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use tauri::{
    tray::TrayIconBuilder,
    webview::Color, Emitter, LogicalPosition, LogicalSize, Manager, RunEvent, Url, WebviewBuilder,
    WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

use crate::bridge::Bridge;
use crate::discover::{discover, EnvironmentSnapshot};
use crate::plugins::PluginManager;
use crate::settings::AppSettings;
use crate::host::{http_get_ok, probe_existing, HostEvent, HostProcess};
use crate::provision::provision;

/// Height of the custom title bar in the shell page (must match `--titlebar-height`).
const TITLEBAR_HEIGHT: f64 = 46.0;
/// Corner radius of the main window (must match `--corner-radius`).
const CORNER_RADIUS: f64 = 12.0;
/// Ports probed for an already-running host (attach mode).
const ATTACH_PORTS: [u16; 2] = [17890, 3080];
/// How long to wait for the readiness line.
const BOOT_TIMEOUT: Duration = Duration::from_secs(45);

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

/// List installed plugins (for the Settings > Plugins management page).
#[tauri::command]
fn get_installed_plugins() -> Vec<store::InstalledPluginInfo> {
    store::list_installed()
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
    let builder = WebviewBuilder::new("content", WebviewUrl::External(url))
        // 白色背景：DSH 页面布局瞬间未铺满时，露出的底色与浅色页面一致
        .background_color(Color(255, 255, 255, 255))
        .initialization_script(&init_script);

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
        let r = radius as i32 * 2; // 椭圆直径 = 2 × 半径
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        unsafe {
            let rgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, r, r);
            if !rgn.is_null() {
                SetWindowRgn(hwnd.0 as *mut core::ffi::c_void, rgn, 1);
                eprintln!("dsh-desktop: rounded region applied ({w}x{h}, r={r})");
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
        .invoke_handler(tauri::generate_handler![
            get_launch_state,
            get_desktop_plugins,
            get_settings,
            set_close_to_tray,
            set_auto_start,
            set_workspace_folder,
            export_diagnostics,
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
            app.manage(state.clone());
            app.manage(host.clone());
            app.manage(guard.clone());
            app.manage(settings_state.clone());
            app.manage(quitting.clone());

            // 桌面插件目录：插件像 U 盘一样放入该目录即可被扫描。解析规则见
            // `store::plugins_root`（开发用仓库根，打包用 APPDATA）——插件商店
            // 必须与这里指向同一个目录，所以两边共用同一个函数。
            let plugins_root = store::plugins_root();
            let plugins = Arc::new(PluginManager::new(plugins_root.clone(), String::new()));
            eprintln!("dsh-desktop: plugins_root={}", plugins_root.display());

            // 后端 overlay 指向当前 DSH_HOME（与 discover 的默认一致）。
            let dsh_home = std::env::var("DSH_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    std::env::var("APPDATA")
                        .map(|appdata| {
                            PathBuf::from(appdata)
                                .join("DeepSeek Harness")
                                .join("dsh-home")
                        })
                        .unwrap_or_else(|_| PathBuf::from("dsh-home"))
                });
            plugins.set_backend_home(dsh_home, "web".into());

            // 本地主题桥 + 插件桥：注入脚本把 DSH 页面的主题快照上报到这里，
            // 再以 Tauri 事件转发给壳页面与启动动画；插件状态/插件 bundle 也由
            // 同一个回环 HTTP 服务提供。
            let handle = app.handle().clone();
            let bridge = bridge::start(
                move |snapshot| {
                    let _ = handle.emit("theme-changed", snapshot);
                },
                plugins.clone(),
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
