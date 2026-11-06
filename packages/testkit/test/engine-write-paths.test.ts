/**
 * Every write path against a run with an engine step (T-42), on the local host: a host that does not
 * run engine steps writes nothing, and a run paused at an unknown outcome is moved by nothing but a
 * person's resume that looked the session up. The oracle: no new start, and the run's files byte for
 * byte as they were (the paths that legitimately write a note say so in their row).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalHost, LocalPipelineHost, type LocalRun } from "@kodel-ai/local";
import {
  defaultHistory,
  type EngineOptions,
  type JournalRecord,
  type PipelineSpec,
  parsePipeline,
} from "@kodel-ai/pipeline-core";
import { FakeEngineResolver, ScriptedSessionAdapter } from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-engine-paths-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const TEXT = [
  "name: eng",
  "nodes:",
  "  - slug: plan",
  "    kind: agent",
  "    prompt: plan it",
  "  - slug: review",
  "    kind: agent",
  "    engine: reviewer",
  "    prompt: review {{task}}",
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "edges:",
  "  - { from: plan, to: review }",
  "  - { from: review, to: approve }",
  "  - { from: approve, to: review, when: rejected }",
  "",
].join("\n");
const ENGINE: PipelineSpec = parsePipeline(TEXT);
const PLAIN_TEXT = TEXT.replace("    engine: reviewer\n", "");

const MCP: EngineOptions = { engineSteps: { start: true } };
const HUMAN: EngineOptions = { engineSteps: { start: false } };

/** The run's own pipeline file, so `pipeline changes restore` has something to restore. */
const PIPELINE_FILE = ".kodel/pipelines/eng.yaml";

const host = (adapter: ScriptedSessionAdapter, engine?: EngineOptions, ownerId = "mcp:1") =>
  new LocalHost(ENGINE, {
    root: dir,
    heartbeatMs: 0,
    integrityDir: join(dir, "integrity"),
    source: TEXT,
    pipelineFile: PIPELINE_FILE,
    ...(engine === undefined ? {} : { engine }),
    engineResolver: new FakeEngineResolver(),
    engineSessions: () => adapter,
    ownerId,
    isOwnerAlive: (owner) => owner !== "gone:1",
  });

const until = async (what: () => Promise<boolean>, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!(await what())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** The sha256 of every file of the run's folder (not the lock), by path. */
async function filesOf(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (path: string, rel: string) => {
    for (const e of await readdir(path, { withFileTypes: true })) {
      if (e.name.startsWith("lock")) continue;
      const full = join(path, e.name);
      if (e.isDirectory()) await walk(full, `${rel}${e.name}/`);
      else
        out[`${rel}${e.name}`] = createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
    }
  };
  await walk(root, "");
  return out;
}

/** A run of the engine pipeline whose engine step runs in a scripted session (its record has an id). */
async function runAtEngineStep(
  adapter: ScriptedSessionAdapter,
  owner = "gone:1",
): Promise<LocalRun> {
  const h = host(adapter, MCP, owner);
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, PIPELINE_FILE), TEXT);
  const { run } = await h.start("the task");
  await run.nextStep({ serve: {} });
  const done = await run.completeStep("plan", 1, "planned");
  if (!done.ok) throw done.error;
  await until(async () => (await run.state()).engineSession?.id !== undefined);
  // the server that waited leaves; the session goes on
  run.stop();
  return run;
}

type Row = [string, (run: LocalRun, h: LocalHost) => Promise<unknown>];

