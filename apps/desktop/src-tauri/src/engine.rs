//! Engine supervisor: spawns the Python processing engine, owns its auth token,
//! detects readiness, restarts it after a crash (bounded), and stops it on exit.

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const READY_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_AUTO_RESTARTS: u32 = 3;

#[derive(Clone, Serialize, Debug)]
pub struct EngineInfo {
    pub status: &'static str, // starting | ready | failed
    pub port: Option<u16>,
    pub token: Option<String>,
    pub error: Option<String>,
}

pub struct EngineSupervisor {
    inner: Mutex<Inner>,
}

struct Inner {
    info: EngineInfo,
    child: Option<Child>,
    generation: u64,
    restarts: u32,
    shutting_down: bool,
}

impl EngineSupervisor {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                info: EngineInfo { status: "starting", port: None, token: None, error: None },
                child: None,
                generation: 0,
                restarts: 0,
                shutting_down: false,
            }),
        })
    }

    pub fn info(&self) -> EngineInfo {
        self.inner.lock().unwrap().info.clone()
    }

    /// Start (or restart) the engine. Returns immediately; readiness is reported via the `zhu://engine` event.
    pub fn start(self: &Arc<Self>, app: &AppHandle) {
        let (generation, token) = {
            let mut g = self.inner.lock().unwrap();
            if let Some(mut child) = g.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            g.generation += 1;
            // Debug builds only: a fixed token lets test tooling call the local API.
            // Release builds always use a fresh random token.
            let token = if cfg!(debug_assertions) {
                std::env::var("ZHU_DEV_ENGINE_TOKEN").ok().filter(|t| t.len() >= 32).unwrap_or_else(new_token)
            } else {
                new_token()
            };
            g.info = EngineInfo { status: "starting", port: None, token: Some(token.clone()), error: None };
            (g.generation, token)
        };
        let _ = app.emit("zhu://engine", self.info());

        let (program, args, cwd) = match resolve_engine(app) {
            Ok(v) => v,
            Err(e) => return self.fail(app, generation, e),
        };
        let mut cmd = Command::new(&program);
        cmd.args(&args)
            .env("ZHU_ENGINE_TOKEN", &token)
            .env("ZHU_PARENT_PID", std::process::id().to_string())
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        // User data lives in the per-app data folder (%LOCALAPPDATA%\app.zhu.desktop\data), never in
        // the install folder: the per-user NSIS install goes to %LOCALAPPDATA%\ZHU. The uninstaller's
        // "Delete the application data" option removes this folder; otherwise it is kept.
        // An explicit ZHU_DATA_DIR (tests, portable use) takes precedence.
        if std::env::var_os("ZHU_DATA_DIR").is_none() {
            if let Ok(dir) = app.path().app_local_data_dir() {
                cmd.env("ZHU_DATA_DIR", dir.join("data"));
            }
        }
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return self.fail(app, generation, format!("could not start engine ({}): {e}", program.display())),
        };
        let stdout = child.stdout.take();
        self.inner.lock().unwrap().child = Some(child);

        // Readiness reader: the engine prints `ZHU_ENGINE_READY port=<n>` once.
        let sup = Arc::clone(self);
        let app2 = app.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            let mut ready = false;
            if let Some(out) = stdout {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    if let Some(rest) = line.trim().strip_prefix("ZHU_ENGINE_READY port=") {
                        if let Ok(port) = rest.trim().parse::<u16>() {
                            ready = sup.mark_ready(&app2, generation, port);
                        }
                    }
                    if ready {
                        continue; // keep draining so the pipe never blocks the engine
                    }
                    if started.elapsed() > READY_TIMEOUT {
                        break;
                    }
                }
            }
            if !ready {
                sup.fail(&app2, generation, "engine exited before it was ready (see %LOCALAPPDATA%\\app.zhu.desktop\\data\\logs\\engine.log)".into());
            }
        });

        // Exit monitor: detects crashes and restarts with backoff.
        let sup = Arc::clone(self);
        let app3 = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(1000));
            let exited = {
                let mut g = sup.inner.lock().unwrap();
                if g.generation != generation || g.shutting_down {
                    return;
                }
                match g.child.as_mut().map(|c| c.try_wait()) {
                    Some(Ok(Some(status))) => Some(status.code()),
                    Some(Ok(None)) => None,
                    _ => return,
                }
            };
            if let Some(code) = exited {
                let attempt = {
                    let mut g = sup.inner.lock().unwrap();
                    g.child = None;
                    g.restarts += 1;
                    g.restarts
                };
                if attempt <= MAX_AUTO_RESTARTS {
                    log::warn!("engine exited (code {code:?}); restarting (attempt {attempt})");
                    std::thread::sleep(Duration::from_millis(500 * attempt as u64));
                    sup.start(&app3);
                } else {
                    sup.fail(&app3, generation, format!("engine stopped unexpectedly (exit code {code:?})"));
                }
                return;
            }
        });
    }

    fn mark_ready(&self, app: &AppHandle, generation: u64, port: u16) -> bool {
        let mut g = self.inner.lock().unwrap();
        if g.generation != generation {
            return false;
        }
        g.info.status = "ready";
        g.info.port = Some(port);
        g.info.error = None;
        let info = g.info.clone();
        drop(g);
        let _ = app.emit("zhu://engine", info);
        true
    }

    fn fail(&self, app: &AppHandle, generation: u64, error: String) {
        let mut g = self.inner.lock().unwrap();
        if g.generation != generation || g.info.status == "ready" && g.child.is_some() {
            return;
        }
        log::error!("engine failed: {error}");
        g.info = EngineInfo { status: "failed", port: None, token: None, error: Some(error) };
        let info = g.info.clone();
        drop(g);
        let _ = app.emit("zhu://engine", info);
    }

    pub fn reset_restart_budget(&self) {
        self.inner.lock().unwrap().restarts = 0;
    }

    pub fn shutdown(&self) {
        let mut g = self.inner.lock().unwrap();
        g.shutting_down = true;
        if let Some(mut child) = g.child.take() {
            // The engine also watches our PID and exits on its own; kill guarantees it.
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 256-bit random token, hex encoded.
fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS random number generator unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Production: the frozen engine bundled as a resource (`zhu-engine/zhu-engine.exe`).
/// Development: `ZHU_ENGINE_CMD` if set, otherwise the repository's engine virtualenv.
fn resolve_engine(app: &AppHandle) -> Result<(PathBuf, Vec<String>, Option<PathBuf>), String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let exe = resource_dir.join("zhu-engine").join("zhu-engine.exe");
        if exe.exists() {
            return Ok((exe, vec![], Some(resource_dir.join("zhu-engine"))));
        }
    }
    if let Ok(cmd) = std::env::var("ZHU_ENGINE_CMD") {
        let mut parts = cmd.split_whitespace().map(String::from);
        let program = parts.next().ok_or("ZHU_ENGINE_CMD is empty")?;
        return Ok((PathBuf::from(program), parts.collect(), None));
    }
    if cfg!(debug_assertions) {
        // Derived from the crate location at compile time — development builds only.
        let engine_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..").join("engine");
        let python = engine_dir.join(".venv").join("Scripts").join("python.exe");
        if python.exists() {
            return Ok((python, vec!["-m".into(), "zhu_engine".into()], Some(engine_dir)));
        }
        return Err(format!("development engine not found at {} — run engine setup (see docs/INSTALLATION.md)", python.display()));
    }
    Err("the bundled engine is missing; reinstall ZHU".into())
}
