# TASK-V75E: what the agent was shown (`served/`)

## TL;DR

- Every `node` answer that the MCP tools hand to the agent is kept, redacted, in `served/<node>-<attempt>-<n>.json`
  of the run, and the journal gets a `step_served` event (`node`, `attempt`, `n`, `ref`, `prompt_hash`,
  `executor`). The same answer to the same client is stored once. Switch: `history.prompts.enabled`
  (already in the config, TASK-CXSE, journalled in `run_started.history`).
- The run machine gives `n` and `ref` under the run's lock; the file is written only after the event was accepted.
  No file without an event; a crash can leave an event without a file (readers treat that as "not stored").
- Cost: medium (core event and state key, store method, recording in `LocalRun.nextStep`, `caller` on the three
  service paths, a report line, English docs, tests, the leftover TASK-5BTP real-agent test). Risk: a write on
  a read-mostly path, bounded by caps, redacted, never failing the answer.
- What the critique changed: `ref` is built by the machine; `step_served` outside `running` is a no-op, not an error;
  a hook-index session no longer makes the key flip; the cut now covers every large field; the scenario test is
  local-only (no change to the shared scenario); tests pass `history` explicitly; docs are written.

## Decisions needed

1. **What counts as "served".** Every `node` answer the service returns from `pipeline_start`, `pipeline_next_step`
   and `pipeline_complete_step`, including those the dialog (`elicit.ts`) and agent-decision code get from
   `service.nextStep` and hand on: they are serves. Recording needs the `serve` option, which only the service
   paths pass (host-internal loops do not). Cost: a new path that forgets `serve` records nothing; guarded by a
   test per service path and one per MCP tool. Recommendation and default: record all of them.
2. **Bounds (please confirm the numbers).** At most 20 files per node attempt, 500 `step_served` plus
   `served_write_failed` events per run, 256 KiB per file. The task gives no figures. Default: these numbers, as
   fixed constants (no new config keys).
3. **Session in the dedupe key.** Key = prompt hash + client name and version + session, where the session counts
   only when it comes from the environment (`CLAUDE_CODE_SESSION_ID`). A session found through the hook index is
   "the newest session of the directory" and flips with several windows, so it is journalled in `executor` but
   not in the key. With `history.executor` off the key is the prompt hash alone. A client update (version
   change) mid-run gives one new file. Default: this.
4. **Report line.** `kodel report` prints `prompts: <n> served` or `prompts: not_collected` after the `task size`
   lines. `not_collected` for a run without the `served` state key: an older run, `history.prompts` off at its
   start, or a run started before this change and continued after upgrading (its own `history` says on; said in
   the docs). Default: this.
5. **Closing the task.** The two real-agent tests (`KODEL_AGENT_TESTS=1`) cannot run in the pipeline; the
   person runs `bun run test:agents` and that run closes the "real run" part of "done when". Not split. Default:
   this.

## Behaviour change

After a run, `.kodel/runs/<run>/served/` holds, for each step attempt and each distinct client, the step as the
engine built it (prompt, rework feedback, result spec, outcomes); the journal says when and to which client. The
fields the service adds around a step (`failed_check`, `workdir`, `branch`, `note`) are not stored. With
`history.prompts.enabled: false` nothing is written and the report says `not_collected`. The agent sees the same
answers; a failed write is invisible to it.

## Risks and invariants

- **Redact at every write path.** One call redacts the answer with the store's rules (those of the moment: a rule
  added mid-run gives later answers another hash, bounded by the caps). Hash, key and file all come from that
  value; the cut comes after redaction. A cut file cannot be checked against its hash (the hash is of the whole
  answer); `served/` is outside the seal, so this is documented, not hidden.
- **Fail closed, the answer stands.** Any error while recording is caught. A failed file write is journalled as
  `served_write_failed` (`node`, `attempt`, `n`, short message without the folder). Other errors record nothing.
- **pipeline-core has no I/O.** Core: the events, the state key, the rule for `n`, `ref` and the caps. Local: hash
  (`node:crypto`), file, executor lookup. A test walks `pipeline-core/src` for `node:crypto`/`node:fs`.
