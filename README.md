# FoxCode

FoxCode 是一个本地优先的桌面 Coding Agent：React/Electron 提供工作台，`fox_serve`
提供稳定的进程协议，Python runtime 负责模型、会话、工具、权限、沙盒和扩展。

## 已具备的产品能力

- 多模型供应商与模型目录，API Key 与普通设置隔离保存
- 用户级和项目级设置，可信项目才会加载项目配置
- 会话创建、恢复、分支、重命名、导出和上下文压缩
- Auto / Default / Plan 交互模式，结构化计划确认
- Read-only / Workspace modify / Full access 权限和逐次审批
- Local / Sandbox 执行环境与工作区文件边界
- Skills、Extensions、Memory、MCP、Subagents
- 图片输入、流式思考/正文、工具调用、用量统计
- 工作区改动、Diff、文件预览和内嵌终端
- 桌面设置中心：模型供应商、API Key、运行默认值、MCP、Subagent

## 快速开始

要求：Python 3.14+、[uv](https://docs.astral.sh/uv/)、Node.js 20+、npm。

```bash
uv sync
uv run fox --trust-project --interactive

cd desktop
npm install
npm run dev
```

首次使用建议打开桌面端「设置」：添加模型供应商和模型元数据，输入 API Key，选择权限与
执行环境，再按需添加 MCP 或自定义 Subagent。密钥只写入用户目录的 `auth.json`，不会回显。

没有 Python sidecar 时桌面端会进入演示模式。演示模式适合体验界面，不会调用真实模型或
执行真实文件操作。

全新用户没有 `models.json` 时，sidecar 会以不发起请求的内置模型进入首次配置模式，设置
中心仍可正常打开；保存第一个供应商后热重载正式模型目录。

## 架构

```text
desktop (Electron + React)
  └─ IPC / NDJSON
     └─ fox_serve
        └─ fox_coding_agent
           ├─ fox_agent_core
           └─ fox_ai
```

| 模块 | 职责 | 文档 |
| --- | --- | --- |
| `desktop/` | 桌面壳、工作台、设置中心、Mock host | [Desktop README](desktop/README.md) |
| `fox_serve/` | UI 与 Python runtime 的 NDJSON sidecar | [Serve README](fox_serve/README.md) |
| `packages/fox_coding_agent/` | Coding runtime、CLI、工具、权限、扩展 | [Coding Agent README](packages/fox_coding_agent/README.md) |
| `packages/fox_agent_core/` | Provider-neutral agent loop 与 harness | [Agent Core README](packages/fox_agent_core/README.md) |
| `packages/fox_ai/` | 模型类型、provider、流式协议与重试 | [AI README](packages/fox_ai/README.md) |
| `docs/` | 跨模块设计 | [文件系统与沙盒](docs/FILESYSTEM_AND_SANDBOX.md) |

依赖方向固定为：`fox-coding-agent → fox-agent-core → fox-ai`。桌面端只通过
`fox_serve` 协议使用 Python 能力，不导入 runtime 实现。

## 配置与数据

用户配置根目录默认是 `~/.foxcode`：

| 路径 | 内容 |
| --- | --- |
| `settings.json` | 模型选择、权限、执行环境、输出上限、扩展等运行策略 |
| `models.json` | 供应商、Base URL、API 适配器和模型元数据 |
| `auth.json` | API Key / OAuth 凭据；不允许放进项目配置 |
| `mcp.json` | 用户级 MCP 服务器 |
| `agents/*.md` | 用户级 Subagent profiles |
| `skills/`、`extensions/` | 用户级技能与扩展 |
| `sessions/` | 按工作区隔离的会话 JSONL |

项目级配置位于 `<workspace>/.foxcode/`。只有项目被信任后，`settings.json`、
`mcp.json`、`agents/`、`skills/` 和 `extensions/` 才会生效。密钥始终是用户级数据。

设置中心是推荐入口；CLI 用户仍可直接编辑 JSON，并用 `/reload` 重新加载。配置写入采用
同目录临时文件 + `os.replace`，无效配置不会替换最后一份可用模型文件。

## 安全模型

- `read-only`：只允许读取和搜索。
- `workspace-modify`：工作区内写入可直接执行；本机 shell 与越界写入需要批准。
- `full-access`：允许系统级操作，宿主和扩展钩子仍可拒绝单次调用。
- `sandbox`：文件工具限制在项目内；原生后端可用时隔离 shell 与网络，否则禁用 shell。
- API Key 不进入 session、事件帧或配置快照；POSIX 上 `auth.json` 权限为 `0600`。
- MCP 环境变量只向 UI 返回变量名，不返回值。
- Subagent 工具集只能收紧父 Agent 权限，不能提权。

## 开发与验证

```bash
UV_CACHE_DIR=/tmp/foxcode-uv-cache uv run python -m unittest discover -s tests -v
UV_CACHE_DIR=/tmp/foxcode-uv-cache uv run python -m unittest discover -s fox_serve/tests -v

cd desktop
npm run typecheck
npm test
npm run build
```

真实模型端到端验证需要本机已配置模型与密钥：

```bash
uv run python fox_serve/scripts/ndjson_client.py --prompt "只回复：ready" --approve
uv run python fox_serve/scripts/real_e2e_suite.py
```

测试、截图、覆盖率和临时产物统一写入项目 `.foxcode/artifacts/`；不要提交用户凭据、会话
或构建缓存。

## 发布

```bash
cd desktop
npm run build
npm run dist:mac
```

发布前至少完成 Python 测试、前端测试、类型检查、生产构建，以及真实 UI 中的供应商、
凭据、MCP、Subagent、会话和权限 smoke test。详见
[Desktop 发布检查清单](desktop/README.md#发布检查清单)。

## 深入阅读

- [Coding runtime 架构指南](packages/fox_coding_agent/ARCHITECTURE_GUIDE.md)
- [Agent core 架构指南](packages/fox_agent_core/ARCHITECTURE_GUIDE.md)
- [MCP 教程](packages/fox_coding_agent/src/extensions/mcp/MCP_TUTORIAL.md)
- [Subagent 教程](packages/fox_coding_agent/src/extensions/subagent/SUBAGENT_TUTORIAL.md)
- [Memory 教程](packages/fox_coding_agent/src/extensions/memory/MEMORY_TUTORIAL.md)
