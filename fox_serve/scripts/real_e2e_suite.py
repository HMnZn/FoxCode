"""Run repeatable real-model end-to-end checks against ``fox_serve``.

This is intentionally not part of the offline unit suite: it uses the user's
configured model and credentials, creates real sessions, and lets the model
invoke real coding tools in an isolated workspace.

Example (from the repository root)::

    uv run python fox_serve/scripts/real_e2e_suite.py \
      --workspace .build-cache/e2e-live-workspace \
      --second-workspace .build-cache/e2e-live-project-two \
      --output desktop/artifacts/real-e2e-results.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

# A direct ``python fox_serve/scripts/...`` launch puts only the scripts
# directory on sys.path.  Keep the documented direct-file invocation working.
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from fox_serve.scripts.ndjson_client import Sidecar


def _safe_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def _frame_text(frames: list[dict[str, Any]]) -> str:
    chunks: list[str] = []
    for frame in frames:
        if frame.get("type") != "message_update":
            continue
        event = frame.get("assistant_message_event") or {}
        if event.get("type") == "text_delta":
            chunks.append(str(event.get("delta") or ""))
    return "".join(chunks)


def _tool_frames(frames: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    return [frame for frame in frames if frame.get("type") == kind]


@dataclass
class Result:
    name: str
    status: str
    duration_ms: int
    detail: dict[str, Any] = field(default_factory=dict)


class Suite:
    def __init__(self, client: Sidecar, workspace: Path, second_workspace: Path) -> None:
        self.client = client
        self.workspace = workspace
        self.second_workspace = second_workspace
        self.results: list[Result] = []
        self.initial_info: dict[str, Any] = {}

    def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = 120.0,
    ) -> Any:
        return self.client.request(method, params, timeout=timeout)

    def wait_for(
        self,
        start: int,
        predicate: Callable[[list[dict[str, Any]]], bool],
        *,
        timeout: float = 240.0,
        answer: str = "allow-once",
        permission_start: int | None = None,
    ) -> list[dict[str, Any]]:
        deadline = time.time() + timeout
        handled: set[str] = set()
        permission_start = len(self.client.permissions) if permission_start is None else permission_start
        while time.time() < deadline:
            for request in self.client.permissions[permission_start:]:
                request_id = str(request.get("id") or "")
                if not request_id or request_id in handled:
                    continue
                self.request(
                    "permission.answer",
                    {"id": request_id, "decision": answer, "reason": "real E2E suite"},
                )
                handled.add(request_id)
            frames = self.client.file_frames[start:]
            errors = [str(frame.get("error")) for frame in frames if frame.get("type") == "error"]
            if errors:
                raise RuntimeError("; ".join(errors))
            if predicate(frames):
                return frames
            time.sleep(0.05)
        raise TimeoutError(f"等待事件超时（{timeout:.0f}s），已收到 {len(self.client.file_frames[start:])} 帧")

    def prompt(
        self,
        message: str,
        *,
        timeout: float = 240.0,
        permission: str = "allow-once",
    ) -> tuple[list[dict[str, Any]], str]:
        start = len(self.client.file_frames)
        permission_start = len(self.client.permissions)
        self.request("prompt", {"message": message})
        # AgentSession emits agent_end for each provider attempt. A recoverable
        # failure is followed by model_retry and another agent_start while the
        # host remains busy, so agent_end alone is not a request-level terminal
        # signal. Wait for the host to settle to avoid closing the sidecar in
        # the middle of an automatic retry.
        next_busy_check = 0.0

        def request_finished(batch: list[dict[str, Any]]) -> bool:
            nonlocal next_busy_check
            if not any(frame.get("type") == "agent_end" for frame in batch):
                return False
            now = time.monotonic()
            if now < next_busy_check:
                return False
            next_busy_check = now + 0.25
            return not bool(self.request("host.info", timeout=10).get("busy"))

        frames = self.wait_for(
            start,
            request_finished,
            timeout=timeout,
            answer=permission,
            permission_start=permission_start,
        )
        return frames, _frame_text(frames)

    def case(self, name: str, action: Callable[[], dict[str, Any] | None]) -> None:
        started = time.perf_counter()
        print(f"\n[RUN ] {name}", flush=True)
        try:
            detail = action() or {}
        except Exception as exc:  # noqa: BLE001 - the suite must continue and report every case
            elapsed = round((time.perf_counter() - started) * 1000)
            detail = {
                "error": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(limit=8),
            }
            self.results.append(Result(name, "failed", elapsed, detail))
            print(f"[FAIL] {name}: {detail['error']}", flush=True)
            return
        elapsed = round((time.perf_counter() - started) * 1000)
        self.results.append(Result(name, "passed", elapsed, detail))
        print(f"[PASS] {name} ({elapsed} ms)", flush=True)

    @staticmethod
    def require(condition: Any, message: str) -> None:
        if not condition:
            raise AssertionError(message)

    def run(self) -> list[Result]:
        self.case("真实宿主与模型握手", self._connectivity)
        self.case("/文件：目录浏览与真实模型读取", self._file_picker_and_model_read)
        self.case("运行中 follow-up 排队并自动继续", self._follow_up)
        self.case("steer 插队、中止当前生成并续跑", self._steer)
        self.case("权限与真实 write 工具", self._permissions_and_write)
        self.case("文件改动、原文与 diff 预览", self._file_views)
        self.case("/压缩：真实摘要、事件与压缩后续聊", self._compaction)
        self.case("会话新建、改名、分支、打开与删除", self._sessions)
        self.case("/new 命令与会话导出", self._slash_new_and_export)
        self.case("新项目/工作区切换并继续真实对话", self._workspace_switch)
        self.case("模型、思考等级与真实推理", self._model_and_thinking)
        self.case("无效命令/目录失败后宿主可恢复", self._error_recovery)
        return self.results

    def run_interrupt_regressions(self) -> list[Result]:
        self.case("真实宿主与模型握手", self._connectivity)
        self.case("工具仍在执行时插队并得到新的模型回复", self._tool_interrupt)
        self.case("工具后纯思考阶段插队，不向模型回放无效消息", self._thinking_interrupt)
        self.case("历史会话反复打开时间不变，真正续聊才更新", self._preview_recency)
        return self.results

    def _interrupt_and_check(self, start: int, marker: str) -> dict[str, Any]:
        interrupt_start = len(self.client.file_frames)
        self.request("steer", {
            "message": f"取消原来的任务，不再调用工具，只回复 {marker}",
            "interrupt": True, "promoteFollowUps": True,
        })
        def answered(batch):
            return any(
                frame.get("type") == "message_end"
                and frame.get("message", {}).get("role") == "assistant"
                and frame.get("message", {}).get("stopReason") == "stop"
                and marker in str(frame.get("message", {}).get("content"))
                for frame in batch
            ) and any(frame.get("type") == "agent_end" for frame in batch)
        frames = self.wait_for(interrupt_start, answered, timeout=120)
        failures = [frame.get("message", {}).get("errorMessage") for frame in frames
                    if frame.get("message", {}).get("stopReason") == "error"]
        self.require(not failures, f"插队后模型请求错误：{failures}")
        all_frames = self.client.file_frames[start:]
        self.require(not self.request("host.info").get("busy"), "插队回复后仍然忙碌")
        return {"reply": _frame_text(frames), "frames": len(all_frames), "modelErrors": failures}

    def _tool_interrupt(self) -> dict[str, Any]:
        self.request("sessions.new")
        self.request("thinking.set", {"level": "off"})
        self.request("permission.set", {"mode": "workspace-modify"})
        start = len(self.client.file_frames)
        self.request("prompt", {"message":
            "只调用 bash 工具执行 sleep 20，然后回复 TOOL_FINISHED；不要换成 Python 或别的工具。"})
        frames = self.wait_for(start, lambda batch: any(
            f.get("type") == "tool_execution_start" and f.get("tool_name") == "bash" for f in batch))
        tool = next(f for f in frames if f.get("type") == "tool_execution_start" and f.get("tool_name") == "bash")
        self.require(not any(f.get("type") == "tool_execution_end" and f.get("tool_call_id") == tool.get("tool_call_id")
                             for f in frames), "工具已经结束，没有实际命中工具执行期")
        result = self._interrupt_and_check(start, "TOOL_INTERRUPT_OK")
        endings = [f for f in self.client.file_frames[start:] if f.get("type") == "tool_execution_end"
                   and f.get("tool_call_id") == tool.get("tool_call_id")]
        self.require(len(endings) == 1, "中止工具必须恰好有一次结束回执")
        return {**result, "interruptedTool": tool.get("tool_name"), "toolEnd": endings[0]}

    def _thinking_interrupt(self) -> dict[str, Any]:
        self.request("sessions.new")
        self.request("thinking.set", {"level": "high"})
        start = len(self.client.file_frames)
        self.request("prompt", {"message":
            "先调用 read 读取 fixture.txt。读完后，仔细思考如何实现一个单文件动态 HTML 编辑器，"
            "包括撤销重做、并发编辑、离线同步、冲突处理和崩溃恢复；逐一分析所有边界情况，然后给出完整代码。"})
        def post_tool_thinking(batch):
            end = next((i for i, f in enumerate(batch) if f.get("type") == "tool_execution_end"), None)
            return end is not None and any(
                f.get("assistant_message_event", {}).get("type") == "thinking_delta" for f in batch[end + 1:])
        self.wait_for(start, post_tool_thinking, timeout=120)
        result = self._interrupt_and_check(start, "THINKING_INTERRUPT_OK")
        aborted = [f.get("message") for f in self.client.file_frames[start:]
                   if f.get("type") == "message_end" and f.get("message", {}).get("stopReason") == "aborted"]
        self.require(any(any(p.get("type") == "thinking" for p in m.get("content", []))
                         and not any(p.get("type") == "toolCall" or p.get("type") == "text" and p.get("text")
                                     for p in m.get("content", [])) for m in aborted),
                     "未命中纯思考中止场景，不能计为通过")
        _, reply = self.prompt("不要调用工具，只回复 AFTER_THINKING_INTERRUPT_OK")
        self.require("AFTER_THINKING_INTERRUPT_OK" in reply, "插队后下一次消息无法正常回答")
        return {**result, "reasoningOnlyAbortObserved": True, "nextReply": reply}

    def _preview_recency(self) -> dict[str, Any]:
        current_file = self.request("host.info")["sessionFile"]
        before = next(row for row in self.request("sessions.list") if row.get("file") == current_file)
        timestamps = []
        for _ in range(2):
            self.request("sessions.new")
            self.request("sessions.open", {"id": before["id"]})
            after = next(row for row in self.request("sessions.list") if row.get("file") == current_file)
            timestamps.append(after["updatedAt"])
            self.require(after["updatedAt"] == before["updatedAt"], "只打开历史会话却刷新了活动时间")
            self.require(after["createdAt"] == before["createdAt"], "打开会话改变了创建时间")
        _, reply = self.prompt("只回复 ACTIVITY_TIMESTAMP_OK")
        self.require("ACTIVITY_TIMESTAMP_OK" in reply, "打开后不能继续对话")
        after_reply = next(row for row in self.request("sessions.list") if row.get("file") == current_file)
        self.require(after_reply["updatedAt"] > before["updatedAt"], "真实回复后活动时间没有更新")
        return {"before": before["updatedAt"], "afterPreviews": timestamps,
                "afterReply": after_reply["updatedAt"]}

    def _connectivity(self) -> dict[str, Any]:
        info = self.request("host.info")
        self.initial_info = info
        self.require(info.get("transport") == "sidecar", "并非真实 sidecar")
        self.require(info.get("engine") == "fox_serve", "宿主引擎不是 fox_serve")
        self.require(info.get("model", {}).get("provider") == "deepseek", "未加载真实 DeepSeek 模型")
        frames, text = self.prompt("不要调用工具，只回复：REAL_MODEL_OK")
        self.require("REAL_MODEL_OK" in text, f"真实模型回复不匹配：{text[-200:]}")
        usage = [frame.get("context_usage") for frame in frames if frame.get("context_usage")]
        self.require(bool(usage), "没有收到后端上下文用量快照")
        return {
            "model": info.get("model", {}).get("id"),
            "cwd": info.get("cwd"),
            "frames": len(frames),
            "lastContextUsage": usage[-1],
        }

    def _file_picker_and_model_read(self) -> dict[str, Any]:
        listing = self.request("files.list")
        names = [item.get("name") for item in listing.get("entries", [])]
        self.require("fixture.txt" in names, f"文件选择列表缺少 fixture.txt：{names}")
        frames, text = self.prompt(
            "请用 read 工具读取 @fixture.txt；然后只回复文件第一行的标记，不要猜。"
        )
        starts = _tool_frames(frames, "tool_execution_start")
        self.require(any(frame.get("tool_name") == "read" for frame in starts), "模型没有调用 read 工具")
        self.require("FOXCODE_REAL_E2E_MARKER_20260929" in text, f"模型没有返回文件标记：{text[-300:]}")
        return {"listed": names, "toolCalls": [frame.get("tool_name") for frame in starts], "reply": text}

    def _follow_up(self) -> dict[str, Any]:
        start = len(self.client.file_frames)
        self.request(
            "prompt",
            {"message": "不要调用工具。先写 20 行简短编号，每行写 FIRST_STAGE。"},
        )
        queued = self.request("follow_up", {"message": "接着只回复：FOLLOW_UP_OK"})
        frames = self.wait_for(
            start,
            lambda batch: "FOLLOW_UP_OK" in _frame_text(batch)
            and any(frame.get("type") == "agent_end" for frame in batch),
        )
        text = _frame_text(frames)
        assistant_ends = [
            frame for frame in frames
            if frame.get("type") == "message_end" and (frame.get("message") or {}).get("role") == "assistant"
        ]
        self.require(queued.get("queued") == "follow_up", f"follow_up 未入队：{queued}")
        self.require("FIRST_STAGE" in text and "FOLLOW_UP_OK" in text, "排队前后两段回复不完整")
        self.require(len(assistant_ends) >= 2, "follow-up 没有形成第二次模型回复")
        return {"assistantMessages": len(assistant_ends), "replyTail": text[-300:]}

    def _steer(self) -> dict[str, Any]:
        start = len(self.client.file_frames)
        self.request(
            "prompt",
            {"message": "不要调用工具。连续输出 500 行 LONG_RUNNING_OUTPUT 和编号。"},
        )
        result = self.request(
            "steer",
            {
                "message": "立刻停止原任务，只回复：STEER_INTERRUPT_OK",
                "interrupt": True,
                "promoteFollowUps": True,
            },
        )
        frames = self.wait_for(
            start,
            lambda batch: "STEER_INTERRUPT_OK" in _frame_text(batch)
            and any(frame.get("type") == "agent_end" for frame in batch),
            timeout=90,
        )
        text = _frame_text(frames)
        self.require(result.get("queued") == "steer" and result.get("interrupted") is True, f"插队返回异常：{result}")
        self.require("STEER_INTERRUPT_OK" in text, f"插队消息未被消费：{text[-500:]}")
        return {"result": result, "frames": len(frames), "replyTail": text[-300:]}

    def _permissions_and_write(self) -> dict[str, Any]:
        self.request("trust.set", {"trusted": True})
        self.request("permission.set", {"mode": "workspace-modify"})
        target = self.workspace / "generated_by_model.txt"
        frames, text = self.prompt(
            "必须调用 write 工具，把精确内容 MODEL_WRITE_OK 写入 generated_by_model.txt，然后简短确认。"
        )
        writes = [
            frame for frame in _tool_frames(frames, "tool_execution_end")
            if frame.get("tool_name") == "write"
        ]
        self.require(writes and not writes[-1].get("is_error"), f"write 工具失败：{writes}")
        written = target.read_text(encoding="utf-8")
        self.require(
            written.rstrip("\n") == "MODEL_WRITE_OK" and written.count("\n") <= 1,
            "模型写入的磁盘内容不精确",
        )

        self.request("permission.set", {"mode": "read-only"})
        denied = self.workspace / "readonly_should_not_exist.txt"
        denied_frames, denied_text = self.prompt(
            "必须尝试调用 write 工具写 readonly_should_not_exist.txt，内容 DENIED。不要改用别的工具。"
        )
        denied_results = [
            frame for frame in _tool_frames(denied_frames, "tool_execution_end")
            if frame.get("tool_name") == "write"
        ]
        self.require(not denied.exists(), "read-only 模式仍然写出了文件")
        self.require(denied_results and denied_results[-1].get("is_error"), "read-only 拒绝没有体现在工具结果")
        self.request("permission.set", {"mode": "workspace-modify"})

        outside = self.workspace.parent / "e2e_outside_denied_20260929.txt"
        self.require(not outside.exists(), f"外部拒绝测试文件已存在，无法判定副作用：{outside}")
        permission_start = len(self.client.permissions)
        outside_frames, outside_text = self.prompt(
            f"必须只调用 write 工具，把 DENIED 写入绝对路径 {outside}。不要改用其他工具。",
            permission="deny",
        )
        outside_results = [
            frame for frame in _tool_frames(outside_frames, "tool_execution_end")
            if frame.get("tool_name") == "write"
        ]
        self.require(len(self.client.permissions) > permission_start, "越界写入没有发出授权请求")
        self.require(not outside.exists(), "拒绝授权后仍写出了工作区外文件")
        self.require(outside_results and outside_results[-1].get("is_error"), "拒绝授权没有生成错误工具结果")
        return {
            "writeReply": text[-200:],
            "readOnlyReply": denied_text[-300:],
            "readOnlyToolError": denied_results[-1].get("result"),
            "outsideDeniedReply": outside_text[-300:],
            "outsideDeniedToolError": outside_results[-1].get("result"),
        }

    def _file_views(self) -> dict[str, Any]:
        preview = self.request("files.read", {"path": "generated_by_model.txt"})
        diff = self.request("files.diff", {"path": "generated_by_model.txt", "context": 3})
        changes = self.request("files.changes")
        changed_paths = [item.get("path") for item in changes.get("files", [])]
        preview_text = str(preview.get("text") or "")
        self.require(
            preview_text.rstrip("\n") == "MODEL_WRITE_OK" and preview_text.count("\n") <= 1,
            f"文件原文预览错误：{preview}",
        )
        self.require("MODEL_WRITE_OK" in str(diff.get("diff") or diff.get("text") or ""), "diff 未包含新增内容")
        self.require("generated_by_model.txt" in changed_paths, f"改动列表缺文件：{changed_paths}")
        return {"previewKind": preview.get("kind"), "changedPaths": changed_paths, "diffBytes": len(json.dumps(diff, ensure_ascii=False))}

    def _compaction(self) -> dict[str, Any]:
        fact = "COMPACTION_FACT_7391"
        filler = "0123456789abcdef" * 2_400
        _, seed_text = self.prompt(
            f"请记住关键事实 {fact}。以下只是用于上下文压缩测试的填充文本，不要复述。\n{filler}\n只回复：SEED_OK",
            timeout=300,
        )
        self.require("SEED_OK" in seed_text, "压缩种子消息未完成")
        pre = self.request("host.info").get("contextTokens")
        start = len(self.client.file_frames)
        result = self.request("run_command", {"name": "compact", "arguments": ""}, timeout=300)
        # Protocol responses and frame delivery are handled concurrently.  The
        # command can resolve a few milliseconds before the reader thread has
        # appended compaction_end, so wait for the observable UI contract.
        frames = self.wait_for(
            start,
            lambda batch: any(frame.get("type") == "compaction_end" for frame in batch),
            timeout=30,
        )
        end = next((frame for frame in reversed(frames) if frame.get("type") == "compaction_end"), None)
        self.require(any(frame.get("type") == "compaction_start" for frame in frames), "缺少 compaction_start")
        self.require(end is not None, "缺少 compaction_end")
        self.require(int(end.get("removedCount") or 0) > 0, f"压缩没有移除旧消息：{end}")
        post = self.request("host.info").get("contextTokens")
        self.require(isinstance(pre, int) and isinstance(post, int) and post < pre, f"压缩后上下文未回落：{pre} -> {post}")
        _, recall = self.prompt("刚才要求你记住的 COMPACTION_FACT 是什么？只回复该事实。")
        self.require(fact in recall, f"压缩后丢失关键事实：{recall}")
        return {
            "preTokens": pre,
            "postTokens": post,
            "removedCount": end.get("removedCount"),
            "retainedCount": end.get("retainedCount"),
            "summaryPreview": str(end.get("summary") or "")[:500],
            "commandResult": result,
        }

    def _sessions(self) -> dict[str, Any]:
        current_file = str(self.request("host.info").get("sessionFile"))
        sessions = self.request("sessions.list")
        current = next((item for item in sessions if str(item.get("file")) == current_file), None)
        self.require(current is not None, "会话列表找不到当前会话")
        current_id = str(current.get("id"))
        renamed = self.request("sessions.rename", {"id": current_id, "title": "E2E 主会话"})
        self.require(renamed.get("title") == "E2E 主会话", f"重命名失败：{renamed}")
        forked = self.request("sessions.fork", {})
        self.require("分支" in str(forked.get("title")), f"分支标题不清晰：{forked}")
        _, branch_reply = self.prompt("只回复：BRANCH_OK")
        self.require("BRANCH_OK" in branch_reply, "分支会话无法继续对话")
        blank = self.request("sessions.new")
        listed = self.request("sessions.list")
        blank_row = next((item for item in listed if item.get("id") == blank.get("id")), None)
        self.require(blank_row is not None and blank_row.get("messageCount") == 0, f"新会话不是空白草稿：{blank_row}")
        replay_start = len(self.client.file_frames)
        opened = self.request("sessions.open", {"id": forked.get("id")})
        replay = self.wait_for(
            replay_start,
            lambda batch: any(frame.get("type") == "session_start" for frame in batch)
            and any(frame.get("type") == "message_end" for frame in batch),
            timeout=30,
        )
        self.require(opened.get("id") == forked.get("id"), "打开分支会话返回错误")
        self.require(any(frame.get("type") == "session_start" for frame in replay), "打开会话没有 session_start")
        self.require(any(frame.get("type") == "message_end" for frame in replay), "打开会话没有回放消息")
        deleted = self.request("sessions.delete", {"id": current_id})
        self.require(deleted.get("id") == current_id, f"删除历史会话失败：{deleted}")
        remaining_ids = {str(item.get("id")) for item in self.request("sessions.list")}
        self.require(current_id not in remaining_ids, "删除后历史会话仍在列表中")
        return {"renamed": renamed, "forked": forked, "blank": blank, "replayFrames": len(replay), "deleted": deleted}

    def _slash_new_and_export(self) -> dict[str, Any]:
        new_result = self.request("run_command", {"name": "new", "arguments": ""})
        session = new_result.get("result") or {}
        self.require(session.get("title") == "新会话", f"/new 没有创建空白会话：{new_result}")
        _, text = self.prompt("只回复：SLASH_NEW_OK")
        self.require("SLASH_NEW_OK" in text, "/new 后不能继续对话")
        export_path = self.workspace / "e2e-session-export.md"
        exported = self.request("session.export", {"format": "markdown", "path": str(export_path)})
        self.require(export_path.is_file() and export_path.stat().st_size > 0, "会话导出文件为空")
        return {"new": new_result, "exported": exported, "exportBytes": export_path.stat().st_size}

    def _workspace_switch(self) -> dict[str, Any]:
        changed = self.request("cwd.change", {"cwd": str(self.second_workspace)})
        info = self.request("host.info")
        self.require(Path(str(info.get("cwd"))).resolve() == self.second_workspace.resolve(), f"工作区未切换：{info.get('cwd')}")
        listing = self.request("files.list")
        self.require(any(item.get("name") == "project-two.txt" for item in listing.get("entries", [])), "新项目文件不可见")
        _, text = self.prompt("不要调用工具，只回复：PROJECT_TWO_OK")
        self.require("PROJECT_TWO_OK" in text, "新项目中真实模型不可用")
        back = self.request("cwd.change", {"cwd": str(self.workspace)})
        return {"changed": changed, "newCwd": info.get("cwd"), "back": back}

    def _model_and_thinking(self) -> dict[str, Any]:
        selected = self.request("model.select", {"reference": "deepseek/deepseek-flash"})
        thinking = self.request("thinking.set", {"level": "high"})
        active = self.request("host.info")
        self.require(active.get("thinkingLevel") == "high", f"宿主未保存 high 思考等级：{active.get('thinkingLevel')}")
        frames, text = self.prompt("计算 17*19，只在最后回复数字。")
        self.require("323" in text, f"思考模式回答错误：{text}")
        thought = [
            frame for frame in frames
            if frame.get("type") == "message_update"
            and (frame.get("assistant_message_event") or {}).get("type") == "thinking_delta"
        ]
        off = self.request("thinking.set", {"level": "off"})
        inactive = self.request("host.info")
        self.require(inactive.get("thinkingLevel") == "off", "思考等级无法切回 off")
        return {
            "selected": selected.get("id"),
            "thinking": thinking,
            # Some OpenAI-compatible DeepSeek endpoints apply reasoning without
            # exposing reasoning_content.  A correct answer plus persisted host
            # state is the portable contract; keep visibility as a diagnostic.
            "visibleThinkingFrames": len(thought),
            "off": off,
        }

    def _error_recovery(self) -> dict[str, Any]:
        errors: list[str] = []
        for method, params in (
            ("cwd.change", {"cwd": str(self.workspace / "definitely-missing")}),
            ("run_command", {"name": "definitely-unknown-command", "arguments": ""}),
        ):
            try:
                self.request(method, params)
            except RuntimeError as exc:
                errors.append(str(exc))
            else:
                raise AssertionError(f"{method} 应失败但成功了")
        info = self.request("host.info")
        frames, text = self.prompt("不要调用工具，只回复：RECOVERY_OK")
        self.require("RECOVERY_OK" in text, "错误后宿主没有恢复")
        self.require(any(frame.get("type") == "agent_end" for frame in frames), "恢复对话未正常结束")
        return {"expectedErrors": errors, "busyAfterErrors": info.get("busy")}


def main(argv: list[str] | None = None) -> int:
    _safe_console()
    parser = argparse.ArgumentParser(description="真实模型 + fox_serve 端到端测试")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--second-workspace", required=True)
    parser.add_argument("--user-dir", default=str(Path.home() / ".foxcode"))
    parser.add_argument("--output", required=True)
    parser.add_argument("--interrupt-regressions", action="store_true")
    args = parser.parse_args(argv)

    workspace = Path(args.workspace).resolve()
    second_workspace = Path(args.second_workspace).resolve()
    output = Path(args.output).resolve()
    # A workspace nested under this repository's ignored .build-cache would be
    # invisible to `git status` in its parent.  Give the fixture its own repo so
    # files.changes exercises the same behavior a normal project sees.
    if not (workspace / ".git").exists():
        subprocess.run(
            ["git", "init", str(workspace)],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    command = [
        sys.executable,
        "-m",
        "fox_serve",
        "--quiet",
        "--cwd",
        str(workspace),
        "--user-dir",
        str(Path(args.user_dir).resolve()),
        "--new-session",
    ]
    client = Sidecar(command, cwd=str(workspace), log_prefix="[sidecar] ")
    suite = Suite(client, workspace, second_workspace)
    exit_code = 1
    try:
        results = suite.run_interrupt_regressions() if args.interrupt_regressions else suite.run()
        passed = sum(item.status == "passed" for item in results)
        failed = len(results) - passed
        payload = {
            "kind": "real-model-e2e",
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "workspace": str(workspace),
            "secondWorkspace": str(second_workspace),
            "model": suite.initial_info.get("model", {}).get("id"),
            "summary": {"total": len(results), "passed": passed, "failed": failed},
            "results": [item.__dict__ for item in results],
            "sidecarStderr": client.errors[-100:],
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n结果：{passed}/{len(results)} 通过；JSON → {output}", flush=True)
        exit_code = 0 if failed == 0 else 1
    finally:
        code = client.close()
        print(f"sidecar 退出码：{code}", flush=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
