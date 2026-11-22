/**
 * `kodel serve` at the command line (TASK-G8KM, T-44): the refusals and their exit code, a clean stop,
 * `--status` (which writes nothing), the one launcher factory, a dead worker in `status` and `report`,
 * the test names of the serve files, the tool surface, and the real session adapter through a gate
 * with a script standing for `claude` (skipped where the process table cannot be read).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  acquireServeRecord,
  createServeDaemon,
  LocalPipelineHost,
  type LocalRun,
  openTaskService,
  ownProcessGroup,
  PipesSessionAdapter,
  SERVE_EXIT_REFUSED,
  servePlace,
  serveTasksOf,
} from "@kodel-ai/local";
import type { AgentDecider } from "@kodel-ai/pipeline-core/mcp";
import {
  buildTaskTools,
  decisionTools,
  HISTORY_TOOLS,
  SERVER_INSTRUCTIONS,
  serverInstructions,
  TASK_INSTRUCTIONS,
  TOOLS,
  toolsFor,
} from "@kodel-ai/pipeline-core/mcp";
import type { Exec } from "../src/claude-worker";
import { runCli } from "../src/cli";
import { printServeStatus } from "../src/serve-command";
import { loadSessions } from "../src/tui/load";
import { serveLauncherOf, serveWorkerOf } from "../src/worker-factory";
import { createSessionWorkerLauncher, execChild } from "../src/worker-launcher-session";
import { FakeLauncher } from "./fake-launcher";

const ONE = [
  "name: one",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write it",
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "  - slug: impl",
  "    kind: agent",
  "    prompt: implement it",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: impl }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

const groupReadable = ownProcessGroup() !== undefined;
const real = test.skipIf(
  process.platform === "win32" || (!groupReadable && process.env.KODEL_REQUIRE_PROCTABLE !== "1"),
);
const posix = test.skipIf(process.platform === "win32");

const TASKS = "tasks:\n  enabled: true\n  adapters:\n    local:\n      prefix: KDL\n";
const SERVE_ON = "serve:\n  enabled: true\n  start:\n    - pipeline: one\n";

let dir: string;
let stateDir: string;
const made: string[] = [];

function project(config: string) {
  dir = mkdtempSync(join(tmpdir(), "kodel-serve-cli-"));
  made.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  mkdirSync(join(dir, ".kodel", "pipelines"), { recursive: true });
  writeFileSync(join(dir, ".kodel", "pipelines", "one.yaml"), ONE);
  writeFileSync(join(dir, ".kodel", "config.yaml"), config);
  writeFileSync(join(dir, ".gitignore"), ".kodel/runs\n.kodel/worktrees\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "kodel-serve-state-"));
  made.push(stateDir);
  project(`worktree:\n  mode: off\n${TASKS}`);
});
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const storeRoot = () => join(dir, ".kodel");
const host = () => new LocalPipelineHost({ root: dir, heartbeatMs: 0, environment: {} });

async function cli(
  args: string[],
  over: {
    environment?: Record<string, string | undefined>;
    platform?: string;
    signal?: AbortSignal;
  } = {},
) {
  let out = "";
  let err = "";
  const code = await runCli(["--root", dir, ...args], {
    cwd: dir,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    interactive: false,
    environment: over.environment ?? { KODEL_STATE_DIR: stateDir, PATH: join(stateDir, "no-bin") },
    confirm: async () => true,
    select: async () => [],
    sessionLauncher: { exec: process.execPath, args: [join(import.meta.dir, "../src/main.ts")] },
    ...(over.platform === undefined ? {} : { platform: over.platform }),
    ...(over.signal === undefined ? {} : { serveSignal: over.signal }),
  });
  return { code, out, err };
}

async function seedTask(title: string): Promise<string> {
  const opened = await openTaskService({ storeRoot: storeRoot() });
  if (!opened) throw new Error("tasks are off");
  const made_ = await opened.service.create({ title });
  if (!made_.ok) throw new Error("could not seed the task");
  return (made_.task as { key: string }).key;
}

/** Every file under `root` with its size and time, so a test can say nothing was written. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) {
        // A directory too: a file made and removed again, or an empty folder made, changes it.
        out.push(`${relative(root, path)}/ ${statSync(path).mtimeMs}`);
        walk(path);
      } else {
        const info = statSync(path);
        out.push(`${relative(root, path)} ${info.size} ${info.mtimeMs}`);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

const recordFile = () => servePlace({ base: stateDir, root: dir }).file;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("t44 kodel serve refuses what a restart does not fix", () => {
  test("t44_serve_on_windows_starts_no_workers", async () => {
    const result = await cli(["serve"], { platform: "win32" });
    expect(result.code).toBe(SERVE_EXIT_REFUSED);
    expect(result.code).toBe(78);
    expect(result.err).toContain(
      "PLATFORM_UNSUPPORTED: agents are not supported on Windows yet; kodel serve starts no workers",
    );
    expect(result.out).toBe("");
    expect(existsSync(join(stateDir, "serve"))).toBe(false);
    const status = await cli(["serve", "--status"], { platform: "win32" });
    expect(status.code).toBe(0);
    expect(status.out).toContain("kodel serve: off (kodel serve does not run on Windows)");
    expect(status.out).toContain("starts no workers");
  });

  test("t44_serve_outside_a_project_refuses", async () => {
    const none = mkdtempSync(join(tmpdir(), "kodel-serve-none-"));
    made.push(none);
    let err = "";
    const code = await runCli(["serve"], {
      cwd: none,
      out: () => undefined,
      err: (t) => {
        err += t;
      },
      interactive: false,
      environment: { KODEL_STATE_DIR: stateDir, PATH: join(stateDir, "no-bin") },
      confirm: async () => true,
      select: async () => [],
    });
    expect(code).toBe(78);
    expect(err).toContain("no Kodel project here");
    expect(existsSync(join(stateDir, "serve"))).toBe(false);
  });

  test("t44_serve_refuses_from_an_engine_command", async () => {
    const engine = await cli(["serve"], {
      environment: { KODEL_STATE_DIR: stateDir, KODEL_ENGINE: "1" },
    });
    expect(engine.code).toBe(78);
    expect(engine.err).toContain(
      "it will not run from a command the engine runs (KODEL_ENGINE is set)",
    );
    expect(existsSync(join(stateDir, "serve"))).toBe(false);
    // Another daemon holds the record: its pid and start are named, and nothing is taken over.
    const held = await acquireServeRecord(servePlace({ base: stateDir, root: dir }), {
      now: Date.now(),
      build: "test",
    });
    try {
      const second = await cli(["serve"]);
      expect(second.code).toBe(78);
      expect(second.err).toContain(
        `kodel serve is already running for this project (pid ${process.pid}, since`,
      );
      expect(JSON.parse(readFileSync(recordFile(), "utf8")).build).toBe("test");
    } finally {
      await held.release();
    }
  });
});

describe("t44 kodel serve refuses a record it cannot write", () => {
  test("t44_serve_unwritable_state_base_refuses", async () => {
    // The state base is a file: the record cannot be made under it, and a restart would not change that.
    const file = join(stateDir, "a-file");
    writeFileSync(file, "");
    const result = await cli(["serve"], {
      environment: { KODEL_STATE_DIR: file, PATH: join(stateDir, "no-bin") },
    });
    expect(result.code).toBe(SERVE_EXIT_REFUSED);
    expect(result.err).toContain("kodel: the record of kodel serve cannot be written at");
    expect(result.err).toContain("check the state base (KODEL_STATE_DIR)");
    const relative = await cli(["serve"], {
      environment: { KODEL_STATE_DIR: "not/absolute", PATH: join(stateDir, "no-bin") },
    });
    expect(relative.code).toBe(SERVE_EXIT_REFUSED);
    expect(relative.err).toContain("KODEL_STATE_DIR must be an absolute path");
  });
});

describe("t44 kodel serve stops cleanly", () => {
  test("t44_serve_stops_cleanly", async () => {
    // In the process: an abort is a stop; the record is gone and the exit is 0.
    const controller = new AbortController();
    const running = cli(["serve"], { signal: controller.signal });
    for (let i = 0; i < 100 && !existsSync(recordFile()); i++) await wait(20);
    expect(existsSync(recordFile())).toBe(true);
    controller.abort();
    const result = await running;
    expect(result.code).toBe(0);
    expect(result.out).toContain(`root:       ${dir}`);
    expect(result.out).toContain(`state base: ${stateDir}`);
    expect(result.out).toContain("idle: serve.enabled is not true in the config");
    expect(result.out).toContain("the workers go on");
    expect(existsSync(recordFile())).toBe(false);
    // The config outside the serve block changes: 75, so a service manager starts it again.
    const again = new AbortController();
    const restarting = cli(["serve"], { signal: again.signal });
    for (let i = 0; i < 100 && !existsSync(recordFile()); i++) await wait(20);
    writeFileSync(join(storeRoot(), "config.yaml"), `worktree:\n  mode: auto\n${TASKS}`);
    const timer = setTimeout(() => again.abort(), 15_000);
    const restarted = await restarting;
    clearTimeout(timer);
    expect(restarted.code).toBe(75);
    expect(existsSync(recordFile())).toBe(false);
  }, 30_000);

  posix(
    "t44_serve_stops_cleanly_on_a_signal",
    async () => {
      const entry = join(import.meta.dir, "../../local/src/session-holder-entry.ts");
      const adapter = new PipesSessionAdapter({
        base: stateDir,
        root: dir,
        baseEnv: { PATH: process.env.PATH ?? "", HOME: stateDir },
        holder: { exec: process.execPath, args: [entry, "holder"] },
        intermediate: { exec: process.execPath, args: [entry] },
      });
      // A worker that runs while the daemon stops: it is not the daemon's child and goes on.
      const worker = await adapter.start({
        argv: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
        cwd: dir,
        name: "kw-r_0mw53d7fj_o2lc",
        origin: "cli",
        timeoutMs: 120_000,
        inheritEnv: true,
      });
      try {
        for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
          const child = spawnServe();
          const out = await until(child, (text) => text.includes("state base:"));
          expect(out).toContain(`root:       ${dir}`);
          for (let i = 0; i < 100 && !existsSync(recordFile()); i++) await wait(20);
          expect(existsSync(recordFile())).toBe(true);
          child.kill(signal);
          const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
          expect(code, signal).toBe(0);
          expect(existsSync(recordFile()), signal).toBe(false);
          expect((await adapter.status(worker.id)).state, signal).toBe("running");
        }
      } finally {
        await adapter.stop(worker.id).catch(() => undefined);
      }
    },
    60_000,
  );
});

function spawnServe(): ChildProcess {
  const main = join(import.meta.dir, "../src/main.ts");
  return spawn(process.execPath, [main, "--root", dir, "serve"], {
    cwd: dir,
    env: { ...process.env, KODEL_STATE_DIR: stateDir, KODEL_ENGINE: undefined },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function until(child: ChildProcess, done: (text: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`no output in time: ${text}`)), 20_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (done(text)) {
        clearTimeout(timer);
        resolve(text);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code}: ${text}`));
    });
  });
}

describe("t44 kodel serve --status", () => {
  test("t44_serve_status_acts_on_nothing", async () => {
    writeFileSync(join(storeRoot(), "config.yaml"), `worktree:\n  mode: auto\n${TASKS}${SERVE_ON}`);
    const orphanKey = await seedTask("A task with a run and no agent");
    await seedTask("A task the next cycle starts");
    const h = host();
    const orphan = await h.start({
      pipeline: "one",
      task: "A task with a run and no agent",
      restart: true,
      task_key: orphanKey,
      caller: { name: "kodel-tui", version: "0.0.0-test" },
    });
    const place = servePlace({ base: stateDir, root: dir });
    const record = await acquireServeRecord(place, { now: Date.now(), build: "test" });
    await record.writeCycle({ state: "active", cycle_at: Date.now() });
    try {
      const before = [...snapshot(dir), ...snapshot(stateDir)];
      const launcher = new FakeLauncher();
      let out = "";
      await printServeStatus({
        root: dir,
        dataDir: storeRoot(),
        host: h,
        launcher,
        place,
        version: "0.0.0-test",
        out: (t) => {
          out += t;
        },
      });
      expect(out).toContain(`kodel serve: active (pid ${process.pid}, since`);
      expect(out).toContain(`state base:  ${stateDir}`);
      expect(out).toContain("limits:      working 0 of 1, alive 0, runs with a worker 0 of 1");
      expect(out).toContain("rule 1:      pipeline one, approval required");
      // What the next cycle would do is not shown here (TASK-H9QP).
      expect(out).not.toContain("next cycle");
      expect(out).not.toContain(`start of ${orphanKey}`);
      expect(out).toContain(
        `no agent:    ${orphan.run.runId}: open run with a task and no agent; any agent continues it with pipeline_next_step`,
      );
      expect(launcher.starts).toEqual([]);
      expect(launcher.resumes).toEqual([]);
      expect([...snapshot(dir), ...snapshot(stateDir)]).toEqual(before);
      // Through the command, with no claude on PATH: it still says what runs and writes nothing.
      const shown = await cli(["serve", "--status"]);
      expect(shown.code).toBe(0);
      expect(shown.out).toContain(`kodel serve: active (pid ${process.pid}`);
      expect(shown.out).toContain(`no agent:    ${orphan.run.runId}`);
      expect(shown.out).toContain("starts:      blocked: claude was not found on PATH");
      expect([...snapshot(dir), ...snapshot(stateDir)]).toEqual(before);
    } finally {
      await record.release();
    }
    let off = "";
    await printServeStatus({
      root: dir,
      dataDir: storeRoot(),
      host: h,
      launcher: new FakeLauncher(),
      place,
      version: "0.0.0-test",
      out: (t) => {
        off += t;
      },
    });
    expect(off).toContain("kodel serve: off (no kodel serve runs for this project)");
  }, 30_000);
});

describe("t44 kodel serve --status when serve is off", () => {
  test("t44_serve_status_disabled_says_what_it_would_do", async () => {
    writeFileSync(
      join(storeRoot(), "config.yaml"),
      `worktree:\n  mode: auto\n${TASKS}serve:\n  enabled: false\n  start:\n    - pipeline: one\n    - pipeline: one\n      match:\n        priority: [high]\n        approval: any\n`,
    );
    const key = await seedTask("A task a daemon would start");
    let out = "";
    await printServeStatus({
      root: dir,
      dataDir: storeRoot(),
      host: host(),
      launcher: new FakeLauncher(),
      place: servePlace({ base: stateDir, root: dir }),
      version: "0.0.0-test",
      out: (t) => {
        out += t;
      },
    });
    expect(out).toContain("config:      serve.enabled is not true; a daemon would be idle");
    expect(out).toContain(`if enabled:  start of ${key}`);
    expect(out).not.toContain("waits:");
    expect(out).toContain(
      "rule 1:      pipeline one, approval required\nrule 2:      pipeline one, priority high, approval any\n",
    );
    expect(out).not.toContain("next cycle");
  });
});

describe("t44 one launcher", () => {
  test("t44_one_launcher_factory", async () => {
    const src = (name: string) => readFileSync(join(import.meta.dir, "../src", name), "utf8");
    const cli_ = src("cli.ts");
    expect(cli_).not.toContain("createSessionWorkerLauncher");
    const action = (command: string) => {
      const at = cli_.indexOf(`.command("${command}")`);
      const next = cli_.indexOf(".command(", at + 1);
      return cli_.slice(at, next < 0 ? undefined : next);
    };
    expect(action("tui")).toContain("await openWorkerLauncher()");
    expect(action("serve")).toContain("openWorkerLauncher");
    // The factory is the one place outside the session launcher itself that builds a launcher.
    const users = readdirSync(join(import.meta.dir, "../src"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => src(f).includes("createSessionWorkerLauncher("));
    expect(users.sort()).toEqual(["worker-factory.ts", "worker-launcher-session.ts"]);
    // The daemon's port is that launcher: the same starts, and the records with their last output.
    const launcher = new FakeLauncher();
    const port = serveLauncherOf(launcher);
    await port.start({ runId: "r_0mw53d7fj_o2lc", workdir: "/w", title: "t" });
    expect(launcher.starts).toEqual([{ runId: "r_0mw53d7fj_o2lc", workdir: "/w", title: "t" }]);
    const status = launcher.statusMap.get("r_0mw53d7fj_o2lc");
    if (!status) throw new Error("no status");
    launcher.statusMap.set("r_0mw53d7fj_o2lc", { ...status, lastOutputAt: 1_234 });
    expect((await port.statuses(["r_0mw53d7fj_o2lc"])).get("r_0mw53d7fj_o2lc")).toEqual(
      serveWorkerOf({ ...status, lastOutputAt: 1_234 }),
    );
    expect(serveWorkerOf({ ...status, lastOutputAt: 1_234 }).lastOutputAt).toBe(1_234);
    expect("lastOutputAt" in serveWorkerOf(status)).toBe(false);
  });
});

describe("t44 a dead worker in status and report", () => {
  test("t44_status_and_report_show_a_dead_worker", async () => {
    const key = await seedTask("Add a flag");
    const h = host();
    const started = await h.start({
      pipeline: "one",
      task: "Add a flag",
      restart: true,
      task_key: key,
      caller: { name: "kodel-serve", version: "0.0.0-test" },
    });
    const runId = started.run.runId;
    const run = (await h.open(runId)) as LocalRun;
    const at = new Date(2026, 10, 6, 10, 2).getTime();
    expect(
      await run.noteWorker({ worker: `kw-${runId}`, id: "a_0mw5abcde_x1y2", reason: "lost", at }),
    ).toEqual({ written: true });
    const status = await cli(["status", runId]);
    expect(status.code).toBe(0);
    expect(status.out).toContain(
      `worker:    agent kw-${runId} lost at 10:02 (its holder is gone); any agent continues the run with pipeline_next_step`,
    );
    const report = await cli(["report", runId]);
    expect(report.code).toBe(0);
    expect(report.out).toContain("background agents that kodel serve saw gone:");
    // local time, as status gives it
    expect(report.out).toContain(`2026-11-06 10:02  kw-${runId}  lost`);
    const json = await cli(["report", runId, "--json"]);
    expect(JSON.parse(json.out).workers_gone).toEqual([
      { at, worker: `kw-${runId}`, id: "a_0mw5abcde_x1y2", reason: "lost" },
    ]);
    // The TUI reads the same note into the session.
    const loaded = await loadSessions(h, Date.now());
    expect(loaded.sessions.find((s) => s.id === runId)?.workerGone).toEqual({
      worker: `kw-${runId}`,
      id: "a_0mw5abcde_x1y2",
      reason: "lost",
      at,
    });
  });
});

describe("t44 the decision id", () => {
  test("t44_test_names_carry_the_decision_id", () => {
    const repo = join(import.meta.dir, "../../..");
    // The decision id as docs/serve.md names it; the test names carry it in lower case, without the dash.
    const heading = readFileSync(join(repo, "docs/serve.md"), "utf8").match(
      /^## Decision (T-\d+)\s*$/m,
    );
    expect(heading?.[1]).toBeDefined();
    const prefix = (heading?.[1] ?? "").toLowerCase().replace("-", "");
    const files = [
      ...readdirSync(join(repo, "packages/pipeline-core/test"))
        .filter((f) => /^serve-.*\.test\.ts$/.test(f))
        .map((f) => join("packages/pipeline-core/test", f)),
      ...readdirSync(join(repo, "packages/local/test"))
        .filter((f) => /^serve-.*\.test\.ts$/.test(f))
        .map((f) => join("packages/local/test", f)),
      "packages/local/test/config-serve.test.ts",
      "packages/local/test/task-mark.test.ts",
      "packages/cli/test/serve.test.ts",
    ];
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const text = readFileSync(join(repo, file), "utf8");
      const aliases = [...text.matchAll(/const (\w+) = test\.skipIf\(/g)].map((m) => m[1]);
      const callee = ["test", ...aliases].join("|");
      const pattern = new RegExp(
        `\\b(?:${callee})(?:\\.(?:skipIf|if)\\((?:[^()]|\\([^()]*\\))*\\)|\\.only|\\.todo)?\\(\\s*(["'\`])((?:(?!\\1).)*)\\1`,
        "g",
      );
      const names = [...text.matchAll(pattern)].map((m) => m[2] ?? "");
      expect(names.length, file).toBeGreaterThan(0);
      for (const name of names) expect(name, file).toContain(prefix);
    }
  });
});

describe("t44 the tool surface", () => {
  test("t44_tool_surface_has_no_note_and_no_approve", () => {
    const decider: AgentDecider = {
      decideGate: async () => ({ ok: true }),
      acceptChange: async () => ({ ok: true }),
    };
    const tools = [
      ...TOOLS,
      ...toolsFor({ taskLink: true }),
      ...toolsFor({ taskLink: false }),
      ...HISTORY_TOOLS,
      ...decisionTools({ gate: true, pipelineChange: true }, decider),
      ...buildTaskTools({
        subtasks: true,
        runs: "full",
        comment: "append",
        fields: true,
        priority: true,
        types: true,
        provenance: true,
      }),
    ];
    expect(tools.length).toBeGreaterThan(10);
    const forbidden = /worker_note|noteWorker|note_worker/i;
    for (const tool of tools) {
      expect(tool.name, tool.name).not.toMatch(/approv/i);
      expect(tool.name, tool.name).not.toMatch(forbidden);
      expect(tool.description, tool.name).not.toMatch(forbidden);
      for (const [key, schema] of Object.entries(tool.shape)) {
        // The mark is set by the service from who calls, never from a tool's input.
        expect(key, tool.name).not.toMatch(/approv|created_by|agent_edited_at|note/i);
        expect(schema.description ?? "", `${tool.name}.${key}`).not.toMatch(forbidden);
        expect(JSON.stringify(schema._def) ?? "", `${tool.name}.${key}`).not.toMatch(forbidden);
      }
    }
    for (const text of [
      SERVER_INSTRUCTIONS,
      serverInstructions({ decisions: { gate: true, pipelineChange: true } }),
      TASK_INSTRUCTIONS,
    ]) {
      expect(text).not.toMatch(forbidden);
    }
  });
});

// ── the real adapter ─────────────────────────────────────────────────────────

/**
 * A `claude` on PATH that does what a worker does, without a model: it opens the run named in its
 * prompt through a host of this source and completes each agent step until the run waits for a
 * person or is done, then prints its session as stream-json. The worker's environment has no
 * `KODEL_*`, so the script is given the state places the test process uses.
 */
