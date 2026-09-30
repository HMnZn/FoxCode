# fox_coding_agent：编码宿主架构与面试指南

本篇讲 `fox_coding_agent/src` 如何把通用 Agent 机制组装成可使用的编码助手：模型目录与凭据、`AgentSession`、`SessionManager`、工具、资源、项目信任、扩展和 CLI。底层循环见 [agent-core 指南](../fox_agent_core/ARCHITECTURE_GUIDE.md)。

配套 [CODING_AGENT_LAB.ipynb](CODING_AGENT_LAB.ipynb) 演示真实模型、文件工具、Session、Skill 和压缩。

这份文档同时承担三种用途：第一次运行请先看第十章；理解设计时按第一至九章阅读；开发或排错时直接查第十一、十二章。文中的能力状态以当前仓库代码为准：Session、Compaction、Skills、Extensions、Memory、子 Agent 与 stdio MCP 已实现，自进化 Skill、TUI 和插件市场仍是设计方向，不能当成已经可用的功能。

<a id="ch01"></a>

## 第一章：从通用内核到 mini coding agent

### 1.1 三个独立包与单向依赖

仓库现在是 uv workspace，每个目录都有独立 `pyproject.toml`：

```text
fox-coding-agent  →  fox-agent-core  →  fox-ai
   CLI、项目策略       循环、状态、Harness    Provider 协议
```

| 包 | 对应 pi | 稳定职责 |
| --- | --- | --- |
| `fox_ai` | pi-ai | 标准模型、消息、流事件、Provider 请求与凭据协议 |
| `fox_agent_core` | pi-agent-core | Agent loop、状态、工具协议、通用 `AgentHarness`、Session 存储协议和压缩算法 |
| `fox_coding_agent` | pi-coding-agent | `AgentSession`、JSONL 会话、项目工具、资源、信任、扩展和 CLI |

构建系统声明并检查这个方向。`fox_ai` 不读取 `.foxcode`；`fox_agent_core` 不导入 coding-agent；只有宿主知道用户目录、cwd 和终端命令。

### 1.2 为什么同时有 AgentHarness、AgentSession 和 Runtime

三个名字对应三层生命周期：

- `fox_agent_core.harness.AgentHarness` 是通用运行壳，只负责“单操作互斥、事件转发、持久化钩子”。它不知道 cwd、Skill 和 JSONL。
- `fox_coding_agent.AgentSession` 组合模型、工具、Skill、压缩和一个 `SessionManager`，代表一个可对话的编码会话。
- `AgentSessionRuntime` 管理当前 `AgentSession`，负责切换 cwd/会话、重载模型与资源、项目信任及扩展生命周期。

公开名称按职责划分：通用层使用 `AgentHarness` 与 `AgentHarnessConfig`；编码层使用 `AgentSession` 与 `AgentSessionConfig`；会话历史由 `SessionManager` 管理。同一概念不再提供第二套别名。

```text
CLI / future UI
  └─ AgentSessionRuntime
       ├─ ModelRuntime ─ ModelRegistry + CredentialStore
       ├─ SettingsManager / ResourceLoader / ProjectTrustManager
       └─ AgentSession
            ├─ SessionManager (JSONL tree)
            ├─ Compaction / Skills / coding tools
            └─ fox_agent_core.AgentHarness
                 └─ Agent → agent_loop → fox_ai
```

### 1.3 models.json 与 auth.json 为什么必须拆开

模型元数据和密钥的生命周期不同。模型目录适合校验、展示和版本管理；凭据必须限制读取面，也不能进入日志、异常或 Session。用户级目录采用：

```text
~/.foxcode/
├─ models.json       # provider endpoint、协议、模型能力和价格
├─ auth.json         # provider → api_key / oauth 凭据
├─ settings.json     # 可选运行策略
└─ trust.json        # 项目路径的信任决定
```

`models.json` 示例：

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "models": [
        {
          "id": "deepseek-v4-flash",
          "name": "DeepSeek V4 Flash",
          "contextWindow": 1000000,
          "maxTokens": 384000,
          "input": ["text"],
          "reasoning": true,
          "thinkingLevelMap": {"minimal": "high", "high": "high", "xhigh": "max"},
          "compat": {"thinkingFormat": "deepseek"}
        }
      ]
    }
  }
}
```

`auth.json` 示例：

```json
{
  "deepseek": {
    "type": "api_key",
    "key": "在本机填写"
  }
}
```

`ModelConfig` 只解析模型目录，`ModelRegistry` 负责默认模型和 `provider/id` 查找，`CredentialStore` 只处理凭据，`ModelRuntime` 在请求边界把当前模型与当前 provider 的凭据配对。`models.json` 中出现密钥或 `auth.json` 中出现模型目录都会校验失败，避免同一数据拥有两种来源。

`fox_ai` 的 OpenAI provider 不解析这些文件。它只接收归一化后的 `Model.thinking_level_map` 与 `compat.thinkingFormat`，再把通用 thinking level 编码成具体 HTTP 参数。

### 1.4 Settings 与模型目录不是同一类配置

`settings.json` 用于运行策略，例如最大轮次、工具执行方式和压缩预算。默认值已经在代码中，文件可以不存在。加载优先级为：

```text
代码默认值 < 用户 ~/.foxcode/settings.json
           < 已信任项目 .foxcode/settings.json < CLI/SDK overrides
```

模型清单来自 `models.json`，凭据来自 `auth.json`。Session 记录实际使用的完整模型快照和 thinking level，保证恢复历史时含义稳定；密钥永远不写进 Session。

需要固定默认模型时，用户级文件只写引用即可：`{"model": "deepseek/deepseek-v4-flash"}`。模型能力与端点始终来自 `models.json`，`settings.json` 不接受完整 `Model` 对象。

### 1.5 项目信任边界

未知项目在 CLI 中默认不受信任。未信任时：

- 不自动加载项目/祖先的 `AGENTS.md`；
- 不加载项目 Skill 和项目 settings 中声明的 Extension；
- 所有 coding tool 调用在执行前被阻止；
- 显式调用的纯文本 Prompt 模板仍可读取，它不会自行执行代码。

使用 `fox --trust-project ...` 或交互命令 `/trust` 记录决定；`/untrust` 会重建当前 Session 的宿主资源。`/cwd` 与 `/resume` 都会依据目标 Session 的真实 cwd 重新查询 trust，避免把源项目的决定带到另一个目录。

SDK 直接构造 Runtime 时默认 trusted；嵌入式产品可以传 `project_trusted=False` 或 `trust_resolver` 建立自己的策略。

### 1.6 Runtime 的事务式切换

切换 cwd、恢复 Session 或 reload 时，Runtime 先构造候选 Settings、Resources、Extension、Tools 和 `AgentSession`。候选全部成功后才替换当前对象；失败则继续使用旧会话。

正在运行时切换会先发出取消并等待工具清理和消息持久化。新的 cwd 使用新的工具实例，避免文件工具仍绑定旧目录。Session 文件中的 metadata 决定恢复后的 cwd。

### 1.7 恢复、统计与导出

`AgentSession` 只对“未产生任何内容的安全失败”自动恢复：

- context overflow：回到失败消息的父节点，压缩上下文，再重试一次；
- timeout、429、连接中断和 5xx：回到父节点，按 `model_retry_attempts` 重试；
- 已产生部分内容或已经执行过工具的轮次不自动整轮重放。

失败节点仍保留在 Session 树中，但不污染恢复后的 active branch。`SessionManager.usage_totals()` 汇总活动分支的 token 与费用；`/usage` 查看，`/export file.json|file.md` 导出完整树或当前对话。

### 1.8 运行入口

```powershell
uv sync
uv run fox --list-models
uv run fox --trust-project --interactive
uv run fox --model deepseek/deepseek-v4-pro --thinking high -p "检查这个项目"
uv run fox --resume -p "继续"
```

常用交互命令：`/new`、`/resume`、`/cwd`、`/reload`、`/trust`、`/compact`、`/usage`、`/export`、`/tools`、`/model`、`/thinking`、`/skill` 和 `/prompt`。

<a id="ch02"></a>

## 第二章：编码工具与 System Prompt

### 2.1 八种工具，各自解决什么问题

| 工具 | 主要用途 | mini 版本的边界 |
| --- | --- | --- |
| read | 按行观察文件 | UTF-8 文本、范围和输出限制，不解码图片 |
| write | 创建或整体覆盖文件 | 原子替换；保留旧文件权限 |
| edit | 精确局部替换 | 必须唯一匹配，不做模糊编辑或自动合并 |
| bash | 运行构建、测试和系统命令 | 需要 Bash/Git Bash；有超时、取消、输出上限 |
| powershell | Windows 原生命令 | 需要 pwsh/Windows PowerShell；不加载 profile |
| grep | 搜索内容，返回路径与行号 | 正则使用 rg；没有 rg 时支持 `literal=true` 后备搜索 |
| find | 按 glob 定位文件 | Python 遍历，支持嵌套 .gitignore，跳过目录符号链接 |
| ls | 查看当前目录结构 | 包含隐藏条目，限制返回数量 |

七种工具默认启用，PowerShell 默认只在 Windows 新会话启用；通过 `settings.json` 的 `tools` 可以调整。名称错误和重复名称会在运行时初始化时报错，包括扩展工具与内置工具重名。

find 与 Python grep 后备实现跳过 `.git/.foxcode/.venv/node_modules/__pycache__`，最多遍历 50000 个条目；需要查看这些目录时使用 read/ls 或显式缩小路径。find 支持 .gitignore，不完整模拟 git 的全局 excludes 配置；rg 搜索遵循 rg 自己的忽略规则。工具只处理 cwd 与路径解析，不提供操作系统级沙箱。

与 pi 的工具集合对齐，不等于逐项复刻：当前没有图片读取、远程工具 operations 适配器、模糊 edit、完整输出落盘和 TUI 渲染器。语义清楚、可测试的核心功能是这一版的目标。

### 2.2 System Prompt 必须与实际能力一致

`build_system_prompt()` 根据当前启用工具生成工具说明与编码规则，再加入用户补充、项目指令、可按需读取的技能目录和 cwd。

如果只启用 read，提示词就不列出 write。`set_active_tools()` 和分支切换会同步更新 system prompt，避免模型看到过期工具说明。禁用 read 时不自动展示需要通过 read 加载的 Skill 目录；显式 `invoke_skill()` 仍可直接注入正文。

自定义前缀优先级：显式 `settings.system_prompt` → 项目 `.foxcode/SYSTEM.md` → 用户 `.foxcode/SYSTEM.md` → 内置编码助手说明。`APPEND_SYSTEM.md` 的用户级和项目级内容均追加。替换前缀仍保留工具清单、项目指令与实际运行环境，因此工具切换后这些事实还能更新。

资源是上下文，工具是能力。AGENTS.md 和 Skill 提供做事方法；执行授权仍由宿主 Hook 控制。system prompt 中的规则不能替代实际工具限制。

<a id="ch03"></a>

## 第三章：Session——把历史保存下来，也要能解释如何继续

### 3.1 Session 比 messages 列表多了什么

普通消息列表能够表示一段线性对话，但以下需求还需要额外信息：

- 返回过去的某一步，尝试另一种做法。
- 恢复当时使用的模型、思考级别和工具集合。
- 记录压缩发生在哪个位置。
- 从文件中恢复当前选中的历史分支。

Session 因而保存一组带 `id`、`parent_id`、类型和数据的条目，并使用 `leaf_id` 表示当前所在位置。

### 3.2 为什么历史建模成树

```text
用户提出需求
  └─ 助手分析
       ├─ 方案 A 的工具调用
       │    └─ 方案 A 的结果
       └─ 用户要求尝试方案 B
            └─ 方案 B 的回复  ← 当前 leaf