/** The write paths a person or an agent reaches, as the commands and the tools call them. */
const WRITE_PATHS: Row[] = [
  ["start", (_run, h) => h.start("the task")],
  ["propose", (run) => run.proposeChange({ yaml: PLAIN_TEXT, summary: "drop the engine" })],
  ["accept", (run) => run.acceptChange({ source: "file", text: PLAIN_TEXT })],
  ["gate", (run) => run.decideHuman("approve", "approved")],
  ["resume", (run) => run.resume()],
  ["resume (raw, not looked up)", (run) => run.apply({ type: "resume" })],
  ["tick", (run) => run.tick()],
  ["next_step", (run) => run.nextStep({ serve: {} })],
  ["take_step", (run) => run.takeStep({})],
  ["complete_step", (run) => run.completeStep("review", 1, "I did it")],
  ["report_result", (run) => run.reportResult("review", 1, { rows: [] })],
  ["feedback", (run) => run.feedback({ category: "unclear", message: "?" })],
  ["pipeline changes discard", (run) => run.discardProposal()],
  ["pipeline changes restore", (run) => run.restoreFile()],
  ["ack", (run) => run.acknowledge("looked")],
  ["seal", (run, h) => h.seal(run.runId)],
  ["migrate", (run) => run.migrate()],
  ["cancel", (run) => run.cancel()],
];

describe("t42 a host that does not run engine steps", () => {
  test("t42_engine_field_refused_before_any_write", async () => {
    const adapter = new ScriptedSessionAdapter();
    const run = await runAtEngineStep(adapter);
    const runDir = (host(adapter) as LocalHost).store.runDir(run.runId);
    const off = host(adapter);
    const starts = adapter.starts;
    for (const [name, path] of WRITE_PATHS) {
      // the file edited by hand, for `restore` to put back if it were let
      if (name === "pipeline changes restore")
        await writeFile(join(dir, PIPELINE_FILE), PLAIN_TEXT);
      const before = await filesOf(runDir);
      const runs = await readdir(join(dir, ".kodel", "runs"));
      const error = await path(off.open(run.runId), off).then(
        () => undefined,
        (e: unknown) => e,
      );
      if (name === "pipeline changes restore") {
        expect((error as Error | undefined)?.message, name).toContain("does not run engine steps");
        expect(await readFile(join(dir, PIPELINE_FILE), "utf8")).toBe(PLAIN_TEXT);
        await writeFile(join(dir, PIPELINE_FILE), TEXT);
      }
      expect(await filesOf(runDir), name).toEqual(before);
      expect(await readdir(join(dir, ".kodel", "runs")), name).toEqual(runs);
      expect(adapter.starts, name).toBe(starts);
    }
    expect(adapter.removes).toBe(0);
  });

  test("t42_proposals_apply_refused_before_write", async () => {
    const pipelines = join(dir, ".kodel", "pipelines");
    await mkdir(pipelines, { recursive: true });
    // a host that runs engine steps keeps the proposal; one that does not refuses to put it in place
    const on = new LocalPipelineHost({
      root: dir,
      integrityDir: join(dir, "integrity"),
      engine: MCP,
    });
    const proposed = await on.proposePipeline({ yaml: TEXT, summary: "a new pipeline" });
    expect(proposed.ok).toBe(true);
    const view = await on.pipelineProposal("eng");
    if (!view) throw new Error("the proposal was not kept");
    const off = new LocalPipelineHost({ root: dir, integrityDir: join(dir, "integrity") });
    const refusedProposal = await off.proposePipeline({ yaml: TEXT, summary: "again" });
    expect(refusedProposal.ok).toBe(false);
    const applied = await off.acceptPipelineProposal("eng", view.hash);
    expect(applied.ok).toBe(false);
    expect(existsSync(join(pipelines, "eng.yaml"))).toBe(false);
    // the control: the host that runs them puts it in place
    expect((await on.acceptPipelineProposal("eng", view.hash)).ok).toBe(true);
    expect(existsSync(join(pipelines, "eng.yaml"))).toBe(true);
  });
});

