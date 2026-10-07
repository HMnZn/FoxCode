# FoxCode Desktop

Electron + React 工作台，通过 `FoxBridge` 连接 Python sidecar。界面、终端与工作区操作在一个窗口中完成。

![FoxCode 工作台](../docs/images/workbench.png)

## 启动

先在仓库根目录执行 `uv sync`，再启动桌面端：

```bash
cd desktop
npm ci
npm run dev
```

启动器自动发现仓库 `.venv`，启动 Vite、Electron 和 `python -m fox_serve`。
自定义 sidecar：

```bash
export FOXCODE_SERVE_CMD=/path/to/python
export FOXCODE_SERVE_ARGS_JSON='["-m","fox_serve","--quiet","--cwd","/path/to/workspace"]'
npm run dev
```

该环境需能导入 `fox_serve` 与 Python runtime。`npm run dev:web` 仅启动浏览器与 Mock host。
演示模式的数据保存在当前窗口；真实记忆与文件操作使用 Electron sidecar。

## 页面

| 入口 | 内容 |
| --- | --- |
| 会话 | 流式正文与思考、工具、图片、计划确认、权限审批、插话与排队 |
| 全部会话 | 恢复、分支、重命名与删除 |
| 插件 | 扩展启停、项目记忆、MCP 服务器、Subagent 角色 |
| 技能 | 静态 Skills 的发现与调用 |
| 用量 | 上下文、tokens、费用估算与回合统计 |
| 设置 | 供应商、API Key、会话设置、运行默认值与诊断 |
| 右侧面板 | 工作区文件、Diff、预览与 PTY 终端 |

### 记忆管理

在「插件」启用 `memory` 并信任项目后，「扩展管理」中的记忆区自动读取后端记忆。
支持全文查看、文本搜索、类型筛选、新增、编辑、置顶、删除和手动刷新。
删除前需要确认；保存错误保留编辑内容。切换工作区会重新加载对应存储。
Agent 执行期间，后端拒绝记忆写入与删除。

![记忆管理](../docs/images/memory.png)

## 代码结构

```text
desktop/
├── electron/       主进程、preload、sidecar 与 terminal
├── scripts/        开发启动器、截图、图标与原生依赖准备
└── src/
    ├── bridge/     IPC bridge、Mock host 与终端协议
    ├── components/ 聊天、记忆、设置、工作区和通用组件
    ├── pages/      顶层页面
    ├── store/      Zustand 状态管理
    ├── styles/     主题与设计变量
    └── types/      与 Python 对齐的协议类型
```

`src/types/protocol.ts` 与 `fox_serve/protocol.py` 保持版本一致。
配置和记忆均通过 host commands 读写，组件不直接访问文件系统。
API Key 输入使用 password 控件，保存后不回显；MCP 环境变量只展示变量名。

## 脚本

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | Vite + Electron + sidecar |
| `npm run dev:web` | 浏览器演示 |
| `npm run dev:no-gpu` | 兼容模式启动 |
| `npm run dev -- --reset-gpu` | 重置兼容模式记录 |
| `npm run typecheck` | TypeScript 检查 |
| `npm test` | 前端回归测试 |
| `npm run build` | 类型检查与生产构建 |
| `npm run shot -- ../.foxcode/artifacts/studio.png` | 真实窗口截图 |
| `npm run icon` | 生成打包图标 |
| `npm run dist:mac` | 生成 macOS DMG/ZIP |

截图工具支持 `--click`、`--workspace` 和 `--eval-file`，用于验证真实 UI。
临时脚本与输出放到 `.foxcode/artifacts/`；公开截图提交到 `docs/images/`。

## 发布验证

1. 运行 Python 回归、`npm test` 和 `npm run build`。
2. 在真实 sidecar 下验证会话、模型配置、凭据、记忆 CRUD、MCP 和 Subagent。
3. 检查审批、Plan 确认、取消、断线与恢复。
4. 确认未信任项目不会加载项目资源，界面和日志没有凭据值。
5. 在目标 macOS 版本验证安装、首次启动、终端和 sidecar。

产物位于 `release/`。当前安装包不包含 Python sidecar，需另行配置运行环境。
发布时还需按分发渠道处理签名与公证。

## 常见问题

- **显示演示模式**：检查仓库 `.venv` 或 `FOXCODE_SERVE_CMD`，确认 Python 可以导入 `fox_serve`。
- **端口占用**：使用 `FOXCODE_DEV_PORT=5300 npm run dev`。
- **GPU 启动失败**：启动器自动重试兼容模式；也可执行 `npm run dev:no-gpu`。
- **记忆为空**：确认当前工作区、`memory` 扩展与项目信任状态；新工作区有独立存储。
- **配置保存失败**：根据设置页诊断修正配置后重试。
- **终端依赖异常**：重新执行 `npm ci`，安装脚本会准备 `node-pty`。

开发缓存位于仓库 `.build-cache/`；关闭窗口或按 Ctrl+C 会停止开发子进程。
