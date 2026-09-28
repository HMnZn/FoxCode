"""无状态 agent 循环：模型 → 工具 → 模型，直到完成或取消。

steering 在下一次模型请求前消费；follow-up 只在本来可以停止时消费。
持久化、技能和压缩属于 Harness，本模块仅提供 prepare_request 等扩展点。
模型/工具错误作为消息返回；事件接收器（例如磁盘存储）失败则向调用者抛出。
"""

from __future__ import annotations

import asyncio
import copy
import time
from dataclasses import replace
from typing import Any

from jsonschema import Draft202012Validator

from fox_ai.src import (
    AssistantMessage, Context, EventStream, SimpleStreamOptions, TextContent,
    Tool, ToolResultMessage, stream_simple,
)

from ._async import OperationAborted, cancellable, check_cancelled, maybe_await
from .event_stream import create_agent_stream
from .types import (
    AgentContext, AgentEndEvent, AgentEvent, AgentLoopConfig, AgentMessage,
    AgentStartEvent, AgentTool, AgentToolCall, AgentToolResult, MessageEndEvent,
    MessageStartEvent, MessageUpdateEvent, ToolExecutionEndEvent,
    ToolExecutionStartEvent, ToolExecutionUpdateEvent, TurnEndEvent, TurnStartEvent,
)

AgentEventSink = Any


class _EventSinkError(RuntimeError):
    """不能把持久化/订阅失败伪装成可继续执行的模型或工具错误。"""


def agent_loop(
    prompts: list[AgentMessage],
    context: AgentContext,
    config: AgentLoopConfig,
    cancel_event: asyncio.Event | None = None,
    stream_fn: Any = None,
) -> EventStream[AgentEvent, list[AgentMessage]]:
    """启动一次运行；result() 返回本次新增的消息，而非完整历史。"""
    return _start_stream(prompts, context, config, cancel_event, stream_fn)


def agent_loop_continue(
    context: AgentContext,
    config: AgentLoopConfig,
    cancel_event: asyncio.Event | None = None,
    stream_fn: Any = None,
) -> EventStream[AgentEvent, list[AgentMessage]]:
    if not context.messages or isinstance(context.messages[-1], AssistantMessage):
        raise ValueError("Cannot continue: context must end with user/toolResult")
    return _start_stream([], context, config, cancel_event, stream_fn)


def _start_stream(prompts, context, config, cancel_event, stream_fn):
    es = create_agent_stream()

    async def run():
        try:
            es.end(await _run_agent_loop(prompts, context, config, es.push, cancel_event, stream_fn))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            es.error(exc)

    es.set_producer(asyncio.create_task(run()))
    return es


async def _run_agent_loop(prompts, context, config, emit, cancel_event, stream_fn):
    if config.max_turns is not None and config.max_turns < 1:
        raise ValueError("max_turns must be positive or None")
    if config.tool_execution not in ("sequential", "parallel"):
        raise ValueError("Invalid tool_execution mode")
    names = [tool.name for tool in context.tools or []]
    if len(names) != len(set(names)):
        raise ValueError("Tool names must be unique")
    current = AgentContext(context.system_prompt, [*context.messages, *prompts], list(context.tools or []))
    new_messages = list(prompts)
    await _safe_emit(emit, AgentStartEvent())
    await _safe_emit(emit, TurnStartEvent())
    for message in prompts:
        await _emit_message(emit, message)
    await _run_loop(current, new_messages, config, cancel_event, emit, stream_fn)
    return new_messages


async def _run_agent_loop_continue(context, config, emit, cancel_event, stream_fn):
    return await _run_agent_loop([], context, config, emit, cancel_event, stream_fn)


def _apply_prepared(context, config, prepared):
    if not prepared:
        return context, config
    context = prepared.get("context", context)
    config = replace(config, model=prepared.get("model", config.model))
    if "thinkingLevel" in prepared:
        level = prepared["thinkingLevel"]
        config = replace(config, reasoning=None if level == "off" else level,
                         stream_options={k: v for k, v in config.stream_options.items() if k != "reasoning"})
    return context, config


