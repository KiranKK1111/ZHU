<div align="center">

<img src="apps/desktop/public/zhu-mark.svg" width="104" alt="The ZHU mark: a speech bubble holding a voice waveform" />

# ZHU

**Hear every question. Have an answer ready.**

ZHU is a Windows desktop app that listens to a conversation, writes down each question as it is asked,<br/>
and helps you answer it. Speech recognition runs on your own computer.

![Windows 10 and 11](https://img.shields.io/badge/Windows-10%20%C2%B7%2011-8b7cf6?style=flat-square&labelColor=1b1e27)
![Tauri 2](https://img.shields.io/badge/Tauri-2-8b7cf6?style=flat-square&labelColor=1b1e27)
![React and TypeScript](https://img.shields.io/badge/React-TypeScript-8b7cf6?style=flat-square&labelColor=1b1e27)
![Python 3.12 or later](https://img.shields.io/badge/Python-3.12%2B-8b7cf6?style=flat-square&labelColor=1b1e27)
![MIT license](https://img.shields.io/badge/License-MIT-8b7cf6?style=flat-square&labelColor=1b1e27)

[What it does](#what-zhu-does) · [Install](#install) · [Using ZHU](#using-zhu) · [Run from source](#run-from-source) · [Privacy](#privacy) · [Documentation](#documentation)

<br/>

<img src="docs/images/home.png" width="92%" alt="ZHU while listening: Live with the recording time, Pause and Stop in the title bar; the questions it picked out of the conversation on the left with the transcript below them; the AI model's answer on the right, with the Ask anything box under it" />

<sub>ZHU while listening: the recording time and controls in the title bar, questions picked out of the conversation, the live transcript, and an answer.</sub>

</div>

---

## What ZHU does

In an interview or a meeting, questions come quickly and are easy to lose. ZHU keeps up with them for you.

It listens to the call and to your microphone, turns the speech into text **on your computer**, and picks out the questions. Each one appears on screen, written out clearly, a moment after it is asked. From there, one click puts it into your chats, right next to the questions: ZHU's own Custom chat, which answers with the AI model you chose, and the chat websites you already use. While you listen, ZHU can put each question there by itself. You press Send.

```mermaid
flowchart LR
    A["Call audio<br/>Zoom · Teams · Meet · browser"] --> C
    B["Your microphone"] --> C
    C["Speech recognition<br/>on your computer"] --> D["Question detection"]
    D --> E(["Questions, as they are asked"])
    E --> G["Custom chat<br/>the AI models you connect"]
    E --> H["Chat websites<br/>ChatGPT · Claude · Gemini"]
```

Audio is never uploaded and never saved. A question leaves your computer only when it is sent to the AI model or the website you picked.

## Highlights

| | |
|---|---|
| **Live questions** | Every question in the conversation is collected, newest first, while the full transcript runs underneath. |
| **Listening, one click away** | Start, pause and stop from the title bar, always in view, with the recording time. |
| **Answers, two ways** | ZHU's own Custom chat with the AI models you connect, or the chat websites you already use (ChatGPT, Claude, Gemini and others). Both open as tabs beside the questions. |
| **Free to start** | Two services answer without a key or an account. Google Gemini, Groq and OpenRouter have free tiers. Paid providers and local models (Ollama, LM Studio) work too. |
| **Send to chat** | One click puts a question into the message boxes of your chat tabs. While you listen, ZHU can do it for every question. You review it and press Send. |
| **Screenshots** | Capture the screen with one shortcut and send the picture with your question. ZHU keeps itself out of its own screenshots. |
| **Knows what a model can read** | The model list marks each model: images, documents, audio, video, or text only. A screenshot is never sent to a model that cannot read it. |
| **Your resume and the job** | Upload your resume once (a document, or a scan or photo of it) and questions about you are answered from it, in your voice, by every model and on the chat websites. Correct it, keep several, and add the job you are applying for. |
| **Your layout** | Drag the lines between the questions, the chat and the transcript to size them your way, or fold the questions away. ZHU remembers it. |
| **Opacity** | Make ZHU see-through, from 40% to 100%: the whole window, chat tabs included. |
| **Hide mode** | One button takes ZHU out of the taskbar, the tray, Alt+Tab and screen captures, keeps it on top of your screen, and makes it 80% see-through. Over ZHU the real pointer stands still for viewers while ZHU's own arrow moves for you. |
| **One process** | The engine runs inside ZHU itself: one entry in Task Manager. If it ever stops, the window stays and **Restart engine** brings it back. |
| **Chats are kept** | Every Custom chat conversation is stored on your computer. The clock button in the chat reopens or deletes earlier ones. |

## Install

**Requirements**

| | |
|---|---|
| System | Windows 10 (21H2 or later) or Windows 11, 64-bit |
| Memory | 8 GB minimum, 16 GB recommended |
| Graphics | Optional. An NVIDIA card (driver 550 or later) makes transcription faster; without one ZHU uses the processor. If a card's driver is missing, ZHU says so and links to it |

**Steps**

1. Download `ZHU-Setup.exe` from the [Releases](../../releases) page (about 880 MB). Every version is built there automatically. No release yet? [Build it](#build-the-installer) with one command.
2. Run it. It installs for your user account and needs no administrator rights. Nothing else has to be installed: no Python, no Node, no CUDA toolkit.
3. Start ZHU from the Start menu. The first time, it asks you to download a speech model (once; after that it works offline). ZHU looks at your hardware and recommends one.

> [!NOTE]
> Builds from this repository are not code-signed yet, so Windows SmartScreen may show "Windows protected your PC". Choose **More info**, then **Run anyway**.

## Using ZHU

ZHU is one screen: the questions on the left, your chats beside them as tabs, and the panel for screenshots and your resume on the right. The gear in the title bar opens **Settings**; press it again, or Esc, to go back to the chats.

### 1. Choose how you want answers

Either way works, and you can use both. Open a chat with the **+** on the tab strip (with no tab open yet, the chat area lists them).

* **Custom chat with an AI model.** Press the gear, then **Answers → Manage models**. For a free start, press **Get a free key** next to Google Gemini, Groq or OpenRouter, paste the key and press **Connect**. ZHU checks the key and picks a model. Then open a **Custom chat** tab.
* **No key at all.** Open a **Custom chat** tab and press **Start without a key**. Two free public services answer right away. Their providers may log what you send, so keep sensitive text for a provider you have a key for.
* **The chat websites you already use.** Pick ChatGPT, Claude, Gemini or another site from the **+** menu. Sign in once, as in a browser.

<p align="center">
  <img src="docs/images/custom-chat.png" width="92%" alt="Custom chat inside ZHU: a formatted answer with highlighted code, the Ask anything box with the model chip, and Start listening in the title bar" />
</p>

### 2. Start listening

Press **Start listening** in the title bar; it is always there, in Settings too. ZHU listens to the call (your computer's sound) and to your microphone, or to only one of them: Start listening asks which (system audio and microphone, system audio only, or microphone only). While it listens, the title bar shows **Live** with the time, and **Pause** and **Stop** next to it; the tray icon says whether ZHU is recording too. To start with an empty page, use **Clear** on the questions and on the transcript.

<p align="center">
  <img src="docs/images/title-bar.png" width="640" alt="The title bar while listening: Live with the recording time, Pause and Stop, then the opacity control opened with its slider, the eye button for hide mode, and the panel button" />
</p>

### 3. Read the questions, get the answers

* **Questions** (left) lists every question that is asked. **Send to chat** puts it into the message boxes of your chat tabs, where you review it and press Send; with no chat tab open, it opens a Custom chat with the question in it. **Copy** copies the question, and the **⋯** menu corrects the wording or removes something that was not a question.
* While you listen, each detected question is also put into the chat tabs by itself (switch it off with the options button at the right of the tab strip).
* **Custom chat** (right) answers like a chat, with formatted text, tables, code and formulas. The model chip in its message box changes the model. **New chat** starts another conversation, and the clock button reopens earlier ones.
* **Make room** where you need it: drag the line between the questions and the chat, or the line above the transcript. Double-click a line to go back to the original sizes. The button at the right of the Questions header folds the column away.

### 4. Add what is on your screen

Press **Ctrl+Shift+A**, or the capture button at the top of the **Screenshots** panel on the right, to capture the whole screen. The picture lands in that panel and is attached to the drafts in your chat tabs. From the panel you can drag it into any message box, or use **Add to …** on it: it goes to the chat tab that is shown, or to a new Custom chat when no tab is open.

The model list shows what each model can read, so pick one with the image mark when you want to send a screenshot.

<p align="center">
  <img src="docs/images/model-list.png" width="420" alt="The model list: each model is marked with what it reads (images, audio, video, or text only), and the chips at the top filter the list" />
</p>

### 5. Let it answer as you

In the panel on the right, upload **your resume** (PDF, Word, text, or a picture of the page) and, if you like, **the job** you are applying for. While they are switched on, questions about you ("tell me about yourself", "what was your biggest project?") are answered from them, by the AI models and on the chat websites (the resume goes with the first question of each new chat). Under **Settings → Answers → How answers should sound** you can add a sentence that goes with every question, for example *"Answer briefly, the way I would say it in an interview."*

### 6. Keep it in view, or out of the way

* **Opacity:** the opacity button in the title bar makes ZHU see-through, so you can read what is behind it. It applies to everything in ZHU, the chat tabs included.
* **Hide mode:** the eye button in the title bar takes ZHU out of the taskbar, Alt+Tab and screen captures, keeps the main window on top of your other windows, and sets the opacity to 80% (change it as you like while hidden; showing ZHU again brings back your usual opacity). Its tray icon goes too. Over ZHU (its title bar too) the real pointer stands still where it entered, so a screen share shows it stopped, while an arrow that looks just like your own Windows pointer moves for you and takes your clicks, scrolling, typing and title-bar drags; when you leave ZHU the real pointer glides to where you left, and at the window's edges it is back so you can resize (Settings → App → **Freeze the pointer while hidden**). Minimize it and a small floating icon brings it back. ZHU opens the way it closed: hidden again (at the opacity it had) if it was, without ever showing in the taskbar or a screen share while it starts.

### Keyboard shortcuts

These work from any app. Change them under **Settings → App → Edit shortcuts**.

| Shortcut | Action |
|---|---|
| `Ctrl` `Shift` `L` | Start, pause or resume listening |
| `Ctrl` `Shift` `A` | Screenshot of the whole screen |
| `Ctrl` `Shift` `C` | Copy the latest question |

The [user manual](docs/USER_MANUAL.md) covers everything in detail.

## Run from source

**You need:** Python 3.12 or later, Node 18.20 or later, Rust (stable, MSVC), Visual Studio Build Tools 2022 with the C++ workload, and the WebView2 runtime.

```powershell
# 1. The engine (speech recognition, question detection, AI providers)
cd engine
py -3 -m venv .venv
.venv\Scripts\pip install -e ".[dev,cuda]"
.venv\Scripts\pip uninstall -y onnxruntime
.venv\Scripts\pip install --force-reinstall --no-deps onnxruntime-directml==1.24.4
.venv\Scripts\python -m pytest

# 2. The desktop app (it runs the engine inside itself, with the Python of engine\.venv)
cd ..\apps\desktop
npm install
npm test
npm run tauri dev
```

The two `onnxruntime` lines replace the processor-only build that one dependency pulls in with the DirectML build ZHU uses.

### Build the installer

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build.ps1
```

This runs the tests, freezes the engine, builds the app and writes `dist\ZHU-Setup.exe` with its SHA-256 checksum next to it. Useful switches: `-SkipInstall` reuses the packages already installed (quicker, and it works while the dev session is running), `-SkipTests` skips the test suites, and `-Sign` code-signs. With `-SkipInstall` a build takes about four minutes on the development laptop, including every test and a check that the app can run the freshly built engine.

> [!TIP]
> Close a running `npm run tauri dev` session first. The script reinstalls dependencies, and Windows refuses to replace files that the running app has open.

### Publish a version

Push to `main` and GitHub does the rest: it works out the next version from your commit messages, builds the installer, and publishes it on the [Releases](../../releases) page.

| Your commit says | Version goes |
|---|---|
| `feat!: …`, or `BREAKING CHANGE: …` in the message | 1.4.2 → **2**.0.0 |
| `feat: …`, or starts with Add, Implement, New, Support… | 1.4.2 → 1.**5**.0 |
| anything else (fixes, clean-ups) | 1.4.2 → 1.4.**3** |

`packaging\version.ps1` tells you what the next version would be before you push. A push that changes only documentation is skipped. Details: [Installation, Releasing](docs/INSTALLATION.md#releasing-the-installer-is-built-on-github).

## Privacy

* **Speech stays local.** Transcription and question detection run on your computer. Audio is held in memory only: it is never written to disk and never uploaded.
* **You decide what is sent.** An AI model receives a question only when you press **Send** in the Custom chat. A screenshot is sent only when it is attached and you send. A chat website can see its message box before you press Send, so a question or screenshot placed in its draft reaches that site (see [Chat websites](docs/WEB_CHATS.md)).
* **Keys are kept by Windows.** API keys go into Windows Credential Manager, not into files or the database.
* **Your data is yours.** Sessions, screenshots and models live in `%LOCALAPPDATA%\app.zhu.desktop\data`. **Settings → Your data → Delete everything** removes them.
* **No telemetry.** ZHU reports nothing about you or your use of it.

More in [Security and privacy](docs/SECURITY_PRIVACY.md).

## Project layout

```
ZHU
├── apps/desktop          The desktop app (Tauri 2)
│   ├── src               Front end: React and TypeScript
│   └── src-tauri         Windows shell in Rust: windows, tray, shortcuts, hide mode, runs the engine in-process
├── engine/zhu_engine     The processing engine in Python, run inside the app (local server on 127.0.0.1, token-protected)
│   ├── audio · vad · stt Capture, voice detection, speech recognition (Whisper or NVIDIA Parakeet)
│   ├── questions         Question detection: rule-based, runs on the processor
│   └── providers         Connections to AI model providers
├── packaging             PyInstaller spec and the installer build script
└── docs                  Guides and reference
```

## Documentation

| Start here | Reference | Under the hood |
|---|---|---|
| [User manual](docs/USER_MANUAL.md) | [AI model providers](docs/PROVIDERS.md) | [Architecture](docs/ARCHITECTURE.md) |
| [Installation](docs/INSTALLATION.md) | [Custom chat](docs/CHAT.md) | [Audio pipeline](docs/AUDIO_PIPELINE.md) |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | [Chat websites](docs/WEB_CHATS.md) | [Question engine](docs/QUESTION_ENGINE.md) |
| [Security and privacy](docs/SECURITY_PRIVACY.md) | [Configuration](docs/CONFIGURATION.md) | [Database](docs/DATABASE.md) · [Front end](docs/FRONTEND.md) |
| | [Benchmarks](docs/BENCHMARKS.md) | [Testing](docs/TESTING.md) |

## Responsible use

ZHU is made for mock interviews, preparation, and meetings where transcription and assistance are permitted. Before you transcribe other people, get the consent that the law and the meeting's rules require. Hide mode keeps ZHU out of a shared screen, so other participants cannot see that it is in use: telling them is up to you.

## License

[MIT](LICENSE) © 2026 KiranKK1111