- **Stored data is additive.** New `served/` folder with records `{v: 1, ...}`, optional `served` state key, new
  journal events. No field renamed, removed or retyped, so no migration; `fixtures/formats/v1` has no `history`
  or `served/` and stays untouched. Formats may break before the first release (rule 4), so there is no test
  that an older engine reads the new event. The seal covers `state.json` and `journal.jsonl` only.
- **Machine rule for `step_served`.** Handled before the status check, like `tick`: `Repeat` unless the run is
  `running` and `node:attempt` is the active agent visit (a run paused or ended, or a step completed by
  another client, between building the answer and applying the event is a quiet no-op, not
  `NODE_NOT_RUNNING`). So "every attempt has a file" is a statistical guarantee, not strict; said in the docs.
- **Numbering and locking.** `apply` takes the lock. The machine checks the key in `state.served["node:attempt"]`
  and the caps, assigns `n = keys + 1` and `ref = served/<slug>-<attempt>-<n>.json` (a node slug already
  matches `^[a-z0-9][a-z0-9-]{0,62}$`, so no escaping), and journals both. The host writes the file from the
  returned `ref`. The key hash is in the state only, not in the journal.
- **State size, no secrets.** `state.json` is rewritten and not redacted; it holds 16-hex key hashes only (at most
  20 per attempt, 500 events per run, about 10 KiB), never client or session strings.
- **Cost.** Per call: the env session and the client (cheap) and a state read; the full `observeExecutor`
  (hook index tail, model from the session log tail) runs only for a new key. A new key costs a second `apply`
  (lock, integrity check, `writeState`, journal) plus the file.
- **Humans decide trust / agent input untrusted.** No new tool; client and session come from the transport and the
  environment, sanitised by the TASK-5BTP code.

## Acceptance criteria and tests

Names carry the task id (no decision-log id applies). Host tests (`packages/local/test/host.test.ts`) start the
host with `history` passed explicitly (`changes` off, so no git is needed; `prompts` on or off per test) and get
a second client or session from a shared `newHost` helper extracted from `executor.test.ts` (fake Claude home,
`environment.CLAUDE_CODE_SESSION_ID`, a `Caller {name, version}`).

