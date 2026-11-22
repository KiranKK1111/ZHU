//! The engine inside this process.
//!
//! The engine is a Python program. ZHU runs it inside `zhu.exe`: this file loads a Python runtime
//! into the process when the engine is first started, and runs the engine on a thread of its own.
//! The window and the engine still talk over the local connection (127.0.0.1, with a token), so
//! nothing else in the app depends on where the engine runs.
//!
//! Two runtimes are known (`Runtime`):
//!   * installed: `zhu-engine\_internal` in ZHU's folder, made by packaging/build.ps1. It holds the
//!     Python runtime (`python3xx.dll`) and every module the engine needs, as plain files.
//!   * source (development builds): the Python that `engine\.venv` was made from, with the
//!     engine's source code, so a change to the engine needs no packaging.
//!
//! Dynamic:
//!   * `zhu.exe` is not linked against Python. The runtime is loaded when the engine is first
//!     started, and its functions are looked up by name. A missing or incomplete runtime is an
//!     ordinary error that the window shows; the window itself never depends on it.
//!   * The engine can be stopped and started again without restarting ZHU. The interpreter is
//!     started once and kept; each start of the engine is a new run inside it, and a run closes
//!     everything it opened (engine/zhu_engine/embedded.py).
//!
//! Failures: an error in the engine's Python code ends the run, never the app. Its last words
//! reach the `Listener` as `Report::Failed`, and engine.rs restarts it or shows a Restart button.
//! What cannot be contained in one process is a crash inside a native library the engine uses
//! (speech recognition, graphics): that ends the app. engine.rs notices when that happened right
//! after a start, and then does not start the engine by itself the next time ZHU opens.
//!
//! Threads and the interpreter lock: one thread (`zhu-engine`) owns the interpreter. It holds the
//! lock while a run is going on (Python itself lets other threads in between) and gives it up
//! while it waits for the next start. `stop` asks from a thread of its own, so a run stuck in
//! something that never lets go of the lock cannot block whoever asked.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// What the engine says about a run. `Ready` comes once; then exactly one of the other two.
#[derive(Debug, Clone, PartialEq)]
pub enum Report {
    Ready(u16),
    Stopped,
    Failed(String),
}

/// Hears the reports of a run, on the engine's thread. It must return quickly and must not wait
/// for the engine (the engine is waiting for it).
pub type Listener = Arc<dyn Fn(Report) + Send + Sync>;

/// A Python runtime to run the engine with, and how to set it up.
#[derive(Debug, Clone)]
pub struct Runtime {
    /// The runtime library, `python3xx.dll`.
    library: PathBuf,
    /// The interpreter's home (`sys.prefix` before the set-up below).
    home: PathBuf,
    /// Where modules are looked for, in this order. Nothing is taken from the user's environment.
    paths: Vec<PathBuf>,
    /// Folders Windows searches for the libraries that modules load.
    library_dirs: Vec<PathBuf>,
    /// Python lines that finish the set-up, run once before the engine is first imported.
    prelude: Vec<String>,
}

impl Runtime {
    /// The engine as installed: `zhu-engine\_internal` in `resource_dir`.
    pub fn installed(resource_dir: &Path) -> Result<Runtime, String> {
        let internal = resource_dir.join("zhu-engine").join("_internal");
        let library = python_library(&internal).ok_or_else(|| format!("The engine is missing from ZHU's folder ({}). Reinstall ZHU.", internal.display()))?;
        // An interpreter that cannot find its own standard library ends the process, with no
        // error to catch. So the folder is looked at first.
        let standard_library = internal.join("encodings").join("__init__.pyc").exists() || internal.join("base_library.zip").exists();
        let engine = internal.join("zhu_engine").join("embedded.pyc").exists();
        if !(standard_library && engine) {
            return Err(format!("The engine in ZHU's folder is incomplete ({}). Reinstall ZHU.", internal.display()));
        }
        Ok(Runtime {
            library,
            home: internal.clone(),
            paths: vec![internal.clone()],
            library_dirs: vec![internal.clone()],
            // What the engine's own program would be: the frozen engine, with its files here.
            prelude: vec!["sys.frozen = True".into(), format!("sys._MEIPASS = {}", py_str(&internal))],
        })
    }

