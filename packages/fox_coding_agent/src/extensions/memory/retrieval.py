"""Three-signal, deterministic, and explainable memory retrieval.

Only three retrieval mechanisms are allowed here:

1. Contextual BM25F for field-aware lexical grounding and pronoun resolution.
2. An auditable concept graph for synonym-level semantic bridging.
3. Temporal truth arbitration for lifecycle, conflicts, and a small time prior.

Abstention and topic diversification are decision/selection policies, not
additional relevance signals. Pinned behavior policies are handled by the
injection layer and never receive a retrieval-score boost.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Sequence

from .models import MemoryEntry, ScoreBreakdown, SearchResult

_WORD_RE = re.compile(r"[a-z0-9][a-z0-9_.+/-]*", re.IGNORECASE)
_HAN_RE = re.compile(r"[\u3400-\u9fff]+")
_STOP_TOKENS = {
    "a", "an", "and", "are", "does", "how", "is", "of", "the", "to", "what", "where", "which",
    "一个", "什么", "使用", "可以", "哪个", "哪里", "如何", "应该", "当前", "怎么", "是否", "现在",
    "目前", "相关", "项目", "需要", "是什么",
}
_REFERENTIAL_RE = re.compile(
    r"^(那|这个|这个呢|那个|它|它呢|那它|那它呢|上述|刚才|前面|what about|how about|and that)",
    re.IGNORECASE,
)

# Stable concept IDs make semantic evidence debuggable. Each synonym family is
# counted at most once, so adding aliases cannot inflate the relevance score.
_CONCEPT_GRAPH: dict[str, tuple[str, ...]] = {
    "testing": ("测试", "test", "pytest", "单测", "自动化测试"),
    "build": ("构建", "build", "打包", "compile"),
    "dependency": ("依赖", "dependency", "dependencies", "包管理", "package manager"),
    "run": ("启动", "运行", "run", "start", "launch"),
    "delete": ("删除", "移除", "delete", "remove", "forget", "忘记"),
    "location": ("目录", "路径", "directory", "path", "folder"),
    "api": ("接口", "api", "endpoint", "端点"),
    "authentication": ("鉴权", "认证", "auth", "authentication", "authorization"),
    "error": ("错误", "异常", "error", "exception", "failure"),
    "logging": ("日志", "log", "logging"),
    "database": ("数据库", "db", "database", "存储"),
    "cache": ("缓存", "cache", "redis"),
    "git-branch": ("分支", "branch", "git"),
    "commit": ("提交", "commit", "提交信息"),
    "naming": ("命名", "name", "naming"),
    "formatting": ("格式化", "format", "formatter", "ruff"),
    "documentation": ("文档", "docs", "documentation", "说明"),
    "response": ("回复", "回答", "response", "answer"),
    "concise": ("简洁", "精炼", "concise", "brief"),
    "chinese": ("中文", "汉语", "chinese"),
    "timeout": ("超时", "timeout", "deadline"),
    "retry": ("重试", "retry", "backoff"),
    "configuration": ("配置", "config", "configuration", "settings"),
    "deployment": ("部署", "deploy", "release", "发布"),
    "credential": ("密钥", "secret", "token", "credential", "凭据"),
}

_FIELD_WEIGHTS = {"name": 3.0, "description": 1.8, "content": 0.7, "tags": 2.2}
_BM25_K1 = 1.2
_BM25_B = 0.65
_CONTEXT_WEIGHT = 0.65
_CONCEPT_WEIGHT = 1.3


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.casefold()).strip()


def token_sequence(text: str) -> list[str]:
    """Tokenize code/English terms plus overlapping Chinese bi/tri-grams."""
    normalized = normalize(text)
    result = [item.strip("./_-") for item in _WORD_RE.findall(normalized)]
    for run in _HAN_RE.findall(normalized):
        if len(run) == 1:
            result.append(run)
        else:
            result.extend(run[index:index + 2] for index in range(len(run) - 1))
            if len(run) >= 3:
                result.extend(run[index:index + 3] for index in range(len(run) - 2))
    return [item for item in result if item and item not in _STOP_TOKENS]


def tokens(text: str) -> set[str]:
    return set(token_sequence(text))


def concepts(text: str) -> set[str]:
    """Return stable concept IDs, counting each synonym family only once."""
    normalized = normalize(text)
    word_terms = set(_WORD_RE.findall(normalized))
    matched: set[str] = set()
    for concept_id, aliases in _CONCEPT_GRAPH.items():
        for alias in aliases:
            normalized_alias = normalize(alias)
            if (re.search(r"[\u3400-\u9fff]", normalized_alias)
                    and normalized_alias in normalized):
                matched.add(concept_id)
                break
            if " " in normalized_alias and normalized_alias in normalized:
                matched.add(concept_id)
                break
            if normalized_alias in word_terms:
                matched.add(concept_id)
                break
    return matched


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def is_expired(entry: MemoryEntry, *, now: datetime | None = None) -> bool:
    if entry.status == "expired":
        return True
    expiry = _parse_time(entry.expires_at)
    return expiry is not None and expiry <= (now or datetime.now(timezone.utc))


@dataclass(frozen=True)
class RetrievalConfig:
    use_conversation_context: bool = True
    use_concept_graph: bool = True
    use_temporal_truth: bool = True
    use_threshold: bool = True
    min_score: float = 3.2


class HybridRetriever:
    """Rank memories with exactly three inspectable evidence channels."""

    def __init__(self, entries: Sequence[MemoryEntry], config: RetrievalConfig | None = None,
                 *, now: datetime | None = None) -> None:
        self.entries = list(entries)
        self.config = config or RetrievalConfig()
        self.now = now or datetime.now(timezone.utc)

    def _eligible(self) -> list[MemoryEntry]:
        if not self.config.use_temporal_truth:
            return list(self.entries)
        entries = [entry for entry in self.entries if not is_expired(entry, now=self.now)
                   and entry.status != "superseded"]
        latest: dict[str, MemoryEntry] = {}
        ungrouped: list[MemoryEntry] = []
        for entry in entries:
            if not entry.topic:
                ungrouped.append(entry)
                continue
            previous = latest.get(entry.topic)
            if previous is None or entry.updated_at > previous.updated_at:
                latest[entry.topic] = entry
        return [*ungrouped, *latest.values()]

    @staticmethod
    def _field_counters(entry: MemoryEntry) -> dict[str, Counter[str]]:
        return {
            "name": Counter(token_sequence(entry.name)),
            "description": Counter(token_sequence(entry.description)),
            "content": Counter(token_sequence(entry.content)),
            "tags": Counter(token_sequence(" ".join(entry.tags))),
        }

    def search(self, query: str, *, limit: int = 5, context: str | None = None) -> list[SearchResult]:
        query = normalize(query)
        if not query:
            return []
        limit = max(1, min(int(limit), 10))
        direct_terms = tokens(query)
        referential = bool(_REFERENTIAL_RE.search(query))
        context_terms = (tokens(context or "") if self.config.use_conversation_context
                         and referential else set())
        term_weights = {term: 1.0 for term in direct_terms}
        for term in context_terms:
            term_weights.setdefault(term, _CONTEXT_WEIGHT)

        query_concepts = concepts(query)
        if context_terms:
            query_concepts |= concepts(context or "")
        candidates = self._eligible()
        field_data = {entry.filename: self._field_counters(entry) for entry in candidates}
        concept_data = {
            entry.filename: concepts(" ".join((
                entry.name, entry.description, entry.content, *entry.tags
            )))
            for entry in candidates
        }
        average_lengths = {
            field: (sum(sum(fields[field].values()) for fields in field_data.values())
                    / max(1, len(field_data)))
            for field in _FIELD_WEIGHTS
        }
        document_frequency = {
            term: sum(any(term in fields[field] for field in _FIELD_WEIGHTS)
                      for fields in field_data.values())
            for term in term_weights
        }
        concept_frequency = {
            concept_id: sum(concept_id in entry_concepts
                            for entry_concepts in concept_data.values())
            for concept_id in query_concepts
        }

        ranked: list[SearchResult] = []
        for entry in candidates:
            fields = field_data[entry.filename]
            lexical_matches: set[str] = set()
            bm25f = 0.0
            for term, query_weight in term_weights.items():
                weighted_tf = 0.0
                for field, field_weight in _FIELD_WEIGHTS.items():
                    frequency = fields[field].get(term, 0)
                    if not frequency:
                        continue
                    lexical_matches.add(term)
                    field_length = sum(fields[field].values())
                    normalization = 1.0 - _BM25_B + _BM25_B * (
                        field_length / max(1.0, average_lengths[field])
                    )
                    weighted_tf += field_weight * frequency / normalization
                if not weighted_tf:
                    continue
                frequency = document_frequency.get(term, 0)
                idf = math.log(1.0 + (
                    len(candidates) - frequency + 0.5
                ) / (frequency + 0.5))
                saturation = (_BM25_K1 + 1.0) * weighted_tf / (_BM25_K1 + weighted_tf)
                bm25f += query_weight * idf * saturation
            bm25f = min(14.0, bm25f / max(1.0, math.sqrt(len(term_weights))))

            entry_concepts = concept_data[entry.filename]
            concept_matches = (query_concepts & entry_concepts
                               if self.config.use_concept_graph else set())
            concept_score = sum(
                _CONCEPT_WEIGHT * math.log(1.0 + (
                    len(candidates) - concept_frequency[concept_id] + 0.5
                ) / (concept_frequency[concept_id] + 0.5))
                for concept_id in concept_matches
            )
            relevance_evidence = bm25f + concept_score

            temporal_score = 0.0
            if self.config.use_temporal_truth and relevance_evidence > 0:
                updated = _parse_time(entry.updated_at)
                if updated:
                    age_days = max(0.0, (self.now - updated).total_seconds() / 86400)
                    temporal_score = 0.8 * math.exp(-age_days / 180.0)

            breakdown = ScoreBreakdown(
                contextual_bm25f=bm25f,
                concept_graph=concept_score,
                temporal_truth=temporal_score,
            )
            score = breakdown.total
            threshold = 2.4 if referential and context_terms else self.config.min_score
            if lexical_matches and len(candidates) <= 3:
                threshold = min(threshold, 0.5)
            if self.config.use_threshold and score < threshold:
                continue
            if not self.config.use_threshold and relevance_evidence <= 0:
                continue
            confidence = 1.0 / (1.0 + math.exp(-(score - 4.0) / 1.6))
            matched = lexical_matches | {f"concept:{item}" for item in concept_matches}
            ranked.append(SearchResult(
                entry=entry, score=score, confidence=confidence, breakdown=breakdown,
                matched_terms=tuple(sorted(matched)),
            ))

        ranked.sort(key=lambda result: (-result.score, result.entry.filename))
        selected: list[SearchResult] = []
        topics: set[str] = set()
        # A relative confidence band is a selection policy, not another score:
        # weak same-concept followers should not ride behind one strong match.
        confidence_floor = ranked[0].score * 0.60 if ranked else 0.0
        for result in ranked:
            if result.score < confidence_floor:
                continue
            topic = result.entry.topic or result.entry.filename
            if self.config.use_temporal_truth and topic in topics:
                continue
            selected.append(result)
            topics.add(topic)
            if len(selected) >= limit:
                break
        return selected


def baseline_search(entries: Iterable[MemoryEntry], query: str, *, limit: int = 5) -> list[SearchResult]:
    """The pre-redesign algorithm, retained as an honest evaluation baseline."""
    query_text = normalize(query)
    query_terms = tokens(query_text)
    ranked: list[SearchResult] = []
    for entry in entries:
        name, description, content = map(normalize, (entry.name, entry.description, entry.content))
        score = 100.0 if entry.pinned else 0.0
        score += 12.0 if query_text in name else 0.0
        score += 8.0 if query_text in description else 0.0
        score += 3.0 if query_text in content else 0.0
        score += len(query_terms & tokens(name)) * 6
        score += len(query_terms & tokens(description)) * 3
        score += len(query_terms & tokens(content))
        if score > 0:
            ranked.append(SearchResult(
                entry, score, 1.0, ScoreBreakdown(contextual_bm25f=score)
            ))
    ranked.sort(key=lambda item: (-item.score, item.entry.filename))
    return ranked[:limit]


__all__ = [
    "HybridRetriever", "RetrievalConfig", "baseline_search", "concepts", "is_expired",
    "normalize", "token_sequence", "tokens",
]
