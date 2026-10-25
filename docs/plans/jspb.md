# TASK-JSPB: per-check section in the report, and the size of the task

## Goal

`kodel report` (and `report --json`) show, per check: how often it ran, how often it failed, how many
times the agent said it was called wrong, how often its condition (`params_hash`) changed, and how the
next result after such a change ended. The report also prints the size of the task (files, lines
added and removed, top-level directories, languages by extension), computed on read from
`changes/run.patch`; nothing new is stored. Without a patch the section says `not_collected`.

## State of the dependencies (checked in the repo)

- TASK-HP9R is merged: `check_finished` already journals `check_id` and `params_hash`
  (`pipeline-core/src/run.ts` ~786). This is the only dependency the task names.
- TASK-BMBD (the `check` field of `feedback_reported`) is **not** merged. The report reads
  `record.check` when it exists; until BMBD lands, `wrong_check` notes carry no check id, so the per-check
  count stays 0. The plan does not add the field (it belongs to BMBD) and the tests build the journal
  records by hand.
- TASK-36TW (`changes/run.patch`) is **not** merged: nothing writes the file today. So the task size is a
  pure function over patch text, fully unit tested; the host passes it the text when
  `changes/run.patch` exists in the run directory and `not_collected` otherwise. The "report on a real
  run shows a size" part becomes true when 36TW lands; the plan says so in the PR.

## Affected files

- `packages/pipeline-core/src/report.ts`: `RunReport.checks: CheckReport[]` and
  `RunReport.task_size?: TaskSize | { not_collected: true }`; `summarizeRun` fills `checks`.
  New `packages/pipeline-core/src/task-size.ts` with `measurePatch(text: string): TaskSize` (pure), exported
  from `index.ts`.
- `packages/pipeline-core/src/backend.ts` + `packages/local/src/store.ts`: one read-only method
  `readRunPatch(runId): Promise<string | undefined>` (undefined when the file is absent).
- `packages/local/src/host.ts`: `RunHandle.report()` adds `task_size` (calls the store, then
  `measurePatch`; `not_collected` when undefined or when the run's `history.changes` is off).
- `packages/cli/src/format.ts`: `formatReport` prints a "checks" table and a "size" line.
  `cli.ts` needs no change (`--json` prints the report object).
- Tests: `pipeline-core/test/report.test.ts`, new `pipeline-core/test/task-size.test.ts`,
  `cli/test/format.test.ts`, `cli/test/cli.test.ts`, `local/test/formats.test.ts` (fixture check).

## Design

`CheckReport` per `check_id`: `{ check_id, kind, node, runs, fails, wrong_check, params_changes,
after_change: { passed, failed } }`.

- Source: `check_finished` records with `check_id`. A record without `check_id` (a run written before
  HP9R) is skipped, so an old journal gives `checks: []`, not an error.
- `runs` / `fails`: count of `check_finished` / of those with `passed === false`.
- `params_changes`: compare `params_hash` with the previous result of the **same** `check_id`; a different
  value counts as one change. The same hash again after a revert is counted as a change too (it differs
  from the previous result), which is what the corner case asks to be visible.
- `after_change`: the result right after a change of the hash is `passed` or `failed`; count each.
  A recheck after `pipeline_accepted` that changes the hash mid-attempt works the same way, because the
  order is the order of the journal, not of attempts.
- `wrong_check`: `feedback_reported` with `category: "wrong_check"` and a `check` that names a check id;
  counted once per record (one note = one count).
- A check removed from the pipeline stays in the table under its old id (the table is built from the
  journal, never from the current spec).
- Several checks of one kind are separate rows because the key is `check_id`, not `kind`.
- `plain()` already strips control characters in `formatReport`; ids and kinds go through it, so
  terminal-escape characters in them are escaped.

`measurePatch` parses `git diff` text line by line without a regex over the whole text (a huge file
must not blow up memory or time):

- `diff --git a/<p> b/<q>` starts a file; quoted names (`"a/\303\244"`) and paths with spaces are read
  from the `---`/`+++` lines and `rename from/to`, falling back to the header.
- new file (`new file mode`), deleted file (`deleted file mode`), rename (`rename from`/`rename to`, counted
  as one file, no lines when similarity is 100%), `Binary files ... differ` (a file, 0 lines, marked
  binary), an empty patch (all zeros, not an error), CRLF (`\r` is stripped from the line end only, a line
  of `+` alone counts as an added line).
- Lines counted only inside hunks (after `@@`), so `---`/`+++` content lines of a file that starts with
  `--` are not mistaken for headers: track the remaining hunk line counts from `@@ -a,b +c,d @@`.
- `top_dirs`: first path segment (`.` for a file in the root), sorted by file count.
- `languages`: by extension (lowercase, `(none)` for no extension), a small fixed map is not needed:
  the extension itself is the label.

## Steps

1. Tests first (red): `task-size.test.ts` with the cases listed below; `report.test.ts` for the check rows.
2. `task-size.ts`, then `report.ts`; green.
3. Store method and `host.ts`; `formats.test.ts`: both v1 fixtures still report and have `checks: []`
   and `task_size: not_collected`.
4. `format.ts` text; `format.test.ts` and `cli.test.ts` (with and without check rows; the `--json` shape).
5. `bun run typecheck && bun run lint && bun test && bun run build && node scripts/check-artifact.mjs`.

## Test strategy

Names carry the task key (`jspb_...`).

- report.test.ts: fail -> changed -> pass; fail -> changed -> fail; two checks of one kind (two rows);
  `wrong_check` counted once per note; no checks; an old journal (no `check_id`) gives no rows;
  hash changed mid-attempt after `pipeline_accepted`; same hash after a revert; a check no longer in the spec
  keeps its row; an escape character in a reason/id does not reach the text output.
- task-size.test.ts: new file, deleted file, rename, "Binary files differ", empty patch, CRLF file, path
  with spaces and unicode, one huge file (hundreds of thousands of lines, finishes quickly).
- format.test.ts / cli.test.ts: text with and without check rows; `--json` has `checks` and `task_size`.
- formats.test.ts: `report` on both v1 fixtures works, prints no check rows and `not_collected`.
- Done when: per-check rows for a run with check ids, none for the v1 fixtures; the size is computed from
  patch text in unit tests and says `not_collected` without a patch.

## Risks

- Until TASK-36TW and TASK-BMBD are merged, two parts of the section are always empty in real runs
  (`task_size`, `wrong_check`). Merging in the task order avoids it; the code does not depend on them being present.
- `RunReport` is a public shape (CLI `--json`, later the export and the server): the new fields are
  additive and optional where a reader of an old report may lack them.
- A huge or hostile patch: the parser is single pass, constant memory per line, no regex backtracking.
- `report --all` (several runs) is explicitly out of scope: it comes with the failure-codes task.
