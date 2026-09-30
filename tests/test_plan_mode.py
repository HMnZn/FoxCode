"""Plan-mode routing, safety, and branch persistence regressions."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fox_ai.src.providers.faux import (
    FAUX_MODEL, FauxScript, clear_scripts, faux_api_provider, push_script,
)
from fox_ai.src import ToolCall, ToolResultMessage
from fox_coding_agent.src import (
    AgentSession, AgentSessionConfig, AgentSessionRuntime,
    JsonlSessionStorage, SessionManager,
)
from fox_coding_agent.src.core.interaction import infer_interaction_mode
from fox_coding_agent.src.extensions.memory import create_memory_extension


def scripted(*scripts: FauxScript):
    queue = list(scripts)
    contexts = []

    def stream(model, context, options):
        contexts.append(context.model_copy(deep=True))
        if not queue:
            raise AssertionError("Unexpected extra model request")
        push_script(queue.pop(0))
        return faux_api_provider.stream_simple(model, context, options)

    stream.contexts = contexts
    return stream


class PlanModeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_scripts()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_auto_router_is_conservative(self) -> None:
        self.assertEqual(infer_interaction_mode("怎么设计这个缓存模块？给我一个方案"), "plan")
        self.assertEqual(infer_interaction_mode("先分析，不要修改代码"), "plan")
        self.assertEqual(infer_interaction_mode("设计并实现这个缓存模块"), "default")
        self.assertEqual(infer_interaction_mode("给我完成 plan 模式，支持自动切换"), "default")
        self.assertEqual(infer_interaction_mode("修复登录失败问题"), "default")

    def test_legacy_system_prompt_builder_still_gets_plan_policy(self) -> None:
        session = AgentSession(AgentSessionConfig(
            model=FAUX_MODEL,
            cwd=self.root,
            tools=[],
            skills=[],
            interaction_mode="plan",
            system_prompt_builder=lambda tools, skills, cwd: "custom prompt",
        ))
        self.assertTrue(session.state.system_prompt.startswith("custom prompt"))
        self.assertIn("Mode: plan", session.state.system_prompt)

    async def test_manual_plan_mode_filters_without_losing_selected_tools_and_persists(self) -> None:
        path = self.root / "plan-session.jsonl"
        session = SessionManager(JsonlSessionStorage(path))
        first = AgentSession(AgentSessionConfig(
            model=FAUX_MODEL,
            session=session,
            cwd=self.root,
            skills=[],
            stream_fn=scripted(FauxScript(text="plan ready")),
            interaction_mode="default",
        ))
        first.set_active_tools(["read", "write", "grep"])
        first.set_interaction_mode("plan")

        self.assertEqual(first.interaction_mode, "plan")
        self.assertEqual(first.selected_tool_names, ("read", "write", "grep"))
        self.assertEqual([tool.name for tool in first.state.tools], ["read", "grep", "submit_plan"])
        self.assertIn("Mode: plan", first.state.system_prompt)
        await first.prompt("inspect and plan")

        restored = AgentSession(AgentSessionConfig(
            session=SessionManager(JsonlSessionStorage(path)),
            cwd=self.root,
            skills=[],
            stream_fn=scripted(FauxScript(text="restored")),
        ))
        self.assertEqual(restored.interaction_mode, "plan")
        self.assertEqual(restored.selected_tool_names, ("read", "write", "grep"))
        self.assertEqual([tool.name for tool in restored.state.tools], ["read", "grep", "submit_plan"])

        forked = restored.fork()
        self.assertEqual(forked.interaction_mode, "plan")
        self.assertEqual([tool.name for tool in forked.state.tools], ["read", "grep", "submit_plan"])
        forked.set_interaction_mode("default")
        self.assertEqual([tool.name for tool in forked.state.tools], ["read", "write", "grep"])
        self.assertEqual(restored.interaction_mode, "plan")

    async def test_auto_mode_changes_effective_tools_per_prompt_and_guard_blocks_write(self) -> None:
        user_dir = self.root / "user"
        project = self.root / "project"
        project.mkdir()
        stream = scripted(FauxScript(text="plan"), FauxScript(text="implemented"))
        runtime = AgentSessionRuntime(
            project, user_dir=user_dir, model=FAUX_MODEL, stream_fn=stream,
            settings_overrides={"interaction_mode": "auto"},
        )
        self.addAsyncCleanup(runtime.close)

        await runtime.prompt("如何设计这个功能？先给计划，不要修改代码")
        self.assertEqual(runtime.interaction_mode, "auto")
        self.assertEqual(runtime.effective_interaction_mode, "plan")
        self.assertNotIn("write", [tool.name for tool in runtime.state.tools])
        self.assertIn("Mode: plan", stream.contexts[0].system_prompt)

        write_tool = runtime.agent_session.get_tool("write")
        self.assertIsNotNone(write_tool)
        blocked = await runtime.agent_session.session_config.before_tool_call(
            {
                "tool_call": type("Call", (), {"name": "write"})(),
                "args": {"path": "blocked.txt", "content": "no"},
            },
            None,
        )
        self.assertTrue(blocked["block"])
        self.assertIn("Plan mode", blocked["reason"])

        await runtime.prompt("现在开始实现上一条计划")
        self.assertEqual(runtime.effective_interaction_mode, "default")
        self.assertIn("write", [tool.name for tool in runtime.state.tools])
        self.assertNotIn("Mode: plan", stream.contexts[1].system_prompt)

    async def test_plan_mode_extension_activation_preserves_hidden_selected_tools(self) -> None:
        project = self.root / "project-with-memory"
        project.mkdir()
        runtime = AgentSessionRuntime(
            project,
            user_dir=self.root / "memory-user",
            model=FAUX_MODEL,
            stream_fn=scripted(FauxScript(text="planned")),
            settings_overrides={"interaction_mode": "plan"},
            extension_factories=(create_memory_extension(),),
        )
        self.addAsyncCleanup(runtime.close)

        await runtime.prompt("plan this change")
        selected = set(runtime.agent_session.selected_tool_names)
        effective = {tool.name for tool in runtime.state.tools}
        self.assertIn("write", selected)
        self.assertIn("memory_remember", selected)
        self.assertNotIn("write", effective)
        self.assertNotIn("memory_remember", effective)
        self.assertIn("memory_recall", effective)
        self.assertIn("submit_plan", effective)

    async def test_submit_plan_is_structured_and_only_effective_in_plan_mode(self) -> None:
        session = AgentSession(AgentSessionConfig(
            model=FAUX_MODEL, cwd=self.root, skills=[], tools=[], interaction_mode="plan",
        ))
        self.assertEqual([tool.name for tool in session.state.tools], ["submit_plan"])
        tool = session.get_tool("submit_plan")
        result = await tool.execute("plan-1", {
            "summary": "Add native images",
            "steps": ["Carry ImageContent through the host", "Render previews"],
            "files": ["fox_serve/host.py"],
            "verification": ["Run protocol tests"],
        })
        self.assertTrue(result.terminate)
        self.assertEqual(result.details["kind"], "plan")
        self.assertEqual(result.details["plan"]["steps"][0], "Carry ImageContent through the host")

        session.set_interaction_mode("default")
        self.assertNotIn("submit_plan", [tool.name for tool in session.state.tools])

    async def test_submit_plan_terminates_the_planning_run_and_persists_details(self) -> None:
        stream = scripted(FauxScript(tool_calls=[ToolCall(
            id="plan-call",
            name="submit_plan",
            arguments={"summary": "Safe change", "steps": ["Inspect", "Implement", "Test"]},
        )]))
        session = AgentSession(AgentSessionConfig(
            model=FAUX_MODEL, cwd=self.root, skills=[], tools=[],
            interaction_mode="auto", stream_fn=stream,
        ))
        await session.prompt("请先规划这个改动")

        results = [message for message in session.state.messages if isinstance(message, ToolResultMessage)]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].tool_call_id, "plan-call")
        self.assertEqual(results[0].details["kind"], "plan")
        self.assertEqual(len(stream.contexts), 1)


if __name__ == "__main__":
    unittest.main()
