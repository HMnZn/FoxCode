"""`workspace_files` 的回归测试：右侧栏「改动清单 / 差异 / 预览」的数据来源。

三类必须守住的东西：

- **解析**：git 的输出格式（porcelain、numstat、引号路径）不能把清单带崩；
- **守界**：只允许读工作目录与其所在仓库根以内的文件；
- **git 只是增强**：不在仓库里时 `changes` 要返回 `error` 而不是抛异常。
"""

from __future__ import annotations

import base64
import shutil
import subprocess
import sys
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fox_serve import workspace_files  # noqa: E402
from fox_serve.host import HostError, ServeHost  # noqa: E402
from fox_serve.tests._tmp import drop as _drop  # noqa: E402
from fox_serve.tests._tmp import temp_dir as _temp_dir  # noqa: E402
from fox_serve.workspace_files import (  # noqa: E402
    WorkspaceFileError,
    _resolve,
    changes,
    directory,
    diff,
    display_path,
    is_excluded,
    parse_binary_numstat,
    parse_numstat,
    parse_porcelain,
    read,
    synthesize_untracked_diff,
    unquote_git_path,
)

GIT = shutil.which("git")



async def _no_repo(*_args: object, **_kwargs: object) -> None:
    """`repo_root` 的打桩：假装当前目录不属于任何仓库。"""

    return None


def _git(*args: str, cwd: Path) -> None:
    subprocess.run(
        ["git", "-c", "core.quotePath=false", *args],
        cwd=str(cwd),
        check=True,
        capture_output=True,
    )


class ParserTests(unittest.TestCase):
    def test_porcelain_maps_status_codes(self) -> None:
        text = "\n".join(
            [
                " M desktop/src/App.tsx",
                "M  staged.py",
                "A  added.py",
                " D gone.py",
                "?? brand-new.txt",
            ]
        )
        entries = parse_porcelain(text)
        self.assertEqual(
            [(item["path"], item["status"]) for item in entries],
            [
                ("desktop/src/App.tsx", "modified"),
                ("staged.py", "modified"),
                ("added.py", "added"),
                ("gone.py", "deleted"),
                ("brand-new.txt", "untracked"),
            ],
        )
        self.assertFalse(entries[0]["staged"])
        self.assertTrue(entries[1]["staged"])
        self.assertTrue(entries[-1]["untracked"])

    def test_porcelain_ignores_short_lines(self) -> None:
        self.assertEqual(parse_porcelain("\nxx\n\n"), [])

    def test_porcelain_keeps_quoted_paths(self) -> None:
        entries = parse_porcelain('?? "a\\tb.txt"')
        self.assertEqual(entries[0]["path"], "a\tb.txt")

    def test_numstat_sums_duplicates_and_flags_binary(self) -> None:
        text = "12\t3\tdesktop/src/App.tsx\n-\t-\tlogo.png\n4\t0\tdesktop/src/App.tsx"
        self.assertEqual(parse_numstat(text)["desktop/src/App.tsx"], (16, 3))
        self.assertEqual(parse_binary_numstat(text), {"logo.png"})

    def test_unquote_handles_escapes_and_plain_text(self) -> None:
        self.assertEqual(unquote_git_path("plain.py"), "plain.py")
        self.assertEqual(unquote_git_path('"tab\\there.py"'), "tab\there.py")

    def test_display_path_keeps_going_up_with_dotdot(self) -> None:
        base = _temp_dir()
        try:
            inner = base / "pkg"
            inner.mkdir()
            target = base / "README.md"
            target.write_text("x", encoding="utf-8")
            self.assertEqual(display_path(inner, target), "../README.md")
            self.assertEqual(display_path(base, target), "README.md")
        finally:
            _drop(base)

    def test_is_excluded_looks_at_every_segment(self) -> None:
        self.assertTrue(is_excluded(".build-cache/npm/x.json", (".build-cache",)))
        self.assertTrue(is_excluded("node_modules/react/index.js", (".build-cache", "node_modules")))
        # 未跟踪目录会把整棵子树带出来，所以任意一段命中都要忽略。
        self.assertTrue(is_excluded("desktop/node_modules/x.js", ("node_modules",)))
        self.assertTrue(is_excluded("desktop/dist/assets/index.js", ("dist",)))
        self.assertFalse(is_excluded("desktop/src/App.tsx", ("node_modules", "dist")))

    def test_synthetic_diff_marks_every_line_as_added(self) -> None:
        text = synthesize_untracked_diff("new.txt", "a\nb", truncated=False)
        self.assertIn("--- /dev/null", text)
        self.assertIn("+++ b/new.txt", text)
        self.assertIn("@@ -0,0 +1,2 @@", text)
        self.assertTrue(text.endswith("+a\n+b"))


class ResolveGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_directory_lists_one_level_and_hides_generated_folders(self) -> None:
        base = _temp_dir()
        try:
            (base / "src").mkdir()
            (base / "src" / "main.py").write_text("print('ok')", encoding="utf-8")
            (base / "README.md").write_text("hello", encoding="utf-8")
            (base / "node_modules").mkdir()
            payload = await directory(base)
            self.assertEqual(
                [(entry["name"], entry["type"]) for entry in payload["entries"]],
                [("src", "directory"), ("README.md", "file")],
            )
            nested = await directory(base, "src")
            self.assertEqual(nested["path"], "src")
            self.assertEqual(nested["entries"][0]["path"], "src/main.py")
        finally:
            _drop(base)

    async def test_directory_rejects_paths_outside_the_workspace(self) -> None:
        base = _temp_dir()
        try:
            workspace = base / "work"
            workspace.mkdir()
            with self.assertRaises(WorkspaceFileError):
                await directory(workspace, "..")
        finally:
            _drop(base)

    async def test_rejects_relative_paths_escaping_the_workspace(self) -> None:
        base = _temp_dir()
        try:
            workspace = base / "work"
            workspace.mkdir()
            (base / "secret.txt").write_text("nope", encoding="utf-8")
            # 直接打 `_resolve`：不带仓库根，纯测守界规则。
            with self.assertRaises(WorkspaceFileError):
                _resolve(workspace, "../secret.txt")
            with self.assertRaises(WorkspaceFileError):
                _resolve(workspace, str(base / "secret.txt"))
        finally:
            _drop(base)

    async def test_allows_paths_inside_an_extra_root(self) -> None:
        base = _temp_dir()
        try:
            workspace = base / "pkg"
            workspace.mkdir()
            target = base / "shared.txt"
            target.write_text("ok", encoding="utf-8")
            resolved, display, relative = _resolve(
                workspace, "../shared.txt", extra_root=base
            )
            self.assertEqual(resolved, target.resolve())
            self.assertEqual(display, "../shared.txt")
            self.assertEqual(relative, "shared.txt")
        finally:
            _drop(base)

    async def test_reports_missing_and_directory_paths(self) -> None:
        base = _temp_dir()
        try:
            with self.assertRaises(WorkspaceFileError):
                await read(base, "missing.txt")
            with self.assertRaises(WorkspaceFileError):
                await read(base, ".")
        finally:
            _drop(base)


@unittest.skipIf(GIT is None, "需要 git 可执行文件")
class RepoWorkspaceTests(unittest.IsolatedAsyncioTestCase):
    """真仓库里的端到端行为（git init + 一次提交）。"""

    def setUp(self) -> None:
        self.repo = _temp_dir("test-repo-")
        _git("init", "--quiet", cwd=self.repo)
        _git("config", "user.email", "t@example.com", cwd=self.repo)
        _git("config", "user.name", "tester", cwd=self.repo)
        self.tracked = self.repo / "tracked.txt"
        self.tracked.write_text("one\ntwo\nthree\n", encoding="utf-8")
        _git("add", "tracked.txt", cwd=self.repo)
        _git("commit", "--quiet", "-m", "init", cwd=self.repo)

    def tearDown(self) -> None:
        _drop(self.repo)

    async def test_changes_lists_modified_and_untracked(self) -> None:
        self.tracked.write_text("one\ntwo\nthree\nfour\n", encoding="utf-8")
        (self.repo / "fresh.txt").write_text("a\nb\n", encoding="utf-8")
        payload = await changes(self.repo)
        self.assertTrue(payload["repo"])
        self.assertIsNone(payload["error"])
        by_path = {item["path"]: item for item in payload["files"]}
        self.assertEqual(by_path["tracked.txt"]["status"], "modified")
        self.assertEqual(by_path["tracked.txt"]["additions"], 1)
        self.assertEqual(by_path["fresh.txt"]["status"], "untracked")
        self.assertEqual(by_path["fresh.txt"]["additions"], 2)
        self.assertEqual(payload["root"], str(self.repo))

    async def test_changes_skips_excluded_untracked_directories(self) -> None:
        cache = self.repo / ".build-cache" / "npm"
        cache.mkdir(parents=True)
        (cache / "blob.json").write_text("{}", encoding="utf-8")
        (self.repo / "keep.txt").write_text("x\n", encoding="utf-8")
        payload = await changes(self.repo)
        paths = [item["path"] for item in payload["files"]]
        self.assertIn("keep.txt", paths)
        self.assertFalse([path for path in paths if path.startswith(".build-cache")])

    async def test_diff_for_tracked_file_carries_hunks(self) -> None:
        self.tracked.write_text("one\nTWO\nthree\n", encoding="utf-8")
        payload = await diff(self.repo, "tracked.txt")
        self.assertIsNone(payload["error"])
        self.assertIn("@@", str(payload["diff"]))
        self.assertIn("+TWO", str(payload["diff"]))
        self.assertEqual(payload["additions"], 1)
        self.assertEqual(payload["deletions"], 1)

    async def test_diff_for_untracked_file_is_all_additions(self) -> None:
        (self.repo / "brand.txt").write_text("hello\nworld\n", encoding="utf-8")
        payload = await diff(self.repo, "brand.txt")
        self.assertTrue(payload["untracked"])
        self.assertIn("+++ b/brand.txt", str(payload["diff"]))
        self.assertIn("+hello", str(payload["diff"]))

    async def test_diff_for_untracked_file_before_first_commit(self) -> None:
        unborn = _temp_dir("test-unborn-repo-")
        try:
            _git("init", "--quiet", cwd=unborn)
            (unborn / "first.txt").write_text("first project file\n", encoding="utf-8")
            payload = await diff(unborn, "first.txt")
            self.assertIsNone(payload["error"])
            self.assertTrue(payload["untracked"])
            self.assertEqual(payload["additions"], 1)
            self.assertIn("+++ b/first.txt", str(payload["diff"]))
            self.assertIn("+first project file", str(payload["diff"]))
        finally:
            _drop(unborn)

    async def test_diff_and_read_accept_absolute_paths(self) -> None:
        self.tracked.write_text("one\ntwo\nthree\nfour\nfive\n", encoding="utf-8")
        payload = await diff(self.repo, str(self.tracked))
        self.assertIn("+five", str(payload["diff"]))
        content = await read(self.repo, str(self.tracked))
        self.assertIn("five", content["text"])
        self.assertFalse(content["binary"])

    async def test_read_marks_binary_files(self) -> None:
        (self.repo / "blob.bin").write_bytes(b"\x00\x01\x02binary")
        payload = await read(self.repo, "blob.bin")
        self.assertTrue(payload["binary"])
        self.assertEqual(payload["text"], "")
        self.assertEqual(payload["kind"], "binary")

    async def test_read_returns_a_png_as_base64(self) -> None:
        # 1×1 透明 PNG：图片不带文本，但渲染进程要有 `data` 才能画出来。
        png = bytes.fromhex(
            "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
            "1f15c4890000000a49444154789c63000100000500010d0a2db4000000"
            "0049454e44ae426082"
        )
        (self.repo / "tiny.png").write_bytes(png)
        payload = await read(self.repo, "tiny.png")
        self.assertEqual(payload["kind"], "image")
        self.assertEqual(payload["mime"], "image/png")
        self.assertEqual(payload["size"], len(png))
        self.assertFalse(payload["binary"])
        self.assertIsNone(payload["error"])
        self.assertEqual(base64.b64decode(str(payload["data"])), png)

    async def test_read_refuses_to_inline_an_oversized_image(self) -> None:
        path = self.repo / "huge.png"
        path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
        with unittest.mock.patch.object(workspace_files, "MAX_IMAGE_BYTES", 8):
            payload = await read(self.repo, "huge.png")
        self.assertEqual(payload["kind"], "image")
        self.assertIsNone(payload["data"])
        self.assertTrue(payload["error"])
        self.assertIn("超过内嵌预览上限", str(payload["error"]))

    async def test_changes_outside_a_repo_reports_an_error(self) -> None:
        # 测试仓库就建在 `.build-cache/tmp` 里（见 `_temp_dir`），那底下不属于任何
        # 仓库，但为了不依赖这一点，还是把 repo_root 打桩成 None，专测「不在仓库里」
        # 这条分支。
        with unittest.mock.patch.object(workspace_files, "repo_root", new=_no_repo):
            payload = await changes(self.repo)
        self.assertFalse(payload["repo"])
        self.assertTrue(payload["error"])


