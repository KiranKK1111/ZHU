//! The floating icon shown while the main window is minimized and ZHU is hidden from the taskbar
//! (bars.rs): the ZHU mark, always on top. A click brings the main window back; a drag moves the
//! icon. While ZHU is in the taskbar the icon is not shown: the taskbar button does that job.
//!
//! The window is created the first time it is needed and then only hidden and shown, so later
//! minimizes show it at once. Its position is kept for the rest of the run. A watchdog keeps it
//! on screen for as long as the main window is minimized (see `start_watchdog`).

use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::AppState;

pub const LABEL: &str = "bubble";
/// Logical size of the window: a 52 px icon with room around it for its shadow and badge.
const SIZE: f64 = 76.0;
/// Distance from the corner of the work area for the first placement.
const MARGIN: f64 = 20.0;

/// How often the watchdog looks at the icon.
const WATCH_EVERY: Duration = Duration::from_millis(1500);
/// The page answers a ping every `WATCH_EVERY`; this long without an answer means it is no longer running.
const SILENT_AFTER: Duration = Duration::from_secs(12);
const REBUILD_AT_MOST_EVERY: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct BubbleState {
    /// Where the user last left the icon (physical pixels).
    pub position: Mutex<Option<PhysicalPosition<i32>>>,
    /// When the icon was last put on screen.
    shown_at: Mutex<Option<Instant>>,
    /// When the icon's page last reported that it is running.
    last_beat: Mutex<Option<Instant>>,
    rebuilt_at: Mutex<Option<Instant>>,
    /// Held while the icon is being created and shown, so two requests never build it twice.
    presenting: Mutex<()>,
}

/// What Windows itself says about the icon's window, and direct ways to put it right.
///
/// The window library answers "is it on top?" from what it last set, and skips a "show" when it
/// believes the window is already shown. Both are wrong as soon as anything else has touched the
/// window ("Show desktop", another program, a full-screen app), so the icon is checked and
/// corrected at the source.
#[cfg(windows)]
mod native {
    use tauri::WebviewWindow;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, IsIconic, IsWindowVisible, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE,
        SW_SHOWNOACTIVATE, WS_EX_TOPMOST,
    };

    pub struct State {
        pub visible: bool,
        pub minimized: bool,
        pub topmost: bool,
    }

    pub fn state(w: &WebviewWindow) -> Option<State> {
        let hwnd = w.hwnd().ok()?;
        unsafe {
            Some(State {
                visible: IsWindowVisible(hwnd).as_bool(),
                minimized: IsIconic(hwnd).as_bool(),
                topmost: GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0 != 0,
            })
        }
    }

    /// Show the window (restoring it if minimized) without taking the focus from the user's work.
    pub fn show(w: &WebviewWindow) {
        if let Ok(hwnd) = w.hwnd() {
            unsafe {
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
        }
        raise(w);
    }

    pub fn raise(w: &WebviewWindow) {
        if let Ok(hwnd) = w.hwnd() {
            unsafe {
                let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }
    }

    pub fn hide(w: &WebviewWindow) {
        if let Ok(hwnd) = w.hwnd() {
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
        }
    }
}

#[cfg(not(windows))]
mod native {
    use tauri::WebviewWindow;

    pub struct State {
        pub visible: bool,
        pub minimized: bool,
        pub topmost: bool,
    }

    pub fn state(w: &WebviewWindow) -> Option<State> {
        Some(State { visible: w.is_visible().ok()?, minimized: w.is_minimized().unwrap_or(false), topmost: true })
    }
    pub fn show(w: &WebviewWindow) {
        let _ = w.unminimize();
        let _ = w.show();
    }
    pub fn raise(w: &WebviewWindow) {
        let _ = w.set_always_on_top(true);
    }
    pub fn hide(w: &WebviewWindow) {
        let _ = w.hide();
    }
}

/// The icon is on screen, as Windows sees it.
fn on_screen(w: &WebviewWindow) -> bool {
    native::state(w).map(|s| s.visible && !s.minimized).unwrap_or(false)
}

/// The window, created on first use. Must not run on the main thread on Windows: creating a
/// webview there from an event handler deadlocks (wry #583), so callers use `show` below.
fn window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?window=bubble".into()));
    // WebView2 requires every webview sharing the user-data folder to use identical environment
    // options; otherwise creation fails with 0x8007139F. Inherit the main window's browser args.
    if let Some(args) = app.config().app.windows.iter().find(|w| w.label == "main").and_then(|w| w.additional_browser_args.clone()) {
        builder = builder.additional_browser_args(&args);
    }
    let window = builder
        .title("ZHU")
        .inner_size(SIZE, SIZE)
        // Without an explicit minimum, Windows applies its default minimum window width (about
        // 130 px), which would stretch the icon's window and push it past the edge of the screen.
        .min_inner_size(SIZE, SIZE)
        .max_inner_size(SIZE, SIZE)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .ok()?;
    // The hooks behind the taskbar switch and the opacity control go on from the thread that owns
    // the window. They run before the first show, so an icon made while ZHU is hidden never appears
    // in Alt+Tab, and one made while ZHU is see-through is see-through from the start.
    let hooked = window.clone();
    let _ = window.run_on_main_thread(move || {
        crate::bars::install(&hooked);
        crate::opacity::install(&hooked);
    });
    Some(window)
}

