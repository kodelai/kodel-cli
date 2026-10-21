# Plan: changing a pipeline under a live run (`kodel pipeline changes`)

## Goal

A person (or the agent, through the engine) can change the pipeline of a run that is already going,
and the run goes on with the new definition, without starting over. Two things come out of it:

- the stuck-run case: a check of the current node is wrong (e.g. `diff max_lines` counts tests), the
  work is done, only the check has to change;
- the "I reached a node and want to change it" case: e.g. change the format of the plan, re-run the
  plan node, and pass the plan gate again.

The agent proposes, the person decides. The engine never writes a pipeline file by itself, only
on a person's command. Every change is in the history and can be listed and restored.

Not in scope (separate tasks): `rerun --from` (finished steps), split limits for src and tests in the
`diff` check, a waiver for one check, the `StateStore` interface (see `todo.md`, before release),
a setup hook for worktrees.

## Decisions taken in the discussion (2026-10-21)

1. A run is pinned to **versions of the whole pipeline**, full copies (`specs/<hash>.yaml`), not diffs.
   Per-node hashes are computed from a version, not stored.
2. A node definition has two parts, hashed apart: **work** (kind, params, timeout, `on_fail`, the
   edges leaving the node) and **checks**. A change of checks does not redo the work: the checks run
   again on the result that exists. Both are recorded in the history.
3. Changes are accepted only for the **current node and the nodes after it**. A change to a node that
   has finished is refused with a pointer to `rerun --from` (not built here).
4. A node may be **removed**; its attempts stay in the history, marked as removed. The node the run
   is standing on cannot be removed.
5. A gate needs no special rule: re-entering a node routes through the nodes after it again, so a
   gate after a re-run node is entered again and asks again. A gate before the current node stays passed.
6. The "pending change" is **derived**, not stored: the engine compares what it finds with the pinned
   version on every `pipeline_next_step` / `pipeline_complete_step`. Restoring the file ends it, no command.
7. A change comes from two sources, both tracked the same way: `pipeline_propose_change` (agent) and
   a hand edit of the pipeline file (person or agent).
8. The person accepts with `kodel pipeline changes apply <run>`; no reason is asked, the diff is the reason.
9. `pipeline_start` asks which version to use when the pipeline file has uncommitted changes.
10. No migration of runs written before this change: they are refused with a message that says so (formats
    may break freely before the first release, AGENTS.md "Stored data", rule 4).
11. The pipeline file inside a repository is changed **in the run's worktree**, so a change reaches
    parallel runs only after a merge. A pipeline outside the repository (home directory) is a shared
    file: `apply` then changes only the run (a fork) unless the person asks to write the file too.

## What the code looks like today (verified)

- `LocalPipelineHost.specFor` (`packages/local/src/pipeline-host.ts:176`) is the only place that compares
  `state.specHash` with the kept `spec.yaml` or the live file, and `open` (`:210`) calls it on every
  call. A mismatch throws `STATE_MODIFIED_EXTERNALLY` and every MCP tool, `status <run>`, `gate`,
  `resume`, `ack`, `report` and `seal` fail with it.
- `meta.json.specHash` is written and never read.
- A `LocalHost` has one fixed spec (`host.spec`), used in `decide`, `inspect`, `nextStep`, `gateResults`,
  `acceptReport`. `LocalPipelineHost.hostFor` caches hosts by `hashSpec(spec)`.
- `specFor` parses the kept copy with the current `parsePipeline`; AGENTS.md rule 2 says a kept snapshot
  is parsed by the reader of the format it was written in.
- Run state is plain TS interfaces (`pipeline-core/src/run.ts`), no zod. There is no stored "attempt":
  `NodeRun.attempt` is a counter, a live attempt is a `Visit`, a closed one exists in the journal and
  in `reports/<node>-<attempt>.json`. Events are applied by `Machine.apply`; `report.ts` ignores events
  it does not know.
- `nextStep()` in `next-step.ts` is pure: `(spec, state, now, registry)`. The `waiting` reason is a
  union `"gate" | "paused"`.
- Human commands are commander commands in `packages/cli/src/cli.ts`: `requireHuman()` (refuses under
  `KODEL_ENGINE` and without a terminal), `mustConfirm()`, `plain()` for agent text, `failIfRefused`,
  `afterDecision`. `gate` (`:166`) is the template. They are not in `TOOLS`, which `service.test.ts`
  pins.
