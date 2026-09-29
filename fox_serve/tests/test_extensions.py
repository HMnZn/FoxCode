"""`extension_catalog` 与 `extensions.set` 的测试。

这些测试覆盖「扩展以配置驱动、可开关」这条链路：
发现候选 → 探测贡献面 → 决定生效作用域 → 改 settings.json → 热重载（失败回滚）。
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from typing import Any

from fox_serve import extension_catalog as catalog
from fox_serve.approvals import PermissionPolicy
from fox_serve.host import HostError, ServeHost
from fox_serve.sessions import SessionIndex
from fox_serve.tests._tmp import temp_dir_obj


def _write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


class SpecTests(unittest.TestCase):
    def test_kind_and_name_for_every_spec_shape(self) -> None:
        self.assertEqual(
            catalog.spec_kind("module:fox_coding_agent.src.extensions.memory:setup"), "module"
        )
        self.assertEqual(catalog.spec_kind("module:alpha"), "module")
        self.assertEqual(catalog.spec_kind("entrypoint:my-pkg"), "entrypoint")
        self.assertEqual(catalog.spec_kind("C:/tmp/ext/my_ext.py"), "file")

    def test_module_target_drops_only_the_callable_suffix(self) -> None:
        self.assertEqual(
            catalog.module_target("module:fox_coding_agent.src.extensions.memory:setup"),
            "fox_coding_agent.src.extensions.memory",
        )
        self.assertEqual(catalog.module_target("module:alpha.beta"), "alpha.beta")

    def test_names_are_short_and_stable(self) -> None:
        self.assertEqual(
            catalog.spec_name("module:fox_coding_agent.src.extensions.memory:setup"), "memory"
        )
        self.assertEqual(catalog.spec_name("entrypoint:fox-mcp"), "fox-mcp")
        self.assertEqual(catalog.spec_name("C:/tmp/ext/my_ext.py"), "my_ext")


class ScopeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = temp_dir_obj()
        self.root = Path(self._tmp.name)
        self.user_path = self.root / "user" / "settings.json"
        self.project_path = self.root / "proj" / ".foxcode" / "settings.json"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_project_key_wins_because_lists_are_replaced(self) -> None:
        _write_json(self.user_path, {"extensions": ["module:user-only:setup"]})
        _write_json(self.project_path, {"extensions": ["module:project-only:setup"]})
        self.assertEqual(catalog.effective_scope(self.user_path, self.project_path), "project")
        self.assertEqual(
            catalog.effective_specs(self.user_path, self.project_path),
            ["module:project-only:setup"],
        )
        self.assertEqual(
            catalog.specs_present_in(self.user_path, self.project_path),
            {"module:user-only:setup": ["user"], "module:project-only:setup": ["project"]},
        )

    def test_user_settings_apply_when_the_project_has_no_key(self) -> None:
        _write_json(self.user_path, {"extensions": ["module:user-only:setup"]})
        self.assertEqual(catalog.effective_scope(self.user_path, self.project_path), "user")
        self.assertEqual(
            catalog.effective_specs(self.user_path, self.project_path), ["module:user-only:setup"]
        )

    def test_suggested_scope_follows_the_active_file_then_trust(self) -> None:
        _write_json(self.project_path, {"extensions": []})
        self.assertEqual(
            catalog.suggested_scope(self.user_path, self.project_path, project_trusted=True),
            "project",
        )
        empty_project = self.root / "other" / ".foxcode" / "settings.json"
        self.assertEqual(
            catalog.suggested_scope(self.user_path, empty_project, project_trusted=True), "project"
        )
        self.assertEqual(
            catalog.suggested_scope(self.user_path, empty_project, project_trusted=False), "user"
        )

    def test_read_configured_ignores_junk(self) -> None:
        path = self.root / "user" / "settings.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{ not json", encoding="utf-8")
        self.assertEqual(catalog.read_configured(path), [])
        _write_json(path, {"extensions": [1, "module:ok:setup", None]})
        self.assertEqual(catalog.read_configured(path), ["module:ok:setup"])


class DiscoverTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = temp_dir_obj()
        self.root = Path(self._tmp.name)
        self.user_dir = self.root / "user"
        self.cwd = self.root / "proj"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_builtin_extensions_are_discovered_and_probed(self) -> None:
        candidates = catalog.discover(user_dir=self.user_dir, cwd=self.cwd)
        by_name = {item.name: item for item in candidates}
        self.assertIn("memory", by_name, [item.name for item in candidates])
        memory = by_name["memory"].probe
        self.assertEqual(
            sorted(memory.tools), ["memory_forget", "memory_recall", "memory_remember"]
        )
        self.assertEqual(memory.context_transforms, ["memory.recall"])
        self.assertIn("session_start", memory.hooks)
        self.assertIn("memory.store", memory.services)
        self.assertIsNone(by_name["subagent"].probe.error)
        self.assertEqual(by_name["subagent"].probe.tools, ["agent"])
        evolution = by_name["skill_evolution"].probe
        self.assertIsNone(evolution.error)
        self.assertEqual(evolution.tools, ["skill_evolution"])
        self.assertEqual(evolution.commands, ["skill-evolution"])
        self.assertIn("skill-evolution.manager", evolution.services)

    def test_user_and_project_files_are_only_docstring_probed(self) -> None:
        user_file = self.user_dir / "extensions" / "my_ext.py"
        user_file.parent.mkdir(parents=True, exist_ok=True)
        user_file.write_text(
            '"""我的本地扩展：不执行它。"""\n\nraise RuntimeError("不应该被导入")\n',
            encoding="utf-8",
        )
        project_file = self.cwd / ".foxcode" / "extensions" / "proj_ext.py"
        project_file.parent.mkdir(parents=True, exist_ok=True)
        project_file.write_text('"""项目级扩展。"""\n', encoding="utf-8")

        candidates = {item.name: item for item in catalog.discover(user_dir=self.user_dir, cwd=self.cwd)}
        self.assertEqual(candidates["my_ext"].origin, "user")
        self.assertEqual(candidates["my_ext"].kind, "file")
        self.assertEqual(candidates["proj_ext"].origin, "project")
        # 只读 docstring：里面的 raise 绝不能被触发，也不能报错。
        # `probed=False` 是刻意的：文件扩展从不执行，所以拿不到工具/钩子清单。
        self.assertEqual(candidates["my_ext"].probe.description, "我的本地扩展：不执行它。")
        self.assertFalse(candidates["my_ext"].probe.probed)
        self.assertEqual(candidates["my_ext"].probe.tools, [])
        self.assertIsNone(candidates["my_ext"].probe.error)
        self.assertEqual(candidates["proj_ext"].probe.description, "项目级扩展。")


class _FakeState:
    tools: list[object] = []


class _FakeRuntime:
    """只实现扩展命令需要的那一小部分。"""

    def __init__(self, cwd: Path, user_dir: Path, manager: object) -> None:
        self.cwd = cwd
        self.user_dir = user_dir
        self.settings_manager = manager
        self.project_trusted = True
        self.permission_mode = "full-access"
        self.session_file = cwd / "session.jsonl"
        self.state = _FakeState()
        self.reload_calls = 0
        self.fail_reloads = 0

    async def reload(self) -> None:
        self.reload_calls += 1
        if self.fail_reloads > 0:
            self.fail_reloads -= 1
            raise RuntimeError("扩展加载失败（测试注入）")


class HostExtensionsSetTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        from fox_coding_agent.src.core.settings import SettingsManager

        self._tmp = temp_dir_obj()
        self.root = Path(self._tmp.name)
        self.cwd = self.root / "proj"
        self.user_dir = self.root / "user"
        self.project_path = self.cwd / ".foxcode" / "settings.json"
        self.user_path = self.user_dir / "settings.json"
        _write_json(self.user_path, {"extensions": []})
        _write_json(self.project_path, {"extensions": ["module:alpha:setup"]})

        self.manager = SettingsManager(cwd=self.cwd, user_dir=self.user_dir)
        self.runtime = _FakeRuntime(self.cwd, self.user_dir, self.manager)
        self.host = ServeHost(cwd=self.cwd, user_dir=self.user_dir)
        self.host._runtime = self.runtime  # noqa: SLF001
        self.host._policy = PermissionPolicy("workspace-modify", cwd=self.cwd)  # noqa: SLF001
        self.host._sessions = SessionIndex(cwd=self.cwd, user_dir=self.user_dir)  # noqa: SLF001
        self.frames: list[dict[str, Any]] = []
        self.host._send = lambda payload: self.frames.append(payload)  # noqa: SLF001

    def tearDown(self) -> None:
        self._tmp.cleanup()

    async def test_enable_adds_the_spec_and_reloads(self) -> None:
        result = await self.host.handle("extensions.set", {"id": "module:beta:setup"})
        self.assertTrue(result["enabled"])
        self.assertEqual(result["scope"], "project")
        self.assertEqual(result["updatedScopes"], ["project"])
        self.assertEqual(
            _read_json(self.project_path)["extensions"],
            ["module:alpha:setup", "module:beta:setup"],
        )
        self.assertEqual(self.runtime.reload_calls, 1)
        kinds = [frame["frame"]["type"] for frame in self.frames if "frame" in frame]
        self.assertIn("session_start", kinds)
        self.assertIn("module:beta:setup", [item["spec"] for item in result["extensions"]])

    async def test_enable_restores_the_original_slot(self) -> None:
        # 关掉再打开应该回到原来的槽位，而不是跑到列表末尾（顺序即加载顺序）。
        _write_json(
            self.project_path,
            {"extensions": ["module:alpha:setup", "module:gamma:setup"]},
        )

        await self.host.handle("extensions.set", {"id": "module:beta:setup"})

        self.assertEqual(
            _read_json(self.project_path)["extensions"],
            ["module:alpha:setup", "module:beta:setup", "module:gamma:setup"],
        )

    async def test_disable_removes_the_spec_from_every_scope(self) -> None:
        _write_json(
            self.project_path,
            {"extensions": ["module:alpha:setup", "module:beta:setup"]},
        )
        _write_json(self.user_path, {"extensions": ["module:beta:setup"]})

        result = await self.host.handle("extensions.set", {"id": "module:beta:setup", "enabled": False})
        self.assertFalse(result["enabled"])
        self.assertEqual(result["updatedScopes"], ["project", "user"])
        self.assertEqual(_read_json(self.project_path)["extensions"], ["module:alpha:setup"])
        self.assertEqual(_read_json(self.user_path)["extensions"], [])
        self.assertEqual(self.runtime.reload_calls, 1)

    async def test_enable_by_bare_name_matches_a_discovered_extension(self) -> None:
        result = await self.host.handle("extensions.set", {"id": "memory"})
        self.assertEqual(result["id"], "module:fox_coding_agent.src.extensions.memory:setup")
        self.assertIn(
            "module:fox_coding_agent.src.extensions.memory:setup",
            _read_json(self.project_path)["extensions"],
        )

    async def test_untrusted_project_refuses_to_write(self) -> None:
        self.runtime.project_trusted = False
        before = _read_json(self.project_path)["extensions"]
        with self.assertRaises(HostError) as caught:
            await self.host.handle("extensions.set", {"id": "module:beta:setup"})
        self.assertIn("未受信任", str(caught.exception))
        self.assertEqual(_read_json(self.project_path)["extensions"], before)
        self.assertEqual(self.runtime.reload_calls, 0)

    async def test_deprecated_key_in_user_settings_is_reported(self) -> None:
        # 用户级文件里塞一个后端已删除的键：SettingsManager 校验会拒绝写入。
        _write_json(self.user_path, {"extensions": [], "memory": True})
        # 让目标作用域落到用户级，才能踩到那个文件。
        self.project_path.unlink()
        with self.assertRaises(HostError) as caught:
            await self.host.handle("extensions.set", {"id": "module:beta:setup"})
        self.assertIn("无法写入", str(caught.exception))
        self.assertIn("memory", str(caught.exception))
        self.assertEqual(self.runtime.reload_calls, 0)

    async def test_failed_reload_rolls_the_settings_file_back(self) -> None:
        self.runtime.fail_reloads = 1
        with self.assertRaises(HostError) as caught:
            await self.host.handle("extensions.set", {"id": "module:beta:setup"})
        self.assertIn("已回滚", str(caught.exception))
        self.assertEqual(_read_json(self.project_path)["extensions"], ["module:alpha:setup"])
        # 第一次（失败）+ 回滚后的第二次（成功）。
        self.assertEqual(self.runtime.reload_calls, 2)

    async def test_setting_an_already_active_extension_is_a_no_op(self) -> None:
        first = await self.host.handle("extensions.set", {"id": "module:alpha:setup"})
        self.assertEqual(first["updatedScopes"], [])
        self.assertEqual(self.runtime.reload_calls, 0)


class HostInfoExtensionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        from fox_coding_agent.src.core.settings import SettingsManager

        self._tmp = temp_dir_obj()
        self.root = Path(self._tmp.name)
        self.cwd = self.root / "proj"
        self.user_dir = self.root / "user"
        self.project_path = self.cwd / ".foxcode" / "settings.json"
        _write_json(self.user_dir / "settings.json", {"extensions": []})
        _write_json(
            self.project_path,
            {"extensions": ["module:fox_coding_agent.src.extensions.memory:setup"]},
        )
        self.manager = SettingsManager(cwd=self.cwd, user_dir=self.user_dir)
        self.runtime = _FakeRuntime(self.cwd, self.user_dir, self.manager)
        self.host = ServeHost(cwd=self.cwd, user_dir=self.user_dir)
        self.host._runtime = self.runtime  # noqa: SLF001
        self.host._policy = PermissionPolicy("workspace-modify", cwd=self.cwd)  # noqa: SLF001
        self.host._sessions = SessionIndex(cwd=self.cwd, user_dir=self.user_dir)  # noqa: SLF001
        self.host._send = lambda payload: None  # noqa: SLF001

    def tearDown(self) -> None:
        self._tmp.cleanup()

    async def test_host_info_reports_active_and_available_extensions(self) -> None:
        info = await self.host.handle("host.info", {})
        active = {item["spec"]: item for item in info["extensions"]}
        self.assertEqual(
            list(active),
            ["module:fox_coding_agent.src.extensions.memory:setup"],
        )
        entry = active["module:fox_coding_agent.src.extensions.memory:setup"]
        self.assertEqual(entry["name"], "memory")
        self.assertTrue(entry["enabled"])
        self.assertEqual(entry["scope"], "project")
        self.assertIn("memory_remember", entry["tools"])
        self.assertEqual(entry["hooks"], ["session_start"])
        self.assertEqual(entry["description"], "Built-in policy-aware long-term memory extension.")

        available = {item["spec"]: item for item in info["availableExtensions"]}
        self.assertNotIn("module:fox_coding_agent.src.extensions.memory:setup", available)
        self.assertIn("module:fox_coding_agent.src.extensions.subagent:setup", available)
        subagent = available["module:fox_coding_agent.src.extensions.subagent:setup"]
        self.assertFalse(subagent["enabled"])
        self.assertEqual(subagent["origin"], "builtin")
        self.assertEqual(subagent["tools"], ["agent"])
        evolution_spec = "module:fox_coding_agent.src.extensions.skill_evolution:setup"
        self.assertIn(evolution_spec, available)
        self.assertEqual(available[evolution_spec]["tools"], ["skill_evolution"])
        self.assertEqual(available[evolution_spec]["commands"], ["skill-evolution"])
