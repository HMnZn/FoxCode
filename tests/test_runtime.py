"""宿主集成测试：真实文件/Session/工具；模型使用显式 Faux 流，无 API 费用。"""

import asyncio
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fox_ai.src import ToolCall, UserMessage
from fox_ai.src.providers.faux import FAUX_MODEL, FauxScript, clear_scripts
from fox_coding_agent.src import (
    AgentSessionRuntime, JsonlSessionStorage, ResourceLoader, Resources, Session, SettingsManager
)
from fox_coding_agent.src.cli import build_parser, run
from test_agent_core import scripted, tool_fixture


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


class Workspace:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.project = self.root / "a"
        self.other = self.root / "b"
        self.user = self.root / "user"
        self.project.mkdir()
        self.other.mkdir()
        clear_scripts()


class SettingsTests(Workspace, unittest.TestCase):
    def test_project_can_override_one_model_field(self):
        write(self.user / "settings.json", json.dumps({"model": FAUX_MODEL.model_dump(mode="json")}))
        write(self.project / ".foxcode/settings.json", json.dumps({"model": {"max_tokens": 120}}))
        settings = SettingsManager(self.project, user_dir=self.user).settings
        self.assertEqual(settings.model.id, "faux")
        self.assertEqual(settings.model.max_tokens, 120)

    def test_api_key_belongs_to_auth_not_settings(self):
        manager = SettingsManager(self.project, user_dir=self.user)
        for scope in ("user", "project"):
            with self.assertRaisesRegex(ValueError, "auth.json"):
                manager.update({"api_key": "test-secret"}, scope=scope)

    def test_precedence_and_atomic_update(self):
        write(self.user / "settings.json", json.dumps({
            "max_turns": 10, "compaction": {"reserve_tokens": 300, "keep_recent_tokens": 200},
            "stream_options": {"max_tokens": 500, "timeout_ms": 6000}}))
        write(self.project / ".foxcode/settings.json", json.dumps({
            "compaction": {"keep_recent_tokens": 80}, "stream_options": {"max_tokens": 250}}))
        manager = SettingsManager(self.project, user_dir=self.user, overrides={"max_turns": 3})
        self.assertEqual(manager.settings.max_turns, 3)
        self.assertEqual(manager.settings.compaction.reserve_tokens, 300)
        self.assertEqual(manager.settings.compaction.keep_recent_tokens, 80)
        self.assertEqual(manager.settings.stream_options, {"max_tokens": 250, "timeout_ms": 6000})
        manager.update({"max_turns": 12}, scope="user")
        self.assertEqual(manager.settings.max_turns, 3)
        self.assertEqual(json.loads(manager.user_path.read_text())["max_turns"], 12)
        before = manager.project_path.read_bytes()
        with patch("fox_coding_agent.src.core.settings.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                manager.update({"max_turns": 5})
        self.assertEqual(manager.project_path.read_bytes(), before)
        self.assertEqual(manager.settings.max_turns, 3)
        self.assertFalse(list(manager.project_path.parent.glob(".settings-*.tmp")))

    def test_invalid_configuration_keeps_previous_snapshot(self):
        manager = SettingsManager(self.project, user_dir=self.user)
        manager.update({"max_turns": 8})
        for invalid in ({"max_turns": 0}, {"max_truns": 9}, {"tools": [10]},
                        {"compaction": {"reserve_tokens": -1}}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                manager.update(invalid)
        self.assertEqual(manager.settings.max_turns, 8)
        write(manager.project_path, "{ broken")
        with self.assertRaises(ValueError):
            manager.reload()
        self.assertEqual(manager.settings.max_turns, 8)


class ResourceTests(Workspace, unittest.TestCase):
    def test_instructions_skills_and_prompt_precedence(self):
        write(self.user / "AGENTS.md", "user instructions")
        write(self.root / "AGENTS.md", "ancestor instructions")
        write(self.project / "AGENTS.md", "project instructions")
        for root, body in [(self.user, "user skill"), (self.project / ".foxcode", "project skill")]:
            write(root / "skills/review/SKILL.md", f"---\nname: review\ndescription: Review code\n---\n{body}")
            write(root / "prompts/review.md", f"---\ndescription: Review\n---\n{body}: $ARGUMENTS")
        result = ResourceLoader(self.project, user_dir=self.user).load()
        self.assertEqual([c.content for c in result.context_files][-3:],
                         ["user instructions", "ancestor instructions", "project instructions"])
        self.assertEqual(result.skills[0].content, "project skill")
        self.assertEqual(result.prompts["review"].render("$(do-not-execute)"),
                         "project skill: $(do-not-execute)")
        self.assertEqual(len(result.diagnostics), 2)

    def test_extension_provider_is_explicit_and_failures_propagate(self):
        seen = []

        def provider(cwd):
            seen.append(cwd)
            return Resources(diagnostics=["provided"])

        loader = ResourceLoader(self.project, user_dir=self.user, providers=(provider,))
        self.assertEqual(loader.load().diagnostics, ["provided"])
        self.assertEqual(seen, [self.project])
        with self.assertRaises(TypeError):
            ResourceLoader(self.project, user_dir=self.user, providers=(lambda cwd: None,)).load()


class RuntimeTests(Workspace, unittest.IsolatedAsyncioTestCase):
    def make_runtime(self, **kwargs):
        runtime = AgentSessionRuntime(self.project, user_dir=self.user, model=FAUX_MODEL, **kwargs)
        self.addAsyncCleanup(runtime.close)
        return runtime

    async def test_failed_new_session_does_not_leave_resumable_file(self):
        write(self.project / ".foxcode/settings.json", json.dumps({"tools": ["read", "read"]}))
        with self.assertRaises(ValueError):
            AgentSessionRuntime(self.project, user_dir=self.user, model=FAUX_MODEL)
        self.assertFalse(list((self.project / ".foxcode/sessions").glob("*.jsonl")))

    async def test_persistence_failure_keeps_original_session(self):
        runtime = self.make_runtime()
        original = runtime.harness
        with patch("fox_coding_agent.src.core.session.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                await runtime.change_cwd(self.other)
        self.assertIs(runtime.harness, original)
        self.assertFalse(list((self.other / ".foxcode/sessions").glob("*.jsonl")))

    async def test_switch_cwd_rebinds_tools_and_restores_saved_session(self):
        stream = scripted(FauxScript(tool_calls=[ToolCall(id="w1", name="write", arguments={
            "path": "result.txt", "content": "A"})]), FauxScript(text="done A"),
            FauxScript(tool_calls=[ToolCall(id="w2", name="write", arguments={
                "path": "result.txt", "content": "B"})]), FauxScript(text="done B"))
        runtime = self.make_runtime(stream_fn=stream)
        events = []
        runtime.subscribe(lambda event, cancel: events.append(event.type))
        await runtime.prompt("write A")
        original_file = runtime.session_file
        await runtime.change_cwd(self.other)
        self.assertEqual(runtime.state.messages, [])
        await runtime.prompt("write B")
        self.assertEqual((self.project / "result.txt").read_text(), "A")
        self.assertEqual((self.other / "result.txt").read_text(), "B")
        self.assertEqual(events.count("agent_end"), 2)
        await runtime.switch_session(original_file)
        self.assertEqual(runtime.cwd, self.project)
        self.assertEqual(runtime.state.messages[-1].content[0].text, "done A")
        restored = AgentSessionRuntime(self.other, user_dir=self.user, session_file=original_file)
        self.addAsyncCleanup(restored.close)
        self.assertEqual(restored.cwd, self.project)
        self.assertEqual(restored.state.model.id, "faux")

    async def test_switch_cwd_keeps_user_defaults_until_target_overrides_them(self):
        write(self.user / "settings.json", json.dumps({
            "api_key_env": "FOX_TEST_API_KEY",
            "stream_options": {"max_tokens": 111, "timeout_ms": 2222},
        }))
        stream = scripted(FauxScript(text="inherited"), FauxScript(text="overridden"))
        with patch.dict(os.environ, {"FOX_TEST_API_KEY": "test-key"}):
            runtime = AgentSessionRuntime(self.project, user_dir=self.user, model=FAUX_MODEL, stream_fn=stream)
            self.addAsyncCleanup(runtime.close)
            await runtime.change_cwd(self.other)
            await runtime.prompt("first target request")
            self.assertEqual(stream.options[-1].api_key, "test-key")
            self.assertEqual(stream.options[-1].max_tokens, 111)
            self.assertEqual(stream.options[-1].timeout_ms, 2222)

            write(self.other / ".foxcode/settings.json", json.dumps({
                "api_key_env": "FOX_TARGET_API_KEY", "stream_options": {"max_tokens": 333},
            }))
            with patch.dict(os.environ, {"FOX_TARGET_API_KEY": "target-key"}):
                await runtime.reload()
                await runtime.prompt("target override")
            self.assertEqual(stream.options[-1].api_key, "target-key")
            self.assertEqual(stream.options[-1].max_tokens, 333)
            self.assertEqual(stream.options[-1].timeout_ms, 2222)

    async def test_reload_preserves_history_and_queues_updates_resources_and_options(self):
        write(self.project / "AGENTS.md", "before")
        write(self.project / ".foxcode/prompts/review.md", "Review $ARGUMENTS")
        stream = scripted(FauxScript(text="first"), FauxScript(text="second"), FauxScript(text="third"))
        runtime = self.make_runtime(stream_fn=stream)
        await runtime.prompt("hello")
        original_file = runtime.session_file
        runtime.harness.follow_up("queued task")
        write(self.project / "AGENTS.md", "after reload")
        runtime.settings_manager.update({"stream_options": {"max_tokens": 80}, "tools": ["read"]})
        await runtime.reload()
        self.assertEqual(runtime.session_file, original_file)
        self.assertEqual(len(runtime.state.messages), 2)
        self.assertIn("after reload", runtime.state.system_prompt)
        self.assertEqual([t.name for t in runtime.state.tools], ["read"])
        await runtime.continue_()
        self.assertEqual(stream.contexts[-1].messages[-1].content[0].text, "queued task")
        self.assertEqual(stream.options[-1].max_tokens, 80)
        await runtime.invoke_prompt("review", "module.py")
        self.assertEqual(stream.contexts[-1].messages[-1].content[0].text, "Review module.py")

    async def test_failed_reload_or_switch_keeps_old_runtime(self):
        runtime = self.make_runtime(stream_fn=scripted(FauxScript(text="still works")))
        old = runtime.harness
        write(self.project / ".foxcode/settings.json", "{ invalid")
        with self.assertRaises(ValueError):
            await runtime.reload()
        self.assertIs(runtime.harness, old)
        with self.assertRaises(FileNotFoundError):
            await runtime.switch_session(self.root / "missing.jsonl")
        self.assertFalse((self.root / "missing.jsonl").exists())
        with self.assertRaises(NotADirectoryError):
            await runtime.change_cwd(self.root / "missing-dir")
        await runtime.prompt("still running")
        self.assertEqual(runtime.state.messages[-1].content[0].text, "still works")

    async def test_switch_cancels_running_tool_and_persists_outcome(self):
        entered = asyncio.Event()

        async def waiting(*args):
            entered.set()
            await asyncio.Event().wait()

        factory = lambda cwd: [tool_fixture("wait", "Wait", {"type": "object"}, waiting)]
        stream = scripted(FauxScript(tool_calls=[ToolCall(id="pending", name="wait", arguments={})]))
        runtime = self.make_runtime(stream_fn=stream, tool_factory=factory)
        original_file = runtime.session_file
        running = asyncio.create_task(runtime.prompt("wait"))
        await asyncio.wait_for(entered.wait(), 2)
        await asyncio.wait_for(runtime.change_cwd(self.other), 2)
        await asyncio.wait_for(running, 2)
        messages = Session(JsonlSessionStorage(original_file)).build_context()
        results = [m for m in messages if m.role == "toolResult"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].tool_call_id, "pending")
        self.assertTrue(results[0].is_error)
        self.assertEqual(runtime.cwd, self.other)

    async def test_user_sessions_are_project_scoped_and_close_is_final(self):
        SettingsManager(self.project, user_dir=self.user).update({"session_scope": "user"}, scope="user")
        runtime = self.make_runtime()
        original = runtime.session_file
        self.assertTrue(original.is_relative_to(self.user / "sessions"))
        await runtime.change_cwd(self.other)
        self.assertNotEqual(original.parent, runtime.session_file.parent)
        self.assertEqual(AgentSessionRuntime.latest_session(self.project, user_dir=self.user), original)
        await runtime.close()
        with self.assertRaisesRegex(RuntimeError, "closed"):
            await runtime.prompt("cannot run")


class CliTests(Workspace, unittest.IsolatedAsyncioTestCase):
    async def test_json_events_and_resume_keep_transcript(self):
        parser = build_parser()
        args = parser.parse_args(["--cwd", str(self.project), "--user-dir", str(self.user),
                                  "--provider", "faux", "--model", "faux", "--json", "-p", "first"])
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = await run(args, stream_fn=scripted(FauxScript(text="hello")))
        self.assertEqual(result, 0)
        events = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(events[0]["type"], "session_start")
        self.assertEqual(events[-1]["type"], "agent_end")
        self.assertIn("Session:", stderr.getvalue())
        path = Path(events[0]["session_file"])
        resumed = parser.parse_args(["--resume", str(path), "--user-dir", str(self.user), "-p", "second"])
        stream = scripted(FauxScript(text="restored"))
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(await run(resumed, stream_fn=stream), 0)
        self.assertEqual(stdout.getvalue().strip(), "restored")
        self.assertEqual(len(stream.contexts[0].messages), 3)
        self.assertEqual(len(Session(JsonlSessionStorage(path)).build_context()), 4)

    async def test_resume_unfinished_user_message(self):
        runtime = AgentSessionRuntime(self.project, user_dir=self.user, model=FAUX_MODEL)
        runtime.session.append_message(UserMessage(content="unfinished"))
        path = runtime.session_file
        await runtime.close()
        args = build_parser().parse_args(["--resume", str(path), "--user-dir", str(self.user)])
        stream = scripted(FauxScript(text="finished"))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(await run(args, stream_fn=stream), 0)
        self.assertEqual(stream.contexts[0].messages[-1].content, "unfinished")


class CliProcessTests(Workspace, unittest.TestCase):
    def command(self, *args):
        packages = str(Path(__file__).resolve().parents[1] / "packages")
        return subprocess.run([sys.executable, "-m", "fox_coding_agent.src", "--user-dir", str(self.user), *args],
                              cwd=self.project, env={**os.environ, "PYTHONPATH": packages},
                              capture_output=True, text=True, timeout=15)

    def test_entrypoint_print_json_and_latest(self):
        result = self.command("--provider", "faux", "--model", "faux", "-p", "test")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "faux response")
        resumed = self.command("-p", "next", "--resume", "--json")
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        events = [json.loads(line) for line in resumed.stdout.splitlines()]
        self.assertEqual(events[0]["type"], "session_start")
        self.assertEqual(events[-1]["type"], "agent_end")

    def test_missing_session_and_model_failure_exit_nonzero_json(self):
        result = self.command("--resume", str(self.root / "missing.jsonl"), "--json", "-p", "next")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["type"], "error")
        self.assertFalse((self.root / "missing.jsonl").exists())
        write(self.project / ".foxcode/settings.json", json.dumps({
            "model": FAUX_MODEL.model_dump(mode="json"), "max_turns": 1}))
        result = self.command("--model", "unknown", "--json", "-p", "test")
        self.assertEqual(result.returncode, 1)
        self.assertIn("--base-url", json.loads(result.stdout)["error"])


if __name__ == "__main__":
    unittest.main()
