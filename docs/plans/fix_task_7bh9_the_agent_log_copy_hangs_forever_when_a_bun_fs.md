# The copy of the agent's log can no longer hang: no lost `realpath`, a bound on one pass, a bound on the step-end wait (TASK-7BH9)

## TL;DR

- **What is done.** Two independent parts; either can be reverted alone.
  **A, the bound.** One pass of `AgentLogWriter.capture` is bounded at 60 s: past it the pass leaves `inFlight` and the run journals `agent_log_failed: stalled`. Its lock is not released; the existing 300 s takeover frees it. The end of a step waits 5 s at most for a pass in flight, then completes without a copy. `in_flight` and `busy` skips no longer reset the ticker's failure count.
  **B, the helper.** Every `realpath` from `node:fs/promises` in `packages/local/src` and `packages/testkit/src` goes through one helper on `realpathSync.native`; a scan keeps the async call out of `src`. B is the larger part and is not needed to stop the hang, only to stop it from happening every few minutes (decided 1b).
- **Cost.** Small to medium: about 70 lines in `agent-log.ts`, a few in `agent-log-ticker.ts`, `host.ts`, `pipeline-host.ts`, a 10-line helper, import changes in 7 files, one enum value in `pipeline-core`, doc paragraphs, 24 tests. One PR.
- **Risk.** Low. No stored-format change; no lock is let go early. Two things to know: after a stall nothing is copied until the lock is 300 s old (about 4 minutes) and step ends say `busy` meanwhile; and a sync `realpath` on a hung mount blocks the event loop (decision 1 below).
- **What the last critique changed.** One guard that 3b does need (a pass that lost its lock no longer declares `stored_copy_changed` on the shared memo); the start of the ticker is bounded too (`hasCandidates`); the step wait is its own 5 s, not `waitMs`; the writer can be stopped (no 60 s drain); eight more tests (wake-up points, a fresh stalled lock, a healthy slow pass, default wiring, a stall before the lock); the run-twice consequence of a blocked loop is named and put to the person.

## Decisions needed

1. **A sync `realpath` on a hung mount can make an engine command run twice.** New, found by the last critique. If one `realpath` blocks the event loop for more than 30 s (a mount of the project, a worktree, the agent's store or the home folder that hangs), this process sends no heartbeat; another kodel process ticking the same run then restarts the visit (`run.ts:2289-2298`) and the command may run a second time while the first still runs. The converted calls are reachable while engine work is owned (the ticker's passes; `host.ts:1234` on every `pipeline_next_step`). At the gate "another process may judge this one dead" was accepted; "a command may run twice" was not spelled out.
   (a) Accept it and say so in `docs/history.md`. It needs a hung mount, an engine step in flight and a second kodel process on the run at once, and in that state the command, which works in the same tree, is stuck as well.
   (b) A helper that never blocks: the async call raced against a 1 s timer and retried (a lost call succeeds on the retry; a hung mount ends in a rejection after three tries). Keeps the loop free; costs a timer per call, a second code path, and it still rests on the call that gets lost.
   **Recommended and default: (a).**

Decided by the person at the gate (recorded, not reopened): **1b** every async `realpath` in `packages/local/src` and `packages/testkit/src` through one sync-based helper, with a scan, equivalence tests and tests that pin the derived values; **2a** a step end waits 5 s for a pass in flight, then completes without a copy and says `busy`; **3b** a pass given up keeps its lock (no `release()`, no write section, no late-writer guards); **4a** one limit of 60 s.

No decision id applies; tests carry `task_7bh9_`.

## Behaviour change

