# FoxCode Studio（`desktop/`）

Electron 桌面端 UI 系统，界面参照 DeepSeek Harness 桌面端的视觉语言与 `Lexora-master/apps/buddy` 的工作台结构。

**边界：这个目录是纯前端/桌面壳，不修改 `packages/` 下任何 Python 包，也不改动仓库根目录。**宿主能力全部通过一个可替换的桥接接口（`FoxBridge`）访问：真实宿主不存在时自动回退到渲染进程内置演示宿主，因此 UI 可以在没有 Python 后端的机器上完整运行、演示与测试。

---

## 快速开始

要求：Node ≥ 20（开发机为 v24.9.0）、npm。**请用 `npm`，不要用 `pnpm`** —— 某些沙箱环境下 pnpm 的 shim 会以管道 stdio 启动子进程而被拒绝（`spawn EPERM`）。

```powershell
cd desktop
npm install            # 首次会下载 Electron 二进制（约 240 MB）
npm run dev            # Vite(127.0.0.1:5273) + Electron 桌面窗口
```

其他脚本：

| 脚本 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式：Vite dev server + Electron，渲染进程热更新 |
| `npm run dev:no-gpu` | 同上，但给 Electron 追加 `--no-sandbox --disable-gpu --disable-crash-reporter` 与工作区内的 `--user-data-dir`（受限环境/VM 用） |
| `npm run dev:web` | 只在浏览器里跑渲染进程（无桌面壳、无原生对话框） |
| `npm run build` | `tsc` 类型检查 + `vite build` 产物到 `dist/` |
| `npm run dist:mac` | 在 macOS 上构建 `.dmg` 与 `.zip`（输出到 `release/`） |
| `npm start` | 用 `dist/` 启动 Electron（需先 build） |
| `npm run test` | Vitest（jsdom）组件与 reducer 测试 |
| `npm run typecheck` | 只跑 `tsc` |
| `npm run shot` | 无头截图：构建后启动 Electron 抓取真实窗口到 PNG，用于无人值守验证 |
| `npm run icon` | 重新生成应用图标：用 Electron 把 `scripts/fox-icon.html`（狐狸标志的静态孪生）渲染成 512×512 PNG，写到 `build/icon.png` 与 `public/icon.png`，再缩出七档写出 `build/icon.ico` |

> `npm run dev` 把 dev server 显式绑在 IPv4 的 `127.0.0.1:5273`（Vite 默认的 `localhost`
> 可能只监听 `::1`，而 `scripts/dev.mjs` 是轮询 `127.0.0.1` 来判断何时拉起 Electron）。
> 端口可用 `FOXCODE_DEV_PORT=5300 npm run dev` 覆盖；`dev.mjs` 会同时尝试 `127.0.0.1`
> 与 `localhost`，并把实际应答的那个地址交给 Electron。
>
> 启动前 `dev.mjs` 会**先探测端口**：如果已有服务在应答（通常是上一次没退干净的 dev
> server），它会打印占用者的 PID 并直接退出，不会再去启动第二个 Electron —— 两个实例
> 抢同一份 GPU 缓存目录正是 `FATAL: GPU process isn't usable. Goodbye.` 的常见来源。

### 受限环境下的两个已知坑（已处理/需传参）

1. **`ELECTRON_RUN_AS_NODE=1` 陷阱**：某些宿主会把该变量传给子进程，Electron 于是以纯 Node 运行，主进程死在 `ipcMain` 未定义。`scripts/electron-bin.mjs` 因此直接 spawn `node_modules/electron/dist/electron.exe`（绕开 npm shim）并在子进程环境中删除该变量。`scripts/dev.mjs`、`scripts/shot.mjs` 都已使用它。
2. **Chromium 沙箱/GPU 起不来**：在没有交互式桌面、被约束的环境或 GPU 缓存目录被别的实例占用时，Electron 会以 `0x80000003 (STATUS_BREAKPOINT)` 崩溃，或刷一片 `GPU process launch failed: error_code=18` 后 `FATAL: GPU process isn't usable. Goodbye.`。

`npm run dev` 会**自动兜底**：如果 Electron 在 10s 内以已知的启动崩溃码（`0x80000003` / `0xC0000005` / `0xFFFF7003`）退出，它打印一行说明后用软模式参数重启一次，无需手动干预。也可以直接从软模式开始：

```powershell
npm run dev:no-gpu
# 等价于给 Electron 传：
#   --no-sandbox --disable-gpu --disable-crash-reporter --user-data-dir=<repo>\.build-cache\electron-userdata-dev
```

也可以用 `FOXCODE_ELECTRON_FLAGS` 手动追加任意开关。正常桌面环境不需要这些开关（会削弱渲染进程沙箱，仅作最后手段）。

---

## 两种宿主模式

| 模式 | 触发条件 | 行为 |
| --- | --- | --- |
| **演示模式** | 找不到可用 sidecar | `src/bridge/mock/mockHost.ts` 在渲染进程内复现 `AgentSessionRuntime` 的可观测行为：单一前台操作、计划确认卡片、阻塞式审批、并行工具批次交错、压缩、中止、会话切换/分叉。数据是脚本化的（`src/bridge/mock/scenario.ts`）。标题栏与侧栏会显示「演示」标记。 |
| **Sidecar 模式** | 设置 `FOXCODE_SERVE_CMD`，或源码仓库存在 `.venv` | 主进程按需拉起 Python 宿主进程，用 **NDJSON over stdin/stdout** 通信；源码开发会自动发现 Windows 的 `.venv/Scripts/python.exe` 与 macOS/Linux 的 `.venv/bin/python3`。帧、审批请求、传输状态经 IPC 转发给渲染进程。 |

```powershell
# 接 fox_serve（真宿主：AgentSessionRuntime）
$repo = "C:\Users\Qin\Desktop\coding_agent\FoxCode"
$env:PYTHONPATH         = $repo                      # `-m fox_serve` 需要仓库根可导入
$env:FOXCODE_SERVE_CMD  = "$repo\.venv\Scripts\python.exe"
$env:FOXCODE_SERVE_ARGS = "-m fox_serve --quiet --cwd $repo"
npm run dev
```

macOS（源码开发）无需设置上述 PowerShell 环境变量：

```bash
cd desktop
npm install
npm run dev               # 自动使用 ../.venv/bin/python3（存在时）
npm run dist:mac          # 生成 release/*.dmg 与 release/*.zip
```

若 Python 环境不在仓库 `.venv`，可设置 `FOXCODE_SERVE_CMD`；参数含空格时用
`FOXCODE_SERVE_ARGS_JSON='["-m","fox_serve","--quiet","--cwd","/path with spaces"]'`。
macOS 使用原生交通灯、`Cmd` 快捷键、Finder/Terminal 打开动作以及登录式 `zsh` 内嵌终端。

## 计划确认与图片输入

