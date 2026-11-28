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
  and `project_id` keys, which say where the history is kept (`docs/history.md`), the `serve` block, which
  says what `kodel serve` starts on its own (`docs/serve.md`), the `mcp` block, which says which tools each
  role of the server serves (`docs/mcp-roles.md`), and the `engines` block, which says which
  programs kodel starts as agents and how (`docs/engines.md`; a start nobody watches uses it only as committed).
- Do not edit the files in `.kodel/pipelines/` while a run is going. To change the pipeline of a run, ask
  the person whether to change it now, and then use `pipeline_propose_change`; the run stops at the end of
  its current step until the person accepts the change. A pipeline file edited by hand is noticed all the
  same and waits for the person in the same way, but the tool is the way to do it.
- To add a pipeline, or to change one outside a run, use `pipeline_propose_change` without `run_id`; never
  write into `.kodel/pipelines/` yourself. The proposal waits in `.kodel/proposals/` (with `storage: home`, in the
  project's folder under `~/.kodel`; do not edit it) until the person accepts it.
- Do not run `gate`, `ack`, `seal`, `resume`, `migrate`, `run cancel`, `pipeline changes apply|discard|restore`,
  `pipeline proposals apply|discard`, `task approve`, `web pair|revoke`, `web token add|revoke` or
  `agent stop|rm|exec|forget-name|attach|start|prune`: they
  refuse to run without a terminal; the web UI's pairing and token commands ask for no confirmation, and of the
  others all but three ask for a confirmation before they change anything (`agent
  exec`, which starts a command as an agent, and `agent attach`, which connects a person's terminal to an agent that
  runs in one of its own, ask for none; `agent start`, which starts the coding agent in a terminal of its own, asks
  only when the `engines` block is not the committed one; `agent prune` asks nothing when it removes nothing: with
  `--dry-run`, or with no finished agent to remove), so trying them only fails.
  `agent ls`, `agent logs` and `agent doctor` (whether a background agent can start here) only read and are yours.
- Do not run `kodel serve` (it refuses under `KODEL_ENGINE`, but not in your own shell): the person starts it. A
  task you create or change with the `task_*` tools is not started by it until the person runs
  `kodel task approve <key>`: tell them so. That approval limits only what the daemon starts on its own: a person
  starts a task by hand (`s` in the TUI, Start in the web UI) without it, and so can a manager whose config has
  `decisions.agent.start_task` (`manager_start_task`, never past `force` unless the person said so).
- `kodel wait <run>` is yours: it only watches and prints one line when the person has decided, so start it
  in the background (Claude Code: the Bash tool with `run_in_background`) when an answer offers it (a
  `waiting` answer, or a `node` or `running` answer whose text names it because a decision waits besides),
  end your turn, and call `pipeline_next_step` when it reports. Never poll `pipeline_next_step` in a loop to
  wait for a person. If it says `still waiting` it gave up (`--timeout`, 8 hours by default): do not start it
  again, tell the person you stopped watching. A project can turn the offer off with
  `agent_hints: { wait: false }` in the project config; then no answer mentions `kodel wait`, and you just
  end your turn and wait to be told.
- A pipeline may fork: a `node` answer then lists every open step in `steps`, and `execution.mode` says how
  this project works them. In `parallel` mode start one subagent (a fork worker) per step that has no `taken_by`
  and give it these rules: call `pipeline_take_step` with the run id and its step's slug and keep the
  `claim_token`; if the answer is `taken` (another worker holds it), `queued` (the project's
  `agents.max_parallel` steps are already being worked) or `none` (no free step), stop and report that
  answer back without doing anything; do the step where its `workdir` says; call
  `pipeline_complete_step` with `node_slug`, `attempt` and that `claim_token`; report the answer back to the
  agent that started you as it is (one of `node`, `waiting`, `running` or `done`, with the `also_waiting` list
  it may carry), never write to the person, and never start `kodel wait` as a fork worker. In `sequential` mode
  do the steps one by one, without taking them, unless its instruction says the project lets you work
  them in parallel (`agents.subagents: auto`): then, if you can start subagents, call `pipeline_next_step`
  again with `subagents: {can: true}` to have them handed out to workers. When the workers are back, call `pipeline_next_step`
  yourself; what waits for a person (`also_waiting` names every gate and pause) is for you to tell them,
  with the command of each (`--node <slug>` when several wait).
- Two things are called a worker; keep them apart. A **fork worker** is the subagent of a fork (the rules
  above): it lives inside your session, reports to you and never starts `kodel wait`. A **background agent**
  is the agent of a whole run that kodel itself started (`s` in `kodel tui`, `kodel serve`, `kodel agent start
  --pipeline`), the session `kw-<run>` of `kodel agent ls`. If you are one, you are the driver of your run:
  at a `waiting` answer you tell what waits, start the wait command exactly as the answer spells it (in the
  background) and end your turn, whatever `agent_hints.wait` says for other agents, and you go on when it
  reports. You cannot decide: your server serves no decision tool, and the person's commands refuse inside
  your session (`docs/decisions.md`).

A step may keep a file with the run instead of in the project (a plan, a screenshot) with
`pipeline_attachment_write`; a pipeline can require one with an `attachment` check, and the person sees
them at a gate beside the changed files (`docs/attachments.md`). An image is stored as given, not scanned
for secrets: never put a secret in one.

Tasks (`docs/tasks.md`) are off unless `.kodel/config.yaml` has `tasks: { enabled: true }`; when they are on the
server also offers the `task_*` tools. When the user asks you to "create a task" for something you should not
fix now, use `task_create` (after one `task_schema`) and tell the user the key; change a status only when
asked. Do not edit the files in `.kodel/tasks/` by hand: the tools keep their format and their keys.

The server has roles (`docs/mcp-roles.md`): `kodel mcp --role worker` serves the tools a run is worked with,
`--role manager` the tools for looking after the runs (the history, the tasks, `manager_inbox` and the other
`manager_*` reads, the decision tools when the config allows them, and the two actions `manager_start_task` and
`manager_stop_agent` when the keys `start_task` and `stop_agent` of `decisions.agent` are on; a manager with `start_task`
starts a task without `task approve`, and with `force` past the limits and the task's links, so pass `force` only when the
person said so in the chat), `--read-only` only the tools that write
nothing, and no flag every tool. Under `KODEL_ENGINE` a server with no role is a worker. A worker has no history
tool and no `task_update`: it does not change a task's status, and when a run ends for a task the engine does
not close, it tells the person the task is still open. An agent is told only of the tools its server serves; do
not look for the others.

Humans: `bun packages/cli/src/main.ts status` lists runs, `report` shows where the time went, `wait <run>` stays
until a run stops waiting for a person (see above); the same
binary has `gate`, `resume`, `ack`, `seal`, `migrate` (takes a run to the newest stored format, one way), and `pipeline changes` (`show`, `apply`, `discard`, `history`,
`restore`) for a change of the pipeline of a run that is going, and `pipeline proposals` (`show`, `apply`,
`discard`) for a pipeline the agent proposed outside a run, and `serve`, a daemon that starts matching tasks in
background agents and resumes them after a decision, by the `serve` block of the project config
(`docs/serve.md`; off by default). A background agent runs in a terminal of its own by default (`kodel agent attach kw-<run>`, or `o` in `kodel tui`, opens it and `Ctrl+\` leaves it running; the committed
line `engines: { claude: { worker: print } }` keeps `claude -p`), and `agent start`, `agent prune` and `agent doctor` start one by hand, remove
the finished ones and say whether one can start here. With `decisions: { dialog: true }` in the project
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
- `packages/cli` (`kodel`): the CLI, built to a single JS file (`dist/kodel.js`), including human-only commands (`gate`, `resume`, `ack`, `seal`, `migrate`, `run cancel`, `pipeline changes apply|discard|restore`, `pipeline proposals apply|discard`, `task approve`, `web pair|revoke`, `web token add|revoke`, `agent stop|rm|exec|forget-name|attach|start|prune`). It also holds the client of `agent attach` and the loader of the one native module (`@lydell/node-pty`, an optional dependency, loaded only by the holder of a terminal session).
- `packages/testkit` (`@kodel-ai/testkit`, private): scripted and adversarial fake agents, fixture helpers.
- `adapters/`: per-agent pieces (MCP config writers, deny rules, driver prompts). `skills/`: agent-facing skills.
- `tests/e2e`, `tests/agents`: end-to-end and real-agent scenarios. `tests/pty`: terminal sessions against the built artifact on a real PTY; they skip, with a printed reason, where none can be opened (`KODEL_REQUIRE_PTY=1` makes a skip a failure). `fixtures/formats/`: golden fixtures per format version.

The engine is meant to be shared with Kodel Server: the server implements the same adapter interfaces
(state store on Postgres, runners as executors) and registers its own node and check kinds.

## Principles

1. **Agent input is untrusted.** The engine, not the agent, decides whether a step is done.
2. **Fail closed.** Missing or invalid results never close a step.
3. **Redact at every write path.** Nothing reaches history without going through `redact`. The one exception is an image a step keeps with the run: it cannot be redacted, so it is stored as given and marked `not scanned for secrets` everywhere it is listed (`docs/attachments.md`).
4. **The engine knows nothing about transport or I/O.** Keep `@kodel-ai/pipeline-core` free of MCP, CLI, `node:fs`, `node:child_process` and clock access; those come in through adapters.
5. **Side effects behind traits** (clock, filesystem, process execution) so tests can fake them.
6. **Humans decide trust.** Trust, gate decisions, `ack`, `seal`, cancelling a run (`kodel run cancel`) and accepting a change of a run's pipeline, or a new or changed pipeline outside a run, are never available as agent-callable MCP tools. The agent may propose (`pipeline_propose_change`); only a person's command puts it in place. The one exception is a project that turns it on in its config (`decisions.agent`, off by default, never for `ack`; a cancel only on a manager's server, `decisions.agent.cancel_run`): the server's instructions then say when the agent may decide, and the journal marks it (`docs/decisions.md`).
7. **Node kinds and check kinds are adapters.** Handlers sit behind traits and are registered by `kind`; the engine never matches on concrete kinds, so a plugin system can be added later without engine changes.
8. **Formats are versioned** (`version` cascade for user files, `v` on every machine-written record). Never rewrite history on disk: the journal is the history and is only appended to; `state.json` is the run's current state and is written in the format the run lives in (a run keeps the format it started with; `kodel migrate` is the one change of it, made by a person).

## Stored data and compatibility

Two kinds of format, with different rules:

- **User-written files** (pipelines, project config) carry `version`. A new engine may reject an old
  `version`, but only with a message that names the version and says what to do.
- **Stored data** (run state, the journal, the pipeline snapshot kept with each run, reports) is
  history. It stays readable by every later engine. The **journal** is only appended to; the **state**
  of a run is its current state and is rewritten as the run goes on, but always in the format the run
  started with.

A run is **pinned to the format it started with** (`state.v`). Every stored format has one codec in
`@kodel-ai/pipeline-core` (`formats/`): `decode` turns what the format stores into the model of the
engine, `encode` turns the model back (an allow-list: it writes every field or refuses, and nothing is
dropped), and `capabilities` says what the format can hold and which behaviours it keeps. The engine
reads and writes each run through the codec of its format; a new run starts in the current format.
`decide()` returns the encoded state and records, or a refusal, so a store writes what it is given and
a model is never written under the wrong `v`. What a format cannot hold (format 1 has no forks, no
claims and one pause) is refused **before anything is written** with `UNSUPPORTED_FORMAT_FEATURE`, and
the answer tells the agent to offer the person `kodel migrate <run>`; the agent never runs it.

For stored data:

1. A change that renames, removes or retypes a stored field ships, in the same change, a **reader and a
   writer** for the previous format (its codec), and a golden fixture of a real old run in
   `fixtures/formats/v<N>/` (or `v<N>-<tag>/`) with tests that open it (`status`, `report`), write it
   back as it was read, and let an open one go on in its own format.
2. A pipeline snapshot kept with a run is parsed by the rules of the format it was written in, never by
   the current user-file parser alone: the format is the `v` of the first journal line that names its
   hash (`run_started`, `pipeline_accepted`). A rule tightened for new files must keep the old rule for
   the snapshots written before it, so it cannot make an old run unreadable; new text always meets the
   current rules.
3. "Cannot read", "unsupported" and "was modified" are different errors. A run written in a format this
   engine does not know says so ("written by a newer kodel, upgrade kodel"); a state that does not fit
   its format is "cannot read" and names the field; only a hash mismatch says it was modified.
4. Before the first release, a format that no published version wrote and no supported run uses may
   break freely. Format 1 is written by the published beta and by the runs in flight, so it is
   supported. A run from before pipelines were kept in versions (`meta.json` format 1) is read and
   listed but cannot be continued by any engine. At the first release, freeze what exists.
5. **A change of a stored format says what it does, in the same change:** it ships `decode`, `encode`,
   `capabilities`, a real fixture and the round-trip test (a fixture directory for every codec, a key
   table the compiler keeps complete for every field of the model and every journal event; the tests
   `t41_registry_matches_fixture_directories` and `t41_model_and_event_key_tables_are_complete` fail
   otherwise). A new field is a compatible addition only if an engine of the same version that ignores
   it decides every step the same way **and** an older engine that writes the run back and drops it
   leaves the newer engine deciding the same way; otherwise the version is bumped. A `decode` is never
   removed; an `encode` only by an explicit decision after the first release. The release note
   (`docs/run-formats.md`) says what a run in flight does after the change.

A run of format 1 keeps the behaviour its engine had where the codec says so (it keeps no `Visit.spec`,
it does not keep a declared outcome after a failed check, it reads two equal edges as one); every
other fix since applies to every run. The limits that a new engine cannot lift in an older one are in
`docs/run-formats.md`.

**Session records** (`<state base>/run/`, the processes `kodel agent` runs) are machine-local state, not history. Their
format follows rules 1-5: a `v` on every record, one codec each (`decode`, `encode`) in
`pipeline-core/src/sessions/`, a golden fixture taken from a real holder in `fixtures/session-formats/`, a newer `v`
refused with "upgrade kodel"; a `decode` is never removed once a published version has written the format. They
differ from history in one way: records may be removed (`kodel agent rm`), but the name marker a session leaves
stays until a person frees it (a session a person started at the command line frees its name with its folder). Unlike the run codecs (an allow-list that refuses an unknown field), the `decode` of
this family ignores unknown optional fields of a known `v`, because builds of different age write one directory;
after the format is declared frozen every new field bumps `v`. Session errors are `SessionError` with
`SESSION_ERROR_CODES`, outside the MCP error contract. The `t41_*` tests do not cover this family; its own tests do
(`docs/session-formats.md`).

The **record of `kodel serve`** (`<state base>/serve/<uid>/<checkout key>.json`) is machine-local state of the same
kind: it follows rules 1-5 like the session records, with a `v` on the record, one codec in
`pipeline-core/src/serve/record.ts` and fixtures in `fixtures/serve-formats/`; its `decode` ignores unknown optional
fields of a known `v` and refuses a newer `v` with "upgrade kodel" (`docs/serve.md`).

Decision T-41 (a run keeps its format; `kodel migrate` is the person's way up) is refuted if a user
outside this repository reports a run of a supported format refused, orphaned or changed by an update.

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

(These are the commands CI runs on Linux and macOS. A separate `pty` job on Linux and macOS installs the
packed CLI and runs the terminal-session checks on a real PTY with `KODEL_REQUIRE_PTY=1`: `bun test` in a sandbox
or under Bun alone skips them.)

## Git

- Sign off commits (`git commit -s`): the project uses the Developer Certificate of Origin.
- Never push to `main` directly; use pull requests.
