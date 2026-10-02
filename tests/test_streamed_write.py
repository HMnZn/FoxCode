"""Exercise file-generation streams, including immediately buffered SDK chunks."""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

from fox_ai.src import Context, SimpleStreamOptions, UserMessage
from fox_ai.src.partial_json import parse_partial_json, parse_tool_arguments
from fox_ai.src.providers.openai_provider import OPENAI_MODELS, openai_api_provider
from fox_coding_agent.src import AgentSession, AgentSessionConfig


HTML = '<!doctype html><style>.wheel {transform: rotate(360deg)}</style>\n' + (
    '<svg><text>鹈鹕 🚲</text><path d="M 0 0 L 10 20"/></svg>\n' * 400
)


class PartialJsonTests(unittest.TestCase):
    def test_every_prefix_of_code_preserves_string_content(self):
        content = '<style>x {color: red}</style>\n"quote" \\ unicode 骑行 🚲'
        raw = json.dumps({"path": "index.html", "content": content}, ensure_ascii=True)
        for index in range(len(raw) + 1):
            preview = parse_partial_json(raw[:index])
            if isinstance(preview.get("content"), str):
                # A split surrogate pair may expose only its high surrogate.
                value = preview["content"].encode("utf-16-le", errors="surrogatepass")
                self.assertTrue(content.encode("utf-16-le").startswith(value), (index, preview))
        self.assertEqual(parse_tool_arguments(raw)["content"], content)

    def test_final_arguments_are_not_repaired(self):
        for raw in ('{"path":"index.html","content":"unfinished', '[]', '{"x": 1,}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                parse_tool_arguments(raw)

    def test_provider_raw_control_characters_inside_strings_are_preserved(self):
        raw = '{"summary":"first line\nsecond line","steps":["inspect\tthen write"]}'
        expected = {
            "summary": "first line\nsecond line",
            "steps": ["inspect\tthen write"],
        }
        self.assertEqual(parse_partial_json(raw), expected)
        self.assertEqual(parse_tool_arguments(raw), expected)


def chunk(arguments=None, *, first=False, finish=None, text=None):
    tool = None if arguments is None else [NS(
        index=0, id="write-1" if first else None,
        function=NS(name="write" if first else None, arguments=arguments),
    )]
    return NS(usage=None, choices=[NS(finish_reason=finish, delta=NS(content=text, tool_calls=tool))])


class BufferedResponse:
    def __init__(self, chunks):
        self.chunks = iter(chunks)
        self.delivered = 0
        self.close = AsyncMock()

    def __aiter__(self):
        return self

    async def __anext__(self):
        # Mirrors SDK chunks already in its network buffer: no await here.
        try:
            value = next(self.chunks)
        except StopIteration:
            raise StopAsyncIteration
        self.delivered += 1
        return value


class StreamedWriteTests(unittest.IsolatedAsyncioTestCase):
    def make_response(self, raw):
        parts = [raw[i:i + 32] for i in range(0, len(raw), 32)]
        return BufferedResponse([chunk(part, first=i == 0) for i, part in enumerate(parts)]
                                + [chunk(finish="tool_calls")])

    def client(self, *responses):
        return NS(close=AsyncMock(), chat=NS(completions=NS(create=AsyncMock(side_effect=responses))))

    async def test_buffered_html_tool_call_writes_exact_bytes_and_keeps_loop_alive(self):
        raw = json.dumps({"path": "index.html", "content": HTML}, ensure_ascii=False)
        response = self.make_response(raw)
        final = BufferedResponse([chunk(text="Created index.html"), chunk(finish="stop")])
        client = self.client(response, final)
        with tempfile.TemporaryDirectory() as directory:
            session = AgentSession(AgentSessionConfig(
                model=OPENAI_MODELS[0], cwd=directory, skills=[],
                stream_fn=openai_api_provider.stream_simple,
                stream_options={"api_key": "test"}, model_retry_attempts=0,
            ))
            observed = []
            session.subscribe(lambda event, cancel: observed.append(response.delivered)
                              if event.type == "message_update" else None)
            with patch("fox_ai.src.providers.openai_provider._create_client", return_value=client):
                await asyncio.wait_for(session.prompt("Create index.html"), 10)
            self.assertEqual((Path(directory) / "index.html").read_bytes(), HTML.encode())
            self.assertTrue(any(0 < count < response.delivered // 2 for count in observed),
                            "Buffered provider starved the agent until the entire file arrived")
            response.close.assert_awaited_once()

    async def test_abort_during_buffered_tool_arguments_closes_stream_before_write(self):
        response = self.make_response(json.dumps({"path": "index.html", "content": HTML}))
        client = self.client(response)
        with tempfile.TemporaryDirectory() as directory:
            session = AgentSession(AgentSessionConfig(
                model=OPENAI_MODELS[0], cwd=directory, skills=[],
                stream_fn=openai_api_provider.stream_simple,
                stream_options={"api_key": "test"}, model_retry_attempts=0,
            ))

            def on_event(event, cancel):
                if event.type == "message_update" and event.assistant_message_event.type == "toolcall_delta":
                    session.abort()

            session.subscribe(on_event)
            with patch("fox_ai.src.providers.openai_provider._create_client", return_value=client):
                await asyncio.wait_for(session.prompt("Create index.html"), 3)
            self.assertFalse((Path(directory) / "index.html").exists())
            assistant = next(message for message in reversed(session.state.messages)
                             if message.role == "assistant")
            self.assertEqual(assistant.stop_reason, "aborted")
            self.assertLess(response.delivered, 100)
            response.close.assert_awaited_once()

    async def test_invalid_complete_write_arguments_become_error(self):
        response = self.make_response('{"path":"index.html","content":"truncated')
        with patch("fox_ai.src.providers.openai_provider._create_client", return_value=self.client(response)):
            stream = openai_api_provider.stream_simple(
                OPENAI_MODELS[0], Context(messages=[UserMessage(content="write")]),
                SimpleStreamOptions(api_key="test"),
            )
            result = await stream.result()
            await stream.aclose()
        self.assertEqual(result.stop_reason, "error")

    async def test_anthropic_complete_and_truncated_file_arguments(self):
        from fox_ai.src.providers.anthropic_provider import ANTHROPIC_MODELS, anthropic_api_provider
        raw = json.dumps({"path": "index.html", "content": HTML})
        for arguments, reason, expected in ((raw, "tool_use", "toolUse"),
                                            (raw[:-10], "tool_use", "error"),
                                            (raw[:-10], "max_tokens", "length")):
            with self.subTest(reason=reason, expected=expected):
                response = BufferedResponse([
                    NS(type="message_start"),
                    NS(type="content_block_start", index=0,
                       content_block=NS(type="tool_use", id="w", name="write", input={})),
                    NS(type="content_block_delta", index=0,
                       delta=NS(type="input_json_delta", partial_json=arguments)),
                    NS(type="content_block_stop", index=0),
                    NS(type="message_delta", delta=NS(stop_reason=reason)),
                    NS(type="message_stop"),
                ])
                client = NS(close=AsyncMock(), messages=NS(create=AsyncMock(return_value=response)))
                with patch("fox_ai.src.providers.anthropic_provider._create_client", return_value=client):
                    stream = anthropic_api_provider.stream_simple(
                        ANTHROPIC_MODELS[0], Context(messages=[UserMessage(content="write")]),
                        SimpleStreamOptions(api_key="test"),
                    )
                    result = await stream.result()
                    await stream.aclose()
                self.assertEqual(result.stop_reason, expected)
                if expected == "toolUse":
                    self.assertEqual(result.content[0].arguments["content"], HTML)