- 自动模式识别到规划请求后只暴露只读工具与 `submit_plan`。计划完成会显示结构化卡片；选择“开始实施”后宿主才切换到执行轮次，选择“暂不实施”则不会产生写操作。选择结果与计划一起写入 Session，恢复会话时可回放。
- 输入框支持文件选择和剪贴板粘贴，每条最多 4 张 PNG/JPEG/WebP/GIF。图片以 `fox_ai.ImageContent` 原生内容块穿过 IPC、Session 和 provider；OpenAI 转为 `image_url` 内容块，Anthropic 转为 base64 image source，不会伪装成 Markdown、路径或文本附件。

Sidecar 协议形状（`electron/sidecar.js`）：

```jsonc
// 下行请求
{"id":"r1","method":"prompt","params":{"message":"…"}}
// 上行响应
{"id":"r1","result":{}}
{"id":"r1","error":"…"}
// 非请求帧：宿主事件 / 传输状态 / 审批请求
{"frame":{"type":"message_update","seq":12,"ts":1730000000000,"v":1,"assistant_message_event":{…}}}
{"event":"transport","status":{"state":"ready","since":1730000000000}}
{"event":"permission","request":{"id":"perm-1","tool_call_id":"call-1",…}}
```

---

## 协议（`src/types/protocol.ts`）

手写镜像 Python 宿主，`PROTOCOL_VERSION = 3`。

- **帧**：`HostFrame = HostEvent & { seq, ts, v }`。`seq` 单调递增，`ts` 由宿主补时间戳（Python 侧事件本身没有时间戳）。
- **宿主事件**：`session_start` / `session_shutdown` / `agent_start` / `agent_end` / `turn_start` / `turn_end` / `message_start` / `message_update` / `message_end` / `tool_execution_start|update|end` / `compaction_start|end|error` / `context_overflow_retry` / `model_retry` / `error`。
- **细粒度流事件**（`message_update.assistant_message_event`，对应 fox_ai 的 12 种事件）：`start`、`text_start|delta|end`、`thinking_start|delta|end`、`toolcall_start|delta|end`、`done`、`error`，一律带 `content_index`。
  - **只转发 `delta`**：宿主每个 delta 都深拷贝整个 partial（O(n²) 字节），前端自行累加。
  - 工具事件按 `tool_call_id` 索引：并行批次（`asyncio.TaskGroup`）的 start/update/end 会**交错**，不能按顺序配对。
- **命令**（`HostCommand`）：`host.info`、`sessions.list|open|new|rename|fork|delete`、`session.export`、`prompt`、`steer`、`follow_up`、`abort`、`compact`、`run_command`、`invoke_skill`、`model.select`、`thinking.set`、`permission.set`、`interaction.set`、`trust.set`、`cwd.change`、`permission.answer`、`extensions.set`、`reload`、`files.list`、`files.changes`、`files.diff`、`files.read`。（`follow_up` 只留在协议里：排队现在完全发生在前端，宿主的 follow-up 队列一次最多只会收到 `drainQueue()` 放出去的那一条。）
  - 运行中不能 `prompt`（宿主抛 `Runtime is already processing`）：忙碌时的发送**只进前端本机队列**（见「排队与插队」），不再直接改走 `steer`。
  - **插队才用 `steer`**：宿主只在**真的有一轮在跑**时才收 `steer`，否则返回 `当前没有正在运行的一轮，steer 不会被消费；请直接发送这条消息`（`session.steer()` 只是入队，没有运行中的一轮就永远没人消费，用户看到的是「插进去也不回来」）。前端收到这条错误就把乐观的气泡撤掉、提示「本轮已经结束，改为直接发送」并改走 `prompt`，消息不会丢。
  - **命令名归一化**：`fox serve` 的 `host.info.commands[].name` 带前导斜杠（`/new`），而界面各处（composer 补全、命令面板、技能页）都是自己补斜杠显示的，所以 `refreshHost()` 收下时就 `replace(/^\//, '')`。不归一化会显示成 `//new`，而且手敲的 `/new` 匹配不上命令表、被当成普通提问发出去（`run_command` 那一侧宿主自己 `lstrip('/')`，所以发不带斜杠的名字是安全的）。
  - 审批：`permission.answer {id, decision: 'allow-once'|'allow-session'|'deny'}` 对应 `before_tool_call(data, cancel)` 这个**可以 await 用户输入**的钩子。
  - `sessions.delete {id}`：宿主只允许删除会话目录内的文件，正在使用的会话会被拒绝。前端不再把按钮灰掉，而是**先 `sessions.new` 切走再删** —— 以前点了没反应（宿主拒绝），用户以为「删了 json 还在」。
  - `sessions.rename {id, title}`：只改会话文件头一行的 `_meta._label`（其余字节原样抄，所以消息数、回放都不受影响；`title` 为空即清掉标签、恢复「首条用户消息」这个自动标题），写入是同目录临时文件 + `os.replace`。**当前会话的改名必须经由它自己的 storage**（`host.py` 的 `_cmd_sessions_rename` 先按 `_runtimes` 找 owner，找不到才直接改文件）：会话对象在内存里握着旧 label，下一次 append 会把整个文件重写一遍，磁盘上刚改好的名字会被它覆盖。上限 `MAX_LABEL_LENGTH = 120`，等同于输入框的 `MAX_TITLE_LENGTH`。
  - `extensions.set {id, enabled, scope?}`：宿主改 settings.json → `runtime.reload()` → 失败回滚（`extensions.set` 已加入 `sidecar.js` 的 `SLOW_METHODS`，超时 300s）。
  - **扩展条目**：`host.info.extensions` 每条含 `id/spec/name/kind/origin/scope/enabled/shadowed/path/description/probed/tools/commands/services/contextTransforms/hooks/error`；`host.info.availableExtensions` 是「宿主发现得到、但还没写进配置」的候选（内置目录、`~/.foxcode/extensions/*.py`、`<项目>/.foxcode/extensions/*.py`）。
  - **上下文占用**：`host.info.contextTokens` 是宿主对当前会话的估算；`compaction_end` 帧带 `preTokens`/`postTokens`/`removedCount`/`retainedCount`/`summary`（不再下发庞大的 `retainedTail`）。二者共同驱动检查器里「已用」的回落，而不是累计 token。**流式期间还会实时累加**：`text_delta`/`thinking_delta` 按字符估算成 `context.live`（`src/lib/tokens.ts` 镜像 `packages/fox_agent_core/src/harness/compaction.py:77-105` 的 `estimate_tokens`：ASCII 每 4 字符 1 token、非 ASCII 每字符 1 token），检查器显示「已用 X · 其中 N 正在流式估算」，拿到权威 usage 后 `live` 归零。只到 `message_end` 才更新数字会让人以为卡死。
  - **一轮到底还在不在跑**：`host.info.busy`（本轮的 `agent_start` 到 `agent_end`/`error` 之间为 true）与 `host.info.lastFrameAt`（宿主最近发帧的时间）。前端每 4 秒 `reconcile()` 一次：界面还在「生成中」而宿主已经 `busy: false`（连续两次确认，避免和 `agent_start` 赛跑）→ 自动解锁并提示「宿主已空闲，但界面还在等这一轮：结束帧可能丢了」；45 秒没有任何新帧 → 输入框上方出现「已 N 秒没有新输出，本轮可能卡住」+「中止本轮」。对账挂在 `App` 上，切到「用量」页也照样有人盯着。另外「发送这一轮」本身失败（桥断了、宿主拒绝）时不会再留下「生成中」：只有**这一轮一帧都没来过**才判定没发出去并复位成空闲（帧来了说明宿主其实收到了，只是回执失败）。
  - **`turn_end` 不是「一轮结束」**：宿主**每个工具批次之间**都会发一次 `turn_end`（`packages/fox_agent_core/src/agent_loop.py` 每个 turn 发一次），只有整轮跑完才发 `agent_end`。前端一度在 `turn_end` 上把状态降级成 `idle`，于是「带工具的一轮」中途会出现毫秒级空闲窗口 —— 排队消息正好在这个窗口被当成新 `prompt` 发出去，宿主回 `RuntimeError: Harness is already processing. Use steer() or follow_up(...)`，而 `prompt` 请求本身是成功的，所以队列里那条已经被摘掉、还画了一个用户气泡：**消息既不执行、又消失了**（用户看到的就是「追加消息有问题」）。现在 `turn_end` 只在有待授权时转 `awaiting-approval`，否则保持 `streaming`，结束一轮只认 `agent_end` / `error` / `session_shutdown`；`drainQueue()` 在发之前还会先问一次 `host.info.busy`，同时把「刚摘掉的那条」记住，若随后真的收到 `already processing` 错误帧就把它放回队首并撤掉气泡（toast「这条消息还在排队」）。
  - **模型**：`host.info.model` 含 `contextWindow` / `maxTokens`（registry 里模型自己的能力上限）/ `outputLimit`（**本次请求真正发出去的 `max_tokens`**，思考与正文共享）。上下文窗口 1M 不等于单次能写 1M：`outputLimit` 才是回答长度的天花板，用量页显示的也是它。

