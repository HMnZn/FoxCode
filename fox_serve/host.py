"""fox_serve 的核心：把 `AgentSessionRuntime` 包成可被 UI 驱动的宿主。

分工：

- :mod:`fox_serve.protocol` 负责「宿主对象 → 线协议 JSON」；
- :mod:`fox_serve.approvals` 负责「能不能执行」；
- :mod:`fox_serve.sessions` 负责会话索引；
- 本模块负责**编排**：订阅事件、分发 20 个命令、把授权请求接到
  `AgentSessionRuntime(before_tool_call=...)` 上。

关于权限（重要，见 `approvals.py` 的模块注释）：宿主固定的判定顺序是
「未信任项目 → 静态权限检查 → 宿主钩子 → 扩展钩子」，钩子只能收紧，不能放行。
所以这里让宿主始终以 `full-access` 运行（这样每次工具调用都会走到钩子），
真正对外生效的档位由 :class:`~fox_serve.approvals.PermissionPolicy` 持有，
`permission.set` 改的是它。`host.info.permissionMode` 上报的就是这个档位。
"""

from __future__ import annotations

import asyncio
import contextlib
import sys
import time
from pathlib import Path
from typing import Any, Callable

from . import __version__
from . import extension_catalog as catalog
from . import workspace_files
from .approvals import (
    ApprovalBroker,
    PermissionPolicy,
    build_preview,
    build_summary,
    extract_paths,
)
from .protocol import (
    PROTOCOL_VERSION,
    event_payload,
    message_payload,
    to_jsonable,
)
from .sessions import SessionIndex

#: 默认的用户级目录（与 CLI 一致：`packages/fox_coding_agent/src/core/settings.py`）。
DEFAULT_USER_DIR = Path.home() / ".foxcode"

#: `run_command` 的内置命令表（对齐 `packages/fox_coding_agent/src/cli.py:126` 的用法）。
BUILTIN_COMMANDS: tuple[dict[str, str], ...] = (
    {"name": "/new", "description": "新建会话", "argumentHint": ""},
    {"name": "/resume", "description": "打开一个已有会话文件", "argumentHint": "FILE"},
    {"name": "/fork", "description": "从当前节点分叉出新会话", "argumentHint": "[ENTRY_ID]"},
    {"name": "/cwd", "description": "切换工作目录", "argumentHint": "DIR"},
    {"name": "/reload", "description": "重新加载设置、技能与扩展", "argumentHint": ""},
    {"name": "/trust", "description": "信任当前项目", "argumentHint": ""},
    {"name": "/untrust", "description": "取消信任当前项目", "argumentHint": ""},
    {"name": "/permission", "description": "切换权限档位", "argumentHint": "MODE"},
    {"name": "/compact", "description": "压缩当前会话上下文", "argumentHint": ""},
    {"name": "/usage", "description": "查看累计用量", "argumentHint": ""},
    {"name": "/export", "description": "导出会话", "argumentHint": "FILE"},
    {"name": "/tools", "description": "列出当前可用工具", "argumentHint": ""},
    {"name": "/model", "description": "切换模型", "argumentHint": "[REFERENCE]"},
    {"name": "/thinking", "description": "设置推理强度", "argumentHint": "[LEVEL]"},
    {"name": "/skill", "description": "调用技能", "argumentHint": "NAME [ARGS]"},
    {"name": "/prompt", "description": "调用提示词模板", "argumentHint": "NAME [ARGS]"},
)

#: 扩展命令不在上表时的兜底说明。
_EXTENSION_COMMAND_HINT = "扩展提供的命令"


def content_text(payload: dict[str, Any]) -> str:
    """消息载荷里的纯文本（`content` 既可能是字符串，也可能是 part 列表）。"""

    content = payload.get("content")
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, (list, tuple)):
        return ""
    chunks: list[str] = []
    for part in content:
        if isinstance(part, str):
            chunks.append(part)
        elif isinstance(part, dict):
            text = part.get("text")
            if isinstance(text, str) and text:
                chunks.append(text)
    return "\n".join(chunks).strip()


