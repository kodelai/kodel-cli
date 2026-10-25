# TASK-4R84: base commit and agent commits in the journal

## Goal

Record in the journal the commit a run started from and the commits the agent made:

- `run_started.base_commit`: the SHA the run's work began at.
- `agent_completed.head`: HEAD of the run's working directory when the agent hands a step in.
- `run_finished.head` and `run_finished.commits`: the final HEAD and the SHAs the agent made,
  amended and reset ones included, capped.

No repository (or an unborn branch) means no such fields. Old runs have none of them and must still open.

## Facts found in the repository

- `packages/local/src/worktree.ts` `GitWorktreeProvider.create` runs `git worktree add -b kodel/<run> <path> HEAD`;
  the SHA that `HEAD` meant is nowhere recorded. `prepare` can also reuse a worktree the caller is in
  (`reusable`), return `undefined` (mode `off`, or no git), or be replaced by `options.workdirs`.
- `packages/local/src/host.ts` `LocalHost.start` (about line 340-385) makes the `start` event; `run_started` is
  logged by `Run.start` in `packages/pipeline-core/src/run.ts` (about line 862) from that event, with optional
  fields spread in (`workdir`, `branch`, `task_key`, `history`). Adding an optional field is additive.
- `agent_completed` is logged in `run.ts` (about line 747); `run_finished` only by `Run.end()` (line 627), called
  from `afterWork`/routing and `cancel`. The core is pure (decide = `(spec, state, event, now, engine)`), so git
  facts must come in through the event, never be read there (principle 4).
- `LocalRun.applyLocked` (`host.ts` about line 925) calls `decide` inside the run lock; `LocalRun.completeStep`
  builds the `agent_completed` event.
- `packages/local/src/git.ts`: `git()` is the one place git is started and always prepends `SAFE_CONFIG`
  (`core.fsmonitor=false`, `core.untrackedCache=false`). `GitSnapshotter` / `repoPrefix` live here too.
- The HEAD reflog of a linked worktree is per worktree (`<gitdir>/worktrees/<name>/logs/HEAD`), so it holds only
  this run's moves; in worktree mode `off` it is the root's reflog and holds older entries too.
- Redaction (`redactEvent`) is applied to the whole incoming event, SHAs are not secrets-shaped but it still
  passes through.
- Stored data rules (AGENTS.md): new optional fields, nothing renamed or retyped, so no migration reader is
  needed; `fixtures/formats/v1` (old runs without the fields) must keep opening with `status` and `report`.

## Design

1. **Base commit.** `Workdir` (worktree.ts) gets `base?: string`. In `create`, run `git rev-parse --verify HEAD`
   first, then `git worktree add -b <branch> <path> <sha>`, so the branch starts exactly at the SHA that is
   recorded (no window in which the person's HEAD moves between the read and the add). For a reused worktree,
   `rev-parse HEAD` inside it. Unborn branch / no commits: `rev-parse` fails, `worktree add ... HEAD` would fail
   too today, so the existing `WORKDIR_CREATE_FAILED` stays as it is; the field is simply absent. When there is
   no provider or it returns `undefined` (mode off, no repo, or `options.workdirs` supplied), the host reads HEAD
   of the root with a small helper; no repo -> no field. `LocalHost.start` passes `baseCommit` in the `start`
   event; `Run.start` journals `base_commit` when given. Also kept in nothing else (the journal is the record).
2. **Git facts helper** in `git.ts`: `readHead(cwd)` -> `string | undefined`; `readCommits(cwd, base, since)`
   -> `{ head, commits, truncated }`:
   - `head`: `rev-parse --verify HEAD`.
   - `commits`: union, newest first, de-duplicated, of `rev-list --max-count=N base..HEAD` and the SHAs of
     `reflog show --format=%H %ct HEAD`, keeping entries from the run's start on (`since`, the `run_started`
     timestamp; the exact time field of a reflog entry is pinned by the real amend/reset test), minus `base`
     itself. The reflog is what
     shows an amended or reset-away commit; `rev-list` alone would lose it. Reflog off or expired: `rev-list`
     alone, nothing fails.
   - Cap `MAX_RUN_COMMITS = 200` (constant next to the helper); when exceeded, keep the newest 200 and the
     result carries `truncated: true`, journaled as `commits_truncated: true`.
   - Every call goes through `git()` (so `SAFE_CONFIG`), plus `-c log.showSignature=false` added to `SAFE_CONFIG`
     (a repository config could otherwise make a log read start `gpg.program`), `--no-textconv` is irrelevant
     (no diff). All failures are swallowed to `undefined`/empty: these facts never fail a step or a run.
3. **`agent_completed.head`.** In `LocalRun.completeStep`, before `apply`, read HEAD in the run's directory
   (`this.cwd()` / the verified workdir, the same one snapshots use; repo root when the run has no workdir) and
   put `head` in the event; `run.ts` journals it with `...(event.head === undefined ? {} : { head: event.head })`.
   The worktree's HEAD is what counts, not the root's.