    /// Development: the engine's source in `engine_dir`, and the Python of `engine_dir\.venv`.
    pub fn source(engine_dir: &Path) -> Result<Runtime, String> {
        let venv = engine_dir.join(".venv");
        let setup = "Set it up first: docs/INSTALLATION.md, Developers.";
        let config = std::fs::read_to_string(venv.join("pyvenv.cfg")).map_err(|_| format!("The engine's virtualenv is missing ({}). {setup}", venv.display()))?;
        let home = config
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once('=')?;
                key.trim().eq_ignore_ascii_case("home").then(|| PathBuf::from(value.trim()))
            })
            .ok_or_else(|| format!("{} does not say which Python it was made from. {setup}", venv.join("pyvenv.cfg").display()))?;
        let library = python_library(&home).ok_or_else(|| format!("The Python that engine\\.venv was made from is not in {} any more. {setup}", home.display()))?;
        let standard_library = home.join("Lib");
        if !standard_library.join("encodings").join("__init__.py").exists() {
            return Err(format!("The Python in {} has no standard library. {setup}", home.display()));
        }
        let zipped = home.join(library.with_extension("zip").file_name().unwrap_or_default());
        let site_packages = venv.join("Lib").join("site-packages");
        Ok(Runtime {
            library,
            home: home.clone(),
            paths: vec![engine_dir.to_path_buf(), zipped, home.join("DLLs"), standard_library, site_packages.clone()],
            library_dirs: vec![home.clone(), home.join("DLLs")],
            // The virtualenv's packages, with what their .pth files add.
            prelude: vec![
                format!("sys.prefix = sys.exec_prefix = {}", py_str(&venv)),
                "import site".into(),
                format!("site.addsitedir({})", py_str(&site_packages)),
            ],
        })
    }
}

/// `python3<digits>.dll` in a folder: the runtime itself (not `python3.dll`, the stable-ABI stub).
fn python_library(folder: &Path) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(folder)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_ascii_lowercase();
            let digits = name.strip_prefix("python3").and_then(|rest| rest.strip_suffix(".dll")).unwrap_or_default();
            !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
        })
        .collect();
    found.sort();
    found.pop()
}

/// A path as a Python string literal (a JSON string is one).
fn py_str(path: &Path) -> String {
    serde_json::to_string(&path.to_string_lossy()).unwrap_or_else(|_| "''".into())
}

/// Start the engine in this process. Returns at once; `listener` hears how the run goes. An `Err`
/// means it could not be attempted (a run is still going on).
pub fn start(runtime: &Runtime, token: &str, data_dir: Option<&Path>, listener: Listener) -> Result<(), String> {
    imp::start(runtime, token, data_dir, listener)
}

/// Ask the running engine to stop. True when the request was delivered within `within`; false
/// when nothing runs, or when the interpreter did not take the request in time (the engine is
/// stuck in something that does not let go of it).
pub fn stop(within: Duration) -> bool {
    imp::stop(within)
}

/// A run is going on (from `start` until the run's thread has finished with it).
pub fn running() -> bool {
    imp::running()
}

