# TASK-5M9D: MCP roles (`kodel mcp --role worker|manager`, `--read-only`, `mcp.roles`)

## TL;DR

- `kodel mcp` gets `--role worker|manager` and `--read-only`. One pure function in pipeline-core picks the
  final tool set (role, then `mcp.roles`, then `--read-only`); the server registers and dispatches only that
  set, and its instructions, answers and fingerprint follow it. No flag: every tool, as today. One PR with the
  whole task: seven manager read tools, the role stored in the journal (format 2 amended in place), an unusable
  `mcp` block stops the server. Decision 5M9D, tests `5m9d_*`.
- The second critique changed: a decision made through the manager no longer serves a step (it would have
  made `kodel serve` refuse to resume the worker); a config refusal at resume is not counted against the run's
  three resume attempts; `kodel init` keeps `--role` / `--read-only` of an existing server entry; the inbox
  also lists a finished run whose task waits to be closed; the watch has an interval, a bound and a defined
  cursor; "writes nothing" is tested over the whole run folder and six run states; a wrong claim about
  `sameExecutor` is replaced by the real effect of the role on the journal.
- Beyond the letter of the task, by the person's choice or as its consequence: the stored role, the server's
  exit on an unusable block with the launcher's check, `pipeline_next_step` marked a write.
- Cost: about 1700 lines of code and 2200 of tests, across pipeline-core, local and cli; review risk is high.
- Risky: a stored format is touched; the worker and any agent under `KODEL_ENGINE` lose `history_*`,
  `task_update` and the decision tools; a typo in the `mcp` block stops every `kodel mcp` of the project and
  idles `kodel serve`.

## Decisions needed

1. **The role in a run of format 1.** The role is a nested key of journal records (`engine.role`,
   `executor.role`). Format 1 is written by the published `0.1.0-beta.0` and by runs in flight, so its shape is
   frozen (rule 4). (a) Not recorded there: a new capability `executorRole` is `false` for format 1, the host
   leaves the key out, and the run goes on as before; `status` and `report` show no role for it. (b) Recorded
   there too: nothing in the codec refuses a nested key, but it grows the frozen format. (c) Refused with
   `UNSUPPORTED_FORMAT_FEATURE` and the offer of `kodel migrate`: this would stop every format-1 run in flight
   at its next step for a field that decides nothing. **Recommendation: (a).** **If no answer: (a).**
2. **A config whose YAML does not parse.** When the file parses, only a problem in the `mcp` block stops
   `kodel mcp`; a bad value elsewhere falls back as today. When it does not parse, the block cannot be read at
   all. (a) Stop only if the text has a top-level `mcp:` line (the person narrowed the set and it cannot be
   read); without that line behave as today. (b) Always stop. (c) Never stop for a parse error.
   **Recommendation: (a)**: it is the closest to "only a problem in the `mcp` block stops the server".
   **If no answer: (a).**

3. **`manager_gate_changes` and git objects.** The changes at a gate are computed by the snapshotter
   (`local/src/git.ts`: `hash-object -w`, `write-tree` on a scratch index), which writes unreferenced objects
   into the repository's git object store, as the gate answer of `pipeline_next_step` and `kodel gate` do
   today. No ref, no index, no working file and no file of the run changes. (a) The tool is marked read-only
   and stays under `--read-only`; the docs state this one effect, and the test compares everything but
   `.git/objects`. (b) It is marked a write: a manager has it, a `--read-only` server does not. (c) A second
   way to compute the changes without writing objects: more code in `git.ts` and two ways to drift.
   **Recommendation: (a).** **If no answer: (a).**

Decided by the person, not open: one PR (1a); the task key is the decision id; no copies of
the history tools (3a); the role is stored (4b); a wrong start command exits non-zero (5a); an unusable `mcp`
block stops the server (6a); `pipeline_next_step` is a write (7a); no limit for the manager (8b).

## Behaviour change

- `kodel mcp` with no flag, outside `KODEL_ENGINE`: today's tools plus the seven `manager_*` read tools.
  `pipeline_next_step` is listed with `readOnlyHint: false`. Existing `.mcp.json` files keep working. With an
  `mcp.roles` block the server serves the union of the two roles after it; a `remove` in one role removes a
  tool here only when the other role lacks it too, and the server says on stderr which removals do not apply.
- `--role worker`: `pipeline_start`, `_next_step`, `_take_step`, `_complete_step`, `_report_result`, `_list`,
  `_resolve`, `_plan`, `_docs`, `_feedback`, `_propose_change`, and with tasks on `task_get`, `task_list`,
  `task_schema`, `task_create`. No `history_*`, no `task_update`, no decision tool, and no word of them in its
  instructions, tool texts or answers. A run tied to a task with `tasks.on_run.mode: ask` ends with "tell the
  person the task is still open; they close it (`kodel task set`, or through a manager)".
- `--role manager`: `history_*` as they are, every `task_*`, `pipeline_list`, `pipeline_resolve`,
  `pipeline_docs`, `pipeline_propose_change` (a call with `run_id` is refused, not read as a project proposal),
  `pipeline_decide_gate` / `pipeline_accept_change` only under `decisions.agent`, and the new read tools:
  `manager_inbox` (gates with slug and attempt, pauses, changes of a run's pipeline with their hash, proposals,
  tasks to approve, a finished run whose task waits to be closed (`tasks.on_run.mode: ask`), dead serve
  workers; each with its command, and a proposal or a change with its summary and what differs, as
  `pipeline proposals show` / `pipeline changes show` print them), `manager_run_report`, `manager_gate_changes`,
  `manager_serve_status`, `manager_agents`, `manager_agent_log`, `manager_watch` (waits up to `wait_s` for an
  event in any run and returns the events and a cursor). The decision tools' texts point to the inbox. Their
  answer on this role is a short state of the run read with `inspect()`: no step is served and nothing is
  ticked, so the run's own worker is the one that goes on (and `kodel serve` still resumes it). A run that
  cannot be read is one marked row in the inbox, never a failed answer. On Windows, where no agents and no
  daemon run, the serve and agent tools answer "off" or an empty list with the reason, and the inbox answers
  with the rest.
