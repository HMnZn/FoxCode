"""离线演示：两轮工具调用、流式回复、JSONL 保存与恢复。

在项目根目录运行：uv run python examples/mini_agent.py
只操作临时目录，不需要 API key。
"""

import asyncio
import sys
import tempfile
from pathlib import Path

# 项目使用 packages/ 源码布局，允许直接运行这个学习示例。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages"))

from fox_ai.src import ToolCall
from fox_ai.src.providers.faux import FAUX_MODEL, FauxScript, clear_scripts, push_script
from fox_coding_agent.src import AgentSession, AgentSessionConfig, JsonlSessionStorage, SessionManager


async def main():
    clear_scripts()
    push_script(FauxScript(tool_calls=[ToolCall(
        id="write-1", name="write", arguments={"path": "hello.txt", "content": "你好，Fox Agent！\n"})]))
    push_script(FauxScript(tool_calls=[ToolCall(id="read-1", name="read", arguments={"path": "hello.txt"})]))
    push_script(FauxScript(text="已创建 hello.txt，并通过 read 工具确认内容。"))

    with tempfile.TemporaryDirectory(prefix="fox-agent-demo-") as directory:
        session_file = Path(directory) / "session.jsonl"
        agent_session = AgentSession(AgentSessionConfig(
            model=FAUX_MODEL, cwd=directory,
            session=SessionManager(JsonlSessionStorage(session_file)), skills=[],
        ))

        def show(event, cancel_event):
            if event.type == "tool_execution_start":
                print(f"调用工具：{event.tool_name}")
            elif event.type == "message_update":
                delta = event.assistant_message_event
                if delta.type == "text_delta":
                    print(delta.delta, end="", flush=True)

        agent_session.subscribe(show)
        await agent_session.prompt("创建 hello.txt，写入问候语，然后读取确认。")
        print(f"\n本次会话共有 {len(agent_session.state.messages)} 条消息。")

        restored = AgentSession(AgentSessionConfig(
            cwd=directory, session=SessionManager(JsonlSessionStorage(session_file)), skills=[],
        ))
        print(f"从 JSONL 恢复了 {len(restored.state.messages)} 条消息，模型：{restored.state.model.id}。")


if __name__ == "__main__":
    asyncio.run(main())
