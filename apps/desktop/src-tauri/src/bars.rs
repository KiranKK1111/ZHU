//! Hiding ZHU: out of the taskbar, out of Alt+Tab and out of screen captures, and back again.
//!
//! Windows decides the first two from one bit of a window's extended style: a "tool window" has no
//! taskbar button and is left out of Alt+Tab and Task View. While the switch is on, every ZHU
//! window (main, sidecar, floating icon) carries that bit. The windows stay on screen where they
//! were, ZHU stays in Task Manager, and the tray icon stays, which is the way back to a window
//! that has been minimized.
//!
//! The same switch leaves those windows out of screen captures (screenshots, recordings, screen
//! sharing): Windows draws them on the display as before and omits them from what a capture
//! receives. That is the documented display affinity "exclude from capture" (Windows 10 2004 and
//! later; older versions show a black rectangle in the capture instead). It covers what Windows
//! composes, so not a camera pointed at the screen, and not a window of another program.
//!
//! While ZHU is hidden this way its main window also stays on top of other windows: with no taskbar
//! button and no Alt+Tab entry, a window that went behind others could only be found through the
//! tray. If anything takes that away while ZHU is hidden, the hook below puts it back at once.
//! The sidecar keeps its place above the main window, as when the main window is an
//! ordinary one: both are then "always on top", and among such windows the one clicked last would
//! otherwise cover the other.
//!
//! Three things make the taskbar part more than setting the bit once:
//!   * The taskbar is only certain to notice the change on a window that is hidden at that moment,
//!     so a visible window is hidden, changed and shown again (the order Windows documents).
//!   * The window library writes the whole extended style again on most state changes (show, hide,
//!     maximize, always on top, click-through), without the bit. A hook on the style change puts
//!     the bit back before the new style takes effect.
//!   * Windows does not move a minimized tool window off screen: it leaves a small title-bar stub
//!     at the bottom-left of the desktop. The same hook sends it to where minimized windows go.
//!
//! The switch is off at every start and is not saved.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, WebviewWindow};

static HIDDEN: AtomicBool = AtomicBool::new(false);
/// ZHU is taking a screenshot itself and wants its windows left out of it (see `set_shield`).
static SHIELD: AtomicBool = AtomicBool::new(false);

/// Every window ZHU has. The chat tabs are not windows of their own: they sit inside the main one.
const LABELS: [&str; 3] = ["main", "sidecar", crate::bubble::LABEL];

const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
const WS_EX_APPWINDOW: u32 = 0x0004_0000;

/// A window's extended style with ZHU hidden or shown; every other bit is kept. The window
/// library gives all three windows the "app window" bit, so that is what "shown" restores (the
/// sidecar and the floating icon stay off the taskbar through `skipTaskbar`, which is separate).
fn ex_style(current: u32, hidden: bool) -> u32 {
    if hidden {
        (current | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW
    } else {
        (current | WS_EX_APPWINDOW) & !WS_EX_TOOLWINDOW
    }
}

pub fn is_hidden() -> bool {
    HIDDEN.load(Ordering::SeqCst)
}

/// ZHU's windows are left out of screen captures: while it is hidden, and for the moment of a
/// screenshot ZHU takes itself.
fn out_of_captures() -> bool {
    HIDDEN.load(Ordering::SeqCst) || SHIELD.load(Ordering::SeqCst)
}

/// Tell Windows, for every window ZHU has, whether captures may include it.
fn protect(app: &AppHandle) {
    let excluded = out_of_captures();
    for label in LABELS {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.set_content_protected(excluded);
        }
    }
}

/// Leave ZHU's windows out of a screenshot ZHU is about to take, and end that again. While ZHU is
/// hidden they are left out anyway, and ending the shield does not bring them back.
pub fn set_shield(app: &AppHandle, on: bool) {
    SHIELD.store(on, Ordering::SeqCst);
    protect(app);
}

/// Prepare a window for the switch. Call once per window, on the main thread. A window made while
/// ZHU is hidden (the floating icon is made on first use) is hidden from the start.
pub fn install(window: &WebviewWindow) {
    imp::install(window);
    if out_of_captures() {
        let _ = window.set_content_protected(true);
    }
    if is_hidden() {
        imp::apply(window, true);
    }
}

