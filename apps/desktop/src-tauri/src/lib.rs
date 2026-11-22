//! ZHU desktop shell (Tauri 2).
//!
//! Responsibilities: window management (main window, floating icon), system tray,
//! global hotkeys, autostart, single instance, the processing engine (which runs inside this
//! process: engine.rs supervises it, embedded.rs loads it), how see-through ZHU is (opacity.rs), the switch that takes ZHU out of the taskbar, Alt+Tab and
//! screen captures (bars.rs), and the embedded web chat tabs (webchat.rs). Everything here uses
//! documented Tauri and Windows behavior. The app stays an ordinary, visible process: no process
//! hiding. With the hide switch on, its windows are still on the user's screen, on top of other
//! windows, and Windows leaves them out of screenshots, recordings and screen sharing.

mod bars;
mod bubble;
/// Public for examples/embedded_check.rs, which packaging/build.ps1 runs against a fresh engine.
pub mod embedded;
mod engine;
mod opacity;
mod resize_cursor;
mod webchat;

use engine::{EngineInfo, EngineSupervisor};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const HOTKEY_ACTIONS: [&str; 3] = [
    "toggle_listening",
    "capture_screen",
    "copy_latest_question",
];

fn default_hotkeys() -> HashMap<String, String> {
    [
        ("toggle_listening", "CommandOrControl+Shift+L"),
        ("capture_screen", "CommandOrControl+Shift+A"),
        ("copy_latest_question", "CommandOrControl+Shift+C"),
    ]
    .into_iter()
    .map(|(a, k)| (a.to_string(), k.to_string()))
    .collect()
}

pub struct AppState {
    pub engine: Arc<EngineSupervisor>,
    pub close_to_tray: AtomicBool,
    pub quitting: AtomicBool,
    /// Show the floating icon while the main window is minimized (a preference, on by default).
    pub minimize_bubble: AtomicBool,
    /// Last recording state reported by the main window: 0 idle, 1 listening, 2 paused.
    pub recording: AtomicU8,
    /// Counts capture_shield requests, so an old timer never switches off a newer shield.
    pub shield_generation: AtomicU64,
    /// Registered shortcut (normalized string form) -> action
    pub hotkeys: Mutex<HashMap<String, String>>,
    pub tray: Mutex<Option<TrayIcon>>,
    pub tray_items: Mutex<Option<TrayItems>>,
}

pub struct TrayItems {
    listening: MenuItem<tauri::Wry>,
    hidden_from_bars: MenuItem<tauri::Wry>,
}

// ============================================================== commands
#[tauri::command]
fn engine_info(state: tauri::State<AppState>) -> EngineInfo {
    state.engine.info()
}

#[tauri::command]
async fn restart_engine(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<EngineInfo, String> {
    state.engine.reset_restart_budget();
    // Stopping the running engine takes a moment: not on the thread that draws the windows.
    let engine = state.engine.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || engine.start(&handle)).await.map_err(|e| e.to_string())?;
    // Wait for the new generation to become ready or fail (the event also notifies all windows).
    for _ in 0..180 {
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(std::time::Duration::from_millis(500)))
            .await
            .ok();
        let info = state.engine.info();
        if info.status != "starting" {
            return Ok(info);
        }
    }
    Ok(state.engine.info())
}

/// Start ZHU again: the way back when the engine is stuck and will not stop (see engine.rs).
#[tauri::command]
fn restart_app(app: AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("ZHU could not find itself: {e}"))?;
    // The new ZHU waits until this one has gone; otherwise it would find this one still running
    // and hand over to it (single instance).
    std::process::Command::new(exe)
        .arg(format!("{WAIT_FOR}{}", std::process::id()))
        .spawn()
        .map_err(|e| format!("ZHU could not be started again: {e}"))?;
    quit_app(&app);
    Ok(())
}

/// Quit: the windows go at once, the engine is stopped in order (bounded), then ZHU exits.
fn quit_app(app: &AppHandle) {
    let st = app.state::<AppState>();
    if st.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        handle.state::<AppState>().engine.shutdown(&handle);
        handle.exit(0);
    });
}

/// `--wait-for=<pid>`: given by `restart_app` to the new ZHU.
const WAIT_FOR: &str = "--wait-for=";

/// Wait (bounded) until the process `pid` has ended.
#[cfg(windows)]
fn wait_for_process(pid: u32) {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    const SYNCHRONIZE: u32 = 0x0010_0000;
    unsafe {
        let handle = OpenProcess(SYNCHRONIZE, 0, pid);
        if !handle.is_null() {
            WaitForSingleObject(handle, 30_000);
            CloseHandle(handle);
        }
    }
}

