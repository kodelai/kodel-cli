# Run title from the agent: optional `title` on `pipeline_start`

## Goal

The agent may name a run: `pipeline_start` gets an optional `title` (English, 2-5 words, kebab-case,
e.g. `pipeline-version-field`). The engine validates it, stores it in the run as its slug and exposes
it to nodes as `{{run.slug}}`. Without a title the slug is made from the task text. A second new
placeholder, `{{run.start_date}}`, holds the day the run started (`YYYY-MM-DD`), so a pipeline can
build a name such as `docs/plans/{{run.start_date}}-{{run.slug}}.md`. The slug is shown in `status`
and `report`.

## Decisions

Confirmed by the person (todo.md line 26 and the review of the first version of this plan):

1. **Title** is validated by the engine: `[a-z0-9-]` only, non-empty, at most 40 characters, no `..`
   (stated even though the alphabet already rules it out, so a later widening cannot let it through).
   A leading, trailing or doubled `-` is refused too.
2. **`run.slug` has no date and no suffix.** It is the validated title; with no title it is
   `slugify(task)` with `_` turned into `-`, capped to the same 40 characters.
3. **`run.slug` is not unique.** The identity of a run is its `runId`; the slug is a label. See
   "Collisions" below for what that means in each place it is used.
4. **`{{run.start_date}}`**: `YYYY-MM-DD` in UTC, taken from `state.startedAt` (already stored), so it
   needs no new stored field and also works for runs that started before this change.
5. **A bad title is refused before anything is made.** `pipeline_start` answers
   `{ok:false, code:"INVALID_ARGUMENTS", issues:[{path:["title"], message}]}` (an existing code, so the
   error-code list and its test of 34 codes do not change). Since the run's git worktree and branch are
   created before the run record, the check runs first, in `PipelineService.start`, before any host call.
6. **An active run picked up again keeps its title; a `title` passed then is ignored.** The title is
   validated in every case (the service cannot know yet whether the run is reused), so a bad title is
   refused even when it would have been ignored: simpler and the same answer every time.
   `restart: true` is a new run with the new title.
7. `{{task.slug}}` stays unchanged, so existing pipelines keep working. `.kodel/pipelines/dev.yaml` is
   **not** changed by the agent (AGENTS.md): the person replaces `{{task.slug}}` with `{{run.slug}}`
   (and adds `{{run.start_date}}` if wanted) between runs, never mid-run.

## Collisions (slug is not unique)

The engine never needs the slug to be unique: run directories, locks, the journal, worktrees and
branches (`kodel/<runId>`) and every tool call are keyed by `runId`. The slug matters only where a
pipeline author puts it into a string:

- **State, journal, `status`, `report`:** the slug is shown next to the `runId`; two runs with the same
  slug are two rows, told apart by `runId`. Nothing is merged or looked up by slug.
- **Finding a run to pick up:** unchanged, by pipeline and task text. The title plays no part in it.
- **A path in a pipeline (`files`, `diff` check paths, prompts):** since each run now works in its own
  git worktree, two runs with the same slug do not write the same file on disk; the collision shows
  up when their branches are merged (the same path changed twice, an ordinary git conflict) and in
  the repository's history. The engine does not detect or prevent it. A pipeline that must keep
  names apart adds `{{run.start_date}}`, or the agent uses another `title`. This is said next to the
  placeholders in `examples/pipelines/feature.yaml`.
- **A run that works in the repository root** (`worktree.mode: off` in the config): two
  active runs with one slug and path would write one file. Accepted, documented; not detected.
