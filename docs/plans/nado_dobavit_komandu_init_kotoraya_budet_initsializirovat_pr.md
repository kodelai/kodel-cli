# Plan: `kodel init`

## Goal

Add `kodel init`, which sets a project up for the coding agents that will run its pipelines. It must:

- find the supported agents and ask the person which to set up (interactive), or take them from a flag (direct);
- connect the `kodel` MCP server to each chosen agent;
- add or update skills (this change ships only the place in the code where skills are kept; no skill yet);
- create `.kodel/config.yaml`;
- ask one yes/no question, whether to turn the local task tracker on (`--tasks` answers it in direct mode).

Out of scope: hooks and plugins, instructions in `AGENTS.md` / `CLAUDE.md`, and deny rules. The last two were
in the first version of this plan and were left out at the final gate: the person could not tell what their
questions meant, and working without them is not critical (the server already tells the agent how to use it, and
the commands that decide are checked for a terminal). They can come back with a clear explanation of their value.

Priority is Claude Code; Codex and OpenCode are written to their documented formats and reported as "not checked
on the real agent yet". The server command written into the agents' config is `kodel mcp` by default. `init` is not
a person-only command (unlike `gate`, `ack`, `seal`, `resume`): it only adds, so it also runs from scripts and CI.

## Decisions already taken with the person

- Default server command `kodel mcp` (`--server-command` overrides it, e.g. for this repository).
- Skills: only the registry and the installer now; the skills themselves later.
- The task tracker question reads: "Turn on the local task tracker? It lets the agent or the CLI create tasks in
  the project so that nothing important is lost." The question about the agents stays as it is.

## Affected files

- `packages/cli/src/init/files.ts` (new): idempotent edits that report `created | updated | unchanged | skipped`:
  JSON merge (a file that is not plain JSON, or has a value of the wrong type, is left alone), managed text
  blocks between marker lines, a hash stamp for installed files.
- `packages/cli/src/init/agents.ts` (new): one adapter per agent: detection (binary in PATH, marker files),
  `connect`, skills directory.
  - claude-code: `.mcp.json`, `enabledMcpjsonServers` and `allow: mcp__kodel` in `.claude/settings.json`;
    skills in `.claude/skills`.
  - codex: managed block in `.codex/config.toml`; skills in `.agents/skills`.
  - opencode: `opencode.json` (`opencode.jsonc` is only reported); skills in `.opencode/skills`.
  - A `kodel` server entry the person set up differently is kept unless `--force`.
- `packages/cli/src/init/skills.ts` (new): `SKILLS` registry (empty), embedded as text like `agent-docs`; the installer
  replaces only a copy that kodel wrote and nobody edited (hash check), `--force` overrides.
- `packages/cli/src/init/index.ts` (new): `runInit`: choose agents, ask about the task tracker, run the steps, print
  one line per file (a file touched by two steps is reported once); `--dry-run` writes nothing.
- `packages/cli/src/cli.ts`: the `init` command and its flags (`--agent`, `--yes`, `--tasks`, `--server-command`,
  `--force`, `--dry-run`); `CliEnv` gets `select(question, choices)`.
- `packages/cli/src/main.ts`: a readline implementation of `select` (numbers, Enter for the defaults, `none`).
- `packages/cli/test/init.test.ts` (new); `cli.test.ts` and `tasks.test.ts` get a `select` in their fake env.
- `adapters/README.md`, `skills/README.md`: say where the code lives and how to add a skill.

## Steps

1. File helpers with their tests (merge keeps the person's lines, second run changes nothing).
2. Agent adapters and detection.
3. Skills registry and installer.
4. `runInit` (agents question, task tracker question, report) and the `init` command; `select` in `main.ts`.
5. `.gitignore` entries for `/.kodel/runs` and `/.kodel/worktrees`; `.kodel/config.yaml` is created only when absent.
6. Docs in the two READMEs.

## Test strategy

Tests use a temporary directory and the fake env. Cases:

- Claude Code gets the server, the permission and the config.
- A second run changes nothing (all agents on).
- The person's JSON keys, deny rules and `.gitignore` lines stay.
- A JSON file with comments, a wrong-typed value, a hand-written Codex server and an existing config are left alone.
- A server entry set up differently is kept, and replaced with `--force`.
- `--dry-run` writes nothing; no terminal: found agents are taken, none found is an error; unknown agent is refused.
- Interactive: the agents question with its defaults, then the task tracker question; `--tasks` and `--yes` ask nothing.
- Skills: install, update, edited copy kept, copy that kodel did not write kept, `--force`.
- `bun run typecheck`, `bun run lint`, `bun test`, `bun run build && bun run check:artifact`.

## Risks

- Codex and OpenCode formats are written from their documentation and not tried on the real agents; the command
  says so, and only Claude Code is claimed as checked.
- `settings.json` is shared: the permission for the `kodel` server affects the whole team.
- Windows: the server command `kodel mcp` may need a `cmd /c` wrapper in Claude Code; not handled now.