- A pass that runs past 60 s (`PASS_LIMIT_MS`; the read budget stays 30 s) is given up: `capture` answers and the run journals `agent_log_failed` with `reason: "stalled"`. Like every reason it is journaled **once per run**: later stalls of the run leave no record of their own; the second sign is the ticker's `unreadable` after three in a row. `stalled` means "a pass was given up", also when the copy was saved and the count after it stalled. A run that does not copy has no place for it; there only `usage_failed: busy` tells.
- The lock of that pass stays. Until it is 300 s old (`AGENT_LOG_STALE_MS`, from when the pass took it) ticks are skipped as `busy` and each step end waits 5 s for the lock and says `busy`. Then the next tick takes the lock over and copies from the journal on. A pass that stalled before it had the lock (in `run.state()`) leaves none: the next tick starts a new pass at once, and each such pass takes 60 s to give up.
- The end of a step waits at most 5 s for a pass in flight (`STEP_IN_FLIGHT_WAIT_MS`), then is completed without a copy; usage and tool calls say `busy`. **This also hits a healthy pass**: a tick pass may read for 30 s (the first after a resume, say), and a step that ends more than 5 s before it does gets `busy` with no fault anywhere. The next pass reads what was skipped; at the **last step of a run** nothing comes after, so that step's usage, tool calls and the tail of its log are missing and the report says "ended in the middle of a step".
- Bounds of the copy inside `pipeline_complete_step`: 5 s when a pass is in flight; 5 s when a stalled pass's lock is held; when the step's own pass stalls, 5 s (a pass in flight that then ended) + 60 s (the limit; the wait for the lock is inside it) + 2 s (the `stalled` record) = 67 s, past the 60 s at which some clients give up (decided 4a).
- **Still unbounded in `completeStep`:** the queue of `apply` (`store.ts:1312-1324`), `pendingChange`, `workerModels`, `executorNow`, `readHead`, `recordHandIn`. The claim is "never hangs on the copy or on a lost `realpath`"; nothing tests `completeStep` as a whole. Other async fs calls (`stat`, `open`, `readFile`, `readdir`, `readlink`) can in principle be lost as well: on the copy's path the bound catches them, elsewhere nothing does.
- `usage_failed: busy` and `tool_calls_failed: busy` now also mean "the count may have started and the pass was given up" and "a pass was in flight for more than 5 s". A count given up still holds its lock and may end later: the journal then has `busy` and `usage_recorded` for one step, or `usage_failed: record_refused` if the step was judged meanwhile (`usage.ts:882-885`; the cursor did not move). Display only; no usage is lost.
- The ticker: a stalled pass counts as a failed tick; `busy` (whoever holds the lock, another process included) and `in_flight` neither count nor reset. The minutes of `busy` after a stall do not stop the timer, a good pass resets the count, three stalled passes with no good one between stop the timer with `unreadable`; step ends go on copying. Starting the timer no longer waits without limit for the hook index (`hasCandidates`, 2 s; a later call tries again).
- Path resolution in `packages/local` is synchronous. Results are the same; errors keep their `code`.
- A server that was started before the update keeps the old behaviour until it is restarted.

## Risks and invariants

