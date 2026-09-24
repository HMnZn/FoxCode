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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from fox_ai.src import TextContent
from .._async import cancellable, check_cancelled, maybe_await
from ..types import AgentToolResult, ToolExecutionMode

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


@dataclass
class FunctionTool:
    """把 async handler(id, params, cancel_event, on_update) 包装成 AgentTool。"""

    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., Any]
    label: str = ""
    execution_mode: ToolExecutionMode | None = None

    async def execute(self, tool_call_id, params, cancel_event=None, on_update=None):
        check_cancelled(cancel_event)
        return await maybe_await(self.handler(tool_call_id, params, cancel_event, on_update))


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
        return data.decode("utf-8")

    def _write(self, path: Path, text: str) -> None:
        data = text.encode("utf-8")
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


class ReadTool(_FileTool):
    name = "read"
    label = "Read file"
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
    description = "Create or overwrite a UTF-8 text file. Creates parent directories."
    parameters = _schema({"path": {"type": "string", "minLength": 1},
                          "content": {"type": "string"}}, ["path", "content"])

    async def execute(self, tool_call_id, params, cancel_event=None, on_update=None):
        check_cancelled(cancel_event)
        path = self._path(params["path"])
        self._write(path, params["content"])
        return _text(f"Wrote {len(params['content'].encode('utf-8'))} bytes to {path}", path=str(path))


class EditTool(_FileTool):
    name = "edit"
    label = "Edit file"
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
    description = "Run a bash command in the working directory. Output is capped at 20000 characters."
    parameters = _schema({"command": {"type": "string", "minLength": 1},
                          "timeout": {"type": "number", "exclusiveMinimum": 0, "maximum": 600}}, ["command"])

    def __init__(self, cwd: str | Path = ".", *, shell: str | None = None) -> None:
        super().__init__(cwd)
        self.shell = shell

    async def execute(self, tool_call_id, params, cancel_event=None, on_update=None):
        check_cancelled(cancel_event)
        shell = self.shell or shutil.which("bash")
        if shell is None and os.name == "nt":
            git_bash = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
            shell = str(git_bash) if git_bash.exists() else None
        if shell is None:
            raise RuntimeError("bash was not found; install Git Bash or set BashTool(shell=...)")
        timeout = params.get("timeout", 120)
        if not 0 < timeout <= 600:
            raise ValueError("timeout must be between 0 and 600 seconds")
        process = await asyncio.create_subprocess_exec(
            shell, "-c", params["command"], cwd=self.cwd,
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


def create_coding_tools(cwd: str | Path = ".") -> list:
    return [ReadTool(cwd), WriteTool(cwd), EditTool(cwd), BashTool(cwd)]


__all__ = ["FunctionTool", "ReadTool", "WriteTool", "EditTool", "BashTool", "create_coding_tools"]
