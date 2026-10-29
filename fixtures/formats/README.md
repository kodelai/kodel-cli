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

## `v2/` and later

`v2/` is the current run-state format (forks). It holds real runs written by this engine, taken with
the script above; the tests open every one of them. A reader was not shipped for the break from 1
to 2 (see above), so `v2/` is where the frozen history begins.

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
