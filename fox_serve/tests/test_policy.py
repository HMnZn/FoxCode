"""权限策略与审批代理测试（决定「弹不弹审批卡」的逻辑都在这）。"""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fox_serve.approvals import (  # noqa: E402
    ApprovalBroker,
    PermissionPolicy,
    build_preview,
    build_summary,
    extract_paths,
    inside_workspace,
)
from fox_serve.tests._tmp import temp_dir_obj  # noqa: E402


class PolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = temp_dir_obj()
        self.cwd = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_read_only_tool_is_always_allowed(self) -> None:
        policy = PermissionPolicy("read-only", cwd=self.cwd)
        decision = policy.evaluate(tool_name="read", required="read-only", args={"path": "a.txt"})
        self.assertEqual(decision.action, "allow")

    def test_read_only_mode_blocks_write_without_prompt(self) -> None:
        policy = PermissionPolicy("read-only", cwd=self.cwd)
        decision = policy.evaluate(tool_name="write", required="workspace-modify", args={"path": "a.txt"})
        self.assertEqual(decision.action, "block")
        self.assertEqual(decision.reason, "mode-insufficient")
        self.assertIn("只读", decision.detail)

    def test_workspace_modify_allows_inside_write(self) -> None:
        policy = PermissionPolicy("workspace-modify", cwd=self.cwd)
        decision = policy.evaluate(
            tool_name="write",
            required="workspace-modify",
            args={"path": str(self.cwd / "notes.md")},
            permission_paths=("path",),
        )
        self.assertEqual(decision.action, "allow")

    def test_workspace_modify_asks_for_outside_write(self) -> None:
        policy = PermissionPolicy("workspace-modify", cwd=self.cwd)
        decision = policy.evaluate(
            tool_name="write",
            required="workspace-modify",
            args={"path": str(self.cwd.parent / "elsewhere.md")},
            permission_paths=("path",),
        )
        self.assertEqual(decision.action, "ask")
        self.assertEqual(decision.reason, "outside-workspace")
        self.assertEqual(decision.path, str(self.cwd.parent / "elsewhere.md"))

    def test_workspace_modify_allows_shell_without_prompt(self) -> None:
        policy = PermissionPolicy("workspace-modify", cwd=self.cwd)
        decision = policy.evaluate(
            tool_name="bash", required="full-access", args={"command": "git log --oneline"}
        )
        self.assertEqual(decision.action, "allow")
        self.assertEqual(decision.reason, "policy")

    def test_full_access_mode_allows_everything(self) -> None:
        policy = PermissionPolicy("full-access", cwd=self.cwd)
        decision = policy.evaluate(tool_name="bash", required="full-access", args={})
        self.assertEqual(decision.action, "allow")

    def test_session_allowlist_skips_next_prompt(self) -> None:
        policy = PermissionPolicy("workspace-modify", cwd=self.cwd)
        policy.allow_tool("bash")
        decision = policy.evaluate(tool_name="bash", required="full-access", args={})
        self.assertEqual(decision.action, "allow")

    def test_set_mode_validates(self) -> None:
        policy = PermissionPolicy("workspace-modify", cwd=self.cwd)
        self.assertEqual(policy.set_mode("full-access"), "full-access")
        with self.assertRaises(ValueError):
            policy.set_mode("yolo")

    def test_unknown_required_permission_defaults_to_full_access(self) -> None:
        policy = PermissionPolicy("workspace-modify", cwd=self.cwd)
        decision = policy.evaluate(tool_name="mystery", required="nonsense", args={})
        self.assertEqual(decision.action, "ask")

    def test_extract_paths_uses_permission_paths_then_fallbacks(self) -> None:
        args = {"file_path": "a.txt", "path": "b.txt", "other": "x"}
        self.assertEqual(extract_paths(args, ("file_path",)), ["a.txt"])
        self.assertEqual(extract_paths(args), ["b.txt", "a.txt"])

    def test_inside_workspace_handles_relative_and_absolute(self) -> None:
        self.assertTrue(inside_workspace("sub/dir/file.txt", self.cwd))
        self.assertTrue(inside_workspace(str(self.cwd / "file.txt"), self.cwd))
        self.assertFalse(inside_workspace("../file.txt", self.cwd))


