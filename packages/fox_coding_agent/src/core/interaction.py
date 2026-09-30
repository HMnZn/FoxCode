"""Interaction-mode policy, automatic routing, and plan-safe tool checks."""

from __future__ import annotations

import re
from typing import Literal


InteractionMode = Literal["auto", "default", "plan"]
EffectiveInteractionMode = Literal["default", "plan"]
INTERACTION_MODES: tuple[InteractionMode, ...] = ("auto", "default", "plan")

# Automatic routing is deliberately conservative.  An explicit implementation
# request wins even when it mentions a plan, while requests that ask for a
# proposal/design without asking for changes enter the read-only planning mode.
_IMPLEMENT_RE = re.compile(
    r"(?:开始|直接|立即|现在)?\s*(?:实施|执行|落地|实现|修复|修改|改造|新增|添加|删除|重构|编写|写入|完成)"
    r"|(?:implement|execute|apply|fix|modify|change|edit|write|add|remove|refactor|build)\b",
    re.IGNORECASE,
)
_PLAN_RE = re.compile(
    r"(?:先|只|帮我|给我)?\s*(?:规划|计划|设计思路|设计方案|实施方案|技术方案|架构方案)"
    r"|(?:怎么|如何).{0,24}(?:设计|规划|实现)"
    r"|(?:不要|无需|先不).{0,12}(?:修改|实现|动代码|写代码)"
    r"|\b(?:plan|planning|proposal|approach|roadmap)\b"
    r"|\b(?:how (?:would|should|can) (?:we|i|you)|design)\b",
    re.IGNORECASE,
)
_PLAN_WITH_IMPLEMENT_RE = re.compile(
    r"(?:设计|规划|计划).{0,12}(?:并|然后|后)(?:实施|实现|修改|落地)"
    r"|(?:plan|design).{0,30}(?:and|then).{0,12}(?:implement|apply|build)",
    re.IGNORECASE,
)


def infer_interaction_mode(message: str) -> EffectiveInteractionMode:
    """Infer a safe per-turn mode for the ``auto`` selection.

    Ambiguous requests remain in the normal execution mode.  This keeps the
    classifier predictable and lets users force planning with the manual mode.
    """

    text = " ".join(str(message).strip().split())
    if not text:
        return "default"
    if _PLAN_WITH_IMPLEMENT_RE.search(text):
        return "default"
    if _PLAN_RE.search(text):
        # Strong imperative requests such as "修改并给我一个方案" are work,
        # not planning-only requests.
        plan_match = _PLAN_RE.search(text)
        implement_match = _IMPLEMENT_RE.search(text)
        if implement_match and plan_match and implement_match.start() < plan_match.start():
            return "default"
        return "plan"
    return "default"


def resolve_interaction_mode(selection: InteractionMode, message: str) -> EffectiveInteractionMode:
    if selection not in INTERACTION_MODES:
        raise ValueError(f"Interaction mode must be one of: {', '.join(INTERACTION_MODES)}")
    return infer_interaction_mode(message) if selection == "auto" else selection


def is_plan_safe_tool(tool: object) -> bool:
    """Return whether a tool is safe to expose and execute while planning."""

    if getattr(tool, "plan_safe", None) is not None:
        return bool(getattr(tool, "plan_safe"))

    domain = getattr(tool, "permission_domain", "runtime")
    if domain == "extension-state":
        return getattr(tool, "permission_action", None) == "read"
    if domain != "runtime":
        return False

    # The generic sub-agent tool can dispatch a ``general`` child with write
    # tools, so its top-level read-only declaration is not sufficient here.
    if getattr(tool, "name", "") == "agent":
        return False
    return getattr(tool, "required_permission", "full-access") == "read-only"


__all__ = [
    "EffectiveInteractionMode", "INTERACTION_MODES", "InteractionMode",
    "infer_interaction_mode", "is_plan_safe_tool", "resolve_interaction_mode",
]
