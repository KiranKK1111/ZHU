# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the ZHU engine. One-folder build (no per-launch extraction of
# large files). The CUDA runtime DLLs from the nvidia-* wheels are placed under
# nvidia/<pkg>/bin, the layout that zhu_engine.system.gpu.register_cuda_dlls searches.
#
#   engine\.venv\Scripts\pyinstaller packaging\zhu-engine.spec --distpath build --workpath build\pyi --noconfirm

import glob
import os
import site
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules, copy_metadata

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
ENGINE = os.path.join(ROOT, "engine")

datas = []
binaries = []
hiddenimports = []

datas += collect_data_files("zhu_engine", includes=["questions/data/*.json"])
datas += collect_data_files("faster_whisper", includes=["assets/*"])
binaries += collect_dynamic_libs("ctranslate2")
binaries += collect_dynamic_libs("onnxruntime")
datas += copy_metadata("keyring") + copy_metadata("fastapi") + copy_metadata("anthropic") + copy_metadata("huggingface_hub")
hiddenimports += collect_submodules("uvicorn") + collect_submodules("keyring.backends") + collect_submodules("zhu_engine")
hiddenimports += ["pynvml", "pyaudiowpatch", "soxr", "websockets", "httptools"]

# CUDA 12 runtime (cuBLAS, cuDNN 9) from pip wheels.
# The full set is 2.0 GB, which exceeds NSIS's ~2 GB data limit (makensis failed with
# "error mmapping file ... out of range"). Measured on the RTX 5060: CTranslate2 Whisper
# transcribes identically in FP16 and INT8/FP16 with only the DLLs below, and a control run
# with none of them fails ("cublas64_12.dll is not found"). Excluded: cudnn_adv (RNN/attention,
# 219 MB), NVRTC and cudnn_engines_runtime_compiled (runtime kernel compilation, 221 MB).
# The precompiled engines and heuristics are kept for robustness on other GPU architectures.
CUDA_DLLS = {
    "cublas": ("cublas64_12.dll", "cublasLt64_12.dll"),
    "cudnn": ("cudnn64_9.dll", "cudnn_graph64_9.dll", "cudnn_ops64_9.dll", "cudnn_cnn64_9.dll",
              "cudnn_engines_precompiled64_9.dll", "cudnn_heuristic64_9.dll"),
}
for sp in site.getsitepackages():
    for pkg, names in CUDA_DLLS.items():
        for name in names:
            dll = os.path.join(sp, "nvidia", pkg, "bin", name)
            if os.path.exists(dll):
                binaries.append((dll, os.path.join("nvidia", pkg, "bin")))

a = Analysis(
    [os.path.join(SPECPATH, "engine_entry.py")],
    pathex=[ENGINE],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "torch", "tensorflow", "matplotlib", "IPython", "pytest", "PyInstaller"],
    # The Python modules as files in _internal, not packed inside zhu-engine.exe: the desktop app
    # loads this same runtime into its own process (apps/desktop/src-tauri/src/embedded.rs), and
    # only zhu-engine.exe itself could read modules that are inside it.
    noarchive=True,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="zhu-engine",
    console=False,  # no console window; logs go to %LOCALAPPDATA%\app.zhu.desktop\data\logs
    disable_windowed_traceback=False,
    icon=os.path.join(ROOT, "apps", "desktop", "src-tauri", "icons", "icon.ico"),
    version=os.path.join(SPECPATH, "engine_version.txt"),
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="zhu-engine")
