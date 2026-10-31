import { describe, expect, test } from "bun:test";
import {
  type AttemptReport,
  type JournalRecord,
  type NodeReport,
  type RunReport,
  type RunState,
  spread,
  summarizePipeline,
  summarizeRun,
} from "../src";

const DEF_A = { work: "w1", checks: "c1", routing: "r1" };
const DEF_B = { work: "w2", checks: "c1", routing: "r1" };

function attempt(n: number, over: Partial<AttemptReport> = {}): AttemptReport {
  return { attempt: n, seconds: 10, outcome: "passed", definition: DEF_A, ...over };
}

function node(name: string, attempts: AttemptReport[], gate = false): NodeReport {
  return {
    node: name,
    gate,
    attempts,
    seconds: attempts.reduce((s, a) => s + a.seconds, 0),
  };
}

function run(id: string, at: number, nodes: NodeReport[], status = "completed") {
  const report: RunReport = {
    runId: id,
    task: id,
    slug: id,
    status,
    total_s: 100,
    work_s: 80,
    waiting_s: 20,
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
  };
  return { runId: id, at, report };
}

const failed = (reason: string, source = "check:result"): Partial<AttemptReport> => ({
  outcome: "blocking_findings",
  failure: { source, reason },
});

describe("spread", () => {
  test("an empty list has no numbers", () => {
    expect(spread([])).toMatchObject({ n: 0, median: 0, p90: 0, max: 0 });
  });

  test("median, p90 and max of a list", () => {
    const s = spread([5, 1, 3, 2, 4, 6, 7, 8, 9, 10]);
    expect(s).toMatchObject({ n: 10, median: 5, p90: 9, max: 10, mean: 5.5 });
  });
});

describe("summarizePipeline per step", () => {
  const runs = [
    run("r1", 1, [node("impl", [attempt(1, failed("typecheck failed", "command")), attempt(2)])]),
    run("r2", 2, [node("impl", [attempt(1, { seconds: 30 })])]),
  ];
  const stats = summarizePipeline(runs, { scope: "all" });
  const impl = stats.nodes[0];

  test("runs, attempts and the rework a run needed", () => {
    expect(impl).toMatchObject({ node: "impl", runs: 2, attempts: 3, failed: 1 });
    expect(impl?.perRun).toBeCloseTo(1.5);
  });

  test("how attempts ended, and why they failed", () => {
    expect(impl?.outcomes).toEqual({ blocking_findings: 1, passed: 2 });
    expect(impl?.failures).toEqual([{ source: "command", reason: "typecheck failed", n: 1 }]);
  });

  test("the time of an attempt", () => {
    expect(impl?.seconds).toMatchObject({ n: 3, median: 10, max: 30 });
  });

  test("the runs of the pipeline by how they ended", () => {
    const mixed = summarizePipeline(
      [
        run("a", 1, [node("impl", [attempt(1)])], "completed"),
        run("b", 2, [node("impl", [attempt(1)])], "failed"),
        run("c", 3, [node("impl", [attempt(1)])], "running"),
      ],
      { scope: "all" },
    );
    expect(mixed.runs).toEqual({
      total: 3,
      used: 3,
      byStatus: { completed: 1, failed: 1, running: 1 },
    });
    expect(mixed.seconds.total.n).toBe(2);
  });

  test("an attempt that has not ended, or was cut off by a change, counts for nothing", () => {
    const s = summarizePipeline(
      [
        run("a", 1, [
          node("impl", [
            attempt(1, { outcome: "superseded" }),
            attempt(2, { outcome: undefined }),
            attempt(3),
          ]),
        ]),
      ],
      { scope: "all" },
    );
    expect(s.nodes[0]?.attempts).toBe(1);
  });

  test("the steps come in the order of the pipeline, and the ones it does not list after them", () => {
    const s = summarizePipeline(
      [run("a", 1, [node("b", [attempt(1)]), node("a", [attempt(1)]), node("gone", [attempt(1)])])],
      { scope: "all", order: ["a", "b"] },
    );
    expect(s.nodes.map((n) => n.node)).toEqual(["a", "b", "gone"]);
  });
});

