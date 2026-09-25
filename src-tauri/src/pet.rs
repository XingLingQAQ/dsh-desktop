//! The desktop pet: an always-on-top window that stays after the main window is
//! closed.
//!
//! Two things make this window unlike the other auxiliary windows in this shell:
//!
//!  * It is **opaque**, with its rounded corners cut by a window region
//!    (`SetWindowRgn`), and the page paints a card inside that region. This is
//!    the same construction as the update popup, and it is here for the same
//!    reason — see below.
//!  * Its position is **persisted**, including which monitor it was on. A pet
//!    that teleports back to the primary screen after a reboot is worse than one
//!    that never moved.
//!
//! ## Why not transparency
//!
//! The first version was `transparent(true)`, so the pet's own pixels were the
//! window's shape and it floated directly over the wallpaper. That looked better
//! and it was verified at the time, but it is **not safe on this machine**: over
//! a Remote Desktop session WebView2 falls back to software composition, where
//! per-pixel window transparency is unreliable. What the user sees when it
//! degrades is the pet sitting on an opaque **grey-white rectangle** — and
//! because a layered window's moves desync the RDP client's bitmap cache, the
//! places it was dragged across keep that grey-white **permanently**, until the
//! whole screen is forced to repaint.
//!
//! The update popup had already been changed to opaque-plus-region for exactly
//! this reason ("透明渲染在软件合成下不可靠"), so the answer was already in the
//! codebase; the pet simply did not follow it. An opaque window is an ordinary
//! window, and RDP repaints ordinary windows correctly.
//!
//! The cost is real and worth stating: the pet no longer floats free — it sits
//! on a card. The card is designed to look intentional (see the `.pet-*` rules
//! in `styles.css`) rather than like a panel the pet got stuck in.
//!
//! The window is created hidden at startup and shown on demand, because
//! building a webview is the expensive part and the user may toggle the pet at
//! any moment.
//!
//! ## Coordinates
//!
//! Everything here is in **physical screen pixels**, and the window is moved
//! with `PhysicalPosition`. That is not a stylistic choice: this shell runs
//! per-monitor-DPI-aware, so the desktop coordinate space Windows actually
//! positions windows in is physical. Mixing in logical units means dividing by
//! one monitor's scale factor and multiplying back by another's, which is how a
//! "bottom-right" default ended up 2000px away from the corner it was aiming
//! for.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// Window label. Also the key `get_webview_window` looks up.
pub const PET_LABEL: &str = "pet";

/// Whether the pet is currently on screen.
///
/// Mirrored as an atomic because the session-state poller asks this several
/// times a second: reading the state file, or asking the window, on every tick
/// would be real work for a question whose answer changes only on a toggle.
static PET_VISIBLE: AtomicBool = AtomicBool::new(false);

/// Whether the pet window is currently shown.
pub fn is_visible() -> bool {
    PET_VISIBLE.load(Ordering::SeqCst)
}

/// Default footprint.
///
/// Sized to the pet plus the room its animation needs, not to a round number:
/// the window is opaque and does not click through, so every pixel of margin
/// around the pet is desktop the user can neither see through nor click. The
/// figure is 108×132 and hops 10px with sparkles reaching 18px above it, and its
/// soft shadow spills a few pixels below — so the height is the figure plus room
/// above *and* below, and the width is the figure plus its side margin.
pub const PET_WIDTH: f64 = 132.0;
pub const PET_HEIGHT: f64 = 168.0;

/// Corner radius of the pet's card, in logical pixels.
///
/// Applied as a window region rather than a CSS `border-radius`: the region is
/// what actually clips the window (and its child webview) to the rounded shape,
/// so the corners show the desktop instead of the window's backing colour.
pub const PET_RADIUS: f64 = 18.0;

/// Keep at least this much of the pet on-screen when restoring a position, so a
/// saved spot on a monitor that is no longer attached cannot hide it forever.
const MIN_VISIBLE: i32 = 40;

/// Gap between the pet and the edges of the work area on first run.
const EDGE_INSET: i32 = 24;

/// Where the pet was last seen.
///
/// `monitor` is stored beside the coordinates because overlapping monitors can
/// share a coordinate range — with per-monitor scaling, two displays can report
/// origins that make a bare (x, y) ambiguous. Naming the monitor is what lets a
/// restore pick the same one it was on.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PetState {
    /// Whether the pet should be showing. Persisted so a pet the user turned on
    /// comes back after a restart.
    pub enabled: bool,
    /// Physical screen pixels.
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// Name of the monitor the position belongs to, when known.
    pub monitor: Option<String>,
}

/// How long the pet has to sit still before its position is written.
///
/// This is a debounce, not a throttle, and the difference matters: a throttle
/// saves on the *first* event of a burst, so any drag shorter than the window
/// would store where the drag started rather than where the pet was dropped.
/// Waiting for the movement to stop stores the position the user actually left.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(300);

