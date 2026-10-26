# Decide how to capture agent usage, history and tool calls (TASK-52A8)

## TL;DR

- Owner decision, no code. The mechanism is merged (log collectors, TASK-VH9G; hook transport, TASK-5NBV). This task writes the last
  defaults into `docs/history.md` (as "planned defaults, not yet built") and leaves the design to 3BK2 and 9JRS, with constraints.
- Decided by the person: `history.agent_log` is **`full` by default and committed with the run history** (option b); caps **per kind in
  `config.yaml`** from measured percentiles; prices **hardcoded plus a config override**; the **price check (script and skill) is
  built in 9JRS with the table**.
- What the last critique changed: the plan now decides which sessions may be stored as `full` (only a session proven to have called
  `pipeline_*` with the run id), the `max_kb` policy (per step, so the end of a run is not the part that is dropped), the price override
  granularity (per model), the switch precedence, and that the format changes must land before the v1 freeze; collection stores only
  closed responses; tests and C4 moved to a labelled appendix; ZKRH/R7AF comments dropped.
- Risks the person accepted: a secret that `redact` misses ends up in git history for good, and every existing project starts
  committing full agent sessions on upgrade (when it tracks `.kodel/runs`).

## Decisions needed

Decided by the person, as they said it: 1. `full` by default, committed with the history. 2. Caps by percentile, in `config.yaml`.
3. Hardcoded prices with a config override. 4. Price check script and skill "right away", built in 9JRS with the table.

Decided in this plan (each needs only your approval; change any of them by rejecting with the choice):

1. **Default caps** (`history.agent_log.preview_chars`; `0` empties a kind; a single number is accepted). Measured on 647 session files:

   | kind | p50 | p90 | p95 | p99 | over 500 |
   | --- | --- | --- | --- | --- | --- |
   | message from the person | 304 | 6 224 | 11 049 | 18 037 | 34% |
   | message from the agent | 92 | 1 550 | 2 438 | 4 390 | 17% |
   | tool input | 289 | 2 011 | 4 108 | 10 822 | 28% |
   | tool result | 410 | 4 864 | 7 789 | 19 430 | 46% |

   One cap keeps this share of the text: 500: 23%; 2 000: 50%; 4 000: 68%; 8 000: 83%; 20 000 (about p99): 96%.
   - (a) **Recommended:** `user 4000`, `agent 4000`, `tool_input 4000`, `tool_result 8000` (about p90-p95); `subagent` description and
     `system.detail` keep 500. (b) p99 for all: no cap in practice, and it all goes into git. (c) 2 000 for all: smaller, but cuts
     the tool results, where most failure causes are.
   - Size at (a), per session with its subagents: median 163 KB of events (38 KB gzipped); p90 2.4 MB (590 KB); p99 8.9 MB (2.1 MB); largest 12.9 MB.
2. **`max_kb` policy.** `max_kb: 20480` (bytes after redaction and cut, all session files of one run) is split per step: each step may
   use up to `max_kb` divided by the number of nodes of the pipeline, unused budget carries over, so a long run never drops its end; when a
   budget is hit, whole events are dropped, one marker event records how many, and the report names the step. (a) **Recommended.** (b)
   First come, first kept: the end of a long run, where failures are, is dropped first; rejected.
3. **Which session is stored as `full`.** Only a session proven to have called `pipeline_*` with this run id (the executor's observed
   session from the environment, or a session whose own log holds such a call). A session known only from the hook index ("the newest of
   the directory") may belong to another window or agent: nothing is stored for it and the report says "session unknown".
4. **Price override granularity.** Per model: an entry in `history.usage.prices` replaces the shipped entry of that model whole; a model not in
   the override uses the shipped one. The recorded `source` is `config` for a model priced from the override.
5. **Switch precedence.** `agent_log.enabled` is the switch of the copy and the privacy switch of this data (it is the most sensitive data a
   run writes, so it counts as a sensitive category even though it is a nested section); `usage` (9JRS) and `tool_calls` (ZKRH) read the log
   by themselves and do not need it; `tool_log` (R7AF, hooks) stays the hooks' switch; `agent_log` honours `tool_log: false`
   by storing no `tool_call`/`tool_result` events; a kind is silenced with `preview_chars: 0`, not with `prompts`/`output`.
6. **Claude Code's `cost-state`.** Written once when a session ends, for the whole session, always above the event totals (hidden
   requests), missing in about half the files. It is not an event, not in any run and not shown as a run's cost: only the local price check
   (`scripts/check-prices.mjs --local`, in 9JRS) reads it, with the same project scoping as the collectors (Kodel projects only).

