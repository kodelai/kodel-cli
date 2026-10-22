# Tasks: a small backlog for what the agent finds on the way, behind a task adapter

## Goal

While working, the agent often meets a problem it should not solve now (a bug elsewhere, a missing test, an
odd design). The person says "create a task" and the agent writes it down, so it is not forgotten. Later the
person asks "what is important there?" and the agent lists the open tasks. A task has a short key
(`KDL-7K3Q`) that the person can say, type and put in a prompt (`/run KDL-7K3Q`), and a task can be split
into subtasks.

Everything the agent and the CLI do with tasks goes through a **task adapter** interface. This change ships
one adapter, `local` (YAML files in the repository). A person who wants their own tracker (Jira, Linear,
GitHub Issues) can later write an adapter for the same interface; there is no plugin loader now, only the
interface and a registry by `kind` (principle 7), so a loader can be added without touching the engine.

This is a parking lot, not a tracker: no assignees, comment threads, custom fields or workflows. Tasks are
**off by default**: with the default config the MCP server does not expose the task tools at all; the
person turns them on in `config.yaml`.

## Core and adapter: who decides what

| The core (`pipeline-core`) decides | The adapter decides |
|---|---|
| The tool and CLI surface, the input limits, redaction of what the agent writes (principle 3) | How a task is stored or where it is sent |
| The four statuses and three priorities (the common model) | How the common statuses map to the tracker's own |
| That a key is an opaque string (1-64 printable characters) | What a key looks like, how a human's input is turned into one, how a new one is allocated |
| That a refused or failed call becomes `{ok:false, code, message}` | Which optional features exist (`capabilities`), the subtask rules, time stamps, ordering ties |
| The text of the tool descriptions and the instructions | Authentication and credentials of a tracker |

Decisions 3, 4 (storage of the link), 6, 7 and 12 below are the rules of the **local adapter**; another
adapter keeps or changes them. The core does not know them.

## Decisions

1. **Statuses**: `todo`, `progress`, `done`, `declined`. Any status may be set from any other (no transition
   rules in the core). New tasks are `todo`. An adapter for a tracker with a workflow maps them and may
   refuse a move its tracker forbids (`TASK_UNSUPPORTED`, with the reason).
