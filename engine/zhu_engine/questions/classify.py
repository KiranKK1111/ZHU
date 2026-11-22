"""Question topic classification (keyword-weighted, deterministic, CPU only)."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

from .types import QuestionCategory as C
from .types import QuestionKind
from .vocabulary import Entity

# Additional topical keywords beyond the vocabulary entities. Weight 1 per hit.
_KEYWORDS: dict[C, tuple[str, ...]] = {
    C.JAVA: ("java", "jvm", "interface", "abstract class", "polymorphism", "inheritance", "encapsulation", "garbage collection", "multithreading", "synchronized", "exception", "checked exception", "collections", "generics", "lambda", "stream", "final", "static", "string pool", "immutable"),
    C.SPRING_BOOT: ("bean", "beans", "dependency injection", "autowired", "annotation", "controller", "application context", "inversion of control", "actuator", "starter", "profile", "transactional"),
    C.JAVASCRIPT: ("closure", "closures", "promise", "promises", "async", "await", "event loop", "hoisting", "prototype", "callback", "var keyword", "let and const", "this keyword", "arrow function", "==", "==="),
    C.TYPESCRIPT: ("type annotation", "type annotations", "union type", "union types", "type guard", "type inference", "tsconfig"),
    C.REACT: ("component", "components", "hook", "hooks", "props", "jsx", "re-render", "context api", "reconciliation", "state management"),
    C.NODEJS: ("event loop", "middleware", "npm", "express", "non-blocking", "libuv", "streams"),
    C.PYTHON: ("decorator", "decorators", "generator", "generators", "list comprehension", "gil", "tuple", "dictionary", "pip"),
    C.CSHARP: ("linq", "async", "delegate", "delegates", "garbage collector", "nuget"),
    C.CPP: ("pointer", "pointers", "destructor", "virtual function", "template", "templates", "smart pointer", "memory leak"),
    C.SQL: ("query", "queries", "join", "joins", "select", "where clause", "group by", "having", "index", "indexes", "stored procedure", "trigger", "view", "subquery", "window function", "second highest salary"),
    C.DATABASE: ("database", "databases", "normalization", "normal form", "transaction", "transactions", "acid", "sharding", "replication", "indexing", "nosql", "schema", "partitioning", "isolation level", "deadlock"),
    C.DATA_STRUCTURES: ("array", "arrays", "hash map", "hashmap", "linked list", "linked lists", "stack", "queue", "tree", "binary tree", "heap", "hash table", "trie", "graph", "matrix", "string", "strings", "cache"),
    C.ALGORITHMS: ("algorithm", "sort", "sorting", "search", "searching", "binary search", "dynamic programming", "recursion", "complexity", "time complexity", "space complexity", "greedy", "backtracking", "traversal", "two pointers", "sliding window", "reverse", "palindrome", "o(", "big o", "whose sum", "target sum", "two numbers", "subarray"),
    C.SYSTEM_DESIGN: ("design", "architecture", "scalability", "scale", "load balancer", "caching", "cache", "requests per second", "latency", "throughput", "high availability", "rate limiter", "url shortener", "distributed system", "distributed systems", "consistency", "availability", "partition"),
    C.MICROSERVICES: ("microservice", "microservices", "service discovery", "api gateway", "circuit breaker", "distributed transactions", "saga", "message queue", "event driven", "monolith"),
    C.DEVOPS: ("docker", "kubernetes", "container", "containers", "pipeline", "ci/cd", "deployment", "jenkins", "helm", "pod", "pods"),
    C.CLOUD: ("aws", "azure", "gcp", "cloud", "serverless", "s3", "ec2", "lambda"),
    C.MATH: ("percent", "percentage", "probability", "ratio", "equation", "average", "mean", "median", "statistics", "divided", "multiplied", "sum of", "%", "×", "÷", "√"),
}
# More specific topics win ties against broader ones.
_SPECIFICITY = {C.SPRING_BOOT: 1.5, C.REACT: 1.3, C.NODEJS: 1.3, C.TYPESCRIPT: 1.1, C.MICROSERVICES: 1.2, C.SQL: 1.2}
_KW_RE = {cat: [re.compile(r"(?<![\w])" + re.escape(k) + (r"(?![\w])" if k[-1].isalnum() else ""), re.IGNORECASE) for k in kws] for cat, kws in _KEYWORDS.items()}


@dataclass(frozen=True)
class Classification:
    category: C
    confidence: float


def classify(text: str, kind: QuestionKind, entities: list[Entity]) -> Classification:
    scores: Counter[C] = Counter()
    for e in entities:
        for rank, d in enumerate(e.domains):
            try:
                cat = C(d)
            except ValueError:
                continue
            if cat is not C.GENERAL:
                scores[cat] += 2.5 if rank == 0 else 1.0  # an entity's primary domain dominates
    for cat, patterns in _KW_RE.items():
        for p in patterns:
            if p.search(text):
                scores[cat] += 1.0
    for cat, mult in _SPECIFICITY.items():
        if cat in scores:
            scores[cat] *= mult

    if kind is QuestionKind.BEHAVIORAL:
        tech = max(scores.values(), default=0)
        if tech < 4:  # a behavioral prompt that mentions a technology is still behavioral
            return Classification(C.BEHAVIORAL, 0.8)
    if kind is QuestionKind.MATH and not scores.get(C.ALGORITHMS):
        return Classification(C.MATH, 0.75)
    if not scores:
        return Classification(C.GENERAL, 0.3)
    ranked = scores.most_common()
    top_cat, top = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0.0
    confidence = round(min(0.95, 0.4 + 0.5 * (top - second) / (top + 1.0) + 0.05 * min(top, 4)), 3)
    return Classification(top_cat, confidence)