- `mcp.roles.manager.add` may name any tool, the run tools too: the person can build a manager that also works
  a run, and with `decisions.agent` approves its own gates. That is what a server with no role already allows;
  `docs/mcp-roles.md` says it in these words.
- Under `KODEL_ENGINE` (every child of a session: serve and TUI workers, a command or check the engine runs, an
  agent a person started with `kodel agent exec`): no flag is the worker, `--role manager` does not start. Such
  an agent loses the `decisions.agent` allowance and the history; the person connects a manager from an agent
  started outside `kodel agent exec`. The mark is a guard against mistakes, not a security boundary.
- `mcp.roles.<role>.add|remove`: an unknown tool name, a decision tool for the worker, one of `pipeline_start`,
  `_next_step`, `_take_step`, `_complete_step` removed from the worker, or one name in both lists rejects the
  config (`CONFIG_INVALID`, the name in the message) for every command. `kodel mcp` then **does not start**:
  non-zero exit, the reason on stderr. A config with no `mcp` block, or with a problem only in another block,
  starts as today. A known name this server cannot serve (a task tool with tasks off, a decision tool without
  `decisions.agent`) does nothing and is named on stderr.
- Background workers: the server is `mcp --role worker --no-decisions --no-wait-hint`. The launcher resolves
  the worker's set from the config in `preflight`, and again inside `start` and `resume` just before it spawns
  `claude` (the daemon keeps a preflight for 60 s, and no resume path calls it). If the set does not resolve,
  nothing is spawned. The TUI shows the reason in its start and resume messages. `kodel serve` reads the whole
  config every cycle, so with an unusable block it is `idle` with the reason in its log and in
  `serve --status`, and starts and resumes nothing; a config refusal that still reaches a resume is not
  counted as one of the run's three resume attempts. The worker's two prompts say to stop if the kodel tools
  are missing, and the resume prompt says the tools may have changed since the session began.
- `kodel init` keeps `--role` and `--read-only` of a kodel server entry it rewrites (the Codex block on every
  run, the others with `--force`) and says so; `--server-command` still takes no `mcp`. No other launcher
  changes: `init` writes the person's own agent's server (no role unless they add one), and an engine step
  starts no `kodel mcp` of its own (`engine-steps.ts` only sets a host option).
- `--read-only`: only tools marked read-only, on top of role and config; no `pipeline_next_step`.
  `--role worker --read-only`, `--role manager` or a bare `--read-only` under `KODEL_ENGINE`, and an unknown
  `--role` do not start: non-zero exit, the reason on stderr. Outside a project the role and `--read-only`
  apply too.
- History: new runs record the role of the server that started them (`worker`, `manager` or `all`) and of the
  server behind each served step; `kodel report`, `history_run_details` and `manager_run_report` show it.
  `tools_hash` gets new values. `CONTRACT_VERSION` 5 -> 6. The release note has its own line for
  `pipeline_next_step` now listed with `readOnlyHint: false` (not asked by the task; found while planning).

## Risks and invariants

- **P1 untrusted input / P2 fail closed.** The set is chosen before the server is built, from flags,
  environment and config, never from a call. A tool outside it is not registered and not in the list its
  dispatcher searches. Roles are allow-lists: a tool in no role is served by no role and fails a test. An
  unusable `mcp` block serves nothing (the server does not start). Flags are checked before any branch serves.
- **A worker without its server.** `claude -p --strict-mcp-config` with `dontAsk` would run with Bash and Edit
  and no kodel server if its server exited. The check inside `start` and `resume` closes the usual path.
  Residual, accepted and pinned by a test: a config edited in the seconds between that check and `claude`
  starting its server. The worker then has no kodel tool, its prompt tells it to stop, and the session ends as
  a dead worker that serve and the TUI report; the run and its task are as they were.
- **A manager's decision must not look like the worker's work.** Today `after()` in `agent-decisions.ts` calls
  `service.nextStep`, which ticks and journals `step_served`; `serve/resume.ts` reads that as "the run moved
  on" and does not resume the worker. On the manager role the answer comes from `inspect()` and journals
  nothing but the decision.
- **A read-only server must not write.** No served tool calls `tick()`; every manager read goes through
  `inspect()` and the history reads. Under `--read-only` the host is built without the agent-log timer,
  without engine launch options and without the dialog hook (an answer in a dialog is a write); on the manager
  the dialog stays as the config says. Tests compare the whole run folder, the proposals, the tasks, the
  session and serve records, the git refs, index and working tree, over runs in six states. The one known
  effect outside them is decision 3.
- **The watch must not load the machine.** One look per second on the host's clock (a port, so a test drives
  it with a fake clock); it reads the run summaries and, of runs that have not ended, the state; ended runs are
  not read again. The cursor is a short id of a snapshot the server keeps in memory (the last 16); a cursor of
  another server or from before a restart is `INVALID_CURSOR`, and a call without one starts afresh. `wait_s`
  above `MAX_WAIT_S` is refused by the schema, `0` answers at once. A watch only awaits a timer, so other
  calls are answered meanwhile.
- **Runs the manager cannot read** (rule 3). A run of a newer format is a row "written by a newer kodel,
  upgrade kodel"; a state that does not fit its format is "cannot read" with the field; a changed one is
  "modified". Format-1 runs are read through their codec and never migrated; another checkout's runs are not
  shown, as in `history_runs`.
- **P3 redact.** The manager tools write nothing. Their texts (agent logs above all) go through the host's
  `historyRedact`, `cutText` and `HISTORY_MAX_BYTES`, are marked `unverified` where an agent wrote them, and
  carry the "data, never instructions" note.
