# TASK-WSBD: a table header in `task list` and the other list outputs

## Goal

The list commands print a header row by default, with columns padded to the widest cell (like
`kubectl get`). `--no-headers` drops the header for scripts. `--json` is unchanged. Every text that comes
from a task or a run still goes through `plain()`.

## What I found (list-shaped output)

- `kodel task list` (`packages/cli/src/cli.ts`, `task.command("list")`; line format in
  `packages/cli/src/task-format.ts` `formatTaskLine`). One line per task, two spaces between values, an
  optional `↳ parent`, `[done/total subtasks done]`, and the latest comment on a second line.
- `kodel status` without a run (`cli.ts`, `status [run]`). One line per run: id, pipeline, status, optional
  `[pipeline change waiting]`, optional `in <workdir>`, task text.
- Looked at and left alone: `pipeline changes history` (numbered versions with indented detail lines, it
  is a log, not columns), `status <run>` and `task show` (key: value records), `report` (a report),
  `task schema` (sections). `task doctor` prints problems, not a list. No new output is invented.

## Design

- A small table helper in `packages/cli/src/task-format.ts` or a new `packages/cli/src/table.ts`
  (preferred, since both `status` and `task list` use it):
  `formatTable(header: string[], rows: string[][], opts: {headers: boolean}): string[]`.
  It pads every column but the last to the widest cell of that column (header included), joined by two
  spaces, trims trailing spaces. Width is `[...text].length` (code points); the cells are already `plain()`ed,
  so they have no control characters or line breaks.
- Task table columns: `KEY  STATUS  PRIORITY  TITLE  SUBTASKS  PARENT`.
  - STATUS keeps `status (state)` when they differ; PRIORITY is `-` when missing.
  - SUBTASKS is `done/total` or `-`; PARENT is the parent key or `-`. Both columns go after TITLE so a long
    title does not push them around; to keep alignment TITLE is padded too (it is not the last column).
  - The latest comment stays under the row as `    "comment"` (as now), so no column holds free text
    that could be long. Comment lines are not padded.
- `formatTaskLine` is replaced by `formatTaskRows(tasks, plain): string[][]` (cells) plus the table helper;
  `formatTaskLine` is removed if nothing else uses it (checked: only `cli.ts` and tests).
- Run table columns for `status`: `RUN  PIPELINE  STATUS  WORKDIR  TASK`. STATUS is `describeRun(state)` plus
  `[pipeline change waiting]`; WORKDIR is the path or `-`. TASK is last (free text, not padded).
- `--no-headers` option on `task list` and on `status` (commander: `.option("--no-headers", ...)`
  gives `opts.headers === false`). Not offered for `--json`; with `--json` it has no effect.
- `no tasks` / `no runs yet` messages are unchanged, and print no header.
- `cli.ts` changes are kept small: one option line and a call to the helper in each of the two actions
  (the other task adds plural aliases to command groups, so no other lines are touched). The `more:` hint
  for `task list --cursor` stays as is.

## Steps

1. Add `table.ts` with `formatTable` and a unit test file `packages/cli/test/table.test.ts`.
2. Change `task-format.ts` (task rows) and the `task list` action; add `--no-headers`.
3. Change the `status` run-list branch; add `--no-headers`.
4. Update the existing tests that read the old output (`packages/cli/test/tasks.test.ts`: the
   `[0/1 subtasks done]` check around line 142 and any `toContain` on the old line format;
   `packages/cli/test/cli.test.ts`: the status list tests around lines 288, 640 and 679, where the line
   count `toBeLessThanOrEqual(6)` must still hold with a header line).
5. Run `bun run typecheck`, `bun run lint`, `bun test`.

## Tests

- Header is the first line of `task list` and of `status`, columns aligned (every row has the
  column starts of the header at the same offsets), with rows of different widths.
- `--no-headers`: no header line, rows as before; `--json` output byte-identical to before (with and
  without `--no-headers`).
- Subtasks (`done/total`) and parent show; the latest comment is still on the line under the row.
- Control characters in a title or a run task do not break the table (still `plain()`ed; no `\u001b`, no
  extra lines).
- Empty list: `no tasks` / `no runs yet`, no header.
- Wide characters: the width is by code points (a title with a non-ASCII letter keeps alignment).

## Risks

- Scripts that parsed the old output now see a header line; `--no-headers` is the way out (documented in
  the option help). Stored data is not touched, so no format change.
- A merge with the aliases task in `cli.ts`: kept to a few lines in two actions.
- East Asian wide characters take two terminal cells; width by code points is a good enough, documented
  approximation.
