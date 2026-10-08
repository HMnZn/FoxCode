"""Atomic text persistence shared by configuration, sessions and extensions."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def atomic_write_text(
    path: Path,
    text: str,
    *,
    newline: str | None = None,
    mode: int | None = None,
) -> None:
    """Flush a sibling temporary file, then replace the destination.

    Failures before replacement leave the previous file intact. Credentials
    can supply a POSIX mode, applied before the new file becomes visible.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", newline=newline, dir=path.parent,
            prefix=f".{path.name}-", suffix=".tmp", delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(text)
            handle.flush()
            if mode is not None and os.name != "nt":
                temporary.chmod(mode)
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def atomic_write_json(path: Path, value: Any, *, mode: int | None = None) -> None:
    """Use the same atomic publishing path for UTF-8 JSON configuration."""
    atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n", mode=mode)
