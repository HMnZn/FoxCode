"""Resolve models and request credentials for one coding-agent process."""

from __future__ import annotations

import os
from typing import Callable

from fox_ai.src import ApiKeyCredential, Model, OAuthCredential, SimpleStreamOptions, stream_simple

from .credentials import CredentialStore
from .model_config import ModelConfig
from .model_registry import ModelRegistry


_PROVIDER_KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "google": "GEMINI_API_KEY",
    "groq": "GROQ_API_KEY",
    "xai": "XAI_API_KEY",
}


class ModelRuntime:
    def __init__(self, user_dir, *, stream_fn=None) -> None:
        self.config = ModelConfig(user_dir)
        self.registry = ModelRegistry(self.config)
        self.credentials = CredentialStore(user_dir)
        self.stream_fn = stream_fn or stream_simple

    def reload(self) -> None:
        # Build complete candidates first so one malformed file cannot replace
        # the last usable in-memory snapshot.
        candidate_config = ModelConfig(self.config.user_dir)
        candidate_credentials = CredentialStore(self.config.user_dir)
        self.config = candidate_config
        self.registry = ModelRegistry(candidate_config)
        self.credentials = candidate_credentials

    def api_key_for(self, model: Model, *, explicit_env: str | None = None) -> str | None:
        if explicit_env:
            return os.environ.get(explicit_env, "") or None
        provider = self.config.snapshot.providers.get(model.provider)
        if provider is not None and (
            provider.api != model.api
            or provider.base_url.rstrip("/") != model.base_url.rstrip("/")
        ):
            return None
        credential = self.credentials.read(model.provider)
        if isinstance(credential, ApiKeyCredential) and credential.key:
            return credential.key
        if isinstance(credential, OAuthCredential):
            return credential.access
        env_name = _PROVIDER_KEY_ENV.get(model.provider)
        return os.environ.get(env_name, "") or None if env_name else None

    def authenticated_stream(self, *, api_key_env: str | None = None) -> Callable:
        def call(model, context, options=None):
            options = options or SimpleStreamOptions()
            key = options.api_key or self.api_key_for(model, explicit_env=api_key_env)
            if key:
                options = options.model_copy(update={"api_key": key})
            return self.stream_fn(model, context, options)
        return call


__all__ = ["ModelRuntime"]
