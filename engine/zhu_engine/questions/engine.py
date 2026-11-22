"""QuestionEngine: the orchestrator of the question detection pipeline.

Pipeline per audio source:
    TranscriptSegment -> SegmentTracker (idempotency) -> per-source window
    -> normalize_transcript (per segment) -> split_utterances -> detect_candidate
    -> grouping (scenario context + question + continuations)
    -> compose (vocabulary -> syntax -> math -> multipart -> format -> classify -> context)
    -> state machine + completion engine -> QuestionEvent values

The engine is synchronous and side-effect free apart from its own state. It does
no I/O, so it can be unit tested deterministically. Callers feed it
``ingest_segment``, ``on_speech_start``/``on_speech_end`` (VAD), and periodic
``tick`` calls on the session audio clock.
"""

from __future__ import annotations

import copy
import re
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable, Iterable, Optional

from .boundary import Utterance, split_utterances
from .candidate import CandidateSignal, detect_candidate, is_continuation, refers_back
from .classify import classify
from .completion import CompletionDecision, CompletionState, evaluate_completion
from .config import QuestionEngineConfig
from .context import ConversationContext
from .dedupe import SegmentTracker, check_duplicate
from .formatter import format_question, format_subquestion, split_multipart
from .mathexpr import normalize_math
from .normalize import NormalizedText, normalize_transcript
from .state import LOCKED_STATES, OPEN_STATES, transition
from .syntax import has_code_context, normalize_code_syntax
from .text import capitalize_first, collapse_ws, strip_terminal_punct
from .types import (
    AudioSource,
    Confidence,
    Question,
    QuestionCategory,
    QuestionEvent,
    QuestionEventType as ET,
    QuestionKind,
    QuestionState as S,
    RelationshipType,
    Span,
    Substitution,
    TranscriptSegment,
)
from .vocabulary import TechnicalVocabulary

_PROGRAMMING_DOMAINS = {"JAVA", "SPRING_BOOT", "JAVASCRIPT", "TYPESCRIPT", "REACT", "NODEJS", "PYTHON", "CSHARP", "CPP", "SQL", "DATA_STRUCTURES", "ALGORITHMS"}


@dataclass
class _Group:
    start: int
    end: int
    first_signal: CandidateSignal
    closed: bool  # followed by another question or a non-question statement


@dataclass
class _Window:
    source: AudioSource
    segment_ids: list[str] = field(default_factory=list)
    consumed: int = 0  # chars of the normalized window text already used
    active_qid: Optional[str] = None
    active_end: int = 0
    prefix_text: str = ""  # normalized text of a reopened question
    prefix_segments: list[str] = field(default_factory=list)
    last_speech_end_ms: int = 0
    speech_active: bool = False
    pending_final_since: Optional[int] = None
    other_source_spoke: bool = False
    last_completed: Optional[tuple[str, int]] = None


@dataclass(frozen=True)
class Relationship:
    from_question_id: str
    to_question_id: str
    type: RelationshipType


