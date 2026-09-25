"""Run with: fox --extension examples/extensions/project_info.py --command project-info

Registers a model tool and a CLI command; it contributes a prompt rule and protects .env files.
This is an example policy, not a filesystem sandbox.
"""

from pathlib import Path

from fox_ai.src import TextContent
from fox_agent_core.src import AgentToolResult


class WordCountTool:
    name = "word_count"
    label = "Count words"
    description = "Count whitespace-separated words in supplied text"
    parameters = {
        "type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"],
        "additionalProperties": False,
    }

    async def execute(self, call_id, params, cancel_event=None, on_update=None):
        count = len(params["text"].split())
        return AgentToolResult(content=[TextContent(text=str(count))], details={"words": count})


def setup(api):
    def project_info(arguments, context):
        return {"cwd": str(context.cwd), "entries": len(context.session.get_entries())}

    def guard(data, context):
        if data["tool_call"].name in {"read", "write", "edit"}:
            path = Path(data["args"]["path"])
            resolved = (context.cwd / path).resolve()
            if resolved.name == ".env":
                return {"block": True, "reason": "This example extension blocks .env file access."}

    api.register_tool(WordCountTool())
    api.register_command("project-info", project_info, "Show current project and session entry count")
    api.add_prompt_guideline("Use word_count for exact whitespace-separated word counts when it is enabled.")
    api.on("tool_call", guard)