describe("t42 a run paused at an unknown outcome", () => {
  /**
   * The paths that write a note while the pause holds, by design, and move nothing: the agent's
   * proposal and note, a person's ack, and the drop of that proposal. Every other path is held to
   * byte-identical files.
   */
  const NOTES = new Set([
    "propose",
    "feedback",
    "ack",
    // a refused report, and a refused take (the run is paused), are journaled as `call_refused`, as for
    // any refused call of the agent
    "report_result",
    "take_step",
    // drops the proposal the row "propose" left; it moves nothing
    "pipeline changes discard",
  ]);

  test("t42_unknown_pause_holds", async () => {
    const adapter = new ScriptedSessionAdapter();
    const run = await runAtEngineStep(adapter);
    // the next server learns the session was lost while its child still runs
    const session = adapter.only();
    const mcp = host(adapter, MCP, "mcp:2");
    const served = mcp.open(run.runId);
    adapter.finish(session.id, { state: "lost", reason: "holder_gone", childAlive: true });
    await served.tick();
    await until(async () => (await served.state()).status === "paused");
    await served.settle();
    const paused = await served.state();
    expect(paused.engineSession?.id).toBe(session.id);
    const runDir = mcp.store.runDir(run.runId);
    const starts = adapter.starts;
    // The agent's first call journals once that its log cannot be copied here (no session of the agent
    // is known); made before the table, so that `next_step` and `take_step` are held to identical bytes.
    await served.nextStep({ serve: {} });
    for (const engine of [MCP, HUMAN]) {
      const h = host(adapter, engine, engine === MCP ? "mcp:3" : "person:1");
      for (const [name, path] of WRITE_PATHS) {
        if (name === "cancel") continue;
        const before = await filesOf(runDir);
        await path(h.open(run.runId), h).catch(() => undefined);
        await h.open(run.runId).settle();
        const after = await h.open(run.runId).state();
        expect(adapter.starts, name).toBe(starts);
        expect(after.engineSession, name).toEqual(paused.engineSession);
        expect(after.pauses, name).toEqual(paused.pauses);
        if (!NOTES.has(name)) expect(await filesOf(runDir), name).toEqual(before);
        // a note never names the step as running again
        const journal = (await h.open(run.runId).journal()) as JournalRecord[];
        expect(
          journal.some((r) => r.event === "run_resumed"),
          name,
        ).toBe(false);
      }
    }
    expect(adapter.removes).toBe(0);
  });

  test("t42_unknown_pause_accept_by_the_dialog_restore_and_discard", async () => {
    // A run whose pipeline file is watched, paused at an unknown outcome.
    const file = ".kodel/pipelines/eng.yaml";
    await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
    await writeFile(join(dir, file), TEXT);
    const adapter = new ScriptedSessionAdapter();
    const make = (engine: EngineOptions, ownerId: string) =>
      new LocalHost(ENGINE, {
        root: dir,
        heartbeatMs: 0,
        integrityDir: join(dir, "integrity"),
        source: TEXT,
        pipelineFile: file,
        engine,
        engineResolver: new FakeEngineResolver(),
        engineSessions: () => adapter,
        ownerId,
        isOwnerAlive: (owner) => owner !== "gone:1",
      });
    const { run } = await make(MCP, "gone:1").start("the task");
    await run.nextStep({ serve: {} });
    await run.completeStep("plan", 1, "planned");
    await until(async () => (await run.state()).engineSession?.id !== undefined);
    run.stop();
    const served = make(MCP, "mcp:2").open(run.runId);
    adapter.finish(adapter.only().id, { state: "lost", reason: "holder_gone", childAlive: true });
    await served.tick();
    await until(async () => (await served.state()).status === "paused");
    await served.settle();
    const paused = await served.state();
    const person = make(HUMAN, "person:1").open(run.runId);
    const changed = TEXT.replace("prompt: ok?", "prompt: really ok?");
    // the dialog's accept: a proposal accepted with the standing it was shown at
    await served.proposeChange({ yaml: changed, summary: "ask more plainly" });
    const pending = await person.pendingChange();
    expect(pending).toBeDefined();
    const accepted = await person.acceptChange({
      source: "proposal",
      text: changed,
      ...(pending?.info.standing === undefined ? {} : { standing: pending.info.standing }),
    });
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.error.code).toBe("PIPELINE_CHANGE_REFUSED");
    // the file's own edit, the same
    const byFile = await person.acceptChange({ source: "file", text: changed });
    expect(byFile.ok).toBe(false);
    // `pipeline changes restore` writes the pipeline file back, and only that
    await writeFile(join(dir, file), changed);
    const restored = await person.restoreFile();
    expect(await readFile(join(dir, file), "utf8")).toBe(TEXT);
    expect(restored.hash).toBe(paused.specHash);
    // `pipeline changes discard` drops the proposal, and moves nothing
    expect(await person.discardProposal()).toBe(true);
    const after = await person.state();
    expect(after.engineSession).toEqual(paused.engineSession);
    expect(after.pauses).toEqual(paused.pauses);
    expect(after.specHash).toBe(paused.specHash);
    expect(adapter.starts).toBe(1);
  });
});

