"""统一加载 AGENTS.md、Skill 与 Prompt；扩展通过显式 provider 接口接入。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .skills import Skill, load_skills_from_dir, parse_frontmatter


@dataclass(frozen=True)
class ContextFile:
    path: Path
    content: str


@dataclass(frozen=True)
class PromptTemplate:
    name: str
    description: str
    content: str
    path: Path

    def render(self, arguments: str = "") -> str:
        # Literal substitution: no Python, shell or template expressions are evaluated.
        return self.content.replace("$ARGUMENTS", arguments)


@dataclass
class Resources:
    context_files: list[ContextFile] = field(default_factory=list)
    skills: list[Skill] = field(default_factory=list)
    prompts: dict[str, PromptTemplate] = field(default_factory=dict)
    diagnostics: list[str] = field(default_factory=list)
    system_prompt_override: str | None = None
    append_system_prompts: list[str] = field(default_factory=list)

    def system_prompt(self, base: str) -> str:
        sections = [base]
        sections.extend(f"Project instructions ({item.path}):\n{item.content}" for item in self.context_files)
        return "\n\n".join(part for part in sections if part)


ResourceProvider = Callable[[Path], Resources]


class ResourceLoader:
    """用户资源 + 项目资源。Skill/Prompt 同名时项目覆盖用户，诊断中注明。

    providers 为宿主显式传入的 Python 回调；不自动执行项目目录中的插件代码。
    每次 load 返回独立快照，让 Runtime 成功重建后再替换旧快照。
    """

    def __init__(self, cwd: str | Path = ".", *, user_dir: str | Path | None = None,
                 providers: tuple[ResourceProvider, ...] = ()):
        self.cwd = Path(cwd).expanduser().resolve()
        self.user_dir = Path(user_dir).expanduser().resolve() if user_dir else Path.home() / ".foxcode"
        self.providers = tuple(providers)

    def load(self) -> Resources:
        result = Resources()
        for root in dict.fromkeys([self.user_dir, self.cwd / ".foxcode"]):
            system = root / "SYSTEM.md"
            append = root / "APPEND_SYSTEM.md"
            if system.is_file():
                result.system_prompt_override = system.read_text(encoding="utf-8-sig")
            if append.is_file():
                result.append_system_prompts.append(append.read_text(encoding="utf-8-sig"))
        seen: set[Path] = set()
        paths = [self.user_dir / "AGENTS.md"]
        paths.extend(p / "AGENTS.md" for p in [*reversed(self.cwd.parents), self.cwd])
        for path in paths:
            if path.is_file() and path.resolve() not in seen:
                seen.add(path.resolve())
                result.context_files.append(ContextFile(path.resolve(), path.read_text(encoding="utf-8-sig")))

        skills: dict[str, Skill] = {}
        # Include the existing mini-core's legacy user Skill directory at lowest priority.
        roots = [self.user_dir / "agent", self.user_dir, self.cwd / ".foxcode"]
        for root in dict.fromkeys(roots):
            loaded = load_skills_from_dir(root / "skills")
            result.diagnostics.extend(f"{d.path}: {d.message}" for d in loaded.diagnostics)
            for skill in loaded.skills:
                if skill.name in skills:
                    result.diagnostics.append(f"Skill {skill.name!r} overridden by {skill.file_path}")
                skills[skill.name] = skill
        result.skills = list(skills.values())

        for root in dict.fromkeys([self.user_dir / "prompts", self.cwd / ".foxcode" / "prompts"]):
            if not root.is_dir():
                continue
            for path in sorted(root.rglob("*.md")):
                name = path.relative_to(root).with_suffix("").as_posix()
                metadata, body = parse_frontmatter(path.read_text(encoding="utf-8-sig"))
                if name in result.prompts:
                    result.diagnostics.append(f"Prompt {name!r} overridden by {path}")
                result.prompts[name] = PromptTemplate(name, str(metadata.get("description", "")), body, path)

        for provider in self.providers:
            extra = provider(self.cwd)
            if not isinstance(extra, Resources):
                raise TypeError("Resource providers must return Resources")
            result.context_files.extend(extra.context_files)
            names = {skill.name: skill for skill in result.skills}
            names.update({skill.name: skill for skill in extra.skills})
            result.skills = list(names.values())
            result.prompts.update(extra.prompts)
            result.diagnostics.extend(extra.diagnostics)
            if extra.system_prompt_override is not None:
                result.system_prompt_override = extra.system_prompt_override
            result.append_system_prompts.extend(extra.append_system_prompts)
        return result
