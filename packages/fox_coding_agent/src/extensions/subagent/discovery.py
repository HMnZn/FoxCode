"""Deterministic discovery of user and trusted-project sub-agent profiles."""

from __future__ import annotations

from pathlib import Path

from ...core.skills import parse_frontmatter
from ...core.paths import ProjectPaths, UserPaths
from .models import SubAgentCatalog, SubAgentDefinition, SubAgentDiagnostic, built_in_agents


def _allowed_tools(value) -> tuple[str, ...] | None:
    if value is None:
        return None
    if isinstance(value, str):
        values = [item.strip() for item in value.split(",")]
    elif isinstance(value, list):
        values = value
    else:
        raise ValueError("allowed-tools must be a comma-separated string or string array")
    if not all(isinstance(item, str) and item.strip() for item in values):
        raise ValueError("allowed-tools must contain nonempty strings")
    return tuple(item.strip() for item in values)


def _load_directory(directory: Path, catalog: SubAgentCatalog) -> None:
    if not directory.is_dir():
        return
    try:
        files = sorted(directory.glob("*.md"), key=lambda path: path.name)
    except OSError as exc:
        catalog.diagnostics.append(SubAgentDiagnostic("list_failed", str(exc), str(directory)))
        return
    for path in files:
        try:
            metadata, body = parse_frontmatter(path.read_text(encoding="utf-8-sig"))
            name = metadata.get("name", path.stem)
            description = metadata.get("description")
            if not isinstance(name, str) or not isinstance(description, str):
                raise ValueError("name and description must be strings")
            definition = SubAgentDefinition(
                name=name,
                description=description,
                system_prompt=body,
                allowed_tools=_allowed_tools(
                    metadata.get("allowed-tools", metadata.get("allowed_tools"))
                ),
                source=str(path.resolve()),
            )
            catalog.definitions[definition.name] = definition
        except (OSError, UnicodeError, ValueError) as exc:
            catalog.diagnostics.append(
                SubAgentDiagnostic("invalid_profile", str(exc), str(path.resolve()))
            )


def discover_subagents(
    user_dir: str | Path,
    cwd: str | Path,
    *,
    project_trusted: bool,
) -> SubAgentCatalog:
    """Load built-ins, then user profiles, then trusted-project overrides."""
    catalog = SubAgentCatalog(definitions=built_in_agents())
    _load_directory(UserPaths.from_root(user_dir).agents, catalog)
    if project_trusted:
        _load_directory(ProjectPaths.from_root(cwd).agents, catalog)
    return catalog


__all__ = ["discover_subagents"]