describe("findings, decisions and usage", () => {
  test("findings are counted by severity, from the host's count or else the journal's rows", () => {
    const s = summarizePipeline(
      [
        run("a", 1, [
          node("review", [
            attempt(1, { findings: { critical: 2, minor: 3 } }),
            attempt(2, { reports: [{ completeness: "complete", rows: 4 }] }),
            attempt(3),
          ]),
        ]),
      ],
      { scope: "all" },
    );
    expect(s.nodes[0]?.findings).toEqual({
      attempts: 2,
      rows: 9,
      bySeverity: { critical: 2, minor: 3 },
    });
  });

  test("at a gate: the decisions, and how many rejections said why", () => {
    const rejected = (reason?: string): Partial<AttemptReport> => ({
      outcome: "rejected",
      failure: { source: "human", reason: reason ?? "" },
      decision: { outcome: "rejected", ...(reason ? { reason } : {}) },
    });
    const s = summarizePipeline(
      [
        run("a", 1, [
          node(
            "approve",
            [
              attempt(1, rejected("fix the tests")),
              attempt(2, rejected()),
              attempt(3, { outcome: "approved", decision: { outcome: "approved" } }),
            ],
            true,
          ),
        ]),
      ],
      { scope: "all" },
    );
    expect(s.nodes[0]?.gate).toBe(true);
    expect(s.nodes[0]?.decisions).toEqual({
      approved: 1,
      rejected: 2,
      rejectedWithReason: 1,
      reasons: ["fix the tests"],
    });
  });

  test("usage is summed over the attempts that recorded it", () => {
    const usage = { input: 10, output: 20, cache_read: 30, cache_write: 40, calls: 2, usd: 0.5 };
    const s = summarizePipeline(
      [run("a", 1, [node("impl", [attempt(1, { usage }), attempt(2)])])],
      { scope: "all" },
    );
    expect(s.nodes[0]?.usage).toEqual({
      attempts: 1,
      usd: 0.5,
      input: 10,
      output: 20,
      cache_read: 30,
      cache_write: 40,
    });
    expect(s.attempts).toMatchObject({ total: 2, withUsage: 1 });
  });
});

describe("the definitions of a step", () => {
  const runs = [
    run("old", 1, [node("impl", [attempt(1, failed("x")), attempt(2)])]),
    run("new", 2, [node("impl", [attempt(1, { definition: DEF_B, seconds: 5 })])]),
    run("ancient", 0, [node("impl", [attempt(1, { definition: undefined })])]),
  ];
  const options = { current: { impl: DEF_B } } as const;

  test("the current scope keeps the attempts on the definition the pipeline has now", () => {
    const s = summarizePipeline(runs, { scope: "current", ...options });
    expect(s.nodes[0]).toMatchObject({ runs: 1, attempts: 1 });
    expect(s.attempts).toMatchObject({ total: 4, inScope: 1, withDefinition: 3 });
    expect(s.runs).toMatchObject({ total: 3, used: 1 });
  });

  test("a step of the pipeline with nothing on its present definition is listed, empty", () => {
    const s = summarizePipeline(runs, {
      scope: "current",
      current: { impl: { work: "w9", checks: "c1", routing: "r1" } },
      order: ["impl"],
    });
    expect(s.nodes).toHaveLength(1);
    expect(s.nodes[0]).toMatchObject({ node: "impl", runs: 0, attempts: 0, elsewhere: 4 });
  });

  test("the attempts the scope leaves out are counted for the step", () => {
    const s = summarizePipeline(runs, { scope: "current", ...options });
    expect(s.nodes[0]?.elsewhere).toBe(3);
    expect(summarizePipeline(runs, { scope: "all", ...options }).nodes[0]?.elsewhere).toBe(0);
  });

  test("the all scope keeps every attempt", () => {
    const s = summarizePipeline(runs, { scope: "all", ...options });
    expect(s.nodes[0]?.attempts).toBe(4);
  });

  test("a step the pipeline no longer has keeps all its attempts in the current scope", () => {
    const s = summarizePipeline(runs, { scope: "current", current: {} });
    expect(s.nodes[0]?.attempts).toBe(4);
  });

  test("versions: oldest first, what changed, and the numbers of each", () => {
    const s = summarizePipeline(runs, { scope: "current", ...options });
    const impl = s.versions[0];
    expect(impl?.node).toBe("impl");
    expect(impl?.versions.map((v) => [v.index, v.current, v.changed])).toEqual([
      [1, false, []],
      [2, true, ["work"]],
    ]);
    expect(impl?.versions[0]).toMatchObject({ runs: 1, attempts: 2, failed: 1 });
    expect(impl?.versions[1]).toMatchObject({ runs: 1, attempts: 1, failed: 0 });
  });

  test("a gate's versions say how many rejections each had, and how many said why", () => {
    const gate = (def: AttemptReport["definition"], reasons: (string | undefined)[]) =>
      reasons.map((reason, i) =>
        attempt(i + 1, {
          definition: def,
          outcome: "rejected",
          failure: { source: "human", reason: reason ?? "" },
          decision: { outcome: "rejected", ...(reason ? { reason } : {}) },
        }),
      );
    const s = summarizePipeline(
      [
        run("a", 1, [node("approve", gate(DEF_A, ["fix it", undefined]), true)]),
        run("b", 2, [node("approve", gate(DEF_B, ["no tests"]), true)]),
      ],
      { scope: "all" },
    );
    expect(s.versions[0]?.versions.map((v) => v.decisions)).toEqual([
      { rejected: 2, rejectedWithReason: 1 },
      { rejected: 1, rejectedWithReason: 1 },
    ]);
  });

  test("a step that nobody decides has no decisions in its versions", () => {
    const s = summarizePipeline(
      [
        run("a", 1, [node("impl", [attempt(1)])]),
        run("b", 2, [node("impl", [attempt(1, { definition: DEF_B })])]),
      ],
      { scope: "all" },
    );
    expect(s.versions[0]?.versions[0]?.decisions).toBeUndefined();
  });

  test("a step with one definition has no versions to compare", () => {
    const s = summarizePipeline([run("a", 1, [node("impl", [attempt(1)])])], { scope: "all" });
    expect(s.versions).toEqual([]);
  });
});

