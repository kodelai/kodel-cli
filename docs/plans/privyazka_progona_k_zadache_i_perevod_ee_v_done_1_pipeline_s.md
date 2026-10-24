# Link a run to a task and close the task when the run is done

## Goal

Today a run and a task are tied only by hand (`task_create` with `run`, `task_update` with `add_run`),
and the agent changes a status only when asked. This change lets `pipeline_start` take a task, ties the
run to it, moves the task to `progress`, and moves it to `done` when the run completes. The person picks
how much the engine does by itself.

Decisions taken with the person (all in the task text):

1. `pipeline_start` gets an optional `task` (a task key). It exists only when tasks are enabled, the
   mode is not `disabled`, and the adapter has `capabilities.runs !== "none"`.
2. On start the engine calls `add_run` and moves the task to state `progress`. On `run_finished` with
   status `completed` it moves the task to state `done` with a comment that names the run. A run that
   fails or is canceled leaves the status alone and only adds a comment.
3. Config: `tasks.on_run.mode` is `auto` (default) | `ask` | `disabled`.
   - `auto`: link, `progress` at start, `done` at the end.
   - `ask`: link and `progress` at start; the end is not automatic. The `done` answer of
     `pipeline_next_step` carries a hint that tells the agent to ask the person and then call `task_update`.
   - `disabled`: the engine does nothing; `pipeline_start` has no `task`/`restart_task`.
4. A task already in state `done` makes `pipeline_start` with `task` fail with `TASK_ALREADY_DONE`
   (names the task, its status and its runs, says to ask the person). `restart_task: true` moves the task
   back to `progress`, attaches the new run, comments "restarted by run …". Earlier runs stay attached.
   A `declined` task is not blocked (the `local` adapter's `declined` is state `done`, so this needs
   the status name: see Risks). `disabled` does not check.
5. The logic lives in `pipeline-core` behind the task adapter interface (no fs, no transport). A failing
   task adapter never stops the run: a warning goes to the journal and into the answer to the agent.
6. Server instructions and `docs/tasks.md` are updated in the same change.

## Where it goes (affected files)

The run can end by three different routes: the agent's `pipeline_complete_step` (MCP), a person's
`kodel gate` / `resume` / cancel (CLI), and the engine's own ticks. All of them pass through one place:
`apply()` in `packages/local/src/host.ts` (the branch that computes `finished`, around line 888). The
close hook must be there, not in `PipelineService`, otherwise a run finished by `kodel gate approve`
would never close its task.

`pipeline-core`:
- `src/run-task.ts` (new): the pure rules. `RunTaskLink` interface (the host's side:
  `onStart`, `onEnd`), `TaskOnRunMode`, `planStart(task, mode, restart)` returning what to do
  (`proceed` | `restart` | `fail TASK_ALREADY_DONE`), `endAction(mode, runStatus)` returning
  `close` | `comment` | `hint` | `none`. No I/O.
- `src/task-service.ts`: `linkRun(key, runId, {restart})`, `finishRun(key, runId, status)`; both use the
  existing timeout, redaction and capability checks; they map state to the tracker's status through
  `schema()` (a status whose `state` is `progress` / `done`), never by name. If the schema offers
  several, take the one the adapter marks default, else the first and say so in the comment.
- `src/errors.ts`: new code `TASK_ALREADY_DONE` (and a message that names task, status, runs).
- `src/service.ts`: `start` takes `task` and `restart_task`, passes them to `host.start`; the answer
  carries `task: {key, status, linked: true}` and `task_warning` when the adapter failed.
  `PipelineHost.start` input gets `task?: string` and `restart_task?: boolean`.
- `src/mcp/tools.ts`: `pipeline_start` shape gets `task` and `restart_task` only when the server was
  built with the task link (as the task tools are built by capability today); text of `restart_task`
  says: do not set it yourself, ask the person first. `SERVER_INSTRUCTIONS` / `TASK_INSTRUCTIONS`
  (`src/mcp/task-tools.ts`): rule 4 is rewritten: "a task tied to a run is moved by the engine
  (mode auto) or after you ask the person (mode ask)".
- `src/next-step.ts`: the `done` answer gets the `tell_the_person`/hint line for mode `ask`.
- `src/run.ts`: `RunState` gets an optional `task?: string` (the key). It is additive and optional, so
  the format `v: 1` stays and old runs read as without a task; no migration needed (stored-data rule 1
  covers rename, remove and retype only). A golden fixture of a run with `task` is added anyway under
  `fixtures/formats/` and opened by the existing format test, so the field is covered.
- `src/report.ts`, CLI `status`: show the key and a "restarted from done" mark.

`local`:
- `src/config.ts`: `tasks.on_run: { mode }`, strict, default `auto`; a bad mode is a config error naming
  the three values.
