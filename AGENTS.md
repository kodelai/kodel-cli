# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## What this is

Kodel is an open-source (Apache-2.0) local MCP engine that runs spec-driven pipelines inside
the coding agent a developer already uses. The engine validates every step result outside the
agent (fail-closed), keeps a run history in the repository, and analyzes that history to
propose improvements to the pipeline. It is built so that a server backend (Kodel Server)
can later sit behind the same contract.

Documents: until the first working version exists, the specifications are Russian working notes
(product notes, decision log, MCP contract, architecture, MVP plan) kept locally in the git-ignored
`notes/` folder; they are not part of the repository. Comments and issues refer to decisions by id
(`T-12`, `T-37`, ...) from the decision log. English documentation in `docs/` will be written from
those notes once the first working version is done. Reference pipeline: `examples/pipelines/feature.yaml`.

## Running a pipeline on this repository

`.mcp.json` starts the `kodel` MCP server from source (`bun packages/cli/src/main.ts mcp`), and
`.kodel/pipelines/dev.yaml` is the pipeline. When the user asks for a change "through the pipeline",
work only through the `pipeline_*` tools: the server's own instructions (sent when it connects) say how.

This repository adds these rules:

- Do not edit `.mcp.json` or `.claude/settings*.json` (the person decides how the server starts and what
  the agent may do). The same goes for the `decisions` block of the project config: it says what the
  agent may decide for the person (`docs/decisions.md`), so only the person changes it. So do the `storage`
  and `project_id` keys, which say where the history is kept (`docs/history.md`).
- Do not edit the files in `.kodel/pipelines/` while a run is going. To change the pipeline of a run, ask
  the person whether to change it now, and then use `pipeline_propose_change`; the run stops at the end of
  its current step until the person accepts the change. A pipeline file edited by hand is noticed all the
  same and waits for the person in the same way, but the tool is the way to do it.
