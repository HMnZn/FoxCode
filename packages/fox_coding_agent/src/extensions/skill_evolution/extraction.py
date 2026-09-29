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
        confidence = float(value.get("confidence") or 0.0)
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
) -> SkillCandidate | None:
    """Extract at most one durable workflow candidate from a feedback window."""
    system = """You are FoxCode's Skill Evolution Extractor.
Return only strict JSON in one of these forms:
{"candidate": null}
{"candidate": {"name":"kebab-case","description":"...","when_to_use":"...","instructions":"...","evidence":"verbatim or close user evidence","tags":[],"confidence":0.0}}

Only USER turns are evidence. Assistant turns provide context but never establish a preference.
Extract one candidate only when the user states or confirms a durable, reusable workflow,
correction, output policy, or implementation constraint that should help future similar tasks.
Do not extract ordinary task requests, assistant guesses, weak acknowledgements, project facts,
secrets, credentials, URLs, account identifiers, exact dates, or temporary parameters.
Generalize entities and payloads. Use lowercase kebab-case for name. If evidence is weak,
return {"candidate": null}. Confidence must reflect evidence strength."""
    payload = json.dumps({"messages": messages[-12:]}, ensure_ascii=False)
    parsed = parse_json_object(await side_query(system, payload))
    candidate = parsed.get("candidate")
    return coerce_candidate(candidate) if isinstance(candidate, dict) else None


__all__ = ["SideQuery", "coerce_candidate", "extract_candidate", "parse_json_object"]