2. **Priority**: `low`, `normal` (default), `high`. `task_list` orders by priority, then oldest first.
3. **Key (local adapter)**: `<PREFIX>-<SUFFIX>`, e.g. `KDL-7K3Q`.
   - The prefix is `tasks.options.prefix` (default `TASK`, pattern `[A-Z][A-Z0-9]{1,9}`).
   - The suffix is 4 random characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ` (30 characters: no `0 O 1 I L U`,
     so a key read aloud or from a screen is not mistaken): about 810 000 keys per prefix.
   - There is no counter, so nothing has to be shared between branches or processes. The key is the only
     identifier (file name, `key` field, argument of every tool and command).
   - **Allocation**: pick a random suffix and create `<KEY>.yaml` with the exclusive flag (`wx`). On `EEXIST`
     pick another; after 10 failures give up with `TASK_KEY_UNAVAILABLE`. The random source is injected, so
     a test can force collisions.
   - **Lookup is forgiving, storage is strict**: `kdl-7k3q` and `KDL-7K3Q` find the same task, and the suffix
     alone (`7K3Q`) works in the CLI. It matches a file whose suffix is exactly that; if two prefixes have the
     same suffix the lookup is refused, never guessed. The stored key is always canonical upper case.
   - A changed prefix affects new tasks only; old keys stay as they are.
4. **Runs** (a task can have many): `runs` is a list of run ids, in the order they were attached, no
   duplicates, at most 100 (a longer list is refused, not truncated). A run is attached
   - on `task_create` with `run` (the run in which the task was found), and
   - later with `task_update` `add_run` (the run that works on the task, for example a new attempt).
   `task_list` can filter by `run`, and a run id is checked against `RUN_ID_PATTERN` in the core. The engine
   does not guess the current run; the agent passes it. The link is task → runs only: runs do not store task
   keys, so the run format is not touched. An adapter with `capabilities.runs: false` (a tracker that has
   nowhere to put it) makes the core refuse `run`, `add_run` and the `run` filter with `TASK_UNSUPPORTED`.
5. **Comment**: optional free text `comment` (at most 500 characters), for example why the task was
   declined. Set on create and on update; `comment: null` in an update clears it. Unlike `body` (what the
   problem is) it is the note about the decision on the task, so `task_list` returns it. Needs
   `capabilities.comment`.
6. **Storage (local adapter)**: one YAML file per task, `<store root>/tasks/<KEY>.yaml` (default
   `.kodel/tasks/`). One file per task keeps two branches from conflicting on one file. Whether the folder is
   committed is the person's choice (the repository does not ignore it).
7. **Format (local adapter)**: stored data, so `v: 1` on the record and the compatibility rules of AGENTS.md
   apply from the start (a reader that migrates in memory on read when the shape changes; golden fixture once
   v1 is frozen). The shape the adapter *returns* is the core's `Task` type, which is not a stored format.
8. **Off by default, on in config**: `config.yaml` gets
   `tasks: { enabled: false, adapter: local, options: {} }`. `adapter` is a `kind` registered by the host
   (only `local` exists); `options` is handed to that adapter and checked by the adapter's own zod schema
   (`options.prefix` for `local`). An unknown `adapter` is refused with `CONFIG_INVALID` naming the kinds that
   exist. When `enabled` is `false`: `registerTaskTools` is not called, the server instructions do not mention
   tasks, and the CLI `task` commands refuse with the line that says how to enable them. The config is read
   when the MCP server starts, so turning tasks on needs a restart of the server (said in the refusal and in
   `docs`). Secrets never go in `options`: an adapter that needs a token reads it from an environment
   variable whose name the person puts in `options`.
9. **Tool names**: `task_create`, `task_list`, `task_get`, `task_update` (the person accepted the overlap
   with the `task_*` tools of the hosted Kodel).
10. **Not a trust decision**: tasks carry no gate or approval meaning, so the agent may create and update
    them (principle 6 is not touched). The server instructions tell it to change a status only when the
    person asks, and to write a `comment` when it declines or finishes a task on the person's word.
11. **Redaction**: `title`, `body` and `comment` go through `redact` in the **service**, before the adapter
    sees them, so no adapter can forget it (principle 3). Text that redaction changes is accepted in its
    redacted form. An error message from an adapter is redacted too before it reaches the agent.
12. **Subtasks**: a task may have a `parent` (the key of another task). A subtask is a full task: it has its
    own key, status, priority, comment and runs. The core passes `parent` through and asks the adapter if
    `capabilities.subtasks`; the rules below are the local adapter's.
    - **One level**: a subtask cannot have subtasks. A parent must itself have no parent, and a task that
      has subtasks cannot be made a subtask. This rules out cycles without a graph check; it can be lifted
      later without changing the record.
    - **Stored on the child only** (`parent: KDL-7K3Q`). The parent file is not touched when a subtask is
      added: one write, no two-file inconsistency, no extra merge conflicts. Children are found by reading
      the folder (the same read `list` already does).
    - **Parent must exist** when a subtask is created or re-parented. `task_update` with `parent` moves a
      subtask under another parent, and `parent: null` makes it a top-level task again.
    - **No automatic status**: closing the last subtask does not close the parent, and closing the parent
      does not touch its subtasks. `task_list` shows on a parent how many subtasks it has and how many are
      done (`subtasks: { done, total }`). When a task is set to `done` or `declined` while it has open
      subtasks, the answer says how many are open (`open_subtasks`); it is not an error.
    - A subtask whose parent file is missing (for example the parent lives in a branch that is not merged
      yet) is shown as a top-level task and reported in `problems`; it is never hidden.
13. **Adapter interface in the core**: see the next section. One adapter per server; the choice is the
    config's, not the agent's (the agent cannot switch trackers).

## Adapter interface

In `packages/pipeline-core/src/tasks.ts`, next to `PipelineHost` (the same pattern: the core defines the
interface, a host implements it):

```ts
export type TaskStatus = "todo" | "progress" | "done" | "declined";
export type TaskPriority = "low" | "normal" | "high";

