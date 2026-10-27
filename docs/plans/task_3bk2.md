# TASK-3BK2: keep the agent's conversation log of a run (`agent_log/`)

## TL;DR

- The engine reads the sessions that **have this run's id in their own `pipeline_*` calls**, outside the run lock, cuts the events to the
  run window, appends redacted normalized events to `agent_log/<session>.jsonl`, and journals one `agent_log_saved` while the run is
  `running`. It does so **every 10 s while the run is going** (a ticker in the MCP server, as the person asked) and as a **final pass at
  the end of each step**, before `run_finished`. The raw log is never copied. On by default, `full` (52A8); `metadata` has no text;
  `enabled: false` writes nothing.
- What round 5 of the critique changed: the checkpoint is no longer a clone but the writer's **live reader state** resumed from the last
  whole line (no cloning, no cap games, and equal to a full read by construction); a stored-tail hash and a token check **fence** the
  file against a second writer; resumed reads can never duplicate (journaled `first_seq`/`last_seq`); a slow first read stores what it
  has instead of stalling; **after `/clear` the hook index's sessions are also candidates** (the run id in the log is the proof), so the
  common `/clear` workflow keeps working; one ticker per process, only in the MCP serve path; the false "heartbeat journals every 10 s"
  claim is gone and the cost is stated; caps move into core. Earlier rounds: run-id proof, one parametrised lock, probe step 0,
  kind-neutral budget, pseudonymised ids, fixtures outside the hashed `v1/` tree.
- Cost: large; commits in this order so the ticker is last and separable: (A) collector options, (B) config, events, store, final-pass
  writer, report, docs, (C) ticker. Risks: full sessions in git; `v: 1` loosened before the first release; a run that ends without a
  step completion loses at most one tick and the open response; every journaled tick rewrites `state.json` (new traffic during agent
  steps, bounded by a cap).
- Nothing is ever journaled to a finished run. An unjournaled tail can remain after a race and is never read.

## Decisions needed

**Answered by the person:** 1 (a), 2 (a), 3 (a), 5 yes, 6 yes, 7 yes; 4 "to be checked"; and capture "end of step + every 10 s while the run
is going" (Decision 8). Still open: **4 (revised below)** and **8** (key name and cap).

4. **Which sessions are candidates (revised, your call).** Step 0 already showed the variable is in the environment of all seven running
   `kodel mcp` processes. But the server inherits `CLAUDE_CODE_SESSION_ID` of the **first** session of its Claude Code process; after
   `/clear` the new session has another id, so with env only, every later run in that window would store nothing. Since the proof is the
   run id inside the log (Decision 3), more candidates cost nothing in safety. (a) Candidates are the env session **plus** the sessions in
   `.kodel/sessions.jsonl` for the run's directories (one line per `SessionStart`, which fires for `clear`, `resume` and `startup`), each
   accepted only if its own log has the run id in a `pipeline_*` call; both the old and the new session of a run that crossed a `/clear`
   are then stored, each from its first call with the run id (recommended). (b) Env session only (the previous plan). *Without an
   answer: (a).* Needs the hooks (`kodel init`); without them it degrades to (b).

8. **The ticker.** Interval 10 s as asked, `history.agent_log.interval_s` (default 10, whole seconds ≥ 1, `0` = final pass only). One ticker
   per run **per process** (a registry on `LocalPipelineHost`, keyed by run id), started only in the MCP serve path at the first `start`,
   `next_step` or `complete_step` of a run, never by the CLI (`status`, `report`, `wait`, `gate`) and never from `inspect`. It is `unref`'d,
   uses an injected timer, stops when the run is not `running`, and is stopped by `LocalPipelineHost.stop()`. It does not start if the
   environment gives no session candidates, if the run has no `agent_log` in `run_started.history`, or if it is disabled. It keeps
   running while the run waits at a gate (the run stays `running`), which is the point of the 10 s capture and is a Decision 7 risk. After
   3 failed ticks in a row (state unreadable, `STATE_MODIFIED_EXTERNALLY`, folder gone) it stops and journals the reason once. At most
   4000 `agent_log_saved` per run, enforced **in core** (like `MAX_LOGGED_REFUSALS`), then the ticker stops with `tick_cap` once and the
   final pass continues. (a) This (recommended). (b) No config key, fixed 10 s. *Without an answer: (a).*

1. **`kodel export` does not exist.** Answered (a): seal and report only; a follow-up task only if you say so.
2. **One task or split.** Answered (a): one task. Commits are ordered A, B, C, so B alone delivers the 52A8 behaviour and C (the ticker with
   its ~45 tests) can be cut into a follow-up if you change your mind. The scope review asked again for exactly this cut; I kept (a) as you
   answered, and say it here so it is not hidden.
3. **Proof and window (answered a).** A session counts if its own log holds a `pipeline_*` tool call (tool-name suffix `pipeline_start`,
   `pipeline_next_step`, `pipeline_complete_step`, any server name) whose input or paired result contains **this run's id**; the window
   starts at the first such call. The collector finds the id in the full call text even in `metadata` mode (nothing of it is stored). The
   `/clear` and resume cases follow from it (see 4). Text of the same response before the call is outside. This deviates from the 52A8
   wording "from the response that issued `pipeline_start`"; the docs say so.