#[cfg(not(windows))]
fn wait_for_process(_pid: u32) {}

#[tauri::command]
fn show_main(app: AppHandle) {
    show_main_window(&app);
}

/// How see-through every ZHU window is, from 0 to 1 (see opacity.rs).
#[tauri::command]
fn set_window_opacity(app: AppHandle, opacity: f64) {
    opacity::set(&app, opacity);
}

/// Take ZHU out of the taskbar, Alt+Tab and screen captures, or put it back (see bars.rs).
#[tauri::command]
fn set_hidden_from_bars(app: AppHandle, hidden: bool) {
    apply_hidden_from_bars(&app, hidden);
}

/// The state of that switch, for a page that has just loaded.
#[tauri::command]
fn hidden_from_bars() -> bool {
    bars::is_hidden()
}

#[tauri::command]
fn set_tray_state(app: AppHandle, recording: bool, paused: bool) {
    let st = app.state::<AppState>();
    // The floating icon shows the same state.
    st.recording.store(match (recording, paused) { (true, false) => 1, (true, true) => 2, _ => 0 }, Ordering::SeqCst);
    let _ = app.emit("zhu://recording", RecordingState { recording, paused });
    let tooltip = match (recording, paused) {
        (true, false) => "ZHU — Recording",
        (true, true) => "ZHU — Recording paused",
        _ => "ZHU — Not recording",
    };
    let tray_guard = st.tray.lock().unwrap();
    if let Some(tray) = tray_guard.as_ref() {
        let _ = tray.set_tooltip(Some(tooltip));
    }
    let items_guard = st.tray_items.lock().unwrap();
    if let Some(items) = items_guard.as_ref() {
        let label = match (recording, paused) {
            (true, false) => "Pause listening",
            (true, true) => "Resume listening",
            _ => "Start listening",
        };
        let _ = items.listening.set_text(label);
    }
}

/// Keep ZHU's own windows out of a screenshot ZHU is about to take. The windows stay on screen for
/// the user; Windows simply leaves them out of captures while this is on. It is meant for the
/// moment of one capture only: the front end turns it off right after, and a timer turns it off
/// after `MAX_SHIELD_MS` in any case, so it can never stay on by accident. (While ZHU is hidden
/// its windows are out of captures for as long as that lasts; see bars.rs, which holds both.)
const MAX_SHIELD_MS: u64 = 4000;

#[tauri::command]
fn capture_shield(app: AppHandle, state: tauri::State<AppState>, on: bool) {
    let generation = state.shield_generation.fetch_add(1, Ordering::SeqCst) + 1;
    bars::set_shield(&app, on);
    if on {
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(MAX_SHIELD_MS));
            // Only if no newer request has come in since.
            if handle.state::<AppState>().shield_generation.load(Ordering::SeqCst) == generation {
                bars::set_shield(&handle, false);
            }
        });
    }
}

#[derive(Serialize, Clone)]
struct RecordingState {
    recording: bool,
    paused: bool,
}

/// The recording state, for the floating icon when it opens.
#[tauri::command]
fn recording_state(state: tauri::State<AppState>) -> RecordingState {
    let v = state.recording.load(Ordering::SeqCst);
    RecordingState { recording: v != 0, paused: v == 2 }
}

/// The "Custom pointer" preference, for the part of the pointer the shell draws: the resize
/// cursors at the window edges (the page styles the pointer inside the window itself).
#[tauri::command]
fn set_custom_cursor(enabled: bool) {
    resize_cursor::set_enabled(enabled);
}

/// The floating icon's page reports that it is running (see bubble::start_watchdog).
#[tauri::command]
fn bubble_alive(app: AppHandle) {
    bubble::alive(&app);
}

/// The preference "Show a floating icon when minimized".
#[tauri::command]
fn set_minimize_bubble(app: AppHandle, enabled: bool) {
    app.state::<AppState>().minimize_bubble.store(enabled, Ordering::SeqCst);
    let minimized = app.get_webview_window("main").map(|m| m.is_minimized().unwrap_or(false)).unwrap_or(false);
    if !enabled {
        bubble::hide(&app, "switched off in Settings");
    } else if minimized {
        bubble::show(&app, "switched on in Settings");
    }
}

#[tauri::command]
fn set_close_to_tray(state: tauri::State<AppState>, enabled: bool) {
    state.close_to_tray.store(enabled, Ordering::SeqCst);
}

#[tauri::command]
fn set_hotkeys(app: AppHandle, map: HashMap<String, String>) -> HashMap<String, Option<String>> {
    register_hotkeys(&app, &map)
}

