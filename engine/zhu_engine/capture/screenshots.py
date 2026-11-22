"""User-initiated screenshot capture: a monitor, all monitors, the active window, or a region.

* GDI BitBlt through ``mss``. Protected (DRM) content shows as black, and ZHU does
  not try to bypass it.
* Active-window bounds come from DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS),
  the documented API for the visible frame without the invisible resize borders.
* Region capture uses a "frozen" monitor image: the overlay window shows it, the
  user drags a rectangle, and the engine crops the frozen image. The result is
  exactly what the user saw.
* Images are saved locally (PNG by default, lossless for code and diagrams) and
  deduplicated by the SHA-256 of their pixels. Nothing is uploaded unless the user
  explicitly sends a screenshot to a provider.
"""

from __future__ import annotations

import ctypes
import hashlib
import io
import sys
import time
import uuid
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from PIL import Image

THUMB_MAX = 360
FROZEN_TTL_S = 120


@dataclass(frozen=True)
class MonitorInfo:
    index: int  # 1-based, mss numbering; 0 = all monitors (virtual screen)
    left: int
    top: int
    width: int
    height: int
    primary: bool

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def list_monitors() -> list[MonitorInfo]:
    import mss

    with mss.mss() as sct:
        mons = sct.monitors
        out = []
        for i, m in enumerate(mons):
            if i == 0:
                continue
            out.append(MonitorInfo(i, m["left"], m["top"], m["width"], m["height"], m["left"] == 0 and m["top"] == 0))
        return out


def _grab(region: dict) -> Image.Image:
    import mss

    with mss.mss() as sct:
        shot = sct.grab(region)
        return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


def grab_monitor(index: int) -> tuple[Image.Image, dict]:
    import mss

    with mss.mss() as sct:
        mons = sct.monitors
        if index < 0 or index >= len(mons):
            raise ValueError(f"monitor {index} does not exist (found {len(mons) - 1})")
        region = dict(mons[index])
    return _grab(region), region


def active_window_rect() -> Optional[dict]:
    if sys.platform != "win32":
        return None
    user32 = ctypes.WinDLL("user32")
    dwmapi = ctypes.WinDLL("dwmapi")
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    rect = wintypes.RECT()
    DWMWA_EXTENDED_FRAME_BOUNDS = 9
    if dwmapi.DwmGetWindowAttribute(wintypes.HWND(hwnd), DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(rect), ctypes.sizeof(rect)) != 0:
        if not user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect)):
            return None
    w, h = rect.right - rect.left, rect.bottom - rect.top
    if w <= 0 or h <= 0:
        return None
    return {"left": rect.left, "top": rect.top, "width": w, "height": h}


@dataclass
class SavedImage:
    id: str
    file_name: str
    thumb_name: str
    width: int
    height: int
    format: str
    bytes: int
    sha256: str


class ScreenshotStore:
    def __init__(self, images_dir: Path, thumbs_dir: Path, frozen_dir: Path) -> None:
        self.images_dir, self.thumbs_dir, self.frozen_dir = images_dir, thumbs_dir, frozen_dir
        self._frozen: dict[str, tuple[Path, dict, float]] = {}

    def pixel_hash(self, img: Image.Image) -> str:
        h = hashlib.sha256()
        h.update(f"{img.width}x{img.height}".encode())
        h.update(img.tobytes())
        return h.hexdigest()

    def save(self, img: Image.Image, fmt: str = "png", quality: int = 92) -> SavedImage:
        fmt = fmt.lower()
        if fmt not in ("png", "jpeg", "webp"):
            raise ValueError("image format must be png, jpeg or webp")
        sid = "s_" + uuid.uuid4().hex[:16]
        ts = time.strftime("%Y%m%d-%H%M%S")
        ext = "jpg" if fmt == "jpeg" else fmt
        name = f"zhu-{ts}-{sid[2:8]}.{ext}"
        path = self.images_dir / name
        params = {"optimize": True} if fmt == "png" else {"quality": quality}
        if fmt == "webp":
            params["method"] = 4
        img.save(path, format=fmt.upper(), **params)
        thumb = img.copy()
        thumb.thumbnail((THUMB_MAX, THUMB_MAX), Image.Resampling.LANCZOS)
        thumb_name = f"{sid}.webp"
        thumb.save(self.thumbs_dir / thumb_name, format="WEBP", quality=80, method=4)
        return SavedImage(sid, name, thumb_name, img.width, img.height, fmt, path.stat().st_size, self.pixel_hash(img))

    # ------------------------------------------------------------- region capture
    def freeze(self, monitor_index: int) -> tuple[str, dict]:
        self._expire()
        img, region = grab_monitor(monitor_index)
        fid = "f_" + uuid.uuid4().hex[:12]
        path = self.frozen_dir / f"{fid}.png"
        img.save(path, format="PNG", compress_level=1)  # fast; temporary file
        self._frozen[fid] = (path, region, time.time())
        return fid, {**region, "pixel_width": img.width, "pixel_height": img.height}

    def frozen_path(self, fid: str) -> Optional[Path]:
        entry = self._frozen.get(fid)
        return entry[0] if entry else None

    def crop_frozen(self, fid: str, x: int, y: int, w: int, h: int) -> Image.Image:
        entry = self._frozen.get(fid)
        if entry is None:
            raise KeyError("the frozen capture has expired; capture again")
        path = entry[0]
        with Image.open(path) as im:
            im.load()
            x0, y0 = max(0, x), max(0, y)
            x1, y1 = min(im.width, x + w), min(im.height, y + h)
            if x1 - x0 < 4 or y1 - y0 < 4:
                raise ValueError("selected region is too small")
            return im.crop((x0, y0, x1, y1)).convert("RGB")

    def discard_frozen(self, fid: str) -> None:
        entry = self._frozen.pop(fid, None)
        if entry:
            entry[0].unlink(missing_ok=True)

    def _expire(self) -> None:
        now = time.time()
        for fid, (_, _, t) in list(self._frozen.items()):
            if now - t > FROZEN_TTL_S:
                self.discard_frozen(fid)
        for p in self.frozen_dir.glob("*.png"):  # leftovers from a previous run
            if p.stem not in self._frozen and now - p.stat().st_mtime > FROZEN_TTL_S:
                p.unlink(missing_ok=True)


def encode_for_provider(path: Path, max_bytes: int = 5 * 1024 * 1024, max_side: int = 4096) -> tuple[str, bytes]:
    """Return (media_type, bytes) within provider limits. Keeps PNG when it fits, so code stays crisp."""
    with Image.open(path) as im:
        im.load()
        img = im.convert("RGB")
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    if buf.tell() <= max_bytes:
        return "image/png", buf.getvalue()
    for q in (92, 85, 75):
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=q)
        if buf.tell() <= max_bytes:
            return "image/jpeg", buf.getvalue()
    img.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return "image/jpeg", buf.getvalue()
