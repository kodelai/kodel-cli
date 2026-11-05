# TUI: a Tasks screen and a Backlog block in Sessions (TASK-G4JY)

## TL;DR

- Screen 3 ("Tasks") stops being a placeholder: all tasks of the project, a card with body, comments, parent and runs. Sessions gets a
  **Backlog** block under the runs: the first 5 tasks in state `todo` with no active run, by priority, then oldest first.
- **No change outside `packages/cli`** (no core, adapter, MCP or stored-format change): the order comes from the adapter's list order,
  which the `local` adapter already gives (priority, then creation date) and which this task writes down in `docs/tasks.md`
  (Decision 1). The TUI only filters and cuts.
- The risky part is the Sessions selection: a Backlog row is not a run. The plan makes the selection **one tagged value** and routes every run-scoped
  key, card, mouse hit and read through one accessor, so no run key can act while a task is picked.
- The tasks are read **apart from the runs** (own timer, own state), so a slow tracker never stalls the run list.
- Read-only: no start key, no status change, no write to tasks.
- **What the critique changed** (two rounds, 1 critical, ~45 findings): the selection became one tagged value behind one accessor (was the critical); the Backlog got its own
  query and is filtered at render, not at read; the tasks read got its own tested scheduler with an in-flight guard and a sequence number; `created_at` was dropped for the adapter's documented
  order (now also pinned in the shared adapter conformance suite); the priority-from-`schema()` read was cut; the tests were split one behaviour per row.

## Decisions needed

1. **Creation date and order.** `TaskSummary` has no date; the `local` adapter's `list()` already returns priority, then `created_at`, then key.
   - C. Rely on the adapter's list order and document it as the contract for the Backlog ("`task_list` returns most important first, oldest first")
     in `docs/tasks.md`; the TUI does not sort, it filters and cuts. (**Recommended**: no core/adapter/MCP/testkit change, nothing the agent sees
     changes. Fits "local today".)
   - A. Add optional `created_at` (and `updated_at`) to `TaskSummary` and sort in the TUI. Correct for a tracker with another order, but it changes the
     agent-facing `task_list` output, touches `packages/testkit`'s memory adapter and the Server contract tests, and needs clipping of untrusted dates.
   If no answer: C. The order becomes an adapter obligation, so the case is added to the shared conformance suite `taskAdapterContract`
   (`packages/testkit/src/task-adapter-contract.ts`; the memory adapter already meets it) and pinned for `local`
   (`task_g4jy_local_list_order_is_priority_then_age`). The test double in the TUI tests follows the documented order, so the TUI tests only prove the TUI does not reorder;
   the conformance case is the refutation of C.
2. **Decision id for the test names.** The task says tests carry the decision id; none is known to me. If the person gives one, it replaces `task_g4jy_`.
   If no answer: `task_g4jy_...`, and the final report says so.
3. **Keys on a Backlog row.** Enter opens the task card; `t` jumps to the Tasks screen with that task selected; Esc on the card goes back to the list. The new
   hint goes at the end of the hint line (`fit` cuts from the right, `q quit` must stay). If no answer: this.
4. **What counts as an active run.** `loadSessions` copies `RunState.taskKey` into `Session.taskKey`; a task is hidden when a session with its key has status
   `waiting` or `running`. Stated limits: a run started with `on_run.mode: disabled` or after a failed link carries no key, and an `unreadable` run has no state to read
   one from, so those cannot hide their task (the task is `todo` still, and shows). Tasks in `progress` are never in the block anyway. If no answer: this.
5. **Size.** The Tasks screen reads one page (200, `TASK_LIMITS.listMax`) of all states and says "first 200 shown" if the adapter has more. The Backlog has its own
   query (below), so it stays right with thousands of tasks. No paging on the screen in this task.
6. **Split.** One task is kept, built in two halves: **A** the Tasks screen (steps 3-6: loader, scheduler, wiring, `Model.tasks`, rendering) and **B** the Backlog (steps 7-9: the tagged selection, the block, keys,
   demo). The selection refactor is the regression-prone part and belongs only to B; A does not touch Sessions behaviour. The person may split at that line. If no answer: one task, A then B.
7. **Cut as not needed:** a cache of task cards (the selected card is read again on every tasks refresh instead), mouse on the Tasks screen (the Pipeline
   screen has none either; parity), filters/paging, and the priority order read from `schema()` (with Decision 1 = C the TUI does not sort, so it only shows the priority name it was given).
   Mouse on Backlog rows stays (they sit in the Sessions list that already has it).
8. **The plan's own screen design, accepted unless the person objects:** the Tasks screen is flat (a child shows `↳ PARENT`), grouped TODO / IN PROGRESS / DONE like the Sessions groups. Nested children and other groupings are later work.

## Behaviour change

- `kodel tui`, menu 3 "Tasks": left, tasks grouped TODO / IN PROGRESS / DONE (`declined` is state done), flat (a child shows `↳ PARENT`), each row key, title,
  priority, status, run count. Right: the card (title, key, status, priority, parent, runs with their state when the run is known, body, comments). Keys: Up/Down,
  Enter/Right open the card, Esc back, `z` zoom, PgUp/PgDn scroll. A dim line says "N task files could not be read (kodel task doctor)" when the adapter reports problems.
- Sessions: under the runs, `BACKLOG · 5 of 12` (`12+` when the read was cut). Up/Down walks on from the last run into the block and back. Enter opens the task card in the
  right pane; `t` goes to the Tasks screen on that task. While a task is picked, `a`, `r`, `c`, `d` and the run tabs do nothing. With no runs, the block still works.
  With no eligible task, no block.
