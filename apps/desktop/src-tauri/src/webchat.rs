//! Embedded web chat tabs (ChatGPT, Claude, Gemini, Qwen, Meta AI, …).
//!
//! Each tab is a child webview of the main window that shows the provider's own website. All tabs
//! share one WebView2 profile (`…\app.zhu.desktop\webchat`), separate from the profile of ZHU's own
//! UI, so a sign-in is done once and is then valid in every tab and after a restart.
//!
//! Security boundaries:
//! * The sites are remote content. Tauri rejects every IPC command from a non-local origin unless a
//!   capability names that origin, and no capability does; the capability file also lists ZHU's own
//!   webviews by label, so a chat webview never matches it. A chat page therefore cannot call
//!   `engine_info` (the engine token) or any other command.
//! * Navigation is limited to https, so a page cannot open ZHU's own bundled UI inside a chat tab.
//! * ZHU fills the message box and attaches screenshots; it never signs in and never presses Send.
//!   The only script it runs in a page is `webchat_inject.js`, with data passed as JSON literals.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

const INJECT_JS: &str = include_str!("webchat_inject.js");
const LABEL_PREFIX: &str = "chat-";
const EVENT: &str = "zhu://webchat";
/// Base64 characters per `eval` when staging an image in the page.
const STAGE_CHUNK: usize = 256 * 1024;
/// Largest image accepted for delivery (base64 characters, about 9 MB of image data).
const MAX_IMAGE_B64: usize = 12 * 1024 * 1024;
const MAX_IMAGES: usize = 10;
const MAX_TEXT: usize = 100_000;

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Bounds {
    fn sane(self) -> Option<Self> {
        let ok = [self.x, self.y, self.width, self.height].iter().all(|v| v.is_finite());
        (ok && self.width >= 1.0 && self.height >= 1.0).then_some(self)
    }
}

#[derive(Default)]
pub struct WebChatState {
    bounds: Mutex<Option<Bounds>>,
    visible: Mutex<Option<String>>,
    /// Tab id -> when its current page finished loading (None while a load is in progress).
    loaded: Mutex<HashMap<String, Option<Instant>>>,
    /// Tab id -> the text ZHU last put into that tab's message box. The page helper forgets it when
    /// the page reloads; sites often restore an unsent draft after a reload, and without this the
    /// next question would be appended to ZHU's own stale draft instead of replacing it.
    last_text: Mutex<HashMap<String, String>>,
    job: AtomicU64,
}

#[derive(Clone, Serialize)]
struct TabEvent<'a> {
    id: &'a str,
    kind: &'a str,
    url: Option<String>,
    title: Option<String>,
}

#[derive(Serialize)]
pub struct TabSnapshot {
    id: String,
    url: Option<String>,
    loading: bool,
}

#[derive(Deserialize)]
pub struct DeliverImage {
    id: String,
    name: String,
    mime: String,
    /// Base64 image bytes.
    data: String,
}

#[derive(Deserialize)]
pub struct DeliverPayload {
    /// Site key for the message-box hints in `webchat_inject.js` ("chatgpt", "claude", …, or "custom").
    service: String,
    text: Option<String>,
    #[serde(default)]
    images: Vec<DeliverImage>,
    /// Attach images even if they were already attached to this page (manual "send again").
    #[serde(default)]
    force: bool,
}

fn label_for(id: &str) -> Result<String, String> {
    let ok = !id.is_empty() && id.len() <= 48 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok {
        Ok(format!("{LABEL_PREFIX}{id}"))
    } else {
        Err("invalid tab id".into())
    }
}

fn parse_https(url: &str) -> Result<Url, String> {
    let u = Url::parse(url).map_err(|e| format!("invalid address: {e}"))?;
    if u.scheme() != "https" || u.host_str().is_none() {
        return Err("only https addresses can be opened in a chat tab".into());
    }
    Ok(u)
}

/// Top-level navigations a chat tab may make: https pages (sign-in redirects included) and blank pages.
fn navigation_allowed(url: &Url) -> bool {
    match url.scheme() {
        "https" => !matches!(url.host_str(), Some(h) if h == "tauri.localhost" || h.ends_with(".localhost")),
        "about" => true,
        _ => false,
    }
}

fn chat_webviews(app: &AppHandle) -> Vec<Webview> {
    app.webviews().into_iter().filter(|(label, _)| label.starts_with(LABEL_PREFIX)).map(|(_, w)| w).collect()
}

fn emit(app: &AppHandle, id: &str, kind: &str, url: Option<String>, title: Option<String>) {
    let _ = app.emit_to("main", EVENT, TabEvent { id, kind, url, title });
}

