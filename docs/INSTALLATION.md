# Installation

## 1. End users: `ZHU-Setup.exe`

1. Run `ZHU-Setup.exe`. It installs per user and needs no administrator rights. If the WebView2 runtime is missing, the installer bootstraps it.
2. Start ZHU from the Start menu. **No Python, Node, CUDA toolkit, or developer tools are needed.** The installer contains the frozen engine with the CUDA 12 runtime (cuBLAS, cuDNN 9).
3. **First launch, one time only:** ZHU shows *Set up speech recognition*. It detects your GPU and recommends a model (large-v3-turbo for an RTX 5060 8 GB). Pick one and press **Download**. You'll see progress and can cancel; an interrupted download resumes. The model is stored in `%LOCALAPPDATA%\app.zhu.desktop\data\models`, and **later launches skip this step**. You can also choose *Skip for now* and download later from Settings → Listening → Speech recognition.
4. Uninstall from *Settings → Apps*. The uninstaller stops ZHU's engine and removes the program from `%LOCALAPPDATA%\ZHU`. Your data lives separately in `%LOCALAPPDATA%\app.zhu.desktop\data` (database, screenshots, models). It is kept unless you tick **Delete the application data** in the uninstaller, so a reinstall can reuse your models. API keys live in Credential Manager (`ZHU`) and can be removed from Settings → Providers first.

The list also offers **NVIDIA Parakeet TDT 0.6B** v2 (English) and v3 (25 European languages), about 3.0 GB each (FP32 weights for the GPU plus INT8 weights for the CPU). Parakeet runs on the GPU through DirectML when enough memory is free, otherwise on the CPU; both are bundled, so nothing else is installed.

**Why the models aren't bundled:** large-v3-turbo alone is 1.6 GB. Bundling the catalog would make the installer several GB and force a download of models you may never use. ZHU uses a one-folder engine and keeps models in user data, so no large file is ever re-extracted at launch.

### Requirements
Windows 10 21H2+ / Windows 11 x64 · 8 GB RAM minimum, 16 GB recommended · NVIDIA driver ≥ 550 for GPU mode (tested with 581.34). Without a compatible GPU, ZHU runs transcription on the CPU.

## 2. Developers

Prerequisites (verified on the development machine): Python 3.12+, Node 18.20+, Rust stable (MSVC) via `winget install Rustlang.Rustup`, Visual Studio Build Tools 2022 with the C++ workload, and the WebView2 runtime.

```powershell
# Engine
cd engine
py -3 -m venv .venv
.venv\Scripts\pip install -e ".[dev,cuda]"
# faster-whisper pulls in the CPU-only "onnxruntime" wheel, which overwrites the DirectML build
# (same package folder). Replace it, as packaging\build.ps1 does:
.venv\Scripts\pip uninstall -y onnxruntime
.venv\Scripts\pip install --force-reinstall --no-deps onnxruntime-directml==1.24.4
.venv\Scripts\python -m pytest            # unit + integration tests
.venv\Scripts\python -m evaluation.evaluate --dataset evaluation\question_heldout.json

# Desktop app (the debug shell starts the engine from engine\.venv automatically)
cd ..\apps\desktop
npm install
npm test
npx tauri dev
```

Run the engine alone with `engine\.venv\Scripts\python -m zhu_engine` in an interactive terminal. It prints a development token and `ZHU_ENGINE_READY port=<n>`.

