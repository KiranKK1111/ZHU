//! Runs the engine inside this process the way `zhu.exe` does, from a freshly built engine
//! folder: start, ask it two questions, stop, and the same again, in one process. packaging/build.ps1
//! runs it after freezing the engine; a failure stops the build.
//!
//!   cargo run --release --example embedded_check -- <folder that holds zhu-engine\_internal>

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use zhu_lib::embedded::{self, Report, Runtime};

fn fail(message: &str) -> ! {
    eprintln!("embedded engine check FAILED: {message}");
    std::process::exit(1);
}

/// One GET to the engine's API; the body of the answer.
fn get(port: u16, path: &str, token: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap_or_else(|e| fail(&format!("could not connect to port {port}: {e}")));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
    if !answer.starts_with("HTTP/1.1 200") {
        fail(&format!("{path} answered: {}", answer.lines().next().unwrap_or_default()));
    }
    answer.split_once("\r\n\r\n").map(|(_, body)| body.to_string()).unwrap_or_default()
}

fn main() {
    let root = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| fail("usage: embedded_check <folder that holds zhu-engine\\_internal>")));
    let runtime = Runtime::installed(&root).unwrap_or_else(|e| fail(&e));
    let data = std::env::temp_dir().join(format!("zhu-embedded-check-{}", std::process::id()));
    let token = "c".repeat(48);

    for round in 1..=2 {
        let (tx, rx) = mpsc::channel::<Report>();
        let tx = std::sync::Mutex::new(tx);
        embedded::start(&runtime, &token, Some(&data), Arc::new(move |report| {
            let _ = tx.lock().map(|tx| tx.send(report));
        }))
        .unwrap_or_else(|e| fail(&e));
        let port = match rx.recv_timeout(Duration::from_secs(180)) {
            Ok(Report::Ready(port)) => port,
            other => fail(&format!("start {round}: the engine did not get ready: {other:?}")),
        };
        let health = get(port, "/api/health", &token);
        let health: serde_json::Value = serde_json::from_str(&health).unwrap_or_else(|_| fail(&format!("/api/health gave {health}")));
        if health["status"] != "ok" {
            fail(&format!("/api/health gave {health}"));
        }
        let gpu: serde_json::Value = serde_json::from_str(&get(port, "/api/system/gpu", &token)).unwrap_or_default();
        println!(
            "start {round}: ready on port {port}, version {}; GPU: {} ({} MB), CUDA available: {}{}",
            health["version"],
            gpu["device_name"].as_str().unwrap_or("none found"),
            gpu["vram_total_mb"],
            gpu["cuda_available"],
            gpu["error"].as_str().map(|e| format!(" ({e})")).unwrap_or_default()
        );
        if !embedded::stop(Duration::from_secs(15)) {
            fail(&format!("start {round}: the engine did not take the request to stop"));
        }
        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(Report::Stopped) => {}
            other => fail(&format!("start {round}: the engine did not stop in order: {other:?}")),
        }
        if !embedded::wait_ended(Duration::from_secs(15)) {
            fail(&format!("start {round}: the engine's run did not end"));
        }
    }
    let _ = std::fs::remove_dir_all(&data);
    println!("embedded engine OK: started, answered and stopped twice in one process");
}
