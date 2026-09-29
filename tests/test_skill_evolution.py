"""Self-evolving skill extension tests; model extraction uses the offline Faux provider."""

from __future__ import annotations

import json
import os
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
from fox_coding_agent.src.extensions.skill_evolution.evaluation import (
    audit_datasets,
    run_offline_evaluation,
)
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

    def test_offline_evaluation_exercises_component_ablations(self):
        report = run_offline_evaluation()
        summary = report["summary"]
        self.assertEqual(summary["full"]["decision_accuracy"], 1.0)
        self.assertLess(summary["no-safety-gate"]["decision_accuracy"], 1.0)
        self.assertLess(summary["no-dedup"]["decision_accuracy"], 1.0)
        self.assertEqual(summary["no-provenance"]["decision_accuracy"], 1.0)
        self.assertEqual(summary["no-provenance"]["traceability_rate"], 0.0)
        recorded = json.loads(
            (Path(__file__).parents[1] / "packages" / "fox_coding_agent" / "src" /
             "extensions" / "skill_evolution" / "fixtures" / "evolution_eval" /
             "results.json").read_text(encoding="utf-8")
        )
        self.assertEqual(recorded["summary"], summary)


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
            "candidate": {
                "name": "conclusion-first",
                "description": "Lead reports with the conclusion.",
                "when_to_use": "When writing future reports.",
                "instructions": "State the conclusion before supporting evidence.",
                "evidence": "User confirmed this should be used in future reports.",
                "tags": ["report"],
                "confidence": 0.95,
            }
        })
        stream = scripted(
            FauxScript(text="Here is the report."),
            FauxScript(text=extracted),
            FauxScript(text="Understood."),
        )
        runtime = self.runtime(stream)
        await runtime.prompt("Put the conclusion first in this report.")
        await runtime.prompt("Yes, use that format for future reports too.")

        store = SkillEvolutionStore(self.user, self.project)
        pending = store.list_proposals(status="pending")
        self.assertEqual(len(pending), 1)
        self.assertFalse((self.project / ".foxcode" / "skills").exists())
        sent = str(stream.contexts[2].messages[-1].content)
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


class BearDatasetAuditTests(unittest.TestCase):
    def test_bear_dataset_audit_reports_environment_gaps_when_available(self):
        root = (
            Path(r"C:\Users\Qin\Desktop\秋招\BearCode\data")
            if os.name == "nt"
            else Path("/mnt/c/Users/Qin/Desktop/秋招/BearCode/data")
        )
        if not root.is_dir():
            self.skipTest("BearCode data directory is not mounted")
        report = audit_datasets(root, ["gaia", "hle", "toolhop", "alfworld", "webshop"])
        self.assertEqual(report["datasets"]["gaia"]["total"], 165)
        self.assertEqual(report["datasets"]["hle"]["total"], 500)
        self.assertEqual(report["datasets"]["hle"]["runnable"], 387)
        self.assertEqual(report["datasets"]["alfworld"]["runnable"], 0)
        self.assertEqual(report["datasets"]["webshop"]["runnable"], 0)
        recorded = json.loads(
            (Path(__file__).parents[1] / "packages" / "fox_coding_agent" / "src" /
             "extensions" / "skill_evolution" / "fixtures" / "evolution_eval" /
             "bear_data_audit.json").read_text(encoding="utf-8")
        )
        for dataset, values in recorded["datasets"].items():
            self.assertEqual(
                {key: report["datasets"][dataset][key] for key in ("runnable", "skipped", "total")},
                values,
            )


if __name__ == "__main__":
    unittest.main()
