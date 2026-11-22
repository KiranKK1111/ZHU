"""GPU discovery and telemetry through NVML (nvidia-ml-py) and CTranslate2.

All telemetry is best effort. A field is None when the driver does not report it
reliably, and no value is ever invented.
"""

from __future__ import annotations

import glob
import logging
import os
import site
import sys
import threading
from dataclasses import asdict, dataclass
from typing import Optional

log = logging.getLogger(__name__)
_dll_lock = threading.Lock()
_dll_done = False


def register_cuda_dlls() -> list[str]:
    """Add pip-installed CUDA runtime DLL directories (nvidia-cublas-cu12, nvidia-cudnn-cu12)
    to the DLL search path. In a frozen build they sit next to the executable."""
    global _dll_done
    with _dll_lock:
        if _dll_done:
            return []
        roots = list(site.getsitepackages()) if hasattr(site, "getsitepackages") else []
        if getattr(sys, "frozen", False):
            roots.insert(0, getattr(sys, "_MEIPASS", os.path.dirname(sys.executable)))
        added = []
        for root in roots:
            for d in glob.glob(os.path.join(root, "nvidia", "*", "bin")):
                if hasattr(os, "add_dll_directory"):
                    os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
                added.append(d)
        _dll_done = True
        return added


@dataclass
class GpuInfo:
    cuda_available: bool
    device_name: Optional[str] = None
    driver_version: Optional[str] = None
    vram_total_mb: Optional[int] = None
    vram_free_mb: Optional[int] = None
    vram_used_mb: Optional[int] = None
    engine_vram_mb: Optional[int] = None
    utilization_pct: Optional[int] = None
    temperature_c: Optional[int] = None
    compute_types: Optional[list[str]] = None
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


class GpuMonitor:
    def __init__(self) -> None:
        self._nvml = None
        self._handle = None
        try:
            import pynvml  # provided by nvidia-ml-py

            pynvml.nvmlInit()
            if pynvml.nvmlDeviceGetCount() > 0:
                self._nvml = pynvml
                self._handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        except Exception as exc:  # no NVIDIA driver, or NVML unavailable
            log.info("NVML unavailable: %s", exc)

    def info(self) -> GpuInfo:
        register_cuda_dlls()
        cuda = False
        compute_types = None
        error = None
        try:
            import ctranslate2

            cuda = ctranslate2.get_cuda_device_count() > 0
            if cuda:
                compute_types = sorted(ctranslate2.get_supported_compute_types("cuda"))
        except Exception as exc:
            error = f"CTranslate2 CUDA check failed: {exc}"
        info = GpuInfo(cuda_available=cuda, compute_types=compute_types, error=error)
        if self._nvml is None:
            return info
        n = self._nvml
        h = self._handle
        try:
            name = n.nvmlDeviceGetName(h)
            info.device_name = name.decode() if isinstance(name, bytes) else name
            drv = n.nvmlSystemGetDriverVersion()
            info.driver_version = drv.decode() if isinstance(drv, bytes) else drv
            mem = n.nvmlDeviceGetMemoryInfo(h)
            info.vram_total_mb = int(mem.total // 2**20)
            info.vram_free_mb = int(mem.free // 2**20)
            info.vram_used_mb = int(mem.used // 2**20)
        except Exception as exc:
            info.error = f"NVML memory query failed: {exc}"
        try:
            info.utilization_pct = int(n.nvmlDeviceGetUtilizationRates(h).gpu)
        except Exception:
            pass
        try:
            info.temperature_c = int(n.nvmlDeviceGetTemperature(h, n.NVML_TEMPERATURE_GPU))
        except Exception:
            pass
        try:
            pid = os.getpid()
            for proc in n.nvmlDeviceGetComputeRunningProcesses(h) or []:
                if proc.pid == pid and proc.usedGpuMemory:
                    info.engine_vram_mb = int(proc.usedGpuMemory // 2**20)
        except Exception:
            pass  # per-process accounting is not available under WDDM on many drivers
        return info