- `pipeline_start` reads the pipeline from the root (`find`), builds the host, then `LocalHost.start`
  creates the worktree from `HEAD` (`worktree.ts:170`). Uncommitted changes of the root are not in it.
- `pipeline-core` must not import `node:crypto`; `hashSource` / `hashSpec` live in `local/src/host.ts`.
- `.claude/settings.json` denies `Edit|Write(.kodel/pipelines/**)`; the agent cannot change it.

## Design

### Pipeline versions (store)
- Layout of a run: `specs/<hash>.yaml` (every version the run has had, full text), `meta.json` gets
  `layout: 2`. `spec.yaml` goes away. The current version is `RunState.specHash` (already exists);
  it changes only through the `pipeline_accepted` event, so it is covered by the state integrity hash
  (`meta.json` is not).
- `FileStore`: `writeSpec(runId, hash, source)`, `readSpec(runId, hash)`, `listSpecs(runId)`. Written
  atomically like the other files.
- A run with no `layout: 2` is refused: `UNSUPPORTED_FORMAT`, "written before versioned pipelines; finish or
  remove it". "Cannot read" and "was modified" stay different errors (rule 3).
- `parseSnapshot(source)` in `pipeline-core`: the single entry for reading a kept version, so the reader
  for a past format can be added there. Today it calls the same parser; a snapshot with an unknown
  `version` says "written in format X", never "modified".

### Hashes and the diff (pure, `pipeline-core`)
- `canonicalNode(spec, slug)` returns `{ work: string, checks: string }`, canonical JSON with sorted keys:
  work = `kind`, `params`, `timeout`, `on_fail`, outgoing edges; checks = `checks[]`.
  Not hashed here (no `node:crypto` in core); `local` hashes with sha256 next to `hashSource`.
  Name, description and `expected_duration` are not part of either (hints).
- `diffPipelines(from, to, state)` returns, per node: `added | removed | work | checks`, plus
  pipeline-level changes (`entry`, `name`, `version`), and a verdict:
  `refused` (reason: a finished node changed, the active node removed, `entry` changed after start,
  the new pipeline is invalid or the position of the run no longer exists) or `ok` with an **effect**:
  - `restart: [nodes]` (work of the active or a later visited node changed: the live attempt is closed as
    `superseded`, a new attempt starts on the new definition, the work already in the worktree stays);
  - `recheck: [node]` (only checks of the active node changed: the checks run again on the existing result);
  - `none` (only nodes not reached yet changed).
- A node not reached yet may change in any way. Removed nodes keep their history.

### Events and the machine (`run.ts`)
- `pipeline_accepted { from, to, source: "proposal" | "file", nodes: [{slug, change}], effect }`,
  journalled with the hashes. `Machine` handles it with the **new** spec for this one event (the host
  passes it), and applies the effect:
  - `restart`: close the visit as superseded (`node_finished` with label `superseded`, not counted in
    `consecutiveFailures`), `enter(slug)` with `attempt + 1`;
  - `recheck`: a new `checks_rerun` event resets `visit.checkIndex = 0`, `phase = "checks"` and calls
    `emitCheck`. Inputs survive: the `result` check reads the stored report, `diff` reads the saved trees;
    a `command` check just runs again.
- `node_entered` records the spec hash and the `work` / `checks` hashes of the node, so the history shows
  which definition each attempt ran on.
- Spike first: how a **failed** attempt is represented before the route is followed (the stuck run:
  `impl#2` failed, run paused). `recheck` must reopen it. Settle this before writing the machine part.
- `FREE_TEXT_FIELDS` (`host.ts:151`) gets the new free-text fields (`summary`).

### The pending change (derived) and the waiting answer
- Where the engine looks (`RunMeta.watched`, local, set at start):
  - the pipeline is inside the repository and the run has a worktree: the copy in the worktree;
  - inside the repository, `worktree: off`: the root file;
  - outside the repository: that file ("shared" mode).
- A pending change exists when (a) `runs/<id>/pending/proposal.yaml` exists, or (b) the hash of the watched
  file is not `specHash`. Both: shown together; `apply` takes the one the person names (default: the
  proposal), a new proposal replaces the old one.
