# Golden runs of the stored formats

Run history is read by every later engine and is never rewritten (AGENTS.md, "Stored data and
compatibility"). Each directory here, `v<N>/`, holds real, finished runs written by an engine of
stored format N. The tests open every run in every `v*/` directory with the current engine
(`packages/local/test/formats.test.ts`, `packages/pipeline-core/test/formats.test.ts` and the
`formats_` tests in `packages/cli/test/cli.test.ts`): `status` and `report` must work, and reading
must not change a byte.

## `v1/`

Two runs of the `dev` pipeline: `r_0mvimyn54_tc9o` (a change of the pipeline accepted by a person;
3 gate decisions) and `r_0mviewgvl_i1ig` (feedback from the agent; 3 gate decisions). Each
has `meta.json`, `state.json`, `journal.jsonl`, `snapshots.json`, `specs/` and `reports/`.

They were taken with `node scripts/take-format-fixture.mjs v1 <run dir> ...`, from the run
directories under `.kodel/runs` (or `~/.kodel/projects/<project_id>/runs` with `storage: home`; the files are the same).
Two things differ from the originals:

- The absolute workdir of the run (`meta.json`, `state.json` and the journal) is the placeholder
  `/kodel-fixture/workdir/<run id>`. It does not exist, so a test that needs the workdir of a
  finished run fails.
- `seal.json` is left out. It holds the hashes of `state.json` and `journal.jsonl`, which the
  placeholder changes, and a copied seal would read as "modified". A fixture reads as `unsealed`.

`hashes.json` lists the sha256 of every file in the directory. The test fails if a file is edited,
removed or added: do not fix such a failure by regenerating the list, add a new version instead.

## When to add `v2/`

Add a directory when a change renames, removes or retypes a stored field (run state, journal
records, the pipeline snapshot kept with a run, reports). The same change ships:

1. a reader for the previous format that migrates in memory on read;
2. a real run written by the engine *before* the change, taken with the script above into the new
   directory, and the tests passing on it with the new reader.

Keep `v1/` as it is: it must keep passing. Adding an optional field, or one that only a newer run
carries, needs no new directory; the test with an unknown field already pins that it is kept.

Before the first release, formats may break freely and these fixtures may be replaced. At the first
release this directory is frozen as v1 and the rules above apply to every change.
