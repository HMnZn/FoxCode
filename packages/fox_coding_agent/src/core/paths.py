"""Canonical FoxCode user and project filesystem layout.

Configuration/resources are durable inputs.  Runtime artifacts are generated
outputs and must stay with the project that produced them.  Keeping all path
construction here prevents individual extensions from inventing new roots.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class UserPaths:
    """Durable, cross-project user state below ``~/.foxcode``."""

    root: Path

    @classmethod
    def from_root(cls, root: str | Path | None = None) -> "UserPaths":
        value = Path(root).expanduser() if root is not None else Path.home() / ".foxcode"
        return cls(value.resolve())

    @property
    def settings(self) -> Path: return self.root / "settings.json"
    @property
    def auth(self) -> Path: return self.root / "auth.json"
    @property
    def models(self) -> Path: return self.root / "models.json"
    @property
    def mcp(self) -> Path: return self.root / "mcp.json"
    @property
    def trust(self) -> Path: return self.root / "trust.json"
    @property
    def sessions(self) -> Path: return self.root / "sessions"
    @property
    def skills(self) -> Path: return self.root / "skills"
    @property
    def extensions(self) -> Path: return self.root / "extensions"
    @property
    def agents(self) -> Path: return self.root / "agents"
    @property
    def prompts(self) -> Path: return self.root / "prompts"

    def public(self) -> dict[str, str]:
        return {
            "root": str(self.root), "settings": str(self.settings), "mcp": str(self.mcp),
            "skills": str(self.skills), "extensions": str(self.extensions),
            "agents": str(self.agents), "sessions": str(self.sessions),
        }


@dataclass(frozen=True)
class ProjectPaths:
    """Project-owned configuration and generated artifacts."""

    root: Path

    @classmethod
    def from_root(cls, root: str | Path) -> "ProjectPaths":
        return cls(Path(root).expanduser().resolve())

    @property
    def control(self) -> Path: return self.root / ".foxcode"
    @property
    def settings(self) -> Path: return self.control / "settings.json"
    @property
    def mcp(self) -> Path: return self.control / "mcp.json"
    @property
    def skills(self) -> Path: return self.control / "skills"
    @property
    def extensions(self) -> Path: return self.control / "extensions"
    @property
    def agents(self) -> Path: return self.control / "agents"
    @property
    def prompts(self) -> Path: return self.control / "prompts"
    @property
    def artifacts(self) -> Path: return self.control / "artifacts"
    @property
    def tests(self) -> Path: return self.artifacts / "tests"
    @property
    def temp(self) -> Path: return self.artifacts / "tmp"
    @property
    def logs(self) -> Path: return self.artifacts / "logs"
    @property
    def cache(self) -> Path: return self.artifacts / "cache"
    @property
    def home(self) -> Path: return self.artifacts / "home"

    def ensure_artifacts(self) -> None:
        for path in (self.artifacts, self.tests, self.temp, self.logs, self.cache, self.home):
            path.mkdir(parents=True, exist_ok=True)

    def public(self) -> dict[str, str]:
        return {
            "root": str(self.root), "config": str(self.control),
            "settings": str(self.settings), "mcp": str(self.mcp),
            "skills": str(self.skills), "artifacts": str(self.artifacts),
            "tests": str(self.tests), "temp": str(self.temp), "logs": str(self.logs),
            "cache": str(self.cache),
        }


__all__ = ["ProjectPaths", "UserPaths"]
