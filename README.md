# FoxCode · Mini Coding Agent

`fox_ai` 提供统一模型协议；`fox_agent_core` 提供循环、状态与通用 Harness；`fox_coding_agent` 提供 AgentSession、SessionManager、Tools、Skill、信任、Extensions 和 CLI。仓库是三个独立分发包组成的 uv workspace，依赖方向为 `fox-coding-agent → fox-agent-core → fox-ai`。

现已增加可复用的 `AgentSessionRuntime`、`SettingsManager`、`ResourceLoader`，以及独立 `fox_coding_agent` CLI。分层设计、配置示例与恢复语义见 [架构指南·宿主运行时与 CLI](packages/fox_coding_agent/ARCHITECTURE_GUIDE.md#ch01)。

在项目根目录运行 `uv sync` 安装 `fox`。用户级 `~/.foxcode/models.json` 保存模型目录，`~/.foxcode/auth.json` 只保存凭据；Windows 下对应 `C:\Users\Qin\.foxcode`。复制 [models.json](examples/models.json) 与 [auth.json](examples/auth.json) 后填写 key。这两个文件采用独立且唯一的结构，不能把 provider 和模型数据写进 `auth.json`。

```powershell
uv run fox --trust-project --interactive
uv run fox --trust-project --memory --interactive
uv run fox --list-models
uv run fox --model deepseek/deepseek-v4-pro --thinking high -p "阅读 README.md，说明项目架构"
uv run fox --resume -p "继续解释 Session"
uv run fox -p "检查目录结构" --json
uv run fox --resume --compact
```

会话默认写入项目 `.foxcode/sessions/`；配置 `session_scope: "user"` 后写入用户 `.foxcode/sessions/<项目路径哈希>/`。`--resume <文件路径>` 支持指定历史会话，`--resume` 不带路径选取当前项目最近会话。正常输出在 stdout，会话路径和诊断在 stderr。

交互中用 `/model` 列出模型，`/model deepseek/deepseek-v4-pro` 切换；`/thinking` 查看当前强度，`/thinking high`、`/thinking xhigh` 或 `/thinking off` 设置。新会话默认选 models.json 中第一个模型、思考关闭；模型与思考级别会保存到 Session。`/cwd` 切换项目后继续从同一用户目录取凭据，密钥不会进入 Session。修改 models.json 或 auth.json 后使用 `/reload`；想应用已修改的模型元数据，再执行 `/model 名称`。

设置文件只作为可选的运行策略覆盖。用户级 `settings.json` 可以只写 `{"model": "provider/model-id"}`；工具、压缩等未配置字段使用代码默认值。

面试准备先读内核的 11 章，再读编码宿主的 9 章，分别理解通用机制与项目策略。

学习资料按包拆分，每个包各一份指南和可独立运行的真实模型 Notebook：

| 包 | 架构讲解 | 动手实验 |
| --- | --- | --- |
| fox_agent_core | [内核指南](packages/fox_agent_core/ARCHITECTURE_GUIDE.md) | [模型、工具协议、事件和 follow-up](packages/fox_agent_core/AGENT_CORE_LAB.ipynb) |
| fox_coding_agent | [宿主指南](packages/fox_coding_agent/ARCHITECTURE_GUIDE.md) | [文件工具、Session、Skill、压缩和 Runtime](packages/fox_coding_agent/CODING_AGENT_LAB.ipynb) |

VS Code 选择 Python 3.14+ 内核，按顺序运行。密钥从 `DEEPSEEK_API_KEY` 或根目录 `.env` 读取，宿主实验数据保存到项目 `.foxcode/labs/coding-agent/`。拆分后的 Notebook 已清空旧输出。

编码宿主 Notebook 的实验目录包含 `sessions/main.jsonl`、`workspace/` 和 `request_metrics.json`。准备 workspace 的单元中设置 `STORAGE_SCOPE = "user"` 可改存到 `Path.home() / ".foxcode"`（Windows Python 下通常是 `C:\Users\Qin\.foxcode`）。每次准备实验都会创建独立目录，旧会话保留；项目 `.foxcode/` 已加入 Git 忽略规则。内核 Notebook 不保存会话。

```text
fox CLI / Notebook
    └── AgentSessionRuntime  Session/cwd 切换、Settings、ResourceLoader、重载
        └── AgentSession     会话、压缩、技能、基础工具
            └── Agent        状态、订阅、steering / follow-up、取消
                └── agent_loop  多轮模型调用 → 参数校验 → 工具执行 → 回传结果
                    └── fox_ai  OpenAI / Anthropic / Faux 流式接口
```

连续对话中支持 `/help`、`/new`、`/resume 文件`、`/cwd 目录`、`/reload`、`/trust`、`/untrust`、`/compact`、`/usage`、`/export`、`/tools`、`/model`、`/thinking`、`/skill 名称`、`/prompt 名称` 和扩展命令。`fox` 在交互终端无任务参数时也会进入连续对话。

扩展示例：[project_info.py](examples/extensions/project_info.py)。显式加载：`fox --extension examples/extensions/project_info.py --command project-info`（需先配置模型）。详细 API 与边界见[宿主指南·第六章](packages/fox_coding_agent/ARCHITECTURE_GUIDE.md#ch06)。

长期记忆作为 `fox_coding_agent` 的可选扩展提供，而不是写进通用 agent loop。使用 `--memory` 启用；模型可调用 `memory_save`、`memory_search`、`memory_list`、`memory_read` 和 `memory_delete`，交互终端可用 `/memory list`、`/memory search 关键词`、`/memory read 文件名`、`/memory delete 文件名` 与 `/memory dir`。记忆保存在用户目录的 `~/.foxcode/projects/<项目路径哈希>/memory/`，以 Markdown 条目为事实来源，`MEMORY.md` 是可重建索引。只有已信任项目能够读写和自动召回记忆。

自动召回只修改发给模型的本次请求副本，不写入 Session JSONL。这样长期知识与对话历史拥有独立生命周期，关闭 Memory 扩展或删除条目后，旧 Session 不会继续携带隐藏的记忆文本。

## 运行离线示例

需要 Python 3.14+，在项目根目录运行：

```powershell
uv sync
uv run python examples/mini_agent.py
```

示例用 Faux 模型在临时目录执行 `write → read → 最终回复`，随后从 JSONL 恢复会话。不使用真实模型，也不需要 API key。

项目采用 `packages/` 源码布局，内核实现在 `fox_agent_core/src/`，通用 Agent 从 `fox_agent_core.src` 导入，宿主与运行时从 `fox_coding_agent` 导入。`uv sync` 安装项目后可直接导入；未安装时可把源码目录加入模块搜索路径：

```powershell
$env:PYTHONPATH = "$PWD/packages"
uv run python -m unittest discover -s tests -v
```

Linux / WSL：

```bash
PYTHONPATH=packages uv run python -m unittest discover -s tests -v
```

## 创建与恢复会话

```python
import asyncio
from fox_ai.src import get_model
from fox_coding_agent.src import AgentSession, AgentSessionConfig, SessionManager, JsonlSessionStorage

async def main():
    model = get_model("openai", "gpt-4o-mini")  # 使用 fox_ai 本地注册表中的模型
    agent_session = AgentSession(AgentSessionConfig(
        model=model,
        cwd=".",
        session=SessionManager(JsonlSessionStorage(".foxcode/sessions/demo.jsonl")),
        stream_options={"max_tokens": 4096, "max_retries": 2},
    ))

    def on_event(event, cancel_event):
        if event.type == "message_update":
            delta = event.assistant_message_event
            if delta.type == "text_delta":
                print(delta.delta, end="", flush=True)

    unsubscribe = agent_session.subscribe(on_event)
    await agent_session.prompt("阅读 README.md，说明这个项目如何运行。")
    unsubscribe()
    if agent_session.state.error_message:
        print(agent_session.state.error_message)

asyncio.run(main())
```

真实调用的凭据通过 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`、`stream_options["api_key"]` 或 `get_api_key(provider)` 提供。内核不自动加载 `.env`。重新打开相同 JSONL 会恢复消息与配置；省略 `model` 时使用会话保存的模型，显式传入则切换模型。工具的 Python 实现和技能仍由当前进程提供。

不需要持久化时，省略 `session`，默认使用内存会话。`tools=None` 使用内置编码工具，`tools=[]` 禁用工具；`skills=None` 自动发现技能，`skills=[]` 禁用技能。

## 循环与队列

一次 `await agent_session.prompt(...)` 可以包含多个 turn。每个 turn 包含一次模型响应以及它产生的一批工具调用。

| 情况 | 行为 |
| --- | --- |
| 回复中存在 `ToolCall` | 校验参数、执行工具、把结果交给下一轮模型 |
| 存在 steering 消息 | 下一次模型调用前注入；不强行中断当前工具 |
| 没有工具和 steering，但存在 follow-up | 把 follow-up 作为后续输入，继续循环 |
| 无待处理工作 | 发出 `agent_end` |
| 模型报错、取消或达到轮次上限 | 结束本次运行；轮次上限默认 100 次模型请求 |

运行中追加输入使用 `agent_session.steer("先处理这个")` 或 `agent_session.follow_up("完成后再检查测试")`。两个队列默认一次消费一条，可在 config 中改为 `all`。运行中的第二次 `prompt` 会报错。

`agent_session.abort()` 发出取消信号；`await agent_session.wait_for_idle()` 等待清理完成。工具批次会补齐错误结果，保持 ToolCall / ToolResult 配对。`continue_()` 用于末尾为 user/toolResult 的未完成历史，或者已有排队消息的情况；普通的下一次对话继续用 `prompt()`。

底层保留 `Agent(AgentOptions(...))` 和 `agent_loop(...)`，可脱离 Harness 使用。`agent_loop` 返回异步事件流，`await stream.result()` 得到本次新增消息。`Agent` 的 `prepare_next_turn` 在继续下一轮之前调用；`prepare_request` 在每次模型请求前调用，包含首轮和排队输入注入之后。

## 工具

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `read` | `path`, `offset?`, `limit?` | UTF-8 文本读取，行号从 1 开始 |
| `write` | `path`, `content` | 创建父目录，原子覆盖文件 |
| `edit` | `path`, `old_text`, `new_text` | 精确匹配一次后替换；无匹配或多次匹配时报错 |
| `bash` | `command`, `timeout?` | 执行命令，默认超时 120 秒，输出有上限 |
| `grep` | `pattern`, `path?`, `glob?`, `literal?`, `ignoreCase?`, `context?`, `limit?` | 内容搜索；正则需要 rg，纯文本搜索可使用 Python 后备实现 |
| `find` | `pattern`, `path?`, `limit?` | glob 查找文件，尊重嵌套 .gitignore |
| `ls` | `path?`, `limit?` | 列出目录，包含隐藏条目 |
| `powershell` | `command`, `timeout?` | PowerShell 命令，支持超时、取消和输出上限 |

Windows 上 `bash` 需要 Git Bash，或自行传入 `BashTool(cwd, shell=...)`。`cwd` 只用于解析相对路径，不是沙箱。需要限制工具权限时，在 `before_tool_call` 中返回 `{"block": True, "reason": "..."}`。文件工具限制单个文本文件 10 MiB，输出限制约 20000 字符。

批次默认并行；只要存在标记为 `sequential` 的工具，整批串行。`write/edit/bash` 默认为串行，避免同批文件修改互相竞争。参数按 JSON Schema 校验，错误作为工具结果交给模型。

自定义工具直接实现 `AgentTool` 协议，无需继承基类或额外包装器：

```python
from fox_ai.src import TextContent
from fox_agent_core.src import AgentToolResult

class GreetTool:
    name = "greet"
    label = "打招呼"
    description = "向指定的人打招呼"
    parameters = {
        "type": "object", "properties": {"name": {"type": "string"}},
        "required": ["name"], "additionalProperties": False,
    }

    async def execute(self, call_id, params, cancel_event=None, on_update=None):
        return AgentToolResult(content=[TextContent(text=f"你好，{params['name']}")])

tool = GreetTool()
```

自定义异步工具应在 `finally` 中释放资源，并允许 `CancelledError` 传播。同步阻塞代码不能被 asyncio 及时取消。`on_update(AgentToolResult(...))` 可发送进度，内核会保证这些更新先于工具结束事件。

## Session、压缩与技能

Session 保存树形历史，`agent_session.move_to(entry_id)` 切换分支，`agent_session.fork(entry_id)` 创建独立的内存会话。模型、思考级别和启用的工具可通过 `set_model`、`set_thinking_level`、`set_active_tools` 修改并持久化。压缩前的原始条目不会删除。

JSONL 使用临时文件与原子替换，写入失败不会覆盖旧文件；它适合单进程、单写入者的小型会话。进程中断后，缺失的工具结果会标记为“结果未知”，不会自动重放可能已经写过文件的工具。

```python
from fox_coding_agent.src import CompactionSettings

config = AgentSessionConfig(
    model=model,
    compaction=CompactionSettings(
        enabled=True,
        reserve_tokens=16384,
        keep_recent_tokens=8000,
    ),
)
```

AgentSession 每次请求前估算消息、system prompt 和工具声明的 token。接近 `context_window - reserve_tokens` 时，总结较早消息并保留最近消息；小窗口最多预留一半容量。切割点不会落在工具调用与结果之间。只有成功生成非空摘要后才更新会话，摘要失败或取消时保留原始历史；可以用 `await agent_session.compact()` 手动触发。

token 数采用字符与图片的启发式估算，不是精确 tokenizer。摘要本身也需要模型调用；可以通过 `summary_fn(model, messages, **options)` 定制。超长单条输入或无法充分缩短的历史会返回预算错误，需要减少输入或工具输出。

Runtime 从 `~/.foxcode/skills` 和已信任项目的 `<cwd>/.foxcode/skills` 发现技能。system prompt 包含技能目录，模型可通过 `read` 读取全文；`await agent_session.invoke_skill("技能名", "补充要求")` 则直接注入技能内容。加载问题可查看 `agent_session.skill_diagnostics`。

## 精简范围

已包含多轮调用、流式事件、队列、取消、工具钩子与校验、会话恢复与分支、自动/手动压缩、技能和八种编码工具（PowerShell 默认仅在 Windows 启用）。`max_retries` 透传给 fox_ai，处理建立模型请求时的短暂失败；不自动重放工具或重试已经输出部分内容的整轮对话。

已增加配置管理、统一资源加载、运行时切换、按工具组装的 system prompt、Python 扩展，以及 CLI（单次文本/JSON、纯文本连续对话、恢复会话）。尚未实现 pi-main 的持久任务调度、lane、checkpoint/replay、完整插件系统、交互式权限 UI、终端界面和完整 provider 兼容层。ExtensionRunner 支持显式加载扩展、工具注册、命令、提示规则与事件钩子，ResourceLoader 仍保留资源 provider 接口；`branch_summary/session_info` 等预留条目类型仍没有完整业务流程。这些可以作为宿主层后续能力添加，普通 agent 循环不依赖它们。
