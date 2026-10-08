"""NDJSON 服务器：stdin 收请求、stdout 发帧（与 `desktop/electron/sidecar.js` 对接）。

设计要点：

- **一条请求一个 task**：长耗时管理请求不阻塞审批应答；`prompt` 返回排队结果，
  其后台任务通过宿主事件持续推送进度。
- **输出串行化**：所有帧与响应都进同一个队列，由单独的 writer task 逐行写出，
  保证一行一个 JSON、互不交错（前端是逐行解析的）。
- **stdout 只放 NDJSON**：日志、异常堆栈一律 stderr。
"""

from __future__ import annotations

import asyncio
import itertools
import json
import sys
import traceback
from typing import Any, Callable, TextIO

from .host import HostError, ServeHost
from .protocol import compact_json, to_jsonable

#: 构造宿主用的工厂：接收「发送一个 NDJSON 对象」的回调。
HostFactory = Callable[[Callable[[dict[str, Any]], None]], ServeHost]


def ensure_utf8(stream: TextIO | None) -> TextIO | None:
    """把标准流锁成 UTF-8 + `\\n` 换行，保证 NDJSON 可跨平台解析。

    Windows 上管道流的默认编码跟随区域设置（中文机器上是 cp936），于是
    `ensure_ascii=False` 的中文 JSON 会以 GBK 字节写出去，父进程按 UTF-8 解码
    就会崩在 `UnicodeDecodeError: 'utf-8' codec can't decode byte 0xd0 …`。
    Electron 侧靠 `PYTHONIOENCODING=utf-8` 规避，但手工 `python -m fox_serve`
    时没有这个变量，所以这里在进程内直接改，双保险。
    """

    if stream is None:
        return None
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is None:  # StringIO / 测试替身
        return stream
    try:
        reconfigure(encoding="utf-8", newline="\n")
    except (ValueError, OSError):  # pragma: no cover - 流已关闭或不支持
        pass
    return stream


