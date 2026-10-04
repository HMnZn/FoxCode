"""Online Skill evaluation checks for the FoxCode plugin adapter."""

import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from fox_coding_agent.src.extensions.skill_evolution.online_eval import (
    _assign_replay_splits,
    _promotion_decision,
    bind_store,
    evaluate_online_skill_evolution_async,
    reset_store,
)
from fox_coding_agent.src.extensions.skill_evolution.retrieval import retrieve_relevant_skills
from fox_coding_agent.src.extensions.skill_evolution.store import SkillEvolutionStore


def test_split_and_champion_thresholds_are_preserved():
    samples = [{"sample_id": f"{value:08x}"} for value in (1, 0xFFFFFFFF)]
    split = _assign_replay_splits(samples)
    assert [row["split"] for row in split] == ["mutate_dev", "promotion_test"]
    old = {"summary": {"average_score": 1.0, "hard_failures": 0}}
    rejected = _promotion_decision(
        status="healthy", candidate={"average_score": 1.0, "hard_failures": 0},
        champion=old,
    )
    accepted = _promotion_decision(
        status="healthy", candidate={"average_score": 1.02, "hard_failures": 0},
        champion=old,
    )
    assert not rejected["promoted"] and accepted["promoted"]


def test_plugin_store_feeds_replay_evaluator_without_live_publish():
    with TemporaryDirectory() as raw:
        root = Path(raw)
        project = root / "project"
        project.mkdir()
        store = SkillEvolutionStore(root / "user", project)
        skill_path = store.user_skills_dir / "api-planner" / "SKILL.md"
        skill_path.parent.mkdir(parents=True)
        skill_path.write_text(
            "---\nname: api-planner\ndescription: 规划 API 调用。\n---\n\n先检查接口。\n",
            encoding="utf-8",
        )
        store.record_online(
            action="merge", skill="api-planner", result={"status": "pending"},
            messages=[{"role": "user", "content": "以后先检查接口。"},
                      {"role": "assistant", "content": "我会先检查接口。"}],
        )
        store.record_usage_judgments([
            {"name": "api-planner", "relevant": True, "used": True},
        ])
        hits = retrieve_relevant_skills("规划 API 调用", store._skills())
        assert hits and hits[0]["name"] == "api-planner"
        token = bind_store(store)
        try:
            report = asyncio.run(evaluate_online_skill_evolution_async(
                write_report=False, write_artifacts=False,
            ))
        finally:
            reset_store(token)
        assert report["skills"]
        assert json.loads((store.state_dir / "skill_usage_stats.json").read_text())[
            "api-planner"]["retrieved"] == 1
        assert "先检查接口" in skill_path.read_text()
