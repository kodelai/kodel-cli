/**
 * T-40: `pipeline_take_step` works the same on every engine of the testkit: a step is claimed once,
 * a second take answers `taken`, and a completion without the token is accepted and journaled.
 */
import { describe, expect, test } from "bun:test";
import type { LocalRun } from "@kodel-ai/local";
import { parsePipeline, type RunState } from "@kodel-ai/pipeline-core";
import {
  defineScenario,
  expectError,
  expectOk,
  formatReport,
  LocalScenarioEngine,
  MemoryEngine,
  matcher,
  runScenario,
  type ScenarioEngine,
} from "../src";

const FORK = [
  "name: fork",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: do a }",
  "  - { slug: b, kind: agent, prompt: do b }",
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: merge }",
  "  - { from: b, to: merge }",
  "",
].join("\n");

const scenario = defineScenario("t40-take-step")
  .pipeline({ inline: FORK })
  .task("split the work")
  .agent("manual")
  .call("pipeline_complete_step", { run_id: "$run", node_slug: "plan", attempt: 1 }, expectOk())
  .call("pipeline_next_step", { run_id: "$run" }, expectOk({ node: { slug: "a" } }))
  .call(
    "pipeline_take_step",
    { run_id: "$run", node_slug: "a" },
    expectOk({ status: "claimed", node_slug: "a", attempt: 1 }),
  )
  .call(
    "pipeline_take_step",
    { run_id: "$run", node_slug: "a" },
    expectOk({ status: "taken", node_slug: "a", attempt: 1 }),
  )
  // the next free step is `b`; a step asked for by name is answered exactly
  .call("pipeline_take_step", { run_id: "$run" }, expectOk({ status: "claimed", node_slug: "b" }))
  // nothing is free: the answer is a worker's, with what is going on in `next`
  .call(
    "pipeline_take_step",
    { run_id: "$run" },
    expectOk({ status: "none", next: { running: { open_steps: [{ node_slug: "a" }] } } }),
  )
  .call("pipeline_next_step", { run_id: "$run", node_slug: "b" }, expectOk({ node: { slug: "b" } }))
  // a completion without the token is accepted: the checks decide, the claim is advice
  .call("pipeline_complete_step", { run_id: "$run", node_slug: "a", attempt: 1 }, expectOk())
  .call("pipeline_complete_step", { run_id: "$run", node_slug: "b", attempt: 1 }, expectOk())
  .expect([
    matcher("nodeStatus", { a: "passed", b: "passed", merge: "running" }),
    matcher("journalHas", ["step_claimed", "step_claim_conflict", "join_reached"]),
  ])
  .build();

/** A step asked for by a slug the pipeline has not is refused as an answer, never as a thrown error. */
const unknownSlug = defineScenario("t40-unknown-slug")
  .pipeline({ inline: FORK })
  .task("split the work")
  .agent("manual")
  .call("pipeline_complete_step", { run_id: "$run", node_slug: "plan", attempt: 1 }, expectOk())
  .call(
    "pipeline_next_step",
    { run_id: "$run", node_slug: "nope" },
    expectError("UNKNOWN_NODE", { message: 'the pipeline has no node "nope"' }),
  )
  .call("pipeline_next_step", { run_id: "$run", node_slug: "a" }, expectOk({ node: { slug: "a" } }))
  .expect([matcher("nodeStatus", { a: "running", b: "running" })])
  .build();

/** With `agents.max_parallel` 1, a second step waits its turn and a take without a slug finds none. */
const capped = defineScenario("t40-take-step-capped")
  .pipeline({ inline: FORK })
  .task("split the work")
  .agent("manual")
  .call("pipeline_complete_step", { run_id: "$run", node_slug: "plan", attempt: 1 }, expectOk())
  .call("pipeline_take_step", { run_id: "$run", node_slug: "a" }, expectOk({ status: "claimed" }))
  .call(
    "pipeline_take_step",
    { run_id: "$run", node_slug: "b" },
    expectOk({ status: "queued", node_slug: "b", held: 1, max_parallel: 1 }),
  )
  .call("pipeline_take_step", { run_id: "$run" }, expectOk({ status: "none" }))
  .expect([matcher("nodeStatus", { a: "running", b: "running" })])
  .build();

test("t40_memory_engine_take_follows_the_core_cap", async () => {
  const engine = new MemoryEngine();
  engine.maxParallel = 1;
  const report = await runScenario(capped, engine);
  expect(report.ok, formatReport(report)).toBe(true);
});

