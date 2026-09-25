"""CLI adapter: one-shot text/JSON or a plain terminal conversation, sharing the same SDK."""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import sys
from pathlib import Path

from pydantic import BaseModel
from fox_ai.src import AssistantMessage, Model, TextContent, get_model
from fox_coding_agent.src import AgentSessionRuntime, SettingsManager
from fox_coding_agent.src.core.auth import AuthStore

THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")


def build_parser():
    parser = argparse.ArgumentParser(prog="fox", description="FoxCode mini coding agent")
    parser.add_argument("-p", "--prompt", help="执行任务后退出")
    parser.add_argument("--resume", nargs="?", const="latest", metavar="SESSION.jsonl",
                        help="恢复指定会话；省略路径则恢复当前项目最近会话")
    parser.add_argument("--json", action="store_true", help="stdout 输出逐行 JSON 事件")
    parser.add_argument("--cwd", type=Path, default=None, help="项目目录，默认当前目录")
    parser.add_argument("--user-dir", type=Path, help="用户配置目录，默认 ~/.foxcode")
    parser.add_argument("--provider", help="模型 provider，例如 deepseek")
    parser.add_argument("--model", help="模型 ID 或 provider/model；优先匹配用户 auth.json")
    parser.add_argument("--base-url", help="自定义服务地址；须与 --model 一起使用")
    parser.add_argument("--api", choices=["openai-completions", "anthropic-messages"],
                        help="自定义模型协议；默认 openai-completions")
    parser.add_argument("--api-key-env", help="存放 API key 的环境变量名")
    parser.add_argument("--max-tokens", type=int, help="单次输出 token 上限")
    parser.add_argument("--thinking", choices=THINKING_LEVELS, help="本次会话的思考强度")
    parser.add_argument("--list-models", action="store_true", help="列出用户 auth.json 中可切换的模型后退出")
    parser.add_argument("--tools", help="启用的工具名，以逗号分隔；空字符串禁用工具")
    parser.add_argument("--extension", action="append", default=[], type=Path, help="加载 Python 扩展，可重复")
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


def _select_model(args, auth_store=None):
    if not args.model:
        if args.provider or args.base_url or args.api:
            raise ValueError("--provider, --base-url and --api require --model")
        return None
    provider = args.provider or "openai"
    if auth_store is not None and not args.base_url and not args.api:
        reference = f"{provider}/{args.model}" if args.provider else args.model
        matches = [entry for entry in auth_store.models if reference.lower() in
                   {entry.reference.lower(), entry.model.id.lower(), entry.model.name.lower()}]
        if matches:
            return auth_store.resolve(reference).model
    registered = get_model(provider, args.model)
    if registered is not None and not args.base_url and not args.api:
        return registered
    if not args.base_url:
        raise ValueError("Unregistered models require --base-url, or configure a full model in settings.json")
    # This is a conservative local context budget, not a claim about the provider's maximum window.
    return Model(id=args.model, name=args.model, provider=provider,
                 api=args.api or "openai-completions", base_url=args.base_url,
                 input=["text"], context_window=32768, max_tokens=args.max_tokens or 4096,
                 compat={"supportsStrictMode": False})


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
        print("auth.json 中没有模型")
        return
    for entry in runtime.available_models:
        marker = "*" if entry.reference == active else " "
        print(f"{marker} {entry.reference}  {entry.model.name}")


async def _interactive(runtime):
    print("FoxCode · /help 查看命令，/exit 退出")
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
                print("/new /resume FILE /cwd DIR /reload /compact /tools [names] /model [provider/id] /thinking [off|minimal|low|medium|high|xhigh|max] /skill NAME [args] /prompt NAME [args] /exit")
                for name, (_, description) in runtime.harness.extensions.api.commands.items():
                    print(f"/{name}: {description}")
            elif command == "new":
                await runtime.new_session()
            elif command == "resume":
                await runtime.switch_session(arguments or runtime.latest_session(runtime.cwd, user_dir=runtime.user_dir))
            elif command == "cwd":
                if arguments:
                    target = Path(arguments).expanduser()
                    await runtime.change_cwd(target if target.is_absolute() else runtime.cwd / target)
                print(runtime.cwd)
            elif command == "reload":
                await runtime.reload()
                print("配置、资源和扩展已重载")
            elif command == "compact":
                result = await runtime.compact()
                print(f"压缩了 {result.removed_count} 条消息\n{result.summary}")
            elif command == "tools":
                if arguments:
                    runtime.harness.set_active_tools([] if arguments == "none" else arguments.replace(",", " ").split())
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
            if command in ("new", "resume", "cwd"):
                print(f"Session: {runtime.session_file}", file=sys.stderr)
        except Exception as exc:
            print(f"fox: {exc}", file=sys.stderr)


async def run(args, *, stream_fn=None):
    """stream_fn is an SDK/test injection point; CLI never silently falls back to a fake model."""
    cwd = (args.cwd or Path.cwd()).expanduser().resolve()
    auth_store = AuthStore(args.user_dir or Path.home() / ".foxcode")
    if args.list_models:
        models = [{"reference": entry.reference, "name": entry.model.name, "reasoning": entry.model.reasoning}
                  for entry in auth_store.models]
        if args.json:
            _emit({"type": "models", "models": models})
        else:
            for item in models:
                print(f"{item['reference']}  {item['name']}")
            if not models:
                print(f"No models configured in {auth_store.path}")
        return 0
    model = _select_model(args, auth_store)
    session_file = None
    if args.resume:
        session_file = (AgentSessionRuntime.latest_session(cwd, user_dir=args.user_dir)
                        if args.resume == "latest" else Path(args.resume).expanduser().resolve())
    if args.max_tokens is not None and args.max_tokens <= 0:
        raise ValueError("--max-tokens must be positive")
    overrides = {}
    if args.api_key_env:
        overrides["api_key_env"] = args.api_key_env
    if args.max_tokens:
        overrides["stream_options"] = {"max_tokens": args.max_tokens}
    if args.tools is not None:
        overrides["tools"] = [name.strip() for name in args.tools.split(",") if name.strip()]
    # Require explicit model selection or settings for new sessions; no arbitrary paid default.
    if model is None and session_file is None:
        model = SettingsManager(cwd, user_dir=args.user_dir).settings.model
    runtime = AgentSessionRuntime(cwd, model=model, session_file=session_file,
                                  user_dir=args.user_dir, settings_overrides=overrides, stream_fn=stream_fn,
                                  extension_paths=args.extension)
    try:
        if args.cwd is not None and runtime.cwd != cwd:
            raise ValueError(f"Session belongs to {runtime.cwd}; omit --cwd to restore it, or create a new session")
        print(f"Session: {runtime.session_file}", file=sys.stderr)
        if args.thinking:
            runtime.set_thinking_level(args.thinking)
        for diagnostic in runtime.resources.diagnostics:
            print(f"Resource: {diagnostic}", file=sys.stderr)
        if args.json:
            _emit({"type": "session_start", "session_file": runtime.session_file, "cwd": runtime.cwd})

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
