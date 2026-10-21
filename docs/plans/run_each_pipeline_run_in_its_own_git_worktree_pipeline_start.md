# Plan: a git worktree for each pipeline run

## Goal

`pipeline_start` creates a git worktree for the run at `<dir>/<run-id>` (default
`<root>/.kodel/worktrees/<run-id>`), on a new branch `kodel/<run-id>` from the root's HEAD. The run's
`workdir` is then the cwd of command nodes, command checks and git snapshots. Pipeline files, trust
and `.kodel/runs` stay in the root. If the agent is already inside a non-main worktree of this
repository, that worktree is reused and nothing is created. The whole behaviour can be turned off.

What is **not** in scope: a setup hook for the new worktree (follow-up, see the end),
`pipeline_set_workdir`, automatic removal, cleanup of aborted runs.

## What the code looks like today (verified)

- `LocalHost` is built once per pipeline spec with `options.root`; it owns a single
  `GitSnapshotter(root)` (`packages/local/src/host.ts:211`). Everything file-related derives from
  `root`: command cwd (`host.ts:618`), the `command` check's cwd (`host.ts:985`), run and gate
  baselines (`host.ts:431`, `:489`), `changesSinceGate` (`host.ts:464`), the `diff` check
  (`host.ts:976`). So the snapshotter must become per run, not per host.
- `LocalHost.start` creates the run under the start lock (`createRun` writes `RunMeta`, then the
  `start` event), and rolls the run back on failure (`removeRun`). The worktree has to join that
  transaction.
- `PipelineHost.start` / the `pipeline_start` tool take `{pipeline, task, restart}` only
  (`packages/pipeline-core/src/service.ts`, `mcp/tools.ts:95`).
- There is **no project config file today**. `HostOptions` is filled by the CLI from `--root` only
  (`packages/cli/src/cli.ts`, `main.ts`).
- The `done` answer of `nextStep` is `{ done: true, run_status }` with no text for the person
  (`packages/pipeline-core/src/next-step.ts:66`, `:97`).

## Design

### Where `workdir` lives
- `RunMeta` (local adapter, `store.ts`) gets an optional `workdir?: string` and `branch?: string`
  (absolute path as created). It is the source of truth for the cwd. Old runs have neither: they
  read as `workdir = root` (in-memory default, nothing rewritten).
- `pipeline-core` only carries `workdir` as an **opaque string**: the `start` event and the
  `run_started` journal record get an optional `workdir` field (and `branch`), so history shows
  where the run worked. The core never touches the file system (principle 4).
- Stored-data rule: adding an optional field is not a rename/removal/retype, so no migration and no
  golden fixture is required before the first release; a test opens an existing run without the
  field and reads it with `workdir = root`.

### The adapter (side effects behind a trait)
New `packages/local/src/worktree.ts`:
```ts
interface WorkdirProvider {
  /** The directory for a new run, or an existing worktree the caller is already in. */
  prepare(input: { runId: string; callerCwd?: string }): Promise<Workdir>;
  /** Fails with WORKDIR_MISSING / WORKDIR_INVALID; called before every command start. */
  verify(workdir: Workdir): Promise<void>;
}
type Workdir = { path: string; branch?: string; created: boolean };
```
- `GitWorktreeProvider(root, {dir, mode})` implements it with `git worktree add -b kodel/<run-id>
  <dir>/<run-id> HEAD`. All git calls go through the same hardened `git()` helper used by
  `GitSnapshotter` (`SAFE_CONFIG`). `git worktree add` runs the `post-checkout` hook of the
  repository; the call passes `-c core.hooksPath=<empty dir>` so a hook the agent wrote does not run
  as the user.
- `mode: "off"` returns `{ path: root, created: false }`: today's behaviour exactly.
- **Reuse rule.** If `callerCwd` is given and is inside a worktree that (a) is listed by the root's
  `git worktree list --porcelain`, (b) has the same `git rev-parse --git-common-dir` as the root,
  and (c) is not the root's main worktree, then `workdir` is that worktree's top level
  (`created: false`, no branch). Paths are compared after `realpath`, case-insensitively on macOS
  and Windows through one normalising helper. Anything else (not a worktree of this repo, or the
  main one) means "create a new one", never an error: a wrong cwd must not let the agent pick a place.
