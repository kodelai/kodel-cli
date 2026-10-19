# Kodel

Spec-driven pipelines for solo developers, running inside the coding agent you already use.

> Status: early design. Nothing here is released yet; see `prd/` for the current drafts
> (product requirements, decisions, and the MCP tool contract).

## Idea

- Describe *how you work* as a reusable pipeline file that lives in your repository.
- Your agent (Claude Code, Codex, OpenCode, ...) drives the run through MCP tools.
- Every step result is validated outside the agent, so "done" is verifiable.
- Run history stays in git and is analyzed to suggest improvements to the pipeline.

## Repository

See [AGENTS.md](AGENTS.md) for the layout and contribution rules.

## License

Apache-2.0. See [LICENSE](LICENSE).
