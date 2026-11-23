# Security and Privacy

## 1. Data stays local by default

| Data | Where | Leaves the machine? |
|---|---|---|
| Audio | Memory only, in bounded queues. Audio is never written to disk | Never |
| Transcripts, questions, notes | `%LOCALAPPDATA%\app.zhu.desktop\data\zhu.db` (SQLite, WAL) | When you send a prompt to a provider, when you export, and, **if you have AI chat tabs open**, each detected question goes into those sites' message boxes |
| Screenshots | `%LOCALAPPDATA%\app.zhu.desktop\data\screenshots\` | The images you attach to a provider prompt, and, **if you have AI chat tabs open**, each new capture is attached to the drafts there |
| Your résumé | Only its text, in the database (`settings` table). The uploaded file is not kept | While it is switched on, the text goes to the AI model with every question you ask or that is asked automatically. It is not put into chat-website drafts. Removed by its bin button and by **Delete everything** |
| API keys | Windows Credential Manager (`ZHU / provider:<id>`) | Only to that provider's API endpoint (for a custom model: the endpoint URL you entered) |
| Chat-site sign-ins (cookies, site data) | `%LOCALAPPDATA%\app.zhu.desktop\webchat` (a separate WebView2 profile) | Used by the chat sites themselves, as in a browser. ZHU does not read them. Cleared by **Sign out of all chat sites** |
| Speech models | `%LOCALAPPDATA%\app.zhu.desktop\data\models\` | One-time download from Hugging Face; no data is uploaded. Parakeet uses a community ONNX export of NVIDIA's model (`istupakov/parakeet-tdt-0.6b-v2-onnx` / `-v3-onnx`, CC-BY-4.0), pinned to the tested commit. ONNX files are model graphs and weights that ONNX Runtime interprets; they contain no executable code |
| Logs | `%LOCALAPPDATA%\app.zhu.desktop\data\logs\engine.log` (rotating, 3 × 2 MB) | Never. Secrets are redacted, and transcript text is not logged |

* Transcription and question detection run **locally** (GPU or CPU). Audio is never uploaded.
* There is **no telemetry**. FastAPI's OpenTelemetry layer has no exporter, and `OTEL_SDK_DISABLED`, `FASTAPI_OTEL_AUTO_CONFIGURE=false`, and `HF_HUB_DISABLE_TELEMETRY=1` are set at engine start.
* An AI model you connected receives a question when you press **Answer** or **Send**. With **Auto-answer** switched on (it is off by default), every question detected while listening is sent to the selected model without a click. A screenshot goes to a model only when it is attached in the ask box and you send.
* **Custom chat** (ZHU's own chat) sends a message, with the earlier turns of that conversation, to the provider of the selected model when you press Send. Conversations are stored in the local database. Two built-in providers (Kilo Gateway, Pollinations) answer without a key; they are contacted only after you press **Start without a key** or connect them, and their free models may log prompts. See CHAT.md.
* **AI chat tabs change this for the sites you open.** With a chat tab open, ZHU places detected questions in the site's message box and attaches captured screenshots to the draft. A site can read its message box before you press Send, and most sites upload an attachment when it is added. Both deliveries can be switched off, and nothing is delivered when no chat tab is open. ZHU never presses Send and never signs in. See WEB_CHATS.md.

## 2. Recording controls and consent

* Audio capture starts only when you press **Start listening** in the title bar (or use the tray menu or the hotkey you configured). It stops when you pause, stop, end the session, or quit; the engine runs inside ZHU's process, so it cannot outlive it.
* While listening, the recording state is shown in text, not only by color: "● Live" or "Paused", with the time, in the title bar on every screen, next to Pause and Stop. When nothing is recorded the title bar offers **Start listening** instead. The tray tooltip says "Recording", "Recording paused" or "Not recording". The status is also announced through `aria-live`.
* You are responsible for obtaining the consent that applicable law and meeting rules require before you transcribe other participants. ZHU is intended for mock interviews, preparation, and meetings where transcription or assistance is permitted.

## 3. Local IPC hardening

The engine is an HTTP/WebSocket server bound to **127.0.0.1 only**.

| Threat | Mitigation |
|---|---|
| Another local process or user calls the API | A 256-bit random bearer token is generated for every start of the engine by the Rust shell and handed to the engine inside the process. It is never written to disk. Comparisons use `hmac.compare_digest` |
| A web page in a browser calls the API (CSRF) | The token is required, and CORS allows only `http://tauri.localhost`, `tauri://localhost`, and the Vite dev origin |
| DNS rebinding | Requests whose `Host` header is not `127.0.0.1:<port>`/`localhost:<port>` get 403. WebSocket upgrades check `Host` and `Origin` |
| Token leakage through URLs or logs | The WebSocket token travels in the `Sec-WebSocket-Protocol` header (`bearer.<token>`), never in a query string. Uvicorn access logs are disabled, and log records pass through a redacting filter |
| Orphaned engine keeps recording | The engine runs inside ZHU's own process, so it cannot outlive it. On quit it is stopped in order first (listening stops, the database closes) |
| Malicious input | All request bodies are validated by Pydantic with length limits. Screenshot and model paths are resolved server-side from IDs, never from client-supplied paths |

