"""有状态 Agent 封装。

对应上游 ``packages/agent/src/agent.ts``。维护 transcript、消息队列、生命周期，
内部委托给 ``agent_loop`` / ``agent_loop_continue``。

关键机制：
- 每次 prompt/continue 给 loop 一个 context 快照（messages/tools 都 copy）。
- steering（工作中注入）vs follow-up（完成后追加）两个队列，QueueMode 控制。
- 事件经 process_events 归约到 _state，并串行广播给订阅者。
- prompt 期间不能再次 prompt（用 steer/follow_up 排队）。
"""

from __future__ import annotations

import asyncio
import inspect
import time
from dataclasses import replace
from typing import Any

from fox_ai.src import (
    AssistantMessage,
    ToolResultMessage,
    TextContent,
    UserMessage,
    stream_simple,
)

from .agent_loop import _run_agent_loop, _run_agent_loop_continue
from .types import (
    AgentContext,
    AgentEndEvent,
    AgentEvent,
    AgentLoopConfig,
    AgentMessage,
    AgentState,
    MessageEndEvent,
    MessageStartEvent,
    MessageUpdateEvent,
    QueueMode,
    StreamFn,
    ToolExecutionEndEvent,
    ToolExecutionMode,
    ToolExecutionStartEvent,
    TurnEndEvent,
)


class _PendingMessageQueue:
    """消息队列（all 或 one-at-a-time 模式）。"""

    def __init__(self, mode: QueueMode = "one-at-a-time") -> None:
        self.mode = mode
        self._messages: list[AgentMessage] = []

    def enqueue(self, message: AgentMessage) -> None:
        self._messages.append(message)

    def has_items(self) -> bool:
        return len(self._messages) > 0

    def drain(self) -> list[AgentMessage]:
        if self.mode == "all":
            drained = list(self._messages)
            self._messages.clear()
            return drained
        if not self._messages:
            return []
        first = self._messages[0]
        self._messages = self._messages[1:]
        return [first]

    def drain_all(self) -> list[AgentMessage]:
        """取走全部消息，不受逐条消费模式影响。"""

        drained = list(self._messages)
        self._messages.clear()
        return drained

    def clear(self) -> None:
        self._messages.clear()


class AgentOptions:
    """Agent 配置。对应上游 ``AgentOptions``。

    所有字段可选；initial_state 含 system_prompt/model/tools 等。
    """

    def __init__(
        self,
        initial_state: dict[str, Any] | AgentState | None = None,
        *,
        convert_to_llm: Any = None,
        transform_context: Any = None,
        stream_fn: StreamFn | None = None,
        get_api_key: Any = None,
        before_tool_call: Any = None,
        after_tool_call: Any = None,
        prepare_next_turn: Any = None,
        prepare_request: Any = None,
        should_stop_after_turn: Any = None,
        steering_mode: QueueMode = "one-at-a-time",
        follow_up_mode: QueueMode = "one-at-a-time",
        tool_execution: ToolExecutionMode = "parallel",
        max_turns: int | None = 100,
        stream_options: dict[str, Any] | None = None,
        **extra: Any,
    ) -> None:
        # 初始状态
        if isinstance(initial_state, AgentState):
            self.initial_state = replace(initial_state)
        else:
            self.initial_state = AgentState()
            if initial_state:
                for k, v in initial_state.items():
                    if k not in AgentState.__dataclass_fields__:
                        raise TypeError(f"Unknown AgentState field: {k}")
                    setattr(self.initial_state, k, v)

        self.initial_state.messages = list(self.initial_state.messages)
        self.initial_state.tools = list(self.initial_state.tools)
        self.initial_state.pending_tool_calls = set()
        self.initial_state.is_streaming = False
        self.initial_state.streaming_message = None
        if max_turns is not None and max_turns < 1:
            raise ValueError("max_turns must be positive or None")
        if tool_execution not in ("parallel", "sequential"):
            raise ValueError("Invalid tool_execution mode")
        if steering_mode not in ("all", "one-at-a-time") or follow_up_mode not in ("all", "one-at-a-time"):
            raise ValueError("Invalid queue mode")

        self.convert_to_llm = convert_to_llm
        self.transform_context = transform_context
        self.stream_fn = stream_fn or stream_simple
        self.get_api_key = get_api_key
        self.before_tool_call = before_tool_call
        self.after_tool_call = after_tool_call
        self.prepare_next_turn = prepare_next_turn
        self.prepare_request = prepare_request
        self.max_turns = max_turns
        self.should_stop_after_turn = should_stop_after_turn
        self.steering_mode = steering_mode
        self.follow_up_mode = follow_up_mode
        self.tool_execution = tool_execution
        self.extra = {**(stream_options or {}), **extra}
        reasoning = self.extra.pop("reasoning", None)
        if self.initial_state.thinking_level is None and reasoning is not None:
            self.initial_state.thinking_level = None if reasoning == "off" else reasoning