- Tasks off, or a config the adapter refuses: the block and the screen each show one line ("Tasks are off: set tasks.enabled in the project config, then start kodel tui
  again", or the error). The tasks are read apart from the runs, so nothing else slows or fails.
- `--demo`: the same screens over sample tasks tied to the sample runs.
- No command, MCP tool or file format changes.

## Risks and invariants

- **Selection (the blocking finding).** One tagged selection `Model.pick = {kind:"run", id} | {kind:"task", key}` replaces reading `selected` directly. `selectedSession`,
  `detailOf`, `normalized`, `cardKey`, `decide`, `scrollCard`, `hints`, `hitTest`, the wheel branch of `mouseEvent`, `ensureDetail` in `run.ts` and the `a/r/c/d` handling
  all go through one accessor `shown(m)` returning the run, the task or nothing; with a task they take the task path or return the model unchanged. `Hit` gets
  `{kind:"task", key}`, `listLines` returns tagged ids. `withData` keeps a run pick when the run is there, else the first run. `pick` is the **Sessions** selection: a task pick is kept only while the task is still in the block, else it falls
  back to the first row **and sets `focus: "list"`** (so a card never shows a row the person did not pick). The Tasks-screen selection is a separate field (`Model.tasks.selected`), kept while the task is on its page.
  Tests below prove no run effect or confirm is possible with a task picked.
- **Stored formats / compatibility:** none touched. `Session.taskKey` is in-memory, read from `RunState.taskKey` (kept by the format 1 codec, `formats/v1.ts:58`); a run without it
  is simply not matched. No codec, fixture or `t41_*` table changes.
- **pipeline-core stays free of I/O (4):** with Decision 1 = C nothing in core changes.
- **Humans decide trust (6), no write path:** the loader is given only `list`, `get`, `schema`; a test gives it a source whose write methods throw.
- **Agent/tracker input is untrusted (1):** the loader validates what `TaskService` returns with zod (the service returns `{ok, ...unknown}`): bad rows are dropped and counted,
  `ok:false` becomes an error state, so a malformed row cannot throw in `render`. Text goes through `fit`/`wrapText` (they neutralize) and `draw()` neutralizes again.
  Redaction of task text is the service's (`TaskService` redacts what comes in); the TUI shows it as the `task_*` tools do. The error line is only cleaned of control characters
  (`plain`); it is not redacted, and the plan does not claim it is (the message comes from the service, which already redacts its own failures).
- **Fail closed / no stall:** each tasks read is bounded by `timeout_s` (up to 300 s). The reads are driven by a small scheduler in `tui/tasks-refresh.ts` (pure, injected clock and loaders, so it is
  tested without a terminal): one read in flight at a time (a tick while a read is out is skipped), a sequence number so only the newest answer is kept (a late older answer is dropped), the same for the
  card read, and a rejection lands in a tasks error state, never in "Cannot read the runs". `run.ts` only wires it to `setInterval` and to opening screen 3. The first read starts at launch, next to the
  first `ensureDetail()`, so the block shows "reading tasks…" only until that read answers; the first paint does not wait for it.
- **Refresh cost:** runs every 2 s as now; tasks list (Backlog query + screen page) at most every 10 s, and at once on opening the Tasks screen; the selected card on selection
  and on each tasks refresh. The service is opened once; changing `tasks.enabled` needs a restart of the TUI (the off line says so).
- **Narrow terminals:** key column fixed-width and clipped (a key may be 64 characters by contract); priority and status clipped; the new hint goes last.
- **Windows / plain Node:** TS in the CLI package only; `check-artifact.mjs` covers it.

## Acceptance criteria and tests

New `packages/cli/test/tui-tasks.test.ts` (names `task_g4jy_...`), driving `initialModel`, `update`, `withData`, `withTasks`, `render`, `hitTest`, `mouseUpdate`, `takeEffects`,
the loaders over fake sources and the scheduler with a fake clock, no terminal. **Each row below is one test.**

| Criterion | Test |
|---|---|
| Block = exactly the 5 right keys (more than 5 eligible; an old low-priority and a newer high-priority; the cut inside a priority class; one `progress`, one active run, one `done`, one `declined`); header `5 of N`, N the filtered count | `task_g4jy_backlog_takes_five_todo_tasks_in_adapter_order` |
| Fewer than 5 eligible: `3 of 3` | `task_g4jy_backlog_with_few_tasks` |
| No eligible task: no block | `task_g4jy_backlog_with_no_tasks_has_no_block` |
| Run statuses: waiting/running hide the task; done/failed/canceled/unreadable do not | `task_g4jy_backlog_active_run_table` |
| A run with another key, or with none, hides nothing | `task_g4jy_backlog_ignores_runs_of_other_tasks` |
| Filtered at render: 5 eligible, then one gets a waiting run before the next read: still 5 rows (the read keeps the todo rows, not just 5), N minus 1; when its run ends it returns | `task_g4jy_backlog_follows_runs_between_reads` |
| Done and declined absent from the block, present on the screen | `task_g4jy_finished_tasks_only_on_the_screen` |
| Own query (`state:[todo]`), pages up to the bound; 300 done + 6 todo still gives the right 5; `N+` when cut | `task_g4jy_backlog_right_past_200_tasks` |
| `local` order is priority, then age, then key; a task without `created_at` and a tie on priority and date | `task_g4jy_local_list_order_is_priority_then_age` (packages/local) |
| The shared conformance suite has the order case and the memory adapter passes it | `task_g4jy_adapter_contract_checks_list_order` (packages/testkit) |
| Unknown priority names (two, differing case) and a missing priority are shown as given and do not break rows | `task_g4jy_unknown_priority_is_shown_as_given` |
| Tasks screen: all tasks, groups (declined under DONE), run count, empty list | `task_g4jy_tasks_screen_lists_all_groups` |
| Parent mark for a child; a parent that is not in the list | `task_g4jy_tasks_screen_parent_mark` |
| 200 rows + `more`: the "first 200 shown" line | `task_g4jy_tasks_screen_says_when_cut` |
| Tasks-screen keys: Up/Down select, Enter/Right open, Esc back | `task_g4jy_tasks_screen_keys` |
| Card: body, comments, runs (state only for a known run), no comments | `task_g4jy_task_card_content` |
| Card: long body, PgUp/PgDn | `task_g4jy_task_card_scrolls` |
| Card: re-read on each tasks refresh; a failed read (including a task deleted between list and card: TASK_NOT_FOUND) shows a line and keeps the list | `task_g4jy_task_card_reread_and_failure` |
| `load_task` effect on selection, stored by key, not repeated on a 2 s refresh | `task_g4jy_card_read_is_an_effect_not_per_refresh` |
| Selection: Down from the last run enters the block, Up leaves it, no wrap at the end | `task_g4jy_selection_walks_runs_then_backlog` |
| No runs but a backlog: Enter, `t`, `z`, click work | `task_g4jy_backlog_works_with_no_runs` |
| A picked task that leaves the block falls back to the first row and sets focus to the list | `task_g4jy_pick_falls_back_when_task_leaves` |
| A picked run that vanishes falls back; pick is never a run and a task at once | `task_g4jy_pick_falls_back_when_run_leaves` |
| With a task picked, `a r y n c d` and a typed comment produce no run effect, no confirm, no run notice | `task_g4jy_run_keys_are_inert_on_a_task` |
| Enter opens the card; Esc returns | `task_g4jy_backlog_enter_and_escape` |
| `t` jumps to the Tasks screen on that task, also when the task is not on the screen's page | `task_g4jy_backlog_t_jumps_even_off_page` |
| `t` with tasks off or in error does not crash | `task_g4jy_backlog_t_with_tasks_off` |
| No printable key on a Backlog row emits an effect except `load_task`; the hint has no start key | `task_g4jy_backlog_has_no_start_key` |
| Mouse: click on a Backlog row sets the task pick (not a run) | `task_g4jy_backlog_click_picks_the_task` |
| Wheel over a task card scrolls the task; narrow and zoomed layouts keep the block usable | `task_g4jy_backlog_wheel_and_layouts` |
| `z`, digits, `q` keep working on the Tasks screen | `task_g4jy_tasks_screen_shared_keys` |
| Tasks off: the wiring returns `off`; both screens show the one line | `task_g4jy_tasks_off_says_so` |
| Bad config: the wiring returns one error line; nothing throws | `task_g4jy_bad_config_is_one_line` |
| First load fails: error line in the block and on the screen; run list unaffected | `task_g4jy_first_tasks_read_fails` |
| Error after a good load keeps the last list and shows the line | `task_g4jy_failure_keeps_the_last_list` |
| A control sequence in an error message is stripped (no redaction is claimed) | `task_g4jy_error_message_is_cleaned` |
| Before the first answer the block says "reading tasks…"; first paint does not wait | `task_g4jy_block_says_reading_before_first_answer` |
| Malformed rows (non-string title/priority) dropped and counted; `ok:false` becomes an error; never throw in `render` | `task_g4jy_loader_validates_rows` |
| Problems from `list()` give the "N task files could not be read" line | `task_g4jy_problems_line` |
| ESC/CSI/OSC in title, body, comment, parent: no `\x1b` outside the TUI's styling in list, card and block; and after the final `neutralize` | `task_g4jy_task_text_is_neutralized` |
| Write methods of the source throw; a key script over every screen never calls them | `task_g4jy_tui_never_writes_tasks` |
| `loadSessions` copies the key on the normal, `problem(...)` and stateful `unreadable` paths; absent for a run without it; a format 1 state | `task_g4jy_session_carries_the_task_key` |
| Demo: block of 5, a declined task on the screen, a task tied to a sample run is hidden | `task_g4jy_demo_tasks` |
| Option building: the `tui` action's `TuiOptions` carry the demo tasks for `--demo` and the real loaders otherwise | `task_g4jy_tui_options_pick_demo_or_real` |
| Scheduler (fake clock): at most one tasks read in flight (a tick while out is skipped); the first read at start; an immediate read on opening screen 3; a late older answer does not overwrite a newer | `task_g4jy_scheduler_one_read_at_a_time_newest_wins` |
| Scheduler: a slow tasks source does not delay the sessions `load()`; a tasks rejection becomes a tasks error, not "Cannot read the runs" | `task_g4jy_tasks_read_is_detached_from_runs` |

Also `bun run typecheck`, `lint`, `test` (includes `t41_*`), `bun run build && node scripts/check-artifact.mjs`. A manual scenario on a real run is listed in the final report: tasks on
with a real `local` store (more than 5 tasks, one run for a task), tasks off, a bad config, a narrow terminal. `docs/tasks.md` gets "In the TUI" and the list-order contract.

---

## Steps

**Half A: the Tasks screen**

1. **Contract text and conformance.** `docs/tasks.md`: list order is most important first, then oldest first, and the TUI Backlog relies on it; "In the TUI" paragraph. Add the order case to
   `taskAdapterContract` in `packages/testkit` (Decision 1 = C) and the `local` order test.
2. **Session key.** `session.ts`: `Session.taskKey?`; `load.ts` `buildSession` copies `state.taskKey` on every path that has a state: the normal one, `problem(...)`, and the `unreadable(...)` at `load.ts:144`
   (it has a state; only `load.ts:124` has none). Test.
3. **Loader `tui/tasks-load.ts`** (style of `pipes-load.ts`): `TasksSource` = `{list, get}` returning the service's `ToolResult`; zod schemas for a row and a task (no `schema()` call);
   `loadTasks(source)` → `{status:"ready", rows, more, problems, todo, todoCut} | {status:"off"} | {status:"error", message}`. The screen page is `list({state:[todo,progress,done], limit:200})`.
   The Backlog read is its own `list({state:["todo"]})` paged by `next` up to 4 pages and returns **all** the todo rows it read (`todo`, in adapter order) and `todoCut` (more existed); it does **not** filter by runs
   and does not stop at 5. `loadTask(source, key)`. `ok:false` and throws become the error state; the message is cleaned with `plain`. Unknown `state` read with `readState`.
4. **Scheduler and wiring.** `tui/tasks-refresh.ts`: a pure scheduler (injected clock/timers and loaders): first read at start, an immediate read when screen 3 opens, then every 10 s; one read in flight, a tick
   while out is skipped; a sequence number so only the newest answer reaches the model; the selected card is read in the same cycle with the same rules. `tui/tasks-open.ts` (outside `cli.ts`, testable):
   `openTasksForTui(storeRoot)` → source, `{off}` or `{error}` using `openTaskService` (not `tasksService()`), with `storeRoot` from `await storeRoot()` (`project().dataDir`, `cli.ts:273`), the same root the MCP server and
   `kodel task` use. A function `tuiTaskOptions(...)` builds the `TuiOptions` part for demo or real; `cli.ts` `tui` only calls it. `run.ts` wires the scheduler to `setInterval` and to opening screen 3, and the result to `withTasks`.
5. **Tasks-screen model and rendering.** `view.ts`: `Model.tasks` (the tasks result + screen state: selected key, cursor, scroll, the card and its error) and `tasksUpdate` (Up/Down, Enter/Right, Esc, `z`, PgUp/PgDn);
   `z` learns section 2; `SHARED_KEYS` keeps its set. `tui/tasks.ts`: `taskList` (flat, groups, fixed-width clipped key column, `↳ PARENT`, run count, problems line, "first 200 shown"), `taskCard` (reuse `fit`, `prose`,
   `wrapText`, `panes`, `layoutOf`). Replace the placeholder. New `Effect` `load_task`.
6. **Demo for the screen.** `tui/demo-tasks.ts` (~9 tasks: mixed priorities and dates, a parent/child, one tied to a sample running run, a declined one); `--demo` uses them. Tests for A.

**Half B: the Backlog (the risky half)**

7. **Selection.** `view.ts`: `Model.pick`, accessor `shown(m)`; move every reader listed in Risks onto it; `moveSelection` walks runs then the block; `Hit` and `ids` tagged; `withData`/`withTasks` fallbacks (focus to the list);
   `Enter`, `z`, `hitTest`, `emptyState` no longer require `sessions.length > 0` when a block exists; `ensureDetail` skips when a task is picked.
8. **The block.** `backlogLines` in `tasks.ts`: derived at render from `Model.tasks.todo` and the current sessions (filter out tasks with a `waiting`/`running` session of that key, take `BACKLOG_COUNT = 5`; header `5 of N`, `N+` when
   `todoCut`), so a run starting hides its task on the next 2 s refresh and a task returns when its run ends. `t` jumps; the hint goes last. Tests for B.
9. **Docs and CI.** `docs/tasks.md` paragraph; run the CI commands and write the manual scenario for the final report.

## Affected files

- `docs/tasks.md`
- `packages/cli/src/tui/session.ts`, `load.ts`, `view.ts`, `run.ts`, `demo.ts`; new `tasks-load.ts`, `tasks-refresh.ts`, `tasks-open.ts`, `tasks.ts`, `demo-tasks.ts`
- `packages/cli/src/cli.ts` (the `tui` action only)
- `packages/cli/test/tui-tasks.test.ts` (new), `packages/cli/test/tui-load.test.ts`, a test in `packages/local/test` for the list order
- `packages/testkit/src/task-adapter-contract.ts` (the order case; the memory adapter already meets it)
- Not touched (Decision 1 = C): `pipeline-core/src/tasks.ts`, the `local` adapter, the MCP tools.

## Rejected review findings

- `[invariants]` "Decision 1 / Step 1: created_at is an agent-visible change, needs clipping, testkit file missing" and `[gaps]`/`[scope]` the same: not rejected, **avoided**: Decision 1 now recommends C, so no field is added;
  if the person picks A, the clipping, testkit, docs and Server contract test become part of the task.
- `[scope]` "split into two tasks": kept as one (Decision 6) with the build order screen first; the person may split at step 6/7.
- `[gaps]` "mouse on the Tasks screen" (info): not added, parity with the Pipeline screen (Decision 7).
- `[invariants]` "re-open the service on config change": not done; the off line tells the person to restart the TUI (one read at start, same rule as the MCP server).
- `[tests]` "Compatibility: t41 tests and Bun-only API": covered by `bun test` and `check-artifact.mjs`; no extra test.
- `[invariants]` "the plan says redacted with `plain`": wording fixed (service redacts what comes in; `plain` only cleans the shown error).

Second round (recheck): all answered by a fix, none rejected, except: `[scope]` "cut the extra tests (validation, problems line, write-methods-throw)": **kept** (they guard Principle 1 and 6 and the
silent loss of files; they are cheap), while the priority-from-`schema()` read and its test were cut as asked. `[scope]` "the cadence is more than the task needs": kept, it is the no-stall invariant, and now tested.
Fixed in the second round: in-flight guard and newest-wins (scheduler), redaction claim removed from the failure test, a testable scheduler, the 200-row screen test, step order by halves, read-all/filter-at-render
for the Backlog, the conformance case for the order, the first read at start, the Sessions `pick` vs the Tasks-screen selection, `unreadable` at `load.ts:144`, the store root, focus to the list on fallback, one test per row.

Every other finding of the critique is answered in the sections above: selection and mouse tagging (Risks, step 5), the 200-task Backlog query (Decision 5, step 3), detached read (Risks, step 4), stale card
(step 5, tests), unreadable/disabled runs (Decision 4), sort and ties (Decision 1 = C, so no TUI sort and no tie rule; a test pins the adapter's), z/SHARED_KEYS (step 5), no-runs case (step 5), problems line, zod
validation, priority fallback, narrow terminals and hints, the test list.

## Rework after the final gate

The person tried the change and sent it back with five comments. This section is what was done for them; it replaces the earlier text where they differ.

1. **Colours.** The key is dim, the priority is coloured (`high` red, `low` dim, `normal` and any other name as given), the group headers and the state words have the colour their group has
   in Sessions (TODO yellow, IN PROGRESS cyan, DONE green, a declined task dim), the Backlog heading is bold yellow, a run's state in the card has its Sessions colour, the captions are dim, the
   parent is cyan. The body and the comments stay plain. Widths are unchanged (`fit` counts visible columns).
   Tests: `task_g4jy_colours_key_and_priority`, `_colours_groups_and_states`, `_colours_backlog_header_and_run_states`, `_colours_do_not_change_the_width`.
2. **A symbol for a child.** In the Tasks list a child whose parent is on the page has `└ ` before its key (it replaced the two-space indent; the row is still key, title, priority). Tests:
   `task_g4jy_child_symbol_in_the_list`, `_child_symbol_keeps_the_row_to_key_title_and_priority`. The same two characters of width as before, so the title is no narrower.
3. **Subtasks in the card.** Under the body a `SUBTASKS` block: key, priority, status, title (priority and status from the rows the list read; a subtask that is not on the page shows key and title), with
   `· done/total done` in the caption when every subtask is known. The cursor of a focused card walks the items (the parent line, the subtasks, then the runs that are in Sessions); Enter on a
   subtask opens its card on top of the one shown (a stack, `Model.tasks.drill`); Esc or Left takes the last one off; a subtask's card has `parent: KEY` as its first item, and Enter on it goes back to the parent when
   the parent is under it on the stack (it is taken off, not put on again), else it opens the parent. The same in the Backlog card of Sessions (the pick stays the Backlog row). The stack and the item cursor are
   emptied when the person goes to another screen or another row. A card without items keeps ↑↓ as scrolling. Tests: `task_g4jy_card_shows_subtasks_under_the_body_with_priority_and_status`,
   `_card_counts_finished_subtasks_when_all_are_known`, `_subtask_off_the_page_shows_key_and_title`, `_card_arrows_walk_the_items`, `_enter_on_a_subtask_opens_its_card_and_esc_comes_back`,
   `_enter_on_the_parent_row_goes_back_to_the_parent_on_the_stack`, `_enter_on_a_parent_that_is_not_on_the_stack_opens_it`, `_opening_a_subtask_asks_for_its_card_once`,
   `_what_was_opened_is_let_go_when_the_person_goes_elsewhere`, `_drill_works_in_the_backlog_card`.
4. **Comments (relaxes the earlier read-only decision; an assumption the person should confirm).** The person asked "why is there no comment management?" and chose neither option offered, so option A was assumed:
   `c` on a task's card (Tasks screen or Backlog card; the task shown, also one opened from the card) opens a one-line input at the bottom, `Comment on KEY: …`; Enter saves, Esc cancels, an empty text saves nothing, at
   most 500 characters (`TASK_LIMITS.comment`). `c` works only while a task **card** has the focus, never from a list row. A paste is handled structurally (see item 6 below). The loop writes it through `TuiOptions.addTaskComment`. The wiring
   gives it only a function that calls `TaskService.update({key, comment})`: the readers (`list`, `get`) still have no way to write. "The TUI never writes a task" now means: **the only write is the comment a person types
   with `c`**; no status, priority or other field, and no delete (the adapter's comments are append-only). The result is told in the notice line (`Comment saved.` or `Could not add the comment: …`), and the card is read again.
   In `--demo` the comment is kept in memory for the life of the options. Tests: `task_g4jy_c_opens_the_input_on_the_task_card_of_the_tasks_screen`, `_c_opens_the_input_on_the_backlog_card`,
   `_c_comments_on_the_task_that_was_opened_from_the_card`, `_c_does_nothing_on_a_run`, `_comment_enter_saves_it_as_an_effect`, `_comment_escape_cancels`, `_comment_with_no_text_saves_nothing`,
   `_comment_backspace_and_keys_are_text`, `_comment_is_at_most_500_characters`, `_pasted_comment_ends_at_its_line_break`, `_the_mouse_is_ignored_while_a_comment_is_typed`, `_the_hint_lists_the_new_keys_last`,
   `_only_c_writes_a_comment` (replaces the "never writes" claim: no key script without `c` yields a write, and `c` + text + Enter + `y` (each a lone key after a pause) yields exactly one comment effect), `_the_real_writer_updates_only_the_comment`,
   `_a_refused_comment_is_an_error_with_the_trackers_words`, `_the_options_carry_the_writer_only_when_there_is_one`, `_demo_comment_shows_on_the_card_and_is_written_nowhere`, and in the loop
   (`tui-run.test.ts`) `task_g4jy_tui_loop_writes_a_task_comment` (saved and told; a refusal; a host with no writer).
   `task_g4jy_tui_never_writes_tasks` stays: the readers cannot write.
5. **Runs.** A `RUNS` block after the subtasks: the id, the state and the run's name for a run that is in Sessions (an item the cursor can reach), the plain id for one that is not (no jump). Enter on a run
   goes to Sessions with that run selected and remembers the card (`Model.back = {section, key, drill}`); Esc from the list there returns to the same card (the Tasks screen or the Backlog), with what was opened
   from it. The hint says `Esc back to KEY`. `back` is let go when the person uses Tab, 1-4, the menu with the mouse, another row, or the Pipeline screen's open. The tagged selection holds: the jump sets the pick to
   a run, and coming back sets it to the task. Tests: `task_g4jy_runs_block_marks_the_runs_that_are_in_sessions`, `_enter_on_a_run_goes_to_it_in_sessions`, `_esc_comes_back_to_the_same_task_card_on_the_tasks_screen`,
   `_esc_brings_back_what_was_opened_from_the_card`, `_esc_comes_back_to_the_backlog_card`, `_back_is_let_go_when_the_person_goes_elsewhere`, `_a_run_the_list_does_not_have_has_no_jump`,
   `_run_keys_stay_inert_after_a_jump_back_to_a_task`.
6. **The review's minors that were cheap.** An empty Tasks list: the card says `No task selected.` and `z` does nothing (`task_g4jy_empty_list_card_says_no_task_selected_and_z_does_nothing`). With no runs and a
   non-empty Backlog the first task is picked at once, with its card asked for, so Enter, `z`, `t` and `c` work from the start (`task_g4jy_first_backlog_task_is_picked_when_there_are_no_runs`,
   `_a_run_arriving_does_not_take_the_pick_from_a_task`; the older no-runs and effect tests were changed to match). The `local` order test had its names swapped and a garbled comment; fixed, and it says why
   there is no case of a record without `created_at` (the schema requires it). Not done: retrying a failed read of a run's detail after a round trip through a Backlog row (cosmetic, the next refresh reads it).
7. **Files.** New tests are in `packages/cli/test/tui-tasks-card.test.ts` (the old file kept the earlier ones). The card, the colours and the items are in `tui/tasks.ts` (`taskCardView`, `cardItems`, `scrollTo`);
   the keys, the stack, the jump and the comment input are in `tui/view.ts`; the writer and the options are in `tui/tasks-open.ts`, `tasks-load.ts` (`TaskCommenter`) and `run.ts`; the demo has a second child of
   `KDL-8W5T` (finished, so it is in the DONE group) and keeps the comments typed in it.

## Findings in the code

- `view.ts:80` `SECTIONS` has `"Tasks"` at index 2; `render()` shows a placeholder; `hitTest`/`mouseEvent` act on section 0 only; `emptyState()` is returned when `sessions.length === 0` (~1190).
- `selectedSession` (280) falls back to `sessions[0]`; it feeds `detailOf`, `normalized`, `cardKey` (526), `scrollCard` (812), `decide` (820), `hints` (1108), `updateKey` a/r (361), `hitTest` (1237), the wheel branch (1274), and
  `run.ts` `ensureDetail` (84-108).
- `view.ts` `Hit` (1208), `listLines` `ids[]`, `mouseEvent` writing `selected: hit.id`, `withData` (248) resetting `selected` to the first run.
- `z` is in `SHARED_KEYS` and handled with `if (m.section !== 0 || m.sessions.length === 0) return m` (341-347); `pipesUpdate`/`reportUpdate` are the pattern for a section with own state; `panes()` and `layoutOf` for list+card.
- `run.ts`: `load()` is awaited in the 2 s refresh behind one `refreshing` flag and before first paint; `load_stats`/`ensureDetail` are the pattern for detached reads and effects.
- `load.ts` `buildSession`: `unreadable(...)` is returned when `state` is undefined (no key to read); `problem(...)` has a state. `RunState.taskKey` (`run.ts:322`) is kept by the format 1 codec (`formats/v1.ts:58`) and set only when the run is linked to a task
  (`pipeline-host.ts:699`; none for `on_run.mode: disabled` or a failed prepare, `run-task.ts:16,80`).
- `pipeline-core/src/tasks.ts`: `TaskSummary` has no dates; `Task.created_at` does; `TaskService.list/get/schema` return `ToolResult` (`{ok, ...unknown}`), failures are values; each call bounded by `timeout_s` (default 30 s).
- `local-adapter.ts`: statuses `todo|progress|done|declined` (declined is state done), priorities `high|normal|low`; `list()` sorts by priority rank, `created_at`, key across all states (~410, 620), `MAX_TASKS` 5000; `problems` are returned by `list()`.
- `openTaskService` (`packages/local/src/tasks/index.ts:47`): `undefined` when off, `CONFIG_INVALID` when bad; `cli.ts` `tasksService()` turns off into `TASKS_DISABLED`, so the TUI cannot use it.
- Test style: `tui-pipelines.test.ts` and `tui-load.test.ts` drive the model and fake sources without a terminal; `tui-neutralize.test.ts` is the pattern for escape codes. No T-id for this TUI work is known.
- `fit`/`wrapText` neutralize; `draw()` neutralizes again; `hint` line already overflows below ~90 columns and `fit` cuts from the right.

## Approved at the gate

The person approved the plan with one change: a row of the Tasks list shows **only the key, the title and the priority**. No status
column, no run count and no `↳ PARENT` mark: a child whose parent is on the list is set in by two spaces, and the status, the run
count and the parent are in the card. The tests that named a parent mark or a run count test the indent instead
(`task_g4jy_tasks_screen_parent_mark`, `task_g4jy_tasks_screen_lists_only_key_title_and_priority`).

6. **Pastes can never write (third review round).** `runTui` turns bracketed paste on (`ESC[?2004h`) when the screen is taken over and off (`ESC[?2004l`) on every way out (`restore()`). `input.ts` has a
   stateful reader (`createInputReader`, one per session; `parseInput` is a fresh reader for a chunk that stands alone) that follows a paste across chunks and across cut markers, gives it as one `paste` event
   and reads nothing in it as keys; a paste over 64 KiB is dropped up to its end marker, and one whose end never comes is given up after 5 s of silence. `applyInput` hands a paste to `pasteText`: with a comment
   input open (task or gate) the text is added as one line (line breaks and control characters become spaces; 500 characters for a task comment) and nothing is saved; with none open it is ignored whole. A comment
   being typed is cancelled with a notice when the card moves on to another task (a reload drops it, or the Backlog task gets started), so Enter cannot save to a task the card no longer shows.
   Tests: `task_g4jy_paste_split_over_three_chunks_outside_typing_does_nothing`, `_paste_on_a_card_does_not_open_a_comment`, `_probe_without_brackets_cannot_open_a_comment_from_a_list_row`,
   `_c_on_a_list_row_opens_nothing`, `_bracketed_paste_into_an_open_comment_is_one_line_and_does_not_save`, `_pasted_comment_is_cut_at_500_characters`, `_paste_outside_an_input_is_ignored_whole`,
   `_paste_into_a_gate_comment_input_is_text`, `_paste_markers_split_anywhere_still_make_one_paste`, `_a_lone_escape_before_the_marker_is_still_a_paste_start`, `_an_unterminated_paste_is_capped_and_dropped`,
   `_a_paste_whose_end_never_comes_is_given_up_after_a_silence`, `_a_paste_longer_than_the_cap_in_one_chunk_is_dropped`, `_a_comment_is_let_go_when_the_card_moves_on_to_another_task`,
   `_a_comment_is_let_go_when_the_backlog_task_leaves_the_block`, `_a_comment_stays_while_the_task_stays_on_the_card`; in `tui-input.test.ts` the paste event and the switches; in `tui-run.test.ts` paste mode
   on at start and off on `q` and on Ctrl-C, and a bracketed paste in the loop not read as keys.

7. **A comment is a deliberate act (fourth review round, layered guards).** The earlier claim "a paste is never saved by itself" held only for one chunk; a paste split over chunks, or one with an end marker inside, got
   through. Saving now takes three separate steps and none of them can come out of pasted text: (a) **confirmation**: Enter in a task-comment input does not save, it shows "Save this comment to KEY? y save · any
   other key edits · Esc cancel «…end of the text»", and only `y` produces the `add_task_comment` effect; any other key goes back to the text (kept), Esc cancels all; (b) **lone key**: Enter and `y` count only when they
   are the whole of their stdin chunk (`applyEvents` passes `alone = events.length === 1`), typed characters still work in bursts; (c) **pauses**: Enter is ignored for 400 ms after the input opened and `y` for 400 ms
   after the question appeared (the model's clock, `m.now`, which `applyInput` sets from an injectable `now`). Also: the input line and the question show the **tail** of a long text and the cursor, so the person sees
   what `y` would send; the 500 cut never splits a surrogate pair and a lone surrogate is dropped before the text reaches the tracker; a bracketed paste into a gate comment is cut at 500; changing screen resets the
   focus to the list, so `c` cannot open on a card the person did not open on that screen; the paste give-up timer runs from the **start** of the paste (5 s) and Ctrl-C quits even inside a paste; a lone ESC or a
   cut-off start marker is held for 50 ms (`HOLD_MS`; `reader.flush`, called from a timer in the loop) and is the Escape key only if nothing continues it, so a cut marker does not cancel an open input or fire
   the way back; the terminal (paste mode, mouse, alternate screen, cursor, raw mode) is put back on SIGINT, SIGTERM and SIGHUP too, and the signal is raised again.
   Tests: `task_g4jy_comment_enter_asks_and_y_saves_it_as_an_effect`, `_comment_needs_a_lone_enter_and_a_lone_y_after_pauses`, `_a_line_break_that_comes_with_other_text_is_not_enter`,
   `_any_key_but_y_on_the_question_goes_back_to_the_text`, `_escape_on_the_question_cancels_everything`, `_a_y_inside_the_pause_after_the_question_is_ignored`,
   `_enter_inside_the_pause_after_the_input_opened_is_ignored`, `_a_paste_while_the_question_is_up_does_not_touch_the_text`, `_the_input_line_shows_the_end_of_a_long_text_and_the_cursor`,
   `_the_question_shows_the_end_of_a_long_text`, `_the_cut_at_500_never_splits_a_character`, `_a_lone_surrogate_is_not_text_and_does_not_reach_the_tracker`,
   `_a_paste_into_a_gate_comment_is_cut_at_500_characters`, `_c_never_opens_on_a_task_the_person_did_not_pick_on_the_new_screen`, `_an_end_marker_inside_the_pasted_text_cannot_save_a_comment`,
   `_a_paste_split_after_c_cannot_save_a_comment_without_brackets`, `_ctrl_c_quits_even_inside_a_paste_or_its_discarded_rest`, `_a_paste_whose_end_never_comes_is_given_up_5_seconds_after_its_start`,
   `_a_held_escape_is_the_escape_key_after_a_short_wait`, `_a_held_escape_with_an_arrow_cut_after_it_is_the_arrow`, `_a_cut_marker_does_not_cancel_an_open_comment_or_restore_back`,
   `_a_cut_off_marker_that_is_not_continued_is_dropped_and_keys_work_again`; in `tui-run.test.ts` the signals restore the screen and raise the signal again, the handlers are removed on quit, and a cut paste
   marker does not press Escape in the loop.

8. **Fifth review round.** (a) The text sent is the text the person confirmed: the `plain()` pass is gone (it removed ZWNJ, ZWJ and variation selectors, so a Persian word or an emoji sequence changed on the
   way); only control characters (C0, DEL, C1) and lone surrogates are removed (`cleanComment`), controls are not taken as typed text, and a text with nothing visible in it (spaces and the zero-width characters
   `trim` keeps) is refused at Enter with "Nothing to save: the comment is empty." so the person is never asked to confirm a text the service will refuse. (b) A paste given up after 5 s hands on what it held as text
   and drops the rest up to its end marker; a pause of `DISCARD_GAP_MS` (1 s) between two chunks ends the dropping, so a terminal that never sends the end marker gives the keys back after a pause while a slow link
   that dribbles the paste in (pieces closer than that) never makes keys; Ctrl-C always works. (c) A chunk that is exactly `\r\n` or `\r\0` is one Enter; with other bytes it is not (since round 6 the reader does this, see item 9). (d) Enter or `y`
   pressed inside the 400 ms pause says "Wait a moment, then press Enter again." / "...then press y." on the input line instead of doing nothing, and `Y` is accepted as `y` through the same guards. (e) The
   signal handler puts the terminal back inside `try/finally`, so the signal is raised again even when the tty is gone; on Windows only SIGINT and SIGTERM are handled and the process ends with the usual code
   (130 / 143) instead of `process.kill` with a signal the platform does not support. (f) `finish()` runs once: the hold timer is not set after it, the `exit` listener is removed, and an answer that arrives
   later (a tasks read, a write) does not draw after the screen is given back.
   Tests: `task_g4jy_the_text_the_person_confirmed_is_the_text_that_is_sent`, `_clean_comment_removes_controls_and_lone_surrogates_and_nothing_else`, `_a_control_character_is_not_taken_as_typed_text`,
   `_a_comment_with_nothing_visible_is_refused_at_enter_with_a_notice`, `_enter_inside_the_pause_says_to_wait_instead_of_dropping_silently`, `_y_inside_the_pause_says_to_wait_and_a_capital_y_saves_after_it`,
   `_enter_as_crlf_or_cr_nul_is_one_enter_and_confirms`, `_crlf_with_other_bytes_is_not_the_enter_key`, `_a_slow_link_that_dribbles_a_paste_in_never_makes_keys`,
   `_a_broken_terminal_with_no_end_marker_gives_the_keys_back_after_a_pause`, `_text_that_came_before_the_give_up_stays_in_the_open_comment`; the paste tests now run on an advancing clock shared by the reader and
   the model, so they hold by the bracket rule or the lone-key rule and not only by the 400 ms pause: `_an_end_marker_inside_the_pasted_text_cannot_save_a_comment`,
   `_a_line_break_with_text_after_the_pause_asks_nothing`, `_a_bracketed_paste_with_line_breaks_after_the_pause_asks_nothing`, `_a_paste_split_after_c_cannot_save_a_comment_without_brackets`, and
   `_a_person_pressing_enter_and_y_at_human_speed_does_save` (the positive case); in `tui-run.test.ts`: `_a_signal_is_raised_again_even_when_the_terminal_cannot_be_restored`,
   `_windows_has_no_sighup_handler_and_ends_with_the_usual_code`, `_q_followed_by_a_held_escape_finishes_once`, `_a_late_tasks_answer_does_not_draw_after_the_screen_is_given_back`.

9. **Sixth review round.** (a) The folding of `\r\n` / `\r\0` into one Enter moved into the reader (`foldLoneEnter` is gone from `run.ts`): the reader folds a chunk that is exactly one of these only when it is
   in plain key mode, nothing is held back and nothing else came out of this call; inside a paste, in the dropped rest of one, or after a held ESC the bytes are what the reader reads without folding (nothing, or
   the held Escape and two Enters), so a paste can no longer reach "save it?" or turn Esc into Enter. (b) The **gate** comment input got the same guards as the task one for Enter: it counts only as the whole of its
   chunk and not within 400 ms of the input opening (`Input.openedAt`), and says "Wait a moment, then press Enter again." on the input line; it still saves with that one Enter (no confirmation step). Enter that
   comes with other bytes in a task comment also says so instead of being dropped silently. (c) A paste that is given up (5 s after its start) or that is too long to keep is handed on as a `paste` event with
   `givenUp`, even when it is empty, and the model says "Paste given up; keys dropped until you pause for a second." The give-up and the end of the dropped rest also happen by the clock: the loop calls
   `reader.flush(now)` on its 100 ms timer, so the text held so far appears in an open comment without a keypress (`flush(Infinity)` still only lets go of a held ESC or marker, it does not give up an open paste).
   An Enter that arrives in the same list as the give-up is not alone, so it is not taken and says "Wait a moment". (d) A paste while the save question is up says "Press y to save, any other key to edit; pasted
   text was ignored." (e) The exact rule of the dropped rest, as implemented: after the give-up every chunk is dropped up to the end marker, or until **more than 1 s passes between two chunks** (by the clock or by the next
   chunk), then keys are read again. So a slow link whose pieces come closer than a second never makes keys, and one that pauses longer than a second after the 5 s mark has the rest typed as keys; that is
   deliberate: it is what lets a terminal that never sends the end marker give the keys back. Ctrl-C works in every state.
   Tests (`tui-tasks-card.test.ts`, "what the sixth review found", and `tui-neutralize.test.ts`): `task_g4jy_crlf_inside_an_open_paste_is_paste_text_and_not_enter`, `_crlf_in_the_dropped_rest_of_a_paste_is_not_enter`,
   `_crlf_after_a_held_escape_does_not_turn_escape_into_enter`, `_a_lone_crlf_in_plain_typing_is_still_one_enter`, `_a_given_up_paste_hands_on_its_text_and_says_why_keys_are_dropped`,
   `_a_give_up_inside_a_burst_keeps_the_text_before_it_and_tells_the_person`, `_with_a_gap_over_a_second_after_the_five_seconds_the_rest_is_typed_as_keys`,
   `_the_timer_gives_up_a_paste_and_ends_the_dropped_rest_without_a_key`, `_infinity_gives_up_what_is_held_and_not_an_open_paste`, `_text_held_by_the_timer_appears_in_the_open_comment_without_a_key`,
   `_enter_in_the_list_of_the_give_up_is_not_silent`, `_a_paste_while_the_save_question_is_up_says_it_was_ignored`, `_a_non_alone_enter_in_a_task_comment_tells_the_person`; for the gate input:
   "a gate comment: Enter in a burst, or too soon after it opened, is not taken and says so" and "a gate comment: a paste with a line-break-only chunk in the middle saves nothing". The two gate tests that
   used to say "a line break inside a chunk ends the comment" now say the opposite (Enter must be a chunk of its own, after the pause).

## Where the code differs from the plan

- **No zod in the loader.** `packages/cli` does not depend on `zod` (only `pipeline-core` and `local` do), and adding it needs a lockfile change.
  `tasks-load.ts` checks the rows with small type guards instead; the behaviour is the one planned (a bad row is dropped and counted, `ok:false` is
  an error state, nothing throws into `render`).
- **`Pick` is `Picked`** in `tasks.ts` (it would hide the TypeScript `Pick`). `Model.pick` is `{kind:"run"} | {kind:"task", key}`; the run is still
  `Model.selected`, and `selectedSession` returns nothing while a task is picked, which is how every run-scoped key, card and read is cut off.
- **`tui.test.ts`** had a test that no screen holds the letters `ACK`; the heading `BACKLOG` does. The test now looks for the engine's words as whole words.
- **A card is asked for by an effect** (`load_task`) when a task is selected in either screen, and again with every list read by the scheduler
  (`tasks-refresh.ts`); the `t` jump marks the card as asked for, so the Tasks screen does not ask a second time.
- **Demo:** 11 sample tasks (the plan said about 9); the run `report-html-export` carries `taskKey: KDL-4H7P`, so the Backlog shows `5 of 7`.
- **Not run by this step:** the full suite, lint and build (the engine runs them). `biome check --write` was run on the files touched only.
  `cli.test.ts` has two tests that fail in the sandbox only (`ps` is not allowed: EPERM); they do not touch this change.
- **`t` from a drilled Backlog card** goes to the base task of the pick on the Tasks screen, not to the subtask that was opened from it.
- **Opening an input ends the chunk** (`applyInput`): a paste that holds a `c` can never open a task comment and save it in one go; the comment is saved
  only from a later chunk. Failure notices (`Could not…`, `Cannot…`) are drawn in red, successes in green.
- **A terminal without bracketed paste** can still deliver a long paste as plain typing, and one that does not strip the end marker from what it pastes can end a paste early. Bracketed paste is
  only a convenience, and the guarantee is **not structural**: without brackets (or after the paste reader gave up), the last defence is timing plus the visible confirmation. A paste that ends in `...\ry`, delivered over a
  link that stalls more than 400 ms right before the `\r` and again before the `y`, would reach the question and then save; the person sees the question with the end of the text, and only the lone `y` saves.
  The layers of items 7 and 8 (confirmation, a lone key, pauses, a visible tail, discarding what comes after a given-up paste) make that an unlikely accident, not an impossible one.
- **`c` on a card whose read failed or is still loading** still opens the input; the write then fails closed at the tracker with its own message (`Could not add the comment: ...`).
