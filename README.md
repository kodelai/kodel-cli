# Kodel

Spec-driven pipelines for solo developers, running inside the coding agent you already use.

> Status: early development. Nothing here is released yet, and the documentation will be
> written once the first working version exists.

## Idea

- Describe *how you work* as a reusable pipeline file that lives in your repository.
- Your agent (Claude Code, Codex, OpenCode, ...) drives the run through MCP tools.
- Every step result is validated outside the agent, so "done" is verifiable.
- Run history stays in the repository (`.kodel/runs`) or, with `storage: home` in the config, under
  `~/.kodel/projects/<id>` ([where the history is kept](docs/history.md#where-the-history-is-kept)), and is analyzed to
  suggest improvements to the pipeline.
- Optional [tasks](docs/tasks.md): the agent writes down what it finds on the way ("create a task for
  that bug"), you ask what is left, and a tracker such as Jira can sit behind the same interface.

## Repository

See [AGENTS.md](AGENTS.md) for the layout and contribution rules.

## License

Apache-2.0. See [LICENSE](LICENSE).