function drivingClaude(base: string, root: string, hang = false): string {
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(base, "claude.ts");
  const local = join(import.meta.dir, "../../local/src/index.ts");
  const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  writeFileSync(
    script,
    [
      `process.env.XDG_STATE_HOME = ${JSON.stringify(xdg)};`,
      process.env.KODEL_STATE_DIR === undefined
        ? "delete process.env.KODEL_STATE_DIR;"
        : `process.env.KODEL_STATE_DIR = ${JSON.stringify(process.env.KODEL_STATE_DIR)};`,
      `const { LocalPipelineHost } = await import(${JSON.stringify(local)});`,
      "const argv = process.argv.slice(2);",
      "if (argv[0] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: true }) + '\\n'); process.exit(0); }",
      "const valueOf = (flag) => { const at = argv.indexOf(flag); return at < 0 ? undefined : argv[at + 1]; };",
      "const id = valueOf('--session-id') ?? valueOf('--resume') ?? 'none';",
      "const runId = /r_[0-9a-z]{9}_[0-9a-z]{4}/.exec(argv.join(' '))?.[0];",
      "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, tools: [] }) + '\\n');",
      // A hanging worker keeps running until a test kills it.
      hang ? "setInterval(() => {}, 60_000); await new Promise(() => {});" : "",
      `const host = new LocalPipelineHost({ root: ${JSON.stringify(root)}, heartbeatMs: 0 });`,
      "const run = await host.open(runId);",
      "for (let i = 0; i < 20; i++) {",
      "  const next = await run.nextStep();",
      "  if (!('node' in next)) break;",
      "  await run.completeStep(next.node.slug, next.node.attempt, 'done by the script');",
      "}",
      "process.stdout.write(JSON.stringify({ type: 'result', session_id: id, num_turns: 1 }) + '\\n');",
      "",
    ].join("\n"),
  );
  const claude = join(bin, "claude");
  writeFileSync(
    claude,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
  );
  chmodSync(claude, 0o755);
  return bin;
}

