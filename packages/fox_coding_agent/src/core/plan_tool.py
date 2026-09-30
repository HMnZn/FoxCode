"""Structured hand-off from read-only planning to an interactive host."""

from __future__ import annotations

from typing import Any

from fox_ai.src import TextContent
from fox_agent_core.src.types import AgentToolResult


def _schema() -> dict[str, Any]:
    string_list = {"type": "array", "items": {"type": "string", "minLength": 1}}
    return {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "minLength": 1},
            "steps": string_list,
            "files": string_list,
            "risks": string_list,
            "verification": string_list,
        },
        "required": ["summary", "steps"],
        "additionalProperties": False,
    }


class SubmitPlanTool:
    """Plan-only control tool whose details are rendered as a confirmation card."""

    name = "submit_plan"
    label = "Submit implementation plan"
    description = (
        "Submit the final implementation-ready plan for user approval. Call this exactly once, "
        "as the only tool call in the final planning turn. It does not implement anything."
    )
    parameters = _schema()
    required_permission = "read-only"
    permission_domain = "runtime"
    plan_safe = True
    sandbox_safe = True
    execution_mode = "sequential"

    async def execute(self, tool_call_id, params, cancel_event=None, on_update=None):
        plan = {
            "summary": str(params["summary"]).strip(),
            "steps": [str(item).strip() for item in params["steps"] if str(item).strip()],
            "files": [str(item).strip() for item in params.get("files", []) if str(item).strip()],
            "risks": [str(item).strip() for item in params.get("risks", []) if str(item).strip()],
            "verification": [
                str(item).strip() for item in params.get("verification", []) if str(item).strip()
            ],
        }
        if not plan["steps"]:
            raise ValueError("steps must contain at least one non-empty item")
        lines = [f"Plan: {plan['summary']}", "", "Steps:"]
        lines.extend(f"{index}. {step}" for index, step in enumerate(plan["steps"], 1))
        for title, key in (("Files", "files"), ("Risks", "risks"), ("Verification", "verification")):
            if plan[key]:
                lines.extend(["", f"{title}:", *(f"- {item}" for item in plan[key])])
        return AgentToolResult(
            content=[TextContent(text="\n".join(lines))],
            details={"kind": "plan", "plan": plan},
            terminate=True,
        )


__all__ = ["SubmitPlanTool"]
