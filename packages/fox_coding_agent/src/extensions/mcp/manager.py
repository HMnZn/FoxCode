"""MCP connection manager and AgentTool proxy implementation."""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any

from fox_ai.src import ImageContent, TextContent
from fox_agent_core.src import AgentToolResult

from .client import McpConnection
from .config import McpConfigResult, McpServerConfig


_UNSAFE_TOOL_CHARS = re.compile(r"[^a-zA-Z0-9_-]+")


def _safe_component(value: str) -> str:
    safe = _UNSAFE_TOOL_CHARS.sub("_", value).strip("_")
    if not safe:
        raise ValueError(f"MCP tool name has no usable characters: {value!r}")
    return safe[:64]


def proxy_name(server_name: str, tool_name: str) -> str:
    return f"mcp__{_safe_component(server_name)}__{_safe_component(tool_name)}"


def _tool_result(result: dict[str, Any]) -> AgentToolResult:
    content = []
    for block in result.get("content", []):
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            content.append(TextContent(text=block["text"]))
        elif (block.get("type") == "image" and isinstance(block.get("data"), str)
              and isinstance(block.get("mimeType"), str)):
            content.append(ImageContent(data=block["data"], mimeType=block["mimeType"]))
        else:
            content.append(TextContent(text=json.dumps(block, ensure_ascii=False)))
    structured = result.get("structuredContent")
    if not content and structured is not None:
        content.append(TextContent(text=json.dumps(structured, ensure_ascii=False, indent=2)))
    if not content:
        content.append(TextContent(text="(MCP tool returned no content)"))
    details = {
        "mcp": True,
        "is_error": bool(result.get("isError")),
        "structured_content": structured,
    }
    if result.get("isError"):
        message = "\n".join(block.text for block in content if isinstance(block, TextContent))
        raise RuntimeError(message or "MCP tool reported an error")
    return AgentToolResult(content=content, details=details)


class McpToolProxy:
    execution_mode = "parallel"

    def __init__(
        self, connection: McpConnection, server: McpServerConfig, definition: dict[str, Any],
    ) -> None:
        remote_name = definition.get("name")
        if not isinstance(remote_name, str) or not remote_name:
            raise ValueError("MCP tool definition is missing a string name")
        schema = definition.get("inputSchema", {"type": "object", "properties": {}})
        if not isinstance(schema, dict):
            raise ValueError(f"MCP tool '{remote_name}' has a non-object inputSchema")
        self.connection = connection
        self.remote_name = remote_name
        self.server_name = server.name
        self.name = proxy_name(server.name, remote_name)
        self.label = f"{server.name}: {remote_name}"
        remote_description = definition.get("description")
        self.description = remote_description if isinstance(remote_description, str) else (
            f"MCP tool {remote_name} provided by server {server.name}"
        )
        self.parameters = schema
        self.required_permission = server.permission
        self.annotations = definition.get("annotations")

    async def execute(self, call_id, params, cancel_event=None, on_update=None):
        result = await self.connection.call_tool(self.remote_name, params)
        return _tool_result(result)


@dataclass(frozen=True)
class McpServerStatus:
    name: str
    connected: bool
    protocol_version: str | None
    tool_count: int
    source: str
    error: str | None = None


class McpManager:
    """Own configured connections, discovery results, proxies, and diagnostics."""

    def __init__(self, config_result: McpConfigResult, *, max_servers: int = 16) -> None:
        self.config_result = config_result
        self.max_servers = max_servers
        self.connections: dict[str, McpConnection] = {}
        self.proxies: list[McpToolProxy] = []
        self.errors: dict[str, str] = {}
        self._tool_counts: dict[str, int] = {}
        self._started = False
        self._lock = asyncio.Lock()

    async def start(self) -> list[McpToolProxy]:
        async with self._lock:
            if self._started:
                return list(self.proxies)
            configs = list(self.config_result.servers.values())
            if len(configs) > self.max_servers:
                raise ValueError(
                    f"MCP configuration has {len(configs)} enabled servers; maximum is {self.max_servers}"
                )

            async def connect(config: McpServerConfig):
                connection = McpConnection(config)
                try:
                    await connection.connect()
                    definitions = await connection.list_tools()
                    proxies = [McpToolProxy(connection, config, item) for item in definitions]
                    return config, connection, proxies, None
                except Exception as exc:
                    await connection.close()
                    return config, None, [], str(exc) or type(exc).__name__

            outcomes = await asyncio.gather(*(connect(config) for config in configs))
            names: set[str] = set()
            for config, connection, proxies, error in outcomes:
                if error is not None or connection is None:
                    self.errors[config.name] = error or "connection failed"
                    continue
                collisions = names & {tool.name for tool in proxies}
                if collisions:
                    self.errors[config.name] = f"proxy name collision: {sorted(collisions)}"
                    await connection.close()
                    continue
                names.update(tool.name for tool in proxies)
                self.connections[config.name] = connection
                self.proxies.extend(proxies)
                self._tool_counts[config.name] = len(proxies)
            self._started = True
            return list(self.proxies)

    def statuses(self) -> list[McpServerStatus]:
        values = []
        for name, config in self.config_result.servers.items():
            connection = self.connections.get(name)
            values.append(McpServerStatus(
                name=name,
                connected=connection is not None,
                protocol_version=connection.protocol_version if connection else None,
                tool_count=self._tool_counts.get(name, 0),
                source=config.source,
                error=self.errors.get(name),
            ))
        return values

    async def close(self) -> None:
        async with self._lock:
            connections = list(self.connections.values())
            self.connections.clear()
            self.proxies.clear()
            self._tool_counts.clear()
            if connections:
                await asyncio.gather(
                    *(connection.close() for connection in connections), return_exceptions=True
                )


__all__ = ["McpManager", "McpServerStatus", "McpToolProxy", "proxy_name"]
