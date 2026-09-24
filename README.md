# FoxCode · 精简 Agent 内核

`packages/fox_agent_core` 是参考 pi-agent 分层设计的 Python 实现，模型调用由现有 `fox_ai` 提供。

面试准备与架构学习可阅读：[fox_agent_core 架构学习与面试指南](packages/fox_agent_core/ARCHITECTURE_GUIDE.md)。文档按 16 章讲解职责划分、运行流程、设计理由、失败处理与工程取舍。

动手实验可打开：[fox_agent_core 真实模型 Notebook](packages/fox_agent_core/AGENT_CORE_LAB.ipynb)。默认沿用已有 DeepSeek 配置，依次学习真实工具调用、JSONL 会话恢复、Skill 加载，以及真实摘要请求驱动的手动和自动压缩；包含事件观察、文件验证和请求用量统计。在 VS Code 中选择项目 `.venv` 的 Python 3.14 内核，从上到下运行即可，密钥从 `DEEPSEEK_API_KEY` 或根目录 `.env` 读取。

Notebook 默认将实验保存在项目的 `.foxcode/labs/agent-core/<运行编号>/`，其中 `sessions/main.jsonl` 保存会话，`workspace/` 保存练习文件和 Skill，`request_metrics.json` 保存用量。配置单元中设置 `STORAGE_SCOPE = "user"` 可改存到 `Path.home() / ".foxcode"`（使用 Windows Python 时为 `C:\Users\Qin\.foxcode`）。每次重新运行准备单元都会创建独立目录，旧会话保留；项目 `.foxcode/` 已加入 Git 忽略规则。

```text
AgentHarness                 对外入口：会话、压缩、技能、基础工具
    └── Agent                状态、订阅、steering / follow-up、取消
          └── agent_loop     多轮模型调用 → 参数校验 → 工具执行 → 回传结果
                └── fox_ai   OpenAI / Anthropic / Faux 流式接口
```

## 运行离线示例

需要 Python 3.14+，在项目根目录运行：

```powershell
uv sync
uv run python examples/mini_agent.py
```

示例用 Faux 模型在临时目录执行 `write → read → 最终回复`，随后从 JSONL 恢复会话。不使用真实模型，也不需要 API key。

项目采用 `packages/` 源码布局。运行自己的脚本或测试前，把它加入模块搜索路径：

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
from fox_agent_core import AgentHarness, AgentHarnessOptions, Session, JsonlSessionStorage

async def main():
    model = get_model("openai", "gpt-4o-mini")  # 使用 fox_ai 本地注册表中的模型
    harness = AgentHarness(AgentHarnessOptions(
        model=model,
        cwd=".",
        session=Session(JsonlSessionStorage(".foxcode/sessions/demo.jsonl")),
        stream_options={"max_tokens": 4096, "max_retries": 2},
    ))

    def on_event(event, cancel_event):
        if event.type == "message_update":
            delta = event.assistant_message_event
            if delta.type == "text_delta":
                print(delta.delta, end="", flush=True)

    unsubscribe = harness.subscribe(on_event)
    await harness.prompt("阅读 README.md，说明这个项目如何运行。")
    unsubscribe()
    if harness.state.error_message:
        print(harness.state.error_message)

asyncio.run(main())
```

真实调用的凭据通过 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`、`stream_options["api_key"]` 或 `get_api_key(provider)` 提供。内核不自动加载 `.env`。重新打开相同 JSONL 会恢复消息与配置；省略 `model` 时使用会话保存的模型，显式传入则切换模型。工具的 Python 实现和技能仍由当前进程提供。

不需要持久化时，省略 `session`，默认使用内存会话。`tools=None` 使用四个内置工具，`tools=[]` 禁用工具；`skills=None` 自动发现技能，`skills=[]` 禁用技能。

## 循环与队列

一次 `await harness.prompt(...)` 可以包含多个 turn。每个 turn 包含一次模型响应以及它产生的一批工具调用。

| 情况 | 行为 |
| --- | --- |
| 回复中存在 `ToolCall` | 校验参数、执行工具、把结果交给下一轮模型 |
| 存在 steering 消息 | 下一次模型调用前注入；不强行中断当前工具 |
| 没有工具和 steering，但存在 follow-up | 把 follow-up 作为后续输入，继续循环 |
| 无待处理工作 | 发出 `agent_end` |
| 模型报错、取消或达到轮次上限 | 结束本次运行；轮次上限默认 100 次模型请求 |

运行中追加输入使用 `harness.steer("先处理这个")` 或 `harness.follow_up("完成后再检查测试")`。两个队列默认一次消费一条，可在 options 中改为 `all`。运行中的第二次 `prompt` 会报错。

