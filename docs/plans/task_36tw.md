# TASK-36TW: patches of the work (`changes/*.patch`)

## TL;DR

- Every handed-in agent attempt leaves `changes/<node>-<attempt>.patch` (work tree at the previous hand-in, or at the run
  start, -> work tree now); the run leaves `changes/run.patch` (start -> end). It is a **history** of what each node and the
  pipeline changed, not a promise that a patch re-applies (`git apply --check` is promised only for a text-only, unredacted
  run from a clean start). Patches survive branch deletion and `git gc`.
- Nothing is snapshotted under the run lock and the core gets no new effect: the tree at each hand-in is taken in
  `completeStep` (outside the lock, 20 s deadline) and recorded in `agent_completed`; the next hand-in starts there. Patches
  are computed in a private bare git dir with a scrubbed environment (the agent's `.gitattributes`, config and hooks cannot
  touch them). The end patch is a detached job, not awaited by the call that ends the run. No migration.
- Cost: one tree snapshot per hand-in and one at the end of the run (measured on this repo in the PR). Off switch:
  `history.changes.enabled: false`.
- **What the critique changed (round 6, no blocker left):** one rule for the chain after a failed hand-in; the end patch is
  detached with its own shutdown and `done` handling; core drops a bad host-made field instead of refusing the hand-in; a
  deadline back-off; trees exempt from redaction; D3 is "header-only file"; a smaller must-have list; the lock change moved to a
  follow-up.
- Risks: hardening of the diff and of tree ids read from an agent-writable journal; secrets in patches; the end patch lost if
  the process is killed; a run paused longer than `gc.pruneExpire` loses its trees.

## Decisions needed

1. **Where the `changes()`/`changesSince` tree-id check goes (P0).** It fixes an existing hole (a tree id like
   `--output=...` in `snapshots.json` reaches `git diff`), shared with the new `patch()` through one helper.
   Options: (a) the first, tiny part of this task (recommended: the helper is shared, about 10 lines); (b) a separate task
   merged first. If unanswered: (a).
2. **Acceptance wording of `git apply --check`.** The Done-when check holds only for a text-only, unredacted run from a clean
   start (D1, D2 and redaction make others fail by design). Recommendation: accept this wording; the real `dev.yaml` run must
   be shown clean if it has no redaction hit (a lockfile or token fixture), and a hit is reported, not hidden. If unanswered: this.

Decided by the person in this run: **D1** binaries are not embedded, the patch says `Binary files differ`; **D2** `run.patch` is
start tree -> end tree, nothing is marked for a dirty start, re-applying is not promised.

Design choices taken (numbered for test names; veto if wrong): **D3** an unchanged node writes a header-only file (just
`# kodel-patch v1`), so a missing file means "not recorded"; **D4** a node patch is *everything that changed in the work tree
since the previous hand-in* (or the run start for the first), so edits made in between (checks, commands, a person at a gate, a
superseded attempt) land in the next agent patch and in `run.patch`; a start tree taken at every node entry was dropped (it needs
a snapshot under the lock and a core effect); **D5** a failure of snapshot, diff, write or deadline never changes a step or run
verdict, it is recorded (`changes_error`); **D6** not in a patch: ignored files, files hidden by `.git/info/exclude` or by
`core.excludesFile` in `.git/config`, submodules, LFS content, the whole `.kodel/`, folders outside the project root.

**Cut down (said here as the instructions ask).** Follow-ups, not done here: `kodel report` verifying a hash and giving reasons for a
missing patch; a `truncated` flag in `task_size`; protecting trees and patches (hash-protected state, seal); cut-PEM and key-file
secret rules; the `tieEnd`/seal windows; the `recordRunBaseline` unlocked write (it has no new writer here); the snapshot's own use
of repo config; 50 MB and 5000-file tests; an e2e CI step; a ref to keep trees alive (see Rejected). Not split into tasks; PR order:
P0 `changes()` check, P1 patches + off switch, P2 hardening matrix, P3 docs/artifact.

## Behaviour change

With `history.changes.enabled` (default) the run folder gets `changes/`: a patch per handed-in agent attempt and one for the run,
redacted, without `history.changes.exclude` paths, cut at `max_kb`, first line `# kodel-patch v1` (plus `; cut at <n> KB; more
follows` when cut), `index` lines dropped. Off: nothing written, no snapshot of this feature. Old runs unchanged. An attempt that
never hands in has no file. A hand-in can take up to the 20 s deadline longer on a huge tree. The call that ends a run no longer
waits for the end patch; `done` answers do not offer to delete the worktree until the end patch is written (within the wait
budget; later it says it is still being written). `kodel gate` that ends a run starts the same job in its own process and waits
for it before exiting. A project below the repository root gets project-relative patches (apply from the project folder).
`<node>-<attempt>.patch` names are not a contract: the journal `ref` is the truth.

