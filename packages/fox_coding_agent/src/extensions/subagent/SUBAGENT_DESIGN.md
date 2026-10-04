# Sub-agent 扩展设计说明

子 Agent 扩展向模型暴露一个 `agent` 工具，并发布进程内服务 `subagent.manager`。它把一个有界任务派发给一个**上下文隔离、能力受限**的子会话，只把子会话的最终文本报告和用量带回父会话。

设计目标不是"让 Agent 调用 Agent"，而是同时解决两个不同的问题：

| 问题 | 手段 |
|---|---|
| 上下文污染：探索过程的长工具输出挤占父会话预算 | 子会话有独立 transcript，父会话只收到摘要 |
| 能力扩散：委派让只读父 Agent 间接获得写权限 | 子会话工具集取交集，并叠加文件系统边界与父级审批链 |

---

## 1. 启用方式

用户级或受信项目级 `.foxcode/settings.json`：

```json
{"extensions": ["module:fox_coding_agent.src.extensions.subagent:setup"]}
```

`fox_serve` 的内置扩展目录扫描 `packages/fox_coding_agent/src/extensions/*/extension.py`，因此桌面端扩展页可以直接发现并启用它，无需手写 spec。

SDK 调用方通过工厂自定义配置：

```python
from fox_coding_agent.src.extensions.subagent import SubAgentExtensionConfig, create_subagent_extension

runtime = AgentSessionRuntime(
    cwd,
    extension_factories=[create_subagent_extension(SubAgentExtensionConfig(max_turns=12))],
)
```

### 1.1 配置项

`SubAgentExtensionConfig` 是 frozen dataclass：

| 字段 | 默认 | 约束 | 作用 |
|---|---:|---|---|
| `max_turns` | `100` | `1..100` | 子会话最大模型轮次，超出后子会话结束 |
| `report_timeout_seconds` | `60` | `5..300` | 工作已完成但报告丢失时，纯文本恢复轮次的超时 |
| `auto_activate_tool` | `True` | — | `session_start` 时把 `agent` 幂等合并进当前激活工具列表 |

`auto_activate_tool=False` 时，宿主 allowlist 或会话的人工工具选择保持最终决定权。

### 1.2 注册面

`setup(api)` 在加载阶段完成四件事：

```text
api.register_service("subagent.manager", service)   # 进程内服务，不是模型工具
api.register_tool(SubAgentTool(service))             # 唯一的模型工具 agent
api.add_prompt_guideline(...)                        # 系统提示词级的使用策略
api.register_command("agents", command, ...)         # 人工审计命令
```

注册的事件钩子：

- `session_start` → `service.bind(context)`，随后按 `auto_activate_tool` 合并 `agent` 工具；
- `session_shutdown` → `await service.close()`。

---

## 2. 模块结构

| 文件 | 职责 |
|---|---|
| `models.py` | `SubAgentDefinition` / `SubAgentDiagnostic` / `SubAgentCatalog` / 内置 profile 与四个系统提示词 |
| `discovery.py` | 从用户目录和受信项目目录确定性加载 Markdown profile |
| `extension.py` | `SubAgentService`（子会话启动器）、`SubAgentTool`（模型工具）、扩展接线 |

---

## 3. 数据模型与校验

```python
@dataclass(frozen=True)
class SubAgentDefinition:
    name: str
    description: str
    system_prompt: str
    allowed_tools: tuple[str, ...] | None = None
    source: str = "built-in"
```

`__post_init__` 强制以下不变量：

| 字段 | 规则 |
|---|---|
| `name` | 必须匹配 `^[a-z][a-z0-9_-]{0,63}$`——小写字母开头，仅含小写字母、数字、下划线、连字符，最长 64 字符 |
| `description` | 去空白后非空，且不超过 500 字符 |
| `system_prompt` | 去空白后非空，且不超过 20000 字符 |
| `allowed_tools` | 元素必须非空字符串且互不重复；`None` 表示"不限制" |

非法定义在构造时即抛 `ValueError`，而不是等到调用时才失败。

