/**
 * Conformance scenarios for the reference pipeline (`examples/pipelines/feature.yaml`).
 * They describe how any correct engine must behave on it, and run against every engine
 * (core with in-memory adapters, local adapters, the server) once that engine exists.
 */
import {
  defineScenario,
  expectError,
  expectOk,
  humanApprove,
  humanReject,
  inj,
  interrupt,
  matcher,
  resume,
} from "../dsl";
import type { Production, ResultReport, Scenario } from "../types";

const PIPELINE = { file: "examples/pipelines/feature.yaml" };
const TASK = "add login rate limit"; // slug: add_login_rate_limit

const PLAN_FILE = "docs/plans/add_login_rate_limit.md";
const planOk: Production = { changes: { [PLAN_FILE]: 24 } };
const implOk: Production = {
  changes: { "packages/pipeline-core/src/limit.ts": 40, "tests/limit.test.ts": 20 },
};
const docsOk: Production = { changes: { "docs/limits.md": 10 } };

const cleanReport: ResultReport = { completeness: "complete", rows: [] };
const cleanReview: Production = { result: cleanReport };
const blockingReview: Production = {
  result: {
    completeness: "complete",
    rows: [{ severity: "major", location: "limit.ts:1", description: "No upper bound" }],
  },
};

const HAPPY_TRAIL = [
  "plan",
  "plan-approval",
  "impl",
  "build",
  "test",
  "review",
  "e2e",
  "manual-test",
  "docs",
];

const base = (id: string) => defineScenario(id).pipeline(PIPELINE).task(TASK);

/** Inputs that make every node succeed on its first attempt. */
const quiet = () => [
  inj("plan", { 1: planOk }),
  inj("impl", { 1: implOk }),
  inj("review", { 1: cleanReview }),
  inj("docs", { 1: docsOk }),
];

/** The same production for attempts 1..n. */
const upTo = (n: number, production: Production): Record<number, Production> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, production]));

/**
 * Human rejections are not failures, so they never trip max_consecutive_failures; the total
 * limit (max_attempts, 10) is what stops an endless back and forth.
 */
function endlessRejections(): Scenario {
  const scenario = base("feature/endless-rejections-hit-the-total-limit")
    .describe(
      "a human rejecting the same work again and again exhausts max_attempts: the run pauses",
    )
    .inject(
      inj("plan", { 1: planOk }),
      inj("impl", upTo(10, implOk)),
      inj("review", upTo(10, cleanReview)),
      inj("docs", { 1: docsOk }),
    )
    .on(humanApprove("plan-approval"));
  for (let round = 1; round <= 10; round++) {
    scenario.on(humanReject("manual-test", `round ${round}`));
  }
  return scenario
    .expect([
      matcher("runStatus", "paused"),
      matcher("attempts", { impl: 10, "manual-test": 10 }),
      matcher("journalHas", "run_paused"),
      matcher("never", ["docs"]),
    ])
    .build();
}

