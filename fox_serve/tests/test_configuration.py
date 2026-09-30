from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from fox_serve.configuration import ConfigurationService
from fox_serve.host import ServeHost


MODEL = {
    "id": "demo-chat",
    "name": "Demo Chat",
    "reasoning": False,
    "input": ["text"],
    "contextWindow": 128_000,
    "maxTokens": 8_192,
}


class ConfigurationServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.user = root / "user"
        self.cwd = root / "project"
        self.cwd.mkdir()
        self.service = ConfigurationService(
            user_dir=self.user, cwd=self.cwd, project_trusted=True
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_provider_and_credential_snapshot_is_redacted(self) -> None:
        self.service.save_provider({
            "id": "demo",
            "baseUrl": "https://example.test/v1",
            "api": "openai-completions",
            "models": [MODEL],
        })
        self.service.set_credential("demo", "super-secret")

        snapshot = self.service.snapshot()
        self.assertEqual(snapshot["providers"][0]["id"], "demo")
        self.assertTrue(snapshot["providers"][0]["credentialConfigured"])
        self.assertNotIn("super-secret", json.dumps(snapshot))
        auth = self.user / "auth.json"
        self.assertEqual(json.loads(auth.read_text())["demo"]["key"], "super-secret")
        if os.name != "nt":
            self.assertEqual(auth.stat().st_mode & 0o777, 0o600)
        self.service.delete_credential("demo")
        self.assertFalse(self.service.snapshot()["providers"][0]["credentialConfigured"])

    def test_invalid_provider_does_not_replace_last_good_file(self) -> None:
        self.service.save_provider({
            "id": "demo", "baseUrl": "https://example.test/v1",
            "api": "openai-completions", "models": [MODEL],
        })
        before = (self.user / "models.json").read_bytes()
        with self.assertRaises(ValueError):
            self.service.save_provider({
                "id": "demo", "baseUrl": "not-a-url",
                "api": "openai-completions", "models": [MODEL],
            })
        self.assertEqual((self.user / "models.json").read_bytes(), before)

    def test_mcp_edit_preserves_redacted_environment_values(self) -> None:
        self.service.save_mcp({
            "name": "github", "command": "npx", "args": ["server"],
            "permission": "read-only", "env": {"TOKEN": "secret"},
        }, scope="user")
        self.service.save_mcp({
            "name": "github", "command": "uvx", "args": ["server-v2"],
            "permission": "read-only",
        }, scope="user")
        raw = json.loads((self.user / "mcp.json").read_text())
        self.assertEqual(raw["github"]["env"], {"TOKEN": "secret"})
        snapshot = self.service.snapshot()
        self.assertEqual(snapshot["mcpServers"][0]["envKeys"], ["TOKEN"])
        self.assertNotIn("secret", json.dumps(snapshot))

    def test_subagent_round_trip_and_project_trust(self) -> None:
        self.service.save_subagent({
            "name": "reviewer",
            "description": "Review changes",
            "systemPrompt": "Inspect the diff and report risks.",
            "allowedTools": ["read", "grep"],
        }, scope="project")
        item = next(row for row in self.service.snapshot()["subagents"] if row["name"] == "reviewer")
        self.assertEqual(item["scope"], "project")
        self.assertEqual(item["allowedTools"], ["read", "grep"])

        untrusted = ConfigurationService(
            user_dir=self.user, cwd=self.cwd, project_trusted=False
        )
        with self.assertRaises(PermissionError):
            untrusted.save_subagent({
                "name": "blocked", "description": "Blocked profile",
                "systemPrompt": "Do not write.", "allowedTools": ["read"],
            }, scope="project")


class FirstRunHostTests(unittest.IsolatedAsyncioTestCase):
    async def test_host_starts_without_models_file_so_ui_can_configure_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cwd = root / "project"
            user = root / "user"
            cwd.mkdir()
            host = ServeHost(cwd=cwd, user_dir=user, send=lambda _payload: None)
            try:
                await host.start()
                info = await host.handle("host.info", {})
                config = await host.handle("config.get", {})
                self.assertEqual(info["model"]["id"], "gpt-4o-mini")
                self.assertEqual(config["providers"], [])
            finally:
                await host.stop()


if __name__ == "__main__":
    unittest.main()
