"""Auditable file-backed memory with controlled writes and conflict history."""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from dataclasses import replace
from datetime import date, datetime, timezone
from pathlib import Path

import yaml

from ...core.skills import parse_frontmatter
from .models import MemoryEntry, MemoryStatus, MemoryType, SearchResult, WriteDecision, WriteResult
from .retrieval import HybridRetriever, RetrievalConfig, normalize, tokens

MEMORY_TYPES = ("user", "feedback", "project", "reference")
MEMORY_STATUSES = ("active", "superseded", "expired")
MAX_MEMORY_FILES = 200
MAX_NAME_CHARS = 100
MAX_DESCRIPTION_CHARS = 500
MAX_CONTENT_CHARS = 20_000
MAX_TAGS = 12
_FILENAME_RE = re.compile(r"^(user|feedback|project|reference)_[a-z0-9-]+-[0-9a-f]{10}\.md$")
_SECRET_PATTERNS = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"(?i)\b(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*[^\s<>{}\[\]]{8,}"),
)


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
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}-",
            suffix=".tmp", delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _iso(value: object, *, required: bool = False) -> str | None:
    if value is None or value == "":
        if required:
            raise ValueError("timestamp is required")
        return None
    if isinstance(value, datetime):
        value = value.isoformat()
    elif isinstance(value, date):
        value = datetime.combine(value, datetime.min.time(), timezone.utc).isoformat()
    if not isinstance(value, str):
        raise ValueError("timestamp must be an ISO-8601 string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"invalid ISO-8601 timestamp: {value}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()


def _metadata(entry: MemoryEntry) -> dict[str, object]:
    result: dict[str, object] = {
        "name": entry.name,
        "description": entry.description,
        "type": entry.type,
        "topic": entry.topic,
        "status": entry.status,
        "pinned": entry.pinned,
        "importance": entry.importance,
        "confidence": entry.confidence,
        "createdAt": entry.created_at,
        "updatedAt": entry.updated_at,
    }
    optional = {
        "expiresAt": entry.expires_at,
        "sourceSession": entry.source_session,
        "writeReason": entry.write_reason,
    }
    result.update({key: value for key, value in optional.items() if value})
    if entry.tags:
        result["tags"] = list(entry.tags)
    if entry.supersedes:
        result["supersedes"] = list(entry.supersedes)
    return result


class MemoryStore:
    """Single-project repository with policy-aware writes and explainable recall."""

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
            updated_at = _iso(metadata.get("updatedAt"), required=True)
            created_at = _iso(metadata.get("createdAt") or updated_at, required=True)
            expires_at = _iso(metadata.get("expiresAt"))
        except ValueError as exc:
            raise ValueError(f"Invalid memory: {path}: {exc}") from exc
        pinned = metadata.get("pinned", False)
        status = metadata.get("status", "active")
        topic = metadata.get("topic") or _slug(str(name))
        importance = metadata.get("importance", 0.5)
        confidence = metadata.get("confidence", 1.0)
        tags = metadata.get("tags", [])
        supersedes = metadata.get("supersedes", [])
        source = metadata.get("sourceSession")
        reason = metadata.get("writeReason")
        if not isinstance(pinned, bool) or status not in MEMORY_STATUSES:
            raise ValueError(f"Invalid memory metadata: {path}")
        if not isinstance(topic, str) or not topic.strip() or len(topic) > 100:
            raise ValueError(f"Invalid memory topic: {path}")
        if (not isinstance(importance, (int, float)) or not 0 <= importance <= 1
                or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1):
            raise ValueError(f"Invalid memory quality scores: {path}")
        if (not isinstance(tags, list) or not all(isinstance(item, str) for item in tags)
                or not isinstance(supersedes, list)
                or not all(isinstance(item, str) for item in supersedes)):
            raise ValueError(f"Invalid memory lists: {path}")
        return MemoryEntry(
            filename=path.name, name=str(name), description=str(description),
            type=validated_kind, content=body.strip(), pinned=pinned,
            updated_at=updated_at or "", source_session=source if isinstance(source, str) else None,
            topic=topic.strip().casefold(), status=status, created_at=created_at or "",
            expires_at=expires_at, importance=float(importance), confidence=float(confidence),
            tags=tuple(tags[:MAX_TAGS]), supersedes=tuple(supersedes),
            write_reason=reason if isinstance(reason, str) else None,
        )

    @staticmethod
    def load_directory(directory: str | Path) -> list[MemoryEntry]:
        """Load a fixture/export directory without constructing project state."""
        entries: list[MemoryEntry] = []
        for path in sorted(Path(directory).glob("*.md")):
            if path.name == "MEMORY.md":
                continue
            try:
                entries.append(MemoryStore._parse(path))
            except (OSError, UnicodeError, ValueError):
                continue
        return entries

    def list(self) -> list[MemoryEntry]:
        if not self.directory.is_dir():
            return []
        entries: list[MemoryEntry] = []
        for path in self.directory.glob("*.md"):
            if path.name == "MEMORY.md" or not _FILENAME_RE.fullmatch(path.name):
                continue
            try:
                entries.append(self._parse(path))
            except (OSError, UnicodeError, ValueError):
                continue
        entries.sort(key=lambda entry: (entry.updated_at, entry.filename), reverse=True)
        return entries[:MAX_MEMORY_FILES]

    def assess_write(self, *, name: str, description: str, type: str, content: str,
                     topic: str | None = None, expires_at: str | None = None,
                     **_: object) -> WriteDecision:
        """Run deterministic admission, duplicate, and conflict checks without writing."""
        self._validate(name, description, type, content)
        if any(pattern.search(content) for pattern in _SECRET_PATTERNS):
            return WriteDecision(False, "reject", (
                "content resembles a credential or private key; durable memory must not store secrets",
            ))
        if expires_at:
            _iso(expires_at)
        normalized_topic = (topic or _slug(name)).strip().casefold()
        if not normalized_topic or len(normalized_topic) > 100:
            raise ValueError("Memory topic must contain 1-100 characters")
        identity = hashlib.sha256(
            f"{type}\0{name.strip().casefold()}".encode("utf-8")
        ).hexdigest()[:10]
        filename = f"{type}_{_slug(name)}-{identity}.md"
        current = self.list()
        existing = next((entry for entry in current if entry.filename == filename), None)
        exact = next((entry for entry in current if entry.status == "active"
                      and normalize(entry.content) == normalize(content)), None)
        conflicts = tuple(entry.filename for entry in current if entry.status == "active"
                          and entry.topic == normalized_topic and entry.filename != filename)
        if existing:
            return WriteDecision(True, "update", ("same logical identity; update in place",),
                                 duplicate_of=existing.filename, conflicts=conflicts)
        if exact:
            return WriteDecision(True, "update", ("exact content duplicate; reuse existing memory",),
                                 duplicate_of=exact.filename)
        reasons = ["passed schema and secret admission policy"]
        if conflicts:
            reasons.append("newer value will supersede active memories with the same topic")
        return WriteDecision(True, "create", tuple(reasons), conflicts=conflicts)

    def controlled_save(self, *, name: str, description: str, type: str, content: str,
                        pinned: bool = False, source_session: str | None = None,
                        topic: str | None = None, importance: float = 0.5,
                        confidence: float = 1.0, expires_at: str | None = None,
                        tags: list[str] | tuple[str, ...] | None = None,
                        write_reason: str | None = None) -> WriteResult:
        kind = self._validate(name, description, type, content)
        if not isinstance(importance, (int, float)) or not 0 <= importance <= 1:
            raise ValueError("importance must be between 0 and 1")
        if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise ValueError("confidence must be between 0 and 1")
        cleaned_tags = tuple(dict.fromkeys(item.strip().casefold() for item in (tags or ()) if item.strip()))
        if len(cleaned_tags) > MAX_TAGS:
            raise ValueError(f"A memory may have at most {MAX_TAGS} tags")
        decision = self.assess_write(
            name=name, description=description, type=type, content=content,
            topic=topic, expires_at=expires_at,
        )
        if not decision.accepted:
            return WriteResult(decision)

        # Exact duplicates do not produce another file or silently refresh age.
        if decision.duplicate_of and not decision.conflicts:
            duplicate = self.read(decision.duplicate_of)
            if duplicate.name.casefold() != name.strip().casefold():
                return WriteResult(decision, duplicate)

        normalized_topic = (topic or _slug(name)).strip().casefold()
        identity = hashlib.sha256(f"{kind}\0{name.strip().casefold()}".encode("utf-8")).hexdigest()[:10]
        filename = f"{kind}_{_slug(name)}-{identity}.md"
        existing = next((entry for entry in self.list() if entry.filename == filename), None)
        if existing is None and len(self.list()) >= MAX_MEMORY_FILES:
            raise ValueError(f"Memory store is full ({MAX_MEMORY_FILES} entries)")
        now = datetime.now(timezone.utc).isoformat()
        entry = MemoryEntry(
            filename=filename, name=name.strip(), description=description.strip(), type=kind,
            content=content.strip(), pinned=bool(pinned), updated_at=now,
            source_session=source_session, topic=normalized_topic, status="active",
            created_at=existing.created_at if existing else now, expires_at=_iso(expires_at),
            importance=float(importance), confidence=float(confidence), tags=cleaned_tags,
            supersedes=decision.conflicts, write_reason=write_reason,
        )
        self._write_entry(entry)
        for old_filename in decision.conflicts:
            old = self.read(old_filename)
            self._write_entry(replace(old, status="superseded"))
        self._rebuild_index()
        return WriteResult(decision, self.read(filename), decision.conflicts)

    def save(self, **values) -> MemoryEntry:
        """Backward-compatible save returning the entry; policy rejection is explicit."""
        result = self.controlled_save(**values)
        if not result.decision.accepted or result.entry is None:
            raise ValueError("Memory rejected: " + "; ".join(result.decision.reasons))
        return result.entry

    def _write_entry(self, entry: MemoryEntry) -> None:
        frontmatter = yaml.safe_dump(_metadata(entry), allow_unicode=True, sort_keys=False).strip()
        _atomic_write(self.directory / entry.filename, f"---\n{frontmatter}\n---\n{entry.content.strip()}\n")

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

    def search_ranked(self, query: str, *, limit: int = 5, context: str | None = None,
                      config: RetrievalConfig | None = None) -> list[SearchResult]:
        return HybridRetriever(self.list(), config).search(query, limit=limit, context=context)

    def search(self, query: str, *, limit: int = 5, context: str | None = None) -> list[MemoryEntry]:
        return [result.entry for result in self.search_ranked(query, limit=limit, context=context)]

    def _rebuild_index(self) -> None:
        entries = self.list()
        lines = ["# Memory Index", "", f"Project: `{self.cwd}`", "",
                 "| Memory | Type | Status | Topic | Updated |", "|---|---|---|---|---|"]
        for entry in entries:
            pin = " 📌" if entry.pinned else ""
            lines.append(
                f"| [{entry.name}]({entry.filename}){pin} | {entry.type} | {entry.status} | "
                f"{entry.topic} | {entry.updated_at} |"
            )
        _atomic_write(self.index_path, "\n".join(lines).rstrip() + "\n")


__all__ = [
    "MEMORY_STATUSES", "MEMORY_TYPES", "MemoryEntry", "MemoryStatus", "MemoryStore",
    "MemoryType", "SearchResult", "WriteDecision", "WriteResult", "project_memory_id",
]