fn place(wv: &Webview, b: Bounds) -> Result<(), String> {
    wv.set_position(LogicalPosition::new(b.x, b.y)).map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(b.width, b.height)).map_err(|e| e.to_string())
}

// ============================================================== commands
// Every command is async: creating a webview from a synchronous command deadlocks on Windows.

/// Create the tab's webview if it does not exist yet (hidden). Returns true when it was created.
#[tauri::command]
pub async fn webchat_open(app: AppHandle, id: String, url: String) -> Result<bool, String> {
    let label = label_for(&id)?;
    if app.get_webview(&label).is_some() {
        return Ok(false);
    }
    let url = parse_https(&url)?;
    let window = app.get_window("main").ok_or("main window missing")?;
    let profile = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("webchat");
    let state = app.state::<WebChatState>();
    state.loaded.lock().unwrap().insert(id.clone(), None);

    // Keep SmartScreen on for third-party sites (Tauri's default arguments turn it off).
    #[allow(unused_mut)]
    let mut browser_args = String::from("--disable-features=msWebOOUI,msPdfOOUI");
    // Test harness only: debug builds can expose the chat profile to DevTools. Release builds never do.
    #[cfg(debug_assertions)]
    if let Some(port) = std::env::var("ZHU_WEBCHAT_DEBUG_PORT").ok().and_then(|p| p.parse::<u16>().ok()) {
        browser_args.push_str(&format!(" --remote-debugging-port={port}"));
    }

    let (load_app, load_id) = (app.clone(), id.clone());
    let (title_app, title_id) = (app.clone(), id.clone());
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .data_directory(profile)
        .additional_browser_args(&browser_args)
        .on_navigation(navigation_allowed)
        .on_page_load(move |_wv, payload| {
            let finished = matches!(payload.event(), PageLoadEvent::Finished);
            let st = load_app.state::<WebChatState>();
            st.loaded.lock().unwrap().insert(load_id.clone(), finished.then(Instant::now));
            emit(&load_app, &load_id, if finished { "loaded" } else { "loading" }, Some(payload.url().to_string()), None);
        })
        .on_document_title_changed(move |wv, title| {
            emit(&title_app, &title_id, "title", wv.url().ok().map(|u| u.to_string()), Some(title));
        });

    // Created off-screen at the size of the tab area, so the site lays out normally even when the
    // tab has never been shown (a delivery can target a tab the user has not opened yet).
    let b = (*state.bounds.lock().unwrap()).unwrap_or(Bounds { x: 0.0, y: 0.0, width: 1100.0, height: 700.0 });
    let wv = match window.add_child(builder, LogicalPosition::new(-20000.0, -20000.0), LogicalSize::new(b.width, b.height)) {
        Ok(wv) => wv,
        // Two callers raced to open the same tab: the other one created it.
        Err(_) if app.get_webview(&label).is_some() => return Ok(false),
        Err(e) => {
            state.loaded.lock().unwrap().remove(&id);
            return Err(format!("could not create the chat tab: {e}"));
        }
    };
    let show = state.visible.lock().unwrap().as_deref() == Some(id.as_str());
    if show {
        place(&wv, b)?;
    } else {
        let _ = wv.hide();
    }
    Ok(true)
}

/// Show one tab in the given area of the main window (logical pixels) and hide the others.
#[tauri::command]
pub async fn webchat_show(app: AppHandle, id: String, bounds: Bounds) -> Result<(), String> {
    let label = label_for(&id)?;
    let b = bounds.sane().ok_or("invalid bounds")?;
    let state = app.state::<WebChatState>();
    *state.bounds.lock().unwrap() = Some(b);
    *state.visible.lock().unwrap() = Some(id.clone());
    if let Some(wv) = app.get_webview(&label) {
        place(&wv, b)?;
        wv.show().map_err(|e| e.to_string())?;
    }
    for other in chat_webviews(&app) {
        if other.label() != label {
            let _ = other.hide();
        }
    }
    Ok(())
}

/// Hide every chat tab (another screen, a dialog or a menu is in front).
#[tauri::command]
pub async fn webchat_hide(app: AppHandle) -> Result<(), String> {
    *app.state::<WebChatState>().visible.lock().unwrap() = None;
    for wv in chat_webviews(&app) {
        let _ = wv.hide();
    }
    Ok(())
}

