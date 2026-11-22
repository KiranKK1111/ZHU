"""WASAPI device enumeration (microphones and render-endpoint loopbacks) via PyAudioWPatch.

PortAudio is a process-global library. Creating one PyAudio instance per caller and
terminating it afterwards tears down every other open stream: in testing, a failed
microphone open terminated the running loopback capture ("Unanticipated host error"),
and so did listing devices while recording. ZHU therefore uses ONE shared instance.
It is re-initialized (to pick up hot-plugged devices) only while no stream is open.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import asdict, dataclass
from typing import Optional

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class AudioDevice:
    id: str  # stable: "<kind>:<device name>"
    name: str
    kind: str  # "microphone" | "system"
    index: int
    channels: int  # native channel count; WASAPI shared mode requires opening with exactly this
    default_samplerate: int
    is_default: bool

    def to_dict(self) -> dict:
        return asdict(self)


def _pyaudio():
    import pyaudiowpatch as pyaudio  # Windows-only dependency

    return pyaudio


class PortAudioHost:
    """Process-wide PortAudio owner with stream reference counting."""

    _lock = threading.RLock()
    _pa = None
    _open_streams = 0

    @classmethod
    def instance(cls, refresh: bool = False):
        with cls._lock:
            if cls._pa is not None and refresh and cls._open_streams == 0:
                cls._pa.terminate()
                cls._pa = None
            if cls._pa is None:
                cls._pa = _pyaudio().PyAudio()
            return cls._pa

    @classmethod
    def open_stream(cls, **kwargs):
        with cls._lock:
            stream = cls.instance().open(**kwargs)
            cls._open_streams += 1
            return stream

    @classmethod
    def close_stream(cls, stream) -> None:
        with cls._lock:
            try:
                if stream.is_active():
                    stream.stop_stream()
                stream.close()
            finally:
                cls._open_streams = max(0, cls._open_streams - 1)

    @classmethod
    def lock(cls):
        return cls._lock


def list_devices() -> list[AudioDevice]:
    pyaudio = _pyaudio()
    with PortAudioHost.lock():
        p = PortAudioHost.instance(refresh=True)
        wasapi = p.get_host_api_info_by_type(pyaudio.paWASAPI)
        default_in = wasapi.get("defaultInputDevice", -1)
        default_out = wasapi.get("defaultOutputDevice", -1)
        default_out_name = p.get_device_info_by_index(default_out)["name"] if default_out >= 0 else None
        devices: list[AudioDevice] = []
        for i in range(wasapi["deviceCount"]):
            d = p.get_device_info_by_host_api_device_index(wasapi["index"], i)
            if d.get("isLoopbackDevice"):
                base = d["name"].replace(" [Loopback]", "")
                devices.append(AudioDevice(f"system:{base}", base, "system", d["index"], int(d["maxInputChannels"]),
                                           int(d["defaultSampleRate"]), base == default_out_name))
            elif d["maxInputChannels"] > 0:
                devices.append(AudioDevice(f"microphone:{d['name']}", d["name"], "microphone", d["index"],
                                           int(d["maxInputChannels"]), int(d["defaultSampleRate"]), d["index"] == default_in))
        return devices


def resolve_device(kind: str, device_id: Optional[str]) -> Optional[AudioDevice]:
    """Resolve by stable id; fall back to the current default device of that kind."""
    devices = [d for d in list_devices() if d.kind == kind]
    if device_id and device_id != "default":
        for d in devices:
            if d.id == device_id:
                return d
        log.warning("audio device %r not found; falling back to default %s device", device_id, kind)
    return next((d for d in devices if d.is_default), devices[0] if devices else None)
