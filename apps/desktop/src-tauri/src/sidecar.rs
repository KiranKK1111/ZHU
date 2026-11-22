//! Sidecar window behavior: edge snapping after a drag, and recovery when the window
//! would otherwise be stranded off-screen (monitor unplugged, resolution or scale change).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Monitor, PhysicalPosition, WebviewWindow, WindowEvent};

const SNAP_DISTANCE: f64 = 24.0; // logical px
const SETTLE: Duration = Duration::from_millis(350);
const MIN_VISIBLE: i32 = 80; // physical px of the window that must stay on some monitor

pub fn install(window: &WebviewWindow) {
    ensure_visible_on_screen(window);
    let last_move: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
    let w = window.clone();
    let lm = Arc::clone(&last_move);
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) => {
            *lm.lock().unwrap() = Some(Instant::now());
            let w2 = w.clone();
            let lm2 = Arc::clone(&lm);
            std::thread::spawn(move || {
                std::thread::sleep(SETTLE);
                let settled = lm2.lock().unwrap().map(|t| t.elapsed() >= SETTLE - Duration::from_millis(20)).unwrap_or(false);
                if settled {
                    *lm2.lock().unwrap() = None;
                    snap_to_edges(&w2);
                }
            });
        }
        WindowEvent::ScaleFactorChanged { .. } => ensure_visible_on_screen(&w),
        _ => {}
    });
    // Display configuration can change without any window event; check periodically (cheap).
    let w = window.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        if w.is_visible().unwrap_or(false) {
            ensure_visible_on_screen(&w);
        }
    });
}

struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

fn work_area(m: &Monitor) -> Rect {
    let wa = m.work_area();
    Rect { x: wa.position.x, y: wa.position.y, w: wa.size.width as i32, h: wa.size.height as i32 }
}

fn window_rect(w: &WebviewWindow) -> Option<Rect> {
    let p = w.outer_position().ok()?;
    let s = w.outer_size().ok()?;
    Some(Rect { x: p.x, y: p.y, w: s.width as i32, h: s.height as i32 })
}

fn overlap(a: &Rect, b: &Rect) -> (i32, i32) {
    let ox = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x);
    let oy = (a.y + a.h).min(b.y + b.h) - a.y.max(b.y);
    (ox.max(0), oy.max(0))
}

fn snap_to_edges(w: &WebviewWindow) {
    let (Some(r), Ok(Some(m))) = (window_rect(w), w.current_monitor()) else { return };
    let area = work_area(&m);
    let threshold = (SNAP_DISTANCE * m.scale_factor()) as i32;
    let mut x = r.x;
    let mut y = r.y;
    if (r.x - area.x).abs() <= threshold {
        x = area.x;
    } else if ((area.x + area.w) - (r.x + r.w)).abs() <= threshold {
        x = area.x + area.w - r.w;
    }
    if (r.y - area.y).abs() <= threshold {
        y = area.y;
    } else if ((area.y + area.h) - (r.y + r.h)).abs() <= threshold {
        y = area.y + area.h - r.h;
    }
    if (x, y) != (r.x, r.y) {
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
}

/// If less than MIN_VISIBLE px of the window (or its header) is on any monitor, move it
/// to the bottom-right corner of the primary monitor's work area.
pub fn ensure_visible_on_screen(w: &WebviewWindow) {
    keep_on_screen(w, MIN_VISIBLE);
}

/// The same, for any window: `min_visible` physical px of it must stay on some monitor.
pub fn keep_on_screen(w: &WebviewWindow, min_visible: i32) {
    let Some(r) = window_rect(w) else { return };
    let Ok(monitors) = w.available_monitors() else { return };
    let header = Rect { x: r.x, y: r.y, w: r.w, h: 40.min(r.h) };
    let visible = monitors.iter().any(|m| {
        let (ox, oy) = overlap(&header, &work_area(m));
        ox >= min_visible.min(r.w) && oy >= 16.min(r.h)
    });
    if visible {
        return;
    }
    let target = w.primary_monitor().ok().flatten().or_else(|| monitors.into_iter().next());
    if let Some(m) = target {
        let a = work_area(&m);
        let margin = (16.0 * m.scale_factor()) as i32;
        let x = a.x + a.w - r.w.min(a.w) - margin;
        let y = a.y + a.h - r.h.min(a.h) - margin;
        let _ = w.set_position(PhysicalPosition::new(x.max(a.x), y.max(a.y)));
    }
}
