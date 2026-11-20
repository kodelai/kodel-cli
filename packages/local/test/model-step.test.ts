/**
 * The report of a step that asked for a model (T-43): the model asked for, read from the pipeline kept
 * with the run, against the models the agent's session and subagent logs show. The logs are built with
 * `ClaudeLogBuilder`, one model per response, so each case has the models it names.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultAgentLog,
  defaultHistory,
  defaultUsage,
  type HistoryConfig,
  type ModelMark,
  runTotals,
  tokensOf,
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

const SESSION = "66666666-6666-4666-8666-666666666666";
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-4-8";

/** A fork: plan, then a and b at once, then a join; each says the model it asks for, or none. */
const forkPipeline = (a: string, b: string, merge = "") =>
  [
    "name: two",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    `  - { slug: a, kind: agent, prompt: do a${asked(a)} }`,
    `  - { slug: b, kind: agent, prompt: do b${asked(b)} }`,
    `  - { slug: merge, kind: agent, prompt: merge, join: all${asked(merge)} }`,
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: merge }",
    "  - { from: b, to: merge }",
    "",
  ].join("\n");

const asked = (model: string) => (model === "" ? "" : `, model: ${model}`);

/** Three agent steps in a row; each says the model it asks for, or none. */
const pipeline = (a: string, b = "", c = "") =>
  [
    "name: two",
    "nodes:",
    `  - { slug: a, kind: agent, prompt: do a${asked(a)} }`,
    `  - { slug: b, kind: agent, prompt: do b${asked(b)} }`,
    `  - { slug: c, kind: agent, prompt: do c${asked(c)} }`,
    "edges:",
    "  - { from: a, to: b }",
    "  - { from: b, to: c }",
    "",
  ].join("\n");

let dir: string;
let claude: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-model-step-")));
  claude = join(dir, "..", `claude-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(claude, { recursive: true, force: true });
});

interface Options {
  text?: string;
  task?: string;
  usage?: boolean;
  executor?: boolean;
}

async function rig(options: Options = {}) {
  const text = options.text ?? pipeline("sonnet");
  await writeFile(join(dir, ".kodel", "pipelines", "two.yaml"), text);
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: SESSION };
  const writer = new UsageWriter({
    root: dir,
    rules: [],
    env: () => env,
    sleep: async () => undefined,
    stepWaitMs: 0,
  });
  const store = new FileStore({ root: join(dir, ".kodel") });
  const agentLog = new AgentLogWriter({ store, root: dir, rules: [], env: () => env });
  const history: HistoryConfig = {
    ...defaultHistory(),
    agent_log: { ...defaultAgentLog(), enabled: true, interval_s: 0 },
    usage: { ...defaultUsage(), enabled: options.usage !== false },
    ...(options.executor === false ? { executor: { enabled: false } } : {}),
  };
  const host = new LocalPipelineHost({
    root: dir,
    heartbeatMs: 0,
    environment: env,
    history,
    usage: writer,
    agentLog,
  });
  const started = await host.start({ pipeline: "two", task: options.task ?? "t", restart: false });
  const run = started.run as LocalRun;
  return { host, run, runId: run.runId, store, writer };
}

/**
 * The host session's log: the start of the run, then one response per name, each on its model. The start
 * is answered on the model of the first response, so no other model is in the first attempt by accident.
 */
function sessionLog(runId: string, answers: { id: string; model: string }[]): ClaudeLogBuilder {
  const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd: dir });
  const startModel = answers[0]?.model ?? SONNET;
  log
    .user("please run the pipeline")
    .say("msg_0", "starting it", { model: startModel })
    .call(
      "msg_0",
      { id: "toolu_start", name: "mcp__kodel__pipeline_start", input: { task: "t" } },
      { input: 100, output: 10, model: startModel },
    )
    .result("toolu_start", [{ type: "text", text: JSON.stringify({ ok: true, run_id: runId }) }]);
  for (const answer of answers) {
    log.say(answer.id, `answer ${answer.id}`, { input: 20, output: 5, model: answer.model });
  }
  return log;
}

/** A subagent of the session, begun after the run's first call, answering on `model`. */
async function subagent(sessionPath: string, id: string, model: string): Promise<void> {
  const child = new ClaudeLogBuilder({
    sessionId: id,
    cwd: dir,
    start: "2026-10-21T10:00:30.000Z",
  });
  child.user("look into it").say(`${id}-m`, "found it", { input: 30, output: 7, model });
  const path = join(dirname(sessionPath), SESSION, "subagents", `${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, child.text());
}

