# Plan: changing a pipeline under a live run (`kodel pipeline changes`)

## Status

Steps 1 to 7 are built (see `git log`). Where the code differs from what is written below:

- A start that needs the person's choice makes nothing and throws `ChoiceNeeded` from the host's `start`;
  the service turns it into the `choice` answer. `StartOutcome` keeps its shape.
- A pipeline that is not in the last commit (a new file) is copied into the worktree **without a
  question**: there is only one version to choose. The note about the file riding into the branch is
  only given when the person chose `working` for a file that differs from the commit.
- A change that cannot be accepted holds nothing back (it is told in `pipeline_change.refused`).
- `kodel pipeline changes` with a run id alone is `show`; `apply` re-reads the text after the
  confirmation and takes nothing if it moved (it does not show the diff again).
- Not built: a test that a failed copy into the worktree rolls the start back; the Bash deny rules
  for `pipeline changes apply|discard|restore` in `.claude/settings.json` (a person edits that file);
  the shared-file mode (out of scope, above).
- The error code `PIPELINE_CHANGE_REFUSED` is new; the error codes section of the contract (local
  notes) has to list it.

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
a setup hook for worktrees, **a pipeline directory outside the repository** (it cannot be configured
today: `pipelinesDir` is only a constructor option; the shared-file mode, `--write-file` and
`--only-run` are dropped until it can).

## Decisions

Taken in the discussion (2026-10-21), and after the review of the first version of this plan.

1. A run is pinned to **versions of the whole pipeline**, full copies (`specs/<hash>.yaml`), not diffs.
   Per-node hashes are computed from a version, not stored.
2. A node definition has three parts, hashed apart: **work** (kind, params, timeout, `on_fail`),
   **checks**, and **routing** (the edges leaving the node). A change of checks does not redo the work.
   All three are recorded in the history. `name`, `description`, `expected_duration` are hints, in none.
3. A change is accepted for the **active node and every node reachable from it**. A node that has
   finished and is **not reachable from the active node** may not change (refused, with a pointer to
   `rerun --from`, not built here). In a loop (`review -> impl`) the nodes of the loop are reachable,
   so they may change. The same applies to a node that is only reached by a taken edge: its routing
   is part of what finished.
4. A node may be **removed** (not the active one); its attempts stay in the history, marked as removed.
5. A gate needs no special rule: re-entering a node routes through the nodes after it again, so a gate
   after a re-run node asks again. A gate before the active node and not reachable from it stays passed.
6. The pending change is **derived**, not stored: the engine compares what it finds with the pinned
   version. Restoring the file ends it, no command.
7. Two sources, tracked alike: `pipeline_propose_change` (agent) and a hand edit of the run's own
   pipeline file. **Only the run's own file blocks the run**: the copy in its worktree, or the root file
   when the run has no worktree. Drift of any other file is shown by `status` and `changes`, never blocks.
   The comparison is of the **parsed pipeline in canonical form**, not of bytes: a comment, whitespace,
   or line endings are not a change. A watched file that does not parse is "cannot read" (reported to
   whoever asks), not a pending change.
8. The person accepts with `kodel pipeline changes apply <run>`; a reason is optional (`--reason`), the
   diff is recorded either way. A pending change can be dropped with `discard`.
9. `pipeline_start` asks which version to use when the pipeline file has uncommitted changes; a project
   config key can set the answer for good.
10. No migration of runs written before this change: refused with a message that says so (formats may
    break freely before the first release, AGENTS.md "Stored data", rule 4).
11. The pipeline file inside the repository is changed **in the run's worktree**, so a change reaches
    parallel runs only after a merge.
12. The names stay: `kodel pipeline changes <run>` (`show` is the default), `apply`, `discard`, `history`,
    `restore`. No aliases for now.

## What the code looks like today (verified)

- `LocalPipelineHost.specFor` (`packages/local/src/pipeline-host.ts:176`) is the only place that compares
  `state.specHash` with the kept `spec.yaml` or the live file, and `open` (`:210`) calls it on every
  call. A mismatch throws `STATE_MODIFIED_EXTERNALLY` and every MCP tool, `status <run>`, `gate`,
  `resume`, `ack`, `report` and `seal` fail with it.
