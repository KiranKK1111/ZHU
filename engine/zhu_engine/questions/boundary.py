"""Utterance boundary detection.

Input:  normalized text, which may contain STT punctuation.
Output: ``Utterance`` sentences with character offsets.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Tokens containing periods that do not end a sentence.
_PROTECTED = re.compile(
    r"\b(?:e\.g\.|i\.e\.|etc\.|vs\.|mr\.|mrs\.|ms\.|dr\.|approx\.|no\.)|"
    r"(?<=\w)\.(?=[A-Za-z0-9])|"  # Node.js, 3.14, ASP.NET
    r"(?<!\w)\.(?=NET\b)",
    re.IGNORECASE,
)
_SENTENCE_END = re.compile(r"[.?!]+(?=\s|$)|…(?=\s|$)")
# Discourse markers that start a new utterance even without punctuation.
_NEW_UTTERANCE = re.compile(
    r"\s(?=(?:okay|ok|alright|all right)[, ]+(?:so|next|now|moving on|let's)\b|"
    r"(?:next question|moving on|let's move on|my next question)\b)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Utterance:
    text: str
    start: int
    end: int
    terminal: str  # "?", ".", "!", "..." or "" when unterminated


def split_utterances(text: str) -> list[Utterance]:
    placeholder = "\x00"
    masked = _PROTECTED.sub(lambda m: m.group(0).replace(".", placeholder), text)
    cuts: list[int] = [0]
    for m in _SENTENCE_END.finditer(masked):
        cuts.append(m.end())
    for m in _NEW_UTTERANCE.finditer(masked):
        cuts.append(m.start() + 1)
    cuts = sorted(set(c for c in cuts if 0 <= c <= len(text)))
    if cuts[-1] != len(text):
        cuts.append(len(text))
    out: list[Utterance] = []
    for a, b in zip(cuts, cuts[1:]):
        chunk = text[a:b]
        stripped = chunk.strip()
        if not stripped:
            continue
        lead = len(chunk) - len(chunk.lstrip())
        start = a + lead
        end = start + len(stripped)
        terminal = ""
        if stripped.endswith(("...", "…")):
            terminal = "..."
        elif stripped[-1] in "?.!":
            terminal = stripped[-1]
        out.append(Utterance(stripped, start, end, terminal))
    return out
