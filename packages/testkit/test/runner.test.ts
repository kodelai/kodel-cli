import { describe, expect, test } from "bun:test";
import {
  createMatchers,
  defineScenario,
  expectError,
  expectOk,
  formatReport,
  humanApprove,
  inj,
  isSubset,
  type Matcher,
  matcher,
  runConformance,
  runScenario,
  type Scenario,
  type ScenarioEngine,
  type ScenarioState,
  ScriptedEngine,
  validateScenario,
} from "../src";
import { loadPipeline } from "../src/load";

const PIPELINE = { file: "examples/pipelines/feature.yaml" };

const state = (over: Partial<ScenarioState> = {}): ScenarioState => ({
  runStatus: "running",
  nodes: [
    { slug: "plan", status: "passed", outcome: "passed", attempt: 2 },
    { slug: "plan-approval", status: "waiting", outcome: null, attempt: 1 },
  ],
  trail: ["plan", "plan-approval"],
  journal: ["run_started"],
  waitingGates: ["plan-approval"],
  ...over,
});

const simple = (...assertions: ReturnType<typeof matcher>[]) =>
  defineScenario("t/simple").pipeline(PIPELINE).expect(assertions).build();

describe("the builder", () => {
  test("collects inputs and steps in order", () => {
    const s = defineScenario("t/order")
      .describe("d")
      .pipeline(PIPELINE)
      .task("fix it")
      .inject(inj("build", { 1: { exit: 1 }, 2: {} }))
      .on(humanApprove("plan-approval"))
      .expect([matcher("runStatus", "completed")])
      .build();
    expect(s.task).toBe("fix it");
    expect(s.agentMode).toBe("auto");
    expect(s.injects).toEqual([
      { node: "build", attempt: 1, produce: { exit: 1 } },
      { node: "build", attempt: 2, produce: {} },
    ]);
    expect(s.steps.map((x) => x.kind)).toEqual(["event", "check"]);
  });

  test("a scenario needs a pipeline", () => {
    expect(() => defineScenario("t/none").build()).toThrow("pipeline() is required");
  });
});

describe("validateScenario", () => {
  const spec = loadPipeline(PIPELINE);
  const problems = (s: Scenario) => validateScenario(s, spec);

  test("accepts a sound scenario", () => {
    expect(problems(simple(matcher("runStatus", "completed")))).toEqual([]);
  });

  test("catches typos in node names, everywhere they can appear", () => {
    const s = defineScenario("t/typos")
      .pipeline(PIPELINE)
      .inject(inj("bild", { 1: {} }))
      .on(humanApprove("plan-aproval"))
      .expect([
        matcher("attempts", { bild: 1 }),
        matcher("trail", ["plan", "nope"]),
        matcher("waitingGates", ["ghost"]),
      ])
      .build();
    const text = problems(s).join("\n");
    expect(text).toContain('inject #0 names unknown node "bild"');
    expect(text).toContain('names unknown node "plan-aproval"');
    expect(text).toContain('attempts names unknown node "bild"');
    expect(text).toContain('trail names unknown node "nope"');
    expect(text).toContain('waitingGates names unknown node "ghost"');
  });

  test("a human decision must target a human node", () => {
    const s = defineScenario("t/h")
      .pipeline(PIPELINE)
      .on(humanApprove("build"))
      .expect([matcher("runStatus", "x")])
      .build();
    expect(problems(s).join()).toContain("not a human node");
  });

  test("attempts start at 1 and are not repeated", () => {
    const s = defineScenario("t/a")
      .pipeline(PIPELINE)
      .inject(inj("build", { 0: {} }), inj("test", { 1: {} }), inj("test", { 1: { exit: 1 } }))
      .expect([matcher("runStatus", "x")])
      .build();
    const text = problems(s).join("\n");
    expect(text).toContain("attempts start at 1");
    expect(text).toContain("duplicate inject for test#1");
  });

  test("a scenario must assert something, and must know its matchers", () => {
    const bare = defineScenario("t/b").pipeline(PIPELINE).build();
    expect(problems(bare).join()).toContain("must assert something");
    expect(problems(simple(matcher("vibes", true))).join()).toContain('unknown matcher "vibes"');
  });

  test("manual mode needs tool steps", () => {
    const s = defineScenario("t/m")
      .pipeline(PIPELINE)
      .agent("manual")
      .expect([matcher("runStatus", "x")])
      .build();
    expect(problems(s).join()).toContain("needs tool steps");
  });
});

