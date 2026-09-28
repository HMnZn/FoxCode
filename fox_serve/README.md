# fox_serve

FoxCode 桌面端（`desktop/`，Electron + React）与真实宿主之间的 **Python 连接层**。
它把 `AgentSessionRuntime` 的能力翻译成一套逐行 JSON 的 stdio 协议，供 Electron
主进程当作 sidecar 直接拉起：

```
┌──────────────────────────┐   NDJSON over stdio   ┌─────────────────────────────┐
│ Electron 主进程          │ <-------------------> │ python -m fox_serve         │
│  desktop/electron/*.js   │   请求 / 响应 / 帧    │  AgentSessionRuntime (真宿主)│
└──────────────────────────┘                       └─────────────────────────────┘
                     ↑ IPC (contextBridge)
              React 渲染进程（同一套协议 DTO）
```

**边界**：本目录只**读**`packages/` 下的 Python 包（`from fox_coding_agent.src import
AgentSessionRuntime, SettingsManager`），不改动其中任何文件。协议 DTO 与前端
`desktop/src/types/protocol.ts` 一一对应，前端在 `PROTOCOL_VERSION = 1` 上做校验。

---

## 快速开始

```powershell
# 1) 单独跑一下，看一眼宿主信息（等价于 Electron 里的握手）
uv run python fox_serve/scripts/ndjson_client.py

# 2) 真发一条消息（--approve 会自动批准审批请求）
uv run python fox_serve/scripts/ndjson_client.py --prompt "只回复两个字：你好" --approve

# 3) 让桌面端用真宿主（在 desktop/ 目录下执行）
$repo = "C:\Users\Qin\Desktop\coding_agent\FoxCode"
$env:PYTHONPATH        = $repo                                    # -m fox_serve 需要仓库根
$env:FOXCODE_SERVE_CMD = "$repo\.venv\Scripts\python.exe"
$env:FOXCODE_SERVE_ARGS = "-m fox_serve --quiet --cwd $repo"
npm run dev
```

设置 `FOXCODE_SERVE_CMD` 之后，`window.foxcode.available` 为真，渲染进程走
IPC bridge 连真宿主；不设则回落到进程内的**演示宿主**（`desktop/src/bridge/mock/`）。
屏幕右上角的连接胶囊会显示 `已连接 · fox serve`。

### 命令行参数

| 参数 | 说明 |
| --- | --- |
| `--cwd DIR` | 工作目录：决定会话目录、信任判定、工具相对路径 |
| `--user-dir DIR` | 用户级配置目录（默认 `~/.foxcode`） |
| `--model REF` | 初始模型（`models.json` 的 reference 或 id，如 `deepseek/deepseek-v4-flash`） |
| `--session FILE` | 直接打开某个会话 JSONL |
| `--resume [FILE]` | 继续最近的会话（可跟具体文件） |
| `--new-session` | 强制开新会话（**默认是继续最近会话**，见下文「会话」） |
| `--thinking LEVEL` | `off\|minimal\|low\|medium\|high\|xhigh` |
| `--permission MODE` | `read-only\|workspace-modify\|full-access`（默认沿用配置档位） |
| `--ask-timeout SEC` | 等界面授权的最长秒数，超时按拒绝（默认 600） |
| `--prompt TEXT` / `--compact` / `--command NAME …` | 启动后立刻做一件事 |
| `--list-models` / `--quiet` / `--version` | 列出模型 / 不打日志 / 版本 |

---

## 线协议

一行一个 JSON 对象，**stdout 只放协议**，日志与堆栈一律走 stderr
（Electron 会以 `[fox serve]` 前缀转进主进程日志）。

| 方向 | 形状 | 含义 |
| --- | --- | --- |
| → | `{"id":"c1","method":"prompt","params":{…}}` | 请求 |
| ← | `{"id":"c1","result":{…}}` | 成功响应 |
| ← | `{"id":"c1","error":"…"}` | 失败响应（含 `HostError` 与未捕获异常的说明） |
| ← | `{"frame":{"type":"message_update",…}}` | 事件帧（带 `seq`/`ts`/`v`） |
| ← | `{"event":"transport","status":{"state":"ready"\|"connecting"\|"offline","detail":…}}` | 传输状态 |
| ← | `{"event":"permission","request":{…}}` | 授权请求（需要界面回答） |