describe("summarizeRun reads usage and a person's decision", () => {
  const state = {
    v: 1,
    runId: "r1",
    task: "t",
    specHash: "h",
    status: "completed",
    startedAt: 0,
    finishedAt: 100,
    nodes: {},
    active: [],
    trail: [],
    nextVisitId: 1,
    seq: 1,
  } as unknown as RunState;
  const at = (ts: number, event: string, rest: Record<string, unknown> = {}): JournalRecord => ({
    v: 1,
    seq: ts,
    ts,
    event,
    ...rest,
  });
  const journal: JournalRecord[] = [
    at(0, "node_entered", { node: "approve", attempt: 1 }),
    at(1000, "gate_waiting", { node: "approve" }),
    at(5000, "gate_decided", { node: "approve", decision: "rejected", reason: "fix it" }),
    at(5000, "node_finished", { node: "approve", attempt: 1, outcome: "rejected" }),
    at(6000, "node_entered", { node: "work", attempt: 1 }),
    at(7000, "usage_recorded", {
      node: "work",
      attempt: 1,
      delta: {
        models: {
          a: {
            input: 1,
            output: 2,
            cache_read: 3,
            cache_write: 4,
            api_calls: 5,
            computed_usd: 0.25,
          },
          b: { input: 10, output: 20, reported_usd: 0.5, computed_usd: 0 },
        },
      },
    }),
    at(8000, "usage_recorded", {
      node: "work",
      attempt: 1,
      delta: { models: { a: { input: 1, output: 1, computed_usd: 0.25 } } },
    }),
  ];
  const report = summarizeRun(state, journal);

  test("a decision at a gate is on its attempt, with the words", () => {
    expect(report.nodes.find((n) => n.node === "approve")?.attempts[0]?.decision).toEqual({
      outcome: "rejected",
      reason: "fix it",
    });
  });

  test("usage records of an attempt add up over its models and its records", () => {
    expect(report.nodes.find((n) => n.node === "work")?.attempts[0]?.usage).toEqual({
      input: 12,
      output: 23,
      cache_read: 3,
      cache_write: 4,
      calls: 5,
      usd: 1,
    });
  });
});
