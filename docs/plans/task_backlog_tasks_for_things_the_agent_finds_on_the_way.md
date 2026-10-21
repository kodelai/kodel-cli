# Tasks: a small local backlog for what the agent finds on the way

## Goal

While working, the agent often meets a problem it should not solve now (a bug elsewhere, a missing test, an
odd design). The person says "create a task" and the agent writes it down, so it is not forgotten. Later the
person asks "what is important there?" and the agent lists the open tasks.

This is a parking lot, not a tracker: no assignees, comments, custom fields or workflows. Tasks are **off by
default**: with the default config the MCP server does not expose the task tools at all; the person turns
them on in `config.yaml`.

## Decisions

1. **Statuses**: `todo`, `progress`, `done`, `declined`. Any status may be set from any other (no transition
   rules). New tasks are `todo`.
2. **Priority**: `low`, `normal` (default), `high`. `task_list` orders by priority, then by creation time.
3. **Storage**: one YAML file per task, `<store root>/tasks/<id>.yaml` (default `.kodel/tasks/`). One file per
   task means two branches adding tasks never conflict. Whether the folder is committed is the person's
   choice (the repository does not ignore it).
4. **Id**: `t_<time in base 36>_<random>`, built like the run id (`t_0mvimom50_ym0u`). Every host checks it
   against `TASK_ID_PATTERN` before it reaches a path. The CLI also accepts any unique prefix of an id.
5. **Format**: stored data, so `v: 1` on the record and the compatibility rules of AGENTS.md apply from the
   start (a reader that migrates in memory on read when the shape changes; golden fixture once v1 is frozen).
6. **Off by default, on in config**: `config.yaml` gets `tasks: { enabled: false }` (default). When it is
   `false`: `registerPipelineTools` does not register `task_*`, the server instructions do not mention them,
   and the CLI `task` commands refuse with the line that says how to enable them. The config is read when the
   MCP server starts, so turning tasks on needs a restart of the server (said in the refusal and in `docs`).
7. **Tool names**: `task_create`, `task_list`, `task_update` (the person accepted the overlap with the
   `task_*` tools of the hosted Kodel).
8. **Not a trust decision**: tasks carry no gate or approval meaning, so the agent may create and update them
   (principle 6 is not touched). The server instructions tell it to change a status only when the person asks.
9. **Origin**: `task_create` takes an optional `run` (a run id, checked against `RUN_ID_PATTERN`) and an
   optional `step`. The engine does not guess the current run; the agent passes it when it is in a run.
10. **Redaction**: `title` and `body` go through `redact` before they are written (principle 3). As with
    the run title, text that redaction changes is accepted in its redacted form (unlike a slug, nothing else
    depends on the exact text).

## Shape

```yaml
v: 1
id: t_0mvimom50_ym0u
title: Fix the off-by-one in report durations
body: |
  Seen in packages/pipeline-core/src/report.ts while working on the run title.
  Durations of steps that finish in the same second print as 0s.
priority: high        # low | normal | high
status: todo          # todo | progress | done | declined
origin:               # optional
  run: r_0mvimyn54_tc9o
  step: implement
created_at: 2026-10-22T09:14:03Z
updated_at: 2026-10-22T09:14:03Z
```

Limits (free text from the agent is bounded, like the other tools): `title` 1-200 characters, one line;
`body` at most 4 000 characters.

## Tools (only when `tasks.enabled`)

- `task_create({ title, body?, priority?, run?, step? })` → `{ ok, task }`.
- `task_list({ status?, priority? , limit? })` → `{ ok, tasks[] }`. Without `status` it returns the open ones
  (`todo` and `progress`); `status: "all"` returns everything. Each item: id, title, priority, status,
  origin, created_at (no body, to keep the answer small).
- `task_get({ id })` → `{ ok, task }` with the full record, body included.
- `task_update({ id, status?, priority?, title?, body? })` → `{ ok, task }`; at least one field, an empty
  update is refused.

Four tools in total: `task_create`, `task_list`, `task_get`, `task_update`.

Annotations: `task_list` and `task_get` are `readOnly`; `task_update` is idempotent; `task_create` is neither.

## Affected files

- `packages/pipeline-core/src/task.ts` (new): `TaskRecord`, `TASK_STATUSES`, `TASK_PRIORITIES`,
  `TASK_ID_PATTERN`, zod schema of the stored record, `validateNewTask`, `orderTasks`. Pure: no clock, no I/O.
- `packages/pipeline-core/src/errors.ts`: new stable codes `TASK_NOT_FOUND`, `TASKS_DISABLED`,
  `INVALID_TASK` (the error-code test pins the list).
- `packages/pipeline-core/src/service.ts`: `TaskStore` interface (`create`, `get`, `list`, `update`) and
  `TaskService` (validates, redacts, stamps time from the injected clock, calls the store). It is a separate
  class from `PipelineService`, so a host that does not want tasks does not carry them.
- `packages/pipeline-core/src/mcp/tools.ts`: `TASK_TOOLS` (separate list from `TOOLS`), `invokeTaskTool`,
  `TASK_INSTRUCTIONS` (one paragraph appended to `SERVER_INSTRUCTIONS` only when enabled). The contract
  snapshot test gets a second snapshot for the task surface.
