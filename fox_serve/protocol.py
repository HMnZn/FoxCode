"""宿主对象 → 线协议 JSON 的翻译层（纯函数，可单测）。

这一层刻意不 import `fox_coding_agent`：它只按属性/类型嗅探，因此可以用假对象
单测，也不会因为宿主的 import 代价拖慢进程启动。

命名规则（由 `desktop/src/types/protocol.ts` 决定，必须逐字对齐）：

- **消息对象用 camelCase**（``stopReason`` / ``totalTokens`` / ``toolCallId``）→
  pydantic ``model_dump(mode="json", by_alias=True)``。
- **流事件用 snake_case**（``content_index`` / ``delta`` / ``tool_call``）→
  pydantic ``model_dump(mode="json")``。
- 工具结果 `result` 在前端是**字符串**（`ToolCallCard.tsx` 把它当 stdout/stderr
  交给 `ToolOutput`），所以这里把 ``AgentToolResult`` 压成人类可读文本。
"""

from __future__ import annotations

import dataclasses
import json
import math
from pathlib import Path
from typing import Any

#: 线协议版本；前端 `PROTOCOL_VERSION` 必须与它相等。
PROTOCOL_VERSION = 1

#: 这些字段名承载「消息」，序列化时使用 camelCase 别名。
_MESSAGE_FIELDS = frozenset({"message", "messages", "tool_results", "streaming_message"})

#: 这些字段名承载 fox_ai 流事件，序列化时保持 snake_case。
_STREAM_FIELDS = frozenset({"assistant_message_event"})

_SKIP_FIELDS = frozenset({"cancel_event", "http_client"})


def to_jsonable(value: Any, *, alias: bool = True, depth: int = 0) -> Any:
    """把任意宿主对象转成 JSON 可序列化结构；永不抛异常。

    ``alias=True`` 时 pydantic 模型走 camelCase 别名（消息、用量），
    ``alias=False`` 时保持字段原名（流事件）。
    """

    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Path):
        return str(value)
    if depth > 12:  # 病态嵌套的兜底，避免无限递归
        return None

    if isinstance(value, dict):
        return {
            str(key): to_jsonable(item, alias=alias, depth=depth + 1)
            for key, item in value.items()
            if key not in _SKIP_FIELDS
        }
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_jsonable(item, alias=alias, depth=depth + 1) for item in value]
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", errors="replace")

    dump = getattr(value, "model_dump", None)
    if callable(dump):
        try:
            return to_jsonable(
                dump(mode="json", by_alias=alias), alias=alias, depth=depth + 1
            )
        except TypeError:  # pragma: no cover - 非 pydantic 的同名方法
            return to_jsonable(dump(), alias=alias, depth=depth + 1)

    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        out: dict[str, Any] = {}
        for field in dataclasses.fields(value):
            if field.name.startswith("_") or field.name in _SKIP_FIELDS:
                continue
            out[field.name] = _dump_field(
                field.name, getattr(value, field.name, None), depth=depth + 1
            )
        return out

    # 普通对象（例如 AgentTool 实例）：只取公开的简单属性，避免把
    # asyncio.Primitive 之类带进 JSON。
    attrs = getattr(value, "__dict__", None)
    if isinstance(attrs, dict):
        out = {}
        for key, item in attrs.items():
            if key.startswith("_") or key in _SKIP_FIELDS:
                continue
            if isinstance(item, (str, int, float, bool, type(None), Path, list, tuple, dict)):
                out[key] = to_jsonable(item, alias=alias, depth=depth + 1)
        return out
    return str(value)


def _dump_field(name: str, value: Any, *, depth: int) -> Any:
    """按字段语义选择 snake_case 还是 camelCase。"""

    if name in _STREAM_FIELDS:
        return to_jsonable(value, alias=False, depth=depth)
    if name in _MESSAGE_FIELDS:
        return to_jsonable(value, alias=True, depth=depth)
    return to_jsonable(value, alias=True, depth=depth)


def compact_json(value: Any) -> str:
    """NDJSON 单行编码（UTF-8 原样输出，便于中文日志排查）。"""

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


# ---------------------------------------------------------------------------
# 工具结果
# ---------------------------------------------------------------------------


def _details_suffix(details: Any) -> str:
    if not isinstance(details, dict):
        return ""
    suffix = ""
    exit_code = details.get("exit_code", details.get("exitCode"))
    if isinstance(exit_code, int):
        suffix += f"\n\n[exit {exit_code}]"
    if details.get("truncated"):
        suffix += "\n[输出已截断]"
    return suffix


def tool_result_text(result: Any) -> str:
    """把 ``AgentToolResult`` / 任意结果压成前端可显示的字符串。"""

    if result is None:
        return ""
    if isinstance(result, str):
        return result
    if isinstance(result, (int, float, bool)):
        return str(result)
    if isinstance(result, dict):
        for key in ("text", "stdout", "output", "content"):
            value = result.get(key)
            if isinstance(value, str) and value.strip():
                return value + _details_suffix(result)
        return compact_json(result)[:4000]

    content = getattr(result, "content", None)
    parts: list[str] = []
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, (list, tuple)):
        for part in content:
            if isinstance(part, str):
                parts.append(part)
                continue
            text = getattr(part, "text", None)
            kind = getattr(part, "type", None)
            if isinstance(text, str) and text:
                parts.append(text)
            elif kind == "image":
                parts.append("[图片输出]")
    body = "\n".join(part for part in parts if part).strip()
    details = getattr(result, "details", None)
    if not body and isinstance(details, dict):
        for key in ("stdout", "output", "text"):
            value = details.get(key)
            if isinstance(value, str) and value.strip():
                body = value
                break
    text = body + _details_suffix(details)
    return text or "(无输出)"