The webview's Tauri capability set is minimal: window controls, events, writing text to the clipboard, opening URLs, and autostart. There is **no file-system or shell access** from the UI. The content security policy limits connections to `ipc:` and `127.0.0.1`.

### Embedded chat websites

AI chat tabs show third-party websites inside the main window. They are isolated from ZHU:

| Threat | Mitigation |
|---|---|
| A chat page calls ZHU's commands (for example `engine_info`, which returns the engine token) | Tauri rejects IPC from non-local origins unless a capability names the origin; none does. The capability lists ZHU's webviews by label, so `chat-*` webviews never match. Verified in the running app: every command tried from a chat page was rejected |
| A chat page loads ZHU's own UI (which has IPC access) inside the tab | Chat tabs may navigate only to `https:` pages outside `*.localhost` |
| A chat page reads ZHU's data or the other profile | Separate WebView2 user-data folder; ordinary browser origin isolation; the local engine requires the token and rejects foreign origins |
| ZHU types a question into a credential field | Sign-in pages are detected (path, host, password field) and never written to; single-line inputs are used only through a site-specific hint |
| Script injection through question text or image data | Passed as JSON string literals; image data must match the base64 alphabet |
| A debugging port left open | Only debug builds honour `ZHU_WEBCHAT_DEBUG_PORT` |

## 4. Screen-capture exclusion ("privacy mode")

ZHU can leave its own windows out of screen captures with the documented Windows capture-exclusion API (`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`). Windows keeps drawing the windows on your display and omits them from what a screenshot, a recording or a screen share receives. It is used in two cases:

* **While ZHU is hidden** (the eye button, next section): for as long as the switch is on.
* **While ZHU takes a screenshot itself** (the screen button, or Ctrl+Shift+A): for about a fifth of a second, so the picture shows what you are working on and not ZHU. A timer ends it after 4 seconds in any case. The capture is silent: no notice appears, and the screenshot shows up in the panel on the right. If ZHU is not hidden, anyone watching a screen share could see it blink out for that moment.

Otherwise ZHU's windows appear in captures like those of any other app.

Limits of capture exclusion:

* It needs Windows 10 version 2004 or later. Older versions show a black rectangle in the capture where the window is.
* It covers what Windows composes for a capture. It does nothing about a camera or a second person looking at the screen, and remote-control tools that read the display in other ways are not guaranteed to honor it.
* It covers ZHU's two windows (main with its chat tabs, floating icon). Windows that belong to the system and are opened from ZHU, such as the tray menu and the "Save as" dialog of an export, are not covered.
* The tray icon is removed while ZHU is hidden, and comes back when it is shown again.

ZHU uses no process hiding, and it does not try to evade security tools: ZHU stays in Task Manager (one process, `zhu.exe`, which runs the engine inside it). The floating icon uses `skipTaskbar`, the standard behavior for a floating palette, and it remains an ordinary top-level window of the visible ZHU process.

