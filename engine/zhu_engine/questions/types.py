"""Typed contracts for the question detection pipeline.

Every pipeline stage consumes and produces the types defined here, so each stage
can be tested independently (Master Prompt 01, section 2).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class AudioSource(str, Enum):
    MICROPHONE = "microphone"
    SYSTEM = "system"
    MANUAL = "manual"  # typed in by the user
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class WordInfo:
    """Word-level output of the STT engine (faster-whisper word_timestamps)."""

    text: str
    start_ms: int
    end_ms: int
    probability: Optional[float] = None


@dataclass(frozen=True)
class TranscriptSegment:
    """One speech segment produced by the STT engine.

    A segment is identified by ``segment_id`` and may be emitted several times
    with an increasing ``revision``: partial results followed by one final result.
    """

    segment_id: str
    revision: int
    text: str
    start_ms: int
    end_ms: int
    is_final: bool
    source: AudioSource = AudioSource.UNKNOWN
    speaker: str = "unknown"
    confidence: Optional[float] = None  # mean word probability when available
    words: tuple[WordInfo, ...] = ()
    language: Optional[str] = None


class QuestionState(str, Enum):
    IDLE = "IDLE"
    SPEECH_DETECTED = "SPEECH_DETECTED"
    CANDIDATE = "CANDIDATE"
    QUESTION_IN_PROGRESS = "QUESTION_IN_PROGRESS"
    AWAITING_COMPLETION = "AWAITING_COMPLETION"
    COMPLETE = "COMPLETE"
    REVISED = "REVISED"
    DISCARDED = "DISCARDED"
    MANUALLY_EDITED = "MANUALLY_EDITED"


class QuestionKind(str, Enum):
    """The linguistic *form* of a question (independent of its topic)."""

    DIRECT = "DIRECT"
    IMPERATIVE = "IMPERATIVE"
    CODING_TASK = "CODING_TASK"
    SCENARIO = "SCENARIO"
    MULTI_PART = "MULTI_PART"
    INDIRECT = "INDIRECT"
    BEHAVIORAL = "BEHAVIORAL"
    MATH = "MATH"
    INCOMPLETE = "INCOMPLETE"


class QuestionCategory(str, Enum):
    """The technical *topic* of a question."""

    JAVA = "JAVA"
    SPRING_BOOT = "SPRING_BOOT"
    JAVASCRIPT = "JAVASCRIPT"
    TYPESCRIPT = "TYPESCRIPT"
    REACT = "REACT"
    NODEJS = "NODEJS"
    PYTHON = "PYTHON"
    CSHARP = "CSHARP"
    CPP = "CPP"
    SQL = "SQL"
    DATABASE = "DATABASE"
    DATA_STRUCTURES = "DATA_STRUCTURES"
    ALGORITHMS = "ALGORITHMS"
    SYSTEM_DESIGN = "SYSTEM_DESIGN"
    MICROSERVICES = "MICROSERVICES"
    DEVOPS = "DEVOPS"
    CLOUD = "CLOUD"
    MATH = "MATH"
    BEHAVIORAL = "BEHAVIORAL"
    GENERAL = "GENERAL"


class RelationshipType(str, Enum):
    FOLLOW_UP = "FOLLOW_UP"
    REPEAT_OF = "REPEAT_OF"
    MERGED_FROM = "MERGED_FROM"
    SPLIT_FROM = "SPLIT_FROM"


@dataclass
class Confidence:
    """Separate heuristic confidence scores in [0, 1], one per pipeline stage.

    These are **uncalibrated heuristic scores**, not probabilities. Calibration
    against the labelled dataset is produced by ``evaluation/evaluate.py``.
    ``None`` means the stage did not run or has nothing meaningful to report.
    """

    transcription: Optional[float] = None
    classification: Optional[float] = None
    boundary: Optional[float] = None
    context_resolution: Optional[float] = None
    normalization: Optional[float] = None
    calibrated: bool = False


@dataclass(frozen=True)
class Span:
    """A character span in a piece of text, with a reason."""

    start: int
    end: int
    reason: str


@dataclass(frozen=True)
class Substitution:
    """A normalization applied to the text. It is kept so the UI can show what changed."""

    original: str
    replacement: str
    rule: str
    confidence: float


@dataclass
class Question:
    question_id: str
    session_id: str
    state: QuestionState
    revision: int
    raw_text: str  # verbatim STT text of the source segments
    formatted_text: str  # normalized and formatted
    resolved_text: Optional[str]  # context-resolved, or None if not resolved
    kind: QuestionKind
    category: QuestionCategory
    source_segment_ids: list[str]
    started_at_ms: int
    ended_at_ms: Optional[int]
    source: AudioSource = AudioSource.UNKNOWN
    speaker: str = "unknown"
    confidence: Confidence = field(default_factory=Confidence)
    subquestions: list[str] = field(default_factory=list)
    scenario: Optional[str] = None  # preserved scenario context
    uncertain_spans: list[Span] = field(default_factory=list)
    substitutions: list[Substitution] = field(default_factory=list)
    math_latex: Optional[str] = None
    needs_review: bool = False
    review_reasons: list[str] = field(default_factory=list)
    parent_question_id: Optional[str] = None  # follow-up parent
    repeat_of: Optional[str] = None
    saved: bool = False
    edit_history: list[dict] = field(default_factory=list)

    @property
    def display_text(self) -> str:
        return self.resolved_text or self.formatted_text


class QuestionEventType(str, Enum):
    CREATED = "question.created"
    UPDATED = "question.updated"
    COMPLETED = "question.completed"
    REVISED = "question.revised"
    DISCARDED = "question.discarded"
    ERROR = "question.error"


@dataclass(frozen=True)
class QuestionEvent:
    event_type: QuestionEventType
    question: Question
