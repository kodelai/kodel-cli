/**
 * Engine steps on the local host (T-42): the host starts an engine step's session only under the run's
 * lock after reading the record again, joins one it did not start, and turns every outcome it cannot
 * prove into an unknown attempt that waits for a person. A scripted adapter plays the sessions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configEngineResolver,
  LocalHost,
  type LocalRun,
  literalRules,
  PipesSessionAdapter,
  secretsOf,
} from "@kodel-ai/local";
import {
  defaultHistory,
  ENGINE_STEPS_OFF,
  ENGINE_UNKNOWN_PREFIX,
  type EngineOptions,
  type PipelineSpec,
  parsePipeline,
  type RedactRule,
  type RunState,
  redactText,
  SessionError,
} from "@kodel-ai/pipeline-core";
import { FakeEngineResolver, Gate, nodeScriptEngine, ScriptedSessionAdapter } from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-engine-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const ENGINE = parsePipeline(
  [
    "name: eng",
    "nodes:",
    "  - slug: review",
    "    kind: agent",
    "    engine: reviewer",
    "    prompt: review {{task}}",
    "",
  ].join("\n"),
);

const MCP: EngineOptions = { engineSteps: { start: true } };
const HUMAN: EngineOptions = { engineSteps: { start: false } };

function host(
  adapter: ScriptedSessionAdapter | undefined,
  options: {
    engine?: EngineOptions;
    resolver?: FakeEngineResolver;
    ownerId?: string;
    rules?: RedactRule[];
    platform?: NodeJS.Platform;
    spec?: PipelineSpec;
  } = {},
): LocalHost {
  return new LocalHost(options.spec ?? ENGINE, {
    root: dir,
    heartbeatMs: 0,
    integrityDir: join(dir, "integrity"),
    ...(options.engine === undefined ? {} : { engine: options.engine }),
    engineResolver: options.resolver ?? new FakeEngineResolver(),
    ...(adapter === undefined ? {} : { engineSessions: () => adapter }),
    ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
    ...(options.rules === undefined ? {} : { rules: options.rules }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    // A waiter in another process is alive unless the test says otherwise.
    isOwnerAlive: (owner) => owner !== "gone:1",
  });
}

const until = async (what: () => Promise<boolean> | boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!(await what())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const started = async (run: LocalRun) =>
  until(async () => (await run.state()).engineSession?.id !== undefined);

const events = async (h: LocalHost, run: LocalRun) =>
  (await h.store.readJournal(run.runId)).map((r) => r.event);

const RESULT = JSON.stringify({ summary: "looks fine" });

/** A record written by an issuer that froze before it took the lock (its resolver is held). */
async function frozenIssuer(adapter: ScriptedSessionAdapter) {
  const h = host(adapter, { engine: HUMAN });
  const { run } = await h.start("task");
  const frozen = new FakeEngineResolver();
  const gate = new Gate();
  frozen.gate = gate;
  const issuer = host(adapter, { engine: MCP, ownerId: "gone:1", resolver: frozen }).open(
    run.runId,
  );
  await issuer.apply({ type: "engine_start_pending", node: "review", attempt: 1 });
  expect((await issuer.state()).engineSession?.id).toBeUndefined();
  return { run, gate };
}

describe("t42 an engine step on the local host", () => {
  test("t42_engine_step_runs_as_named_host_session", async () => {
    const adapter = new ScriptedSessionAdapter();
    const h = host(adapter, { engine: MCP });
    const { run } = await h.start("fix the login");
    await started(run);
    expect(adapter.starts).toBe(1);
    const [spec] = adapter.specs;
    expect(spec?.name).toBe(`ke-${run.runId}-1-1`.toLowerCase());
    expect(spec?.origin).toBe("host");
    expect(spec?.inheritEnv).toBe(false);
    expect(spec?.argv?.at(-1)).toBe("review fix the login");
    expect(spec?.argv?.at(-2)).toBe("--");
    const session = adapter.only();
    adapter.finish(session.id, { state: "exited", exitCode: 0 }, RESULT);
    await run.settle();
    const state = await run.state();
    expect(state.status).toBe("completed");
    expect(state.engineSession).toBeUndefined();
    expect(await events(h, run)).toEqual([
      "run_started",
      "node_entered",
      "engine_session_started",
      "command_finished",
      "node_finished",
      "run_finished",
    ]);
    expect(adapter.removes).toBe(0);
  });

  test("t42_driver_cannot_complete_engine_step", async () => {
    const adapter = new ScriptedSessionAdapter();
    const h = host(adapter, { engine: MCP });
    const { run } = await h.start("task");
    await started(run);
    const done = await run.apply({ type: "agent_completed", node: "review", attempt: 1 });
    expect(done.ok).toBe(false);
    adapter.finish(adapter.only().id, { state: "exited", exitCode: 0 }, RESULT);
    await run.settle();
  });

  test("t42_result_failures_are_known_failures", async () => {
    const adapter = new ScriptedSessionAdapter();
    const h = host(adapter, { engine: MCP });
    const { run } = await h.start("task");
    await started(run);
    adapter.finish(adapter.only().id, { state: "exited", exitCode: 3 }, RESULT);
    await until(async () => (await run.state()).nodes.review?.attempt === 2);
    const state = await run.state();
    expect(state.nodes.review?.lastFailure).toMatchObject({ source: "command" });
    expect(state.nodes.review?.lastFailure?.reason).toContain("code 3");
    // the rework is a new attempt with a session of its own, never the first one again
    await until(() => adapter.starts === 2);
    expect(adapter.specs[1]?.name).toBe(`ke-${run.runId}-1-2`.toLowerCase());
    expect(adapter.specs[1]?.argv?.at(-1)).toContain("The previous attempt failed (command)");
    run.stop();
  });

  test("t42_human_decide_does_not_start_and_the_mcp_host_starts_once", async () => {
    const adapter = new ScriptedSessionAdapter();
    const human = host(adapter, { engine: HUMAN });
    const { run } = await human.start("task");
    expect(adapter.starts).toBe(0);
    expect((await run.state()).engineSession).toBeUndefined();
    // the MCP host's tick writes the record and starts it, once, however often it ticks
    const mcp = host(adapter, { engine: MCP, ownerId: "mcp:1" });
    const served = mcp.open(run.runId);
    await served.tick();
    await served.tick();
    await started(served);
    await served.tick();
    expect(adapter.starts).toBe(1);
    adapter.finish(adapter.only().id, { state: "exited", exitCode: 0 }, RESULT);
    await served.settle();
    expect((await served.state()).status).toBe("completed");
  });

  test("t42_takeover_rejoins_never_reruns", async () => {
    const adapter = new ScriptedSessionAdapter();
    const first = host(adapter, { engine: MCP, ownerId: "gone:1" });
    const { run } = await first.start("task");
    await started(run);
    run.stop(); // the first server leaves; the session goes on
    const second = host(adapter, { engine: MCP, ownerId: "mcp:2" });
    const joined = second.open(run.runId);
    await joined.tick();
    expect((await joined.state()).active[0]?.owner).toBe("mcp:2");
    adapter.finish(adapter.only().id, { state: "exited", exitCode: 0 }, RESULT);
    await joined.settle();
    expect(adapter.starts).toBe(1);
    expect((await joined.state()).status).toBe("completed");
    expect(adapter.removes).toBe(0);
  });
});

