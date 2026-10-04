"""Add/merge/discard Skill maintenance with staged FoxCode proposals."""

from __future__ import annotations

import json
import re
from dataclasses import replace

from .extraction import SideQuery, parse_json_object
from .models import SkillCandidate
from .retrieval import retrieve_relevant_skills
from .store import SkillEvolutionStore


def _identity(text: str) -> str:
    raw = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]+", " ", str(text or "").lower())
    return re.sub(r"\s+", " ", raw).strip()


async def maintain_candidate(
    candidate: SkillCandidate,
    store: SkillEvolutionStore,
    side_query: SideQuery,
    retrieved_reference: dict | None = None,
) -> SkillCandidate | None:
    """Choose add, merge or discard; only stage the resulting proposal."""
    if candidate.mode == "replace":
        return candidate
    skills = store._skills()
    identities = {_identity(candidate.name), _identity(candidate.description),
                  _identity(candidate.when_to_use)} - {""}
    exact_target = next((skill.name for skill in skills if identities & {
        _identity(skill.name), _identity(skill.description),
    }), "")
    query = "\n".join((candidate.name, candidate.description,
                       candidate.when_to_use, candidate.instructions,
                       " ".join(candidate.tags)))
    similar_hits = retrieve_relevant_skills(query, skills, limit=8, min_score=0.03)
    top_reference_name = str((retrieved_reference or {}).get("name") or "").strip()
    system = (
        "You are FoxCode's online Skill Set Manager.\n"
        "Decide whether a candidate should add a new skill, merge into an existing skill, or be discarded.\n"
        "Output ONLY strict JSON.\n\n"
        "Schema:\n"
        '{"action":"add|merge|discard","target_skill":"existing name for merge",'
        '"reason":"short reason","merged_description":"optional",'
        '"merged_when_to_use":"optional","merged_instructions":"optional full merged SKILL.md body"}\n\n'
        "Rules:\n"
        "- Prefer merge over add when the same capability already exists.\n"
        "- Discard if the candidate duplicates an existing shared/project skill and adds no user-specific durable improvement.\n"
        "- If merging, synthesize a complete merged instruction body, preserving useful existing guidance and adding only durable new guidance.\n"
        "- Do not preserve one-off payload, secrets, transient project facts, URLs, exact dates, or assistant-only claims.\n"
    )
    payload = {
        "candidate": candidate.to_dict(),
        "exact_identity_target": exact_target,
        "retrieved_reference": retrieved_reference or None,
        "similar_skills": similar_hits,
        "existing_skills": [{
            "name": skill.name, "description": skill.description,
            "instructions": skill.content[:6000],
        } for skill in skills[:80]],
    }
    decision = parse_json_object(
        await side_query(system, json.dumps(payload, ensure_ascii=False))
    )
    action = str(decision.get("action") or "").strip().lower()
    target = str(decision.get("target_skill") or "").strip()
    if exact_target:
        action, target = "merge", exact_target
    elif action == "add" and similar_hits and similar_hits[0]["score"] >= 0.55:
        action, target = "merge", str(similar_hits[0]["name"])
    elif action == "merge" and not target:
        target = top_reference_name
    if action not in {"add", "merge", "discard"}:
        action = "discard"
    if action == "discard":
        return None
    if action == "add":
        return candidate
    existing = next((skill for skill in skills if skill.name == target), None)
    if existing is None:
        raise ValueError(f"Maintainer target disappeared: {target}")
    instructions = str(decision.get("merged_instructions") or "").strip()
    if not instructions:
        instructions = existing.content.rstrip() + "\n\n" + candidate.instructions.strip()
    description = str(decision.get("merged_description") or "").strip()
    return replace(
        candidate,
        name=existing.name,
        description=description or existing.description,
        when_to_use=str(decision.get("merged_when_to_use") or candidate.when_to_use),
        instructions=instructions,
        mode="replace",
    )


__all__ = ["maintain_candidate"]
