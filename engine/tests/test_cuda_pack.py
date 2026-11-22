"""The NVIDIA libraries travel compressed and are unpacked in place (system/cuda_pack.py)."""

from __future__ import annotations

import os
from pathlib import Path

from zhu_engine.system import cuda_pack


def _engine(tmp_path: Path) -> tuple[Path, dict[str, bytes]]:
    """A folder laid out like a frozen engine's libraries, with two made-up NVIDIA libraries."""
    root = tmp_path / "_internal"
    contents = {
        "nvidia/cublas/bin/cublas64_12.dll": os.urandom(4096) + b"A" * 200_000,
        "nvidia/cudnn/bin/cudnn_ops64_9.dll": b"B" * 300_000 + os.urandom(1024),
    }
    for name, data in contents.items():
        path = root / name
        path.parent.mkdir(parents=True)
        path.write_bytes(data)
    (root / "python313.dll").write_bytes(b"not an NVIDIA library")
    return root, contents


def _pack_all(root: Path) -> None:
    for library in cuda_pack.libraries(root):
        cuda_pack.pack_file(library, library.with_name(library.name + cuda_pack.PACKED_SUFFIX))
        library.unlink()


def test_packed_libraries_come_back_identical_and_the_packed_files_go(tmp_path):
    root, contents = _engine(tmp_path)
    assert [p.name for p in cuda_pack.libraries(root)] == ["cublas64_12.dll", "cudnn_ops64_9.dll"]
    _pack_all(root)
    assert cuda_pack.libraries(root) == [] and len(cuda_pack.packed(root)) == 2
    assert sum(p.stat().st_size for p in cuda_pack.packed(root)) < 50_000  # it really compresses

    assert cuda_pack.unpack(root) == (2, [])
    for name, data in contents.items():
        assert (root / name).read_bytes() == data
    assert cuda_pack.packed(root) == []
    assert not list(root.rglob("*.partial"))
    assert (root / "python313.dll").read_bytes() == b"not an NVIDIA library"
    # Nothing left to do: a second call is free and reports nothing.
    assert cuda_pack.unpack(root) == (0, [])


def test_a_damaged_file_is_reported_and_left_for_the_next_start(tmp_path):
    root, contents = _engine(tmp_path)
    _pack_all(root)
    damaged = root / "nvidia/cublas/bin/cublas64_12.dll.xz"
    data = bytearray(damaged.read_bytes())
    data[len(data) // 2] ^= 0xFF
    damaged.write_bytes(bytes(data))

    done, errors = cuda_pack.unpack(root)
    assert done == 1 and len(errors) == 1 and errors[0].startswith("cublas64_12.dll.xz:")
    # The good one is unpacked; the damaged one gave no library under the real name.
    assert (root / "nvidia/cudnn/bin/cudnn_ops64_9.dll").read_bytes() == contents["nvidia/cudnn/bin/cudnn_ops64_9.dll"]
    assert not (root / "nvidia/cublas/bin/cublas64_12.dll").exists()
    assert damaged.exists() and not list(root.rglob("*.partial"))


def test_an_engine_run_from_source_has_nothing_to_unpack():
    assert cuda_pack.runtime_root() is None
    assert cuda_pack.unpack() == (0, [])
