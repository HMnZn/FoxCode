# fox_serve

`fox_serve` 是 FoxCode Desktop 与 Python runtime 之间的 sidecar。它通过 stdin/stdout 上的
NDJSON 接收请求、返回结果，并推送 Agent 帧、传输状态和权限审批。

```text
React renderer ←IPC→ Electron main ←NDJSON→ fox_serve ←Python API→ AgentSessionRuntime
```

## 启动

```bash
uv run python -m fox_serve --quiet --cwd /path/to/workspace
uv run python fox_serve/scripts/ndjson_client.py
uv run python fox_serve/scripts/ndjson_client.py --prompt "只回复：ready" --approve
```

常用参数包括 `--cwd`、`--user-dir`、`--model`、`--session`、`--resume`、
`--new-session`、`--thinking`、`--permission`、`--ask-timeout` 和 `--quiet`。

## 协议

每行一个 JSON 对象。stdout 只承载协议，日志只写 stderr。

```jsonc
{"id":"r1","method":"host.info","params":{}}
{"id":"r1","result":{"transport":"sidecar"}}
{"id":"r1","error":"可展示给用户的错误"}
{"frame":{"type":"message_update","seq":12,"ts":1730000000000,"v":3}}
{"event":"transport","status":{"state":"ready","since":1730000000000}}
{"event":"permission","request":{"id":"perm-1","tool_name":"bash"}}
```

命令按 `host`、`sessions`、`prompt/run`、`model/runtime`、`permission/trust`、
`skills/extensions`、`files` 和 `config` 分组。完整 DTO 以
[desktop/src/types/protocol.ts](../desktop/src/types/protocol.ts) 与 [protocol.py](protocol.py) 为准。

## 配置控制面

[configuration.py](configuration.py) 是桌面设置唯一的文件写入口：

- 使用 runtime 的模型、MCP、Subagent 和 Settings schema 做校验；
- 使用同目录临时文件、`fsync` 和 `os.replace` 原子写入；
- 模型配置验证失败时恢复最后一份有效文件；
- API Key 只写 `auth.json`，快照只返回 `credentialConfigured`；
- MCP env 只返回 key 名，编辑其他字段时保留未回显的值；
- 未信任项目拒绝项目级写入；
- MCP/Subagent 保存后启用对应扩展并热重载 runtime；
- Agent 正在运行时拒绝修改产品配置，避免中途替换能力集。
- 首次启动没有 `models.json` 时仍保持控制面在线，允许 UI 完成第一个供应商配置。

## 权限

sidecar 让 runtime 内部以 `full-access` 运行，把用户可见档位交给 `PermissionPolicy` 执行，
这样 `workspace-modify` 中需要越界的单次操作可以先请求 UI 批准。判定顺序是“项目是否可信
→ sidecar 静态策略 → 用户审批 → 扩展钩子”，后续层只能收紧权限，不能提权。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `server.py` | 并发读取 NDJSON、响应与背压 |
| `host.py` | 命令编排、runtime 生命周期与帧转发 |
| `protocol.py` | JSON 序列化与协议版本 |
| `configuration.py` | 设置控制面与脱敏快照 |
| `approvals.py` | 权限策略、审批 broker 与预览 |
| `sessions.py` | 会话索引、标签与安全删除 |
| `workspace_files.py` | 改动清单、diff 和安全文件预览 |
| `extension_catalog.py` | 扩展发现与作用域 |

## 测试

```bash
UV_CACHE_DIR=/tmp/foxcode-uv-cache uv run python -m unittest discover -s fox_serve/tests -v
```
