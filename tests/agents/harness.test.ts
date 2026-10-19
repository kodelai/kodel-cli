import { describe, expect, test } from "bun:test";
import { agentEnv } from "./harness";

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
