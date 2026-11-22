"""WASAPI capture of one audio source (microphone or system loopback) with automatic recovery.

Capture runs only between ``start()`` and ``stop()``, which are triggered explicitly
by the user from the UI. There is no hidden or automatic recording.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Callable, Optional

import numpy as np

from .devices import AudioDevice, PortAudioHost, _pyaudio, resolve_device
from .preprocess import Preprocessor

log = logging.getLogger(__name__)

BlockHandler = Callable[[np.ndarray, int], None]  # (16 kHz mono float32 block, session sample offset)
StatusHandler = Callable[[str, str, Optional[str]], None]  # (source kind, state, message)


class SourceCapture:
    def __init__(
        self,
        kind: str,
        device_id: Optional[str],
        on_block: BlockHandler,
        on_status: StatusHandler,
        noise_reduction: bool = True,
        queue_blocks: int = 200,
    ) -> None:
        self.kind = kind
        self.device_id = device_id
        self._on_block = on_block
        self._on_status = on_status
        self._noise_reduction = noise_reduction
        self._q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=queue_blocks)  # bounded (about 4 s of 20 ms blocks)
        self._stop = threading.Event()
        self._paused = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.dropped_blocks = 0
        self.device: Optional[AudioDevice] = None
        self._samples_out = 0  # 16 kHz samples delivered, defines this source's clock

    # ------------------------------------------------------------------ control
    def start(self, sample_offset: int = 0) -> None:
        self._samples_out = sample_offset
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name=f"capture-{self.kind}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def pause(self) -> None:
        self._paused.set()

    def resume(self) -> None:
        self._paused.clear()

    @property
    def samples_out(self) -> int:
        return self._samples_out

    def advance_clock(self, samples: int) -> None:
        """Keep the clock moving while paused, so timestamps stay monotonic with wall time."""
        self._samples_out += samples

    # ------------------------------------------------------------------ worker
    def _run(self) -> None:
        backoff = 0.5
        while not self._stop.is_set():
            try:
                self._capture_once()
                backoff = 0.5
            except Exception as exc:  # device unplugged, exclusive-mode conflict, driver reset...
                log.warning("%s capture error: %s", self.kind, exc)
                self._on_status(self.kind, "reconnecting", f"Audio device interrupted: {exc}")
                if self._stop.wait(backoff):
                    break
                backoff = min(backoff * 2, 5.0)
        self._on_status(self.kind, "stopped", None)

    def _capture_once(self) -> None:
        pyaudio = _pyaudio()
        dev = resolve_device(self.kind, self.device_id)
        if dev is None:
            raise RuntimeError(f"no {self.kind} device available")
        self.device = dev
        channels = max(1, dev.channels)  # WASAPI shared mode: must match the endpoint's native channel count
        pre = Preprocessor(dev.default_samplerate, channels, self._noise_reduction)
        frames = max(1, dev.default_samplerate // 50)  # 20 ms

        def callback(in_data, frame_count, time_info, status):
            arr = np.frombuffer(in_data, dtype=np.float32).reshape(-1, channels)
            try:
                self._q.put_nowait(arr.copy())
            except queue.Full:
                try:
                    self._q.get_nowait()  # drop oldest, never block the audio thread
                except queue.Empty:
                    pass
                self.dropped_blocks += 1
                self._q.put_nowait(arr.copy())
            return (None, pyaudio.paContinue)

        stream = PortAudioHost.open_stream(format=pyaudio.paFloat32, channels=channels, rate=dev.default_samplerate, input=True,
                                           input_device_index=dev.index, frames_per_buffer=frames, stream_callback=callback)
        self._on_status(self.kind, "capturing", dev.name)
        last_data = time.monotonic()
        # A loopback endpoint delivers NO packets while nothing plays. To keep this source's
        # sample clock locked to real time (segment timestamps and question completion depend
        # on it), silence is filled against the wall clock: before each block, and on idle
        # timeouts, the clock is padded with zeros up to the samples real time says are due.
        wall0, clock0 = time.monotonic(), self._samples_out

        def pad_to_now(reserve: int = 0) -> None:
            due = clock0 + int((time.monotonic() - wall0) * 16_000) - reserve
            gap = due - self._samples_out
            if gap > 1600:  # > 100 ms behind real time: that span was silence
                self._deliver(np.zeros(gap, dtype=np.float32))

        try:
            while not self._stop.is_set():
                try:
                    block = self._q.get(timeout=0.25)
                    last_data = time.monotonic()
                except queue.Empty:
                    if not stream.is_active():
                        raise RuntimeError("stream became inactive")
                    if self.kind == "system":
                        pad_to_now()
                    elif time.monotonic() - last_data > 3.0:
                        raise RuntimeError("microphone delivered no audio for 3 s")
                    continue
                processed = pre.process(block)
                if self.kind == "system":
                    pad_to_now(reserve=processed.size)
                self._deliver(processed)
        finally:
            PortAudioHost.close_stream(stream)  # never terminate PortAudio: other streams may be open

    def _deliver(self, mono16k: np.ndarray) -> None:
        if mono16k.size == 0:
            return
        offset = self._samples_out
        self._samples_out += mono16k.size
        if not self._paused.is_set():
            self._on_block(mono16k, offset)
