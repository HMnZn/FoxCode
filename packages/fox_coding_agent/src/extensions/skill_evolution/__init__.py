"""Staged, auditable self-evolving skills extension with real evaluation support."""

from .extension import (
    SkillEvolutionConfig,
    SkillEvolutionService,
    SkillEvolutionTool,
    create_skill_evolution_extension,
    setup,
)
from .models import EvolutionProposal, SkillCandidate
from .store import SkillEvolutionStore, candidate_rejection_reasons, project_evolution_id

__all__ = [
    "EvolutionProposal", "SkillCandidate", "SkillEvolutionConfig", "SkillEvolutionService",
    "SkillEvolutionStore", "SkillEvolutionTool", "candidate_rejection_reasons",
    "create_skill_evolution_extension", "project_evolution_id", "setup",
]
