"""A small reusable lifecycle wrapper around Agent.

The harness knows nothing about cwd, configuration files, coding tools or
credentials. Hosts inject prepared AgentOptions and persistence hooks.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from .._async import maybe_await
from ..agent import Agent, AgentOptions
from ..types import AgentMessage, AgentState, MessageEndEvent
from .hooks import HarnessHooks


@dataclass
class AgentHarnessConfig:
    agent_options: AgentOptions
    hooks: HarnessHooks = field(default_factory=HarnessHooks)


class AgentHarness:
    """Single-operation Agent lifecycle with injected persistence."""

    def __init__(self, config: AgentHarnessConfig) -> None:
        self.config = config
        self.hooks = config.hooks
        self.agent = Agent(config.agent_options)
        self._busy = False
        self._idle: asyncio.Future | None = None
        self._listeners: list[Any] = []
        self.agent.subscribe(self._on_agent_event)

    @property
    def state(self) -> AgentState:
        return self.agent.state

    @property
    def is_running(self) -> bool:
        return self._busy

    def subscribe(self, listener):
        self._listeners.append(listener)

        def unsubscribe():
            if listener in self._listeners:
                self._listeners.remove(listener)
        return unsubscribe

    async def emit(self, event) -> None:
        for listener in list(self._listeners):
            await maybe_await(listener(event, self.agent.cancel_event))

    async def _on_agent_event(self, event, cancel_event) -> None:
        if isinstance(event, MessageEndEvent) and self.hooks.persist_message:
            await maybe_await(self.hooks.persist_message(event.message))
        for listener in list(self._listeners):
            await maybe_await(listener(event, cancel_event))

    def ensure_idle(self) -> None:
        if self._busy or self.agent.is_running:
            raise RuntimeError("Harness is already processing. Use steer() or follow_up() to queue messages.")

    async def run(self, action):
        self.ensure_idle()
        self._busy = True
        self._idle = asyncio.get_running_loop().create_future()
        try:
            if self.hooks.before_run:
                await maybe_await(self.hooks.before_run())
            return await action()
        finally:
            try:
                if self.hooks.after_run:
                    await maybe_await(self.hooks.after_run())
            finally:
                self._busy = False
                self._idle.set_result(None)

    async def prompt(self, message: str | AgentMessage | list[AgentMessage]) -> None:
        await self.run(lambda: self.agent.prompt(message))

    async def continue_(self) -> None:
        await self.run(self.agent.continue_)

    def steer(self, message: str | AgentMessage) -> None:
        self.agent.steer(message)

    def follow_up(self, message: str | AgentMessage) -> None:
        self.agent.follow_up(message)

    def promote_follow_ups(self) -> int:
        return self.agent.promote_follow_ups()

    def abort(self) -> None:
        self.agent.abort()

    async def wait_for_idle(self) -> None:
        if self._idle is not None:
            await asyncio.shield(self._idle)


__all__ = ["AgentHarness", "AgentHarnessConfig"]
