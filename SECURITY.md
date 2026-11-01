# Security policy

Kodel is in beta and is maintained by a small team, so a reply may take a while. Only the latest
release is supported; fixes ship as a new release.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability.

- Use [private vulnerability reporting](https://github.com/kodelai/kodel-cli/security/advisories/new)
  on GitHub, or
- write to dev@kodel.ai.

Include the Kodel version (`kodel --version`), the coding agent and the operating system, the steps to
reproduce, what you expected and what happened. Please do not send real secrets.

We will confirm that we received the report and keep you informed. Please give us a reasonable time to
fix the problem before you share the details publicly.

## What counts as a vulnerability

Kodel treats everything an agent sends as untrusted and lets only a person decide what to trust. A
report is in scope if it shows that:

- an agent can do what only a person may do: a gate decision, `ack`, `seal`, accepting a change of a
  pipeline, or trust;
- a check passes on a missing or invalid result (the engine must fail closed);
- a secret reaches the run history or a report without going through redaction;
- Kodel reads or writes outside the repository or the run's worktree, for example through a path or a
  symbolic link;
- a command can be injected through a pipeline, the config, a run name or an agent's answer;
- a hook of a coding agent runs or reveals more than it is meant to.

## What does not

- The commands of a pipeline you accepted. They run by design: people decide what to trust.
- Bugs in a coding agent or in the MCP SDK. Please report them to their projects.
- A vulnerability in a dependency without a way to reach it through Kodel.
- What an agent does inside the permissions you gave it.
