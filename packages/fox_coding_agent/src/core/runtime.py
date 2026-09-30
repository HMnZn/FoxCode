"""AgentSession 的宿主生命周期：切换 Session/cwd、重载资源、保持订阅。"""

from __future__ import annotations

import os
from pathlib import Path

from fox_ai.src import Model, TextContent, UserMessage
from fox_agent_core.src._async import maybe_await, cancellable
import asyncio
from .agent_session import AgentSession, AgentSessionConfig
from .resources import ResourceLoader
from .session_manager import InMemorySessionStorage, JsonlSessionStorage, SessionManager
from .session_layout import SessionLayout
from .settings import SettingsManager
from .model_runtime import ModelRuntime
from .tools import create_all_tools
from .system_prompt import build_system_prompt
from .extensions import ExtensionRunner, ExtensionContext
from .permissions import PERMISSION_MODES, check_tool_permission
from .interaction import is_plan_safe_tool
from .sandbox import check_sandbox_tool
from .paths import UserPaths


class AgentSessionRuntime:
    """一个 runtime 拥有一个当前 AgentSession；订阅在切换后继续生效。

    使用 prompt/continue_/invoke_* 启动任务。切换会取消并等待旧任务持久化；
    change_cwd 创建独立新会话，reload 保留当前会话和待处理消息。
    构造或加载失败时保留旧 AgentSession。工具工厂接收新 cwd，避免复用旧路径。
    """

    def __init__(self, cwd: str | Path = ".", *, model: Model | None = None,
                 session_file: str | Path | None = None, user_dir: str | Path | None = None,
                 settings_overrides: dict | None = None, stream_fn=None, stream_options: dict | None = None,
                 resource_providers=(), tool_factory=None, before_tool_call=None, after_tool_call=None,
                 extension_paths=(), extension_factories=(), extension_specs=(), summary_fn=None,
                 project_trusted: bool | None = True, trust_resolver=None):
        self.user_dir = Path(user_dir).expanduser().resolve() if user_dir else Path.home() / ".foxcode"
        self.model_runtime = ModelRuntime(self.user_dir, stream_fn=stream_fn)
        self._overrides = settings_overrides or {}
        self._stream_fn, self._stream_options = stream_fn, dict(stream_options or {})
        self._providers = tuple(resource_providers)
        self._tool_factory = tool_factory or create_all_tools
        self._extension_paths = tuple(Path(p).expanduser().resolve() for p in extension_paths)
        self._extension_factories = tuple(extension_factories)
        self._extension_specs = tuple(extension_specs)
        self._summary_fn = summary_fn
        self._preparing = False
        self._hook_cancel = None
        self._before, self._after = before_tool_call, after_tool_call
        self._listeners = []
        self._changing = False
        self._closed = False
        self._trust_resolver = trust_resolver
        cwd = Path(cwd).expanduser().resolve()
        session = None
        if session_file is not None:
            path = self._existing_file(session_file)
            session = SessionManager(JsonlSessionStorage(path))
            cwd = Path(session.storage.get_metadata().get("cwd", str(cwd))).expanduser().resolve()
        else:
            path = None
        if project_trusted is None:
            project_trusted = bool(trust_resolver(cwd)) if trust_resolver else True
        self.project_trusted = project_trusted
        settings, loader, resources = self._prepare(cwd, project_trusted)
        selected = self._model(model, session, settings)
        if session is None:
            path, session = self._new_session(cwd, settings)
        agent_session = self._build(cwd, session, selected, settings, resources, project_trusted)
        self._install(cwd, path, settings, loader, resources, agent_session, project_trusted)

    @staticmethod
    def _existing_file(path) -> Path:
        path = Path(path).expanduser().resolve()
        if not path.is_file() or path.stat().st_size == 0:
            raise FileNotFoundError(f"Session file does not exist or is empty: {path}")
        return path

    def _prepare(self, cwd, project_trusted=None):
        if not cwd.is_dir():
            raise NotADirectoryError(f"Working directory does not exist: {cwd}")
        trusted = self.project_trusted if project_trusted is None else project_trusted
        settings = SettingsManager(cwd, user_dir=self.user_dir, overrides=self._overrides,
                                   project_trusted=trusted)
        loader = ResourceLoader(cwd, user_dir=self.user_dir, providers=self._providers,
                                project_trusted=trusted)
        return settings, loader, loader.load()

    def _model(self, explicit, session, manager):
        saved = session.build_settings().get("model") if session is not None else None
        selected = explicit or (Model.model_validate(saved) if saved else manager.settings.model)
        if isinstance(selected, str):
            selected = self.model_runtime.registry.resolve(selected).model
        if selected is None:
            configured = self.model_runtime.registry.default()
            selected = configured.model if configured else None
        if selected is None:
            raise ValueError(f"A model is required: configure {self.user_dir / 'models.json'} or pass --model.")
        return selected

    @staticmethod
    def _session_layout(manager: SettingsManager) -> SessionLayout:
        # SessionLayout has no cwd/default-root fallback.  SettingsManager's
        # explicit user directory is the sole owner of all transcripts.
        return SessionLayout(UserPaths.from_root(manager.user_dir).sessions)

    @classmethod
    def latest_session(cls, cwd: str | Path = ".", *, user_dir=None,
                       project_trusted: bool = True) -> Path:
        cwd = Path(cwd).expanduser().resolve()
        manager = SettingsManager(cwd, user_dir=user_dir, project_trusted=project_trusted)
        files = cls._session_layout(manager).files(cwd)
        if not files:
            raise FileNotFoundError(f"No saved sessions for {cwd}")
        return max(files, key=lambda path: (path.stat().st_mtime_ns, path.name))

    def _new_session(self, cwd, settings):
        path = self._session_layout(settings).new_session_file(cwd)
        return path, SessionManager(InMemorySessionStorage(metadata={"cwd": str(cwd)}))

    @staticmethod
    def _persist_new(agent_session, path):
        """Publish an in-memory draft immediately before its first real message."""
        if isinstance(agent_session.session.storage, JsonlSessionStorage):
            return
        if path.exists():
            raise FileExistsError(f"Refusing to overwrite session: {path}")
        try:
            storage = JsonlSessionStorage(path, metadata=agent_session.session.storage.get_metadata())
            for entry in agent_session.session.get_entries():
                storage.append_entry(entry)
        except BaseException:
            # This method owns this newly created UUID path; existing sessions never enter here.
            path.unlink(missing_ok=True)
            raise
        agent_session.session = SessionManager(storage)
        agent_session.session_config.session = agent_session.session
        # AgentSession hooks captured the temporary in-memory session's bound
        # method during construction. Rebind persistence after publishing the
        # JSONL-backed session so new messages reach the durable transcript.
        agent_session.hooks.persist_message = agent_session.session.append_message

    def _build(self, cwd, session, model, manager, resources, project_trusted):
        extensions = ExtensionRunner.load(
            paths=self._extension_paths,
            factories=tuple(dict.fromkeys(self._extension_factories)),
            specs=self._extension_specs,
            sources=manager.settings.extensions,
        )
        try:
            return self._build_with_extensions(
                cwd, session, model, manager, resources, extensions, project_trusted
            )
        except BaseException:
            extensions.dispose()
            raise

    def _build_with_extensions(self, cwd, session, model, manager, resources, extensions,
                               project_trusted):
        settings = manager.settings
        had_tool_selection = "active_tools" in session.build_settings()
        tools = [*self._tool_factory(cwd), *extensions.api.tools]
        available = {tool.name for tool in tools}
        if len(available) != len(tools):
            raise ValueError("Extension tool names must not collide with built-in/custom tools")
        if settings.tools is not None and (len(settings.tools) != len(set(settings.tools))
                                            or set(settings.tools) - available):
            raise ValueError("Configured tools must be unique and available in this runtime")
        stream_options = {**settings.stream_options, **self._stream_options}
        authenticated_stream = self.model_runtime.authenticated_stream(api_key_env=settings.api_key_env)
        async def before(data, cancel):
            call = data["tool_call"]
            tool = agent_session.get_tool(call.name)
            if tool is None:
                return {"block": True, "reason": f"Tool '{call.name}' is not registered"}
            # submit_plan only packages text already produced by the model; it
            # reads no project data and changes no external state. Keeping it
            # available lets an untrusted workspace still show the approval
            # card, while every actual project tool remains blocked.
            if not project_trusted and call.name != "submit_plan":
                return {"block": True, "reason": (
                    "Project is not trusted; restart with --trust-project before executing tools"
                )}
            if (agent_session.effective_interaction_mode == "plan"
                    and not is_plan_safe_tool(tool)):
                return {"block": True, "reason": (
                    f"Tool '{call.name}' is blocked while Plan mode is active; "
                    "switch to Default mode before implementation"
                )}
            if agent_session.execution_mode == "sandbox":
                sandbox_reason = check_sandbox_tool(tool, data["args"], cwd)
                if sandbox_reason:
                    return {"block": True, "reason": sandbox_reason}
            reason = check_tool_permission(tool, data["args"], cwd, settings.permission_mode)
            if reason:
                return {"block": True, "reason": reason}
            if self._before:
                outcome = await maybe_await(self._before(data, cancel))
                if outcome and outcome.get("block"):
                    return outcome
            return await extensions.before_tool(data, cancel, agent_session.extension_context)

        async def after(data, cancel):
            outcome = await extensions.after_tool(data, cancel, agent_session.extension_context) or {}
            if self._after:
                outcome.update(await maybe_await(self._after(data, cancel)) or {})
            return outcome or None

        async def transform_context(messages, cancel):
            return await extensions.transform_context(messages, agent_session.extension_context)

        def prompt_builder(active, skills, workdir, interaction_mode):
            return build_system_prompt(cwd=workdir, tools=active, skills=skills, resources=resources,
                custom_prompt=settings.system_prompt or resources.system_prompt_override,
                append_prompt=settings.append_system_prompt, guidelines=extensions.api.guidelines,
                permission_mode=settings.permission_mode, interaction_mode=interaction_mode)

        agent_session = AgentSession(AgentSessionConfig(
            model=model, cwd=cwd, session=session, tools=tools, skills=resources.skills,
            system_prompt_builder=prompt_builder,
            compaction=settings.compaction, max_turns=settings.max_turns,
            model_retry_attempts=settings.model_retry_attempts,
            tool_execution=settings.tool_execution, stream_fn=authenticated_stream,
            stream_options=stream_options, before_tool_call=before, after_tool_call=after,
            summary_fn=self._summary_fn, transform_context=transform_context,
            interaction_mode=settings.interaction_mode,
            execution_mode=settings.execution_mode,
        ))
        agent_session.extensions = extensions
        agent_session.extension_context = ExtensionContext(
            cwd=cwd,
            agent_session=agent_session,
            user_dir=self.user_dir,
            project_trusted=project_trusted,
            permission_mode=settings.permission_mode,
            services=extensions.api.services,
        )
        selected_names = list(agent_session.selected_tool_names)
        if settings.tools is not None and selected_names != settings.tools:
            agent_session.set_active_tools(settings.tools)
        elif settings.tools is None and os.name != "nt" and "powershell" in available:
            # Keep saved choices; hide Windows-specific commands only for brand-new sessions.
            if not had_tool_selection:
                agent_session.set_active_tools([name for name in selected_names if name != "powershell"])
        return agent_session

    def _install(self, cwd, path, settings, loader, resources, agent_session, project_trusted):
        previous_unsubscribe = getattr(self, "_unsubscribe", None)
        previous = getattr(self, "agent_session", None)
        self.cwd, self.session_file = cwd, path
        self.project_trusted = project_trusted
        self.settings_manager, self.resource_loader, self.resources = settings, loader, resources
        self.agent_session = agent_session
        self._extensions_started = False
        self._unsubscribe = agent_session.subscribe(self._forward)
        if previous_unsubscribe:
            previous_unsubscribe()
        if previous:
            previous.extensions.dispose()

    async def _forward(self, event, cancel_event):
        await self.agent_session.extensions.emit(event.type, event, self.agent_session.extension_context)
        for listener in list(self._listeners):
            await maybe_await(listener(event, cancel_event))

    def subscribe(self, listener):
        self._listeners.append(listener)

        def unsubscribe():
            if listener in self._listeners:
                self._listeners.remove(listener)
        return unsubscribe

    @property
    def state(self):
        return self.agent_session.state

    @property
    def session(self):
        return self.agent_session.session

    @property
    def usage_totals(self):
        return self.session.usage_totals()

    @property
    def permission_mode(self):
        return self.settings_manager.settings.permission_mode

    @property
    def interaction_mode(self):
        return self.agent_session.interaction_mode

    @property
    def effective_interaction_mode(self):
        return self.agent_session.effective_interaction_mode

    @property
    def execution_mode(self):
        return self.agent_session.execution_mode

    def export_session(self, path: str | Path, *, format: str | None = None) -> Path:
        """Export the current session tree as JSON or active transcript as Markdown."""
        target = Path(path)
        selected = (format or target.suffix.lstrip(".") or "json").lower()
        if selected in {"md", "markdown"}:
            return self.session.export_markdown(target)
        if selected == "json":
            return self.session.export_json(target)
        raise ValueError("Session export format must be json or markdown")

    @property
    def available_models(self):
        """Models from the user-level models.json catalog."""
        return self.model_runtime.registry.models

    def select_model(self, reference: str) -> Model:
        """Switch the current Session to a models.json model while idle."""
        self._ensure_available()
        self.agent_session.ensure_idle()
        selected = self.model_runtime.registry.resolve(reference)
        self.agent_session.set_model(selected.model)
        if not selected.model.reasoning and self.state.thinking_level:
            self.agent_session.set_thinking_level("off")
        return selected.model

    def set_thinking_level(self, level: str) -> None:
        self._ensure_available()
        self.agent_session.ensure_idle()
        if level != "off" and not self.state.model.reasoning:
            raise ValueError(f"Model {self.state.model.provider}/{self.state.model.id} does not support reasoning")
        self.agent_session.set_thinking_level(level)

    def _ensure_available(self):
        if self._closed:
            raise RuntimeError("Runtime is closed")
        if self._changing:
            raise RuntimeError("Runtime is switching or reloading; wait for it to finish")
        if self._preparing:
            raise RuntimeError("Runtime is preparing a request or running an extension command")

    async def _start_extensions(self):
        if not self._extensions_started:
            await self.agent_session.extensions.emit("session_start", {"type": "session_start", "cwd": self.cwd},
                                               self.agent_session.extension_context)
            self._extensions_started = True

    async def _prepare_start(self):
        self._ensure_available()
        self.agent_session.ensure_idle()
        self._preparing = True
        self._hook_cancel = asyncio.Event()
        try:
            await cancellable(self._start_extensions(), self._hook_cancel)
        finally:
            self._preparing = False
            self._hook_cancel = None

    async def prompt(self, message):
        self._ensure_available()
        self.agent_session.ensure_idle()
        native_message = message if isinstance(message, UserMessage) else None
        hook_message = message
        if native_message is not None:
            hook_message = (
                native_message.content
                if isinstance(native_message.content, str)
                else "\n".join(
                    block.text for block in native_message.content if isinstance(block, TextContent)
                )
            )
        if isinstance(hook_message, str):
            self.agent_session.prepare_interaction_for_prompt(hook_message)
        self._preparing = True
        self._hook_cancel = asyncio.Event()
        try:
            await cancellable(self._start_extensions(), self._hook_cancel)
            outcomes = await cancellable(self.agent_session.extensions.emit("before_prompt", {"message": hook_message},
                self.agent_session.extension_context), self._hook_cancel)
            for outcome in outcomes:
                if outcome and "message" in outcome:
                    hook_message = outcome["message"]
        finally:
            self._preparing = False
            self._hook_cancel = None
        if native_message is not None and isinstance(hook_message, str):
            blocks = [] if isinstance(native_message.content, str) else list(native_message.content)
            images = [block for block in blocks if not isinstance(block, TextContent)]
            message = UserMessage(
                content=([TextContent(text=hook_message)] if hook_message else []) + images,
                timestamp=native_message.timestamp,
            )
        else:
            message = hook_message
        self._persist_new(self.agent_session, self.session_file)
        await self.agent_session.prompt(message)

    def set_interaction_mode(self, mode: str):
        """Select automatic, normal execution, or read-only planning for this branch."""

        self._ensure_available()
        return self.agent_session.set_interaction_mode(mode)

    def set_execution_mode(self, mode: str):
        """Select direct host execution or the native project sandbox."""

        self._ensure_available()
        return self.agent_session.set_execution_mode(mode)

    async def continue_(self):
        await self._prepare_start()
        if any(entry.type == "message" for entry in self.session.get_entries()):
            self._persist_new(self.agent_session, self.session_file)
        await self.agent_session.continue_()

    async def invoke_skill(self, name, instructions=""):
        from .skills import format_skill_invocation
        skill = next((s for s in self.agent_session.skills if s.name == name), None)
        if skill is None:
            raise ValueError(f"Unknown skill: {name}")
        await self.prompt(format_skill_invocation(skill, instructions))

    async def invoke_prompt(self, name, arguments=""):
        self._ensure_available()
        if name not in self.resources.prompts:
            raise ValueError(f"Unknown prompt template: {name}")
        await self.prompt(self.resources.prompts[name].render(arguments))

    def abort(self):
        self.agent_session.abort()
        if self._hook_cancel is not None:
            self._hook_cancel.set()

    async def compact(self):
        await self._prepare_start()
        return await self.agent_session.compact()

    async def run_command(self, name, arguments=""):
        self._ensure_available()
        self.agent_session.ensure_idle()
        self._preparing = True
        self._hook_cancel = asyncio.Event()
        try:
            await cancellable(self._start_extensions(), self._hook_cancel)
            return await cancellable(self.agent_session.extensions.command(name, arguments, self.agent_session.extension_context),
                                     self._hook_cancel)
        finally:
            self._preparing = False
            self._hook_cancel = None

    async def _replace(self, *, cwd=None, session_file=None, reload=False, model=None,
                       project_trusted=None):
        self._ensure_available()
        self._changing = True
        candidate = None
        try:
            target_cwd = Path(cwd).expanduser().resolve() if cwd is not None else self.cwd
            path, session = None, None
            if session_file is not None:
                path = self._existing_file(session_file)
                # Read metadata before touching the old runtime. Reopen after it settles.
                preview = SessionManager(JsonlSessionStorage(path))
                target_cwd = Path(preview.storage.get_metadata().get("cwd", str(target_cwd))).expanduser().resolve()
            if project_trusted is not None:
                target_trusted = project_trusted
            elif target_cwd == self.cwd:
                target_trusted = self.project_trusted
            elif self._trust_resolver:
                target_trusted = bool(self._trust_resolver(target_cwd))
            else:
                target_trusted = self.project_trusted
            if reload:
                path = self.session_file
            settings, loader, resources = self._prepare(target_cwd, target_trusted)
            old = self.agent_session
            old.abort()
            await old.wait_for_idle()
            if reload:
                session = old.session
            elif path is not None:
                session = SessionManager(JsonlSessionStorage(path))
            # New projects use their configured model, falling back to the current model.
            fallback = self.state.model if session is None and settings.settings.model is None else None
            selected = self._model(model or fallback, session, settings)
            is_new_session = session is None
            if session is None:
                path, session = self._new_session(target_cwd, settings)
            candidate = self._build(
                target_cwd, session, selected, settings, resources, target_trusted
            )
            if is_new_session and selected.reasoning and old.state.thinking_level:
                candidate.set_thinking_level(old.state.thinking_level)
            if self._extensions_started:
                await old.extensions.emit("session_shutdown", {"type": "session_shutdown", "reason": "reload" if reload else "switch"},
                                          old.extension_context)
            if reload:
                candidate.agent.steering_queue = old.agent.steering_queue
                candidate.agent.follow_up_queue = old.agent.follow_up_queue
            self._install(
                target_cwd, path, settings, loader, resources, candidate, target_trusted
            )
        except BaseException:
            if candidate is not None and candidate is not self.agent_session:
                candidate.extensions.dispose()
            raise
        finally:
            self._changing = False

    async def switch_session(self, session_file: str | Path):
        target = Path(session_file).expanduser().resolve()
        if target == Path(self.session_file).expanduser().resolve():
            return
        await self._replace(session_file=session_file)

    async def change_cwd(self, cwd: str | Path, *, model: Model | None = None,
                         project_trusted: bool | None = None):
        """切换项目并新建会话；不把旧项目的消息自动带入新项目。"""
        target = Path(cwd).expanduser().resolve()
        if target == self.cwd and model is None and project_trusted is None:
            return
        await self._replace(cwd=cwd, model=model, project_trusted=project_trusted)

    async def new_session(self, *, model: Model | None = None):
        await self._replace(model=model or self.state.model)

    async def fork(self, from_id: str | None = None) -> Path:
        """Fork the selected history path into a new durable session and switch to it."""
        self._ensure_available()
        self.agent_session.ensure_idle()
        self._changing = True
        candidate = None
        try:
            old = self.agent_session
            forked = old.session.fork(from_id)
            settings, loader, resources = self._prepare(self.cwd, self.project_trusted)
            selected = self._model(None, forked, settings)
            path = self._session_layout(settings).new_session_file(self.cwd)
            candidate = self._build(
                self.cwd, forked, selected, settings, resources, self.project_trusted
            )
            if self._extensions_started:
                await old.extensions.emit(
                    "session_shutdown", {"type": "session_shutdown", "reason": "fork"},
                    old.extension_context,
                )
            self._persist_new(candidate, path)
            self._install(
                self.cwd, path, settings, loader, resources, candidate, self.project_trusted
            )
            return path
        except BaseException:
            if candidate is not None and candidate is not self.agent_session:
                candidate.extensions.dispose()
            raise
        finally:
            self._changing = False

    async def reload(self):
        """重读设置/资源并重建 cwd 绑定工具；保留当前模型、历史、队列。"""
        self._ensure_available()
        old_runtime = self.model_runtime
        candidate_runtime = ModelRuntime(self.user_dir, stream_fn=self._stream_fn)
        self.model_runtime = candidate_runtime
        try:
            await self._replace(reload=True)
        except BaseException:
            self.model_runtime = old_runtime
            raise

    async def set_project_trust(self, trusted: bool):
        """Rebuild cwd-bound services under a new trust decision."""
        await self._replace(reload=True, project_trusted=trusted)

    async def set_permission_mode(self, mode: str):
        """Apply a process-local permission override and rebuild the current session host."""
        if mode not in PERMISSION_MODES:
            raise ValueError(f"Permission must be one of: {', '.join(PERMISSION_MODES)}")
        previous = self._overrides.get("permission_mode")
        had_previous = "permission_mode" in self._overrides
        self._overrides["permission_mode"] = mode
        try:
            await self._replace(reload=True)
        except BaseException:
            if had_previous:
                self._overrides["permission_mode"] = previous
            else:
                self._overrides.pop("permission_mode", None)
            raise

    async def close(self):
        if self._closed:
            return
        self._ensure_available()
        self._changing = True
        try:
            self.abort()
            await self.agent_session.wait_for_idle()
            try:
                # Direct SDK users may append a user message before calling
                # continue_().  Persist meaningful transcripts on close, while
                # still discarding untouched UI drafts and setting-only entries.
                if any(entry.type == "message" for entry in self.session.get_entries()):
                    self._persist_new(self.agent_session, self.session_file)
                if self._extensions_started:
                    await self.agent_session.extensions.emit("session_shutdown", {"type": "session_shutdown", "reason": "close"},
                                                       self.agent_session.extension_context)
            finally:
                self.agent_session.extensions.dispose()
                self._unsubscribe()
                self._closed = True
        finally:
            self._changing = False
