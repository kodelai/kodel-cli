# Run formats: what happens to a run when kodel is updated

A run keeps the format of its stored data (the `v` of `state.json` and of the journal records) from
its start to its end. When you update kodel in the middle of a session, a run that was going goes on:
the new kodel reads and writes it in the format it started with, so the old MCP process that is still
open, the new MCP after a restart and any `kodel` command all work on the same run. A new run starts in
the newest format. `kodel status`, `report` and the history read every run, finished ones too.

There is nothing to migrate for this. The one thing that changes a run's format is a command a person
runs on purpose (below).

## What a run of format 1 cannot do

Format 1 (every run written before forks: the early builds, the published `0.1.0-beta.0`, `main` until
the fork merge) has room for one step at a time, one pause, and no worker claims. When such a run is
asked for something it has no place for, kodel refuses **before anything is written** with
`UNSUPPORTED_FORMAT_FEATURE` and the run stays as it was:

- a pipeline with a fork and a `join` proposed or accepted into it (`pipeline_propose_change`,
  `kodel pipeline changes apply`);
- a second pause, a fork attribution, a worker's claim on a step (`pipeline_take_step` answers that
  there is no step to take).

The answer tells the agent to offer you the way up. The agent does not run it, and you may decline it:
the run then goes on with these limits.