#[tauri::command]
pub async fn webchat_close(app: AppHandle, id: String) -> Result<(), String> {
    let label = label_for(&id)?;
    let state = app.state::<WebChatState>();
    state.loaded.lock().unwrap().remove(&id);
    state.last_text.lock().unwrap().remove(&id);
    {
        let mut visible = state.visible.lock().unwrap();
        if visible.as_deref() == Some(id.as_str()) {
            *visible = None;
        }
    }
    if let Some(wv) = app.get_webview(&label) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Back, forward, reload, or go to an https address.
#[tauri::command]
pub async fn webchat_navigate(app: AppHandle, id: String, action: String, url: Option<String>) -> Result<(), String> {
    let wv = app.get_webview(&label_for(&id)?).ok_or("this chat tab is not loaded")?;
    match action.as_str() {
        "back" => wv.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => wv.eval("history.forward()").map_err(|e| e.to_string()),
        "reload" => wv.reload().map_err(|e| e.to_string()),
        "goto" => wv.navigate(parse_https(url.as_deref().unwrap_or_default())?).map_err(|e| e.to_string()),
        _ => Err("unknown navigation action".into()),
    }
}

/// Loaded tabs with their current address.
#[tauri::command]
pub async fn webchat_tabs(app: AppHandle) -> Vec<TabSnapshot> {
    let state = app.state::<WebChatState>();
    let loaded = state.loaded.lock().unwrap().clone();
    chat_webviews(&app)
        .into_iter()
        .map(|wv| {
            let id = wv.label()[LABEL_PREFIX.len()..].to_string();
            let loading = !matches!(loaded.get(&id), Some(Some(_)));
            TabSnapshot { url: wv.url().ok().map(|u| u.to_string()), loading, id }
        })
        .collect()
}

/// Sign out everywhere: clear cookies and site data of the shared chat profile.
#[tauri::command]
pub async fn webchat_clear_data(app: AppHandle) -> Result<(), String> {
    let views = chat_webviews(&app);
    if let Some(first) = views.first() {
        // One profile for all tabs, so clearing through any tab clears it for all of them.
        first.clear_all_browsing_data().map_err(|e| e.to_string())?;
        for wv in &views {
            let _ = wv.reload();
        }
        return Ok(());
    }
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("webchat");
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("the chat profile is still in use ({e}). Try again in a few seconds.")),
    }
}

