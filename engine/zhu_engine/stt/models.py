"""Speech model catalog, one-time download, and memory-aware selection with fallback.

Two back ends:
* ``whisper``: faster-whisper / CTranslate2 on CUDA (FP16, INT8/FP16) or the CPU (INT8).
* ``parakeet``: NVIDIA Parakeet TDT on ONNX Runtime, on the GPU through DirectML (FP32)
  or on the CPU (INT8). See stt/parakeet.py.

The VRAM figures below are *planning estimates* used before a model is loaded.
The values actually measured on the target hardware are in docs/BENCHMARKS.md
(see benchmarks/stt_benchmark.py). ZHU does not assume a model fits just because
its weights file is smaller than the free VRAM: the estimate includes a runtime
buffer allowance, and a reserve is kept for other applications.
"""

from __future__ import annotations

import logging
import os
import shutil
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Optional

from ..system.memory import GPU_LOAD_COMMIT_MB
from . import parakeet

log = logging.getLogger(__name__)

# Parakeet v3 languages (model card of nvidia/parakeet-tdt-0.6b-v3).
PARAKEET_V3_LANGUAGES = ("bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv", "lt", "mt",
                         "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk")


def _fmt_mb(mb: int) -> str:
    return f"{mb / 1024:.1f} GB" if mb >= 1024 else f"{mb} MB"


@dataclass(frozen=True)
class ModelSpec:
    name: str
    repo: str
    label: str
    multilingual: bool
    download_mb: int  # approximate size of everything downloaded
    # Whisper: planning estimates for FP16 and INT8/FP16 on CUDA, incl. decoding buffers (beam 5, 30 s window).
    # Parakeet: vram_fp16_mb is the FP32 DirectML estimate; vram_int8_mb is 0 because INT8 runs on the CPU.
    vram_fp16_mb: int
    vram_int8_mb: int
    notes: str
    backend: str = "whisper"  # whisper | parakeet
    languages: Optional[tuple[str, ...]] = None  # None = every Whisper language
    cpu_ram_mb: int = 0  # Parakeet: host memory needed for CPU (INT8) inference
    # Hugging Face commit to download. Pinned for third-party exports so users get exactly the
    # files that were tested and benchmarked; None = the repository's current main branch.
    revision: Optional[str] = None

    @property
    def memory_summary(self) -> str:
        if self.backend == "parakeet":
            return f"GPU (DirectML, FP32) ≈ {_fmt_mb(self.vram_fp16_mb)} VRAM · CPU (INT8) ≈ {_fmt_mb(self.cpu_ram_mb)} RAM"
        return f"Planning estimate {_fmt_mb(self.vram_fp16_mb)} VRAM (FP16), {_fmt_mb(self.vram_int8_mb)} (INT8)"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["languages"] = list(self.languages) if self.languages else None
        d["memory_summary"] = self.memory_summary
        return d


CATALOG: dict[str, ModelSpec] = {
    m.name: m
    for m in [
        ModelSpec("large-v3-turbo", "mobiuslabsgmbh/faster-whisper-large-v3-turbo", "Whisper large-v3 turbo", True, 1620, 2600, 1700,
                  "Recommended for RTX-class GPUs: near large-v3 accuracy with 4 decoder layers (much faster)."),
        ModelSpec("large-v3", "Systran/faster-whisper-large-v3", "Whisper large-v3", True, 3090, 4700, 3000,
                  "Highest accuracy; slower. Needs about 5 GB VRAM free in FP16."),
        ModelSpec("distil-large-v3", "Systran/faster-distil-whisper-large-v3", "Distil-Whisper large-v3 (English)", False, 1510, 2400, 1600,
                  "English only; fast; good for clear English speech.", languages=("en",)),
        ModelSpec("medium", "Systran/faster-whisper-medium", "Whisper medium", True, 1530, 2300, 1500, "Balanced fallback for low VRAM."),
        ModelSpec("small", "Systran/faster-whisper-small", "Whisper small", True, 480, 1000, 700, "CPU-friendly fallback."),
        ModelSpec("base", "Systran/faster-whisper-base", "Whisper base", True, 145, 500, 400, "Minimal; lowest accuracy."),
        # VRAM: measured peak 2.6 GB on clips up to 12 s; the estimate leaves room for 25 s segments.
        ModelSpec("parakeet-tdt-0.6b-v2", "istupakov/parakeet-tdt-0.6b-v2-onnx", "NVIDIA Parakeet TDT 0.6B v2 (English)", False, 3030, 2800, 0,
                  "NVIDIA's English model: very accurate, punctuation and capitalization built in. Uses the GPU through DirectML, "
                  "or runs fast on the CPU. Model by NVIDIA, CC-BY-4.0.",
                  backend="parakeet", languages=("en",), cpu_ram_mb=1500, revision="0bbb45a3365852604aef28b538a8f066f4ccaa85"),
        ModelSpec("parakeet-tdt-0.6b-v3", "istupakov/parakeet-tdt-0.6b-v3-onnx", "NVIDIA Parakeet TDT 0.6B v3 (25 European languages)", True, 3070, 2800, 0,
                  "Multilingual Parakeet: English plus 24 European languages, detected automatically. Same speed and memory as v2. "
                  "Model by NVIDIA, CC-BY-4.0.",
                  backend="parakeet", languages=PARAKEET_V3_LANGUAGES, cpu_ram_mb=1500, revision="8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce"),
    ]
}
# Whisper fallback ladder (largest first). Parakeet models are listed separately.
FALLBACK_ORDER = ["large-v3-turbo", "large-v3", "distil-large-v3", "medium", "small", "base"]
PARAKEET_MODELS = [n for n, m in CATALOG.items() if m.backend == "parakeet"]
MODEL_ORDER = FALLBACK_ORDER + PARAKEET_MODELS
_COMPLETE_MARKER = ".zhu-complete"
_WHISPER_FILES = ("model.bin", "config.json", "tokenizer.json")


