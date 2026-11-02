import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
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
import { engineRecord, FileStore, LocalPipelineHost, logFacts, modelFromLog } from "../src";
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
    session_name?: Sourced<string>;
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
      record_version: 2,
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

describe("what the host will not trust or cannot read", () => {
  test("t5btp_a_directory_the_agent_names_does_not_choose_the_session", async () => {
    const other = await mkdtemp(join(tmpdir(), "kodel-other-"));
    await writeFile(
      join(dir, ".kodel", "sessions.jsonl"),
      `${JSON.stringify({ session_id: "theirs", agent: "claude-code", cwd: other, ts: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    const host = newHost();
    const { call, close } = await connect(host);
    const started = await call("pipeline_start", { task: "t", pipeline: "two", cwd: other });
    const { started: record } = await records(host, started.run_id);
    expect(record?.executor).not.toHaveProperty("session");
    await close();
    await rm(other, { recursive: true, force: true });
  });

  test("t5btp_a_session_id_that_is_not_an_id_is_never_put_into_a_path", async () => {
    await transcript("x", [{ type: "assistant", message: { model: "claude-test-1" } }]);
    const host = newHost({
      environment: { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: "../x" },
    });
    const { call, close } = await connect(host);
    const { started } = await records(host, await startRun(call));
    expect(started?.executor).not.toHaveProperty("model");
    await close();
  });

  test("t5btp_a_config_dir_that_cannot_be_read_does_not_fail_the_start", async () => {
    const host = newHost({
      environment: { CLAUDE_CONFIG_DIR: "/dev/null/nope\u0000", CLAUDE_CODE_SESSION_ID: "s-9" },
    });
    const { call, close } = await connect(host);
    const runId = await startRun(call);
    const { started } = await records(host, runId);
    expect(started?.executor.client?.value.name).toBe("agent");
    await close();
  });

  test("t5btp_the_model_follows_the_log_when_the_log_grows", async () => {
    await transcript("s-5", [{ type: "assistant", message: { model: "claude-test-1" } }]);
    const path = join(claude, "projects", projectFolderName(dir), "s-5.jsonl");
    expect(await modelFromLog(path)).toBe("claude-test-1");
    await writeFile(
      path,
      `${JSON.stringify({ type: "assistant", message: { model: "claude-test-1" } })}\n${JSON.stringify({ type: "assistant", message: { model: "claude-test-2" } })}\n`,
    );
    expect(await modelFromLog(path)).toBe("claude-test-2");
  });

  test("t5btp_without_what_the_agent_was_served_the_engine_record_has_no_hashes", () => {
    const record = engineRecord(BUILD, undefined);
    expect(record).toEqual({
      version: "1.2.3",
      commit: "abc123def456",
      record_version: 2,
      meta_version: 2,
    });
  });

  test("t5btp_a_run_with_executor_records_is_reported_like_any_other", async () => {
    const host = newHost({
      environment: { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: "s-6" },
    });
    const { call, close } = await connect(host);
    const runId = await startRun(call);
    await call("pipeline_complete_step", { run_id: runId, node_slug: "a", attempt: 1 });
    const report = await (await host.open(runId))?.report();
    expect(report?.runId).toBe(runId);
    await close();
  });
});

// The shapes below are the ones Claude Code writes in a session log (checked on real logs, 2026-11):
// a rename adds a `custom-title` record followed by an `agent-name` record with the same text, and an
// automatic session has an `agent-name` that equals its `ai-title`.
const SID = "s-name";
const custom = (title: string, session = SID) => ({
  type: "custom-title",
  customTitle: title,
  sessionId: session,
});
const shown = (name: string, session = SID) => ({
  type: "agent-name",
  agentName: name,
  sessionId: session,
});
const aiTitle = (title: string, session = SID) => ({
  type: "ai-title",
  aiTitle: title,
  sessionId: session,
});
const logPath = (session: string) =>
  join(claude, "projects", projectFolderName(dir), `${session}.jsonl`);
const namedHost = (session = SID) =>
  newHost({ environment: { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: session } });

describe("the name of the session", () => {
  test("session_label_recorded_on_the_records", async () => {
    await transcript(SID, [custom("fix the list"), shown("fix the list")]);
    const host = namedHost();
    const { call, close } = await connect(host);
    const runId = await startRun(call);
    await call("pipeline_next_step", { run_id: runId });
    await call("pipeline_complete_step", { run_id: runId, node_slug: "a", attempt: 1 });
    const journal = ((await (await host.open(runId))?.journal()) ?? []) as unknown as Rec[];
    const named = (event: string) =>
      journal.filter((r) => r.event === event).map((r) => r.executor?.session_name);
    const expected = { value: "fix the list", source: "derived" };
    expect(named("run_started")).toEqual([expected]);
    expect(named("step_served")[0]).toEqual(expected);
    expect(named("agent_completed")[0]).toEqual(expected);
    await close();
  });

  test("session_label_name_rule_prefers_the_last_custom_title", async () => {
    await transcript(SID, [custom("first"), shown("first"), custom("second"), shown("auto name")]);
    expect((await logFacts(logPath(SID), SID)).name).toBe("second");
  });

  test("session_label_name_rule_skips_a_cleared_custom_title", async () => {
    await transcript(SID, [custom("kept"), custom("  "), shown("auto name")]);
    expect((await logFacts(logPath(SID), SID)).name).toBe("kept");
  });

  test("session_label_name_rule_uses_agent_name_without_a_custom_title", async () => {
    await transcript(SID, [shown("older"), aiTitle("older"), shown("newer")]);
    expect((await logFacts(logPath(SID), SID)).name).toBe("newer");
  });

  test("session_label_name_rule_falls_back_to_ai_title_alone", async () => {
    // an automatic session of Claude Code may have only this record (seen on a real log, 2026-11-02)
    await transcript(SID, [aiTitle("a summary of the first prompt")]);
    expect((await logFacts(logPath(SID), SID)).name).toBe("a summary of the first prompt");
  });

  test("session_label_name_rule_ranks_the_three_kinds", async () => {
    // the newest of a kind counts; an older custom-title beats a newer agent-name, which beats an ai-title
    await transcript(SID, [aiTitle("old summary"), shown("shown"), aiTitle("new summary")]);
    expect((await logFacts(logPath(SID), SID)).name).toBe("shown");
    await transcript(SID, [custom("chosen"), shown("shown"), aiTitle("new summary")]);
    expect((await logFacts(logPath(SID), SID)).name).toBe("chosen");
    await transcript(SID, [aiTitle("old summary"), aiTitle("new summary")]);
    expect((await logFacts(logPath(SID), SID)).name).toBe("new summary");
    await transcript(SID, [aiTitle("   ")]);
    expect((await logFacts(logPath(SID), SID)).name).toBeUndefined();
    await transcript(SID, [aiTitle("theirs", "other")]);
    expect((await logFacts(logPath(SID), SID)).name).toBeUndefined();
  });

  test("session_label_name_rule_ignores_other_session_ids", async () => {
    await transcript(SID, [custom("theirs", "other"), shown("theirs", "other"), shown("mine")]);
    expect((await logFacts(logPath(SID), SID)).name).toBe("mine");
    expect((await logFacts(logPath(SID), "other")).name).toBe("theirs");
  });

  test("session_label_a_name_before_the_tail_is_not_found_and_is_no_error", async () => {
    const filler = { type: "user", message: { content: "x".repeat(700 * 1024) } };
    await transcript(SID, [custom("too far back"), filler]);
    expect(await logFacts(logPath(SID), SID)).toEqual({ model: undefined, name: undefined });
  });

  test("session_label_the_model_scan_is_unchanged", async () => {
    await mkdir(join(claude, "projects", projectFolderName(dir)), { recursive: true });
    await writeFile(
      logPath(SID),
      `{"type": "assistant", "message": {"model": "claude-spaced"}}\n${JSON.stringify(shown("n"))}\n`,
    );
    expect(await logFacts(logPath(SID), SID)).toEqual({ model: "claude-spaced", name: "n" });
    expect(await modelFromLog(logPath(SID))).toBe("claude-spaced");
  });

  test("session_label_failures_leave_no_name", async () => {
    expect(await logFacts(logPath("missing"), "missing")).toEqual({
      model: undefined,
      name: undefined,
    });
    await mkdir(logPath("a-directory"), { recursive: true });
    expect((await logFacts(logPath("a-directory"), "a-directory")).name).toBeUndefined();
    await transcript(SID, [{ type: "user" }]);
    expect((await logFacts(logPath(SID), SID)).name).toBeUndefined();
    await mkdir(join(claude, "projects", projectFolderName(dir)), { recursive: true });
    await writeFile(
      logPath("torn"),
      `${JSON.stringify(shown("kept", "torn"))}\n{"type":"agent-name","ag`,
    );
    expect((await logFacts(logPath("torn"), "torn")).name).toBe("kept");
  });

  test("session_label_cache_key_has_the_session_id", async () => {
    await transcript(SID, [shown("mine"), shown("theirs", "other")]);
    expect((await logFacts(logPath(SID), SID)).name).toBe("mine");
    expect((await logFacts(logPath(SID), "other")).name).toBe("theirs");
  });

  test("session_label_cache_hit_returns_the_name", async () => {
    await transcript(SID, [shown("old name")]);
    const path = logPath(SID);
    expect((await logFacts(path, SID)).name).toBe("old name");
    const { mtime } = await stat(path);
    // The same size and the same mtime: the file is taken to be as it was.
    await writeFile(path, `${JSON.stringify(shown("new name"))}\n`);
    await utimes(path, mtime, mtime);
    expect((await logFacts(path, SID)).name).toBe("old name");
  });

  test("session_label_cache_follows_a_change_of_size", async () => {
    await transcript(SID, [shown("old name")]);
    expect((await logFacts(logPath(SID), SID)).name).toBe("old name");
    await transcript(SID, [shown("old name"), shown("a longer new name")]);
    expect((await logFacts(logPath(SID), SID)).name).toBe("a longer new name");
  });

  test("session_label_cache_follows_a_change_of_mtime", async () => {
    await transcript(SID, [shown("old name")]);
    const path = logPath(SID);
    expect((await logFacts(path, SID)).name).toBe("old name");
    await writeFile(path, `${JSON.stringify(shown("new name"))}\n`);
    await utimes(path, new Date(2030, 0, 1), new Date(2030, 0, 1));
    expect((await logFacts(path, SID)).name).toBe("new name");
  });

  test("session_label_follows_a_rename_at_the_next_record", async () => {
    await transcript(SID, [shown("before")]);
    const host = namedHost();
    const { call, close } = await connect(host);
    const runId = await startRun(call);
    await transcript(SID, [shown("before"), custom("after the rename"), shown("after the rename")]);
    await call("pipeline_complete_step", { run_id: runId, node_slug: "a", attempt: 1 });
    const { started, completed } = await records(host, runId);
    expect(started?.executor.session_name?.value).toBe("before");
    expect(completed[0]?.executor.session_name?.value).toBe("after the rename");
    await close();
  });

  test("session_label_model_and_name_are_searched_independently", async () => {
    // The hook names one file for the session; the store holds another: each value comes from the first
    // file that has it.
    await transcript("elsewhere", [{ type: "assistant", message: { model: "claude-test-1" } }]);
    await transcript(SID, [shown("from the store")]);
    await writeFile(
      join(dir, ".kodel", "sessions.jsonl"),
      `${JSON.stringify({ session_id: SID, agent: "claude-code", cwd: dir, transcript_path: logPath("elsewhere"), ts: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    const host = namedHost();
    const { call, close } = await connect(host);
    const { started } = await records(host, await startRun(call));
    expect(started?.executor.model).toEqual({ value: "claude-test-1", source: "derived" });
    expect(started?.executor.session_name).toEqual({ value: "from the store", source: "derived" });
    await close();
  });

  test("session_label_name_is_cleaned_then_redacted", async () => {
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
    const hostile = `\u202etitle\u200b\u0000 ${secret} ${"y".repeat(300)}`;
    await transcript(SID, [custom(hostile)]);
    const host = namedHost();
    const { call, close } = await connect(host);
    const { started, text } = await records(host, await startRun(call));
    expect(text).not.toContain(secret);
    const name = started?.executor.session_name?.value ?? "";
    expect(name.startsWith("title")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(120);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test is about them
    expect(/[\u0000-\u001f\u200b\u202e]/.test(name)).toBe(false);
    await close();
  });

  test("session_label_unsafe_session_id_reads_no_file", async () => {
    // `../x` would land on this decoy if the id were put into a path.
    await mkdir(join(claude, "projects"), { recursive: true });
    await writeFile(
      join(claude, "projects", "x.jsonl"),
      `${JSON.stringify(shown("decoy", "../x"))}\n`,
    );
    const host = namedHost("../x");
    const { call, close } = await connect(host);
    const { started } = await records(host, await startRun(call));
    expect(started?.executor).not.toHaveProperty("session_name");
    await close();
  });

  test("session_label_records_what_it_recorded_for_an_id_too_long_for_the_name", async () => {
    const long = "s".repeat(129);
    await transcript(long, [
      { type: "assistant", message: { model: "claude-test-1" } },
      shown("never read", long),
    ]);
    const host = namedHost(long);
    const { call, close } = await connect(host);
    const { started } = await records(host, await startRun(call));
    expect(started?.executor.session?.value).toBe(long);
    expect(started?.executor.model?.value).toBe("claude-test-1");
    expect(started?.executor).not.toHaveProperty("session_name");
    await close();
  });

  test("session_label_absent_when_executor_history_is_off", async () => {
    await setConfig("history:\n  executor:\n    enabled: false\n");
    await transcript(SID, [shown("must not appear")]);
    const host = namedHost();
    const { call, close } = await connect(host);
    const runId = await startRun(call);
    await call("pipeline_next_step", { run_id: runId });
    await call("pipeline_complete_step", { run_id: runId, node_slug: "a", attempt: 1 });
    const { text } = await records(host, runId);
    expect(text).not.toContain("must not appear");
    expect(text).not.toContain("session_name");
    await close();
  });
});

describe("the name of the session: what the log really looks like", () => {
  test("session_label_reads_the_records_of_a_real_log", async () => {
    // fixtures/claude-code-names.jsonl keeps the shape of the records Claude Code 2.1.316 wrote on
    // 2026-11-01 (a session named automatically, then renamed); the ids and the titles are made up. A change in the
    // shape shows here first.
    const id = "11111111-1111-4111-8111-111111111111";
    await mkdir(join(claude, "projects", projectFolderName(dir)), { recursive: true });
    await copyFile(
      new URL("./fixtures/claude-code-names.jsonl", import.meta.url).pathname,
      logPath(id),
    );
    expect((await logFacts(logPath(id), id)).name).toBe("wait timeout");
  });

  test("session_label_a_secret_across_the_cut_is_redacted_whole", async () => {
    // The name is cut at 120 characters; the secret starts before the cut and ends after it, and must be
    // redacted before the cut, or half of it stays.
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
    await transcript(SID, [custom(`${"a".repeat(100)} ${secret} tail`)]);
    const host = namedHost();
    const { call, close } = await connect(host);
    const { started, text } = await records(host, await startRun(call));
    expect(text).not.toContain("sk-ant");
    expect(text).not.toContain("abcdefghij");
    expect(started?.executor.session_name?.value.startsWith("aaaa")).toBe(true);
    await close();
  });

  test("session_label_a_cut_never_splits_a_character", async () => {
    await transcript(SID, [custom(`${"a".repeat(119)}\u{1F600}\u{1F600}`)]);
    const host = namedHost();
    const { call, close } = await connect(host);
    const { started } = await records(host, await startRun(call));
    const name = started?.executor.session_name?.value ?? "";
    expect([...name].length).toBe(120);
    expect(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(name),
    ).toBe(false);
    await close();
  });
});

describe("an event the running engine does not know", () => {
  test("t41_unknown_event_is_ignored_by_the_running_engine", async () => {
    // A later engine may journal an event this one has no name for. The state decides every step and the
    // journal is only appended to, so the run must report, answer and go on as if it were not there.
    const host = newHost();
    const { call, close } = await connect(host);
    const runId = await startRun(call);
    const run = await host.open(runId);
    const journal = (await run?.journal()) ?? [];
    const last = journal.at(-1);
    const before = {
      report: JSON.stringify(await run?.report()),
      inspect: JSON.stringify(await run?.inspect()),
      next: JSON.stringify(await call("pipeline_next_step", { run_id: runId })),
    };
    await new FileStore({ root: join(dir, ".kodel") }).appendJournal(runId, [
      { v: 2, seq: last?.seq ?? 1, ts: last?.ts ?? 0, event: "event_of_a_later_engine", n: 1 },
    ]);
    // read back, listed, reported, asked for the next step, completed: nothing notices it
    expect(((await run?.journal()) ?? []).some((r) => r.event === "event_of_a_later_engine")).toBe(
      true,
    );
    expect(JSON.stringify(await run?.report())).toBe(before.report);
    expect(JSON.stringify(await run?.inspect())).toBe(before.inspect);
    expect(JSON.stringify(await call("pipeline_next_step", { run_id: runId }))).toBe(before.next);
    expect((await host.runSummaries()).map((r) => r.meta.runId)).toContain(runId);
    const done = await call("pipeline_complete_step", {
      run_id: runId,
      node_slug: "a",
      attempt: 1,
    });
    expect(done.ok).toBe(true);
    expect(done.next?.node?.slug).toBe("b");
    await close();
  });
});
