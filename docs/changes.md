# Patches of the work (`changes/*.patch`)

A run keeps what each agent step changed and what the whole run changed, as plain `git diff` text in the
run's folder, independent of the run's branch (a branch that may be deleted after a squash merge) and of
`git gc`. It is a **history** of the work, not a promise that a patch can be applied again.

Switch: `history.changes.enabled` in `.kodel/config.yaml` (on by default), fixed for a run when it starts.
`history.changes.exclude` lists globs of paths that get no patch (project-relative, dotfiles included, so
write `**/*.lock`, not `*.lock`); `history.changes.max_kb` is the largest patch kept (default 512, at most 8192). With the
switch off nothing is written and no snapshot of this feature is taken.

## The files

In `.kodel/runs/<run id>/changes/`:

| file | holds |
| --- | --- |
| `<node>-<attempt>.patch` | the work since the previous hand-in of an agent step (or since the start of the run, for the first), taken when the agent hands the step in and before its checks run |
| `run.patch` | the work from the start of the run to its end, written in the background once the run has ended |

A name that is taken gets a `~<n>` suffix (a node removed from the pipeline and added again starts at
attempt 1 again). The journal says which file is whose; do not rely on the names.

The journal points to them:

- `agent_completed.changes` is `{ ref, bytes, truncated }`; `agent_completed.changes_error` says why there is
  none; `agent_completed.tree` is the work tree at that hand-in, where the next patch starts.
- `changes_recorded` is the same for `run.patch`, written once the run has finished.

A patch that could not be made is recorded and never changes the result of a step or of the run.

## What a patch is

Every file starts with `# kodel-patch v1`, or `# kodel-patch v1; cut at <n> KB; more follows` when it was cut
at `max_kb`. Then comes the output of `git diff` between two trees: `a/` and `b/` prefixes, no renames (a
rename is a delete and an add), paths relative to the project folder (apply from there, or with
`git apply --directory`), `Binary files differ` for binary files, and no `index` lines (a blob id would let
anyone test a guess of a small secret). The text is redacted like everything else that is written.

A step that changed nothing has a file with the header only. A missing file means "not recorded".

## How it is made safe

The agent can write `.gitattributes` and `.git/config`, and a plain `git diff` reads both: one attribute
line makes every file "binary" and the patch empty, other keys run programs. So a patch is computed in a
private bare git directory made for the occasion: no config, no attributes, no hooks, no template, none of
the environment's `GIT_*` variables; the repository's objects are reached through `alternates`. The two trees
come from `snapshots.json` and the journal, which the agent can also write, so every tree id is checked to be
an object id before git sees it (this check is also in the comparison used at gates).

The snapshot and the patch of a hand-in share a 20 second limit; at the end of the run the limit is 120
seconds. A hand-in that does not fit is handed in without a patch and says `deadline:`; after two in a row,
the next ones of the run are not tried and say `skipped:` (`t36tw_deadline_backoff_holds_for_the_rest_of_the_run`).
A snapshot runs no hook of the repository (`t36tw_hardening_snapshot_runs_no_hook`). Tested with git 2.39.

## What is not in a patch, and what may not apply

Each line is a limit and names the test that pins it (`policy`: it cannot be tested).

| limit | test |
| --- | --- |
| Binary content is not embedded | `t36tw_d1_binary_file_is_marked_not_embedded` |
| Ignored files, files in `.git/info/exclude` or hidden through `core.excludesFile` (an agent can write that), the whole `.kodel/` folder | `t36tw_d6_ignored_and_hidden_files_and_kodel_are_not_in_a_patch` |
| Submodules are not followed | `t36tw_d6_a_submodule_is_not_followed` |
| LFS content, anything outside the project folder | `t36tw_project_below_repo_root` (the folder), LFS: policy |
| Files matched by `history.changes.exclude`; `!pattern` means "every path but that one" | `t36tw_exclude_*`, `t36tw_limit_negated_glob_means_everything_but` |
| Work between two hand-ins (a check, a command, a person) is in the next agent patch and in `run.patch`; an attempt that never hands in has no file | `t36tw_limit_parallel_double_counting_and_untouched_work_between_hand_ins` |
| Agent steps that are active at the same time share one tree, and the second hand-in repeats the first's work | `t36tw_limit_parallel_double_counting_and_untouched_work_between_hand_ins` (the case of work in between), the rest: policy |
| A redacted patch may not apply: a secret in a context line, a lockfile integrity string | `t36tw_limit_a_redacted_patch_does_not_apply` |
| A secret that spans lines changes the line counts of its hunk | `t36tw_limit_multi_line_redaction_breaks_the_hunk` |
| A cut patch may cut a key in the middle | `t36tw_limit_cut_pem` |
| `task_size` of a report counts a cut patch as it is | `t36tw_limit_task_size_of_a_cut_patch_is_low` |
| A run that started with uncommitted work: `run.patch` starts from the tree as it was, not from `base_commit` | `t36tw_run_patch_is_start_to_end_and_the_oracle_is_the_trees` |
| Content that is not UTF-8 is rewritten | policy |
| A tree id, the tree before it and a redacted patch let someone confirm a guess of a small secret | `t36tw_limit_tree_id_confirms_guess` |
| The patch files and `snapshots.json` are outside the run's seal (the journal is inside it, so a change of the journal after the run is seen): an agent that can write there can overwrite its own history | `t36tw_limit_an_agent_can_overwrite_a_patch_undetected` |
| The note of the run's patch is written after the run was sealed, and seals it again; it is not written if the files are no longer as the run left them, and the patch is dropped | `t36tw_changes_recorded_is_not_written_over_a_changed_journal` |
| An agent that writes two `agent_completed` lines with a `deadline:` error into the journal switches the patches of hand-ins off for the rest of the run (the end patch is unaffected) | policy (the same trust level as blanking its own history) |
| The same by forged lines: `skipped:` lines count for the back-off like `deadline:` ones, and one `changes_recorded` line written into the journal stops the end patch from being written (and is sealed as the run's own) | policy |
| A quick run of command steps can end before the start of the run is recorded: the patch then has no start tree (an error is recorded) or the work is already in it | policy; `t36tw_d5_missing_start_tree_at_the_end_is_recorded_and_the_task_is_told` for the error |
| A lock that stays busy, or a state that cannot be read, at the end of the run: no note is written (writing it needs the lock) | policy |
| The object store and its `alternates` are agent-writable | policy |
| A tree removed by `git gc` (a run paused longer than `gc.pruneExpire`, two weeks by default) gives `changes_error` for the end of the run and the first hand-in after the pause | `t36tw_d5_a_pruned_start_tree_is_recorded_and_the_next_hand_in_recovers` |
| Every hand-in leaves unreachable objects, which can bring `git gc --auto` earlier | policy |
| A process that is killed, or that leaves the server before the end of the run has been recorded (the server waits 30 seconds), leaves no `run.patch`, no record and its scratch folders in the temporary folder | policy |

`git apply --check run.patch` on a clean checkout of `base_commit` is expected to pass for a run in its own
worktree that changed only text and had nothing to redact (`t36tw_run_patch_applies_on_clean_base_checkout`).
Whether it is the case for a real run of the pipeline is checked by a person at the final gate.

## Where a patch is looked for

`kodel report` reads `changes/run.patch` by its name, not through the journal; it refuses a link in place of the
folder or the file and a file over 8 MB. The journal's `changes_recorded` says whether the file was meant to be
there.
