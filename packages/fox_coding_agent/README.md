# fox-coding-agent

FoxCode 的 Coding Agent 宿主层：把通用 Agent 内核装配为可用于真实代码仓库的 runtime 和 CLI。

## 能力

- `AgentSessionRuntime` 生命周期与 cwd/session 切换
- 用户级/项目级设置、模型目录、凭据和信任
- Read/Write/Edit/Bash/Grep/Find/Ls/PowerShell 工具
- 权限检查、沙盒、Plan 模式和结构化 system prompt
- Skills、Extensions、Memory、MCP、Subagent、Skill Evolution
- 会话持久化、恢复、分支、压缩和资源加载

## CLI

```bash
uv run fox --trust-project --interactive
uv run fox --list-models
uv run fox --model provider/model-id -p "解释这个仓库"
uv run fox --resume
```

## 配置

推荐通过 FoxCode Desktop 设置中心管理。用户文件为 `models.json`、`auth.json`、
`settings.json`、`mcp.json` 和 `agents/*.md`；可信项目可在 `<workspace>/.foxcode/` 覆盖
非凭据配置。优先级是“默认值 < 用户设置 < 可信项目设置 < 进程 overrides”。

详细设计见 [ARCHITECTURE_GUIDE.md](ARCHITECTURE_GUIDE.md)，实验见
[CODING_AGENT_LAB.ipynb](CODING_AGENT_LAB.ipynb)。

```bash
UV_CACHE_DIR=/tmp/foxcode-uv-cache uv run python -m unittest discover -s tests -v
```