A run of format 1 also keeps the behaviour its engine had where it differed: it does not keep a
declared outcome after a failed check (a recheck then ends as the old engine's did), it reads two edges
for one label as the first one winning, and the stale-result rule uses the version of the run. Every
other fix since applies to every run.

New text always meets today's rules: two edges for one label with no `join` stay an error in a pipeline
file, in a proposal and in a change you apply. Only a pipeline already kept with an old run is read the
old way.

## The name of a session

Kodel journals the name of the agent's session next to its id: the field `session_name` in the `executor` of
`run_started`, `step_served` and `agent_completed`, and the event `agent_session_named` (see
`docs/history.md`). Neither decides a step, and nothing is rewritten:

- A run of format 1 is unchanged. Format 1 has no place for the event (`sessionNames` is false for it, and the
  copy of the agent's log does not offer it); the field in `executor` is written to its records as to any other.
- A run of format 2 that was going when kodel was updated gets names from then on, one event per named session on
  the first pass of the copy of the agent's log. Records already written are not rewritten.
- An older kodel that works on the same run ignores the event and the field. It counts the event as a sign of
  life, so a run whose agent is stuck, in a session that is renamed, looks alive to it. If it rewrites the
  `agentLog` of the state it drops the hashes of the names, and the newer kodel journals a name again.

## Limits that a newer kodel cannot lift in an older one

If an older kodel (a session you have not restarted, a `kodel` older on your `PATH`) works on the same
run:

- It refuses a project config with a key it does not know. `main` before forks refuses `agents:`; the
  published beta also refuses `decisions`, `history`, `prompts`, `executor`, `tool_log`, `storage` and
  `project_id`. In a project that uses one of them the older kodel cannot start at all.
- The beta does not see runs kept with `storage: home` and keeps its trusted hashes by path, not by
  project id.
- Neither older kodel retries a lock another process holds: on Windows a call can fail once with
  `EPERM` while the newer one holds it (the state is untouched; try again), and the rename of
  `state.json` can fail while the older process has it open.
- After the newer kodel starts a run of the newest format for a pipeline and task, the older
  `pipeline_start` for that same pair throws instead of starting a run.
- An older `kodel wait` that watches a run that was upgraded is not told what happened.
- An older process that writes back a state it kept in memory after the run was upgraded leaves a run
  the new kodel refuses to read (it says the state is written in an older format than its journal records); finish such a run with the
  kodel that has it open, or upgrade first and close the older session.
- The beta may not read a run after a newer kodel has written it: its shape has grown since.

These are known and are not tested in CI. A run from before pipelines were kept in versions
(`meta.json` format 1) is read and listed, but no kodel except the one that started it can continue it;
it still blocks `pipeline_start` for its task until it is finished.

## The way up

`kodel migrate <run>` (in a terminal, by a person) takes a run that is going to the newest format. It
is one way: the older kodel will not read the run afterwards. Close every older session on the run
first, including one waiting at a gate or in the middle of an agent step, which send no heartbeat.
After it the run can fork and claim like any new run, and its old snapshots still read as before. The
agent is told to offer it and never runs it.

## Pipelines written with `format:`

The key was renamed to `version` before the first runs this repository keeps (`format: 1` is now a
generic unknown-key error). Accepting both keys in pipeline files, with an error when they differ, is
proposed in a follow-up task. No kept pipeline of a supported run uses `format:`, so the reader of kept
pipelines does not accept it.

## Tool calls (TASK-ZKRH)

The record of the agent's tool calls adds an optional `toolCalls` key to `state.json`, two journal events
(`tool_calls_recorded`, `tool_calls_failed`) and `tool_calls` to `run_started.history`, in format 1 and in
format 2 alike (the codec of format 1 keeps them as it keeps `usage`). A run that was going when kodel was
updated has no `tool_calls` in its frozen history, so it reads `not_captured` and goes on as before; a run
started after the update records tool calls. A kodel from before the update refuses a project config that has
`history.tool_calls` (the `history` section is strict). It reads and goes on with a run of format 2 that holds `toolCalls`
and its events (the codec of format 2 keeps what it does not know): it ignores them and leaves the state key as it was, so
the cursor lags and a newer kodel catches up later. A run of format 1 never holds them in practice, since new runs start in
format 2 and a run that was going has no `history.tool_calls`; an older codec of format 1 would refuse them as "cannot
read". Nothing here needs `kodel migrate`.

## Engine steps (TASK-NNR3, T-42)

Format 2 is amended in place, with no new version (rule 5): the state gains an optional `engineSession`
key, the open record of a step that runs as a session (`docs/engines.md`). It is absent for every run
without engine steps, so such a run writes the same bytes as before. No published build wrote format 2.

- A new journal event, `engine_session_started` (`node`, `attempt`, `name`, `id`, `launch`), in format 2
  only. Format 1 has no place for it or for the key: an engine step in such a run is refused with
  `UNSUPPORTED_FORMAT_FEATURE`, and the answer offers `kodel migrate`.
  A host that joins a session whose id was never written (it found it by name) writes the event with
  `launch: "unknown"`: it did not build the launch, so it has no hash of it.
- `run_resumed` may carry `session` (the session a resume cleared), and `node_finished.source` may be
  `session` (an attempt whose outcome is unknown).
- A run in flight is unaffected: it has no engine step, and none can be added while engine steps are off.
- A dev build from before this change says "was modified" for a run whose pipeline has an engine step. A
  build with this change says "upgrade kodel" for a kept copy whose hash matches but which has a field it
  does not know.
- The refusal of an engine step no longer guards a run whose engine node was removed by an accepted change
  after a resume.

Golden fixture: `fixtures/formats/v2-engine/`, a real run with an engine step.

## Worker notes (TASK-G8KM, T-44)

`kodel serve` (`docs/serve.md`) journals the event `worker_note` when a background worker of a run is gone
(`what: gone`, `worker`, `id?`, `reason`: `lost`, `killed`, `exited` or `not_started`, `exit_code?`, `at?`; see
`docs/history.md`). It decides no step, the state has no new field, and nothing is rewritten:

- A run of format 2 gets the event from now on, a run that was going when kodel was updated too. Records
  already written are not rewritten. Format 2 is amended in place, with no new version (rule 5): an engine of
  format 2 that does not know the event reads it, writes it back and decides as if it were absent, and an
  older engine that writes the run back drops nothing, since the journal is only appended to.
- A run of format 1 is unchanged. Format 1 has no place for the event (`workerNotes` is false for it): the note
  is a quiet no-op, not a refusal, so nothing offers `kodel migrate` for it, and the daemon logs the death
  instead.
- An older kodel that works on the same run ignores the event. It counts it as a sign of life, so its TUI may
  date the wait of a run by it.

Golden fixture: `fixtures/formats/v2-worker/`, two runs with a note. The engine, the host
(`LocalPipelineHost`) and the daemon (`createServeDaemon`) that wrote them were real; the launcher was the
`ScriptedLauncher` of `@kodel-ai/testkit`, so no agent process ran (`fixtures/formats/README.md`).

## The `serve` block

The project config gains a `serve` block (`docs/serve.md`); the config `version` is not bumped. A kodel from
before this change refuses the whole config while the block is there (`unknown key: serve`, "upgrade kodel or
remove the key"), so in a project that uses it an older kodel cannot start at all. An MCP server that was
already running when kodel was updated does not read the config again and does not mark the tasks its agent
makes (`docs/tasks.md`): restart the agents' sessions after the update. The four task keys the mark adds are
optional and kept by an older kodel as they are.

## Terminal workers (TASK-EKAV, T-47)

No run format changes: the state, the journal and the kept pipelines are as before.

- **The project config** gains `engines.<name>.worker` and `engines.<name>.terminal` (`docs/engines.md`), and a
  profile's step `command` becomes optional; the config `version` is not bumped. Present configs load
  unchanged. A kodel from before this change refuses a config that has the new keys (`unknown key: …`), as it
  does for `serve`. With the key absent a worker is now a terminal session; `docs/changes.md` has the one line
  that keeps print workers.
- **The session records** (format 1, not frozen) gain a record file, `agent.json`, and the name marker of a
  resumed session moves to the new record (`docs/session-formats.md`). No change of `v`: a build that does
  not know the file derives the same status, lists and removes the session.
- **The record of `kodel serve`** (format 1) gains the optional `counts.alive`; `counts.workers` keeps its
  meaning, so an older TUI or `--status` reads it right. No change of `v`.
- **A run in flight at the update.** A `claude -p` worker that is alive is listed and resumed by the old
  rule. One that already exited at its gate has no `agent.json`: the id of its conversation is read from the
  argv its record keeps (which the launcher wrote), so it is resumed after your decision and keeps its
  `max_runs` place until then. The resumed session runs as the setting says now (`terminal` when the key is
  absent; Claude Code continues a conversation across the two); where that cannot run the resume is refused
  with the reason, makes no record and counts as a failed attempt.
- **An older kodel beside a newer one.** An older daemon or TUI sees a terminal worker at a gate as a running
  worker (it holds a `max_workers` place for it and may call it stalled) and a `lost` one as dead. Use one
  build for the daemon, the TUI and the workers of a checkout.

Fixtures: `fixtures/session-formats/v1/` (`agent-chosen.json`, `agent-resumed.json`, and
`worker-print-before-t47/`, the record of a print worker taken from the launcher and the holder of the build
before this change), `fixtures/serve-formats/v1/serve-alive.json`.

## Task links (TASK-9RZD, T-45, T-46)

No run format, journal, session record or serve record changes. The task files of the `local` adapter gain
two optional keys of format 1, `depends_on` and `conflicts_with` (`docs/tasks.md`); `v` stays 1 and a file
without them reads as before. After the update:

- a run in flight goes on as it was; a task without links is started and ordered as before (with the `local`
  adapter the order is the same: priority, then `created_at`, then the key);
- the task tools gain parameters (`TASK_TOOLS_VERSION` 2): an MCP server that was already running does not
  offer them until the agent's session is restarted;
- **a kodel from before this change ignores the links.** It keeps both keys when it rewrites a task file (at
  the end of the file) and its `kodel serve` starts a task that a newer one would hold back. Update every
  kodel that runs `kodel serve` on the repository before you rely on the links.

## A step that asks for a model (T-43)

A node `model:` without `engine` asks the agent that drives the run to give the step to a subagent on that
model (a worker, in a fork worked in parallel). It is a field of the pipeline file and stores nothing by
itself: the model asked for is read from the pipeline kept with the run (`specs/<hash>.yaml`) when the
report is built.

- A run of format 1 refuses a pipeline that has such a step, in a proposal, an accepted change and a run's
  own change (`UNSUPPORTED_FORMAT_FEATURE`, and the answer offers `kodel migrate`), the way it refuses an
  engine step: the kept copy would be a pipeline the engine that wrote the run cannot read. It is the
  pipeline feature `model` of format 2.
- A run in flight is unaffected: no pipeline written before can hold the field without `engine`.
- An older kodel, including the published beta, refuses such a pipeline as one it cannot parse; a dev build
  from before this change says "was modified" for a run whose kept pipeline has the field.
- For a step that a fork's worker did, a later change adds one optional field to the journal event
  `agent_completed` (`worker_models`, see `docs/history.md`, "Requested and observed model"); that change
  is made in place in format 2 too.

## The role of the server (TASK-5M9D)

`kodel mcp` can be started with a role (`docs/mcp-roles.md`), and a run records which server was behind it:
`run_started.engine.role`, and `executor.role` on `run_started`, `step_served` and `agent_completed`, are
`worker`, `manager`, or `all` for a server started with no role. A gate or a pipeline change an agent decided
through a manager's server carries `decided_via: manager` beside `decided_by: agent`. All of it is in journal
records only: `state.json` has no new key.

- Format 2 is amended in place, with no new version (rule 5). No decision of the run reads these keys: `decide()`
  works from the state, and the journal is only appended to. An engine of format 2 that ignores them decides
  every step the same way, and an older engine that goes on with the run never rewrites a journal line, so it
  cannot drop a key and the newer engine decides the same after it. The capability is `executorRole`.
- A run in flight is unaffected: its records already written are not rewritten, and the ones written from now
  on carry the role. A run started before the update reports the roles of its later steps only.
- A run of format 1 records no role (`executorRole` is false for it): the host leaves the key out, the run
  goes on as before, and `status` and `report` show no role for it. The encoder of format 1 refuses the key,
  so it cannot be written there by mistake. Nothing offers `kodel migrate` for it.
- `decided_via` is read by `kodel serve` and the TUI, not by the run: after a decision made through a manager
  the run's worker is resumed, as after a person's decision. An older kodel that does not know the key reads
  the decision as an agent's own and does not resume the worker; continue such a run with any agent.
- A run worked by servers of two roles may journal one more `step_served` for a step: the record is deduped by
  what the agent was shown, and a text that differs by role is another record. That is bookkeeping of the
  history; it counts toward the cap on served records, and when the cap is reached records stop, steps do not.
- `engine.tools_hash` has new values: it now covers the role, `--read-only`, the read-only mark of each tool
  and the final set with the task tools. `engine.contract_version` is 7 (6 is the attachment tools, T-45).
- Was format 2 published? The registry lists `@kodel-ai/kodel` `0.1.0-beta.0` (2026-10-25, `latest`) and
  `0.1.0-beta.1` (2026-10-28, `beta`), asked on 2026-11-22. Which of them wrote format 2 was not established
  from the registry, and the amendment does not depend on it: the argument above holds for a published format
  too.

Golden fixture: `fixtures/formats/v2-roles/`, two runs made by real `kodel mcp` servers (one with no role, one
with `--role worker`), one finished and one open (`scripts/take-v2-roles-fixture.mjs`).
`fixtures/formats/v2-manager/` holds `decided_via`: three open runs made by real servers with `decisions.agent`
on, a gate and a pipeline change decided through a `--role manager` server and a gate decided by an agent
where the run is worked (`scripts/take-v2-manager-fixture.mjs`).

Release note, on its own line because it was found while planning and not asked for: `pipeline_next_step` is
now listed with `readOnlyHint: false`. It restarts engine work whose owner is gone and records what the agent
was shown, so it is not served by a `--read-only` server; a client that approves read-only tools by itself
will ask for it.

## Attachments (T-45)

A step can keep files with the run (`docs/attachments.md`). Each stored version is one journal event,
`attachment_written` (`node`, `attempt`, `name`, `version`, `ref`, `type`, `bytes`, `lines?`, `sha256`,
`scanned`, `redacted?`, `claim?`, and the fork fields of the visit when the step is in a fork); the files are in the run's `attachments/` folder. The state has no new field: like
every event, a write advances `state.seq` and nothing else, and the bounds and the history of a name are
read from the journal.

- A run of format 2 takes the event from now on, a run that was going when kodel was updated too. Format 2
  is amended in place, with no new version (rule 5): an engine of format 2 that does not know the event
  decides every step the same way, and has nothing to drop when it writes the run back.
- A run of format 1 refuses the write before a file or a record is made (`UNSUPPORTED_FORMAT_FEATURE`, and
  the answer offers `kodel migrate`), and refuses a pipeline with an `attachment` check in a proposal, an
  accepted change and an edit of the file: it is the pipeline feature `attachment` of format 2.
  `kodel migrate` leaves the `attachments/` folder alone.
- **An older build of format 2 lacks the protection, not the run.** A kodel from before this change lists
  no attachments and approves a gate without comparing them with what the person saw. It decides every
  step as before; what it lacks is a check that did not exist when it was built. No published build writes
  format 2, so this is a dev session that was not restarted after the update: restart it.
- An older kodel that reads a run whose kept pipeline has the `attachment` check says the pipeline was
  written by a newer kodel ("upgrade kodel"), never that it was modified.

Golden fixture: `fixtures/formats/v2-attachment/`, one run with two versions of a text, a PNG and the check
(`fixtures/formats/README.md`).

## Who canceled a run, and why (NE3N)

A cancel ends a run with the `run_finished` record it always had, `status: canceled`. The record now
also keeps who canceled it and why: `reason` (it existed already, and is now filled), and for a cancel an
agent made on the person's instruction `decided_by: agent` and `instruction`, plus `decided_via: manager`
in format 2. Nothing is new in the state, and no event is new.

- A run of format 2 keeps the fields from now on, a run that was going when kodel was updated too. Format 2
  is amended in place, with no new version (rule 5): the fields decide nothing, so an engine that does not
  know them decides every step the same way, and one that drops them leaves the run `canceled`.
- A run of format 1 keeps `reason`, `decided_by` and `instruction` as well (its journal holds the fields
  of a record as given, as it already did for an agent's gate decision); `decided_via` has no place there.
- A cancel of a run that has completed or failed now answers `RUN_FINISHED` instead of a quiet success; it
  still writes nothing, for a run of either format.

Tested on the golden runs `fixtures/formats/v1-cancel/` (a run of format 1 canceled through a manager's
server: it stays format 1, with no `decided_via`) and `fixtures/formats/v2-cancel/` (a run of format 2
canceled through a manager's server, and one canceled by the person), made by the real engine with
`bun scripts/take-cancel-fixtures.mjs`: each opens, is written back as it was read, reports the agent's cancel
in `agent_decisions`, and reads as `canceled` with the new fields taken out of its `run_finished`.

## How a run was started, and who stopped its agent (manager_start_task, manager_stop_agent)

`run_started` may carry `origin: {by, via, agent_instruction?, forced?}`: `by` is `person` or `agent`, `via` is `tui`,
`web`, `cli` or `manager` (a closed list: a new path, such as Kodel Server, adds a value in its own change), `forced`
lists the warnings the start went ahead of (`full`, `blocked`, `conflict`) as the engine found them, and
`agent_instruction` is what the agent says the person told it (at most 2000 characters, redacted like any text). The
path that made the call sets `by` and `via`, never a tool's argument: `pipeline_start` takes no such field, and a run
started by `kodel serve` or by `pipeline_start` has none ("not one of these paths"). `origin` names a kind and never a
person or a device, so `history.executor: false` does not turn it off (`docs/history.md`). A second journal event,
`agent_stopped` (`by: agent`, `via: manager`, `agent_instruction?` at most 500 characters, redacted), says that an agent
stopped the run's agent through a manager's server; it is not written for a run that has ended.

- Format 2 is amended in place, with no new version (rule 5). The state has no new key. Neither the field nor the event
  is read by any decision of the run: an engine of format 2 that ignores them decides every step the same way, and an
  older engine that goes on with the run only appends to the journal, so it cannot drop either. The capabilities are
  `origin` and `agentStops`.
- A run in flight is unaffected: its records already written are not rewritten, and a run that was going when kodel was
  updated has no `origin` (it was started before there was one). It takes `agent_stopped` from then on.
- A run of format 1 holds neither (`origin` and `agentStops` are false for it). The encoder of format 1 refuses a
  `run_started` with `origin` and the event, with `UNSUPPORTED_FORMAT_FEATURE`; in practice a new run is always format 2,
  so the host never writes one there, and the event is a quiet no-op, not a refusal: nothing offers `kodel migrate`.
- A build from before this change reads such a run: the codec of format 2 keeps what it does not know, so it ignores the
  field and the event and writes the journal back as it was. It does not know `agent_stopped` is not a sign of life
  (it is left out for `worker_note`), so its TUI may date a wait by it.

Golden fixture: `fixtures/formats/v2-origin/`, two runs made by a real `LocalPipelineHost` (`scripts/take-v2-origin-fixture.mjs`):
one started as an agent through a manager (with `forced` and the agent's words, and an `agent_stopped`), left open, and one
started by a person at the TUI and finished. The session record has its own note: `startedBy` and the `via` of a stop
(`docs/session-formats.md`).

## When the formats change again

A change of a stored format ships a codec for the previous one, a real fixture and the tests, and
says here what a run in flight does (AGENTS.md, "Stored data and compatibility", rule 5).
