"""Graphics cards and their drivers (system/gpu.py): a card without its driver is named and explained."""

from __future__ import annotations

import ctypes
import sys

import pytest

from zhu_engine.system import gpu
from zhu_engine.system.gpu import DisplayAdapter, gpu_warning

NVIDIA_OK = DisplayAdapter("NVIDIA GeForce RTX 4060", "NVIDIA", "ok")
INTEL_OK = DisplayAdapter("Intel(R) UHD Graphics", "Intel", "ok")


def test_no_warning_when_every_card_has_its_driver():
    assert gpu_warning([NVIDIA_OK, INTEL_OK], cuda_available=True) is None
    assert gpu_warning([INTEL_OK], cuda_available=False) is None  # no NVIDIA card: nothing to install
    assert gpu_warning([], cuda_available=False) is None  # unknown (not Windows, or the list failed)


def test_an_nvidia_card_without_its_driver_is_said_plainly():
    w = gpu_warning([INTEL_OK, DisplayAdapter("NVIDIA graphics card", "NVIDIA", "no_driver")], cuda_available=False)
    assert w is not None
    assert w.title == "NVIDIA graphics driver not installed"
    assert "driver is not installed" in w.message and "restart ZHU" in w.message and "processor" in w.message
    assert w.driver_url == "https://www.nvidia.com/drivers"


def test_an_nvidia_card_turned_off_or_failing():
    off = gpu_warning([DisplayAdapter("NVIDIA GeForce GTX 1650", "NVIDIA", "disabled")], cuda_available=False)
    assert off is not None and off.title == "NVIDIA graphics card turned off" and "Device Manager" in off.message
    broken = gpu_warning([DisplayAdapter("NVIDIA GeForce GTX 1650", "NVIDIA", "problem", 43)], cuda_available=False)
    assert broken is not None and "code 43" in broken.message


def test_a_driver_too_old_for_cuda():
    w = gpu_warning([NVIDIA_OK], cuda_available=False, driver_version="391.35")
    assert w is not None and w.title == "NVIDIA graphics driver needs an update" and "(391.35)" in w.message


def test_another_card_on_the_basic_display_driver():
    w = gpu_warning([DisplayAdapter("AMD graphics card", "AMD", "no_driver")], cuda_available=False)
    assert w is not None and w.title == "Graphics driver not installed"
    assert "AMD graphics card" in w.message and w.driver_url == "https://www.amd.com/support"
    unknown = gpu_warning([DisplayAdapter("graphics card", "", "no_driver")], cuda_available=False)
    assert unknown is not None and unknown.driver_url is None and "maker of the computer" in unknown.message


@pytest.mark.skipif(sys.platform != "win32", reason="Windows lists graphics cards in its registry")
def test_reading_the_cards_the_way_device_manager_does(monkeypatch):
    """A made-up machine: what Windows records for cards with and without drivers."""
    import winreg

    display = ["PCI\\VEN_XXXX&DEV_1&CC_030000", "PCI\\VEN_XXXX&DEV_1&CC_0300"]
    pci = {
        # NVIDIA card, driver never installed: no service, Device Manager code 28.
        "VEN_10DE&DEV_2D19&SUBSYS_1&REV_A1": {"i1": {"HardwareID": display, "DeviceDesc": "@machine.inf,%x%;Video Controller"}},
        # The same card's sound part (HDMI audio, class 04): not a graphics card.
        "VEN_10DE&DEV_22EB&SUBSYS_1&REV_A1": {"i2": {"HardwareID": ["PCI\\VEN_10DE&DEV_22EB&CC_040300"], "Service": "HDAudBus"}},
        # Intel graphics on Windows' stand-in driver.
        "VEN_8086&DEV_7D55&SUBSYS_1&REV_08": {"i3": {"HardwareID": display, "Service": "BasicDisplay", "DeviceDesc": "Microsoft Basic Display Adapter"}},
        # AMD card with its driver.
        "VEN_1002&DEV_73FF&SUBSYS_1&REV_C7": {"i4": {"HardwareID": display, "Service": "amdkmdag", "DeviceDesc": "@oem9.inf,%amd73ff%;AMD Radeon RX 6600"}},
        # A card that was taken out: Windows remembers it, but it is not present.
        "VEN_10DE&DEV_1C82&SUBSYS_1&REV_A1": {"gone": {"HardwareID": display, "Service": "nvlddmkm", "DeviceDesc": "NVIDIA GeForce GTX 1050 Ti"}},
    }
    problems = {"PCI\\VEN_10DE&DEV_2D19&SUBSYS_1&REV_A1\\i1": 28}
    absent = {"PCI\\VEN_10DE&DEV_1C82&SUBSYS_1&REV_A1\\gone"}

    class Key:
        def __init__(self, node):
            self.node = node

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def open_key(parent, sub):
        node = {r"SYSTEM\CurrentControlSet\Enum\PCI": pci} if parent == winreg.HKEY_LOCAL_MACHINE else parent.node
        if not isinstance(node.get(sub), dict):
            raise OSError(sub)
        return Key(node[sub])

    def enum_key(key, i):
        children = [k for k, v in key.node.items() if isinstance(v, dict)]
        if i >= len(children):
            raise OSError("no more")
        return children[i]

    def query_value(key, name):
        v = key.node.get(name)
        if v is None or isinstance(v, dict):
            raise OSError(name)
        return v, 1

    nodes: dict[int, str] = {}

    def locate(ref, instance_id, flags):
        if instance_id in absent:
            return 0x0D  # CR_NO_SUCH_DEVNODE
        ref._obj.value = len(nodes) + 1
        nodes[ref._obj.value] = instance_id
        return 0

    def status_of(status_ref, problem_ref, node, flags):
        code = problems.get(nodes[node], 0)
        status_ref._obj.value = 0x400 if code else 0x0A
        problem_ref._obj.value = code
        return 0

    class CfgMgr:
        CM_Locate_DevNodeW = staticmethod(locate)
        CM_Get_DevNode_Status = staticmethod(status_of)

    monkeypatch.setattr(winreg, "OpenKey", open_key)
    monkeypatch.setattr(winreg, "EnumKey", enum_key)
    monkeypatch.setattr(winreg, "QueryValueEx", query_value)
    monkeypatch.setattr(ctypes, "WinDLL", lambda name: CfgMgr())

    found = gpu.display_adapters()
    assert found == [
        DisplayAdapter("NVIDIA graphics card", "NVIDIA", "no_driver"),
        DisplayAdapter("Intel graphics card", "Intel", "no_driver"),
        DisplayAdapter("AMD Radeon RX 6600", "AMD", "ok"),
    ]
    w = gpu_warning(found, cuda_available=False)
    assert w is not None and w.title == "NVIDIA graphics driver not installed"  # the one that matters for speech


@pytest.mark.skipif(sys.platform != "win32", reason="Windows lists graphics cards in its registry")
def test_this_computers_cards_can_be_listed():
    for a in gpu.display_adapters():
        assert a.name and a.state in ("ok", "no_driver", "disabled", "problem")


def test_the_info_carries_the_cards_and_the_warning(monkeypatch):
    monkeypatch.setattr(gpu, "display_adapters", lambda: [DisplayAdapter("NVIDIA graphics card", "NVIDIA", "no_driver")])
    info = gpu.GpuMonitor().info().to_dict()
    assert info["adapters"] == [{"name": "NVIDIA graphics card", "vendor": "NVIDIA", "state": "no_driver", "problem_code": 0}]
    if not info["cuda_available"]:  # on a machine with a working NVIDIA card CUDA is there regardless
        assert info["warning"]["title"] == "NVIDIA graphics driver not installed"