- `nextStep` gets an optional input `pending?: PendingChange` and answers
  `waiting { reason: "pipeline_changed", changes, effect, redo, how_to_decide: { cli }, tell_the_person }`.
  `redo` lists the nodes that run again and what it touches ("the plan gate will ask again").
  The `waiting` union and the `status` line get the new reason.
- The check runs inside `LocalRun.nextStep` / `completeStep` / `inspect` (not in `open`), so a mismatch
  is an answer, not an error. `open` no longer throws on a changed file; it still throws when a **kept
  version** is missing or does not match its own hash (that is "modified").
- `LocalRun` takes the spec of its `specHash` from `specs/`, and is rebuilt after `apply`
  (`runs` cache in `LocalPipelineHost` is keyed by run; `hosts` by spec hash).

### Agent tool
- `pipeline_propose_change { pipeline: string (yaml), summary: string }` (one pending proposal per run).
  Validated with `parsePipeline`; refused with the reason if invalid or if `diffPipelines` says `refused`
  (the agent hears it at once, not at `apply`). Size capped (256 KiB). The journal gets
  `pipeline_change_proposed { hash, summary }` (summary redacted); the text is stored as the kept
  pipelines are, unredacted.
- It writes no pipeline file and needs no change of the deny rules. It is added to `TOOLS` and to the pinned
  list in `service.test.ts`.
- `pipeline_feedback` records the current `specHash` and the active node on its own (engine side, no new
  argument), so a note says which version and node it was about.
- `SERVER_INSTRUCTIONS` get a rule: before changing a pipeline, ask the person "change it now (the run
  stops until you apply it) or note it with `pipeline_feedback` and decide another way?"; never apply it
  yourself; when the answer is `waiting: pipeline_changed`, tell the person the changes, which nodes run
  again, and the command.

### Human commands (`kodel pipeline changes`)
All use `requireHuman()`; the ones that change anything also `mustConfirm()`. They go through a host-level
method that does not use `open` (like `seal`).
- `changes <run>`: the pending change as the waiting answer shows it (checks first), or "none".
- `changes apply <run> [--write-file] [--only-run]`: shows the diff, asks, then:
  1. re-reads and re-hashes the source; if it is not what the person saw, shows the diff again;
  2. saves `specs/<hash>.yaml`; 3. in repository mode writes the version into the worktree copy (so it
  reaches the branch); in shared mode only saves for the run unless `--write-file`, and warns that parallel
  sessions use that file; 4. applies `pipeline_accepted`; 5. removes `pending/proposal.yaml`;
  6. `afterDecision`.
  A broken file is refused with the parse error.
- `changes history <run>`: versions with hash, time, source, changed nodes, diff against the previous one.
- `changes restore <run> [<hash>]`: writes the version (default: the pinned one) into the watched file.
  Restoring the pinned version ends a pending change; an older one shows up as a new pending change.

### `pipeline_start` and uncommitted pipelines
- Applies only when the run gets a worktree. The pipeline file differs from `HEAD` (`git status --porcelain
  -- <file>`; a file that is not in `HEAD` is "new").
- Without `pipeline_version`: no run is created; the answer is
  `{ choice: { reason: "pipeline_uncommitted", options: ["working", "committed"], diff, tell_the_person } }`.
  The agent must ask the person and call again; the text says not to choose alone.
- `pipeline_version: "working"`: pin the root file and write it into the worktree copy. `"committed"`:
  pin `git show HEAD:<file>`; the worktree copy already equals it. A new file has only `working`.
- The copy is part of the start transaction in the worktree adapter: rolled back with the worktree on failure.
- The choice goes into `run_started`. Only the run's own pipeline file is checked, not `config.yaml`.
- A run that is reused, or has no worktree, or a pipeline outside the repository: no question.
- When the agent starts inside an existing worktree that is reused, its copy is compared with the root the
  same way.
- `specFor`'s "no kept copy, use the live file" fallback goes away (every run has `specs/`).

## Steps

Each step is its own change that passes `typecheck`, `lint`, `bun test`, so each fits the `diff`
limit of `dev.yaml` (this plan is larger than 800 lines of change; do not run it as one `impl`).

1. **Versions and hashes.** `specs/` layout and `layout: 2`, `parseSnapshot`, `canonicalNode`, node hashes
   in `local`, `node_entered` carries the hashes. `open` reads the pinned version from `specs/`.
