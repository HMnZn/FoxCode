# fox_coding_agent：编码宿主架构与面试指南

本篇讲 `fox_coding_agent/src` 如何把通用循环组装为可用的编码助手：Runtime、Harness、Session、Compaction、Settings、Resources、Skill、Tools、System Prompt、Extensions 与 CLI。通用循环的调度细节见 [agent-core 指南](../fox_agent_core/ARCHITECTURE_GUIDE.md)。

配套 [CODING_AGENT_LAB.ipynb](CODING_AGENT_LAB.ipynb) 独立演示文件工具、Session 恢复、Skill、真实摘要压缩和 Runtime/扩展；不依赖另一本 Notebook 的变量或运行结果。

阅读路线：第一章先跑起来并理解配置，第二章理解工具与提示词，第三至五章学习历史、压缩和技能，第六至七章理解扩展与入口，第八章准备面试。

<a id="ch01"></a>

## 第一章：从 AgentHarness 到可运行的 mini coding agent

这次增加的能力对应 pi coding-agent 的宿主层。`Agent` 和 `agent_loop` 继续负责单个任务的运行，`AgentHarness` 继续组合工具、Session、Skill 和压缩；`AgentSessionRuntime` 管理当前 Harness 的生命周期。

### 1.1 通用内核与 coding-agent 的包边界

| 模块 | 位置 | 解决的问题 |
| --- | --- | --- |
| `SettingsManager` | `fox_coding_agent/src/core/settings.py` | 合并用户级、项目级配置，校验并保存 |
| `AuthStore` | `fox_coding_agent/src/core/auth.py` | 读取用户级模型目录，为实际请求选择凭据 |
| `ResourceLoader` | `fox_coding_agent/src/core/resources.py` | 加载项目指令、Skill、Prompt，提供扩展资源接口 |
| `AgentSessionRuntime` | `fox_coding_agent/src/core/runtime.py` | 管理 Session/cwd 切换、重载、取消、事件订阅 |
| `fox` CLI | `packages/fox_coding_agent/src/cli.py` | 解释命令行参数，把事件输出为文本或 JSON |

**与 pi 的真实包边界对照**：本地 pi-main 的 `AgentSessionRuntime` 位于 `packages/coding-agent/src/core/agent-session-runtime.ts`，`SettingsManager` 和 `ResourceLoader` 也位于 `packages/coding-agent/src/core/`。它们属于 coding-agent 的宿主层，未放入 `packages/agent/src`。

Fox 已按这一边界拆分：运行时、配置、资源、Session、Skill、Compaction、Harness 和具体编码工具均位于 `fox_coding_agent/src/core`。`fox_agent_core/src` 只保留 Agent、循环、类型、事件；依赖单向从 coding-agent 指向 agent-core。Notebook 和未来的 UI 通过 coding-agent SDK 复用这些宿主能力。

当前 CLI 的参数解析、stdout/stderr 与退出码位于独立的 `fox_coding_agent` 包。底层循环无需知道配置文件、命令行或项目目录发现规则。

Python 通过 `from fox_agent_core.src import Agent, AgentOptions` 导入通用内核，通过 `from fox_coding_agent.src import AgentSessionRuntime, AgentHarness` 导入宿主。顶层 `fox_agent_core/__init__.py` 已移除，没有从通用内核反向导入编码宿主的兼容层。

```text
fox CLI / Notebook / 未来的 UI
  └── AgentSessionRuntime
       ├── SettingsManager
       ├── ResourceLoader → AGENTS.md / Skill / Prompt / 显式资源 provider
       └── 当前 AgentHarness
            ├── Session（JSONL）
            ├── Compaction / Tools
            └── Agent → agent_loop → fox_ai
```

### 1.2 安装与运行

在 FoxCode 根目录运行 `uv sync`，项目会安装 `fox` 命令。需要 Python 3.14+。