def required_files(name: str) -> tuple[str, ...]:
    return parakeet.REQUIRED_FILES if CATALOG[name].backend == "parakeet" else _WHISPER_FILES


def model_dir(models_root: Path, name: str) -> Path:
    return models_root / name


def is_installed(models_root: Path, name: str) -> bool:
    d = model_dir(models_root, name)
    return (d / _COMPLETE_MARKER).exists() and all((d / f).exists() for f in required_files(name))


def installed_models(models_root: Path) -> list[str]:
    return [n for n in MODEL_ORDER if is_installed(models_root, n)]


def supports_language(name: str, language: Optional[str]) -> bool:
    """Whether a model can transcribe ``language`` (None = automatic detection)."""
    langs = CATALOG[name].languages
    if langs is None:
        return True
    if language is None:
        return len(langs) > 1  # an English-only model cannot detect languages
    return language in langs


def delete_model(models_root: Path, name: str) -> None:
    d = model_dir(models_root, name)
    if d.exists():
        shutil.rmtree(d)


@dataclass
class DownloadProgress:
    model: str
    state: str  # queued | downloading | verifying | completed | failed | cancelled
    downloaded_bytes: int = 0
    total_bytes: Optional[int] = None
    message: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


class ModelDownloader:
    """Downloads one model at a time from Hugging Face into %LOCALAPPDATA%\\app.zhu.desktop\\data\\models\\<name>.

    The download is resumable (huggingface_hub keeps .incomplete files), and the model
    is marked complete only after every required file exists. Once installed it is
    never downloaded again.
    """

    def __init__(self, models_root: Path, on_progress: Callable[[DownloadProgress], None]) -> None:
        self.root = models_root
        self._on_progress = on_progress
        self._lock = threading.Lock()
        self._active: Optional[str] = None
        self._cancel = threading.Event()
        self.last: dict[str, DownloadProgress] = {}

    @property
    def active(self) -> Optional[str]:
        return self._active

    def start(self, name: str) -> DownloadProgress:
        if name not in CATALOG:
            raise ValueError(f"unknown model {name!r}")
        with self._lock:
            if is_installed(self.root, name):
                p = DownloadProgress(name, "completed", message="already installed")
                self._emit(p)
                return p
            if self._active:
                raise RuntimeError(f"model {self._active} is already downloading")
            self._active = name
            self._cancel.clear()
        p = DownloadProgress(name, "queued")
        self._emit(p)
        threading.Thread(target=self._run, args=(name,), name=f"download-{name}", daemon=True).start()
        return p

    def cancel(self) -> None:
        self._cancel.set()

    def _emit(self, p: DownloadProgress) -> None:
        self.last[p.model] = p
        self._on_progress(p)

    def _run(self, name: str) -> None:
        spec = CATALOG[name]
        target = model_dir(self.root, name)
        target.mkdir(parents=True, exist_ok=True)
        try:
            from huggingface_hub import HfApi, hf_hub_download

            os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
            info = HfApi().model_info(spec.repo, revision=spec.revision, files_metadata=True)
            files = [s for s in info.siblings if not s.rfilename.startswith(".") and not s.rfilename.endswith(".md")]
            total = sum(s.size or 0 for s in files) or None
            done = 0
            self._emit(DownloadProgress(name, "downloading", 0, total))
            for s in files:
                if self._cancel.is_set():
                    self._emit(DownloadProgress(name, "cancelled", done, total))
                    return
                dest = target / s.rfilename
                if dest.exists() and s.size and dest.stat().st_size == s.size:
                    done += s.size
                    continue
                watcher = _SizeWatcher(target, lambda b: self._emit(DownloadProgress(name, "downloading", done + b, total)))
                watcher.start()
                try:
                    hf_hub_download(spec.repo, s.rfilename, local_dir=str(target), revision=spec.revision)
                finally:
                    watcher.stop()
                done += s.size or (dest.stat().st_size if dest.exists() else 0)
                self._emit(DownloadProgress(name, "downloading", done, total))
            self._emit(DownloadProgress(name, "verifying", done, total))
            missing = [f for f in required_files(name) if not (target / f).exists()]
            if missing:
                raise RuntimeError(f"download incomplete, missing {missing}")
            (target / _COMPLETE_MARKER).write_text(spec.repo + (f"@{spec.revision}" if spec.revision else ""), encoding="utf-8")
            self._emit(DownloadProgress(name, "completed", done, total))
        except Exception as exc:
            log.exception("model download failed")
            self._emit(DownloadProgress(name, "failed", message=f"Download failed: {exc}. Check your internet connection and retry."))
        finally:
            with self._lock:
                self._active = None


