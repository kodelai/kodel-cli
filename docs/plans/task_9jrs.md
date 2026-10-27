# Tokens and estimated cost per node attempt and per run (TASK-9JRS)

## TL;DR

- Records, for every agent-node attempt and for the run: tokens per model (`input`, `output`, `cache_read`, `cache_write` with its 1-hour part, `api_calls`), an **estimated** `cost_usd`
  with `cost_basis` and the price-table `revision`, and the flags `complete`, `partial`, `unattributed`, `last_open`, `long_context`. Shown in `kodel report`. Usage never feeds a check, a route or a gate.
- Own pass, own gate `history.usage` (works with `agent_log` off), one pass at each agent step end (no ticker). Also here (52A8): the price table, the per-model override, and, as the last commits, `scripts/check-prices.mjs` and `skills/kodel-prices/`.
- **What the critique changed:** (1) the 1-hour cache tier is carried through (cost was up to 37.5% low); (2) records are **append-only deltas** with a per-session **cursor** (`seq`), so a refused hand-in, a restart and a budget stop lose or double nothing;
  (3) attribution is by the pass that reads an event, with gate and pause spans going to `unattributed`; (4) both passes of a step end run under one lock; (5) the price-check script reads a JSON data file, not `dist/`.
- Cost: about 9 commits in three groups (A core and state, B pass and report, C tooling). Risks: a long list of edges in the pass (open response, budget stop, lock) each with a named test; Claude Code log drift (canary); cost compared to the agent's own only loosely.

## Decisions needed

Nothing blocks the start. Defaults are what I do without an answer.

1. **Split the price check?** (a) **Default:** keep `scripts/check-prices.mjs` and `skills/kodel-prices/` in this task as the last two commits, each reviewable alone, because the person asked for them with the table (52A8). (b) A follow-up task:
   two reviewers recommended it, and nothing in the cost feature needs them. Answer (b) and I stop after group B.