---

## 目录结构

```
desktop/
├─ electron/            # 主进程（CommonJS）
│  ├─ main.js           # 无边框窗口、单实例锁、IPC 白名单、FOXCODE_SHOT 截图钩子
│  ├─ preload.js        # contextBridge 暴露 window.foxcode（无 sidecar 时 available=false）
│  └─ sidecar.js        # Python 宿主客户端（NDJSON over stdio，30s / 慢命令 300s）
├─ scripts/
│  ├─ dev.mjs           # Vite + Electron 编排
│  ├─ shot.mjs          # 无头截图
│  └─ electron-bin.mjs  # 原生 Electron 二进制定位 + 环境清洗
├─ src/
│  ├─ bridge/           # FoxBridge 接口、IPC 实现、MockHost、脚本化演示数据
│  ├─ types/protocol.ts # 协议镜像（手写，单一事实来源）
│  ├─ store/            # zustand：sessionStore（宿主+时间线）、railStore（右侧标签）、filesStore（改动+预览）、terminalStore（shell）、uiStore（视图/主题/栏宽）、timeline 纯 reducer
│  ├─ components/
│  │  ├─ ui/            # 设计系统原语（Button/IconButton/Chip/Menu/Select/Dialog/Tabs/…）
│  │  ├─ content/       # Markdown、代码高亮、Diff、JSON、终端输出
│  │  ├─ chat/          # MessageList、TraceList、ToolCallCard、PermissionPrompt、Composer
│  │  ├─ workspace/     # FilesTab（目录+改动）、FilePreview（差异/原文/渲染）
│  │  └─ layout/        # TitleBar、Sidebar、Splitter（栏宽手柄）、Inspector（右侧工作台）、TerminalPanel（终端标签）、CommandPalette
│  └─ pages/            # ChatPage + Sessions/Skills/Extensions/Usage/Settings
└─ vitest.config.mts    # 渲染进程测试配置（jsdom + @ 别名）
```

## 界面与交互