describe("t42 never twice", () => {
  test("t42_boot_failed_rolled_back_vs_began", async () => {
    // not listed after the throw: nothing ran, a known failure
    const quiet = new ScriptedSessionAdapter();
    quiet.failStart = { code: "HOLDER_BOOT_FAILED" };
    const h = host(quiet, { engine: MCP });
    const { run } = await h.start("task a");
    await until(async () => (await run.state()).status === "paused");
    expect((await run.state()).nodes.review?.lastFailure?.source).toBe("command");
    expect((await run.state()).engineSession).toBeUndefined();
    run.stop();
    // listed after the throw: it may have begun, the outcome is unknown
    const began = new ScriptedSessionAdapter();
    began.failStart = { code: "HOLDER_BOOT_FAILED", listed: true };
    const h2 = host(began, { engine: MCP });
    const second = (await h2.start("task b")).run;
    await until(async () => (await second.state()).status === "paused");
    const state = await second.state();
    expect(state.nodes.review?.lastFailure?.source).toBe("session");
    expect(state.engineSession).toBeDefined();
    expect(began.starts).toBe(1);
  });

  test("t42_crash_windows_used_name_is_unknown", async () => {
    const adapter = new ScriptedSessionAdapter();
    adapter.failStart = { code: "NAME_USED" };
    const h = host(adapter, { engine: MCP });
    const { run } = await h.start("task");
    await until(async () => (await run.state()).status === "paused");
    const state = await run.state();
    expect(state.nodes.review?.lastFailure?.reason.startsWith(ENGINE_UNKNOWN_PREFIX)).toBe(true);
    // ticks of any host start nothing more
    await host(adapter, { engine: MCP, ownerId: "mcp:2" }).open(run.runId).tick();
    expect(adapter.starts).toBe(1);
  });

  test("t42_no_id_lookup_unreadable_entry_is_unknown", async () => {
    const adapter = new ScriptedSessionAdapter();
    const { run, gate } = await frozenIssuer(adapter);
    // a session of the record's name IS listed, but another entry cannot be read: still unknown
    adapter.sessions.set("a_000000099_fake", {
      id: "a_000000099_fake",
      name: `ke-${run.runId}-1-1`.toLowerCase(),
      spec: { argv: ["x"], cwd: "/" },
      status: { state: "running" },
      stdout: "",
      complete: true,
    });
    adapter.unreadableEntry = true;
    const late = host(adapter, { engine: MCP, ownerId: "mcp:3" }).open(run.runId);
    await late.tick();
    await until(async () => (await late.state()).status === "paused");
    expect((await late.state()).nodes.review?.lastFailure?.reason).toContain("cannot be read");
    gate.open();
  });

  test("t42_frozen_issuer_after_joiner_unknown_spawns_nothing", async () => {
    const adapter = new ScriptedSessionAdapter();
    const { run, gate } = await frozenIssuer(adapter);
    // the joiner finds no session of the name: unknown, the run pauses
    const late = host(adapter, { engine: MCP, ownerId: "mcp:3" }).open(run.runId);
    await late.tick();
    await until(async () => (await late.state()).status === "paused");
    // the issuer wakes, reads the record again under the lock, finds the attempt paused: no start
    gate.open();
    await new Promise((r) => setTimeout(r, 300));
    expect(adapter.starts).toBe(0);
    expect((await late.state()).status).toBe("paused");
  });

  test.skipIf(process.platform === "win32")(
    "t42_test_hook_inert_by_default",
    async () => {
      // an adapter built as the CLI builds it (no hooks) publishes and boots a session normally; a hook
      // that throws (the window-3 test) would have stopped it right after the publish
      const base = join(dir, "hook-state");
      const entry = new URL("../../local/src/session-holder-entry.ts", import.meta.url).pathname;
      const adapter = new PipesSessionAdapter({
        base,
        root: dir,
        holder: { exec: process.execPath, args: [entry, "holder"] },
        intermediate: { exec: process.execPath, args: [entry] },
      });
      const { id } = await adapter.start({
        argv: [process.execPath, "-e", "0"],
        cwd: dir,
        timeoutMs: 10_000,
        origin: "host",
      });
      const done = await adapter.wait(id, { timeoutMs: 10_000 });
      expect(done.state).toBe("exited");
    },
    20_000,
  );
});

