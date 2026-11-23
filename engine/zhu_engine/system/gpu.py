"""GPU discovery and telemetry through NVML (nvidia-ml-py) and CTranslate2.

All telemetry is best effort. A field is None when the driver does not report it
reliably, and no value is ever invented.

NVML and CUDA only see a card whose NVIDIA driver is installed. To tell "no NVIDIA card" from
"an NVIDIA card without its driver", the graphics cards are also listed the way Device Manager
lists them (``display_adapters``): Windows records every card it finds, with or without a driver.
"""

from __future__ import annotations

import glob
import logging
import os
import re
import site
import sys
import threading
from dataclasses import asdict, dataclass, field
from typing import Literal, Optional

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


AdapterState = Literal["ok", "no_driver", "disabled", "problem"]


@dataclass(frozen=True)
class DisplayAdapter:
    """A graphics card as Windows sees it."""

    name: str
    vendor: str  # "NVIDIA", "AMD", "Intel", or "" when unknown
    state: AdapterState  # ok: its maker's driver is installed and working
    problem_code: int = 0  # Device Manager's problem code, when state is "problem"


@dataclass(frozen=True)
class GpuWarning:
    title: str
    message: str
    driver_url: Optional[str] = None


_VENDORS = {"10DE": "NVIDIA", "1002": "AMD", "1022": "AMD", "8086": "Intel"}
DRIVER_URLS = {
    "NVIDIA": "https://www.nvidia.com/drivers",
    "AMD": "https://www.amd.com/support",
    "Intel": "https://www.intel.com/content/www/us/en/support/detect.html",
}
#: Windows' stand-in driver for a card whose own driver is missing ("Microsoft Basic Display Adapter").
_BASIC_DISPLAY = "basicdisplay"
_CM_PROB_DISABLED = 22
_CM_PROB_FAILED_INSTALL = 28
_DN_HAS_PROBLEM = 0x400
#: A display controller in a PCI hardware id: class 03 (VGA, XGA, 3D, other display).
_DISPLAY_CLASS = re.compile(r"&CC_03[0-9A-F]{2}", re.IGNORECASE)


def display_adapters() -> list[DisplayAdapter]:
    """The graphics cards in this computer, with or without a driver. Empty when unknown."""
    if sys.platform != "win32":
        return []
    try:
        return _windows_adapters()
    except Exception as exc:  # noqa: BLE001 - a diagnostic must never stop the engine
        log.info("could not list the graphics cards: %s", exc)
        return []


def _windows_adapters() -> list[DisplayAdapter]:
    import ctypes
    import winreg
    from ctypes import wintypes

    cfgmgr = ctypes.WinDLL("cfgmgr32")
    locate = cfgmgr.CM_Locate_DevNodeW
    locate.argtypes = [ctypes.POINTER(wintypes.DWORD), wintypes.LPCWSTR, wintypes.ULONG]
    locate.restype = wintypes.DWORD
    status_of = cfgmgr.CM_Get_DevNode_Status
    status_of.argtypes = [ctypes.POINTER(wintypes.ULONG), ctypes.POINTER(wintypes.ULONG), wintypes.DWORD, wintypes.ULONG]
    status_of.restype = wintypes.DWORD

    def subkeys(key) -> list[str]:
        names, i = [], 0
        while True:
            try:
                names.append(winreg.EnumKey(key, i))
            except OSError:
                return names
            i += 1

    def value(key, name: str):
        try:
            return winreg.QueryValueEx(key, name)[0]
        except OSError:
            return None

    found: list[DisplayAdapter] = []
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Enum\PCI") as pci:
        for device in subkeys(pci):
            vendor = _VENDORS.get(device[4:8].upper(), "") if device.upper().startswith("VEN_") else ""
            with winreg.OpenKey(pci, device) as device_key:
                for instance in subkeys(device_key):
                    with winreg.OpenKey(device_key, instance) as key:
                        ids = (value(key, "HardwareID") or []) + (value(key, "CompatibleIDs") or [])
                        if not any(_DISPLAY_CLASS.search(i) for i in ids):
                            continue
                        # Windows remembers cards that were taken out; only the ones present count.
                        node = wintypes.DWORD()
                        if locate(ctypes.byref(node), f"PCI\\{device}\\{instance}", 0) != 0:
                            continue
                        status, problem = wintypes.ULONG(), wintypes.ULONG()
                        if status_of(ctypes.byref(status), ctypes.byref(problem), node.value, 0) != 0:
                            continue
                        code = problem.value if status.value & _DN_HAS_PROBLEM else 0
                        service = str(value(key, "Service") or "").lower()
                        description = str(value(key, "FriendlyName") or value(key, "DeviceDesc") or "").rsplit(";", 1)[-1].strip()
                        if code == _CM_PROB_DISABLED:
                            state: AdapterState = "disabled"
                        elif not service or service == _BASIC_DISPLAY or code == _CM_PROB_FAILED_INSTALL:
                            state = "no_driver"
                        elif code:
                            state = "problem"
                        else:
                            state = "ok"
                        # Without its driver a card is called "Microsoft Basic Display Adapter" or
                        # "Video Controller"; its maker says more.
                        name = description if state != "no_driver" and description else (f"{vendor} graphics card" if vendor else "graphics card")
                        found.append(DisplayAdapter(name, vendor, state, code if state == "problem" else 0))
    return found