async def _run_loop(current, new_messages, config, cancel_event, emit, stream_fn):
    last_turn = None
    turn_index = 0
    pending_messages = await _safe_drain(config.get_steering_messages)
    while True:
        has_more_tool_calls = True
        while has_more_tool_calls or pending_messages:
            if last_turn is not None:
                await _safe_emit(emit, TurnStartEvent())
            try:
                # Prepare only when another turn will actually run.
                stopped = cancel_event is not None and cancel_event.is_set()
                limited = config.max_turns is not None and turn_index >= config.max_turns
                if last_turn is not None and config.prepare_next_turn and not stopped and not limited:
                    prepared = await cancellable(config.prepare_next_turn(last_turn), cancel_event)
                    current, config = _apply_prepared(current, config, prepared)
                if last_turn is not None and not pending_messages and not stopped and not limited:
                    pending_messages = await _safe_drain(config.get_steering_messages)
                for message in pending_messages:
                    current.messages.append(message)
                    new_messages.append(message)
                    await _emit_message(emit, message)
                pending_messages = []
                # 已消费的队列消息先写入历史，再报告中止/上限，避免悄悄丢失输入。
                check_cancelled(cancel_event)
                if limited:
                    raise RuntimeError(f"Maximum number of model turns reached ({config.max_turns})")

                # 每次请求前调用，包含首轮；Harness 在这里检查上下文预算。
                if config.prepare_request:
                    prepared = await cancellable(config.prepare_request({
                        "context": current, "model": config.model,
                        "turn_index": turn_index, "cancel_event": cancel_event,
                    }), cancel_event)
                    current, config = _apply_prepared(current, config, prepared)
                check_cancelled(cancel_event)
            except _EventSinkError:
                raise
            except Exception as exc:
                message = _failure_message(config, exc)
                current.messages.append(message)
                await _emit_message(emit, message)
            else:
                message = await _stream_assistant_response(current, config, cancel_event, emit, stream_fn)
                turn_index += 1
            new_messages.append(message)

            tool_calls = [c for c in message.content if isinstance(c, AgentToolCall)]
            tool_results = []
            has_more_tool_calls = False
            if tool_calls:
                # 输出截断或中止，也为每一个调用补齐结果，保证历史可继续使用。
                skip = None
                if message.stop_reason == "length":
                    skip = "Tool call was truncated (output length limit reached)"
                elif message.stop_reason in ("error", "aborted"):
                    skip = "Tool call was not executed because the response failed or was aborted"
                batch = await _execute_tool_calls(current, message, config, cancel_event, emit, skip)
                tool_results = batch["messages"]
                has_more_tool_calls = skip is None and not batch["terminate"]
                current.messages.extend(tool_results)
                new_messages.extend(tool_results)
            await _safe_emit(emit, TurnEndEvent(message=message, tool_results=tool_results))
            last_turn = {"message": message, "tool_results": tool_results,
                         "context": current, "new_messages": new_messages}
            if message.stop_reason in ("error", "aborted") or (cancel_event and cancel_event.is_set()):
                await _safe_emit(emit, AgentEndEvent(messages=new_messages))
                return
            if config.should_stop_after_turn:
                try:
                    stop = await cancellable(config.should_stop_after_turn(last_turn), cancel_event)
                except OperationAborted:
                    stop = True
                if stop:
                    await _safe_emit(emit, AgentEndEvent(messages=new_messages))
                    return
            pending_messages = await _safe_drain(config.get_steering_messages)
        # 没有工具也没有 steering 时，才消费 follow-up。
        pending_messages = await _safe_drain(config.get_follow_up_messages)
        if not pending_messages:
            break
    await _safe_emit(emit, AgentEndEvent(messages=new_messages))


def _failure_message(config: AgentLoopConfig, exc: Exception) -> AssistantMessage:
    return AssistantMessage(
        api=config.model.api, provider=config.model.provider, model=config.model.id,
        stop_reason="aborted" if isinstance(exc, OperationAborted) else "error",
        error_message=str(exc), timestamp=int(time.time() * 1000),
    )


