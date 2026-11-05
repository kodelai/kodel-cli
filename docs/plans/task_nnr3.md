# An engine step runs as a session (TASK-NNR3, rebase of TASK-WKJ4 on Session)

## TL;DR

- An agent node with `engine:` runs as a detached host session `ke-<run id>-<visit id>-<attempt>` (POSIX only); it outlives the driver and the MCP server, and the next MCP host joins it by id.
- One open record per run (`RunState.engineSession`, format 2 amended in place) is written **before** `start()`; only the MCP host of the issuing decide starts, under the state lock; everyone else joins. Any open record blocks a new start until its outcome is proven or a person resumes.
- Unknown outcome: the attempt fails, the run pauses `consecutive`, only a person's `resume` goes on. `pass_env`/profile env values are redacted as literals.
- One task, steps in order. The only thing that waits for KDJS D-B and D-C is the CLI turning engine steps on: one default-off flag in the same change.

## Decisions needed

Nothing blocks implementation. The defaults below are taken; the person may override any of them at the plan gate.

1. **Order with TASK-WKJ4: answered (b).** WKJ4 PR 1 lands first as Step 1 of this task (`engines:` schema, the refusal of an engine node on every write path before anything is written, "upgrade kodel" for a hash-matched kept copy with an unknown key). WKJ4 PR 2 and its decision 4 are superseded.
2. **Stored format: answered.** Format 2 amended in place, no version bump. Rule 5: the key is additive and optional (precedents in `docs/run-formats.md`), absent for every run without engine nodes, and no published build wrote format 2 (only the beta's format 1 is out). Ships with codec rows, `t41_*` rows, a real fixture `fixtures/formats/v2-engine/`, a round-trip test and a release note, in the same step.
3. **Unknown outcome 4(i): answered (a).** **Redaction: answered (b)**, limited to `pass_env` and profile env values (not the base allow-list).
4. **Defaults taken, not blocking:** (ii) the result is exit 0 and stdout one JSON object with a string `summary` or `result` (passthrough zod, at most 128 KiB, not cut), so `claude -p --output-format json` works unchanged; (iii) the host never calls `remove` ("journal before remove" dropped). Scope: forks, joins, `result` checks and `outcomes` on an engine node are refused at validation (follow-up task). The `kodel mcp` guard is option (a) (process group check). No `pipelineFeatures` refactor.
5. **Turn-on flag (blocks only the flag).** `KODEL_ENGINE_STEPS` default off in the CLI; turned on in a one-line change once D-B (a child is not a second client) and D-C (`engines:` person-only, AGENTS.md list) are on main and agree with `EngineLaunch`. The person writes T-42; tests use `t42_`.

## Behaviour change

- **None while the flag is off**, without engine nodes, or for command nodes. No config key, pause reason, `v`, `ERROR_CODES` or `CONTRACT_VERSION` (5) change. `lastFailure.source` gains `"session"`.
- **Handler (Principle 7).** The agent handler declares a new `Begin` variant `{ needs: "session", spec }` when `params.engine` is set; the core maps it to phase `engine` and effect `run_engine_step` (not `run_command`), never by matching `kind`.
- **Stored.** `RunState.engineSession?: { node, attempt, visitId, name, id? }`, absent when none. Set by the decide that issues `start`; `id` filled by input `engine_session_started` (journal `{ node, attempt, name, id, launch }`, `launch` = sha256 of the redacted argv, env names and cwd); removed when the outcome is proven or by a person's resume.
- **Who starts.** `EngineOptions.engineSteps?: { start: boolean }`. With the flag on, only `kodel mcp` sets `start: true`. A human command (`gate`, `resume`, accept) enters the visit in phase `engine` with no record and returns at once; it never joins or owns it. The MCP host's next tick or `next_step` sends input `engine_start_pending`: it sets the record and issues `start`, is not a restart, counts nothing and journals nothing but the start. The stale rule (`DEFAULT_STALE_MS`, `restarts` 3) never applies to a session visit; a takeover of one is a join and counts `takeovers` (`MAX_TAKEOVERS` 10). A host without `engineSteps` refuses any decide that would enter or touch an engine visit, and its tick skips them.
- **Waiting.** `engineBusy`/`afterDecision` (`host.ts:2433`, `cli.ts:357`) skip a session visit (by phase `engine` + `needs: "session"`, not by a record), so `kodel gate/resume` never wait `WORK_WAIT_MS` on it. `status`, `report`, `wait`, `agent ls` only read. The driver cannot complete it.
- **Unknown.** Attempt failed with `source: "session"`, `pause.reason` `consecutive`, record kept. `lastFailure.reason` starts with the fixed prefix "outcome unknown, a person decides" and names the session id, `kodel agent logs/stop <id>`, and "upgrade kodel" for `NEWER_FORMAT`.
- **Resume after unknown.** The resume host looks the record up by id/name: still running = refused ("stop it first: `kodel agent stop <id>`"); ended or not listed = cleared; unreadable, `FOREIGN` or `NEWER_FORMAT` = cleared with a warning naming the session. The person's `resume` is the confirmation; no extra flag. An accept (command, dialog, `pipeline changes restore/discard`) is refused while the pause is unknown (reason `consecutive` + an open record of the paused node). If the resume hits `total` (`run.ts:1343`), the record is already cleared, so accept is safe.
- **Refused before anything is written:** start, propose, accept, `proposals apply` of a pipeline with an engine node on a host without `engineSteps`, on Windows, or with `replace`-function redaction rules; an accept that changes the work of an active engine visit; format 1: `UNSUPPORTED_FORMAT_FEATURE` ("offer `kodel migrate`").
- **Output.** Checks see the redacted stdout; `command_finished.output` holds it, the summary is in it. Known gap: the gate report (`report.ts:481`) reads `agent_completed` only, so it shows no engine summary, and engine runs get no workdir fallback. `cancel()` and MCP shutdown detach and name `kodel agent stop <id>`. `kodel mcp` inside a host session's process group serves no tools.

## Risks and invariants

- **Never twice.** Only the decide that sets the record issues `start`. After the save the issuer takes the state lock, re-reads, and calls `start()` only if its record has no id, its visit is in `active` with that attempt in phase `engine`, and no pause names the node; it holds the lock through `start()` and the id write. A joiner classifies a no-id record only under the same lock after a re-read. Any open record blocks a new start, so at most one session per run is ever unproven. Only residual: a lock broken as stale while its holder is frozen.
- **No-id record.** Visit live: listed by name (one full `list()`, `origin: "host"`, recorded cwd) = join and write the id; not listed or any unreadable entry = unknown. Visit gone: not listed = quiet, cleared.
- **Crash windows.** (1) before the record's save: the next tick starts once; (2) after the save, before `start()`: the rule above; (3) inside `start()` after the folder is published (`session-pipes.ts:209`) or (4) after it, before the id write: listed = join; (5) after the id write: `status(id)`; (6) result save lost: terminal status, same event.
- **Boot.** Lock wait 10 s = boot bound 10 s, so the per-start adapter uses `bootTimeoutMs` 5 s. After any `start()` throw a full `list()`: not listed = known failure, cleared; listed or unreadable = unknown.
- **Outcome table** (pure, `satisfies Record<SessionErrorCode, Outcome>`, so a new code breaks the typecheck). Result: `exited`, code 0, child gone, stdout read with 128 KiB + 1 bytes and not longer than 128 KiB. Failed (`source: "command"`): non-zero code, killed, cut or invalid output, resolver refusal, prompt over 64 KiB, function rules, a `start()` throw with the name not listed. Unknown: everything else. Never result or failed while `childAlive`.
- **Prompt.** `begin.prompt` + check instructions + `reentry_feedback` (as `next-step.ts:814`), one argv element after `--`, at most 64 KiB, never a `source: "session"` reason.
- **Launch.** argv from the resolved profile, cwd = workdir, `inheritEnv: false`; env = `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TMPDIR`, `TERM` + `pass_env` + profile env. Dropped unless in `pass_env`: `SSH_AUTH_SOCK`, `GNUPGHOME`, `XDG_*`, `SHELL`, proxy/CA vars, `KODEL_*` (the holder adds `KODEL_ENGINE=1`); a failure reason names `pass_env`. Holder via the CLI adapter factory (`agent-commands.ts:107`). Timeout: node, `defaults.timeout`, profile, else 3600 s.
- **Redaction (b).** A per-start `PipesSessionAdapter` whose `rules` = project rules + escaped literals of `pass_env`/profile env values (at least 12 chars, not path-like) and their JSON-escaped form; they reach the holder's tail, log files and the record's argv. Every read applies the project rules again. `docs/engines.md` says long harmless values are redacted from what checks see.
- **Format.** Format 1 marks the key `refused`. The write-back leg of rule 5 holds because no build drops the key (host writes keep unknown state keys, `formats/v2.ts:31`); the "ignores it" leg rests on the refusal of WKJ4 PR 1. The release note says: a dev build before Step 1 says "was modified" for such a run, and the refusal no longer guards a run whose engine node was removed by an accepted change after a resume.
- **Residuals** (`docs/engines.md`, T-42): stale-broken lock during a frozen `start()`; the profile's content is not pinned (a changed `launch` hash is visible in the journal only); an older kodel or `.mcp.json` from a branch without the guard in the child serves tools; the guard fails open when both `ps` and `/proc` fail; a descendant in its own group outlives the child; resume after unknown may redo work; short or path-like values not literal-redacted; absent exit code is recorded as 0 by the holder; `ke-` records grow (`list()` cost, follow-up "Free finished `ke-` records"); the child's tool calls are not in history. A second host (Kodel Server) must provide the state lock, re-read under it and `start` with the same rule.

## Acceptance criteria and tests

| Criterion | Tests |
|---|---|
| Runs without engine nodes decide the same | `t42_existing_runs_decide_the_same` (golden: `v1`, `v2`, consecutive pause + resume, accept on it, engine-busy skip; captured on main in Step 2; a test pins the sha256 of the golden directory); `t42_no_engine_key_without_engine_nodes` (state + journal bytes) |
| WKJ4 PR 1 refusal | schema rows; `t42_engine_field_refused_before_any_write` (table over every write path: start, resume, accept, gate, tick, `next_step`, `take_step`, `complete_step`, ack, seal, migrate, `pipeline changes discard\|restore`, `proposals apply`, feedback, `report_result`); `t42_hash_matched_unparseable_copy_says_upgrade` |
| Validation, format | `t42_engine_node_refusals` (one per row + valid control); `t42_v1_run_engine_refused_unsupported_feature`; `t42_v2_engine_fixture_round_trip`; `t41_registry_matches_fixture_directories`, `t41_model_and_event_key_tables_are_complete` pass |
| Record and start | `t42_record_written_before_start`; `t42_engine_session_started_idempotent`; `t42_human_decide_does_not_start` (returns at once, no wait); `t42_pending_start_not_a_restart` (counters and journal unchanged); `t42_only_issuing_decide_starts` (takeover, reissue, gate/resume, lost-save retry, two hosts on one base) |
| Never twice | `t42_crash_windows` (1-6, oracle: `start()` count per run <= 1); `t42_frozen_issuer_after_joiner_unknown_spawns_nothing` (pausable fake lock); `t42_window3_real_adapter`, `t42_window4_real_adapter`; `t42_boot_failed_rolled_back_vs_began`; `t42_no_id_lookup_unreadable_entry_is_unknown`; `t42_takeover_rejoins_never_reruns` (real SIGKILL); `t42_test_hook_inert_by_default` |
| Unknown holds | `t42_outcome_table`; `t42_outcome_property` (exhaustive over status x exit x `childAlive` x complete); `t42_unknown_fails_attempt_and_pauses`; `t42_unknown_pause_holds` (table over every write path, incl. `total` on resume: zero spawns, no journal lines); `t42_accept_refused_on_unknown_pause` (command, dialog, agent, restore/discard; control); `t42_resume_after_unknown` (running refused, ended cleared, unreadable cleared with warning); `t42_unknown_reason_text` (a child's stdout cannot forge the prefix) |
| Off by default | `t42_cli_flag_off_sets_no_engine_steps`; `t42_host_without_engine_steps_refuses_and_tick_writes_nothing`; `t42_refused_before_write` (Windows by injected platform, `replace` rules, proposals, `proposals apply`) |
| Run and read | `t42_engine_step_runs_as_named_host_session` (fake and real); `t42_result_contract` (`summary`, `result`, empty, non-JSON, extra keys, trailing text, 128 KiB, +1, > 256 KiB); `t42_driver_cannot_complete_engine_step`; `t42_gate_returns_without_waiting`; `t42_status_report_wait_never_spawn`; `t42_session_timeout_fails` (real); `t42_shutdown_and_cancel_detach`; `t42_host_never_calls_remove` (fake adapter throws on `remove`, every outcome row); `t42_every_source_consumer_has_session_row` (`next-step.ts`, `report.ts:474`, `tui/gate.ts`, `service.ts:777`: phase `engine` from an agent node is not command time) |
| Launch, redaction | `t42_spec_from_resolved_profile`; `t42_prompt_content_and_single_argv_element`; `t42_prompt_over_cap_fails_before_record`; `t42_child_env_is_allow_list` (real); `t42_secret_never_reaches_kodel_sinks` (journal, state, output, reason, answer, report, `agent logs`, `agent ls`, holder log files, record argv); `t42_checks_see_redacted_output`; `t42_short_or_path_env_value_not_redacted` (documented gap) |
| Second client | `t42_engine_child_is_not_a_second_kodel_client` (real: macOS `ps -o pgid=`, Linux `/proc/self/stat` fields after the last `)`); `t42_ps_failure_fails_open`; `t42_cli_origin_session_keeps_tools` |
| Shipped artifact | `scripts/check-artifact.mjs` runs one engine step from `dist/kodel.js` on Node with a Node-script engine (POSIX) |
| Contract | `t42_error_codes_unchanged`; `t42_contract_snapshot` (version 5) |

Real tests are a tagged slow group with timeouts and **no retries** (a retry hides a double start), run in the macOS and Linux CI jobs, skipped on Windows with an asserted reason. Refusal tables have a negative control and assert byte-identical journal and state. Docs (`docs/engines.md`, `pipeline_docs` text, run-formats note) are checked by review.

**Done.** Every row passes on main with the flag off; then, after D-B and D-C, the flag is turned on and one real run is recorded in the PR (manual: `kodel agent ls` shows `ke-<run>-...`; kill the MCP server mid-step, a new one joins; `kodel mcp` in the child serves no tools).

**Refutation** (T-42). A path starts a session while an open record of the run is not proven or cleared by a person (except the stale-lock residual); a path goes past an unknown without a person's resume; a step closes without exit 0 and a valid result; a host path calls `remove`; a run without engine nodes changes its bytes; a literal env value of 12+ chars reaches a kodel sink; an engine child serves tools (unless `ps` and `/proc` both fail); a build with the flag off, a human command or a host without `engineSteps` calls `start()`.

---

## Steps

0. The person writes T-42. Comment on TASK-WKJ4 (Step 1 here, PR 2 superseded). Follow-ups created: "Engine steps in forks, joins, result checks and outcomes", "Free finished `ke-` records".
1. **WKJ4 PR 1**: `engines:` schema and `model`; the refusal of an engine node on every write path; "upgrade kodel" for a hash-matched kept copy with an unknown key.
2. **Golden**: capture `t42_existing_runs_decide_the_same` on main, pin its hash; merge before Step 4.
3. **Testkit**: fake resolver, fault-injecting fake session adapter (throws on `remove`), pausable fake lock/clock, Node-script engine.
4. **Core** (`pipeline-core`): `EngineLaunch`/`EngineResolver`, `Begin` `needs: "session"`, validation refusals, outcome table, `engineSession` with codec rows, `engine_session_started`, `engine_start_pending`, `run_engine_step { start | join }`, unknown path, accept refusals, resume clearing, `lastFailure.source "session"`. Same step: `fixtures/formats/v2-engine/` (taken with the real `PipesSessionAdapter`/holder through `LocalPipelineHost`, a Node-script engine, `engineSteps` injected), round-trip test, `t41_*` rows, `fixtures/formats/README.md` line, `docs/run-formats.md` note.
5. **Host** (`local`): `runEngineStep` in `spawn()` (lock rule, no-id lookup, wait, zod), per-start adapter with redaction and 5 s boot, `engineBusy` skip, refusals, detach, resume lookup, report readers. `session-pipes.ts` gets only a constructor-injected test hook, inert by default.
6. **Guard**: `kodel mcp` serves no tools in a live host session's process group.
7. **Surfaces and docs**: `next-step.ts`, `format.ts`, `elicit.ts`, `tui/`, `pipeline_docs`; `docs/engines.md`, `docs/session-formats.md`; the `check-artifact.mjs` leg; the CLI flag `KODEL_ENGINE_STEPS` (off): `kodel mcp` sets `engineSteps { start: true }`, human commands `{ start: false }`, not with `KODEL_STATE_DIR`.
8. After D-B and D-C are on main: turn the flag on, add `engines:` to AGENTS.md's person-only list, record the real run.

## Affected files

- `packages/pipeline-core/src/`: new `engine-launch.ts`; `run.ts`, `registry.ts`, `pipeline.ts`, `pipeline-diff.ts`, `formats/{types,v1,v2}.ts`, `service.ts`, `next-step.ts`, `index.ts`.
- `packages/local/src/`: `host.ts`, `pipeline-host.ts`, `history/claude-code/report.ts`, `session-pipes.ts` (test hook only).
- `packages/cli/src/`: `mcp-server.ts`, `main.ts`, `cli.ts`, `agent-commands.ts`, `elicit.ts`, `format.ts`, `tui/`.
- `packages/testkit/src/`; tests in `packages/*/test`; `fixtures/formats/v2-engine/`, `fixtures/formats/README.md`; `scripts/check-artifact.mjs`; `docs/run-formats.md`, `docs/engines.md`, `docs/session-formats.md`; `AGENTS.md` (Step 8).
- Not changed: `.mcp.json`, `.claude/settings*.json`, `.kodel/pipelines/`, config keys, `version.ts`, `ERROR_CODES`, `Pause.reason`, `session.ts`, `session-holder.ts`, `sessions/records.ts`, `redact.ts`, `kodel hook`.

## Rejected review findings

- Split into NNR3a/b/c (and Q3): the person ordered one task; only the turn-on waits, as a flag.
- `place` and `confirmSession`: one open record per run and the person's resume as the confirmation keep never-twice; lost is only that a person can clear a record of another checkout without typing its id (the warning names it).
- `prove` mode: no longer needed, since no new start happens while a record is open.
- Pinning the profile in the snapshot (M4): a residual; the `launch` hash shows a change.
- A run format 3: no published build wrote format 2.
- The id written before `start()`: the adapter chooses it inside `start()`.
- A filtered `list({name})`: it skips unreadable records.
- A field on `node_finished` for unknown: the reason prefix tells it.
- Crash window 2 with a dead issuer pid as quiet (n4): pid reuse makes it unsafe; it stays unknown.
- A hook pre-filter and a zod-free record reader for the guard: the process-group check suffices.

## Findings in the code

- `main` at 2aeae3a, no release tag; `engines:` not in the schema yet. `Begin` has `agent | engine | human` (`registry.ts:51`); a human-entered engine visit sets `heartbeatAt` with no owner (`run.ts:1141`), so today it would wait `DEFAULT_STALE_MS` and cost a restart.
- `afterDecision` waits up to `WORK_WAIT_MS` 30 min (`cli.ts:95`, `:357`) while `engineBusy` sees phase `engine` (`host.ts:2433`).
- Effects are dispatched after the save (`host.ts:2121`); a lost result save is retried (`host.ts:2178`).
- D-B not built (`mcp-server.ts:90`); `KODEL_ENGINE` read only by `requireHuman` (`cli.ts:307`); `CONTRACT_VERSION` 5 (`mcp/tools.ts:18`).

## Implementation notes (impl step)

Where the code and the plan differ, the code was followed; what is not done is listed.

- Validation is stricter than planned: a step with `engine` is refused in any pipeline with a fork or a
  join (not only inside a branch). Only one session visit can then be active, which keeps "one open record
  per run" trivially true.
- The host runs the waiting for a session in a job of its own; a takeover goes through a new input
  `engine_session_joined` (counts `takeovers`, past `MAX_TAKEOVERS` the outcome is unknown). The visit's
  `owner` is the issuing/joining host; `EngineOptions.engineSteps` gained an optional `owner` the host fills.
- `run_resumed` carries `session` when a resume cleared an open record. The resume's lookup lives in
  `LocalRun.resume`; its warning is printed by `kodel resume`.
- The no-id join writes `engine_session_started` with `launch: "unknown"` (the joiner did not build the launch).
- `KODEL_ENGINE_STEPS` is a build constant (`packages/cli/src/engine-steps.ts`), off.
- Golden (Step 2): not captured on `main` with a pinned hash; `t42_existing_runs_decide_the_same` replays a
  scripted run (consecutive pause, resume, accept, ticks) with and without `engineSteps` and compares bytes.
  The t41/format loops over every fixture directory also pass unchanged.
- The `check-artifact.mjs` leg asserts the refusal of an engine pipeline by the built file (the flag is
  off, so no engine step can run there); the one-engine-step leg waits for the flag.
- Not written (rows of the test table): `t42_window4_real_adapter`, `t42_gate_returns_without_waiting`,
  `t42_status_report_wait_never_spawn`, `t42_session_timeout_fails` (real), `t42_shutdown_and_cancel_detach`,
  `t42_every_source_consumer_has_session_row`, `t42_checks_see_redacted_output`, `t42_contract_snapshot`,
  `t42_error_codes_unchanged` (no code or contract was changed), and the full write-path tables of
  `t42_unknown_pause_holds` / `t42_engine_field_refused_before_any_write` at the host level (they exist at
  the core level). Surfaces (`next-step.ts`, `format.ts`, `elicit.ts`, `tui/`) were not changed: a session
  visit already reads as engine work (`running`), and an unknown outcome as a `consecutive` pause whose
  reason carries the fixed prefix.

### Second pass (the missing rows)

Added since the list above: the host-level write-path tables (`t42_engine_field_refused_before_any_write`,
`t42_unknown_pause_holds`, `t42_proposals_apply_refused_before_write`, in
`packages/testkit/test/engine-write-paths.test.ts`), `t42_window4_real_adapter`, `t42_crash_window6_result_save_lost`,
`t42_session_timeout_fails`, `t42_gate_returns_without_waiting`, `t42_status_report_wait_never_spawn`,
`t42_shutdown_and_cancel_detach`, `t42_checks_see_redacted_output`, `t42_every_source_consumer_has_session_row`,
`t42_contract_snapshot`, `t42_error_codes_unchanged`, and the CLI-level `kodel mcp` guard tests
(`packages/cli/test/engine-mcp-guard.test.ts`). Two write paths wrote before they refused on a host that does
not run engine steps (`proposeChange`, `discardProposal`); both now refuse first.

Still open, and why:
- In `t42_unknown_pause_holds` some paths write a note while the pause holds: `propose`, `feedback`, `ack`,
  `take_step`/`next_step` (the agent-log bookkeeping), `report_result` (journaled as `call_refused`) and
  `pipeline changes discard` (drops the proposal the `propose` row left). Their rows assert zero starts, the
  record and the pauses unchanged and no `run_resumed`, not byte-identical files. `cancel` is left out of that
  table (it ends the run by design; `t42_shutdown_and_cancel_detach` covers it).
- `total` on resume after an unknown outcome is not reached by a test: `resume` itself tops up the attempts
  of a node at its limit, so a resumed engine step never meets `total` there.
- `t42_frozen_issuer_after_joiner_unknown_spawns_nothing` uses a held resolver (before the lock) rather than a
  pausable fake of the file lock: the store's lock is not injectable, and a lock broken as stale is the
  stated residual.
- The two real CLI guard tests skip where no process group can be read (this sandbox blocks `ps`); they ran
  outside it once: the control passed, and the inside test printed nothing, which fits the server with no tools
  (`serveNoTools` offers no tools capability, so the client's `listTools` was refused). The client now reads
  the capability first. That diagnosis is inferred from the code, and the fixed test did not run outside the
  sandbox again (a second run there was not permitted); CI must set `KODEL_REQUIRE_PROCTABLE=1`.
- The `check-artifact.mjs` leg was checked by reading only (no build): `pipeline_start` goes through the
  service's `guarded`, so the refusal comes back as `{ ok: false, code: "PIPELINE_INVALID" }` with no `run_id`,
  and `LocalHost.start` refuses before the start lock, so no run folder is made.

### Review fixes (impl attempt 2)

- `KODEL_STATE_DIR`: with it set, the CLI builds no host with engine steps (`engineHostOptions` returns
  nothing), so every session of an engine step lives under the default base, which is where the guard of a
  `kodel mcp` in the child (it gets no `KODEL_*` variable) looks. Test `t42_cli_no_engine_steps_with_state_dir`.
- The decisions an engine step writes under the lock (the id, a failed or unknown start, a no-id join) now go
  through the end-of-decision steps of `apply` (`startEndJob`, `tieEnd`). No test ends a run that way: none
  of those decisions can end a run today (a failed attempt of an agent node is reworked or paused, an
  unknown one pauses), so the call is there for the day one can.
- A state that cannot be read under the lock is read twice more, then the start is left to this process's
  next tick (`retryStarts`), never classified as unknown by its own issuer. `engineBusy` without the pipeline
  tells a session visit by its missing heartbeat, so a person's command never waits on it.
- Shutdown and cancel name the sessions: `LocalRun.sessionsNote()` (the MCP server writes it on stderr when it
  leaves) and `cancel()`'s `warning`.
- The fixture holds a third run with an unknown outcome and a person's resume (`source: session`,
  `run_resumed.session`). `Visit.takeovers` is not in any stored file: it lives on the visit, which the
  unknown outcome ends, and `engine_session_joined` is not journaled. The open run of the fixture is let go
  on (joined by id, finished) in `t42_v2_engine_open_run_goes_on_in_its_format`.
- `t42_secret_never_reaches_kodel_sinks_real` covers the session's own files (the record's argv, the
  holder's tails), which are what `kodel agent ls` and `kodel agent logs` print; the commands themselves are
  not run in that test. The run keeps the task text as the person typed it (redacted by the project's rules
  before any profile is read), so the value is checked in what the run records of the step, not in the task.
- In `t42_unknown_pause_holds` the paths that write a note are `propose`, `feedback`, `ack`, `report_result`
  and `take_step` (refused calls journaled as `call_refused`), and `pipeline changes discard` (drops the
  proposal). Every other path is byte-identical.
- CI: `KODEL_REQUIRE_PROCTABLE=1` is set for the `bun test` step on macOS and Linux (`.github/workflows/ci.yml`).

### Impl attempt 3

- Golden (Step 2) captured on the base commit `2aeae3a`: `fixtures/golden/existing-runs/` (5 scenarios of
  `packages/pipeline-core/test/golden-scenarios.ts`, written from a temporary checkout of that commit),
  sha256 of the directory pinned in `t42_golden_is_pinned`. `t42_existing_runs_decide_the_same` replays them
  on this build without engine steps, with the MCP host's and with a person's options: no byte differed.
- `READ_ERROR_OUTCOME` was removed (every read error is unknown; one comment says so).
- `kodel mcp` waiting (`wait_s`) on a session another process owns now watches the state for the wait;
  a person's command still never waits on a session.
- A person's resume whose lookup does not find the session warns (it may be another checkout or state base)
  instead of taking it as ended; the dialog shows that warning. A cancel names a session only when it has an
  id. With `KODEL_STATE_DIR` set the start refusal says why.
- Not done: no test of the dialog's resume text (the dialog only passes `warning` on); finding 9 (real
  SIGKILL) and the artifact leg stay as noted.

### Impl attempt 4

- A profile may not set or pass `HOME` or `USERPROFILE` (config validation and again at the launch). Under a
  holder (`KODEL_ENGINE=1`) the guard of `kodel mcp` also looks in the account's own base
  (`os.userInfo().homedir`); the variable only widens where it looks, the process group still decides.
- New input `engine_start_abandoned`: an issuer that finds, under the lock, that its attempt is no longer to
  be started (and never called `start()`) removes its record (state only, nothing journaled).
- A person's resume on a host that cannot look sessions up is refused (fail closed).
- A failed engine step keeps what it printed (redacted, the end of both streams) and its reason carries the
  last 1000 characters.
- `pipeline changes restore` is refused first on a host that does not run engine steps.
- The real guard tests still skip in this sandbox (`ps` is blocked); CI sets `KODEL_REQUIRE_PROCTABLE=1`.

### Impl attempt 6

- Literal redaction now covers values with `/` (base64 tokens) and their JSON form with `\/`; only shorter
  values and existing paths of this machine (a path start, plain-word segments, there on disk) stay visible.
- The guard tests inject the child's home instead of passing `HOME` in an environment it does not read; the
  CLI tests run the client in a process group of its own and look in empty bases.
- The server's shutdown note names only sessions with an id.
- Real test of the child's environment: `t42_child_env_is_allow_list_real`.
- Residual, not fixed: a session whose holder has not yet recorded its child is not seen by the guard
  (see docs/engines.md); treating every starting session as inside would take the tools from every
  `kodel mcp` of the person meanwhile.
- `newerKeptCopy` applies to kept copies only, not to text being introduced.

### Impl attempt 7

- `t42_short_or_path_env_value_not_redacted` failed in the full run only: its "real path" lived under
  `os.tmpdir()`, which is `/tmp/claude-501` in the sandbox but a `/var/folders/<random>/T/...` folder in the
  engine's run, and the built-in high-entropy rule hides such a path (checked: `redactText` of a
  `/var/folders/...` path gives `[REDACTED:high-entropy]`). The path side is now tested at unit level with
  the disk injected; the end-to-end leg checks only the secret side.

### Merge of origin/main (impl attempt 8)

- Main moved `kodel resume` into `gate-decision.ts` (`prepareResume`/`commitResume`, also used by the TUI):
  `DecisionRun.resume` and `commitResume` now carry the engine `warning`, which `kodel resume` prints and the
  TUI's decision message shows. `.kodel/pipelines/dev.yaml` is main's version (the run's own variant is not
  part of this task).