| criterion | test |
| --- | --- |
| first serve: `served/<node>-1-1.json` (`v: 1`) and one event with `n: 1` and `ref` | `v75e_first_serve_writes_file_and_event` |
| same answer, same client and session: one file | `v75e_repeat_serve_same_client_is_stored_once` |
| other client; same client with another env session; a client update: a second file | `v75e_other_client_gets_its_own_file`, `v75e_other_session_gets_its_own_file`, `v75e_client_version_change_gets_its_own_file` |
| hook-index session is not in the key (two hook sessions: one file); it is in `executor` | `v75e_hook_session_does_not_flip_the_key` |
| `history.executor` off: key is the hash; event has no `executor` | `v75e_executor_off_key_is_prompt_hash_only` |
| rework: new attempt, own file | `v75e_rework_gets_new_attempt_file` |
| pipeline change on the same attempt: new prompt, new hash, `n: 2`; the refutation is "hash equal when the prompt differs" | `v75e_pipeline_change_changes_prompt_hash` |
| failing check (scripted `test` step exits 1): attempt 2's `reentry_feedback` and its served file hold the reason. Local-only test with `LocalEngine`; the shared scenario and `ScenarioState` are not changed | `v75e_scenario_failing_check_reason_in_attempt_2` |
| switch off: no `served/`, no event, no state key | `v75e_switch_off_stores_nothing` |
| hash: stable for equal answers; moves with feedback, `pipeline_change`, `result_spec`, outcomes (unit) | `v75e_prompt_hash_is_stable_and_follows_every_field` |
| redaction: a secret shape the redactor matches, in task text and `reentry_feedback`: neither of two secrets is in the file; both prompts have one hash | `v75e_served_file_is_redacted`, `v75e_hash_is_of_redacted_text` |
| `waiting` / `running` answers store nothing | `v75e_waiting_answer_stores_nothing`, `v75e_running_answer_stores_nothing` |
| `wait_s`: no file while `running`; the node answer after the wait is stored once | `v75e_long_poll_stores_node_answer_once` |
| run paused by a human `pause` (gives `waiting`): nothing written | `v75e_paused_run_stores_nothing` |
| the race: the run is paused or the step completed between the answer and the event: answer returned, no event, no error | `v75e_event_outside_running_or_stale_attempt_is_a_noop` |
| 20-file cap (20 env sessions) and 500-event cap (varied `Caller.name`, shared with `served_write_failed`): answer still returned | `v75e_file_cap_per_attempt_still_returns_answer`, `v75e_event_cap_per_run_still_returns_answer`, `v75e_write_failures_share_the_event_cap` |
| tight loop of the same call: one file | `v75e_tight_loop_is_one_file` |
| two distinct callers at once (`Promise.all`): numbers exactly `{1,2}`, both files exist; cross-process locking is covered by the store's own lock tests, not here | `v75e_concurrent_serves_get_distinct_numbers` |
| huge text: file ≤ 256 KiB, parses, `truncated: true`; every large field has the cut order (`prompt`, `reentry_feedback`, `execution.instruction`, then `result_spec` and `pipeline_change` replaced by a marker); prompts differing after the cut hash differently | `v75e_huge_prompt_is_cut_and_valid`, `v75e_huge_result_spec_is_replaced_by_a_marker` |
| write error (a regular file where `served/` should be; works on Windows): answer returned, `served_write_failed` without the folder path; the report and readers treat the missing file as "not stored" | `v75e_write_error_does_not_fail_the_answer`, `v75e_event_without_file_reads_as_not_stored` |
| the answer is byte-identical with the switch on and off | `v75e_answer_identical_with_and_without_recording` |
| each service path serves (real `LocalPipelineHost`, not a fake service): start, next_step, complete_step; each MCP tool (`packages/local/test/mcp.test.ts`); dialog and agent-decision paths (`packages/cli`) | `v75e_every_service_path_serves`, `v75e_every_mcp_tool_serves`, `v75e_dialog_and_agent_decision_next_step_are_serves` |
| host-internal calls (no `serve`) store nothing | `v75e_internal_next_step_stores_nothing` |
| old runs (`fixtures/formats/v1`): `status` and `report` work, report says `prompts: not_collected`, the `task size` lines are unchanged, reading creates no `served/`, `hashes.json` still holds. One test per file | `v75e_old_run_reports_not_collected` (`packages/local/test/formats.test.ts`), `v75e_old_run_report_line_in_cli` (`packages/cli/test/cli.test.ts`) |
| new run, switch on, no serve: `served: 0`; with serves: counted | `v75e_report_new_run_says_zero`, `v75e_report_counts_served` |
| no `node:crypto`/`node:fs` in `pipeline-core/src` (file walk; asserts the list is non-empty) | `v75e_core_has_no_io_imports` |
| real agent: every node attempt has a file and an event; a repeat creates none (person-verified) | `claude_code_v75e_served_files` |
| real agent: `run_started` and `agent_completed` carry client name, version and session; an explicit message if the client reports no version (person-verified) | `claude_code_5btp_executor_record` |

Done when (from the task): for a real run every node attempt has a served file and a `step_served` event; attempt 2
holds the failure reason of attempt 1; repeating `next_step` creates no new files; with `history.prompts` false
nothing is stored. Scripted tests show all but "real run"; the person's `bun run test:agents` closes that.

---

## Steps

1. Core `run.ts`: events `step_served {node, attempt, key, prompt_hash, executor?}` and `served_write_failed
   {node, attempt, n, message}`; state `served?: Record<"node:attempt", string[]>`, `servedEvents?: number`; the
   `start` event initializes `served: {}` when `history.prompts.enabled`. Both events are handled before the status
   check; `Repeat` when not `running`, when `node:attempt` is not the active agent visit, on a seen key, on 20 keys
   for the attempt, or on 500 events. Otherwise `n = keys + 1`, `ref = served/<slug>-<attempt>-<n>.json`; journal
   `step_served {node, attempt, n, ref, prompt_hash, executor?}`.