请求之间**互不阻塞**：`prompt` 是「入队后立刻返回」，进度全部由帧驱动，所以
`permission.answer` 可以在同一轮里随时插进来（服务端每行一个 task 并发分发）。

### 请求（26 个，与前端 `HostCommand` 一致）

`host.info`、`sessions.list`、`sessions.open{id}`、`sessions.new`、
`sessions.rename{id,title}`、`sessions.fork{fromId?}`、`sessions.delete{id}`、
`session.export{format:'json'|'markdown',path}`、
`prompt{message,options?}`、`steer{message}`、`follow_up{message}`、`abort`、
`compact`、`run_command{name,arguments?}`、`invoke_skill{name,instructions?}`、
`model.select{reference}`、`thinking.set{level}`、`permission.set{mode}`、
`trust.set{trusted}`、`cwd.change{cwd}`、`permission.answer{id,decision,reason?}`、
`extensions.set{id,enabled,scope?}`、`reload`、`files.changes{limit?}`、
`files.diff{path,context?}`、`files.read{path,maxBytes?}`。

`files.*` 供右侧栏的改动清单与预览用（实现见 `fox_serve/workspace_files.py`）。
`files.changes` 把 `git status --porcelain=v1 --untracked-files=all` 与两次
`diff --numstat` 合成 `{cwd, repo, root, branch, files[{path,display,status,additions,
deletions,binary,staged,untracked,oversized}], total, truncated, error}`，未跟踪文件的行数
由宿主自己数（git 的 numstat 不覆盖它们）；`files.diff` 给 `git diff HEAD -U3` 的统一差异，
HEAD 里没有的未跟踪文件合成「整文件新增」；`files.read` 给原文。三个命令都**不抛异常**：
找不到 git、不在仓库里、超时都只填 `error`，界面对应退回「本轮会话触碰的文件」。
路径只允许工作区（及仓库根）之内，越界抛 `HostError`；二进制与超过 2 MiB 的文件不预览。

`files.read` 的返回值带 `kind`（`text` / `binary` / `image`）、`mime`、`data`、`error`：
图片（`.png/.jpg/.jpeg/.gif/.webp/.bmp/.ico/.avif`，见 `IMAGE_MIMES`）直接给 base64
（`data`），前端拼 `data:` URL 渲染；图片超过 `MAX_IMAGE_BYTES = 2 MiB`（base64 还要再涨约
37%）时不内嵌，`data` 为 `None` 且 `error` 写明「图片 X 超过内嵌预览上限」，界面只显示这句
话和文件大小。文本与二进制照旧给 `text`；二进制判定仍是前 8000 字节里出现 `\x00`。
注意 git 走 `asyncio.to_thread(subprocess.run, …)`：sidecar 的 stdin/stdout 是 Node 管道，
Windows proactor 循环下 `create_subprocess_exec` 的子进程会拿不到管道关闭事件而卡到超时。

`sessions.new` 用完 `runtime.new_session()` 后读 `runtime.session_file` 拿路径 ——
`new_session()` 本身**不返回**路径（`packages/fox_coding_agent/src/core/runtime.py:463`），
早先按返回值取路径会得到 `Path(None)` 而抛
`TypeError: argument should be a str or an os.PathLike object where __fspath__ returns a str`。

`sessions.delete{id}` 只删会话目录内的文件：`find` 找不到 → `找不到会话：…`；
解析后不在当前工作区对应的用户级会话目录里 → `PermissionError`；
正在使用的会话（与 `runtime.session_file` 同一文件）→ 拒绝并提示先切换。

`sessions.rename{id,title}` 只重写会话文件第一行的 `_meta._label`（`sessions.py` 的
`set_session_label`：同目录临时文件 + `os.replace`，其余行 `shutil.copyfileobj` 原样抄，
所以消息数与回放完全不受影响）。`title` 为空/缺失就是**清掉标签**，界面回到「首条用户消息」
这个自动标题；标题先折叠所有空白再截到 `MAX_LABEL_LENGTH = 120`（前端输入框同一个值）。
**正在使用的会话必须经由它自己的 storage 改名**：`_cmd_sessions_rename` 先按 `_runtimes`
找 owner，`owner.session.storage.set_label()` 存在就走它，否则才直接改文件 ——
理由是会话对象在内存里握着旧 label，下一次 append 把整个文件重写一遍，磁盘上刚写好的名字
会被它覆盖。错误映射：`find` 找不到 → `找不到会话：…`，目录外的路径 → `PermissionError`
原文，其余 `OSError`/`ValueError`/文件头不是合法 JSON → `重命名会话失败：…`。
返回值是这条会话的最新 `summary`（`live` 标记照旧）。

