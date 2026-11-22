"""Exit when the parent desktop process exits, so no orphaned engine keeps the microphone open."""

from __future__ import annotations

import ctypes
import logging
import os
import sys
import threading
from typing import Callable

log = logging.getLogger(__name__)

SYNCHRONIZE = 0x00100000
INFINITE = 0xFFFFFFFF


def watch_parent(parent_pid: int, on_exit: Callable[[], None]) -> None:
    if sys.platform != "win32" or parent_pid <= 0:
        return
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = ctypes.c_void_p
    handle = kernel32.OpenProcess(SYNCHRONIZE, False, parent_pid)
    if not handle:
        log.warning("cannot watch parent pid %s (error %s)", parent_pid, ctypes.get_last_error())
        return

    def wait() -> None:
        kernel32.WaitForSingleObject(ctypes.c_void_p(handle), INFINITE)
        log.info("parent process %s exited; shutting down engine", parent_pid)
        try:
            on_exit()
        finally:
            threading.Timer(5.0, lambda: os._exit(0)).start()

    threading.Thread(target=wait, name="parent-watchdog", daemon=True).start()
