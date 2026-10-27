import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentLogConfig,
  defaultAgentLog,
  defaultHistory,
  type HistoryConfig,
  type HistoryEvent,
  historyEventSchema,
  type RedactRule,
  type RunState,
} from "@kodel-ai/pipeline-core";
import { ClaudeLogBuilder } from "../../testkit/src";
import {
  type AgentLogRun,
  AgentLogWriter,
  agentLogRoom,
  FileStore,
  LocalPipelineHost,
  type LocalRun,
  readStoredAgentLog,
} from "../src";
import { claudeCodeCollector } from "../src/history";

const SESSION = "33333333-3333-4333-8333-333333333333";
const OLD = "44444444-4444-4444-8444-444444444444";

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
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-agent-log-run-")));
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
  await rm(dir, { recursive: true, force: true });
  await rm(claude, { recursive: true, force: true });
});

const logConfig = (over: Partial<AgentLogConfig> = {}): HistoryConfig => ({
  ...defaultHistory(),
  agent_log: { ...defaultAgentLog(), interval_s: 0, ...over },
});

interface Rig {
  host: LocalPipelineHost;
  run: LocalRun;
  runId: string;
  store: FileStore;
  writer: AgentLogWriter;
  env: NodeJS.ProcessEnv;
}

async function rig(
  options: {
    history?: HistoryConfig;
    session?: string | null;
    writer?: (store: FileStore, env: () => NodeJS.ProcessEnv) => AgentLogWriter;
    /** Project redaction rules, for the host (the journal) and for the writer alike. */
    rules?: RedactRule[];
  } = {},
): Promise<Rig> {
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude };
  if (options.session !== null) env["CLAUDE_CODE_SESSION_ID"] = options.session ?? SESSION;
  const store = new FileStore({ root: join(dir, ".kodel") });
  const writer =
    options.writer?.(store, () => env) ??
    new AgentLogWriter({ store, root: dir, rules: options.rules ?? [], env: () => env });
  const host = new LocalPipelineHost({
    root: dir,
    heartbeatMs: 0,
    environment: env,
    history: options.history ?? logConfig(),
    agentLog: writer,
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  });
  const started = await host.start({ pipeline: "two", task: "t", restart: false });
  const run = started.run as LocalRun;
  return { host, run, runId: run.runId, store, writer, env };
}

/** The start of the run as the agent's log has it, then whatever `more` adds. */
function sessionLog(
  runId: string,
  session = SESSION,
  more: (log: ClaudeLogBuilder) => void = () => undefined,
): ClaudeLogBuilder {
  const log = new ClaudeLogBuilder({ sessionId: session, cwd: dir });
  log
    .user("please run the pipeline")
    .say("msg_0", "starting it")
    .call("msg_0", { id: "toolu_start", name: "mcp__kodel__pipeline_start", input: { task: "t" } })
    .result("toolu_start", [{ type: "text", text: JSON.stringify({ ok: true, run_id: runId }) }])
    .say("msg_1", "I will do step a")
    .call("msg_1", { id: "toolu_bash", name: "Bash", input: { command: "echo hello" } })
    .result("toolu_bash", "hello")
    .say("msg_2", "that worked");
  more(log);
  return log;
}

const installed = (log: ClaudeLogBuilder) => log.install(claude);

const stateOf = (rig: Rig): Promise<RunState> => rig.run.state();

async function stored(rig: Rig, session = SESSION): Promise<HistoryEvent[]> {
  const state = await stateOf(rig);
  const length = state.agentLog?.sessions[session]?.length ?? 0;
  const text = (await rig.store.readAgentLog(rig.runId, session, length)) ?? "";
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as HistoryEvent);
}

const journalOf = async (rig: Rig) => rig.run.journal();

const capture = (rig: Rig, why: "tick" | "step" = "tick", node = "a") =>
  rig.writer.capture(rig.run.agentLogRun(), {
    why,
    waitMs: 0,
    ...(why === "step" ? { step: { node, attempt: 1 } } : {}),
  });