用户级 `C:\Users\Qin\.foxcode\auth.json` 保存 provider 连接信息、密钥和模型列表。完整模板见 [examples/auth.json](../../examples/auth.json)，结构如下：

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "apiKey": "填写你的密钥",
      "models": [
        {
          "id": "deepseek-v4-flash",
          "name": "DeepSeek V4 Flash",
          "contextWindow": 1000000,
          "maxTokens": 384000,
          "input": ["text"],
          "reasoning": true,
          "compat": {
            "thinkingFormat": "deepseek",
            "reasoningEffortMap": {
              "minimal": "high", "low": "high", "medium": "high",
              "high": "high", "xhigh": "max"
            }
          }
        }
      ]
    }
  }
}
```

这些模型元数据沿用用户提供的配置，配置加载器不负责验证服务商当前价格或最大窗口。`baseUrl` 必须是普通 URL，不能填 Markdown 链接。API key 不存入会话；模型 ID、地址、参数等元数据会保存在会话中。

之后使用：

```powershell
uv run fox --interactive
uv run fox --list-models
uv run fox --model deepseek/deepseek-v4-pro --thinking xhigh -p "检查项目结构"
uv run fox --resume -p "继续，列出主要模块"
uv run fox --resume .foxcode/sessions/<会话编号>.jsonl -p "解释上次的结果"
uv run fox -p "阅读 README.md" --json
```

`--resume` 不带路径会选择当前项目、当前存储范围下最近修改的会话。它不会扫描 Notebook 的 `labs/`；恢复实验会话请明确指定其 JSONL 路径。

`--resume` 不带 `-p` 用于继续末尾为 user/toolResult 的未完成历史。已完成的对话可提供新的 `-p`；连续对话使用 `--interactive`（纯文本输入，无 TUI）。

文本模式只向 stdout 输出最终回答，会话路径与诊断写入 stderr。`--json` 输出逐行 JSON，包括 `session_start`、Agent 事件和错误事件，适合其他进程订阅。正常完成退出码为 0，配置/模型/运行错误为 1，参数用法错误为 2，Ctrl+C 为 130。

### 1.3 配置：用户默认值与项目差异

```text
用户主目录/.foxcode/
  auth.json                             # 凭据与模型目录
  settings.json                         # 可选，覆盖运行策略
  AGENTS.md
  skills/<名称>/SKILL.md
  prompts/<名称>.md
  sessions/<项目路径哈希>/<会话编号>.jsonl  # session_scope=user 时

项目目录/
  AGENTS.md
  .foxcode/
    settings.json                       # 可选，不存放凭据
    skills/<名称>/SKILL.md
    prompts/<名称>.md
    sessions/<会话编号>.jsonl             # 默认 session_scope=project
```

默认用户目录为 `Path.home() / ".foxcode"`：Windows Python 下通常是 `C:\Users\Qin\.foxcode`，WSL 内核则使用 Linux 用户目录。SDK 的 `user_dir=` 和 CLI 的 `--user-dir` 可显式指定位置。

优先级是默认值 → 用户配置 → 项目配置 → 显式 overrides。对象递归合并，列表整体替换。例如用户配置保留摘要尾部 8000 tokens，项目仅修改 `compaction.keep_recent_tokens` 为 1000，不会丢掉用户设置的 `reserve_tokens`。

上述优先级只用于可选的 settings.json；auth.json 始终只读用户目录，不加载项目目录中的同名文件。当前只需要维护 auth.json，其余运行参数使用代码默认值。下面的 SettingsManager 示例用于解释已有覆盖机制。

```python
from fox_coding_agent.src import SettingsManager

settings = SettingsManager(".")
settings.update({"max_turns": 30}, scope="user")
settings.update({"compaction": {"keep_recent_tokens": 1000}}, scope="project")
```

`update()` 先校验合并结果，再通过临时文件原子替换目标配置。写入失败保留旧文件与旧配置快照。它适用于单写入者，不提供多进程事务锁。

可配置项：`model`、`system_prompt`、`append_system_prompt`、`extensions`、`api_key_env`、`stream_options`、`compaction`、`tools`、`max_turns`、`tool_execution`、`session_scope`。未知顶层键报错。

`tools=null` 保留会话保存的工具选择，新会话默认启用 read/write/edit/bash/grep/find/ls，Windows 还启用 powershell；`tools=[]` 禁用工具；列表显式指定启用的内置或扩展工具。修改配置文件后，对已打开的 runtime 调用 `reload()` 才生效。

新会话使用显式模型，否则兼容旧 settings 的 model，最后选择 auth.json 的第一个模型。恢复优先采用保存的模型，显式 `model=` / `--model` 可覆盖。`reload()` 保留当前会话模型，CLI 用 `/model provider/id` 切换，SDK 用 `runtime.select_model(reference)`。加载新的 auth.json 后，再次选择模型才会应用它修改后的元数据。

### 1.4 运行时：会话与工作目录一起管理

```python
from fox_coding_agent.src import AgentSessionRuntime

