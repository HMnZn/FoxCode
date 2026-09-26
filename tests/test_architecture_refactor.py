"""Focused contracts for the pi-style package and host refactor."""

import json
import importlib
import tempfile
import unittest
from pathlib import Path

from fox_ai.src import AssistantMessage, TextContent, ToolCall, Usage, UsageCost, UserMessage
from fox_ai.src.providers.faux import FAUX_MODEL, FauxScript, clear_scripts, push_script
from fox_coding_agent.src import (
    AgentSession,
    AgentSessionConfig,
    AgentSessionRuntime,
    CompactionSettings,
    CredentialStore,
    ExtensionRunner,
    ModelConfig,
    ModelRuntime,
    ResourceLoader,
    SessionManager,
)


def write(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) if not isinstance(value, str) else value, encoding="utf-8")


def catalog():
    return {"providers": {"demo": {
        "baseUrl": "https://example.invalid/v1",
        "api": "openai-completions",
        "models": [{"id": "model", "name": "Model", "contextWindow": 32000,
                    "maxTokens": 1000, "input": ["text"], "reasoning": False}],
    }}}


class ModelBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_split_catalog_and_credentials(self):
        write(self.root / "models.json", catalog())
        write(self.root / "auth.json", {"demo": {"type": "api_key", "key": "secret"}})
        runtime = ModelRuntime(self.root)
        model = runtime.registry.resolve("demo/model").model
        self.assertEqual(runtime.api_key_for(model), "secret")
        self.assertNotIn("secret", repr(runtime.registry.models))
        self.assertEqual(CredentialStore(self.root).list(), ("demo",))

    def test_combined_auth_and_nested_reasoning_map_are_rejected(self):
        combined = catalog()
        combined["providers"]["demo"]["apiKey"] = "secret"
        write(self.root / "auth.json", combined)
        with self.assertRaisesRegex(ValueError, "credential type"):
            CredentialStore(self.root)
        write(self.root / "models.json", combined)
        with self.assertRaisesRegex(ValueError, "Invalid model config"):
            ModelConfig(self.root)
        canonical = catalog()
        canonical["providers"]["demo"]["models"][0]["compat"] = {
            "reasoningEffortMap": {"high": "max"}
        }
        write(self.root / "models.json", canonical)
        with self.assertRaisesRegex(ValueError, "thinkingLevelMap"):
            ModelConfig(self.root)

    def test_removed_compatibility_names_are_not_public(self):
        sdk = importlib.import_module("fox_coding_agent.src")
        for name in ("AuthStore", "FileCredentialStore", "AgentHarness",
                     "AgentHarnessOptions", "AgentSessionOptions", "Session"):
            self.assertFalse(hasattr(sdk, name), name)
        for module in ("auth", "harness", "session", "compaction"):
            with self.assertRaises(ModuleNotFoundError):
                importlib.import_module(f"fox_coding_agent.src.core.{module}")


class TrustAndExtensionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / "project"
        self.user = self.root / "user"
        self.project.mkdir()
        clear_scripts()

    async def test_untrusted_project_skips_automatic_resources_and_blocks_tools(self):
        write(self.project / "AGENTS.md", "untrusted instructions")
        write(self.project / ".foxcode/skills/local/SKILL.md",
              "---\nname: local\ndescription: local skill\n---\nunsafe")
        write(self.project / ".foxcode/prompts/review.md", "Review $ARGUMENTS")
        resources = ResourceLoader(self.project, user_dir=self.user, project_trusted=False).load()
        self.assertEqual(resources.context_files, [])
        self.assertEqual(resources.skills, [])
        self.assertIn("review", resources.prompts)  # explicit inert template remains available

        push_script(FauxScript(tool_calls=[ToolCall(
            id="write", name="write", arguments={"path": "blocked.txt", "content": "x"})]))
        push_script(FauxScript(text="blocked safely"))
        runtime = AgentSessionRuntime(self.project, user_dir=self.user, model=FAUX_MODEL,
                                      project_trusted=False)
        self.addAsyncCleanup(runtime.close)
        await runtime.prompt("write a file")
        self.assertFalse((self.project / "blocked.txt").exists())
        results = [m for m in runtime.state.messages if m.role == "toolResult"]
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].is_error)

    async def test_settings_selects_a_models_json_reference(self):
        write(self.user / "models.json", catalog())
        write(self.user / "settings.json", {"model": "demo/model"})
        runtime = AgentSessionRuntime(self.project, user_dir=self.user, project_trusted=False)
        self.addAsyncCleanup(runtime.close)
        self.assertEqual((runtime.state.model.provider, runtime.state.model.id), ("demo", "model"))

    async def test_extension_service_registry(self):
        marker = object()
        def setup(api):
            api.register_service("memory.index", marker)
            api.register_context_transform(
                "memory.recall", lambda messages, context: [UserMessage(content="memory"), *messages]
            )

        runner = ExtensionRunner.load(factories=(setup,))
        self.addCleanup(runner.dispose)
        self.assertIs(runner.api.get_service("memory.index"), marker)
        source = [UserMessage(content="question")]
        transformed = await runner.transform_context(source, object())
        self.assertEqual([message.content for message in transformed], ["memory", "question"])
        self.assertEqual([message.content for message in source], ["question"])
        with self.assertRaises(ValueError):
            runner.api.register_service("memory.index", object())


class SessionRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        clear_scripts()

    async def test_transient_empty_model_error_retries_without_polluting_active_branch(self):
        push_script(FauxScript(error="503 temporarily overloaded"))
        push_script(FauxScript(text="recovered"))
        session = AgentSession(AgentSessionConfig(
            model=FAUX_MODEL, cwd=self.temp.name, tools=[], skills=[], model_retry_attempts=1,
        ))
        events = []
        session.subscribe(lambda event, cancel: events.append(event.type))
        await session.prompt("hello")
        self.assertEqual(session.state.messages[-1].content[0].text, "recovered")
        self.assertNotIn("503", " ".join(getattr(m, "error_message", "") or ""
                                           for m in session.state.messages))
        self.assertIn("model_retry", events)

    async def test_context_overflow_compacts_then_retries_once(self):
        stored = SessionManager()
        for index in range(6):
            stored.append_message(UserMessage(content=f"history {index} " + "x" * 200))
        push_script(FauxScript(error="maximum context length exceeded"))
        push_script(FauxScript(text="after compaction"))

        async def summarize(model, messages, **options):
            return "older history summarized"

        session = AgentSession(AgentSessionConfig(
            model=FAUX_MODEL, cwd=self.temp.name, session=stored, tools=[], skills=[],
            model_retry_attempts=1, summary_fn=summarize,
            compaction=CompactionSettings(enabled=False, reserve_tokens=0, keep_recent_tokens=1),
        ))
        events = []
        session.subscribe(lambda event, cancel: events.append(event.type))
        await session.prompt("continue")
        self.assertEqual(session.state.messages[-1].content[0].text, "after compaction")
        self.assertIn("context_overflow_retry", events)
        self.assertTrue(any(entry.type == "compaction" for entry in stored.get_entries()))

    async def test_usage_and_exports_follow_active_branch(self):
        session = SessionManager()
        session.append_message(UserMessage(content="hello"))
        session.append_message(AssistantMessage(
            api="faux", provider="faux", model="faux", stopReason="stop",
            content=[TextContent(text="answer")],
            usage=Usage(input=10, output=4, totalTokens=14,
                        cost=UsageCost(input=0.1, output=0.2, total=0.3)),
        ))
        self.assertEqual(session.usage_totals()["total_tokens"], 14)
        self.assertAlmostEqual(session.usage_totals()["cost"], 0.3)
        json_path = session.export_json(Path(self.temp.name) / "session.json")
        md_path = session.export_markdown(Path(self.temp.name) / "session.md")
        exported = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertEqual(exported["usage"]["output"], 4)
        self.assertIn("## Assistant", md_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
