"""Authentication, model switching and real SDK request serialization, without network calls."""

import contextlib
import io
import json
import unittest
from unittest.mock import patch

import httpx

from fox_ai.src import Context, SimpleStreamOptions, UserMessage
from fox_ai.src.providers.faux import FauxScript
from fox_ai.src.providers.openai_provider import openai_api_provider
from fox_coding_agent.src import (
    AgentSessionRuntime,
    CredentialStore,
    ModelConfig,
    ModelRegistry,
    ModelRuntime,
)
from fox_coding_agent.src.cli import build_parser, run
from test_agent_core import scripted
from test_runtime import Workspace, write


def model_data():
    model = {"id": "flash", "name": "Flash", "contextWindow": 32768,
             "maxTokens": 4096, "input": ["text"], "reasoning": True,
             "compat": {"thinkingFormat": "deepseek"},
             "thinkingLevelMap": {
                 "minimal": "high", "low": "high", "medium": "high", "high": "high", "xhigh": "max"}}
    return {"providers": {
        "first": {"api": "openai-completions", "baseUrl": "https://first.invalid/v1",
                  "models": [model]},
        "second": {"api": "openai-completions", "baseUrl": "https://second.invalid/v1",
                   "models": [{**model, "id": "pro", "name": "Pro"}]},
    }}


def credential_data(first="first-secret", second="second-secret"):
    return {
        "first": {"type": "api_key", "key": first},
        "second": {"type": "api_key", "key": second},
    }


