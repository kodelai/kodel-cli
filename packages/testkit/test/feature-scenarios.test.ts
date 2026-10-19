import { describe, expect, test } from "bun:test";
import { featureScenarios, loadPipeline, validateScenario } from "../src";

describe("the feature scenarios", () => {
  const spec = loadPipeline({ file: "examples/pipelines/feature.yaml" });

  test("there are scenarios, with unique ids", () => {
    expect(featureScenarios.length).toBeGreaterThanOrEqual(10);
    const ids = featureScenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every scenario is sound against the pipeline it runs on", () => {
    for (const scenario of featureScenarios) {
      expect(validateScenario(scenario, spec), scenario.id).toEqual([]);
    }
  });

  test("the pipeline file the scenarios name is valid", () => {
    expect(spec.name).toBe("feature");
    expect(spec.nodes.some((n) => n.slug === "manual-test")).toBe(true);
  });

  test("the scenarios cover the routes that matter", () => {
    const ids = featureScenarios.map((s) => s.id);
    for (const wanted of [
      "feature/happy-path",
      "feature/test-fails-then-passes",
      "feature/build-exhausts-attempts",
      "feature/review-blocking-then-fixed",
      "feature/manual-test-rejected-new-iteration",
      "feature/interrupted-build-restarts",
      "feature/agent-claims-done-with-a-red-check",
    ]) {
      expect(ids).toContain(wanted);
    }
  });

  test("adversarial scenarios drive the engine through tool calls only", () => {
    const manual = featureScenarios.filter((s) => s.agentMode === "manual");
    expect(manual.length).toBeGreaterThanOrEqual(4);
    for (const s of manual) expect(s.steps.some((x) => x.kind === "tool")).toBe(true);
  });
});