```

当前分支由 leaf 沿 parent 指针向前追溯得到。分支结构让“回到过去继续”具有清楚含义，不必删除原来的方案 A，也不必把两条路线混进同一个线性列表。

`move_to` 改变当前叶节点；在该节点后新增条目，就形成新的延续。`fork` 则创建一个独立的内存会话。当前实现会复制选定路径上的条目并重新生成 ID，不是通过共享底层存储实现零成本分叉。

### 3.3 历史与模型上下文是不同的数据产品

完整历史主要用于解释、恢复和分支；模型上下文主要用于下一步决策。保存过的每一个历史细节，不需要每次都重新发送给模型。

本项目通过 `build_context()` 把当前分支投影成消息列表。遇到最近的压缩条目，就以摘要与保留尾部作为新的上下文基础。

```text
保存的历史：原始消息 → 更多消息 → 压缩条目 → 后续消息

本轮上下文：摘要 + 压缩时保留的尾部 + 压缩之后新增的消息
```

模型配置还有另一条恢复路径。`build_settings()` 会继续查找压缩点以前的配置条目，因为压缩对话文本不应导致模型、思考级别等配置丢失。

这种“历史记录 → 当前视图”的思路可以借助事件溯源的思想来理解，但当前项目没有完整保存所有运行事件，也没有实现确定性的执行重放。面试时可以说它具有历史投影的设计，不应直接声称实现了完整 Event Sourcing 系统。

### 3.4 为什么提供存储协议

Session 通过存储接口访问条目，内存实现和 JSONL 实现遵守同一套约定。这样，上层分支和上下文重建逻辑不需要关心数据究竟来自字典还是文件。

内存后端适合测试和临时对话；JSONL 后端适合单进程的小型持久会话。以后可以增加数据库实现，但还要补足事务和并发语义，不能只替换几个读写函数就宣称支持分布式运行。

### 3.5 JSONL 的“追加”要准确理解

当前 `append_entry()` 是在逻辑历史中追加条目，**物理实现会重新序列化整个会话文件，然后原子替换旧文件。** 它不是每次只向文件末尾 append 一行。

这个实现选择有明确取舍：

| 收益 | 成本 |
| --- | --- |
| 文件始终包含一致的 metadata、leaf 和条目集合 | 历史越长，每次重写的数据越多 |
| 临时文件写入失败时旧文件仍在 | 大会话下时间和写入开销会明显增长 |
| 分支切换也能用同一种保存方式处理 | 不适合多个写入者直接竞争同一个文件 |

保存过程包含临时文件、flush/fsync 和替换操作，普通保存失败还会回滚该次内存修改。但不能因此承诺任何硬件故障下绝不丢数据，也不能把它扩展解释为多个外部系统之间的事务。

### 3.6 恢复时最难的问题是“结果未知”

考虑以下时间线：

```text
1. 已保存：assistant 请求 write
2. 工具执行：目标文件已经修改
3. 进程退出：ToolResult 还没保存
4. 重新打开会话：只能看到调用，看不到结果
```

此时，“没有工具结果”不能推出“工具没有执行”。如果自动重放，可能再次写入、重复提交或重复扣费。

当前恢复策略会检查会话尾部的 assistant 工具调用与已有结果，为缺失结果补上“执行中断、结果未知，需要先检查状态”的错误消息，不自动重新执行工具。

这是一个保守选择：宁可让后续决策重新观察环境，也不把恢复历史等同于重复操作。它只处理这个特定的尾部缺口，不代表能自动修复任意损坏的文件或任意历史结构。

### 3.7 Session 保存了什么，没有保存什么

| 当前保存或可恢复 | 当前没有完整持久化 |
| --- | --- |
| 完成的对话消息与工具结果 | 进行中的每个 token、每条进度事件 |
| 模型、思考级别、启用工具名称 | 工具的 Python 实现与运行中的协程 |
| 分支关系、当前 leaf、压缩结果 | steering / follow-up 的全部待消费队列 |
| 重建上下文所需的历史条目 | 完整运行 checkpoint、自动断点续执行 |

system prompt、工作目录和技能集合主要由恢复时的宿主选项重新组装，也不能只靠消息文件推断出原来整个进程环境。

<a id="ch04"></a>

## 第四章：Compaction——在有限窗口内保持继续工作的能力

### 4.1 为什么需要管理上下文

Agent 会不断积累文件内容、工具输出、模型回复和用户补充要求。即使会话存储可以无限增长，一次模型请求的输入窗口仍然有限，还要为输出留出空间。

直接删除最早消息虽然简单，但可能丢掉关键约束，例如“只允许改测试环境”或“某个方案已经失败”。保留全部内容又会增加输入体积，并最终遇到窗口限制。

压缩的目标是把旧信息转化为更短的工作摘要，同时保留最近的细节，让模型具备继续决策所需的信息。

### 4.2 为什么压缩策略放在 Harness

不同产品对上下文有不同要求。编码任务要保留文件路径和修改结果，客服任务可能要保留订单信息和用户确认，另一种应用也可能完全不允许摘要化。

因此，循环提供“请求前准备”的时机，Harness 决定是否压缩，Compaction 模块执行切割与摘要。这样循环可以被不同策略复用。

循环仍然需要知道准备后的新上下文是什么，否则下一次模型调用还会发送旧历史。所以扩展点不只是发一个通知，还必须允许返回替换后的上下文。

### 4.3 为什么是 prepare_request，而不是只用 prepare_next_turn

`prepare_next_turn` 只在一轮完成后、确实准备继续时运行。它覆盖不了首次请求前已经很长的恢复历史。

此外，steering 或 follow-up 可能带入一大段新文本。如果在这些消息注入以前就完成预算检查，实际发送时仍可能超出预期。

当前 Harness 接在 `prepare_request` 上，时机是：**本次待处理消息已经加入上下文，模型请求还没有发出。** 首轮和后续轮次都经过这个边界。

这是面试中值得重点说明的一个设计细节：选择扩展点时，应依据它能看到的状态是否完整，而不只是函数名字是否看起来合适。

### 4.4 触发阈值和保留预算分别解决什么问题

设模型窗口为 W，输出预留为 R，当前估算输入为 T。当前阈值规则可以写成：

```text
实际预留 = min(R, W // 2)
触发阈值 = W - 实际预留
T >= 触发阈值时，尝试自动压缩
```

例如窗口为 100000、预留为 16000，则约在估算输入达到 84000 时尝试压缩。小窗口限制预留不超过一半，是为了避免默认预留比整个模型窗口还大。

`keep_recent_tokens` 的作用不同：它决定切割时希望保留多少最近消息。一个控制什么时候开始整理，另一个控制哪些内容尽量保持原样。

这不是压缩后长度的硬保证。消息按整体保留，最近一条消息可能很长；工具调用与结果又不能随意拆开，所以实际保留量可能超过设定值。

### 4.5 为什么工具调用与结果不能拆开

若只保留工具结果，模型可能看不到它对应的调用；若只保留调用，模型又可能面对一个没有结果的操作。

当前切割逻辑从尾部累计预算，当切割点落在工具结果上时，向前移动以带上对应的调用区域。它适用于正常组织的调用与结果序列，不是对任意损坏历史的通用修复器。

```text
较早消息：用户目标、旧分析、旧工具观察   → 生成摘要
最近消息：assistant 工具调用 + 对应结果 → 一起保留
后续输入：当前仍需处理的消息             → 保留并继续处理
```

### 4.6 为什么摘要生成成功后才能提交

压缩至少分成三个阶段：

1. 根据旧消息生成候选摘要，原始上下文暂时保留。
2. 检查摘要是否成功、非空，以及操作是否已取消。
3. 写入压缩条目，再用 Session 重建后续上下文。

如果在摘要请求之前就清空旧历史，一旦请求失败就会丢失继续任务所需的信息。当前实现将候选生成与提交分开，失败时保留原始消息；这是局部的提交边界，不是全局事务。

模型生成摘要仍有误差，不能保证保留全部语义。原始历史仍留在 Session 中，提供回溯依据，而不是随着摘要成功就被删除。

### 4.7 当前估算与压缩的能力边界

自动检查使用字符、非 ASCII 字符和图片的启发式估算，也计入 system prompt 和工具声明。它没有接入精确 tokenizer。模块虽然提供读取 usage 的辅助函数，当前 Harness 的自动判断仍主要使用估算，而不是完整的 usage 校准方案。

另外，摘要请求本身也有窗口限制。如果积累的待总结内容已经太长，不能假设“再发一次摘要请求”一定可以解决。分层摘要或分块总结是后续方向。

当前会在触发压缩后的路径上，再检查剩余估算输入与输出预算。如果仍然过大，就结束请求并提示减少输入或工具输出。关闭自动压缩时，这段检查也不会自动变成另一套独立的硬预算保护。

### 4.8 面试时怎样描述压缩

> 我把长期保存的历史和下一次模型请求的上下文分开。每次请求前先检查预算，旧信息可以摘要化，最近消息和工具调用关系尽量保留。摘要成功后才提交新的上下文，同时保留原始历史用于追溯。当前计数是启发式，压缩也有信息损失，所以还需要实际任务评估，不能只看 token 是否减少。

<a id="ch05"></a>

## 第五章：Skills 与 Hooks——怎样扩展能力而不持续修改循环

### 5.1 Tool、Skill、Hook 是三种不同的扩展方式

| 机制 | 提供什么 | 典型例子 |
| --- | --- | --- |
| Tool | 可实际执行的能力 | 读取文件、运行命令、查询数据库 |
| Skill | 面向某类任务的说明、步骤和资源位置 | 代码审查流程、项目约定 |
| Hook | 宿主介入运行流程的时机 | 参数执行前检查、请求前压缩 |

Skill 可以指导模型怎样组合工具，但技能文件本身不会因为被发现就自动执行其中的命令。Hook 是宿主提供的回调，也不是模型自主生成的一段可执行代码。

### 5.2 为什么技能采用“目录先展示，正文按需读取”

如果把所有技能全文都放进 system prompt，即使大多数技能与当前任务无关，也会长期占据上下文。

发现阶段实际会读取并解析整个技能文件，将 frontmatter、正文和绝对路径保存为内存中的 `Skill` 对象；但 system prompt 只投影名称、描述和文件位置，不注入正文。模型判断有用时，可以通过 `read` 再从该位置读取全文。显式 `invoke_skill()` 则直接把内存中的技能正文和补充要求加入本次用户输入。

这种设计把“发现有哪些知识”与“加载具体知识”分开，降低普通请求的上下文负担。若宿主禁用了文件读取能力，就需要改用显式调用或提供另一种加载方式。

### 5.3 Skill 是怎样被发现并建立索引的

这里的“索引”不是向量数据库、embedding 或全文倒排索引，而是一次**文件系统扫描 + 元数据目录投影**。主 Runtime 在启动、切换 cwd 和 `/reload` 时由 `ResourceLoader` 生成一份资源快照，链路如下：

```text
用户 ~/.foxcode/skills
        +
受信任项目 <cwd>/.foxcode/skills
        +
显式 ResourceProvider 返回的 Skills
        │
        ▼
递归发现 SKILL.md / 根级 .md
        │
        ▼
解析 frontmatter、校验 name/description、保存正文和绝对路径
        │
        ▼
按 name 去重，得到 list[Skill]
        │
        ├─ 自动发现：name + description + location → system prompt
        └─ 显式调用：按精确 name 查找 → 正文 → 本轮用户消息
```

`load_skills_from_dir()` 对每个目录使用两阶段规则：

1. 先按字典序读取目录项。如果当前目录直接包含 `SKILL.md`，就加载它并停止扫描该目录的其他文件和子目录；一个技能目录因此形成一个边界。
2. 如果没有 `SKILL.md`，跳过隐藏条目和 `node_modules`，继续递归子目录。只有最初传入的技能根目录会把直接位于根级的普通 `*.md` 当作候选；更深层的普通 Markdown 不会被自动当作技能。

普通根级 `*.md` 必须在 frontmatter 中声明非空 `description`，否则会静默跳过。`SKILL.md` 缺省 `name` 时使用其父目录名；名称必须是最长 64 字符的 kebab-case，描述最长 1024 字符。解析、读取、校验和目录遍历错误会进入 diagnostics，不会产生半有效 Skill。扫描还用解析后的真实路径记录已访问目录，避免符号链接环导致无限递归。

主 Runtime 的覆盖顺序是用户级 < 项目级 < `ResourceProvider`，同名时后加载者覆盖，并记录诊断；未受信任项目不会扫描项目 Skill。较低层的 `load_skills(LoadSkillsOptions)` 是另一条可独立使用的 API，它支持显式路径，并采用“先加载者胜出、后续同名项记 collision”的规则。区分这两条入口很重要：CLI/Runtime 通常走 `ResourceLoader`，直接构造 `AgentSession` 且不传 `skills` 时才会使用 `load_skills()` 自动发现。

索引是内存快照，没有常驻数据库、文件监听器或增量更新。修改文件后需要 `/reload` 或重建 Runtime；重载只有在新资源和会话候选都构造成功后才替换旧快照。

### 5.4 “检索”是怎样发生的

自动路径中，`format_skills_for_prompt()` 把可见技能格式化成 `<available_skills>` XML，每项只含 `name`、`description` 和 `location`。只有启用了 `read` 工具，这个目录才会被 `build_system_prompt()` 加入 system prompt。随后由模型根据当前任务与 description 的语义匹配决定是否读取某个 `location`；这里没有独立的相似度计算、top-k 召回或重排器，因此结果依赖模型判断，不能表述成确定性的语义检索系统。

显式路径中，CLI 的 `--skill NAME`、交互命令 `/skill NAME [args]` 或 SDK 的 `invoke_skill(name, instructions)` 使用完整、区分大小写的名称查找当前 `list[Skill]`。找到后，`format_skill_invocation()` 把缓存正文、技能位置、相对引用基准目录和附加要求一起注入用户消息；找不到就报 `Unknown skill`。这个路径不要求启用 `read`。

`disable-model-invocation: true` 只把技能从 `<available_skills>` 目录中排除，不会从内存集合删除，所以用户仍可按名称显式调用。换言之，当前实现有两个很小的“索引面”：给模型看的元数据目录，以及给显式调用使用的名称集合；它没有对 Skill 正文建立搜索索引。

### 5.5 技能不是权限系统

`disable_model_invocation` 在当前实现中主要影响技能是否出现在自动展示的目录中；显式调用仍然可以使用该技能。它不等于对文件访问施加了隔离。

技能文本、读取的文件和命令输出都可能影响模型决策，因此工具权限应在可执行边界实施，不能只依赖一段“请不要执行危险操作”的提示词。

### 5.6 关键 Hook 的时机

| 扩展点 | 时机 | 可以解决的问题 |
| --- | --- | --- |
| `prepare_request` | 消息注入后、每次模型请求前 | 上下文预算、压缩、请求准备 |
| `prepare_next_turn` | 已有一轮完成且确实继续时 | 调整后续上下文、模型或思考级别 |
| `transform_context` | 形成模型输入之前 | 请求侧筛选、上下文变换 |
| `convert_to_llm` | 转成模型层消息的边界 | 自定义消息映射 |
| `get_api_key` | 模型请求边界 | 动态解析凭据 |
| `before_tool_call` | 参数准备后、实际执行前 | 权限检查、阻止执行 |
| `after_tool_call` | 适用的结果处理阶段 | 修改内容、详情、错误标记或终止提示 |
| `should_stop_after_turn` | 当前轮次完成后 | 宿主要求提前停止 |

这张表描述内核与 Agent 的扩展面。当前 `AgentSessionConfig` 只直接暴露其中一部分，其余能力可以使用较低层的 Agent 接口或扩展 Harness，不能假设每个选项都能原样传给所有层。

`after_tool_call` 也不是无论发生什么都执行的 finally 钩子，例如取消或参数校验未完成时，不一定进入它。资源释放仍应放在工具自身的清理路径中。

### 5.7 上下文变换与历史修改不能混为一谈

某次请求不发送一条消息，不代表应该从会话历史删除它。请求侧变换解决“模型这一轮看到什么”，Session 修改解决“历史保存什么”，两个动作的后果不同。

当前消息对象也不是完全不可变的。编写变换 Hook 时，最好返回需要的新列表或新对象，避免意外原地修改多个层共享的数据。

### 5.8 为什么先使用小接口，而不是直接做复杂插件系统

这个 mini 版本的主要扩展需求可以由工具协议、可替换流函数和少量生命周期回调覆盖。直接引入插件市场、动态模块加载、版本依赖管理和插件隔离，会增加一整套与 Agent 闭环不同的问题。

比较合理的演进方式是先稳定消息、工具和事件契约。当确实出现多方分发、独立升级和隔离运行需求时，再把这些接口组织成插件系统。

<a id="ch06"></a>

## 第六章：Extensions


扩展是提供同步 `setup(api)` 函数的 Python 文件、可导入模块或已安装包 entry point。它可以注册：

| API | 作用 |
| --- | --- |
| `register_tool(tool)` | 注册实现 AgentTool 协议的工具 |
| `register_command(name, handler, description)` | 注册 CLI 命令；也可由 SDK 调用 |
| `add_prompt_guideline(text)` | 补充 system prompt 规则 |
| `on(event, handler)` | 订阅 Agent/Compaction 事件和宿主钩子 |
| `register_service(name, service)` | 注册供扩展协作的进程内服务 |
| `register_context_transform(name, fn)` | 只转换本次模型请求的消息副本 |

handler 支持同步或异步，签名为 `(data, context)`；`context.cwd` 是所属项目，`context.user_dir` 是用户级 `.foxcode` 目录，`context.project_trusted` 表示项目信任状态，`context.session` 提供当前会话。`context.active_tools`、`activate_tools()` 与 `add_runtime_tools()` 是扩展操作模型工具集的稳定边界，动态发现工具不需要了解 AgentSession 内部结构。Agent/Compaction 事件的 data 是事件对象；`before_prompt`、`tool_call`、`tool_result`、`session_start`、`session_shutdown` 的 data 是字典。

`before_prompt` 可返回 `{"message": "替换后的输入"}`；`tool_call` 可返回 `{"block": True, "reason": "原因"}`；`tool_result` 可补充或替换 content/details/is_error 等结果字段。普通事件只用于观察，返回值不改变核心循环。宿主传入的工具阻止策略先执行，扩展不会使已阻止的工具真正执行。

`session_start` 在该 Harness 首次执行任务或命令前触发，`session_shutdown` 在使用过的 Harness 关闭或切换前触发。事件回调应避免直接启动同一宿主的另一次运行；需要新任务时，由外部调用方调度，或使用现有 steering/follow-up 队列。

扩展通过 `settings.json` 的 `extensions` 数组或 SDK 参数显式加载，例如：

```json
{
  "extensions": [
    "extensions/project_info.py",
    "module:fox_coding_agent.src.extensions.memory:setup",
    "entrypoint:company-tools"
  ]
}
```

文件相对路径以该 settings.json 所在目录为基准，因此上例对应 `.foxcode/extensions/project_info.py`。`module:<package>[:callable]` 显式导入可安装模块，省略 callable 时使用 `setup`；`entrypoint:<name>` 从 Python 包元数据的 `foxcode.extensions` group 加载唯一同名入口。第三方包只需在自己的 `pyproject.toml` 声明入口，FoxCode 核心无需增加 import、设置字段或包目录。扩展是具有进程权限的 Python 代码，不是隔离执行的 Skill；本版不会扫描并自动执行所有项目 `.py` 文件或所有已安装 entry point。

第三方包的声明示例：

```toml
[project.entry-points."foxcode.extensions"]
company-tools = "company_fox_extension:setup"
```

安装该包后，在 settings 中写入 `"entrypoint:company-tools"` 即可显式启用；删除该项并 `/reload` 即停用。扩展自己的业务配置由扩展读取，不向 `RuntimeSettings` 增加专用字段。

完整可运行示例见 [project_info.py](../../examples/extensions/project_info.py)。它添加 word_count 工具、project-info 命令和一个文件工具 Hook：

```powershell
uv run fox --command project-info
uv run fox --interactive
```

`/reload` 会重新编译显式扩展文件并重建全部模块/entry point 注册表，避免重复事件处理器。加载失败保留当前 AgentSession。当前支持单文件、模块入口、Python package entry point 和 SDK 工厂；不包含插件市场、包安装、Provider 扩展或自定义 UI 组件协议。

<a id="ch07"></a>

## 第七章：CLI 与未来 UI


```powershell
uv run fox --trust-project --interactive
# settings.json 的 extensions 中加载 Memory 后：
uv run fox --trust-project --permission workspace-modify --interactive
uv run fox --resume --interactive
uv run fox --resume --compact
uv run fox -p "梳理项目结构"
uv run fox --skill release-audit -p "检查开发环境"
uv run fox --template review -p "src/module.py"
```

连续对话提供 `/new`、`/resume 文件`、`/fork [条目 ID]`、`/cwd 目录`、`/reload`、`/trust`、`/untrust`、`/permission`、`/compact`、`/usage`、`/export`、`/tools`、`/model`、`/thinking`、`/skill 名称`、`/prompt 名称` 和扩展命令。加载 Memory 扩展时还会注册 `/memory`。`/tools none` 禁用工具；`/help` 显示可用命令；`/exit` 结束。当前每次任务等待完成后打印最终回复，Ctrl+C 结束 CLI；没有实现终端组件、复杂键盘交互或 TUI。

非交互 JSON 模式继续保留稳定的逐行事件输出，扩展命令返回 `command_result`。普通扩展 print 被导向 stderr；扩展若直接写文件描述符或启动自己的后台任务，需自行遵守宿主输出和资源清理约定。

未来 UI 可以直接创建 AgentSessionRuntime、调用 prompt/compact/reload，并通过 subscribe 消费事件，不需要调用 CLI 或重写 Agent 循环。

<a id="ch08"></a>

## 第八章：职责、源码与面试表达

### 8.1 一次任务怎样贯穿宿主

CLI 解析参数，Runtime 选定 cwd 与 Session，再由 Settings 和 Resources 决定模型、工具、项目指令与扩展。AgentSession 用 SessionManager 重建 Agent 上下文，每次请求前检查压缩预算，完成消息到达后保存。工具结果推动下一轮模型请求；CLI 订阅事件或等待最终回复。

`Runtime` 管理“当前是哪一个 AgentSession”，`AgentSession` 管理“这个会话如何运行与保存”。切换项目需要重建 cwd 绑定的工具，不能只修改字符串；恢复 Session 恢复的是历史状态，无法恢复进程退出前的协程。加载失败保留旧 AgentSession，但已取消的旧任务不会自行重启。

### 8.2 源码地图

| 文件 | 要理解的职责 |
| --- | --- |
| [runtime.py](src/core/runtime.py) | 会话/cwd 切换、重载、扩展生命周期 |
| [agent_session.py](src/core/agent_session.py) | Agent、持久化、压缩与安全恢复的组装 |
| [session_manager.py](src/core/session_manager.py) | 历史树、JSONL、统计、导出和上下文重建 |
| [compaction.py](../fox_agent_core/src/harness/compaction.py) | 通用估算、切割和摘要生成 |
| [settings.py](src/core/settings.py) | 配置优先级与原子写入 |
| [model_config.py](src/core/model_config.py) / [model_registry.py](src/core/model_registry.py) | 模型目录、归一化和选择 |
| [credentials.py](src/core/credentials.py) / [model_runtime.py](src/core/model_runtime.py) | 凭据持久化与请求时认证 |
| [resources.py](src/core/resources.py) / [skills.py](src/core/skills.py) | 项目知识的发现与组织 |
| [tools.py](src/core/tools.py) / [system_prompt.py](src/core/system_prompt.py) | 执行能力与提示词的一致性 |
| [extensions.py](src/core/extensions.py) | 注册工具、命令和钩子 |
| [extensions/memory](src/extensions/memory) | 项目记忆存储、工具、召回与命令 |
| [cli.py](src/cli.py) | 命令行参数、连续对话、JSON 和退出码 |

### 8.3 面试中避免夸大能力

“我参考 pi 的分层，把项目策略放在 coding-agent，而不写进通用 loop。工具提供执行能力，Skill 提供方法，system prompt 组织上下文，Hook 执行宿主限制。Session 保存历史树，压缩生成模型可消费的工作视图，Runtime 保证切换会话时 cwd、工具和资源同步变化。”

当前是单进程、单写入者的 mini 实现，没有完整 TUI、插件市场、OS 沙箱或 exactly-once 保证。JSONL 使用全文件原子替换；压缩使用估算预算，摘要成功后才提交，无法保证任何长度的输入都能缩到窗口内。未来 UI 复用 Runtime 的调用与订阅接口，无需重新实现循环。


<a id="ch09"></a>

## 第九章：Memory、MCP 与自进化 Skill 应该怎样加入

### 9.1 先判断它是机制、宿主能力还是扩展

遵循 pi 的核心思想：稳定、通用的执行机制放底层，具有产品策略和外部副作用的能力放 coding-agent 扩展。

| 能力 | 推荐位置 | 不放入 agent loop 的原因 |
| --- | --- | --- |
| Memory 的存储、检索、写入策略 | `fox_coding_agent/src/extensions/memory/` | 记什么、存多久和作用域都是产品策略 |
| MCP server 生命周期与工具代理 | `fox_coding_agent/src/extensions/mcp/` | 涉及进程、网络、凭据、信任和动态资源 |
| Skill 候选生成、评估与发布 | `fox_coding_agent/src/extensions/skill_evolution/` | 会写文件并改变以后行为，需要审核与版本管理 |
| 通用服务注册、请求上下文变换、事件 | `core/extensions.py` | 这是多个扩展共享的稳定协议 |
| ToolCall 调度、取消、消息事件 | `fox_agent_core` | 是所有 Agent 都需要的执行机制 |

扩展目录按能力组织：

```text
fox_coding_agent/src/
├─ core/extensions.py              # Extension API 与 Runner
└─ extensions/
   ├─ memory/                      # MemoryStore、retriever、extension setup
   ├─ mcp/                         # MCPManager、server config、tool proxy
   └─ skill_evolution/             # candidate/evaluator/publisher
```

这些模块通过 `setup(api)` 注册，不让 `fox_agent_core` 反向依赖它们。

### 9.2 Memory：已实现为策略化可选扩展

当前实现位于 `src/extensions/memory/`，通过 `extensions` 中的模块入口显式启用。它采用四个核心选择：项目路径映射到独立目录、正文使用人可读 Markdown、`MEMORY.md` 作为派生索引、模型请求前按需召回。FoxCode 对边界做了进一步收紧：

- 记忆统一保存在 `~/.foxcode/projects/<project-hash>/memory/`，不会向用户项目写入额外知识文件。
- Markdown 条目是事实来源，`MEMORY.md` 随 CRUD 重建；文件名、类型、字段长度、条目数和路径都经过校验。
- 模型只看到 `memory_remember`、`memory_recall`、`memory_forget` 三个意图工具；list/read 等存储 CRUD 留在 `MemoryStore` 和 `/memory` 人工审计命令中。
- 写入先经过 schema、敏感信息、重复与 topic 冲突检查；新事实可保留旧值并把它标记为 `superseded`，限时事实使用 `expiresAt`。
- 召回严格限制为三个可解释信号：Contextual BM25F、Auditable Concept Graph 和 Temporal Truth Arbitration；阈值与相对置信带只负责拒答和候选选择，不额外堆叠相关性分数。
- `pinned user/feedback` 是自动注入的 ambient policy，不污染显式搜索结果；expired/superseded 条目不会进入正常召回。
- 只有 trusted 项目可以读写或召回。召回文本明确标记为历史观察，要求模型用当前文件验证项目事实。
- context transform 深拷贝最后一条用户消息，只修改本次模型请求；注入经过字符预算、相关片段截取和 XML 转义，召回正文不会写回 JSONL Session。

```text
session_start
    └─ MemoryService.bind(user_dir, cwd, trust, session_id)

用户输入 ── context transform ── MemoryStore.search ── 请求副本 ── 模型
   │                                                        │
   └──────────────── 原始消息写入 Session ──────────────────┘

模型 ── remember / recall / forget ── Markdown + MEMORY.md
用户 ── /memory list/search/read/delete/dir ──┘
```

扩展注册 `memory.store` 服务供其他扩展协作，同时只向模型注册 `memory_remember`、`memory_recall`、`memory_forget`。`memory_recall` 返回带 provenance 和三信号分解的预算化 excerpt，不返回最多 20K 的完整正文；完整 list/read 只保留在 `/memory` 命令。默认自动召回最多 3 条、注入 12000 字符，模型主动 recall 的正文总预算为 6000 字符，可以在 SDK 中传入配置：

```python
from fox_coding_agent.src import AgentSessionRuntime
from fox_coding_agent.src.extensions.memory import MemoryExtensionConfig, create_memory_extension

runtime = AgentSessionRuntime(
    ".",
    extension_factories=(create_memory_extension(
        MemoryExtensionConfig(
            max_recall=5,
            max_injected_chars=16000,
            max_tool_recall_chars=8000,
        )
    ),),
)
```

这里不自动从每轮对话提取并永久保存内容。写入必须是模型对 `memory_remember` 的显式工具调用；工具返回可观察的 `accepted/action/reasons/superseded` 决策，并禁止保存凭据。用户可以用 `/memory` 检查和删除。完整的字段、评分原因、50/120 golden set、消融结果和复现命令见 [Memory v2 设计文档](src/extensions/memory/MEMORY_DESIGN.md)。

### 9.3 MCP：连接管理器不是一个巨型工具

当前实现位于 `extensions/mcp/`，注册 `mcp.manager` 服务。每个远端 tool 映射成普通 `AgentTool` proxy，内核继续使用现有参数校验、事件、权限和取消逻辑。Manager 负责 stdio 连接、协议协商、分页能力发现、超时与关闭；proxy 只把一次 `execute()` 转给目标 server。

配置分两层：`~/.foxcode/mcp.json` 保存用户 server，项目 `.foxcode/mcp.json` 保存项目 server。项目配置必须经过 trust；凭据使用环境变量引用，不写进 Session。扩展在异步 `session_start` 中完成连接和发现，再通过 `ExtensionContext.add_runtime_tools()` 注入不持久化的动态 proxy；`session_shutdown` 关闭整个进程组。当前边界只覆盖 stdio tools，HTTP/OAuth、resources、prompts、sampling、elicitation、tasks 与 Apps 尚未实现。完整配置与安全约束见 [MCP 设计文档](src/extensions/mcp/MCP_DESIGN.md)。

### 9.3.1 子 Agent：隔离上下文，继承能力上限

`extensions/subagent/` 注册 `subagent.manager` 服务和一个 `agent` 工具。每次调用创建独立的内存 Session，只继承父会话的模型、认证流、工作目录、思考级别和已启用工具，不复制父对话。`explore` 与 `plan` 固定只读工具集，`general` 使用父工具但排除 `agent`，自定义 Markdown profile 可进一步白名单；每个子工具调用仍重新经过父权限模式检查。项目 profile 只有在项目受信时加载。完整格式见 [子 Agent 设计文档](src/extensions/subagent/SUBAGENT_DESIGN.md)。

### 9.4 自进化 Skill：生成候选，不自动覆盖生效 Skill（设计草案）

**当前仓库尚未实现 `extensions/skill_evolution/`。** 推荐的自进化流程应拆成四步：观察运行事件 → 生成候选 → 离线评估/人工审核 → 发布。扩展监听 Session 与工具结果，从成功或失败模式生成候选文件：

```text
~/.foxcode/skill-candidates/<candidate-id>/SKILL.md
<project>/.foxcode/skill-candidates/<candidate-id>/SKILL.md
```

通过测试和审核后，再由 publisher 原子复制到 `skills/<name>/SKILL.md`，写入版本、来源 Session 和评估结果，然后触发 `/reload`。项目级发布受 trust 控制。不要让当前运行中的模型直接覆盖正在使用的 Skill，否则一次提示注入或错误总结会永久改变 Agent 行为，也难以回滚。

### 9.5 扩展之间怎样协作

`ExtensionAPI.register_service()` 发布进程内能力，`ExtensionContext.service()` 供其他扩展查找；`register_context_transform()` 只改变发给模型的请求副本；Tool 用于模型可主动调用的动作；event hook 用于观察生命周期。

这四种接口分别解决依赖注入、上下文增强、可执行能力和事件观察。Memory、MCP、自进化 Skill 可以独立安装，也可以通过服务注册表协作，而 agent loop 始终只看到标准消息与标准工具。

<a id="ch10"></a>

## 第十章：从零运行一次完整流程

这一章只使用当前已经实现的能力。目标是完成模型配置、首次运行、项目资源、长期记忆与 Session 恢复，并知道每一步写到了哪里。

### 10.1 环境与安装

仓库要求 Python 3.14+，并使用 uv workspace 管理三个本地包。在仓库根目录执行：

```powershell
uv sync
uv run --with pytest pytest -q
uv run fox --help
```

`uv run fox` 来自 `packages/fox_coding_agent/pyproject.toml` 的 console script。开发时不需要进入某个子包单独安装；根目录的 workspace 会把三个包连在一起。

### 10.2 准备模型、凭据和默认模型

先在用户目录创建三个相互独立的文件。Windows 默认目录是 `C:\Users\<用户名>\.foxcode\`，其他系统默认是 `~/.foxcode/`。

`models.json` 保存公开的模型元数据：

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "models": [
        {
          "id": "deepseek-v4-flash",
          "name": "DeepSeek V4 Flash",
          "contextWindow": 1000000,
          "maxTokens": 384000,
          "input": ["text"],
          "reasoning": true,
          "thinkingLevelMap": {
            "minimal": "high",
            "low": "high",
            "medium": "high",
            "high": "high",
            "xhigh": "max"
          },
          "compat": {"thinkingFormat": "deepseek"}
        }
      ]
    }
  }
}
```

`auth.json` 只保存凭据：

```json
{
  "deepseek": {
    "type": "api_key",
    "key": "替换为真实密钥"
  }
}
```

`settings.json` 选择默认模型；这里只需写覆盖默认值的字段：

```json
{
  "model": "deepseek/deepseek-v4-flash"
}
```

然后验证目录并开始会话：

```powershell
uv run fox --list-models
uv run fox --trust-project --interactive
```

首次使用某个项目时，`--trust-project` 会把规范化后的项目路径写入用户级 `trust.json`。后续可以省略这个参数；如果目录被移动，它会被视为另一个项目，需要重新决定是否信任。

### 10.3 观察一次请求写入了什么

新会话统一保存在用户级 `~/.foxcode/sessions/--<normalized-cwd>--/session-<uuid>/session.jsonl`。空白草稿不会创建目录，第一条消息提交时才落盘。文件第一行是 metadata，后续是模型切换、thinking level、启用工具和消息等条目。可以依次执行：

```text
/usage
/export session.md
/export session.json
/exit
```

Markdown 导出当前活动分支，适合阅读；JSON 导出完整树、当前 leaf、usage 和所有条目，适合检查分支。两者都是显式导出，不会包含 `auth.json` 中的密钥。

重新进入时：

```powershell
uv run fox --resume --interactive
uv run fox --resume -p "继续刚才的任务"
```

不带路径的 `--resume` 选择当前工作区用户级目录下修改时间最新的 JSONL。指定具体文件时，Runtime 以文件 metadata 中的 cwd 为准，而不是盲目沿用当前终端目录。

### 10.4 加入项目指令、Prompt 与 Skill

可以创建如下项目资源：

```text
<project>/
├─ AGENTS.md
└─ .foxcode/
   ├─ SYSTEM.md
   ├─ APPEND_SYSTEM.md
   ├─ prompts/
   │  └─ review.md
   └─ skills/
      └─ release-audit/
         └─ SKILL.md
```

Prompt 模板是显式调用的文本模板，例如：

```markdown
---
description: 审查指定文件
---
请审查 $ARGUMENTS，重点检查正确性和回归风险。
```

调用方式：

```powershell
uv run fox --template review -p "src/module.py"
```

Skill 必须提供有效 frontmatter：

```markdown
---
name: release-audit
description: 发布前检查版本、测试和变更记录
---

1. 阅读项目发布约定。
2. 运行相关测试。
3. 汇总阻塞项，不自动发布。
```

调用方式：

```powershell
uv run fox --skill release-audit -p "检查当前分支"
```

修改资源后，在交互会话使用 `/reload`。重载采用候选对象先构建、成功后替换的方式；解析失败会报告错误并保留旧 Runtime。

### 10.5 验证长期记忆

Memory 不是默认能力，必须在每次启动时显式加载：

```powershell
uv run fox --trust-project --permission workspace-modify --interactive
```

然后输入“请记住：默认用中文回答，代码注释也使用中文”。只有模型实际调用 `memory_remember` 后才完成持久化；一句普通的“我记住了”不能作为保存成功的证据。使用以下命令验证：

```text
/memory list
/memory dir
```

再新建一个同项目、同样加载 Memory 的会话询问偏好。召回内容只注入本次请求副本，不会复制进 Session JSONL。Memory 的状态读写独立于三档工作区权限；若没有条目，依次检查：`extensions` 是否包含 Memory 入口、项目是否 trusted、模型是否真的发出了 `memory_remember` 工具调用。

### 10.6 最小验收清单

- `uv run fox --list-models` 能列出 `provider/model`。
- 提交首条消息后能生成用户级 `sessions/--<normalized-cwd>--/session-*/session.jsonl`，其中没有 API key。
- `/tools` 与 system prompt 中的工具列表一致。
- `/reload` 后新的 AGENTS、Prompt、Skill 或扩展生效。
- `/export` 能导出当前会话，`/usage` 能汇总当前活动分支。
- 启用 Memory 后，`/memory list` 能看到由 `memory_remember` 创建的条目。
- `uv run --with pytest pytest -q` 通过后，再把改动交给其他入口或 UI。

<a id="ch11"></a>

## 第十一章：配置、资源与命令参考

### 11.1 settings.json 完整字段

用户文件与可信项目文件使用同一结构。对象字段递归合并，列表和标量整体覆盖；未知字段直接报错。

| 字段 | 类型与默认值 | 作用 |
| --- | --- | --- |
| `model` | `string \| null` | `models.json` 中的 `provider/model` 引用 |
| `system_prompt` | `string \| null` | 完整替换默认 system prompt 前缀 |
| `append_system_prompt` | `string`，默认空 | 在基础规则之后追加文本 |
| `api_key_env` | `string \| null` | 指定本次运行读取的密钥环境变量名 |
| `stream_options` | object，默认 `{}` | 请求选项，例如 `max_tokens`、`timeout_ms`、采样参数 |
| `compaction.enabled` | boolean，默认 `true` | 是否自动压缩；手动 `/compact` 不受它限制 |
| `compaction.reserve_tokens` | integer，默认 `16384` | 为输出预留的窗口空间 |
| `compaction.keep_recent_tokens` | integer，默认 `8000` | 压缩时尽量原样保留的近期消息预算 |
| `tools` | `string[] \| null` | `null` 使用平台默认；空数组禁用；名称必须唯一且存在 |
| `extensions` | `string[]`，默认空 | 显式加载扩展文件、`module:` 模块或 `entrypoint:` 包入口 |
| `permission_mode` | `read-only` / `workspace-modify` / `full-access` | 工作区与系统工具权限；默认 `full-access` 以保持 SDK 兼容，`extension-state` 独立于此模式 |
| `execution_mode` | `local` / `sandbox` | 工具执行边界；沙盒限制项目路径，并只在原生进程后端可用时开放 shell |
| `max_turns` | 正整数，默认 `100` | 一次 Agent 操作的最大轮数 |
| `model_retry_attempts` | `0..5`，默认 `1` | 对可安全重试的空响应错误最多恢复几次 |
| `tool_execution` | `parallel` / `sequential` | 同一轮多个工具调用的执行策略 |

示例：

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "stream_options": {
    "max_tokens": 8192,
    "timeout_ms": 120000
  },
  "compaction": {
    "enabled": true,
    "reserve_tokens": 16384,
    "keep_recent_tokens": 8000
  },
  "tool_execution": "parallel",
  "permission_mode": "workspace-modify",
  "execution_mode": "sandbox",
  "extensions": ["module:fox_coding_agent.src.extensions.memory:setup"]
}
```

`settings.json` 不接受 API key，也不接受完整模型对象。用户级相对扩展路径相对于 `~/.foxcode/`，项目级相对路径相对于 `<project>/.foxcode/`。

### 11.2 模型选择、密钥与 thinking 映射

`models.json` 的 provider 层包含 `baseUrl`、`api` 与 `models`。模型条目的主要字段如下：

| 字段 | 要求与含义 |
| --- | --- |
| `id` | 必填，发送给 provider 的模型 ID |
| `name` | 可选展示名；省略时使用 `id` |
| `contextWindow` / `maxTokens` | 必须是正数；分别用于上下文预算与默认输出上限 |
| `input` | `text`、`image` 能力列表；默认空列表 |
| `reasoning` | 是否允许设置 thinking level；默认 `false` |
| `thinkingLevelMap` | 通用 thinking level 到 provider 值的稀疏映射，值也可以是 `null` |
| `cost` | 每百万 token 的 input/output/cache 费率；可带 `tiers` |
| `samplingParams` | OpenAI-compatible 请求体的模型级采样参数 |
| `headers` | 模型级附加 HTTP header；不要在可提交的目录中硬编码秘密 |
| `compat` | provider 协议差异开关；宽松接收，只有实现读取的键才有效 |

`auth.json` 以 provider ID 为键，只接受两种精确结构：API key 使用 `{"type": "api_key", "key": "..."}`；OAuth 使用 `{"type": "oauth", "access": "...", "refresh": "...", "expires": 0}`。项目目录没有第二份 auth 覆盖层。

模型选择优先级是：显式传给 Runtime/CLI 的模型 → Session 保存的模型快照 → settings 中的引用 → `models.json` 第一项。恢复 Session 时保存的快照优先，避免同名目录项更新后悄悄改变旧会话含义。

密钥解析顺序是：请求显式 `api_key`；否则如果配置了 `api_key_env`，只读取该环境变量；没有配置时再读取 `auth.json`，最后尝试已知 provider 的默认环境变量。配置了 `api_key_env` 但变量为空时不会继续回退到 `auth.json`。目录中的 provider endpoint 与当前模型 endpoint 不一致时，不会把该 provider 的已存凭据发送给陌生地址。

`thinkingLevelMap` 是稀疏覆盖表：

```python
provider_level = mapping.get(level, level)
```

`max` 可以作为 provider 原生映射值，例如 `xhigh: max`，但不是 CLI 可选的通用思考等级。`off` 在会话状态中转成 `None`。`thinkingFormat: deepseek` 会生成 `thinking.type` 与可选的 `reasoning_effort`；默认 `openai` 格式使用顶层 `reasoning_effort`。

当前实现没有读取 `requiresReasoningContentOnAssistantMessages`，把它写在 `compat` 中不会改变请求，可以删除。`compat` 是 provider 逃生口，不应为了“兼容”而复制未被代码消费的字段。

当前 provider 实际读取的兼容键可以从 [openai_provider.py](../fox_ai/src/providers/openai_provider.py) 和 [anthropic_provider.py](../fox_ai/src/providers/anthropic_provider.py) 查证。OpenAI-compatible 路径主要包括 `thinkingFormat`、`supportsReasoningEffort`、`thinkingTokenBudgetField`、`supportsStrictMode`、`supportsOpenAIGrammarTools`、`supportsFinishReason` 与 `vllmPriority`；Anthropic 路径主要包括 `forceAdaptiveThinking`、`supportsMidConvoEffort`、`allowedFallbackModels` 与 `supportsStrictTools`。添加其他键不会自动产生兼容行为。

### 11.3 资源发现与覆盖顺序

| 资源 | 位置与顺序 | 冲突/信任规则 |
| --- | --- | --- |
| System 前缀 | 内置 → 用户 `SYSTEM.md` → 项目 `.foxcode/SYSTEM.md` → ResourceProvider → `settings.system_prompt` | 后者替换前者；项目与祖先资源要求 trusted |
| 追加提示 | `settings.append_system_prompt`，再追加用户、项目和 provider 的 `APPEND_SYSTEM.md` | 全部串联，不做文本合并 |
| AGENTS | 用户 `~/.foxcode/AGENTS.md`，再从文件系统祖先到 cwd 的 `AGENTS.md` | 全部加入；项目链要求 trusted |
| Skill | 用户 `.foxcode/skills` → 项目 `.foxcode/skills` → ResourceProvider | Runtime 中同名后者覆盖；无 read 工具时不自动展示目录 |
| Prompt | 用户 `.foxcode/prompts` → 项目 `.foxcode/prompts` → ResourceProvider | 同名后者覆盖；只在显式调用时注入 |
| Extension | settings 路径 → SDK 显式路径 → SDK factory | Python 代码在加载时执行；项目 settings 在 untrusted 时不加载 |

Prompt 模板虽然在 untrusted 项目也可被发现，但它只做 `$ARGUMENTS` 字面替换，必须由用户显式调用。SDK `extension_paths` 是调用方的显式加载行为，不会因为目标项目 untrusted 就把 Python 代码变成沙箱执行。

### 11.4 CLI 参数

| 参数 | 作用 |
| --- | --- |
| `-p, --prompt TEXT` | 执行一次任务后退出；也作为 Skill、模板或扩展命令的附加参数 |
| `--interactive` | 进入纯文本多轮会话；TTY 且没有其他动作时自动进入 |
| `--resume [FILE]` | 恢复指定 Session；省略文件时恢复当前项目最近会话 |
| `--cwd DIR` / `--user-dir DIR` | 指定项目目录或用户配置目录 |
| `--model ID` | 临时选择 `models.json` 中的模型 |
| `--thinking LEVEL` | 设置初始 thinking level |
| `--permission MODE` | 临时覆盖 `settings.json` 的三档工具权限 |
| `--trust-project` / `--no-trust-project` | 记录项目信任决定 |
| `--compact` | 执行任务前手动压缩 |
| `--skill NAME` / `--template NAME` / `--command NAME` | 三种互斥的显式动作 |
| `--list-models` | 列出目录模型，不创建 Session |
| `--json` | stdout 使用逐行 JSON；诊断和普通扩展 print 走 stderr |

模型 endpoint、协议和能力写入 `models.json`；`api_key_env`、`stream_options`、`tools` 与 `extensions` 写入 `settings.json`，CLI 不再解析这些配置项。`--thinking` 和交互 `/thinking` 接受 `off|minimal|low|medium|high|xhigh`。

`--interactive` 不能与 `--json`、`-p`、`--command`、`--skill`、`--template`、`--list-models` 混用。`--list-models` 也不能和任务或 Session 动作混用。

### 11.5 交互命令

| 命令 | 行为 |
| --- | --- |
| `/new` | 在当前 cwd 创建新 Session |
| `/resume [FILE]` | 切换到指定或最近 Session |
| `/fork [ENTRY_ID]` | 从当前叶节点或指定条目创建新的持久化 Session 并切换 |
| `/cwd DIR` | 切换项目并创建独立 Session，重新计算 trust |
| `/reload` | 事务式重载配置、模型、资源和扩展 |
| `/trust`、`/untrust` | 更新信任决定并重建当前宿主 |
| `/permission [MODE]` | 查看或临时切换三档工具权限 |
| `/compact` | 手动生成摘要并持久化压缩点 |
| `/usage` | 显示当前活动分支的 token 和费用汇总 |
| `/export FILE` | 按 `.json` 或 `.md` 导出 |
| `/tools [names]` | 查看或切换工具；`none` 禁用全部 |
| `/model [reference]` | 查看目录或切换模型 |
| `/thinking [level]` | 查看或切换思考强度 |
| `/skill NAME [args]` | 显式注入 Skill 正文并开始一轮 |
| `/prompt NAME [args]` | 渲染 Prompt 模板并开始一轮 |
| `/memory ...` | 仅加载 Memory 扩展后存在 |
| `/help`、`/exit` | 查看帮助或退出 |

扩展注册的命令会动态加入 `/help`。保留命令名不能被扩展覆盖。

### 11.6 持久化位置

| 数据 | 默认位置 | 备注 |
| --- | --- | --- |
| 模型目录 | `~/.foxcode/models.json` | 不含密钥 |
| 凭据 | `~/.foxcode/auth.json` | provider 级凭据 |
| 用户策略 | `~/.foxcode/settings.json` | 低于项目配置优先级 |
| 信任决定 | `~/.foxcode/trust.json` | 规范化绝对路径到 boolean |
| 用户 Session | `~/.foxcode/sessions/--<normalized-cwd>--/session-<uuid>/session.jsonl` | 唯一会话位置；空白草稿不落盘 |
| 长期记忆 | `~/.foxcode/projects/<project-hash>/memory/` | 与 Session 生命周期分离 |

<a id="ch12"></a>

## 第十二章：SDK、事件、测试与排错

### 12.1 Runtime 最小 SDK 示例

下面的代码复用 `models.json`、`auth.json` 和 `settings.json`，因此不在源码中放密钥：

```python
import asyncio
from pathlib import Path

