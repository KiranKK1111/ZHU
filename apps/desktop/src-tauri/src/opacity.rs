//! How see-through ZHU is: the opacity control in the title bar.
//!
//! It is Windows' own transparency for a whole window (a "layered" window with one alpha value),
//! not a fade drawn by the page. So it covers everything a window shows: the pages with their menus
//! and dialogs, and the chat sites inside the main window, which are separate web views that the
//! page cannot fade. It applies to every ZHU window (the main window and the floating icon).
//!
//! The window library writes a window's whole extended style again on many changes (show, hide,
//! maximize, always on top) and would drop the "layered" bit with it. A hook on the style change
//! keeps the bit while ZHU is see-through.

use std::sync::atomic::{AtomicU8, Ordering};

use tauri::{AppHandle, Manager, WebviewWindow};

/// The opacity of every ZHU window, 0..=255; 255 is opaque.
static ALPHA: AtomicU8 = AtomicU8::new(255);
/// The least opacity accepted, so a window can never become invisible and get lost.
const MIN_OPACITY: f64 = 0.3;
/// Every window ZHU has.
const LABELS: [&str; 2] = ["main", crate::bubble::LABEL];

/// The alpha value for an opacity from 0 to 1, within the accepted range.
fn alpha_for(opacity: f64) -> u8 {
    if !opacity.is_finite() {
        return 255;
    }
    (opacity.clamp(MIN_OPACITY, 1.0) * 255.0).round() as u8
}

/// Make every ZHU window this opaque (0 to 1).
pub fn set(app: &AppHandle, opacity: f64) {
    let alpha = alpha_for(opacity);
    if ALPHA.swap(alpha, Ordering::SeqCst) == alpha {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        for label in LABELS {
            // As windows: see crate::main_window.
            if let Some(window) = handle.get_window(label) {
                imp::apply(&window);
            }
        }
    });
}

/// Prepare a window: call once per window, on the main thread. A window made later (the floating
/// icon) takes the current opacity from the start.
pub fn install(window: &WebviewWindow) {
    imp::install(window);
    imp::apply(&window.as_ref().window());
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::sync::atomic::Ordering;

    use tauri::WebviewWindow;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, STYLESTRUCT, WM_NCDESTROY, WM_STYLECHANGING};

    use super::ALPHA;

    #[link(name = "user32")]
    extern "system" {
        fn SetLayeredWindowAttributes(hwnd: *mut c_void, key: u32, alpha: u8, flags: u32) -> i32;
        fn RedrawWindow(hwnd: *mut c_void, rect: *const c_void, region: *mut c_void, flags: u32) -> i32;
    }
    const WS_EX_LAYERED: u32 = 0x0008_0000;
    const LWA_ALPHA: u32 = 0x0000_0002;
    const RDW_INVALIDATE: u32 = 0x0001;
    const RDW_ERASE: u32 = 0x0004;
    const RDW_ALLCHILDREN: u32 = 0x0080;
    const RDW_FRAME: u32 = 0x0400;
    /// Any number that no other subclass of these windows uses ("ZHU" + 3; bars.rs has + 2).
    const SUBCLASS_ID: usize = 0x5A48_5503;

    pub fn install(window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else { return };
        unsafe {
            let _ = SetWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID, 0);
        }
    }

    pub fn apply(window: &tauri::Window) {
        let Ok(hwnd) = window.hwnd() else { return };
        let alpha = ALPHA.load(Ordering::SeqCst);
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            if alpha < 255 {
                if style & WS_EX_LAYERED == 0 {
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (style | WS_EX_LAYERED) as isize);
                }
                SetLayeredWindowAttributes(hwnd.0, 0, alpha, LWA_ALPHA);
            } else if style & WS_EX_LAYERED != 0 {
                // Opaque again: an ordinary window, which Windows then has to draw afresh.
                SetLayeredWindowAttributes(hwnd.0, 0, 255, LWA_ALPHA);
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (style & !WS_EX_LAYERED) as isize);
                RedrawWindow(hwnd.0, std::ptr::null(), std::ptr::null_mut(), RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN);
            }
        }
    }

    /// The window procedure hook. It must never panic: it is called by Windows.
    unsafe extern "system" fn subclass(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        if msg == WM_STYLECHANGING && wparam.0 as i32 == GWL_EXSTYLE.0 && ALPHA.load(Ordering::SeqCst) < 255 {
            // The extended style is about to be replaced: the new one stays see-through.
            let style = lparam.0 as *mut STYLESTRUCT;
            if !style.is_null() {
                unsafe { (*style).styleNew |= WS_EX_LAYERED };
            }
        }
        if msg == WM_NCDESTROY {
            unsafe {
                let _ = RemoveWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID);
            }
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::WebviewWindow;

    pub fn install(_window: &WebviewWindow) {}
    pub fn apply(_window: &tauri::Window) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opacity_becomes_an_alpha_value_within_the_accepted_range() {
        assert_eq!(alpha_for(1.0), 255);
        assert_eq!(alpha_for(0.5), 128);
        assert_eq!(alpha_for(0.4), 102);
        // Never invisible, whatever arrives.
        assert_eq!(alpha_for(0.0), alpha_for(MIN_OPACITY));
        assert_eq!(alpha_for(-3.0), alpha_for(MIN_OPACITY));
        assert_eq!(alpha_for(7.0), 255);
        assert_eq!(alpha_for(f64::NAN), 255);
        assert!(alpha_for(MIN_OPACITY) >= 76);
    }
}