/// When the pet was last seen to move.
static LAST_MOVE: Mutex<Option<Instant>> = Mutex::new(None);

/// Whether a debounce worker is already waiting. One per drag gesture, not one
/// per frame.
static SETTLING: AtomicBool = AtomicBool::new(false);

/// A monitor's bounds in physical pixels.
#[derive(Clone, Debug)]
struct MonitorRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    name: Option<String>,
}

fn state_path() -> PathBuf {
    std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("dsh-desktop")
        .join("pet.json")
}

/// Read the saved pet state.
///
/// A missing file is the default, not an error: the pet's position is a
/// convenience, never something to fail over. A file that *exists* but will not
/// parse is different — that is a truncated write, and silently taking the
/// default would reset `enabled` too, which does not merely move the pet: it turns
/// off the reason closing the main window keeps the app alive. So it is logged.
pub fn load() -> PetState {
    let Ok(text) = fs::read_to_string(state_path()) else {
        return PetState::default();
    };
    match serde_json::from_str(&text) {
        Ok(state) => state,
        Err(error) => {
            eprintln!(
                "dsh-desktop: pet.json 无法解析（{error}），按默认值处理；宠物位置和开关会重置"
            );
            PetState::default()
        }
    }
}

pub fn save(state: &PetState) -> std::io::Result<()> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(state).map_err(std::io::Error::other)?;
    // Write beside the target and rename over it, so a write that is interrupted
    // — and this process is force-killed routinely, which is what the whole
    // kill-on-close job is about — leaves the previous file intact instead of a
    // half-written one. `rename` is atomic on the same volume.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, &path)
}

/// Create the pet window if it does not exist yet, hidden.
///
/// Called once at startup so the first toggle is instant: a webview build plus a
/// page load is a visible pause, and paying it on the click that asked for the
/// pet is exactly the wrong time.
pub fn prepare(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(PET_LABEL) {
        return Ok(existing);
    }
    let window = WebviewWindowBuilder::new(app, PET_LABEL, WebviewUrl::App("pet.html".into()))
        .title("DSH Desktop Pet")
        .inner_size(PET_WIDTH, PET_HEIGHT)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        // Opaque on purpose — see the module docs. The rounded shape comes from
        // the window region applied below, not from per-pixel transparency.
        .transparent(false)
        .visible(false)
        .build()
        .map_err(|error| format!("建立宠物窗口失败：{error}"))?;
    // A window region is in window coordinates and does not follow a resize on
    // its own, so it has to be re-cut whenever the size changes.
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Resized(_)) {
            apply_card_region(&handle);
        }
    });
    apply_card_region(app);
    Ok(window)
}

/// Clip the pet window to a rounded rectangle.
///
/// The region is what makes the card's corners show the desktop: an opaque
/// window has no other way to be non-rectangular. Cut from the window's current
/// size, which is why `show()` calls it again after sizing and showing — a
/// window that has never been shown does not reliably report the size it will
/// have.
fn apply_card_region(app: &AppHandle) {
    if let Some(frame) = app.get_window(PET_LABEL) {
        crate::apply_rounded_region_r(&frame, PET_RADIUS);
    }
}

/// The work area as a monitor rectangle, for the clamping path.
fn primary_work_area() -> Option<MonitorRect> {
    crate::work_area().map(|(left, top, right, bottom)| MonitorRect {
        left,
        top,
        right,
        bottom,
        name: None,
    })
}

/// Every attached monitor, in physical pixels.
fn monitor_rects(app: &AppHandle) -> Vec<MonitorRect> {
    let Ok(list) = app.available_monitors() else { return Vec::new() };
    list.iter()
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            MonitorRect {
                left: position.x,
                top: position.y,
                right: position.x + size.width as i32,
                bottom: position.y + size.height as i32,
                name: monitor.name().cloned(),
            }
        })
        .collect()
}

/// The physical size the window will have, derived from the logical footprint
/// and the scale factor of the monitor it is on.
///
/// Derived rather than read back from the window: a size queried immediately
/// after `show()` can still be the pre-show value, and the whole point of doing
/// this arithmetic is to place the window before it has settled.
fn physical_footprint(window: &WebviewWindow) -> (i32, i32) {
    let scale = window.scale_factor().unwrap_or(1.0);
    (
        (PET_WIDTH * scale).round() as i32,
        (PET_HEIGHT * scale).round() as i32,
    )
}

/// Where the pet goes the first time it is ever shown: bottom-right, clear of
/// the taskbar.
fn default_position(width: i32, height: i32) -> (i32, i32) {
    let Some((_, _, right, bottom)) = crate::work_area() else {
        return (EDGE_INSET, EDGE_INSET);
    };
    (right - width - EDGE_INSET, bottom - height - EDGE_INSET)
}

