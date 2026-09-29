# 从零理解 FoxCode Sub-agent 扩展

这是一份面向学习者的子 Agent 教程。读完后，你应该能够回答五个问题：

1. 为什么不把探索工作直接交给主 Agent，而要额外引入「子 Agent」？
2. 一次委派为什么既可能**污染上下文**，又可能**扩散能力**？这两件事怎么分别解决？
3. 子会话继承父会话的什么、不继承什么？`session_id` 为什么必须丢掉？
4. 子 Agent 的每一次工具调用要穿过哪三道闸门？为什么第②道要「不因委派而放宽」？
5. 什么情况下子 Agent 会被判定为**失败**，即使它「看起来干完了活」？

建议先跑一次，再按章节读代码。

```powershell
uv sync
uv run fox --trust-project --interactive
# 在会话里：
#   /agents                    查看当前可用的委派 profile
#   让模型调用 agent 工具
uv run python -m unittest discover -s tests -p "test_subagent_mcp_extensions.py" -v
```

> 这份教程解释「为什么这样设计」。字段级、消息级的完整契约在 [SUBAGENT_DESIGN.md](SUBAGENT_DESIGN.md)。

---

## 第一章：为什么需要子 Agent

### 1.1 一个具体的上下文污染场景

假设用户说：

> 「这个仓库的缓存层是怎么实现的？顺便看看有没有并发安全问题。」

诚实的做法要读十几个文件：`cache/*.py`、调用方、测试、配置。每一份文件内容都会变成一条工具结果消息进入对话历史。

问题不在于「读得太多」，而在于**读进来的东西再也出不去**：

- 主 Agent 为了回答一个问题，永久背上了十几份文件的正文；
- 这些正文里可能只有三行是有用的结论；
- 而上下文窗口是**整个任务共享**的，后面真正要改代码时，预算已经被探索消耗掉了；
- 如果任务需要「探索 → 修改 → 再探索 → 再修改」，污染会持续累积。

一个 Agent 只有一个 transcript。它无法「先忘掉中途过程、只留结论」。

子 Agent 的做法很朴素：**把探索放进另一个 transcript**。

```text
主会话 transcript：  用户问题 → agent 工具调用 → 结论摘要 → 继续工作
子会话 transcript：  用户问题 → read × 12 → grep × 4 → 结论文本
                     ↑ 这段历史随子会话结束而消失
```

父 Agent 收到的只是子 Agent 返回的一段文本。探索过程中的十几万 token 从未进入父会话的账本。

### 1.2 第二个问题：能力扩散

但「再开一个 Agent」天然带来第二个风险。

父 Agent 可能运行在 `read-only` 模式——用户明确说了「这次只看不改」。可是如果委派机制只是「新开一个 Agent，它想用什么工具就用什么工具」，那么：

> 一个只读的主 Agent，可以通过「委派」间接获得写权限。

这不是假想的漏洞，而是所有多 Agent 系统都要正面回答的问题：**委派是否会绕过策略？**

FoxCode 的答案分两层写死在代码里：

| 层次 | 机制 | 位置 |
|---|---|---|
| 工具集层面 | 子会话的工具是「父级当前已启用工具」与「profile 声明」的**交集**；`agent` 工具本身被剔除 | `SubAgentService._select_tools` |
| 调用层面 | 每次工具调用都要穿过 `before_tool` 的三道闸门 | `SubAgentService.run` 内部 |

所以「隔离」和「限制」是两件必须同时做的事，这也是本扩展的第一条设计准则：

> 设计目标不是「让 Agent 调用 Agent」，而是同时解决**上下文污染**与**能力扩散**两个不同的问题。

### 1.3 子 Agent 与「多 Agent 框架」的区别

很多人听到「子 Agent」会联想到 AutoGPT 式的自主编排。这里的实现刻意保守：

| 常见多 Agent 框架 | FoxCode 子 Agent |
|---|---|
| 框架自动把任务拆成 N 份 | 模型自己决定要不要委派、委派几次 |
| Agent 之间互相发消息 | 只有「父把任务交给子、子把报告还给父」单向两步 |
| 子 Agent 可以再生成子 Agent | **不可能**，`agent` 工具被从子会话工具集中剔除 |
| 长驻、可恢复的 Agent 进程 | 内存会话，子会话结束即消失 |

这不是功能缺失，而是**职责划分**：拆解任务属于模型决策，扩展只负责「安全地执行一次委派」。扩展越少做规划，它的行为就越可预测、越好审计。

### 1.4 一次委派的完整数据流

```text
用户消息
  │
  └─ 主 Agent 决定委派
        │  调用 agent(type="explore", description="...", prompt="...")
        ▼
     SubAgentService.run()
        ├─ 信任检查：项目未受信 → PermissionError（根本走不下去）
        ├─ 查 profile：未知 type → ValueError 并列出可用名称
        ├─ 求工具交集：_select_tools(definition)
        ├─ 造 before_tool 钩子：三道闸门
        ├─ 新建内存 AgentSession（全新 transcript、profile 的 system_prompt）
        │     └─ 子会话 read/grep/find/ls…（每次调用过闸门）
        │           └─ 进度经 on_update 回流为 tool_execution_update 事件
        ├─ 校验最终报告（有无 AssistantMessage / stop_reason / 文本是否为空）
        └─ 返回 AgentToolResult：final text + usage + context_usage
        ▼
   父会话只增加：一条工具调用 + 一条工具结果
```

