"""fox_serve 的核心：把 `AgentSessionRuntime` 包成可被 UI 驱动的宿主。

分工：

- :mod:`fox_serve.protocol` 负责「宿主对象 → 线协议 JSON」；
- :mod:`fox_serve.approvals` 负责「能不能执行」；
- :mod:`fox_serve.sessions` 负责会话索引；
- 本模块负责**编排**：订阅事件、分发宿主命令、把授权请求接到
  `AgentSessionRuntime(before_tool_call=...)` 上。

关于权限（重要，见 `approvals.py` 的模块注释）：宿主固定的判定顺序是
「未信任项目 → 静态权限检查 → 宿主钩子 → 扩展钩子」，钩子只能收紧，不能放行。
所以这里让宿主始终以 `full-access` 运行（这样每次工具调用都会走到钩子），
真正对外生效的档位由 :class:`~fox_serve.approvals.PermissionPolicy` 持有，
`permission.set` 改的是它。`host.info.permissionMode` 上报的就是这个档位。
"""

from __future__ import annotations

import asyncio
import base64
import copy
import contextlib
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import __version__
from . import extension_catalog as catalog
from . import workspace_files
from .configuration import ConfigurationService
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
from fox_coding_agent.src.core.session_layout import session_id_from_path
from fox_coding_agent.src.core._io import atomic_write_text
from fox_coding_agent.src.core.paths import ProjectPaths, UserPaths
from fox_coding_agent.src.core.sandbox import detect_sandbox
from fox_ai.src import ImageContent, TextContent, ToolResultMessage, UserMessage
from .sessions import MAX_LABEL_LENGTH, SessionIndex, branch_label

#: 默认的用户级目录（与 CLI 一致：`packages/fox_coding_agent/src/core/settings.py`）。
DEFAULT_USER_DIR = Path.home() / ".foxcode"
MAX_PROMPT_IMAGES = 4
MAX_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024
MAX_PROMPT_IMAGES_BYTES = 20 * 1024 * 1024
PROMPT_IMAGE_MIMES = frozenset({"image/png", "image/jpeg", "image/webp", "image/gif"})
# Tool arguments can contain whole source files. Providers often stream them a
# few characters at a time, while the desktop currently only uses these delta
# events to show an activity label. Bound the host-to-renderer update rate and
# coalesce skipped fragments so protocol clients can still reconstruct the
# complete argument stream before the authoritative ``toolcall_end``.
TOOLCALL_DELTA_INTERVAL_SECONDS = 0.05

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
    {"name": "/mode", "description": "切换自动、执行或计划模式", "argumentHint": "[auto|default|plan]"},
    {"name": "/sandbox", "description": "切换本机或沙盒执行环境", "argumentHint": "[local|sandbox]"},
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


