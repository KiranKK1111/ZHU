"""Lightweight conversation context manager (Master Prompt 01, section 6).

It resolves references such as "it", "that", "them", and "what about X" against the
most recent completed question. The context is bounded, and a reference is never
rewritten when its referent is uncertain. The original wording is always kept,
because the resolved text is stored separately.
"""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

from .text import strip_terminal_punct
from .vocabulary import Entity

_LANG_QUALIFIER = re.compile(
    r"\b(?:in|using|with)\s+(Java|JavaScript|TypeScript|Python|C#|C\+\+|Kotlin|Go|Rust|Spring Boot|React|Node\.js|SQL|PostgreSQL|MySQL|MongoDB|\.NET)(?![\w])"
)
_LANG_MENTION = re.compile(
    r"(?<![\w])(?:Java|JavaScript|TypeScript|Python|C#|C\+\+|Kotlin|Go|Rust|Spring Boot|Spring|React|Node\.js|SQL|PostgreSQL|MySQL|MongoDB|\.NET)(?![\w])"
)
_PRIMARY_PATTERNS = [
    re.compile(r"^(?:what|who)\s+(?:is|are|was|were)\s+(?P<art>a\s+|an\s+|the\s+)?(?P<np>.+?)(?=\s+(?:in|on|for|and|with|used|when|compared)\b|[?.!,]|$)", re.IGNORECASE),
    re.compile(r"^(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:explain|describe|define)\s+(?:what\s+)?(?P<art>a\s+|an\s+|the\s+)?(?P<np>.+?)(?=\s+(?:is|are|in|on|for|and|with|works?)\b|[?.!,]|$)", re.IGNORECASE),
    re.compile(r"^how\s+(?:does|do|is|are)\s+(?P<art>a\s+|an\s+|the\s+)?(?P<np>.+?)\s+(?:work|works|implemented|handled|managed)\b", re.IGNORECASE),
]
_SINGULAR = re.compile(
    r"\bit\b(?!'s\s+(?:possible|true|necessary|better|good|okay|ok|fine)\b)|"
    r"\b(?:that|this)\b(?=\s*[?.!,]|\s*$|\s+(?:is|works?|differs?|different|compares?|one|approach|better|faster)\b)",
    re.IGNORECASE,
)
_EXPLETIVE_IT = re.compile(r"\b(?:is|was|would|will)\s+it\s+(?:possible|true|necessary|better|good|okay|ok|fine|a good idea)\b", re.IGNORECASE)
_PLURAL = re.compile(r"\b(?:them|they)\b|\b(?:those|these)\b(?=\s*[?.!,]|\s*$|\s+(?:are|differ|compare|work)\b)", re.IGNORECASE)
_CLAUSE_BOUNDARY = re.compile(r"[,;?]|\b(?:and|or|but|then)\b", re.IGNORECASE)
_WHAT_ABOUT = re.compile(r"^(?:and\s+)?(?:what|how)\s+about\s+(?P<x>.+?)\s*[?.!]*$", re.IGNORECASE)
_FOLLOW_UP_MARKERS = re.compile(
    r"\b(?:same\s+approach|previous\s+(?:example|question|answer)|above\s+(?:solution|example|approach|code)|"
    r"another\s+way|instead\s+of\s+(?:that|this|it)|the\s+previous\s+one|in\s+that\s+case|follow[- ]up|"
    r"(?:that|this)\s+approach)\b",
    re.IGNORECASE,
)


@dataclass
class ContextEntry:
    question_id: str
    text: str
    entities: list[str]
    primary: Optional[str]
    language: Optional[str]
    category: str
    ended_at_ms: int
    primary_phrase: Optional[str] = None  # primary with its article ("a microservice"), used for rewrites


@dataclass
class Resolution:
    resolved_text: Optional[str] = None
    parent_question_id: Optional[str] = None
    parent_category: Optional[str] = None
    confidence: Optional[float] = None
    reasons: list[str] = field(default_factory=list)
    needs_review: bool = False


def extract_primary(text: str, entities: list[Entity]) -> Optional[str]:
    return extract_primary_phrase(text, entities)[0]


def extract_primary_phrase(text: str, entities: list[Entity]) -> tuple[Optional[str], Optional[str]]:
    """(subject without article, subject as spoken with its article)."""
    core = text.strip()
    for rx in _PRIMARY_PATTERNS:
        m = rx.match(core)
        if m:
            np = m.group("np").strip()
            if 0 < len(np.split()) <= 4:
                return np, ((m.group("art") or "") + np).strip()
    distinct = list(dict.fromkeys(e.canonical for e in entities))
    return (distinct[0], distinct[0]) if len(distinct) == 1 else (None, None)