2. **Own pass, not the agent-log copy.** **Default:** own pass gated by `history.usage.enabled`, so turning `agent_log` off (privacy) keeps usage. It reads the log a second time; the cost of that read is measured once on a real run and written in the PR. The docs say: `agent_log: false` does not stop the transcript being read, only `usage: false` does.
3. **Attribution rule.** The task text says `[first step_served, agent_completed]`, which needs `history.prompts`, is capped at 500 and loses the response that calls `pipeline_next_step`. **Default:** an event read in the pass that completes an attempt is credited to that attempt (so the windows are contiguous, from the run's first call);
   events whose time falls in a gate wait or a pause (from the journal) are credited to `unattributed`; polling through command/check nodes is charged to the next agent attempt (documented); usage after the last pass is not recorded and the run total says it is a lower bound. Tokens are never double counted by construction (see cursor).
4. **The response that calls `pipeline_complete_step`** is still open at the step end. **Default:** the pass counts it as it stands (flushed only when the read reached the end of the file, never on a budget stop), marks the attempt `last_open`, and the next pass credits only the difference when that response is read whole (the cursor keeps its start offset and the amounts counted). Real runs show the size of the effect.
5. **Tolerance.** Tokens within 10% of `claude -p`'s own `usage`/`modelUsage`; cost compared apart, with a looser number set from the first real runs (it is documented, not guessed now). Default: 10% for tokens.
6. **Formats.** Additive only: optional `cache_write_1h` on the `usage` event (part of `cache_write`, like `reasoning` in `output`), and new records. `revision`/`source` live in the usage record, **not** on the event's `cost` (the stored `agent_log` events keep `unknown`: one answer per place). Per `fixtures/formats/README.md` an optional field needs no new directory, so the release does not wait. The default collector options keep the old shape.
7. **Decision id.** The 52A8 decisions have no id in the repository; tests use `t9jrs_`. **Default:** ask the person at the gate; the PR checklist greps that no `t9jrs_` remains at merge.
8. **Non-Claude agents.** A run driven by an agent with no collector reads `not_collected: agent_unsupported`, not `session_unknown`. Default: yes.

## Behaviour change

- `kodel report <run>` (and `--json`) shows per agent attempt and for the run: tokens per model, calls, estimated cost, the table `revision`s used, and flags: `complete`, `partial` (a model without a price: the cost is partial, never `$0`), `unattributed`, `last_open`, `long_context` (not modelled; cost may be low),
  `source: config` when the override priced it; or `not_collected` with a reason (`disabled`, `not_captured`, `session_unknown`, `log_missing`, `unreadable`, `agent_unsupported`). While a run goes only attempts whose step has ended show.
- One pass at the end of each agent step, before the step is judged; it never fails the step. `history.usage: { enabled: true, prices: {} }`, on by default; `false` writes nothing and stops the read.
- An override entry (per model, up to 64, ids matching the safe pattern) replaces the shipped entry whole: all four prices, finite and non-negative, `cache_write_1h` defaulting to 2x input.
- Costs are estimates, stored with the revision, never recomputed. Claude Code's `cost-state` is never shown as a cost. Tokens spent while the run waits at a gate are not charged to a node.
- Maintainer tooling (group C): `node scripts/check-prices.mjs [--local]` and the skill `kodel-prices`.

## Risks and invariants

- **P1 untrusted input.** Log times, model ids and the config are agent-editable (an agent can move cost between attempts or change its run's override). Harmless because usage never feeds a check, route or gate; `source: config` is visible; prices are frozen in `run_started.history.usage`.
- **P3 redact / state.** Journal events go through the store's `redact`; the **state is not**. `state.usage` and the frozen override hold numbers and safe ids only: model and session ids must match `SAFE_ID`-style patterns (length cap) or are folded into `other`; ids that redaction would change are hashed before both writes (as `agent_log` does), so state and journal agree and the report reads the state. At most 16 models per record, 64 per run; the same pattern and count cap are in the zod schema of `history.usage.prices`, so the frozen copy in `state.history` is no free-text channel. A bad value is `Repeat`ed.
- **P4.** Table, matching, price maths and aggregation are pure in `pipeline-core` (no `node:fs`, no clock; `effectiveFrom` is compared with the event's `ts`). Reading logs and the override file stays in `@kodel-ai/local`. The API is event-based, so Kodel Server can feed its own events; its store must persist `RunState.usage` (named in the PR).
- **P6.** No new MCP tool; nothing a person decides is open to the agent.
- **P8 / stored data.** New events `usage_recorded`, `usage_failed`, state `usage`, optional `cache_write_1h`, `run_started.history.usage`. Verified in the code: `readStateRaw` and `readJournal` parse plain JSON and `summarizeRun` ignores unknown events, so an engine without this change tolerates all of it (a test of the current reader pins that). A usage record carries `v`; the usage reader in `summarizeRun` (not the store) turns an unknown `v` into a "cannot read (format X)" row, never "modified". Old runs read `not_captured`.
  `fixtures/formats/v1/` and `hashes.json` are untouched; the golden run with usage is `fixtures/usage-run/` with explicit `status`/`report` tests and a note of where its hash is pinned at the freeze; the saved real session in it is scrubbed to usage lines and ids before commit.
- **Records are deltas.** `usage_recorded {session, node?, attempt?, delta, cursor}`: the machine accepts one with a node only for the **active agent visit in phase agent while running** (else `Repeat`), and one without a node (`unattributed`) while running; the report sums deltas. A hand-in refused after the pass (`UNKNOWN_OUTCOME`, `NODE_NOT_RUNNING`) and retried simply adds another delta to the same attempt. Nothing is rewritten and nothing is written to a finished run.
- **Cursor.** State keeps per session `{last_seq, last_key, flushed?}`: `seq` is deterministic for the same log, so after a server restart the pass re-reads from the run's start (up to its budget) and skips what is credited; a budget stop credits only what was read, the rest comes next pass (`complete: false` meanwhile). Nothing is orphaned.
- **Double counting.** One `usage` per response (the collector folds lines); the aggregator also dedupes by `message.id`/`requestId` across the main file and subagent files (set capped at 200 000 keys; beyond it the record is flagged `dedupe_overflow`). Subagents are counted regardless of `tool_log`.
- **Time and lock.** The step end takes the pass lock once and runs the agent-log pass, then the usage pass, under it; the ticker never runs usage and yields as it does for the agent log. Worst added time before a step is judged: lock wait 5 s + agent-log budget 30 s + usage budget 10 s, stated in the docs. If the lock is not obtained, `usage_failed: busy` is journaled once (the delta waits for the next pass; nothing is lost because the cursor did not move).
- **Journal size.** `usage_recorded` only at step ends, at most `MAX_USAGE_EVENTS` (1000) per run, plus `usage_failed` once per reason.
- **Clock.** Journal `ts` is epoch ms, log `ts` ISO (converted); same machine assumed (a remote or devcontainer MCP would mis-window: documented). The normalizer clamps non-monotonic log time forward, so skew errs toward the earlier node, deterministically.
- **Price shape.** Dated entries per model (a list). Long context (>200k input in one request) is counted per event in `long_context` and flagged, not modelled. Models seen under other names (Bedrock/Vertex ids, `[1m]`) read as `partial`: accepted.

## Acceptance criteria and tests

Names carry `t9jrs_` until the person gives the decision id. Each commit carries its tests.

1. **Real run.** A dev-pipeline run records usage for every agent node and a run total; tokens within 10% of `claude -p`'s own `modelUsage` for the same session. `tests/agents/claude-code-usage.test.ts`: `t9jrs_real_run_tokens_agree_with_agent`, `t9jrs_real_run_cost_reported_against_agent`, canary `t9jrs_canary_new_claude_format_fails_loudly`. `tests/agents/harness.ts` is changed to return the result event's `usage` and `modelUsage` (test in `harness.test.ts`). Env-gated: the person runs them before merge and the result goes in the PR; they must not depend on the pinned CI version writing `cache_creation`.
   The CI-enforced twin is offline: `t9jrs_saved_session_agrees_offline` (saved real session with the agent's own numbers; also asserts the `last_open` response is the only difference, with its size), `t9jrs_changed_usage_shape_is_unreadable_not_zero`.
2. **Unreadable log.** `t9jrs_log_missing_is_not_collected`, `t9jrs_invalid_lines_truncated_tail_unknown_fields`, `t9jrs_entries_without_timestamp_and_clock_skew`, `t9jrs_big_log_is_streamed` (a synthetic generated stream, heap and chunk-count assertion, not a 1 GB file).
3. **Parser and pass (offline).** `t9jrs_default_collector_options_events_byte_identical` (v2.1.306 against the existing golden; the new options leave the agent-log pass unchanged), `t9jrs_cache_write_1h_is_carried` and `t9jrs_1h_write_priced_at_its_own_rate` on a refreshed **real** fixture with 1h writes (`fixtures/history/claude-code/<new version>`, scrubbed; a test fails if it has none),
   `t9jrs_dedupe_message_id_request_id`, `t9jrs_dedupe_across_sidechain_and_subagent_files`, `t9jrs_dedupe_overflow_flagged`, `t9jrs_cache_tokens_kept_apart`, `t9jrs_subagent_counts_under_parent_and_is_marked`, `t9jrs_subagents_counted_when_tool_log_false`, `t9jrs_attempt_credit_with_prompts_off_and_over_served_cap`, `t9jrs_retried_node_gets_its_own_attempt`.
4. **Attribution (the refutation of decision 3).** `t9jrs_node_sums_plus_unattributed_equal_run_total` (also as a property test over random splits), boundary cases with an equal timestamp and one millisecond either side, `t9jrs_first_attempt_starts_at_runs_first_call`, `t9jrs_next_step_response_credited_to_its_step`, `t9jrs_gate_wait_and_pause_spans_go_to_unattributed`, `t9jrs_superseded_or_canceled_attempt_usage_not_lost`, `t9jrs_refused_hand_in_then_retry_adds_delta`, `t9jrs_recorded_only_for_active_agent_visit` (a wrong node or future attempt is `Repeat`).
5. **Edges of the pass.** `t9jrs_open_response_flushed_only_at_eof_never_on_budget_stop`, `t9jrs_flushed_open_response_corrected_on_next_pass`, `t9jrs_pass_after_restart_skips_credited_and_catches_up`, `t9jrs_budget_stop_credits_only_what_was_read`, `t9jrs_log_still_written_complete_false_then_filled_idempotent`, `t9jrs_truncated_or_rotated_log`, `t9jrs_worktree_removed_before_collection`, `t9jrs_agent_still_running_at_run_end`.
6. **Price maths (pure).** `t9jrs_price_maths`, `t9jrs_long_context_flagged_not_modelled`, `t9jrs_reasoning_not_added_to_output`, `t9jrs_rounding_pinned`, `t9jrs_model_matching` (suffix cut, `claude-3-5` not `claude-3`, longest prefix, exact beats prefix), `t9jrs_effective_from_before_of_after_none_and_duplicates`, `t9jrs_unknown_model_keeps_tokens_cost_null_partial`, `t9jrs_reported_zero_is_not_unknown`, `t9jrs_overlap_semantics_subtracts_cached`, `t9jrs_override_per_model_source_config`,
   `t9jrs_override_rejects_partial_negative_nonfinite_unknown_keys_and_unsafe_ids`, `t9jrs_override_1h_defaults_to_2x_input`, `t9jrs_cost_stored_with_revision_not_recomputed`, `t9jrs_pure_modules_have_no_io_import` (AST scan of imports, including type-only, re-exports and dynamic `import()`).
7. **Run machine and journal.** `t9jrs_usage_failed_once_per_reason`, `t9jrs_usage_recorded_and_model_caps`, `t9jrs_state_holds_only_numbers_and_safe_ids` (whole `state.json` after a hostile log), `t9jrs_state_and_journal_agree_under_project_redaction_rule`, `t9jrs_usage_recorded_is_redacted_in_journal`, `t9jrs_nothing_written_to_a_finished_run` (journal byte-identical after a later pass), `t9jrs_old_run_reads_as_not_captured` (golden run opened with `status` and `report`), `t9jrs_current_reader_ignores_unknown_events`, `t9jrs_unknown_usage_v_is_cannot_read_not_modified`.
8. **Host.** `t9jrs_switch_off_writes_nothing_and_does_not_read`, `t9jrs_agent_log_off_usage_on_records_written`, `t9jrs_step_end_runs_both_passes_under_one_lock_usage_after_agent_log_before_judging`, `t9jrs_lock_busy_journals_usage_failed_once_and_loses_nothing`, `t9jrs_collector_throw_or_timeout_never_fails_step_and_routing_unchanged`, `t9jrs_ticker_and_step_pass_interleaved`, `t9jrs_one_session_over_two_runs`, `t9jrs_two_sessions_in_one_run`, `t9jrs_frozen_prices_used_not_later_edit`, `t9jrs_agent_unsupported_reason`. Finding the log: `t9jrs_only_sessions_that_called_pipeline_tools_count`, `..._session_shared_with_other_work_goes_to_unattributed`, `..._run_over_several_sessions`, `..._session_from_hook_index_or_env`; the folder-name cases are 3BK2's and re-run only if the shared finder changes.
9. **Config.** `every_history_category_has_a_switch` and `t3bk2_history_keys_exact` (agent-log-docs.test.ts) name `usage` as optional like `agent_log`; `t9jrs_usage_config_defaults`.
10. **Isolation (hard test).** `t9jrs_usage_never_feeds_check_route_or_gate`: the price/aggregation module is split from the record types, an AST scan shows the checker, router and gate code import neither, and one scripted run with two different tables/overrides and a throwing usage pass has equal routing and gates. A failure refutes keeping usage information-only.
11. **Report.** `t9jrs_report_shows_flags` (golden output for each flag and each `not_collected` reason), `t9jrs_report_partial_total_never_zero`, `t9jrs_report_labels_estimate_and_revisions`, `t9jrs_report_never_shows_cost_state`, `t9jrs_report_json_has_usage`, `t9jrs_docs_history_updated` (replaces the "Prices (planned)" assertion in the same commit).
12. **Tooling (group C).** `t9jrs_check_prices_local_drift_over_10pct` (9.9% not flagged; models absent from events listed; `hasUnknownModelCost` skipped), `t9jrs_check_prices_exit_codes` (plain Node subprocess, saved pages: 1 on a change, 2 on unreachable or unparsable; a local fake server answering 500 or hanging gives 2), `t9jrs_check_prices_local_outside_kodel_project_reads_nothing`, `t9jrs_project_folder_name_matches_locate_ts` (the script's copy against `locate.ts` on a corpus), `t9jrs_kodel_prices_skill_structure`.

**Refutations:** D2 own pass: `t9jrs_agent_log_off_usage_on_records_written` fails. D3: test 4 conservation, or node sums short of the agent's figure beyond the tolerance. D4: a real run is more than 10% low only because of the last response. D5: a real run misses 10% on tokens, so the decision is reopened, not the test bent. D6: `t9jrs_default_collector_options_events_byte_identical` fails. Information-only: test 10.
One-off, by the builder, in the PR (the sample kept as a fixture): tokens of 3+ clean real sessions within 10% of the agent's own; the cost of the second log read; cost against `cost-state` on sessions without long context; the shipped `sourceUrl`s parse from saved pages.

**Cannot be shown by a test:** agreement with the invoice; that shipped prices are current (only the maintainer script with network); hidden requests missing from the transcript; subagent cost when no subagent log is written; a remote clock and the host-vs-log clock; the real wall-clock worst case of the added time (tests use a fake clock); the open-response effect beyond one real run.

---

## Steps

0. At the gate: the answers to the decisions and the decision id.
**Group A (pure, no I/O)**
1. Event detail: optional `cache_write_1h` on `usage` (`agent-history.ts`, `normalize.ts`); collector options `usageDetail` and `holdBack: false` that flushes only at the end of the file; defaults byte-identical; a refreshed real fixture. Tests 3 (parser part).
2. Core: `price-table.json` + `price-table.ts`, `usage.ts` (matching, per-event pricing, aggregation with the attribution rule), `usage-record.ts` (types, `v`). Check price lists for the minimum set of model ids. Tests 6.
3. Config `history.usage` (schema with the id pattern and count cap), `HistoryConfig.usage?`, frozen in `run_started.history`. Tests 9.
4. Run events `usage_recorded`, `usage_failed`, state `usage` with the cursor, active-visit check, caps, id guards. Tests 7.
**Group B (the pass and what shows it)**
5. Extract the session finder from `agent-log.ts` into `session-finder.ts` with no behaviour change and no `agent_log` gate; `AgentLogRun` gets a read-only `journal()` (spans). Tests 8 (finding the log).
6. `local/src/usage.ts`: own gate, cursor, budget, flush rule, gate/pause spans; the shared step-end lock in `agent-log.ts`/`host.ts` running both passes; nothing to a finished run. Tests 3-5, 8.
7. Report in `summarizeRun`, `kodel report` (+ `--json`), `kodel status` untouched; docs in `docs/history.md` (replace "Prices (planned)" **and the Constraint paragraph** that says the release waits; add the privacy and gate-chat lines). Tests 10-11.
**Group C (may be cut, decision 1)**
8. `scripts/check-prices.mjs` (reads `price-table.json`; `--local` with a small copy of `projectFolderName` guarded by a test). Tests 12.
9. `skills/kodel-prices/`.

## Affected files

- New: `packages/pipeline-core/src/{price-table.json,price-table.ts,usage.ts,usage-record.ts}`, `packages/local/src/{usage,session-finder}.ts`, `scripts/check-prices.mjs`, `skills/kodel-prices/`, `fixtures/usage-run/`, `fixtures/history/claude-code/<new version>/`, `tests/agents/claude-code-usage.test.ts`, tests in `pipeline-core`, `local`, `cli`, `testkit`.
- Changed: `pipeline-core/src/{agent-history,run,report,history-config,index}.ts`, `packages/local/src/{host,agent-log,agent-log-ticker,config,history/claude-code/normalize,history/claude-code/collector}.ts`, `packages/cli/src/{format,cli}.ts`, `tests/agents/{harness,harness.test}.ts`, `docs/history.md`, `packages/local/test/{config,agent-log-docs}.test.ts`, `packages/testkit`.
- Not changed: MCP tool definitions; `fixtures/formats/v1/*`, `hashes.json`; `examples/pipelines/feature.yaml`.

## Rejected review findings

Adopted in the plan: every finding of both rounds not listed here. Not adopted, with the reason:

- *Split the price check* (scope, twice): not the default; the person asked for it with the table (52A8). It is decision 1, group C, cuttable at no cost.
- *Reuse the agent-log pass's read instead of an own pass* (scope): the privacy switch must not decide whether usage works (decision 2); the second read is measured once instead.
- *Use `step_served` windows as the task says* (task text): replaced by the pass-credit rule (decision 3), which needs neither `history.prompts` nor the 500 cap.
- *Drop the equal-routing scenario test* (scope): kept; it is the refutation of the information-only rule.
- *Folder-name and hook-session tests belong to 3BK2* (scope): accepted, re-run only if the shared finder changes.
- *The release waits for the format change* (my first plan): wrong; the changes are additive (decision 6).
- *Drop the docs-wording and older-engine tests* (scope): the older-engine test is replaced by a test of the current reader plus the verified code facts; the docs test stays only as `t9jrs_docs_history_updated` because the existing docs test would fail otherwise.
- *Make `complete: true` possible for a normal run* (invariants): `complete` means the source was read to its end; the open last response is counted and marked `last_open` (decision 4).
- *Windows from a persisted time cursor*: not used; the `seq` cursor is exact and deterministic, so clock skew cannot double count.
- *Merge the two cap tests* (scope): done as one test, `t9jrs_usage_recorded_and_model_caps`.
- *Remote clock* (gaps): documented, not handled.

## Findings in the code

- `agent-history.ts`: `usage` event has `model`, four counts, `reasoning`, `semantics`, `message_id`, `request_id`, `cost {amount?, basis}`; `normalize.ts:251` emits `cost: {basis: "unknown"}`; `COST_BASES` has `computed`. `normalize.ts:243-247` keeps only `cache_creation_input_tokens` and drops `cache_creation.ephemeral_1h_input_tokens`; recent logs (2.1.310/311) carry it on every assistant line with all writes 1-hour. `fixtures/history/claude-code/v2.1.306` has no `cache_creation` object.
- `normalize.ts:109,233`: `flushPending` marks a message seen, so later lines of it make no usage; `collector.ts:252-255` flushes at the end of every non-holdBack read, including a budget stop (the reason for the "EOF only" rule). `normalize.ts:163` clamps log time forward; `SEEN_CAP` 1 000 000.
- `agent-log.ts:290-302` `shouldSkip` is `disabled` without `state.agentLog`/`agent_log.enabled`; `findRunStart` in `history/claude-code/window.ts`; `PASS_BUDGET_MS` 30 s; the ticker yields only through `AgentLogWriter.inFlight` (`agent-log-ticker.ts:98`); `AgentLogRun` has `state()`, `apply()`, `workdir()` and no journal.
- `host.ts:2111-2156` `completeStep`: the capture runs before `agent_completed` is applied (`~2135`), and that apply can be refused (`run.ts:975-984`); `recordHandIn` runs in between.
- `run.ts`: `step_served` only with `history.prompts` and capped at 500 (`1158-1180`); `node_entered` always journaled (`661`); journal `ts` is epoch ms (`502-508`); state is not redacted (`173`); `SAFE_ID` and the `agentLogSaved` checks (`1202-1260`) do not check the active visit, `stepServed` does.
- `store.ts`: `readStateRaw` (`495-520`) and `readJournal` (`613-633`) parse plain JSON, no `v` check on journal records; `redactDeep` on journal events (`975`); `summarizeRun` (`report.ts:207-362`) ignores unknown events.
- `history-config.ts` (`agent_log` optional, not in `DEFAULT_HISTORY`), `config.ts:145-171` `HISTORY_SECTION_KEYS`, `config.test.ts:279-283` and `agent-log-docs.test.ts:75-77` list the keys; `docs/history.md:294` "Prices (planned)" and `:313-315` the Constraint paragraph.
- `scripts/build-cli.mjs:24-27` builds `dist/kodel.js` from `main.ts`, which runs the CLI at top level; core uses extensionless imports; CI runs `bun test` before `bun run build`. `tests/agents/harness.ts:226-235` exposes only `total_cost_usd`. `fixtures/formats/README.md`: an optional field needs no new directory. `skills/` has `analyze`, `design`, `kodel-run`.

## Implementation notes (where the build differs from the plan)

Written after the review of the build. What was done differently or not done, plainly:

- **Fixtures are hand-made, not recordings.** `fixtures/history/claude-code/v2.1.310/` (the 1-hour cache tier) and
  `fixtures/price-pages/` (the saved price page) were written by hand with invented numbers; their READMEs say so. A real,
  scrubbed recording of a session with 1-hour writes was not committed. `t9jrs_saved_session_agrees_offline` therefore sums the raw
  file by an independent route and shows that nothing is lost or added; it does not show that a real agent agrees. That is the
  env-gated `tests/agents/claude-code-usage.test.ts`, which was not run. The golden run `fixtures/usage-run/` was made by the pass of
  this build over a hand-made log, outside `fixtures/formats/v1/` so that `hashes.json` is untouched; it moves under the frozen
  formats at the first release.
- **The price table is unverified against the live page.** Every entry has `checkedAt: null`. The 4.5 rows are from the vendor's
  price page; the 5.x rows (Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50, Fable 5.1 $10/$50) are from the model table
  of the `claude-api` skill, cached 2026-10-06, after the second review found that the first version of them (assumed to be the 4.5
  prices) was wrong. The cache read price of Haiku 5.5 is not published there and is assumed to be 10% of its input price. Haiku
  5.5 prices a request over 100K prompt tokens higher, which is not modelled; its `long_context_tokens` is 100 000, so such calls are
  flagged (the others: 200 000). There are no rows for `claude-opus-4-1`, `claude-opus-4`, `claude-sonnet-4`, `claude-3-7-sonnet` or `claude-3-5-*`, so a
  run on those models reads `partial` (the accepted behaviour for an unknown model, never `$0`). `scripts/check-prices.mjs` lists the
  unchecked entries; the saved price page it is tested on is also hand-made, so the repository does not show that the shipped
  `sourceUrl` parses. The `cost-state` parser is written without a sample of the format.
- **"A session shared with other work goes to unattributed" is not built.** Only the spans a person was waited for (gates, pauses)
  go to `unattributed`; whatever else the session says between two steps is credited to the next agent step, as decision 3 says for
  polling through command nodes. The test named for it is not written.
- **Dedupe across logs holds within one pass.** The set that tells a repeated response apart is per pass (capped at 200 000 keys),
  not kept for the run; a read repeated in a later pass (a budget stop, a subagent log that appears later) could count a response
  twice. Subagent logs do not repeat the main log's responses in the logs seen, so this is rare.
- **Windows come from passes, not from `step_served`** (decision 3); the plan's test names `t9jrs_window_*` are covered by the
  boundary tests of `splitBySpans` and the pass tests. `t9jrs_run_over_several_sessions` and `t9jrs_two_sessions_in_one_run` are one
  test, `t9jrs_two_sessions_in_one_run_and_session_from_hook_index`.
- **`node_superseded` (a node dropped by a pipeline change) is not exercised.** A cancelled run is (`t9jrs_superseded_or_canceled_attempt_usage_not_lost`).
- **The JSON import has no import attribute.** `price-table.ts` reads `price-table.json` with a plain `import`; that works for Bun
  and for the bundled `dist/kodel.js`. An unbundled Node ESM consumer of `@kodel-ai/pipeline-core` (its exports point at `src/`) would
  need `with { type: "json" }` or a bundler; Kodel Server must be told.
- **Past 1000 `usage_recorded` events** a run says `cap` (a failure reason) and the log is not read again; past 2000 attempts the
  rest is counted in `unattributed`.
- **`t9jrs_` is still a provisional prefix** (decision 7); the PR checklist greps that none is left at merge.
- **Correction deltas** zero `api_calls` (the response was counted as a call when it was open). A model line made only of a
  correction (the agent changed model between steps) used to read `usd: null` beside a total that had the dollars; `summarizeCost`
  now counts a line as known when it has any cost, so the two agree (`t9jrs_model_line_made_of_a_correction_has_its_cost`).

### After the second review

- **Prices and thresholds fixed** (see the table note above); `long_context_tokens` is a field of a table entry
  (`t9jrs_long_context_threshold_is_the_models_own`). Every test and fixture with a dollar figure was changed with it.
- **Open response and a whole one in another stream.** The pass kept the set of repeats under one key and looked up the open
  response under another, so the check never matched; both now use `usageDedupeKey`
  (`t9jrs_open_response_in_one_stream_whole_in_another_counted_once`).
- **A record the run refuses** (an id its account does not accept, the run gone) ends the pass and now says `record_refused` once,
  and `SAFE_SESSION` has the 128-character cap of the run's own ids, so a longer session is not looked at and reads `session_unknown`
  (`t9jrs_a_record_the_run_refuses_is_said_once_not_a_silent_end`, `t9jrs_session_id_over_the_length_cap_is_not_looked_at_and_said`).
- **A subagent log with no time on any entry** is said (`unreadable`), not skipped without a word. A log whose first entry only lacks
  a time is dated by the first entry that has one, as before.
- **Tests named in the plan that were renamed or split, and what they do not show.** `t9jrs_open_response_flushed_only_at_eof_never_on_budget_stop`
  is two tests: the collector-level `t9jrs_a_stopped_read_does_not_release_the_open_response_when_usage_detail_is_on` and the writer-level
  `t9jrs_budget_stop_credits_only_what_was_read` (the writer's own rule is `!stoppedEarly` in `usage.ts`; the collector rule is a guard
  for a consumer that reads without `holdBack`, which the usage pass does not). `t9jrs_step_end_runs_both_passes_under_one_lock_usage_after_agent_log_before_judging`
  is `t9jrs_usage_pass_runs_after_agent_log_before_judging` (order in the journal) plus the new `t9jrs_step_end_takes_the_pass_lock_once_for_both_passes`
  (counts the acquisitions). `t9jrs_switch_off_writes_nothing_and_does_not_read` now has a collector spy
  (`t9jrs_switch_off_does_not_even_build_a_collector_or_read`).
