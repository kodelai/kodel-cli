import { describe, expect, test } from "bun:test";
import type {
  JournalRecord,
  NextStep,
  PipelineSpec,
  ResultReport,
  RunState,
} from "@kodel-ai/pipeline-core";
import { type GateRun, loadGateDetail } from "../src/tui/gate";

const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
const MIN = 60_000;

const SPEC = {
  version: "1",
  name: "dev",
  entry: "plan",
  nodes: [
    { slug: "plan", kind: "agent" },
    { slug: "plan-approval", kind: "human" },
    { slug: "impl", kind: "agent" },
    { slug: "test", kind: "command" },
    { slug: "review", kind: "agent" },
    { slug: "final-approval", kind: "human" },
    { slug: "release", kind: "command" },
  ],
  edges: [
    { from: "plan", to: "plan-approval", when: "passed" },
    { from: "plan-approval", to: "impl", when: "approved" },
    { from: "plan-approval", to: "plan", when: "rejected" },
    { from: "impl", to: "test", when: "passed" },
    { from: "test", to: "review", when: "passed" },
    { from: "test", to: "impl", when: "failed" },
    { from: "review", to: "final-approval", when: "passed" },
    { from: "final-approval", to: "release", when: "approved" },
    { from: "final-approval", to: "impl", when: "rejected" },
  ],
} as unknown as PipelineSpec;

const node = (slug: string, status: string, attempt = 1) => ({
  slug,
  status,
  outcome: null,
  attempt,
});

function state(over: Partial<RunState> = {}): RunState {
  return {
    v: 1,
    runId: "r_1",
    status: "running",
    startedAt: NOW - 90 * MIN,
    trail: ["plan", "plan-approval", "impl", "test", "impl", "test", "review", "final-approval"],
    nodes: {
      plan: node("plan", "passed"),
      "plan-approval": node("plan-approval", "passed"),
      impl: node("impl", "passed", 2),
      test: node("test", "passed", 2),
      review: node("review", "passed"),
      "final-approval": node("final-approval", "waiting"),
    },
    active: [{ node: "final-approval", attempt: 1, visitId: 8, phase: "human", checkIndex: 0 }],
    ...over,
  } as unknown as RunState;
}

const rec = (event: string, minutesAgo: number, rest: Record<string, unknown> = {}) =>
  ({ v: 1, seq: 1, ts: NOW - minutesAgo * MIN, event, ...rest }) as JournalRecord;

const JOURNAL: JournalRecord[] = [
  rec("node_entered", 80, { node: "plan", attempt: 1 }),
  rec("check_finished", 79, {
    node: "plan",
    attempt: 1,
    kind: "diff",
    passed: true,
    duration_ms: 150,
  }),
  rec("node_entered", 70, { node: "plan-approval", attempt: 1 }),
  rec("gate_decided", 60, { node: "plan-approval", decision: "approved", reason: null }),
  rec("node_entered", 59, { node: "impl", attempt: 1 }),
  rec("node_entered", 40, { node: "test", attempt: 1 }),
  rec("command_finished", 39, {
    node: "test",
    attempt: 1,
    passed: false,
    exit: 1,
    duration_ms: 70_000,
  }),
  rec("node_entered", 38, { node: "impl", attempt: 2 }),
  rec("check_finished", 30, {
    node: "impl",
    attempt: 2,
    kind: "diff",
    passed: true,
    duration_ms: 160,
  }),
  rec("node_entered", 29, { node: "test", attempt: 2 }),
  rec("command_finished", 27, {
    node: "test",
    attempt: 2,
    passed: true,
    exit: 0,
    duration_ms: 85_000,
  }),
  rec("node_entered", 26, { node: "review", attempt: 1 }),
  rec("report_accepted", 25, { node: "review", attempt: 1, completeness: "complete", rows: 2 }),
  rec("check_finished", 25, {
    node: "review",
    attempt: 1,
    kind: "result",
    passed: true,
    duration_ms: 60,
  }),
  rec("node_entered", 24, { node: "final-approval", attempt: 1 }),
  rec("gate_waiting", 24, { node: "final-approval", attempt: 1 }),
];

const gateNext = {
  waiting: {
    reason: "gate",
    node_slug: "final-approval",
    prompt: "Look at the diff.",
    instructions: "Try the change.",
    how_to_decide: { cli: "kodel gate approve|reject r_1" },
  },
} as unknown as NextStep;

interface Fake {
  state?: RunState;
  next?: NextStep;
  journal?: JournalRecord[];
  since?: Awaited<ReturnType<GateRun["changesSinceStart"]>>;
  after?: Awaited<ReturnType<GateRun["changesSinceGate"]>>;
  reports?: Record<string, ResultReport>;
}

const source = (fake: Fake = {}) => ({
  open: async (): Promise<GateRun> => ({
    state: async () => fake.state ?? state(),
    currentSpec: async () => SPEC,
    inspect: async () => fake.next ?? gateNext,
    journal: async () => fake.journal ?? JOURNAL,
    changesSinceStart: async () =>
      fake.since ?? { kind: "changes", files: { "a.ts": 5, "b.ts": 30 } },
    changesSinceGate: async () => fake.after ?? { kind: "changes", files: {} },
    resultsOf: async (n, a) => fake.reports?.[`${n}:${a}`],
  }),
});

const REVIEW: ResultReport = {
  completeness: "complete",
  rows: [
    { severity: "minor", location: "a.ts:1", description: "small" },
    { severity: "info", location: "b.ts:2", description: "fyi" },
  ],
};