def gpu_warning(adapters: list[DisplayAdapter], cuda_available: bool, driver_version: Optional[str] = None) -> Optional[GpuWarning]:
    """What to tell the user when a graphics card cannot be used for want of its driver. None when all is well."""
    nvidia = [a for a in adapters if a.vendor == "NVIDIA"]
    slower = "Until then speech recognition runs on the processor, which is slower, and ZHU recommends a smaller speech model."
    for a in nvidia:
        if a.state == "no_driver":
            return GpuWarning(
                "NVIDIA graphics driver not installed",
                f"This computer has an NVIDIA graphics card, but its driver is not installed, so ZHU cannot use it. {slower} "
                "Install the driver from NVIDIA (or through Windows Update), then restart ZHU.",
                DRIVER_URLS["NVIDIA"],
            )
        if a.state == "disabled":
            return GpuWarning(
                "NVIDIA graphics card turned off",
                f"The NVIDIA graphics card ({a.name}) is turned off in Device Manager, so ZHU cannot use it. {slower} "
                "Turn it on in Device Manager (Display adapters), then restart ZHU.",
            )
        if a.state == "problem":
            return GpuWarning(
                "NVIDIA graphics card not working",
                f"Windows reports a problem with the NVIDIA graphics card ({a.name}; Device Manager code {a.problem_code}), so ZHU cannot use it. {slower} "
                "Reinstall its driver from NVIDIA, then restart ZHU.",
                DRIVER_URLS["NVIDIA"],
            )
    if any(a.state == "ok" for a in nvidia) and not cuda_available:
        version = f" ({driver_version})" if driver_version else ""
        return GpuWarning(
            "NVIDIA graphics driver needs an update",
            f"The NVIDIA driver{version} is installed but could not start CUDA, which ZHU uses for speech recognition; the driver is probably too old. {slower} "
            "Install the latest driver from NVIDIA, then restart ZHU.",
            DRIVER_URLS["NVIDIA"],
        )
    for a in adapters:
        if a.state == "no_driver" and a.vendor != "NVIDIA":
            source = a.vendor or "the maker of the computer"
            return GpuWarning(
                "Graphics driver not installed",
                f"The driver for this computer's {a.name} is not installed: Windows is using its basic display driver, so the screen and ZHU can be slow. "
                f"Install the driver from {source} or through Windows Update.",
                DRIVER_URLS.get(a.vendor),
            )
    return None


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
    #: The graphics cards Windows sees, with or without a driver.
    adapters: list[DisplayAdapter] = field(default_factory=list)
    #: Set when a card cannot be used for want of its driver (see gpu_warning).
    warning: Optional[GpuWarning] = None

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
        # Listed once: a driver installed later takes effect when ZHU (or its engine) restarts.
        self._adapters = display_adapters()
        listed = ", ".join(f"{a.name} [{a.state}]" for a in self._adapters) or "none found"
        log.info("graphics cards: %s", listed)

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
        info = GpuInfo(cuda_available=cuda, compute_types=compute_types, error=error, adapters=list(self._adapters))
        info.warning = gpu_warning(self._adapters, cuda)
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
        if info.warning is not None and info.driver_version:
            info.warning = gpu_warning(self._adapters, cuda, info.driver_version)
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
