import { describe, expect, test } from "bun:test";
import { HISTORY_TOOL_NAMES, isOwnTool, PIPELINE_TOOL_NAMES } from "../src";
import { decisionTools, HISTORY_TOOLS, TOOLS, toolsFor } from "../src/mcp";

describe("zkrh the list of the engine's own tools", () => {
  test("zkrh_own_tool_names_match_the_registry_including_take_step_and_decision_tools", () => {
    const decider = {
      decideGate: async () => ({ ok: true }),
      acceptChange: async () => ({ ok: true }),
    } as unknown as Parameters<typeof decisionTools>[1];
    const pipelineNames = (tools: { name: string }[]) =>
      tools.map((tool) => tool.name).filter((name) => name.startsWith("pipeline_"));
    // The list is every name a host may register: whatever a host registers is in it (a host that
    // keeps no attachments and serves no decisions registers fewer), and a host with everything on
    // registers all of it.
    for (const name of pipelineNames(TOOLS)) expect(PIPELINE_TOOL_NAMES).toContain(name);
    const everything = pipelineNames([
      ...toolsFor({ taskLink: true, attachments: true }),
      ...decisionTools({ gate: true, pipelineChange: true }, decider),
    ]).sort();
    expect([...PIPELINE_TOOL_NAMES].sort()).toEqual(everything);
    expect(PIPELINE_TOOL_NAMES).toContain("pipeline_take_step");
    expect(PIPELINE_TOOL_NAMES).toContain("pipeline_decide_gate");
    expect(PIPELINE_TOOL_NAMES).toContain("pipeline_attachment_write");
    expect(isOwnTool("mcp__kodel__pipeline_attachment_read")).toBe(true);
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