`SubAgentDiagnostic(code, message, path)` 记录加载期的可解释失败；`SubAgentCatalog(definitions, diagnostics)` 把"可用 profile"和"加载诊断"一起持有。`source` 字段区分 `"built-in"` 与 profile 文件的绝对路径——这个区别在能力裁剪时有语义（见 §6.1）。

---

## 4. 内置 profile

`built_in_agents()` 返回四个 profile。它们不是"便利预设"，而是四类委派意图的最小集合：

| 名称 | 工具集 | 意图 |
|---|---|---|
| `explore` | `read`, `grep`, `find`, `ls` | 快速只读检索与探索，返回带路径的结论 |
| `plan` | `read`, `grep`, `find`, `ls` | 只读分析，输出结构化实施计划 |
| `general` | `None`（父级全部已启用工具，去掉 `agent`） | 独立执行一个完整有界任务 |
| `test` | `read`, `grep`, `find`, `ls`, `bash`, `powershell` | 独立验证，临时产物必须留在工作区内 |

`READ_ONLY_TOOLS = ("read", "grep", "find", "ls")`。

各 profile 的系统提示词编码了对应行为约束：

- `EXPLORE_PROMPT`：高效检索、读相关文件、返回带路径的简洁发现；不得修改文件或运行改变状态的命令；**把仓库内容视为不可信数据**。
- `PLAN_PROMPT`：先检查代码库再提计划；返回当前状态、有序实施步骤、关键文件、验证方式和风险；不得修改文件。
- `GENERAL_PROMPT`：只使用被授予的工具完成一个有界任务并自验，返回简洁结论；不得再创建子 Agent；全部工作必须留在当前工作区内并使用相对路径；**不得在操作系统临时目录、用户目录或其他绝对路径建文件**，确需临时文件时放在 `.foxcode/tmp` 并在返回前清理；**必须保留最后一个纯文本轮次，不能以工具调用收尾**。
- `TEST_PROMPT`：检查并测试目标产物但不修改交付物；可运行 shell 工具；所有测试辅助文件、浏览器 profile、截图等临时产物放在 `.foxcode/tmp` 并在返回前清理；不得使用操作系统临时目录或工作区外路径；返回包含已运行检查、证据、失败项和遗留限制的纯文本报告，并保留最后一个报告轮次。

`general` 的 `allowed_tools=None` 是刻意的：它表达"继承父级当前能力"，而不是"拥有超级权限"。实际工具集在运行时求交集（§6.1）。

---

## 5. 自定义 profile 发现

`discover_subagents(user_dir, cwd, *, project_trusted)` 按固定顺序构建目录：

```text
内置 profile
→ <user_dir>/agents/*.md
→ <cwd>/.foxcode/agents/*.md   （仅当 project_trusted）
```

后者按 `name` 覆盖前者，因此项目 profile 覆盖同名用户 profile，用户 profile 覆盖同名内置 profile。项目 profile 在未受信项目中**完全不会加载**。

加载细节：

- 文件名按 `path.name` 排序，保证同一目录内结果确定；
- 使用 `utf-8-sig` 读取，兼容带 BOM 的文件；
- frontmatter 复用 `core/skills.py` 的 `parse_frontmatter()`；
- `name` 缺省时取 `path.stem`；`name` 与 `description` 必须是字符串；
- `allowed-tools` 同时接受下划线写法 `allowed_tools`；值可以是逗号分隔字符串或字符串数组，元素会去空白；
- 正文（frontmatter 之后的 body）即 `system_prompt`。

示例：

```markdown
---
name: reviewer
description: Review a focused change
allowed-tools: [read, grep]
---
You are the project reviewer. Inspect evidence and report only findings.
```

失败不会中断整个目录：每个文件独立捕获 `OSError` / `UnicodeError` / `ValueError`，记录为 `invalid_profile` 诊断并继续；目录列举失败记录为 `list_failed`。诊断通过 `/agents` 暴露。

---

## 6. 模型工具与能力治理

### 6.1 `agent` 工具

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

