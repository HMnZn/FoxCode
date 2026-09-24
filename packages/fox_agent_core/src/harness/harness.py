"""精简宿主：把 Agent、Session、Compaction、Skills 和 Tools 接起来。

一个 Harness 同时只运行一个操作。它不负责终端 UI、扩展市场或多进程调度。
恢复会话不会重放工具副作用：中断时缺失的工具结果会标记为未知/失败。
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal

from fox_ai.src import AssistantMessage, Model, TextContent, ToolCall, ToolResultMessage
from .._async import check_cancelled, maybe_await
from ..agent import Agent, AgentOptions
from ..types import AgentContext, AgentMessage, AgentState, MessageEndEvent, StreamFn
from .compaction import CompactionResult, CompactionSettings, compact, estimate_context_tokens, estimate_tokens, should_compact
from .session import Session
from .skills import LoadSkillsOptions, Skill, format_skill_invocation, format_skills_for_prompt, load_skills
from .tool import create_coding_tools


@dataclass
class CompactionEvent:
    type: Literal["compaction_start", "compaction_end", "compaction_error"]
    automatic: bool = False
    result: CompactionResult | None = None
    error: str | None = None


@dataclass
class AgentHarnessOptions:
    model: Model | None = None  # 恢复已有 session 时可使用已保存的模型。
    session: Session | None = None
    cwd: str | Path = "."
    system_prompt: str = "You are a coding assistant. Inspect relevant files before editing."
    tools: list[Any] | None = None  # None 使用四个内置工具；[] 表示禁用工具。
    skills: list[Skill] | None = None  # None 自动发现；[] 表示禁用技能。
    skill_options: LoadSkillsOptions | None = None
    compaction: CompactionSettings = field(default_factory=CompactionSettings)
    stream_fn: StreamFn | None = None
    summary_fn: Any = None  # async (model, messages, **options) -> str，便于测试或定制。
    stream_options: dict[str, Any] = field(default_factory=dict)
    thinking_level: Any = None
    max_turns: int | None = 100
    tool_execution: Literal["parallel", "sequential"] = "parallel"
    steering_mode: Literal["all", "one-at-a-time"] = "one-at-a-time"
    follow_up_mode: Literal["all", "one-at-a-time"] = "one-at-a-time"
    get_api_key: Any = None
    before_tool_call: Any = None
    after_tool_call: Any = None


class AgentHarness:
    def __init__(self, options: AgentHarnessOptions) -> None:
        self.options = options
        self.cwd = Path(options.cwd).expanduser().resolve()
        self.session = options.session if options.session is not None else Session()
        self._busy = False
        self._manual_cancel: asyncio.Event | None = None
        self._idle: asyncio.Future | None = None
        self._listeners: list[Any] = []
        tools = list(options.tools) if options.tools is not None else create_coding_tools(self.cwd)
        self._tools = {tool.name: tool for tool in tools}
        if len(self._tools) != len(tools):
            raise ValueError("Tool names must be unique")
        self._default_tool_names = list(self._tools)
        loaded = load_skills(options.skill_options or LoadSkillsOptions(cwd=str(self.cwd))) if options.skills is None else None
        self.skills = list(loaded.skills if loaded else options.skills or [])
        self.skill_diagnostics = loaded.diagnostics if loaded else []
        saved = self.session.build_settings()
        model = options.model or (Model.model_validate(saved["model"]) if saved.get("model") else None)
        if model is None:
            raise ValueError("A model is required for a new session")
        self._default_model = model
        if "model" not in saved or Model.model_validate(saved["model"]) != model:
            self.session.append_model_change(model.model_dump(mode="json", by_alias=True))
        level = saved.get("thinking_level", options.thinking_level)
        active_names = saved.get("active_tools", self._default_tool_names)
        self._validate_tool_names(active_names)
        if "thinking_level" not in saved:
            self.session.append_thinking_level_change(level)
        if "active_tools" not in saved:
            self.session.append_active_tools_change(active_names)
        system = "\n\n".join(part for part in (
            options.system_prompt, f"Working directory: {self.cwd}", format_skills_for_prompt(self.skills)
        ) if part)
        stream_options = dict(options.stream_options)
        stream_options.setdefault("session_id", self.session.storage.get_metadata().get("id"))
        self.agent = Agent(AgentOptions(
            initial_state={"model": model, "system_prompt": system, "messages": self.session.build_context(),
                           "tools": [self._tools[n] for n in active_names], "thinking_level": level},
            stream_fn=options.stream_fn, stream_options=stream_options,
            get_api_key=options.get_api_key, before_tool_call=options.before_tool_call,
            after_tool_call=options.after_tool_call, prepare_request=self._prepare_request,
            max_turns=options.max_turns, tool_execution=options.tool_execution,
            steering_mode=options.steering_mode, follow_up_mode=options.follow_up_mode,
        ))
        self._recover_interrupted_tools()
        self.agent.subscribe(self._on_agent_event)

    @property
    def state(self) -> AgentState:
        return self.agent.state

    @property
    def is_running(self) -> bool:
        return self._busy

    def subscribe(self, listener):
        """listener(event, cancel_event)，支持同步或异步；返回取消订阅函数。"""
        self._listeners.append(listener)

        def unsubscribe():
            if listener in self._listeners:
                self._listeners.remove(listener)

        return unsubscribe

    async def _emit(self, event):
        for listener in list(self._listeners):
            await maybe_await(listener(event, self.agent.cancel_event or self._manual_cancel))

    async def _on_agent_event(self, event, cancel_event):
        if isinstance(event, MessageEndEvent):
            self.session.append_message(event.message)
        await self._emit(event)

    def _ensure_idle(self):
        if self._busy or self.agent.is_running:
            raise RuntimeError("Harness is already processing. Use steer() or follow_up() to queue messages.")

    async def _run(self, action):
        self._ensure_idle()
        self._busy = True
        self._idle = asyncio.get_running_loop().create_future()
        try:
            self._recover_interrupted_tools()
            return await action()
        finally:
            # Session 是持久历史来源；存储失败也不能使 Agent 保留未保存的消息。
            try:
                self.state.messages = self.session.build_context()
            finally:
                self._busy = False
                self._manual_cancel = None
                self._idle.set_result(None)

    async def prompt(self, message: str | AgentMessage | list[AgentMessage]) -> None:
        await self._run(lambda: self.agent.prompt(message))

    async def continue_(self) -> None:
        await self._run(self.agent.continue_)

    def steer(self, message: str | AgentMessage) -> None:
        self.agent.steer(message)

    def follow_up(self, message: str | AgentMessage) -> None:
        self.agent.follow_up(message)

    def abort(self) -> None:
        self.agent.abort()
        if self._manual_cancel is not None:
            self._manual_cancel.set()

    async def wait_for_idle(self) -> None:
        if self._idle is not None:
            await asyncio.shield(self._idle)

    async def invoke_skill(self, name: str, instructions: str = "") -> None:
        skill = next((s for s in self.skills if s.name == name), None)
        if skill is None:
            raise ValueError(f"Unknown skill: {name}")
        await self.prompt(format_skill_invocation(skill, instructions))

    async def _prepare_request(self, request):
        context = request["context"]
        # 估算包含 system prompt 和工具声明；保留启发式计数，避免引入 tokenizer。
        from fox_ai.src import UserMessage
        overhead = estimate_tokens(UserMessage(content=context.system_prompt))
        overhead += estimate_tokens(UserMessage(content=json.dumps([
            {"name": t.name, "description": t.description, "parameters": t.parameters}
            for t in context.tools or []], ensure_ascii=False)))
        count = estimate_context_tokens(context.messages) + overhead
        if should_compact(count, request["model"].context_window, self.options.compaction):
            result = await self._compact_context(context, request["model"], request["cancel_event"], automatic=True)
            if result.removed_count:
                context.messages = self.session.build_context()
            # 无法再切割（例如单个超长用户输入）时，明确结束，保留原始输入。
            remaining = estimate_context_tokens(context.messages) + overhead
            output_budget = self.options.stream_options.get("max_tokens") or request["model"].max_tokens
            if remaining + output_budget >= request["model"].context_window:
                raise RuntimeError("Context still exceeds the model budget after compaction; reduce the input or tool output")
        return {"context": context}

    async def _compact_context(self, context, model, cancel_event, *, automatic):
        await self._emit(CompactionEvent("compaction_start", automatic))
        try:
            summary_options = dict(self.options.stream_options)
            # 普通回复的输出预算与摘要预算独立。
            summary_options["max_tokens"] = min(2000, model.max_tokens or 2000)
            if self.options.get_api_key:
                key = await maybe_await(self.options.get_api_key(model.provider))
                if key:
                    summary_options["api_key"] = key
            result = await compact(model, list(context.messages), self.options.compaction,
                                   **{**summary_options, "stream_fn": self.options.stream_fn,
                                      "summary_fn": self.options.summary_fn, "cancel_event": cancel_event})
            check_cancelled(cancel_event)
            if result.removed_count:
                self.session.append_compaction(result.summary, result.retained_tail)
                self.state.messages = self.session.build_context()
        except Exception as exc:
            await self._emit(CompactionEvent("compaction_error", automatic, error=str(exc)))
            raise
        await self._emit(CompactionEvent("compaction_end", automatic, result=result))
        return result

    async def compact(self) -> CompactionResult:
        """手动压缩仅允许在空闲时执行，忽略 enabled 开关。"""
        async def action():
            self._manual_cancel = asyncio.Event()
            return await self._compact_context(
                AgentContext(self.state.system_prompt, list(self.state.messages), self.state.tools),
                self.state.model, self._manual_cancel, automatic=False)

        return await self._run(action)

    def set_model(self, model: Model) -> None:
        self._ensure_idle()
        self.session.append_model_change(model.model_dump(mode="json", by_alias=True))
        self.state.model = model

    def set_thinking_level(self, level) -> None:
        self._ensure_idle()
        if level not in (None, "off", "minimal", "low", "medium", "high", "xhigh"):
            raise ValueError(f"Invalid thinking level: {level}")
        level = None if level == "off" else level
        self.session.append_thinking_level_change(level)
        self.state.thinking_level = level

    def _validate_tool_names(self, names):
        missing = set(names) - self._tools.keys()
        if missing:
            raise ValueError(f"Tools required by the session are unavailable: {sorted(missing)}")
        if len(names) != len(set(names)):
            raise ValueError("Tool names must be unique")

    def set_active_tools(self, names: list[str]) -> None:
        self._ensure_idle()
        self._validate_tool_names(names)
        self.session.append_active_tools_change(names)
        self.state.tools = [self._tools[name] for name in names]

    def move_to(self, entry_id: str | None) -> None:
        self._ensure_idle()
        self.session.move_to(entry_id)
        saved = self.session.build_settings()
        self.state.model = Model.model_validate(saved["model"]) if saved.get("model") else self._default_model
        self.state.thinking_level = saved.get("thinking_level", self.options.thinking_level)
        names = saved.get("active_tools", self._default_tool_names)
        self._validate_tool_names(names)
        self.state.tools = [self._tools[n] for n in names]
        self.state.messages = self.session.build_context()
        self.state.error_message = None
        self.agent.clear_all_queues()
        self._recover_interrupted_tools()

    def fork(self, from_id: str | None = None) -> AgentHarness:
        self._ensure_idle()
        forked = self.session.fork(from_id)
        model = None if forked.build_settings().get("model") else self._default_model
        return AgentHarness(replace(self.options, session=forked, model=model,
                                    tools=list(self._tools.values()), skills=list(self.skills)))

    def _recover_interrupted_tools(self) -> None:
        """只补全尾部缺失的结果，绝不自动重跑可能已产生副作用的工具。"""
        messages = self.state.messages
        index = len(messages) - 1
        while index >= 0 and isinstance(messages[index], ToolResultMessage):
            index -= 1
        if index < 0 or not isinstance(messages[index], AssistantMessage):
            return
        known = {m.tool_call_id for m in messages[index + 1:]}
        for call in messages[index].content:
            if isinstance(call, ToolCall) and call.id not in known:
                result = ToolResultMessage(
                    tool_call_id=call.id, tool_name=call.name, is_error=True,
                    content=[TextContent(text="Execution was interrupted. Outcome is unknown; inspect state before retrying.")],
                    timestamp=int(time.time() * 1000))
                self.session.append_message(result)
                messages.append(result)


__all__ = ["AgentHarness", "AgentHarnessOptions", "CompactionEvent"]