#[tauri::command]
async fn export_file(app: AppHandle, default_name: String, contents: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let ext = default_name.rsplit('.').next().unwrap_or("txt").to_string();
    let picked = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(ext.to_uppercase(), &[ext.as_str()])
        .blocking_save_file();
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, contents.as_bytes()).map_err(|e| format!("could not save file: {e}"))?;
    Ok(Some(path.display().to_string()))
}

fn show_main_window(app: &AppHandle) {
    bubble::hide(app, "ZHU was opened");
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

const HIDE_FROM_BARS: &str = "Hide from taskbar, Alt+Tab and screen capture";
const SHOW_IN_BARS: &str = "Show in taskbar, Alt+Tab and screen capture";

fn apply_hidden_from_bars(app: &AppHandle, hidden: bool) {
    bars::set_hidden(app, hidden);
    // The floating icon is only for a hidden ZHU (the tray menu can switch this while minimized).
    if hidden {
        bubble::show(app, "ZHU was hidden while minimized");
    } else {
        bubble::hide(app, "ZHU is in the taskbar again");
    }
    let st = app.state::<AppState>();
    {
        let items_guard = st.tray_items.lock().unwrap();
        if let Some(items) = items_guard.as_ref() {
            let _ = items.hidden_from_bars.set_text(if hidden { SHOW_IN_BARS } else { HIDE_FROM_BARS });
        }
    }
    let _ = app.emit("zhu://hidden-from-bars", hidden);
}

fn normalize(sc: &Shortcut) -> String {
    sc.into_string().to_lowercase()
}

fn register_hotkeys(app: &AppHandle, map: &HashMap<String, String>) -> HashMap<String, Option<String>> {
    // One caller at a time, from dropping the old shortcuts to registering the new ones. The page
    // can ask twice at almost the same moment (at start, and when preferences arrive from another
    // window); interleaved, the second caller found every shortcut "already registered" by the
    // first, reported them all as failed and left none of them connected to its action.
    let st = app.state::<AppState>();
    let mut registered = st.hotkeys.lock().unwrap_or_else(|e| e.into_inner());
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    registered.clear();
    let mut result = HashMap::new();
    for action in HOTKEY_ACTIONS {
        let Some(accel) = map.get(action).filter(|a| !a.trim().is_empty()) else {
            result.insert(action.to_string(), None);
            continue;
        };
        match accel.parse::<Shortcut>() {
            Err(e) => {
                result.insert(action.to_string(), Some(format!("invalid shortcut: {e}")));
            }
            Ok(sc) => {
                let key = normalize(&sc);
                if registered.contains_key(&key) {
                    result.insert(action.to_string(), Some("already used by another ZHU action".into()));
                    continue;
                }
                match gs.register(sc) {
                    Ok(()) => {
                        registered.insert(key, action.to_string());
                        result.insert(action.to_string(), None);
                    }
                    Err(_) => {
                        // Windows gives no more detail than "refused": some other program has these keys.
                        result.insert(action.to_string(), Some(format!("{accel} is already used by another app")));
                    }
                }
            }
        }
    }
    result
}

/// Every shortcut is carried out by the main window's page.
fn handle_hotkey(app: &AppHandle, action: &str) {
    #[derive(Serialize, Clone)]
    struct Payload<'a> {
        action: &'a str,
    }
    let _ = app.emit("zhu://hotkey", Payload { action });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show ZHU", true, None::<&str>)?;
    let hide_bars = MenuItem::with_id(app, "hidden_from_bars", HIDE_FROM_BARS, true, None::<&str>)?;
    let listening = MenuItem::with_id(app, "listening", "Start listening", true, None::<&str>)?;
    let new_session = MenuItem::with_id(app, "new_session", "New session", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let restart_engine = MenuItem::with_id(app, "restart_engine", "Restart the engine", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit ZHU", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &hide_bars, &sep1, &listening, &new_session, &settings, &sep2, &restart_engine, &quit])?;

    let tray = TrayIconBuilder::with_id("zhu")
        .icon(app.default_window_icon().cloned().expect("app icon missing"))
        .tooltip("ZHU — Not recording")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            #[derive(Serialize, Clone)]
            struct Payload<'a> {
                action: &'a str,
            }
            match event.id().as_ref() {
                "show" => show_main_window(app),
                "hidden_from_bars" => apply_hidden_from_bars(app, !bars::is_hidden()),
                "listening" => {
                    let _ = app.emit("zhu://tray", Payload { action: "toggle_listening" });
                }
                "new_session" => {
                    show_main_window(app);
                    let _ = app.emit("zhu://tray", Payload { action: "new_session" });
                }
                "settings" => {
                    show_main_window(app);
                    let _ = app.emit("zhu://tray", Payload { action: "open_settings" });
                }
                "restart_engine" => {
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        let engine = handle.state::<AppState>().engine.clone();
                        engine.reset_restart_budget();
                        engine.start(&handle);
                    });
                }
                "quit" => quit_app(app),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    let st = app.state::<AppState>();
    *st.tray.lock().unwrap() = Some(tray);
    *st.tray_items.lock().unwrap() = Some(TrayItems { listening, hidden_from_bars: hide_bars });
    Ok(())
}

