import { describe, expect, test } from "bun:test";
import type {
  JournalRecord,
  NextStep,
  PipelineSpec,
  ResultReport,
  RunState,
} from "@kodel-ai/pipeline-core";
import { addComment, type GateRun, loadDiff, loadGateDetail, removeComment } from "../src/tui/gate";

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
  rec("node_entered", 80, { node: "plan", attempt: 1, rework: false }),
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
  rec("node_entered", 70, { node: "plan-approval", attempt: 1, rework: false }),
  rec("gate_decided", 60, { node: "plan-approval", decision: "approved", reason: null }),
  rec("node_finished", 60, {
    node: "plan-approval",
    attempt: 1,
    outcome: "approved",
    status: "passed",
  }),
  rec("node_entered", 59, { node: "impl", attempt: 1, rework: false }),
  rec("check_finished", 50, {
    node: "impl",
    attempt: 1,
    kind: "diff",
    passed: false,
    duration_ms: 90,
    reason: "too many lines",
  }),
  rec("node_finished", 50, { node: "impl", attempt: 1, outcome: "failed", status: "failed" }),
  rec("node_entered", 49, { node: "impl", attempt: 2, rework: true }),
  rec("check_finished", 45, {
    node: "impl",
    attempt: 2,
    kind: "diff",
    passed: true,
    duration_ms: 160,
  }),
  rec("node_finished", 45, { node: "impl", attempt: 2, outcome: "passed", status: "passed" }),
  rec("node_entered", 44, { node: "test", attempt: 1, rework: false }),
  rec("command_finished", 43, {
    node: "test",
    attempt: 1,
    passed: false,
    exit: 1,
    duration_ms: 70_000,
    reason: "1 test failed",
  }),
  rec("node_finished", 43, { node: "test", attempt: 1, outcome: "failed", status: "failed" }),
  rec("node_entered", 42, { node: "test", attempt: 2, rework: true }),
  rec("command_finished", 40, {
    node: "test",
    attempt: 2,
    passed: true,
    exit: 0,
    duration_ms: 85_000,
  }),
  rec("node_finished", 40, { node: "test", attempt: 2, outcome: "passed", status: "passed" }),
  rec("node_entered", 39, { node: "review", attempt: 1, rework: false }),
  rec("report_accepted", 38, { node: "review", attempt: 1, completeness: "complete", rows: 2 }),
  rec("check_finished", 38, {
    node: "review",
    attempt: 1,
    kind: "result",
    passed: true,
    duration_ms: 60,
  }),
  rec("node_finished", 38, { node: "review", attempt: 1, outcome: "passed", status: "passed" }),
  rec("node_entered", 37, { node: "final-approval", attempt: 1, rework: false }),
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

type Written = { ok: true } | { ok: false; code: string; message: string };

interface Fake {
  state?: RunState;
  next?: NextStep;
  journal?: JournalRecord[];
  since?: Awaited<ReturnType<GateRun["changesSinceStart"]>>;
  after?: Awaited<ReturnType<GateRun["changesSinceGate"]>>;
  reports?: Record<string, ResultReport>;
  said?: { text: string; ts: number } | undefined;
  tokens?: { tokens: number; cost?: number; approx: boolean } | undefined;
  /** Every call to `reportResult`, in order. */
  written?: { node: string; attempt: number; raw: unknown; replace: boolean }[];
  refuse?: Written;
}

const run = (fake: Fake = {}): GateRun => ({
  state: async () => fake.state ?? state(),
  currentSpec: async () => SPEC,
  inspect: async () => fake.next ?? gateNext,
  journal: async () => fake.journal ?? JOURNAL,
  changesSinceStart: async () =>
    fake.since ?? { kind: "changes", files: { "a.ts": 5, "b.ts": 30 } },
  changesSinceGate: async () => fake.after ?? { kind: "changes", files: {} },
  resultsOf: async (n, a) => fake.reports?.[`${n}:${a}`],
  agentReport: async () => fake.said,
  agentTokens: async () => fake.tokens,
  diffOf: async (path) =>
    path === "a.ts" ? { text: "@@ -1 +1 @@\n-x\n+y", truncated: false } : undefined,
  reportResult: async (node, attempt, raw, options) => {
    fake.written?.push({ node, attempt, raw, replace: options?.replace === true });
    return fake.refuse ?? { ok: true };
  },
});