describe("t3bk2 the copy of the agent's log into a run", () => {
  test("t3bk2_round_trip", async () => {
    const r = await rig();
    await installed(sessionLog(r.runId));
    const result = await capture(r);
    expect(result).toMatchObject({ saved: 1, streams: [SESSION], failures: [] });
    const events = await stored(r);
    expect(events.length).toBeGreaterThan(4);
    for (const event of events) expect(historyEventSchema.safeParse(event).success).toBe(true);
    // the window starts at the call that started the run: the person's request and the first words are outside
    expect(events.map((e) => e.kind === "message" && e.text_preview).filter(Boolean)).not.toContain(
      "please run the pipeline",
    );
    expect(events.find((e) => e.kind === "tool_call")).toMatchObject({
      name: "mcp__kodel__pipeline_start",
    });
    expect(events.find((e) => e.kind === "tool_result" && e.id === "toolu_bash")).toMatchObject({
      output_preview: "hello",
    });
    const state = await stateOf(r);
    const file = join(r.store.runDir(r.runId), "agent_log", `${SESSION}.jsonl`);
    expect(state.agentLog?.sessions[SESSION]?.length).toBe((await stat(file)).size);
    const saved = (await journalOf(r)).find((rec) => rec.event === "agent_log_saved");
    expect(saved).toMatchObject({ session: SESSION, why: "tick", first_seq: 1, stream_from: 0 });
  });

  test("t3bk2_pass_idempotent", async () => {
    const r = await rig();
    await installed(sessionLog(r.runId));
    expect((await capture(r)).saved).toBe(1);
    const before = await readFile(
      join(r.store.runDir(r.runId), "agent_log", `${SESSION}.jsonl`),
      "utf8",
    );
    expect((await capture(r)).saved).toBe(0);
    expect((await capture(r)).saved).toBe(0);
    expect(
      await readFile(join(r.store.runDir(r.runId), "agent_log", `${SESSION}.jsonl`), "utf8"),
    ).toBe(before);
    expect((await journalOf(r)).filter((rec) => rec.event === "agent_log_saved")).toHaveLength(1);
  });

  test("t3bk2_pass_continues_from_the_checkpoint", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await installed(log);
    await capture(r);
    const first = (await stored(r)).length;
    log.say("msg_2", "more words").say("msg_3", "and more");
    await writeFile(path, log.text());
    expect((await capture(r)).saved).toBe(1);
    const events = await stored(r);
    expect(events.length).toBeGreaterThan(first);
    // one stream, numbered once, in order, nothing twice
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("t3bk2_step_pass_comes_before_the_step_is_judged", async () => {
    const r = await rig();
    await installed(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    const journal = await journalOf(r);
    const events = journal.map((rec) => rec.event);
    expect(events.indexOf("agent_log_saved")).toBeGreaterThan(-1);
    expect(events.indexOf("agent_log_saved")).toBeLessThan(events.indexOf("agent_completed"));
    expect(journal.find((rec) => rec.event === "agent_log_saved")).toMatchObject({
      why: "step",
      node: "a",
      attempt: 1,
    });
  });

  test("t3bk2_last_pass_before_run_finished", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await installed(log);
    await r.run.completeStep("a", 1);
    log.say("msg_5", "step b done");
    await writeFile(path, log.text());
    await r.run.completeStep("b", 1);
    const events = (await journalOf(r)).map((rec) => rec.event);
    const finished = events.indexOf("run_finished");
    expect(finished).toBeGreaterThan(-1);
    const lastSaved = events.lastIndexOf("agent_log_saved");
    expect(lastSaved).toBeGreaterThan(-1);
    expect(lastSaved).toBeLessThan(finished);
    const state = await stateOf(r);
    expect(state.status).toBe("completed");
    expect((await r.run.report()).agent_log).toMatchObject({ final_pass: true, unverified: true });
  });

  test("t3bk2_finished_run_not_journaled", async () => {
    const r = await rig();
    await installed(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    await r.run.completeStep("b", 1);
    const before = (await journalOf(r)).length;
    const dirBefore = await readFile(
      join(r.store.runDir(r.runId), "agent_log", `${SESSION}.jsonl`),
      "utf8",
    );
    expect(await capture(r)).toMatchObject({ skipped: "not_running", saved: 0 });
    expect(await capture(r, "step", "b")).toMatchObject({ skipped: "not_running" });
    expect((await journalOf(r)).length).toBe(before);
    expect(
      await readFile(join(r.store.runDir(r.runId), "agent_log", `${SESSION}.jsonl`), "utf8"),
    ).toBe(dirBefore);
    // and the machine refuses an event, whoever sends it
    const late = await r.run.apply({
      type: "agent_log_failed",
      reason: "log_missing",
    });
    expect(late).toMatchObject({ noop: true });
  });

  test("t3bk2_other_end_incomplete", async () => {
    const r = await rig();
    await installed(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    await capture(r); // the ticker, during step b
    await r.run.cancel();
    const report = (await r.run.report()).agent_log;
    expect(report).toMatchObject({ final_pass: false });
  });
});

describe("t3bk2 which sessions belong to the run", () => {
  const index = async (...lines: object[]) => {
    await mkdir(join(dir, ".kodel"), { recursive: true });
    await appendFile(
      join(dir, ".kodel", "sessions.jsonl"),
      lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
    );
  };
  const hooked = (session: string, path: string) => ({
    session_id: session,
    agent: "claude-code",
    transcript_path: path,
    cwd: dir,
    ts: "2026-10-21T10:00:00.000Z",
  });

  test("t3bk2_proof_no_candidates_unknown", async () => {
    const r = await rig({ session: null });
    // a step of the agent with no session to copy: a reason, journaled once, and the step goes on
    expect(await capture(r, "step")).toMatchObject({ saved: 0, failures: ["session_unknown"] });
    await r.run.completeStep("a", 1);
    expect((await stateOf(r)).nodes["a"]?.status).not.toBe("running");
    expect((await journalOf(r)).filter((rec) => rec.event === "agent_log_failed")).toHaveLength(1);
    expect((await r.run.report()).agent_log).toMatchObject({
      sessions: 0,
      failed: ["session_unknown"],
    });
  });

  test("t3bk2_proof_no_failure_from_the_ticker_before_the_first_step", async () => {
    const r = await rig({ session: null });
    expect(await capture(r)).toMatchObject({ saved: 0, failures: [] });
    expect((await journalOf(r)).filter((rec) => rec.event === "agent_log_failed")).toHaveLength(0);
  });

  test("t3bk2_proof_env_session_without_the_run_id_is_unknown", async () => {
    const r = await rig();
    // a log that never called the run's tools: the environment says the session, the log does not agree
    const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd: dir });
    log.user("hello").say("msg_1", "hi").say("msg_2", "again");
    await installed(log);
    expect(await capture(r, "step")).toMatchObject({ saved: 0, failures: ["session_unknown"] });
    expect(await r.store.agentLogSize(r.runId, SESSION)).toBeUndefined();
  });

  test("t3bk2_proof_clear_new_session_via_index", async () => {
    // after /clear the server's environment still names the old session; the hook index names the new one
    const r = await rig({ session: OLD });
    const oldLog = sessionLog(r.runId, OLD);
    await installed(oldLog);
    const newLog = new ClaudeLogBuilder({
      sessionId: SESSION,
      cwd: dir,
      start: "2026-10-21T12:00:00.000Z",
    });
    newLog
      .user("continue")
      .call("msg_n1", {
        id: "toolu_n1",
        name: "mcp__kodel__pipeline_next_step",
        input: { run_id: r.runId },
      })
      .result("toolu_n1", "ok")
      .say("msg_n2", "going on")
      .say("msg_n3", "still");
    const newPath = await installed(newLog);
    await index(hooked(SESSION, newPath));
    const result = await capture(r, "step");
    expect(result.streams.sort()).toEqual([OLD, SESSION].sort());
    // each from the first call of the run in it
    expect((await stored(r, SESSION))[1]).toMatchObject({
      kind: "tool_call",
      name: "mcp__kodel__pipeline_next_step",
    });
    expect((await stored(r, OLD)).find((e) => e.kind === "tool_call")).toMatchObject({
      name: "mcp__kodel__pipeline_start",
    });
  });

  test("t3bk2_proof_later_session_keeps_first_file", async () => {
    // the environment names another session at a later step (the server was started again): the first file stays
    const r = await rig({ session: SESSION });
    const first = sessionLog(r.runId);
    await installed(first);
    expect((await capture(r, "step")).streams).toEqual([SESSION]);
    const keptLength = (await stateOf(r)).agentLog?.sessions[SESSION]?.length ?? 0;
    expect(keptLength).toBeGreaterThan(0);
    r.env["CLAUDE_CODE_SESSION_ID"] = OLD;
    const second = new ClaudeLogBuilder({
      sessionId: OLD,
      cwd: dir,
      start: "2026-10-21T14:00:00.000Z",
    });
    second
      .call("msg_o1", {
        id: "toolu_o1",
        name: "mcp__kodel__pipeline_next_step",
        input: { run_id: r.runId },
      })
      .result("toolu_o1", "ok")
      .say("msg_o2", "continuing")
      .say("msg_o3", "still");
    await installed(second);
    const result = await capture(r, "step");
    expect(result.streams).toContain(OLD);
    const after = (await stateOf(r)).agentLog?.sessions;
    expect(after?.[SESSION]?.length).toBe(keptLength);
    expect(after?.[OLD]?.length).toBeGreaterThan(0);
  });

  test("t3bk2_proof_index_session_without_run_id_refused", async () => {
    const r = await rig({ session: OLD });
    await installed(sessionLog(r.runId, OLD));
    // the person's other conversation in the same project: it is in the index, but it never touched this run
    const other = new ClaudeLogBuilder({ sessionId: SESSION, cwd: dir });
    other.user("unrelated").say("msg_x", "text").say("msg_y", "more");
    const path = await installed(other);
    await index(hooked(SESSION, path));
    const result = await capture(r, "step");
    expect(result.streams).toEqual([OLD]);
    expect(await r.store.agentLogSize(r.runId, SESSION)).toBeUndefined();
  });

  test("t3bk2_proof_other_run_id_is_unknown", async () => {
    const r = await rig();
    await installed(sessionLog("r_0zzzzzzzz_aaaa"));
    expect(await capture(r, "step")).toMatchObject({ saved: 0, failures: ["session_unknown"] });
  });

  test("t3bk2_proof_cross_project_refused", async () => {
    const r = await rig();
    // the right run id in a log whose working directory is another project's
    const foreign = join(dir, "..", `foreign-${Date.now()}`);
    await mkdir(join(foreign, ".kodel"), { recursive: true });
    const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd: foreign });
    log
      .call("msg_1", { id: "t1", name: "mcp__kodel__pipeline_start", input: {} })
      .result("t1", JSON.stringify({ run_id: r.runId }))
      .say("msg_2", "x")
      .say("msg_3", "y");
    const path = await log.install(claude, join("-fake-project-folder"));
    await index(hooked(SESSION, path));
    try {
      const result = await capture(r, "step");
      expect(result.streams).toEqual([]);
      expect(result.failures).toContain("refused");
      expect(await r.store.agentLogSize(r.runId, SESSION)).toBeUndefined();
    } finally {
      await rm(foreign, { recursive: true, force: true });
    }
  });

  test("t3bk2_forged_own_server_documented_gap", async () => {
    // an agent that names the run in a call of a session of the same project is taken for that run's: a gap the docs
    // state (residual risks); the copy is display data and holds nothing that session did not already hold
    const r = await rig({ session: null });
    const forged = new ClaudeLogBuilder({ sessionId: OLD, cwd: dir });
    forged
      .call("msg_1", {
        id: "t1",
        name: "mcp__kodel__pipeline_next_step",
        input: { run_id: r.runId },
      })
      .say("msg_2", "a")
      .say("msg_3", "b");
    const path = await installed(forged);
    await index(hooked(OLD, path));
    expect((await capture(r, "step")).streams).toEqual([OLD]);
  });

  test("t3bk2_proof_bad_session_ids_are_not_candidates", async () => {
    const r = await rig({ session: "../escape" });
    await index(hooked("con", "/nowhere"), hooked("a b", "/nowhere"), {
      session_id: 7,
      agent: "claude-code",
    });
    const result = await capture(r, "step");
    expect(result.streams).toEqual([]);
    // none of them is a name that can be a file, and nothing was stored under any
    await expect(r.store.agentLogSize(r.runId, "con")).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS",
    });
    expect(Object.keys((await stateOf(r)).agentLog?.sessions ?? {})).toEqual([]);
  });

  test("t3bk2_proof_missing_log_not_collected", async () => {
    const r = await rig(); // the environment names a session whose log is not in the store
    expect(await capture(r, "step")).toMatchObject({ saved: 0, failures: ["log_missing"] });
    expect((await r.run.report()).agent_log).toMatchObject({
      sessions: 0,
      failed: ["log_missing"],
    });
  });
});

