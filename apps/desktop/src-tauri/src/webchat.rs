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
//! * New windows (`new_window`): a sign-in pop-up ("Continue with Google") opens as WebView2's own
//!   pop-up in the same profile, with no IPC; a link meant for a new tab opens in the user's normal
//!   browser; anything else is refused.
//! * ZHU fills the message box and attaches screenshots; it never signs in and never presses Send.
//!   The scripts it runs in a page are `webchat_inject.js`, with data passed as JSON literals, and
//!   a fixed style rule that keeps the pointer the arrow (`POINTER_JS`), as everywhere in ZHU.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
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
/// The resume and the job with their instruction (the engine keeps at most 24,000 + 12,000 characters).
const MAX_CONTEXT: usize = 80_000;

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
    /// When a chat page last had a link opened in the user's browser (at most one a second).
    browser_opened: Mutex<Option<Instant>>,
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
    /// The user's resume (and job), for the first message of a new chat. The page helper decides
    /// whether this chat needs it (see `contextPlan` in webchat_inject.js).
    #[serde(default)]
    context: Option<DeliverContext>,
}

#[derive(Deserialize, Serialize)]
pub struct DeliverContext {
    /// "file": attached as a text file, with `note` in the message; "text": in the message itself.
    mode: String,
    /// Add it even to a chat under way (the user pressed "Add resume").
    #[serde(default)]
    force: bool,
    /// In the file name and the first line: how the page tells it is already in the chat.
    marker: String,
    file_name: String,
    text: String,
    note: String,
    question_heading: String,
    /// The path of the tab's own start page, a new chat on sites ZHU has no addresses for.
    #[serde(default)]
    home: String,
}

impl DeliverContext {
    fn check(&self) -> Result<(), String> {
        let plain = |s: &str, max: usize, extra: &[char]| !s.is_empty() && s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(&c));
        if self.mode != "file" && self.mode != "text" {
            return Err("unknown way to add the resume".into());
        }
        if !plain(&self.marker, 64, &['-']) {
            return Err("invalid resume marker".into());
        }
        if !plain(&self.file_name, 120, &['-', '_', '.']) || !self.file_name.ends_with(".txt") {
            return Err("invalid resume file name".into());
        }
        if self.text.is_empty() || self.text.len() > MAX_CONTEXT || self.note.len() > 1_000 || self.question_heading.len() > 200 || self.home.len() > 500 {
            return Err("the resume is too long to add".into());
        }
        Ok(())
    }
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

/// What happens when a chat page asks for a new window (`window.open`, or a link to a new tab).
#[derive(Debug, PartialEq, Eq)]
enum NewWindow {
    /// A sign-in window: opened by WebView2 itself, in the chat profile. It keeps its link to the
    /// page that opened it, which "Continue with Google / Microsoft / Apple" needs to hand the
    /// sign-in back, and it closes itself when the sign-in is done.
    Popup,
    /// An ordinary link meant for a new tab (a source in an answer): the user's normal browser.
    Browser,
    Deny,
}

/// `sized`: the page gave the window a size or position, as sign-in pop-ups do and links do not.
/// Without one, a page on a sign-in host or path still counts as a sign-in window.
fn new_window(url: &Url, sized: bool) -> NewWindow {
    if !navigation_allowed(url) {
        return NewWindow::Deny;
    }
    if url.scheme() != "https" {
        // about:blank, filled in by the page's script afterwards: only as a pop-up.
        return if sized { NewWindow::Popup } else { NewWindow::Deny };
    }
    if sized || looks_like_sign_in(url) {
        NewWindow::Popup
    } else {
        NewWindow::Browser
    }
}

fn looks_like_sign_in(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    let host_hint = ["accounts.", "login.", "auth.", "signin.", "appleid.", "sso."].iter().any(|p| host.starts_with(p));
    let path = url.path().to_ascii_lowercase();
    let path_hint = ["/oauth", "/authorize", "/login", "/signin", "/sign_in", "/sign-in", "/auth/", "/sso"].iter().any(|p| path.contains(p));
    host_hint || path_hint
}

