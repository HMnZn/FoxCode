"""Persistent user decisions for loading and executing project-owned content."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


class ProjectTrustManager:
    def __init__(self, user_dir: str | Path | None = None) -> None:
        self.user_dir = Path(user_dir).expanduser().resolve() if user_dir else Path.home() / ".foxcode"
        self.path = self.user_dir / "trust.json"
        self._decisions: dict[str, bool] = {}
        self.reload()

    @staticmethod
    def key(cwd: str | Path) -> str:
        return os.path.normcase(str(Path(cwd).expanduser().resolve()))

    def reload(self) -> None:
        if not self.path.exists():
            self._decisions = {}
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            raise ValueError(f"Cannot read project trust: {self.path}: {exc}") from exc
        if not isinstance(data, dict) or not all(isinstance(k, str) and isinstance(v, bool)
                                                 for k, v in data.items()):
            raise ValueError(f"Invalid project trust file: {self.path}")
        self._decisions = data

    def decision(self, cwd: str | Path) -> bool | None:
        return self._decisions.get(self.key(cwd))

    def set(self, cwd: str | Path, trusted: bool) -> None:
        next_decisions = {**self._decisions, self.key(cwd): trusted}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.path.parent,
                                             prefix=".trust-", suffix=".tmp", delete=False) as handle:
                temporary = Path(handle.name)
                json.dump(next_decisions, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        self._decisions = next_decisions


__all__ = ["ProjectTrustManager"]
