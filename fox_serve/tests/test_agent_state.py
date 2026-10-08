"""宿主「一轮到底还在不在跑」的可观测状态。

前端只能从帧推断运行状态：**结束帧丢一次，界面就永远停在「生成中」**，用户除了重启
什么都做不了。所以 `host.info.busy` / `lastFrameAt` 与「没有在跑的一轮就拒绝插话」
这两件事必须钉住 —— 它们是前端自愈与「插话回落成直接发送」的唯一依据。
"""

from __future__ import annotations

import time
import types
import unittest
import asyncio
from pathlib import Path
from typing import Any

from fox_serve.approvals import PermissionPolicy
from fox_serve.host import HostError, ServeHost, prompt_message
from fox_ai.src import (
    AssistantMessage,
    ImageContent,
    TextContent,
    ToolCall,
    ToolResultMessage,
    UserMessage,
)
from fox_ai.src.events import ToolCallDeltaEvent, ToolCallEndEvent, ToolCallStartEvent
from fox_agent_core.src.types import MessageUpdateEvent
from fox_coding_agent.src.core.session_manager import SessionManager


class _StubSession:
    def __init__(self) -> None:
        self.steers: list[str] = []
        self.follow_ups: list[str] = []

    def steer(self, message: str) -> None:
        self.steers.append(message)

    def follow_up(self, message: str) -> None:
        self.follow_ups.append(message)

    def promote_follow_ups(self) -> int:
        promoted = len(self.follow_ups)
        self.steers.extend(self.follow_ups)
        self.follow_ups.clear()
        return promoted

    def has_queued_messages(self) -> bool:
        return bool(self.steers or self.follow_ups)


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
        self.interaction_mode = "auto"
        self.effective_interaction_mode = "default"
        self.execution_mode = "local"
        self.aborted = False
        self.continued = 0

    def abort(self) -> None:
        self.aborted = True

    async def continue_(self) -> None:
        self.continued += 1

    def set_interaction_mode(self, mode: str) -> str:
        if mode not in ("auto", "default", "plan"):
            raise ValueError("invalid interaction mode")
        self.interaction_mode = mode
        self.effective_interaction_mode = "plan" if mode == "plan" else "default"
        return mode

    def set_execution_mode(self, mode: str) -> str:
        if mode not in ("local", "sandbox"):
            raise ValueError("invalid execution mode")
        self.execution_mode = mode
        return mode


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
    host._tasks = set()
    host._runtime_tasks = {}
    host._running_runtimes = set()
    host._toolcall_delta_at = {}
    host._toolcall_delta_pending = {}
    host._tools = {}
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

    def test_tool_call_deltas_are_rate_limited_but_terminal_call_is_forwarded(self) -> None:
        runtime = _StubRuntime()
        host = _bare_host(runtime)
        partial = AssistantMessage(
            content=[ToolCall(id="write-1", name="write", arguments={})]
        )

        def update(stream_event: object) -> MessageUpdateEvent:
            return MessageUpdateEvent(
                message=partial,
                assistant_message_event=stream_event,  # type: ignore[arg-type]
            )

        host._on_runtime_event(
            runtime,
            update(ToolCallStartEvent(content_index=0, partial=partial)),
        )
        host._on_runtime_event(
            runtime,
            update(ToolCallDeltaEvent(content_index=0, delta="a", partial=partial)),
        )
        host._on_runtime_event(
            runtime,
            update(ToolCallDeltaEvent(content_index=0, delta="b", partial=partial)),
        )
        # Simulate enough elapsed time without making the test sleep.
        host._toolcall_delta_at[(id(runtime), 0)] -= 1
        host._on_runtime_event(
            runtime,
            update(ToolCallDeltaEvent(content_index=0, delta="c", partial=partial)),
        )
        final_call = ToolCall(id="write-1", name="write", arguments={"content": "abc"})
        host._on_runtime_event(
            runtime,
            update(
                ToolCallEndEvent(
                    content_index=0,
                    tool_call=final_call,
                    partial=AssistantMessage(content=[final_call]),
                )
            ),
        )

        stream_types = [
            envelope["frame"]["assistant_message_event"]["type"]
            for envelope in host.frames
        ]
        self.assertEqual(
            stream_types,
            ["toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end"],
        )
        streamed_arguments = "".join(
            envelope["frame"]["assistant_message_event"].get("delta", "")
            for envelope in host.frames
        )
        self.assertEqual(streamed_arguments, "abc")
        final_event = host.frames[-1]["frame"]["assistant_message_event"]
        self.assertEqual(final_event["tool_call"]["arguments"], {"content": "abc"})
        self.assertNotIn((id(runtime), 0), host._toolcall_delta_at)

        # A call can finish before the throttle window elapses. Its queued
        # fragment must be flushed immediately before the terminal event.
        host.frames.clear()
        host._on_runtime_event(
            runtime,
            update(ToolCallStartEvent(content_index=1, partial=partial)),
        )
        host._on_runtime_event(
            runtime,
            update(ToolCallDeltaEvent(content_index=1, delta="x", partial=partial)),
        )
        host._on_runtime_event(
            runtime,
            update(ToolCallDeltaEvent(content_index=1, delta="y", partial=partial)),
        )
        host._on_runtime_event(
            runtime,
            update(
                ToolCallEndEvent(
                    content_index=1,
                    tool_call=final_call,
                    partial=AssistantMessage(content=[final_call]),
                )
            ),
        )
        flushed = [envelope["frame"] for envelope in host.frames]
        self.assertEqual(
            "".join(item["assistant_message_event"].get("delta", "") for item in flushed),
            "xy",
        )
        self.assertEqual(
            [item["assistant_message_event"]["type"] for item in flushed],
            ["toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end"],
        )
        self.assertNotIn((id(runtime), 1), host._toolcall_delta_pending)

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
        self.assertEqual(result, {"queued": "steer", "promoted": 0, "interrupted": False})
        self.assertEqual(runtime.agent_session.steers, ["顺便看一眼"])

    async def test_steer_can_promote_all_pending_follow_ups(self) -> None:
        runtime = _StubRuntime()
        runtime.agent_session.follow_ups = ["排队一", "排队二"]
        host = _bare_host(runtime)
        host._agent_running = True

        result = await host._cmd_steer({
            "message": "现在插话",
            "promoteFollowUps": True,
            "interrupt": True,
        })
        await asyncio.gather(*list(host._tasks))

        self.assertEqual(result, {"queued": "steer", "promoted": 2, "interrupted": True})
        self.assertEqual(runtime.agent_session.follow_ups, [])
        self.assertEqual(runtime.agent_session.steers, ["排队一", "排队二", "现在插话"])
        self.assertTrue(runtime.aborted)
        self.assertEqual(runtime.continued, 1)

    async def test_steer_resume_is_skipped_when_old_loop_already_consumed_it(self) -> None:
        runtime = _StubRuntime()
        host = _bare_host(runtime)
        host._agent_running = True

        # Reproduce the narrow race after _cmd_steer: the previous loop drained
        # the queue and produced the inserted answer before the resume task got
        # scheduled.  There is nothing left for continue_() to do.
        runtime.agent_session.steers.clear()
        await host._resume_after_steer(runtime)

        self.assertEqual(runtime.continued, 0)
        self.assertFalse(host._agent_running)

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


