"""Project-scoped, file-backed long-term memory.

Memory is application state, so it lives above fox_agent_core. Each project is
mapped to a stable directory under the user's FoxCode directory. Entries are
human-readable Markdown files; MEMORY.md is a derived index and never the
source of truth.
"""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import yaml

from ...core.skills import parse_frontmatter

MemoryType = Literal["user", "feedback", "project", "reference"]
MEMORY_TYPES = ("user", "feedback", "project", "reference")
MAX_MEMORY_FILES = 200
MAX_NAME_CHARS = 100
MAX_DESCRIPTION_CHARS = 500
MAX_CONTENT_CHARS = 20_000
_FILENAME_RE = re.compile(r"^(user|feedback|project|reference)_[a-z0-9-]+-[0-9a-f]{10}\.md$")


@dataclass(frozen=True)
class MemoryEntry:
    filename: str
    name: str
    description: str
    type: MemoryType
    content: str
    pinned: bool
    updated_at: str
    source_session: str | None = None


def project_memory_id(cwd: str | Path) -> str:
    canonical = os.path.normcase(str(Path(cwd).expanduser().resolve()))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")[:40]
    return slug or "memory"


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                         prefix=f".{path.name}-", suffix=".tmp",
                                         delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _tokens(text: str) -> set[str]:
    normalized = text.casefold()
    tokens = {token for token in re.findall(r"[a-z0-9_][a-z0-9_-]+", normalized) if len(token) > 1}
    chinese = "".join(re.findall(r"[\u3400-\u9fff]", normalized))
    tokens.update(chinese[index:index + 2] for index in range(max(0, len(chinese) - 1)))
    return tokens


