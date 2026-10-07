# fox-ai

FoxCode 的模型协议层，将不同供应商的消息、流式响应、工具调用和用量统一为一个 API。

## 职责

- 消息、模型、上下文、调用参数与费用类型。
- OpenAI compatible、Anthropic 和用于离线测试的 Faux 适配器。
- 统一流式事件、增量工具参数解析、约束采样和可取消的重试。
- 模型与 API provider 注册表。

输入为 `Model + Context + StreamOptions`，输出为 `EventStream` 与最终 `AssistantMessage`。
这一层不持有工作区、会话文件、权限或 UI 状态。

## 源码导航

| 模块 | 内容 |
| --- | --- |
| [`types.py`](src/types.py) | 消息、模型、调用选项、用量与费用 |
| [`stream.py`](src/stream.py) | 流式与非流式调用入口 |
| [`models.py`](src/models.py) | 模型目录与 provider 注册 |
| [`providers/`](src/providers/) | 供应商协议适配 |
| [`events.py`](src/events.py)、[`event_stream.py`](src/event_stream.py) | 流式事件与结果通道 |
| [`partial_json.py`](src/partial_json.py) | 增量工具参数解析 |
| [`retry.py`](src/retry.py)、[`provider_retry.py`](src/provider_retry.py) | 循环层与请求阶段的重试策略 |

`fox-agent-core` 消费这些类型并驱动 Agent 循环；`fox-coding-agent` 负责用户配置与凭据。

## 验证

从仓库根目录运行：

```bash
uv run python -m unittest discover -s tests -v
```

测试覆盖流式协议、取消、工具调用、错误处理、模型目录和凭据隔离。完整项目入口见
[FoxCode README](../../README.md)。