export interface Task {
  key: string;                      // opaque to the core
  title: string;
  body?: string;
  priority: TaskPriority;
  status: TaskStatus;
  comment?: string;
  parent?: string;                  // key of the parent
  runs: string[];                   // run ids; [] when the adapter has no runs
  url?: string;                     // where a human opens it, for adapters that have one
  created_at: string;               // ISO 8601, set by the adapter (a tracker has its own clock)
  updated_at: string;
}

export interface TaskSummary extends Omit<Task, "body" | "runs"> {
  run_count: number;
  subtasks?: { done: number; total: number };
}

export interface TaskFilter {
  statuses: TaskStatus[];           // the core expands "open" and "all"
  priority?: TaskPriority;
  run?: string;
  parent?: string;
  top_level?: boolean;
  limit: number;
}

export interface NewTask {          // already validated and redacted by the service
  title: string;
  body?: string;
  priority: TaskPriority;
  comment?: string;
  run?: string;
  parent?: string;
}

export interface TaskPatch {
  status?: TaskStatus;
  priority?: TaskPriority;
  title?: string;
  body?: string;
  comment?: string | null;          // null clears
  add_run?: string;
  parent?: string | null;           // null detaches
}

export interface TaskAdapterCapabilities {
  subtasks: boolean;
  runs: boolean;
  comment: boolean;
}

export interface TaskAdapter {
  readonly kind: string;
  readonly capabilities: TaskAdapterCapabilities;
  /** Turn what a person typed into a key, or `undefined` if it cannot be one (`7k3q` → `KDL-7K3Q`). */
  resolveKey(input: string): string | undefined;
  create(input: NewTask): Promise<Task>;
  get(key: string): Promise<{ task: Task; subtasks: TaskSummary[] } | undefined>;
  list(filter: TaskFilter): Promise<{ tasks: TaskSummary[]; problems: TaskProblem[] }>;
  update(key: string, patch: TaskPatch): Promise<{ task: Task; open_subtasks?: number } | undefined>;
}

export interface TaskProblem { key?: string; message: string }

export type TaskAdapterFactory = (ctx: TaskAdapterContext) => TaskAdapter;

