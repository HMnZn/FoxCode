"""Self-evolving skill extension tests; model extraction uses the offline Faux provider."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fox_ai.src import ToolCall
from fox_ai.src.providers.faux import FAUX_MODEL, FauxScript, clear_scripts
from fox_coding_agent.src import AgentSessionRuntime
from fox_coding_agent.src.extensions.skill_evolution import (
    SkillCandidate,
    SkillEvolutionStore,
    create_skill_evolution_extension,
)
from fox_coding_agent.src.extensions.skill_evolution.extension import SkillEvolutionTool
from fox_coding_agent.src.extensions.skill_evolution.maintainer import maintain_candidate
from test_agent_core import scripted


class SkillEvolutionStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / "project"
        self.user = self.root / "user"
        self.project.mkdir()
        self.store = SkillEvolutionStore(self.user, self.project)

    def test_full_replacement_keeps_history_and_does_not_append(self):
        self.assertEqual(
            SkillEvolutionTool.parameters["properties"]["mode"]["enum"],
            ["append", "replace"],
        )
        path = self.user / "skills" / "coding-method" / "SKILL.md"
        path.parent.mkdir(parents=True)
        path.write_text("---\nname: coding-method\ndescription: 处理代码任务的旧方法。\nversion: 0.1.0\n---\n\n旧方法。\n")
        candidate = SkillCandidate(
            name="coding-method", description="处理代码任务的统一方法。",
            instructions="# 统一方法\n\n按输入检查、执行和验证三个阶段处理。",
            evidence="已标注的代码任务训练轨迹。", confidence=0.9,
            mode="replace",
        )
        proposal = self.store.propose(candidate)
        self.assertEqual(proposal.suggested_action, "replace")
        applied = self.store.apply(proposal.id, target="user")
        self.assertEqual(applied.version, "0.1.1")
        body = path.read_text()
        self.assertIn("# 统一方法", body)
        self.assertNotIn("旧方法。", body)
        self.assertNotIn("## Learned evolution", body)
        history = list(self.store.history_dir.glob("*.jsonl"))
        self.assertEqual(len(history), 1)
        self.assertIn("旧方法。", history[0].read_text())

    @staticmethod
    def candidate(**overrides):
        values = {
            "name": "conclusion-first",
            "description": "Lead reports with the conclusion.",
            "when_to_use": "When writing reports.",
            "instructions": "State the conclusion before supporting evidence.",
            "evidence": "User: Always put the conclusion first in future reports.",
            "tags": ("report",),
            "confidence": 0.95,
        }
        values.update(overrides)
        return SkillCandidate(**values)

    def test_proposal_is_quarantined_then_applied_with_history(self):
        proposal = self.store.propose(self.candidate(), source_session="s1")
        self.assertEqual(proposal.status, "pending")
        self.assertEqual(proposal.suggested_action, "add")
        self.assertFalse((self.project / ".foxcode" / "skills").exists())

        applied = self.store.apply(proposal.id)
        self.assertEqual(applied.status, "applied")
        self.assertEqual(applied.version, "0.1.0")
        skill_file = self.project / ".foxcode" / "skills" / "conclusion-first" / "SKILL.md"
        self.assertIn("State the conclusion", skill_file.read_text(encoding="utf-8"))

        second = self.store.propose(self.candidate(
            instructions="State the conclusion first and include the highest-risk caveat.",
            evidence="User: Keep conclusion first, and always include the highest-risk caveat.",
        ))
        self.assertEqual(second.suggested_action, "merge")
        merged = self.store.apply(second.id)
        self.assertEqual(merged.version, "0.1.1")
        history = list(self.store.history_dir.glob("*.jsonl"))
        self.assertEqual(len(history), 1)
        self.assertIn("0.1.0", history[0].read_text(encoding="utf-8"))
        self.assertTrue(self.store.provenance_path.is_file())

    def test_secret_url_and_missing_evidence_are_rejected(self):
        candidates = [
            self.candidate(instructions="Use api_key=sk-1234567890abcdefghijklmnop"),
            self.candidate(instructions="Always open https://example.test/task/123"),
            self.candidate(evidence=""),
        ]
        for candidate in candidates:
            proposal = self.store.propose(candidate)
            self.assertEqual(proposal.status, "rejected")
            with self.assertRaisesRegex(KeyError, "Unknown"):
                self.store.apply(proposal.id)
        persisted = "\n".join(
            path.read_text(encoding="utf-8")
            for path in self.store.state_dir.rglob("*") if path.is_file()
        )
        self.assertNotIn("sk-1234567890abcdefghijklmnop", persisted)

    def test_derived_candidate_name_merges_longest_existing_parent(self):
        original = self.store.propose(self.candidate(name="api-request-planner"))
        self.store.apply(original.id, target="user")
        derived = self.store.propose(self.candidate(
            name="api-request-planner-toolsearcher-keywords",
            instructions="Use concise capability keywords when searching for a tool.",
        ))
        self.assertEqual(derived.suggested_action, "merge")
        self.assertEqual(derived.target_skill, "api-request-planner")
        self.assertEqual(derived.score, 0.95)

class SkillEvolutionExtensionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / "project"
        self.user = self.root / "user"
        self.project.mkdir()
        clear_scripts()

    def runtime(self, stream):
        runtime = AgentSessionRuntime(
            self.project,
            user_dir=self.user,
            model=FAUX_MODEL,
            stream_fn=stream,
            extension_factories=(create_skill_evolution_extension(),),
            project_trusted=True,
        )
        self.addAsyncCleanup(runtime.close)
        return runtime

    async def test_feedback_window_stages_but_does_not_auto_apply(self):
        extracted = json.dumps({
            "skills": [{
                "name": "conclusion-first",
                "description": "Lead reports with the conclusion.",
                "when_to_use": "When writing future reports.",
                "instructions": "State the conclusion before supporting evidence.",
                "evidence": "User confirmed this should be used in future reports.",
                "tags": ["report"],
                "confidence": 0.95,
            }]
        })
        stream = scripted(
            FauxScript(text="Here is the report."),
            FauxScript(text=extracted),
            FauxScript(text='{"action":"add","target_skill":"","reason":"new workflow"}'),
            FauxScript(text="Understood."),
        )
        runtime = self.runtime(stream)
        await runtime.prompt("Put the conclusion first in this report.")
        await runtime.prompt("Yes, use that format for future reports too.")

        store = SkillEvolutionStore(self.user, self.project)
        pending = store.list_proposals(status="pending")
        self.assertEqual(len(pending), 1)
        self.assertFalse((self.project / ".foxcode" / "skills").exists())
        sent = str(stream.contexts[3].messages[-1].content)
        self.assertIn("skill_evolution_candidate", sent)

    async def test_apply_tool_activates_skill_in_current_session(self):
        store = SkillEvolutionStore(self.user, self.project)
        proposal = store.propose(SkillEvolutionStoreTests.candidate())
        stream = scripted(
            FauxScript(tool_calls=[ToolCall(
                id="evolve-1", name="skill_evolution",
                arguments={"action": "apply", "proposal_id": proposal.id, "target": "project"},
            )]),
            FauxScript(text="Skill activated."),
        )
        runtime = self.runtime(stream)
        await runtime.prompt("Apply the staged skill.")
        self.assertIn("conclusion-first", [skill.name for skill in runtime.agent_session.skills])
        self.assertEqual(store.get_proposal(proposal.id).status, "applied")

    async def test_maintainer_rewrites_existing_skill_as_one_body(self):
        path = self.user / "skills" / "api-planner" / "SKILL.md"
        path.parent.mkdir(parents=True)
        path.write_text(
            "---\nname: api-planner\ndescription: 规划软件接口调用。\n---\n\n先识别任务。\n",
            encoding="utf-8",
        )
        calls = []

        async def side_query(system, prompt):
            calls.append((system, prompt))
            return json.dumps({
                "action": "merge", "reason": "用户纠正了漏选接口",
                "merged_description": "按依赖规划软件接口调用。",
                "merged_instructions": "# 接口规划\n\n先识别任务，再检查依赖是否满足。",
            })

        candidate = SkillCandidate(
            name="api-planner", description="规划接口。",
            instructions="检查依赖。", evidence="用户指出漏选依赖接口。",
            confidence=0.9,
        )
        maintained = await maintain_candidate(
            candidate, SkillEvolutionStore(self.user, self.project), side_query,
        )
        self.assertEqual(len(calls), 1)
        self.assertEqual(maintained.mode, "replace")
        self.assertEqual(maintained.name, "api-planner")
        self.assertIn("先识别任务", maintained.instructions)
        self.assertEqual(path.read_text(encoding="utf-8").count("检查依赖"), 0)


class DatasetAuditTests(unittest.TestCase):
    def test_api_request_parser_rejects_code_execution(self):
        from fox_coding_agent.src.extensions.skill_evolution.fixtures.api_bank_support import parse_api_request
        self.assertEqual(parse_api_request("API-Request: [Search(q='ok')]"), {"api_name": "Search", "parameters": {"q": "ok"}})
        self.assertIsNone(parse_api_request("API-Request: [Search(q=__import__('os'))]"))
