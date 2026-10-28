# Kodel

Spec-driven pipelines that run inside the coding agent you already use, and are checked outside of it.

[![npm](https://img.shields.io/npm/v/@kodel-ai/kodel?include_prereleases)](https://www.npmjs.com/package/@kodel-ai/kodel)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

> **Status: beta.** Formats and commands may still change before 1.0. The full documentation is not
> written yet; until then this README and [AGENTS.md](AGENTS.md) are the entry points.

## Quick start

Requirement: Node >= 22.19. Kodel works with Claude Code, Codex and OpenCode (see
[adapters](adapters/README.md) for what is checked on a real agent).

**1. Install.** The agents' hooks call `kodel-hook`, so install globally rather than using `npx`.

```bash
npm install -g @kodel-ai/kodel
```

**2. Set up your repository.** In the repository you want to work on:

```bash
kodel init
```

It adds the MCP server, the `/kodel-design` and `/kodel-run` skills, the config and the hooks for the
agents it finds. It asks before it writes; `--dry-run` shows what would change. Other options:
`--agent claude-code,codex,opencode`, `--tasks` for the optional task tracker, `--no-hooks`.

**3. Create a pipeline.** Restart your agent so it picks up the MCP server, then ask it to design one:

```text
/kodel-design
```

The agent looks at your project and proposes a pipeline: the steps, what is checked after each one,
and where you decide. The proposal waits for you. Read it and accept it in a terminal:

```bash
kodel pipeline proposals show
kodel pipeline proposals apply <name>
```

**4. Run it.** Give the agent a task:

```text
/kodel-run fix the login timeout
```

The agent works through the steps, and the engine checks each result. When a run needs you, the agent
says what to look at and which command to decide with:

```bash
kodel status              # list the runs, or show one
kodel gate approve <run>  # decide the human step a run is waiting at (or: gate reject)
kodel report <run>        # where the time went and what was redone
```

An example of a full pipeline, with a plan, two human gates, a review and tests, is
[`examples/pipelines/feature.yaml`](examples/pipelines/feature.yaml).

## Commands for people

These ask for confirmation and refuse to run without a terminal, on purpose: an agent can propose,
only a person decides.

| Command | What it does |
| --- | --- |
| `kodel init` | Set the project up for your coding agents. |
| `kodel status [run]` | List the runs, or show one. |
| `kodel wait <run>` | Stay until a run stops waiting for a person, print one line, exit. It changes nothing. |
| `kodel gate approve\|reject <run>` | Decide the human step a run is waiting at. |
| `kodel resume <run>` | Carry on a paused run, with more attempts for the step that stopped it. |
| `kodel ack <run>` | Accept the state of a run after you changed it by hand. |
| `kodel seal <run>` | Accept the files of a finished run after a deliberate change. |
| `kodel report [run]` | Where the time went and what was redone in a run. |
| `kodel pipeline changes ...` | Review a change to the pipeline of a run that is going. |
| `kodel pipeline proposals ...` | Review a pipeline the agent proposed outside a run. |
| `kodel task ...` | The tasks of this repository (off until `tasks.enabled` is set). |
| `kodel feedback [text]` | Send a bug report, an idea or a note to the Kodel developers. |

Run `kodel <command> --help` for the options.

## Tasks

Optional, and off by default. When on, the agent can write down what it finds on the way ("create a
task for that bug"), you can ask what is left, and a tracker such as Jira can sit behind the same
interface. See [docs/tasks.md](docs/tasks.md).

## How it is built

A Bun workspace in TypeScript, shipped as a single JavaScript file that runs on plain Node.

| Package | Role |
| --- | --- |
| `packages/pipeline-core` | The pure engine: pipeline spec, result checks, run state machine, redaction, and the MCP tool definitions. No file system, process or clock access. |
| `packages/local` | Local adapters: file state store, process executor, git snapshots, clock, local tasks. |
| `packages/cli` | The `kodel` command, including the human-only commands. |
| `packages/testkit` | Scripted and adversarial fake agents and fixtures (private). |

The engine knows nothing about transport or I/O, and node and check kinds are registered by `kind`.
That is what lets a server backend implement the same adapter interfaces later. The principles
behind this (untrusted agent input, fail-closed, redaction on every write, humans decide trust) are in
[AGENTS.md](AGENTS.md). How Kodel reads the logs of your agent sessions is in
[docs/history.md](docs/history.md).

## Contributing

To work on Kodel itself you need [Bun](https://bun.sh) as well as Node. `bun run build` produces
`packages/cli/dist/kodel.js`, the same file that is published.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build && node scripts/check-artifact.mjs
```

CI runs the same on Linux, macOS and Windows. Sign off your commits (`git commit -s`): the project uses
the Developer Certificate of Origin. Open a pull request, never push to `main`. Everything committed,
including comments and commit messages, is in English. Read [AGENTS.md](AGENTS.md) before you start:
it also says what an AI agent may and may not do in this repository.

## License

Apache-2.0. See [LICENSE](LICENSE).
