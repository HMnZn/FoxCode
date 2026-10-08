"""Coding host integration tests, using real filesystem operations and scripted model boundaries."""

import asyncio
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fox_ai.src import TextContent, ToolCall, UserMessage
from fox_ai.src.providers.faux import FAUX_MODEL, FauxScript
from fox_agent_core.src import AgentToolResult
from fox_coding_agent.src import (
    AgentSessionRuntime, BashTool, FindTool, GrepTool, LsTool, ModelConfig,
    ModelRegistry, PowerShellTool,
    ResourceLoader, SettingsManager, ReadTool, WriteTool, build_system_prompt,
)
from fox_coding_agent.src.cli import build_parser, run
from test_agent_core import scripted, tool_fixture
from test_runtime import Workspace, write


class CodingToolTests(Workspace, unittest.IsolatedAsyncioTestCase):
    async def test_find_nested_ignores_glob_and_ls(self):
        write(self.project / ".gitignore", "*.log\n!keep.log\nignored/\n")
        write(self.project / "keep.log", "keep")
        write(self.project / "drop.log", "drop")
        write(self.project / "ignored/a.py", "ignored")
        write(self.project / "src/.gitignore", "private.py\n")
        write(self.project / "src/private.py", "private")
        write(self.project / "src/main.py", "main")
        write(self.project / "src/nested/mod.py", "module")
        result = await FindTool(self.project).execute("find", {"pattern": "**/*.py"})
        self.assertEqual(result.content[0].text.splitlines(), ["src/main.py", "src/nested/mod.py"])
        result = await FindTool(self.project).execute("find", {"pattern": "*.log"})
        self.assertEqual(result.content[0].text, "keep.log")
        result = await LsTool(self.project).execute("ls", {})
        self.assertIn(".gitignore", result.content[0].text)
        self.assertIn("ignored/", result.content[0].text)

    async def test_find_limits_and_cancel(self):
        for i in range(4):
            write(self.project / f"{i}.py", "file")
        result = await FindTool(self.project).execute("find", {"pattern": "*.py", "limit": 2})
        self.assertTrue(result.details["truncated"])
        cancel = asyncio.Event()
        cancel.set()
        with self.assertRaisesRegex(Exception, "aborted"):
            await FindTool(self.project).execute("find", {"pattern": "*.py"}, cancel)
        with self.assertRaises(NotADirectoryError):
            await FindTool(self.project).execute("find", {"pattern": "*", "path": "absent"})

    async def test_grep_literal_fallback_and_context(self):
        write(self.project / "sample.txt", "before\nTARGET literal .*\nafter\n")
        with patch("fox_coding_agent.src.core.tools.shutil.which", return_value=None):
            tool = GrepTool(self.project)
            result = await tool.execute("grep", {"pattern": "target literal .*", "literal": True,
                                                  "ignoreCase": True, "context": 1})
            self.assertIn("sample.txt:1:before", result.content[0].text)
            self.assertIn("sample.txt:2:TARGET literal .*", result.content[0].text)
            self.assertIn("sample.txt:3:after", result.content[0].text)
            with self.assertRaisesRegex(RuntimeError, "ripgrep"):
                await tool.execute("grep", {"pattern": "target.*"})

    @unittest.skipUnless(shutil.which("rg"), "ripgrep is unavailable")
    async def test_grep_real_rg_regex_errors_and_limit(self):
        write(self.project / "code.py", "hello12\nhello34\nhello56\n")
        result = await GrepTool(self.project).execute("grep", {"pattern": "hello[0-9]+", "limit": 2})
        self.assertTrue(result.details["truncated"])
        self.assertIn("hello12", result.content[0].text)
        with self.assertRaises(RuntimeError):
            await GrepTool(self.project).execute("grep", {"pattern": "["})

    async def test_powershell_argument_vector_and_missing_executable(self):
        tool = PowerShellTool(self.project, shell="pwsh-test")
        command = tool._command("Write-Output 'a;b'")
        self.assertEqual(command[:5],
                         ["pwsh-test", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
        self.assertIn("[Console]::OutputEncoding", command[-1])
        self.assertTrue(command[-1].endswith("Write-Output 'a;b'"))
        with patch("fox_coding_agent.src.core.tools.shutil.which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "PowerShell"):
                await PowerShellTool(self.project).execute("ps", {"command": "echo hello"})

    @unittest.skipUnless(
        shutil.which("pwsh") or shutil.which("powershell"),
        "PowerShell is unavailable",
    )
    async def test_powershell_uses_utf8_and_workspace_local_temp(self):
        result = await PowerShellTool(self.project).execute(
            "ps", {"command": "Write-Output '中文正常'; Write-Output $env:TEMP"}
        )
        text = result.content[0].text
        self.assertIn("中文正常", text)
        self.assertIn(str(self.project / ".foxcode" / "artifacts" / "tmp").lower(), text.lower())

        script = self.project / "中文脚本.ps1"
        await WriteTool(self.project).execute(
            "write-ps1",
            {"path": script.name, "content": "Write-Output '脚本中文正常'\n"},
        )
        self.assertTrue(script.read_bytes().startswith(b"\xef\xbb\xbf"))
        script_result = await PowerShellTool(self.project).execute(
            "run-ps1", {"command": f"& '{script}'"}
        )
        self.assertIn("脚本中文正常", script_result.content[0].text)

    @unittest.skipUnless(
        os.name == "nt" and (shutil.which("bash") or "").lower().endswith("system32\\bash.exe"),
        "Windows WSL bash launcher is unavailable",
    )
    async def test_wsl_bash_uses_mnt_workspace_temp(self):
        tool = BashTool(self.project)
        result = await tool.execute("bash", {"command": "printf '%s' \"$TEMP\""})
        expected = "/mnt/" + str(self.project / ".foxcode" / "artifacts" / "tmp")[0].lower()
        self.assertTrue(result.content[0].text.startswith(expected + "/"))
        self.assertIn("Windows bash may be WSL", tool.description)


class SystemPromptTests(Workspace, unittest.TestCase):
    def test_custom_system_and_append_files(self):
        write(self.user / "SYSTEM.md", "user prefix")
        write(self.project / ".foxcode/SYSTEM.md", "project prefix")
        write(self.user / "APPEND_SYSTEM.md", "user addendum")
        write(self.project / ".foxcode/APPEND_SYSTEM.md", "project addendum")
        write(self.project / "AGENTS.md", "project instruction")
        resources = ResourceLoader(self.project, user_dir=self.user).load()
        prompt = build_system_prompt(cwd=self.project, tools=[ReadTool(self.project)], resources=resources,
                                     custom_prompt=resources.system_prompt_override)
        self.assertTrue(prompt.startswith("project prefix"))
        self.assertIn("user addendum", prompt)
        self.assertIn("project addendum", prompt)
        self.assertIn("project instruction", prompt)
        self.assertIn("- read:", prompt)
        self.assertNotIn("- write:", prompt)


class AuthTests(Workspace, unittest.IsolatedAsyncioTestCase):
    def write_auth(self):
        write(self.user / "models.json", json.dumps({"providers": {"demo": {
            "baseUrl": "https://demo.invalid", "api": "openai-completions",
            "models": [
                {"id": "flash", "name": "Flash", "contextWindow": 32768, "maxTokens": 100,
                 "input": ["text"], "reasoning": True,
                 "compat": {"thinkingFormat": "deepseek"}, "thinkingLevelMap": {"high": "max"}},
                {"id": "pro", "name": "Pro", "contextWindow": 65536, "maxTokens": 200,
                 "input": ["text"], "reasoning": True},
            ],
        }}}))
        write(self.user / "auth.json", json.dumps({
            "demo": {"type": "api_key", "key": "auth-secret"}
        }))

    async def test_auth_models_are_default_switchable_and_never_persist_key(self):
        self.write_auth()
        registry = ModelRegistry(ModelConfig(self.user))
        self.assertEqual([entry.reference for entry in registry.models], ["demo/flash", "demo/pro"])
        self.assertEqual(registry.resolve("flash").model.thinking_level_map["high"], "max")
        stream = scripted(FauxScript(text="first"), FauxScript(text="second"))
        runtime = AgentSessionRuntime(self.project, user_dir=self.user, stream_fn=stream)
        self.addAsyncCleanup(runtime.close)
        self.assertEqual(runtime.state.model.id, "flash")
        runtime.set_thinking_level("high")
        await runtime.prompt("first")
        self.assertEqual(stream.options[-1].api_key, "auth-secret")
        runtime.select_model("demo/pro")
        await runtime.prompt("second")
        self.assertEqual(runtime.state.model.id, "pro")
        self.assertEqual(stream.options[-1].api_key, "auth-secret")
        self.assertNotIn("auth-secret", runtime.session_file.read_text(encoding="utf-8"))

    def test_core_import_does_not_import_host(self):
        packages = str(Path(__file__).resolve().parents[1] / "packages")
        result = subprocess.run([sys.executable, "-c",
            "import sys; import fox_agent_core.src; assert 'fox_coding_agent' not in sys.modules"],
            env={**os.environ, "PYTHONPATH": packages}, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)


class ExtensionTests(Workspace, unittest.IsolatedAsyncioTestCase):
    def runtime(self, **kwargs):
        runtime = AgentSessionRuntime(self.project, user_dir=self.user, model=FAUX_MODEL, **kwargs)
        self.addAsyncCleanup(runtime.close)
        return runtime

    async def test_custom_tool_prompt_events_and_command(self):
        events, executed = [], []

        def setup(api):
            async def tool(call_id, params, cancel, update):
                executed.append(params["value"])
                return AgentToolResult([TextContent(text=params["value"].upper())])
            api.register_tool(tool_fixture("uppercase", "Uppercase text", {"type": "object", "properties": {
                "value": {"type": "string"}}, "required": ["value"]}, tool))
            api.register_command("where", lambda args, ctx: str(ctx.cwd), "Show cwd")
            api.add_prompt_guideline("Always report the actual tool result.")
            api.on("before_prompt", lambda data, ctx: {"message": "transformed " + data["message"]})
            api.on("session_start", lambda data, ctx: events.append("start"))
            api.on("session_shutdown", lambda data, ctx: events.append(data["reason"]))

        stream = scripted(FauxScript(tool_calls=[ToolCall(id="u", name="uppercase", arguments={"value": "fox"})]),
                          FauxScript(text="FOX"))
        runtime = self.runtime(extension_factories=(setup,), stream_fn=stream)
        self.assertIn("Always report the actual tool result.", runtime.state.system_prompt)
        await runtime.prompt("please uppercase")
        self.assertEqual(executed, ["fox"])
        self.assertEqual(stream.contexts[0].messages[0].content[0].text, "transformed please uppercase")
        self.assertEqual(await runtime.run_command("where"), str(self.project))
        await runtime.close()
        self.assertEqual(events, ["start", "close"])

    async def test_hook_blocks_tool_and_can_decorate_result(self):
        def setup(api):
            api.on("tool_call", lambda data, ctx: {"block": True, "reason": "read-only extension"}
                   if data["tool_call"].name == "write" else None)
            api.on("tool_result", lambda data, ctx: {"details": {"reviewed": True}})

        stream = scripted(FauxScript(tool_calls=[ToolCall(id="w", name="write", arguments={
            "path": "must-not-exist.txt", "content": "blocked"})]), FauxScript(text="blocked"))
        runtime = self.runtime(extension_factories=(setup,), stream_fn=stream)
        await runtime.prompt("write")
        self.assertFalse((self.project / "must-not-exist.txt").exists())
        result = next(m for m in runtime.state.messages if m.role == "toolResult")
        self.assertTrue(result.is_error)
        self.assertEqual(result.details, {"reviewed": True})

    async def test_file_reload_no_stale_modules_or_duplicate_handlers(self):
        extension = self.project / ".foxcode/extensions/demo.py"
        write(extension, 'def setup(api):\n    api.register_command("version", lambda args, ctx: "one")\n')
        SettingsManager(self.project, user_dir=self.user).update({"extensions": ["extensions/demo.py"]})
        runtime = self.runtime()
        self.assertEqual(await runtime.run_command("version"), "one")
        old_modules = set(runtime.agent_session.extensions._modules)
        write(extension, 'def setup(api):\n    api.register_command("version", lambda args, ctx: "two")\n')
        await runtime.reload()
        self.assertEqual(await runtime.run_command("version"), "two")
        self.assertTrue(old_modules.isdisjoint(sys.modules))
        previous = runtime.agent_session
        write(extension, 'def setup(api):\n    raise ValueError("bad plugin")\n')
        with self.assertRaisesRegex(ValueError, "bad plugin"):
            await runtime.reload()
        self.assertIs(runtime.agent_session, previous)
        self.assertEqual(await runtime.run_command("version"), "two")

    async def test_collision_fails_without_new_session_file(self):
        def setup(api):
            api.register_tool(WriteTool(self.project))
        with self.assertRaisesRegex(ValueError, "collide"):
            self.runtime(extension_factories=(setup,))
        self.assertFalse(list((self.project / ".foxcode/sessions").glob("*.jsonl")))

    async def test_enabled_tools_refresh_system_prompt(self):
        runtime = self.runtime()
        runtime.agent_session.set_active_tools(["read"])
        self.assertIn("- read:", runtime.state.system_prompt)
        self.assertNotIn("- write:", runtime.state.system_prompt)
        runtime.agent_session.set_active_tools([])
        self.assertIn("<tools>\n(none)", runtime.state.system_prompt)

    async def test_compaction_through_runtime_is_persisted_and_observable(self):
        calls = []

        async def summary(model, messages, **kwargs):
            calls.append(messages)
            return "Preserved release ID demo-42 and remaining task."

        events = []
        def setup(api):
            api.on("compaction_end", lambda event, ctx: events.append(event.result.removed_count))

        runtime = self.runtime(summary_fn=summary, extension_factories=(setup,),
                               settings_overrides={"compaction": {"enabled": False, "keep_recent_tokens": 20}})
        runtime.session.append_message(UserMessage(content="history " * 300))
        runtime.session.append_message(UserMessage(content="recent"))
        await runtime.reload()
        result = await runtime.compact()
        self.assertGreater(result.removed_count, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(events, [result.removed_count])
        self.assertEqual(runtime.session.get_entries()[-1].type, "compaction")


class CodingCliTests(Workspace, unittest.IsolatedAsyncioTestCase):
    def args(self, *extra):
        return build_parser().parse_args(["--cwd", str(self.project), "--user-dir", str(self.user),
            "--model", "faux/faux", *extra])

    async def test_json_command_extension_output_is_on_stderr(self):
        path = self.root / "extension.py"
        write(path, 'print("loading")\ndef setup(api):\n    api.register_command("hello", lambda args, ctx: "hi " + args)\n')
        write(self.user / "settings.json", json.dumps({"extensions": [str(path)]}))
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = await run(self.args("--command", "hello", "-p", "Fox", "--json"))
        self.assertEqual(result, 0)
        events = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(events[-1], {"type": "command_result", "name": "hello", "result": "hi Fox"})
        self.assertIn("loading", stderr.getvalue())

    async def test_interactive_commands_and_two_prompts(self):
        stream = scripted(FauxScript(text="first answer"), FauxScript(text="second answer"))
        with patch("builtins.input", side_effect=["/model", "/thinking off", "hello", "/tools read", "/reload", "again", "/exit"]), \
             contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(await run(self.args("--interactive"), stream_fn=stream), 0)
        self.assertIn("first answer", output.getvalue())
        self.assertIn("second answer", output.getvalue())
        self.assertIn("faux/faux", output.getvalue())
        self.assertIn("思考强度: off", output.getvalue())
        self.assertEqual([tool.name for tool in stream.contexts[-1].tools], ["read"])
        self.assertEqual(len(stream.contexts[-1].messages), 3)

    async def test_interactive_permission_and_fork(self):
        with patch("builtins.input", side_effect=["/permission read-only", "/fork", "/exit"]), \
             contextlib.redirect_stdout(io.StringIO()) as output, \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(await run(self.args("--interactive")), 0)
        self.assertIn("权限: read-only", output.getvalue())
        # The untouched initial draft is memory-only; explicit /fork publishes
        # exactly one user-level session directory.
        self.assertEqual(len(list((self.user / "sessions").rglob("session.jsonl"))), 1)
        self.assertFalse((self.project / ".foxcode/sessions").exists())

    async def test_template_action(self):
        write(self.project / ".foxcode/prompts/review.md", "Review $ARGUMENTS")
        stream = scripted(FauxScript(text="reviewed"))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            await run(self.args("--template", "review", "-p", "example.py"), stream_fn=stream)
        self.assertEqual(stream.contexts[0].messages[0].content[0].text, "Review example.py")


if __name__ == "__main__":
    unittest.main()