- **Not done on purpose:** no suffix, no registry, no check against other runs or branches (a check
  cannot see other people's runs, and a suffix chosen locally would collide anyway).

## What changed in the code since the first plan (and how this plan takes it in)

Checked against `HEAD` 9fe501c, in this run's worktree:

- Runs now work in a git worktree, made in `GitWorktreeProvider.prepare` **before** `store.createRun`
  (`local/src/host.ts` `LocalHost.start`). Validation therefore moves up to the service (decision 5).
- `PipelineHost.start` (`local/src/pipeline-host.ts`) now takes `cwd` and `pipeline_version` and may
  throw `ChoiceNeeded` before any run exists; `title` is one more optional field on this path and plays
  no part in `runExists` / the pipeline-version choice.
- Placeholders are rendered in **five** places, not three: `run.ts` (`Machine.render`, `emitCheck`),
  `next-step.ts:222`, `service.ts:375` (`plan` dry run) and `local/src/host.ts:1507` (check params of a
  result report). All of them build `{ task: state.task }` by hand. This plan adds one helper,
  `renderContextOf(state)`, used by all four state-based callers, so the next placeholder is a change in one place.
- `RunMeta` is `v: 2` (`META_VERSION`) and `RunState` is `v: 1` with optional fields added over time
  (`workdir`, `pipelineFile`, `proposals`). The slug follows the same pattern: an optional field,
  no version bump.
- `status` prints a table with a header row (`RUN PIPELINE STATUS WORKDIR TASK`, `--no-headers`).
- The error-code list is checked by a test that counts 34 codes; reusing `INVALID_ARGUMENTS` leaves it alone.
- `pipeline_start` already has `cwd` and `pipeline_version`; `title` is added beside them and the
  tool description stays short.
- `pipeline-core/agent-docs/*.md` (served by `pipeline_docs`) lists the placeholders; it must say the
  new ones (see Affected files).

## Affected files

- `packages/pipeline-core/src/slug.ts`: `validateTitle(title): string` (returns the title or throws
  `KodelError("INVALID_ARGUMENTS", reason, { issues })`), `runSlug(title | undefined, task): string`,
  `MAX_TITLE_LENGTH = 40`, `startDate(ms): string`. Pure: a timestamp in, a string out; no clock access.
- `packages/pipeline-core/src/render.ts`: `RenderContext` gets `run?: { slug: string; startDate: string }`;
  `{{run.slug}}` and `{{run.start_date}}` are replaced when the context has a run; `renderContextOf(state)`
  builds the context from a `RunState` (the stored slug, or `runSlug(undefined, task)` for a run without one).
- `packages/pipeline-core/src/run.ts`: `RunState.slug?: string`; the `start` event carries `slug`; `decide`
  stores it; the `run_started` journal record includes it; `Machine.render` and `emitCheck` use `renderContextOf`.
- `packages/pipeline-core/src/next-step.ts`, `packages/local/src/host.ts` (the `renderDeep(params…)` call):
  use `renderContextOf(state)`.
- `packages/pipeline-core/src/pipeline.ts`: `PLACEHOLDERS` gains `"run.slug"` and `"run.start_date"`; both are
  allowed in a `command` like `task.slug` (digits, lower case and `-` cannot carry shell syntax); the
  message near line 259 names them as the safe replacements for `{{task}}`.
- `packages/pipeline-core/src/service.ts`: `start(input)` takes `title?`, validates it first, passes it down;
  `plan()` (a dry run, no run exists) renders `{{run.slug}}` from the task and leaves `{{run.start_date}}`
  as the literal text `YYYY-MM-DD`.
- `packages/pipeline-core/src/mcp/tools.ts`: `title` in the `pipeline_start` shape (`z.string().max(…)`; the
  description gives the form: English, 2-5 words, kebab-case) and in the server instructions. The schema does
  not enforce the pattern: the engine does, so the agent gets the reason.
- `packages/pipeline-core/src/report.ts`: `RunReport.slug`; `packages/cli/src/format.ts`: slug in the first line
  of `report`; `packages/cli/src/cli.ts`: `status` list gets a `SLUG` column (and `slug` in `--json`), `status <run>`
  a `slug:` line; all through `plain()` so it cannot move the cursor.
- `packages/local/src/pipeline-host.ts`, `packages/local/src/host.ts`: pass `title` through `PipelineHost.start`
  to `LocalHost.start(task, { …, title })`; compute the slug there and send it in the `start` event.
  `packages/local/src/store.ts`: `RunMeta.slug?` (optional, so older `meta.json` files read as before).
- `packages/pipeline-core/agent-docs/pipeline-spec.md` (and `examples.md` if it lists placeholders): the two new placeholders.
- `examples/pipelines/feature.yaml`: header comment lists the new placeholders and the collision note.

## Stored data and compatibility (AGENTS.md)

`RunState.slug` and `RunMeta.slug` are **added** optional fields, not renamed or retyped, so rule 1 needs no
migration. Old runs have no slug: readers (`status`, `report`, `{{run.slug}}` in a run that started before
this change) compute it with `runSlug(undefined, state.task)`; `{{run.start_date}}` comes from `startedAt`.
Nothing is rewritten on disk. A pipeline snapshot kept with an old run is parsed by the reader of its own
format and cannot contain `run.*` placeholders, so rule 2 is not touched. A test opens a state and a
`meta.json` without `slug` and checks `status` and `report` (`fixtures/formats/v1` is not extended: it is
frozen at the first release).

## Steps

1. Tests first (red): `slug.test.ts` (`validateTitle`, `runSlug`, `startDate`), `render.test.ts` (the two placeholders, `renderContextOf`).
2. Implement `slug.ts`, `render.ts`, the placeholder list in `pipeline.ts`.
3. `run.ts` state, event and rendering; `next-step.ts`; `report.ts`.
4. `service.ts` (validate first), MCP tool shape and instructions, `agent-docs`.
5. Host (`host.ts`, `pipeline-host.ts`, `store.ts`), including the `renderDeep` call at `host.ts:1507`.
6. CLI output (`status`, `report`).
7. Example pipeline comment. Run `bun run typecheck`, `bun run lint`, `bun test`, `bun run build && node scripts/check-artifact.mjs`.

## Test strategy

- `validateTitle` accepts `pipeline-version-field`; refuses empty, uppercase, spaces, `_`, `..`, `/`, non-ASCII,
  leading/trailing/doubled `-` and 41 characters; each refusal has a readable reason.
- `runSlug`: the title as given; with no title, a stable slug from the task within the cap, only `[a-z0-9-]`.
- `startDate` formats a timestamp as UTC `YYYY-MM-DD`, including around midnight UTC.
- `{{run.slug}}` and `{{run.start_date}}` render in prompts, `files`, check params and result-report params
  (the four state-based callers share `renderContextOf`); both are accepted in a `command`; an unknown
  placeholder is still refused at parse time and the message lists them.
- Service/host: a valid title lands in the state, `meta.json` and the `run_started` record; an invalid one
  returns `{ok:false, code:"INVALID_ARGUMENTS"}` and leaves **no** run directory, **no** worktree and **no** branch
  (the check runs before `prepare`); reuse keeps the first title and ignores a new valid one;
  `restart: true` with another title makes a new run with that title.
- Collisions: two runs with the same title get different `runId`s, both appear in `status`, neither affects the
  other's state; the second is not blocked (documents decision 3).
- MCP: `pipeline_start` lists `title`; a bad title reaches the agent as the refusal message with the field name.
- CLI: `status` (table and `--json`), `status <run>` and `report` show the slug; a state without a slug still prints.
- `agent-docs/pipeline-spec.md` (line 18 lists `{{task}}` and `{{task.slug}}`) names the new placeholders; a test
  in `docs.test.ts` asserts it, so the served documentation cannot fall behind the placeholder list.

## Risks

- **Idempotency of `pipeline_start`**: declared idempotent. A second call with another valid title must not
  change the run; covered by the reuse test.
- **Silent overwrite on collision**: only for runs that share a working directory and a path (decision 3).
  Accepted; the mitigation is in the pipeline (`{{run.start_date}}`, another title) and in the documentation.
- **Path safety**: the slug is part of file paths. The alphabet rules out separators and `..`, and the cap bounds
  the length. The title is agent input (principle 1), so it is redacted like the task before it is stored; if
  redaction changes it, it is refused, otherwise the stored slug would differ from the path a plan was written under.
- **Mid-run pipeline change**: switching `dev.yaml` to `{{run.slug}}` while a run is active makes the pipeline
  differ from the run's copy and waits for the person; that is why the person does it between runs.
- **A start refused after the worktree exists**: avoided by validating first; the existing cleanup in
  `LocalHost.start` still removes the worktree if the later steps fail.
- **Date and time zone**: `start_date` is UTC, so a run started late in the evening local time can carry the
  next day's date. Stated in the example comment.
- **Dry run**: `plan` shows `YYYY-MM-DD` for `{{run.start_date}}` because no run exists yet; said in the tool text.
