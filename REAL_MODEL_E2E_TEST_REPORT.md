# FoxCode Coding Agent 真实模型端到端测试报告

## 2026-09-29 用户反馈后的补充修复

用户实际会话暴露出上一轮覆盖不足：工具之后的纯思考阶段中止、以及打开历史会话后时间变成“刚刚”。本次已从用户截图对应的本地会话审计记录确认错误，并补充修复与真实测试。

### 插队问题的准确原因与修复

实际记录依次为 `ls/read/bash` 工具调用、只有 `thinking` 内容的 aborted assistant、插入的用户消息、DeepSeek 400：`Invalid assistant message: content or tool_calls must be set`。

上一轮只过滤了 `content=[]`。纯思考消息的内部 content 非空，但转换为模型请求时没有正文和工具调用，因此仍然无效。本次在 `SessionManager.build_context()` 中也过滤没有正文/工具调用的失败或中止回复，保留审计原文和完整工具配对；压缩 retained tail 同样处理。已经保存的这类历史会话重新加载时也适用。

前端 `message_end` 不再把 `stopReason=aborted` 的 `Operation aborted` 当作模型错误渲染；真正的模型错误仍显示，并补上历史回放时的错误信息。

### 历史会话时间的语义

`updatedAt` 改为消息、工具结果、压缩等持久化对话活动的最后时间，忽略加载过程中的工具/配置条目和文件 mtime。只打开、预览或改名不会让会话变成“刚刚”；实际发送消息、收到回复后才推进活动时间。缺少条目时间的旧格式才回退到文件时间。

### 补充验证结果

| 验证 | 结果 |
| --- | --- |
| Python：核心、会话索引、宿主插队相关回归 | 73/73 通过 |
| 前端：时间线、消息显示、会话 store、侧栏相关回归 | 51/51 通过 |
| TypeScript + Vite 生产构建 | 通过 |
| 真实 DeepSeek 专项测试 | 4/4 通过 |
| 真实 Electron 完整操作测试 | 9/9 通过 |

真实专项测试明确等到 `tool_execution_start` 且工具未结束时插队；另一个场景等到工具结束后出现 `thinking_delta`，并断言持久化的中止回复只有思考内容。两者都收到插队后的新 assistant 回复，后续继续聊天也正常。

Electron 驱动现在通过真实模型 `message_end` 判断成功，不能仅凭用户气泡里的同名标记通过；同时测试队列按钮插队、Ctrl+Enter 插队、历史会话侧栏点击。最后一次历史预览前后 `updatedAt` 均为 `1790671391919`，协议测试也确认连续两次打开不变、真正续聊后增加。

上一轮 Electron 脚本在工具实际开始前就允许插队，并可能把用户输入的标记当作回答，这属于测试缺口；已修正，不能用上一轮 7/7 证明工具期插队已全面正常。

补充证据：

- [真实模型专项结果](desktop/artifacts/interrupt-regressions.json)
- [真实 Electron 9 项结果](desktop/artifacts/real-electron-interrupt-regressions.json)
- [真实 Electron 截图](desktop/artifacts/real-electron-interrupt-regressions.png)

协议复现：在本文原 E2E 命令中增加 `--interrupt-regressions`，并将 `--output` 指向独立结果文件。

## 首轮测试记录

- 测试日期：2026-09-29（Asia/Shanghai）
- 平台：Windows + WSL，Electron 桌面端
- 真实模型：`deepseek/deepseek-v4-flash`
- 结论：修复发现的问题后，测试范围内全部通过

## 结果总览

| 层级 | 结果 | 说明 |
| --- | ---: | --- |
| 核心 Python 回归 | 127 项中 124 通过、3 跳过 | 跳过项均为当前平台不具备的 POSIX/ripgrep 条件 |
| `fox_serve` 回归 | 146 通过 | sidecar、协议、会话、文件、权限、扩展等 |
| 桌面端 Vitest | 169 通过 | 22 个测试文件 |
| TypeScript 类型检查 | 通过 | `tsc -p tsconfig.json` |
| Electron 生产构建 | 通过 | Vite production build |
| 真实模型协议 E2E | 12/12 通过 | 独立 sidecar、真实 API、真实文件与 Git 工作区 |
| 真实 Electron E2E | 7/7 通过 | 实际桌面窗口、preload/IPC/sidecar/模型完整链路 |

首轮自动化单元/集成回归共 442 项，其中 439 通过、3 跳过；另外执行了 19 个真实模型端到端场景。首轮插队覆盖的局限与补充测试见本文开头。

## 真实模型协议测试

