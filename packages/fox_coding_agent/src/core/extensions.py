"""Small explicit Python extension API: tools, commands, prompt rules and event hooks.

Extensions are trusted Python code loaded from explicitly configured paths. No UI dependency.
Each runtime build gets a new runner/module namespace, so reload doesn't duplicate handlers.
"""

from __future__ import annotations

import contextlib
import inspect
import re
import sys
import types
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4

from fox_agent_core.src._async import maybe_await

RESERVED_COMMANDS = {"help", "exit", "quit", "new", "resume", "cwd", "reload", "compact", "tools", "model", "thinking", "skill", "prompt", "trust", "untrust", "export", "usage"}


@dataclass(frozen=True)
class ExtensionContext:
    cwd: Path
    agent_session: object
    services: dict[str, object] = field(default_factory=dict)

    @property
    def session(self):
        return self.agent_session.session

    def service(self, name: str):
        if name not in self.services:
            raise KeyError(f"Extension service is not registered: {name}")
        return self.services[name]


@dataclass
class ExtensionAPI:
    tools: list = field(default_factory=list)
    commands: dict = field(default_factory=dict)
    handlers: dict = field(default_factory=dict)
    guidelines: list[str] = field(default_factory=list)
    services: dict[str, object] = field(default_factory=dict)
    context_transforms: list[tuple[str, object]] = field(default_factory=list)

    def register_tool(self, tool):
        if not callable(getattr(tool, "execute", None)) or not getattr(tool, "name", None):
            raise TypeError("Extension tools must implement AgentTool")
        if any(t.name == tool.name for t in self.tools):
            raise ValueError(f"Duplicate extension tool: {tool.name}")
        self.tools.append(tool)

    def register_command(self, name, handler, description=""):
        if not re.fullmatch(r"[a-z][a-z0-9_-]*", name) or name in RESERVED_COMMANDS or name in self.commands:
            raise ValueError(f"Invalid, duplicate or reserved command: {name}")
        if not callable(handler):
            raise TypeError("Command handler must be callable")
        self.commands[name] = (handler, description)

    def on(self, event, handler):
        if not isinstance(event, str) or not callable(handler):
            raise TypeError("on(event, handler) requires a string and callable")
        self.handlers.setdefault(event, []).append(handler)

    def add_prompt_guideline(self, text):
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Prompt guideline must be a nonempty string")
        self.guidelines.append(text)

    def register_service(self, name: str, service: object):
        """Publish a process-local capability for cooperating extensions.

        Services are application objects, not LLM tools. An MCP connection
        manager, memory index or skill-candidate store can live here while
        exposing only selected operations as tools and event hooks.
        """
        if not re.fullmatch(r"[a-z][a-z0-9_.-]*", name) or name in self.services:
            raise ValueError(f"Invalid or duplicate extension service: {name}")
        self.services[name] = service

    def get_service(self, name: str, default=None):
        return self.services.get(name, default)

    def register_context_transform(self, name: str, transform):
        """Register a per-request, non-persistent LLM context transform."""
        if (not re.fullmatch(r"[a-z][a-z0-9_.-]*", name)
                or any(existing == name for existing, _ in self.context_transforms)):
            raise ValueError(f"Invalid or duplicate context transform: {name}")
        if not callable(transform):
            raise TypeError("Context transform must be callable")
        self.context_transforms.append((name, transform))


class ExtensionRunner:
    def __init__(self):
        self.api = ExtensionAPI()
        self._modules = []

    @classmethod
    def load(cls, paths=(), factories=()):
        runner = cls()
        try:
            for file in dict.fromkeys(Path(p).resolve() for p in paths):
                if file.suffix != ".py" or not file.is_file():
                    raise ValueError(f"Extension must be an existing Python file: {file}")
                name = f"_fox_extension_{uuid4().hex}"
                module = types.ModuleType(name)
                module.__file__ = str(file)
                sys.modules[name] = module
                runner._modules.append(name)
                # Compile source directly so a same-size edit within one second is still reloaded.
                with contextlib.redirect_stdout(sys.stderr):
                    exec(compile(file.read_text(encoding="utf-8-sig"), str(file), "exec"), module.__dict__)
                    runner._setup(getattr(module, "setup", None))
            for factory in factories:
                runner._setup(factory)
            return runner
        except BaseException:
            runner.dispose()
            raise

    def _setup(self, factory):
        if not callable(factory):
            raise TypeError("Extension must define setup(api)")
        result = factory(self.api)
        if inspect.isawaitable(result):
            if inspect.iscoroutine(result):
                result.close()
            raise TypeError("setup(api) must be synchronous; async work belongs in event handlers")

    async def emit(self, event, data, context):
        results = []
        for handler in [*self.api.handlers.get(event, []), *self.api.handlers.get("*", [])]:
            # Ordinary extension print statements go to stderr, keeping CLI JSON usable.
            with contextlib.redirect_stdout(sys.stderr):
                results.append(await maybe_await(handler(data, context)))
        return results

    async def before_tool(self, data, cancel, context):
        for result in await self.emit("tool_call", data, context):
            if result and result.get("block"):
                return result
        return None

    async def after_tool(self, data, cancel, context):
        update = {}
        for result in await self.emit("tool_result", data, context):
            if result:
                update.update(result)
        return update or None

    async def command(self, name, arguments, context):
        if name not in self.api.commands:
            raise ValueError(f"Unknown extension command: {name}")
        with contextlib.redirect_stdout(sys.stderr):
            return await maybe_await(self.api.commands[name][0](arguments, context))

    async def transform_context(self, messages, context):
        """Apply transforms to a request copy; Session history is untouched."""
        current = list(messages)
        for name, transform in self.api.context_transforms:
            with contextlib.redirect_stdout(sys.stderr):
                updated = await maybe_await(transform(list(current), context))
            if updated is not None:
                if not isinstance(updated, list):
                    raise TypeError(f"Context transform {name!r} must return a message list or None")
                current = updated
        return current

    def dispose(self):
        for name in self._modules:
            sys.modules.pop(name, None)
        self._modules.clear()
