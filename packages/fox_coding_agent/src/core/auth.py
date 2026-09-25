"""User-level provider credentials and model catalog.

``auth.json`` is deliberately separate from project settings.  It contains API
keys and is read only from ``~/.foxcode`` (or an explicitly supplied user_dir).
Neither Session nor JSONL history stores credentials.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError

from fox_ai.src import Model


class AuthProvider(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, hide_input_in_errors=True)

    base_url: str = Field(alias="baseUrl")
    api: str
    api_key: SecretStr = Field(alias="apiKey", repr=False)
    models: list[dict[str, Any]] = Field(default_factory=list)


class AuthFile(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    providers: dict[str, AuthProvider] = Field(default_factory=dict)


@dataclass(frozen=True)
class AuthenticatedModel:
    """Public catalog entry; credentials remain inside AuthStore."""
    reference: str
    model: Model


class AuthStore:
    """Load models and keys from one trusted, user-owned auth.json file."""

    def __init__(self, user_dir: str | Path):
        self.user_dir = Path(user_dir).expanduser().resolve()
        self.path = self.user_dir / "auth.json"
        self._models: list[AuthenticatedModel] = []
        self._providers: dict[str, AuthProvider] = {}
        self.reload()

    def reload(self) -> None:
        if not self.path.exists():
            self._models = []
            self._providers = {}
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            raise ValueError(f"Cannot read auth config: {self.path}: {exc}") from exc
        try:
            config = AuthFile.model_validate(data)
        except ValidationError as exc:
            locations = [".".join(map(str, e["loc"])) for e in exc.errors(include_input=False)]
            raise ValueError(f"Invalid auth config in {self.path}: {', '.join(locations)}") from None
        models: list[AuthenticatedModel] = []
        for provider_id, provider in config.providers.items():
            url = urlsplit(provider.base_url)
            if url.scheme not in {"http", "https"} or not url.netloc or url.username or url.password:
                raise ValueError(f"Invalid baseUrl in {self.path} for provider {provider_id}")
            for item in provider.models:
                raw = dict(item)
                compat = dict(raw.get("compat") or {})
                # Accept the supplied compatibility format as well as pi's
                # first-class thinkingLevelMap; fox_ai consumes the latter.
                effort_map = raw.get("thinkingLevelMap", compat.get("reasoningEffortMap"))
                compat.setdefault("supportsStrictMode", False)
                raw.update({
                    "provider": provider_id,
                    "api": provider.api,
                    "baseUrl": provider.base_url,
                    "compat": compat,
                })
                if effort_map is not None:
                    raw["thinkingLevelMap"] = effort_map
                try:
                    model = Model.model_validate(raw)
                except ValidationError:
                    raise ValueError(f"Invalid model metadata in {self.path} for provider {provider_id}") from None
                if model.context_window <= 0 or model.max_tokens <= 0:
                    raise ValueError(f"Model token limits must be positive: {provider_id}/{model.id}")
                models.append(AuthenticatedModel(f"{provider_id}/{model.id}", model))
        if len({e.reference.lower() for e in models}) != len(models):
            raise ValueError(f"Duplicate model reference in {self.path}")
        self._models = models
        self._providers = config.providers

    @property
    def models(self) -> tuple[AuthenticatedModel, ...]:
        return tuple(self._models)

    def default(self) -> AuthenticatedModel | None:
        return self._models[0] if self._models else None

    def resolve(self, reference: str) -> AuthenticatedModel:
        normalized = reference.strip().lower()
        if not normalized:
            raise ValueError("Model reference must not be empty")
        exact = [entry for entry in self._models if entry.reference.lower() == normalized]
        if len(exact) == 1:
            return exact[0]
        matches = [entry for entry in self._models
                   if entry.model.id.lower() == normalized or entry.model.name.lower() == normalized]
        if len(matches) == 1:
            return matches[0]
        choices = ", ".join(entry.reference for entry in self._models) or "(auth.json has no models)"
        raise ValueError(f"Unknown or ambiguous model {reference!r}. Available: {choices}")

    def for_model(self, model: Model) -> AuthenticatedModel | None:
        matches = [entry for entry in self._models
                   if entry.model.provider == model.provider and entry.model.id == model.id]
        return matches[0] if len(matches) == 1 else None

    def key_for_model(self, model: Model) -> str | None:
        """Resolve by provider and endpoint, including older saved model IDs."""
        provider = self._providers.get(model.provider)
        if provider and provider.api == model.api and provider.base_url.rstrip("/") == model.base_url.rstrip("/"):
            return provider.api_key.get_secret_value() or None
        return None