describe("t42 resume after an unknown outcome", () => {
  async function unknownRun(adapter: ScriptedSessionAdapter) {
    const h = host(adapter, { engine: MCP });
    const { run } = await h.start("task");
    await started(run);
    adapter.failWait = undefined;
    // the waiter learns the session was lost
    adapter.finish(adapter.only().id, { state: "lost", reason: "holder_gone" });
    await until(async () => (await run.state()).status === "paused");
    return { h, run };
  }

  test("t42_resume_after_unknown_not_found_warns", async () => {
    // a session this checkout does not see (another checkout, another state base) is not "ended"
    const adapter = new ScriptedSessionAdapter();
    const { run } = await unknownRun(adapter);
    const id = adapter.only().id;
    adapter.sessions.delete(id);
    const resumed = await host(adapter, { engine: HUMAN }).open(run.runId).resume();
    expect(resumed.ok).toBe(true);
    expect(resumed.warning).toContain(id);
    expect(resumed.warning).toContain("another checkout");
  });

  test("t42_issuer_abandons_a_record_it_never_started", async () => {
    // the attempt moved on before the issuer took the lock (here: the run was canceled); the issuer
    // never called start(), so its record goes and no later look can take it for an unknown start
    const adapter = new ScriptedSessionAdapter();
    const { run, gate } = await frozenIssuer(adapter);
    await host(adapter, { engine: HUMAN }).open(run.runId).cancel();
    expect((await run.state()).engineSession?.id).toBeUndefined();
    gate.open();
    await until(async () => (await run.state()).engineSession === undefined);
    expect(adapter.starts).toBe(0);
  });

  test("t42_failed_step_keeps_its_output", async () => {
    const adapter = new ScriptedSessionAdapter();
    const { run } = await host(adapter, { engine: MCP }).start("fails loudly");
    await started(run);
    adapter.finish(adapter.only().id, { state: "exited", exitCode: 3 }, "boom: the detail\n");
    await until(async () => (await run.state()).nodes.review?.lastFailure !== undefined);
    const reason = (await run.state()).nodes.review?.lastFailure?.reason ?? "";
    expect(reason).toContain("code 3");
    expect(reason).toContain("boom: the detail");
    run.stop();
  });

  test("t42_cancel_names_only_a_started_session", async () => {
    const adapter = new ScriptedSessionAdapter();
    const { run, gate } = await frozenIssuer(adapter);
    const canceled = await host(adapter, { engine: HUMAN }).open(run.runId).cancel();
    expect(canceled.ok).toBe(true);
    expect(canceled.warning).toContain("was not recorded as started");
    gate.open();
  });

  test("t42_resume_after_unknown", async () => {
    const adapter = new ScriptedSessionAdapter();
    const { run } = await unknownRun(adapter);
    const state = await run.state();
    expect(state.nodes.review?.lastFailure?.source).toBe("session");
    // still running (its child is alive): refused, and nothing is written
    const session = adapter.only();
    session.status = { state: "exited", exitCode: 0, childAlive: true };
    const person = host(adapter, { engine: HUMAN }).open(run.runId);
    const refused = await person.resume();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("kodel agent stop");
    // over: cleared, and the person's resume starts nothing
    session.status = { state: "exited", exitCode: 0 };
    const resumed = await person.resume();
    expect(resumed.ok).toBe(true);
    expect(resumed.warning).toBeUndefined();
    const after = await person.state();
    expect(after.engineSession).toBeUndefined();
    expect(adapter.starts).toBe(1);
  });

  test("t42_resume_after_unknown_unreadable_warns", async () => {
    const adapter = new ScriptedSessionAdapter();
    const { run } = await unknownRun(adapter);
    // the session's record cannot be read: cleared, with a warning that names it
    adapter.status = async () => {
      throw new SessionError("CANNOT_READ", "the record is torn");
    };
    const person = host(adapter, { engine: HUMAN }).open(run.runId);
    const resumed = await person.resume();
    expect(resumed.ok).toBe(true);
    expect(resumed.warning).toContain("cannot be read");
    expect(resumed.warning).toContain("kodel agent stop");
  });

  test("t42_resume_without_a_session_adapter_fails_closed", async () => {
    const adapter = new ScriptedSessionAdapter();
    const { run } = await unknownRun(adapter);
    const before = await run.state();
    const resumed = await host(undefined, { engine: HUMAN }).open(run.runId).resume();
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) expect(resumed.error.message).toContain("cannot look its session");
    expect((await run.state()).engineSession).toEqual(before.engineSession);
  });

  test("t42_accept_refused_on_unknown_pause", async () => {
    const adapter = new ScriptedSessionAdapter();
    const { run } = await unknownRun(adapter);
    const person = host(adapter, { engine: HUMAN }).open(run.runId);
    const text =
      "name: eng\nnodes:\n  - slug: review\n    kind: agent\n    engine: reviewer\n    prompt: other\n";
    const accepted = await person.acceptChange({ source: "file", text });
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.error.code).toBe("PIPELINE_CHANGE_REFUSED");
  });
});

describe("t42 refused before anything is written", () => {
  const runsOf = async () => {
    const runs = join(dir, ".kodel", "runs");
    return existsSync(runs) ? await readdir(runs) : [];
  };

  test("t42_host_without_engine_steps_refuses_and_tick_writes_nothing", async () => {
    const h = host(new ScriptedSessionAdapter());
    const refused = await h.start("task").catch((e: unknown) => e);
    expect((refused as Error).message).toBe(ENGINE_STEPS_OFF);
    expect(await runsOf()).toEqual([]);
  });

  test("t42_refused_before_write", async () => {
    for (const options of [
      { engine: MCP, platform: "win32" as const },
      { engine: MCP, rules: [{ name: "f", pattern: /x/g, replace: () => "y" }] },
    ]) {
      const refused = await host(new ScriptedSessionAdapter(), options)
        .start("task")
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(Error);
      expect(await runsOf()).toEqual([]);
    }
  });
});

