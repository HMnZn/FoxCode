"""Mini coding agent SDK. CLI and future UIs share these host services."""

from .core.runtime import AgentSessionRuntime
from .core.harness import AgentHarness, AgentHarnessOptions, CompactionEvent
from .core.settings import SettingsManager, RuntimeSettings
from .core.auth import AuthStore, AuthenticatedModel
from .core.resources import ResourceLoader, ResourceProvider, Resources, ContextFile, PromptTemplate
from .core.tools import (ReadTool, WriteTool, EditTool, BashTool, PowerShellTool,
                         GrepTool, FindTool, LsTool, create_coding_tools, create_all_tools)
from .core.system_prompt import build_system_prompt
from .core.extensions import ExtensionAPI, ExtensionRunner, ExtensionContext
from .core.session import Session, SessionEntry, SessionStorage, InMemorySessionStorage, JsonlSessionStorage
from .core.compaction import (
    CompactionResult, CompactionSettings, calculate_context_tokens, compact,
    estimate_context_tokens, estimate_tokens, find_cut_point, generate_summary, should_compact,
)
from .core.skills import (
    Skill, SkillDiagnostic, SkillLoadResult, LoadSkillsOptions,
    load_skills, load_skill_from_file, load_skills_from_dir,
    format_skills_for_prompt, format_skill_invocation, parse_frontmatter,
    validate_name, validate_description,
)
