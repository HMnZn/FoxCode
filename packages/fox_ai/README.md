# fox-ai

FoxCode 的 provider-neutral 模型层，负责模型类型、流式事件、provider 注册、约束采样和重试。

## 边界

- 不知道 Coding Agent、工具权限、会话目录或 UI。
- 输入是 `Model + Context + StreamOptions`。
- 输出是统一 `EventStream[AssistantMessageEvent, AssistantMessage]`。
- 内置 OpenAI-compatible、Anthropic 和 Faux provider；第三方可注册新 provider。

## 关键模块

- `types.py`：消息、模型、费用、上下文和 stream options
- `events.py` / `event_stream.py`：统一流式事件
- `models.py`：模型与 API provider 注册表
- `providers/`：协议适配器
- `retry.py` / `provider_retry.py`：安全阶段重试
- `partial_json.py`：增量 tool-call JSON

详细设计见 [ARCHITECTURE_STUDY.md](ARCHITECTURE_STUDY.md)。从仓库根运行测试：

```bash
UV_CACHE_DIR=/tmp/foxcode-uv-cache uv run python -m unittest discover -s tests -v
```
