# TASK-XJPC: find the project root in one place (marker-based)

## Goal

One function, `findProjectRoot(cwd, { explicit, env })` in `packages/local`, returns
`{ root, dataDir, via, worktreeOf? }`. A project is a directory with a committed `.kodel/config.yaml`
(written later by `kodel init`, TASK-9M7X, out of scope). `dataDir` is `<root>/.kodel` for now
(TASK-N5R4 may move it); every caller takes `dataDir` instead of building `<root>/.kodel` by hand.
The CLI default of `--root`, the MCP server and the pipeline host use it, so a command run in a
subfolder or in a linked worktree reads and writes the project's own store (the main checkout's, for a
linked worktree). No marker means `NO_PROJECT`; there is no fallback store and `~/.kodel` is never used.

## Resolution order

1. Explicit `--root`, else `KODEL_ROOT` (non-empty): used as is, `via: "explicit"`, even if it is a linked
   worktree: no remap, no warning, no marker needed (a caller who names the root knows).
2. Nearest marker upward from `realpath(cwd)` (a directory that has a file `.kodel/config.yaml`; a
   `.kodel` with only `pipelines/` is not a project). The walk stops at the top of the git repository
   `cwd` is in (`git rev-parse --show-toplevel`); if git answers nothing (not a repo, or git missing)
   it goes up to the filesystem root. A `.kodel` that is `os.homedir()/.kodel` is skipped.
3. If `cwd` is inside a linked worktree: `git rev-parse --git-common-dir` (absolute, realpath);
   accepted only when it is a folder named `.git` (a submodule's `.git/modules/x`, a bare repo or a
   `gitdir:` pointer we would have to read are not accepted: work in place). The main checkout is its
   parent; the marker's path relative to the worktree top is mapped into the main checkout, and
   that mapped directory must itself hold a marker, otherwise work in place. `worktreeOf` records the
   main checkout. Git failing or missing = work in place, silently.
4. Nothing found: `KodelError("NO_PROJECT", "no Kodel project here (no .kodel/config.yaml in this folder or above); run \`kodel init\` here, or pass --root")`.
5. Monorepo: each package may have its own marker; the nearest wins, no merging; `--root` picks another.

Stderr notes (CLI only, never stdout, also under `--json` and `mcp`): `using the project at <path>: you
are in a worktree of it` on a mapping from a linked worktree; one line when the walk climbed above cwd
without a git boundary (the message names the root it settled on); nothing for a plain subfolder in a repo.

## What reading the code settled

