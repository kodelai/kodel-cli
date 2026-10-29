import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type AgentHistoryCollector,
  buildDelta,
  defaultAgentLog,
  defaultHistory,
  defaultPricing,
  defaultUsage,
  type HistoryConfig,
  type JournalRecord,
  type RedactRule,
  type RunState,
  runTotals,
  summarizeCost,
  tokensOf,
  type UsageConfig,
} from "@kodel-ai/pipeline-core";
import { ClaudeLogBuilder } from "../../testkit/src";
import {
  type AgentLogRun,
  AgentLogWriter,
  FileStore,
  LocalPipelineHost,
  type LocalRun,
  UsageWriter,
} from "../src";
import { claudeCodeCollector } from "../src/history/claude-code/collector";

const SESSION = "55555555-5555-4555-8555-555555555555";

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
/** Links to `dir` made by a test, removed with it. */
let links: string[] = [];
beforeEach(async () => {
  links = [];
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-usage-run-")));
  claude = join(dir, "..", `claude-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  for (const link of links) await rm(link, { force: true });
  await rm(dir, { recursive: true, force: true });
  await rm(claude, { recursive: true, force: true });
});

interface RigOptions {
  /** A task of its own, so that a second run in one test is not the first one picked up again. */
  task?: string;
  rules?: RedactRule[];
  toolLog?: boolean;
  usage?: Partial<UsageConfig> | null;
  collector?: (configDir: string) => AgentHistoryCollector;
  agentLog?: boolean;
  /** Reach the project through a link to it (`/var` against `/private/var` on macOS): the agent's folder is the real one's. */
  viaLink?: boolean;
  session?: string | null;
  budgetMs?: number;
  now?: () => number;
}

interface Rig {
  host: LocalPipelineHost;
  run: LocalRun;
  runId: string;
  writer: UsageWriter;
  agentLog: AgentLogWriter;
  store: FileStore;
}

const historyOf = (options: RigOptions): HistoryConfig => ({
  ...defaultHistory(),
  ...(options.toolLog === false ? { tool_log: { enabled: false } } : {}),
  agent_log: { ...defaultAgentLog(), enabled: options.agentLog !== false, interval_s: 0 },
  ...(options.usage === null ? {} : { usage: { ...defaultUsage(), ...options.usage } }),
});

async function rig(options: RigOptions = {}): Promise<Rig> {
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude };
  let root = dir;
  if (options.viaLink === true) {
    root = join(dirname(dir), `${basename(dir)}-link`);
    await symlink(dir, root);
    links.push(root);
  }
  if (options.session !== null) env["CLAUDE_CODE_SESSION_ID"] = options.session ?? SESSION;
  const writer = new UsageWriter({
    root,
    rules: options.rules ?? [],
    env: () => env,
    ...(options.collector === undefined ? {} : { collector: options.collector }),
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const store = new FileStore({ root: join(root, ".kodel") });
  const agentLog = new AgentLogWriter({
    store,
    root,
    rules: options.rules ?? [],
    env: () => env,
  });
  const host = new LocalPipelineHost({
    root,
    heartbeatMs: 0,
    environment: env,
    history: historyOf(options),
    usage: writer,
    agentLog,
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  });
  const started = await host.start({ pipeline: "two", task: options.task ?? "t", restart: false });
  const run = started.run as LocalRun;
  return { host, run, runId: run.runId, writer, agentLog, store };
}

/** The start of the run as the agent's log has it, with a known use per response. */
function sessionLog(runId: string, session = SESSION): ClaudeLogBuilder {
  const log = new ClaudeLogBuilder({ sessionId: session, cwd: dir });
  log
    .user("please run the pipeline")
    .say("msg_0", "starting it")
    .call(
      "msg_0",
      { id: "toolu_start", name: "mcp__kodel__pipeline_start", input: { task: "t" } },
      { input: 100, output: 10 },
    )
    .result("toolu_start", [{ type: "text", text: JSON.stringify({ ok: true, run_id: runId }) }])
    .say("msg_1", "step a", {
      input: 200,
      output: 20,
      cacheRead: 1000,
      cacheWrite: 300,
      cacheWrite1h: 100,
    });
  return log;
}

const install = (log: ClaudeLogBuilder) => log.install(claude);
const stateOf = (r: Rig): Promise<RunState> => r.run.state();
const journalOf = (r: Rig): Promise<JournalRecord[]> => r.store.readJournal(r.runId);

describe("usage pass", () => {
  test("t9jrs_pass_counts_an_attempt_and_marks_the_open_response", async () => {
    const r = await rig();
    await install(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    const state = await stateOf(r);
    const a = state.usage?.attempts["a:1"];
    expect(a).toBeDefined();
    if (a === undefined) return;
    // msg_0 closed, msg_1 still open at the end of the log: counted as it stands and marked
    expect(a.last_open).toBe(true);
    const tokens = tokensOf(a);
    expect(tokens.input).toBe(300);
    expect(tokens.output).toBe(30);
    expect(tokens.cache_read).toBe(1000);
    expect(tokens.cache_write).toBe(300);
    expect(tokens.cache_write_1h).toBe(100);
    expect(tokens.api_calls).toBe(2);
    expect(summarizeCost(a).usd).not.toBeNull();
    expect((await journalOf(r)).filter((rec) => rec.event === "usage_recorded")).toHaveLength(1);
  });

  test("t9jrs_usage_pass_runs_after_agent_log_before_judging", async () => {
    const r = await rig();
    await install(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    const events = (await journalOf(r)).map((rec) => rec.event);
    expect(events.indexOf("agent_log_saved")).toBeGreaterThan(-1);
    expect(events.indexOf("usage_recorded")).toBeGreaterThan(events.indexOf("agent_log_saved"));
    expect(events.indexOf("usage_recorded")).toBeLessThan(events.indexOf("agent_completed"));
  });

  test("t9jrs_flushed_open_response_corrected_on_next_pass", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await install(log);
    await r.run.completeStep("a", 1);
    // the response that was open is now whole, with its real output, and a new one is being written
    log.say("msg_1", "step a, more", {
      input: 200,
      output: 70,
      cacheRead: 1000,
      cacheWrite: 300,
      cacheWrite1h: 100,
    });
    log.say("msg_2", "step b", { input: 10, output: 5 });
    await writeFile(path, log.text());
    await r.run.completeStep("b", 1);
    const state = await stateOf(r);
    const total = tokensOf(
      runTotals(state.usage ?? { attempts: {}, unattributed: { models: {}, passes: 0 } }),
    );
    // msg_1 counted once with its final output; the call count is not raised by the correction
    expect(total.output).toBe(10 + 70 + 5);
    expect(total.input).toBe(100 + 200 + 10);
    expect(total.api_calls).toBe(3);
    expect(state.usage?.attempts["b:1"]?.last_open).toBe(true);
  });

  test("t9jrs_pass_after_restart_skips_credited_and_catches_up", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await install(log);
    await r.run.completeStep("a", 1);
    const before = tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage()));
    // a new process: nothing is kept in memory
    log.say("msg_2", "step b", { input: 10, output: 5 });
    await writeFile(path, log.text());
    r.writer.forget(r.runId);
    await r.run.completeStep("b", 1);
    const after = tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage()));
    expect(after.api_calls).toBe(before.api_calls + 1);
    expect(after.input).toBe(before.input + 10);
  });

  test("t9jrs_switch_off_writes_nothing_and_does_not_read", async () => {
    const r = await rig({ usage: { enabled: false } });
    await install(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    const state = await stateOf(r);
    expect(state.usage).toBeUndefined();
    const events = (await journalOf(r)).map((rec) => rec.event);
    expect(events).not.toContain("usage_recorded");
    expect(events).not.toContain("usage_failed");
  });

  test("t9jrs_agent_log_off_usage_on_records_written", async () => {
    const r = await rig({ agentLog: false });
    await install(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    const events = (await journalOf(r)).map((rec) => rec.event);
    expect(events).not.toContain("agent_log_saved");
    expect(events).toContain("usage_recorded");
  });

  test("t9jrs_root_through_a_symlink_finds_the_session_for_agent_log_and_usage", async () => {
    // The agent's folder is named after the real directory; the project is reached through a link to it.
    const r = await rig({ viaLink: true });
    await install(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    const events = (await journalOf(r)).map((rec) => rec.event);
    expect(events).toContain("agent_log_saved");
    expect(events).toContain("usage_recorded");
    expect(events).not.toContain("agent_log_failed");
    expect(events).not.toContain("usage_failed");
    expect((await stateOf(r)).usage?.attempts["a:1"]).toBeDefined();
  });

  /** A log of the run's session id, as another directory's agent folder would hold it. */
  const logOfOtherDirectory = (runId: string, cwd: string): ClaudeLogBuilder =>
    new ClaudeLogBuilder({ sessionId: SESSION, cwd })
      .user("go")
      .say("msg_0", "starting it")
      .call(
        "msg_0",
        { id: "toolu_start", name: "mcp__kodel__pipeline_start", input: { task: "t" } },
        { input: 100, output: 10 },
      )
      .result("toolu_start", [{ type: "text", text: JSON.stringify({ ok: true, run_id: runId }) }]);

  test("t9jrs_root_through_a_symlink_still_does_not_find_another_projects_log", async () => {
    const r = await rig({ viaLink: true });
    await install(logOfOtherDirectory(r.runId, join(dirname(dir), `elsewhere-${basename(dir)}`)));
    await r.run.completeStep("a", 1);
    const state = await stateOf(r);
    expect(state.usage?.failed).toContain("log_missing");
    expect(state.usage?.attempts["a:1"]).toBeUndefined();
    expect((await journalOf(r)).map((rec) => rec.event)).not.toContain("usage_recorded");
  });

  test("t9jrs_root_through_a_symlink_refuses_a_sibling_whose_name_only_begins_with_the_projects", async () => {
    const r = await rig({ viaLink: true });
    // the agent's folder of `<project>-sibling` shares the project's name as a prefix: it is found by name, then
    // refused because its own `cwd` is not in the project, never credited (its lines are scanned for the run's id only)
    await install(logOfOtherDirectory(r.runId, `${dir}-sibling`));
    await r.run.completeStep("a", 1);
    const state = await stateOf(r);
    expect(state.usage?.failed).toContain("refused");
    expect(state.usage?.attempts["a:1"]).toBeUndefined();
    expect((await journalOf(r)).map((rec) => rec.event)).not.toContain("usage_recorded");
  });

  test("t9jrs_old_run_without_usage_section_is_not_captured", async () => {
    const r = await rig({ usage: null });
    await install(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    expect((await stateOf(r)).usage).toBeUndefined();
    expect((await r.run.report()).usage).toEqual({ not_collected: true, reason: "not_captured" });
  });

  test("t9jrs_session_unknown_is_said_once", async () => {
    const r = await rig({ session: null });
    await r.run.completeStep("a", 1);
    await r.run.completeStep("b", 1);
    const failed = (await journalOf(r)).filter((rec) => rec.event === "usage_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ reason: "session_unknown" });
  });

  test("t9jrs_log_missing_is_not_collected", async () => {
    const r = await rig();
    // the environment names a session, and no log of it exists
    await r.run.completeStep("a", 1);
    const state = await stateOf(r);
    expect(state.usage?.failed).toContain("log_missing");
    expect(state.status).toBe("running");
  });

  test("t9jrs_only_sessions_that_called_pipeline_tools_count", async () => {
    const r = await rig();
    // a log that only mentions the run id in what the person said
    const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd: dir });
    log
      .user(`what happened to ${r.runId}?`)
      .say("msg_0", "I do not know", { input: 500, output: 50 });
    await install(log);
    await r.run.completeStep("a", 1);
    const state = await stateOf(r);
    expect(Object.keys(state.usage?.attempts ?? {})).toEqual([]);
    expect(state.usage?.failed).toContain("session_unknown");
  });

  test("t9jrs_budget_stop_credits_only_what_was_read", async () => {
    let clock = 0;
    // every look at the clock is a second later: the budget is up after the first entries
    const r = await rig({ budgetMs: 2_500, now: () => (clock += 1_000) });
    await install(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    const state = await stateOf(r);
    expect(state.usage?.sessions[SESSION]?.behind).toBe(true);
    expect(state.usage?.attempts["a:1"]?.incomplete).toBe(true);
    // what was read is credited and not read twice: a pass with time left catches up with the rest
    const credited = tokensOf(runTotals(state.usage ?? emptyUsage())).api_calls;
    expect(credited).toBeLessThan(2);
  });

  test("t9jrs_budget_stop_then_next_pass_catches_up_and_counts_each_once", async () => {
    const clock = { now: 0, tick: 1_000 };
    const r = await rig({ budgetMs: 2_500, now: () => (clock.now += clock.tick) });
    const log = sessionLog(r.runId);
    const path = await install(log);
    await r.run.completeStep("a", 1);
    expect((await stateOf(r)).usage?.sessions[SESSION]?.behind).toBe(true);
    clock.tick = 0;
    log.say("msg_2", "step b", { input: 10, output: 5 });
    await writeFile(path, log.text());
    await r.run.completeStep("b", 1);
    const state = await stateOf(r);
    expect(state.usage?.sessions[SESSION]?.behind).toBeUndefined();
    const total = tokensOf(runTotals(state.usage ?? emptyUsage()));
    expect(total.api_calls).toBe(3);
    expect(total.input).toBe(100 + 200 + 10);
    expect(total.output).toBe(10 + 20 + 5);
    expect((await r.run.report()).usage).toMatchObject({ complete: true });
  });

  test("t9jrs_gate_wait_and_pause_spans_go_to_unattributed", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    // the person was waited for from 10:00:01.000 to 10:00:02.000: what is said then is outside every step
    log.wait(1_000).say("msg_g", "chatting at the gate", { input: 7, output: 3 });
    log.wait(2_000).say("msg_h", "back at work", { input: 11, output: 4 });
    await install(log);
    const at = Date.parse("2026-10-21T10:00:01.000Z");
    const journal = async (): Promise<JournalRecord[]> => [
      { v: 1, seq: 1, ts: at, event: "gate_waiting", node: "g", attempt: 1 },
      { v: 1, seq: 2, ts: at + 1_000, event: "gate_decided", node: "g" },
    ];
    const done = await r.writer.capture(runWith(r, journal), { node: "a", attempt: 1 }, held);
    expect(done.recorded).toBeGreaterThan(0);
    const usage = (await stateOf(r)).usage;
    expect(tokensOf(usage?.unattributed ?? emptyUsage().unattributed).input).toBe(7);
    expect(tokensOf(usage?.attempts["a:1"] ?? emptyUsage().unattributed).input).toBe(
      100 + 200 + 11,
    );
  });

  test("t9jrs_node_sums_plus_unattributed_equal_run_total", async () => {
    const r = await rig();
    await install(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    const usage = (await stateOf(r)).usage;
    if (usage === undefined) throw new Error("no usage");
    const parts = [...Object.values(usage.attempts), usage.unattributed].map(
      (totals) => tokensOf(totals).input,
    );
    expect(parts.reduce((a, b) => a + b, 0)).toBe(tokensOf(runTotals(usage)).input);
  });

  test("t9jrs_every_response_counted_once_however_the_passes_fall", async () => {
    // a small seeded generator: the same splits every time, and many different ones over the rounds of the test
    let seed = 20_261_027;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return (seed >> 8) % n;
    };
    for (let round = 0; round < 6; round += 1) {
      const r = await rig({ task: `round ${round}` });
      const log = sessionLog(r.runId);
      const path = await install(log);
      let input = 100 + 200;
      let output = 10 + 20;
      let calls = 2;
      const run = runWith(r, () => r.store.readJournal(r.runId));
      for (let i = 0; i < 8; i += 1) {
        const added = random(3);
        for (let k = 0; k < added; k += 1) {
          const a = 1 + random(50);
          const b = 1 + random(50);
          log.say(`msg_r${round}_${i}_${k}`, "more", { input: a, output: b });
          input += a;
          output += b;
          calls += 1;
        }
        await writeFile(path, log.text());
        if (random(2) === 0) await r.writer.capture(run, { node: "a", attempt: 1 }, held);
        if (random(4) === 0) r.writer.forget(r.runId);
      }
      await r.writer.capture(run, { node: "a", attempt: 1 }, held);
      // a pass with nothing new changes nothing
      const once = (await stateOf(r)).usage;
      await r.writer.capture(run, { node: "a", attempt: 1 }, held);
      const twice = (await stateOf(r)).usage;
      expect(twice?.events).toBe(once?.events);
      const total = tokensOf(runTotals(twice ?? emptyUsage()));
      expect(total.input).toBe(input);
      expect(total.output).toBe(output);
      expect(total.api_calls).toBe(calls);
    }
  });

  test("t9jrs_refused_hand_in_then_retry_adds_delta", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await install(log);
    const refused = await r.run.completeStep("a", 1, undefined, "no_such_outcome");
    expect(refused.ok).toBe(false);
    log.say("msg_2", "second try", { input: 10, output: 5 });
    await writeFile(path, log.text());
    await r.run.completeStep("a", 1);
    const a = (await stateOf(r)).usage?.attempts["a:1"];
    expect(a).toBeDefined();
    if (a === undefined) return;
    // each response once, in the one attempt
    expect(tokensOf(a).api_calls).toBe(3);
    expect(tokensOf(a).input).toBe(100 + 200 + 10);
  });

  test("t9jrs_recorded_only_for_active_agent_visit", async () => {
    const r = await rig();
    const delta = buildDelta([], { table: { format: 1, revision: "2026-10-01", models: {} } });
    const cursor = { last_seq: 3, last_key: "a".repeat(64) };
    const event = (node: string, attempt: number) => ({
      type: "usage_recorded" as const,
      session: SESSION,
      node,
      attempt,
      delta,
      cursor,
    });
    // another node, a future attempt: nothing is closed that does not exist
    const took = async (node: string, attempt: number) => {
      const decision = await r.run.apply(event(node, attempt));
      return decision.ok && decision.noop !== true;
    };
    expect(await took("b", 1)).toBe(false);
    expect(await took("a", 2)).toBe(false);
    expect(await took("a", 1)).toBe(true);
  });

  test("t9jrs_subagent_counts_under_parent_and_is_marked", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await install(log);
    await subagentLog(path, "agent-aaaa1111", (child) =>
      child.say("sub_1", "looking", { input: 40, output: 4, model: "claude-haiku-5-5" }),
    );
    await r.run.completeStep("a", 1);
    const a = (await stateOf(r)).usage?.attempts["a:1"];
    expect(a?.subagent).toBe(true);
    expect(a?.models["claude-haiku-5-5"]?.input).toBe(40);
    // under the parent's attempt, in the run's totals
    expect(tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage())).input).toBe(
      100 + 200 + 40,
    );
  });

  test("t9jrs_subagents_counted_when_tool_log_false", async () => {
    const r = await rig({ toolLog: false });
    const path = await install(sessionLog(r.runId));
    await subagentLog(path, "agent-bbbb2222", (child) =>
      child.say("sub_2", "looking", { input: 40, output: 4 }),
    );
    await r.run.completeStep("a", 1);
    expect((await stateOf(r)).usage?.attempts["a:1"]?.subagent).toBe(true);
  });

  test("t9jrs_dedupe_across_sidechain_and_subagent_files", async () => {
    const r = await rig();
    const path = await install(sessionLog(r.runId));
    // the same response is in the subagent's file too
    await subagentLog(path, "agent-cccc3333", (child) =>
      child.say("msg_1", "step a", {
        input: 200,
        output: 20,
        cacheRead: 1000,
        cacheWrite: 300,
        cacheWrite1h: 100,
      }),
    );
    await r.run.completeStep("a", 1);
    expect(tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage())).api_calls).toBe(2);
  });

  test("t9jrs_state_holds_only_numbers_and_safe_ids", async () => {
    const r = await rig();
    const hostile = "sk-ant-0123456789abcdef0123456789abcdef weird model";
    const log = sessionLog(r.runId);
    log.say("msg_x", "odd", { input: 5, output: 1, model: hostile });
    log.say("msg_y", "odd too", { input: 5, output: 1 });
    await install(log);
    await r.run.completeStep("a", 1);
    const text = await readFile(join(r.store.runDir(r.runId), "state.json"), "utf8");
    expect(text).not.toContain("sk-ant");
    expect(text).not.toContain("weird");
    expect((await stateOf(r)).usage?.attempts["a:1"]?.models["other"]).toBeDefined();
  });

  test("t9jrs_state_and_journal_agree_under_project_redaction_rule", async () => {
    const rules: RedactRule[] = [{ name: "model", pattern: /sonnet/g }];
    const r = await rig({ rules });
    await install(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    const state = await stateOf(r);
    const recorded = (await journalOf(r)).find((rec) => rec.event === "usage_recorded");
    const stateModels = Object.keys(state.usage?.attempts["a:1"]?.models ?? {});
    const journalModels = Object.keys(
      (recorded?.["delta"] as { models?: Record<string, unknown> } | undefined)?.models ?? {},
    );
    expect(stateModels).toEqual(journalModels);
    expect(stateModels.join()).not.toContain("sonnet");
    const text = await readFile(join(r.store.runDir(r.runId), "state.json"), "utf8");
    expect(text).not.toContain("sonnet");
  });

  test("t9jrs_agent_unsupported_reason", async () => {
    const r = await rig();
    // a client that is not Claude Code made the calls of this run
    const caller = { name: "some-other-agent", version: "1" };
    await r.run.nextStep({ serve: { caller } });
    await r.run.completeStep("a", 1, undefined, undefined, caller);
    expect((await stateOf(r)).usage?.failed).toContain("agent_unsupported");
  });

  test("t9jrs_nothing_written_to_a_finished_run", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await install(log);
    await r.run.completeStep("a", 1);
    await r.run.completeStep("b", 1);
    expect((await stateOf(r)).status).toBe("completed");
    const before = (await journalOf(r)).length;
    log.say("msg_9", "after the end", { input: 999, output: 99 });
    await writeFile(path, log.text());
    const done = await r.writer.capture(
      {
        runId: r.runId,
        state: () => r.run.state(),
        apply: (event) => r.run.apply(event),
        workdir: async () => undefined,
        journal: () => r.store.readJournal(r.runId),
      },
      { node: "b", attempt: 1 },
      { stillHeld: async () => true },
    );
    expect(done.skipped).toBe("not_running");
    expect((await journalOf(r)).length).toBe(before);
  });
});

describe("usage pass around the step end", () => {
  test("t9jrs_lock_busy_journals_usage_failed_once_and_loses_nothing", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await install(log);
    // somebody else holds the lock on copying for the whole of the step end
    let release: () => void = () => undefined;
    const gone = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = r.store.withAgentLogLock(r.runId, 0, () => gone);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await r.run.completeStep("a", 1);
    release();
    await holding;
    let events = (await journalOf(r)).filter((rec) => rec.event.startsWith("usage_"));
    expect(events.map((rec) => rec["reason"])).toEqual(["busy"]);
    // nothing moved: the next step end reads all of it
    log.say("msg_2", "step b", { input: 10, output: 5 });
    await writeFile(path, log.text());
    await r.run.completeStep("b", 1);
    events = (await journalOf(r)).filter((rec) => rec.event === "usage_failed");
    expect(events).toHaveLength(1);
    const total = tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage()));
    expect(total.input).toBe(100 + 200 + 10);
    expect(total.api_calls).toBe(3);
  }, 20_000);

  test("t9jrs_collector_throw_or_timeout_never_fails_step_and_routing_unchanged", async () => {
    const boom = {
      agent: "claude-code",
      profiles: [],
      locate: async () => [],
      read: (): AsyncIterable<never> => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error("boom");
          },
        }),
      }),
    };
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: SESSION };
    const writer = new UsageWriter({ root: dir, rules: [], env: () => env, collector: () => boom });
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      environment: env,
      history: historyOf({}),
      usage: writer,
    });
    const run = (await host.start({ pipeline: "two", task: "t", restart: false })).run as LocalRun;
    await install(sessionLog(run.runId));
    const first = await run.completeStep("a", 1);
    expect(first.ok).toBe(true);
    const second = await run.completeStep("b", 1);
    expect(second.ok).toBe(true);
    const state = await run.state();
    expect(state.status).toBe("completed");
    expect(state.usage?.failed).toContain("unreadable");
  });

  test("t9jrs_ticker_and_step_pass_interleaved", async () => {
    const r = await rig();
    await install(sessionLog(r.runId));
    const ticks = Array.from({ length: 4 }, () =>
      r.agentLog.capture(r.run.agentLogRun(), { why: "tick", waitMs: 0 }),
    );
    await Promise.all([...ticks, r.run.completeStep("a", 1)]);
    const total = tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage()));
    expect(total.api_calls).toBe(2);
    expect(total.input).toBe(100 + 200);
  });

  test("t9jrs_attempt_credit_with_prompts_off_and_over_served_cap", async () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: SESSION };
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      environment: env,
      history: { ...historyOf({}), prompts: { enabled: false } },
    });
    const run = (await host.start({ pipeline: "two", task: "t", restart: false })).run as LocalRun;
    await install(sessionLog(run.runId));
    await run.completeStep("a", 1);
    const state = await run.state();
    // no step was ever served and the use is in its attempt all the same
    expect(
      (await new FileStore({ root: join(dir, ".kodel") }).readJournal(run.runId)).some(
        (rec) => rec.event === "step_served",
      ),
    ).toBe(false);
    expect(tokensOf(state.usage?.attempts["a:1"] ?? emptyUsage().unattributed).input).toBe(300);
  });

  test("t9jrs_one_session_over_two_runs", async () => {
    const r = await rig({ task: "first" });
    const log = sessionLog(r.runId);
    const path = await install(log);
    await r.run.completeStep("a", 1);
    await r.run.completeStep("b", 1);
    const first = tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage()));
    // the same session goes on with another run
    const second = (await r.host.start({ pipeline: "two", task: "second", restart: false }))
      .run as LocalRun;
    log
      .wait(1_000)
      .call(
        "msg_s0",
        { id: "toolu_start2", name: "mcp__kodel__pipeline_start", input: { task: "second" } },
        { input: 1_000, output: 100 },
      )
      .result("toolu_start2", [
        { type: "text", text: JSON.stringify({ ok: true, run_id: second.runId }) },
      ])
      .say("msg_s1", "second run, step a", { input: 2_000, output: 200 });
    await writeFile(path, log.text());
    await second.completeStep("a", 1);
    const mine = tokensOf(runTotals((await second.state()).usage ?? emptyUsage()));
    // each run got its own slice: the second does not hold the first's use, nor the first the second's
    expect(mine.input).toBe(1_000 + 2_000);
    expect(tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage())).input).toBe(first.input);
  });

  test("t9jrs_two_sessions_in_one_run_and_session_from_hook_index", async () => {
    const r = await rig();
    await install(sessionLog(r.runId));
    // after a /clear the run goes on in a session the environment does not name
    const OTHER = "77777777-7777-4777-8777-777777777777";
    const second = new ClaudeLogBuilder({
      sessionId: OTHER,
      cwd: dir,
      start: "2026-10-21T10:01:00.000Z",
    });
    second
      .user("continue the run")
      .call(
        "msg_o0",
        { id: "toolu_next", name: "mcp__kodel__pipeline_next_step", input: { run_id: r.runId } },
        { input: 30, output: 3 },
      )
      .result("toolu_next", [{ type: "text", text: JSON.stringify({ ok: true, run_id: r.runId }) }])
      .say("msg_o1", "after the clear", { input: 4, output: 1 });
    const otherPath = await second.install(claude);
    await writeFile(
      join(dir, ".kodel", "sessions.jsonl"),
      `${JSON.stringify({ session_id: OTHER, agent: "claude-code", transcript_path: otherPath, cwd: dir, ts: "2026-10-21T10:00:00.000Z" })}\n`,
    );
    await r.run.completeStep("a", 1);
    const usage = (await stateOf(r)).usage;
    expect(Object.keys(usage?.sessions ?? {}).sort()).toEqual([OTHER, SESSION].sort());
  });

  test("t9jrs_truncated_or_rotated_log", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await install(log);
    await r.run.completeStep("a", 1);
    const before = tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage()));
    // the log is replaced by a shorter one: it is not the log we left
    const short = new ClaudeLogBuilder({ sessionId: SESSION, cwd: dir });
    short
      .user("hello")
      .call(
        "msg_0",
        { id: "toolu_start", name: "mcp__kodel__pipeline_start", input: { task: "t" } },
        { input: 1, output: 1 },
      )
      .result("toolu_start", [
        { type: "text", text: JSON.stringify({ ok: true, run_id: r.runId }) },
      ]);
    await writeFile(path, short.text());
    r.writer.forget(r.runId);
    await r.run.completeStep("b", 1);
    const state = await stateOf(r);
    expect(state.usage?.failed).toContain("unreadable");
    expect(tokensOf(runTotals(state.usage ?? emptyUsage())).input).toBe(before.input);
  });

  test("t9jrs_changed_usage_shape_is_unreadable_not_zero", async () => {
    // a new Claude Code that calls the usage of a response something else: no usage at all
    const r = await rig({ task: "renamed" });
    const log = sessionLog(r.runId);
    log.lines.forEach((line, i) => {
      log.lines[i] = line.replace('"usage":', '"token_usage":');
    });
    await install(log);
    await r.run.completeStep("a", 1);
    const state = await stateOf(r);
    expect(state.usage?.failed).toContain("unreadable");
    expect(Object.keys(state.usage?.attempts ?? {})).toEqual([]);
    expect((await r.run.report()).usage).toEqual({ not_collected: true, reason: "unreadable" });
  });

  test("t9jrs_usage_with_every_count_renamed_is_unreadable_not_zero", async () => {
    const r = await rig({ task: "zeros" });
    const log = sessionLog(r.runId);
    log.lines.forEach((line, i) => {
      log.lines[i] = line
        .replaceAll("input_tokens", "tokens_in")
        .replaceAll("output_tokens", "tokens_out");
    });
    await install(log);
    await r.run.completeStep("a", 1);
    expect((await stateOf(r)).usage?.failed).toContain("unreadable");
  });

  test("t9jrs_streamed_lines_fold_to_the_agents_own_figure", async () => {
    // a response is written as one line per content block, the usage growing: the agent's figure is the last one
    const r = await rig({ task: "streamed" });
    const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd: dir });
    log
      .user("go")
      .call(
        "msg_0",
        { id: "toolu_start", name: "mcp__kodel__pipeline_start", input: { task: "streamed" } },
        { input: 100, output: 2 },
      )
      .result("toolu_start", [
        { type: "text", text: JSON.stringify({ ok: true, run_id: r.runId }) },
      ]);
    let agents = 0;
    for (let n = 1; n <= 4; n += 1) {
      const id = `msg_s${n}`;
      for (let line = 1; line <= 5; line += 1) {
        log.say(id, `part ${line}`, { input: 50, output: line * 20, cacheRead: 400 });
      }
      agents += 100;
    }
    log.say("msg_end", "done", { input: 1, output: 1 });
    await install(log);
    await r.run.completeStep("a", 1);
    const ours = tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage()));
    // the sum of the last lines of each response, and not of all the lines (which is three times as much)
    expect(ours.output).toBe(2 + agents + 1);
    expect(ours.input).toBe(100 + 4 * 50 + 1);
    expect(ours.cache_read).toBe(4 * 400);
    expect(ours.api_calls).toBe(6);
  });

  test("t9jrs_worktree_removed_before_collection", async () => {
    const r = await rig();
    const gone = join(dir, "..", `gone-worktree-${Date.now()}`);
    const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd: gone });
    log
      .user("run it")
      .call(
        "msg_0",
        { id: "toolu_start", name: "mcp__kodel__pipeline_start", input: { task: "t" } },
        { input: 100, output: 10 },
      )
      .result("toolu_start", [
        { type: "text", text: JSON.stringify({ ok: true, run_id: r.runId }) },
      ])
      .say("msg_1", "working", { input: 5, output: 1 });
    const where = await log.install(claude, "-worktree-folder");
    await writeFile(
      join(dir, ".kodel", "sessions.jsonl"),
      `${JSON.stringify({ session_id: SESSION, agent: "claude-code", transcript_path: where, cwd: gone, ts: "2026-10-21T10:00:00.000Z" })}\n`,
    );
    const withIt = await r.writer.capture(
      { ...runWith(r, () => r.store.readJournal(r.runId)), workdir: async () => gone },
      { node: "a", attempt: 1 },
      held,
    );
    expect(withIt.sessions).toEqual([SESSION]);
    expect(tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage())).input).toBe(105);
  });
});

/** The run as the pass sees it, with a journal of our own: the times a person was waited for are told, not waited. */
function runWith(r: Rig, journal: () => Promise<JournalRecord[]>): AgentLogRun {
  return {
    runId: r.runId,
    state: () => r.run.state(),
    apply: (event) => r.run.apply(event),
    workdir: async () => undefined,
    journal,
  };
}
const held = { stillHeld: async () => true };

/** A subagent of the session whose log is at `sessionPath`, begun after the run's first call. */
async function subagentLog(
  sessionPath: string,
  id: string,
  fill: (log: ClaudeLogBuilder) => void,
): Promise<void> {
  const child = new ClaudeLogBuilder({
    sessionId: id,
    cwd: dir,
    start: "2026-10-21T10:00:30.000Z",
  });
  child.user("look into it");
  fill(child);
  const path = join(dirname(sessionPath), SESSION, "subagents", `${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, child.text());
}

function emptyUsage() {
  return { attempts: {}, unattributed: { models: {}, passes: 0 } };
}

// ── what the review of the build asked for ──────────────────────────────────

const LOOP = [
  "name: loop",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write",
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

describe("usage pass: edges of the log and of the run", () => {
  test("t9jrs_invalid_lines_truncated_tail_unknown_fields", async () => {
    const r = await rig({ task: "hostile-lines" });
    const log = sessionLog(r.runId);
    // a field no version knows on every line, lines that are not entries at all, an entry of a kind nobody knows
    log.lines.forEach((line, i) => {
      log.lines[i] = line.replace('{"sessionId"', '{"surprise":{"a":1},"sessionId"');
    });
    log.lines.splice(
      3,
      0,
      "{ not json",
      "",
      "[]",
      '{"type":"mystery","timestamp":"2026-10-21T10:00:00.500Z","payload":{"x":1}}',
    );
    const path = await install(log);
    // the agent is writing right now: the last line is torn
    await writeFile(
      path,
      `${log.text()}{"type":"assistant","message":{"id":"msg_torn","usage":{"input_tokens":9`,
    );
    await r.run.completeStep("a", 1);
    const state = await stateOf(r);
    expect(state.usage?.failed ?? []).toEqual([]);
    expect(tokensOf(state.usage?.attempts["a:1"] ?? emptyUsage().unattributed).input).toBe(300);
  });

  test("t9jrs_entries_without_timestamp_and_clock_skew", async () => {
    const r = await rig({ task: "no-clock" });
    const log = sessionLog(r.runId);
    // one tool result with no timestamp, and the last response stamped before the first
    log.lines.forEach((line, i) => {
      if (line.includes('"tool_result"')) log.lines[i] = line.replace(/"timestamp":"[^"]*",/, "");
    });
    const lastIndex = log.lines.length - 1;
    log.lines[lastIndex] = (log.lines[lastIndex] ?? "").replace(
      /"timestamp":"[^"]*"/,
      '"timestamp":"2026-10-21T09:00:00.000Z"',
    );
    await install(log);
    await r.run.completeStep("a", 1);
    const state = await stateOf(r);
    expect(state.usage?.failed ?? []).toEqual([]);
    // every response counted once, in the attempt that was completed
    const tokens = tokensOf(state.usage?.attempts["a:1"] ?? emptyUsage().unattributed);
    expect(tokens.input).toBe(300);
    expect(tokens.api_calls).toBe(2);
  });

  test("t9jrs_first_attempt_starts_at_runs_first_call", async () => {
    const r = await rig({ task: "first-call" });
    const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd: dir });
    log
      .user("please run the pipeline")
      .say("msg_pre", "work before the run", { input: 999, output: 99 })
      .call(
        "msg_0",
        { id: "toolu_start", name: "mcp__kodel__pipeline_start", input: { task: "first-call" } },
        { input: 100, output: 10 },
      )
      .result("toolu_start", [
        { type: "text", text: JSON.stringify({ ok: true, run_id: r.runId }) },
      ])
      .say("msg_1", "step a", { input: 200, output: 20 });
    await install(log);
    await r.run.completeStep("a", 1);
    const a = (await stateOf(r)).usage?.attempts["a:1"] ?? emptyUsage().unattributed;
    // the call itself and what follows it; what came before it is not the run's
    expect(tokensOf(a).input).toBe(300);
  });

  test("t9jrs_next_step_response_credited_to_its_step", async () => {
    const r = await rig({ task: "next-step" });
    const log = sessionLog(r.runId);
    const path = await install(log);
    await r.run.completeStep("a", 1);
    // the response that asks what is next is written after step a is over and belongs to step b
    log
      .call(
        "msg_n1",
        { id: "toolu_n1", name: "mcp__kodel__pipeline_next_step", input: { run_id: r.runId } },
        { input: 7, output: 1 },
      )
      .result("toolu_n1", [{ type: "text", text: "{}" }])
      .say("msg_2", "step b", { input: 11, output: 4 });
    await writeFile(path, log.text());
    await r.run.completeStep("b", 1);
    const usage = (await stateOf(r)).usage;
    expect(tokensOf(usage?.attempts["b:1"] ?? emptyUsage().unattributed).input).toBe(7 + 11);
    expect(tokensOf(usage?.attempts["a:1"] ?? emptyUsage().unattributed).input).toBe(300);
  });

  test("t9jrs_log_still_written_complete_false_then_filled_idempotent", async () => {
    const clock = { now: 0, tick: 1_000 };
    const r = await rig({ task: "fill", budgetMs: 2_500, now: () => (clock.now += clock.tick) });
    await install(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    expect((await r.run.report()).usage).toMatchObject({ complete: false });
    // a pass with time left fills the rest in, and a second one finds nothing to add
    clock.tick = 0;
    const journal = () => r.store.readJournal(r.runId);
    const first = await r.writer.capture(runWith(r, journal), { node: "b", attempt: 1 }, held);
    expect(first.recorded).toBeGreaterThan(0);
    expect((await r.run.report()).usage).toMatchObject({ complete: true });
    const filled = tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage()));
    const events = (await journalOf(r)).filter((rec) => rec.event === "usage_recorded").length;
    const again = await r.writer.capture(runWith(r, journal), { node: "b", attempt: 1 }, held);
    expect(again.recorded).toBe(0);
    expect(tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage()))).toEqual(filled);
    expect((await journalOf(r)).filter((rec) => rec.event === "usage_recorded").length).toBe(
      events,
    );
  });

  test("t9jrs_budget_stop_while_skipping_credited_events_leaves_the_report_incomplete", async () => {
    const clock = { now: 0, tick: 0 };
    const r = await rig({
      task: "restart-slow",
      budgetMs: 2_500,
      now: () => (clock.now += clock.tick),
    });
    await install(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    expect((await r.run.report()).usage).toMatchObject({ complete: true });
    // the server restarts (nothing in memory), and the first read is slow: it ends while still skipping what is counted
    r.writer.forget(r.runId);
    clock.tick = 1_000;
    const journal = () => r.store.readJournal(r.runId);
    await r.writer.capture(runWith(r, journal), { node: "b", attempt: 1 }, held);
    const stopped = await stateOf(r);
    expect(stopped.usage?.sessions[SESSION]?.behind).toBe(true);
    // the cursor did not go back, and the report says the log was not read to its end
    expect(stopped.usage?.sessions[SESSION]?.last_seq).toBeGreaterThan(0);
    expect((await r.run.report()).usage).toMatchObject({ complete: false });
    // a later pass that reaches the end of a log with nothing new in it clears the mark
    clock.tick = 0;
    await r.writer.capture(runWith(r, journal), { node: "b", attempt: 1 }, held);
    expect((await stateOf(r)).usage?.sessions[SESSION]?.behind).toBeUndefined();
    expect((await r.run.report()).usage).toMatchObject({ complete: true });
  });

  test("t9jrs_agent_still_running_at_run_end", async () => {
    const r = await rig({ task: "running-at-end" });
    const log = sessionLog(r.runId);
    const path = await install(log);
    await r.run.completeStep("a", 1);
    log.say("msg_2", "step b, the last words are still being written", { input: 10, output: 1 });
    await writeFile(path, log.text());
    await r.run.completeStep("b", 1);
    const state = await stateOf(r);
    expect(state.status).toBe("completed");
    // the response open at the end is counted as it stands and said to be
    expect(state.usage?.attempts["b:1"]?.last_open).toBe(true);
    expect((await r.run.report()).usage).toMatchObject({ lower_bound: true });
  });

  test("t9jrs_usage_recorded_is_redacted_in_journal", async () => {
    const rules: RedactRule[] = [{ name: "model", pattern: /sonnet/g }];
    const r = await rig({ task: "redact", rules });
    await install(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    const records = (await journalOf(r)).filter((rec) => rec.event === "usage_recorded");
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain("sonnet");
  });

  test("t9jrs_frozen_prices_used_not_later_edit", async () => {
    const dear = {
      "claude-sonnet-5-5": { input: 900, output: 900, cache_read: 900, cache_write: 900 },
    };
    const r = await rig({ task: "frozen", usage: { prices: dear } });
    // the agent edits the config of the project after the run began: the run keeps the prices it started with
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      "worktree:\n  mode: off\nhistory:\n  usage:\n    prices: {}\n",
    );
    await install(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    const a = (await stateOf(r)).usage?.attempts["a:1"];
    if (a === undefined) throw new Error("no attempt a:1");
    const model = Object.values(a.models)[0];
    expect(model?.config_priced_calls).toBeGreaterThan(0);
    // 300 input tokens at 900 dollars per million tokens and more besides
    expect(model?.computed_usd).toBeGreaterThan(0.2);
    expect(summarizeCost(a).config).toBe(true);
  });

  test("t9jrs_hostile_model_id_on_the_open_response_is_folded", async () => {
    const r = await rig({ task: "hostile-open" });
    const log = sessionLog(r.runId);
    // the last response, the one still open at the step end, names a model that is no id
    log.say("msg_open", "still going", {
      input: 5,
      output: 1,
      model: "sk-ant-0123456789abcdef0123456789abcdef weird model",
    });
    await install(log);
    await r.run.completeStep("a", 1);
    const state = await stateOf(r);
    expect(state.usage?.failed ?? []).toEqual([]);
    // the step's whole delta was kept: nothing was pushed to the next attempt
    expect(tokensOf(state.usage?.attempts["a:1"] ?? emptyUsage().unattributed).input).toBe(305);
    const text = await readFile(join(r.store.runDir(r.runId), "state.json"), "utf8");
    expect(text).not.toContain("sk-ant");
  });

  test("t9jrs_the_pass_that_could_not_run_is_said_once", async () => {
    const r = await rig({ task: "errored" });
    await install(sessionLog(r.runId));
    // the store fails at the step end in a way that is not a busy lock
    r.store.withAgentLogLock = async () => {
      throw new Error("disk is gone");
    };
    await r.run.completeStep("a", 1);
    await r.run.completeStep("b", 1);
    // nothing was read (the copy threw before the count could run), so it is `busy`, as when the lock is lost
    const failed = (await journalOf(r)).filter(
      (rec) => rec.event === "usage_failed" && rec["reason"] === "busy",
    );
    expect(failed).toHaveLength(1);
  });

  test("t9jrs_an_unreadable_log_is_not_read_again_until_it_grows", async () => {
    let reads = 0;
    const r = await rig({
      task: "unreadable-once",
      collector: (configDir) => {
        const inner = claudeCodeCollector({ configDir });
        return {
          ...inner,
          read: (...args: Parameters<typeof inner.read>) => {
            reads += 1;
            return inner.read(...args);
          },
        };
      },
    });
    const log = sessionLog(r.runId);
    log.lines.forEach((line, i) => {
      log.lines[i] = line.replace('"usage":', '"token_usage":');
    });
    await install(log);
    await r.run.completeStep("a", 1);
    expect((await stateOf(r)).usage?.failed).toContain("unreadable");
    const afterFirst = reads;
    expect(afterFirst).toBeGreaterThan(0);
    await r.run.completeStep("b", 1);
    expect(reads).toBe(afterFirst);
  });

  test("t9jrs_events_cap_is_said_once_and_the_log_is_not_read_again", async () => {
    const r = await rig({ task: "cap" });
    await install(sessionLog(r.runId));
    const delta = buildDelta([], defaultPricing());
    for (let i = 1; i <= 1_000; i += 1) {
      const done = await r.run.apply({
        type: "usage_recorded",
        session: SESSION,
        delta,
        cursor: { last_seq: i, last_key: "a".repeat(64) },
      });
      expect(done.ok).toBe(true);
    }
    const before = (await journalOf(r)).filter((rec) => rec.event === "usage_recorded").length;
    expect(before).toBe(1_000);
    await r.run.completeStep("a", 1);
    await r.run.completeStep("b", 1);
    const state = await stateOf(r);
    expect(state.usage?.failed).toEqual(["cap"]);
    const after = await journalOf(r);
    expect(after.filter((rec) => rec.event === "usage_recorded").length).toBe(1_000);
    expect(after.filter((rec) => rec.event === "usage_failed")).toHaveLength(1);
  }, 60_000);

  test("t9jrs_retried_node_gets_its_own_attempt", async () => {
    await writeFile(join(dir, ".kodel", "pipelines", "loop.yaml"), LOOP);
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: SESSION };
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      environment: env,
      history: historyOf({}),
      usage: new UsageWriter({ root: dir, rules: [], env: () => env }),
    });
    const run = (await host.start({ pipeline: "loop", task: "t", restart: false })).run as LocalRun;
    const log = sessionLog(run.runId);
    const path = await install(log);
    await run.completeStep("write", 1);
    await run.decideHuman("approve", "rejected", "again");
    log.say("msg_2", "second try", { input: 40, output: 4 });
    await writeFile(path, log.text());
    await run.completeStep("write", 2);
    const usage = (await run.state()).usage;
    expect(Object.keys(usage?.attempts ?? {}).sort()).toEqual(["write:1", "write:2"]);
    expect(tokensOf(usage?.attempts["write:1"] ?? emptyUsage().unattributed).input).toBe(300);
    expect(tokensOf(usage?.attempts["write:2"] ?? emptyUsage().unattributed).input).toBe(40);
  });

  test("t9jrs_superseded_or_canceled_attempt_usage_not_lost", async () => {
    const r = await rig({ task: "canceled" });
    const log = sessionLog(r.runId);
    const path = await install(log);
    await r.run.completeStep("a", 1);
    const kept = tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage()));
    await r.run.cancel();
    expect((await stateOf(r)).status).toBe("canceled");
    // what was counted stays counted, and a later pass writes nothing to a run that is over
    log.say("msg_3", "after the cancel", { input: 500, output: 50 });
    await writeFile(path, log.text());
    const before = (await journalOf(r)).length;
    const done = await r.writer.capture(
      runWith(r, () => r.store.readJournal(r.runId)),
      { node: "b", attempt: 1 },
      held,
    );
    expect(done.skipped).toBe("not_running");
    expect((await journalOf(r)).length).toBe(before);
    expect(tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage()))).toEqual(kept);
    expect((await stateOf(r)).usage?.attempts["a:1"]).toBeDefined();
  });
});

