"""Unit tests for the individual question pipeline stages."""

from __future__ import annotations

import pytest

from zhu_engine.questions import QuestionState as S
from zhu_engine.questions.boundary import split_utterances
from zhu_engine.questions.candidate import detect_candidate, is_continuation
from zhu_engine.questions.completion import CompletionState, evaluate_completion
from zhu_engine.questions.config import QuestionEngineConfig
from zhu_engine.questions.formatter import fix_embedded_question, format_question, split_multipart
from zhu_engine.questions.mathexpr import normalize_math
from zhu_engine.questions.normalize import normalize_transcript
from zhu_engine.questions.state import InvalidTransition, transition
from zhu_engine.questions.syntax import normalize_code_syntax
from zhu_engine.questions.types import QuestionKind as K

from .helpers import VOCAB, make_feeder

CFG = QuestionEngineConfig()


class TestStateMachine:
    def test_allowed_path(self):
        s = S.IDLE
        for t in (S.SPEECH_DETECTED, S.CANDIDATE, S.QUESTION_IN_PROGRESS, S.AWAITING_COMPLETION, S.QUESTION_IN_PROGRESS, S.AWAITING_COMPLETION, S.COMPLETE, S.REVISED, S.COMPLETE):
            s = transition(s, t)
        assert s is S.COMPLETE

    @pytest.mark.parametrize("a,b", [(S.IDLE, S.COMPLETE), (S.DISCARDED, S.CANDIDATE), (S.COMPLETE, S.QUESTION_IN_PROGRESS), (S.MANUALLY_EDITED, S.COMPLETE)])
    def test_rejected(self, a, b):
        with pytest.raises(InvalidTransition):
            transition(a, b)


class TestNormalize:
    def test_fillers_and_stutters(self):
        assert normalize_transcript("um what is uh the the difference").text == "what is the difference"

    def test_legit_double_kept(self):
        assert normalize_transcript("I think that that is fine").text == "I think that that is fine"

    def test_self_correction_onset(self):
        assert normalize_transcript("compare kafka, I mean, rabbit mq and redis").text == "compare rabbit mq and redis"


class TestVocabulary:
    @pytest.mark.parametrize("spoken,canonical", [
        ("spring boot", "Spring Boot"), ("rest api", "REST API"), ("j son", "JSON"), ("c plus plus", "C++"),
        ("c sharp", "C#"), ("node j s", "Node.js"), ("type script", "TypeScript"), ("kubernetes", "Kubernetes"),
    ])
    def test_distinctive_aliases(self, spoken, canonical):
        assert VOCAB.normalize(f"tell me about {spoken} please").text == f"tell me about {canonical} please"

    def test_hash_map_needs_context(self):
        assert VOCAB.normalize("how does a hash map work").text == "how does a hash map work"
        assert VOCAB.normalize("how does a hash map work in java").text == "how does a HashMap work in Java"

    def test_session_domain_supports_substitution(self):
        assert "HashMap" in VOCAB.normalize("how does a hash map resize", active_domains={"JAVA"}).text

    def test_no_match_inside_words(self):
        assert VOCAB.normalize("javascript is not java").text == "JavaScript is not Java"

    def test_user_terms_override(self, tmp_path):
        import json
        from zhu_engine.questions.vocabulary import TechnicalVocabulary
        p = tmp_path / "vocab.json"
        p.write_text(json.dumps({"terms": [{"canonical": "Quarkus", "aliases": ["quark us"], "domains": ["JAVA"]}, {"canonical": "Java", "disabled": True}]}))
        v = TechnicalVocabulary.load(p)
        assert v.normalize("what is quark us in java").text == "what is Quarkus in java"  # Java entry disabled


class TestSyntax:
    def test_big_o_requires_context(self):
        assert normalize_code_syntax("the o of n thing").text == "the o of n thing"
        assert normalize_code_syntax("what is the time complexity, o of n log n?").text == "what is the time complexity, O(n log n)?"
        assert normalize_code_syntax("is big o of n squared bad").text == "is O(n²) bad"

    def test_generics_java_only(self):
        assert normalize_code_syntax("return a list of strings in java").text == "return a List<String> in java"
        assert normalize_code_syntax("return a list of strings").text == "return a list of strings"
        assert normalize_code_syntax("a map of string to integer in java").text == "a Map<String, Integer> in java"

    def test_array_index_in_code_context(self):
        assert normalize_code_syntax("in the loop compare arr bracket i with the next element").text == "in the loop compare arr[i] with the next element"


class TestMath:
    def test_percent_of(self):
        assert normalize_math("what is twenty percent of five hundred").text == "what is 20% of 500"

    def test_power_and_root(self):
        assert normalize_math("what is two to the power of ten").text == "what is 2^10"
        assert normalize_math("what is the square root of sixteen plus nine").text == "what is √16 + 9"

    def test_fraction_and_decimal(self):
        assert normalize_math("what is three fourths plus one half").text == "what is 3/4 + 1/2"
        assert normalize_math("multiply three point one four times two").text == "multiply 3.14 × 2"

    def test_equation(self):
        r = normalize_math("solve x plus five equals twelve")
        assert r.text == "solve x + 5 = 12" and r.latex == "x + 5 = 12"

    def test_prose_numbers_untouched(self):
        assert normalize_math("which one is better").found is False
        assert normalize_math("call it two times").found is False