const source = (fake?: Fake) => ({ open: async () => run(fake) });

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
    expect(d?.attempt).toBe(1);
    expect(d?.prompt).toBe("Look at the diff.");
    expect(d?.instructions).toBe("Try the change.");
    expect(d?.position).toBe("gate 2 of 2");
  });

  test("the visits are the entries into steps in the order they happened, repeats marked, then where the usual outcomes lead", async () => {
    const d = await load();
    expect(d?.visits.map((v) => [v.slug, v.attempt.n, v.rework, v.state])).toEqual([
      ["plan", 1, false, "done"],
      ["plan-approval", 1, false, "done"],
      ["impl", 1, false, "failed"],
      ["impl", 2, true, "done"],
      ["test", 1, false, "failed"],
      ["test", 2, true, "done"],
      ["review", 1, false, "done"],
      ["final-approval", 1, false, "waiting"],
      ["release", 0, false, "pending"],
    ]);
    expect(d?.visits.filter((v) => v.human).map((v) => v.slug)).toEqual([
      "plan-approval",
      "final-approval",
    ]);
    expect(d?.visits[0]?.kind).toBe("agent");
  });

  test("each visit keeps how it ended, for how long, why it failed, and its own records", async () => {
    const d = await load();
    const testOne = d?.visits[4]?.attempt;
    expect(testOne).toMatchObject({
      n: 1,
      outcome: "failed",
      ok: false,
      ms: MIN,
      exit: 1,
      reason: "1 test failed",
    });
    expect(testOne?.log).toHaveLength(3);
    expect(testOne?.log.join("\n")).toContain("command_finished");
    expect(d?.visits[2]?.attempt).toMatchObject({ ok: false, reason: "too many lines" });
    expect(d?.visits[3]?.attempt).toMatchObject({ ok: true, ms: 4 * MIN });
  });

  test("the try the gate is on counts its time up to now", async () => {
    const d = await load();
    expect(d?.visits[7]?.attempt.ms).toBe(37 * MIN);
    expect(d?.visits[7]?.attempt.ok).toBeUndefined();
  });

  test("checks of the verdict are those of the latest try of each step", async () => {
    const d = await load();
    expect(d?.checks.every((c) => c.passed)).toBe(true);
    expect(d?.checks.filter((c) => c.node === "test")).toEqual([
      { node: "test", label: "test", passed: true, ms: 85_000 },
    ]);
    expect(d?.checks.filter((c) => c.node === "impl")).toEqual([
      { node: "impl", label: "impl diff", passed: true, ms: 160 },
    ]);
    expect(d?.metrics.checksTotal).toBe(d?.checks.length);
    expect(d?.metrics.checksPassed).toBe(d?.checks.length);
  });

  test("a check that failed in the latest try is a failed check, and the count says so", async () => {
    const journal = JOURNAL.map((r) =>
      r.event === "command_finished" && r.attempt === 2
        ? ({ ...r, passed: false } as JournalRecord)
        : r,
    );
    const d = await load({ journal });
    expect(d?.checks.filter((c) => !c.passed).map((c) => c.node)).toEqual(["test"]);
    expect((d?.metrics.checksPassed ?? 0) < (d?.metrics.checksTotal ?? 0)).toBe(true);
  });

  test("what the agent said about a step is kept as its word, and only when it said something", async () => {
    const d = await load();
    expect(d?.visits[0]?.attempt.summary).toBe("Wrote the plan.");
    expect(d?.visits[2]?.attempt.summary).toBeUndefined();
  });

  test("a person's decisions sit on the try they were made at, with the reason", async () => {
    const journal = JOURNAL.map((r) =>
      r.event === "gate_decided"
        ? ({ ...r, decision: "rejected", reason: "no tests" } as JournalRecord)
        : r,
    );
    expect((await load({ journal }))?.visits[1]?.attempt.decision).toEqual({
      decision: "rejected",
      reason: "no tests",
    });
    expect((await load())?.visits[1]?.attempt.decision).toEqual({ decision: "approved" });
  });

  test("the findings of a review are on the try that made them", async () => {
    const d = await load({ reports: { "review:1": REVIEW } });
    expect(d?.visits[6]?.attempt.review).toEqual({
      completeness: "complete",
      findings: [
        { severity: "minor", location: "a.ts:1", description: "small" },
        { severity: "info", location: "b.ts:2", description: "fyi" },
      ],
    });
    expect(d?.visits[2]?.attempt.review).toBeUndefined();
  });

  test("the comments are the rows of the gate's own report", async () => {
    const d = await load({
      reports: {
        "final-approval:1": {
          completeness: "complete",
          rows: [{ severity: "major", location: "a.ts:3", description: "why?" }],
        },
      },
    });
    expect(d?.comments).toEqual([{ severity: "major", location: "a.ts:3", description: "why?" }]);
    expect((await load())?.comments).toEqual([]);
  });

  test("the report is what the agent last wrote in its log; failing that, the last summary a step left; failing that, nothing", async () => {
    const said = { text: "All done.", ts: NOW - 5 * MIN };
    expect((await load({ said }))?.report).toEqual({
      text: "All done.",
      ts: NOW - 5 * MIN,
      from: "log",
    });
    expect((await load())?.report).toEqual({ text: "Wrote the plan.", ts: 0, from: "journal" });
    const quiet = JOURNAL.map((r) => (r.event === "agent_completed" ? { ...r, summary: null } : r));
    expect((await load({ journal: quiet }))?.report).toBeUndefined();
  });

  test("the log is looked at from when the gate was reached", async () => {
    let asked: number | undefined;
    const open = async (): Promise<GateRun> => ({
      ...run(),
      agentReport: async (since) => {
        asked = since;
        return undefined;
      },
    });
    await loadGateDetail({ open }, "r_1", NOW);
    expect(asked).toBe(NOW - 37 * MIN);
  });

  test("the numbers: time at work and waiting for a person, steps, repeats, tokens", async () => {
    const d = await load({ tokens: { tokens: 412_000, cost: 3.4, approx: true } });
    expect(d?.metrics).toMatchObject({
      waitMs: 10 * MIN + 37 * MIN,
      workMs: 90 * MIN - 47 * MIN,
      stepsDone: 5,
      stepsTotal: 7,
      retries: 2,
      tokens: { total: 412_000, cost: 3.4, approx: true },
    });
    expect((await load())?.metrics.tokens).toBeUndefined();
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
    expect(await load({ next: { node: { slug: "impl" } } as unknown as NextStep })).toBeUndefined();
    expect(await loadGateDetail({ open: async () => undefined }, "r_1", NOW)).toBeUndefined();
  });

  test("one failing read does not take the whole detail down", async () => {
    const broken = {
      open: async (): Promise<GateRun> => ({
        ...run(),
        changesSinceStart: async () => {
          throw new Error("no git");
        },
        agentReport: async () => {
          throw new Error("log unreadable");
        },
        agentTokens: async () => {
          throw new Error("log unreadable");
        },
      }),
    };
    const d = await loadGateDetail(broken, "r_1", NOW);
    expect(d?.changes).toEqual({ kind: "unavailable", reason: "no git" });
    expect(d?.prompt).toBe("Look at the diff.");
    expect(d?.report?.from).toBe("journal");
    expect(d?.metrics.tokens).toBeUndefined();
  });
});

