import asyncio
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fox_ai.src import AssistantMessage, Context, EventStream, SimpleStreamOptions, TextContent, ThinkingContent, UserMessage
from fox_ai.src.providers.faux import FAUX_MODEL
from fox_agent_core.src import (
    Agent, AgentOptions, AgentState
)
from fox_coding_agent.src import (
    AgentSession, AgentSessionConfig, SessionManager, CompactionSettings, ReadTool, WriteTool, EditTool, BashTool, LoadSkillsOptions, check_tool_permission, load_skills, generate_summary
)


class ToolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)

    async def test_read_write_edit_and_ambiguous_edit(self):
        await WriteTool(self.path).execute("w", {"path": "nested/file.txt", "content": "first\r\nsecond\r\n"})
        result = await ReadTool(self.path).execute("r", {"path": "nested/file.txt", "offset": 2, "limit": 1})
        self.assertEqual(result.content[0].text, "2: second")
        await EditTool(self.path).execute("e", {"path": "nested/file.txt", "old_text": "second", "new_text": "changed"})
        self.assertEqual((self.path / "nested/file.txt").read_bytes(), b"first\r\nchanged\r\n")
        with self.assertRaisesRegex(ValueError, "exactly once"):
            await EditTool(self.path).execute("e", {"path": "nested/file.txt", "old_text": "\r\n", "new_text": ""})

    @unittest.skipUnless(shutil.which("bash"), "bash is not installed")
    async def test_bash_exit_output_timeout_and_cancel(self):
        bash = BashTool(self.path)
        result = await bash.execute("b", {"command": "echo hello"})
        self.assertEqual(result.content[0].text.strip(), "hello")
        with self.assertRaisesRegex(RuntimeError, "code 7"):
            await bash.execute("b", {"command": "echo failed; exit 7"})
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            await asyncio.wait_for(bash.execute("b", {"command": "sleep 20", "timeout": 0.05}), 3)
        cancel = asyncio.Event()
        started = asyncio.Event()
        task = asyncio.create_task(bash.execute("b", {"command": "echo started; sleep 20"}, cancel,
                                              lambda partial: started.set()))
        await asyncio.wait_for(started.wait(), 3)
        cancel.set()
        with self.assertRaisesRegex(Exception, "aborted"):
            await asyncio.wait_for(task, 3)

    def test_bash_uses_workspace_modification_permission(self):
        bash = BashTool(self.path)
        self.assertEqual(bash.required_permission, "workspace-modify")
        self.assertIsNone(
            check_tool_permission(bash, {"command": "echo ok"}, self.path, "workspace-modify")
        )
        self.assertIn(
            "requires workspace-modify",
            check_tool_permission(bash, {"command": "echo no"}, self.path, "read-only"),
        )

    @unittest.skipUnless(os.name == "posix" and shutil.which("bash"), "POSIX process groups required")
    async def test_bash_kills_child_process(self):
        bash = BashTool(self.path)
        started = asyncio.Event()
        task = asyncio.create_task(bash.execute("b", {"command": "sleep 30 & echo $! > child.pid; echo ready; wait"},
                                               on_update=lambda partial: started.set()))
        await asyncio.wait_for(started.wait(), 3)
        pid = int((self.path / "child.pid").read_text())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        status_file = Path(f"/proc/{pid}/stat")
        if status_file.exists():
            self.assertEqual(status_file.read_text().split()[2], "Z")

    async def test_skill_discovery_and_explicit_invocation(self):
        skill_dir = self.path / ".foxcode/skills/example"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("---\nname: example\ndescription: test skill\ndisable-model-invocation: true\n---\nFollow these steps.")
        options = LoadSkillsOptions(cwd=str(self.path), user_dir=str(self.path / "user"))
        skills = load_skills(options)
        self.assertEqual(len(skills.skills), 1)
        contexts = []

        def stream(model, context, opts):
            contexts.append(context)
            es = EventStream()
            es.end(AssistantMessage(content=[TextContent(text="ok")], stop_reason="stop"))
            return es

        harness = AgentSession(AgentSessionConfig(model=FAUX_MODEL, tools=[], cwd=self.path, skill_options=options, stream_fn=stream))
        self.assertNotIn("<name>example</name>", harness.state.system_prompt)
        await harness.invoke_skill("example", "Do this task")
        self.assertIn("Follow these steps", contexts[0].system_prompt)
        prompt = contexts[0].messages[0].content[0].text
        self.assertEqual(prompt, "Do this task")
        self.assertNotIn("Follow these steps", prompt)
        self.assertNotIn("Follow these steps", harness.state.system_prompt)

    async def test_explicit_skill_requires_a_real_task(self):
        skill_dir = self.path / ".foxcode/skills/example"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: example\ndescription: test skill\n---\nFollow these steps."
        )
        harness = AgentSession(AgentSessionConfig(
            model=FAUX_MODEL,
            tools=[],
            cwd=self.path,
            skill_options=LoadSkillsOptions(cwd=str(self.path), user_dir=str(self.path / "user")),
        ))
        with self.assertRaisesRegex(ValueError, "requires task instructions"):
            await harness.invoke_skill("example")

    @unittest.skipUnless(os.name == "posix", "symlink creation requires POSIX")
    async def test_skill_symlink_cycle(self):
        (self.path / "loop").symlink_to(self.path, target_is_directory=True)
        result = load_skills(LoadSkillsOptions(cwd=str(self.path), skill_paths=[str(self.path)], include_defaults=False))
        self.assertEqual(result.skills, [])

    async def test_summary_options_and_multiple_text_blocks(self):
        captured = []

        def stream(model, context, opts):
            captured.append(opts)
            es = EventStream()
            es.end(AssistantMessage(content=[ThinkingContent(thinking="analysis"), TextContent(text="one"), TextContent(text="two")], stop_reason="stop"))
            return es

        summary = await generate_summary(FAUX_MODEL, [UserMessage(content="old")], stream_fn=stream,
                                         max_tokens=42, session_id="normal")
        self.assertEqual(summary, "one\ntwo")
        self.assertEqual(captured[0].max_tokens, 42)
        self.assertNotEqual(captured[0].session_id, "normal")

    async def test_compaction_abort_and_busy_guard(self):
        entered = asyncio.Event()

        async def summary(*args, **kwargs):
            entered.set()
            await asyncio.Event().wait()

        session = SessionManager()
        session.append_message(UserMessage(content="old " * 100))
        session.append_message(UserMessage(content="recent"))
        harness = AgentSession(AgentSessionConfig(model=FAUX_MODEL, session=session, tools=[], skills=[],
                               summary_fn=summary, compaction=CompactionSettings(keep_recent_tokens=10)))
        previous = session.leaf_id
        task = asyncio.create_task(harness.compact())
        await entered.wait()
        with self.assertRaisesRegex(RuntimeError, "already processing"):
            harness.move_to(None)
        harness.abort()
        with self.assertRaisesRegex(Exception, "aborted"):
            await asyncio.wait_for(task, 2)
        await harness.wait_for_idle()
        self.assertEqual(session.leaf_id, previous)

    async def test_state_options_and_fork_have_independent_identity(self):
        opts = AgentOptions(initial_state={"model": FAUX_MODEL})
        a, b = Agent(opts), Agent(opts)
        a.state.messages.append(UserMessage(content="one"))
        self.assertEqual(b.state.messages, [])
        x, y = AgentState(), AgentState()
        x.model.id = "changed"
        self.assertNotEqual(x.model.id, y.model.id)
        session = SessionManager()
        self.assertNotEqual(session.storage.get_metadata()["id"], session.fork().storage.get_metadata()["id"])


class ProviderCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_closes_openai_and_anthropic_streams(self):
        from fox_ai.src.providers.openai_provider import openai_api_provider, OPENAI_MODELS
        from fox_ai.src.providers.anthropic_provider import anthropic_api_provider, ANTHROPIC_MODELS

        for provider, model, module in [
            (openai_api_provider, OPENAI_MODELS[0], "openai_provider"),
            (anthropic_api_provider, ANTHROPIC_MODELS[0], "anthropic_provider"),
        ]:
            with self.subTest(provider=module):
                entered = asyncio.Event()

                class Response:
                    close = AsyncMock()

                    def __aiter__(self):
                        return self

                    async def __anext__(self):
                        entered.set()
                        await asyncio.Event().wait()

                response = Response()
                create = AsyncMock(return_value=response)
                client = SimpleNamespace(close=AsyncMock(), messages=SimpleNamespace(create=create),
                                         chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
                with patch(f"fox_ai.src.providers.{module}._create_client", return_value=client):
                    stream = provider.stream_simple(model, Context(messages=[UserMessage(content="hello")]), SimpleStreamOptions(api_key="test"))
                    await asyncio.wait_for(entered.wait(), 2)
                    await stream.aclose()
                self.assertEqual((await stream.result()).stop_reason, "aborted")
                response.close.assert_awaited_once()
                client.close.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