5. **Metadata mode drops `session.cwd` and `git_branch`** (answered yes).
6. **Format changes under `v: 1` (answered yes):** `text_preview` optional; the cut marker is a `system` event `subtype: "agent_log_cut"` with the
   `seq` and `ts` of the last dropped event (never a cursor); 9JRS's `revision`/`source` are not added here. At the first release the
   golden fixture of a run with `agent_log/` (outside the hashed `v1/` tree now) is moved under the frozen set or its hash pinned: a
   checklist line in the PR and the docs.
7. **Residual risks, written into the docs, not filtered (answered yes):** while a run waits at a gate everything else the same session does is
   in `full` mode, and the ticker keeps copying it; an agent that starts its own `kodel mcp` with a chosen session id and the run id can
   copy another session of the project into `.kodel/runs`; redact rules are read live, so a rule removed mid-run keeps earlier redactions;
   a copy is "at most one interval behind what the agent has flushed" (Claude Code may buffer); the docs recommend ignoring
   `.kodel/runs/*/agent_log` in projects that track `.kodel/runs`.

## Behaviour change

- A run leaves `agent_log/<session>.jsonl` per proven session (subagents as their own files with `parent_session_id`), inside the window,
  redacted, at most one tick behind what the agent has flushed. `kodel report` shows one line: sessions, entries, bytes, mode,
  `complete`, the step whose share was full, or `not_collected` with one reason (`session_unknown`, `log_missing`, `refused`,
  `log_changed`, `stored_copy_changed`, `tick_cap`, `disabled`) and `unverified`. The reason strings are exact and never say "modified".
- Projects that upgrade start storing full sessions unless `history.agent_log` says otherwise. The docs lose "not yet built"; the "When"
  rule of 52A8 ("at the end of each step and of the run") becomes "every `interval_s` seconds and at the end of each step", and the
  "tail may be missing" line becomes "at most one interval and the open response".
- What the agent is told never changes; a failed capture never fails a step. The final pass is short because the ticker copied most of it.
  After a server restart the first pass reads the log from the start and is bounded (below), so a very large session catches up over
  several ticks. `report` and `status` show running attempts' seconds up to the last journal record, which ticks now advance (a change
  of display only, documented).
- Nothing but `report` reads `agent_log/` yet: this task produces data with no other consumer (said in the PR).

## Risks and invariants

- **One pass function, two callers.** `capture(run, why)` is idempotent and never throws into a caller. (1) The ticker (Decision 8): skipped
  if a pass of that run is in flight in this process, takes the lock without waiting (busy → skip). (2) The final pass in `completeStep`,
  after the "change pending" no-op check and before the completing event, waiting up to 5 s for the lock. Both first check from `state()`
  (status `running`; for the final pass an active visit with this node and attempt, the node coming from the state, never from the call);
  a refused call reads nothing. Nothing runs under the run lock: the pass takes the per-run `agent_log` lock and, inside it, the run lock
  only through `apply` of `agent_log_saved`. Order is always `agent_log` lock → run lock.
- **Fencing (the lock can be taken over).** The `agent_log` lock has its own staleness of 5 min (a per-lock parameter of the existing
  `FileStore` lock code; no heartbeat). The whole pass has a 30 s budget (read, redaction, append) checked between stages; at the end it
  aborts rather than continue. Before each of truncate, append and `apply` the holder re-reads the lock file and checks its token; if
  the lock is no longer its own, it aborts without writing. Residual race (a takeover between the check and the write) is detected, not
  prevented: `agent_log_saved` carries `tail_hash` (sha256, lowercase hex, of the last 64 bytes of the stored stream at `stream_to`);
  the next pass verifies it before truncating or appending and stops that session with `stored_copy_changed` on a mismatch.
- **Write order and recovery.** Truncate the file to the journaled length (drops only unjournaled bytes; history is not rewritten), append
  whole lines, fsync, `apply`. A crash before the journal leaves an unjournaled tail that the next pass drops; after it, nothing is lost.
  If the file is shorter than the journaled length, or its stored prefix does not parse, it is never extended: `stored_copy_changed`. The
  reader trusts the journal: bytes past the last `stream_to` are "not stored", neither "cannot read" nor "modified". `agent_log_saved`
  and `agent_log_failed` are refused unless the run is `running`; the race "run ended between append and journal" is narrowed by the
  status check under the lock and accepted.
- **The last pass lands before `run_finished`**; a run that ends otherwise (cancel, gate rejection, failed check, timeout, a last human or
  command node) gets no final pass, and loses at most one tick and the open response: `complete: false`, "ended without a final pass". The
  step's own `pipeline_complete_step` call is in the open response and is never in that step's pass.
