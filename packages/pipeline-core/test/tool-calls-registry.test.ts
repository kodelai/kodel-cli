import { describe, expect, test } from "bun:test";
import { HISTORY_TOOL_NAMES, isOwnTool, PIPELINE_TOOL_NAMES } from "../src";
import { decisionTools, HISTORY_TOOLS, TOOLS } from "../src/mcp";

describe("zkrh the list of the engine's own tools", () => {
  test("zkrh_own_tool_names_match_the_registry_including_take_step_and_decision_tools", () => {
    const decider = {
      decideGate: async () => ({ ok: true }),
      acceptChange: async () => ({ ok: true }),
    } as unknown as Parameters<typeof decisionTools>[1];
    const registered = [...TOOLS, ...decisionTools({ gate: true, pipelineChange: true }, decider)]
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("pipeline_"))
      .sort();
    expect([...PIPELINE_TOOL_NAMES].sort()).toEqual(registered);
    expect(PIPELINE_TOOL_NAMES).toContain("pipeline_take_step");
    expect(PIPELINE_TOOL_NAMES).toContain("pipeline_decide_gate");
  });

  test("history_tools_are_own_tools", () => {
    expect([...HISTORY_TOOL_NAMES].sort()).toEqual(HISTORY_TOOLS.map((tool) => tool.name).sort());
    for (const name of HISTORY_TOOL_NAMES) {
      expect(isOwnTool(name)).toBe(true);
      expect(isOwnTool(`mcp__kodel__${name}`)).toBe(true);
    }
    expect(isOwnTool("mcp__kodel__history_other")).toBe(false);
  });
});
