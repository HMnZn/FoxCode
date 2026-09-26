"""Harness-level event marker used by hosts and future transports."""

from typing import Protocol


class HarnessEvent(Protocol):
    type: str


__all__ = ["HarnessEvent"]
