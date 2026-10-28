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
  rec("agent_completed", 79, {
    node: "plan",
    attempt: 1,
    outcome: "passed",
    summary: "Wrote the plan.",
  }),
  rec("check_finished", 79, {
    node: "plan",
    attempt: 1,
    kind: "diff",
    passed: true,
    duration_ms: 150,
  }),
  rec("node_finished", 79, { node: "plan", attempt: 1, outcome: "passed", status: "passed" }),
  rec("node_entered", 70, { node: "plan-approval", attempt: 1 }),
  rec("gate_decided", 60, { node: "plan-approval", decision: "approved", reason: null }),
  rec("node_finished", 60, {
    node: "plan-approval",
    attempt: 1,
    outcome: "approved",
    status: "passed",
  }),
  rec("node_entered", 59, { node: "impl", attempt: 1 }),
  rec("check_finished", 50, {
    node: "impl",
    attempt: 1,
    kind: "diff",
    passed: false,
    duration_ms: 90,
    reason: "too many lines",
  }),
  rec("node_finished", 50, { node: "impl", attempt: 1, outcome: "failed", status: "failed" }),
  rec("node_entered", 49, { node: "impl", attempt: 2 }),
  rec("check_finished", 45, {
    node: "impl",
    attempt: 2,
    kind: "diff",
    passed: true,
    duration_ms: 160,
  }),
  rec("node_finished", 45, { node: "impl", attempt: 2, outcome: "passed", status: "passed" }),
  rec("node_entered", 44, { node: "test", attempt: 1 }),
  rec("command_finished", 43, {
    node: "test",
    attempt: 1,
    passed: false,
    exit: 1,
    duration_ms: 70_000,
    reason: "1 test failed",
  }),
  rec("node_finished", 43, { node: "test", attempt: 1, outcome: "failed", status: "failed" }),
  rec("node_entered", 42, { node: "test", attempt: 2 }),
  rec("command_finished", 40, {
    node: "test",
    attempt: 2,
    passed: true,
    exit: 0,
    duration_ms: 85_000,
  }),
  rec("node_finished", 40, { node: "test", attempt: 2, outcome: "passed", status: "passed" }),
  rec("node_entered", 39, { node: "review", attempt: 1 }),
  rec("report_accepted", 38, { node: "review", attempt: 1, completeness: "complete", rows: 2 }),
  rec("check_finished", 38, {
    node: "review",
    attempt: 1,
    kind: "result",
    passed: true,
    duration_ms: 60,
  }),
  rec("node_finished", 38, { node: "review", attempt: 1, outcome: "passed", status: "passed" }),
  rec("node_entered", 37, { node: "final-approval", attempt: 1 }),
  rec("gate_waiting", 37, { node: "final-approval", attempt: 1 }),
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

const load = (fake?: Fake) => loadGateDetail(source(fake), "r_1", NOW);

