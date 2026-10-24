# TASK-HP9R: check_id and params_hash on check results

## Goal

Every `check_finished` journal record carries a stable `check_id` and a `params_hash`, so the
failures of one check can be followed across runs and across changes of its condition (fail -> change
the params -> pass reads as one chain by `check_id`, with two different `params_hash` values). The
node's last failure keeps `check_id`, so the retry text can name the check (used later by the
wrong_check task). Prerequisite TASK-36HG (golden v1 fixtures) is merged (`5db3150`).

## Facts found in the repository

- The journal record is written in the core, in `Run.decide`, case `"check_finished"`
  (`packages/pipeline-core/src/run.ts` ~745). It already derives `kind` from `NodeSpec.checks[index]`
  and does not take it from the event, so `check_id` and `params_hash` are derived there too; the
  event types and the three producers (`packages/local/src/host.ts` x2, `packages/testkit/src/memory-engine.ts`)
  need no change.
- `EngineOptions.fingerprint` (text -> short stable string) already exists and is used by
  `definitionOf`; the local host injects `hashSource`. Without it the journal simply has no hashes.
- `stableJson` (`canonical.ts`) sorts object keys; YAML comments and layout are gone after parsing,
  so hashing `stableJson(check.params)` ignores key order and comments. Hash the *declared* params
  (`check.params`), not the rendered ones (`renderDeep(...)` in `emitCheck`): the rendered form changes
  with run context and would make the chain break for no change of the condition.
- `Feedback` (`run.ts:48`) is what `NodeRun.lastFailure` stores in `state.json` and what
  `next-step.ts` prints in `reentry_feedback`. `finish()` receives it from the check case
  (`source: "check:<kind>"`).
- `report.ts` (`summarizeRun`, ~175) reads `check_finished` records field by field with type guards,
  so old records without the new fields already parse.
- Stored-data rules (AGENTS.md): both fields are new optional fields, nothing is renamed, removed or
  retyped, so no migration reader is needed; a test must still open the v1 fixtures
  (`fixtures/formats/v1/*`, whose journals contain `check_finished` without the fields).

## Design

- `checkIdOf(node: NodeSpec, index: number): string | undefined` in `canonical.ts` (pure, next to
  `stableJson`): `"<node.slug>/<kind>#<n>"`, `n` = 1-based position among the checks **of that kind**
  in the node. Returns `undefined` for an index with no check.
- `paramsHashOf` as a private method of `Run` (needs `this.fingerprint`): `fingerprint(stableJson(check.params))`,
  `undefined` when no fingerprint is injected (the field is then absent, not empty).
- Journal: `check_finished` gets `check_id` and, when available, `params_hash`.
- `Feedback` gets an optional `check_id?: string`, set by the check case in `finish`. It is cleared
  with `lastFailure` when the node passes (existing code). `reentry_feedback` text names it:
  `... failed (check:command #check_id): ...` is **not** changed in wording beyond appending the id in
  parentheses only when present, so existing text tests stay green; the exact wording is fixed in the
  test.
- Documented behaviour (comment on `checkIdOf` and a test): the id does not change when params change;
  it changes only when checks of the same kind in the node are reordered or one is inserted before.
  Two nodes with the same kind get different ids (the node slug is in it). A rework (attempt 2) gives
  the same id. A kind unknown to the registry still gets an id (it is derived from the spec only).

## Affected files

- `packages/pipeline-core/src/canonical.ts`: `checkIdOf`.
- `packages/pipeline-core/src/run.ts`: `Feedback.check_id`, journal fields in the `check_finished`
  case, pass `check_id` into the failure.
- `packages/pipeline-core/src/next-step.ts`: name the check in `reentry_feedback` (small).
- `packages/pipeline-core/src/index.ts`: export `checkIdOf` if the other canonical helpers are exported.
- `packages/pipeline-core/src/report.ts`: optionally carry `check_id` and `params_hash` into the
  per-check summary row (read with the same type guards); only if `report.test.ts` shows it is cheap.
- Tests (below). No change to `AGENTS.md`, `.mcp.json`, `.claude/settings*`, `.kodel/pipelines/`.

## Steps

1. `checkIdOf` + unit tests in `canonical.test.ts`.
2. `Run`: add the fields to the journal record and to `Feedback`; unit tests in `run.test.ts`.
3. `next-step.ts` retry text names the check; adjust `next-step.test.ts`.
4. Testkit scenario: fail -> change the check params (via an accepted pipeline change) -> pass; read the
   journal and assert one `check_id`, two different `params_hash` values.
5. Local integration test: ids survive a node restart and a recheck after `pipeline_accepted`.
6. Fixture test: open the v1 fixtures (`status`, `report`) and an old-style journal line without the
   fields; no error.
7. Run `bun run typecheck`, `bun run lint`, `bun test`, `bun run build && node scripts/check-artifact.mjs`.
8. Real run check: a run of the `dev` pipeline writes `check_id` and `params_hash` in `journal.jsonl`.

## Test strategy

Names carry the task id, e.g. `hp9r_check_id_counts_per_kind`.

- Unit (`canonical.test.ts`, `run.test.ts`): ids for one check, two checks of one kind
  (`#1`, `#2`), mixed kinds (each kind counts from 1); id stable when params change; `params_hash`
  ignores key order and YAML comments, changes with any param (nested objects, arrays, unicode, null,
  a huge value); the journal record has both fields; a node with no checks writes nothing; same kind
  three times and the middle one removed by a pipeline change -> ids shift (documented and asserted);
  two nodes with one kind -> ids differ by node; unknown kind -> id still present; attempt 2 -> same
  id; no `fingerprint` -> `params_hash` absent, `check_id` present.
- `lastFailure.check_id` is set on a failed check and gone after a pass; `reentry_feedback` names it.
- Scenario (testkit): the fail -> changed -> pass chain by `check_id`.
- Integration (local): restart of the node and recheck after `pipeline_accepted` keep the ids.
- Fixture: v1 fixture runs and an old journal line without the fields still read.

## Risks

- `state.json` gains an optional field in `lastFailure`: additive, readers ignore unknown keys. If the
  state schema is strict somewhere, the test with the v1 fixtures will show it; then the field is made
  optional in that schema.
- Changing `reentry_feedback` wording could break text assertions in other tests or agent prompts;
  keep the old text as a prefix and add the id only when present.
- Hash input choice (declared vs rendered params): declared was chosen so the id chain does not break
  on run context; the cost is that a changed template variable value is not seen in `params_hash`.
- `check_id` shifts when same-kind checks are inserted or reordered: by design, covered by a test and
  a comment, not a bug.
- Large param values are hashed through `fingerprint` only; nothing is stored in the journal but the
  short hash.