fn open_in_browser(app: &AppHandle, url: &Url) {
    use tauri_plugin_opener::OpenerExt;
    let state = app.state::<WebChatState>();
    let mut last = state.browser_opened.lock().unwrap();
    // A page that opens windows in a loop gets one browser tab a second, not a flood.
    if last.is_some_and(|t| t.elapsed() < Duration::from_secs(1)) {
        return;
    }
    *last = Some(Instant::now());
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
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
    let popup_app = app.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .data_directory(profile)
        .additional_browser_args(&browser_args)
        .on_navigation(navigation_allowed)
        // Without this handler every new window is refused, and with it sign-in pop-ups.
        .on_new_window(move |url, features| match new_window(&url, features.size().is_some() || features.position().is_some()) {
            NewWindow::Popup => NewWindowResponse::Allow,
            NewWindow::Browser => {
                open_in_browser(&popup_app, &url);
                NewWindowResponse::Deny
            }
            NewWindow::Deny => NewWindowResponse::Deny,
        })
        .on_page_load(move |wv, payload| {
            let finished = matches!(payload.event(), PageLoadEvent::Finished);
            // Every page gets the arrow as it starts, and again once it has loaded (in case the
            // page replaced its style sheets meanwhile).
            let _ = wv.eval(POINTER_JS);
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
    if let Some(ctx) = &payload.context {
        ctx.check()?;
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
            "context": payload.context,
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
                    // The box may hold more than the question (the resume, or the note about it).
                    let inserted = status.get("inserted").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| text.clone());
                    app2.state::<WebChatState>().last_text.lock().unwrap().insert(tab_id.clone(), inserted);
                }
                let mut status = status;
                if let Some(obj) = status.as_object_mut() {
                    obj.remove("inserted"); // the window has no use for a copy of the whole text
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

/// The chat pages show only the arrow too, over their message boxes, buttons and links, as the
/// rest of ZHU does (globals.css). The rule is a style sheet the script makes and adopts into the
/// document, so it needs no element in the page and can be applied the moment a document exists.
/// It is fixed text and carries no data.
const POINTER_JS: &str = "(function(){try{var d=document,k='__zhuArrow',s=window[k],\
make=function(){var n=new CSSStyleSheet();n.replaceSync('*,*::before,*::after{cursor:default!important}');window[k]=n;return n;},\
rest=d.adoptedStyleSheets.filter(function(x){return x!==s;});\
try{d.adoptedStyleSheets=rest.concat([s||make()]);}catch(e){d.adoptedStyleSheets=rest.concat([make()]);}}catch(e){}})()";

/// The chat tab shown at this point of the screen (physical pixels), if one is shown there.
pub fn visible_tab_at(app: &AppHandle, x: i32, y: i32) -> Option<Webview> {
    let id = app.state::<WebChatState>().visible.lock().unwrap().clone()?;
    let wv = app.get_webview(&format!("{LABEL_PREFIX}{id}"))?;
    let origin = app.get_window("main")?.inner_position().ok()?;
    let (pos, size) = (wv.position().ok()?, wv.size().ok()?);
    let (left, top) = (origin.x + pos.x, origin.y + pos.y);
    (x >= left && y >= top && x < left + size.width as i32 && y < top + size.height as i32).then_some(wv)
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
    fn the_pointer_script_gives_every_element_the_arrow() {
        assert!(POINTER_JS.contains("'*,*::before,*::after{cursor:default!important}'"));
        // One function, called at once, that touches nothing but the page's style sheets.
        assert!(POINTER_JS.starts_with("(function(){") && POINTER_JS.ends_with("})()"));
        assert!(POINTER_JS.contains("adoptedStyleSheets") && !POINTER_JS.contains("fetch") && !POINTER_JS.contains("location"));
    }

    #[test]
    fn the_resume_part_of_a_delivery_is_checked() {
        let ctx = |mode: &str, marker: &str, file_name: &str, text: &str| DeliverContext {
            mode: mode.into(),
            force: false,
            marker: marker.into(),
            file_name: file_name.into(),
            text: text.into(),
            note: "My resume is attached.".into(),
            question_heading: "=== QUESTION ===".into(),
            home: "/".into(),
        };
        assert!(ctx("file", "zhu-1a2b3c4d", "resume-and-job-zhu-1a2b3c4d.txt", "About me").check().is_ok());
        assert!(ctx("text", "zhu-1a2b3c4d", "resume-zhu-1a2b3c4d.txt", "About me").check().is_ok());
        // The marker goes into a CSS selector in the page and the name into a file: plain characters only.
        for (mode, marker, name) in [
            ("both", "zhu-1", "a.txt"),
            ("file", "zhu\"],*", "a.txt"),
            ("file", "", "a.txt"),
            ("file", "zhu-1", "../a.txt"),
            ("file", "zhu-1", "a.exe"),
            ("file", "zhu-1", "a b.txt"),
        ] {
            assert!(ctx(mode, marker, name, "About me").check().is_err(), "{mode} {marker} {name}");
        }
        assert!(ctx("file", "zhu-1", "a.txt", "").check().is_err());
        assert!(ctx("file", "zhu-1", "a.txt", &"x".repeat(MAX_CONTEXT + 1)).check().is_err());
    }

    #[test]
    fn navigation_stays_on_the_web() {
        let ok = |s: &str| navigation_allowed(&Url::parse(s).unwrap());
        assert!(ok("https://accounts.google.com/o/oauth2/auth") && ok("about:blank"));
        // ZHU's own UI (which has IPC access) must never load inside a chat tab.
        assert!(!ok("https://tauri.localhost/index.html") && !ok("http://tauri.localhost/index.html"));
        assert!(!ok("http://example.com") && !ok("file:///C:/x") && !ok("tauri://localhost") && !ok("data:text/html,x"));
    }

    #[test]
    fn sign_in_pop_ups_open_and_links_go_to_the_browser() {
        let kind = |s: &str, sized: bool| new_window(&Url::parse(s).unwrap(), sized);
        // "Continue with Google / Microsoft / Apple": a sized window, or a sign-in page without a size.
        assert_eq!(kind("https://accounts.google.com/o/oauth2/v2/auth?client_id=x", true), NewWindow::Popup);
        assert_eq!(kind("https://accounts.google.com/o/oauth2/v2/auth?client_id=x", false), NewWindow::Popup);
        assert_eq!(kind("https://login.microsoftonline.com/common/oauth2/v2.0/authorize", false), NewWindow::Popup);
        assert_eq!(kind("https://appleid.apple.com/auth/authorize", false), NewWindow::Popup);
        assert_eq!(kind("https://chat.example.com/api/auth/signin/google", false), NewWindow::Popup);
        assert_eq!(kind("https://www.example.com/anything", true), NewWindow::Popup);
        assert_eq!(kind("about:blank", true), NewWindow::Popup);
        // A source link in an answer: the normal browser.
        assert_eq!(kind("https://en.wikipedia.org/wiki/Mutex", false), NewWindow::Browser);
        assert_eq!(kind("https://docs.python.org/3/library/asyncio.html", false), NewWindow::Browser);
        // Never: other schemes, ZHU's own UI, or an unsized blank window.
        assert_eq!(kind("about:blank", false), NewWindow::Deny);
        assert_eq!(kind("http://example.com/login", true), NewWindow::Deny);
        assert_eq!(kind("https://tauri.localhost/index.html", true), NewWindow::Deny);
        assert_eq!(kind("file:///C:/Windows/notepad.exe", true), NewWindow::Deny);
        assert_eq!(kind("ms-settings:privacy", false), NewWindow::Deny);
    }
}