describe("tui gate detail", () => {
  test("the question is the node's own text; this is the second gate on the way", async () => {
    const d = await load();
    expect(d?.node).toBe("final-approval");
    expect(d?.prompt).toBe("Look at the diff.");
    expect(d?.instructions).toBe("Try the change.");
    expect(d?.position).toBe("gate 2 of 2");
  });

  test("the steps are what was walked, each once, then where the usual outcomes lead", async () => {
    const d = await load();
    expect(d?.steps.map((s) => s.slug)).toEqual([
      "plan",
      "plan-approval",
      "impl",
      "test",
      "review",
      "final-approval",
      "release",
    ]);
    expect(d?.steps.find((s) => s.slug === "final-approval")?.state).toBe("waiting");
    expect(d?.steps.find((s) => s.slug === "release")).toMatchObject({
      state: "pending",
      attempts: [],
    });
    expect(d?.steps.filter((s) => s.human).map((s) => s.slug)).toEqual([
      "plan-approval",
      "final-approval",
    ]);
    expect(d?.steps.find((s) => s.slug === "impl")?.kind).toBe("agent");
  });

  test("every try at a step is kept, with how it ended and for how long", async () => {
    const d = await load();
    const test = d?.steps.find((s) => s.slug === "test")?.attempts;
    expect(test?.map((a) => [a.n, a.outcome, a.ok, a.ms, a.exit])).toEqual([
      [1, "failed", false, MIN, 1],
      [2, "passed", true, 2 * MIN, 0],
    ]);
    expect(test?.[0]?.reason).toBe("1 test failed");
    const impl = d?.steps.find((s) => s.slug === "impl")?.attempts;
    expect(impl?.[0]).toMatchObject({ ok: false, reason: "too many lines" });
    expect(impl?.[1]).toMatchObject({ ok: true });
  });

  test("checks of the verdict are those of the latest try: a red first try does not count", async () => {
    const d = await load();
    expect(d?.checks.every((c) => c.passed)).toBe(true);
    expect(d?.checks.filter((c) => c.node === "test")).toEqual([
      { node: "test", label: "test", passed: true, ms: 85_000 },
    ]);
    expect(d?.checks.filter((c) => c.node === "impl")).toEqual([
      { node: "impl", label: "impl diff", passed: true, ms: 160 },
    ]);
  });

  test("a check that failed in the latest try is a failed check", async () => {
    const journal = JOURNAL.map((r) =>
      r.event === "command_finished" && r.attempt === 2
        ? ({ ...r, passed: false } as JournalRecord)
        : r,
    );
    const d = await load({ journal });
    expect(d?.checks.filter((c) => !c.passed).map((c) => c.node)).toEqual(["test"]);
  });

  test("what the agent said about a step is kept as its word, and only when it said something", async () => {
    const d = await load();
    expect(d?.steps.find((s) => s.slug === "plan")?.attempts[0]?.summary).toBe("Wrote the plan.");
    expect(d?.steps.find((s) => s.slug === "impl")?.attempts[0]?.summary).toBeUndefined();
  });

  test("a person's decisions sit on the try they were made at, with the reason", async () => {
    const journal = JOURNAL.map((r) =>
      r.event === "gate_decided"
        ? ({ ...r, decision: "rejected", reason: "no tests" } as JournalRecord)
        : r,
    );
    const d = await load({ journal });
    expect(d?.steps.find((s) => s.slug === "plan-approval")?.attempts[0]?.decision).toEqual({
      decision: "rejected",
      reason: "no tests",
    });
    const approved = await load();
    expect(approved?.steps.find((s) => s.slug === "plan-approval")?.attempts[0]?.decision).toEqual({
      decision: "approved",
    });
  });

  test("the findings of a review are on the try that made them", async () => {
    const d = await load({ reports: { "review:1": REVIEW } });
    expect(d?.steps.find((s) => s.slug === "review")?.attempts[0]?.review).toEqual({
      completeness: "complete",
      findings: [
        { severity: "minor", location: "a.ts:1", description: "small" },
        { severity: "info", location: "b.ts:2", description: "fyi" },
      ],
    });
    expect(d?.steps.find((s) => s.slug === "impl")?.attempts[0]?.review).toBeUndefined();
  });

  test("changes are counted by file and line, the biggest first", async () => {
    const d = await load();
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
    const d = await load({ after: { kind: "changes", files: { "late.ts": 3 } } });
    expect(d?.changedAfterChecks).toEqual(["late.ts"]);
  });

  test("when the engine cannot tell what changed, that is what is said", async () => {
    const d = await load({ since: { kind: "unavailable", reason: "git failed" } });
    expect(d?.changes).toEqual({ kind: "unavailable", reason: "git failed" });
    expect((await load({ since: { kind: "changes", files: {} } }))?.changes).toEqual({
      kind: "none",
    });
    expect((await load({ since: { kind: "no_repo" } }))?.changes).toEqual({ kind: "no_repo" });
  });

  test("the journal is all of it, oldest first", async () => {
    const d = await load();
    expect(d?.journal).toHaveLength(JOURNAL.length);
    expect(d?.journal[0]).toContain("node_entered");
    expect(d?.journal.at(-1)).toContain("gate_waiting");
  });

  test("a run that does not wait at a human step has no gate detail", async () => {
    const paused = {
      waiting: { reason: "paused", node_slug: "impl", prompt: "p", how_to_decide: { cli: "c" } },
    } as unknown as NextStep;
    expect(await load({ next: paused })).toBeUndefined();
    const working = { node: { slug: "impl" } } as unknown as NextStep;
    expect(await load({ next: working })).toBeUndefined();
    expect(await loadGateDetail({ open: async () => undefined }, "r_1", NOW)).toBeUndefined();
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
    const d = await loadGateDetail(broken, "r_1", NOW);
    expect(d?.changes).toEqual({ kind: "unavailable", reason: "no git" });
    expect(d?.prompt).toBe("Look at the diff.");
  });
});
