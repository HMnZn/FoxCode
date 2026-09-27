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
from fox_agent_core.src._async import check_cancelled, maybe_await
from fox_agent_core.src.agent import AgentOptions
from fox_agent_core.src.harness import (
    AgentHarness as CoreAgentHarness,
    AgentHarnessConfig as CoreAgentHarnessConfig,
    CompactionResult,
    CompactionSettings,
    HarnessHooks,
    compact,
    estimate_context_tokens,
    estimate_tokens,
    should_compact,
)
from fox_agent_core.src.types import AgentContext, AgentMessage, StreamFn
from .session_manager import SessionManager
from .skills import LoadSkillsOptions, Skill, format_skill_invocation, format_skills_for_prompt, load_skills
from .tools import create_coding_tools


@dataclass
class CompactionEvent:
    type: Literal["compaction_start", "compaction_end", "compaction_error"]
    automatic: bool = False
    result: CompactionResult | None = None
    error: str | None = None


@dataclass
class RecoveryEvent:
    type: Literal["context_overflow_retry", "model_retry"]
    attempt: int
    error: str


@dataclass
class AgentSessionConfig:
    model: Model | None = None  # 恢复已有 session 时可使用已保存的模型。
    session: SessionManager | None = None
    cwd: str | Path = "."
    system_prompt: str = "You are a coding assistant. Inspect relevant files before editing."
    system_prompt_builder: Any = None
    tools: list[Any] | None = None  # None 使用内置编码工具；[] 表示禁用工具。
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
    transform_context: Any = None
    convert_to_llm: Any = None
    before_tool_call: Any = None
    after_tool_call: Any = None
    model_retry_attempts: int = 1


