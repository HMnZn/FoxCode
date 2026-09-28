"""宿主「一轮到底还在不在跑」的可观测状态。

前端只能从帧推断运行状态：**结束帧丢一次，界面就永远停在「生成中」**，用户除了重启
什么都做不了。所以 `host.info.busy` / `lastFrameAt` 与「没有在跑的一轮就拒绝插话」
这两件事必须钉住 —— 它们是前端自愈与「插话回落成直接发送」的唯一依据。
"""

from __future__ import annotations

import time
import types
import unittest
from typing import Any

from fox_serve.host import HostError, ServeHost


class _StubSession:
    def __init__(self) -> None:
        self.steers: list[str] = []
        self.follow_ups: list[str] = []

    def steer(self, message: str) -> None:
        self.steers.append(message)

    def follow_up(self, message: str) -> None:
        self.follow_ups.append(message)


class _StubRuntime:
    """`host.info` 与 `_enqueue` 会碰到的属性，只装配这些。"""

    def __init__(self) -> None:
        self.agent_session = _StubSession()
        self.cwd = "C:/work"
        self.session_file = "C:/work/.foxcode/sessions/live.jsonl"
        self.state = types.SimpleNamespace(model=None)
        self.available_models: list[Any] = []
        self.project_trusted = True
        self.permission_mode = "workspace-modify"


def _bare_host(runtime: Any | None = None) -> ServeHost:
    """绕过 `ServeHost.__init__`（真实构造要拉起 runtime 与扩展）。"""

    host = ServeHost.__new__(ServeHost)
    host._runtime = runtime
    host._closed = False
    host.cwd = "C:/work"
    host.project_trusted = True
    host._seq = 0
    host._started_at = time.time()
    host._agent_running = False
    host._last_frame_at = time.time()
    host._log_line = lambda message: None
    host.frames: list[dict[str, Any]] = []
    host._send = lambda payload: host.frames.append(payload)
    return host


class AgentRunningFlagTests(unittest.TestCase):
    def test_start_and_end_frames_toggle_busy(self) -> None:
        host = _bare_host()
        host._emit_frame({"type": "agent_start"})
        self.assertTrue(host._agent_running)
        host._emit_frame({"type": "agent_end"})
        self.assertFalse(host._agent_running)

    def test_error_frame_also_ends_the_run(self) -> None:
        # 出错之后界面还显示「生成中」是最糟的组合：既没结果也不解锁。
        host = _bare_host()
        host._emit_frame({"type": "agent_start"})
        host._emit_frame({"type": "error", "error": "boom"})
        self.assertFalse(host._agent_running)

    def test_every_frame_moves_the_heartbeat(self) -> None:
        host = _bare_host()
        host._last_frame_at = 0.0
        host._emit_frame({"type": "turn_start"})
        self.assertGreater(host._last_frame_at, 0.0)
        self.assertEqual(host.frames[0]["frame"]["seq"], 1)
        self.assertEqual(host.frames[0]["frame"]["type"], "turn_start")

    def test_tool_frames_do_not_change_busy(self) -> None:
        host = _bare_host()
        host._emit_frame({"type": "agent_start"})
        host._emit_frame({"type": "tool_execution_start", "tool_call_id": "t1", "tool_name": "ls"})
        self.assertTrue(host._agent_running)


class SteerRefusalTests(unittest.IsolatedAsyncioTestCase):
    async def test_steer_is_refused_when_nothing_is_running(self) -> None:
        host = _bare_host(_StubRuntime())
        with self.assertRaises(HostError) as caught:
            await host._cmd_steer({"message": "顺便看一眼"})
        message = str(caught.exception)
        self.assertIn("没有正在运行的一轮", message)
        self.assertIn("steer", message)

    async def test_follow_up_is_refused_when_nothing_is_running(self) -> None:
        host = _bare_host(_StubRuntime())
        with self.assertRaises(HostError) as caught:
            await host._cmd_follow_up({"message": "接着做"})
        self.assertIn("follow_up", str(caught.exception))

    async def test_steer_lands_in_the_session_queue_while_running(self) -> None:
        runtime = _StubRuntime()
        host = _bare_host(runtime)
        host._agent_running = True
        result = await host._cmd_steer({"message": "顺便看一眼"})
        self.assertEqual(result, {"queued": "steer"})
        self.assertEqual(runtime.agent_session.steers, ["顺便看一眼"])

    async def test_follow_up_lands_in_the_session_queue_while_running(self) -> None:
        runtime = _StubRuntime()
        host = _bare_host(runtime)
        host._agent_running = True
        result = await host._cmd_follow_up({"message": "接着做"})
        self.assertEqual(result, {"queued": "follow_up"})
        self.assertEqual(runtime.agent_session.follow_ups, ["接着做"])

    async def test_an_empty_message_is_still_an_argument_error(self) -> None:
        host = _bare_host(_StubRuntime())
        with self.assertRaises(HostError) as caught:
            await host._cmd_steer({"message": "   "})
        self.assertIn("非空的 message", str(caught.exception))


class RunPromptTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_returning_prompt_clears_busy(self) -> None:
        # 正常收尾时 `agent_end` 已经翻过标志，但没有结束帧的一轮也必须解锁。
        class _Ok:
            async def prompt(self, message: str) -> None:
                return None

        host = _bare_host(_Ok())
        host._agent_running = True
        await host._run_prompt("你好")
        self.assertFalse(host._agent_running)
        self.assertEqual(host.frames, [])

    async def test_a_failing_prompt_becomes_an_error_frame_and_clears_busy(self) -> None:
        class _Broken:
            async def prompt(self, message: str) -> None:
                raise RuntimeError("provider exploded")

        host = _bare_host(_Broken())
        host._agent_running = True
        await host._run_prompt("你好")

        self.assertFalse(host._agent_running)
        kinds = [payload["frame"]["type"] for payload in host.frames]
        self.assertEqual(kinds, ["error"])
        self.assertIn("provider exploded", host.frames[0]["frame"]["error"])


class HostInfoBusyTests(unittest.IsolatedAsyncioTestCase):
    """`host.info` 必须带上 busy / lastFrameAt：前端每 4 秒拿它对账。"""

    def _info_host(self) -> ServeHost:
        host = _bare_host(_StubRuntime())
        host._policy = types.SimpleNamespace(
            mode="workspace-modify",
            snapshot=lambda: {"mode": "workspace-modify"},
        )
        host._thinking_level = lambda: "medium"
        host._extension_views_safe = lambda: ([], [])
        host._context_tokens = lambda: 0
        host._model_info = lambda model: {"id": "deepseek-v4-flash", "displayName": "DeepSeek V4 Flash"}
        host._skills = lambda: []
        host._commands = lambda: []
        return host

    async def test_reports_not_busy_between_runs(self) -> None:
        host = self._info_host()
        info = await host._cmd_host_info({})
        self.assertIs(info["busy"], False)
        self.assertIsInstance(info["lastFrameAt"], int)
        self.assertGreater(info["lastFrameAt"], 0)

    async def test_reports_busy_while_a_run_is_in_flight(self) -> None:
        host = self._info_host()
        host._agent_running = True
        info = await host._cmd_host_info({})
        self.assertIs(info["busy"], True)
