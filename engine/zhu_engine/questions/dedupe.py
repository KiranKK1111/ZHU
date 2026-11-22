"""Duplicate detection (Master Prompt 01, section 12).

* Segment level: (segment_id, revision) tracking makes ingestion idempotent
  against retransmission, WebSocket reconnects, and replayed events.
* Question level: a question that is textually similar to a recent one **and**
  overlaps it in time is a duplicate (overlapping audio windows, or re-transcription
  after a worker restart). A similar question that does **not** overlap in time is an
  intentional repeat. It is kept and linked with ``repeat_of``, never deleted.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from .text import similarity
from .types import Question, QuestionState, TranscriptSegment


class SegmentTracker:
    def __init__(self, max_tracked: int = 10_000) -> None:
        self._revisions: dict[str, int] = {}
        self._max = max_tracked

    def accept(self, seg: TranscriptSegment) -> bool:
        """True if this is a new segment or a newer revision of a known one."""
        seen = self._revisions.get(seg.segment_id)
        if seen is not None and seg.revision <= seen:
            return False
        if seen is None and len(self._revisions) >= self._max:
            # Bounded memory: forget the oldest half (insertion ordered).
            for key in list(self._revisions)[: self._max // 2]:
                del self._revisions[key]
        self._revisions[seg.segment_id] = seg.revision
        return True


@dataclass(frozen=True)
class DuplicateCheck:
    duplicate_of: Optional[str] = None
    repeat_of: Optional[str] = None


def _overlaps(a0: int, a1: int, b0: int, b1: int, tolerance_ms: int = 250) -> bool:
    return a0 < b1 + tolerance_ms and b0 < a1 + tolerance_ms


def check_duplicate(
    text: str,
    start_ms: int,
    end_ms: int,
    candidates: Iterable[Question],
    threshold: float,
    exclude_id: Optional[str] = None,
) -> DuplicateCheck:
    repeat_of = None
    for q in candidates:
        if q.question_id == exclude_id or q.state is QuestionState.DISCARDED:
            continue
        if similarity(text, q.formatted_text) < threshold:
            continue
        q_end = q.ended_at_ms if q.ended_at_ms is not None else end_ms
        if _overlaps(start_ms, end_ms, q.started_at_ms, q_end):
            return DuplicateCheck(duplicate_of=q.question_id)
        repeat_of = repeat_of or q.question_id
    return DuplicateCheck(repeat_of=repeat_of)
