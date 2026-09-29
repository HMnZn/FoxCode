"""精简编码工具：read / write / edit / bash。

cwd 用于解析相对路径，不是文件系统沙箱。宿主可通过 before_tool_call 限制权限。
文件修改使用原子替换；bash 输出有上限，超时或取消时结束子进程树。
"""

from __future__ import annotations

import asyncio
import os
import shutil
import signal
import tempfile
import fnmatch
from pathlib import Path
from typing import Any
from pathspec import GitIgnoreSpec

from fox_ai.src import TextContent
from fox_agent_core.src._async import cancellable, check_cancelled
from fox_agent_core.src.types import AgentToolResult, ToolExecutionMode

MAX_OUTPUT_CHARS = 20000
MAX_FILE_BYTES = 10 * 1024 * 1024


def _text(text: str, **details: Any) -> AgentToolResult:
    return AgentToolResult(content=[TextContent(text=text)], details=details or None)


def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[:MAX_OUTPUT_CHARS] + "\n[Output truncated; narrow the requested range.]"


def _schema(properties: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


class _FileTool:
    execution_mode: ToolExecutionMode = "sequential"

    def __init__(self, cwd: str | Path = ".") -> None:
        self.cwd = Path(cwd).expanduser().resolve()

    def _path(self, value: str) -> Path:
        path = Path(value).expanduser()
        return (self.cwd / path).resolve() if not path.is_absolute() else path.resolve()

    def _read(self, path: Path) -> str:
        with path.open("rb") as handle:
            data = handle.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise ValueError("File exceeds 10 MiB; inspect a smaller range with bash")
        if b"\x00" in data:
            raise ValueError("Binary files are not supported by this text tool")
        # utf-8-sig is identical to UTF-8 for ordinary files and transparently
        # removes the BOM required by Windows PowerShell 5.1 for non-ASCII .ps1.
        return data.decode("utf-8-sig")

    def _write(self, path: Path, text: str) -> int:
        encoding = "utf-8-sig" if os.name == "nt" and path.suffix.lower() == ".ps1" else "utf-8"
        data = text.encode(encoding)
        if len(data) > MAX_FILE_BYTES:
            raise ValueError("File exceeds the 10 MiB write limit")
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
                temp = Path(handle.name)
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            if path.exists():
                temp.chmod(path.stat().st_mode & 0o777)
            os.replace(temp, path)
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)
        return len(data)


class ReadTool(_FileTool):
    name = "read"
    label = "Read file"
    required_permission = "read-only"
    execution_mode = "parallel"
    description = "Read a UTF-8 text file, with optional 1-based offset and line limit."
    parameters = _schema({"path": {"type": "string", "minLength": 1},
                          "offset": {"type": "integer", "minimum": 1},
                          "limit": {"type": "integer", "minimum": 1, "maximum": 2000}}, ["path"])

    async def execute(self, tool_call_id, params, cancel_event=None, on_update=None):
        check_cancelled(cancel_event)
        path = self._path(params["path"])
        lines = self._read(path).splitlines()
        offset, limit = params.get("offset", 1), params.get("limit", 2000)
        if offset < 1 or not 1 <= limit <= 2000:
            raise ValueError("offset must be >= 1 and limit must be between 1 and 2000")
        if offset > len(lines) and (lines or offset != 1):
            raise ValueError(f"offset exceeds file length ({len(lines)} lines)")
        selected = lines[offset - 1:offset - 1 + limit]
        text = "\n".join(f"{i}: {line}" for i, line in enumerate(selected, offset))
        if offset - 1 + limit < len(lines):
            text += f"\n[More lines available; next offset: {offset + limit}]"
        return _text(_truncate(text), path=str(path), total_lines=len(lines))


class WriteTool(_FileTool):
    name = "write"
    label = "Write file"
    required_permission = "workspace-modify"
    permission_paths = ("path",)
    description = "Create or overwrite a UTF-8 text file. Creates parent directories."
    parameters = _schema({"path": {"type": "string", "minLength": 1},
                          "content": {"type": "string"}}, ["path", "content"])

    async def execute(self, tool_call_id, params, cancel_event=None, on_update=None):
        check_cancelled(cancel_event)
        path = self._path(params["path"])
        size = self._write(path, params["content"])
        return _text(f"Wrote {size} bytes to {path}", path=str(path))


class EditTool(_FileTool):
    name = "edit"
    label = "Edit file"
    required_permission = "workspace-modify"
    permission_paths = ("path",)
    description = "Replace exactly one occurrence of old_text with new_text. Fails if ambiguous or missing."
    parameters = _schema({"path": {"type": "string", "minLength": 1},
                          "old_text": {"type": "string", "minLength": 1},
                          "new_text": {"type": "string"}}, ["path", "old_text", "new_text"])

    async def execute(self, tool_call_id, params, cancel_event=None, on_update=None):
        check_cancelled(cancel_event)
        path = self._path(params["path"])
        text = self._read(path)
        old = params["old_text"]
        if not old or text.count(old) != 1:
            raise ValueError("old_text must match exactly once; read the file and include more context")
        self._write(path, text.replace(old, params["new_text"], 1))
        return _text(f"Edited {path}", path=str(path))


