import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentLogConfig,
  defaultAgentLog,
  defaultHistory,
  defaultToolCalls,
  defaultUsage,
  type HistoryConfig,
  type HistoryEvent,
  type RunEvent,
  type RunState,
  runTotals,
  tokensOf,
} from "@kodel-ai/pipeline-core";
import { ClaudeLogBuilder } from "../../testkit/src";
import {
  AGENT_LOG_STALE_MS,
  type AgentLogRun,
  AgentLogTickers,
  AgentLogWriter,
  FileStore,
  GIVE_UP_WAIT_MS,
  LocalPipelineHost,
  type LocalRun,
  MAX_FAILED_TICKS,
  PASS_LIMIT_MS,
  type PassTimers,
  STEP_IN_FLIGHT_WAIT_MS,
  type TimerHandle,
  type Timers,
  UsageWriter,
} from "../src";
import { claudeCodeCollector } from "../src/history";

const SESSION = "66666666-6666-4666-8666-666666666666";
let taskNumber = 0;

const PIPELINE = (gate: boolean) =>
  [
    `name: ${gate ? "gated" : "two"}`,
    "nodes:",
    "  - slug: a",
    "    kind: agent",
    "    prompt: do a",
    gate
      ? "  - slug: ask\n    kind: human\n    prompt: fine?"
      : "  - slug: b\n    kind: agent\n    prompt: do b",
    "edges:",
    gate
      ? "  - { from: a, to: ask }\n  - { from: ask, to: a, when: rejected }"
      : "  - { from: a, to: b }",
    "",
  ].join("\n");