async def _stream_assistant_response(context, config, cancel_event, emit, stream_fn):
    response = None
    partial = None
    added_partial = False
    try:
        check_cancelled(cancel_event)
        messages = context.messages
        if config.transform_context:
            messages = await cancellable(config.transform_context(messages, cancel_event), cancel_event)
        if config.convert_to_llm:
            messages = await cancellable(config.convert_to_llm(messages), cancel_event)
        llm_context = Context(system_prompt=context.system_prompt or None, messages=messages,
                              tools=_convert_tools(context.tools) if context.tools else None)
        opts = dict(config.stream_options)
        for name in ("api_key", "reasoning", "temperature", "max_tokens", "session_id", "thinking_budgets"):
            value = getattr(config, name)
            if value is not None:
                opts[name] = value
        if config.get_api_key:
            key = await cancellable(config.get_api_key(config.model.provider), cancel_event)
            if key:
                opts["api_key"] = key
        opts["cancel_event"] = cancel_event
        response = (stream_fn or stream_simple)(
            config.model, llm_context, SimpleStreamOptions(**opts)
        )
        iterator = response.__aiter__()
        # An HTTP connection can stay open forever without yielding another
        # SSE chunk.  Provider timeouts are not enough for custom StreamFn
        # implementations, and historically this left a run stuck immediately
        # after a fast tool such as `ls`.  Treat timeout_ms as a per-event idle
        # deadline as well as the provider request timeout.
        idle_timeout_ms = opts.get("timeout_ms")
        while True:
            # A buffered iterator can complete anext() in the same tick as the
            # cancellation waiter. cancellable() deliberately prefers completed
            # operations (important for writes), so check explicitly between
            # model events instead of draining the whole backlog after abort.
            check_cancelled(cancel_event)
            try:
                if idle_timeout_ms is not None:
                    async with asyncio.timeout(float(idle_timeout_ms) / 1000):
                        event = await cancellable(anext(iterator), cancel_event)
                else:
                    event = await cancellable(anext(iterator), cancel_event)
            except StopAsyncIteration:
                break
            except TimeoutError:
                raise RuntimeError(
                    f"Model stream timeout: produced no event for "
                    f"{float(idle_timeout_ms) / 1000:g}s"
                ) from None
            if event.type in ("done", "error"):
                break
            partial = event.partial.model_copy(deep=True)
            if not added_partial:
                context.messages.append(partial)
                added_partial = True
                await _safe_emit(emit, MessageStartEvent(message=partial))
            else:
                context.messages[-1] = partial
            if event.type != "start":
                await _safe_emit(emit, MessageUpdateEvent(
                    message=partial, assistant_message_event=event.model_copy(deep=True)))
        final = await cancellable(response.result(), cancel_event)
        if final.stop_reason == "pending":
            raise RuntimeError("Model stream ended without a stop reason")
    except _EventSinkError:
        raise
    except Exception as exc:
        final = _failure_message(config, exc)
        if partial is not None:
            final.content = partial.content
    finally:
        if response is not None:
            await response.aclose()
    if added_partial:
        context.messages[-1] = final
    else:
        context.messages.append(final)
        await _safe_emit(emit, MessageStartEvent(message=final))
    await _safe_emit(emit, MessageEndEvent(message=final))
    return final


def _convert_tools(tools: list[AgentTool]) -> list[Tool]:
    return [Tool(name=t.name, description=t.description, parameters=t.parameters,
                 constrained_sampling=getattr(t, "constrained_sampling", None)) for t in tools]


async def _execute_tool_calls(context, message, config, cancel_event, emit, skip=None):
    calls = [c for c in message.content if isinstance(c, AgentToolCall)]
    sequential = config.tool_execution == "sequential" or any(
        getattr(_find_tool(context.tools, c.name), "execution_mode", None) == "sequential" for c in calls)
    if sequential:
        outcomes = []
        for call in calls:
            outcome = await _execute_single(context, message, call, config, cancel_event, emit, skip)
            outcomes.append(outcome)
            await _emit_message(emit, outcome[0])
    else:
        # 接收器失败时取消并等待其余工具，不留下后台任务。
        async with asyncio.TaskGroup() as group:
            tasks = [group.create_task(_execute_single(context, message, c, config, cancel_event, emit, skip))
                     for c in calls]
        outcomes = [task.result() for task in tasks]
        for result, _ in outcomes:
            await _emit_message(emit, result)
    return {"messages": [r for r, _ in outcomes],
            "terminate": bool(outcomes) and all(stop for _, stop in outcomes)}


