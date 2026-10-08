"""Production configuration control-plane used by the desktop host.

The renderer never reads or writes ``~/.foxcode`` directly.  This module keeps
that boundary small: validate user input with the same domain models used by
the runtime, write atomically, and only expose redacted credential metadata.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Literal

from fox_ai.src import ApiKeyCredential
from fox_coding_agent.src.core._io import atomic_write_json, atomic_write_text
from fox_coding_agent.src.core.credentials import CredentialStore
from fox_coding_agent.src.core.model_config import ModelConfig
from fox_coding_agent.src.core.paths import ProjectPaths, UserPaths
from fox_coding_agent.src.core.settings import SettingsManager
from fox_coding_agent.src.extensions.mcp.config import load_mcp_config
from fox_coding_agent.src.extensions.subagent.discovery import discover_subagents
from fox_coding_agent.src.extensions.subagent.models import SubAgentDefinition


Scope = Literal["user", "project"]
_SAFE_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$")
_MCP_EXTENSION = "module:fox_coding_agent.src.extensions.mcp:setup"
_SUBAGENT_EXTENSION = "module:fox_coding_agent.src.extensions.subagent:setup"


def _read_object(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise ValueError(f"无法读取配置 {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"配置必须是 JSON 对象：{path}")
    return value


class ConfigurationService:
    """Validated mutations and redacted snapshots for desktop settings."""

    def __init__(self, *, user_dir: str | Path, cwd: str | Path, project_trusted: bool) -> None:
        self.user_paths = UserPaths.from_root(user_dir)
        self.project_paths = ProjectPaths.from_root(cwd)
        self.cwd = Path(cwd).expanduser().resolve()
        self.project_trusted = project_trusted

    def _scope_path(self, scope: Scope, kind: str) -> Path:
        if scope == "project" and not self.project_trusted:
            raise PermissionError("项目未受信任，不能修改项目级配置")
        paths = self.user_paths if scope == "user" else self.project_paths
        return Path(getattr(paths, kind))

    def snapshot(self) -> dict[str, Any]:
        settings = SettingsManager(
            self.cwd, user_dir=self.user_paths.root, project_trusted=self.project_trusted
        )
        models = ModelConfig(self.user_paths.root)
        credentials = CredentialStore(self.user_paths.root)
        configured_credentials = set(credentials.list())
        providers: list[dict[str, Any]] = []
        for provider_id, provider in models.snapshot.providers.items():
            providers.append({
                "id": provider_id,
                "baseUrl": provider.base_url,
                "api": provider.api,
                "models": provider.models,
                "credentialConfigured": provider_id in configured_credentials,
            })

        mcp = load_mcp_config(
            self.user_paths.root, self.cwd, project_trusted=self.project_trusted
        )
        mcp_servers = [{
            "name": item.name,
            "command": item.command,
            "args": list(item.args),
            "cwd": str(item.cwd) if item.cwd else None,
            "timeout": item.timeout,
            "enabled": item.enabled,
            "permission": item.permission,
            "protocolVersion": item.protocol_version,
            "scope": "project" if item.source == str(self.project_paths.mcp) else "user",
            # Environment values are deliberately never returned to the renderer.
            "envKeys": sorted(item.env),
        } for item in mcp.servers.values()]

        agents = discover_subagents(
            self.user_paths.root, self.cwd, project_trusted=self.project_trusted
        )
        subagents: list[dict[str, Any]] = []
        for item in agents.definitions.values():
            source = item.source
            if source == "built-in":
                scope = "builtin"
            elif str(self.project_paths.agents) in source:
                scope = "project"
            else:
                scope = "user"
            subagents.append({
                "name": item.name,
                "description": item.description,
                "systemPrompt": item.system_prompt if scope != "builtin" else "",
                "allowedTools": list(item.allowed_tools) if item.allowed_tools is not None else None,
                "scope": scope,
                "source": source,
                "editable": scope != "builtin",
            })

        diagnostics = [
            {"area": "mcp", "code": item.code, "message": item.message, "path": item.path}
            for item in mcp.diagnostics
        ] + [
            {"area": "subagent", "code": item.code, "message": item.message, "path": item.path}
            for item in agents.diagnostics
        ]
        return {
            "runtime": settings.settings.model_dump(mode="json"),
            "providers": providers,
            "mcpServers": sorted(mcp_servers, key=lambda item: item["name"]),
            "subagents": sorted(subagents, key=lambda item: (item["scope"] != "builtin", item["name"])),
            "diagnostics": diagnostics,
            "projectTrusted": self.project_trusted,
        }

    def update_runtime(self, values: Any, *, scope: Scope) -> None:
        if not isinstance(values, dict):
            raise ValueError("values 必须是对象")
        allowed = {
            "model", "permission_mode", "interaction_mode", "execution_mode", "max_turns",
            "model_retry_attempts", "tool_execution", "stream_options", "compaction",
        }
        unknown = set(values) - allowed
        if unknown:
            raise ValueError(f"桌面设置不支持这些字段：{sorted(unknown)}")
        SettingsManager(
            self.cwd, user_dir=self.user_paths.root, project_trusted=self.project_trusted
        ).update(values, scope=scope)

    def save_provider(self, payload: Any) -> None:
        if not isinstance(payload, dict):
            raise ValueError("provider 必须是对象")
        provider_id = str(payload.get("id") or "").strip()
        if not _SAFE_ID.fullmatch(provider_id):
            raise ValueError("供应商 ID 只能包含字母、数字、点、下划线或连字符")
        base_url = str(payload.get("baseUrl") or "").strip()
        api = str(payload.get("api") or "").strip()
        models = payload.get("models")
        if not base_url or not api or not isinstance(models, list) or not models:
            raise ValueError("baseUrl、api 与至少一个模型为必填项")
        path = self.user_paths.models
        data = _read_object(path)
        providers = data.setdefault("providers", {})
        if not isinstance(providers, dict):
            raise ValueError("models.json 的 providers 必须是对象")
        providers[provider_id] = {"baseUrl": base_url, "api": api, "models": models}
        # The loader and settings editor share exactly the same validation.
        ModelConfig.parse(data, source=path)
        atomic_write_json(path, data, mode=0o600)

    def delete_provider(self, provider_id: str) -> None:
        data = _read_object(self.user_paths.models)
        providers = data.get("providers", {})
        if isinstance(providers, dict):
            providers.pop(provider_id, None)
        atomic_write_json(self.user_paths.models, data, mode=0o600)
        CredentialStore(self.user_paths.root).delete(provider_id)

    def set_credential(self, provider_id: str, api_key: str) -> None:
        if not _SAFE_ID.fullmatch(provider_id):
            raise ValueError("无效的供应商 ID")
        key = api_key.strip()
        if not key:
            raise ValueError("API Key 不能为空")
        CredentialStore(self.user_paths.root).write(provider_id, ApiKeyCredential(key=key))

    def delete_credential(self, provider_id: str) -> None:
        CredentialStore(self.user_paths.root).delete(provider_id)

    def _ensure_extension(self, spec: str, *, preferred_scope: Scope) -> None:
        manager = SettingsManager(
            self.cwd, user_dir=self.user_paths.root, project_trusted=self.project_trusted
        )
        project_data = _read_object(manager.project_path) if self.project_trusted else {}
        # A project-level extensions key replaces (rather than merges with) the
        # user list.  Update that effective list so "save and enable" is true.
        target: Scope = (
            "project" if preferred_scope == "project" or "extensions" in project_data else "user"
        )
        path = manager.project_path if target == "project" else manager.user_path
        extensions = list(_read_object(path).get("extensions", []))
        if spec not in extensions:
            extensions.append(spec)
            manager.update({"extensions": extensions}, scope=target)

    def save_mcp(self, payload: Any, *, scope: Scope) -> None:
        if not isinstance(payload, dict):
            raise ValueError("server 必须是对象")
        name = str(payload.get("name") or "").strip()
        path = self._scope_path(scope, "mcp")
        data = _read_object(path)
        wrapped = "mcpServers" in data
        servers = data.setdefault("mcpServers", {}) if wrapped else data
        if not isinstance(servers, dict):
            raise ValueError("mcpServers 必须是对象")
        previous = servers.get(name)
        raw = {
            "command": str(payload.get("command") or "").strip(),
            "args": payload.get("args", []),
            "timeout": payload.get("timeout", 30),
            "enabled": bool(payload.get("enabled", True)),
            "permission": payload.get("permission", "full-access"),
            "protocolVersion": payload.get("protocolVersion", "auto"),
        }
        if payload.get("cwd"):
            raw["cwd"] = str(payload["cwd"])
        if payload.get("env") is not None:
            if not isinstance(payload["env"], dict):
                raise ValueError("env 必须是对象")
            raw["env"] = payload["env"]
        elif isinstance(previous, dict) and isinstance(previous.get("env"), dict):
            # The renderer only receives environment variable names, never values.
            # Editing another field must therefore preserve the redacted secrets.
            raw["env"] = previous["env"]
        servers[name] = raw
        # Validate the edited scope in isolation before making it visible.
        from fox_coding_agent.src.extensions.mcp.config import _parse_server
        _parse_server(name, raw, path)
        atomic_write_json(path, data, mode=0o600)
        self._ensure_extension(_MCP_EXTENSION, preferred_scope=scope)

    def delete_mcp(self, name: str, *, scope: Scope) -> None:
        path = self._scope_path(scope, "mcp")
        data = _read_object(path)
        servers = data.get("mcpServers") if "mcpServers" in data else data
        if isinstance(servers, dict):
            servers.pop(name, None)
        atomic_write_json(path, data, mode=0o600)

    def save_subagent(self, payload: Any, *, scope: Scope) -> None:
        if not isinstance(payload, dict):
            raise ValueError("subagent 必须是对象")
        name = str(payload.get("name") or "").strip()
        description = str(payload.get("description") or "").strip()
        prompt = str(payload.get("systemPrompt") or "").strip()
        tools = payload.get("allowedTools")
        if tools is not None and not isinstance(tools, list):
            raise ValueError("allowedTools 必须是字符串数组或 null")
        definition = SubAgentDefinition(
            name=name, description=description, system_prompt=prompt,
            allowed_tools=tuple(tools) if tools is not None else None,
        )
        directory = self._scope_path(scope, "agents")
        tool_line = "" if definition.allowed_tools is None else (
            f"allowed-tools: {', '.join(definition.allowed_tools)}\n"
        )
        text = (
            "---\n"
            f"name: {definition.name}\n"
            f"description: {definition.description}\n"
            f"{tool_line}"
            "---\n\n"
            f"{definition.system_prompt.rstrip()}\n"
        )
        atomic_write_text(directory / f"{definition.name}.md", text)
        self._ensure_extension(_SUBAGENT_EXTENSION, preferred_scope=scope)

    def delete_subagent(self, name: str, *, scope: Scope) -> None:
        if not _SAFE_ID.fullmatch(name):
            raise ValueError("无效的 Subagent 名称")
        directory = self._scope_path(scope, "agents").resolve()
        path = (directory / f"{name}.md").resolve()
        if path.parent != directory:
            raise ValueError("无效的 Subagent 路径")
        path.unlink(missing_ok=True)


__all__ = ["ConfigurationService"]