class _SizeWatcher(threading.Thread):
    """Reports bytes of the in-progress download by watching .incomplete files."""

    def __init__(self, root: Path, report: Callable[[int], None]) -> None:
        super().__init__(daemon=True)
        self.root, self.report = root, report
        self._stop_evt = threading.Event()

    def run(self) -> None:
        while not self._stop_evt.wait(0.5):
            size = 0
            for p in self.root.rglob("*.incomplete"):
                try:
                    size += p.stat().st_size
                except OSError:
                    pass
            self.report(size)

    def stop(self) -> None:
        self._stop_evt.set()


@dataclass(frozen=True)
class Selection:
    model: str
    device: str  # cuda | directml | cpu
    compute_type: str  # Whisper: float16 | int8_float16 | int8. Parakeet: float32 | int8
    reason: str


def select_model(
    preferred: str,
    installed: list[str],
    cuda_available: bool,
    vram_free_mb: Optional[int],
    budget_mb: int,
    reserve_mb: int = 768,
    device_pref: str = "auto",  # auto | cuda (= GPU) | cpu
    compute_pref: str = "auto",  # auto | float16 | int8_float16 | int8
    cuda_compute_types: Optional[list[str]] = None,
    language: Optional[str] = "en",
    directml: bool = True,
    commit_free_mb: Optional[int] = None,
) -> Optional[Selection]:
    """Pick the best installed model that fits the VRAM budget. Falls back down the ladder, then to CPU.

    The preferred model is always tried first. Fallback models must support ``language``.
    Parakeet runs on the GPU through DirectML only when an NVIDIA GPU with enough free VRAM is
    present and at least GPU_LOAD_COMMIT_MB of host commit is free (a DirectML load peaks at about
    3.5 GB); otherwise a preferred Parakeet model runs on the CPU with INT8 weights.
    """
    if not installed:
        return None
    ordered = [preferred] + [m for m in MODEL_ORDER if m != preferred]
    candidates = [m for m in ordered if m in installed and (m == preferred or supports_language(m, language))]
    use_gpu = cuda_available and device_pref != "cpu"
    reason = "CUDA unavailable" if not cuda_available else ("CPU requested" if device_pref == "cpu" else "insufficient VRAM for any installed model")
    if use_gpu:
        available = budget_mb if vram_free_mb is None else min(budget_mb, max(0, vram_free_mb - reserve_mb))
        types = cuda_compute_types or ["float16", "int8_float16"]
        compute_order = [compute_pref] if compute_pref not in ("auto", "int8") else ["float16", "int8_float16"]
        for m in candidates:
            spec = CATALOG[m]
            if spec.backend == "parakeet":
                need_commit = GPU_LOAD_COMMIT_MB.get(m, 0)
                if compute_pref == "int8":
                    blocker = "INT8 requested (runs on the CPU)"
                elif not directml:
                    blocker = "DirectML unavailable"
                elif spec.vram_fp16_mb > available:
                    blocker = f"needs {spec.vram_fp16_mb} MB VRAM, {available} MB available"
                elif commit_free_mb is not None and commit_free_mb < need_commit:
                    blocker = f"needs about {need_commit} MB of free memory to load on the GPU, {commit_free_mb} MB free"
                else:
                    why = "preferred model" if m == preferred else f"fallback: {preferred} needs more than {available} MB available"
                    return Selection(m, "directml", "float32", why)
                if m == preferred and device_pref != "cuda":
                    return Selection(m, "cpu", "int8", f"CPU (INT8): {blocker}")
                continue
            for ct in compute_order:
                if ct not in types:
                    continue
                need = spec.vram_fp16_mb if ct == "float16" else spec.vram_int8_mb
                if need <= available:
                    why = "preferred model" if m == preferred else f"fallback: {preferred} needs more than {available} MB available"
                    return Selection(m, "cuda", ct, why)
        if device_pref == "cuda":
            return None
    pref_spec = CATALOG.get(preferred)
    if pref_spec is not None and pref_spec.backend == "parakeet" and preferred in installed:
        return Selection(preferred, "cpu", "int8", reason)
    # On the CPU, Parakeet INT8 is about 10x faster than Whisper small and far more robust in heavy
    # noise (4.5% vs 12% WER at 0 dB); clean-speech WER is similar (docs/BENCHMARKS.md).
    cpu_pref = PARAKEET_MODELS + ["small", "base", "medium", "distil-large-v3", "large-v3-turbo"]
    cpu_order = [m for m in cpu_pref if m in candidates]
    if preferred in installed and preferred in ("small", "base"):
        cpu_order.insert(0, preferred)
    m = cpu_order[0] if cpu_order else candidates[0]
    return Selection(m, "cpu", "int8", reason)
