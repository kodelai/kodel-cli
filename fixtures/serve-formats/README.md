# Record fixtures of `kodel serve`

Golden files of the daemon's record (`<state base>/serve/<uid>/<checkout key>.json`, `docs/serve.md`), one
directory per `v`. The record is machine-local state, not history: one codec in
`packages/pipeline-core/src/serve/record.ts`, whose `decode` ignores unknown optional fields of a known `v` and
refuses a newer `v` with "upgrade kodel". `packages/pipeline-core/test/serve-record.test.ts` opens every file here
and writes it back as it was read.

`v1/serve.json` was written by the real `acquireServeRecord` and `writeCycle` of `@kodel-ai/local` (not by
hand), driven by a daemon cycle (the one that made `fixtures/formats/v2-worker/`). What would name the machine
was passed in as neutral values: `pid` (`4242`) and its identity, `root` (`/kodel-fixture/checkout`) and
`state_base` (`/kodel-fixture/state`). The times and the counts are those of the last cycle.

`v1/serve-alive.json` is the record with `counts.alive` (T-45: the live worker processes, beside `workers`, the
agents that are working), written by the same two functions with the same neutral values. `serve.json` stays as a
record from before the field: it is optional, an older reader drops it, and `v` did not change.
