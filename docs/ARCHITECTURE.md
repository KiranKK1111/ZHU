# ZHU — Architecture

This document is the single source of truth for module boundaries and data contracts.
It covers Phase 1 of the master prompt ("Architecture and feasibility").

## 1. Measured development environment (2026-11-17)

| Item | Value | How measured |
|---|---|---|
| OS | Windows 11 Pro 10.0.26200, x64 | `ver` |
| GPU | NVIDIA GeForce RTX 5060 Laptop GPU, 8151 MiB | `nvidia-smi` |
| NVIDIA driver | 581.34 | `nvidia-smi` |
| CUDA toolkit (nvcc) | not installed — not required (CUDA runtime comes from pip wheels) | `nvcc` |
| MSVC | Build Tools 2022, 14.44.35207 | `vswhere` |
| Windows SDK | 10.0.26100.0 | filesystem |
| WebView2 runtime | 157.0.4341.46 | filesystem |
| Node.js | 18.20.5 / npm 10.8.2 | `node --version` |
| Python | 3.13.0 x64 | `python --version` |
| Rust | not present at start; installed via `winget install Rustlang.Rustup` | — |
| RAM | 16 GB | `/proc/meminfo` |

Node 18 constrains front-end tooling: Vite 6 and Tailwind CSS 3.4 are used, because Tailwind 4 and Vite 7 require Node ≥ 20.

## 2. Feasibility matrix

| Capability | Classification | Notes |
|---|---|---|
| Tauri 2 shell, windows, tray, global hotkeys, autostart, single instance | Fully supported | Official Tauri 2 plugins. |
| Custom title bar with Windows Snap | Platform limitation | `decorations:false` + drag region keeps drag-to-edge snap, Win+Arrow, and double-click-maximize. The Windows 11 *Snap Layouts flyout* on hovering the maximize button is **not** available with custom chrome. |
| Window opacity | Native Windows integration | `opacity.rs` makes ZHU's windows layered with one alpha value (`SetLayeredWindowAttributes`), so the transparency covers whole windows, the chat tabs' separate web views included. A hook keeps the layered style when the window library rewrites the extended style. 40–100% in the title bar; hiding ZHU starts it at 80%. |
| Hide from the taskbar and Alt+Tab | Native Windows integration | Tauri's `skipTaskbar` only deletes the taskbar tab and leaves a window in Alt+Tab, so `bars.rs` sets the tool-window style on both windows (main, floating icon). It also keeps that style when the window library rewrites the extended style (show, hide, maximize, always on top), and parks a minimized window off screen, where Windows would otherwise leave a title-bar stub on the desktop. While hidden, the main window is always on top (nothing else could bring it back from behind other windows; the same hook sets that state again if something removes it). The windows stay visible on the user's screen and are left out of captures (the last row of this table); see `docs/SECURITY_PRIVACY.md` §4. |
| Microphone capture | Fully supported | WASAPI through PyAudioWPatch. |
| System audio (loopback) capture | Native Windows integration | WASAPI loopback through PyAudioWPatch. Per-application capture (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, Win10 2004+) is **not** implemented; see §8. |
| Local STT on GPU | Requires hardware benchmarking | faster-whisper / CTranslate2 with CUDA 12 + cuDNN 9 pip wheels. RTX 50 (Blackwell, sm_120) support is verified by `engine/benchmarks/stt_benchmark.py`; results are in `docs/BENCHMARKS.md`. |
| CPU fallback | Fully supported | CTranslate2 int8 on CPU, or Parakeet INT8 on ONNX Runtime. |
| NVIDIA Parakeet TDT 0.6B (v2, v3) | Fully supported, benchmarked | ONNX export run on ONNX Runtime without PyTorch or NeMo: DirectML (FP32) on the GPU, INT8 on the CPU. CUDA was rejected because onnxruntime-gpu ≥ 1.27 targets CUDA 13 and the CUDA provider would push the installer past 2 GB; see BENCHMARKS.md. |
| Silero VAD | Fully supported | ONNX model bundled with faster-whisper and run through onnxruntime on CPU, without PyTorch. |
| Question detection | Fully supported | Deterministic rule-based pipeline on the CPU. No second model is loaded onto the GPU. |
| Screenshot: monitor, all monitors, active window | Native Windows integration | GDI BitBlt through `mss`; active-window bounds come from `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`. Windows Graphics Capture was evaluated, but it needs a WinRT projection and a consent prompt per item, and it offers nothing extra for user-initiated still captures. DRM-protected content shows as black, which is expected and not bypassed. |
| Image clipboard | Native Windows integration | `CF_DIB` through Win32 `SetClipboardData` (ctypes). |
| Google Gemini, Groq, OpenRouter | Supported; not tested with real keys | OpenAI-compatible APIs with a no-payment tier (checked 2026-11-20). The model is chosen from the provider's own list on Connect. See `docs/PROVIDERS.md`. |
| OpenAI (ChatGPT models), Anthropic (Claude), DeepSeek, xAI (Grok) | Requires provider access | Official REST APIs. **They need a paid API key**: a consumer ChatGPT, Claude, Grok, or DeepSeek chat subscription does not include API access. |
| Custom models | Fully supported | Any number of user-defined OpenAI-compatible endpoints (local servers, gateways, other vendors); API key optional. Tested against a real local server. |
| Meta AI | Website only | There is no generally available public consumer API. Use it as an AI chat tab, or in the browser with the copy workflow. |
| AI chat tabs (embedded provider websites) | Supported; depends on each website | Provider sites cannot be framed (`X-Frame-Options` / CSP `frame-ancestors`), so each tab is a native child webview of the main window (Tauri `unstable` multi-webview) with a shared profile. ZHU fills the message box and attaches screenshots; it never signs in or submits. Sites change without notice, and some refuse sign-in in embedded browsers. Tested signed-out only; see `docs/WEB_CHATS.md`. |
| Credentials | Fully supported | Windows Credential Manager through `keyring`. Credentials are never written to SQLite or to logs. |
| Capture-exclusion "privacy mode" | Native Windows integration | Part of the hide switch: while ZHU is hidden, `bars.rs` sets the display affinity "exclude from capture" on all three windows (Tauri `set_content_protected`), and for the moment of a screenshot ZHU takes itself. Windows 10 2004 or later. See `docs/SECURITY_PRIVACY.md` §4 for the limits. |
| Installer `ZHU-Setup.exe` | Fully supported (built and tested) | Tauri NSIS bundler with a PyInstaller one-folder engine as a resource: 880 MB. The CUDA libraries are compressed once at build time and unpacked by the installer (see INSTALLATION.md §3). NSIS has a ~2 GB data limit, so only the CUDA DLLs proven necessary are bundled (see packaging/zhu-engine.spec). Model weights download once on first run. |
| Code signing | Requires a certificate | A plan is in `docs/INSTALLATION.md`. Builds produced here are unsigned. |

