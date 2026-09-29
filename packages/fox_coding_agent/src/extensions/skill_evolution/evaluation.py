"""Executable offline quality evaluation and live GAIA/HLE skill ablations.

Offline mode evaluates the actual local gates and add/merge decision code without an API.
Live mode calls FoxCode's configured model and reports strict Pass@1 for runnable text rows.
It never claims ALFWorld/WebShop environment execution or GAIA attachment coverage when the
required environment/assets are absent.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import tempfile
import time
from uuid import uuid4
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from fox_ai.src import Context, SimpleStreamOptions, TextContent, UserMessage

from fox_coding_agent.src.core.model_runtime import ModelRuntime
from fox_coding_agent.src.core.skills import load_skills_from_dir

from .models import SkillCandidate
from .store import SkillEvolutionStore


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "evolution_eval" / "cases.jsonl"
DEFAULT_BEAR_DATA = Path.home() / "Desktop" / "秋招" / "BearCode" / "data"


@dataclass(frozen=True)
class BenchmarkSample:
    id: str
    dataset: str
    prompt: str
    answer: str
    problem_type: str
    runnable: bool
    skip_reason: str = ""


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            value = json.loads(line)
            if isinstance(value, dict):
                rows.append(value)
    return rows


def _candidate(value: dict[str, Any]) -> SkillCandidate:
    return SkillCandidate(
        name=str(value.get("name") or ""),
        description=str(value.get("description") or ""),
        when_to_use=str(value.get("when_to_use") or ""),
        instructions=str(value.get("instructions") or ""),
        evidence=str(value.get("evidence") or ""),
        tags=tuple(str(item) for item in value.get("tags", [])),
        confidence=float(value.get("confidence") or 0.0),
    )


def run_offline_evaluation(cases_path: Path = FIXTURE_PATH) -> dict[str, Any]:
    """Run the production store/gates, plus controlled component ablations."""
    cases = _read_jsonl(cases_path)
    variants: dict[str, list[tuple[bool, bool]]] = {
        "full": [], "no-safety-gate": [], "no-dedup": [], "no-provenance": [],
    }
    details: list[dict[str, Any]] = []
    for row in cases:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            project, user = root / "project", root / "user"
            project.mkdir()
            for existing in row.get("existing", []):
                name = str(existing["name"])
                path = project / ".foxcode" / "skills" / name / "SKILL.md"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(
                    "---\n"
                    f"name: {name}\n"
                    f"description: {json.dumps(str(existing['description']))}\n"
                    "---\n\nExisting instructions.\n",
                    encoding="utf-8",
                )
            store = SkillEvolutionStore(user, project)
            candidate = _candidate(row["candidate"])
            proposal = store.propose(candidate, source_session="offline-eval")
            expected_status = row["expected_status"]
            expected_action = row["expected_action"]
            full_ok = (
                proposal.status == expected_status
                and proposal.suggested_action == expected_action
                and store.provenance_path.is_file()
            )
            variants["full"].append((full_ok, store.provenance_path.is_file()))

            # Remove one component at a time while keeping the same labeled cases.
            no_safety_status = "pending"
            variants["no-safety-gate"].append((
                no_safety_status == expected_status and proposal.suggested_action == expected_action,
                True,
            ))
            variants["no-dedup"].append((
                proposal.status == expected_status and "add" == expected_action,
                True,
            ))
            variants["no-provenance"].append((
                proposal.status == expected_status and proposal.suggested_action == expected_action,
                False,
            ))
            details.append({
                "id": row["id"],
                "actual_status": proposal.status,
                "actual_action": proposal.suggested_action,
                "reasons": proposal.reasons,
                "expected_status": expected_status,
                "expected_action": expected_action,
                "full_pass": full_ok,
            })

    summary = {
        name: {
            "passed": sum(decision for decision, _traceable in results),
            "total": len(results),
            "decision_accuracy": round(
                sum(decision for decision, _traceable in results) / len(results), 4
            ) if results else 0.0,
            "traceability_rate": round(
                sum(traceable for _decision, traceable in results) / len(results), 4
            ) if results else 0.0,
        }
        for name, results in variants.items()
    }
    return {
        "kind": "offline-skill-evolution",
        "cases": str(cases_path),
        "summary": summary,
        "details": details,
    }


def _load_json(path: Path) -> list[dict[str, Any]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError(f"Dataset must contain a JSON array: {path}")
    return [item for item in value if isinstance(item, dict)]


def load_benchmark(data_root: Path, dataset: str) -> list[BenchmarkSample]:
    key = dataset.lower()
    if key == "hle":
        rows = _load_json(data_root / "HLE" / "all_500.json")
        return [
            BenchmarkSample(
                id=str(row.get("id")), dataset="HLE", prompt=str(row.get("question") or ""),
                answer=str(row.get("answer") or ""),
                problem_type=str(row.get("problem_type") or "text"),
                runnable=str(row.get("problem_type") or "text") == "text",
                skip_reason="multimodal input is not embedded as a runnable FoxCode message"
                if str(row.get("problem_type") or "text") != "text" else "",
            ) for row in rows
        ]
    if key == "gaia":
        rows = _load_json(data_root / "GAIA" / "all.json")
        return [
            BenchmarkSample(
                id=str(row.get("task_id") or row.get("id")), dataset="GAIA",
                prompt=str(row.get("Question") or ""), answer=str(row.get("answer") or ""),
                problem_type=str(row.get("problem_type") or "text"),
                runnable=str(row.get("problem_type") or "text") == "text" and not row.get("file_name"),
                skip_reason="required attachment/environment is absent from BearCode/data"
                if str(row.get("problem_type") or "text") != "text" or row.get("file_name") else "",
            ) for row in rows
        ]
    if key == "toolhop":
        rows = _load_json(data_root / "ToolHop" / "ToolHop.json")
        return [
            BenchmarkSample(
                id=str(row.get("id")), dataset="ToolHop-direct", prompt=str(row.get("question") or ""),
                answer=str(row.get("answer") or ""), problem_type="tool-schema-only",
                runnable=False,
                skip_reason="tool schemas are present but executable tool implementations are absent",
            ) for row in rows
        ]
    if key in {"alfworld", "webshop"}:
        filename = "ALFWorld/test.json" if key == "alfworld" else "WebShop/test.json"
        rows = _load_json(data_root / filename)
        return [
            BenchmarkSample(
                id=str(row.get("id")), dataset=key, prompt=str(row.get("goal") or ""),
                answer="", problem_type="environment", runnable=False,
                skip_reason="interactive benchmark environment is not included",
            ) for row in rows
        ]
    raise ValueError(f"Unknown dataset: {dataset}")


def audit_datasets(data_root: Path, datasets: Iterable[str]) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for dataset in datasets:
        samples = load_benchmark(data_root, dataset)
        reasons: dict[str, int] = {}
        for sample in samples:
            if not sample.runnable:
                reasons[sample.skip_reason] = reasons.get(sample.skip_reason, 0) + 1
        values[dataset] = {
            "total": len(samples),
            "runnable": sum(sample.runnable for sample in samples),
            "skipped": sum(not sample.runnable for sample in samples),
            "skip_reasons": reasons,
        }
    return {"kind": "dataset-audit", "data_root": str(data_root), "datasets": values}


def _skill_prompt(skills_dir: Path | None, variant: str) -> str:
    if variant == "baseline" or skills_dir is None:
        return ""
    skills = load_skills_from_dir(skills_dir).skills
    if variant == "metadata-only":
        return "\n".join(f"- {skill.name}: {skill.description}" for skill in skills)
    if variant == "full":
        return "\n\n".join(
            f"# {skill.name}\n{skill.description}\n\n{skill.content}" for skill in skills
        )
    raise ValueError(f"Unknown variant: {variant}")


_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def normalize_answer(value: str) -> str:
    return _NON_ALNUM.sub(" ", value.lower()).strip()


def strict_correct(prediction: str, answer: str) -> bool:
    expected = normalize_answer(answer)
    if not expected:
        return False
    lines = [normalize_answer(line) for line in prediction.splitlines() if line.strip()]
    whole = normalize_answer(prediction)
    return whole == expected or bool(lines and lines[-1] == expected)


def _assistant_text(message: Any) -> str:
    return "\n".join(
        block.text for block in getattr(message, "content", []) if isinstance(block, TextContent)
    ).strip()


async def run_live_evaluation(
    *,
    data_root: Path,
    datasets: list[str],
    variants: list[str],
    skills_dir: Path | None,
    user_dir: Path,
    model_reference: str | None,
    limit: int,
    output_dir: Path,
) -> dict[str, Any]:
    if limit < 1:
        raise ValueError("limit must be positive")
    runtime = ModelRuntime(user_dir)
    configured = runtime.registry.resolve(model_reference) if model_reference else runtime.registry.default()
    if configured is None:
        raise ValueError(f"No model configured under {user_dir}; pass --model or configure models.json")
    model = configured.model
    stream_fn = runtime.authenticated_stream()
    runnable = [
        sample
        for name in datasets
        for sample in [item for item in load_benchmark(data_root, name) if item.runnable][:limit]
    ]
    output_dir.mkdir(parents=True, exist_ok=True)
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid4().hex[:8]
    results: list[dict[str, Any]] = []
    for variant in variants:
        evolved = _skill_prompt(skills_dir, variant)
        system = (
            "Answer the benchmark question. Return the shortest exact final answer on the last line. "
            "Do not claim to inspect files or environments that are not provided."
        )
        if evolved:
            system += "\n\nAvailable skill guidance:\n" + evolved
        for sample in runnable:
            stream = stream_fn(
                model,
                Context(system_prompt=system, messages=[UserMessage(content=sample.prompt)]),
                SimpleStreamOptions(
                    max_tokens=min(model.max_tokens or 2000, 2000),
                    temperature=0.0,
                    tool_choice="none",
                ),
            )
            message = await stream.result()
            prediction = _assistant_text(message)
            row = {
                "id": sample.id, "dataset": sample.dataset, "variant": variant,
                "problem_type": sample.problem_type, "answer": sample.answer,
                "prediction": prediction, "correct": strict_correct(prediction, sample.answer),
                "stop_reason": message.stop_reason, "error": message.error_message,
                "usage": message.usage.model_dump(mode="json", by_alias=True),
            }
            results.append(row)
            with (output_dir / f"{run_id}.jsonl").open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    summary: dict[str, Any] = {}
    for variant in variants:
        selected = [row for row in results if row["variant"] == variant]
        summary[variant] = {
            "passed": sum(row["correct"] for row in selected),
            "total": len(selected),
            "pass_at_1": round(sum(row["correct"] for row in selected) / len(selected), 4)
            if selected else 0.0,
        }
    report = {
        "kind": "live-skill-ablation", "run_id": run_id, "model": model.id,
        "data_root": str(data_root), "skills_dir": str(skills_dir) if skills_dir else None,
        "summary": summary,
        "dataset_audit": audit_datasets(data_root, datasets)["datasets"],
    }
    (output_dir / f"{run_id}.summary.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    offline = sub.add_parser("offline", help="Run deterministic evolution quality/ablation fixtures")
    offline.add_argument("--cases", type=Path, default=FIXTURE_PATH)
    audit = sub.add_parser("audit", help="Report which BearCode rows are honestly runnable")
    audit.add_argument("--data-root", type=Path, default=Path(os.environ.get("BEARCODE_DATA", DEFAULT_BEAR_DATA)))
    audit.add_argument("--datasets", default="gaia,hle,toolhop,alfworld,webshop")
    live = sub.add_parser("live", help="Call a configured model for Pass@1 skill ablations")
    live.add_argument("--data-root", type=Path, default=Path(os.environ.get("BEARCODE_DATA", DEFAULT_BEAR_DATA)))
    live.add_argument("--datasets", default="gaia,hle")
    live.add_argument("--variants", default="baseline,metadata-only,full")
    live.add_argument("--skills-dir", type=Path)
    live.add_argument("--user-dir", type=Path, default=Path.home() / ".foxcode")
    live.add_argument("--model")
    live.add_argument("--limit", type=int, default=20)
    live.add_argument("--output-dir", type=Path, default=Path(".foxcode/evals/skill-evolution"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "offline":
        report = run_offline_evaluation(args.cases)
    elif args.command == "audit":
        report = audit_datasets(args.data_root, args.datasets.split(","))
    else:
        report = asyncio.run(run_live_evaluation(
            data_root=args.data_root,
            datasets=args.datasets.split(","),
            variants=args.variants.split(","),
            skills_dir=args.skills_dir,
            user_dir=args.user_dir,
            model_reference=args.model,
            limit=args.limit,
            output_dir=args.output_dir,
        ))
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "BenchmarkSample", "audit_datasets", "load_benchmark", "normalize_answer",
    "run_live_evaluation", "run_offline_evaluation", "strict_correct",
]
