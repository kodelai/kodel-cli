# Task links (`depends_on`, `conflicts_with`), readiness and the base order of `kodel serve` (TASK-9RZD)

## TL;DR

- **What:** a task may name tasks it waits for (`depends_on`) and tasks it must not run beside
  (`conflicts_with`). `kodel serve` starts no task whose dependency is open, or closed by an agent and not
  approved by you, or whose conflicting task has an open run; the others go in a computed order. The tools,
  `kodel task`, `--status` and the TUI show and edit the links; `s` in the TUI still starts a blocked task
  after a one-line warning.
- **Cost:** about 6 working days. New pure code in `pipeline-core/src/schedule/`; `serve/plan.ts` changes in
  about 40 lines. Task files gain two optional keys, `v` stays 1; no run, session or config format change.
- **Risky:** (1) a kodel older than this change ignores the links: an older install on the same repository
  **starts a blocked task** (decision 1). (2) An agent can still close a dependency by running a pipeline
  for it (decision 4). (3) TASK-EKAV edits `serve/plan.ts`, `serve/daemon.ts` and the TUI at the same time
  and took the test id `t45_` (decisions 6 and 8). (4) `depends_on` orders starts, not code.
- **What the critique changed:** a dependency an agent closed blocks until you approve it; an agent's
  removal of a link marks every loosened task **before** any file loses the link; the daemon's "declined"
  comment is cut (decision 3); tasks that wait for approval do not move the order; a bad link stops one
  task, not the project; no folder lock, no new error code.

## Decisions needed

Each has a default that is taken if you do not answer. 1-5 change what the product does; 6-11 are process.

1. **`v` of the task file; older builds are fail-open.** The two keys are optional keys of `v: 1`. An older
   kodel reads such a file, ignores the keys, keeps them on a write-back (moved to the end of the file) and
   **its daemon starts a blocked task**: against principle 2 in the older build, and not a "compatible
   addition" by the wording of stored-data rule 5. The daemon on your machine is not the risk (it exits with
   75 when the build on disk changes, `daemon.ts:959`); a teammate's older install, another checkout and an
   old MCP server are. A (**recommended, default**): keep `v: 1` and say it in the docs, as the approval
   mark did (the published beta already makes tasks without the mark, `docs/tasks.md:180-182`; the links
   get the same stated limit). B: write
   `v: 2` on a file that has a link: an older kodel reports that file as a problem, cannot show or change
   the task, and its daemon starts **nothing** in the project while one such file exists. Fail closed, at
   the price that one linked task stops every older build.
2. **What an agent's link change costs (the approval mark).** A (**recommended, default**): any change of
   the links of task T through the task tools marks T (`agent_edited_at`, so T waits for `kodel task
   approve`); removing a conflict T-U marks U too, whichever file holds it, because U is loosened as well.
   Adding a conflict or a dependency never marks the other task (it is only restricted, and its approval is
   not taken away by a call that did not name it). B: mark only on removal (an agent can then add
   `X depends_on A` to an approved X and reorder A without you). C: links never touch the mark.
3. **The daemon's comment on a dependent whose dependency was declined** (the task asks for it). The review
   found eight edge cases in it (it would lift a give-up, duplicate after a restart, bump `updated_at` under
   a `task approve`, ...). A (**recommended, default**): **cut it**. A declined dependency is shown where
   the person looks: `task show`, the card and `--status` say `TASK-X (declined)` beside the dependency, and
   the daemon logs one line when it starts the dependent. No daemon comment exists besides the give-up, so
   none can lift it. B: keep the comment, with these rules: written only for a `todo` task that a rule
   matches and that is ready; never while the task's latest comment is the daemon's give-up (so it is never
   newer than one); the mark in memory is set after the write, so a failed write is tried again; skipped
   when the text is among the last 20 comments. Accepted then: a duplicate after a restart on a task with
   more than 20 newer comments; no second comment after a re-decline.
