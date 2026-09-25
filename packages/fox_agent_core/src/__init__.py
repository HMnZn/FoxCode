"""通用 Agent 内核。项目文件、会话和编码策略由 fox_coding_agent 提供。"""

from .agent import Agent, AgentOptions
from .agent_loop import agent_loop, agent_loop_continue
from .event_stream import create_agent_stream
from .types import (
    AgentContext,
    AgentEndEvent,
    AgentEvent,
    AgentLoopConfig,
    AgentMessage,
    AgentStartEvent,
    AgentState,
    AgentTool,
    AgentToolCall,
    AgentToolResult,
    AgentToolUpdateCallback,
    MessageEndEvent,
    MessageStartEvent,
    MessageUpdateEvent,
    QueueMode,
    StreamFn,
    ToolExecutionEndEvent,
    ToolExecutionMode,
    ToolExecutionStartEvent,
    ToolExecutionUpdateEvent,
    TurnEndEvent,
    TurnStartEvent,
)

__version__ = "0.85.1"
__all__ = [
    "Agent",
    "AgentOptions",
    "agent_loop",
    "agent_loop_continue",
    "create_agent_stream",
    "AgentContext",
    "AgentEndEvent",
    "AgentEvent",
    "AgentLoopConfig",
    "AgentMessage",
    "AgentStartEvent",
    "AgentState",
    "AgentTool",
    "AgentToolCall",
    "AgentToolResult",
    "AgentToolUpdateCallback",
    "MessageEndEvent",
    "MessageStartEvent",
    "MessageUpdateEvent",
    "QueueMode",
    "StreamFn",
    "ToolExecutionEndEvent",
    "ToolExecutionMode",
    "ToolExecutionStartEvent",
    "ToolExecutionUpdateEvent",
    "TurnEndEvent",
    "TurnStartEvent"
]