def prompt_message(message: Any, options: Any = None) -> tuple[UserMessage | str, str]:
    """Validate renderer images and build a native multimodal user message."""

    text = message if isinstance(message, str) else ""
    raw_attachments = options.get("attachments", []) if isinstance(options, dict) else []
    if raw_attachments is None:
        raw_attachments = []
    if not isinstance(raw_attachments, list):
        raise HostError("attachments 必须是数组")
    if len(raw_attachments) > MAX_PROMPT_IMAGES:
        raise HostError(f"每条消息最多附加 {MAX_PROMPT_IMAGES} 张图片")

    images: list[ImageContent] = []
    total = 0
    for index, item in enumerate(raw_attachments, 1):
        if not isinstance(item, dict):
            raise HostError(f"第 {index} 个图片附件格式无效")
        mime = str(item.get("mimeType") or item.get("mime_type") or "").lower()
        if mime not in PROMPT_IMAGE_MIMES:
            raise HostError(f"不支持的图片类型：{mime or '(空)'}")
        data = item.get("data")
        if not isinstance(data, str) or not data:
            raise HostError(f"第 {index} 个图片附件缺少 base64 data")
        if data.startswith("data:"):
            marker = data.find(",")
            data = data[marker + 1:] if marker >= 0 else ""
        if len(data) > ((MAX_PROMPT_IMAGE_BYTES + 2) // 3) * 4 + 8:
            raise HostError(f"第 {index} 张图片超过 8 MiB")
        try:
            decoded = base64.b64decode(data, validate=True)
        except (ValueError, TypeError) as exc:
            raise HostError(f"第 {index} 个图片附件不是有效 base64") from exc
        if len(decoded) > MAX_PROMPT_IMAGE_BYTES:
            raise HostError(f"第 {index} 张图片超过 8 MiB")
        total += len(decoded)
        if total > MAX_PROMPT_IMAGES_BYTES:
            raise HostError("图片附件总大小超过 20 MiB")
        images.append(ImageContent(data=data, mimeType=mime))

    if not text.strip() and not images:
        raise HostError("需要一个非空的 message 或至少一张图片")
    if not images:
        return text, text
    content = ([TextContent(text=text)] if text.strip() else []) + images
    return UserMessage(content=content, timestamp=int(time.time() * 1000)), text


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
        # A newly-created conversation must not tear down a run that is still
        # producing output. The active runtime drives the visible workbench;
        # older busy runtimes stay alive here until their own prompt finishes.
        self._runtimes: dict[str, Any] = {}
        self._runtime_unsubscribes: dict[int, Callable[[], None]] = {}
        self._running_runtimes: set[int] = set()
        self._toolcall_delta_at: dict[tuple[int, int], float] = {}
        self._toolcall_delta_pending: dict[tuple[int, int], tuple[Any, str]] = {}
        #: 后台任务（`prompt` 这类长耗时操作），退出时统一取消。
        self._tasks: set[asyncio.Task[Any]] = set()
        #: 每个 runtime 当前的前台运行任务。显式插话要先等旧请求完成取消清理，
        #: 再从同一会话继续，不能和旧 prompt 并发改写 transcript。
        self._runtime_tasks: dict[int, asyncio.Task[Any]] = {}
        #: 前端靠帧推进状态，所以「一轮到底还在不在跑」必须由宿主自己给出：
        #: 任务排队、结束以及 `agent_start`/`agent_end`/`error` 都会更新状态。
        #: 少了这个信号，一轮如果在模型请求里静默卡住，前端会永远停在「生成中」。
        self._agent_running = False
        self._last_frame_at = self._started_at
        # Baseline for workspaces without git.  Unlike tool-argument guessing,
        # this catches writes performed through shell commands and ignores reads.
        self._workspace_snapshot: workspace_files.WorkspaceSnapshot | None = None
        self._workspace_snapshots: dict[int, workspace_files.WorkspaceSnapshot] = {}

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """构造 runtime、挂上事件与审批钩子，并发出 `session_start`。"""

        from fox_coding_agent.src import AgentSessionRuntime, SettingsManager
        from fox_coding_agent.src.core.model_config import ModelConfig

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

        initial_model: Any = self.model_reference
        if self.model_reference is None and not ModelConfig(self.user_dir).snapshot.models:
            # First-run bootstrap: without a models.json the old host exited
            # before the settings UI could create one.  A built-in model object
            # lets the control plane come online; no request is made merely by
            # constructing it.  Once the user saves a provider, reload exposes
            # the real configured catalog.
            from fox_ai.src import get_model
            initial_model = get_model("openai", "gpt-4o-mini")
            self._log("未发现 models.json，使用内置模型启动首次配置模式")

        self._runtime = AgentSessionRuntime(
            cwd=str(self.cwd),
            model=initial_model,
            session_file=str(self.session_file) if self.session_file else None,
            user_dir=str(self.user_dir),
            # 见模块文档：让每次工具调用都走到我们的审批钩子。
            settings_overrides={"permission_mode": "full-access"},
            before_tool_call=self._before_tool_call,
            project_trusted=self.project_trusted,
        )
        self._refresh_tools(self._runtime)
        self._policy.set_cwd(self._runtime.cwd)
        self._sessions = SessionIndex(cwd=self._runtime.cwd, user_dir=self.user_dir)
        await self._reset_workspace_snapshot(self._runtime)
        self._register_runtime(self._runtime)

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
        for unsubscribe in list(self._runtime_unsubscribes.values()):
            try:
                unsubscribe()
            except Exception:  # noqa: BLE001 - 收尾阶段不抛
                pass
        self._runtime_unsubscribes.clear()
        runtimes = list({id(runtime): runtime for runtime in self._runtimes.values()}.values())
        if self._runtime is not None and all(runtime is not self._runtime for runtime in runtimes):
            runtimes.append(self._runtime)
        for runtime in runtimes:
            try:
                await runtime.close()
            except Exception as exc:  # noqa: BLE001
                self._log(f"关闭 runtime 时出错：{type(exc).__name__}: {exc}")
        self._runtimes.clear()
        self._workspace_snapshots.clear()
        self._running_runtimes.clear()
        self._runtime = None

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
                "execution": getattr(runtime, "execution_mode", "local"),
            }
        )

    # ------------------------------------------------------------------
    # 事件订阅
    # ------------------------------------------------------------------

    @staticmethod
    def _runtime_key(runtime: Any) -> str:
        raw = str(getattr(runtime, "session_file", "") or "")
        if not raw:
            return f"runtime:{id(runtime)}"
        try:
            return str(Path(raw).expanduser().resolve()).casefold()
        except OSError:
            return str(Path(raw).expanduser().absolute()).casefold()

    def _register_runtime(self, runtime: Any) -> None:
        key = self._runtime_key(runtime)
        self._runtimes[key] = runtime
        marker = id(runtime)
        if marker in self._runtime_unsubscribes:
            return
        subscribe = getattr(runtime, "subscribe", None)
        if not callable(subscribe):
            return
        unsubscribe = subscribe(
            lambda event, cancel=None, owner=runtime: self._on_runtime_event(owner, event, cancel)
        )
        self._runtime_unsubscribes[marker] = unsubscribe

    def _refresh_tools(self, runtime: Any) -> None:
        self._tools = {str(getattr(tool, "name", "")): tool for tool in (getattr(runtime.state, "tools", None) or [])}

    def _activate_runtime(self, runtime: Any) -> None:
        self._runtime = runtime
        self._workspace_snapshot = self._workspace_snapshots.get(id(runtime))
        self._register_runtime(runtime)
        self._agent_running = id(runtime) in self._running_runtimes
        self.cwd = Path(runtime.cwd)
        self._refresh_tools(runtime)
        if self._policy is not None:
            self._policy.reset_allowlist()
            self._policy.set_cwd(runtime.cwd)
        self._sessions = SessionIndex(cwd=runtime.cwd, user_dir=self.user_dir)

    async def _reset_workspace_snapshot(self, runtime: Any | None = None) -> None:
        """Start a fresh edited-file baseline for the active conversation."""

        owner = runtime or self._runtime
        root = Path(getattr(owner, "cwd", self.cwd))
        snapshot = await workspace_files.capture_snapshot(root)
        self._workspace_snapshots[id(owner)] = snapshot
        if owner is self._runtime:
            self._workspace_snapshot = snapshot

    def _build_runtime(
        self,
        *,
        cwd: str | Path,
        session_file: str | Path | None = None,
        model: Any = None,
    ) -> Any:
        from fox_coding_agent.src import AgentSessionRuntime

        runtime = AgentSessionRuntime(
            cwd=str(cwd),
            model=model,
            session_file=str(session_file) if session_file is not None else None,
            user_dir=str(self.user_dir),
            settings_overrides={"permission_mode": "full-access"},
            before_tool_call=self._before_tool_call,
            project_trusted=bool(
                getattr(self._runtime, "project_trusted", self.project_trusted)
            ),
        )
        level = getattr(getattr(self._runtime, "state", None), "thinking_level", None)
        if level is not None:
            runtime.agent_session.set_thinking_level(level)
        return runtime

    def _on_runtime_event(self, runtime: Any, event: Any, cancel: Any = None) -> None:
        kind = getattr(event, "type", None)
        marker = id(runtime)
        stream_event = (
            getattr(event, "assistant_message_event", None)
            if kind == "message_update"
            else None
        )
        stream_kind = getattr(stream_event, "type", None)
        content_index = getattr(stream_event, "content_index", None)
        delta_key = (
            (marker, content_index)
            if isinstance(content_index, int) and not isinstance(content_index, bool)
            else None
        )
        delta_times = getattr(self, "_toolcall_delta_at", None)
        if delta_times is None:
            # Some embedders and focused tests construct a host without calling
            # __init__. Keep event forwarding robust for those callers.
            delta_times = {}
            self._toolcall_delta_at = delta_times
        pending_deltas = getattr(self, "_toolcall_delta_pending", None)
        if pending_deltas is None:
            pending_deltas = {}
            self._toolcall_delta_pending = pending_deltas
        if stream_kind == "toolcall_start" and delta_key is not None:
            delta_times.pop(delta_key, None)
            pending_deltas.pop(delta_key, None)
        elif stream_kind == "toolcall_delta" and delta_key is not None:
            now = time.monotonic()
            previous = delta_times.get(delta_key)
            if previous is not None and now - previous < TOOLCALL_DELTA_INTERVAL_SECONDS:
                queued = pending_deltas.get(delta_key)
                prefix = queued[1] if queued is not None else ""
                pending_deltas[delta_key] = (
                    event,
                    prefix + str(getattr(stream_event, "delta", "")),
                )
                return
            queued = pending_deltas.pop(delta_key, None)
            if queued is not None:
                event = self._replace_toolcall_delta(
                    event,
                    queued[1] + str(getattr(stream_event, "delta", "")),
                )
            delta_times[delta_key] = now
        elif stream_kind == "toolcall_end" and delta_key is not None:
            delta_times.pop(delta_key, None)
            queued = pending_deltas.pop(delta_key, None)
            if queued is not None and runtime is self._runtime:
                self._on_event(
                    self._replace_toolcall_delta(queued[0], queued[1]),
                    cancel,
                )
        if kind == "agent_start":
            self._running_runtimes.add(marker)
        elif kind in ("agent_end", "error"):
            self._running_runtimes.discard(marker)
            for key in [key for key in delta_times if key[0] == marker]:
                delta_times.pop(key, None)
            for key in [key for key in pending_deltas if key[0] == marker]:
                pending_deltas.pop(key, None)
        if runtime is self._runtime:
            self._agent_running = marker in self._running_runtimes
            self._on_event(event, cancel)

    @staticmethod
    def _replace_toolcall_delta(event: Any, delta: str) -> Any:
        """Clone a message update with coalesced tool-argument text."""

        stream_event = getattr(event, "assistant_message_event", None)
        clone_stream = getattr(stream_event, "model_copy", None)
        if not callable(clone_stream):
            return event
        cloned = copy.copy(event)
        cloned.assistant_message_event = clone_stream(update={"delta": delta})
        return cloned

    def _on_event(self, event: Any, _cancel: Any = None) -> None:
        """订阅回调：**必须快且不能抛**（抛异常会杀掉整轮，见 agent_loop.py:396）。"""

        try:
            payload = event_payload(event)
            if payload is None:
                return
            kind = payload.get("type")
            if kind == "session_shutdown":
                self._emit_transport("offline", str(payload.get("reason") or ""))
            self._emit_frame(payload)
        except Exception as exc:  # noqa: BLE001
            self._log(f"转发事件失败：{type(exc).__name__}: {exc}")

    # ------------------------------------------------------------------
    # 上下文占用
    # ------------------------------------------------------------------

    def _context_tokens(self) -> int | None:
        """Read the coding backend's context estimate; never count in serve."""

        runtime = self._runtime
        agent_session = getattr(runtime, "agent_session", None)
        counter = getattr(agent_session, "context_tokens", None)
        if not callable(counter):
            return None
        try:
            return int(counter())
        except Exception as exc:  # noqa: BLE001
            self._log(f"读取后端 token 计数失败：{type(exc).__name__}: {exc}")
            return None

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
            # Extensions may activate tools during ``session_start`` after the
            # host's initial active-tool snapshot was built.  The executing
            # AgentContext is authoritative and also belongs to the correct
            # background runtime; falling back to the stale cache made tools
            # such as ``agent`` look unknown and therefore ``full-access``.
            execution_context = payload.get("context")
            context_tools = getattr(execution_context, "tools", None) or ()
            tool = next(
                (item for item in context_tools if getattr(item, "name", None) == name),
                None,
            )
            if tool is None:
                tool = self._tools.get(name)
            else:
                self._tools[name] = tool
            required = str(getattr(tool, "required_permission", "full-access") or "full-access")
            permission_paths = getattr(tool, "permission_paths", None)

            decision = policy.evaluate(
                tool_name=name,
                required=required,
                args=args,
                permission_paths=permission_paths,
                sandboxed=getattr(tool, "execution_environment", "local") == "sandbox",
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
            "executionMode": getattr(runtime, "execution_mode", "local"),
            "sandbox": detect_sandbox().as_dict(),
            "interactionMode": getattr(runtime, "interaction_mode", "auto"),
            "effectiveInteractionMode": getattr(runtime, "effective_interaction_mode", "default"),
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
            "paths": {
                "user": UserPaths.from_root(getattr(self, "user_dir", DEFAULT_USER_DIR)).public(),
                "project": ProjectPaths.from_root(runtime.cwd).public(),
            },
        }

    # ---- 会话 ----

    async def _cmd_sessions_list(self, _params: dict[str, Any]) -> list[dict[str, Any]]:
        runtime = self._require_runtime()
        assert self._sessions is not None
        live_file = getattr(runtime, "session_file", None)
        # Reading several transcripts is disk work.  Keeping it off the event
        # loop also prevents host.info/sessions.list from timing out while an
        # agent is streaming many frames.
        rows = await asyncio.to_thread(self._sessions.list_all, live_file=live_file)
        if live_file and not Path(live_file).is_file():
            now = int(time.time() * 1000)
            rows.insert(0, {
                "id": session_id_from_path(live_file),
                "file": str(live_file),
                "title": "新会话",
                "cwd": str(runtime.cwd),
                "model": getattr(getattr(getattr(runtime, "state", None), "model", None), "id", None),
                "createdAt": now,
                "updatedAt": now,
                "messageCount": 0,
                "totalTokens": 0,
                "cost": 0.0,
                "live": True,
            })
        for row in rows:
            try:
                key = str(Path(str(row.get("file") or "")).expanduser().resolve()).casefold()
            except OSError:
                key = ""
            owner = self._runtimes.get(key)
            row["running"] = owner is not None and id(owner) in self._running_runtimes
        return rows

    async def _cmd_sessions_open(self, params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        assert self._sessions is not None
        identifier = str(params.get("id") or params.get("file") or "")
        path = self._sessions.find(identifier)
        if path is None or not Path(path).is_file():
            raise HostError(f"找不到会话：{identifier or '(空)'}")
        current = getattr(runtime, "session_file", None)
        try:
            unchanged = current is not None and Path(path).resolve() == Path(current).resolve()
        except OSError:
            unchanged = False
        if unchanged:
            summary = self._sessions.summary_for(Path(path), live=True)
            result = summary or {
                "id": session_id_from_path(path),
                "file": str(path),
                "title": session_id_from_path(path),
                "live": True,
            }
            # Opening the highlighted/live row during generation is a UI
            # navigation operation. Do not emit session_start: it would erase
            # the in-flight renderer view. When idle, replaying is still useful
            # after a renderer reload, but it does not require replacing runtime.
            if self._agent_running:
                return result
            self._emit_session_start()
            replayed = self._replay_current_session()
            self._log(f"重新回放当前会话 {path.name}，共 {replayed} 条消息")
            return result
        cached = self._runtimes.get(str(Path(path).resolve()).casefold())
        if cached is not None:
            self._activate_runtime(cached)
            self._emit_session_start()
            running = id(cached) in self._running_runtimes
            if running:
                self._emit_frame({"type": "agent_start"})
            replayed = self._replay_current_session(settle=not running)
            streaming = getattr(cached.state, "streaming_message", None)
            if running and streaming is not None:
                self._emit_frame({"type": "message_start", "message": message_payload(streaming)})
            self._log(f"切回后台会话 {path.name}，回放 {replayed} 条消息")
            summary = self._sessions.summary_for(Path(path), live=True)
            return summary or {"id": session_id_from_path(path), "file": str(path), "title": session_id_from_path(path)}
        if self._agent_running:
            candidate = self._build_runtime(cwd=self.cwd, session_file=path)
            self._activate_runtime(candidate)
            await self._reset_workspace_snapshot(candidate)
            self._emit_session_start()
            replayed = self._replay_current_session()
            self._log(f"后台保留原任务，打开会话 {path.name}，回放 {replayed} 条消息")
            summary = self._sessions.summary_for(Path(path), live=True)
            return summary or {"id": session_id_from_path(path), "file": str(path), "title": session_id_from_path(path)}
        old_key = self._runtime_key(runtime)
        await runtime.switch_session(str(path))
        await self._reset_workspace_snapshot(runtime)
        self._runtimes.pop(old_key, None)
        self._register_runtime(runtime)
        assert self._policy is not None
        self._policy.reset_allowlist()
        self._policy.set_cwd(runtime.cwd)
        self._sessions = SessionIndex(cwd=runtime.cwd, user_dir=self.user_dir)
        self._emit_session_start()
        replayed = self._replay_current_session()
        self._log(f"打开会话 {path.name}，回放 {replayed} 条消息")
        summary = self._sessions.summary_for(Path(path), live=True)
        return summary or {"id": session_id_from_path(path), "file": str(path), "title": session_id_from_path(path)}

    async def _cmd_sessions_new(self, _params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        # `AgentSessionRuntime.new_session()` 没有返回值
        # （packages/fox_coding_agent/src/core/runtime.py:463-464 只 await 了 _replace），
        # 新会话的路径要从 runtime.session_file 读——以前这里写成 Path(None) 会直接崩。
        if self._agent_running:
            candidate = self._build_runtime(
                cwd=runtime.cwd,
                model=getattr(runtime.state, "model", None),
            )
            self._activate_runtime(candidate)
            runtime = candidate
        else:
            old_key = self._runtime_key(runtime)
            await runtime.new_session()
            self._runtimes.pop(old_key, None)
            self._register_runtime(runtime)
        await self._reset_workspace_snapshot(runtime)
        path = self._current_session_path(runtime)
        assert self._policy is not None
        self._policy.reset_allowlist()
        self._policy.set_cwd(runtime.cwd)
        self._emit_session_start()
        assert self._sessions is not None
        summary = self._sessions.summary_for(path, live=True)
        return summary or {
            "id": session_id_from_path(path),
            "file": str(path),
            "title": "新会话",
            "cwd": str(runtime.cwd),
            "live": True,
        }

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
        return {"id": session_id_from_path(deleted), "file": str(deleted)}

    async def _cmd_sessions_rename(self, params: dict[str, Any]) -> dict[str, Any]:
        """给一个会话改名：标题写进会话文件头部的 `_meta._label`。

        `sessions.list` 读的就是那个字段（`fox_serve/sessions.py::read_session_file`），
        所以改完不需要重建索引。标题留空 = 恢复自动标题（首条用户消息）。

        正在使用的会话不能直接改磁盘：它的 storage 在内存里握着旧标题，下一次
        append 触发的整文件重写会把改动抹掉，得走那个 runtime 自己的 SessionManager。
        """

        assert self._sessions is not None
        identifier = str(params.get("id") or params.get("sessionId") or params.get("file") or "")
        if not identifier:
            raise HostError("sessions.rename 需要一个 id")
        label = " ".join(str(params.get("title") or "").split())[:MAX_LABEL_LENGTH]
        path = self._sessions.find(identifier)
        if path is None or not Path(path).is_file():
            raise HostError(f"找不到会话：{identifier}")
        try:
            key = str(Path(path).resolve()).casefold()
        except OSError:  # pragma: no cover
            key = ""
        owner = self._runtimes.get(key) if key else None
        storage = getattr(getattr(owner, "session", None), "storage", None)
        setter = getattr(storage, "set_label", None)
        try:
            if callable(setter):
                setter(label or None)
            else:
                self._sessions.rename(identifier, label or None)
        except PermissionError as exc:
            raise HostError(str(exc)) from exc
        except FileNotFoundError as exc:
            raise HostError(f"找不到会话：{identifier}") from exc
        except (OSError, ValueError) as exc:
            raise HostError(f"重命名会话失败：{exc}") from exc
        self._log(f"会话改名 → {label or '（自动标题）'}")
        summary = self._sessions.summary_for(Path(path), live=owner is not None)
        return summary or {
            "id": session_id_from_path(path),
            "file": str(path),
            "title": label,
        }

    async def _cmd_sessions_fork(self, params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        from_id = params.get("fromId") or params.get("from_id")
        old_key = self._runtime_key(runtime)
        path = await runtime.fork(str(from_id) if from_id else None)
        await self._reset_workspace_snapshot(runtime)
        self._runtimes.pop(old_key, None)
        self._register_runtime(runtime)
        self._emit_session_start()
        replayed = self._replay_current_session()
        assert self._sessions is not None
        # 分叉出来的会话要换个名字：否则列表里两条一模一样的标题根本分不清谁是谁。
        label = self._label_fork(path, runtime)
        self._log(f"分叉出新会话 {Path(path).name}（{label}），回放 {replayed} 条消息")
        summary = self._sessions.summary_for(Path(path), live=True)
        return summary or {
            "id": session_id_from_path(path),
            "file": str(path),
            "title": label,
        }

    def _label_fork(self, path: Path | str, runtime: Any) -> str:
        """把刚分叉出来的会话改名成 `原标题-分支`，返回最终标题。

        标题取自分叉之后、改名之前的那份摘要 —— 手动改过名就是那个名字，否则是首条
        用户消息。新会话此刻还没有下一条消息，所以直接走它自己的 storage 落盘，内存
        与磁盘不会打架（与 `sessions.rename` 对活动会话的处理一致）。
        """

        assert self._sessions is not None
        current = self._sessions.summary_for(Path(path), live=True) or {}
        label = branch_label(str(current.get("title") or ""))
        storage = getattr(getattr(runtime, "session", None), "storage", None)
        setter = getattr(storage, "set_label", None)
        if callable(setter):
            setter(label)
        else:  # pragma: no cover - 兜底：storage 不可用时直接改文件头
            self._sessions.rename(session_id_from_path(Path(path)), label)
        return label

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

    def _replay_current_session(self, *, settle: bool = True) -> int:
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
        discarded_tool_calls: set[str] = set()
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
            if role == "assistant" and payload.get("stopReason") in ("error", "aborted"):
                # The durable transcript keeps incomplete provider output for
                # diagnostics. Replaying it would recreate “本轮出错” and fake
                # tool cards every time the session is opened.
                discarded_tool_calls.update(
                    str(call.get("id")) for call in tool_call_parts(payload) if call.get("id")
                )
                continue
            if role == "toolResult" and str(payload.get("toolCallId")) in discarded_tool_calls:
                discarded_tool_calls.discard(str(payload.get("toolCallId")))
                continue
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
                        "details": payload.get("details"),
                    }
                )
            count += 1
        for entry in entries:
            if str(getattr(entry, "type", "")) != "plan_decision":
                continue
            data = getattr(entry, "data", None)
            if isinstance(data, dict):
                self._emit_frame({
                    "type": "plan_decision",
                    "tool_call_id": data.get("tool_call_id"),
                    "decision": data.get("decision"),
                })
        if tool_frames and settle:
            self._emit_frame({"type": "agent_end"})
        return count

    # ---- 对话 ----

    async def _cmd_prompt(
        self,
        params: dict[str, Any],
        *,
        effective_mode: str | None = None,
    ) -> dict[str, Any]:
        runtime = self._require_runtime()
        options = params.get("options") or {}
        message, routing_text = prompt_message(params.get("message"), options)
        queue_as = str(options.get("queueAs") or options.get("queue_as") or "").strip()
        if queue_as == "steer":
            self._enqueue("steer", message)
            return {"queued": "steer"}
        if queue_as in ("follow_up", "followUp"):
            self._enqueue("follow_up", message)
            return {"queued": "follow_up"}

        # Resolve automatic planning before the background task starts so an
        # immediate host.info already reflects the effective mode. The runtime
        # repeats this check after extension preprocessing as a safe no-op.
        if not self._agent_running:
            session = getattr(runtime, "agent_session", None)
            prepare_mode = getattr(session, "prepare_interaction_for_prompt", None)
            if callable(prepare_mode):
                if effective_mode is None:
                    prepare_mode(routing_text)
                else:
                    prepare_mode(routing_text, effective_mode=effective_mode)

        # 一轮对话可能要跑几分钟，而前端 sidecar 客户端对单个请求有超时。
        # 所以这里立刻返回，把这一轮放到后台 task 里跑：进度/结束全部由帧
        # （agent_start / tool_execution_* / agent_end）驱动，和 UI 的模型一致。
        kwargs = {"effective_mode": effective_mode} if effective_mode is not None else {}
        self._queue_operation(runtime, lambda: runtime.prompt(message, **kwargs), name="prompt")
        return {
            "queued": "prompt",
            "effectiveInteractionMode": getattr(
                runtime, "effective_interaction_mode", "default"
            ),
        }

    def _queue_operation(self, runtime: Any, operation: Callable[[], Awaitable[Any]], *, name: str) -> None:
        """Track prompt and skill runs through the same background-task lifecycle."""
        self._agent_running = True
        marker = id(runtime)
        self._running_runtimes.add(marker)
        task = self._spawn_task(self._run_operation(runtime, operation, name=name), name=name)
        self._runtime_tasks[marker] = task

        task.add_done_callback(lambda done: self._finish_operation(runtime, done))

    async def _run_operation(self, runtime: Any, operation: Callable[[], Awaitable[Any]], *, name: str) -> None:
        try:
            await operation()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._log(f"{name} 失败：{type(exc).__name__}: {exc}")
            if runtime is self._runtime:
                self._emit_frame({"type": "error", "error": f"{type(exc).__name__}: {exc}"})
        finally:
            self._finish_operation(runtime, asyncio.current_task())

    def _finish_operation(self, runtime: Any, task: asyncio.Task[Any] | None) -> None:
        marker = id(runtime)
        owner = self._runtime_tasks.get(marker)
        if owner is not None and owner is not task:
            return
        self._runtime_tasks.pop(marker, None)
        self._running_runtimes.discard(marker)
        if runtime is self._runtime:
            self._agent_running = False

    def _spawn_task(self, coro: Any, *, name: str) -> asyncio.Task[Any]:
        task = asyncio.ensure_future(coro)
        task.set_name(f"fox_serve:{name}")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def _cmd_steer(self, params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        message, _ = prompt_message(params.get("message"), params)
        self._require_running("steer")
        promote_pending = bool(params.get("promoteFollowUps") or params.get("promote_follow_ups"))
        interrupt = bool(params.get("interrupt"))
        promoted = 0
        if promote_pending:
            session = getattr(runtime, "agent_session", None)
            promote = getattr(session, "promote_follow_ups", None)
            if promote is None:
                promote = getattr(getattr(session, "agent", None), "promote_follow_ups", None)
            if promote is None:
                raise HostError("当前宿主不支持把排队消息提升为插话")
            promoted = int(promote())
        self._enqueue("steer", message)
        if interrupt:
            runtime.abort()
            self._spawn_task(self._resume_after_steer(runtime), name="steer-resume")
        return {"queued": "steer", "promoted": promoted, "interrupted": interrupt}

    async def _resume_after_steer(self, runtime: Any) -> None:
        """中止当前请求清理完成后，消费 steering 队列继续同一会话。"""

        marker = id(runtime)
        previous = self._runtime_tasks.get(marker)
        current = asyncio.current_task()
        if previous is not None and previous is not current:
            await asyncio.gather(asyncio.shield(previous), return_exceptions=True)
        if self._closed:
            return
        self._runtime_tasks[marker] = current
        self._running_runtimes.add(marker)
        if runtime is self._runtime:
            self._agent_running = True
        try:
            # The old loop may win the race and consume the steering message
            # just before abort reaches it.  In that case it has already
            # produced the inserted reply, and an unconditional continue_()
            # would run once too many and fail with "Cannot continue from
            # message role: assistant".  Only resume when work is still queued.
            session = getattr(runtime, "agent_session", None)
            queue_owner = getattr(session, "agent", None) or session
            has_queued = getattr(queue_owner, "has_queued_messages", None)
            if callable(has_queued) and not bool(has_queued()):
                return
            await runtime.continue_()
        except asyncio.CancelledError:  # pragma: no cover - 退出时取消
            raise
        except Exception as exc:  # noqa: BLE001 - 与普通 prompt 一样转成可见错误帧
            self._log(f"steer 续跑失败：{type(exc).__name__}: {exc}")
            if runtime is self._runtime:
                self._emit_frame({"type": "error", "error": f"{type(exc).__name__}: {exc}"})
        finally:
            if self._runtime_tasks.get(marker) is current:
                self._runtime_tasks.pop(marker, None)
            session = getattr(runtime, "agent_session", None)
            if not bool(getattr(session, "is_running", False)):
                self._running_runtimes.discard(marker)
                if runtime is self._runtime:
                    self._agent_running = False

    async def _cmd_follow_up(self, params: dict[str, Any]) -> dict[str, Any]:
        self._require_runtime()
        message, _ = prompt_message(params.get("message"), params)
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

    def _enqueue(self, kind: str, message: Any) -> None:
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
        preview = message if isinstance(message, str) else content_text(message_payload(message))
        self._log(f"{kind} 已入队：{preview[:60]}")

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
        instructions = str(params.get("instructions") or "").strip()
        if not instructions:
            raise HostError("调用技能前需要提供具体任务，选择技能本身不会发送消息")
        if self._agent_running:
            raise HostError("当前任务仍在运行，请结束后再调用技能")
        skills = getattr(getattr(runtime, "agent_session", None), "skills", [])
        if not any(getattr(skill, "name", None) == name for skill in skills):
            raise HostError(f"Unknown skill: {name}")

        # Like a normal prompt, a skill run may take minutes.  Return to the
        # renderer immediately and let runtime frames carry progress/results.
        self._queue_operation(runtime, lambda: runtime.invoke_skill(name, instructions), name=f"skill:{name}")
        return {"queued": "skill", "name": name}

    async def _reload_runtime(self) -> None:
        """重载设置/扩展，并刷新 cwd 绑定的工具表。"""

        runtime = self._require_runtime()
        await runtime.reload()
        self._refresh_tools(runtime)
        self._emit_session_start()

    async def _cmd_reload(self, _params: dict[str, Any]) -> dict[str, Any]:
        await self._reload_runtime()
        return {"ok": True}

    # ---- 设置 ----

    def _configuration(self) -> ConfigurationService:
        runtime = self._require_runtime()
        return ConfigurationService(
            user_dir=getattr(runtime, "user_dir", self.user_dir),
            cwd=getattr(runtime, "cwd", self.cwd),
            project_trusted=bool(getattr(runtime, "project_trusted", self.project_trusted)),
        )

    async def _cmd_config_get(self, _params: dict[str, Any]) -> dict[str, Any]:
        try:
            return await asyncio.to_thread(self._configuration().snapshot)
        except (OSError, PermissionError, ValueError) as exc:
            raise HostError(f"读取产品配置失败：{exc}") from exc

    @staticmethod
    def _config_scope(params: dict[str, Any]) -> str:
        scope = str(params.get("scope") or "user")
        if scope not in {"user", "project"}:
            raise HostError("scope 必须是 user 或 project")
        return scope

    async def _apply_configuration(self, operation: Callable[[], None], *, reload: bool = True) -> dict[str, Any]:
        if self._agent_running:
            raise HostError("Agent 运行中不能修改产品配置，请等待本轮结束")
        try:
            await asyncio.to_thread(operation)
            if reload:
                await self._reload_runtime()
            else:
                self._require_runtime().model_runtime.reload()
            return await self._cmd_config_get({})
        except HostError:
            raise
        except (OSError, PermissionError, ValueError) as exc:
            raise HostError(str(exc)) from exc

    async def _cmd_config_runtime_update(self, params: dict[str, Any]) -> dict[str, Any]:
        service = self._configuration()
        scope = self._config_scope(params)
        return await self._apply_configuration(
            lambda: service.update_runtime(params.get("values"), scope=scope)
        )

    async def _cmd_config_provider_save(self, params: dict[str, Any]) -> dict[str, Any]:
        service = self._configuration()
        return await self._apply_configuration(lambda: service.save_provider(params.get("provider")))

    async def _cmd_config_provider_delete(self, params: dict[str, Any]) -> dict[str, Any]:
        provider_id = str(params.get("id") or "").strip()
        if not provider_id:
            raise HostError("需要供应商 ID")
        service = self._configuration()
        return await self._apply_configuration(lambda: service.delete_provider(provider_id))

    async def _cmd_config_credential_set(self, params: dict[str, Any]) -> dict[str, Any]:
        provider_id = str(params.get("providerId") or "").strip()
        api_key = str(params.get("apiKey") or "")
        service = self._configuration()
        return await self._apply_configuration(
            lambda: service.set_credential(provider_id, api_key), reload=False
        )

    async def _cmd_config_credential_delete(self, params: dict[str, Any]) -> dict[str, Any]:
        provider_id = str(params.get("providerId") or "").strip()
        service = self._configuration()
        return await self._apply_configuration(
            lambda: service.delete_credential(provider_id), reload=False
        )

    async def _cmd_config_mcp_save(self, params: dict[str, Any]) -> dict[str, Any]:
        service = self._configuration()
        scope = self._config_scope(params)
        return await self._apply_configuration(
            lambda: service.save_mcp(params.get("server"), scope=scope)
        )

    async def _cmd_config_mcp_delete(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name") or "").strip()
        service = self._configuration()
        scope = self._config_scope(params)
        return await self._apply_configuration(lambda: service.delete_mcp(name, scope=scope))

    async def _cmd_config_subagent_save(self, params: dict[str, Any]) -> dict[str, Any]:
        service = self._configuration()
        scope = self._config_scope(params)
        return await self._apply_configuration(
            lambda: service.save_subagent(params.get("subagent"), scope=scope)
        )

    async def _cmd_config_subagent_delete(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name") or "").strip()
        service = self._configuration()
        scope = self._config_scope(params)
        return await self._apply_configuration(lambda: service.delete_subagent(name, scope=scope))

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

    async def _cmd_interaction_set(self, params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._require_runtime()
        try:
            mode = runtime.set_interaction_mode(str(params.get("mode") or ""))
        except (RuntimeError, ValueError) as exc:
            raise HostError(str(exc)) from exc
        self._refresh_tools(runtime)
        self._log(f"交互模式 → {mode}（当前生效：{runtime.effective_interaction_mode}）")
        return {
            "interactionMode": mode,
            "effectiveInteractionMode": runtime.effective_interaction_mode,
        }

    async def _cmd_execution_set(self, params: dict[str, Any]) -> dict[str, Any]:
        """Switch the current branch between direct and sandboxed execution."""

        runtime = self._require_runtime()
        if self._agent_running:
            raise HostError("运行中不能切换执行环境")
        try:
            mode = runtime.set_execution_mode(str(params.get("mode") or ""))
        except (RuntimeError, ValueError) as exc:
            raise HostError(str(exc)) from exc
        capability = detect_sandbox()
        if mode == "sandbox":
            detail = capability.detail if capability.shell else f"{capability.detail} shell 将被禁用"
            self._log(f"执行环境 → sandbox（{detail}）")
        else:
            self._log("执行环境 → local")
        return {"executionMode": mode, "sandbox": capability.as_dict()}

    async def _cmd_plan_answer(self, params: dict[str, Any]) -> dict[str, Any]:
        """Resolve a submitted plan and optionally start its implementation."""

        runtime = self._require_runtime()
        tool_call_id = str(params.get("id") or params.get("toolCallId") or "").strip()
        raw_decision = str(params.get("decision") or "").strip().lower()
        aliases = {"accept": "accepted", "accepted": "accepted", "yes": "accepted",
                   "reject": "rejected", "rejected": "rejected", "no": "rejected"}
        decision = aliases.get(raw_decision)
        if not tool_call_id or decision is None:
            raise HostError("plan.answer 需要有效的 id 和 accept/reject decision")
        if self._agent_running:
            raise HostError("计划仍在生成，请等待规划结束后再选择")

        session = getattr(runtime, "session", None)
        if session is None:
            raise HostError("当前会话不可用")
        found = False
        previous = None
        for entry in session.get_branch(include_ancestors=True):
            if entry.type == "message" and isinstance(entry.data, ToolResultMessage):
                details = entry.data.details
                if (entry.data.tool_call_id == tool_call_id and isinstance(details, dict)
                        and details.get("kind") == "plan"):
                    found = True
            elif entry.type == "plan_decision" and isinstance(entry.data, dict):
                if entry.data.get("tool_call_id") == tool_call_id:
                    previous = entry.data.get("decision")
        if not found:
            raise HostError(f"找不到待确认的计划：{tool_call_id}")
        if previous is not None:
            if previous == decision:
                return {"id": tool_call_id, "decision": decision, "duplicate": True}
            raise HostError("这个计划已经作出选择，不能重复修改")

        session.append_plan_decision(tool_call_id, decision)
        self._emit_frame({
            "type": "plan_decision", "tool_call_id": tool_call_id, "decision": decision,
        })
        if decision == "rejected":
            return {"id": tool_call_id, "decision": decision, "queued": False}

        # Manual Plan mode is a sticky selection, so approval explicitly leaves
        # it. Auto remains sticky and routes the implementation instruction to
        # Default mode for this turn.
        if getattr(runtime, "interaction_mode", "auto") == "plan":
            runtime.set_interaction_mode("default")
        result = await self._cmd_prompt(
            {
                "message": "用户已批准上一条结构化计划。现在严格按照该计划开始实施并完成验证。"
            },
            effective_mode="default",
        )
        return {"id": tool_call_id, "decision": decision, **result}

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
        try:
            unchanged = target.resolve() == Path(runtime.cwd).expanduser().resolve()
        except OSError:
            unchanged = False
        if unchanged:
            # The renderer may spell a Windows path with the other separator.
            # A no-op cwd sync must never replace and abort the active runtime.
            return {"cwd": str(runtime.cwd), "unchanged": True}
        if getattr(self, "_running_runtimes", set()):
            raise HostError("仍有会话正在运行，请等待任务结束后再切换工作区")
        marker = ProjectPaths.from_root(target).control
        try:
            await asyncio.to_thread(marker.mkdir, parents=True, exist_ok=True)
        except OSError as exc:
            raise HostError(
                f"工作区不可写：无法创建 {marker}（{type(exc).__name__}: {exc}）"
            ) from exc
        old_key = self._runtime_key(runtime)
        try:
            await runtime.change_cwd(str(target))
        except Exception as exc:  # noqa: BLE001 - 统一翻译成宿主错误，交给界面显示
            raise HostError(f"切换工作区失败：{type(exc).__name__}: {exc}") from exc
        self._runtimes.pop(old_key, None)
        self._register_runtime(runtime)
        assert self._policy is not None
        self._policy.reset_allowlist()
        self._policy.set_cwd(runtime.cwd)
        self.cwd = Path(runtime.cwd)
        self._sessions = SessionIndex(cwd=runtime.cwd, user_dir=self.user_dir)
        await self._reset_workspace_snapshot(runtime)
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
        return await workspace_files.changes(
            self._workspace_root(), limit=count, baseline=self._workspace_snapshot
        )

    async def _cmd_files_list(self, params: dict[str, Any]) -> dict[str, Any]:
        path = str(params.get("path") or "").strip()
        limit = params.get("limit")
        count = int(limit) if isinstance(limit, int) and limit > 0 else 500
        try:
            return await workspace_files.directory(
                self._workspace_root(), path, limit=count
            )
        except workspace_files.WorkspaceFileError as exc:
            raise HostError(str(exc)) from exc

    async def _cmd_files_diff(self, params: dict[str, Any]) -> dict[str, Any]:
        path = str(params.get("path") or "").strip()
        context = params.get("context")
        try:
            return await workspace_files.diff(
                self._workspace_root(),
                path,
                context=int(context) if isinstance(context, int) else 3,
                baseline=self._workspace_snapshot,
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
            "mode": self._builtin_mode,
            "sandbox": self._builtin_sandbox,
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

    async def _builtin_mode(self, params: dict[str, Any]) -> Any:
        runtime = self._require_runtime()
        arguments = str(params.get("arguments") or "").strip()
        if not arguments:
            return {
                "interactionMode": runtime.interaction_mode,
                "effectiveInteractionMode": runtime.effective_interaction_mode,
            }
        return await self._cmd_interaction_set({"mode": arguments})

    async def _builtin_sandbox(self, params: dict[str, Any]) -> Any:
        runtime = self._require_runtime()
        arguments = str(params.get("arguments") or "").strip()
        if not arguments:
            return {
                "executionMode": runtime.execution_mode,
                "sandbox": detect_sandbox().as_dict(),
            }
        return await self._cmd_execution_set({"mode": arguments})

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
            mode = getattr(getattr(manager, "settings", None), "permission_mode", None)
            if isinstance(mode, str) and mode:
                return mode
        except Exception as exc:  # noqa: BLE001
            self._log(f"读取 settings 失败，按 workspace-modify 处理：{type(exc).__name__}: {exc}")
        return "workspace-modify"

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

    def _memory_service(self) -> Any:
        runtime = self._require_runtime()
        api = self._extension_api()
        service = api.get_service("memory.store") if api is not None else None
        if service is None:
            raise HostError("请先在扩展页启用 memory 扩展")
        try:
            # Runtime lifecycle hooks start on the first prompt. The management
            # UI must work before that, without starting unrelated MCP servers.
            if service.store is None:
                service.bind(runtime.agent_session.extension_context)
            service.require_store()
        except (RuntimeError, PermissionError) as exc:
            raise HostError(str(exc)) from exc
        return service

    async def _cmd_memory_list(self, params: dict[str, Any]) -> dict[str, Any]:
        store = self._memory_service().require_store()
        query = params.get("query", "")
        if not isinstance(query, str):
            raise HostError("query 必须是字符串")
        # Management search includes historical entries; agent recall uses its
        # own relevance and expiry policy and must not be reused as a file list.
        entries = store.list()
        if query.strip():
            needle = query.strip().casefold()
            entries = [entry for entry in entries if needle in " ".join(
                (entry.name, entry.description, entry.content, entry.topic, *entry.tags)
            ).casefold()]
        return {"entries": to_jsonable(entries), "directory": str(store.directory)}

    async def _cmd_memory_save(self, params: dict[str, Any]) -> dict[str, Any]:
        service = self._memory_service()
        if id(self._runtime) in self._running_runtimes:
            raise HostError("请等待当前 Agent 运行结束后修改记忆")
        allowed = {"filename", "name", "description", "type", "content", "pinned"}
        if set(params) - allowed:
            raise HostError("记忆包含不支持的字段")
        if "pinned" in params and not isinstance(params["pinned"], bool):
            raise HostError("pinned 必须是布尔值")
        store = service.require_store()
        try:
            values = dict(params)
            filename = values.pop("filename", None)
            if filename is not None:
                if set(values) - {"description", "content", "pinned"}:
                    raise HostError("已有记忆的名称和类型不可修改")
                entry = store.update(filename, **values)
            else:
                if not {"name", "description", "type", "content"} <= set(values):
                    raise HostError("需要名称、描述、类型和内容")
                result = service.save(**values)
                if not result.decision.accepted or result.entry is None:
                    raise HostError("；".join(result.decision.reasons))
                entry = result.entry
        except (ValueError, FileNotFoundError, TypeError) as exc:
            raise HostError(str(exc)) from exc
        return {"entry": to_jsonable(entry)}

    async def _cmd_memory_delete(self, params: dict[str, Any]) -> dict[str, Any]:
        store = self._memory_service().require_store()
        if id(self._runtime) in self._running_runtimes:
            raise HostError("请等待当前 Agent 运行结束后删除记忆")
        try:
            deleted = store.delete(params.get("filename"))
        except (ValueError, TypeError) as exc:
            raise HostError(str(exc)) from exc
        return {"deleted": deleted}

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
        project_path = Path(getattr(manager, "project_path", ProjectPaths.from_root(cwd).settings))
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
        settings = catalog.ExtensionSettings.read(user_path, project_path)
        present = settings.present_in
        configured = catalog.describe_configured(
            settings.specs, scope=settings.scope, present_in=present
        )
        available = catalog.describe_available(
            self._extension_candidates(),
            scope=settings.suggested_scope(project_trusted=trusted),
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

    def _resolve_extension_spec(self, raw: str, settings: catalog.ExtensionSettings) -> str:
        """把前端给的花名 / 文件路径 / spec 归一成能写进 settings 的字符串。"""

        spec = raw.strip()
        kind = catalog.spec_kind(spec)
        if kind in {"module", "entrypoint"}:
            return spec
        if kind == "file" and (spec.endswith(".py") or "/" in spec or "\\" in spec):
            return str(Path(spec).expanduser().resolve())
        for candidate in self._extension_candidates():
            if spec in {candidate.name, candidate.spec, Path(candidate.path).stem}:
                return candidate.spec
        for existing in settings.specs:
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
        user_path, project_path, trusted = self._extension_settings()
        locations = {"user": user_path, "project": project_path}
        settings = catalog.ExtensionSettings.read(user_path, project_path)
        spec = self._resolve_extension_spec(raw, settings)
        present = settings.present_in
        here = present.get(spec, [])

        target = str(params.get("scope") or "").strip()
        if target not in catalog.SCOPES:
            target = here[0] if here else settings.suggested_scope(project_trusted=trusted)
        if target == "project" and not trusted:
            raise HostError('项目未受信任，不能写入项目级扩展配置（可传 scope:"user"，或先信任项目）')

        before = {scope: list(settings.layers[scope] or []) for scope in catalog.SCOPES}
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
        if touched:
            backups = {scope: locations[scope].read_text(encoding="utf-8")
                       if locations[scope].is_file() else None for scope in touched}
            written: list[str] = []
            try:
                for scope in touched:
                    self._write_extensions(scope, desired[scope])
                    written.append(scope)
                await self._reload_runtime()
            except Exception as exc:
                errors: list[str] = []
                for scope in reversed(written):
                    try:
                        backup = backups[scope]
                        if backup is None:
                            locations[scope].unlink(missing_ok=True)
                        else:
                            atomic_write_text(locations[scope], backup)
                    except OSError as restore_error:
                        errors.append(f"{scope}: {restore_error}")
                if written:
                    with contextlib.suppress(Exception):
                        await self._reload_runtime()
                detail = f"配置回滚失败：{'；'.join(errors)}" if errors else "已回滚到原来的配置"
                raise HostError(f"扩展更新失败，{detail}：{exc}") from exc

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