/// The usable part of a monitor (without the taskbar), in physical pixels: x, y, width, height.
fn work_area(m: &Monitor) -> (i32, i32, i32, i32) {
    let area = m.work_area();
    (area.position.x, area.position.y, area.size.width as i32, area.size.height as i32)
}

/// If less than `min_visible` physical pixels of the icon are on any monitor (one was unplugged,
/// or the resolution changed), move it to the bottom-right corner of the primary monitor.
fn keep_on_screen(w: &WebviewWindow, min_visible: i32) {
    let (Ok(position), Ok(size)) = (w.outer_position(), w.outer_size()) else { return };
    let (x, y, width, height) = (position.x, position.y, size.width as i32, size.height as i32);
    let Ok(monitors) = w.available_monitors() else { return };
    let visible = monitors.iter().any(|m| {
        let (ax, ay, aw, ah) = work_area(m);
        let across = (x + width).min(ax + aw) - x.max(ax);
        let down = (y + height).min(ay + ah) - y.max(ay);
        across >= min_visible.min(width) && down >= min_visible.min(height)
    });
    if visible {
        return;
    }
    if let Some(m) = w.primary_monitor().ok().flatten().or_else(|| monitors.into_iter().next()) {
        let (ax, ay, aw, ah) = work_area(&m);
        let margin = (MARGIN * m.scale_factor()) as i32;
        let _ = w.set_position(PhysicalPosition::new((ax + aw - width.min(aw) - margin).max(ax), (ay + ah - height.min(ah) - margin).max(ay)));
    }
}

/// Bottom-right corner of the work area of the monitor the main window is on.
fn default_position(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    // For a minimized window Windows reports the monitor of its last normal position.
    let monitor = crate::main_window(app)
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let size = (SIZE * scale).round() as i32;
    let margin = (MARGIN * scale).round() as i32;
    Some(PhysicalPosition::new(
        area.position.x + area.size.width as i32 - size - margin,
        area.position.y + area.size.height as i32 - size - margin,
    ))
}

/// Create (if needed), place and show the icon. Blocks while a webview is created, so it must
/// run off the main thread.
fn present(app: &AppHandle, reason: &str) {
    let state = app.state::<BubbleState>();
    let _one_at_a_time = state.presenting.lock().unwrap_or_else(|e| e.into_inner());
    let Some(w) = window(app) else {
        log(app, "could not create the icon window");
        return;
    };
    // The main window may have come back while the icon was being created.
    if !wanted(app) || on_screen(&w) {
        return;
    }
    let saved = *state.position.lock().unwrap();
    if let Some(p) = saved.or_else(|| default_position(app)) {
        let _ = w.set_position(p);
    }
    // Windows can enlarge a new window to its default minimum width; insist on the icon's size.
    let _ = w.set_size(LogicalSize::new(SIZE, SIZE));
    // A monitor may have been unplugged since the icon was last placed.
    let half = (SIZE * w.scale_factor().unwrap_or(1.0) / 2.0) as i32;
    keep_on_screen(&w, half);
    let _ = w.show(); // keeps the window library's own record right
    native::show(&w); // and this shows it even when that record already said "shown"
    *state.shown_at.lock().unwrap() = Some(Instant::now());
    log(app, &format!("shown ({reason})"));
}