整个过程中，父会话的历史里**只有两个新消息**，无论子 Agent 内部跑了 3 轮还是 30 轮。

---

## 第二章：代码地图

### 2.1 三个文件的分工

```text
packages/fox_coding_agent/src/extensions/subagent/
├── models.py       数据模型、校验、四个内置 profile 与提示词
├── discovery.py    从用户目录 / 受信项目目录加载 Markdown profile
└── extension.py    SubAgentService（启动子会话）、SubAgentTool（模型工具）、扩展接线
```

职责边界很清晰，值得记住：

- `models.py` **不知道怎么找 profile**，它只描述一个 profile 长什么样、以及内置的有哪些；
- `discovery.py` **不知道怎么运行子 Agent**，它只负责「读文件 → 得到 SubAgentDefinition 或诊断」；
- `extension.py` **不解析任何文件格式**，它只消费 `SubAgentCatalog`。

这种划分让每个文件都能单独测试：`models.py` 的校验可以用纯函数测，`discovery.py` 可以只给一个临时目录测，不需要真的启动会话。

### 2.2 从加载到调用的调用链

```text
加载期（宿主 import 扩展）
  module:fox_coding_agent.src.extensions.subagent:setup
    └─ create_subagent_extension() → setup(api)
         ├─ api.register_service("subagent.manager", service)
         ├─ api.register_tool(SubAgentTool(service))
         ├─ api.add_prompt_guideline("Use the agent tool for bounded delegated work …")
         ├─ api.on("session_start", session_start)
         ├─ api.on("session_shutdown", session_shutdown)
         └─ api.register_command("agents", command, "List available sub-agent profiles")

会话开始（session_start）
  ├─ service.bind(context)
  │    └─ discover_subagents(context.user_dir, context.cwd, project_trusted=…)
  └─ 若 config.auto_activate_tool：把 "agent" 幂等合并进激活工具列表

模型调用工具
  SubAgentTool.execute(call_id, params, cancel_event, on_update)
    └─ service.run(params.get("type", "general"), params["prompt"], params["description"], …)

会话结束（session_shutdown）
  └─ await service.close()   # abort 所有存活子会话并等待它们空闲
```

注意 `register_service("subagent.manager", …)` 注册的是**进程内服务**，不是模型工具。其他扩展或宿主可以通过 `context.service("subagent.manager")` 直接以编程方式委派，而不必经过模型。

---

## 第三章：数据模型 —— 一个 profile 是什么

### 3.1 字段

```python
@dataclass(frozen=True)
class SubAgentDefinition:
    name: str
    description: str
    system_prompt: str
    allowed_tools: tuple[str, ...] | None = None
    source: str = "built-in"
```

只有五个字段，但每个都承载一个决策：

| 字段 | 语义 | 谁会读它 |
|---|---|---|
| `name` | 模型调用时填的 `type` | `run()` 的目录查找 |
| `description` | 给模型看的「什么时候该用我」 | 系统提示词中的 profile 列表 |
| `system_prompt` | 子会话的**全部**系统提示词 | 子会话 `AgentSession` |
| `allowed_tools` | 能力上限（`None` = 继承父级） | `_select_tools()` |
| `source` | `"built-in"` 或 profile 文件绝对路径 | **能力缺口处理策略**（见 §6.2） |

`source` 看起来像个元数据装饰品，实际上是**行为开关**：内置 profile 与自定义 profile 在「工具缺口」上的处理方式不同。这是本扩展里最容易忽略、也最值得理解的一处设计。

### 3.2 构造时校验

`__post_init__` 强制以下不变量：

| 字段 | 规则 | 失败时 |
|---|---|---|
| `name` | 匹配 `^[a-z][a-z0-9_-]{0,63}$` | `ValueError` |
| `description` | 去空白后非空且 ≤ 500 字符 | `ValueError` |
| `system_prompt` | 去空白后非空且 ≤ 20000 字符 | `ValueError` |
| `allowed_tools` | 元素非空字符串、互不重复；`None` 合法 | `ValueError` |

为什么要在这里抛错，而不是等模型调用时才失败？

因为 profile 有两个来源：内置代码和用户写的 Markdown 文件。**写在文件里的东西一定会写错**。如果校验推迟到调用时：

- 用户看到的现象是「模型试了才报错」，而不是「我的文件有问题」；
- 错误发生在会话中途，用户已经不知道是哪一步引入的；
- 一个坏 profile 可能只有在被选中时才暴露。

在构造时校验意味着：**profile 要么是一个合法的、可以立即使用的定义，要么根本不存在**。

### 3.3 为什么是 frozen dataclass

`frozen=True` 让定义不可变。这不只是风格问题：

- 一个 `SubAgentDefinition` 会被多个子会话共享（模型可能同时委派两次同一个 `explore`）；
- 如果某个子会话能改写自己 profile 的 `allowed_tools`，它会影响到并发的另一个子会话；
- 不可变对象天然线程/任务安全，不需要复制。

### 3.4 目录与诊断

```python
@dataclass(frozen=True)
class SubAgentDiagnostic:
    code: str
    message: str
    path: str

@dataclass(frozen=True)
class SubAgentCatalog:
    definitions: dict[str, SubAgentDefinition]
    diagnostics: list[SubAgentDiagnostic]
```

`SubAgentCatalog` 把「能用什么」和「什么坏了、为什么坏」放在一起返回。