4. **`run_finished.head` / `.commits`.** `Run.end` cannot read git, so the facts come in through the decide call:
   `decide(spec, state, event, now, engine, facts?)` where `facts = { head?, commits?, commitsTruncated? }`.
   `applyLocked` calls `decide` once without facts; if the resulting journal contains `run_finished` it reads the
   facts (pure and idempotent: nothing was written yet) and calls `decide` a second time with them. `Run.end`
   adds the fields only when given. Only runs that end pay the cost; `tick` and ordinary steps do not.
   `since` for the reflog is the `run_started` timestamp (`state.startedAt`).
5. **Which directory.** One private `gitDir()` on `LocalRun`: the verified workdir if there is one, else the
   project root; if that is not a repository, skip all of it.
6. **Testkit.** `memory-engine.ts` builds events for the scripted agent; the fields are optional, so only
   the fake host needs to leave them out. No change expected.
7. **Report.** `report.ts` reads `agent_completed`; the new fields need no display change (the task asks only
   for the journal); not touched.

## Files

- `packages/pipeline-core/src/run.ts`: `start.baseCommit?`, `agent_completed.head?`, `decide` facts argument,
  `Run.end` fields, `run_started.base_commit`, `agent_completed.head`.
- `packages/pipeline-core/src/index.ts`: export the facts type if `decide` is public.
- `packages/local/src/git.ts`: `readHead`, `readRunCommits`, `MAX_RUN_COMMITS`, `log.showSignature=false`.
- `packages/local/src/worktree.ts`: `Workdir.base`, create from the read SHA, reuse reads HEAD.
- `packages/local/src/host.ts`: pass `baseCommit` in `start`; head in `completeStep`; two-pass `decide` in
  `applyLocked`.
- Tests (below). No new dependency.

## Tests (names carry the task id, e.g. `t4r84_...`)

- `worktree.test.ts`: `base_commit` equals HEAD at start (new worktree, reused worktree); root HEAD moved by the
  person after the start does not change it; mode `off` records the root's HEAD; no repo -> no field; unborn
  branch -> no field (start behaviour unchanged); detached HEAD -> the SHA.
- `git.test.ts`: `readRunCommits`: two commits -> both, newest first; `commit --amend` -> both the old and the new
  SHA; `reset --hard` back -> the dropped commit is still listed, head is the earlier one; no commits ->
  `commits: []`; detached HEAD; `core.logAllRefUpdates=false` -> `rev-list` result only, no error; cap and
  `truncated`; a branch renamed or deleted by the agent (HEAD is what is read); shallow clone (`base..HEAD`
  stops at the boundary, no error).
- `host.test.ts`: the three events carry the fields in a real run (agent commits twice, completes the step,
  run ends); `agent_completed.head` is the worktree's HEAD, not the root's; a run without a repository has no
  fields; `tick` and non-ending events do not call git for commits (spy on the executor/`git` helper).
- Unit (`pipeline-core`): `run_started`, `agent_completed`, `run_finished` carry the fields when the event/facts
  have them and omit them otherwise; the journal of an old run replays unchanged.
- `hardening.test.ts`: a repository whose `.git/config` sets `core.fsmonitor`, `log.showSignature=true` with
  `gpg.program` pointing at a marker script, `core.pager`, and a `reference-transaction`/`post-checkout` hook
  cannot make the base/HEAD/commits reads run the marker (SAFE_CONFIG; the empty hooks dir used at `worktree add`
  is kept).
- Fixture: the existing `fixtures/formats/v1` runs (no such fields) still open with `status` and `report`
  (`formats.test.ts`); nothing is added or changed in the fixtures.

## Risks and corner cases

- Reflog disabled/expired: fall back to `rev-list`; amended commits are then not shown. Documented in the code
  comment, not an error.
- Submodules: only the superproject HEAD is read; submodule commits are out of scope.
- Windows: `git` is called with `cwd`, no path is built into arguments except `base..HEAD`; path comparison is
  not needed.
- The root HEAD moved by the person during the run does not matter: everything is read in the worktree.
- A run in worktree mode `off` shares the root's reflog: the `since` cut-off and `base` exclusion bound it, but
  the person's own commits during the run are listed too (in that mode there is no way to tell them apart);
  stated in the comment.
- `decide` twice on a run end: pure, no side effects before the second call; must keep the same `now`.
- The reflog line format (`%at` vs `%ct`) must be pinned by the real amend/reset test.
- Merge order: the task changes `run_started` like tasks 4, 8 and 9; this one merges after TASK-36HG and TASK-CXSE
  (both already in `origin/main`), and conflicts in `run.ts`/`host.ts` `start` are resolved by keeping every
  optional field.

## Implementation notes

- All new tests are in `packages/local/test/run-commits.test.ts` (git helpers, base commit, end-to-end journal,
  event unit tests, hardening) instead of being spread over `worktree.test.ts`, `git.test.ts`, `host.test.ts` and
  `hardening.test.ts`; the cases listed above are all covered there. The cap test builds 203 commits with one
  `git fast-import`.
- `decide` takes the facts as a sixth argument (`RunFacts`), not inside `EngineOptions`, since they belong to one
  call, not to the engine.
- The run's journal is read once at the end of a run to find `run_started.base_commit`; the state does not carry it.
