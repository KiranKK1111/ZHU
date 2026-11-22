"""Configurable thresholds for the question engine. All values are in milliseconds unless noted.

Defaults were chosen from the evaluation dataset (see docs/QUESTION_ENGINE.md);
``benchmarks/question_benchmark.py`` re-measures them.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class QuestionEngineConfig:
    candidate_threshold: float = 0.5
    # Completion
    awaiting_after_ms: int = 350  # silence before IN_PROGRESS -> AWAITING_COMPLETION
    short_pause_ms: int = 800  # explicit "?" and finalized transcript
    base_pause_ms: int = 1400  # linguistically complete, no "?"
    extended_pause_ms: int = 3500  # dangling ending ("... and", "explain ...")
    max_completion_timeout_ms: int = 9000  # hard bound while waiting for a final STT result
    # VAD confirms that speech has resumed only after min_speech_ms (~250 ms) of voice. Measured in
    # the real-time benchmark: without this guard a comma pause ("What is a microservice, | why…")
    # completed the first clause before the resumption was confirmed. Added to every pause.
    onset_guard_ms: int = 300
    continuation_window_ms: int = 4000  # "...and give me an example" after completion
    non_question_flush_ms: int = 1500
    # Duplicates
    duplicate_similarity: float = 0.88
    dedupe_recent_questions: int = 20
    # Confidence
    uncertain_word_probability: float = 0.45
    low_transcription_confidence: float = 0.6
    # Context
    context_size: int = 8
    follow_up_window_ms: int = 180_000
    # Window bound: a source window never holds more than this many segments.
    max_window_segments: int = 64
