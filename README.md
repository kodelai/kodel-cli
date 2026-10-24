# Kodel

Spec-driven pipelines that run inside the coding agent you already use, and are checked outside of it.

> **Status: early development.** Nothing is released yet and the package is not on npm. The
> English documentation will be written once the first working version exists; until then this
> README and [AGENTS.md](AGENTS.md) are the entry points.

Coding agents are good at doing a step and bad at knowing when it is really done. Kodel is a local
[MCP](https://modelcontextprotocol.io) server that holds the process: you describe how you work as a
pipeline file in your repository, the agent walks through it with `pipeline_*` tools, and the engine,
not the agent, decides whether each step passed.

## Why Kodel

- **The agent's word is not enough.** Every step result is validated by the engine: the diff touched
  only the files it should, the build and tests pass, the review has no blocking findings. A missing or
  invalid result never closes a step (fail-closed).
- **A person decides what matters.** Approvals, rejections and changes to the pipeline itself are
  commands you run in a terminal. They are not MCP tools, so an agent cannot approve its own work.
- **The process lives in your repository.** The pipeline is a YAML file you review like code, and the
  history of every run is kept next to it, so you can see where time went and what was redone.
- **It improves.** Run history is analyzed to propose changes to the pipeline, which you accept or not.
- **No new agent to adopt.** Claude Code, Codex and OpenCode talk to the same server (see
  [adapters](adapters/README.md) for what is checked on a real agent and what is not yet).

Kodel is not a replacement for your agent, a hosted service, or a CI system. It is the layer between
"the agent says it is done" and "it really is".

## How it looks

A pipeline is a graph of nodes. A node is something the agent does (`agent`), something the engine
runs (`command`), or a decision that waits for you (`human`). `checks` verify the result of a node, and
`edges` say where to go next, including back to an earlier step with the reason for the failure.

```yaml
version: 1
name: feature
nodes:
  - slug: plan
    kind: agent
    prompt: |
      Task: {{task}}
      Write an implementation plan to docs/plans/{{task.slug}}.md. Change no other file.
    checks:
      - { kind: diff, paths: ["docs/plans/{{task.slug}}.md"], mode: changed_only }
  - { slug: plan-approval, kind: human, prompt: "Approve the plan or reject it with a reason." }
  - slug: impl
    kind: agent
    prompt: "Implement the approved plan. Add or update tests."
    checks:
      - { kind: diff, paths: ["packages/**", "tests/**"], max_lines: 800 }
  - { slug: test, kind: command, command: "bun test" }
edges:
  - { from: plan,          to: plan-approval }
  - { from: plan-approval, to: impl, when: approved }
  - { from: plan-approval, to: plan, when: rejected }
  - { from: impl,          to: test }
  - { from: test,          to: impl, when: failed }
```

The full reference pipeline, with a review step, an e2e run and a manual test, is
[`examples/pipelines/feature.yaml`](examples/pipelines/feature.yaml).

You start a run from your agent in plain words ("fix the login timeout through the pipeline"), or with
the `/kodel-run` skill. The agent then asks the server for the next step, does it, reports it, and
repeats. When a run needs you, the agent tells you what to look at and the command to decide with.

## Quick start

Requirements: Node >= 22.19 to run, [Bun](https://bun.sh) to build from source.

```bash
git clone <this repository> && cd etude
bun install --frozen-lockfile
bun run build
```

Make `kodel` and `kodel-hook` (both in `packages/cli/dist/`) available on your `PATH`, for example with
`npm link` inside `packages/cli`. Then, in the repository you want to work on:

```bash
kodel init          # MCP server, the /kodel-run skill, config and hooks for the agents found here
```

`kodel init` asks before it writes, and `--dry-run` shows what would change. It supports
`--agent claude-code,codex,opencode`, `--tasks` for the optional task tracker, and `--no-hooks`.

Restart your agent so it picks up the new MCP server, put a pipeline in `.kodel/pipelines/`, and ask:

```text
/kodel-run fix the login timeout
```

The agent starts the run and works through the steps. You stay in control from a terminal:

```bash
kodel status              # list the runs, or show one
kodel gate approve <run>  # decide the human step a run is waiting at (or: gate reject)
kodel report <run>        # where the time went and what was redone
```

A new pipeline is not written by hand into `.kodel/pipelines/`. Ask the agent to propose it
(`pipeline_propose_change`), then accept it with `kodel pipeline proposals apply`.

## Commands for people

These ask for confirmation and refuse to run without a terminal, on purpose.

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
