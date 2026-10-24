# Agent adapters

One directory per supported agent (`claude-code`, `codex`, `opencode`). An adapter holds the
agent-specific pieces only: the MCP config writer used by `kodel init`, and the prompt or skill that drives the pipeline loop.

An agent is listed as supported only after it passes the real-agent scenarios in `tests/agents/`.

Until the adapters are split out of the CLI, the code of `kodel init` lives in `packages/cli/src/init/`
(`agents.ts` has one adapter per agent). `claude-code` is checked on the real agent; `codex` and `opencode`
are written to the agents' documented formats and not checked yet.

The `kodel-run` launcher skill is installed for every agent by `kodel init`, into its `skillsDir` (`.claude/skills`, `.agents/skills`, `.opencode/skills`).
