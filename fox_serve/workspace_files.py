"""工作区文件视图：把「改了哪些文件、每个文件差在哪、文件现在长什么样」喂给右侧栏。

设计取舍（与 DSH 的 `dsh-workspace-changes` 对照后选的轻方案）：

- **改动清单直接问 git**（`status --porcelain` + 两次 `diff --numstat`），不自己维护
  轮次快照。好处是零状态、shell 里手改的文件也在；代价是 Host 重启后仍然有清单
  （比 DSH 那种「重启即失忆」更耐用），而「本轮改动」这个语义由前端按会话时间线
  另行给出。
- **逐文件差异用 `git diff HEAD -U3`**；HEAD 里没有的未跟踪文件合成一份「整文件新增」
  的统一差异，这样预览面板对任意一行都能给出内容。
- **git 只是增强，不是依赖**：找不到 git、不在仓库里、命令超时都只返回 `error`
  字段，让右侧栏退回「本轮会话触碰的文件」，绝不把异常抛给 UI。
- 路径统一用 `-c core.quotePath=false`，避免非 ASCII 路径被 git 转义成八进制。
"""

from __future__ import annotations

import asyncio
import os
import subprocess
from pathlib import Path
from typing import Any

#: 改动清单里默认忽略的顶层目录（未跟踪文件专用）。这些目录里的文件对「我改了什么」
#: 没有信息量：构建缓存、依赖、Python 虚拟环境、会话记录。
DEFAULT_EXCLUDES: tuple[str, ...] = (
    ".build-cache",
    ".venv",
    ".git",
    "node_modules",
    "dist",
    "build",
    "__pycache__",
    ".foxcode",
    ".pytest_cache",
)

#: 单个文件最多读多少字节（预览用；超过就截断并置 `truncated`）。
MAX_FILE_BYTES = 2 * 1024 * 1024

#: 合成未跟踪文件差异时最多展开多少行（够看开头，不用等整个大文件）。
MAX_SYNTHETIC_LINES = 2000

_KIND_BY_CODE = {
    "A": "added",
    "M": "modified",
    "D": "deleted",
    "R": "renamed",
    "C": "renamed",
    "T": "typechange",
    "U": "conflicted",
    "?": "untracked",
}


class WorkspaceFileError(RuntimeError):
    """路径不合法或文件读不出来；由 `host.py` 翻成 `HostError` 回给前端。"""


# ----------------------------------------------------------------------
# 纯函数：解析 git 输出（单测直接打这些）
# ----------------------------------------------------------------------


def unquote_git_path(raw: str) -> str:
    """还原 git 偶尔加的引号（路径里有制表符/引号时才出现）。"""

    text = raw.strip()
    if len(text) < 2 or not text.startswith('"') or not text.endswith('"'):
        return text
    body = text[1:-1]
    out: list[str] = []
    index = 0
    while index < len(body):
        char = body[index]
        if char != "\\" or index + 1 >= len(body):
            out.append(char)
            index += 1
            continue
        escape = body[index + 1]
        mapping = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\"}
        if escape in mapping:
            out.append(mapping[escape])
            index += 2
            continue
        if escape.isdigit():  # 八进制字节序列
            digits = body[index + 1 : index + 4]
            try:
                out.append(chr(int(digits, 8)))
            except ValueError:
                out.append(escape)
            index += 4
            continue
        out.append(escape)
        index += 2
    return "".join(out)


def status_kind(index_code: str, worktree_code: str) -> str:
    """把 porcelain 的两列状态码压成一个前端好用的字面量。"""

    for code in (worktree_code, index_code):
        if code and code != " ":
            return _KIND_BY_CODE.get(code, "modified")
    return "modified"