Not decided here: scheduling the price check (an outward action; off); running another model on the same prompt and state (the
executor's job; the engine already keeps the step prompt and the base commit).

## Behaviour change

- Each run keeps its agent session in `agent_log/` of the run folder, on by default, with no opt-in, like the other history categories on
  by default. It is committed when the project tracks `.kodel/runs` (this repository ignores it; `init` no longer writes `.gitignore`; GitHub
  push protection may refuse a push whose branch holds a known secret pattern). **On upgrade, every existing project starts storing full
  sessions**: the docs section says it in one line, and so should the next `kodel init`/release notes.
- Only events of the run's window are stored, from the response that issued `pipeline_start` to the end of the run; the person's request
  and the final answer after the last step are outside it. Subagents of a stored session are included.
- Data is collected at the end of each step and at the end of the run, only up to the last closed response (the open one is carried to
  the next pass). Nothing is written to a finished run, by any writer (host, executor, `tieEnd`, the CLI's `gate`/`resume`/`seal`); the
  last response of a session may be missing and the report says so.
- Cost is an estimate with the table `revision` and its `source`; a total over a model without a price is `partial`, never `$0`.

## Risks and invariants

- Principle 3: `redact` (the built-in rules and the project rules, passed into the collector) runs before the cut, and the write of
  `agent_log/` goes through the store's `redact`. **Residual risk, in the docs section:** it catches known patterns and 32+ character
  mixed high-entropy words, not hex-only or short secrets; a secret split across two events is redacted per event; `history.changes.exclude`
  does not apply; a tool that reads an `.env` puts up to 8 000 characters of it into the log, and in a tracked history that is permanent.
  Ways to lower it: `preview_chars: 0` for a kind, `mode: metadata`, `enabled: false`. The miss rate of hex-only canaries is measured and reported, as information.
- Principle 1: usage and cost come from logs and a config the agent can edit; they are information only, never an input of a check, a route
  or a gate. The new keys (and the price override) are journaled in `run_started.history` and collection reads those, not the live file; a run
  without them reads as "not captured"; an `agent_log` file whose journal is missing reads as "mode unknown". The agent can edit the
  config for later runs; that is accepted and shown in the report as the mode that was used.
- Principle 4: the price table is plain data in `pipeline-core`, the entry chosen by the usage event's `ts`; the override is read by the
  local loader. In core `agent_log` and `usage` are optional parts of `HistoryConfig` and not in `DEFAULT_HISTORY`; the `HISTORY_SECTION_KEYS`
  test becomes a subset assertion that names `agent_log` as sensitive, and the comment of `HISTORY_CATEGORIES` is rewritten by 3BK2. A side-file
  operation is added to the core store interface, not only to `FileStore`.
- Principle 6: nothing a person decides becomes open to the agent; `decisions.agent` does not cover these defaults.
- Stored data (constraint for 3BK2 and 9JRS): the changes are optional `revision`/`source` on `usage.cost` and a `computed` basis,
  `text_preview` optional in `metadata`, a new cut marker, new keys in `run_started.history`. They are allowed under `v: 1` only before the first
  release (rule 4), so **the release is blocked on 3BK2/9JRS, or the version is bumped with a reader of the previous format**. The golden
  fixtures in `fixtures/formats/v1/history/` stay byte-identical: the old behaviour (cap 500, whitespace collapsed, no `revision`) remains the
  default of the collector options and the new one is selected by options, with new fixtures added. A bad line, an unknown kind or another `v` in an
  `agent_log` file is reported as "cannot read (format X)", never as "modified", and does not fail `report` for the rest of the run. The file name
  comes from a session id that must pass the `SAFE_SESSION` guard.
- Seal: the seal covers state and journal only. `agent_log/<session>.jsonl` is plain JSONL, only appended while the run goes, with a cursor
  (last stored `seq` and the byte offset) kept in the journal as `agent_log_saved`, so a pass does not re-read the file and is idempotent;
  display data outside the seal, shown as unverified. A stored cost is not recomputed with a later table.

## Acceptance criteria and tests

This task is judged by the person at the gate (C1, C2 are manual: a reader ticks a list). The tests are in the appendix as suggestions for
3BK2 and 9JRS; a decision counts as implemented only when those tasks' tests pass. The prefix `t52a8_` is provisional: rename when decision ids exist.

- C1: `docs/history.md` gets a section "Capture decisions", titled "planned defaults, not yet built", with only the decisions: the six items above,
  the `full` default and the upgrade note, the caps and `max_kb`, the price-table fields (`format`, `revision`, per model prices,
  `effectiveFrom`, `sourceUrl`, `checkedAt`) and the residual risk. The older lines that say "500 characters" or "only normalized events
  are kept" are marked "current behaviour until 3BK2 lands" (`grep -n "500" docs/history.md` lists every hit). The person's answer is in the plan
  and the task comment, not in the docs. Append the section after main's last one (rebase first: main added "What the agent was shown").
  Check: `git diff --name-only $(git merge-base HEAD main)..HEAD` lists `docs/history.md` and `docs/plans/task_52a8.md` only.
- C2: TASK-52A8, 3BK2 and 9JRS each get one comment pointing to the section; 3BK2's comment also carries the ZKRH/R7AF overlap note (a pointer for
  them is not added). Before editing, `task_get` records each body's length; bodies stay <= 4000 and comments <= 500; statuses are unchanged (the
  engine moves 52A8 to done at run end). Body edits are made only where they shorten (3BK2: the default sentence, `max_mb` to `max_kb`, `.jsonl.gz`
  to `.jsonl`, the goal text "and, later, replayed with another model"; 9JRS: "(two open questions)" to "(decided)"; 52A8: the two open items become decided
  sentences). These records are not in git, so this is checked by the gate reader with `task_get`.
