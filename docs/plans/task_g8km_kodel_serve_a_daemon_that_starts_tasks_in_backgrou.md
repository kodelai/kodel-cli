# `kodel serve`: a daemon that starts tasks in background workers and resumes them (TASK-G8KM)

## TL;DR

- `kodel serve` (foreground, one per checkout) runs a cycle every 5 s: it reads tasks, runs and worker records, asks a
  pure function in `pipeline-core` (`planServe`) what to do, and does it only through the existing `WorkerLauncher`:
  it starts matching tasks within two limits, resumes a worker after the person's decision with no TUI open, and
  records in the run that its worker died. Rules are a new person-owned `serve` config block, off by default.
- Cost: one PR, about 2,200 lines of code and 3,600 of tests. Stored data: a journal-only event `worker_note` in run
  format 2 (an addition without a bump; format 1 is left as it is) and four optional fields on a task (`created_by`,
  `created_in_run`, `agent_edited_at`, `approved_at`).
- **What the critique changed (plan-revise 2):** simpler. The `starting` and `started` notes and every second launch
  are cut: the daemon launches once per run and writes only `gone` (Decision 1). A start that finds an existing run
  writes and launches nothing. Three dead workers in a row pause all starts. An approval is refused when the task
  changed while the person read it. The engine checks only the shape of a note; the tie of a name to a run is
  `local`'s. Cut as extras: the `stalled` word in the TUI, the `held` log line. Added: `kodel serve --status`
  (Decision 2), the rule in the MCP server's instructions, about 25 named tests. Earlier settled answers are kept.
- Risky: (1) anything that can edit `.kodel/config.yaml`, a task file, or run `kodel serve` (an agent with Bash, a
  `git pull`, a checkout of another branch) can turn the daemon on, widen its rules or get past the task mark;
  (2) the resume is automatic, so two agents can do one step if the person hands a worker's run to another agent
  within a cycle of deciding; (3) a daemon killed in the seconds between making a run and launching its agent leaves
  a run with no agent and no note.

## Decisions needed

Settled by the person and not reopened: one PR; automatic resume whenever the daemon is on; no approval of the block;
a dead worker goes into the run; `lastOutputAt` as an optional field of `WorkerStatus`; two limits (`max_workers`,
`max_runs`); a mark on tasks an agent made and an approval by a person; in-memory state with the give-up as the
task's latest comment; one start rule; exit 78; decision id `T-43` (`T-44` if TASK-HN8N takes it first). Settled by
the fixes of plan-fix 1 and kept as defaults unless the person says otherwise: every task not made by a person at a
terminal counts as an agent's; tasks without a mark count as the person's; `kodel task approve <key>` is the way to
approve; a tracker that cannot keep the mark starts nothing; `max_workers: 1` and `max_runs: 1` by default; only the
daemon writes the note and `stalled` is not journaled; starts need `worktree.mode: auto`; an agent's edit of the
title, body, status, priority or parent makes a task wait for an approval again.

Open; the plan takes the recommendation when one is not answered.

1. **A start that died half-way.** The previous plan wrote `starting` and `started` notes to find it. The critique
   showed three holes in that (a death before the first note, a launcher that throws after it spawned, a false
   `never_started`), and each fix adds a state rule. (a) **Cut it: the daemon launches once per run. When
   `launcher.start` throws and no record `kw-<run>` exists right after, it writes `gone` with `not_started` into the
   run; when a record exists, the worker did start and nothing is written. A daemon that is killed between making the
   run and that point (seconds) leaves a run with a task in `progress` and no agent: `kodel status` and the TUI show a
   running run with no agent, and `kodel serve --status` lists it (`open run with a task and no agent`); any agent
   continues it with `pipeline_next_step`**; (b) mark the run as the daemon's in the same write that makes it (a new
   field of `run_started`, one more stored-data change) and note it later: closes the window, costs about 150 lines
   and the rules above. **Recommended (a)**: it is the simplest design that meets the task, and the window is seconds.
   It re-opens the critique's G1 for that window only: an accepted risk. Default (a).
