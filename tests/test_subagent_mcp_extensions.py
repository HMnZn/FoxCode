"""Offline integration tests for the packaged sub-agent and MCP extensions."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

from fox_ai.src import TextContent, ToolCall
from fox_ai.src.providers.faux import FAUX_MODEL, FauxScript, clear_scripts
from fox_coding_agent.src import AgentSessionRuntime
from fox_coding_agent.src.extensions.mcp import McpConnection, McpServerConfig, load_mcp_config
from fox_coding_agent.src.extensions.subagent import discover_subagents

from test_agent_core import scripted


def write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value if isinstance(value, str) else json.dumps(value), encoding="utf-8")


MCP_SERVER = r'''import json
import sys

for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    method = message.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": "2025-11-25",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "test-server", "version": "1"},
        }
    elif method == "tools/list":
        result = {"tools": [{
            "name": "echo",
            "description": "Echo one value",
            "inputSchema": {
                "type": "object",
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
                "additionalProperties": False,
            },
        }]}
    elif method == "tools/call":
        value = message["params"]["arguments"]["value"]
        result = {"content": [{"type": "text", "text": "remote:" + value}]}
    else:
        print(json.dumps({
            "jsonrpc": "2.0", "id": message["id"],
            "error": {"code": -32601, "message": "not found"},
        }), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
'''

MODERN_MCP_SERVER = r'''import json
import sys

for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    if message.get("method") == "initialize":
        response = {"jsonrpc": "2.0", "id": message["id"],
                    "error": {"code": -32601, "message": "removed"}}
    elif message.get("method") == "tools/list":
        meta = message.get("params", {}).get("_meta", {})
        if (meta.get("io.modelcontextprotocol/protocolVersion") != "2026-07-28"
                or "io.modelcontextprotocol/clientInfo" not in meta):
            response = {"jsonrpc": "2.0", "id": message["id"],
                        "error": {"code": -32602, "message": "missing modern metadata"}}
        else:
            response = {"jsonrpc": "2.0", "id": message["id"],
                        "result": {"tools": []}}
    else:
        continue
    print(json.dumps(response), flush=True)
'''


class ExtensionWorkspace(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.project = self.root / "project"
        self.user = self.root / "user"
        self.project.mkdir()
        clear_scripts()

    def runtime(self, stream):
        runtime = AgentSessionRuntime(
            self.project, user_dir=self.user, model=FAUX_MODEL,
            stream_fn=stream, project_trusted=True,
        )
        self.addAsyncCleanup(runtime.close)
        return runtime

    async def test_subagent_runs_with_isolated_history_and_custom_profiles(self):
        write(self.user / "settings.json", {"extensions": [
            "module:fox_coding_agent.src.extensions.subagent:setup",
        ]})
        write(self.project / ".foxcode/agents/reviewer.md", """---
name: reviewer
description: Review a focused change
allowed-tools: [read, grep]
---
You are the project reviewer. Inspect evidence and report only findings.
""")
        stream = scripted(
            FauxScript(tool_calls=[ToolCall(id="delegate", name="agent", arguments={
                "description": "review module",
                "prompt": "Inspect module.py and summarize it",
                "type": "reviewer",
            })]),
            FauxScript(text="child report"),
            FauxScript(text="parent answer"),
        )
        runtime = self.runtime(stream)
        events = []
        runtime.subscribe(lambda event, _cancel: events.append(event))
        self.assertIn("agent", [tool.name for tool in runtime.state.tools])
        await runtime.prompt("delegate this review")

        self.assertIn("agent", [tool.name for tool in runtime.state.tools])
        self.assertEqual(len(stream.contexts), 3)
        self.assertIn("project reviewer", stream.contexts[1].system_prompt)
        self.assertEqual([tool.name for tool in stream.contexts[1].tools], ["read", "grep"])
        self.assertEqual(len(stream.contexts[1].messages), 1)
        self.assertNotEqual(stream.options[0].session_id, stream.options[1].session_id)
        result = next(message for message in runtime.state.messages if message.role == "toolResult")
        self.assertEqual(result.content[0].text, "child report")
        self.assertEqual(result.details["agent_type"], "reviewer")
        progress = [
            event for event in events
            if event.type == "tool_execution_update" and event.tool_name == "agent"
        ]
        self.assertTrue(progress)
        self.assertIn("子 Agent 运行中", progress[0].partial_result.content[0].text)
        live_usage = [
            event.partial_result.details.get("context_usage", {})
            for event in progress
            if event.partial_result.details
        ]
        self.assertTrue(any(item.get("context_tokens", 0) > 0 for item in live_usage))

    async def test_subagent_child_tools_use_parent_approval_hook(self):
        write(self.user / "settings.json", {"extensions": [
            "module:fox_coding_agent.src.extensions.subagent:setup",
        ]})
        approved = []

        async def before_tool(data, _cancel):
            approved.append(data["tool_call"].name)
            return None

        stream = scripted(
            FauxScript(tool_calls=[ToolCall(id="delegate", name="agent", arguments={
                "description": "write child artifact",
                "prompt": "Create child.txt",
                "type": "general",
            })]),
            FauxScript(tool_calls=[ToolCall(id="write", name="write", arguments={
                "path": "child.txt",
                "content": "made by child",
            })]),
            FauxScript(text="child completed"),
            FauxScript(text="parent completed"),
        )
        runtime = AgentSessionRuntime(
            self.project,
            user_dir=self.user,
            model=FAUX_MODEL,
            stream_fn=stream,
            before_tool_call=before_tool,
            project_trusted=True,
        )
        self.addAsyncCleanup(runtime.close)

        await runtime.prompt("delegate the write")

        self.assertEqual(approved, ["agent", "write"])
        self.assertEqual((self.project / "child.txt").read_text(encoding="utf-8"), "made by child")

    async def test_subagent_cannot_write_outside_workspace_even_with_parent_approval(self):
        write(self.user / "settings.json", {"extensions": [
            "module:fox_coding_agent.src.extensions.subagent:setup",
        ]})
        outside = self.root / "outside.txt"
        approved = []

        async def before_tool(data, _cancel):
            approved.append(data["tool_call"].name)
            return None

        stream = scripted(
            FauxScript(tool_calls=[ToolCall(id="delegate", name="agent", arguments={
                "description": "attempt outside write",
                "prompt": "Try the requested write and report the result",
                "type": "general",
            })]),
            FauxScript(tool_calls=[ToolCall(id="write", name="write", arguments={
                "path": str(outside),
                "content": "must not escape",
            })]),
            FauxScript(text="The outside write was blocked."),
            FauxScript(text="parent completed"),
        )
        runtime = AgentSessionRuntime(
            self.project,
            user_dir=self.user,
            model=FAUX_MODEL,
            stream_fn=stream,
            before_tool_call=before_tool,
            project_trusted=True,
        )
        self.addAsyncCleanup(runtime.close)

        await runtime.prompt("delegate the outside write")

        self.assertFalse(outside.exists())
        self.assertEqual(approved, ["agent"])

    def test_untrusted_projects_do_not_load_project_agent_profiles(self):
        write(self.user / "agents/shared.md", """---
