"""Hybrid question completion engine (Master Prompt 01, section 11).

Silence is never the only signal. The pause needed to finalize a question adapts
to linguistic completeness (an explicit "?" or a dangling conjunction), transcript
finalization, VAD speech activity, and speaker or source changes. The wait is
always bounded by ``max_completion_timeout_ms``.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .config import QuestionEngineConfig
from .text import ends_dangling


class CompletionState(str, Enum):
    IN_PROGRESS = "in_progress"
    AWAITING = "awaiting"
    COMPLETE = "complete"


@dataclass(frozen=True)
class CompletionDecision:
    state: CompletionState
    boundary_confidence: float | None
    reason: str
    possibly_incomplete: bool = False


def required_pause_ms(text: str, all_final: bool, cfg: QuestionEngineConfig) -> tuple[int, str]:
    if ends_dangling(text):
        return cfg.extended_pause_ms, "dangling ending"
    if text.rstrip().endswith("?") and all_final:
        return cfg.short_pause_ms, "explicit question ending"
    return cfg.base_pause_ms, "linguistically complete"


def evaluate_completion(
    text: str,
    silence_ms: int,
    *,
    all_final: bool,
    speech_active: bool,
    pending_final: bool,
    other_source_spoke: bool,
    cfg: QuestionEngineConfig,
) -> CompletionDecision:
    if speech_active:
        return CompletionDecision(CompletionState.IN_PROGRESS, None, "speech active")
    dangling = ends_dangling(text)
    if (pending_final or not all_final) and silence_ms < cfg.max_completion_timeout_ms:
        state = CompletionState.AWAITING if silence_ms >= cfg.awaiting_after_ms else CompletionState.IN_PROGRESS
        return CompletionDecision(state, None, "waiting for final transcript")
    if (pending_final or not all_final) and silence_ms >= cfg.max_completion_timeout_ms:
        return CompletionDecision(CompletionState.COMPLETE, 0.35, "completion timeout", possibly_incomplete=True)
    if other_source_spoke and not dangling and silence_ms >= cfg.awaiting_after_ms + cfg.onset_guard_ms:
        return CompletionDecision(CompletionState.COMPLETE, 0.75, "another audio source started speaking")
    need, reason = required_pause_ms(text, all_final, cfg)
    need += cfg.onset_guard_ms
    if silence_ms >= need:
        if dangling:
            return CompletionDecision(CompletionState.COMPLETE, 0.4, "extended pause after dangling ending", possibly_incomplete=True)
        conf = 0.9 if text.rstrip().endswith("?") else 0.75
        return CompletionDecision(CompletionState.COMPLETE, conf, reason)
    if silence_ms >= cfg.awaiting_after_ms:
        return CompletionDecision(CompletionState.AWAITING, None, f"pause {silence_ms} ms < {need} ms ({reason})")
    return CompletionDecision(CompletionState.IN_PROGRESS, None, "recent speech")
