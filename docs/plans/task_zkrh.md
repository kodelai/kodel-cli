# Tool calls of the agent per node (TASK-ZKRH)

## TL;DR

- A pass at the end of each agent step (the pattern of the merged usage count, TASK-9JRS, in the fork-aware form of TASK-HRPZ) reads the agent's own log and journals **every tool call and every tool
  result it releases as its own row**; `kodel report` joins them by id and shows them per attempt (name, start, duration, ok or error, input and result bytes, MCP server, subagent; kodel's own `pipeline_*`
  calls flagged). Claude Code only. Own switch `history.tool_calls`, independent of `agent_log`.
- **The pass does no pairing**, so it needs no memory of open calls: the collector releases a call and its result at different moments, and a result recorded in a later pass joins its call at report time.
  A call belongs to the attempt of the **next hand-in after it started** (usage's rule, placed by time); calls made while several agent steps were open are marked `shared`.
- Cost: about five commits; one additive option in `usage.ts` (the run-start memo is shared). Risky: journal size and read cost, one more read before a step is judged, and what no pass ever sees (the
  final response of a stream that gets no later response).
- What this revision changed (fifth critique, no blocker): result rows instead of pairing in the pass (the collector's release order made pairing wrong); attribution by the next hand-in (the contiguous and
  window rules contradicted each other and needed claim records); counts-only records past the row budget (loop detection survives); the loss at the end of a stream stated in full; the memo sharing admitted.

## Decisions needed

Decided by the person in this chat: previews only with `agent_log` in `full` mode, knowing the journal is sealed and may be committed; one run, five commits; a separate pass; wait for HRPZ (merged);
flag own calls by tool name; display in `report` and `--json`; R7AF after ZKRH and narrowed.

Open, with what I do if you do not answer:

1. **What no pass ever sees (variant A stays dropped).** The collector releases a response only at the next response of the same log, so these are never recorded: the final response of the last agent step,
   of a session that ended between steps (a new chat after a gate, `/clear`, a restart), of each subagent log, and of a step whose last pass was skipped as `busy`. A step's hand-in call is recorded at the next
   pass, in the same session. (a) **Recommended:** accept it, say it in the docs and the report; the R7AF hook can add what is missing. (b) A follow-up task that reads the open response on a clone, as
   usage's provisional count does. If not answered: (a).
2. **The rule that places a call.** (a) **Recommended:** the call goes to the attempt of the first `agent_completed` at or after its `started` (the step being handed in by this pass counts as completing now); a
   call in a gate wait or pause while no agent step is open is `unattributed`; it is marked `shared` when more than one agent step was open at `started`. This is usage's rule by time; it is exact in sequential
   runs and in sequential-mode forks, and approximate with parallel workers (flagged `shared`). Attempts that were never handed in take no calls: theirs go to the next hand-in. (b) Windows from `node_entered`
   (the earlier plan; every branch is entered at fork start, so nearly every call is `shared`). (c) Calls in a fork `unattributed`. If not answered: (a).
3. **Lines over 8 MB.** The line reader drops them and counts `invalid_lines` with no id, so the task's "a 10 MB input or result is capped" cannot be kept for such a line: its call or result is not recorded, and the
   record says `skipped N lines`. (a) **Recommended:** accept and say it in the Done-when comparison. (b) A size-only path in the shared line reader (a change of shared code). If not answered: (a).
4. **The memo of run starts.** `RunStartMemo` is private to `UsageWriter`. (a) **Recommended:** an additive option on the usage writer lets the host hand both writers one map (the diff of `usage.ts` is that option
   only, its tests stay unchanged). (b) The new writer keeps its own memo: every candidate log that grew is scanned twice per step end. If not answered: (a).
5. **Decision id.** Tests keep the provisional `zkrh_`; the task says the mechanism was decided with the owner and AGENTS.md wants an id from the decision log. Say if you want an entry. If not answered: none.

## Behaviour change

- `kodel report <run>` has a block per agent attempt: `tools: 14 calls (Bash 6, Edit 4, Read 3, mcp:kodel 1), 2 failed, 1 open; longest: Bash 41 s, ...`, own calls marked (the server is shown: another MCP server
  with the same tool names is marked too), `shared` where several agent steps were open, or a reason (`disabled`, `not_captured`, `session_unknown`, `log_missing`, `unreadable`, `agent_unsupported`, `no_calls`),
  `unverified`, and `rows_cut` / `skipped` when a budget or the 8 MB limit hid something. `report --json` has every row. A step's block is complete only after the next pass; the report says what is never
  recorded (decision 1). An own call's `ok` does not say the step passed (the engine answers a failed check as a normal result).
- New optional key `history.tool_calls: { enabled: true, preview_chars: 200 }`. An older kodel refuses a project config that has it (`history` is `.strict()`): the PR says so. Previews are stored only when
  `agent_log` is on in `full` mode and sit in the journal, so a project that tracks `.kodel/runs` and ignores only `agent_log/` commits them; the docs say so (or set `preview_chars: 0`).
- One more read of new log bytes at each agent step end, before the step is judged; it never fails a step. Nothing changes for the agent, a check, a route or a gate.

## Risks and invariants

- **P1:** the log is the agent's own and editable; rows are information only. `zkrh_tool_calls_never_feed_check_route_or_gate` (import boundary; a throwing or timing-out pass leaves routing, gates and the usage
  record of the same step identical). **The machine checks the envelope and the row keys** (cheap, weak, said so): the envelope is the step handed in (an active agent visit, else `Repeat`); a row whose `node`
  is not in the run, or whose `attempt` is below 1 or above the node's highest attempt, is stored as unattributed. A node removed and added again resets its attempts (a pipeline change), as in usage's key.
  Forged timestamps can place a row in a real attempt; the block says `unverified`. The machine cannot tell an agent node from another kind (principle 7).