describe("tui comments and diffs", () => {
  test("a comment is recorded as a row of the gate's report, the way the agent records the ones it is told", async () => {
    const written: NonNullable<Fake["written"]> = [];
    await addComment(source({ written }), "r_1", "final-approval", 2, {
      severity: "major",
      location: "a.ts:3",
      description: "why?",
    });
    expect(written).toEqual([
      {
        node: "final-approval",
        attempt: 2,
        raw: { rows: [{ severity: "major", location: "a.ts:3", description: "why?" }] },
        replace: false,
      },
    ]);
  });

  test("a comment the engine refuses is an error with the engine's words", async () => {
    const refuse: Written = { ok: false, code: "INVALID_RESULT_ROWS", message: "row 0: bad" };
    await expect(
      addComment(source({ refuse }), "r_1", "final-approval", 1, {
        severity: "x",
        location: "",
        description: "",
      }),
    ).rejects.toThrow("INVALID_RESULT_ROWS: row 0: bad");
  });

  test("deleting a comment writes the list again without it", async () => {
    const written: NonNullable<Fake["written"]> = [];
    const rows = [
      { severity: "major", location: "a.ts", description: "one" },
      { severity: "minor", location: "b.ts", description: "two" },
      { severity: "info", location: "c.ts", description: "three" },
    ];
    const reports = { "final-approval:1": { completeness: "complete", rows } as ResultReport };
    await removeComment(source({ written, reports }), "r_1", "final-approval", 1, 1);
    expect(written).toEqual([
      { node: "final-approval", attempt: 1, raw: { rows: [rows[0], rows[2]] }, replace: true },
    ]);
    await expect(
      removeComment(source({ written, reports }), "r_1", "final-approval", 1, 7),
    ).rejects.toThrow("already gone");
  });

  test("a run that cannot take comments says so", async () => {
    const open = async (): Promise<GateRun> => {
      const { reportResult: _unused, ...rest } = run();
      return rest;
    };
    await expect(
      addComment({ open }, "r_1", "final-approval", 1, {
        severity: "major",
        location: "x",
        description: "y",
      }),
    ).rejects.toThrow("cannot take comments");
  });

  test("a diff is the text git gives; no diff and a failing read are answers, not crashes", async () => {
    expect(await loadDiff(source(), "r_1", "a.ts")).toEqual({
      kind: "text",
      text: "@@ -1 +1 @@\n-x\n+y",
      truncated: false,
    });
    expect(await loadDiff(source(), "r_1", "other.ts")).toEqual({ kind: "missing" });
    expect(await loadDiff({ open: async () => undefined }, "r_1", "a.ts")).toEqual({
      kind: "missing",
    });
    const broken = {
      open: async (): Promise<GateRun> => ({
        ...run(),
        diffOf: async () => {
          throw new Error("git failed");
        },
      }),
    };
    expect(await loadDiff(broken, "r_1", "a.ts")).toEqual({ kind: "error", message: "git failed" });
  });
});