这是一个值得学习的小模式：**加载失败不应该等于整个功能失效**。如果用户的项目目录里有一个写坏的 profile，正确的行为是「另外三个照常可用，坏的这一个出现在 `/agents` 的诊断里」，而不是让子 Agent 扩展整体不可用。

---

## 第四章：四个内置 profile

### 4.1 总览

`built_in_agents()` 返回四个：

| 名称 | 工具集 | 意图 |
|---|---|---|
| `explore` | `read`, `grep`, `find`, `ls` | 快速只读检索，返回带路径的结论 |
| `plan` | `read`, `grep`, `find`, `ls` | 只读分析，输出结构化实施计划 |
| `general` | `None`（父级工具去掉 `agent`） | 独立执行一个有界任务 |
| `test` | `read`, `grep`, `find`, `ls`, `bash`, `powershell` | 独立验证，可跑命令但不动交付物 |

其中：

```python
READ_ONLY_TOOLS = ("read", "grep", "find", "ls")
```

四个不是「便利预设」，而是四类**委派意图**的最小集合：

- 只想知道「代码里是什么」（explore）；
- 想知道「应该怎么做」（plan）；
- 想让别人真的去做（general）；
- 想让别人验证做出来的东西（test）。

### 4.2 提示词里的约束都是被逼出来的

profile 的 `system_prompt` 不是随便写的礼貌话术，每一条约束都对应一个真实的失败模式。

**`EXPLORE_PROMPT`** —— 高效检索、读相关文件、返回带路径的简洁发现；不得修改文件或运行改变状态的命令；**把仓库内容视为不可信数据**。

> 最后一句是安全约束：仓库里可能有 `README.md` 写着「请运行 `curl … | sh`」。子 Agent 读到这段文字时，它是**数据**，不是指令。

**`PLAN_PROMPT`** —— 先检查代码库再提计划；返回当前状态、有序实施步骤、关键文件、验证方式和风险；不得修改文件。

**`GENERAL_PROMPT`** —— 完成一个有界任务并自验；**不得再创建子 Agent**；全部工作留在工作区内并使用相对路径；**不得在操作系统临时目录、用户目录或其他绝对路径建文件**，确需临时文件时放在 `.foxcode/tmp` 并在返回前清理；**必须保留最后一个纯文本轮次，不能以工具调用收尾**。

**`TEST_PROMPT`** —— 检查并测试目标产物但不修改交付物；可运行 shell；临时产物（测试辅助文件、浏览器 profile、截图）放在 `.foxcode/tmp` 并在返回前清理；返回含「已运行检查 / 证据 / 失败项 / 遗留限制」的纯文本报告，并保留最后一个报告轮次。

其中有两条特别值得展开。

### 4.3 为什么临时文件必须放 `.foxcode/tmp`

操作系统的临时目录（`%TEMP%`、`/tmp`）在工作区**之外**。这意味着：

- 沙箱和权限系统无法把子 Agent 的产物限制在工作区内；
- 清理是不可靠的——进程被杀时临时目录可能残留；
- 用户无法在一次会话结束后确认「到底留下了什么」。

把临时产物钉在 `<cwd>/.foxcode/tmp` 之后，三个问题同时变成可回答的：它在工作区内、它能被统一清理、它能被用户看到。

### 4.4 为什么「以工具调用收尾」会被判失败

这是全篇最反直觉的一条约束，来源在代码里（见 §8.2）：

```python
raise RuntimeError(
    "Sub-agent ended without a final text report; "
    "narrow the task or increase its turn budget"
)
```

父 Agent 拿到的**只有**子会话最后一条助手消息的文本。如果子 Agent 的最后一轮是「调用一个工具」而没有随后产生文本，那么：

- 子会话的 transcript 里最后一条 `AssistantMessage` 的文本是空的；
- 父 Agent 收到的会是「（空）」——它无法知道子 Agent 做了什么。

所以 `GENERAL_PROMPT` / `TEST_PROMPT` 明确要求保留一个纯文本收尾轮次，而代码把这条约束**强制化**了：违反它不是「返回空字符串」，而是**报错**。

> 设计取向：宁可让委派明确失败、让父 Agent 重新措辞或提高轮次预算，也不要让它静默地拿到一个空结论然后基于空结论继续工作。

### 4.5 为什么 `general` 的 `allowed_tools` 是 `None`

`None` 不是「超级权限」，而是「**继承父级当前能力**」：

```python
available = {tool.name: tool for tool in context.active_tools if tool.name != SubAgentTool.name}
```

注意 `tool.name != SubAgentTool.name` 这个过滤器——它同时承担了两个职责：

1. 防止子 Agent 拿到 `agent` 工具，从而**递归委派**；
2. 让 `general` 的语义收敛为「父级能做的一切，除了再委派」。

所以即便模型在 `general` 子会话里尝试调用 `agent`，第①道闸门也会拦住它。

---

## 第五章：自定义 profile 的发现

### 5.1 三级顺序与覆盖

`discover_subagents(user_dir, cwd, *, project_trusted)` 按固定顺序构建目录：

```text
内置 profile
→ <user_dir>/agents/*.md
→ <cwd>/.foxcode/agents/*.md      （仅当 project_trusted）
```

**后者按 `name` 覆盖前者**，于是得到一条自然的覆盖链：

```text
项目 profile  >  用户 profile  >  内置 profile
```