2. **`kodel serve --status`.** Read-only: whether a daemon runs for this checkout (pid, since, active or idle and why,
   the state base), the counts against the limits, what waits, what the next cycle would start, and open runs with a
   task and no agent. It answers "what will start when I turn this on" (every existing matching task counts as the
   person's) and "is it running" without the TUI. It acts on nothing, so it is not the `kodel tick` the task rules
   out. (a) **add it** (about 70 lines; the plan and `readServeStatus` exist already); (b) leave it out.
   **Recommended (a).** Default (a).
3. **Three dead workers in a row.** A fault the preflight cannot see (a usage limit of `claude`, no SSH key in the
   unit's environment, a full disk) would let the daemon walk through the whole backlog, one dead run per task.
   (a) **after three workers in a row that the daemon started and that ended outside a wait, it starts nothing more
   and says so; a worker that reaches a wait or the end resets the count; a restart of the daemon (the person's act)
   also does**; (b) no such stop. **Recommended (a)** (in memory, about 30 lines). Default (a).

## Behaviour change

- **Config** (the person's block; strict at every level; off by default; read again every cycle):

  ```yaml
  serve:
    enabled: true            # default false: the daemon runs idle and says so
    max_workers: 2           # 1..64, default 1: worker processes alive at once
    max_runs: 4              # 1..64, default 1: open runs that have a worker
    stalled_after_s: 1800    # 0..86400, default 1800; 0: never
    start:                   # absent: starts nothing, only resumes and watches
      pipeline: dev
      match:                 # every key optional; an empty match is every `todo` task
        status: [todo]             # exact status names
        priority: [urgent, high]   # any of
        parent: TASK-AB12          # direct children only
  ```

  A kodel older than this change refuses the whole config (`unknown key: serve; … upgrade kodel or remove the key`).
  An MCP server that was already running before the upgrade does not re-read the config and does not mark tasks:
  restart the agents' sessions after the upgrade. The config `version` is not bumped.
- **`kodel serve`** prints the root, the state base and the build, then one plain, redacted line per event. With
  `enabled` not true or a config that does not load it is idle: it does nothing, says why once, looks again every
  cycle. Exit codes: 0 after `SIGTERM`, `SIGINT` or `SIGHUP` (the action in hand is finished; workers go on); 75 when
  the config outside the `serve` block or the kodel build on disk changed (host, tracker and launcher are built once;
  a service manager starts it again); 78 for what a restart does not fix (Windows: `PLATFORM_UNSUPPORTED: agents are
  not supported on Windows yet; kodel serve starts no workers`; `KODEL_ENGINE` set; another daemon: `kodel serve is
  already running for this project (pid 4242, since …)`). `kodel serve --status`: Decision 2.
- **Start.** A task is started when its state is `todo`, the rule matches, no run of the history names it and the
  tracker lists no run for it besides the one it was found in, it does not wait for an approval, its latest comment
  is not the daemon's give-up, both limits have room and starts are not paused (Decision 3). Order: the tracker's
  priorities, then its list order. A start is what `s` in the TUI does (the run through the host with `task_key`,
  `restart: true`, caller `kodel-serve`; then the worker), from the `HEAD` of the checkout at that moment. If the host
  answers with a run that already existed, the daemon writes nothing, launches nothing and logs it. A failed start
  is tried again in later cycles, 60 s apart; after three the task gets `kodel serve: not started after 3 attempts
  (pipeline dev): <reason>. A newer comment makes the daemon try again; or start it by its key in the TUI.` Problems
  of the environment (no `claude`, not signed in, `decisions.dialog`, the pipeline does not load or has uncommitted
  changes, no git, `worktree.mode: off`, the tracker cannot attach runs or keep the mark, more than 1,000 candidates,
  the worker records cannot be read, the start lock busy for 15 s) use no attempt: nothing starts, one log line per
  change.
- **Limits.** `max_runs` counts open runs that have a worker, from the start until the run ends or its worker is gone
  for good; `max_workers` counts worker processes that are starting or running. A start needs room in both; a resume
  needs room in `max_workers` only. When `max_workers` is full, resumes wait, oldest decision first, and every
  waiting resume goes before any new start. A start or a resume by the person's key in the TUI ignores both; the
  daemon then does nothing new until the counts are under the limits.
- **Resume.** A worker that exited at a wait and whose run a person then decided is resumed as `kw-<run>-d<seq>`,
  once per decision, in the first cycle with a free worker place, by the rule the TUI offers `s resumes` with, unless
  the journal, read again right before, shows that an agent was served, claimed or completed a step since the
  decision. Removing a resume's record (`kodel agent rm`, a person's command) frees its name, so that decision may be
  resumed again; removing every record of a run takes the run away from the daemon: it is not resumed and nothing is
  launched for it.
- **A worker that died** is written into its run: `worker_note` (`gone`; `lost`, `killed`, `exited` or `not_started`;
  the record's name and id; the exit code), once per record id. `kodel status <run>` and the TUI card say `agent
  kw-r_… lost at 10:02 (its holder is gone); any agent continues the run with pipeline_next_step`, `kodel report`
  lists it. Lost: the holder is gone (a reboot, a kill). Killed: by its timeout. Exited: outside a wait. A worker a
  person stopped is not noted. Stalled (running, no output for `stalled_after_s`, counted from the latest of its last
  output, its start, the daemon's start and the last gap of more than 60 s between two cycles): a log line once per
  quiet spell, nothing else.
- **Tasks an agent made or changed.** `task_create` marks the task (`created_by: agent`, and `created_in_run` when
  `run` is given); a `task_update` that changes the title, body, status, priority or parent sets `agent_edited_at`. A
  task waits for an approval when it has either mark and no `approved_at` later than the last agent edit (equal
  times wait). `kodel task approve <key>` shows the task, asks, and refuses when the task changed since it was shown
  (`the task changed while you were reading; look again`). Comments, and what the engine itself does to a task, do
  not mark. `task_create` tells the agent that such a task is not started by `kodel serve` until the person approves
  it, so the agent tells the person. `kodel task show`, `list` and the TUI show `waits for approval`.
- **TUI.** No daemon, or an idle one: as today. An active daemon: the header shows `serve on (pid N)`; a run that
  would offer `s resumes` reads `agent exited at your decision · kodel serve resumes it`. A daemon whose process is
  gone is seen at the next refresh (4 s); one that finished no cycle for 2 min is named in the header and `s
  resumes` is offered again. `s` on a task takes the same start lock as the daemon. The card shows a `worker_note`.
- **What the daemon writes:** `worker_note` records in runs; the give-up comment; through the run's tie, the task's
  `progress` status as every start does (with the `local` adapter these are changes of tracked files under
  `.kodel/tasks/`, at times the person does not choose); its own record under the state base; stdout.
- **Limits, said in the docs.** One checkout, one user, one machine, one state base (`KODEL_STATE_DIR`, else
  `~/.kodel`): a daemon under another state base is not seen by the TUI or by a second `kodel serve`, each then
  resumes and counts only its own workers, and only the start lock (in the lock root) is shared. A second clone may
  run its own daemon; clones that share tasks through git can start one task twice: one daemon per tracker. The
  daemon reads the working tree: a checkout of another branch brings that branch's config and task files, and a
  `git stash -u` or `git clean` that removes run folders and task changes makes a started task look new, so run it
  in a checkout that stays on one branch and ignores `.kodel/runs`. A TUI built before this change does not know the
  daemon: it still offers `s resumes` (the record's name keeps it to one) and starts without the lock. A user unit
  without linger ends at logout. On macOS a refusal (78) is started again by launchd every 60 s, one log line each.

## Risks and invariants

- **Accepted risks.**
  - *No approval of the block (critique I3, G6, G7; the person's decision).* The block is in a tracked file and is
    read every cycle. An agent with Bash can add or widen it and can start `kodel serve` (the command cannot ask for a
    terminal); a `git pull`, merge or checkout can turn it on or change its rules within 5 s. What stands against
    it: the MCP server's instructions and, in this repository, `AGENTS.md` ("do not edit the `serve` block, do not
    run `kodel serve` or `kodel task approve`"); the refusal under `KODEL_ENGINE` (a worker cannot start it); the
    task mark; the two limits; the gates of the pipeline. `adapters/` holds no deny rules today, so for the person's
    own interactive agent the only technical guard is that text.
  - *The task mark is advisory against an agent that leaves the tools.* It is set by the writer: an agent that edits
    `.kodel/tasks/*.yaml` with Bash, an MCP server of a build from before this change, and task files that arrive by
    `git pull` or a checkout of another branch all make or change tasks without a mark, and those count as the
    person's. It holds against the path it was asked for: `task_create` and `task_update` of an agent inside a run.
  - *Automatic resume (I1, G4; the person's decision).* No journal line proves that the person's own agent is not
    continuing the run. If the person decides and hands a worker's run to another agent within a cycle, both may do
    the same step; the engine's checks still decide each result. Only a run with a worker's record is resumed.
  - *No state file (G1, G2, T4, T5, I7, G14; the person's decision), and Decision 1.* Attempts and the count of dead
    workers are in memory: a start that kills the daemon before a run is made is tried again after every restart. The
    give-up is the task's latest comment: any newer comment, also an agent's, re-arms it, and an agent can write the
    same words to block a start. A daemon killed between making a run and launching its agent leaves a run with no
    agent and no note. A dead worker of a format-1 run is logged again after each restart, once.
- **1 / 6 Agent input is untrusted; humans decide trust.** The daemon decides nothing about a run: its host port has
  no gate, ack, seal, resume-of-a-pause or accept call (a narrow interface, and a journal scan in the tests). The new
  host call `noteWorker` writes a fact, changes no state and no route, and no MCP tool reaches it (a snapshot of the
  tool list tests it). `kodel task approve` is a person's command (`requireHuman`, a confirmation).
- **2 Fail closed.** Config not loadable, tracker list incomplete, tracker without the mark, worker records not
  readable (`kodel agent ls` failed): no start, no resume, no note in that cycle. A worker in state `unknown` or a
  run that cannot be read is not resumed and holds its places; the log line keeps the three reasons of rule 3 apart
  (`cannot read: <field>`, `written by a newer kodel, upgrade kodel`, `was modified`). A daemon record that cannot be
  read or is newer makes a second daemon refuse and names the file.
- **3 Redact.** `worker_note` carries no free text; the comment goes through `TaskService.update`; log lines through
  `redactText` with the project rules.
- **4 / 5, and the shared engine.** `planServe`, `admitStart`, `resumeVerdict`, `decisionOf`, `needsApproval` and the
  record codec are pure (`now` is an input), under the subpath `@kodel-ai/pipeline-core/serve`, not in the main
  entry. `decide()` checks only the shape of a `worker_note` (bounded opaque strings, an enum, an integer): the names
  `kw-<run>` are the local launcher's convention, so the check that a name belongs to the run is in `local`'s
  `noteWorker`, and Kodel Server can write a note with its own runner ids.
- **8 / Stored data, rule by rule.**
  - *The journal event `worker_note`* (run format 2). Rule 5: a compatible addition, not a bump. An engine of format
    2 that does not know it decides every step the same way (journal-only; an unknown event is read, written back
    and reported as absent: `t41_unknown_event_is_ignored_by_the_current_engine`), and nothing is dropped when an
    older engine writes the run back: the journal is only appended to and the state has no new field. This does not
    rest on format 2 being unreleased (it is: `docs/run-formats.md` names format 1 as what the published beta wrote).
    The change ships: the event in `V2_ONLY_EVENTS` (the key table of `t41_model_and_event_key_tables_are_complete`),
    a capability `workerNotes` (true for 2, false for 1), `decode` and `encode` unchanged for format 2 (records are
    stored as they are) and refusing it for format 1 as for every v2-only event, a golden run
    `fixtures/formats/v2-worker/` taken from a real run with `scripts/take-format-fixture.mjs`, and the release note.
  - *A run of format 1:* the note is a quiet no-op, like `agent_session_named` (`run.ts:2488`), and the daemon logs
    the death instead, once per daemon. Not `UNSUPPORTED_FORMAT_FEATURE`: that answer offers an agent `kodel migrate`,
    and nobody asked the run for anything; the run is unchanged and goes on. Rules 1 to 4: no field is renamed,
    removed or retyped; no snapshot rule changes; no error text changes.
  - *What an older kodel does* (the release note says it; not testable here, a check at release): it ignores the
    record but counts it as a sign of life; its TUI may date a hand-edited pipeline's wait by it. The new readers
    leave it out (`tui/load.ts:394`, `decisionOf`); a test pins that list and the refusal text of the config.
  - *Task files of the `local` adapter* (`v: 1`): four optional keys. The schema passes unknown keys through and
    writes them back (`local-adapter.ts:127-143`), so an older kodel keeps them; a file without them reads as a
    person's task. No bump. Fixture `fixtures/task-formats/v1/` and a round-trip test. The task contract stays `1`:
    optional fields, a capability `provenance` that reads as off unless `true`, an optional method.
  - *The daemon's record* `<state base>/serve/<uid>/<checkoutKey>.json`: machine-local, not history; `v: 1`, one codec
    (`decode` ignores unknown optional fields of a known `v` and refuses a newer one with "upgrade kodel"; `encode`
    strict), a fixture, a round-trip test; described in `docs/serve.md`.
  - Session records, their codecs and fixtures, `session-holder.ts`, `session-pipes.ts`: untouched.
- **One launch mechanism.** `tui` and `serve` get the launcher from one factory in the CLI; `local` sees a port; the
  daemon calls its `start` in one place, once per run.
- **Two starters.** "Not started yet / limits" is checked under `worker-start.lock` in the lock root, from the check
  to the end of `launcher.start`. The lock names its holder's pid and process identity; it is taken over only when
  that process is gone (a reused pid after a reboot is another identity), never from a live holder. A waiter gives up
  after 15 s (TUI: `another start is in progress, try again`; daemon: next cycle). Order: `worker-start.lock`, then
  `start.lock`, then a run's lock; holders of the inner two never ask for the outer one. Not covered: an agent's own
  `pipeline_start` for the task in the same second (the daemon then gets the existing run back and does nothing).
- **Cost of a cycle.** One child (`kodel agent ls --json`), the states of the open runs (an ended run is read once and
  remembered), a task list only when a start is possible. A test holds a cycle over 500 ended runs under a bound.
- **Service managers.** systemd: `KillMode=process`, `Restart=on-failure`, `RestartPreventExitStatus=78`. launchd:
  `AbandonProcessGroup`, `ThrottleInterval` 60. Not testable in CI: steps of the manual scenario.

## Acceptance criteria and tests

Pure (`packages/pipeline-core/test/serve-*.test.ts`, `format-codecs.test.ts`):

| Criterion | Test |
| --- | --- |
| One named case per verdict (`no_worker`, `unknown`, `active`, `dead`, `over`, `not_at_wait`, `wait_before_start`, `waiting_person`, `undecided`, `agent_decided`, `already_resumed`, `no_session_id`, `moved`, `resume`); the TUI's table passes unchanged; `RunDecision` is `WorkerDecision` | `t43_resume_verdict_<why>`, `t43_resume_verdict_is_the_tui_rule`, `t43_run_decision_is_worker_decision` |
| Started at most once: not when done, in progress, named by a run, with a run in the tracker besides `created_in_run`, waiting for an approval, given up | `t43_matching_task_is_started_at_most_once` |
| `needsApproval`: made by an agent; a person's or an approved task whose title, body, status, priority or parent an agent changed (each a case); approved after the edit: no; equal times: yes; a comment: no; the engine's own update: no | `t43_needs_approval_table` |
| Status, priority, parent (direct children only); an empty match is every `todo` task | `t43_rule_matches` |
| An incomplete list (`complete: false`) plans no start and one `environment` line | `t43_incomplete_list_starts_nothing` |
| One case per row of the two counts: at a gate (run yes, worker no), running (both), `unknown` (both), lost (neither), ended (neither) | `t43_limits_table` |
| Both limits hold; the rest wait in priority order; `queued` logged on change only; over a limit after a TUI start: nothing new | `t43_two_limits_hold_and_the_rest_wait`, `t43_over_the_limit_starts_nothing` |
| `max_workers` full: resumes wait, oldest decision first, and go before any start; a resume never needs `max_runs` | `t43_resumes_go_before_starts` |
| Three daemon-started workers in a row ended outside a wait: no start, one line; a worker at a wait or done resets | `t43_three_dead_workers_pause_starts` |
| Stalled from the latest of last output, start, daemon start, last gap; `0` never; once per quiet spell | `t43_stalled_from_last_output_at`, `t43_sleep_gap_stalls_no_worker` |
| Lost, killed by timeout, exited outside a wait: one note per record id; a second worker under a reused name is noted too; stopped by a person: none | `t43_dead_worker_is_noted_once_per_record` |
| Three attempts 60 s apart, then give-up; the give-up comment stops retries; a newer comment re-arms | `t43_gives_up_after_three_attempts` |
| Same input, same plan; the subpath imports no `node:` module | `t43_plan_is_pure` |
| `worker_note` in `decide()`: journaled in format 2 with no state change; each a no-op: a name or id over the bound or with other characters, a reason outside the four, a non-integer exit code, an ended run, format 1 | `t43_worker_note_shape_<case>`, `t43_worker_note_format_1_is_untouched` |
| The event is in the key tables; the fixture `v2-worker` opens (`status`, `report`), round-trips, an open one goes on | `t41_*` over `v2-worker` |
| The daemon's record: round trip, unknown optional field ignored, newer `v` refused, a fixture per version | `t43_serve_record_round_trip` |

Adapter (`packages/local/test/`; real host and tracker, fake clock, `ScriptedLauncher`). They run on all three OSes
because process liveness is injected (`isSame`); the three that use real processes are POSIX only and marked `*`:

| Criterion | Test |
| --- | --- |
| Done-when 1: a new matching task starts, stops at its gate, is resumed in the cycle after the gate is approved (counted with the fake clock), finishes; no TUI | `t43_task_runs_through_a_gate_with_no_tui` |
| Done-when 2: `max_runs: 1`: the second starts only after the first run ended, also while the first waits at its gate; `max_workers: 1`, `max_runs: 2`: it starts when the first reaches its gate, and the first's resume comes in the first cycle after the second's worker left | `t43_limit_one_second_task_waits`, `t43_resume_waits_for_a_worker_place` |
| `host.start` answers `reused` or `terminal`: no note, no launch, no attempt | `t43_existing_run_is_not_given_a_worker` |
| `launcher.start` throws and no record exists: `gone not_started`, the places are free, the task is not started again; it throws and a record exists: no note | `t43_failed_launch_is_noted_not_retried`, `t43_launch_that_spawned_is_not_noted` |
| A worker exited at its gate or was stopped and the person removed its record: nothing is launched, nothing is noted, also by a new daemon | `t43_rm_after_start_launches_nothing` |
| `noteWorker` in the host: a name that is not `kw-<this run>` or `kw-<this run>-d<n>` is refused; a second call with the same id writes nothing | `t43_note_worker_binds_the_name_to_the_run` |
| Two processes on one store (daemon and the TUI's `startTask`) make one run for a task and pass no limit `*`; a live slow holder is never taken over, a dead one and a reused pid are (injected); a waiter gives up after 15 s on both paths; a start that holds `worker-start.lock` while another process holds `start.lock` finishes (no cycle) | `t43_two_processes_start_a_task_once`, `t43_start_lock_stale_only_when_gone`, `t43_start_lock_waiter_gives_up`, `t43_lock_order_has_no_cycle` |
| A holder that is gone is noted in the next cycle; a new daemon notes nothing twice; for a format-1 run it is logged once per daemon | `t43_dead_holder_noted_within_one_cycle`, `t43_restart_does_not_repeat_notes`, `t43_format_1_dead_worker_is_logged_once` |
| An agent's journal line between plan and act cancels the resume; `NAME_TAKEN` is success; two loops resume once; removing a record re-arms or releases | `t43_resume_is_skipped_when_an_agent_moved`, `t43_resume_name_taken_is_success`, `t43_rm_rearms_or_releases_a_run` |
| The first of two actions throws, the second runs; a stop request ends after the action in hand; `kodel agent ls` fails: the cycle does nothing | `t43_cycle_survives_a_failed_action`, `t43_stop_finishes_the_action_in_hand`, `t43_unreadable_workers_stop_the_cycle` |
| `enabled: false` or a config that does not load: idle, logged once, active when fixed; config outside the block or the build changed: 75 | `t43_idle_until_enabled`, `t43_changed_config_or_build_ends_the_daemon` |
| Environment problems, each a named case (`ChoiceNeeded`, `STATE_LOCKED`, no `claude`, `worktree.mode: off` (still resumes), tracker without `provenance`, tracker without runs, more than 5 pages): no attempt, no comment, logged on change; preflight at most once a minute | `t43_environment_<case>_is_not_an_attempt` |
| A second daemon refuses and names the pid; dead or recycled pid taken over; two takers, one wins; unreadable refuses; the status table (active, idle, gone, silent, unreadable) | `t43_second_serve_refuses_and_names_the_pid`, `t43_stale_record_is_taken_over`, `t43_takeover_race_has_one_winner`, `t43_serve_status_table` |
| The three reasons a run cannot be opened are three log lines | `t43_unreadable_runs_say_why` |
| A secret in a title, a failure reason, a decision reason is in no log line, comment or note | `t43_log_and_comments_are_redacted` |
| The daemon's host port has no decision call; the journal's decisions are only the test's; apart from `worker_note` a daemon's run has the file names and event kinds of a TUI's; no MCP tool list names `worker_note`, `noteWorker` or `approve` | `t43_daemon_decides_nothing`, `t43_serve_adds_only_worker_notes`, `t43_tool_surface_has_no_note_and_no_approve` |
| A cycle over 500 ended runs reads each once | `t43_ended_runs_are_read_once` |
| The block: off by default, strict, bounds; the zod shape is the core type; the refusal text for an unknown key and `NOT_A_SIGN_OF_LIFE` are pinned | `t43_serve_block_defaults_and_strict_keys`, `t43_release_note_promises_are_pinned` |
| Task mark: `task_create` and an editing `task_update` set it, the tools cannot clear it or approve; an old file reads as a person's, an older schema keeps the keys, the fixture round-trips; `approve` sets `approved_at` later than the edit and refuses a task changed since it was shown | `t43_task_mark_is_set_by_the_tool`, `t43_task_mark_round_trip`, `t43_approve_refuses_a_changed_task` |
| An agent rewrites a person's task to match the rule, or an approved one: not started until `kodel task approve` | `t43_agent_edit_needs_a_new_approval` |

CLI and TUI (`packages/cli/test/`):

| Criterion | Test |
| --- | --- |
| Refusals with 78: Windows (platform injected; says so, starts nothing), `KODEL_ENGINE`, second daemon; `SIGTERM` and `SIGHUP`: 0, record gone, a worker goes on `*` | `t43_serve_on_windows_starts_no_workers`, `t43_serve_refuses_from_an_engine_command`, `t43_serve_stops_cleanly` |
| `--status` prints the daemon, the counts, what would start, runs with a task and no agent; it writes nothing | `t43_serve_status_acts_on_nothing` |
| `tui` and `serve` use one launcher factory; `lastOutputAt` is copied, absent when the record has none | `t43_one_launcher_factory`, `t43_worker_status_carries_last_output_at` |
| `kodel task approve` needs a terminal and a yes; `task add` and `task set` without a terminal or under `KODEL_ENGINE` mark the task | `t43_approve_is_a_persons_command`, `t43_task_add_and_set_mark_without_a_terminal` |
| `status` and `report` show a `worker_note`; the TUI card shows it | `t43_status_and_report_show_a_dead_worker`, `t43_tui_shows_a_dead_worker` |
| Active daemon: no resume offer, the header; idle, gone or silent: today's offer; the TUI's start holds the lock; every TASK-9PNS test unchanged | `t43_tui_leaves_the_resume_to_serve`, `t43_tui_offers_again_when_serve_is_silent`, `t43_tui_start_takes_the_start_lock` |
| Real session adapter, a fake `claude` that drives the run through the host, under the guard of the existing `real` tests: start, gate, `kodel gate approved`, resume, done; a killed holder is noted `*` | `t43_serve_real_adapter_through_a_gate` |
| Every test of the serve files carries the id that `docs/serve.md` names for the decision | `t43_test_names_carry_the_decision_id` |

Manual, outside the sandbox, at the final gate: the two done-when cases with a real `claude`
(`tests/agents/claude-code-serve.test.ts`, `t43_live_serve_runs_a_task_through_a_gate`, `KODEL_AGENT_TESTS=1`); the
systemd unit and the launchd plist (stop the service, the worker is still in `kodel agent ls`); a daemon under
another `KODEL_STATE_DIR` (`--status` in the shell says no daemon and names the shell's state base). Not covered by
any test: an older kodel on the same run, an agent's `pipeline_start` for the same task in the same second, a TUI
built before this change, two clones on one tracker, the double step after an automatic resume (accepted).

Refuted (T-43) if, on one checkout with one daemon, one state base and builds with this change: a task is started
twice; a task an agent made, or whose title, body, status, priority or parent an agent changed through the tools, is
started by the daemon without a `kodel task approve` after that; more worker processes than `max_workers` or more
open worker runs than `max_runs` exist after an act of the daemon; a decided run of a worker is not resumed within
two cycles of a free worker place with no TUI open, or is resumed twice for one decision without a person removing a
record; the TUI and an active daemon both resume one decision; a holder that is gone is not noted in its run (format
2) in the next cycle; the daemon launches an agent twice for one run, or anything for a run whose records a person
removed, or into a run it did not make; a launch the daemon saw fail leaves no note; a journal has a decision made
by the daemon; a run of format 1 is changed or refused because of a note.

---

## Steps

1. **Core, resume rule** (`pipeline-core/src/serve/resume.ts`). Move `decisionOf`, `WaitMark`, `DecisionMark`,
   `DecisionInfo` from `cli/src/tui/worker-resume.ts`; add `RunDecision` and

   ```ts
   export type ResumeVerdict =
     | { kind: "resume"; seq: number; decision: DecisionMark }
     | { kind: "no"; why: "no_worker" | "unknown" | "active" | "dead" | "over" | "not_at_wait" | "wait_before_start"
           | "waiting_person" | "undecided" | "agent_decided" | "already_resumed" | "no_session_id" | "moved" };
   export function resumeVerdict(run: ResumeRunView, worker: ServeWorkerView | undefined,
     opts: { refuseMoved: boolean }): ResumeVerdict;       // the TUI passes false and words `moved` itself
   ```

   `tui/worker-resume.ts` re-exports `decisionOf` and builds `resumeOffer` on it (wording and `pending` stay there).
2. **Core, the note** (`run.ts`, `formats/`). `RunEvent` gains `{ type: "worker_note"; what: "gone"; worker: string;
   id?: string; reason: "lost" | "killed" | "exited" | "not_started"; exit_code?: number; at?: number }`. `decide()`
   journals `worker_note` and changes nothing else; it checks the shape only (`worker` and `id`: 1 to 64 characters
   of `[A-Za-z0-9._-]`; the enum; an integer; `at` not after the record's own time); a run that is not `running` or
   `paused`, a format without `workerNotes`, or a field that does not hold is a quiet no-op (`Repeat`).
   `FormatCapabilities.workerNotes`; `V2_ONLY_EVENTS`; `report.ts` gets the case beside `task_link`.
3. **Core, plan** (`serve/plan.ts`, exported as `@kodel-ai/pipeline-core/serve`).

   ```ts
   export interface ServeRules { enabled: boolean; max_workers: number; max_runs: number; stalled_after_s: number;
     start?: { pipeline: string; match: { status?: string[]; priority?: string[]; parent?: string } } }
   export interface ServeTaskView { key: string; title: string; status: string; state: TaskState; priority?: string;
     parent?: string; comment?: string; needs_approval?: boolean; started_runs: number }   // runs besides created_in_run
   export interface ServeWorkerView { id: string; name: string; state: SessionState | "unknown"; label: string;
     started: number; since?: number; exitCode?: number; sessionId?: string; resumed: number[]; resumes: number;
     decisionSeq?: number; lastOutputAt?: number }
   export interface ServeRunView { runId: string; status: RunStatus; canNote: boolean;          // format has workerNotes
     taskKey?: string; waitsForPerson: boolean; marks?: DecisionInfo; worker?: ServeWorkerView;
     noted: string[] }                           // record ids that have a `gone` note
   export interface ServeMemory { attempts: Record<string, { count: number; last_at: number; reason: string }>;
     mine: string[];                             // run ids this daemon started, for the count below
     dead_in_a_row: number; logged: string[] }   // marks of log lines already printed
   export interface ServeInput { now: number; rules: ServeRules; runs: ServeRunView[]; memory: ServeMemory;
     unreadable: { runId: string; why: "cannot_read" | "newer" | "modified"; detail: string }[];
     quietFrom: number;                          // daemon start or the last gap between cycles
     tasks?: { list: ServeTaskView[]; complete: boolean; priorities: string[] };
     environment: { ok: true } | { ok: false; reason: string } }
   export type ServeAction =
     | { kind: "note"; runId: string; worker: string; id: string; reason: "lost" | "killed" | "exited";
         exit_code?: number; at?: number }
     | { kind: "resume"; runId: string; seq: number; sessionId: string }
     | { kind: "start"; taskKey: string; pipeline: string }
     | { kind: "give_up"; taskKey: string; reason: string }
     | { kind: "log"; mark: string; problem: "stalled" | "dead" | "moved" | "no_session_id" | "unreadable"
           | "queued" | "environment" | "paused"; runId?: string; detail?: string };
   export interface ServePlan { actions: ServeAction[]; memory: ServeMemory;      // actions in order: notes, resumes, starts
     counts: { workers: number; max_workers: number; runs: string[]; max_runs: number };
     waiting: { resumes: string[]; starts: string[] }; orphans: string[] }        // open runs with a task and no agent
   export function planServe(input: ServeInput): ServePlan;
   export type Admission = { ok: true } | { ok: false; why: "done" | "not_todo" | "has_run" | "not_approved"
     | "gave_up" | "max_runs" | "max_workers" };
   export function admitStart(input: { task: ServeTaskView; runs: ServeRunView[];
     limits?: { max_workers: number; max_runs: number } }): Admission;          // the TUI passes no limits
   ```

   A run holds a place in `max_runs` when it is `running` or `paused` and has a worker whose verdict is not `dead`,
   `not_at_wait`, `already_resumed`, `no_session_id`, `agent_decided` or `over`. A worker holds a place in
   `max_workers` when its state is `starting`, `running` or `unknown`. `orphans` is for `--status` only; nothing acts
   on it. `no_worker` is never an action.
4. **Core and local, the task mark.** `tasks.ts`: `Task.created_by?: "agent"`, `Task.created_in_run?`,
   `Task.agent_edited_at?`, `Task.approved_at?`, `TaskSummary.needs_approval?` and `created_in_run?`, the pure
   `needsApproval(task)`, `NewTask.created_by?`, `TaskPatch.by_agent?` (set by the caller of the service, never read
   from a tool's input), `TaskAdapterCapabilities.provenance?: boolean`, optional `TaskAdapter.approve?(key, seen, o)`
   where `seen` is the `updated_at` the person was shown. `mcp/task-tools.ts`: `task_create` and `task_update`
   (`:110-153`, `:221-260`) pass the origin; the description of `task_create` and the task instructions gain one
   sentence each (a task you create is not started by `kodel serve` until the person approves it with `kodel task
   approve <key>`: tell them; do not edit the `serve` block of the config, do not run `kodel serve` or `kodel task
   approve`). `advanceForRun` does not mark. `TaskService.approve` is not in `buildTaskTools`. `local-adapter.ts`:
   the four keys in the schema and `FIELD_ORDER`, `provenance: true`, `approve` under the task's lock (refuses when
   `updated_at` is not `seen`; sets `approved_at` later than `agent_edited_at`); an update with `by_agent` that
   changes title, body, status, priority or parent (also through `clear`) sets `agent_edited_at`. CLI: `kodel task
   approve <key>` (`requireHuman`, `mustConfirm`), `task add` and `task set` mark unless `env.interactive` and no
   `KODEL_ENGINE`; `task show`/`list` and the TUI row and card show `waits for approval`.
   `testkit/memory-task-adapter.ts` and the adapter contract tests follow.
5. **Local, config** (`config.ts`): the zod block, `ProjectConfig.serve`, both return paths.
6. **Local, the note and the locks.** `LocalRun.noteWorker(input)`: under the run's lock, refuse a `worker` that is
   not `kw-<this run>` or `kw-<this run>-d<n>`, read the journal, return if a `gone` note with the same `id` (or,
   without an id, the same `worker` and reason) exists, else `apply({ type: "worker_note", … })`.
   `FileStore.withWorkerStartLock(fn)` and `LocalPipelineHost.withWorkerStartLock` (`<lockRoot>/worker-start.lock`
   with pid and identity; wait 15 s; taken over only when `sameProcess` says the holder is gone).
   `local/src/serve/files.ts`: `acquireServeRecord` (exclusive create; a live recorded process refuses with pid and
   `started`; a dead or recycled one is taken over behind a `.takeover` guard file, re-reading the same text before
   removing; unreadable or newer refuses and names the file), `writeCycle()` (temporary file and rename, with the
   Windows retry of `store.ts`; a failed write is logged and the cycle goes on), `release()`,
   `readServeStatus(place, now)` → `active | idle | off | silent | unknown` (`off` as soon as the recorded process is
   gone, `silent` when `now - cycle_at > 120 s`, `off` on Windows without reading anything). Paths from
   `resolveBase` and `sessionCheckoutKey` (imported, not changed).
7. **Local, loop** (`local/src/serve/daemon.ts`): `createServeDaemon(deps)` with `plan()` (reads and plans, acts on
   nothing: `--status` uses it), `cycle()` and `run(signal)`. A cycle: config (file hash outside `serve` and build
   stat against the start → 75; off or not loadable → idle); `runSummaries()` (ended runs remembered; runs of another
   checkout left out for workers, kept for "a run names the task"); `launcher.statuses` (a throw ends the cycle);
   `run.journal()` and `run.inspect()` for open runs whose worker is not `running`; when a start is possible, the
   preflight (kept 60 s; plus `worktree.mode` and the tracker's capabilities) and `tasks.list` filtered by the rule
   where the tracker can (pages of 200, at most 5); `planServe`; the actions one by one, each caught; `writeCycle`.
   A resume reads the journal again (same `seq`, not moved), then `launcher.resume`; `NAME_TAKEN` is success by
   someone else. A start, under the lock: count the attempt; read the task, the runs and the statuses again;
   `admitStart` with the limits; `host.start` (`task_key`, `restart: true`, caller `kodel-serve`); if its status is
   not `started`, stop here; `launcher.start`; if it throws, read the statuses: no record `kw-<run>` →
   `noteWorker` with `not_started`. Errors of the environment (`ChoiceNeeded`, `UNKNOWN_PIPELINE`, `CONFIG_INVALID`,
   `GIT_REQUIRED`, `STATE_LOCKED`, a failed preflight) take the attempt back. The host is given as a narrow port:
   `open`, `runSummaries`, `list`, `taskLink`, `start`, `withWorkerStartLock`.
8. **Testkit** (`scripted-launcher.ts`): a launcher port without processes that drives a run through the host on
   `start` and `resume` until a `waiting` or `done` answer, with switches for lost, silent, failing, and "throws
   after it made the record".
9. **CLI.** `cli.ts`: the launcher construction of `tui` moves into `openWorkerLauncher()`; the `serve` command
   (refusals, signals, exit codes, `--status`); `tui` gets `serve: () => readServeStatus(...)`; `status` prints the
   notes. `worker-launcher.ts`, `worker-launcher-session.ts`: `lastOutputAt`. `tui/worker-start.ts`: `startTask`
   under `host.withWorkerStartLock` (optional on `StartHost`). `tui/load.ts`, `tui/run.ts`, `tui/view.ts`: the
   daemon's status at each worker refresh, the header, two card lines (a dead worker, `kodel serve resumes it`),
   `worker_note` in `NOT_A_SIGN_OF_LIFE`. The worker's deny list is not changed: a worker has `KODEL_ENGINE`, and a
   `*kodel* serve*` pattern would refuse `npx serve` in a worktree.
10. **Fixtures.** `fixtures/formats/v2-worker/` (a real run with a `gone` note, taken with
    `scripts/take-format-fixture.mjs`) and its section in `fixtures/formats/README.md`; `fixtures/task-formats/v1/`
    (a real file from before and one with the keys); `fixtures/serve-formats/v1/serve.json`, written by a real daemon.
11. **Docs.** `docs/serve.md`: the block, a cycle, the two limits and the order, the pause after three dead workers,
    resume and its limit, the note, agent-made tasks and the approval, `--status`, exit codes, the record, the TUI
    with a daemon, the accepted risks in plain words, the limits above, what a unit needs (workers must outlive the
    daemon, 78 means do not restart, the state base, linger) and the two examples below, T-43.
    `docs/run-formats.md`: "Worker notes (TASK-G8KM, T-43)": format 2 gets the event from now on, also a run in
    flight; records already written are not rewritten; format 1 is unchanged; an older kodel ignores it and counts it
    as a sign of life; and "The `serve` block": an older kodel refuses the config, a server already running does not
    see it. `docs/tasks.md`: the mark, `kodel task approve`, the task file keys. `docs/history.md`: the event.
    `docs/decisions.md`: one paragraph. `AGENTS.md`: do not edit the `serve` block, do not run `kodel serve` or `task
    approve`; `task approve` among the human-only commands.

    ```ini
    # ~/.config/systemd/user/kodel-serve.service   (systemctl --user enable --now kodel-serve; loginctl enable-linger $USER)
    [Service]
    WorkingDirectory=%h/code/my-app
    ExecStart=/usr/bin/env kodel serve
    Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
    Restart=on-failure
    RestartSec=10
    RestartPreventExitStatus=78
    KillMode=process
    [Install]
    WantedBy=default.target
    ```

    ```xml
    <!-- ~/Library/LaunchAgents/ai.kodel.serve.my-app.plist   (launchctl bootstrap gui/$UID <file>) -->
    <plist version="1.0"><dict>
      <key>Label</key><string>ai.kodel.serve.my-app</string>
      <key>ProgramArguments</key><array><string>/usr/local/bin/kodel</string><string>serve</string></array>
      <key>WorkingDirectory</key><string>/Users/me/code/my-app</string>
      <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string></dict>
      <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
      <key>ThrottleInterval</key><integer>60</integer>
      <key>AbandonProcessGroup</key><true/>
      <key>StandardOutPath</key><string>/Users/me/Library/Logs/kodel-serve.log</string>
    </dict></plist>
    ```
12. **Decision T-43** (the person copies it to the decision log). *A daemon (`kodel serve`) starts and resumes
    background workers by the person's `serve` block; one pure function plans, one launcher starts each run's agent
    once, one lock admits, one owner resumes; it decides nothing about a run and writes only the fact that a worker
    is gone; a task an agent made or changed waits for a person.* Test plan: the `t43_*` tests. Refutation: the list
    under "Refuted".
13. `bun run typecheck`, `bun run lint`, `bun test`, `bun run build && node scripts/check-artifact.mjs`; the
    real-adapter and live tests and the manual scenario outside the sandbox.

## Affected files

New: `packages/pipeline-core/src/serve/{resume,plan,record,index}.ts` and the `./serve` export in its `package.json`;
`packages/local/src/serve/{daemon,files}.ts`; `packages/testkit/src/scripted-launcher.ts`;
`fixtures/formats/v2-worker/`, `fixtures/task-formats/v1/`, `fixtures/serve-formats/v1/`; `docs/serve.md`; tests
`packages/pipeline-core/test/serve-{resume,plan,record}.test.ts`,
`packages/local/test/{serve-daemon,serve-files,config-serve,task-mark}.test.ts`, `packages/cli/test/serve.test.ts`,
`tests/agents/claude-code-serve.test.ts`.

Changed: `packages/pipeline-core/src/{run,report,tasks,task-service}.ts`, `formats/{types,v1,v2}.ts`,
`mcp/task-tools.ts`; `packages/local/src/{config,store,host,pipeline-host,index}.ts`, `tasks/local-adapter.ts`;
`packages/testkit/src/{index,memory-task-adapter,task-adapter-contract}.ts`; `packages/cli/src/cli.ts` (expected
conflict with TASK-HN8N; if it lands first, the factory is cut from its version of `tui`),
`worker-launcher.ts`, `worker-launcher-session.ts` (one optional field), `task-format.ts`,
`tui/{worker-resume,worker-start,load,run,view}.ts`; tests `packages/pipeline-core/test/format-codecs.test.ts`,
`packages/local/test/formats.test.ts`, `packages/cli/test/{fake-launcher.ts,tui-worker.test.ts,worker-launcher.test.ts,tasks.test.ts,cli.test.ts}`;
`fixtures/formats/README.md`; `docs/{run-formats,tasks,history,decisions}.md`; `AGENTS.md`.

Not touched: `packages/pipeline-core/src/session.ts`, `sessions/`, `packages/local/src/session-*.ts`,
`fixtures/session-formats/`, `fixtures/formats/v1*`, `v2`, `v2-engine`, `packages/cli/src/claude-worker.ts`,
`adapters/` (empty today), `.kodel/pipelines/`, `.mcp.json`, the root `package.json`.

## Rejected review findings

From plan-revise 2 (critique attempt 2 and the recheck):

- **[scope] split into several PRs; the task mark and approval as a separate PR.** The person chose one PR and asked
  for the mark in this task. Kept; the plan says the mark is advisory against an agent that leaves the tools.
- **[scope] cut `match.priority`, `match.parent`, the unit examples.** The task's text asks for each ("status,
  priority, parent at least", "Docs: systemd and launchd unit examples"). Kept; the docs lead with what a unit needs.
- **[scope] cut `lastOutputAt`, stalled, the sleep-gap rule.** `lastOutputAt` is settled and the task asks for
  `stalled` from it; the gap rule is ten lines and stops a comment storm after sleep. Taken from the finding: the
  `stalled` word in the TUI and the `held` log line are cut.
- **[scope] the TUI surface is too large.** Kept: the start lock and the hand-over of the resume (needed), the header
  (the task: "shows that the daemon is on"), the `kodel serve resumes it` line (it explains the missing offer), the
  dead-worker line (the person: visible in the TUI). Cut: the stalled line.
- **[scope] Decision 2 of the earlier list needs a start filter by creation time or an allow-list key.** No new
  data: `--status` shows what would start before the person turns it on, and `match` is the allow-list.
- **[gaps] the one-daemon guard must not depend on the state base; a foreign `starting` note must not be finished.**
  The second half is gone with the notes. Two daemons under two state bases can no longer put two agents on one run:
  each resumes only workers it can see, and a start is admitted under the lock in the lock root. What is left
  (limits counted apart) is a documented limit and a manual check; a long-lived file in `.kodel` would sit in `git
  status` for as long as the service runs.
- **[gaps] the starting mark must be one write with the run.** Not taken: Decision 1 (a) accepts that window instead
  of adding a field to `run_started`; option (b) there is this finding.
- **[gaps] (1) of the working-tree finding, a second start after `git stash -u` or `git clean`.** Not closed: with no
  state outside the tree (the person's decision) nothing remembers the start. Documented as a limit; (2) and (3) of
  the finding are in the risks and the docs.
- **[invariants] put the rule into the per-agent deny rules in `adapters/`.** The folders are empty; there is nothing
  to extend. Taken instead: the rule is in the MCP server's task instructions, and the plan says that outside this
  repository that text and `KODEL_ENGINE` are the only guards.
- **[tests] a test for "an older kodel ignores the note, refuses the config, keeps the task keys".** Cannot be run
  here; named as a check at release, and what this build promises is pinned (`t43_release_note_promises_are_pinned`).
- **[recheck, tests] a test for a record removed before the `started` note; [recheck, invariants] the journal
  contradicts itself after a launcher that throws.** Both notes are cut; the second is now
  `t43_launch_that_spawned_is_not_noted`.

Decided by the person at plan-approval (each stands as an accepted risk above): **I3, G6, G7, S8** (no approval of
the block); **S2, S11 in part** (one PR; still cut: `poll_s`, `max_start_attempts`, the rule list); **G2, I7, G14,
T4 in part** (no state file); **I2, S4** (answered by the mark, not by caps).

Rejected earlier on the merits and unchanged: **I8** (`worker-start.lock` stays in the lock root: it guards the
history, and `start.lock` is there already); **G18** (the CLI resolves a run's worktree to its project,
`cli.ts:242-244`); **S9, second half** (the record needs a `v` because a TUI of another build reads it); **S1,
second half** (no journal mark for a resume: the record's name says it); **S3, in part** (the task asks for stalled
and the give-up); **G12** is met by not touching the deny list.

## Findings in the code

- `packages/cli/src/worker-launcher.ts`: `WorkerLauncher` (`preflight`, `start`, `resume`, `statuses`, `progress`,
  `logs`, `stop`); names `kw-<run>` and `kw-<run>-d<seq>`; `WorkerStatus` has no `lastOutputAt`.
- `packages/cli/src/worker-launcher-session.ts`: records are read through a child (`kodel agent ls --json`), and
  `listAll` throws when it fails or prints no JSON (`:224-239`); `parseEntry` drops `lastOutputAt`, which
  `PipesSessionAdapter.list()` returns (`packages/local/src/session-pipes.ts:312-320, 595-643`). Workers are started
  with `origin: "cli"` (`:277`), so `kodel agent rm` frees the name (`session-pipes.ts:584-590`): a name can be used
  again, and "no record" does not mean "never started". `preflight` refuses on `win32`, `decisions.dialog`, no
  `claude`, not signed in, no task link, no pipeline.
- `packages/cli/src/tui/worker-start.ts`: `startTask` checks "done" and "an active run names the key" outside any
  lock, then `host.start({ task_key, restart: true, caller: kodel-tui })` and refuses a status that is not `started`,
  then `launcher.start`; `resumeWorker` reads the journal again and treats `NAME_TAKEN` as done.
  `tui/worker-resume.ts`: `decisionOf` and `resumeOffer` are pure but live in the CLI; the resume is offered, never
  automatic (`docs/plans/task_9pns.md`, Decision 1).
- `packages/local/src/host.ts:751-915`: `start` looks for an active run by pipeline and task text, not by task key,
  and hands an existing one back as `reused` (`:806-809`); `run_started` journals the caller only with
  `history.executor` on. `packages/local/src/store.ts:1219-1365`: `withStartLock` is queued per process and not
  re-entrant, waits 10 s, tells a dead holder by pid only and takes a live one over after 60 s.
- `packages/pipeline-core/src/run.ts:838-850, 1874-1882`: `task_note` is a host-written, journal-only event, applied
  from `packages/local/src/host.ts:2008`; `run.ts:2488-2505`: `agent_session_named` is a quiet no-op (`Repeat`) for a
  format without `sessionNames`. `formats/types.ts:19-35`: `FormatCapabilities`; `formats/v1.ts:200-209`:
  `V2_ONLY_EVENTS`; `formats/v2.ts`: format 2 stores the model and its records as they are.
  `packages/pipeline-core/test/format-codecs.test.ts:554-579`: the key-table test reads every `this.log("…")` of
  `run.ts`, and an event the engine does not know is read, written back and reported as absent.
  `docs/run-formats.md:12-14, 36-48`: format 1 is what the published beta wrote; `agent_session_named` was added to
  format 2 with a capability and a release note, the pattern this plan follows. `fixtures/formats/` has `v1`,
  `v1-open`, `v2`, `v2-engine`. `packages/cli/src/tui/load.ts:394`: `NOT_A_SIGN_OF_LIFE`.
- `packages/local/src/tasks/local-adapter.ts:127-160, 534, 654`: a task file has `v: 1`, the schema passes unknown
  keys through and writes them back, an update runs under a lock file next to the task; there is no creator field.
  `packages/pipeline-core/src/tasks.ts`: "inside a major version everything new is optional".
  `mcp/task-tools.ts:110-153, 221-260`: `task_create` takes an optional `run` (kept in the task's `runs`, so
  `run_count` alone cannot mean "was started"), and `task_update` changes title, body, status, priority and parent of
  any task. `cli.ts:435`: `kodel mcp` builds the task service once; `cli.ts:1523`: `kodel task add` asks for no
  terminal.
- `packages/pipeline-core/src/run-task.ts`: a run started with `task_key` moves the task to `progress` and attaches
  the run; a failed run only comments.
- `packages/local/src/config.ts`: every block is strict; an unknown top-level key is refused with "is the file written
  for a newer kodel? upgrade kodel or remove the key". `kodel init` writes no `.gitignore` (`docs/history.md`).
- `packages/local/src/storage-paths.ts:130, 193-217`: the lock root is `.kodel` in `project` mode; session records
  and the daemon's record are under the state base (`KODEL_STATE_DIR`, else `~/.kodel`).
  `packages/local/src/process-table.ts`: `sameProcess(pid, identity)`, `processIdentity` (POSIX only).
- `packages/cli/src/cli.ts:771-864`: `tui` builds the launcher inline; `requireHuman` (`cli.ts:340`) needs a terminal
  and refuses under `KODEL_ENGINE`. `packages/cli/src/claude-worker.ts:27-45, 231`: the deny list is verbs after any
  spelling of the binary; the worker's environment keeps only `KODEL_ENGINE` of the `KODEL_*` names.
- `adapters/claude-code`, `adapters/codex`, `adapters/opencode` are empty. The highest decision id is `T-42`.

## Deviations

- Step 9 says the worker's deny list is not changed. `task approve*` was added to `WORKER_DENIED_COMMANDS`
  (`packages/cli/src/claude-worker.ts`): `kodel task approve` is a person's command and refuses under
  `KODEL_ENGINE` all the same, but denying it up front keeps a worker from trying. Unlike a `serve*` pattern it
  matches only after a spelling of the kodel binary, so no other program is refused.
