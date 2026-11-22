"""Context-sensitive technical vocabulary normalization (Master Prompt 01, section 7).

An alias is replaced only when either
* the entry has no ``context`` list, meaning the alias is distinctive ("spring boot"), or
* at least one of its context words appears in the same utterance, or
* one of its ``context_domains`` is active in the conversation.

A substitution is never applied just because a term is in the dictionary.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Iterable, Optional

from .types import Substitution


@dataclass(frozen=True)
class VocabEntry:
    canonical: str
    aliases: tuple[str, ...]
    domains: tuple[str, ...]
    context: Optional[tuple[str, ...]] = None
    context_domains: tuple[str, ...] = ()
    user_defined: bool = False


@dataclass(frozen=True)
class Entity:
    canonical: str
    domains: tuple[str, ...]
    start: int
    end: int


@dataclass
class VocabResult:
    text: str
    substitutions: list[Substitution] = field(default_factory=list)
    entities: list[Entity] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # aliases seen but not applied (no context)


def _alias_pattern(alias: str) -> str:
    parts = [re.escape(p) for p in alias.split()]
    return r"[\s-]+".join(parts)


def _contains_phrase(haystack: str, phrase: str) -> bool:
    return re.search(r"(?<![\w])" + _alias_pattern(phrase.lower()) + r"(?![\w])", haystack) is not None


class TechnicalVocabulary:
    def __init__(self, entries: Iterable[VocabEntry]) -> None:
        self._entries: list[VocabEntry] = list(entries)
        self._by_alias: dict[str, VocabEntry] = {}
        for e in self._entries:
            for a in e.aliases:
                self._by_alias[" ".join(a.lower().split())] = e
        aliases = sorted(self._by_alias, key=len, reverse=True)
        body = "|".join(_alias_pattern(a) for a in aliases) or r"(?!x)x"
        # Boundaries: do not match inside identifiers ("javascript" must not match "java").
        self._regex = re.compile(r"(?<![\w#+])(?:" + body + r")(?![\w#+])", re.IGNORECASE)

    # ------------------------------------------------------------------ loading
    @classmethod
    def load(cls, user_file: Optional[Path] = None) -> "TechnicalVocabulary":
        builtin = json.loads(
            resources.files("zhu_engine.questions").joinpath("data/vocabulary.json").read_text("utf-8")
        )
        entries = [cls._entry_from_dict(d) for d in builtin["terms"]]
        if user_file is not None and user_file.exists():
            entries = cls.merge_user_entries(entries, json.loads(user_file.read_text("utf-8")).get("terms", []))
        return cls(entries)

    @staticmethod
    def _entry_from_dict(d: dict, user: bool = False) -> VocabEntry:
        ctx = d.get("context")
        return VocabEntry(
            canonical=str(d["canonical"]),
            aliases=tuple(str(a) for a in d.get("aliases", []) if str(a).strip()),
            domains=tuple(d.get("domains", ["GENERAL"])),
            context=tuple(str(c).lower() for c in ctx) if ctx else None,
            context_domains=tuple(d.get("context_domains", [])),
            user_defined=user,
        )

    @classmethod
    def merge_user_entries(cls, builtin: list[VocabEntry], user_terms: list[dict]) -> list[VocabEntry]:
        """User entries override built-ins with the same canonical form; ``disabled`` removes them."""
        result = list(builtin)
        for d in user_terms:
            key = str(d.get("canonical", "")).lower()
            if not key:
                continue
            # A user entry replaces every built-in entry with the same canonical form.
            result = [e for e in result if e.canonical.lower() != key]
            if not d.get("disabled"):
                result.append(cls._entry_from_dict(d, user=True))
        return result

    @property
    def entries(self) -> list[VocabEntry]:
        return list(self._entries)

    # ------------------------------------------------------------------ matching
    def normalize(
        self,
        text: str,
        active_domains: Iterable[str] = (),
        extra_context: str = "",
    ) -> VocabResult:
        lowered = (text + " " + extra_context).lower()
        active = set(active_domains)
        out: list[str] = []
        subs: list[Substitution] = []
        entities: list[Entity] = []
        skipped: list[str] = []
        pos = 0
        for m in self._regex.finditer(text):
            matched = m.group(0)
            key = " ".join(re.split(r"[\s-]+", matched.lower()))
            entry = self._by_alias.get(key)
            if entry is None:
                continue
            ok, conf, rule = self._context_supported(entry, key, lowered, active)
            out.append(text[pos : m.start()])
            new_start = sum(len(s) for s in out)
            if ok:
                # Plain lower-case terms ("microservices") keep the speaker's casing.
                replacement = matched if (entry.canonical.islower() and matched.lower() == entry.canonical) else entry.canonical
                out.append(replacement)
                if matched != replacement:
                    subs.append(Substitution(matched, replacement, rule, conf))
                entities.append(Entity(entry.canonical, entry.domains, new_start, new_start + len(replacement)))
            else:
                out.append(matched)
                skipped.append(matched)
            pos = m.end()
        out.append(text[pos:])
        return VocabResult("".join(out), subs, entities, skipped)

    @staticmethod
    def _context_supported(entry: VocabEntry, alias_key: str, lowered: str, active: set[str]) -> tuple[bool, float, str]:
        if entry.context is None:
            return True, 0.95, "vocabulary"
        for word in entry.context:
            if word != alias_key and _contains_phrase(lowered, word):
                return True, 0.8, f"vocabulary:context({word})"
        if active.intersection(entry.context_domains):
            return True, 0.65, "vocabulary:session-domain"
        return False, 0.0, ""

    def find_entities(self, text: str) -> list[Entity]:
        """Entities already present in canonical form (used for context and classification)."""
        found = []
        for m in self._regex.finditer(text):
            key = " ".join(re.split(r"[\s-]+", m.group(0).lower()))
            entry = self._by_alias.get(key)
            if entry is None:
                continue
            # Context-gated aliases ("react", "spring") count only once normalized to canonical casing;
            # otherwise the ordinary English word would be treated as the technology.
            same = m.group(0) == entry.canonical if entry.context is not None else m.group(0).lower() == entry.canonical.lower()
            if same:
                found.append(Entity(entry.canonical, entry.domains, m.start(), m.end()))
        return found
