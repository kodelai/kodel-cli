# TASK-BMBD: wrong_check names the check; agent instructions

## Goal

Let the agent say *which* check fired for nothing. `pipeline_feedback` gets an optional `check` (a
`check_id`, as in `check_finished` and in the retry text); the engine accepts only an id that belongs
to the node; the journal records it; the retry text names the failed check; the server instructions
tell the agent to offer the person to record `wrong_check` with the id and to record it only after
they agree. The note stays a claim of the agent: it never changes a verdict or the run.

Prerequisites are in: TASK-HP9R (`check_id` on check results, `checkIdOf` in `canonical.ts`,
`Feedback.check_id`, the id in `reentry_feedback`) is merged and its status is `done`. No earlier task
of the epic added a tool argument, and `CONTRACT_VERSION` is still `1`
(`packages/pipeline-core/src/mcp/tools.ts:13`), so **this task makes the 1 -> 2 bump** (epic rule:
the first task that adds `check`, `task` or `executor` bumps, the later ones only add their argument
and update the snapshot).

## Facts found in the repository

- The tool is `pipeline_feedback` in `packages/pipeline-core/src/mcp/tools.ts` (~297). Shape today:
  `run_id, node_slug, attempt, category, message, suggestion`. It calls `PipelineService.feedback`
  (`service.ts` ~558), which splits `node_slug` into `node` and passes the rest to `run.feedback`.
- The event `{type:"feedback"}` is declared in `run.ts` (~255) and handled in `Run.apply` (~647): it
  validates `event.node` with `this.node(...)` (unknown node -> error), then logs `feedback_reported`
  with `node` (the given node, or the only active one, or null), `attempt`, `category`, `message`,
  `suggestion`, `spec`.
- `checkIdOf(node, index)` (`canonical.ts:29`) builds `"<slug>/<kind>#<n>"` from `NodeSpec.checks`;
  `undefined` when there is no check at that index. The set of valid ids of a node is therefore
  `node.checks.map((_, i) => checkIdOf(node, i))`.
- `next-step.ts` ~306 already appends ` (<check_id>)` to `reentry_feedback` for a failed check
  (`hp9r` tests in `next-step.test.ts` ~96 pin the exact text). So "the retry text names the failed
  check_id" is already true for the human-readable string; this task makes sure the text says what to
  *do* with it (see Steps) and keeps the old-run path (no id) unchanged.
- `SERVER_INSTRUCTIONS` is built by `serverInstructions()` (`tools.ts` ~28); point 6 is the "check
  looks wrong" point, `pipeline_propose_change` is mentioned in points 6 and 8. The existing test
  `the instructions the server gives on connecting name only tools that exist` (`service.test.ts` ~680)
  must keep passing.
- The tool-surface snapshot tests are in `packages/pipeline-core/test/service.test.ts` (~659 `CONTRACT_VERSION`
  is `1`; ~707 `pipeline_feedback` argument list). `docs.test.ts` and the `pipeline_docs` index echo
  `contract_version`.
- Scripted engines in `packages/testkit` (`memory-engine.ts` ~115, `local-engine.ts` ~120) implement
  `pipeline_feedback` themselves and drop unknown arguments; they need to pass `check` through.
- `report.ts` counts `feedback_reported` records only (`feedback += 1`); no change needed.
- Stored data: `check` is a new **optional** field on `feedback_reported`; nothing is renamed or
  retyped, `RECORD_VERSION` stays 1, no migration reader. Old journals have no field and must still
  open (golden fixtures in `fixtures/formats/v1` already cover `status` / `report`).

## Affected files

- `packages/pipeline-core/src/mcp/tools.ts`: `CONTRACT_VERSION = 2`; `check` in the `pipeline_feedback`
  shape and description; instruction sentences (points 6 and the propose-change point).
- `packages/pipeline-core/src/service.ts`: `feedback()` input type gains `check?: string` and passes it on.
- `packages/pipeline-core/src/run.ts`: `feedback` event gains `check?: string`; `apply` validates it and
  logs it.
- `packages/pipeline-core/src/next-step.ts`: wording of the retry text (only if the current text does not
  already tell the agent what to refer to; the `(<check_id>)` suffix stays).
- `packages/testkit/src/memory-engine.ts`, `packages/testkit/src/local-engine.ts`: pass `check`.
- Tests: `packages/pipeline-core/test/service.test.ts`, `next-step.test.ts`, a new
  `feedback-check.test.ts` (unit), `packages/local/test/mcp.test.ts` (integration),
  `tests/agents/` (real agent), `docs.test.ts` only if it pins the version.
- Docs: `pipeline_docs` text, if it describes `pipeline_feedback` arguments (grep first; nothing found
  under `docs/` besides plans).

## Steps

