"""User-level session paths.

The storage root is deliberately mandatory.  Session persistence must never
fall back to the process working directory: desktop sidecars can be launched
from different directories, which would otherwise scatter history across
projects.
"""

from __future__ import annotations

import re
from pathlib import Path
from uuid import uuid4


SESSION_FILENAME = "session.jsonl"


def normalized_cwd(cwd: str | Path) -> str:
    """Return a readable, filesystem-safe workspace bucket name."""

    raw = str(cwd).replace("\\", "/").strip()
    # Drive separators, path separators, whitespace and punctuation all become
    # one dash.  Keep unicode word characters so non-English folders stay
    # recognisable in the user's session directory.
    readable = re.sub(r"[\W_]+", "-", raw, flags=re.UNICODE).strip("-")
    return f"--{readable or 'root'}--"


def session_id_from_path(path: str | Path) -> str:
    """Read an id from the directory layout (and from legacy flat names)."""

    candidate = Path(path)
    return candidate.parent.name if candidate.name == SESSION_FILENAME else candidate.stem


class SessionLayout:
    """Resolve session locations below an explicitly supplied user root."""

    def __init__(self, root: str | Path) -> None:
        if root is None or not str(root).strip():
            raise ValueError("SessionLayout root is required")
        self.root = Path(root).expanduser().resolve()

    def workspace_dir(self, cwd: str | Path) -> Path:
        return self.root / normalized_cwd(cwd)

    def new_session_file(self, cwd: str | Path) -> Path:
        return self.workspace_dir(cwd) / f"session-{uuid4()}" / SESSION_FILENAME

    def files(self, cwd: str | Path) -> list[Path]:
        directory = self.workspace_dir(cwd)
        if not directory.is_dir():
            return []
        return sorted(directory.glob(f"session-*/{SESSION_FILENAME}"))

    def all_files(self) -> list[Path]:
        """Return sessions from every workspace bucket below this user root."""

        if not self.root.is_dir():
            return []
        return sorted(self.root.glob(f"--*--/session-*/{SESSION_FILENAME}"))


__all__ = [
    "SESSION_FILENAME",
    "SessionLayout",
    "normalized_cwd",
    "session_id_from_path",
]