2. **Diff and the machine.** `diffPipelines`, `pipeline_accepted`, `checks_rerun`, `superseded`; the spike
   on failed attempts comes first. Pure tests in `pipeline-core`.
3. **Derived waiting.** Watched file, pending detection, `pipeline_changed` in `nextStep`, `status`, tools no
   longer throw on a changed file. Update the `hardening.test.ts` cases.
4. **`pipeline_propose_change`** and the `pipeline_feedback` binding; instructions text.
5. **Commands.** `kodel pipeline changes` (`show`, `apply`, `history`, `restore`), shared-mode behaviour.
6. **`pipeline_start` choice.** Dirty detection, `pipeline_version`, copy into the worktree.
7. **Docs and rules.** AGENTS.md ("do not edit `.kodel/pipelines/`" becomes "propose changes with
   `pipeline_propose_change`; the person accepts"), `adapters/` prompts, `skills/`. The deny rules in
   `.claude/settings.json` can stay: the agent no longer edits the file. This step is made by the person
   where it touches `.claude/settings*.json`.

## Tests

Names carry the decision id once the decision log has one (placeholders `dN` below).

- Core: `diff_refuses_a_change_to_a_finished_node`, `diff_checks_only_on_the_active_node_is_recheck`,
  `diff_work_change_is_restart`, `diff_removed_node_is_kept_in_history`, `diff_cannot_remove_the_active_node`,
  `canonical_node_ignores_key_order_and_name`, `accepted_restart_closes_the_attempt_as_superseded`,
  `superseded_attempt_does_not_count_as_a_failure`, `recheck_runs_the_checks_on_the_existing_report`,
  `a_gate_after_a_restarted_node_asks_again`, `a_gate_before_the_active_node_stays_passed`.
- Local: `restoring_the_file_ends_the_pending_change_without_a_command`,
  `a_changed_file_gives_waiting_not_an_error` (replaces the "refused" cases of `hardening.test.ts`),
  `a_missing_or_modified_kept_version_is_still_modified`, `an_old_run_without_layout_2_is_refused_by_format`,
  `a_snapshot_is_read_by_parse_snapshot`, `each_attempt_records_its_node_hashes`,
  `apply_writes_the_worktree_copy_not_the_root`, `apply_in_shared_mode_changes_only_the_run`,
  `apply_shows_the_diff_again_if_the_file_changed_meanwhile`, `changes_history_lists_every_version`,
  `restore_writes_the_pinned_version`, `start_with_uncommitted_pipeline_asks_and_creates_nothing`,
  `start_working_copies_the_root_file_into_the_worktree`, `start_committed_pins_head`,
  `start_new_untracked_pipeline_offers_only_working`, `start_failure_rolls_back_the_copy`.
- MCP/CLI: `propose_change_refuses_an_invalid_pipeline`, `propose_change_writes_no_file`,
  `a_new_proposal_replaces_the_old_one`, `feedback_records_spec_hash_and_node`, `accept_commands_are_human_only`
  (add `pipeline changes apply|restore` to the lists in "only a person can decide" and "commands a person
  runs refuse to run from the engine"), the pinned tool arguments in `service.test.ts` updated for
  `pipeline_propose_change` and `pipeline_version`.
- Update: `host.test.ts` ("the pipeline source a run started with is kept next to it"), `mcp.test.ts`
  ("editing the pipeline file does not change a run already started"), `store.test.ts` fixtures.

## Risks and open points

- A failed attempt before the route is followed (step 2 spike) decides how `recheck` works for the stuck run.
- Weakened checks: the agent could propose a looser check to pass its own work. `apply` shows check
  changes first and the proposal path is the only agent path; nothing stops the person from accepting. A
  mark in `report` for "checks changed during the run" is cheap and worth adding in step 5.
- `pipeline_version` is chosen by the agent after asking; it is journalled, not enforced.
- Shared mode (pipeline outside the repository) and `--write-file` touch every parallel session: the
  command warns, nothing more.
- `AGENTS.md` mentions the `trust` command which does not exist; fixed separately (`3b0da91`).
- The `done` / `status` text for a run whose pipeline is a fork ("differs from `<name>` in the shared
  directory") is added in step 5.
