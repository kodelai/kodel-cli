/** Sample runs for the Report screen of `kodel tui --demo`: numbers made up, in the shape of real ones. */
import {
  type AttemptReport,
  type NodeForms,
  type NodeReport,
  type StatsRun,
  summarizePipeline,
} from "@kodel-ai/pipeline-core";
import { definitionKey } from "./definition-text";
import type { StatsData } from "./stats-load";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** A small deterministic generator, so the sample is the same every time. */
function generator(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const def = (work: string): NodeForms => ({ work, checks: "c1", routing: "r1" });
const OLD_IMPL = def("impl-1");
const NOW_IMPL = def("impl-2");
const CURRENT: Record<string, NodeForms> = {
  plan: def("p1"),
  "plan-approval": def("pa1"),
  impl: NOW_IMPL,
  verify: def("v1"),
  test: def("t1"),
  "final-approval": def("fa1"),
  publish: def("pub1"),
};
const ORDER = Object.keys(CURRENT);

const REJECTIONS = [
  "The plan does not say how the old runs are read.",
  "Fix the minor review findings, add a test for the docs pipeline.",
  "Split it: the format change is a separate pull request.",
  "",
];

function attempts(
  count: number,
  rand: () => number,
  base: Partial<AttemptReport>,
  seconds: number,
  failure?: { chance: number; source: string; reasons: string[]; outcome: string },
): AttemptReport[] {
  return Array.from({ length: count }, (_, i) => {
    const last = i === count - 1;
    const wobble = 0.6 + rand() * 0.8;
    const found: AttemptReport = {
      attempt: i + 1,
      seconds: Math.round(seconds * wobble),
      outcome: "passed",
      ...base,
    };
    if (failure && !last) {
      found.outcome = failure.outcome;
      found.failure = {
        source: failure.source,
        reason: failure.reasons[Math.floor(rand() * failure.reasons.length)] ?? "failed",
      };
    }
    return found;
  });
}

function devRuns(): StatsRun[] {
  const rand = generator(7);
  const runs: StatsRun[] = [];
  const total = 14;
  for (let i = 0; i < total; i++) {
    const newer = i >= 7;
    const recent = i >= total - 3;
    const implTries = newer ? 1 + Math.floor(rand() * 2) : 2 + Math.floor(rand() * 3);
    const usage = (usd: number) =>
      recent
        ? {
            usage: {
              input: 300,
              output: 9000,
              cache_read: 400_000,
              cache_write: 30_000,
              calls: 12,
              usd: usd * (0.7 + rand() * 0.6),
            },
          }
        : {};
    const rejected = rand() < 0.35;
    const nodes: NodeReport[] = [
      {
        node: "plan",
        gate: false,
        attempts: attempts(
          1 + Math.floor(rand() * 2),
          rand,
          { definition: CURRENT.plan, ...usage(0.9) },
          340,
          {
            chance: 1,
            source: "check:diff",
            reasons: ["the plan file did not change"],
            outcome: "failed",
          },
        ),
        seconds: 0,
      },
      {
        node: "plan-approval",
        gate: true,
        attempts: [
          ...(rejected
            ? [
                {
                  attempt: 1,
                  seconds: 5400,
                  outcome: "rejected",
                  definition: CURRENT["plan-approval"],
                  failure: { source: "human", reason: REJECTIONS[i % 4] ?? "" },
                  decision: {
                    outcome: "rejected",
                    ...(REJECTIONS[i % 4] ? { reason: REJECTIONS[i % 4] } : {}),
                  },
                } as AttemptReport,
              ]
            : []),
          {
            attempt: rejected ? 2 : 1,
            seconds: 1800 + Math.round(rand() * 3000),
            outcome: "approved",
            definition: CURRENT["plan-approval"],
            decision: { outcome: "approved" },
          },
        ],
        seconds: 0,
      },
      {
        node: "impl",
        gate: false,
        attempts: attempts(
          implTries,
          rand,
          { definition: newer ? NOW_IMPL : OLD_IMPL, ...usage(4.2) },
          newer ? 420 : 640,
          {
            chance: 1,
            source: "check:result",
            reasons: ["1 blocking finding in the review", "typecheck failed"],
            outcome: "blocking_findings",
          },
        ),
        seconds: 0,
      },
      {
        node: "verify",
        gate: false,
        attempts: attempts(1 + (newer ? 0 : 1), rand, { definition: CURRENT.verify }, 3, {
          chance: 1,
          source: "command",
          reasons: ["typecheck failed"],
          outcome: "failed",
        }),
        seconds: 0,
      },
      {
        node: "test",
        gate: false,
        attempts: attempts(1, rand, { definition: CURRENT.test }, 170),
        seconds: 0,
      },
      {
        node: "final-approval",
        gate: true,
        attempts: [
          {
            attempt: 1,
            seconds: 900 + Math.round(rand() * 20_000),
            outcome: "approved",
            definition: CURRENT["final-approval"],
            decision: { outcome: "approved" },
          },
        ],
        seconds: 0,
      },
      {
        node: "publish",
        gate: false,
        attempts: attempts(1, rand, { definition: CURRENT.publish }, 35),
        seconds: 0,
      },
    ];
    for (const n of nodes) n.seconds = n.attempts.reduce((s, a) => s + a.seconds, 0);
    const work = nodes.filter((n) => !n.gate).reduce((s, n) => s + n.seconds, 0);
    const waiting = nodes.filter((n) => n.gate).reduce((s, n) => s + n.seconds, 0);
    runs.push({
      runId: `r_demo${i}`,
      at: Date.now() - (total - i) * 2 * DAY,
      report: {
        runId: `r_demo${i}`,
        task: `task ${i}`,
        slug: `task-${i}`,
        status: i === total - 1 ? "running" : "completed",
        total_s: work + waiting,
        work_s: work,
        waiting_s: waiting,
        nodes,
        restarts: 0,
        pauses: 0,
        feedback: 0,
        refused: 0,
        refusals: [],
        extra_attempts: 0,
        pipeline_changes: [],
        agent_decisions: [],
        checks: [],
        prompts: { not_collected: true },
      },
    });
  }
  return runs;
}

export function demoStats(pipeline: string): StatsData {
  const runs = pipeline === "dev" ? devRuns() : [];
  const options = { current: CURRENT, order: ORDER };
  return {
    pipeline,
    loadedAt: Date.now(),
    runs: runs.length,
    unreadable: 0,
    definitionsKnown: true,
    current: summarizePipeline(runs, { scope: "current", ...options }),
    all: summarizePipeline(runs, { scope: "all", ...options }),
    definitions: pipeline === "dev" ? DEFINITIONS : {},
  };
}

const IMPL_BEFORE = [
  "kind: agent",
  "attempts: 10, 3 failures in a row",
  "on_fail: failed",
  "prompt:",
  "  Implement the approved plan.",
  "  Keep the change small.",
  "check: diff",
  '  paths: ["packages/"]',
  "→ verify",
  "→ plan  when blocking_findings",
];

const IMPL_NOW = [
  "kind: agent",
  "attempts: 10, 3 failures in a row",
  "on_fail: failed",
  "prompt:",
  "  Implement the approved plan.",
  "  Keep the change small.",
  "  Do not run the whole suite: run the tests of what you changed.",
  "check: diff",
  '  paths: ["packages/"]',
  "→ verify",
  "→ plan  when blocking_findings",
];

const DEFINITIONS: Record<string, string[]> = {
  [definitionKey("impl", OLD_IMPL)]: IMPL_BEFORE,
  [definitionKey("impl", NOW_IMPL)]: IMPL_NOW,
};
