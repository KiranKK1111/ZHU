"""Prepare the frozen engine for the installer: the NVIDIA libraries compressed once, the rest as it is.

    engine\\.venv\\Scripts\\python packaging\\pack_cuda.py

    build\\zhu-engine          the frozen engine as PyInstaller made it (what runs in the smoke test)
    build\\cuda-pack           each NVIDIA library compressed, named by the SHA-256 of its content
    build\\stage\\zhu-engine    what the installer takes: every file of the frozen engine, with each
                              NVIDIA library replaced by its compressed form (<name>.dll.xz)

Why: the six NVIDIA libraries are 1.5 GB of the engine's 1.8 GB and identical from build to build.
Compressing them inside the installer took about eleven minutes on every build. Here each is
compressed once, on all processor cores at the same time, and found again in build\\cuda-pack the
next time (on GitHub that folder is cached). The installer then only has to store them.
On the user's computer they are unpacked right after installation; see
engine/zhu_engine/system/cuda_pack.py.

The stage folder is made of hard links where the disk allows it, so it costs no time or space.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))

from zhu_engine.system.cuda_pack import PACKED_SUFFIX, libraries, pack_file  # noqa: E402


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def link(source: Path, target: Path) -> None:
    """Make ``target`` the same file as ``source``: a hard link, or a copy where links are not possible."""
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)


def verify(engine: Path, stage: Path, digests: dict[Path, str]) -> None:
    """Run the installer's unpack step for real: the staged ``zhu-engine.exe --unpack-cuda`` on a
    copy of the staged folder that holds the smallest packed library, and compare the result
    with the original. (The other libraries take the same path; their content is protected by
    the checksum inside each packed file.)"""
    work = stage.parent.parent / "verify" / "zhu-engine"
    if work.parent.exists():
        shutil.rmtree(work.parent)
    smallest = min(digests, key=lambda p: p.stat().st_size)
    sample = smallest.relative_to(engine)
    for path in stage.rglob("*"):
        if path.is_file():
            relative = path.relative_to(stage)
            if not relative.name.endswith(".dll" + PACKED_SUFFIX) or relative.with_name(relative.name[: -len(PACKED_SUFFIX)]) == sample:
                link(path, work / relative)
    started = time.monotonic()
    result = subprocess.run([str(work / "zhu-engine.exe"), "--unpack-cuda"], timeout=600)
    unpacked = work / sample
    if result.returncode != 0 or not unpacked.exists():
        raise SystemExit(f"the staged engine did not unpack {sample.name} (exit code {result.returncode})")
    if sha256(unpacked) != digests[smallest]:
        raise SystemExit(f"{sample.name} came back different from the original")
    if (work / sample.parent / (sample.name + PACKED_SUFFIX)).exists():
        raise SystemExit(f"{sample.name}{PACKED_SUFFIX} was left behind after unpacking")
    print(f"unpack check: zhu-engine.exe --unpack-cuda restored {sample.name} exactly ({time.monotonic() - started:.0f} s)")
    shutil.rmtree(work.parent)


def _pack(job: tuple[str, str]) -> tuple[str, float]:
    source, target = Path(job[0]), Path(job[1])
    started = time.monotonic()
    pack_file(source, target)
    return source.name, time.monotonic() - started


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--engine", type=Path, default=ROOT / "build" / "zhu-engine")
    parser.add_argument("--cache", type=Path, default=ROOT / "build" / "cuda-pack")
    parser.add_argument("--stage", type=Path, default=ROOT / "build" / "stage" / "zhu-engine")
    parser.add_argument("--no-verify", action="store_true", help="skip running the staged engine's unpack step")
    args = parser.parse_args()

    internal = args.engine / "_internal"
    big = libraries(internal)
    if not big:
        print(f"no NVIDIA libraries under {internal}: nothing to pack", file=sys.stderr)
        return 1
    args.cache.mkdir(parents=True, exist_ok=True)

    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=len(big)) as pool:
        digests = dict(zip(big, pool.map(sha256, big)))
    compressed = {path: args.cache / (digest + PACKED_SUFFIX) for path, digest in digests.items()}
    missing = [(str(path), str(target)) for path, target in compressed.items() if not target.exists()]
    print(f"{len(big)} NVIDIA libraries, {sum(p.stat().st_size for p in big) / 2**20:.0f} MB; "
          f"{len(big) - len(missing)} already compressed, {len(missing)} to compress")
    if missing:
        with ProcessPoolExecutor(max_workers=min(len(missing), os.cpu_count() or 2)) as pool:
            for name, seconds in pool.map(_pack, missing):
                print(f"  compressed {name} in {seconds:.0f} s")

    # Compressed libraries of earlier NVIDIA versions are no longer needed.
    wanted = {target.name for target in compressed.values()}
    for old in args.cache.iterdir():
        if old.name not in wanted:
            old.unlink()

    if args.stage.exists():
        shutil.rmtree(args.stage)
    packed_names = set(big)
    for path in args.engine.rglob("*"):
        if path.is_dir():
            continue
        relative = path.relative_to(args.engine)
        if path in packed_names:
            link(compressed[path], args.stage / relative.parent / (relative.name + PACKED_SUFFIX))
        else:
            link(path, args.stage / relative)

    packed_size = sum(target.stat().st_size for target in compressed.values())
    staged = sum(p.stat().st_size for p in args.stage.rglob("*") if p.is_file())
    print(f"NVIDIA libraries compressed: {packed_size / 2**20:.0f} MB; staged engine: {staged / 2**20:.0f} MB "
          f"({time.monotonic() - started:.0f} s)")
    if not args.no_verify:
        verify(args.engine, args.stage, digests)
    # For the workflow: a name for exactly this set of compressed files, to cache them under.
    key = hashlib.sha256("\n".join(sorted(wanted)).encode()).hexdigest()[:16]
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
            out.write(f"cuda-pack-key={key}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
