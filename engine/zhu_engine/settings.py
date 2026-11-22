"""Engine settings (validated by Pydantic, persisted in SQLite)."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class AudioSettings(BaseModel):
    microphone_enabled: bool = True
    microphone_device: Optional[str] = None  # stable id "microphone:<name>", None = Windows default
    system_enabled: bool = True
    system_device: Optional[str] = None
    noise_reduction: bool = True
    source_labels: dict[str, str] = Field(default_factory=lambda: {"microphone": "Microphone", "system": "System audio"})
    # Which sources feed question detection. Speaker identity is never inferred from the source.
    question_sources: list[Literal["microphone", "system"]] = Field(default_factory=lambda: ["system", "microphone"])


class VadSettings(BaseModel):
    start_threshold: float = Field(0.5, ge=0.05, le=0.95)
    end_threshold: float = Field(0.35, ge=0.05, le=0.95)
    min_speech_ms: int = Field(250, ge=60, le=2000)
    min_silence_ms: int = Field(550, ge=150, le=3000)
    max_segment_s: float = Field(25.0, ge=5, le=30)


class TranscriptionSettings(BaseModel):
    model: str = "large-v3-turbo"
    device: Literal["auto", "cuda", "cpu"] = "auto"
    compute_type: Literal["auto", "float16", "int8_float16", "int8"] = "auto"
    language: Optional[str] = "en"
    vram_budget_mb: int = Field(4096, ge=512, le=24576)
    profile: Literal["accuracy", "balanced", "latency"] = "balanced"
    partial_interval_ms: int = Field(700, ge=300, le=3000)
    vocabulary_hints: bool = True


class QuestionSettings(BaseModel):
    short_pause_ms: int = Field(800, ge=200, le=5000)
    base_pause_ms: int = Field(1400, ge=300, le=8000)
    extended_pause_ms: int = Field(3500, ge=800, le=15000)
    max_completion_timeout_ms: int = Field(9000, ge=2000, le=30000)


class CaptureSettings(BaseModel):
    image_format: Literal["png", "jpeg", "webp"] = "png"
    jpeg_quality: int = Field(92, ge=50, le=100)
    default_monitor: int = Field(1, ge=0)


class PrivacySettings(BaseModel):
    retention_days: Optional[int] = Field(None, ge=1, le=3650)  # None = keep until deleted
    store_transcripts: bool = True


class EngineSettings(BaseModel):
    audio: AudioSettings = Field(default_factory=AudioSettings)
    vad: VadSettings = Field(default_factory=VadSettings)
    transcription: TranscriptionSettings = Field(default_factory=TranscriptionSettings)
    questions: QuestionSettings = Field(default_factory=QuestionSettings)
    capture: CaptureSettings = Field(default_factory=CaptureSettings)
    privacy: PrivacySettings = Field(default_factory=PrivacySettings)


def merge_settings(current: EngineSettings, patch: dict) -> EngineSettings:
    data = current.model_dump()
    for section, values in patch.items():
        if section not in data:
            raise ValueError(f"unknown settings section {section!r}")
        if not isinstance(values, dict):
            raise ValueError(f"settings section {section!r} must be an object")
        data[section].update(values)
    return EngineSettings.model_validate(data)