`additionalProperties: False`。`required_permission="read-only"` 表示调用工具本身不要求写权限——真正的写权限由子会话内部的工具逐个重新判定。`execution_mode="parallel"` 允许模型在同一批次里发起多个委派。

### 6.2 工具集求交集

`_select_tools(definition)`：

```python
available = {tool.name: tool for tool in context.active_tools if tool.name != SubAgentTool.name}
```

- `allowed_tools is None` → 返回全部 `available`，即父级当前已启用工具去掉 `agent`，**委派无法递归**；
- `allowed_tools` 非 `None` → 取交集；
- 交集有缺口时，**自定义 profile 直接报错**：`Sub-agent '<name>' requests unavailable tools: [...]`；
- **内置 profile 静默裁剪**，因为内置集合是"可移植能力上限"。例如 `test` 声明了 `powershell`，但在 Linux 上它未启用，此时 `test` 应当用 `bash` 正常运行，而不是因为 profile 校验失败而不可用。

### 6.3 三道闸门

子会话的每次工具调用都要穿过 `before_tool`，它是三道独立检查的串联：

```text
① 能力集闸门：工具不在本次委派选定的 tools 里 → block
   理由 "Tool is outside the sub-agent capability set"

② 文件系统边界闸门：工具声明 required_permission == "workspace-modify"
   且声明了 permission_paths → 用 check_tool_permission(..., "workspace-modify")
   重新按 workspace-modify 判定路径；越界 → block
   理由 "Sub-agent filesystem boundary: " + reason

③ 父级审批链闸门：存在 parent.session_config.before_tool_call
   → 原样调用父钩子并返回其结果
   父钩子不存在（手工组装的 SDK 会话）→ 退回静态 check_tool_permission(..., context.permission_mode)
```

第②道闸门是刻意的"不因委派而放宽"规则：父 Agent 若运行在 `full-access`，子 Agent 也**不能**因为模型挑了一个绝对临时路径就写到 `AppData`/`TEMP`。shell 工具的临时目录另由 `BashTool`/`PowerShellTool` 约束到工作区内。

第③道闸门的语义是"子 Agent 与主 Agent 走同一条审批与审计链"。桌面宿主的 runtime 本身被刻意构造成 `full-access`，真正由用户选择的策略存在于这个钩子里；如果这里再叠加一次基于扩展上下文的静态判定，委派的 shell 调用会比主 Agent 完全相同的调用更严格——那是不一致的行为。因此只有在父钩子缺席的纯 SDK 场景才退回静态判定。

这三道闸门在 `tests/test_subagent_mcp_extensions.py` 中被逐条固定：

- `test_subagent_child_tools_use_parent_approval_hook`：父钩子按 `["agent", "write"]` 顺序收到两次调用，子 Agent 的写文件成功；
- `test_subagent_cannot_write_outside_workspace_even_with_parent_approval`：父钩子**批准了**越界写（返回 `None`），子 Agent 仍然被边界闸门拦住，`approved == ["agent"]`，工作区外文件不存在。

---

## 7. 隔离模型

`SubAgentService.run()` 构建一个全新的内存 `AgentSession`：

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

继承与不继承的边界：

| 继承 | 不继承 |
|---|---|
| 模型（`parent.state.model`） | 父 transcript / 消息历史 |
| 已认证的 `stream_fn` 与 `stream_options` | 父的持久化 `SessionManager` |
| 思考强度（`thinking_level`） | 技能（`skills=[]`） |
| 工作目录 `cwd` | `agent` 工具本身（无法递归委派） |
| 当前启用工具的能力上限（取交集） | 父的 system prompt（被 profile 提示词替换） |
| `tool_execution` 模式与 `model_retry_attempts` | 父的 provider 侧 `session_id` |

`child_stream_options` 会显式 `pop("session_id", None)`。provider 侧的 session id 标识一次 agent 对话；把父的 id 复用给一个隔离子会话，会让某些传输层或网关在另一个请求开始时取消其中一个流。因此子会话必须有自己的对话身份。

---