/** The person edits the pipeline file; the run notices it and a change is then accepted from it. */
const changeFile = (text: string) => writeFile(join(dir, ".kodel", "pipelines", "two.yaml"), text);

const markOf = async (run: LocalRun, node: string, attempt = 1): Promise<ModelMark> => {
  const mark = (await run.report()).models?.marks.find(
    (m) => m.node === node && m.attempt === attempt,
  );
  if (mark === undefined) throw new Error(`no mark for ${node} #${attempt}`);
  return mark;
};

describe("t43 the mark in the report", () => {
  test("t43_mark_match_by_host", async () => {
    const r = await rig();
    await sessionLog(r.runId, [{ id: "msg_1", model: SONNET }]).install(claude);
    await r.run.completeStep("a", 1);
    expect(await markOf(r.run, "a")).toMatchObject({
      requested: "sonnet",
      seen: [SONNET],
      result: "match",
      by: "host",
    });
  });

  test("t43_mark_match_by_subagent", async () => {
    const r = await rig();
    const path = await sessionLog(r.runId, [{ id: "msg_1", model: OPUS }]).install(claude);
    await subagent(path, "agent-one", SONNET);
    await r.run.completeStep("a", 1);
    const mark = await markOf(r.run, "a");
    expect(mark.result).toBe("match");
    expect(mark.by).toBe("subagent");
    expect(mark.seen).toEqual([OPUS, SONNET].sort());
  });

  test("t43_mark_match_by_host_when_host_and_subagent_both_on_the_family", async () => {
    const r = await rig();
    const path = await sessionLog(r.runId, [{ id: "msg_1", model: SONNET }]).install(claude);
    await subagent(path, "agent-one", SONNET);
    await r.run.completeStep("a", 1);
    expect(await markOf(r.run, "a")).toMatchObject({ result: "match", by: "host" });
  });

  test("t43_mark_match_host_on_requested_subagent_other", async () => {
    const r = await rig();
    const path = await sessionLog(r.runId, [{ id: "msg_1", model: SONNET }]).install(claude);
    await subagent(path, "agent-one", OPUS);
    await r.run.completeStep("a", 1);
    expect(await markOf(r.run, "a")).toMatchObject({ result: "match", by: "host" });
  });

  test("t43_mark_mismatch", async () => {
    const r = await rig();
    const path = await sessionLog(r.runId, [{ id: "msg_1", model: OPUS }]).install(claude);
    await subagent(path, "agent-one", OPUS);
    await r.run.completeStep("a", 1);
    expect(await markOf(r.run, "a")).toMatchObject({
      requested: "sonnet",
      seen: [OPUS],
      result: "mismatch",
    });
  });

  test("t43_helper_subagent_counts_known_limit", async () => {
    // The host did the step itself on opus; a helper subagent (Explore) it started on sonnet is seen
    // too, so the step reads as a match. The docs say so: the log cannot tell the helper from the step.
    const r = await rig();
    const path = await sessionLog(r.runId, [{ id: "msg_1", model: OPUS }]).install(claude);
    await subagent(path, "agent-helper", SONNET);
    await r.run.completeStep("a", 1);
    expect(await markOf(r.run, "a")).toMatchObject({ result: "match", by: "subagent" });
  });

  test("t43_host_model_is_that_of_the_attempt_not_a_later_one", async () => {
    const r = await rig({ text: pipeline("sonnet", "sonnet") });
    const log = sessionLog(r.runId, [{ id: "msg_1", model: SONNET }]);
    const path = await log.install(claude);
    await r.run.completeStep("a", 1);
    // the host answers b on opus: its attempt says opus, and a's mark is not rewritten by it
    log.say("msg_2", "answer b", { input: 20, output: 5, model: OPUS });
    await writeFile(path, log.text());
    await r.run.completeStep("b", 1);
    expect(await markOf(r.run, "a")).toMatchObject({ result: "match", by: "host" });
    expect(await markOf(r.run, "b")).toMatchObject({ result: "mismatch" });
  });

  test("t43_mark_label_left_out_when_history_executor_is_off", async () => {
    const r = await rig({ executor: false });
    await sessionLog(r.runId, [{ id: "msg_1", model: SONNET }]).install(claude);
    await r.run.completeStep("a", 1);
    const mark = await markOf(r.run, "a");
    expect(mark.result).toBe("match");
    expect(mark.by).toBeUndefined();
  });

  test("t43_usage_off_is_not_observed", async () => {
    const r = await rig({ usage: false });
    await sessionLog(r.runId, [{ id: "msg_1", model: SONNET }]).install(claude);
    await r.run.completeStep("a", 1);
    expect(await markOf(r.run, "a")).toMatchObject({
      result: "not_observed",
      reason: "usage_missing",
    });
  });

  test("t43_requested_model_follows_the_snapshot_of_the_attempt", async () => {
    // a and b ask for sonnet; before c begins a person accepts a change that makes c ask for opus: each
    // attempt is judged against the pipeline that was in force when it began
    const r = await rig({ text: pipeline("sonnet", "sonnet", "sonnet") });
    const log = sessionLog(r.runId, [{ id: "msg_1", model: SONNET }]);
    const path = await log.install(claude);
    await r.run.completeStep("a", 1);
    await changeFile(pipeline("sonnet", "sonnet", "opus"));
    const accepted = await r.run.acceptChange({
      source: "file",
      text: pipeline("sonnet", "sonnet", "opus"),
    });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    log.say("msg_2", "answer b", { input: 20, output: 5, model: SONNET });
    await writeFile(path, log.text());
    await r.run.completeStep("b", 1);
    log.say("msg_3", "answer c", { input: 20, output: 5, model: OPUS });
    await writeFile(path, log.text());
    await r.run.completeStep("c", 1);
    expect((await markOf(r.run, "a")).requested).toBe("sonnet");
    expect((await markOf(r.run, "b")).requested).toBe("sonnet");
    expect(await markOf(r.run, "c")).toMatchObject({
      requested: "opus",
      seen: [OPUS],
      result: "match",
    });
  });

  test("t43_mismatch_changes_nothing", async () => {
    // the same run twice, once on the model asked for and once not: the journal says the same things in the
    // same order, the run ends the same way, and the tokens counted are the same
    const trail = async (task: string, host: string) => {
      const r = await rig({ text: pipeline("sonnet", "", ""), task });
      const log = sessionLog(r.runId, [{ id: "msg_1", model: host }]);
      await log.install(claude);
      await r.run.completeStep("a", 1);
      await r.run.completeStep("b", 1);
      await r.run.completeStep("c", 1);
      const journal = await r.store.readJournal(r.runId);
      const state = await r.run.state();
      return {
        events: journal.map((rec) => `${rec.event}:${String(rec.node ?? "")}`),
        status: state.status,
        tokens: tokensOf(
          runTotals(state.usage ?? { attempts: {}, unattributed: { models: {}, passes: 0 } }),
        ),
        mark: (await r.run.report()).models?.marks[0]?.result,
      };
    };
    const matching = await trail("one", SONNET);
    const mismatching = await trail("two", OPUS);
    expect(matching.mark).toBe("match");
    expect(mismatching.mark).toBe("mismatch");
    expect(mismatching.events).toEqual(matching.events);
    expect(mismatching.status).toBe(matching.status);
    expect(mismatching.tokens).toEqual(matching.tokens);
  });

  test("t43_run_without_model_steps_has_no_line", async () => {
    const r = await rig({ text: pipeline("", "") });
    await sessionLog(r.runId, [{ id: "msg_1", model: SONNET }]).install(claude);
    await r.run.completeStep("a", 1);
    expect((await r.run.report()).models).toBeUndefined();
  });

  test("t43_unreadable_kept_pipeline_is_said_once_and_not_guessed", async () => {
    const r = await rig({ text: pipeline("sonnet", "sonnet", "sonnet") });
    await sessionLog(r.runId, [{ id: "msg_1", model: SONNET }]).install(claude);
    await r.run.completeStep("a", 1);
    // a version of the pipeline that was accepted later, so that the first copy is no longer the current one
    await changeFile(pipeline("sonnet", "sonnet", "opus"));
    const accepted = await r.run.acceptChange({
      source: "file",
      text: pipeline("sonnet", "sonnet", "opus"),
    });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    const current = (await r.run.state()).specHash;
    const kept = join(dir, ".kodel", "runs", r.runId, "specs");
    for (const name of await readdir(kept)) {
      if (!name.startsWith(current)) await writeFile(join(kept, name), "damaged");
    }
    const fresh = await new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      environment: { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: SESSION },
    }).open(r.runId);
    const report = await fresh?.report();
    // the report is still made; the models of the attempts under the damaged copy are not guessed
    expect(report?.models?.no_snapshot).toBe(true);
    expect(report?.models?.marks.find((m) => m.node === "a")).toBeUndefined();
  });
});

