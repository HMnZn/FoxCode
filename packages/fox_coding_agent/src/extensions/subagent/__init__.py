"""Isolated, capability-scoped sub-agent extension."""

from .discovery import discover_subagents
from .extension import (
    SubAgentExtensionConfig, SubAgentService, SubAgentTool,
    create_subagent_extension, setup,
)
from .models import SubAgentCatalog, SubAgentDefinition, SubAgentDiagnostic, built_in_agents

__all__ = [
    "SubAgentCatalog", "SubAgentDefinition", "SubAgentDiagnostic",
    "SubAgentExtensionConfig", "SubAgentService", "SubAgentTool", "built_in_agents",
    "create_subagent_extension", "discover_subagents", "setup",
]
