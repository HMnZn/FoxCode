"""`cwd.change` 的失败翻译。

界面唯一的入口就是「选一个工作区文件夹」；目标目录不存在或不可写时，runtime 会
在最深处抛一个英文 `PermissionError`，用户只看到「工作区无法切换」而不知道原因。
所以 `_cmd_cwd_change` 自己先检查一遍，这里钉住那几句中文错误。

只测失败分支：成功分支要真 runtime（`_policy`、`SessionIndex`、会话事件），属于
真实宿主联调的范畴，不在单测里造。
"""

from __future__ import annotations

import unittest
from pathlib import Path
from typing import Any

from fox_serve.host import HostError, ServeHost
from fox_serve.tests._tmp import temp_dir_obj

MISSING = "definitely-not-a-real-directory-9d3f"


class _StubRuntime:
    """只提供 `_cmd_cwd_change` 在失败之前会碰到的两个属性。"""

    def __init__(self, cwd: str) -> None:
        self.cwd = cwd

    async def change_cwd(self, cwd: str) -> None:  # pragma: no cover - 失败分支走不到
        self.cwd = cwd


def _bare_host(runtime: Any) -> ServeHost:
    """绕过 `ServeHost.__init__`：这几个分支在碰 `_policy` / 会话之前就抛错了。"""

    host = ServeHost.__new__(ServeHost)
    host._runtime = runtime
    host._closed = False
    return host


class CwdChangeFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_requires_a_path(self) -> None:
        host = _bare_host(_StubRuntime("C:/x"))
        with self.assertRaises(HostError) as caught:
            await host._cmd_cwd_change({})
        self.assertIn("需要 cwd", str(caught.exception))

    async def test_reports_a_missing_directory(self) -> None:
        host = _bare_host(_StubRuntime("C:/x"))
        with self.assertRaises(HostError) as caught:
            await host._cmd_cwd_change({"cwd": MISSING})
        self.assertIn("工作区不存在或不是目录", str(caught.exception))
        self.assertIn(MISSING, str(caught.exception))

    async def test_reports_an_unwritable_directory(self) -> None:
        # `<target>/.foxcode` 被一个同名文件占住：`mkdir` 抛 OSError，正是真实的
        # 「目录不可写」情形，且不依赖 Windows ACL。
        with temp_dir_obj("cwd-test-") as raw:
            target = Path(raw)
            (target / ".foxcode").write_text("not a directory", encoding="utf-8")
            host = _bare_host(_StubRuntime("C:/x"))
            with self.assertRaises(HostError) as caught:
                await host._cmd_cwd_change({"cwd": str(target)})
        message = str(caught.exception)
        self.assertIn("工作区不可写", message)
        self.assertIn(".foxcode", message)

    async def test_translates_a_runtime_error(self) -> None:
        class _Broken(_StubRuntime):
            async def change_cwd(self, cwd: str) -> None:
                raise PermissionError(f"[WinError 5] 拒绝访问: {cwd}")

        with temp_dir_obj("cwd-test-") as raw:
            host = _bare_host(_Broken("C:/x"))
            with self.assertRaises(HostError) as caught:
                await host._cmd_cwd_change({"cwd": raw})
        message = str(caught.exception)
        self.assertIn("切换工作区失败", message)
        self.assertIn("PermissionError", message)