/// Put text into the tab's message box and attach images to the draft. Never submits.
#[tauri::command]
pub async fn webchat_deliver(app: AppHandle, id: String, payload: DeliverPayload) -> Result<Value, String> {
    let wv = app.get_webview(&label_for(&id)?).ok_or("this chat tab is not loaded")?;
    let text = payload.text.unwrap_or_default();
    if text.len() > MAX_TEXT {
        return Err("text is too long".into());
    }
    if payload.images.len() > MAX_IMAGES {
        return Err(format!("at most {MAX_IMAGES} images per delivery"));
    }
    for img in &payload.images {
        if img.data.len() > MAX_IMAGE_B64 {
            return Err("image is too large to attach".into());
        }
        // The data is spliced into a script as a string literal; allow the base64 alphabet only.
        if !img.data.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=') {
            return Err("image data is not valid base64".into());
        }
        if !img.mime.starts_with("image/") {
            return Err("only images can be attached".into());
        }
    }
    let state = app.state::<WebChatState>();
    let job = state.job.fetch_add(1, Ordering::SeqCst) + 1;
    // A page that finished loading a while ago and still has no message box is most likely a
    // sign-in page; a page that is still loading gets more time.
    let settled = matches!(state.loaded.lock().unwrap().get(&id), Some(Some(t)) if t.elapsed() > Duration::from_secs(8));
    let find_budget = Duration::from_secs(if settled { 6 } else { 30 });
    let previous = state.last_text.lock().unwrap().get(&id).cloned().unwrap_or_default();
    let app2 = app.clone();
    let tab_id = id.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let meta = json!({
            "job": job,
            "service": payload.service,
            "text": text,
            "previous": previous,
            "force": payload.force,
            "images": payload.images.iter().map(|i| json!({"id": i.id, "name": i.name, "mime": i.mime})).collect::<Vec<_>>(),
        });
        let install = |wv: &Webview| -> Result<(), String> {
            wv.eval(INJECT_JS).map_err(|e| e.to_string())?;
            for (index, img) in payload.images.iter().enumerate() {
                for chunk in img.data.as_bytes().chunks(STAGE_CHUNK) {
                    // Safe: the data was checked to be ASCII base64 above.
                    let chunk = std::str::from_utf8(chunk).unwrap_or_default();
                    wv.eval(format!("window.__zhu&&window.__zhu.stage({job},{index},\"{chunk}\")")).map_err(|e| e.to_string())?;
                }
            }
            wv.eval(format!("window.__zhu&&window.__zhu.begin({meta})")).map_err(|e| e.to_string())
        };
        install(&wv)?;

        let started = Instant::now();
        let mut finding_since = Instant::now();
        // When the document has been fully loaded for a while and still shows no message box, more
        // waiting will not help: it is a sign-in page, a consent wall, or an unsupported site.
        let mut complete_since: Option<Instant> = None;
        // A sign-in page that stays for a few seconds is not a redirect on the way to the chat.
        let mut sign_in_since: Option<Instant> = None;
        let mut last_url = String::new();
        loop {
            std::thread::sleep(Duration::from_millis(150));
            // The tab may have been closed while we waited.
            if app2.get_webview(wv.label()).is_none() {
                return Err("the chat tab was closed".into());
            }
            let status = match eval_json(&wv, format!("window.__zhu?window.__zhu.step({job}):({{\"done\":true,\"ok\":false,\"reason\":\"unknown_job\"}})")) {
                Ok(v) => v,
                Err(_) if started.elapsed() < Duration::from_secs(40) => continue, // mid-navigation
                Err(e) => return Err(e),
            };
            if status.get("done").and_then(Value::as_bool) == Some(true) {
                if status.get("reason").and_then(Value::as_str) == Some("unknown_job") && started.elapsed() < Duration::from_secs(40) {
                    // The page navigated (a new document has no helper and no job): start over there.
                    install(&wv)?;
                    finding_since = Instant::now();
                    complete_since = None;
                    sign_in_since = None;
                    continue;
                }
                if status.get("text").and_then(Value::as_str) == Some("replace") {
                    app2.state::<WebChatState>().last_text.lock().unwrap().insert(tab_id.clone(), text.clone());
                }
                return Ok(status);
            }
            if let Some(u) = status.get("url").and_then(Value::as_str) {
                last_url = u.to_string();
            }
            let finding = status.get("phase").and_then(Value::as_str) == Some("find");
            if !finding {
                finding_since = Instant::now();
            }
            if finding && status.get("ready").and_then(Value::as_str) == Some("complete") {
                complete_since.get_or_insert_with(Instant::now);
            } else {
                complete_since = None;
            }
            if finding && status.get("sign_in").and_then(Value::as_bool) == Some(true) {
                sign_in_since.get_or_insert_with(Instant::now);
            } else {
                sign_in_since = None;
            }
            let stalled = matches!(complete_since, Some(t) if t.elapsed() > Duration::from_secs(10));
            let sign_in = matches!(sign_in_since, Some(t) if t.elapsed() > Duration::from_secs(4));
            if (finding && (stalled || sign_in || finding_since.elapsed() > find_budget)) || started.elapsed() > Duration::from_secs(60) {
                let _ = wv.eval(format!("window.__zhu&&window.__zhu.cancel({job})"));
                return Ok(json!({
                    "done": true,
                    "ok": false,
                    "reason": if sign_in { "sign_in" } else if finding { "no_message_box" } else { "timeout" },
                    "url": last_url,
                }));
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Evaluate an expression in the page and return its JSON-serialized value.
fn eval_json(wv: &Webview, js: String) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel::<String>();
    wv.eval_with_callback(js, move |s| {
        let _ = tx.send(s);
    })
    .map_err(|e| e.to_string())?;
    let raw = rx.recv_timeout(Duration::from_secs(3)).map_err(|_| "the page did not respond".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("unexpected page reply: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_ids_are_restricted() {
        assert_eq!(label_for("chatgpt-1a2b").unwrap(), "chat-chatgpt-1a2b");
        // Every label carries the "chat-" prefix, so an id can never address ZHU's own webviews.
        assert_eq!(label_for("main").unwrap(), "chat-main");
        for bad in ["", "a b", "../x", "a/b", "a.b", &"x".repeat(49)] {
            assert!(label_for(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn only_https_pages_open() {
        assert!(parse_https("https://chatgpt.com").is_ok());
        for bad in ["http://chatgpt.com", "file:///C:/Windows/win.ini", "javascript:alert(1)", "tauri://localhost", "chatgpt.com", "https://"] {
            assert!(parse_https(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn navigation_stays_on_the_web() {
        let ok = |s: &str| navigation_allowed(&Url::parse(s).unwrap());
        assert!(ok("https://accounts.google.com/o/oauth2/auth") && ok("about:blank"));
        // ZHU's own UI (which has IPC access) must never load inside a chat tab.
        assert!(!ok("https://tauri.localhost/index.html") && !ok("http://tauri.localhost/index.html"));
        assert!(!ok("http://example.com") && !ok("file:///C:/x") && !ok("tauri://localhost") && !ok("data:text/html,x"));
    }
}