1. 真实宿主与模型握手、流式帧、上下文用量。
2. `/文件` 对应的目录浏览；模型实际调用 `read` 并读回唯一标记。
3. 运行中 follow-up 排队；首轮结束后自动继续下一轮。
4. steer 立即插队；中止当前生成并继续插入的消息。
5. `workspace-modify` 下真实写文件。
6. `read-only` 阻止写入；工作区外写入触发授权，拒绝后无副作用。
7. 文件原文、改动列表和 Git diff；覆盖刚 `git init`、尚无首个提交的仓库。
8. `/压缩` 使用真实模型生成摘要；上下文从 12,549 tokens 降至 2,662 tokens，并在压缩后正确回忆 `COMPACTION_FACT_7391`。
9. 会话新建、改名、分支、打开、回放和删除。
10. `/new` 与 Markdown 会话导出。
11. 新项目/工作区切换，随后继续真实模型对话。
12. 模型选择、思考等级、真实推理，以及无效命令/目录失败后的恢复能力。

机器可读结果见 [real-e2e-results.json](desktop/artifacts/real-e2e-results.json)。

## 真实 Electron 测试

测试直接启动 production renderer 和 Electron 主进程，由真实 preload/IPC 启动 `python -m fox_serve`，没有使用 mock host。

1. Electron、sidecar 和 DeepSeek 模型连接成功。
2. 输入 `/` 时菜单只显示 `/文件` 与 `/压缩`。
3. `/文件` 打开真实工作区文件列表，选择 `fixture.txt` 后插入 `@fixture.txt`；模型调用 `read` 并显示文件内容。
4. 运行中发送第二条消息进入本地队列；可修改；点击“立即插队”后中止当前轮并得到插队回复。
5. 排队/插队完成后 `/压缩` 仍可补全并调用真实宿主压缩，不会被当作普通提示词。
6. “新建会话”清空旧时间线并创建新会话。
7. 从侧栏在第二项目中新建对话，宿主 cwd 实际改变；模型读取第二项目文件成功。

结果见 [real-electron-e2e-results.json](desktop/artifacts/real-electron-e2e-results.json)，最终界面截图见 [real-electron-e2e.png](desktop/artifacts/real-electron-e2e.png)。

## 发现并修复的问题

### 1. 排队后 `/压缩` 失效

根因：首次读取宿主信息时会把 `/compact` 规范化为 `compact`，但排队出队和运行状态对账会再次写入未经规范化的 `HostInfo`。排队一次后，命令匹配因此失败，`/压缩` 会消失或被当成普通模型消息。

修复：所有 `BRIDGE.info()` 写入统一经过 `normalizeHost()`；新增“排队刷新后命令名仍为 `compact`”回归测试。

### 2. 很早发生的插队会污染后续上下文

根因：在模型第一个流式分片前中止，会持久化一个空的 assistant 审计条目。恢复会话时把它原样发给 OpenAI 兼容接口，接口拒绝没有 `content` 和 `tool_calls` 的 assistant 消息。

修复：空的中止 assistant 仍保留在会话审计树中，但构建模型上下文时跳过；普通历史和压缩后的 retained tail 都应用该规则。

### 3. steer 存在重复续跑竞态

根因：旧循环有时已经消费插队消息并给出回复，宿主随后又无条件调用一次 `continue_()`，产生 `Cannot continue from message role: assistant`。

修复：等待旧任务结束后检查是否仍有排队消息；队列已经被消费时不重复续跑。

### 4. 新 Git 仓库无法预览未跟踪文件 diff

根因：Windows Git 对无 `HEAD` 仓库返回 `bad revision 'HEAD'`，原逻辑只识别另外两种错误文案。

修复：兼容常见的四类 unborn-HEAD 文案，并继续生成未跟踪文件的合成 diff。

### 5. 独立 NDJSON 客户端在任意 cwd 下无法可靠启动

根因：子进程切换到测试工作区后找不到仓库内 `fox_serve`；相对 cwd 还会被应用两次；启动失败时请求会等满超时。

修复：对子进程注入仓库根目录 `PYTHONPATH`，启动前把 cwd 解析为绝对路径，并在 stdout EOF 时立即结束所有待处理请求。

## 新增的可重复测试设施

- `fox_serve/scripts/real_e2e_suite.py`：12 项真实模型协议套件，失败时非零退出并写 JSON。
- `desktop/scripts/real-e2e-driver.js`：在真实 Electron renderer 内执行 7 项用户操作。
- `desktop/scripts/shot.mjs` / `desktop/electron/main.js`：支持隔离工作区、严格断言、截图和 JSON 结果输出。
- 三个针对本次实际缺陷的 Python 回归测试，以及一个前端命令规范化回归断言。

