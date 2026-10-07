"""Offline evaluation and ablation runner for the FoxCode memory pipeline.

Run from the repository root:
    uv run python tests/memory_eval.py
"""

from __future__ import annotations

import argparse
import json
import math
import tempfile
from typing import Iterable
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean

from fox_coding_agent.src.extensions.memory.injection import build_memory_context
from fox_coding_agent.src.extensions.memory.models import MemoryEntry, ScoreBreakdown, SearchResult
from fox_coding_agent.src.extensions.memory.retrieval import HybridRetriever, RetrievalConfig, normalize, tokens
from fox_coding_agent.src.extensions.memory.store import MemoryStore

FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "memory_eval"
EVAL_NOW = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)

def baseline_search(entries: Iterable[MemoryEntry], query: str, *, limit: int = 5) -> list[SearchResult]:
    """The pre-redesign algorithm, retained as an honest evaluation baseline."""
    query_text = normalize(query)
    query_terms = tokens(query_text)
    ranked: list[SearchResult] = []
    for entry in entries:
        name, description, content = map(normalize, (entry.name, entry.description, entry.content))
        score = 100.0 if entry.pinned else 0.0
        score += 12.0 if query_text in name else 0.0
        score += 8.0 if query_text in description else 0.0
        score += 3.0 if query_text in content else 0.0
        score += len(query_terms & tokens(name)) * 6
        score += len(query_terms & tokens(description)) * 3
        score += len(query_terms & tokens(content))
        if score > 0:
            ranked.append(SearchResult(
                entry, score, 1.0, ScoreBreakdown(contextual_bm25f=score)
            ))
    ranked.sort(key=lambda item: (-item.score, item.entry.filename))
    return ranked[:limit]


@dataclass(frozen=True)
class Metrics:
    recall_at_k: float
    precision_at_k: float
    hit_at_1: float
    mrr: float
    ndcg_at_k: float
    false_positive_rate: float
    stale_return_rate: float
    injection_precision: float
    avg_injected_chars: float
    budget_violations: int


def _read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def _dcg(predicted: list[str], relevant: set[str]) -> float:
    return sum(1.0 / math.log2(index + 2) for index, item in enumerate(predicted) if item in relevant)


def _rank(experiment: str, entries: list[MemoryEntry], query: dict, k: int) -> list[SearchResult]:
    if experiment == "baseline":
        return baseline_search(entries, query["query"], limit=k)
    overrides = {
        "full": {},
        "no_conversation_context": {"use_conversation_context": False},
        "no_concept_graph": {"use_concept_graph": False},
        "no_temporal_truth": {"use_temporal_truth": False},
        "no_abstention": {"use_threshold": False},
    }[experiment]
    retriever = HybridRetriever(entries, RetrievalConfig(**overrides), now=EVAL_NOW)
    return retriever.search(query["query"], limit=k, context=query.get("context"))


def evaluate_retrieval(experiment: str, entries: list[MemoryEntry], queries: list[dict],
                       stale_ids: set[str], *, k: int = 5,
                       injection_budget: int = 1600) -> Metrics:
    recalls: list[float] = []
    precisions: list[float] = []
    hits_at_1: list[float] = []
    reciprocal_ranks: list[float] = []
    ndcgs: list[float] = []
    null_false_positives: list[float] = []
    stale_returns = 0
    total_returns = 0
    injection_precisions: list[float] = []
    injection_chars: list[int] = []
    budget_violations = 0

    for query in queries:
        results = _rank(experiment, entries, query, k)
        predicted = [result.entry.filename for result in results]
        relevant = set(query["relevant_ids"])
        stale_returns += len(set(predicted) & stale_ids)
        total_returns += len(predicted)
        if relevant:
            matched = relevant & set(predicted)
            recalls.append(len(matched) / len(relevant))
            precisions.append(len(matched) / max(1, len(predicted)))
            hits_at_1.append(float(bool(predicted and predicted[0] in relevant)))
            first = next((index for index, item in enumerate(predicted, 1) if item in relevant), None)
            reciprocal_ranks.append(1.0 / first if first else 0.0)
            ideal = sum(1.0 / math.log2(index + 2) for index in range(min(len(relevant), k)))
            ndcgs.append(_dcg(predicted, relevant) / ideal if ideal else 0.0)
        else:
            null_false_positives.append(float(bool(predicted)))

        report = build_memory_context(results, injection_budget)
        if report.text:
            injection_precisions.append(len(set(report.included) & relevant) / len(report.included))
            injection_chars.append(report.used_chars)
        elif relevant:
            injection_precisions.append(0.0)
            injection_chars.append(0)
        if report.used_chars > injection_budget:
            budget_violations += 1

    return Metrics(
        recall_at_k=mean(recalls), precision_at_k=mean(precisions), hit_at_1=mean(hits_at_1),
        mrr=mean(reciprocal_ranks), ndcg_at_k=mean(ndcgs),
        false_positive_rate=mean(null_false_positives),
        stale_return_rate=stale_returns / max(1, total_returns),
        injection_precision=mean(injection_precisions),
        avg_injected_chars=mean(injection_chars), budget_violations=budget_violations,
    )


