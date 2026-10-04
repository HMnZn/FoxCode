"""API-Bank request parsing and model-call helpers for the coding experiment."""

from __future__ import annotations

import ast
import re
from typing import Any

from fox_ai.src import Context, SimpleStreamOptions, TextContent, UserMessage


def parse_api_request(value: str) -> dict[str, Any] | None:
    """Parse one API-Request without executing model-produced code."""
    match = re.search(r"API-Request\s*:\s*(\[[^\n]*\])", str(value or ""), re.I)
    if match is None:
        return None
    try:
        expression = ast.parse(match.group(1), mode="eval").body
    except SyntaxError:
        return _parse_relaxed_api_request(match.group(1))
    if not isinstance(expression, ast.List) or len(expression.elts) != 1:
        return None
    call = expression.elts[0]
    if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.args:
        return None
    parameters: dict[str, Any] = {}
    try:
        for keyword in call.keywords:
            if keyword.arg is None or keyword.arg in parameters:
                return None
            parameters[keyword.arg] = ast.literal_eval(keyword.value)
    except (ValueError, TypeError, SyntaxError):
        return None
    return {"api_name": call.func.id, "parameters": parameters}


def _parse_relaxed_api_request(expression: str) -> dict[str, Any] | None:
    """Handle dataset labels with unescaped quotes inside a quoted payload."""
    call = re.fullmatch(r"\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*\]", expression.strip())
    if call is None:
        return None
    api_name, body = call.groups()
    if not body.strip():
        return {"api_name": api_name, "parameters": {}}
    keys = list(re.finditer(r"(?:^|,\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=", body))
    if not keys or keys[0].start() != 0:
        return None
    parameters: dict[str, Any] = {}
    for index, item in enumerate(keys):
        key = item.group(1)
        if key in parameters:
            return None
        end = keys[index + 1].start() if index + 1 < len(keys) else len(body)
        raw = body[item.end():end].strip()
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
            parsed: Any = raw[1:-1]
        else:
            try:
                parsed = ast.literal_eval(raw)
            except (ValueError, TypeError, SyntaxError):
                return None
        parameters[key] = parsed
    return {"api_name": api_name, "parameters": parameters}


def score_api_request(expected: str, prediction: str) -> dict[str, Any]:
    target = parse_api_request(expected)
    actual = parse_api_request(prediction)
    if target is None:
        raise ValueError(f"Invalid expected API request: {expected[:200]}")
    expected_parameters = target["parameters"]
    actual_parameters = actual["parameters"] if actual else {}
    api_name_correct = bool(actual and actual["api_name"] == target["api_name"])
    parameter_names_correct = bool(actual and set(actual_parameters) == set(expected_parameters))
    matching_values = sum(
        key in actual_parameters and actual_parameters[key] == value
        for key, value in expected_parameters.items()
    )
    parameter_value_recall = (
        round(matching_values / len(expected_parameters), 4)
        if expected_parameters else float(parameter_names_correct)
    )
    return {
        "expected_request": target,
        "predicted_request": actual,
        "parseable": actual is not None,
        "api_name_correct": api_name_correct,
        "parameter_names_correct": parameter_names_correct,
        "parameter_value_recall": parameter_value_recall,
        "passed": bool(api_name_correct and parameter_names_correct and parameter_value_recall == 1.0),
    }


async def call_text_model(
    *, stream_fn: Any, model: Any, system: str, prompt: str,
    max_tokens: int, retries: int = 1,
) -> dict[str, Any]:
    """Call the configured provider and retain every attempt for auditability."""
    attempts: list[dict[str, Any]] = []
    for attempt in range(retries + 1):
        try:
            stream = stream_fn(
                model,
                Context(system_prompt=system, messages=[UserMessage(content=prompt)]),
                SimpleStreamOptions(max_tokens=max_tokens, temperature=0.0, tool_choice="none"),
            )
            message = await stream.result()
            body = "\n".join(
                block.text for block in getattr(message, "content", [])
                if isinstance(block, TextContent)
            ).strip()
            error = str(message.error_message or "")
            usage = getattr(message, "usage", None)
            record = {
                "attempt": attempt + 1,
                "stop_reason": message.stop_reason,
                "error": error or None,
                "usage": usage.model_dump(mode="json", by_alias=True) if usage else {},
            }
            attempts.append(record)
            if message.stop_reason != "error" and not error:
                return {"text": body, **record, "attempts": attempts}
        except Exception as exc:
            attempts.append({
                "attempt": attempt + 1, "stop_reason": "exception",
                "error": f"{type(exc).__name__}: {exc}"[:1000], "usage": {},
            })
    return {"text": "", **attempts[-1], "attempts": attempts}