/** A writer that counts how often the log is read, and can hold a read until the test lets it go. */
function spyWriter(
  spy: { reads: number; gate?: Promise<void> },
  extra: Partial<ConstructorParameters<typeof AgentLogWriter>[0]> = {},
) {
  return (store: FileStore, env: () => NodeJS.ProcessEnv) =>
    new AgentLogWriter({
      store,
      root: dir,
      rules: [],
      env,
      collector: (configDir) => {
        const real = claudeCodeCollector({ configDir, cacheScope: true });
        return {
          ...real,
          read: async function* (ref, window, options) {
            spy.reads += 1;
            if (spy.gate !== undefined) await spy.gate;
            yield* real.read(ref, window, options);
          },
        };
      },
      ...extra,
    });
}

describe("t3bk2 what a pass does and does not read", () => {
  test("t3bk2_refused_call_reads_nothing", async () => {
    const spy = { reads: 0 };
    const r = await rig({ writer: spyWriter(spy) });
    await installed(sessionLog(r.runId));
    // a step that is not the one the run is at: nothing is read, and the machine refuses the call
    await r.run.completeStep("a", 7);
    await r.run.completeStep("zzz", 1);
    expect(spy.reads).toBe(0);
    expect((await journalOf(r)).some((rec) => rec.event === "agent_log_saved")).toBe(false);
  });

  test("t3bk2_forged_node_reads_nothing", async () => {
    const spy = { reads: 0 };
    const r = await rig({ writer: spyWriter(spy) });
    await installed(sessionLog(r.runId));
    // the node comes from the state, not from the call: step b has not been entered
    expect(await capture(r, "step", "b")).toMatchObject({ skipped: "no_step" });
    expect(spy.reads).toBe(0);
  });

  test("t3bk2_pending_change_noop_first", async () => {
    const spy = { reads: 0 };
    const r = await rig({ writer: spyWriter(spy) });
    await installed(sessionLog(r.runId));
    const changed = PIPELINE.replace("do b", "do b differently");
    expect((await r.run.proposeChange({ yaml: changed, summary: "s" })).ok).toBe(true);
    const decision = await r.run.completeStep("a", 1);
    expect(decision).toMatchObject({ ok: true, noop: true });
    // the step was not judged, so nothing was copied for it
    expect(spy.reads).toBe(0);
  });

  test("t3bk2_run_lock_not_held_at_apply", async () => {
    const r = await rig();
    await installed(sessionLog(r.runId));
    const seen: { runLock: boolean; copyLock: boolean }[] = [];
    const run = r.run.agentLogRun();
    const spyRun: AgentLogRun = {
      ...run,
      apply: async (event) => {
        if (event.type === "agent_log_saved") {
          const exists = (name: string) =>
            stat(join(r.store.runDir(r.runId), name)).then(
              () => true,
              () => false,
            );
          seen.push({ runLock: await exists("lock"), copyLock: await exists("agent_log.lock") });
        }
        return run.apply(event);
      },
    };
    await r.writer.capture(spyRun, { why: "tick", waitMs: 0 });
    // the lock on copying is held through the journal write; the run's own is not (the lock order is copy, then run)
    expect(seen).toEqual([{ runLock: false, copyLock: true }]);
    await expect(stat(join(r.store.runDir(r.runId), "agent_log.lock"))).rejects.toThrow();
  });

  test("t3bk2_pass_outside_run_lock", async () => {
    let release: () => void = () => undefined;
    const spy = { reads: 0, gate: new Promise<void>((resolve) => (release = resolve)) };
    const r = await rig({ writer: spyWriter(spy) });
    await installed(sessionLog(r.runId));
    const pass = capture(r);
    // the read is held; the run can still be asked and written to
    while (spy.reads === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const state = await Promise.race([
      r.store.withLock(r.runId, async () => "free"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
    ]);
    expect(state).toBe("free");
    expect((await r.run.state()).status).toBe("running");
    release();
    expect((await pass).saved).toBe(1);
  });

  test("t3bk2_concurrent_passes", async () => {
    let release: () => void = () => undefined;
    const spy = { reads: 0, gate: new Promise<void>((resolve) => (release = resolve)) };
    const r = await rig({ writer: spyWriter(spy) });
    const other = spyWriter({ reads: 0 })(r.store, () => r.env);
    await installed(sessionLog(r.runId));
    const first = capture(r);
    while (spy.reads === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    // another process (here: another writer) meets the lock held: it skips, it does not wait or write
    expect(await other.capture(r.run.agentLogRun(), { why: "tick", waitMs: 0 })).toMatchObject({
      skipped: "busy",
      saved: 0,
    });
    release();
    expect((await first).saved).toBe(1);
    const saved = (await journalOf(r)).filter((rec) => rec.event === "agent_log_saved");
    expect(saved).toHaveLength(1);
  });
});

describe("t3bk2 crashes, restarts and two writers", () => {
  test("t3bk2_crash_before_journal", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await installed(log);
    const real = r.run.agentLogRun();
    let failing = true;
    const flaky: AgentLogRun = {
      ...real,
      apply: async (event) => {
        if (event.type === "agent_log_saved" && failing) throw new Error("the process died here");
        return real.apply(event);
      },
    };
    // the bytes are on disk, the journal does not know
    await r.writer.capture(flaky, { why: "tick", waitMs: 0 });
    const file = join(r.store.runDir(r.runId), "agent_log", `${SESSION}.jsonl`);
    expect((await stat(file)).size).toBeGreaterThan(0);
    expect((await stateOf(r)).agentLog?.sessions[SESSION]).toBeUndefined();
    // the next pass drops what was never vouched for and stores it once
    failing = false;
    log.say("msg_3", "later");
    await writeFile(path, log.text());
    expect((await capture(r)).saved).toBe(1);
    const events = await stored(r);
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect((await stat(file)).size).toBe(
      (await stateOf(r)).agentLog?.sessions[SESSION]?.length ?? -1,
    );
  });

  test("t3bk2_crash_after_journal", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await installed(log);
    await capture(r);
    const before = await stored(r);
    // the server restarts: a writer with nothing in memory continues from the journal
    log.say("msg_3", "after the restart").say("msg_4", "and again");
    await writeFile(path, log.text());
    const fresh = new AgentLogWriter({ store: r.store, root: dir, rules: [], env: () => r.env });
    const result = await fresh.capture(r.run.agentLogRun(), { why: "tick", waitMs: 0 });
    expect(result.saved).toBe(1);
    const after = await stored(r);
    expect(after.slice(0, before.length)).toEqual(before);
    const seqs = after.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(after.length).toBeGreaterThan(before.length);
    // the same as a writer that never restarted would have stored
    const state = await stateOf(r);
    expect(state.agentLog?.sessions[SESSION]?.last_seq).toBe(after.at(-1)?.seq);
  });

  test("t3bk2_two_hosts_no_duplicates", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await installed(log);
    const other = new AgentLogWriter({ store: r.store, root: dir, rules: [], env: () => r.env });
    await capture(r); // writer one
    log.say("msg_3", "one more").say("msg_4", "and one");
    await writeFile(path, log.text());
    await other.capture(r.run.agentLogRun(), { why: "tick", waitMs: 0 }); // writer two takes the new part
    log.say("msg_5", "more").say("msg_6", "still more");
    await writeFile(path, log.text());
    await capture(r); // writer one again, with a checkpoint the journal has left behind
    const events = await stored(r);
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const messages = events
      .filter((e) => e.kind === "message")
      .map((e) => e.kind === "message" && e.message_id);
    expect(new Set(messages).size).toBe(messages.length);
    expect(messages).toContain("msg_5");
  });

  test("t3bk2_torn_tail_not_stored", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await installed(log);
    const more = new ClaudeLogBuilder({
      sessionId: SESSION,
      cwd: dir,
      start: "2026-10-21T11:00:00.000Z",
    });
    more.say("msg_3", "the next response").say("msg_4", "and the one after");
    const half = more.lines[0] ?? "";
    await appendFile(path, half.slice(0, 50));
    await capture(r);
    const first = await stored(r);
    expect(first.some((e) => e.kind === "message" && e.message_id === "msg_3")).toBe(false);
    await appendFile(path, `${half.slice(50)}\n${more.lines[1] ?? ""}\n`);
    await appendFile(
      path,
      `${new ClaudeLogBuilder({ sessionId: SESSION, cwd: dir, start: "2026-10-21T11:05:00.000Z" }).say("msg_5", "closes it").lines[0]}\n`,
    );
    await capture(r);
    const events = await stored(r);
    expect(events.filter((e) => e.kind === "message" && e.message_id === "msg_3")).toHaveLength(1);
  });

  test("t3bk2_race_tail_not_read", async () => {
    const r = await rig();
    await installed(sessionLog(r.runId));
    await capture(r);
    const file = join(r.store.runDir(r.runId), "agent_log", `${SESSION}.jsonl`);
    const length = (await stateOf(r)).agentLog?.sessions[SESSION]?.length ?? 0;
    // a pass that died after appending leaves a tail the journal does not know
    await appendFile(file, '{"v":1,"half');
    const read = await readStoredAgentLog(r.store, r.runId, SESSION, length);
    expect(read.ok).toBe(true);
    expect(read.events.length).toBeGreaterThan(0);
  });

  test("t3bk2_log_changed_stops_once", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await installed(log);
    await capture(r);
    // the log is replaced by a shorter one: the cursor means nothing now
    const shorter = new ClaudeLogBuilder({ sessionId: SESSION, cwd: dir });
    shorter
      .call("msg_0", { id: "toolu_start", name: "mcp__kodel__pipeline_start", input: {} })
      .result("toolu_start", JSON.stringify({ run_id: r.runId }))
      .say("msg_1", "x")
      .say("msg_2", "y");
    await writeFile(path, shorter.text());
    const second = await r.writer.capture(r.run.agentLogRun(), {
      why: "step",
      waitMs: 0,
      step: { node: "a", attempt: 1 },
    });
    expect(second.failures).toEqual(["log_changed"]);
    const third = await capture(r);
    expect(third).toMatchObject({ saved: 0 });
    expect((await journalOf(r)).filter((rec) => rec.event === "agent_log_failed")).toHaveLength(1);
  });

  test("t3bk2_rule_change_not_log_changed", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await installed(log);
    await capture(r);
    // a project redaction rule added while the run goes (and the server restarted): the key is of the event, not its text
    const rules = [{ name: "any", pattern: /hello/g }];
    const fresh = new AgentLogWriter({ store: r.store, root: dir, rules, env: () => r.env });
    log.say("msg_3", "later").say("msg_4", "more");
    await writeFile(path, log.text());
    const result = await fresh.capture(r.run.agentLogRun(), { why: "tick", waitMs: 0 });
    expect(result).toMatchObject({ saved: 1, failures: [] });
  });
});

