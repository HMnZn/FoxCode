# FoxCode Desktop

FoxCode 的 Electron + React 工作台。渲染进程只依赖 `FoxBridge`，真实环境通过 Electron
主进程连接 `fox_serve`；浏览器、测试或 sidecar 不可用时使用内置 Mock host。

## 启动

```bash
npm install
npm run dev       # Vite + Electron + 自动发现 Python sidecar
npm run dev:web   # 只启动浏览器版，使用 Mock host
```

源码仓库存在 `../.venv/bin/python3`（Windows 为 `../.venv/Scripts/python.exe`）时，开发脚本
会自动执行 `python -m fox_serve`。也可显式配置：

```bash
export FOXCODE_SERVE_CMD=/path/to/python
export FOXCODE_SERVE_ARGS_JSON='["-m","fox_serve","--quiet","--cwd","/path/to/repo"]'
npm run dev
```

## 页面与能力

- Chat：流式消息、思考、工具卡、计划确认、审批、插话和排队
- Sessions：会话列表、恢复、分支、重命名和删除
- Skills / Extensions：发现、启用与贡献面审计
- Usage：上下文、tokens、费用和回合统计
- Settings：当前会话设置、持久化默认值、模型供应商、API Key、MCP、Subagents 和诊断
- Inspector：工作区改动、Diff、文本/Markdown/HTML/SVG/图片预览
- Terminal：Electron 主进程持有的 PTY 终端

## 设置中心的数据边界

设置页不直接访问文件系统，所有读写都通过 `config.*` host commands。`config.get` 只返回
凭据是否存在、MCP 环境变量名等脱敏元数据。API Key 输入使用 password 控件，保存后不会
再次回显。真实宿主负责校验、原子写入和热重载。

## 目录

```text
desktop/
├─ electron/           Electron 主进程、preload、sidecar、terminal
├─ scripts/            dev、截图、图标与原生依赖准备
├─ src/
│  ├─ bridge/          IPC bridge 与 Mock host
│  ├─ components/      UI、聊天、设置、工作区和布局组件
│  ├─ pages/           顶层页面
│  ├─ store/           Zustand stores
│  ├─ styles/          主题与 design tokens
│  └─ types/protocol.ts
└─ build/              打包资源
```

协议类型以 `src/types/protocol.ts` 为前端事实来源，并与 `fox_serve/protocol.py` 保持版本一致。

## 常用脚本

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 开发模式，自动沿用成功的 GPU/沙箱兼容模式 |
| `npm run dev:no-gpu` | 受限环境下关闭 GPU/sandbox 的开发模式 |
| `npm run dev -- --reset-gpu` | 清除兼容模式记录，重新检测 GPU/沙箱 |
| `npm run dev:web` | 浏览器 + Mock host |
| `npm run typecheck` | TypeScript 检查 |
| `npm test` | Vitest 全量测试 |
| `npm run build` | 类型检查 + Vite 生产构建 |
| `npm run shot` | 构建后抓取真实 Electron 窗口截图 |
| `npm run dist:mac` | 构建 macOS DMG/ZIP |

## 测试策略

- 纯函数：diff、preview、tokens、terminal text
- Store：session、workspace、files、terminal、rail
- 组件：composer、timeline、inspector、settings、extensions
- Mock host：协议行为和无需 Python 的产品演示
- 真实 UI：启动 Web 或 Electron，逐项操作设置、会话和工作区

```bash
npm run typecheck
npm test
npm run build
```

## 发布检查清单

1. Python sidecar 与前端 `PROTOCOL_VERSION` 一致。
2. `npm run typecheck && npm test && npm run build` 全部通过。
3. 真实 sidecar 下验证 provider/API Key、MCP、Subagent 的新增、编辑、删除和重载。
4. 验证 API Key、MCP env 值没有出现在页面、日志和 session 中。
5. 验证未信任项目不能写项目级配置。
6. 验证权限审批、Plan 确认、取消、掉线与重连。
7. 在目标 macOS 版本测试 DMG 安装、首次启动、终端和 sidecar 拉起。
8. 检查 `release/` 的架构、版本号、图标和签名/公证状态。

## 故障排查

- 显示“演示”：确认仓库 `.venv` 存在，或设置 `FOXCODE_SERVE_CMD`。
- 端口占用：设置 `FOXCODE_DEV_PORT=5300`。
- Chromium/GPU 启动失败：启动器会自动用软模式重试一次，并在窗口成功显示后保存记录，
  后续 `npm run dev` 直接沿用；也可使用 `npm run dev:no-gpu`。软模式关闭硬件加速与
  Chromium 沙箱，仅用于开发/受限环境。更新显卡驱动后可运行 `npm run dev -- --reset-gpu`
  重新检测；升级 Electron 后也会自动重新检测。
- 开发模式的浏览器存储和 GPU 缓存统一位于 `../.build-cache/electron-userdata-dev`，
  正常启动和兼容模式重试使用同一目录。关闭窗口或按 Ctrl+C 时启动器会清理子进程。
- 配置保存失败：设置页会显示宿主校验错误；先修复对应 JSON 诊断再重试。
- 原生终端依赖异常：重新执行 `npm install`，`postinstall` 会准备 `node-pty`。
