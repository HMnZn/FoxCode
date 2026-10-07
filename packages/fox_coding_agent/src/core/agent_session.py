"""精简宿主：把 Agent、Session、Compaction、Skills 和 Tools 接起来。

一个 Harness 同时只运行一个操作。它不负责终端 UI、扩展市场或多进程调度。
恢复会话不会重放工具副作用：中断时缺失的工具结果会标记为未知/失败。
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
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
    AgentHarness,
    AgentHarnessConfig,
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
    resolve_interaction_mode,
)
from .system_prompt import PLAN_MODE_SECTION
from .tool_registry import ToolRegistry
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
    system_prompt_builder: Callable[[list[Any], list[Skill], Path, EffectiveInteractionMode], str] | None = None
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


class AgentSession(AgentHarness):
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
        self._tool_registry = ToolRegistry(tools)
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
        active_names = saved.get("active_tools", list(self._tool_registry.default_names))
        self._tool_registry.select(active_names)
        interaction_mode = saved.get("interaction_mode", config.interaction_mode)
        if interaction_mode not in INTERACTION_MODES:
            raise ValueError(f"Invalid interaction mode: {interaction_mode}")
        self._interaction_mode: InteractionMode = interaction_mode
        execution_mode = saved.get("execution_mode", config.execution_mode)
        if execution_mode not in EXECUTION_MODES:
            raise ValueError(f"Invalid execution mode: {execution_mode}")
        self._execution_mode: ExecutionMode = execution_mode
        self._tool_registry.configure_execution(self._execution_mode)
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
        effective_tools = self._tool_registry.effective_tools(self._effective_interaction_mode)
        self._base_system_prompt = "\n\n".join(part for part in (
            config.system_prompt, f"Working directory: {self.cwd}", format_skills_for_prompt(self.skills)
        ) if part)
        system = self._build_system_prompt(effective_tools)
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
        super().__init__(AgentHarnessConfig(
            agent_options=agent_options,
            hooks=HarnessHooks(
                persist_message=lambda message: self.session.append_message(message),
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
                # Output activity includes visible reasoning even when that
                # reasoning is intentionally omitted from the next request.
                output_tokens=estimate_tokens(event.message, include_thinking=True),
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

    async def prompt(
        self,
        message: str | AgentMessage | list[AgentMessage],
        *,
        effective_mode: EffectiveInteractionMode | None = None,
    ) -> None:
        prompt_text = self._prompt_text(message)
        if prompt_text is not None:
            self.prepare_interaction_for_prompt(prompt_text, effective_mode=effective_mode)
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
        # Providers can disconnect after streaming part of a text or tool call.
        # Partial content does not make the response usable: retry it just like
        # an error received before the first delta.
        if message.stop_reason != "error":
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

    def _failed_attempt(self):
        """Return the terminal failed assistant, past its paired tool results.

        The loop deliberately pairs a partially streamed tool call with an
        error ToolResultMessage so the durable transcript remains structurally
        valid.  Those result messages used to hide the assistant from recovery,
        causing the configured retry loop to stop early.
        """

        trailing_results: list[ToolResultMessage] = []
        for entry in reversed(self.session.get_branch()):
            if entry.type != "message":
                continue
            message = entry.data
            if isinstance(message, ToolResultMessage):
                trailing_results.append(message)
                continue
            if not isinstance(message, AssistantMessage):
                return None
            kind = self._failure_kind(message)
            if kind is None:
                return None
            call_ids = {
                block.id for block in message.content if isinstance(block, ToolCall)
            }
            if trailing_results and any(
                result.tool_call_id not in call_ids for result in trailing_results
            ):
                return None
            return entry, message, kind
        return None

    async def _run_with_recovery(self, action) -> None:
        await self.run(action)
        for attempt in range(1, self.session_config.model_retry_attempts + 1):
            failed = self._failed_attempt()
            if failed is None:
                return
            entry, message, kind = failed
            failed_leaf = self.session.leaf_id
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
        return estimate_context_tokens(
            list(messages),
            include_thinking=self._replays_thinking(),
        ) + overhead

    def _replays_thinking(self, model: Model | None = None) -> bool:
        """Whether this provider sends raw reasoning back on later requests."""

        selected = model or self.state.model
        return bool(
            (selected.compat or {}).get(
                "requiresReasoningContentOnAssistantMessages", False
            )
        )

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
            last_summary_update = 0.0
            async def on_summary_update(message) -> None:
                nonlocal last_summary_update
                now = time.monotonic()
                # Providers can split output into hundreds of tiny chunks.  A
                # progress frame per chunk floods Electron IPC without making
                # the compacting indicator more informative.
                if now - last_summary_update < 0.1:
                    return
                last_summary_update = now
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
                    "include_thinking": self._replays_thinking(model),
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

    def get_tool(self, name: str):
        """Return a registered tool, including runtime extensions."""
        return self._tool_registry.get(name)

    @property
    def interaction_mode(self) -> InteractionMode:
        return self._interaction_mode

    @property
    def effective_interaction_mode(self) -> EffectiveInteractionMode:
        return self._effective_interaction_mode

    @property
    def selected_tool_names(self) -> tuple[str, ...]:
        return self._tool_registry.selected_names

    @property
    def execution_mode(self) -> ExecutionMode:
        return self._execution_mode

    def _apply_interaction_policy(self) -> None:
        self.state.tools = self._tool_registry.effective_tools(self._effective_interaction_mode)
        self._refresh_system_prompt()

    def _build_system_prompt(self, tools: list[Any]) -> str:
        builder = self.session_config.system_prompt_builder
        prompt = (
            builder(tools, self.skills, self.cwd, self._effective_interaction_mode)
            if builder is not None else self._base_system_prompt
        )
        if self._effective_interaction_mode == "plan" and PLAN_MODE_SECTION not in prompt:
            prompt = f"{prompt}\n\n{PLAN_MODE_SECTION}"
        if self._active_skill_context:
            prompt = f"{prompt}\n\n{self._active_skill_context}"
        return prompt

    def prepare_interaction_for_prompt(
        self,
        message: str,
        *,
        effective_mode: EffectiveInteractionMode | None = None,
    ) -> EffectiveInteractionMode:
        """Resolve ``auto`` for one turn, or apply an explicit one-turn mode.

        ``effective_mode`` intentionally does not change the persistent user
        selection.  Internal transitions such as approving a submitted plan
        can therefore enter execution for exactly one turn while Auto remains
        selected.
        """

        self.ensure_idle()
        effective = (
            effective_mode
            if effective_mode is not None
            else resolve_interaction_mode(self._interaction_mode, message)
        )
        if effective not in ("default", "plan"):
            raise ValueError("Effective interaction mode must be one of: default, plan")
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
            self._tool_registry.configure_execution(self._execution_mode)
        return self._execution_mode

    def add_runtime_tools(self, tools: list[Any], *, activate: bool = True) -> None:
        """Add ephemeral tools discovered after session construction.

        Dynamic capabilities such as MCP are not persisted in ``active_tools``:
        they must be rediscovered for every runtime, which prevents a resumed
        session from depending on a server that is no longer configured.
        """
        self.ensure_idle()
        self._tool_registry.add_runtime(
            tools, activate=activate, execution_mode=self._execution_mode,
        )
        if activate and tools:
            self._apply_interaction_policy()

    def set_active_tools(self, names: list[str]) -> None:
        self.ensure_idle()
        self.session.append_active_tools_change(self._tool_registry.persisted_names(names))
        self._tool_registry.select(names)
        self._apply_interaction_policy()

    def _refresh_system_prompt(self):
        self.state.system_prompt = self._build_system_prompt(self.state.tools)

    def move_to(self, entry_id: str | None) -> None:
        self.ensure_idle()
        self.session.move_to(entry_id)
        saved = self.session.build_settings()
        self.state.model = Model.model_validate(saved["model"]) if saved.get("model") else self._default_model
        self.state.thinking_level = saved.get("thinking_level", self.session_config.thinking_level)
        names = saved.get("active_tools", list(self._tool_registry.default_names))
        self._tool_registry.validate_selection(names)
        mode = saved.get("interaction_mode", self.session_config.interaction_mode)
        if mode not in INTERACTION_MODES:
            raise ValueError(f"Invalid interaction mode: {mode}")
        self._tool_registry.select(names)
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
        tools = self._tool_registry.fork_tools()
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
