# 后端局部重构记录与职责约定

## 本轮实际删除与合并

本轮主要删除文件内部的重复实现，整份源码文件只删除了一个，同时新增了三个共享模块。这属于局部去重和性能优化，尚未完成整个后端的全面结构收敛。

| 原位置 | 实际删除内容 | 当前实现 |
| --- | --- | --- |
| `fox_agent_core/src/harness/result.py` | 整个文件，28 行；删除 `HarnessError / Result / Ok / Err` 及导出 | 主流程继续使用消息表示模型、工具失败，使用异常传播宿主错误 |
| `fox_ai/src/retry.py` | `_RetrySleepCancelledError` 和 `_sleep()` | `fox_ai/src/_async.py` 的 `sleep_with_cancel()` |
| `fox_ai/src/provider_retry.py` | `_abortable_sleep()` | 同一个 `sleep_with_cancel()` |
| `fox_coding_agent/src/core/session_manager.py` | JSONL 类中重复的树操作、`_order` 列表、各类条目的重复构造、重复的条目序列化 | 内核存储基类、`_append()` 和 `_serialize_entry()` |
| `fox_coding_agent/src/core/agent_session.py` | 三参数提示词回调探测、重复的提示词拼接、散落的工具注册与筛选实现 | 四参数回调、统一提示词构造和 `tool_registry.py` |
| `core/settings.py`、`credentials.py`、`trust.py` 与 Memory、Skill Evolution 的 `store.py` | 各自复制的临时文件、flush/fsync、replace 和清理代码 | `fox_coding_agent/src/core/_io.py` 的 `atomic_write_text()` |
| `fox_agent_core/src/harness/compaction.py` | `DEFAULT_COMPACTION_SETTINGS` 重复默认值字典 | `CompactionSettings` |
| `fox_ai/pyproject.toml`、`uv.lock` | `json-repair` 依赖声明和锁定记录 | 现有标准库 JSON 解析 |

例如，`session_manager.py` 从 528 行减少到 411 行，`agent_session.py` 从 736 行减少到 665 行。按重构前快照统计，计入新增共享模块后，后端 Python 源码净减少 **172 行**。迁入共享模块的功能继续保留，不能把它们全部算作废弃代码。

可以在仓库根目录查看实际删除和代码差异：

```bash
git diff --diff-filter=D --name-only -- packages
git diff --ignore-space-at-eol -- packages/fox_coding_agent/src/core/session_manager.py
git diff --ignore-space-at-eol -- packages/fox_ai/src/retry.py packages/fox_ai/src/provider_retry.py
```

## 当前职责划分

依赖保持单向：`fox_coding_agent → fox_agent_core → fox_ai`。Desktop 与 `fox_serve` 通过现有 SDK 使用后端。

| 职责 | 唯一实现位置 |
| --- | --- |
| 厂商协议、消息和流事件 | `fox_ai/src/providers/`、`types.py`、`events.py` |
| Provider 和 Assistant 重试的可取消等待 | `fox_ai/src/_async.py` |
| 多轮循环、流消费和工具执行 | `fox_agent_core/src/agent_loop.py` |
| 会话树的插入顺序、节点校验、叶节点和失败回滚 | `fox_agent_core/src/harness/session.py` |
| 会话条目构造、上下文投影、JSONL 编解码和导出 | `fox_coding_agent/src/core/session_manager.py` |
| 工具注册、持久选择、动态工具与 Plan 过滤 | `fox_coding_agent/src/core/tool_registry.py` |
| 设置、凭据、会话、Memory 和 Skill Evolution 的原子文本写入 | `fox_coding_agent/src/core/_io.py` |
| 用户与项目目录 | `fox_coding_agent/src/core/paths.py` |
| 会话运行、压缩、模型和交互设置 | `fox_coding_agent/src/core/agent_session.py` |
| 会话切换、资源组装与扩展生命周期 | `fox_coding_agent/src/core/runtime.py` |

JSONL 存储复用内核的树操作，只实现读取和保存；写入失败时恢复内存状态。节点按字典插入顺序读取，不再维护第二份顺序列表。所有条目从一个构造入口追加，并深拷贝输入。新会话首次发布时一次写入整个草稿，包含当前叶节点和标签；后续消息由当前 SessionManager 持久化。

动态工具先完成整批校验再注册，选择动态工具不会将它们写入恢复配置。`submit_plan` 始终由交互模式管理。会话提示词的初始构造和更新使用同一条路径。

流消费为每个响应建立一个取消监听，事件读取仍分别计算空闲超时。Provider 与 Assistant 重试共享取消等待和子任务清理；各自保留 HTTP 与消息级的重试策略。Token 估算规则保持一致，工具参数只序列化一次，非 ASCII 字符统计通过编码长度计算。

已清理的接口与依赖：

- `system_prompt_builder` 统一为 `(tools, skills, cwd, interaction_mode) -> str`，不再探测三参数旧签名。
- 删除未参与运行链路的 `HarnessError / Result / Ok / Err` 类型和 `harness/result.py`。
- 压缩默认值仅由 `CompactionSettings` 定义，删除重复的默认值字典。
- 删除未使用的 `json-repair` 依赖；流式 JSON 预览与最终参数验证仍使用现有标准库实现。

厂商协议字段、Windows 工具行为、JSONL 文件格式与已有功能继续由行为测试约束。新增能力应扩展对应职责的实现，不另建旧接口转发层或重复的持久化工具。

从仓库根目录验证（pytest 可通过 `uv run --with pytest` 临时提供）：

```bash
uv run --with pytest python -m pytest tests fox_serve/tests -q
```
