"""Evaluate the question engine against the labelled dataset.

    python -m evaluation.evaluate [--dataset evaluation/question_dataset.json] [--json out.json]

Reports question-detection precision, recall, and F1 (matching each produced question
to an expected one), kind and category accuracy, exact-format match rate,
follow-up resolution accuracy, plus a calibration table of the heuristic
classification confidence. Every number printed here is computed, not estimated.
"""

from __future__ import annotations

import argparse
import itertools
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from zhu_engine.questions import AudioSource, QuestionEngine, QuestionEngineConfig, TechnicalVocabulary, TranscriptSegment  # noqa: E402
from zhu_engine.questions.text import similarity  # noqa: E402


def run_item(vocab: TechnicalVocabulary, item: dict) -> tuple[list, float]:
    counter = itertools.count()
    eng = QuestionEngine("eval", vocab, QuestionEngineConfig(), id_factory=lambda: f"q{next(counter)}")
    t = 0
    pause = item.get("pause_ms", 3000)
    latencies = []
    for i, text in enumerate(item["utterances"]):
        dur = max(800, 70 * len(text.split()))
        seg = TranscriptSegment(f"s{i}", 1, text, t, t + dur, True, AudioSource.SYSTEM, confidence=0.9)
        t0 = time.perf_counter()
        eng.ingest_segment(seg)
        latencies.append((time.perf_counter() - t0) * 1000)
        t += dur
        for _ in range(pause // 100):
            t += 100
            eng.tick(t)
    qs = [q for q in eng.questions.values() if q.state.value != "DISCARDED"]
    return qs, max(latencies) if latencies else 0.0


def evaluate(dataset: Path) -> dict:
    data = json.loads(dataset.read_text("utf-8"))
    vocab = TechnicalVocabulary.load()
    tp = fp = fn = 0
    kind_ok = cat_ok = exact = matched = 0
    follow_total = follow_ok = 0
    review_total = review_ok = 0
    sub_total = sub_ok = 0
    calib: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    per_tag: dict[str, Counter] = defaultdict(Counter)
    failures = []
    latencies = []
    for item in data["items"]:
        produced, lat = run_item(vocab, item)
        latencies.append(lat)
        expected = item["expected"]
        used = set()
        item_fail = []
        for exp in expected:
            best, best_sim = None, 0.0
            for i, q in enumerate(produced):
                if i in used:
                    continue
                s = similarity(q.formatted_text, exp["text"])
                if s > best_sim:
                    best, best_sim = i, s
            if best is None or best_sim < 0.6:
                fn += 1
                item_fail.append(f"missed: {exp['text']}")
                for tag in item["tags"]:
                    per_tag[tag]["fn"] += 1
                continue
            used.add(best)
            q = produced[best]
            tp += 1
            matched += 1
            for tag in item["tags"]:
                per_tag[tag]["tp"] += 1
            if q.kind.value == exp["kind"]:
                kind_ok += 1
            else:
                item_fail.append(f"kind {q.kind.value} != {exp['kind']}: {exp['text']}")
            allowed = exp["category"] if isinstance(exp["category"], list) else [exp["category"]]
            correct_cat = q.category.value in allowed
            cat_ok += correct_cat
            conf = q.confidence.classification or 0.0
            bucket = f"{int(conf * 10) / 10:.1f}"
            calib[bucket][0] += 1
            calib[bucket][1] += int(correct_cat)
            if not correct_cat:
                item_fail.append(f"category {q.category.value} != {exp['category']}: {exp['text']}")
            if q.formatted_text == exp["text"]:
                exact += 1
            else:
                item_fail.append(f"format: got {q.formatted_text!r} expected {exp['text']!r}")
            if "resolved" in exp:
                follow_total += 1
                if q.resolved_text == exp["resolved"]:
                    follow_ok += 1
                else:
                    item_fail.append(f"resolved: got {q.resolved_text!r} expected {exp['resolved']!r}")
            if "needs_review" in exp:
                review_total += 1
                review_ok += int(q.needs_review == exp["needs_review"])
            if "subquestions" in exp:
                sub_total += 1
                if len(q.subquestions) == exp["subquestions"]:
                    sub_ok += 1
                else:
                    item_fail.append(f"subquestions {len(q.subquestions)} != {exp['subquestions']}: {exp['text']}")
        extra = [q for i, q in enumerate(produced) if i not in used]
        fp += len(extra)
        for q in extra:
            item_fail.append(f"false positive: {q.formatted_text}")
            for tag in item["tags"]:
                per_tag[tag]["fp"] += 1
        if item_fail:
            failures.append({"id": item["id"], "issues": item_fail})

    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    latencies.sort()
    return {
        "items": len(data["items"]),
        "expected_questions": tp + fn,
        "detection": {"tp": tp, "fp": fp, "fn": fn, "precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4)},
        "kind_accuracy": round(kind_ok / matched, 4) if matched else None,
        "category_accuracy": round(cat_ok / matched, 4) if matched else None,
        "exact_format_rate": round(exact / matched, 4) if matched else None,
        "follow_up_resolution_accuracy": round(follow_ok / follow_total, 4) if follow_total else None,
        "needs_review_accuracy": round(review_ok / review_total, 4) if review_total else None,
        "subquestion_count_accuracy": round(sub_ok / sub_total, 4) if sub_total else None,
        "ingest_latency_ms": {"p50": round(latencies[len(latencies) // 2], 3), "max": round(latencies[-1], 3)},
        "classification_calibration": {k: {"n": v[0], "accuracy": round(v[1] / v[0], 3)} for k, v in sorted(calib.items())},
        "failures": failures,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(Path(__file__).parent / "question_dataset.json"))
    ap.add_argument("--json")
    args = ap.parse_args()
    report = evaluate(Path(args.dataset))
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2), "utf-8")
    failures = report.pop("failures")
    print(json.dumps(report, indent=2))
    if failures:
        print(f"\n{len(failures)} item(s) with issues:")
        for f in failures:
            print(f"  [{f['id']}]")
            for issue in f["issues"]:
                print(f"     - {issue}")


if __name__ == "__main__":
    main()
