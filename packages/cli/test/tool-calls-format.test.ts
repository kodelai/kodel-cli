import { describe, expect, test } from "bun:test";
import type { ToolCallsAttempt, ToolCallsReport } from "@kodel-ai/pipeline-core";
import { toolCallsLines } from "../src/format";
import { plain } from "../src/plain";

const attempt = (over: Partial<ToolCallsAttempt> = {}): ToolCallsAttempt => ({
  node: "impl",
  attempt: 1,
  calls: 14,
  by_tool: { Bash: 6, Edit: 4, Read: 3, pipeline_start: 1 },
  failed: 2,
  open: 1,
  shared: 0,
  longest: [{ tool: "Bash", ms: 41_000 }],
  lines: [],
  omitted: 0,
  ...over,
});

const full = (
  over: Partial<Extract<ToolCallsReport, { unverified: true }>> = {},
): ToolCallsReport => ({
  unverified: true,
  attempts: [attempt()],
  rows_cut: false,
  skipped: 0,
  unjoined: 0,
  complete: true,
  failed: [],
  ...over,
});

describe("zkrh the block of tool calls in the report", () => {
  test("zkrh_report_block_text", () => {
    const lines = toolCallsLines(full(), plain);
    expect(lines[0]).toBe("tool calls (what the agent's own log says; not verified):");
    expect(lines[1]).toBe(
      "  impl #1: 14 call(s) (Bash 6, Edit 4, Read 3, pipeline_start 1), 2 failed, 1 open; longest: Bash 41 s",
    );
  });

  test("zkrh_report_says_what_is_never_recorded", () => {
    const text = toolCallsLines(full(), plain).join("\n");
    expect(text).toContain("final response of the last step");
    expect(text).toContain("says nothing of whether its step passed");
  });

  test("zkrh_report_marks_shared_cut_skipped_unjoined_and_incomplete", () => {
    const text = toolCallsLines(
      full({
        attempts: [attempt({ shared: 3 })],
        rows_cut: true,
        skipped: 2,
        unjoined: 4,
        complete: false,
        failed: ["busy"],
      }),
      plain,
    ).join("\n");
    expect(text).toContain("3 shared with another open step");
    expect(text).toContain("rows were left out for want of room");
    expect(text).toContain("2 line(s) of the log were over the limit");
    expect(text).toContain("4 result(s) have no call");
    expect(text).toContain("not read to its end yet");
    expect(text).toContain("not recorded: busy");
  });

  test("zkrh_report_reasons", () => {
    expect(toolCallsLines({ not_collected: true, reason: "session_unknown" }, plain)).toEqual([
      "tool calls: not_collected (session_unknown)",
    ]);
    expect(toolCallsLines({ cannot_read: true, format: "7" }, plain)).toEqual([
      "tool calls: cannot read (written in format 7, upgrade kodel)",
    ]);
    expect(toolCallsLines(undefined, plain)).toEqual([]);
  });

  test("zkrh_report_unattributed_calls_are_outside_every_step", () => {
    const text = toolCallsLines(
      full({
        unattributed: attempt({
          node: undefined,
          attempt: undefined,
          calls: 2,
          by_tool: { Bash: 2 },
          failed: 0,
          open: 0,
          longest: [],
        }),
      }),
      plain,
    ).join("\n");
    expect(text).toContain("outside every step: 2 call(s) (Bash 2)");
  });

  test("zkrh_more_than_six_tools_are_counted_together", () => {
    const byTool = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`T${i}`, 10 - i]));
    const text = toolCallsLines(full({ attempts: [attempt({ by_tool: byTool })] }), plain)[1];
    expect(text).toContain("T0 10, T1 9, T2 8, T3 7, T4 6, T5 5, 9 more");
  });

  test("zkrh_escapes_plain", () => {
    // names come from the agent's own log: an escape, an OSC 8 link, a bidi mark and a carriage return never reach a terminal
    const hostile = "Ba\u001b[31msh\u001b]8;;http://x\u0007‮\r";
    const text = toolCallsLines(
      full({
        attempts: [
          attempt({
            node: "im\u001bpl",
            by_tool: { [hostile]: 1 },
            longest: [{ tool: hostile, ms: 1000 }],
          }),
        ],
        failed: [hostile],
      }),
      plain,
    ).join("\n");
    for (const char of ["\u001b", "\u0007", "\r", "\u202e"])
      expect(text.includes(char)).toBe(false);
  });

  test("zkrh_report_marks_own_calls_and_shows_servers", () => {
    const line = (tool: string, over: Record<string, unknown> = {}) => ({
      id: `id-${tool}`,
      tool,
      started: "2026-10-21T10:00:00.000Z",
      ...over,
    });
    const text = toolCallsLines(
      full({
        attempts: [
          attempt({
            lines: [
              line("pipeline_start", { own: true, server: "kodel" }),
              line("pipeline_start", { own: true, server: "claude_ai_Kodel" }),
              line("Bash"),
            ] as ToolCallsAttempt["lines"],
          }),
        ],
      }),
      plain,
    ).join("\n");
    expect(text).toContain("2 of the engine's own");
    expect(text).toContain("MCP: kodel, claude_ai_Kodel");
  });
});