describe("t42 crash windows", () => {
  test("t42_crash_window6_result_save_lost", async () => {
    // the result of the session was not saved (the server left before it): the same owner, started
    // again, joins by id and reads the same end; nothing starts twice
    const adapter = new ScriptedSessionAdapter();
    const run = await runAtEngineStep(adapter, "mcp:1");
    adapter.finish(adapter.only().id, { state: "exited", exitCode: 0 }, '{"summary":"ok"}');
    const again = host(adapter, MCP, "mcp:1").open(run.runId);
    await again.tick();
    await until(async () => (await again.state()).active.some((v) => v.phase === "human"));
    expect(adapter.starts).toBe(1);
  });
});

describe("t42 people's commands never wait for or start a session", () => {
  const GATED = [
    "name: g",
    "nodes:",
    "  - { slug: approve, kind: human, prompt: approve }",
    "  - { slug: review, kind: agent, engine: reviewer, prompt: review }",
    "edges:",
    "  - { from: approve, to: review }",
    "  - { from: approve, to: review, when: rejected }",
    "",
  ].join("\n");

  test("t42_gate_returns_without_waiting", async () => {
    const adapter = new ScriptedSessionAdapter();
    const person = new LocalHost(parsePipeline(GATED), {
      root: dir,
      heartbeatMs: 0,
      integrityDir: join(dir, "integrity"),
      engine: HUMAN,
      engineResolver: new FakeEngineResolver(),
      engineSessions: () => adapter,
    });
    const { run } = await person.start("t");
    const decided = await run.decideHuman("approve", "approved");
    expect(decided.ok).toBe(true);
    const at = Date.now();
    // what `kodel gate` does after a decision: wait for the engine's work, up to 30 minutes
    await run.waitForRest(30 * 60_000, "approve");
    expect(Date.now() - at).toBeLessThan(2_000);
    expect(adapter.starts).toBe(0);
    expect((await run.state()).active[0]).toMatchObject({ node: "review", phase: "engine" });
  });

  test("t42_status_report_wait_never_spawn", async () => {
    const adapter = new ScriptedSessionAdapter();
    const person = new LocalHost(parsePipeline(GATED), {
      root: dir,
      heartbeatMs: 0,
      integrityDir: join(dir, "integrity"),
      engine: HUMAN,
      engineResolver: new FakeEngineResolver(),
      engineSessions: () => adapter,
    });
    const { run } = await person.start("t");
    await run.decideHuman("approve", "approved");
    const before = await filesOf(person.store.runDir(run.runId));
    // what `status`, `report` and `wait` read, from a host without engine steps and from a person's
    for (const reader of [
      new LocalHost(parsePipeline(GATED), { root: dir, integrityDir: join(dir, "integrity") }),
      person,
    ]) {
      const r = reader.open(run.runId);
      await r.state();
      await r.report();
      await r.journal();
      await r.nextStep();
    }
    expect(adapter.starts).toBe(0);
    expect(await filesOf(person.store.runDir(run.runId))).toEqual(before);
  });

  test("t42_shutdown_and_cancel_detach", async () => {
    const adapter = new ScriptedSessionAdapter();
    const run = await runAtEngineStep(adapter);
    const session = adapter.only();
    // the server stopped (`runAtEngineStep` called `stop`): the session runs on, nothing was written
    expect(session.status.state).toBe("running");
    // the server that stopped waiting names the session and how to stop it
    expect(run.sessionsNote()).toContain(`kodel agent stop ${session.id}`);
    const canceled = await host(adapter, HUMAN, "person:1").open(run.runId).cancel();
    expect(canceled.ok).toBe(true);
    expect(canceled.warning).toContain(`kodel agent stop ${session.id}`);
    // a cancel ends the run, not the session: the person stops it with `kodel agent stop <id>`
    expect(session.status.state).toBe("running");
    expect((await run.state()).engineSession?.id).toBe(session.id);
    expect(adapter.removes).toBe(0);
  });

  test("t42_checks_see_redacted_output", async () => {
    const adapter = new ScriptedSessionAdapter();
    const h = host(adapter, MCP);
    const { run } = await h.start("the task", {
      history: {
        ...defaultHistory(),
        changes: { ...defaultHistory().changes, enabled: false },
        output: { enabled: true, max_kb: 64 },
      },
    });
    await run.nextStep({ serve: {} });
    await run.completeStep("plan", 1, "planned");
    await until(async () => (await run.state()).engineSession?.id !== undefined);
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    adapter.finish(
      adapter.only().id,
      { state: "exited", exitCode: 0 },
      JSON.stringify({ summary: `found ${key}` }),
    );
    await run.settle();
    const journal = await run.journal();
    const finished = journal.find((r) => r.event === "command_finished");
    const ref = (finished?.output as { ref?: string } | undefined)?.ref;
    // what the checks of the step read is the kept output, and it is kept redacted
    expect(ref).toBeDefined();
    const kept = await readFile(join(h.store.runDir(run.runId), ref as string), "utf8");
    expect(kept).not.toContain(key);
    expect(kept).toContain("REDACTED");
    const all = JSON.stringify(journal) + JSON.stringify(await run.state());
    expect(all).not.toContain(key);
  });
});