describe("t42 the launch", () => {
  test("t42_secret_never_reaches_kodel_sinks", async () => {
    const secret = "s3cr3t-value-that-is-long";
    const adapter = new ScriptedSessionAdapter();
    const resolver = new FakeEngineResolver({ env: { TOKEN: secret }, secrets: [secret] });
    const h = new LocalHost(ENGINE, {
      root: dir,
      heartbeatMs: 0,
      integrityDir: join(dir, "integrity"),
      engine: MCP,
      engineResolver: resolver,
      engineSessions: () => adapter,
    });
    const { run } = await h.start("task");
    await started(run);
    // the session gets the value; what kodel keeps never holds it
    expect(adapter.specs[0]?.env?.TOKEN).toBe(secret);
    adapter.finish(
      adapter.only().id,
      { state: "exited", exitCode: 0 },
      JSON.stringify({ summary: `the token is ${secret}` }),
    );
    await run.settle();
    const runDir = h.store.runDir(run.runId);
    const all = async (path: string): Promise<string> => {
      const entries = await readdir(path, { withFileTypes: true });
      const parts = await Promise.all(
        entries.map((e) =>
          e.isDirectory() ? all(join(path, e.name)) : readFile(join(path, e.name), "utf8"),
        ),
      );
      return parts.join("\n");
    };
    expect(await all(runDir)).not.toContain(secret);
    expect((await run.state()).status).toBe("completed");
  });

  test("t42_short_or_path_env_value_not_redacted", async () => {
    // The path side at unit level, with the disk injected: an end-to-end path would sit under the
    // machine's temp folder, whose name may look random and be hidden by the built-in entropy rule.
    const token = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const onDisk = (path: string) => path === "/srv/kodel/engine/work";
    expect(
      secretsOf(["short", "/srv/kodel/engine/work", token, "/not/on/this/disk/at/all"], onDisk),
    ).toEqual([token, "/not/on/this/disk/at/all"]);
    // a path whose segments are not plain words is not taken for one, even if it exists
    expect(secretsOf(["/srv/kodel/a+b/work=x"], () => true)).toEqual(["/srv/kodel/a+b/work=x"]);
    const rules = literalRules(['quote"inside-value', token]);
    expect(rules.map((r) => r.pattern.source)).toContain('quote\\\\"inside-value');
    // its JSON form with `/` written `\/` is redacted too
    expect(redactText(JSON.stringify(token).replaceAll("/", "\\/"), rules)).not.toContain(
      "EXAMPLEKEY",
    );

    // end to end, the secret side: the step prints the token; it is gone from the reason, the journal
    // and the kept file
    const adapter = new ScriptedSessionAdapter();
    const h = new LocalHost(ENGINE, {
      root: dir,
      heartbeatMs: 0,
      integrityDir: join(dir, "integrity"),
      engine: MCP,
      engineResolver: configEngineResolver(
        async () => ({ reviewer: { command: ["prog"], pass_env: ["AWS_SECRET"] } }),
        () => ({ PATH: "/bin", AWS_SECRET: token }),
      ),
      engineSessions: () => adapter,
    });
    const { run } = await h.start("print the token", {
      history: {
        ...defaultHistory(),
        changes: { ...defaultHistory().changes, enabled: false },
        output: { enabled: true, max_kb: 64 },
      },
    });
    await started(run);
    adapter.finish(adapter.only().id, { state: "exited", exitCode: 1 }, `it was ${token} here\n`);
    await until(async () => (await run.state()).nodes.review?.lastFailure !== undefined);
    run.stop();
    const reason = (await run.state()).nodes.review?.lastFailure?.reason ?? "";
    expect(reason).toContain("it printed: it was ");
    expect(reason).not.toContain(token);
    expect(reason).not.toContain("EXAMPLEKEY");
    const journal = await run.journal();
    expect(JSON.stringify(journal)).not.toContain("EXAMPLEKEY");
    const ref = (
      journal.find((r) => r.event === "command_finished")?.output as { ref: string } | undefined
    )?.ref;
    expect(ref).toBeDefined();
    const kept = await readFile(join(h.store.runDir(run.runId), ref as string), "utf8");
    expect(kept).toContain("it was ");
    expect(kept).not.toContain("EXAMPLEKEY");
  });

  test("t42_child_env_is_allow_list", async () => {
    const resolver = configEngineResolver(
      async () => ({
        reviewer: {
          command: ["prog", "--json"],
          model_flag: "--model",
          pass_env: ["API_KEY"],
          env: { MODE: "x" },
        },
      }),
      () => ({ PATH: "/bin", HOME: "/h", API_KEY: "k", SSH_AUTH_SOCK: "/s", KODEL_X: "1" }),
    );
    const out = await resolver.resolve(
      { profile: "reviewer", prompt: "p", model: "m" },
      { cwd: "/w" },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.launch.env).toEqual({ PATH: "/bin", HOME: "/h", API_KEY: "k", MODE: "x" });
    expect(out.launch.argv).toEqual(["prog", "--json", "--model", "m", "--", "p"]);
    expect(out.launch.timeoutMs).toBe(3_600_000);
    const missing = await configEngineResolver(
      async () => ({ reviewer: { command: ["p"], pass_env: ["NOPE"] } }),
      () => ({}),
    ).resolve({ profile: "reviewer", prompt: "p" }, { cwd: "/w" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("pass_env");
  });

  test("t42_state_keeps_the_record_shape", async () => {
    const adapter = new ScriptedSessionAdapter();
    const h = host(adapter, { engine: MCP });
    const { run } = await h.start("task");
    await started(run);
    const state = (await run.state()) as RunState;
    expect(Object.keys(state.engineSession ?? {}).sort()).toEqual([
      "attempt",
      "id",
      "name",
      "node",
      "visitId",
    ]);
    run.stop();
  });
});

describe("t42 a real session", () => {
  const posix = process.platform !== "win32";
  test("t42_real_tests_skip_only_on_windows", async () => {
    // the one reason the real tests skip, asserted: sessions refuse to start on Windows (TASK-W58V);
    // anywhere else the adapter starts one, so the real tests run
    const entry = new URL("../../local/src/session-holder-entry.ts", import.meta.url).pathname;
    const adapter = new PipesSessionAdapter({
      base: join(dir, "skip-state"),
      root: dir,
      holder: { exec: process.execPath, args: [entry, "holder"] },
      intermediate: { exec: process.execPath, args: [entry] },
    });
    const started = adapter.start({
      argv: [process.execPath, "-e", "0"],
      cwd: dir,
      timeoutMs: 10_000,
      origin: "host",
    });
    if (posix) expect((await started).id).toMatch(/^a_/);
    else await expect(started).rejects.toMatchObject({ code: "PLATFORM_UNSUPPORTED" });
  });

  test.skipIf(!posix)(
    "t42_engine_step_runs_as_named_host_session_real",
    async () => {
      const state = join(dir, "state");
      const entry = new URL("../../local/src/session-holder-entry.ts", import.meta.url).pathname;
      const make = (rules: RedactRule[], bootTimeoutMs: number) =>
        new PipesSessionAdapter({
          base: state,
          root: dir,
          holder: { exec: process.execPath, args: [entry, "holder"] },
          intermediate: { exec: process.execPath, args: [entry] },
          rules,
          bootTimeoutMs,
        });
      const command = nodeScriptEngine(dir, {
        stdout: JSON.stringify({ summary: "prompt of {{prompt_bytes}} bytes" }),
      });
      const h = new LocalHost(ENGINE, {
        root: dir,
        heartbeatMs: 0,
        integrityDir: join(dir, "integrity"),
        engine: MCP,
        engineResolver: configEngineResolver(
          async () => ({ reviewer: { command, timeout: 30 } }),
          () => ({ PATH: process.env.PATH }),
        ),
        engineSessions: ({ rules, bootTimeoutMs }) => make(rules, bootTimeoutMs),
      });
      const { run } = await h.start("real task");
      await until(async () => (await run.state()).status === "completed", 20_000);
      const journal = await h.store.readJournal(run.runId);
      const started = journal.find((r) => r.event === "engine_session_started");
      expect(started?.name).toBe(`ke-${run.runId}-1-1`.toLowerCase());
      const listed = await make([], 5_000).list();
      expect(listed.map((e) => e.name)).toContain(`ke-${run.runId}-1-1`.toLowerCase());
      expect(listed.find((e) => e.id === started?.id)?.status.state).toBe("exited");
    },
    30_000,
  );
});

describe("t42 crash windows with the real adapter", () => {
  test.skipIf(process.platform === "win32")(
    "t42_window3_real_adapter",
    async () => {
      // the process dies inside start() after the session folder is published: the next look lists
      // it, so the outcome is unknown and nothing is started again
      const state = join(dir, "state");
      const entry = new URL("../../local/src/session-holder-entry.ts", import.meta.url).pathname;
      let starts = 0;
      const h = new LocalHost(ENGINE, {
        root: dir,
        heartbeatMs: 0,
        integrityDir: join(dir, "integrity"),
        engine: MCP,
        engineResolver: new FakeEngineResolver({ argv: [process.execPath, "-e", "0"] }),
        engineSessions: ({ rules, bootTimeoutMs }) =>
          new PipesSessionAdapter({
            base: state,
            root: dir,
            holder: { exec: process.execPath, args: [entry, "holder"] },
            intermediate: { exec: process.execPath, args: [entry] },
            rules,
            bootTimeoutMs,
            testHooks: {
              afterPublish: () => {
                starts += 1;
                throw new Error("the process died here");
              },
            },
          }),
      });
      const { run } = await h.start("crash");
      await until(async () => (await run.state()).status === "paused");
      const after = await run.state();
      expect(after.nodes.review?.lastFailure?.source).toBe("session");
      expect(after.engineSession?.id).toBeUndefined();
      await h.open(run.runId).tick();
      expect(starts).toBe(1);
    },
    20_000,
  );
});

describe("t42 more crash windows and limits with the real adapter", () => {
  const posix = process.platform !== "win32";
  const entry = new URL("../../local/src/session-holder-entry.ts", import.meta.url).pathname;
  const adapterAt = (state: string) => (rules: RedactRule[], bootTimeoutMs: number) =>
    new PipesSessionAdapter({
      base: state,
      root: dir,
      holder: { exec: process.execPath, args: [entry, "holder"] },
      intermediate: { exec: process.execPath, args: [entry] },
      rules,
      bootTimeoutMs,
    });

  test.skipIf(!posix)(
    "t42_window4_real_adapter",
    async () => {
      // `start()` answered but the process died before the id was written: the record has no id, the
      // session runs under its name. The next server lists it, writes its id and waits; nothing starts.
      const state = join(dir, "state");
      const make = adapterAt(state);
      const command = nodeScriptEngine(dir, { sleepMs: 300 });
      const person = host(new ScriptedSessionAdapter(), { engine: HUMAN });
      const { run } = await person.start("window four");
      // the dying issuer: its record is written, its job is held before the lock
      const frozen = new FakeEngineResolver();
      frozen.gate = new Gate();
      const issuer = host(new ScriptedSessionAdapter(), {
        engine: MCP,
        ownerId: "gone:1",
        resolver: frozen,
      }).open(run.runId);
      await issuer.apply({ type: "engine_start_pending", node: "review", attempt: 1 });
      const record = (await issuer.state()).engineSession;
      if (record === undefined) throw new Error("no record");
      // what its start() did before it died
      await make([], 5_000).start({
        argv: [...command, "--", "the prompt"],
        cwd: dir,
        env: { PATH: process.env.PATH ?? "" },
        inheritEnv: false,
        timeoutMs: 30_000,
        name: record.name,
        origin: "host",
      });
      issuer.stop();
      let starts = 0;
      const joiner = new LocalHost(ENGINE, {
        root: dir,
        heartbeatMs: 0,
        integrityDir: join(dir, "integrity"),
        engine: MCP,
        ownerId: "mcp:4",
        isOwnerAlive: (owner) => owner !== "gone:1",
        engineResolver: new FakeEngineResolver(),
        engineSessions: ({ rules, bootTimeoutMs }) => {
          const real = make(rules, bootTimeoutMs);
          const start = real.start.bind(real);
          real.start = (spec) => {
            starts += 1;
            return start(spec);
          };
          return real;
        },
      }).open(run.runId);
      await joiner.tick();
      await until(async () => (await joiner.state()).status === "completed", 20_000);
      expect(starts).toBe(0);
      const journal = await joiner.journal();
      expect(journal.filter((r) => r.event === "engine_session_started")).toHaveLength(1);
    },
    30_000,
  );

  test.skipIf(!posix)(
    "t42_session_timeout_fails",
    async () => {
      const state = join(dir, "state");
      const make = adapterAt(state);
      const command = nodeScriptEngine(dir, { sleepMs: 10_000 });
      const h = new LocalHost(ENGINE, {
        root: dir,
        heartbeatMs: 0,
        integrityDir: join(dir, "integrity"),
        engine: MCP,
        engineResolver: configEngineResolver(
          async () => ({ reviewer: { command, timeout: 1 } }),
          () => ({ PATH: process.env.PATH }),
        ),
        engineSessions: ({ rules, bootTimeoutMs }) => make(rules, bootTimeoutMs),
      });
      const { run } = await h.start("too slow");
      await until(async () => (await run.state()).nodes.review?.lastFailure !== undefined, 20_000);
      const failure = (await run.state()).nodes.review?.lastFailure;
      expect(failure?.source).toBe("command");
      expect(failure?.reason).toContain("timeout");
      run.stop();
    },
    30_000,
  );
});

describe("t42 the oracle of never twice", () => {
  const RESULT_OK = JSON.stringify({ summary: "ok" });
  const settleTo = async (run: LocalRun, status: string) =>
    until(async () => (await run.state()).status === status, 5_000);

  test("t42_crash_windows", async () => {
    const starts: Record<string, number> = {};
    // (1) the decision that would write the record was lost: a person's host entered the step and
    // wrote none; the starting host's tick writes it and starts once
    {
      const adapter = new ScriptedSessionAdapter();
      const { run } = await host(adapter, { engine: HUMAN }).start("w1");
      const mcp = host(adapter, { engine: MCP, ownerId: "mcp:1" }).open(run.runId);
      await mcp.tick();
      await mcp.tick();
      await started(mcp);
      adapter.finish(adapter.only().id, { state: "exited", exitCode: 0 }, RESULT_OK);
      await settleTo(mcp, "completed");
      starts.w1 = adapter.starts;
    }
    // (2) the record was saved and the issuer died before start(): not listed, unknown
    // (4) it died after start(), before the id was written: listed by name, joined, finished
    for (const window of ["w2", "w4"] as const) {
      const adapter = new ScriptedSessionAdapter();
      const { run } = await host(adapter, { engine: HUMAN }).start(window);
      await host(adapter, {
        engine: MCP,
        ownerId: "gone:1",
        resolver: Object.assign(new FakeEngineResolver(), { gate: new Gate() }),
      })
        .open(run.runId)
        .apply({ type: "engine_start_pending", node: "review", attempt: 1 });
      if (window === "w4") {
        adapter.sessions.set("a_000000077_fake", {
          id: "a_000000077_fake",
          name: `ke-${run.runId}-1-1`.toLowerCase(),
          spec: { argv: ["x"], cwd: "/" },
          status: { state: "exited", exitCode: 0 },
          stdout: RESULT_OK,
          complete: true,
        });
      }
      const joiner = host(adapter, { engine: MCP, ownerId: "mcp:2" }).open(run.runId);
      await joiner.tick();
      await settleTo(joiner, window === "w2" ? "paused" : "completed");
      starts[window] = adapter.starts;
    }
    // (3) the process died inside start() after the folder was made: listed, unknown
    {
      const adapter = new ScriptedSessionAdapter();
      adapter.failStart = { code: "STATE_UNWRITABLE", listed: true };
      const { run } = await host(adapter, { engine: MCP }).start("w3");
      await settleTo(run, "paused");
      await host(adapter, { engine: MCP, ownerId: "mcp:2" }).open(run.runId).tick();
      starts.w3 = adapter.starts;
    }
    // (5) after the id was written: the next server joins by id
    // (6) the result was not saved: the same owner, started again, reads the same end
    for (const window of ["w5", "w6"] as const) {
      const adapter = new ScriptedSessionAdapter();
      const owner = window === "w5" ? "gone:1" : "mcp:6";
      const { run } = await host(adapter, { engine: MCP, ownerId: owner }).start(window);
      await started(run);
      run.stop();
      adapter.finish(adapter.only().id, { state: "exited", exitCode: 0 }, RESULT_OK);
      const next = host(adapter, {
        engine: MCP,
        ownerId: window === "w5" ? "mcp:5" : owner,
      }).open(run.runId);
      await next.tick();
      await settleTo(next, "completed");
      starts[window] = adapter.starts;
    }
    expect(starts).toEqual({ w1: 1, w2: 0, w3: 1, w4: 0, w5: 1, w6: 1 });
    for (const n of Object.values(starts)) expect(n).toBeLessThanOrEqual(1);
  });

  test("t42_host_never_calls_remove", async () => {
    type Row = {
      name: string;
      arrange?: (a: ScriptedSessionAdapter) => void;
      end?: object;
      out?: string;
    };
    const rows: Row[] = [
      { name: "result", end: { state: "exited", exitCode: 0 }, out: RESULT_OK },
      { name: "non-zero", end: { state: "exited", exitCode: 3 } },
      { name: "invalid output", end: { state: "exited", exitCode: 0 }, out: "nope" },
      { name: "killed", end: { state: "killed", reason: "timeout" } },
      { name: "lost", end: { state: "lost", reason: "holder_gone" } },
      { name: "child alive", end: { state: "exited", exitCode: 0, childAlive: true } },
      { name: "start refused", arrange: (a) => (a.failStart = { code: "HOLDER_BOOT_FAILED" }) },
      {
        name: "start began",
        arrange: (a) => (a.failStart = { code: "HOLDER_BOOT_FAILED", listed: true }),
      },
      { name: "name used", arrange: (a) => (a.failStart = { code: "NAME_USED" }) },
      { name: "unreadable", arrange: (a) => (a.failWait = "CANNOT_READ") },
    ];
    for (const row of rows) {
      const adapter = new ScriptedSessionAdapter();
      row.arrange?.(adapter);
      const { run } = await host(adapter, { engine: MCP }).start(`remove ${row.name}`);
      if (row.end !== undefined) {
        await started(run);
        adapter.finish(adapter.only().id, row.end as never, row.out ?? "");
      }
      await until(async () => {
        const s = await run.state();
        return s.status !== "running" || (s.nodes.review?.attempt ?? 0) > 1;
      }, 5_000);
      run.stop();
      expect(adapter.removes, row.name).toBe(0);
    }
  });

  test("t42_spec_from_resolved_profile", async () => {
    const adapter = new ScriptedSessionAdapter();
    const spec = parsePipeline(
      "name: eng\nnodes:\n  - slug: review\n    kind: agent\n    engine: reviewer\n    model: big\n    timeout: 120\n    prompt: review {{task}}\n",
    );
    const h = host(adapter, {
      engine: MCP,
      spec,
      resolver: undefined,
    });
    const real = new LocalHost(spec, {
      ...h.options,
      engineResolver: configEngineResolver(
        async () => ({
          reviewer: {
            command: ["prog", "-p"],
            model_flag: "--model",
            pass_env: ["API_TOKEN"],
            env: { MODE: "review" },
            timeout: 900,
          },
        }),
        () => ({ PATH: "/bin", HOME: "/home/x", API_TOKEN: "t", SECRET_OTHER: "no" }),
      ),
    });
    const { run } = await real.start("the profile");
    await started(run);
    const [given] = adapter.specs;
    expect(given).toMatchObject({
      argv: ["prog", "-p", "--model", "big", "--", "review the profile"],
      cwd: dir,
      env: { PATH: "/bin", HOME: "/home/x", API_TOKEN: "t", MODE: "review" },
      inheritEnv: false,
      // the node's own timeout wins over the profile's
      timeoutMs: 120_000,
      origin: "host",
      name: `ke-${run.runId}-1-1`.toLowerCase(),
    });
    run.stop();
  });
});

describe("t42 secrets and the real adapter", () => {
  test.skipIf(process.platform === "win32")(
    "t42_secret_never_reaches_kodel_sinks_real",
    async () => {
      // The value of a pass_env variable, printed by the program on both streams and put in the
      // prompt: the session's own files (its record's argv, the holder's tails, which `agent ls` and
      // `agent logs` print) and what the run records of the step never hold it.
      const secret = "pass-env-value-0123456789";
      const state = join(dir, "state");
      const entry = new URL("../../local/src/session-holder-entry.ts", import.meta.url).pathname;
      const script = join(dir, "leak.mjs");
      await writeFile(
        script,
        "process.stderr.write(process.env.API_TOKEN + '\\n');\nprocess.stdout.write(JSON.stringify({ summary: 'token ' + process.env.API_TOKEN }));\n",
      );
      const h = new LocalHost(ENGINE, {
        root: dir,
        heartbeatMs: 0,
        integrityDir: join(dir, "integrity"),
        engine: MCP,
        engineResolver: configEngineResolver(
          async () => ({
            reviewer: { command: [process.execPath, script], pass_env: ["API_TOKEN"], timeout: 30 },
          }),
          () => ({ PATH: process.env.PATH, API_TOKEN: secret }),
        ),
        engineSessions: ({ rules, bootTimeoutMs }) =>
          new PipesSessionAdapter({
            base: state,
            root: dir,
            holder: { exec: process.execPath, args: [entry, "holder"] },
            intermediate: { exec: process.execPath, args: [entry] },
            rules,
            bootTimeoutMs,
          }),
      });
      const { run } = await h.start(`look at ${secret}`);
      await until(async () => (await run.state()).status === "completed", 20_000);
      const all = async (path: string): Promise<string> => {
        const entries = await readdir(path, { withFileTypes: true });
        const parts = await Promise.all(
          entries.map((e) =>
            e.isDirectory()
              ? all(join(path, e.name))
              : e.isFile()
                ? readFile(join(path, e.name), "utf8").catch(() => "")
                : Promise.resolve(""),
          ),
        );
        return parts.join("\n");
      };
      const sessions = await all(state);
      expect(sessions).toContain("REDACTED");
      expect(sessions).not.toContain(secret);
      // the run keeps the task as the person typed it (redacted by the project's rules only, before any
      // profile is read); everything the step produced is free of the value
      const journal = (await run.journal()).filter((r) => r.event !== "run_started");
      expect(JSON.stringify(journal)).not.toContain(secret);
    },
    30_000,
  );
});

describe("t42 the open run of the fixture goes on", () => {
  test("t42_v2_engine_open_run_goes_on_in_its_format", async () => {
    // AGENTS.md rule 1: an open run of a stored format goes on in its own format. The open run of
    // `fixtures/formats/v2-engine/` waits for its engine session; a server joins it by the recorded id
    // and reads its end, writing format 2 and starting nothing.
    const { cp } = await import("node:fs/promises");
    const { LocalPipelineHost } = await import("@kodel-ai/local");
    const id = "r_0mw18z17b_0uiy";
    const from = new URL(`../../../fixtures/formats/v2-engine/${id}`, import.meta.url).pathname;
    await cp(from, join(dir, ".kodel", "runs", id), { recursive: true });
    const before = JSON.parse(
      await readFile(join(dir, ".kodel", "runs", id, "state.json"), "utf8"),
    );
    const record = before.engineSession as { id: string; name: string };
    const adapter = new ScriptedSessionAdapter();
    adapter.sessions.set(record.id, {
      id: record.id,
      name: record.name,
      spec: { argv: ["x"], cwd: "/" },
      status: { state: "exited", exitCode: 0 },
      stdout: JSON.stringify({ summary: "joined late" }),
      complete: true,
    });
    const server = new LocalPipelineHost({
      root: dir,
      integrityDir: join(dir, "integrity"),
      heartbeatMs: 0,
      engine: MCP,
      ownerId: "mcp:9",
      isOwnerAlive: (owner) => owner !== "fixture-host:1",
      engineResolver: new FakeEngineResolver(),
      engineSessions: () => adapter,
    });
    const run = await server.open(id);
    if (!run) throw new Error("the fixture run does not open");
    await run.tick();
    await until(async () =>
      (await run.journal()).some((r) => r.event === "command_finished" && r.passed === true),
    );
    run.stop();
    const after = await run.state();
    expect(after.v).toBe(2);
    expect((await run.journal()).every((r) => r.v === 2)).toBe(true);
    expect(after.engineSession?.attempt ?? 0).not.toBe(1);
    expect(adapter.starts).toBe(0);
    expect(adapter.removes).toBe(0);
  });
});

describe("t42 what a server names when it leaves", () => {
  test("t42_shutdown_names_only_started_sessions", async () => {
    // a start that is still before its lock (the resolver is held) has no id: nothing to name
    const adapter = new ScriptedSessionAdapter();
    const person = host(adapter, { engine: HUMAN });
    const { run } = await person.start("task");
    const frozen = new FakeEngineResolver();
    frozen.gate = new Gate();
    const issuer = host(adapter, { engine: MCP, ownerId: "mcp:1", resolver: frozen }).open(
      run.runId,
    );
    await issuer.apply({ type: "engine_start_pending", node: "review", attempt: 1 });
    issuer.stop();
    expect(issuer.sessionsNote()).toBeUndefined();
    frozen.gate.open();
    // a started one is named with how to stop it
    const other = new ScriptedSessionAdapter();
    const second = (await host(other, { engine: MCP, ownerId: "mcp:2" }).start("task 2")).run;
    await started(second);
    second.stop();
    expect(second.sessionsNote()).toContain(`kodel agent stop ${other.only().id}`);
  });
});

describe("t42 the child's environment, for real", () => {
  test.skipIf(process.platform === "win32")(
    "t42_child_env_is_allow_list_real",
    async () => {
      // the engine's program writes the environment it got; the host's own has more than the allow-list
      const state = join(dir, "state");
      const entry = new URL("../../local/src/session-holder-entry.ts", import.meta.url).pathname;
      const seen = join(dir, "env.json");
      const script = join(dir, "env.mjs");
      await writeFile(
        script,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env));\nprocess.stdout.write(JSON.stringify({ summary: "ok" }));\n`,
      );
      const h = new LocalHost(ENGINE, {
        root: dir,
        heartbeatMs: 0,
        integrityDir: join(dir, "integrity"),
        engine: MCP,
        engineResolver: configEngineResolver(
          async () => ({
            reviewer: { command: [process.execPath, script], pass_env: ["PASS_ME"], timeout: 30 },
          }),
          () => ({
            PATH: process.env.PATH,
            HOME: dir,
            PASS_ME: "passed",
            SSH_AUTH_SOCK: "/tmp/agent.sock",
            KODEL_STATE_DIR: "/somewhere",
            SOMETHING_ELSE: "x",
          }),
        ),
        engineSessions: ({ rules, bootTimeoutMs }) =>
          new PipesSessionAdapter({
            base: state,
            root: dir,
            baseEnv: { SSH_AUTH_SOCK: "/tmp/agent.sock", KODEL_X: "1" },
            holder: { exec: process.execPath, args: [entry, "holder"] },
            intermediate: { exec: process.execPath, args: [entry] },
            rules,
            bootTimeoutMs,
          }),
      });
      const { run } = await h.start("env");
      await until(async () => (await run.state()).status === "completed", 20_000);
      const env = JSON.parse(await readFile(seen, "utf8")) as Record<string, string>;
      expect(env.PASS_ME).toBe("passed");
      expect(env.KODEL_ENGINE).toBe("1");
      expect(env.SSH_AUTH_SOCK).toBeUndefined();
      expect(env.SOMETHING_ELSE).toBeUndefined();
      expect(Object.keys(env).filter((k) => k.startsWith("KODEL_"))).toEqual(["KODEL_ENGINE"]);
    },
    30_000,
  );
});