- `meta.json.specHash` is written and never read. `meta.json` is **untrusted** (`host.ts:383-388`):
  `workdir` was moved into the integrity-protected state for that reason.
- A `LocalHost` has one fixed spec (`host.spec`), used in `decide`, `inspect`, `nextStep`, `gateResults`,
  `acceptReport`. `LocalPipelineHost.hostFor` caches hosts by `hashSpec(spec)`; runs are cached by run id.
  The MCP server and the CLI are different processes.
- `specFor` parses the kept copy with the current `parsePipeline`; AGENTS.md rule 2 says a kept snapshot
  is parsed by the reader of the format it was written in.
- Run state is plain TS interfaces (`pipeline-core/src/run.ts`), no zod. There is no stored "attempt":
  `NodeRun.attempt` is a counter, a live attempt is a `Visit`, a closed one exists in the journal and
  in `reports/<node>-<attempt>.json`. `Machine.apply` refuses every event except tick, heartbeat,
  cancel, resume, acknowledge and feedback when `status !== "running"` (`run.ts:589`). `start()` creates
  the `NodeRun`s from the spec (`run.ts:724`). `check_finished` is accepted when its index equals
  `visit.checkIndex` (`run.ts:653`).
- The `diff` check defaults to `since: node`, whose baseline is the snapshot `visit:<visitId>` taken in
  `enter()` only when `!rework` (`registry.ts:233`, `run.ts:367`). It re-snapshots the **live tree**
  (`git.ts:197`); it does not read saved trees. `since: attempt` needs `attempt:<visit>:<n>`.
- A failed attempt with no `failed` edge is re-entered at once as rework: the stuck run is **`impl#2` in
  phase `agent`, status running** (or paused after repeated failures); the failed verdict belongs to the
  closed attempt 1.
- `nextStep()` in `next-step.ts` is pure: `(spec, state, now, registry)`. The `waiting` reason is a
  union `"gate" | "paused"`.
- Human commands are commander commands in `packages/cli/src/cli.ts`: `requireHuman()`, `mustConfirm()`,
  `plain()`, `failIfRefused`, `afterDecision`. `gate` (`:192`) is the template. They are not in `TOOLS`,
  which `service.test.ts` pins. `.claude/settings.json` lists each human command in a Bash deny rule.
- `pipeline_start` reads the pipeline from the root (`find`), builds the host, then `LocalHost.start`
  creates the worktree from `HEAD` (`worktree.ts:170`). Uncommitted changes of the root are not in it.
- `pipeline-core` must not import `node:crypto`; `hashSource` / `hashSpec` live in `local/src/host.ts`.
  `FREE_TEXT_FIELDS` (`host.ts:151`) already has `summary`.
- `.claude/settings.json` denies `Edit|Write(.kodel/pipelines/**)`. Whether that pattern covers the copy in a
  worktree, and `sed -i` through Bash, cannot be relied on.

## Design

### Pipeline versions (store)
- Layout of a run: `specs/<hash>.yaml` (every version the run has had, full text). `meta.json` gets `v: 2`
  (principle 8: `v` is the format version). `spec.yaml` goes away. The current version is
  `RunState.specHash`; it changes only through `pipeline_accepted`, so the integrity hash covers it.
- **The pipeline file of the run (path relative to the repository) is recorded in `run_started` and kept in
  the state**, never read from `meta.json`. The watched path is derived from `state.workdir` + that path
  on every use, and must resolve inside the repository or the worktree (realpath check). A path that does
  not is refused.
- `FileStore`: `writeSpec(runId, hash, source)`, `readSpec(runId, hash)`, `listSpecs(runId)`, atomic.
- A run with `meta.v < 2` is refused with `UNSUPPORTED_FORMAT`: "written before versioned pipelines;
  finish or remove it". "Cannot read" and "was modified" stay different errors (rule 3).
