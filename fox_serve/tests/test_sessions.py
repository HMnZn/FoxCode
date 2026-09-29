"""会话索引与 `sessions.new` / `sessions.delete` 的回归测试。

覆盖三类曾经出问题的地方：

- `SessionSummary.createdAt/updatedAt` 必须是毫秒数字（前端按 number 声明）；
- `sessions.new` 不能依赖 `runtime.new_session()` 的返回值（它返回 None）；
- `sessions.delete` 只能删会话目录里的文件，且不许删当前正在用的会话。
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fox_serve.approvals import PermissionPolicy  # noqa: E402
from fox_serve.host import HostError, ServeHost  # noqa: E402
from fox_serve.sessions import (  # noqa: E402
    MAX_LABEL_LENGTH,
    SessionIndex,
    _epoch_ms,
    branch_label,
    read_session_file,
)
from fox_serve.tests._tmp import temp_dir_obj  # noqa: E402
from fox_coding_agent.src.core.session_layout import SessionLayout  # noqa: E402


def _write_session(
    directory: Path,
    name: str,
    *,
    title: str = "你好",
    created: str = "2026-09-27T22:00:00",
    cwd: Path | None = None,
) -> Path:
    """写一个最小可用的会话文件（meta 行 + 一问一答）。"""

    path = directory / f"session-{name}" / "session.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    project = cwd or directory
    lines = [
        json.dumps(
            {"_meta": {"cwd": str(project), "timestamp": created, "_label": title}},
            ensure_ascii=False,
        ),
        json.dumps(
            {"type": "message", "data": {"role": "user", "content": [{"type": "text", "text": title}]}},
            ensure_ascii=False,
        ),
        json.dumps(
            {
                "type": "message",
                "data": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "好"}],
                    "usage": {"totalTokens": 10},
                },
            },
            ensure_ascii=False,
        ),
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


class EpochTests(unittest.TestCase):
    def test_iso_string_becomes_milliseconds(self) -> None:
        value = _epoch_ms("2026-09-27T22:00:00", 0.0)
        self.assertEqual(value, int(datetime(2026, 9, 27, 22, 0, 0).timestamp() * 1000))

    def test_seconds_become_milliseconds(self) -> None:
        self.assertEqual(_epoch_ms(1_700_000_000.5, 0.0), 1_700_000_000_500)

    def test_garbage_falls_back_to_the_file_mtime(self) -> None:
        self.assertEqual(_epoch_ms("", 5.0), 5000)
        self.assertEqual(_epoch_ms("不是时间", 5.0), 5000)
        self.assertEqual(_epoch_ms(None, 7.0), 7000)


class SummaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = temp_dir_obj()
        self.root = Path(self._tmp.name)
        self.project = self.root / "proj"
        self.sessions_dir = SessionLayout(self.root / "user" / "sessions").workspace_dir(self.project)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_summary_timestamps_are_numbers(self) -> None:
        path = _write_session(self.sessions_dir, "s-1")
        summary = read_session_file(path, live=False)
        assert summary is not None
        data = summary.to_summary()
        self.assertIsInstance(data["createdAt"], int)
        self.assertIsInstance(data["updatedAt"], int)
        self.assertGreater(data["updatedAt"], 1_600_000_000_000)
        self.assertEqual(data["messageCount"], 2)
        self.assertEqual(data["totalTokens"], 10)

    def test_list_sorts_newest_first(self) -> None:
        older = _write_session(self.sessions_dir, "old", title="旧")
        newer = _write_session(self.sessions_dir, "new", title="新")
        index = SessionIndex(cwd=self.root / "proj", user_dir=self.root / "user")
        listed = index.list()
        self.assertEqual([item["id"] for item in listed], ["session-new", "session-old"])
        self.assertGreaterEqual(
            newer.stat().st_mtime, older.stat().st_mtime
        )

    def test_recency_uses_messages_not_preview_config_writes_or_file_mtime(self) -> None:
        path = _write_session(self.sessions_dir, "preview")
        lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        lines[1]["timestamp"] = "2026-09-27T22:00:01+00:00"
        lines[2]["timestamp"] = "2026-09-27T22:00:02+00:00"
        path.write_text("\n".join(json.dumps(item) for item in lines), encoding="utf-8")
        before = read_session_file(path).to_summary()
        lines.append({"type": "active_tools_change", "timestamp": "2026-09-29T22:00:00+00:00", "data": ["read"]})
        path.write_text("\n".join(json.dumps(item) for item in lines), encoding="utf-8")
        os.utime(path, (2_000_000_000, 2_000_000_000))
        self.assertEqual(read_session_file(path).to_summary()["updatedAt"], before["updatedAt"])
        self.assertEqual(before["updatedAt"], _epoch_ms("2026-09-27T22:00:02+00:00", 0))
        lines.append({"type": "message", "data": {
            "role": "user", "timestamp": before["updatedAt"] + 60000, "content": [],
        }})
        path.write_text("\n".join(json.dumps(item) for item in lines), encoding="utf-8")
        self.assertEqual(read_session_file(path).to_summary()["updatedAt"], before["updatedAt"] + 60000)

    def test_project_level_sessions_are_not_scanned(self) -> None:
        legacy = self.project / ".foxcode" / "sessions"
        legacy.mkdir(parents=True)
        (legacy / "old.jsonl").write_text('{"_meta": {}}\n', encoding="utf-8")
        index = SessionIndex(cwd=self.project, user_dir=self.root / "user")
        self.assertEqual(index.files(), [])

    def test_list_all_groups_user_sessions_from_every_workspace(self) -> None:
        other = self.root / "other"
        other_dir = SessionLayout(self.root / "user" / "sessions").workspace_dir(other)
        current_file = _write_session(self.sessions_dir, "current", title="当前", cwd=self.project)
        other_file = _write_session(other_dir, "other", title="其他", cwd=other)
        index = SessionIndex(cwd=self.project, user_dir=self.root / "user")

        self.assertEqual([row["id"] for row in index.list()], ["session-current"])
        listed = index.list_all()
        self.assertEqual({row["id"] for row in listed}, {"session-current", "session-other"})
        self.assertEqual({row["cwd"] for row in listed}, {str(self.project), str(other)})
        self.assertEqual(index.find("session-other"), other_file)
        self.assertEqual(index.latest(), current_file)


class DeleteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = temp_dir_obj()
        self.root = Path(self._tmp.name)
        self.sessions_dir = SessionLayout(self.root / "user" / "sessions").workspace_dir(self.root / "proj")
        self.index = SessionIndex(cwd=self.root / "proj", user_dir=self.root / "user")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_delete_removes_the_file(self) -> None:
        path = _write_session(self.sessions_dir, "gone")
        deleted = self.index.delete("session-gone")
        self.assertEqual(deleted, path)
        self.assertFalse(path.exists())

    def test_delete_unknown_id_raises(self) -> None:
        with self.assertRaises(FileNotFoundError):
            self.index.delete("nope")

    def test_delete_refuses_files_outside_the_session_dirs(self) -> None:
        stranger = self.root / "elsewhere.jsonl"
        stranger.write_text("{}\n", encoding="utf-8")
        with self.assertRaises(FileNotFoundError):
            self.index.delete(str(stranger))
        self.assertTrue(stranger.exists())


class RenameTests(unittest.TestCase):
    """`SessionIndex.rename` 只重写会话文件头部，历史条目必须原样保留。"""

    def setUp(self) -> None:
        self._tmp = temp_dir_obj()
        self.root = Path(self._tmp.name)
        self.sessions_dir = SessionLayout(self.root / "user" / "sessions").workspace_dir(self.root / "proj")
        self.index = SessionIndex(cwd=self.root / "proj", user_dir=self.root / "user")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_rename_writes_the_label_into_the_first_line(self) -> None:
        path = _write_session(self.sessions_dir, "old", title="自动标题")
        before = path.read_text(encoding="utf-8").splitlines()

        renamed = self.index.rename("session-old", "手工标题")

        self.assertEqual(renamed, path)
        after = path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(json.loads(after[0])["_meta"]["_label"], "手工标题")
        # 除首行外一个字节都不该动：历史条目是用户数据的唯一副本。
        self.assertEqual(after[1:], before[1:])
        session = read_session_file(path)
        assert session is not None
        self.assertEqual(session.title, "手工标题")
        self.assertEqual(session.message_count, 2)

    def test_rename_without_a_label_restores_the_automatic_title(self) -> None:
        path = _write_session(self.sessions_dir, "auto", title="首条用户消息")
        self.index.rename("session-auto", "手工标题")

        self.index.rename("session-auto", None)

        session = read_session_file(path)
        assert session is not None
        self.assertEqual(session.title, "首条用户消息")

    def test_rename_unknown_id_raises(self) -> None:
        with self.assertRaises(FileNotFoundError):
            self.index.rename("nope", "标题")

    def test_rename_refuses_files_outside_the_session_dirs(self) -> None:
        stranger = self.root / "elsewhere.jsonl"
        stranger.write_text(json.dumps({"_meta": {"cwd": str(self.root)}}) + "\n", encoding="utf-8")
        with self.assertRaises(FileNotFoundError):
            self.index.rename(str(stranger), "标题")


class BranchLabelTests(unittest.TestCase):
    """分叉会话的题名：`原标题-分支`，再分叉一次就是 `原标题-分支2`。"""

    def test_first_fork_appends_the_suffix(self) -> None:
        self.assertEqual(branch_label("runtime.py 并发约束审查"), "runtime.py 并发约束审查-分支")

    def test_forking_a_branch_counts_up(self) -> None:
        self.assertEqual(branch_label("审查-分支"), "审查-分支2")
        self.assertEqual(branch_label("审查-分支2"), "审查-分支3")
        self.assertEqual(branch_label("审查-分支9"), "审查-分支10")

    def test_suffix_inside_a_longer_title_is_not_a_counter(self) -> None:
        # 「-分支」后面跟的不是数字，就当成标题本身的一部分，只加一级。
        self.assertEqual(branch_label("分支-分支说明"), "分支-分支说明-分支")

    def test_blank_and_overlong_titles(self) -> None:
        self.assertEqual(branch_label("  新 会话  "), "新 会话-分支")
        self.assertEqual(len(branch_label("长" * 400)), MAX_LABEL_LENGTH)
        self.assertTrue(branch_label("长" * 400).endswith("-分支"))


class _FakeState:
    model = None


class _FakeRuntime:
    """只实现被 `sessions.new` / `sessions.delete` 用到的那一小部分。"""

    def __init__(self, session_file: Path, cwd: Path) -> None:
        self.session_file = session_file
        self.cwd = cwd
        self.switch_calls = 0
        self.state = _FakeState()
        self.available_models: list[object] = []
        self.project_trusted = True
        self.permission_mode = "full-access"

    async def new_session(self, **_kwargs: object) -> None:
        # 真实 runtime 只规划路径；首条消息之前不创建文件。
        new_file = self.session_file.parent.parent / "session-new-draft" / "session.jsonl"
        self.session_file = new_file

    async def switch_session(self, path: str) -> None:
        self.switch_calls += 1
        self.session_file = Path(path)


class _FakeEntry:
    def __init__(self, data: object) -> None:
        self.type = "message"
        self.data = data


class _FakeMessage:
    def __init__(self, text: str) -> None:
        self.content = text


class _FakeSession:
    def __init__(self, entries: list[object]) -> None:
        self._entries = entries

    def get_branch(self) -> list[object]:
        return list(self._entries)


class HostSessionCommandTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._tmp = temp_dir_obj()
        self.root = Path(self._tmp.name)
        self.cwd = self.root / "proj"
        self.sessions_dir = SessionLayout(self.root / "user" / "sessions").workspace_dir(self.cwd)
        self.live = _write_session(self.sessions_dir, "live-1", title="当前会话")
        self.old = _write_session(self.sessions_dir, "old-1", title="旧会话")
        self.host = ServeHost(cwd=self.cwd, user_dir=self.root / "user")
        self.runtime = _FakeRuntime(self.live, self.cwd)
        # 直接注入替身：起真实 AgentSessionRuntime 需要 API key 和一个模型。
        self.host._runtime = self.runtime  # noqa: SLF001
        self.host._policy = PermissionPolicy("workspace-modify", cwd=self.cwd)  # noqa: SLF001
        self.host._sessions = SessionIndex(cwd=self.cwd, user_dir=self.root / "user")  # noqa: SLF001

    def tearDown(self) -> None:
        self._tmp.cleanup()

    async def test_new_session_reads_the_path_from_the_runtime(self) -> None:
        sent: list[dict[str, object]] = []
        self.host._send = lambda payload: sent.append(payload)  # noqa: SLF001
        summary = await self.host.handle("sessions.new", {})
        self.assertEqual(summary["id"], "session-new-draft")
        self.assertFalse(Path(summary["file"]).exists())
        kinds = [frame["frame"]["type"] for frame in sent if "frame" in frame]  # type: ignore[index]
        self.assertIn("session_start", kinds)

    async def test_new_session_keeps_the_running_runtime_alive(self) -> None:
        background = self.runtime
        candidate_file = _write_session(self.sessions_dir, "new-live", title="新会话")
        candidate = _FakeRuntime(candidate_file, self.cwd)
        self.host._agent_running = True  # noqa: SLF001
        self.host._running_runtimes.add(id(background))  # noqa: SLF001
        self.host._register_runtime(background)  # noqa: SLF001
        self.host._build_runtime = lambda **_kwargs: candidate  # type: ignore[method-assign]  # noqa: SLF001

        summary = await self.host.handle("sessions.new", {})

        self.assertEqual(summary["id"], "session-new-live")
        self.assertIs(self.host._runtime, candidate)  # noqa: SLF001
        self.assertIn(id(background), self.host._running_runtimes)  # noqa: SLF001
        self.assertEqual(background.session_file, self.live)

    async def test_opening_the_live_session_is_a_noop(self) -> None:
        sent: list[dict[str, object]] = []
        self.host._send = lambda payload: sent.append(payload)  # noqa: SLF001
        self.host._agent_running = True  # noqa: SLF001

        summary = await self.host.handle("sessions.open", {"id": "session-live-1"})

        self.assertEqual(summary["id"], "session-live-1")
        self.assertEqual(self.runtime.switch_calls, 0)
        self.assertEqual(sent, [])

    async def test_delete_removes_a_history_session(self) -> None:
        result = await self.host.handle("sessions.delete", {"id": "session-old-1"})
        self.assertEqual(result["id"], "session-old-1")
        self.assertFalse(self.old.exists())

    async def test_delete_refuses_the_live_session(self) -> None:
        with self.assertRaises(HostError) as ctx:
            await self.host.handle("sessions.delete", {"id": "session-live-1"})
        self.assertIn("正在使用", str(ctx.exception))
        self.assertTrue(self.live.exists())

    async def test_delete_unknown_session_raises_host_error(self) -> None:
        with self.assertRaises(HostError):
            await self.host.handle("sessions.delete", {"id": "missing"})

    async def test_rename_updates_a_history_session(self) -> None:
        result = await self.host.handle(
            "sessions.rename", {"id": "session-old-1", "title": "  改过的标题  "}
        )
        self.assertEqual(result["id"], "session-old-1")
        self.assertEqual(result["title"], "改过的标题")
        session = read_session_file(self.old)
        assert session is not None
        self.assertEqual(session.title, "改过的标题")

    async def test_rename_of_the_live_session_goes_through_its_storage(self) -> None:
        """活动会话不能直接改磁盘：storage 在内存里握着旧标题，会被下一次 append 抹掉。"""

        labels: list[str | None] = []

        class _Storage:
            def set_label(self, label: str | None) -> None:
                labels.append(label)

        self.runtime.session = type("_S", (), {"storage": _Storage()})()
        self.host._register_runtime(self.runtime)  # noqa: SLF001

        result = await self.host.handle("sessions.rename", {"id": "session-live-1", "title": "活动会话"})

        self.assertEqual(result["id"], "session-live-1")
        self.assertEqual(labels, ["活动会话"])
        session = read_session_file(self.live)
        assert session is not None
        # 磁盘内容是替身 storage 的事（真实 storage 会自己原子落盘），宿主不越权直接改。
        self.assertEqual(session.title, "当前会话")

    async def test_rename_requires_an_id_and_clamps_long_titles(self) -> None:
        with self.assertRaises(HostError):
            await self.host.handle("sessions.rename", {})
        result = await self.host.handle(
            "sessions.rename", {"id": "session-old-1", "title": "长" * 200}
        )
        self.assertEqual(len(result["title"]), MAX_LABEL_LENGTH)

    def test_context_tokens_estimates_from_the_branch(self) -> None:
        session = _FakeSession([_FakeEntry(_FakeMessage("你好" * 50))])
        self.runtime.agent_session = type(
            "_A", (), {"session": session, "context_tokens": lambda self: 123}
        )()
        self.host._runtime = self.runtime  # noqa: SLF001
        value = self.host._context_tokens()  # noqa: SLF001
        self.assertEqual(value, 123)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
