"""Sub-agent extension with isolated context and capability-scoped child sessions."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from fox_ai.src import AssistantMessage, TextContent
from fox_agent_core.src import AgentToolResult
from fox_agent_core.src._async import maybe_await

from ...core.agent_session import AgentSession, AgentSessionConfig
from ...core.permissions import check_tool_permission
from ...core.session_manager import SessionManager
from .discovery import discover_subagents
from .models import SubAgentCatalog, SubAgentDefinition


def _result(text: str, **details) -> AgentToolResult:
    return AgentToolResult([TextContent(text=text)], details=details or None)


@dataclass(frozen=True)
class SubAgentExtensionConfig:
    # Delegated coding tasks commonly need several inspect/edit/test cycles.
    # Match the main harness ceiling so a child does not die after doing the
    # work but before it has one final turn left to report the result.
    max_turns: int = 100
    auto_activate_tool: bool = True

    def __post_init__(self) -> None:
        if not 1 <= self.max_turns <= 100:
            raise ValueError("max_turns must be between 1 and 100")


class SubAgentService:
    """Runtime-bound child-agent launcher registered as ``subagent.manager``."""

    def __init__(self, config: SubAgentExtensionConfig) -> None:
        self.config = config
        self.context = None
        self.catalog = SubAgentCatalog()
        self._children: set[AgentSession] = set()

    def bind(self, context) -> None:
        self.context = context
        self.catalog = discover_subagents(
            context.user_dir, context.cwd, project_trusted=context.project_trusted
        )

    def definitions(self) -> list[SubAgentDefinition]:
        return list(self.catalog.definitions.values())

    def _require_context(self):
        if self.context is None:
            raise RuntimeError("Sub-agent extension has not received session_start")
        return self.context

    def _select_tools(self, definition: SubAgentDefinition):
        context = self._require_context()
        available = {
            tool.name: tool for tool in context.active_tools
            if tool.name != SubAgentTool.name
        }
        if definition.allowed_tools is None:
            return list(available.values())
        missing = set(definition.allowed_tools) - available.keys()
        if missing and definition.source != "built-in":
            raise ValueError(
                f"Sub-agent '{definition.name}' requests unavailable tools: {sorted(missing)}"
            )
        # Built-ins describe a portable maximum capability set. For example,
        # PowerShell is normally inactive on Linux; the test profile should
        # still run with bash instead of failing profile validation.
        return [available[name] for name in definition.allowed_tools if name in available]

    async def run(
        self,
        agent_type: str,
        prompt: str,
        description: str = "",
        *,
        cancel_event: asyncio.Event | None = None,
        on_update=None,
    ) -> AgentToolResult:
        context = self._require_context()
        if not context.project_trusted:
            raise PermissionError("Sub-agents are disabled until the project is trusted")
        definition = self.catalog.definitions.get(agent_type)
        if definition is None:
            raise ValueError(
                f"Unknown sub-agent type '{agent_type}'; available: "
                f"{', '.join(sorted(self.catalog.definitions))}"
            )
        parent = context.agent_session
        tools = self._select_tools(definition)

        async def before_tool(data, child_cancel_event):
            tool = next((item for item in tools if item.name == data["tool_call"].name), None)
            if tool is None:
                return {"block": True, "reason": "Tool is outside the sub-agent capability set"}
            # Delegation must not silently widen the filesystem boundary.  In
            # particular, a parent running with full access should not let a
            # child write to AppData/TEMP merely because the model picked an
            # absolute scratch path.  Shell tools are additionally given a
            # workspace-local TEMP by BashTool/PowerShellTool.
            if (
                getattr(tool, "required_permission", None) == "workspace-modify"
                and getattr(tool, "permission_paths", ())
            ):
                reason = check_tool_permission(tool, data["args"], context.cwd, "workspace-modify")
                if reason:
                    return {
                        "block": True,
                        "reason": "Sub-agent filesystem boundary: " + reason,
                    }
            # A child must go through the same host approval/audit chain as its
            # parent. In the desktop host the runtime itself is deliberately
            # built as full-access and the real user-selected policy lives in
            # this hook. Running a second static check against the extension
            # context made a delegated shell call stricter than the identical
            # main-agent call.
            parent_before = parent.session_config.before_tool_call
            if parent_before is not None:
                outcome = await maybe_await(parent_before(data, child_cancel_event))
                if outcome:
                    return outcome
                return None

            # A manually assembled AgentSession may not have a parent hook. In
            # that SDK-only case retain the ordinary static permission guard.
            reason = check_tool_permission(
                tool, data["args"], context.cwd, context.permission_mode
            )
            return {"block": True, "reason": reason} if reason else None

        child_stream_options = dict(parent.session_config.stream_options)
        # The provider-facing session id identifies one agent conversation.
        # Reusing the parent's id for an isolated child can make transports or
        # gateways cancel one stream when another request starts.
        child_stream_options.pop("session_id", None)

        child = AgentSession(AgentSessionConfig(
            model=parent.state.model,
            session=SessionManager(),
            cwd=context.cwd,
            system_prompt=definition.system_prompt,
            tools=tools,
            skills=[],
            stream_fn=parent.session_config.stream_fn,
            stream_options=child_stream_options,
            thinking_level=parent.state.thinking_level,
            max_turns=self.config.max_turns,
            tool_execution=parent.session_config.tool_execution,
            # A sub-agent returns its report directly to the parent tool call;
            # it has no interactive host where somebody can accept a submitted
            # plan. Its profile and allowed_tools already define the intended
            # role. Auto-routing a prompt containing "design" or "plan" into
            # interactive Plan mode exposes submit_plan, which is outside the
            # child's capability set and leaves the delegation without text.
            interaction_mode="default",
            before_tool_call=before_tool,
            model_retry_attempts=parent.session_config.model_retry_attempts,
        ))
        self._children.add(child)
        started_at = time.monotonic()
        progress = {
            "phase": "正在启动",
            "context_tokens": 0,
            "output_tokens": 0,
            "estimated": True,
            "last_report_at": 0.0,
        }

        def report_progress(*, force: bool = False) -> None:
            if on_update is None:
                return
            now = time.monotonic()
            # Message deltas can arrive several times per token.  A short
            # throttle keeps live accounting responsive without flooding the
            # desktop pipe with near-identical tool update frames.
            if not force and now - progress["last_report_at"] < 0.2:
                return
            progress["last_report_at"] = now
            elapsed = max(0, int(time.monotonic() - started_at))
            text = f"子 Agent 运行中 · {elapsed}s · {progress['phase']}"
            on_update(_result(
                text,
                agent_type=agent_type,
                description=description,
                elapsed_seconds=elapsed,
                heartbeat=not force,
                context_usage={
                    "context_tokens": progress["context_tokens"],
                    "output_tokens": progress["output_tokens"],
                    "estimated": progress["estimated"],
                },
            ))

        async def relay_child_event(event, _child_cancel_event) -> None:
            kind = getattr(event, "type", "")
            if kind == "agent_start":
                progress["phase"] = "正在请求模型"
                report_progress(force=True)
            elif kind == "turn_start":
                progress["phase"] = "正在思考"
            elif kind == "tool_execution_start":
                progress["phase"] = f"正在调用 {getattr(event, 'tool_name', '工具')}"
                report_progress(force=True)
            elif kind == "tool_execution_end":
                name = getattr(event, "tool_name", "工具")
                progress["phase"] = (
                    f"{name} 调用失败，正在恢复"
                    if bool(getattr(event, "is_error", False))
                    else f"已完成 {name}，继续处理"
                )
                report_progress(force=True)
            elif kind == "message_update":
                usage = getattr(event, "context_usage", None)
                if usage is not None:
                    progress["context_tokens"] = max(
                        0, int(getattr(usage, "context_tokens", 0) or 0)
                    )
                    progress["output_tokens"] = max(
                        0, int(getattr(usage, "output_tokens", 0) or 0)
                    )
                    progress["estimated"] = bool(getattr(usage, "estimated", True))
                    stream_event = getattr(event, "assistant_message_event", None)
                    report_progress(force=getattr(stream_event, "type", "") in {
                        "done", "text_end", "thinking_end", "toolcall_end",
                    })

        async def heartbeat() -> None:
            while True:
                await asyncio.sleep(5)
                report_progress()

        async def relay_parent_cancel() -> None:
            assert cancel_event is not None
            await cancel_event.wait()
            child.abort()

        child.subscribe(relay_child_event)
        heartbeat_task = asyncio.create_task(heartbeat()) if on_update is not None else None
        cancel_task = (
            asyncio.create_task(relay_parent_cancel()) if cancel_event is not None else None
        )
        try:
            await child.prompt(prompt)
            final = next(
                (message for message in reversed(child.state.messages)
                 if isinstance(message, AssistantMessage)),
                None,
            )
            if final is None:
                raise RuntimeError("Sub-agent produced no assistant response")
            if final.stop_reason in {"error", "aborted"}:
                if final.stop_reason == "aborted" and cancel_event is not None and cancel_event.is_set():
                    raise RuntimeError("Sub-agent was cancelled because the parent run was interrupted")
                raise RuntimeError(final.error_message or "Sub-agent failed")
            text = "\n".join(
                block.text for block in final.content if isinstance(block, TextContent)
            ).strip()
            if not text:
                raise RuntimeError(
                    "Sub-agent ended without a final text report; narrow the task or increase its turn budget"
                )
            usage = child.session.usage_totals()
            return _result(
                text,
                agent_type=agent_type,
                description=description,
                usage=usage,
                context_usage={
                    "context_tokens": progress["context_tokens"],
                    "output_tokens": progress["output_tokens"],
                    "estimated": progress["estimated"],
                },
            )
        finally:
            for task in (heartbeat_task, cancel_task):
                if task is not None and not task.done():
                    task.cancel()
            child.abort()
            await child.wait_for_idle()
            await asyncio.gather(
                *(task for task in (heartbeat_task, cancel_task) if task is not None),
                return_exceptions=True,
            )
            self._children.discard(child)

    async def close(self) -> None:
        children = list(self._children)
        for child in children:
            child.abort()
        if children:
            await asyncio.gather(*(child.wait_for_idle() for child in children), return_exceptions=True)
        self._children.clear()


class SubAgentTool:
    name = "agent"
    label = "Run sub-agent"
    required_permission = "read-only"
    execution_mode = "parallel"
    description = (
        "Run one isolated sub-agent and return its final report. Built-ins: explore (read-only), "
        "plan (read-only), test (verification with workspace-local temp files), general (enabled "
        "parent tools). Custom types come from .foxcode/agents."
    )
    parameters = {
        "type": "object",
        "properties": {
            "description": {"type": "string", "minLength": 1, "maxLength": 100},
            "prompt": {"type": "string", "minLength": 1, "maxLength": 50_000},
            "type": {"type": "string", "minLength": 1, "maxLength": 64},
        },
        "required": ["description", "prompt"],
        "additionalProperties": False,
    }

    def __init__(self, service: SubAgentService) -> None:
        self.service = service

    async def execute(self, call_id, params, cancel_event=None, on_update=None):
        return await self.service.run(
            params.get("type", "general"),
            params["prompt"],
            params["description"],
            cancel_event=cancel_event,
            on_update=on_update,
        )


def create_subagent_extension(config: SubAgentExtensionConfig | None = None):
    config = config or SubAgentExtensionConfig()

    def setup(api):
        service = SubAgentService(config)
        tool = SubAgentTool(service)
        api.register_service("subagent.manager", service)
        api.register_tool(tool)
        api.add_prompt_guideline(
            "Use the agent tool for bounded delegated work when isolation or independent exploration helps; "
            "include all necessary context in its prompt and do not duplicate its work. Use the test type "
            "for verification. Sub-agents must keep all files, including temporary artifacts, inside the "
            "current workspace."
        )

        def session_start(data, context):
            service.bind(context)
            if config.auto_activate_tool and tool.name not in {
                item.name for item in context.selected_tools
            }:
                active = [item.name for item in context.selected_tools]
                context.activate_tools([*active, tool.name])

        async def session_shutdown(data, context):
            await service.close()

        def command(arguments, context):
            values = [{
                "name": item.name,
                "description": item.description,
                "allowed_tools": list(item.allowed_tools) if item.allowed_tools is not None else None,
                "source": item.source,
            } for item in service.definitions()]
            return {
                "agents": values,
                "diagnostics": [diagnostic.__dict__ for diagnostic in service.catalog.diagnostics],
            }

        api.on("session_start", session_start)
        api.on("session_shutdown", session_shutdown)
        api.register_command("agents", command, "List available sub-agent profiles")

    return setup


setup = create_subagent_extension()


__all__ = [
    "SubAgentExtensionConfig", "SubAgentService", "SubAgentTool",
    "create_subagent_extension", "setup",
]
