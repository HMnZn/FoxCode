"""Executable offline quality evaluation and live skill ablations.

Offline mode evaluates the actual local gates and add/merge decision code without an API.
Live mode calls FoxCode's configured model and reports strict Pass@1 for runnable text rows.
It never claims environment execution or attachment coverage when the
required environment/assets are absent.
"""

from __future__ import annotations

import argparse
import asyncio
import difflib
import hashlib
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
from fox_coding_agent.src.core.skills import (
    load_skill_from_file,
    load_skills_from_dir,
    parse_frontmatter,
)

from .extraction import extract_candidate
from .models import SkillCandidate
from .store import SkillEvolutionStore


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "evolution_eval" / "cases.jsonl"
DEFAULT_SEED_SKILL = (
    Path(__file__).parent / "fixtures" / "evolution_eval" / "household_task_planner_v0.md"
)
DEFAULT_DATA_ROOT = Path(__file__).parent / "data"


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
                skip_reason="required attachment/environment is absent from the provided data directory"
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


_ACTION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("take", re.compile(r"\b(take|pick\s+up|grab)\b", re.I)),
    ("clean", re.compile(r"\b(clean|wash|rinse)\b", re.I)),
    ("cool", re.compile(r"\b(cool|chill)\b", re.I)),
    ("heat", re.compile(r"\b(heat|warm)\b", re.I)),
    ("place", re.compile(r"\b(place|put|set)\b", re.I)),
    ("observe", re.compile(r"\b(observe|find|locate|search|inspect|look|see)\b", re.I)),
)


def expected_plan_actions(subgoals: str) -> list[str]:
    """Translate dataset subgoal patterns into provider-neutral action labels."""
    actions: list[str] = []
    for line in str(subgoals or "").splitlines():
        low = line.lower()
        if "you see" in low:
            actions.append("observe")
        elif "pick up" in low:
            actions.append("take")
        elif "you clean" in low:
            actions.append("clean")
        elif "you cool" in low:
            actions.append("cool")
        elif "you heat" in low:
            actions.append("heat")
        elif "you put" in low:
            actions.append("place")
    return actions


def predicted_plan_actions(prediction: str) -> list[str]:
    actions: list[str] = []
    for line in str(prediction or "").splitlines():
        matches = [
            (match.start(), action)
            for action, pattern in _ACTION_PATTERNS
            if (match := pattern.search(line)) is not None
        ]
        if matches:
            actions.append(min(matches)[1])
    return actions


def _lcs_length(left: list[str], right: list[str]) -> int:
    row = [0] * (len(right) + 1)
    for item in left:
        previous = 0
        for index, other in enumerate(right, start=1):
            saved = row[index]
            row[index] = previous + 1 if item == other else max(row[index], row[index - 1])
            previous = saved
    return row[-1]


def _target_object(subgoals: str) -> str:
    match = re.search(r"(?:a|the)\s+([a-z][a-z0-9_-]*)\s+(?:\\d\+|\d+)", subgoals, re.I)
    return match.group(1).lower() if match else ""


def score_household_plan(goal: str, subgoals: str, prediction: str) -> dict[str, Any]:
    expected = expected_plan_actions(subgoals)
    predicted = predicted_plan_actions(prediction)
    matched = _lcs_length(expected, predicted)
    action_recall = round(matched / len(expected), 4) if expected else 0.0
    target = _target_object(subgoals)
    object_mentioned = bool(target and re.search(rf"\b{re.escape(target)}\b", prediction, re.I))
    quantity_ok = True
    if re.search(r"\btwo\b", goal, re.I):
        quantity_ok = bool(
            re.search(r"\b(two|2)\b", prediction, re.I)
            or predicted.count("take") >= 2
        )
    passed = bool(expected and matched == len(expected) and object_mentioned and quantity_ok)
    return {
        "expected_actions": expected,
        "predicted_actions": predicted,
        "action_recall": action_recall,
        "object": target,
        "object_mentioned": object_mentioned,
        "quantity_ok": quantity_ok,
        "passed": passed,
    }


def _assistant_text(message: Any) -> str:
    return "\n".join(
        block.text for block in getattr(message, "content", []) if isinstance(block, TextContent)
    ).strip()


