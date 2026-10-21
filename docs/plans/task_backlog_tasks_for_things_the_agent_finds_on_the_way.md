# Tasks: a small local backlog for what the agent finds on the way

## Goal

While working, the agent often meets a problem it should not solve now (a bug elsewhere, a missing test, an
odd design). The person says "create a task" and the agent writes it down, so it is not forgotten. Later the
person asks "what is important there?" and the agent lists the open tasks. A task has a short key
(`KDL-12`) that the person can say, type and put in a prompt (`/run KDL-12`).

This is a parking lot, not a tracker: no assignees, comments thread, custom fields or workflows. Tasks are
**off by default**: with the default config the MCP server does not expose the task tools at all; the
person turns them on in `config.yaml`.

## Decisions

1. **Statuses**: `todo`, `progress`, `done`, `declined`. Any status may be set from any other (no transition
   rules). New tasks are `todo`.
2. **Priority**: `low`, `normal` (default), `high`. `task_list` orders by priority, then by key number.
3. **Key instead of id**: `<PREFIX>-<N>`, e.g. `KDL-12`. The prefix comes from the config
   (`tasks.prefix`, default `TASK`, pattern `[A-Z][A-Z0-9]{1,9}`); `N` is a number that only goes up.
   - The key is the only identifier: the file name, the `key` field, the argument of every tool and command.
   - **Allocation**: `N` = highest number in the folder + 1, whatever the prefix of that file is, so a
     number is never given twice even if the prefix is changed. The file is created with the exclusive flag
     (`wx`); on `EEXIST` (a parallel create) the store takes the next number and retries. A task is never
     deleted (it is `declined`), so a number is not reused.
   - **Lookup is forgiving, storage is strict**: `kdl-12` and `KDL-12` find the same task; in the CLI a bare
     `12` works too (the prefix of the config is added). The stored key is always canonical upper case.
   - A changed prefix affects new tasks only; old keys stay as they are.
4. **Runs** (a task can have many): `runs` is a list of run ids, in the order they were attached, no
   duplicates, at most 100 (a longer list is refused, not truncated). A run is attached
   - on `task_create` with `run` (the run in which the task was found), and
   - later with `task_update` `add_run` (the run that works on the task, for example a new attempt).
   `task_list` can filter by `run` ("what was found in this run / which tasks did this run touch"), and a
   run id is checked against `RUN_ID_PATTERN`. The engine does not guess the current run; the agent passes
   it. The list is the link in one direction only (task → runs): runs do not store task keys, so the run
   format is not touched. A reverse index can be built from the tasks when it is needed.
5. **Comment**: optional free text `comment` (at most 500 characters), for example why the task was
   declined. Set on create and on update; `comment: null` in an update clears it. Unlike `body` (what the
   problem is) it is the note about the decision on the task, so `task_list` returns it.
6. **Storage**: one YAML file per task, `<store root>/tasks/<KEY>.yaml` (default `.kodel/tasks/`). One file
   per task keeps two branches from conflicting on one file. Whether the folder is committed is the
   person's choice (the repository does not ignore it).
7. **Format**: stored data, so `v: 1` on the record and the compatibility rules of AGENTS.md apply from the
   start (a reader that migrates in memory on read when the shape changes; golden fixture once v1 is
   frozen).
8. **Off by default, on in config**: `config.yaml` gets
   `tasks: { enabled: false, prefix: TASK }`. When `enabled` is `false`: `registerPipelineTools` does not
   register `task_*`, the server instructions do not mention them, and the CLI `task` commands refuse with
   the line that says how to enable them. The config is read when the MCP server starts, so turning tasks on
   needs a restart of the server (said in the refusal and in `docs`).
9. **Tool names**: `task_create`, `task_list`, `task_get`, `task_update` (the person accepted the overlap
   with the `task_*` tools of the hosted Kodel).
10. **Not a trust decision**: tasks carry no gate or approval meaning, so the agent may create and update
    them (principle 6 is not touched). The server instructions tell it to change a status only when the
    person asks, and to write a `comment` when it declines or finishes a task on the person's word.
11. **Redaction**: `title`, `body` and `comment` go through `redact` before they are written (principle 3).
    Text that redaction changes is accepted in its redacted form (nothing else depends on the exact text).

## Shape

```yaml
v: 1
key: KDL-12
title: Fix the off-by-one in report durations
body: |
  Seen in packages/pipeline-core/src/report.ts while working on the run title.
  Durations of steps that finish in the same second print as 0s.
priority: high        # low | normal | high
status: declined      # todo | progress | done | declined
comment: Not a bug, the report rounds down on purpose (see T-41).   # optional
runs:                 # optional, many; first is where the task was found
  - r_0mvimyn54_tc9o
  - r_0mvin1n0q_c91r
created_at: 2026-10-22T09:14:03Z
updated_at: 2026-10-23T10:02:41Z
```

