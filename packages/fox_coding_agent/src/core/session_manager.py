"""会话（Session）持久化与树结构。

参考上游 ``packages/coding-agent/src/core/session-manager.ts``，保留精简的历史树与持久化接口。

会话以**树结构**存储条目（message / compaction / branch_summary / thinking_level_change
/ model_change / active_tools_change / interaction_mode_change / label 等）。每个条目有 id、parent_id、
timestamp。从叶节点回溯到根（或到 compaction）构成当前上下文。

提供两种后端：
- ``InMemorySessionStorage``：纯内存，测试与临时场景。
- ``JsonlSessionStorage``：JSONL 文件持久化，每行一个条目。

SDK 场景下，会话的核心价值是**保存/恢复对话**与**分支**（fork）。
"""

from __future__ import annotations

import json
import copy
import uuid
from pathlib import Path
from typing import Any

from fox_ai.src import (
    AssistantMessage, Message, TextContent, ThinkingContent, ToolCall,
    ToolResultMessage, UserMessage,
)

# 通用 Entry、Storage 协议和内存实现位于 agent-core。
from fox_agent_core.src.harness.session import (
    SessionEntry, SessionEntryType, SessionStorage, InMemorySessionStorage,
    validate_entry as _validate_entry,
)
from ._io import atomic_write_text


# ============================================================
# JSONL 存储
# ============================================================


class JsonlSessionStorage(InMemorySessionStorage):
    """JSONL 文件会话存储。每行一个条目 JSON。

    文件格式：
    - 第 1 行：metadata（含 leaf_id / label）
    - 第 2+ 行：entry JSON（按追加顺序）
    """

    def __init__(self, file_path: str | Path, metadata: dict[str, Any] | None = None) -> None:
        self._path = Path(file_path)
        super().__init__(metadata)
        if self._path.exists():
            self._load()
        else:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._save()

    @classmethod
    def create(cls, file_path: str | Path, source: SessionStorage) -> JsonlSessionStorage:
        """Publish a complete draft with one write, preserving its selected branch."""
        path = Path(file_path)
        if path.exists():
            raise FileExistsError(f"Refusing to overwrite session: {path}")
        storage = cls.__new__(cls)
        InMemorySessionStorage.__init__(storage, source.get_metadata())
        storage._path = path
        for entry in source.get_entries():
            _validate_entry(entry, storage._entries)
            storage._entries[entry.id] = copy.deepcopy(entry)
        leaf_id = source.get_leaf_id()
        if leaf_id is not None and leaf_id not in storage._entries:
            raise ValueError(f"Session leaf does not exist: {leaf_id}")
        storage._leaf_id = leaf_id
        storage._label = source.get_label()
        storage._save()
        return storage

    def _save(self) -> None:
        meta = {**self._metadata, "_leaf_id": self._leaf_id, "_label": self._label}
        records = [{"_meta": meta}, *map(_serialize_entry, self.get_entries())]
        text = "\n".join(json.dumps(record, ensure_ascii=False) for record in records) + "\n"
        atomic_write_text(self._path, text, newline="\n")

    def _load(self) -> None:
        lines = self._path.read_text(encoding="utf-8").splitlines()
        if not lines:
            return
        # 第一行是 meta
        meta_obj = json.loads(lines[0])
        if "_meta" not in meta_obj:
            raise ValueError("Session file is missing its metadata header")
        meta = meta_obj.get("_meta", {})
        self._metadata = {k: v for k, v in meta.items() if k not in ("_leaf_id", "_label")}
        self._leaf_id = meta.get("_leaf_id")
        self._label = meta.get("_label")
        for line in lines[1:]:
            if not line.strip():
                continue
            obj = json.loads(line)
            entry = SessionEntry(
                id=obj["id"],
                parent_id=obj.get("parent_id"),
                timestamp=obj.get("timestamp", ""),
                type=obj.get("type", "message"),
                data=_deserialize_message(obj.get("data")),
                label=obj.get("label"),
            )
            _validate_entry(entry, self._entries)
            self._entries[entry.id] = entry
        if self._leaf_id is not None and self._leaf_id not in self._entries:
            raise ValueError(f"Session leaf does not exist: {self._leaf_id}")


def _serialize_message(data: Any) -> Any:
    """序列化 message 数据（Pydantic model → dict）。"""
    if data is None:
        return None
    if isinstance(data, (UserMessage, AssistantMessage, ToolResultMessage)):
        return data.model_dump(by_alias=True, mode="json")
    return data


def _deserialize_message(data: Any) -> Any:
    """反序列化 message 数据（dict → Pydantic model）。"""
    if data is None or not isinstance(data, dict):
        return data
    role = data.get("role")
    if role == "user":
        return UserMessage.model_validate(data)
    if role == "assistant":
        return AssistantMessage.model_validate(data)
    if role == "toolResult":
        return ToolResultMessage.model_validate(data)
    return data