def _usage(message: Any) -> dict[str, Any]:
    usage = getattr(message, "usage", None)
    return usage.model_dump(mode="json", by_alias=True) if usage is not None else {}


async def _call_text_model(
    *,
    stream_fn: Any,
    model: Any,
    system: str,
    prompt: str,
    max_tokens: int,
    retries: int = 1,
) -> dict[str, Any]:
    """Call the configured provider and retain every attempt for auditability."""
    attempts: list[dict[str, Any]] = []
    for attempt in range(retries + 1):
        try:
            stream = stream_fn(
                model,
                Context(system_prompt=system, messages=[UserMessage(content=prompt)]),
                SimpleStreamOptions(
                    max_tokens=max_tokens, temperature=0.0, tool_choice="none",
                ),
            )
            message = await stream.result()
            text = _assistant_text(message)
            error = str(message.error_message or "")
            record = {
                "attempt": attempt + 1,
                "stop_reason": message.stop_reason,
                "error": error or None,
                "usage": _usage(message),
            }
            attempts.append(record)
            if message.stop_reason != "error" and not error:
                return {"text": text, **record, "attempts": attempts}
        except Exception as exc:
            attempts.append({
                "attempt": attempt + 1,
                "stop_reason": "exception",
                "error": f"{type(exc).__name__}: {exc}"[:1000],
                "usage": {},
            })
    last = attempts[-1]
    return {"text": "", **last, "attempts": attempts}


def _planning_system(skill_content: str = "") -> str:
    system = (
        "Turn the household goal into a minimal ordered action plan. "
        "Write one action per line and do not claim that any action was executed."
    )
    if skill_content:
        system += f"\n\n<skill name=\"household-task-planner\">\n{skill_content}\n</skill>"
    return system