2. Core `service.ts`: `RunHandle.nextStep(options)` gets `serve?: { caller?: Caller }`; `start`, `nextStep` (both
   calls of the `wait_s` loop) and `completeStep` pass it. `elicit.ts` and `agent-decisions.ts` are unchanged.
3. Local `store.ts`: `redactAnswer(value)` and `writeServed(runId, ref, record)`; the record is `{v: 1, node, attempt,
   n, prompt_hash, truncated?, answer}`; the cut order is in the table above; atomic write; `readServed`.
4. Local `host.ts` in `LocalRun.nextStep`: if `serve` is given, the step is a `node` answer and `state.served` exists:
   redact once, hash, build the key (hash, client, env session only); skip if the key is in the state; run the full
   `observeExecutor` (omitted when `history.executor` is off); `apply(step_served)`; if accepted, write the file at
   the returned `ref`; on a write error `apply(served_write_failed)`. All inside try/catch.
5. Report: `report.ts` counts `step_served`, reads the `served` key into `prompts: { served: n } | { not_collected:
   true }`; `cli/src/format.ts` prints it after the `task size` lines.
6. Testkit: `LocalEngine` (`local-engine.ts`) starts the host with `history` (changes off) and passes `serve` from
   `start`, `drive` and `pipeline_next_step`; `MemoryEngine`, `ScenarioState`, the shared scenarios and
   `matchers.ts` are not touched. Shared `newHost` helper for the local tests.
7. Docs: a "What the agent was shown" section in `docs/history.md` (folder, record, event, caps, the key, the
   switch, the report line, the statistical guarantee, the upgraded-run case).
8. Real-agent tests in new `tests/agents/claude-code-served.test.ts` (next to `claude-code.test.ts`, reusing
   `harness.ts`: `makeSandbox`, `runAgentTurn`, `humanHost`); new harness helpers read whole journal records and list
   `served/`. First step of the executor test: find out empirically whether Claude Code exports the session to
   the MCP server; if not, the sandbox installs the hooks (as `hooks.test.ts` does) and the test says which path it used.
9. `bun run typecheck && bun run lint && bun test && bun run build && node scripts/check-artifact.mjs`.

## Affected files

- `packages/pipeline-core/src/run.ts`, `service.ts`, `report.ts`, `index.ts`.
- `packages/local/src/store.ts`, `host.ts`.
- `packages/cli/src/format.ts`.
- `packages/testkit/src/local-engine.ts`.
- `docs/history.md`.
- Tests: `packages/local/test/host.test.ts`, `executor.test.ts` (helper extracted), `formats.test.ts`, `mcp.test.ts`;
  `packages/cli/test/cli.test.ts` (and the dialog/agent-decision tests); `packages/pipeline-core/test/`;
  `tests/agents/harness.ts`, new `tests/agents/claude-code-served.test.ts`.

## Rejected review findings

- **[scope] `served_write_failed` is optional.** Kept: without it a failed write leaves an event with no trace of why;
  it shares the 500 bound and is a few lines.
- **[scope] core state field heavier than a cap in local.** Does not hold: a number and dedupe done in local, by
  listing the folder, race across clients and processes and can overwrite a file a journal `ref` points to
  (Principle 8). The field is hashes only, about 10 KiB.
- **[scope] `observeSession` refactor of `executor.ts`.** Taken, in a smaller form: no refactor; the cheap key uses the
  env variable directly, the existing `observeExecutor` runs only for a new key.
- **[scope] extra tests (no-io, identical answer, concurrency) are not in the task.** Kept: each guards an invariant
  the design depends on and costs little.
- **[scope] opt-in `serve` deviates from "LocalRun.nextStep writes".** Kept, Decision 1, with a test per path and per tool.
- **[scope, info] split the task.** Not split (Decision 5).
- **[gaps, info] stale second `apply` cost and `Caller.version` in the key.** Stated (Risks, Decision 3), no change.

