"""Host memory status (GlobalMemoryStatusEx).

Measured on the target laptop: CTranslate2 needs free *commit charge* (RAM plus page
file), not only free VRAM, while it loads a model. With about 1.5 GB of commit free,
large-v3-turbo failed to load with "mkl_malloc: failed to allocate memory", or with a
misleading "CUDA failed with error out of memory". The preflight check turns that
into an actionable message.
"""

from __future__ import annotations

import ctypes
import sys
from dataclasses import asdict, dataclass
from typing import Optional

# Approximate host commit needed while loading (weights are read, then converted).
# These are planning values; see docs/BENCHMARKS.md for the measured failures.
# Parakeet: the minimum, i.e. CPU (INT8) inference (measured peak process commit 1.5 GB).
LOAD_COMMIT_MB = {"large-v3-turbo": 3000, "large-v3": 5500, "distil-large-v3": 2900, "medium": 2800, "small": 1100, "base": 500,
                  "parakeet-tdt-0.6b-v2": 1500, "parakeet-tdt-0.6b-v3": 1500}
# Parakeet on the GPU (DirectML, FP32): measured peak process commit 3.55 GB (benchmark).
# Under memory pressure DirectML session creation failed with E_OUTOFMEMORY, and once with an
# access violation while about 3.4 GB was free, so a margin is kept. Below this, model
# selection runs Parakeet on the CPU instead.
GPU_LOAD_COMMIT_MB = {"parakeet-tdt-0.6b-v2": 4000, "parakeet-tdt-0.6b-v3": 4000}


@dataclass(frozen=True)
class HostMemory:
    total_mb: int
    available_mb: int
    commit_limit_mb: int
    commit_available_mb: int

    def to_dict(self) -> dict:
        return asdict(self)


def host_memory() -> Optional[HostMemory]:
    if sys.platform != "win32":
        return None

    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

    ms = MEMORYSTATUSEX()
    ms.dwLength = ctypes.sizeof(ms)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms)):
        return None
    mb = 2**20
    return HostMemory(ms.ullTotalPhys // mb, ms.ullAvailPhys // mb, ms.ullTotalPageFile // mb, ms.ullAvailPageFile // mb)


def load_memory_problem(model: str) -> Optional[str]:
    """Human-readable warning if loading ``model`` is likely to fail for lack of host memory."""
    mem = host_memory()
    need = LOAD_COMMIT_MB.get(model)
    if mem is None or need is None or mem.commit_available_mb >= need:
        return None
    return (f"Only {mem.commit_available_mb} MB of memory (RAM + page file) is free; loading {model} needs about {need} MB. "
            "Close memory-heavy applications, or let Windows manage the page file size (System → About → Advanced system settings → Performance → Virtual memory).")