- Judged by the person, evidence: decisions 1-6 and the four earlier ones (the size table and the percentiles above; the caps are reconsidered when the
  per-run size reported by 3BK2 or the cut rate exceeds what the person accepts). Not testable: whether `full` in git is right for the person; secrets
  that match no pattern; real price accuracy; whether the percentiles fit other users; other agents' logs; the judge's benefit before a judge exists.

---

## Steps

1. At the plan gate the person approves, or rejects with the choice to change.
2. Rebase onto `main`, write the section, fix the "500 characters" lines (C1).
3. Comments and body edits of the three task records (C2); if an update fails, stop and report which are done; the rest are repeated.
4. Complete the step; the engine closes the task with the run.

## Affected files

- `docs/history.md` (new section), `docs/plans/task_52a8.md`. Task records through `task_update` only (not in git).
- Built later in 3BK2/9JRS: collector options (caps, kept line breaks, marker, rules, closed-response cursor), the table and override,
  `scripts/check-prices.mjs` (network mode and `--local`), `skills/kodel-prices/`.

## Appendix: suggested tests and open items for 3BK2 and 9JRS (not binding)

- 3BK2: defaults when no config, no `history`, no `agent_log` key; `enabled: false` stores nothing; caps per kind, `0`, a single number, the marker and line
  breaks kept; redaction before the cut (secret split over lines, across the cut, across two events, with a project rule); only a proven session and
  window (a second window, another agent, run A's events never in run B); closed-response cursor and idempotent passes, run twice at a step end and the run
  end; `max_kb` per-step budget with the marker and the report text; config frozen at run start, "not captured" and "mode unknown"; an invalid line or
  unknown kind is "cannot read", not "modified"; editing `agent_log/` keeps the seal valid and report says "unverified"; nothing written to a finished run by any
  writer; the CLI path of `gate`/`resume`/`seal`; session id guard; server run (no keys) reads "not captured"; golden v1 fixtures unchanged with default options.
  Open: the stale `CLAUDE_CODE_SESSION_ID` after `/clear` (needs a real-agent scenario in `tests/agents`); window edges; parallel runs in one session; a lower cap
  for `mcp__kodel__*` results (already in `served/`); a first-use notice or docs line about the upgrade.
- 9JRS: table (`format`, `revision`, per model `input/output/cache_read/cache_write`, `effectiveFrom`, `sourceUrl`, `checkedAt`); check the shape against the current
  price lists before fixing it (1-hour cache writes, long-context tiers, Bedrock/Vertex ids); matching cases (`-YYYYMMDD` suffix cut, `claude-3-5` does not match
  `claude-3`, longest prefix wins, exact beats prefix, no entry gives `partial`, `effectiveFrom` day before/of/none); `reported_zero` falls through; `overlap`
  subtracts cached tokens; the cost is stored with `revision` and `source` and not recomputed; the override at per-model granularity and in `run_started.history`;
  cost never feeds a check, route or gate (an import graph, and a run with a different table and override routes and gates identically; one change refutes it);
  the table module has no file or clock import; `--local` drift over 10% (9.9% not flagged; models absent from the events listed; `hasUnknownModelCost` skipped);
  exit codes of the network mode on saved pages (1 on a change, 2 on unreachable or unparsable) and a note on how a changed page format is noticed later.
- Refutations, run once locally by the 9JRS builder (output and date in a comment; if one fails the person reopens the decision through a new task): tokens
  of a clean real session (no resume, no compaction, at least 3 sessions) within 10% of the agent's own; the table's cost within 10% of `cost-state` over the
  models the events saw, on sessions without 1-hour cache, long context or non-Anthropic endpoints; on 20 real sessions with a failed tool call (`ok: false`, seed
  recorded) the failing `tool_result` is uncut in at least 18; per-run size at the caps: median and p90 reported; the redaction canary run over the measured
  sessions leaks zero known patterns; the shipped `sourceUrl`s parse from saved pages with zero unparsable.
- Open: if 9JRS grows too large the table and override go first and the script and skill follow in the same task; an older build reading the nested keys gets a bare
  "Unrecognized key".

## Rejected review findings

- Splitting 9JRS (scope, info): not split; the person asked for the check with the table.
- Keeping the docs section minimal, test table dropped from C3 (scope): done, moved to the appendix; the person's quote is removed from the docs.
- ZKRH and R7AF pointer comments (scope): dropped; the overlap is a note in 3BK2's comment.
- Staleness shown in the report: not wanted; every computed cost is an estimate with its `revision`.
- Decision-log ids (tests): the log is outside the repository; the prefix is provisional.
- "Seal `agent_log/`" (earlier critique): not done; display data shown as unverified.
- A refutation for "`full` in git is right" (tests): not testable; judged by the person, with the size evidence and the reconsideration trigger in C2.
- Hook SessionEnd, late flush, git-ignore condition, `cost_snapshot` event (earlier critiques): dropped in the previous round.

## Findings in the code

- `agent-history.ts`: `previewOf` collapses whitespace, `PREVIEW_CAP` 500, `text_preview` required, strict union, `v: z.literal(1)`; `normalize.ts`: `flushPending` at EOF
  emits an open response with partial usage; `collector.ts`: `seq_from` only filters.
- `executor.ts`: `observed-env` vs `observed-hook` (newest session of the directory); `SAFE_SESSION`. `host.ts`: `tieEnd`, `recordRefusal`, the project rules in `FileStore`.
- `history-config.ts`: `HISTORY_CATEGORIES` documented as every sensitive category with a switch; `run.ts` types `run_started.history` as `HistoryConfig`.
- `fixtures/formats/v1/history/*.events.jsonl` pinned by `hashes.json`; the README forbids regenerating the list after the release.
- `main` (`fe0b253`): `init` no longer writes `.gitignore`; this repository ignores `/.kodel/runs`. Claude Code `cost-state` is the last line of a session file when present.
