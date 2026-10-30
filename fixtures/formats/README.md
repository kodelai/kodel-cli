# Golden runs of the stored formats

Run history is read by every later engine and is never rewritten (AGENTS.md, "Stored data and
compatibility"). Each directory here, `v<N>/`, holds finished runs written by the real engine of
run-state format N (the `v` of `state.json` and of the journal records): the host, the store, the
process executor and git did what they do in a run of `kodel mcp`; only the agent's part (the files
written, the steps completed) was played by a script, and the person's decisions were made through
the host methods the commands call (each section says how). The tests look at every run
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

The current run-state format (forks; `pauses[]`, `forks`, `effects[]` on `pipeline_accepted`). Four
runs made by `bun scripts/take-v2-fixtures.mjs`, two of the `dev` pipeline and two of fork pipelines,
and taken with the script above; the tests open every one of them (`status`, `report`, the history
of the pipeline) and check that reading changes no byte. A reader was not shipped for the break from
1 to 2 (see above), so `v2/` is where the frozen history begins.

What is real: the runs went through `LocalPipelineHost` of `@kodel-ai/local`, the host `kodel mcp`
and the commands are built on, with nothing replaced. Every step was handed out by `nextStep` with
`serve` (as `pipeline_next_step` hands it out), so each has a `step_served` record, a `served/` file
and an entry in `state.served`; the host was given a build (`engine.version` `0.1.0`, the version of
`packages/cli/package.json`, `commit` `fixture`), so `engineVersion` is stamped and every hand-in
carries `engine_version` where it differs; the `executor` records name the client the host observed,
the script itself (`take-v2-fixtures`), and nothing else. The commands of the pipelines were run by
the real process executor in the run's worktree and their output is in `artifacts/`; the scratch
repository has a `package.json` whose `typecheck`, `lint`, `build` and `check:artifact` scripts are
`node -e 0`, one smoke test for `bun test`, and a bare `origin` for `sync` and `publish`. Every
agent step's files were committed in the worktree before the step was completed (author
`Kodel Fixture <fixture@example.com>`), so `head` and `tree` of the hand-ins move with the run and
`run_finished.commits` lists the commits since the base. The snapshots, patches (`changes/`) and
worktrees are git's.

What the script played: the agent (the files a step asks for, the result reports, `feedback`, the
proposal, `completeStep` with its outcome) and the person (`decideHuman` at the gates, `acceptChange`
for the proposal and for the file change, `resume` of the paused branch: the same host methods
`kodel gate`, `kodel pipeline changes apply` and `kodel resume` call). The `dev` pipeline of the
scratch repository is this repository's `.kodel/pipelines/dev.yaml` with the two `publish` checks
that ask GitHub (`gh pr view`) left out, and with them the `publish -> impl, when: conflicts` edge
only the second could take: the scratch repository has no pull request. Its other four `publish`
checks ran (not `main`, a clean tree, `Signed-off-by`, HEAD pushed to `origin`).

- `r_0mvu1vxry_4ggv` (`dev`): the agent's proposal to change the `plan-critique` prompt, accepted
  while that step was being worked (`effects: [{ kind: "restart", node: "plan-critique" }]`, a
  superseded attempt); a note from the agent (`feedback_reported`); three gate decisions (the plan
  rejected once, then approved; the result approved); the whole path to `publish`, with result
  reports (a minor and an info finding) and `verify`, `test`, `build`, `sync` really run. Five
  commits, ten served steps.
- `r_0mvu1w1ng_dk6c` (`dev`): a change made in the run's pipeline file (the `review` prompt, a step
  the run never reached: `effects: []`), accepted; a note from the agent; `plan` ending with
  `nothing_to_change` and its gate rejected once, then approved. Two commits, two served steps.
- `r_0mvu1w2tp_ssyf` (`fork`): `examples/pipelines/fork.yaml` with `verify` taking 1.5 s and the
  `test` command failing the first time it runs: `impl`, then `verify` and `test` at the same time
  (two overlapping command branches, `fork_started`, `branch_settled` with one failed), the join `fix`
  entered with the failed branch's feedback (`join_reached.failed`), `restart_failed` running `test`
  again, and the run completing on the join's second visit. Its `state.json` carries `forks`, its
  `active` visits carried the fork attribution while they went, and its journal has the overlap. No
  pause.
- `r_0mvu1w4w6_w0iy` (`fork-pause`, a pipeline written for this run, in the script): the same fork,
  with `test` given `max_attempts: 1, max_consecutive_failures: 1` and a failure route into a
  `fix-test` agent step of its branch. `test` failed once and its branch paused at that route
  (`run_paused` with `reason: consecutive`, `node: test`, `fork: f1`, `branch: test`) while `verify`
  went on and arrived at the join; then the run stood `paused`. The person resumed that node
  (`run_resumed` with the same node and attribution), `fix-test` ran, `test` passed on its extra
  attempt and the join was entered once. `end()` clears `pauses` on the final state, so the journal's
  two records, the report's count of pauses and the `forks` of the state are what the fixture pins.

**Do not open a fork run with the beta** (`@kodel-ai/kodel@0.1.0-beta.0` or earlier): it refuses
format 2 as written by a newer kodel, which is the right answer, and must not be made to read it.

Each run worked in a worktree of its own, so `meta.json` carries the placeholder workdir and the
branch `kodel/<run id>`. The placeholder is put wherever the worktree's path was: `meta.json`,
`state.json` and the journal (whose redacted `run_started.workdir` is handled by `placeholderInJournal`).
The `served/` files are not touched by it: the scratch directory's random name read as a secret when
the answer was stored, so their `answer.workdir` reads `[REDACTED:high-entropy].kodel/worktrees/<run
id>`, as it was written, and holds no path of the machine; a served file's `prompt_hash` is of that
stored answer and is not recomputed. `history.executor` is on in
the scratch project (it is what stamps the engine version and the client): the script ran with no
`CLAUDE*` variable in its environment and no agent hook index in the scratch repository, so no
`executor` record carries a session or a model, and `history.agent_log` is off (no agent ran, so
there was no conversation to copy). A fixture must hold no identifier of the person who took it:
the guard test (`formats_no_fixture_holds_a_path_of_a_person_or_a_seal`) refuses an observed session
as it refuses a path of a home directory, and the script scans the taken runs for a path of the
machine or of the scratch directory.

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
