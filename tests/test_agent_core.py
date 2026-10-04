"""内核回归测试：全部离线，不需要 API key，也不会调用真实模型。"""

import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fox_ai.src import AssistantMessage, EventStream, StartEvent, TextContent, ThinkingContent, ToolCall, ToolResultMessage, UserMessage
from fox_ai.src.providers.faux import FAUX_MODEL, FauxScript, clear_scripts, faux_api_provider, push_script
from fox_agent_core.src import (
    Agent, AgentOptions, AgentContext, AgentLoopConfig, AgentState, AgentToolResult, agent_loop, agent_loop_continue
)
from fox_coding_agent.src import (
    AgentSession, AgentSessionConfig, CompactionSettings, SessionManager, JsonlSessionStorage, compact, find_cut_point
)
from fox_agent_core.src.harness import estimate_tokens


def scripted(*scripts):
    contexts, options = [], []
    queue = list(scripts)

    def stream(model, context, opts):
        contexts.append(context.model_copy(deep=True))
        options.append(opts)
        if not queue:
            raise AssertionError("Unexpected extra model request")
        push_script(queue.pop(0))
        return faux_api_provider.stream_simple(model, context, opts)

    stream.contexts, stream.options = contexts, options
    return stream


def make_agent(stream, tools=None, **options):
    return Agent(AgentOptions(initial_state={"model": FAUX_MODEL, "tools": tools or []}, stream_fn=stream, **options))


def tool_fixture(name, description, parameters, handler, execution_mode=None):
    """Test-only structural AgentTool fixture; execute handlers are asynchronous."""
    return SimpleNamespace(name=name, label=name, description=description, parameters=parameters,
                           execute=handler, execution_mode=execution_mode)


def echo_tool(handler=None, mode=None):
    async def echo(call_id, args, cancel, update):
        return AgentToolResult([TextContent(text=args["value"])])

    return tool_fixture("echo", "Echo text", {"type": "object", "properties": {"value": {"type": "string"}},
                        "required": ["value"], "additionalProperties": False}, handler or echo, execution_mode=mode)


def call(id="a", value="hello"):
    return ToolCall(id=id, name="echo", arguments={"value": value})


class AgentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        clear_scripts()

    def test_hidden_thinking_is_not_counted_as_replayed_context(self):
        message = AssistantMessage(content=[
            ThinkingContent(thinking="x" * 400),
            TextContent(text="answer"),
        ])
        without_thinking = estimate_tokens(message)
        with_thinking = estimate_tokens(message, include_thinking=True)
        self.assertGreater(with_thinking, without_thinking + 90)

    async def test_tool_round_trip_and_progress_order(self):
        async def execute(id, args, cancel, update):
            update(AgentToolResult([TextContent(text="first")]))
            update(AgentToolResult([TextContent(text="second")]))
            return AgentToolResult([TextContent(text="result")], added_tool_names=["new"])

        stream = scripted(FauxScript(tool_calls=[call()]), FauxScript(text="done"))
        agent = make_agent(stream, [echo_tool(execute)])
        events = []

        async def listener(event, cancel):
            if event.type == "tool_execution_update":
                await asyncio.sleep(0.001)
            events.append(event)

        agent.subscribe(listener)
        await agent.prompt("run")
        self.assertEqual([m.role for m in agent.state.messages], ["user", "assistant", "toolResult", "assistant"])
        self.assertEqual(agent.state.messages[2].added_tool_names, ["new"])
        tool_events = [e.type for e in events if e.type.startswith("tool_execution")]
        self.assertEqual(tool_events, ["tool_execution_start", "tool_execution_update", "tool_execution_update", "tool_execution_end"])
        self.assertEqual([m.role for m in stream.contexts[1].messages], ["user", "assistant", "toolResult"])
        self.assertLess(abs(agent.state.messages[0].timestamp - time.time() * 1000), 5000)
        self.assertFalse(agent.is_running)
        self.assertFalse(agent.state.pending_tool_calls)

    async def test_invalid_arguments_and_missing_tool_are_results(self):
        stream = scripted(FauxScript(tool_calls=[call(value=42), ToolCall(id="b", name="missing", arguments={})]), FauxScript(text="fixed"))
        agent = make_agent(stream, [echo_tool()])
        await agent.prompt("run")
        results = [m for m in agent.state.messages if isinstance(m, ToolResultMessage)]
        self.assertTrue(all(m.is_error for m in results))
        self.assertIn("Invalid arguments", results[0].content[0].text)
        self.assertIn("not found", results[1].content[0].text)

    async def test_truncated_calls_are_paired_and_not_executed(self):
        stream = scripted(FauxScript(tool_calls=[call()], stop_reason="length"))
        agent = make_agent(stream, [echo_tool()])
        events = []
        agent.subscribe(lambda event, cancel: events.append(event.type))
        await agent.prompt("run")
        self.assertTrue(agent.state.messages[-1].is_error)
        self.assertIn("truncated", agent.state.messages[-1].content[0].text)
        self.assertEqual(events.count("tool_execution_start"), 0)
        self.assertEqual(events.count("tool_execution_end"), 0)
        self.assertEqual(len(stream.contexts), 1)

    async def test_steering_before_follow_up_and_one_at_a_time(self):
        stream = scripted(*(FauxScript(text="ok") for _ in range(4)))
        agent = make_agent(stream)
        agent.steer("steer 1")
        agent.steer("steer 2")
        agent.follow_up("follow 1")
        agent.follow_up("follow 2")
        await agent.prompt("begin")
        users = [m.content[0].text for m in agent.state.messages if isinstance(m, UserMessage)]
        self.assertEqual(users, ["begin", "steer 1", "steer 2", "follow 1", "follow 2"])
        self.assertEqual(len(stream.contexts), 4)
        self.assertFalse(agent.has_queued_messages())

    async def test_promote_follow_ups_moves_every_pending_message_to_steering(self):
        stream = scripted(FauxScript(text="ok"))
        agent = make_agent(stream)
        agent.follow_up("follow 1")
        agent.follow_up("follow 2")

        self.assertEqual(agent.promote_follow_ups(), 2)
        agent.steer("interrupt now")
        await agent.prompt("begin")

        users = [m.content[0].text for m in agent.state.messages if isinstance(m, UserMessage)]
        self.assertEqual(users, ["begin", "follow 1", "follow 2", "interrupt now"])
        self.assertEqual(len(stream.contexts), 1)
        self.assertFalse(agent.has_queued_messages())

    async def test_continue_consumes_only_one_initial_steering(self):
        stream = scripted(*(FauxScript(text="ok") for _ in range(3)))
        agent = make_agent(stream)
        await agent.prompt("start")
        agent.steer("one")
        agent.steer("two")
        await agent.continue_()
        self.assertEqual(len(stream.contexts), 3)
        self.assertEqual(stream.contexts[1].messages[-1].content[0].text, "one")

    async def test_prepare_hooks_and_stream_options(self):
        prepares, turns = [], []

        def prepare(request):
            prepares.append(request["turn_index"])

        def next_turn(request):
            turns.append(request["message"])
            return {"context": request["context"], "thinkingLevel": "high"}

        stream = scripted(FauxScript(tool_calls=[call()]), FauxScript(text="done"))
        agent = make_agent(stream, [echo_tool()], prepare_request=prepare, prepare_next_turn=next_turn,
                           api_key="test-key", temperature=0.25, max_tokens=77, session_id="abc", max_retries=2)
        await agent.prompt("run")
        self.assertEqual(prepares, [0, 1])
        self.assertEqual(len(turns), 1)
        self.assertEqual(stream.options[0].session_id, "abc")
        self.assertEqual(stream.options[0].max_tokens, 77)
        self.assertEqual(stream.options[0].max_retries, 2)
        self.assertEqual(stream.options[1].reasoning, "high")
        self.assertEqual(agent.state.thinking_level, "high")

    async def test_silent_model_stream_times_out_and_closes(self):
        closed = asyncio.Event()

        def stalled_stream(model, context, options):
            stream = EventStream()

            async def wait_forever():
                try:
                    await asyncio.Event().wait()
                finally:
                    closed.set()

            stream.set_producer(asyncio.create_task(wait_forever()))
            return stream

        agent = make_agent(stalled_stream, stream_options={"timeout_ms": 10})
        await agent.prompt("do not hang")
        self.assertTrue(closed.is_set())
        self.assertEqual(agent.state.messages[-1].stop_reason, "error")
        self.assertIn("produced no event", agent.state.messages[-1].error_message)

    async def test_abort_model_closes_producer(self):
        started, closed = asyncio.Event(), asyncio.Event()

        def stream(model, context, opts):
            es = EventStream()

            async def produce():
                try:
                    es.push(StartEvent(partial=AssistantMessage()))
                    started.set()
                    await asyncio.Event().wait()
                finally:
                    closed.set()

            es.set_producer(asyncio.create_task(produce()))
            return es

        agent = make_agent(stream)
        task = asyncio.create_task(agent.prompt("run"))
        await started.wait()
        agent.abort()
        await asyncio.wait_for(task, 2)
        self.assertTrue(closed.is_set())
        self.assertEqual(agent.state.messages[-1].stop_reason, "aborted")

    async def test_abort_tools_pairs_entire_batch(self):
        for mode in ("sequential", "parallel"):
            with self.subTest(mode=mode):
                entered, cleaned = asyncio.Event(), []

                async def execute(id, args, cancel, update):
                    entered.set()
                    try:
                        await asyncio.Event().wait()
                    finally:
                        cleaned.append(id)

                stream = scripted(FauxScript(tool_calls=[call("a"), call("b")]))
                agent = make_agent(stream, [echo_tool(execute)], tool_execution=mode)
                task = asyncio.create_task(agent.prompt("run"))
                await entered.wait()
                agent.abort()
                await asyncio.wait_for(task, 2)
                results = [m for m in agent.state.messages if isinstance(m, ToolResultMessage)]
                self.assertEqual([r.tool_call_id for r in results], ["a", "b"])
                self.assertTrue(all(r.is_error for r in results))
                self.assertTrue(all(
                    "agent run was interrupted" in r.content[0].text for r in results
                ))
                self.assertTrue(cleaned)
                self.assertFalse(agent.state.pending_tool_calls)

    async def test_caller_cancellation_cleans_up(self):
        entered, closed = asyncio.Event(), asyncio.Event()

        async def execute(id, args, cancel, update):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                closed.set()

        agent = make_agent(scripted(FauxScript(tool_calls=[call()])), [echo_tool(execute)])
        task = asyncio.create_task(agent.prompt("run"))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(closed.is_set())
        self.assertFalse(agent.is_running)
        self.assertTrue(agent.state.messages[-1].is_error)

    async def test_limit_and_block_terminate(self):
        stream = scripted(FauxScript(tool_calls=[call()]), FauxScript(tool_calls=[call("b")]))
        agent = make_agent(stream, [echo_tool()], max_turns=2)
        await agent.prompt("loop")
        self.assertIn("Maximum", agent.state.error_message)
        self.assertEqual(len(stream.contexts), 2)
        blocked = make_agent(scripted(FauxScript(tool_calls=[call()])), [echo_tool()],
                             before_tool_call=lambda ctx, cancel: {"block": True, "terminate": True})
        await blocked.prompt("run")
        self.assertTrue(blocked.state.messages[-1].is_error)

    async def test_result_without_terminal_event_and_low_level_snapshot(self):
        def stream(model, context, opts):
            es = EventStream()
            es.end(AssistantMessage(content=[TextContent(text="done")], stop_reason="stop"))
            return es

        context = AgentContext("", [UserMessage(content="begin")])
        es = agent_loop_continue(context, AgentLoopConfig(model=FAUX_MODEL), stream_fn=stream)
        events = [event async for event in es]
        self.assertEqual(len(context.messages), 1)
        self.assertEqual(len(await es.result()), 1)
        self.assertEqual([e.type for e in events], ["agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end"])

    async def test_limit_does_not_drop_consumed_steering(self):
        stream = scripted(FauxScript(text="ok"))
        agent = make_agent(stream, max_turns=1)
        agent.steer("first")
        agent.steer("second")
        await agent.prompt("begin")
        users = [m.content[0].text for m in agent.state.messages if isinstance(m, UserMessage)]
        self.assertIn("second", users)
        self.assertIn("Maximum", agent.state.error_message)

    async def test_thinking_off_clears_stream_option_and_stop_hook_can_abort(self):
        stream = scripted(FauxScript(tool_calls=[call()]), FauxScript(text="done"))
        agent = make_agent(stream, [echo_tool()], reasoning="high",
                           prepare_next_turn=lambda ctx: {"thinkingLevel": "off"})
        await agent.prompt("run")
        self.assertEqual(stream.options[0].reasoning, "high")
        self.assertIsNone(stream.options[1].reasoning)
        entered = asyncio.Event()

        async def stop(ctx):
            entered.set()
            await asyncio.Event().wait()

        agent = make_agent(scripted(FauxScript(text="done")), should_stop_after_turn=stop)
        task = asyncio.create_task(agent.prompt("run"))
        await entered.wait()
        agent.abort()
        await asyncio.wait_for(task, 2)
        self.assertFalse(agent.is_running)

    async def test_listener_failure_is_not_hidden(self):
        agent = make_agent(scripted(FauxScript(text="ok")))

        def fail(event, cancel):
            if event.type == "message_end":
                raise OSError("disk failed")

        agent.subscribe(fail)
        with self.assertRaisesRegex(RuntimeError, "disk failed"):
            await agent.prompt("run")
        self.assertFalse(agent.is_running)


class SessionAndHarnessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        clear_scripts()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)

    async def test_jsonl_branch_compaction_reload_and_write_failure(self):
        file = self.path / "session.jsonl"
        session = SessionManager(JsonlSessionStorage(file))
        first = session.append_message(UserMessage(content="first"))
        session.append_message(AssistantMessage(content=[TextContent(text="answer")], stop_reason="stop"))
        session.append_compaction("summary", [UserMessage(content="tail")])
        restored = SessionManager(JsonlSessionStorage(file))
        self.assertEqual(len(restored.build_context()), 2)
        self.assertIn("summary", restored.build_context()[0].content)
        restored.move_to(first.id)
        restored.append_message(UserMessage(content="branch"))
        self.assertEqual(len(restored.build_context()), 2)
        before = file.read_bytes()
        count = len(restored.get_entries())
        with patch("fox_coding_agent.src.core.session_manager.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                restored.append_message(UserMessage(content="lost"))
        self.assertEqual(file.read_bytes(), before)
        self.assertEqual(len(restored.get_entries()), count)
        with self.assertRaises(ValueError):
            restored.move_to("missing")

    async def test_empty_aborted_assistant_is_audited_but_not_replayed(self):
        """An immediate steer can abort before the first model delta arrives.

        Keep that terminal event in the durable session for diagnostics, but do
        not send an invalid ``assistant(content=[])`` back to OpenAI-compatible
        providers on the resumed request.
        """

        file = self.path / "session.jsonl"
        session = SessionManager(JsonlSessionStorage(file))
        session.append_message(UserMessage(content="long request"))
        session.append_message(
            AssistantMessage(content=[], stop_reason="aborted", error_message="Operation aborted")
        )
        session.append_message(UserMessage(content="interrupt now"))

        restored = SessionManager(JsonlSessionStorage(file))
        self.assertEqual(len(restored.get_entries()), 3)
        context = restored.build_context()
        self.assertEqual([message.role for message in context], ["user", "user"])
        self.assertEqual(context[-1].content, "interrupt now")

        # The same guard applies when an old compaction retained an empty
        # assistant message.
        restored.append_compaction(
            "summary",
            [AssistantMessage(content=[], stop_reason="error", error_message="provider failed")],
        )
        compacted = restored.build_context()
        self.assertEqual(len(compacted), 1)
        self.assertIn("summary", compacted[0].content)

    async def test_reasoning_only_abort_after_tools_can_resume_and_reload(self):
        session = SessionManager(JsonlSessionStorage(self.path / "reasoning-abort.jsonl"))
        session.append_message(UserMessage(content="make an html page"))
        session.append_message(AssistantMessage(content=[call()], stop_reason="toolUse"))
        session.append_message(ToolResultMessage(
            tool_call_id="a", tool_name="echo", content=[TextContent(text="file read")],
        ))
        interrupted = AssistantMessage(
            content=[ThinkingContent(thinking="I will now update that file"), TextContent(text="")],
            stop_reason="aborted", error_message="Operation aborted",
        )
        session.append_message(interrupted)
        stream = scripted(FauxScript(text="dynamic page ready"))
        harness = AgentSession(AgentSessionConfig(
            model=FAUX_MODEL, session=session, cwd=self.path, skills=[],
            tools=[echo_tool()], stream_fn=stream,
        ))
        harness.steer("make it dynamic")
        await harness.continue_()
        self.assertEqual([m.role for m in stream.contexts[0].messages],
                         ["user", "assistant", "toolResult", "user"])
        restored = SessionManager(JsonlSessionStorage(self.path / "reasoning-abort.jsonl"))
        self.assertTrue(any(e.type == "message" and e.data == interrupted for e in restored.get_entries()))
        self.assertEqual(restored.build_context()[-1].content[0].text, "dynamic page ready")
        restored.append_compaction("summary", [interrupted])
        self.assertEqual(len(restored.build_context()), 1)

    async def test_reasoning_only_success_is_audited_but_not_replayed(self):
        session = SessionManager(JsonlSessionStorage(self.path / "reasoning-only-stop.jsonl"))
        session.append_message(UserMessage(content="finish the report"))
        reasoning_only = AssistantMessage(
            content=[ThinkingContent(thinking="unfinished private reasoning")],
            stop_reason="stop",
        )
        session.append_message(reasoning_only)

        self.assertEqual([message.role for message in session.build_context()], ["user"])
        self.assertTrue(any(
            entry.type == "message" and entry.data == reasoning_only
            for entry in session.get_entries()
        ))

    async def test_failed_partial_tool_call_and_result_are_not_replayed(self):
        session = SessionManager(JsonlSessionStorage(self.path / "partial-error.jsonl"))
        session.append_message(UserMessage(content="verify in browser"))
        session.append_message(AssistantMessage(
            content=[ToolCall(id="partial", name="browser_evaluate", arguments={})],
            stop_reason="error",
            error_message="connection error: Connection error.",
        ))
        session.append_message(ToolResultMessage(
            tool_call_id="partial",
            tool_name="browser_evaluate",
            content=[TextContent(text="Tool call was not executed because the response failed or was aborted")],
            is_error=True,
        ))

        self.assertEqual([message.role for message in session.build_context()], ["user"])
        self.assertEqual(len(session.get_entries()), 3)

    async def test_harness_persists_tools_and_restores_configuration(self):
        file = self.path / "session.jsonl"
        stream = scripted(FauxScript(tool_calls=[ToolCall(id="w", name="write", arguments={"path": "demo.txt", "content": "hello"})]), FauxScript(text="done"))
        harness = AgentSession(AgentSessionConfig(model=FAUX_MODEL, session=SessionManager(JsonlSessionStorage(file)),
                               cwd=self.path, skills=[], stream_fn=stream))
        harness.set_thinking_level("high")
        harness.set_active_tools(["read", "write"])
        await harness.prompt("write file")
        self.assertEqual((self.path / "demo.txt").read_text(), "hello")
        restored = AgentSession(AgentSessionConfig(session=SessionManager(JsonlSessionStorage(file)), cwd=self.path,
                                skills=[], stream_fn=scripted(FauxScript(text="welcome back"))))
        self.assertEqual(restored.state.thinking_level, "high")
        self.assertEqual([t.name for t in restored.state.tools], ["read", "write"])
        self.assertEqual(len(restored.state.messages), 4)
        await restored.prompt("next")
        self.assertEqual(len(restored.state.messages), 6)
        fork = restored.fork()
        fork.state.messages[0].content[0].text = "changed"
        self.assertNotEqual(restored.state.messages[0].content[0].text, "changed")

    async def test_interrupted_tool_is_not_replayed(self):
        session = SessionManager()
        session.append_message(UserMessage(content="write"))
        session.append_message(AssistantMessage(content=[call()], stop_reason="toolUse"))
        harness = AgentSession(AgentSessionConfig(model=FAUX_MODEL, session=session, tools=[echo_tool()], skills=[],
                               stream_fn=scripted(FauxScript(text="inspect before retry"))))
        self.assertTrue(harness.state.messages[-1].is_error)
        await harness.continue_()
        self.assertEqual(harness.state.messages[-1].content[0].text, "inspect before retry")

    async def test_auto_compaction_before_first_request(self):
        session = SessionManager()
        for _ in range(4):
            session.append_message(UserMessage(content="x" * 1200))
            session.append_message(AssistantMessage(content=[TextContent(text="old answer")], stop_reason="stop"))
        summarized = []

        async def summary(model, messages, **options):
            summarized.extend(messages)
            return "Previous work and next steps"

        stream = scripted(FauxScript(text="done"))
        harness = AgentSession(AgentSessionConfig(model=FAUX_MODEL.model_copy(update={"context_window": 1000, "max_tokens": 50}),
                               session=session, tools=[], skills=[], stream_fn=stream, summary_fn=summary,
                               compaction=CompactionSettings(reserve_tokens=200, keep_recent_tokens=80)))
        events = []
        harness.subscribe(lambda event, cancel: events.append(event.type))
        await harness.prompt("continue task")
        self.assertTrue(summarized)
        self.assertIn("Previous work", stream.contexts[0].messages[0].content)
        self.assertEqual(events.count("compaction_end"), 1)
        self.assertTrue(any(e.type == "compaction" for e in session.get_entries()))
        self.assertEqual(harness.state.messages, session.build_context())

    async def test_backend_attaches_live_context_usage_to_stream_updates(self):
        harness = AgentSession(
            AgentSessionConfig(
                model=FAUX_MODEL,
                tools=[],
                skills=[],
                stream_fn=scripted(FauxScript(text="streaming token accounting")),
            )
        )
        snapshots = []
        harness.subscribe(
            lambda event, cancel: snapshots.append(event.context_usage)
            if event.type == "message_update" and event.context_usage is not None
            else None
        )
        await harness.prompt("count in backend")
        self.assertTrue(snapshots)
        self.assertTrue(all(snapshot.estimated for snapshot in snapshots))
        self.assertGreater(snapshots[-1].context_tokens, 0)
        self.assertGreater(snapshots[-1].output_tokens, 0)

    async def test_compaction_streams_progress_from_backend(self):
        session = SessionManager()
        for _ in range(4):
            session.append_message(UserMessage(content="old context " * 300))
            session.append_message(
                AssistantMessage(content=[TextContent(text="old answer")], stop_reason="stop")
            )
        stream = scripted(
            FauxScript(text="incremental summary"),
            FauxScript(text="done"),
        )
        harness = AgentSession(
            AgentSessionConfig(
                model=FAUX_MODEL.model_copy(
                    update={"context_window": 1800, "max_tokens": 50}
                ),
                session=session,
                tools=[],
                skills=[],
                stream_fn=stream,
                compaction=CompactionSettings(
                    reserve_tokens=300, keep_recent_tokens=80
                ),
            )
        )
        progress = []
        harness.subscribe(
            lambda event, cancel: progress.append(event.summary_tokens)
            if event.type == "compaction_update"
            else None
        )
        await harness.prompt("continue")
        self.assertTrue(progress)
        self.assertGreater(progress[-1], 0)

    async def test_auto_compaction_runs_between_tool_turns(self):
        async def large_result(call_id, args, cancel, update):
            return AgentToolResult([TextContent(text="x" * 3000)])

        tool = tool_fixture(
            "large",
            "Return a large result",
            {"type": "object", "properties": {}, "additionalProperties": False},
            large_result,
        )
        summarized = []

        async def summary(model, messages, **options):
            summarized.extend(messages)
            return "Earlier tool task"

        stream = scripted(
            FauxScript(tool_calls=[ToolCall(id="big", name="large", arguments={})]),
            FauxScript(text="done after compact"),
        )
        harness = AgentSession(
            AgentSessionConfig(
                model=FAUX_MODEL.model_copy(
                    update={"context_window": 1200, "max_tokens": 50}
                ),
                tools=[tool],
                skills=[],
                stream_fn=stream,
                summary_fn=summary,
                compaction=CompactionSettings(
                    reserve_tokens=400, keep_recent_tokens=80
                ),
            )
        )
        events = []
        harness.subscribe(lambda event, cancel: events.append(event.type))
        await harness.prompt("run tool")
        self.assertEqual(len(stream.contexts), 2)
        self.assertTrue(summarized)
        self.assertLess(
            events.index("tool_execution_end"), events.index("compaction_start")
        )
        self.assertLess(events.index("compaction_end"), events.index("agent_end"))

    async def test_failed_summary_preserves_context(self):
        async def summary(model, messages, **options):
            return ""

        session = SessionManager()
        session.append_message(UserMessage(content="old " * 100))
        session.append_message(UserMessage(content="recent"))
        harness = AgentSession(AgentSessionConfig(model=FAUX_MODEL, session=session, tools=[], skills=[], summary_fn=summary,
                               compaction=CompactionSettings(keep_recent_tokens=10)))
        before = session.leaf_id
        with self.assertRaisesRegex(ValueError, "empty"):
            await harness.compact()
        self.assertEqual(session.leaf_id, before)
        self.assertFalse(harness.is_running)

    async def test_compaction_checks_new_follow_up_input(self):
        stream = scripted(FauxScript(text="x" * 200), FauxScript(text="done"))

        async def summary(model, messages, **options):
            return "Earlier work"

        harness = AgentSession(AgentSessionConfig(model=FAUX_MODEL.model_copy(update={"context_window": 600, "max_tokens": 50}),
                               tools=[], skills=[], stream_fn=stream, summary_fn=summary,
                               compaction=CompactionSettings(reserve_tokens=200, keep_recent_tokens=80)))
        harness.follow_up("q" * 1400)
        await harness.prompt("begin")
        self.assertEqual(len(stream.contexts), 2)
        self.assertIn("Earlier work", stream.contexts[1].messages[0].content)
        self.assertEqual(stream.contexts[1].messages[-1].content[0].text, "q" * 1400)

    async def test_cut_preserves_tool_group(self):
        messages = [UserMessage(content="old" * 100), AssistantMessage(content=[call()], stop_reason="toolUse"),
                    ToolResultMessage(tool_call_id="a", tool_name="echo", content=[TextContent(text="result")])]
        self.assertEqual(find_cut_point(messages, 1), 1)
        self.assertEqual(find_cut_point(messages[2:], 1), 0)


if __name__ == "__main__":
    unittest.main()