- `parseSnapshot(source)` in `pipeline-core` is the single entry for reading a kept version, so a reader
  for a past format can be added there. Today it calls the same parser; an unknown `version` says
  "written in format X", never "modified".
- The `pipeline` name cannot change in a change (`meta.pipeline` and `find()` key on it): refused.

### Hashes and the diff (pure, `pipeline-core`)
- `canonicalNode(spec, slug)` returns `{ work, checks, routing }`, canonical JSON with sorted keys. Not
  hashed in core (no `node:crypto`); `local` hashes with sha256 next to `hashSource`. The canonical
  **pipeline** is the same idea over the whole spec and is what Decision 7 compares.
- `diffPipelines(from, to, state)` returns per node `added | removed | work | checks | routing`, the
  pipeline-level changes (`entry`, `version`), and a verdict:
  - `refused`: the pipeline is invalid; `name` changed; `entry` changed; the active node removed or the
    position of a visit no longer exists; a finished node **not reachable from the active node** changed
    (reason names the node and says `rerun --from`); at a gate: "reject or approve the gate first".
  - `ok` with an effect, by the **phase of the active attempt**:
    - `agent`: work changed -> `restart`; only checks or routing changed -> `none` (the new checks apply
      at `complete_step`, nothing is closed);
    - `checks` (checks of the active node running or about to): checks changed -> `recheck`;
      work changed -> `restart`;
    - `engine` (a command is running): `apply` is refused until it is over (see Races);
    - `human`: work changed -> `restart` (the gate is entered again); otherwise `none`;
    - nodes not reached yet changed: no effect on the active attempt.
  - **Routing never restarts a node.** The edges are read at `finish` with the then-current spec.
- A node not reached yet may change in any way.

### Events and the machine (`run.ts`)
- `pipeline_accepted { from, to, source, nodes: [{slug, change}], effect, reason? }`. `Machine` handles it
  with the **new** spec for this one event (the host passes it). It is allowed also when the run is
  `paused` (state `running`/`paused`); if `pause.node` is a node whose work or checks changed, the pause
  clears and the node is re-entered; otherwise the pause stays and the output says "run `kodel resume`".
  A finished run refuses it. It creates a `NodeRun` for every added node (else `UNKNOWN_NODE` at routing and
  at `resume`) and keeps the `NodeRun` of a removed node, marked removed.
- `restart`: its own path, not `finish()`: the visit ends with a `node_superseded` record (status of the
  run and `consecutiveFailures` unchanged, **no routing**); then `enter` with `attempt + 1`. Whether it
  costs `max_attempts`: it does not. The new visit is **rework-style: it keeps the snapshots
  `visit:<id>` and `attempt:*` of the superseded one**, so the `diff` baseline does not move and the work
  already in the worktree counts. A `since: attempt` check added later gets its snapshot taken at accept.
- `recheck`: `checks_rerun` resets `visit.checkIndex = 0`, `phase = "checks"` and calls `emitCheck`. It
  measures **the tree as it is now** (`diff` re-snapshots; stated in the diff the person sees).
- `check_finished` / command results carry the `specHash` they were started under and are **dropped
  on mismatch**, so a result of the old definition is never accepted for the new one.
- `node_entered` records the spec hash and the three node hashes, so the history shows which definition
  each attempt ran on. `report` marks an attempt "definition changed" with the changed parts.
- After `restart` the agent's next `pipeline_next_step` for the node carries a **note**: "the definition of
  this step changed (…); your work is still in the worktree". Reuse the `reentry_feedback` slot.
- Spike first (small, before the machine part): the exact shape of the state in a paused run, and where
  the superseded visit's snapshots live, so `restart` and the pause clearing are written once.

### The pending change (derived) and the waiting answer
- Watched file = the run's own file (Decision 7). A proposal exists in `runs/<id>/pending/proposal.yaml`.
- A pending change exists when the proposal exists and differs from the pinned version, or the watched
  file parses and its canonical form differs from the pinned one. Both at once: both are listed, `apply`
  takes the one the person names (default: the proposal), a new proposal replaces the old.
