"""CLI adapter: one-shot text/JSON or a plain terminal conversation, sharing the same SDK."""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import sys
from pathlib import Path

from pydantic import BaseModel
from fox_ai.src import AssistantMessage, TextContent, get_model
from fox_coding_agent.src import AgentSessionRuntime, SettingsManager
from fox_coding_agent.src.core.model_config import ModelConfig
from fox_coding_agent.src.core.model_registry import ModelRegistry
from fox_coding_agent.src.core.permissions import PERMISSION_MODES
from fox_coding_agent.src.core.trust import ProjectTrustManager

THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh")


def build_parser():
    parser = argparse.ArgumentParser(
        prog="fox", description="FoxCode mini coding agent",
        epilog="运行策略请写入 ~/.foxcode/settings.json 或项目 .foxcode/settings.json。",
    )
    parser.add_argument("-p", "--prompt", help="执行任务后退出")
    parser.add_argument("--resume", nargs="?", const="latest", metavar="SESSION.jsonl",
                        help="恢复指定会话；省略路径则恢复当前项目最近会话")
    parser.add_argument("--json", action="store_true", help="stdout 输出逐行 JSON 事件")
    parser.add_argument("--cwd", type=Path, default=None, help="项目目录，默认当前目录")
    parser.add_argument("--user-dir", type=Path, help="用户配置目录，默认 ~/.foxcode")
    parser.add_argument("--model", help="模型 ID 或 provider/model；优先匹配用户 models.json")
    parser.add_argument("--thinking", choices=THINKING_LEVELS, help="本次会话的思考强度")
    parser.add_argument("--list-models", action="store_true", help="列出用户 models.json 中可切换的模型后退出")
    parser.add_argument("--permission", choices=PERMISSION_MODES,
                        help="权限：仅查看、工作区内修改或完全访问；默认读取 settings.json")
    trust = parser.add_mutually_exclusive_group()
    trust.add_argument("--trust-project", dest="project_trust", action="store_true",
                       help="信任并记录当前项目，允许加载项目资源和执行工具")
    trust.add_argument("--no-trust-project", dest="project_trust", action="store_false",
                       help="记录当前项目为不信任")
    parser.set_defaults(project_trust=None)
    parser.add_argument("--compact", action="store_true", help="执行前手动压缩当前会话")
    parser.add_argument("--interactive", action="store_true", help="进入纯文本连续对话")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--skill", help="显式调用 Skill，-p 作为补充要求")
    action.add_argument("--template", help="调用 Prompt 模板，-p 替换 $ARGUMENTS")
    action.add_argument("--command", help="调用扩展命令，-p 作为命令参数")
    return parser