export const featureScenarios: Scenario[] = [
  base("feature/happy-path")
    .describe("everything passes on the first attempt; both human gates approve")
    .inject(...quiet())
    .on(humanApprove("plan-approval"))
    .on(humanApprove("manual-test"))
    .expect([
      matcher("runStatus", "completed"),
      matcher("trail", HAPPY_TRAIL),
      matcher("attempts", { plan: 1, impl: 1, build: 1, test: 1, review: 1, docs: 1 }),
      matcher("journalHas", ["run_started", "run_finished"]),
    ])
    .build(),

  base("feature/test-fails-then-passes")
    .describe("a red test sends the run back to impl; the second round is green")
    .inject(
      inj("plan", { 1: planOk }),
      inj("impl", { 1: implOk, 2: implOk }),
      inj("test", { 1: { exit: 1 } }),
      inj("review", { 1: cleanReview }),
      inj("docs", { 1: docsOk }),
    )
    .on(humanApprove("plan-approval"))
    .on(humanApprove("manual-test"))
    .expect([
      matcher("runStatus", "completed"),
      matcher("attempts", { impl: 2, build: 2, test: 2, review: 1 }),
      matcher("trail", [
        "plan",
        "plan-approval",
        "impl",
        "build",
        "test",
        "impl",
        "build",
        "test",
        "review",
        "e2e",
        "manual-test",
        "docs",
      ]),
    ])
    .build(),

  base("feature/build-exhausts-attempts")
    .describe(
      "build fails three times in a row (max_consecutive_failures); the run pauses and waits for a human",
    )
    .inject(
      inj("plan", { 1: planOk }),
      inj("impl", { 1: implOk, 2: implOk, 3: implOk }),
      inj("build", { 1: { exit: 1 }, 2: { exit: 1 }, 3: { exit: 1 } }),
    )
    .on(humanApprove("plan-approval"))
    .expect([
      matcher("runStatus", "paused"),
      matcher("attempts", { impl: 3, build: 3 }),
      matcher("never", ["test", "review", "e2e", "manual-test", "docs"]),
      matcher("journalHas", "run_paused"),
    ])
    .build(),

  base("feature/review-blocking-then-fixed")
    .describe("a blocking finding fails the result check and routes back to impl")
    .inject(
      inj("plan", { 1: planOk }),
      inj("impl", { 1: implOk, 2: implOk }),
      inj("review", { 1: blockingReview, 2: cleanReview }),
      inj("docs", { 1: docsOk }),
    )
    .on(humanApprove("plan-approval"))
    .on(humanApprove("manual-test"))
    .expect([
      matcher("runStatus", "completed"),
      matcher("attempts", { impl: 2, review: 2 }),
      matcher("trail", [
        "plan",
        "plan-approval",
        "impl",
        "build",
        "test",
        "review",
        "impl",
        "build",
        "test",
        "review",
        "e2e",
        "manual-test",
        "docs",
      ]),
    ])
    .build(),

  base("feature/plan-rejected-returns-to-plan")
    .describe("a rejected plan is written again before implementation starts")
    .inject(
      inj("plan", { 1: planOk, 2: planOk }),
      inj("impl", { 1: implOk }),
      inj("review", { 1: cleanReview }),
      inj("docs", { 1: docsOk }),
    )
    .on(humanReject("plan-approval", "too vague"))
    .on(humanApprove("plan-approval"))
    .on(humanApprove("manual-test"))
    .expect([
      matcher("runStatus", "completed"),
      matcher("attempts", { plan: 2, "plan-approval": 2 }),
      matcher("trail", ["plan", "plan-approval", "plan", "plan-approval", ...HAPPY_TRAIL.slice(2)]),
    ])
    .build(),

  base("feature/manual-test-rejected-new-iteration")
    .describe(
      "after a human rejection the diff baseline is the new visit: an impl that changes nothing " +
        "fails its check even though earlier work exists",
    )
    .inject(
      inj("plan", { 1: planOk }),
      inj("impl", { 1: implOk, 2: {}, 3: implOk }),
      inj("review", { 1: cleanReview }),
      inj("docs", { 1: docsOk }),
    )
    .on(humanApprove("plan-approval"))
    .on(humanReject("manual-test", "the button does nothing"))
    .expect([
      matcher("waitingGate", "manual-test"),
      matcher("attempts", { impl: 3, build: 2, "manual-test": 2 }),
    ])
    .on(humanApprove("manual-test"))
    .expect([matcher("runStatus", "completed")])
    .build(),

  base("feature/plan-touches-other-files")
    .describe("changed_only fails when the plan step also edits code; the node is written again")
    .inject(
      inj("plan", {
        1: { changes: { [PLAN_FILE]: 24, "packages/oops.ts": 3 } },
        2: planOk,
      }),
      inj("impl", { 1: implOk }),
      inj("review", { 1: cleanReview }),
      inj("docs", { 1: docsOk }),
    )
    .on(humanApprove("plan-approval"))
    .on(humanApprove("manual-test"))
    .expect([
      matcher("runStatus", "completed"),
      matcher("attempts", { plan: 2 }),
      matcher("trail", HAPPY_TRAIL),
    ])
    .build(),

  base("feature/resume-grants-a-fresh-failure-count")
    .describe(
      "after the pause a human resumes: the blocked route is taken and the count starts over",
    )
    .inject(
      inj("plan", { 1: planOk }),
      inj("impl", upTo(4, implOk)),
      inj("build", { 1: { exit: 1 }, 2: { exit: 1 }, 3: { exit: 1 } }),
      inj("review", { 1: cleanReview }),
      inj("docs", { 1: docsOk }),
    )
    .on(humanApprove("plan-approval"))
    .expect([matcher("runStatus", "paused"), matcher("attempts", { impl: 3, build: 3 })])
    .on(resume())
    .expect([
      matcher("runStatus", "running"),
      matcher("waitingGate", "manual-test"),
      matcher("attempts", { impl: 4, build: 4 }),
      matcher("journalHas", ["run_paused", "run_resumed"]),
    ])
    .build(),

  endlessRejections(),

  base("feature/interrupted-build-restarts")
    .describe("the process dies while build runs; the next step restarts it without a new attempt")
    .inject(
      inj("plan", { 1: planOk }),
      inj("impl", { 1: implOk }),
      inj("build", { 1: { hangs: true } }),
      inj("review", { 1: cleanReview }),
    )
    .on(humanApprove("plan-approval"))
    .expect([matcher("runStatus", "running"), matcher("nodeStatus", { build: "running" })])
    .on(interrupt())
    .expect([
      matcher("journalHas", "node_restarted"),
      matcher("attempts", { build: 1 }),
      matcher("waitingGate", "manual-test"),
    ])
    .build(),

  // ── the agent protocol: an agent that does not behave ──────────────────────

  base("feature/agent-claims-done-with-a-red-check")
    .describe("impl changed nothing but the agent says it is done: the node does not advance")
    .agent("manual")
    .inject(inj("plan", { 1: planOk }), inj("impl", { 1: {} }))
    .call(
      "pipeline_complete_step",
      { run_id: "$run", node_slug: "plan", attempt: 1, summary: "planned" },
      expectOk({ advanced: true }),
    )
    .on(humanApprove("plan-approval"))
    .call(
      "pipeline_complete_step",
      { run_id: "$run", node_slug: "impl", attempt: 1, summary: "done" },
      expectOk({ advanced: false, outcome: "failed" }),
    )
    .expect([matcher("nodeStatus", { impl: "rework" }), matcher("attempts", { impl: 2 })])
    .build(),

  base("feature/stale-attempt-is-rejected")
    .describe("completing a node with the wrong attempt number is an error and changes nothing")
    .agent("manual")
    .inject(inj("plan", { 1: planOk }))
    .call(
      "pipeline_complete_step",
      { run_id: "$run", node_slug: "plan", attempt: 5, summary: "done" },
      expectError("ATTEMPT_MISMATCH"),
    )
    .expect([matcher("nodeStatus", { plan: "running" }), matcher("attempts", { plan: 1 })])
    .build(),

  base("feature/completing-an-unreached-node-is-rejected")
    .describe("the agent cannot skip ahead: a node the run has not reached is not running")
    .agent("manual")
    .inject(inj("plan", { 1: planOk }))
    .call(
      "pipeline_complete_step",
      { run_id: "$run", node_slug: "build", attempt: 1, summary: "built" },
      expectError("NODE_NOT_RUNNING"),
    )
    .expect([matcher("never", ["build"]), matcher("trail", ["plan"])])
    .build(),

  base("feature/feedback-for-an-unknown-node-is-rejected")
    .describe("pipeline_feedback names a node that does not exist")
    .agent("manual")
    .inject(inj("plan", { 1: planOk }))
    .call(
      "pipeline_feedback",
      { run_id: "$run", node_slug: "ghost", category: "other", message: "the prompt is unclear" },
      expectError("UNKNOWN_NODE"),
    )
    .expect([matcher("runStatus", "running"), matcher("journalLacks", "feedback_reported")])
    .build(),
];