name: shared
description: User profile
---
user prompt
""")
        write(self.project / ".foxcode/agents/project.md", """---
name: project
description: Project profile
---
project prompt
""")
        catalog = discover_subagents(
            self.user, self.project, project_trusted=False
        )
        self.assertIn("shared", catalog.definitions)
        self.assertNotIn("project", catalog.definitions)

    async def test_mcp_discovers_proxies_calls_tool_and_closes_server(self):
        server = self.root / "mcp_server.py"
        write(server, MCP_SERVER)
        write(self.user / "settings.json", {"extensions": [
            "module:fox_coding_agent.src.extensions.mcp:setup",
        ]})
        write(self.user / "mcp.json", {"mcpServers": {"demo": {
            "command": sys.executable,
            "args": [str(server)],
            "permission": "read-only",
        }}})
        stream = scripted(
            FauxScript(tool_calls=[ToolCall(
                id="remote", name="mcp__demo__echo", arguments={"value": "fox"},
            )]),
            FauxScript(text="done"),
        )
        runtime = self.runtime(stream)
        self.assertNotIn("mcp__demo__echo", [tool.name for tool in runtime.state.tools])
        await runtime.prompt("call remote echo")

        self.assertIn("mcp__demo__echo", [tool.name for tool in runtime.state.tools])
        result = next(message for message in runtime.state.messages if message.role == "toolResult")
        self.assertEqual(result.content[0].text, "remote:fox")
        report = await runtime.run_command("mcp")
        self.assertTrue(report["servers"][0]["connected"])
        self.assertEqual(report["servers"][0]["protocol_version"], "2025-11-25")
        runtime.agent_session.set_active_tools(["read", "mcp__demo__echo"])
        self.assertEqual(runtime.session.build_settings()["active_tools"], ["read"])
        connection = runtime.agent_session.extension_context.service("mcp.manager").manager.connections["demo"]
        process = connection.process
        await runtime.close()
        self.assertIsNotNone(process.returncode)

    def test_mcp_project_config_requires_trust_and_overrides_user(self):
        write(self.user / "mcp.json", {"mcpServers": {
            "same": {"command": "user-command"},
        }})
        write(self.project / ".foxcode/mcp.json", {"mcpServers": {
            "same": {"command": "project-command"},
        }})
        untrusted = load_mcp_config(self.user, self.project, project_trusted=False)
        trusted = load_mcp_config(self.user, self.project, project_trusted=True)
        self.assertEqual(untrusted.servers["same"].command, "user-command")
        self.assertEqual(trusted.servers["same"].command, "project-command")

    async def test_mcp_auto_negotiates_modern_stateless_metadata(self):
        server = self.root / "modern_mcp_server.py"
        write(server, MODERN_MCP_SERVER)
        connection = McpConnection(McpServerConfig(
            name="modern", command=sys.executable, args=(str(server),), timeout=5,
        ))
        self.addAsyncCleanup(connection.close)
        await connection.connect()
        self.assertEqual(connection.protocol_version, "2026-07-28")
        self.assertEqual(await connection.list_tools(), [])


if __name__ == "__main__":
    unittest.main()