/** The daemon over the real session adapter, the real launcher and a script standing for `claude`. */
async function realWorld(hang = false) {
  writeFileSync(join(storeRoot(), "config.yaml"), `worktree:\n  mode: auto\n${TASKS}${SERVE_ON}`);
  execFileSync("git", ["commit", "-qam", "serve on"], { cwd: dir, stdio: "ignore" });
  await seedTask("Add a flag");
  const base = mkdtempSync(join(tmpdir(), "kodel-serve-real-"));
  made.push(base);
  const bin = drivingClaude(base, dir, hang);
  const environment: Record<string, string | undefined> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME,
    KODEL_STATE_DIR: stateDir,
  };
  const entry = join(import.meta.dir, "../../local/src/session-holder-entry.ts");
  const main = join(import.meta.dir, "../src/main.ts");
  const adapter = new PipesSessionAdapter({
    base: stateDir,
    root: dir,
    baseEnv: environment,
    holder: { exec: process.execPath, args: [entry, "holder"] },
    intermediate: { exec: process.execPath, args: [entry] },
  });
  // `claude auth status` is asked of the script, not of a claude on this machine.
  const exec: Exec = (file, args, options) =>
    execChild(file === "claude" ? join(bin, "claude") : file, args, options);
  const launcher = createSessionWorkerLauncher({
    adapter,
    self: { exec: process.execPath, args: [main] },
    root: dir,
    stateBase: stateDir,
    environment,
    rules: [],
    servedTools: TOOLS.map((t) => t.name),
    which: async () => join(bin, "claude"),
    exec,
    platform: process.platform,
    clock: Date.now,
    uuid: () => "7f3b2a9c-1d4e-4f6a-9b8c-0d1e2f3a4b5c",
  });
  const opened = await openTaskService({ storeRoot: storeRoot() });
  if (!opened) throw new Error("tasks are off");
  const h = host();
  const lines: string[] = [];
  const daemon = createServeDaemon({
    root: dir,
    storeRoot: storeRoot(),
    host: h,
    launcher: serveLauncherOf(launcher),
    tasks: serveTasksOf(opened.service),
    log: (line) => lines.push(line),
    version: "0.0.0-test",
  });
  return { adapter, daemon, h, lines };
}

