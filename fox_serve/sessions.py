"""会话索引：把 `.foxcode/sessions/*.jsonl` 读成前端要的 `SessionSummary`。

刻意只做**轻量解析**（不 import 宿主的 SessionManager）：JSONL 的第一行是
meta、之后每行一个条目（`packages/fox_coding_agent/src/core/session_manager.py:121-151`），
列表页只关心标题/条数/用量，没必要把整棵树反序列化成 pydantic 模型。

会话目录规则见 `packages/fox_coding_agent/src/core/runtime.py:106-112`：
project 作用域 → `<cwd>/.foxcode/sessions`；user 作用域 →
`<user_dir>/sessions/<sha256(normcase(cwd))[:16]>`。这里两个都扫，保证「最近会话」
不会漏。
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

#: 列表页最多返回多少个会话。
DEFAULT_LIMIT = 50


def _user_scope_dir(user_dir: Path, cwd: Path) -> Path:
    key = hashlib.sha256(os.path.normcase(str(cwd.resolve())).encode("utf-8")).hexdigest()[:16]
    return user_dir / "sessions" / key


def _first_text(parts: Any) -> str:
    if not isinstance(parts, list):
        return ""
    chunks: list[str] = []
    for part in parts:
        if isinstance(part, dict) and part.get("type") == "text":
            text = part.get("text")
            if isinstance(text, str):
                chunks.append(text)
        elif isinstance(part, str):
            chunks.append(part)
    return "\n".join(chunks).strip()


def _append_usage(bucket: dict[str, float], usage: Any) -> None:
    if not isinstance(usage, dict):
        return
    for key in ("input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"):
        value = usage.get(key)
        if isinstance(value, (int, float)):
            bucket[key] = bucket.get(key, 0.0) + float(value)
    cost = usage.get("cost")
    if isinstance(cost, dict):
        total = cost.get("total")
        if isinstance(total, (int, float)):
            bucket["cost"] = bucket.get("cost", 0.0) + float(total)
    elif isinstance(cost, (int, float)):
        bucket["cost"] = bucket.get("cost", 0.0) + float(cost)


@dataclass
class SessionFile:
    """磁盘上的一个会话文件。"""

    path: Path
    session_id: str
    cwd: str
    created_at: str
    updated_at: float
    message_count: int
    title: str
    model: str | None
    usage: dict[str, float]
    live: bool = False

    def to_summary(self) -> dict[str, Any]:
        """前端的 `SessionSummary`。"""

        return {
            "id": self.session_id,
            "file": str(self.path),
            "title": self.title or "未命名会话",
            "cwd": self.cwd,
            "model": self.model,
            "createdAt": _epoch_ms(self.created_at, self.updated_at),
            "updatedAt": _epoch_ms(self.updated_at, self.updated_at),
            "messageCount": self.message_count,
            "totalTokens": int(self.usage.get("totalTokens", 0)),
            "cost": round(float(self.usage.get("cost", 0.0)), 6),
            "live": self.live,
        }


def _iso(timestamp: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(timestamp))


def _epoch_ms(value: Any, fallback: float) -> int:
    """把 ISO 字符串或秒级时间戳统一成**毫秒级 epoch**。

    前端 `SessionSummary.createdAt/updatedAt` 声明的是 number
    （`desktop/src/types/protocol.ts`）。以前这里发的是 ISO 字符串，后果是
    侧栏排序 `b.updatedAt - a.updatedAt` 得到 NaN（看起来只是「没排序」），
    相对时间也永远走 `new Date(...)` 兜底分支。
    """

    if isinstance(value, bool):
        return int(fallback * 1000)
    if isinstance(value, (int, float)):
        return int(float(value) * 1000)
    if isinstance(value, str) and value.strip():
        text = value.strip().replace("Z", "+00:00")
        try:
            return int(datetime.fromisoformat(text).timestamp() * 1000)
        except ValueError:
            for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
                try:
                    return int(time.mktime(time.strptime(text, fmt)) * 1000)
                except ValueError:
                    continue
    return int(fallback * 1000)


def read_session_file(path: Path, *, live: bool = False) -> SessionFile | None:
    """解析一个会话文件；损坏时返回 None（不抛给上层）。"""

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    if not lines:
        return None

    title = ""
    cwd = ""
    created_at = ""
    model: str | None = None
    usage: dict[str, float] = {}
    message_count = 0

    try:
        meta_obj = json.loads(lines[0])
    except json.JSONDecodeError:
        return None
    meta = meta_obj.get("_meta") if isinstance(meta_obj, dict) else None
    if isinstance(meta, dict):
        cwd = str(meta.get("cwd") or "")
        created_at = str(meta.get("timestamp") or meta.get("created_at") or "")
        label = meta.get("_label")
        if isinstance(label, str):
            title = label

    for line in lines[1:]:
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict):
            continue
        etype = entry.get("type")
        data = entry.get("data")
        if etype == "message" and isinstance(data, dict):
            role = data.get("role")
            if role in ("user", "assistant"):
                message_count += 1
            if role == "user" and not title:
                title = _first_text(data.get("content"))[:80]
            if role == "assistant":
                _append_usage(usage, data.get("usage"))
        elif etype == "model_change" and isinstance(data, dict):
            model = str(data.get("id") or data.get("name") or "") or model
        elif etype == "label" and isinstance(data, str) and not title:
            title = data

    if not cwd:
        cwd = str(path.parent.parent.parent) if path.parent.name == "sessions" else ""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = time.time()

    return SessionFile(
        path=path,
        session_id=path.stem,
        cwd=cwd,
        created_at=created_at or _iso(mtime),
        updated_at=mtime,
        message_count=message_count,
        title=title,
        model=model,
        usage=usage,
        live=live,
    )


class SessionIndex:
    """按目录扫会话文件，供 `sessions.list` / `sessions.open` 使用。"""

    def __init__(self, *, cwd: str | Path, user_dir: str | Path, limit: int = DEFAULT_LIMIT) -> None:
        self.cwd = Path(cwd).absolute()
        self.user_dir = Path(user_dir).expanduser()
        self.limit = limit

    # ---- 目录 ----

    def directories(self) -> list[Path]:
        return [self.cwd / ".foxcode" / "sessions", _user_scope_dir(self.user_dir, self.cwd)]

    def files(self) -> list[Path]:
        seen: dict[Path, None] = {}
        for directory in self.directories():
            if not directory.is_dir():
                continue
            for path in sorted(directory.glob("*.jsonl")):
                seen.setdefault(path, None)
        return list(seen)

    # ---- 查询 ----

    def find(self, session_id: str) -> Path | None:
        """按 id（文件名）或路径找会话文件。"""

        if not session_id:
            return None
        candidate = Path(session_id)
        if candidate.is_file():
            return candidate
        for path in self.files():
            if path.stem == session_id or path.name == session_id:
                return path
        return Path(session_id) if candidate.suffix == ".jsonl" else None

    def latest(self) -> Path | None:
        files = self.files()
        if not files:
            return None
        return max(files, key=lambda path: path.stat().st_mtime)

    def list(
        self,
        *,
        live_file: str | Path | None = None,
        include_empty: bool = False,
    ) -> list[dict[str, Any]]:
        """新→旧返回会话摘要。

        宿主每次启动都会新建一个会话文件（`AgentSessionRuntime` 的默认行为），
        所以磁盘上很容易堆一批 0 条消息的空会话。列表默认把它们过滤掉，
        只保留真正聊过的会话 + 当前 live 的那一个（`include_empty=True` 可关闭过滤）。
        """

        live_path = Path(live_file).resolve() if live_file else None
        summaries: list[SessionFile] = []
        for path in self.files():
            try:
                is_live = live_path is not None and path.resolve() == live_path
            except OSError:  # pragma: no cover
                is_live = False
            session = read_session_file(path, live=is_live)
            if session is None:
                continue
            if not include_empty and session.message_count == 0 and not is_live:
                continue
            summaries.append(session)
        summaries.sort(key=lambda item: item.updated_at, reverse=True)
        return [item.to_summary() for item in summaries[: self.limit]]

    def summary_for(self, path: Path, *, live: bool = True) -> dict[str, Any] | None:
        session = read_session_file(path, live=live)
        return None if session is None else session.to_summary()

    def delete(self, session_id: str) -> Path:
        """删除一个会话文件，返回被删掉的路径。

        只允许删**自己会话目录里的 `.jsonl`**：`sessions.delete` 的参数来自前端，
        不能让它删掉任意路径（找不到 → `FileNotFoundError`，越界 → `PermissionError`）。
        「正在使用的会话」由宿主判断，这里不做业务判断。
        """

        path = self.find(session_id)
        if path is None or not path.is_file():
            raise FileNotFoundError(session_id)
        try:
            resolved = path.resolve()
        except OSError as exc:  # pragma: no cover
            raise FileNotFoundError(session_id) from exc
        boundaries = [directory.resolve() for directory in self.directories() if directory.is_dir()]
        if not any(resolved.parent == directory for directory in boundaries):
            raise PermissionError(f"会话文件不在会话目录内：{resolved}")
        path.unlink()
        return path


def iter_message_dicts(path: Path) -> Iterable[dict[str, Any]]:
    """只读遍历会话文件里的消息 dict（camelCase，来自宿主落盘格式）。"""

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines[1:]:
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict) and entry.get("type") == "message":
            data = entry.get("data")
            if isinstance(data, dict):
                yield data


__all__ = [
    "DEFAULT_LIMIT",
    "SessionFile",
    "SessionIndex",
    "iter_message_dicts",
    "read_session_file",
]
