# init: do not add entries to .gitignore

## TL;DR

- `kodel init` stops creating or editing `.gitignore`: `ignoreLines`, its constants and `hookFile` are removed (`packages/cli/src/init/index.ts`, `init/hooks.ts`), the tests and the doc that expect it are updated.
- Small change: two source files, one test file, one doc line. No stored format, no engine change.
- Risk: after `init` the run history, worktrees and hook files (which hold unredacted absolute paths) are no longer ignored, so a `git add -A` can commit them. The critique raised this; the plan names it, and the person decided to give no hint.
- The critique changed: the new test must fail on the old code, the "not a git root" note gets a negative assertion, `hookFile` and the stale prompt text are removed, the risks are written out.

## Decisions needed

None open. The person decided:

1. No hint about paths not to commit: not in the report, not in the docs.
2. The lines for the hook files go too (init does not touch `.gitignore` at all).
3. The hooks prompt (`init/index.ts:162`) loses the "(personal, not committed)" remark; nothing replaces it.

## Behaviour change

`kodel init` no longer creates or changes `.gitignore`, in a git repository or outside one. The "not the top of a git repository" note disappears with it, and the report has no `.gitignore` line. Everything else (config, MCP server entry, permissions, skills, hooks) is as before.

## Risks and invariants

- Stored data: nothing stored changes (run state, journal, snapshot, reports). No golden fixture needed.
- pipeline-core: untouched, no I/O added. Humans decide trust: unchanged. The engine stays fail-closed without the ignore lines: snapshots and the dirty-root check already exclude `.kodel`.
- Redaction (Principle 3): `sessions.jsonl` and `hooks.log` hold raw `cwd` and `transcript_path` (home directory, user name) and are not redacted; the ignore line was what kept them out of commits. Accepted by the task and by the person (no hint).
- Un-ignored `.kodel/runs`: with worktree mode off (or falling back), `git add -A` commits run state; a later branch switch or stash rewrites it under the engine, which then reports "state was changed outside kodel". Un-ignored `.kodel/worktrees` is added as embedded repositories, `git status` lists it, and root tools that ignore git rules scan the copies.
- Hook files outside `.kodel` (`.codex/hooks.json`, `.opencode/plugins/kodel-hooks.ts`, maybe `.claude/settings.local.json`) stay untracked, so every worktree-mode `pipeline_start` says the root has uncommitted changes (`worktree.ts:204-212`). True, and caused by init; not changed here.
- `.kodel/proposals` was never in init's list; the older plan left that open, and this closes it as "never".

## Acceptance criteria and tests

- `gy2n_init_never_creates_or_changes_gitignore` (new, `packages/cli/test/init.test.ts`): (1) a git root with no `.gitignore` still has none; (2) an existing `.gitignore` with known bytes is identical afterwards, with hooks and with `--no-hooks`; (3) outside a git root (the test removes `.git` itself) the output contains neither `.gitignore` nor "not the top of a git repository". It must fail on the old code: run it against the old `ignoreLines` before deleting it, and see it fail on (1) and (2).
- `what_the_person_wrote_stays` keeps writing `node_modules\n` and asserts the file is exactly that afterwards.
- `a_second_run_changes_nothing` and `a_rerun_changes_nothing...` (renamed `a_rerun_changes_nothing`): `.gitignore` out of the file lists, the `sessions.jsonl` count lines deleted.
- `hooks_are_registered_by_default_for_the_chosen_agent` loses its ignore-line loop; `no_hooks_leaves_every_hook_file_alone` (renamed) loses its `.gitignore` line; `dry_run_lists_the_hook_files_and_writes_nothing` and `dry_run_writes_nothing` assert `out` has no `.gitignore`.
- `bun run typecheck`, `lint`, `bun test`, `bun run build && node scripts/check-artifact.mjs` pass.
- Not testable: the wording of the docs.

---

## Steps

1. Write the new test first and run it against the old code; it must fail.
2. `packages/cli/src/init/index.ts`: delete `ignoreLines`, `IGNORED`, `HOOK_IGNORED`, the call, and the imports `HOOK_LOG`, `SESSIONS_INDEX`, `hookFile` (`stat`, `join` stay). Drop the "(personal, not committed)" remark from the hooks prompt.
3. `packages/cli/src/init/hooks.ts:53-56`: remove `hookFile` and its comment (its only caller is the deleted call).
4. `packages/cli/test/init.test.ts`: edits as listed above; delete `outside_a_git_root_the_ignore_lines_are_reported`; line numbers ~79, 91, 109-116, 182-187, 414-417, 443, 471, 500-506.
5. `adapters/README.md:25`: drop "and gitignored"; say the files are personal and not committed by init. No other doc change.
6. Run typecheck, lint, tests, build, check-artifact.

## Affected files

- `packages/cli/src/init/index.ts`, `packages/cli/src/init/hooks.ts`
- `packages/cli/test/init.test.ts`
- `adapters/README.md`

Older files in `docs/plans/` mention the gitignore step; they are history and stay.

## Rejected review findings

- [gaps] "Hook files add a permanent uncommitted-changes note" and [gaps] "snapshots include hook files": real but out of scope; recorded under Risks, no change made.
- [scope] "Decisions 1 and 2 are not worth asking": they were asked; the person answered (no hint, remove all).
- [gaps] "Add guidance on paths not to commit" (docs/report): the person decided on no hint.
- [gaps/tests] "`beforeEach` `.git` is dead setup": it stays; the new test needs it.

## Findings in the code

- `packages/cli/src/init/index.ts:59-61` constants, `:134-155` `ignoreLines`, `:162` prompt, `:209-212` the only call.
- `packages/cli/src/init/hooks.ts:53-56` `hookFile`, used only by that call.
- `.gitignore` is touched nowhere else in `packages/*/src`; other tests write their own fixture `.gitignore`.
- `adapters/README.md:25` is the only doc that says init gitignores files.
- `packages/local/src/git.ts:191` and `worktree.ts:207` exclude `.kodel`, so the engine does not rely on the ignore lines.