describe("t44 the real session adapter", () => {
  real(
    "t44_serve_real_adapter_through_a_gate",
    async () => {
      const { adapter, daemon, h, lines } = await realWorld();
      const settle = async (name: string) => {
        for (let i = 0; i < 200; i++) {
          const found = (await adapter.list({ name }))[0];
          if (found !== undefined) {
            await adapter.wait(found.id, { timeoutMs: 30_000 });
            return found.id;
          }
          await wait(50);
        }
        throw new Error(`no record ${name}: ${lines.join("\n")}`);
      };
      expect(await daemon.cycle()).toEqual({ kind: "active" });
      const runId = (await h.runSummaries())[0]?.meta.runId ?? "";
      expect(runId).not.toBe("");
      await settle(`kw-${runId}`);
      const run = (await h.open(runId)) as LocalRun;
      expect(await run.inspect()).toMatchObject({ waiting: { node_slug: "approve" } });
      // The person approves (`kodel gate approved`); the next cycle resumes the worker after it.
      await run.decideHuman("approve", "approved");
      await run.waitForRest(5_000);
      expect(await daemon.cycle()).toEqual({ kind: "active" });
      const seq = (await run.journal()).findLast((r) => r.event === "gate_decided")?.seq;
      await settle(`kw-${runId}-d${seq}`);
      expect((await run.state()).status, lines.join("\n")).toBe("completed");
      // Once per decision: a later cycle resumes nothing more.
      expect(await daemon.cycle()).toEqual({ kind: "active" });
      expect((await adapter.list()).map((r) => r.name).sort()).toEqual([
        `kw-${runId}`,
        `kw-${runId}-d${seq}`,
      ]);
      const journal = await run.journal();
      expect(journal.some((r) => r.event === "worker_note")).toBe(false);
    },
    120_000,
  );

  real(
    "t44_serve_real_adapter_notes_a_killed_holder",
    async () => {
      const { adapter, daemon, h, lines } = await realWorld(true);
      expect(await daemon.cycle()).toEqual({ kind: "active" });
      const runId = (await h.runSummaries())[0]?.meta.runId ?? "";
      expect(runId).not.toBe("");
      let pids: { holder: number; child: number } | undefined;
      let id = "";
      for (let i = 0; i < 200 && pids === undefined; i++) {
        id = (await adapter.list({ name: `kw-${runId}` }))[0]?.id ?? "";
        const file = join(adapter.place.dir, id, "status.json");
        if (id !== "" && existsSync(file)) {
          const status = JSON.parse(readFileSync(file, "utf8"));
          if (status.state === "running" && status.child?.pid !== undefined) {
            pids = { holder: status.holder.pid, child: status.child.pid };
          }
        }
        if (pids === undefined) await wait(50);
      }
      if (pids === undefined) throw new Error(`no running worker: ${lines.join("\n")}`);
      const { holder, child } = pids;
      try {
        process.kill(holder, "SIGKILL");
        for (let i = 0; i < 100; i++) {
          if ((await adapter.status(id)).state === "lost") break;
          await wait(50);
        }
        // The cycle reads the records through `kodel agent ls --json`, as a person's daemon does.
        expect(await daemon.cycle()).toEqual({ kind: "active" });
        const run = (await h.open(runId)) as LocalRun;
        const notes = (await run.journal()).filter((r) => r.event === "worker_note");
        expect(notes, lines.join("\n")).toHaveLength(1);
        expect(notes[0]).toMatchObject({ worker: `kw-${runId}`, id, reason: "lost" });
        expect(lines.some((l) => l.startsWith(`noted: run ${runId}`))).toBe(true);
      } finally {
        // The holder's child leads its own process group; it outlives the holder and is stopped here.
        try {
          process.kill(-child, "SIGKILL");
        } catch {
          // already gone
        }
      }
    },
    120_000,
  );
});