`harness.abort()` 发出取消信号；`await harness.wait_for_idle()` 等待清理完成。工具批次会补齐错误结果，保持 ToolCall / ToolResult 配对。`continue_()` 用于末尾为 user/toolResult 的未完成历史，或者已有排队消息的情况；普通的下一次对话继续用 `prompt()`。

底层保留 `Agent(AgentOptions(...))` 和 `agent_loop(...)`，可脱离 Harness 使用。`agent_loop` 返回异步事件流，`await stream.result()` 得到本次新增消息。`Agent` 的 `prepare_next_turn` 在继续下一轮之前调用；`prepare_request` 在每次模型请求前调用，包含首轮和排队输入注入之后。

## 工具

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `read` | `path`, `offset?`, `limit?` | UTF-8 文本读取，行号从 1 开始 |
| `write` | `path`, `content` | 创建父目录，原子覆盖文件 |
| `edit` | `path`, `old_text`, `new_text` | 精确匹配一次后替换；无匹配或多次匹配时报错 |
| `bash` | `command`, `timeout?` | 执行命令，默认超时 120 秒，输出有上限 |

Windows 上 `bash` 需要 Git Bash，或自行传入 `BashTool(cwd, shell=...)`。`cwd` 只用于解析相对路径，不是沙箱。需要限制工具权限时，在 `before_tool_call` 中返回 `{"block": True, "reason": "..."}`。文件工具限制单个文本文件 10 MiB，输出限制约 20000 字符。

批次默认并行；只要存在标记为 `sequential` 的工具，整批串行。`write/edit/bash` 默认为串行，避免同批文件修改互相竞争。参数按 JSON Schema 校验，错误作为工具结果交给模型。

自定义工具可以实现 `AgentTool` 协议，也可以使用包装器：

```python
from fox_ai.src import TextContent
from fox_agent_core import FunctionTool, AgentToolResult

async def greet(call_id, params, cancel_event, on_update):
    return AgentToolResult(content=[TextContent(text=f"你好，{params['name']}")])

tool = FunctionTool(
    name="greet",
    description="向指定的人打招呼",
    parameters={
        "type": "object",
        "properties": {"name": {"type": "string"}},
        "required": ["name"],
        "additionalProperties": False,
    },
    handler=greet,
)
```

自定义异步工具应在 `finally` 中释放资源，并允许 `CancelledError` 传播。同步阻塞代码不能被 asyncio 及时取消。`on_update(AgentToolResult(...))` 可发送进度，内核会保证这些更新先于工具结束事件。

## Session、压缩与技能

Session 保存树形历史，`harness.move_to(entry_id)` 切换分支，`harness.fork(entry_id)` 创建独立的内存会话。模型、思考级别和启用的工具可通过 `set_model`、`set_thinking_level`、`set_active_tools` 修改并持久化。压缩前的原始条目不会删除。

JSONL 使用临时文件与原子替换，写入失败不会覆盖旧文件；它适合单进程、单写入者的小型会话。进程中断后，缺失的工具结果会标记为“结果未知”，不会自动重放可能已经写过文件的工具。

```python
from fox_agent_core import CompactionSettings

options = AgentHarnessOptions(
    model=model,
    compaction=CompactionSettings(
        enabled=True,
        reserve_tokens=16384,
        keep_recent_tokens=8000,
    ),
)
```

Harness 每次请求前估算消息、system prompt 和工具声明的 token。接近 `context_window - reserve_tokens` 时，总结较早消息并保留最近消息；小窗口最多预留一半容量。切割点不会落在工具调用与结果之间。只有成功生成非空摘要后才更新会话，摘要失败或取消时保留原始历史；可以用 `await harness.compact()` 手动触发。

token 数采用字符与图片的启发式估算，不是精确 tokenizer。摘要本身也需要模型调用；可以通过 `summary_fn(model, messages, **options)` 定制。超长单条输入或无法充分缩短的历史会返回预算错误，需要减少输入或工具输出。

技能默认从 `~/.foxcode/agent/skills` 和 `<cwd>/.foxcode/skills` 发现。system prompt 包含技能目录，模型可通过 `read` 读取全文；`await harness.invoke_skill("技能名", "补充要求")` 则直接注入技能内容。加载问题可查看 `harness.skill_diagnostics`。

## 精简范围

已包含多轮调用、流式事件、队列、取消、工具钩子与校验、会话恢复与分支、自动/手动压缩、技能和四个编码工具。`max_retries` 透传给 fox_ai，处理建立模型请求时的短暂失败；不自动重放工具或重试已经输出部分内容的整轮对话。

尚未实现 pi-main 的持久任务调度、lane、checkpoint/replay、扩展系统、交互式权限 UI、终端界面和完整 provider 兼容层。`branch_summary/session_info` 等预留条目类型也没有完整业务流程。这些可以作为宿主层后续能力添加，普通 agent 循环不依赖它们。
