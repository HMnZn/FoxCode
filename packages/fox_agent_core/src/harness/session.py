"""Backend-neutral session entry and storage contracts."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal, Protocol


SessionEntryType = Literal[
    "message", "compaction", "branch_summary", "thinking_level_change",
    "model_change", "active_tools_change", "label", "session_info",
]


@dataclass
class SessionEntry:
    id: str
    parent_id: str | None
    timestamp: str
    type: SessionEntryType
    data: Any = None
    label: str | None = None


def create_entry_id() -> str:
    return uuid.uuid4().hex[:16]


def create_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def validate_entry(entry: SessionEntry, entries: dict[str, SessionEntry]) -> None:
    if entry.id in entries:
        raise ValueError(f"Duplicate session entry: {entry.id}")
    if entry.parent_id is not None and entry.parent_id not in entries:
        raise ValueError(f"Missing parent entry: {entry.parent_id}")


class SessionStorage(Protocol):
    def create_entry_id(self) -> str: ...
    def create_timestamp(self) -> str: ...
    def get_metadata(self) -> dict[str, Any]: ...
    def get_leaf_id(self) -> str | None: ...
    def set_leaf_id(self, entry_id: str | None) -> None: ...
    def get_entries(self) -> list[SessionEntry]: ...
    def get_entry(self, entry_id: str) -> SessionEntry | None: ...
    def append_entry(self, entry: SessionEntry) -> None: ...
    def get_label(self) -> str | None: ...
    def set_label(self, label: str | None) -> None: ...


class InMemorySessionStorage:
    def __init__(self, metadata: dict[str, Any] | None = None) -> None:
        self._metadata = {"id": uuid.uuid4().hex, **(metadata or {})}
        self._entries: dict[str, SessionEntry] = {}
        self._order: list[str] = []
        self._leaf_id: str | None = None
        self._label: str | None = None

    def create_entry_id(self) -> str:
        return create_entry_id()

    def create_timestamp(self) -> str:
        return create_timestamp()

    def get_metadata(self) -> dict[str, Any]:
        return dict(self._metadata)

    def get_leaf_id(self) -> str | None:
        return self._leaf_id

    def set_leaf_id(self, entry_id: str | None) -> None:
        if entry_id is not None and entry_id not in self._entries:
            raise ValueError(f"Unknown session entry: {entry_id}")
        self._leaf_id = entry_id

    def get_entries(self) -> list[SessionEntry]:
        return [self._entries[eid] for eid in self._order]

    def get_entry(self, entry_id: str) -> SessionEntry | None:
        return self._entries.get(entry_id)

    def append_entry(self, entry: SessionEntry) -> None:
        validate_entry(entry, self._entries)
        self._entries[entry.id] = entry
        self._order.append(entry.id)
        self._leaf_id = entry.id

    def get_label(self) -> str | None:
        return self._label

    def set_label(self, label: str | None) -> None:
        self._label = label


__all__ = [
    "SessionEntryType", "SessionEntry", "SessionStorage", "InMemorySessionStorage",
    "create_entry_id", "create_timestamp", "validate_entry",
]
