"""User-level credential persistence backed by ``auth.json``."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from fox_ai.src import ApiKeyCredential, Credential, OAuthCredential


class CredentialStore:
    """CredentialStore implementation keyed directly by provider id."""

    def __init__(self, user_dir: str | Path) -> None:
        self.user_dir = Path(user_dir).expanduser().resolve()
        self.path = self.user_dir / "auth.json"
        self._credentials: dict[str, Credential] = {}
        self.reload()

    @staticmethod
    def _parse_credential(provider_id: str, raw: Any) -> Credential:
        if not isinstance(raw, dict):
            raise ValueError(f"Invalid auth credential for provider {provider_id}")
        kind = raw.get("type")
        if kind == "api_key":
            if set(raw) != {"type", "key"}:
                raise ValueError(f"Invalid API key credential fields for provider {provider_id}")
            key = raw.get("key")
            if not isinstance(key, str) or not key:
                raise ValueError(f"Invalid API key credential for provider {provider_id}")
            return ApiKeyCredential(key=key)
        if kind == "oauth":
            if set(raw) != {"type", "access", "refresh", "expires"}:
                raise ValueError(f"Invalid OAuth credential fields for provider {provider_id}")
            access, refresh, expires = raw.get("access"), raw.get("refresh"), raw.get("expires")
            if not isinstance(access, str) or not isinstance(refresh, str) or not isinstance(expires, (int, float)):
                raise ValueError(f"Invalid OAuth credential for provider {provider_id}")
            return OAuthCredential(access=access, refresh=refresh, expires=float(expires))
        raise ValueError(f"Invalid auth credential type for provider {provider_id}")

    def reload(self) -> None:
        if not self.path.exists():
            self._credentials = {}
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            raise ValueError(f"Cannot read auth config: {self.path}: {exc}") from exc
        if not isinstance(data, dict):
            raise ValueError(f"Invalid auth config in {self.path}: expected an object")
        credentials = {}
        for provider_id, raw in data.items():
            if not provider_id.strip():
                raise ValueError(f"Invalid empty provider id in {self.path}")
            credentials[provider_id] = self._parse_credential(provider_id, raw)
        self._credentials = credentials

    def read(self, provider_id: str) -> Credential | None:
        return self._credentials.get(provider_id)

    def list(self) -> tuple[str, ...]:
        return tuple(self._credentials)

    def write(self, provider_id: str, credential: Credential) -> None:
        next_credentials = {**self._credentials, provider_id: credential}
        self._save(next_credentials)
        self._credentials = next_credentials

    def delete(self, provider_id: str) -> None:
        next_credentials = dict(self._credentials)
        next_credentials.pop(provider_id, None)
        self._save(next_credentials)
        self._credentials = next_credentials

    def _save(self, credentials: dict[str, Credential]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data: dict[str, Any] = {}
        for provider_id, credential in credentials.items():
            if isinstance(credential, ApiKeyCredential):
                value: dict[str, Any] = {"type": "api_key"}
                value["key"] = credential.key
            else:
                value = {"type": "oauth", "access": credential.access,
                         "refresh": credential.refresh, "expires": credential.expires}
            data[provider_id] = value
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.path.parent,
                                             prefix=".auth-", suffix=".tmp", delete=False) as handle:
                temporary = Path(handle.name)
                json.dump(data, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


__all__ = ["CredentialStore"]