class NdjsonServer:
    """把 :class:`ServeHost` 挂在 stdin/stdout 上。"""

    def __init__(
        self,
        host_factory: HostFactory,
        *,
        stdin: TextIO | None = None,
        stdout: TextIO | None = None,
        log: Callable[[str], None] | None = None,
        on_ready: Callable[[ServeHost], Any] | None = None,
    ) -> None:
        self._host_factory = host_factory
        self._stdin = ensure_utf8(stdin) if stdin is not None else ensure_utf8(sys.stdin)
        self._stdout = ensure_utf8(stdout) if stdout is not None else ensure_utf8(sys.stdout)
        self._log = log or (lambda message: print(message, file=sys.stderr, flush=True))
        self._on_ready = on_ready
        # A model can produce thousands of tiny delta frames.  Control replies
        # (especially ``abort``/``host.info``) must not wait behind that entire
        # backlog, otherwise Electron times out even though the host handled the
        # request.  The monotonically increasing sequence keeps equal-priority
        # items stable and also makes every PriorityQueue tuple comparable.
        self._out: asyncio.PriorityQueue[tuple[int, int, dict[str, Any] | None]] = (
            asyncio.PriorityQueue()
        )
        self._out_seq = itertools.count()
        self._host: ServeHost | None = None
        self._writer: asyncio.Task[None] | None = None
        self._ready_task: asyncio.Task[None] | None = None
        self._inflight: set[asyncio.Task[None]] = set()

    # ------------------------------------------------------------------
    # 输出
    # ------------------------------------------------------------------

    def send(self, payload: dict[str, Any]) -> None:
        """线程/回调安全地排入一行输出（不阻塞）。"""

        # Request responses are control-plane traffic; frames are data-plane
        # traffic.  Let responses overtake queued stream deltas, while retaining
        # FIFO order inside each class.
        priority = 0 if "id" in payload else 10
        self._out.put_nowait((priority, next(self._out_seq), payload))

    def _write_payload(self, payload: dict[str, Any]) -> None:
        """Write one complete line outside the asyncio event-loop thread."""

        self._stdout.write(compact_json(payload) + "\n")
        self._stdout.flush()

    async def _write_loop(self) -> None:
        while True:
            _priority, _sequence, payload = await self._out.get()
            if payload is None:
                break
            try:
                # Pipe backpressure is synchronous.  Writing on the event-loop
                # thread used to freeze stdin dispatch too, so a full stdout
                # pipe made the red stop button and all queries appear dead.
                await asyncio.to_thread(self._write_payload, payload)
            except Exception as exc:  # noqa: BLE001 - 父进程关掉管道时优雅退出
                self._log(f"[fox serve] stdout 写入失败：{type(exc).__name__}: {exc}")
                break

    # ------------------------------------------------------------------
    # 入口
    # ------------------------------------------------------------------

    async def run(self) -> int:
        self._writer = asyncio.ensure_future(self._write_loop())
        host = self._host_factory(self.send)
        self._host = host
        try:
            await host.start()
        except Exception as exc:  # noqa: BLE001
            self._log(f"[fox serve] 宿主启动失败：{type(exc).__name__}: {exc}")
            self._log(traceback.format_exc())
            self.send({"event": "transport", "status": {"state": "offline", "detail": str(exc)}})
            await self._shutdown()
            return 2
        if self._on_ready is not None:
            self._ready_task = asyncio.ensure_future(self._run_ready(host))

        exit_code = 0
        try:
            while True:
                line = await asyncio.to_thread(self._stdin.readline)
                if not line:
                    self._log("[fox serve] stdin 结束，退出")
                    break
                line = line.strip()
                if not line:
                    continue
                self._spawn(line)
        except asyncio.CancelledError:  # pragma: no cover - 被信号打断
            self._log("[fox serve] 收到取消信号")
        except Exception as exc:  # noqa: BLE001
            self._log(f"[fox serve] 读循环异常：{type(exc).__name__}: {exc}")
            self._log(traceback.format_exc())
            exit_code = 1
        finally:
            await self._shutdown()
        return exit_code

    def _spawn(self, line: str) -> None:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            self._log(f"[fox serve] 忽略无法解析的一行（{exc}）：{line[:200]}")
            return
        if not isinstance(obj, dict):
            self._log(f"[fox serve] 忽略非对象请求：{line[:200]}")
            return
        task = asyncio.ensure_future(self._dispatch(obj))
        self._inflight.add(task)
        task.add_done_callback(self._inflight.discard)

    async def _dispatch(self, obj: dict[str, Any]) -> None:
        request_id = obj.get("id")
        method = obj.get("method")
        params = obj.get("params")
        if not isinstance(params, dict):
            params = {}
        if not isinstance(method, str) or not method:
            self._log(f"[fox serve] 请求缺少 method：{compact_json(obj)[:200]}")
            return
        host = self._host
        if host is None:
            self.send({"id": request_id, "error": "宿主未就绪"})
            return
        try:
            result = await host.handle(method, params)
        except HostError as exc:
            self.send({"id": request_id, "error": str(exc)})
        except asyncio.CancelledError:  # pragma: no cover
            raise
        except Exception as exc:  # noqa: BLE001
            self._log(f"[fox serve] {method} 失败：{type(exc).__name__}: {exc}")
            self._log(traceback.format_exc())
            self.send({"id": request_id, "error": f"{type(exc).__name__}: {exc}"})
        else:
            self.send({"id": request_id, "result": to_jsonable(result)})

    async def _run_ready(self, host: ServeHost) -> None:
        """宿主就绪后的可选动作（例如 `--prompt` / `--compact`）。"""

        callback = self._on_ready
        if callback is None:
            return
        try:
            result = callback(host)
            if asyncio.iscoroutine(result) or isinstance(result, asyncio.Future):
                await result
        except Exception as exc:  # noqa: BLE001
            self._log(f"[fox serve] 启动动作失败：{type(exc).__name__}: {exc}")
            self._log(traceback.format_exc())
            self.send({"frame": {"type": "error", "error": f"{type(exc).__name__}: {exc}"}})

    # ------------------------------------------------------------------
    # 收尾
    # ------------------------------------------------------------------

    async def _shutdown(self, *, grace: float = 5.0) -> None:
        if self._ready_task is not None and not self._ready_task.done():
            self._ready_task.cancel()
            await asyncio.gather(self._ready_task, return_exceptions=True)
            self._ready_task = None
        # 先给还在处理中的请求一点时间（父进程可能在收到最后几行后马上关掉
        # stdin，但仍在读 stdout），超时后再取消。
        if self._inflight:
            _done, pending = await asyncio.wait(set(self._inflight), timeout=grace)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        self._inflight.clear()
        host = self._host
        if host is not None:
            try:
                await host.stop()
            except Exception as exc:  # noqa: BLE001
                self._log(f"[fox serve] 宿主收尾失败：{type(exc).__name__}: {exc}")
        # Drain everything already accepted before stopping the writer.
        self._out.put_nowait((100, next(self._out_seq), None))
        if self._writer is not None:
            try:
                await self._writer
            except Exception:  # noqa: BLE001
                pass
            self._writer = None


def run_stdio(
    host_factory: HostFactory,
    *,
    log: Callable[[str], None] | None = None,
    on_ready: Callable[[ServeHost], Any] | None = None,
) -> int:
    """同步入口：建事件循环、跑服务器、返回退出码。"""

    ensure_utf8(sys.stderr)
    server = NdjsonServer(host_factory, log=log, on_ready=on_ready)
    try:
        return asyncio.run(server.run())
    except KeyboardInterrupt:  # pragma: no cover - Ctrl+C 属于正常退出
        return 0


__all__ = ["NdjsonServer", "ensure_utf8", "run_stdio", "HostFactory"]