// ============================================================== entry point
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri_plugin_window_state::StateFlags;

    // Started again by `restart_app`: the old ZHU must be gone first.
    if let Some(pid) = std::env::args().find_map(|a| a.strip_prefix(WAIT_FOR).and_then(|p| p.parse::<u32>().ok())) {
        wait_for_process(pid);
    }
    let supervisor = EngineSupervisor::new();
    let started_minimized = std::env::args().any(|a| a == "--minimized");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .with_denylist(&[bubble::LABEL])
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let key = normalize(shortcut);
                // Never wait here: while shortcuts are being registered again the list is held, and
                // registering waits for this (the main) thread. A key pressed in that moment is skipped.
                let action = app.state::<AppState>().hotkeys.try_lock().ok().and_then(|map| map.get(&key).cloned());
                if let Some(action) = action {
                    handle_hotkey(app, &action);
                }
            })
            .build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            engine: supervisor.clone(),
            close_to_tray: AtomicBool::new(true),
            quitting: AtomicBool::new(false),
            minimize_bubble: AtomicBool::new(true),
            recording: AtomicU8::new(0),
            shield_generation: AtomicU64::new(0),
            hotkeys: Mutex::new(HashMap::new()),
            tray: Mutex::new(None),
            tray_items: Mutex::new(None),
        })
        .manage(webchat::WebChatState::default())
        .manage(bubble::BubbleState::default())
        .invoke_handler(tauri::generate_handler![
            engine_info,
            restart_engine,
            restart_app,
            show_main,
            set_hidden_from_bars,
            hidden_from_bars,
            set_window_opacity,
            set_tray_state,
            set_close_to_tray,
            set_minimize_bubble,
            bubble_alive,
            set_custom_cursor,
            recording_state,
            capture_shield,
            set_hotkeys,
            export_file,
            webchat::webchat_open,
            webchat::webchat_show,
            webchat::webchat_hide,
            webchat::webchat_close,
            webchat::webchat_navigate,
            webchat::webchat_tabs,
            webchat::webchat_clear_data,
            webchat::webchat_deliver
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;
            register_hotkeys(&handle, &default_hotkeys());
            supervisor.start_at_launch(&handle);
            bubble::start_watchdog(app.handle());
            // ZHU's own resize cursors at the edges of the main window, and the hooks behind the
            // taskbar switch and the opacity control (the floating icon gets its hooks when it is
            // made, in bubble.rs).
            if let Some(w) = app.get_webview_window("main") {
                resize_cursor::install(&w);
                bars::install(&w);
                opacity::install(&w);
            }
            if started_minimized {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimizing the main window brings up the floating icon; any way back hides it.
            match (window.label(), event) {
                ("main", WindowEvent::Resized(_)) => {
                    if window.is_minimized().unwrap_or(false) {
                        bubble::show(window.app_handle(), "the main window was minimized");
                    } else {
                        bubble::hide(window.app_handle(), "the main window was restored");
                    }
                }
                // Windows can hand the focus to a window that is still minimized (when another
                // window closes, for instance); only a window that is really back hides the icon.
                ("main", WindowEvent::Focused(true)) if !window.is_minimized().unwrap_or(false) => {
                    bubble::hide(window.app_handle(), "the main window got the focus")
                }
                (bubble::LABEL, WindowEvent::Moved(position)) => bubble::moved(window.app_handle(), *position),
                _ => {}
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let st = app.state::<AppState>();
                match window.label() {
                    "main" if !st.quitting.load(Ordering::SeqCst) && st.close_to_tray.load(Ordering::SeqCst) => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    "main" => {
                        // Closing it quits ZHU (close-to-tray is off, or ZHU is quitting already).
                        api.prevent_close();
                        quit_app(app);
                    }
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building ZHU")
        .run(|app, event| {
            // Any other way out (the engine was stopped already when ZHU quits through quit_app).
            if let tauri::RunEvent::Exit = event {
                app.state::<AppState>().engine.shutdown(app);
            }
        });
}