## 3. Process model

```text
┌─────────────────────────────── zhu.exe: one process ───────────────────────────────┐
│  Rust (Tauri 2)                                                                     │
│    Window manager: main · floating icon · opacity                                   │
│    Tray · global shortcuts · autostart · single-instance · window state             │
│    EngineSupervisor (engine.rs): owns the token, starts / restarts / stops          │
│      the engine; embedded.rs loads the Python runtime when the engine first starts  │
│        │ thread "zhu-engine" runs embedded.run(token, data_dir, report)            │
│        ▼                                                                            │
│  Python 3.13, loaded at run time                     WebView2 windows (React)       │
│    FastAPI + WebSocket on 127.0.0.1:<random>  ◄────  REST: Authorization: Bearer    │
│    audio → VAD → STT → question engine        ────►  WS: subprotocol bearer.<tok>   │
│    storage (SQLite) · capture · providers                                           │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

* **One process.** The engine runs inside `zhu.exe`, on a thread of its own. `zhu.exe` is not linked against Python: `embedded.rs` loads the runtime (`zhu-engine\_internal\python313.dll` in an installation; the Python of `engine\.venv` in a development build) the first time the engine starts, and looks up its functions by name. A missing or incomplete runtime is an error the window shows, with Restart; there is no other way of running the engine.
* **The window outlives the engine.** An error in the engine's Python code ends its run, never the app: `zhu_engine/embedded.py` catches everything, `SystemExit` included, and reports it. The supervisor restarts the engine after a failure, up to three times in a row; after that, and while it restarts, the window stays on screen with a notice and a **Restart engine** button. **Restart engine** is also in Settings → App and in the tray menu.
* **What one process cannot contain:** a crash inside a native library (speech recognition, graphics) ends the whole app. If ZHU ended that way within a minute of starting its engine, the next start does not start the engine by itself; the window says so and offers to start it. This keeps a crash at start from repeating every time ZHU opens.
* **Restarting in place.** The interpreter is started once and kept. Each start of the engine is a new run inside it that closes what it opened (database, log files, the server's socket). An engine that does not stop when asked cannot be replaced in the same process; the window then offers **Restart ZHU**.
* `zhu-engine.exe` is still installed: the installer runs it once to unpack the NVIDIA libraries (§3, INSTALLATION.md), and the build smoke-tests it. The app never starts it.

* The engine is the **single source of truth** for session, transcript, question, screenshot, and provider state. The main window subscribes to its WebSocket stream and replays missed events after a reconnect, so it cannot drift from the engine.
* UI-only preferences (theme, sidebar state, window opacity) live in the front-end preference store. They are broadcast between windows with Tauri events.

### Local IPC hardening

* The engine binds only to `127.0.0.1`. The port is chosen by the OS (port 0) and reported to the shell when the server is up (in-process; the stand-alone `python -m zhu_engine` prints `ZHU_ENGINE_READY port=<n>`).
* A 256-bit random token is generated by the Rust supervisor for every start and handed to the engine in-process; it is never written to disk. Every HTTP route requires `Authorization: Bearer`. The WebSocket requires the `bearer.<token>` subprotocol, so the token never appears in URLs or access logs. Comparisons use `hmac.compare_digest`.
* CORS allows only `http://tauri.localhost`, `tauri://localhost`, and the Vite dev origin. A malicious web page cannot read responses, and it cannot authenticate because it does not know the token.
* The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding.
* The engine ends with ZHU: it runs inside its process. On quit the supervisor first stops it in order (listening stops, the database closes), bounded at a few seconds.

