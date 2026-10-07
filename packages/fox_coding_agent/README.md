# fox-coding-agent

FoxCode 的运行时与 CLI，将通用 Agent 内核装配为可操作代码仓库的 Coding Agent。

## 能力

- `AgentSessionRuntime` 生命周期、工作区切换、会话持久化、恢复、分支和压缩。
- 用户级与项目级设置、模型目录、凭据、信任与权限。
- 文件读取、写入、编辑、搜索、Shell 和结构化计划工具。
- Local / Sandbox 执行环境；Auto / Default / Plan 交互模式。
- 静态 Skills、可配置 Extensions，以及 Memory、MCP、Subagent 三个内置扩展。

## CLI

在仓库根目录执行：

```bash
uv sync
uv run fox --trust-project --interactive
uv run fox --list-models
uv run fox --model provider/model-id -p "解释这个仓库"
uv run fox --resume
```

交互会话支持 `/new`、`/resume`、`/fork`、`/cwd`、`/reload`、`/compact`、`/model`、
`/thinking`、`/skill` 和扩展注册的命令。完整选项见 `uv run fox --help`。

## 配置

推荐使用桌面设置页管理模型与凭据，使用扩展页管理 Memory、MCP 和 Subagent。
默认用户目录为 `~/.foxcode`；可信项目可在 `<workspace>/.foxcode/` 覆盖非凭据设置。

优先级为：默认值 → 用户设置 → 可信项目设置 → 进程 overrides。
API Key 始终存入用户级 `auth.json`；项目配置不会携带凭据。
`extensions` 数组采用整体替换语义，项目列表优先于用户列表。

## 源码导航

| 模块 | 内容 |
| --- | --- |
| [`core/runtime.py`](src/core/runtime.py) | 宿主运行时与生命周期 |
| [`core/agent_session.py`](src/core/agent_session.py) | Agent 会话编排 |
| [`core/model_runtime.py`](src/core/model_runtime.py) | 模型目录与凭据装配 |
| [`core/settings.py`](src/core/settings.py) | 设置解析与覆盖 |
| [`core/tools.py`](src/core/tools.py)、[`core/tool_registry.py`](src/core/tool_registry.py) | 工具实现与注册 |
| [`core/permissions.py`](src/core/permissions.py)、[`core/sandbox.py`](src/core/sandbox.py) | 权限与隔离 |
| [`core/skills.py`](src/core/skills.py)、[`core/extensions.py`](src/core/extensions.py) | 技能发现与扩展 API |
| [`core/session_manager.py`](src/core/session_manager.py) | 会话存储与恢复 |

## 内置扩展

| 扩展 | 用途 | 文档 |
| --- | --- | --- |
| Memory | 持久化偏好、反馈、项目决策与参考资料 | [Memory](src/extensions/memory/README.md) |
| MCP | 连接外部工具服务器 | [MCP](src/extensions/mcp/README.md) |
| Subagent | 通过独立上下文执行受限子任务 | [Subagent](src/extensions/subagent/README.md) |

## 验证

```bash
uv run python -m unittest discover -s tests -v
uv run python tests/memory_eval.py
```

记忆评估与 golden fixtures 位于 `tests/`，不随运行时包发布。
文件系统布局与沙盒规则见 [执行模型](../../docs/FILESYSTEM_AND_SANDBOX.md)。
