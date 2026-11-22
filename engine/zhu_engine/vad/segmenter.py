"""Speech segmenter: turns a 16 kHz stream plus VAD probabilities into speech segments.

Hysteresis thresholds, minimum speech and silence durations, pre-roll padding, and
a maximum segment length (long monologues are split at the quietest recent chunk)
are all configurable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

import numpy as np

from .silero import CHUNK, StreamingSileroVAD

SR = 16_000


@dataclass(frozen=True)
class VadConfig:
    start_threshold: float = 0.5
    end_threshold: float = 0.35
    min_speech_ms: int = 250
    min_silence_ms: int = 550
    pre_roll_ms: int = 300
    post_roll_ms: int = 150
    max_segment_s: float = 25.0


@dataclass
class SpeechSegment:
    source: str
    index: int
    start_sample: int
    audio: list[np.ndarray]
    finished: bool = False
    end_sample: Optional[int] = None

    def samples(self) -> np.ndarray:
        return np.concatenate(self.audio) if self.audio else np.zeros(0, dtype=np.float32)

    @property
    def duration_ms(self) -> int:
        return int(sum(a.size for a in self.audio) * 1000 / SR)


class Segmenter:
    """Callbacks: on_start(seg), on_audio(seg) after each block while speaking, on_end(seg)."""

    def __init__(self, source: str, cfg: VadConfig, on_start: Callable, on_audio: Callable, on_end: Callable, vad: StreamingSileroVAD | None = None) -> None:
        self.source = source
        self.cfg = cfg
        self.vad = vad or StreamingSileroVAD()
        self._on_start, self._on_audio, self._on_end = on_start, on_audio, on_end
        self._pre_roll: list[np.ndarray] = []
        self._pre_roll_len = 0
        self._current: Optional[SpeechSegment] = None
        self._speech_run = 0
        self._silence_run = 0
        self._count = 0
        self._probs: list[tuple[int, float]] = []  # (absolute chunk sample, prob) within current segment
        self._pos = 0  # absolute sample index of the next sample to arrive

    def feed(self, audio: np.ndarray, offset: int) -> None:
        if offset > self._pos + SR:  # gap (pause/resume): close any open segment
            self.flush()
        self._pos = offset
        probs = self.vad.process(audio)
        chunk_ms = CHUNK * 1000 // SR
        cursor = 0
        for p in probs:
            chunk = audio[cursor : cursor + CHUNK] if cursor < audio.size else np.zeros(0, np.float32)
            cursor += CHUNK
            self._step(p, chunk, chunk_ms)
        tail = audio[cursor:]
        if tail.size:
            self._append(tail)
        self._pos = offset + audio.size
        if self._current is not None:
            self._on_audio(self._current)

    def _append(self, chunk: np.ndarray) -> None:
        if self._current is not None:
            self._current.audio.append(chunk)
        else:
            self._pre_roll.append(chunk)
            self._pre_roll_len += chunk.size
            limit = self.cfg.pre_roll_ms * SR // 1000
            while self._pre_roll and self._pre_roll_len - self._pre_roll[0].size >= limit:
                self._pre_roll_len -= self._pre_roll.pop(0).size

    def _step(self, prob: float, chunk: np.ndarray, chunk_ms: int) -> None:
        cfg = self.cfg
        if self._current is None:
            self._append(chunk)
            self._speech_run = self._speech_run + chunk_ms if prob >= cfg.start_threshold else 0
            if self._speech_run >= cfg.min_speech_ms:
                start = self._pos - self._pre_roll_len
                self._current = SpeechSegment(self.source, self._count, max(0, start), list(self._pre_roll))
                self._count += 1
                self._pre_roll, self._pre_roll_len = [], 0
                self._silence_run = 0
                self._probs = []
                self._on_start(self._current)
        else:
            self._current.audio.append(chunk)
            self._probs.append((self._pos, prob))
            self._silence_run = self._silence_run + chunk_ms if prob < cfg.end_threshold else 0
            if self._silence_run >= cfg.min_silence_ms:
                self._finish(trim_ms=max(0, self._silence_run - cfg.post_roll_ms))
            elif self._current.duration_ms >= cfg.max_segment_s * 1000:
                self._split_long()
        self._pos += chunk.size

    def _finish(self, trim_ms: int = 0) -> None:
        seg = self._current
        if seg is None:
            return
        audio = seg.samples()
        trim = min(audio.size, trim_ms * SR // 1000)
        if trim:
            audio = audio[: audio.size - trim]
        seg.audio = [audio]
        seg.finished = True
        seg.end_sample = seg.start_sample + audio.size
        self._current = None
        self._speech_run = 0
        self._on_end(seg)

    def _split_long(self) -> None:
        """Split at the lowest-probability chunk in the last 3 s, keeping the remainder as a new segment."""
        seg = self._current
        assert seg is not None
        recent = self._probs[-int(3 * SR / CHUNK) :]
        split_at = min(recent, key=lambda x: x[1])[0] if recent else self._pos
        audio = seg.samples()
        cut = max(SR, min(audio.size, split_at - seg.start_sample))
        head, tail = audio[:cut], audio[cut:]
        seg.audio = [head]
        self._finish()
        nxt = SpeechSegment(self.source, self._count, seg.start_sample + cut, [tail])
        self._count += 1
        self._current = nxt
        self._probs = []
        self._on_start(nxt)

    def flush(self) -> None:
        if self._current is not None:
            self._finish()
        self.vad.reset()
        self._pre_roll, self._pre_roll_len = [], 0
        self._speech_run = self._silence_run = 0