### Hide from the taskbar, Alt+Tab and screen capture

The eye button in the title bar, and the same entry in the tray menu, hide ZHU and put it back. ZHU remembers it: if it was hidden when it closed, it opens hidden again. The shell keeps that, with the opacity of each mode, in `start-state.json` in ZHU's folder under `%LOCALAPPDATA%` (nothing else is in it), and makes the window a hidden one before it is first shown, so a starting ZHU never appears in the taskbar, the tray or a capture. While it is on:

* **ZHU is not in the taskbar, Alt+Tab or Task View.** Its two windows (main, floating icon) carry the Windows "tool window" style, which is the documented way to leave a window out of those lists.
* **ZHU is not in screen captures**, as described above. The windows stay on your own screen where they are.
* **ZHU is not in the system tray.** Its tray icon is removed and comes back when ZHU is shown again. A minimized ZHU comes back through the floating icon, or by starting ZHU again (which shows the window that is already running).
* **The main window stays on top of other windows.** With no taskbar button, no Alt+Tab entry and no tray icon, a window behind others would be hard to reach. If another program takes the "always on top" state away, ZHU sets it again at once. System surfaces that Windows always draws above applications (the Start menu, the lock screen, a permission prompt) still cover it, and so does another always-on-top window that you click afterwards.
* **The pointer freezes over ZHU** (Settings → App → **Freeze the pointer while hidden**, on by default). For that, ZHU installs a Windows low-level mouse hook while it is hidden, and removes it when it is shown again or the setting is switched off. The hook sees mouse movements, buttons and the wheel for the whole desktop, and acts on them only over ZHU's window: there it keeps them from moving the real pointer and from reaching other programs, and hands them to ZHU's own windows. When you leave ZHU it moves the real pointer to where ZHU's arrow is (gliding there in a fraction of a second); a click made during that moment is held back and made again at the arrow, so it reaches what you clicked on. It records nothing, stores nothing, and sees no keystrokes. ZHU's stand-in arrow is drawn from your own Windows pointer scheme (so it looks like your pointer, not like ZHU) and is left out of captures like its other windows.
* **The process is not hidden.** ZHU (`zhu.exe`) stays in Task Manager. The recording state is still shown in the title bar (§2). Hiding ZHU also sets its opacity to 80%; that changes only how ZHU looks on your screen.

The consent rules in §2 apply whether or not ZHU is hidden: other participants cannot see from a shared screen that ZHU is in use, so telling them is up to you.

## 5. Credentials

* Keys are stored with `keyring` (WinVault backend → Windows Credential Manager), encrypted for the user account by DPAPI.
* The API never returns a key. The UI receives only `has_api_key` and a 4-character hint.
* **Remove key** (Settings → AI models → Manage) removes the Credential Manager entry. Removing a model you added also removes its key.
* ZHU never handles the passwords of chat websites: you type them into the provider's own page, and the session cookie stays in the chat profile.

## 6. Retention and deletion

* Nothing is deleted automatically. (The engine supports a retention period, `privacy.retention_days`; the app no longer has a control for it.)
* **Keep the full transcript** (Settings → Your data) can be turned off. Questions are then still detected live, but transcript segments are not written to the database.
* Sessions, individual questions, and screenshots can be deleted from their screens. Deleting a session cascades to its transcript, questions, revisions, relationships, provider interactions, and screenshot files.
* **Settings → Your data → Delete everything** (typed confirmation required) removes every session, transcript, question, screenshot, interaction, and Custom chat conversation, and then runs `VACUUM` on the database. Models, API keys, and chat-site sign-ins are kept. Remove those separately (chat sites: **Sign out of all chat sites**).

## 7. Known limitations

* The SQLite database is not encrypted at rest (SQLCipher is not bundled). It is protected by your Windows account's file permissions, like other per-user application data. Use BitLocker for at-rest encryption.
* Builds produced in this repository are unsigned until a code-signing certificate is configured (see INSTALLATION.md §5). Windows SmartScreen may warn on first run.