class AgentSession(CoreAgentHarness):
    def __init__(self, config: AgentSessionConfig) -> None:
        self.session_config = config
        self.cwd = Path(config.cwd).expanduser().resolve()
        self.session = config.session if config.session is not None else SessionManager()
        self._manual_cancel: asyncio.Event | None = None
        tools = list(config.tools) if config.tools is not None else create_coding_tools(self.cwd)
        self._tools = {tool.name: tool for tool in tools}
        self._runtime_tool_names: set[str] = set()
        if len(self._tools) != len(tools):
            raise ValueError("Tool names must be unique")
        self._default_tool_names = list(self._tools)
        loaded = load_skills(config.skill_options or LoadSkillsOptions(cwd=str(self.cwd))) if config.skills is None else None
        self.skills = list(loaded.skills if loaded else config.skills or [])
        self.skill_diagnostics = loaded.diagnostics if loaded else []
        saved = self.session.build_settings()
        model = config.model or (Model.model_validate(saved["model"]) if saved.get("model") else None)
        if model is None:
            raise ValueError("A model is required for a new session")
        self._default_model = model
        if "model" not in saved or Model.model_validate(saved["model"]) != model:
            self.session.append_model_change(model.model_dump(mode="json", by_alias=True))
        level = saved.get("thinking_level", config.thinking_level)
        active_names = saved.get("active_tools", self._default_tool_names)
        self._validate_tool_names(active_names)
        if "thinking_level" not in saved:
            self.session.append_thinking_level_change(level)
        if "active_tools" not in saved:
            self.session.append_active_tools_change(active_names)
        system = "\n\n".join(part for part in (
            config.system_prompt, f"Working directory: {self.cwd}", format_skills_for_prompt(self.skills)
        ) if part)
        if config.system_prompt_builder:
            system = config.system_prompt_builder([self._tools[n] for n in active_names], self.skills, self.cwd)
        stream_options = dict(config.stream_options)
        stream_options.setdefault("session_id", self.session.storage.get_metadata().get("id"))
        agent_options = AgentOptions(
            initial_state={"model": model, "system_prompt": system, "messages": self.session.build_context(),
                           "tools": [self._tools[n] for n in active_names], "thinking_level": level},
            stream_fn=config.stream_fn, stream_options=stream_options,
            get_api_key=config.get_api_key, before_tool_call=config.before_tool_call,
            after_tool_call=config.after_tool_call, prepare_request=self._prepare_request,
            transform_context=config.transform_context, convert_to_llm=config.convert_to_llm,
            max_turns=config.max_turns, tool_execution=config.tool_execution,
            steering_mode=config.steering_mode, follow_up_mode=config.follow_up_mode,
        )
        super().__init__(CoreAgentHarnessConfig(
            agent_options=agent_options,
            hooks=HarnessHooks(
                persist_message=self.session.append_message,
                before_run=self._before_session_run,
                after_run=self._after_session_run,
            ),
        ))
        self._recover_interrupted_tools()

    def _before_session_run(self):
        self._recover_interrupted_tools()

    def _after_session_run(self):
        # SessionManager is the durable source of truth. A persistence failure
        # must not leave the in-memory Agent ahead of it.
        self.state.messages = self.session.build_context()
        self._manual_cancel = None

    async def _emit(self, event):
        for listener in list(self._listeners):
            await maybe_await(listener(event, self.agent.cancel_event or self._manual_cancel))

    async def prompt(self, message: str | AgentMessage | list[AgentMessage]) -> None:
        await self._run_with_recovery(lambda: self.agent.prompt(message))

    async def continue_(self) -> None:
        await self._run_with_recovery(self.agent.continue_)

    @staticmethod
    def _failure_kind(message: AssistantMessage) -> str | None:
        if message.stop_reason != "error" or message.content:
            return None
        error = (message.error_message or "").lower()
        overflow_terms = (
            "context length", "context window", "context limit", "maximum context",
            "too many tokens", "request too large", "context still exceeds",
        )
        if any(term in error for term in overflow_terms):
            return "overflow"
        retry_terms = (
            "timeout", "timed out", "rate limit", "429", "connection",
            "temporar", "overloaded", "502", "503", "504",
        )
        return "retry" if any(term in error for term in retry_terms) else None

    async def _run_with_recovery(self, action) -> None:
        await self.run(action)
        for attempt in range(1, self.session_config.model_retry_attempts + 1):
            entry = self.session.get_entry(self.session.leaf_id) if self.session.leaf_id else None
            message = entry.data if entry is not None and entry.type == "message" else None
            if not isinstance(message, AssistantMessage):
                return
            kind = self._failure_kind(message)
            if kind is None:
                return
            failed_leaf = entry.id
            self.session.move_to(entry.parent_id)
            self.state.messages = self.session.build_context()
            self.state.error_message = None
            if kind == "overflow":
                await self._emit(RecoveryEvent("context_overflow_retry", attempt,
                                               message.error_message or "context overflow"))
                result = await self.compact()
                if not result.removed_count:
                    self.session.move_to(failed_leaf)
                    self.state.messages = self.session.build_context()
                    self.state.error_message = message.error_message
                    return
            else:
                await self._emit(RecoveryEvent("model_retry", attempt,
                                               message.error_message or "model failure"))
            await self.run(self.agent.continue_)

    def abort(self) -> None:
        super().abort()
        if self._manual_cancel is not None:
            self._manual_cancel.set()

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
        if should_compact(count, request["model"].context_window, self.session_config.compaction):
            result = await self._compact_context(context, request["model"], request["cancel_event"], automatic=True)
            if result.removed_count:
                context.messages = self.session.build_context()
            # 无法再切割（例如单个超长用户输入）时，明确结束，保留原始输入。
            remaining = estimate_context_tokens(context.messages) + overhead
            output_budget = self.session_config.stream_options.get("max_tokens") or request["model"].max_tokens
            if remaining + output_budget >= request["model"].context_window:
                raise RuntimeError("Context still exceeds the model budget after compaction; reduce the input or tool output")
        return {"context": context}

    async def _compact_context(self, context, model, cancel_event, *, automatic):
        await self._emit(CompactionEvent("compaction_start", automatic))
        try:
            summary_options = dict(self.session_config.stream_options)
            # 普通回复的输出预算与摘要预算独立。
            summary_options["max_tokens"] = min(2000, model.max_tokens or 2000)
            if self.session_config.get_api_key:
                key = await maybe_await(self.session_config.get_api_key(model.provider))
                if key:
                    summary_options["api_key"] = key
            result = await compact(model, list(context.messages), self.session_config.compaction,
                                   **{**summary_options, "stream_fn": self.session_config.stream_fn,
                                      "summary_fn": self.session_config.summary_fn, "cancel_event": cancel_event})
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

        return await self.run(action)

    def set_model(self, model: Model) -> None:
        self.ensure_idle()
        self.session.append_model_change(model.model_dump(mode="json", by_alias=True))
        self.state.model = model

    def set_thinking_level(self, level) -> None:
        self.ensure_idle()
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

    def get_tool(self, name: str):
        """Return a registered tool, including tools added by a runtime extension."""
        return self._tools.get(name)

    def add_runtime_tools(self, tools: list[Any], *, activate: bool = True) -> None:
        """Add ephemeral tools discovered after session construction.

        Dynamic capabilities such as MCP are not persisted in ``active_tools``:
        they must be rediscovered for every runtime, which prevents a resumed
        session from depending on a server that is no longer configured.
        """
        self.ensure_idle()
        additions = list(tools)
        names = [tool.name for tool in additions]
        if len(names) != len(set(names)):
            raise ValueError("Runtime tool names must be unique")
        collisions = set(names) & self._tools.keys()
        if collisions:
            raise ValueError(f"Runtime tools collide with available tools: {sorted(collisions)}")
        for tool in additions:
            if not callable(getattr(tool, "execute", None)) or not getattr(tool, "name", None):
                raise TypeError("Runtime tools must implement AgentTool")
            self._tools[tool.name] = tool
            self._runtime_tool_names.add(tool.name)
        if activate and additions:
            self.state.tools = [*self.state.tools, *additions]
            self._refresh_system_prompt()

    def set_active_tools(self, names: list[str]) -> None:
        self.ensure_idle()
        self._validate_tool_names(names)
        # Runtime-discovered tools (for example MCP proxies) are deliberately
        # rediscovered instead of becoming a resume-time dependency.
        persisted = [name for name in names if name not in self._runtime_tool_names]
        self.session.append_active_tools_change(persisted)
        self.state.tools = [self._tools[name] for name in names]
        self._refresh_system_prompt()

    def _refresh_system_prompt(self):
        if self.session_config.system_prompt_builder:
            self.state.system_prompt = self.session_config.system_prompt_builder(self.state.tools, self.skills, self.cwd)

    def move_to(self, entry_id: str | None) -> None:
        self.ensure_idle()
        self.session.move_to(entry_id)
        saved = self.session.build_settings()
        self.state.model = Model.model_validate(saved["model"]) if saved.get("model") else self._default_model
        self.state.thinking_level = saved.get("thinking_level", self.session_config.thinking_level)
        names = saved.get("active_tools", self._default_tool_names)
        self._validate_tool_names(names)
        self.state.tools = [self._tools[n] for n in names]
        self._refresh_system_prompt()
        self.state.messages = self.session.build_context()
        self.state.error_message = None
        self.agent.clear_all_queues()
        self._recover_interrupted_tools()

    def fork(self, from_id: str | None = None) -> AgentSession:
        self.ensure_idle()
        forked = self.session.fork(from_id)
        model = None if forked.build_settings().get("model") else self._default_model
        return AgentSession(replace(self.session_config, session=forked, model=model,
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


__all__ = ["AgentSession", "AgentSessionConfig", "CompactionEvent", "RecoveryEvent"]
