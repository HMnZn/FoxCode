# fox-agent-core

FoxCode 的 provider-neutral Agent 内核：多轮模型循环、工具调用、状态、队列、取消、事件和通用 harness。

## 边界

- 依赖 `fox-ai`，不依赖 Coding Agent 宿主。
- 不决定文件权限、工作区、CLI、MCP 或桌面协议。
- 工具通过 `AgentTool` 协议注入；宿主通过 hooks 收紧策略。

```text
input → model stream → tool calls → validated tool results → next turn → final response
```

关键模块是 `agent_loop.py`、`agent.py`、`types.py` 和 `harness/`。详细设计见
[ARCHITECTURE_GUIDE.md](ARCHITECTURE_GUIDE.md)，实验见 [AGENT_CORE_LAB.ipynb](AGENT_CORE_LAB.ipynb)。

```bash
UV_CACHE_DIR=/tmp/foxcode-uv-cache uv run python -m unittest discover -s tests -v
```

后端职责划分与重构约定见 [REFACTORING.md](../REFACTORING.md)。