async def _execute_single(context, message, call, config, cancel_event, emit, skip=None):
    await _safe_emit(emit, ToolExecutionStartEvent(tool_call_id=call.id, tool_name=call.name, args=call.arguments))
    tool = _find_tool(context.tools, call.name)
    updates: list[asyncio.Task] = []
    accepting_updates = True

    def on_update(partial):
        if not accepting_updates:
            return
        previous = updates[-1] if updates else None
        snapshot = copy.deepcopy(partial)

        async def deliver():
            if previous is not None:
                await previous
            await _safe_emit(emit, ToolExecutionUpdateEvent(
                tool_call_id=call.id, tool_name=call.name, args=call.arguments, partial_result=snapshot))

        updates.append(asyncio.create_task(deliver()))

    is_error = False
    result = None
    validated = None
    try:
        if skip:
            raise ValueError(skip)
        check_cancelled(cancel_event)
        if tool is None:
            raise ValueError(f"Tool '{call.name}' not found")
        validated = _validate_args(tool, call.arguments)
        if config.before_tool_call:
            before = await cancellable(config.before_tool_call({
                "assistant_message": message, "tool_call": call, "args": validated,
                "context": context}, cancel_event), cancel_event)
            if before and before.get("block"):
                result = _error_result(before.get("reason", "Tool execution was blocked"))
                result.terminate = bool(before.get("terminate"))
                is_error = True
        check_cancelled(cancel_event)
        if result is None:
            result = await cancellable(tool.execute(call.id, validated, cancel_event, on_update), cancel_event)
            if not isinstance(result, AgentToolResult):
                raise TypeError("Tool execute() must return AgentToolResult")
    except _EventSinkError:
        raise
    except Exception as exc:
        result, is_error = _error_result(str(exc)), True
    finally:
        accepting_updates = False
        if updates:
            # 进度先于 tool_execution_end；进度接收器的失败也必须可见。
            settled = await asyncio.gather(*updates, return_exceptions=True)
            for outcome in settled:
                if isinstance(outcome, BaseException):
                    raise outcome
    if config.after_tool_call and validated is not None and not (cancel_event and cancel_event.is_set()):
        try:
            after = await cancellable(config.after_tool_call({
                "assistant_message": message, "tool_call": call, "args": validated,
                "result": result, "is_error": is_error, "context": context}, cancel_event), cancel_event)
            if after:
                for key in ("content", "details", "terminate"):
                    if key in after:
                        setattr(result, key, after[key])
                is_error = after.get("is_error", is_error)
        except _EventSinkError:
            raise
        except Exception as exc:
            result, is_error = _error_result(str(exc)), True
    await _safe_emit(emit, ToolExecutionEndEvent(
        tool_call_id=call.id, tool_name=call.name, result=result, is_error=is_error))
    return ToolResultMessage(
        tool_call_id=call.id, tool_name=call.name, content=result.content, details=result.details,
        added_tool_names=result.added_tool_names, is_error=is_error, timestamp=int(time.time() * 1000),
    ), result.terminate


def _find_tool(tools, name):
    return next((t for t in tools or [] if t.name == name), None)


def _validate_args(tool, args):
    args = copy.deepcopy(args)
    if prepare := getattr(tool, "prepare_arguments", None):
        args = prepare(args)
    Draft202012Validator.check_schema(tool.parameters)
    error = next(Draft202012Validator(tool.parameters).iter_errors(args), None)
    if error:
        path = ".".join(str(p) for p in error.absolute_path) or "arguments"
        raise ValueError(f"Invalid arguments for {tool.name} at {path}: {error.message}")
    return args


def _error_result(message):
    return AgentToolResult(content=[TextContent(text=message)], details={"error": message})


async def _emit_message(emit, message):
    await _safe_emit(emit, MessageStartEvent(message=message))
    await _safe_emit(emit, MessageEndEvent(message=message))


async def _safe_emit(emit, event):
    try:
        await maybe_await(emit(event))
    except _EventSinkError:
        raise
    except Exception as exc:
        raise _EventSinkError(f"Agent event receiver failed: {exc}") from exc


async def _safe_drain(getter):
    return (await maybe_await(getter()) or []) if getter is not None else []


__all__ = ["agent_loop", "agent_loop_continue"]
