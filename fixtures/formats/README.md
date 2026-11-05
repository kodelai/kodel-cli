# Golden runs of the stored formats

Run history is read by every later engine and is never rewritten (AGENTS.md, "Stored data and
compatibility"). Each directory here, `v<N>/`, holds finished runs written by the real engine of
run-state format N (the `v` of `state.json` and of the journal records); `v1-open/` holds open runs
of format 1 (see its section). In each, the host, the store, the
process executor and git did what they do in a run of `kodel mcp`; only the agent's part (the files
written, the steps completed) was played by a script, and the person's decisions were made through
the host methods the commands call (each section says how). The tests look at every run
in every directory here with the current engine (`packages/local/test/formats.test.ts`,
`packages/pipeline-core/test/format-codecs.test.ts`, `packages/local/test/v1-continue.test.ts` and the
`t41_` format tests in `packages/cli/test/cli.test.ts`): every run must open (`status` and `report`
work), every codec must write a run back as it read it, an open run must go on in its own format,
and reading must not change a byte. A directory is named `v<N>` or `v<N>-<tag>` (`<N>` is the
format its codec reads); every format has a codec and a directory.

## `v1/`

Two runs of the `dev` pipeline: `r_0mvimyn54_tc9o` (a change of the pipeline accepted by a person;
3 gate decisions) and `r_0mviewgvl_i1ig` (feedback from the agent; 3 gate decisions). Each
has `meta.json`, `state.json`, `journal.jsonl`, `snapshots.json`, `specs/` and `reports/`.

**Format 1 is read and written by its own codec** (AGENTS.md, "Stored data and compatibility", rule 5):
a run of format 1 goes on in format 1 to its end, and `status`, `report` and the history read it.
These two runs were written by an early build of the engine, before the published beta. Forks
replaced `pause` by `pauses[]` and added `forks` and a fork attribution to visits; format 1 cannot
hold them, so a run of that format that is asked for one is refused before anything is written
(`UNSUPPORTED_FORMAT_FEATURE`), and the person can upgrade it with `kodel migrate`.
`v1/history/` holds golden event streams of the agent's log, not runs.

They were taken with `node scripts/take-format-fixture.mjs v1 <run dir> ...`, from the run
directories under `.kodel/runs` (or `~/.kodel/projects/<project_id>/runs` with `storage: home`; the files are the same).
Two things differ from the originals:

- The absolute workdir of the run (`meta.json`, `state.json` and the journal) is the placeholder
  `/kodel-fixture/workdir/<run id>`. It does not exist, so a test that needs the workdir of a
  finished run fails. Only those files and `served/*.json` are rewritten; every other file
  (artifacts, patches, specs) is copied byte for byte, and the script refuses a run that holds a
  path of the machine there.
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
stored answer and is not recomputed. A served file written since leaves `answer.workdir` out (the
run's directory is in `meta.json`); the fixtures keep it as they were written, and a reader takes a
served answer with or without it, so the fixtures were not taken again. `history.executor` is on in
the scratch project (it is what stamps the engine version and the client): the script ran with no
`CLAUDE*` variable in its environment and no agent hook index in the scratch repository, so no
`executor` record carries a session or a model, and `history.agent_log` is off (no agent ran, so
there was no conversation to copy). A fixture must hold no identifier of the person who took it:
the guard test (`formats_no_fixture_holds_a_path_of_a_person_or_a_seal`) refuses an observed session
as it refuses a path of a home directory, and the script scans the taken runs for a path of the
machine or of the scratch directory.

## `v1-open/`

Three runs of run-state format 1 left **open** (not finished), written by the real engine of commit
`12f85788cc300f83421e17472ef3d115a8f590a5` (format 1, before forks). They pin what a run that the
beta left going looks like on disk, which `v1/` (finished runs only) does not. The directory name is `v<N>-<tag>`: it maps to the codec of format `<N>`, and the tests that walk the
fixtures (`t41_registry_matches_fixture_directories`, the loop that opens every run) pick it up.

How they were made: a scratch script in a checkout of that commit (`bun scripts/make-v1-open.mjs
<out-dir>`, not part of this repository) drove `LocalPipelineHost` of that commit the way
`scripts/take-v2-fixtures.mjs` does for format 2: a scratch git repository (author `Kodel Fixture
<fixture@example.com>`, `worktree: { mode: auto }`, `history.agent_log` off, no `CLAUDE*` variable),
every step handed out by `nextStep` with `serve`, the agent's files committed before `completeStep`,
the commands (`node -e ...`) run by the real process executor in the run's worktree, and the person's
acceptance of a change made through `pendingChange`/`acceptChange` (what `kodel pipeline changes apply`
calls). The pipelines are tiny and written for these runs; each run's `specs/` holds them as they were.

- `r_0mvxulus6_0m28` (`gate`): `impl` (agent) completed, then the run waits at the human gate
  `approve`: `status: running`, one active visit `approve` #1 in phase `human`, the journal ends with
  `gate_waiting`.
- `r_0mvxulvel_5xgk` (`paused-change`): `impl`, then the command step `test` failed with
  `max_consecutive_failures: 1` and the run paused (`run_paused`, `reason: consecutive`, `pause.blocked`
  from `test` to `fix`). A person edited the run's pipeline file (a slower failing `test` command,
  `max_consecutive_failures: 2`) and accepted it while paused: `pipeline_accepted` with
  `source: file` and `effect: { kind: "reroute", node: "test" }` (the format-1 field; format 2 has
  `effects[]`), two specs. The run went on to `fix`, `test` #2 failed on the new version and the run
  paused again: `status: paused` with a `pause` object, nothing active. While `test` #2 was running,
  a `work_finished` event (`passed: true`) carrying the **old** spec hash was applied through
  `LocalRun.apply`, the path the engine's own command results take; `stale-result.json` records what
  that engine decided: `ok: true, noop: true`, no journal record, the visit still running, i.e. a
  result of another pipeline version is dropped as a repeat. (In format 1 only `work_finished` and
  `check_finished` carry a spec hash; an agent's hand-in carries none.)
- `r_0mvxulxyp_gmed` (`dup-edge`): the agent step `work` has `outcomes: [small]` and a command check
  that fails the first time. `work` #1 was completed with the outcome `small` (`agent_completed`
  `outcome: small`), the check failed (`check_finished` `passed: false`, `node_finished` `failed`,
  `source: check:command`), `work` #2 was entered with that feedback, completed with `small` again and
  passed. The pipeline has two edges `{ from: work, when: small }` (to `first`, then to `second`), no
  `join`; the engine entered `first` (`node_entered first` #1), so the first edge won.
  `routing-result.json` records the edges, the attempts and the target entered. The run is left open
  at `first` #1 (served, not completed).

`stale-result.json` and `routing-result.json` were written by the scratch script from the engine's
own answers and journal; they are not run files. The runs were taken with
`node scripts/take-format-fixture.mjs v1-open <run dir> <run dir> <run dir>` from the scratch
repository's `.kodel/runs`, with the two JSON files already in the directory so that `hashes.json`
covers them; as in `v1/`, the workdir is the placeholder `/kodel-fixture/workdir/<run id>`. An open run
has no `seal.json`. Taking them left `v1/hashes.json` and `v2/hashes.json` byte for byte as they were.

## Later formats

Add a directory when a change renames, removes or retypes a stored field (run state, journal
records, the pipeline snapshot kept with a run, reports). The same change ships:

1. a codec for the previous format: `decode` (the stored text into the engine's model), `encode` (back,
   an allow-list that refuses what the format cannot hold) and its `capabilities`;
2. a real run written by the engine *before* the change, taken with the script above into the new
   directory (`v<N>` or `v<N>-<tag>`), and the tests passing on it: it opens, it is written back as
   it was read, and an open one goes on in its own format.

Keep every `v<N>/` as it is: every one of them must keep opening and, where it is open, going on.
Adding an optional field, or one that only a newer run carries, needs no new directory; the test with
an unknown field already pins that it is kept.

Before the first release, formats may break freely and these fixtures may be replaced; the break
above is the one such break made so far. At the first release this directory is frozen and the rules
above apply to every change.

## `v2-engine/`

Three runs of run-state format 2 with an engine step (T-42, TASK-NNR3: an agent node with `engine:` that
kodel runs itself as a session). Format 2 was amended in place for them (`RunState.engineSession`, the
journal event `engine_session_started`, `source: session` on `node_finished`, `session` on `run_resumed`);
see `docs/run-formats.md`. They were made by `bun scripts/take-v2-engine-fixture.mjs`, which drives
`LocalPipelineHost` with engine steps turned on (`engineSteps: { start: true }` for the server,
`{ start: false }` for the person's host) and the real `PipesSessionAdapter` with its holder; the
engine's programs are Node scripts named by `engines:` profiles of the scratch project. The script
played the agent (`plan`) and the person (`decideHuman` at the gates, `resume`); the owners of the engine
visits are neutral names (`fixture-host:1`, `fixture-host:2`, `fixture-gone:1`). The runs were taken with
`node scripts/take-format-fixture.mjs v2-engine <run dir> <run dir> <run dir>`.

- `r_0mw18z041_oscj` (finished): `plan`, then `review` (the engine step) failed its first session (exit
  1, `command_finished` with `passed: false`), was entered again and passed on its second session
  (`engine_session_started` twice, the result kept in `artifacts/`), its command check ran, and the gate
  was approved. The final state holds no `engineSession`: the record goes when the outcome is proven.
- `r_0mw18z17b_0uiy` (open): `plan`, then `review` #1 running in its session when the run was taken:
  the state holds the open record (`engineSession` with the session's id) and the visit in phase
  `engine` with no heartbeat. The script tried to stop the session after the run was taken; where `ps`
  is not allowed it ends at its own timeout.
- `r_0mw18z1td_qe4s` (finished, `engine-unknown`): a person's host entered `review` (no record); a
  starting host wrote the record and stopped before `start()`; the next server took the waiting over,
  found no session of the name and the attempt failed as unknown (`node_finished` with
  `source: session`, `run_paused` with `reason: consecutive`); the person's `resume` looked the session
  up, found none and cleared the record (`run_resumed` with `session`); the server started attempt 2,
  which passed, and the gate was approved. The takeover's count (`Visit.takeovers`) lived on the visit,
  which the unknown outcome ended, so no stored file holds it; the input `engine_session_joined` is
  not journaled.
