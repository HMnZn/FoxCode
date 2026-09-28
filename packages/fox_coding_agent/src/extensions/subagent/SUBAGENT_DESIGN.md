# Sub-agent extension

The extension exposes one model-facing `agent` tool and the process-local
`subagent.manager` service. A child receives the parent's model, authenticated stream,
thinking level, working directory, and currently enabled tools, but receives neither the
parent transcript nor its durable `SessionManager`. Its transcript lives only in memory and
the tool returns the child's final text plus usage details.

## Enable it

Set the user or trusted-project `.foxcode/settings.json` value:

```json
{"extensions": ["module:fox_coding_agent.src.extensions.subagent:setup"]}
```

SDK callers can instead pass `create_subagent_extension()` through
`AgentSessionRuntime(extension_factories=...)`.

Built-in profiles are:

- `explore`: `read`, `grep`, `find`, and `ls` only.
- `plan`: the same read-only capabilities with a planning prompt.
- `general`: every currently enabled parent tool except `agent`, so delegation cannot recurse.

Every child tool call goes through the parent's permission hook. A `general` child therefore
has exactly the same effective permission as the main agent: it cannot turn a read-only parent
into a writer, while a desktop parent in workspace-modification mode may use its enabled shell
tools without an extra delegation-specific elevation.

## Custom profiles

Profiles are Markdown files loaded in this order:

1. `<user-dir>/agents/*.md`
2. `<trusted-project>/.foxcode/agents/*.md`

The later definition wins by name. Project profiles are never loaded for an untrusted
project. Example:

```markdown
---
name: reviewer
description: Review a focused change
allowed-tools: [read, grep]
---
You are a focused reviewer. Report findings with file paths and evidence.
```

Names are bounded and validated. Unknown tools fail the child invocation rather than silently
expanding its permissions. `/agents` returns loaded profiles and parse diagnostics.

## Lifecycle

`session_start` binds discovery to the actual `cwd`, user directory, trust decision, and
parent session. Each invocation builds a fresh in-memory `AgentSession`; cancellation of the
outer tool cancels the child. `session_shutdown` aborts and joins any remaining children.

The initial design deliberately omits child persistence, recursive delegation, shared parent
history, and automatic parallel orchestration. Parallelism is still available when the model
emits multiple `agent` calls and the parent tool execution mode is parallel.
