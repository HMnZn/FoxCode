"""翻译层测试：宿主对象 → 线协议 JSON（不需要真实 runtime）。"""

from __future__ import annotations

import dataclasses
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fox_serve.protocol import (  # noqa: E402
    PROTOCOL_VERSION,
    compact_json,
    event_payload,
    message_payload,
    stream_event_payload,
    to_jsonable,
    tool_result_text,
)


class _AliasedModel:
    """假装成 pydantic 模型（有 model_dump(mode, by_alias)）。"""

    def __init__(self, data: dict, aliases: dict[str, str]) -> None:
        self._data = data
        self._aliases = aliases

    def model_dump(self, *, mode: str = "python", by_alias: bool = False) -> dict:
        if not by_alias:
            return dict(self._data)
        return {self._aliases.get(key, key): value for key, value in self._data.items()}


class _FakeContent:
    def __init__(self, text: str) -> None:
        self.type = "text"
        self.text = text


class _FakeToolResult:
    def __init__(self, text: str, details: dict | None = None) -> None:
        self.content = [_FakeContent(text)]
        self.details = details


@dataclasses.dataclass
class _FakeToolStart:
    tool_call_id: str
    tool_name: str
    args: dict
    type: str = "tool_execution_start"


@dataclasses.dataclass
class _FakeToolEnd:
    tool_call_id: str
    tool_name: str
    result: object
    is_error: bool = False
    type: str = "tool_execution_end"


@dataclasses.dataclass
class _FakeToolUpdate:
    tool_call_id: str
    partial_result: object
    type: str = "tool_execution_update"


@dataclasses.dataclass
class _FakeMessageUpdate:
    assistant_message_event: object
    message: object = None
    type: str = "message_update"


@dataclasses.dataclass
class _FakeAgentEnd:
    messages: list
    type: str = "agent_end"


class ToJsonableTests(unittest.TestCase):
    def test_alias_flag_switches_naming(self) -> None:
        model = _AliasedModel({"total_tokens": 12}, {"total_tokens": "totalTokens"})
        self.assertEqual(to_jsonable(model, alias=True), {"totalTokens": 12})
        self.assertEqual(to_jsonable(model, alias=False), {"total_tokens": 12})

    def test_handles_paths_dicts_and_nested(self) -> None:
        value = {"file": Path("a/b.txt"), "items": [1, 2], "nested": {"x": (1, 2)}}
        self.assertEqual(
            to_jsonable(value),
            {"file": str(Path("a/b.txt")), "items": [1, 2], "nested": {"x": [1, 2]}},
        )

    def test_never_raises_on_unknown_objects_and_drops_cancel_event(self) -> None:
        @dataclasses.dataclass
        class Weird:
            keep: str = "ok"
            cancel_event: object = None
            _private: int = 1

        self.assertEqual(to_jsonable(Weird()), {"keep": "ok"})

    def test_compact_json_is_single_line_utf8(self) -> None:
        line = compact_json({"text": "中文", "n": 1})
        self.assertNotIn("\n", line)
        self.assertIn("中文", line)
        self.assertEqual(json.loads(line), {"text": "中文", "n": 1})


class ToolResultTests(unittest.TestCase):
    def test_content_text_with_exit_code_and_truncation(self) -> None:
        result = _FakeToolResult("hello", {"exit_code": 0, "truncated": True})
        self.assertEqual(tool_result_text(result), "hello\n\n[exit 0]\n[输出已截断]")

    def test_empty_content_falls_back(self) -> None:
        self.assertEqual(tool_result_text(_FakeToolResult("")), "(无输出)")
        self.assertEqual(tool_result_text(None), "")
        self.assertEqual(tool_result_text("已完成的纯字符串"), "已完成的纯字符串")
        self.assertEqual(tool_result_text({"stdout": "out"}), "out")

    def test_nonzero_exit(self) -> None:
        self.assertEqual(
            tool_result_text(_FakeToolResult("boom", {"exit_code": 2})), "boom\n\n[exit 2]"
        )


class MessageAndStreamTests(unittest.TestCase):
    def test_message_uses_camel_case(self) -> None:
        model = _AliasedModel(
            {"role": "assistant", "stop_reason": "toolUse", "usage": {"total_tokens": 3}},
            {"stop_reason": "stopReason", "usage": "usage", "total_tokens": "totalTokens"},
        )
        payload = message_payload(model)
        # 嵌套的 usage 没有被别名表覆盖，但顶层键必须是 camelCase。
        self.assertEqual(payload["stopReason"], "toolUse")
        self.assertEqual(payload["usage"]["total_tokens"], 3)

    def test_stream_event_keeps_snake_case(self) -> None:
        event = _AliasedModel(
            {"type": "text_delta", "content_index": 0, "delta": "你好"},
            {"content_index": "contentIndex"},
        )
        self.assertEqual(
            stream_event_payload(event),
            {"type": "text_delta", "content_index": 0, "delta": "你好"},
        )


