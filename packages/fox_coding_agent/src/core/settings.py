"""用户/项目配置：深度合并、校验、原子保存。无模型请求或终端依赖。"""

from __future__ import annotations

import copy
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from fox_agent_core.src.harness import CompactionSettings


def merge_settings(base: dict, override: dict) -> dict:
    """对象递归合并；列表与标量整体替换，不修改输入。"""
    result = copy.deepcopy(base)
    for key, value in override.items():
        result[key] = (merge_settings(result[key], value)
                       if isinstance(result.get(key), dict) and isinstance(value, dict)
                       else copy.deepcopy(value))
    return result


class RuntimeSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The model is a models.json reference such as "deepseek/deepseek-chat".
    model: str | None = None
    system_prompt: str | None = None
    append_system_prompt: str = ""
    api_key_env: str | None = None
    stream_options: dict[str, Any] = Field(default_factory=dict)
    compaction: CompactionSettings = Field(default_factory=CompactionSettings)
    tools: list[str] | None = None
    extensions: list[str] = Field(default_factory=list)
    memory: bool = False
    permission_mode: Literal["read-only", "workspace-write", "full-access"] = "full-access"
    max_turns: int = Field(default=100, gt=0)
    model_retry_attempts: int = Field(default=1, ge=0, le=5)
    tool_execution: Literal["parallel", "sequential"] = "parallel"
    session_scope: Literal["project", "user"] = "project"


class SettingsManager:
    """优先级：默认值 < ~/.foxcode/settings.json < cwd/.foxcode/settings.json < overrides。

    user_dir 指 .foxcode 本身。写入采用单写入者原子替换，不提供跨进程锁。
    模型目录放在用户级 models.json，密钥放在 auth.json；这里保留可选的运行策略覆盖。
    """

    def __init__(self, cwd: str | Path = ".", *, user_dir: str | Path | None = None,
                 overrides: dict | None = None, project_trusted: bool = True):
        self.cwd = Path(cwd).expanduser().resolve()
        self.user_dir = Path(user_dir).expanduser().resolve() if user_dir else Path.home() / ".foxcode"
        self.user_path = self.user_dir / "settings.json"
        self.project_path = self.cwd / ".foxcode" / "settings.json"
        self.overrides = copy.deepcopy(overrides or {})
        self.project_trusted = project_trusted
        self.reload()

    @staticmethod
    def _read(path: Path) -> dict:
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            raise ValueError(f"Cannot read settings: {path}: {exc}") from exc
        if not isinstance(data, dict):
            raise ValueError(f"Settings must be a JSON object: {path}")
        if isinstance(data.get("extensions"), list):
            data["extensions"] = [str((path.parent / Path(item).expanduser()).resolve())
                                  if isinstance(item, str) else item for item in data["extensions"]]
        return data

    def _validate(self, user: dict, project: dict) -> RuntimeSettings:
        if any("api_key" in layer or "apiKey" in layer for layer in (user, project, self.overrides)):
            raise ValueError(f"Store API keys in {self.user_dir / 'auth.json'}, not settings.json")
        for layer in (user, project, self.overrides):
            unknown = set(layer) - RuntimeSettings.model_fields.keys()
            if unknown:
                raise ValueError(f"Unknown settings: {sorted(unknown)}")
        return RuntimeSettings.model_validate(merge_settings(merge_settings(user, project), self.overrides))

    def reload(self) -> RuntimeSettings:
        user = self._read(self.user_path)
        project = self._read(self.project_path) if self.project_trusted else {}
        settings = self._validate(user, project)
        self.settings = settings
        return settings

    def update(self, values: dict, *, scope: Literal["user", "project"] = "project") -> RuntimeSettings:
        if scope not in ("user", "project"):
            raise ValueError("scope must be 'user' or 'project'")
        user = self._read(self.user_path)
        project = self._read(self.project_path) if self.project_trusted else {}
        if scope == "project" and not self.project_trusted:
            raise PermissionError("Project settings cannot be changed before the project is trusted")
        target = self.user_path if scope == "user" else self.project_path
        updated = merge_settings(user if scope == "user" else project, values)
        candidate = self._validate(updated if scope == "user" else user,
                                   updated if scope == "project" else project)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent,
                                             prefix=".settings-", suffix=".tmp", delete=False) as f:
                temporary = Path(f.name)
                json.dump(updated, f, ensure_ascii=False, indent=2)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(temporary, target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        self.settings = candidate
        return candidate
