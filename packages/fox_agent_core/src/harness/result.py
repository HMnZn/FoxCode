"""Small typed result vocabulary for expected harness failures."""

from dataclasses import dataclass
from typing import Generic, TypeVar

T = TypeVar("T")


class HarnessError(RuntimeError):
    code = "harness_error"


@dataclass(frozen=True)
class Ok(Generic[T]):
    value: T
    ok: bool = True


@dataclass(frozen=True)
class Err:
    error: HarnessError
    ok: bool = False


Result = Ok[T] | Err


__all__ = ["HarnessError", "Ok", "Err", "Result"]