- `packages/pipeline-core/src/mcp/register.ts`: `registerTaskTools(server, taskService)`.
- `packages/pipeline-core/src/docs.ts`: `pipeline_docs` mentions nothing about tasks (they are not a pipeline
  feature); the config reference in the docs gains the `tasks.enabled` key.
- `packages/local/src/config.ts`: `TasksConfig { enabled: boolean }`, `DEFAULT_TASKS`, `tasks` key in the strict
  schema and in `loadConfig`.
- `packages/local/src/task-store.ts` (new): file implementation of `TaskStore` (YAML via `yaml`, write to a
  temp file and `rename`, like `store.ts`; ids from the injected random source and clock). Reads skip an
  unreadable file and report it as a problem instead of failing the whole list.
- `packages/local/src/index.ts`: export it.
- `packages/cli/src/mcp-server.ts`: `createServer` takes the loaded config; registers the task tools and the
  extra instructions only when `tasks.enabled`.
- `packages/cli/src/cli.ts`: `kodel task add <title> [--body --priority --run --step]`,
  `kodel task list [--status <s>|all] [--json]`, `kodel task show <id>`,
  `kodel task set <id> [--status --priority --title --body]`. All refuse with `TASKS_DISABLED` when off.
- `examples/` / README: a short `config.yaml` example with `tasks: { enabled: true }`.

## Test strategy

Names carry the decision id where it helps (this plan's numbers, until the decision log has ids).

- Core: `validateNewTask` accepts a normal task; refuses empty or multi-line title, title over 200, body over
  4 000, unknown status or priority; `orderTasks` puts `high` before `normal` before `low`, then older first.
- Service: create stamps `created_at`/`updated_at` from the fake clock and returns status `todo` and priority
  `normal`; a secret in `title` and `body` is redacted in what the store receives (`redact` on every write
  path); update changes `updated_at` and leaves `created_at`; update of an unknown id is `TASK_NOT_FOUND`;
  `run` that is not a run id is `INVALID_TASK`; an empty update is refused.
- List: no `status` returns only `todo` and `progress`; `all` returns every status; filters combine.
- Store (local, temp dir): round trip of a record; one file per task; two creates in parallel give two
  files; a broken YAML file does not hide the other tasks and is named in the problems; an id with a path
  separator never reaches the file system (`TASK_ID_PATTERN`); the written file contains `v: 1`.
- Config: default `tasks.enabled` is `false`; `tasks: { enabled: true }` loads; a misspelled key under `tasks`
  is refused (strict schema, as the other keys).
- MCP surface: with the default config `listTools` has **no** `task_*` and the instructions do not contain
  the task paragraph; with `enabled: true` it has the four tools and the paragraph. A snapshot pins the task
  surface and bumps `CONTRACT_VERSION` only when it changes.
- CLI: each `task` command with tasks disabled prints the enabling hint and exits non-zero; with tasks
  enabled add/list/show/set work; a unique id prefix resolves, an ambiguous prefix is refused with the
  candidates; `list --json` is stable.
- E2E (testkit scripted agent): the agent creates a task mid-run, the run is not affected, and `task_list`
  shows it afterwards.
- Real agent (`tests/agents`, optional): "create a task for this bug" leads to one `task_create` with a
  sensible title; "what is important there?" leads to `task_list` and a short answer.

## Risks

- **Two sources of "task"**: the hosted Kodel has `task_*` tools too. If one agent session has both servers,
  the names collide in meaning. Accepted by the person; the descriptions of the local tools say "local
  backlog in this repository" to keep the agent from mixing them up.
- **Enable needs a restart** of the MCP server, because tools are registered at start. A hint in the refusal
  and in the docs; no hot reload.
- **Tasks in worktrees**: runs work in git worktrees, but the store root is the main repository's `.kodel`,
  so tasks made inside a run land in the main repository, not in the run's branch. This is intended (the
  task is about the project, not about the run), and it means the folder is not part of a run's diff.
- **Prompt injection through task text**: a task body is agent-written text that a later session reads back
  through `task_list`/`task_get`. It is data, never instructions; the tool descriptions say so, and `body`
  is not rendered into any pipeline template.
- **Growth**: the list is bounded by `limit` (default 50, max 200) and the answer leaves out bodies; a
  repository with thousands of tasks gets a slow `list` (one read per file). Fine for a personal backlog; an
  index file can be added later without changing the format.
- **Stored data from day one**: `v: 1` is set now, but the format may still break before the first release
  (AGENTS.md, Stored data, rule 4); the golden fixture is added when v1 is frozen.

## Order of work

1. Core: `task.ts`, error codes, `TaskStore`/`TaskService`, unit tests.
2. Local: config key, `task-store.ts`, tests.
3. MCP: tools, instructions, gating by config, surface snapshots.
4. CLI: `task` commands.
5. E2E and docs; run `bun run typecheck`, `bun run lint`, `bun test`, `bun run build && node scripts/check-artifact.mjs`.
