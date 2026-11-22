"""Copy an image to the Windows clipboard as CF_DIB (Win32 OpenClipboard / SetClipboardData)."""

from __future__ import annotations

import ctypes
import io
import sys
import time
from ctypes import wintypes
from pathlib import Path

from PIL import Image

CF_DIB = 8
GMEM_MOVEABLE = 0x0002


def copy_image(path: Path) -> None:
    if sys.platform != "win32":
        raise RuntimeError("image clipboard is only implemented on Windows")
    with Image.open(path) as im:
        img = im.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="BMP")
    dib = buf.getvalue()[14:]  # strip BITMAPFILEHEADER -> packed DIB

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]

    # Another process may hold the clipboard briefly; retry for up to about 1 s.
    for _ in range(20):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        raise RuntimeError("the clipboard is in use by another application")
    try:
        user32.EmptyClipboard()
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(dib))
        if not handle:
            raise MemoryError("GlobalAlloc failed")
        ptr = kernel32.GlobalLock(handle)
        ctypes.memmove(ptr, dib, len(dib))
        kernel32.GlobalUnlock(handle)
        if not user32.SetClipboardData(CF_DIB, handle):
            kernel32.GlobalFree(handle)
            raise RuntimeError(f"SetClipboardData failed ({ctypes.get_last_error()})")
        # On success the system owns the memory.
    finally:
        user32.CloseClipboard()