class TestBoundaryAndCandidates:
    def test_protected_periods(self):
        utts = split_utterances("What is Node.js? Compare it with ASP.NET Core, e.g. performance.")
        assert [u.text for u in utts] == ["What is Node.js?", "Compare it with ASP.NET Core, e.g. performance."]

    @pytest.mark.parametrize("text,kind", [
        ("What is polymorphism?", K.DIRECT), ("Explain the Spring Bean lifecycle.", K.IMPERATIVE),
        ("Compare REST and GraphQL.", K.IMPERATIVE), ("Implement an LRU cache.", K.CODING_TASK),
        ("Tell me about a time you handled a production incident.", K.BEHAVIORAL),
        ("I'd like you to describe your project architecture.", K.INDIRECT),
    ])
    def test_kinds(self, text, kind):
        sig = detect_candidate(text)
        assert sig.is_candidate and sig.kind is kind

    @pytest.mark.parametrize("text", ["Okay, that's great.", "Thank you.", "I think we used Kafka for that.", "Sounds good"])
    def test_non_questions(self, text):
        assert not detect_candidate(text).is_candidate

    def test_continuations(self):
        assert is_continuation("and give me a practical example?")
        assert is_continuation("Explain with an example.")
        assert not is_continuation("What is encapsulation?")


class TestFormatter:
    def test_embedded_inversion(self):
        assert fix_embedded_question("explain what is dependency injection and how") == "explain what dependency injection is and how"

    def test_imperative_period(self):
        assert format_question("explain the spring bean lifecycle?") == "Explain the spring bean lifecycle."

    def test_embedded_how_not_split(self):
        assert split_multipart("can you explain what dependency injection is and how spring boot manages beans") == []

    def test_compare_not_split(self):
        assert split_multipart("compare rest and graphql") == []


class TestCompletion:
    def test_question_mark_short_pause(self):
        # short pause (800) + VAD onset guard (300): a resumption detected late must still be able to win
        early = evaluate_completion("What is X?", 900, all_final=True, speech_active=False, pending_final=False, other_source_spoke=False, cfg=CFG)
        assert early.state is CompletionState.AWAITING
        d = evaluate_completion("What is X?", 1150, all_final=True, speech_active=False, pending_final=False, other_source_spoke=False, cfg=CFG)
        assert d.state is CompletionState.COMPLETE

    def test_dangling_needs_extended_pause(self):
        d = evaluate_completion("Can you explain", 2500, all_final=True, speech_active=False, pending_final=False, other_source_spoke=False, cfg=CFG)
        assert d.state is CompletionState.AWAITING

    def test_never_complete_while_speaking(self):
        d = evaluate_completion("What is X?", 99_999, all_final=True, speech_active=True, pending_final=False, other_source_spoke=False, cfg=CFG)
        assert d.state is CompletionState.IN_PROGRESS

    def test_bounded_timeout_when_final_missing(self):
        d = evaluate_completion("What is X", CFG.max_completion_timeout_ms, all_final=False, speech_active=False, pending_final=True, other_source_spoke=False, cfg=CFG)
        assert d.state is CompletionState.COMPLETE and d.possibly_incomplete


class TestManualOperations:
    def test_edit_locks_question(self):
        f = make_feeder()
        f.say("What is polymorhism?")
        q = f.questions[0]
        evs = f.engine.edit_question(q.question_id, "What is polymorphism in Java?", f.t)
        assert evs[0].question.state is S.MANUALLY_EDITED
        assert q.edit_history[-1]["before"] == "What is polymorhism?"
        assert q.raw_text == "What is polymorhism?"

    def test_merge_and_split(self):
        f = make_feeder()
        f.say("What is a microservice?")
        f.say("Why would you use one?")
        a, b = f.questions
        f.engine.merge_questions([a.question_id, b.question_id], f.t)
        merged = f.questions
        assert len(merged) == 1 and merged[0].formatted_text == "What is a microservice? Why would you use one?"
        evs = f.engine.split_question(merged[0].question_id, len("What is a microservice?"), f.t)
        texts = sorted(q.formatted_text for q in f.questions)
        assert texts == ["What is a microservice?", "Why would you use one?"]
        assert evs[-1].event_type.value == "question.created"

    def test_discard(self):
        f = make_feeder()
        f.say("What is polymorphism?")
        f.engine.discard_question(f.questions[0].question_id)
        assert f.questions == []

    def test_manual_question(self):
        f = make_feeder()
        evs = f.engine.create_manual("explain the cap theorem", 0)
        assert evs[0].question.formatted_text == "Explain the CAP theorem." and evs[0].question.state is S.COMPLETE

    def test_restore_after_restart_keeps_context(self):
        f = make_feeder()
        f.say("What is HashMap in Java?")
        saved = list(f.engine.questions.values())
        g = make_feeder(prefix="r")
        g.engine.restore(saved)
        g.t = f.t
        g.say("How is it different from TreeMap?")
        assert g.questions[-1].resolved_text == "How is HashMap different from TreeMap in Java?"