`sessions.fork{fromId?}` 分叉完成后把新会话命名成「原标题-分支」（`sessions.py` 的
`branch_label`：已带 `-分支` 后缀就往数字上加一，`X-分支` → `X-分支2` → `X-分支3`；空白先
折叠）。截断用 `_fit_branch(root, suffix)` 从 `root` 上截，**保后缀**：直接对结果取
`[:MAX_LABEL_LENGTH]` 会把 `-分支` 裁掉，只剩一个和原会话同名的标题。写入顺序是先
`summary_for(path, live=True)` 取标题、再 `branch_label`、然后 `runtime.session.storage.
set_label()`（分叉出来的会话还没有下一条消息，内存与磁盘不会打架），没有 storage 才回退
`SessionIndex.rename`。

`prompt.options.queueAs` 为 `steer`/`follow_up` 时改走运行中插话（调用
`runtime.agent_session.steer/follow_up`），否则按普通提交。`permission.answer` 的
`decision ∈ {allow-once, allow-session, deny}`。

**插话需要真的有一轮在跑**：`steer`/`follow_up` 在没有运行中一轮时直接失败，报
`当前没有正在运行的一轮，steer 不会被消费；请直接发送这条消息`。原因是
`agent_session.steer()` 只是把消息塞进队列，没有正在跑的一轮就永远没人消费 ——
前端以前会显示「已插话」而正文再也不动（用户侧表现为「插入也不回去」）。现在前端
拿到这条错误就把消息改走普通 `prompt`，不再吞掉它。

### 事件

宿主事件 19 种（`agent_start` … `tool_execution_end`、`compaction_*`、
`context_overflow_retry`、`model_retry`、`error`）、fox_ai 流事件 12 种，全部从
`runtime.subscribe` 直接翻译：

- **命名**：流事件用 snake_case（`content_index`/`delta`/`tool_call`/`reason`），
  消息与用量用 camelCase（`stopReason`/`toolCallId`/`totalTokens`/`cacheRead`）——
  分别对应 `model_dump(mode="json")` 与 `model_dump(mode="json", by_alias=True)`。
- **只转发增量**：`message_update` 只带 `assistant_message_event` 的 delta 和后端计算的 `context_usage`，不重复序列化整条 partial message
  （宿主每个 delta 都深拷贝了整个 partial，原样转发是 O(n²)）。
- **工具结果字符串化**：`tool_execution_end.result` 被压成人类可读文本
  （content 文本 + `[exit N]` + `[输出已截断]`），因为前端工具卡就是这么渲染的。
- `agent_end` 不带 `messages`（前端已从 delta 折叠出时间线，带上只是重复几 MB）。
- **压缩事件带数字**：`compaction_end` 被改写成
  `{type, automatic, preTokens, postTokens, removedCount, retainedCount, summary}` ——
  `preTokens` 取自 `compaction_start` 时的估算，`postTokens` 是压缩后的即时估算
  （`fox_agent_core.src.harness.compaction.estimate_context_tokens`），并且**丢掉**
  `result.retainedTail`（原文尾巴可能几 MB，前端只用计数）。字符串形式的 `result`
  仍会透传（截断到 4000 字符），供 mock 之类的简单宿主使用。
- `host.info.contextTokens`：Coding backend 对当前会话分支的 token 估算，serve 只转发，前端在还没有 usage 时用它
  填充上下文占用。
- `host.info.busy` / `host.info.lastFrameAt`：**这一轮到底还在不在跑**。`busy` 在
  `agent_start` 到 `agent_end`/`error` 之间为 true（`_cmd_prompt` 一接单就先置 true，
  避免和异步到来的 `agent_start` 赛跑），`lastFrameAt` 是最近一次发帧的毫秒时间戳。
  没有这两个字段，前端在一轮静默卡住或结束帧丢失时**只能永远显示「生成中」**：它现在
  每 4 秒对账一次，宿主说空闲就连同提示一起解锁。