let dir: string;
let claude: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-ticker-")));
  claude = join(dir, "..", `claude-ticker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "two.yaml"), PIPELINE(false));
  await writeFile(join(dir, ".kodel", "pipelines", "gated.yaml"), PIPELINE(true));
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(claude, { recursive: true, force: true });
});

/** Timers that go when the test says so, and remember what was asked of them. */
function manualTimers() {
  interface Fake extends TimerHandle {
    fn: () => void;
    ms: number;
    cleared: boolean;
    unrefed: boolean;
  }
  const all: Fake[] = [];
  const timers: Timers = {
    setInterval: (fn, ms) => {
      const handle: Fake = {
        fn,
        ms,
        cleared: false,
        unrefed: false,
        unref() {
          handle.unrefed = true;
        },
      };
      all.push(handle);
      return handle;
    },
    clearInterval: (handle) => {
      (handle as Fake).cleared = true;
    },
  };
  return { timers, all, live: () => all.filter((t) => !t.cleared) };
}

const logConfig = (over: Partial<AgentLogConfig> = {}): HistoryConfig => ({
  ...defaultHistory(),
  agent_log: { ...defaultAgentLog(), interval_s: 10, ...over },
});

interface Rig {
  host: LocalPipelineHost;
  run: LocalRun;
  runId: string;
  store: FileStore;
  writer: AgentLogWriter;
  env: NodeJS.ProcessEnv;
  fake: ReturnType<typeof manualTimers>;
}

async function rig(
  options: {
    history?: HistoryConfig;
    pipeline?: string;
    session?: string | null;
    timers?: boolean;
  } = {},
): Promise<Rig> {
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude };
  if (options.session !== null) env["CLAUDE_CODE_SESSION_ID"] = options.session ?? SESSION;
  const store = new FileStore({ root: join(dir, ".kodel") });
  const writer = new AgentLogWriter({ store, root: dir, rules: [], env: () => env });
  const fake = manualTimers();
  const host = new LocalPipelineHost({
    root: dir,
    heartbeatMs: 0,
    environment: env,
    history: options.history ?? logConfig(),
    agentLog: writer,
    ...(options.timers === false ? {} : { agentLogTimer: fake.timers }),
  });
  taskNumber += 1;
  const started = await host.start({
    pipeline: options.pipeline ?? "two",
    // a task of its own: the same task would pick up the run a test made before
    task: `t${taskNumber}`,
    restart: false,
  });
  const run = started.run as LocalRun;
  return { host, run, runId: run.runId, store, writer, env, fake };
}

function sessionLog(runId: string): ClaudeLogBuilder {
  const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd: dir });
  log
    .user("run it")
    .call("msg_0", { id: "toolu_start", name: "mcp__kodel__pipeline_start", input: { task: "t" } })
    .result("toolu_start", JSON.stringify({ ok: true, run_id: runId }))
    .say("msg_1", "step a")
    .say("msg_2", "more");
  return log;
}

async function stored(r: Rig, session = SESSION): Promise<HistoryEvent[]> {
  const length = (await r.run.state()).agentLog?.sessions[session]?.length ?? 0;
  const text = (await r.store.readAgentLog(r.runId, session, length)) ?? "";
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as HistoryEvent);
}

const saved = async (r: Rig) =>
  (await r.run.journal()).filter((rec) => rec.event === "agent_log_saved");

const tickersOf = (host: LocalPipelineHost) =>
  (host as unknown as { agentLogTickers: AgentLogTickers }).agentLogTickers;

/** A pause long enough for the start of a timer, which is not waited for by the call that asks for it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("t3bk2 the timer: when it starts and stops", () => {
  test("t3bk2_tick_starts_from_serve_path_only", async () => {
    const r = await rig();
    await sessionLog(r.runId).install(claude);
    await settle();
    // the start of the run made it
    expect(r.fake.all).toHaveLength(1);
    expect(r.fake.all[0]?.ms).toBe(10_000);
    // looking at a run does not
    tickersOf(r.host).stop(r.runId);
    await r.run.inspect();
    await settle();
    expect(r.fake.live()).toHaveLength(0);
    // a call of the agent through the tools does, in each of its ways
    await r.run.nextStep({ serve: {} });
    await settle();
    expect(r.fake.live()).toHaveLength(1);
    tickersOf(r.host).stop(r.runId);
    await r.run.completeStep("a", 1);
    await settle();
    expect(r.fake.live()).toHaveLength(1);
  });

  test("t3bk2_tick_never_from_a_host_without_timers", async () => {
    // the host a command of the person builds has no registry: nothing can start
    const r = await rig({ timers: false });
    await r.run.nextStep({ serve: {} });
    await r.run.completeStep("a", 1);
    await r.run.inspect();
    expect(r.fake.all).toHaveLength(0);
  });

  test("t3bk2_tick_one_per_run_per_process", async () => {
    const r = await rig();
    await sessionLog(r.runId).install(claude);
    // the same run opened again, and every call of the agent: still one timer
    const again = (await r.host.open(r.runId)) as LocalRun;
    for (let i = 0; i < 4; i++) {
      await r.run.nextStep({ serve: {} });
      await again.nextStep({ serve: {} });
    }
    await settle();
    expect(r.fake.all).toHaveLength(1);
  });

  test("t3bk2_tick_interval_config", async () => {
    const off = await rig({ history: logConfig({ interval_s: 0 }) });
    await off.run.nextStep({ serve: {} });
    await settle();
    expect(off.fake.all).toHaveLength(0);
    const five = await rig({ history: logConfig({ interval_s: 5 }) });
    await five.run.nextStep({ serve: {} });
    await settle();
    expect(five.fake.all[0]?.ms).toBe(5_000);
  });

  test("t3bk2_tick_not_started_without_candidates", async () => {
    const r = await rig({ session: null });
    await r.run.nextStep({ serve: {} });
    await settle();
    expect(r.fake.all).toHaveLength(0);
    // a session that shows up later (a hook registered it) starts it at the next call
    await appendFile(
      join(dir, ".kodel", "sessions.jsonl"),
      `${JSON.stringify({ session_id: SESSION, agent: "claude-code", cwd: dir, ts: "2026-10-21T10:00:00.000Z" })}\n`,
    );
    await r.run.nextStep({ serve: {} });
    await settle();
    expect(r.fake.all).toHaveLength(1);
  });

  test("t3bk2_tick_not_started_for_a_run_that_does_not_copy", async () => {
    const off = await rig({ history: logConfig({ enabled: false }) });
    await off.run.nextStep({ serve: {} });
    const old = await rig({ history: defaultHistory() });
    await old.run.nextStep({ serve: {} });
    await settle();
    expect(off.fake.all).toHaveLength(0);
    expect(old.fake.all).toHaveLength(0);
  });

  test("t3bk2_tick_unref_no_leak", async () => {
    const r = await rig();
    await sessionLog(r.runId).install(claude);
    await settle();
    const timer = r.fake.all[0];
    // a timer must not keep a process up, and is gone when the run is
    expect(timer?.unrefed).toBe(true);
    await r.run.completeStep("a", 1);
    await r.run.completeStep("b", 1);
    expect(timer?.cleared).toBe(true);
  });

  test("t3bk2_tick_stops_on_not_running", async () => {
    const r = await rig();
    await sessionLog(r.runId).install(claude);
    await settle();
    await r.run.cancel();
    expect(r.fake.live()).toHaveLength(0);
    // a tick that meets a run that has ended stops its timer too
    const second = await rig();
    await sessionLog(second.runId).install(claude);
    await settle();
    await second.run.apply({ type: "cancel" }, { trust: true });
    await tickersOf(second.host).tick(second.runId);
    expect(second.fake.live()).toHaveLength(0);
  });

  test("t3bk2_tick_stopped_by_host_stop", async () => {
    const r = await rig();
    await sessionLog(r.runId).install(claude);
    await settle();
    expect(r.fake.live()).toHaveLength(1);
    r.host.stop();
    expect(r.fake.live()).toHaveLength(0);
  });

  test("t3bk2_tick_runs_through_a_gate", async () => {
    const r = await rig({ pipeline: "gated" });
    const log = sessionLog(r.runId);
    const path = await log.install(claude);
    await r.run.completeStep("a", 1);
    // the run waits for a person; the run is still running, and so is the copy
    expect((await r.run.state()).status).toBe("running");
    const before = (await stored(r)).length;
    log.say("msg_3", "while the person thinks").say("msg_4", "and thinks");
    await writeFile(path, log.text());
    await r.run.nextStep({ serve: {} });
    await settle();
    await tickersOf(r.host).tick(r.runId);
    expect((await stored(r)).length).toBeGreaterThan(before);
  });
});

describe("t3bk2 the timer: what a tick does", () => {
  test("t3bk2_tick_writes_only_new", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await log.install(claude);
    await settle();
    const tickers = tickersOf(r.host);
    await tickers.tick(r.runId);
    await tickers.tick(r.runId);
    await tickers.tick(r.runId);
    expect(await saved(r)).toHaveLength(1);
    log.say("msg_3", "new").say("msg_4", "newer");
    await writeFile(path, log.text());
    await tickers.tick(r.runId);
    expect(await saved(r)).toHaveLength(2);
  });

  test("t3bk2_tick_quiet_before_first_step", async () => {
    // the person's session has not got to the run yet: ticks say nothing, not even that the session is unknown
    const r = await rig();
    await settle();
    await tickersOf(r.host).tick(r.runId);
    await tickersOf(r.host).tick(r.runId);
    expect((await r.run.journal()).some((rec) => rec.event === "agent_log_failed")).toBe(false);
  });

  /** A host whose reads of the log wait until the test lets them go. */
  async function heldRig() {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = { reads: 0 };
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: SESSION };
    const store = new FileStore({ root: join(dir, ".kodel") });
    const writer = new AgentLogWriter({
      store,
      root: dir,
      rules: [],
      env: () => env,
      collector: (configDir) => {
        const real = claudeCodeCollector({ configDir });
        return {
          ...real,
          read: async function* (ref, window, options) {
            spy.reads += 1;
            await gate;
            yield* real.read(ref, window, options);
          },
        };
      },
    });
    const fake = manualTimers();
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      environment: env,
      history: logConfig(),
      agentLog: writer,
      agentLogTimer: fake.timers,
    });
    const run = (await host.start({ pipeline: "two", task: "t", restart: false })).run as LocalRun;
    await sessionLog(run.runId).install(claude);
    await settle();
    return { host, run, writer, spy, release };
  }

  test("t3bk2_tick_in_flight_skips", async () => {
    const h = await heldRig();
    const tickers = tickersOf(h.host);
    const first = tickers.tick(h.run.runId);
    while (h.spy.reads === 0) await settle();
    // a tick that comes while the first is still reading does not start another
    await tickers.tick(h.run.runId);
    expect(h.spy.reads).toBe(1);
    // and the end of a step waits for it, because the pass ends inside the time a step end waits for one
    const stepDone = h.run.completeStep("a", 1);
    h.release();
    await first;
    await stepDone;
    expect((await h.run.state()).nodes["a"]?.status).not.toBe("running");
  });

  test("t3bk2_tick_races_run_end", async () => {
    const h = await heldRig();
    const pass = h.writer.capture(h.run.agentLogRun(), { why: "tick", waitMs: 0 });
    while (h.spy.reads === 0) await settle();
    // the run ends while the pass reads
    await h.run.apply({ type: "cancel" }, { trust: true });
    const before = (await h.run.journal()).length;
    h.release();
    await pass;
    // the journal took nothing after the end, so what the pass wrote is past the length it vouches for
    expect((await h.run.journal()).length).toBe(before);
    expect((await h.run.state()).agentLog?.sessions[SESSION]).toBeUndefined();
  });

  test("t3bk2_tick_does_not_change_timeouts", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await log.install(claude);
    await settle();
    const before = (await r.run.state()).active[0];
    for (let i = 0; i < 3; i++) {
      log.say(`msg_t${i}`, "text").say(`msg_u${i}`, "more");
      await writeFile(path, log.text());
      await tickersOf(r.host).tick(r.runId);
    }
    const after = (await r.run.state()).active[0];
    // what the engine times a step by is not touched by the copies
    expect(after).toEqual(before);
    expect((await saved(r)).length).toBeGreaterThan(1);
  });

  test("t3bk2_tick_crash_recovery", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await log.install(claude);
    await settle();
    const real = r.run.agentLogRun();
    let fail = true;
    const flaky: AgentLogRun = {
      ...real,
      apply: async (event: RunEvent) => {
        if (event.type === "agent_log_saved" && fail) throw new Error("the process died here");
        return real.apply(event);
      },
    };
    const t = new AgentLogTickers(r.writer, r.fake.timers);
    await t.ensure(flaky);
    await t.tick(r.runId);
    fail = false;
    log.say("msg_9", "after").say("msg_10", "the crash");
    await writeFile(path, log.text());
    await t.tick(r.runId);
    const events = await stored(r);
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events.some((e) => e.kind === "message" && e.message_id === "msg_9")).toBe(true);
    t.stopAll();
  });

  test("t3bk2_tick_lag_bounded", async () => {
    // after each tick the stored log holds every closed response that the log held when the tick came
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await log.install(claude);
    await settle();
    for (let round = 0; round < 4; round++) {
      log.say(`msg_r${round}a`, "words").say(`msg_r${round}b`, "more words");
      await writeFile(path, log.text());
      await tickersOf(r.host).tick(r.runId);
      const messages = (await stored(r))
        .filter((e) => e.kind === "message")
        .map((e) => e.kind === "message" && e.message_id);
      // everything but the response still open (the last one) is there
      expect(messages).toContain(`msg_r${round}a`);
    }
  });

  /** A second process: its own host, writer, timers and checkpoints, on the same project. */
  function secondProcess(r: Rig) {
    const env = { ...r.env };
    const store = new FileStore({ root: join(dir, ".kodel") });
    const writer = new AgentLogWriter({ store, root: dir, rules: [], env: () => env });
    const fake = manualTimers();
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      environment: env,
      history: logConfig(),
      agentLog: writer,
      agentLogTimer: fake.timers,
    });
    return { host, store, writer, fake };
  }

  test("t3bk2_hard_drop_keeps_ticked_log", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await log.install(claude);
    await settle();
    await tickersOf(r.host).tick(r.runId);
    const kept = (await stored(r)).length;
    expect(kept).toBeGreaterThan(3);
    // the process is gone with no word (no stop, no end of a step); another comes up and reads what is on disk
    const p = secondProcess(r);
    const again = (await p.host.open(r.runId)) as LocalRun;
    log.say("msg_after", "the server is back").say("msg_after2", "and copying");
    await writeFile(path, log.text());
    const result = await p.writer.capture(again.agentLogRun(), { why: "tick", waitMs: 0 });
    expect(result.saved).toBe(1);
    const length = (await again.state()).agentLog?.sessions[SESSION]?.length ?? 0;
    const text = (await p.store.readAgentLog(r.runId, SESSION, length)) ?? "";
    const events = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HistoryEvent);
    expect(events.length).toBeGreaterThan(kept);
    expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
  });

  test("t3bk2_two_servers_one_run_tickers", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await log.install(claude);
    await settle();
    const p = secondProcess(r);
    const second = (await p.host.open(r.runId)) as LocalRun;
    await second.nextStep({ serve: {} });
    await settle();
    const mine = tickersOf(r.host);
    const theirs = tickersOf(p.host);
    for (let round = 0; round < 6; round++) {
      log.say(`msg_w${round}`, "words").say(`msg_x${round}`, "more");
      await writeFile(path, log.text());
      await (round % 2 === 0 ? mine : theirs).tick(r.runId);
    }
    await mine.tick(r.runId);
    const events = await stored(r);
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const messages = events
      .filter((e) => e.kind === "message")
      .map((e) => e.kind === "message" && e.message_id);
    expect(new Set(messages).size).toBe(messages.length);
    expect(messages).toContain("msg_w4");
    const file = join(r.store.runDir(r.runId), "agent_log", `${SESSION}.jsonl`);
    expect((await stat(file)).size).toBe(
      (await r.run.state()).agentLog?.sessions[SESSION]?.length ?? -1,
    );
  });

  test("t3bk2_tick_io_cache_dropped_on_fallback", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await log.install(claude);
    await settle();
    await tickersOf(r.host).tick(r.runId);
    let made = 0;
    const store = new FileStore({ root: join(dir, ".kodel") });
    const writer = new AgentLogWriter({
      store,
      root: dir,
      rules: [],
      env: () => r.env,
      collector: (configDir) => {
        made += 1;
        return claudeCodeCollector({ configDir, cacheScope: true });
      },
    });
    log.say("msg_c", "later").say("msg_d", "and later");
    await writeFile(path, log.text());
    // a writer with nothing in memory reads from the start: its collector is made again, remembering nothing
    await writer.capture(r.run.agentLogRun(), { why: "tick", waitMs: 0 });
    expect(made).toBe(1);
    log.say("msg_e", "again").say("msg_f", "and again");
    await writeFile(path, log.text());
    // the pass that started again from the beginning let go of what the collector remembered: a new one is made
    await writer.capture(r.run.agentLogRun(), { why: "tick", waitMs: 0 });
    expect(made).toBe(2);
    log.say("msg_g", "once more").say("msg_h", "and once more");
    await writeFile(path, log.text());
    // and a pass that resumes from its checkpoint keeps the one it has
    await writer.capture(r.run.agentLogRun(), { why: "tick", waitMs: 0 });
    expect(made).toBe(2);
  });
});

describe("t3bk2 the timer: giving up", () => {
  /** A writer that answers as if it could not do its work. */
  const answering = (answers: object[], forgotten: string[] = []) =>
    ({
      capture: async () => ({ saved: 0, streams: [], failures: [], ...(answers.shift() ?? {}) }),
      forget: (id: string) => forgotten.push(id),
      hasCandidates: async () => true,
    }) as unknown as AgentLogWriter;

  const fakeRun = (journal: RunEvent[]): AgentLogRun => ({
    runId: "r_000000001_aaaa",
    state: async () =>
      ({
        status: "running",
        agentLog: { ticks: 0 },
        history: { agent_log: { ...defaultAgentLog(), interval_s: 10 } },
      }) as unknown as RunState,
    apply: async (event) => {
      journal.push(event);
      return { ok: true };
    },
    workdir: async () => undefined,
    journal: async () => [],
  });

  test("t3bk2_tick_stops_after_3_failures", async () => {
    const journal: RunEvent[] = [];
    const fake = manualTimers();
    const errors = Array.from({ length: 10 }, () => ({ errored: true }));
    const t = new AgentLogTickers(answering(errors), fake.timers);
    const run = fakeRun(journal);
    await t.ensure(run);
    expect(fake.live()).toHaveLength(1);
    for (let i = 0; i < MAX_FAILED_TICKS - 1; i++) await t.tick(run.runId);
    expect(fake.live()).toHaveLength(1);
    await t.tick(run.runId);
    expect(fake.live()).toHaveLength(0);
    // said once, then silent
    expect(journal).toEqual([{ type: "agent_log_failed", reason: "unreadable" }]);
    await t.tick(run.runId);
    expect(journal).toHaveLength(1);
  });

  test("t3bk2_tick_busy_lock_skips", async () => {
    // another process holds the lock: the tick does not wait, writes nothing, says nothing, and the timer stays
    const journal: RunEvent[] = [];
    const fake = manualTimers();
    const t = new AgentLogTickers(
      answering(Array.from({ length: 5 }, () => ({ skipped: "busy" }))),
      fake.timers,
    );
    const run = fakeRun(journal);
    await t.ensure(run);
    for (let i = 0; i < 5; i++) await t.tick(run.runId);
    expect(journal).toEqual([]);
    expect(fake.live()).toHaveLength(1);
  });

  test("t3bk2_tick_a_good_tick_resets_the_count", async () => {
    const fake = manualTimers();
    const t = new AgentLogTickers(
      answering([{ errored: true }, { errored: true }, {}, { errored: true }, { errored: true }]),
      fake.timers,
    );
    const run = fakeRun([]);
    await t.ensure(run);
    for (let i = 0; i < 5; i++) await t.tick(run.runId);
    expect(fake.live()).toHaveLength(1);
  });

  test("task_7bh9_skips_do_not_reset_the_failure_count", async () => {
    const errored = { errored: true };
    const busy = { skipped: "busy" };
    const after = async (answers: object[]) => {
      const journal: RunEvent[] = [];
      const fake = manualTimers();
      const t = new AgentLogTickers(answering([...answers]), fake.timers);
      const run = fakeRun(journal);
      await t.ensure(run);
      for (let i = 0; i < answers.length; i++) await t.tick(run.runId);
      return { going: fake.live().length === 1, journal };
    };
    // a tick that did not run is not a good one: the failures on either side of it still add up
    const stopped = await after([
      errored,
      busy,
      busy,
      busy,
      busy,
      busy,
      errored,
      { skipped: "in_flight" },
      errored,
    ]);
    expect(stopped.going).toBe(false);
    expect(stopped.journal).toEqual([{ type: "agent_log_failed", reason: "unreadable" }]);
    // a good one between them starts the count again
    expect((await after([errored, busy, {}, errored, errored])).going).toBe(true);
    // and being kept out is not a failure, however long it lasts
    const kept = await after(Array.from({ length: 20 }, () => busy));
    expect(kept).toEqual({ going: true, journal: [] });
  });

  test("t3bk2_tick_cap_once", async () => {
    const journal: RunEvent[] = [];
    const fake = manualTimers();
    const forgotten: string[] = [];
    const t = new AgentLogTickers(
      answering(
        Array.from({ length: 5 }, () => ({ skipped: "tick_cap" })),
        forgotten,
      ),
      fake.timers,
    );
    const run = fakeRun(journal);
    await t.ensure(run);
    await t.tick(run.runId);
    await t.tick(run.runId);
    // the timer is done and says so once; the ends of steps go on, with what the timer knew kept
    expect(journal).toEqual([{ type: "agent_log_failed", reason: "tick_cap" }]);
    expect(fake.live()).toHaveLength(0);
    expect(forgotten).toEqual([]);
  });

  test("t3bk2_tick_restart_resumes_from_the_journal", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await log.install(claude);
    await settle();
    await tickersOf(r.host).tick(r.runId);
    const first = (await stored(r)).length;
    // a new process: nothing in memory but the timer it starts at its first call
    const env = { ...r.env };
    const store = new FileStore({ root: join(dir, ".kodel") });
    const writer = new AgentLogWriter({ store, root: dir, rules: [], env: () => env });
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      environment: env,
      history: logConfig(),
      agentLog: writer,
      agentLogTimer: manualTimers().timers,
    });
    const again = (await host.open(r.runId)) as LocalRun;
    await again.nextStep({ serve: {} });
    await settle();
    log.say("msg_z1", "after the restart").say("msg_z2", "and more");
    await writeFile(path, log.text());
    await tickersOf(host).tick(r.runId);
    const length = (await again.state()).agentLog?.sessions[SESSION]?.length ?? 0;
    const events = ((await store.readAgentLog(r.runId, SESSION, length)) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HistoryEvent);
    expect(events.length).toBeGreaterThan(first);
    expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
  });
});

describe("t3bk2 the timer on Windows", () => {
  test.skipIf(process.platform !== "win32")("t3bk2_windows_concurrent_state_reader", async () => {
    // the state file is replaced by a rename at each journaled tick while a reader (kodel wait) reads it
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await log.install(claude);
    await settle();
    let reading = true;
    let failures = 0;
    const reader = (async () => {
      while (reading) {
        try {
          await r.run.state();
        } catch {
          failures += 1;
        }
      }
    })();
    for (let i = 0; i < 20; i++) {
      log.say(`msg_${i}a`, "words").say(`msg_${i}b`, "more");
      await writeFile(path, log.text());
      await tickersOf(r.host).tick(r.runId);
    }
    reading = false;
    await reader;
    expect(failures).toBe(0);
  });
});

describe("session_label the timer journals a rename", () => {
  test("session_label_a_rename_between_two_ticks_is_journaled_once", async () => {
    const r = await rig();
    const path = await sessionLog(r.runId).install(claude);
    await appendFile(
      path,
      `${JSON.stringify({ type: "custom-title", customTitle: "first", sessionId: SESSION })}\n`,
    );
    const names = async () =>
      (await r.run.journal())
        .filter((rec) => rec.event === "agent_session_named")
        .map((rec) => rec.name);
    await tickersOf(r.host).tick(r.runId);
    expect(await names()).toEqual(["first"]);
    await appendFile(
      path,
      `${JSON.stringify({ type: "custom-title", customTitle: "second", sessionId: SESSION })}\n`,
    );
    await tickersOf(r.host).tick(r.runId);
    await tickersOf(r.host).tick(r.runId);
    expect(await names()).toEqual(["first", "second"]);
  });
});

const until = async (met: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 1_000; i++) {
    if (await met()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never happened: ${what}`);
};

