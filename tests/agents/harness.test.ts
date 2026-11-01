import { describe, expect, test } from "bun:test";
import { agentEnv, agentUsageOf, comparableSum, responsesOf, windowUsage } from "./harness";

describe("the environment the agent under test gets", () => {
  test("carries nothing that could start these scenarios again inside the sandbox", () => {
    const env = agentEnv("/state", {
      PATH: "/bin",
      KODEL_AGENT_TESTS: "1",
      KODEL_AGENT_KEEP: "1",
      KODEL_AGENT_VERBOSE: "1",
      KODEL_AGENT_MODEL: "opus",
    });
    expect(Object.keys(env).filter((k) => k.startsWith("KODEL_AGENT_"))).toEqual([]);
    expect(env.PATH).toBe("/bin");
  });

  test("points the server at the shared directory of trusted hashes", () => {
    expect(agentEnv("/state", {}).KODEL_STATE_DIR).toBe("/state");
    expect(agentEnv("/state", { KODEL_STATE_DIR: "/other" }).KODEL_STATE_DIR).toBe("/state");
  });
});

describe("the agent's own count of its use", () => {
  test("t9jrs_harness_reads_usage_and_model_usage_of_the_result", () => {
    const usage = agentUsageOf({
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
      modelUsage: {
        "claude-sonnet-5-5": {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 40,
          costUSD: 0.5,
        },
      },
    });
    expect(usage).toEqual({
      total: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
      models: {
        "claude-sonnet-5-5": { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, usd: 0.5 },
      },
    });
  });

  test("t9jrs_harness_has_no_usage_when_the_result_has_none", () => {
    expect(agentUsageOf({})).toBeUndefined();
  });

  test("t9jrs_harness_ignores_what_is_not_a_count", () => {
    const usage = agentUsageOf({
      usage: { input_tokens: "many", output_tokens: -3 },
      modelUsage: { m: { inputTokens: Number.NaN } },
    });
    expect(usage?.total).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(usage?.models["m"]?.input).toBe(0);
  });
});

/** A recorded-shape stream: one `assistant` event per content block, the usage of a message grows while it streams. */
const event = (id: string, usage: [number, number, number, number], blocks: unknown[]) =>
  JSON.stringify({
    type: "assistant",
    message: {
      id,
      usage: {
        input_tokens: usage[0],
        output_tokens: usage[1],
        cache_read_input_tokens: usage[2],
        cache_creation_input_tokens: usage[3],
      },
      content: blocks,
    },
  });
const tool = (name: string) => ({ type: "tool_use", id: `t_${name}`, name, input: {} });
const SAMPLE = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
  // before the run: a tool search with the big first cache write
  event("m1", [4, 50, 1000, 9000], [tool("ToolSearch")]),
  JSON.stringify({ type: "user", message: { content: [] } }),
  event("m2", [1, 10, 9000, 100], [tool("mcp__kodel__pipeline_list")]),
  // the run: pipeline_start in a response of two blocks, the first with a smaller usage
  event("m3", [1, 5, 9100, 50], [{ type: "text", text: "starting" }]),
  event("m3", [1, 30, 9100, 50], [tool("mcp__kodel__pipeline_start")]),
  event("m4", [1, 20, 9200, 60], [tool("Write")]),
  event("m5", [2, 40, 9300, 70], [tool("mcp__kodel__pipeline_complete_step")]),
  // after the run: a background watch and the final answer
  event("m6", [3, 90, 9400, 80], [tool("Bash")]),
  event("m7", [1, 200, 9500, 90], [{ type: "text", text: "done" }]),
  "not json",
].join("\n");

describe("the agent's own account of the responses of a turn", () => {
  test("t9jrs_harness_folds_the_stream_to_one_response_per_message_id_with_its_tools", () => {
    const responses = responsesOf(SAMPLE);
    expect(responses.map((r) => r.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
    const m3 = responses.find((r) => r.id === "m3");
    // the last usage of the id wins, the tools of all its events are kept
    expect(m3?.usage).toEqual({ input: 1, output: 30, cacheRead: 9100, cacheWrite: 50 });
    expect(m3?.tools).toEqual(["mcp__kodel__pipeline_start"]);
  });

  test("t9jrs_harness_sums_the_window_from_pipeline_start_to_the_last_complete_step_inclusive", () => {
    const total = windowUsage(responsesOf(SAMPLE), "pipeline_start", "pipeline_complete_step");
    // m3 + m4 + m5; not the tool search and the list before, not the watch and the answer after
    expect(total).toEqual({ input: 4, output: 90, cacheRead: 27600, cacheWrite: 180 });
  });

  test("t9jrs_harness_compares_input_cache_read_and_cache_write_only_never_output", () => {
    // the stream's output_tokens is a streamed placeholder: the sum that is held to a tolerance leaves it out
    expect(comparableSum({ input: 4, output: 90, cacheRead: 27600, cacheWrite: 180 })).toBe(27784);
    expect(comparableSum({ input: 4, output: 9_000_000, cacheRead: 27600, cacheWrite: 180 })).toBe(
      27784,
    );
  });

  test("t9jrs_harness_has_no_window_without_a_start_or_with_the_end_before_it", () => {
    expect(windowUsage(responsesOf(SAMPLE), "pipeline_start", "no_such_tool")).toBeUndefined();
    expect(
      windowUsage(responsesOf(SAMPLE), "no_such_tool", "pipeline_complete_step"),
    ).toBeUndefined();
    expect(
      windowUsage(responsesOf(SAMPLE), "pipeline_complete_step", "pipeline_start"),
    ).toBeUndefined();
    expect(windowUsage([], "pipeline_start", "pipeline_complete_step")).toBeUndefined();
  });

  test("t9jrs_harness_takes_the_last_complete_step_when_a_step_is_redone", () => {
    const redone = [
      event("a", [1, 10, 100, 10], [tool("mcp__kodel__pipeline_start")]),
      event("b", [1, 10, 100, 10], [tool("mcp__kodel__pipeline_complete_step")]),
      event("c", [1, 10, 100, 10], [tool("Edit")]),
      event("d", [1, 10, 100, 10], [tool("mcp__kodel__pipeline_complete_step")]),
      event("e", [9, 9, 9, 9], [{ type: "text", text: "end" }]),
    ].join("\n");
    expect(windowUsage(responsesOf(redone), "pipeline_start", "pipeline_complete_step")).toEqual({
      input: 4,
      output: 40,
      cacheRead: 400,
      cacheWrite: 40,
    });
  });
});