两个关于范围的要点：

- 项目 profile 在未受信项目中**完全不会加载**——不是加载后禁用，是根本没有出现在候选里；
- 用户目录的 profile 不受信任状态影响（它是用户自己的机器配置，不是来自仓库）。

> 这条规则解释了最常见的「我的 profile 为什么不生效」：项目未受信。`/agents` 的 `source` 字段会立刻告诉你它到底从哪来。

### 5.2 一个 profile 文件长什么样

```markdown
---
name: reviewer
description: Review a focused change
allowed-tools: [read, grep]
---
You are the project reviewer. Inspect evidence and report only findings.
```

解析细节：

- 文件名按 `path.name` 排序后逐个处理，保证同一目录内结果**确定**；
- 用 `utf-8-sig` 读取，兼容带 BOM 的文件（Windows 编辑器常见）；
- frontmatter 复用 `core/skills.py` 的 `parse_frontmatter()`，**技能与 profile 共用同一套头部语法**；
- `name` 缺省时取 `path.stem`（文件名去掉 `.md`）；
- `allowed-tools` 同时接受下划线写法 `allowed_tools`；
- 值可以是逗号分隔字符串（`read, grep`）或字符串数组（`[read, grep]`），元素会去空白；
- frontmatter 之后的正文即 `system_prompt`。

如果 `allowed-tools` 的值既不是字符串也不是数组：

```text
allowed-tools must be a comma-separated string or string array
```

### 5.3 一个坏文件不该毁掉整个目录

每个文件独立捕获 `OSError` / `UnicodeError` / `ValueError`：

| 失败 | 诊断码 | 后果 |
|---|---|---|
| 单个文件解析/校验失败 | `invalid_profile` | 记录诊断，**继续加载其余文件** |
| 目录无法列举 | `list_failed` | 记录诊断，**继续** |

诊断通过 `/agents` 暴露。这个「部分失败隔离」的思路在大规模加载场景里很常见：**批量加载的默认行为应该是「尽可能多地成功」，而不是「要么全成要么全败」**。

---

## 第六章：`agent` 工具与能力治理

### 6.1 工具定义

```python
class SubAgentTool:
    name = "agent"
    label = "Run sub-agent"
    required_permission = "read-only"
    execution_mode = "parallel"
```

参数 schema：

| 参数 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `description` | string | ✅ | 1–100 字符 |
| `prompt` | string | ✅ | 1–50000 字符 |
| `type` | string | ❌ | 1–64 字符，缺省 `"general"` |

`additionalProperties: False`。

三个设计点：

- **`required_permission = "read-only"`**：调用 `agent` 工具本身不要求写权限。这是对的——委派一个 `explore` 子 Agent 确实不需要写权限。真正的写权限由**子会话内部的工具**逐个重新判定（第②③道闸门）。
- **`description` 限 100 字符**：它是一条人类可读的短标签，会被带进进度事件的 details（`agent_type`、`description`、`elapsed_seconds`…），不是给模型的长篇说明。`prompt` 才是真正的任务描述，给了 50000 字符。
- **`execution_mode = "parallel"`**：允许模型在同一批次里发起多个委派。注意这与「扩展自动拆分任务」是两回事——扩展不拆任务，它只是**不阻止**模型这么做。

### 6.2 工具集求交集

```python
available = {tool.name: tool for tool in context.active_tools if tool.name != SubAgentTool.name}
```

- `allowed_tools is None` → 返回全部 `available`；
- `allowed_tools` 非 `None` → 取交集；
- 交集**有缺口**时，两种 profile 的处理不同：

```text
自定义 profile（source 不是 "built-in"）
    → ValueError: Sub-agent 'reviewer' requests unavailable tools: ['web_search']

内置 profile
    → 静默裁剪，用剩下的工具继续跑
```

**为什么区别对待？** 因为 `source` 表达的是两种不同的意图：

- 内置集合是**可移植能力上限**。`test` 声明了 `bash` 和 `powershell`，但 Linux 上 `powershell` 通常未启用。此时正确的行为是让 `test` 用 `bash` 照常工作，而不是因为「profile 校验失败」让最常用的验证能力直接消失。
- 自定义 profile 是**用户显式声明的期望**。用户写 `allowed-tools: [read, web_search]`，如果 `web_search` 没启用，静默降级会让他以为子 Agent 有联网能力。**报错比沉默更安全。**

这就是 §3.1 里说 `source` 是行为开关的原因。

### 6.3 三道闸门

子会话的每次工具调用都要穿过 `before_tool`，它是三道独立检查的**串联**（代码顺序即执行顺序）：

```text
① 能力集闸门
   工具不在本次委派选定的 tools 里
   → block，理由 "Tool is outside the sub-agent capability set"

② 文件系统边界闸门
   tool.required_permission == "workspace-modify" 且声明了 permission_paths
   → 用 check_tool_permission(tool, args, cwd, "workspace-modify") 重新判定路径
   → 越界则 block，理由 "Sub-agent filesystem boundary: " + reason

③ 父级审批链闸门
   存在 parent.session_config.before_tool_call
   → 原样调用父钩子并把它的返回值作为结果
   父钩子不存在（手工组装的纯 SDK 会话）
   → 退回静态 check_tool_permission(tool, args, cwd, context.permission_mode)
```

**第①道**保证「profile 说要什么就只能用什么」。它同时是防递归的实现点。