- A proposal or file equal to the pinned version is not pending (and is cleaned up).
- `nextStep` gets an optional input `pending` and answers `waiting { reason: "pipeline_changed", watched:
  <path>, changes, effect, redo, refused?, how_to_decide: { cli }, tell_the_person }`. `redo` lists the nodes
  that run again and what it touches ("the plan gate will ask again"). If the verdict is `refused`, the
  answer says why, and that the file has to be restored or `discard`ed. When the change was **made in the
  worktree copy and not through the tool**, the answer says so and tells the agent to restore the file and
  use `pipeline_propose_change`.
- The block happens at `complete_step` (where the version is needed to route), not in the middle of the
  agent's work: `pipeline_next_step` answers the node as before with `pipeline_changed: true` and the
  summary; `pipeline_complete_step` answers `waiting`. A node that is not active (gate waiting, paused)
  answers `waiting` at once. If a gate waits at the same time, the answer shows both, the change first.
- The check lives in `LocalRun.nextStep` / `completeStep` / `inspect`, not in `open`. `open` still throws
  when a **kept version** is missing or does not match its own hash ("modified").
- `gate` and `resume` refuse while a change is pending: "a pipeline change is waiting: `kodel pipeline
  changes <run>`", unless the person adds `--ignore-pending-change`.
- `status` (list and `<run>`) shows `pipeline change pending` and the watched path. `report` shows the
  versions and the marks.
- Cross-process: `open` compares the cached run's host hash with `state.specHash` on every call and
  rebuilds when they differ (the CLI's `apply` is seen by the MCP server). The old `LocalRun`'s running
  tasks are handed to the new one so `stop()` still kills them.

### Agent tools
- `pipeline_propose_change { pipeline: string (yaml), summary: string }` (one pending proposal per run).
  Validated with `parsePipeline`; refused with the reason if invalid or if `diffPipelines` says `refused`
  (the agent hears it at once). Size capped (256 KiB), `summary` capped (`LIMITS.text`). The proposal is
  agent input: it goes through `redact` and the **redacted text is what is hashed and stored**; a proposal
  that redaction changes is refused ("it contains something that looks like a secret"). The journal gets
  `pipeline_change_proposed { hash, summary }`, counted like refusals (`MAX_LOGGED_REFUSALS`).
- `pipeline_propose_change` with an empty `pipeline` **withdraws** the agent's own proposal.
- It writes no pipeline file, so it needs no change of the deny rules.
- `pipeline_resolve` takes an optional `run_id` and then returns the **pinned** pipeline text of that run,
  so the agent edits what the run uses, not the root file.
- `pipeline_feedback` records the current `specHash` and the active node on its own (engine side).
- `SERVER_INSTRUCTIONS`: before changing a pipeline, ask the person "change it now (the run stops at the
  next step until you apply it) or note it with `pipeline_feedback` and decide another way?"; never apply
  it yourself; change the pipeline only through the tool, never by editing the file; on
  `waiting: pipeline_changed` tell the person the changes, which nodes run again, and the command.

### Human commands (`kodel pipeline changes`)
All use `requireHuman()`; the ones that change anything also `mustConfirm()`; text of the agent goes
through `plain()` and is truncated. They go through a host-level method that does not use `open` (like
`seal`). Each is added to the Bash deny rules in `.claude/settings.json` (a person edits that file).
- `changes <run>` (also `changes show`): the pending change as the waiting answer shows it (checks first),
  the watched path, or "none".
- `changes apply <run> [--reason "..."] [--from proposal|file]`:
  1. refuses a finished run and a `refused` verdict, with the reason;
  2. refuses while the active attempt runs a command or a check (`engine` phase, or `checks` with a check
     running): "wait for it or `kodel resume`" (races, below);
  3. shows the diff, asks; re-reads and re-hashes the source; if it is not what the person saw, shows it again;
  4. saves `specs/<hash>.yaml`; 5. writes the version into the watched file (repository mode: the
     worktree copy, so it reaches the branch); 6. applies `pipeline_accepted`; 7. removes the proposal;
  8. `afterDecision`.
  If it stops half way, running it again finishes it: a proposal equal to the pinned version is not
  pending, and a watched file that differs only by the part not yet applied is shown as the same change.
  The output says "apply did not finish, run it again" when it finds that state.
- `changes discard <run>`: drops the pending proposal; for a file source tells which file to restore and
  offers to do it (`restore`).
- `changes history <run>`: versions from the **journal** (hash, time, source, changed nodes, reason), diff
  against the previous one; an orphan `specs/<hash>.yaml` is reported as such.
- `changes restore <run> [<hash>]`: writes the version (default: the pinned one) into the watched file.
  Restoring a version `diffPipelines` would refuse is refused up front.

### `pipeline_start` and uncommitted pipelines
- Applies only when the run gets a worktree. The pipeline file differs from `HEAD` (`git status --porcelain
  -- <file>`; a file not in `HEAD` is "new"; an ignored file not in `HEAD` is "new" too). The comparison is
  of the canonical pipeline (line endings and comments do not count).
- Without `pipeline_version`: no run is created; the answer is
  `{ choice: { reason: "pipeline_uncommitted", options: ["working", "committed"], diff, tell_the_person } }`,
  documented in the tool description (it has no `run_id`). The agent must ask the person; the text says not
  to choose alone.
- `pipeline_version: "working"`: pin the root file and write it into the worktree copy. `"committed"`: pin
  `git show HEAD:<file>`; the worktree copy equals it (canonical form). A new file has only `working`.
- The copy is part of the start transaction in the worktree adapter, rolled back with it on failure.
- The `note` of the answer says the copy rides into the branch with the run's commit.
- `config.yaml` gets `pipeline: { uncommitted: ask | working | committed }` (default `ask`) for people who
  work on the pipeline itself. The choice goes into `run_started`.
- A reused run, no worktree: no question. A reused worktree: its copy is compared with the root the same way.
- The "no kept copy, use the live file" fallback of `specFor` goes away.

## Races and partial failures
- `apply` runs in the CLI, the engine work in the MCP process. `apply` refuses in `engine`/`checks`
  phases (above) and results carry the `specHash` (dropped on mismatch), so a late result never counts.
- Two `apply` at once: the state write is under the run's lock; the second sees the changed `specHash`
  and shows the diff again.
- The order of `apply` (spec file, watched file, event, proposal) is chosen so that every prefix is either
  "nothing happened" or a state the next `apply` completes.

## Steps

Each step is its own change that passes `typecheck`, `lint`, `bun test`, so each fits the `diff` limit
of `dev.yaml` (this plan is larger than 800 lines of change; do not run it as one `impl`).

1. **Versions and hashes.** `specs/`, `meta.v: 2`, the pipeline file path in the state, `parseSnapshot`,
   `canonicalNode`, hashes in `local`, `node_entered` carries them. `open` reads the pinned version.
2. **Diff and the machine.** The spike first. `diffPipelines`, `pipeline_accepted`, `node_superseded`,
   `checks_rerun`, rework-style restart, results carry `specHash`, paused runs. Pure tests in `pipeline-core`.
3. **Derived waiting.** Watched file, canonical comparison, `pipeline_changed` in `nextStep`, the block at
   `complete_step`, `status`, `gate` / `resume` refuse, cross-process rebuild; update `hardening.test.ts`.
4. **Agent tools.** `pipeline_propose_change` (redaction, withdraw), `pipeline_resolve` with `run_id`,
   `pipeline_feedback` binding, the reentry note, instructions text.
5. **Commands.** `kodel pipeline changes` (`show`, `apply`, `discard`, `history`, `restore`), `report` marks.
6. **`pipeline_start` choice.** Dirty detection, `pipeline_version`, the config key, copy into the worktree.
7. **Docs and rules.** AGENTS.md ("do not edit `.kodel/pipelines/`" becomes "propose changes with
   `pipeline_propose_change`; the person accepts"), `adapters/`, `skills/`. The Bash deny rules for the new
   commands are added by the person in `.claude/settings.json`.

## Tests

Names carry the decision id once the decision log has one.

- Core: `diff_refuses_a_finished_node_not_reachable_from_the_active_one`, `diff_allows_nodes_of_a_loop`,
  `diff_refuses_name_entry_and_removal_of_the_active_node`, `diff_effect_follows_the_phase`,
  `diff_checks_only_is_recheck`, `diff_routing_never_restarts`, `diff_removed_node_is_kept_in_history`,
  `canonical_pipeline_ignores_key_order_comments_and_line_endings`,
  `accepted_restart_is_not_routed_and_costs_no_attempt`, `restart_keeps_the_diff_baseline`,
  `accepted_adds_node_runs_for_new_nodes`, `accepted_on_a_paused_run_clears_the_pause_of_a_changed_node`,
  `accepted_on_a_finished_run_is_refused`, `a_result_of_the_old_definition_is_dropped`,
  `recheck_measures_the_tree_as_it_is`, `a_gate_after_a_restarted_node_asks_again`,
  `a_gate_before_the_active_node_stays_passed`.
- Local: `restoring_the_file_ends_the_pending_change_without_a_command`,
  `a_comment_or_whitespace_edit_is_not_a_change`, `crlf_worktree_copy_equals_head_version`,
  `drift_of_another_file_is_shown_not_blocking`, `an_unparsable_watched_file_is_an_error_not_a_pending_change`,
  `a_proposal_equal_to_the_pinned_version_is_not_pending`, `a_changed_file_gives_waiting_not_an_error`
  (replaces the "refused" cases of `hardening.test.ts`), `the_watched_path_comes_from_the_state_not_meta`,
  `the_watched_path_outside_the_repository_is_refused`, `a_missing_or_modified_kept_version_is_modified`,
  `an_old_run_without_v2_is_refused_by_format`, `each_attempt_records_its_node_hashes`,
  `mcp_process_picks_up_an_apply_from_the_cli`, `apply_refuses_while_a_command_or_check_runs`,
  `apply_writes_the_worktree_copy_not_the_root`, `apply_shows_the_diff_again_if_the_file_changed_meanwhile`,
  `an_interrupted_apply_is_finished_by_the_next_one`, `changes_history_comes_from_the_journal`,
  `restore_writes_the_pinned_version`, `restore_of_a_refused_version_is_refused`,
  `gate_and_resume_refuse_while_a_change_is_pending`, `status_shows_a_pending_change`,
  `start_with_uncommitted_pipeline_asks_and_creates_nothing`, `start_working_copies_the_root_file_into_the_worktree`,
  `start_committed_pins_head`, `start_new_untracked_pipeline_offers_only_working`,
  `start_config_default_skips_the_question`, `start_failure_rolls_back_the_copy`.
- MCP/CLI: `propose_change_refuses_an_invalid_or_refused_pipeline`, `propose_change_writes_no_file`,
  `propose_change_redacts_and_refuses_a_secret`, `a_new_proposal_replaces_the_old`,
  `propose_change_with_an_empty_pipeline_withdraws_it`, `resolve_with_run_id_returns_the_pinned_text`,
  `feedback_records_spec_hash_and_node`, `restart_note_reaches_the_agent`,
  `accept_commands_are_human_only` (add `pipeline changes apply|discard|restore` to the lists in "only a
  person can decide" and "commands a person runs refuse to run from the engine"), the pinned tool arguments
  in `service.test.ts` updated.
- Update: `host.test.ts` ("the pipeline source a run started with is kept next to it"), `mcp.test.ts`
  ("editing the pipeline file does not change a run already started"), `store.test.ts` fixtures.

## Risks and open points

- Weakened checks: the agent can propose a looser check to pass its own work. `apply` shows check changes
  first and `report` marks "checks changed during the run"; nothing stops the person from accepting.
- `pipeline_version` is chosen by the agent after asking; it is journalled, not enforced.
- The spike may change how `restart` and the pause clearing look; the plan keeps them as one path in step 2.
- A pipeline outside the repository is not supported; `pipeline changes` only knows a file in the repository.
- `AGENTS.md` mentioned a `trust` command that does not exist; fixed separately (`3b0da91`).
