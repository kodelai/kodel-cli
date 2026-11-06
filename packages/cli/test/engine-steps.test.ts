/**
 * Engine steps are off in this build (T-42): no host the CLI builds runs them until the flag is turned on.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { engineStepsRefusal } from "@kodel-ai/local";
import { parsePipeline } from "@kodel-ai/pipeline-core";
import { engineHostOptions, KODEL_ENGINE_STEPS } from "../src/engine-steps";

describe("t42 the flag of engine steps", () => {
  test("t42_cli_flag_off_sets_no_engine_steps", () => {
    expect(KODEL_ENGINE_STEPS).toBe(false);
    expect(engineHostOptions("mcp", { root: "/r" })).toEqual({});
    expect(engineHostOptions("human", { root: "/r" })).toEqual({});
    // it is a constant of the build, never read from the environment
    const source = readFileSync(new URL("../src/engine-steps.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/KODEL_ENGINE_STEPS"\]|\.KODEL_ENGINE_STEPS\b/);
  });

  test("t42_cli_no_engine_steps_with_state_dir", () => {
    for (const role of ["mcp", "human"] as const) {
      const options = engineHostOptions(
        role,
        { root: "/r", environment: { KODEL_STATE_DIR: "/s" } },
        true,
      );
      expect(options.engine).toBeUndefined();
      expect(options.engineSessions).toBeUndefined();
      // and the refusal says why
      const refusal = engineStepsRefusal(
        parsePipeline("name: e\nnodes:\n  - { slug: a, kind: agent, engine: x, prompt: p }\n"),
        { engine: {}, rules: [], platform: "linux", offReason: options.engineStepsOffReason },
      );
      expect(refusal?.message).toContain("KODEL_STATE_DIR is set");
    }
    // an empty value is no base of its own
    expect(
      engineHostOptions("mcp", { root: "/r", environment: { KODEL_STATE_DIR: "" } }, true).engine,
    ).toEqual({ engineSteps: { start: true } });
  });

  test("t42_only_mcp_starts_when_on", () => {
    const mcp = engineHostOptions("mcp", { root: "/r", environment: {} }, true);
    const human = engineHostOptions("human", { root: "/r", environment: {} }, true);
    expect(mcp.engine?.engineSteps).toEqual({ start: true });
    expect(human.engine?.engineSteps).toEqual({ start: false });
    expect(typeof mcp.engineSessions).toBe("function");
  });
});