class BashTool(_FileTool):
    name = "bash"
    label = "Run command"
    required_permission = "workspace-modify"
    workspace_shell = True
    description = "Run a bash command in the working directory. Output is capped at 20000 characters."
    parameters = _schema({"command": {"type": "string", "minLength": 1},
                          "timeout": {"type": "number", "exclusiveMinimum": 0, "maximum": 600}}, ["command"])

    def __init__(self, cwd: str | Path = ".", *, shell: str | None = None) -> None:
        super().__init__(cwd)
        self.shell = shell
        self._uses_wsl = False
        if os.name == "nt" and self.name == "bash":
            self.description = (
                type(self).description
                + " Use paths relative to the working directory; Windows bash may be WSL "
                "(/mnt/c), not Git Bash (/c)."
            )

    def _command(self, command):
        shell = self.shell or shutil.which("bash")
        if shell is None and os.name == "nt":
            git_bash = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
            shell = str(git_bash) if git_bash.exists() else None
        if shell is None:
            raise RuntimeError("bash was not found; install Git Bash or set BashTool(shell=...)")
        normalized = str(shell).replace("/", "\\").lower()
        self._uses_wsl = os.name == "nt" and normalized.endswith("\\system32\\bash.exe")
        return [shell, "-c", command]

    def _environment(self) -> dict[str, str]:
        """Keep command-created temporary artifacts inside the workspace."""

        environment = os.environ.copy()
        temp_dir = self.cwd / ".foxcode" / "tmp"
        temp_dir.mkdir(parents=True, exist_ok=True)
        temp_value = str(temp_dir)
        if self._uses_wsl and len(temp_value) >= 3 and temp_value[1:3] == ":\\":
            drive = temp_value[0].lower()
            temp_value = f"/mnt/{drive}/{temp_value[3:].replace(chr(92), '/')}"
        environment.update({"TMPDIR": temp_value, "TEMP": temp_value, "TMP": temp_value})
        if self._uses_wsl:
            # WSL only imports explicitly listed custom Windows variables.
            inherited = [item for item in environment.get("WSLENV", "").split(":") if item]
            for name in ("TMPDIR", "TEMP", "TMP"):
                if name not in inherited:
                    inherited.append(name)
            environment["WSLENV"] = ":".join(inherited)
        return environment

    async def execute(self, tool_call_id, params, cancel_event=None, on_update=None):
        check_cancelled(cancel_event)
        command = self._command(params["command"])
        timeout = params.get("timeout", 120)
        if not 0 < timeout <= 600:
            raise ValueError("timeout must be between 0 and 600 seconds")
        process = await asyncio.create_subprocess_exec(
            *command, cwd=self.cwd,
            env=self._environment(),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            start_new_session=os.name != "nt",
        )
        output = bytearray()
        truncated = False

        async def collect():
            nonlocal truncated
            while chunk := await process.stdout.read(4096):
                remaining = MAX_OUTPUT_CHARS - len(output)
                output.extend(chunk[:remaining])
                truncated |= len(chunk) > remaining
                if on_update is not None and remaining > 0:
                    on_update(_text(output.decode("utf-8", errors="replace")))
            return await process.wait()

        try:
            async with asyncio.timeout(timeout):
                code = await cancellable(collect(), cancel_event)
        except TimeoutError:
            raise RuntimeError(f"Command timed out after {timeout}s\n{output.decode('utf-8', errors='replace')}") from None
        finally:
            # 也清理仍持有 stdout 的后代进程；工具结束后不保留后台命令。
            if os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            elif process.returncode is None:
                killer = await asyncio.create_subprocess_exec(
                    "taskkill", "/PID", str(process.pid), "/T", "/F",
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                await killer.wait()
            await process.wait()
        text = output.decode("utf-8", errors="replace")
        if truncated:
            text += "\n[Output truncated]"
        if code != 0:
            raise RuntimeError(f"Command exited with code {code}\n{text}")
        return _text(text or "(no output)", exit_code=code, truncated=truncated)


class PowerShellTool(BashTool):
    name = "powershell"
    label = "Run PowerShell"
    description = "Execute a PowerShell command without loading profiles; supports timeout and cancellation."

    def _command(self, command):
        shell = self.shell or shutil.which("pwsh") or shutil.which("powershell")
        if shell is None:
            raise RuntimeError("PowerShell was not found; install pwsh or use bash")
        # Windows PowerShell 5.1 inherits the legacy console code page even
        # when stdout is redirected.  The host decodes tool output as UTF-8,
        # so force both PowerShell and native child processes onto UTF-8 before
        # evaluating the user's command. PowerShell 7 already uses UTF-8; the
        # preamble is harmless there.
        utf8_command = (
            "$__foxcodeUtf8 = [System.Text.UTF8Encoding]::new($false); "
            "[Console]::InputEncoding = $__foxcodeUtf8; "
            "[Console]::OutputEncoding = $__foxcodeUtf8; "
            "$OutputEncoding = $__foxcodeUtf8; "
            + command
        )
        return [shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", utf8_command]


def _limit(params, default):
    value = params.get("limit", default)
    if not isinstance(value, int) or not 1 <= value <= 2000:
        raise ValueError("limit must be an integer between 1 and 2000")
    return value


def _matches(path, pattern):
    # PurePath.full_match implements ** (including zero intermediate directories).
    return Path(path).full_match(pattern) or ("/" not in pattern and fnmatch.fnmatchcase(Path(path).name, pattern))


async def _walk_files(root, cancel_event):
    """Bounded cooperative traversal with nested .gitignore rules; never follows directory symlinks."""
    if not root.is_dir():
        raise NotADirectoryError(str(root))
    parents = []
    for base in reversed(root.parents):
        ignore = base / ".gitignore"
        if ignore.is_file():
            parents.append((base, GitIgnoreSpec.from_lines(ignore.read_text(encoding="utf-8-sig").splitlines())))
    stack = [(root, parents)]
    visited = 0
    while stack:
        directory, inherited = stack.pop()
        check_cancelled(cancel_event)
        rules = list(inherited)
        ignore = directory / ".gitignore"
        if ignore.is_file():
            rules.append((directory, GitIgnoreSpec.from_lines(ignore.read_text(encoding="utf-8-sig").splitlines())))
        for child in directory.iterdir():
            visited += 1
            if visited % 64 == 0:
                await asyncio.sleep(0)
                check_cancelled(cancel_event)
            if visited > 50000:
                raise RuntimeError("Search exceeds 50000 entries; narrow the search path")
            if child.name in {".git", ".foxcode", ".venv", "node_modules", "__pycache__"}:
                continue
            is_dir = child.is_dir()
            ignored = False
            for base, spec in rules:
                match = spec.check_file(child.relative_to(base).as_posix() + ("/" if is_dir else ""))
                if match.include is not None:
                    ignored = match.include
            if ignored or child.is_symlink():
                continue
            if is_dir:
                stack.append((child, rules))
            elif child.is_file():
                yield child


class LsTool(_FileTool):
    name = "ls"
    label = "List directory"
    required_permission = "read-only"
    execution_mode = "parallel"
    description = "List immediate directory entries, including hidden files; directories end with /."
    parameters = _schema({"path": {"type": "string"},
                          "limit": {"type": "integer", "minimum": 1, "maximum": 2000}}, [])

    async def execute(self, tool_call_id, params, cancel_event=None, on_update=None):
        check_cancelled(cancel_event)
        path, limit = self._path(params.get("path", ".")), _limit(params, 500)
        rows = []
        # Limit iteration as well as returned text, avoiding unbounded directory materialization.
        with os.scandir(path) as entries:
            for entry in entries:
                if len(rows) >= limit:
                    break
                rows.append(entry.name + ("/" if entry.is_dir(follow_symlinks=False) else ""))
        truncated = len(rows) >= limit
        text = "\n".join(sorted(rows)) or "(empty directory)"
        if truncated:
            text += "\n[Entry limit reached; narrow the path.]"
        return _text(_truncate(text), path=str(path), truncated=truncated)


class FindTool(_FileTool):
    name = "find"
    label = "Find files"
    required_permission = "read-only"
    execution_mode = "parallel"
    description = "Find files by glob, respecting nested .gitignore; skips symlinks and agent/dependency directories."
    parameters = _schema({"pattern": {"type": "string", "minLength": 1}, "path": {"type": "string"},
                          "limit": {"type": "integer", "minimum": 1, "maximum": 2000}}, ["pattern"])

    async def execute(self, tool_call_id, params, cancel_event=None, on_update=None):
        root, limit = self._path(params.get("path", ".")), _limit(params, 1000)
        rows, size = [], 0
        truncated = False
        async for path in _walk_files(root, cancel_event):
            relative = path.relative_to(root).as_posix()
            if _matches(relative, params["pattern"]):
                rows.append(relative)
                size += len(relative) + 1
                if len(rows) >= limit or size >= MAX_OUTPUT_CHARS:
                    truncated = True
                    break
        text = "\n".join(sorted(rows)) or "(no files found)"
        return _text(_truncate(text + ("\n[Result limit reached]" if truncated else "")), truncated=truncated)


class GrepTool(_FileTool):
    name = "grep"
    label = "Search contents"
    required_permission = "read-only"
    execution_mode = "parallel"
    description = ("Search contents with path:line output. Regex uses ripgrep (rg); without rg, set literal=true. "
                   "Directory searches respect .gitignore. Output and match counts are capped.")
    parameters = _schema({"pattern": {"type": "string", "minLength": 1}, "path": {"type": "string"},
                          "glob": {"type": "string"}, "ignoreCase": {"type": "boolean"},
                          "literal": {"type": "boolean"},
                          "context": {"type": "integer", "minimum": 0, "maximum": 10},
                          "limit": {"type": "integer", "minimum": 1, "maximum": 2000}}, ["pattern"])

    async def execute(self, tool_call_id, params, cancel_event=None, on_update=None):
        check_cancelled(cancel_event)
        path, limit = self._path(params.get("path", ".")), _limit(params, 100)
        if not path.exists():
            raise FileNotFoundError(str(path))
        rg = shutil.which("rg")
        if rg:
            args = [rg, "--no-heading", "--line-number", "--with-filename", "--color", "never",
                    "--max-columns", "1000", "--max-columns-preview", "--max-count", str(limit)]
            if params.get("literal"):
                args.append("--fixed-strings")
            if params.get("ignoreCase"):
                args.append("--ignore-case")
            if params.get("glob"):
                args.extend(["--glob", params["glob"]])
            if params.get("context"):
                args.extend(["--context", str(params["context"])])
            args.extend(["--", params["pattern"], str(path)])
            return await cancellable(self._run_rg(args, limit), cancel_event)
        if not params.get("literal"):
            raise RuntimeError("Regex search requires ripgrep (rg). Install it, or set literal=true.")
        rows, size = [], 0
        needle = params["pattern"].casefold() if params.get("ignoreCase") else params["pattern"]

        async def files():
            if path.is_file():
                yield path
            else:
                async for item in _walk_files(path, cancel_event):
                    yield item

        matches = 0
        async for file in files():
            if params.get("glob") and not _matches(file.relative_to(path if path.is_dir() else path.parent).as_posix(), params["glob"]):
                continue
            try:
                lines = self._read(file).splitlines()
            except (UnicodeError, ValueError):
                continue
            for index, line in enumerate(lines):
                if index % 128 == 0:
                    await asyncio.sleep(0)
                    check_cancelled(cancel_event)
                if needle in (line.casefold() if params.get("ignoreCase") else line):
                    matches += 1
                    context = params.get("context", 0)
                    for i in range(max(0, index - context), min(len(lines), index + context + 1)):
                        row = f"{file}:{i + 1}:{lines[i][:1000]}"
                        rows.append(row)
                        size += len(row) + 1
                    if matches >= limit or size >= MAX_OUTPUT_CHARS:
                        return _text(_truncate("\n".join(rows)) + "\n[Result limit reached]", truncated=True)
        return _text("\n".join(rows) or "(no matches)", truncated=False)

    async def _run_rg(self, args, limit):
        process = await asyncio.create_subprocess_exec(*args, cwd=self.cwd,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=1024 * 1024)
        errors = bytearray()

        async def drain_errors():
            while chunk := await process.stderr.read(4096):
                errors.extend(chunk[:max(0, 4000 - len(errors))])

        error_task = asyncio.create_task(drain_errors())
        rows, size, truncated = [], 0, False
        try:
            while line := await process.stdout.readline():
                text = line.decode("utf-8", errors="replace").rstrip("\n")
                rows.append(text)
                size += len(text) + 1
                if len(rows) >= limit or size >= MAX_OUTPUT_CHARS:
                    truncated = True
                    break
            if truncated and process.returncode is None:
                process.kill()
            code = await process.wait()
            await error_task
            if not truncated and code not in (0, 1):
                raise RuntimeError(errors.decode("utf-8", errors="replace") or f"rg exited with {code}")
            text = "\n".join(rows) or "(no matches)"
            return _text(_truncate(text) + ("\n[Result limit reached]" if truncated else ""), truncated=truncated)
        finally:
            if process.returncode is None:
                process.kill()
            await process.wait()
            await error_task


def create_all_tools(cwd: str | Path = ".") -> list:
    return [ReadTool(cwd), WriteTool(cwd), EditTool(cwd), BashTool(cwd),
            GrepTool(cwd), FindTool(cwd), LsTool(cwd), PowerShellTool(cwd)]


def create_coding_tools(cwd: str | Path = ".") -> list:
    return [tool for tool in create_all_tools(cwd) if tool.name != "powershell" or os.name == "nt"]


__all__ = ["ReadTool", "WriteTool", "EditTool", "BashTool", "PowerShellTool", "GrepTool",
           "FindTool", "LsTool", "create_coding_tools", "create_all_tools"]
