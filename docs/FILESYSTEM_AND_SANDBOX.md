# FoxCode execution and filesystem model

FoxCode treats access permission and execution isolation as independent axes:

| Axis | Values | Question answered |
| --- | --- | --- |
| Interaction | `auto`, `default`, `plan` | Is this turn planning or implementation? |
| Permission | `read-only`, `workspace-modify`, `full-access` | Which capabilities may the agent request? |
| Execution | `local`, `sandbox` | Where and inside which OS boundary do tools run? |

Selecting `sandbox` never silently degrades to unrestricted execution. File
tools enforce project containment themselves. Shell is enabled only when a
native process backend is available: Bubblewrap on Linux or `sandbox-exec` on
macOS. Otherwise shell calls are blocked and the UI reports file-only sandbox
support. A process sandbox receives a read-only host filesystem, a writable
project tree, and no network namespace/access.

## Canonical paths

`UserPaths` and `ProjectPaths` in `core/paths.py` are the only path layout
authorities. New code should not construct `.foxcode` paths directly.

User-owned durable inputs and cross-project state:

```text
~/.foxcode/
├── settings.json
├── auth.json
├── models.json
├── mcp.json
├── trust.json
├── skills/
├── extensions/
├── agents/
├── prompts/
└── sessions/
```

Project-owned configuration and generated outputs:

```text
<project>/.foxcode/
├── settings.json
├── mcp.json
├── skills/
├── extensions/
├── agents/
├── prompts/
└── artifacts/
    ├── tests/
    ├── tmp/
    ├── cache/
    ├── home/
    └── logs/
```

Source files and intentional checked-in fixtures stay in their normal project
locations. Coverage data, browser profiles, screenshots, generated reports,
logs, and disposable test helpers belong under `artifacts/`. Shell tools export
`FOXCODE_ARTIFACTS_DIR`, `FOXCODE_TEST_ARTIFACTS_DIR`, `TMPDIR`, `TEMP`, `TMP`,
and `COVERAGE_FILE` so test runners have a consistent destination.
Sandboxed shells receive a minimal environment instead of inheriting provider
credentials; HOME and common package caches are redirected under `artifacts/`.

The host exposes the resolved layout in `host.info.paths`; the desktop does not
guess platform-specific locations.