- To add a pipeline, or to change one outside a run, use `pipeline_propose_change` without `run_id`; never
  write into `.kodel/pipelines/` yourself. The proposal waits in `.kodel/proposals/` (with `storage: home`, in the
  project's folder under `~/.kodel`; do not edit it) until the person accepts it.
- Do not run `gate`, `ack`, `seal`, `resume`, `pipeline changes apply|discard|restore` or
  `pipeline proposals apply|discard`: they refuse to run without a terminal and ask for a confirmation, so
  trying them only fails.
- `kodel wait <run>` is yours: it only watches and prints one line when the person has decided, so start it
  in the background (Claude Code: the Bash tool with `run_in_background`) when an answer offers it (a
  `waiting` answer, or a `node` or `running` answer whose text names it because a decision waits besides),
  end your turn, and call `pipeline_next_step` when it reports. Never poll `pipeline_next_step` in a loop to
  wait for a person. If it says `still waiting` it gave up (`--timeout`, 8 hours by default): do not start it
  again, tell the person you stopped watching. A project can turn the offer off with
  `agent_hints: { wait: false }` in the project config; then no answer mentions `kodel wait`, and you just
  end your turn and wait to be told.
- A pipeline may fork: a `node` answer then lists every open step in `steps`, and `execution.mode` says how
  this project works them. In `parallel` mode start one subagent (a worker) per step that has no `taken_by`
  and give it these rules: call `pipeline_take_step` with the run id and its step's slug and keep the
  `claim_token`; if the answer is `taken` (another worker holds it), `queued` (the project's
  `agents.max_parallel` steps are already being worked) or `none` (no free step), stop and report that
  answer back without doing anything; do the step where its `workdir` says; call
  `pipeline_complete_step` with `node_slug`, `attempt` and that `claim_token`; report the answer back to the
  agent that started you as it is (one of `node`, `waiting`, `running` or `done`, with the `also_waiting` list
  it may carry), never write to the person, and never start `kodel wait` as a worker. In `sequential` mode
  do the steps one by one, without taking them, unless its instruction says the project lets you work
  them in parallel (`agents.subagents: auto`): then, if you can start subagents, call `pipeline_next_step`
  again with `subagents: {can: true}` to have them handed out to workers. When the workers are back, call `pipeline_next_step`
  yourself; what waits for a person (`also_waiting` names every gate and pause) is for you to tell them,
  with the command of each (`--node <slug>` when several wait).

Tasks (`docs/tasks.md`) are off unless `.kodel/config.yaml` has `tasks: { enabled: true }`; when they are on the
server also offers the `task_*` tools. When the user asks you to "create a task" for something you should not
fix now, use `task_create` (after one `task_schema`) and tell the user the key; change a status only when
asked. Do not edit the files in `.kodel/tasks/` by hand: the tools keep their format and their keys.

Humans: `bun packages/cli/src/main.ts status` lists runs, `report` shows where the time went, `wait <run>` stays
until a run stops waiting for a person (see above); the same
binary has `gate`, `resume`, `ack`, `seal`, and `pipeline changes` (`show`, `apply`, `discard`, `history`,
`restore`) for a change of the pipeline of a run that is going, and `pipeline proposals` (`show`, `apply`,
`discard`) for a pipeline the agent proposed outside a run. With `decisions: { dialog: true }` in the project
config (off by default), a client that can show a form (MCP elicitation) is also asked there at a gate, a
pause, a change of the pipeline of a run and a state changed outside kodel, and the person's answer in that
dialog is the same decision as the command; the commands stay the way to decide when the dialog is off, the
client has none or the person did not answer in it. A dialog stays open 10 minutes at most;
`KODEL_DIALOG_TIMEOUT_S` in the server's environment (`.mcp.json`) changes that for a client that gives up
on a call sooner.

## Permission to write code

**Do not write or change code until the person has explicitly allowed it.** A request to "add X", an
answer to a question you asked, or a discussion of a design is not that permission. When the task is
unclear or the person says "let's discuss first", discuss: propose, ask, wait. Start only after a clear
go-ahead ("go", "implement it", "do it"). Reading the code and answering questions need no permission.

## Language

- **All code comments, doc comments, documentation, commit messages, PR descriptions, error
  messages, log messages and identifiers are written in English.** No exceptions for new work.
- Conversation with the user may be in the user's language; files are not.
- Everything that is committed is in English. The local, git-ignored `notes/` folder holds the
  Russian working notes and must not be committed.

## Layout

Bun workspace (TypeScript, ESM). Runtime target: Node >= 22.19; Bun is the development toolchain.

- `packages/pipeline-core` (`@kodel-ai/pipeline-core`): pure engine (pipeline spec, result checks, run state machine, routing, redaction, error codes, format versions), the `PipelineService` and the adapter interfaces. It also holds the task adapter contract (`tasks.ts`) and the `TaskService`; the `task_*` tools (`mcp/task-tools.ts`) exist only when the config turns tasks on. No file system, process, network or clock access. The subpath `@kodel-ai/pipeline-core/mcp` holds the MCP tool definitions bound to the service (it depends on the MCP SDK; the main entry does not import it). Transport-free: the CLI adds stdio, the server adds HTTP and auth.
- `packages/local` (`@kodel-ai/local`): local adapters (file state store, process executor, git snapshots, system clock, the `local` task adapter that keeps one YAML file per task in `.kodel/tasks/`).
- `packages/cli` (`kodel`): the CLI, built to a single JS file (`dist/kodel.js`), including human-only commands (`gate`, `resume`, `ack`, `seal`, `pipeline changes apply|discard|restore`, `pipeline proposals apply|discard`).
- `packages/testkit` (`@kodel-ai/testkit`, private): scripted and adversarial fake agents, fixture helpers.
- `adapters/`: per-agent pieces (MCP config writers, deny rules, driver prompts). `skills/`: agent-facing skills.
- `tests/e2e`, `tests/agents`: end-to-end and real-agent scenarios. `fixtures/formats/`: golden fixtures per format version.

The engine is meant to be shared with Kodel Server: the server implements the same adapter interfaces
(state store on Postgres, runners as executors) and registers its own node and check kinds.

## Principles

1. **Agent input is untrusted.** The engine, not the agent, decides whether a step is done.
2. **Fail closed.** Missing or invalid results never close a step.
3. **Redact at every write path.** Nothing reaches history without going through `redact`.
4. **The engine knows nothing about transport or I/O.** Keep `@kodel-ai/pipeline-core` free of MCP, CLI, `node:fs`, `node:child_process` and clock access; those come in through adapters.
5. **Side effects behind traits** (clock, filesystem, process execution) so tests can fake them.
6. **Humans decide trust.** Trust, gate decisions, `ack`, `seal` and accepting a change of a run's pipeline, or a new or changed pipeline outside a run, are never available as agent-callable MCP tools. The agent may propose (`pipeline_propose_change`); only a person's command puts it in place. The one exception is a project that turns it on in its config (`decisions.agent`, off by default, never for `ack`): the server's instructions then say when the agent may decide, and the journal marks it (`docs/decisions.md`).
7. **Node kinds and check kinds are adapters.** Handlers sit behind traits and are registered by `kind`; the engine never matches on concrete kinds, so a plugin system can be added later without engine changes.
8. **Formats are versioned** (`version` cascade for user files, `v` on every machine-written record). Never rewrite history on disk.

## Stored data and compatibility

Two kinds of format, with different rules:

- **User-written files** (pipelines, project config) carry `version`. A new engine may reject an old
  `version`, but only with a message that names the version and says what to do.
- **Stored data** (run state, journal, the pipeline snapshot kept with each run, reports) is history.
  It stays readable by every later engine, and it is never edited to make that true.

For stored data:

1. A change that renames, removes or retypes a stored field ships, in the same change, a reader for the
   previous format that migrates **in memory on read**, and a golden fixture of a real old run in
   `fixtures/formats/v<N>/` with a test that opens it with the current engine (`status`, `report`).
2. A pipeline snapshot kept with a run is parsed by the reader of the format it was written in, never by
   the current user-file parser. A user-file rule (a field removed, a stricter check) must not make an
   old run unreadable.
3. "Cannot read" and "was modified" are different errors. A run written in a format this engine does not
   know says so ("written in format X, upgrade or migrate"); only a hash mismatch says it was modified.
4. Before the first release, formats may break freely. At the first release, freeze what exists as v1:
   add the golden fixtures above for it, and from then on rules 1-3 apply to every change.

One exception was made under rule 4, before the first release (decision T-40, forks in the run
engine): run-state format 1 (`state.json` and the journal records with `v: 1`, written by
`@kodel-ai/kodel@0.1.0-beta.0` and earlier; a beta is pre-release) was replaced by format 2 without
a reader. The engine refuses a format-1 run with `UNSUPPORTED_FORMAT`, names the format and says to
finish it with the kodel that started it. A run nobody wants to finish can be left as it is: it is
refused, the run lists and `findLatest` pass it over, and it only blocks `pipeline_start` for the same
pipeline and task (the refusal names the run and says it must be finished before a new run starts for
that task). kodel has no command that cancels a run. The engine never guesses from the shape and never calls
such a run modified, and `fixtures/formats/v1/` keeps the real runs that prove the refusal. The
decision is refuted if a user outside this repository reports history lost to it.

## Decisions and tests

Every decision recorded in the decision log (local notes, referred to by id) has a test plan and a refutation criterion.
A decision is implemented only when its tests exist and pass. Test names carry the decision id
(for example `t12_format_cascade_defaults_to_v1`). If a test shows a decision does not hold,
revisit the decision instead of bending the test.

## Conventions

- TypeScript in strict mode (`noUncheckedIndexedAccess`), ESM only, no `any`. Validate external input with `zod` (v3, aligned with Kodel Server). Biome formats and lints.
- The shipped artifact must run on plain Node, not only under Bun: CI runs `scripts/check-artifact.mjs` against the built file.
- Errors: `KodelError` with a stable string code (see the error codes in the MCP contract); tools return `{ok:false, code, message}` rather than throwing.
- Keep dependencies minimal and justify each new one in the PR description. Licenses must be compatible with Apache-2.0.
- Keep comments rare and about *why*, not *what*. Match the style of the surrounding code.

## Commands

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build && node scripts/check-artifact.mjs
```

(These are the commands CI runs on Linux, macOS and Windows.)

## Git

- Sign off commits (`git commit -s`): the project uses the Developer Certificate of Origin.
- Never push to `main` directly; use pull requests.