class EventPayloadTests(unittest.TestCase):
    def test_tool_execution_start_keeps_raw_args(self) -> None:
        payload = event_payload(
            _FakeToolStart("call_1", "read", {"path": "a.txt", "limit": 10})
        )
        assert payload is not None
        self.assertEqual(payload["type"], "tool_execution_start")
        self.assertEqual(payload["tool_call_id"], "call_1")
        self.assertEqual(payload["args"], {"path": "a.txt", "limit": 10})

    def test_tool_execution_end_compresses_result_to_string(self) -> None:
        payload = event_payload(
            _FakeToolEnd("call_1", "bash", _FakeToolResult("done", {"exit_code": 0}))
        )
        assert payload is not None
        self.assertEqual(payload["result"], "done\n\n[exit 0]")
        self.assertFalse(payload["is_error"])
        self.assertEqual(payload["details"], {"exit_code": 0})

    def test_tool_execution_update_keeps_structured_progress_details(self) -> None:
        payload = event_payload(_FakeToolUpdate(
            "agent_1",
            _FakeToolResult("子 Agent 运行中", {
                "context_usage": {
                    "context_tokens": 4321,
                    "output_tokens": 123,
                    "estimated": True,
                },
            }),
        ))
        assert payload is not None
        self.assertEqual(payload["partial_result"], "子 Agent 运行中")
        self.assertEqual(payload["details"]["context_usage"]["context_tokens"], 4321)

    def test_message_update_sends_only_delta_and_backend_usage(self) -> None:
        message = _AliasedModel({"role": "assistant"}, {"role": "role"})
        stream = _AliasedModel({"type": "thinking_delta", "content_index": 1}, {})
        event = _FakeMessageUpdate(assistant_message_event=stream, message=message)
        event.context_usage = dataclasses.make_dataclass(
            "Usage", [("context_tokens", int), ("output_tokens", int), ("estimated", bool)]
        )(120, 7, True)
        payload = event_payload(event)
        assert payload is not None
        self.assertNotIn("message", payload)
        self.assertEqual(payload["assistant_message_event"]["content_index"], 1)
        self.assertEqual(payload["context_usage"]["context_tokens"], 120)

    def test_message_update_size_does_not_grow_with_partial_message(self) -> None:
        from fox_ai.src import AssistantMessage, ToolCall
        from fox_ai.src.events import ToolCallDeltaEvent
        message = AssistantMessage(content=[ToolCall(
            id="write-1", name="write", arguments={"path": "index.html", "content": "x" * 100_000},
        )])
        stream = ToolCallDeltaEvent(content_index=0, delta="{}", partial=message)
        payload = event_payload(_FakeMessageUpdate(assistant_message_event=stream, message=message))
        assert payload is not None
        self.assertLess(len(compact_json(payload)), 500)
        self.assertNotIn("partial", payload["assistant_message_event"])

    def test_compaction_payload_uses_backend_counts_without_retained_messages(self) -> None:
        result = dataclasses.make_dataclass(
            "Result",
            [("summary", str), ("retained_tail", list), ("removed_count", int)],
        )("summary", [1, 2, 3], 7)
        event = dataclasses.make_dataclass(
            "Compaction",
            [
                ("result", object),
                ("pre_tokens", int),
                ("post_tokens", int),
                ("summary_tokens", int),
                ("automatic", bool),
                ("type", str, dataclasses.field(default="compaction_end")),
            ],
        )(result, 1000, 200, 30, True)
        payload = event_payload(event)
        assert payload is not None
        self.assertEqual(payload["preTokens"], 1000)
        self.assertEqual(payload["postTokens"], 200)
        self.assertEqual(payload["summaryTokens"], 30)
        self.assertEqual(payload["removedCount"], 7)
        self.assertEqual(payload["retainedCount"], 3)
        self.assertNotIn("result", payload)

    def test_agent_end_omits_full_history(self) -> None:
        payload = event_payload(_FakeAgentEnd(messages=[1, 2, 3]))
        self.assertEqual(payload, {"type": "agent_end"})

    def test_unknown_and_before_prompt_are_dropped(self) -> None:
        self.assertIsNone(event_payload(object()))

        @dataclasses.dataclass
        class BeforePrompt:
            message: str = "hi"
            type: str = "before_prompt"

        self.assertIsNone(event_payload(BeforePrompt()))

    def test_protocol_version_is_three(self) -> None:
        self.assertEqual(PROTOCOL_VERSION, 3)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
