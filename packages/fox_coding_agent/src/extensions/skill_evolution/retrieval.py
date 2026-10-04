"""BM25 Skill retrieval for FoxCode's loaded Skill objects."""

from __future__ import annotations

import math
import re
from collections import Counter
from pathlib import Path
from typing import Any

from fox_coding_agent.src.core.skills import Skill, parse_frontmatter

_TOKEN_RE = re.compile(r"[a-zA-Z0-9]+|[\u4e00-\u9fff]{1,2}")
_STOP_TOKENS = {
    "请帮", "帮我", "我做", "做一", "一次", "一下", "这个", "那个",
    "一个", "用户", "问题", "回答", "生成", "使用", "需要",
}


def token_list(text: str) -> list[str]:
    """Expand English tokens and overlapping CJK bigrams."""
    raw = str(text or "").lower().replace("_", " ").replace("-", " ")
    tokens = [m.group(0) for m in _TOKEN_RE.finditer(raw)]
    for chunk in re.findall(r"[\u4e00-\u9fff]+", raw):
        if len(chunk) >= 2:
            tokens.extend(chunk[i:i + 2] for i in range(len(chunk) - 1))
    expanded: list[str] = []
    for token in tokens:
        if not token.strip() or token in _STOP_TOKENS:
            continue
        expanded.append(token)
        if len(token) > 3 and token.endswith("s"):
            expanded.append(token[:-1])
    return expanded


def _when_to_use(skill: Skill) -> str:
    try:
        metadata, _ = parse_frontmatter(Path(skill.file_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    return str(metadata.get("when-to-use") or metadata.get("when_to_use") or "")


def retrieve_relevant_skills(
    query: str, skills: list[Skill], *, limit: int = 3, min_score: float = 0.08,
) -> list[dict[str, Any]]:
    """BM25 with metadata x3, first 2500 body chars, k1=1.4, b=.75."""
    query_terms = token_list(query)
    query_tokens = set(query_terms)
    if not query_tokens:
        return []
    docs: list[tuple[Skill, list[str], str]] = []
    document_frequency: Counter[str] = Counter()
    for skill in skills:
        when = _when_to_use(skill)
        meta_terms = token_list("\n".join([skill.name, skill.description, when]))
        body_terms = token_list(skill.content[:2500])
        terms = (meta_terms * 3) + body_terms
        if not terms:
            continue
        docs.append((skill, terms, when))
        document_frequency.update(set(terms))
    if not docs:
        return []
    avg_doc_len = sum(len(terms) for _, terms, _ in docs) / max(1, len(docs))
    doc_count = len(docs)
    k1, b = 1.4, 0.75
    hits: list[dict[str, Any]] = []
    for skill, terms, when in docs:
        term_counts = Counter(terms)
        overlap = query_tokens & set(term_counts)
        if not overlap:
            continue
        raw_score = 0.0
        doc_len = max(1, len(terms))
        for token in overlap:
            tf = term_counts[token]
            idf = math.log(
                1 + (doc_count - document_frequency[token] + 0.5)
                / (document_frequency[token] + 0.5)
            )
            denom = tf + k1 * (1 - b + b * doc_len / max(1.0, avg_doc_len))
            raw_score += idf * (tf * (k1 + 1)) / max(denom, 0.0001)
        name_bonus = 0.15 if skill.name.lower() in str(query or "").lower() else 0.0
        score = min(1.0, raw_score / max(3.0, len(query_tokens)) + name_bonus)
        if score < min_score:
            continue
        hits.append({
            "score": float(score), "name": skill.name,
            "description": skill.description, "when_to_use": when,
            "source": "foxcode", "context": "inline",
            "skill_dir": str(Path(skill.file_path).parent),
        })
    hits.sort(key=lambda item: item["score"], reverse=True)
    return hits[:max(1, int(limit or 1))]


def format_retrieved_skill_context(hits: list[dict[str, Any]]) -> str:
    if not hits:
        return ""
    lines = [
        "<retrieved_skills>",
        "These skills were retrieved for the current user request. Use a skill only "
        "if it directly matches the user's intent; otherwise ignore this block.",
    ]
    for index, hit in enumerate(hits, start=1):
        lines.append(
            f"{index}. {hit['name']} (score={hit['score']:.3f}, "
            f"source={hit['source']}): {hit['description']}"
        )
        if hit.get("when_to_use"):
            lines.append(f"   When to use: {hit['when_to_use']}")
    lines.append("</retrieved_skills>")
    return "\n".join(lines)


__all__ = ["retrieve_relevant_skills", "format_retrieved_skill_context"]
