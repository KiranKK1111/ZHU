"""STT worker: one thread owns the speech model and serializes all GPU work.

The model is faster-whisper (CTranslate2) or NVIDIA Parakeet (ONNX Runtime, stt/parakeet.py),
chosen by the catalog's ``backend``. Neither is used as a native streaming model. ZHU
approximates streaming like this:
* While a VAD speech segment grows, the segment audio is re-decoded at an interval
  (greedy, without word timestamps) and emitted as ``transcript.partial`` revisions.
  These may change.
* At VAD end-of-speech the whole segment is decoded once more (beam search, word
  timestamps) and emitted as ``transcript.final``.
Segments never overlap in audio, so no words are duplicated across segments.
Force-split long segments (> max_segment_s) are additionally de-duplicated on
their word boundary.

The job queue is bounded. Final jobs take priority, and a pending partial for a
segment is replaced (coalesced) by a newer one.
"""

from __future__ import annotations

import logging
import math
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import numpy as np

from ..questions.types import AudioSource, TranscriptSegment, WordInfo
from ..system.gpu import register_cuda_dlls
from .models import CATALOG, Selection, model_dir
from .parakeet import model_languages

log = logging.getLogger(__name__)
SR = 16_000

# Phrases Whisper is known to hallucinate on silence/noise. Only dropped when the
# segment is short AND the decoder reports a high no-speech probability.
_HALLUCINATIONS = re.compile(
    r"^(?:thank you\.?|thanks for watching!?|thank you for watching\.?|you\.?|bye\.?|\.+|subtitles by .*|"
    r"please subscribe.*|transcribed by .*)$",
    re.IGNORECASE,
)


@dataclass
class _Job:
    key: str  # segment id
    source: AudioSource
    audio: np.ndarray
    start_ms: int
    final: bool
    revision: int
    enqueued: float


@dataclass(frozen=True)
class SttOptions:
    language: Optional[str] = "en"  # None = auto-detect
    beam_size_final: int = 5
    beam_size_partial: int = 1
    partial_min_audio_ms: int = 900
    hotwords: Optional[str] = None
    max_pending_jobs: int = 8