// ── what the second review of the build asked for ───────────────────────────

/** The lines of a log with no time on any entry (the first time found in a log is the one that dates it). */
const withoutTimes = (text: string): string =>
  text
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      const entry = JSON.parse(line) as Record<string, unknown>;
      delete entry["timestamp"];
      return JSON.stringify(entry);
    })
    .join("\n");

describe("usage pass: the second review", () => {
  test("t9jrs_open_response_in_one_stream_whole_in_another_counted_once", async () => {
    const r = await rig({ task: "open-and-whole" });
    // main: msg_1 whole, msg_2 open at the end of the log; the subagent's file ends in msg_1, open there
    const log = sessionLog(r.runId).say("msg_2", "step b", { input: 30, output: 3 });
    const path = await install(log);
    await subagentLog(path, "agent-dddd4444", (child) =>
      child.say("msg_1", "step a", {
        input: 200,
        output: 20,
        cacheRead: 1000,
        cacheWrite: 300,
        cacheWrite1h: 100,
      }),
    );
    await r.run.completeStep("a", 1);
    const total = tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage()));
    expect(total.api_calls).toBe(3);
    expect(total.input).toBe(100 + 200 + 30);
  });

  test("t9jrs_session_id_over_the_length_cap_is_not_looked_at_and_said", async () => {
    const long = "a".repeat(129);
    const r = await rig({ task: "long-session", session: long });
    await install(sessionLog(r.runId, long));
    await r.run.completeStep("a", 1);
    const state = await stateOf(r);
    // nothing is counted for it, and the pass did not end for no visible reason
    expect(state.usage?.attempts["a:1"]).toBeUndefined();
    const failed = (await journalOf(r)).filter((rec) => rec.event === "usage_failed");
    expect(failed.map((rec) => rec["reason"])).toEqual(["session_unknown"]);
  });

  test("t9jrs_a_record_the_run_refuses_is_said_once_not_a_silent_end", async () => {
    const r = await rig({ task: "refused-record" });
    await install(sessionLog(r.runId));
    const applied: string[] = [];
    const run: AgentLogRun = {
      ...runWith(r, () => r.store.readJournal(r.runId)),
      apply: async (event) => {
        applied.push(event.type);
        // the machine refuses every usage record
        if (event.type === "usage_recorded") return { ok: false };
        return r.run.apply(event);
      },
    };
    const done = await r.writer.capture(run, { node: "a", attempt: 1 }, held);
    expect(done.recorded).toBe(0);
    expect(done.failures).toEqual(["record_refused"]);
    expect(applied).toContain("usage_failed");
  });

  test("t9jrs_subagent_log_without_any_time_is_said_not_skipped_silently", async () => {
    const r = await rig({ task: "no-time" });
    const path = await install(sessionLog(r.runId));
    await subagentLog(path, "agent-eeee5555", (child) =>
      child.say("sub_9", "looking", { input: 40, output: 4 }),
    );
    const file = join(dirname(path), SESSION, "subagents", "agent-eeee5555.jsonl");
    await writeFile(file, withoutTimes(await readFile(file, "utf8")));
    await r.run.completeStep("a", 1);
    const failed = (await journalOf(r)).filter((rec) => rec.event === "usage_failed");
    expect(failed.map((rec) => rec["reason"])).toEqual(["unreadable"]);
    // the main log is still counted, and the subagent's use is not guessed at
    const total = tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage()));
    expect(total.input).toBe(100 + 200);
  });

  test("t9jrs_step_end_takes_the_pass_lock_once_for_both_passes", async () => {
    const r = await rig({ task: "one-lock" });
    await install(sessionLog(r.runId));
    const original = r.store.withAgentLogLock.bind(r.store);
    let taken = 0;
    r.store.withAgentLogLock = ((...args: Parameters<typeof original>) => {
      taken += 1;
      return original(...args);
    }) as typeof r.store.withAgentLogLock;
    await r.run.completeStep("a", 1);
    // both the copy and the usage pass ran...
    const events = (await journalOf(r)).map((rec) => rec.event);
    expect(events).toContain("agent_log_saved");
    expect(events).toContain("usage_recorded");
    // ...under one acquisition of the lock
    expect(taken).toBe(1);
  });

  test("t9jrs_switch_off_does_not_even_build_a_collector_or_read", async () => {
    let built = 0;
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: SESSION };
    const writerFor = () =>
      new UsageWriter({
        root: dir,
        rules: [],
        env: () => env,
        collector: (configDir) => {
          built += 1;
          return claudeCodeCollector({ configDir });
        },
      });
    const hostFor = (usage: UsageWriter, config: Partial<UsageConfig>) =>
      new LocalPipelineHost({
        root: dir,
        heartbeatMs: 0,
        environment: env,
        history: historyOf({ usage: config }),
        usage,
      });
    const off = (
      await hostFor(writerFor(), { enabled: false }).start({
        pipeline: "two",
        task: "off",
        restart: false,
      })
    ).run as LocalRun;
    await install(sessionLog(off.runId));
    await off.completeStep("a", 1);
    expect(built).toBe(0);
    // with it on, the same setup does read
    const on = (
      await hostFor(writerFor(), {}).start({
        pipeline: "two",
        task: "on",
        restart: false,
      })
    ).run as LocalRun;
    await install(sessionLog(on.runId));
    await on.completeStep("a", 1);
    expect(built).toBe(1);
  });
});