describe("t42 writes made by hand", () => {
  test("t42_written_state_files_are_the_run_s", async () => {
    // the oracle above hashes every file of the run; a file added by hand shows in it
    const probe = join(dir, "probe");
    await mkdir(probe);
    const before = await filesOf(probe);
    await writeFile(join(probe, "x"), "y");
    expect(await filesOf(probe)).not.toEqual(before);
  });
});

describe("t42 a server waits for a session it does not own", () => {
  test("t42_wait_s_waits_on_a_session_of_another_process", async () => {
    const adapter = new ScriptedSessionAdapter();
    // the server that started the session waits for it in its own job
    const owner = host(adapter, MCP, "mcp:a");
    const { run } = await owner.start("the task");
    await run.nextStep({ serve: {} });
    await run.completeStep("plan", 1, "planned");
    await until(async () => (await run.state()).engineSession?.id !== undefined);
    // another server asked to wait (wait_s) watches the state, and starts or joins nothing
    const other = host(adapter, MCP, "mcp:b").open(run.runId);
    const at = Date.now();
    setTimeout(
      () => adapter.finish(adapter.only().id, { state: "exited", exitCode: 0 }, '{"summary":"ok"}'),
      400,
    );
    await other.waitForRest(5_000, "review", "step");
    const waited = Date.now() - at;
    expect(waited).toBeGreaterThanOrEqual(350);
    expect(waited).toBeLessThan(4_000);
    expect(adapter.starts).toBe(1);
    expect((await other.state()).active[0]?.node).toBe("approve");
    // a person's command does not wait on it
    const second = await host(adapter, MCP, "mcp:c").start("another task");
    await second.run.nextStep({ serve: {} });
    await second.run.completeStep("plan", 1, "planned");
    await until(async () => (await second.run.state()).engineSession?.id !== undefined);
    const person = host(adapter, HUMAN, "person:1").open(second.run.runId);
    const from = Date.now();
    await person.waitForRest(5_000, "review", "step");
    expect(Date.now() - from).toBeLessThan(1_000);
    second.run.stop();
  });
});
