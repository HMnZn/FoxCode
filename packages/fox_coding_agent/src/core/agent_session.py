"""精简宿主：把 Agent、Session、Compaction、Skills 和 Tools 接起来。

一个 Harness 同时只运行一个操作。它不负责终端 UI、扩展市场或多进程调度。
恢复会话不会重放工具副作用：中断时缺失的工具结果会标记为未知/失败。
"""

from __future__ import annotations

import asyncio
import inspect
import json
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal

from fox_ai.src import (
    AssistantMessage,
    Model,
    TextContent,
    ToolCall,
    ToolResultMessage,
    UserMessage,
)
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
from fox_agent_core.src.types import (
    AgentContext,
    AgentMessage,
    ContextUsageSnapshot,
    MessageUpdateEvent,
    StreamFn,
)
from .session_manager import SessionManager
from .interaction import (
    INTERACTION_MODES, EffectiveInteractionMode, InteractionMode,
    is_plan_safe_tool, resolve_interaction_mode,
)
from .system_prompt import PLAN_MODE_SECTION
from .plan_tool import SubmitPlanTool
from .sandbox import EXECUTION_MODES, ExecutionMode
from .skills import LoadSkillsOptions, Skill, format_skill_invocation, format_skills_for_prompt, load_skills
from .tools import create_coding_tools


@dataclass
class CompactionEvent:
    type: Literal[
        "compaction_start",
        "compaction_update",
        "compaction_end",
        "compaction_error",
    ]
    automatic: bool = False
    result: CompactionResult | None = None
    error: str | None = None
    pre_tokens: int | None = None
    post_tokens: int | None = None
    summary_tokens: int | None = None


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
    interaction_mode: InteractionMode = "auto"
    execution_mode: ExecutionMode = "local"