class ConversationContext:
    def __init__(self, max_entries: int = 8, follow_up_window_ms: int = 180_000) -> None:
        self._entries: deque[ContextEntry] = deque(maxlen=max_entries)
        self.follow_up_window_ms = follow_up_window_ms

    def add(self, question_id: str, text: str, entities: list[Entity], category: str, ended_at_ms: int) -> None:
        lang = _LANG_QUALIFIER.search(text)
        primary, phrase = extract_primary_phrase(text, entities)
        self._entries.append(
            ContextEntry(
                question_id=question_id,
                text=text,
                entities=list(dict.fromkeys(e.canonical for e in entities)),
                primary=primary,
                language=lang.group(1) if lang else None,
                primary_phrase=phrase,
                category=category,
                ended_at_ms=ended_at_ms,
            )
        )

    def remove(self, question_id: str) -> None:
        self._entries = deque((e for e in self._entries if e.question_id != question_id), maxlen=self._entries.maxlen)

    def active_domains(self, last_n: int = 3) -> set[str]:
        return {e.category for e in list(self._entries)[-last_n:]}

    def recent(self) -> list[ContextEntry]:
        return list(self._entries)

    def resolve(self, text: str, entities: list[Entity], now_ms: int, exclude_id: Optional[str] = None) -> Resolution:
        res = Resolution()
        prev = next(
            (e for e in reversed(self._entries) if e.question_id != exclude_id and now_ms - e.ended_at_ms <= self.follow_up_window_ms),
            None,
        )
        what_about = _WHAT_ABOUT.match(text.strip())
        singular = [m for m in _SINGULAR.finditer(text) if not (m.group(0).lower() == "it" and _EXPLETIVE_IT.search(text))]
        plural = list(_PLURAL.finditer(text))
        marker = _FOLLOW_UP_MARKERS.search(text)
        if not (what_about or singular or plural or marker):
            return res

        # An antecedent inside the question itself ("What is a microservice, and why use it?"):
        # substantive content followed by a clause boundary before the pronoun.
        first_ref = min([m.start() for m in singular + plural] or [len(text)])
        before = text[:first_ref]
        clause = _CLAUSE_BOUNDARY.search(before)
        if clause and len(before[: clause.start()].split()) >= 2 and not what_about:
            res.reasons.append("reference resolved within the question")
            return res

        if prev is None:
            # Only a pronoun near the start makes the question depend on missing context.
            early = len(before.split()) <= 4
            res.reasons.append("unresolved reference: no previous question in context")
            res.needs_review = bool(singular or plural) and early
            res.confidence = 0.0 if res.needs_review else None
            return res

        res.parent_question_id = prev.question_id
        res.parent_category = prev.category

        if what_about and prev.primary and prev.primary in prev.text:
            x = strip_terminal_punct(what_about.group("x"))
            target = prev.primary_phrase if prev.primary_phrase and prev.primary_phrase in prev.text else prev.primary
            resolved = prev.text.replace(target, x, 1)
            res.resolved_text = resolved
            res.confidence = 0.7
            res.reasons.append(f"'what about' substituted '{x}' for '{prev.primary}'")
            return res

        if singular and plural:
            res.confidence = 0.3
            res.reasons.append("ambiguous reference: mixed singular and plural pronouns")
            res.needs_review = True
            return res

        if singular:
            if len(singular) > 1 and len({m.group(0).lower() for m in singular}) > 1:
                res.confidence = 0.3
                res.reasons.append("ambiguous reference: several different pronouns")
                res.needs_review = True
                return res
            referent = prev.primary
            if referent is None or (len(prev.entities) > 1 and prev.primary not in prev.entities and len(prev.primary.split()) > 3):
                res.confidence = 0.3
                res.reasons.append("ambiguous reference: previous question has no single clear subject")
                res.needs_review = True
                return res
            resolved = _replace_spans(text, singular, prev.primary_phrase or referent)
            conf = 0.8
        elif plural:
            subjects = [e for e in prev.entities if not _LANG_MENTION.fullmatch(e) and e != prev.language]
            if len(subjects) < 2:
                res.confidence = 0.3
                res.reasons.append("ambiguous reference: plural pronoun but previous question has one subject")
                res.needs_review = True
                return res
            referent = " and ".join(subjects) if len(subjects) <= 3 else None
            if referent is None:
                res.confidence = 0.3
                res.needs_review = True
                res.reasons.append("ambiguous reference: too many candidate referents")
                return res
            resolved = _replace_spans(text, plural, referent)
            conf = 0.7
        else:
            # Only a follow-up marker ("another way") — relationship without rewrite.
            res.confidence = 0.6
            res.reasons.append(f"follow-up marker '{marker.group(0)}'")
            return res

        if prev.language and not _LANG_MENTION.search(resolved):
            core = strip_terminal_punct(resolved)
            tail = resolved[len(core) :]
            resolved = f"{core} in {prev.language}{tail}"
            conf -= 0.05
            res.reasons.append(f"carried over qualifier 'in {prev.language}'")
        res.resolved_text = resolved
        res.confidence = round(conf, 2)
        res.reasons.append(f"resolved reference to '{referent}'")
        return res


def _replace_spans(text: str, matches: list[re.Match[str]], referent: str) -> str:
    out, pos = [], 0
    for m in matches:
        out.append(text[pos : m.start()])
        out.append(referent)
        pos = m.end()
    out.append(text[pos:])
    return "".join(out)