# model 可省略，此时使用用户 auth.json 的第一个模型。
runtime = AgentSessionRuntime(cwd=".")
runtime.subscribe(lambda event, cancel: print(event.type))
try:
    await runtime.prompt("阅读项目说明")
    first_session = runtime.session_file
    await runtime.reload()
    await runtime.change_cwd("../another-project")
    await runtime.prompt("阅读这个项目的说明")
    await runtime.switch_session(first_session)
finally:
    await runtime.close()
```

| 操作 | Session | cwd / 资源 / 工具 |
| --- | --- | --- |
| `new_session()` | 新建历史；旧 JSONL 保留 | 当前项目重载，默认沿用当前模型 |
| `change_cwd(path)` | 为目标项目创建新历史 | 目标配置与资源重新加载，工具绑定新路径 |
| `switch_session(file)` | 从指定 JSONL 恢复 | 恢复元数据中的 cwd 并重建宿主 |
| `reload()` | 保留历史、模型、排队消息 | 重新加载配置、指令、技能、模板和工具 |
| `close()` | 保留已保存历史 | 取消并等待当前任务，解除运行时订阅 |

切换时先加载并检查目标资源，再取消旧任务、等待旧任务完成清理和持久化，随后构建新 Harness。切换中的新 prompt 会被拒绝。切换成功前不替换当前 Harness，失败后仍可继续使用原 Harness；若已经发出取消，旧任务不会自动重启。新会话在 Harness 成功构建后才写入 JSONL，避免失败初始化留下可被 `--resume` 选中的空文件。

工具必须绑定目标 cwd。内置工具每次重建；自定义工具通过 `tool_factory(cwd)` 提供，工厂应返回适用于传入 cwd 的新工具对象。runtime 不调用全局 `os.chdir()`，多个 runtime 可以使用不同项目。

Runtime 的订阅独立于当前 Harness，因此切换后无需重新 subscribe。事件回调中不要等待当前任务的切换或关闭操作；应在外层调度这些操作，避免任务等待自己的结束。

早期 Notebook 的 Session 没有 cwd 元数据。恢复这类旧文件时，请通过 `cwd=` 或 `--cwd` 指向对应实验 `workspace/`，例如 `.foxcode/labs/agent-core/fox-agent-core-lab-9tr1uzmn/workspace`。有 cwd 元数据的新会话自动恢复原项目；CLI 显式 `--cwd` 与它冲突时会报错。

### 1.5 资源加载：方法、指令和工具分开

`AGENTS.md` 按用户级、文件系统祖先目录到当前目录的顺序加入 system prompt，重复物理路径只读取一次。这一版只加载启动 cwd 及祖先的指令，不会在模型读取任意子目录文件时动态加载该子目录的指令。

Skill 复用现有解析器，读取用户 `.foxcode/skills` 与项目 `.foxcode/skills`，同时兼容旧用户目录 `.foxcode/agent/skills`。目录优先级：旧用户目录 → 用户目录 → 项目目录。重名时后者覆盖前者并产生诊断。直接调用旧的 `load_skills()` 仍保留它原先的“先加载优先”规则；新规则由统一 ResourceLoader 实现。

Skill 的描述进入 system prompt；正文按需通过 read 或 `invoke_skill()` 加入。Prompt 模板则是可复用的用户输入：

```markdown
---
description: 检查指定模块
---
请检查 $ARGUMENTS 的职责、错误处理和测试覆盖。
```

保存为 `.foxcode/prompts/review.md` 后调用：

```python
await runtime.reload()
await runtime.invoke_prompt("review", "packages/fox_agent_core/src/agent_loop.py")
```

模板采用字面量 `$ARGUMENTS` 替换，不执行 Python 或 Shell。Prompt 也支持子目录，例如 `prompts/code/review.md` 的名称为 `code/review`。

资源回调仍可通过 `resource_providers=(callback,)` 注入，接收 cwd 并返回 `Resources`。可执行扩展通过 ExtensionRunner 显式加载，注册工具、命令、提示规则和事件钩子，详见第六章。当前没有扩展市场或 pi 完整插件协议。

### 1.6 与 pi 的边界和面试表达

这四项解决的是“同一个 Agent 循环如何服务不同项目和入口”。Session 保存历史，Settings 决定运行策略，Resources 提供项目知识，Runtime 负责把它们与 cwd 对齐，CLI 负责用户输入输出。

没有为这四项修改 agent loop 的执行算法。保留这种依赖方向，可以在以后添加 TUI、HTTP/RPC 或插件时继续复用核心循环。当前仍是单进程、单会话写入者的精简实现；完整 TUI、OAuth 管理、项目可信任 UI、跨进程会话锁和插件市场属于后续应用层能力。

验证命令：`uv run python -m unittest discover -s tests -v`。测试覆盖配置优先级、原子写失败、资源覆盖、cwd 工具重绑定、会话恢复、运行中取消、重载保留队列和 CLI JSON/退出码。测试显式注入 Faux 模型；正常 CLI 使用用户选择的真实 Provider，不会在请求失败时回退模拟模型。

### 1.7 为什么认证必须独立于 cwd

原先 `/cwd` 切换项目后，只继承了模型对象，新项目未配置 `api_key_env`，请求因此找不到 DeepSeek 密钥。现在每次请求通过 AuthStore 按实际模型的 provider、API 和服务地址查找凭据。模型切换、分支恢复及摘要调用共享这条路径，不缓存一个与当前模型无关的密钥。

auth.json 存在用户目录，项目 cwd 只影响工具、资源和会话位置。项目不能通过放置一个同名 auth.json 覆盖用户凭据。Session 保存模型与思考级别，但不保存 apiKey；`/reload` 可以读取更新后的凭据，加载失败保留之前有效的目录。

| 操作 | 结果 |
| --- | --- |
| `/model` | 列出目录并显示当前模型 |
| `/model deepseek/deepseek-v4-pro` | 保留消息，切换模型并保存模型变更 |
| `/thinking` | 查看当前思考级别，新会话默认 off |
| `/thinking high` | 设置框架级思考强度并保存 |
| `/thinking xhigh` | 按本例的映射发送 DeepSeek `max` |
| `/thinking off` | 发送关闭思考的参数，不只是隐藏思考文本 |
| `/cwd DIR`、`/new` | 新建会话并保留当前模型与可用的思考级别 |
| `/resume FILE` | 恢复会话保存的模型和思考级别 |

支持 `off/minimal/low/medium/high/xhigh/max`。提供的 DeepSeek 配置把 minimal 至 high 映射为同一服务端级别 high，xhigh 映射为 max；因此这些名称不表示服务端一定有七种不同模式。普通模型不允许启用思考。切换到不支持思考的模型时自动关闭思考。

底层通过 OpenAI SDK 的 extra_body 发送 DeepSeek 的 thinking 与 reasoning_effort 字段；框架思考状态优先于采样参数中固定的 thinking 值，避免旧的 disabled 参数使 `/thinking high` 失效。

原项目设置备份为 `.foxcode/settings.before-auth.json`，不参与加载。无需新建 settings.json；模型目录以外的项目策略继续使用代码默认值。CLI 入口是 `fox_coding_agent.src.cli:main`，升级后运行 `uv sync` 刷新安装元数据。

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

七种工具默认启用，PowerShell 默认只在 Windows 新会话启用；通过配置或 `--tools` 可以调整。名称错误和重复名称会在运行时初始化时报错，包括扩展工具与内置工具重名。

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

当前机制先加载技能元数据，在 system prompt 中提供名称、描述和文件位置。模型判断有用时，可以通过 `read` 读取全文。显式 `invoke_skill()` 则直接把指定技能内容和补充要求加入本次用户输入。

这种设计把“发现有哪些知识”与“加载具体知识”分开，降低普通请求的上下文负担。若宿主禁用了文件读取能力，就需要改用显式调用或提供另一种加载方式。

### 5.3 技能不是权限系统

`disable_model_invocation` 在当前实现中主要影响技能是否出现在自动展示的目录中；显式调用仍然可以使用该技能。它不等于对文件访问施加了隔离。

技能文本、读取的文件和命令输出都可能影响模型决策，因此工具权限应在可执行边界实施，不能只依赖一段“请不要执行危险操作”的提示词。

### 5.4 关键 Hook 的时机

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

这张表描述内核与 Agent 的扩展面。当前 `AgentHarnessOptions` 只直接暴露其中一部分，其余能力可以使用较低层的 Agent 接口或扩展 Harness，不能假设每个选项都能原样传给所有层。

`after_tool_call` 也不是无论发生什么都执行的 finally 钩子，例如取消或参数校验未完成时，不一定进入它。资源释放仍应放在工具自身的清理路径中。

### 5.5 上下文变换与历史修改不能混为一谈

某次请求不发送一条消息，不代表应该从会话历史删除它。请求侧变换解决“模型这一轮看到什么”，Session 修改解决“历史保存什么”，两个动作的后果不同。

当前消息对象也不是完全不可变的。编写变换 Hook 时，最好返回需要的新列表或新对象，避免意外原地修改多个层共享的数据。

### 5.6 为什么先使用小接口，而不是直接做复杂插件系统

这个 mini 版本的主要扩展需求可以由工具协议、可替换流函数和少量生命周期回调覆盖。直接引入插件市场、动态模块加载、版本依赖管理和插件隔离，会增加一整套与 Agent 闭环不同的问题。

比较合理的演进方式是先稳定消息、工具和事件契约。当确实出现多方分发、独立升级和隔离运行需求时，再把这些接口组织成插件系统。

<a id="ch06"></a>

## 第六章：Extensions


扩展是包含同步 `setup(api)` 函数的 Python 文件。它可以注册：

| API | 作用 |
| --- | --- |
| `register_tool(tool)` | 注册实现 AgentTool 协议的工具 |
| `register_command(name, handler, description)` | 注册 CLI 命令；也可由 SDK 调用 |
| `add_prompt_guideline(text)` | 补充 system prompt 规则 |
| `on(event, handler)` | 订阅 Agent/Compaction 事件和宿主钩子 |

handler 支持同步或异步，签名为 `(data, context)`；`context.cwd` 是所属项目，`context.harness` 和 `context.session` 提供当前宿主与会话。Agent/Compaction 事件的 data 是事件对象；`before_prompt`、`tool_call`、`tool_result`、`session_start`、`session_shutdown` 的 data 是字典。

`before_prompt` 可返回 `{"message": "替换后的输入"}`；`tool_call` 可返回 `{"block": True, "reason": "原因"}`；`tool_result` 可补充或替换 content/details/is_error 等结果字段。普通事件只用于观察，返回值不改变核心循环。宿主传入的工具阻止策略先执行，扩展不会使已阻止的工具真正执行。

`session_start` 在该 Harness 首次执行任务或命令前触发，`session_shutdown` 在使用过的 Harness 关闭或切换前触发。事件回调应避免直接启动同一宿主的另一次运行；需要新任务时，由外部调用方调度，或使用现有 steering/follow-up 队列。

扩展通过 CLI `--extension 路径` 或配置显式加载，例如：

```json
{
  "extensions": ["extensions/project_info.py"]
}
```

配置中的相对路径以该 settings.json 所在目录为基准，因此上例对应 `.foxcode/extensions/project_info.py`。CLI 的相对路径则以命令启动目录为基准。扩展是具有进程权限的 Python 代码，不是隔离执行的 Skill；本版不会扫描并自动执行所有项目 `.py` 文件。

完整可运行示例见 [project_info.py](../../examples/extensions/project_info.py)。它添加 word_count 工具、project-info 命令和一个文件工具 Hook：

```powershell
uv run fox --extension examples/extensions/project_info.py --command project-info
uv run fox --extension examples/extensions/project_info.py --interactive
```

`/reload` 会重新编译显式扩展的源文件，使用新的注册表，避免重复事件处理器和旧模块缓存。加载失败保留当前 Harness。当前支持单文件扩展和 SDK 工厂，不包含插件市场、包安装、Provider 扩展或自定义 UI 组件协议。

<a id="ch07"></a>

## 第七章：CLI 与未来 UI


```powershell
uv run fox --interactive
uv run fox --resume --interactive
uv run fox --resume --compact
uv run fox --tools read,grep,find,ls -p "梳理项目结构"
uv run fox --skill release-audit -p "检查开发环境"
uv run fox --template review -p "src/module.py"
```

连续对话提供 `/new`、`/resume 文件`、`/cwd 目录`、`/reload`、`/compact`、`/tools`、`/model`、`/thinking`、`/skill 名称`、`/prompt 名称` 和扩展命令。`/tools none` 禁用工具；`/help` 显示可用命令；`/exit` 结束。当前每次任务等待完成后打印最终回复，Ctrl+C 结束 CLI；没有实现终端组件、复杂键盘交互或 TUI。

非交互 JSON 模式继续保留稳定的逐行事件输出，扩展命令返回 `command_result`。普通扩展 print 被导向 stderr；扩展若直接写文件描述符或启动自己的后台任务，需自行遵守宿主输出和资源清理约定。

未来 UI 可以直接创建 AgentSessionRuntime、调用 prompt/compact/reload，并通过 subscribe 消费事件，不需要调用 CLI 或重写 Agent 循环。

<a id="ch08"></a>

## 第八章：职责、源码与面试表达

### 8.1 一次任务怎样贯穿宿主

CLI 解析参数，Runtime 选定 cwd 与 Session，再由 Settings 和 Resources 决定模型、工具、项目指令与扩展。Harness 用 Session 重建 Agent 上下文，每次请求前检查压缩预算，完成消息到达后保存。工具结果推动下一轮模型请求；CLI 订阅事件或等待最终回复。

`Runtime` 管理“当前是哪一个宿主”，`Harness` 管理“这个宿主如何运行与保存”。切换项目需要重建 cwd 绑定的工具，不能只修改字符串；恢复 Session 恢复的是历史状态，无法恢复进程退出前的协程。加载失败保留旧 Harness，但已取消的旧任务不会自行重启。

### 8.2 源码地图

| 文件 | 要理解的职责 |
| --- | --- |
| [runtime.py](src/core/runtime.py) | 会话/cwd 切换、重载、扩展生命周期 |
| [harness.py](src/core/harness.py) | Agent、持久化和请求前压缩的组装 |
| [session.py](src/core/session.py) | 历史树、JSONL 和上下文重建 |
| [compaction.py](src/core/compaction.py) | 估算、切割和摘要生成 |
| [settings.py](src/core/settings.py) | 配置优先级与原子写入 |
| [auth.py](src/core/auth.py) | 用户级模型目录、别名解析与按服务地址匹配的凭据 |
| [resources.py](src/core/resources.py) / [skills.py](src/core/skills.py) | 项目知识的发现与组织 |
| [tools.py](src/core/tools.py) / [system_prompt.py](src/core/system_prompt.py) | 执行能力与提示词的一致性 |
| [extensions.py](src/core/extensions.py) | 注册工具、命令和钩子 |
| [cli.py](src/cli.py) | 命令行参数、连续对话、JSON 和退出码 |

### 8.3 面试中避免夸大能力

“我参考 pi 的分层，把项目策略放在 coding-agent，而不写进通用 loop。工具提供执行能力，Skill 提供方法，system prompt 组织上下文，Hook 执行宿主限制。Session 保存历史树，压缩生成模型可消费的工作视图，Runtime 保证切换会话时 cwd、工具和资源同步变化。”

当前是单进程、单写入者的 mini 实现，没有完整 TUI、插件市场、OS 沙箱或 exactly-once 保证。JSONL 使用全文件原子替换；压缩使用估算预算，摘要成功后才提交，无法保证任何长度的输入都能缩到窗口内。未来 UI 复用 Runtime 的调用与订阅接口，无需重新实现循环。
