//! Engine supervisor: runs the Python processing engine inside this process (embedded.rs), owns
//! its auth token, tells the windows how it is doing (`zhu://engine`), restarts it after a
//! failure (a few times in a row at most), and stops it when ZHU quits.
//!
//! The windows stay up whatever the engine does. The states they see:
//!   starting -> ready, or -> failed with the reason. While failed, Restart starts it again.
//!   `stuck`: the engine did not stop when asked. A new one cannot start in this process while the
//!   old one holds the interpreter, so the window offers to restart ZHU instead.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::embedded::{self, Listener, Report, Runtime};

/// How long a start may take before it counts as failed. The first start in a session loads
/// Python and every module of the engine.
const READY_TIMEOUT: Duration = Duration::from_secs(120);
/// Failures in a row that are answered with a restart before the window shows the error.
const MAX_AUTO_RESTARTS: u32 = 3;
/// An engine that has been ready this long has started well: the count of failures in a row
/// begins again, and the marker of a start in progress is removed.
const SETTLED: Duration = Duration::from_secs(60);
/// How long a running engine gets to stop: it stops listening and closes its database.
const STOP_WAIT: Duration = Duration::from_secs(20);

#[derive(Clone, Serialize, Debug)]
pub struct EngineInfo {
    pub status: &'static str, // starting | ready | failed
    pub port: Option<u16>,
    pub token: Option<String>,
    pub error: Option<String>,
    /// The engine did not stop when asked: only restarting ZHU can start it again.
    pub stuck: bool,
}

impl EngineInfo {
    fn starting(token: Option<String>) -> Self {
        EngineInfo { status: "starting", port: None, token, error: None, stuck: false }
    }
    fn failed(error: String, stuck: bool) -> Self {
        EngineInfo { status: "failed", port: None, token: None, error: Some(error), stuck }
    }
}

pub struct EngineSupervisor {
    inner: Mutex<Inner>,
}

struct Inner {
    info: EngineInfo,
    /// Counts starts; reports and timers of an older start are ignored.
    generation: u64,
    /// Failures in a row (see `SETTLED`).
    restarts: u32,
    shutting_down: bool,
    /// The current run was asked to stop (a restart, or quitting): its end is expected.
    stopping: bool,
}

impl EngineSupervisor {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner { info: EngineInfo::starting(None), generation: 0, restarts: 0, shutting_down: false, stopping: false }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn info(&self) -> EngineInfo {
        self.lock().info.clone()
    }

    fn emit(&self, app: &AppHandle) {
        let _ = app.emit("zhu://engine", self.info());
    }

    /// The first start, when ZHU opens. If ZHU ended by itself shortly after the engine's last
    /// start (a crash in one of the engine's native libraries takes the whole app with it), the
    /// engine is not started by itself this time: the window says why and offers to start it.
    /// That keeps a crash at start from becoming a crash every time ZHU opens.
    pub fn start_at_launch(self: &Arc<Self>, app: &AppHandle) {
        if marker::take(app) {
            log::warn!("ZHU ended unexpectedly right after its engine started last time; not starting it by itself");
            self.lock().info = EngineInfo::failed(
                "ZHU closed unexpectedly while its engine was starting, the last time it ran. To be safe, the engine was not started this time. Press Restart engine to start it."
                    .into(),
                false,
            );
            self.emit(app);
            return;
        }
        self.start(app);
    }

