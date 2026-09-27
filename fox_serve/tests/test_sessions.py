"""会话索引与 `sessions.new` / `sessions.delete` 的回归测试。

覆盖三类曾经出问题的地方：

- `SessionSummary.createdAt/updatedAt` 必须是毫秒数字（前端按 number 声明）；
- `sessions.new` 不能依赖 `runtime.new_session()` 的返回值（它返回 None）；
- `sessions.delete` 只能删会话目录里的文件，且不许删当前正在用的会话。
"""

from __future__ import annotations

import json
import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fox_serve.approvals import PermissionPolicy  # noqa: E402
from fox_serve.host import HostError, ServeHost  # noqa: E402
from fox_serve.sessions import SessionIndex, _epoch_ms, read_session_file  # noqa: E402
from fox_serve.tests._tmp import temp_dir_obj  # noqa: E402


def _write_session(
    directory: Path,
    name: str,
    *,
    title: str = "你好",
    created: str = "2026-09-27T22:00:00",
) -> Path:
    """写一个最小可用的会话文件（meta 行 + 一问一答）。"""

    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.jsonl"
    project = directory.parent.parent
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
        self.sessions_dir = self.root / "proj" / ".foxcode" / "sessions"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_summary_timestamps_are_numbers(self) -> None:
        _write_session(self.sessions_dir, "s-1")
        summary = read_session_file(self.sessions_dir / "s-1.jsonl", live=False)
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
        self.assertEqual([item["id"] for item in listed], ["new", "old"])
        self.assertGreaterEqual(
            newer.stat().st_mtime, older.stat().st_mtime
        )


class DeleteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = temp_dir_obj()
        self.root = Path(self._tmp.name)
        self.sessions_dir = self.root / "proj" / ".foxcode" / "sessions"
        self.index = SessionIndex(cwd=self.root / "proj", user_dir=self.root / "user")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_delete_removes_the_file(self) -> None:
        path = _write_session(self.sessions_dir, "gone")
        deleted = self.index.delete("gone")
        self.assertEqual(deleted, path)
        self.assertFalse(path.exists())

    def test_delete_unknown_id_raises(self) -> None:
        with self.assertRaises(FileNotFoundError):
            self.index.delete("nope")

    def test_delete_refuses_files_outside_the_session_dirs(self) -> None:
        stranger = self.root / "elsewhere.jsonl"
        stranger.write_text("{}\n", encoding="utf-8")
        with self.assertRaises(PermissionError):
            self.index.delete(str(stranger))
        self.assertTrue(stranger.exists())


class _FakeState:
    model = None


class _FakeRuntime:
    """只实现被 `sessions.new` / `sessions.delete` 用到的那一小部分。"""

    def __init__(self, session_file: Path, cwd: Path) -> None:
        self.session_file = session_file
        self.cwd = cwd
        self.state = _FakeState()
        self.available_models: list[object] = []
        self.project_trusted = True
        self.permission_mode = "full-access"

    async def new_session(self, **_kwargs: object) -> None:
        # 真实 runtime 的 new_session() 没有返回值，路径由 _install 写进 session_file。
        new_file = self.cwd / "新增会话.jsonl"
        new_file.write_text(
            json.dumps(
                {"_meta": {"cwd": str(self.cwd), "timestamp": "2026-09-27T23:00:00"}},
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        self.session_file = new_file


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
        self.sessions_dir = self.cwd / ".foxcode" / "sessions"
        self.live = _write_session(self.sessions_dir, "live-1", title="当前会话")
        self.old = _write_session(self.sessions_dir, "old-1", title="旧会话")
        self.host = ServeHost(cwd=self.cwd, user_dir=self.root / "user")
        self.runtime = _FakeRuntime(self.live, self.cwd)
        # 直接注入替身：起真实 AgentSessionRuntime 需要 API key 和一个模型。
        self.host._runtime = self.runtime  # noqa: SLF001
        self.host._policy = PermissionPolicy("workspace-write", cwd=self.cwd)  # noqa: SLF001
        self.host._sessions = SessionIndex(cwd=self.cwd, user_dir=self.root / "user")  # noqa: SLF001

    def tearDown(self) -> None:
        self._tmp.cleanup()

    async def test_new_session_reads_the_path_from_the_runtime(self) -> None:
        sent: list[dict[str, object]] = []
        self.host._send = lambda payload: sent.append(payload)  # noqa: SLF001
        summary = await self.host.handle("sessions.new", {})
        self.assertEqual(summary["id"], "新增会话")
        self.assertTrue(Path(summary["file"]).is_file())
        kinds = [frame["frame"]["type"] for frame in sent if "frame" in frame]  # type: ignore[index]
        self.assertIn("session_start", kinds)

    async def test_delete_removes_a_history_session(self) -> None:
        result = await self.host.handle("sessions.delete", {"id": "old-1"})
        self.assertEqual(result["id"], "old-1")
        self.assertFalse(self.old.exists())

    async def test_delete_refuses_the_live_session(self) -> None:
        with self.assertRaises(HostError) as ctx:
            await self.host.handle("sessions.delete", {"id": "live-1"})
        self.assertIn("正在使用", str(ctx.exception))
        self.assertTrue(self.live.exists())

    async def test_delete_unknown_session_raises_host_error(self) -> None:
        with self.assertRaises(HostError):
            await self.host.handle("sessions.delete", {"id": "missing"})

    def test_context_tokens_estimates_from_the_branch(self) -> None:
        session = _FakeSession([_FakeEntry(_FakeMessage("你好" * 50))])
        self.runtime.agent_session = type("_A", (), {"session": session})()
        self.host._runtime = self.runtime  # noqa: SLF001
        value = self.host._context_tokens()  # noqa: SLF001
        self.assertIsInstance(value, int)
        self.assertGreater(value, 0)

    def test_compaction_payload_drops_the_retained_tail(self) -> None:
        session = _FakeSession([_FakeEntry(_FakeMessage("上下文" * 100))])
        self.runtime.agent_session = type("_A", (), {"session": session})()
        self.host._runtime = self.runtime  # noqa: SLF001
        self.host._pre_compact_tokens = 100_000  # noqa: SLF001
        payload = {
            "type": "compaction_end",
            "automatic": True,
            "result": {"summary": "摘要", "retainedTail": [1, 2, 3], "removedCount": 7},
        }
        out = self.host._compaction_payload(payload)  # noqa: SLF001
        self.assertEqual(out["preTokens"], 100_000)
        self.assertIsInstance(out["postTokens"], int)
        self.assertEqual(out["summary"], "摘要")
        self.assertEqual(out["removedCount"], 7)
        self.assertEqual(out["retainedCount"], 3)
        self.assertTrue(out["automatic"])
        self.assertNotIn("retainedTail", out)
        self.assertNotIn("result", out)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