def parse_porcelain(text: str) -> list[dict[str, Any]]:
    """解析 `git status --porcelain=v1 --no-renames`。

    每行形如 `XY PATH`（`XY` 两列、随后一个空格）。小于 4 字符的行直接跳过，
    这样 git 偶尔插入的提示行不会把整份清单带崩。
    """

    entries: list[dict[str, Any]] = []
    for line in text.splitlines():
        if len(line) < 4:
            continue
        index_code = line[0]
        worktree_code = line[1]
        path = unquote_git_path(line[3:])
        if not path:
            continue
        entries.append(
            {
                "path": path,
                "status": status_kind(index_code, worktree_code),
                "staged": index_code not in (" ", "?"),
                "untracked": index_code == "?" and worktree_code == "?",
            }
        )
    return entries


def parse_numstat(text: str) -> dict[str, tuple[int, int]]:
    """解析 `git diff --numstat`：`adds<TAB>dels<TAB>path`，二进制文件是 `-\\t-`。"""

    counts: dict[str, tuple[int, int]] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t", 2)
        if len(parts) < 3:
            continue
        adds, dels, path = parts
        path = unquote_git_path(path)
        if not path:
            continue
        added = 0 if adds == "-" else _safe_int(adds)
        removed = 0 if dels == "-" else _safe_int(dels)
        previous = counts.get(path)
        if previous is not None:
            added += previous[0]
            removed += previous[1]
        counts[path] = (added, removed)
    return counts


def parse_binary_numstat(text: str) -> set[str]:
    """`--numstat` 里加法/减法都是 `-` 的路径就是二进制。"""

    names: set[str] = set()
    for line in text.splitlines():
        parts = line.split("\t", 2)
        if len(parts) == 3 and parts[0] == "-" and parts[1] == "-":
            names.add(unquote_git_path(parts[2]))
    return names


def _safe_int(value: str) -> int:
    try:
        return int(value)
    except ValueError:
        return 0


def top_segment(path: str) -> str:
    """路径的第一段（`\\` 也当分隔符）。"""

    head = path.replace("\\", "/")
    while head.startswith("./"):
        head = head[2:]
    return head.split("/", 1)[0]


def is_excluded(path: str, excludes: tuple[str, ...]) -> bool:
    """路径的**任意一段**命中忽略名单就算忽略。

    按段（而不是只看第一段）判断，是因为未跟踪目录会整棵列出来：仓库里未跟踪的
    `desktop/` 会把 `desktop/node_modules/**` 一起带出来，那些文件对「我改了什么」
    没有信息量。
    """

    parts = path.replace("\\", "/").split("/")
    return any(part in excludes for part in parts)


def display_path(cwd: Path, absolute: Path) -> str:
    """相对会话工作目录的展示路径；工作目录之外保留 `../`。"""

    try:
        rel = os.path.relpath(str(absolute), str(cwd))
    except ValueError:  # pragma: no cover - 不同盘符才会走到
        return absolute.as_posix()
    return rel.replace("\\", "/")


def synthesize_untracked_diff(path: str, text: str, *, truncated: bool) -> str:
    """给未跟踪文件造一份「整文件新增」的统一差异。"""

    lines = text.splitlines()
    shown = lines[:MAX_SYNTHETIC_LINES]
    header = [f"--- /dev/null", f"+++ b/{path}", f"@@ -0,0 +1,{max(len(shown), 1)} @@"]
    body = [f"+{line}" for line in shown]
    if truncated or len(lines) > len(shown):
        body.append("+…（内容过长，已截断）")
    return "\n".join([*header, *body])


# ----------------------------------------------------------------------
# git 调用
# ----------------------------------------------------------------------


def _git_env() -> dict[str, str]:
    return {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_PAGER": "cat",
    }


