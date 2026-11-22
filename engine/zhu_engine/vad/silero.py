"""Streaming Silero VAD (v6 ONNX model shipped inside faster-whisper), run on the CPU through onnxruntime.

Using the ONNX model avoids installing PyTorch. One instance per audio source,
because the recurrent state is per stream.
"""

from __future__ import annotations

import os
import sys
from importlib import resources

import numpy as np

CHUNK = 512  # samples at 16 kHz = 32 ms
CONTEXT = 64


def model_path() -> str:
    if getattr(sys, "frozen", False):
        candidate = os.path.join(getattr(sys, "_MEIPASS", ""), "faster_whisper", "assets", "silero_vad_v6.onnx")
        if os.path.exists(candidate):
            return candidate
    return str(resources.files("faster_whisper").joinpath("assets/silero_vad_v6.onnx"))


class StreamingSileroVAD:
    def __init__(self) -> None:
        import onnxruntime

        opts = onnxruntime.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.log_severity_level = 4
        self._session = onnxruntime.InferenceSession(model_path(), providers=["CPUExecutionProvider"], sess_options=opts)
        self.reset()

    def reset(self) -> None:
        self._h = np.zeros((1, 1, 128), dtype=np.float32)
        self._c = np.zeros((1, 1, 128), dtype=np.float32)
        self._context = np.zeros(CONTEXT, dtype=np.float32)
        self._pending = np.zeros(0, dtype=np.float32)

    def process(self, audio: np.ndarray) -> list[float]:
        """Feed 16 kHz float32 audio; returns one speech probability per completed 512-sample chunk."""
        buf = np.concatenate([self._pending, audio.astype(np.float32, copy=False)])
        n = buf.size // CHUNK
        probs: list[float] = []
        for i in range(n):
            chunk = buf[i * CHUNK : (i + 1) * CHUNK]
            inp = np.concatenate([self._context, chunk])[None, :]
            out, self._h, self._c = self._session.run(None, {"input": inp, "h": self._h, "c": self._c})
            self._context = chunk[-CONTEXT:]
            probs.append(float(out.reshape(-1)[0]))
        self._pending = buf[n * CHUNK :]
        return probs
