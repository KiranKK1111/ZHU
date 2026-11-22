"""Transcript normalization: fillers, stutters, and self-corrections.

Input:  raw STT text of one segment.
Output: ``NormalizedText``. The raw text is never modified; it is kept separately
by the caller.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .text import AUXILIARIES, IMPERATIVE_VERBS, WH_WORDS, collapse_ws
from .types import Substitution

FILLER_RE = re.compile(r"(?<![\w'])(?:u+m+|u+h+m*|e+r+m+|e+r+|h+m+|m+h*m+|a+h+)(?![\w'])[,.]?\s*", re.IGNORECASE)
# Consecutive duplicate words ("the the"). Some doubled words are grammatical.
STUTTER_RE = re.compile(r"\b(\w+)(?:[\s,]+\1\b)+", re.IGNORECASE)
LEGIT_DOUBLES = frozenset({"that", "had", "is", "very", "bye", "no", "yes", "so"})

# Repair markers: "<reparandum>, sorry, <repair>" / "... I mean ..." / "no wait".
CORRECTION_RE = re.compile(
    r",?\s*\b(?:sorry|i mean|no wait|no,? sorry|or rather|rather|correction|let me rephrase|"
    r"i meant|actually,? i mean|scratch that)\b\s*,?\s*",
    re.IGNORECASE,
)
_FUNCTION_WORDS = (
    {"the", "a", "an", "of", "to", "in", "on", "with", "between", "and", "or", "for", "from", "by", "about", "is", "are", "was", "were", "versus", "vs"}
    | WH_WORDS | AUXILIARIES | IMPERATIVE_VERBS
)
_PHRASE_STOP = re.compile(r"\b(?:and|or|but|in|on|for|with|of|to|between|versus|vs)\b|[,.?!]", re.IGNORECASE)


@dataclass
class NormalizedText:
    text: str
    substitutions: list[Substitution] = field(default_factory=list)
    review_reasons: list[str] = field(default_factory=list)


def _remove_fillers(text: str, subs: list[Substitution]) -> str:
    def repl(m: re.Match[str]) -> str:
        subs.append(Substitution(m.group(0).strip(), "", "filler", 0.95))
        return ""

    return FILLER_RE.sub(repl, text)


def _remove_stutters(text: str, subs: list[Substitution]) -> str:
    def repl(m: re.Match[str]) -> str:
        word = m.group(1)
        if word.lower() in LEGIT_DOUBLES:
            return m.group(0)
        subs.append(Substitution(m.group(0), word, "stutter", 0.9))
        return word

    return STUTTER_RE.sub(repl, text)


def _apply_self_corrections(text: str, subs: list[Substitution], reasons: list[str]) -> str:
    """Replace the reparandum with the repair.

    Strategy (standard disfluency onset alignment):
    1. The repair is the phrase after the marker, up to the next phrase boundary.
    2. If the repair's first word also occurs among the last six words before the
       marker, the reparandum starts at that word ("hash map, sorry, hash set").
    3. Otherwise the reparandum is the same number of words as the repair. This
       is less certain, so the question is flagged for review.
    """
    for _ in range(3):  # at most three repairs per segment
        m = CORRECTION_RE.search(text)
        if not m or m.start() == 0:
            return text
        before, after = text[: m.start()], text[m.end() :]
        stop = _PHRASE_STOP.search(after)
        repair = after[: stop.start()].strip() if stop and stop.start() > 0 else after.strip()
        repair_words = repair.split()
        before_words = before.split()
        if not repair_words or not before_words:
            return text
        onset = repair_words[0].lower()
        cut = None
        window = before_words[-6:]
        for i in range(len(window) - 1, -1, -1):
            if window[i].lower().strip(",.") == onset:
                cut = len(before_words) - len(window) + i
                break
        certain = cut is not None
        if cut is None:
            # Extend backwards over content words only, capped at the repair length.
            cap = min(len(repair_words), 3)
            cut = len(before_words)
            while cut > 0 and len(before_words) - cut < cap and before_words[cut - 1].lower().strip(",.") not in _FUNCTION_WORDS:
                cut -= 1
            if cut == len(before_words):
                return text
        reparandum = " ".join(before_words[cut:])
        new_text = " ".join(before_words[:cut] + [after.strip()])
        subs.append(
            Substitution(f"{reparandum}{m.group(0)}{repair}", repair, "self_correction", 0.85 if certain else 0.55)
        )
        if not certain:
            reasons.append(f"self-correction: assumed '{reparandum}' was replaced by '{repair}'")
        text = new_text
    return text


def normalize_transcript(raw: str) -> NormalizedText:
    subs: list[Substitution] = []
    reasons: list[str] = []
    text = raw.replace("…", "...")
    text = _remove_fillers(text, subs)
    text = _remove_stutters(text, subs)
    text = _apply_self_corrections(text, subs, reasons)
    text = collapse_ws(text)
    text = re.sub(r"^[,.;:]\s*", "", text)
    return NormalizedText(text=text, substitutions=subs, review_reasons=reasons)
