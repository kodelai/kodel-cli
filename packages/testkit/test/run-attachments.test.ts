/**
 * A scenario whose agent keeps an attachment (T-45): the production of an attempt names what the agent
 * keeps with the run, and the engine that keeps attachments (the local one) takes it. The pipeline uses
 * the `attachment` check, which only such an engine has, so the scenario is read with the engine's kinds.
 */
import { describe, expect, test } from "bun:test";
import {
  defineScenario,
  formatReport,
  humanApprove,
  inj,
  LocalScenarioEngine,
  MemoryEngine,
  matcher,
  runScenario,
} from "../src";

const PIPELINE = [
  "name: planned",
  "nodes:",
  "  - slug: plan",
  "    kind: agent",
  "    prompt: write the plan",
  "    checks:",
  "      - { kind: attachment, name: plan.md, min_lines: 2 }",
  "  - { slug: approval, kind: human, prompt: fine? }",
  "  - { slug: impl, kind: agent, prompt: build it }",
  "edges:",
  "  - { from: plan, to: approval }",
  "  - { from: approval, to: impl, when: approved }",
  "  - { from: approval, to: plan, when: rejected }",
  "",
].join("\n");

const planKept = defineScenario("attachment/plan-kept-after-a-short-one")
  .describe("the first plan is too short for the check; the second passes, and the run goes on")
  .pipeline({ inline: PIPELINE })
  .task("keep a plan")
  .inject(
    inj("plan", {
      1: { attach: [{ name: "plan.md", content: "one line\n" }] },
      2: { attach: [{ name: "plan.md", content: "one\ntwo\nthree\n" }] },
    }),
  )
  .expect([
    matcher("waitingGates", ["approval"]),
    matcher("attempts", { plan: 2 }),
    matcher("journalHas", ["attachment_written", "check_finished"]),
  ])
  .on(humanApprove("approval"))
  .expect([matcher("runStatus", "completed"), matcher("trail", ["plan", "approval", "impl"])])
  .build();

const neverKept = defineScenario("attachment/never-kept")
  .describe("an agent that never keeps the plan never gets past the check")
  .pipeline({ inline: PIPELINE })
  .task("keep no plan")
  .expect([matcher("runStatus", "paused"), matcher("nodeStatus", { plan: "failed" })])
  .build();

describe("t45 a scenario with attachments", () => {
  test("t45_testkit_attach_on_the_local_engine", async () => {
    for (const scenario of [planKept, neverKept]) {
      const report = await runScenario(scenario, new LocalScenarioEngine());
      expect(report.ok, formatReport(report)).toBe(true);
    }
  }, 60_000);

  test("t45_an_engine_without_attachments_does_not_read_the_pipeline", async () => {
    // the core with in-memory adapters keeps no attachments and has no such check kind: the scenario
    // is refused where its pipeline is read, never run with a check that could not be judged
    await expect(runScenario(planKept, new MemoryEngine())).rejects.toThrow(
      'unknown check kind "attachment"',
    );
  });
});