## 4. Repository layout

```text
ZHU/
├── apps/desktop/                  Tauri 2 + React desktop application
│   ├── src/                       React front end (one bundle, three window roots)
│   │   ├── app/                   window roots, routing, state stores, providers
│   │   ├── components/            primitives · layout · transcription · questions · capture · composer · setup
│   │   ├── features/              the four screens (home, webchat, history, settings)
│   │   ├── hooks/ services/ styles/ types/ utils/
│   └── src-tauri/                 Rust shell (windows, tray, hotkeys, the in-process engine, web chat tabs + page helper)
├── engine/                        Python processing engine
│   ├── zhu_engine/
│   │   ├── api/                   FastAPI app, auth, WebSocket hub, routes
│   │   ├── audio/                 device enumeration, WASAPI capture, preprocessing, resampling
│   │   ├── vad/                   Silero VAD (onnxruntime) + streaming segmenter
│   │   ├── stt/                   faster-whisper and Parakeet (ONNX Runtime) back ends, model ladder, transcriber
│   │   ├── questions/             the Question Detection Engine (see docs/QUESTION_ENGINE.md)
│   │   ├── capture/               screenshots, thumbnails, clipboard
│   │   ├── providers/             ProviderAdapter + OpenAI/Anthropic/DeepSeek/xAI/Meta + user-defined custom endpoints
│   │   ├── storage/               SQLite database + migrations + repositories
│   │   └── system/                GPU telemetry, paths, logging with redaction, parent watchdog
│   ├── tests/                     pytest suite (unit + integration)
│   ├── evaluation/                labelled question-detection dataset + evaluator
│   └── benchmarks/                STT and question-engine benchmarks
├── packaging/                     PyInstaller spec, build scripts
└── docs/                          documentation deliverables
```

## 5. Data contracts

The canonical definitions are the Pydantic models in `engine/zhu_engine/api/schemas.py` and `engine/zhu_engine/questions/types.py`. They are mirrored in `apps/desktop/src/types/engine.ts`. A summary follows.

### 5.1 WebSocket envelope

```json
{ "seq": 412, "event_type": "question.updated", "session_id": "…", "ts_ms": 1763350000000, "data": { … } }
```

* `seq` increases strictly within one engine process. A client sends `{"type":"hello","last_seq":N}` on connect, and the server replays the buffered events after N from a bounded ring of 2,000 events. Clients drop any event with `seq <= last_seen`, which makes processing idempotent.
* `engine_instance` is also sent in `hello.ack`. When it changes (the engine restarted), clients refetch their REST state.