describe("t3bk2 the share of each step", () => {
  const state = (nodes: string[], bytes = 0) => ({ agentLog: { nodes, bytes } }) as never;
  const kb = (max_kb: number) => ({ max_kb });

  test("t3bk2_budget_cumulative", () => {
    const nodes = ["a", "b", "c", "d"];
    // the share of a step is the part of the bound up to its node, less what the steps before it used
    expect(agentLogRoom(state(nodes), kb(4), { node: "a" })).toBe(1024);
    expect(agentLogRoom(state(nodes), kb(4), { node: "b" })).toBe(2048);
    expect(agentLogRoom(state(nodes, 500), kb(4), { node: "b" })).toBe(1548);
    expect(agentLogRoom(state(nodes, 3000), kb(4), { node: "d" })).toBe(1096);
  });

  test("t3bk2_budget_floor", () => {
    const nodes = ["a", "b", "c"];
    expect(agentLogRoom(state(nodes), kb(1), { node: "a" })).toBe(341);
    expect(agentLogRoom(state(nodes), kb(1), { node: "b" })).toBe(682);
    expect(agentLogRoom(state(nodes), kb(1), { node: "c" })).toBe(1024);
  });

  test("t3bk2_budget_dev_pipeline_shape", () => {
    // 13 nodes, 5 of them the agent's: the shares of the nodes that never copy flow on to the ones that do
    const nodes = Array.from({ length: 13 }, (_, i) => `n${i}`);
    const agent = [1, 3, 5, 8, 11];
    const total = 20 * 1024;
    let used = 0;
    const rooms: number[] = [];
    for (const i of agent) {
      const room = agentLogRoom(state(nodes, used), kb(20), { node: `n${i}` });
      rooms.push(room);
      used += Math.floor(room / 2); // each step uses half of what it was offered
    }
    expect(rooms[0]).toBe(Math.floor((total * 2) / 13));
    // later steps are offered more than a fifth of the bound each, because the steps before them took less
    expect(rooms[4] ?? 0).toBeGreaterThan(total / 5);
    expect(used).toBeLessThanOrEqual(total);
  });

  test("t3bk2_budget_revisit", () => {
    const nodes = ["a", "b", "c", "d"];
    // step a came again after it used all it was given: it has the share of its own node, not nothing
    expect(agentLogRoom(state(nodes, 1024), kb(4), { node: "a" })).toBe(1024);
    // and never more than what is left
    expect(agentLogRoom(state(nodes, 3584), kb(4), { node: "a" })).toBe(512);
  });

  test("t3bk2_budget_added_node_uses_remainder", () => {
    const nodes = ["a", "b"];
    expect(agentLogRoom(state(nodes, 1000), kb(4), { node: "added-later" })).toBe(4096 - 1000);
    expect(agentLogRoom(state([], 0), kb(4), { node: "any" })).toBe(4096);
  });

  test("t3bk2_budget_total_never_exceeds", () => {
    // a property: whatever order the steps come in and whatever each takes of its offer, the run never passes the bound
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 200; round++) {
      const nodes = Array.from({ length: 1 + Math.floor(next() * 12) }, (_, i) => `n${i}`);
      const max_kb = 1 + Math.floor(next() * 30);
      let used = 0;
      for (let step = 0; step < 60; step++) {
        const node =
          next() < 0.1 ? "unknown" : (nodes[Math.floor(next() * nodes.length)] as string);
        const room = agentLogRoom(state(nodes, used), kb(max_kb), { node });
        expect(room).toBeGreaterThanOrEqual(0);
        used += Math.floor(room * next());
        expect(used).toBeLessThanOrEqual(max_kb * 1024);
      }
    }
  });

  test("t3bk2_budget_event_over_allowance_and_marker_count", async () => {
    const r = await rig({ history: logConfig({ max_kb: 1 }) });
    const log = sessionLog(r.runId);
    for (let i = 0; i < 40; i++)
      log.say(`msg_x${i}`, `a fairly long sentence number ${i} ${"y".repeat(60)}`);
    await installed(log);
    const result = await r.writer.capture(r.run.agentLogRun(), {
      why: "step",
      waitMs: 0,
      step: { node: "a", attempt: 1 },
    });
    expect(result.saved).toBe(1);
    const state = await stateOf(r);
    const length = state.agentLog?.sessions[SESSION]?.length ?? 0;
    expect(length).toBeLessThanOrEqual(1024);
    const saved = (await journalOf(r)).find((rec) => rec.event === "agent_log_saved");
    const cut = (saved?.["cut"] as number) ?? 0;
    expect(cut).toBeGreaterThan(0);
    expect(state.agentLog?.cut).toBe(cut);
    const events = await stored(r);
    const marker = events.at(-1);
    // one mark, last, and it counts what was left out; every line whole
    expect(marker).toMatchObject({
      kind: "system",
      subtype: "agent_log_cut",
      detail: `${cut} event(s) left out`,
    });
    expect(events.filter((e) => e.kind === "system" && e.subtype === "agent_log_cut")).toHaveLength(
      1,
    );
    expect(historyEventSchema.safeParse(marker).success).toBe(true);
    const text = (await r.store.readAgentLog(r.runId, SESSION, length)) ?? "";
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("t3bk2 what a failure does", () => {
  test("t3bk2_failure_never_fails_step", async () => {
    const r = await rig();
    await installed(sessionLog(r.runId));
    r.store.appendAgentLog = async () => {
      throw new Error("disk full");
    };
    const decision = await r.run.completeStep("a", 1);
    expect(decision.ok).toBe(true);
    const state = await stateOf(r);
    expect(state.nodes["a"]?.status).not.toBe("running");
    expect(state.agentLog?.sessions).toEqual({});
  });

  test("t3bk2_failure_read_only_directory", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const r = await rig();
    await installed(sessionLog(r.runId));
    const folder = join(r.store.runDir(r.runId), "agent_log");
    await mkdir(folder, { recursive: true });
    await chmod(folder, 0o500);
    try {
      const decision = await r.run.completeStep("a", 1);
      expect(decision.ok).toBe(true);
      expect((await stateOf(r)).agentLog?.sessions).toEqual({});
    } finally {
      await chmod(folder, 0o700);
    }
  });

  test("t3bk2_worktree_removed", async () => {
    // the session worked in a worktree that is gone by the time of the copy: it is still the run's own directory
    const r = await rig();
    // a worktree outside the repository (the config can put them anywhere), removed with the run
    const gone = join(dir, "..", `gone-worktree-${Date.now()}`);
    const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd: gone });
    log
      .call("msg_0", { id: "toolu_start", name: "mcp__kodel__pipeline_start", input: {} })
      .result("toolu_start", JSON.stringify({ run_id: r.runId }))
      .say("msg_1", "in the worktree")
      .say("msg_2", "still");
    await log.install(claude, join("-worktree-folder"));
    const index = join(dir, ".kodel", "sessions.jsonl");
    await writeFile(
      index,
      `${JSON.stringify({ session_id: SESSION, agent: "claude-code", transcript_path: join(claude, "projects", "-worktree-folder", `${SESSION}.jsonl`), cwd: gone, ts: "2026-10-21T10:00:00.000Z" })}\n`,
    );
    const run = r.run.agentLogRun();
    const without = await r.writer.capture(
      { ...run, workdir: async () => undefined },
      { why: "tick", waitMs: 0 },
    );
    // not the project's, as far as the host can tell: refused, said once, and tried again when it is told more
    expect(without.streams).toEqual([]);
    expect(without.failures).toEqual(["refused"]);
    const withIt = await r.writer.capture(
      { ...run, workdir: async () => gone },
      { why: "tick", waitMs: 0 },
    );
    expect(withIt.streams).toEqual([SESSION]);
  });

  test("t3bk2_missing_log_not_collected", async () => {
    const r = await rig();
    // the log was deleted by the agent's own cleanup after the run began: not collected, no crash, the step goes on
    await installed(sessionLog(r.runId));
    await rm(claude, { recursive: true, force: true });
    const decision = await r.run.completeStep("a", 1);
    expect(decision.ok).toBe(true);
    expect((await r.run.report()).agent_log).toMatchObject({
      sessions: 0,
      failed: ["log_missing"],
    });
  });
});