/** The timers of a writer's limits, which go when the test says so. */
function passTimers() {
  interface Fake {
    fn: () => void;
    ms: number;
    state: "live" | "fired" | "cleared";
  }
  const all: Fake[] = [];
  const timers: PassTimers = {
    setTimeout: (fn, ms) => {
      const handle: Fake = { fn, ms, state: "live" };
      all.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      const fake = handle as Fake;
      if (fake.state === "live") fake.state = "cleared";
    },
  };
  const live = (ms?: number) =>
    all.filter((t) => t.state === "live" && (ms === undefined || t.ms === ms));
  const fire = async (ms: number) => {
    await until(() => live(ms).length > 0, `a live timer of ${ms} ms`);
    const timer = live(ms)[0] as Fake;
    timer.state = "fired";
    timer.fn();
  };
  return { timers, live, fire };
}

/**
 * A run that counts usage and tool calls, served by a host whose writer has hand-fired limits, a clock of its own
 * for the lock on copying (the wait for the lock moves it) and reads of the log that can be held.
 */
async function boundRig(options: { staleMs?: number; session?: string | null } = {}) {
  const pass = passTimers();
  const now = { t: Date.now() };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  /** `hold`: how many of the next reads wait for `release`. */
  const spy = { reads: 0, hold: 0 };
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude };
  if (options.session !== null) env["CLAUDE_CODE_SESSION_ID"] = options.session ?? SESSION;
  const store = new FileStore({
    root: join(dir, ".kodel"),
    clock: () => now.t,
    sleep: async (ms) => {
      now.t += ms;
    },
    ...(options.staleMs === undefined ? {} : { agentLogStaleMs: options.staleMs }),
  });
  const writer = new AgentLogWriter({
    store,
    root: dir,
    rules: [],
    env: () => env,
    timers: pass.timers,
    collector: (configDir) => {
      const real = claudeCodeCollector({ configDir });
      return {
        ...real,
        read: async function* (ref, window, options) {
          spy.reads += 1;
          if (spy.hold > 0) {
            spy.hold -= 1;
            await gate;
          }
          yield* real.read(ref, window, options);
        },
      };
    },
  });
  const fake = manualTimers();
  const host = new LocalPipelineHost({
    root: dir,
    heartbeatMs: 0,
    environment: env,
    history: { ...logConfig(), usage: defaultUsage(), tool_calls: defaultToolCalls() },
    agentLog: writer,
    // no wait for the step's own call in the log: these logs have none, and the tests are not about it
    usage: new UsageWriter({
      root: dir,
      rules: [],
      env: () => env,
      sleep: async () => undefined,
      stepWaitMs: 0,
    }),
    agentLogTimer: fake.timers,
  });
  taskNumber += 1;
  const started = await host.start({ pipeline: "two", task: `t${taskNumber}`, restart: false });
  const run = started.run as LocalRun;
  const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd: dir });
  log
    .user("run it")
    .call(
      "msg_0",
      { id: "toolu_start", name: "mcp__kodel__pipeline_start", input: { task: "t" } },
      { input: 100, output: 10 },
    )
    .result("toolu_start", JSON.stringify({ ok: true, run_id: run.runId }))
    .say("msg_1", "step a", { input: 200, output: 20 });
  const path = await log.install(claude);
  await settle();
  const reasons = async (event: string) =>
    (await run.journal()).filter((rec) => rec.event === event).map((rec) => rec["reason"]);
  const lockToken = async (): Promise<string | undefined> =>
    readFile(join(store.runDir(run.runId), "agent_log.lock"), "utf8")
      .then((text) => (JSON.parse(text) as { token?: string }).token)
      .catch(() => undefined);
  return {
    host,
    run,
    runId: run.runId,
    store,
    writer,
    pass,
    fake,
    now,
    spy,
    log,
    path,
    release: () => release(),
    reasons,
    lockToken,
  };
}

