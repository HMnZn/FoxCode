"""扩展目录：发现可加载的扩展、探测它们提供了什么、判断启停该写哪个文件。

设计约束（与 `packages/fox_coding_agent` 的分工）：

- 扩展的**加载**仍然只由 `AgentSessionRuntime` 完成（`settings.extensions` 里的
  `module:` / `entrypoint:` / 文件路径），本模块不参与加载，也不持有运行时状态；
- 本模块只做三件只读的事：**发现**候选扩展、**探测**单个扩展注册了什么、
  **解析**某个 spec 当前写在项目级还是用户级的 `settings.json` 里。

探测刻意分两种强度：

- `module:` / `entrypoint:` 这类包内扩展，用一个一次性 `ExtensionRunner` 真正跑
  一次 `setup(api)`，从而拿到工具/命令/服务/钩子的准确清单。这些扩展的 `setup`
  是纯注册（构造 service、登记 handler），不会连接 MCP 服务器或写磁盘；
- 文件扩展（`~/.foxcode/extensions/*.py`）**不执行**，只用 AST 读模块 docstring，
  避免为了展示而运行任意脚本。
"""

from __future__ import annotations

import ast
import importlib.util
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable
from fox_coding_agent.src.core.paths import ProjectPaths, UserPaths

#: 配置里 `extensions` 数组的两种作用域。项目级存在时整体覆盖用户级。
SCOPES: tuple[str, str] = ("project", "user")

#: 文件扩展的搜索目录（相对于各自的根）。
EXTENSION_SUBDIR = "extensions"
PROJECT_DIR = ".foxcode"


def spec_kind(spec: str) -> str:
    """`module:` / `entrypoint:` / 文件路径。"""

    if spec.startswith("module:"):
        return "module"
    if spec.startswith("entrypoint:"):
        return "entrypoint"
    return "file"


def module_target(spec: str) -> str:
    """`module:a.b:c` → `a.b`；`module:a.b` → `a.b`。"""

    target = spec.removeprefix("module:")
    head, separator, _tail = target.rpartition(":")
    return head if separator else target


def spec_name(spec: str) -> str:
    """展示名：包扩展取末段模块名，文件扩展取文件名主干。"""

    kind = spec_kind(spec)
    if kind == "module":
        target = module_target(spec)
        return target.rpartition(".")[2] or target or spec
    if kind == "entrypoint":
        return spec.removeprefix("entrypoint:") or spec
    return Path(spec).stem or spec


@dataclass
class Probe:
    """一个扩展的静态/探测结果。"""

    description: str = ""
    probed: bool = False
    tools: list[str] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)
    services: list[str] = field(default_factory=list)
    hooks: list[str] = field(default_factory=list)
    context_transforms: list[str] = field(default_factory=list)
    error: str | None = None
    location: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "description": self.description,
            "probed": self.probed,
            "tools": list(self.tools),
            "commands": list(self.commands),
            "services": list(self.services),
            "hooks": list(self.hooks),
            "contextTransforms": list(self.context_transforms),
            "error": self.error,
            "location": self.location,
        }


_PROBE_CACHE: dict[tuple[str, float], Probe] = {}


def _module_file(spec: str) -> str:
    """`module:a.b:c` → 该模块的文件路径（用于缓存失效与展示）。"""

    if spec_kind(spec) != "module":
        return ""
    target = module_target(spec)
    try:
        found = importlib.util.find_spec(target)
    except (ImportError, ValueError, AttributeError):
        return ""
    return str(getattr(found, "origin", "") or "")


def _mtime(path: str) -> float:
    if not path:
        return 0.0
    try:
        return Path(path).stat().st_mtime
    except OSError:
        return 0.0


def _file_docstring(path: Path) -> tuple[str, str | None]:
    """不执行脚本，只读它的模块 docstring。返回 (docstring, error)。"""

    try:
        source = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        return "", f"无法读取扩展文件：{exc}"
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:
        return "", f"语法错误：{exc}"
    return (ast.get_docstring(tree) or "").strip(), None


