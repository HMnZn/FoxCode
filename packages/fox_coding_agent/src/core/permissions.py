"""Capability-based tool permission policy used by the runtime."""

from __future__ import annotations

from pathlib import Path
from typing import Literal


PermissionMode = Literal["read-only", "workspace-write", "full-access"]
PERMISSION_MODES: tuple[PermissionMode, ...] = (
    "read-only", "workspace-write", "full-access",
)
_LEVEL = {name: index for index, name in enumerate(PERMISSION_MODES)}


def check_tool_permission(tool, args: dict, cwd: str | Path,
                          mode: PermissionMode) -> str | None:
    """Return a blocking reason, or ``None`` when the call is allowed.

    Unknown extension tools require full access. A tool that declares
    ``workspace-write`` must also declare every written path argument through
    ``permission_paths`` so resolved paths (including symlinks) can be checked.
    """
    required = getattr(tool, "required_permission", "full-access")
    if required not in _LEVEL:
        return f"Tool '{tool.name}' declares an invalid permission requirement: {required}"
    if mode not in _LEVEL:
        return f"Invalid permission mode: {mode}"
    if _LEVEL[mode] < _LEVEL[required]:
        return f"Tool '{tool.name}' requires {required} permission (current: {mode})"
    if mode != "workspace-write" or required != "workspace-write":
        return None

    root = Path(cwd).expanduser().resolve()
    path_fields = tuple(getattr(tool, "permission_paths", ()))
    if not path_fields:
        return f"Tool '{tool.name}' has no workspace path declaration; full-access is required"
    for field in path_fields:
        value = args.get(field)
        if not isinstance(value, str) or not value:
            return f"Tool '{tool.name}' has an invalid path argument: {field}"
        candidate = Path(value).expanduser()
        candidate = (root / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
        if not candidate.is_relative_to(root):
            return f"Tool '{tool.name}' cannot modify outside the workspace in workspace-write mode: {candidate}"
    return None


__all__ = ["PERMISSION_MODES", "PermissionMode", "check_tool_permission"]