- **Verify on every command start** (node commands, the `command` check, snapshots): the directory
  still exists, its `realpath` is unchanged from the recorded one, it is still listed by
  `git worktree list`, and its common dir equals the root's. Missing gives `WORKDIR_MISSING`; any
  other mismatch gives `WORKDIR_INVALID`. Both are new error codes (`errors.ts`) and make the node
  fail closed with the code in the reason; they never fall back to the root.

### Creation inside `start`
In `LocalHost.start`, inside the start lock and before `createRun`: `provider.prepare(...)`. Order:
worktree first, then `createRun` (with `workdir`/`branch` in `RunMeta`), then the `start` event.
Any failure after the worktree was created removes it again (`git worktree remove --force` and
`git branch -D`, only for a worktree this call created) and then removes the run, as today.
A failure to create returns `{ok:false, code:"WORKDIR_CREATE_FAILED", message}` through the tool.
If the dir or branch already exists (stale leftovers) the call fails with that code; it never reuses
or deletes what it did not create.

### Per-run snapshotter and cwd
- `LocalRun` gets `workdir` (from `RunMeta`, default root) and builds `GitSnapshotter(workdir)`
  lazily; `host.snapshotter` stays only as the injectable test override (`HostOptions.snapshotter`).
  `CheckContext.snapshotter` is the run's.
- `commandOptions` and the `command` check use the run's workdir as `cwd`.
- `GitSnapshotter` excludes `.kodel` as before. A worktree inside `<root>/.kodel/worktrees` is
  therefore invisible to the root's snapshots, and `.kodel/` inside the worktree is just checked-out
  tracked files (pipelines), which the engine ignores in favour of the root's copy.