from fox_coding_agent.src import AgentSessionRuntime
from fox_coding_agent.src.extensions.memory import create_memory_extension


async def main() -> None:
    runtime = AgentSessionRuntime(
        Path.cwd(),
        project_trusted=True,
        extension_factories=(create_memory_extension(),),
    )

    def observe(event, cancel_event) -> None:
        print(event.type)

    unsubscribe = runtime.subscribe(observe)
    try:
        await runtime.prompt("阅读 README.md，概括项目结构")
        if runtime.state.error_message:
            raise RuntimeError(runtime.state.error_message)
        print(runtime.usage_totals)
    finally:
        unsubscribe()
        await runtime.close()


asyncio.run(main())
```

`AgentSessionRuntime` 是 CLI 和未来 UI 共用的宿主边界。它一次只允许一个前台操作；调用方应 `await` 当前任务完成，切换/重载时由 Runtime 负责取消旧 Agent、等待清理并持久化。`close()` 是终止操作，关闭后不能继续复用实例。

测试时应注入 `stream_fn` 和测试模型，避免真实 API 费用。仓库测试使用 Faux provider 或脚本化流；这比在单元测试里 mock 整个 Runtime 更能覆盖消息、工具和 Session 闭环。

### 12.2 事件层级与典型顺序

一次有工具调用的任务通常经历：

```text
agent_start
  turn_start
    message_start/update/end
    tool_execution_start/update/end
  turn_end
  ...下一轮...