/// Wait until the run has ended. False when it is still going on after `within`.
pub fn wait_ended(within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while running() {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    true
}

/// The Python that one run executes. Nothing may leave it as an exception: an escaped
/// `SystemExit` would make the interpreter end the process.
fn bootstrap(prelude: &[String], token: &str, data_dir: Option<&Path>, callback: usize) -> String {
    let token = serde_json::to_string(token).unwrap_or_else(|_| "''".into());
    let data = data_dir.map(py_str).unwrap_or_else(|| "None".into());
    let setup: String = prelude.iter().map(|line| format!("            {line}\n")).collect();
    format!(
        r#"import sys
def _zhu_start():
    import ctypes
    tell = ctypes.CFUNCTYPE(None, ctypes.c_char_p, ctypes.c_char_p)({callback})
    try:
        if not getattr(sys, "_zhu_prepared", False):
{setup}            sys._zhu_prepared = True
        from zhu_engine import embedded
        embedded.run({token}, {data}, {callback})
    except BaseException as error:
        tell(b"failed", ("%s: %s" % (type(error).__name__, error)).encode("utf-8", "replace")[:500])
_zhu_start()
del _zhu_start
"#
    )
}

#[cfg(windows)]
mod imp {
    use std::ffi::{c_char, c_int, c_void, CStr, CString};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use super::{bootstrap, Listener, Report, Runtime};

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryExW(name: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
        fn AddDllDirectory(directory: *const u16) -> *mut c_void;
    }
    /// The library's own folder is searched for what it needs (the C runtime next to it).
    const LOAD_WITH_ALTERED_SEARCH_PATH: u32 = 0x0000_0008;

    /// The functions of the Python runtime that are used, found by name after loading it.
    struct Python {
        run: unsafe extern "C" fn(*const c_char) -> c_int,
        save_thread: unsafe extern "C" fn() -> *mut c_void,
        restore_thread: unsafe extern "C" fn(*mut c_void),
        lock: unsafe extern "C" fn() -> c_int,
        unlock: unsafe extern "C" fn(c_int),
    }

    struct Job {
        token: String,
        data_dir: Option<std::path::PathBuf>,
        listener: Listener,
    }

    /// Set once the interpreter is up; `stop` uses it from other threads.
    static PYTHON: OnceLock<Python> = OnceLock::new();
    /// The way to hand a start to the engine's thread (made with the thread, on first use).
    static JOBS: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();
    static LISTENER: Mutex<Option<Listener>> = Mutex::new(None);
    static RUNNING: AtomicBool = AtomicBool::new(false);
    /// The current run has said how it ended (so the thread does not say it again).
    static ENDED: AtomicBool = AtomicBool::new(false);

    fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn running() -> bool {
        RUNNING.load(Ordering::SeqCst)
    }

    pub fn start(runtime: &Runtime, token: &str, data_dir: Option<&Path>, listener: Listener) -> Result<(), String> {
        if RUNNING.swap(true, Ordering::SeqCst) {
            return Err("the engine is still running".into());
        }
        ENDED.store(false, Ordering::SeqCst);
        // The first start makes the thread, with the runtime it is given; the interpreter it then
        // loads stays for the life of the process.
        let jobs = JOBS.get_or_init(|| {
            let (tx, rx) = channel::<Job>();
            let runtime = runtime.clone();
            if std::thread::Builder::new().name("zhu-engine".into()).spawn(move || engine_thread(runtime, rx)).is_err() {
                log::error!("could not start the engine's thread");
            }
            Mutex::new(tx)
        });
        let job = Job { token: token.to_string(), data_dir: data_dir.map(Path::to_path_buf), listener };
        let sent = jobs.lock().map_err(|_| ()).and_then(|tx| tx.send(job).map_err(|_| ()));
        if sent.is_err() {
            RUNNING.store(false, Ordering::SeqCst);
            return Err("the engine's thread is gone; restart ZHU".into());
        }
        Ok(())
    }

    pub fn stop(within: Duration) -> bool {
        if !running() || PYTHON.get().is_none() {
            return false;
        }
        // Taking the interpreter lock can wait for ever when the engine is stuck in something that
        // keeps it, so the asking happens on a thread that may be left waiting.
        let (done, heard) = channel::<()>();
        let asked = std::thread::Builder::new().name("zhu-engine-stop".into()).spawn(move || {
            if let Some(python) = PYTHON.get() {
                let code = c"from zhu_engine import embedded as _zhu_embedded\n_zhu_embedded.request_stop()\ndel _zhu_embedded\n";
                unsafe {
                    let state = (python.lock)();
                    (python.run)(code.as_ptr());
                    (python.unlock)(state);
                }
            }
            let _ = done.send(());
        });
        asked.is_ok() && heard.recv_timeout(within).is_ok()
    }

    /// Called by the engine (from Python, through ctypes) with what it has to say.
    unsafe extern "C" fn report(kind: *const c_char, text: *const c_char) {
        // Nothing may unwind into the Python runtime.
        let _ = std::panic::catch_unwind(|| {
            if kind.is_null() || text.is_null() {
                return;
            }
            let kind = unsafe { CStr::from_ptr(kind) }.to_string_lossy().into_owned();
            let text = unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned();
            let report = match kind.as_str() {
                "ready" => match text.trim().parse::<u16>() {
                    Ok(port) => Report::Ready(port),
                    Err(_) => return,
                },
                "stopped" => Report::Stopped,
                _ => Report::Failed(text),
            };
            tell(report);
        });
    }

    fn tell(report: Report) {
        if !matches!(report, Report::Ready(_)) && ENDED.swap(true, Ordering::SeqCst) {
            return; // this run's end was told already
        }
        let listener = LISTENER.lock().ok().and_then(|current| current.clone());
        if let Some(listener) = listener {
            listener(report);
        }
    }

    fn load(runtime: &Runtime) -> Result<Python, String> {
        unsafe {
            for folder in &runtime.library_dirs {
                AddDllDirectory(wide(folder.as_os_str()).as_ptr());
            }
            let module = LoadLibraryExW(wide(runtime.library.as_os_str()).as_ptr(), std::ptr::null_mut(), LOAD_WITH_ALTERED_SEARCH_PATH);
            if module.is_null() {
                return Err(format!("{} could not be loaded", runtime.library.display()));
            }
            let find = |name: &'static [u8]| -> Result<*mut c_void, String> {
                let address = GetProcAddress(module, name.as_ptr());
                if address.is_null() {
                    Err(format!("this Python runtime has no {}", String::from_utf8_lossy(&name[..name.len() - 1])))
                } else {
                    Ok(address)
                }
            };
            let python = Python {
                run: std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*const c_char) -> c_int>(find(b"PyRun_SimpleString\0")?),
                save_thread: std::mem::transmute::<*mut c_void, unsafe extern "C" fn() -> *mut c_void>(find(b"PyEval_SaveThread\0")?),
                restore_thread: std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void)>(find(b"PyEval_RestoreThread\0")?),
                lock: std::mem::transmute::<*mut c_void, unsafe extern "C" fn() -> c_int>(find(b"PyGILState_Ensure\0")?),
                unlock: std::mem::transmute::<*mut c_void, unsafe extern "C" fn(c_int)>(find(b"PyGILState_Release\0")?),
            };
            let initialize: unsafe extern "C" fn(c_int) = std::mem::transmute(find(b"Py_InitializeEx\0")?);
            // Py_SetPath and Py_SetPythonHome are the older way to configure an interpreter
            // (deprecated, still in 3.13, which the build uses); they need no knowledge of the
            // layout of the runtime's configuration structures, which change between versions.
            let set_path: unsafe extern "C" fn(*const u16) = std::mem::transmute(find(b"Py_SetPath\0")?);
            let set_home: unsafe extern "C" fn(*const u16) = std::mem::transmute(find(b"Py_SetPythonHome\0")?);
            // Nothing from the user's environment (PYTHONPATH, PYTHONHOME, user site packages),
            // no site set-up at start, no .pyc files written into ZHU's folder.
            for flag in [&b"Py_IgnoreEnvironmentFlag\0"[..], b"Py_NoSiteFlag\0", b"Py_NoUserSiteDirectory\0", b"Py_DontWriteBytecodeFlag\0"] {
                let address = GetProcAddress(module, flag.as_ptr());
                if !address.is_null() {
                    *(address as *mut c_int) = 1;
                }
            }
            let paths = std::env::join_paths(runtime.paths.iter()).map_err(|_| "a folder of the engine has a ';' in its name".to_string())?;
            // The runtime keeps these for as long as it lives: they are never freed.
            let paths: &'static [u16] = Box::leak(wide(&paths).into_boxed_slice());
            let home: &'static [u16] = Box::leak(wide(runtime.home.as_os_str()).into_boxed_slice());
            set_path(paths.as_ptr());
            set_home(home.as_ptr());
            // 0: the runtime installs no handlers for Ctrl+C and the like; this is not its program.
            initialize(0);
            Ok(python)
        }
    }

    /// The thread that owns the interpreter: it starts it on the first job and runs every job in it.
    fn engine_thread(runtime: Runtime, jobs: Receiver<Job>) {
        let mut resting: *mut c_void = std::ptr::null_mut();
        for job in jobs {
            if let Ok(mut current) = LISTENER.lock() {
                *current = Some(job.listener.clone());
            }
            if PYTHON.get().is_none() {
                match load(&runtime) {
                    Ok(python) => {
                        resting = unsafe { (python.save_thread)() };
                        let _ = PYTHON.set(python);
                    }
                    Err(reason) => {
                        tell(Report::Failed(reason));
                        RUNNING.store(false, Ordering::SeqCst);
                        continue;
                    }
                }
            }
            let Some(python) = PYTHON.get() else { continue };
            let callback = report as unsafe extern "C" fn(*const c_char, *const c_char) as usize;
            match CString::new(bootstrap(&runtime.prelude, &job.token, job.data_dir.as_deref(), callback)) {
                Ok(code) => unsafe {
                    (python.restore_thread)(resting);
                    (python.run)(code.as_ptr());
                    resting = (python.save_thread)();
                },
                Err(_) => tell(Report::Failed("the engine's start-up text could not be built".into())),
            }
            // The engine normally says how its run ended; if it did not, it is said here.
            tell(Report::Failed("the engine ended without a reason (see logs\\engine.log in ZHU's data folder)".into()));
            RUNNING.store(false, Ordering::SeqCst);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::Path;
    use std::time::Duration;

    use super::{Listener, Runtime};

    pub fn running() -> bool {
        false
    }
    pub fn start(_runtime: &Runtime, _token: &str, _data_dir: Option<&Path>, _listener: Listener) -> Result<(), String> {
        Err("the engine runs inside ZHU on Windows only".into())
    }
    pub fn stop(_within: Duration) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zhu-embedded-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_start_up_text_quotes_what_it_is_given() {
        let prelude = vec!["sys.frozen = True".to_string()];
        let code = bootstrap(&prelude, "t0k\"en", Some(Path::new(r"D:\data folder")), 4096);
        // Backslashes and quotes are escaped, so a path or token cannot end the string and add code.
        assert!(code.contains(r#"embedded.run("t0k\"en", "D:\\data folder", 4096)"#), "{code}");
        assert!(code.contains("            sys.frozen = True\n            sys._zhu_prepared = True\n"), "{code}");
        assert!(bootstrap(&[], "t", None, 1).contains(r#"embedded.run("t", None, 1)"#));
        // Every way out of the engine's code is caught inside the text itself.
        assert!(code.contains("except BaseException"));
        assert_eq!(py_str(Path::new(r#"C:\A "B"\_internal"#)), r#""C:\\A \"B\"\\_internal""#);
    }

    #[test]
    fn the_installed_runtime_needs_a_complete_folder() {
        let root = scratch("installed");
        let internal = root.join("zhu-engine").join("_internal");
        std::fs::create_dir_all(internal.join("encodings")).unwrap();
        assert!(Runtime::installed(&root).unwrap_err().contains("missing"));
        std::fs::write(internal.join("python3.dll"), b"").unwrap(); // the stub is not the runtime
        assert!(Runtime::installed(&root).unwrap_err().contains("missing"));
        std::fs::write(internal.join("python313.dll"), b"").unwrap();
        assert!(Runtime::installed(&root).unwrap_err().contains("incomplete"));
        std::fs::write(internal.join("encodings").join("__init__.pyc"), b"").unwrap();
        std::fs::create_dir_all(internal.join("zhu_engine")).unwrap();
        std::fs::write(internal.join("zhu_engine").join("embedded.pyc"), b"").unwrap();
        let runtime = Runtime::installed(&root).unwrap();
        assert_eq!(runtime.library, internal.join("python313.dll"));
        assert_eq!(runtime.paths, vec![internal.clone()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_source_runtime_comes_from_the_virtualenv() {
        let root = scratch("source");
        let engine = root.join("engine");
        assert!(Runtime::source(&engine).unwrap_err().contains("virtualenv is missing"));
        let home = root.join("Python313");
        std::fs::create_dir_all(home.join("Lib").join("encodings")).unwrap();
        std::fs::write(home.join("Lib").join("encodings").join("__init__.py"), b"").unwrap();
        std::fs::write(home.join("python313.dll"), b"").unwrap();
        std::fs::create_dir_all(engine.join(".venv")).unwrap();
        std::fs::write(engine.join(".venv").join("pyvenv.cfg"), format!("home = {}\ninclude-system-site-packages = false\n", home.display())).unwrap();
        let runtime = Runtime::source(&engine).unwrap();
        assert_eq!(runtime.library, home.join("python313.dll"));
        assert_eq!(runtime.paths[0], engine);
        assert_eq!(runtime.paths[1], home.join("python313.zip"));
        assert!(runtime.prelude.iter().any(|line| line.starts_with("site.addsitedir(")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_runs_before_a_start() {
        assert!(!running());
        assert!(!stop(Duration::from_millis(10)));
        assert!(wait_ended(Duration::from_millis(10)));
    }
}
