# Testing Strategy

| Layer | Command | What it covers |
|---|---|---|
| Engine unit + integration | `cd engine; .venv\Scripts\python -m pytest` | Question engine (all 20 §18 scenarios + per-stage units + manual ops + restart recovery), storage (migrations, crash recovery, revision-guarded upserts, cascades), API (auth, Host and CORS checks, sessions, questions, settings validation, providers without keys, WebSocket auth + replay, vocabulary, purge), event hub (sequence, replay, gap, slow subscribers), providers (SSE streaming, images, 429 + Retry-After, cancel, unsupported capabilities, Anthropic error mapping and message shape), DSP (vectorized high-pass vs. reference IIR, resampling + DC removal), model selection ladder, log redaction, screenshot store, VAD on real speech |
| Question-engine evaluation | `python -m evaluation.evaluate [--dataset evaluation\question_heldout.json]` | Precision, recall, F1, kind / category / format accuracy, follow-up resolution, sub-question counts, confidence calibration |
| STT benchmark (GPU) | `python benchmarks\stt_benchmark.py --e2e` (Whisper); `--configs parakeet-v2-dml,parakeet-v2-cpu,parakeet-v3-dml,parakeet-v3-cpu --e2e --e2e-config parakeet-v2-cpu` (Parakeet) | Load time, VRAM, process commit, latency, RTF, WER (clear, fast, 10 dB and 0 dB noise, two speakers), question detection on real STT output, real-time end-to-end latency. One process per configuration |
| Parakeet back end | part of `pytest` (`tests/test_parakeet.py`) | Catalog and pinned revisions, per-back-end installed-file check, language support, model selection (DirectML / CPU INT8 / memory and VRAM gates / GPU-required), load-failure ladder, SentencePiece word grouping and timing; real CPU inference when the model and benchmark audio are present |
| AI models | part of `pytest` (`tests/test_custom_providers.py`) | Free providers listed first and marked, non-chat models filtered out, automatic model choice from the provider's own list (stable before preview, newest version, nothing chosen when nothing is familiar, a chosen model is kept), a server that rejects the usage option; endpoint URL validation, add / persist / remove, id forgery, limit, keyless requests send no `Authorization` header, API routes (key stored but never returned), survival across an engine restart, and a full run against a real local OpenAI-compatible HTTP server (model list, streamed answer over the WebSocket, stored interaction) |
| Résumé, screenshots panel | part of `pytest` (`tests/test_resume.py`) and `npm test` (`tests/sidepanel.test.ts`) | Text from PDF, Word and text files; long files cut at a line; unusable files explained (old .doc, scans, damaged files, over 10 MB); the résumé block cannot be closed from inside the text; upload, switch and delete through the API; the résumé reaches the model on Home and in the chat only while switched on, with the question passed unchanged; purge removes it. Screenshots in the chat: refused for a provider not set to read images, sent once, text-only history, answer again. Attachments in a message box, where "Add to chat" goes, and the pointer drag (click vs. drag, drop zones, Escape). Live run with made-up data: [CHAT.md](CHAT.md#résumé) |
| Custom chat | part of `pytest` (`tests/test_chat.py`) and `npm test` (`tests/chat.test.tsx`) | Free-model detection (flags, price shapes, ids, local addresses, free tiers), model-list shapes, a free model selected on Connect; conversations against a local gateway-like server (two turns with two models, answer again, provider error and retry, thinking kept apart, rejected requests leave nothing behind, purge, interrupted answers); the model list and default choice, money vs. formulas, rendered Markdown (no HTML, no remote images, links open outside), the chat store, questions reaching the chat's message box. Live run: [CHAT.md](CHAT.md#tested) |
| Front end | `cd apps\desktop; npm test` | WebSocket envelope ordering and dedupe, revision-guarded stores, transcript partial→final replacement, auto-scroll logic, overlay coordinate mapping, shortcut recording; the question card; the taskbar switch in the title bar (starts in the shell's state, changes only when the shell says so, follows the tray menu, reports a failure); asking a model (selected model, answer instructions, images only for models that read them, no model connected), Auto-answer gating (off by default, once per question, only while listening), preference migration; AI chat tabs: service list vs. page-helper hints, tab ids, https-only addresses, message template, result wording, automatic-delivery gating (listening, switches, dedupe, revisions, target), and the page helper itself on plain text boxes (replace / append / already there, sign-in pages never written to, nothing is ever clicked) |
| Rust shell | `cd apps\desktop\src-tauri; cargo test --lib` / `cargo build` | Chat-tab id, address, and navigation rules; the window style with ZHU hidden from the taskbar and shown again; compiles the window, tray, hotkey, engine-supervisor, and web-chat code |
| Packaging | `packaging\build.ps1` | Smoke-tests the **frozen** engine (readiness, health, GPU detection) before building the installer |

## Not automated (manual QA checklist)

These need a real desktop session, and a person should check them on each release:

- [ ] Main window at 900×600, 1366×768, 1920×1080, 2560×1440, 3840×2160 and at 100/125/150/200% scaling: no clipping, overlap, or horizontal scroll
- [ ] Sidecar: drag, resize to 300×260, compact mode, edge snapping, move between monitors, unplug a monitor (it recovers within 5 s), opacity, click-through + Ctrl+Shift+K
- [ ] Windows Snap by dragging the title bar to an edge, Win+Arrow, double-click maximize
- [ ] Tray: show/hide, start/pause listening label, quit stops the engine (`zhu-engine.exe` gone from Task Manager)
- [ ] Hide from the taskbar, Alt+Tab and screen capture: press Alt+Tab and Win+Tab with it on (no ZHU, no sidecar, no floating icon) and off; switch it from the tray menu; restart Explorer with it on (no taskbar button comes back)
- [ ] While hidden: a full-screen screenshot (PrtSc, Snipping Tool) and a screen share show the desktop behind ZHU's main window, sidecar and floating icon; after switching the hiding off they show ZHU again; ZHU's own screenshot (Ctrl+Shift+A) taken while hidden leaves ZHU hidden afterwards
- [ ] While hidden: the main window stays above other apps when they are clicked, including a maximized one; the sidecar stays in front of the main window when the main window is clicked, and comes up in front when it is shown; with the sidecar's own "always on top" switched off, the main window covers it; after showing ZHU in the taskbar again the main window goes behind other windows normally
- [ ] Global hotkeys with a conflicting app registered
- [ ] Keyboard-only navigation of every screen; screen reader announces the recording state
- [ ] Clean install on a fresh Windows user account; first-run model download; uninstall

Every number in BENCHMARKS.md comes from these commands. Results must not be edited by hand.

## Live desktop test (2026-11-17)

The real app (`zhu.exe` debug + Vite) was run on the development laptop (RTX 5060, Windows 11, 125% scaling) with a throwaway data folder. It was driven through WebView2's DevTools protocol (real DOM clicks and mouse events) and real global hotkeys, with SAPI-synthesized interview audio played through the speakers and captured by system-audio loopback.

| Area | Result |
|---|---|
| Shell starts engine, UI connects (authenticated WebSocket) | ✅ |
| First-run setup: GPU detected, recommendation, low-memory warning, real download (`base`, 147.9 MB) → app switches to the workspace automatically | ✅ |
| Live transcription, large-v3-turbo FP16 on CUDA | ✅ transcript word-perfect, confidence 0.89–0.96 |
| Question detection live: direct, follow-up resolved ("How is HashMap different from ConcurrentHashMap in Java?"), coding task, scenario spanning two VAD segments, acknowledgement not a question, intentional repeats linked | ✅ |
| Uncertain words (low STT probability) shown with dotted underline | ✅ |
| Sidecar: global hotkey show, live transcript, latest question, Pause (engine → paused), compact bar (46 px), edge snap (gap 0), off-screen recovery | ✅ |
| Region capture: overlay, drag, Enter → 650×375 physical-pixel PNG at 125% scaling | ✅ |
| Copy question (button) and copy-latest hotkey (Ctrl+Shift+C) → Windows clipboard | ✅ |
| Light theme; 900×600 minimum: compact layout, no horizontal overflow | ✅ |
| Engine killed → supervisor restart ~1 s, both windows reconnect, session resumable | ✅ |

### Defects found by this test and fixed
1. No minimize/maximize/close on the setup and engine-starting screens → shared `WindowControls`.
2. Context-panel tab label clipped at 125% → 320 px panel, equal-width tabs.
3. Microphone failed to open: WASAPI shared mode needs the native channel count (4) → open with native channels.
4. One capture failure (or listing devices) terminated **all** audio streams: per-caller PortAudio instances were terminated → one process-wide `PortAudioHost`.
5. Scenario lost when split across VAD segments: loopback's sample clock drifted behind wall time and question completion used the wall clock → loopback silence padded against wall time and completion ticks on the audio clock.
6. Engine crash ended the active session → sessions stay resumable (recording never resumes on its own).
7. Overlay window creation failed (0x8007139F) whenever windows had custom WebView2 args → overlay inherits the main window's args.
8. Duplicate sidecar edge-snapping in the front end and shell → shell only.
9. Speech model never released after stop → unloaded after 120 s idle (frees VRAM and ~2 GB RAM for turbo).
10. Memory preflight message was not shown in the UI → displayed on the setup screen.

### Not covered by this run
Tray menu clicks, the native Save dialog (export), provider API calls with real keys (none configured), the microphone path with a human speaker, multi-monitor moves (one monitor available), and the 1024×768–3840×2160 / 100–200% scaling matrix (only 125% available).

## Simplified interface: live test (2026-11-20)

Debug build, throwaway data, driven through the DevTools protocol. Checked in the running app: the four-screen navigation; Home with a spoken question (transcribed locally, shown as a card, delivered to both chat tabs in 1.6 s); **Add another model** in Settings against a local OpenAI-compatible test server (connected and a model chosen in one step, no key); **Answer** on the question card and a typed question in the ask box, both answered in the Answers panel; History; the sidecar; the new Settings page.

Not checked: Gemini, Groq, OpenRouter and the other cloud providers with real keys (none were available), so "paste a key → Connect" was exercised end to end only against the local test server and in unit tests of the model choice.

## AI chat tabs: live test (2026-11-20)

Debug build on the development laptop, throwaway engine data, driven through the DevTools protocol of both the main webview and the chat profile. **No account was used: every site was signed out.** Results per site, the end-to-end run (speech → question → tabs in 1.8 s; screenshot attached in ChatGPT; nothing submitted), and what was not tested are in [WEB_CHATS.md](WEB_CHATS.md#tested-behaviour).

Also verified live: a chat page cannot call any ZHU command (`engine_info`, `webchat_tabs`, `event.listen`, `clipboard-manager.write_text` all rejected); two tabs of one site share the same cookies; the page area follows the window layout at 125 % scaling; the page is hidden on other screens and after a reload of the main window.

### Defects found by this test and fixed
1. A page that swapped its text box for a rich editor mid-delivery made the helper re-run the image phase and report 0 images → only the text phases restart on a replaced editor.
2. Meta AI collapses its layout to 0 × 0 while the tab is hidden, so its message box was "not visible" → size check skipped for a site's own hinted message box in hidden tabs.
3. **On DeepSeek's sign-in page the question was typed into the phone/e-mail field** → sign-in pages are detected and never written to; single-line inputs are no longer candidates for the generic search.
4. A sign-in page made a delivery wait 30 s → reported after 4 s ("sign-in page"), or after 10 s once a page is fully loaded without a message box.
5. After a page reload the site restored ZHU's unsent draft and the next question was appended to it → the shell remembers the last text inserted per tab.
6. Found in review, not by a failing run: a hidden main window flushed engine events on a throttled timer (up to 1 s late) → flushed in a microtask; show/hide commands could be applied out of order → serialized; a tab closed while its page was still being created left the page running → closed again after creation.

The installer rebuilt with these features (`dist/ZHU-Setup.exe`, 851 MB) was **not** put through the install / uninstall test below again; the install steps did not change.

## Installer test (2026-11-17, `dist/ZHU-Setup.exe`, 844 MB)

Real per-user install on the development laptop, with no test overrides.

| Step | Result |
|---|---|
| `ZHU-Setup.exe /S` | ✅ exit 0, registered in Apps as "ZHU 0.1.0", Start-menu shortcut |
| Launch installed `zhu.exe` | ✅ bundled `zhu-engine.exe` ready in ~4 s, CUDA detected (RTX 5060), first-run model setup shown; no Python, Node or CUDA toolkit used |
| Data location | ✅ `%LOCALAPPDATA%\app.zhu.desktop\data` (db, logs, models, screenshots); the install folder `%LOCALAPPDATA%\ZHU` holds program files only |
| Uninstall **while the engine is still running** | ✅ install folder fully removed in ~2 s, shortcut and registry entry removed, user data kept |

### Defects found by installer testing and fixed
1. NSIS failed (`error mmapping file … out of range`): the 2.0 GB CUDA runtime exceeded NSIS's ~2 GB limit → only the CUDA DLLs proven necessary are bundled (transcripts identical in FP16 and INT8/FP16; a control run without DLLs fails).
2. Program and data shared `%LOCALAPPDATA%\ZHU` (the per-user install folder) → data moved to the per-app data folder.
3. Uninstall left 31–41 locked engine files (97–126 MB) → NSIS hooks stop the engine and wait for it to exit, then sweep the engine folder.
4. Frozen windowed engine could lose the readiness handshake (`sys.stdout` is None) → fd-1 fallback; console logging only when stderr exists.
5. `anthropic` SDK was not a declared dependency → added to `pyproject.toml`.
