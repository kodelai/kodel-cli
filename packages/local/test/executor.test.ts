import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineService, toolsFingerprint } from "@kodel-ai/pipeline-core";
import {
  CONTRACT_VERSION,
  registerPipelineTools,
  SERVER_INSTRUCTIONS,
  TOOLS,
} from "@kodel-ai/pipeline-core/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LocalPipelineHost } from "../src";
import { projectFolderName } from "../src/history/claude-code/locate";

const PIPELINE = [
  "name: two",
  "nodes:",
  "  - slug: a",
  "    kind: agent",
  "    prompt: do a",
  "  - slug: b",
  "    kind: agent",
  "    prompt: do b",
  "edges:",
  "  - { from: a, to: b }",
  "",
].join("\n");

let dir: string;
let claude: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-executor-"));
  claude = await mkdtemp(join(tmpdir(), "kodel-claude-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "two.yaml"), PIPELINE);
  await setConfig("");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(claude, { recursive: true, force: true });
});

// The runs of these tests work in the root: the worktree is tested in worktree.test.ts.
const setConfig = (history: string) =>
  writeFile(join(dir, ".kodel", "config.yaml"), `worktree:\n  mode: off\n${history}`);

const BUILD = { version: "1.2.3", commit: "abc123def456" };

const newHost = (over: { version?: string; environment?: NodeJS.ProcessEnv } = {}) =>
  new LocalPipelineHost({
    root: dir,
    heartbeatMs: 0,
    build: { ...BUILD, version: over.version ?? BUILD.version },
    environment: over.environment ?? { CLAUDE_CONFIG_DIR: claude },
  });

async function connect(host: LocalPipelineHost, client = { name: "agent", version: "9.1.0" }) {
  const server = new McpServer({ name: "kodel-test", version: "0.0.0" });
  const service = new PipelineService(host, {
    waitBudgetMs: 10_000,
    caller: () => {
      const seen = server.server.getClientVersion();
      return seen === undefined ? undefined : { name: seen.name, version: seen.version };
    },
    surface: {
      instructions: SERVER_INSTRUCTIONS,
      tools: toolsFingerprint(TOOLS),
      contract_version: CONTRACT_VERSION,
    },
  });
  registerPipelineTools(server, service);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client(client);
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    return JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
  };
  return { call, close: () => Promise.all([mcp.close(), server.close()]) };
}

interface Sourced<T> {
  value: T;
  source: string;
}
interface Rec {
  event: string;
  engine_version?: string;
  engine: {
    version: string;
    commit: string;
    record_version: number;
    contract_version: number;
    instructions_hash: string;
    tools_hash: string;
  };
  executor: {
    client?: Sourced<{ name: string; version: string }>;
    session?: Sourced<string>;
    model?: Sourced<string>;
  };
}

const records = async (host: LocalPipelineHost, runId: string) => {
  const journal = ((await (await host.open(runId))?.journal()) ?? []) as unknown as Rec[];
  return {
    started: journal.find((r) => r.event === "run_started"),
    completed: journal.filter((r) => r.event === "agent_completed"),
    text: JSON.stringify(journal),
  };
};

const startRun = async (call: Awaited<ReturnType<typeof connect>>["call"]) => {
  const started = await call("pipeline_start", { task: "t5btp", pipeline: "two" });
  return started.run_id as string;
};

