import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AgentHistoryCollector,
  type CallRow,
  defaultAgentLog,
  defaultHistory,
  defaultToolCalls,
  defaultUsage,
  type HistoryConfig,
  type JournalRecord,
  type RunState,
  type ToolCallsConfig,
  type ToolCallsPayload,
  toolCallsReport,
} from "@kodel-ai/pipeline-core";
import { ClaudeLogBuilder } from "../../testkit/src";
import {
  FileStore,
  LocalPipelineHost,
  type LocalRun,
  proveRunStart,
  RunStartCache,
  type RunStartMemo,
  ToolCallsWriter,
} from "../src";
import { claudeCodeCollector } from "../src/history/claude-code/collector";

const SESSION = "66666666-6666-4666-8666-666666666666";
const T0 = Date.parse("2026-10-21T10:00:00.000Z");

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
/** The time the host and the pass see; the log is stamped from `T0` on, so the test moves this to where the log is. */
let nowMs: number;
beforeEach(async () => {
  nowMs = T0;
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-tool-calls-run-")));
  claude = join(dir, "..", `claude-tc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "two.yaml"), PIPELINE);
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(claude, { recursive: true, force: true });
});

interface RigOptions {
  /** A task of its own, so that a second run in one test is not the first one picked up again. */
  task?: string;
  toolCalls?: Partial<ToolCallsConfig> | null;
  agentLog?: boolean;
  usage?: boolean;
  session?: string | null;
  collector?: (configDir: string) => AgentHistoryCollector;
  budgetMs?: number;
  now?: () => number;
}

interface Rig {
  host: LocalPipelineHost;
  run: LocalRun;
  runId: string;
  writer: ToolCallsWriter;
  store: FileStore;
  env: NodeJS.ProcessEnv;
}

const historyOf = (options: RigOptions): HistoryConfig => ({
  ...defaultHistory(),
  agent_log: { ...defaultAgentLog(), enabled: options.agentLog !== false, interval_s: 0 },
  usage: { ...defaultUsage(), enabled: options.usage !== false },
  ...(options.toolCalls === null
    ? {}
    : { tool_calls: { ...defaultToolCalls(), ...options.toolCalls } }),
});

async function rig(options: RigOptions = {}): Promise<Rig> {
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude };
  if (options.session !== null) env["CLAUDE_CODE_SESSION_ID"] = options.session ?? SESSION;
  const writer = new ToolCallsWriter({
    root: dir,
    rules: [],
    env: () => env,
    now: options.now ?? (() => nowMs),
    ...(options.collector === undefined ? {} : { collector: options.collector }),
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  });
  const store = new FileStore({ root: join(dir, ".kodel") });
  const host = new LocalPipelineHost({
    root: dir,
    heartbeatMs: 0,
    clock: () => nowMs,
    environment: env,
    history: historyOf(options),
    toolCalls: writer,
  });
  const started = await host.start({ pipeline: "two", task: options.task ?? "t", restart: false });
  const run = started.run as LocalRun;
  return { host, run, runId: run.runId, writer, store, env };
}

/** What the log holds up to the response of step a that is still being written. */
function sessionLog(runId: string): ClaudeLogBuilder {
  const log = new ClaudeLogBuilder({
    sessionId: SESSION,
    cwd: dir,
    start: new Date(T0).toISOString(),
  });
  log
    .user("please run the pipeline")
    .call("msg_0", { id: "toolu_start", name: "mcp__kodel__pipeline_start", input: { task: "t" } })
    .result("toolu_start", [{ type: "text", text: JSON.stringify({ ok: true, run_id: runId }) }])
    .call("msg_1", { id: "toolu_bash", name: "Bash", input: { command: "ls -la" } })
    .wait(400)
    .result("toolu_bash", "total 0")
    .call("msg_2", {
      id: "toolu_done_a",
      name: "mcp__kodel__pipeline_complete_step",
      input: { run_id: runId, node_slug: "a", attempt: 1 },
    });
  return log;
}

const install = (log: ClaudeLogBuilder) => log.install(claude);
const stateOf = (r: Rig): Promise<RunState> => r.run.state();
const journalOf = (r: Rig): Promise<JournalRecord[]> => r.store.readJournal(r.runId);
const recordsOf = async (r: Rig): Promise<JournalRecord[]> =>
  (await journalOf(r)).filter((rec) => rec.event === "tool_calls_recorded");
const rowsOf = async (r: Rig): Promise<ToolCallsPayload["rows"]> =>
  (await recordsOf(r)).flatMap((rec) => (rec["calls"] as ToolCallsPayload).rows);
const callsOf = async (r: Rig): Promise<CallRow[]> =>
  (await rowsOf(r)).filter((row): row is CallRow => row.k === "c");
const failuresOf = async (r: Rig): Promise<string[]> =>
  (await journalOf(r))
    .filter((rec) => rec.event === "tool_calls_failed")
    .map((rec) => String(rec["reason"]));
const reportOf = async (r: Rig) => toolCallsReport(await stateOf(r), await journalOf(r));

/** The time `ms` after the last line of the log, so that the pass of the step that follows is after what the log holds. */
const after = (log: ClaudeLogBuilder, ms = 500): number => {
  const last = log.lines[log.lines.length - 1] ?? "{}";
  return Date.parse((JSON.parse(last) as { timestamp: string }).timestamp) + ms;
};

describe("zkrh the pass that records tool calls", () => {
  test("zkrh_call_and_result_rows_join_by_id", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    await install(log);
    nowMs = after(log);
    await r.run.completeStep("a", 1);
    const report = await reportOf(r);
    if (!("attempts" in report))
      throw new Error(`${JSON.stringify(report)} ${await failuresOf(r)}`);
    const attempt = report.attempts.find((a) => a.node === "a" && a.attempt === 1);
    expect(attempt, JSON.stringify(report)).toBeDefined();
    const bash = attempt?.lines.find((l) => l.tool === "Bash");
    expect(bash).toMatchObject({ ok: true, in_bytes: Buffer.byteLength('{"command":"ls -la"}') });
    expect(bash?.ms).toBeGreaterThanOrEqual(400);
    // the call that hands the step in is not released yet: it comes with the next pass
    expect(attempt?.lines.some((l) => l.tool === "pipeline_complete_step")).toBe(false);
  });

  test("zkrh_hand_in_call_recorded_at_next_pass_with_result", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await install(log);
    nowMs = after(log);
    await r.run.completeStep("a", 1);
    // the result of the hand-in and the first response of step b are written after the pass
    log
      .wait(3000)
      .result("toolu_done_a", "{}")
      .call("msg_3", {
        id: "toolu_edit",
        name: "Edit",
        input: { file_path: "/x" },
      });
    log
      .wait(300)
      .result("toolu_edit", "edited")
      .call("msg_4", {
        id: "toolu_done_b",
        name: "mcp__kodel__pipeline_complete_step",
        input: { node_slug: "b", attempt: 1 },
      });
    await writeFile(path, log.text());
    nowMs = after(log, 2000);
    await r.run.completeStep("b", 1);
    const report = await reportOf(r);
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    const a = report.attempts.find((x) => x.node === "a");
    const b = report.attempts.find((x) => x.node === "b");
    // the hand-in call started in step a and is placed there although the pass of step b read it
    expect(a?.lines.find((l) => l.tool === "pipeline_complete_step")).toMatchObject({
      own: true,
      ok: true,
    });
    expect(b?.lines.map((l) => l.tool)).toEqual(["Edit"]);
    // nothing is recorded twice
    const ids = (await callsOf(r)).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("zkrh_own_calls_are_flagged_by_name_and_show_the_server", async () => {
    const r = await rig();
    await install(sessionLog(r.runId));
    nowMs = T0 + 2000;
    await r.run.completeStep("a", 1);
    const calls = await callsOf(r);
    const own = calls.find((c) => c.tool === "pipeline_start");
    expect(own).toMatchObject({ own: true, server: "kodel" });
    expect(calls.find((c) => c.tool === "Bash")?.own).toBeUndefined();
  });

  test("zkrh_works_with_agent_log_off_and_usage_off_and_stores_no_preview", async () => {
    const r = await rig({ agentLog: false, usage: false });
    await install(sessionLog(r.runId));
    nowMs = T0 + 2000;
    await r.run.completeStep("a", 1);
    const calls = await callsOf(r);
    expect(calls.map((c) => c.tool)).toContain("Bash");
    // the agent's text is not kept, so no preview of a call's input is either; the sizes are
    for (const call of calls) expect(call.preview).toBeUndefined();
    expect(calls.find((c) => c.tool === "Bash")?.in_bytes).toBeGreaterThan(0);
    expect((await stateOf(r)).usage).toBeUndefined();
  });

  test("zkrh_previews_only_when_agent_log_full", async () => {
    const r = await rig({ toolCalls: { preview_chars: 8 } });
    await install(sessionLog(r.runId));
    nowMs = T0 + 2000;
    await r.run.completeStep("a", 1);
    const bash = (await callsOf(r)).find((c) => c.tool === "Bash");
    expect(bash?.preview).toBeDefined();
    expect((bash?.preview ?? "").length).toBeLessThanOrEqual(8);
    const none = await rig({ task: "second", toolCalls: { preview_chars: 0 } });
    await install(sessionLog(none.runId));
    nowMs = T0 + 2000;
    await none.run.completeStep("a", 1);
    for (const call of await callsOf(none)) expect(call.preview).toBeUndefined();
  });

  test("zkrh_switch_off_builds_no_collector_and_reads_nothing", async () => {
    let built = 0;
    const r = await rig({
      toolCalls: { enabled: false },
      collector: (configDir) => {
        built += 1;
        return claudeCodeCollector({ configDir });
      },
    });
    await install(sessionLog(r.runId));
    nowMs = T0 + 2000;
    await r.run.completeStep("a", 1);
    expect(built).toBe(0);
    expect((await stateOf(r)).toolCalls).toBeUndefined();
    expect(await recordsOf(r)).toHaveLength(0);
    expect(await reportOf(r)).toEqual({ not_collected: true, reason: "disabled" });
  });

  test("zkrh_not_captured_for_a_run_without_the_key", async () => {
    const r = await rig({ toolCalls: null });
    await install(sessionLog(r.runId));
    nowMs = T0 + 2000;
    await r.run.completeStep("a", 1);
    expect(await recordsOf(r)).toHaveLength(0);
    expect(await reportOf(r)).toEqual({ not_collected: true, reason: "not_captured" });
  });

  test("zkrh_config_edit_mid_run_keeps_the_frozen_value", async () => {
    const r = await rig();
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      "worktree:\n  mode: off\nhistory:\n  tool_calls:\n    enabled: false\n",
    );
    await install(sessionLog(r.runId));
    nowMs = T0 + 2000;
    await r.run.completeStep("a", 1);
    expect((await recordsOf(r)).length).toBeGreaterThan(0);
  });

  test("zkrh_cursor_skips_recorded_after_restart", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    await install(log);
    nowMs = T0 + 2000;
    await r.run.completeStep("a", 1);
    const before = (await callsOf(r)).length;
    // a new process: the writer remembers nothing, the state has the cursor
    const again = new ToolCallsWriter({
      root: dir,
      rules: [],
      env: () => r.env,
      now: () => nowMs,
    });
    await again.capture(
      {
        runId: r.runId,
        state: () => r.run.state(),
        apply: (event) => r.run.apply(event),
        workdir: async () => undefined,
        journal: () => journalOf(r),
      },
      { node: "b", attempt: 1 },
      { stillHeld: async () => true },
    );
    expect((await callsOf(r)).length).toBe(before);
  });

  test("zkrh_failure_said_once_and_session_unknown_reason", async () => {
    const r = await rig({ session: null });
    nowMs = T0 + 2000;
    await r.run.completeStep("a", 1);
    nowMs = T0 + 4000;
    await r.run.completeStep("b", 1);
    expect(await failuresOf(r)).toEqual(["session_unknown"]);
    expect(await reportOf(r)).toEqual({ not_collected: true, reason: "session_unknown" });
  });

  test("zkrh_failed_result_has_its_error_type", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    log
      .call("msg_2", { id: "toolu_w", name: "Write", input: { file_path: "/y" } })
      .result("toolu_w", "PreToolUse:Write hook error: blocked", true)
      .call("msg_3", { id: "toolu_x", name: "Bash", input: { command: "rm" } });
    await install(log);
    nowMs = after(log);
    await r.run.completeStep("a", 1);
    const report = await reportOf(r);
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    const write = report.attempts[0]?.lines.find((l) => l.tool === "Write");
    expect(write).toMatchObject({ ok: false, err: "hook_blocked" });
    expect(report.attempts[0]?.failed).toBe(1);
  });

  test("zkrh_line_over_8mb_skipped_and_counted", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await install(log);
    await appendFile(path, `${"x".repeat(9 * 1024 * 1024)}\n`);
    nowMs = after(log);
    await r.run.completeStep("a", 1);
    const records = await recordsOf(r);
    const skipped = records.reduce(
      (sum, rec) => sum + ((rec["calls"] as ToolCallsPayload).skipped ?? 0),
      0,
    );
    expect(skipped).toBeGreaterThanOrEqual(1);
    const report = await reportOf(r);
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    expect(report.skipped).toBeGreaterThanOrEqual(1);
  });

  test("zkrh_subagent_rows_are_marked_with_the_log_id", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await install(log);
    const child = new ClaudeLogBuilder({
      sessionId: "agent-abc1",
      cwd: dir,
      start: new Date(T0 + 150).toISOString(),
    });
    child
      .user("look into it")
      .call("sub_0", { id: "toolu_sub", name: "Grep", input: { pattern: "x" } })
      .result("toolu_sub", "found")
      .call("sub_1", { id: "toolu_sub2", name: "Read", input: { file_path: "/z" } });
    const subPath = join(dirname(path), SESSION, "subagents", "agent-abc1.jsonl");
    await mkdir(dirname(subPath), { recursive: true });
    await writeFile(subPath, child.text());
    nowMs = after(log);
    await r.run.completeStep("a", 1);
    const calls = await callsOf(r);
    expect(calls.find((c) => c.tool === "Grep")).toMatchObject({ subagent: "agent-abc1" });
    expect(calls.find((c) => c.tool === "Bash")?.subagent).toBeUndefined();
  });

  test("zkrh_tool_calls_failure_leaves_the_usage_record_intact", async () => {
    const r = await rig({
      collector: () => {
        throw new Error("a reader that breaks");
      },
    });
    await install(sessionLog(r.runId));
    nowMs = T0 + 2000;
    await r.run.completeStep("a", 1);
    // the step went on and usage recorded what it read
    const state = await stateOf(r);
    expect(state.usage).toBeDefined();
    expect(await recordsOf(r)).toHaveLength(0);
    const events = (await journalOf(r)).map((rec) => rec.event);
    expect(events).toContain("agent_completed");
  });

  test("zkrh_pass_runs_after_usage_and_before_judging", async () => {
    const r = await rig();
    await install(sessionLog(r.runId));
    nowMs = T0 + 2000;
    await r.run.completeStep("a", 1);
    const events = (await journalOf(r)).map((rec) => rec.event);
    expect(events.indexOf("tool_calls_recorded")).toBeGreaterThan(-1);
    expect(events.indexOf("tool_calls_recorded")).toBeLessThan(events.indexOf("agent_completed"));
  });

  test("zkrh_state_and_journal_agree", async () => {
    const r = await rig();
    await install(sessionLog(r.runId));
    nowMs = T0 + 2000;
    await r.run.completeStep("a", 1);
    const records = await recordsOf(r);
    const state = (await stateOf(r)).toolCalls;
    expect(state?.events).toBe(records.length);
    const last = records[records.length - 1];
    expect(state?.sessions[SESSION]?.last_seq).toBe(
      (last?.["cursor"] as { last_seq: number } | undefined)?.last_seq,
    );
  });

  test("zkrh_budget_stop_then_next_pass_catches_up_each_call_once", async () => {
    // the first pass runs out of time after a few entries; the next one reads on and nothing is recorded twice
    let reads = 0;
    let limited = true;
    const r = await rig({
      budgetMs: 5_000,
      now: () => {
        if (!limited) return nowMs;
        reads += 1;
        return reads < 5 ? T0 : T0 + 1_000_000;
      },
    });
    const log = sessionLog(r.runId);
    const path = await install(log);
    nowMs = after(log);
    await r.run.completeStep("a", 1);
    const first = await stateOf(r);
    expect(Object.values(first.toolCalls?.sessions ?? {}).some((c) => c.behind === true)).toBe(
      true,
    );
    limited = false;
    log
      .wait(3000)
      .result("toolu_done_a", "{}")
      .call("msg_3", {
        id: "toolu_edit",
        name: "Edit",
        input: { file_path: "/x" },
      });
    await writeFile(path, log.text());
    nowMs = after(log, 2000);
    await r.run.completeStep("b", 1);
    const ids = (await callsOf(r)).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const tools = (await callsOf(r)).map((c) => c.tool);
    expect(tools).toEqual(
      expect.arrayContaining(["pipeline_start", "Bash", "pipeline_complete_step"]),
    );
    const report = await reportOf(r);
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    expect(report.complete).toBe(true);
  });
});

describe("zkrh what is found about where a run begins is shared", () => {
  test("zkrh_run_start_memo_shared_no_double_scan", async () => {
    const r = await rig();
    const path = await install(sessionLog(r.runId));
    const cache = new RunStartCache();
    const first = { path };
    const second = { path };
    expect(await proveRunStart(r.runId, first, cache)).toBe(true);
    // the second writer is told what the first found, and no search of its own is needed to know it
    expect(await proveRunStart(r.runId, second, cache)).toBe(true);
    expect(second).toEqual(first);
    // a log that has no call of the run is not searched again until it grows, whoever asks
    const none = { path: join(dirname(path), "no-such-run.jsonl") };
    await writeFile(none.path, "{}\n");
    const a: RunStartMemo = { path: none.path };
    const b: RunStartMemo = { path: none.path };
    expect(await proveRunStart(r.runId, a, cache)).toBe(false);
    expect(await proveRunStart(r.runId, b, cache)).toBe(false);
    expect(b.start).toBeNull();
    cache.forget(r.runId);
    expect(cache.get(r.runId, path)).toBeUndefined();
  });
});