    /// Start the engine, or start it again. A running engine is stopped first, which can take a
    /// few seconds: call this off the main thread when one may be running.
    pub fn start(self: &Arc<Self>, app: &AppHandle) {
        if embedded::running() {
            self.lock().stopping = true;
            embedded::stop(Duration::from_secs(10));
            if !embedded::wait_ended(STOP_WAIT) {
                log::error!("the engine did not stop when asked");
                self.lock().info = EngineInfo::failed("The engine did not stop when asked, so it cannot be started again. Restart ZHU to start it.".into(), true);
                self.emit(app);
                return;
            }
        }
        let (generation, token) = {
            let mut g = self.lock();
            if g.shutting_down {
                return;
            }
            g.generation += 1;
            g.stopping = false;
            // Debug builds only: a fixed token lets test tooling call the local API.
            // Release builds always use a fresh random token.
            let token = if cfg!(debug_assertions) {
                std::env::var("ZHU_DEV_ENGINE_TOKEN").ok().filter(|t| t.len() >= 32).unwrap_or_else(new_token)
            } else {
                new_token()
            };
            g.info = EngineInfo::starting(Some(token.clone()));
            (g.generation, token)
        };
        self.emit(app);

        let runtime = match runtime(app) {
            Ok(runtime) => runtime,
            Err(reason) => return self.fail(app, generation, reason),
        };
        // User data lives in the per-app data folder (%LOCALAPPDATA%\app.zhu.desktop\data), never
        // in ZHU's own folder. An explicit ZHU_DATA_DIR (tests, portable use) takes precedence.
        let data_dir = if std::env::var_os("ZHU_DATA_DIR").is_none() { app.path().app_local_data_dir().ok().map(|dir| dir.join("data")) } else { None };

        marker::set(app);
        let listener: Listener = {
            let sup = Arc::clone(self);
            let app = app.clone();
            Arc::new(move |report| sup.on_report(&app, generation, report))
        };
        if let Err(reason) = embedded::start(&runtime, &token, data_dir.as_deref(), listener) {
            marker::clear(app);
            return self.fail(app, generation, reason);
        }

        // A start that never gets ready counts as failed.
        let sup = Arc::clone(self);
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(READY_TIMEOUT);
            let late = {
                let mut g = sup.lock();
                let late = g.generation == generation && g.info.status == "starting";
                if late {
                    g.stopping = true;
                }
                late
            };
            if late {
                sup.fail(&app, generation, "The engine did not get ready within two minutes. See logs\\engine.log in ZHU's data folder.".into());
                embedded::stop(Duration::from_secs(10));
            }
        });
    }

    /// What the engine says about a run (on the engine's thread: nothing here may wait for it).
    fn on_report(self: &Arc<Self>, app: &AppHandle, generation: u64, report: Report) {
        match report {
            Report::Ready(port) => {
                {
                    let mut g = self.lock();
                    if g.generation != generation {
                        return;
                    }
                    g.info.status = "ready";
                    g.info.port = Some(port);
                    g.info.error = None;
                }
                self.emit(app);
                let sup = Arc::clone(self);
                let app = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(SETTLED);
                    let settled = {
                        let mut g = sup.lock();
                        let settled = g.generation == generation && g.info.status == "ready";
                        if settled {
                            g.restarts = 0;
                        }
                        settled
                    };
                    if settled {
                        marker::clear(&app);
                    }
                });
            }
            Report::Stopped | Report::Failed(_) => {
                // The run ended in order: whatever it was, it did not take ZHU with it.
                marker::clear(app);
                let reason = match report {
                    Report::Failed(reason) => reason,
                    _ => "The engine stopped by itself.".to_string(),
                };
                let attempt = {
                    let mut g = self.lock();
                    if g.generation != generation || g.stopping || g.shutting_down {
                        return; // an end that was asked for
                    }
                    g.restarts += 1;
                    g.restarts
                };
                log::warn!("engine ended unexpectedly ({reason}); failure {attempt} in a row");
                if attempt > MAX_AUTO_RESTARTS {
                    return self.fail(app, generation, reason);
                }
                self.lock().info = EngineInfo::starting(None);
                self.emit(app);
                let sup = Arc::clone(self);
                let app = app.clone();
                std::thread::spawn(move || {
                    // This report comes from inside the run; its thread finishes after it.
                    embedded::wait_ended(STOP_WAIT);
                    std::thread::sleep(Duration::from_millis(500 * attempt as u64));
                    let current = {
                        let g = sup.lock();
                        g.generation == generation && !g.shutting_down
                    };
                    if current {
                        sup.start(&app);
                    }
                });
            }
        }
    }

    fn fail(&self, app: &AppHandle, generation: u64, error: String) {
        {
            let mut g = self.lock();
            if g.generation != generation {
                return;
            }
            log::error!("engine failed: {error}");
            g.info = EngineInfo::failed(error, false);
        }
        self.emit(app);
    }

    pub fn reset_restart_budget(&self) {
        self.lock().restarts = 0;
    }

    /// Stop the engine before ZHU quits: it stops listening and closes its database. Bounded: an
    /// engine that does not stop in time is left to end with the process.
    pub fn shutdown(&self, app: &AppHandle) {
        self.lock().shutting_down = true;
        if embedded::running() {
            embedded::stop(Duration::from_secs(5));
            if !embedded::wait_ended(Duration::from_secs(10)) {
                log::warn!("the engine did not stop in time; it ends with ZHU");
            }
        }
        marker::clear(app);
    }
}

/// Where the engine comes from. Release builds: the engine installed with ZHU. Development
/// builds: the engine's source, with the Python of its virtualenv.
fn runtime(app: &AppHandle) -> Result<Runtime, String> {
    if cfg!(debug_assertions) {
        // Derived from the crate location at compile time: development builds only.
        let engine_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..").join("engine");
        return Runtime::source(&engine_dir);
    }
    let resource_dir = app.path().resource_dir().map_err(|e| format!("ZHU's folder could not be found ({e}). Reinstall ZHU."))?;
    Runtime::installed(&resource_dir)
}

/// 256-bit random token, hex encoded.
fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS random number generator unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A file that exists from an engine start until that engine has been ready for `SETTLED`, or has
/// ended in order. Found when ZHU opens, it means ZHU itself ended shortly after starting its
/// engine. Development builds do without it: every change to the shell restarts the app.
mod marker {
    use std::path::PathBuf;
    use tauri::{AppHandle, Manager};

    fn path(app: &AppHandle) -> Option<PathBuf> {
        app.path().app_local_data_dir().ok().map(|dir| dir.join("engine-starting"))
    }

    pub fn set(app: &AppHandle) {
        if cfg!(debug_assertions) {
            return;
        }
        if let Some(path) = path(app) {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(path, b"");
        }
    }

    pub fn clear(app: &AppHandle) {
        if let Some(path) = path(app) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// True (once) when the marker was left by the last session.
    pub fn take(app: &AppHandle) -> bool {
        if cfg!(debug_assertions) {
            return false;
        }
        match path(app) {
            Some(path) if path.exists() => {
                let _ = std::fs::remove_file(path);
                true
            }
            _ => false,
        }
    }
}
