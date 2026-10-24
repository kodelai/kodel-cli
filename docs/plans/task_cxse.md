# TASK-CXSE: `history` config section and start without git

## Goal

One nested `history` section in `.kodel/config.yaml` in which every category of sensitive data can be
switched off, the effective values recorded in `run_started.history` and fixed for the run, and a clear
refusal (stable code, message naming the setting) to start a run without git when
`history.changes.enabled` is on.

This task adds the switches and the start check only. Nothing yet writes patches, output, prompts,
executor data or tool logs; the later tasks of the series read `run_started.history` and honour it. A
disabled category writes nothing at all is a contract for them, tested here as far as it can be (the
recorded values and the category list).

## Facts found in the repository

- `packages/local/src/config.ts`: `ProjectConfig { version, worktree, pipeline, agent_hints, tasks }`,
  one strict zod schema with every key optional, `loadConfig(storeRoot)` merging with defaults
  (`DEFAULT_*` constants). Unknown keys fail with `CONFIG_INVALID` naming the key. A missing optional
  section needs no version bump. `config.local.yaml` does not exist yet (TASK-6E84).
- `packages/local/src/host.ts:273` (`LocalHost.start`): `needsGit` is true when a check's `baseline()`
  is set; it then throws a plain `Error` ("this pipeline has a diff check, which needs a git
  repository, ..."). The check runs before the worktree is prepared and before anything is written,
  so a refused start leaves nothing behind. `GitSnapshotter.isRepo()` (`git.ts:80`) is
  `git rev-parse --is-inside-work-tree` and returns false for: no git, binary missing, a bare
  repository, a directory outside the repository (all the corner cases collapse to one "false").
- `packages/local/src/pipeline-host.ts:447`: `start()` loads the config at each start (skipped when
  `options.worktree` is injected by a test) and passes `worktree` etc. to `LocalHost.start`.
- `packages/pipeline-core/src/run.ts:167,837`: the `start` event and the `run_started` journal record;
  the record already carries optional `workdir`, `branch`, `pipelineFile`. A new optional field is
  additive, so the stored format stays v1-readable; golden fixtures in `fixtures/formats/v1` have no
  `history` and must still open.
- `packages/pipeline-core/src/errors.ts`: `ERROR_CODES` is the closed list of stable codes.
- `minimatch` is already a dependency of `pipeline-core` (`checks.ts`).

## Affected files

New:
- `packages/pipeline-core/src/history-config.ts`: the pure part, exported from the index:
  `HISTORY_CATEGORIES = ["changes","output","prompts","executor","tool_log"] as const`,
  `HistoryConfig` type, `DEFAULT_HISTORY` (all enabled; `changes.exclude: []`, `changes.max_kb: 512`,
  `output.max_kb: 64`), `isValidGlob(pattern)` (minimatch `makeRe` returns `false` for an invalid one).
  Types and defaults live in the core because the run record and later the server use them; there is
  no I/O.
- `docs` change: none (English docs come after the first working version).

Changed:
- `packages/pipeline-core/src/errors.ts`: add `GIT_REQUIRED` (name settled here; stable).
- `packages/pipeline-core/src/run.ts`: `start` event gets optional `history?: HistoryConfig`;
  `run_started` journals it when given. Test fakes (`testkit/memory-engine.ts`) need no change since
  the field is optional.
- `packages/local/src/config.ts`: `ProjectConfig.history: HistoryConfig`; zod section, strict at every
  level:
  `history: { changes: { enabled, exclude: string[] (each a valid glob, non-empty), max_kb: int >= 1 },
  output: { enabled, max_kb: int >= 1 }, prompts: { enabled }, executor: { enabled },
  tool_log: { enabled } }`, all keys optional; defaults merged per key (a partial `changes` keeps the
  other defaults). Zero, negative, fractional `max_kb`, non-array `exclude`, and bad globs give
  `CONFIG_INVALID` naming the path. Defaults when there is no file also include `history`.
- `packages/local/src/host.ts`: `start(task, options)` takes `history: HistoryConfig`; `needsGit` is
  true also when `history.changes.enabled`. Both refusals become
  `KodelError("GIT_REQUIRED", ...)`:
  - changes on: "this run records changes (history.changes.enabled) and needs a git repository, but
    <root> is not inside a git work tree (or git is not installed): set history.changes.enabled to
    false in .kodel/config.yaml, or run kodel inside a git repository";
  - diff check only: the old text, now with the same code (the code is unified, the text stays).
  Passes `history` into the `start` event.
- `packages/local/src/pipeline-host.ts`: read `config.history` with the other settings at each start
  (load the config also when `worktree` is injected, or accept an injected `history` option for
  tests) and pass it down. Values are read once per start and live in the journal, so editing the
  config mid-run changes nothing for that run.

Not changed: `.mcp.json`, `.claude/settings*`, `.kodel/pipelines/`, `kodel init` (defaults live in
code), the MCP tool schemas (the code reaches the user through the existing error path; verify that
a `KodelError` thrown from `start` becomes `{ok:false, code, message}`).

## Steps

1. Core: `history-config.ts`, export, `GIT_REQUIRED`, the `start` event field and the `run_started`
   record.
2. Config: the schema and merge in `config.ts`, with a one-line comment on why the section is strict.
3. Host: the `needsGit` condition, the `KodelError`, the event field.
4. Pipeline host: pass the effective history to `start`.
5. Tests (below), then `bun run typecheck && bun run lint && bun test`, then
   `bun run build && node scripts/check-artifact.mjs`.

## Test strategy

Names carry the task's behaviour; the decision ids are the series' (none is cited by the task text, so
none is invented).

- `packages/local/test/config.test.ts`: defaults with no file and with a file lacking the section;
  each key set alone (partial `changes` keeps `max_kb: 512`); an unknown key refused by name, at the
  top of `history` and inside `changes`; wrong types (`enabled: "yes"`, `exclude: "a"`); `max_kb` of
  0, -1 and 1.5; bad globs in `exclude` (`"["`, empty string); the section absent.
- `packages/local/test/host.test.ts`: start in a non-git temp directory fails with `GIT_REQUIRED` and
  the message contains `history.changes.enabled` when changes is on; succeeds when off; a directory
  inside a git repository's subdirectory works; a pipeline with a diff check in a non-git directory
  still fails with the same text (now with the code); `run_started.history` equals the effective
  values (defaults, and a non-default config); editing the config after start does not change the run's
  record, and a second run started after the edit has the new values; a refused start leaves no run
  directory, no worktree and no branch.
- Corner cases: git binary missing (run with `PATH` emptied for the snapshotter; same code and a
  message that does not blame the directory only); a bare repository; a directory outside the
  repository (git exists but `rev-parse` says so); resuming a run whose `run_started` has no
  `history` (the golden v1 fixtures: `status` and `report` still open them, existing
  `formats.test.ts`).
- CLI (`packages/cli/test`): `kodel` start path in a non-git directory prints the message with the
  setting name and the code; MCP: the `pipeline_start` tool returns `{ok:false, code:"GIT_REQUIRED",
  message}` (extend `mcp.test.ts`).
- `every_history_category_has_a_switch`: compares `HISTORY_CATEGORIES` (the categories the engine can
  write) with the keys of the zod `history` schema and with `DEFAULT_HISTORY`, in both directions, so a
  new category cannot be added to one and forgotten in the other. Fails if a category has no
  `enabled` key.

## Risks and decisions to confirm

- **Code name** `GIT_REQUIRED` is a new stable code; it is public once released. Settled here as the
  task proposes.
- **Old runs**: a `run_started` without `history` means "recorded before the section existed", not
  "all on". This task records nothing for them and invents no value; the later tasks that read the
  field must treat absence as "no history of that kind was written" (stated in the code comment and
  to be carried into their plans). Rewriting old journals is forbidden by AGENTS.md.
- **`config.local.yaml`** (TASK-6E84) will merge over this section; the merge happens before the zod
  parse or on the result, so the section needs nothing now. Not implemented here.
- **Git check is coarse**: `isRepo()` folds "git missing", "bare" and "outside repository" into false.
  The message names all three possibilities instead of changing `isRepo` (kept small; a finer
  diagnosis can come later).
- **Merge order**: this changes `run_started` with TASK-7/8/9; keep the new field optional and
  appended after `pipelineFile` to reduce conflicts.
- The working copy of the main checkout has uncommitted files (`docs/plans/...`, `todo.md`) that this
  worktree does not have; none is needed for this task.
