"""VAD segmenter integration test on real (SAPI-synthesized) speech.

Audio comes from `benchmarks/stt_benchmark.py` (generated on Windows); skipped if absent.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

AUDIO = Path(__file__).resolve().parents[1] / "benchmarks" / "audio"
A, B = AUDIO / "clear-q-short.wav", AUDIO / "clear-q-ll.wav"


@pytest.mark.skipif(not (A.exists() and B.exists()), reason="benchmark audio not generated")
def test_two_utterances_give_two_segments():
    from zhu_engine.vad.segmenter import Segmenter, VadConfig

    from benchmarks.stt_benchmark import read_wav

    a, b = read_wav(A), read_wav(B)
    gap = np.zeros(16000 * 2, np.float32)
    stream = np.concatenate([gap[:8000], a, gap, b, gap])
    starts, ends = [], []
    seg = Segmenter("system", VadConfig(), lambda s: starts.append(s.start_sample), lambda s: None, lambda s: ends.append((s.start_sample, s.end_sample)))
    for i in range(0, stream.size, 320):  # 20 ms blocks, like the capture worker
        seg.feed(stream[i : i + 320], i)
    seg.flush()
    assert len(starts) == 2 and len(ends) == 2
    # First segment starts near the real speech onset (0.5 s, minus pre-roll), ends before the second begins.
    assert 0 <= ends[0][0] <= 8000 + 1600
    assert ends[0][1] < ends[1][0]
    # Second segment starts within ~0.5 s of where utterance B really starts.
    b_start = 8000 + a.size + gap.size
    assert abs(ends[1][0] - b_start) < 8000
