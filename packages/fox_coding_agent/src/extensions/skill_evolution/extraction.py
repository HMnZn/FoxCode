"""LLM extraction kept separate from deterministic validation and writes."""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from .models import SkillCandidate


SideQuery = Callable[[str, str], Awaitable[str]]


def parse_json_object(text: str) -> dict[str, Any]:
    raw = str(text or "").strip()
    if not raw:
        return {}
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except ValueError:
        start, end = raw.find("{"), raw.rfind("}")
        if start < 0 or end <= start:
            return {}
        try:
            value = json.loads(raw[start:end + 1])
            return value if isinstance(value, dict) else {}
        except ValueError:
            return {}


def coerce_candidate(value: dict[str, Any]) -> SkillCandidate | None:
    name = str(value.get("name") or "").strip()
    description = str(value.get("description") or "").strip()
    instructions = str(value.get("instructions") or "").strip()
    evidence = str(value.get("evidence") or "").strip()
    if not all((name, description, instructions, evidence)):
        return None
    tags = value.get("tags") if isinstance(value.get("tags"), list) else []
    try:
        confidence = float(value.get("confidence", 1.0))
    except (TypeError, ValueError):
        confidence = 0.0
    return SkillCandidate(
        name=name,
        description=description,
        instructions=instructions,
        when_to_use=str(value.get("when_to_use") or "").strip(),
        evidence=evidence,
        tags=tuple(str(item).strip() for item in tags if str(item).strip())[:8],
        confidence=max(0.0, min(1.0, confidence)),
    )


async def extract_candidate(
    messages: list[dict[str, str]],
    side_query: SideQuery,
    retrieved_reference: dict[str, Any] | None = None,
) -> SkillCandidate | None:
    """Extract at most one durable workflow candidate from a feedback window."""
    system = """You are FoxCode's online Skill Extractor.
Extract at most ONE reusable skill candidate from a live conversation window.
Output ONLY strict JSON: {"skills": []} or {"skills": [{...}]}.

Candidate fields: name, description, when_to_use, instructions, evidence, tags.

Rules:
- USER turns are the primary evidence. Assistant turns are context only.
- A next user feedback turn may confirm, reject, or refine the prior assistant behavior.
- Do not extract assistant-only guesses, weak confirmations, one-off task payload, secrets, project facts, URLs, account IDs, exact dates, or temporary parameters.
- Extract only durable workflow, output policy, implementation preference, correction, or repeated constraint likely useful for future similar tasks.
- Remove entity names and runtime-specific payload; use placeholders where needed.
- retrieved_reference is identity context only; never treat it as new user evidence.
- If evidence is weak, generic, or low-value, return {"skills": []}."""
    payload = json.dumps({"messages": messages[-12:],
                          "retrieved_reference": retrieved_reference or None}, ensure_ascii=False)
    parsed = parse_json_object(await side_query(system, payload))
    skills = parsed.get("skills")
    candidate = (skills[0] if isinstance(skills, list) and skills else
                 parsed.get("candidate"))
    return coerce_candidate(candidate) if isinstance(candidate, dict) else None


__all__ = ["SideQuery", "coerce_candidate", "extract_candidate", "parse_json_object"]