describe("t3bk2 what is in the stored events", () => {
  const withSubagent = async (
    r: Rig,
    mutate: (log: ClaudeLogBuilder) => void = () => undefined,
  ) => {
    const log = sessionLog(r.runId);
    mutate(log);
    const path = await installed(log);
    const child = new ClaudeLogBuilder({
      sessionId: "agent-abc123",
      cwd: dir,
      start: "2026-10-21T10:30:00.000Z",
    });
    child.user("review the change").say("msg_s1", "I looked at it").say("msg_s2", "all fine");
    const folder = join(path, "..", SESSION, "subagents");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "agent-abc123.jsonl"), child.text());
    return { path, folder };
  };

  test("t3bk2_subagent_files_marked", async () => {
    const r = await rig();
    await withSubagent(r);
    const result = await capture(r);
    expect(result.streams.sort()).toEqual(["agent-abc123", SESSION].sort());
    const child = await stored(r, "agent-abc123");
    expect(child.length).toBeGreaterThan(1);
    for (const event of child)
      expect(event).toMatchObject({ parent_session_id: SESSION, session_id: "agent-abc123" });
    expect((await journalOf(r)).find((rec) => rec["session"] === "agent-abc123")).toMatchObject({
      parent: SESSION,
    });
  });

  test("t3bk2_subagent_parent_not_proven", async () => {
    const r = await rig();
    // a session that never touched this run, with a subagent log of its own
    const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd: dir });
    log.user("hi").say("msg_1", "a").say("msg_2", "b");
    const path = await installed(log);
    const folder = join(path, "..", SESSION, "subagents");
    await mkdir(folder, { recursive: true });
    const child = new ClaudeLogBuilder({ sessionId: "agent-zzz", cwd: dir });
    child.user("x").say("msg_s", "y").say("msg_t", "z");
    await writeFile(join(folder, "agent-zzz.jsonl"), child.text());
    expect((await capture(r, "step")).streams).toEqual([]);
    expect(await r.store.agentLogSize(r.runId, "agent-zzz")).toBeUndefined();
  });

  test("t3bk2_subagent_older_than_the_run_is_left_out", async () => {
    const r = await rig();
    const { folder } = await withSubagent(r);
    const early = new ClaudeLogBuilder({
      sessionId: "agent-early",
      cwd: dir,
      start: "2026-10-21T08:00:00.000Z",
    });
    early.user("old work").say("msg_e1", "x").say("msg_e2", "y");
    await writeFile(join(folder, "agent-early.jsonl"), early.text());
    const result = await capture(r);
    expect(result.streams).not.toContain("agent-early");
    expect(result.streams).toContain("agent-abc123");
  });

  test("t3bk2_tool_log_off_no_tool_or_subagent", async () => {
    const history = logConfig();
    history.tool_log = { enabled: false };
    const r = await rig({ history });
    await withSubagent(r);
    const result = await capture(r);
    expect(result.streams).toEqual([SESSION]);
    const events = await stored(r);
    expect(events.length).toBeGreaterThan(2);
    expect(
      events.some(
        (e) => e.kind === "tool_call" || e.kind === "tool_result" || e.kind === "subagent",
      ),
    ).toBe(false);
    expect(await r.store.agentLogSize(r.runId, "agent-abc123")).toBeUndefined();
  });

  test("t3bk2_metadata_mode_stores_no_text", async () => {
    const r = await rig({ history: logConfig({ mode: "metadata" }) });
    const log = sessionLog(r.runId, SESSION, (l) =>
      l.user("CANARY_USER").say("msg_c", "CANARY_AGENT").say("msg_d", "x"),
    );
    await installed(log);
    await capture(r);
    const file = await r.store.readAgentLog(r.runId, SESSION, 1_000_000);
    expect(file).not.toContain("CANARY");
    expect(file).not.toContain("echo hello");
    expect(file).not.toContain(dir);
    const events = await stored(r);
    expect(events.length).toBeGreaterThan(3);
    for (const event of events)
      expect(JSON.stringify(Object.keys(event))).not.toMatch(/preview|cwd|git_branch/);
    expect(events.find((e) => e.kind === "tool_call")).toMatchObject({
      name: "mcp__kodel__pipeline_start",
    });
    expect((await stateOf(r)).history?.agent_log?.mode).toBe("metadata");
  });

  test("t3bk2_caps_from_the_config_are_applied", async () => {
    const r = await rig({
      history: logConfig({
        preview_chars: { user: 10, agent: 12, tool_input: 20, tool_result: 0 },
      }),
    });
    const long = "word ".repeat(40);
    await installed(sessionLog(r.runId, SESSION, (l) => l.say("msg_l", long).say("msg_m", long)));
    await capture(r);
    const events = await stored(r);
    const agent = events.filter((e) => e.kind === "message" && e.role === "assistant");
    expect(agent.length).toBeGreaterThan(1);
    for (const e of agent)
      expect(e.kind === "message" && (e.text_preview?.length ?? 0)).toBeLessThanOrEqual(12);
    // a kind with `0` keeps no text at all
    for (const e of events.filter((x) => x.kind === "tool_result"))
      expect("output_preview" in e).toBe(false);
  });

  test("t3bk2_redaction_reaches_the_file", async () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const r = await rig();
    await installed(
      sessionLog(r.runId, SESSION, (l) => l.say("msg_k", `the key is ${key}`).say("msg_l", "x")),
    );
    await capture(r);
    const file = await r.store.readAgentLog(r.runId, SESSION, 1_000_000);
    expect(file).not.toContain(key);
    expect(file).toContain("[REDACTED:");
  });

  test("t3bk2_redact_writer_pass_collector_off", async () => {
    // a collector that hands over an event with a secret in a field it does not redact: the store does
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const r = await rig();
    const text = r.store.agentLogLines([
      { kind: "system", subtype: "note", detail: `x ${key}`, session_id: "s" },
    ]);
    expect(text).not.toContain(key);
  });

  test("t3bk2_ids_pseudonym_keeps_pairing", async () => {
    const id = "toolu_01Qh5Zr8KdLm3NpTxV9aBcWy2EfGjR7sUo";
    const r = await rig();
    await installed(
      sessionLog(r.runId, SESSION, (l) =>
        l
          .call("msg_p", { id, name: "Bash", input: { command: "ls" } })
          .result(id, "out")
          .say("msg_q", "x")
          .say("msg_r", "y"),
      ),
    );
    await capture(r);
    const events = await stored(r);
    const call = events.find((e) => e.kind === "tool_call" && e.input_preview?.includes("ls"));
    const result = events.find((e) => e.kind === "tool_result" && e.output_preview === "out");
    expect(call?.kind === "tool_call" && call.id).toMatch(/^id-[0-9a-f]{16}$/);
    expect(result?.kind === "tool_result" && result.id).toBe(
      call?.kind === "tool_call" ? call.id : "",
    );
    expect(await r.store.readAgentLog(r.runId, SESSION, 1_000_000)).not.toContain(id);
  });

  test("t3bk2_secret_in_id_not_stored", async () => {
    const r = await rig();
    // after a character that is not part of a word, where the rule for such keys sees the key
    const secretId = `toolu-${["AKIA", "IOSFODNN7EXAMPLE"].join("")}`;
    await installed(
      sessionLog(r.runId, SESSION, (l) =>
        l
          .call("msg_p", { id: secretId, name: "Bash", input: {} })
          .result(secretId, "ok")
          .say("msg_q", "x")
          .say("msg_r", "y"),
      ),
    );
    await capture(r);
    expect(await r.store.readAgentLog(r.runId, SESSION, 1_000_000)).not.toContain(
      "IOSFODNN7EXAMPLE",
    );
  });

  test("t3bk2_time_bound_stores_partial_and_continues", async () => {
    let ticks = 0;
    const r = await rig({
      writer: (store, env) =>
        new AgentLogWriter({
          store,
          root: dir,
          rules: [],
          env,
          budgetMs: 1_000,
          // every look at the clock costs 300 ms: a pass reads a few entries and keeps what it has
          now: () => (ticks += 300),
        }),
    });
    const log = sessionLog(r.runId);
    for (let i = 0; i < 12; i++) log.say(`msg_t${i}`, `sentence ${i}`);
    log.say("msg_t_end", "the end");
    await installed(log);
    let firstSaved = 0;
    for (let pass = 0; pass < 40; pass++) {
      const result = await capture(r);
      if (pass === 0) firstSaved = (await stored(r)).length;
      if (result.skipped !== undefined) break;
    }
    const events0 = await stored(r);
    // the first pass stopped on the clock with a part, and the later ones went on from there
    expect(firstSaved).toBeLessThan(events0.length);
    const events = await stored(r);
    const full = (await readStoredAgentLog(r.store, r.runId, SESSION, 10_000_000)).events;
    expect(full).toEqual(events);
    const messages = events
      .filter((e) => e.kind === "message")
      .map((e) => e.kind === "message" && e.message_id);
    expect(messages).toContain("msg_t11");
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect((await stateOf(r)).agentLog?.failed).toEqual([]);
  });
});

