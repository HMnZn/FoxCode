"""pi-agent-core 核心类型。

对应上游 ``packages/agent/src/types.ts``。

关键契约：
- ``AgentTool.execute`` 是用户实现工具的入口。Python 版用 asyncio.Event
  替代 TS 的 AbortSignal 做取消。
- ``AgentEvent`` 是 agent 层事件（不同于 pi-ai 的流式事件），覆盖 agent/turn/
  message/tool 四层生命周期。
- 模型/工具错误编码为消息；配置、持久化与事件接收器错误向宿主抛出。
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from fox_ai.src import (
    AssistantMessage,
    AssistantMessageEvent,
    Context,
    EventStream,
    ImageContent,
    Message,
    Model,
    SimpleStreamOptions,
    TextContent,
    ThinkingLevel,
    ToolCall,
    ToolResultMessage,
)

# ============================================================
# 基础别名
# ============================================================

#: 工具执行模式。
ToolExecutionMode = Literal["sequential", "parallel"]

#: 消息队列模式。
QueueMode = Literal["all", "one-at-a-time"]

#: agent 循环中的消息（复用 pi-ai 的 Message 联合）。
AgentMessage = Message

#: 工具调用块（从 AssistantMessage.content 提取）。
AgentToolCall = ToolCall


# ============================================================
# AgentToolResult / AgentTool
# ============================================================


@dataclass
class AgentToolResult:
    """工具执行结果。

    - ``content``：返回给模型的内容。
    - ``details``：给日志/UI 的结构化详情（不发给模型）。
    - ``terminate``：提示本 batch 之后应停止（仅当批次里所有 result 都 terminate=True 才生效）。
    """

    content: list[TextContent | ImageContent] = field(default_factory=list) #按约定返回给模型的文本或图片
    details: Any = None #给日志或 UI 使用的结构化信息，按约定不发给模型
    added_tool_names: list[str] | None = None #传递给工具结果的元数据；不会自动注册新工具
    terminate: bool = False  #请求在当前批次之后停止；注释规定同批所有结果都为 True 才生效


#: 工具执行时的进度回调（流式更新）。
AgentToolUpdateCallback = Callable[[AgentToolResult], None]


class AgentTool(Protocol): #约定一个工具应该具备什么
    """工具契约。继承 pi-ai 的 Tool（name/description/parameters），增加执行逻辑。

    用户实现工具时遵守 ``execute`` 签名：
        async def execute(
            tool_call_id: str,
            params: dict,           # 已校验
            cancel_event: asyncio.Event | None,
            on_update: Callable | None,
        ) -> AgentToolResult

    失败语义：抛异常 = 失败（被循环捕获转成 error result）；返回 = 成功。
    """

    name: str #工具的名字
    description: str #工具的描述
    parameters: dict[str, Any] #工具接收的参数
    label: str
    execution_mode: ToolExecutionMode | None  #顺序还是并行

    def execute( #实际执行工具
        self,
        tool_call_id: str, #标识某一次调用，同一工具被调用多次时靠它区分
        params: dict[str, Any], #本次调用的参数；注释约定调用前已完成校验
        cancel_event: asyncio.Event | None = None, #取消信号，工具需要主动检查并配合退出
        on_update: AgentToolUpdateCallback | None = None, #执行过程中的进度回调
    ) -> Awaitable[AgentToolResult]: ...


# ============================================================
# AgentContext / AgentState
# ============================================================


@dataclass
class AgentContext:
    """agent 调用上下文快照。"""

    system_prompt: str
    messages: list[AgentMessage]
    tools: list[AgentTool] | None = None


# 占位默认 Model（实际使用时由 AgentOptions.initial_state 覆盖）
_DEFAULT_MODEL = Model(
    id="unknown",
    name="unknown",
    api="unknown",
    provider="unknown",
    base_url="",
    reasoning=False,
    input=[],
    context_window=0,
    max_tokens=0,
)


@dataclass
class AgentState:
    """Agent 的可变状态（有状态 Agent 维护）。

    这些类只负责存储字段。更新状态、通知 UI，以及注释中提到的“每次更新都新建”，
    都需要外部代码实现。AgentContext 也不会因为被称为“快照”就自动复制里面的列表。
    """

    system_prompt: str = ""
    model: Model = field(default_factory=lambda: _DEFAULT_MODEL.model_copy(deep=True)) #使用的模型
    thinking_level: ThinkingLevel | None = None #思考级别
    tools: list[AgentTool] = field(default_factory=list)
    messages: list[AgentMessage] = field(default_factory=list)
    is_streaming: bool = False #是否正在流式生成
    streaming_message: AgentMessage | None = None #当前尚未生成完的消息
    pending_tool_calls: set[str] = field(default_factory=set) #尚未完成的工具调用 ID 集合
    error_message: str | None = None  #当前错误信息


# ============================================================
# 流函数与配置
# ============================================================

#: 流函数抽象（默认 pi-ai 的 stream_simple）。
StreamFn = Callable[
    [Model, Context, SimpleStreamOptions | None],
    EventStream[AssistantMessageEvent, AssistantMessage],
]


@dataclass
class AgentLoopConfig:
    """agent 循环配置。

    不继承 SimpleStreamOptions（Pydantic），改为独立 dataclass，避免
    dataclass + Pydantic 继承冲突。stream 选项字段（api_key/reasoning 等）
    直接声明为可选字段，在 LLM 调用边界提取。

    钩子字段都是可选的，宿主按需提供。
    """

    model: Model = field(default_factory=lambda: _DEFAULT_MODEL.model_copy(deep=True))
    # stream 选项（对应 SimpleStreamOptions 的子集）
    api_key: str | None = None
    reasoning: ThinkingLevel | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    session_id: str | None = None
    thinking_budgets: dict[str, int] | None = None
    stream_options: dict[str, Any] = field(default_factory=dict)
    #: 每次模型请求前执行，包括第一轮、steering 和 follow-up 注入之后。
    prepare_request: Any = None
    #: 单次运行最多调用模型多少次；None 表示不设限。
    max_turns: int | None = 100
    # 钩子 就是预留给外部传入的处理函数
    convert_to_llm: Any = None
    transform_context: Any = None
    get_api_key: Any = None
    should_stop_after_turn: Any = None
    prepare_next_turn: Any = None
    get_steering_messages: Any = None
    get_follow_up_messages: Any = None
    tool_execution: ToolExecutionMode = "parallel"
    before_tool_call: Any = None
    after_tool_call: Any = None


# ============================================================
# Agent 事件（agent 层，覆盖四层生命周期）

# ============================================================
'''
| 层次 | 事件 | 描述 |
|---|---|---|
| Agent | `AgentStartEvent`、`AgentEndEvent` | 一次完整运行的开始和结束 |
| Turn | `TurnStartEvent`、`TurnEndEvent` | 一轮处理的开始和结束 |
| Message | `MessageStartEvent`、`MessageUpdateEvent`、`MessageEndEvent` | 消息的开始、更新、完成 |
| Tool | `ToolExecutionStartEvent`、`ToolExecutionUpdateEvent`、`ToolExecutionEndEvent` | 工具的开始、进度、结束 |
'''

@dataclass
class AgentStartEvent:
    type: Literal["agent_start"] = "agent_start"


@dataclass
class AgentEndEvent:
    type: Literal["agent_end"] = "agent_end"
    messages: list[AgentMessage] = field(default_factory=list)


@dataclass
class TurnStartEvent:
    type: Literal["turn_start"] = "turn_start"


@dataclass
class TurnEndEvent:
    type: Literal["turn_end"] = "turn_end"
    message: AgentMessage = None  # type: ignore[assignment]
    tool_results: list[ToolResultMessage] = field(default_factory=list)


@dataclass
class MessageStartEvent:
    type: Literal["message_start"] = "message_start"
    message: AgentMessage = None  # type: ignore[assignment]


@dataclass
class MessageUpdateEvent:
    """assistant 消息流式更新（携带底层 pi-ai 流式事件）。"""

    type: Literal["message_update"] = "message_update"
    message: AgentMessage = None  # type: ignore[assignment]
    assistant_message_event: AssistantMessageEvent | None = None


@dataclass
class MessageEndEvent:
    type: Literal["message_end"] = "message_end"
    message: AgentMessage = None  # type: ignore[assignment]



#工具的执行
@dataclass
class ToolExecutionStartEvent: #开始执行
    type: Literal["tool_execution_start"] = "tool_execution_start"
    tool_call_id: str = ""
    tool_name: str = ""
    args: Any = None


@dataclass
class ToolExecutionUpdateEvent: #中间进度，可以出现零次或多次
    type: Literal["tool_execution_update"] = "tool_execution_update"
    tool_call_id: str = ""
    tool_name: str = "" #正在执行哪个工具
    args: Any = None #这次调用的输入参数
    partial_result: AgentToolResult | None = None #执行过程中的部分结果或进度


@dataclass
class ToolExecutionEndEvent: #执行结束，携带最终结果和错误标记
    type: Literal["tool_execution_end"] = "tool_execution_end"
    tool_call_id: str = ""
    tool_name: str = ""
    result: AgentToolResult | None = None
    is_error: bool = False


#: Agent 事件联合。
AgentEvent = (
    AgentStartEvent
    | AgentEndEvent
    | TurnStartEvent
    | TurnEndEvent
    | MessageStartEvent
    | MessageUpdateEvent
    | MessageEndEvent
    | ToolExecutionStartEvent
    | ToolExecutionUpdateEvent
    | ToolExecutionEndEvent
)


__all__ = [
    "ToolExecutionMode",
    "QueueMode",
    "AgentMessage",
    "AgentToolCall",
    "AgentToolResult",
    "AgentToolUpdateCallback",
    "AgentTool",
    "AgentContext",
    "AgentState",
    "StreamFn",
    "AgentLoopConfig",
    "AgentStartEvent",
    "AgentEndEvent",
    "TurnStartEvent",
    "TurnEndEvent",
    "MessageStartEvent",
    "MessageUpdateEvent",
    "MessageEndEvent",
    "ToolExecutionStartEvent",
    "ToolExecutionUpdateEvent",
    "ToolExecutionEndEvent",
    "AgentEvent",
]
