"""Capability-based tool permission policy used by the runtime."""

from __future__ import annotations

from pathlib import Path
from typing import Literal


PermissionMode = Literal["read-only", "workspace-write", "full-access"]
PermissionDomain = Literal["runtime", "extension-state"]
ExtensionStateAction = Literal["read", "write", "delete", "admin"]
PERMISSION_MODES: tuple[PermissionMode, ...] = (
    "read-only", "workspace-write", "full-access",
)
PERMISSION_DOMAINS: tuple[PermissionDomain, ...] = ("runtime", "extension-state")
EXTENSION_STATE_ACTIONS: tuple[ExtensionStateAction, ...] = (
    "read", "write", "delete", "admin",
)
_LEVEL = {name: index for index, name in enumerate(PERMISSION_MODES)}


def check_tool_permission(tool, args: dict, cwd: str | Path,
                          mode: PermissionMode) -> str | None:
    """Return a blocking reason, or ``None`` when the call is allowed.

    Unknown extension tools require full access. Tools may declare the generic
    ``extension-state`` domain for state owned by an explicitly loaded extension;
    those operations are independent of workspace access modes. Project trust is
    still enforced by the runtime before this function is called.

    A runtime-domain tool that declares ``workspace-write`` must also declare
    every written path argument through ``permission_paths`` so resolved paths
    (including symlinks) can be checked.
    """
    if mode not in _LEVEL:
        return f"Invalid permission mode: {mode}"

    domain = getattr(tool, "permission_domain", "runtime")
    if domain not in PERMISSION_DOMAINS:
        return f"Tool '{tool.name}' declares an invalid permission domain: {domain}"
    if domain == "extension-state":
        action = getattr(tool, "permission_action", None)
        if action not in EXTENSION_STATE_ACTIONS:
            return f"Tool '{tool.name}' declares an invalid extension-state action: {action}"
        return None

    required = getattr(tool, "required_permission", "full-access")
    if required not in _LEVEL:
        return f"Tool '{tool.name}' declares an invalid permission requirement: {required}"
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


__all__ = [
    "EXTENSION_STATE_ACTIONS", "PERMISSION_DOMAINS", "PERMISSION_MODES",
    "ExtensionStateAction", "PermissionDomain", "PermissionMode",
    "check_tool_permission",
]