class AgentSession(CoreAgentHarness):
    def __init__(self, config: AgentSessionConfig) -> None:
        # A silent SSE connection used to keep the whole harness busy forever.
        # 60s is deliberately an *idle* budget: a healthy long generation can
        # run for hours as long as it keeps producing chunks.
        stream_options = dict(config.stream_options)
        stream_options.setdefault("timeout_ms", 60_000)
        self.session_config = replace(config, stream_options=stream_options)
        self.cwd = Path(config.cwd).expanduser().resolve()
        self.session = config.session if config.session is not None else SessionManager()
        self._manual_cancel: asyncio.Event | None = None
        # Explicit skill invocations belong to the system context for exactly
        # one run.  Keeping the skill body out of the UserMessage prevents it
        # from becoming the conversation title or a giant user bubble.
        self._active_skill_context = ""
        tools = list(config.tools) if config.tools is not None else create_coding_tools(self.cwd)
        self._tools = {tool.name: tool for tool in tools}
        self._runtime_tool_names: set[str] = set()
        if len(self._tools) != len(tools):
            raise ValueError("Tool names must be unique")
        self._default_tool_names = list(self._tools)
        self._plan_tool = SubmitPlanTool()
        if self._plan_tool.name in self._tools:
            raise ValueError(f"Reserved tool name is already registered: {self._plan_tool.name}")
        # This control-plane tool is deliberately not part of selected tools:
        # it appears only in the effective Plan-mode tool set.
        self._tools[self._plan_tool.name] = self._plan_tool
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
        interaction_mode = saved.get("interaction_mode", config.interaction_mode)
        if interaction_mode not in INTERACTION_MODES:
            raise ValueError(f"Invalid interaction mode: {interaction_mode}")
        self._selected_tool_names = list(active_names)
        self._interaction_mode: InteractionMode = interaction_mode
        execution_mode = saved.get("execution_mode", config.execution_mode)
        if execution_mode not in EXECUTION_MODES:
            raise ValueError(f"Invalid execution mode: {execution_mode}")
        self._execution_mode: ExecutionMode = execution_mode
        self._configure_tool_execution_mode()
        self._effective_interaction_mode: EffectiveInteractionMode = (
            "plan" if interaction_mode == "plan" else "default"
        )
        if "thinking_level" not in saved:
            self.session.append_thinking_level_change(level)
        if "active_tools" not in saved:
            self.session.append_active_tools_change(active_names)
        if "interaction_mode" not in saved:
            self.session.append_interaction_mode_change(interaction_mode)
        if "execution_mode" not in saved:
            self.session.append_execution_mode_change(execution_mode)
        effective_tools = self._effective_tools()
        self._base_system_prompt = "\n\n".join(part for part in (
            config.system_prompt, f"Working directory: {self.cwd}", format_skills_for_prompt(self.skills)
        ) if part)
        system = self._base_system_prompt
        if config.system_prompt_builder:
            system = self._build_system_prompt(effective_tools)
        elif self._effective_interaction_mode == "plan":
            system = f"{system}\n\n{PLAN_MODE_SECTION}"
        stream_options.setdefault("session_id", self.session.storage.get_metadata().get("id"))
        agent_options = AgentOptions(
            initial_state={"model": model, "system_prompt": system, "messages": self.session.build_context(),
                           "tools": effective_tools, "thinking_level": level},
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

    async def _on_agent_event(self, event, cancel_event) -> None:
        """Attach backend token accounting before forwarding a stream update.

        The renderer previously counted characters itself.  That made the UI a
        second source of truth and meant non-desktop hosts saw no live usage at
        all.  The AgentSession owns the context and compaction policy, so it is
        the only layer that can produce a consistent snapshot.
        """

        if isinstance(event, MessageUpdateEvent):
            messages = [*self.state.messages, event.message]
            event.context_usage = ContextUsageSnapshot(
                context_tokens=self._estimate_context_tokens(messages),
                output_tokens=estimate_tokens(event.message),
                estimated=True,
            )
        await super()._on_agent_event(event, cancel_event)

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
        prompt_text = self._prompt_text(message)
        if prompt_text is not None:
            self.prepare_interaction_for_prompt(prompt_text)
        await self._run_with_recovery(lambda: self.agent.prompt(message))

    @staticmethod
    def _prompt_text(message: str | AgentMessage | list[AgentMessage]) -> str | None:
        if isinstance(message, str):
            return message
        if isinstance(message, UserMessage):
            if isinstance(message.content, str):
                return message.content
            return "\n".join(
                block.text for block in message.content if isinstance(block, TextContent)
            )
        return None

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
        task = instructions.strip()
        if not task:
            raise ValueError("Invoking a skill requires task instructions")
        self.activate_skill(skill)
        try:
            await self.prompt(task)
        finally:
            self.clear_active_skill()

    def activate_skill(self, skill: Skill) -> None:
        """Inject ``skill`` for the next run without persisting its body as user text."""

        self.ensure_idle()
        self._active_skill_context = format_skill_invocation(skill)
        self._refresh_system_prompt()

    def clear_active_skill(self) -> None:
        self._active_skill_context = ""
        self._refresh_system_prompt()

    async def _prepare_request(self, request):
        context = request["context"]
        count = self._estimate_context_tokens(context.messages, context=context)
        if should_compact(count, request["model"].context_window, self.session_config.compaction):
            result = await self._compact_context(context, request["model"], request["cancel_event"], automatic=True)
            if result.removed_count:
                context.messages = self.session.build_context()
            # 无法再切割（例如单个超长用户输入）时，明确结束，保留原始输入。
            remaining = self._estimate_context_tokens(context.messages, context=context)
            output_budget = self.session_config.stream_options.get("max_tokens") or request["model"].max_tokens
            if remaining + output_budget >= request["model"].context_window:
                raise RuntimeError("Context still exceeds the model budget after compaction; reduce the input or tool output")
        return {"context": context}

    def _estimate_context_tokens(self, messages, *, context=None) -> int:
        """Estimate messages plus the prompt/tool declaration overhead."""

        system_prompt = (
            context.system_prompt if context is not None else self.state.system_prompt
        )
        tools = context.tools if context is not None else self.state.tools
        overhead = estimate_tokens(UserMessage(content=system_prompt))
        overhead += estimate_tokens(
            UserMessage(
                content=json.dumps(
                    [
                        {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                        for tool in tools or []
                    ],
                    ensure_ascii=False,
                )
            )
        )
        return estimate_context_tokens(list(messages)) + overhead

    def context_tokens(self) -> int:
        """Current backend estimate used by hosts before the first model usage."""

        messages = list(self.state.messages)
        if self.state.streaming_message is not None:
            messages.append(self.state.streaming_message)
        return self._estimate_context_tokens(messages)

    async def _compact_context(self, context, model, cancel_event, *, automatic):
        pre_tokens = self._estimate_context_tokens(context.messages, context=context)
        await self._emit(
            CompactionEvent(
                "compaction_start",
                automatic,
                pre_tokens=pre_tokens,
            )
        )
        try:
            summary_options = dict(self.session_config.stream_options)
            # 普通回复的输出预算与摘要预算独立。
            summary_options["max_tokens"] = min(2000, model.max_tokens or 2000)
            if self.session_config.get_api_key:
                key = await maybe_await(self.session_config.get_api_key(model.provider))
                if key:
                    summary_options["api_key"] = key
            async def on_summary_update(message) -> None:
                await self._emit(
                    CompactionEvent(
                        "compaction_update",
                        automatic,
                        pre_tokens=pre_tokens,
                        summary_tokens=estimate_tokens(message),
                    )
                )

            result = await compact(
                model,
                list(context.messages),
                self.session_config.compaction,
                **{
                    **summary_options,
                    "stream_fn": self.session_config.stream_fn,
                    "summary_fn": self.session_config.summary_fn,
                    "cancel_event": cancel_event,
                    "on_update": on_summary_update,
                },
            )
            check_cancelled(cancel_event)
            if result.removed_count:
                self.session.append_compaction(result.summary, result.retained_tail)
                self.state.messages = self.session.build_context()
        except Exception as exc:
            await self._emit(CompactionEvent("compaction_error", automatic, error=str(exc)))
            raise
        await self._emit(
            CompactionEvent(
                "compaction_end",
                automatic,
                result=result,
                pre_tokens=pre_tokens,
                post_tokens=self.context_tokens(),
                summary_tokens=estimate_tokens(
                    UserMessage(content=result.summary)
                )
                if result.summary
                else 0,
            )
        )
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
        if getattr(self, "_plan_tool", None) is not None and self._plan_tool.name in names:
            raise ValueError(f"Tool '{self._plan_tool.name}' is managed by Plan mode and cannot be selected")
        missing = set(names) - self._tools.keys()
        if missing:
            raise ValueError(f"Tools required by the session are unavailable: {sorted(missing)}")
        if len(names) != len(set(names)):
            raise ValueError("Tool names must be unique")

    def get_tool(self, name: str):
        """Return a registered tool, including tools added by a runtime extension."""
        return self._tools.get(name)

    @property
    def interaction_mode(self) -> InteractionMode:
        return self._interaction_mode

    @property
    def effective_interaction_mode(self) -> EffectiveInteractionMode:
        return self._effective_interaction_mode

    @property
    def selected_tool_names(self) -> tuple[str, ...]:
        return tuple(self._selected_tool_names)

    @property
    def execution_mode(self) -> ExecutionMode:
        return self._execution_mode

    def _configure_tool_execution_mode(self) -> None:
        for tool in self._tools.values():
            setter = getattr(tool, "set_execution_mode", None)
            if callable(setter):
                setter(self._execution_mode)

    def _effective_tools(self) -> list[Any]:
        tools = [self._tools[name] for name in self._selected_tool_names]
        if self._effective_interaction_mode == "plan":
            tools = [tool for tool in tools if is_plan_safe_tool(tool)]
            tools.append(self._plan_tool)
        return tools

    def _apply_interaction_policy(self) -> None:
        self.state.tools = self._effective_tools()
        self._refresh_system_prompt()

    def _build_system_prompt(self, tools: list[Any]) -> str:
        """Call new four-argument builders while preserving the public 3-arg hook."""

        builder = self.session_config.system_prompt_builder
        if builder is None:
            return self._base_system_prompt
        try:
            signature = inspect.signature(builder)
            signature.bind(tools, self.skills, self.cwd, self._effective_interaction_mode)
            accepts_mode = True
        except (TypeError, ValueError):
            accepts_mode = False
        if accepts_mode:
            prompt = builder(tools, self.skills, self.cwd, self._effective_interaction_mode)
        else:
            prompt = builder(tools, self.skills, self.cwd)
        if self._effective_interaction_mode == "plan" and PLAN_MODE_SECTION not in prompt:
            prompt = f"{prompt}\n\n{PLAN_MODE_SECTION}"
        if self._active_skill_context:
            prompt = f"{prompt}\n\n{self._active_skill_context}"
        return prompt

    def prepare_interaction_for_prompt(self, message: str) -> EffectiveInteractionMode:
        """Resolve ``auto`` for one new turn and refresh prompt/tools."""

        self.ensure_idle()
        effective = resolve_interaction_mode(self._interaction_mode, message)
        if effective != self._effective_interaction_mode:
            self._effective_interaction_mode = effective
            self._apply_interaction_policy()
        return effective

    def set_interaction_mode(self, mode: str) -> InteractionMode:
        self.ensure_idle()
        normalized = str(mode).strip().lower()
        if normalized not in INTERACTION_MODES:
            raise ValueError(f"Interaction mode must be one of: {', '.join(INTERACTION_MODES)}")
        if normalized != self._interaction_mode:
            self.session.append_interaction_mode_change(normalized)
            self._interaction_mode = normalized  # type: ignore[assignment]
        effective: EffectiveInteractionMode = "plan" if normalized == "plan" else "default"
        if effective != self._effective_interaction_mode:
            self._effective_interaction_mode = effective
        self._apply_interaction_policy()
        return self._interaction_mode

    def set_execution_mode(self, mode: str) -> ExecutionMode:
        """Persist and apply local vs sandboxed tool execution for this branch."""

        self.ensure_idle()
        normalized = str(mode).strip().lower()
        if normalized not in EXECUTION_MODES:
            raise ValueError(f"Execution mode must be one of: {', '.join(EXECUTION_MODES)}")
        if normalized != self._execution_mode:
            self.session.append_execution_mode_change(normalized)
            self._execution_mode = normalized  # type: ignore[assignment]
            self._configure_tool_execution_mode()
        return self._execution_mode

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
            setter = getattr(tool, "set_execution_mode", None)
            if callable(setter):
                setter(self._execution_mode)
        if activate and additions:
            self._selected_tool_names.extend(names)
            self._apply_interaction_policy()

    def set_active_tools(self, names: list[str]) -> None:
        self.ensure_idle()
        self._validate_tool_names(names)
        # Runtime-discovered tools (for example MCP proxies) are deliberately
        # rediscovered instead of becoming a resume-time dependency.
        persisted = [name for name in names if name not in self._runtime_tool_names]
        self.session.append_active_tools_change(persisted)
        self._selected_tool_names = list(names)
        self._apply_interaction_policy()

    def _refresh_system_prompt(self):
        if self.session_config.system_prompt_builder:
            self.state.system_prompt = self._build_system_prompt(self.state.tools)
        else:
            self.state.system_prompt = self._base_system_prompt
            if self._effective_interaction_mode == "plan":
                self.state.system_prompt += f"\n\n{PLAN_MODE_SECTION}"
            if self._active_skill_context:
                self.state.system_prompt += f"\n\n{self._active_skill_context}"

    def move_to(self, entry_id: str | None) -> None:
        self.ensure_idle()
        self.session.move_to(entry_id)
        saved = self.session.build_settings()
        self.state.model = Model.model_validate(saved["model"]) if saved.get("model") else self._default_model
        self.state.thinking_level = saved.get("thinking_level", self.session_config.thinking_level)
        names = saved.get("active_tools", self._default_tool_names)
        self._validate_tool_names(names)
        mode = saved.get("interaction_mode", self.session_config.interaction_mode)
        if mode not in INTERACTION_MODES:
            raise ValueError(f"Invalid interaction mode: {mode}")
        self._selected_tool_names = list(names)
        self._interaction_mode = mode
        self._effective_interaction_mode = "plan" if mode == "plan" else "default"
        self._apply_interaction_policy()
        self.state.messages = self.session.build_context()
        self.state.error_message = None
        self.agent.clear_all_queues()
        self._recover_interrupted_tools()

    def fork(self, from_id: str | None = None) -> AgentSession:
        self.ensure_idle()
        forked = self.session.fork(from_id)
        model = None if forked.build_settings().get("model") else self._default_model
        tools = [tool for name, tool in self._tools.items() if name != self._plan_tool.name]
        return AgentSession(replace(self.session_config, session=forked, model=model,
                                    tools=tools, skills=list(self.skills)))

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