class SummaryAndPreviewTests(unittest.TestCase):
    def test_summary_for_shell_and_write(self) -> None:
        shell = build_summary("bash", "full-access", [], {"command": "ls -la\n"})
        self.assertIn("执行 shell 命令", shell)
        self.assertIn("ls -la", shell)
        write = build_summary("write", "workspace-modify", ["C:/tmp/a.md"], {"path": "C:/tmp/a.md"})
        self.assertEqual(write, "写入 C:/tmp/a.md")

    def test_preview_command_path_and_diff(self) -> None:
        self.assertEqual(
            build_preview("bash", {"command": "echo hi"}, "full-access", []),
            {"kind": "command", "command": "echo hi"},
        )
        self.assertEqual(
            build_preview("write", {"path": "a.md"}, "workspace-modify", ["a.md"]),
            {"kind": "path", "paths": ["a.md"]},
        )
        diff = build_preview(
            "edit", {"old_string": "a\n", "new_string": "b\n"}, "workspace-modify", ["a.md"]
        )
        assert diff is not None
        self.assertEqual(diff["kind"], "diff")
        self.assertIn("+b", diff["diff"])
        self.assertIsNone(build_preview("read", {}, "read-only", []))


class ApprovalBrokerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._tmp = temp_dir_obj()
        self.policy = PermissionPolicy("workspace-modify", cwd=Path(self._tmp.name))
        self.requests: list[dict] = []
        self.broker = ApprovalBroker(
            policy=self.policy, on_request=self.requests.append, timeout=5.0
        )

    async def asyncTearDown(self) -> None:
        self._tmp.cleanup()

    async def _ask(self, **overrides):
        payload = {
            "tool_call_id": "call_1",
            "tool_name": "bash",
            "args": {"command": "ls"},
            "required": "full-access",
            "summary": "执行 shell 命令",
            "request_extra": {"reason": "mode-insufficient", "preview": None, "path": None},
        }
        payload.update(overrides)
        return await self.broker.ask(**payload)

    async def test_allow_once_round_trip(self) -> None:
        task = asyncio.ensure_future(self._ask())
        while not self.requests:
            await asyncio.sleep(0.01)
        request_id = self.requests[0]["id"]
        self.assertEqual(self.broker.pending_ids, [request_id])
        self.assertTrue(self.broker.answer(request_id, "allow-once"))
        self.assertEqual(await task, "allow-once")
        self.assertEqual(self.broker.pending_ids, [])

    async def test_request_shape_matches_frontend_contract(self) -> None:
        task = asyncio.ensure_future(self._ask())
        while not self.requests:
            await asyncio.sleep(0.01)
        request = self.requests[0]
        for key in ("id", "ts", "tool_call_id", "tool_name", "args", "required", "mode", "cwd", "summary", "reason"):
            self.assertIn(key, request)
        self.assertEqual(request["mode"], "workspace-modify")
        self.assertIn(request["reason"], ("mode-insufficient", "outside-workspace", "policy", "always-ask"))
        self.broker.answer(request["id"], "deny")
        self.assertEqual(await task, "deny")

    async def test_allow_session_extends_policy(self) -> None:
        task = asyncio.ensure_future(self._ask())
        while not self.requests:
            await asyncio.sleep(0.01)
        self.broker.answer(self.requests[0]["id"], "allow-session")
        self.assertEqual(await task, "allow-session")
        self.assertTrue(self.policy.is_allowed("bash"))

    async def test_unknown_answer_is_ignored(self) -> None:
        self.assertFalse(self.broker.answer("p999", "allow-once"))

    async def test_timeout_treated_as_deny(self) -> None:
        broker = ApprovalBroker(
            policy=self.policy, on_request=self.requests.append, timeout=0.05
        )
        verdict = await broker.ask(
            tool_call_id="call_2",
            tool_name="bash",
            args={},
            required="full-access",
            summary="执行 shell 命令",
            request_extra={},
        )
        self.assertEqual(verdict, "deny")

    async def test_cancel_all_denies_pending(self) -> None:
        task = asyncio.ensure_future(self._ask())
        while not self.requests:
            await asyncio.sleep(0.01)
        self.assertEqual(self.broker.cancel_all("会话已中止"), 1)
        self.assertEqual(await task, "deny")

    async def test_cancel_event_denies(self) -> None:
        cancel = asyncio.Event()
        task = asyncio.ensure_future(self._ask(cancel=cancel))
        while not self.requests:
            await asyncio.sleep(0.01)
        cancel.set()
        self.assertEqual(await task, "deny")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
