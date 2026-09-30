"""MCP server configuration loading and validation."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, replace
from pathlib import Path
from ...core.paths import ProjectPaths, UserPaths


_SERVER_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


@dataclass(frozen=True)
class McpServerConfig:
    name: str
    command: str
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    cwd: Path | None = None
    timeout: float = 30.0
    enabled: bool = True
    permission: str = "full-access"
    protocol_version: str = "auto"
    source: str = ""

    def __post_init__(self) -> None:
        if not _SERVER_RE.fullmatch(self.name):
            raise ValueError("server name must contain only letters, digits, underscores, or hyphens")
        if not self.command.strip():
            raise ValueError("command must be a nonempty string")
        if not all(isinstance(value, str) for value in self.args):
            raise ValueError("args must contain only strings")
        if not all(isinstance(key, str) and isinstance(value, str)
                   for key, value in self.env.items()):
            raise ValueError("env must map strings to strings")
        if isinstance(self.timeout, bool) or not isinstance(self.timeout, (int, float)):
            raise ValueError("timeout must be a number")
        if not 0.1 <= self.timeout <= 600:
            raise ValueError("timeout must be between 0.1 and 600 seconds")
        if not isinstance(self.enabled, bool):
            raise ValueError("enabled must be a boolean")
        if self.permission not in {"read-only", "full-access"}:
            raise ValueError("permission must be read-only or full-access")
        if self.protocol_version not in {"auto", "2025-11-25", "2026-07-28"}:
            raise ValueError("protocolVersion must be auto, 2025-11-25, or 2026-07-28")


@dataclass(frozen=True)
class McpConfigDiagnostic:
    code: str
    message: str
    path: str


@dataclass
class McpConfigResult:
    servers: dict[str, McpServerConfig] = field(default_factory=dict)
    diagnostics: list[McpConfigDiagnostic] = field(default_factory=list)


def _parse_server(name: str, raw: object, path: Path) -> McpServerConfig:
    if not isinstance(raw, dict):
        raise ValueError("server configuration must be an object")
    known = {
        "command", "args", "env", "cwd", "timeout", "enabled", "permission",
        "protocolVersion",
    }
    unknown = set(raw) - known
    if unknown:
        raise ValueError(f"unknown fields: {sorted(unknown)}")
    command = raw.get("command")
    args = raw.get("args", [])
    env = raw.get("env", {})
    cwd = raw.get("cwd")
    if not isinstance(command, str):
        raise ValueError("command must be a string")
    if not isinstance(args, list):
        raise ValueError("args must be an array")
    if not isinstance(env, dict):
        raise ValueError("env must be an object")
    if cwd is not None and not isinstance(cwd, str):
        raise ValueError("cwd must be a string")
    if not isinstance(raw.get("enabled", True), bool):
        raise ValueError("enabled must be a boolean")
    if (isinstance(raw.get("timeout", 30.0), bool)
            or not isinstance(raw.get("timeout", 30.0), (int, float))):
        raise ValueError("timeout must be a number")
    resolved_cwd = None
    if cwd:
        candidate = Path(cwd).expanduser()
        resolved_cwd = (path.parent / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
    return McpServerConfig(
        name=name,
        command=command,
        args=tuple(args),
        env=dict(env),
        cwd=resolved_cwd,
        timeout=float(raw.get("timeout", 30.0)),
        enabled=raw.get("enabled", True),
        permission=raw.get("permission", "full-access"),
        protocol_version=raw.get("protocolVersion", "auto"),
        source=str(path),
    )


def _merge_file(path: Path, result: McpConfigResult) -> None:
    if not path.is_file():
        return
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(raw, dict):
            raise ValueError("configuration root must be an object")
        servers = raw.get("mcpServers", raw)
        if not isinstance(servers, dict):
            raise ValueError("mcpServers must be an object")
    except (OSError, UnicodeError, ValueError) as exc:
        result.diagnostics.append(McpConfigDiagnostic("config_invalid", str(exc), str(path)))
        return
    for name, value in servers.items():
        try:
            if not isinstance(name, str):
                raise ValueError("server name must be a string")
            config = _parse_server(name, value, path)
            if config.enabled:
                result.servers[name] = config
            else:
                result.servers.pop(name, None)
        except (TypeError, ValueError) as exc:
            result.diagnostics.append(
                McpConfigDiagnostic("server_invalid", f"{name}: {exc}", str(path))
            )


def load_mcp_config(
    user_dir: str | Path,
    cwd: str | Path,
    *,
    project_trusted: bool,
) -> McpConfigResult:
    """Merge user configuration and trusted-project overrides.

    A server that does not declare ``cwd`` runs in the active project directory,
    so relative side effects (screenshots, downloads, logs) land inside the
    project instead of the process working directory or the user home.
    """
    result = McpConfigResult()
    user_paths = UserPaths.from_root(user_dir)
    project_paths = ProjectPaths.from_root(cwd)
    _merge_file(user_paths.mcp, result)
    if project_trusted:
        _merge_file(project_paths.mcp, result)
    project = Path(cwd).expanduser().resolve()
    for name, server in result.servers.items():
        if server.cwd is None:
            result.servers[name] = replace(server, cwd=project)
    return result


__all__ = [
    "McpConfigDiagnostic", "McpConfigResult", "McpServerConfig", "load_mcp_config",
]
