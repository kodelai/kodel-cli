# TASK-36HG: golden fixtures of stored format v1

## Goal

Keep golden copies of two real, finished runs written by the current stored format in
`fixtures/formats/v1/`, and test that the current engine opens them read-only. From then on a change
of stored data is tested against history written before it (AGENTS.md, "Stored data and
compatibility", rules 1-3). This task adds fixtures, a README and tests; it changes no engine code
unless a test shows a real reading bug.

## Facts found in the repository

- `fixtures/formats/v1/` exists with only `.gitkeep`; `fixtures/hooks/` is unrelated.
- `.kodel/runs` is git-ignored, so the two source runs (`r_0mvimyn54_tc9o`, `r_0mviewgvl_i1ig`) live
  in the main checkout and are copied from there. Each run has `meta.json` (`v: 2`), `state.json`
  (`v: 1`), `journal.jsonl` (`v: 1` records), `snapshots.json`, `specs/<hash>.yaml`,
  `reports/*.json`, and `seal.json`. The first run also has a `pending/` directory.
- The absolute workdir appears in `meta.json` (`workdir`), `state.json` and the `run_started` journal
  record. Both runs have English task text.
- `seal.json` stores the sha256 of `state.json` and `journal.jsonl`. Replacing the workdir changes
  both files, so a copied seal would read as `modified`. The task wants the fixtures to read as
  `unsealed`, so `seal.json` is **not** copied. `FileStore.checkSeal` returns `unsealed` when the
  file is missing and there is no trusted hash (`packages/local/src/store.ts`).
- The state hash kept outside the repository (`FileIntegrity`) is unknown for a copied run, so
  `trusts()` gives `undefined`; reading must not treat that as tampering.
- `readStateRaw` raises `UNSUPPORTED_FORMAT` when `state.v > RECORD_VERSION` and
  `STATE_MODIFIED_EXTERNALLY` for invalid JSON: the "cannot read" and "was modified" split exists.
- `summarizeRun(state, journal)` lives in `packages/pipeline-core/src/report.ts`; the CLI has
  `status` and `report` in `packages/cli/src/cli.ts`, tested through a `cli(...)` helper in
  `packages/cli/test/cli.test.ts`.

## Affected files

New:
- `fixtures/formats/v1/<run id>/...` for the two runs (remove `.gitkeep`).
- `fixtures/formats/v1/hashes.json`: the sha256 of every fixture file (the tamper check).
- `fixtures/formats/README.md`.
- `packages/local/test/formats.test.ts`.
- A small helper to copy a fixture into a temp store (in `packages/testkit` if the helper is reused
  by the CLI test, otherwise local to the tests).
- A fixture-taking script, `scripts/take-format-fixture.mjs` (optional; see Steps 1).

Changed because a test did fail for a real reason (see "Found while implementing"):
`packages/pipeline-core/src/canonical.ts` (`parseSnapshot`). Otherwise only if a test fails: `packages/local/src/store.ts` or
`packages/pipeline-core/src/report.ts`. Added to `packages/pipeline-core/test/report.test.ts` and
`packages/cli/test/cli.test.ts`: the unit and CLI cases.

No change to `AGENTS.md`, `.mcp.json`, `.claude/settings*` or `.kodel/pipelines/`.

## Steps

1. **Take the fixtures.** For each of the two runs copy `meta.json`, `state.json`, `journal.jsonl`,
   `snapshots.json`, `specs/`, `reports/` (and `pending/` if it holds files; an empty directory is
   not kept by git, so the loader must not require it). Do not copy `seal.json`. Replace the
   absolute workdir with a placeholder, `/kodel-fixture/workdir/<run id>`, in `meta.json`,
   `state.json` and the journal, by exact string replacement of the workdir prefix everywhere it
   occurs (not by regex over the JSON). It occurs in more than `run_started`: in
   `r_0mviewgvl_i1ig` a failed test's output in the journal holds a `<workdir>/packages/...:164:31`
   stack line, which the replacement turns into `<placeholder>/packages/...`. `reports/`, `specs/` and
   `snapshots.json` have no such path. The test asserts that no `/Users/` path is left in any
   fixture file.
2. **Hash list.** Write `hashes.json` (path to sha256) after the replacement. The test recomputes
   the hashes and fails, with the message "fixture changed: add v2 instead of editing v1", if a file
   differs, is missing or is extra.
3. **README** (`fixtures/formats/README.md`): how the fixtures were taken (which runs, what was
   changed and why: workdir placeholder and no seal), how to read them, and the rule for adding a
   new version: when a stored field is renamed, removed or retyped, add `v<N+1>/` with a real run
   written by the new engine, keep `v<N>/` untouched, and ship the in-memory migration reader. Adding
   an optional field does not need a new directory. Mention that pre-release formats may break
   freely (AGENTS.md rule 4) and that the first release freezes this directory as v1.
4. **Integration test** `packages/local/test/formats.test.ts`, one case per `fixtures/formats/v*/`
   run found by directory listing (so v2 is picked up with no test change):
   - copy the run to a temp store under a path with spaces; the placeholder workdir does not exist
     and the run is finished, so nothing may need it or git;
   - `readState`, the journal reader, `listRuns`, `summarizeRun`, and the host `status` and `report`
     work; the report counts match the numbers in the task (4 and 2 reports, 3 gates each);
   - file hashes of the copy before and after reading are equal (reading never rewrites history,
     including no new `seal.json`, lock or temp files left behind);
   - `checkSeal` gives `unsealed`, never `modified`.
   Name the tests with the decision id where the log has one for the format rules (look it up in
   the local notes; otherwise use `formats_` names).
5. **Unit test**: `summarizeRun` over the fixture journals, with expected node, gate, attempt and
   restart counts written down literally.
6. **CLI test**: `kodel status` and `kodel report <id>` on a store made from the fixtures, checking
   exit code 0 and the run id and pipeline in the output.
7. **Corner cases**, each its own test:
   - `snapshots.json` points at git objects that do not exist in the temp store: status and report
     still work (a finished run does not read git);
   - the temp path contains spaces; on Windows the same copy is also made with backslash paths
     (`path.win32` in a unit check of the helper, real backslashes when `process.platform` is
     `win32`);
   - an unknown field added to a copied `state.json` and a journal record is kept: the run opens, no
     error, and the field is still in the file afterwards (pin the behaviour);
   - a copied run whose `state.v` is higher than the engine knows fails with `UNSUPPORTED_FORMAT`
     and a message that names the format and says to upgrade, not `STATE_MODIFIED_EXTERNALLY`;
   - a corrupt `state.json` fails with `STATE_MODIFIED_EXTERNALLY` (the other side of the split);
   - an edited fixture file makes the hash test fail (mutate a copy and run the hash check
     function on it).
8. Run `bun run typecheck`, `bun run lint`, `bun test`, and `bun run build && node
   scripts/check-artifact.mjs`.

## Test strategy

The tests are listed in steps 4-7. The central claim, "an old run stays readable and is never
rewritten", is tested by hashing the whole copied directory before and after every operation.
Expectation numbers come from the source runs and are written as literals, not computed from the
engine, so a regression in the engine shows up. Tests must run on Linux, macOS and Windows: normalise
line endings expectations (git `autocrlf` could change fixture bytes on Windows, which would break
the hash list; add `fixtures/formats/** -text` to `.gitattributes` so the bytes stay as taken).

## Risks

- **Seal and workdir.** Checked: each `seal.json` matches the current bytes of `state.json` and
  `journal.jsonl`, so the placeholder edit would turn a copied seal into `modified`; chosen: no
  `seal.json`. Checked: a journal record is only `v`, `seq`, `ts`, `event` and event fields, with no
  hash chain, so the edit breaks nothing else.
- **Personal data in history.** Checked with a scan of both runs for `/Users/` paths, e-mail
  addresses and token-like strings: the only hits are the workdir (and the stack line above). The
  task text and reports are real project text. Step 1 repeats the scan on the copies.
- **Windows line endings** (see Test strategy) and git ignoring empty directories (`pending/`).
- **A real reading bug found by the tests** (for example a code path that rewrites a file on read or
  needs the workdir). Then fix it in a separate, small commit with its own test, since reading must
  never rewrite history.
- **Fixture size:** about 85 KB for both runs, acceptable.
- **Merge order:** the task is to be merged before the tasks that add stored fields; keep this change
  free of engine edits so it merges cleanly.

## Found while implementing

- Run `r_0mviewgvl_i1ig` could not be opened: its kept pipeline has `files` on `human` nodes, which a
  later change (`be5d74f`) removed from the user-file format, and `parseSnapshot` was a stub that called
  the current `parsePipeline`. That is AGENTS.md rule 2 broken. `parseSnapshot` now reads the kept
  copy with a registry in which `human` still accepts `files` (kept in the node's parameters, so the
  node has the definition the journal recorded). Test: `a_snapshot_still_reads_the_files_a_human_node_used_to_take`
  in `packages/pipeline-core/test/canonical.test.ts`. The fix is the only engine change and is meant to
  be its own commit.
- The task text says "4 reports" for `r_0mvimyn54_tc9o`; the run directory holds 3 (`plan-approval-1`,
  `review-1`, `review-2`). The fixture keeps what the run has, and a test pins 3 and 2.
- The backslash-path case is not tested separately: the temp store path has a space on every system and
  uses the native separator, so on Windows it has backslashes; `hashTree` normalises them.
- The unit test of `summarizeRun` is a new file, `packages/pipeline-core/test/formats.test.ts`.