class Agent:
    """有状态 Agent。"""

    def __init__(self, options: AgentOptions | None = None) -> None:
        opts = options or AgentOptions()
        self._state = replace(opts.initial_state, messages=list(opts.initial_state.messages),
                              tools=list(opts.initial_state.tools), pending_tool_calls=set())
        self._convert_to_llm = opts.convert_to_llm
        self._transform_context = opts.transform_context
        self._stream_fn = opts.stream_fn
        self._get_api_key = opts.get_api_key
        self._before_tool_call = opts.before_tool_call
        self._after_tool_call = opts.after_tool_call
        self._prepare_next_turn = opts.prepare_next_turn
        self._prepare_request = opts.prepare_request
        self._max_turns = opts.max_turns
        self._stream_options = dict(opts.extra)
        self._should_stop_after_turn = opts.should_stop_after_turn
        self._tool_execution = opts.tool_execution

        self.steering_queue = _PendingMessageQueue(opts.steering_mode)
        self.follow_up_queue = _PendingMessageQueue(opts.follow_up_mode)
        self._drain_all_steering_once = False

        self._listeners: list[Any] = []  # Callable[[AgentEvent, asyncio.Event|None], Any]
        self._active_run: dict[str, Any] | None = None

    # ---- 状态 ----

    @property
    def state(self) -> AgentState:
        return self._state

    # ---- 订阅 ----

    def subscribe(self, listener: Any) -> Any:
        """订阅事件。返回取消订阅函数。"""
        self._listeners.append(listener)

        def _unsubscribe() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return _unsubscribe

    # ---- 队列 ----

    def steer(self, message: AgentMessage | str) -> None:
        """入 steering 队列（工作中注入）。"""
        for item in self._normalize_input(message):
            self.steering_queue.enqueue(item)

    def follow_up(self, message: AgentMessage | str) -> None:
        """入 follow-up 队列（完成后追加）。"""
        for item in self._normalize_input(message):
            self.follow_up_queue.enqueue(item)

    def promote_follow_ups(self) -> int:
        """把尚未执行的 follow-up 全部提升为 steering。

        桌面端默认把运行中的普通发送排到任务末尾；用户显式“插话”时，需要把
        此前所有排队消息一起交给下一次模型请求，而不是在两个队列里留下旧消息。
        """

        pending = self.follow_up_queue.drain_all()
        for item in pending:
            self.steering_queue.enqueue(item)
        # 显式插话的含义是“发送全部排队消息”，即使此刻 follow-up 为空，紧接着
        # 入队的当前插话也应与已有 steering 在同一次模型请求中消费。
        self._drain_all_steering_once = True
        return len(pending)

    def _drain_steering(self) -> list[AgentMessage]:
        if self._drain_all_steering_once:
            self._drain_all_steering_once = False
            return self.steering_queue.drain_all()
        return self.steering_queue.drain()

    def clear_steering_queue(self) -> None:
        self.steering_queue.clear()
        self._drain_all_steering_once = False

    def clear_follow_up_queue(self) -> None:
        self.follow_up_queue.clear()

    def clear_all_queues(self) -> None:
        self.steering_queue.clear()
        self.follow_up_queue.clear()

    def has_queued_messages(self) -> bool:
        return self.steering_queue.has_items() or self.follow_up_queue.has_items()

    # ---- 生命周期 ----

    @property
    def is_running(self) -> bool:
        return self._active_run is not None

    @property
    def cancel_event(self) -> asyncio.Event | None:
        return self._active_run["cancel_event"] if self._active_run else None

    def abort(self) -> None:
        if self._active_run and self._active_run["cancel_event"]:
            self._active_run["cancel_event"].set()

    async def wait_for_idle(self) -> None:
        if self._active_run:
            await asyncio.shield(self._active_run["promise"])

    def reset(self) -> None:
        # 对齐 v0.84.1：运行中拒绝 reset，避免与活跃循环竞争状态
        if self._active_run:
            raise RuntimeError("Agent is already processing. Wait for completion before resetting.")
        self._state.messages = []
        self._state.is_streaming = False
        self._state.streaming_message = None
        self._state.error_message = None
        self._state.pending_tool_calls = set()
        self.clear_all_queues()

    # ---- prompt / continue ----

    async def prompt(self, message: AgentMessage | list[AgentMessage] | str) -> None:
        """发送用户输入，启动循环。运行中调用会报错（用 steer/follow_up 排队）。"""
        if self._active_run:
            raise RuntimeError(
                "Agent is already processing. Use steer() or follow_up() to queue messages."
            )
        messages = self._normalize_input(message)
        await self._run_prompt_messages(messages)

    async def continue_(self) -> None:
        """从已有 context 继续。末尾须是 user/toolResult，或有排队消息。"""
        if self._active_run:
            raise RuntimeError("Agent is already processing.")
        last = self._state.messages[-1] if self._state.messages else None
        if not last:
            raise RuntimeError("No messages to continue from")
        if isinstance(last, AssistantMessage):
            # 末尾是 assistant：尝试消费排队消息作为 prompt
            queued = self._drain_steering()
            if queued:
                await self._run_prompt_messages(queued, skip_initial_steering=True)
                return
            queued = self.follow_up_queue.drain()
            if queued:
                await self._run_prompt_messages(queued)
                return
            raise RuntimeError("Cannot continue from message role: assistant")
        await self._run_continuation()

    # ---- 内部 ----

    def _normalize_input(self, message: Any) -> list[AgentMessage]:
        if isinstance(message, str):
            return [
                UserMessage(
                    content=[TextContent(text=message)],
                    timestamp=int(time.time() * 1000),
                )
            ]
        messages = list(message) if isinstance(message, list) else [message]
        if not messages or not all(isinstance(m, (UserMessage, AssistantMessage, ToolResultMessage)) for m in messages):
            raise TypeError("Expected a string, a Message, or a non-empty list of Messages")
        return messages

    def _create_context_snapshot(self) -> AgentContext:
        return AgentContext(
            system_prompt=self._state.system_prompt,
            messages=list(self._state.messages),
            tools=list(self._state.tools) if self._state.tools else None,
        )

    def _create_loop_config(self, skip_initial_steering: bool = False) -> AgentLoopConfig:
        cfg = AgentLoopConfig(
            model=self._state.model,
            tool_execution=self._tool_execution,
            convert_to_llm=self._convert_to_llm,
            transform_context=self._transform_context,
            get_api_key=self._get_api_key,
            before_tool_call=self._before_tool_call,
            after_tool_call=self._after_tool_call,
            prepare_next_turn=self._wrap_prepare(self._prepare_next_turn),
            prepare_request=self._wrap_prepare(self._prepare_request),
            max_turns=self._max_turns,
            stream_options=dict(self._stream_options),
        )
        # should_stop_after_turn：把 Agent 级回调包成 loop 级钩子
        if self._should_stop_after_turn:
            hook = self._should_stop_after_turn

            async def _should_stop_after_turn(ctx: dict[str, Any]) -> bool:
                result = hook(ctx)
                if inspect.isawaitable(result):
                    result = await result
                return bool(result)

            cfg.should_stop_after_turn = _should_stop_after_turn
        cfg.reasoning = self._state.thinking_level or None
        # 用闭包接 steering/follow-up 队列
        _skip = [skip_initial_steering]

        async def _get_steering() -> list[AgentMessage]:
            if _skip[0]:
                _skip[0] = False
                return []
            return self._drain_steering()

        async def _get_follow_up() -> list[AgentMessage]:
            return self.follow_up_queue.drain()

        cfg.get_steering_messages = _get_steering
        cfg.get_follow_up_messages = _get_follow_up
        return cfg

    def _wrap_prepare(self, hook: Any) -> Any:
        if hook is None:
            return None

        async def prepare(request: dict[str, Any]) -> Any:
            result = hook(request)
            if inspect.isawaitable(result):
                result = await result
            if result:
                context = result.get("context")
                if context is not None:
                    self._state.messages = list(context.messages)
                    self._state.system_prompt = context.system_prompt
                    self._state.tools = list(context.tools or [])
                if result.get("model") is not None:
                    self._state.model = result["model"]
                if "thinkingLevel" in result:
                    level = result["thinkingLevel"]
                    self._state.thinking_level = None if level == "off" else level
            return result

        return prepare

    async def _run_prompt_messages(
        self, messages: list[AgentMessage], skip_initial_steering: bool = False
    ) -> None:
        await self._run_with_lifetime(
            lambda cancel_event: _run_agent_loop(
                messages,
                self._create_context_snapshot(),
                self._create_loop_config(skip_initial_steering),
                self._process_events,
                cancel_event,
                self._stream_fn,
            )
        )

    async def _run_continuation(self) -> None:
        await self._run_with_lifetime(
            lambda cancel_event: _run_agent_loop_continue(
                self._create_context_snapshot(),
                self._create_loop_config(),
                self._process_events,
                cancel_event,
                self._stream_fn,
            )
        )

    async def _run_with_lifetime(self, executor: Any) -> None:
        if self._active_run:
            raise RuntimeError("Agent is already processing.")
        cancel_event = asyncio.Event()
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._active_run = {"promise": future, "cancel_event": cancel_event}
        self._state.is_streaming = True
        self._state.streaming_message = None
        self._state.error_message = None
        task = asyncio.create_task(executor(cancel_event))
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            # 调用者取消 prompt task 时也先完成工具/网络清理，再传播取消。
            cancel_event.set()
            await asyncio.shield(task)
            raise
        except Exception as exc:
            # 模型/工具错误在 loop 中转成消息；存储或订阅者错误应向宿主暴露。
            self._state.error_message = str(exc)
            raise
        finally:
            self._state.is_streaming = False
            self._state.streaming_message = None
            self._state.pending_tool_calls.clear()
            self._active_run = None
            if not future.done():
                future.set_result(None)

    async def _process_events(self, event: AgentEvent) -> None:
        """状态归约 + 串行广播。"""
        if isinstance(event, (MessageStartEvent, MessageUpdateEvent)):
            self._state.streaming_message = event.message
        elif isinstance(event, MessageEndEvent):
            self._state.streaming_message = None
            self._state.messages.append(event.message)
        elif isinstance(event, ToolExecutionStartEvent):
            self._state.pending_tool_calls = self._state.pending_tool_calls | {event.tool_call_id}
        elif isinstance(event, ToolExecutionEndEvent):
            self._state.pending_tool_calls = self._state.pending_tool_calls - {event.tool_call_id}
        elif isinstance(event, TurnEndEvent):
            if isinstance(event.message, AssistantMessage) and event.message.error_message:
                self._state.error_message = event.message.error_message
        elif isinstance(event, AgentEndEvent):
            self._state.streaming_message = None

        # 串行广播
        for listener in list(self._listeners):
            result = listener(event, self.cancel_event)
            if inspect.isawaitable(result):
                await result


__all__ = ["Agent", "AgentOptions"]