1. **Argument.** In `tools.ts` add to the `pipeline_feedback` shape
   `check: z.string().max(LIMITS.id).optional().describe(...)` (use the id limit already used for slugs;
   describe it as "the check_id of the check that fired for nothing, as the retry text or the journal
   names it; only with category wrong_check"). Add one sentence to the tool description. Bump
   `CONTRACT_VERSION` to 2.
2. **Service and event.** Thread `check` through `PipelineService.feedback` and the `feedback` event type.
3. **Validation in `Run.apply`** (fail closed, before anything is logged):
   - `check` without a node to resolve against (`event.node` absent and not exactly one active node):
     `INVALID_ARGUMENTS`, message says to pass `node_slug`.
   - the node is `event.node ?? only active`; `check` must equal (exact, case- and space-sensitive, no
     trimming) one of that node's `checkIdOf` ids; otherwise `INVALID_ARGUMENTS` whose `issues` list the
     valid ids (an empty list is stated as "this step has no checks"). This also covers an id of another
     node and an unknown node (already refused by `this.node`).
   - `check` with a category other than `wrong_check`: refuse with `INVALID_ARGUMENTS` (the id only
     has meaning there). Decided by the person. `category` itself stays as it is.
   - log `check` in `feedback_reported` only when given (optional field, like `withdrawn`), not `null`.
4. **Retry text.** No change: it already ends with `(<check_id>)`, and a failure without an id (run
   from before HP9R) keeps today's text. Only a test that the id is in it is added.
5. **Instructions** (`serverInstructions`): extend point 6 with: if a check failed and you think it
   fired for nothing, or the person says so, offer to record it with `pipeline_feedback`
   (`category: wrong_check`, `check`: the check_id from the retry text), and record it only after they
   agree. In the `pipeline_propose_change` point (8): the summary names the check_id and what should get
   better. Keep numbering and the wait/dialog variants intact.
6. **Testkit engines** pass `check` and map the refusal.
7. **Tests** (below). Update the snapshot test once: `CONTRACT_VERSION` 2 and the `pipeline_feedback`
   argument list with `check`.
8. Run `bun run typecheck`, `bun run lint`, `bun test`, `bun run build && node scripts/check-artifact.mjs`.

## Decisions taken by the person

- A `check` with a category other than `wrong_check` is refused with `INVALID_ARGUMENTS`.
- Without `node_slug`, the only active node is used; with none or several active, the call is refused.
- The retry text stays as it is (`... (<check_id>)`); step 4 changes nothing and the hp9r asserts stay.
- The instability of `check_id` when an earlier check of the same kind is removed is not solved here.
- The real-agent test is written and run in this task.

## Test strategy (names carry `bmbd_`)

- **Unit** (`pipeline-core/test`): `bmbd_schema_accepts_and_rejects_check` (absent, valid string,
  non-string, too long); `bmbd_unknown_node_is_refused`; `bmbd_unknown_id_lists_valid_ids`;
  `bmbd_id_of_another_node_is_refused`; `bmbd_feedback_reported_has_check`;
  `bmbd_feedback_without_check_has_no_field`; `bmbd_check_does_not_change_verdict_or_run` (status,
  attempt, lastFailure and next step identical before and after); `bmbd_reentry_feedback_contains_the_id`
  and `..._without_id_reads_as_before`; `bmbd_contract_version_is_2`.
- **Instructions test**: the existing "names only tools that exist" test stays; new asserts for the
  wrong_check sentence (offer first, record after agreement, `check_id`) and the summary sentence.
- **Integration** (`local/test/mcp.test.ts`): a real run over MCP, call with and without `check`;
  journal on disk has/has not the field; refusal for an id of another node.
- **Real agent** (`tests/agents`, new `claude-code-wrong-check.test.ts` modelled on the existing ones): a
  check fails; the agent offers the person to record `wrong_check` and calls `pipeline_feedback` with the
  id only after the person agrees; no `feedback_reported` is in the journal before.
- **Corner cases:** check for a node that is not running; repeated feedback (the journal limit/dedupe
  that applies to feedback today is kept as is, not redefined here); a very long `message` / `check`;
  control characters and fake terminal lines in `message` or `check` (must not reach the journal or a
  terminal line unescaped; the id check refuses them before logging, and `message` goes through the
  existing redaction path); an id in another case or with spaces; feedback on a finished run; a run
  written before `check_id` existed (golden fixture v1 still opens, `status` and `report` work).
- Windows/macOS/Linux: no test depends on path separators or line endings.

## Risks

- **Contract bump touches other tasks in flight.** Tasks 11+ (`task`, `executor`) assume the bump is
  done; merge order matters. Only `CONTRACT_VERSION` and the snapshot are shared, so conflicts are small.
- **Refusing `check` with a non-`wrong_check` category** is a choice not stated in the task; if the
  person prefers to accept it, step 3 loses one branch and one test.
- **Id stability.** `check_id` shifts when a same-kind check before it is removed (HP9R test). A note
  recorded against an old id may point at another check after a pipeline change; the record also keeps
  `spec` (the pipeline hash), which is the way to resolve it later. Not solved here.
- **Prompt-injection surface.** The id is quoted back by the agent from the retry text; validation by
  exact match against the node's real ids means a hostile string never reaches the journal.
- **Real-agent test is flaky by nature**; it asserts the order of events (offer, agreement, call) and not
  the wording.
- **Exact-string asserts** on the retry text (hp9r tests) must be updated together with any wording change
  in step 4.
