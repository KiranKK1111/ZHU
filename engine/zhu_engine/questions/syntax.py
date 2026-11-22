"""Spoken programming syntax normalization (Master Prompt 01, section 8).

Explicitly spoken symbol names ("triple equals") are always converted. Patterns
that could be ordinary prose ("o of n", "list of strings", "arr bracket i")
are converted only when a programming or complexity context is present.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .types import Substitution


@dataclass
class SyntaxResult:
    text: str
    substitutions: list[Substitution] = field(default_factory=list)
    has_code: bool = False


CODE_CONTEXT_WORDS = re.compile(
    r"\b(?:code|program|programming|function|functions|method|methods|class|classes|variable|"
    r"variables|operator|operators|syntax|java|javascript|typescript|python|c\+\+|c#|kotlin|"
    r"golang|rust|compile|compiler|loop|array|arrays|string|strings|integer|integers|return|"
    r"returns|algorithm|statement|expression|boolean|null|undefined|object|objects|interface|"
    r"generic|generics|lambda|stream|collection|collections|implement)\b",
    re.IGNORECASE,
)
COMPLEXITY_CONTEXT = re.compile(
    r"\b(?:complexity|complexities|time|space|runtime|run time|algorithm|algorithms|big\s*-?\s*o|"
    r"efficient|efficiency|performance|optimal|optimi[sz]e|worst case|best case|average case|"
    r"amortized|linear|logarithmic|quadratic|constant)\b",
    re.IGNORECASE,
)
JAVA_LIKE_CONTEXT = re.compile(r"\b(?:java|c#|typescript|kotlin|generics?|generic type)\b", re.IGNORECASE)

# Explicit symbol names. Order matters: longest first.
_SYMBOLS: list[tuple[str, str]] = [
    (r"\b(?:triple equals?|three equals?|equals equals equals|triple equal sign)\b", "==="),
    (r"\b(?:strict not equals?|bang double equals?|not triple equals?|exclamation double equals?)\b", "!=="),
    (r"\b(?:double equals?|equals equals|double equal signs?|double equal to)\b", "=="),
    (r"\b(?:bang equals?|exclamation equals?|not equals operator)\b", "!="),
    (r"\b(?:double ampersands?|ampersand ampersand)\b", "&&"),
    (r"\b(?:double pipes?|pipe pipe|double vertical bars?)\b", "||"),
    (r"\b(?:double colons?|colon colon|scope resolution operator)\b", "::"),
]
_CODE_ONLY: list[tuple[str, str]] = [
    (r"\b([a-z])\s+plus plus\b", r"\1++"),
    (r"\b([a-z])\s+minus minus\b", r"\1--"),
    (r"\bplus equals\b", "+="),
    (r"\bminus equals\b", "-="),
    (r"\b(\w+)\s+(?:open\s+)?(?:square\s+)?bracket\s+(\w+)(?:\s+close\s+(?:square\s+)?bracket)?\b", r"\1[\2]"),
]

_BIG_O_EXPR: list[tuple[str, str]] = [
    (r"n log(?: of)? n", "n log n"),
    (r"log(?: of)? n", "log n"),
    (r"n (?:squared|square|to the power(?: of)? two|to the power(?: of)? 2|raised to(?: the power(?: of)?)? two)", "n²"),
    (r"n (?:cubed|cube|to the power(?: of)? three)", "n³"),
    (r"(?:two|2) (?:to the|to the power(?: of)?|raised to(?: the power(?: of)?)?) n", "2ⁿ"),
    (r"n factorial", "n!"),
    (r"(?:n plus m|n \+ m)", "n + m"),
    (r"(?:m plus n)", "m + n"),
    (r"(?:v plus e)", "V + E"),
    (r"(?:n times m|n into m|n m)", "n × m"),
    (r"(?:m times n|m into n)", "m × n"),
    (r"(?:n times k|n into k|n k)", "n × k"),
    (r"(?:square root of n|root n)", "√n"),
    (r"(?:one|1|constant)", "1"),
    (r"(?:n|k|m)", None),  # keeps the letter as spoken
]
_BIG_O_RE = re.compile(
    r"\b(big\s+)?(?:o|oh)\s+of\s+(" + "|".join(p for p, _ in _BIG_O_EXPR) + r")\b",
    re.IGNORECASE,
)

_HYPHEN_RE = re.compile(
    r"\b(second|third|fourth|fifth|kth|nth|k-th|n-th)\s+(largest|smallest|highest|lowest|biggest|"
    r"maximum|minimum|most|least|greatest|longest|shortest)\b",
    re.IGNORECASE,
)
_NON_RE = re.compile(
    r"\bnon\s+(repeating|repeated|negative|zero|empty|null|blocking|primitive|static|recursive|"
    r"unique|overlapping|decreasing|increasing|functional|relational|clustered)\b",
    re.IGNORECASE,
)

_TYPE_NAMES = {
    "string": "String", "strings": "String", "integer": "Integer", "integers": "Integer",
    "int": "Integer", "ints": "Integer", "long": "Long", "longs": "Long", "double": "Double",
    "doubles": "Double", "boolean": "Boolean", "booleans": "Boolean", "object": "Object",
    "objects": "Object", "character": "Character", "characters": "Character", "char": "Character",
    "chars": "Character",
}
_CONTAINERS = {
    "list": "List", "set": "Set", "map": "Map", "hashmap": "HashMap", "hash map": "HashMap",
    "arraylist": "ArrayList", "array list": "ArrayList", "optional": "Optional", "queue": "Queue",
    "deque": "Deque", "stack": "Stack", "hashset": "HashSet", "hash set": "HashSet",
    "treemap": "TreeMap", "tree map": "TreeMap", "completablefuture": "CompletableFuture",
    "completable future": "CompletableFuture", "future": "Future",
}
_TYPE_ALT = "|".join(sorted(_TYPE_NAMES, key=len, reverse=True))
_CONT_ALT = "|".join(re.escape(c) for c in sorted(_CONTAINERS, key=len, reverse=True))
_MAP_GENERIC_RE = re.compile(rf"\b({_CONT_ALT})\s+of\s+({_TYPE_ALT})\s+to\s+({_TYPE_ALT})\b", re.IGNORECASE)
_GENERIC_RE = re.compile(rf"\b({_CONT_ALT})\s+of\s+({_TYPE_ALT})\b", re.IGNORECASE)

_SQL_START = re.compile(r"\bselect\b(?=.*\bfrom\b)", re.IGNORECASE)
_SQL_END = re.compile(
    r"[?.!](?:\s|$)|,\s+and\s+|\s+and\s+(?=(?:what|how|why|explain|tell|which)\b)|"
    r"\s+(?:in|using|with|on)\s+(?=(?:sql|mysql|postgresql|oracle|sql server|sqlite|mariadb)\b)|"
    r"\s+(?=(?:return|returns|give|gives|do|does|mean|means|output|outputs|produce|produces|print|show|display)\b)",
    re.IGNORECASE,
)
_SQL_REPLACEMENTS: list[tuple[str, str]] = [
    (r"\bcount\s+(?:of\s+)?star\b", "COUNT(*)"),
    (r"\bselect\s+star\b", "SELECT *"),
    (r"\b(?:is\s+)?greater than or equal to\b", ">="),
    (r"\b(?:is\s+)?less than or equal to\b", "<="),
    (r"\b(?:is\s+)?not equal to\b|\bnot equals\b", "!="),
    (r"\b(?:is\s+)?greater than\b", ">"),
    (r"\b(?:is\s+)?less than\b", "<"),
    (r"\b(?:is\s+)?equal to\b|\bequals\b", "="),
]
_SQL_KEYWORDS = [
    "select", "distinct", "from", "where", "group by", "order by", "having", "inner join",
    "left outer join", "right outer join", "left join", "right join", "full outer join", "join",
    "on", "limit", "offset", "as", "and", "or", "not", "in", "between", "like", "is null",
    "is not null", "desc", "asc", "union all", "union", "count", "sum", "avg", "min", "max",
]
_SQL_KW_RE = re.compile(r"\b(" + "|".join(k.replace(" ", r"\s+") for k in sorted(_SQL_KEYWORDS, key=len, reverse=True)) + r")\b", re.IGNORECASE)


def has_code_context(text: str) -> bool:
    return bool(CODE_CONTEXT_WORDS.search(text))


def normalize_code_syntax(text: str, code_context: bool | None = None, java_like: bool | None = None) -> SyntaxResult:
    subs: list[Substitution] = []
    if code_context is None:
        code_context = has_code_context(text)
    if java_like is None:
        java_like = bool(JAVA_LIKE_CONTEXT.search(text))
    has_code = False

    def sub(pattern: str | re.Pattern[str], repl, rule: str, conf: float, flags=re.IGNORECASE) -> None:
        nonlocal text, has_code
        rx = pattern if isinstance(pattern, re.Pattern) else re.compile(pattern, flags)

        def _r(m: re.Match[str]) -> str:
            nonlocal has_code
            new = repl(m) if callable(repl) else m.expand(repl)
            if new != m.group(0):
                subs.append(Substitution(m.group(0), new, rule, conf))
                has_code = True
            return new

        text = rx.sub(_r, text)

    for pattern, symbol in _SYMBOLS:
        sub(pattern, symbol, "syntax:symbol", 0.9)

    if code_context:
        for pattern, repl in _CODE_ONLY:
            sub(pattern, repl, "syntax:code", 0.8)

    # Big-O: "big o of ..." is explicit; a bare "o of n" needs a complexity context.
    complexity = bool(COMPLEXITY_CONTEXT.search(text))

    def big_o(m: re.Match[str]) -> str:
        if not m.group(1) and not complexity:
            return m.group(0)
        spoken = m.group(2).lower()
        for pattern, value in _BIG_O_EXPR:
            if re.fullmatch(pattern, spoken):
                return f"O({value if value is not None else spoken})"
        return m.group(0)

    sub(_BIG_O_RE, big_o, "syntax:big-o", 0.85)
    sub(_HYPHEN_RE, lambda m: f"{m.group(1)}-{m.group(2)}", "format:compound-adjective", 0.9)
    sub(_NON_RE, lambda m: f"non-{m.group(1)}", "format:compound-adjective", 0.9)

    if java_like:
        sub(
            _MAP_GENERIC_RE,
            lambda m: f"{_CONTAINERS[' '.join(m.group(1).lower().split())]}<{_TYPE_NAMES[m.group(2).lower()]}, {_TYPE_NAMES[m.group(3).lower()]}>",
            "syntax:generic",
            0.7,
        )
        sub(
            _GENERIC_RE,
            lambda m: f"{_CONTAINERS[' '.join(m.group(1).lower().split())]}<{_TYPE_NAMES[m.group(2).lower()]}>",
            "syntax:generic",
            0.7,
        )

    text, sql_subs = _normalize_sql(text)
    if sql_subs:
        subs.extend(sql_subs)
        has_code = True
    return SyntaxResult(text, subs, has_code)


def _normalize_sql(text: str) -> tuple[str, list[Substitution]]:
    m = _SQL_START.search(text)
    if not m:
        return text, []
    start = m.start()
    end_m = _SQL_END.search(text, m.end())
    end = end_m.start() if end_m else len(text.rstrip())
    fragment = text[start:end]
    if " from " not in fragment.lower():
        return text, []
    new = fragment
    for pattern, repl in _SQL_REPLACEMENTS:
        new = re.sub(pattern, repl, new, flags=re.IGNORECASE)
    new = _SQL_KW_RE.sub(lambda k: " ".join(k.group(1).upper().split()), new)
    new = f"`{new.strip()}`"
    return text[:start] + new + text[end:], [Substitution(fragment, new, "syntax:sql", 0.75)]
