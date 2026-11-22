"""Shared lexical helpers and word lists for the question pipeline."""

from __future__ import annotations

import re
from difflib import SequenceMatcher

WORD_RE = re.compile(r"[A-Za-z0-9#+_.'-]*[A-Za-z0-9#+_]|[A-Za-z0-9]")

WH_WORDS = frozenset(
    {"what", "why", "how", "when", "where", "which", "who", "whom", "whose", "what's", "how's", "where's", "who's", "why's"}
)

AUXILIARIES = frozenset(
    {
        "is", "are", "was", "were", "do", "does", "did", "can", "could", "would", "will",
        "should", "shall", "have", "has", "had", "may", "might", "must", "isn't", "aren't",
        "don't", "doesn't", "didn't", "can't", "couldn't", "wouldn't", "won't", "shouldn't",
        "haven't", "hasn't",
    }
)

SUBJECT_STARTERS = frozenset(
    {"you", "we", "i", "it", "there", "this", "that", "these", "those", "they", "he", "she",
     "the", "a", "an", "your", "our", "my", "any", "anyone", "someone"}
)

IMPERATIVE_VERBS = frozenset(
    {
        "explain", "describe", "compare", "contrast", "define", "differentiate", "elaborate",
        "discuss", "outline", "list", "name", "walk", "tell", "give", "show", "write",
        "implement", "code", "design", "build", "create", "find", "calculate", "compute",
        "solve", "reverse", "sort", "merge", "count", "return", "print", "check", "determine",
        "optimize", "optimise", "prove", "derive", "convert", "evaluate", "simplify", "draw",
        "model", "estimate", "identify", "debug", "fix", "refactor", "review", "suggest",
        "recommend", "justify", "illustrate", "demonstrate", "summarize", "summarise",
        "mention", "state", "share", "talk", "provide", "detect", "remove", "rotate", "search",
        "traverse", "validate", "generate", "construct", "develop", "configure", "deploy",
        "analyze", "analyse", "predict", "clarify", "highlight", "present", "propose",
    }
)

CODING_VERBS = frozenset(
    {"write", "implement", "code", "reverse", "sort", "merge", "count", "print", "return",
     "find", "detect", "remove", "rotate", "search", "traverse", "validate", "generate",
     "construct", "build", "create", "solve", "check", "convert", "design"}
)

CODING_OBJECTS = frozenset(
    {
        "program", "function", "method", "algorithm", "array", "arrays", "string", "strings",
        "linked", "list", "tree", "trees", "graph", "graphs", "class", "code", "query",
        "script", "integer", "integers", "number", "numbers", "element", "elements",
        "character", "characters", "matrix", "stack", "queue", "heap", "cache", "palindrome",
        "anagram", "substring", "subarray", "node", "nodes", "binary", "bst", "hashmap",
        "sum", "target", "duplicates", "fibonacci", "factorial", "prime", "recursion",
        "recursive", "iterative", "loop", "lru", "pointer", "pointers", "interval",
        "intervals", "permutation", "permutations", "combinations", "subsequence",
    }
)

LEADING_DISCOURSE = re.compile(
    r"^(?:(?:ok(?:ay)?|alright|all right|right|so|now|well|um+|uh+|great|good|cool|sure|"
    r"and|next|then|also|(?:my|the|our)(?: next| last| first| final)? question(?: is| would be| for you is)?|next question(?: is)?|"
    r"the question is|question)\b[\s,:;.-]*)+",
    re.IGNORECASE,
)

# Words that, at the end of an utterance, strongly suggest the speaker has not finished.
DANGLING_ENDINGS = frozenset(
    {
        "and", "or", "but", "the", "a", "an", "of", "to", "with", "between", "for", "in",
        "on", "like", "so", "because", "which", "that", "is", "are", "was", "were", "how",
        "what", "why", "if", "when", "where", "your", "my", "our", "their", "its", "as",
        "from", "by", "about", "into", "than", "then", "also", "explain", "describe",
        "tell", "me", "us", "you", "can", "could", "would", "should", "do", "does", "um",
        "uh", "er", "using", "via", "versus", "vs", "an", "whether", "this", "these", "those",
    }
)

NUMBER_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60,
    "seventy": 70, "eighty": 80, "ninety": 90,
}
SCALE_WORDS = {"hundred": 100, "thousand": 1_000, "million": 1_000_000, "billion": 1_000_000_000}


def words(text: str) -> list[str]:
    """Lower-cased word tokens."""
    return [w.lower() for w in WORD_RE.findall(text)]


def first_words(text: str, n: int) -> list[str]:
    return words(text)[:n]


def similarity(a: str, b: str) -> float:
    """Token-sequence similarity in [0, 1], insensitive to case and punctuation."""
    ta, tb = words(a), words(b)
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    return SequenceMatcher(None, ta, tb, autojunk=False).ratio()


def capitalize_first(text: str) -> str:
    for i, ch in enumerate(text):
        if ch.isalpha():
            return text[:i] + ch.upper() + text[i + 1 :]
        if ch.isdigit():
            return text
    return text


def strip_terminal_punct(text: str) -> str:
    return text.rstrip().rstrip(".?!…,;: ").rstrip()


def collapse_ws(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([,.;:?!])", r"\1", text)
    text = re.sub(r",(?=\S)(?!\d)", ", ", text)
    return text


def ends_dangling(text: str) -> bool:
    stripped = text.rstrip()
    if stripped.endswith(("...", "…", ",", "-", "—", ":")):
        return True
    toks = words(stripped)
    return bool(toks) and toks[-1] in DANGLING_ENDINGS