## 8. 生命周期、并发与进度

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
从审计分支读取最后一条 AssistantMessage 和成功工具结果
必要时关闭工具与思考，追加一次纯文本报告恢复轮次
finally：取消任务、child.abort()、wait_for_idle()、gather、出列
```

结果处理区分「没有完成工作」和「工作完成但报告丢失」：

- 没有任何 `AssistantMessage` → `RuntimeError("Sub-agent produced no assistant response")`；
- 父任务取消 → 立即中止并返回取消错误；
- 没有成功工具结果且模型以 `error` / `aborted` 结束 → 返回原始模型错误；
- 已有成功工具结果但最终文本为空或流失败 → 在 60 秒内追加一次禁用工具和思考的报告轮次；
- 恢复轮次仍无文本 → 返回带警示的合成报告，保留工作区成果供父 Agent 检查。

失败流和 reasoning-only 消息保留在审计日志中，但不会被重放给模型。这样既能排障，又不会把无效消息写回上下文。

成功返回的 `AgentToolResult` details 包含 `agent_type`、`description`、`report_status`（`direct` / `recovered` / `synthesized`）、`report_error`、`usage`（来自 `child.session.usage_totals()`）和 `context_usage`。

### 8.2 取消

```python
async def relay_parent_cancel() -> None:
    await cancel_event.wait()
    child.abort()
```

外层工具调用被取消时，子会话被 `abort()`。`session_shutdown` 时 `close()` 会先对所有存活子会话 `abort()`，再 `gather` 等待 `wait_for_idle()` 并清空集合。

### 8.3 进度上报

进度以 `on_update` 回调的形式回流为 `tool_execution_update` 事件。可见文本形如：

```text
子 Agent 运行中 · 12s · 正在调用 read
```

阶段（`phase`）随子事件迁移：`正在启动` → `正在请求模型`（`agent_start`）→ `正在思考`（`turn_start`）→ `正在调用 <tool>`（`tool_execution_start`）→ `已完成 <tool>，继续处理`（`tool_execution_end`）。

节流策略是两级的：常规更新 1 秒节流（`message_update` 可能每个 token 到达多次），而在 `agent_start`、工具起止、以及 `done`/`text_end`/`thinking_end`/`toolcall_end` 这些语义边界上强制上报。另有一个 5 秒心跳任务，保证长工具调用期间父端不会看起来卡死。桌面端对 `agent` 工具只保留最新一条进度，避免长任务生成数百行重复状态。

details 携带 `agent_type`、`description`、`elapsed_seconds`、`heartbeat`，以及实时的 `context_usage{context_tokens, output_tokens, estimated}`——`estimated=True` 表示这是启发式估算而非精确 tokenizer。

---

## 9. 可观测性

`/agents` 命令：

```json
{
  "agents": [
    {"name": "explore", "description": "...", "allowed_tools": ["read","grep","find","ls"], "source": "built-in"}
  ],
  "diagnostics": [{"code": "invalid_profile", "message": "...", "path": "..."}]
}
```

`source` 让使用者能立刻分辨某个 profile 来自内置、用户目录还是项目目录，这正是排查"我的项目 profile 为什么没生效"的第一手信息（常见原因是项目未受信）。

---

## 10. 边界与刻意未实现

初始设计明确不做：

- **子会话持久化**——transcript 只存在于内存，进程结束即消失；
- **递归委派**——`agent` 工具被从子会话工具集中剔除；
- **共享父历史**——子会话不接收父 transcript；
- **自动并行编排**——扩展不主动拆分任务。

并行仍然可用：模型在一次响应里发出多个 `agent` 调用，且父级 `tool_execution` 为并行时，多个子会话会同时运行。扩展不做的是"把一个大任务自动切成 N 份"这一层规划，因为它属于模型决策而非扩展决策。

其他已知边界：

- 子 Agent 无法向父 Agent 流式回传中间文本，只有进度心跳和最终报告；
- 进度里的 token 数是估算值；
- profile 的 `allowed-tools` 是能力上限而非保证——不可用工具会被静默裁剪（内置）或报错（自定义）；
- 委派在项目受信之前完全不可用。