class Transcriber:
    def __init__(self, models_root: Path, selection: Selection, options: SttOptions,
                 on_segment: Callable[[TranscriptSegment, dict], None], on_error: Callable[[str], None]) -> None:
        self.models_root = models_root
        self.selection = selection
        self.options = options
        self._on_segment = on_segment
        self._on_error = on_error
        self.backend = CATALOG[selection.model].backend if selection.model in CATALOG else "whisper"
        self._model = None
        self._cv = threading.Condition()
        self._finals: "OrderedDict[str, _Job]" = OrderedDict()
        self._partials: "OrderedDict[str, _Job]" = OrderedDict()
        self._stop = False
        self._thread: Optional[threading.Thread] = None
        self._prev_final_text: dict[AudioSource, str] = {}
        self._prev_final_end: dict[AudioSource, int] = {}
        self.stats = {"jobs": 0, "dropped_partials": 0, "last_rtf": None, "last_latency_ms": None, "load_ms": None}
        self.ready = threading.Event()
        self.load_error: Optional[str] = None

    # ---------------------------------------------------------------- lifecycle
    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="stt-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        with self._cv:
            self._stop = True
            self._cv.notify_all()
        if self._thread:
            self._thread.join(timeout=10)
        # Releases GPU memory (CTranslate2 and ONNX Runtime free their buffers on destruction).
        if self.backend == "parakeet" and self._model is not None:
            self._model.close()
        self._model = None

    def _load(self) -> None:
        sel = self.selection
        t0 = time.perf_counter()
        path = model_dir(self.models_root, sel.model)
        if self.backend == "parakeet":
            from .parakeet import ParakeetModel

            self._model = ParakeetModel(path, device=sel.device, precision=sel.compute_type, cpu_threads=4)
            # Warm-up: the first run allocates GPU buffers / initializes kernels.
            self._model.transcribe(np.zeros(SR, dtype=np.float32))
        else:
            register_cuda_dlls()
            from faster_whisper import WhisperModel

            self._model = WhisperModel(str(path), device=sel.device, compute_type=sel.compute_type,
                                       cpu_threads=4 if sel.device == "cpu" else 0, num_workers=1)
            # Warm-up: the first CUDA decode initializes cuBLAS/cuDNN kernels (several seconds).
            list(self._model.transcribe(np.zeros(SR, dtype=np.float32), language=self.options.language or "en", beam_size=1)[0])
        self.stats["load_ms"] = int((time.perf_counter() - t0) * 1000)
        log.info("loaded %s on %s/%s in %d ms", sel.model, sel.device, sel.compute_type, self.stats["load_ms"])

    # ---------------------------------------------------------------- submission
    def submit(self, key: str, source: AudioSource, audio: np.ndarray, start_ms: int, final: bool, revision: int) -> None:
        job = _Job(key, source, audio, start_ms, final, revision, time.perf_counter())
        with self._cv:
            if final:
                self._partials.pop(key, None)
                self._finals[key] = job
            else:
                if audio.size * 1000 // SR < self.options.partial_min_audio_ms:
                    return
                if key in self._partials:
                    self.stats["dropped_partials"] += 1
                self._partials[key] = job
                while len(self._partials) + len(self._finals) > self.options.max_pending_jobs and self._partials:
                    self._partials.popitem(last=False)
                    self.stats["dropped_partials"] += 1
            self._cv.notify()

    def _next(self) -> Optional[_Job]:
        with self._cv:
            while not self._stop and not self._finals and not self._partials:
                self._cv.wait()
            if self._stop:
                return None
            if self._finals:
                return self._finals.popitem(last=False)[1]
            return self._partials.popitem(last=False)[1]

    # ---------------------------------------------------------------- worker
    def _run(self) -> None:
        try:
            self._load()
        except Exception as exc:
            self.load_error = str(exc)
            log.exception("model load failed")
            self._on_error(f"Could not load speech model {self.selection.model} on {self.selection.device}: {exc}")
            self.ready.set()
            return
        self.ready.set()
        while True:
            job = self._next()
            if job is None:
                return
            try:
                self._decode(job)
            except Exception as exc:
                log.exception("decode failed")
                self._on_error(f"Transcription error: {exc}")

    def _decode(self, job: _Job) -> None:
        assert self._model is not None
        t0 = time.perf_counter()
        if self.backend == "parakeet":
            text, words, confidence, no_speech, language = self._run_parakeet(job)
        else:
            text, words, confidence, no_speech, language = self._run_whisper(job)
        elapsed = time.perf_counter() - t0
        dur = job.audio.size / SR
        self.stats["jobs"] += 1
        self.stats["last_rtf"] = round(elapsed / dur, 3) if dur else None
        self.stats["last_latency_ms"] = int((time.perf_counter() - job.enqueued) * 1000)

        # Measured on this hardware: Whisper returns "Thank you." for pure silence with
        # no_speech_prob = 0.0, so the decoder's own score is not enough. Also gate on audio energy.
        rms = float(np.sqrt(np.mean(job.audio.astype(np.float64) ** 2))) if job.audio.size else 0.0
        quiet = rms < 10 ** (-50 / 20)  # below -50 dBFS
        if not text or (_HALLUCINATIONS.match(text) and (no_speech > 0.5 or quiet) and dur < 4.0):
            if job.final:
                # Emit an empty final so consumers can close the segment, but keep no text.
                text, words, confidence = "", [], None
            else:
                return

        if job.final and text:
            text, words = self._dedupe_boundary(job, text, words)
        end_ms = job.start_ms + int(dur * 1000)
        seg = TranscriptSegment(job.key, job.revision, text, job.start_ms, end_ms, job.final, job.source,
                                confidence=confidence, words=tuple(words), language=language)
        if job.final and text:
            self._prev_final_text[job.source] = (self._prev_final_text.get(job.source, "") + " " + text)[-400:]
            self._prev_final_end[job.source] = end_ms
        self._on_segment(seg, {"rtf": self.stats["last_rtf"], "latency_ms": self.stats["last_latency_ms"], "no_speech_prob": round(no_speech, 3)})

    def _run_parakeet(self, job: _Job) -> tuple[str, list[WordInfo], Optional[float], float, Optional[str]]:
        """Parakeet has no prompt, hotwords, or beam search; partial and final decodes are identical
        greedy TDT decodes, and word timings come from the predicted token frames."""
        res = self._model.transcribe(job.audio)
        words = [WordInfo(w.text, job.start_ms + int(w.start_s * 1000), job.start_ms + int(w.end_s * 1000), w.probability) for w in res.words]
        confidence = round(sum(w.probability for w in res.words) / len(res.words), 3) if res.words else None
        # No no-speech estimate exists; the energy gate in _decode still applies.
        no_speech = 0.0 if res.text else 1.0
        return res.text, (words if job.final else []), confidence, no_speech, model_languages(CATALOG[self.selection.model].languages)

    def _run_whisper(self, job: _Job) -> tuple[str, list[WordInfo], Optional[float], float, Optional[str]]:
        opts = self.options
        prompt = self._prev_final_text.get(job.source, "")[-200:] or None
        segments, info = self._model.transcribe(
            job.audio,
            language=opts.language,
            beam_size=opts.beam_size_final if job.final else opts.beam_size_partial,
            word_timestamps=job.final,
            condition_on_previous_text=False,
            initial_prompt=prompt,
            hotwords=opts.hotwords if prompt is None else None,
            vad_filter=False,
            temperature=0.0 if not job.final else (0.0, 0.2, 0.4),
            without_timestamps=not job.final,
        )
        segs = list(segments)
        text = " ".join(s.text.strip() for s in segs).strip()
        words: list[WordInfo] = []
        for s in segs:
            for w in s.words or []:
                words.append(WordInfo(w.word.strip(), job.start_ms + int(w.start * 1000), job.start_ms + int(w.end * 1000), round(float(w.probability), 3)))
        if words:
            confidence = round(sum(w.probability or 0 for w in words) / len(words), 3)
        elif segs:
            confidence = round(math.exp(sum(s.avg_logprob for s in segs) / len(segs)), 3)
        else:
            confidence = None
        no_speech = max((s.no_speech_prob for s in segs), default=1.0)
        return text, words, confidence, no_speech, info.language

    def _dedupe_boundary(self, job: _Job, text: str, words: list[WordInfo]) -> tuple[str, list[WordInfo]]:
        """After a forced split the first words of a segment may repeat the previous segment's last words."""
        prev_end = self._prev_final_end.get(job.source)
        prev = self._prev_final_text.get(job.source, "")
        if prev_end is None or abs(job.start_ms - prev_end) > 300 or not words:
            return text, words
        prev_tokens = [t.lower().strip(",.?!") for t in prev.split()[-6:]]
        cur = [w.text.lower().strip(",.?!") for w in words]
        for k in range(min(4, len(cur), len(prev_tokens)), 1, -1):
            if cur[:k] == prev_tokens[-k:]:
                words = words[k:]
                return " ".join(w.text for w in words), words
        return text, words