/// Pull a saved position back onto a monitor that exists now.
///
/// A pet saved on a display that has since been unplugged would otherwise be
/// restored off-screen and could never be dragged back, which looks exactly like
/// the pet having vanished. Only the axis that actually overflows is corrected,
/// so a legitimate edge position is not nudged inward for no reason.
fn clamp_visible(app: &AppHandle, x: i32, y: i32, width: i32, saved: Option<&str>) -> (i32, i32) {
    let mut monitors = monitor_rects(app);
    if monitors.is_empty() {
        if let Some(area) = primary_work_area() {
            monitors.push(area);
        }
    }
    if monitors.is_empty() {
        return (x, y);
    }
    // Prefer the monitor the pet was last on by name; fall back to whichever
    // one the saved point actually falls inside, and finally to the first.
    let target = saved
        .and_then(|name| monitors.iter().find(|m| m.name.as_deref() == Some(name)))
        .or_else(|| {
            monitors
                .iter()
                .find(|m| x >= m.left && x < m.right && y >= m.top && y < m.bottom)
        })
        .unwrap_or(&monitors[0]);
    let x = x.clamp(target.left - width + MIN_VISIBLE, target.right - MIN_VISIBLE);
    let y = y.clamp(target.top, target.bottom - MIN_VISIBLE);
    (x, y)
}

/// Show the pet, restoring its saved position when there is one.
pub fn show(app: &AppHandle) -> Result<(), String> {
    let window = prepare(app)?;
    let state = load();
    // Position AFTER showing. A position set on a hidden window is not reliably
    // kept: the show itself can re-place the window, which is what put a freshly
    // enabled pet in the top-left corner instead of the bottom-right it was sent
    // to.
    let _ = window.set_size(LogicalSize::new(PET_WIDTH, PET_HEIGHT));
    window.show().map_err(|error| format!("显示宠物失败：{error}"))?;
    let (width, height) = physical_footprint(&window);
    let (x, y) = match (state.x, state.y) {
        (Some(x), Some(y)) => clamp_visible(app, x, y, width, state.monitor.as_deref()),
        _ => default_position(width, height),
    };
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| format!("摆放宠物失败：{error}"))?;
    // Now that the window is on screen at its final size, cut the card's corners.
    // Doing it here rather than only at build time matters because the window is
    // built hidden: its size is not settled until it has been shown.
    apply_card_region(app);
    PET_VISIBLE.store(true, Ordering::SeqCst);
    let mut next = state;
    next.enabled = true;
    let _ = save(&next);
    Ok(())
}

/// Hide the pet and remember that it is off.
pub fn hide(app: &AppHandle) -> Result<(), String> {
    remember_position_now(app);
    if let Some(window) = app.get_webview_window(PET_LABEL) {
        let _ = window.hide();
    }
    PET_VISIBLE.store(false, Ordering::SeqCst);
    let mut state = load();
    state.enabled = false;
    let _ = save(&state);
    Ok(())
}

/// Persist where the pet is right now, once it stops moving.
///
/// Driven by the window's `Moved` event, which fires once per frame while a drag
/// is in progress — a few hundred times a second. Writing the state file on each
/// of those would be a few hundred small writes for a value where only the last
/// one matters, so the write is deferred until the movement has stopped.
pub fn remember_position(app: &AppHandle) {
    *LAST_MOVE.lock().unwrap() = Some(Instant::now());
    if SETTLING.swap(true, Ordering::SeqCst) {
        // A worker is already waiting and will pick up the newer timestamp.
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(SAVE_DEBOUNCE);
            let settled = LAST_MOVE
                .lock()
                .unwrap()
                .is_some_and(|at| at.elapsed() >= SAVE_DEBOUNCE);
            if settled {
                break;
            }
        }
        SETTLING.store(false, Ordering::SeqCst);
        write_position(&app);
    });
}

/// Persist the position, ignoring the debounce.
///
/// Used where the value on screen is the one that has to survive immediately:
/// the pet being hidden, or the app quitting before the debounce has fired.
pub fn remember_position_now(app: &AppHandle) {
    *LAST_MOVE.lock().unwrap() = Some(Instant::now());
    write_position(app);
}

fn write_position(app: &AppHandle) {
    // A hidden pet's position is not a position: it is wherever the window happens
    // to sit while nobody can see it, and for a window never shown that is the
    // default corner. `RunEvent::Exit` records the position on *every* exit, so
    // without this guard quitting with the pet off overwrites the user's real
    // saved spot with that corner. Still correct on the hide path: `hide()` calls
    // this before it clears the flag, so the last real position is kept.
    if !PET_VISIBLE.load(Ordering::SeqCst) {
        return;
    }
    let Some(window) = app.get_webview_window(PET_LABEL) else { return };
    let Ok(position) = window.outer_position() else { return };
    let monitor = window.current_monitor().ok().flatten().and_then(|m| m.name().cloned());
    let mut state = load();
    state.x = Some(position.x);
    state.y = Some(position.y);
    state.monitor = monitor;
    let _ = save(&state);
}
