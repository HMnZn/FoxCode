"""Data contracts for staged, auditable skill evolution."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal


EvolutionAction = Literal["add", "merge", "discard"]
ProposalStatus = Literal["pending", "applied", "discarded", "rejected"]


@dataclass(frozen=True)
class SkillCandidate:
    """A reusable procedure extracted from user evidence, not yet an active skill."""

    name: str
    description: str
    instructions: str
    when_to_use: str = ""
    evidence: str = ""
    tags: tuple[str, ...] = ()
    confidence: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["tags"] = list(self.tags)
        return value


@dataclass
class EvolutionProposal:
    id: str
    candidate: SkillCandidate
    status: ProposalStatus = "pending"
    proposed_at: str = ""
    source_session: str = ""
    source_messages: list[dict[str, str]] = field(default_factory=list)
    suggested_action: EvolutionAction = "add"
    target_skill: str = ""
    score: float = 0.0
    reasons: list[str] = field(default_factory=list)
    applied_at: str = ""
    version: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "candidate": self.candidate.to_dict(),
            "status": self.status,
            "proposed_at": self.proposed_at,
            "source_session": self.source_session,
            "source_messages": list(self.source_messages),
            "suggested_action": self.suggested_action,
            "target_skill": self.target_skill,
            "score": self.score,
            "reasons": list(self.reasons),
            "applied_at": self.applied_at,
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "EvolutionProposal":
        raw = value.get("candidate") if isinstance(value.get("candidate"), dict) else {}
        candidate = SkillCandidate(
            name=str(raw.get("name") or ""),
            description=str(raw.get("description") or ""),
            instructions=str(raw.get("instructions") or ""),
            when_to_use=str(raw.get("when_to_use") or ""),
            evidence=str(raw.get("evidence") or ""),
            tags=tuple(str(item) for item in raw.get("tags", []) if str(item).strip()),
            confidence=float(raw.get("confidence") or 0.0),
        )
        return cls(
            id=str(value.get("id") or ""),
            candidate=candidate,
            status=str(value.get("status") or "pending"),  # type: ignore[arg-type]
            proposed_at=str(value.get("proposed_at") or ""),
            source_session=str(value.get("source_session") or ""),
            source_messages=list(value.get("source_messages") or []),
            suggested_action=str(value.get("suggested_action") or "add"),  # type: ignore[arg-type]
            target_skill=str(value.get("target_skill") or ""),
            score=float(value.get("score") or 0.0),
            reasons=[str(item) for item in value.get("reasons", [])],
            applied_at=str(value.get("applied_at") or ""),
            version=str(value.get("version") or ""),
        )


__all__ = [
    "EvolutionAction", "EvolutionProposal", "ProposalStatus", "SkillCandidate",
]
