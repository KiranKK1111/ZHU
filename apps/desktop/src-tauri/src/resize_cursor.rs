//! The pointer at the edges of ZHU's main window: the arrow, like everywhere else in ZHU.
//!
//! Inside the window the pointer is styled by the page (src/styles/globals.css): only ever the
//! arrow. The edges are not part of the page: they are the window's resize border (the invisible
//! frame around a frameless window, and a thin native strip along the top), and Windows itself
//! picks the cursor there by asking the window "which cursor?" (WM_SETCURSOR) and, unanswered,
//! showing its double-headed resize arrows. This answers that question for the eight resize
//! positions with the standard arrow. Dragging the edges still resizes the window; only the
//! pointer's shape stays the same.

use tauri::WebviewWindow;

/// Keep the arrow at this window's edges. Call once per window, on the main thread.
pub fn install(window: &WebviewWindow) {
    imp::install(window);
}

/// The eight places on a window where dragging resizes it, as Windows numbers them.
#[cfg(windows)]
fn is_resize_border(hit: u32) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT};
    [HTLEFT, HTRIGHT, HTTOP, HTBOTTOM, HTTOPLEFT, HTTOPRIGHT, HTBOTTOMLEFT, HTBOTTOMRIGHT].contains(&hit)
}

#[cfg(windows)]
mod imp {
    use tauri::WebviewWindow;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, LoadCursorW, SetCursor, IDC_ARROW, WM_NCDESTROY, WM_SETCURSOR};

    /// Any number that no other subclass of these windows uses ("ZHU" + 1).
    const SUBCLASS_ID: usize = 0x5A48_5501;

    pub fn install(window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else { return };
        unsafe {
            let _ = SetWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID, 0);
            // The strip along the top edge of a frameless window is a small window of its own,
            // made by the window library (tauri-runtime-wry, undecorated_resizing.rs), and it does
            // not pass the question on to its parent. Its names are that library's; if a later
            // version renames it, the top edge simply shows the resize arrow again.
            if let Ok(strip) = FindWindowExW(Some(hwnd), None, w!("TAURI_DRAG_RESIZE_BORDERS"), w!("TAURI_DRAG_RESIZE_WINDOW")) {
                let _ = SetWindowSubclass(strip, Some(subclass), SUBCLASS_ID, 0);
            }
        }
    }

    /// The window procedure hook. It must never panic: it is called by Windows.
    unsafe extern "system" fn subclass(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        // The low word says where on the window the mouse is.
        if msg == WM_SETCURSOR && super::is_resize_border((lparam.0 & 0xFFFF) as u32) {
            if let Ok(arrow) = unsafe { LoadCursorW(None, IDC_ARROW) } {
                unsafe {
                    SetCursor(Some(arrow));
                }
                return LRESULT(1); // answered: Windows does not set its own
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
    pub fn install(_window: &tauri::WebviewWindow) {}
}

#[cfg(all(test, windows))]
mod tests {
    use super::is_resize_border;
    use windows::Win32::UI::WindowsAndMessaging::{HTBOTTOMRIGHT, HTCAPTION, HTCLIENT, HTLEFT, HTTOP};

    #[test]
    fn only_the_resize_border_is_answered() {
        assert!(is_resize_border(HTLEFT) && is_resize_border(HTTOP) && is_resize_border(HTBOTTOMRIGHT));
        // Inside the window the page decides (it shows the arrow too).
        assert!(!is_resize_border(HTCLIENT) && !is_resize_border(HTCAPTION));
    }
}
