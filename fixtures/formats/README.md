# Golden runs of the stored formats

Run history is read by every later engine and is never rewritten (AGENTS.md, "Stored data and
compatibility"). Each directory here, `v<N>/`, holds real, finished runs written by an engine of
run-state format N (the `v` of `state.json` and of the journal records). The tests look at every run
in every `v*/` directory with the current engine (`packages/local/test/formats.test.ts`,
`packages/pipeline-core/test/formats.test.ts` and the `t40_` format tests in
`packages/cli/test/cli.test.ts`): a run of the current format or a later one must open (`status` and
`report` work), a run of format 1 must be refused with `UNSUPPORTED_FORMAT` naming its format (see
below), and reading must not change a byte either way.

## `v1/`

Two runs of the `dev` pipeline: `r_0mvimyn54_tc9o` (a change of the pipeline accepted by a person;
3 gate decisions) and `r_0mviewgvl_i1ig` (feedback from the agent; 3 gate decisions). Each
has `meta.json`, `state.json`, `journal.jsonl`, `snapshots.json`, `specs/` and `reports/`.

**Format 1 is refused by design.** Forks (decision T-40) replaced `pause` by `pauses[]` and added
`forks` and a fork attribution to visits; this was done before the first release, so no reader for
format 1 is shipped (AGENTS.md, "Stored data and compatibility", the exception under rule 4). The
runs stay here untouched to prove that the refusal is clear: `status`, `report`, `resume`,
`pipeline_next_step`, `gate`, `ack`, `seal`, `wait` and `pipeline changes` say "run-state format 1
by an older kodel; finish or cancel it with the kodel that started it", never "modified"; the run
list shows them as `format 1`; `pipeline_start` passes a finished one over and refuses to start
beside an open one. `v1/history/` holds golden event streams of the agent's log, not runs.

They were taken with `node scripts/take-format-fixture.mjs v1 <run dir> ...`, from the run
directories under `.kodel/runs`. Two things differ from the originals:

- The absolute workdir of the run (`meta.json`, `state.json` and the journal) is the placeholder
  `/kodel-fixture/workdir/<run id>`. It does not exist, so a test that needs the workdir of a
  finished run fails.
- `seal.json` is left out. It holds the hashes of `state.json` and `journal.jsonl`, which the
  placeholder changes, and a copied seal would read as "modified". A fixture reads as `unsealed`.

`hashes.json` lists the sha256 of every file in the directory. The test fails if a file is edited,
removed or added: do not fix such a failure by regenerating the list, add a new version instead.

## `v2/`

The current run-state format (forks; `pauses[]`, `forks`, `effects[]` on `pipeline_accepted`). Two
runs of the `dev` pipeline written by this engine, taken with the script above; the tests open every
one of them (`status`, `report`, the history of the pipeline) and check that reading changes no byte.
A reader was not shipped for the break from 1 to 2 (see above), so `v2/` is where the frozen history
begins.

- `r_0mvtewczh_4i2w`: the agent's proposal to change the `plan-critique` prompt, accepted while that
  step was being worked (`effects: [{ kind: "restart", node: "plan-critique" }]`, a superseded
  attempt); a note from the agent (`feedback_reported`); three gate decisions (the plan rejected once,
  then approved; the result approved); the whole path to `publish`, with result reports.
- `r_0mvtewgdn_zfhl`: a change made in the run's pipeline file (the `review` prompt, a step the run
  never reached: `effects: []`), accepted; a note from the agent; `plan` ending with
  `nothing_to_change` and its gate rejected once, then approved.
- `r_0mvthh4vp_9gqe`: a run of the `fork` example pipeline (`examples/pipelines/fork.yaml` with the
  `test` command failing once): `impl`, then `verify` and `test` at the same time (two overlapping
  command branches, `fork_started`, two `branch_settled`, one of them failed), the join `fix` entered
  with the failed branch's feedback (`join_reached.failed`), `restart_failed` running `test` again,
  and the run completing on the join's second visit. Its `state.json` carries `forks`, its `active`
  visits carried the fork attribution while they went, and its journal has the overlap.

**Do not open a fork run with the beta** (`@kodel-ai/kodel@0.1.0-beta.0` or earlier): it refuses
format 2 as written by a newer kodel, which is the right answer, and must not be made to read it.

They were made by a script in place of the agent, in a scratch repository with the pipeline's commands
answered by a stub (as `packages/local/test/changes-dev-yaml.test.ts` does), each run in a worktree
of its own, so `meta.json` carries the placeholder workdir and branch. The run directories hold what
the engine writes for such a run: `changes/` (the patch of every handed-in attempt and of the run),
`artifacts/` (the output of the stubbed commands), `reports/`, `snapshots.json` and `specs/`.

## Later formats

Add a directory when a change renames, removes or retypes a stored field (run state, journal
records, the pipeline snapshot kept with a run, reports). The same change ships:

1. a reader for the previous format that migrates in memory on read;
2. a real run written by the engine *before* the change, taken with the script above into the new
   directory, and the tests passing on it with the new reader.

Keep every `v<N>/` as it is: `v1/` must keep being refused clearly, the others must keep opening.
Adding an optional field, or one that only a newer run carries, needs no new directory; the test with
an unknown field already pins that it is kept.

Before the first release, formats may break freely and these fixtures may be replaced; the break
above is the one such break made so far. At the first release this directory is frozen and the rules
above apply to every change.