- **Principles 1, 2, 6, 7.** Unchanged: the copy is display data and never decides a step.
- **Principle 3 (redact).** No new write path; `stalled` is a constant, the event carries no text and no session id.
- **Principle 4.** `pipeline-core` gets one string in `AGENT_LOG_FAILURES`. `AgentLogFailure` is an exported union: a server with an exhaustive `switch` over it gets a compile error to fix; an older `pipeline-core` treats the reason as unknown.
- **Principle 5.** The timers of the limit, of the step wait and of `hasCandidates` are injected (`timers` option of the writer), so tests fire them by hand. They are real timers, not the injected clock, like the ticker's; ref'd, cleared when the work wins, and cleared by the new `AgentLogWriter.stop()` that `LocalPipelineHost.stop()` calls, so a process that is closing does not stay up for them.
- **Principle 8, stored data.** No format change: the codecs know journal events by name only (`formats/v1.ts:161`), `agentLog` is opaque (`v1.ts:151`), `agent_log_failed` keeps its keys. Rule 5: an engine that ignores the value decides every step the same; an older engine reads it as a string and its machine refuses to journal a reason it does not know (`run.ts:2595`, existing `t3bk2_failed_event_once_per_reason`). That an older build prints it is a review claim, not a test. No `v` bump, codec, fixture or `t41_*` change.
- **The journal is only appended to; a stream is vouched for by the journal.** A pass given up keeps its lock; if it wakes it goes on as the slow pass it is. A pass that never wakes (a lost call) leaks its closure for the life of the process and its lock file until the takeover: one per stall.
  - *It wakes while the lock is its own.* Nobody else got past `withAgentLogLock`, so it writes alone and `lockedRun` removes the lock when it returns.
  - *It wakes after the takeover.* Then two passes of one run are alive in one process, which was not possible before. What stops the late one, by wake-up point: `stillHeld()` is false before the name (406), before the append (602) and before `agent_log_saved` (614); `also` is not entered (272); the count asks before each record (`usage.ts:870,891`, `tool-calls.ts:684`); an `agent_log_saved` already in flight is refused by the machine, because its `stream_from` is no longer the stored length (`run.ts:2502`); a late `agent_log_failed` may land (`fail()` does not ask): one reason, once, display only.
  - *Shared memory.* The late pass shares `memos`, `collectors` and the memos of `UsageWriter` and `ToolCallsWriter` with the newer pass. A checkpoint it puts back or clears is used only if it matches the journal and the source tail (`agent-log.ts:458-465`, `usage.ts:692-697`), so it costs a re-read at most; `collectors.clear()` drops a cache, and a collector in use keeps working. Sticky stops are set from what the late pass read itself against its own snapshot of an append-only log (`log_changed`, `usage.ts:781`), so the newer pass cannot cause them, with one exception: `stored_copy_changed` (`agent-log.ts:608-613`) is concluded from the stored file, which the newer pass has just extended. **The one guard 3b needs:** before that conclusion the pass asks `stillHeld()` and aborts if the lock is not its own. (Right for two processes as well.)
  - *What stays as today.* A write that is past its check when the lock is taken over (an `appendAgentLog` held between its tail check and its `truncate`, a count between its two records) completes; the next pass then finds `stored_copy_changed` and the stream stops. Two processes have this window today; it still needs a call that resumes after its lock is 300 s old, but one process can now reach it.
- **A slow, healthy pass** cut by the limit keeps its lock and finishes; only one `stalled` record and one ticker count are wrong for it.
- **`realpath` results decide where history is.** `integrity.ts:48-60` gives the key of the hash folder, `project-locate.ts` the project root, `worktree.ts` the run's workdir. The claim is not "the same libc call" (not true in every runtime) but "the two forms agree in the runtime that runs them on every shape tested" (criterion 1), with the derived key and root pinned (criteria 3, 4). The tests run under Bun; for Node the equivalence rests on libuv, where both forms are `uv_fs_realpath`, and is not run in CI. `storage-paths.ts:293,311` only compares; the home folder comes from `project_id`.
- **Sync `realpath` blocks the event loop** for the length of the call: decision 1. Windows and Bun on Windows are not in CI; `realpathSync.native` exists there.
- **Refutation.** Tests cannot show a lost call. Refuted by: the manual script reporting `HANG` with the helper in at least 5 million calls; or a run whose journal has `stalled`, or no `agent_log_failed` at all, and no `agent_log_saved` for more than 6 minutes while `step_served` records go on. When the helper can go: no upstream Bun report is known to this plan; filing one is a follow-up, and the helper's comment names Bun 1.3.5 so that the script can be rerun on a later Bun.

## Acceptance criteria and tests