/** One worker holds both steps at the cap and renews either of them; a handed-in step is `none`. */
const renewAtCap = defineScenario("t40-renew-at-cap")
  .pipeline({ inline: FORK })
  .task("split the work")
  .agent("manual")
  .call("pipeline_complete_step", { run_id: "$run", node_slug: "plan", attempt: 1 }, expectOk())
  .call(
    "pipeline_take_step",
    { run_id: "$run", node_slug: "a", claim_token: "T" },
    expectOk({ status: "claimed" }),
  )
  .call(
    "pipeline_take_step",
    { run_id: "$run", node_slug: "b", claim_token: "T" },
    expectOk({ status: "claimed" }),
  )
  .call(
    "pipeline_take_step",
    { run_id: "$run", node_slug: "b", claim_token: "T" },
    expectOk({ status: "renewed", node_slug: "b" }),
  )
  .call(
    "pipeline_take_step",
    { run_id: "$run", node_slug: "a", claim_token: "T" },
    expectOk({ status: "renewed", node_slug: "a" }),
  )
  .call(
    "pipeline_complete_step",
    { run_id: "$run", node_slug: "a", attempt: 1, claim_token: "T" },
    expectOk(),
  )
  .call(
    "pipeline_take_step",
    { run_id: "$run", node_slug: "a", claim_token: "U" },
    expectOk({ status: "none" }),
  )
  .expect([matcher("nodeStatus", { a: "passed", b: "running" })])
  .build();

describe("t40 renewal at the cap in both test engines", () => {
  test("t40_renew_second_step_at_the_cap_in_both_test_engines (core-memory)", async () => {
    const engine = new MemoryEngine();
    engine.maxParallel = 2;
    const report = await runScenario(renewAtCap, engine);
    expect(report.ok, formatReport(report)).toBe(true);
  });
  test("t40_renew_second_step_at_the_cap_in_both_test_engines (local)", async () => {
    const engine = new LocalScenarioEngine();
    engine.maxParallel = 2;
    const report = await runScenario(renewAtCap, engine);
    expect(report.ok, formatReport(report)).toBe(true);
  }, 60_000);
});

const engines: { name: string; make: () => ScenarioEngine }[] = [
  { name: "core-memory", make: () => new MemoryEngine() },
  { name: "local", make: () => new LocalScenarioEngine() },
];

describe("t40 take_step in both test engines", () => {
  for (const { name, make } of engines) {
    test(`t40_take_step_in_both_test_engines (${name})`, async () => {
      const report = await runScenario(scenario, make());
      expect(report.ok, formatReport(report)).toBe(true);
    }, 60_000);

    test(`t40_next_step_unknown_node_slug_refused_in_both_test_engines (${name})`, async () => {
      const report = await runScenario(unknownSlug, make());
      expect(report.ok, formatReport(report)).toBe(true);
    }, 60_000);
  }
});

test("t40_local_engine_keeps_refused_follow_ups", async () => {
  // a result of engine work the run cannot take is kept, as the memory engine keeps it, so the
  // runner's rule (no follow-up refused while the run goes) holds on the local engine too
  const engine = new LocalScenarioEngine();
  try {
    await engine.start({
      spec: parsePipeline(FORK),
      task: "split the work",
      agentMode: "manual",
      injects: [],
    });
    expect(engine.refusedFollowUps()).toEqual([]);
    const run = (engine as unknown as { run: LocalRun }).run;
    await run.apply({ type: "work_finished", node: "plan", attempt: 1, passed: true, reason: "" });
    expect(engine.refusedFollowUps()).toEqual([
      expect.objectContaining({ event: "work_finished", afterEnd: false }),
    ]);
  } finally {
    await engine.dispose();
  }
}, 60_000);

test("t40_memory_engine_take_without_slug_answers_the_step_the_machine_renewed", async () => {
  // one worker holds a and b; the machine renews the first it holds in the order of the open visits,
  // which here is b (the visits are put in another order than the nodes); the answer names b too
  const engine = new MemoryEngine();
  await engine.start({
    spec: parsePipeline(FORK),
    task: "split the work",
    injects: [],
    agentMode: "manual",
  });
  await engine.callTool("pipeline_complete_step", {
    run_id: "run-1",
    node_slug: "plan",
    attempt: 1,
  });
  for (const slug of ["a", "b"]) {
    const took = await engine.callTool("pipeline_take_step", {
      run_id: "run-1",
      node_slug: slug,
      claim_token: "T",
    });
    expect(took).toMatchObject({ ok: true, status: "claimed", node_slug: slug });
  }
  const inner = engine as unknown as { state: RunState };
  inner.state = { ...inner.state, active: [...inner.state.active].reverse() };
  expect(inner.state.active.map((v) => v.node)).toEqual(["b", "a"]);
  const renewed = await engine.callTool("pipeline_take_step", {
    run_id: "run-1",
    claim_token: "T",
  });
  expect(renewed).toMatchObject({ ok: true, status: "renewed", node_slug: "b" });
});
