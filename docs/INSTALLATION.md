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
powershell -ExecutionPolicy Bypass -File packaging\build.ps1          # add -Sign to code-sign
```

The script:
1. sets up the venv;
2. runs the engine tests;
3. freezes the engine with PyInstaller (`packaging/zhu-engine.spec`, one folder → `build/zhu-engine`);
4. **smoke-tests the frozen engine** (readiness, `/health`, `/system/gpu`);
5. runs the front-end tests;
6. runs `tauri build` with `tauri.bundle.conf.json`, which adds `build/zhu-engine` as a resource;
7. writes `dist/ZHU-Setup.exe` and `dist/ZHU-Setup.exe.sha256`.

### Releasing: the installer is built on GitHub

`.github/workflows/release.yml` runs the same script on a GitHub Windows runner.

* **Pushing a version tag** builds the installer and publishes it as a GitHub Release for that tag, with its SHA-256:

  ```powershell
  git tag v0.2.0
  git push origin v0.2.0
  ```

* **Actions → Build installer → Run workflow** builds from any branch without making a release; the installer is kept with that run as an artifact for 14 days. Use it to try the build before tagging.

Before tagging, set the new version in the five places that carry it, and commit: `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/package.json`, `engine/pyproject.toml` and `packaging/engine_version.txt`. The workflow warns when the tag and `tauri.conf.json` differ, and builds anyway.

A first build takes about an hour (Rust from scratch, the CUDA wheels, compressing 850 MB); later ones reuse cached dependencies. The runner has no NVIDIA card, so the smoke test prints "CUDA available: False"; the CUDA runtime is bundled regardless. Dependencies are not pinned to exact versions, so a build on GitHub can pick up newer packages than the ones on your computer.

## 4. Integrity

`ZHU-Setup.exe.sha256` holds the SHA-256 of the installer. Verify it with `Get-FileHash dist\ZHU-Setup.exe -Algorithm SHA256`. Model downloads are verified by size against the Hugging Face file listing, and a model is marked installed only after every required file is present.

## 5. Code-signing plan

1. Obtain an OV or EV code-signing certificate. An EV certificate gives immediate SmartScreen reputation. For CI, Azure Trusted Signing is an option.
2. Sign `zhu-engine.exe`, `ZHU.exe`, and the installer with SHA-256 digests and RFC 3161 timestamps (`build.ps1 -Sign` signs the installer; add the inner binaries through Tauri's `bundle.windows.certificateThumbprint` / `signCommand`).
3. Publish the SHA-256 alongside each release.

Until then, builds are **unsigned**, and SmartScreen will show "Windows protected your PC" (More info → Run anyway).