## Risks and invariants

- **1 Agent input untrusted / hardening.** Patches are computed in a **private bare git dir** (cwd = that temp dir):
  `git init --bare --template=` with the repository's object format; `objects/info/alternates` with the **absolute** object
  directory (`path.resolve`, written with `/`; git prints it relative from a normal checkout); every inherited `GIT_*` variable
  dropped except `GIT_EXEC_PATH`; `GIT_DIR`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_ATTR_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` = a file that does
  not exist in the temp dir, `HOME`/`XDG_CONFIG_HOME` in the temp dir. Discovery (`rev-parse --git-path objects`, object format)
  runs in the **normal** environment (so `safe.directory` is honoured); only `init`, `update-index`, `write-tree` and `diff` are
  scrubbed. Flags: `--no-ext-diff --no-textconv --no-color --no-renames --src-prefix=a/ --dst-prefix=b/ --relative=<prefix>
  -c core.quotePath=true`, then `--end-of-options` before tree ids. **Tree ids come from the journal and `snapshots.json`
  (agent-writable)**: each is checked against `^[0-9a-f]{40}([0-9a-f]{24})?$` first (a bad one is a `changes_error`), also in
  `changes()`/`changesSince` (P0). `exclude`: two filtered trees via `ls-tree -r -z` + `update-index --add --index-info` in a
  private index (no `read-tree`), only when a path matches; project-relative paths, `minimatch` with `dot: true` as `isValidGlob`.
  Temp dir removed in `finally` (`rm` with retries). The hand-in snapshot and patch share one **20 s deadline**
  (`HAND_IN_DEADLINE_MS`, checked between git calls and passed to each as a timeout; git is killed on expiry); the end job has 120 s.
  Back-off: if the two previous hand-ins ended with `changes_error: "deadline: ..."`, this hand-in skips the snapshot and records
  `skipped: earlier hand-ins exceeded the deadline`. Tested minimum git 2.39 (verified manually); the Windows hardening test asserts
  that `git config --show-origin --list` under the scrubbed environment shows no ProgramData or user path.
- **2 Fail closed.** A patch is a record, never a verdict (D5). The state pre-check in `completeStep` is in a `try`; a damaged
  state is left for `apply` to refuse. The host validates `changes`/`tree` first and turns a bad value into `changes_error`; core
  **drops** an invalid optional `changes`/`tree` (a last-line guard) and never refuses the hand-in for it.
- **3 Redact.** The writer redacts with the rules as they are at write time (an agent editing `config.yaml` can remove a custom
  rule before its hand-in: documented limit); drops `index` lines; error texts are redacted, root replaced by `.`, cut at 200
  characters, `changes_error` joins the fields `redactEvent` covers. The read is cut at `maxBytes + margin`, the last partial line
  dropped, redaction, then the cut at `maxBytes` on a line boundary. The journal's `redactDeep` leaves a valid SHA in the field
  `tree` alone (a project rule like `[0-9a-f]{32,}` would otherwise break the chain). A tree id, the previous tree and a redacted
  patch let someone confirm a guess of a small secret (the dropped `index` lines only stop the casual leak): documented.
- **4, 5 No I/O in pipeline-core.** Core gets optional fields on `agent_completed` (`changes`, `changes_error`, `tree`) and one
  small event; no effect, nothing in `enter()`. The switch is read from `state.history.changes`. `minimatch` is added to
  `packages/local` (already a dependency of core; justified in the PR); a test pins that core imports no `node:fs` or
  `node:child_process`.
- **6 Humans decide trust.** No tool or argument is added; nothing from a patch reaches an agent answer.
- **7 Kinds are adapters.** An attempt is `visit.phase === "agent"` in the host, never `node.kind` (a custom agent-phase kind is
  patched, a non-agent node of any kind is not).
- **8 Formats / stored data.** New optional: `agent_completed.changes {ref, bytes, truncated}`, `.changes_error`, `.tree`; the
  journal event `changes_recorded {changes | changes_error}` for the run, allowed on a finished run like `task_note`. Nothing
  renamed or retyped; the v1 goldens still open; a run with the new fields is a fixture beside the tests. The patch header has a
  documented grammar.
- **Chain rule (one rule).** The base of a hand-in is the `tree` of the **immediately previous** `agent_completed`. If that event
  has no `tree` (its snapshot failed, or it predates the feature) this hand-in records `changes_error: "no recorded start"` and
  **no patch**, but still records its own `tree` whenever its snapshot succeeded, so the next hand-in chains. The `run` tree is
  the base only when there is no earlier `agent_completed`. A run resumed after a crash between `writeState` and `appendJournal`
  (the event is lost) may widen the next patch: documented.
- **Locks and time.** No snapshot and no `snapshots.json` writer inside the lock; nothing calls `withLock` from `apply`/`dispatch`.
  The end job is started right after the finishing `apply` (before the slow `tieEnd` tracker call), is **not** awaited by the
  caller, is registered in `pending` so `settle()` covers it, and applies `changes_recorded` through the normal queue. The mcp
  server's shutdown calls a new `LocalPipelineHost.settle(deadline)` (10 s) that waits for every cached run; this is the
  SIGINT/SIGTERM and the stdin-closed path (`StoppableHost` is widened). A process killed during the end snapshot leaves no
  `run.patch` and no record (documented). A hand-in call is up to 20 s deadline plus the 20 s wait budget, so a client with a
  timeout under 45 s may give up; the step is still handed in.
- **Files.** Node patches: exclusive create `<node>-<attempt>.patch`, then `<node>-<attempt>~<n>.patch` if taken (re-added node,
  same-node race); a file made for a call that is then refused or throws is deleted in a `finally`; a file with no journal ref is
  ignored. `run.patch` is written atomically, and only if no `changes_recorded` exists yet (a recorded patch is not replaced).
- **Trust.** Trees in the journal and `snapshots.json` and the patch files are agent-writable and outside the seal: an agent can
  blank or skew its own history or overwrite `changes/run.patch`. Same level as today's baselines; the docs say it is history, not
  evidence.
- **Known limits (docs/changes.md; each is pinned by a `t36tw_limit_*` test or marked policy = not testable):** D1 and D6; a
  redacted or cut patch does not apply; multi-line redaction breaks hunk counts; `task_size` of a cut patch is low; parallel
  attempts share the tree and the second hand-in repeats the first's work; non-UTF-8 content is rewritten; trees pruned by `git gc`
  (a run paused past `gc.pruneExpire`, 2 weeks, or a repo with `gc.pruneExpire=now`, gets `changes_error` for the end patch and
  the first hand-in after the pause); the start snapshot may read a tree an entry command is changing (existing
  `recordRunBaseline` timing); `changes_recorded` is refused if `state.json` was edited after the finish (the file may still be
  on disk and `report` reads it); the unreferenced loose objects can trigger `gc --auto`; `*.lock` must be `**/*.lock` in
  `exclude`; a `!` glob means "everything but"; policy: the object store is agent-writable, the seal "modified" window, an agent can
  rewrite patches.

## Acceptance criteria and tests

**M** must have (maps to Done-when or to an invariant), **S** may be cut in review. PR: P0, P1, P2, P3. Each row names the control
that would catch a regression; a plain-code mutation (the check moved, the guard removed) is run once per M row in the PR.

| M/S | PR | criterion | tests (named) | control: fails if |
| --- | --- | --- | --- | --- |
| M | P1 | node patch = the work since the previous hand-in; first starts at the run start; the failed check's edits and the fix are in the rework patch | `t36tw_d4_patch_is_work_since_previous_hand_in`, `t36tw_d4_first_patch_starts_at_run_start` | a patch holds edits from before the previous hand-in or after this one |
| M | P1 | `run.patch` = start -> end (oracle from tree objects); a dirty start holds only what the run changed | `t36tw_run_patch_is_start_to_end`, `t36tw_d2_dirty_start_run_patch_is_start_to_end` | hashes differ, or the start tree is HEAD |
| M | P1 | D3: an unchanged node writes a header-only file; "not recorded" (`changes_error`, no file) differs | `t36tw_d3_unchanged_node_writes_header_only_file`, `t36tw_not_recorded_differs_from_unchanged` | no file, or a diff body |
| M | P1 | survives branch deletion and `git gc --prune=now` | `t36tw_patch_survives_branch_delete_and_gc` | the file is gone |
| M | P1 | off: no file, snapshotter called 0 times by this feature (pipeline with a diff check; root run and worktree run through a minimal per-cwd snapshotter factory) | `t36tw_off_writes_nothing_and_takes_no_snapshot` | any extra call |
| M | P1 | the hand-in snapshot is before the checks | `t36tw_hand_in_snapshot_is_before_checks` (a check that appends a file) | the appended file is in this node's patch |
| M | P1 | chain rule: A ok, B snapshot fails, C gets `changes_error` and records its tree, D chains; run started before the upgrade (earlier events have no `tree`) never gets earlier work in a patch; a run with no `history.changes` writes nothing | `t36tw_chain_failure_then_recovery`, `t36tw_run_started_before_upgrade_never_widens`, `t36tw_run_without_history_changes_writes_nothing` | a patch holds an earlier node's work |
| M | P1 | D5, at hand-in and at the end, each case: snapshot, diff, write, deadline (hung fake spawn is killed), missing start tree, `.git` gone, workdir gone; verdict, seal and `tieEnd` unchanged; error has no root path, is redacted, <= 200 chars | `t36tw_d5_hand_in_<case>_is_recorded_not_fatal`, `t36tw_d5_end_<case>_is_recorded_not_fatal` (7 each), `t36tw_deadline_kills_hung_git`, `t36tw_redact_event_covers_changes_error` | verdict changes or loss unrecorded |
| M | P1 | deadline back-off after two deadline errors; a bad `changes`/`tree` from the host becomes `changes_error` and the hand-in is accepted; core drops a bad value | `t36tw_deadline_backoff`, `t36tw_bad_host_field_is_error_not_refusal`, `t36tw_core_drops_invalid_changes_and_tree` | a refused hand-in |
| M | P1 | `complete_step` refused / repeated / wrong attempt / non-agent phase / blocked by a pending change / damaged state / `apply` throws (lock timeout) leaves no file and the usual error; same-node race (injected pause) gives distinct names and the journal ref is followed | `t36tw_complete_step_leaves_no_file_when_<case>` (7), `t36tw_same_node_race_distinct_names`, `t36tw_agent_phase_not_node_kind` | an orphan, an overwrite, a changed error |
| M | P1 | the end patch: written for completed, failed, canceled and gate-rejected runs (a second host stands for `kodel gate`, worktree run) and a run with no agent node; the call that ends a run returns before it; `settle()` waits for it; shutdown settles it by deadline and still exits when it hangs; `done` withholds the delete hint until written; `run.patch` is not replaced once recorded and is written atomically | `t36tw_run_patch_for_every_end`, `t36tw_run_patch_when_gate_finishes_run`, `t36tw_finishing_call_returns_before_end_snapshot`, `t36tw_settle_waits_for_end_patch`, `t36tw_shutdown_settles_end_patch`, `t36tw_shutdown_exits_when_end_patch_hangs`, `t36tw_done_withholds_delete_hint_until_written`, `t36tw_run_patch_not_replaced_after_record`, `t36tw_run_patch_write_is_atomic` | `run.patch` missing after `settle()`, or the caller blocks |
| M | P1 | `exclude`: dotfile, nested, `**`, renamed, deleted, below the repo root (prefix stripped, applies from the project folder); each absence test has a positive control in the same patch | `t36tw_exclude_dotfile`, `_nested`, `_globstar`, `_renamed`, `_deleted`, `_below_repo_root` | an excluded path appears or the patch is empty |
| M | P1 | secrets: added by the agent in `+`, in `-`, in a name; a generic token cut at the read limit (no run of 8 of its characters); `index` lines absent; a hostile project rule does not break the chain (`tree` exempt); the tree-id guess limit | `t36tw_secret_added_line`, `_removed_line`, `_in_name`, `t36tw_secret_cut_at_read_limit`, `t36tw_index_lines_are_dropped`, `t36tw_hostile_redaction_rule_keeps_tree`, `t36tw_limit_tree_id_confirms_guess` | a fragment survives, or the chain breaks |
| M | P1 | D1, D6 and limits: binary shows `Binary files differ`; ignored, `.git/info/exclude`, `core.excludesFile`, submodule, `.kodel` absent; a pruned tree gives `changes_error`; `*.lock`, `!` glob, redacted patch does not apply, multi-line redaction, cut `task_size` low, parallel double counting, non-UTF-8, cut PEM leaks at most 31 chars, an agent overwrites a patch/tree undetected | `t36tw_d1_binary_file_is_marked_not_embedded`, `t36tw_d6_ignored`, `_info_exclude`, `_excludes_file`, `_submodule`, `_kodel_dir`, `_pruned_tree`, `t36tw_limit_<x>` (one per limit above) | a hidden file appears, or a limit does not hold |
| M | P1 | fields: ref/tree validation in the host (`..`, absolute, `\`, non-SHA); `changes_recorded` accepted on a finished run, other events refused; the new-fields fixture opens with `status`/`report`; v1 goldens open; writer refuses a traversal name and a symlinked `changes/`; core pulls in no I/O | `t36tw_event_fields`, `t36tw_bad_ref_and_tree`, `t36tw_new_fields_fixture_opens`, `t36tw_writer_rejects_traversal_and_symlinked_dir`, `t36tw_core_stays_pure`, existing `formats.test.ts` | an accepted bad value |
| M | P0 | a tree id that is not a SHA (`--output=...`, `-p`) is refused in `patch()` and in `changes()`/`changesSince`, creates no file; control: plain `git diff --output` writes | `t36tw_hardening_tree_id_option_injection` | a file is written |
| M | P2 | hardening, one per payload, with a stated control: attribute/config cases (`* -diff`, `diff=x`+`diff.x.binary`, `core.bigFileThreshold`, `init.templateDir` seed) — plain `git diff` is fooled; process cases (textconv, `diff.external`/`GIT_EXTERNAL_DIFF`, `core.fsmonitor`, a hook, `core.hooksPath`, `core.attributesFile`) — the payload marker fires in a real call such as `git status`, never in `patch()`; a parameterised test over `diff.noprefix`/`mnemonicPrefix`/`renames`/`algorithm`/`context`/`orderFile`/`indentHeuristic`; inherited `GIT_WORK_TREE`/`GIT_DIR`/`GIT_CONFIG_PARAMETERS`; discovery uses the normal env; temp dir removed on success and failure; `worktree: off`, linked worktree, own alternates; the tests restore `process.env` in `finally`, print the git version | `t36tw_hardening_<payload>` (one name per payload), `t36tw_hardening_diff_config_keys`, `t36tw_discovery_uses_normal_env`, `t36tw_worktree_off_relative_objects_path`, `t36tw_linked_worktree_objects`, `t36tw_repo_with_own_alternates` | a payload ran or a patch differs from the reference |
| M | P2 | no new agent tool or argument; agent answers carry no patch data; a config edit mid-run changes nothing | `t36tw_no_new_agent_tool_or_argument`, `t36tw_agent_answers_do_not_leak_patch_data`, `t36tw_config_edit_mid_run_is_ignored` | the run follows the file |
| M | P3 | a clean worktree, text-only, unredacted run: `git apply --check` of `run.patch` on a clean checkout of `base_commit` (project folder), not gated | `t36tw_run_patch_applies_on_clean_base_checkout` | apply fails |
| M | P3 | the real `.kodel/pipelines/dev.yaml`, driven by the scripted testkit agent with commands stubbed through the host's `runCommand` option, leaves node patches and `run.patch` (not gated); the built-artifact scenario in `scripts/check-artifact.mjs` (rework, gate, branch delete + gc, `enabled:false`) | `t36tw_real_dev_yaml_scripted_run_leaves_patches`, artifact check; `tests/e2e/changes.test.ts` (`KODEL_E2E=1`) | no file |
| M | P3 | evidence of the real agent run: the assertion in `tests/agents/dev-pipeline.test.ts` (gated as now) and a manual run of `dev.yaml` at the final gate, recorded by the person, showing patches and `git apply --check` (or the redaction hit that explains a failure) | assertion; manual step | no patch |
| S | P1 | corner cases (oracle: `git apply` onto the `from` tree with `autocrlf=false` equals the `to` tree; text only, scope stated per test; rename is delete + add under `--no-renames`): new, deleted, renamed, mode change, symlink (not on Windows), odd names (space, quote, unicode, 4 cases; newline not on Windows), agent commit; more: CRLF, no trailing newline, file<->dir swap, empty file, dangling symlink | `t36tw_corner_new`, `_deleted`, `_renamed`, `_mode`, `_symlink`, `_name_space`, `_name_quote`, `_name_unicode`, `_name_dash`, `_agent_commit`, ... | hashes differ |
| S | P1 | truncation: exactly `max_kb`, `+1`, grammar, line and UTF-8 boundary, not inside `[REDACTED:...]`, `bytes` = size on disk when redaction shrinks the head; an endless fake spawn is killed and bytes read are bounded | `t36tw_truncation_exact`, `_plus_one`, `_utf8`, `_not_in_mask`, `_bytes_on_disk`, `t36tw_large_input_cap_kills_git` | a boundary is wrong |
| S | P1 | an orphan file is ignored and the retry uses `~1`; a skewed valid tree id gives a skewed patch, not a crash | `t36tw_orphan_file_is_ignored`, `t36tw_limit_skewed_tree_id` | a wrong ref |
| S | P3 | docs: every limit in `docs/changes.md` is a table row naming an existing test or `policy` | `t36tw_docs_limits_have_tests` | a limit without a test |

---

## Steps

0. Read `tests/agents/harness.ts`, `dev-pipeline.test.ts`, `mcp-server.ts`, `pipeline-host.ts`; reuse the driver.
**P0.** 1. `treeId()` validation and `--end-of-options` in `git.ts` `changes()`/`changesSince`; the injection test.
**P1 (patches and off switch).**
2. **core `run.ts`.** `ChangesRef`; `agent_completed` optional `changes`, `changes_error`, `tree` (an invalid one is dropped); event
   `changes_recorded {changes | changes_error}` on a finished run like `task_note`; `changes_error` joins the redacted free-text
   fields; the journal's `redactDeep` leaves a valid SHA in `tree`.
3. **`git.ts`.** `isolatedGit()` (scrubbed env, private dir, cwd = temp dir, always cleaned, discovery in the normal env); one
   deadline across the calls of `snapshot()`; `GitSnapshotter.patch(from, to, {exclude, maxBytes, prefix, deadline})`; `treeId()`;
   stdout through `spawn` up to `maxBytes + margin`, git killed past it. `host.ts` creates snapshotters through a minimal injectable
   per-cwd factory (an injected `options.snapshotter` is returned for every run today).
4. **`store.ts`.** `writeChanges(runId, name, buf, {maxKb})`: drop `index` lines and the last partial line at the read limit, redact,
   cut, header, exclusive create with `~<n>` for node patches, atomic write for `run.patch` (skipped if `changes_recorded` exists), name
   validation like `writeArtifact`, no symlinked directory followed; `deleteChanges` (in `finally`).
5. **`host.ts`.** (a) `completeStep`, after the blocking-change early return, only if the visit is active in phase `agent` with the same
   `attempt` (state read in a `try`): back-off check; snapshot (deadline); base by the chain rule; `patch(base, now)`; `writeChanges`;
   `changes`/`changes_error`/`tree` into the event; delete the file in a `finally` if `apply` refuses, repeats or throws. Before the
   checks. (b) When `apply()` finishes the run: start the detached end job (snapshot, `patch(run, now)`, write, `changes_recorded`)
   before `tieEnd`, registered in `pending`, never awaited by the caller; `kodel gate` awaits it before exit; the `done` answer withholds
   the delete hint while it is pending. (c) Settings from `state.history.changes`; off means none of this runs.
**P2.** 6. The hardening matrix and fixes; `LocalPipelineHost.settle(deadline)` and a widened `StoppableHost` in `mcp-server.ts` (the
settle test sits in P1 with it; keep it small). **P3.** 7. `docs/changes.md` (files, fields, header grammar, hardening, every limit with
its test or `policy`, apply from the project folder, minimum git, "history, not evidence", loose objects and `gc --auto`);
`minimatch` in `packages/local/package.json`; the artifact scenario; the e2e. 8. Run `bun run typecheck`, `lint`, `test`,
`build && node scripts/check-artifact.mjs`, the e2e with `KODEL_E2E=1`; measure hand-in and end time on this repo (the last hand-in
snapshots twice) and put it in the PR.

## Affected files

- `packages/pipeline-core/src/run.ts`, `redact.ts` or the journal write, `index.ts`, tests there
- `packages/local/src/git.ts`, `store.ts`, `host.ts`, `pipeline-host.ts`, `packages/local/package.json`; `packages/cli/src/mcp-server.ts`
- `packages/local/test/git.test.ts`, `host.test.ts`, `hardening.test.ts`, `formats.test.ts`, new `changes-patch.test.ts` (+ a fixture run)
- `tests/e2e/changes.test.ts`, `tests/agents/dev-pipeline.test.ts`, `scripts/check-artifact.mjs`, `docs/changes.md`

## Rejected review findings

Taken in this round: the single chain rule and its tests; core drops instead of refusing; the detached end job with `done`, gate and
shutdown handling; the 20 s deadline and the back-off; trees exempt from redaction; D3 as header-only; the `finally` for the file;
discovery in the normal env; run.patch not replaced; named test lists, controls and the `limit_*` rule; `t36tw_agent_phase_not_node_kind`;
`LocalPipelineHost.settle`; a scripted run of the real `dev.yaml`; P0 as a decision; the smaller M list; the lock change moved out.
Rejected or deferred, with the reason:
- **[gaps 4] Keep a ref under `refs/kodel/<run>/` so a long pause survives `gc --auto`.** The task decides "store the diff as files, not as git refs"; so the
  limit is documented (`gc.pruneExpire`) and the loss is a recorded `changes_error`.
- **[invariants 1] Keep tree ids out of tracked history.** The chain needs them; a tree id lets someone confirm a guess of a small
  secret. Documented and pinned (`t36tw_limit_tree_id_confirms_guess`); the `index` drop stays as a partial measure.
- **[invariants 8] Freeze the redaction rules at the run start.** Not done: it changes how `config.yaml` is read for all writers. Documented.
- **[invariants 7] Take the start snapshot before entry work is spawned.** Existing `recordRunBaseline` timing; documented limit.
- **[invariants 6] Re-read the base under the lock.** Parallel attempts are not supported by the engine's one-active-visit model in
  practice; the double counting is documented and pinned.
- **[gaps 13] Reuse the hand-in tree for the end snapshot.** Not done: engine work may run between them; the double snapshot is measured in the PR.
- **[scope 6] `recordRunBaseline` lock change and its two tests.** Moved to a follow-up task: no new writer exists here.
- **[scope 5] Drop `~<n>`, orphan rule, `changes_recorded`, filtered trees, the Windows config test.** Kept: `~n`/orphan protect history
  from being overwritten (S rows), `changes_recorded` is the only record of an end-patch failure (D5), filtered trees do not depend on
  path quoting, the Windows config check is one assertion.
- **[tests 8] A CI job for minimum git and Windows symlink/mode tests.** Symlink and mode corner tests skip on Windows with a named
  reason; no extra CI job (follow-up); "verified manually on 2.39" is stated as such.
- **[scope 1] Split into separate tasks.** Only P0 is offered as a decision; P1-P3 stay one task in four PRs.
- **Snapshot cost, SIGKILL during the end job, a real-agent `dev.yaml` run, `git` below 2.39, a planted `git.exe`:** cannot be shown by a
  test; measured, documented or manual as stated.

## Findings in the code

- `packages/local/src/git.ts`: `snapshot()` (private index, `hash-object --no-filters`, `ls-files --exclude-standard`, `.kodel` excluded,
  paths carry `--show-prefix`, many git calls); `changes()` passes tree ids to `git diff` unchecked (`:284-296`); `git()` spreads
  `process.env`, no timeout.
- `packages/local/src/host.ts:498-503, 1179-1192` `recordRunBaseline` (after the start lock); `:649-652` an injected `options.snapshotter`
  is returned for every run, else `new GitSnapshotter(cwd)`; `:1014-1024` `apply` awaits the `tieEnd` continuation, which is not on
  `this.queue`; `:1466-1487` `settle`; `:1550-1554` the `done` hint; `:1626` `completeStep`; `:1053-1061` `applyLocked` rethrows all but
  `STATE_MODIFIED_EXTERNALLY`; `:195-204` `redactEvent` covers a fixed list; `:343` `output_error` bound; `:1576-1590` `report()` reads the
  fixed `changes/run.patch` (the JSPB test in `cli.test.ts:545-556` stands).
- `packages/pipeline-core/src/service.ts:243,571` the wait budget (20 s) is spent after `completeStep` returns; `next-step.ts:12`
  `MAX_WAIT_S = 45`; `mcp/register.ts:47-50` `afterTool` is awaited.
- `packages/pipeline-core/src/run.ts:825` `agent_completed`; `acceptPipeline` gives a re-added node `attempt: 0`.
- `packages/local/src/store.ts:542-544` `appendJournal` applies `redactDeep` to every string; `:597-604` `writeSnapshot` is a read-modify-write;
  `:659-673` `withLock` is not re-entrant; `:384` exclusive create; the seal covers `state.json` and `journal.jsonl` only.
- `packages/cli/src/mcp-server.ts:23,114-117,133-146` `StoppableHost` and `stopAndWait` (no settle); `packages/local/src/pipeline-host.ts:114,617-621`
  the host caches `LocalRun`s and `stop()` aborts tasks; `main.ts:63` `process.exit`; `cli.ts:248` `afterDecision` waits for rest.
- `history-config.ts` has `changes.exclude` and `max_kb` (TASK-CXSE; `enabled` defaults to true, so pre-upgrade runs already carry it).
  `tests/e2e` is empty; `bun test` discovers all `*.test.ts`.
- Verified with git 2.39: a relative `--git-path objects` breaks `alternates`; `read-tree` needs a work tree; a bare dir with a populated
  index does not read in-tree attributes; `init` templates re-open the attribute hole; `git apply --check` accepts a comment first line;
  a non-existent `GIT_CONFIG_GLOBAL` file is skipped; `--end-of-options` works on tree diffs; `snapshot()` of this 308-file worktree takes ~150 ms.

## As built (differences from the plan)

- `patch()` is the function `patchBetween(root, from, to, options)` in `packages/local/src/patch.ts`, not a method of `GitSnapshotter`:
  `git.ts` is also in the bundle of the hook, which has a 100 KB budget, and `minimatch` and the core would have pushed it to 460 KB.
  `git.ts` keeps the deadline, the tree-id check and `snapshot(deadline)`; `GitSnapshotter.root` is public.
- The hardening and event tests are in `packages/local/test/changes-patch.test.ts` and the other `changes-*.test.ts` files (not in
  `hardening.test.ts`); the core ones in `packages/pipeline-core/test/changes.test.ts`; the shutdown ones in
  `packages/cli/test/shutdown-changes.test.ts`.
- `tests/e2e/changes.test.ts` was not written: a human gate cannot be decided without a terminal (`kodel gate` refuses), so the
  built-artifact scenario is in `scripts/check-artifact.mjs` (a rework, `git gc --prune=now`, the switch off), and the gate decided by
  another process is in `changes-worktree.test.ts`. `test:e2e` and its CI step were not added either (a follow-up, as the plan says).
- Added after the review of the first implementation: `core.hooksPath=<null device>` on every call of a snapshot (`update-index` runs
  `post-index-change` even on a private index), the back-off counts `skipped:` too and holds for the rest of the run, the host checks the
  tree id the snapshot gave, `changes.ref` is exempt from redaction like `tree`, `changesError` is a free-text field of `redactEvent`,
  error texts hide the temporary and the home folder, `execFile`'s `killed` on `maxBuffer` is not a deadline, the `done` answer also waits
  for a patch another process is writing (up to the deadline of the job plus 30 s), `startEndJob` no longer throws for a state with no
  `changes`, `readRunPatch` refuses a link and a file over 8 MB, shutdown waits 30 s, `docs/changes.md` names a test or `policy` for every
  limit and `t36tw_docs_limits_have_tests` checks it.
- Added after the second review: the note of the run's patch (`changes_recorded`) is refused by `applyLocked` unless the run is still
  sealed (it seals the run again, so it must not turn a change of the journal into the run's own), the job gives up and drops its file
  then; `nextStep` looks at the seal under the lock (no false "changed afterwards" while a note is written); the file of a hand-in is
  deleted only if the journal does not point to it (`apply` can throw after it wrote); `settle(deadline)` bounds the wait on the queue;
  `history.changes.max_kb` is at most 8192 and the host clamps what it reads from the state; `LocalRun.endPatchGaveUp` ends the "still
  being recorded" answer when the job cannot write. `t36tw_agent_phase_not_node_kind` uses a plugin kind. Not changed: the check of
  `changes/` is a lstat followed by opens by path (the agent runs as the same user), and the call that ends a run does wait for the end
  job within the engine's wait budget through `waitForRest` (only the host-level `completeStep` returns at once).
- Added after the third review: the look at the seal that the end job takes before it starts is under the lock too (the task's note
  and the patch's note are written at the same moment, each in three steps, and an unlocked look lost the patch in 25 of 40 runs of a
  scratch test; `t36tw_end_note_and_task_note_do_not_race_into_a_lost_patch` repeats it 12 times with a slow journal); an `apply` that
  throws in the end job drops its file and ends the wait; the error text cannot throw (no home folder); the `done` note says there is
  nothing to poll for. Known and left: the 20 s limit covers the git calls and not the whole hand-in (the journal read, the redaction of
  up to 8 MB), core takes `changes_recorded` in any status (only the host sends it), and an error text can carry a path outside the
  root, home and temporary folders. Tests the plan marks M that are still not written: `t36tw_run_patch_for_every_end` for a failed and a
  gate-rejected run, the cases of a pending pipeline change and a damaged state, workdir gone, a per-cwd snapshotter factory, a gate and
  a branch delete in the artifact scenario, and a check that `serveStdio` hands the real host to `stopAndWait`.
- After the fourth review (no major left): the error text hides the real path of the root and puts the longest place first; a folder
  that cannot be removed no longer replaces a patch that was made; the three tests that waited a fixed time wait for what they need;
  tests for the first patch of a dirty start and for a missing start tree at the end with a task link. The merge with `origin/main`
  (the `served/` files and `decisions`) touched `host.ts` and `store.ts` side by side with this change and needed no change of design.
- After the fifth review (one major: tests that could not pass on Windows CI): the tests that need a `#!/bin/sh` payload, an exec bit or a
  link are skipped on Windows (`posixTest`, the mode and link part of the corner test, the folder link of the writer test) and
  `t36tw_hardening_private_dir_is_removed` lists the folder with `readdirSync`; they are the part of the plan that "skips on Windows with a
  named reason", the reason being written beside each. Also: `snapshot()` gives the deadline to its first `git` call (`isRepo`) and no
  longer lets a failed cleanup replace the tree it made; the error text ignores a place of fewer than four
  characters (a `HOME` of `/` mangled every path; the places are named before the redaction, because the entropy rule wipes a long path); the "still being recorded" note is only for a run with a worktree of its own.
- Golden fixture: none was added. The fields are all optional and nothing is renamed or retyped, so rule 1 of "Stored data and
  compatibility" does not ask for one; `t36tw_pipeline_host_settle_waits_for_the_end_patch_and_the_run_reopens` opens a finished run with the
  new fields in a second host and reads its report.
- Named in the plan and not written: `t36tw_concurrent_complete_step_distinct_names` and the cases of a pending pipeline change, a damaged
  state and a thrown `apply` in `complete_step`; the `.git` gone and workdir gone failures; `t36tw_run_patch_for_every_end` for a failed
  and a gate-rejected run (the completed, canceled and gate-by-another-process ends are tested); a per-cwd snapshotter factory (an
  injected snapshotter is still used for every run; the worktree run with the switch off is checked by what it leaves on disk); the S rows
  (CRLF, file/dir swap, empty file, dangling symlink, an orphan file, LFS, non-UTF-8 and `*.lock` limits, which are `policy` in the docs).
  `limit_cut_pem` is pinned at the text level.
- The follow-ups of the plan stand: `kodel report` verifying a hash, protecting trees and patches, the PEM rules, the
  `recordRunBaseline` write without the lock, the use of repo config by `snapshot()`.