class MemoryStore:
    """Single-project memory repository with deterministic files and index."""

    def __init__(self, user_dir: str | Path, cwd: str | Path) -> None:
        self.user_dir = Path(user_dir).expanduser().resolve()
        self.cwd = Path(cwd).expanduser().resolve()
        self.directory = self.user_dir / "projects" / project_memory_id(self.cwd) / "memory"
        self.index_path = self.directory / "MEMORY.md"

    @staticmethod
    def _validate(name: str, description: str, type: str, content: str) -> MemoryType:
        if not isinstance(name, str) or not name.strip() or len(name) > MAX_NAME_CHARS:
            raise ValueError(f"Memory name must contain 1-{MAX_NAME_CHARS} characters")
        if (not isinstance(description, str) or not description.strip()
                or len(description) > MAX_DESCRIPTION_CHARS):
            raise ValueError(f"Memory description must contain 1-{MAX_DESCRIPTION_CHARS} characters")
        if type not in MEMORY_TYPES:
            raise ValueError(f"Memory type must be one of: {', '.join(MEMORY_TYPES)}")
        if not isinstance(content, str) or not content.strip() or len(content) > MAX_CONTENT_CHARS:
            raise ValueError(f"Memory content must contain 1-{MAX_CONTENT_CHARS} characters")
        return type  # type: ignore[return-value]

    @staticmethod
    def _parse(path: Path) -> MemoryEntry:
        metadata, body = parse_frontmatter(path.read_text(encoding="utf-8-sig"))
        name, description, kind = metadata.get("name"), metadata.get("description"), metadata.get("type")
        try:
            validated_kind = MemoryStore._validate(name, description, kind, body)
        except ValueError as exc:
            raise ValueError(f"Invalid memory: {path}: {exc}") from exc
        pinned = metadata.get("pinned", False)
        updated_at = metadata.get("updatedAt", "")
        source = metadata.get("sourceSession")
        if not isinstance(pinned, bool) or not isinstance(updated_at, str) or not updated_at:
            raise ValueError(f"Invalid memory metadata: {path}")
        return MemoryEntry(
            filename=path.name,
            name=name,
            description=description,
            type=validated_kind,
            content=body,
            pinned=pinned,
            updated_at=updated_at,
            source_session=source if isinstance(source, str) else None,
        )

    def list(self) -> list[MemoryEntry]:
        if not self.directory.is_dir():
            return []
        entries: list[tuple[int, MemoryEntry]] = []
        for path in self.directory.glob("*.md"):
            if path.name == "MEMORY.md" or not _FILENAME_RE.fullmatch(path.name):
                continue
            try:
                entries.append((path.stat().st_mtime_ns, self._parse(path)))
            except (OSError, UnicodeError, ValueError):
                continue
        entries.sort(key=lambda item: (-item[0], item[1].filename))
        return [entry for _, entry in entries[:MAX_MEMORY_FILES]]

    def save(self, *, name: str, description: str, type: str, content: str,
             pinned: bool = False, source_session: str | None = None) -> MemoryEntry:
        kind = self._validate(name, description, type, content)
        identity = hashlib.sha256(f"{kind}\0{name.strip().casefold()}".encode("utf-8")).hexdigest()[:10]
        filename = f"{kind}_{_slug(name)}-{identity}.md"
        if not (self.directory / filename).exists() and len(self.list()) >= MAX_MEMORY_FILES:
            raise ValueError(f"Memory store is full ({MAX_MEMORY_FILES} entries)")
        now = datetime.now(timezone.utc).isoformat()
        metadata: dict[str, object] = {
            "name": name.strip(), "description": description.strip(), "type": kind,
            "pinned": bool(pinned), "updatedAt": now,
        }
        if source_session:
            metadata["sourceSession"] = source_session
        frontmatter = yaml.safe_dump(metadata, allow_unicode=True, sort_keys=False).strip()
        _atomic_write(self.directory / filename, f"---\n{frontmatter}\n---\n{content.strip()}\n")
        self._rebuild_index()
        return self.read(filename)

    def _path(self, filename: str) -> Path:
        if not isinstance(filename, str) or not _FILENAME_RE.fullmatch(filename):
            raise ValueError("Invalid memory filename")
        path = self.directory / filename
        if not path.is_file():
            raise FileNotFoundError(f"Memory does not exist: {filename}")
        return path

    def read(self, filename: str) -> MemoryEntry:
        return self._parse(self._path(filename))

    def delete(self, filename: str) -> bool:
        try:
            path = self._path(filename)
        except FileNotFoundError:
            return False
        path.unlink()
        self._rebuild_index()
        return True

    def search(self, query: str, *, limit: int = 5) -> list[MemoryEntry]:
        if not isinstance(query, str) or not query.strip():
            return []
        limit = max(1, min(int(limit), 10))
        query_text = query.strip().casefold()
        query_tokens = _tokens(query_text)
        ranked: list[tuple[float, MemoryEntry]] = []
        for entry in self.list():
            name, description, content = (entry.name.casefold(), entry.description.casefold(),
                                           entry.content.casefold())
            score = 100.0 if entry.pinned else 0.0
            score += 12.0 if query_text in name else 0.0
            score += 8.0 if query_text in description else 0.0
            score += 3.0 if query_text in content else 0.0
            score += len(query_tokens & _tokens(name)) * 6
            score += len(query_tokens & _tokens(description)) * 3
            score += len(query_tokens & _tokens(content))
            if score > 0:
                ranked.append((score, entry))
        ranked.sort(key=lambda item: (-item[0], item[1].filename))
        return [entry for _, entry in ranked[:limit]]

    def _rebuild_index(self) -> None:
        entries = self.list()
        lines = ["# Memory Index", "", f"Project: `{self.cwd}`", ""]
        for entry in entries:
            pin = " pinned" if entry.pinned else ""
            lines.append(
                f"- **[{entry.name}]({entry.filename})** ({entry.type}{pin}) — {entry.description}"
            )
        _atomic_write(self.index_path, "\n".join(lines).rstrip() + "\n")


__all__ = [
    "MemoryEntry", "MemoryStore", "MemoryType", "MEMORY_TYPES", "project_memory_id",
]
