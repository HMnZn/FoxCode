"""异步事件流。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any, Generic, TypeVar

TEvent = TypeVar("TEvent")
TResult = TypeVar("TResult")

_SENTINEL = object()


class EventStream(Generic[TEvent, TResult], AsyncIterator[TEvent]):
    """异步事件流。

    泛型参数：
    - ``TEvent``：流中事件的类型。
    - ``TResult``：终止事件携带的最终结果类型（如 ``AssistantMessage``）。
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue[Any] = asyncio.Queue()
        self._ended = False
        self._result_future: asyncio.Future[TResult] = asyncio.get_running_loop().create_future()
        self._events: list[TEvent] = []
        self._producer: asyncio.Task[Any] | None = None

    def set_producer(self, task: asyncio.Task[Any]) -> None:
        """绑定生产者，使关闭消费流时也能取消网络请求。"""
        self._producer = task

        def finished(done: asyncio.Task[Any]) -> None:
            if done.cancelled():
                if not self._ended:
                    self._ended = True
                    self._result_future.cancel()
                    self._queue.put_nowait(_SENTINEL)
            elif (exc := done.exception()) is not None:
                self.error(exc)

        task.add_done_callback(finished)

    async def aclose(self) -> None:
        """停止生产者并等待清理。已完成的结果保持可读。"""
        if self._producer is not None and self._producer is not asyncio.current_task():
            if not self._producer.done() and not self._ended:
                self._producer.cancel()
            await asyncio.gather(self._producer, return_exceptions=True)
        if not self._ended:
            self._ended = True
            self._result_future.cancel()
            self._queue.put_nowait(_SENTINEL)
        if self._result_future.done() and not self._result_future.cancelled():
            self._result_future.exception()

    # ---- 生产者接口 ----

    def push(self, event: TEvent) -> None:
        """推送一个事件。在流已结束后调用会被忽略。"""
        if self._ended:
            return
        self._events.append(event)
        self._queue.put_nowait(event)

    def end(self, result: TResult) -> None:
        """标记流成功结束，并附带最终结果。"""
        if self._ended:
            return
        self._ended = True
        if not self._result_future.done():
            self._result_future.set_result(result)
        self._queue.put_nowait(_SENTINEL)

    def error(self, error: BaseException) -> None:
        """标记流因异常结束。"""
        if self._ended:
            return
        self._ended = True
        if not self._result_future.done():
            self._result_future.set_exception(error)
        self._queue.put_nowait(_SENTINEL)

    # ---- 消费者接口 ----

    async def result(self) -> TResult:
        """等待并返回终止事件携带的最终结果。"""
        return await asyncio.shield(self._result_future)

    @property
    def events(self) -> list[TEvent]:
        """已推送的全部事件（用于重放）。"""
        return list(self._events)

    async def __anext__(self) -> TEvent:
        if self._ended and self._queue.empty():
            raise StopAsyncIteration
        item = await self._queue.get()
        if item is _SENTINEL:
            raise StopAsyncIteration
        return item  # type: ignore[no-any-return]

    def __aiter__(self) -> AsyncIterator[TEvent]:
        return self


__all__ = ["EventStream"]
