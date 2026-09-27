"""MCP stdio client extension with dynamic AgentTool proxies."""

from .client import (
    LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION, McpConnection, McpProtocolError,
)
from .config import (
    McpConfigDiagnostic, McpConfigResult, McpServerConfig, load_mcp_config,
)
from .extension import McpExtensionConfig, McpService, create_mcp_extension, setup
from .manager import McpManager, McpServerStatus, McpToolProxy, proxy_name

__all__ = [
    "LEGACY_PROTOCOL_VERSION", "MODERN_PROTOCOL_VERSION", "McpConfigDiagnostic",
    "McpConfigResult", "McpConnection", "McpExtensionConfig", "McpManager",
    "McpProtocolError", "McpServerConfig", "McpServerStatus", "McpService",
    "McpToolProxy", "create_mcp_extension", "load_mcp_config", "proxy_name", "setup",
]
