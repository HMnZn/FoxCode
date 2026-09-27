"""Value objects shared by memory persistence, retrieval, and injection."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

MemoryType = Literal["user", "feedback", "project", "reference"]
MemoryStatus = Literal["active", "superseded", "expired"]
WriteAction = Literal["create", "update", "reject"]


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
    topic: str = ""
    status: MemoryStatus = "active"
    created_at: str = ""
    expires_at: str | None = None
    importance: float = 0.5
    confidence: float = 1.0
    tags: tuple[str, ...] = ()
    supersedes: tuple[str, ...] = ()
    write_reason: str | None = None


@dataclass(frozen=True)
class ScoreBreakdown:
    """The three intentional retrieval signals; no hidden score stacking."""

    contextual_bm25f: float = 0.0
    concept_graph: float = 0.0
    temporal_truth: float = 0.0

    @property
    def total(self) -> float:
        return self.contextual_bm25f + self.concept_graph + self.temporal_truth


@dataclass(frozen=True)
class SearchResult:
    entry: MemoryEntry
    score: float
    confidence: float
    breakdown: ScoreBreakdown
    matched_terms: tuple[str, ...] = ()


@dataclass(frozen=True)
class WriteDecision:
    accepted: bool
    action: WriteAction
    reasons: tuple[str, ...]
    duplicate_of: str | None = None
    conflicts: tuple[str, ...] = ()


@dataclass(frozen=True)
class WriteResult:
    decision: WriteDecision
    entry: MemoryEntry | None = None
    superseded: tuple[str, ...] = field(default_factory=tuple)


__all__ = [
    "MemoryEntry", "MemoryStatus", "MemoryType", "ScoreBreakdown", "SearchResult",
    "WriteAction", "WriteDecision", "WriteResult",
]
