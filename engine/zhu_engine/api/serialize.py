"""JSON serialization of engine dataclasses for REST and WebSocket payloads."""

from __future__ import annotations

from dataclasses import asdict
from enum import Enum
from typing import Any

from ..questions.types import Question, TranscriptSegment


def _plain(v: Any) -> Any:
    if isinstance(v, Enum):
        return v.value
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    return v


def question_to_dict(q: Question) -> dict:
    d = _plain(asdict(q))
    d["display_text"] = q.display_text
    return d


def segment_to_dict(s: TranscriptSegment, source_label: str | None = None) -> dict:
    d = _plain(asdict(s))
    d["source_label"] = source_label or s.source.value
    return d


def screenshot_to_dict(row: dict) -> dict:
    return {
        "id": row["id"],
        "session_id": row.get("session_id"),
        "file_name": row["file_name"],
        "width": row["width"],
        "height": row["height"],
        "format": row["format"],
        "bytes": row["bytes"],
        "mode": row["mode"],
        "monitor": row.get("monitor"),
        "created_at": row["created_at"],
    }
