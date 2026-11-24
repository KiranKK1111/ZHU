"""Text recognition (OCR) with the recognizer built into Windows (Windows.Media.Ocr).

Used for resumes that are pictures: a scanned PDF, or a photo or screenshot of the page. Windows
recognizes text in the languages installed for the user (Settings → Time & language), on the
computer itself: nothing leaves it.

The Windows calls are asynchronous (WinRT). They run on a thread of their own with an event loop of
their own, so this works from any caller, including one inside a running event loop.
"""

from __future__ import annotations

import asyncio
import io
import sys
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from PIL import Image

# Windows recognizes text best when lines are 20-40 px high. A page scanned at 150 dpi or more is
# fine as it is; smaller pictures are enlarged to about this long side first.
_MIN_LONG_SIDE = 2200
_MAX_UPSCALE = 3.0
_TIMEOUT_S = 120


class OcrUnavailable(RuntimeError):
    """Text recognition cannot run here; the message is shown to the user."""


def _engine():
    if sys.platform != "win32":
        raise OcrUnavailable("Reading text from a picture needs Windows.")
    try:
        from winrt.windows.globalization import Language
        from winrt.windows.media.ocr import OcrEngine
    except ImportError as exc:  # pragma: no cover - a build without the Windows bindings
        raise OcrUnavailable("Text recognition is not part of this build of ZHU.") from exc
    engine = OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        english = Language("en-US")
        engine = OcrEngine.try_create_from_language(english) if OcrEngine.is_language_supported(english) else None
    if engine is None:
        raise OcrUnavailable(
            "Windows has no text recognition for your languages. Add a language under Settings → Time & language → "
            "Language & region (with its optional features), or upload a PDF with selectable text, a Word or a text file."
        )
    return engine


def _prepare(img: "Image.Image", limit: int) -> bytes:
    """The picture as PNG bytes, upright, in RGB, and of a size Windows reads well."""
    from PIL import Image, ImageOps

    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "L"):
        background = Image.new("RGB", img.size, "white")  # transparent parts become paper, not black
        rgba = img.convert("RGBA")
        background.paste(rgba, mask=rgba.getchannel("A"))
        img = background
    long_side = max(img.size)
    scale = 1.0
    if long_side < _MIN_LONG_SIDE:
        scale = min(_MAX_UPSCALE, _MIN_LONG_SIDE / long_side)
    if long_side * scale > limit:
        scale = limit / long_side
    if abs(scale - 1.0) > 0.01:
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


async def _recognize(pictures: list["Image.Image"]) -> list[str]:
    from winrt.windows.graphics.imaging import BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, SoftwareBitmap
    from winrt.windows.media.ocr import OcrEngine
    from winrt.windows.storage.streams import DataWriter, InMemoryRandomAccessStream

    engine = _engine()
    limit = int(OcrEngine.max_image_dimension or 10_000)
    texts: list[str] = []
    for picture in pictures:
        stream = InMemoryRandomAccessStream()
        writer = DataWriter(stream)
        writer.write_bytes(_prepare(picture, limit))
        await writer.store_async()
        writer.detach_stream()
        stream.seek(0)
        decoder = await BitmapDecoder.create_async(stream)
        bitmap = await decoder.get_software_bitmap_async()
        bitmap = SoftwareBitmap.convert(bitmap, BitmapPixelFormat.BGRA8, BitmapAlphaMode.PREMULTIPLIED)
        result = await engine.recognize_async(bitmap)
        texts.append("\n".join(line.text for line in result.lines))
    return texts


def recognize(pictures: list["Image.Image"]) -> list[str]:
    """The text Windows recognizes in each picture, line by line (one string per picture)."""
    if not pictures:
        return []
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="zhu-ocr")
    try:
        return pool.submit(lambda: asyncio.run(_recognize(pictures))).result(timeout=_TIMEOUT_S)
    except OcrUnavailable:
        raise
    except TimeoutError as exc:
        raise OcrUnavailable("Reading the text took too long. Upload a PDF with selectable text, a Word or a text file.") from exc
    except OSError as exc:  # WinRT reports its errors as OSError (HRESULT)
        raise OcrUnavailable(f"Windows could not read the picture ({exc.strerror or exc}).") from exc
    finally:
        pool.shutdown(wait=False)  # a recognizer that hangs must not hold the caller past the timeout
