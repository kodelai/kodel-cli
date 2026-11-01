import { describe, expect, test } from "bun:test";
import {
  type AgentTurn,
  assistantText,
  branchSettled,
  type ClaimWindow,
  claimWindows,
  completionsPerAttempt,
  entriesOf,
  type JournalRecord,
  kodelArgsOf,
  kodelCommands,
  maxConcurrentClaims,
  nestedAgentCalls,
  orchestratorCalls,
  overlapping,
  type ToolCall,
  toolCallsOfTranscript,
  workerCalls,
} from "./harness";

/** The helpers the fork scenarios judge a real run by, on small hand-made journals and streams. */

const claimed = (
  ts: number,
  node: string,
  by: string,
  extra: JournalRecord = {},
): JournalRecord => ({
  event: "step_claimed",
  ts,
  node,
  attempt: 1,
  by,
  ttl_s: 900,
  ...extra,
});
const completed = (ts: number, node: string, attempt = 1): JournalRecord => ({
  event: "agent_completed",
  ts,
  node,
  attempt,
  outcome: "passed",
});

const span = (start: number, end: number): ClaimWindow => ({
  node: "x",
  attempt: 1,
  by: "m",
  start,
  end,
  completed: true,
});

describe("claim windows from a journal", () => {
  test("t40_harness_claim_windows_end_at_the_hand_in", () => {
    const windows = claimWindows([
      claimed(1_000, "a", "w1"),
      claimed(1_500, "b", "w2"),
      completed(5_000, "a"),
      completed(6_000, "b"),
    ]);
    expect(windows).toEqual([
      { node: "a", attempt: 1, by: "w1", start: 1_000, end: 5_000, completed: true },
      { node: "b", attempt: 1, by: "w2", start: 1_500, end: 6_000, completed: true },
    ]);
  });

  test("t40_harness_renewal_extends_the_window_and_follows_a_new_attempt", () => {
    const windows = claimWindows([
      claimed(0, "a", "w1", { ttl_s: 10 }),
      claimed(8_000, "a", "w1", { ttl_s: 10, renewed: true, attempt: 2 }),
      completed(15_000, "a", 2),
    ]);
    expect(windows).toEqual([
      { node: "a", attempt: 2, by: "w1", start: 0, end: 15_000, completed: true },
    ]);
  });

  test("t40_harness_a_lapsed_claim_ends_at_its_lapse_and_a_new_holder_opens_a_window", () => {
    const records = [
      claimed(0, "b", "ghost", { ttl_s: 30 }),
      claimed(31_000, "b", "w2", { ttl_s: 30 }),
      completed(40_000, "b"),
    ];
    expect(claimWindows(records)).toEqual([
      { node: "b", attempt: 1, by: "ghost", start: 0, end: 30_000, completed: false },
      { node: "b", attempt: 1, by: "w2", start: 31_000, end: 40_000, completed: true },
    ]);
  });

  test("t40_harness_a_claim_never_handed_in_ends_at_its_lapse", () => {
    const windows = claimWindows([claimed(0, "b", "ghost", { ttl_s: 30 }), completed(5_000, "a")]);
    expect(windows).toEqual([
      { node: "b", attempt: 1, by: "ghost", start: 0, end: 30_000, completed: false },
    ]);
  });

  test("t40_harness_a_hand_in_of_another_attempt_does_not_close_the_window", () => {
    const windows = claimWindows([
      claimed(0, "a", "w1"),
      completed(1_000, "a", 2),
      completed(2_000, "a", 1),
    ]);
    expect(windows[0]?.end).toBe(2_000);
  });

  test("t40_harness_a_take_over_closes_the_previous_window", () => {
    const windows = claimWindows([claimed(0, "a", "w1"), claimed(2_000, "a", "w2")]);
    expect(windows.map((w) => [w.by, w.start, w.end, w.completed])).toEqual([
      ["w1", 0, 2_000, false],
      ["w2", 2_000, 902_000, false],
    ]);
  });
});