**(a) Where a run of a package project works.** Today `GitWorktreeProvider.create` runs
`git worktree add -b kodel/<run> <dir>/<run> HEAD` with `this.root` as git's cwd: the worktree is always
of the whole repository, and `LocalRun.cwd()` (`host.ts` ~l.464) returns `workdir.path`, the worktree
TOP. For a project whose root is `<repo>/pkg` that is wrong: commands, checks, the snapshotter
(`new GitSnapshotter(cwd)`; its `--show-prefix` already copes with a subfolder) and the pipeline-file
copy (`watched()` joins `state.pipelineFile`, relative to the root, onto `state.workdir`) would all work
at the repo top. Decision: the run works in the SAME subfolder inside its worktree, `<worktree>/<rel>`,
where `rel` = path of the project root relative to the repo top (empty for a repo-root project, so
today's behaviour is unchanged). Implementation: keep the worktree top as `Workdir.path` for git
operations (`verify`, `discard`, `reusable`), add the `rel` join where the run uses its directory
(`cwd()`, `watched()`, `pipelineCopy` target, the `workdir` shown to the agent and in `doneHint`).
The worktrees folder (`worktree.dir`, default `.kodel/worktrees`) stays resolved against the project root,
i.e. `<dataDir>/worktrees`, so it is inside the main checkout. A worktree is of the whole repo, so a
monorepo run sees all packages but works in its package. `reusable()` (the caller already is in a
kodel worktree) compares worktree tops, which stays correct, and then the subfolder is applied.
This is the one place where the engine's behaviour changes beyond root lookup, so it gets its own test.

**(b) Nested repositories and submodules.** `git rev-parse` answers for the nearest repository, and the
walk stops at that repository's top, so a marker above a nested repo or submodule is not used from
inside it: `NO_PROJECT` there unless the nested repo has its own marker (or `--root`). This is intended
(the nearest repository is the boundary). A submodule's common dir is `.git/modules/<name>`, not a
folder named `.git`, so it is never remapped. A test is needed and cheap: superproject with a marker +
`git init` nested folder / a submodule without marker gives `NO_PROJECT`; with its own marker gives that
marker; a linked worktree of the superproject still maps.

**(c) Places that build `<root>/.kodel` by hand (all take `dataDir`).**
`packages/cli/src/cli.ts:133-134` (`host()` and `storeRoot()`), `packages/local/src/host.ts:236`
(`options.storeRoot ?? \`${root}/.kodel\``), `packages/local/src/pipeline-host.ts:81` (same default; it also
derives `pipelines/` and loads the config from it), `packages/local/src/config.ts:12` (`DEFAULT_WORKTREE_DIR
= ".kodel/worktrees"`, resolved against the root in `worktree.ts` `resolveDir`), the default exclude
`[".kodel"]` in `git.ts:77` and `:(exclude).kodel` in `worktree.ts:196` (these stay hard-coded on
purpose: git runs with the project folder as its cwd, so the pathspec and the `ls-files` paths are relative
to the project and already exclude `<rel>/.kodel` for a package project), `tasks/index.ts` (`storeRoot` option; already takes a resolved dir), and the integrity key in
`integrity.ts` (derived from the store root, so it follows). `LocalPipelineHost` and `openTaskService`
keep taking an already resolved `root`/`storeRoot`, so tests with explicit roots are unaffected. The
`mcp` command resolves once at start. `.mcp.json` runs the server from the repo root, so it keeps working.

**(d) Existing tests.** Tests that go through `runCli` (`packages/cli/test/cli.test.ts`, `tasks.test.ts`)
set `env.cwd` to a temp dir (some without git) and rely on the cwd being the root; `packages/local/test/*`
and `tests/agents/*` build `LocalPipelineHost` with an explicit `root`, so they are unaffected.
For the CLI tests the shared helper that writes the temp project gets a `.kodel/config.yaml` marker
(an empty/default one is valid config), or the test passes `--root`; the NO_PROJECT tests use a bare dir.
This repository must commit its own `.kodel/config.yaml` (today it is untracked), otherwise running the
CLI/MCP from this repo would fail with NO_PROJECT; to be told to the person, since a committed file is
a decision about its content. Also: a linked worktree of THIS repo has no config.yaml until it is
committed (untracked files are not in a worktree), so the first run's worktree cannot be a marker
location; mapping needs the marker in the worktree. Open question for the person: in a linked worktree
with no marker, should the walk also try the main checkout's same relative path? The plan assumes NO
(spec as written) and `NO_PROJECT` there.

## Affected files

- `packages/local/src/project-root.ts` (new, exported from `index.ts`): `findProjectRoot`.
- `packages/cli/src/cli.ts`: `--root` without a static default; memoized `resolveProject()` feeds `host()`,
  `storeRoot()` (= `dataDir`) and `mcp`; stderr notes; `UserError` for `NO_PROJECT`.
- `packages/cli/src/mcp-server.ts`: `createNoProjectServer(error)`: registers the pipeline tools on a host
  whose every method throws `KodelError("NO_PROJECT")` so `tools/list` works and each call answers
  `{ok:false, code:"NO_PROJECT", message}`; no `task_*` tools there (tasks on/off is unknown).
- `packages/local/src/host.ts`, `pipeline-host.ts`, `worktree.ts`, `git.ts`: a `projectRel` (root relative to
  the repo top), per (a); the git excludes stay as they are, per (c).
- `packages/pipeline-core/src/errors.ts` + `test/errors.test.ts`: `NO_PROJECT`, count 34 to 35.
- `docs/tasks.md` (fix the claim that tasks from a run's worktree always reach the main `.kodel`) and a
  short docs section "How the project is found".
- Tests: `packages/local/test/project-root.test.ts`, `packages/cli/test/project-root.test.ts`, a worktree
  test for (a).

## Test strategy

- `findProjectRoot`: git repo + linked worktree + subfolder (all give the same store); non-git folder with a
  marker, also from a sub-subfolder, with the climbing note; no marker anywhere = `NO_PROJECT` text and code;
  `.kodel/pipelines/` without `config.yaml` is not a project; explicit `--root` and `KODEL_ROOT` win over
  everything (`--root` over `KODEL_ROOT`) and a linked worktree given explicitly is not remapped; symlinks
  (realpath, `/var` vs `/private/var`); a worktree whose `.git` file points elsewhere gets only what git
  reports (a fake `gitdir:` target is not trusted; a non-`.git` common dir is not remapped); `~/.kodel`
  (fake HOME) is skipped; git missing (PATH without git) works in place; nested repo and submodule per (b).
- Monorepo: two packages with nested markers (and a marker at the repo top): the nearest wins from
  each package, from the main checkout and from a linked worktree (mapped into the same package of the main
  checkout); `--root` picks another.
- CLI: `task add` / `status` from main, worktree, subfolder use one store; stderr lines for worktree yes,
  subfolder no, climbing yes; never on stdout, also with `--json`.
- MCP: no marker: server starts, `tools/list` works, every tool answers `NO_PROJECT`, no `task_*` tools;
  from a worktree and a subfolder the tools see the same runs.
- Engine (a): a package project run: the workdir the agent gets is `<worktree>/pkg`, a command runs there,
  the diff check sees only package changes, the pipeline copy lands in `<worktree>/pkg/.kodel/pipelines`
  at the right relative place; a repo-root project behaves exactly as before.
- Full `bun run typecheck`, `lint`, `bun test`, `bun run build && node scripts/check-artifact.mjs`.

## Risks

- (a) is the largest change: `Workdir.path` stays the worktree top for git calls, and every consumer of the
  run's directory must use the joined one; a missed one makes a package run work at the repo top. Runs
  started earlier have no `rel` (repo-root projects) and are unaffected.
- Existing tests with temp dirs fail with `NO_PROJECT` until given a marker; check the suite early.
- Untracked config in this repository (see (d)); the person must commit it.
- A marker present in a worktree but with different content from main: main's is used after mapping.
- git failure modes (missing, dubious ownership) fall back to in-place silently; the climbing note covers
  the no-git case only.