agent_end
```

`message_update` 内部携带 fox_ai 的细粒度事件，包括 `text_*`、`thinking_*` 和 `toolcall_*`。编码宿主还会发出 `compaction_start/end/error`、`context_overflow_retry` 与 `model_retry`。Runtime 订阅者适合更新 UI 或日志；Extension `on()` 除了观察普通 Agent 事件，还能处理 `before_prompt`、`tool_call`、`tool_result`、`session_start`、`session_shutdown` 等宿主钩子。

事件不是 Session 的同义词。Session 持久化完成消息和配置变化，不保存每个 token delta 或每条工具进度；进程退出后不能靠 JSONL 恢复一条正在运行的协程。

### 12.3 扩展的最小骨架

```python
def setup(api):
    api.add_prompt_guideline("报告实际执行过的检查，不要声称未执行的命令。")

    def where(arguments, context):
        return {"cwd": str(context.cwd), "session": context.session.storage.get_metadata()}

    api.register_command("where", where, "显示当前扩展上下文")
```

`setup(api)` 必须同步完成注册；网络连接、异步初始化与清理应放进生命周期 handler。扩展是拥有当前 Python 进程权限的可信代码，不是安全沙箱。重新加载时 Runner 使用新的模块命名空间，并移除旧模块引用；扩展自己创建的外部进程或后台任务仍需自行清理。

### 12.4 测试地图

| 测试文件 | 主要覆盖 |
| --- | --- |
| `tests/test_runtime.py` | settings、资源优先级、切换/重载、取消、CLI JSON 与恢复 |
| `tests/test_coding_agent.py` | 文件工具、system prompt、扩展、命令、模板和压缩 |
| `tests/test_auth_models.py` | 模型目录、凭据隔离、thinking wire 格式 |
| `tests/test_memory_extension.py` | Memory CRUD、项目隔离、召回与 trust |
| `tests/test_harness_tools.py` | Harness、Skill、命令取消与 fork |
| `tests/test_architecture_refactor.py` | 分层边界、旧兼容入口移除、恢复和导出 |
| `tests/test_agent_core.py` | 底层 Agent loop、队列、工具调度和停止条件 |

常用命令：

```powershell
uv run --with pytest pytest -q
uv run --with pytest pytest -q tests/test_memory_extension.py
uv run --with pytest pytest -q tests/test_runtime.py -k reload
```

真实 provider 的协议实验放在 Notebook 中，常规测试不应依赖网络、真实密钥或付费请求。

### 12.5 常见问题定位

| 现象 | 首先检查 |
| --- | --- |
| `A model is required` | `models.json` 是否存在，settings 的引用是否正确，或是否显式传了模型 |
| 模型存在但认证失败 | `auth.json` provider 名是否一致；`api_key_env` 是否有值；endpoint 是否匹配 |
| `Project is not trusted` | 使用 `--trust-project` 或 `/trust`；确认切换后的真实 cwd |
| 新会话没有长期记忆 | 是否在 `extensions` 加载 Memory；项目是否 trusted；权限是否允许；`/memory list` 是否真的有条目 |
| “我记住了”但目录为空 | 模型没有调用 `memory_remember`；普通文本回复不会触发持久化 |
| Skill/Prompt 找不到 | 检查目录、frontmatter、名称和 `/reload` 输出的 Resource diagnostics |
| 扩展命令不存在 | 确认扩展路径、同步 `setup(api)` 和命令名是否与保留名冲突 |
| `Harness is already processing` | 等待当前操作完成；不要从同一个事件 handler 重入 Runtime |
| `Context still exceeds...` | 缩小用户输入/工具输出，检查模型窗口和 compaction 预算 |
| grep 提示需要 ripgrep | 安装 `rg`，或对简单查询使用 `literal=true` |
| 恢复后出现 unknown outcome | 上次退出发生在工具副作用之后、结果持久化之前；先检查外部状态，不要直接重跑 |
| 切换 Session 报工具缺失 | 历史保存的 active tools 在当前平台/扩展集合中不存在；恢复相同扩展或另建会话 |

### 12.6 安全与能力边界检查表

- `auth.json` 不进入模型目录、Session、导出或异常详情；提交代码前仍要检查实际文件是否被 Git 忽略。
- 内置文件工具把路径限制在 cwd 内，但 Bash/PowerShell 是进程级命令能力，不等于操作系统沙箱。
- Project trust 控制自动项目资源和工具执行；用户显式加载的扩展仍是任意 Python 代码。
- Prompt、AGENTS 和 Skill 都可能影响模型决策，但不能提升宿主权限。
- 自动重试只覆盖没有内容、没有已知副作用的特定错误；不能承诺 exactly-once。
- Compaction 是启发式预算与有损摘要；原始历史仍保留，但下一次模型上下文可能只看到摘要视图。
- Memory 是项目路径作用域，不是跨所有项目的全局用户画像；移动项目会得到新的 memory id。
- 当前没有 MCP HTTP/OAuth、TUI、插件市场、多进程 Session 锁和分布式事务。需要这些能力时，应在现有边界上新增明确协议，而不是把行为塞进 agent loop。

完成以上实践后，再按“CLI → Runtime → AgentSession → AgentHarness → Agent → Provider”的调用顺序阅读源码，能把用户可见行为、宿主策略与底层机制一一对应起来。
