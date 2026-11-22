"""The CUDA runtime as it travels inside the installer.

Six NVIDIA libraries (cuBLAS, cuDNN) are 1.5 GB of the frozen engine's 1.8 GB, and they are the
same files in every build. Letting the installer compress them each time made that one step most
of a build. So the build compresses each of them once (the result is kept and reused, see
packaging/pack_cuda.py) and the installer carries ``<name>.dll.xz`` in the place where
``<name>.dll`` belongs.

They are unpacked on the user's computer, in place:

  * by the installer, right after it has copied the files (``zhu-engine.exe --unpack-cuda``,
    called from the installer hook in apps/desktop/src-tauri/windows/hooks.nsh), and
  * by the engine when it starts and still finds packed files, should that step not have run.

Unpacking a file writes ``<name>.dll.<pid>.partial``, renames it to ``<name>.dll`` and only then
removes the packed file, so stopping half way leaves nothing half written under the real name.
The xz format carries a checksum: a damaged file fails to unpack instead of giving a bad library.
"""

from __future__ import annotations

import lzma
import os
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

PACKED_SUFFIX = ".xz"
_CHUNK = 8 * 1024 * 1024


def runtime_root() -> Optional[Path]:
    """The folder of the frozen engine's libraries; None when the engine runs from source."""
    if not getattr(sys, "frozen", False):
        return None
    return Path(getattr(sys, "_MEIPASS", os.path.dirname(sys.executable)))


def libraries(root: Path) -> list[Path]:
    """The NVIDIA libraries under a frozen engine's library folder (what gets packed)."""
    return sorted(root.glob("nvidia/*/bin/*.dll"))


def packed(root: Path) -> list[Path]:
    """The packed libraries that are still waiting to be unpacked."""
    return sorted(root.glob("nvidia/*/bin/*.dll" + PACKED_SUFFIX))


def pack_file(source: Path, target: Path, preset: int = 6) -> None:
    """Compress one library into ``target`` (written under a temporary name first)."""
    temporary = target.with_name(f"{target.name}.{os.getpid()}.partial")
    compressor = lzma.LZMACompressor(format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64, preset=preset)
    with open(source, "rb") as src, open(temporary, "wb") as out:
        while chunk := src.read(_CHUNK):
            out.write(compressor.compress(chunk))
        out.write(compressor.flush())
    os.replace(temporary, target)


def unpack_file(source: Path) -> Path:
    """Unpack ``<name>.dll.xz`` to ``<name>.dll`` next to it and remove the packed file."""
    target = source.with_name(source.name[: -len(PACKED_SUFFIX)])
    temporary = target.with_name(f"{target.name}.{os.getpid()}.partial")
    try:
        with lzma.open(source, "rb") as src, open(temporary, "wb") as out:
            shutil.copyfileobj(src, out, _CHUNK)
        os.replace(temporary, target)
    except BaseException:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise
    source.unlink()
    return target


def unpack(root: Optional[Path] = None) -> tuple[int, list[str]]:
    """Unpack every packed library under ``root`` (default: this frozen engine's own folder).

    Returns how many were unpacked, and one message per file that could not be (a read-only
    folder, a full disk, a damaged file). A failure leaves the packed file where it is, so the
    next start tries again; meanwhile the engine works without the GPU libraries, on the CPU.
    """
    root = root or runtime_root()
    if root is None:
        return 0, []
    waiting = packed(root)
    if not waiting:
        return 0, []
    done, errors = 0, []

    def one(path: Path) -> Optional[str]:
        try:
            unpack_file(path)
            return None
        except Exception as exc:  # noqa: BLE001 - reported to the caller, file by file
            return f"{path.name}: {exc}"

    # Decompression releases the interpreter lock, so the files unpack side by side.
    with ThreadPoolExecutor(max_workers=min(4, len(waiting))) as pool:
        for error in pool.map(one, waiting):
            if error is None:
                done += 1
            else:
                errors.append(error)
    return done, errors
