"""历史回放的回归测试（`ServeHost._replay_current_session`）。

真实会话里「一轮只有工具调用、没有正文」很常见（`memory_remember` 被
workspace-modify 拒绝就是这种回合）。UI 的会话视图只在工具帧
（`tool_execution_start/end`）到达时才建卡片，所以回放必须把助手消息的
`toolCall` part 补成工具帧——否则用户看到的是「模型没有回复」。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fox_serve.approvals import PermissionPolicy  # noqa: E402
from fox_serve.host import ServeHost, content_text, tool_call_parts  # noqa: E402


class _Entry:
    def __init__(self, kind: str, data: Any) -> None:
        self.type = kind
        self.data = data


class _Session:
    def __init__(self, entries: list[_Entry]) -> None:
        self._entries = entries

    def get_branch(self) -> list[_Entry]:
        return self._entries


class _AgentSession:
    def __init__(self, entries: list[_Entry]) -> None:
        self.session = _Session(entries)


class _Runtime:
    def __init__(self, entries: list[_Entry]) -> None:
        self.agent_session = _AgentSession(entries)


def _text(value: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": value}]


class ReplayTest(unittest.TestCase):
    def _host(self, entries: list[_Entry]) -> tuple[ServeHost, list[dict[str, Any]]]:
        host = ServeHost(cwd=".")
        host._runtime = _Runtime(entries)  # noqa: SLF001
        host._policy = PermissionPolicy("workspace-modify", cwd=Path.cwd())  # noqa: SLF001
        frames: list[dict[str, Any]] = []
        host._send = lambda payload: frames.append(payload)  # noqa: SLF001
        return host, frames

    @staticmethod
    def _kinds(frames: list[dict[str, Any]]) -> list[str]:
        return [item["frame"]["type"] for item in frames if "frame" in item]

    def test_content_helpers(self) -> None:
        payload = {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "我来记一下"},
                {"type": "toolCall", "id": "call_1", "name": "memory_remember"},
                {"type": "toolCall", "name": "missing-id"},
            ],
        }
        self.assertEqual(content_text(payload), "我来记一下")
        self.assertEqual([part["id"] for part in tool_call_parts(payload)], ["call_1"])
        self.assertEqual(content_text({"role": "user", "content": "纯字符串"}), "纯字符串")
        self.assertEqual(content_text({"role": "user"}), "")

    def test_replay_emits_tool_frames_for_a_tool_only_turn(self) -> None:
        entries = [
            _Entry("model_change", {"id": "deepseek-v4-flash"}),
            _Entry("message", {"role": "user", "content": _text("记住我偏好中文")}),
            _Entry(
                "message",
                {
                    "role": "assistant",
                    "content": [
                        {"type": "toolCall", "id": "call_1", "name": "memory_remember"},
                    ],
                },
            ),
            _Entry(
                "message",
                {
                    "role": "toolResult",
                    "toolCallId": "call_1",
                    "toolName": "memory_remember",
                    "isError": True,
                    "content": _text("requires full-access permission"),
                },
            ),
            _Entry(
                "message",
                {
                    "role": "assistant",
                    "content": _text("已了解你的偏好，但当前权限模式无法修改记忆。"),
                },
            ),
        ]
        host, frames = self._host(entries)
        replayed = host._replay_current_session()  # noqa: SLF001

        self.assertEqual(replayed, 4)
        self.assertEqual(
            self._kinds(frames),
            [
                "message_end",
                "message_end",
                "tool_execution_start",
                "message_end",
                "tool_execution_end",
                "message_end",
                "agent_end",
            ],
        )
        start = frames[2]["frame"]
        self.assertEqual(start["tool_call_id"], "call_1")
        self.assertEqual(start["tool_name"], "memory_remember")
        self.assertEqual(start["args"], {})
        end = frames[4]["frame"]
        self.assertEqual(end["tool_call_id"], "call_1")
        self.assertTrue(end["is_error"])
        self.assertEqual(end["result"], "requires full-access permission")
        # 每一帧都要带信封，前端按 seq 排序。
        self.assertTrue(all("seq" in item["frame"] for item in frames))

    def test_replay_keeps_arguments_and_skips_history_without_tools(self) -> None:
        entries = [
            _Entry("message", {"role": "user", "content": _text("你好")}),
            _Entry(
                "message",
                {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "读文件"},
                        {"type": "toolCall", "id": "c9", "name": "read_file", "arguments": {"path": "a.py"}},
                    ],
                },
            ),
        ]
        host, frames = self._host(entries)
        host._replay_current_session()  # noqa: SLF001

        self.assertEqual(
            self._kinds(frames),
            ["message_end", "message_end", "tool_execution_start", "agent_end"],
        )
        self.assertEqual(frames[2]["frame"]["args"], {"path": "a.py"})

    def test_replay_without_tools_emits_no_agent_end(self) -> None:
        entries = [
            _Entry("message", {"role": "user", "content": _text("你好")}),
            _Entry("message", {"role": "assistant", "content": _text("你好，有什么可以帮你？")}),
        ]
        host, frames = self._host(entries)
        host._replay_current_session()  # noqa: SLF001
        self.assertEqual(self._kinds(frames), ["message_end", "message_end"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