describe("tui gate detail", () => {
  test("the question is the node's own text; this is the second gate on the way", async () => {
    const d = await loadGateDetail(source(), "r_1");
    expect(d?.node).toBe("final-approval");
    expect(d?.prompt).toBe("Look at the diff.");
    expect(d?.instructions).toBe("Try the change.");
    expect(d?.position).toBe("gate 2 of 2");
  });

  test("the way is what was walked, each step once with its repeats, then where the usual outcomes lead", async () => {
    const d = await loadGateDetail(source(), "r_1");
    expect(d?.path.map((p) => p.slug)).toEqual([
      "plan",
      "plan-approval",
      "impl",
      "test",
      "review",
      "final-approval",
      "release",
    ]);
    expect(d?.path.find((p) => p.slug === "impl")?.note).toBe("×2");
    expect(d?.path.find((p) => p.slug === "final-approval")?.state).toBe("waiting");
    expect(d?.path.find((p) => p.slug === "release")?.state).toBe("pending");
    expect(d?.path.filter((p) => p.human).map((p) => p.slug)).toEqual([
      "plan-approval",
      "final-approval",
    ]);
  });

  test("checks are those of the latest attempt of each step: the red first try of test is not shown", async () => {
    const d = await loadGateDetail(source(), "r_1");
    const test = d?.checks.filter((c) => c.node === "test");
    expect(test).toEqual([{ node: "test", label: "test", passed: true, ms: 85_000 }]);
    expect(d?.checks.find((c) => c.node === "plan")).toMatchObject({
      label: "plan diff",
      passed: true,
    });
    expect(d?.checks.every((c) => c.passed)).toBe(true);
  });

  test("a check that failed in the latest attempt is shown as failed", async () => {
    const journal = JOURNAL.map((r) =>
      r.event === "command_finished" && r.attempt === 2
        ? ({ ...r, passed: false } as JournalRecord)
        : r,
    );
    const d = await loadGateDetail(source({ journal }), "r_1");
    expect(d?.checks.filter((c) => !c.passed).map((c) => c.node)).toEqual(["test"]);
  });

  test("the findings are those of the last report accepted before the gate", async () => {
    const d = await loadGateDetail(source({ reports: { "review:1": REVIEW } }), "r_1");
    expect(d?.review?.node).toBe("review");
    expect(d?.review?.findings).toEqual([
      { severity: "minor", location: "a.ts:1", description: "small" },
      { severity: "info", location: "b.ts:2", description: "fyi" },
    ]);
  });

  test("changes are counted by file and line, the biggest first", async () => {
    const d = await loadGateDetail(source(), "r_1");
    expect(d?.changes).toEqual({
      kind: "files",
      files: [
        ["b.ts", 30],
        ["a.ts", 5],
      ],
      totalFiles: 2,
      totalLines: 35,
    });
    expect(d?.changedAfterChecks).toEqual([]);
  });

  test("files that changed after the checks are named", async () => {
    const d = await loadGateDetail(
      source({ after: { kind: "changes", files: { "late.ts": 3 } } }),
      "r_1",
    );
    expect(d?.changedAfterChecks).toEqual(["late.ts"]);
  });

  test("when the engine cannot tell what changed, that is what is said", async () => {
    const d = await loadGateDetail(
      source({ since: { kind: "unavailable", reason: "git failed" } }),
      "r_1",
    );
    expect(d?.changes).toEqual({ kind: "unavailable", reason: "git failed" });
    const none = await loadGateDetail(source({ since: { kind: "changes", files: {} } }), "r_1");
    expect(none?.changes).toEqual({ kind: "none" });
    const norepo = await loadGateDetail(source({ since: { kind: "no_repo" } }), "r_1");
    expect(norepo?.changes).toEqual({ kind: "no_repo" });
  });

  test("earlier decisions come with their reasons", async () => {
    const journal = [
      ...JOURNAL,
      rec("gate_decided", 100, {
        node: "plan-approval",
        decision: "rejected",
        reason: "no tests in the plan",
      }),
    ];
    const d = await loadGateDetail(source({ journal }), "r_1");
    expect(d?.decisions.map((x) => [x.node, x.decision, x.reason])).toEqual([
      ["plan-approval", "approved", undefined],
      ["plan-approval", "rejected", "no tests in the plan"],
    ]);
  });

  test("a run that does not wait at a human step has no gate detail", async () => {
    const paused = {
      waiting: { reason: "paused", node_slug: "impl", prompt: "p", how_to_decide: { cli: "c" } },
    } as unknown as NextStep;
    expect(await loadGateDetail(source({ next: paused }), "r_1")).toBeUndefined();
    const working = { node: { slug: "impl" } } as unknown as NextStep;
    expect(await loadGateDetail(source({ next: working }), "r_1")).toBeUndefined();
    expect(await loadGateDetail({ open: async () => undefined }, "r_1")).toBeUndefined();
  });

  test("one failing read does not take the whole detail down", async () => {
    const run = await source().open();
    const broken = {
      open: async (): Promise<GateRun> => ({
        ...run,
        changesSinceStart: async () => {
          throw new Error("no git");
        },
      }),
    };
    const d = await loadGateDetail(broken, "r_1");
    expect(d?.changes).toEqual({ kind: "unavailable", reason: "no git" });
    expect(d?.prompt).toBe("Look at the diff.");
  });
});