- **Cursor and no duplicates.** `agent_log_saved`: `session`, `first_seq`, `last_seq`, `stream_from`, `stream_to`, `tail_hash`, `last_key`,
  `entries`, `bytes`, `node`, `complete`. Core refuses an event unless the run is `running`, `stream_from` equals the journaled length,
  and `first_seq` is greater than the previous `last_seq` of that session (neutral names; no file concept beyond a stored-stream length).
  Every path filters `seq > journaled last_seq`, and a resumed read is used only if its state's seq equals the journaled `last_seq`, so
  two servers with different checkpoints cannot store an event twice. `last_key` is the lowercase hex sha256 of `ts|kind|ids` of the event
  at `last_seq` computed over the **pseudonymised** ids and keyed by the run id (stable under redact-rule edits, no secret in the hash,
  unchanged by the journal's entropy redaction because it is hex). A log shorter than before or with another `last_key`: `log_changed`
  once, capture of that session stays stopped (a same-length rewrite before `last_seq` is a known gap).
- **Resumable reading without cloning.** The writer keeps, per session in memory, the **live reader state** (the collector's normalizer
  state, its `seq`, `lastTs`, `chosen` profiles, `drifted`, counters) and the byte offset after the last whole line processed. A pass
  resumes at that offset with that same state object, so the open response simply stays pending inside it and is emitted when it
  closes: nothing is cloned, nothing is trimmed, and `seen` keeps its collector cap (`SEEN_CAP`), so a resumed read equals a full read by
  construction. With the hold-back option the collector returns events only up to the last closed response; the rest stays in the state.
  A torn last line is not consumed (the offset stops at the last newline). Before using it the writer checks that the file is at least
  `offset` long and that the sha256 of the 64 bytes before `offset` is the stored one; any mismatch, a restart, or a session evicted from
  the memory table (at most 8 sessions kept, dropped when the run ends) means **a full read from byte 0**. The state is bounded by
  `SEEN_CAP` and the call table cap. A full read is bounded by the pass budget: when the budget ends it **stores everything up to the last
  closed response it reached and keeps that state**, so the next tick continues; a huge session catches up over several ticks instead of
  stalling.
- **Session candidates and files (Decision 4).** Candidates: the env session and the hook-index sessions of the run's directories; each
  is accepted only with the run id in its own log (found without storing text). Path of a candidate: the index's `transcript_path` when it
  names it, else `<store>/<folder>/<session>.jsonl` for the run's directory, the root and the scan folders of `foldersFor`;
  `claudeConfigDir(env)` comes from `host.options.environment` so tests can fake the store; `assertInside` as always. The run's `workdir`
  is passed as `extraWorkdirs` (a removed worktree is not refused). Subagent files are found by listing `<session>/subagents/`, named with
  `SAFE_SESSION` plus the reserved-name rule of `artifactFileName`. **Per-pass I/O is cached** per session for the life of the ticker (the
  project workdirs from `git worktree list`, the `cwd` verdict) and dropped on a fallback to a full read.
- **Principle 3.** `writeAgentLog` runs `redactDeep` with the store's rules over the **whole** event, on top of the collector's redaction
  before the cut. No id is exempted: when redaction would change an id, the writer replaces it everywhere with a stable pseudonym
  `id-<hash of id + run id>`, so call and result still pair and a secret never reaches the file through an id. Size and `max_kb` are
  counted after the last redaction.
- **Principle 1.** Display data only; keys frozen in `run_started.history`; session ids in file names guarded; node and attempt from state;
  the first-`cwd` rule is the existing collector rule; the forged-session path is Decision 7.
- **Principle 4.** Core: config data (`DEFAULT_AGENT_LOG`), the two events and their acceptance rules (running, `stream_from`, `first_seq`,
  the 4000 cap, once per reason for `agent_log_failed`), counters, the report line; no I/O. There is no store interface in core
  (`backend.ts` is empty): file operations are in `FileStore` like `writeServed`; the ticker, the lock and the readers are in `packages/local`.
- **Principle 5.** The clock, the tick timer, the 30 s budget and the lock's wait and staleness come from injected seams. This needs
  plumbing that does not exist: `HostOptions` passes `lockTimeoutMs`, `staleLockMs`, a per-call wait and a sleep to `FileStore`.
- **Principle 6.** Nothing a person decides becomes agent-callable.
- **Principle 7.** The budget never matches a node kind.
- **Principle 8 / stored data.** Optional keys and events only. A run without `run_started.history.agent_log` reads "not captured"; a file
  without the journal reads "mode unknown"; an unknown `v` in the journaled range is "cannot read (format X)", other damage there is
  "damaged, unverified"; never "modified". Fixtures: "a run from before the change" is the existing `v1` runs (opened with `status` and
  `report`); the run **with** `agent_log/` is a real sanitized run in `fixtures/agent-log/`, outside the hashed `v1/` tree (Decision 6).
- **Seal.** `agent_log/` is outside the seal and shown `unverified`; `agent_log_saved` is in the sealed journal.
- **Journal and state cost (stated, not hand-waved).** There is no heartbeat in the journal today: the `heartbeat` event only updates
  the visit and rewrites `state.json`, and only while the engine runs commands. A journaled tick is new traffic during agent steps: one
  `state.json` rewrite (tmp, fsync, rename), an integrity update and a journal append with fsync, at most every 10 s and only when
  something new was appended, at most 4000 per run. `kodel wait` and `status` read the state while it is renamed (a Windows test with a
  concurrent reader). A benchmark test runs `report` and `status` on a run with 4000 saved events.
- **Switches.** Independent of `history.executor`. With `tool_log: false` no `tool_call`, `tool_result`, `subagent` events and no subagent
  files are stored.
- **Budget (kind-neutral).** The cumulative allowance at a node is `floor(max_kb × 1024 × (index + 1) / nodes)` minus the bytes already
  used, with `index` and `nodes` taken from the pipeline pinned at run start and journaled; a node that is not in that list (added by an
  accepted change) may use what is left of `max_kb`; a revisit may use its node's own share while the total stays within `max_kb`.
  Nodes with no pass carry their share on automatically. An event over the allowance is dropped, counted in one `agent_log_cut` marker per
  step; never a half line.
- **Failures.** `agent_log_failed` is journaled once per reason per run (counted in core from the state, so a restart does not repeat it)
  and not at all when there is no candidate (an agent without a collector). A tick never journals a failure before the run has had a
  step end.
- **Test hosts.** `LocalHost` falls back to `process.env`, and inside Claude Code `CLAUDE_CODE_SESSION_ID` is set. The testkit's
  `scenarioHistory()` therefore sets `agent_log.enabled = false` and `interval_s: 0`, and existing tests that start runs with `history`
  pin `environment: {}`, in the **same commit** as the first code that reads the environment.

## Acceptance criteria and tests

Prefix `t3bk2_` (the 52A8 decisions have no ids in the repository; renamed in the PR, a checklist item). Fake clock, manual ticker, latches and
fault injection everywhere; no sleeps. Each commit carries its tests and passes `typecheck`, `lint` and `test` alone. Real = `tests/agents`,
run by the person before merge behind an env gate, not in CI; the result goes into the PR.

| Step | Criterion | Tests |
| --- | --- | --- |
| 0 | The server sees the variable (pass: present in a fresh server process; Claude Code version recorded) | probe result in the PR; real test asserts `observed-env` first |
| A | Defaults unchanged, options inert, goldens regenerated from the old code in the first commit | `t3bk2_golden_unchanged_default_options`, `t3bk2_options_inert` |
| A | Metadata: every field of every kind classed allow/deny by a schema test; canary text in each field absent; `text_preview` absent validates; old events parse | `t3bk2_metadata_allowlist_no_text`, `t3bk2_metadata_events_validate`, `t3bk2_old_event_still_parses` |
| A | Caps | `t3bk2_caps_per_kind`, `t3bk2_caps_one_number`, `t3bk2_caps_zero`, `t3bk2_caps_boundary`, `t3bk2_caps_surrogate_and_cjk`, `t3bk2_caps_invalid` |
| A | Hold-back of the open response; the live state resumed at every line boundary of a real fixture equals a full read (same `seq`, pairing, `duration_ms`, no repeated `session` event), including a fixture with repeats (re-emitted message id after `/compact`, a late tool result); torn last line not consumed; stale offset or tail hash falls back to a full read; state bounded on a long session | `t3bk2_open_response_held_back`, `t3bk2_resume_equals_full_read`, `t3bk2_resume_equals_full_read_with_repeats`, `t3bk2_resume_torn_line`, `t3bk2_resume_stale_falls_back`, `t3bk2_resume_state_bounded` |
| A | Redaction: before the cut; no 8+ character substring of a planted known-pattern token survives the cut; project rule; an unknown-pattern token stays (negative control, pins the documented gap with a hex-only token); the writer redacts with the collector's redaction stubbed off | `t3bk2_redact_tool_input`, `t3bk2_redact_tool_result`, `t3bk2_redact_user_and_agent_text`, `t3bk2_redact_across_cut`, `t3bk2_redact_project_rule`, `t3bk2_redact_unknown_pattern_stays`, `t3bk2_redact_writer_pass_collector_off` |
| A | Ids: pseudonym keeps pairing; a secret-looking id never in the file | `t3bk2_ids_pseudonym_keeps_pairing`, `t3bk2_secret_in_id_not_stored` |
| B | Config: defaults, bad values (`max_kb` 0, negative, huge, bad mode, bad `interval_s`), frozen at start, not captured, mode unknown, exact key list including `interval_s`, every documented default equals `DEFAULT_AGENT_LOG` | `t3bk2_defaults`, `t3bk2_config_rejects_bad_values`, `t3bk2_config_frozen`, `t3bk2_not_captured`, `t3bk2_mode_unknown`, `t3bk2_history_keys_exact`, `t3bk2_docs_defaults_match` |
| B | Core events: refused unless running; `stream_from` mismatch refused; `first_seq` not above the previous `last_seq` refused; the 4000 cap and once-per-reason counted in core and surviving a restart; `last_key`, `tail_hash` and session names round-trip unchanged through the journal, also with a hostile project rule | `t3bk2_saved_event_rules`, `t3bk2_saved_first_seq_rule`, `t3bk2_cap_in_core_survives_restart`, `t3bk2_failed_event_once_per_reason`, `t3bk2_journal_round_trip` |
| B | Store: name guard, truncate to the journaled length, append, fsync; shorter stored file stops (never extended); `tail_hash` mismatch stops; lock order; no-wait skip; per-call wait; a stale lock (older than 5 min) is taken over; a live holder inside the staleness is kept; a holder whose lock was taken over writes nothing (token check before truncate, append, apply) | `t3bk2_store_name_guard`, `t3bk2_store_truncate_to_journal`, `t3bk2_stored_file_shorter_stops`, `t3bk2_tail_hash_mismatch_stops`, `t3bk2_lock_order`, `t3bk2_lock_busy_skips`, `t3bk2_lock_wait_5s`, `t3bk2_lock_stale_takeover`, `t3bk2_lock_live_holder_kept_within_staleness`, `t3bk2_taken_over_holder_writes_nothing` |
| B | Proof and candidates: first call with the run id; run id in input only (resumed session); found in `metadata` mode; other run's id → unknown; two runs in one session; same response ends A and starts B; text before the call outside; failed start call; env absent and no index → unknown; `/clear`: the new session from the hook index is accepted by the run id and the old one stays stored; an index session without the run id is refused; a different id in a later step keeps the first file; forged id from another project refused; the own-server forgery is the documented gap | `t3bk2_proof_first_call_with_run_id`, `t3bk2_proof_resumed_session_captured`, `t3bk2_proof_metadata_mode_still_matches`, `t3bk2_proof_other_run_id_is_unknown`, `t3bk2_proof_two_runs_one_session`, `t3bk2_proof_same_response_ends_and_starts`, `t3bk2_proof_text_before_call_outside`, `t3bk2_proof_failed_start_call`, `t3bk2_proof_no_candidates_unknown`, `t3bk2_proof_clear_new_session_via_index`, `t3bk2_proof_index_session_without_run_id_refused`, `t3bk2_proof_later_session_keeps_first_file`, `t3bk2_proof_cross_project_refused`, `t3bk2_forged_own_server_documented_gap` |
| B | Subagents: own files, marked, parent not proven → not stored, nested, none with `tool_log: false` | `t3bk2_subagent_files_marked`, `t3bk2_subagent_parent_not_proven`, `t3bk2_subagent_nested`, `t3bk2_tool_log_off_no_tool_or_subagent` |
| B | Pass: round trip; idempotent; refused call and forged node/attempt read nothing; after the pending-change no-op; the run lock never held at `apply` (lock-order spy); does not block `pipeline_next_step` (latch); the 30 s budget with a fake clock stores up to the last closed response and the next pass continues (repeatedly hit); crash before journal and after journal (injected failure); torn tail not stored; two hosts with different checkpoints on one session store no event twice | `t3bk2_round_trip`, `t3bk2_pass_idempotent`, `t3bk2_refused_call_reads_nothing`, `t3bk2_forged_node_reads_nothing`, `t3bk2_pending_change_noop_first`, `t3bk2_run_lock_not_held_at_apply`, `t3bk2_pass_outside_run_lock`, `t3bk2_budget_bound_stores_partial_and_continues`, `t3bk2_crash_before_journal`, `t3bk2_crash_after_journal`, `t3bk2_torn_tail_not_stored`, `t3bk2_two_hosts_no_duplicates` |
| B | End of run: last pass before `run_finished`; other ends → `complete: false` with the right reason; nothing journaled to a finished run by host, executor, CLI `gate`/`resume`/`seal` (function level), `tieEnd`'s own event excepted; the race tail is not read | `t3bk2_last_pass_before_run_finished`, `t3bk2_other_end_incomplete`, `t3bk2_finished_run_not_journaled`, `t3bk2_race_tail_not_read` |
| B | `log_changed` stops once and stays; a redact-rule change mid-run is not `log_changed` | `t3bk2_log_changed_stops_once`, `t3bk2_rule_change_not_log_changed` |
| B | Budget: cumulative allowance, floor, carry across nodes without a pass (the `dev.yaml` shape), revisit within the total, a node added by `pipeline_accepted` uses the remainder, a node inserted before the current index, one event over the allowance, marker count = dropped events, total never above `max_kb` (property test) | `t3bk2_budget_cumulative`, `..._floor`, `..._dev_pipeline_shape`, `..._revisit`, `..._added_node_uses_remainder`, `..._inserted_before_index`, `..._event_over_allowance`, `..._marker_count`, `..._total_never_exceeds` |
| B | Failures never fail a step: store throws, read-only directory, full disk, worktree removed, log missing | `t3bk2_failure_never_fails_step`, `t3bk2_worktree_removed`, `t3bk2_missing_log_not_collected` |
| B | Hardening (collector tests not repeated): bounded buffer by a byte-counting reader at small scale in CI; a long line; NUL, junk and invalid UTF-8; symlink and path outside the store; `cwd` variants; bad session ids (`..`, `/`, NUL, long, `con`, `nul` on all OSes) | `t3bk2_hardening_stream_bound`, `..._long_line`, `..._junk_nul_utf8`, `..._symlink_and_outside_store`, `..._cwd_variants`, `..._session_ids` |
| B | Report: line text and exact reason strings (never "modified"), `unverified`, no `cwd` needed; `report` and `status` open no file under `agent_log/` (spy); seal verifies after editing `agent_log/` and a changed `agent_log_saved` journal record breaks it; torn file and unknown `v`; running-attempt seconds up to the last journal record (finished attempts unchanged); `report` and `status` on a run with 4000 saved events stay within a stated bound | `t3bk2_report_line`, `t3bk2_report_reasons_exact`, `t3bk2_report_does_not_open_file`, `t3bk2_seal_ignores_agent_log`, `t3bk2_seal_covers_saved_event`, `t3bk2_cannot_read_not_modified`, `t3bk2_damaged_is_not_format_x`, `t3bk2_report_running_attempt_time`, `t3bk2_report_4000_events` |
| B | Old runs: the existing `v1` runs open with `status` and `report`; the real sanitized run in `fixtures/agent-log/` opens | `t3bk2_old_run_still_opens`, `t3bk2_agent_log_run_opens` |
| B | Test hosts are isolated: a test fails when it would read the runner's `CLAUDE_CODE_SESSION_ID` | `t3bk2_test_hosts_isolated_from_env` |
| B | Docs: exact strings ("not yet built" gone, the "When" rule, the Decision 3 deviation, the "exact, since the agent starts a server per session" line corrected, Decision 7 risks, `interval_s` key, latency, retention advice, truncate note, the release-freeze checklist) | `t3bk2_docs_text` |
| C | Ticker (manual ticker, fake clock): starts in the MCP serve path from each of `start`, `next_step`, `complete_step` and never from the CLI hosts or `inspect`; one per run per process even when the run is opened through two `LocalHost` objects; stops when the run is not `running`, on persistent errors (3 in a row, reason once) and in `stop()`; no leaked timer (`unref`) after the run ends or the host closes; does not start without candidates, without `agent_log` in `run_started.history`, or when disabled; a tick appends and journals only when there is something new; in flight → next skipped; busy lock → skipped; quiet before the first step end; `interval_s` from config, `0` off; restart resumes from the journal with a full read; the cap stops it once and the final pass continues; keeps running through a gate | `t3bk2_tick_starts_from_serve_path_only`, `t3bk2_tick_one_per_run_per_process`, `t3bk2_tick_stops_on_not_running`, `t3bk2_tick_stops_after_3_failures`, `t3bk2_tick_stopped_by_host_stop`, `t3bk2_tick_unref_no_leak`, `t3bk2_tick_not_started_without_candidates`, `t3bk2_tick_writes_only_new`, `t3bk2_tick_in_flight_skips`, `t3bk2_tick_busy_lock_skips`, `t3bk2_tick_quiet_before_first_step`, `t3bk2_tick_interval_config`, `t3bk2_tick_restart_full_read`, `t3bk2_tick_cap_once`, `t3bk2_tick_runs_through_gate` |
| C | Ticks vs the rest: two servers ticking one run (different checkpoints, alternate writes, no duplicates, stale checkpoint caught by the stored-length and tail-hash checks); ticks do not change timeouts; a tick racing a run end is refused; a crash during a tick follows truncate-to-journal; the stored log is at most one interval behind a growing fake log; a hard drop of the server between append and journal keeps everything up to the last journaled tick; the per-session I/O cache is dropped on a fallback | `t3bk2_two_servers_one_run_tickers`, `t3bk2_tick_does_not_change_timeouts`, `t3bk2_tick_races_run_end`, `t3bk2_tick_crash_recovery`, `t3bk2_tick_lag_bounded`, `t3bk2_hard_drop_keeps_ticked_log`, `t3bk2_tick_io_cache_dropped_on_fallback` |
| C | Windows: the writer and `kodel wait` read `state.json` concurrently while ticks rename it | `t3bk2_windows_concurrent_state_reader` (skipped elsewhere) |
| real | A Claude Code run: the run id is found in the log; the window starts at the first `pipeline_*` call; at least 2 `agent_log_saved` events during a long step; the last pass came before `run_finished`; the canary appears redacted and no raw line is copied; the canary names the missing profile (also a unit test with a fake version) | `tests/agents/claude-code-agent-log.test.ts`, `t3bk2_canary_names_missing_profile` |

Refutations (what shows a decision wrong): the Step 0 probe fails → Decisions 4 and 8, stop. The run id missing from a live session's log in the
real test → Decision 3. Size: the builder reports the median and p90 of event bytes of the real runs taken during the work and of this
repository's runs; a median over 500 KB or a p90 over 5 MB reopens the caps, and the person judges at the gate. The ticker (Decision 8): the
real run reports `agent_log_saved` per hour and the time of one `apply` under ticks; more than 4000 events in a normal run, or a
`pipeline_next_step` latency under ticks above twice its latency without them, reopens the interval. A full read of the largest real
session (12.9 MB) must finish within the 30 s budget on the builder's machine, or the budget is raised. "At most one interval behind" is
measured against the real log in the real test and the docs say "behind what the agent has flushed". The documented hex-only and own-server
gaps are pinned by tests. `/clear` is interactive and the headless harness cannot drive it: the unit tests pin the candidate rules with
fake logs and the person tries `/clear` once by hand at the gate. Decisions 1, 2, 5, 6, 7 are choices, not testable. Windows: CRLF,
symlink, stale-takeover and fsync tests carry guards or skips (listed in the test files).

---

## Steps

0. **Probe**: confirm a fresh server process sees `CLAUDE_CODE_SESSION_ID` (the `executor.session` source in a run's journal or a temporary
   log line); record the Claude Code version; stop and ask if it fails.
1. **A: collector options** (`agent-history.ts`, `history/claude-code`): caps per kind, line breaks, cut marker, project redact rules,
   metadata (no text, `cwd`/`git_branch` dropped), `extraWorkdirs`, hold back the open response, the run-id finder over the full call text,
   pseudonym-aware ids, and resumable reading (`ReadOptions.resume` with the live state and an offset after the last whole line). Goldens
   regenerated from the old code and committed first; new sanitized fixtures (`__CWD__`) with a leak scan.
2. **B: config and events**: `agent_log` in `HistoryConfig` (optional) with `DEFAULT_AGENT_LOG` plain data, zod schema, `mergeHistory`, journaled
   in `run_started.history`; `agent_log_saved` and `agent_log_failed` in `run.ts` with the acceptance rules and caps; testkit
   `scenarioHistory()` and the existing tests pinned, in the same commit as the first code that reads the environment.
3. **B: store and lock**: `writeAgentLog`; the `agent_log` lock (per-lock staleness, token check, per-call wait) and the `HostOptions` plumbing
   of the lock and sleep seams.
4. **B: writer** `packages/local/src/agent-log.ts` (`capture`, candidates, window, budget, live-state table) and the call in
   `LocalRun.completeStep`; wiring in `pipeline-host.ts` and the host the CLI builds for `report`/`status`.
5. **B: report** (`report.ts`, `format.ts`): the line, `RunReport.agent_log`, reasons, "ended without a final pass".
6. **B: docs**: `docs/history.md` (including the Decision 3 deviation, the "When" rule, `interval_s`, the freeze checklist) and the comment
   of `HISTORY_CATEGORIES`.
7. **C: ticker** in `LocalPipelineHost` (registry, start in the serve path, stop, back-off) and `interval_s`.
8. Tests as in the table; `typecheck`, `lint`, `test`, `build` with `check-artifact`.

## Affected files

- `packages/pipeline-core/src/{history-config,agent-history,run,report,index}.ts`
- `packages/local/src/{config,store,host,executor,pipeline-host}.ts`, new `agent-log.ts`, `history/claude-code/*`
- `packages/cli/src/{cli,format}.ts`
- `packages/testkit/src/{fake-agent-history,history-fixtures,local-engine}.ts`
- `fixtures/history/claude-code/*`, new `fixtures/agent-log/` (not in the hashed `v1/`)
- `packages/local/test/{agent-log*,history-config,host,worktree,gate-comments,output}.test.ts`, core tests,
  `tests/agents/claude-code-agent-log.test.ts`, one Windows test
- `docs/history.md`

## Rejected review findings

Rounds 1 and 2 (answered in the plan; only what was not taken):

- *Seal the file with a chunk hash* (invariants): 52A8 decided display data, unverified; not reopened. (`tail_hash` here is a cursor check, not a seal.)
- *Nested-key "newer kodel" hint in config* (gaps): a separate small change in `config.ts`; offered as a follow-up.
- *Drop `unverified` and `mode unknown`* (scope): in the 52A8 decision text.
- *`/clear` in the real-agent harness* (gaps): the harness is headless; replaced by fake-log unit tests and one manual try.

Round 3:

- *Make the split the default* (scope): not made the default; you answered (a). Commits are ordered A, B, C so a split stays cheap.
- *Cut the lock, use an in-memory guard* (scope): two MCP servers can serve one run, so a file lock stays; simplified and fenced instead.
- *Option (b) of Decision 3, a response-start timestamp* (scope): not needed once the run-id proof removes the tolerances.
- *Trim the test set* (scope): trimmed earlier; the rest guard real risks. The table is long because the ticker and the proof are new.
- *Add a pass at `pipeline_next_step`* (gaps): a write at `next_step` is not needed now that the ticker copies in the background; `complete: false` tells the two end cases apart. (Round 4 correctly noted `nextStep` already writes `step_served`, so the reason is "not needed", not "read-only".)
- *The "release waits" language is stricter than AGENTS.md rule 4* (scope): it is the 52A8 wording; kept, flagged in Decision 6.

Round 4 (the ticker round), not taken:

- *Split the ticker into its own task now* (scope): you answered (a); commit order makes it cheap later; said in Decision 2.
- *Drop the checkpoint, re-read in full per step* (scope): the ticker needs it; it is now cheap and exact (live state, no clone), and sits in commit A only because the collector owns it.
- *Cut scope-creep items* (scope, minor): `time_bound` is removed as a failure (a slow read now stores partial progress); pseudonymised ids, hex `last_key` and the reserved-name tests stay (each guards a stated risk, and they are small); the position budget stays because it is the 52A8 wording, with a simple rule for added nodes.
- *Journal one event per N ticks* (scope): rejected: the reader trusts only the journal, so a coarser journal makes the stored log look older; the cost is stated and capped instead.
- *A lint check that fails on the `t3bk2_` prefix* (tests): circular; the rename is a PR checklist item.
- *Soften "at most one interval behind"* (tests): taken: the docs say "behind what the agent has flushed".
- *A `kodel history`/analysis consumer* (scope): outside this task; said in the PR.
- *Move `last_key` to a keyed hash only* (invariants, info): taken as keyed by the run and over pseudonymised ids.

## Findings in the code

- `host.ts:1082-1151` `applyLocked`: the run ends inside the lock that accepts the last event, with `writeSeal`; `host.ts:1627` `recordServed`
  is the model for an event with no lock held; `host.ts:1739-1776` `completeStep` (a "change pending" no-op comes first); only the MCP path
  calls it (`service.ts:556`); `host.ts:1571` `nextStep` applies a `tick` and `recordServed` journals `step_served`.
- `host.ts:1323-1334` and `run.ts:960-973`: the `heartbeat` timer (`setInterval`, `unref`, `staleMs/3`) only updates `visit.heartbeatAt`
  and rewrites `state.json`, only while the engine runs commands; nothing journals a heartbeat. It is the model for the timer, not for the load.
- `pipeline-host.ts:418-432,537-541,553,686`: hosts are keyed by `hashSpec:pipelineFile`, so one run can live in two `LocalHost`
  objects in one process (`start` then `open`); `pipeline-host.ts:617-621` `stop()` knows only commands; `cli.ts:185-188` builds its own
  host; `cli/src/elicit.ts:264` and `agent-decisions.ts:33` also call `nextStep`.
- `store.ts:141-142,711-741,775-804`: `lockTimeoutMs` 10 s and `staleLockMs` 60 s per `FileStore`, a live holder is taken over after
  `staleLockMs`, `lockedRun` checks the token only at release, `Date.now()` and `sleep(20)` are direct; `store.ts:297` (`host.ts`) builds
  `FileStore` with only root and rules; `store.ts:509-546` the seal covers state and journal only; `store.ts:552,563-580` the journal is
  redacted on append and a torn last line is tolerated; `store.ts:666` `writeServed`; `store.ts:162-176` state is replaced by rename.
- `executor.ts:36-38,150-177`: `SESSION_ENV`, `SAFE_SESSION`, hook `transcript_path`, `claudeConfigDir(env)`; `hooks/session-registrar.ts`:
  one index line per `SessionStart`; `host.ts:1637-1648,1782-1795`: the executor record exists only with `history.executor` on;
  `host.ts:280-298` redact rules come from the live config.
- `agent-history.ts:116-121,149`: every event needs `seq`, `ts`, `session_id`; `redactEvent` rewrites every string, ids included;
  `PREVIEW_CAP`, required `text_preview`. `collector.ts:70-103,152-158`: the cwd check at read time, `seq` assigned before `inWindow`,
  counters; `normalize.ts:18,115-128,170-264`: `SEEN_CAP` 1,000,000, `seen` keys `u: c: r: m: s:`, a response closes when the next entry
  arrives, the open response's message and tool_call are returned directly; `locate.ts:18,27,55-99`; `scope.ts:54-74`: `projectWorkdirs` spawns
  `git worktree list` and misses a removed worktree.
- `report.ts:138,345-349`: `summarizeRun` takes the last journal `ts` as `last` and attributes the time to a running attempt.
- `run.ts:811-815`: `MAX_LOGGED_REFUSALS`, the model for caps enforced in core; `run.ts:1110-1136` `acceptPipeline` can add nodes.
- `redact.ts:72-78`: the entropy rule rewrites 32+ character words that mix case and digits (why `last_key` and `tail_hash` are hex and ids are
  pseudonymised).
- `packages/pipeline-core/src/nodes.ts` and `backend.ts` are empty modules: no node capability and no store interface in core.
- `formats.test.ts:60-93` and `fixtures/formats/README.md`: `hashes.json` covers the whole `v1/` tree; adding files there fails CI.
- `.kodel/pipelines/dev.yaml`: 13 nodes, 5 agent, 3 human, 5 command (the budget test shape).
- `tests/agents/claude-code-served.test.ts:104-110`, `harness.ts:299-316`: the only real-agent session assertion accepts env or hook; the
  harness is headless. Testkit `local-engine.ts:34-39` `scenarioHistory()`; several local tests and `tests/e2e` build or spawn hosts without
  `environment`.
- Step 0 evidence: all seven running `kodel mcp` processes have `CLAUDE_CODE_SESSION_ID` in their environment; `docs/history.md:155` says
  it is exact "since the agent starts a server per session", which is wrong for `/clear`.
- No `export` command in `packages/cli/src`; `tool_log` has no consumer yet.