def partial_result_text(partial: Any) -> str:
    """``tool_execution_update.partial_result`` → 字符串（前端同样按字符串用）。"""

    if partial is None:
        return ""
    if isinstance(partial, str):
        return partial
    return tool_result_text(partial)


# ---------------------------------------------------------------------------
# 事件 → 帧负载
# ---------------------------------------------------------------------------


def message_payload(message: Any) -> Any:
    """消息对象序列化（camelCase）。"""

    if message is None:
        return None
    return to_jsonable(message, alias=True)


def stream_event_payload(event: Any) -> Any:
    """fox_ai 流事件序列化（snake_case，逐帧只带 delta）。"""

    if event is None:
        return None
    # Real provider events contain ``partial`` (the entire growing message).
    # Exclude it before serialization, not afterwards: otherwise each token
    # re-encodes the entire HTML file and saturates the desktop pipe.
    if hasattr(event, "partial"):
        fields = ("type", "content_index", "delta", "content", "tool_call")
        return {
            name: to_jsonable(getattr(event, name), alias=False)
            for name in fields if hasattr(event, name)
        }
    return to_jsonable(event, alias=False)


def event_payload(event: Any) -> dict[str, Any] | None:
    """把宿主事件转成线协议帧负载（不含 seq/ts/v 信封）。

    返回 ``None`` 表示这个事件不需要发给前端。
    """

    etype = getattr(event, "type", None)
    if not isinstance(etype, str) or not etype:
        return None

    if etype == "message_start":
        return {"type": etype, "message": message_payload(getattr(event, "message", None))}
    if etype == "message_update":
        payload = {
            "type": etype,
            "assistant_message_event": stream_event_payload(
                getattr(event, "assistant_message_event", None)
            ),
        }
        usage = getattr(event, "context_usage", None)
        if usage is not None:
            payload["context_usage"] = to_jsonable(usage, alias=False)
        return payload
    if etype == "message_end":
        return {"type": etype, "message": message_payload(getattr(event, "message", None))}
    if etype == "turn_end":
        results = getattr(event, "tool_results", None) or []
        return {
            "type": etype,
            "message": message_payload(getattr(event, "message", None)),
            "tool_results": [message_payload(item) for item in results],
        }
    if etype == "agent_start":
        return {"type": etype}
    if etype == "agent_end":
        # 故意不回传完整 messages：那是整段历史，帧会非常大，而前端时间线
        # 是增量构建的（protocol.ts 里 messages 也是可选的）。
        return {"type": etype}
    if etype == "turn_start":
        return {"type": etype}
    if etype == "tool_execution_start":
        return {
            "type": etype,
            "tool_call_id": getattr(event, "tool_call_id", None),
            "tool_name": getattr(event, "tool_name", None),
            "args": to_jsonable(getattr(event, "args", None)),
        }
    if etype == "tool_execution_update":
        partial = getattr(event, "partial_result", None)
        payload = {
            "type": etype,
            "tool_call_id": getattr(event, "tool_call_id", None),
            "partial_result": partial_result_text(partial),
        }
        details = getattr(partial, "details", None)
        if isinstance(details, dict) and details:
            payload["details"] = to_jsonable(details, alias=False)
        return payload
    if etype == "tool_execution_end":
        result = getattr(event, "result", None)
        payload = {
            "type": etype,
            "tool_call_id": getattr(event, "tool_call_id", None),
            "tool_name": getattr(event, "tool_name", None),
            "result": tool_result_text(result),
            "is_error": bool(getattr(event, "is_error", False)),
        }
        details = getattr(result, "details", None)
        if isinstance(details, dict) and details:
            payload["details"] = to_jsonable(details, alias=False)
        return payload
    if etype in (
        "compaction_start",
        "compaction_update",
        "compaction_end",
        "compaction_error",
    ):
        payload = {
            "type": etype,
            "automatic": bool(getattr(event, "automatic", False)),
        }
        for source, target in (
            ("pre_tokens", "preTokens"),
            ("post_tokens", "postTokens"),
            ("summary_tokens", "summaryTokens"),
        ):
            value = getattr(event, source, None)
            if isinstance(value, int):
                payload[target] = value
        error = getattr(event, "error", None)
        if error:
            payload["error"] = str(error)
        result = getattr(event, "result", None)
        if result is not None:
            summary = getattr(result, "summary", None)
            if isinstance(summary, str) and summary:
                payload["summary"] = summary[:4000]
            removed = getattr(result, "removed_count", None)
            if isinstance(removed, int):
                payload["removedCount"] = removed
            retained = getattr(result, "retained_tail", None)
            if isinstance(retained, list):
                payload["retainedCount"] = len(retained)
        return payload
    if etype in ("context_overflow_retry", "model_retry"):
        return to_jsonable(event, alias=True)
    if etype == "session_start":
        return {
            "type": etype,
            "session_file": str(getattr(event, "session_file", "") or ""),
            "cwd": str(getattr(event, "cwd", "") or ""),
            "permission": getattr(event, "permission", None)
            or getattr(event, "permission_mode", None),
        }
    if etype == "session_shutdown":
        reason = getattr(event, "reason", None)
        return {"type": etype, "reason": reason if reason else "close"}
    if etype == "error":
        return {"type": etype, "error": str(getattr(event, "error", "") or "")}
    if etype == "before_prompt":
        # 不是前端契约里的事件，丢弃。
        return None

    payload = to_jsonable(event, alias=True)
    return payload if isinstance(payload, dict) else None