- **P3:** rows live in the journal, redacted by the store; the **state holds no text, no names and no per-attempt data**: per session the cursor `{last_seq, last_key}`, counts of records and approximate row
  bytes, failed reasons. Row ids are hashed in `local` (core has no crypto) from the session and the raw id, as `id-` and 12 hex; the machine checks only the format. The same raw id always hashes the same,
  so a project rule that rewrites hex changes call and result rows alike and the join still works (two ids collapsed by such a rule would merge: documented). The collector redacts a preview **before** it cuts
  it; the store redacts again. The pass puts only the project's rules in `capture.rules`. `plain` strips escapes in the CLI for previews, tool names and server names.
- **P4:** the record, caps, key check, attribution rule, join and aggregation are pure in `pipeline-core`; log reading and hashing are in `@kodel-ai/local`. The own-tool list is a plain exported list in the main
  entry (not the `mcp` subpath, which pulls in the MCP SDK), checked against the registry by a test in the `mcp` tests. The PR names that Kodel Server's `RunState` must persist `toolCalls`.
- **P6:** no new MCP tool; nothing a person decides becomes open to the agent.
- **P8 / stored data (format 2):** records exist only in run-state format 2 (format-1 runs are refused; no reader). New journal events `tool_calls_recorded` and `tool_calls_failed`, state key `toolCalls`,
  `run_started.history.tool_calls`, optional event fields; additive only (the fixtures README: an optional additive field needs no new directory). The payload `calls.v` is the format of the record (as
  `delta.v` for usage): the report reads every record through an `unknownFormat` check, an unknown failed reason reads "cannot read (format X)", never dropped, never "modified". A field added later bumps
  `calls.v`. A format-2 run without the key reads `not_captured`. An older engine that continues a run keeps the `toolCalls` state untouched and the cursor lags; a later pass catches up from the run's
  start. The golden run goes to `fixtures/tool-calls-run/` beside `fixtures/usage-run/`, **not** into `fixtures/formats/v2/` (its format test fails on any added file).
- **Rows.** Two kinds, in one record per pass and session: a call row `{id, tool, server?, own?, started, in_bytes?, preview?, subagent?, node?, attempt?, shared?}` and a result row `{id, ended, ms?, ok, err?, out_bytes?}`
  (result rows carry no attempt: the report takes it from the joined call). The record also carries exact `counts` of the calls of the pass per `(node, attempt, tool)`, and `skipped`. The report joins a result to
  its call by id within a session; a call with no result is `open` (the run is still going, or the result never came); a result with no call (its row was cut, or the line was over 8 MB) is counted `unjoined`.
- **Attribution.** Decision 2. The pure function takes the journal's records and returns for a `started` the attempt, `unattributed`, and whether it is `shared`; the waits (gate and pause windows, per node
  and per branch) come from `outsideSpans` in `local` and are passed in, so core imports nothing from `local`. While a pipeline change waits for a person the agent may keep working in phase agent: those calls
  are charged to the attempt (documented). A pass skipped as `busy` loses nothing by time: the next pass reads everything since the cursor and places each call by its `started`.
- **Release and pairing in the collector.** With `holdBack` a `tool_use` line's call is released at the next line; its result is held behind the pending usage until the next response starts; a `<synthetic>` or
  no-usage entry releases at once; `HELD_CAP` flushes early. So a call and its result can come out in different passes, which is why rows are separate. The checkpoint lives in the writer's memory (`StreamMemo`),
  not in the state; after a restart the read from the run's start numbers `seq` the same way and skips what the cursor covers. `duration_ms` is computed by the collector from its own calls map, which a read from
  the start refills. Pairing per session; first call wins for a repeated id. In `execution.mode: parallel` the main stream reads as open `Task` calls (the workers are in their own logs): documented.
- **Budgets.** 200 rows per record; **about 768 KB of journaled rows per run** (counted by `JSON.stringify` length before redaction, so approximate); past it records carry **counts only** (no rows, 32
  distinct tool names per record, the rest in `other`), so loops stay visible and the report says `rows_cut` (durations and failures are then unknown); 1 000 records per run, then one `tool_calls_failed: cap`
  says so and the pass stops writing. Worst case for a hostile log about 2.5 MB; typical runs far less. The journal is read whole by every pass, `status`, `report`, `completeStep` and every poll of `kodel wait`
  (current journals are about 150 KB): said in the docs. Previews are cut by the collector, and a value over 256 KB of JSON skips `preview()` and keeps only its size, so a 1-8 MB entry does not cost the budget.