describe("t3bk2 hard input", () => {
  const closing = (n: number) =>
    new ClaudeLogBuilder({ sessionId: SESSION, cwd: dir, start: `2026-10-21T13:0${n}:00.000Z` })
      .say(`msg_end${n}`, "a response after the junk")
      .say(`msg_close${n}`, "and the next, so that it is closed")
      .text();

  test("t3bk2_hardening_junk_nul_utf8", async () => {
    const r = await rig();
    const path = await installed(sessionLog(r.runId));
    const nul = `${JSON.stringify({ type: "user", cwd: dir, timestamp: "2026-10-21T12:59:00.000Z", message: { role: "user", content: "a\u0000b" } })}\n`;
    await appendFile(path, nul);
    await appendFile(
      path,
      Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x0a, 0x7b, 0x22, 0x74, 0x79, 0x0a]),
    );
    await appendFile(path, closing(1));
    const result = await capture(r);
    expect(result.saved).toBe(1);
    const events = await stored(r);
    expect(events.filter((e) => e.kind === "message" && e.message_id === "msg_end1")).toHaveLength(
      1,
    );
    // what is stored is text that reads back, whatever was in the log
    const read = await readStoredAgentLog(r.store, r.runId, SESSION, 10_000_000);
    expect(read.ok).toBe(true);
    expect(JSON.stringify(events)).not.toContain("\\ufffd");
  });

  test("t3bk2_hardening_long_line", async () => {
    const r = await rig();
    const path = await installed(sessionLog(r.runId));
    // a line over the cap is skipped without being held, and the entries after it are read
    await appendFile(path, `${"x".repeat(9 * 1024 * 1024)}\n`);
    await appendFile(path, closing(2));
    const result = await capture(r);
    expect(result.saved).toBe(1);
    expect((await stored(r)).some((e) => e.kind === "message" && e.message_id === "msg_end2")).toBe(
      true,
    );
  });

  test("t3bk2_hardening_stream_bound", async () => {
    // a log of many megabytes is read as a stream and what is stored is bounded by the share, not by the log
    const r = await rig({ history: logConfig({ max_kb: 64 }) });
    const log = sessionLog(r.runId);
    for (let i = 0; i < 12_000; i++) log.say(`msg_big${i}`, `${"lorem ipsum ".repeat(60)}${i}`);
    log.say("msg_big_end", "the end");
    const path = await installed(log);
    expect((await stat(path)).size).toBeGreaterThan(8 * 1024 * 1024);
    const started = Date.now();
    const result = await r.writer.capture(r.run.agentLogRun(), {
      why: "step",
      waitMs: 0,
      step: { node: "a", attempt: 1 },
    });
    expect(result.saved).toBe(1);
    expect(Date.now() - started).toBeLessThan(25_000);
    const length = (await stateOf(r)).agentLog?.sessions[SESSION]?.length ?? 0;
    expect(length).toBeLessThanOrEqual(64 * 1024);
    expect(length).toBeGreaterThan(1_000);
  });

  test("t3bk2_hardening_symlink_and_outside_store", async () => {
    const r = await rig({ session: null });
    // a transcript path from the hook index that is not in the agent's store is not looked at
    const outside = join(dir, "..", `outside-${Date.now()}.jsonl`);
    await writeFile(outside, sessionLog(r.runId).text());
    await writeFile(
      join(dir, ".kodel", "sessions.jsonl"),
      `${JSON.stringify({ session_id: OLD, agent: "claude-code", transcript_path: outside, cwd: dir, ts: "2026-10-21T10:00:00.000Z" })}\n`,
    );
    try {
      expect(await capture(r, "step")).toMatchObject({ saved: 0, failures: ["session_unknown"] });
      expect(await r.store.agentLogSize(r.runId, OLD)).toBeUndefined();
      // and a link in the store that leads out of it is refused, never opened
      const linkRig = await rig({ session: SESSION });
      const folder = join(claude, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
      await mkdir(folder, { recursive: true });
      await writeFile(outside, sessionLog(linkRig.runId).text());
      await symlink(outside, join(folder, `${SESSION}.jsonl`));
      const result = await capture(linkRig, "step");
      expect(result.failures).toEqual(["refused"]);
      expect(result.streams).toEqual([]);
    } finally {
      await rm(outside, { force: true });
    }
  });

  test("t3bk2_hardening_cwd_variants", async () => {
    const make = async (cwd: string, folder: string) => {
      const r = await rig();
      const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd });
      log
        .call("msg_0", { id: "toolu_s", name: "mcp__kodel__pipeline_start", input: {} })
        .result("toolu_s", JSON.stringify({ run_id: r.runId }))
        .say("msg_1", "a")
        .say("msg_2", "b");
      await log.install(claude, folder);
      return r;
    };
    // a subdirectory of the project is the project
    const sub = await make(join(dir, "packages", "x"), dir.replace(/[^a-zA-Z0-9]/g, "-"));
    expect((await capture(sub, "step")).streams).toEqual([SESSION]);
    await rm(join(claude, "projects"), { recursive: true, force: true });
    // a relative one is nobody's, and a sibling directory with the same beginning is not the project
    for (const cwd of ["relative/path", `${dir}-sibling`, "/"]) {
      const r = await make(cwd, dir.replace(/[^a-zA-Z0-9]/g, "-"));
      const result = await capture(r, "step");
      expect(result.streams).toEqual([]);
      await rm(join(claude, "projects"), { recursive: true, force: true });
    }
  });
});

