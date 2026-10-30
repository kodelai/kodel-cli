# Kodel

Spec-driven pipelines for solo developers, running inside the coding agent you already use.

> Status: early development. Nothing here is released yet, and the documentation will be
> written once the first working version exists.

## Idea

- Describe *how you work* as a reusable pipeline file that lives in your repository.
- Your agent (Claude Code, Codex, OpenCode, ...) drives the run through MCP tools.
- Every step result is validated outside the agent, so "done" is verifiable.
- Run history stays in git and is analyzed to suggest improvements to the pipeline.
- Optional [tasks](docs/tasks.md): the agent writes down what it finds on the way ("create a task for
  that bug"), you ask what is left, and a tracker such as Jira can sit behind the same interface.

## Forks and subagents

A pipeline may fork: several branches run at once and meet at a `join: all` step. How the agent works
the steps that are open at the same time is set in the project config (`.kodel/config.yaml`):

```yaml
agents:
  subagents: auto   # yes: one subagent (worker) per open step; no: one step after another;
                    # auto (default): in parallel only when the agent says it can start subagents
  max_parallel: 8   # how many steps may be worked at once (1-64); the others wait their turn
  claim_ttl_s: 900  # how long a worker's hold on its step lasts unless it renews it (1-86400)
```

The engine still checks every step itself; a worker's hold only keeps two workers off one step.

## Repository

See [AGENTS.md](AGENTS.md) for the layout and contribution rules.

## License

Apache-2.0. See [LICENSE](LICENSE).
