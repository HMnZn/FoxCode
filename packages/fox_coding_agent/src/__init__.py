"""Mini coding agent SDK. CLI and future UIs share these host services."""

from .core.runtime import AgentSessionRuntime
from .core.agent_session import (
    AgentSession, AgentSessionConfig,
    CompactionEvent, RecoveryEvent,
)
from .core.settings import SettingsManager, RuntimeSettings
from .core.credentials import CredentialStore
from .core.model_config import ModelConfig, ModelConfigSnapshot, ConfiguredModel
from .core.model_registry import ModelRegistry
from .core.model_runtime import ModelRuntime
from .core.trust import ProjectTrustManager
from .core.permissions import PERMISSION_MODES, PermissionMode, check_tool_permission
from .core.resources import ResourceLoader, ResourceProvider, Resources, ContextFile, PromptTemplate
from .core.tools import (ReadTool, WriteTool, EditTool, BashTool, PowerShellTool,
                         GrepTool, FindTool, LsTool, create_coding_tools, create_all_tools)
from .core.system_prompt import build_system_prompt
from .core.extensions import ExtensionAPI, ExtensionRunner, ExtensionContext
from .extensions.memory import (
    HybridRetriever, MemoryEntry, MemoryExtensionConfig, MemoryService, MemoryStore,
    RetrievalConfig, SearchResult, WriteDecision, WriteResult,
    create_memory_extension, project_memory_id,
)
from .core.session_manager import (
    SessionManager, SessionEntry, SessionStorage,
    InMemorySessionStorage, JsonlSessionStorage,
)
from fox_agent_core.src.harness import (
    CompactionResult, CompactionSettings, calculate_context_tokens, compact,
    estimate_context_tokens, estimate_tokens, find_cut_point, generate_summary, should_compact,
)
from .core.skills import (
    Skill, SkillDiagnostic, SkillLoadResult, LoadSkillsOptions,
    load_skills, load_skill_from_file, load_skills_from_dir,
    format_skills_for_prompt, format_skill_invocation, parse_frontmatter,
    validate_name, validate_description,
)
