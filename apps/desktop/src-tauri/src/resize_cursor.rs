//! ZHU's own resize cursors at the edges of its windows.
//!
//! Inside a window the pointer is styled by the page (src/styles/cursors.ts). The edges are not
//! part of the page: they are the window's resize border (the invisible frame around a frameless
//! window, and a thin native strip along the top), and Windows itself picks the cursor there by
//! asking the window "which cursor?" (WM_SETCURSOR) and, unanswered, showing its standard resize
//! arrows. This answers that question for the eight resize positions with ZHU's own double
//! arrows, in the style of its pointer, while the "Custom pointer" preference is on.
//!
//! The images are the PNGs that `npm run icons` renders from public/cursors/resize-*.svg, at the
//! sizes of 100 %, 125 %, 150 % and 200 % screen scaling; the one nearest the window's scaling is used.

use tauri::WebviewWindow;

/// Show ZHU's resize cursors at this window's edges. Call once per window, on the main thread.
pub fn install(window: &WebviewWindow) {
    imp::install(window);
}

/// The "Custom pointer" preference.
pub fn set_enabled(enabled: bool) {
    imp::set_enabled(enabled);
}

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    use tauri::WebviewWindow;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateIconIndirect, FindWindowExW, SetCursor, HCURSOR, HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT, ICONINFO, WM_NCDESTROY,
        WM_SETCURSOR,
    };

    static ENABLED: AtomicBool = AtomicBool::new(true);
    /// Any number that no other subclass of these windows uses ("ZHU" + 1).
    const SUBCLASS_ID: usize = 0x5A48_5501;

    /// Left-right, up-down, and the two diagonals.
    const EW: usize = 0;
    const NS: usize = 1;
    const NWSE: usize = 2;
    const NESW: usize = 3;
    const SIZES: [u32; 4] = [32, 40, 48, 64];
    const IMAGES: [[&[u8]; 4]; 4] = [
        [include_bytes!("../cursors/ew-32.png"), include_bytes!("../cursors/ew-40.png"), include_bytes!("../cursors/ew-48.png"), include_bytes!("../cursors/ew-64.png")],
        [include_bytes!("../cursors/ns-32.png"), include_bytes!("../cursors/ns-40.png"), include_bytes!("../cursors/ns-48.png"), include_bytes!("../cursors/ns-64.png")],
        [
            include_bytes!("../cursors/nwse-32.png"),
            include_bytes!("../cursors/nwse-40.png"),
            include_bytes!("../cursors/nwse-48.png"),
            include_bytes!("../cursors/nwse-64.png"),
        ],
        [
            include_bytes!("../cursors/nesw-32.png"),
            include_bytes!("../cursors/nesw-40.png"),
            include_bytes!("../cursors/nesw-48.png"),
            include_bytes!("../cursors/nesw-64.png"),
        ],
    ];

    /// Cursors made so far: (direction, size index) -> cursor handle. They live as long as the app.
    static MADE: Mutex<Option<HashMap<(usize, usize), isize>>> = Mutex::new(None);

    pub fn set_enabled(enabled: bool) {
        ENABLED.store(enabled, Ordering::Relaxed);
    }

    pub fn install(window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else { return };
        unsafe {
            let _ = SetWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID, 0);
            // The strip along the top edge of a frameless window is a small window of its own,
            // made by the window library (tauri-runtime-wry, undecorated_resizing.rs), and it does
            // not pass the question on to its parent. Its names are that library's; if a later
            // version renames it, the top edge simply keeps the standard cursor.
            if let Ok(strip) = FindWindowExW(Some(hwnd), None, w!("TAURI_DRAG_RESIZE_BORDERS"), w!("TAURI_DRAG_RESIZE_WINDOW")) {
                let _ = SetWindowSubclass(strip, Some(subclass), SUBCLASS_ID, 0);
            }
        }
    }

    /// The window procedure hook. It must never panic: it is called by Windows.
    unsafe extern "system" fn subclass(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        // Not while ZHU is hidden: a screen share shows the mouse pointer as it is, so over a
        // hidden ZHU it stays the standard Windows one (the page does the same, AppProviders.tsx).
        if msg == WM_SETCURSOR && ENABLED.load(Ordering::Relaxed) && !crate::bars::is_hidden() {
            // The low word says where on the window the mouse is.
            let hit = (lparam.0 & 0xFFFF) as u32;
            let direction = if hit == HTLEFT || hit == HTRIGHT {
                Some(EW)
            } else if hit == HTTOP || hit == HTBOTTOM {
                Some(NS)
            } else if hit == HTTOPLEFT || hit == HTBOTTOMRIGHT {
                Some(NWSE)
            } else if hit == HTTOPRIGHT || hit == HTBOTTOMLEFT {
                Some(NESW)
            } else {
                None
            };
            if let Some(cursor) = direction.and_then(|d| cursor(d, hwnd)) {
                unsafe {
                    SetCursor(Some(HCURSOR(cursor as _)));
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

    /// The cursor for a direction at the window's screen scaling, made on first use.
    fn cursor(direction: usize, hwnd: HWND) -> Option<isize> {
        let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
        let wanted = 32 * dpi / 96;
        let size = (0..SIZES.len()).min_by_key(|&i| SIZES[i].abs_diff(wanted))?;
        let mut made = MADE.lock().ok()?;
        let made = made.get_or_insert_with(HashMap::new);
        if let Some(&handle) = made.get(&(direction, size)) {
            return Some(handle);
        }
        let handle = create(IMAGES[direction][size])?;
        made.insert((direction, size), handle);
        Some(handle)
    }

    /// A Windows cursor from a PNG, with its hot spot in the middle.
    fn create(png: &[u8]) -> Option<isize> {
        let image = tauri::image::Image::from_bytes(png).ok()?;
        let (width, height) = (image.width(), image.height());
        if width == 0 || height == 0 || image.rgba().len() != (width * height * 4) as usize {
            return None;
        }
        // Windows wants blue-green-red-alpha.
        let mut bgra = image.rgba().to_vec();
        for pixel in bgra.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
        // With an alpha channel in the colour bitmap the mask is not used, but it has to exist.
        let mask = vec![0xFFu8; ((((width + 15) >> 4) << 1) * height) as usize];
        unsafe {
            let colour = CreateBitmap(width as i32, height as i32, 1, 32, Some(bgra.as_ptr().cast()));
            let mask = CreateBitmap(width as i32, height as i32, 1, 1, Some(mask.as_ptr().cast()));
            let info = ICONINFO { fIcon: false.into(), xHotspot: width / 2, yHotspot: height / 2, hbmMask: mask, hbmColor: colour };
            let cursor = CreateIconIndirect(&info);
            let _ = DeleteObject(colour.into());
            let _ = DeleteObject(mask.into());
            cursor.ok().map(|c| c.0 as isize)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn install(_window: &tauri::WebviewWindow) {}
    pub fn set_enabled(_enabled: bool) {}
}