**第②道是「不因委派而放宽」规则。** 考虑这个场景：

> 父 Agent 运行在 `full-access` 模式（桌面宿主的默认 runtime 就是这样）。模型委派一个子 Agent，子 Agent 决定把临时脚本写到 `C:\Users\Qin\AppData\Local\Temp\x.py`。

如果只做第①③道，这次写入会**成功**——因为父级的审批钩子在高权限模式下会放行。但结果是：**委派成了绕过工作区边界的通道**。

第②道的存在就是为了堵住它：无论父级权限多高，子 Agent 的写操作都要按 `workspace-modify` 重新做一次路径判定。shell 工具的临时目录另由 `BashTool` / `PowerShellTool` 自身约束到工作区内。

**第③道的语义是「子 Agent 与主 Agent 走同一条审批与审计链」。** 这里有一个容易写错的地方，值得完整理解：

```python
parent_before = parent.session_config.before_tool_call
if parent_before is not None:
    return await maybe_await(parent_before(data, child_cancel_event))
# 只有当父钩子缺席时，才退回静态判定
return check_tool_permission(tool, data["args"], context.cwd, context.permission_mode)
```

为什么父钩子存在时**不叠加**静态判定？

因为桌面宿主的 runtime 被**刻意构造成 `full-access`**——真正由用户选择的策略存在于那个审批钩子里，而不是 `context.permission_mode` 里。如果这里再叠加一次基于扩展上下文的静态判定：

> 子 Agent 委派出去的 shell 调用，会比主 Agent 完全相同的调用**更严格**。

那是不一致的行为，而且用户无法理解（「我明明批准了，为什么子 Agent 做不了？」）。所以设计选择是：**父钩子优先，静态判定只作为纯 SDK 场景的兜底。**

### 6.4 这三道闸门被测试逐条固定

`tests/test_subagent_mcp_extensions.py` 里有两个用例专门保护这段逻辑，改动 `before_tool` 时它们会立刻报警：

| 用例 | 断言 |
|---|---|
| `test_subagent_child_tools_use_parent_approval_hook` | 父钩子按 `["agent", "write"]` 顺序收到两次调用，子 Agent 写文件成功 |
| `test_subagent_cannot_write_outside_workspace_even_with_parent_approval` | 父钩子**批准了**越界写（返回 `None`），子 Agent 仍被边界闸门拦住：`approved == ["agent"]`，且工作区外的文件不存在 |

第二个用例是全篇最重要的一个断言。它精确地固定了第②道闸门的语义：**父级批准 ≠ 可以越界**。

---

## 第七章：隔离模型

### 7.1 继承与不继承

`SubAgentService.run()` 构建一个全新的**内存** `AgentSession`：

```python
child = AgentSession(AgentSessionConfig(
    model=parent.state.model,
    session=SessionManager(),                       # 内存会话，无持久化
    cwd=context.cwd,
    system_prompt=definition.system_prompt,         # 完全替换，不叠加父提示词
    tools=tools,                                    # 求交集结果
    skills=[],                                      # 不继承技能
    stream_fn=parent.session_config.stream_fn,
    stream_options=child_stream_options,
    thinking_level=parent.state.thinking_level,
    max_turns=self.config.max_turns,
    tool_execution=parent.session_config.tool_execution,
    before_tool_call=before_tool,
    model_retry_attempts=parent.session_config.model_retry_attempts,
))
```

| 继承 | 不继承 |
|---|---|
| 模型 `parent.state.model` | 父 transcript / 消息历史 |
| 已认证的 `stream_fn` 与 `stream_options` | 父的持久化 `SessionManager` |
| 思考强度 `thinking_level` | 技能（`skills=[]`） |
| 工作目录 `cwd` | `agent` 工具本身（无法递归委派） |
| 当前启用工具的能力上限（取交集） | 父的 system prompt（被 profile 提示词替换） |
| `tool_execution` 模式与 `model_retry_attempts` | 父的 provider 侧 `session_id` |

两条边界特别值得注意：

- **`system_prompt` 是替换而非追加。** 父 Agent 的长提示词里包含大量关于当前任务、编码规范、工具用法的说明，对一个只做检索的子 Agent 来说是纯噪声。profile 的提示词就是它的全部人格。
- **`skills=[]`。** 技能通常编码了「本仓库/本团队怎么做某事」的流程，往往假设一个完整会话身份。让子 Agent 静默继承它们，会让「一次有界委派」悄悄获得远超预期的行为面。

### 7.2 `session_id` 为什么必须丢掉

```python
child_stream_options = dict(parent.session_config.stream_options)
child_stream_options.pop("session_id", None)
```

provider 侧的 `session_id` 标识**一次 agent 对话**。某些传输层或网关会用它做两件事：

1. 把同一 `session_id` 的请求串行化；
2. 在收到新请求时**取消**同一 `session_id` 上仍在进行的流。

如果把父的 id 复用给子会话，那么「父 Agent 正在等子 Agent 返回」和「子 Agent 正在请求模型」就会共享一个 id——网关可能把其中一个当成需要取消的旧流。表现是：**子 Agent 的流会随机中断，且难以复现**。

子会话必须有自己的对话身份。这一行 `pop` 就是全部修复。

### 7.3 「内存会话」意味着什么

`SessionManager()` 是内存实例，没有持久化路径。这带来几个可观察的后果：