def probe_spec(spec: str) -> Probe:
    """探测一个扩展 spec；结果按 (spec, 文件 mtime) 缓存。"""

    location = _module_file(spec) if spec_kind(spec) != "file" else str(Path(spec))
    key = (spec, _mtime(location))
    cached = _PROBE_CACHE.get(key)
    if cached is not None:
        return cached
    probe = _probe_uncached(spec, location)
    _PROBE_CACHE[key] = probe
    return probe


def clear_probe_cache() -> None:
    _PROBE_CACHE.clear()


def _probe_uncached(spec: str, location: str) -> Probe:
    if spec_kind(spec) == "file":
        path = Path(spec)
        if not path.is_file():
            return Probe(error=f"扩展文件不存在：{path}", location=str(path))
        description, error = _file_docstring(path)
        return Probe(description=description, error=error, location=str(path))

    # 包扩展：真正跑一次 setup(api)，但只落在一个一次性 runner 上。
    try:
        from fox_coding_agent.src.core.extensions import ExtensionRunner
    except Exception as exc:  # pragma: no cover - 依赖缺失时才发生
        return Probe(error=f"无法导入扩展 API：{exc}", location=location)

    runner = None
    try:
        runner = ExtensionRunner.load(specs=[spec])
        api = runner.api
        module = None
        if spec_kind(spec) == "module":
            module = importlib.import_module(module_target(spec))
        return Probe(
            description=(getattr(module, "__doc__", "") or "").strip(),
            probed=True,
            tools=[str(getattr(tool, "name", "")) for tool in api.tools],
            commands=sorted(str(name) for name in api.commands),
            services=sorted(str(name) for name in api.services),
            hooks=sorted(str(name) for name in api.handlers),
            context_transforms=[str(name) for name, _ in api.context_transforms],
            location=location,
        )
    except Exception as exc:
        return Probe(error=f"{type(exc).__name__}: {exc}", location=location)
    finally:
        if runner is not None:
            runner.dispose()


@dataclass(frozen=True)
class Candidate:
    """一个可被启用（或当前已启用）的扩展。"""

    spec: str
    name: str
    kind: str
    origin: str  # 'builtin' | 'user' | 'project'
    path: str
    probe: Probe

    @property
    def id(self) -> str:
        return self.spec


def _package_extensions_dir() -> tuple[Path | None, str]:
    """仓库内置扩展的目录与模块前缀（`fox_coding_agent.src.extensions`）。"""

    try:
        import fox_coding_agent.src.extensions as package
    except Exception:
        return None, ""
    origin = getattr(package, "__file__", "") or ""
    if not origin:
        return None, ""
    return Path(origin).parent, str(package.__name__)


def discover(
    *,
    user_dir: Path,
    cwd: Path,
) -> list[Candidate]:
    """按「内置包 → 用户目录 → 项目目录」的顺序发现候选扩展。"""

    candidates: list[Candidate] = []
    seen: set[str] = set()

    package_dir, prefix = _package_extensions_dir()
    if package_dir is not None and prefix and package_dir.is_dir():
        for child in sorted(package_dir.iterdir()):
            module_file = child / "extension.py"
            if not child.is_dir() or not module_file.is_file():
                continue
            spec = f"module:{prefix}.{child.name}:setup"
            seen.add(spec)
            candidates.append(
                Candidate(
                    spec=spec,
                    name=child.name,
                    kind="module",
                    origin="builtin",
                    path=str(package_dir / child.name),
                    probe=probe_spec(spec),
                )
            )

    for origin, directory in (
        ("user", UserPaths.from_root(user_dir).extensions),
        ("project", ProjectPaths.from_root(cwd).extensions),
    ):
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.py")):
            spec = str(path.resolve())
            if spec in seen:
                continue
            seen.add(spec)
            candidates.append(
                Candidate(
                    spec=spec,
                    name=path.stem,
                    kind="file",
                    origin=origin,
                    path=spec,
                    probe=probe_spec(spec),
                )
            )
    return candidates