| # | Criterion | Test |
|---|---|---|
| 1 | `realPath` gives what `fs.promises.realpath` gives in the same runtime for: a symlink to a directory and to a file, a trailing slash, `.` and `..` segments, a relative path, the empty string; on macOS also `/private`, `/tmp`, `/var` and a case variant. Both reject with the same `code` for a missing path, a path through a file, a dangling symlink, a symlink loop and (not as root) an unreadable directory | `task_7bh9_real_path_matches_async_realpath`, `task_7bh9_real_path_rejects_with_the_same_code` |
| 2 | No `.ts` under `packages/local/src`, `packages/testkit/src`, `packages/cli/src` has an identifier or property name `realpath` (read from the syntax tree with the `typescript` package, so comments and strings do not count and every import form, `fs.promises.realpath`, a renamed import and the callback form do; `real-path.ts` is not excluded). The scanner is tested on samples of each form | `task_7bh9_no_async_realpath_in_src`, `task_7bh9_scan_finds_every_form` |
| 3 | The key of the hash folder is `sha256(await fs.promises.realpath(<root>/.kodel))[0..16]` for a root reached through a symlink and before `.kodel` exists | `task_7bh9_integrity_key_unchanged` (beside `storage-integrity.test.ts:214`) |
| 4 | `locateProject` and `canonicalRoot` give the root `fs.promises.realpath` gives (symlinked cwd, linked worktree, case variant on macOS); `ensurePlace` still refuses a link that leaves the base. Reached by existing tests: `host.ts:1234` by the manual-edit cases of `changes.test.ts`, `worktree.ts:217` and its `ENOENT` branch by `worktree.test.ts:498-503`, the testkit collector by `packages/testkit/test/agent-history.test.ts` | `task_7bh9_located_root_unchanged`, `task_7bh9_place_link_check_unchanged`; one case with a symlinked project root added to `agent-history.test.ts` if none reaches lines 153-154 |
| 5 | A pass whose read never settles: when the limit fires, `capture` answers `errored`, `failures: ["stalled"]`, `busy()` is false, the lock is there with the pass's token | `task_7bh9_stalled_pass_is_given_up_and_keeps_its_lock` |
| 6 | While that lock is fresh a tick is `busy` and journals nothing; past `agentLogStaleMs` the next tick takes the lock over and copies | `task_7bh9_copy_resumes_after_the_takeover` |
| 7 | A pass that hangs in `run.state()` before the lock: the limit fires, no lock file exists, the next tick copies at once | `task_7bh9_stall_before_the_lock_leaves_no_lock` |
| 8 | Two stalled passes of a real run (the real state machine) leave one `agent_log_failed: stalled` | `task_7bh9_stalled_is_journaled_once` |
| 9 | A pass given up and let go while the lock is its own finishes: file and journal agree, the lock is removed, the next pass stores nothing twice | `task_7bh9_late_pass_with_its_lock_finishes` |
| 10 | A pass given up, a takeover, a newer copy, then the late pass is let go, for each hang point: in the read; in `run.state()` at the top of `copy`; in `appendAgentLog` before its tail check on a stream with a vouched part; in the `apply` of `agent_log_saved`; in the `apply` of `fail()`. Each time: no further `agent_log_saved`, the stored stream and the newer lock untouched, no `stored_copy_changed`, and a third pass copies new events and stores nothing twice (a stale checkpoint costs it a re-read only) | `task_7bh9_late_pass_after_takeover_writes_nothing` (one case per point) |
| 11 | A step pass given up in its count, a takeover, a newer step pass that counts, then the late one is let go: no further `usage_recorded` or tool-call record, and the next pass still counts (no sticky stop) | `task_7bh9_late_count_after_takeover_records_nothing` |
| 12 | A pass under the limit is not given up and leaves no live timer; the timer of the step wait is cleared when the pass ends first; `writer.stop()` clears a live limit timer and `host.stop()` calls it | `task_7bh9_healthy_pass_does_not_stall`, `task_7bh9_stop_clears_the_pass_timer` |
| 13 | Defaults: a writer built as `host.ts:632` and `pipeline-host.ts:221` build it has `passLimitMs === 60_000` and the system timers; `0` or a negative option means the default; one case with the system timers and `passLimitMs: 30` gives a pass up | `task_7bh9_defaults_are_wired` |
| 14 | A tick pass hangs; `completeStep` returns when the step wait fires and not before, the step is judged, `usage_failed` and `tool_calls_failed` say `busy` once each | `task_7bh9_step_end_does_not_wait_past_its_limit` |
| 15 | A healthy tick pass ends inside the step wait: the step end copies and counts as before. One that ends after it: `busy`, and the next step end counts what was skipped | `task_7bh9_step_end_behind_a_slow_healthy_pass` |
| 16 | After a give-up, with the stalled lock still fresh and nothing in flight: `completeStep` waits the lock wait and says `busy`, the step is judged | `task_7bh9_step_end_while_stalled_lock_is_fresh_says_busy` |
| 17 | The count of a step's own pass hangs: `completeStep` returns only when the limit and then the wait for the `stalled` record have fired (each leg of the 67 s sum by a hand-fired timer); `stalled` once, `busy` once each although the count had started | `task_7bh9_counted_then_stalled_tells_busy` |
| 18 | `errored`, `busy` x 5, `errored`, `in_flight`, `errored` stops the timer; `errored`, `busy`, a good tick, `errored`, `errored` does not; twenty `busy` do not | `task_7bh9_skips_do_not_reset_the_failure_count` |
| 19 | Real writer, hanging collector, three rounds of limit fired and lock gone stale (the lock's token differs each round): the timer is stopped, `unreadable` is journaled, a step end with a healthy collector then copies | `task_7bh9_ticker_stops_after_three_stalled_passes_and_steps_still_copy` |
| 20 | `hasCandidates` that never settles: `ensure` returns when its timer fires, no timer is started, `lastRefusal` is `no_candidates`, a later `ensure` starts one | `task_7bh9_ensure_does_not_get_stuck_on_candidates` |
| 21 | The machine journals `stalled` once; the report lists it; `docs/history.md` names it | `task_7bh9_stalled_reason_is_known_to_the_machine`; existing `t3bk2_docs_text` group; one more entry in the reason loop at `packages/cli/test/format.test.ts:276` |
| 22 | Existing suites stay green with no existing assertion weakened, in particular `t3bk2_tick_in_flight_skips` (its comment at line 384 is reworded: the step end waits for the pass because it ends inside the wait), `t3bk2_tick_busy_lock_skips`, `t9jrs_lock_busy_...` and the other step-end cases of `usage.test.ts`, `t41_*` | `bun test`, `typecheck`, `lint`, `build` + `check-artifact` |

What the tests cannot show: a lost call (it is a matter of chance; the manual run says "not refuted", never "proven"); other fs calls being lost; the event loop being blocked; a write that is past its check at the takeover; a `realpath` reached by a computed name or a dynamic import; a client that waits more than 60 s; an older build printing `stalled`; Node, Linux case rules and Windows for criterion 1 beyond what CI runs. `scripts/take-v2-*.mjs` keep the async call (one-off scripts, outside the scan).

Manual check (Bun 1.3.5, macOS; at least 5 million calls; covers `realpath` only): must end with `done calls=N` and no `HANG` line.

```ts
import { appendFileSync } from "node:fs";
import { realPath } from "./packages/local/src/real-path";
const OUT = process.argv[3]!; const secs = Number(process.argv[2]);
const log = (s: string) => appendFileSync(OUT, `${new Date().toISOString()} ${s}\n`);
const until = Date.now() + secs * 1000; let n = 0;
const race = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p.then(() => "ok"), new Promise<string>((r) => setTimeout(() => r("HANG"), ms))]);
while (Date.now() < until) {
  n++;
  if ((await race(realPath(process.cwd()), 10_000)) === "HANG") { log(`HANG at call ${n}`); break; }
  if (n % 500 === 0) await new Promise((r) => setTimeout(r, 1));
}
log(`done calls=${n}`); process.exit(0);
```

(With `fs.promises.realpath`: one call lost after 162k to 2.8M calls under Bun 1.3.5; none in 5.7M under Node 22.22.)

---

## Steps

Part B (the helper):

1. New `packages/local/src/real-path.ts`: `export async function realPath(path: string): Promise<string> { return realpathSync.native(path); }`, with one comment on why (Bun 1.3.5 loses the promise form of this call, TASK-7BH9). Being `async`, a throw is a rejection with the same `code`. Exported from the package index for the testkit.
2. Import swap, no logic change: `history/scope.ts:6,23`; `project-locate.ts:11,58-60`; `worktree.ts:12` and lines 65, 76, 90, 129, 130, 132, 134, 147, 182, 217; `host.ts:11,1234`; `storage-paths.ts:9,293,311`; `integrity.ts:8,54`; `packages/testkit/src/fake-agent-history.ts:8,153,154`. Tests keep their own async `realpath`. If B is ever split off, `host.ts:1234` goes with A (it is inside `completeStep`).

Part A (the bound):

3. **The limit.** `agent-log.ts`: options `passLimitMs` (default and fallback for a value that is not positive: `PASS_LIMIT_MS = 60_000`, exported, readable on the writer) and `timers` (system `setTimeout`/`clearTimeout` by default). The wait for the `stalled` record and for `hasCandidates` is a constant, `GIVE_UP_WAIT_MS = 2_000`, not an option. `capture` races the work against the timer and clears it when the work wins. When the timer wins: delete the `inFlight` entry if it is this work; `.catch(() => undefined)` on the work; `run.apply({ type: "agent_log_failed", reason: "stalled" })` raced against `GIVE_UP_WAIT_MS`, errors swallowed; answer a fresh `{ saved: 0, streams: [], failures: ["stalled"], errored: true }`. The lock is not touched. `stop()` clears every live timer of the writer; `LocalPipelineHost.stop()` (`pipeline-host.ts:806-811`) calls it.
4. **The one guard.** `agent-log.ts:608-613`: when `appendAgentLog` answers `ok: false`, ask `lock.stillHeld()` first and return `"abort"` if it is false; only a holder concludes `stored_copy_changed`.
5. **The wait at the end of a step.** `idle(runId, limitMs)` waits for the pass in flight or the limit (through `timers`; cleared when the pass ends first) and says whether one is still in flight. `capture` with `why: "step"` calls it with the writer's `stepWaitMs` (default `STEP_IN_FLIGHT_WAIT_MS = 5_000`), a number of its own: `input.waitMs` stays the wait for the lock only, so the tests that pass `waitMs: 0` or a 200 ms lock wait (`agent-log.test.ts:156`, `usage.test.ts:153`) behave as before. Still in flight means `skipped: "in_flight"`, which the host already tells as `busy` (`host.ts:3563-3574`). The comment at `agent-log.ts:234` is rewritten.
6. **The host.** `host.ts` `completeStep`: tell `busy` also when the pass came back with `failures` containing `stalled` (`if (!counted || stalled)`).
7. **The ticker.** `agent-log-ticker.ts` `tick`: `in_flight` and `busy` leave `entry.failures` as it is; a pass that ran still resets it. `AgentLogWriter.hasCandidates()` races the finder against `GIVE_UP_WAIT_MS` and answers `false` on the limit, so `ensure` (60-88) always leaves `starting`. Header comment updated.
8. **The reason.** `pipeline-core/src/run.ts`: `"stalled"` in `AGENT_LOG_FAILURES`.
9. **Docs.** `docs/history.md`, the agent-log section: `stalled` in the list at line 441, and a paragraph that says: the 60 s limit; once per run; the lock is kept and the copy comes back when it is 300 s old; a stall before the lock; the 5 s wait of a step end, that it also applies behind a healthy slow pass, and that `busy` at the last step of a run means that step's usage, tool calls and log tail are missing; `busy` after a stalled count; the ticker does not count `busy` from any holder; other async fs calls can be lost and only the copy is bounded; a blocked loop on a hung mount and what follows (decision 1a); a server started before the update needs a restart.
10. **Tests**, then `bun run typecheck && bun run lint && bun test && bun run build && node scripts/check-artifact.mjs`.

Test means: a manual `timers` fake for the writer (like `manualTimers`, `agent-log-ticker.test.ts:71`); a store with an injected `clock`, `sleep` and a small `agentLogStaleMs`; gates: a collector whose `read` waits (`heldRig`, line 336), an `AgentLogRun` wrapper whose `state()` or `apply()` of a named event waits, a `FileStore` subclass whose `appendAgentLog` waits before `super`, a host whose `usage.capture` waits, a finder whose index read waits. No test depends on the speed of a 2-CPU runner except the one real-timer case of criterion 13, which has a 30 ms limit and waits for the answer, not for a time.
Files: `packages/local/test/real-path.test.ts` (new; 1, 2), `storage-integrity.test.ts` (3), `project-root.test.ts`, `storage-paths.test.ts`, `packages/testkit/test/agent-history.test.ts` (4), `agent-log.test.ts` (5-13), `agent-log-ticker.test.ts` (14-16, 18-20), `usage.test.ts` (11, 17), `packages/pipeline-core/test/agent-log.test.ts`, `packages/cli/test/format.test.ts` (21).

## Affected files

- `packages/local/src/real-path.ts` (new), `packages/local/src/index.ts`
- `packages/local/src/history/scope.ts`, `project-locate.ts`, `worktree.ts`, `host.ts`, `storage-paths.ts`, `integrity.ts`; `packages/testkit/src/fake-agent-history.ts`
- `packages/local/src/agent-log.ts`, `agent-log-ticker.ts`, `pipeline-host.ts`
- `packages/pipeline-core/src/run.ts`
- `docs/history.md`
- Tests: `packages/local/test/real-path.test.ts` (new), `agent-log.test.ts`, `agent-log-ticker.test.ts`, `usage.test.ts`, `storage-integrity.test.ts`, `project-root.test.ts`, `storage-paths.test.ts`, `packages/testkit/test/agent-history.test.ts`, `packages/pipeline-core/test/agent-log.test.ts`, `packages/cli/test/format.test.ts`

Not touched: `store.ts`, `usage.ts`, `tool-calls.ts`, `packages/pipeline-core/src/formats/*`, `fixtures/`, `docs/run-formats.md`, `scripts/`, `.kodel/`, `.mcp.json`, the MCP contract, the config schema.

## Rejected review findings

Earlier reviews (short): the write section, `release()` and the guards of every late write went with decision 3b; a step-specific limit with 4a; "`realOrSelf` only" and "two PRs" with 1b; a test of an older engine reading `stalled` and a note in `docs/run-formats.md` are not built (no old build as a fixture; no format changes).

Last critique:

- **"Keep the sync helper off the paths reachable while engine work is owned."** Not possible to draw: the ticker's passes and `pendingChange` run during engine steps and are the paths the task is about. Put to the person as decision 1 instead.
- **"A Node run of the equivalence tests in `check-artifact`."** Not added: the helper is not reachable from the artifact's surface that the script drives, and a second test runner is out of proportion; the libuv argument is stated under Risks.
- **"A second signal for later stalls (stderr, a count)."** Not added: the journal's once-per-reason rule is the machine's (`run.ts:2595`), and the ticker's `unreadable` after three is the second sign; the refutation is now worded so that the journal can check it.
- **"Biome `noRestrictedImports` instead of the scan, or drop it; it covers `cli/src`, which is not edited."** Kept as a test: the lint rule sees imports only, not `fs.promises.realpath`; reading the syntax tree removes the fragility; `cli/src` is covered so that the call does not come back there.
- **"`giveUpWaitMs` is one option too many."** Agreed in part: it is a constant now, not an option; the 2 s stay, because the `stalled` record must not be able to hang the answer.
- **"Criterion 19 (the ticker end to end) overlaps 6, 8, 18."** Kept: it is the only one that joins the ticker's count to the real writer and the takeover.
- **"File the Bun issue / say when the helper can go."** No upstream report is known here and none is filed by this change; stated under Refutation as a follow-up.

## Findings in the code

- `packages/local/src/history/scope.ts:6,21-27`: `realOrSelf` awaits `realpath` from `node:fs/promises`; the lost call. Callers: `scope.ts:38,40,55,59,68`; `history/claude-code/collector.ts:129,132` (every `read`); `session-finder.ts:157,170,174` (every pass); `history/claude-code/locate.ts:116,126,129,154,194`; `history/claude-code/report.ts:68,79`; `executor.ts:202,214,261,270`.
- Other async `realpath` in `src`: `host.ts:1234` (`watched`, reached from `pendingChange` and so from `completeStep` and `pipeline_next_step`), `worktree.ts:65,76,90,129-134,147,182,217`, `storage-paths.ts:293,311`, `integrity.ts:47-60` (the hash key at line 81), `project-locate.ts:58-60` (a second, private `realOrSelf`, used at 87-92, 128-130, 151-152), `packages/testkit/src/fake-agent-history.ts:153-154`. `packages/cli/src` has none. Sync already: `session-paths.ts:35` (`.native`), `host.ts:485-487` and `storage-paths.ts:264` (the JS `realpathSync`; left alone).
- `packages/local/src/agent-log.ts:232-246`: `capture` removes the pass from `inFlight` only when the work settles; a tick during it is `in_flight` (236); a step end calls `idle()` (237), a loop with no limit (193-201). `run()` reads the state before the lock (254).
- `packages/local/src/store.ts:1410-1474`: the lock file is removed only in the `finally` after `fn` returns; `stillHeld` compares tokens (1466-1467). A lock older than `staleMs` counts as abandoned also when its pid is alive (1369-1370), so the process that stalled takes its own lock over (`takeOverAbandoned`, 1378-1408; 300 s, line 118).
- `packages/local/src/store.ts:1544-1576`: `appendAgentLog` checks the tail only when `expect.length > 0`, then truncates and writes, with awaits between and no lock check.
- `packages/local/src/agent-log.ts`: `stillHeld()` at 272, 406, 602, 614; `fail()` (421-437) does not ask; shared state written at 467, 471, 556, 571-572, 609-610, 641-644; a checkpoint is trusted only after 458-465. `packages/pipeline-core/src/run.ts:2501-2503`: `agent_log_saved` is refused unless `stream_from` is the stored length and `first_seq` is past the stored one.
- `packages/local/src/usage.ts:359` and `tool-calls.ts:183`: writers with memos of their own per run, one per process; `usage.ts:692-697` (checkpoint test), `781` (sticky stop), `870,891` (lock asked before each record), `882-885` (`record_refused`).
- `packages/local/src/agent-log-ticker.ts:60-88`: `ensure` awaits `run.state()` and `writer.hasCandidates()` with `starting` set; `95-119`: `in_flight` and `busy` reset `entry.failures`.
- `packages/local/src/host.ts:3537,3540-3575`: the step pass; `waitMs` (5 s, `host.ts:685`) bounds only the lock wait. `host.ts:684` and `2749-2759`: the heartbeat is a timer of this event loop, a third of `staleMs` (30 s); `run.ts:2289-2298`: a tick restarts engine work whose heartbeat is stale.
- `packages/local/src/pipeline-host.ts:806-811`: `stop()` stops the tickers; `host.ts:632` and `pipeline-host.ts:221` build the writer.
- `packages/pipeline-core/src/run.ts:518-527,765,2592-2605`; `formats/v1.ts:151,161-164`: reasons are a list in `run.ts` only.
- Tests to lean on: `agent-log-docs.test.ts:57` (every reason in the docs), `format.test.ts:276-287`, `agent-log-ticker.test.ts:71-98, 336-374, 384, 579-602`, `storage-integrity.test.ts:214`, `worktree.test.ts:498-503`, `usage.test.ts:153,661`.

## Notes from the implementation

- **Criterion 10, the hang point "in `appendAgentLog` before its tail check".** A late pass that wakes there is past
  the `stillHeld()` of `agent-log.ts` and its tail check passes (the newer pass extended the stream, it did not change
  the vouched part), so it does truncate to the vouched length and write its own text again. With the same source log
  that text is byte for byte what the newer pass stored, which is what the test asserts (the stored bytes are equal
  before and after, no `agent_log_saved`, no `stored_copy_changed`, the third pass stores nothing twice); it is not
  "no write at all". If the source log grew between the two passes this is the window listed under "What stays as
  today". No guard was added there, by decision 3b.
- **Criterion 10, "in `run.state()` at the top of `copy`"** is reached in the test as the fourth `state()` call of the
  pass (before the lock, under it, for the name, for the copy).
- **Criterion 17.** The first leg (the wait for a pass in flight) is ended by letting that pass end inside the wait,
  as the 67 s sum describes it; the limit of the pass and the wait for the `stalled` record are fired by hand.
- **Criterion 2.** The scan also reports `fs["realpath"]` (an element access by that string), beside identifiers and
  property names.
- **Criterion 4.** The case added to `packages/testkit/test/agent-history.test.ts` is
  `task_7bh9_fake_agent_reads_through_a_symlinked_root`.
- The step wait is an option of the writer (`stepWaitMs`, default `STEP_IN_FLIGHT_WAIT_MS`), readable on it like
  `passLimitMs` and `timers`; the system timers are exported as `SYSTEM_PASS_TIMERS`.

- `storage-paths.ts` calls `realpathSync.native` directly instead of the `realPath` helper: the session hook loads
  that file and may import only `node:` modules (`storage_hook_imports_nothing_heavy`). Same call, same result.