/** Lets a promise go on by itself and says whether it has settled. */
const watch = (promise: Promise<unknown>) => {
  const seen = { done: false };
  void promise.then(
    () => {
      seen.done = true;
    },
    () => {
      seen.done = true;
    },
  );
  return seen;
};

/** The input tokens counted for the run so far; none when the run does not count. */
const inputOf = async (run: LocalRun): Promise<number | undefined> => {
  const usage = (await run.state()).usage;
  return usage === undefined ? undefined : tokensOf(runTotals(usage)).input;
};

describe("task_7bh9 the end of a step behind a pass", () => {
  test("task_7bh9_step_end_does_not_wait_past_its_limit", async () => {
    const b = await boundRig();
    b.spy.hold = 1;
    const tick = tickersOf(b.host).tick(b.runId);
    await until(() => b.spy.reads > 0, "the read of the tick");
    const step = b.run.completeStep("a", 1);
    const seen = watch(step);
    await until(() => b.pass.live(STEP_IN_FLIGHT_WAIT_MS).length === 1, "the step wait");
    await settle();
    // not before its wait is over
    expect(seen.done).toBe(false);
    expect((await b.run.state()).nodes["a"]?.status).toBe("running");
    await b.pass.fire(STEP_IN_FLIGHT_WAIT_MS);
    await step;
    // the step is judged without a copy, and what was not counted is said once
    expect((await b.run.state()).nodes["a"]?.status).not.toBe("running");
    expect(await b.reasons("usage_failed")).toEqual(["busy"]);
    expect(await b.reasons("tool_calls_failed")).toEqual(["busy"]);
    expect(b.spy.reads).toBe(1);
    b.release();
    await tick;
  });

  test("task_7bh9_step_end_behind_a_slow_healthy_pass", async () => {
    // a pass that ends inside the wait: the step end copies and counts as it always did
    const quick = await boundRig();
    quick.spy.hold = 1;
    const first = tickersOf(quick.host).tick(quick.runId);
    await until(() => quick.spy.reads > 0, "the read of the tick");
    const inTime = quick.run.completeStep("a", 1);
    await until(() => quick.pass.live(STEP_IN_FLIGHT_WAIT_MS).length === 1, "the step wait");
    quick.release();
    await first;
    await inTime;
    expect(await quick.reasons("usage_failed")).toEqual([]);
    expect(await quick.reasons("tool_calls_failed")).toEqual([]);
    expect(await inputOf(quick.run)).toBe(300);
    expect(quick.pass.live()).toEqual([]);
    await quick.run.apply({ type: "cancel" }, { trust: true });

    // one that ends after it: nothing is wrong anywhere, and the step still says `busy`
    const slow = await boundRig();
    slow.spy.hold = 1;
    const second = tickersOf(slow.host).tick(slow.runId);
    await until(() => slow.spy.reads > 0, "the read of the tick");
    const late = slow.run.completeStep("a", 1);
    await slow.pass.fire(STEP_IN_FLIGHT_WAIT_MS);
    await late;
    expect(await slow.reasons("usage_failed")).toEqual(["busy"]);
    expect(await slow.reasons("agent_log_failed")).toEqual([]);
    slow.release();
    await second;
    // the cursor did not move: the next step end counts what was skipped
    slow.log.say("msg_2", "step b", { input: 10, output: 5 });
    await writeFile(slow.path, slow.log.text());
    await slow.run.completeStep("b", 1);
    expect(await slow.reasons("usage_failed")).toEqual(["busy"]);
    expect(await inputOf(slow.run)).toBe(310);
  });

  test("task_7bh9_step_end_while_stalled_lock_is_fresh_says_busy", async () => {
    const b = await boundRig();
    b.spy.hold = 1;
    const tick = tickersOf(b.host).tick(b.runId);
    await until(() => b.spy.reads > 0, "the read of the tick");
    await b.pass.fire(PASS_LIMIT_MS);
    await tick;
    expect(b.writer.busy(b.runId)).toBe(false);
    const token = await b.lockToken();
    expect(token).toBeDefined();
    const from = b.now.t;
    await b.run.completeStep("a", 1);
    // it waited for the lock as long as a step end does, and not for the pass that holds it
    expect(b.now.t - from).toBeGreaterThanOrEqual(5_000);
    expect(b.now.t - from).toBeLessThan(AGENT_LOG_STALE_MS);
    expect(b.pass.live(STEP_IN_FLIGHT_WAIT_MS)).toEqual([]);
    expect(await b.lockToken()).toBe(token as string);
    expect((await b.run.state()).nodes["a"]?.status).not.toBe("running");
    expect(await b.reasons("usage_failed")).toEqual(["busy"]);
    expect(await b.reasons("tool_calls_failed")).toEqual(["busy"]);
    expect(await b.reasons("agent_log_failed")).toEqual(["stalled"]);
  });
});