@dataclass(frozen=True)
class Configured:
    """配置里的一个扩展条目 + 它写在哪个文件里。"""

    spec: str
    scope: str
    enabled: bool = True


def read_configured(path: Path) -> list[str]:
    """读一个 settings.json 的 `extensions` 原始列表（不解析、不写回）。"""

    import json

    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    items = data.get("extensions")
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, str)]


def has_extensions_key(path: Path) -> bool:
    """该文件是否显式定义了 `extensions`（决定合并时谁覆盖谁）。"""

    import json

    if not path.is_file():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and isinstance(data.get("extensions"), list)


def effective_scope(user_path: Path, project_path: Path) -> str:
    """`RuntimeSettings` 的合并规则是「列表整体替换」，所以项目级有键就赢。"""

    return "project" if has_extensions_key(project_path) else "user"


def effective_specs(user_path: Path, project_path: Path) -> list[str]:
    scope = effective_scope(user_path, project_path)
    return read_configured(project_path if scope == "project" else user_path)


def suggested_scope(user_path: Path, project_path: Path, *, project_trusted: bool) -> str:
    """新扩展默认写哪儿：跟随当前生效的文件；都没有时项目已信任就写项目。"""

    if has_extensions_key(project_path) or has_extensions_key(user_path):
        return effective_scope(user_path, project_path)
    return "project" if project_trusted else "user"


def specs_present_in(user_path: Path, project_path: Path) -> dict[str, list[str]]:
    """spec → 出现在哪些作用域（用于「已写在另一处」的提示与关闭时全清）。"""

    found: dict[str, list[str]] = {}
    for scope, path in (("project", project_path), ("user", user_path)):
        for spec in read_configured(path):
            found.setdefault(spec, []).append(scope)
    return found


def describe_configured(
    specs: Iterable[str],
    *,
    scope: str,
    present_in: dict[str, list[str]] | None = None,
    probes: dict[str, Probe] | None = None,
) -> list[dict[str, Any]]:
    """把生效的 spec 列表变成前端要的条目。"""

    presence = present_in or {}
    cache = probes or {}
    out: list[dict[str, Any]] = []
    for spec in specs:
        probe = cache.get(spec) or probe_spec(spec)
        scopes = presence.get(spec, [scope])
        out.append(
            {
                "id": spec,
                "spec": spec,
                "name": spec_name(spec),
                "kind": spec_kind(spec),
                "path": probe.location or spec,
                "scope": scope,
                "enabled": True,
                "shadowed": [item for item in scopes if item != scope],
                **probe.to_dict(),
            }
        )
    return out


def describe_available(
    candidates: Iterable[Candidate],
    *,
    scope: str,
    configured: set[str],
    present_in: dict[str, list[str]] | None = None,
) -> list[dict[str, Any]]:
    """可发现但当前不生效的扩展（未配置，或被另一个作用域的文件覆盖）。"""

    presence = present_in or {}
    out: list[dict[str, Any]] = []
    for candidate in candidates:
        if candidate.spec in configured:
            continue
        elsewhere = [item for item in presence.get(candidate.spec, []) if item != scope]
        out.append(
            {
                "id": candidate.spec,
                "spec": candidate.spec,
                "name": candidate.name,
                "kind": candidate.kind,
                "path": candidate.path,
                "origin": candidate.origin,
                "scope": scope,
                "enabled": False,
                "shadowed": elsewhere,
                **candidate.probe.to_dict(),
            }
        )
    return out


__all__ = [
    "Candidate",
    "Configured",
    "EXTENSION_SUBDIR",
    "PROJECT_DIR",
    "Probe",
    "SCOPES",
    "clear_probe_cache",
    "describe_available",
    "describe_configured",
    "discover",
    "effective_scope",
    "effective_specs",
    "has_extensions_key",
    "module_target",
    "probe_spec",
    "read_configured",
    "spec_kind",
    "spec_name",
    "specs_present_in",
    "suggested_scope",
]