describe("t3bk2 the seal, the report and the stored stream", () => {
  async function finished(): Promise<Rig> {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await installed(log);
    await r.run.completeStep("a", 1);
    log.say("msg_9", "b is done").say("msg_10", "closed");
    await writeFile(path, log.text());
    await r.run.completeStep("b", 1);
    expect((await stateOf(r)).status).toBe("completed");
    return r;
  }

  test("t3bk2_seal_ignores_agent_log", async () => {
    const r = await finished();
    expect(await r.run.sealStatus()).toBe("sealed");
    const before = (await r.run.report()).agent_log;
    await appendFile(
      join(r.store.runDir(r.runId), "agent_log", `${SESSION}.jsonl`),
      "garbage that is not an event\n",
    );
    // the files are display data outside the seal; the report says so and counts from the journal
    expect(await r.run.sealStatus()).toBe("sealed");
    expect((await r.run.report()).agent_log).toEqual(before);
    expect(before).toMatchObject({ unverified: true, final_pass: true });
  });

  test("t3bk2_seal_covers_saved_event", async () => {
    const r = await finished();
    const file = join(r.store.runDir(r.runId), "journal.jsonl");
    const text = await readFile(file, "utf8");
    expect(text).toContain('"event":"agent_log_saved"');
    await writeFile(file, text.replace('"event":"agent_log_saved"', '"event":"agent_log_savex"'));
    expect(await r.run.sealStatus()).toBe("modified");
  });

  test("t3bk2_report_does_not_open_file", async () => {
    const r = await finished();
    const before = (await r.run.report()).agent_log;
    await rm(join(r.store.runDir(r.runId), "agent_log"), { recursive: true, force: true });
    // the report is made of the state and the journal: a stream that is gone changes nothing in it
    expect((await r.run.report()).agent_log).toEqual(before);
    expect(await readStoredAgentLog(r.store, r.runId, SESSION, 100)).toMatchObject({
      ok: false,
      problem: "missing",
    });
  });

  test("t3bk2_cannot_read_not_modified", async () => {
    const r = await rig();
    const folder = join(r.store.runDir(r.runId), "agent_log");
    await mkdir(folder, { recursive: true });
    const good = JSON.stringify({
      v: 1,
      agent: "claude-code",
      agent_version: "",
      session_id: "s",
      seq: 1,
      ts: "2026-10-21T10:00:00.000Z",
      kind: "system",
      subtype: "x",
    });
    const future = JSON.stringify({ v: 2, kind: "something new" });
    await writeFile(join(folder, "s.jsonl"), `${good}\n${future}\n${good}\n`);
    const read = await readStoredAgentLog(r.store, r.runId, "s", 10_000);
    expect(read).toMatchObject({ ok: false, problem: "format" });
    if (read.ok) throw new Error("expected a problem");
    // a format this reader does not know is said so, with what to do; it is not a file that was changed
    expect(read.detail).toContain("format 2");
    expect(read.detail).toContain("upgrade");
    expect(read.detail).not.toMatch(/modified/i);
    expect(read.events).toHaveLength(1);
  });

  test("t3bk2_damaged_is_not_format_x", async () => {
    const r = await rig();
    const folder = join(r.store.runDir(r.runId), "agent_log");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "s.jsonl"), 'not json at all\n{"v":1}\n');
    const damaged = await readStoredAgentLog(r.store, r.runId, "s", 10_000);
    expect(damaged).toMatchObject({ ok: false, problem: "damaged" });
    if (damaged.ok) throw new Error("expected a problem");
    expect(damaged.detail).not.toMatch(/format \d|modified/i);
    await writeFile(join(folder, "t.jsonl"), '{"v":1,"kind":"system"}\n');
    expect(await readStoredAgentLog(r.store, r.runId, "t", 10_000)).toMatchObject({
      ok: false,
      problem: "damaged",
    });
    // the same stream cut at the length the journal vouches for is whole
    await writeFile(join(folder, "u.jsonl"), "not json at all\n");
    expect(await readStoredAgentLog(r.store, r.runId, "u", 0)).toMatchObject({
      ok: true,
      events: [],
    });
  });
});

describe("t3bk2 what the run asked for", () => {
  test("t3bk2_disabled_writes_nothing", async () => {
    const r = await rig({ history: logConfig({ enabled: false }) });
    await installed(sessionLog(r.runId));
    await r.run.completeStep("a", 1);
    expect(await capture(r)).toMatchObject({ skipped: "disabled" });
    await expect(stat(join(r.store.runDir(r.runId), "agent_log"))).rejects.toThrow();
    const events = (await journalOf(r)).map((rec) => rec.event);
    expect(events.some((e) => e.startsWith("agent_log"))).toBe(false);
    expect((await r.run.report()).agent_log).toEqual({ not_collected: true, reason: "disabled" });
  });

  test("t3bk2_not_captured", async () => {
    // a host that did not ask for it, like a run from before it existed
    const r = await rig({ history: defaultHistory() });
    await installed(sessionLog(r.runId));
    expect((await stateOf(r)).agentLog).toBeUndefined();
    expect(await capture(r)).toMatchObject({ skipped: "disabled" });
    await r.run.completeStep("a", 1);
    expect((await r.run.report()).agent_log).toEqual({
      not_collected: true,
      reason: "not_captured",
    });
  });

  test("t3bk2_config_frozen", async () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: SESSION };
    const config = (agentLog: string) =>
      writeFile(
        join(dir, ".kodel", "config.yaml"),
        `worktree:\n  mode: off\nhistory:\n  agent_log: ${agentLog}\n`,
      );
    await config("{ mode: metadata, interval_s: 0 }");
    const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0, environment: env });
    const started = await host.start({ pipeline: "two", task: "t", restart: false });
    const run = started.run as LocalRun;
    await installed(sessionLog(run.runId, SESSION, (l) => l.user("CANARY_USER")));
    // the person edits the file while the run goes: the run keeps what it started with
    await config("{ enabled: false, mode: full }");
    await run.completeStep("a", 1);
    const state = await run.state();
    expect(state.history?.agent_log).toMatchObject({ enabled: true, mode: "metadata" });
    const length = state.agentLog?.sessions[SESSION]?.length ?? 0;
    expect(length).toBeGreaterThan(0);
    const store = new FileStore({ root: join(dir, ".kodel") });
    expect(await store.readAgentLog(run.runId, SESSION, length)).not.toContain("CANARY");
  });

  test("t3bk2_mode_unknown", async () => {
    const r = await rig();
    await installed(sessionLog(r.runId));
    await capture(r);
    // the journal says nothing of the mode: a report says it does not know, and does not guess
    const state = await stateOf(r);
    const { summarizeRun } = await import("@kodel-ai/pipeline-core");
    const { agent_log: _gone, ...history } = state.history ?? ({} as HistoryConfig);
    const report = summarizeRun(
      { ...state, history: history as HistoryConfig },
      await journalOf(r),
    );
    expect(report.agent_log).toMatchObject({ mode: "unknown" });
  });

  test("t3bk2_test_hosts_isolated_from_env", async () => {
    // inside Claude Code the shell has a session id of its own; the test setup takes it out, so that a host built
    // without an environment does not go looking for the developer's session
    expect(process.env["CLAUDE_CODE_SESSION_ID"]).toBeUndefined();
    const env = { ...process.env };
    const store = new FileStore({ root: join(dir, ".kodel") });
    const spy = { reads: 0 };
    const writer = spyWriter(spy)(store, () => env);
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      history: logConfig(),
      agentLog: writer,
    });
    const started = await host.start({ pipeline: "two", task: "t", restart: false });
    await (started.run as LocalRun).completeStep("a", 1);
    expect(spy.reads).toBe(0);
  });
});