class QuestionEngine:
    def __init__(
        self,
        session_id: str,
        vocabulary: TechnicalVocabulary,
        config: QuestionEngineConfig | None = None,
        id_factory: Callable[[], str] | None = None,
        question_sources: Iterable[AudioSource] | None = None,
    ) -> None:
        self.session_id = session_id
        self.vocab = vocabulary
        self.cfg = config or QuestionEngineConfig()
        self._new_id = id_factory or (lambda: "q_" + uuid.uuid4().hex[:16])
        self._sources = set(question_sources) if question_sources else None
        self.context = ConversationContext(self.cfg.context_size, self.cfg.follow_up_window_ms)
        self._tracker = SegmentTracker()
        self._segments: dict[str, TranscriptSegment] = {}
        self._norm_cache: dict[tuple[str, int], NormalizedText] = {}
        self.questions: "OrderedDict[str, Question]" = OrderedDict()
        self._question_norm: dict[str, str] = {}
        self._seg_to_questions: dict[str, set[str]] = {}
        self.relationships: list[Relationship] = []
        self._windows: dict[AudioSource, _Window] = {}

    # ================================================================ public API
    def ingest_segment(self, seg: TranscriptSegment) -> list[QuestionEvent]:
        if not self._tracker.accept(seg):
            return []  # retransmission, reconnect replay, or stale revision
        self._segments[seg.segment_id] = seg
        if self._sources is not None and seg.source not in self._sources:
            return []
        w = self._window(seg.source)
        events: list[QuestionEvent] = []
        w.last_speech_end_ms = max(w.last_speech_end_ms, seg.end_ms)
        w.other_source_spoke = False
        if seg.is_final and w.pending_final_since is not None and seg.end_ms >= w.pending_final_since - 500:
            w.pending_final_since = None

        owners = [qid for qid in self._seg_to_questions.get(seg.segment_id, ()) if qid != w.active_qid]
        if seg.segment_id not in w.segment_ids and seg.segment_id not in w.prefix_segments:
            if owners:
                # Late revision of a segment that belongs to an already completed question.
                for qid in owners:
                    events += self._rebuild_completed(qid, seg.end_ms)
                return events
            w.segment_ids.append(seg.segment_id)
            if len(w.segment_ids) > self.cfg.max_window_segments:
                self._force_trim(w)
        events += self._process_window(w, seg.end_ms)
        return events

    def on_speech_start(self, source: AudioSource, t_ms: int) -> list[QuestionEvent]:
        w = self._window(source)
        w.speech_active = True
        w.other_source_spoke = False
        events: list[QuestionEvent] = []
        for other in self._windows.values():
            if other is not w and other.active_qid:
                other.other_source_spoke = True
        if w.active_qid:
            q = self.questions[w.active_qid]
            if q.state is S.AWAITING_COMPLETION:
                events.append(self._set_state(q, S.QUESTION_IN_PROGRESS, ET.UPDATED))
        return events

    def on_speech_end(self, source: AudioSource, t_ms: int) -> list[QuestionEvent]:
        w = self._window(source)
        w.speech_active = False
        w.last_speech_end_ms = max(w.last_speech_end_ms, t_ms)
        w.pending_final_since = t_ms
        return []

    def tick(self, now_ms: int) -> list[QuestionEvent]:
        events: list[QuestionEvent] = []
        for w in list(self._windows.values()):
            silence = max(0, now_ms - w.last_speech_end_ms)
            if w.pending_final_since is not None and silence >= self.cfg.max_completion_timeout_ms:
                w.pending_final_since = None
            if w.active_qid:
                q = self.questions[w.active_qid]
                segs = [self._segments[s] for s in q.source_segment_ids if s in self._segments]
                decision = evaluate_completion(
                    self._question_part(q.formatted_text),
                    silence,
                    all_final=all(s.is_final for s in segs),
                    speech_active=w.speech_active,
                    pending_final=w.pending_final_since is not None,
                    other_source_spoke=w.other_source_spoke,
                    cfg=self.cfg,
                )
                events += self._apply_decision(w, q, decision, now_ms)
            elif w.segment_ids and not w.speech_active and silence >= self.cfg.non_question_flush_ms:
                if all(self._segments[s].is_final for s in w.segment_ids):
                    text, _ = self._window_text(w)
                    w.consumed = len(text)
                    self._trim(w)
        return events

    def window_state(self, source: AudioSource) -> S:
        w = self._windows.get(source)
        if w is None:
            return S.IDLE
        if w.active_qid:
            return self.questions[w.active_qid].state
        return S.SPEECH_DETECTED if (w.speech_active or w.segment_ids) else S.IDLE

    # ---------------------------------------------------------- manual actions
    def edit_question(self, qid: str, text: str, now_ms: int, editor: str = "user") -> list[QuestionEvent]:
        q = self._require(qid)
        new_text = collapse_ws(text)
        if not new_text:
            raise ValueError("question text must not be empty")
        q.edit_history.append({"at_ms": now_ms, "before": q.formatted_text, "after": new_text, "editor": editor})
        q.formatted_text = new_text
        q.resolved_text = None
        q.subquestions = []
        entities = self.vocab.find_entities(new_text)
        q.category = classify(new_text, q.kind, entities).category
        self._detach(qid)
        if q.ended_at_ms is None:
            q.ended_at_ms = self._end_ms(q)
        self.context.remove(qid)
        self.context.add(qid, new_text, entities, q.category.value, q.ended_at_ms or now_ms)
        return [self._set_state(q, S.MANUALLY_EDITED, ET.REVISED, force_event=True)]

    def discard_question(self, qid: str) -> list[QuestionEvent]:
        q = self._require(qid)
        self._detach(qid)
        self.context.remove(qid)
        return [self._set_state(q, S.DISCARDED, ET.DISCARDED, force_event=True)]

    def discard_all(self) -> list[QuestionEvent]:
        """Discard every question of the session at once (the user's "Clear"), one being spoken included.

        Discarded questions take no part in duplicate detection or context, so a question that is
        asked again afterwards is picked up as new.
        """
        events: list[QuestionEvent] = []
        for qid, q in list(self.questions.items()):
            if q.state is not S.DISCARDED:
                events += self.discard_question(qid)
        return events

    def set_saved(self, qid: str, saved: bool) -> list[QuestionEvent]:
        q = self._require(qid)
        q.saved = saved
        q.revision += 1
        return [QuestionEvent(ET.UPDATED, copy.deepcopy(q))]

    def merge_questions(self, qids: list[str], now_ms: int) -> list[QuestionEvent]:
        qs = sorted((self._require(i) for i in dict.fromkeys(qids)), key=lambda q: q.started_at_ms)
        if len(qs) < 2:
            raise ValueError("merge needs at least two questions")
        if any(q.state in OPEN_STATES for q in qs):
            raise ValueError("cannot merge a question that is still in progress")
        target, others = qs[0], qs[1:]
        parts = [q.display_text for q in qs]
        target.edit_history.append({"at_ms": now_ms, "before": target.formatted_text, "after": " ".join(parts), "editor": "merge"})
        target.formatted_text = " ".join(parts)
        target.resolved_text = None
        target.raw_text = " ".join(q.raw_text for q in qs)
        target.subquestions = parts
        target.kind = QuestionKind.MULTI_PART
        target.source_segment_ids = list(dict.fromkeys(s for q in qs for s in q.source_segment_ids))
        target.ended_at_ms = max((q.ended_at_ms or q.started_at_ms) for q in qs)
        for s in target.source_segment_ids:
            self._seg_to_questions.setdefault(s, set()).add(target.question_id)
        events = [self._set_state(target, S.MANUALLY_EDITED if target.state is S.MANUALLY_EDITED else S.REVISED, ET.REVISED, force_event=True)]
        for o in others:
            self.relationships.append(Relationship(target.question_id, o.question_id, RelationshipType.MERGED_FROM))
            self.context.remove(o.question_id)
            events.append(self._set_state(o, S.DISCARDED, ET.DISCARDED, force_event=True))
        return events

    def split_question(self, qid: str, at: int, now_ms: int) -> list[QuestionEvent]:
        q = self._require(qid)
        if q.state in OPEN_STATES:
            raise ValueError("cannot split a question that is still in progress")
        text = q.formatted_text
        first, second = text[:at].strip(), text[at:].strip()
        if not first or not second:
            raise ValueError("split position must leave text on both sides")
        first, second = format_question(first), format_question(second)
        q.edit_history.append({"at_ms": now_ms, "before": text, "after": first, "editor": "split"})
        q.formatted_text, q.resolved_text, q.subquestions = first, None, []
        events = [self._set_state(q, S.MANUALLY_EDITED if q.state is S.MANUALLY_EDITED else S.REVISED, ET.REVISED, force_event=True)]
        new = self._new_question(
            second, q.raw_text, q.source_segment_ids, q.started_at_ms, q.source,
            detect_candidate(second), state_path=(S.QUESTION_IN_PROGRESS, S.COMPLETE),
        )
        new.ended_at_ms = q.ended_at_ms
        self.relationships.append(Relationship(new.question_id, q.question_id, RelationshipType.SPLIT_FROM))
        events.append(QuestionEvent(ET.CREATED, copy.deepcopy(new)))
        return events

    def create_manual(self, text: str, now_ms: int) -> list[QuestionEvent]:
        norm = normalize_transcript(text).text
        if not norm:
            raise ValueError("question text must not be empty")
        q = self._new_question(norm, text, [], now_ms, AudioSource.MANUAL, detect_candidate(norm), state_path=(S.QUESTION_IN_PROGRESS,))
        q.ended_at_ms = now_ms
        transition(q.state, S.COMPLETE)
        q.state = S.COMPLETE
        q.confidence.boundary = 1.0
        self._add_to_context(q)
        return [QuestionEvent(ET.CREATED, copy.deepcopy(q))]

    def restore(self, questions: Iterable[Question]) -> None:
        """Seed state after an engine restart so context and dedupe survive recovery."""
        for q in sorted(questions, key=lambda q: q.started_at_ms):
            self.questions[q.question_id] = q
            for s in q.source_segment_ids:
                self._seg_to_questions.setdefault(s, set()).add(q.question_id)
            if q.state in (S.COMPLETE, S.REVISED, S.MANUALLY_EDITED):
                self._add_to_context(q)

    # ================================================================ internals
    def _window(self, source: AudioSource) -> _Window:
        if source not in self._windows:
            self._windows[source] = _Window(source)
        return self._windows[source]

    def _require(self, qid: str) -> Question:
        q = self.questions.get(qid)
        if q is None:
            raise KeyError(qid)
        return q

    def _norm(self, sid: str) -> NormalizedText:
        seg = self._segments[sid]
        key = (sid, seg.revision)
        n = self._norm_cache.get(key)
        if n is None:
            n = normalize_transcript(seg.text)
            self._norm_cache[key] = n
            if len(self._norm_cache) > 4096:
                for k in list(self._norm_cache)[:2048]:
                    del self._norm_cache[k]
        return n

    def _window_text(self, w: _Window) -> tuple[str, list[tuple[str, int, int]]]:
        parts: list[str] = []
        spans: list[tuple[str, int, int]] = []
        pos = 0
        for sid in w.segment_ids:
            t = self._norm(sid).text
            if parts:
                pos += 1
            spans.append((sid, pos, pos + len(t)))
            parts.append(t)
            pos += len(t)
        return " ".join(parts), spans

    def _trim(self, w: _Window) -> None:
        """Drop finalized segments that are fully consumed from the window front."""
        while w.segment_ids:
            sid = w.segment_ids[0]
            if sid == (self.questions[w.active_qid].source_segment_ids[0] if w.active_qid and self.questions[w.active_qid].source_segment_ids else None):
                break
            n = len(self._norm(sid).text) + (1 if len(w.segment_ids) > 1 else 0)
            if not self._segments[sid].is_final or n > w.consumed:
                break
            w.consumed -= n
            w.segment_ids.pop(0)
        if not w.segment_ids:
            w.consumed = 0

    def _force_trim(self, w: _Window) -> None:
        while len(w.segment_ids) > self.cfg.max_window_segments:
            sid = w.segment_ids.pop(0)
            n = len(self._norm(sid).text) + 1
            w.consumed = max(0, w.consumed - n)

    @staticmethod
    def _analyze(utts: list[Utterance]) -> list[_Group]:
        groups: list[_Group] = []
        current: Optional[_Group] = None
        last_terminal = ""
        scenario: list[Utterance] = []
        for u in utts:
            sig = detect_candidate(u.text)
            if current is None:
                if sig.is_candidate:
                    start = scenario[0].start if scenario else u.start
                    current = _Group(start, u.end, sig, False)
                    scenario = []
                elif sig.is_scenario_context or (scenario and len(scenario) < 4):
                    scenario.append(u)
                else:
                    scenario = []
            else:
                complete = last_terminal in ("?", ".", "!") and not _dangling(utts, current)
                if is_continuation(u.text) or not complete or (sig.is_candidate and refers_back(u.text)):
                    # A candidate that refers back ("why would you use it") within continuous
                    # speech is another part of the same question, not a new one.
                    current.end = u.end
                elif sig.is_candidate:
                    current.closed = True
                    groups.append(current)
                    current = _Group(u.start, u.end, sig, False)
                else:
                    current.closed = True
                    groups.append(current)
                    current = None
                    scenario = [u] if sig.is_scenario_context else []
            last_terminal = u.terminal
        if current is not None:
            groups.append(current)
        return groups

    def _process_window(self, w: _Window, now_ms: int) -> list[QuestionEvent]:
        text, spans = self._window_text(w)
        w.consumed = min(w.consumed, len(text))
        utts = [Utterance(u.text, u.start + w.consumed, u.end + w.consumed, u.terminal) for u in split_utterances(text[w.consumed :])]
        groups = self._analyze(utts)
        events: list[QuestionEvent] = []

        if not groups:
            if w.active_qid and not w.prefix_text:
                q = self.questions[w.active_qid]
                if q.state in OPEN_STATES:
                    w.active_qid = None
                    events.append(self._set_state(q, S.DISCARDED, ET.DISCARDED, force_event=True))
            return events

        for gi, g in enumerate(groups):
            seg_ids = [sid for sid, a, b in spans if a < g.end and b > g.start]
            gtext = text[g.start : g.end]
            if gi == 0 and w.active_qid is None and w.last_completed and is_continuation(gtext):
                qid, at = w.last_completed
                prev = self.questions.get(qid)
                if prev and prev.state in (S.COMPLETE, S.REVISED) and now_ms - at <= self.cfg.continuation_window_ms:
                    w.active_qid = qid
                    w.prefix_text = self._question_norm[qid]
                    w.prefix_segments = list(prev.source_segment_ids)
                    self.context.remove(qid)
            if gi == 0 and w.active_qid is not None:
                q = self.questions[w.active_qid]
                full_text = (w.prefix_text + " " + gtext).strip() if w.prefix_text else gtext
                full_segs = list(dict.fromkeys(w.prefix_segments + seg_ids))
                events += self._update_open(w, q, full_text, full_segs, now_ms)
                w.active_end = g.end
            else:
                events += self._create_open(w, gtext, seg_ids, g.first_signal, now_ms)
                if w.active_qid is None:  # duplicate of a completed question: skip it
                    w.consumed = g.end
                    continue
                w.active_end = g.end
            if g.closed and w.active_qid:
                q = self.questions[w.active_qid]
                events += self._complete(w, q, CompletionDecision(CompletionState.COMPLETE, 0.85, "followed by new utterance"), now_ms)
        return events

    def _create_open(self, w: _Window, text: str, seg_ids: list[str], signal: CandidateSignal, now_ms: int) -> list[QuestionEvent]:
        segs = [self._segments[s] for s in seg_ids]
        start = min(s.start_ms for s in segs)
        end = max(s.end_ms for s in segs)
        raw = " ".join(s.text.strip() for s in segs)
        fields = self._compose(text, seg_ids, exclude_id=None, now_ms=now_ms)
        recent = list(self.questions.values())[-self.cfg.dedupe_recent_questions :]
        dup = check_duplicate(fields["formatted_text"], start, end, reversed(recent), self.cfg.duplicate_similarity)
        if dup.duplicate_of:
            existing = self.questions[dup.duplicate_of]
            if existing.state in OPEN_STATES:
                w.active_qid = existing.question_id
                return self._update_open(w, existing, text, list(dict.fromkeys(existing.source_segment_ids + seg_ids)), now_ms)
            w.active_qid = None
            return []
        path = (S.QUESTION_IN_PROGRESS,) if signal.score >= 0.75 else ()
        q = self._new_question(text, raw, seg_ids, start, w.source, signal, state_path=path, fields=fields)
        if dup.repeat_of:
            q.repeat_of = dup.repeat_of
            self.relationships.append(Relationship(q.question_id, dup.repeat_of, RelationshipType.REPEAT_OF))
        w.active_qid = q.question_id
        w.prefix_text, w.prefix_segments = "", []
        return [QuestionEvent(ET.CREATED, copy.deepcopy(q))]

    def _update_open(self, w: _Window, q: Question, text: str, seg_ids: list[str], now_ms: int) -> list[QuestionEvent]:
        if q.state in LOCKED_STATES:
            return []
        fields = self._compose(text, seg_ids, exclude_id=q.question_id, now_ms=now_ms)
        segs = [self._segments[s] for s in seg_ids if s in self._segments]
        fields["raw_text"] = " ".join(s.text.strip() for s in segs)
        fields["source_segment_ids"] = seg_ids
        changed = self._apply_fields(q, fields)
        self._question_norm[q.question_id] = text
        for s in seg_ids:
            self._seg_to_questions.setdefault(s, set()).add(q.question_id)
        target = q.state
        if q.state is S.CANDIDATE and detect_candidate(text).score >= 0.75:
            target = S.QUESTION_IN_PROGRESS
        elif q.state is S.AWAITING_COMPLETION:
            target = S.QUESTION_IN_PROGRESS
        elif q.state is S.COMPLETE:  # reopened continuation
            target = S.REVISED
        if target is not q.state:
            return [self._set_state(q, target, ET.REVISED if target is S.REVISED else ET.UPDATED, force_event=True)]
        if changed:
            q.revision += 1
            return [QuestionEvent(ET.REVISED if q.state is S.REVISED else ET.UPDATED, copy.deepcopy(q))]
        return []

    def _apply_decision(self, w: _Window, q: Question, d: CompletionDecision, now_ms: int) -> list[QuestionEvent]:
        if d.state is CompletionState.COMPLETE:
            return self._complete(w, q, d, now_ms)
        if d.state is CompletionState.AWAITING and q.state is S.QUESTION_IN_PROGRESS:
            return [self._set_state(q, S.AWAITING_COMPLETION, ET.UPDATED)]
        if d.state is CompletionState.AWAITING and q.state is S.CANDIDATE:
            return [self._set_state(q, S.QUESTION_IN_PROGRESS, ET.UPDATED)]
        return []

    def _complete(self, w: _Window, q: Question, d: CompletionDecision, now_ms: int) -> list[QuestionEvent]:
        if q.state is S.CANDIDATE:
            q.state = transition(q.state, S.QUESTION_IN_PROGRESS)
        if q.state not in (S.QUESTION_IN_PROGRESS, S.AWAITING_COMPLETION, S.REVISED):
            return []
        q.ended_at_ms = self._end_ms(q)
        q.confidence.boundary = d.boundary_confidence
        if d.possibly_incomplete:
            self._add_review(q, f"question may be incomplete ({d.reason})")
        w.consumed = max(w.consumed, w.active_end)
        w.active_qid = None
        w.prefix_text, w.prefix_segments = "", []
        w.last_completed = (q.question_id, now_ms)
        w.other_source_spoke = False
        self._add_to_context(q)
        self._trim(w)
        return [self._set_state(q, S.COMPLETE, ET.COMPLETED, force_event=True)]

    def _rebuild_completed(self, qid: str, now_ms: int) -> list[QuestionEvent]:
        q = self.questions[qid]
        if q.state in LOCKED_STATES or q.state in OPEN_STATES:
            return []
        segs = [self._segments[s] for s in q.source_segment_ids if s in self._segments]
        text = " ".join(self._norm(s.segment_id).text for s in segs)
        fields = self._compose(text, q.source_segment_ids, exclude_id=qid, now_ms=now_ms)
        fields["raw_text"] = " ".join(s.text.strip() for s in segs)
        if not self._apply_fields(q, fields):
            return []
        self._question_norm[qid] = text
        self.context.remove(qid)
        self._add_to_context(q)
        return [self._set_state(q, S.REVISED, ET.REVISED, force_event=True)]

    def _new_question(
        self,
        text: str,
        raw: str,
        seg_ids: list[str],
        start_ms: int,
        source: AudioSource,
        signal: CandidateSignal,
        state_path: tuple[S, ...] = (),
        fields: dict | None = None,
    ) -> Question:
        qid = self._new_id()
        fields = fields or self._compose(text, seg_ids, exclude_id=qid, now_ms=start_ms)
        state = S.CANDIDATE
        for target in state_path:
            state = transition(state, target)
        segs = [self._segments[s] for s in seg_ids if s in self._segments]
        speakers = {s.speaker for s in segs}
        q = Question(
            question_id=qid,
            session_id=self.session_id,
            state=state,
            revision=1,
            raw_text=raw,
            source_segment_ids=list(seg_ids),
            started_at_ms=start_ms,
            ended_at_ms=None,
            source=source,
            speaker=speakers.pop() if len(speakers) == 1 else "unknown",
            **{k: v for k, v in fields.items() if k not in ("raw_text", "source_segment_ids")},
        )
        self.questions[qid] = q
        self._question_norm[qid] = text
        for s in seg_ids:
            self._seg_to_questions.setdefault(s, set()).add(qid)
        return q

    def _compose(self, text: str, seg_ids: list[str], exclude_id: Optional[str], now_ms: int) -> dict:
        """Run vocabulary -> syntax -> math -> multipart -> format -> classify -> context."""
        scenario_raw, qtext = _split_scenario(text)
        active = self.context.active_domains()
        subs: list[Substitution] = []
        reasons: list[str] = []
        for sid in seg_ids:
            if sid in self._segments:
                n = self._norm(sid)
                subs += n.substitutions
                reasons += n.review_reasons

        v = self.vocab.normalize(qtext, active, extra_context=scenario_raw or "")
        subs += v.substitutions
        scen_text = None
        if scenario_raw:
            sv = self.vocab.normalize(scenario_raw, active, extra_context=qtext)
            subs += sv.substitutions
            scen_text = _format_scenario(sv.text)
        domains = {d for e in v.entities for d in e.domains} | active
        code_ctx = has_code_context(v.text) or bool(domains & _PROGRAMMING_DOMAINS)
        sx = normalize_code_syntax(v.text, code_context=code_ctx, java_like=bool({"JAVA", "CSHARP", "TYPESCRIPT"} & domains) or None)
        subs += sx.substitutions
        mx = normalize_math(sx.text)
        subs += mx.substitutions
        reasons += mx.review_reasons
        qfinal = mx.text

        signal = detect_candidate(qfinal)
        kind = signal.kind
        if scen_text and kind is not QuestionKind.BEHAVIORAL:
            kind = QuestionKind.SCENARIO
        elif mx.found and kind in (QuestionKind.DIRECT, QuestionKind.IMPERATIVE):
            kind = QuestionKind.MATH
        # Sub-questions: split each sentence at clause boundaries; separate sentences are parts too.
        parts: list[str] = []
        unpaused = re.sub(r"(?:\.\.\.|…)\s+(?=\S)", " ", qfinal)  # spoken "..." pauses are not sentence ends
        for sentence in split_utterances(unpaused):
            parts += split_multipart(sentence.text) or [sentence.text]
        if len(parts) < 2:
            parts = []
        subquestions = [format_subquestion(p) for p in parts]
        if parts and kind is not QuestionKind.SCENARIO:
            kind = QuestionKind.MULTI_PART

        formatted_q = format_question(qfinal, signal)
        formatted = f"{scen_text} {formatted_q}" if scen_text else formatted_q
        entities = self.vocab.find_entities(formatted)
        q_entities = self.vocab.find_entities(formatted_q)
        res = self.context.resolve(formatted_q, q_entities, now_ms, exclude_id=exclude_id)
        resolved = None
        if res.resolved_text:
            resolved = f"{scen_text} {res.resolved_text}" if scen_text else res.resolved_text
        basis = resolved or formatted
        cls = classify(basis, kind, self.vocab.find_entities(basis) if resolved else entities)
        if cls.category is QuestionCategory.GENERAL and res.parent_category and res.parent_category != "GENERAL":
            cls = type(cls)(QuestionCategory(res.parent_category), 0.5)
        if res.needs_review:
            reasons += res.reasons

        segs = [self._segments[s] for s in seg_ids if s in self._segments]
        confs = [s.confidence for s in segs if s.confidence is not None]
        transcription = round(sum(confs) / len(confs), 3) if confs else None
        if transcription is not None and transcription < self.cfg.low_transcription_confidence:
            reasons.append(f"low transcription confidence ({transcription:.2f})")
        raw = " ".join(s.text.strip() for s in segs)
        uncertain = _uncertain_spans(raw, segs, self.cfg.uncertain_word_probability)

        return {
            "formatted_text": formatted,
            "resolved_text": resolved,
            "kind": kind,
            "category": cls.category,
            "subquestions": subquestions,
            "scenario": scen_text,
            "substitutions": [s for s in subs if s.rule not in ("filler",)],
            "math_latex": mx.latex,
            "review_reasons": list(dict.fromkeys(reasons)),
            "needs_review": bool(reasons),
            "parent_question_id": res.parent_question_id,
            "uncertain_spans": uncertain,
            "confidence": Confidence(
                transcription=transcription,
                classification=cls.confidence,
                boundary=None,
                context_resolution=res.confidence,
                normalization=round(min((s.confidence for s in subs if s.rule != "filler"), default=1.0), 3) if any(s.rule != "filler" for s in subs) else None,
            ),
        }

    @staticmethod
    def _apply_fields(q: Question, fields: dict) -> bool:
        changed = False
        for k, v in fields.items():
            if k == "confidence":
                v.boundary = q.confidence.boundary
            if getattr(q, k) != v:
                setattr(q, k, v)
                if k not in ("confidence", "substitutions", "uncertain_spans"):
                    changed = True
        if fields.get("parent_question_id") and q.parent_question_id:
            pass
        return changed

    def _set_state(self, q: Question, target: S, event: ET, force_event: bool = False) -> QuestionEvent:
        if q.state is not target:
            q.state = transition(q.state, target)
        q.revision += 1
        return QuestionEvent(event, copy.deepcopy(q))

    def _detach(self, qid: str) -> None:
        for w in self._windows.values():
            if w.active_qid == qid:
                w.consumed = max(w.consumed, w.active_end)
                w.active_qid = None
                w.prefix_text, w.prefix_segments = "", []
                self._trim(w)

    def _end_ms(self, q: Question) -> int:
        ends = [self._segments[s].end_ms for s in q.source_segment_ids if s in self._segments]
        return max(ends) if ends else q.started_at_ms

    def _add_to_context(self, q: Question) -> None:
        text = self._question_part(q.display_text)
        self.context.add(q.question_id, text, self.vocab.find_entities(text), q.category.value, q.ended_at_ms or q.started_at_ms)
        if q.parent_question_id and not any(
            r.from_question_id == q.question_id and r.type is RelationshipType.FOLLOW_UP for r in self.relationships
        ):
            self.relationships.append(Relationship(q.question_id, q.parent_question_id, RelationshipType.FOLLOW_UP))

    def _question_part(self, formatted: str) -> str:
        """Formatted text without a leading scenario description."""
        utts = split_utterances(formatted)
        for i, u in enumerate(utts):
            if detect_candidate(u.text).is_candidate:
                return " ".join(x.text for x in utts[i:])
        return formatted

    @staticmethod
    def _add_review(q: Question, reason: str) -> None:
        if reason not in q.review_reasons:
            q.review_reasons.append(reason)
        q.needs_review = True