def _json_value(value):
    if isinstance(value, BaseModel):
        return _json_value(value.model_dump(mode="json"))
    if dataclasses.is_dataclass(value):
        return {field.name: _json_value(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_value(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    return value


def _emit(value):
    print(json.dumps(_json_value(value), ensure_ascii=False), flush=True)


def _select_model(args, registry=None):
    if not args.model:
        return None
    reference = args.model
    if registry is not None:
        matches = [entry for entry in registry.models if reference.lower() in
                   {entry.reference.lower(), entry.model.id.lower(), entry.model.name.lower()}]
        if matches:
            return registry.resolve(reference).model
    provider, separator, model_id = reference.partition("/")
    registered = get_model(provider, model_id) if separator else get_model("openai", reference)
    if registered is not None:
        return registered
    raise ValueError(f"Unknown model '{reference}'; configure it in models.json")


def _print_answer(runtime):
    if runtime.state.error_message:
        raise RuntimeError(runtime.state.error_message)
    answer = next((m for m in reversed(runtime.state.messages) if isinstance(m, AssistantMessage)), None)
    if answer:
        print("".join(block.text for block in answer.content if isinstance(block, TextContent)))


def _print_models(runtime):
    active = f"{runtime.state.model.provider}/{runtime.state.model.id}"
    print(f"当前模型: {active}")
    if not runtime.available_models:
        print("models.json 中没有模型")
        return
    for entry in runtime.available_models:
        marker = "*" if entry.reference == active else " "
        print(f"{marker} {entry.reference}  {entry.model.name}")


async def _interactive(runtime):
    print(f"FoxCode · {runtime.permission_mode} · /help 查看命令，/exit 退出")
    while True:
        try:
            line = input("fox> ").strip()
        except EOFError:
            return
        if not line:
            continue
        try:
            if not line.startswith("/"):
                await runtime.prompt(line)
                _print_answer(runtime)
                continue
            command, _, arguments = line[1:].partition(" ")
            arguments = arguments.strip()
            if command in ("exit", "quit"):
                return
            if command == "help":
                print("/new /resume FILE /fork [ENTRY_ID] /cwd DIR /reload /trust /untrust /permission [read-only|workspace-modify|full-access] /compact /usage /export FILE /tools [names] /model [provider/id] /thinking [off|minimal|low|medium|high|xhigh] /skill NAME [args] /prompt NAME [args] /exit")
                for name, (_, description) in runtime.agent_session.extensions.api.commands.items():
                    print(f"/{name}: {description}")
            elif command == "new":
                await runtime.new_session()
            elif command == "resume":
                await runtime.switch_session(arguments or runtime.latest_session(
                    runtime.cwd, user_dir=runtime.user_dir,
                    project_trusted=runtime.project_trusted,
                ))
            elif command == "fork":
                await runtime.fork(arguments or None)
            elif command == "cwd":
                if arguments:
                    target = Path(arguments).expanduser()
                    target = target if target.is_absolute() else runtime.cwd / target
                    trust_manager = ProjectTrustManager(runtime.user_dir)
                    await runtime.change_cwd(
                        target, project_trusted=trust_manager.decision(target) is True
                    )
                print(runtime.cwd)
            elif command in ("trust", "untrust"):
                trusted = command == "trust"
                ProjectTrustManager(runtime.user_dir).set(runtime.cwd, trusted)
                await runtime.set_project_trust(trusted)
                print("项目已信任" if trusted else "项目已设为不信任")
            elif command == "permission":
                if arguments:
                    await runtime.set_permission_mode(arguments)
                print(f"权限: {runtime.permission_mode}")
            elif command == "reload":
                await runtime.reload()
                print("配置、资源和扩展已重载")
            elif command == "compact":
                result = await runtime.compact()
                print(f"压缩了 {result.removed_count} 条消息\n{result.summary}")
            elif command == "usage":
                print(json.dumps(runtime.usage_totals, ensure_ascii=False))
            elif command == "export":
                if not arguments:
                    raise ValueError("/export requires a .json or .md path")
                print(runtime.export_session(arguments))
            elif command == "tools":
                if arguments:
                    runtime.agent_session.set_active_tools([] if arguments == "none" else arguments.replace(",", " ").split())
                print(", ".join(t.name for t in runtime.state.tools) or "(none)")
            elif command == "model":
                if arguments:
                    model = runtime.select_model(arguments)
                    print(f"当前模型: {model.provider}/{model.id}")
                else:
                    _print_models(runtime)
            elif command == "thinking":
                if arguments:
                    runtime.set_thinking_level(arguments)
                print(f"思考强度: {runtime.state.thinking_level or 'off'}")
            elif command in ("skill", "prompt"):
                name, _, extra = arguments.partition(" ")
                if command == "skill":
                    await runtime.invoke_skill(name, extra)
                else:
                    await runtime.invoke_prompt(name, extra)
                _print_answer(runtime)
            else:
                result = await runtime.run_command(command, arguments)
                if result is not None:
                    print(json.dumps(_json_value(result), ensure_ascii=False))
            if command in ("new", "resume", "fork", "cwd"):
                print(f"Session: {runtime.session_file}", file=sys.stderr)
        except Exception as exc:
            print(f"fox: {exc}", file=sys.stderr)


async def run(args, *, stream_fn=None):
    """stream_fn is an SDK/test injection point; CLI never silently falls back to a fake model."""
    cwd = (args.cwd or Path.cwd()).expanduser().resolve()
    user_dir = args.user_dir or Path.home() / ".foxcode"
    model_config = ModelConfig(user_dir)
    registry = ModelRegistry(model_config)
    if args.list_models:
        models = [{"reference": entry.reference, "name": entry.model.name, "reasoning": entry.model.reasoning}
                  for entry in registry.models]
        if args.json:
            _emit({"type": "models", "models": models})
        else:
            for item in models:
                print(f"{item['reference']}  {item['name']}")
            if not models:
                print(f"No models configured in {model_config.path}")
        return 0
    model = _select_model(args, registry)
    trust_manager = ProjectTrustManager(user_dir)
    initial_trusted = (args.project_trust if args.project_trust is not None
                       else trust_manager.decision(cwd) is True)
    session_file = None
    if args.resume:
        session_file = (AgentSessionRuntime.latest_session(
                            cwd, user_dir=args.user_dir, project_trusted=initial_trusted)
                        if args.resume == "latest" else Path(args.resume).expanduser().resolve())
    overrides = {}
    if args.permission:
        overrides["permission_mode"] = args.permission
    # Require explicit model selection or settings for new sessions; no arbitrary paid default.
    project_trusted = initial_trusted
    if model is None and session_file is None:
        model = SettingsManager(cwd, user_dir=args.user_dir,
                                project_trusted=project_trusted).settings.model
    runtime = AgentSessionRuntime(cwd, model=model, session_file=session_file,
                                  user_dir=args.user_dir, settings_overrides=overrides, stream_fn=stream_fn,
                                  project_trusted=(args.project_trust if args.project_trust is not None else None),
                                  trust_resolver=lambda path: trust_manager.decision(path) is True)
    try:
        if args.project_trust is not None:
            # For --resume the session metadata may select a different cwd
            # than the shell's current directory; record the actual project.
            trust_manager.set(runtime.cwd, args.project_trust)
        if args.cwd is not None and runtime.cwd != cwd:
            raise ValueError(f"Session belongs to {runtime.cwd}; omit --cwd to restore it, or create a new session")
        print(f"Session: {runtime.session_file}", file=sys.stderr)
        print(f"Permission: {runtime.permission_mode}", file=sys.stderr)
        if not runtime.project_trusted:
            print("Project is untrusted: project resources and tools are disabled; use --trust-project or /trust",
                  file=sys.stderr)
        if args.thinking:
            runtime.set_thinking_level(args.thinking)
        for diagnostic in runtime.resources.diagnostics:
            print(f"Resource: {diagnostic}", file=sys.stderr)
        if args.json:
            _emit({"type": "session_start", "session_file": runtime.session_file,
                   "cwd": runtime.cwd, "permission": runtime.permission_mode})

            def on_event(event, cancel_event):
                _emit(event)

            runtime.subscribe(on_event)
        if args.compact:
            result = await runtime.compact()
            if not args.json:
                print(f"压缩了 {result.removed_count} 条消息\n{result.summary}")
        if args.interactive:
            await _interactive(runtime)
            return 0
        if args.command:
            result = await runtime.run_command(args.command, args.prompt or "")
            if args.json:
                _emit({"type": "command_result", "name": args.command, "result": result})
            elif result is not None:
                print(json.dumps(_json_value(result), ensure_ascii=False))
            return 0
        if args.skill:
            await runtime.invoke_skill(args.skill, args.prompt or "")
        elif args.template:
            await runtime.invoke_prompt(args.template, args.prompt or "")
        elif args.prompt is not None:
            if not args.prompt.strip():
                raise ValueError("Prompt must not be empty")
            await runtime.prompt(args.prompt)
        elif not args.compact:
            if runtime.state.messages and isinstance(runtime.state.messages[-1], AssistantMessage):
                raise ValueError("Session has a completed assistant response; use --resume -p TASK for a new turn")
            await runtime.continue_()
        if runtime.state.error_message:
            raise RuntimeError(runtime.state.error_message)
        if not args.json:
            if args.prompt is not None or args.skill or args.template or not args.compact:
                _print_answer(runtime)
        return 0
    finally:
        await runtime.close()


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.interactive and (args.json or args.prompt is not None or args.command or args.skill or args.template or args.list_models):
        parser.error("--interactive cannot be combined with --json, -p, --command, --skill, --template or --list-models")
    if args.list_models and (args.prompt is not None or args.resume or args.compact or args.command or args.skill or args.template):
        parser.error("--list-models cannot be combined with a task or session action")
    if args.prompt is None and not (args.resume or args.compact or args.command or args.skill or args.template or args.interactive or args.list_models):
        if sys.stdin.isatty() and not args.json:
            args.interactive = True
        else:
            parser.error("provide -p TASK, --resume [SESSION.jsonl], or --interactive")
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        if args.json:
            _emit({"type": "error", "error": "Interrupted"})
        print("Interrupted", file=sys.stderr)
        return 130
    except Exception as exc:
        if args.json:
            _emit({"type": "error", "error": str(exc)})
        print(f"fox: {exc}", file=sys.stderr)
        return 1