def evaluate_write_policy(cases: list[dict]) -> dict[str, float | int]:
    correct = 0
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        project = root / "project"
        project.mkdir()
        store = MemoryStore(root / "user", project)
        for case in cases:
            values = {key: value for key, value in case.items()
                      if key not in {"id", "accepted"}}
            decision = store.assess_write(**values)
            correct += decision.accepted == case["accepted"]
    return {"cases": len(cases), "correct": correct, "accuracy": correct / max(1, len(cases))}


def run(fixture_root: Path = FIXTURE_ROOT, *, k: int = 5) -> dict:
    entries = MemoryStore.load_directory(fixture_root / "store")
    queries = _read_jsonl(fixture_root / "queries.jsonl")
    manifest = json.loads((fixture_root / "manifest.json").read_text(encoding="utf-8"))
    if len(entries) != 50 or len(queries) != 120:
        raise ValueError(f"Invalid fixture: expected 50 memories/120 queries, got {len(entries)}/{len(queries)}")
    stale_ids = set(manifest["superseded_ids"] + manifest["expired_ids"])
    experiments = [
        "baseline", "no_conversation_context", "no_concept_graph",
        "no_temporal_truth", "no_abstention", "full",
    ]
    metrics = {
        experiment: asdict(evaluate_retrieval(experiment, entries, queries, stale_ids, k=k))
        for experiment in experiments
    }
    write_policy = evaluate_write_policy(_read_jsonl(fixture_root / "write_cases.jsonl"))
    counts = {kind: sum(query["kind"] == kind for query in queries)
              for kind in ("literal", "paraphrase", "referential", "none")}
    return {
        "fixture": {"memories": len(entries), "queries": len(queries), "query_types": counts,
                    "superseded": len(manifest["superseded_ids"]),
                    "expired": len(manifest["expired_ids"])},
        "settings": {"k": k, "injection_budget_chars": 1600, "evaluation_time": EVAL_NOW.isoformat()},
        "write_policy": write_policy,
        "experiments": metrics,
    }


def _table(report: dict) -> str:
    columns = ("recall_at_k", "precision_at_k", "hit_at_1", "mrr", "ndcg_at_k",
               "false_positive_rate", "stale_return_rate", "injection_precision")
    labels = ("R@5", "P@5", "Hit@1", "MRR", "nDCG", "Null-FPR", "Stale", "Inject-P")
    lines = ["experiment              " + " ".join(f"{label:>9}" for label in labels),
             "-" * 100]
    for name, metrics in report["experiments"].items():
        lines.append(f"{name:<23}" + " ".join(f"{metrics[column]:9.3f}" for column in columns))
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate and ablate the FoxCode memory pipeline")
    parser.add_argument("--fixtures", type=Path, default=FIXTURE_ROOT)
    parser.add_argument("--k", type=int, default=5)
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    parser.add_argument("--output", type=Path, help="also write the full JSON report")
    args = parser.parse_args()
    report = run(args.fixtures, k=args.k)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"fixture: {report['fixture']}")
        print(f"write policy: {report['write_policy']}")
        print(_table(report))


if __name__ == "__main__":
    main()