async def _evaluate_household_rows(
    *,
    rows: list[dict[str, Any]],
    variant: str,
    skill_content: str,
    stream_fn: Any,
    model: Any,
    retries: int = 1,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for row in rows:
        goal = str(row.get("goal") or "")
        call = await _call_text_model(
            stream_fn=stream_fn,
            model=model,
            system=_planning_system(skill_content),
            prompt=goal,
            max_tokens=300,
            retries=retries,
        )
        prediction = str(call["text"])
        score = score_household_plan(goal, str(row.get("subgoals") or ""), prediction)
        results.append({
            "id": row.get("id"),
            "variant": variant,
            "goal": goal,
            "difficulty": row.get("difficulty"),
            "prediction": prediction,
            "stop_reason": call["stop_reason"],
            "error": call["error"],
            "usage": call["usage"],
            "attempts": call["attempts"],
            **score,
        })
    return results


def _planning_summary(results: list[dict[str, Any]], variants: Iterable[str]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for variant in variants:
        selected = [row for row in results if row["variant"] == variant]
        total = len(selected)
        summary[variant] = {
            "passed": sum(bool(row["passed"]) for row in selected),
            "total": total,
            "plan_pass_rate": round(
                sum(bool(row["passed"]) for row in selected) / total, 4
            ) if total else 0.0,
            "mean_action_recall": round(
                sum(float(row["action_recall"]) for row in selected) / total, 4
            ) if total else 0.0,
            "input_tokens": sum(int(row["usage"].get("input", 0) or 0) for row in selected),
            "output_tokens": sum(int(row["usage"].get("output", 0) or 0) for row in selected),
            "errors": sum(bool(row["error"]) for row in selected),
        }
    return summary


def build_evolution_feedback(
    failures: list[dict[str, Any]], *, skill_name: str
) -> str:
    """Create explicit evaluator feedback from labeled failures, never from held-out rows."""
    examples = []
    for row in failures[:12]:
        expected = " -> ".join(str(item).upper() for item in row["expected_actions"])
        predicted = " -> ".join(str(item).upper() for item in row["predicted_actions"]) or "none"
        examples.append(
            f"- goal={row['goal']!r}; expected={expected}; predicted={predicted}"
        )
    evidence = "\n".join(examples) or "- no failed example was supplied"
    return (
        f"Update the existing {skill_name} skill for future household-planning tasks. "
        "Use that exact skill name. The reusable correction is: emit one canonical action per "
        "line; OBSERVE the target before TAKE; TAKE before CLEAN, COOL, HEAT, or PLACE; perform "
        "the requested state transformation before placement; preserve requested quantities; "
        "and for look/examine goals, take the object before observing the named device. "
        "Do not claim environment execution. These labeled evolution-set failures support the "
        f"correction:\n{evidence}"
    )


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _read_jsonl_objects(path: Path) -> list[dict[str, Any]]:
    return _read_jsonl(path) if path.is_file() else []


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


async def run_household_planning_evaluation(
    *,
    data_path: Path,
    skill_path: Path,
    user_dir: Path,
    model_reference: str | None,
    limit: int,
    output_path: Path,
) -> dict[str, Any]:
    """Real API baseline/full comparison for plan decomposition, not environment success."""
    if limit < 1:
        raise ValueError("limit must be positive")
    rows = _load_json(data_path)[:limit]
    skill, diagnostics = load_skill_from_file(skill_path)
    if skill is None:
        raise ValueError("Cannot load evaluation skill: " + "; ".join(d.message for d in diagnostics))

    runtime = ModelRuntime(user_dir)
    configured = runtime.registry.resolve(model_reference) if model_reference else runtime.registry.default()
    if configured is None:
        raise ValueError(f"No model configured under {user_dir}; pass --model or configure models.json")
    model = configured.model
    stream_fn = runtime.authenticated_stream()
    base_system = (
        "Turn the household goal into a minimal ordered action plan. "
        "Write one action per line and do not claim that any action was executed."
    )
    results: list[dict[str, Any]] = []
    for variant in ("baseline", "full"):
        system = base_system
        if variant == "full":
            system += f"\n\n<skill name=\"{skill.name}\">\n{skill.content}\n</skill>"
        for row in rows:
            goal = str(row.get("goal") or "")
            stream = stream_fn(
                model,
                Context(system_prompt=system, messages=[UserMessage(content=goal)]),
                SimpleStreamOptions(max_tokens=300, temperature=0.0, tool_choice="none"),
            )
            message = await stream.result()
            prediction = _assistant_text(message)
            score = score_household_plan(goal, str(row.get("subgoals") or ""), prediction)
            results.append({
                "id": row.get("id"),
                "variant": variant,
                "goal": goal,
                "difficulty": row.get("difficulty"),
                "prediction": prediction,
                "stop_reason": message.stop_reason,
                "error": message.error_message,
                "usage": message.usage.model_dump(mode="json", by_alias=True),
                **score,
            })

    summary: dict[str, Any] = {}
    for variant in ("baseline", "full"):
        selected = [row for row in results if row["variant"] == variant]
        summary[variant] = {
            "passed": sum(row["passed"] for row in selected),
            "total": len(selected),
            "plan_pass_rate": round(sum(row["passed"] for row in selected) / len(selected), 4),
            "mean_action_recall": round(
                sum(row["action_recall"] for row in selected) / len(selected), 4
            ),
            "input_tokens": sum(row["usage"].get("input", 0) for row in selected),
            "output_tokens": sum(row["usage"].get("output", 0) for row in selected),
            "errors": sum(bool(row["error"]) for row in selected),
        }
    report = {
        "kind": "household-planning-skill-ablation",
        "claim_boundary": "plan decomposition only; no interactive environment was executed",
        "model": configured.reference,
        "skill": {"name": skill.name, "path": str(skill_path)},
        "data": {"path": str(data_path), "sample_count": len(rows)},
        "summary": summary,
        "effect": {
            "plan_pass_rate_delta": round(
                summary["full"]["plan_pass_rate"] - summary["baseline"]["plan_pass_rate"], 4
            ),
            "mean_action_recall_delta": round(
                summary["full"]["mean_action_recall"]
                - summary["baseline"]["mean_action_recall"], 4
            ),
        },
        "results": results,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return report


async def run_household_self_evolution_evaluation(
    *,
    data_path: Path,
    seed_skill_path: Path,
    user_dir: Path,
    model_reference: str | None,
    evolution_limit: int,
    test_limit: int,
    output_path: Path,
    retries: int = 1,
) -> dict[str, Any]:
    """Run a real API extract/propose/apply/reload/held-out-evaluate cycle.

    The active user Skill is copied into an isolated user-level layout. Applying the
    proposal therefore exercises production storage and versioning without mutating the
    caller's live Skill directory.
    """
    if evolution_limit < 1 or test_limit < 1:
        raise ValueError("evolution-limit and test-limit must be positive")
    all_rows = _load_json(data_path)
    required = evolution_limit + test_limit
    if len(all_rows) < required:
        raise ValueError(f"Dataset needs at least {required} rows, found {len(all_rows)}")
    evolution_rows = all_rows[:evolution_limit]
    heldout_rows = all_rows[evolution_limit:required]
    evolution_ids = [str(row.get("id")) for row in evolution_rows]
    heldout_ids = [str(row.get("id")) for row in heldout_rows]
    if set(evolution_ids) & set(heldout_ids):
        raise ValueError("Evolution and held-out sample ids must be disjoint")

    runtime = ModelRuntime(user_dir)
    configured = runtime.registry.resolve(model_reference) if model_reference else runtime.registry.default()
    if configured is None:
        raise ValueError(f"No model configured under {user_dir}; pass --model or configure models.json")
    model = configured.model
    stream_fn = runtime.authenticated_stream()

    seed_text = seed_skill_path.read_text(encoding="utf-8")
    seed_skill, diagnostics = load_skill_from_file(seed_skill_path)
    if seed_skill is None:
        raise ValueError("Cannot load seed skill: " + "; ".join(d.message for d in diagnostics))
    seed_metadata, _seed_body = parse_frontmatter(seed_text)
    seed_version = str(seed_metadata.get("version") or "")
    if not seed_version:
        raise ValueError("Seed skill must declare a version")

    with tempfile.TemporaryDirectory(prefix="foxcode-skill-evolution-e2e-") as raw:
        sandbox = Path(raw)
        sandbox_user = sandbox / "user"
        sandbox_project = sandbox / "project"
        sandbox_project.mkdir(parents=True)
        active_path = sandbox_user / "skills" / seed_skill.name / "SKILL.md"
        active_path.parent.mkdir(parents=True)
        active_path.write_text(seed_text, encoding="utf-8")
        store = SkillEvolutionStore(sandbox_user, sandbox_project)

        evolution_results = await _evaluate_household_rows(
            rows=evolution_rows,
            variant="initial_skill",
            skill_content=seed_skill.content,
            stream_fn=stream_fn,
            model=model,
            retries=retries,
        )
        failures = [row for row in evolution_results if not row["passed"]]
        if not failures:
            raise ValueError("Initial skill produced no evolution-set failures to learn from")

        feedback = build_evolution_feedback(failures, skill_name=seed_skill.name)
        source_messages = [
            {
                "role": "assistant",
                "content": json.dumps(
                    [{
                        "goal": row["goal"],
                        "prediction": row["prediction"],
                        "expected_actions": row["expected_actions"],
                    } for row in failures],
                    ensure_ascii=False,
                ),
            },
            {"role": "user", "content": feedback},
        ]
        extraction_record: dict[str, Any] = {}

        async def side_query(system: str, prompt: str) -> str:
            call = await _call_text_model(
                stream_fn=stream_fn,
                model=model,
                system=system,
                prompt=prompt,
                max_tokens=1200,
                retries=retries,
            )
            extraction_record.update({
                "system": system,
                "prompt": prompt,
                "response": call["text"],
                "stop_reason": call["stop_reason"],
                "error": call["error"],
                "usage": call["usage"],
                "attempts": call["attempts"],
            })
            if call["error"]:
                raise RuntimeError(str(call["error"]))
            return str(call["text"])

        candidate = await extract_candidate(source_messages, side_query)
        if candidate is None:
            raise ValueError("Real API extraction returned no reusable candidate")
        proposal = store.propose(
            candidate,
            source_session="e2e-api-eval",
            source_messages=source_messages,
        )
        if proposal.status != "pending":
            raise ValueError("Extracted candidate was rejected: " + "; ".join(proposal.reasons))
        if proposal.suggested_action != "merge" or proposal.target_skill != seed_skill.name:
            raise ValueError(
                "Evolution must merge the seed skill; got "
                f"{proposal.suggested_action}:{proposal.target_skill or candidate.name}"
            )
        applied = store.apply(proposal.id, target="user")
        evolved_text = active_path.read_text(encoding="utf-8")
        evolved_skill, evolved_diagnostics = load_skill_from_file(active_path)
        if evolved_skill is None:
            raise ValueError(
                "Cannot reload evolved skill: "
                + "; ".join(d.message for d in evolved_diagnostics)
            )
        evolved_metadata, _evolved_body = parse_frontmatter(evolved_text)
        evolved_version = str(evolved_metadata.get("version") or "")

        heldout_results: list[dict[str, Any]] = []
        for variant, content in (
            ("baseline", ""),
            ("initial_skill", seed_skill.content),
            ("evolved_skill", evolved_skill.content),
        ):
            heldout_results.extend(await _evaluate_household_rows(
                rows=heldout_rows,
                variant=variant,
                skill_content=content,
                stream_fn=stream_fn,
                model=model,
                retries=retries,
            ))
        summary = _planning_summary(
            heldout_results, ("baseline", "initial_skill", "evolved_skill")
        )
        provenance = _read_jsonl_objects(store.provenance_path)
        history_files = sorted(store.history_dir.glob("*.jsonl"))
        history = [row for path in history_files for row in _read_jsonl_objects(path)]
        diff = "\n".join(difflib.unified_diff(
            seed_text.splitlines(),
            evolved_text.splitlines(),
            fromfile=f"{seed_skill.name}@{seed_version}",
            tofile=f"{seed_skill.name}@{evolved_version}",
            lineterm="",
        ))
        report = {
            "kind": "household-planning-self-evolution-e2e",
            "claim_boundary": "plan decomposition only; no interactive environment was executed",
            "model": configured.reference,
            "data": {
                "path": str(data_path),
                "evolution_ids": evolution_ids,
                "heldout_ids": heldout_ids,
                "sets_disjoint": not bool(set(evolution_ids) & set(heldout_ids)),
            },
            "isolation": {
                "user_level_layout": True,
                "live_user_skill_mutated": False,
                "approval_mode": "evaluation-only auto-apply inside isolated sandbox",
            },
            "evolution": {
                "initial_skill": {
                    "name": seed_skill.name,
                    "version": seed_version,
                    "sha256": _sha256_text(seed_text),
                    "content": seed_text,
                },
                "evolution_set_summary": _planning_summary(
                    evolution_results, ("initial_skill",)
                )["initial_skill"],
                "evolution_set_results": evolution_results,
                "feedback": feedback,
                "extraction_api_call": extraction_record,
                "candidate": candidate.to_dict(),
                "proposal_before_apply": proposal.to_dict(),
                "applied_proposal": applied.to_dict(),
                "evolved_skill": {
                    "name": evolved_skill.name,
                    "version": evolved_version,
                    "sha256": _sha256_text(evolved_text),
                    "content": evolved_text,
                },
                "diff": diff,
                "history": history,
                "provenance": provenance,
            },
            "heldout": {
                "summary": summary,
                "effect": {
                    "pass_rate_delta_evolved_vs_initial": round(
                        summary["evolved_skill"]["plan_pass_rate"]
                        - summary["initial_skill"]["plan_pass_rate"], 4
                    ),
                    "action_recall_delta_evolved_vs_initial": round(
                        summary["evolved_skill"]["mean_action_recall"]
                        - summary["initial_skill"]["mean_action_recall"], 4
                    ),
                },
                "results": heldout_results,
            },
            "proof": {
                "real_extraction_api_succeeded": not bool(extraction_record.get("error")),
                "candidate_staged": proposal.proposed_at != "",
                "production_merge_path_used": proposal.suggested_action == "merge",
                "version_advanced": seed_version != evolved_version,
                "history_recorded": bool(history),
                "provenance_recorded": len(provenance) >= 2,
                "evolved_skill_reloaded": evolved_skill is not None,
                "heldout_is_independent": not bool(set(evolution_ids) & set(heldout_ids)),
            },
        }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    offline = sub.add_parser("offline", help="Run deterministic evolution quality/ablation fixtures")
    offline.add_argument("--cases", type=Path, default=FIXTURE_PATH)
    audit = sub.add_parser("audit", help="Report which evaluation rows are honestly runnable")
    audit.add_argument("--data-root", type=Path, default=Path(os.environ.get("SKILL_EVOLUTION_DATA", DEFAULT_DATA_ROOT)))
    audit.add_argument("--datasets", default="gaia,hle,toolhop,alfworld,webshop")
    live = sub.add_parser("live", help="Call a configured model for Pass@1 skill ablations")
    live.add_argument("--data-root", type=Path, default=Path(os.environ.get("SKILL_EVOLUTION_DATA", DEFAULT_DATA_ROOT)))
    live.add_argument("--datasets", default="gaia,hle")
    live.add_argument("--variants", default="baseline,metadata-only,full")
    live.add_argument("--skills-dir", type=Path)
    live.add_argument("--user-dir", type=Path, default=Path.home() / ".foxcode")
    live.add_argument("--model")
    live.add_argument("--limit", type=int, default=20)
    live.add_argument("--output-dir", type=Path, default=Path(".foxcode/evals/skill-evolution"))
    planning = sub.add_parser(
        "planning-live", help="Run a real API baseline/full household-planning Skill ablation"
    )
    planning.add_argument(
        "--data", type=Path, default=DEFAULT_DATA_ROOT / "ALFWorld" / "test.json"
    )
    planning.add_argument(
        "--skill", type=Path,
        default=Path.home() / ".foxcode" / "skills" / "household-task-planner" / "SKILL.md",
    )
    planning.add_argument("--user-dir", type=Path, default=Path.home() / ".foxcode")
    planning.add_argument("--model")
    planning.add_argument("--limit", type=int, default=8)
    planning.add_argument(
        "--output", type=Path,
        default=Path(".foxcode/evals/skill-evolution/household-planning.json"),
    )
    evolving = sub.add_parser(
        "evolve-live",
        help="Run a real API extract/propose/apply/reload/held-out evaluation cycle",
    )
    evolving.add_argument(
        "--data", type=Path, default=DEFAULT_DATA_ROOT / "ALFWorld" / "test.json"
    )
    evolving.add_argument("--seed-skill", type=Path, default=DEFAULT_SEED_SKILL)
    evolving.add_argument("--user-dir", type=Path, default=Path.home() / ".foxcode")
    evolving.add_argument("--model")
    evolving.add_argument("--evolution-limit", type=int, default=9)
    evolving.add_argument("--test-limit", type=int, default=8)
    evolving.add_argument("--retries", type=int, default=1)
    evolving.add_argument(
        "--output", type=Path,
        default=Path(".foxcode/evals/skill-evolution/household-e2e.json"),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "offline":
        report = run_offline_evaluation(args.cases)
    elif args.command == "audit":
        report = audit_datasets(args.data_root, args.datasets.split(","))
    elif args.command == "live":
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
    elif args.command == "planning-live":
        report = asyncio.run(run_household_planning_evaluation(
            data_path=args.data,
            skill_path=args.skill,
            user_dir=args.user_dir,
            model_reference=args.model,
            limit=args.limit,
            output_path=args.output,
        ))
    else:
        report = asyncio.run(run_household_self_evolution_evaluation(
            data_path=args.data,
            seed_skill_path=args.seed_skill,
            user_dir=args.user_dir,
            model_reference=args.model,
            evolution_limit=args.evolution_limit,
            test_limit=args.test_limit,
            output_path=args.output,
            retries=args.retries,
        ))
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "BenchmarkSample", "audit_datasets", "load_benchmark", "normalize_answer",
    "build_evolution_feedback", "expected_plan_actions", "predicted_plan_actions",
    "run_household_planning_evaluation", "run_household_self_evolution_evaluation",
    "run_live_evaluation", "run_offline_evaluation", "score_household_plan", "strict_correct",
]
