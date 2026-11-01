# A golden run with usage (TASK-9JRS)

`r_0mvw32fz3_x186/` is a finished two-step run of run-state format 2 (forks, T-40): it holds `usage_recorded` events in
the journal and `usage` in the state. It was made by the usage pass of this repository over a **hand-made** session log
(the numbers are invented; the log is not a real Claude Code transcript), the flow of
`t9jrs_flushed_open_response_corrected_on_next_pass` in `packages/local/test/usage.test.ts`, with no worktree (the state
holds no working directory) and `seal.json` left out.

It replaces the run of format 1 (`r_0mvr1f5ur_1h9c/`) that the build adding `history.usage` took: format 2 refuses a
format-1 run without a reader (AGENTS.md, "Stored data and compatibility"), so that run could no longer be opened. The
token figures are **not** the same as that run's: this one follows the flow of the test named above (the response open at
the first pass is corrected at the second), so `a:1` has `cache_write_1h` 100 (the old run had 0) and `b:1` has output 55
(the old run had 5), and the computed costs differ with them. The stored revision is the one of the price table when it
was taken (2026-10-28).

It is read by `packages/local/test/usage-run-fixture.test.ts` with `open`, `state` and `report`, and nothing on disk may
change. It is kept outside `fixtures/formats/` because those directories are pinned by `hashes.json`, which is not
regenerated once the first release has frozen them. **At the first release this run is moved under the frozen formats**
(with its hash pinned there), like the sample run in `fixtures/agent-log/`; from then on a change of the shape of a usage
record needs a reader of the previous format.