// ── a fork worked by workers ────────────────────────────────────────────────

/**
 * A worker's log (a subagent of the session): its answers on `model`, then the call that hands its step in,
 * then, when `closing` is given, the report it writes after the call, on that model.
 */
async function workerLog(
  sessionPath: string,
  id: string,
  runId: string,
  steps: { node: string; attempt?: number; model: string; closing?: string }[],
  options: { start?: string } = {},
): Promise<string> {
  const child = new ClaudeLogBuilder({
    sessionId: id,
    cwd: dir,
    start: options.start ?? "2026-10-21T10:00:30.000Z",
  });
  child.user("take your step");
  let n = 0;
  for (const step of steps) {
    n += 1;
    // one line for the response that makes the call, on the worker's model
    child.call(
      `${id}-w${n}`,
      {
        id: `${id}-tu${n}`,
        name: "mcp__kodel__pipeline_complete_step",
        input: { run_id: runId, node_slug: step.node, attempt: step.attempt ?? 1 },
      },
      { input: 30, output: 7, model: step.model },
    );
    if (step.closing !== undefined) {
      child.say(`${id}-c${n}`, "my report", { input: 5, output: 2, model: step.closing });
    }
  }
  const path = join(dirname(sessionPath), SESSION, "subagents", `${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, child.text());
  return path;
}

/** The run at the point where a and b are open, the host session on `host`. */
async function openFork(options: Options & { host?: string } = {}) {
  const host = options.host ?? OPUS;
  const r = await rig({ text: forkPipeline("sonnet", "opus"), ...options });
  const path = await sessionLog(r.runId, [{ id: "msg_1", model: host }]).install(claude);
  await r.run.completeStep("plan", 1);
  const tokenA = "token-for-a";
  const tokenB = "token-for-b";
  const takenA = await r.run.takeStep({ node: "a", token: tokenA });
  const takenB = await r.run.takeStep({ node: "b", token: tokenB });
  expect(takenA.status).toBe("claimed");
  expect(takenB.status).toBe("claimed");
  return { ...r, path, tokenA, tokenB };
}

const handIn = (f: Awaited<ReturnType<typeof openFork>>, node: string, token: string) =>
  f.run.completeStep(node, 1, "done", undefined, undefined, token);

describe("t43 a fork worked by workers", () => {
  test("t43_fork_two_workers_two_models_each_judged_by_its_own_log_a_first", async () => {
    const f = await openFork();
    await workerLog(f.path, "agent-wa", f.runId, [{ node: "a", model: SONNET }]);
    await workerLog(f.path, "agent-wb", f.runId, [{ node: "b", model: OPUS }]);
    await handIn(f, "a", f.tokenA);
    await handIn(f, "b", f.tokenB);
    expect(await markOf(f.run, "a")).toMatchObject({
      requested: "sonnet",
      seen: [SONNET],
      result: "match",
      by: "worker",
    });
    expect(await markOf(f.run, "b")).toMatchObject({
      requested: "opus",
      seen: [OPUS],
      result: "match",
      by: "worker",
    });
  });

  test("t43_fork_two_workers_two_models_each_judged_by_its_own_log_b_first", async () => {
    const f = await openFork();
    await workerLog(f.path, "agent-wa", f.runId, [{ node: "a", model: SONNET }]);
    await workerLog(f.path, "agent-wb", f.runId, [{ node: "b", model: OPUS }]);
    await handIn(f, "b", f.tokenB);
    await handIn(f, "a", f.tokenA);
    expect((await markOf(f.run, "a")).result).toBe("match");
    expect((await markOf(f.run, "b")).result).toBe("match");
  });

  test("t43_pooled_models_are_mixed_but_the_marks_are_not", async () => {
    const f = await openFork({ host: OPUS });
    await workerLog(f.path, "agent-wa", f.runId, [{ node: "a", model: SONNET }]);
    await workerLog(f.path, "agent-wb", f.runId, [{ node: "b", model: SONNET }]);
    await handIn(f, "a", f.tokenA);
    await handIn(f, "b", f.tokenB);
    // the pool credits what the session and every worker wrote to the step handed in, so a's use holds the
    // models of both workers; b was on sonnet, not on the opus it asked for, and says so
    const usage = (await f.run.state()).usage;
    expect(Object.keys(usage?.attempts["a:1"]?.models ?? {})).toContain(SONNET);
    expect(await markOf(f.run, "a")).toMatchObject({ result: "match", by: "worker" });
    expect(await markOf(f.run, "b")).toMatchObject({ result: "mismatch", seen: [SONNET] });
  });

  test("t43_worker_on_another_model_is_mismatch", async () => {
    const f = await openFork();
    await workerLog(f.path, "agent-wa", f.runId, [{ node: "a", model: OPUS }]);
    await workerLog(f.path, "agent-wb", f.runId, [{ node: "b", model: OPUS }]);
    await handIn(f, "a", f.tokenA);
    await handIn(f, "b", f.tokenB);
    expect(await markOf(f.run, "a")).toMatchObject({ result: "mismatch", seen: [OPUS] });
  });

  test("t43_worker_log_not_found_is_not_observed", async () => {
    const f = await openFork();
    // no worker log holds the call for a
    await workerLog(f.path, "agent-wb", f.runId, [{ node: "b", model: OPUS }]);
    await handIn(f, "a", f.tokenA);
    expect(await markOf(f.run, "a")).toMatchObject({
      result: "not_observed",
      reason: "worker_not_found",
      seen: [],
    });
  });

  test("t43_worker_call_found_in_two_logs_is_not_observed", async () => {
    const f = await openFork();
    await workerLog(f.path, "agent-wa", f.runId, [{ node: "a", model: SONNET }]);
    await workerLog(f.path, "agent-wa2", f.runId, [{ node: "a", model: SONNET }]);
    await handIn(f, "a", f.tokenA);
    expect(await markOf(f.run, "a")).toMatchObject({
      result: "not_observed",
      reason: "worker_not_found",
    });
  });

  test("t43_coordinator_with_a_token_is_not_observed", async () => {
    // the call is in the main log, which is never searched: an agent that takes a step itself is no worker
    const f = await openFork();
    const main = sessionLog(f.runId, [{ id: "msg_1", model: SONNET }]);
    main.call(
      "msg_1",
      {
        id: "tu_main",
        name: "mcp__kodel__pipeline_complete_step",
        input: { run_id: f.runId, node_slug: "a", attempt: 1 },
      },
      { model: SONNET },
    );
    await writeFile(f.path, main.text());
    await handIn(f, "a", f.tokenA);
    expect(await markOf(f.run, "a")).toMatchObject({
      result: "not_observed",
      reason: "worker_not_found",
    });
  });

  test("t43_worker_closing_report_after_the_call_is_not_counted", async () => {
    const f = await openFork();
    await workerLog(f.path, "agent-wa", f.runId, [{ node: "a", model: SONNET, closing: OPUS }]);
    await workerLog(f.path, "agent-wb", f.runId, [{ node: "b", model: OPUS }]);
    await handIn(f, "a", f.tokenA);
    expect(await markOf(f.run, "a")).toMatchObject({ result: "match", seen: [SONNET] });
  });

  test("t43_worker_with_several_steps_in_one_log_keeps_the_stretches_apart", async () => {
    // the same worker took b after a, on another model: each step is judged by its own stretch of the log
    const f = await openFork();
    await workerLog(f.path, "agent-wab", f.runId, [
      { node: "a", model: SONNET },
      { node: "b", model: OPUS },
    ]);
    await handIn(f, "a", f.tokenA);
    await handIn(f, "b", f.tokenB);
    expect(await markOf(f.run, "a")).toMatchObject({ seen: [SONNET], result: "match" });
    expect(await markOf(f.run, "b")).toMatchObject({ seen: [OPUS], result: "match" });
  });

  test("t43_worker_log_over_the_size_bound_is_not_observed", async () => {
    const f = await openFork();
    const path = await workerLog(f.path, "agent-wa", f.runId, [{ node: "a", model: SONNET }]);
    const { appendFile } = await import("node:fs/promises");
    // larger than the bound the log is read up to: pad with lines the reader skips
    const junk = `${JSON.stringify({ type: "system", note: "x".repeat(1000) })}\n`;
    await appendFile(path, junk.repeat(4200));
    await handIn(f, "a", f.tokenA);
    expect(await markOf(f.run, "a")).toMatchObject({
      result: "not_observed",
      reason: "worker_not_found",
    });
  });

  test("t43_worker_log_with_an_other_id_is_not_observed", async () => {
    const f = await openFork();
    await workerLog(f.path, "agent-wa", f.runId, [{ node: "a", model: "weird model!" }]);
    await handIn(f, "a", f.tokenA);
    expect(await markOf(f.run, "a")).toMatchObject({
      result: "not_observed",
      reason: "unknown_id",
      seen: ["other"],
    });
  });

  test("t43_step_not_done_by_a_worker_in_a_run_with_workers_is_not_observed", async () => {
    // the join is done by the coordinator after the workers: the pooled use holds their closing responses
    const f = await openFork({ text: forkPipeline("sonnet", "opus", "sonnet") });
    await workerLog(f.path, "agent-wa", f.runId, [{ node: "a", model: SONNET, closing: SONNET }]);
    await workerLog(f.path, "agent-wb", f.runId, [{ node: "b", model: OPUS }]);
    await handIn(f, "a", f.tokenA);
    await handIn(f, "b", f.tokenB);
    await f.run.completeStep("merge", 1);
    expect(await markOf(f.run, "merge")).toMatchObject({
      result: "not_observed",
      reason: "workers_in_run",
    });
  });

  test("t43_worker_step_with_usage_off_writes_no_worker_models", async () => {
    const f = await openFork({ usage: false });
    await workerLog(f.path, "agent-wa", f.runId, [{ node: "a", model: SONNET }]);
    await handIn(f, "a", f.tokenA);
    const journal = await f.store.readJournal(f.runId);
    const done = journal.find((r) => r.event === "agent_completed" && r.node === "a");
    expect(done?.worker_models).toBeUndefined();
  });

  test("t43_worker_models_are_in_the_journal_folded_sorted_and_unique", async () => {
    const f = await openFork();
    await workerLog(f.path, "agent-wa", f.runId, [
      { node: "a", model: OPUS, closing: OPUS },
      { node: "a", attempt: 1, model: SONNET },
    ]);
    await handIn(f, "a", f.tokenA);
    const journal = await f.store.readJournal(f.runId);
    const done = journal.find((r) => r.event === "agent_completed" && r.node === "a");
    expect(done?.worker_models).toEqual([OPUS]);
  });

  test("t43_cost_and_tokens_and_passes_unchanged_by_the_worker_scan", async () => {
    // the scan only reads: it writes no event and changes no count, however often it is asked
    const f = await openFork();
    await workerLog(f.path, "agent-wa", f.runId, [{ node: "a", model: SONNET }]);
    const run = (f.run as unknown as { agentLogRun(): AgentLogRun }).agentLogRun();
    const before = {
      journal: JSON.stringify(await f.store.readJournal(f.runId)),
      usage: JSON.stringify((await f.run.state()).usage),
    };
    expect(await f.writer.workerModels(run, { node: "a", attempt: 1 })).toEqual([SONNET]);
    expect(await f.writer.workerModels(run, { node: "a", attempt: 1 })).toEqual([SONNET]);
    expect(await f.writer.workerModels(run, { node: "b", attempt: 1 })).toEqual([]);
    expect(JSON.stringify(await f.store.readJournal(f.runId))).toBe(before.journal);
    expect(JSON.stringify((await f.run.state()).usage)).toBe(before.usage);
  });
});