def tool_call_parts(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """助手消息里的工具调用 part（历史回放要靠它补 `tool_execution_*` 帧）。"""

    content = payload.get("content")
    if not isinstance(content, (list, tuple)):
        return []
    return [
        part
        for part in content
        if isinstance(part, dict) and part.get("type") == "toolCall" and part.get("id")
    ]


class HostError(RuntimeError):
    """可以安全回给前端的错误（前端把它显示在时间线/提示条里）。"""


class ServeHost:
    """一个 `AgentSessionRuntime` + 一条 NDJSON 上行通道。"""

    def __init__(
        self,
        *,
        cwd: str | Path = ".",
        user_dir: str | Path | None = None,
        model: str | None = None,
        session_file: str | Path | None = None,
        thinking: str | None = None,
        permission: str | None = None,
        project_trusted: bool = True,
        ask_timeout: float = 600.0,
        send: Callable[[dict[str, Any]], None] | None = None,
        log: Callable[[str], None] | None = None,
    ) -> None:
        self.cwd = Path(cwd).absolute()
        self.user_dir = Path(user_dir).expanduser() if user_dir else DEFAULT_USER_DIR
        self.model_reference = model
        self.session_file = Path(session_file).expanduser() if session_file else None
        self.thinking = thinking
        self.permission_override = permission
        self.project_trusted = project_trusted
        self.ask_timeout = ask_timeout

        self._send = send or (lambda payload: None)
        self._log_line = log or (lambda message: None)

        self._runtime: Any | None = None
        self._policy: PermissionPolicy | None = None
        self._broker: ApprovalBroker | None = None
        self._sessions: SessionIndex | None = None
        self._tools: dict[str, Any] = {}
        self._seq = 0
        self._started_at = time.time()
        self._closed = False
        self._unsubscribe: Callable[[], None] | None = None
        #: 后台任务（`prompt` 这类长耗时操作），退出时统一取消。
        self._tasks: set[asyncio.Task[Any]] = set()
        #: `compaction_start` 时记下的上下文占用，用于给 `compaction_end` 补前后对比。
        self._pre_compact_tokens: int | None = None
        #: 前端靠帧推进状态，所以「一轮到底还在不在跑」必须由宿主自己给出：
        #: 只在收到 `agent_start`/`agent_end`/`error` 时翻转（见 `_emit_frame`）。
        #: 少了这个信号，一轮如果在模型请求里静默卡住，前端会永远停在「生成中」。
        self._agent_running = False
        self._last_frame_at = self._started_at

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """构造 runtime、挂上事件与审批钩子，并发出 `session_start`。"""

        from fox_coding_agent.src import AgentSessionRuntime, SettingsManager

        configured_mode = self.permission_override or self._configured_permission_mode(
            SettingsManager
        )
        self._policy = PermissionPolicy(configured_mode, cwd=self.cwd)
        self._broker = ApprovalBroker(
            policy=self._policy,
            on_request=self._emit_permission,
            timeout=self.ask_timeout,
            log=self._log,
        )

        self._runtime = AgentSessionRuntime(
            cwd=str(self.cwd),
            model=self.model_reference,
            session_file=str(self.session_file) if self.session_file else None,
            user_dir=str(self.user_dir),
            # 见模块文档：让每次工具调用都走到我们的审批钩子。
            settings_overrides={"permission_mode": "full-access"},
            before_tool_call=self._before_tool_call,
            project_trusted=self.project_trusted,
        )
        self._tools = {
            str(getattr(tool, "name", "")): tool
            for tool in (getattr(self._runtime.state, "tools", None) or [])
        }
        self._policy.set_cwd(self._runtime.cwd)
        self._sessions = SessionIndex(cwd=self._runtime.cwd, user_dir=self.user_dir)
        self._unsubscribe = self._runtime.subscribe(self._on_event)

        if self.thinking:
            self._apply_thinking(self.thinking)

        self._log(
            f"宿主就绪：cwd={self._runtime.cwd} 模型={self._current_model_label()} "
            f"权限={self._policy.mode}（宿主内部 full-access，档位由 sidecar 执行）"
        )
        self._emit_transport("ready")
        self._emit_session_start()

    async def stop(self) -> None:
        """收尾：作废未应答的授权、关闭 runtime。"""

        if self._closed:
            return
        self._closed = True
        for task in list(self._tasks):
            if not task.done():
                task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
            self._tasks.clear()
        if self._broker is not None:
            self._broker.cancel_all("sidecar 正在退出")
        if self._unsubscribe is not None:
            try:
                self._unsubscribe()
            except Exception:  # noqa: BLE001 - 收尾阶段不抛
                pass
            self._unsubscribe = None
        runtime = self._runtime
        if runtime is not None:
            try:
                await runtime.close()
            except Exception as exc:  # noqa: BLE001
                self._log(f"关闭 runtime 时出错：{type(exc).__name__}: {exc}")
        self._runtime = None

    @property
    def started(self) -> bool:
        return self._runtime is not None and not self._closed

    # ------------------------------------------------------------------
    # 输出通道
    # ------------------------------------------------------------------

    def _log(self, message: str) -> None:
        self._log_line(f"[fox serve] {message}")

    def _emit(self, payload: dict[str, Any]) -> None:
        try:
            self._send(payload)
        except Exception as exc:  # noqa: BLE001 - stdout 断掉时不能让 agent 崩
            self._log(f"写出失败：{type(exc).__name__}: {exc}")

    def _emit_frame(self, payload: dict[str, Any]) -> None:
        """包上 `HostFrame` 信封（seq/ts/v）后发给前端。"""

        self._seq += 1
        frame = dict(payload)
        frame["seq"] = self._seq
        frame["ts"] = int(time.time() * 1000)
        frame["v"] = PROTOCOL_VERSION
        self._last_frame_at = time.time()
        kind = frame.get("type")
        # 一轮的起止：`error` 也算结束（否则出错后前端会一直以为还在跑）。
        if kind == "agent_start":
            self._agent_running = True
        elif kind in ("agent_end", "error"):
            self._agent_running = False
        self._emit({"frame": frame})

    def _emit_transport(self, state: str, detail: str | None = None) -> None:
        status: dict[str, Any] = {
            "state": state,
            "since": int(self._started_at * 1000),
        }
        if detail:
            status["detail"] = detail
        self._emit({"event": "transport", "status": status})

    def _emit_permission(self, request: dict[str, Any]) -> None:
        self._emit({"event": "permission", "request": request})

    def _emit_session_start(self) -> None:
        runtime = self._runtime
        if runtime is None or self._policy is None:
            return
        self._emit_frame(
            {
                "type": "session_start",
                "session_file": str(getattr(runtime, "session_file", "") or ""),
                "cwd": str(getattr(runtime, "cwd", self.cwd)),
                "permission": self._policy.mode,
            }
        )

    # ------------------------------------------------------------------
    # 事件订阅
    # ------------------------------------------------------------------

    def _on_event(self, event: Any, _cancel: Any = None) -> None:
        """订阅回调：**必须快且不能抛**（抛异常会杀掉整轮，见 agent_loop.py:396）。"""

        try:
            payload = event_payload(event)
            if payload is None:
                return
            kind = payload.get("type")
            if kind == "session_shutdown":
                self._emit_transport("offline", str(payload.get("reason") or ""))
            elif kind == "compaction_start":
                # 压缩发生在轮次中间，先量一次占用，`compaction_end` 才有前后对比。
                self._pre_compact_tokens = self._context_tokens()
            elif kind == "compaction_end":
                payload = self._compaction_payload(payload)
            self._emit_frame(payload)
        except Exception as exc:  # noqa: BLE001
            self._log(f"转发事件失败：{type(exc).__name__}: {exc}")

    # ------------------------------------------------------------------
    # 上下文占用
    # ------------------------------------------------------------------

    def _context_tokens(self) -> int | None:
        """按当前分支的消息粗估上下文占用（token）。

        `usage.totalTokens` 只有在一轮结束时才有值，而压缩事件发生在轮内，
        所以这里用宿主自己的估算器
        （`packages/fox_agent_core/src/harness/compaction.py:108 estimate_context_tokens`）
        做量级估算，让 UI 在压缩后立刻能看到占用下降。
        """

        runtime = self._runtime
        session = getattr(getattr(runtime, "agent_session", None), "session", None)
        if session is None:
            return None
        try:
            entries = list(session.get_branch())
        except Exception as exc:  # noqa: BLE001
            self._log(f"估算上下文失败（读取分支）：{type(exc).__name__}: {exc}")
            return None
        messages: list[Any] = []
        for entry in entries:
            if str(getattr(entry, "type", "")) != "message":
                continue
            data = getattr(entry, "data", None)
            if data is not None and hasattr(data, "content"):
                messages.append(data)
        if not messages:
            return 0
        try:
            from fox_agent_core.src.harness.compaction import estimate_context_tokens
        except Exception as exc:  # noqa: BLE001
            self._log(f"估算上下文失败（导入估算器）：{type(exc).__name__}: {exc}")
            return None
        try:
            return int(estimate_context_tokens(messages))
        except Exception as exc:  # noqa: BLE001
            self._log(f"估算上下文失败：{type(exc).__name__}: {exc}")
            return None

    def _compaction_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        """把宿主的 `compaction_end` 收成前端要的形状。

        宿主原样发的是 `CompactionResult(summary, retained_tail, removed_count)`
        （`packages/fox_coding_agent/src/core/agent_session.py:63`），其中
        `retainedTail` 是保留下来的原始消息——整段塞进帧里又大又没用。前端只关心
        「压缩前后占用多少、删了几条、摘要是什么」。
        """

        result = payload.get("result")
        out: dict[str, Any] = {"type": "compaction_end"}
        if "automatic" in payload:
            out["automatic"] = bool(payload.get("automatic"))
        pre = self._pre_compact_tokens
        post = self._context_tokens()
        self._pre_compact_tokens = None
        if isinstance(pre, int):
            out["preTokens"] = pre
        if isinstance(post, int):
            out["postTokens"] = post
        if isinstance(result, str):
            out["result"] = result[:4000]
        elif isinstance(result, dict):
            summary = result.get("summary")
            if isinstance(summary, str):
                out["summary"] = summary[:4000]
            removed = result.get("removedCount", result.get("removed_count"))
            if isinstance(removed, int):
                out["removedCount"] = removed
            tail = result.get("retainedTail", result.get("retained_tail"))
            if isinstance(tail, list):
                out["retainedCount"] = len(tail)
        return out

    # ------------------------------------------------------------------
    # 审批钩子（= UI 的「等待你的授权」）
    # ------------------------------------------------------------------

    async def _before_tool_call(self, data: Any, cancel: Any = None) -> dict[str, Any] | None:
        """`AgentSessionRuntime(before_tool_call=...)` 的实现。

        返回 ``None`` 放行；返回 ``{"block": True, "reason": ...}`` 拒绝该次调用。
        异常一律放行，避免把整个 agent 轮次带崩。
        """

        try:
            policy = self._policy
            broker = self._broker
            if policy is None or broker is None:
                return None
            payload = data if isinstance(data, dict) else {}
            call = payload.get("tool_call")
            name = str(getattr(call, "name", "") or payload.get("tool_name") or "")
            if not name:
                return None
            args = payload.get("args")
            tool = self._tools.get(name)
            required = str(getattr(tool, "required_permission", "full-access") or "full-access")
            permission_paths = getattr(tool, "permission_paths", None)

            decision = policy.evaluate(
                tool_name=name,
                required=required,
                args=args,
                permission_paths=permission_paths,
            )
            if decision.action == "allow":
                return None
            if decision.action == "block":
                self._log(f"拒绝 {name}：{decision.detail}")
                return {"block": True, "reason": decision.detail}

            paths = list(decision.paths) or extract_paths(args, permission_paths)
            verdict = await broker.ask(
                tool_call_id=getattr(call, "id", None),
                tool_name=name,
                args=to_jsonable(args),
                required=required,
                summary=build_summary(name, required, paths, args),
                request_extra={
                    "reason": decision.reason,
                    "path": decision.path or (paths[0] if paths else None),
                    "preview": build_preview(name, args, required, paths),
                },
                cancel=cancel,
            )
            if verdict == "deny":
                return {"block": True, "reason": "用户在桌面上拒绝了这次工具调用"}
            if verdict == "allow-session":
                policy.allow_tool(name)
            return None
        except Exception as exc:  # noqa: BLE001
            self._log(f"审批钩子异常，已放行：{type(exc).__name__}: {exc}")
            return None

    # ------------------------------------------------------------------
    # 命令分发
    # ------------------------------------------------------------------

    async def handle(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """处理一条请求（与 `desktop/electron/sidecar.js` 的方法名一一对应）。"""

        handler = getattr(self, f"_cmd_{method.replace('.', '_')}", None)
        if handler is None:
            raise HostError(f"未知方法：{method}")
        return await handler(dict(params or {}))

    def _require_runtime(self) -> Any:
        if self._runtime is None or self._closed:
            raise HostError("宿主运行时尚未就绪或已关闭")
        return self._runtime

    # ---- host.info ----

    async def _cmd_host_info(self, _params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        assert self._policy is not None
        thinking = self._thinking_level()
        extensions, available_extensions = self._extension_views_safe()
        return {
            "transport": "sidecar",
            "hostVersion": __version__,
            "protocolVersion": PROTOCOL_VERSION,
            "cwd": str(getattr(runtime, "cwd", self.cwd)),
            "sessionFile": str(getattr(runtime, "session_file", "") or ""),
            # 当前上下文占用的量级估算：前端在还没拿到任何 usage 之前先用它显示进度。
            "contextTokens": self._context_tokens(),
            "permissionMode": self._policy.mode,
            "thinkingLevel": thinking,
            "model": self._model_info(getattr(runtime.state, "model", None)),
            "availableModels": [
                self._model_info(getattr(entry, "model", entry))
                for entry in (getattr(runtime, "available_models", None) or [])
            ],
            "skills": self._skills(),
            "commands": self._commands(),
            "extensions": extensions,
            # 可发现但当前没生效的扩展：前端「扩展」页用它渲染「可加载」分组。
            "availableExtensions": available_extensions,
            "projectTrusted": bool(getattr(runtime, "project_trusted", self.project_trusted)),
            "sidecarConnected": True,
            # 一轮到底还在不在跑 + 最近一帧是什么时候。前端在「生成中」时用它
            # 对账：宿主已经空闲却还显示生成中，就说明结束帧丢了（或这一轮静默
            # 卡死），必须自己解锁，不能让用户永远只能看着「生成中」。
            "busy": self._agent_running,
            "lastFrameAt": int(self._last_frame_at * 1000),
            # 以下字段前端不认识（多余字段会被忽略），主要用于诊断。
            "engine": "fox_serve",
            "runtimePermissionMode": getattr(runtime, "permission_mode", None),
            "policy": self._policy.snapshot(),
            "hostPid": __import__("os").getpid(),
        }

    # ---- 会话 ----

    async def _cmd_sessions_list(self, _params: dict[str, Any]) -> list[dict[str, Any]]:
        runtime = self._require_runtime()
        assert self._sessions is not None
        return self._sessions.list(live_file=getattr(runtime, "session_file", None))

    async def _cmd_sessions_open(self, params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        assert self._sessions is not None
        identifier = str(params.get("id") or params.get("file") or "")
        path = self._sessions.find(identifier)
        if path is None or not Path(path).is_file():
            raise HostError(f"找不到会话：{identifier or '(空)'}")
        await runtime.switch_session(str(path))
        assert self._policy is not None
        self._policy.reset_allowlist()
        self._policy.set_cwd(runtime.cwd)
        self._sessions = SessionIndex(cwd=runtime.cwd, user_dir=self.user_dir)
        self._emit_session_start()
        replayed = self._replay_current_session()
        self._log(f"打开会话 {path.name}，回放 {replayed} 条消息")
        summary = self._sessions.summary_for(Path(path), live=True)
        return summary or {"id": Path(path).stem, "file": str(path), "title": Path(path).stem}

    async def _cmd_sessions_new(self, _params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        # `AgentSessionRuntime.new_session()` 没有返回值
        # （packages/fox_coding_agent/src/core/runtime.py:463-464 只 await 了 _replace），
        # 新会话的路径要从 runtime.session_file 读——以前这里写成 Path(None) 会直接崩。
        await runtime.new_session()
        path = self._current_session_path(runtime)
        assert self._policy is not None
        self._policy.reset_allowlist()
        self._policy.set_cwd(runtime.cwd)
        self._emit_session_start()
        assert self._sessions is not None
        summary = self._sessions.summary_for(path, live=True)
        return summary or {"id": path.stem, "file": str(path), "title": "新会话"}

    @staticmethod
    def _current_session_path(runtime: Any) -> Path:
        """runtime 当前会话文件的路径（`new_session`/`fork` 之后由 `_install` 写入）。"""

        raw = str(getattr(runtime, "session_file", "") or "").strip()
        if not raw:
            raise HostError("宿主没有给出会话文件路径")
        return Path(raw)

    async def _cmd_sessions_delete(self, params: dict[str, Any]) -> dict[str, Any]:
        """删除一个历史会话文件。

        「当前正在使用的会话」不删（否则内存里的 runtime 会指向一个不存在的文件）。
        """

        runtime = self._require_runtime()
        assert self._sessions is not None
        identifier = str(params.get("id") or params.get("sessionId") or params.get("file") or "")
        if not identifier:
            raise HostError("sessions.delete 需要一个 id")
        path = self._sessions.find(identifier)
        if path is None or not Path(path).is_file():
            raise HostError(f"找不到会话：{identifier}")
        live = getattr(runtime, "session_file", None)
        try:
            is_live = live is not None and Path(path).resolve() == Path(live).resolve()
        except OSError:  # pragma: no cover
            is_live = False
        if is_live:
            raise HostError("不能删除当前正在使用的会话，请先新建或切换到别的会话")
        try:
            deleted = self._sessions.delete(identifier)
        except PermissionError as exc:
            raise HostError(str(exc)) from exc
        except FileNotFoundError as exc:
            raise HostError(f"找不到会话：{identifier}") from exc
        except OSError as exc:
            raise HostError(f"删除会话失败：{exc}") from exc
        self._log(f"删除会话 {deleted.name}")
        return {"id": deleted.stem, "file": str(deleted)}

    async def _cmd_sessions_fork(self, params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        from_id = params.get("fromId") or params.get("from_id")
        path = await runtime.fork(str(from_id) if from_id else None)
        self._emit_session_start()
        replayed = self._replay_current_session()
        assert self._sessions is not None
        self._log(f"分叉出新会话 {Path(path).name}，回放 {replayed} 条消息")
        summary = self._sessions.summary_for(Path(path), live=True)
        return summary or {"id": Path(path).stem, "file": str(path), "title": "分叉会话"}

    async def _cmd_session_export(self, params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        fmt = str(params.get("format") or "json").lower()
        target = params.get("path") or params.get("file")
        if not target:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            suffix = "md" if fmt.startswith("mark") else "json"
            target = str(Path(runtime.cwd) / f"foxcode-session-{stamp}.{suffix}")
        path = runtime.export_session(str(target), format="markdown" if fmt.startswith("mark") else "json")
        self._log(f"导出会话 → {path}")
        return {"path": str(path)}

    def _replay_current_session(self) -> int:
        """把当前会话的历史消息按 `message_end` 帧回放给前端。

        前端 `sessions.open` 的约定（`desktop/src/bridge/mock/mockHost.ts`）：
        先 `session_start`，再逐条 `message_end`，最后返回 summary。

        但**只有 `message_end` 不够**：真实会话里「一轮只有工具调用、没有正文」
        的助手消息很常见（模型先调工具、下一轮才说话），而 UI 的会话视图只在
        工具帧（`tool_execution_start/end`）到达时才建卡片。所以这里把助手消息
        的 `toolCall` part 补成 `tool_execution_start`，把 `toolResult` 消息补成
        `tool_execution_end`，回放完再补一个 `agent_end` 把状态从「执行中」归位。
        """

        runtime = self._runtime
        if runtime is None:
            return 0
        session = getattr(getattr(runtime, "agent_session", None), "session", None)
        if session is None:
            return 0
        try:
            entries = session.get_branch()
        except Exception as exc:  # noqa: BLE001
            self._log(f"读取会话分支失败：{type(exc).__name__}: {exc}")
            return 0
        count = 0
        tool_frames = 0
        for entry in entries:
            if str(getattr(entry, "type", "")) != "message":
                continue
            payload = message_payload(getattr(entry, "data", None))
            if not isinstance(payload, dict) or payload.get("role") not in (
                "user",
                "assistant",
                "toolResult",
            ):
                continue
            role = payload["role"]
            self._emit_frame({"type": "message_end", "message": payload})
            if role == "assistant":
                for call in tool_call_parts(payload):
                    args = call.get("arguments")
                    if not isinstance(args, dict):
                        args = call.get("args") if isinstance(call.get("args"), dict) else {}
                    self._emit_frame(
                        {
                            "type": "tool_execution_start",
                            "tool_call_id": call.get("id"),
                            "tool_name": call.get("name"),
                            "args": args or {},
                        }
                    )
                    tool_frames += 1
            elif role == "toolResult":
                self._emit_frame(
                    {
                        "type": "tool_execution_end",
                        "tool_call_id": payload.get("toolCallId"),
                        "tool_name": payload.get("toolName") or "",
                        "result": content_text(payload),
                        "is_error": bool(payload.get("isError")),
                    }
                )
            count += 1
        if tool_frames:
            self._emit_frame({"type": "agent_end"})
        return count

    # ---- 对话 ----

    async def _cmd_prompt(self, params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        message = params.get("message")
        if not isinstance(message, str) or not message.strip():
            raise HostError("prompt 需要一个非空的 message")
        options = params.get("options") or {}
        queue_as = str(options.get("queueAs") or options.get("queue_as") or "").strip()
        if queue_as == "steer":
            self._enqueue("steer", message)
            return {"queued": "steer"}
        if queue_as in ("follow_up", "followUp"):
            self._enqueue("follow_up", message)
            return {"queued": "follow_up"}

        # 一轮对话可能要跑几分钟，而前端 sidecar 客户端对单个请求有超时。
        # 所以这里立刻返回，把这一轮放到后台 task 里跑：进度/结束全部由帧
        # （agent_start / tool_execution_* / agent_end）驱动，和 UI 的模型一致。
        self._agent_running = True
        self._spawn_task(self._run_prompt(message), name="prompt")
        return {"queued": "prompt"}

    async def _run_prompt(self, message: str) -> None:
        runtime = self._runtime
        if runtime is None:
            self._agent_running = False
            return
        try:
            await runtime.prompt(message)
        except asyncio.CancelledError:  # pragma: no cover - 退出时取消
            raise
        except Exception as exc:  # noqa: BLE001 - 失败要变成错误帧，前端才会显示
            self._log(f"prompt 失败：{type(exc).__name__}: {exc}")
            self._emit_frame({"type": "error", "error": f"{type(exc).__name__}: {exc}"})
        finally:
            # `runtime.prompt()` 返回或抛错都代表这一轮真的结束了（它 await 的是
            # 整轮 agent loop），所以这里必须把忙碌标志放下：否则一轮异常收尾后
            # `host.info.busy` 会永远停在 true，前端只能一直显示「生成中」。
            self._agent_running = False

    def _spawn_task(self, coro: Any, *, name: str) -> None:
        task = asyncio.ensure_future(coro)
        task.set_name(f"fox_serve:{name}")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _cmd_steer(self, params: dict[str, Any]) -> dict[str, Any]:
        self._require_runtime()
        message = str(params.get("message") or "")
        if not message.strip():
            raise HostError("steer 需要一个非空的 message")
        self._require_running("steer")
        self._enqueue("steer", message)
        return {"queued": "steer"}

    async def _cmd_follow_up(self, params: dict[str, Any]) -> dict[str, Any]:
        self._require_runtime()
        message = str(params.get("message") or "")
        if not message.strip():
            raise HostError("follow_up 需要一个非空的 message")
        self._require_running("follow_up")
        self._enqueue("follow_up", message)
        return {"queued": "follow_up"}

    def _require_running(self, kind: str) -> None:
        """没有在跑的一轮时拒绝插话。

        `session.steer()` / `session.follow_up()` 只是把消息塞进队列，**没有正在
        运行的一轮就永远没人消费**：前端会看到「已插话」而正文再也不动，这正是
        「插入也不回去」的成因。让宿主把这件事说清楚，前端才能退回普通发送。
        """

        if not self._agent_running:
            raise HostError(f"当前没有正在运行的一轮，{kind} 不会被消费；请直接发送这条消息")

    def _enqueue(self, kind: str, message: str) -> None:
        """`steer` / `follow_up` 是同步入队（`harness.py:89-93`），运行中插话走这里。"""

        runtime = self._require_runtime()
        session = getattr(runtime, "agent_session", None)
        target = None
        if session is not None:
            target = getattr(session, kind, None)
            if target is None:
                agent = getattr(session, "agent", None)
                target = getattr(agent, kind, None)
        if target is None:
            raise HostError(f"当前宿主不支持 {kind}（运行中插话）")
        target(message)
        self._log(f"{kind} 已入队：{message[:60]}")

    async def _cmd_abort(self, _params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        runtime.abort()
        if self._broker is not None:
            self._broker.cancel_all("会话已中止")
        return {"aborted": True}

    async def _cmd_compact(self, _params: dict[str, Any]) -> Any:
        runtime = self._require_runtime()
        result = await runtime.compact()
        return to_jsonable(result)

    async def _cmd_invoke_skill(self, params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        name = str(params.get("name") or "").strip()
        if not name:
            raise HostError("invoke_skill 需要 name")
        instructions = str(params.get("instructions") or "")
        try:
            result = await runtime.invoke_skill(name, instructions)
        except ValueError as exc:
            raise HostError(str(exc)) from exc
        return {"ok": True, "result": to_jsonable(result)}

    async def _reload_runtime(self) -> None:
        """重载设置/扩展，并刷新 cwd 绑定的工具表。"""

        runtime = self._require_runtime()
        await runtime.reload()
        self._tools = {
            str(getattr(tool, "name", "")): tool
            for tool in (getattr(runtime.state, "tools", None) or [])
        }
        self._emit_session_start()

    async def _cmd_reload(self, _params: dict[str, Any]) -> dict[str, Any]:
        await self._reload_runtime()
        return {"ok": True}

    # ---- 设置 ----

    async def _cmd_model_select(self, params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        reference = str(params.get("reference") or params.get("id") or "").strip()
        if not reference:
            raise HostError("model.select 需要 reference")
        try:
            model = runtime.select_model(reference)
        except ValueError as exc:
            raise HostError(str(exc)) from exc
        return self._model_info(model)

    async def _cmd_thinking_set(self, params: dict[str, Any]) -> dict[str, Any]:
        level = str(params.get("level") or "").strip()
        if not level:
            raise HostError("thinking.set 需要 level")
        self._apply_thinking(level)
        return {"thinkingLevel": self._thinking_level()}

    def _apply_thinking(self, level: str) -> None:
        runtime = self._require_runtime()
        try:
            runtime.set_thinking_level(level)
        except ValueError as exc:
            raise HostError(str(exc)) from exc
        self.thinking = level
        self._log(f"推理强度 → {level}")

    def _thinking_level(self) -> str:
        runtime = self._runtime
        level = getattr(getattr(runtime, "state", None), "thinking_level", None)
        if not level:
            level = self.thinking
        return str(level or "off")

    async def _cmd_permission_set(self, params: dict[str, Any]) -> dict[str, Any]:
        self._require_runtime()
        assert self._policy is not None
        try:
            mode = self._policy.set_mode(str(params.get("mode") or ""))
        except ValueError as exc:
            raise HostError(str(exc)) from exc
        self._log(f"权限档位 → {mode}（宿主内部仍为 full-access，静态检查不会抢先拒绝）")
        return {"permissionMode": mode}

    async def _cmd_trust_set(self, params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        trusted = bool(params.get("trusted"))
        await runtime.set_project_trust(trusted)
        try:
            from fox_coding_agent.src.core.trust import ProjectTrustManager

            ProjectTrustManager(self.user_dir).set(str(runtime.cwd), trusted)
        except Exception as exc:  # noqa: BLE001 - 持久化失败不影响本会话
            self._log(f"写入项目信任失败：{type(exc).__name__}: {exc}")
        self._emit_session_start()
        return {"projectTrusted": trusted}

    async def _cmd_cwd_change(self, params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        cwd = str(params.get("cwd") or "").strip()
        if not cwd:
            raise HostError("cwd.change 需要 cwd")
        # 会话、信任状态、技能都挂在 `<cwd>/.foxcode` 下。目录不存在或不可写时，
        # runtime 会在很深的地方抛一个英文 `PermissionError`，界面只能把原文糊给
        # 用户（「工作区无法切换」但看不出为什么）。所以这里先自己检查一遍，用中文
        # 说清楚是「不存在」还是「不可写」。
        target = Path(cwd).expanduser()
        if not target.is_dir():
            raise HostError(f"工作区不存在或不是目录：{target}")
        marker = target / ".foxcode"
        try:
            await asyncio.to_thread(marker.mkdir, parents=True, exist_ok=True)
        except OSError as exc:
            raise HostError(
                f"工作区不可写：无法创建 {marker}（{type(exc).__name__}: {exc}）"
            ) from exc
        try:
            await runtime.change_cwd(str(target))
        except Exception as exc:  # noqa: BLE001 - 统一翻译成宿主错误，交给界面显示
            raise HostError(f"切换工作区失败：{type(exc).__name__}: {exc}") from exc
        assert self._policy is not None
        self._policy.reset_allowlist()
        self._policy.set_cwd(runtime.cwd)
        self.cwd = Path(runtime.cwd)
        self._sessions = SessionIndex(cwd=runtime.cwd, user_dir=self.user_dir)
        self._emit_session_start()
        return {"cwd": str(runtime.cwd)}

    # ---- 工作区文件（右侧栏的「改了哪些文件 / 预览」） ----
    #
    # 这三个命令只读、不碰 runtime 状态，所以不需要 `_require_runtime()`：
    # 工作区门还没选完、runtime 还没起来时也应该能回答。

    def _workspace_root(self) -> Path:
        runtime = self._runtime
        if runtime is not None:
            raw = str(getattr(runtime, "cwd", "") or "").strip()
            if raw:
                return Path(raw)
        return Path(self.cwd)

    async def _cmd_files_changes(self, params: dict[str, Any]) -> dict[str, Any]:
        limit = params.get("limit")
        count = int(limit) if isinstance(limit, int) and limit > 0 else 300
        return await workspace_files.changes(self._workspace_root(), limit=count)

    async def _cmd_files_diff(self, params: dict[str, Any]) -> dict[str, Any]:
        path = str(params.get("path") or "").strip()
        context = params.get("context")
        try:
            return await workspace_files.diff(
                self._workspace_root(),
                path,
                context=int(context) if isinstance(context, int) else 3,
            )
        except workspace_files.WorkspaceFileError as exc:
            raise HostError(str(exc)) from exc

    async def _cmd_files_read(self, params: dict[str, Any]) -> dict[str, Any]:
        path = str(params.get("path") or "").strip()
        max_bytes = params.get("maxBytes")
        kwargs: dict[str, Any] = {}
        if isinstance(max_bytes, int) and max_bytes > 0:
            kwargs["max_bytes"] = max_bytes
        try:
            return await workspace_files.read(self._workspace_root(), path, **kwargs)
        except workspace_files.WorkspaceFileError as exc:
            raise HostError(str(exc)) from exc

    # ---- 审批 ----

    async def _cmd_permission_answer(self, params: dict[str, Any]) -> dict[str, Any]:
        broker = self._broker
        if broker is None:
            raise HostError("宿主尚未就绪，无法应答授权")
        request_id = str(params.get("id") or "")
        decision = str(params.get("decision") or "deny")
        reason = params.get("reason")
        accepted = broker.answer(request_id, decision, str(reason) if reason else None)
        if not accepted:
            raise HostError(f"授权请求已失效：{request_id}")
        return {"accepted": True}

    # ---- 内置命令（run_command） ----

    async def _cmd_run_command(self, params: dict[str, Any]) -> Any:
        runtime = self._require_runtime()
        name = str(params.get("name") or "").lstrip("/").strip()
        arguments = str(params.get("arguments") or "").strip()
        if not name:
            raise HostError("run_command 需要 name")

        table: dict[str, Any] = {
            "new": self._cmd_sessions_new,
            "session": self._cmd_sessions_open,
            "resume": self._builtin_resume,
            "fork": self._cmd_sessions_fork,
            "cwd": self._cmd_cwd_change,
            "reload": self._cmd_reload,
            "trust": self._builtin_trust,
            "untrust": self._builtin_untrust,
            "permission": self._builtin_permission,
            "compact": self._cmd_compact,
            "usage": self._builtin_usage,
            "export": self._builtin_export,
            "tools": self._builtin_tools,
            "model": self._builtin_model,
            "thinking": self._builtin_thinking,
            "skill": self._builtin_skill,
            "prompt": self._builtin_prompt,
        }
        handler = table.get(name)
        if handler is not None:
            result = await handler({"arguments": arguments})
            return {"name": name, "result": result if result is not None else {"ok": True}}

        try:
            result = await runtime.run_command(name, arguments)
        except ValueError as exc:
            raise HostError(str(exc)) from exc
        return {"name": name, "result": to_jsonable(result)}

    async def _builtin_resume(self, params: dict[str, Any]) -> Any:
        arguments = str(params.get("arguments") or "")
        if not arguments:
            assert self._sessions is not None
            latest = self._sessions.latest()
            if latest is None:
                raise HostError("没有可恢复的会话")
            arguments = str(latest)
        return await self._cmd_sessions_open({"id": arguments})

    async def _builtin_trust(self, _params: dict[str, Any]) -> Any:
        return await self._cmd_trust_set({"trusted": True})

    async def _builtin_untrust(self, _params: dict[str, Any]) -> Any:
        return await self._cmd_trust_set({"trusted": False})

    async def _builtin_permission(self, params: dict[str, Any]) -> Any:
        arguments = str(params.get("arguments") or "")
        if not arguments:
            assert self._policy is not None
            return {"permissionMode": self._policy.mode}
        return await self._cmd_permission_set({"mode": arguments})

    async def _builtin_usage(self, _params: dict[str, Any]) -> Any:
        runtime = self._require_runtime()
        return to_jsonable(runtime.usage_totals)

    async def _builtin_export(self, params: dict[str, Any]) -> Any:
        arguments = str(params.get("arguments") or "")
        payload: dict[str, Any] = {}
        if arguments:
            payload["path"] = arguments
            payload["format"] = "markdown" if arguments.lower().endswith(".md") else "json"
        return await self._cmd_session_export(payload)

    async def _builtin_tools(self, _params: dict[str, Any]) -> Any:
        return {"tools": sorted(self._tools)}

    async def _builtin_model(self, params: dict[str, Any]) -> Any:
        arguments = str(params.get("arguments") or "")
        if not arguments:
            return {"model": self._model_info(getattr(self._require_runtime().state, "model", None))}
        return await self._cmd_model_select({"reference": arguments})

    async def _builtin_thinking(self, params: dict[str, Any]) -> Any:
        arguments = str(params.get("arguments") or "")
        if not arguments:
            return {"thinkingLevel": self._thinking_level()}
        return await self._cmd_thinking_set({"level": arguments})

    async def _builtin_skill(self, params: dict[str, Any]) -> Any:
        arguments = str(params.get("arguments") or "")
        name, _, rest = arguments.partition(" ")
        if not name:
            raise HostError("用法：/skill NAME [ARGS]")
        return await self._cmd_invoke_skill({"name": name, "instructions": rest})

    async def _builtin_prompt(self, params: dict[str, Any]) -> Any:
        runtime = self._require_runtime()
        arguments = str(params.get("arguments") or "")
        name, _, rest = arguments.partition(" ")
        if not name:
            raise HostError("用法：/prompt NAME [ARGS]")
        try:
            result = await runtime.invoke_prompt(name, rest)
        except ValueError as exc:
            raise HostError(str(exc)) from exc
        return {"ok": True, "result": to_jsonable(result)}

    # ------------------------------------------------------------------
    # host.info 的各段
    # ------------------------------------------------------------------

    def _configured_permission_mode(self, settings_manager_cls: Any) -> str:
        """读项目/用户设置里的权限档位（在构造 runtime 之前）。"""

        try:
            manager = settings_manager_cls(
                str(self.cwd), user_dir=str(self.user_dir), project_trusted=self.project_trusted
            )
            reload_fn = getattr(manager, "reload", None)
            if callable(reload_fn):
                reload_fn()
            mode = getattr(getattr(manager, "settings", None), "permission_mode", None)
            if isinstance(mode, str) and mode:
                return mode
        except Exception as exc:  # noqa: BLE001
            self._log(f"读取 settings 失败，按 workspace-write 处理：{type(exc).__name__}: {exc}")
        return "workspace-write"

    def _current_model_label(self) -> str:
        runtime = self._runtime
        model = getattr(getattr(runtime, "state", None), "model", None)
        return str(getattr(model, "name", "") or getattr(model, "id", "") or "未知模型")

    def _output_limit(self, model: Any) -> int | None:
        """本次请求真正会发出去的 `max_tokens`（思考与答案共享同一个上限）。

        取值顺序与 `agent_loop._stream_assistant_response` 一致：会话 stream_options
        → 用户 settings → 模型 registry 的 maxTokens。界面拿它解释「回答为什么被
        截断」，以及显示当前到底允许输出多少 token。
        """

        runtime = self._runtime
        session = getattr(runtime, "agent_session", None)
        sources = (
            getattr(getattr(session, "session_config", None), "stream_options", None),
            getattr(
                getattr(getattr(runtime, "settings_manager", None), "settings", None),
                "stream_options",
                None,
            ),
        )
        for source in sources:
            if isinstance(source, dict):
                value = source.get("max_tokens")
                if isinstance(value, int) and value > 0:
                    return value
        value = getattr(model, "max_tokens", None)
        return value if isinstance(value, int) and value > 0 else None

    def _model_info(self, model: Any) -> dict[str, Any] | None:
        """`ModelInfo`（`id` 用 registry 的 reference，便于 `model.select` 精确解析）。"""

        if model is None:
            return None
        runtime = self._runtime
        model_id = str(getattr(model, "id", "") or "")
        entry = None
        for candidate in getattr(runtime, "available_models", None) or []:
            candidate_model = getattr(candidate, "model", candidate)
            if str(getattr(candidate_model, "id", "")) == model_id:
                entry = candidate
                break
        if entry is not None:
            model = getattr(entry, "model", model)
        cost = getattr(model, "cost", None)
        return {
            "id": str(getattr(entry, "reference", "") or model_id),
            "provider": str(getattr(model, "provider", "") or ""),
            "displayName": str(getattr(model, "name", "") or model_id),
            "contextWindow": getattr(model, "context_window", None),
            "maxTokens": getattr(model, "max_tokens", None),
            "outputLimit": self._output_limit(model),
            "supportsThinking": bool(getattr(model, "reasoning", False)),
            "supportsTools": True,
            "costPerMTokIn": getattr(cost, "input", None),
            "costPerMTokOut": getattr(cost, "output", None),
            "modelId": model_id,
        }

    def _skills(self) -> list[dict[str, Any]]:
        session = getattr(self._runtime, "agent_session", None)
        skills = list(getattr(session, "skills", None) or [])
        out: list[dict[str, Any]] = []
        for skill in skills:
            path = getattr(skill, "file_path", None)
            out.append(
                {
                    "name": str(getattr(skill, "name", "") or ""),
                    "description": str(getattr(skill, "description", "") or ""),
                    "source": str(path) if path else "user",
                    "enabled": not bool(getattr(skill, "disable_model_invocation", False)),
                }
            )
        return out

    def _extension_api(self) -> Any:
        session = getattr(self._runtime, "agent_session", None)
        return getattr(getattr(session, "extensions", None), "api", None)

    def _commands(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = [dict(item) for item in BUILTIN_COMMANDS]
        seen = {item["name"].lstrip("/") for item in items}
        api = self._extension_api()
        commands = getattr(api, "commands", None)
        if isinstance(commands, dict):
            for name, value in commands.items():
                key = str(name).lstrip("/")
                if key in seen:
                    continue
                description = ""
                if isinstance(value, (tuple, list)) and len(value) >= 2:
                    description = str(value[1] or "")
                items.append(
                    {
                        "name": f"/{key}",
                        "description": description or _EXTENSION_COMMAND_HINT,
                        "argumentHint": "",
                    }
                )
        return items

    # ---- 扩展 ----

    def _extension_settings(self) -> tuple[Path, Path, bool]:
        """(用户级 settings、项目级 settings、项目是否受信任)。"""

        runtime = self._runtime
        manager = getattr(runtime, "settings_manager", None)
        user_dir = Path(getattr(runtime, "user_dir", self.user_dir))
        cwd = Path(getattr(runtime, "cwd", self.cwd))
        user_path = Path(getattr(manager, "user_path", user_dir / "settings.json"))
        project_path = Path(getattr(manager, "project_path", cwd / ".foxcode" / "settings.json"))
        trusted = bool(getattr(runtime, "project_trusted", self.project_trusted))
        return user_path, project_path, trusted

    def _extension_candidates(self) -> list[catalog.Candidate]:
        runtime = self._runtime
        return catalog.discover(
            user_dir=Path(getattr(runtime, "user_dir", self.user_dir)),
            cwd=Path(getattr(runtime, "cwd", self.cwd)),
        )

    def _extension_views(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """(当前生效的扩展、可发现但未生效的扩展)。"""

        user_path, project_path, trusted = self._extension_settings()
        scope = catalog.effective_scope(user_path, project_path)
        present = catalog.specs_present_in(user_path, project_path)
        configured = catalog.describe_configured(
            catalog.effective_specs(user_path, project_path), scope=scope, present_in=present
        )
        available = catalog.describe_available(
            self._extension_candidates(),
            scope=catalog.suggested_scope(user_path, project_path, project_trusted=trusted),
            configured={str(item["spec"]) for item in configured},
            present_in=present,
        )
        return configured, available

    def _extension_views_safe(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        try:
            return self._extension_views()
        except Exception as exc:  # 扩展目录异常不应该让 host.info 整体失败
            self._log(f"扩展信息读取失败：{exc}")
            return [], []

    def _extensions(self) -> list[dict[str, Any]]:
        """当前生效的扩展（含探测出的贡献面）。"""

        return self._extension_views_safe()[0]

    def _resolve_extension_spec(self, raw: str) -> str:
        """把前端给的花名 / 文件路径 / spec 归一成能写进 settings 的字符串。"""

        spec = raw.strip()
        kind = catalog.spec_kind(spec)
        if kind in {"module", "entrypoint"}:
            return spec
        if kind == "file" and (spec.endswith(".py") or "/" in spec or "\\" in spec):
            return str(Path(spec).expanduser().resolve())
        user_path, project_path, _trusted = self._extension_settings()
        for candidate in self._extension_candidates():
            if spec in {candidate.name, candidate.spec, Path(candidate.path).stem}:
                return candidate.spec
        for existing in catalog.effective_specs(user_path, project_path):
            if catalog.spec_name(existing) == spec:
                return existing
        return spec

    def _write_extensions(self, scope: str, specs: list[str]) -> None:
        """把一个作用域的 `extensions` 列表整体写回（SettingsManager 会原子写 + 校验）。"""

        manager = getattr(self._runtime, "settings_manager", None)
        if manager is None:
            raise HostError("这个宿主没有设置管理器，无法写入扩展配置")
        try:
            manager.update({"extensions": list(dict.fromkeys(specs))}, scope=scope)
        except PermissionError as exc:
            raise HostError(f"项目未受信任，不能写入项目级扩展配置：{exc}") from exc
        except ValueError as exc:
            hint = "（检查用户级 settings.json 里是否留有已废弃的键，例如 `memory`）" if scope == "user" else ""
            raise HostError(f"扩展配置无法写入{hint}：{exc}") from exc

    async def _cmd_extensions_set(self, params: dict[str, Any]) -> dict[str, Any]:
        """启用/关闭一个扩展：改 settings.json → 热重载；重载失败则回滚配置。

        语义（与 `RuntimeSettings` 的合并规则对齐）：
        - 「生效」= spec 出现在**生效作用域**的 `extensions` 列表里（项目级有该键则项目级胜出）；
        - 启用 → 追加进目标作用域；
        - 关闭 → 从所有作用域移除，否则另一个文件会把它重新打开。
        """

        self._require_runtime()
        raw = str(params.get("id") or params.get("spec") or params.get("path") or "").strip()
        if not raw:
            raise HostError("extensions.set 需要 id（扩展名、spec 或文件路径）")
        enabled = bool(params.get("enabled", True))
        spec = self._resolve_extension_spec(raw)

        user_path, project_path, trusted = self._extension_settings()
        locations = {"user": user_path, "project": project_path}
        present = catalog.specs_present_in(user_path, project_path)
        here = present.get(spec, [])

        target = str(params.get("scope") or "").strip()
        if target not in catalog.SCOPES:
            target = here[0] if here else catalog.suggested_scope(
                user_path, project_path, project_trusted=trusted
            )
        if target == "project" and not trusted:
            raise HostError('项目未受信任，不能写入项目级扩展配置（可传 scope:"user"，或先信任项目）')

        before = {scope: catalog.read_configured(path) for scope, path in locations.items()}
        desired = {scope: list(specs) for scope, specs in before.items()}
        if enabled:
            current = desired[target]
            if spec not in current:
                # 用户已有的顺序保持不动，只给新条目挑一个确定的位置：排在第一个
                # 「字典序更大」的条目之前 —— 关掉再打开就能回到原来的槽位。
                index = next((i for i, item in enumerate(current) if item > spec), len(current))
                current.insert(index, spec)
        else:
            for scope in catalog.SCOPES:
                desired[scope] = [item for item in desired[scope] if item != spec]

        touched = [scope for scope in catalog.SCOPES if desired[scope] != before[scope]]
        for scope in touched:
            self._write_extensions(scope, desired[scope])
        if touched:
            try:
                await self._reload_runtime()
            except Exception as exc:
                for scope in touched:
                    with contextlib.suppress(Exception):
                        self._write_extensions(scope, before[scope])
                with contextlib.suppress(Exception):
                    await self._reload_runtime()
                raise HostError(f"扩展没能加载，已回滚到原来的配置：{exc}") from exc

        configured, available = self._extension_views_safe()
        live = {str(item["spec"]) for item in configured}
        if touched and ((spec in live) != enabled):
            raise HostError(f"{spec} 已写入配置但没有生效（可能被另一个作用域的配置覆盖）")
        return {
            "id": spec,
            "enabled": enabled,
            "scope": target,
            "updatedScopes": touched,
            "extensions": configured,
            "availableExtensions": available,
        }


__all__ = ["BUILTIN_COMMANDS", "HostError", "ServeHost", "DEFAULT_USER_DIR"]