const transcript = (session: string, lines: unknown[]) =>
  mkdir(join(claude, "projects", projectFolderName(dir)), { recursive: true }).then(() =>
    writeFile(
      join(claude, "projects", projectFolderName(dir), `${session}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    ),
  );

describe("who ran the run", () => {
  test("t5btp_run_started_records_the_client_of_the_handshake_and_the_engine", async () => {
    const host = newHost();
    const { call, close } = await connect(host);
    const runId = await startRun(call);
    const { started } = await records(host, runId);
    expect(started?.executor).toEqual({
      client: { value: { name: "agent", version: "9.1.0" }, source: "observed" },
    });
    expect(started?.engine).toMatchObject({
      version: "1.2.3",
      commit: "abc123def456",
      record_version: 1,
      contract_version: CONTRACT_VERSION,
    });
    expect(started?.engine.instructions_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(started?.engine.tools_hash).toMatch(/^[0-9a-f]{64}$/);
    await close();
  });

  test("t5btp_the_session_comes_from_the_environment_and_is_left_out_when_there_is_none", async () => {
    const withEnv = newHost({
      environment: { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: "s-1" },
    });
    const first = await connect(withEnv);
    const a = await records(withEnv, await startRun(first.call));
    expect(a.started?.executor.session).toEqual({ value: "s-1", source: "observed-env" });
    await first.close();

    await setConfig("");
    const without = newHost();
    const second = await connect(without);
    const started = await second.call("pipeline_start", { task: "another", pipeline: "two" });
    const b = await records(without, started.run_id);
    expect(b.started?.executor).not.toHaveProperty("session");
    await second.close();
  });

  test("t5btp_the_session_comes_from_the_hook_index_when_the_environment_has_none", async () => {
    await writeFile(
      join(dir, ".kodel", "sessions.jsonl"),
      [
        { session_id: "old", agent: "claude-code", cwd: dir, ts: "2026-01-01T00:00:00.000Z" },
        {
          session_id: "elsewhere",
          agent: "claude-code",
          cwd: tmpdir(),
          ts: "2026-01-02T00:00:00.000Z",
        },
        { session_id: "hooked", agent: "claude-code", cwd: dir, ts: "2026-01-03T00:00:00.000Z" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    const host = newHost();
    const { call, close } = await connect(host);
    const { started } = await records(host, await startRun(call));
    expect(started?.executor.session).toEqual({ value: "hooked", source: "observed-hook" });
    await close();
  });

  test("t5btp_the_model_is_read_from_the_session_log_and_marked_derived", async () => {
    await transcript("s-2", [
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "assistant", message: { role: "assistant", model: "claude-test-1" } },
      { type: "assistant", message: { role: "assistant", model: "<synthetic>" } },
      "not json",
    ]);
    const host = newHost({
      environment: { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: "s-2" },
    });
    const { call, close } = await connect(host);
    const { started } = await records(host, await startRun(call));
    expect(started?.executor.model).toEqual({ value: "claude-test-1", source: "derived" });
    await close();
  });

  test("t5btp_no_log_means_no_model_never_a_guess", async () => {
    const host = newHost({
      environment: { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: "missing" },
    });
    const { call, close } = await connect(host);
    const { started } = await records(host, await startRun(call));
    expect(started?.executor).not.toHaveProperty("model");
    await close();
  });

  test("t5btp_a_client_without_a_name_gives_no_client_record", async () => {
    const host = newHost();
    const { call, close } = await connect(host, { name: "\u0000\n", version: "1" });
    const { started } = await records(host, await startRun(call));
    expect(started?.executor).toEqual({});
    await close();
  });
});

describe("who completed each step", () => {
  test("t5btp_two_clients_in_one_run_give_two_executor_records", async () => {
    const host = newHost();
    const one = await connect(host, { name: "claude-code", version: "2.0.0" });
    const runId = await startRun(one.call);
    await one.call("pipeline_complete_step", { run_id: runId, node_slug: "a", attempt: 1 });
    await one.close();

    const two = await connect(host, { name: "codex", version: "0.5.0" });
    await two.call("pipeline_complete_step", { run_id: runId, node_slug: "b", attempt: 1 });
    await two.close();

    const { completed } = await records(host, runId);
    expect(completed.map((r) => r.executor.client?.value.name)).toEqual(["claude-code", "codex"]);
    expect(completed.every((r) => r.executor.client?.source === "observed")).toBe(true);
  });

  test("t5btp_an_engine_upgraded_between_steps_records_both_versions", async () => {
    const before = newHost({ version: "1.0.0" });
    const first = await connect(before);
    const runId = await startRun(first.call);
    await first.call("pipeline_complete_step", { run_id: runId, node_slug: "a", attempt: 1 });
    await first.close();

    const after = newHost({ version: "2.0.0" });
    const second = await connect(after);
    await second.call("pipeline_complete_step", { run_id: runId, node_slug: "b", attempt: 1 });
    await second.close();

    const { started, completed } = await records(after, runId);
    expect(started?.engine.version).toBe("1.0.0");
    expect(completed[0]).not.toHaveProperty("engine_version");
    expect(completed[1]?.engine_version).toBe("2.0.0");
  });

  test("t5btp_a_claimed_executor_in_the_arguments_is_ignored", async () => {
    const host = newHost();
    const { call, close } = await connect(host);
    const runId = await startRun(call);
    await call("pipeline_complete_step", {
      run_id: runId,
      node_slug: "a",
      attempt: 1,
      executor: { model: "claimed-model-x" },
      model: "claimed-model-y",
    });
    const { text } = await records(host, runId);
    expect(text).not.toContain("claimed-model");
    await close();
  });
});

describe("hostile values", () => {
  test("t5btp_control_characters_are_removed_and_a_huge_name_is_cut", async () => {
    const host = newHost();
    const { call, close } = await connect(host, {
      name: `ag\u0000e\u001bn\nt${"x".repeat(1_000_000)}`,
      version: "1 .0",
    });
    const { started } = await records(host, await startRun(call));
    const client = started?.executor.client?.value;
    expect(client?.name?.length).toBeLessThanOrEqual(200);
    expect(client?.name?.startsWith("agent")).toBe(true);
    expect(client?.version).toBe("1.0");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test is about them
    expect(/[\u0000-\u001f]/.test(JSON.stringify(client))).toBe(false);
    await close();
  });

  test("t5btp_a_secret_in_a_client_name_does_not_reach_the_history", async () => {
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
    const host = newHost();
    const { call, close } = await connect(host, { name: `agent ${secret}`, version: "1" });
    const { text } = await records(host, await startRun(call));
    expect(text).not.toContain(secret);
    await close();
  });
});

describe("the switch history.executor", () => {
  test("t5btp_with_history_executor_off_nothing_is_recorded", async () => {
    await setConfig("history:\n  executor:\n    enabled: false\n");
    const host = newHost({
      environment: { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: "s-3" },
    });
    const { call, close } = await connect(host);
    const runId = await startRun(call);
    await call("pipeline_complete_step", { run_id: runId, node_slug: "a", attempt: 1 });
    const { started, completed, text } = await records(host, runId);
    expect(started).not.toHaveProperty("executor");
    expect(started).not.toHaveProperty("engine");
    expect(completed[0]).not.toHaveProperty("executor");
    expect(text).not.toContain("s-3");
    expect(text).not.toContain("9.1.0");
    await close();
  });
});