- **Time and lock.** Worst case before a step is judged today: 5 s lock + 30 s copy + 2 s wait + 10 s usage = 47 s, before the hand-in (20 s) and checks. The new pass is chained after usage in the `also` of
  `completeStep` under the same lock with its own budget of 5 s: 52 s, stated in the docs and the PR. In a fork the second `completeStep` waits for the lock only `agentLogStepWaitMs` (5 s); a longer pass
  makes it `busy` and no pass runs for it (as usage's); with three or more workers the waiters race. The pass does not wait for the step's call in the log.
- **Own tools.** A call is kodel's own when its tool name (after `mcp__<server>__`) is in the plain list of the engine's `pipeline_*` tools (the registry's, including `pipeline_take_step`, and the decision tools
  `pipeline_decide_gate` and `pipeline_accept_change`); `task_*` tools are not flagged. The failure of an own call needs no parsing: the engine answers a refusal with `isError`, so `is_error` is already set.
- **Errors.** `error_type` is optional on the shared `tool_result` event (a plain string there), never written to the agent-log copy, and a closed enum (`error | denied | interrupted | hook_blocked`) in the
  record; anything unmatched falls to `error`. Matching sits inside the Claude Code profile on real shapes: the `<tool_use_error>` wrapper with a permission denial, the `PreToolUse:<Tool> hook error`
  prefix, `[Request interrupted by user for tool use]`, an MCP validation error, plain `Exit code 1`; an `is_error: false` result that mentions them stays ok.
- **Subagents.** Read as usage reads them (their own log files, joined by the stream's session and parent); `subagent` is the log id (it matches `SAFE_SESSION`); counted whatever `tool_log` says; counts split
  main/subagent; a call present in both the main log (sidechain) and the subagent's file is recorded once; a subagent that began before the run takes no slot; a subagent log with no timestamps is said.
- **Differences from usage, stated in the docs.** Usage credits all a pass reads to the step handed in; tool calls go to the next hand-in after their `started`, so after a retry or in a fork an attempt's tokens
  and calls can differ. Engine-run steps (TASK-WKJ4, not built) have no calls in the host's log: a reason `engine_step` comes with WKJ4.
- **Durations** are wall time from the log; parallel calls share `started` and also `ended`, so each reads as long as the slowest; a missing or negative duration is dropped. `result_bytes` counts text blocks only.
- **Clock.** The same machine is assumed, as in 9JRS (documented).

## Acceptance criteria and tests

No decision ids exist (decision 5); names use `zkrh_`. "Refuted if" says what shows a group wrong.

- Independence and previews: `zkrh_works_with_agent_log_off`, `zkrh_works_with_usage_off`, `zkrh_run_start_memo_shared_no_double_scan`, `zkrh_previews_only_when_agent_log_full`,
  `zkrh_agent_log_off_or_metadata_stores_no_preview_but_sizes`, `zkrh_preview_is_redacted_in_journal`, `zkrh_secret_straddling_the_preview_cut_is_redacted` (a token that starts before `preview_chars` and ends
  after it, also in a Bash command and a Windows path), `zkrh_preview_chars_zero_stores_no_preview`, `zkrh_value_over_256kb_skips_preview_keeps_size`. Refuted if a preview, or any prefix of a secret, is in
  the journal of a run with `agent_log` off or in any journal.
- Rows and join: `zkrh_call_and_result_rows_join_by_id`, `zkrh_result_in_a_later_pass_joins`, `zkrh_call_without_result_is_open_in_the_report`, `zkrh_result_without_call_is_counted_unjoined`,
  `zkrh_log_ending_after_a_result_line_still_joins_next_pass`, `zkrh_synthetic_entry_releases_at_once`, `zkrh_held_cap_flush`, `zkrh_result_before_call`, `zkrh_same_id_twice_first_wins`,
  `zkrh_id_reused_across_sessions_stays_apart`, `zkrh_loop_100_identical_calls_100_rows`, `zkrh_parallel_calls_one_message` (shared `ended` said), `zkrh_parallel_mode_task_calls_read_open`,
  `zkrh_forked_session_copies_rows_documented`, `zkrh_result_bytes_text_blocks_only`, `zkrh_input_bytes_utf8`, `zkrh_hash_collision_by_a_hex_rule_documented`. Refuted if a call and its result recorded in different
  passes do not join, or a row is recorded twice.
- Never recorded (decision 1): `zkrh_hand_in_call_recorded_at_next_pass_with_result`, `zkrh_hand_in_call_recorded_after_server_restart`, `zkrh_last_step_final_response_absent_and_said`,
  `zkrh_session_ended_between_steps_final_response_absent_and_said`, `zkrh_subagent_final_response_absent`, `zkrh_end_of_run_loses_what_follows_the_last_pass`, `zkrh_report_marks_the_latest_step_incomplete_until_next_pass`.
- Attribution (decision 2): `zkrh_call_goes_to_the_next_hand_in_after_started`, `zkrh_the_step_handed_in_now_takes_the_calls_since_the_last_hand_in`, `zkrh_next_step_fetch_call_is_in_its_step`,
  `zkrh_superseded_attempt_calls_go_to_the_next_hand_in`, `zkrh_retry_attempt_own_rows`, parametrised `zkrh_unattributed_cases` (gate wait, pause, before the first call, future `started`),
  `zkrh_span_edges` (equal timestamp, 1 ms either side), `zkrh_first_attempt_starts_at_runs_first_call`, `zkrh_shared_when_two_agent_steps_were_open`, `zkrh_fork_equal_entry_time_is_deterministic`,
  `zkrh_mixed_run_sequential_fork_sequential`, `zkrh_fork_in_gate_wait_while_other_branch_open_is_not_unattributed`, `zkrh_skipped_busy_pass_loses_nothing_next_pass_places_by_started`,
  `zkrh_refused_hand_in_then_retry_adds_rows_once`, `zkrh_pipeline_change_wait_charged_to_the_attempt`, `zkrh_rows_plus_unattributed_equal_all_calls` (property over random pass splits; `sum(counts)` equals the
  calls read). Refuted if rows plus unattributed differ from all calls, or a call is credited to a step that was neither open at `started` nor the next hand-in. `zkrh_attribution_agrees_with_outside_spans_on_the_usage_fixtures`
  lives in `local` (it needs `outsideSpans`); `zkrh_fork_placement_on_a_hand_written_fork_fixture` has the expected placement written by hand.
- Machine and state: `zkrh_tool_calls_never_feed_check_route_or_gate`, `zkrh_record_accepted_only_for_active_agent_visit` (two visits open), `zkrh_record_refused_when_run_ended`,
  `zkrh_refused_record_does_not_advance_cursor_retry_records_each_call_once`, `zkrh_refused_record_said_once`, `zkrh_row_with_unknown_node_or_attempt_zero_or_above_highest_folded_to_unattributed`,
  `zkrh_removed_and_readded_node_collision_documented`, `zkrh_cursor_skips_credited_after_restart`, `zkrh_stale_cursor_after_older_engine_is_caught_up`, `zkrh_state_and_journal_agree`,
  `zkrh_state_holds_no_text_names_or_attempts`, `zkrh_id_format_checked`. Refuted if the routing differs with the pass on, off or throwing.
- Flag, ids and errors: `zkrh_flags_own_calls_by_name_list_and_shows_server`, `zkrh_task_tools_not_flagged`, `zkrh_other_server_same_name_is_flagged_and_shown`,
  `zkrh_own_tool_names_match_the_registry_including_take_step_and_decision_tools` (in the `mcp` tests), `zkrh_refused_own_call_is_not_ok_from_is_error`, `zkrh_ids_hash_from_session_and_raw_id_and_are_stable`,
  table-driven `zkrh_error_type_real_shapes` (an unmatched shape falls to `error`, never to `denied` or `hook_blocked`), `zkrh_text_mentioning_denied_or_interrupted_in_ok_result_stays_ok`,
  `zkrh_interrupted_result_is_error_type_interrupted` (through the pass and report), `zkrh_mcp_name_parsing` (`mcp__my_server__do_it`, `mcp__x`, `mcp____t`, `mcp__a__b__c`: first `__`),
  `zkrh_duration_from_timestamps`, `zkrh_negative_or_missing_duration_dropped`.
- Subagents: `zkrh_subagent_rows_marked_with_log_id`, `zkrh_subagent_joined_by_stream_not_agent_id`, `zkrh_counts_split_main_and_subagent`, `zkrh_subagents_counted_when_tool_log_false`,
  `zkrh_dedupe_across_sidechain_and_subagent_files`, `zkrh_many_subagent_logs_do_not_make_the_pass_forget_the_main_log`, `zkrh_subagent_that_began_before_the_run_takes_no_slot`,
  `zkrh_subagent_log_without_time_is_said`.
- Switch, reasons, config: `zkrh_switch_off_builds_no_collector_and_reads_nothing`, `zkrh_config_edit_mid_run_keeps_frozen_value`, `zkrh_not_captured_without_key`, parametrised `zkrh_reason_table` (disabled,
  session_unknown, log_missing, unreadable, agent_unsupported, no_calls), `zkrh_renamed_tool_fields_are_unreadable_not_no_calls`, `zkrh_config_parses_and_defaults`, `zkrh_preview_chars_validation`
  (negative, non-integer, above a cap), `zkrh_forget_at_run_end`; the key lists in `config.test.ts` and `agent-log-docs.test.ts` are updated. Refuted if a frozen switch changes mid-run.
- Pass mechanics (the 9JRS analogues): `zkrh_step_end_takes_the_lock_once_for_all_passes`, `zkrh_failing_copy_or_usage_does_not_stop_the_pass`, `zkrh_lost_lock_with_the_copy_off_is_said_as_busy`,
  `zkrh_ticker_does_not_run_the_pass`, `zkrh_does_not_wait_for_the_step_call`, `zkrh_budget_stop_then_next_pass_catches_up_each_call_once`, `zkrh_truncated_or_rotated_log`,
  `zkrh_worktree_removed_before_collection`, `zkrh_two_sessions_in_one_run`, `zkrh_one_session_over_two_runs`, `zkrh_unreadable_log_not_reread_until_it_grows`, `zkrh_failure_said_once` (busy, cap, bytes),
  `zkrh_session_id_over_length_cap`, `zkrh_agent_running_at_run_end`, `zkrh_bounded_time_with_slow_reader`, `zkrh_synthetic_model_log_with_calls_and_no_usage_is_read`,
  `zkrh_tool_calls_timeout_leaves_usage_record_intact`, `zkrh_fork_second_pass_busy_is_caught_up_later`, `zkrh_fork_three_workers_race_for_the_lock`.
- Hardening: `zkrh_invalid_lines_truncated_tail_unknown_fields`, `zkrh_entries_without_timestamp`, `zkrh_line_over_8mb_skipped_and_counted` (a `skipped` count, no per-call reason), `zkrh_many_calls_capped_counts_exact`
  (a failure at call 250 counted while rows last; 200 and 201 rows), `zkrh_counts_only_records_past_the_row_budget_keep_loops_visible`, `zkrh_more_than_32_distinct_tools_fold_into_other`,
  `zkrh_journal_budget_approximate_and_bounded`, `zkrh_preview_cut_mark_and_surrogates`, `zkrh_escapes_plain` (ESC, OSC 8, `\r`, bidi, C1 in previews, tool names, server names and `error_type`, in text and JSON;
  long names capped), `zkrh_windows_paths_in_input`, `zkrh_big_log_is_streamed`, `zkrh_report_and_status_with_journal_at_cap` (bounded time).
- Format and docs: `zkrh_default_options_leave_new_fields_out_even_when_the_log_has_them`, `zkrh_tool_detail_is_carried`, `zkrh_golden_events_and_hashes_untouched`, `zkrh_error_type_never_in_agent_log_copy`,
  `zkrh_unknown_payload_v_is_cannot_read_not_modified` (journal and state key), `zkrh_unknown_failed_reason_reads_cannot_read`, `zkrh_unknown_event_types_ignored_by_the_current_summarize`,
  `zkrh_golden_run_status_and_report` (format 2, `fixtures/tool-calls-run/`), `zkrh_storage_home_run`, `zkrh_docs_history_section_tool_calls`.
- Report (one per behaviour): `zkrh_report_running_run_shows_only_ended_attempts`, `zkrh_report_marks_unverified`, `zkrh_report_marks_shared`, `zkrh_report_says_rows_cut_and_skipped`, `zkrh_report_says_what_is_never_recorded`,
  `zkrh_report_longest_3`, `zkrh_report_reasons`, `zkrh_report_json_rows`, `zkrh_status_unchanged`, `zkrh_report_writes_nothing`.
- Real agent: manual gate `tests/agents/claude-code-tool-calls.test.ts`: `zkrh_real_run_lists_edit_and_bash` (both listed, each duration below the step's wall time, `Bash` above 0, own calls flagged),
  `zkrh_real_run_every_non_last_agent_node_has_a_tool_block` (at least two agent steps; the last carries the documented "not recorded" text, so the task's Done-when is narrowed and said so),
  `zkrh_real_fork_run_marks_shared`; subagent calls are covered offline only. **Offline twin in commit 3, not last:** `zkrh_saved_real_session_matches_raw_tool_use_ids` (a scrubbed real log, named in the plan
  step 1 and including a subagent if one can be taken: recorded ids, compared through the same hash, equal the raw `tool_use` ids minus the never-recorded final responses; an 8 MB line only counts `skipped`).
  Refuted if a call present in the raw log is missing without one of the documented reasons.
- E2E: `zkrh_fork_run_through_the_real_pipeline_service_with_a_scripted_log` (beside `tests/e2e/fork-run.test.ts`).
- PR checks (not tests): the usage and fork tests are green after the merge of `main` and before commit 1; `usage.ts` differs only by the memo option and its tests are unchanged; the checklist of task-record
  edits (R7AF body and Done-when, comments on KP9C, WKJ4 and ZKRH).
- Not shown by a test, said in the docs: the cost of the extra reads on a real run (measured once, in the PR), clock skew across machines, forged timestamps (only the `unverified` text), the 52 s worst case, Codex and
  OpenCode pairing (not met by this run, said in the PR; it moves to the tasks that add their collectors), that an older engine refuses the new config key.

---

## Steps

0. **Merge `main` into the run's branch** (the worktree starts at `fb48b7d`, before usage, storage and HRPZ; the diff check of the plan step forbids doing it earlier), `bun install`, the usage and fork tests as a baseline (green).
   TASK-V75E (the served/ windows) is merged; its windows are not used: prompt recording can be off.
1. **Read first (no commit):** the journal records that bound a hand-in or an open step (`node_entered`, `agent_completed`, `node_finished`, `node_superseded`, `run_finished`), where the node's highest attempt is
   kept, `summarizeRun`'s tolerance of unknown events, how the usage writer can take a shared memo, the collector's release order across a resumed read, the real error shapes and a real session (with a subagent
   if one exists) for the fixture. Stop and report if the record shape or the attribution rule does not hold.
2. **Commit 1, event fields:** `input_bytes?` on `tool_call`, optional string `error_type?` on `tool_result`, both only under the collector option `toolDetail`; no preview above 256 KB of JSON; normalizer matching in the Claude
   Code profile; a scrubbed real fixture with every error shape; reword the doc comment of `HistoryConfig.tool_log` ("the hooks' switch").
3. **Commit 2, core:** `tool-calls-record.ts` (call and result rows, record with `calls.v`, cursor, state, budgets, schemas), `tool-calls.ts` (own-tool list, attribution, join, aggregation, key check), the handling in
   `run.ts`, `tool_calls` in `HistoryConfig`, `local/src/config.ts`, the report part and type (with the `unknownFormat` check).
4. **Commit 3, pass and offline twin:** `local/src/tool-calls.ts` (`ToolCallsWriter`, hashing of ids) chained after usage in the `also` of `completeStep` in `host.ts`; the memo option in `usage.ts`; `forget`; its own
   `busy` reason; independent of `state.usage`; the golden run in `fixtures/tool-calls-run/`; the offline twin; a timing note on a real run.
5. **Commit 4, report, CLI, docs, tasks:** `report` / `--json`; `docs/history.md` section "Tool calls" (switch, previews in the journal and tracked runs, the attribution rule and forks, what is never recorded, the
   pipeline-change wait, the 8 MB line, time before a step is judged and `busy` in a fork, journal growth, differences from usage, own-call `ok`, mixed versions and the config break, `tool_log` is the hooks' switch, the
   52A8 line is now true: an independent pass with its own switch); edit the body and Done-when of TASK-R7AF (narrowed: what no pass sees, and a live view, hooks needing `kodel init`) and comment on TASK-KP9C (map a
   worker's stream to its step), TASK-WKJ4 (reason `engine_step`) and TASK-ZKRH (Codex/OpenCode pairing moves to the tasks that add their collectors; `agent_id` is the subagent's log id; an unmatched call is `open`; the
   8 MB line is dropped, not capped; the narrowed Done-when; dependencies VH9G, 52A8, 3BK2, 9JRS, CXSE, V75E, HRPZ are merged).
6. **Commit 5, real-agent scenarios** (manual gate).

## Affected files

`packages/local/src/{tool-calls,usage,session-finder,host,config,index}.ts` (`usage.ts` only the memo option), `packages/local/src/history/claude-code/{collector,normalize}.ts`,
`packages/pipeline-core/src/{agent-history,history-config,run,report,tool-calls,tool-calls-record,index}.ts`, `packages/cli/src/format.ts`, `packages/testkit/src/{claude-log-builder,history-fixtures}.ts`, tests beside each,
`docs/history.md`, `fixtures/tool-calls-run/`, a scrubbed real log under `fixtures/history/`, `tests/agents/claude-code-tool-calls.test.ts`, `tests/e2e/`, task records of R7AF, KP9C, WKJ4 and ZKRH. Not touched:
`usage-record.ts`, the price table.

## Rejected review findings

The fifth critique and the earlier ones, by what became of them:

- **Taken:** pairing in the pass replaced by separate call and result rows joined in the report (the collector's release order); attribution by the next hand-in (contiguous and window rules contradicted each other; claim
  records are capped and `execution.mode` is not journaled); the memo sharing admitted as a small `usage.ts` change; counts-only records past the row budget; the loss at the end of a stream stated (decision 1); the
  `skipped` limit and the 8 MB line in the Done-when comparison; the 256 KB preview skip; the secret-straddling-the-cut test; the wording "the checkpoint lives in the writer's memory"; the tests the tests critics named
  (the next-pass completeness, mixed run, tie-break, e2e, docs, report at the cap, real run every node, refutation lines); hashing in `local`; the own-call `ok` caveat; the V75E dependency stated; the decision id raised.
- **Rejected:** dropping `shared` and fork handling (scope): the placement is ambiguous in a fork and the report must not present it as fact; the cost is one boolean from the same function. Splitting the task (the person
  chose one run; the re-read, the largest part, is gone). Cutting the machine's key check and the state caps (scope): the key check is a few lines on a sealed journal, and the state caps are gone because the state keeps
  no per-attempt data. A `node` field on own-call rows for KP9C (it needs a new field in the shared event; KP9C designs its own mapping). A size-only reader path for lines over 8 MB (decision 3: a change of shared code).
  Reading the open response on a clone (decision 1: a follow-up). Flagging only the server named in `.mcp.json` (the pass does not know it; the server is shown instead).
- **Not tested, documented:** see the last line of the tests.

## Findings in the code

- HRPZ is merged (`e322ece`): run-state format 2 (`RECORD_VERSION` 2; format-1 runs refused with `UNSUPPORTED_FORMAT`), `Visit.fork?: ForkRef` (`packages/pipeline-core/src/run.ts` ~96-101, 204-235), `pipeline_take_step`
  and `CONTRACT_VERSION = 3` in `TOOLS` (`packages/pipeline-core/src/mcp/tools.ts`; the decision tools are in `mcp/decision-tools.ts`, `task_*` in `mcp/task-tools.ts`; `register.ts:57` and `task-tools.ts:330` return refusals
  with `isError: !result.ok`), `steps[]` and `execution.mode` in `next-step.ts` (the mode is not journaled), per-worker claim tokens (`step_claimed`, capped by `MAX_LOGGED_CLAIMS`, renewals journaled). The journal has
  `node_entered`, `agent_completed`, `node_finished`, `node_superseded` (node and attempt only), `run_finished`; all fork branch heads get `node_entered` at `fork_started`.
- Usage is merged and fork-aware: `packages/local/src/usage.ts` (`UsageWriter`, `capture`, `skipReason`, `credit`, `awaitStepCall`, private `runs` map of `StreamMemo extends RunStartMemo`, its own `SessionFinder`;
  `outsideSpans(journal, now, openAgentSteps, openPauses)` treats a visit as an agent step only if the journal has its `agent_completed` or it is open, keeps gate and pause windows per node and branch and subtracts the time
  any agent step was open), `packages/local/src/session-finder.ts` (`SessionFinder`, `proveRunStart`, `RunStartMemo`), `packages/pipeline-core/src/{usage,usage-record,usage-report}.ts`. Usage credits all a pass reads to the
  step handed in; in a fork what a session used goes to whichever step is handed in first (`docs/plans/task_hrpz.md`, "Usage in a fork"; `docs/history.md` ~464-472).
- It runs as `CaptureInput.also` of the agent-log copy under one lock (`packages/local/src/agent-log.ts`, `packages/local/src/host.ts` ~2657-2690; the pass runs before `agent_completed` is applied, ~2662 vs ~2709; the lock wait is
  `agentLogStepWaitMs`, 5 s, a loser gets `busy`) and still runs with the copy off. The machine accepts `usage_recorded` with a node only for an active visit of that node and attempt in phase agent, else `Repeat`
  (`run.ts` ~2106-2139), which holds with several visits; core has no crypto.
- The collector with `holdBack`: `settled = [...reader.unreleased, ...drafts.slice(0, closed)]` releases an earlier line's `tool_use` calls at the next line; results wait in `claude.held` behind `pending` until the next
  response starts (`history/claude-code/collector.ts` ~46, 148, 232-262; `normalize.ts` ~37-39, 139-149, 168, 281, `settle`/`flushPending`, `HELD_CAP` 5 000); a `<synthetic>`/no-usage entry sets no `pending`. The checkpoint
  (`ReaderState` with `unreleased`, `calls`) is kept per writer in memory (`usage.ts` ~294, 826). The usage open-response clone reads without `holdBack` and yields only a usage event. `previewOf` redacts before it cuts
  (`agent-history.ts`); `BUILTIN_RULES` hold functions (not cloneable, `redact.ts` 49-64).
- `findRunStart` returns `{offset, ts}` only (`history/claude-code/window.ts`). The store redacts every appended record (`packages/local/src/store.ts`); `readJournal` reads the whole file and is called by passes,
  `completeStep`, `status`, `report` and `kodel wait`. `history/jsonl.ts` drops a line over 8 MB and counts it invalid (no id). `toolResultEvent` is a plain `z.object`. `history` in the project config is `.strict()`.
- `fixtures/formats/` is checked file by file by `packages/local/test/formats.test.ts`; the README says an optional additive field needs no new directory. `docs/history.md` ~336 tells a tracked project to ignore
  `.kodel/runs/*/agent_log` only, and already says `usage` and `tool_calls` read the log themselves (52A8).
- Related tasks read: TASK-V75E (done), TASK-WKJ4 (engine profiles; a step run by another engine has no calls in the host log), TASK-KP9C (batch of parallel agent nodes; workers are subagents with their own logs),
  TASK-R7AF (hooks).

## As built (where the plan and `main` disagree, and what was left)

Written at the end of the implementation. `main` moved on while the plan was being made (usage, forks, storage, and T-41: a run keeps its
format and every format has a codec), so:

- **Format.** The plan said the records exist only in run-state format 2 and format 1 is refused. After T-41 a run of format 1 is supported:
  the codec of format 1 keeps `toolCalls` and the two events like `usage` (`STATE_TABLE`, `OPAQUE_KEYS`, `V1_EVENTS`), format 2 stores the model
  as it is, and `docs/run-formats.md` says what a run in flight does (nothing to migrate; a run started before reads `not_captured`).
  The golden run is in `fixtures/tool-calls-run/` (format 2).
- **The report** is made in `summarizeRun` with the usage report, from the journal that is already read there, not by a lazy host method:
  `status` also builds it. `RunReport.tool_calls` is optional like `task_size`.
- **Cursor of a long pass.** A pass that reads more than 200 rows writes several records; each part carries the cursor of its last row, so a
  record the run refuses never moves the cursor past rows that were not recorded.
- **`skipped`** (lines the line reader dropped) is the count of the read, put on the first record of a pass; after a restart the read starts at
  the run's beginning and may count the same lines again.
- **`usage.ts`** changed only by the `runStarts` option (the shared `RunStartCache` of `session-finder.ts`); its tests are unchanged.
- **The offline twin** (`zkrh_saved_real_session_matches_raw_tool_use_ids`) runs at the collector: it compares every `tool_use` and
  `tool_result` id of the saved session and its subagent with what the reader gives, with no collector code on the reference side. The
  pass-level comparison with a raw log is the env-gated `zkrh_real_run_matches_raw_log`.
- **Changed after the review of the build** (findings of the first review, all fixed): the placement context now knows the agent steps that
  are open (`state.active`), so the pass of the first branch of a fork marks `shared`; a call that began after the pass did (by at most a minute)
  is left for the next pass instead of being recorded `unattributed` for good (the cursor stays before it, `behind` is set, the checkpoint is
  dropped); the counts and a row agree past 64 attempts; the row budget latches after a cut; the report reads the journal when the state lost
  `toolCalls`; the run start of one log is never taken for another's; `Object.hasOwn` and a refusal of `__proto__` for the session key; a call
  that the main log and a subagent's own file both hold is recorded once per pass; a record that is not the last of a pass carries `behind`; the
  dead `unreadableAt` branch is removed; the CLI block shows how many calls are the engine's own and which MCP servers were called; the docs no
  longer say an older kodel keeps the state key.
- **Changed after the second review of the build:** a stream refused for the cap of 64 sessions is skipped and said as `cap` (it used to end the whole pass
  as `record_refused`); a held pass does not count `skipped` lines (the next pass reads them again); the label of `skipped` says "could not be read (over
  the limit, or not JSON)"; the docs say what is true of an older kodel (format 2 reads and keeps the key, only format 1 and the config refuse), that every
  call in a fork whose steps are worked one by one is also `shared`, and that a call held by the main log and a subagent file is two rows when read in two passes.
- **The tests, counted** (a script compared the 147 `zkrh_` names of the acceptance section with the test files): 71 are there under the same name. These
  are there under another name: `zkrh_agent_log_off_or_metadata_stores_no_preview_but_sizes` and `zkrh_works_with_usage_off` (in
  `zkrh_works_with_agent_log_off_and_usage_off_and_stores_no_preview`), `zkrh_preview_chars_zero_stores_no_preview` (in `zkrh_previews_only_when_agent_log_full`),
  `zkrh_config_edit_mid_run_keeps_frozen_value`, `zkrh_cursor_skips_credited_after_restart` and `zkrh_hand_in_call_recorded_after_server_restart` (in
  `zkrh_cursor_skips_recorded_after_restart_and_the_hand_in_call_comes_with_the_next_pass`), `zkrh_failing_copy_or_usage_does_not_stop_the_pass` (the usage half only:
  `zkrh_failing_usage_does_not_stop_the_pass`), `zkrh_first_attempt_starts_at_runs_first_call`, `zkrh_interrupted_result_is_error_type_interrupted` and
  `zkrh_refused_own_call_is_not_ok_from_is_error` (in `zkrh_interrupted_and_refused_own_call_end_to_end`), `zkrh_error_type_never_in_agent_log_copy` (in
  `zkrh_preview_is_redacted_in_journal_and_error_type_never_in_the_agent_log_copy`), `zkrh_skipped_busy_pass_loses_nothing_next_pass_places_by_started`,
  `zkrh_subagent_rows_marked_with_log_id`, `zkrh_subagent_log_without_time_is_said` (in `zkrh_subagent_that_began_before_the_run_takes_no_slot_and_one_without_a_time_is_said`),
  `zkrh_id_reused_across_sessions_stays_apart` (in `zkrh_same_id_twice_first_wins_and_sessions_stay_apart`), `zkrh_id_format_checked` (in `zkrh_session_and_id_formats_are_checked`),
  `zkrh_task_tools_not_flagged` and `zkrh_other_server_same_name_is_flagged_and_shown` (in `zkrh_flags_own_calls_by_name_list_and_shows_server`, and the CLI test of the servers),
  `zkrh_the_step_handed_in_now_takes_the_calls_since_the_last_hand_in` and `zkrh_next_step_fetch_call_is_in_its_step` (in `zkrh_call_goes_to_the_next_hand_in_after_started` and the
  seeded `zkrh_rows_plus_unattributed_equal_all_calls`), the report's `zkrh_report_marks_unverified`, `zkrh_report_says_rows_cut_and_skipped` and `zkrh_report_longest_3`
  (in `zkrh_report_block_text` and `zkrh_report_marks_shared_cut_skipped_unjoined_and_incomplete`), `zkrh_end_of_run_loses_what_follows_the_last_pass` (in `zkrh_agent_running_at_run_end`),
  `zkrh_golden_events_and_hashes_untouched` (the existing format tests: `hashes.json` and the golden event files are not changed), `zkrh_duration_from_timestamps` (the `ms` asserted in the join test).
- **Not built, left for a follow-up** (the names of the plan with no test at all): at pass level a real fork (`zkrh_fork_placement_on_a_hand_written_fork_fixture`,
  `zkrh_fork_in_gate_wait_while_other_branch_open_is_not_unattributed`, `zkrh_mixed_run_sequential_fork_sequential`, `zkrh_fork_second_pass_busy_is_caught_up_later`,
  `zkrh_fork_three_workers_race_for_the_lock`, `zkrh_real_fork_run_marks_shared`; the placement of a fork is tested in the pure code only) and the e2e
  `zkrh_fork_run_through_the_real_pipeline_service_with_a_scripted_log`; the lock and the passes together (`zkrh_step_end_takes_the_lock_once_for_all_passes`,
  `zkrh_lost_lock_with_the_copy_off_is_said_as_busy`, `zkrh_ticker_does_not_run_the_pass`, `zkrh_does_not_wait_for_the_step_call`, `zkrh_tool_calls_timeout_leaves_usage_record_intact`,
  `zkrh_bounded_time_with_slow_reader`, `zkrh_report_and_status_with_journal_at_cap`); the sessions (`zkrh_two_sessions_in_one_run`, `zkrh_one_session_over_two_runs`,
  `zkrh_stale_cursor_after_older_engine_is_caught_up`, `zkrh_worktree_removed_before_collection`, `zkrh_unreadable_log_not_reread_until_it_grows` (the branch it tested was dead and is
  removed), `zkrh_renamed_tool_fields_are_unreadable_not_no_calls` (the pass says `no_calls` for such a log; usage's guess that a log is of a format it does not read is not built here));
  the reader (`zkrh_held_cap_flush`, `zkrh_synthetic_entry_releases_at_once`, `zkrh_synthetic_model_log_with_calls_and_no_usage_is_read`, `zkrh_input_bytes_utf8`,
  `zkrh_result_bytes_text_blocks_only`, `zkrh_negative_or_missing_duration_dropped`, `zkrh_invalid_lines_truncated_tail_unknown_fields` for a torn tail, `zkrh_big_log_is_streamed`); the report
  (`zkrh_report_running_run_shows_only_ended_attempts`, `zkrh_report_marks_the_latest_step_incomplete_until_next_pass`, `zkrh_report_writes_nothing`, `zkrh_status_unchanged`) and the machine
  (`zkrh_refused_record_said_once`, `zkrh_unknown_event_types_ignored_by_the_current_summarize`); the history (`zkrh_storage_home_run`), the retries (`zkrh_retry_attempt_own_rows`,
  `zkrh_refused_hand_in_then_retry_adds_rows_once`, `zkrh_pipeline_change_wait_charged_to_the_attempt`, `zkrh_attribution_agrees_with_outside_spans_on_the_usage_fixtures`),
  the ends of a run (`zkrh_last_step_final_response_absent_and_said`, `zkrh_session_ended_between_steps_final_response_absent_and_said`, `zkrh_subagent_final_response_absent`: said in the docs and the
  report, not asserted per case), `zkrh_counts_split_main_and_subagent`, `zkrh_subagents_counted_when_tool_log_false`, `zkrh_parallel_mode_task_calls_read_open`; the documented limits that have no test
  (`zkrh_forked_session_copies_rows_documented`, `zkrh_removed_and_readded_node_collision_documented`, `zkrh_hash_collision_by_a_hex_rule_documented`); and the two real-agent names
  `zkrh_real_run_every_non_last_agent_node_has_a_tool_block` and `zkrh_real_fork_run_marks_shared` (the file has `zkrh_real_run_lists_edit_and_bash`, `zkrh_real_run_matches_raw_log` and
  `zkrh_real_run_block_says_what_is_not_recorded`). A pass that runs out of time before it has read one event and has no stored cursor yet writes nothing, so nothing marks that log as behind. The
  env-gated real-agent scenarios were written and **not run** (`tests/agents/claude-code-tool-calls.test.ts`).