describe("overlap and concurrency", () => {
  test("t40_harness_overlapping_windows", () => {
    expect(overlapping(span(0, 10), span(5, 15))).toBe(true);
    expect(overlapping(span(5, 15), span(0, 10))).toBe(true);
    expect(overlapping(span(0, 10), span(2, 3))).toBe(true);
    expect(overlapping(span(0, 10), span(10, 20))).toBe(false);
    expect(overlapping(span(0, 10), span(11, 20))).toBe(false);
    expect(overlapping(span(0, Number.POSITIVE_INFINITY), span(100, 200))).toBe(true);
  });

  test("t40_harness_max_concurrent_claims", () => {
    expect(maxConcurrentClaims([])).toBe(0);
    expect(maxConcurrentClaims([span(0, 10), span(10, 20), span(20, 30)])).toBe(1);
    expect(maxConcurrentClaims([span(0, 10), span(5, 20), span(8, 9)])).toBe(3);
    expect(maxConcurrentClaims([span(0, 10), span(5, 20), span(12, 30)])).toBe(2);
  });

  test("t40_harness_sequential_workers_never_overlap_in_a_real_shaped_journal", () => {
    const windows = claimWindows([
      claimed(0, "a", "w1"),
      completed(4_000, "a"),
      claimed(4_000, "b", "w2"),
      completed(9_000, "b"),
    ]);
    expect(maxConcurrentClaims(windows)).toBe(1);
    const [a, b] = windows as [ClaimWindow, ClaimWindow];
    expect(overlapping(a, b)).toBe(false);
  });
});

describe("other journal readings", () => {
  test("t40_harness_completions_per_attempt", () => {
    const counts = completionsPerAttempt([
      completed(1, "a"),
      completed(2, "a"),
      completed(3, "b"),
      completed(4, "b", 2),
      { event: "node_entered", ts: 5, node: "a", attempt: 1 },
    ]);
    expect([...counts]).toEqual([
      ["a#1", 2],
      ["b#1", 1],
      ["b#2", 1],
    ]);
  });

  test("t40_harness_branch_settled_and_entries", () => {
    const records: JournalRecord[] = [
      { event: "node_entered", node: "b", attempt: 1 },
      {
        event: "branch_settled",
        fork: "f1",
        branch: "b",
        node: "b",
        label: "failed",
        failed: true,
        source: "check",
        reason: "x",
      },
      {
        event: "branch_settled",
        fork: "f1",
        branch: "a",
        node: "a",
        label: "passed",
        failed: false,
      },
      { event: "node_entered", node: "b", attempt: 2 },
      {
        event: "branch_settled",
        fork: "f1",
        branch: "c",
        node: "c",
        label: "failed",
        failed: true,
        dead: true,
      },
    ];
    expect(branchSettled(records)).toEqual([
      { fork: "f1", branch: "b", node: "b", label: "failed", failed: true, dead: false },
      { fork: "f1", branch: "a", node: "a", label: "passed", failed: false, dead: false },
      { fork: "f1", branch: "c", node: "c", label: "failed", failed: true, dead: true },
    ]);
    expect(entriesOf(records, "b")).toBe(2);
    expect(entriesOf(records, "a")).toBe(0);
  });
});

