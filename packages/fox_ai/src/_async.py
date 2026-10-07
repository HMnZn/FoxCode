"""Cancellation-aware waits shared by provider and assistant retries."""

from __future__ import annotations

import asyncio


async def sleep_with_cancel(ms: float, cancel_event: asyncio.Event | None) -> None:
    """Wake immediately on cancellation and always drain both child tasks."""
    if cancel_event is None:
        await asyncio.sleep(ms / 1000)
        return
    if cancel_event.is_set():
        raise asyncio.CancelledError
    sleeper = asyncio.create_task(asyncio.sleep(ms / 1000))
    cancelled = asyncio.create_task(cancel_event.wait())
    try:
        await asyncio.wait((sleeper, cancelled), return_when=asyncio.FIRST_COMPLETED)
        if cancel_event.is_set():
            raise asyncio.CancelledError
    finally:
        for task in (sleeper, cancelled):
            if not task.done():
                task.cancel()
        await asyncio.gather(sleeper, cancelled, return_exceptions=True)