@unittest.skipIf(GIT is None, "需要 git 可执行文件")
class HostFileCommandTests(unittest.IsolatedAsyncioTestCase):
    """命令分发层：方法名、参数与错误翻译。"""

    def setUp(self) -> None:
        self.repo = _temp_dir("test-repo-")
        _git("init", "--quiet", cwd=self.repo)
        _git("config", "user.email", "t@example.com", cwd=self.repo)
        _git("config", "user.name", "tester", cwd=self.repo)
        target = self.repo / "a.txt"
        target.write_text("one\n", encoding="utf-8")
        _git("add", "a.txt", cwd=self.repo)
        _git("commit", "--quiet", "-m", "init", cwd=self.repo)
        target.write_text("one\ntwo\n", encoding="utf-8")
        self.host = ServeHost(cwd=self.repo)

    def tearDown(self) -> None:
        _drop(self.repo)

    async def test_files_changes_command(self) -> None:
        payload = await self.host.handle("files.changes")
        self.assertTrue(payload["repo"])
        self.assertEqual([item["path"] for item in payload["files"]], ["a.txt"])

    async def test_files_list_command(self) -> None:
        payload = await self.host.handle("files.list", {"path": ""})
        self.assertIn("a.txt", [item["name"] for item in payload["entries"]])

    async def test_files_diff_and_read_commands(self) -> None:
        diff_payload = await self.host.handle("files.diff", {"path": "a.txt"})
        self.assertIn("+two", str(diff_payload["diff"]))
        read_payload = await self.host.handle("files.read", {"path": "a.txt"})
        # Windows 上 `write_text` 会把换行写成 CRLF，断言前先归一化。
        self.assertEqual(
            str(read_payload["text"]).replace("\r\n", "\n"), "one\ntwo\n"
        )

    async def test_read_outside_the_workspace_raises_host_error(self) -> None:
        with self.assertRaises(HostError):
            await self.host.handle("files.read", {"path": "../../etc/hosts"})

    async def test_unknown_method_still_raises(self) -> None:
        with self.assertRaises(HostError):
            await self.host.handle("files.nope")
