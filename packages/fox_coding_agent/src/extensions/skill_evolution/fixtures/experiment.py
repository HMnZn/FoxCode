"""Three-arm coding Skill experiment: no Skill, initial Skill, full replacement.

All experiment code and datasets live under fixtures. The writer sees only
training traces. The same solver handles every test arm with one call per item.
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import json
import math
import random
import re
import ast
from dataclasses import replace
from pathlib import Path
from typing import Any

from fox_coding_agent.src.core.model_runtime import ModelRuntime
from fox_coding_agent.src.core.skills import load_skill_from_file

from ..extraction import parse_json_object
from ..models import SkillCandidate
from ..maintainer import maintain_candidate
from ..online_eval import (
    _build_heuristic_candidate_variants,
    _build_llm_candidate_variant_async,
)
from ..store import SkillEvolutionStore
from .api_bank_support import call_text_model, score_api_request

ROOT = Path(__file__).parent
DATA = ROOT / "data"
DEFAULT_MODEL = "deepseek/deepseek-flash"
DEFAULT_WRITER = "deepseek/deepseek-v4-pro"


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def api_bank_rows() -> list[dict[str, Any]]:
    data = DATA / "API-Bank" / "test-data" / "level-1-api.json"
    rows = json.loads(data.read_text(encoding="utf-8"))
    return [
        {
            **row,
            "id": f"{row['file']}:{row['id']}",
            "prompt": str(row["instruction"]) + str(row["input"]),
            "source": str(data.relative_to(ROOT)),
        }
        for row in rows
    ]


def split(rows: list[dict[str, Any]], dataset: str) -> dict[str, list[dict[str, Any]]]:
    if dataset == "api-bank-final":
        by_file: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            by_file.setdefault(str(row["file"]), []).append(row)
        files = sorted(by_file, key=lambda name: digest(["api-bank", name]))
        parts: dict[str, list[dict[str, Any]]] = {
            "train": [], "validation": [], "test": [],
        }
        targets = {"train": 80, "validation": 40, "pilot": 120}
        pilot: list[dict[str, Any]] = []
        phase = iter(targets)
        current = next(phase)
        for filename in files:
            selected = pilot if current == "pilot" else parts[current]
            selected.extend(by_file[filename])
            if current == "test":
                continue
            if len(selected) >= targets[current]:
                try:
                    current = next(phase)
                except StopIteration:
                    current = "test"
        if any(len(pilot if name == "pilot" else parts[name]) < target
               for name, target in targets.items()):
            raise ValueError("API-Bank has too few file-disjoint rows")
        if not parts["test"]:
            raise ValueError("No untouched API-Bank confirmation rows remain")
        return parts
    raise ValueError(f"Unknown coding dataset: {dataset}")


def grade(dataset: str, row: dict[str, Any], prediction: str) -> dict[str, Any]:
    if dataset != "api-bank-final":
        raise ValueError(f"Unknown coding dataset: {dataset}")
    score = grade_api_request(row, prediction)
    return {**score, "parseable": score["actual"] is not None}


def api_schema(row: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result = {}
    for line in (str(row["instruction"]) + "\n" + str(row["input"])).splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and "name" in value and "input_parameters" in value:
            result[value["name"]] = value["input_parameters"]
    return result


def typed_api_request(request: dict[str, Any] | None, schema: dict[str, Any]) -> Any:
    if request is None:
        return None
    params = dict(request["parameters"])
    for name, spec in schema.get(request["api_name"], {}).items():
        kind, value = str(spec.get("type", "")), params.get(name)
        container = (
            list if kind.startswith("list") else dict if kind == "dict" else None
        )
        if container is not None and isinstance(value, str):
            try:
                decoded = ast.literal_eval(value)
            except ValueError, SyntaxError:
                continue
            if isinstance(decoded, container):
                params[name] = decoded
        elif (
            kind == "int"
            and isinstance(value, str)
            and re.fullmatch(r"[+-]?\d+", value)
        ):
            params[name] = int(value)
        elif kind == "float" and isinstance(value, str):
            try:
                decoded = float(value)
            except ValueError:
                continue
            if math.isfinite(decoded):
                params[name] = decoded
    return {"api_name": request["api_name"], "parameters": params}


def grade_api_request(row: dict[str, Any], prediction: str) -> dict[str, Any]:
    raw = score_api_request(row["expected_output"], prediction)
    schema = api_schema(row)
    expected = typed_api_request(raw["expected_request"], schema)
    actual = typed_api_request(raw["predicted_request"], schema)
    return {
        "passed": expected is not None and actual is not None and expected == actual,
        "legacy_passed": raw["passed"],
        "expected": expected,
        "actual": actual,
    }


def solver_system(dataset: str, skill: str) -> str:
    if dataset != "api-bank-final":
        raise ValueError(f"Unknown coding dataset: {dataset}")
    base = (
        "Complete the supplied API-request benchmark item. Follow its API "
        "descriptions and output contract exactly. Do not execute the request "
        "or claim success."
    )
    return base + (f"\n\n<skill>\n{skill}\n</skill>" if skill else "")


def summarise(results: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "correct": sum(row["passed"] for row in results),
        "total": len(results),
        "parseable": sum(row["parseable"] for row in results),
        "errors": sum(bool(row["error"]) for row in results),
        "tokens": sum(row["usage"].get("totalTokens", 0) or 0 for row in results),
        "recorded_cost": sum(
            row["usage"].get("cost", {}).get("total", 0) or 0 for row in results
        ),
    }


def paired(
    initial: list[dict[str, Any]], evolved: list[dict[str, Any]]
) -> dict[str, Any]:
    left, right = {r["id"]: r for r in initial}, {r["id"]: r for r in evolved}
    if left.keys() != right.keys():
        raise ValueError("Paired arms do not contain the same task IDs")
    diffs = [int(right[k]["passed"]) - int(left[k]["passed"]) for k in sorted(left)]
    rng = random.Random(20261004)
    boot = sorted(
        sum(rng.choices(diffs, k=len(diffs))) / len(diffs) for _ in range(2000)
    )
    return {
        "wins": diffs.count(1),
        "losses": diffs.count(-1),
        "delta": sum(diffs) / len(diffs),
        "bootstrap_95_ci": [boot[49], boot[1949]],
    }


class Runner:
    def __init__(
        self, root: Path, user_dir: Path, model: str, writer: str, concurrency: int
    ):
        runtime = ModelRuntime(user_dir)
        self.stream = runtime.authenticated_stream()
        self.student = runtime.registry.resolve(model).model
        self.writer = runtime.registry.resolve(writer).model
        self.root = root
        self.semaphore = asyncio.Semaphore(concurrency)
        self.cached: dict[tuple[str, str, str], dict[str, Any]] = {}
        calls_path = root / "calls.jsonl"
        if calls_path.is_file():
            for line in calls_path.read_text(encoding="utf-8").splitlines():
                call = json.loads(line)
                response = call["response"]
                if not response["error"]:
                    self.cached[(call["phase"], call["system"], call["prompt"])] = response

    async def call(
        self, *, system: str, prompt: str, phase: str, teacher: bool = False
    ) -> dict[str, Any]:
        key = (phase, system, prompt)
        if key in self.cached:
            return self.cached[key]
        async with self.semaphore:
            result = await call_text_model(
                stream_fn=self.stream,
                model=self.writer if teacher else self.student,
                system=system,
                prompt=prompt,
                max_tokens=2000 if teacher else 600,
                retries=1,
            )
            with (self.root / "calls.jsonl").open("a", encoding="utf-8") as handle:
                handle.write(
                    json.dumps(
                        {
                            "phase": phase,
                            "system": system,
                            "prompt": prompt,
                            "response": result,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
            if not result["error"]:
                self.cached[key] = result
            return result

    async def evaluate(
        self, dataset: str, rows: list[dict[str, Any]], arms: dict[str, str], phase: str
    ) -> dict[str, Any]:
        async def one(row: dict[str, Any], arm: str, skill: str) -> dict[str, Any]:
            response = await self.call(
                system=solver_system(dataset, skill),
                prompt=row["prompt"],
                phase=f"{phase}/{arm}/{row['id']}",
            )
            return {
                "id": row["id"],
                "arm": arm,
                "prediction": response["text"],
                "error": response["error"],
                "usage": response["usage"],
                "attempts": response["attempts"],
                **grade(dataset, row, response["text"]),
            }

        jobs = [(row, arm, skill) for row in rows for arm, skill in arms.items()]
        random.Random(20261004).shuffle(jobs)
        outputs = await asyncio.gather(*(one(*job) for job in jobs))
        result = {name: [row for row in outputs if row["arm"] == name] for name in arms}
        if any(row["error"] for row in outputs):
            raise RuntimeError(
                f"Provider errors in {phase}; raw calls preserved, no selection"
            )
        return {
            "summary": {name: summarise(value) for name, value in result.items()},
            "results": result,
        }


WRITER = """你是 API-Bank Coding Skill 的监督候选提取器。仅根据训练题目、模型预测和标注，
归纳一条可复用的失败修正方法，供 Skill Maintainer 决定 add/merge/discard。
不要照抄具体实体、数字、API 实例或标准答案；部署时看不到答案。
只输出 JSON：{"description":"简短能力描述","instructions":"中文可复用方法"}。"""


async def run(args: argparse.Namespace) -> None:
    root = args.run_dir
    if args.resume:
        if not root.is_dir():
            raise FileNotFoundError(f"Cannot resume missing run directory: {root}")
    else:
        root.mkdir(parents=True, exist_ok=False)
    dataset = args.dataset
    rows = api_bank_rows()
    parts = split(rows, dataset)
    seed_path = ROOT / "api_bank_eval" / "initial.md"
    seed, diagnostics = load_skill_from_file(seed_path)
    if seed is None:
        raise ValueError(str(diagnostics))
    runner = Runner(root, args.user_dir, args.model, args.writer, args.concurrency)
    (root / "initial.md").write_text(
        seed_path.read_text(encoding="utf-8"), encoding="utf-8"
    )
    protocol = {
        "dataset": dataset,
        "evolution_method": "Extractor candidate -> Maintainer add/merge/discard -> staged Skill",
        "data_sha256": digest(rows),
        "student": args.model,
        "writer": args.writer,
        "seed_sha256": digest(seed.content),
        "split_ids": {name: [r["id"] for r in value] for name, value in parts.items()},
        "inference_calls_per_task": 1,
        "test_opened_during_training": False,
    }
    protocol_path = root / "protocol.json"
    if args.resume and json.loads(protocol_path.read_text(encoding="utf-8")) != protocol:
        raise ValueError("Resume protocol differs from frozen original run")
    protocol_path.write_text(
        json.dumps(protocol, ensure_ascii=False, indent=2)
    )
    train = await runner.evaluate(
        dataset, parts["train"], {"initial": seed.content}, "train"
    )
    training_by_id = {row["id"]: row for row in parts["train"]}
    failures = sorted(
        train["results"]["initial"], key=lambda row: (row["passed"], row["id"])
    )
    evidence = [
        {
            "id": r["id"],
            "task": training_by_id[r["id"]]["prompt"],
            "prediction": r["prediction"],
            "expected": r["expected"],
            "passed": r["passed"],
        }
        for r in failures[:12]
    ]
    response = await runner.call(
        system=WRITER,
        phase="writer",
        teacher=True,
        prompt=json.dumps(
            {"initial": seed.content, "traces": evidence}, ensure_ascii=False
        ),
    )
    candidate_output = parse_json_object(response["text"])
    content = candidate_output.get("instructions")
    if response["error"] or not isinstance(content, str) or not content.strip():
        raise ValueError("Extractor did not produce a candidate; raw call preserved")
    if len(content) > 4000 or re.search(r"标准答案|参考答案|\b\d{4,}\b", content):
        raise ValueError(
            "Candidate contains forbidden answer dependencies or literals"
        )
    stage = root / "stage"
    active = stage / "user" / "skills" / seed.name / "SKILL.md"
    active.parent.mkdir(parents=True)
    active.write_text(seed_path.read_text(encoding="utf-8"), encoding="utf-8")
    store = SkillEvolutionStore(stage / "user", stage / "project")
    raw_candidate = SkillCandidate(
            name=seed.name,
            description=str(candidate_output.get("description") or seed.description),
            instructions=content,
            evidence="用户授权使用 API-Bank 有监督训练错误提取候选方法。",
            confidence=0.9,
            when_to_use="当任务是根据对话与接口说明生成下一次 API 请求时使用。",
    )
    async def maintainer_query(system: str, prompt: str) -> str:
        answer = await runner.call(system=system, prompt=prompt,
                                   phase="maintainer", teacher=True)
        if answer["error"]:
            raise RuntimeError(f"Maintainer model error: {answer['error']}")
        return answer["text"]

    maintained = await maintain_candidate(raw_candidate, store, maintainer_query)
    if maintained is None:
        raise ValueError("Skill Maintainer discarded the candidate")
    validation = None
    candidate_selection: dict[str, Any] = {}
    if dataset == "api-bank-final":
        failures_for_rules = [{
            "rule_id": "skill_instruction_alignment",
            "details": {"reason": (
                f"训练请求：{item['task'][-650:]}；预测：{item['prediction'][:180]}；"
                f"正确请求：{str(item['expected'])[:180]}"
            )},
        } for item in evidence if not item["passed"]][:4]
        rules = [{"rule_id": "skill_instruction_alignment", "kind": "llm_binary",
                  "params": {"requirement_text": "按接口 schema 生成正确的下一次 API 请求"}}]
        rule_summary = {"failures": failures_for_rules}
        snapshot = {"name": seed.name, "description": seed.description,
                    "when_to_use": raw_candidate.when_to_use,
                    "instructions": seed.content}
        candidates = {"maintainer": maintained}
        heuristic = _build_heuristic_candidate_variants(
            lineage_id="api-bank", snapshot=snapshot, rules=rules,
            rule_summary=rule_summary, max_variants=2,
        )
        for index, variant in enumerate(heuristic):
            candidates[f"heuristic_{index}"] = replace(
                maintained, instructions=variant["snapshot"]["instructions"],
            )
        llm = await _build_llm_candidate_variant_async(
            lineage_id="api-bank", snapshot=snapshot, rules=rules,
            rule_summary=rule_summary, side_query=maintainer_query,
        )
        if llm is not None:
            candidates["llm_mutation"] = replace(
                maintained, instructions=llm["snapshot"]["instructions"],
                description=llm["snapshot"]["description"],
            )
        validation = await runner.evaluate(
            dataset, parts["validation"],
            {"initial": seed.content,
             **{name: item.instructions for name, item in candidates.items()}},
            "validation",
        )
        winner = max(candidates, key=lambda name: (
            validation["summary"][name]["correct"],
            -validation["summary"][name]["errors"],
        ))
        maintained = candidates[winner]
        candidate_selection = {
            "candidate_names": list(candidates), "selected": winner,
            "validation_scores": validation["summary"],
            "selection_metric": "API request exact match on file-disjoint development rows",
        }
    proposal = store.propose(maintained, source_session=f"{dataset}-skill-maintainer")
    if proposal.status != "pending" or proposal.suggested_action != "replace":
        raise ValueError(f"Full replacement proposal rejected: {proposal.reasons}")
    store.apply(proposal.id, target="user")
    evolved, diagnostics = load_skill_from_file(active)
    if evolved is None or "## Learned evolution" in evolved.content:
        raise ValueError(f"Unified Skill failed reload: {diagnostics}")
    (root / "evolved.md").write_text(
        active.read_text(encoding="utf-8"), encoding="utf-8"
    )
    if validation is None:
        validation = await runner.evaluate(
            dataset, parts["validation"],
            {"initial": seed.content, "evolved": evolved.content}, "validation",
        )
    (root / "validation.json").write_text(
        json.dumps(validation, ensure_ascii=False, indent=2)
    )
    # Candidate is frozen before test. Validation records support the audit but do
    # not change the mandatory three-arm comparison.
    test = await runner.evaluate(
        dataset,
        parts["test"],
        {"baseline": "", "initial": seed.content, "evolved": evolved.content},
        "test",
    )
    comparison = paired(test["results"]["initial"], test["results"]["evolved"])
    decision = (
        "supported_gain"
        if comparison["bootstrap_95_ci"][0] > 0
        else "observed_gain_unconfirmed"
        if comparison["delta"] > 0
        else "reject"
    )
    report = {
        "protocol": protocol,
        "train": train["summary"],
        "validation": validation["summary"],
        "candidate_selection": candidate_selection,
        "test": test,
        "paired_initial_vs_evolved": comparison,
        "decision": decision,
        "skill_changed_in_live_user_directory": False,
        "note": (
            "Only the sandbox Skill was replaced; output tokens and provider cost "
            "are recorded per arm."
        ),
    }
    (root / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(
        json.dumps(
            {
                "dataset": dataset,
                "test": test["summary"],
                "paired": comparison,
                "decision": decision,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def audit(args: argparse.Namespace) -> None:
    root = args.run_dir
    report = json.loads((root / "results.json").read_text())
    dataset = report["protocol"]["dataset"]
    rows = api_bank_rows()
    if digest(rows) != report["protocol"]["data_sha256"]:
        raise ValueError("Dataset changed")
    lookup = {row["id"]: row for row in rows}
    assert set(report["test"]["results"]) == {"baseline", "initial", "evolved"}
    for arm, values in report["test"]["results"].items():
        if len(values) != len(report["protocol"]["split_ids"]["test"]):
            raise ValueError(f"Missing {arm} results")
        for result in values:
            if (
                grade(dataset, lookup[result["id"]], result["prediction"])["passed"]
                != result["passed"]
            ):
                raise ValueError(f"Changed score for {result['id']}")
    calls_path = root / "calls.jsonl"
    if calls_path.is_file():
        call_records = [json.loads(line) for line in calls_path.read_text().splitlines()]
    else:
        with gzip.open(root / "calls.jsonl.gz", "rt", encoding="utf-8") as handle:
            call_records = [json.loads(line) for line in handle]
    raw = {call["phase"]: call for call in call_records}
    for arm, values in report["test"]["results"].items():
        for result in values:
            if (
                raw[f"test/{arm}/{result['id']}"]["response"]["text"]
                != result["prediction"]
            ):
                raise ValueError(f"Raw response mismatch for {result['id']}")
    print(
        json.dumps(
            {"dataset": dataset, "verified": True, "test": report["test"]["summary"]},
            ensure_ascii=False,
            indent=2,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["run", "audit"])
    parser.add_argument(
        "--dataset",
        choices=["api-bank-final"],
        default="api-bank-final",
    )
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--user-dir", type=Path, default=Path.home() / ".foxcode")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--writer", default=DEFAULT_WRITER)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--resume", action="store_true",
                        help="Retry only failed calls of an identical frozen run")
    args = parser.parse_args()
    if not 1 <= args.concurrency <= 8:
        parser.error("concurrency must be 1..8")
    asyncio.run(run(args)) if args.phase == "run" else audit(args)


if __name__ == "__main__":
    main()
