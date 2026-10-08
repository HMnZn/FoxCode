"""Credential-blind ``models.json`` loading and validation."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from fox_ai.src import Model
from .paths import UserPaths


class ProviderDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, hide_input_in_errors=True)

    base_url: str = Field(alias="baseUrl")
    api: str
    models: list[dict[str, Any]] = Field(default_factory=list)


class ModelsFile(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    providers: dict[str, ProviderDefinition] = Field(default_factory=dict)


@dataclass(frozen=True)
class ConfiguredModel:
    reference: str
    model: Model


@dataclass(frozen=True)
class ModelConfigSnapshot:
    models: tuple[ConfiguredModel, ...]
    providers: dict[str, ProviderDefinition]
    source: Path | None


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"Cannot read model config: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"Invalid model config in {path}: expected an object")
    return value


def _normalize_model(provider_id: str, provider: ProviderDefinition, item: dict[str, Any]) -> Model:
    raw = dict(item)
    raw.setdefault("name", raw.get("id"))
    compat = dict(raw.get("compat") or {})
    if "reasoningEffortMap" in compat:
        raise ValueError(
            f"Use thinkingLevelMap instead of compat.reasoningEffortMap: {provider_id}/{raw.get('id')}"
        )
    compat.setdefault("supportsStrictMode", False)
    raw.update({
        "provider": provider_id,
        "api": provider.api,
        "baseUrl": provider.base_url,
        "compat": compat,
    })
    try:
        model = Model.model_validate(raw)
    except ValidationError:
        raise ValueError(f"Invalid model metadata for provider {provider_id}") from None
    if model.context_window <= 0 or model.max_tokens <= 0:
        raise ValueError(f"Model token limits must be positive: {provider_id}/{model.id}")
    return model


class ModelConfig:
    """Load the model catalog from the single canonical models.json schema."""

    def __init__(self, user_dir: str | Path) -> None:
        paths = UserPaths.from_root(user_dir)
        self.user_dir, self.path = paths.root, paths.models
        self.snapshot = ModelConfigSnapshot((), {}, None)
        self.reload()

    def reload(self) -> ModelConfigSnapshot:
        source: Path | None = self.path if self.path.exists() else None
        if source is None:
            self.snapshot = ModelConfigSnapshot((), {}, None)
            return self.snapshot
        self.snapshot = self.parse(_read_json(source), source=source)
        return self.snapshot

    @staticmethod
    def parse(data: dict[str, Any], *, source: Path | None = None) -> ModelConfigSnapshot:
        """Validate a complete catalog in memory before publishing or loading it."""
        try:
            config = ModelsFile.model_validate(data)
        except ValidationError as exc:
            locations = [".".join(map(str, e["loc"])) for e in exc.errors(include_input=False)]
            raise ValueError(f"Invalid model config in {source}: {', '.join(locations)}") from None
        models: list[ConfiguredModel] = []
        for provider_id, provider in config.providers.items():
            url = urlsplit(provider.base_url)
            if url.scheme not in {"http", "https"} or not url.netloc or url.username or url.password:
                raise ValueError(f"Invalid baseUrl in {source} for provider {provider_id}")
            for item in provider.models:
                model = _normalize_model(provider_id, provider, item)
                models.append(ConfiguredModel(f"{provider_id}/{model.id}", model))
        if len({entry.reference.lower() for entry in models}) != len(models):
            raise ValueError(f"Duplicate model reference in {source}")
        return ModelConfigSnapshot(tuple(models), config.providers, source)


__all__ = [
    "ProviderDefinition",
    "ConfiguredModel",
    "ModelConfigSnapshot",
    "ModelConfig",
]