describe("runScenario", () => {
  test("passes when the state matches", async () => {
    const engine = new ScriptedEngine(state());
    const s = defineScenario("t/pass")
      .pipeline(PIPELINE)
      .task("x")
      .inject(inj("plan", { 1: { changes: { "a.md": 1 } } }))
      .on(humanApprove("plan-approval"))
      .expect([
        matcher("runStatus", "running"),
        matcher("waitingGates", ["plan-approval"]),
        matcher("attempts", { plan: 2 }),
        matcher("trail", ["plan", "plan-approval"]),
        matcher("executed", ["plan"]),
        matcher("never", ["impl"]),
        matcher("nodeStatus", { "plan-approval": "waiting" }),
        matcher("nodeOutcome", { plan: "passed" }),
        matcher("journalHas", "run_started"),
        matcher("journalLacks", "run_paused"),
      ])
      .build();
    const report = await runScenario(s, engine);
    expect(report.ok).toBe(true);
    expect(engine.started?.task).toBe("x");
    expect(engine.started?.injects).toHaveLength(1);
    expect(engine.events).toEqual([{ kind: "humanApprove", node: "plan-approval" }]);
    expect(engine.disposed).toBe(true);
  });

  test("reports the first divergence with expected and actual values", async () => {
    const s = simple(
      matcher("runStatus", "running"),
      matcher("attempts", { plan: 1 }),
      matcher("never", ["plan"]),
    );
    const report = await runScenario(s, new ScriptedEngine(state()));
    expect(report.ok).toBe(false);
    expect(report.divergence).toMatchObject({
      kind: "assertion",
      key: "attempts",
      expected: { plan: 1 },
      actual: { plan: 2 },
    });
    const text = formatReport(report);
    expect(text).toContain("FAIL t/simple on scripted");
    expect(text).toContain('expected: {"plan":1}');
    expect(text).toContain('actual:   {"plan":2}');
  });

  test("checkpoints in the middle are evaluated in order", async () => {
    const s = defineScenario("t/mid")
      .pipeline(PIPELINE)
      .expect([matcher("runStatus", "completed")])
      .on(humanApprove("plan-approval"))
      .expect([matcher("runStatus", "running")])
      .build();
    const report = await runScenario(s, new ScriptedEngine(state()));
    expect(report.divergence?.step).toBe(0);
  });

  test("tool steps substitute $run and compare the response", async () => {
    const engine = new ScriptedEngine(state(), {
      pipeline_complete_step: (args) =>
        args.attempt === 5
          ? { ok: false, code: "ATTEMPT_MISMATCH", message: "no" }
          : { ok: true, advanced: false, outcome: "failed", next: { node: "impl" } },
    });
    const s = defineScenario("t/tools")
      .pipeline(PIPELINE)
      .agent("manual")
      .call(
        "pipeline_complete_step",
        { run_id: "$run", node_slug: "plan", attempt: 5 },
        expectError("ATTEMPT_MISMATCH"),
      )
      .call(
        "pipeline_complete_step",
        { run_id: "$run", node_slug: "plan", attempt: 1 },
        expectOk({ advanced: false, next: { node: "impl" } }),
      )
      .expect([matcher("runStatus", "running")])
      .build();
    const report = await runScenario(s, engine);
    expect(report.ok).toBe(true);
    expect(engine.calls[0]?.args.run_id).toBe("run-1");
  });

  test("a wrong tool answer is a divergence", async () => {
    const engine = new ScriptedEngine(state(), {
      pipeline_complete_step: () => ({ ok: true, advanced: true }),
    });
    const s = defineScenario("t/wrong")
      .pipeline(PIPELINE)
      .agent("manual")
      .call("pipeline_complete_step", { run_id: "$run" }, expectError("ATTEMPT_MISMATCH"))
      .expect([matcher("runStatus", "running")])
      .build();
    const report = await runScenario(s, engine);
    expect(report.divergence).toMatchObject({ kind: "tool", key: "pipeline_complete_step" });
  });

  test("an engine without tool support is reported as unsupported, not as a crash", async () => {
    const noTools: ScenarioEngine = {
      name: "no-tools",
      start: async () => ({ runId: "r" }),
      applyEvent: async () => {},
      readState: async () => state(),
    };
    const s = defineScenario("t/u")
      .pipeline(PIPELINE)
      .agent("manual")
      .call("pipeline_feedback", { run_id: "$run" }, expectOk())
      .expect([matcher("runStatus", "running")])
      .build();
    const report = await runScenario(s, noTools);
    expect(report.divergence?.kind).toBe("unsupported");
  });

  test("an invalid scenario is a setup divergence and never starts the engine", async () => {
    const engine = new ScriptedEngine(state());
    const report = await runScenario(simple(matcher("attempts", { ghost: 1 })), engine);
    expect(report.divergence?.kind).toBe("setup");
    expect(engine.started).toBeUndefined();
  });

  test("an engine that throws is reported, and still disposed", async () => {
    const engine = new ScriptedEngine(state());
    engine.start = async () => {
      throw new Error("boom");
    };
    const report = await runScenario(simple(matcher("runStatus", "running")), engine);
    expect(report.divergence).toMatchObject({ kind: "engine", actual: "boom" });
    expect(engine.disposed).toBe(true);
  });

  test("custom matchers are per run and do not leak", async () => {
    const maxAttempt: Matcher = {
      key: "maxAttempt",
      apply: (s, expected) => {
        const got = Math.max(...s.nodes.map((n) => n.attempt));
        return { ok: got === expected, expected, actual: got, detail: "highest attempt" };
      },
    };
    const s = defineScenario("t/custom")
      .pipeline(PIPELINE)
      .expect([matcher("maxAttempt", 2)])
      .build();
    expect((await runScenario(s, new ScriptedEngine(state()), { matchers: [maxAttempt] })).ok).toBe(
      true,
    );
    expect((await runScenario(s, new ScriptedEngine(state()))).divergence?.kind).toBe("setup");
    expect(createMatchers().has("maxAttempt")).toBe(false);
  });
});

