"""Alternative file entry point; normally enable the packaged extension with --memory.

Example: uv run fox --trust-project --extension examples/extensions/memory.py --interactive
"""

from fox_coding_agent.src.extensions.memory import setup
