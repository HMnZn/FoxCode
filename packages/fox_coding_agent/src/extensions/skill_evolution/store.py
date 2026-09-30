"""File-backed proposal, provenance, version, and active-skill storage."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from pathlib import Path
from ...core.paths import ProjectPaths, UserPaths
from typing import Any

import yaml

from fox_coding_agent.src.core.skills import (
    load_skill_from_file,
    load_skills_from_dir,
    parse_frontmatter,
    validate_description,
    validate_name,
)

from .models import EvolutionProposal, SkillCandidate


_SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{16,}\b"),
    re.compile(r"(?i)\b(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S{10,}"),
)
_URL = re.compile(r"https?://\S+", re.I)
_EXACT_DATE = re.compile(r"\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b")
_WORD = re.compile(r"[a-z0-9]+|[\u4e00-\u9fff]", re.I)


def project_evolution_id(cwd: str | Path) -> str:
    resolved = str(Path(cwd).expanduser().resolve())
    slug = re.sub(r"[^a-z0-9]+", "-", Path(resolved).name.lower()).strip("-") or "project"
    return f"{slug}-{hashlib.sha256(resolved.encode()).hexdigest()[:10]}"


def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=f".{path.name}-", suffix=".tmp", delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def _slug(name: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    value = re.sub(r"-{2,}", "-", value)[:64].strip("-")
    return value or f"evolved-skill-{hashlib.sha1(name.encode()).hexdigest()[:8]}"


def _tokens(value: str) -> set[str]:
    return set(_WORD.findall(value.lower()))


def _similarity(left: str, right: str) -> float:
    a, b = _tokens(left), _tokens(right)
    return len(a & b) / len(a | b) if a and b else 0.0


def candidate_rejection_reasons(candidate: SkillCandidate) -> list[str]:
    """Hard local gate; the model cannot override these checks."""
    reasons: list[str] = []
    reasons.extend(validate_name(candidate.name))
    reasons.extend(validate_description(candidate.description))
    if not candidate.instructions.strip():
        reasons.append("instructions are required")
    if not candidate.evidence.strip():
        reasons.append("user evidence is required")
    corpus = "\n".join((candidate.description, candidate.instructions, candidate.evidence))
    if any(pattern.search(corpus) for pattern in _SECRET_PATTERNS):
        reasons.append("candidate resembles a credential or secret")
    if _URL.search(candidate.instructions):
        reasons.append("instructions contain a one-off URL")
    if _EXACT_DATE.search(candidate.instructions):
        reasons.append("instructions contain an exact date")
    if len(candidate.instructions) > 20_000:
        reasons.append("instructions exceed 20000 characters")
    if not 0.0 <= candidate.confidence <= 1.0:
        reasons.append("confidence must be between 0 and 1")
    return reasons


def _redact_source_messages(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    """Provenance is useful, but it must not become a second secret store."""
    values: list[dict[str, str]] = []
    for item in messages[-12:]:
        content = str(item.get("content") or "")[:6000]
        for pattern in _SECRET_PATTERNS:
            content = pattern.sub("[REDACTED]", content)
        content = _URL.sub("[URL]", content)
        content = _EXACT_DATE.sub("[DATE]", content)
        values.append({"role": str(item.get("role") or ""), "content": content})
    return values


class SkillEvolutionStore:
    """Owns extension state while writing active skills to FoxCode's normal skill path."""

    def __init__(self, user_dir: str | Path, cwd: str | Path) -> None:
        self.user_dir = Path(user_dir).expanduser().resolve()
        self.cwd = Path(cwd).expanduser().resolve()
        self.state_dir = (
            self.user_dir / "projects" / project_evolution_id(self.cwd) / "skill-evolution"
        )
        self.proposals_path = self.state_dir / "proposals.json"
        self.provenance_path = self.state_dir / "provenance.jsonl"
        self.history_dir = self.state_dir / "history"
        self.project_skills_dir = ProjectPaths.from_root(self.cwd).skills
        self.user_skills_dir = UserPaths.from_root(self.user_dir).skills

    def _read_proposals(self) -> list[EvolutionProposal]:
        if not self.proposals_path.is_file():
            return []
        try:
            raw = json.loads(self.proposals_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        return [EvolutionProposal.from_dict(item) for item in raw if isinstance(item, dict)]

    def _write_proposals(self, proposals: list[EvolutionProposal]) -> None:
        _atomic_text(self.proposals_path, _json([item.to_dict() for item in proposals]))

    def _append_event(self, event: dict[str, Any]) -> None:
        self.provenance_path.parent.mkdir(parents=True, exist_ok=True)
        row = {"time": _utc_now(), **event}
        with self.provenance_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")

    def list_proposals(self, *, status: str | None = None) -> list[EvolutionProposal]:
        values = self._read_proposals()
        return [item for item in values if status is None or item.status == status]

    def get_proposal(self, proposal_id: str) -> EvolutionProposal:
        match = next((item for item in self._read_proposals() if item.id == proposal_id), None)
        if match is None:
            raise KeyError(f"Unknown skill evolution proposal: {proposal_id}")
        return match

    def _skills(self) -> list[Any]:
        return [
            *load_skills_from_dir(self.user_skills_dir).skills,
            *load_skills_from_dir(self.project_skills_dir).skills,
        ]

    def suggest_action(self, candidate: SkillCandidate) -> tuple[str, str, float]:
        skills = self._skills()
        exact = next((skill for skill in skills if skill.name == candidate.name), None)
        if exact is not None:
            return "merge", exact.name, 1.0
        derived = sorted(
            (
                skill for skill in skills
                if candidate.name.startswith(f"{skill.name}-")
            ),
            key=lambda skill: len(skill.name),
            reverse=True,
        )
        if derived:
            # Extractors sometimes append a learned subtopic to an explicitly named
            # existing Skill. Prefer evolving the longest matching parent over
            # creating a near-duplicate Skill directory.
            return "merge", derived[0].name, 0.95
        query = "\n".join((candidate.name, candidate.description, candidate.when_to_use))
        ranked = sorted(
            (
                (_similarity(query, f"{skill.name}\n{skill.description}"), skill)
                for skill in skills
            ),
            key=lambda item: item[0], reverse=True,
        )
        if ranked and ranked[0][0] >= 0.72:
            return "merge", ranked[0][1].name, round(ranked[0][0], 4)
        return "add", "", round(ranked[0][0], 4) if ranked else 0.0

    def propose(
        self,
        candidate: SkillCandidate,
        *,
        source_session: str = "",
        source_messages: list[dict[str, str]] | None = None,
    ) -> EvolutionProposal:
        reasons = candidate_rejection_reasons(candidate)
        action, target, score = self.suggest_action(candidate)
        digest = hashlib.sha256(
            json.dumps(candidate.to_dict(), ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()[:16]
        proposals = self._read_proposals()
        duplicate = next((item for item in proposals if item.id == digest), None)
        if duplicate is not None:
            return duplicate
        proposal = EvolutionProposal(
            id=digest,
            candidate=candidate,
            status="rejected" if reasons else "pending",
            proposed_at=_utc_now(),
            source_session=source_session,
            source_messages=_redact_source_messages(list(source_messages or [])),
            suggested_action=action,  # type: ignore[arg-type]
            target_skill=target,
            score=score,
            reasons=reasons,
        )
        if reasons:
            # Do not turn rejected secret-bearing input into durable extension state.
            self._append_event({
                "event": "rejected", "proposal_id": proposal.id,
                "candidate_name": proposal.candidate.name,
                "reasons": list(reasons),
            })
            return proposal
        proposals.append(proposal)
        self._write_proposals(proposals[-500:])
        self._append_event({"event": "proposed", **proposal.to_dict()})
        return proposal

    def discard(self, proposal_id: str, *, reason: str = "") -> EvolutionProposal:
        proposals = self._read_proposals()
        proposal = next((item for item in proposals if item.id == proposal_id), None)
        if proposal is None:
            raise KeyError(f"Unknown skill evolution proposal: {proposal_id}")
        if proposal.status != "pending":
            raise ValueError(f"Proposal is already {proposal.status}")
        proposal.status = "discarded"
        if reason:
            proposal.reasons.append(reason[:500])
        self._write_proposals(proposals)
        self._append_event({"event": "discarded", "proposal_id": proposal.id, "reason": reason[:500]})
        return proposal

    def _target_file(self, proposal: EvolutionProposal, target: str) -> Path:
        if proposal.suggested_action == "merge":
            for skill in self._skills():
                if skill.name == proposal.target_skill:
                    return Path(skill.file_path)
            raise FileNotFoundError(f"Merge target no longer exists: {proposal.target_skill}")
        base = self.project_skills_dir if target == "project" else self.user_skills_dir
        path = base / _slug(proposal.candidate.name) / "SKILL.md"
        if path.is_file():
            metadata, _body = parse_frontmatter(path.read_text(encoding="utf-8"))
            existing_name = str(metadata.get("name") or path.parent.name)
            if existing_name != proposal.candidate.name:
                raise FileExistsError(
                    f"Skill directory collision: {proposal.candidate.name!r} and {existing_name!r}"
                )
        return path

    @staticmethod
    def _next_version(value: object) -> str:
        parts = str(value or "0.1.0").split(".")
        if len(parts) != 3 or any(not part.isdigit() for part in parts):
            return "0.1.1"
        return f"{parts[0]}.{parts[1]}.{int(parts[2]) + 1}"

    def apply(self, proposal_id: str, *, target: str = "project") -> EvolutionProposal:
        if target not in {"project", "user"}:
            raise ValueError("target must be project or user")
        proposals = self._read_proposals()
        proposal = next((item for item in proposals if item.id == proposal_id), None)
        if proposal is None:
            raise KeyError(f"Unknown skill evolution proposal: {proposal_id}")
        if proposal.status != "pending":
            raise ValueError(f"Proposal is already {proposal.status}")
        reasons = candidate_rejection_reasons(proposal.candidate)
        if reasons:
            raise ValueError("Candidate rejected: " + "; ".join(reasons))

        path = self._target_file(proposal, target)
        previous = path.read_text(encoding="utf-8") if path.is_file() else ""
        if previous:
            metadata, body = parse_frontmatter(previous)
            version = self._next_version(metadata.get("version"))
            history = {
                "time": _utc_now(), "proposal_id": proposal.id,
                "path": str(path), "content": previous,
            }
            history_path = self.history_dir / f"{_slug(proposal.target_skill or proposal.candidate.name)}.jsonl"
            history_path.parent.mkdir(parents=True, exist_ok=True)
            with history_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(history, ensure_ascii=False, sort_keys=True) + "\n")
            addition = proposal.candidate.instructions.strip()
            if addition not in body:
                body = body.rstrip() + f"\n\n## Learned evolution\n\n{addition}\n"
            name = str(metadata.get("name") or proposal.target_skill or proposal.candidate.name)
            description = str(metadata.get("description") or proposal.candidate.description)
        else:
            version = "0.1.0"
            body = proposal.candidate.instructions.strip() + "\n"
            name = proposal.candidate.name
            description = proposal.candidate.description

        metadata = {
            "name": name,
            "description": description,
            "version": version,
            "last-evolved": _utc_now(),
            "when-to-use": proposal.candidate.when_to_use,
            "tags": list(proposal.candidate.tags),
        }
        document = "---\n" + yaml.safe_dump(
            metadata, allow_unicode=True, sort_keys=False
        ).strip() + "\n---\n\n" + body.strip() + "\n"
        _atomic_text(path, document)
        loaded, diagnostics = load_skill_from_file(path)
        if loaded is None:
            _atomic_text(path, previous) if previous else path.unlink(missing_ok=True)
            raise ValueError("Written skill failed validation: " + "; ".join(d.message for d in diagnostics))

        proposal.status = "applied"
        proposal.applied_at = _utc_now()
        proposal.version = version
        self._write_proposals(proposals)
        self._append_event({
            "event": "applied", "proposal_id": proposal.id,
            "action": proposal.suggested_action, "target_skill": loaded.name,
            "version": version, "path": str(path),
        })
        return proposal

    def stats(self) -> dict[str, Any]:
        proposals = self._read_proposals()
        counts = {status: sum(item.status == status for item in proposals)
                  for status in ("pending", "applied", "discarded", "rejected")}
        return {
            "state_dir": str(self.state_dir),
            "project_skills_dir": str(self.project_skills_dir),
            "counts": counts,
            "total": len(proposals),
        }


__all__ = [
    "SkillEvolutionStore", "candidate_rejection_reasons", "project_evolution_id",
]