| event_type | data |
|---|---|
| `transcript.partial` / `transcript.final` | `TranscriptSegment` |
| `question.created` / `updated` / `completed` / `revised` / `discarded` / `error` | `Question` |
| `listening.status` | `ListeningStatus` |
| `audio.level` | `{source, rms_db}` (throttled to 10 Hz) |
| `gpu.stats` | `GpuStats` (every 2 s while listening) |
| `screenshot.created` / `screenshot.deleted` | `Screenshot` / `{id}` |
| `session.created` / `session.updated` / `session.deleted` | `Session` |
| `provider.started` / `provider.delta` / `provider.completed` / `provider.error` | `{request_id, interaction_id, provider_id, text?, error?}` |
| `model.download` | `{model, state, message}` |

### 5.2 REST surface

All routes are under `http://127.0.0.1:<port>/api`.

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness + version |
| `GET /system/gpu` · `GET /system/diagnostics` | GPU telemetry, versions, model status |
| `GET/PUT /settings` | engine settings (validated by Pydantic) |
| `GET /audio/devices` | WASAPI input + loopback devices |
| `GET/POST /sessions` · `GET/PATCH/DELETE /sessions/{id}` · `POST /sessions/{id}/end` · `GET /sessions/{id}/export?format=md|json` | session management |
| `GET /sessions/{id}/transcript` · `PATCH /transcript/{id}` | transcript + manual correction (raw text preserved) |
| `POST /listening/{start,pause,resume,stop}` · `GET /listening/status` | explicit recording controls |
| `GET /sessions/{id}/questions` · `POST /questions` · `PATCH /questions/{id}` · `POST /questions/{id}/save` · `POST /questions/merge` · `POST /questions/{id}/split` · `DELETE /questions/{id}` | question management |
| `GET /capture/monitors` · `POST /capture` · `POST /capture/frozen` · `POST /capture/frozen/{id}/crop` | screenshots |
| `GET /screenshots` · `GET /screenshots/{id}/{image,thumbnail}` · `POST /screenshots/{id}/copy` · `DELETE /screenshots/{id}` | gallery |
| `GET /providers` · `PUT /providers/{id}/config` · `DELETE /providers/{id}/credential` · `POST /providers/{id}/test` · `GET /providers/{id}/models` · `POST /providers/{id}/submit` · `POST /requests/{id}/cancel` · `GET /sessions/{id}/interactions` | providers |
| `GET/PUT /vocabulary` | user technical vocabulary |
| `POST /data/purge` | delete all local data |

## 6. Module dependency diagram

```text
                 api ───────────────┐
        ┌─────────┼────────┬────────┼─────────┐
        ▼         ▼        ▼        ▼         ▼
     session   capture  providers storage   system
     service      │        │        ▲         ▲
        │         └────────┴────────┤         │
        ▼                           │         │
  audio → vad → stt ──► questions ──┘         │
        └──────────────────┴──────────────────┘ (gpu telemetry, paths, logging)
```

`questions` has **no** dependency on audio, STT, storage, or the API. It consumes `TranscriptSegment` values and returns `QuestionEvent` values, so it is testable in isolation. `SessionService` (in `zhu_engine/session.py`) is the composition root: it wires audio → VAD → STT → questions → storage → WebSocket hub.

## 7. Threading model (engine)

* asyncio event loop: HTTP, WebSocket, provider streaming (httpx async), question engine ticks.
* One capture thread per audio source (PyAudio callback → bounded `queue.Queue(maxsize=…)`; when the queue is full the *oldest* block is dropped and counted).
* One VAD/segmenter thread per source.
* **One** STT worker thread that owns the single WhisperModel and serializes GPU work. Its job queue is bounded, and a partial-decode job is coalesced (replaced) when a newer partial for the same segment arrives.
* Results are passed back to the loop with `loop.call_soon_threadsafe`.

## 8. Known limitations (honest list)

1. Whisper is not a native streaming model. ZHU gets partial results by re-decoding the growing speech segment at an interval and finalizing at VAD end-of-speech. A partial can therefore change between revisions, and the UI shows it as provisional.
2. Per-process audio capture is not implemented. ZHU captures the default render endpoint loopback, which contains every application's audio.
3. Speaker diarization is not implemented. Speakers are labeled by **audio source** only (microphone / system audio, with user-configurable labels), and `speaker` is `"unknown"`.
4. Snap Layouts flyout: see the feasibility matrix.
5. Builds are unsigned until a code-signing certificate is supplied.
