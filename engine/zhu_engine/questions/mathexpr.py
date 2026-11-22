"""Spoken mathematical expression interpretation (Master Prompt 01, section 9).

Only maximal *math spans* are converted: runs of operands (numbers, number words,
single-letter variables) joined by spoken operators. Everything else is left
untouched.

Parentheses are inserted only when the speaker states the grouping explicitly
("open bracket … close bracket", "the quantity …", "…, all times …"). A span
that mixes additive and multiplicative operators without explicit grouping is
converted using standard precedence, and the question is flagged for review,
because spoken arithmetic is genuinely ambiguous there.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from .text import NUMBER_WORDS, SCALE_WORDS
from .types import Substitution

_DENOMINATORS = {
    "half": 2, "halves": 2, "third": 3, "thirds": 3, "fourth": 4, "fourths": 4, "quarter": 4,
    "quarters": 4, "fifth": 5, "fifths": 5, "sixth": 6, "sixths": 6, "seventh": 7, "sevenths": 7,
    "eighth": 8, "eighths": 8, "ninth": 9, "ninths": 9, "tenth": 10, "tenths": 10,
    "hundredth": 100, "hundredths": 100,
}
_VARIABLES = frozenset("xyznmkbc")

# (spoken words, kind, symbol). Kind: bin = binary, post = postfix, pre = prefix.
_OPERATORS: list[tuple[tuple[str, ...], str, str]] = [
    (("to", "the", "power", "of"), "bin", "^"),
    (("raised", "to", "the", "power", "of"), "bin", "^"),
    (("raised", "to", "the", "power"), "bin", "^"),
    (("to", "the", "power"), "bin", "^"),
    (("raised", "to"), "bin", "^"),
    (("multiplied", "by"), "bin", "×"),
    (("divided", "by"), "bin", "/"),
    (("is", "equal", "to"), "bin", "="),
    (("equal", "to"), "bin", "="),
    (("square", "root", "of"), "pre", "√"),
    (("the", "square", "root", "of"), "pre", "√"),
    (("plus",), "bin", "+"),
    (("minus",), "bin", "-"),
    (("times",), "bin", "×"),
    (("into",), "bin", "×"),
    (("over",), "bin", "/"),
    (("mod",), "bin", "mod"),
    (("modulo",), "bin", "mod"),
    (("equals",), "bin", "="),
    (("squared",), "post", "²"),
    (("cubed",), "post", "³"),
    (("percent",), "post", "%"),
    (("factorial",), "post", "!"),
]
_OPERATORS.sort(key=lambda o: len(o[0]), reverse=True)
_OPEN_GROUP = [("open", "bracket"), ("open", "parenthesis"), ("open", "paren"), ("the", "quantity")]
_CLOSE_GROUP = [("close", "bracket"), ("close", "parenthesis"), ("close", "paren"), ("end", "quantity")]
_ADDITIVE = {"+", "-"}
_MULTIPLICATIVE = {"×", "/", "mod"}


@dataclass
class MathResult:
    text: str
    latex: Optional[str] = None
    substitutions: list[Substitution] = field(default_factory=list)
    review_reasons: list[str] = field(default_factory=list)
    found: bool = False


@dataclass
class _Tok:
    kind: str  # num | var | bin | post | pre | open | close | word
    value: str
    start: int  # index into original word list
    end: int


def _fmt_number(n: float) -> str:
    return str(int(n)) if float(n).is_integer() else repr(n)


def _parse_number(ws: list[str], i: int) -> tuple[Optional[float], int]:
    """Parse a spoken or written number starting at ws[i]. Returns (value, next_index)."""
    w = ws[i]
    if re.fullmatch(r"-?\d+(?:\.\d+)?", w):
        return float(w), i + 1
    total, current, j, seen = 0.0, 0.0, i, False
    if w == "a" and i + 1 < len(ws) and ws[i + 1] in SCALE_WORDS:
        current, j, seen = 1.0, i + 1, True
    while j < len(ws):
        t = ws[j]
        if t in NUMBER_WORDS:
            current += NUMBER_WORDS[t]
            seen = True
        elif t in SCALE_WORDS:
            scale = SCALE_WORDS[t]
            current = (current or 1.0) * scale
            if scale >= 1000:
                total += current
                current = 0.0
            seen = True
        elif t == "and" and seen and j + 1 < len(ws) and ws[j + 1] in NUMBER_WORDS and j > i and ws[j - 1] in SCALE_WORDS:
            pass  # "one hundred and five"
        else:
            break
        j += 1
    if not seen:
        return None, i
    value = total + current
    # decimals: "three point one four"
    if j + 1 < len(ws) and ws[j] == "point" and ws[j + 1] in NUMBER_WORDS and NUMBER_WORDS[ws[j + 1]] < 10:
        digits = []
        k = j + 1
        while k < len(ws) and ws[k] in NUMBER_WORDS and NUMBER_WORDS[ws[k]] < 10:
            digits.append(str(NUMBER_WORDS[ws[k]]))
            k += 1
        value = float(f"{int(value)}.{''.join(digits)}")
        j = k
    return value, j


def _match_seq(ws: list[str], i: int, seq: tuple[str, ...]) -> bool:
    return tuple(ws[i : i + len(seq)]) == seq


def _tokenize(ws: list[str], trail: list[str] | None = None) -> list[_Tok]:
    toks: list[_Tok] = []
    i = 0
    while i < len(ws):
        matched = False
        # ", all times 4": the comma plus "all" groups everything spoken before it.
        if ws[i] == "all" and trail is not None and i > 0 and trail[i - 1].startswith(","):
            toks.append(_Tok("groupall", "", i, i + 1))
            i += 1
            continue
        for seq in _OPEN_GROUP:
            if _match_seq(ws, i, seq):
                toks.append(_Tok("open", "(", i, i + len(seq)))
                i += len(seq)
                matched = True
                break
        if matched:
            continue
        for seq in _CLOSE_GROUP:
            if _match_seq(ws, i, seq):
                toks.append(_Tok("close", ")", i, i + len(seq)))
                i += len(seq)
                matched = True
                break
        if matched:
            continue
        for seq, kind, sym in _OPERATORS:
            if _match_seq(ws, i, seq):
                toks.append(_Tok(kind, sym, i, i + len(seq)))
                i += len(seq)
                matched = True
                break
        if matched:
            continue
        value, j = _parse_number(ws, i)
        if value is not None:
            # Fractions: "three fourths", "one half"
            if j < len(ws) and ws[j] in _DENOMINATORS and float(value).is_integer() and value < 100:
                toks.append(_Tok("num", f"{_fmt_number(value)}/{_DENOMINATORS[ws[j]]}", i, j + 1))
                i = j + 1
            else:
                toks.append(_Tok("num", _fmt_number(value), i, j))
                i = j
            continue
        if ws[i] in _VARIABLES or (ws[i] == "a" and i + 1 < len(ws) and any(_match_seq(ws, i + 1, s) for s, k, _ in _OPERATORS if k == "bin")):
            toks.append(_Tok("var", ws[i], i, i + 1))
            i += 1
            continue
        toks.append(_Tok("word", ws[i], i, i + 1))
        i += 1
    return toks


def _find_spans(toks: list[_Tok]) -> list[tuple[int, int]]:
    """Return [start, end) token ranges that form valid expressions."""
    spans = []
    i = 0
    while i < len(toks):
        if toks[i].kind not in ("num", "var", "pre", "open"):
            i += 1
            continue
        j = i
        expect_operand = True
        depth = 0
        last_valid = -1
        has_operator = False
        op_at_valid = False
        while j < len(toks):
            t = toks[j]
            if expect_operand:
                if t.kind in ("num", "var"):
                    expect_operand = False
                    if depth == 0:
                        last_valid, op_at_valid = j, has_operator
                elif t.kind in ("pre", "open"):
                    depth += t.kind == "open"
                    has_operator = has_operator or t.kind == "pre"
                else:
                    break
            else:
                if t.kind == "bin":
                    expect_operand = True
                    has_operator = True
                elif t.kind == "post":
                    has_operator = True
                    if depth == 0:
                        last_valid, op_at_valid = j, True
                elif t.kind == "groupall" and depth == 0 and j + 1 < len(toks) and toks[j + 1].kind == "bin":
                    pass
                elif t.kind == "close" and depth > 0:
                    depth -= 1
                    if depth == 0:
                        last_valid, op_at_valid = j, has_operator
                else:
                    break
            j += 1
        if last_valid >= i and op_at_valid:
            # "of" after a percent ("20 percent of 500") continues the span.
            end = last_valid + 1
            while (
                end + 1 < len(toks)
                and toks[end - 1].value == "%"
                and toks[end].kind == "word"
                and toks[end].value == "of"
                and toks[end + 1].kind in ("num", "var")
            ):
                toks[end] = _Tok("bin", "of", toks[end].start, toks[end].end)
                end += 2
            spans.append((i, end))
            i = end
        else:
            i += 1
    return spans


def _render(toks: list[_Tok]) -> tuple[str, str]:
    plain: list[str] = []
    latex: list[str] = []
    latex_map = {"×": r"\times", "/": r"\div", "-": "-", "+": "+", "=": "=", "^": "^", "mod": r"\bmod", "of": r"\text{ of }"}
    for idx, t in enumerate(toks):
        if t.kind in ("num", "var"):
            if plain and plain[-1] in ("√", "("):
                plain[-1] += t.value
            else:
                plain.append(t.value)
            if "/" in t.value and t.kind == "num":
                a, b = t.value.split("/")
                lv = rf"\frac{{{a}}}{{{b}}}"
            else:
                lv = t.value
            if latex and latex[-1].endswith(r"\sqrt{"):
                latex[-1] += lv + "}"
            elif latex and latex[-1] == "^":
                latex[-1] = "^{" + lv + "}"
            else:
                latex.append(lv)
        elif t.kind == "post":
            plain[-1] += t.value
            latex.append({"²": "^{2}", "³": "^{3}", "%": r"\%", "!": "!"}[t.value])
        elif t.kind == "pre":
            plain.append("√")
            latex.append(r"\sqrt{")
        elif t.kind == "open":
            plain.append("(")
            latex.append("(")
        elif t.kind == "close":
            plain[-1] += ")"
            latex.append(")")
        elif t.kind == "bin":
            if t.value == "^":
                plain.append("^")
            else:
                plain.append(t.value)
            latex.append(latex_map[t.value])
    text = " ".join(plain).replace(" ^ ", "^")
    tex = " ".join(latex).replace(" ^{", "^{").replace(" ^ ", "^")
    return text, tex


def normalize_math(text: str) -> MathResult:
    raw_words = text.split()
    if not raw_words:
        return MathResult(text)
    # Separate trailing punctuation so it can be re-attached.
    core = [re.sub(r"[,.?!;:]+$", "", w) for w in raw_words]
    trail = [w[len(c):] for w, c in zip(raw_words, core)]
    lowered = [c.lower() for c in core]
    toks = _tokenize(lowered, trail)
    spans = _find_spans(toks)
    if not spans:
        return MathResult(text)

    result = MathResult(text, found=True)
    out_words = list(raw_words)
    replaced: list[tuple[int, int, str]] = []
    for s, e in spans:
        span_toks = toks[s:e]
        bins = {t.value for t in span_toks if t.kind == "bin"}
        explicit_group = any(t.kind == "open" for t in span_toks)
        w0, w1 = span_toks[0].start, span_toks[-1].end
        for k, t in enumerate(span_toks):
            if t.kind == "groupall":
                span_toks = [_Tok("open", "(", w0, w0)] + span_toks[:k] + [_Tok("close", ")", t.start, t.start)] + span_toks[k + 1 :]
                explicit_group = True
                break
        plain, tex = _render(span_toks)
        if bins & _ADDITIVE and bins & _MULTIPLICATIVE and not explicit_group:
            result.review_reasons.append(
                f"spoken arithmetic '{' '.join(core[w0:w1])}' mixes operators; grouping is ambiguous"
            )
        if "×" in bins and any(t.value == "×" and lowered[t.start] == "into" for t in span_toks if t.kind == "bin"):
            result.review_reasons.append("'into' interpreted as multiplication")
        replaced.append((w0, w1, plain))
        result.substitutions.append(Substitution(" ".join(core[w0:w1]), plain, "math", 0.8))
        result.latex = tex if result.latex is None else result.latex + r",\quad " + tex
    for w0, w1, plain in reversed(replaced):
        out_words[w0:w1] = [plain + trail[w1 - 1]]
    result.text = " ".join(out_words)
    return result