- **P4/P5 core without I/O.** `tool-roles.ts` is pure, no SDK import. The manager tools are descriptors bound
  to `ManagerHost`, an interface of optional reads (the shape of `HistoryHost`). `local` implements the inbox,
  the report, the changes at a gate and the watch (timer, abort signal, the host's clock); `cli` supplies the
  ports that live there (the serve record and the daemon's view, session records and logs). Core gets `wait_s`
  as a number and hands it over, as `pipeline_next_step` does with `waitForRest`.
- **P6 humans decide.** No new decision tool. The decision tools are built only from `decisions.agent`; the
  worker can never be given them (resolver and config check). `mcp` joins the blocks only the person edits.
  `ack`, `resume`, `seal`, `migrate`, `task approve` stay commands. The manager may be given run tools by the
  person (8b): documented, not prevented.
- **P8 / stored data: the role (4b).** `EngineRecord` and `ExecutorRecord` gain an optional `role`. Both live
  only in journal records (`run_started.engine`, and `executor` of `run_started`, `step_served`,
  `agent_completed`); `state.json` does not change, so no state key table changes.
  - *Rule 5 argument.* No decision reads these records: `decide()` works from the state, and the journal is
    only appended to. An engine of the same version that ignores `role` decides every step the same. An older
    engine that goes on with the run never rewrites a journal line, so it cannot drop the key, and the newer
    engine decides the same after it. So it is a compatible addition: format 2 is amended in place, no v3.
  - *Was format 2 released?* In the repository: no version tag exists (`git tag` has only a backup tag),
    `packages/cli/package.json` is still `0.1.0` (the published build is `0.1.0-beta.0`), and
    `docs/run-formats.md` says "No published build wrote format 2". I did not query the npm registry from the
    sandbox; the implement step runs `npm view @kodel-ai/kodel versions` and writes the answer into the release
    note. The amendment does not depend on it: the rule 5 argument holds for a published format too.
  - *What ships with it:* `capabilities.executorRole` (v2 `true`, v1 per decision 1), the codecs unchanged in
    `decode` (v2 already keeps unknown nested keys) and checked in `encode` by capability, a real fixture
    `fixtures/formats/v2-roles/` (a run started by a no-role server and worked by a `--role worker` server), the
    round-trip test, the fixture directory registered for `t41_registry_matches_fixture_directories`, and a
    section in `docs/run-formats.md` saying what a run in flight does (nothing changes; new records carry the
    role).
  - *What the role does change in a run.* The answers differ by role, so their `promptHash` differs, and with
    it the key that dedupes `step_served` (`servedKeyOf`): a run worked by servers of two roles journals more
    `step_served` records and counts them toward `MAX_SERVED_EVENTS` in the state (an existing field). That is
    bookkeeping of the history; when the cap is reached records stop, steps do not.
- **Session and serve records.** Not changed. Dead workers are read through the existing views.
- **User files.** `mcp` is a new optional block; the commands of an older kodel reject the key through
  `.strict()` and name it, but its `kodel mcp` catches every config error and serves everything with defaults
  (`cli.ts:476-487`). The docs say that every build that serves the project must know the block.
- **Kodel Server.** `resolveToolSet` takes the role table as an argument; `only` and the second argument of
  `toolsFingerprint` are optional. A client on contract 5 sees more tools and one changed hint, nothing removed.
- **Tests under the engine mark.** In a run of this repository `bun test` and `scripts/check-artifact.mjs` have
  `KODEL_ENGINE=1`: every test and script that starts `kodel mcp` and expects the full set strips it (as
  `cli.test.ts:166, 1148, 1430` do). The suite is run both ways.

## Acceptance criteria and tests

**Decision 5M9D:** *an agent connected to `kodel mcp` can call exactly the tools chosen by the role, the
person's `mcp.roles` block and `--read-only`.* **Refuted if** an agent connected with `--role worker` or
`--read-only` (or any role, or a server narrowed by `mcp.roles`) could call a tool outside its set, listed or
not; or if a `--read-only` server changed a run.

"Every name" is `KNOWN_TOOL_NAMES` plus two names that never existed, called through a real MCP client (the
harness of `mcp-no-decisions.test.ts`), with tasks on and off and `decisions.agent` on and off.

| Criterion | Test |
| --- | --- |
| A server narrowed by `mcp.roles` (a `remove`, and an `add` in the other role) refuses the removed tool through a client, tasks and `decisions.agent` on and off | `5m9d_override_narrowed_server_refuses_removed_tool` |
| A worker server in a project with `decisions.agent: true`: no decision tool, no rule 10, no decision wording in a `waiting` answer; the same with `--no-decisions --no-wait-hint` | `5m9d_worker_role_ignores_decisions_agent` |
| Role sets are exactly the lists of the task; no role is their union | `5m9d_role_sets_are_exactly_the_listed_tools`, `5m9d_no_role_serves_the_union` |
| Union with overrides in both roles; a `remove` in one role alone does not shrink it | `5m9d_union_follows_the_overrides_of_both_roles` |
| Every tool of every registry has a boolean mark and a role; `TASK_TOOL_NAMES` equals `buildTaskTools` for every capability profile | `5m9d_every_tool_has_a_mark_and_a_role`, `5m9d_task_tool_names_match_the_registry` |
| The write tools are the pinned list, `pipeline_next_step` among them | `5m9d_write_tools_are_the_pinned_list` |
| Order role, config, `--read-only`; `add` cannot bring a write back | `5m9d_read_only_is_applied_last` |
| Worker: every name outside its set answers "no such tool", also with `decisions.agent` on | `5m9d_worker_cannot_call_a_tool_outside_its_set` |
| Manager: the same; by default no start, next_step, take, complete, report | `5m9d_manager_cannot_call_a_tool_outside_its_set` |
| `manager.add: [pipeline_start]` is taken (8b) | `5m9d_the_person_can_give_the_manager_run_tools` |
| `--read-only`: the same; every listed tool has `readOnlyHint: true` | `5m9d_read_only_serves_only_read_tools` |
| After every tool of a `--read-only` server and every `manager_*` tool is called, the whole run folder (state, journal, `served/`, snapshots, agent-log copies, usage, tool calls), proposals, tasks, session and serve records, git refs, index and working tree are byte-identical; over runs with a dead owner of engine work, at a gate, paused, with an open pipeline change, in a fork with claims, and an open format-1 run (which stays format 1) | `5m9d_read_only_server_leaves_everything_as_it_was`, `5m9d_manager_read_tools_only_read` |
| A manager's `pipeline_decide_gate` / `pipeline_accept_change` journals the decision and no `step_served`, starts no engine work, and the serve resume plan still resumes the worker | `5m9d_manager_decision_does_not_serve_a_step` |
| Each registration hands its dispatcher the filtered list; an excluded name is refused by `invokeTool`, `invokeHistoryTool`, `invokeTaskTool` and the manager dispatcher | `5m9d_each_dispatcher_refuses_a_tool_outside_the_set` |
| Config: unknown name, decision tool for the worker, core removed, a name in `add` and `remove`: rejected and named; the schema is strict | `5m9d_config_names_an_unknown_tool`, `5m9d_config_refuses_decision_tools_for_the_worker`, `5m9d_config_refuses_removing_the_core_of_a_run`, `5m9d_config_refuses_a_name_in_add_and_remove` |
| Unusable `mcp` block, table-driven (unknown key under `mcp`, wrong type, unknown role, unknown tool, `mcp: null`): `kodel mcp` exits non-zero with the reason; `mcp: {}`, no block, an empty file: as today | `5m9d_unusable_mcp_block_stops_the_server` |
| A valid `mcp` block next to a broken `tasks` block: the server starts and serves the narrowed set, not the full one | `5m9d_a_bad_block_elsewhere_keeps_the_narrowed_set` |
| Unparseable YAML per decision 2 | `5m9d_unparseable_config_stops_only_with_an_mcp_line` |
| With an unusable `mcp` block `preflight`, `start` and `resume` spawn nothing and give the reason, also within the daemon's 60 s preflight cache; `openWorkerLauncher` does not swallow it | `5m9d_launcher_spawns_no_worker_whose_set_does_not_resolve` |
| `kodel serve` with an unusable block is idle with the reason and uses up no resume attempt; the TUI's start and resume messages carry the reason | `t44_5m9d_serve_idles_and_counts_no_resume_attempt_on_a_config_refusal`, `5m9d_tui_shows_the_config_refusal` |
| The accepted residual: a fake `claude` whose kodel server exits at start (and at resume) calls no tool, ends as a dead worker that serve reports, and the run is unchanged | `5m9d_worker_without_its_server_ends_as_a_dead_worker` |
| A session resumed over a narrower set: the removed tool answers "no such tool", the resume prompt says the tools may have changed, the run goes on | `5m9d_resume_over_a_changed_set_goes_on` |
| `kodel init` keeps `--role` / `--read-only` of an existing entry for every agent it writes | `5m9d_init_keeps_the_role_flags_of_an_existing_server` |
| A known name the server cannot serve is named on stderr; a decision tool in `manager.add` needs `decisions.agent` | `5m9d_an_unserved_known_name_is_reported`, `5m9d_decision_tools_still_need_decisions_agent` |
| Unknown `--role`, `--role manager` and bare `--read-only` under `KODEL_ENGINE`, `--role worker --read-only`: non-zero exit, reason, nothing served | `5m9d_wrong_start_commands_are_refused_before_serving` |
| Environment as `session-env.ts` builds it: no flag is the worker | `5m9d_under_the_engine_mark_the_server_is_a_worker` |
| Outside a project the role and `--read-only` hold; the T-42 guard still serves nothing | `5m9d_roles_hold_outside_a_project`, `5m9d_role_does_not_lift_the_engine_step_guard` |
| No tool name outside the served set appears in the instructions, the descriptions, or the worker's `waiting` / `done` answers (incl. `on_run: ask`), per role, flag and decisions state | `5m9d_texts_name_only_served_tools`, `5m9d_worker_done_answer_names_no_task_update` |
| No-role instructions equal a golden file, except an explicit list of replaced and added lines that the test itself holds and asserts one by one. The golden is generated from `main` and committed as the first commit of the branch, before any edit, and is never regenerated by the test | `5m9d_no_role_instructions_match_the_golden_text` |
| Manager `pipeline_propose_change` refuses `run_id` and unknown keys; the worker's takes `run_id` as today | `5m9d_manager_propose_change_is_strict` |
| On the manager, decision tools point to `manager_inbox` and answer with no step to do | `5m9d_manager_decides_from_the_inbox` |
| The inbox lists a gate (slug, attempt), a pause, a run change (hash, summary, what differs), a proposal (summary, what differs), a task to approve, a finished run whose task waits to be closed, a dead serve worker | `5m9d_inbox_lists_everything_that_waits_for_a_person` |
| A run of a newer format, a state that does not fit, a modified run, a `meta.json` format-1 run and another checkout's run: one marked row each (or absent), the inbox and the watch still answer | `5m9d_inbox_and_watch_survive_runs_they_cannot_read` |
| With `platform: win32` the serve and agent tools say off / empty with the reason and the inbox answers the rest | `5m9d_manager_ports_on_windows_say_why` |
| Run report, changes at a gate, serve status, agents, agent log: right content, redacted, bounded, `unverified` on agent text; a host without the port answers `HISTORY_UNAVAILABLE` | `5m9d_manager_answers_are_redacted_and_bounded`, `5m9d_manager_tools_without_a_port_say_unavailable` |
| `manager_watch`, driven by a fake clock of the host (no real timer): returns at an event of any run, at `wait_s`, at once for `wait_s: 0`, and when the call is cancelled; `wait_s` above `MAX_WAIT_S` is refused; a foreign cursor or one from before a restart is `INVALID_CURSOR` | `5m9d_watch_runs_on_the_hosts_clock_and_returns_on_event_timeout_cancel`, `5m9d_watch_refuses_a_cursor_that_is_not_its_own` |
| With 200 ended runs a look reads no ended run's state; another tool call is answered while a watch is open | `5m9d_watch_does_not_read_ended_runs_or_hold_the_server` |
| Fingerprint: same input, same text; differs by role, `--read-only`, a mark, a task tool; `CONTRACT_VERSION` is 6 | `5m9d_fingerprint_covers_the_role_and_the_final_set` |
| `run_started.engine.role` and `executor.role` are written for format 2 (`all`, `worker`), shown by `report` and `history_run_details` | `5m9d_the_role_is_recorded_with_the_run` |
| The `v2-roles` fixture opens with `status` and `report`, writes back as read, and an open run of it goes on; older v2 fixtures (no role) still do | `5m9d_role_fixture_round_trips`, existing `t41_*` |
| A format-1 run in flight goes on and records no role (decision 1a; with (b) or (c) this test and the capability change with the answer) | `5m9d_format_1_run_goes_on_without_a_role` |
| A format-2 run started by a no-role server and continued by a worker server, and the reverse: each record carries its own role and every decision is the same as with one server | `5m9d_a_run_worked_by_two_roles_records_both` |
| `decisions.dialog: true`: the manager behaves as the config says; a `--read-only` server opens no dialog | `5m9d_read_only_server_opens_no_dialog` |
| An engine that ignores `role` decides the same: the decisions over the fixture with the key stripped are equal | `5m9d_the_role_decides_nothing` |
| `decisions.dialog` behaves as before on the worker role and with no flag | `5m9d_dialog_follows_the_config_as_before` |
| The worker's `--mcp-config` has `--role worker` at start and at resume; its allow-list equals what that server lists through a client and follows a config edit between two starts | `5m9d_claude_worker_starts_the_worker_role`, `5m9d_worker_allowlist_matches_the_served_set` |
| `task_9pns_*`, `t_decisions_*`, `t41_*`, `t42_*`, `t44_*` pass (argv and hashes updated) | existing |

Not tested here, said in the docs: that a real `claude` honours the allow-list (`tests/agents`, outside the
sandbox, by hand); that an older kodel rejects the `mcp` key (only the strict schema is tested); that the
worker cannot edit the config (rests on its deny rule); whether the manager's instructions lead an agent well;
that `KODEL_ENGINE` is only a guard (an agent that unsets it in its shell and starts `kodel mcp` gets every
tool); the answer of `npm view`; CI runs the suite without the mark on Linux and macOS, the run with
`KODEL_ENGINE=1` is local and in the pipeline's own checks.

`5m9d_every_tool_has_a_mark_and_a_role` is satisfied by putting a new tool in any role: the pinned lists
(`ROLE_TOOLS`, the write list) are the review point for a future tool, and the docs say so.

Plus `bun run typecheck`, `bun run lint`, `bun test` (with and without `KODEL_ENGINE=1`), `bun run build &&
node scripts/check-artifact.mjs`.

---

## Steps

1. **`pipeline-core/src/tool-roles.ts`** (main entry, no SDK): `ROLE_TOOLS`, `RUN_CORE`, `DECISION_TOOLS`,
   `TASK_TOOL_NAMES`, `MANAGER_TOOL_NAMES`, `KNOWN_TOOL_NAMES`; `roleOverridesProblem(overrides, roles?)`;
   `resolveToolSet({ role?, overrides, readOnly, available, roles? })` -> `{ names, unapplied }` or `{ refused }`.
2. **One base type** `ToolSpec` in `mcp/tools.ts`; the pipeline, task and manager descriptors extend it. Role
   variants are derived in `toolsFor({ taskLink, role })`, never copied. `pipeline_next_step`: `readOnly:
   false`, "It only reads" reworded in its description and in rule 9a.
3. **Registration** (`register.ts`, `history-tools.ts`, `task-tools.ts`, `manager-tools.ts`): optional `only`;
   each filters once, passes the filtered list to its dispatcher and returns it.
4. **Texts per served set.** `serverInstructions({ role, served, ... })`, `taskInstructions(mode, linkable,
   served)`: a rule about a tool is there only if the tool is served; the worker keeps the rule numbers; the
   manager gets its own text. `decisionTools(flags, decider, { lookWith })` and the failures in
   `cli/src/agent-decisions.ts:73,125` name `manager_inbox` on the manager, where `after()` answers from
   `inspect()` (a new read of the service) instead of `service.nextStep`. `LocalPipelineHost` gets `servedTools`; the `on_run: ask` text (`host.ts:3136`) follows it.
5. **Manager reads in core.** `pipeline-core/src/manager-view.ts`: `ManagerHost` (`inbox`, `runReport`,
   `gateChanges`, `serveStatus`, `agents`, `agentLog`, `watch(cursor, waitMs, signal)`, all optional) and the
   answer builders with the limits and cursors of `history-view.ts`. `mcp/manager-tools.ts`: seven strict,
   read-only descriptors; `wait_s` at most `MAX_WAIT_S`.
6. **Manager reads in `local`** (`host.ts`, or a new `manager.ts` next to it): the inbox over `runSummaries`,
   `inspect()`, `pipelineProposals`, `needsApproval`; the report from `report.ts`; the changes at a gate from
   what the gate answer shows (`changesSinceStart`, `capChanges`) without `tick()`; the inbox entries of a
   proposal and of a run change carry the summary and the diff the `show` commands print, and the entry for a
   finished run whose task is open; the watch as one look a second on the host's clock and sleep port over the
   run summaries, the states of runs that have not ended and the inbox key, ended by the abort signal, with
   its snapshots kept in memory (16). Unreadable runs become marked rows.
7. **Manager ports in `cli`**: serve status and dead workers from `readServeStatus` and the daemon's view
   (`serve-command.ts`), agents and their logs from the session adapter behind `agent ls` / `agent logs`
   (`agent-commands.ts`); `createServer` merges them with the host's reads.
8. **The stored role.** `executor.ts`: `role?` on `EngineRecord` and `ExecutorRecord`; `ServedSurface` and the
   service's caller carry the role; `local/src/executor.ts` (`engineRecord`, `observeExecutor`) writes it when
   `capabilities.executorRole`; `formats/types.ts`, `v1.ts`, `v2.ts` get the capability; `report.ts` and
   `history-view.ts` show it; the fixture `fixtures/formats/v2-roles/` is made from a real run; `docs/run-formats.md`.
9. **Fingerprint** (`executor.ts`): optional `{ role, readOnly }` header and `read_only` per tool, over the
   final set with the task tools. `CONTRACT_VERSION` 6.
10. **Config** (`local/src/config.ts`): the `mcp` block in `configSchema`, checked with `roleOverridesProblem`;
    `loadMcpRoles(storeRoot)` reads only that block and returns the overrides, none, or throws
    `CONFIG_INVALID` (decision 2 for text that does not parse).
11. **`kodel mcp`** (`cli.ts`): flags checked first; role from the flag, else worker under `KODEL_ENGINE`;
    `loadMcpRoles` without a `.catch`; the NO_PROJECT branch gets role and `--read-only`; stderr lines (role,
    count, unapplied names); the worker role turns `agentDecisions` off; `--read-only` builds the host without
    timer and engine launch. `createServer` (`mcp-server.ts`): `role`, `readOnly`, `served`, `only`.
12. **The worker**: `workerMcpConfig` adds `--role worker`; `servedTools` becomes a function called at each
    start and resume, using `loadMcpRoles` and `resolveToolSet`; `preflight`
    (`worker-launcher-session.ts:311`) calls it and refuses with its reason; `openWorkerLauncher`
    (`worker-factory.ts`) lets that error through (a tracker that cannot be opened still only drops the task
    tools, as the server does). `start` and `resume` call it again before they spawn, and throw a typed
    refusal; `local/src/serve/daemon.ts` does not count that refusal in `resume_attempts`;
    `cli/src/tui/worker-start.ts` shows it. `startPrompt` and `resumePrompt` gain the two sentences.
    **`kodel init`** (`cli/src/init/index.ts`, `init/agents.ts`): keep `--role <r>` and `--read-only` found
    after `mcp` in an existing kodel entry.
13. **Tests** of the table; pinned ones updated (`cli/test/executor.test.ts:72`,
    `pipeline-core/test/engine-steps.test.ts:657`, `local/test/executor.test.ts:77`,
    `cli/test/worker-launcher.test.ts:195`, the `zkrh_*` registry test); every spawn of `kodel mcp` in tests,
    `tests/agents/harness.ts` and `scripts/check-artifact.mjs` strips `KODEL_ENGINE`.
14. **Docs**: `docs/mcp-roles.md` (roles and lists, the manager tools, `mcp.roles` and its refusals, that
    `manager.add` can give run tools and what that means with `decisions.agent`, `--read-only`, the order,
    `KODEL_ENGINE` and `agent exec`, a step that starts `kodel mcp` gets the worker, restart the server after a
    config edit, every build that serves the project must know the block, what `init` keeps, the git objects
    of decision 3, Windows, limits, "Decision 5M9D" with the refutation criterion: this is the repository's
    copy; the entry in the decision log (`notes/`, git-ignored) is the person's to write, and the tests are
    named by the task key, not `tNN_`, by the person's choice; the golden text is the branch's first commit);
    AGENTS.md (`mcp` among the person's
    blocks, the roles, the worker does not change a task's status); `docs/decisions.md`, `docs/tasks.md:249`,
    `docs/history.md`, `docs/serve.md` (the preflight refusal), `docs/run-formats.md`.

## Affected files

- `packages/pipeline-core/src/`: `tool-roles.ts`, `manager-view.ts`, `mcp/manager-tools.ts` (new); `index.ts`,
  `tool-calls.ts`, `executor.ts`, `service.ts`, `report.ts`, `history-view.ts`, `formats/types.ts`,
  `formats/v1.ts`, `formats/v2.ts`, `mcp/tools.ts`, `mcp/register.ts`, `mcp/history-tools.ts`,
  `mcp/task-tools.ts`, `mcp/decision-tools.ts`, `mcp/index.ts`.
- `packages/local/src/`: `config.ts`, `host.ts` (and `manager.ts` if split out), `executor.ts`, `index.ts`,
  `serve/daemon.ts`.
- `packages/cli/src/`: `cli.ts`, `mcp-server.ts`, `agent-decisions.ts`, `agent-commands.ts`,
  `serve-command.ts`, `claude-worker.ts`, `worker-factory.ts`, `worker-launcher-session.ts`, `worker-launcher.ts`,
  `tui/worker-start.ts`, `init/index.ts`, `init/agents.ts`, `format.ts`.
- `fixtures/formats/v2-roles/` (new), `fixtures/formats/README.md`.
- Tests: `pipeline-core/test/mcp-roles.test.ts`, `pipeline-core/test/manager-tools.test.ts`,
  `local/test/manager.test.ts`, `cli/test/mcp-roles.test.ts`, `cli/test/manager-tools.test.ts` (new), a golden
  text of today's instructions; `pipeline-core/test/{executor,engine-steps,tool-calls-registry,task-tools,format-codecs}.test.ts`,
  `local/test/{config,executor,serve-daemon}.test.ts`,
  `cli/test/{executor,worker-launcher,worker-resume,mcp-no-decisions,init,tui-worker}.test.ts`,
  `tests/agents/harness.ts`, `tests/agents/claude-code-worker.test.ts`, `scripts/check-artifact.mjs`.
- Docs: `docs/mcp-roles.md` (new), `AGENTS.md`, `docs/tasks.md`, `docs/decisions.md`, `docs/history.md`,
  `docs/serve.md`, `docs/run-formats.md`.

## Rejected review findings

Still accepted from the critique and in the plan: inv-1, inv-2, inv-4, inv-5, tests-1..7, tests-9, tests-10,
tests-12..14, gaps-1, gaps-2, gaps-4, gaps-6, gaps-8, gaps-9, gaps-11, gaps-12, scope-6..8.

Settled by the person's decisions at plan approval:

- **scope-1, tests-11** (the split leaves the task partly done): accepted in full, one PR (1a).
- **scope-2** (extending the history answers): dropped; the history tools stay as they are (3a).
- **gaps-7, inv-7** (the role is not observable in the history): now stored (4b); inv-7's "no stored field
  changes" no longer holds, and the compatibility rules are followed instead.
- **inv-3, gaps-3, tests-3** (a config problem must not leave a worker without its server): the person chose
  to stop the server (6a) over the minimum set I proposed; the worker is protected by the preflight instead,
  and a bad value outside the `mcp` block does not stop the server.
- **inv-9, scope-3** (a limit for the manager): rejected by the person (8b); the docs say what `manager.add`
  can do.
- **inv-8** (ask the person to record and confirm the id): no id is asked for; the decision is named by the
  task key, which cannot clash with a parallel task.

Second critique (32 rows in the run's report, all read). Accepted and in the plan: tests-1..10, scope-4..7,
gaps-1..10, inv-1, inv-2, inv-4, inv-5. Not taken, or taken in part:

- **scope-1** (storing the role is not asked by the task): decided by the person (4b). It breaks no invariant:
  the addition is argued under rule 5 and ships with its fixture and tests.
- **scope-2** (exit, launcher check and the YAML rule go beyond the task): the exit is the person's decision
  (6a) and the launcher check was asked for with it; the TL;DR names them as beyond the task. The YAML rule
  stays an open question (decision 2), not a silent choice.
- **scope-3** (split along the task's seams): decided by the person (1a); the review risk is in the TL;DR.
- **inv-3, in part**: right that `sameExecutor` has no production caller, so my sentence is removed and the
  real effect (more `step_served` records through `promptHash`) is named. Not taken: that this weakens the
  rule 5 argument; the cap stops records, never a step.

Rejected by me in the first round, as before:

- **scope-4** (`KODEL_ENGINE` rules are not in the task): they are, verbatim: "Under KODEL_ENGINE with no
  --role the server takes worker; --role manager refuses there."
- **inv-6, second half** (ignore unknown names in `add`): the task says an unknown name rejects the config; a
  silently ignored `add` hides a typo. The build dependence is the rule for every config key.
- **gaps-5, the `run-task.ts:86` part**: `TASK_ALREADY_DONE` is thrown only from `pipeline_start`, so only a
  server that serves `pipeline_start` is told to call it.
- **scope-5** (fingerprint and contract beyond need): the task asks for "the role and the final set"; the mark
  is sent to the client; contract 6 follows the precedent of 5 (new tools).
- **tests-8, the old-fixture test**: the `t41_*` tests already open the old fixtures with `status` and
  `report`; the determinism and contract checks are added.
- **gaps-10, "what does a contract-5 server do"**: nothing changes for it; the role arguments are optional.

## Findings in the code

- **Three registries, three dispatchers**: `mcp/register.ts` (loose schema, `afterTool`, `extraTools`),
  `mcp/history-tools.ts` (strict), `mcp/task-tools.ts` (strict, `buildTaskTools(capabilities)`); all called by
  `createServer` in `cli/src/mcp-server.ts`, task tools only `if (tasks)`.
- **Marks exist** as required fields and are sent as `readOnlyHint`; one is wrong: `RunHandle.nextStep`
  (`local/src/host.ts:3098`) calls `watchAgentLog()` and `tick()` (`:3499`). The read-only path is `inspect()`
  (`:2140`), used by `kodel status` and `kodel wait`.
- **`decisions.agent` acts in three places**: `decisionTools`, `agentDecisionsRule` (`mcp/tools.ts:40`), the
  host option `agentDecisions` in `tell_the_person` (`next-step.ts:356-456`, `host.ts:1148-1166`);
  `--no-decisions` turns all off (`cli.ts:488-497`).
- **Texts that name a tool**: `host.ts:3136` ("call task_update"); `agent-decisions.ts:73,125` ("look again
  with pipeline_next_step"); the decision tools return a `NextStep`.
- **Where the role can be stored**: `EngineRecord` and `ExecutorRecord` (`pipeline-core/src/executor.ts:35-60`)
  are written only into journal records (`run.ts:2331-2377`; `local/src/host.ts:902`, `:3655`). Neither codec
  lists nested keys of a record: `decodeRecord` of v2 returns the record as it is, `encodeV1Record`
  (`formats/v1.ts:424`) checks the event name and the fork fields only. The state tables (`v1.ts:60-84`) are
  not involved. `fixtures/formats/` has `v1`, `v1-open`, `v2`, `v2-engine`, `v2-model`, `v2-worker`;
  `docs/run-formats.md:105-107` is the precedent for amending format 2 in place.
- **`toolsFingerprint`** (`executor.ts:144`): name, description, arguments; no marks; `createServer` leaves the
  task tools out. Stored as sha256 in `run_started.engine.tools_hash`, only when `host.start` got a surface.
- **`kodel mcp` never fails on config today**: every read has a `.catch` (`cli.ts:447-487`); the NO_PROJECT
  branch serves every tool before any flag is looked at.
- **The worker**: `workerMcpConfig` (`claude-worker.ts:124`); `openWorkerLauncher` (`worker-factory.ts:26-34`)
  computes `servedTools` once, with `.catch(() => undefined)`; `preflight` (`worker-launcher-session.ts:311`)
  checks the platform, the dialog, `claude` on PATH and its auth, not the server.
- **`KODEL_ENGINE`** is forced by `session-env.ts:33` and `engineEnv` (`host.ts:356`), inherited by commands
  (`command.ts:117`); `kodel mcp` does not read it today; the T-42 guard (`cli.ts:437`) is by process group.
- **Config**: `configSchema` (`local/src/config.ts:296`) strict at every level; `loadAgentHints` reads one
  block on its own, and the `storage` key is already checked against the lines of the text (`:440-455`): the
  two models for `loadMcpRoles` and decision 2.
- **Names without the SDK**: `PIPELINE_TOOL_NAMES`, `HISTORY_TOOL_NAMES` in `tool-calls.ts`, kept equal to the
  registries by the `zkrh_*` test; no list for the task tools yet.
- **Sources for the manager tools**: `SessionSource` / `loadSessions` (`cli/src/tui/load.ts`), the key of
  `kodel wait` (`cli.ts:941`), `readServeStatus` (`local/src/serve/files.ts:304`), `printServeStatus`
  (`cli/src/serve-command.ts:157`), `needsApproval` (`tasks.ts:250`), `agent ls` / `agent logs`
  (`cli/src/agent-commands.ts:223,269`), `HISTORY_LIMITS` and `INVALID_CURSOR` in `history-view.ts`.
- **A decision serves a step today**: `after()` (`cli/src/agent-decisions.ts:41-50`) calls
  `service.nextStep`, which ticks and records `step_served` (`host.ts:3255-3290`); `serve/resume.ts` counts
  that as the run having moved.
- **Resume has no preflight**: the daemon (`local/src/serve/daemon.ts:769`) and the TUI
  (`cli/src/tui/worker-start.ts:182`) call `launcher.resume` directly; the daemon counts a throw in
  `resume_attempts` (`:782`), keeps a preflight for `PREFLIGHT_TTL_MS = 60_000` (`:69, :579`), and goes `idle`
  with the reason when the config does not load (`:412, :1004`).
- **`kodel init`** always writes `[...args, "mcp"]` (`cli/src/init/index.ts:206`) and refuses a
  `--server-command` that ends in `mcp`.
- **The snapshotter writes git objects**: `hash-object -w` and `write-tree` on a scratch index with
  `GIT_OPTIONAL_LOCKS=0` (`local/src/git.ts:314-368`), reached by `changesSinceStart` (`host.ts:3418`).
- **`sameExecutor`** (`executor.ts:133`) is used only in a test. The served key is
  `servedKeyOf(promptHash, client, session)` (`host.ts:3270-3277`).
- **The dialog hook** looks for `waiting` in an answer and in its `next` (`cli/src/elicit.ts:192-201`).
- **`serve` never starts a task that has a run** (`pipeline-core/src/serve/plan.ts:256`), so a finished run
  with an open task waits for a person and is shown nowhere today.
- **Test naming**: by decision (`tNN_*`) or by task key (`task_9pns_*`, `zkrh_*`); this task uses `5m9d_*`.

## Deviations during implementation

1. **A decision through a manager needed one more journal key.** The plan said a manager's decision must not
   serve a step, "so that `kodel serve` still resumes the worker". Not serving a step was not enough: the resume
   rule (`pipeline-core/src/serve/resume.ts`) refuses every decision marked `decided_by: agent`
   (`agent_decided`), whoever is served afterwards, because an agent that decides where the run is worked goes on
   itself. So a decision made through a manager's server is journaled with `decided_via: manager` beside
   `decided_by: agent` (`AgentDecision.viaManager`, written only where the format has `executorRole`), and the
   resume rule lets it through. It is a journal-only key under the same rule-5 argument as the role; an older
   kodel reads such a decision as an agent's own and does not resume (the behaviour before this change). Tests:
   `t44_5m9d_a_decision_through_a_manager_is_resumed_like_a_persons`, `5m9d_manager_decision_does_not_serve_a_step`.
   The key has its own golden fixture, `fixtures/formats/v2-manager/` (`scripts/take-v2-manager-fixture.mjs`,
   real servers), opened, written back and resume-planned by `5m9d_manager_decision_fixture_round_trips`,
   `5m9d_manager_decision_fixture_opens_and_its_open_run_goes_on` and
   `t44_5m9d_manager_decision_fixture_is_resumed_like_a_persons`.
2. **"Starts no engine work" is about the answer, not the decision.** A decision applied by any server
   dispatches what it leads into (a command step after the gate), as a person's `kodel gate` does and as the
   decision tools did before. What the manager role removes is the tick and the serve that followed the
   decision. The test uses a gate that leads into an agent step and checks that nothing is served and no
   command is started.
3. **Dead serve workers in the inbox come from the journal.** The plan named the daemon's view
   (`serve-command.ts`) as the source. The inbox lists a worker the daemon noted as gone (`worker_note`) in an
   open run while nobody has been served or has completed a step since; the daemon's live view would start
   `kodel agent ls` as a child for every inbox call. Without a daemon nothing writes the note, and
   `manager_agents` shows the session records directly. `docs/mcp-roles.md` says so under "Limits".
4. **`manager_watch` looks at the runs and the proposals only.** "The inbox key" of the plan is the state of
   every open run (status, steps, pauses) and the list of proposed pipelines. The tracker and the daemon are not
   asked every second; a task that begins to wait for approval shows in `manager_inbox`. Documented.
5. **The golden instruction texts are not a first commit.** This step must not commit. The three files in
   `packages/pipeline-core/test/fixtures/` were written from the unedited sources before any edit of this
   change, and the test never regenerates them; whoever commits should keep them as they are.
6. **`kodel serve` ends on a config change, then idles.** The daemon already exits (to be started again) when
   the config outside its `serve` block changes; the daemon started on a config with an unusable `mcp` block is
   the one that is idle with the reason. The test follows that order.
7. **The TUI needed no code change.** Its start and resume messages already carry the launcher's reason; the
   preflight's new refusal is checked first among the project's own conditions (before `claude` is looked for),
   so the reason shows on a machine without `claude` too. `tui/worker-start.ts` is unchanged.
8. **Descriptions follow the role and the flags, not single removals.** A tool removed with `mcp.roles` is not
   taken out of a sibling's description (one history tool names another). The instructions do follow the served
   set rule by rule. Documented under "Limits".
9. **The registry answer.** `npm view` could not run in the sandbox (its cache folder is not writable); the
   registry's JSON was read instead: `@kodel-ai/kodel` has `0.0.0-stage`, `0.1.0-beta.0` (2026-10-25, `latest`)
   and `0.1.0-beta.1` (2026-10-28, `beta`). Which of them wrote format 2 was not established; the release note
   says so, and the amendment does not depend on it.
10. **New files beyond the plan's list:** `packages/cli/src/manager-ports.ts` (the CLI's ports, kept out of
    `agent-commands.ts` and `serve-command.ts`), `scripts/take-v2-roles-fixture.mjs` (how the fixture is made),
    `packages/local/test/helpers/run-states.ts` (the project of six run states both "writes nothing" tests use).
    `pipeline_next_step`'s instruction line keeps the words "never takes a step" (a pinned test reads them).