# ---------------------------------------------------------------- helpers

def _dangling(utts: list[Utterance], group: _Group) -> bool:
    from .text import ends_dangling

    last = next((u for u in reversed(utts) if u.end <= group.end), None)
    return bool(last) and ends_dangling(last.text)


def _split_scenario(text: str) -> tuple[Optional[str], str]:
    utts = split_utterances(text)
    if len(utts) < 2:
        return None, text
    for i, u in enumerate(utts):
        sig = detect_candidate(u.text)
        if sig.is_candidate:
            if i == 0:
                return None, text
            return " ".join(x.text for x in utts[:i]), " ".join(x.text for x in utts[i:])
    return None, text


def _format_scenario(text: str) -> str:
    sentences = split_utterances(collapse_ws(text))
    out = []
    for s in sentences:
        core = capitalize_first(strip_terminal_punct(s.text))
        if core:
            out.append(core + ".")
    return " ".join(out)


def _uncertain_spans(raw: str, segs: list[TranscriptSegment], threshold: float) -> list[Span]:
    spans: list[Span] = []
    pos = 0
    lowered = raw.lower()
    for s in segs:
        for w in s.words:
            token = w.text.strip().lower().strip(",.?!")
            if not token:
                continue
            idx = lowered.find(token, pos)
            if idx < 0:
                continue
            pos = idx + len(token)
            if w.probability is not None and w.probability < threshold:
                spans.append(Span(idx, idx + len(token), f"low STT confidence ({w.probability:.2f})"))
    return spans
