import { describe, expect, test } from "bun:test";
import { agentEnv, agentUsageOf } from "./harness";

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
