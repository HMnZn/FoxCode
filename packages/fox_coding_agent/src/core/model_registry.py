"""Model selection over a normalized ModelConfig snapshot."""

from __future__ import annotations

from fox_ai.src import Model

from .model_config import ConfiguredModel, ModelConfig


class ModelRegistry:
    def __init__(self, config: ModelConfig) -> None:
        self.config = config

    @property
    def models(self) -> tuple[ConfiguredModel, ...]:
        return self.config.snapshot.models

    def reload(self) -> None:
        self.config.reload()

    def default(self) -> ConfiguredModel | None:
        return self.models[0] if self.models else None

    def resolve(self, reference: str) -> ConfiguredModel:
        normalized = reference.strip().lower()
        if not normalized:
            raise ValueError("Model reference must not be empty")
        exact = [entry for entry in self.models if entry.reference.lower() == normalized]
        if len(exact) == 1:
            return exact[0]
        matches = [entry for entry in self.models
                   if entry.model.id.lower() == normalized or entry.model.name.lower() == normalized]
        if len(matches) == 1:
            return matches[0]
        choices = ", ".join(entry.reference for entry in self.models) or "(models.json has no models)"
        raise ValueError(f"Unknown or ambiguous model {reference!r}. Available: {choices}")

    def for_model(self, model: Model) -> ConfiguredModel | None:
        matches = [entry for entry in self.models
                   if entry.model.provider == model.provider and entry.model.id == model.id]
        return matches[0] if len(matches) == 1 else None


__all__ = ["ModelRegistry"]
