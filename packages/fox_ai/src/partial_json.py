"""Bounded preview parsing for JSON tool arguments arriving in fragments.

Only close an unfinished string/container. Do not run general-purpose JSON
repair over source code: its heuristics inspect HTML/CSS as malformed JSON and
can monopolize the provider's event loop on every token. Previews are never a
substitute for decoding the complete arguments before executing a tool.
"""

from __future__ import annotations

import json
from typing import Any


def parse_partial_json(text: str) -> dict[str, Any]:
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else {}
    except (ValueError, RecursionError):
        pass

    closers: list[str] = []
    in_string = False
    escaped = False
    escape_start = -1
    string_start = 0
    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
                escape_start = index
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
            string_start = index
        elif char in "{[":
            closers.append("}" if char == "{" else "]")
            if len(closers) > 128:
                return {}
        elif char in "}]":
            if not closers or closers.pop() != char:
                return {}

    suffix = "".join(reversed(closers))
    candidate = text
    if in_string:
        # A delta may end in a backslash or halfway through a Unicode escape.
        if escaped or (escape_start >= 0 and text[escape_start:].startswith("\\u")
                       and len(text) - escape_start < 6):
            candidate = text[:escape_start]
        candidate += '"'
    candidate = candidate.rstrip()
    if candidate.endswith(":"):
        candidate += "null"
    elif candidate.endswith(","):
        candidate = candidate[:-1]
    try:
        value = json.loads(candidate + suffix)
        return value if isinstance(value, dict) else {}
    except (ValueError, RecursionError):
        # An unfinished object key is not a value yet. Preserve prior members.
        if in_string:
            prefix = text[:string_start].rstrip().rstrip(",")
            try:
                value = json.loads(prefix + suffix)
                return value if isinstance(value, dict) else {}
            except (ValueError, RecursionError):
                pass
        return {}


def parse_tool_arguments(text: str) -> dict[str, Any]:
    """Complete tool input must be an exact JSON object; never repair writes."""
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("Tool arguments must be a JSON object")
    return value