- `host.info.model.outputLimit`：**本次请求真正会发出去的 `max_tokens`**，取值顺序与会话
  一致（会话 `stream_options` → 用户 settings → registry 的 `maxTokens`）。deepseek 系
  `compat.thinkingFormat: "deepseek"` 下思考与正文**共享这一个上限**，长思考会把回答挤掉，
  所以界面拿它解释「回答为什么被截断」；`maxTokens` 则是 registry 里模型自己的能力上限，
  两个值一起给，界面才知道该不该建议调大。
- `cwd.change` 先自检再交给 runtime，把最深处的英文异常翻成能照做的中文：目录不存在 →
  `工作区不存在或不是目录：<path>`；`<cwd>/.foxcode` 建不出来 → `工作区不可写：无法创建 …`；
  runtime 自己抛错 → `切换工作区失败：<类型>: <原文>`。（改之前用户只看到
  `PermissionError: [WinError 5] 拒绝访问: '…\.foxcode'`，界面上只能说「工作区无法切换」。）
- `to_jsonable()` 永不抛：pydantic / dataclass / Path / dict / list / 非有限浮点 /
  未知对象都有兜底，`cancel_event`、`http_client` 这类活对象显式剔除。

---

## 权限模型（关键设计）

宿主的判定顺序是**固定**的（`packages/fox_coding_agent/src/core/runtime.py:182-197`）：

```
未信任项目 → 静态 check_tool_permission → 宿主 before_tool_call → 扩展 before_tool
```

后两步**只能收紧、不能放行**。所以如果 sidecar 直接把 `permission_mode` 交给宿主，
`workspace-modify` 档位下界面就永远无法「点一次同意，放过这次越界写入」——
静态检查会先拒绝掉。

因此 fox_serve 的做法是：

1. 构造 runtime 时用 `settings_overrides={"permission_mode": "full-access"}`，
   让静态检查永不先拒（`host.info.runtimePermissionMode` 会如实上报 `full-access`）；
2. **档位由 sidecar 的 `PermissionPolicy` 执行**：`read-only` 档位直接 block 更高权限
   的工具（钩子无法提权，只能如实拒绝），`workspace-modify` 在界面中显示为
   “工作区修改”，工作区内写入与 shell 直接放行，仅对越界文件写入发审批请求，
   `full-access` 档位全放行；
3. 审批把 `before_tool_call` 挂起在一个 future 上，向界面发 `permission` 事件，
   等 `permission.answer`、`abort` 或超时（超时按拒绝）。`allow-session` 记进
   会话级白名单；`read-only` 类工具（Read/Grep/Find/Ls）永远放行。

`host.info.permissionMode` 上报的是**界面档位**，`runtimePermissionMode` 是宿主真实
档位——排查时看后者。界面上的权限菜单走 `permission.set`，只改 sidecar 的档位。

---

## 会话

- **默认继续 cwd 下最近的会话**（`AgentSessionRuntime.latest_session`）。桌面端每次启动
  都会拉起一个新的 sidecar 进程，如果默认新建会话，用户每开一次界面就多一个空会话文件；
  界面上的「新建会话」按钮走 `sessions.new`，所以默认续接是安全的。要强制新会话用
  `--new-session`。
- `sessions.list` 只扫描
  `<user_dir>/sessions/--<normalized-cwd>--/session-*/session.jsonl`，**轻量解析**
  JSONL（不 import 宿主的 `SessionManager`）。空白草稿仅作为当前 live 行由宿主返回，
  磁盘上没有对应文件。
- `sessions.open` 先发 `session_start{…}`，再对历史里每条 `message` 逐个发 `message_end`
  ——磁盘上的消息本来就是 camelCase（`session_manager.py` 用 `by_alias=True` 落盘），
  可以直接转发给前端回放。
- `sessions.list` 的 `createdAt`/`updatedAt` 是**毫秒 epoch 数字**（`sessions._epoch_ms`
  把 ISO 字符串与秒级数字统一成毫秒）：前端 `SessionSummary` 声明的就是 `number`，早先直接
  透传 ISO 字符串会让侧栏排序得到 `NaN`、时间显示退化成日期。