- The base of every comparison is a snapshot taken **in the workdir** (`recordRunBaseline` and the
  gate snapshot both go through the run's snapshotter), so exactly one tree is compared.
- The env of a command gets `KODEL_WORKDIR` (informational) next to `KODEL_RUN_ID`.

### Telling the server which cwd the agent is in
`pipeline_start` input gets an optional `cwd` (absolute path, max 4096). It is only a hint for the
reuse rule; the server validates it and never uses it as a path to run in. The tool description
says: "pass the directory you are working in". The answer gets `workdir` and `branch` (or
`workdir: null` when off), so the agent works there. `SERVER_INSTRUCTIONS` gets one sentence: "do
your work in the `workdir` the start answer names; commands and checks run there".
`PipelineHost.start` gets `cwd?: string` in its input.

### Settings
There is no config file, so this change adds the smallest one: `.kodel/config.yaml` (user-written,
`version: 1`, zod-validated, unknown keys rejected with a message that names the key):
```yaml
version: 1
worktree:
  mode: auto              # auto | off
  dir: .kodel/worktrees   # relative to the root, or absolute
```
Defaults when the file is absent: `auto` and `.kodel/worktrees`. The CLI reads it too (`--root`
decides which file). The agent cannot change it (it is not an MCP tool, and like the pipeline files
it is the person's). `dir` is checked: after `realpath` it must not be inside `.git` and must not be
the root itself.
> Decided at the plan gate: a config file, not `kodel mcp` flags (`status`, `gate` and the others need the same values).

### The end of a run
`nextStep` for a finished run returns `{ done: true, run_status, tell_the_person? }`; the text is
built by the **host** (core stays text-agnostic about git). For a run with a created worktree it
names the path, the branch and the commands, and nothing is automatic:
```
The work is in <workdir> on branch kodel/<run-id>.
Commit:  git -C <workdir> add -A && git -C <workdir> commit -s
Remove:  git worktree remove <workdir> && git branch -d kodel/<run-id>
```
Paths are quoted for the shell; text that came from the agent goes through `plain()`. The agent
cannot remove the worktree: no tool does it, and no CLI command is added (the printed `git` commands
are the whole mechanism, as agreed). `status` shows a workdir column and `report` a line with it;
both read it from `RunMeta`, defaulting to the root.

### Files touched
- `packages/pipeline-core`: `run.ts` (event and journal field), `service.ts` + `mcp/tools.ts`
  (`cwd` input, `workdir`/`branch` in the answer, instructions sentence), `next-step.ts` (done text),
  `errors.ts` (3 codes).
- `packages/local`: new `worktree.ts` and `config.ts`; `store.ts` (`RunMeta`); `host.ts`
  (start transaction, per-run snapshotter and cwd, verify); `pipeline-host.ts` (pass `cwd`, config);
  `index.ts` exports.
- `packages/cli`: `cli.ts` (read config, status/report columns), `format.ts`.
- `tests/agents`: new `claude-code-worktree.test.ts`, fixtures in `pipelines.ts`, `cwd` in
  `TurnOptions` (`harness.ts`).
- `packages/testkit`: the engines accept a `workdir` where they stand in for the host.
- `.gitignore`: add `/.kodel/worktrees`. English docs are deferred (AGENTS.md: after the first
  working version).

## Steps
1. `errors.ts` codes, `config.ts` (parse, defaults, validation). Tests.
2. `worktree.ts` provider: create, reuse rule, verify, rollback. Tests against a temp git repo.
3. Per-run workdir in `host.ts` (cwd, snapshotter, verify before commands), the `RunMeta` field,
   the journal field in core, the `start` transaction. Tests.
4. `pipeline_start` input and answer, instructions, `cwd` plumbing through `PipelineHost`. Tests.
5. `done` text, CLI `status`/`report`, `.gitignore`. Tests.
6. Real-agent scenarios in `tests/agents` (see Test strategy). Written after step 4, because that is
   where the agent-facing contract (`cwd` in, `workdir` out, the instructions sentence) exists;
   run by hand with `KODEL_AGENT_TESTS=1` before the change is handed to the person.
7. The CI set: typecheck, lint, test, build + artifact check.

## Test strategy
Test names carry a decision id; this change has none in the (local) decision log yet, so the tests
use the placeholder prefix `tNN_` and are renamed when an id is assigned.
- `worktree_created_on_start_in_configured_dir_on_branch_from_head`
- `worktree_mode_off_runs_in_root_as_before`
- `worktree_reused_when_caller_is_in_a_listed_non_main_worktree`
- `worktree_not_reused_for_main_worktree_other_repo_symlink_or_forged_dotgit` (a directory whose
  `.git` file was rewritten to point elsewhere; a path that only looks like a worktree)
- `start_failure_after_creation_removes_worktree_branch_and_run` (fault injection at `createRun` and
  at the `start` event); `start_with_existing_dir_or_branch_fails_without_deleting_it`
- `command_node_and_command_check_run_in_workdir`, `diff_check_and_gate_changes_use_workdir` (a file
  changed in the worktree is seen, a file changed in the root is not)
- `workdir_removed_between_commands_fails_with_workdir_missing`,
  `workdir_swapped_for_symlink_fails_closed`
- `old_run_without_workdir_reads_as_root` (a run as it is written today)
- `post_checkout_hook_written_by_agent_does_not_run_on_create`
- `config_defaults_unknown_key_and_bad_dir_messages`
- `done_text_names_path_branch_and_commands`
- e2e (`tests/e2e`): a scripted agent starts a run, works in the returned `workdir`, reaches `done`;
  it runs on Linux, macOS and Windows CI (path case, long path).

### Real-agent scenarios (`tests/agents/claude-code-worktree.test.ts`)
Claude Code on a real kodel server, in the style of `claude-code-scenarios.test.ts`: `scenario(...)`
is `test.skip` unless `KODEL_AGENT_TESTS=1`, the sandbox comes from `makeSandbox` (a git repository
with one commit, which `git worktree add` needs), and failures print `explain(turn)`. The scripted
e2e proves the engine; these prove that a real agent reads the contract the way it is meant. Fixtures
go to `pipelines.ts`: a one-node pipeline whose command check asserts where the file is.
1. `agent_works_in_returned_workdir`: asked to create `answer.txt`, the agent writes it under the
   `workdir` from the start answer. Asserts: the file is in the worktree and not in the root, the
   `command` check ran with that cwd, and the journal has the `workdir`. This is the main one: it
   tests whether the single `SERVER_INSTRUCTIONS` sentence and the tool description are enough.
2. `agent_passes_cwd_and_reuses_existing_worktree`: the agent is started with its cwd inside a
   worktree created beforehand. Asserts: `pipeline_start` carried that `cwd`, no new worktree or
   branch appeared (`git worktree list` unchanged), the run's `workdir` is the existing one.
   Needs `TurnOptions.cwd` in the harness (today the cwd is the sandbox directory).
3. `agent_cannot_steer_workdir`: the prompt tells the agent to start the pipeline with a hostile
   `cwd` (the root, a second repository, a path with `..`, a symlink into the root). Asserts: a new
   worktree was created, and no command or check ran outside it. Pairs with the unit test
   `worktree_not_reused_for_main_worktree_other_repo_symlink_or_forged_dotgit`.
4. `failed_check_in_worktree_is_retried`: the `secret` shape: the first attempt fails the check, the
   engine's reason names the file, the agent fixes it in the same worktree and the second attempt
   passes. Asserts: two `pipeline_complete_step` calls, one `failed`, one `passed`, the same `workdir`.
5. `agent_does_not_remove_worktree`: the agent is allowed every tool, and the run reaches `done`.
   Asserts: the worktree and the branch still exist, the `done` answer carries the path, the branch
   and the commit/remove commands, and the agent relays them to the person instead of running them.
The budget and timeout are the harness defaults; each scenario is one or two turns. They are not run
in CI (they cost money and are slow), as for the other files in `tests/agents`.

## Risks and open points
1. **Fail-open comparisons.** A baseline taken in one directory and a check made in another gives a
   wrong or empty diff. Mitigation: one place builds the snapshotter per run, and a test.
2. **The agent's `cwd`.** Only a hint, validated both ways (`worktree list` and common dir),
   re-verified before every command (TOCTOU), compared after `realpath`. A wrong value creates a new
   worktree instead of failing, so the agent cannot steer where commands run.
3. **Hooks and config in a new worktree.** `post-checkout` hooks and repository config are a way to
   run code as the user; the create call neutralises hooks and uses the hardened git helper.
4. **Uncommitted changes in the root do not reach the new worktree** (it starts from HEAD). Said in
   the start answer; a dirty root gets a one-line warning there.
5. **The environment of a fresh worktree** (`node_modules`, `.env`, build output are absent): the
   first `bun test` can fail for reasons unrelated to the code. See the follow-up.
6. **Windows**: path length (`.kodel/worktrees/<run id>` plus `node_modules` depth; `core.longpaths` is the remedy, ids are not shortened), path case,
   drive letters. One normalising path helper; CI runs the e2e on Windows.
7. **The config file is new.** A deliberately minimal schema with `version`; an unknown version or
   key fails with a message that names it. Agents cannot write it.
8. **Concurrency.** Branch names contain the run id and creation runs under the start lock, so two
   runs cannot claim one branch. Two runs sharing a reused worktree is not prevented (the agent was
   already there); documented.
9. **Server compatibility.** Kodel Server can implement `WorkdirProvider` with runners, or ignore
    `cwd`; the contract says `workdir` is whatever the host answers (opaque), and may be null.
10. **The engine does not merge the result.** The printed commands are all that is offered.

## Follow-up (noted, not done here)
**Setup hook.** A command run once in a new worktree to prepare the environment (install
dependencies, copy `.env`). Open: who approves it (it is a command the engine runs for the person,
so it falls under trust), where it is declared (config or pipeline), and its failure mode (fail the
start, or a warning). To be written into the local notes and designed separately.
