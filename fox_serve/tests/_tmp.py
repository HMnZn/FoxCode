"""测试临时目录的统一落点。

为什么需要它：这台机器上 Python 的 `tempfile.gettempdir()` 会退化成**当前工作目录**
（`TEMP`／`TMP` 指向不可写的沙箱目录时会一路回退到 cwd），于是 `mkdtemp()` 会在仓库根
留下一堆 `tmpXXXXXXXX` 临时 git 仓库。统一落到 `.build-cache/tmp`：它既在 `.gitignore`
里，也在 `workspace_files.DEFAULT_EXCLUDES` 里，即使测试中途被打断也不会污染改动清单。
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

#: 测试临时文件的落点（仓库根下的忽略目录）。
TMP_ROOT = Path(__file__).resolve().parents[2] / ".build-cache" / "tmp"


def _ensure() -> Path:
    TMP_ROOT.mkdir(parents=True, exist_ok=True)
    return TMP_ROOT


def temp_dir(prefix: str = "test-") -> Path:
    """建一个临时目录，调用方负责 `drop`（适合 `mkdtemp` 的用法）。"""

    return Path(tempfile.mkdtemp(prefix=prefix, dir=str(_ensure()))).resolve()


def temp_dir_obj(prefix: str = "test-") -> tempfile.TemporaryDirectory[str]:
    """交给 `TemporaryDirectory` 管理的临时目录（出作用域自动删）。"""

    return tempfile.TemporaryDirectory(prefix=prefix, dir=str(_ensure()))


def drop(path: Path) -> None:
    """删干净：Windows 上 `.git/objects` 是只读的，`rmtree` 可能只删掉一半。"""

    for item in [path, *path.rglob("*")]:
        try:
            item.chmod(0o700)
        except OSError:
            pass
    shutil.rmtree(path, ignore_errors=True)
