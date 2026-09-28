"""`python -m fox_serve`：命令行入口。

用法（Electron 侧就是这么拉起来的，见 `desktop/electron/main.js` 的 `createSidecar`）::

    "C:\\...\\FoxCode\\.venv\\Scripts\\python.exe" -m fox_serve --cwd C:\\...\\FoxCode

常用参数：

- `--cwd DIR`：工作目录（决定会话目录、信任判定与工具的相对路径）
- `--user-dir DIR`：用户级配置目录（默认 `~/.foxcode`）
- `--model REF`：初始模型（`models.json` 里的 reference 或 id）
- `--resume [FILE]`：继续最近的会话；也可以直接给文件
- `--new-session`：强制开新会话（**默认是继续 cwd 下最近的会话**，因为桌面端
  每次启动都会拉起一个新 sidecar 进程，默认新建会让会话列表堆满空会话）
- `--thinking LEVEL`：`off|minimal|low|medium|high|xhigh`
- `--permission MODE`：`read-only|workspace-modify|full-access`（默认沿用持仓设置）
- `--prompt TEXT` / `--compact` / `--command NAME`：启动后立刻做一件事
- `--list-models`：列出可切换模型后退出
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable

from . import __version__
from .approvals import PERMISSION_MODES
from .host import DEFAULT_USER_DIR, ServeHost
from .server import run_stdio

#: 与 `packages/fox_coding_agent/src/cli.py:20` 保持一致。
THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fox-serve",
        description="FoxCode 桌面端的 Python 连接层（NDJSON over stdio）",
    )
    parser.add_argument("--cwd", default=".", help="工作目录（默认当前目录）")
    parser.add_argument("--user-dir", default=None, help=f"用户配置目录（默认 {DEFAULT_USER_DIR}）")
    parser.add_argument("--model", default=None, help="初始模型 reference 或 id")
    parser.add_argument("--session", default=None, help="直接打开某个会话 JSONL 文件")
    parser.add_argument(
        "--resume",
        nargs="?",
        const="",
        default=None,
        help="继续最近的会话（可跟一个具体文件）",
    )
    parser.add_argument(
        "--new-session",
        dest="new_session",
        action="store_true",
        help="强制开新会话（默认是继续 cwd 下最近的会话，见 _resolve_session）",
    )
    parser.add_argument("--thinking", default=None, choices=THINKING_LEVELS, help="推理强度")
    parser.add_argument("--permission", default=None, choices=PERMISSION_MODES, help="权限档位")
    trust = parser.add_mutually_exclusive_group()
    trust.add_argument(
        "--trust-project",
        dest="project_trusted",
        action="store_true",
        default=None,
        help="把项目标记为已信任（默认按已有记录）",
    )
    trust.add_argument(
        "--no-trust-project",
        dest="project_trusted",
        action="store_false",
        help="不信任项目（写入/执行类工具会被拒绝）",
    )
    parser.add_argument(
        "--ask-timeout",
        type=float,
        default=600.0,
        help="等待界面授权的最长秒数（超时按拒绝处理，默认 600）",
    )
    parser.add_argument("--prompt", default=None, help="启动后立刻发送一条消息")
    parser.add_argument("--compact", action="store_true", help="启动后压缩一次上下文")
    parser.add_argument(
        "--command",
        nargs=argparse.REMAINDER,
        default=None,
        help="启动后执行一条内置/扩展命令，例如 --command permission full-access",
    )
    parser.add_argument("--list-models", action="store_true", help="列出 models.json 中的模型后退出")
    parser.add_argument("--quiet", action="store_true", help="不输出 stderr 日志")
    parser.add_argument("--version", action="version", version=f"fox_serve {__version__}")
    return parser


def _stderr_log(*, quiet: bool) -> Callable[[str], None]:
    if quiet:
        return lambda message: None
    return lambda message: print(message, file=sys.stderr, flush=True)


def _latest_session(args: argparse.Namespace, log: Callable[[str], None], *, why: str) -> str | None:
    """cwd 下最近的会话文件；没有就返回 None（= 新建会话）。"""

    try:
        from fox_coding_agent.src import AgentSessionRuntime  # 延迟 import，--help 也要快

        path = AgentSessionRuntime.latest_session(
            args.cwd, user_dir=args.user_dir or None, project_trusted=True
        )
        log(f"[fox serve] {why}：{path}")
        return str(path)
    except Exception as exc:  # noqa: BLE001 - 没有历史会话时继续开新会话
        log(f"[fox serve] 没有可恢复的会话（{type(exc).__name__}: {exc}），改为新建会话")
        return None


def _resolve_session(args: argparse.Namespace, log: Callable[[str], None]) -> str | None:
    """把 `--session` / `--resume` / `--new-session` 解析成一个具体文件。

    默认（三个都没给）是**继续 cwd 下最近的会话**：桌面端每次启动 sidecar 都会
    拉起一个新进程，若默认新建会话，用户每开一次界面就多一个空会话文件。
    界面上的「新建会话」按钮走 `sessions.new`，所以这里可以安全地默认续接。
    """

    if getattr(args, "session", None):
        return str(Path(args.session).expanduser())
    resume = getattr(args, "resume", None)
    if resume:
        return str(Path(resume).expanduser())
    if getattr(args, "new_session", False):
        log("[fox serve] --new-session：开一个新会话")
        return None
    if resume is None:
        return _latest_session(args, log, why="默认继续最近会话")
    return _latest_session(args, log, why="--resume 使用最近会话")


def _print_models(args: argparse.Namespace) -> int:
    from fox_coding_agent.src.core.model_config import ModelConfig

    user_dir = Path(args.user_dir).expanduser() if args.user_dir else DEFAULT_USER_DIR
    snapshot = ModelConfig(user_dir).snapshot
    for entry in snapshot.models:
        model = entry.model
        print(
            json.dumps(
                {
                    "reference": entry.reference,
                    "id": model.id,
                    "name": model.name,
                    "provider": model.provider,
                    "contextWindow": model.context_window,
                    "reasoning": model.reasoning,
                },
                ensure_ascii=False,
            )
        )
    if not snapshot.models:
        print(f"(models.json 中没有模型：{snapshot.source})", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    log = _stderr_log(quiet=args.quiet)

    if args.list_models:
        return _print_models(args)

    session_file = _resolve_session(args, log)

    def factory(send: Callable[[dict[str, Any]], None]) -> ServeHost:
        return ServeHost(
            cwd=args.cwd,
            user_dir=args.user_dir,
            model=args.model,
            session_file=session_file,
            thinking=args.thinking,
            permission=args.permission,
            project_trusted=True if args.project_trusted is None else bool(args.project_trusted),
            ask_timeout=args.ask_timeout,
            send=send,
            log=log,
        )

    async def on_ready(host: ServeHost) -> None:
        """宿主就绪后执行 `--prompt` / `--compact` / `--command`。"""

        if args.prompt:
            await host.handle("prompt", {"message": args.prompt})
            return
        if args.compact:
            await host.handle("compact", {})
            return
        if args.command:
            name, _, rest = " ".join(args.command).partition(" ")
            result = await host.handle(
                "run_command", {"name": name, "arguments": rest}
            )
            log(f"[fox serve] {name} → {json.dumps(result, ensure_ascii=False, default=str)[:400]}")

    log(f"[fox serve] fox_serve {__version__} 启动：cwd={Path(args.cwd).absolute()}")
    return run_stdio(factory, log=log, on_ready=on_ready)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
