"""fox_serve —— FoxCode 桌面端 UI 与 Python 宿主之间的连接层（sidecar）。

这个包**不修改** `packages/` 下的任何代码：它只 import 现成的宿主 API
（``fox_coding_agent.src.AgentSessionRuntime``）并把宿主暴露成一个可由
Electron 前端驱动的进程。

进程模型（与 `desktop/electron/sidecar.js` 逐字对齐）::

    stdin   <- {"id": "c1", "method": "prompt", "params": {...}}
    stdout  -> {"id": "c1", "result": {...}}          # 成功
               {"id": "c1", "error": "..."}           # 失败
               {"frame": {...HostFrame...}}           # 宿主事件（无序请求）
               {"event": "transport", "status": {...}}
               {"event": "permission", "request": {...}}

约定：
- **stdout 只输出 NDJSON**，每行一个 JSON 对象；日志一律走 stderr。
- 请求之间**并发**处理（每条请求一个 asyncio task），因为 ``prompt`` 会在整轮
  结束前一直挂起，而 UI 需要在同一时间发 ``permission.answer``。
"""

from __future__ import annotations

__all__ = ["__version__"]

#: sidecar 自身的版本号（会作为 ``HostInfo.hostVersion`` 上报）。
__version__ = "0.1.0"