export interface TaskAdapterContext {
  storeRoot: string;                // where the local adapter keeps files
  options: unknown;                 // `tasks.options` from the config, still unchecked: the adapter validates it
  clock: Clock;                     // the injected clock of the host
  random: () => number;             // injected randomness, for keys
}
```

Rules of the contract:

- **Absent is `undefined`, failure is a throw.** `get` and `update` return `undefined` for an unknown key
  (the service turns it into `TASK_NOT_FOUND`). Anything else that goes wrong (tracker unreachable, bad
  credentials) throws; the service turns an unknown error into `TASK_ADAPTER_FAILED` with the redacted
  message, and a `KodelError` with its own code keeps it.
- **The adapter never trusts the agent either.** The service validates and redacts, but an adapter that
  builds a path, a query or a request from `key`, `run` or `parent` must still check them for its own
  medium (the local adapter checks the key pattern before a file name exists; a tracker adapter encodes
  its requests).
- **Unsupported is refused by the service**, from `capabilities`, before the adapter is called: `parent`
  without `subtasks`, `run`/`add_run`/`run` filter without `runs`, `comment` without `comment` give
  `TASK_UNSUPPORTED` with a message naming the adapter and the feature.
- **Idempotence**: `update` with the same patch twice gives the same task; `add_run` of an attached run is a
  no-op.
- **Registry**: `TaskAdapterRegistry` (`register(kind, factory)`, `create(kind, ctx)`), filled by the host.
  The CLI registers `local`; a future plugin loader would register more. The core never matches on a kind.
- **Conformance suite**: `@kodel-ai/testkit` exports `taskAdapterContract(makeAdapter)`, a set of tests that
  every adapter must pass (create/get/list/update, filters, not-found, idempotence, capability-gated
  behavior, no body in summaries). The `local` adapter and an in-memory fake run it; an author of a tracker
  adapter can run it on theirs.

## Shape (what the local adapter stores)

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

Limits (free text from the agent is bounded, like the other tools; enforced by the core): `title` 1-200
characters, one line; `body` at most 4 000; `comment` at most 500; `runs` at most 100 (the local adapter's
cap, since another adapter may keep runs differently).

## Tools (only when `tasks.enabled`)

- `task_create({ title, body?, priority?, comment?, run?, parent? })` → `{ ok, task }` (the answer carries the
  new key, which the agent tells the person).
- `task_list({ status?, priority?, run?, parent?, top_level?, limit? })` → `{ ok, tasks[], problems[] }`. The
  list is flat: subtasks are items too, each with its `parent`. Without `status` it returns the open ones
  (`todo` and `progress`); `status: "all"` returns every status. `parent: <key>` returns the subtasks of that
  task; `top_level: true` leaves subtasks out. Each item is a `TaskSummary`: key, title, priority, status,
  comment, parent (if any), `subtasks: { done, total }` (if any), run count, url (if any); no body and no run
  list, to keep the answer small. `limit` default 50, max 200.
- `task_get({ key })` → `{ ok, task, subtasks[] }`: the full record and the subtasks as summaries.
- `task_update({ key, status?, priority?, title?, body?, comment?, add_run?, parent? })` → `{ ok, task,
  open_subtasks? }`; at least one field, an empty update is refused.

Every `key` argument goes through `adapter.resolveKey` first. Annotations: `task_list` and `task_get` are
`readOnly`; `task_update` is idempotent; `task_create` is neither. The tool descriptions say that the
answers are data, and that the tracker behind them may be written by other people.

## Affected files

- `packages/pipeline-core/src/tasks.ts` (new): the types and interface of the section above,
  `TASK_STATUSES`, `TASK_PRIORITIES`, `TaskAdapterRegistry`, `validateNewTask`, `validatePatch`,
  `expandStatuses` (`open` / `all`), `orderTasks` (priority, then `created_at`, then key; used by adapters
  that cannot sort themselves). Pure: no clock, no I/O, no randomness of its own.
- `packages/pipeline-core/src/errors.ts`: new stable codes `TASK_NOT_FOUND`, `TASKS_DISABLED`,
  `INVALID_TASK`, `TASK_UNSUPPORTED`, `TASK_ADAPTER_FAILED`, `TASK_KEY_UNAVAILABLE` (the error-code test pins
  the list).
- `packages/pipeline-core/src/service.ts`: `TaskService(adapter)`: validates, redacts, checks capabilities,
  resolves keys, calls the adapter, maps errors. A separate class from `PipelineService`, so a host that does
  not want tasks does not carry them. It stamps no time and allocates no key: both belong to the adapter.
- `packages/pipeline-core/src/mcp/tools.ts`: `TASK_TOOLS` (a separate list from `TOOLS`), `invokeTaskTool`,
  `TASK_INSTRUCTIONS` (one paragraph appended to `SERVER_INSTRUCTIONS` only when enabled). The contract
  snapshot test gets a second snapshot for the task surface.
- `packages/pipeline-core/src/mcp/register.ts`: `registerTaskTools(server, taskService)`.
- `packages/pipeline-core/src/index.ts`: export the task types, the registry and `TaskService`.
- `packages/pipeline-core/src/docs.ts`: the config reference gains the `tasks` keys, and a short note on the
  adapter (what `options` is for `local`).
- `packages/local/src/config.ts`: `TasksConfig { enabled: boolean; adapter: string; options: unknown }`,
  `DEFAULT_TASKS`, the `tasks` key in the strict schema (`options` is a free record: it is the adapter's to
  check) and in `loadConfig`.
- `packages/local/src/tasks/local-adapter.ts` (new): the `local` adapter and its options schema
  (`prefix`). Key allocation with `wx` and the retry of decision 3; the one-level subtask rule; YAML via
  `yaml`; update writes a temp file and `rename`, like `store.ts`. A file that cannot be read, or whose name
  does not match its `key`, is reported as a problem and does not fail the whole list.
- `packages/local/src/tasks/index.ts` and `packages/local/src/index.ts`: export `localTaskAdapter` (the
  factory) and `createTaskAdapter(config, ctx)` (looks the kind up in a registry that has `local`).
- `packages/cli/src/mcp-server.ts`: `createServer` takes the loaded config; when `tasks.enabled`, builds the
  adapter, then registers the task tools and the extra instructions.
- `packages/cli/src/cli.ts`: `kodel task add <title> [--body --priority --comment --run --parent]`,
  `kodel task list [--status <s>|all] [--run <id>] [--parent <key>] [--top-level] [--json]`,
  `kodel task show <key>` (prints the subtasks), `kodel task set <key> [--status --priority --title --body
  --comment --add-run --parent <key>|none]`. The CLI goes through the same `TaskService` as the MCP tools, so
  both behave the same. All refuse with `TASKS_DISABLED` when off.
- `packages/testkit/src/task-adapter-contract.ts` and `memory-task-adapter.ts` (new): the conformance suite
  and an in-memory adapter (also used to test the service and the tools without files).
- README / `examples/`: a `config.yaml` example with
  `tasks: { enabled: true, adapter: local, options: { prefix: KDL } }`.

## Test strategy

Names carry the decision id where it helps (this plan's numbers, until the decision log has ids).

- **Adapter contract** (`taskAdapterContract`), run on the in-memory fake and on `local`: create returns a
  task with `todo`/`normal` defaults and non-empty key and times; get returns the same task plus its
  subtasks; unknown key gives `undefined` on get and update; update is idempotent; `comment: null` clears;
  `add_run` appends in order and ignores a repeat; `list` filters by status, priority, run, parent and
  `top_level` and combines them; summaries carry no body; `limit` is honored; a parent item carries
  `subtasks: { done, total }`; an adapter with a capability off does not need to implement it (the
  capability-gated cases are skipped for it, and its `capabilities` are checked for consistency).
- Core, validation: `validateNewTask` accepts a normal task; refuses empty or multi-line title, title over
  200, body over 4 000, comment over 500, unknown status or priority, a run that is not a run id, a key over
  64 characters or with control characters; `expandStatuses` gives `todo`+`progress` for open and all four
  for all; `orderTasks` puts `high` before `normal` before `low`, then older first, then by key.
- Service (with the in-memory adapter): a secret in `title`, `body` and `comment` is redacted in what the
  adapter receives; a message of an adapter error that contains a secret is redacted; an unknown thrown error
  becomes `TASK_ADAPTER_FAILED` and a `KodelError` keeps its code; `undefined` becomes `TASK_NOT_FOUND`; an
  empty update is refused; `parent`, `run` and `comment` are refused with `TASK_UNSUPPORTED` when the
  adapter's capability is off, and the adapter is not called; every `key` goes through `resolveKey`, and an
  input it rejects is `TASK_NOT_FOUND`.
- Service, subtasks: setting a parent to `done` with two open subtasks succeeds and answers
  `open_subtasks: 2`; closing a parent does not change the subtasks; closing the last subtask does not change
  the parent.
- Local adapter, keys: only characters of the alphabet; `PREFIX-XXXX`; deterministic with a fake random;
  `resolveKey("kdl-7k3q")` is `KDL-7K3Q`, a bare suffix resolves with the prefix of the config, and a wrong
  length, a character outside the alphabet (`0 O 1 I L U`), `../x` and a path separator give `undefined`;
  a suffix shared by two prefixes is refused.
- Local adapter, files: round trip; one file per task named `<KEY>.yaml`; 50 creates in parallel give 50
  distinct keys; a forced collision retries and succeeds; ten in a row give `TASK_KEY_UNAVAILABLE`; a
  changed prefix keeps old tasks readable; a broken YAML file, a file whose name and `key` differ, and a
  subtask with a missing parent are in `problems` and do not hide the other tasks (the orphan is listed as
  top-level); a key with a path separator never reaches the file system; the file contains `v: 1`; times
  come from the injected clock.
- Local adapter, subtasks: `checkParent` accepts a top-level parent; refuses a missing parent, itself as
  parent, a parent that is a subtask, and a task that already has subtasks becoming a subtask; re-parent
  moves, `parent: null` detaches.
- Registry: `local` is registered; an unknown `adapter` in the config is `CONFIG_INVALID` and the message
  names the known kinds; a second registration of the same kind is refused; the factory receives `options`
  untouched and a bad `options` (`prefix: kdl`) is refused by the adapter's schema with a readable message.
- Config: defaults are `enabled: false`, `adapter: local`, `options: {}`; `tasks: { enabled: true, adapter:
  local, options: { prefix: KDL } }` loads; a misspelled key under `tasks` is refused (strict schema), a
  misspelled key under `options` is refused by the adapter.
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

- **An interface designed from one implementation**: only `local` exists, so the interface may fit it too
  well and misfit a real tracker (workflows, custom fields, pagination, rate limits). Mitigations: the
  `capabilities` switch for optional features, an opaque `key`, adapter-owned times and key allocation,
  `url`, `TASK_ADAPTER_FAILED` for remote errors, and an `update` that may refuse a status move. What is not
  covered (cursor pagination, a status workflow with required fields) is left out on purpose; the interface
  carries no version yet, and a field added to a type is compatible. Before the first release, one real
  tracker adapter (even a throwaway Jira or GitHub one) should be written against it to test the design.
- **Text from a tracker is untrusted**: with an external adapter, `title`, `body` and `comment` may be written
  by other people and read by the agent. It is data, never instructions; the tool descriptions say so, and
  none of it is rendered into a pipeline template. The same holds for local files an agent wrote earlier.
- **Credentials**: a tracker adapter needs a token. The config holds only the name of an environment
  variable; the core never logs `options`, and `redact` covers error messages. Making the agent unable to
  read the token is the person's job (permissions), as for any MCP server.
- **Key collisions (local)**: inside one working copy `wx` makes a duplicate impossible. Across branches two
  tasks may get the same random key; with 4 characters and two branches of 20 new tasks each that is about
  0.05%, and the result is a loud git add/add conflict on `<KEY>.yaml`, never a silent overwrite. The suffix
  can be made 5 characters later without changing the record: old keys stay valid if the pattern accepts both
  lengths.
- **Keys are not memorable**: `KDL-7K3Q` is harder to remember than `KDL-12`, and has no order. The agent
  always says the key together with the title.
- **Unbounded run lists**: a long-lived task could collect many runs. The cap of 100 refuses with a clear
  message; `task_list` returns only a count.
- **Subtask depth and orphans (local)**: one level only, on purpose; a deeper tree needs a cycle check and a
  rollup rule. A subtask whose parent is not in the working copy is shown, not hidden.
- **Two sources of "task"**: the hosted Kodel has `task_*` tools too. If one agent session has both servers,
  the names collide in meaning. Accepted by the person; the descriptions say "the tasks of this repository,
  kept by the configured adapter" to keep the agent from mixing them up.
- **Enable needs a restart** of the MCP server, because tools are registered at start. A hint in the refusal
  and in the docs; no hot reload.
- **Tasks in worktrees (local)**: runs work in git worktrees, but the store root is the main repository's
  `.kodel`, so tasks made inside a run land in the main repository, not in the run's branch. This is
  intended, and it means the folder is not part of a run's diff.
- **Growth (local)**: `list` reads one file per task, so thousands of tasks get slow. Fine for a personal
  backlog; an index file can be added later without changing the record format.
- **Stored data from day one**: `v: 1` is set now, but the format may still break before the first release
  (AGENTS.md, Stored data, rule 4); the golden fixture is added when v1 is frozen.

## Order of work

1. Core: `tasks.ts` (types, interface, registry, validation), error codes, `TaskService`, unit tests.
2. Testkit: in-memory adapter and the conformance suite; service and tool tests on top of them.
3. Local: config keys, `local` adapter (allocation with `wx`, subtask rules), contract and file tests.
4. MCP: tools, instructions, gating by config, surface snapshots.
5. CLI: `task` commands.
6. E2E and docs; run `bun run typecheck`, `bun run lint`, `bun test`, `bun run build && node scripts/check-artifact.mjs`.
