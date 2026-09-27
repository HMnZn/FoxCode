"""Dependency-free stdio JSON-RPC client for MCP servers."""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
from collections import deque
from typing import Any

from .config import McpServerConfig


MODERN_PROTOCOL_VERSION = "2026-07-28"
LEGACY_PROTOCOL_VERSION = "2025-11-25"
_ENV_REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


class McpProtocolError(RuntimeError):
    def __init__(self, code: int | None, message: str, data: object = None) -> None:
        self.code, self.data = code, data
        super().__init__(f"MCP error {code}: {message}" if code is not None else message)


def _expand_env(value: str) -> str:
    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in os.environ:
            raise ValueError(f"MCP environment variable is not set: {name}")
        return os.environ[name]
    return _ENV_REF.sub(replace, value)


class McpConnection:
    """One concurrency-safe stdio transport and its negotiated lifecycle mode."""

    def __init__(self, config: McpServerConfig) -> None:
        self.config = config
        self.process: asyncio.subprocess.Process | None = None
        self.protocol_version: str | None = None
        self.server_info: dict[str, Any] = {}
        self._next_id = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._write_lock = asyncio.Lock()
        self._lifecycle_lock = asyncio.Lock()
        self._stderr: deque[str] = deque(maxlen=40)
        self._closed = False

    @property
    def stderr_text(self) -> str:
        return " | ".join(self._stderr)

    async def connect(self) -> None:
        async with self._lifecycle_lock:
            if self.process is not None and self.process.returncode is None:
                return
            if self._closed:
                raise RuntimeError(f"MCP server '{self.config.name}' connection is closed")
            environment = dict(os.environ)
            environment.update({key: _expand_env(value) for key, value in self.config.env.items()})
            kwargs: dict[str, Any] = {}
            if os.name == "nt":
                kwargs["creationflags"] = getattr(__import__("subprocess"), "CREATE_NEW_PROCESS_GROUP", 0)
            else:
                kwargs["start_new_session"] = True
            self.process = await asyncio.create_subprocess_exec(
                self.config.command,
                *self.config.args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.config.cwd,
                env=environment,
                **kwargs,
            )
            self._reader_task = asyncio.create_task(self._read_loop())
            self._stderr_task = asyncio.create_task(self._stderr_loop())
            try:
                await self._negotiate()
            except BaseException:
                await self.close()
                raise

    def _modern_meta(self) -> dict[str, Any]:
        return {
            "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": {"name": "foxcode", "version": "0.1.0"},
            "io.modelcontextprotocol/clientCapabilities": {},
        }

    async def _negotiate(self) -> None:
        configured = self.config.protocol_version
        if configured == MODERN_PROTOCOL_VERSION:
            self.protocol_version = MODERN_PROTOCOL_VERSION
            return
        try:
            result = await self.request("initialize", {
                "protocolVersion": LEGACY_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "foxcode", "version": "0.1.0"},
            }, include_meta=False)
        except McpProtocolError as exc:
            if configured == LEGACY_PROTOCOL_VERSION or exc.code != -32601:
                raise
            self.protocol_version = MODERN_PROTOCOL_VERSION
            return
        if not isinstance(result, dict):
            raise McpProtocolError(None, "MCP initialize returned a non-object result")
        negotiated = result.get("protocolVersion")
        if not isinstance(negotiated, str):
            raise McpProtocolError(None, "MCP initialize did not return protocolVersion")
        self.protocol_version = negotiated
        self.server_info = result.get("serverInfo") if isinstance(result.get("serverInfo"), dict) else {}
        await self.notify("notifications/initialized", {}, include_meta=False)

    async def _read_loop(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        try:
            while line := await self.process.stdout.readline():
                try:
                    message = json.loads(line)
                except (UnicodeError, json.JSONDecodeError):
                    continue
                if not isinstance(message, dict):
                    continue
                request_id = message.get("id")
                if request_id in self._pending and ("result" in message or "error" in message):
                    future = self._pending.pop(request_id)
                    if future.done():
                        continue
                    if "error" in message:
                        error = message.get("error") or {}
                        future.set_exception(McpProtocolError(
                            error.get("code"), str(error.get("message", "unknown error")),
                            error.get("data"),
                        ))
                    else:
                        future.set_result(message.get("result"))
                elif "method" in message and request_id is not None:
                    await self._write({
                        "jsonrpc": "2.0", "id": request_id,
                        "error": {"code": -32601, "message": "Client method not supported"},
                    })
        finally:
            code = await self.process.wait()
            detail = self.stderr_text
            error = RuntimeError(
                f"MCP server '{self.config.name}' exited with code {code}"
                + (f": {detail}" if detail else "")
            )
            for future in list(self._pending.values()):
                if not future.done():
                    future.set_exception(error)
            self._pending.clear()

    async def _stderr_loop(self) -> None:
        assert self.process is not None and self.process.stderr is not None
        while line := await self.process.stderr.readline():
            value = line.decode("utf-8", errors="replace").strip()
            if value:
                self._stderr.append(value)

    async def _write(self, message: dict[str, Any]) -> None:
        if self.process is None or self.process.stdin is None or self.process.returncode is not None:
            raise RuntimeError(f"MCP server '{self.config.name}' is not running")
        payload = (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        async with self._write_lock:
            self.process.stdin.write(payload)
            await self.process.stdin.drain()

    def _params(self, params: dict[str, Any] | None, include_meta: bool) -> dict[str, Any]:
        values = dict(params or {})
        if include_meta and self.protocol_version == MODERN_PROTOCOL_VERSION:
            metadata = values.get("_meta") if isinstance(values.get("_meta"), dict) else {}
            values["_meta"] = {**self._modern_meta(), **metadata}
        return values

    async def request(
        self, method: str, params: dict[str, Any] | None = None, *, include_meta: bool = True,
    ) -> Any:
        request_id = self._next_id
        self._next_id += 1
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._write({
                "jsonrpc": "2.0", "id": request_id, "method": method,
                "params": self._params(params, include_meta),
            })
            async with asyncio.timeout(self.config.timeout):
                return await future
        except TimeoutError as exc:
            self._pending.pop(request_id, None)
            if method != "initialize":
                try:
                    await self.notify(
                        "notifications/cancelled",
                        {"requestId": request_id, "reason": "client cancelled or timed out"},
                        include_meta=include_meta,
                    )
                except Exception:
                    pass
            raise RuntimeError(
                f"MCP request '{method}' to '{self.config.name}' timed out after "
                f"{self.config.timeout:g}s"
            ) from exc
        except asyncio.CancelledError:
            self._pending.pop(request_id, None)
            if method != "initialize":
                try:
                    await self.notify(
                        "notifications/cancelled",
                        {"requestId": request_id, "reason": "client cancelled"},
                        include_meta=include_meta,
                    )
                except Exception:
                    pass
            raise
        except BaseException:
            self._pending.pop(request_id, None)
            raise

    async def notify(
        self, method: str, params: dict[str, Any] | None = None, *, include_meta: bool = True,
    ) -> None:
        await self._write({
            "jsonrpc": "2.0", "method": method,
            "params": self._params(params, include_meta),
        })

    async def list_tools(self) -> list[dict[str, Any]]:
        tools: list[dict[str, Any]] = []
        cursor = None
        seen_cursors: set[str] = set()
        while True:
            result = await self.request("tools/list", {"cursor": cursor} if cursor else {})
            if not isinstance(result, dict) or not isinstance(result.get("tools"), list):
                raise McpProtocolError(None, "tools/list returned an invalid result")
            tools.extend(item for item in result["tools"] if isinstance(item, dict))
            cursor = result.get("nextCursor")
            if not cursor:
                return tools
            if not isinstance(cursor, str) or cursor in seen_cursors:
                raise McpProtocolError(None, "tools/list returned an invalid or repeated cursor")
            seen_cursors.add(cursor)

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = await self.request("tools/call", {"name": name, "arguments": arguments})
        if not isinstance(result, dict):
            raise McpProtocolError(None, "tools/call returned a non-object result")
        return result

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        process = self.process
        if process is not None:
            if process.stdin is not None:
                process.stdin.close()
            if process.returncode is None:
                try:
                    if os.name != "nt":
                        os.killpg(process.pid, signal.SIGTERM)
                    else:
                        process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    async with asyncio.timeout(2):
                        await process.wait()
                except TimeoutError:
                    try:
                        if os.name != "nt":
                            os.killpg(process.pid, signal.SIGKILL)
                        else:
                            process.kill()
                    except ProcessLookupError:
                        pass
            await process.wait()
        tasks = [task for task in (self._reader_task, self._stderr_task) if task is not None]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self.process = None
        self._reader_task = self._stderr_task = None


__all__ = [
    "LEGACY_PROTOCOL_VERSION", "MODERN_PROTOCOL_VERSION", "McpConnection", "McpProtocolError",
]