describe("t44 kodel serve --status with workers that stay alive at a wait (T-45)", () => {
  const LIMITS =
    "serve:\n  enabled: true\n  max_workers: 1\n  max_runs: 3\n  start:\n    - pipeline: one\n";

  /** Two runs with a worker in a terminal each: the first waits at its gate, the second has a step open. */
  async function twoRuns() {
    writeFileSync(join(storeRoot(), "config.yaml"), `worktree:\n  mode: auto\n${TASKS}${LIMITS}`);
    const h = host();
    const launcher = new FakeLauncher();
    const started: string[] = [];
    for (const title of ["Waits at its gate", "Has a step open"]) {
      const key = await seedTask(title);
      const made = await h.start({
        pipeline: "one",
        task: title,
        restart: true,
        task_key: key,
        caller: { name: "kodel-tui", version: "0.0.0-test" },
      });
      await launcher.start({ runId: made.run.runId, workdir: dir, title });
      const status = launcher.statusMap.get(made.run.runId);
      if (status === undefined) throw new Error("no worker");
      launcher.statusMap.set(made.run.runId, { ...status, terminal: true });
      started.push(made.run.runId);
    }
    const [waiting, working] = started as [string, string];
    const run = (await h.open(waiting)) as LocalRun;
    await run.completeStep("write", 1);
    await run.waitForRest(10_000);
    return { h, launcher, waiting, working };
  }

  const status = async (
    h: LocalPipelineHost,
    launcher: FakeLauncher,
    now: number,
  ): Promise<string> => {
    let out = "";
    await printServeStatus({
      root: dir,
      dataDir: storeRoot(),
      host: h,
      launcher,
      place: servePlace({ base: stateDir, root: dir }),
      version: "0.0.0-test",
      now,
      out: (t) => {
        out += t;
      },
    });
    return out;
  };

  test("t44_status_names_working_and_alive", async () => {
    const { h, launcher } = await twoRuns();
    const before = [...snapshot(dir), ...snapshot(stateDir)];
    // The worker at its gate is alive and holds no worker place; both runs hold a run place.
    const out = await status(h, launcher, launcher.started + 60_000);
    expect(out).toContain("limits:      working 1 of 1, alive 2, runs with a worker 2 of 3");
    expect(out).not.toContain("stalled:");
    // It reads and writes nothing, and acts on nothing.
    expect([...snapshot(dir), ...snapshot(stateDir)]).toEqual(before);
    expect(launcher.finished).toEqual([]);
    expect(launcher.resumes).toEqual([]);
    // The record a daemon writes names both, and `workers` stays what stands beside `max_workers`.
    const place = servePlace({ base: stateDir, root: dir });
    const record = await acquireServeRecord(place, { now: Date.now(), build: "test" });
    try {
      await record.writeCycle({
        state: "active",
        cycle_at: Date.now(),
        counts: { workers: 1, alive: 2, max_workers: 1, runs: 2, max_runs: 3 },
      });
      const stored = JSON.parse(readFileSync(place.file, "utf8")) as { counts: unknown };
      expect(stored.counts).toEqual({ workers: 1, alive: 2, max_workers: 1, runs: 2, max_runs: 3 });
    } finally {
      await record.release();
    }
  });

  test("t44_status_lists_stalled_workers", async () => {
    const { h, launcher, waiting, working } = await twoRuns();
    // Hours later neither printed anything nor called the engine. No daemon runs: the quiet time is
    // the worker's own. The one with a step open is stalled, and the line says what it holds; the
    // one that waits with the person is not.
    const later = launcher.started + 2 * 3_600_000;
    const out = await status(h, launcher, later);
    expect(out).toContain(
      `stalled:     kw-${working} (run ${working}): quiet for 7200 s; it holds a worker place and a run place; nothing stops it but you: kodel agent attach kw-${working}, or kodel agent stop kw-${working}`,
    );
    expect(out).not.toContain(`stalled:     kw-${waiting}`);
    expect(out).toContain("limits:      working 1 of 1, alive 2, runs with a worker 2 of 3");
    // A daemon that started a moment ago has not watched it for that long: nothing is listed yet.
    const place = servePlace({ base: stateDir, root: dir });
    const record = await acquireServeRecord(place, { now: later - 5_000, build: "test" });
    try {
      await record.writeCycle({ state: "active", cycle_at: later });
      expect(await status(h, launcher, later)).not.toContain("stalled:");
    } finally {
      await record.release();
    }
    // Output puts it off.
    const printing = launcher.statusMap.get(working);
    if (printing === undefined) throw new Error("no worker");
    launcher.statusMap.set(working, { ...printing, lastOutputAt: later - 60_000 });
    expect(await status(h, launcher, later)).not.toContain("stalled:");
  });
});