describe("task_7bh9 the timer and a pass that does not end", () => {
  test("task_7bh9_ticker_stops_after_three_stalled_passes_and_steps_still_copy", async () => {
    const stale = 1_000;
    const b = await boundRig({ staleMs: stale });
    await b.run.nextStep({ serve: {} });
    await settle();
    const tickers = tickersOf(b.host);
    expect(tickers.has(b.runId)).toBe(true);
    b.spy.hold = MAX_FAILED_TICKS;
    const tokens: (string | undefined)[] = [];
    for (let round = 1; round <= MAX_FAILED_TICKS; round++) {
      const tick = tickers.tick(b.runId);
      await until(() => b.spy.reads === round, `the read of round ${round}`);
      tokens.push(await b.lockToken());
      await b.pass.fire(PASS_LIMIT_MS);
      await tick;
      // a tick kept out by the lock of the pass given up is no failure and no good tick
      await tickers.tick(b.runId);
      expect(tickers.has(b.runId)).toBe(round < MAX_FAILED_TICKS);
      b.now.t += stale + 1;
    }
    // each round took the lock of the one before over
    expect(new Set(tokens).size).toBe(MAX_FAILED_TICKS);
    expect(tokens).not.toContain(undefined);
    expect(b.fake.live()).toHaveLength(0);
    expect(await b.reasons("agent_log_failed")).toEqual(["stalled", "unreadable"]);
    // the timer is done; the end of a step still copies and counts
    await b.run.completeStep("a", 1);
    const saved = (await b.run.journal()).filter((rec) => rec.event === "agent_log_saved");
    expect(saved.map((rec) => rec["why"])).toEqual(["step"]);
    expect(await b.reasons("usage_failed")).toEqual([]);
  });

  test("task_7bh9_ensure_does_not_get_stuck_on_candidates", async () => {
    const b = await boundRig();
    const finder = (b.writer as unknown as { finder: { hasCandidates(): Promise<boolean> } })
      .finder;
    const real = finder.hasCandidates.bind(finder);
    // the read of the hook index never answers
    finder.hasCandidates = () => new Promise<boolean>(() => undefined);
    const timers = manualTimers();
    const tickers = new AgentLogTickers(b.writer, timers.timers);
    const run = b.run.agentLogRun();
    const ensured = tickers.ensure(run);
    const seen = watch(ensured);
    await until(() => b.pass.live(GIVE_UP_WAIT_MS).length === 1, "the wait for the candidates");
    await settle();
    expect(seen.done).toBe(false);
    await b.pass.fire(GIVE_UP_WAIT_MS);
    await ensured;
    expect(timers.all).toHaveLength(0);
    expect(tickers.lastRefusal).toBe("no_candidates");
    // nothing is left behind that would keep a later call from trying again
    finder.hasCandidates = real;
    await tickers.ensure(run);
    expect(timers.live()).toHaveLength(1);
    expect(tickers.lastRefusal).toBeUndefined();
    expect(b.pass.live()).toEqual([]);
  });
});
