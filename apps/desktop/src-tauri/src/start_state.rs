//! How ZHU was when it closed, so that it opens the same way: hidden or not (the eye button,
//! bars.rs), and the opacity in each of those (opacity.rs). The window's size, place and
//! maximized state are kept by Tauri's window-state plugin, and the page keeps its own
//! preferences; these two are the shell's, because they have to be in place before the window
//! first appears: a ZHU that was hidden must not show in the taskbar or a screen share for even a
//! moment while it starts.
//!
//! Kept in `start-state.json` in ZHU's folder under `%LOCALAPPDATA%`, written whenever one of
//! them changes.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Where the opacity starts when ZHU is hidden (the page's HIDDEN_OPACITY).
const HIDDEN_OPACITY: f64 = 0.8;
/// The least opacity there is (the page's MIN_OPACITY).
const MIN_OPACITY: f64 = 0.4;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StartState {
    /// Hidden from the taskbar, Alt+Tab and screen captures.
    pub hidden: bool,
    /// The opacity while hidden.
    pub hidden_opacity: Option<f64>,
    /// The opacity otherwise.
    pub opacity: Option<f64>,
}

impl StartState {
    /// The opacity ZHU opens with, before its page is there to set it.
    pub fn opacity_at_start(&self) -> Option<f64> {
        let level = if self.hidden { Some(self.hidden_opacity.unwrap_or(HIDDEN_OPACITY)) } else { self.opacity };
        level.filter(|v| v.is_finite()).map(|v| v.clamp(MIN_OPACITY, 1.0))
    }

    fn parse(text: &str) -> StartState {
        serde_json::from_str(text).unwrap_or_default()
    }
}

/// The state as last read or written.
static CURRENT: Mutex<Option<StartState>> = Mutex::new(None);

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|dir| dir.join("start-state.json"))
}

/// How ZHU was when it closed (all off and unknown the first time, or if the file is unreadable).
pub fn load(app: &AppHandle) -> StartState {
    let state = file(app).and_then(|path| std::fs::read_to_string(path).ok()).map(|text| StartState::parse(&text)).unwrap_or_default();
    if let Ok(mut current) = CURRENT.lock() {
        *current = Some(state);
    }
    state
}

/// ZHU was hidden or shown again.
pub fn remember_hidden(app: &AppHandle, hidden: bool) {
    change(app, |s| s.hidden = hidden);
}

/// The opacity was set, while ZHU was hidden or not.
pub fn remember_opacity(app: &AppHandle, opacity: f64, hidden: bool) {
    if !opacity.is_finite() {
        return;
    }
    let level = Some((opacity.clamp(MIN_OPACITY, 1.0) * 100.0).round() / 100.0);
    change(app, |s| if hidden { s.hidden_opacity = level } else { s.opacity = level });
}

/// The opacity ZHU had while hidden, for a page that has just loaded in a hidden ZHU.
pub fn hidden_opacity() -> Option<f64> {
    CURRENT.lock().ok().and_then(|c| *c).and_then(|s| s.hidden_opacity)
}

fn change(app: &AppHandle, edit: impl FnOnce(&mut StartState)) {
    let Ok(mut current) = CURRENT.lock() else { return };
    let before = current.unwrap_or_default();
    let mut state = before;
    edit(&mut state);
    *current = Some(state);
    if state == before {
        return;
    }
    let Some(path) = file(app) else { return };
    let Ok(text) = serde_json::to_string_pretty(&state) else { return };
    // Written beside it first and then put in its place, so a crash never leaves half a file.
    let partial = path.with_extension("json.partial");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::write(&partial, text).is_ok() {
        let _ = std::fs::rename(&partial, &path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_opens_hidden_at_the_opacity_it_had_then() {
        let s = StartState::parse(r#"{ "hidden": true, "hidden_opacity": 0.65, "opacity": 0.9 }"#);
        assert_eq!(s, StartState { hidden: true, hidden_opacity: Some(0.65), opacity: Some(0.9) });
        assert_eq!(s.opacity_at_start(), Some(0.65));
        // Shown: the everyday opacity.
        assert_eq!(StartState { hidden: false, ..s }.opacity_at_start(), Some(0.9));
    }

    #[test]
    fn missing_or_odd_values_fall_back_safely() {
        // The first start, or a file from another version.
        assert_eq!(StartState::parse(""), StartState::default());
        assert_eq!(StartState::parse("not json"), StartState::default());
        let s = StartState::parse(r#"{ "hidden": true, "something_else": 1 }"#);
        assert!(s.hidden);
        assert_eq!(s.opacity_at_start(), Some(HIDDEN_OPACITY));
        assert_eq!(StartState::default().opacity_at_start(), None);
        assert_eq!(StartState { opacity: Some(0.1), ..Default::default() }.opacity_at_start(), Some(MIN_OPACITY));
    }
}
