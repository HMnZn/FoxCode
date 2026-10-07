# MCP

连接 MCP 工具服务器，将外部工具注册到 FoxCode 当前会话。

## 启用

桌面端「插件 → 扩展管理」支持添加、编辑和删除服务器。保存服务器后宿主会启用 MCP 扩展并重载。
也可在 `settings.json` 的 `extensions` 列表中添加：

```json
"module:fox_coding_agent.src.extensions.mcp:setup"
```

用户配置为 `~/.foxcode/mcp.json`，项目配置为 `<workspace>/.foxcode/mcp.json`。
只有可信项目会加载项目服务器；同名项目配置覆盖用户配置。

## 配置示例

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "enabled": true,
      "permission": "read-only",
      "timeout": 30
    }
  }
}
```

工作目录与服务器权限应按所需能力配置。环境变量由后端保存；桌面快照只返回变量名。
项目不可信时不会执行服务器命令。

## 运行机制

- 使用 stdio 传输、JSON-RPC 请求与协议版本协商。
- 初始化后分页发现工具，注册带服务器命名空间的代理工具。
- 映射工具结果、错误与进度；管理超时、取消和连接断开。
- 会话重载或结束时清理服务器进程。
- 外部工具继续受宿主权限与扩展 hook 约束。

`/mcp` 提供会话内管理入口。MCP 服务不会在扩展目录探测阶段启动。

## 源码与验证

| 文件 | 内容 |
| --- | --- |
| [`config.py`](config.py) | 配置模型、合并与环境变量解析 |
| [`client.py`](client.py) | stdio 客户端、协商、请求与通知 |
| [`manager.py`](manager.py) | 服务器生命周期和工具代理 |
| [`extension.py`](extension.py) | 工具、命令与 hooks 注册 |

从仓库根目录执行：

```bash
uv run python -m unittest discover -s tests -v
uv run python -m unittest discover -s fox_serve/tests -v
```
