# Tasks: a small local backlog for what the agent finds on the way

## Goal

While working, the agent often meets a problem it should not solve now (a bug elsewhere, a missing test, an
odd design). The person says "create a task" and the agent writes it down, so it is not forgotten. Later the
person asks "what is important there?" and the agent lists the open tasks. A task has a short key
(`KDL-7K3Q`) that the person can say, type and put in a prompt (`/run KDL-7K3Q`), and a task can be split
into subtasks.

This is a parking lot, not a tracker: no assignees, comment threads, custom fields or workflows. Tasks are
**off by default**: with the default config the MCP server does not expose the task tools at all; the
person turns them on in `config.yaml`.

## Decisions

1. **Statuses**: `todo`, `progress`, `done`, `declined`. Any status may be set from any other (no transition
   rules). New tasks are `todo`.
2. **Priority**: `low`, `normal` (default), `high`. `task_list` orders by priority, then oldest first
   (`created_at`, then key, so the order is stable).
3. **Key**: `<PREFIX>-<SUFFIX>`, e.g. `KDL-7K3Q`.
   - The prefix comes from the config (`tasks.prefix`, default `TASK`, pattern `[A-Z][A-Z0-9]{1,9}`).
   - The suffix is 4 random characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ` (30 characters: no `0 O 1 I L U`,
     so a key read aloud or from a screen is not mistaken). That is about 810 000 keys per prefix: a
     collision needs a very large backlog, and the cases that remain are handled below.
   - There is no counter, so nothing has to be shared between branches or processes: the key is the
     only identifier (file name, `key` field, argument of every tool and command).
   - **Allocation**: the store picks a random suffix and creates `<KEY>.yaml` with the exclusive flag (`wx`).
     On `EEXIST` it picks another suffix; after 10 failures it gives up with `TASK_KEY_UNAVAILABLE` (it means
     the folder is nearly full or the random source is broken, never a normal case). The random source is
     injected, so a test can force collisions.
   - **Lookup is forgiving, storage is strict**: `kdl-7k3q` and `KDL-7K3Q` find the same task; in the CLI the
     suffix alone (`7K3Q`) works too, with the prefix of the config. The stored key is always canonical upper
     case. A lookup by suffix never guesses: it matches a file whose suffix is exactly that, whatever its
     prefix, and refuses if two prefixes have the same suffix.
   - A changed prefix affects new tasks only; old keys stay as they are.
4. **Runs** (a task can have many): `runs` is a list of run ids, in the order they were attached, no
   duplicates, at most 100 (a longer list is refused, not truncated). A run is attached
   - on `task_create` with `run` (the run in which the task was found), and
   - later with `task_update` `add_run` (the run that works on the task, for example a new attempt).
   `task_list` can filter by `run`, and a run id is checked against `RUN_ID_PATTERN`. The engine does not
   guess the current run; the agent passes it. The link is task → runs only: runs do not store task keys, so
   the run format is not touched. A reverse index can be built from the tasks when it is needed.
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
12. **Subtasks**: a task may have a `parent` (the key of another task). A subtask is a full task: it has its
    own key, status, priority, comment and runs.
    - **One level**: a subtask cannot have subtasks. A parent must itself have no parent, and a task that
      has subtasks cannot be made a subtask. This rules out cycles without a graph check; the limit can be
      lifted later without changing the record (the field is already a single key).
    - **Stored on the child only** (`parent: KDL-7K3Q`). The parent file is not touched when a subtask is
      added, so there is one write, no two-file inconsistency, and no extra merge conflicts. Children are
      found by reading the folder (the same read `list` already does).
    - **Parent must exist** when a subtask is created or re-parented. `task_update` with `parent` moves a
      subtask under another parent, and `parent: null` makes it a top-level task again.
    - **No automatic status**: closing the last subtask does not close the parent, and closing the parent
      does not touch its subtasks (the person decides). `task_list` shows on a parent how many subtasks it has
      and how many are done (`subtasks: { done, total }`). When a task is set to `done` or `declined` while
      it still has open subtasks, the answer says how many are open, so the agent can tell the person; it is
      not an error.
    - A subtask whose parent file is missing (for example the parent lives in a branch that is not merged
      yet) is shown as a top-level task and reported as a problem; it is never hidden.

## Shape

```yaml
v: 1
key: KDL-7K3Q
title: Fix the off-by-one in report durations
body: |
  Seen in packages/pipeline-core/src/report.ts while working on the run title.
  Durations of steps that finish in the same second print as 0s.