4. **A dependency closed by a run an agent started.** An agent may call `pipeline_start` with a
   `task_key` (`mcp/tools.ts:504-507`); when that run completes, the engine closes the task with no mark
   (`run-task.ts:106-113`), and a dependent may start. The close is the engine's verdict (the pipeline's
   checks and gates passed), not the agent's word, but the agent chose to run it. A (**recommended,
   default**): accepted, and said in `docs/serve.md` and in T-45's criterion: "a dependency is released by
   your approval or by a completed run of it". B: a run's close releases dependents only when `kodel
   serve` or the TUI started the run (the starter has to be read from the run: about half a day more, and
   a run you asked an agent to start then needs `task approve` before its dependents go).
5. **Scope.** A (**recommended, default**): all in one run, one merge. If it proves too large, cut in this
   order, each a line in the hand-in: the `BLOCKED` column of `kodel task list`; opening a linked task from
   the card (the keys stay as text); the reasons in the `--status` queues (the order stays). Not cut:
   readiness, the order, the marks, doctor, the TUI warning. B: two runs, (a) model, adapter, tools, CLI,
   card; (b) `ready`, `rank`, queues, daemon, `--status`, Backlog mark. Then (a) is **not merged without
   (b)**: it would show `[blocked]` on tasks the daemon still starts.
6. **Overlap with TASK-EKAV** (14 shared files, list in "Affected files"; its branch has no commit yet).
   Default: edits of shared files stay small and additive, whichever merges second rebases. Other ways:
   wait for EKAV (about 11 days), or merge this first.
7. **Design doc.** Default: `docs/plans/scheduler_design.md` is not shipped (it describes a head, `kodel
   queue`, leases and limits that do not exist); the behaviour and two sections "Decision T-45" and
   "Decision T-46" go into `docs/tasks.md` and `docs/serve.md`, as "Decision T-44" stands there. Other
   ways: ship it whole, or ship sections 1, 1a (base), 1b, 2 as a new doc.
8. **Decision ids.** The task says T-45 and T-46; EKAV's plan took `t45_` too. Default: this change uses
   `t45_`/`t46_`; if EKAV merges first, I rename to the next free ids in one commit before the merge.
9. **Decision log.** It is in the local `notes/`, which I do not write. Default: the tests carry the ids and
   `docs/serve.md` the criteria; you copy them into the log.
10. **Windows.** CI runs Linux and macOS only (`ci.yml:26,58`). Default: no platform code is added, and the
   hand-in says Windows was not run. Other way: a `windows-latest` job in this change.
11. **`docs/changes.md`** is about run patches, not a change log. Default: the update note goes into
    `docs/tasks.md` and `docs/run-formats.md`; `docs/changes.md` is not touched.

## Behaviour change

- **Two new fields of a task**, offered only by a tracker with the capability `links` (the `local` adapter
  has it): `depends_on` (this task waits for those) and `conflicts_with` (do not run at the same time; it
  holds both ways whichever task it was written on).
- **Setting them.** `task_create`, `kodel task add`: `depends_on`, `conflicts_with`. `task_update`, `kodel
  task set`: the same two set the whole list; `add_depends_on`, `remove_depends_on`, `add_conflicts_with`,
  `remove_conflicts_with`; `clear` takes both names. CLI flags are the same words with dashes, one key per
  flag, repeatable. At most 20 keys per list.
- **Refused, nothing written:** a key that is no task (`TASK_NOT_FOUND`, names the key); a link to itself
  and a `depends_on` cycle of any depth (`INVALID_TASK`, the code a parent cycle has today; the message
  spells it: `A -> B -> A`); a key both added and removed. A tracker without `links` does not offer the
  parameters (`INVALID_ARGUMENTS` from a tool, `TASK_UNSUPPORTED` from the service).
- **Reading.** `task_get`, `task_list`, `kodel task show|list`: `depends_on`; `dependencies` (each key with
  its state: `open`, `done`, `declined`, `missing`, and `needs_approval` when it is closed but waits for
  you); `blocked_by` (absent when the task is not blocked); `blocks` (open tasks that depend on it);
  `conflicts_with`. The list table gets a `BLOCKED` column.
- **`kodel serve` does not start a task while**
  - a dependency is open, or cannot be found or read (fail closed);
  - a dependency is closed but **waits for your approval** (an agent set it to done or declined through
    the tools, or an agent made it and nobody approved it): `kodel task approve <dependency>` releases it.
    A run that completes closes its task without adding a mark, so a chain of tasks that did not wait for
    approval needs nothing from you (decision 4); a dependency that waited for approval before its run
    still waits after it. A rule with `approval: any` waives this for the tasks it takes: it then waives
    the approval of their dependencies too, whichever rule those match (said in `docs/serve.md`);
  - a run of a task it conflicts with is open, whoever started it; two conflicting tasks are never started
    in one cycle; and while a run exists that cannot be read and is not known to have ended, no task with
    a conflict is started (its task is not known). Runs of another checkout are outside this, as today.
  `declined` counts as done (decision 3 for how you are told).
- **The order.** Ready tasks go by: effective priority (a task's own, raised to the highest priority of
  any open task that depends on it through any number of steps), then how many open tasks it unblocks,
  then `created_at` (as text; a task without one keeps its list place), then key. A dependent counts for both only if it does not wait for approval, so a task
  an agent made or relinked cannot reorder yours. Tasks outside your start rules count (they raise a
  priority, they are not started). Today: priority, then the tracker's list order.
- **`depends_on` orders starts, not code.** A task is `done` when its run completes; the dependent's
  worktree is cut from `HEAD` then, whether or not the dependency's branch is merged.
- **`kodel serve --status`** (text) lists the start queue and the worker queue in order with the reason of
  each place, and the blocked tasks with theirs (`TASK-Y waits for TASK-X (open)`, `... (done, waits for
  approval)`, `TASK-Z conflicts with TASK-W (run r_...)`).
- **`kodel task doctor`** names a dependency or conflict key that is no task and every `depends_on` cycle
  (two merged branches can make one). These never stop other tasks from starting.
- **TUI.** The card shows `depends on` (with each state), `blocks`, `conflicts with`; the rows of the Backlog
  and the list carry no link mark (see "At the final gate"). `s` on a blocked or conflicting task asks as today with
  one more line (`TASK-A waits for TASK-B: start it anyway?`); `y` starts it, anything else does not.
- **Links hold back `kodel serve` only.** A run started by hand (`s` in the TUI after the warning, or
  `pipeline_start` with a `task_key` in a session) is not checked against them.
- **Unchanged:** the approval of the task itself, both limits, resumes, gates. A project with no link in
  any listed task is read exactly as today (tasks with no link never trigger the wider read), and with the
  `local` adapter its order is the same (its list order already is priority, `created_at`, key); where a
  tracker's list order and `created_at` disagree, `created_at` now wins. No
  head, no `.kodel/queue.yaml`, no `kodel queue`, no `queue_*` tools, no Queue view (TASK-CM7F).

## Risks and invariants

- **Humans decide (6).** Three ways an agent could make the daemon start something without you: (a)
  closing a dependency with `task_update`: closed by design, a closed dependency that waits for approval
  still blocks; the engine's own close (`advanceForRun`, `task-service.ts:373`, no `by_agent`) adds no
  mark, which leaves the limit of decision 4; (b) removing a link: decision 2 and the order of writes
  below; (c) reordering: a dependent that waits for approval counts for nothing in the order. Links hold
  back the daemon only: a start by hand is never checked against them.
- **Marks before loosening.** A removal of a conflict T-U (T is the task the call names) is written so
  that no file loses a link while a task it loosens is unmarked: (A) every U whose file does not hold the
  conflict gets a mark-only write; (B) T's one write: its mark, its own halves gone, the rest of the patch;
  (C) every U whose file holds the conflict: its mark and the removal in one write. A pair held only in T
  is loosened in B, after A marked U; a pair held in U is loosened in C, after B marked T; the write that
  removes the last half always carries that task's own mark. A write that fails stops the call: either the
  conflict is still in force or every loosened task is marked; tasks marked on the way stay marked (fail
  closed). A person's removal goes in the same order without marks. Removing a dependency is one write of
  T (mark and removal together).
- **Fail closed (2).** Blocks, never starts: a dependency key with no entry in `dependencies` (an adapter
  that declares `links` and does not fill it), state `missing`, an unreadable dependency file, members of a
  cycle (they wait for each other for ever; doctor names the cycle), a conflict while an unreadable run is
  about. Readiness is taken from the task's own `dependencies` (the tracker's fact about each key), never
  from whether the dependency is in the daemon's list, so a done dependency that is not listed unblocks
  and a missing one blocks. Older builds: decision 1.
- **A bad link stops one task, a bad file stops the project (as today).** A well-formed key that names no
  task, and a cycle, are not `problems` of a list (those make the list incomplete and start nothing,
  `daemon.ts:629`): they block their own task and go to `verify`/doctor. A link value that is not a list of
  at most 20 strings of at most 64 characters makes the file "not a valid task (depends_on)", exactly as a
  bad `priority` does today; such a file is never rewritten.
- **Agent input is untrusted (1).** Keys go through `checkKeyInput`, are resolved and bounded. Every walk
  of the graph visits a task once (memoised); the test counts visits, not seconds.
- **Redaction (3).** Keys are names: the service refuses one that redaction would change. Queue reasons
  and `blocked_tasks` hold keys, run ids, priority names and fixed words only, never a title.
- **No I/O in the core (4, 5).** `schedule/*.ts` are pure; a test scans their imports.
- **Kinds are adapters (7).** The core never matches the status name `declined`: the adapter says
  `declined` in the dependency's state.
- **Stored data (8).** No run format, journal, session record or serve record changes; the `t41_*` tables
  are untouched. The task file gains two optional keys of `v: 1`, a golden file with links, a round-trip
  test for the old golden files, and a test that a writer with the schema the beta has (copied into the
  test; a real older build cannot be run in a test) keeps the keys and moves them to the end.
- **Symmetry on disk.** A conflict is written to the file of the task it was set on, read as the union of
  both sides, removed from every file that holds it in the order above, each write under its own task
  lock, never two locks at once. A repeat of a failed call finishes it.
- **Two writers at once** can each add half of a cycle (the check and the write are one step per task, not
  per folder). It is caught on read like a cycle from a merge: both wait, doctor names it. No new lock.
- **The daemon reads more only when links exist.** It reads as today first; if any listed task has a
  link (`depends_on`, `conflicts_with` or `blocks`), it also reads every open task without the rule filter
  for the order, under the cap the read has today (5 pages of 200, `daemon.ts:71-72`; with the `local`
  adapter at most 5 more loads of the folder per cycle). More than 1000 open tasks: nothing is started and
  the message says "close tasks or remove the links". Pages may come from different moments, as today; a
  stale page cannot start a blocked task, because the start reads the task again under the lock and takes
  readiness from that read.
- **Accepted limits (in the docs).** A run tied to a task later with `add_run` is not seen by the conflict
  check: the check goes by the task a run was started for. A dependency that never starts on its
  own leaves its dependent waiting: `--status` and the card name the dependency, nothing chases it. An
  old unreadable run keeps tasks with conflicts from auto-start until you remove it; `s` still works.
- **Windows.** No path code; keys match `[A-Z0-9-]`; messages are ASCII; ordering compares strings by code
  unit, with no locale and no date parsing, so the order is the same everywhere.

## Acceptance criteria and tests

`t45_` links and readiness; `t46_` the order and the queues (ids: decision 8).

| Criterion | Test |
| --- | --- |
| Without `links`: no parameter in any tool, `TASK_UNSUPPORTED` from the service; `TASK_TOOLS_VERSION` is 2 and the instructions name links | `t45_links_are_offered_only_with_the_capability` (`pipeline-core/test/task-tools.test.ts`) |
| Patch shapes: 20 keys, duplicates, add and remove of one key, set with add, clear with set | `t45_link_patch_validation_table` (`pipeline-core/test/tasks.test.ts`) |
| Set, add, remove, clear; `get` and `list` show `depends_on`, `dependencies`, `blocked_by`, `blocks`, `conflicts_with`; run for the memory adapter and the local one | conformance cases `t45_*` in `testkit/src/task-adapter-contract.ts`, run by `local/test/tasks.test.ts` and `pipeline-core/test/tasks.test.ts` |
| Unknown key, self link, A->B->A, A->B->C->A: refused, nothing written, the message spells the cycle | `t45_unknown_self_and_cycle_are_refused` (conformance) |
| A conflict set on A shows on B; removing it on B clears A's file; one-sided files read as both | `t45_conflicts_are_symmetric_whichever_file_holds_them` (`local/test/tasks.test.ts`) |
| **R1.** An agent's removal of T-U with one write made to fail (the file at its size limit, as an agent can make it with comments), for each layout (held in T only, in U only, in both) and each failing write: afterwards the conflict is in force or both T and U are marked, never a loosened unmarked task; repeating the call finishes the removal | `t45_no_link_is_loosened_before_its_tasks_are_marked` (a table), `t45_half_removed_conflict_stays_in_force` (`local/test/task-mark.test.ts`) |
| Mark table (decision 2): agent adds or removes a link on T: T marked; agent removes conflict T-U held in U's file: T and U marked; agent adds conflict T-U: U not marked; a person's change: neither file marked | `t45_agent_link_change_marks_every_loosened_task` (`local/test/task-mark.test.ts`) |
| **C1.** Agent sets dependency B to done (and to declined) with `task_update`: approved A is not started; after `task approve B` it is. Rule `approval: any`: A starts | `t45_agent_closing_a_dependency_does_not_unblock` (`pipeline-core/test/serve-plan.test.ts`, `local/test/serve-daemon.test.ts`) |
| B did not wait for approval and its run completes: A starts with no approval. B waited for approval before its run (agent-made, never approved): A waits until `task approve B` | `t45_run_closing_a_dependency_unblocks`, `t45_unapproved_agent_made_dependency_blocks_when_done` |
| **C2.** With the default of decision 3 the plan has no comment action for links, and a give-up stays a give-up when a dependency is declined | `t45_declined_dependency_never_lifts_a_give_up` (`serve-plan.test.ts`) |
| **C3.** Conflict A-B held in B; agent removes it on A; A (approved before) is not started beside B's open run until approved | `t45_agent_removing_a_conflict_held_in_the_other_file_waits` (`local/test/serve-daemon.test.ts`) |
| Golden files without links read and write back byte for byte; the golden file with links round-trips; the beta's schema keeps both keys, at the end of the file | `t45_task_file_links_round_trip`, `t45_older_writer_keeps_the_link_keys` (`local/test/task-mark.test.ts`) |
| Hand-edited files. Missing key, bad-pattern key, cycle: the task is listed and blocked, the list stays complete, doctor names it, no file rewritten. Oversized list, non-string element, `depends_on: null`, a string: the file is a problem, not rewritten | `t45_bad_links_block_one_task_not_the_project`, `t45_malformed_link_values_are_a_file_problem`, `t45_doctor_names_bad_links` (`local/test/tasks-hostile.test.ts`) |
| 5000 files that name each other: each task visited once (a counter) | `t45_link_walks_visit_each_task_once` |
| Two half-cycles written as fixture files (no race in the test): both tasks wait, doctor names the cycle | `t45_cycle_from_two_writers_is_caught_on_read` |
| A run that cannot be read, with no worker record and not known ended: a task with a conflict is not started, a task without one is; a run of another checkout holds nothing back | `t45_unreadable_run_holds_back_conflicting_tasks` (`local/test/serve-daemon.test.ts`) |
| Every start the daemon makes passes `admitStart` in the plan and again under the lock; `prepareStart` is the only caller that asks `ready` and goes on | `t45_daemon_never_starts_over_a_block` |
| `ready` table: dependency open / done / declined / missing / done-unapproved / absent from `dependencies`; conflict with an open run, an ended run, an unreadable run; reasons join today's in a fixed order | `t45_ready_table`, `t45_admit_start_reasons_keep_their_order` (`schedule-ready.test.ts`, `serve-plan.test.ts`) |
| A dependency that is done, declined, or in a custom closed status and not in the daemon's list unblocks; one not found blocks | `t45_unlisted_closed_dependency_unblocks_and_missing_blocks` |
| A depends on B: not started while B is `todo` or `progress`; started the cycle after B is done | `t45_dependent_waits_then_starts` (`serve-plan.test.ts`), `t45_serve_starts_the_dependent_after_the_dependency` (`cli/test/serve.test.ts`, on files) |
| Two ready conflicting tasks: one start per cycle; none while the other's run is open | `t45_conflicting_tasks_are_never_started_together` |
| The daemon's check under the start lock refuses a task blocked or conflicting since the plan; no attempt used | `t45_daemon_start_reads_the_links_again` |
| No listed task has a link: the same reads as today, and for the `local` adapter the same order. A link present: the unfiltered read; over 1000 open tasks: nothing starts and the message says so | `t45_no_links_reads_as_today`, `t45_too_many_open_tasks_starts_nothing` (`serve-daemon.test.ts`) |
| Fixtures where list order and `created_at` disagree: `created_at` wins; rows without one keep their list place | `t46_created_at_beats_list_order` |
| `task show|list|add|set` | `t45_cli_links_show_and_set` (`cli/test/tasks.test.ts`) |
| Card lists; Backlog mark; malformed link fields from a tracker are dropped and bounded | `t45_tui_card_shows_links`, `t45_tui_backlog_rows_carry_no_blocked_mark`, `t45_tui_bounds_link_fields` |
| `s` on a blocked task: the warning line; `y` starts; `n` and Esc start nothing | `t45_tui_manual_start_warns_and_starts` (`cli/test/tui-worker.test.ts`) |
| `rank` table: raised transitively; a dependency before its dependents; unblocks; `created_at`; key alone on a full tie; a done or declined dependent raises nothing; an unapproved one raises nothing; one outside the rules raises and is not started | `t46_rank_table`, `t45_tasks_outside_the_rule_raise_priority_but_are_not_started` |
| Any permutation of the input gives the same order; a cyclic graph ends; `created_at` missing, mixed or unparseable falls back to list order for those rows, compared as text | `t46_order_is_reproducible_from_the_tasks`, `t46_rank_ends_on_a_cycle`, `t46_created_at_is_compared_as_text` |
| `order()` follows the policy's key and nothing else (a fake policy reverses it); `schedule/*.ts` import nothing but core types | `t46_queue_order_follows_the_policy`, `t46_schedule_is_pure` |
| Both queues go through `order()`; resumes stay oldest decision first and before any start; every `t44_*` of `serve-plan.test.ts` passes unchanged | `t46_plan_orders_both_queues_through_the_interface` |
| `queues`, `blocked_tasks` and `--status` agree; a title that looks like a secret appears in none of them | `t46_plan_reports_queues_and_blocked_tasks`, `t46_status_prints_the_queues` (`cli/test/serve.test.ts`) |

Not testable here, said in the hand-in: Windows, a real older kodel, the read time of 5000 real tasks.

Refutation. T-45: a task is auto-started with an open dependency, with a dependency an agent closed and no
person approved (a completed run of the dependency releases it, decision 4), or beside an open run of a
task it conflicts with; or a cycle is accepted through the
tools; or an agent's call through the tools loosens a task's links and the task starts without an approval
(rules with `approval: any` aside). T-46: two daemons on copies of the same task files and runs plan
different orders; or a counted dependent stands before its open dependency; or a task that waits for
approval changes the place of another.

---

## Steps

1. **Model** (`pipeline-core/src/tasks.ts`). `TaskAdapterCapabilities.links?: boolean`. `DependencyRef =
   { key; state: "open" | "done" | "declined" | "missing"; needs_approval?: true }`. `Task` and
   `TaskSummary`: `depends_on?`, `dependencies?`, `blocked_by?`, `blocks?`, `conflicts_with?`;
   `TaskSummary.created_at?`. `NewTask` and `TaskPatch`: the lists and `add_*`/`remove_*`. `CLEARABLE`
   gains both; `TASK_LIMITS.links = 20`; `validateNewTask`/`validatePatch`. No new error code.
2. **Pure code** (`pipeline-core/src/schedule/`, new):
   - `links.ts`: `applyLinkPatch` (set, add, remove, clear on two lists), `dependencyRefs(keys, lookup)`
     (`lookup` gives state, declined, needs approval, or nothing: `missing`), `blockedBy(task, approval)`,
     `findCycle`, `buildGraph(summaries)`, `dependents`, `unblocks`, `cycles` (for doctor). Both adapters
     use them, so the rules exist once.
   - `ready.ts`: `ready({ task, approval, openRunTasks, unreadableRuns, startedNow })` ->
     `{ok:true} | {ok:false, why:"blocked", by} | {ok:false, why:"conflict", with}`.
   - `rank.ts`: `rank(graph, priorities)` -> per key `{ place, effective, raisedBy?, unblocks }`; the sort
     key is (effective rank, unblocks descending, `created_at`, key), which puts a dependency first.
   - `queue.ts`: `QueueEntry`, `QueuePolicy`, `QueueContext`, `order()`, `startPolicy`, `workerPolicy`.
3. **Service and tools.** `TaskService`: capability check, resolve every key, refuse a key redaction would
   change, fill `blocked_by` from `dependencies` (approval required). `mcp/task-tools.ts`: parameters under
   `caps.links`, descriptions, instruction 7, `TASK_TOOLS_VERSION = 2`.
4. **Adapters.** `local-adapter.ts`: `links: true`; `recordSchema` (bounded lists) and `FIELD_ORDER` (after
   `parent`); `load()` builds the conflict union and the reverse of `depends_on`; `toTask`/`summary` fill
   the fields; `create`/`applyUpdate` apply the patch with the cycle check, the removal in the order "marks
   before loosening" and the mark of decision 2; `verify` adds unknown keys and cycles. `testkit/src/memory-task-adapter.ts`: the
   same through `links.ts`, with a switch for the capability; `task-adapter-contract.ts`: the link cases.
   Golden file and `README.md` in `fixtures/task-formats/v1/`.
5. **`planServe`** (`serve/plan.ts`, kept small). `ServeTaskView` gains the link fields and `created_at`;
   `ServeInput.unreadable_open?: string[]`. `Admission` gains `blocked` and `conflict` (after
   `not_approved`, before `gave_up`, through `ready`). The candidate sort and the resume sort become
   `order(entries, policy, ctx)`. `ServePlan` gains `queues` and `blocked_tasks`. No new action (decision
   3). `holdsWorker`, `servePlaces`, the resume loop and `resumeVerdict` are not edited.
6. **Daemon** (`serve/daemon.ts`). `ServeTasksPort.capabilities.links`; `listTasks`: today's read, then the
   unfiltered read of open tasks only if a listed task has a link; the two view functions carry the
   fields; `gatherRuns` also returns the ids of runs it cannot read and does not know ended; `start`
   passes them and the open runs to `admitStart`; one log line when a task starts past a declined
   dependency.
7. **CLI.** `cli.ts`: flags of `task add` and `task set`; `task-format.ts`: `formatTask` lines, the
   `BLOCKED` column, `links` in `formatSchema`; `serve-command.ts`: the queue and blocked lines.
8. **TUI.** `tasks-load.ts`: parse and bound the fields; `tasks.ts`: the card lines, the row mark;
   `worker-start.ts`: `prepareStart` returns `warning?` from `ready`; `run.ts`: `StartCheck.warning`;
   `view.ts`: one line in the start question.
9. **Docs.** `docs/tasks.md` (fields, commands, file keys, the mark, older builds, starts not code, the
   accepted limits); `docs/serve.md` ("Starting a task", the order, the queues, `--status`, "Decision
   T-45", "Decision T-46"; T-44's criterion names link changes); `docs/run-formats.md` (the update note).
10. **Checks.** `bun run typecheck`, `bun run lint`, `bun test`, `bun run build && node
    scripts/check-artifact.mjs`; the Linux container run before a push.

## Affected files

Overlap with TASK-EKAV's plan is marked **[EKAV]**.

- `packages/pipeline-core/src/tasks.ts`, `task-service.ts`, `index.ts`, `mcp/task-tools.ts`
- `packages/pipeline-core/src/schedule/{links,ready,rank,queue,index}.ts` (new)
- `packages/pipeline-core/src/serve/plan.ts` **[EKAV]** (it changes `ServeWorkerView`, `ServeRunView`,
  `holdsWorker`, `servePlaces`, `admitStart`, the resume loop, log problems, a `finish` action; conflicts
  expected in `admitStart`, the starts loop and `ServePlan`)
- `packages/local/src/tasks/local-adapter.ts`
- `packages/local/src/serve/daemon.ts` **[EKAV]** (it adds `finish` and a per-cycle `inspect`; this change
  edits `listTasks`, `gatherRuns`' return, the two view functions, `start`)
- `packages/testkit/src/memory-task-adapter.ts`, `task-adapter-contract.ts` (**[EKAV]** touches other
  files of the package)
- `packages/cli/src/cli.ts` **[EKAV]** (the `task` block only), `serve-command.ts` **[EKAV]** (`--status`
  lines), `task-format.ts`
- `packages/cli/src/tui/tasks-load.ts`, `tui/tasks.ts`; `tui/worker-start.ts` **[EKAV]** (`prepareStart`
  only), `tui/run.ts` **[EKAV]** (one field of `StartCheck`), `tui/view.ts` **[EKAV]** (one line of the
  start question, the Backlog mark)
- `fixtures/task-formats/v1/with-links.yaml`, `fixtures/task-formats/v1/README.md`
- Tests: `pipeline-core/test/{tasks,task-tools,schedule-ready,schedule-rank,schedule-queue}.test.ts`,
  `serve-plan.test.ts` **[EKAV]**; `local/test/{tasks,tasks-hostile,task-mark}.test.ts`,
  `serve-daemon.test.ts` **[EKAV]**; `cli/test/{tasks,tui-tasks,tui-tasks-card}.test.ts`, `serve.test.ts`
  **[EKAV]**, `tui-worker.test.ts` **[EKAV]**
- `docs/tasks.md` **[EKAV]**, `docs/serve.md` **[EKAV]**, `docs/run-formats.md` **[EKAV]**
- Not touched: `errors.ts`, `serve/resume.ts`, `mcp/tools.ts`, `tui/tabs.ts`, `tui/demo-tasks.ts`,
  `docs/changes.md`, `docs/decisions.md`, `AGENTS.md`, the run and session codecs, `.kodel/`, `.mcp.json`.

## Rejected review findings

Everything else from the critique (C1-C3, M1-M2, M4-M12, M14-M16, m3-m4, m6-m11, m14-m15) is fixed above.

Second look: R1, R2 (decision 4), R3 (cap and cost), R5-R7, r1-r9 are fixed above.

- **M3, second half, and R4 (a run attached later with `add_run` is invisible to the conflict check).**
  Not fixed. The run ids are in `Task.runs`, so it could be done with one read per conflicting task per
  candidate; it is left out because no agent act starts anything through it (it is a missing protection
  for a run that was started untied), and every start by the daemon or the TUI ties its run. Documented
  as a limit. The first half (unreadable runs) is fixed.
- **R3, the snapshot part.** No single-snapshot read is added: pages from different moments exist today,
  and the start reads the task again under the lock. The cap (1000 open tasks) and the cost are stated.
- **r6, in part.** "No tool starts a blocked task" was wrong and is withdrawn: links hold back the daemon
  only, and `pipeline_start` with a `task_key` is a start by hand. The test is that the daemon never does.
- **r10 / m15 (process questions out of "Decisions needed").** They stay in the section, after the product
  ones and a line or two each: the step's format asks for every open question there.
- **M13 and m1 (folder lock: one of two concurrent writers refused, lock order, stale lock).** The folder
  lock is cut instead: a cycle from two writers is caught on read exactly like one from a merge (both wait,
  doctor names it), and the two-file removal never holds two locks. No new lock, so nothing to order or to
  go stale; the test is `t45_cycle_from_two_writers_is_caught_on_read`.
- **m2 (edge cases of the declined comment).** Moot with the default of decision 3 (no comment); the
  rules of option B answer them if you choose it.
- **m3 (read link values as unknown and bound by hand).** Done the other way: a malformed value is a file
  problem like any other malformed field, which is today's rule and needs no second reader; a well-formed
  but wrong key blocks one task only.
- **m5 (the warning is not checked again after `y`).** The manual start ignores readiness on purpose; a
  block that appears between the question and `y` would be overridden all the same.
- **m11, last part (`TASK_LINK_REFUSED` in the MCP contract docs).** No new code any more: a self link and
  a cycle answer `INVALID_TASK`, as a parent cycle does.
- **m12 (a check that test names are unique across branches).** A test cannot see another branch;
  decision 8 covers the clash.
- **m13 (crash between the two writes of a removal).** Not a crash test: the failure of the second write
  is tested (`t45_half_removed_conflict_stays_in_force`); a crash leaves the same state.
- **m14 (`--status --json` stability).** `kodel serve --status` has no JSON form; the plan no longer names
  one.

## Findings in the code

- `packages/local/src/tasks/local-adapter.ts:129-151`: the record schema is `.passthrough()` and
  `serialize` (`:174-181`) writes unknown keys after the known ones: an older kodel keeps the link keys
  and moves them to the end. A `v` above 1 is a problem of the file (`:333-335`), which makes the daemon's
  list incomplete (`serve/daemon.ts:629`) and starts nothing. A field of the wrong type fails the whole
  record (`:336-340`).
- `packages/local/src/tasks/local-adapter.ts:762-767`: a parent cycle answers `INVALID_TASK`; `:778-790`:
  `agent_edited_at` compares one record (title, body, status, priority, parent), so the mark for a second
  file is new code.
- `packages/pipeline-core/src/run-task.ts:96-115`, `task-service.ts:373`: the engine's own move of a task
  goes through `advanceForRun` without `by_agent`, so "closed by an agent's edit" is told apart by the mark
  that exists already.
- `packages/pipeline-core/src/tasks.ts:171-193`: `TaskSummary` is an explicit list without `created_at`;
  `needs_approval` there is the precedent for a fact the adapter fills with a pure function of the core.
- `packages/pipeline-core/src/serve/plan.ts:182-193, 262`: a give-up is the task's latest comment only, so
  any later daemon comment would lift it. `:586-599`: today's order; `:519`: the resume sort; `:157`:
  `ServePlan.blocked` exists and means "why nothing starts", hence `blocked_tasks`.
- `packages/local/src/serve/daemon.ts:595-641`: the daemon lists `todo` tasks, filtered by the rule when
  there is one, 200 per page, 5 pages. `:482-493`: an unreadable run without a worker record is dropped
  before the plan. `:377`: the daemon's memory is in the process only. `:959`: it exits when the build on
  disk changes. `:816-880`: the start reads the task and the runs again under the lock.
- `packages/cli/src/tui/worker-start.ts:92-150`: the manual start never calls `admitStart`.
- `packages/testkit/src/task-adapter-contract.ts`, `memory-task-adapter.ts`: the conformance suite and the
  second adapter; link rules must be there, not only in the local adapter's tests.
- `packages/cli/src/cli.ts:1784-1797`: `task doctor` prints what `verify` returns; no change needed there.
- `packages/pipeline-core/src/mcp/task-tools.ts:24`: `TASK_TOOLS_VERSION` is bumped when arguments change.
- `docs/changes.md` is about run patches; `docs/run-formats.md:145-152` holds the update notes.
- `.github/workflows/ci.yml:26,58`: no Windows job. `packages/cli/src/serve-command.ts:181-184`: `kodel
  serve` starts nothing on Windows and `--status` has no JSON form.
- `.kodel/worktrees/r_0mwqz8yju_xy8j/docs/plans/task_ekav_...md` (uncommitted): lines 54 and 169 take
  `t45_`; lines 329-341 list its files.

## Implementation notes

The person's answers to "Decisions needed", which override the text above where they differ:

1. **A.** The task file stays `v: 1`; the limit of older builds is said in `docs/tasks.md` and
   `docs/run-formats.md`.
2. **C. Links never touch the approval mark.** A change of `depends_on` or `conflicts_with` through the
   task tools sets `agent_edited_at` on no task, neither the one the call names nor the other side of a
   conflict. Everything above that exists only for option A is not implemented: the mark table, the write
   order "marks before loosening", and the tests `t45_no_link_is_loosened_before_its_tasks_are_marked`,
   `t45_agent_link_change_marks_every_loosened_task` and
   `t45_agent_removing_a_conflict_held_in_the_other_file_waits`. In their place
   `t45_link_change_does_not_touch_the_approval_mark` pins the behaviour (conformance case for both
   adapters, the tools on the memory adapter, the tools on real files), and `docs/tasks.md` and
   `docs/serve.md` ("Accepted risks") say that an agent can change the links of an approved task without
   an approval. Kept: a dependency an agent closed with `task_update` waits for approval and releases
   nothing until it is approved (that is the status, not a link). A removal of a conflict held in two
   files writes the named task first and the other file after it, one lock at a time: a conflict holds
   while either file names it, so a failed write leaves it in force and a repeat finishes it
   (`t45_half_removed_conflict_stays_in_force`).
3. **A.** No daemon comment for a declined dependency: `task show`, the card and `--status` show
   `(declined)`, and the daemon logs one line when it starts a task past one.
4. **A.** A dependency closed by a completed run releases its dependents, also a run an agent started;
   said in `docs/serve.md` and in the criterion of T-45.
5. **A.** One change. Nothing of the stated cut list was cut: the `BLOCKED` column, opening a linked task
   from the card and the reasons in the `--status` queues are all in.
6. Edits of the files shared with TASK-EKAV are small and additive; the new logic is in
   `packages/pipeline-core/src/schedule/`. Conflicts are resolved at the end.
7-11. The defaults: the design doc is not shipped; the ids are `t45_`/`t46_`; the decision log is not
   written; no Windows job; the compatibility note is in `docs/tasks.md` and `docs/run-formats.md`.

What differs from the plan besides decision 2:

- **Where the tests are.** The service and tool tests are in `packages/testkit/test/task-links.test.ts`
  (the service tests live in testkit, not in `pipeline-core/test`); the file tests of the `local` adapter
  are in the new `packages/local/test/task-links.test.ts`, not spread over `task-mark` and `tasks-hostile`;
  the plan tests are in the new `packages/pipeline-core/test/serve-plan-links.test.ts`, so
  `serve-plan.test.ts` is not edited; the TUI card, Backlog and bounds tests are in the new
  `packages/cli/test/tui-task-links.test.ts`.
- **`t44_test_names_carry_the_decision_id`** (`cli/test/serve.test.ts`) took the first `## Decision`
  heading of `docs/serve.md` only; it now takes every heading there (T-44, T-45, T-46), so the `t45_` and
  `t46_` tests may stand in the `serve-*` test files.
- **Not written:** `t45_serve_starts_the_dependent_after_the_dependency` through the `kodel serve`
  command; the same path is covered on real files and a real host by
  `t45_run_closing_a_dependency_unblocks` in `local/test/serve-daemon.test.ts`.
- **`unblocks` is counted through any number of steps**, not directly: only then does a dependency always
  stand before a task that depends on it when their priorities are equal (the refutation of T-46).
  `dependents` and `unblocks` are inside `rank.ts`, not exported from `links.ts`.
- **A task without `created_at`** goes after the tasks that have one, in its list place, so that the order
  stays a total order whatever order the tasks are read in.
- **A readable open run of another checkout** that names a conflicting task holds the task back, as such a
  run already counts for "the task has a run"; only an unreadable run of another checkout holds nothing
  back.
- **`remove_*` takes a key that names no task**, so that a link a merge left can be removed with the
  tools; an added key must be a task.
- **An empty list is refused** (`depends_on: []`): `clear` is the way to empty a list.
- **`blocks` and the conflicts read from both sides** are cut to 100 keys in an answer
  (`TASK_LIMITS.linksShown`).
- The memory adapter of the testkit has `links: true` by default; a profile without links is run by the
  conformance suite too.

Not run here: Windows, a real older kodel, the read time of 5,000 real tasks, and the full suite, lint and
build (the pipeline's own steps run those).

### The change of `.kodel/pipelines/dev.yaml` in this worktree

It is not an edit by hand. The `test` step of the first attempt failed on its 900 s timeout: every test file
run alone passes and none hangs (the slowest takes about 90 s), but they sum to about 1100 s. The change of
the `test` node (`timeout: 1800`, `expected_duration: 1100`) was proposed with `pipeline_propose_change`
and accepted on the person's word (change `c9b7862ceb922692`, kept in the run's history); the engine wrote
it into the run's pipeline file. It goes into the pull request with this change.

### After the second review

- `kodel task doctor` counts the problems past the cap right when link problems follow a capped list.
- The TUI start warning, like the daemon, does not count an unreadable run of another checkout.
- The agent's task instructions say that a change of links through the tools takes effect without an
  approval (decision 2C).
- `blocked_by` is not given for a task that is itself done or declined (both adapters; a conformance case pins it).
- Known limits left as they are: an answer shows at most 100 conflicts of a task (`TASK_LIMITS.linksShown`), and
  the daemon reads that list, so a conflict past the hundredth is not seen; and every `task_update` reads the
  tasks folder once after its write to give `blocks` and the conflicts named by other files in its answer.

### After the fifth review

- The service no longer gives `blocked_by` for a finished task either (`t45_finished_task_is_not_blocked_through_the_service`).
- The worker queue's reason is the time of the decision (`decided at <ms>`), not the journal seq of another run.
- The second `t45_tui_manual_start_warns_and_starts` (worker-launcher) is renamed `..._through_the_launcher`.

### At the final gate

The person sent the change back from the final gate with one remark: the `[blocked: …]` mark before the
title in the rows of the TUI task list and Backlog only takes room. The mark is removed; the card keeps
`DEPENDS ON`, `BLOCKS` and `CONFLICTS WITH`, and `s` on a blocked task still asks with the warning line.
The test `t45_tui_backlog_marks_blocked_tasks` became `t45_tui_backlog_rows_carry_no_blocked_mark`, and
`docs/tasks.md` says the rows carry no link mark.