## 3. Building the installer

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build.ps1
```

| Switch | Effect |
|---|---|
| `-SkipInstall` | Uses the Python and npm packages that are already installed. For a second build on the same computer; it also works while `npm run tauri dev` is running, which the installs do not |
| `-SkipTests` | Skips the engine and front-end test suites |
| `-Sign` | Code-signs the installer (needs `ZHU_SIGN_CERT_THUMBPRINT`) |

The script prints the time at each step and, at the end, how long each one took. Measured on the development laptop with `-SkipInstall`: 2 minutes 38 seconds for everything, and an installer of 882 MB.

The script:
1. sets up the venv;
2. runs the engine tests;
3. freezes the engine with PyInstaller (`packaging/zhu-engine.spec`, one folder → `build/zhu-engine`);
4. **smoke-tests the frozen engine** (readiness, `/health`, `/system/gpu`);
5. **packs the NVIDIA libraries** (`packaging/pack_cuda.py`, see below) into `build/stage/zhu-engine`;
6. runs the front-end tests;
7. runs `tauri build` with `tauri.bundle.conf.json`, which adds `build/stage/zhu-engine` as a resource;
8. writes `dist/ZHU-Setup.exe` and `dist/ZHU-Setup.exe.sha256`.

**Why the NVIDIA libraries are packed separately.** The CUDA runtime (cuBLAS, cuDNN: eight libraries) is 1.5 GB of the engine's 1.8 GB, and it is the same in every build. Compressing it inside the installer took about eleven minutes each time, on one processor core. Now each library is compressed once, all of them at the same time (about 3 minutes on the development laptop), and kept in `build/cuda-pack` under the SHA-256 of its content; later builds find it there. The installer carries the libraries as `<name>.dll.xz` and only stores them.

On the user's computer the installer unpacks them right after copying the files (`zhu-engine.exe --unpack-cuda`, from `apps/desktop/src-tauri/windows/hooks.nsh`; about 11 seconds on the development laptop). If that step does not run, the engine unpacks them at its next start, and until then it transcribes on the processor. Each build runs that unpack command of the freshly built engine on one library and compares the result with the original.

### Releasing: the installer is built on GitHub

`.github/workflows/release.yml` runs the same script on a GitHub Windows runner, under a version number it works out by itself.

* **Every push to `main` becomes a release.** The workflow reads the commit messages since the last release, decides the next version, writes it into the app, builds the installer, and publishes a GitHub Release with the tag `vX.Y.Z`, the installer and its SHA-256. A push that changes only documentation is skipped. Builds run one at a time: a newer push waits for the running build and is released as the version after it.
* **Actions → Build installer → Run workflow** builds the next version from any branch without releasing it; the installer is kept with that run as an artifact for 14 days.
* **A tag pushed by hand** releases exactly that version, whatever the commits say: `git tag v2.0.0`, then `git push origin v2.0.0`.

**How the version is decided** (`packaging\version.ps1`), from the first line of each commit message since the last release. The largest change decides:

| Part | Example | Raised by |
|---|---|---|
| Main version | 1.4.2 → 2.0.0 | A change that breaks something people rely on: `feat!: …`, `fix(api)!: …`, a line `BREAKING CHANGE: …` in the message, or a message starting with `major:` or `breaking:` |
| Sub version | 1.4.2 → 1.5.0 | A new feature: `feat: …`, or a message starting with Add, Implement, Introduce, New, Support, Enable, Allow or Create |
| Patch | 1.4.2 → 1.4.3 | Everything else: fixes, clean-ups, wording, build changes |

So the wording of a commit matters: "Add export to PDF" gives a new sub version, "Fix export to PDF" a patch. To see what the next version would be before pushing, run `packaging\version.ps1`; it only reports.

The version written in the repository's files (`0.1.0`) is only the starting point: with no release yet, the first one takes it. After that the tags hold the versions, and the workflow writes the number into the app at build time (`tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`, `pyproject.toml`, the engine's `__init__.py` and `engine_version.txt`) without committing anything. A build on your own computer therefore shows the version in the files, unless you run `packaging\version.ps1 -Apply` first.

The first build on GitHub with the old layout took 27 minutes. How long one takes now has not been measured yet; the build script prints the time of each step and a summary at the end, so the log of a run shows where it went. Three things are cached between builds: the Rust build, the engine's installed Python packages, and the compressed NVIDIA libraries. The first build after this change fills those caches, so the one after it is the first representative one. The runner has no NVIDIA card, so the smoke test prints "CUDA available: False"; the CUDA runtime is bundled regardless. Dependencies are not pinned to exact versions, so a build on GitHub can pick up newer packages than the ones on your computer.

## 4. Integrity

`ZHU-Setup.exe.sha256` holds the SHA-256 of the installer. Verify it with `Get-FileHash dist\ZHU-Setup.exe -Algorithm SHA256`. Model downloads are verified by size against the Hugging Face file listing, and a model is marked installed only after every required file is present.

## 5. Code-signing plan

1. Obtain an OV or EV code-signing certificate. An EV certificate gives immediate SmartScreen reputation. For CI, Azure Trusted Signing is an option.
2. Sign `zhu-engine.exe`, `ZHU.exe`, and the installer with SHA-256 digests and RFC 3161 timestamps (`build.ps1 -Sign` signs the installer; add the inner binaries through Tauri's `bundle.windows.certificateThumbprint` / `signCommand`).
3. Publish the SHA-256 alongside each release.

Until then, builds are **unsigned**, and SmartScreen will show "Windows protected your PC" (More info → Run anyway).