class AuthModelTests(Workspace, unittest.IsolatedAsyncioTestCase):
    def configure(self, models=None, credentials=None):
        write(self.user / "models.json", json.dumps(models or model_data()))
        write(self.user / "auth.json", json.dumps(credentials or credential_data()))

    def runtime(self, **kwargs):
        runtime = AgentSessionRuntime(self.project, user_dir=self.user, **kwargs)
        self.addAsyncCleanup(runtime.close)
        return runtime

    async def test_switch_cwd_new_session_resume_branch_and_summary_resolve_current_key(self):
        self.configure()
        stream = scripted(*[FauxScript(text="ok") for _ in range(6)])
        runtime = self.runtime(stream_fn=stream, settings_overrides={"compaction": {
            "enabled": False, "keep_recent_tokens": 1}})
        runtime.set_thinking_level("xhigh")
        await runtime.prompt("first")
        first_leaf = runtime.session.leaf_id
        runtime.select_model("second/pro")
        await runtime.prompt("second")
        self.assertEqual([o.api_key for o in stream.options], ["first-secret", "second-secret"])
        self.assertEqual(stream.options[-1].reasoning, "xhigh")
        runtime.agent_session.move_to(first_leaf)
        await runtime.prompt("first branch again")
        self.assertEqual(stream.options[-1].api_key, "first-secret")
        runtime.select_model("second/pro")
        await runtime.change_cwd(self.other)
        self.assertEqual(runtime.state.thinking_level, "xhigh")
        self.assertEqual(runtime.state.model.id, "pro")
        await runtime.prompt("after cwd")
        saved_file = runtime.session_file
        await runtime.new_session()
        await runtime.switch_session(saved_file)
        self.assertEqual(runtime.state.thinking_level, "xhigh")
        runtime.set_thinking_level("off")
        await runtime.prompt("off")
        self.assertIsNone(stream.options[-1].reasoning)
        await runtime.compact()
        self.assertEqual(stream.options[-1].api_key, "second-secret")
        self.assertNotIn("first-secret", saved_file.read_text())
        self.assertNotIn("second-secret", saved_file.read_text())
        restored = AgentSessionRuntime(self.other, user_dir=self.user, session_file=saved_file)
        try:
            self.assertEqual(restored.state.model.id, "pro")
            self.assertIsNone(restored.state.thinking_level)
        finally:
            await restored.close()

    async def test_reload_updates_credentials_and_failure_preserves_current_auth(self):
        self.configure()
        stream = scripted(FauxScript(text="new"), FauxScript(text="still new"))
        runtime = self.runtime(stream_fn=stream)
        self.configure(credentials=credential_data(first="rotated-secret"))
        await runtime.reload()
        await runtime.prompt("new key")
        self.assertEqual(stream.options[-1].api_key, "rotated-secret")
        changed = model_data()
        changed["providers"]["first"]["models"][0]["maxTokens"] = "invalid"
        self.configure(models=changed, credentials=credential_data(first="rotated-secret"))
        with self.assertRaisesRegex(ValueError, "model metadata"):
            await runtime.reload()
        await runtime.prompt("after failed reload")
        self.assertEqual(stream.options[-1].api_key, "rotated-secret")

    async def test_catalog_validation_hides_keys_and_rejects_duplicates(self):
        self.configure()
        config = ModelConfig(self.user)
        registry = ModelRegistry(config)
        self.assertNotIn("secret", repr(registry.models))
        normalized = registry.default().model
        self.assertEqual(normalized.thinking_level_map["xhigh"], "max")
        self.assertNotIn("reasoningEffortMap", normalized.compat)
        original = registry.models
        data = model_data()
        data["providers"]["first"]["models"] *= 2
        self.configure(models=data)
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            config.reload()
        self.assertEqual(registry.models, original)
        data = model_data()
        data["providers"]["first"]["models"] = "invalid"
        self.configure(models=data)
        with self.assertRaises(ValueError) as caught:
            config.reload()
        self.assertNotIn("first-secret", str(caught.exception))
        with self.assertRaises(ValueError):
            registry.resolve("missing")
        self.assertEqual(CredentialStore(self.user).list(), ("first", "second"))

    async def test_credentials_are_scoped_to_endpoint_and_project_auth_is_not_loaded(self):
        self.configure()
        runtime = ModelRuntime(self.user)
        model = runtime.registry.default().model
        self.assertIsNone(runtime.api_key_for(model.model_copy(update={"base_url": "https://other.invalid"})))
        self.assertIsNone(runtime.api_key_for(model.model_copy(update={"api": "anthropic-messages"})))
        write(self.project / ".foxcode/auth.json", json.dumps({"providers": {}}))
        self.assertEqual(self.runtime().state.model.id, "flash")

    async def test_cli_model_thinking_and_list_models_without_creating_sessions(self):
        self.configure()
        parser = build_parser()
        base = ["--cwd", str(self.project), "--user-dir", str(self.user)]
        with contextlib.redirect_stdout(io.StringIO()) as output:
            await run(parser.parse_args([*base, "--list-models", "--json"]))
        self.assertEqual(len(json.loads(output.getvalue())["models"]), 2)
        self.assertFalse((self.project / ".foxcode/sessions").exists())
        stream = scripted(FauxScript(text="on"), FauxScript(text="off"))
        commands = ["/model", "/model second/pro", "/thinking xhigh", "on",
                    "/thinking off", "off", "/thinking bogus", "/exit"]
        with patch("builtins.input", side_effect=commands), contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            await run(parser.parse_args([*base, "--interactive"]), stream_fn=stream)
        self.assertIn("当前模型: second/pro", output.getvalue())
        self.assertIn("Invalid thinking level", errors.getvalue())
        self.assertNotIn("second-secret", output.getvalue() + errors.getvalue())
        self.assertEqual([o.reasoning for o in stream.options], ["xhigh", None])
        self.assertTrue(all(o.api_key == "second-secret" for o in stream.options))
        stream = scripted(FauxScript(text="flag"))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            await run(parser.parse_args([*base, "--model", "second/pro", "--thinking", "high", "-p", "flag"]),
                      stream_fn=stream)
        self.assertEqual(stream.options[0].reasoning, "high")
        self.assertEqual(stream.options[0].api_key, "second-secret")

    async def test_real_openai_sdk_serializes_deepseek_thinking_on_and_off(self):
        self.configure()
        model = ModelRegistry(ModelConfig(self.user)).default().model
        bodies = []

        async def handle(request):
            bodies.append(json.loads(request.content))
            payload = {"id": "test", "object": "chat.completion.chunk", "created": 1, "model": model.id,
                       "choices": [{"index": 0, "delta": {"content": "ok"}, "finish_reason": "stop"}]}
            return httpx.Response(200, headers={"content-type": "text/event-stream"},
                                  content="data: " + json.dumps(payload) + "\n\ndata: [DONE]\n\n")

        for level in ("high", "xhigh", None):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                options = SimpleStreamOptions(api_key="test-key", reasoning=level, http_client=client,
                    sampling_params={"extra_body": {"thinking": {"type": "disabled"}, "custom": True}})
                stream = openai_api_provider.stream_simple(model, Context(messages=[UserMessage(content="hi")]), options)
                response = await stream.result()
                await stream.aclose()
                self.assertEqual(response.stop_reason, "stop", response.error_message)
        self.assertEqual([b["thinking"]["type"] for b in bodies], ["enabled", "enabled", "disabled"])
        self.assertEqual([b.get("reasoning_effort") for b in bodies], ["high", "max", None])
        self.assertTrue(all(b["custom"] for b in bodies))
