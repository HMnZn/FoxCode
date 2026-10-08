"""Session tool registration, selection and effective capabilities."""

from __future__ import annotations

from typing import Any

from .interaction import EffectiveInteractionMode, is_plan_safe_tool
from .plan_tool import SubmitPlanTool
from .sandbox import ExecutionMode


class ToolRegistry:
    """Own registered tools and distinguish durable choices from runtime tools."""

    def __init__(self, tools: list[Any], *, runtime_names: tuple[str, ...] = ()) -> None:
        self._tools = {tool.name: tool for tool in tools}
        if len(self._tools) != len(tools):
            raise ValueError("Tool names must be unique")
        if set(runtime_names) - self._tools.keys():
            raise ValueError("Runtime tool names must refer to registered tools")
        self._default_runtime_names = runtime_names
        self._runtime_names = set(runtime_names)
        self.default_names = tuple(name for name in self._tools if name not in self._runtime_names)
        self._selected_names = list(self._tools)
        self._plan_tool = SubmitPlanTool()
        if self._plan_tool.name in self._tools:
            raise ValueError(f"Reserved tool name is already registered: {self._plan_tool.name}")
        self._tools[self._plan_tool.name] = self._plan_tool

    @property
    def selected_names(self) -> tuple[str, ...]:
        return tuple(self._selected_names)

    def get(self, name: str) -> Any:
        return self._tools.get(name)

    def validate_selection(self, names: list[str]) -> None:
        if self._plan_tool.name in names:
            raise ValueError(f"Tool '{self._plan_tool.name}' is managed by Plan mode and cannot be selected")
        missing = set(names) - self._tools.keys()
        if missing:
            raise ValueError(f"Tools required by the session are unavailable: {sorted(missing)}")
        if len(names) != len(set(names)):
            raise ValueError("Tool names must be unique")

    def select(self, names: list[str]) -> None:
        self.validate_selection(names)
        self._selected_names = list(names)

    def restore_selection(self, names: list[str]) -> None:
        """Restore durable choices and derive extension tools from this runtime."""
        selected = list(names)
        selected.extend(name for name in self._default_runtime_names if name not in selected)
        self.select(selected)

    def persisted_names(self, names: list[str]) -> list[str]:
        self.validate_selection(names)
        return [name for name in names if name not in self._runtime_names]

    def effective_tools(self, mode: EffectiveInteractionMode) -> list[Any]:
        tools = [self._tools[name] for name in self._selected_names]
        if mode == "plan":
            tools = [tool for tool in tools if is_plan_safe_tool(tool)]
            tools.append(self._plan_tool)
        return tools

    @staticmethod
    def _configure(tool: Any, mode: ExecutionMode) -> None:
        setter = getattr(tool, "set_execution_mode", None)
        if callable(setter):
            setter(mode)

    def configure_execution(self, mode: ExecutionMode) -> None:
        for tool in self._tools.values():
            self._configure(tool, mode)

    def add_runtime(
        self, tools: list[Any], *, activate: bool, execution_mode: ExecutionMode,
    ) -> None:
        additions = list(tools)
        for tool in additions:
            if not callable(getattr(tool, "execute", None)) or not getattr(tool, "name", None):
                raise TypeError("Runtime tools must implement AgentTool")
        names = [tool.name for tool in additions]
        if len(names) != len(set(names)):
            raise ValueError("Runtime tool names must be unique")
        collisions = set(names) & self._tools.keys()
        if collisions:
            raise ValueError(f"Runtime tools collide with available tools: {sorted(collisions)}")
        for tool in additions:
            self._configure(tool, execution_mode)
        self._tools.update(zip(names, additions))
        self._runtime_names.update(names)
        if activate:
            self._selected_names.extend(names)

    def fork_tools(self) -> list[Any]:
        return [tool for name, tool in self._tools.items() if name != self._plan_tool.name]
