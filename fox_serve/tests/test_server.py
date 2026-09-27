"""NDJSON 服务器测试：用假宿主跑通「请求/响应/事件/并发/收尾」。"""

from __future__ import annotations

import asyncio
import io
import json
import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fox_serve.server import NdjsonServer, ensure_utf8  # noqa: E402


class FakeHost:
    """只实现 NdjsonServer 用到的那几个方法。"""

    def __init__(self, send) -> None:
        self.send = send
        self.started = False
        self.stopped = 0
        self.calls: list[tuple[str, dict]] = []
        self.gate = asyncio.Event()

    async def start(self) -> None:
        self.started = True
        self.send({"event": "transport", "status": {"state": "ready", "since": 1}})

    async def stop(self) -> None:
        self.stopped += 1

    async def handle(self, method: str, params: dict[str, Any]) -> Any:
        self.calls.append((method, params))
        if method == "host.info":
            return {"transport": "sidecar", "protocolVersion": 1, "cwd": str(Path.cwd())}
        if method == "prompt":
            # 模拟「整轮还没结束」：等测试放行，期间另一个请求要先被处理。
            await self.gate.wait()
            self.send({"frame": {"type": "agent_end", "seq": 1, "ts": 2, "v": 1}})
            return {"queued": "prompt"}
        if method == "permission.answer":
            self.gate.set()
            return {"accepted": True}
        if method == "boom":
            raise RuntimeError("宿主炸了")
        raise ValueError(f"未知方法：{method}")


def _parse_lines(text: str) -> list[dict]:
    return [json.loads(line) for line in text.splitlines() if line.strip()]


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def _run(self, lines: list[dict], *, host: FakeHost | None = None) -> tuple[list[dict], FakeHost]:
        stdin = io.StringIO("".join(json.dumps(line) + "\n" for line in lines))
        stdout = io.StringIO()
        holder: dict[str, FakeHost] = {}

        def factory(send):
            created = host or FakeHost(send)
            holder["host"] = created
            return created

        server = NdjsonServer(factory, stdin=stdin, stdout=stdout, log=lambda message: None)
        code = await server.run()
        self.assertEqual(code, 0)
        return _parse_lines(stdout.getvalue()), holder["host"]

    async def test_request_response_and_transport_event(self) -> None:
        out, host = await self._run([{"id": "c1", "method": "host.info", "params": {}}])
        self.assertTrue(host.started)
        self.assertEqual(host.stopped, 1)
        self.assertEqual(out[0]["event"], "transport")
        self.assertEqual(out[0]["status"]["state"], "ready")
        response = [item for item in out if item.get("id") == "c1"][0]
        self.assertEqual(response["result"]["protocolVersion"], 1)

    async def test_unknown_method_and_host_exception_become_errors(self) -> None:
        out, _host = await self._run(
            [
                {"id": "c1", "method": "nope", "params": {}},
                {"id": "c2", "method": "boom", "params": {}},
            ]
        )
        errors = {item["id"]: item["error"] for item in out if "error" in item}
        self.assertIn("未知方法", errors["c1"])
        self.assertIn("宿主炸了", errors["c2"])

    async def test_malformed_lines_are_ignored(self) -> None:
        stdin = io.StringIO("不是 JSON\n\n" + json.dumps({"id": "c1", "method": "host.info"}) + "\n")
        stdout = io.StringIO()
        logs: list[str] = []
        server = NdjsonServer(
            lambda send: FakeHost(send), stdin=stdin, stdout=stdout, log=logs.append
        )
        self.assertEqual(await server.run(), 0)
        self.assertTrue(any("忽略" in message for message in logs))

    async def test_requests_are_concurrent(self) -> None:
        """`prompt` 挂着的时候，`permission.answer` 必须还能被处理。"""

        out, _host = await self._run(
            [
                {"id": "c1", "method": "prompt", "params": {"message": "你好"}},
                {"id": "c2", "method": "permission.answer", "params": {"id": "p1", "decision": "allow-once"}},
            ]
        )
        ids = [item.get("id") for item in out if "id" in item]
        self.assertIn("c2", ids)
        self.assertIn("c1", ids)
        frames = [item["frame"] for item in out if "frame" in item]
        self.assertEqual(frames[0]["type"], "agent_end")
        # c2 必须比 c1 先返回（否则说明是串行处理，真实场景会死锁）。
        self.assertLess(ids.index("c2"), ids.index("c1"))

    async def test_missing_method_is_logged_not_crashing(self) -> None:
        stdin = io.StringIO(json.dumps({"id": "c1"}) + "\n")
        stdout = io.StringIO()
        logs: list[str] = []
        server = NdjsonServer(
            lambda send: FakeHost(send), stdin=stdin, stdout=stdout, log=logs.append
        )
        self.assertEqual(await server.run(), 0)
        self.assertTrue(any("method" in message for message in logs))
        self.assertEqual([item for item in _parse_lines(stdout.getvalue()) if "id" in item], [])

    async def test_start_failure_reports_offline_and_exit_code(self) -> None:
        class BrokenHost(FakeHost):
            async def start(self) -> None:
                raise RuntimeError("没有模型可用")

        stdin = io.StringIO("")
        stdout = io.StringIO()
        logs: list[str] = []
        server = NdjsonServer(
            lambda send: BrokenHost(send), stdin=stdin, stdout=stdout, log=logs.append
        )
        self.assertEqual(await server.run(), 2)
        out = _parse_lines(stdout.getvalue())
        self.assertEqual(out[0]["event"], "transport")
        self.assertEqual(out[0]["status"]["state"], "offline")


class EncodingTests(unittest.TestCase):
    """Windows 上管道流默认跟随区域设置（cp936），必须锁成 UTF-8。"""

    def test_reconfigures_non_utf8_text_stream(self) -> None:
        buffer = io.BytesIO()
        stream = io.TextIOWrapper(buffer, encoding="cp936", newline="\r\n")
        self.assertIs(ensure_utf8(stream), stream)
        self.assertEqual(stream.encoding.replace("-", "").lower(), "utf8")
        stream.write("你好\n")
        stream.flush()
        self.assertEqual(buffer.getvalue(), "你好\n".encode("utf-8"))

    def test_leaves_plain_text_objects_alone(self) -> None:
        # io.StringIO 没有 reconfigure，测试替身必须原样返回。
        fake = io.StringIO()
        self.assertIs(ensure_utf8(fake), fake)
        self.assertIsNone(ensure_utf8(None))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
