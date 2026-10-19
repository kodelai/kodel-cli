# Agent adapters

One directory per supported agent (`claude-code`, `codex`, `opencode`). An adapter holds the
agent-specific pieces only: the MCP config writer used by `kodel mcp install`, the deny rules
written by `kodel init`, and the prompt or skill that drives the pipeline loop.

An agent is listed as supported only after it passes the real-agent scenarios in `tests/agents/`.