- **布局**：整窗是 DSH 的 AppFrame 结构 —— 顶部 40px 条（与侧栏同色、整条可拖拽、左端是侧栏开关，右端是连接状态 chip、命令入口、检查器开关、主题开关与自绘窗口控件）+ 左侧栏（会话与导航，可折叠为 56px 图标条）+ 中列（`rounded-tl-[16px]` 的 canvas 面板，内含聊天页/各管理页 + 粘底 composer）+ 右侧工作台（一条标签栏：开始 / 文件 / 每个打开的文件 / 终端）。**没有底部状态栏**（DSH 没有）：运行状态、待授权、中止按钮与「上下文已用 X / 花费」都在 composer 上方的状态条里（`SessionStatusBar`），全量用量在侧栏的「用量」页，版本与宿主标签在侧栏 footer，工作区切换在 composer 的工作区菜单里。
- **栏宽可以拖**：侧栏与右侧工作台之间、中列与右侧工作台之间各有一个 5px 的手柄（`src/components/layout/Splitter.tsx`，`role="separator"`，指针拖动、`←/→` 各 16px、双击复位）。宽度全在 `uiStore`（`foxcode.ui.v5` 持久化）：侧栏默认 320、夹在 `SIDEBAR_MIN_WIDTH = 208` 与 `SIDEBAR_MAX_WIDTH = 460` 之间；右栏 `inspectorWidth` 为 `null` 时**跟着当前标签自动**（文件/终端 520、开始/文件列表 360），拖过之后才固定，下限 `INSPECTOR_MIN_WIDTH = 300`；**中列永远留 `MAIN_MIN_WIDTH = 420`** —— 右栏的上限是 `window.innerWidth − 侧栏 − 420`，窗口变窄时 `clampPaneWidths()` 会重新夹一遍。没有这条约束时把右栏拖宽会把中间正文挤到换行错位（用户看到的「中间的字都漂移了」）。
- **设计语言**：跟随 DSH 桌面端 —— 中性色阶取 DSH 档（暗 canvas `#151517`、layer `#1b1b1c` / `#232324` / `#2c2c2e`，亮 canvas 白 `#ffffff`、sidebar `#f9fafb`）、发丝线 `rgb(255 255 255 / .059|.122|.161)`（亮色 `rgb(0 0 0 / .039|.102|.122)`）、交互底色 `--color-interactive` / `-strong`、圆角档 `4/8/12/16/20` + 28px 面板圆角（弹窗、命令面板、composer 卡）、`.4,0,.2,1` 标准缓动、签名阴影 `surface-pop`（把 0.5px 发丝边写进阴影里）、浮层 `blur(40px) saturate(150%)`、`prefers-reduced-motion` 全局降级、`corner-shape: superellipse(1.5)` squircle（带 `@supports` 回退）；Switch 用 DSH 几何 36×20 / 16px 滑块，Chip 用 DSH Tag 胶囊（11px/17px、999px 圆角、只变调色不变尺寸），Menu 行 34px/13px、标题行 11px、分隔线 0.5px，Tooltip `3px 7px` 圆角 8px（亮色也是深底白字），Dialog 卡 28px 圆角 + `22px 14px 12px 24px` 头部与 16px/24 标题。主按钮与焦点环、链接改用 DSH 的墨色 `brand-primary` 与 business blue `--color-focus`；灵狐橙只留给品牌（标志、`fox-tile`、字标、空态光晕、选中态）。
- **品牌（灵狐）**：`src/components/brand/Fox.tsx` 提供 `FoxMark`（32 格头部几何：双耳 + 腮毛 + 吻部 + 眼高光，`tone="brand|outline"`、`eyes="dot|happy"`、≥22px 才画细节）与 `FoxMascot`（坐姿全身：尾巴 + 奶白尾尖 + 前爪 + 地面阴影）。它出现在侧栏品牌行（`fox-tile` + `FoxCode` + `灵狐`）、折叠栏顶部、以及各页空状态（`EmptyState` 的 `mascot` 槽位，带 `--color-fox-glow` 光晕）；标题栏不再单独放字标（DSH 的品牌在侧栏）。配色 token `--color-fox*` / `--color-accent*` 在 `src/styles/globals.css`；主按钮 `btn-primary` 现在走墨色，品牌底座用 `fox-tile`。
- **中栏两种视角**：聊天页头部有「会话 / 轨迹」分段控件（`uiStore.chatView`，随偏好持久化）。**会话**里每个工具批次都折叠成一行（`2 项工具调用 memory_remember · memory_forget` + `N 失败` / `N 运行中` + `展开`），默认收起、点击展开成完整卡片，所以「模型这一轮到底调了什么」一眼可见、又不会淹掉正文；**轨迹**按时间列出每次工具批次（带触发它的那条用户消息摘要与状态 chip）以及压缩、重试、错误等事件。打开历史会话时，宿主回放 `message_end` 并补上 `tool_execution_start/end`（`fox_serve/host.py` 的 `_replay_current_session`），否则「只有工具、没有正文」的回合在会话视图里会是一片空白。
- **扩展页**：宿主发现到的扩展分成**已启用**（写在生效作用域的 `extensions` 里）与**可加载**（发现得到、还没写进配置）两组，卡片上列出 `setup` 探测出的工具/命令/服务/上下文变换/钩子、来源（内置/用户目录/项目目录）与作用域；右上角标出**生效作用域**（项目级优先）。开关直接发 `extensions.set`：宿主改配置 + 热重载，失败会回滚并在卡片上给出错误；项目未受信任时项目级候选的开关禁用。
- **右侧工作台（`railStore`）**：一条标签栏管住四种标签 —— **开始**（空手时的两张卡片：工作区文件 / 新建终端，以及当前工作区路径）、**文件**（工作区目录浏览 + 改动清单 + 本轮涉及的文件）、**每个打开的文件**（各自带着自己的 `差异/原文/渲染` 视角与滚动位置）、**终端**。打开文件、打开终端都会把面板自动展开；`开始` 永远在、不能关，其余标签都能关（关文件标签顺手丢掉它的预览内容，关终端标签才会结束那个 shell）。标签全部保持挂载、不活跃的用 `hidden` 藏起来：切回来时「文件」标签还停在原来那个目录，终端也不重画回看。面板宽度按当前标签给 —— 文件与终端 520px，开始与文件列表 360px。
- **「文件」标签**：上半是**工作区目录浏览**（`files.list`，点目录下钻、点文件开标签）；中间是**工作区改动清单**（`files.changes`），每行 = 状态字母（A/M/D/R/T/U/?）+ 等宽路径 + `+N −N`（二进制显示「二进制」）；路径把**目录截断、文件名永远完整**，因为窄栏里只有文件名是有效信息。下半是**本轮涉及的文件**（从会话时间线的工具参数汇总），点开默认看原文。点任何一行都不再就地替换，而是在右边新开一个标签。
- **快捷键**：`Ctrl/⌘+K` 命令面板、`Ctrl/⌘+N` 新会话、`Ctrl/⌘+B` 折叠侧栏、`Ctrl/⌘+J` 折叠右侧工作台、`Ctrl/⌘+Alt+P` 打开工作区文件、`Ctrl/⌘+`` 开/收终端标签、`Esc` 关闭面板（无面板时中止当前运行）、`Enter` 发送 / `Shift+Enter` 换行（运行中 `Enter` 为**排队**、`Ctrl/⌘+Enter` 为**插队**）、`/` 在 composer 唤起命令与技能。
- **排队与插队**（`sessionStore.queue` + `src/components/chat/QueuedMessages.tsx`）：运行中按 `Enter` **不打断这一轮**，消息落进输入框上方那条可编辑的小框（「排队 N 条 · 这一轮结束后自动发送」）：点文字就地改（`Enter` 存、`Esc` 撤）、点 `⚡` 立即插队（`steer`，宿主会中断当前请求）、点 `×` 删掉。排队只存在于**本机**（`followUp` 不碰宿主、也不进时间线）：消息一进宿主的 follow-up 队列就改不了，而小框要能改能删。本轮 `agent_end`/`error` 之后 `App` 上的一个 effect 调 `drainQueue()`，**一次只放一条**（多条一起 `prompt` 会被宿主当成同一轮里的同一句话），并且**发之前先确认 `host.info.busy === false`**（工具批次之间的 `turn_end` 不算跑完，见「协议」里那条），发不出去就放回队首等下次。
- **命令目录**（composer 的 `/` 弹层）：只留两条 —— **`/文件`**（打开工作区文件选择器）与 **`/压缩`**（发给宿主的 `compact`）；其余宿主命令（`/new`、`/model`、`/permission`、`/export`、`/thinking`…）界面上都有对应入口（侧栏、命令面板、用量页），列在这里只会把弹层塞满。手敲真名仍然可用（`/new` 照样发 `run_command`，`/压缩` 这类中文名走 `SLASH_ALIASES` 映射回宿主名）。`/文件` 带路径就当场补成 `@路径`，不带路径就开选择器：面板是 `files.list` 的工作区目录（目录优先、显示 `formatBytes`），`↑↓` 选、`Enter` 选中、`Esc` 上一级，底部写「N 项」。列表是 `overflow-y-auto` + `max-h-[min(46vh,320px)]`，`↑↓` 选择时选中行会 `scrollIntoView({block:'nearest'})`，所以走到最后几条也看得见选中谁（以前是 `matches.slice(0, 8)`，第 9 条以后根本进不了 DOM，也没有滚动容器）。
- **审批**：工具调用前若需要授权，卡片内联出现在 composer 上方，提供「拒绝 / 本会话总是允许 / 允许一次」；同一批次的多个请求按 `tool_call_id` 独立跟踪。
- **安全**：渲染进程 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，preload 只暴露白名单通道；外部链接一律交给系统浏览器；构建产物注入严格 CSP。
- **通知**：toast 锚在**右下角**（窗口底部上方），避免盖住标题栏与右侧工作台的标签条。
- **技能页**：按来源分组，组标题讲人话（`user` → 用户级、`project` → 项目级），组内卡片只保留启用状态 chip。
- **对话排版**：Markdown 走 DSH 的字号阶梯 —— 正文 14px/24px（比界面基线的 14px/22px 更松），标题 21/30、19/28、18/26、14/24、13/20（前三级 700，四级 600），表格 13px/22px 且表头 13px 中等字重（不再全大写），`small` 12px/20px；行内代码 0.86em（≈12px），代码块正文 12px/1.6、行号 11px。
- **设置页**：左侧 172px 分节导航（会话 / 模型 / 权限 / 外观 / 演示宿主），带 `IntersectionObserver` 滚动联动与 2.5px 橙色指示条，`min-[880px]` 以下自动收起为单栏。
- **工作区**：没有选中工作区时整个窗口是**工作区选择门**（只有顶条、选择卡与 toast；侧栏/检查器/命令面板都不渲染，快捷键也不响应），选过之后可以随时在 composer 左侧的工作区菜单、命令面板的「工作区」分组或设置页的「最近工作区」里切换。
- **侧栏里的会话**：每行悬停出现 `…` 菜单（`SessionMenu`，会话页复用同一个）—— 置顶（只写 `localStorage` 的 `foxcode.pinned-sessions.v1`，是本机视图偏好，宿主没有「重要」这个概念；置顶只把会话在本工作区内提到最前，行不会脱离所属工作区）、重命名（`sessions.rename`，输入框上限 120 字）、分叉会话（`sessions.fork{fromId}`，目标不是当前会话时先 `sessions.open`；新会话被命名成「原标题-分支」，已带 `-分支` 就往数字上加一，规则与宿主 `branch_label` 一致）、永久删除会话（确认对话框里写明要删的那个 jsonl；当前会话会先 `sessions.new` 再删，只有运行中的会话禁用）。
- **菜单面板走 portal**（`src/components/ui/Menu.tsx`）：面板挂到 `document.body` 并用 `fixed` 坐标 —— 量触发按钮与面板、放不下就翻到另一边、夹在视口内、打开期间跟着滚动/缩放走。原因是侧栏的会话列表与会话页的 `surface-card` 都有 `overflow: hidden` 祖先，面板留在原地会被裁掉（列表最后一行只看得见半个菜单）。**悬停才出现的「…」按钮在菜单打开期间强制可见**（`has-[[aria-expanded=true]]:opacity-100`）：否则指针一离开那一行，面板还开着、却整个变透明。
- **长列表**：历史会话的行带 `virtual-row` 工具类（`content-visibility: auto` + `contain-intrinsic-size: auto 54px`），引擎会跳过屏外行的布局与绘制；`auto` 会记住已测量过的高度，所以滚动条不会跳。这是不引入 JS 虚拟滚动组件的轻量做法——真要做窗口化渲染，热点在这里。

## 工作区

- **首选工作区**：桌面端不假设工作目录。`localStorage` 的 `foxcode.workspace.v1` 里没有 `current` 时，渲染进程只画 `WorkspacePicker`（`src/components/workspace/WorkspacePicker.tsx`）——可以走原生对话框选文件夹，也可以一键用宿主进程当前目录；选过的路径进 `recent`（最多 8 条，LRU 去重）。
- **语义**：一次选择就是对宿主发一次 `cwd.change`（`fox_serve/host.py` 的 `_cmd_cwd_change` → `runtime.change_cwd()` + 会话索引重建 + `_policy.reset_allowlist()`），所以**会话列表、相对路径、读写范围与信任判定**全部以它为准。
- **别名与隐藏名单**（`aliases` / `hidden`，与 `current`/`recent` 写在同一份 `foxcode.workspace.v1` 里）：侧栏工作区行的 `…` 菜单能重命名（`rename()`，只写渲染进程的别名，磁盘上的目录名不动；清空别名即恢复文件夹名）和「从列表移除」（`hide()`，从 `recent` 与工作区树里隐去，**不删磁盘上的任何东西**，重新打开这个文件夹就回到列表；宿主当前所在的目录拒绝移除）。为什么不只 `forget`：侧栏的工作区树由 `recent` + `current` + 每个会话自己的 `cwd` 派生，光从 `recent` 删掉，下一秒会话的 `cwd` 就把它带回来了 —— 所以过滤必须发生在派生树那一步。
- **在工作区上新建对话**：工作区行悬停出现「+」—— 当前工作区直接 `sessions.new`，别的工作区先切过去（`cwd.change` 本身就会在新目录下开一条新会话，不需要再加一条 `sessions.new`）。运行中不会被切断：`open()` 忙时只把请求入列。
- **状态放在哪一侧**：只有渲染进程有状态（`src/store/workspaceStore.ts`），没有主进程 workspace 文件——避免两个真相源；主进程只提供两个原生能力：`dialog:pick-directory`（选择文件夹）与 `shell:show-item`（在文件管理器中打开）。下次启动由 `syncHost()` 把记住的路径幂等地回灌给宿主（`syncedFor` 防重复）。
- **失败不锁门，但也不再假装成功**：`cwd.change` 失败时**仍然记住**这个路径（下次启动再试），同时把失败本身留在状态里：`failedFor` / `failedHostCwd` / `lastError`，聊天页顶部出现「工作区未生效：<原因> · 目标 …，宿主仍停在 …」的警告条 + `重试切换` 按钮，设置页也有一行同样的提示。之前只弹一个 toast 就下沉，界面会一边显示新工作区、一边在旧目录里跑，用户只能说得出「工作区无法切换」。
- **不会变成重试风暴**：`host` 每次刷新都会让 `syncHost()` 重跑，所以失败状态里记下「失败的路径 + 当时的 host.cwd」，两者都没变就直接 return；宿主自己动过（或用户点重试）才再试一次。
- **错误文案要能照做**：宿主侧 `_cmd_cwd_change` 先自检（不存在 → `工作区不存在或不是目录：…`；`<cwd>/.foxcode` 建不出来 → `工作区不可写：无法创建 …`；runtime 抛错 → `切换工作区失败：<类型>: <原文>`），渲染进程再剥掉 Electron 的 `Error invoking remote method 'host:command': ` 外壳（`src/bridge/ipc.ts` 的 `unwrapIpcError`）。**不剥壳的话，宿主写好的中文原因会被挤到横幅可视区之外，用户看到的还是英文的 IPC 实现细节。**

## 右侧栏：标签、改动清单与预览

- **数据来自 git，不来自快照**：`fox_serve/workspace_files.py` 直接问仓库（`status --porcelain=v1 --no-renames --untracked-files=all` + `diff --numstat` + `diff --cached --numstat` + `rev-parse --abbrev-ref HEAD`），所以 shell 里手改的文件也在、宿主重启后清单也还在。代价是没有「这是哪一轮改的」这个语义 —— 那个由前端从会话时间线另行给出（「本轮涉及 N 个文件」段）。
- **未跟踪文件**：git 的 numstat 只覆盖已跟踪文件，所以未跟踪的行数由宿主自己数（>2 MiB 或含 NUL 时给 0 并标 `oversized`）；预览差异时合成一份「整文件新增」的统一差异（`--- /dev/null` + `+++ b/<path>` + `@@ -0,0 +1,N @@`）。
- **忽略规则**：`.build-cache`、`.venv`、`.git`、`node_modules`、`dist`、`build`、`__pycache__`、`.foxcode`、`.pytest_cache` 只要出现在路径的**任意一段**就忽略 —— 未跟踪目录会把整棵子树带出来，`desktop/node_modules/**` 必须挡住。
- **守界**：`_resolve()` 只接受工作区（以及仓库根）之内的路径，`../` 与越界绝对路径被拒绝（`需要一个文件路径` / `路径在工作区之外：…` / `文件不存在：…` / `这是一个目录，不是文件：…`）；二进制文件不预览正文与差异，超过 2 MiB 截断并标「已截断」。
- **git 只是增强**：找不到 git、不在仓库里、命令超时（20s）都只填 `error` 字段，右侧栏退回「本轮涉及的文件」，绝不把异常抛给 UI。
- **不要在 sidecar 里用 `asyncio.create_subprocess_exec` 跑 git**：sidecar 自己的 stdin/stdout 是 Node 侧的管道，Windows 的 proactor 事件循环下子进程拿不到管道关闭事件，`communicate()` 会一直等到超时（实测 `git rev-parse` 卡满 20s，于是 `changes()` 误判「不是 git 仓库」）；改成 `asyncio.to_thread(subprocess.run, …, stdin=DEVNULL)` 后同一个仓库 0.19s。
- **一个文件一个标签**：预览按路径存在 `filesStore.previews` 里（不是一个 `preview` 槽位），所以来回切标签既不重新取内容，也不会丢掉另一侧已经拿到的差异/原文；重复打开同一个文件只是切过去，用户自己选的视角（差异/原文/渲染）不会被重置。关掉标签才丢掉那份内容。
- **渲染页签**：预览有第三种视角（`差异 / 原文 / 渲染`，`src/lib/preview.ts` 决定打开时的默认视角）。图片（`.png/.jpg/.jpeg/.gif/.webp/.bmp/.ico/.avif`）只有「渲染」——base64 由宿主给（`files.read` 的 `data`/`mime`，上限 2 MiB），拼成 `data:` URL；**不用 `file://`**：dev 下 `webSecurity` 会拦、打包后路径也要另算一遍。HTML 走 `<iframe sandbox="">`（样式生效、脚本不执行，也不给它同源权限），并且 `srcDoc` 会先过 `fitHtml()` 注入一段收敛样式（`html,body{max-width:100%;overflow-x:hidden}` + `img,svg,video,canvas{max-width:100%!important;height:auto}` + `pre,table{max-width:100%;overflow-x:auto}`，插在 `</head>` 之前、没有 head 就插在 `<html>` 之后）：渲染的是**别人的** HTML，里面写死 `width:1200px` 的横幅以前会把 iframe 撑出横向滚动条、右边被切掉（演示宿主 `mockHost.ts` 里就专门留了一条 1200×220 的横幅来盯这个）；SVG 用 `data:image/svg+xml;charset=utf-8,` + 百分比编码的 `<img>`（也就不用 `dangerouslySetInnerHTML`）；Markdown 与 JSON 复用会话里已有的 `Markdown`/`JsonViewer`（JSON 解析失败只显示「JSON 解析失败：…」）。其它类型给「这个文件没有可以渲染的样子」，二进制仍然只报事实。
- **图片超限是宿主的错，不是渲染的**：`files.read` 对超过 `MAX_IMAGE_BYTES = 2 MiB` 的图片不给 `data` 而是给 `error`（「图片 X 超过内嵌预览上限」），所以 `filesStore.load()` 非 diff 分支会把 `content.error` 提到 preview 的 `error` 上——否则那句解释会被「有内容」的判断吞掉，用户只看到一张空白预览。
- **图片默认「适应窗口」**（`FilePreview.tsx` 的 `RenderBody`）：`max-h-full max-w-full object-contain` + `m-auto`，所以 5000px 的截图进 520px 的栏也会整张缩进来（不放大、不裁切、不横向滚动）；双击在「适应窗口」与原始大小（`max-w-none`，容器随之滚动）之间切换，`title` 随状态改写。只有演示宿主那张内嵌图是不够看的：`mockHost.ts` 的 `DEMO_PNG_BASE64` 是 1200×800 的示意图（画在 `.build-cache/make-demo-png.mjs` 里，纯 Node 手写 PNG，平面色块 5059 字节；逐像素渐变要 50 KB，不适合内嵌源码）。
- **测试**：`src/lib/diff.test.ts`（统一差异解析、行号推进、整文件替换判定）、`src/lib/preview.test.ts`（后缀认类型、默认视角、data URL 与图片描述）、`src/store/railStore.test.ts`（标签去重、关闭回落到左边那个、`开始` 关不掉、关终端标签会结束 shell）与 `src/components/layout/Inspector.test.tsx`（清单 → 开标签 → 差异/原文/渲染、图片出 `<img>` 且无「差异」页签、双击切原始大小、非图片二进制行只给事实不给预览）。

## 内嵌终端

- **为什么不是 xterm.js + node-pty**：ConPTY 要原生模块按 Electron ABI 重编，工程里没有，也不该为这个功能引入。这里是**主进程管道式 shell**（`electron/terminal.js`，最多 4 个并发会话），行模式：没有光标寻址、没有 resize、没有 SIGINT。`vim`/`top` 这类全屏程序不能用，面板空态里直接写明。
- **提示符是前端画的**：管道里的 cmd/PowerShell 不会回显你敲的命令行（实测 cmd 只打印自己的提示符 `C:\…>`，不回显输入），所以 `terminalStore.submit()` 本地回显 `❯ <命令>`，`clear`/`cls` 也由前端拦截（清本地回看，发给 shell 没有意义）。
- **输入合并**：`src/lib/terminalText.ts` 是纯函数屏幕缓冲（`\r` 覆写、`\b`、`\t` 按列对齐、CSI/OSC 直接丢弃、最多 4000 行滚动），store 里 25ms 合并窗口把 dev server 那种输出风暴折成一次重渲染。
- **编码（Windows）**：cmd 启动时按控制台代码页（中文系统 936）写字节，所以 `resolveShell()` 用 `cmd /Q /D /K "chcp 65001>nul"`，并在环境里设 `PYTHONIOENCODING=utf-8`/`PYTHONUTF8=1`（管道不是控制台，python 会挑 ANSI 代码页写 stdout）；`decode()` 先按 UTF-8 解，出现替换字符就整段改用 GBK 重解（Node 自带 full ICU，本机可用）。**已知边界**：`chcp` 改的是控制台代码页，管道没有控制台，cmd 仍按 ANSI 页读**命令行**——非 ASCII 命令行实测会吃掉引号并卡在 `More?`，所以 win32 上这类行**拒发**并在回看里说明（写进脚本文件或改用 ASCII 参数）。
- **不依赖 sidecar**：终端是主进程自己的事（`src/bridge/terminal.ts` 的 `terminalDriver()` 只看 `window.foxcode.terminal` 有没有，不看 `available`），演示模式下照样是真的 `cmd.exe`；只在纯浏览器/jsdom 里退化成脚本化演示终端（`ls`/`pwd`/`echo`/`help`）。
- **入口**：`Ctrl+``（开着且在眼前就收起来）、命令面板的「打开 / 收起终端」与「新建终端」、以及「开始」标签里的「新建终端」卡片；终端就长在右侧工作台里，和文件、文件列表共用同一块地方。关掉终端标签 = 结束那个 shell；折叠整个面板（`Ctrl+J`）不会——回看和工作目录都还在。退出应用时 `terminals.dispose()` 会结束所有子 shell（`win.on('closed')` 与 `before-quit` 都挂）。
- **测试**：`src/lib/terminalText.test.ts`（CRLF、`\r` 覆写、`\b`、tab 列对齐、CSI/OSC 丢弃、裁剪）、`src/store/terminalStore.test.ts`（启动/复用/重启、本地回显与回车符、`cls` 拦截、输出折叠、忽略别的终端 id、历史、win32 非 ASCII 拒发）、`src/components/layout/TerminalPanel.test.tsx`（头部信息、回车发送、重新启动、shell 退出后不再发送）。

## 品牌与图标（灵狐）

```powershell
npm run icon   # scripts/make-icon.mjs → Electron 渲染 scripts/fox-icon.html → build/icon.png + public/icon.png + build/icon.ico
```

- `scripts/fox-icon.html` 是狐狸标志的**静态孪生**（字面颜色 `#ffab63/#f9762b/#e05a17/#fff2e3/#3c2413`，512×512 透明背景），不依赖 React，便于离线渲染。
- `scripts/make-icon.mjs` 借 `scripts/electron-bin.mjs` 的 `electronBinary/electronEnv/electronFlags` 起一个隐藏窗口，`capturePage()` 后写出 PNG；受限环境下会自动补 `--no-sandbox --disable-gpu --user-data-dir=…` 软模式（显式传 `FOXCODE_ELECTRON_FLAGS` 时以它为准）。`build/icon.png` 给 Electron 主进程当窗口图标，`public/icon.png` 给渲染进程当 favicon（Vite 的 `base: './'` 保证 `file://` 下也能取到）。
- `scripts/icon.mjs` 同时把 512px 图缩成 `16/24/32/48/64/128/256` 七档，手写 ICO 容器（ICONDIR + 每档一条目录项 + 内嵌 PNG，Windows Vista 以后原生支持）写出 `build/icon.ico`，供打包后的快捷方式/安装包使用；Windows 上 `BrowserWindow({ icon })` 也优先用这个多尺寸 `.ico`。
- `index.html`：`<title>FoxCode Studio · 灵狐</title>`、favicon、`theme-color`（暗/亮各一条）以及一段**挂载前**的内联背景色，避免窗口闪白。
- Electron 主进程：`SHELL_BG` 与画布色一致（`#151517`），窗口图标走 `WINDOW_ICON`（Windows 优先 `.ico`，其余平台 `.png`）。

## 测试

```powershell
npm run test
```

- `src/store/timeline.test.ts`：纯 reducer —— 用户消息、流式 delta 折叠、思考与正文分离、**并行工具批次按 id 索引**、用量累计、`turn_end`/`agent_end` 幂等、审批拒绝/允许、错误帧、**工具批次后的文字不并回上一轮**、**带工具的一轮在 `turn_end` 之后仍然是「生成中」（工具还在跑，降到空闲会让排队消息提前发出去）而 `agent_end` 之后才空闲**、**上下文占用取最近一次请求并随压缩回落**、宿主估算只在没有更大 usage 时补齐、**流式文字按字符实时估算进 `context.live` 并在拿到 usage 后归零**、**每帧都盖 `lastFrameAt` 心跳且新帧清掉 `stalled`**、**宿主报告空闲时 `applyHostIdle` 解锁但仍保留已流出的文字**。
- `src/store/sessionStore.test.ts`：把刺探宿主换成 `vi.spyOn(bridge, 'send')` 之后 —— **运行中发送只进本机队列（一个请求都不发、也不进时间线）**、**排队消息可改（空串忽略）可删**、**`drainQueue` 一次只发一条并让会话转入 streaming**、运行中不 `drain`、**排空前先问宿主：`busy: true` 时一个请求都不发、队列原样留着**、**`steerQueued` 把那条从队列里摘掉后带 `interrupt` 发 `steer`**、**宿主命令名的前导斜杠会在 `refreshHost` 那一步剥掉**、**被拒绝的 `steer` 会退化成普通 `prompt`（方法序列 `steer` → `prompt`，消息不丢）**、宿主收下的 `steer` 不再重发、**对账要宿主连续两次说空闲才解锁**（一次不解除）、宿主说忙时绝不动正在跑的一轮、45 秒没有新帧会标成「可能卡住」、**删除当前会话先 `sessions.new` 再 `sessions.delete`**、删除普通会话只有一条命令。
- `src/components/chat/QueuedMessages.test.tsx`：输入框上方的排队小框 —— 空队列不渲染、列出全部并显示「排队 2 条」、点文字改写并 `Enter` 保存、点 `⚡` 让桥收到 `steer` 且队列清空、点 `×` 清空。
- `src/components/chat/Composer.test.tsx`：命令目录 —— **弹层里只有 `/文件` 与 `/压缩`**（`/permission`、`/model`、`/export`、`/thinking` 都不在）、`/压缩` 两次回车发 `run_command{name:'compact'}`、**手敲 `/new` 仍然走 `run_command`（真名不封死）**、点 `/文件` 开工作区选择器并在里面选中一个文件 → 输入框变成 `@路径 `、`/文件 <路径>` 直接补全且不再发 `files.list`。
- `src/store/uiStore.test.ts`：栏宽 —— 侧栏默认 320 且拖过头会夹在 208–460、右栏拖过头是 `窗口 − 侧栏 − 420` 且不小于 300、`setInspectorWidth(null)` 回到「跟着标签自动」、窗口变窄时 `clampPaneWidths()` 会收缩到中列还剩 420、窗口够宽时不动用户的选择。
- `src/components/workspace/FilePreview.test.tsx`：`fitHtml()` 的收敛样式插在 `</head>` 之前（且在 `<title>` 之后）、没有 head 时插在 `<html>` 之后、无 `<html>` 的碎片前置。
- `src/components/layout/Splitter` 的拖动由 `Inspector.test.tsx` 的 `drags the panel width step by step and resets on double click` 盯住（`←` 每步 16px、连按两次都要跟着动、双击回自动宽度 —— 曾经的 bug 是 `storedWidth ?? width - delta` 把增量吞掉，只有第一次手势有效）。
- `src/store/workspaceStore.test.ts`：工作区存储 —— 路径归一化（尾分隔符 / Windows 大小写）、`open` 成功即 `cwd.change` + 记住、宿主失败**仍然**记住且 `applying` 归零、**失败被记成 `failedFor`/`failedHostCwd`/`lastError` 供界面显示与重试**、**`retry()` 成功后清空失败态**、**同一失败在宿主刷新时不会重放 `cwd.change`（宿主自己动过才再试）**、`recent` 8 条 LRU 且大小写不敏感去重、`syncHost` 只在分歧时推一次（幂等）、未选工作区时 no-op、`forget`/`reset`、**别名按归一化键存储（正斜杠/小写/尾分隔符都命中同一条）且清空即删除**、**`hide` 只动名单与 `recent` 并拒绝隐藏当前工作区、重新打开该目录后自动解除隐藏**、**`reset` 保留别名与隐藏名单**。
- `src/store/pinStore.test.ts`：置顶名单 —— 最新置顶排最前并落 `localStorage`、再点一次取消、脏载荷（`['x', 7, null, 'y']`）只读回字符串、非数组回退空、`pinnedFirst` 不改调用方顺序（没有置顶时**返回同一个数组引用**，这是每行的热路径）、已被删会话留下的孤儿 pin 不会凭空造出一行。
- `src/store/railStore.test.ts`：右侧工作台的标签 —— 打开文件即开标签并展开面板、同一个文件不会开两次、重新打开保留用户选的视角、关掉当前标签回落到左边那个并丢掉该文件的预览、`开始` 关不掉、`Ctrl+`` 二次触发会关掉终端标签并结束 shell。
- `src/bridge/ipc.test.ts`：`unwrapIpcError` 剥掉 `Error invoking remote method 'host:command': ` 外壳（含双重 `Error:` 前缀、纯字符串错误、以及无关错误原样返回）。
- `src/pages/ChatPage.test.tsx`：会话视图把一次工具批次压成「1 项工具调用 read」一行且默认不铺开参数，点击展开后参数可见、切到轨迹后同一批工具调用出现。
- `src/components/chat/MessageList.test.tsx`：工具折叠行本身 —— 名字去重计数（`read_file · grep ×2`）、默认不渲染参数、点击展开/收起、`awaiting-approval` 时自动展开并标 `1 运行中`、失败时标 `1 失败`。
- `src/components/content/ContentParts.test.tsx`：思考块默认折叠（流式中也不自动展开），用户点开后保持展开。
- `src/pages/ExtensionsPage.test.tsx`：对着真实 MockHost 走一遍 —— 已启用/可加载两个分组、贡献面（工具/命令/服务/上下文变换/钩子）与生效作用域、文件扩展的「不会预先执行」提示；**打开开关 = 发 `extensions.set` 并让条目真的在两份列表之间搬动**；项目未受信任时项目级候选的开关禁用。
- `src/components/layout/Sidebar.test.tsx`：挂真实侧栏（会话/工作区都换成 spy）—— 展开折叠工作区、仅新建会话按钮开新会话、打开别的工作区的会话会 adopt `cwd`、**工作区内新建对话不发 `cwd.change`**、**跨工作区新建对话就是一次 `cwd.change`**、**别名重命名后行标题变化而 `current`/`recent` 不动、清空别名恢复文件夹名**、**「从列表移除」写隐藏名单且当前工作区那一项 `aria-disabled`**、**置顶把会话提到本组最前**、**会话菜单的重命名/分叉/永久删除各发一次对应命令（附确认对话框）**。
- `src/App.test.tsx`：挂载真实壳层（对着 MockHost）——渲染工作台、命令面板开关、从 composer 发出一条 prompt 并流进时间线、视图切换、**会话/轨迹切换**、**经确认对话框删除会话**、**没有工作区时先显示选择门（快捷键一并失效），选中最近工作区后才进工作台**、**流式中切到「用量」页再切回来，正文继续累积（切页面只是可见性问题，帧不会丢）**。

> 说明：受限的自动化沙箱里 Chromium 自带的沙箱会阻止浏览器进程启动（`electron.exe` 直接以
> `STATUS_BREAKPOINT` 退出），需要 `FOXCODE_ELECTRON_FLAGS="--no-sandbox --disable-gpu --disable-crash-reporter --user-data-dir=<工作区内路径>"`
> 才能拉起真实窗口 —— 加齐这几个 flag 后 `npm run shot` 抓到的就是真实 Electron 渲染的窗口
> （`artifacts/*.png` 都是这么来的）。普通桌面终端里 `npm run dev` 不需要这些 flag。

截图 harness 可以驱动一次真实交互，用来验证渲染而不是只看空状态：

```powershell
# 依次点击「第一个文案/aria-label 命中该子串的按钮」，这里 = 开始卡片 + 发送
npm run shot -- artifacts/run.png --delay=10000 --click="agent_loop.py+发送"
# 顺手抓取一次页面状态用于排查布局（结果打印到终端）
$env:FOXCODE_SHOT_EVAL = "({ cls: document.documentElement.className })"
npm run shot -- artifacts/theme.png --click="切换主题"
```

> `FOXCODE_SHOT_EVAL` 会被塞进**环境变量**传给 Electron，所以它必须是**纯 ASCII**：中文字符串字面量
> 在命令行 → 环境变量的路上会被按本地代码页转码而损坏（现象是 `Script failed to execute, this normally
> means an error was thrown`，甚至整个脚本被注释掉返回 `undefined`）。需要中文就写成 `\uXXXX` 转义，
> 或者在源码里保持纯 ASCII；脚本本身可以是多行，用 `Get-Content -Raw` 塞进变量即可。

> 若 `npm run shot` 不传参数，只会抓取初始空状态。主题与会话偏好存在 Electron 的
> `--user-data-dir` 里，因此多次抓图之间会保留（需要干净状态就换一个 user-data-dir）。

`FOXCODE_SHOT_EVAL` 里可以写 async 断言：Electron 会 await 这个 Promise，于是能在真实窗口里
先等某个交互出现、再断言它的后果（下面这条就是在验证「批准后授权 toast 必须消失」）：

```powershell
$env:FOXCODE_SHOT_EVAL = '(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const findApprove = () => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("允许一次")); let waited = 0; while (!findApprove() && waited < 120000) { await sleep(250); waited += 250; } const before = [...document.querySelectorAll("[role=status]")].length; findApprove()?.click(); await sleep(2500); return { waited, before, after: [...document.querySelectorAll("[role=status]")].length }; })()'
npm run shot -- artifacts/approval.png --delay=3000 --click="agent_loop.py+发送"
# shot eval: {"waited":12000,"before":1,"after":0}
```

> 每个 `--click` 步骤默认最多等 20s（`FOXCODE_SHOT_CLICK_ATTEMPTS` 可调，单位 250ms）；
> `--delay` 是**最后一个交互结束之后**的稳定时间，而不是从启动算起的总时长。
