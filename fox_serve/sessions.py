"""会话索引：把用户级 session 目录读成前端的 `SessionSummary`。

刻意只做**轻量解析**（不 import 宿主的 SessionManager）：JSONL 的第一行是
meta、之后每行一个条目（`packages/fox_coding_agent/src/core/session_manager.py:121-151`），
列表页只关心标题/条数/用量，没必要把整棵树反序列化成 pydantic 模型。

这里只扫描 `<user_dir>/sessions/--<normalized-cwd>--/session-*/session.jsonl`。
旧的项目级 `.foxcode/sessions` 不迁移、不回退，也不进入应用列表。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from fox_coding_agent.src.core.session_layout import SessionLayout, session_id_from_path

#: 列表页最多返回多少个会话。
DEFAULT_LIMIT = 50

#: 手动改名允许的最大长度（前端输入框限制同一个值）。
MAX_LABEL_LENGTH = 120

#: 分叉会话标题的后缀（前端 `lib/format.ts::branchLabel` 用同一套规则）。
BRANCH_SUFFIX = "-分支"

_BRANCH_PATTERN = re.compile(r"^(?P<root>.+?)-分支(?P<count>\d*)$")
_LEGACY_SKILL_PATTERN = re.compile(
    r"^\s*<skill\s+[^>]*name=(?:\"([^\"]+)\"|'([^']+)')[^>]*>.*?</skill>\s*(.*)$",
    re.IGNORECASE | re.DOTALL,
)


def _automatic_title(text: str) -> str:
    """Collapse pre-fix skill payloads into a readable task/name title."""

    match = _LEGACY_SKILL_PATTERN.match(text)
    if match is None:
        return text
    task = str(match.group(3) or "").strip()
    return task or f"技能 · {match.group(1) or match.group(2)}"


def branch_label(base: str) -> str:
    """分叉出来的会话叫什么：`标题-分支`，再分叉一次就是 `标题-分支2`。

    `标题` 取自分叉前的标题（手动改过就用那个，否则是首条用户消息），所以连着分叉
    不会叠成一串 `-分支-分支`。

    截断的是**原题**而不是整个结果：后缀说明这是一条分叉，裁掉它就只剩一个和原会话
    同名的标题，列表里根本分不出来。
    """

    text = " ".join(str(base or "").split()) or "新会话"
    match = _BRANCH_PATTERN.match(text)
    if match is not None:
        return _fit_branch(str(match.group("root")), f"{BRANCH_SUFFIX}{int(match.group('count') or 1) + 1}")
    return _fit_branch(text, BRANCH_SUFFIX)


def _fit_branch(root: str, suffix: str) -> str:
    """把 `root + suffix` 塞进 `MAX_LABEL_LENGTH`，优先保住后缀。"""

    return f"{root[: max(1, MAX_LABEL_LENGTH - len(suffix))]}{suffix}"


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
    entry_times: list[int] = []
    activity_times: list[int] = []

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
        timestamp = _epoch_ms(entry.get("timestamp"), 0.0)
        if not timestamp and isinstance(data, dict):
            # Message timestamps use epoch milliseconds; entry timestamps use
            # ISO strings. Older transcripts sometimes contain only the former.
            raw = data.get("timestamp")
            if isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw > 0:
                timestamp = int(raw)
        if timestamp > 0:
            entry_times.append(timestamp)
            if etype in ("message", "compaction", "branch_summary"):
                activity_times.append(timestamp)
        if etype == "message" and isinstance(data, dict):
            role = data.get("role")
            if role in ("user", "assistant"):
                message_count += 1
            if role == "user" and not title:
                title = _automatic_title(_first_text(data.get("content")))[:80]
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
        session_id=session_id_from_path(path),
        cwd=cwd,
        created_at=created_at or (
            datetime.fromtimestamp(min(entry_times) / 1000).astimezone().isoformat()
            if entry_times else _iso(mtime)
        ),
        # Opening a session can refresh tool/configuration entries and its file
        # mtime. Sidebar recency describes conversation activity, not disk I/O.
        updated_at=max(activity_times) / 1000 if activity_times else (
            min(entry_times) / 1000 if entry_times else mtime
        ),
        message_count=message_count,
        title=title,
        model=model,
        usage=usage,
        live=live,
    )


def set_session_label(path: Path, label: str | None) -> None:
    """只改会话文件第一行的 `_meta._label`，其余条目原样抄过去。

    标题的事实来源就是这里（`read_session_file` 先读 `_meta._label`，为空才退回首条
    用户消息），所以改名不必重写整棵会话树。写临时文件 + `os.replace` 与
    `JsonlSessionStorage._save()` 保持一致：中途失败不会留下半个会话文件。

    Windows 上必须先关掉源文件再 `os.replace`：替换一个还开着的文件会得到
    `PermissionError: [WinError 5]`。
    """

    temp_name = ""
    try:
        with path.open("r", encoding="utf-8") as source:
            first = source.readline()
            try:
                meta_obj = json.loads(first)
            except json.JSONDecodeError as exc:
                raise ValueError(f"会话文件头不是合法 JSON：{path}") from exc
            if not isinstance(meta_obj, dict):
                raise ValueError(f"会话文件头不是对象：{path}")
            meta = meta_obj.get("_meta")
            if not isinstance(meta, dict):
                meta = {}
                meta_obj["_meta"] = meta
            if label:
                meta["_label"] = label
            else:
                meta.pop("_label", None)
            handle = tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=str(path.parent),
                prefix=".label-",
                suffix=".tmp",
                delete=False,
            )
            temp_name = handle.name
            with handle:
                handle.write(json.dumps(meta_obj, ensure_ascii=False) + "\n")
                shutil.copyfileobj(source, handle)
                handle.flush()
                os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except BaseException:
        if temp_name:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
        raise


class SessionIndex:
    """按目录扫会话文件，供 `sessions.list` / `sessions.open` 使用。"""

    def __init__(self, *, cwd: str | Path, user_dir: str | Path, limit: int = DEFAULT_LIMIT) -> None:
        self.cwd = Path(cwd).absolute()
        self.user_dir = Path(user_dir).expanduser()
        self.layout = SessionLayout(self.user_dir / "sessions")
        self.limit = limit

    # ---- 目录 ----

    def directories(self) -> list[Path]:
        if not self.layout.root.is_dir():
            return [self.layout.workspace_dir(self.cwd)]
        return [path for path in self.layout.root.glob("--*--") if path.is_dir()]

    def files(self) -> list[Path]:
        return self.layout.files(self.cwd)

    def all_files(self) -> list[Path]:
        """Sessions for every workspace, used by the desktop workspace tree."""

        return self.layout.all_files()

    # ---- 查询 ----

    def find(self, session_id: str) -> Path | None:
        """按 id（文件名）或路径找会话文件。"""

        if not session_id:
            return None
        candidate = Path(session_id).expanduser()
        try:
            candidate_key = str(candidate.resolve()).casefold()
        except OSError:
            candidate_key = ""
        for path in self.all_files():
            try:
                same_file = candidate_key != "" and str(path.resolve()).casefold() == candidate_key
            except OSError:  # pragma: no cover
                same_file = False
            if same_file or session_id_from_path(path) == session_id or path.name == session_id:
                return path
        return None

    def latest(self) -> Path | None:
        files = self.files()
        if not files:
            return None
        return max(files, key=lambda path: path.stat().st_mtime)

    def list(self, *, live_file: str | Path | None = None,
             include_empty: bool = False) -> list[dict[str, Any]]:
        """Recent summaries from the current workspace."""
        return self._summaries(self.files(), live_file=live_file, include_empty=include_empty)

    def list_all(self, *, live_file: str | Path | None = None,
                 include_empty: bool = False) -> list[dict[str, Any]]:
        """Recent summaries across all user-level workspace buckets."""
        return self._summaries(self.all_files(), live_file=live_file, include_empty=include_empty)

    def _summaries(self, files: Iterable[Path], *, live_file: str | Path | None,
                   include_empty: bool) -> list[dict[str, Any]]:
        live_path = Path(live_file).resolve() if live_file else None
        summaries: list[SessionFile] = []
        for path in files:
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

        path = self._owned(session_id)
        path.unlink()
        try:
            path.parent.rmdir()
        except OSError:
            pass
        return path

    def rename(self, session_id: str, label: str | None) -> Path:
        """给一个历史会话改名（写 `_meta._label`），返回会话文件路径。

        边界和 `delete` 一样，只碰自己会话目录里的文件。**正在被 runtime 打开的
        会话不要走这里**：那个 storage 在内存里握着旧 label，下一次 append 触发的
        整体重写会把这里的改动覆盖掉，得让宿主走它自己的 SessionManager。
        """

        path = self._owned(session_id)
        set_session_label(path, label)
        return path

    def _owned(self, session_id: str) -> Path:
        """把 id 解析成一个属于本会话目录的现存文件。"""

        path = self.find(session_id)
        if path is None or not path.is_file():
            raise FileNotFoundError(session_id)
        try:
            resolved = path.resolve()
        except OSError as exc:  # pragma: no cover
            raise FileNotFoundError(session_id) from exc
        boundaries = [directory.resolve() for directory in self.directories() if directory.is_dir()]
        if not any(resolved.parent.parent == directory for directory in boundaries):
            raise PermissionError(f"会话文件不在会话目录内：{resolved}")
        return path


__all__ = [
    "BRANCH_SUFFIX",
    "DEFAULT_LIMIT",
    "MAX_LABEL_LENGTH",
    "SessionFile",
    "SessionIndex",
    "branch_label",
    "read_session_file",
    "set_session_label",
]
