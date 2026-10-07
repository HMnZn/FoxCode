"""Persistent user decisions for loading and executing project-owned content."""

from __future__ import annotations

import json
import os
from pathlib import Path
from .paths import UserPaths
from ._io import atomic_write_text


class ProjectTrustManager:
    def __init__(self, user_dir: str | Path | None = None) -> None:
        paths = UserPaths.from_root(user_dir)
        self.user_dir = paths.root
        self.path = paths.trust
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
        atomic_write_text(self.path, json.dumps(next_decisions, ensure_ascii=False, indent=2) + "\n")
        self._decisions = next_decisions


__all__ = ["ProjectTrustManager"]
