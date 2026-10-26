import { describe, expect, test } from "bun:test";
import { featureScenarios, formatReport, LocalScenarioEngine, runScenario } from "../src";

interface Served {
  node: string;
  attempt: number;
  n: number;
  answer: { slug: string; reentry_feedback?: string };
}

describe("what the agent was shown, in a scripted run", () => {
  test("v75e_scenario_failing_check_reason_in_attempt_2", async () => {
    const scenario = featureScenarios.find((s) => s.id === "feature/test-fails-then-passes");
    expect(scenario).toBeDefined();
    const engine = new LocalScenarioEngine();
    // `runScenario` disposes the engine, so the files are read from what it left in the journal first
    const seen: Served[] = [];
    const original = engine.readState.bind(engine);
    engine.readState = async () => {
      const state = await original();
      seen.splice(
        0,
        seen.length,
        ...((await engine.servedFiles()).map((f) => f.content) as Served[]),
      );
      return state;
    };
    const report = await runScenario(scenario as NonNullable<typeof scenario>, engine);
    expect(report.ok, formatReport(report)).toBe(true);
    const impl = seen.filter((f) => f.node === "impl");
    expect(impl.map((f) => f.attempt)).toEqual([1, 2]);
    expect(impl[0]?.answer.reentry_feedback).toBeUndefined();
    // the red test of attempt 1 is told to the agent that does attempt 2
    expect(impl[1]?.answer.reentry_feedback).toContain('"test" failed');
    // every step the agent did has a file
    const attempts = new Set(seen.map((f) => `${f.node}#${f.attempt}`));
    for (const key of ["plan#1", "impl#1", "impl#2", "review#1", "docs#1"]) {
      expect(attempts.has(key), key).toBe(true);
    }
  }, 60_000);
});
