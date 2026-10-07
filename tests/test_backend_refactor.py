"""Behavioral contracts for consolidated persistence, tools and retry waits."""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fox_ai.src import ApiKeyCredential, AssistantMessage, UserMessage
from fox_ai.src.provider_retry import retry_provider_request
from fox_ai.src.retry import RetryCallbacks, RetryPolicy, retry_assistant_call
from fox_ai.src.providers.faux import FAUX_MODEL
from fox_coding_agent.src import (
    AgentSession, AgentSessionConfig, CredentialStore, InMemorySessionStorage,
    JsonlSessionStorage, ReadTool, SessionManager,
)
from fox_coding_agent.src.core._io import atomic_write_text
from fox_coding_agent.src.core.trust import ProjectTrustManager


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_publish_preserves_tree_selected_branch_and_label_in_one_write(self):
        source = SessionManager(InMemorySessionStorage({"cwd": str(self.root)}))
        first = source.append_message(UserMessage(content="first"))
        source.append_message(UserMessage(content="other branch"))
        source.append_label("draft label")
        source.move_to(first.id)
        target = self.root / "session.jsonl"
        with patch("fox_coding_agent.src.core._io.os.replace", wraps=os.replace) as replace:
            storage = JsonlSessionStorage.create(target, source.storage)
        self.assertEqual(replace.call_count, 1)
        restored = SessionManager(JsonlSessionStorage(target))
        self.assertEqual(restored.storage.get_metadata(), source.storage.get_metadata())
        self.assertEqual(restored.get_entries(), source.get_entries())
        self.assertEqual(restored.leaf_id, first.id)
        self.assertEqual(restored.get_label(), "draft label")
        self.assertEqual([m.content for m in restored.build_context()], ["first"])
        source.get_entry(first.id).data.content = "changed draft"
        self.assertEqual(storage.get_entry(first.id).data.content, "first")
        before = target.read_bytes()
        with self.assertRaises(FileExistsError):
            JsonlSessionStorage.create(target, source.storage)
        self.assertEqual(target.read_bytes(), before)

    def test_failed_mutations_restore_memory_and_disk(self):
        target = self.root / "session.jsonl"
        session = SessionManager(JsonlSessionStorage(target))
        first = session.append_message(UserMessage(content="first"))
        session.append_message(UserMessage(content="second"))
        session.storage.set_label("original")
        before = target.read_bytes()
        entries, leaf = session.get_entries(), session.leaf_id
        actions = (
            lambda: session.append_message(UserMessage(content="lost")),
            lambda: session.move_to(first.id),
            lambda: session.storage.set_label("lost"),
        )
        for action in actions:
            with self.subTest(action=action), patch(
                "fox_coding_agent.src.core._io.os.replace", side_effect=OSError("disk full"),
            ):
                with self.assertRaises(OSError):
                    action()
            self.assertEqual(session.get_entries(), entries)
            self.assertEqual(session.leaf_id, leaf)
            self.assertEqual(session.get_label(), "original")
            self.assertEqual(target.read_bytes(), before)
            self.assertEqual(list(self.root.iterdir()), [target])

    def test_flush_failure_keeps_existing_text_and_cleans_temporary_file(self):
        target = self.root / "state.json"
        target.write_text("original", encoding="utf-8")
        with patch("fox_coding_agent.src.core._io.os.fsync", side_effect=OSError("flush failed")):
            with self.assertRaises(OSError):
                atomic_write_text(target, "replacement")
        self.assertEqual(target.read_text(encoding="utf-8"), "original")
        self.assertEqual(list(self.root.iterdir()), [target])

    def test_credential_and_trust_state_only_changes_after_successful_write(self):
        credentials = CredentialStore(self.root)
        credentials.write("demo", ApiKeyCredential(key="original"))
        trust = ProjectTrustManager(self.root)
        trust.set(self.root, True)
        with patch("fox_coding_agent.src.core._io.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                credentials.write("demo", ApiKeyCredential(key="replacement"))
            with self.assertRaises(OSError):
                trust.set(self.root, False)
        self.assertEqual(credentials.read("demo").key, "original")
        self.assertTrue(trust.decision(self.root))
        self.assertEqual(CredentialStore(self.root).read("demo").key, "original")
        self.assertTrue(ProjectTrustManager(self.root).decision(self.root))
        if os.name != "nt":
            self.assertEqual(credentials.path.stat().st_mode & 0o777, 0o600)


class SessionToolTests(unittest.TestCase):
    def setUp(self):
        self.session = AgentSession(AgentSessionConfig(model=FAUX_MODEL, tools=[], skills=[]))

    def test_invalid_runtime_batch_leaves_registered_and_selected_tools_unchanged(self):
        before = self.session.state.system_prompt
        with self.assertRaises(TypeError):
            self.session.add_runtime_tools([
                ReadTool(), SimpleNamespace(name="invalid", execute=None),
            ])
        self.assertIsNone(self.session.get_tool("read"))
        self.assertEqual(self.session.selected_tool_names, ())
        self.assertEqual(self.session.state.tools, [])
        self.assertEqual(self.session.state.system_prompt, before)

    def test_runtime_selection_does_not_become_a_restore_dependency(self):
        read = ReadTool()
        self.session.add_runtime_tools([read], activate=False)
        self.assertEqual(self.session.selected_tool_names, ())
        self.session.set_active_tools(["read"])
        self.assertEqual(self.session.state.tools, [read])
        self.assertEqual(self.session.session.build_settings()["active_tools"], [])
        restored = AgentSession(AgentSessionConfig(
            model=FAUX_MODEL, session=self.session.session, tools=[], skills=[],
        ))
        self.assertEqual(restored.state.tools, [])

    def test_prompt_builder_requires_the_canonical_four_argument_contract(self):
        with self.assertRaises(TypeError):
            AgentSession(AgentSessionConfig(
                model=FAUX_MODEL, tools=[], skills=[],
                system_prompt_builder=lambda tools, skills, cwd: "old signature",
            ))


class RetryCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_assistant_retry_cancels_backoff_without_another_model_call(self):
        cancel = asyncio.Event()
        calls, finished = [], []

        async def produce():
            calls.append(True)
            return AssistantMessage(stop_reason="error", error_message="503 overloaded")

        async def scheduled(*args):
            asyncio.get_running_loop().call_soon(cancel.set)

        async def on_finished(*args):
            finished.append(args)

        response = await asyncio.wait_for(retry_assistant_call(
            produce, RetryPolicy(enabled=True, max_retries=2, base_delay_ms=60_000), cancel,
            RetryCallbacks(on_retry_scheduled=scheduled, on_retry_finished=on_finished),
        ), 1)
        self.assertEqual(response.stop_reason, "aborted")
        self.assertIsNone(response.error_message)
        self.assertEqual(len(calls), 1)
        self.assertEqual(finished, [(False, 1, "503 overloaded")])

    async def test_provider_retry_cancels_backoff_and_drains_child_tasks(self):
        cancel, requested = asyncio.Event(), asyncio.Event()
        calls = []

        class RateLimitError(Exception):
            status_code = 429
            headers = {"retry-after-ms": "60000"}

        async def request():
            calls.append(True)
            requested.set()
            raise RateLimitError("rate limit")

        before = asyncio.all_tasks()
        task = asyncio.create_task(retry_provider_request(
            request, max_retries=2, cancel_event=cancel,
        ))
        await requested.wait()
        cancel.set()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(asyncio.all_tasks(), before)