def _run_git_sync(
    command: list[str], cwd: Path, timeout: float
) -> tuple[int, str, str]:
    """在工作线程里跑 git。

    这里刻意**不用** `asyncio.create_subprocess_exec`：sidecar 自己的 stdin/stdout 是
    Node 侧的管道，Windows 的 proactor 事件循环在这种进程里开子进程会让 git 拿不到
    管道关闭事件，`communicate()` 一直等到超时（实测 `git rev-parse` 卡满 20s）。
    换成线程 + `subprocess.run` 后同一仓库只要几十毫秒。
    """

    completed = subprocess.run(  # noqa: S603 - 参数是固定白名单，不经 shell
        command,
        cwd=str(cwd),
        env=_git_env(),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    return (
        completed.returncode,
        completed.stdout.decode("utf-8", "replace"),
        completed.stderr.decode("utf-8", "replace"),
    )


async def _git(
    args: list[str], cwd: Path, *, timeout: float
) -> tuple[int, str, str]:
    """跑一次 git，带超时与净化环境。返回 `(returncode, stdout, stderr)`。"""

    command = ["git", "-c", "core.quotePath=false", *args]
    try:
        return await asyncio.to_thread(_run_git_sync, command, cwd, timeout)
    except subprocess.TimeoutExpired as exc:
        raise WorkspaceFileError(f"git 超过 {timeout:.0f}s 没返回") from exc
    except FileNotFoundError as exc:
        raise WorkspaceFileError("找不到 git 可执行文件") from exc
    except OSError as exc:  # pragma: no cover - 权限等罕见情况
        raise WorkspaceFileError(f"无法启动 git：{exc}") from exc


async def repo_root(cwd: Path, *, timeout: float = 10.0) -> Path | None:
    """`cwd` 所属仓库的根；不在仓库里返回 None。"""

    try:
        code, out, _err = await _git(
            ["rev-parse", "--show-toplevel"], cwd, timeout=timeout
        )
    except WorkspaceFileError:
        return None
    if code != 0:
        return None
    text = out.strip()
    return Path(text) if text else None


# ----------------------------------------------------------------------
# 对外三个动作
# ----------------------------------------------------------------------


async def changes(
    cwd: Path,
    *,
    limit: int = 300,
    timeout: float = 20.0,
    excludes: tuple[str, ...] = DEFAULT_EXCLUDES,
) -> dict[str, Any]:
    """工作区改动清单（绝不抛异常，失败时给 `error`）。"""

    base: dict[str, Any] = {
        "cwd": str(cwd),
        "repo": False,
        "root": None,
        "branch": None,
        "files": [],
        "total": 0,
        "truncated": False,
        "error": None,
    }
    try:
        root = await repo_root(cwd, timeout=timeout)
        if root is None:
            base["error"] = "当前工作区不是 git 仓库，只能看本轮会话触碰的文件"
            return base
        code, status_text, status_err = await _git(
            ["status", "--porcelain=v1", "--no-renames", "--untracked-files=all"],
            root,
            timeout=timeout,
        )
        if code != 0:
            base["error"] = status_err.strip() or "git status 失败"
            return base

        entries = parse_porcelain(status_text)

        _code, unstaged, _err = await _git(
            ["diff", "--numstat", "--no-renames", "--no-color"],
            root,
            timeout=timeout,
        )
        _code, staged, _err = await _git(
            ["diff", "--cached", "--numstat", "--no-renames", "--no-color"],
            root,
            timeout=timeout,
        )
        counts = parse_numstat(unstaged)
        for path, pair in parse_numstat(staged).items():
            previous = counts.get(path, (0, 0))
            counts[path] = (previous[0] + pair[0], previous[1] + pair[1])
        binary = parse_binary_numstat(unstaged) | parse_binary_numstat(staged)

        _code, branch_out, _err = await _git(
            ["rev-parse", "--abbrev-ref", "HEAD"], root, timeout=timeout
        )
        base["root"] = str(root)
        base["repo"] = True
        base["branch"] = branch_out.strip() or None

        files: list[dict[str, Any]] = []
        for entry in entries:
            path = str(entry["path"])
            if entry["untracked"] and is_excluded(path, excludes):
                continue
            absolute = root / path
            added, removed = counts.get(path, (0, 0))
            truncated_file = False
            if entry["untracked"]:
                added, truncated_file = _count_lines(absolute)
                removed = 0
            files.append(
                {
                    "path": path,
                    "display": display_path(cwd, absolute),
                    "status": entry["status"],
                    "additions": added,
                    "deletions": removed,
                    "binary": path in binary,
                    "staged": bool(entry["staged"]),
                    "untracked": bool(entry["untracked"]),
                    "oversized": truncated_file,
                }
            )

        files.sort(key=lambda item: (str(item["status"]), str(item["path"]).lower()))
        base["total"] = len(files)
        base["truncated"] = len(files) > limit
        base["files"] = files[:limit]
        return base
    except WorkspaceFileError as exc:
        base["error"] = str(exc)
        return base
    except Exception as exc:  # noqa: BLE001 - 右侧栏不该因为 git 怪毛病整页报错
        base["error"] = f"{type(exc).__name__}: {exc}"
        return base


async def diff(
    cwd: Path,
    path: str,
    *,
    context: int = 3,
    timeout: float = 20.0,
    max_bytes: int = MAX_FILE_BYTES,
) -> dict[str, Any]:
    """单个文件的统一差异（未跟踪文件合成「整文件新增」）。"""

    target, display, repo_relative = _resolve(cwd, path)
    result: dict[str, Any] = {
        "path": display,
        "absolute": str(target),
        "diff": "",
        "binary": False,
        "untracked": False,
        "truncated": False,
        "additions": None,
        "deletions": None,
        "error": None,
    }
    root = await repo_root(cwd, timeout=timeout)
    if root is not None:
        # 用仓库根再解析一次，这样 `../` 形式的路径与 git 的相对路径都能对上。
        target, display, repo_relative = _resolve(cwd, path, extra_root=root)
        result["path"] = display
        result["absolute"] = str(target)
    workdir = root if root is not None else cwd
    spec = repo_relative if root is not None else target.name

    text, truncated, binary = _read_text(target, max_bytes=max_bytes)
    if binary:
        result.update({"binary": True, "error": "二进制文件，无法预览差异"})
        return result

    if root is not None:
        code, out, err = await _git(
            [
                "diff",
                f"-U{max(int(context), 0)}",
                "--no-color",
                "--no-renames",
                "HEAD",
                "--",
                spec,
            ],
            workdir,
            timeout=timeout,
        )
        if code != 0:
            merged = (err or out).strip()
            if "unknown revision" in merged or "ambiguous argument 'HEAD'" in merged:
                out = ""
            else:
                result["error"] = merged or "git diff 失败"
                return result
        if out.strip():
            result.update(_diff_counts(out))
            if len(out) > max_bytes:
                result["truncated"] = True
                out = out[:max_bytes]
            result["diff"] = out
            return result

    # 走到这里：未跟踪文件、或者已提交且没有改动。
    tracked = await _is_tracked(workdir, spec, timeout=timeout)
    if not tracked:
        result["untracked"] = True
        result["additions"] = _count_lines(target)[0]
        result["deletions"] = 0
        result["truncated"] = truncated
        result["diff"] = synthesize_untracked_diff(display, text, truncated=truncated)
        return result

    result["error"] = "这个文件和 HEAD 相比没有改动"
    return result


async def read(
    cwd: Path,
    path: str,
    *,
    max_bytes: int = MAX_FILE_BYTES,
) -> dict[str, Any]:
    """读文件内容给预览面板（超出上限截断、二进制只报事实）。"""

    target, display, _repo_relative = _resolve(
        cwd, path, extra_root=await repo_root(cwd)
    )
    text, truncated, binary = _read_text(target, max_bytes=max_bytes)
    size = 0
    try:
        size = target.stat().st_size
    except OSError:
        size = len(text.encode("utf-8", "replace"))
    return {
        "path": display,
        "absolute": str(target),
        "text": "" if binary else text,
        "truncated": truncated,
        "binary": binary,
        "size": size,
        "lines": 0 if binary else text.count("\n") + (1 if text and not text.endswith("\n") else 0),
    }


# ----------------------------------------------------------------------
# 内部工具
# ----------------------------------------------------------------------


def _resolve(
    cwd: Path, raw: str, *, extra_root: Path | None = None
) -> tuple[Path, str, str]:
    """把前端给的路径解析成绝对路径，并守住「不许跑出工作区」。

    允许两种输入：绝对路径，或相对路径（先按工作目录、再按仓库根试）。允许的
    范围是工作目录本身，加上 `extra_root`（工作目录所在仓库的根）—— 后者是为了
    让「工作目录在仓库子目录里」时也能预览仓库上层的改动。
    """

    text = (raw or "").strip()
    if not text:
        raise WorkspaceFileError("需要一个文件路径")
    candidate = Path(text)
    base = Path(cwd).absolute()
    roots: list[Path] = [base.resolve()]
    if extra_root is not None:
        try:
            resolved_root = Path(extra_root).resolve()
            if resolved_root != roots[0]:
                roots.append(resolved_root)
        except OSError:  # pragma: no cover
            pass

    options: list[Path] = []
    if candidate.is_absolute():
        options.append(candidate)
    else:
        for root in roots:
            options.append(root / candidate)
    fallback = options[0]
    target = next((item for item in options if item.exists()), fallback)
    try:
        target = target.resolve()
    except OSError as exc:  # pragma: no cover
        raise WorkspaceFileError(f"路径无法解析：{exc}") from exc

    matched: Path | None = None
    for root in roots:
        try:
            target.relative_to(root)
            matched = root
            break
        except ValueError:
            continue
    if matched is None:
        raise WorkspaceFileError(f"路径在工作区之外：{text}")
    if not target.exists():
        raise WorkspaceFileError(f"文件不存在：{text}")
    if target.is_dir():
        raise WorkspaceFileError(f"这是一个目录，不是文件：{text}")

    return target, display_path(base, target), target.relative_to(matched).as_posix()


async def _is_tracked(cwd: Path, spec: str, *, timeout: float) -> bool:
    try:
        code, out, _err = await _git(
            ["ls-files", "--error-unmatch", "--", spec], cwd, timeout=timeout
        )
    except WorkspaceFileError:
        return False
    return code == 0 and bool(out.strip())


def _diff_counts(diff_text: str) -> dict[str, int]:
    additions = 0
    deletions = 0
    for line in diff_text.splitlines():
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            additions += 1
        elif line.startswith("-"):
            deletions += 1
    return {"additions": additions, "deletions": deletions}


def _count_lines(path: Path) -> tuple[int, bool]:
    """未跟踪文件的行数（顺带告诉调用方是不是没数完）。"""

    try:
        size = path.stat().st_size
    except OSError:
        return 0, False
    if size > MAX_FILE_BYTES:
        return 0, True
    try:
        with path.open("rb") as handle:
            data = handle.read(MAX_FILE_BYTES)
    except OSError:
        return 0, False
    if b"\x00" in data[:8000]:
        return 0, True
    text = data.decode("utf-8", "replace")
    count = text.count("\n")
    if text and not text.endswith("\n"):
        count += 1
    return count, False


def _read_text(path: Path, *, max_bytes: int) -> tuple[str, bool, bool]:
    """读文件；返回 `(文本, 是否截断, 是否二进制)`。"""

    try:
        size = path.stat().st_size
    except OSError as exc:
        raise WorkspaceFileError(f"读不到文件：{exc}") from exc
    limit = max(int(max_bytes), 1024)
    try:
        with path.open("rb") as handle:
            data = handle.read(limit)
    except OSError as exc:
        raise WorkspaceFileError(f"读不到文件：{exc}") from exc
    binary = b"\x00" in data[:8000]
    text = data.decode("utf-8", "replace")
    return text, size > limit, binary
