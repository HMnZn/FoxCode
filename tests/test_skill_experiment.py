"""Checks for the single API-Bank three-arm coding experiment."""

import json

from fox_coding_agent.src.extensions.skill_evolution.fixtures.experiment import (
    ROOT, api_bank_rows, grade, paired, split,
)


def test_file_disjoint_final_holdout():
    rows = api_bank_rows()
    parts = split(rows, "api-bank-final")
    assert [len(parts[name]) for name in ("train", "validation", "test")] == [80, 40, 159]
    names = [{row["file"] for row in parts[part]} for part in parts]
    assert not (names[0] & names[1] or names[0] & names[2] or names[1] & names[2])
    assert parts == split(rows, "api-bank-final")


def test_request_scoring_is_structural():
    row = {"instruction": "", "input": "", "expected_output": "API-Request: [Search(q='x')]"}
    assert grade("api-bank-final", row, "API-Request: [Search(q='x')]")["passed"]
    assert not grade("api-bank-final", row, "API-Request: [Search(q='y')]")["passed"]
    assert not grade("api-bank-final", row, "not a request")["parseable"]


def test_paired_comparison_requires_same_tasks():
    left = [{"id": "a", "passed": False}, {"id": "b", "passed": True}]
    right = [{"id": "b", "passed": True}, {"id": "a", "passed": True}]
    result = paired(left, right)
    assert result["wins"] == 1 and result["losses"] == 0
    try:
        paired(left, [{"id": "c", "passed": True}])
    except ValueError:
        pass
    else:
        raise AssertionError("Mismatched test rows were accepted")


def test_saved_three_arm_result_has_complete_test_sets():
    root = ROOT / "api_bank_eval"
    report = json.loads((root / "results.json").read_text())
    arms = report["test"]["results"]
    assert set(arms) == {"baseline", "initial", "evolved"}
    assert all(len(arm) == 159 for arm in arms.values())
    assert all(row["error"] is None for arm in arms.values() for row in arm)
