"""First-class execution sandbox policy and native shell adapters."""

from __future__ import annotations

import os
import platform
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal


ExecutionMode = Literal["local", "sandbox"]
EXECUTION_MODES: tuple[ExecutionMode, ...] = ("local", "sandbox")


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def resolve_workspace_path(value: str, cwd: str | Path) -> Path:
    root = Path(cwd).expanduser().resolve()
    candidate = Path(value).expanduser()
    return (root / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()


@dataclass(frozen=True)
class SandboxCapability:
    backend: str
    shell: bool
    network_isolated: bool
    detail: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "backend": self.backend, "shell": self.shell,
            "networkIsolated": self.network_isolated, "detail": self.detail,
        }


def detect_sandbox() -> SandboxCapability:
    system = platform.system().lower()
    if system == "linux":
        binary = shutil.which("bwrap")
        if binary:
            return SandboxCapability("bubblewrap", True, True, binary)
        return SandboxCapability(
            "file-policy", False, False,
            "Bubblewrap (bwrap) is not installed; file tools remain confined and shell is disabled.",
        )
    if system == "darwin":
        binary = shutil.which("sandbox-exec")
        if binary:
            return SandboxCapability("sandbox-exec", True, True, binary)
        return SandboxCapability(
            "file-policy", False, False,
            "sandbox-exec is unavailable; file tools remain confined and shell is disabled.",
        )
    return SandboxCapability(
        "file-policy", False, False,
        "This platform has no configured process sandbox; file tools remain confined and shell is disabled.",
    )


def sandbox_shell_command(command: list[str], cwd: str | Path) -> list[str]:
    """Wrap a shell argv in the strongest native backend available."""

    root = Path(cwd).expanduser().resolve()
    capability = detect_sandbox()
    if capability.backend == "bubblewrap":
        return [
            capability.detail, "--die-with-parent", "--new-session", "--unshare-net",
            "--ro-bind", "/", "/", "--bind", str(root), str(root),
            "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
            "--chdir", str(root), "--", *command,
        ]
    if capability.backend == "sandbox-exec":
        escaped = str(root).replace('"', '\\"')
        profile = (
            '(version 1)(deny default)(allow process*)(allow file-read*)'
            f'(allow file-write* (subpath "{escaped}"))'
            '(allow file-write-data (literal "/dev/null"))'
            '(deny network*)'
        )
        return [capability.detail, "-p", profile, *command]
    raise RuntimeError(f"Sandbox shell is unavailable: {capability.detail}")


def check_sandbox_tool(tool: object, args: Any, cwd: str | Path) -> str | None:
    """Return a hard block reason for calls that cannot be safely sandboxed."""

    if not getattr(tool, "sandbox_safe", False):
        return f"Tool '{getattr(tool, 'name', '?')}' does not declare sandbox support"
    if getattr(tool, "workspace_shell", False) and not detect_sandbox().shell:
        return detect_sandbox().detail
    if not isinstance(args, dict):
        return None
    root = Path(cwd).expanduser().resolve()
    for field in tuple(getattr(tool, "permission_paths", ())):
        raw = args.get(field)
        values = [raw] if isinstance(raw, str) else raw if isinstance(raw, list) else []
        for value in values:
            if isinstance(value, str) and not _inside(resolve_workspace_path(value, root), root):
                return f"Sandbox blocks access outside the project: {value}"
    return None


__all__ = [
    "EXECUTION_MODES", "ExecutionMode", "SandboxCapability", "check_sandbox_tool",
    "detect_sandbox", "resolve_workspace_path", "sandbox_shell_command",
]