/// The icon belongs on screen: the user has it switched on, ZHU is hidden from the taskbar and the
/// main window is minimized. While ZHU is in the taskbar its button there brings the window back,
/// so no icon is shown.
fn wanted(app: &AppHandle) -> bool {
    let st = app.state::<AppState>();
    st.minimize_bubble.load(Ordering::SeqCst)
        && crate::bars::is_hidden()
        && !st.quitting.load(Ordering::SeqCst)
        && crate::main_window(app).map(|m| m.is_minimized().unwrap_or(false)).unwrap_or(false)
}

/// Show the icon (the main window was minimized). Does nothing when the user switched it off.
pub fn show(app: &AppHandle, reason: &'static str) {
    if !wanted(app) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || present(&app, reason));
}

pub fn hide(app: &AppHandle, reason: &str) {
    if let Some(w) = app.get_webview_window(LABEL) {
        if native::state(&w).map(|s| s.visible).unwrap_or(false) {
            let _ = w.hide();
            native::hide(&w);
            log(app, &format!("hidden ({reason})"));
        }
    }
}

/// The icon was moved (by the user, or by `present`): remember where.
pub fn moved(app: &AppHandle, position: PhysicalPosition<i32>) {
    // A minimized window reports a parking position far off screen; that is not where the user put it.
    if position.x <= -30000 || position.y <= -30000 {
        return;
    }
    *app.state::<BubbleState>().position.lock().unwrap() = Some(position);
}

/// The icon's page is running: it answers the watchdog's ping with this.
pub fn alive(app: &AppHandle) {
    *app.state::<BubbleState>().last_beat.lock().unwrap() = Some(Instant::now());
}

/// Keeps the icon on screen for as long as the main window is minimized, whatever happens to it.
///
/// Events alone are not enough: "Show desktop" minimizes the icon too, a full-screen or another
/// always-on-top window can end up above it, some other program can hide it, and its page can die
/// (the browser engine ends a renderer when memory runs out), which leaves a transparent window
/// with nothing in it. Every `WATCH_EVERY` this puts things right:
///   * icon missing, hidden or minimized  -> shown again
///   * icon no longer on top              -> raised again
///   * page silent for `SILENT_AFTER`     -> the window is rebuilt
///   * main window not minimized          -> icon hidden
pub fn start_watchdog(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(WATCH_EVERY);
        if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
            return;
        }
        let Some(w) = app.get_webview_window(LABEL) else {
            if wanted(&app) {
                present(&app, "watchdog: there was no icon");
            }
            continue;
        };
        if !wanted(&app) {
            hide(&app, "watchdog: the main window is not minimized, or ZHU is in the taskbar");
            continue;
        }
        let Some(now) = native::state(&w) else { continue };
        if now.minimized || !now.visible {
            present(&app, if now.minimized { "watchdog: the icon had been minimized" } else { "watchdog: the icon had been hidden" });
            continue;
        }
        if !now.topmost {
            native::raise(&w);
            log(&app, "raised (watchdog: it was no longer on top of other windows)");
        }
        let _ = w.emit("zhu://bubble-ping", ()); // the page answers with `alive`
        let state = app.state::<BubbleState>();
        let shown_for = state.shown_at.lock().unwrap().map(|t| t.elapsed()).unwrap_or_default();
        let silent_for = state.last_beat.lock().unwrap().map(|t| t.elapsed()).unwrap_or(shown_for);
        let rebuilt_ago = state.rebuilt_at.lock().unwrap().map(|t| t.elapsed());
        if shown_for > SILENT_AFTER && silent_for > SILENT_AFTER && rebuilt_ago.map(|t| t > REBUILD_AT_MOST_EVERY).unwrap_or(true) {
            log(&app, &format!("the icon's page has been silent for {} s: rebuilding the window", silent_for.as_secs()));
            *state.rebuilt_at.lock().unwrap() = Some(Instant::now());
            *state.last_beat.lock().unwrap() = None;
            let _ = w.destroy();
            // The label is free again only once the window is really gone.
            for _ in 0..40 {
                if app.get_webview_window(LABEL).is_none() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            present(&app, "watchdog: rebuilt");
        }
    });
}

/// One line per show, hide and repair, so that an icon that went away can be explained afterwards.
fn log(app: &AppHandle, message: &str) {
    crate::shell_log(app, "floating icon", message);
}