## 2026-09-29 子 agent、PowerShell 与临时目录复测

复盘真实会话 `C:\Users\Qin\Desktop\coding_agent\test_project` 后确认：测试子 agent
累计消耗了 1,618,882 tokens，但这属于多轮请求的累计计费量，并不是单次上下文占用；
原协议只在子 agent 完成后返回该累计量，运行过程中没有向桌面端转发子上下文快照。
该子 agent 最后一轮还停在工具调用，没有最终正文，旧实现却显示为成功的
`(Sub-agent produced no text output)`。此外，它按提示把验证脚本和截图写到了
`C:\Users\Qin\AppData\Local\Temp\pelican_verify`，中途失败后没有完整清理。

本轮已修复：

1. 子 agent 每次模型流更新都会转发后端 `context_usage`；桌面底栏分别显示主上下文和
   正在运行的子 Agent 上下文，工具卡显示实时 token，结束后保留最后快照但不再计入活动占用。
2. 新增内置 `test` 子 agent。它允许读取和执行验证命令，但提示词明确禁止修改交付物，
   临时文件只能放在工作区 `.foxcode/tmp`。
3. `bash`/`powershell` 子进程的 `TMPDIR`、`TEMP`、`TMP` 固定到当前工作区
   `.foxcode/tmp`；子 agent 的 `write/edit` 即使父会话为 full-access，也不能越出工作区。
4. Windows PowerShell 启动时强制输入、输出和管道使用 UTF-8；Windows 下写入 `.ps1`
   自动使用 UTF-8 BOM，解决 PowerShell 5.1 把脚本内中文当成本地代码页读取的问题。
5. 子 agent 没有最终文本时改为明确失败，不再伪装成成功。
6. Windows 上检测到系统 `bash.exe`（WSL）时，工具说明明确要求使用相对路径或
   `/mnt/c/...`，并把工作区临时目录转换为 WSL 路径；不再误导模型使用 Git Bash 的 `/c/...`。

真实模型隔离复测使用 `deepseek/deepseek-v4-flash`，会话保存在仓库
`.build-cache/real-subagent-workspace/.foxcode/live-session/session.jsonl`。模型实际调用
`type=test` 并读取工作区标记；协议收到 40 个带结构化进度的更新，子上下文由 0 实时增长至
1,942 tokens，最终正确返回 `FOXCODE_SUBAGENT_LIVE_CONTEXT_OK`。本轮没有向用户全局
`~/.foxcode/sessions` 写入测试会话。

自动回归结果：核心/编码 agent 共 131 项（128 通过、3 项按环境跳过），sidecar 148 项通过，
桌面端 171 项通过；TypeScript 类型检查和 production build 均通过。

仍需后续增强的边界：子 agent 的完整内部 transcript 和每个子工具的参数/结果目前不持久化，
只能看到阶段、实时上下文和最终报告；现有上限主要是 30 回合，缺少按子任务配置的总 token、
工具调用次数和总墙钟时间预算；`workspace_shell` 也缺少操作系统级沙箱，显式写死的绝对路径无法
仅靠环境变量完全拦截。后续应增加可折叠的子任务审计树和资源预算，并为 shell 引入真正的工作区
文件系统隔离，而不是尝试解析命令字符串。

## 边界与说明

- 当前产品的“文件选择”语义是从工作区选择文件并插入 `@路径`，再由模型工具读取；该链路已完整验证。协议目前没有实现任意二进制/图片附件上传，因此没有把它误报为已测试功能。
- Windows 原生“选择文件夹”对话框本身没有做像素级自动点击；测试预置了两个最近工作区，并通过真实侧栏操作、`cwd.change`、新会话和第二项目文件读取验证了对话框之后的完整项目切换链路。
- 模型是否输出可见的 reasoning delta 取决于供应商；模型切换和思考等级请求已验证，不能把“必须出现可见思考文本”作为跨供应商通过条件。

## 复现命令

```bash
uv.exe run python -m unittest discover -s tests -v
uv.exe run python -m unittest discover -s fox_serve/tests -v
uv.exe run python fox_serve/scripts/real_e2e_suite.py \
  --workspace .build-cache/e2e-live-workspace \
  --second-workspace .build-cache/e2e-live-project-two \
  --output desktop/artifacts/real-e2e-results.json
```

```powershell
cd desktop
npm test
npm run typecheck
npm run build
```

Electron E2E 还需要设置 `FOXCODE_SERVE_CMD`、`FOXCODE_SERVE_ARGS` 和独立的 `--user-data-dir`；本次使用的完整驱动保存在 `desktop/scripts/real-e2e-driver.js`。
