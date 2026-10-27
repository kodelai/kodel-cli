# A golden run with usage (TASK-9JRS)

`r_0mvr1f5ur_1h9c/` is a finished two-step run of the format of the build that added `history.usage`: it holds
`usage_recorded` events in the journal and `usage` in the state. It was made by the usage pass of this repository over a
**hand-made** session log (the numbers are invented; the log is not a real Claude Code transcript), with the working
directory replaced by `/kodel-fixture/workdir/<id>` and `seal.json` left out.

It is read by `packages/local/test/usage-run-fixture.test.ts` with `open`, `state` and `report`, and nothing on disk may
change. It is kept outside `fixtures/formats/v1/` because that directory is pinned by `hashes.json`, which is not regenerated
once the first release has frozen v1. **At the first release this run is moved under the frozen formats** (with its hash
pinned there), like the sample run in `fixtures/agent-log/`; from then on a change of the shape of a usage record needs a
reader of the previous format.
