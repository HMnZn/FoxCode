"""Callbacks injected into the generic harness by an application host."""

from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class HarnessHooks:
    persist_message: Callable[[Any], Any] | None = None
    before_run: Callable[[], Any] | None = None
    after_run: Callable[[], Any] | None = None


__all__ = ["HarnessHooks"]