describe("runConformance", () => {
  test("runs every scenario on a fresh engine", async () => {
    const engines: ScriptedEngine[] = [];
    const reports = await runConformance(() => {
      const e = new ScriptedEngine(state());
      engines.push(e);
      return e;
    }, [simple(matcher("runStatus", "running")), simple(matcher("runStatus", "completed"))]);
    expect(reports.map((r) => r.ok)).toEqual([true, false]);
    expect(new Set(engines).size).toBe(2);
  });
});

describe("isSubset", () => {
  test("compares objects by the keys of the expectation, deeply", () => {
    expect(isSubset({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } })).toBe(true);
    expect(isSubset({ a: 1 }, { a: 2 })).toBe(false);
    expect(isSubset({ a: 1 }, { b: undefined })).toBe(true);
    expect(isSubset("x", { a: 1 })).toBe(false);
    expect(isSubset([1, 2], [1, 2])).toBe(true);
  });
});

describe("refused follow-ups", () => {
  const engineWith = (afterEnd: boolean): ScenarioEngine => ({
    name: "refusing",
    start: async () => ({ runId: "r" }),
    applyEvent: async () => {},
    readState: async () => state(),
    refusedFollowUps: () => [
      { event: "work_finished", code: "NODE_NOT_RUNNING", message: "no", afterEnd },
    ],
  });

  test("t40_scenario_fails_on_a_follow_up_refused_while_the_run_goes", async () => {
    const report = await runScenario(simple(), engineWith(false));
    expect(report.ok).toBe(false);
    expect(report.divergence?.kind).toBe("engine");
    expect(report.divergence?.detail).toContain("work_finished refused: NODE_NOT_RUNNING");
    // one refused after the end is the end, not a stall
    expect((await runScenario(simple(), engineWith(true))).ok).toBe(true);
    // and a scenario that expects one says so
    const allowed = defineScenario("t/allowed")
      .pipeline(PIPELINE)
      .allowRefusedFollowUps()
      .expect([])
      .build();
    expect((await runScenario(allowed, engineWith(false))).ok).toBe(true);
  });
});
