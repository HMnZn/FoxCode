from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fox_coding_agent.src.core.paths import ProjectPaths, UserPaths
from fox_coding_agent.src.core.sandbox import (
    SandboxCapability, check_sandbox_tool, sandbox_shell_command,
)
from fox_coding_agent.src.core.session_manager import (
    InMemorySessionStorage, JsonlSessionStorage, SessionManager,
)
from fox_coding_agent.src.core.tools import BashTool, ReadTool, WriteTool
from fox_coding_agent.src import AgentSession, AgentSessionConfig
from fox_ai.src.providers.faux import FAUX_MODEL


class PathLayoutTests(unittest.TestCase):
    def test_user_inputs_and_project_outputs_have_one_layout(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            user = UserPaths.from_root(root / "user")
            project = ProjectPaths.from_root(root / "project")
            self.assertEqual(user.mcp, root / "user" / "mcp.json")
            self.assertEqual(user.skills, root / "user" / "skills")
            self.assertEqual(project.tests, root / "project" / ".foxcode" / "artifacts" / "tests")
            self.assertEqual(project.temp, root / "project" / ".foxcode" / "artifacts" / "tmp")


class SandboxToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_file_tools_cannot_escape_in_sandbox_mode(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            workspace = Path(raw) / "project"
            workspace.mkdir()
            tool = WriteTool(workspace)
            tool.set_execution_mode("sandbox")
            with self.assertRaisesRegex(PermissionError, "outside the project"):
                await tool.execute("call", {"path": "../escaped.txt", "content": "no"})
            self.assertFalse((workspace.parent / "escaped.txt").exists())

    async def test_read_tools_are_guarded_too(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            workspace = Path(raw) / "project"
            workspace.mkdir()
            outside = Path(raw) / "secret.txt"
            outside.write_text("secret", encoding="utf-8")
            tool = ReadTool(workspace)
            tool.set_execution_mode("sandbox")
            with self.assertRaises(PermissionError):
                await tool.execute("call", {"path": str(outside)})

    async def test_shell_environment_routes_artifacts_to_project(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            workspace = Path(raw) / "project"
            workspace.mkdir()
            environment = BashTool(workspace)._environment()  # noqa: SLF001
            project = ProjectPaths.from_root(workspace)
            self.assertEqual(environment["FOXCODE_ARTIFACTS_DIR"], str(project.artifacts))
            self.assertEqual(environment["FOXCODE_TEST_ARTIFACTS_DIR"], str(project.tests))
            self.assertEqual(environment["TMPDIR"], str(project.temp))
            self.assertTrue(project.tests.is_dir())

    async def test_sandbox_shell_environment_does_not_inherit_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as raw, patch.dict(
            "os.environ", {"PATH": "/usr/bin", "OPENAI_API_KEY": "secret"}, clear=True,
        ):
            workspace = Path(raw) / "project"
            workspace.mkdir()
            tool = BashTool(workspace)
            tool.set_execution_mode("sandbox")
            environment = tool._environment()  # noqa: SLF001
            project = ProjectPaths.from_root(workspace)
            self.assertNotIn("OPENAI_API_KEY", environment)
            self.assertEqual(environment["PATH"], "/usr/bin")
            self.assertEqual(environment["HOME"], str(project.home))
            self.assertEqual(environment["XDG_CACHE_HOME"], str(project.cache))

    async def test_undeclared_extension_tool_is_blocked(self) -> None:
        class Unsafe:
            name = "extension_tool"

        self.assertIn("does not declare sandbox support", check_sandbox_tool(Unsafe(), {}, ".") or "")

    async def test_linux_native_wrapper_binds_only_the_project_writable(self) -> None:
        with tempfile.TemporaryDirectory() as raw, patch(
            "fox_coding_agent.src.core.sandbox.detect_sandbox",
            return_value=SandboxCapability("bubblewrap", True, True, "/usr/bin/bwrap"),
        ):
            workspace = Path(raw).resolve()
            command = sandbox_shell_command(["/bin/bash", "-c", "pytest"], workspace)
            self.assertEqual(command[0], "/usr/bin/bwrap")
            self.assertIn("--unshare-net", command)
            bind = command.index("--bind")
            self.assertEqual(command[bind + 1:bind + 3], [str(workspace), str(workspace)])

    async def test_macos_native_wrapper_denies_network_and_limits_writes(self) -> None:
        with tempfile.TemporaryDirectory() as raw, patch(
            "fox_coding_agent.src.core.sandbox.detect_sandbox",
            return_value=SandboxCapability("sandbox-exec", True, True, "/usr/bin/sandbox-exec"),
        ):
            workspace = Path(raw).resolve()
            command = sandbox_shell_command(["/bin/zsh", "-lc", "pytest"], workspace)
            self.assertEqual(command[:2], ["/usr/bin/sandbox-exec", "-p"])
            self.assertIn("(deny network*)", command[2])
            self.assertIn(str(workspace), command[2])


class ExecutionModePersistenceTests(unittest.TestCase):
    def test_execution_mode_is_branch_setting(self) -> None:
        session = SessionManager(InMemorySessionStorage())
        session.append_execution_mode_change("sandbox")
        self.assertEqual(session.build_settings()["execution_mode"], "sandbox")

    def test_agent_resume_and_fork_keep_sandbox_mode(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "session.jsonl"
            first = AgentSession(AgentSessionConfig(
                model=FAUX_MODEL,
                cwd=raw,
                session=SessionManager(JsonlSessionStorage(path)),
                skills=[],
            ))
            first.set_execution_mode("sandbox")
            restored = AgentSession(AgentSessionConfig(
                cwd=raw,
                session=SessionManager(JsonlSessionStorage(path)),
                skills=[],
            ))
            self.assertEqual(restored.execution_mode, "sandbox")
            self.assertEqual(restored.get_tool("write").execution_environment, "sandbox")
            self.assertEqual(restored.fork().execution_mode, "sandbox")


if __name__ == "__main__":
    unittest.main()