priority: high        # low | normal | high
status: declined      # todo | progress | done | declined
comment: Not a bug, the report rounds down on purpose (see T-41).   # optional
parent: KDL-W4N9      # optional; present only on a subtask
runs:                 # optional, many; first is where the task was found
  - r_0mvimyn54_tc9o
  - r_0mvin1n0q_c91r
created_at: 2026-10-22T09:14:03Z
updated_at: 2026-10-23T10:02:41Z
```

Limits (free text from the agent is bounded, like the other tools): `title` 1-200 characters, one line;
`body` at most 4 000; `comment` at most 500; `runs` at most 100.

## Tools (only when `tasks.enabled`)

- `task_create({ title, body?, priority?, comment?, run?, parent? })` → `{ ok, task }` (the answer carries the
  new key, which the agent tells the person).
- `task_list({ status?, priority?, run?, parent?, top_level?, limit? })` → `{ ok, tasks[], problems[] }`. The
  list is flat: subtasks are items too, each with its `parent`. Without `status` it returns the open ones
  (`todo` and `progress`); `status: "all"` returns every status. `parent: <key>` returns the subtasks of that
  task; `top_level: true` leaves subtasks out. Each item: key, title, priority, status, comment, parent (if
  any), `subtasks: { done, total }` (if any), run count (no body, no run list, to keep the answer small).
  `limit` default 50, max 200.
- `task_get({ key })` → `{ ok, task, subtasks[] }`: the full record (body, all runs) and the subtasks as
  `{ key, title, status, priority }`.
- `task_update({ key, status?, priority?, title?, body?, comment?, add_run?, parent? })` → `{ ok, task,
  open_subtasks? }`; at least one field, an empty update is refused. `add_run` that is already attached
  changes nothing (idempotent). `parent: null` detaches.

Annotations: `task_list` and `task_get` are `readOnly`; `task_update` is idempotent; `task_create` is neither.

## Affected files

- `packages/pipeline-core/src/task.ts` (new): `TaskRecord`, `TASK_STATUSES`, `TASK_PRIORITIES`,
  `TASK_KEY_PATTERN`, `TASK_PREFIX_PATTERN`, `KEY_ALPHABET`, `randomKey(prefix, random)`, `normalizeKey(input,
  prefix)`, zod schema of the stored record, `validateNewTask`, `checkParent(task, parent, all)` (one-level
  rule), `withSubtaskCounts`, `orderTasks`. Pure: no clock, no I/O; randomness comes in as a function.
- `packages/pipeline-core/src/errors.ts`: new stable codes `TASK_NOT_FOUND`, `TASKS_DISABLED`,
  `INVALID_TASK`, `TASK_KEY_UNAVAILABLE` (the error-code test pins the list).
- `packages/pipeline-core/src/service.ts`: `TaskStore` interface (`create` which allocates the key, `get`,
  `list`, `update`) and `TaskService` (validates, redacts, stamps time from the injected clock, applies the
  subtask rules, calls the store). A separate class from `PipelineService`, so a host that does not want
  tasks does not carry them.
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
- `packages/cli/src/cli.ts`: `kodel task add <title> [--body --priority --comment --run --parent]`,
  `kodel task list [--status <s>|all] [--run <id>] [--parent <key>] [--top-level] [--json]`,
  `kodel task show <key>` (prints the subtasks), `kodel task set <key> [--status --priority --title --body
  --comment --add-run --parent <key>|none]`. All refuse with `TASKS_DISABLED` when off.
- README / `examples/`: a short `config.yaml` example with `tasks: { enabled: true, prefix: KDL }`.

## Test strategy

Names carry the decision id where it helps (this plan's numbers, until the decision log has ids).

- Core, keys: `randomKey` uses only the alphabet, makes `PREFIX-XXXX`, and with a fake random source is
  deterministic; `normalizeKey("kdl-7k3q")` is `KDL-7K3Q`; a bare suffix resolves with the config prefix;
  refuses a wrong length, a character outside the alphabet (`0`, `O`, `1`, `I`, `L`, `U`), `../x`, a path
  separator, an over-long prefix.
- Core, validation: `validateNewTask` accepts a normal task; refuses empty or multi-line title, title over
  200, body over 4 000, comment over 500, unknown status or priority, a run that is not a run id;
  `orderTasks` puts `high` before `normal` before `low`, then older first, then by key.
- Core, subtasks: `checkParent` accepts a top-level parent; refuses a missing parent, itself as parent, a
  parent that is a subtask, and a task that already has subtasks becoming a subtask.
- Service: create stamps `created_at`/`updated_at` from the fake clock and returns status `todo` and priority
  `normal`; a secret in `title`, `body` and `comment` is redacted in what the store receives; update changes
  `updated_at` and leaves `created_at`; `comment: null` clears the comment; `add_run` appends in order,
  ignores a repeat, and refuses the 101st; an unknown key is `TASK_NOT_FOUND`; an empty update is refused.
- Service, subtasks: create with `parent` links it; re-parent moves it; `parent: null` detaches; setting a
  parent to `done` with two open subtasks succeeds and answers `open_subtasks: 2`; closing a parent does not
  change the subtasks; closing the last subtask does not change the parent.
- List: no `status` returns only `todo` and `progress`; `all` returns every status; `run` filter finds a task
  whose run list has that run in any position; `parent` returns only the subtasks of that task; `top_level`
  leaves subtasks out; a parent item carries `subtasks: { done, total }`; items carry `comment` and a run
  count but no body; filters combine.
- Store (local, temp dir): round trip of a record; one file per task named `<KEY>.yaml`; 50 creates in
  parallel give 50 distinct keys; a forced collision (fake random returns the same suffix twice) retries and
  succeeds; ten collisions in a row give `TASK_KEY_UNAVAILABLE`; a changed prefix keeps old tasks readable;
  a broken YAML file, a file whose name and `key` differ, and a subtask with a missing parent are named in
  the problems and do not hide the other tasks (the orphan is listed as top-level); a key with a path
  separator never reaches the file system; the written file contains `v: 1`; a suffix shared by two prefixes
  is refused on lookup.
- Config: defaults are `enabled: false`, `prefix: TASK`; `tasks: { enabled: true, prefix: KDL }` loads; a bad
  prefix (`kdl`, `1AB`, 11 characters) and a misspelled key under `tasks` are refused (strict schema).
- MCP surface: with the default config `listTools` has **no** `task_*` and the instructions do not contain
  the task paragraph; with `enabled: true` it has the four tools and the paragraph. A snapshot pins the task
  surface and bumps `CONTRACT_VERSION` only when it changes.
- CLI: each `task` command with tasks disabled prints the enabling hint and exits non-zero; with tasks
  enabled add/list/show/set work; `show kdl-7k3q` and `show 7K3Q` find `KDL-7K3Q`; `add --parent` makes a
  subtask and `show <parent>` lists it; `list --run`, `--parent` and `--top-level` filter; `list --json` is
  stable.
- E2E (testkit scripted agent): the agent creates a task mid-run with `run` set and a subtask under it, the
  run is not affected, `task_list` shows both, and a second run is attached with `add_run`.
- Real agent (`tests/agents`, optional): "create a task for this bug" leads to one `task_create` and the agent
  names the key; "split it into two subtasks" leads to two `task_create` with `parent`; "decline KDL-7K3Q, it
  is by design" leads to one `task_update` with status and a `comment`; "what is important there?" leads to
  `task_list` and a short answer.

## Risks

- **Key collisions**: inside one working copy `wx` makes a duplicate impossible. Across branches two tasks may
  get the same random key; with 4 characters and two branches of 20 new tasks each that is about 0.05%, and
  the result is a loud git add/add conflict on `<KEY>.yaml`, never a silent overwrite. If it ever matters, the
  suffix can be made 5 characters without changing the record: old keys stay valid, since the pattern then
  accepts both lengths.
- **Keys are not memorable**: `KDL-7K3Q` is harder to remember than `KDL-12`, and has no order. The person
  trades this for no shared counter. The agent always says the key together with the title.
- **Unbounded run lists**: a long-lived task could collect many runs. The cap of 100 refuses with a clear
  message; `task_list` returns only a count, so the answer stays small.
- **Subtask depth and orphans**: one level only, on purpose; a deeper tree needs a cycle check and a rollup
  rule. A subtask whose parent is not in the working copy is shown, not hidden.
- **Two sources of "task"**: the hosted Kodel has `task_*` tools too. If one agent session has both servers,
  the names collide in meaning. Accepted by the person; the descriptions of the local tools say "local
  backlog in this repository" to keep the agent from mixing them up. A key such as `KDL-7K3Q` is unlikely to
  equal a Jira key, but the person chooses the prefix.
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

1. Core: `task.ts` (keys, validation, subtask rules), error codes, `TaskStore`/`TaskService`, unit tests.
2. Local: config keys, `task-store.ts` (allocation with `wx`), tests.
3. MCP: tools, instructions, gating by config, surface snapshots.
4. CLI: `task` commands.
5. E2E and docs; run `bun run typecheck`, `bun run lint`, `bun test`, `bun run build && node scripts/check-artifact.mjs`.