def _serialize_entry(entry: SessionEntry) -> dict[str, Any]:
    return {
        "id": entry.id, "parent_id": entry.parent_id,
        "timestamp": entry.timestamp, "type": entry.type,
        "data": _serialize_message(entry.data), "label": entry.label,
    }


# ============================================================
# Session 类
# ============================================================


class SessionManager:
    """一个会话：树结构条目 + 当前叶节点。

    核心操作：
    - append_message / append_compaction / append_label：追加条目
    - get_branch：从叶节点回溯到根（或到 compaction）
    - build_context：从分支构建 AgentMessage 列表
    - move_to：切换到另一个叶节点（分支切换）
    """

    def __init__(self, storage: SessionStorage | None = None) -> None:
        self._storage = storage if storage is not None else InMemorySessionStorage()

    @property
    def storage(self) -> SessionStorage:
        return self._storage

    @property
    def leaf_id(self) -> str | None:
        return self._storage.get_leaf_id()

    def get_entry(self, entry_id: str) -> SessionEntry | None:
        return self._storage.get_entry(entry_id)

    def get_entries(self) -> list[SessionEntry]:
        return self._storage.get_entries()

    def get_label(self) -> str | None:
        return self._storage.get_label()

    # ---- 追加条目 ----

    def _append(self, entry_type: SessionEntryType, data: Any) -> SessionEntry:
        entry = SessionEntry(
            id=self._storage.create_entry_id(), parent_id=self.leaf_id,
            timestamp=self._storage.create_timestamp(), type=entry_type,
            data=copy.deepcopy(data),
        )
        self._storage.append_entry(entry)
        return entry

    def append_message(self, message: Message) -> SessionEntry:
        return self._append("message", message)

    def append_compaction(self, summary: str, retained_tail: list[Message]) -> SessionEntry:
        return self._append("compaction", {
            "summary": summary,
            "retained_tail": [_serialize_message(m) for m in retained_tail],
        })

    def append_label(self, label: str) -> SessionEntry:
        entry = self._append("label", label)
        self._storage.set_label(label)
        return entry

    def append_thinking_level_change(self, level: str | None) -> SessionEntry:
        return self._append("thinking_level_change", level)

    def append_model_change(self, model: dict[str, Any]) -> SessionEntry:
        return self._append("model_change", model)

    def append_active_tools_change(self, names: list[str]) -> SessionEntry:
        return self._append("active_tools_change", names)

    def append_interaction_mode_change(self, mode: str) -> SessionEntry:
        return self._append("interaction_mode_change", mode)

    def append_execution_mode_change(self, mode: str) -> SessionEntry:
        return self._append("execution_mode_change", mode)

    def append_plan_decision(self, tool_call_id: str, decision: str) -> SessionEntry:
        if decision not in ("accepted", "rejected"):
            raise ValueError("Plan decision must be accepted or rejected")
        return self._append("plan_decision", {
            "tool_call_id": str(tool_call_id), "decision": decision,
        })

    def build_settings(self) -> dict[str, Any]:
        """恢复当前分支上的配置，包含压缩点之前的配置条目。"""
        settings = {}
        keys = {"model_change": "model", "thinking_level_change": "thinking_level",
                "active_tools_change": "active_tools",
                "interaction_mode_change": "interaction_mode",
                "execution_mode_change": "execution_mode"}
        for entry in self.get_branch(include_ancestors=True):
            if entry.type in keys:
                settings[keys[entry.type]] = copy.deepcopy(entry.data)
        return settings

    # ---- 分支与上下文 ----

    def get_branch(self, from_id: str | None = None, *, include_ancestors: bool = False) -> list[SessionEntry]:
        """从指定节点（默认叶节点）回溯到根（或到 compaction）。

        如果路径上遇到 compaction，从 compaction 开始（含）。
        """
        leaf = from_id or self.leaf_id
        if leaf is None:
            return []
        path: list[SessionEntry] = []
        current: str | None = leaf
        seen: set[str] = set()
        while current:
            if current in seen:
                raise ValueError("Session contains a cycle")
            seen.add(current)
            entry = self._storage.get_entry(current)
            if entry is None:
                raise ValueError(f"Unknown session entry: {current}")
            path.append(entry)
            if entry.type == "compaction" and not include_ancestors:
                break
            current = entry.parent_id
        path.reverse()
        return path

    def build_context(self) -> list[Message]:
        """从当前分支构建 AgentMessage 列表。

        - compaction 条目：展开为 summary 文本 + retained_tail 消息。
        - message 条目：直接取 data。
        - 失败/中止 assistant 及其配对工具结果保留在审计树中，但不再发给模型。
          流中断时内容和工具参数都可能只生成了一半，不能成为下一次请求的历史。
        - 其他类型条目：跳过（不影响消息序列）。
        """
        messages: list[Message] = []
        discarded_tool_calls: set[str] = set()

        def append_replayable(message: Message) -> None:
            if isinstance(message, AssistantMessage):
                if message.stop_reason in ("aborted", "error"):
                    discarded_tool_calls.update(
                        block.id for block in message.content if isinstance(block, ToolCall)
                    )
                    return
                if not message.content:
                    return
                # Raw reasoning is intentionally excluded from subsequent
                # requests. A reasoning-only assistant therefore has no valid
                # provider-visible content and must stay audit-only too.
                if not any(
                    isinstance(block, ToolCall)
                    or (isinstance(block, TextContent) and block.text.strip())
                    for block in message.content
                ):
                    return
            if isinstance(message, ToolResultMessage) and message.tool_call_id in discarded_tool_calls:
                discarded_tool_calls.discard(message.tool_call_id)
                return
            messages.append(message.model_copy(deep=True))

        for entry in self.get_branch():
            if entry.type == "message":
                if isinstance(entry.data, (UserMessage, AssistantMessage, ToolResultMessage)):
                    append_replayable(entry.data)
            elif entry.type == "compaction" and isinstance(entry.data, dict):
                summary = entry.data.get("summary", "")
                if summary:
                    messages.append(
                        UserMessage(content=f"[Previous conversation summary]\n{summary}")
                    )
                for raw in entry.data.get("retained_tail", []):
                    if isinstance(raw, dict):
                        msg = _deserialize_message(raw)
                        if isinstance(msg, (UserMessage, AssistantMessage, ToolResultMessage)):
                            append_replayable(msg)
        return messages

    def move_to(self, entry_id: str | None) -> None:
        """切换叶节点（分支切换）。"""
        self._storage.set_leaf_id(entry_id)

    def fork(self, from_id: str | None = None) -> SessionManager:
        """从指定节点 fork 出一个新会话（共享到该点的历史）。"""
        branch = self.get_branch(from_id, include_ancestors=True)
        new_storage = InMemorySessionStorage(metadata={**self._storage.get_metadata(), "id": uuid.uuid4().hex})
        new_session = SessionManager(new_storage)
        for entry in branch:
            new_entry = SessionEntry(
                id=new_storage.create_entry_id(),
                parent_id=new_storage.get_leaf_id(),
                timestamp=entry.timestamp,
                type=entry.type,
                data=copy.deepcopy(entry.data),
                label=entry.label,
            )
            new_storage.append_entry(new_entry)
        new_storage.set_label(self.get_label())
        return new_session

    def usage_totals(self) -> dict[str, float | int]:
        """Sum request usage on the active branch, including compacted history."""
        totals: dict[str, float | int] = {
            "input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
            "reasoning": 0, "total_tokens": 0, "cost": 0.0,
        }
        for entry in self.get_branch(include_ancestors=True):
            message = entry.data if entry.type == "message" else None
            if not isinstance(message, (AssistantMessage, ToolResultMessage)):
                continue
            usage = message.usage
            if usage is None:
                continue
            for name in ("input", "output", "cache_read", "cache_write", "reasoning", "total_tokens"):
                totals[name] += getattr(usage, name, 0) or 0
            totals["cost"] += getattr(getattr(usage, "cost", None), "total", 0) or 0
        return totals

    def export_json(self, path: str | Path) -> Path:
        """Export the complete tree without exposing credentials."""
        target = Path(path).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "metadata": self.storage.get_metadata(),
            "leaf_id": self.leaf_id,
            "label": self.get_label(),
            "usage": self.usage_totals(),
            "entries": [_serialize_entry(entry) for entry in self.get_entries()],
        }
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return target

    @staticmethod
    def _markdown_content(message: Message) -> str:
        if isinstance(message, UserMessage):
            return message.content if isinstance(message.content, str) else "\n".join(
                getattr(block, "text", f"[{getattr(block, 'type', 'content')}]") for block in message.content
            )
        if isinstance(message, ToolResultMessage):
            return "\n".join(getattr(block, "text", "[content]") for block in message.content)
        parts: list[str] = []
        for block in message.content:
            if isinstance(block, TextContent):
                parts.append(block.text)
            elif isinstance(block, ThinkingContent):
                parts.append(f"<details><summary>Thinking</summary>\n\n{block.thinking}\n\n</details>")
            elif isinstance(block, ToolCall):
                parts.append(f"```json\n{{\"tool\": {json.dumps(block.name)}, \"arguments\": "
                             f"{json.dumps(block.arguments, ensure_ascii=False)}}}\n```")
        return "\n\n".join(parts)

    def export_markdown(self, path: str | Path) -> Path:
        target = Path(path).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        sections = ["# FoxCode Session", ""]
        headings = {"user": "User", "assistant": "Assistant", "toolResult": "Tool Result"}
        for message in self.build_context():
            sections.extend([f"## {headings.get(message.role, message.role)}", "",
                             self._markdown_content(message), ""])
        target.write_text("\n".join(sections).rstrip() + "\n", encoding="utf-8")
        return target


__all__ = [
    "SessionEntry",
    "SessionEntryType",
    "SessionStorage",
    "InMemorySessionStorage",
    "JsonlSessionStorage",
    "SessionManager",
]
