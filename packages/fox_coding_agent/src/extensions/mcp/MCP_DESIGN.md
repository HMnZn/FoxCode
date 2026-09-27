# MCP extension

The extension publishes `mcp.manager`. During `session_start` it starts configured stdio
servers, negotiates MCP, follows every `tools/list` cursor, and installs one ordinary
`AgentTool` proxy per remote tool. Proxies use the collision-resistant form
`mcp__<server>__<tool>`. They pass through FoxCode's JSON Schema validation, events,
cancellation, and permission checks.

## Enable and configure

Add `"module:fox_coding_agent.src.extensions.mcp:setup"` to the `extensions` array in
`.foxcode/settings.json`. Server definitions are merged in this order:

1. `<user-dir>/mcp.json`
2. `<trusted-project>/.foxcode/mcp.json`

An untrusted project cannot contribute MCP configuration and FoxCode does not start servers
at all while the project is untrusted. A project definition replaces a same-named user
definition.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": {"ACCESS_TOKEN": "${MCP_ACCESS_TOKEN}"},
      "timeout": 30,
      "permission": "full-access",
      "protocolVersion": "auto"
    }
  }
}
```

Supported fields are `command`, `args`, `env`, `cwd`, `timeout`, `enabled`, `permission`, and
`protocolVersion`. `${NAME}` environment references fail closed when missing. Keep secrets in
the environment or a credential facility, not in JSON. `permission` defaults to
`full-access`; set it to `read-only` only when the entire server is safe to call in that mode.
Remote self-declared read-only hints are not trusted as authorization.

`protocolVersion` accepts `auto`, `2025-11-25`, or `2026-07-28`. Auto first negotiates the
legacy initialized lifecycle for compatibility; a method-not-found response selects the
2026-07-28 stateless request metadata model. Stdio cancellation sends
`notifications/cancelled`, and shutdown terminates the server process group.

`/mcp` reports server state, protocol versions, proxy names, and safe diagnostics without
printing configured environment values.

## Boundaries

This first implementation supports stdio tools. It intentionally does not implement HTTP
authorization, resources, prompts, elicitation, sampling, tasks, or MCP Apps. Server-to-client
requests receive method-not-supported. Unknown content blocks are preserved as JSON text;
text and base64 image blocks map to FoxCode's native tool-result blocks.

Dynamic proxies are ephemeral: `ExtensionContext.add_runtime_tools()` makes them available to the
current model request without persisting their names into session settings. A resumed session
must rediscover current servers, so stale MCP tool selections cannot prevent startup.