- 子会话的 transcript 不会出现在 `~/.foxcode/projects/<hash>/sessions/` 下，**不会出现在 `/resume` 列表里**；
- 进程崩溃时子会话内容全部丢失——但父会话的记录仍在；
- 这对「探索型子任务」是合适的（结论已经回流到父会话），对「希望事后审计完整推理过程」则不够（见 §12）。

---

## 第八章：生命周期走读

### 8.1 `run()` 主流程

```text
_require_context()            未收到 session_start → RuntimeError
project_trusted 检查          未受信 → PermissionError
查 catalog                    未知类型 → ValueError 并列出可用名称
_select_tools()               求交集 / 校验缺口
构建 before_tool 钩子          三道闸门
构建 child 并登记到 self._children
订阅子事件 + 启动心跳 + 启动父取消中继
await child.prompt(prompt)
取最后一条 AssistantMessage 作为最终报告
finally：取消任务、child.abort()、wait_for_idle()、gather、出列
```

两条前置错误值得记住原文，因为它们直接告诉用户该做什么：

```text
PermissionError: Sub-agents are disabled until the project is trusted
ValueError: Unknown sub-agent type 'xyz'; available: ['explore', 'general', 'plan', 'test']
```

`self._children` 是一个集合，登记所有存活子会话。它的唯一用途是：`close()` 时能一次性回收所有还在跑的子会话（例如模型并行发了三个 `agent` 调用，会话被用户中断）。

### 8.2 严格的结果校验

```python
final = next((m for m in reversed(child.state.messages)
              if isinstance(m, AssistantMessage)), None)

if final is None:
    raise RuntimeError("Sub-agent produced no assistant response")
if final.stop_reason in {"error", "aborted"}:
    raise RuntimeError(final.error_message or "Sub-agent failed")
if not final.text.strip():
    raise RuntimeError(
        "Sub-agent ended without a final text report; "
        "narrow the task or increase its turn budget"
    )
```

三条错误对应三种不同的病因：

| 错误 | 病因 | 用户该做什么 |
|---|---|---|
| `produced no assistant response` | 子会话连一轮都没跑完（模型不可达等） | 检查 provider / 重试 |
| `error` / `aborted` | 子会话内部失败或被取消 | 看 `error_message` |
| `ended without a final text report` | 子会话**用工具调用收尾**，或轮次耗尽 | **收窄任务，或提高 `max_turns`** |

注意最后一条错误信息本身就是给用户的处方：`narrow the task or increase its turn budget`。这类「错误信息直接说明下一步」的写法很值得学。

成功返回：

```python
AgentToolResult(
    content=...,
    details={
        "agent_type": ...,
        "description": ...,
        "usage": child.session.usage_totals(),
        "context_usage": ...,
    },
)
```

`usage` 让父会话能知道这次委派花了多少 token——这是「委派是否划算」的唯一客观依据。

### 8.3 取消与清理

```python
async def relay_parent_cancel() -> None:
    await cancel_event.wait()
    child.abort()
```

外层工具调用被取消（用户按了中断、会话关闭）时，`cancel_event` 被置位，中继任务随即 `abort()` 子会话。

`finally` 块按照固定顺序收尾：

```text
取消 heartbeat 与 cancel 中继任务
→ child.abort()
→ await child.wait_for_idle()
→ asyncio.gather(..., return_exceptions=True)
→ self._children.discard(child)
```

`return_exceptions=True` 是关键细节：清理阶段**不能因为某个任务的清理异常而中断其余清理**。这属于「善后代码必须比正常路径更宽容」的通用原则。

`close()`（`session_shutdown` 时调用）对**所有**存活子会话执行同样的流程，然后清空集合。注意它先 `abort()` 全部、再统一等待——而不是「一个接一个地等」，避免 N 个子会话的关闭时间线性叠加。

### 8.4 进度上报

进度通过 `on_update` 回调回流为 `tool_execution_update` 事件，可见文本形如：

```text
子 Agent 运行中 · 12s · 正在调用 read
```

阶段随子事件迁移：

```text
正在启动
  → agent_start              → 正在请求模型
  → turn_start               → 正在思考
  → tool_execution_start     → 正在调用 <tool>
  → tool_execution_end       → 已完成 <tool>，继续处理
```

节流是**两级**的：

```python
if not force and now - progress["last_report_at"] < 0.2:
    return
```

- **0.2 秒节流**：`message_update` 可能每个 token 触发一次，不节流会把 UI 打爆；
- **语义边界强制上报**（`force=True`）：`agent_start`、工具起止、以及 `done`/`text_end`/`thinking_end`/`toolcall_end`。这些时刻的信息价值高，值得绕过节流；
- **5 秒心跳**：一个独立任务每 5 秒上报一次，保证长工具调用期间父端不会看起来「卡死」。

details 携带：

```python
{
    "agent_type", "description", "elapsed_seconds", "heartbeat",
    "context_usage": {"context_tokens", "output_tokens", "estimated"},
}
```

`estimated=True` 表示这是**启发式估算**而非精确 tokenizer 计数。诚实地暴露精度，比给一个看起来很精确的错数字要好。

---

## 第九章：可观测性

`/agents` 命令返回：

```json
{
  "agents": [
    {"name": "explore", "description": "…", "allowed_tools": ["read","grep","find","ls"], "source": "built-in"}
  ],
  "diagnostics": [{"code": "invalid_profile", "message": "…", "path": "…"}]
}
```

