"""可取消的异步边界；取消时等待子任务清理，避免工具在后台继续运行。"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any


class OperationAborted(Exception):
    pass


async def maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


async def cancellable(value: Any, cancel_event: asyncio.Event | None) -> Any:
    if not inspect.isawaitable(value):
        return value
    task = asyncio.ensure_future(value)
    waiter = asyncio.create_task(cancel_event.wait()) if cancel_event is not None else None
    try:
        if waiter is None:
            return await task
        await asyncio.wait((task, waiter), return_when=asyncio.FIRST_COMPLETED)
        # 已完成的操作优先：不能把已经发生的文件写入报告成「未执行」。
        if task.done():
            return task.result()
        raise OperationAborted("Operation aborted")
    finally:
        for pending in (task, waiter):
            if pending is not None and not pending.done():
                pending.cancel()
        await asyncio.gather(*(t for t in (task, waiter) if t is not None), return_exceptions=True)


def check_cancelled(cancel_event: asyncio.Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise OperationAborted("Operation aborted")
