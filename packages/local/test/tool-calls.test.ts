import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  ROW_ID,
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
  rowId,
  ToolCallsWriter,
  UsageWriter,
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
/** The run as the pass sees it, for a test that calls the writer itself. */
const runOf = (
  r: Rig,
  apply: (event: Parameters<LocalRun["apply"]>[0]) => ReturnType<LocalRun["apply"]> = (event) =>
    r.run.apply(event),
) => ({
  runId: r.runId,
  state: () => r.run.state(),
  apply,
  workdir: async () => undefined,
  journal: () => journalOf(r),
});
const held = { stillHeld: async () => true };

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

  test("zkrh_cursor_skips_recorded_after_restart_and_the_hand_in_call_comes_with_the_next_pass", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await install(log);
    nowMs = after(log);
    await r.run.completeStep("a", 1);
    const before = (await callsOf(r)).length;
    // a new process: the writer remembers nothing, the state has the cursor; the log has grown meanwhile
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
    const again = new ToolCallsWriter({ root: dir, rules: [], env: () => r.env, now: () => nowMs });
    await again.capture(runOf(r), { node: "b", attempt: 1 }, { stillHeld: async () => true });
    const calls = await callsOf(r);
    const ids = calls.map((c) => c.id);
    // nothing is recorded twice, the earlier rows are not read again, and the hand-in call of step a is in
    expect(new Set(ids).size).toBe(ids.length);
    expect(calls.length).toBeGreaterThan(before);
    expect(calls.filter((c) => c.tool === "pipeline_complete_step")).toHaveLength(1);
    expect(calls.find((c) => c.tool === "Edit")).toMatchObject({ node: "b", attempt: 1 });
    expect(calls.find((c) => c.tool === "pipeline_complete_step")).toMatchObject({
      node: "a",
      attempt: 1,
    });
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

describe("zkrh the pass, what the review asked for", () => {
  test("zkrh_truncated_or_rotated_log", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await install(log);
    nowMs = after(log);
    await r.run.completeStep("a", 1);
    const before = (await callsOf(r)).length;
    // the log is replaced by a shorter one: it is not the log the cursor was made against
    const short = new ClaudeLogBuilder({
      sessionId: SESSION,
      cwd: dir,
      start: new Date(T0).toISOString(),
    });
    short.user("please run the pipeline");
    await writeFile(path, short.text());
    nowMs = after(log, 5000);
    await r.run.completeStep("b", 1);
    expect(await failuresOf(r)).toContain("unreadable");
    expect((await callsOf(r)).length).toBe(before);
    expect(await reportOf(r)).toMatchObject({ unverified: true });
  });

  test("zkrh_a_call_started_during_the_pass_is_left_for_the_next_pass", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    // a worker goes on writing: this call starts 30 s after the pass began
    log
      .wait(3000)
      .result("toolu_done_a", "{}")
      .wait(30_000)
      .call("msg_3", { id: "toolu_late", name: "Edit", input: { file_path: "/x" } })
      .result("toolu_late", "edited")
      .call("msg_4", {
        id: "toolu_done_b",
        name: "mcp__kodel__pipeline_complete_step",
        input: { node_slug: "b", attempt: 1 },
      });
    await install(log);
    const first = T0 + 4000;
    nowMs = first;
    await r.run.completeStep("a", 1);
    expect((await callsOf(r)).some((c) => c.tool === "Edit")).toBe(false);
    const state = await stateOf(r);
    expect(Object.values(state.toolCalls?.sessions ?? {}).every((c) => c.behind === true)).toBe(
      true,
    );
    const report = await reportOf(r);
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    expect(report.complete).toBe(false);
    // the next pass reads it again, places it and records it once
    nowMs = first + 120_000;
    await r.run.completeStep("b", 1);
    const edits = (await callsOf(r)).filter((c) => c.tool === "Edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ node: "b", attempt: 1 });
    const done = await reportOf(r);
    if (!("attempts" in done)) throw new Error(JSON.stringify(done));
    expect(done.complete).toBe(true);
  });

  test("zkrh_failing_usage_does_not_stop_the_pass", async () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: SESSION };
    const broken = new UsageWriter({
      root: dir,
      rules: [],
      env: () => env,
      collector: () => {
        throw new Error("a reader that breaks");
      },
    });
    const writer = new ToolCallsWriter({ root: dir, rules: [], env: () => env, now: () => nowMs });
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      clock: () => nowMs,
      environment: env,
      history: historyOf({}),
      usage: broken,
      toolCalls: writer,
    });
    const run = (await host.start({ pipeline: "two", task: "t", restart: false })).run as LocalRun;
    await install(sessionLog(run.runId));
    nowMs = T0 + 2000;
    await run.completeStep("a", 1);
    const store = new FileStore({ root: join(dir, ".kodel") });
    const journal = await store.readJournal(run.runId);
    expect(journal.some((rec) => rec.event === "tool_calls_recorded")).toBe(true);
    expect(journal.some((rec) => rec.event === "agent_completed")).toBe(true);
  });

  test("zkrh_forget_at_run_end", async () => {
    // the host lets go of what the writer kept for a run when the run ends, and not before
    const forgotten: string[] = [];
    class Spy extends ToolCallsWriter {
      override forget(runId: string): void {
        forgotten.push(runId);
        super.forget(runId);
      }
    }
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: SESSION };
    const spy = new Spy({ root: dir, rules: [], env: () => env, now: () => nowMs });
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      clock: () => nowMs,
      environment: env,
      history: historyOf({}),
      toolCalls: spy,
    });
    const run = (await host.start({ pipeline: "two", task: "t", restart: false })).run as LocalRun;
    const log = sessionLog(run.runId);
    const path = await install(log);
    nowMs = after(log);
    await run.completeStep("a", 1);
    expect(forgotten).toEqual([]);
    log
      .wait(3000)
      .result("toolu_done_a", "{}")
      .call("msg_3", {
        id: "toolu_done_b",
        name: "mcp__kodel__pipeline_complete_step",
        input: { node_slug: "b", attempt: 1 },
      });
    await writeFile(path, log.text());
    nowMs = after(log, 2000);
    await run.completeStep("b", 1);
    expect((await run.state()).status).toBe("completed");
    expect(forgotten).toEqual([run.runId]);
  });

  test("zkrh_more_than_32_distinct_tools_fold_into_other_counts_exact", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    for (let i = 0; i < 40; i++) {
      log
        .call(`msg_t${i}`, { id: `toolu_t${i}`, name: `Tool${i}`, input: { n: i } })
        .result(`toolu_t${i}`, "ok");
    }
    log.call("msg_last", { id: "toolu_last", name: "Bash", input: { command: "true" } });
    await install(log);
    nowMs = after(log);
    await r.run.completeStep("a", 1);
    const counts: Record<string, number> = {};
    for (const rec of await recordsOf(r)) {
      const per = (rec["calls"] as ToolCallsPayload).counts;
      for (const tools of Object.values(per)) {
        for (const [tool, n] of Object.entries(tools)) counts[tool] = (counts[tool] ?? 0) + n;
      }
    }
    expect(Object.keys(counts).length).toBeLessThanOrEqual(33);
    expect(counts["other"]).toBeGreaterThanOrEqual(1);
    // exact: every call the log holds before the open response is counted once
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe((await callsOf(r)).length);
  });

  test("zkrh_interrupted_and_refused_own_call_end_to_end", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    log
      .call("msg_x", { id: "toolu_int", name: "Bash", input: { command: "sleep 99" } })
      .result("toolu_int", "[Request interrupted by user for tool use]", true)
      .call("msg_y", {
        id: "toolu_refused",
        name: "mcp__kodel__pipeline_report_result",
        input: { rows: [] },
      })
      .result("toolu_refused", '{ "ok": false, "code": "MISSING_REQUIRED_VALUE" }', true)
      .call("msg_z", { id: "toolu_end", name: "Read", input: { file_path: "/q" } });
    await install(log);
    nowMs = after(log);
    await r.run.completeStep("a", 1);
    const report = await reportOf(r);
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    const lines = report.attempts[0]?.lines ?? [];
    expect(lines.find((l) => l.tool === "Bash" && l.err !== undefined)).toMatchObject({
      ok: false,
      err: "interrupted",
    });
    expect(lines.find((l) => l.tool === "pipeline_report_result")).toMatchObject({
      own: true,
      ok: false,
      err: "error",
    });
  });

  test("zkrh_preview_is_redacted_in_journal_and_error_type_never_in_the_agent_log_copy", async () => {
    const r = await rig();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const log = sessionLog(r.runId);
    log
      .call("msg_s", { id: "toolu_s", name: "Bash", input: { command: `export T=${token}` } })
      .result("toolu_s", "denied", true)
      .call("msg_e", { id: "toolu_e", name: "Read", input: { file_path: "/q" } });
    await install(log);
    nowMs = after(log);
    await r.run.completeStep("a", 1);
    const journal = await readFile(join(dir, ".kodel", "runs", r.runId, "journal.jsonl"), "utf8");
    expect(journal).not.toContain(token);
    expect(journal).not.toContain(token.slice(0, 12));
    expect(journal).toContain("export T=");
    // the stored copy of the agent's log never has the fields only this pass asks for
    const copy = await readFile(
      join(dir, ".kodel", "runs", r.runId, "agent_log", `${SESSION}.jsonl`),
      "utf8",
    );
    expect(copy).not.toContain("error_type");
    expect(copy).not.toContain("input_bytes");
  });

  test("zkrh_ids_hash_from_session_and_raw_id_and_are_stable", () => {
    expect(rowId("s1", "toolu_a")).toBe(rowId("s1", "toolu_a"));
    expect(rowId("s1", "toolu_a")).not.toBe(rowId("s2", "toolu_a"));
    expect(rowId("s1", "toolu_a")).not.toBe(rowId("s1", "toolu_b"));
    expect(rowId("s1", "toolu_a")).toMatch(ROW_ID);
  });

  test("zkrh_dedupe_across_sidechain_and_subagent_files", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    log
      .call("msg_d", { id: "toolu_dup", name: "Grep", input: { pattern: "x" } })
      .result("toolu_dup", "found")
      .call("msg_e", { id: "toolu_e", name: "Read", input: { file_path: "/q" } });
    const path = await install(log);
    const child = new ClaudeLogBuilder({
      sessionId: "agent-dup1",
      cwd: dir,
      start: new Date(T0 + 150).toISOString(),
    });
    child
      .user("look into it")
      .call("sub_0", { id: "toolu_dup", name: "Grep", input: { pattern: "x" } })
      .result("toolu_dup", "found")
      .call("sub_1", { id: "toolu_sub_end", name: "Read", input: { file_path: "/z" } });
    const subPath = join(dirname(path), SESSION, "subagents", "agent-dup1.jsonl");
    await mkdir(dirname(subPath), { recursive: true });
    await writeFile(subPath, child.text());
    nowMs = after(log);
    await r.run.completeStep("a", 1);
    expect((await callsOf(r)).filter((c) => c.tool === "Grep")).toHaveLength(1);
  });

  test("zkrh_subagent_that_began_before_the_run_takes_no_slot_and_one_without_a_time_is_said", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await install(log);
    const before = new ClaudeLogBuilder({
      sessionId: "agent-old1",
      cwd: dir,
      start: new Date(T0 - 60_000).toISOString(),
    });
    before
      .user("old")
      .call("old_0", { id: "toolu_old", name: "Glob", input: {} })
      .result("toolu_old", "x");
    const dirOf = join(dirname(path), SESSION, "subagents");
    await mkdir(dirOf, { recursive: true });
    await writeFile(join(dirOf, "agent-old1.jsonl"), before.text());
    await writeFile(
      join(dirOf, "agent-notime.jsonl"),
      `${JSON.stringify({ type: "user", message: { role: "user", content: "no time" } })}\n`,
    );
    nowMs = after(log);
    await r.run.completeStep("a", 1);
    expect((await callsOf(r)).some((c) => c.tool === "Glob")).toBe(false);
    expect(await failuresOf(r)).toContain("unreadable");
  });

  test("zkrh_more_than_200_rows_make_several_records_and_a_refused_one_loses_none", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    for (let i = 0; i < 150; i++) {
      log
        .call(`msg_b${i}`, { id: `toolu_b${i}`, name: "Bash", input: { n: i } })
        .result(`toolu_b${i}`, "ok");
    }
    log.call("msg_end", { id: "toolu_end", name: "Read", input: { file_path: "/q" } });
    await install(log);
    nowMs = after(log);
    // the run refuses the second record of the pass: the cursor stays at the first one and says it is not at the end
    let seen = 0;
    const writer = new ToolCallsWriter({
      root: dir,
      rules: [],
      env: () => r.env,
      now: () => nowMs,
    });
    await writer.capture(
      runOf(r, async (event) => {
        if (event.type === "tool_calls_recorded") {
          seen += 1;
          if (seen === 2) {
            return { ok: true, noop: true } as unknown as Awaited<ReturnType<LocalRun["apply"]>>;
          }
        }
        return r.run.apply(event);
      }),
      { node: "a", attempt: 1 },
      held,
    );
    expect(await failuresOf(r)).toContain("record_refused");
    const partial = (await stateOf(r)).toolCalls?.sessions[SESSION];
    expect(partial?.behind).toBe(true);
    const rowsSoFar = (await rowsOf(r)).length;
    expect(rowsSoFar).toBeLessThanOrEqual(200);
    // a later pass (a new process) records the rest, each call once
    const again = new ToolCallsWriter({ root: dir, rules: [], env: () => r.env, now: () => nowMs });
    await again.capture(runOf(r), { node: "a", attempt: 1 }, held);
    const calls = await callsOf(r);
    const ids = calls.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    // the 150 of the loop and the one of the base log
    expect(calls.filter((c) => c.tool === "Bash")).toHaveLength(151);
    // the first part of 200 rows, then (the second was refused) the rest written by the later pass
    expect((await recordsOf(r)).length).toBe(2);
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
