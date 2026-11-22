"""Parakeet back end: catalog, installation check, model selection, fallback, word grouping, and
(when the model and benchmark audio are present) real inference."""

from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np
import pytest

from zhu_engine.session import SessionService
from zhu_engine.stt import parakeet
from zhu_engine.stt.models import CATALOG, Selection, installed_models, is_installed, required_files, select_model, supports_language

V2, V3 = "parakeet-tdt-0.6b-v2", "parakeet-tdt-0.6b-v3"
ROOT = Path(__file__).resolve().parents[1]
BENCH_MODELS = ROOT / "benchmarks" / "models"
BENCH_AUDIO = ROOT / "benchmarks" / "audio"


# ------------------------------------------------------------------ catalog
def test_catalog_lists_parakeet_with_download_and_memory_info():
    for name in (V2, V3):
        spec = CATALOG[name]
        assert spec.backend == "parakeet" and spec.repo.startswith("istupakov/parakeet-tdt-0.6b-")
        assert 2900 <= spec.download_mb <= 3200  # FP32 + INT8 ONNX files (about 3.2 GB)
        assert spec.revision and len(spec.revision) == 40  # third-party export: pinned to the tested commit
        d = spec.to_dict()
        assert "DirectML" in d["memory_summary"] and "CPU (INT8)" in d["memory_summary"]
    assert CATALOG[V2].languages == ("en",) and not CATALOG[V2].multilingual
    assert len(CATALOG[V3].languages) == 25 and CATALOG[V3].multilingual
    assert "FP16" in CATALOG["large-v3-turbo"].to_dict()["memory_summary"]


def test_language_support():
    assert supports_language(V2, "en") and not supports_language(V2, "hi") and not supports_language(V2, None)
    assert supports_language(V3, "de") and supports_language(V3, None) and not supports_language(V3, "ja")
    assert supports_language("large-v3-turbo", "ja") and supports_language("large-v3-turbo", None)
    assert not supports_language("distil-large-v3", "fr")


def test_installed_requires_every_parakeet_file(tmp_path):
    d = tmp_path / V2
    d.mkdir()
    for f in required_files(V2)[:-1]:
        (d / f).write_bytes(b"x")
    (d / ".zhu-complete").write_text("repo")
    assert not is_installed(tmp_path, V2)  # vocab.txt missing
    (d / "vocab.txt").write_text("<blk> 0")
    assert is_installed(tmp_path, V2) and installed_models(tmp_path) == [V2]


# ------------------------------------------------------------------ selection
def test_parakeet_runs_on_gpu_through_directml_when_vram_and_memory_allow():
    s = select_model(V2, [V2], True, 7800, 4096, commit_free_mb=6000)
    assert (s.model, s.device, s.compute_type) == (V2, "directml", "float32")


@pytest.mark.parametrize("kwargs, why", [
    ({"vram_free_mb": 2000}, "VRAM"),
    ({"commit_free_mb": 2500}, "free memory"),
    ({"directml": False}, "DirectML unavailable"),
    ({"compute_pref": "int8"}, "INT8 requested"),
])
def test_preferred_parakeet_falls_back_to_cpu_int8(kwargs, why):
    args = {"vram_free_mb": 7800, "commit_free_mb": 6000} | kwargs
    vram = args.pop("vram_free_mb")
    s = select_model(V2, [V2, "small"], True, vram, 4096, **args)
    assert (s.model, s.device, s.compute_type) == (V2, "cpu", "int8")
    assert why in s.reason


def test_parakeet_without_gpu_and_gpu_required():
    assert select_model(V2, [V2], False, None, 4096) == Selection(V2, "cpu", "int8", "CUDA unavailable")
    assert select_model(V2, [V2], True, 7800, 4096, device_pref="cpu").device == "cpu"
    assert select_model(V2, [V2], True, 1000, 4096, device_pref="cuda") is None  # GPU required, nothing fits


def test_whisper_preference_is_unchanged_and_parakeet_is_the_cpu_fallback():
    s = select_model("large-v3-turbo", ["large-v3-turbo", V2, "small"], True, 7800, 4096, commit_free_mb=6000)
    assert (s.model, s.device) == ("large-v3-turbo", "cuda")
    # No GPU: Parakeet INT8 beats Whisper small on the CPU, but only for a language it supports.
    assert select_model("large-v3-turbo", ["large-v3-turbo", V2, "small"], False, None, 4096, language="en").model == V2
    assert select_model("large-v3-turbo", ["large-v3-turbo", V2, "small"], False, None, 4096, language="hi").model == "small"
    assert select_model("large-v3-turbo", ["large-v3-turbo", V3, "small"], False, None, 4096, language="de").model == V3


def test_unknown_preferred_model_does_not_crash():
    s = select_model("no-such-model", ["small"], False, None, 4096)
    assert s.model == "small"


def test_parakeet_load_failure_ladder():
    ladder = SessionService._fallback_ladder(Selection(V2, "directml", "float32", "x"), [V2, "small"])
    assert [(s.model, s.device, s.compute_type) for s in ladder] == [(V2, "cpu", "int8"), ("small", "cpu", "int8")]
    ladder = SessionService._fallback_ladder(Selection(V2, "cpu", "int8", "x"), [V2])
    assert ladder == []


# ------------------------------------------------------------------ word grouping
def test_group_words_joins_pieces_and_timestamps():
    sp = "▁"
    pieces = [f"{sp}What", f"{sp}is", f"{sp}Hash", "Map", f"{sp}in", f"{sp}Java", "?"]
    frames = [0, 3, 6, 8, 14, 15, 19]
    durations = [3, 3, 2, 4, 1, 4, 0]
    logprobs = [0.0, 0.0, math.log(0.5), math.log(0.9), 0.0, 0.0, 0.0]
    text, words = parakeet.group_words(pieces, frames, durations, logprobs, 0.08)
    assert text == "What is HashMap in Java?"
    assert [w.text for w in words] == ["What", "is", "HashMap", "in", "Java?"]
    hm = words[2]
    assert (hm.start_s, hm.end_s) == (0.48, 0.96)  # frames 6 .. 8 + 4
    assert hm.probability == pytest.approx(0.7)
    assert words[4].end_s == pytest.approx((19 + 1) * 0.08)  # duration 0 still covers one frame


def test_group_words_empty():
    assert parakeet.group_words([], [], [], [], 0.08) == ("", [])


# ------------------------------------------------------------------ real inference (optional)
def _read(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


@pytest.mark.skipif(not (BENCH_MODELS / V2 / "encoder-model.int8.onnx").exists() or not (BENCH_AUDIO / "clear-q-micro.wav").exists(),
                    reason="Parakeet v2 model or benchmark audio not present (see benchmarks/stt_benchmark.py)")
def test_parakeet_cpu_int8_transcribes_real_speech():
    m = parakeet.ParakeetModel(BENCH_MODELS / V2, device="cpu", precision="int8", cpu_threads=2)
    res = m.transcribe(_read(BENCH_AUDIO / "clear-q-micro.wav"))
    assert res.text == "What is a microservice, why would you use it, and how would you handle distributed transactions?"
    assert all(0 <= w.start_s < w.end_s for w in res.words) and all(0 < w.probability <= 1 for w in res.words)
    assert m.transcribe(np.zeros(32000, np.float32)).text == ""  # silence: no hallucinated text
    assert m.transcribe(np.zeros(800, np.float32)).text == ""  # under 100 ms
    m.close()
