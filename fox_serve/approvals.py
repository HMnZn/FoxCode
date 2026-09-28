"""权限策略与异步审批（fox_serve 的「能不能执行」这一半）。

背景（`packages/fox_coding_agent/src/core/runtime.py:182-197` 的顺序是固定的）::

    未信任项目拦截 → 静态 check_tool_permission → 宿主 before_tool_call → 扩展 before_tool

也就是说**宿主钩子只能收紧、不能放行**：一旦静态检查根据 `permission_mode` 拒绝了
某个调用，钩子根本没机会跑。所以想要「在 UI 上点一下就把越界写入放行」这件事，
只能这样实现：

1. sidecar 用 `settings_overrides={"permission_mode": "full-access"}` 启动宿主，
   让**每次**工具调用都会走到我们的 `before_tool_call`；
2. 真正的权限档位由本模块的 :class:`PermissionPolicy` 持有（UI 看到的就是它），
   `permission.set` 改的是它，而不是宿主的静态检查。

于是 `read-only`（只读工具放行、其余直接拒绝）／`workspace-modify`（界面显示为
“工作区修改”，工作区内写入和 shell 放行、越界文件写入弹审批）／
`full-access`（全部放行）三档语义都能工作，
并且「本会话总是允许」有地方可记。
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal

#: 权限档位（与 `packages/fox_coding_agent/src/core/permissions.py:9-12` 一致）。
PermissionMode = Literal["read-only", "workspace-modify", "full-access"]
PERMISSION_MODES: tuple[PermissionMode, ...] = ("read-only", "workspace-modify", "full-access")

#: 审批决定（与前端 `PermissionDecision` 一致）。
PermissionDecision = Literal["allow-once", "allow-session", "deny"]

#: 前端 `PermissionRequest.reason` 是联合字面量，不能自由发挥。
PermissionReason = Literal["mode-insufficient", "outside-workspace", "policy", "always-ask"]

_RANK: dict[str, int] = {"read-only": 0, "workspace-modify": 1, "full-access": 2}

#: 这些工具会执行命令，工作区内的路径检查对它们没意义。
_SHELL_TOOLS = frozenset({"bash", "powershell", "sh", "zsh", "cmd", "terminal"})

#: 找不到 `permission_paths` 时，这些参数名按路径看待。
_PATH_KEYS = (
    "path",
    "file_path",
    "filepath",
    "paths",
    "files",
    "file",
    "directory",
    "dir",
    "target",
    "cwd",
)


@dataclass(frozen=True)
class PolicyDecision:
    """一次工具调用的处置结论。"""

    action: Literal["allow", "ask", "block"]
    reason: PermissionReason
    detail: str
    path: str | None = None
    paths: tuple[str, ...] = ()

    @property
    def blocked(self) -> bool:
        return self.action == "block"


def _as_paths(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple, set, frozenset)):
        return [item for item in value if isinstance(item, str)]
    return []


def extract_paths(args: Any, permission_paths: Any = None) -> list[str]:
    """从工具参数里挑出「文件系统路径」，用于工作区判定与预览。"""

    if not isinstance(args, dict):
        return []
    if isinstance(permission_paths, (list, tuple)) and permission_paths:
        # 工具自己声明了哪些参数是路径：以它为准，避免把无关的 "path" 参数
        # 也当成写入目标。
        keys = [str(key) for key in permission_paths]
    else:
        keys = list(_PATH_KEYS)

    found: list[str] = []
    for key in keys:
        if key not in args:
            continue
        for value in _as_paths(args[key]):
            if value and value not in found:
                found.append(value)
    return found


def _resolve(path: str, cwd: Path) -> Path:
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        candidate = cwd / candidate
    try:
        return candidate.resolve()
    except OSError:  # pragma: no cover - Windows 上极少见
        return candidate.absolute()


def inside_workspace(path: str, cwd: Path) -> bool:
    """路径是否在工作目录内（越界写入需要审批）。"""

    target = _resolve(path, cwd)
    root = cwd.resolve()
    try:
        return os.path.commonpath([str(target), str(root)]) == str(root)
    except ValueError:  # 不同盘符
        return False


class PermissionPolicy:
    """把「工具需要什么权限 + 当前档位 + 参数」翻译成 allow/ask/block。

    规则（对齐 DSH 桌面端的审批语义）::

        read-only 档位：只读工具放行；其余**拒绝**（不能靠审批提权）
        workspace-modify：只读工具、工作区内写入和 shell 放行；
                         越界文件写入 → 弹审批
        full-access：全部放行（钩子仍可以拒绝，但默认不拦）
    """

    def __init__(self, mode: PermissionMode = "workspace-modify", *, cwd: str | Path = ".") -> None:
        self._mode: PermissionMode = mode
        self.cwd = Path(cwd).absolute()
        #: 「本会话总是允许」的记忆：工具名 → 允许。
        self._allowlist: set[str] = set()

    # ---- 档位 ----

    @property
    def mode(self) -> PermissionMode:
        return self._mode

    def set_mode(self, mode: str) -> PermissionMode:
        normalized = str(mode).strip().lower()
        if normalized not in _RANK:
            raise ValueError(
                f"未知权限档位 {mode!r}；可选：{', '.join(PERMISSION_MODES)}"
            )
        self._mode = normalized  # type: ignore[assignment]
        return self._mode

    def set_cwd(self, cwd: str | Path) -> None:
        self.cwd = Path(cwd).absolute()

    # ---- 会话级允许 ----

    def allow_tool(self, tool_name: str) -> None:
        self._allowlist.add(tool_name)

    def is_allowed(self, tool_name: str) -> bool:
        return tool_name in self._allowlist

    def reset_allowlist(self) -> None:
        self._allowlist.clear()

    def snapshot(self) -> dict[str, Any]:
        return {"mode": self._mode, "allowlist": sorted(self._allowlist)}

    # ---- 判定 ----

    def evaluate(
        self,
        *,
        tool_name: str,
        required: str = "full-access",
        args: Any = None,
        permission_paths: Any = None,
    ) -> PolicyDecision:
        required = required if required in _RANK else "full-access"
        need = _RANK[required]
        mode = _RANK[self._mode]
        paths = extract_paths(args, permission_paths)
        is_shell = tool_name in _SHELL_TOOLS

        # 1. 只读工具（read/grep/find/ls…）永远放行。
        if need == 0:
            return PolicyDecision("allow", "policy", f"{tool_name} 是只读工具")

        # 2. 只读档位：不允许提权，直接拒绝。
        if mode == 0:
            return PolicyDecision(
                "block",
                "mode-insufficient",
                f"当前权限档位为只读，{tool_name} 需要 {required} 权限；"
                "请先在界面上提高权限档位。",
            )

        # 3. 完全访问档位：不拦。
        if mode == _RANK["full-access"]:
            return PolicyDecision("allow", "policy", "完全访问档位")

        # 4. workspace-modify 档位。
        if self.is_allowed(tool_name):
            return PolicyDecision("allow", "policy", f"本会话已允许 {tool_name}")

        if is_shell:
            return PolicyDecision(
                "allow",
                "policy",
                f"工作区修改模式允许从当前工作区执行 {tool_name}",
            )

        outside = [path for path in paths if not inside_workspace(path, self.cwd)]
        if outside:
            return PolicyDecision(
                "ask",
                "outside-workspace",
                f"{tool_name} 会写入工作目录之外的路径",
                path=outside[0],
                paths=tuple(outside),
            )
        if not paths:
            # 没有路径参数又高于只读：保守起见问一次。
            return PolicyDecision(
                "ask", "policy", f"{tool_name} 需要 {required} 权限", path=None
            )
        return PolicyDecision("allow", "policy", f"{tool_name} 在工作目录内")


# ---------------------------------------------------------------------------
# 审批代理
# ---------------------------------------------------------------------------


@dataclass
class _Pending:
    request: dict[str, Any]
    future: asyncio.Future[str] = field(repr=False)


class ApprovalBroker:
    """把 `before_tool_call` 的「等人点按钮」变成可 await 的 future。

    宿主钩子（`runtime.py:182-197`）是 `cancellable(...)` 里 await 的
    coroutine，所以在这里等用户点击是安全的：整轮会挂住，直到
    `permission.answer` 到达、超时、或会话被中止。
    """

    def __init__(
        self,
        *,
        policy: PermissionPolicy,
        on_request: Callable[[dict[str, Any]], None],
        timeout: float = 600.0,
        log: Callable[[str], None] | None = None,
    ) -> None:
        self.policy = policy
        self._on_request = on_request
        self._timeout = timeout
        self._log = log or (lambda message: None)
        self._pending: dict[str, _Pending] = {}
        self._counter = 0

    # ---- 计数/查询 ----

    @property
    def pending_ids(self) -> list[str]:
        return list(self._pending)

    def _next_id(self) -> str:
        self._counter += 1
        return f"p{self._counter}"

    # ---- 申请 ----

    async def ask(
        self,
        *,
        tool_call_id: str | None,
        tool_name: str,
        args: Any,
        required: str,
        summary: str,
        request_extra: dict[str, Any],
        cancel: Any = None,
    ) -> PermissionDecision:
        request: dict[str, Any] = {
            "id": self._next_id(),
            "ts": int(time.time() * 1000),
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "args": args,
            "required": required,
            "mode": self.policy.mode,
            "cwd": str(self.policy.cwd),
            "summary": summary,
            **request_extra,
        }
        if "reason" not in request:
            request["reason"] = "policy"

        loop = asyncio.get_running_loop()
        future: asyncio.Future[str] = loop.create_future()
        self._pending[request["id"]] = _Pending(request=request, future=future)
        self._on_request(request)
        self._log(f"等待授权 {request['id']}：{summary}")

        try:
            return await self._wait(future, cancel)
        finally:
            self._pending.pop(request["id"], None)

    async def _wait(self, future: asyncio.Future[str], cancel: Any) -> PermissionDecision:
        waiters: list[asyncio.Future[Any]] = [future]
        cancel_task: asyncio.Task[Any] | None = None
        if cancel is not None and hasattr(cancel, "wait"):
            cancel_task = asyncio.ensure_future(cancel.wait())
            waiters.append(cancel_task)
        try:
            done, _ = await asyncio.wait(
                waiters, timeout=self._timeout, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            if cancel_task is not None and not cancel_task.done():
                cancel_task.cancel()

        if future in done and not future.cancelled():
            return future.result()
        if cancel_task is not None and cancel_task in done:
            self._log("会话被中止，授权请求作废")
            return "deny"
        self._log(f"授权请求超时（{self._timeout:.0f}s），按拒绝处理")
        return "deny"

    # ---- 应答 ----

    def answer(self, request_id: str, decision: str, reason: str | None = None) -> bool:
        pending = self._pending.get(request_id)
        if pending is None:
            self._log(f"忽略未知的授权应答：{request_id}")
            return False
        normalized = decision if decision in ("allow-once", "allow-session", "deny") else "deny"
        if pending.future.done():
            return False
        pending.future.set_result(normalized)  # type: ignore[arg-type]
        if normalized == "allow-session":
            self.policy.allow_tool(str(pending.request.get("tool_name", "")))
        detail = f"（{reason}）" if reason else ""
        self._log(f"授权 {request_id} → {normalized}{detail}")
        return True

    def cancel_all(self, reason: str = "会话已结束") -> int:
        count = 0
        for pending in list(self._pending.values()):
            if not pending.future.done():
                pending.future.set_result("deny")
                count += 1
        if count:
            self._log(f"{reason}：作废 {count} 个未应答的授权请求")
        self._pending.clear()
        return count


# ---------------------------------------------------------------------------
# 摘要与预览（供 host 组装 PermissionRequest）
# ---------------------------------------------------------------------------


def _shorten(value: Any, limit: int = 160) -> str:
    text = value if isinstance(value, str) else str(value)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def build_summary(tool_name: str, required: str, paths: list[str], args: Any) -> str:
    """给审批卡写一句人话（前端直接显示 `summary`）。"""

    requirement = {"read-only": "只读", "workspace-modify": "工作区修改", "full-access": "完全访问"}.get(
        required, required
    )
    if tool_name in _SHELL_TOOLS:
        command = ""
        if isinstance(args, dict):
            command = _shorten(args.get("command") or args.get("script") or "", 120)
        return f"执行 shell 命令（{requirement}）" + (f"：{command}" if command else "")
    if tool_name in ("write", "edit") and paths:
        verb = "写入" if tool_name == "write" else "编辑"
        return f"{verb} {paths[0]}"
    if paths:
        return f"{tool_name} 要访问 {paths[0]}"
    return f"调用工具 {tool_name}（需要{requirement}权限）"


def build_preview(tool_name: str, args: Any, required: str, paths: list[str]) -> dict[str, Any] | None:
    """构造 `PermissionRequest.preview`（前端按 kind 渲染）。"""

    if not isinstance(args, dict):
        return None
    if tool_name in _SHELL_TOOLS or required == "full-access":
        command = args.get("command") or args.get("script") or args.get("cmd")
        if isinstance(command, str) and command.strip():
            return {"kind": "command", "command": command}
    if tool_name == "edit":
        old = args.get("old_string") or args.get("oldText")
        new = args.get("new_string") or args.get("newText")
        if isinstance(old, str) and isinstance(new, str):
            from difflib import unified_diff

            path = paths[0] if paths else "edit"
            diff = "".join(
                unified_diff(
                    old.splitlines(keepends=True),
                    new.splitlines(keepends=True),
                    fromfile=f"a/{path}",
                    tofile=f"b/{path}",
                )
            )
            if diff:
                return {"kind": "diff", "diff": diff}
    if paths:
        return {"kind": "path", "paths": paths}
    return None


__all__ = [
    "ApprovalBroker",
    "PermissionDecision",
    "PermissionMode",
    "PermissionPolicy",
    "PolicyDecision",
    "PERMISSION_MODES",
    "build_preview",
    "build_summary",
    "extract_paths",
    "inside_workspace",
]