describe("t3bk2 what the review of the build found", () => {
  const nodes2 = ["a", "b"];
  const stateOf2 = (bytes: number, visits: Record<string, number>) =>
    ({ agentLog: { nodes: nodes2, bytes, visits } }) as never;

  test("t3bk2_budget_the_timer_cannot_spend_the_next_steps_share", () => {
    const total = 64 * 1024;
    const config = { max_kb: 64 };
    // the first pass of step a is offered its share; having used it, the next pass of the same visit has none
    expect(agentLogRoom(stateOf2(0, {}), config, { node: "a", attempt: 1 })).toBe(total / 2);
    expect(
      agentLogRoom(stateOf2(total / 2, { "a:1": total / 2 }), config, { node: "a", attempt: 1 }),
    ).toBe(0);
    // and step b is offered the rest
    expect(
      agentLogRoom(stateOf2(total / 2, { "a:1": total / 2 }), config, { node: "b", attempt: 1 }),
    ).toBe(total / 2);
  });

  test("t3bk2_budget_a_step_that_comes_again_is_a_visit_of_its_own", () => {
    const config = { max_kb: 64 };
    const used = { "a:1": 32 * 1024 };
    expect(agentLogRoom(stateOf2(32 * 1024, used), config, { node: "a", attempt: 2 })).toBe(
      32 * 1024,
    );
    const both = { "a:1": 32 * 1024, "a:2": 32 * 1024 };
    expect(agentLogRoom(stateOf2(64 * 1024, both), config, { node: "a", attempt: 2 })).toBe(0);
  });

  test("t3bk2_pass_failure_loses_nothing", async () => {
    // a pass that reads and then fails to store must not leave the next one to start after what it read
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await installed(log);
    expect((await capture(r)).saved).toBe(1);
    log.say("msg_3", "three").say("msg_4", "four");
    await writeFile(path, log.text());
    const real = r.store.appendAgentLog.bind(r.store);
    let failing = true;
    r.store.appendAgentLog = async (...args) => {
      if (failing) {
        failing = false;
        throw new Error("the disk is full");
      }
      return real(...args);
    };
    expect(await capture(r)).toMatchObject({ saved: 0, errored: true });
    log.say("msg_5", "five").say("msg_6", "six");
    await writeFile(path, log.text());
    expect((await capture(r)).saved).toBe(1);
    const events = await stored(r);
    const messages = events
      .filter((e) => e.kind === "message")
      .map((e) => e.kind === "message" && e.message_id);
    // nothing between the pass that failed and the one that followed is missing
    expect(messages).toEqual(expect.arrayContaining(["msg_1", "msg_2", "msg_3", "msg_4", "msg_5"]));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  test("t3bk2_pass_failure_after_the_journal_refused_loses_nothing", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await installed(log);
    await capture(r);
    log.say("msg_3", "three").say("msg_4", "four");
    await writeFile(path, log.text());
    const real = r.run.agentLogRun();
    let failing = true;
    const flaky: AgentLogRun = {
      ...real,
      apply: async (event) => {
        if (event.type === "agent_log_saved" && failing) {
          failing = false;
          throw new Error("the journal could not be written");
        }
        return real.apply(event);
      },
    };
    await r.writer.capture(flaky, { why: "tick", waitMs: 0 });
    log.say("msg_5", "five").say("msg_6", "six");
    await writeFile(path, log.text());
    expect((await capture(r)).saved).toBe(1);
    const events = await stored(r);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.some((e) => e.kind === "message" && e.message_id === "msg_3")).toBe(true);
  });

  test("t3bk2_restart_catches_up_over_several_passes", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    for (let i = 0; i < 40; i++) log.say(`msg_h${i}`, `history ${i}`);
    log.say("msg_h_end", "the end");
    const path = await installed(log);
    await capture(r);
    const before = (await stateOf(r)).agentLog?.sessions[SESSION]?.last_seq ?? 0;
    // the server restarts: nothing in memory, a small budget per pass, and the agent has written more
    let ticks = 0;
    const store = new FileStore({ root: join(dir, ".kodel") });
    const fresh = new AgentLogWriter({
      store,
      root: dir,
      rules: [],
      env: () => r.env,
      budgetMs: 1_000,
      now: () => {
        ticks += 300;
        return ticks;
      },
    });
    log.say("msg_new1", "after the restart").say("msg_new2", "and more").say("msg_new3", "last");
    await writeFile(path, log.text());
    let passes = 0;
    let saved = 0;
    while (saved === 0 && passes < 80) {
      saved = (await fresh.capture(r.run.agentLogRun(), { why: "tick", waitMs: 0 })).saved;
      passes += 1;
    }
    // it gets to the new part over several passes instead of starting from the beginning each time
    expect(saved).toBe(1);
    expect(passes).toBeGreaterThan(1);
    expect(passes).toBeLessThan(40);
    const after = (await stateOf(r)).agentLog?.sessions[SESSION]?.last_seq ?? 0;
    expect(after).toBeGreaterThan(before);
    const events = await stored(r);
    expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
  });

  test("t3bk2_report_final_pass_when_the_timer_had_copied_everything", async () => {
    const r = await rig();
    const log = sessionLog(r.runId);
    const path = await installed(log);
    await capture(r);
    await r.run.completeStep("a", 1);
    log.say("msg_3", "b begins").say("msg_4", "b goes on");
    await writeFile(path, log.text());
    await capture(r); // the timer takes everything that is closed
    await r.run.completeStep("b", 1); // and the pass at the end of the step finds nothing new
    expect((await stateOf(r)).status).toBe("completed");
    expect((await r.run.report()).agent_log).toMatchObject({ final_pass: true });
  });

  test("t3bk2_events_with_no_room_are_counted", async () => {
    const r = await rig({ history: logConfig({ max_kb: 1 }) });
    await installed(sessionLog(r.runId));
    // the bound is nearly used by another stream: less room than the mark that says events were left out
    const hex = "a".repeat(64);
    await r.run.apply({
      type: "agent_log_saved",
      why: "tick",
      session: "other",
      node: "a",
      attempt: 1,
      first_seq: 1,
      last_seq: 1,
      stream_from: 0,
      stream_to: 900,
      tail_hash: hex,
      last_key: hex,
      entries: 1,
    });
    const before = (await stateOf(r)).agentLog;
    const result = await capture(r);
    expect(result.saved).toBe(1);
    const after = (await stateOf(r)).agentLog;
    // nothing was stored, and the events that could not be are in the count of what was left out
    expect(after?.sessions[SESSION]?.length).toBe(0);
    expect(after?.bytes).toBe(before?.bytes);
    expect(after?.cut).toBeGreaterThan(before?.cut ?? 0);
    expect((await r.run.report()).agent_log).toMatchObject({ cut: after?.cut });
  });

  test("t3bk2_step_failure_is_journaled", async () => {
    const r = await rig();
    await installed(sessionLog(r.runId));
    r.store.appendAgentLog = async () => {
      throw new Error("the disk is full");
    };
    const decision = await r.run.completeStep("a", 1);
    expect(decision.ok).toBe(true);
    // the step went on, and the report says why the copy did not
    expect((await journalOf(r)).filter((rec) => rec.event === "agent_log_failed")).toMatchObject([
      { reason: "unreadable" },
    ]);
    expect((await r.run.report()).agent_log).toMatchObject({ failed: ["unreadable"] });
  });

  test("t3bk2_journal_round_trip", async () => {
    // a rule that matches the hashes the cursor is made of: the journal is redacted on the way in, the state is not
    const hostile: RedactRule[] = [{ name: "hex", pattern: /[0-9a-f]{64}/g }];
    const r = await rig({ rules: hostile });
    const log = sessionLog(r.runId);
    const path = await installed(log);
    expect((await capture(r)).saved).toBe(1);
    const text = await readFile(join(r.store.runDir(r.runId), "journal.jsonl"), "utf8");
    expect(text).toContain("[REDACTED:hex]");
    const cursor = (await stateOf(r)).agentLog?.sessions[SESSION];
    expect(cursor?.tail_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cursor?.last_key).toMatch(/^[0-9a-f]{64}$/);
    // and the next pass goes on from the state, not from the journal
    log.say("msg_3", "later").say("msg_4", "and later");
    await writeFile(path, log.text());
    const second = await capture(r);
    expect(second).toMatchObject({ saved: 1, failures: [] });
  });

  test("t3bk2_a_link_out_of_the_store_is_not_read_to_find_the_run", async () => {
    const r = await rig();
    const outside = join(dir, "..", `secret-${Date.now()}.jsonl`);
    // a file that would prove the run if it were read: it is not a session log of the agent's, only a link names it
    await writeFile(outside, sessionLog(r.runId).text());
    const folder = join(claude, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(folder, { recursive: true });
    await symlink(outside, join(folder, `${SESSION}.jsonl`));
    try {
      const result = await capture(r, "step");
      expect(result.failures).toEqual(["refused"]);
      expect(result.streams).toEqual([]);
      expect((await stateOf(r)).agentLog?.sessions).toEqual({});
    } finally {
      await rm(outside, { force: true });
    }
  });
});