class NativeImagePromptTests(unittest.TestCase):
    def test_images_become_native_content_blocks(self) -> None:
        encoded = "aGVsbG8="
        message, text = prompt_message("inspect this", {
            "attachments": [{
                "name": "shot.png", "mimeType": "image/png", "data": encoded, "size": 5,
            }],
        })
        self.assertIsInstance(message, UserMessage)
        self.assertEqual(text, "inspect this")
        self.assertTrue(any(isinstance(block, ImageContent) for block in message.content))

    def test_image_only_prompt_is_allowed_and_bad_base64_is_rejected(self) -> None:
        message, text = prompt_message("", {
            "attachments": [{"mimeType": "image/jpeg", "data": "aGVsbG8="}],
        })
        self.assertIsInstance(message, UserMessage)
        self.assertEqual(text, "")
        with self.assertRaises(HostError):
            prompt_message("", {"attachments": [{"mimeType": "image/png", "data": "%%%"}]})


class PlanAnswerTests(unittest.IsolatedAsyncioTestCase):
    async def test_accept_is_persisted_leaves_manual_plan_and_queues_implementation(self) -> None:
        runtime = _StubRuntime()
        runtime.interaction_mode = "plan"
        runtime.effective_interaction_mode = "plan"
        runtime.session = SessionManager()
        runtime.session.append_message(ToolResultMessage(
            toolCallId="plan-1",
            toolName="submit_plan",
            content=[TextContent(text="Plan")],
            details={"kind": "plan", "plan": {"summary": "S", "steps": ["A"]}},
        ))
        host = _bare_host(runtime)
        prompts = []
        effective_modes = []

        async def queue_prompt(params, *, effective_mode=None):
            prompts.append(params)
            effective_modes.append(effective_mode)
            return {"queued": "prompt"}

        host._cmd_prompt = queue_prompt
        result = await host._cmd_plan_answer({"id": "plan-1", "decision": "accept"})

        self.assertEqual(result["decision"], "accepted")
        self.assertEqual(runtime.interaction_mode, "default")
        self.assertEqual(len(prompts), 1)
        self.assertEqual(effective_modes, ["default"])
        decisions = [entry for entry in runtime.session.get_entries() if entry.type == "plan_decision"]
        self.assertEqual(decisions[0].data["decision"], "accepted")
        self.assertEqual(host.frames[-1]["frame"]["type"], "plan_decision")


class DynamicToolPermissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_executing_context_for_extension_tool_permission(self) -> None:
        host = _bare_host(_StubRuntime())
        host._tools = {}  # noqa: SLF001 - reproduces the stale startup snapshot
        host._policy = PermissionPolicy("workspace-modify", cwd=Path("C:/work"))  # noqa: SLF001

        class _UnexpectedBroker:
            async def ask(self, **_kwargs):
                raise AssertionError("read-only extension tool must not request approval")

        host._broker = _UnexpectedBroker()  # noqa: SLF001
        agent_tool = types.SimpleNamespace(
            name="agent",
            required_permission="read-only",
            permission_paths=None,
        )
        call = types.SimpleNamespace(id="call-agent", name="agent")
        data = {
            "tool_call": call,
            "args": {"description": "delegate", "prompt": "work"},
            "context": types.SimpleNamespace(tools=[agent_tool]),
        }

        self.assertIsNone(await host._before_tool_call(data))
        self.assertIs(host._tools["agent"], agent_tool)  # noqa: SLF001


class RunPromptTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_returning_prompt_clears_busy(self) -> None:
        # 正常收尾时 `agent_end` 已经翻过标志，但没有结束帧的一轮也必须解锁。
        class _Ok:
            async def prompt(self, message: str) -> None:
                return None

        host = _bare_host(_Ok())
        host._agent_running = True
        await host._run_operation(host._runtime, lambda: host._runtime.prompt("你好"), name="prompt")
        self.assertFalse(host._agent_running)
        self.assertEqual(host.frames, [])

    async def test_a_failing_prompt_becomes_an_error_frame_and_clears_busy(self) -> None:
        class _Broken:
            async def prompt(self, message: str) -> None:
                raise RuntimeError("provider exploded")

        host = _bare_host(_Broken())
        host._agent_running = True
        await host._run_operation(host._runtime, lambda: host._runtime.prompt("你好"), name="prompt")

        self.assertFalse(host._agent_running)
        kinds = [payload["frame"]["type"] for payload in host.frames]
        self.assertEqual(kinds, ["error"])
        self.assertIn("provider exploded", host.frames[0]["frame"]["error"])

    async def test_cancelled_skill_drains_task_and_clears_busy(self) -> None:
        runtime = _StubRuntime()
        runtime.agent_session.skills = [types.SimpleNamespace(name="review")]
        started, released = asyncio.Event(), asyncio.Event()
        async def invoke_skill(name, instructions):
            self.assertEqual((name, instructions), ("review", "inspect changes"))
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                released.set()
        runtime.invoke_skill = invoke_skill
        host = _bare_host(runtime)
        self.assertEqual(await host.handle("invoke_skill", {
            "name": "review", "instructions": "inspect changes",
        }), {"queued": "skill", "name": "review"})
        await asyncio.wait_for(started.wait(), 1)
        self.assertTrue(host._agent_running)
        task = host._runtime_tasks[id(runtime)]
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(released.is_set())
        self.assertFalse(host._agent_running)
        self.assertEqual(host._runtime_tasks, {})
        self.assertEqual(host._tasks, set())
        self.assertEqual(host._running_runtimes, set())

    async def test_prompt_cancelled_before_start_does_not_leave_host_busy(self) -> None:
        runtime = _StubRuntime()
        async def prompt(message):
            self.fail("cancelled task must not start the model request")
        runtime.prompt = prompt
        host = _bare_host(runtime)
        result = await host.handle("prompt", {"message": "hello"})
        self.assertEqual(result["queued"], "prompt")
        task = host._runtime_tasks[id(runtime)]
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(host._agent_running)
        self.assertEqual(host._runtime_tasks, {})
        self.assertEqual(host._running_runtimes, set())
        self.assertEqual(host._tasks, set())
        self.assertEqual(host.frames, [])

    async def test_background_failure_keeps_active_session_running(self) -> None:
        active, background = _StubRuntime(), _StubRuntime()
        host = _bare_host(active)
        host._agent_running = True
        host._running_runtimes.update((id(active), id(background)))
        async def fail():
            raise RuntimeError("background error")
        await host._run_operation(background, fail, name="prompt")
        self.assertTrue(host._agent_running)
        self.assertEqual(host._running_runtimes, {id(active)})
        self.assertEqual(host.frames, [])


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
        self.assertEqual(info["interactionMode"], "auto")
        self.assertEqual(info["effectiveInteractionMode"], "default")
        self.assertIsInstance(info["lastFrameAt"], int)
        self.assertGreater(info["lastFrameAt"], 0)

    async def test_manual_interaction_mode_is_reported(self) -> None:
        host = self._info_host()
        result = await host._cmd_interaction_set({"mode": "plan"})
        self.assertEqual(result, {
            "interactionMode": "plan",
            "effectiveInteractionMode": "plan",
        })
        info = await host._cmd_host_info({})
        self.assertEqual(info["interactionMode"], "plan")
        self.assertEqual(info["effectiveInteractionMode"], "plan")

    async def test_execution_mode_can_be_selected_and_reported(self) -> None:
        host = self._info_host()
        result = await host._cmd_execution_set({"mode": "sandbox"})
        self.assertEqual(result["executionMode"], "sandbox")
        info = await host._cmd_host_info({})
        self.assertEqual(info["executionMode"], "sandbox")
        self.assertIn("backend", info["sandbox"])

    async def test_reports_busy_while_a_run_is_in_flight(self) -> None:
        host = self._info_host()
        host._agent_running = True
        info = await host._cmd_host_info({})
        self.assertIs(info["busy"], True)