/// Hide ZHU from the taskbar, Alt+Tab and screen captures, or show it there again.
pub fn set_hidden(app: &AppHandle, hidden: bool) {
    // The switch first, then the windows: the style hook reads it while they change.
    HIDDEN.store(hidden, Ordering::SeqCst);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        protect(&handle);
        for label in LABELS {
            if let Some(w) = handle.get_webview_window(label) {
                imp::apply(&w, hidden);
            }
        }
        // The main window is on top of other windows exactly while ZHU is hidden.
        if let Some(main) = handle.get_webview_window("main") {
            let _ = main.set_always_on_top(hidden);
        }
        if hidden {
            imp::raise_sidecar(); // becoming "always on top" put the main window above it
        }
    });
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

    use tauri::WebviewWindow;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowLongPtrW, IsIconic, IsWindowVisible, SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST,
        SET_WINDOW_POS_FLAGS, STYLESTRUCT, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, SW_SHOW, SW_SHOWNA, WINDOWPOS, WM_NCDESTROY,
        WM_STYLECHANGING, WM_WINDOWPOSCHANGED, WM_WINDOWPOSCHANGING, WS_EX_TOPMOST,
    };

    use super::{ex_style, HIDDEN};

    /// Any number that no other subclass of these windows uses ("ZHU" + 2; resize_cursor.rs has + 1).
    const SUBCLASS_ID: usize = 0x5A48_5502;
    /// Where Windows itself puts a minimized window that has a taskbar button.
    const PARKED: i32 = -32000;

    /// Which window a hook is on (the hook's reference data).
    const OTHER: usize = 0;
    const MAIN: usize = 1;
    const SIDECAR: usize = 2;
    /// The sidecar's window handle, for the main window's hook; 0 while there is none.
    static SIDECAR_HWND: AtomicIsize = AtomicIsize::new(0);

    pub fn install(window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else { return };
        let role = match window.label() {
            "main" => MAIN,
            "sidecar" => SIDECAR,
            _ => OTHER,
        };
        if role == SIDECAR {
            SIDECAR_HWND.store(hwnd.0 as isize, Ordering::SeqCst);
        }
        unsafe {
            let _ = SetWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID, role);
        }
    }

    unsafe fn is_topmost(hwnd: HWND) -> bool {
        unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0 != 0 }
    }

    /// The sidecar, when it is on screen and set to stay on top (its own setting can switch that off).
    unsafe fn floating_sidecar() -> Option<HWND> {
        let hwnd = HWND(SIDECAR_HWND.load(Ordering::SeqCst) as *mut _);
        if hwnd.0.is_null() || !unsafe { IsWindowVisible(hwnd) }.as_bool() || !unsafe { is_topmost(hwnd) } {
            return None;
        }
        Some(hwnd)
    }

    /// Put the sidecar in front of the other always-on-top windows, without giving it the focus.
    pub fn raise_sidecar() {
        unsafe {
            if let Some(sidecar) = floating_sidecar() {
                let _ = SetWindowPos(sidecar, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }
    }

    pub fn apply(window: &WebviewWindow, hidden: bool) {
        let Ok(hwnd) = window.hwnd() else { return };
        unsafe {
            let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let wanted = ex_style(current, hidden);
            if wanted == current {
                return;
            }
            if !IsWindowVisible(hwnd).as_bool() {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted as isize);
                return;
            }
            // Hide, change, show. Hiding the window the user is working in hands the focus to
            // another one, so that window takes it back; any other is shown without taking it.
            let had_focus = GetForegroundWindow() == hwnd;
            transitions(hwnd, false); // no fade out and in: the window just stays where it is
            let _ = ShowWindow(hwnd, SW_HIDE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted as isize);
            let _ = ShowWindow(hwnd, if had_focus { SW_SHOW } else { SW_SHOWNA });
            if had_focus {
                let _ = SetForegroundWindow(hwnd);
            }
            transitions(hwnd, true);
        }
    }

    /// The show and hide animations of one window, on or off.
    unsafe fn transitions(hwnd: HWND, enabled: bool) {
        let disabled: BOOL = (!enabled).into();
        unsafe {
            let _ = DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, (&disabled as *const BOOL).cast(), std::mem::size_of::<BOOL>() as u32);
        }
    }

    /// The window procedure hook. It must never panic: it is called by Windows.
    unsafe extern "system" fn subclass(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, role: usize) -> LRESULT {
        if HIDDEN.load(Ordering::SeqCst) {
            if msg == WM_STYLECHANGING && wparam.0 as i32 == GWL_EXSTYLE.0 {
                // The extended style is about to be replaced: the new one keeps ZHU hidden.
                let style = lparam.0 as *mut STYLESTRUCT;
                if !style.is_null() {
                    unsafe {
                        (*style).styleNew = ex_style((*style).styleNew, true);
                    }
                }
            } else if msg == WM_WINDOWPOSCHANGING && lparam.0 != 0 {
                unsafe { placing(hwnd, role, &mut *(lparam.0 as *mut WINDOWPOS)) };
            } else if msg == WM_WINDOWPOSCHANGED && role == MAIN && lparam.0 != 0 {
                // The main window got a new place among the windows; a click on it brings it to
                // the front. Both it and the sidecar are "always on top" now, so that would cover
                // the sidecar: the sidecar goes back in front. (Windows asks for the new place in
                // more than one way, so this looks at the result and not at the request.)
                unsafe { keep_on_top(hwnd) };
                let moved_in_the_stack = unsafe { (*(lparam.0 as *const WINDOWPOS)).flags.0 } & SWP_NOZORDER.0 == 0;
                if moved_in_the_stack && unsafe { is_topmost(hwnd) } {
                    raise_sidecar();
                }
            }
        }
        if msg == WM_NCDESTROY {
            if role == SIDECAR {
                SIDECAR_HWND.store(0, Ordering::SeqCst);
            }
            unsafe {
                let _ = RemoveWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID);
            }
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    /// The main window of a hidden ZHU is on screen but no longer "always on top" (another program
    /// or a tool took that away, or it has just been shown): it is made so again. Placing it
    /// sends this window the same message again, so the flag keeps that from repeating.
    unsafe fn keep_on_top(hwnd: HWND) {
        static BUSY: AtomicBool = AtomicBool::new(false);
        unsafe {
            if is_topmost(hwnd) || !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return;
            }
            if BUSY.swap(true, Ordering::SeqCst) {
                return;
            }
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            BUSY.store(false, Ordering::SeqCst);
        }
    }

    /// A window of a hidden ZHU is about to be moved or shown; `position` is what Windows is about
    /// to do and may be changed here.
    unsafe fn placing(hwnd: HWND, role: usize, position: &mut WINDOWPOS) {
        let flags = position.flags.0;
        if unsafe { IsIconic(hwnd) }.as_bool() {
            // Placed as a minimized window: off screen, not as a stub on the desktop.
            if flags & SWP_NOMOVE.0 == 0 {
                position.x = PARKED;
                position.y = PARKED;
            }
        } else if role == SIDECAR && flags & SWP_SHOWWINDOW.0 != 0 && unsafe { is_topmost(hwnd) } {
            // The sidecar is shown again. Windows would leave it where it was among the windows,
            // which can be behind the main window; it comes up in front.
            position.flags = SET_WINDOW_POS_FLAGS(flags & !SWP_NOZORDER.0);
            position.hwndInsertAfter = HWND_TOPMOST;
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::WebviewWindow;

    pub fn install(_window: &WebviewWindow) {}
    pub fn raise_sidecar() {}

    /// Elsewhere only the main window has a taskbar or dock entry to leave out.
    pub fn apply(window: &WebviewWindow, hidden: bool) {
        if window.label() == "main" {
            let _ = window.set_skip_taskbar(hidden);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the window library writes for a plain window: window edge + app window.
    const PLAIN: u32 = 0x0004_0100;
    /// The sidecar with always-on-top and click-through: topmost, transparent, layered.
    const SIDECAR: u32 = PLAIN | 0x0000_0008 | 0x0000_0020 | 0x0008_0000;

    #[test]
    fn hiding_swaps_the_two_bits_and_keeps_the_rest() {
        for style in [PLAIN, SIDECAR] {
            let hidden = ex_style(style, true);
            assert_ne!(hidden & WS_EX_TOOLWINDOW, 0);
            assert_eq!(hidden & WS_EX_APPWINDOW, 0);
            assert_eq!(hidden & !(WS_EX_TOOLWINDOW | WS_EX_APPWINDOW), style & !WS_EX_APPWINDOW);
        }
    }

    #[test]
    fn showing_again_gives_back_the_style_it_had() {
        for style in [PLAIN, SIDECAR] {
            assert_eq!(ex_style(ex_style(style, true), false), style);
        }
    }

    #[test]
    fn a_style_the_window_library_writes_while_hidden_stays_hidden() {
        // This is what the hook does with each new style: the result is the same however often.
        let once = ex_style(PLAIN, true);
        assert_eq!(ex_style(once, true), once);
        assert_eq!(ex_style(SIDECAR, true), once | (SIDECAR & !PLAIN));
    }
}
