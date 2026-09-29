"""把 `python -m fox_serve` 当成子进程驱动一遍（开发/排查用，也可当协议示例）。

它做的事和 Electron 里的 `desktop/electron/sidecar.js` 完全一样：写一行 JSON 请求
到 sidecar 的 stdin，然后逐行读 stdout，把响应帧与事件打印出来。

示例::

    # 只看宿主信息与会话列表
    uv run python fox_serve/scripts/ndjson_client.py

    # 真发一条消息（--approve 会自动批准审批请求）
    uv run python fox_serve/scripts/ndjson_client.py --prompt "读一下 README 的前 20 行" --approve

    # 只发任意命令
    uv run python fox_serve/scripts/ndjson_client.py --call "compact"
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


class Sidecar:
    """极简 NDJSON 客户端（等价于 desktop/electron/sidecar.js）。"""

    def __init__(self, command: list[str], *, cwd: str, log_prefix: str = "") -> None:
        env = dict(os.environ)
        # The child runs in the workspace selected by ``--cwd``.  Once that is
        # different from this repository, ``python -m fox_serve`` can no longer
        # discover the source package through the process working directory.
        # Mirror desktop/electron/main.js and keep the repository root on the
        # child import path so this diagnostic client works for real projects.
        repo_root = str(Path(__file__).resolve().parents[2])
        current_pythonpath = env.get("PYTHONPATH")
        env["PYTHONPATH"] = (
            repo_root
            if not current_pythonpath
            else os.pathsep.join((repo_root, current_pythonpath))
        )
        # 与 desktop/electron/sidecar.js 一致：管道两端都按 UTF-8 收发。
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        self.process = subprocess.Popen(
            command,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
        )
        self._counter = 0
        self._pending: dict[str, threading.Event] = {}
        self._results: dict[str, Any] = {}
        self.file_frames: list[dict[str, Any]] = []
        self.permissions: list[dict[str, Any]] = []
        self.transport: list[dict[str, Any]] = []
        self.errors: list[str] = []
        self._prefix = log_prefix
        self._lock = threading.Lock()
        self._threads = [
            threading.Thread(target=self._read_stdout, daemon=True),
            threading.Thread(target=self._read_stderr, daemon=True),
        ]
        for thread in self._threads:
            thread.start()

    # ---- 收发 ----

    def request(self, method: str, params: dict[str, Any] | None = None, *, timeout: float = 60.0) -> Any:
        with self._lock:
            self._counter += 1
            request_id = f"c{self._counter}"
        event = threading.Event()
        self._pending[request_id] = event
        payload = {"id": request_id, "method": method, "params": params or {}}
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        if not event.wait(timeout):
            self._pending.pop(request_id, None)
            raise TimeoutError(f"{method} 超时（{timeout:.0f}s）")
        result = self._results.pop(request_id, None)
        self._pending.pop(request_id, None)
        if isinstance(result, dict) and "error" in result:
            raise RuntimeError(f"{method} 失败：{result['error']}")
        return result.get("result") if isinstance(result, dict) else result

    # ---- 读取 ----

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        try:
            for line in self.process.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    print(f"{self._prefix}非 JSON 行：{line[:200]}")
                    continue
                self._handle(obj)
            # EOF without a protocol response is also a failure.  In
            # particular, an import/startup error used to leave host.info
            # waiting for its full 60-second timeout even though the child had
            # already exited.
            self._fail_pending("sidecar 已退出，未返回协议响应")
        except Exception as exc:  # noqa: BLE001 - 读端断了就别让调用者干等
            print(f"{self._prefix}stdout 读取失败：{type(exc).__name__}: {exc}")
            self._fail_pending(f"sidecar stdout 读取失败：{type(exc).__name__}: {exc}")

    def _handle(self, obj: dict[str, Any]) -> None:
        if "frame" in obj:
            frame = obj["frame"]
            self.file_frames.append(frame)
            print(f"{self._prefix}frame  {self._describe(frame)}")
        elif obj.get("event") == "permission":
            request = obj.get("request") or {}
            self.permissions.append(request)
            print(f"{self._prefix}授权   需要授权 {request.get('tool_name')}：{request.get('summary')}")
        elif obj.get("event") == "transport":
            self.transport.append(obj.get("status") or {})
            print(f"{self._prefix}传输   {json.dumps(obj.get('status'), ensure_ascii=False)}")
        elif "id" in obj:
            self._results[obj["id"]] = obj
            event = self._pending.get(obj["id"])
            if event is not None:
                event.set()
        else:
            print(f"{self._prefix}未知消息：{json.dumps(obj, ensure_ascii=False)[:200]}")

    def _fail_pending(self, reason: str) -> None:
        for request_id, event in list(self._pending.items()):
            self._results[request_id] = {"id": request_id, "error": reason}
            event.set()

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        try:
            for line in self.process.stderr:
                line = line.rstrip()
                if line:
                    self.errors.append(line)
                    print(f"{self._prefix}stderr {line}")
        except Exception as exc:  # noqa: BLE001
            print(f"{self._prefix}stderr 读取失败：{type(exc).__name__}: {exc}")

    @staticmethod
    def _describe(frame: dict[str, Any]) -> str:
        etype = frame.get("type")
        if etype == "message_update":
            event = frame.get("assistant_message_event") or {}
            kind = event.get("type")
            if kind in ("text_delta", "thinking_delta"):
                return f"{kind} {json.dumps(event.get('delta', ''), ensure_ascii=False)[:120]}"
            return str(kind)
        if etype == "tool_execution_start":
            return f"tool_execution_start {frame.get('tool_name')} {json.dumps(frame.get('args'), ensure_ascii=False)[:120]}"
        if etype == "tool_execution_end":
            return (
                f"tool_execution_end {frame.get('tool_name')} is_error={frame.get('is_error')} "
                f"{json.dumps(str(frame.get('result'))[:120], ensure_ascii=False)}"
            )
        if etype == "message_end":
            message = frame.get("message") or {}
            return f"message_end role={message.get('role')}"
        return str(etype)

    # ---- 收尾 ----

    def close(self) -> int:
        try:
            if self.process.stdin is not None:
                self.process.stdin.close()
        except OSError:
            pass
        try:
            return self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:  # pragma: no cover
            self.process.kill()
            return -1


def _default_command(cwd: str) -> list[str]:
    return [sys.executable, "-m", "fox_serve", "--cwd", cwd, "--quiet"]


def _safe_console() -> None:
    """本机控制台可能是 cp936：打印中文时不要因为编码而炸掉。"""

    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):  # pragma: no cover
            pass


def main(argv: list[str] | None = None) -> int:
    _safe_console()
    parser = argparse.ArgumentParser(description="驱动 fox_serve 的 NDJSON 客户端")
    parser.add_argument("--cwd", default=str(Path.cwd()), help="sidecar 的工作目录")
    parser.add_argument("--call", action="append", default=None, help="额外请求，可重复")
    parser.add_argument("--prompt", default=None, help="发送一条消息并等待整轮结束")
    parser.add_argument("--approve", action="store_true", help="自动批准所有审批请求")
    parser.add_argument("--timeout", type=float, default=180.0, help="等待整轮结束的秒数")
    args = parser.parse_args(argv)

    # Resolve once before both changing the child working directory and passing
    # --cwd.  Passing the original relative value to a child that already runs
    # inside it would otherwise duplicate the path (workspace/workspace).
    target_cwd = str(Path(args.cwd).resolve())
    client = Sidecar(_default_command(target_cwd), cwd=target_cwd)
    exit_code = 0
    try:
        info = client.request("host.info")
        print("host.info →", json.dumps(info, ensure_ascii=False, indent=2))
        sessions = client.request("sessions.list")
        print(f"sessions.list → {len(sessions or [])} 个会话")
        for item in (sessions or [])[:5]:
            print(f"  - {item.get('title')}（{item.get('messageCount')} 条，{item.get('totalTokens')} tok）")

        for call in args.call or []:
            name, _, rest = call.partition(" ")
            params: dict[str, Any] = {"name": name, "arguments": rest}
            print(f"run_command {name} →", json.dumps(client.request("run_command", params), ensure_ascii=False)[:400])

        if args.prompt:
            client.request("prompt", {"message": args.prompt})
            deadline = time.time() + args.timeout
            answered: set[str] = set()
            while time.time() < deadline:
                for request in list(client.permissions):
                    request_id = str(request.get("id"))
                    if request_id in answered:
                        continue
                    if args.approve:
                        client.request(
                            "permission.answer",
                            {"id": request_id, "decision": "allow-once"},
                        )
                        answered.add(request_id)
                if any(frame.get("type") == "agent_end" for frame in client.file_frames):
                    break
                time.sleep(0.2)
            else:
                print("（等待 agent_end 超时）")
                exit_code = 1
            print(f"共收到 {len(client.file_frames)} 帧，{len(client.permissions)} 个授权请求")
    finally:
        code = client.close()
        print(f"sidecar 退出码：{code}")
    return exit_code


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
