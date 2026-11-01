# A golden run with tool calls (TASK-ZKRH)

`r_0mvhxxz40_zo34/` is a finished two-step run of run-state format 2 that holds `tool_calls_recorded` events in the journal and
`toolCalls` in the state. It was made by the tool-calls pass of this repository over a **hand-made** session log (the calls and
times are invented; the log is not a real Claude Code transcript) with a fake clock, with `history.agent_log` and
`history.usage` switched off (so the pass is shown to work without them), no worktree, and `seal.json` and the lock left out.

The first record (step `a`) holds the call of `pipeline_start`, a `Bash` call and their results; the second (step `b`) holds
the hand-in call of step `a` with its result, which the first pass could not read because its response was still open, and the
calls of step `b`, one of them an error blocked by a hook of the project.

It is read by `packages/local/test/tool-calls-run-fixture.test.ts` with `open`, `state` and `report`, and nothing on disk may
change. It is kept outside `fixtures/formats/` because those directories are pinned by `hashes.json`, which is not regenerated
once the first release has frozen them. **At the first release this run is moved under the frozen formats** (with its hash
pinned there), like `fixtures/usage-run/`; from then on a change of the shape of a tool-calls record needs a reader of the
previous format (`calls.v`).