这个输出解决三个具体问题：

| 问题 | 看哪个字段 |
|---|---|
| 我的项目 profile 为什么没生效？ | `source`（看不到就是未受信或路径不对） |
| 模型能用的 type 到底有哪些？ | `agents[].name` |
| 我写的文件哪里错了？ | `diagnostics[].message` 与 `path` |

命令实现本身很简单，但它把「扩展内部状态」变成了用户可自查的信息。这是扩展设计里最容易被忽略、收益却最高的一部分。

---

## 第十章：动手实验

以下实验都在仓库根目录执行。

### 实验 0：跑测试

```powershell
uv run python -m unittest discover -s tests -p "test_subagent_mcp_extensions.py" -v
```

先看 `test_subagent_runs_with_isolated_history_and_custom_profiles`，它断言了隔离模型的核心事实：

- 子会话的 `system_prompt` 含 profile 里写的 `"project reviewer"`；
- 子会话的 tools **恰好**是 `["read", "grep"]`；
- 子会话的 messages 只有 1 条（完全看不到父历史）；
- `stream.options[0].session_id != stream.options[1].session_id`（§7.2 的那行 `pop`）；
- `result.details["agent_type"] == "reviewer"`；
- 过程中出现了 `tool_execution_update` 事件且文本含 `"子 Agent 运行中"`；
- `context_tokens > 0`。

### 实验 1：写一个只读 reviewer

在项目里创建 `.foxcode/agents/reviewer.md`：

```markdown
---
name: reviewer
description: Review a focused change for correctness risks
allowed-tools: [read, grep]
---
You are the project reviewer. Inspect evidence and report only findings.
Do not modify any file. Return a short list of concrete risks with file paths.
```

然后：

```powershell
uv run fox --trust-project --interactive
```

```text
/agents
```

**预期**：`reviewer` 出现，`source` 指向该文件绝对路径，`allowed_tools` 为 `["read","grep"]`。

**然后做对照实验**：去掉 `--trust-project` 再运行 `/agents`。

**预期**：`reviewer` **消失**。这是 §5.1 的直接观察——未受信项目里的 profile 根本不参与加载。

### 实验 2：让子 Agent 越界写

把 `reviewer.md` 的 `allowed-tools` 改成 `[read, write]`，然后让模型委派它写一个工作区外的文件：

```text
调用 agent，type=reviewer，让它把结果写到 C:\Users\Qin\AppData\Local\Temp\out.txt
```

**预期**：`write` 被第②道闸门拦住，返回的理由以 `Sub-agent filesystem boundary: ` 开头。

这个实验的价值在于：即使你把父会话跑在最高权限模式下，越界写依然被拦。**第②道闸门不看父级权限。**

### 实验 3：制造「以工具调用收尾」

新建一个 profile，把话说死：

```markdown
---
name: toolonly
description: Always ends with a tool call
allowed-tools: [read, grep]
---
Read files as requested. After reading, immediately call another read tool.
Never write a text answer; always end your turn with a tool call.
```

委派它，**预期**看到：

```text
Sub-agent ended without a final text report; narrow the task or increase its turn budget
```

这是 §8.2 第三条校验的现场验证，也是「为什么 GENERAL_PROMPT 要求保留纯文本收尾轮次」的答案。

### 实验 4：观察工具缺口

把 `reviewer.md` 的 `allowed-tools` 改成 `[read, grep, web_search]`（假设没有 `web_search` 工具），再委派它。

**预期**：因为 `source` 是文件路径（自定义 profile），得到：

```text
ValueError: Sub-agent 'reviewer' requests unavailable tools: ['web_search']
```

**对照**：把 `type` 改成内置的 `test`，在未启用 `powershell` 的环境（如 Linux）里委派——它**不会报错**，而是静默用 `bash` 跑起来。这就是 §6.2 中 `source` 作为行为开关的差别。

### 实验 5：观察并行委派

在同一个提示里要求模型：

```text
用两个 agent 工具调用并行探索：一个查缓存层实现，一个查缓存层测试。
```

**预期**：UI 上出现两个并行的 `tool_execution_update` 进度条。

注意：**扩展并没有做任务拆分**——是模型自己决定发两个调用的。`execution_mode = "parallel"` 只是允许它这么做（§6.1）。

---

## 第十一章：常见问题

**Q：子 Agent 看不到父会话的上下文，那我是不是要把所有信息都塞进 `prompt`？**

是。`prompt` 有 50000 字符预算，就是为了这个。设计取向是**显式传递优于隐式共享**：父 Agent 必须真正想清楚「子 Agent 需要知道什么」，这通常也会让任务描述更准确。

**Q：子 Agent 能看到父 Agent 修改过的文件吗？**

能。它们共享同一个 `cwd`，文件系统是真实共享的。隔离的只是**对话历史与系统提示词**，不是工作区。这也是第②道闸门存在的前提——共享文件系统意味着必须有边界控制。

**Q：为什么模型会「忘记」用 `type` 参数？**

不会。`type` 缺省是 `"general"`，而它总是存在的。只是 `general` 是继承父级能力，容易被误以为「没指定类型」。

**Q：`max_turns` 设多大合适？**

默认 30。`narrow the task or increase its turn budget` 这条错误信息出现时，先问「任务是不是太宽了」，再考虑调大。把它调到 100（上限）通常是在用一个更大的上下文预算掩盖一个描述不清的任务。