// ── the fifth review ────────────────────────────────────────────────────────

/** A collector that tells which reads begin at the start of a log and which continue one. */
function spyingCollector(reads: { sub: boolean; resumed: boolean }[]) {
  return (configDir: string): AgentHistoryCollector => {
    const real = claudeCodeCollector({ configDir, cacheScope: true });
    return {
      agent: real.agent,
      profiles: real.profiles,
      locate: (root, options) => real.locate(root, options),
      read: (ref, window, options) => {
        reads.push({
          sub: ref.parent_session_id !== undefined,
          resumed: options?.resume !== undefined,
        });
        return real.read(ref, window, options);
      },
    };
  };
}

const freshMainReads = (reads: { sub: boolean; resumed: boolean }[]) =>
  reads.filter((read) => !read.sub && !read.resumed).length;

describe("usage pass: the fifth review", () => {
  test("t9jrs_many_subagent_logs_do_not_make_the_pass_forget_the_main_log", async () => {
    const reads: { sub: boolean; resumed: boolean }[] = [];
    const r = await rig({ task: "many-subagents", collector: spyingCollector(reads) });
    const log = sessionLog(r.runId);
    const path = await install(log);
    // more subagent logs than the old shared cap of 16 streams
    for (let i = 0; i < 20; i += 1) {
      await subagentLog(path, `agent-many${String(i).padStart(4, "0")}`, (child) =>
        child.say(`sub_${i}`, "looking", { input: 1, output: 1 }),
      );
    }
    await r.run.completeStep("a", 1);
    log.say("msg_2", "step b", { input: 10, output: 5 });
    await writeFile(path, log.text());
    await r.run.completeStep("b", 1);
    // the main log was read from the run's start once; the second pass went on from where the first stopped
    expect(freshMainReads(reads)).toBe(1);
    const total = tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage()));
    expect(total.input).toBe(100 + 200 + 10 + 20);
  }, 60_000);

  test("t9jrs_a_run_with_many_subagent_logs_does_not_push_out_another_runs_memory", async () => {
    const reads: { sub: boolean; resumed: boolean }[] = [];
    const first = await rig({ task: "busy-run", collector: spyingCollector(reads) });
    const log = sessionLog(first.runId);
    const path = await install(log);
    for (let i = 0; i < 20; i += 1) {
      await subagentLog(path, `agent-busy${String(i).padStart(4, "0")}`, (child) =>
        child.say(`sub_${i}`, "looking", { input: 1, output: 1 }),
      );
    }
    const second = (await first.host.start({ pipeline: "two", task: "quiet-run", restart: false }))
      .run as LocalRun;
    log
      .wait(1_000)
      .call(
        "msg_q0",
        { id: "toolu_start_q", name: "mcp__kodel__pipeline_start", input: { task: "quiet-run" } },
        { input: 1_000, output: 100 },
      )
      .result("toolu_start_q", [
        { type: "text", text: JSON.stringify({ ok: true, run_id: second.runId }) },
      ])
      .say("msg_q1", "second run, step a", { input: 2_000, output: 200 });
    await writeFile(path, log.text());
    await first.run.completeStep("a", 1);
    await second.completeStep("a", 1);
    log.say("msg_q2", "more", { input: 3, output: 1 });
    await writeFile(path, log.text());
    await first.run.completeStep("b", 1);
    await second.completeStep("b", 1);
    // one read from the start for each of the two runs, then they go on: neither made the other forget
    expect(freshMainReads(reads)).toBe(2);
  }, 60_000);

  for (const runs of [2, 3]) {
    test(`t9jrs_${runs}_concurrent_runs_with_a_full_hook_index_keep_their_main_memory`, async () => {
      const reads: { sub: boolean; resumed: boolean }[] = [];
      const first = await rig({ task: "indexed-0", collector: spyingCollector(reads) });
      const log = sessionLog(first.runId);
      const path = await install(log);
      // The hook index lists the newest 20 sessions of the project: each is a candidate of every run, with a log of its
      // own that does not hold any run, so each takes a memo (the old shared cap of 32 held one run's 21, not two).
      const lines: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        const other = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
        const otherLog = new ClaudeLogBuilder({ sessionId: other, cwd: dir });
        otherLog.user("something else").say(`other_${i}`, "unrelated", { input: 1, output: 1 });
        await install(otherLog);
        lines.push(JSON.stringify({ session_id: other, agent: "claude-code" }));
      }
      await writeFile(join(dir, ".kodel", "sessions.jsonl"), `${lines.join("\n")}\n`);
      const all = [first.run];
      for (let n = 1; n < runs; n += 1) {
        const next = (
          await first.host.start({ pipeline: "two", task: `indexed-${n}`, restart: false })
        ).run as LocalRun;
        log
          .wait(1_000)
          .call(
            `msg_s${n}`,
            {
              id: `toolu_start_${n}`,
              name: "mcp__kodel__pipeline_start",
              input: { task: `indexed-${n}` },
            },
            { input: 10, output: 1 },
          )
          .result(`toolu_start_${n}`, [
            { type: "text", text: JSON.stringify({ ok: true, run_id: next.runId }) },
          ]);
        all.push(next);
      }
      log.say("msg_ia", "step a", { input: 20, output: 2 });
      await writeFile(path, log.text());
      // Passes alternate over the runs, so a run's memos would be pushed out by the next run's if they shared a cap.
      for (const run of all) await run.completeStep("a", 1);
      log.say("msg_ib", "step b", { input: 30, output: 3 });
      await writeFile(path, log.text());
      for (const run of all) await run.completeStep("b", 1);
      // One read from the start for each run, then each goes on from its checkpoint: none lost its memory to another.
      expect(freshMainReads(reads)).toBe(runs);
    }, 120_000);
  }

  test("t9jrs_a_subagent_that_began_before_the_run_takes_no_slot_and_is_not_counted", async () => {
    const reads: { sub: boolean; resumed: boolean }[] = [];
    const r = await rig({ task: "early-subagents", collector: spyingCollector(reads) });
    const path = await install(sessionLog(r.runId));
    for (let i = 0; i < 20; i += 1) {
      const id = `agent-early${String(i).padStart(3, "0")}`;
      const child = new ClaudeLogBuilder({
        sessionId: id,
        cwd: dir,
        start: "2026-10-21T09:00:00.000Z",
      });
      child.user("before the run").say(`early_${i}`, "old news", { input: 500, output: 5 });
      const file = join(dirname(path), SESSION, "subagents", `${id}.jsonl`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, child.text());
    }
    await r.run.completeStep("a", 1);
    await r.run.completeStep("b", 1);
    // not counted, and not read at all
    expect(reads.filter((read) => read.sub)).toHaveLength(0);
    expect(tokensOf(runTotals((await stateOf(r)).usage ?? emptyUsage())).input).toBe(100 + 200);
    expect(freshMainReads(reads)).toBe(1);
  }, 60_000);

  test("t9jrs_lost_lock_with_the_copy_switched_off_is_said_as_busy", async () => {
    const r = await rig({ task: "lost-lock", agentLog: false });
    await install(sessionLog(r.runId));
    // the lock is taken and then lost before the count could run: the copy says it is switched off
    r.agentLog.capture = (async () => ({
      skipped: "disabled",
      saved: 0,
      streams: [],
      failures: [],
    })) as typeof r.agentLog.capture;
    await r.run.completeStep("a", 1);
    const events = (await journalOf(r)).filter((rec) => rec.event.startsWith("usage_"));
    expect(events.map((rec) => [rec.event, rec["reason"]])).toEqual([["usage_failed", "busy"]]);
  });

  test("t9jrs_cap_reached_in_the_middle_of_a_pass_is_said_as_cap_not_as_a_refused_record", async () => {
    const r = await rig({ task: "cap-mid-pass" });
    const log = sessionLog(r.runId);
    log.wait(1_000).say("msg_g", "chatting at the gate", { input: 7, output: 3 });
    log.wait(2_000).say("msg_h", "back at work", { input: 11, output: 4 });
    await install(log);
    const delta = buildDelta([], defaultPricing());
    // one record short of the cap: the step's record fits, the one for what was said at the gate does not
    for (let i = 1; i <= 999; i += 1) {
      const done = await r.run.apply({
        type: "usage_recorded",
        session: "99999999-9999-4999-8999-999999999999",
        delta,
        cursor: { last_seq: i, last_key: "a".repeat(64) },
      });
      expect(done.ok).toBe(true);
    }
    const at = Date.parse("2026-10-21T10:00:01.000Z");
    const journal = async (): Promise<JournalRecord[]> => [
      { v: 1, seq: 1, ts: at, event: "gate_waiting", node: "g", attempt: 1 },
      { v: 1, seq: 2, ts: at + 1_000, event: "gate_decided", node: "g" },
    ];
    const done = await r.writer.capture(runWith(r, journal), { node: "a", attempt: 1 }, held);
    expect(done.recorded).toBe(1);
    const failed = (await stateOf(r)).usage?.failed ?? [];
    expect(failed).toContain("cap");
    expect(failed).not.toContain("record_refused");
    expect((await journalOf(r)).filter((rec) => rec.event === "usage_recorded").length).toBe(1_000);
  }, 120_000);
});
