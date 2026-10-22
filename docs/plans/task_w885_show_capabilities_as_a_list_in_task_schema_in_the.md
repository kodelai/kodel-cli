# TASK-W885: show capabilities as a list in `kodel task schema`

## Goal

`formatSchema` (packages/cli/src/task-format.ts) prints one line,
`capabilities: subtasks yes, runs full, comments append, fields no`. Replace it with a
`capabilities:` heading followed by one item per ENABLED capability. `priority` and `types`
(in `TaskAdapterCapabilities`, but not printed today) are included. `--json` output is not touched.

## Affected files

- packages/cli/src/task-format.ts: `formatSchema` only.
- packages/cli/test/tasks.test.ts: a test for the text output (or the existing schema test).
- No change to packages/cli/src/cli.ts, pipeline-core, or the JSON path.

## Steps

1. In `formatSchema`, build the list from `answer.capabilities`:
   `subtasks` if true; `runs (<attach|full>)` if not `none`; `comments (append)` if not `none`;
   `fields` if true; `priority` if true; `types` if true.
2. Emit `capabilities:` then `  <item>` per line (same two-space indent as the other sections);
   if none is enabled, print `capabilities: none`.
3. Keep the blank line before `statuses:`.

## Test strategy

- Text output for the local adapter lists subtasks, runs (full), comments (append), priority and
  does not mention fields or types.
- An adapter with everything on lists all six; one with nothing on prints `capabilities: none`.
- `--json` output still equals the raw answer (existing test stays green).
- `bun run typecheck`, `bun run lint`, `bun test`.

## Risks

- Anything parsing the old one-line text format: grep found no use besides `formatSchema`.
- Item wording for `runs` and `comments` changes the visible text; kept short with the level in brackets.