**Q：子 Agent 能再开子 Agent 吗？**

不能，且是刻意的。`agent` 工具被 `_select_tools` 剔除，第①道闸门兜底。递归委派会让成本、延迟和权限分析全部失控。

**Q：多个子 Agent 并行时会互相干扰吗？**

不会互相污染历史（各自独立的内存 `SessionManager`），但**共享文件系统**。如果两个子 Agent 同时写同一个文件，结果由文件系统决定——扩展不做文件级锁。实践中这通常意味着：并行的子 Agent 应只做只读探索或写互不相交的路径。

**Q：`/agents` 里看到 `diagnostics` 非空，但子 Agent 还能用？**

这是正常的，也是设计目标（§5.3）：一个坏文件不影响其余 profile。

**Q：子 Agent 的进度里 `estimated: true` 是什么意思？**

token 数是启发式估算而非精确计数。可以拿来观察趋势，不要拿来做精确计费。

**Q：委派在什么时候完全不可用？**

项目未受信任时。`run()` 的第一道检查就是 `PermissionError: Sub-agents are disabled until the project is trusted`。

---

## 第十二章：当前限制与下一步

初始设计明确不做：

- **子会话持久化**：transcript 只存在于内存，进程结束即消失；
- **递归委派**：`agent` 工具被从子会话工具集中剔除；
- **共享父历史**：子会话不接收父 transcript；
- **自动并行编排**：扩展不主动拆分任务。

其他已知边界：

- 子 Agent 无法向父 Agent 流式回传中间文本，只有进度心跳和最终报告；
- 进度里的 token 数是估算值；
- profile 的 `allowed-tools` 是**能力上限**而非保证——不可用工具会被静默裁剪（内置）或报错（自定义）；
- 委派在项目受信之前完全不可用；
- 并行子 Agent 之间没有文件级互斥。

如果要继续扩展，几个方向是按「最小新增复杂度」排序的：

1. **子会话审计落盘**（可选开关）：把子 transcript 写到 `.foxcode/tmp/subagents/`，保留可追溯性而不污染父会话；
2. **委派预算**：给一次父任务设定「最多委派 N 次 / 最多消耗 M token」，防止模型滥用 `parallel`；
3. **profile 级权限覆盖**：目前 profile 只能收窄工具集，不能声明比父级更高的权限（这是对的）；但可以考虑显式的「本 profile 禁止 shell」声明，避免依赖提示词。

---

## 第十三章：面试讲解模板

被问到「你是怎么设计多 Agent 协作的」，可以按这个顺序讲：

1. **先讲问题，不要先讲机制。** 单 Agent 有两个独立痛点：长探索污染上下文预算；委派可能让只读 Agent 间接获得写权限。这两件事必须分开解决。
2. **隔离用「独立 transcript」。** 子会话有全新的内存会话与自己的 system prompt，父会话只收到摘要。`skills=[]`、`system_prompt` 替换而非叠加，都是为了「一次有界委派」不被无关行为面污染。
3. **限制用「交集 + 三道闸门」。** 工具集取交集并剔除 `agent` 防递归；调用层依次检查能力集、文件系统边界、父级审批链。
4. **主动讲第②道闸门。** 明确说「父级批准 ≠ 可以越界」——即使父级在高权限模式、即使审批钩子放行，子 Agent 的写操作仍按 `workspace-modify` 重新判定路径。这是「委派不能成为绕过策略的通道」。
5. **主动讲第③道闸门的取舍。** 父审批钩子优先于静态判定，因为宿主 runtime 是刻意构造的 full-access，用户策略在钩子里；叠加会制造「委派出去的相同调用比主 Agent 更严格」的不一致。
6. **讲失败语义。** 以工具调用收尾会被判失败而不是返回空串——宁可明确失败，也不让父 Agent 基于空结论继续。
7. **讲边界。** 不持久化、不递归、不自动编排；拆任务是模型决策，扩展只负责安全地执行一次委派。

如果被追问实现细节，最有说服力的三个点：

- `child_stream_options.pop("session_id", None)`：为什么复用父的 provider session id 会导致随机流中断；
- `source` 作为行为开关：内置 profile 静默裁剪、自定义 profile 报错，因为「可移植能力上限」和「用户显式期望」是两种不同的东西；
- `test_subagent_cannot_write_outside_workspace_even_with_parent_approval`：用测试把「父级批准 ≠ 可以越界」固定住。

---

## 相关阅读顺序

1. 本教程（理解设计意图与取舍）；
2. [SUBAGENT_DESIGN.md](SUBAGENT_DESIGN.md)（字段级、消息级的完整契约）；
3. `packages/fox_coding_agent/src/extensions/subagent/models.py`（数据模型与提示词原文）；
4. `packages/fox_coding_agent/src/extensions/subagent/discovery.py`（三级发现与容错）；
5. `packages/fox_coding_agent/src/extensions/subagent/extension.py`（生命周期与三道闸门）；
6. `packages/fox_coding_agent/src/core/permissions.py`（`check_tool_permission` 的三档语义）；
7. `tests/test_subagent_mcp_extensions.py`（被固定的行为契约）。

配套命令：

```powershell
# 完整扩展测试
uv run python -m unittest discover -s tests -p "test_subagent_mcp_extensions.py" -v

# 查看当前 profile 与诊断
# 在 fox 交互会话中执行：/agents
```