- `sessions.delete` 复用 `SessionIndex.find`，并把解析后的路径限制在
  `SessionIndex.directories()` 内才 `unlink`（防越界删除）。
- `sessions.rename` 与 `sessions.delete` 现在共用同一个私有守卫 `SessionIndex._owned()`
  （`find` + 判据 `resolved.parent.parent == directory`），越界一律 `PermissionError` ——
  改名写文件比删除更危险，边界检查不能只写在删除那条路径上。
- **Windows 上必须先把源文件关掉再 `os.replace`**：替换一个还开着读句柄的文件会得到
  `PermissionError: [WinError 5] 拒绝访问`。`set_session_label` 因此把整个读取过程包进
  `try`，`os.replace` 落在 `with path.open(...)` 之外，异常时先 unlink 临时文件再抛。

---

## 扩展

扩展与主程序隔离：宿主只在启动（或重载）时读 settings.json 的 `extensions` 列表，逐项调用
各自的 `setup(api)`。`setup` 只做注册（工具、命令、服务、上下文变换、钩子），真正的工作
发生在运行时。

- **什么算「启用」**：spec 出现在**生效作用域**的 `extensions` 列表里。项目级
  `<cwd>/.foxcode/settings.json` 一旦出现该键，它会**整体覆盖**用户级
  `<user_dir>/settings.json` 的列表（`SettingsManager` 的合并规则是列表替换）。
- 支持的 spec 形状：`module:<pkg>[.<mod>][:callable]`（缺省 `setup`）、
  `entrypoint:<name>`、以及相对 settings.json 目录解析的**文件路径**。
- **开关**（`extensions.set`）：启用 → 把 spec 插进目标作用域（默认 = 它已在的作用域，
  否则 = 当前生效作用域；项目未受信任则拒绝写项目级）；关闭 → **从所有作用域移除**，
  否则另一个作用域的文件会把它重新打开。插入位置按 spec 字典序落在现有顺序里的稳定槽位，
  所以反复开关不会再漂移（列表顺序就是加载顺序）。
- **热重载**：写完就 `runtime.reload()`（保留会话、模型与历史）。若重载抛错（例如 spec 拼错、
  扩展 import 失败），宿主把 touched 的作用域写回原值、再重载一次，然后报
  `扩展没能加载，已回滚到原来的配置：…`；随后还会校验 `(spec ∈ 生效列表) == enabled`，
  不一致就报 `已写入配置但没有生效`。
- **探测的安全性**：`module:` / `entrypoint:` 用一次性 `ExtensionRunner` 真跑一次
  `setup(api)`（纯注册，不连接 MCP、不写磁盘），拿到工具/命令/服务/变换/钩子清单；
  **文件扩展只做 AST 解析读 docstring，绝不执行**（`probed: false`，
  前端会据此提示「文件扩展不会被宿主预先执行」）。结果按 `(spec, 文件 mtime)` 缓存。
- **可发现但未启用**：`host.info.availableExtensions` 列出还没写进配置的候选 ——
  `packages/fox_coding_agent/src/extensions/*/extension.py`（内置）、
  `~/.foxcode/extensions/*.py`、`<cwd>/.foxcode/extensions/*.py`。
- `host.info.extensions` 的每个条目：`id/spec/name/kind/origin/scope/enabled/shadowed/path/
  description/probed/tools/commands/services/contextTransforms/hooks/error`；
  `shadowed` 是「另一个作用域里也引用了它」的计数。

---

## 模块