All other findings were fixed above (`NODE_NOT_RUNNING` vs `Repeat`, `ref`, scenario test, `history` in host tests,
`newHost`, hook-index key, cut order, docs, test file, paused test, pipeline-change test, caps tests, concurrency
test, service-path tests, MCP tool test, no-io walk, secret shape, old-run test split, mid-run rule change,
hash of a cut file, upgraded runs, stale attempt, harness session path, crash test).

## Findings in the code

- `packages/pipeline-core/src/run.ts:783-807`: `call_refused` is handled before the status check; `tick`/`heartbeat`
  give `Repeat` when not running; any other event gives `NODE_NOT_RUNNING`. `MAX_LOGGED_REFUSALS` at `:178`.
- `packages/pipeline-core/src/pipeline.ts:134-136`: the node slug pattern, safe in a file name.
- `packages/pipeline-core/src/service.ts:512, 524-528, 585`: the three paths; `completeStep` passes `this.caller()` (`:567`).
- `packages/cli/src/elicit.ts:264`, `agent-decisions.ts:33`: `service.nextStep` results handed to the agent.
- `packages/local/src/host.ts:1558` `LocalRun.nextStep`; `:1040-1141` `apply` takes the lock inside; `:375-410`
  `LocalHost.start` takes `history?` (production `pipeline-host.ts:508`); `host.test.ts` passes none and the
  default `changes.enabled` needs git (`history-config.test.ts`).
- `packages/local/src/store.ts:111, 610-650`: `artifactFileName`, `writeReport`/`writeArtifact`; `writeState` does not redact.
- `packages/local/src/executor.ts`: `SESSION_ENV`, `observeExecutor` (hook index tail 64 KiB, session log tail 512 KiB).
- `packages/testkit/src/local-engine.ts:60,132,140,230`, `types.ts:115`, `conformance.test.ts:23-30`,
  `feature-scenarios.test.ts:13`: the shared scenario runs on both engines.
- `tests/agents`: `claude-code.test.ts` exists; `harness.ts` has `makeSandbox`, `runAgentTurn`, `humanHost`,
  `journalEvents` (names only), no hooks and no session variable.
- `docs/history.md:139-161`: English docs of the executor record and `.kodel/sessions.jsonl`.
- `fixtures/formats/v1`: two runs without `history` or `served/`.

## Implementation notes (where the code differs from the plan)

- The cut takes the biggest field first (a text is shortened, `result_spec` / `pipeline_change` replaced by a
  marker), not a fixed order: a huge check no longer costs the prompt. Same limits, still valid JSON.
- The host tests are in a new `packages/local/test/served.test.ts` with their own small `newHost`/`connect`
  helpers (nothing was extracted from `executor.test.ts`). The machine rules and the no-I/O walk are in
  `packages/pipeline-core/test/served.test.ts`; the failing-check scenario is
  `packages/testkit/test/served-scenario.test.ts`, via a new `LocalScenarioEngine.servedFiles()` (the shared
  scenario and `ScenarioState` are untouched).
- `v75e_paused_run_stores_nothing` became `v75e_ended_run_stores_nothing` at the host level (there is no cheap human
  pause in a host test); paused and stale-attempt cases are `v75e_event_outside_running_or_stale_attempt_is_a_noop`
  in the core. The dialog and agent-decision paths are tested in `elicit.test.ts` and `agent-decisions.test.ts`
  (`v75e_dialog_next_step_is_a_serve`, and the end of the agent-rejection test). The service paths are covered
  by `v75e_every_service_path_serves`, which calls the MCP tools, so there is no separate `mcp.test.ts` case.
- `executor.ts` is unchanged: the cheap key reads `CLAUDE_CODE_SESSION_ID` directly and `observeExecutor` runs only for
  a new key.
- The two real-agent tests (`tests/agents/claude-code-served.test.ts`) share one real turn. They were written and
  typechecked, not run: they spend money and need `KODEL_AGENT_TESTS=1`. Whether Claude Code exports the session
  to the server is still unverified; the executor test says so in its failure message if it does not.