- `src/pipeline-host.ts` (`start`, line ~435): calls `RunTaskLink.onStart` before the worktree is made
  (so `TASK_ALREADY_DONE` leaves nothing behind, as the title check does), stores `task` in the state.
- `src/host.ts` `apply()`: after the seal is written, if `finished` and the state has `task`, call
  `RunTaskLink.onEnd(task, runId, status)`; the result (warning or hint) is journaled as
  `task_link` records (new record kind, with `v`). The call is made after the state is on disk and its
  failure is caught: closing the task must not change the run.
- `src/tasks/index.ts`: `openTaskService` also returns the `RunTaskLink` built on `TaskService`.

`cli`:
- `src/mcp-server.ts`, `src/cli.ts`: pass the link to the host and to `createServer`; `kodel status`
  and `report` print the task.
- `kodel task` gets no new command; `kodel task list --run` already filters.

Docs: `docs/tasks.md` (config `on_run`, the three modes, `restart_task`, what the agent is told),
a short line in `docs/` for the run side if one exists. English only.

## Steps

1. Tests first, named by decision id (see below); they fail.
2. Core rules (`run-task.ts`), `TASK_ALREADY_DONE`, `TaskService.linkRun/finishRun`.
3. Config `on_run`, host wiring in `pipeline-host.ts` and `host.ts`, `RunState.task`.
4. `pipeline_start` parameters, instructions, `next-step` hint, report/status output.
5. Docs, golden fixture, `bun run typecheck && bun run lint && bun test && bun run build && node scripts/check-artifact.mjs`.

## Test strategy

Names carry the decision ids; the ids of the new decisions are added to the local decision log by the
person (none exist yet for this change), so the tests use the short names below until they are assigned.

- `run_task_auto_links_and_sets_progress_at_start`
- `run_task_auto_closes_task_when_run_completes`
- `run_task_auto_closes_when_person_approves_the_last_gate_in_cli` (the route that does not pass MCP)
- `run_task_failed_or_canceled_run_only_comments`
- `run_task_ask_links_at_start_and_hints_at_done_without_closing`
- `run_task_disabled_has_no_task_parameter_and_touches_nothing`
- `run_task_param_absent_when_adapter_has_no_runs_or_tasks_are_off`
- `run_task_start_without_task_changes_nothing`
- `run_task_already_done_fails_and_leaves_no_worktree_branch_or_run`
- `run_task_restart_task_moves_back_to_progress_and_keeps_old_runs`
- `run_task_declined_is_not_blocked` and `run_task_disabled_skips_done_check`
- `run_task_adapter_failure_does_not_stop_start_or_end` (timeout, throw; warning in journal and answer)
- `run_task_state_chosen_by_state_not_by_status_name` (a fake adapter with other status names)
- `run_task_old_run_without_task_field_reads_with_current_engine` (golden fixture)
- `run_task_comment_is_redacted` (principle 3; the run title and task text can hold a secret)
- CLI: config `on_run.mode: bogus` is refused with the three values named.

Fakes: a scripted `TaskAdapter` (the testkit already has task fixtures in `packages/local/test/tasks.test.ts`
style) and the existing fake clock; no network.

## Risks and open points

- **`declined` is `done` by state** (decision 2 of the tasks plan). "Not blocked" therefore needs the
  status name: the check blocks only a task whose state is `done` and whose status is not one the schema
  marks as a decline. The schema has no such mark today. Proposal: block every `done`-state task for
  now and say so in the docs; revisit when the schema gets a "resolution" notion. This differs from the
  wording in the task and the person should confirm it.
- **Where the run ends.** Hooking `apply()` fixes the gate/CLI route but runs the adapter inside the
  per-run lock. The call has the adapter timeout (30 s default); if it must not hold the lock, queue it
  and run it right after the lock is released. Prefer the second form.
- **Crash between state write and task call**: the run is sealed, the task is still `progress`. Accept it
  and add a `kodel task doctor` line listing `progress` tasks whose run is finished; do not retry
  forever from the engine.
- **Trust (principle 6).** Moving a task is not a trust decision, so an automatic move is allowed. But
  `restart_task` is a flag the agent can set; the rule not to set it alone is text, not a lock. The
  start answer and `report` mark the restart so a person sees it. If that is not enough, make the
  restart a human-only `kodel` command and drop the flag; the person decides.
- **Stored data.** `RunState.task` is new and optional (compatible). New journal record kind
  `task_link` must be skipped, not rejected, by older readers: check the reader's unknown-kind path
  and add a test.
- **Adapters without runs** (`runs: "none"`): `task` is not offered; with mode `auto` and no support the
  server starts and says on stderr that the link is off.
- **Two runs for one task at once**: allowed; the task closes when the first completes. Alternative:
  close only when no other attached run is active. Not in scope; note it in the docs.