Limits (free text from the agent is bounded, like the other tools): `title` 1-200 characters, one line;
`body` at most 4 000; `comment` at most 500; `runs` at most 100.

## Tools (only when `tasks.enabled`)

- `task_create({ title, body?, priority?, comment?, run? })` → `{ ok, task }` (the answer carries the new
  key, which the agent tells the person).
- `task_list({ status?, priority?, run?, limit? })` → `{ ok, tasks[] }`. Without `status` it returns the open
  ones (`todo` and `progress`); `status: "all"` returns every status. Each item: key, title, priority,
  status, comment, run count (no body, no run list, to keep the answer small). `limit` default 50, max 200.
- `task_get({ key })` → `{ ok, task }` with the full record: body and all runs.
- `task_update({ key, status?, priority?, title?, body?, comment?, add_run? })` → `{ ok, task }`; at least one
  field, an empty update is refused. `add_run` that is already attached changes nothing (idempotent).

Annotations: `task_list` and `task_get` are `readOnly`; `task_update` is idempotent; `task_create` is neither.

## Affected files

- `packages/pipeline-core/src/task.ts` (new): `TaskRecord`, `TASK_STATUSES`, `TASK_PRIORITIES`,
  `TASK_KEY_PATTERN`, `TASK_PREFIX_PATTERN`, `normalizeKey(input, prefix)`, `formatKey(prefix, n)`,
  `keyNumber(key)`, zod schema of the stored record, `validateNewTask`, `orderTasks`. Pure: no clock, no I/O.
- `packages/pipeline-core/src/errors.ts`: new stable codes `TASK_NOT_FOUND`, `TASKS_DISABLED`,
  `INVALID_TASK` (the error-code test pins the list).
- `packages/pipeline-core/src/service.ts`: `TaskStore` interface (`create` with a key allocated by the store,
  `get`, `list`, `update`) and `TaskService` (validates, redacts, stamps time from the injected clock, calls
  the store). A separate class from `PipelineService`, so a host that does not want tasks does not carry
  them.
- `packages/pipeline-core/src/mcp/tools.ts`: `TASK_TOOLS` (a separate list from `TOOLS`), `invokeTaskTool`,
  `TASK_INSTRUCTIONS` (one paragraph appended to `SERVER_INSTRUCTIONS` only when enabled). The contract
  snapshot test gets a second snapshot for the task surface.
- `packages/pipeline-core/src/mcp/register.ts`: `registerTaskTools(server, taskService)`.
- `packages/pipeline-core/src/docs.ts`: the config reference gains the `tasks` keys (tasks are not a
  pipeline feature, so `pipeline_docs` says nothing else about them).
- `packages/local/src/config.ts`: `TasksConfig { enabled: boolean; prefix: string }`, `DEFAULT_TASKS`, the
  `tasks` key in the strict schema (prefix checked against `TASK_PREFIX_PATTERN`) and in `loadConfig`.
- `packages/local/src/task-store.ts` (new): file implementation of `TaskStore` (YAML via `yaml`; create with
  `wx` and the retry of decision 3; update writes a temp file and `rename`, like `store.ts`). A file that
  cannot be read, or whose name does not match its `key`, is reported as a problem and does not fail the
  whole list.
- `packages/local/src/index.ts`: export it.
- `packages/cli/src/mcp-server.ts`: `createServer` takes the loaded config; registers the task tools and the
  extra instructions only when `tasks.enabled`.
- `packages/cli/src/cli.ts`: `kodel task add <title> [--body --priority --comment --run]`,
  `kodel task list [--status <s>|all] [--run <id>] [--json]`, `kodel task show <key>`,
  `kodel task set <key> [--status --priority --title --body --comment --add-run]`. All refuse with
  `TASKS_DISABLED` when off.
- README / `examples/`: a short `config.yaml` example with `tasks: { enabled: true, prefix: KDL }`.

## Test strategy

