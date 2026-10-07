"""Regression checks for the checked-in memory golden set."""

from dataclasses import fields

from fox_coding_agent.src.extensions.memory import ScoreBreakdown
from memory_eval import run


def test_retrieval_score_has_exactly_three_explainable_signals():
    assert [field.name for field in fields(ScoreBreakdown)] == [
        "contextual_bm25f", "concept_graph", "temporal_truth",
    ]


def test_memory_eval_fixture_and_full_pipeline_improve_over_baseline():
    report = run()
    assert report["fixture"]["memories"] == 50
    assert report["fixture"]["queries"] == 120
    baseline = report["experiments"]["baseline"]
    full = report["experiments"]["full"]
    assert full["recall_at_k"] > baseline["recall_at_k"]
    assert full["mrr"] > baseline["mrr"]
    assert full["false_positive_rate"] < baseline["false_positive_rate"]
    assert full["stale_return_rate"] == 0
    assert full["budget_violations"] == 0
    assert report["write_policy"]["accuracy"] == 1.0