| 文件 | 职责 |
| --- | --- |
| `host.py` | `ServeHost`：构造 runtime、订阅事件、实现 22 个命令、挂 `before_tool_call` |
| `extension_catalog.py` | 扩展目录：spec 解析、`setup` 探测、可发现候选、作用域合并与 `extensions.set` 的数据层 |
| `protocol.py` | 事件/DTO 翻译（`event_payload`、`message_payload`、`stream_event_payload`、`to_jsonable`） |
| `approvals.py` | `PermissionPolicy`（档位规则、路径判定、summary/preview）+ `ApprovalBroker`（future ↔ 事件 ↔ 超时） |
| `sessions.py` | 会话目录扫描与 JSONL 轻量解析、改名（`set_session_label`）、分叉命名（`branch_label`） |
| `server.py` | `NdjsonServer`：读一行 / 并发分发 / 单 writer 写一行 / 优雅退出 |
| `cli.py`、`__main__.py` | argparse 入口（`python -m fox_serve`） |
| `tests/` | 142 个 `unittest` 用例（协议翻译、权限策略、服务端并发与错误路径、会话时间戳/删除/改名/分叉命名/`sessions.new` 取路径、图片 base64 与超限、扩展目录与开关/回滚、`test_agent_state.py` 的忙碌标志/心跳/插话拒绝） |
| `scripts/ndjson_client.py` | 协议示例 + 排查工具（也在端到端验证里当驱动用） |

## 测试

venv 里没有 pytest，所以测试用标准库 `unittest`：

```powershell
$env:PYTHONIOENCODING = "utf-8"     # Windows 控制台显示中文
uv run python -m unittest discover -s fox_serve/tests -t .
# Ran 142 tests ... OK
```

（PowerShell 会把 uv 的 stderr 当成错误而给出 exit 1，结论看 `OK` 那一行。）

### 测试的临时目录（别落进仓库）

这台机器上 `tempfile.gettempdir()` 会解析到**工作区根目录**（`$env:TEMP` 看着是
`AppData\Local\Temp`，但 `tempfile` 拿到的是进程 cwd），所以 `tempfile.mkdtemp()` 建的
一次性 git 仓库会直接长在仓库根上——用户真的在仓库根看到过 11 个 `tmpXXXXXXXX`。
现在所有测试都走 `fox_serve/tests/_tmp.py`：

- `temp_dir(prefix)` / `temp_dir_obj(prefix)` 把临时目录固定在 `<repo>/.build-cache/tmp`
  （`.build-cache/` 已在 `.gitignore` 里）；
- `drop(path)` 负责删除：先给每个文件 `chmod(0o700)` 再 `rmtree`
  （Windows 上 `.git/objects` 是只读的，直接 `rmtree` 只会删掉一半）。

写新测试时用这两个 helper，不要直接 `tempfile.mkdtemp()`。

## 已验证的端到端链路

- `host.info` / `sessions.list` 返回真实数据：协议版本、会话文件、模型目录
  （`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro`，上下文 1,000,000）、
  16 个内置命令 + 扩展命令 `/memory`、真实会话列表。
- `--prompt "只回复两个字：你好"` 一轮 12 帧：`agent_start → turn_start → message_start →
  message_end(user) → message_start → text_start → text_delta → text_end →
  message_end(assistant) → turn_end → agent_end`，0 个授权请求，退出码 0。
- 真实 Electron 界面 + 真宿主跑一轮完整对话（`desktop/artifacts/sidecar-live.png`）：
  流式中文正文、2 张 `read` 工具卡、`18.8K tok · $0.0017 cache 11.0K`、
  上下文 `16.9K / 1.00M`、状态栏回到 `空闲`。
- 扩展页 + 真宿主的开关链路（`desktop/artifacts/extensions-real.png`、
  `extensions-toggled.png`）：`host.info` 报出 memory / mcp / subagent 三个已启用扩展
  （含 `setup` 探测出的工具、命令、服务、上下文变换与钩子），界面上关掉 mcp 后
  `.foxcode/settings.json` 真的只剩两条 spec、mcp 落到「可加载」，再打开又写回三条并热重载。

## 已知边界

- 只服务一个界面进程（stdio 单管道），没有鉴权——不要把它挂到网络上。
- `prompt.options.attachments` 暂未实现（当前忽略图片附件）。
- `invoke_prompt`（提示词模板）没有对应命令；模板可以用 `run_command` 之外的方式自行扩展。
- 重新打开一个扩展时它是**按 spec 字典序插入**的，第一次开关之后列表顺序可能和手写时不同
  （之后反复开关不再变化）；列表顺序即加载顺序，钩子的先后因此可能变。
- 单写者假设：宿主的 JSONL 存储没有跨进程锁（`_save` 每次整文件原子重写），
  所以别同时用 CLI 和界面写同一个会话文件。