Names carry the decision id where it helps (this plan's numbers, until the decision log has ids).

- Core, keys: `normalizeKey("kdl-12")` is `KDL-12`; a bare `12` resolves with the config prefix; refuses
  `KDL-0`, `KDL-01`, `KDL12`, `../x`, a path separator, an over-long prefix or number; `formatKey` and
  `keyNumber` are inverse.
- Core, validation: `validateNewTask` accepts a normal task; refuses empty or multi-line title, title over
  200, body over 4 000, comment over 500, unknown status or priority, a run that is not a run id;
  `orderTasks` puts `high` before `normal` before `low`, then lower number first.
- Service: create stamps `created_at`/`updated_at` from the fake clock and returns status `todo` and priority
  `normal`; a secret in `title`, `body` and `comment` is redacted in what the store receives; update changes
  `updated_at` and leaves `created_at`; `comment: null` clears the comment; `add_run` appends in order, ignores
  a repeat, and refuses the 101st; an unknown key is `TASK_NOT_FOUND`; an empty update is refused.
- List: no `status` returns only `todo` and `progress`; `all` returns every status; `run` filter finds a task
  whose run list has that run in any position; filters combine; items carry `comment` and a run count but no
  body.
- Store (local, temp dir): round trip of a record; one file per task named `<KEY>.yaml`; first key is
  `<PREFIX>-1`; 20 creates in parallel give 20 distinct consecutive keys (the `wx` retry); a changed prefix
  continues the numbering; a broken YAML file and a file whose name and `key` differ are named in the problems
  and do not hide the other tasks; a key with a path separator never reaches the file system; the written file
  contains `v: 1`.
- Config: defaults are `enabled: false`, `prefix: TASK`; `tasks: { enabled: true, prefix: KDL }` loads; a bad
  prefix (`kdl`, `1AB`, 11 characters) and a misspelled key under `tasks` are refused (strict schema).
- MCP surface: with the default config `listTools` has **no** `task_*` and the instructions do not contain
  the task paragraph; with `enabled: true` it has the four tools and the paragraph. A snapshot pins the task
  surface and bumps `CONTRACT_VERSION` only when it changes.
- CLI: each `task` command with tasks disabled prints the enabling hint and exits non-zero; with tasks
  enabled add/list/show/set work; `show kdl-3` and `show 3` find `KDL-3`; `list --run` filters; `list
  --json` is stable.
- E2E (testkit scripted agent): the agent creates a task mid-run with `run` set, the run is not affected,
  `task_list` shows the task, and a second run is attached with `add_run`.
- Real agent (`tests/agents`, optional): "create a task for this bug" leads to one `task_create` and the agent
  names the key; "decline KDL-3, it is by design" leads to one `task_update` with status and a `comment`;
  "what is important there?" leads to `task_list` and a short answer.

## Risks

- **Keys collide across branches**: two branches that each create `KDL-7` produce two files with the same
  name, which git reports as an add/add conflict on merge. This is the price of a readable key (a random id
  would not collide). Inside one working copy `wx` makes a duplicate impossible. If the folder is shared by
  branches often, the person should keep `tasks/` ignored and use one working copy, or accept the occasional
  conflict; the conflict is loud, never silent.
- **Unbounded run lists**: a long-lived task could collect many runs. The cap of 100 refuses with a clear
  message; `task_list` returns only a count, so the answer stays small.
- **Two sources of "task"**: the hosted Kodel has `task_*` tools too. If one agent session has both servers,
  the names collide in meaning. Accepted by the person; the descriptions of the local tools say "local
  backlog in this repository" to keep the agent from mixing them up. A key such as `KDL-12` may also equal a
  Jira key if the prefix is chosen so; the person decides the prefix.
- **Enable needs a restart** of the MCP server, because tools are registered at start. A hint in the refusal
  and in the docs; no hot reload.
- **Tasks in worktrees**: runs work in git worktrees, but the store root is the main repository's `.kodel`,
  so tasks made inside a run land in the main repository, not in the run's branch. This is intended (the
  task is about the project, not about the run), and it means the folder is not part of a run's diff.
- **Prompt injection through task text**: `body` and `comment` are agent-written text that a later session
  reads back through `task_list`/`task_get`. It is data, never instructions; the tool descriptions say so,
  and none of it is rendered into a pipeline template.
- **Growth**: `list` reads one file per task, so a repository with thousands of tasks gets slow. Fine for a
  personal backlog; an index file can be added later without changing the record format.
- **Stored data from day one**: `v: 1` is set now, but the format may still break before the first release
  (AGENTS.md, Stored data, rule 4); the golden fixture is added when v1 is frozen.

## Order of work

1. Core: `task.ts` (keys, validation), error codes, `TaskStore`/`TaskService`, unit tests.
2. Local: config keys, `task-store.ts` (allocation with `wx`), tests.
3. MCP: tools, instructions, gating by config, surface snapshots.
4. CLI: `task` commands.
5. E2E and docs; run `bun run typecheck`, `bun run lint`, `bun test`, `bun run build && node scripts/check-artifact.mjs`.
