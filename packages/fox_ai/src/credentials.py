"""Provider credential contracts.

fox_ai owns the provider-facing abstraction. Applications decide how secrets
are persisted; the default implementation here is intentionally in-memory.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class ApiKeyCredential:
    key: str = field(repr=False)
    type: str = "api_key"


@dataclass(frozen=True)
class OAuthCredential:
    access: str = field(repr=False)
    refresh: str = field(repr=False)
    expires: float
    type: str = "oauth"


Credential = ApiKeyCredential | OAuthCredential


class CredentialStore(Protocol):
    """Application-owned credential storage keyed by provider id."""

    def read(self, provider_id: str) -> Credential | None: ...
    def list(self) -> tuple[str, ...]: ...
    def write(self, provider_id: str, credential: Credential) -> None: ...
    def delete(self, provider_id: str) -> None: ...


class InMemoryCredentialStore:
    def __init__(self, credentials: dict[str, Credential] | None = None) -> None:
        self._credentials = dict(credentials or {})

    def read(self, provider_id: str) -> Credential | None:
        return self._credentials.get(provider_id)

    def list(self) -> tuple[str, ...]:
        return tuple(self._credentials)

    def write(self, provider_id: str, credential: Credential) -> None:
        self._credentials[provider_id] = credential

    def delete(self, provider_id: str) -> None:
        self._credentials.pop(provider_id, None)


__all__ = [
    "ApiKeyCredential",
    "OAuthCredential",
    "Credential",
    "CredentialStore",
    "InMemoryCredentialStore",
]
