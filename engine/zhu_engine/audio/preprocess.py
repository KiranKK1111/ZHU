"""Streaming audio preprocessing: down-mix, resample to 16 kHz, high-pass, optional noise gate.

Everything is stateful across blocks, so block boundaries cause no clicks.
"""

from __future__ import annotations

import math

import numpy as np

TARGET_RATE = 16_000


class Preprocessor:
    def __init__(self, input_rate: int, channels: int, noise_reduction: bool = True, highpass_hz: float = 80.0) -> None:
        import soxr

        self.channels = channels
        self.noise_reduction = noise_reduction
        self._resampler = soxr.ResampleStream(input_rate, TARGET_RATE, 1, dtype="float32", quality="HQ") if input_rate != TARGET_RATE else None
        # First-order high-pass (removes DC offset and low rumble).
        rc = 1.0 / (2 * math.pi * highpass_hz)
        dt = 1.0 / TARGET_RATE
        self._alpha = rc / (rc + dt)
        self._prev_x = 0.0
        self._prev_y = 0.0
        self._noise_floor = 1e-3

    def process(self, block: np.ndarray) -> np.ndarray:
        """block: float32, shape (frames, channels) or (frames,). Returns float32 mono at 16 kHz."""
        x = block.astype(np.float32, copy=False)
        if x.ndim == 2:
            x = x.mean(axis=1, dtype=np.float32)
        if self._resampler is not None:
            x = self._resampler.resample_chunk(x)
        if x.size == 0:
            return x
        y = self._highpass(x)
        if self.noise_reduction:
            y = self._gate(y)
        return y

    def _highpass(self, x: np.ndarray) -> np.ndarray:
        """Exact vectorized one-pole high-pass y[n] = a·(y[n-1] + x[n] - x[n-1]).

        Closed form per sub-block: y[n] = a^n · (y0 + Σ_{k≤n} d[k] / a^(k-1)). Sub-blocks of
        256 samples keep a^-n well inside float64 range.
        """
        a = self._alpha
        out = np.empty(x.size, dtype=np.float32)
        px, py = self._prev_x, self._prev_y
        for s in range(0, x.size, 256):
            xs = x[s : s + 256].astype(np.float64)
            d = np.diff(xs, prepend=px)
            n = np.arange(1, xs.size + 1)
            pw = a**n
            ys = pw * (py + np.cumsum(d / (pw / a)))
            out[s : s + xs.size] = ys
            px, py = float(xs[-1]), float(ys[-1])
        self._prev_x, self._prev_y = px, py
        return out

    def _gate(self, y: np.ndarray) -> np.ndarray:
        """Soft downward expander: attenuates frames close to the tracked noise floor.
        It reduces steady background hiss. It is not a full spectral denoiser."""
        frame = 320  # 20 ms
        out = y.copy()
        for s in range(0, y.size, frame):
            seg = out[s : s + frame]
            rms = float(np.sqrt(np.mean(seg * seg)) + 1e-9)
            # Track the floor slowly upward, quickly downward.
            self._noise_floor = 0.995 * self._noise_floor + 0.005 * rms if rms > self._noise_floor else 0.9 * self._noise_floor + 0.1 * rms
            ratio = rms / (self._noise_floor * 2.0 + 1e-9)
            if ratio < 1.0:
                seg *= max(ratio, 0.25)
        return out


def rms_dbfs(x: np.ndarray) -> float:
    if x.size == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))
    return round(20 * math.log10(rms + 1e-12), 1)