describe("what the stream says of subagents", () => {
  const call = (name: string, id: string, parent?: string, input = {}): ToolCall => ({
    name,
    input,
    output: "",
    isError: false,
    id,
    ...(parent === undefined ? {} : { parent }),
  });

  const line = (event: unknown) => JSON.stringify(event);
  const turn = (calls: ToolCall[], stdout = ""): AgentTurn => ({
    sessionId: "s",
    calls,
    responses: [],
    kodelTools: [],
    costUsd: 0,
    finalText: "",
    isError: false,
    transcript: `${stdout}\n--- stderr ---\n`,
  });

  test("t40_harness_groups_calls_under_their_agent_call", () => {
    const calls = [
      call("Agent", "t1", undefined, { subagent_type: "general-purpose" }),
      call("Agent", "t2"),
      call("mcp__kodel__pipeline_take_step", "c1", "t1"),
      call("mcp__kodel__pipeline_take_step", "c2", "t2"),
      call("Task", "c3", "t2"),
      call("mcp__kodel__pipeline_next_step", "c4"),
    ];
    const t = turn(calls);
    expect(orchestratorCalls(t).map((c) => c.id)).toEqual(["t1", "t2", "c4"]);
    const workers = workerCalls(t);
    expect(workers.map((w) => [w.subagentType, w.calls.map((c) => c.id)])).toEqual([
      ["general-purpose", ["c1"]],
      [undefined, ["c2", "c3"]],
    ]);
    expect(nestedAgentCalls(t).map((c) => c.id)).toEqual(["c3"]);
  });

  test("t40_harness_assistant_text_keeps_the_orchestrators_own_words", () => {
    const stdout = [
      line({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "kodel gate approve r --node gate-a" }] },
      }),
      line({
        type: "assistant",
        parent_tool_use_id: "t1",
        message: { content: [{ type: "text", text: "worker words" }] },
      }),
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "x", content: "--node gate-b" }] },
      }),
      "not json",
    ].join("\n");
    const t = turn([], stdout);
    expect(assistantText(t)).toBe("kodel gate approve r --node gate-a");
    expect(assistantText(t, { topLevel: false })).toBe(
      "kodel gate approve r --node gate-a\nworker words",
    );
  });

  test("t40_harness_reads_tool_calls_from_a_subagent_transcript", () => {
    const text = [
      line({
        type: "assistant",
        isSidechain: true,
        message: {
          content: [
            {
              type: "tool_use",
              id: "u1",
              name: "mcp__kodel__pipeline_take_step",
              input: { node_slug: "a" },
            },
          ],
        },
      }),
      line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "u1", content: [{ type: "text", text: "ok" }] },
          ],
        },
      }),
    ].join("\n");
    expect(toolCallsOfTranscript(text)).toEqual([
      {
        name: "mcp__kodel__pipeline_take_step",
        input: { node_slug: "a" },
        output: "ok",
        isError: false,
        id: "u1",
      },
    ]);
  });

  test("t40_harness_reads_kodel_commands_from_shell_lines", () => {
    expect(kodelArgsOf("kodel wait r_1")).toEqual(["wait r_1"]);
    expect(kodelArgsOf("cd /x && kodel wait r_1 & echo started")).toEqual(["wait r_1"]);
    expect(kodelArgsOf("./bin/kodel gate approve r_1 --node a; kodel status")).toEqual([
      "gate approve r_1 --node a",
      "status",
    ]);
    expect(kodelArgsOf("(kodel resume r_1)")).toEqual(["resume r_1"]);
    expect(kodelArgsOf("cat .kodel/runs/r_1/state.json")).toEqual([]);
    expect(kodelArgsOf("echo kodelwait; ls kodel-agent-x")).toEqual([]);
  });

  test("t40_harness_finds_kodel_commands_of_the_agent_and_its_workers", () => {
    const bash = (command: string, parent?: string): ToolCall => ({
      name: "Bash",
      input: { command, run_in_background: true },
      output: "",
      isError: false,
      ...(parent === undefined ? {} : { parent }),
    });
    const calls: ToolCall[] = [
      bash("kodel wait r_1"),
      { name: "Read", input: { file_path: "kodel wait" }, output: "", isError: false },
      bash("kodel gate approve r_1", "agent-1"),
      { name: "Monitor", input: { command: "kodel wait r_1" }, output: "", isError: false },
    ];
    const found = kodelCommands(calls);
    expect(found.map((c) => [c.args, c.index, c.call.parent])).toEqual([
      ["wait r_1", 0, undefined],
      ["gate approve r_1", 2, "agent-1"],
      ["wait r_1", 3, undefined],
    ]);
  });
});
