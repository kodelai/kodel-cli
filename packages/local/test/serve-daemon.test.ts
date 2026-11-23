/**
 * `kodel serve` on a real host and tracker, with a fake clock and a launcher without processes
 * (TASK-G8KM, T-44). Process liveness is injected where a test needs a holder alive or gone; the tests
 * that use real processes are POSIX only.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type JournalRecord,
  KodelError,
  type RedactRule,
  type RunState,
  type Task,
  type TaskService,
} from "@kodel-ai/pipeline-core";
import type { ServeWorkerView } from "@kodel-ai/pipeline-core/serve";
import { ScriptedLauncher, type ScriptedRecord } from "../../testkit/src/scripted-launcher";
import {
  createServeDaemon,
  FileStore,
  LocalPipelineHost,
  openTaskService,
  processIdentity,
  type RunSummary,
  type ServeDaemonDeps,
  type ServeHostPort,
  ServeRecordRefused,
  type ServeTasksPort,
  serveTasksOf,
} from "../src";

const GATED = [
  "name: gated",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: do it",
  "  - slug: review",
  "    kind: human",
  "    prompt: look at it",
  "  - slug: ship",
  "    kind: agent",
  "    prompt: ship it",
  "edges:",
  "  - { from: write, to: review }",
  "  - { from: review, to: ship }",
  "  - { from: review, to: write, when: rejected }",
  "",
].join("\n");

const CHILD = join(import.meta.dir, "helpers", "serve-start-child.ts");
const T0 = Date.UTC(2026, 10, 21, 9);
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

let tmp: string;
let dir: string;
let t: number;
const storeRoot = () => join(dir, ".kodel");
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

interface Setup {
  serve?: string[];
  config?: string[];
}

function configText(setup: Setup): string {
  const serve = setup.serve ?? ["serve:", "  enabled: true", "  start:", "    - pipeline: gated"];
  return `${["tasks:", "  enabled: true", ...serve, ...(setup.config ?? [])].join("\n")}\n`;
}

async function project(setup: Setup = {}): Promise<void> {
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await mkdir(join(storeRoot(), "pipelines"), { recursive: true });
  await writeFile(join(storeRoot(), "pipelines", "gated.yaml"), GATED);
  await writeFile(join(storeRoot(), "config.yaml"), configText(setup));
  await writeFile(join(dir, ".gitignore"), ".kodel/worktrees/\n.kodel/runs/\n.kodel/tasks/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
}

const writeConfig = (setup: Setup) =>
  writeFile(join(storeRoot(), "config.yaml"), configText(setup));

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kodel-serve-"));
  dir = join(tmp, "repo");
  await mkdir(dir);
  t = T0;
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const tick = (ms = 5_000) => {
  t += ms;
};

function newHost(extra: Partial<ConstructorParameters<typeof LocalPipelineHost>[0]> = {}) {
  return new LocalPipelineHost({
    root: dir,
    heartbeatMs: 0,
    clock: () => t,
    integrityDir: join(tmp, "integrity"),
    ...extra,
  });
}

async function openTasks(): Promise<TaskService> {
  const opened = await openTaskService({ storeRoot: storeRoot(), clock: () => t });
  if (!opened) throw new Error("tasks are off");
  return opened.service;
}

interface World {
  host: LocalPipelineHost;
  service: TaskService;
  launcher: ScriptedLauncher;
  lines: string[];
  daemon: ReturnType<typeof createServeDaemon>;
  make: (title: string, more?: { priority?: string }) => Promise<string>;
  task: (key: string) => Promise<Task>;
  runOf: (key: string) => Promise<string>;
  journal: (runId: string) => Promise<JournalRecord[]>;
  state: (runId: string) => Promise<RunState>;
  approve: (runId: string, reason?: string) => Promise<void>;
  newDaemon: (more?: Partial<ServeDaemonDeps>) => ReturnType<typeof createServeDaemon>;
}

async function world(
  options: {
    launcher?: ScriptedLauncher;
    host?: LocalPipelineHost;
    deps?: Partial<ServeDaemonDeps>;
  } = {},
): Promise<World> {
  const host = options.host ?? newHost();
  const service = await openTasks();
  const launcher = options.launcher ?? new ScriptedLauncher({ host, now: () => t });
  const lines: string[] = [];
  const newDaemon = (more: Partial<ServeDaemonDeps> = {}) =>
    createServeDaemon({
      root: dir,
      storeRoot: storeRoot(),
      host,
      launcher,
      tasks: serveTasksOf(service),
      log: (line) => lines.push(line),
      version: "0.0.0-test",
      now: () => t,
      ...options.deps,
      ...more,
    });
  const task = async (key: string) => {
    const got = await service.get({ key });
    if (!got.ok) throw new Error(JSON.stringify(got));
    return got.task as Task;
  };
  return {
    host,
    service,
    launcher,
    lines,
    daemon: newDaemon(),
    newDaemon,
    make: async (title, more = {}) => {
      const made = await service.create({ title, ...more });
      if (!made.ok) throw new Error(JSON.stringify(made));
      return (made.task as Task).key;
    },
    task,
    runOf: async (key) => {
      const runs = (await task(key)).runs;
      const last = runs[runs.length - 1];
      if (last === undefined) throw new Error(`${key} has no run: ${lines.join(" | ")}`);
      return last;
    },
    journal: async (runId) => {
      const run = await host.open(runId);
      if (!run) throw new Error(`no run ${runId}`);
      return run.journal();
    },
    state: async (runId) => {
      const run = await host.open(runId);
      if (!run) throw new Error(`no run ${runId}`);
      return run.state();
    },
    approve: async (runId, reason) => {
      const run = await host.open(runId);
      const decided = await run?.decideHuman("review", "approved", reason);
      expect(decided?.ok).toBe(true);
    },
  };
}

/** A launcher whose records cannot be read once, right after a launch that failed. */
class StatusesFailOnce extends ScriptedLauncher {
  failNextStatusesAfterStart = false;
  private armed = false;
  override async start(input: { runId: string; workdir: string; title: string }) {
    this.armed = this.failNextStatusesAfterStart;
    return super.start(input);
  }
  override async statuses(runIds: readonly string[]): Promise<Map<string, ServeWorkerView>> {
    if (this.armed) {
      this.armed = false;
      this.failNextStatusesAfterStart = false;
      throw new Error("kodel agent ls failed");
    }
    return super.statuses(runIds);
  }
}

const starts = (launcher: ScriptedLauncher) => launcher.calls.filter((c) => c.kind === "start");
const resumes = (launcher: ScriptedLauncher) => launcher.calls.filter((c) => c.kind === "resume");
const notesOf = (journal: JournalRecord[]) => journal.filter((r) => r.event === "worker_note");
const atGate = async (w: World, runId: string) => {
  const run = await w.host.open(runId);
  const next = await run?.inspect();
  return next !== undefined && "waiting" in next;
};

/** A launcher that runs `hook` once, right after the plan read the records. */
class HookedLauncher extends ScriptedLauncher {
  hook: (() => Promise<void>) | undefined;
  override async statuses(runIds: readonly string[]): Promise<Map<string, ServeWorkerView>> {
    const out = await super.statuses(runIds);
    const hook = this.hook;
    this.hook = undefined;
    if (hook) {
      await hook();
      return out;
    }
    return out;
  }
}

describe("kodel serve on the local host (T-44)", () => {
  test("t44_task_runs_through_a_gate_with_no_tui", async () => {
    await project();
    const w = await world();
    const key = await w.make("Task A");
    expect(await w.daemon.cycle()).toEqual({ kind: "active" });
    const runId = await w.runOf(key);
    expect(starts(w.launcher)).toHaveLength(1);
    expect(await atGate(w, runId)).toBe(true);
    expect((await w.task(key)).state).toBe("progress");
    // Waiting for the person: nothing happens.
    tick();
    await w.daemon.cycle();
    expect(resumes(w.launcher)).toHaveLength(0);
    await w.approve(runId);
    // The first cycle after the decision resumes it.
    tick();
    await w.daemon.cycle();
    expect(resumes(w.launcher)).toHaveLength(1);
    expect(w.launcher.of(runId).map((r) => r.name)).toEqual([
      `kw-${runId}`,
      expect.stringMatching(new RegExp(`^kw-${runId}-d\\d+$`)),
    ]);
    expect((await w.state(runId)).status).toBe("completed");
    tick();
    await w.daemon.cycle();
    expect(resumes(w.launcher)).toHaveLength(1);
    expect(starts(w.launcher)).toHaveLength(1);
    expect(w.lines.some((l) => l.startsWith("started:"))).toBe(true);
    expect(w.lines.some((l) => l.startsWith("resumed:"))).toBe(true);
  });

  test("t44_limit_one_second_task_waits", async () => {
    await project();
    const w = await world();
    const a = await w.make("Task A", { priority: "high" });
    const b = await w.make("Task B", { priority: "normal" });
    await w.daemon.cycle();
    const runA = await w.runOf(a);
    expect(starts(w.launcher)).toHaveLength(1);
    // The first waits at its gate: its run still holds the one place.
    tick();
    await w.daemon.cycle();
    expect(starts(w.launcher)).toHaveLength(1);
    expect((await w.task(b)).state).toBe("todo");
    expect(w.lines.filter((l) => l.startsWith("queued:"))).toHaveLength(1);
    await w.approve(runA);
    tick();
    await w.daemon.cycle();
    expect((await w.state(runA)).status).toBe("completed");
    expect(starts(w.launcher)).toHaveLength(1);
    tick();
    await w.daemon.cycle();
    expect(starts(w.launcher)).toHaveLength(2);
    expect((await w.task(b)).state).toBe("progress");
  });

  test("t44_resume_waits_for_a_worker_place", async () => {
    await project({
      serve: ["serve:", "  enabled: true", "  max_runs: 2", "  start:", "    - pipeline: gated"],
    });
    const w = await world();
    const a = await w.make("Task A", { priority: "high" });
    const b = await w.make("Task B", { priority: "normal" });
    w.launcher.next.push("drive", "silent");
    await w.daemon.cycle();
    expect(starts(w.launcher)).toHaveLength(1);
    // A reached its gate and its worker left: B starts in the next cycle.
    tick();
    await w.daemon.cycle();
    const runA = await w.runOf(a);
    const runB = await w.runOf(b);
    expect(starts(w.launcher)).toHaveLength(2);
    await w.approve(runA);
    tick();
    await w.daemon.cycle();
    // B's worker holds the one worker place: A's resume waits.
    expect(resumes(w.launcher)).toHaveLength(0);
    await w.launcher.wake(runB);
    tick();
    await w.daemon.cycle();
    expect(resumes(w.launcher)).toHaveLength(1);
    expect(resumes(w.launcher)[0]?.runId).toBe(runA);
  });

  test("t44_existing_run_is_not_given_a_worker", async () => {
    await project();
    const w = await world();
    const key = await w.make("Task A");
    // An agent started a run for the same text without the task's key.
    const other = await w.host.start({ pipeline: "gated", task: "Task A", restart: false });
    await w.daemon.cycle();
    expect(starts(w.launcher)).toHaveLength(0);
    expect(w.daemon.memory().attempts).toEqual({});
    expect(notesOf(await w.journal(other.run.runId))).toHaveLength(0);
    expect(w.lines.some((l) => l.includes(`run ${other.run.runId} existed already`))).toBe(true);
    expect((await w.task(key)).state).toBe("todo");
    // Said once per task, not every cycle.
    tick();
    await w.daemon.cycle();
    tick();
    await w.daemon.cycle();
    expect(w.lines.filter((l) => l.startsWith(`not started: ${key}:`))).toHaveLength(1);
  });

  test("t44_failed_launch_is_noted_not_retried", async () => {
    await project();
    const w = await world();
    const key = await w.make("Task A");
    w.launcher.next.push("failing");
    await w.daemon.cycle();
    const runId = await w.runOf(key);
    const notes = notesOf(await w.journal(runId));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ worker: `kw-${runId}`, reason: "not_started" });
    // The places are free and the task is not started again.
    const status = await w.daemon.plan();
    expect(status.config === "ok" && status.plan.counts).toMatchObject({ workers: 0, runs: [] });
    tick(61_000);
    await w.daemon.cycle();
    expect(starts(w.launcher)).toHaveLength(1);
    expect(status.config === "ok" && status.plan.orphans).toEqual([runId]);
    // It counts once as a worker that ended outside a wait (Decision 3a).
    expect(w.daemon.memory().dead_in_a_row).toBe(1);
    tick();
    await w.daemon.cycle();
    expect(w.daemon.memory().dead_in_a_row).toBe(1);
    expect(w.daemon.memory().unlaunched).toEqual([]);
  });

  test("t44_failed_launch_note_is_tried_again", async () => {
    await project();
    const w = await world();
    let failNote = true;
    const open = w.host.open.bind(w.host);
    const wrapped = new WeakSet<object>();
    w.host.open = async (runId) => {
      const run = await open(runId);
      if (run !== undefined && !wrapped.has(run)) {
        wrapped.add(run);
        const write = run.noteWorker.bind(run);
        run.noteWorker = async (input) => {
          if (failNote) throw new Error("disk full");
          return write(input);
        };
      }
      return run;
    };
    const key = await w.make("Task A");
    w.launcher.next.push("failing");
    await w.daemon.cycle();
    const runId = await w.runOf(key);
    expect(notesOf(await w.journal(runId))).toHaveLength(0);
    expect(w.lines.filter((l) => l.startsWith(`not noted yet: run ${runId}`))).toHaveLength(1);
    expect(w.lines.some((l) => l.includes("worker records cannot be read"))).toBe(false);
    tick();
    await w.daemon.cycle();
    expect(w.lines.filter((l) => l.startsWith(`not noted yet: run ${runId}`))).toHaveLength(1);
    failNote = false;
    tick();
    await w.daemon.cycle();
    const notes = notesOf(await w.journal(runId));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ worker: `kw-${runId}`, reason: "not_started" });
    tick();
    await w.daemon.cycle();
    expect(notesOf(await w.journal(runId))).toHaveLength(1);
    expect(w.daemon.memory().dead_in_a_row).toBe(1);
    expect(w.daemon.memory().unlaunched).toEqual([]);
  });

  test("t44_launch_that_spawned_is_not_noted", async () => {
    await project();
    const w = await world();
    const key = await w.make("Task A");
    w.launcher.next.push("throws_after_record");
    await w.daemon.cycle();
    const runId = await w.runOf(key);
    expect(w.launcher.of(runId)).toHaveLength(1);
    expect(notesOf(await w.journal(runId))).toHaveLength(0);
  });

  for (const [behaviour, noted] of [
    ["failing", true],
    ["throws_after_record", false],
  ] as const) {
    test(`t44_failed_launch_with_unread_records_is_checked_again_${behaviour}`, async () => {
      await project();
      const host = newHost();
      const launcher = new StatusesFailOnce({ host, now: () => t });
      const w = await world({ launcher, host });
      const key = await w.make("Task A");
      launcher.next.push(behaviour);
      launcher.failNextStatusesAfterStart = true;
      await w.daemon.cycle();
      const runId = await w.runOf(key);
      expect(launcher.failNextStatusesAfterStart).toBe(false);
      expect(notesOf(await w.journal(runId))).toHaveLength(0);
      expect(w.daemon.memory().unlaunched.map((u) => u.runId)).toEqual([runId]);
      tick();
      await w.daemon.cycle();
      const notes = notesOf(await w.journal(runId));
      if (noted) {
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({ worker: `kw-${runId}`, reason: "not_started" });
        expect(w.daemon.memory().dead_in_a_row).toBe(1);
      } else {
        expect(notes).toHaveLength(0);
        expect(w.daemon.memory().dead_in_a_row).toBe(0);
      }
      tick();
      await w.daemon.cycle();
      expect(notesOf(await w.journal(runId))).toHaveLength(noted ? 1 : 0);
      expect(w.daemon.memory().unlaunched).toEqual([]);
      expect(starts(launcher)).toHaveLength(1);
    });
  }

  test("t44_rm_after_start_launches_nothing", async () => {
    await project();
    const w = await world();
    const a = await w.make("Task A");
    await w.daemon.cycle();
    const runA = await w.runOf(a);
    w.launcher.remove(runA);
    await w.approve(runA);
    tick();
    await w.daemon.cycle();
    await w.newDaemon().cycle();
    expect(resumes(w.launcher)).toHaveLength(0);
    expect(notesOf(await w.journal(runA))).toHaveLength(0);
    // A worker a person stopped and whose record they removed: the same.
    const b = await w.make("Task B");
    w.launcher.next.push("silent");
    tick();
    await w.daemon.cycle();
    const runB = await w.runOf(b);
    w.launcher.stop(runB);
    tick();
    await w.daemon.cycle();
    w.launcher.remove(runB);
    tick();
    await w.daemon.cycle();
    await w.newDaemon().cycle();
    expect(notesOf(await w.journal(runB))).toHaveLength(0);
    expect(w.launcher.calls.filter((c) => c.runId === runB && c.kind !== "statuses")).toHaveLength(
      1,
    );
  });

  test("t44_note_worker_binds_the_name_to_the_run", async () => {
    await project();
    const host = newHost();
    const started = await host.start({ pipeline: "gated", task: "something", restart: false });
    const run = await host.open(started.run.runId);
    if (!run) throw new Error("no run");
    const runId = run.runId;
    for (const worker of [
      "kw-r_0mvxulus6_0m28",
      `kw-${runId}-d0`,
      `kw-${runId}-dx`,
      runId,
      `kw-${runId}x`,
    ]) {
      const error = await run
        .noteWorker({ worker, id: "a_1", reason: "lost" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(KodelError);
      expect((error as KodelError).code).toBe("INVALID_ARGUMENTS");
    }
    expect(await run.noteWorker({ worker: `kw-${runId}`, id: "a_1", reason: "lost" })).toEqual({
      written: true,
    });
    expect(await run.noteWorker({ worker: `kw-${runId}`, id: "a_1", reason: "exited" })).toEqual({
      written: false,
    });
    expect(
      await run.noteWorker({
        worker: `kw-${runId}-d7`,
        id: "a_2",
        reason: "killed",
        exit_code: 137,
      }),
    ).toEqual({ written: true });
    const notes = notesOf(await run.journal());
    expect(notes.map((n) => [n.worker, n.id, n.reason])).toEqual([
      [`kw-${runId}`, "a_1", "lost"],
      [`kw-${runId}-d7`, "a_2", "killed"],
    ]);
  });

  test("t44_dead_holder_noted_within_one_cycle", async () => {
    await project();
    const w = await world();
    const key = await w.make("Task A");
    w.launcher.next.push("silent");
    await w.daemon.cycle();
    const runId = await w.runOf(key);
    w.launcher.lose(runId);
    tick();
    await w.daemon.cycle();
    const notes = notesOf(await w.journal(runId));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      worker: `kw-${runId}`,
      id: w.launcher.of(runId)[0]?.id,
      reason: "lost",
    });
  });

  test("t44_dropped_note_is_logged_once", async () => {
    await project();
    const w = await world();
    const key = await w.make("Task A");
    w.launcher.next.push("silent");
    await w.daemon.cycle();
    const runId = await w.runOf(key);
    w.launcher.lose(runId);
    // A record whose time is ahead of the run's clock: the engine does not take the note.
    const record = w.launcher.of(runId)[0] as ScriptedRecord;
    record.since = t + 3_600_000;
    for (let i = 0; i < 3; i++) {
      tick();
      await w.daemon.cycle();
    }
    expect(notesOf(await w.journal(runId))).toEqual([]);
    expect(w.lines.filter((l) => l.startsWith(`not noted: run ${runId}`))).toHaveLength(1);
    expect(w.lines.filter((l) => l.startsWith("noted:"))).toEqual([]);
  });

  test("t44_restart_does_not_repeat_notes", async () => {
    await project();
    const w = await world();
    const key = await w.make("Task A");
    w.launcher.next.push("silent");
    await w.daemon.cycle();
    const runId = await w.runOf(key);
    w.launcher.lose(runId);
    tick();
    await w.daemon.cycle();
    tick();
    await w.daemon.cycle();
    const again = w.newDaemon();
    tick();
    await again.cycle();
    expect(notesOf(await w.journal(runId))).toHaveLength(1);
    expect(w.lines.filter((l) => l.startsWith("noted:"))).toHaveLength(1);
  });

  test("t44_format_1_dead_worker_is_logged_once", async () => {
    await project({ serve: ["serve:", "  enabled: true"] });
    const GATE = "r_0mvxulus6_0m28";
    const runDir = join(storeRoot(), "runs", GATE);
    await cp(
      join(import.meta.dir, "..", "..", "..", "fixtures", "formats", "v1-open", GATE),
      runDir,
      {
        recursive: true,
      },
    );
    for (const file of ["state.json", "meta.json"]) {
      const path = join(runDir, file);
      const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (file === "state.json" || typeof value.workdir === "string") {
        await writeFile(path, `${JSON.stringify({ ...value, workdir: dir }, null, 2)}\n`);
      }
    }
    const w = await world();
    const before = (await w.journal(GATE)).length;
    const lost: ScriptedRecord = {
      id: "a_000000001_lost",
      name: `kw-${GATE}`,
      runId: GATE,
      state: "lost",
      started: T0 - 60_000,
      since: T0 - 30_000,
      sessionId: "s",
    };
    w.launcher.records.push(lost);
    await w.daemon.cycle();
    tick();
    await w.daemon.cycle();
    expect(w.lines.filter((l) => l.startsWith("dead:"))).toEqual([
      `dead: run ${GATE}: kw-${GATE} lost`,
    ]);
    expect((await w.journal(GATE)).length).toBe(before);
    expect((await w.state(GATE)).v).toBe(1);
    // Once per daemon.
    tick();
    await w.newDaemon().cycle();
    expect(w.lines.filter((l) => l.startsWith("dead:"))).toHaveLength(2);
  });

  test("t44_resume_is_skipped_when_an_agent_moved", async () => {
    await project();
    const host = newHost();
    let hook: ((runId: string) => Promise<void>) | undefined;
    let opens = 0;
    const port: ServeHostPort = {
      open: async (id) => {
        opens += 1;
        // The second open in a cycle is the resume's, after the plan read the journal.
        if (hook !== undefined && opens === 2) {
          const run = hook;
          hook = undefined;
          await run(id);
        }
        return host.open(id);
      },
      runSummaries: () => host.runSummaries(),
      list: () => host.list(),
      taskLink: () => host.taskLink(),
      start: (input) => host.start(input),
      withWorkerStartLock: (fn) => host.withWorkerStartLock(fn),
    };
    const w = await world({ host, deps: { host: port } });
    const key = await w.make("Task A");
    await w.daemon.cycle();
    const runId = await w.runOf(key);
    await w.approve(runId);
    // Between the plan and the act, an agent is served the next step.
    hook = async (id) => {
      const run = await host.open(id);
      await run?.nextStep({ serve: {} });
      for (let i = 0; i < 100; i++) {
        if ((await w.journal(id)).some((r) => r.event === "step_served")) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("no step_served");
    };
    opens = 0;
    tick();
    await w.daemon.cycle();
    expect(hook).toBeUndefined();
    expect(resumes(w.launcher)).toHaveLength(0);
    expect(w.lines.some((l) => l.includes("moved on"))).toBe(true);
    // Seen by the plan next time: one line, no resume.
    tick();
    await w.daemon.cycle();
    tick();
    await w.daemon.cycle();
    expect(resumes(w.launcher)).toHaveLength(0);
    expect(w.lines.filter((l) => l.startsWith("moved:"))).toHaveLength(1);
  });

  test("t44_resume_name_taken_is_success", async () => {
    await project();
    const host = newHost();
    const launcher = new HookedLauncher({ host, now: () => t });
    const w = await world({ host, launcher });
    const key = await w.make("Task A");
    await w.daemon.cycle();
    const runId = await w.runOf(key);
    await w.approve(runId);
    // The TUI resumes it between the plan and the act.
    launcher.hook = async () => {
      const run = await host.open(runId);
      const { decision } = (await import("@kodel-ai/pipeline-core/serve")).decisionOf(
        (await run?.journal()) ?? [],
      );
      if (!decision) throw new Error("no decision");
      launcher.next.push("silent");
      await launcher.resume({ runId, workdir: dir, sessionId: "s", decision });
    };
    tick();
    await w.daemon.cycle();
    expect(w.lines.some((l) => l.includes("was resumed already"))).toBe(true);
    expect(w.lines.some((l) => l.startsWith("failed:"))).toBe(false);
    expect(w.launcher.of(runId)).toHaveLength(2);
    // Two loops resume once.
    tick();
    await w.daemon.cycle();
    await w.newDaemon().cycle();
    expect(w.launcher.of(runId)).toHaveLength(2);
  });

  test("t44_resume_rereads_the_worker_records", async () => {
    await project();
    const host = newHost();
    const launcher = new HookedLauncher({ host, now: () => t });
    const w = await world({ host, launcher });
    const key = await w.make("Task A");
    await w.daemon.cycle();
    const runId = await w.runOf(key);
    await w.approve(runId);
    // The person removes the worker's record between the plan and the resume.
    launcher.hook = async () => {
      launcher.remove(runId);
    };
    tick();
    await w.daemon.cycle();
    expect(resumes(w.launcher)).toHaveLength(0);
    expect(
      w.lines.some((l) => l.includes(`not resumed: run ${runId}: its worker record is gone`)),
    ).toBe(true);
    expect(w.lines.some((l) => l.startsWith("failed:"))).toBe(false);
  });

  test("t44_resume_rechecks_max_workers", async () => {
    await project({
      serve: ["serve:", "  enabled: true", "  max_runs: 2", "  start:", "    - pipeline: gated"],
    });
    const host = newHost();
    const launcher = new HookedLauncher({ host, now: () => t });
    const w = await world({ host, launcher });
    const a = await w.make("Task A", { priority: "high" });
    await w.daemon.cycle();
    const runA = await w.runOf(a);
    await w.approve(runA);
    // Another starter takes the one worker place between the plan and the resume.
    const b = await w.make("Task B", { priority: "normal" });
    launcher.hook = async () => {
      const started = await host.start({
        pipeline: "gated",
        task: "Task B",
        restart: true,
        task_key: b,
        caller: { name: "kodel-tui", version: "0.0.0-test" },
      });
      launcher.next.push("silent");
      await launcher.start({ runId: started.run.runId, workdir: dir, title: "Task B" });
    };
    tick();
    await w.daemon.cycle();
    expect(resumes(w.launcher)).toHaveLength(0);
    expect(w.lines.some((l) => l.includes(`not resumed: run ${runA}: max_workers is full`))).toBe(
      true,
    );
  });

  test("t44_worker_of_an_ended_run_keeps_its_worker_place", async () => {
    await project({
      serve: ["serve:", "  enabled: true", "  max_runs: 2", "  start:", "    - pipeline: gated"],
    });
    const w = await world();
    const a = await w.make("Task A", { priority: "high" });
    await w.daemon.cycle();
    const runA = await w.runOf(a);
    await w.approve(runA);
    tick();
    await w.daemon.cycle();
    expect((await w.state(runA)).status).toBe("completed");
    // The run is over, but its agent is still finishing its last answer.
    const latest = w.launcher.of(runA).at(-1);
    if (latest === undefined) throw new Error("no record");
    latest.state = "running";
    delete latest.since;
    const b = await w.make("Task B", { priority: "normal" });
    tick();
    await w.daemon.cycle();
    expect((await w.task(b)).runs).toEqual([]);
    tick();
    await w.daemon.cycle();
    expect((await w.task(b)).runs).toEqual([]);
    // It exits: the place is free and the run is not read again.
    latest.state = "exited";
    latest.since = t;
    tick();
    await w.daemon.cycle();
    expect((await w.task(b)).runs).toHaveLength(1);
    const before = w.launcher.calls.filter(
      (c) => c.kind === "statuses" && c.runIds?.includes(runA),
    ).length;
    tick();
    await w.daemon.cycle();
    const after = w.launcher.calls.filter(
      (c) => c.kind === "statuses" && c.runIds?.includes(runA),
    ).length;
    expect(after).toBe(before);
  });

  test("t44_failing_resume_gives_up_and_frees_the_worker_place", async () => {
    await project({
      serve: ["serve:", "  enabled: true", "  max_runs: 2", "  start:", "    - pipeline: gated"],
    });
    const w = await world();
    const a = await w.make("Task A", { priority: "high" });
    await w.daemon.cycle();
    const runA = await w.runOf(a);
    await w.approve(runA);
    const failing = spyOn(w.launcher, "resume").mockImplementation(async () => {
      throw new Error("claude is not signed in");
    });
    try {
      for (let i = 0; i < 3; i++) {
        tick(61_000);
        await w.daemon.cycle();
      }
      expect(failing).toHaveBeenCalledTimes(3);
      expect(w.lines.filter((l) => l.startsWith(`not resumed: run ${runA} (attempt`))).toHaveLength(
        3,
      );
      // given up: said once, not tried again, and the one worker place is free for a start
      const b = await w.make("Task B", { priority: "normal" });
      tick(61_000);
      await w.daemon.cycle();
      tick(61_000);
      await w.daemon.cycle();
      expect(failing).toHaveBeenCalledTimes(3);
      expect(w.lines.filter((l) => l.startsWith(`resume_failed: run ${runA}`))).toHaveLength(1);
      expect((await w.task(b)).runs).toHaveLength(1);
    } finally {
      failing.mockRestore();
    }
  });

  test("t44_5m9d_serve_idles_and_counts_no_resume_attempt_on_a_config_refusal", async () => {
    const serve = ["serve:", "  enabled: true", "  start:", "    - pipeline: gated"];
    await project({ serve });
    const w = await world();
    const a = await w.make("Task A", { priority: "high" });
    await w.daemon.cycle();
    const runA = await w.runOf(a);
    await w.approve(runA);
    const config = join(storeRoot(), "config.yaml");
    const good = await readFile(config, "utf8");

    // An `mcp` block that cannot be used. A daemon that runs ends when the config changes; the one
    // started on the new config reads it whole every cycle, so it is idle with the reason, and neither
    // starts nor resumes anything.
    await writeFile(config, `${good}\nmcp:\n  roles:\n    worker:\n      add: [pipeline_strat]\n`);
    tick(61_000);
    expect((await w.daemon.cycle()).kind).toBe("restart");
    const onBadConfig = w.newDaemon();
    for (let i = 0; i < 4; i++) {
      tick(61_000);
      expect((await onBadConfig.cycle()).kind).toBe("idle");
    }
    expect(w.lines.filter((l) => l.startsWith("idle:"))).toHaveLength(1);
    expect(w.lines.find((l) => l.startsWith("idle:"))).toContain("pipeline_strat");
    expect(resumes(w.launcher)).toHaveLength(0);

    // A refusal that still reaches a resume (the file changed between the daemon's read and the
    // launcher's own check): nothing was spawned, and it is not one of the run's three attempts.
    await writeFile(config, good);
    const daemon = w.newDaemon();
    const refusing = spyOn(w.launcher, "resume").mockImplementation(async () => {
      throw new KodelError("CONFIG_INVALID", 'mcp.roles.worker names "pipeline_strat"');
    });
    try {
      for (let i = 0; i < 5; i++) {
        tick(61_000);
        await daemon.cycle();
      }
      expect(refusing).toHaveBeenCalledTimes(5);
    } finally {
      refusing.mockRestore();
    }
    const refused = w.lines.filter((l) => l.startsWith(`not resumed: run ${runA}`));
    expect(refused).toHaveLength(5);
    expect(refused.every((l) => l.includes("no attempt is counted"))).toBe(true);
    expect(w.lines.some((l) => l.includes("(attempt"))).toBe(false);
    expect(w.lines.some((l) => l.startsWith("resume_failed"))).toBe(false);
    // Fixed: the very next cycle resumes the worker.
    tick(61_000);
    await daemon.cycle();
    expect(resumes(w.launcher)).toHaveLength(1);
    expect(w.lines.some((l) => l.startsWith(`resumed: run ${runA}`))).toBe(true);
  });

  test("t44_rm_rearms_or_releases_a_run", async () => {
    await project();
    const w = await world();
    const key = await w.make("Task A");
    await w.daemon.cycle();
    const runId = await w.runOf(key);
    await w.approve(runId);
    w.launcher.next.push("silent");
    tick();
    await w.daemon.cycle();
    const resumed = w.launcher.of(runId)[1];
    expect(resumed?.decisionSeq).toBeDefined();
    // The person stops the resume and removes its record: the decision may be resumed again.
    w.launcher.stop(runId);
    w.launcher.remove(runId, resumed?.name);
    tick();
    await w.daemon.cycle();
    expect(resumes(w.launcher)).toHaveLength(2);
    expect((await w.state(runId)).status).toBe("completed");

    // Every record of a run removed: the daemon leaves it alone.
    const other = await w.make("Task B");
    tick();
    await w.daemon.cycle();
    const runB = await w.runOf(other);
    w.launcher.remove(runB);
    await w.approve(runB);
    tick();
    await w.daemon.cycle();
    expect(resumes(w.launcher)).toHaveLength(2);
    expect(notesOf(await w.journal(runB))).toHaveLength(0);
  });

  test("t44_cycle_survives_a_failed_action", async () => {
    await project({
      serve: [
        "serve:",
        "  enabled: true",
        "  max_runs: 2",
        "  max_workers: 2",
        "  start:",
        "    - pipeline: gated",
      ],
    });
    const w = await world();
    const a = await w.make("Task A", { priority: "high" });
    const b = await w.make("Task B", { priority: "normal" });
    await w.daemon.cycle();
    const runA = await w.runOf(a);
    const runB = await w.runOf(b);
    await w.approve(runA);
    tick(1_000);
    await w.approve(runB);
    w.launcher.next.push("failing");
    tick();
    await w.daemon.cycle();
    expect(resumes(w.launcher).map((c) => c.runId)).toEqual([runA, runB]);
    expect(w.lines.some((l) => l.startsWith(`not resumed: run ${runA} (attempt 1 of 3)`))).toBe(
      true,
    );
    expect((await w.state(runB)).status).toBe("completed");
  });

  test("t44_stop_finishes_the_action_in_hand", async () => {
    await project({
      serve: [
        "serve:",
        "  enabled: true",
        "  max_runs: 2",
        "  max_workers: 2",
        "  start:",
        "    - pipeline: gated",
      ],
    });
    const host = newHost();
    const stop = new AbortController();
    class Stopping extends ScriptedLauncher {
      override async resume(input: Parameters<ScriptedLauncher["resume"]>[0]) {
        stop.abort();
        return super.resume(input);
      }
    }
    const launcher = new Stopping({ host, now: () => t });
    const w = await world({ host, launcher, deps: { sleep: async () => undefined } });
    const a = await w.make("Task A", { priority: "high" });
    const b = await w.make("Task B", { priority: "normal" });
    await w.daemon.cycle();
    const runA = await w.runOf(a);
    const runB = await w.runOf(b);
    await w.approve(runA);
    tick(1_000);
    await w.approve(runB);
    tick();
    expect(await w.daemon.run(stop.signal)).toEqual({ exit: 0 });
    // The resume in hand was finished; the next was not begun.
    expect(resumes(launcher).map((c) => c.runId)).toEqual([runA]);
    expect((await w.state(runA)).status).toBe("completed");
    expect(w.launcher.of(runB)).toHaveLength(1);
  });

  test("t44_unreadable_workers_stop_the_cycle", async () => {
    await project();
    const w = await world();
    const a = await w.make("Task A");
    w.launcher.next.push("silent");
    await w.daemon.cycle();
    const runA = await w.runOf(a);
    await w.make("Task B");
    w.launcher.lose(runA);
    w.launcher.failStatuses = true;
    tick(61_000);
    const result = await w.daemon.cycle();
    expect(result.kind).toBe("stopped");
    expect(notesOf(await w.journal(runA))).toHaveLength(0);
    expect(starts(w.launcher)).toHaveLength(1);
    expect(w.lines.some((l) => l.includes("the worker records cannot be read"))).toBe(true);
  });

  test("t44_unreadable_workers_write_an_idle_record", async () => {
    await project();
    const written: { state: string; reason?: string }[] = [];
    const w = await world();
    const daemon = w.newDaemon({
      record: {
        place: { base: tmp, root: dir, file: join(tmp, "serve.json") },
        current: () => {
          throw new Error("not used");
        },
        writeCycle: async (update) => {
          written.push(update);
          return { ok: true };
        },
        release: async () => undefined,
      },
    });
    await w.make("Task A");
    w.launcher.next.push("silent");
    await daemon.cycle();
    expect(written.at(-1)?.state).toBe("active");
    w.launcher.failStatuses = true;
    tick();
    expect((await daemon.cycle()).kind).toBe("stopped");
    expect(written.at(-1)?.state).toBe("idle");
    expect(written.at(-1)?.reason).toContain("the worker records cannot be read");
  });

  test("t44_unreadable_runs_name_the_cause", async () => {
    await project();
    const host = newHost();
    const failing: ServeHostPort = Object.assign(Object.create(host) as LocalPipelineHost, {
      runSummaries: async (): Promise<RunSummary[]> => {
        throw new Error("disk on fire");
      },
    });
    const w = await world({ host });
    const daemon = w.newDaemon({ host: failing });
    const result = await daemon.cycle();
    expect(result).toEqual({
      kind: "stopped",
      reason: "the runs cannot be read: disk on fire; nothing is done in this cycle",
    });
    expect(w.lines.some((l) => l.includes("worker records"))).toBe(false);
  });

  test("t44_record_taken_over_ends_the_daemon", async () => {
    await project();
    const w = await world();
    const file = join(tmp, "serve.json");
    const daemon = w.newDaemon({
      sleep: async () => undefined,
      record: {
        place: { base: tmp, root: dir, file },
        current: () => {
          throw new Error("not used");
        },
        writeCycle: async () => ({
          ok: false,
          error: new ServeRecordRefused(
            "taken_over",
            `another kodel serve took over the record ${file}`,
          ),
        }),
        release: async () => undefined,
      },
    });
    const ended = await daemon.run(new AbortController().signal);
    expect(ended).toEqual({
      exit: 78,
      reason: `another kodel serve took over the record ${file}`,
    });
    // The log line goes through redaction, which may mask a random temporary path.
    expect(w.lines.some((l) => l.startsWith("another kodel serve took over the record"))).toBe(
      true,
    );
  });

  test("t44_idle_until_enabled", async () => {
    await project({ serve: ["serve:", "  enabled: false", "  start:", "    - pipeline: gated"] });
    const w = await world();
    await w.make("Task A");
    expect((await w.daemon.cycle()).kind).toBe("idle");
    tick();
    await w.daemon.cycle();
    expect(w.lines.filter((l) => l.startsWith("idle:"))).toHaveLength(1);
    // A block that does not load: idle, said once more.
    await writeConfig({ serve: ["serve:", "  enabled: true", "  max_workers: 0"] });
    tick();
    expect((await w.daemon.cycle()).kind).toBe("idle");
    tick();
    await w.daemon.cycle();
    expect(w.lines.filter((l) => l.startsWith("idle:"))).toHaveLength(2);
    expect(starts(w.launcher)).toHaveLength(0);
    // Fixed: active, without a restart.
    await writeConfig({});
    tick();
    expect((await w.daemon.cycle()).kind).toBe("active");
    expect(starts(w.launcher)).toHaveLength(1);
  });

  test("t44_changed_config_or_build_ends_the_daemon", async () => {
    await project();
    let build = "1";
    const w = await world({
      deps: { buildStamp: async () => build, sleep: async () => undefined },
    });
    await w.daemon.cycle();
    // The serve block alone may change.
    await writeConfig({ serve: ["serve:", "  enabled: true", "  max_workers: 3"] });
    expect((await w.daemon.cycle()).kind).toBe("active");
    await writeConfig({
      serve: ["serve:", "  enabled: true", "  max_workers: 3"],
      config: ["agent_hints:", "  wait: false"],
    });
    const ended = await w.daemon.run(new AbortController().signal);
    expect(ended.exit).toBe(75);
    // The build.
    await writeConfig({});
    const other = w.newDaemon();
    await other.cycle();
    build = "2";
    expect((await other.cycle()).kind).toBe("restart");
  });

  test("t44_unread_build_or_broken_yaml_is_no_restart", async () => {
    await project();
    let build: string | undefined;
    const w = await world({
      deps: {
        buildStamp: async () => {
          if (build === undefined) throw new Error("cannot stat");
          return build;
        },
      },
    });
    // The first stamp cannot be read: the first one read is the base, not a change.
    expect((await w.daemon.cycle()).kind).toBe("active");
    build = "1";
    tick();
    expect((await w.daemon.cycle()).kind).toBe("active");
    build = undefined;
    tick();
    expect((await w.daemon.cycle()).kind).toBe("active");
    build = "1";
    tick();
    expect((await w.daemon.cycle()).kind).toBe("active");
    build = "2";
    tick();
    expect((await w.daemon.cycle()).kind).toBe("restart");

    // A config that does not parse: idle with the parse error, no restart; back as it was: active.
    const text = await readFile(join(storeRoot(), "config.yaml"), "utf8");
    const other = w.newDaemon();
    expect((await other.cycle()).kind).toBe("active");
    await writeFile(join(storeRoot(), "config.yaml"), `${text}\nserve: [unclosed\n`);
    tick();
    const idle = await other.cycle();
    expect(idle.kind).toBe("idle");
    expect(idle.kind === "idle" && idle.reason).toContain("the config does not load");
    await writeFile(join(storeRoot(), "config.yaml"), text);
    tick();
    expect((await other.cycle()).kind).toBe("active");
  });

  describe("problems of the environment use no attempt", () => {
    const noAttempt = (w: World) => {
      expect(starts(w.launcher)).toHaveLength(0);
      expect(w.daemon.memory().attempts).toEqual({});
    };
    const noComment = async (w: World, key: string) => {
      expect((await w.task(key)).comments ?? []).toEqual([]);
    };

    test("t44_environment_task_read_under_the_lock_is_not_an_attempt", async () => {
      await project();
      const w = await world();
      const key = await w.make("Task A");
      const tasks = serveTasksOf(w.service);
      const daemon = w.newDaemon({
        tasks: {
          capabilities: tasks.capabilities,
          list: (filter) => tasks.list(filter),
          get: async () => {
            throw new Error("tracker down");
          },
          comment: (k, text) => tasks.comment(k, text),
          priorities: () => tasks.priorities(),
        },
      });
      for (let i = 0; i < 4; i++) {
        await daemon.cycle();
        tick(61_000);
      }
      expect(starts(w.launcher)).toHaveLength(0);
      expect(daemon.memory().attempts).toEqual({});
      await noComment(w, key);
      expect(w.lines.filter((l) => l.includes("tracker down"))).toHaveLength(1);
    });

    test("t44_environment_check_that_throws_blocks_only_starts", async () => {
      await project();
      const w = await world();
      const a = await w.make("Task A");
      w.launcher.next.push("silent");
      await w.daemon.cycle();
      const runA = await w.runOf(a);
      await w.make("Task B");
      w.host.taskLink = async () => {
        throw new Error("tracker link broken");
      };
      w.launcher.lose(runA);
      tick(61_000);
      expect((await w.daemon.cycle()).kind).toBe("active");
      expect(notesOf(await w.journal(runA))).toHaveLength(1);
      expect(starts(w.launcher)).toHaveLength(1);
      expect(w.lines.some((l) => l.includes("the start conditions cannot be read"))).toBe(true);
    });

    test("t44_environment_choice_needed_is_not_an_attempt", async () => {
      await project();
      await writeFile(
        join(storeRoot(), "pipelines", "gated.yaml"),
        GATED.replace("do it", "do it now"),
      );
      const w = await world();
      const key = await w.make("Task A");
      await w.daemon.cycle();
      tick(61_000);
      await w.daemon.cycle();
      noAttempt(w);
      await noComment(w, key);
      expect(w.lines.filter((l) => l.includes("not committed"))).toHaveLength(1);
    });

    test("t44_environment_state_locked_is_not_an_attempt", async () => {
      await project();
      const host = newHost({ workerStartLock: { workerStartWaitMs: 50 } });
      const w = await world({ host });
      const key = await w.make("Task A");
      // Another starter holds the lock (a store of its own, as another process has).
      const other = new FileStore({ root: storeRoot() });
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = other.withWorkerStartLock(() => held);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await w.daemon.cycle();
      tick(61_000);
      await w.daemon.cycle();
      noAttempt(w);
      await noComment(w, key);
      expect(w.lines.filter((l) => l.includes("another start is in progress"))).toHaveLength(1);
      release();
      await holding;
      tick(61_000);
      await w.daemon.cycle();
      expect(starts(w.launcher)).toHaveLength(1);
    });

    test("t44_environment_no_claude_is_not_an_attempt", async () => {
      await project();
      const w = await world();
      const key = await w.make("Task A");
      w.launcher.preflightResult = { ok: false, reason: "claude is not on the PATH" };
      for (let i = 0; i < 3; i++) {
        await w.daemon.cycle();
        tick();
      }
      noAttempt(w);
      await noComment(w, key);
      // Asked at most once a minute.
      expect(w.launcher.calls.filter((c) => c.kind === "preflight")).toHaveLength(1);
      expect(w.lines.filter((l) => l.includes("claude is not on the PATH"))).toHaveLength(1);
      tick(60_000);
      await w.daemon.cycle();
      expect(w.launcher.calls.filter((c) => c.kind === "preflight")).toHaveLength(2);
      w.launcher.preflightResult = { ok: true };
      tick(60_000);
      await w.daemon.cycle();
      expect(starts(w.launcher)).toHaveLength(1);
    });

    test("t44_environment_worktree_mode_off_is_not_an_attempt", async () => {
      await project();
      const first = await world();
      const a = await first.make("Task A");
      await first.daemon.cycle();
      const runA = await first.runOf(a);
      // The config changed outside the block: a new daemon (the old one exits with 75).
      await writeConfig({ config: ["worktree:", "  mode: off"] });
      const w = await world({ launcher: first.launcher });
      const b = await w.make("Task B");
      await first.approve(runA);
      tick();
      await w.daemon.cycle();
      // Still resumes; starts nothing.
      expect(resumes(w.launcher)).toHaveLength(1);
      expect(starts(w.launcher)).toHaveLength(1);
      expect((await w.task(b)).state).toBe("todo");
      expect(w.daemon.memory().attempts).toEqual({});
      expect(w.lines.some((l) => l.includes("worktree.mode is off"))).toBe(true);
    });

    const wrapped = (real: ServeTasksPort, change: Partial<ServeTasksPort["capabilities"]>) => ({
      ...real,
      list: real.list.bind(real),
      get: real.get.bind(real),
      comment: real.comment.bind(real),
      priorities: real.priorities.bind(real),
      capabilities: { ...real.capabilities, ...change },
    });

    test("t44_environment_tracker_without_provenance_is_not_an_attempt", async () => {
      await project();
      const service = await openTasks();
      const w = await world({
        deps: { tasks: wrapped(serveTasksOf(service), { provenance: false }) },
      });
      const key = await w.make("Task A");
      await w.daemon.cycle();
      tick();
      await w.daemon.cycle();
      noAttempt(w);
      await noComment(w, key);
      expect(w.lines.filter((l) => l.includes("cannot keep the mark"))).toHaveLength(1);
    });

    test("t44_environment_tracker_without_runs_is_not_an_attempt", async () => {
      await project();
      const service = await openTasks();
      const w = await world({ deps: { tasks: wrapped(serveTasksOf(service), { runs: "none" }) } });
      const key = await w.make("Task A");
      await w.daemon.cycle();
      tick();
      await w.daemon.cycle();
      noAttempt(w);
      await noComment(w, key);
      expect(w.lines.filter((l) => l.includes("cannot attach runs"))).toHaveLength(1);
    });

    test("t44_environment_more_than_five_pages_is_not_an_attempt", async () => {
      await project();
      const service = await openTasks();
      const real = serveTasksOf(service);
      let pages = 0;
      const endless: ServeTasksPort = {
        ...wrapped(real, {}),
        list: async (filter) => {
          pages += 1;
          const { cursor: _cursor, ...first } = filter;
          const page = await real.list(first);
          return { ...page, next: `page-${pages}` };
        },
      };
      const w = await world({ deps: { tasks: endless } });
      const key = await w.make("Task A");
      await w.daemon.cycle();
      noAttempt(w);
      await noComment(w, key);
      expect(pages).toBe(5);
      expect(w.lines.filter((l) => l.includes("more than 1000 candidates"))).toHaveLength(1);
    });
  });

  test("t44_unreadable_runs_say_why", async () => {
    await project({
      serve: [
        "serve:",
        "  enabled: true",
        "  max_runs: 3",
        "  max_workers: 3",
        "  start:",
        "    - pipeline: gated",
      ],
    });
    const w = await world();
    const keys = [await w.make("Task A"), await w.make("Task B"), await w.make("Task C")];
    await w.daemon.cycle();
    const [newer, broken, modified] = await Promise.all(keys.map((k) => w.runOf(k)));
    const statePath = (id: string | undefined) =>
      join(storeRoot(), "runs", id ?? "?", "state.json");
    const raw = async (id: string | undefined) =>
      JSON.parse(await readFile(statePath(id), "utf8")) as Record<string, unknown>;
    await writeFile(statePath(newer), JSON.stringify({ ...(await raw(newer)), v: 99 }));
    await writeFile(statePath(broken), JSON.stringify({ ...(await raw(broken)), active: "nope" }));
    await writeFile(statePath(modified), JSON.stringify({ ...(await raw(modified)), title: "x" }));
    // A fresh host: no run is cached.
    const fresh = await world({ host: newHost(), launcher: w.launcher });
    tick();
    await fresh.daemon.cycle();
    const unreadable = fresh.lines.filter((l) => l.startsWith("unreadable:"));
    expect(unreadable.find((l) => l.includes(newer ?? "?"))).toContain(
      "written by a newer kodel, upgrade kodel",
    );
    expect(unreadable.find((l) => l.includes(broken ?? "?"))).toContain("cannot read");
    expect(unreadable.find((l) => l.includes(modified ?? "?"))).toContain("was modified");
  });

  test("t44_give_up_with_a_long_reason_is_written_once", async () => {
    await project({
      serve: ["serve:", "  enabled: true", "  start:", "    - pipeline: gated"],
    });
    const host = newHost();
    const port: ServeHostPort = {
      open: (id) => host.open(id),
      runSummaries: () => host.runSummaries(),
      list: () => host.list(),
      taskLink: () => host.taskLink(),
      withWorkerStartLock: (fn) => host.withWorkerStartLock(fn),
      start: async () => {
        throw new Error(`the launch failed: ${"y".repeat(800)}`);
      },
    };
    const w = await world({ host, deps: { host: port } });
    const key = await w.make("Task with a long failure");
    for (let i = 0; i < 6; i++) {
      await w.daemon.cycle();
      tick(61_000);
    }
    const comments = (await w.task(key)).comments ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.text.length).toBeLessThanOrEqual(500);
    expect(w.lines.filter((l) => l.startsWith("gave up:"))).toHaveLength(1);
    expect(w.lines.filter((l) => l.startsWith("failed:"))).toEqual([]);
  });

  test("t44_give_up_comment_refused_is_given_up_in_memory", async () => {
    await project({
      serve: ["serve:", "  enabled: true", "  start:", "    - pipeline: gated"],
    });
    const host = newHost();
    const port: ServeHostPort = {
      open: (id) => host.open(id),
      runSummaries: () => host.runSummaries(),
      list: () => host.list(),
      taskLink: () => host.taskLink(),
      withWorkerStartLock: (fn) => host.withWorkerStartLock(fn),
      start: async () => {
        throw new Error("the launch failed");
      },
    };
    const w = await world({ host, deps: { host: port } });
    const key = await w.make("Task whose tracker refuses the comment");
    const comment = spyOn(w.service, "update").mockImplementation(async () => ({
      ok: false,
      code: "INVALID_TASK",
      message: "refused",
    }));
    try {
      for (let i = 0; i < 6; i++) {
        await w.daemon.cycle();
        tick(61_000);
      }
    } finally {
      comment.mockRestore();
    }
    expect(w.daemon.memory().attempts[key]?.given_up).toBe(true);
    const gave = w.lines.filter((l) => l.startsWith("gave up:"));
    expect(gave).toHaveLength(1);
    expect(gave[0]).toContain("the comment could not be written");
    expect(w.lines.filter((l) => l.startsWith("failed:"))).toEqual([]);
  });

  test("t44_log_and_comments_are_redacted", async () => {
    await project({
      serve: ["serve:", "  enabled: true", "  start:", "    - pipeline: gated"],
    });
    const host = newHost();
    const rules: RedactRule[] = [{ name: "word", pattern: /hunter2/g }];
    let failing = true;
    const port: ServeHostPort = {
      open: (id) => host.open(id),
      runSummaries: () => host.runSummaries(),
      list: () => host.list(),
      taskLink: () => host.taskLink(),
      withWorkerStartLock: (fn) => host.withWorkerStartLock(fn),
      start: async (input) => {
        if (failing) throw new Error(`the tracker said ${SECRET} and hunter2`);
        return host.start(input);
      },
    };
    const w = await world({ host, deps: { host: port, rules } });
    const key = await w.make(`Task with ${SECRET}`);
    for (let i = 0; i < 4; i++) {
      await w.daemon.cycle();
      tick(61_000);
    }
    const comments = (await w.task(key)).comments ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.text).toContain(
      "kodel serve: not started after 3 attempts (pipeline gated)",
    );
    // A decision with a secret in its reason.
    failing = false;
    await w.service.update({ key, comment: "try again" });
    await w.daemon.cycle();
    const runId = await w.runOf(key);
    await w.approve(runId, `fine, ${SECRET}`);
    tick();
    await w.daemon.cycle();
    const everything = [...w.lines, ...comments.map((c) => c.text)].join("\n");
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("hunter2");
    expect(w.lines.some((l) => l.startsWith("gave up:"))).toBe(true);
    const notes = notesOf(await w.journal(runId));
    expect(JSON.stringify(notes)).not.toContain(SECRET);
  });

  test("t44_daemon_decides_nothing", async () => {
    await project();
    const host = newHost();
    const calledHost = new Set<string>();
    const calledRun = new Set<string>();
    const spy = <T extends object>(target: T, seen: Set<string>): T =>
      new Proxy(target, {
        get(object, property, receiver) {
          const value: unknown = Reflect.get(object, property, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            seen.add(String(property));
            const out: unknown = value.apply(object, args);
            if (property === "open" && out instanceof Promise) {
              return out.then((run: object | undefined) => (run ? spy(run, calledRun) : run));
            }
            return out;
          };
        },
      });
    const port = spy<ServeHostPort>(
      {
        open: (id) => host.open(id),
        runSummaries: () => host.runSummaries(),
        list: () => host.list(),
        taskLink: () => host.taskLink(),
        start: (input) => host.start(input),
        withWorkerStartLock: (fn) => host.withWorkerStartLock(fn),
        foreignRootOf: (meta) => host.foreignRootOf(meta),
      },
      calledHost,
    );
    const w = await world({ host, deps: { host: port } });
    const key = await w.make("Task A");
    w.launcher.next.push("drive", "silent");
    await w.daemon.cycle();
    const runId = await w.runOf(key);
    await w.approve(runId);
    tick();
    await w.daemon.cycle();
    w.launcher.lose(runId);
    tick();
    await w.daemon.cycle();
    for (const name of calledHost) {
      expect([
        "open",
        "runSummaries",
        "list",
        "taskLink",
        "start",
        "withWorkerStartLock",
        "foreignRootOf",
      ]).toContain(name);
    }
    for (const name of calledRun) {
      expect([
        "journal",
        "inspect",
        "integrityStatus",
        "location",
        "inProject",
        "noteWorker",
      ]).toContain(name);
    }
    // The journal's decisions are only the test's.
    const decisions = (await w.journal(runId)).filter((r) =>
      ["gate_decided", "run_resumed", "pipeline_accepted", "acknowledged"].includes(r.event),
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decided_by).toBeUndefined();
  });

  test("t44_serve_adds_only_worker_notes", async () => {
    await project({
      serve: [
        "serve:",
        "  enabled: true",
        "  max_runs: 4",
        "  max_workers: 4",
        "  start:",
        "    - pipeline: gated",
      ],
    });
    const w = await world();
    const key = await w.make("Task A");
    await w.daemon.cycle();
    const daemonRun = await w.runOf(key);
    // The TUI's start of another task: the run through the host with the task's key, then the worker.
    const other = await w.make("Task B");
    const tui = await w.host.start({
      pipeline: "gated",
      task: "Task B",
      restart: true,
      task_key: other,
      caller: { name: "kodel-tui", version: "0.0.0-test" },
    });
    await w.launcher.start({ runId: tui.run.runId, workdir: dir, title: "Task B" });
    const kinds = async (id: string) =>
      [...new Set((await w.journal(id)).map((r) => r.event))].sort();
    const files = async (id: string) => (await readdir(join(storeRoot(), "runs", id))).sort();
    expect(await kinds(daemonRun)).toEqual(await kinds(tui.run.runId));
    expect(await files(daemonRun)).toEqual(await files(tui.run.runId));
    // A dead worker adds the note and nothing else.
    const third = await w.make("Task C");
    w.launcher.next.push("silent");
    tick();
    await w.daemon.cycle();
    const runC = await w.runOf(third);
    const before = await kinds(runC);
    w.launcher.lose(runC);
    tick();
    await w.daemon.cycle();
    expect((await kinds(runC)).filter((k) => !before.includes(k))).toEqual(["worker_note"]);
  });

  test("t44_ended_runs_are_read_once", async () => {
    const summaries: RunSummary[] = Array.from({ length: 500 }, (_, i) => {
      const runId = `r_0mw${String(i).padStart(6, "0")}_abcd`;
      return {
        meta: { runId } as RunSummary["meta"],
        state: { v: 2, status: "completed", taskKey: `KDL-${i}` } as unknown as RunState,
      };
    });
    const opened: string[] = [];
    const host: ServeHostPort = {
      open: async (id) => {
        opened.push(id);
        return undefined;
      },
      runSummaries: async () => summaries,
      list: async () => ({ pipelines: [] }),
      taskLink: async () => undefined,
      start: async () => {
        throw new Error("no start");
      },
      withWorkerStartLock: (fn) => fn(),
    };
    const launcher = new ScriptedLauncher({ host: { open: async () => undefined }, now: () => t });
    await mkdir(storeRoot(), { recursive: true });
    await writeFile(join(storeRoot(), "config.yaml"), "serve:\n  enabled: true\n");
    const daemon = createServeDaemon({
      root: dir,
      storeRoot: storeRoot(),
      host,
      launcher,
      log: () => undefined,
      version: "0.0.0-test",
      now: () => t,
    });
    const began = performance.now();
    for (let i = 0; i < 3; i++) {
      await daemon.cycle();
      tick();
    }
    expect(performance.now() - began).toBeLessThan(2_000);
    expect(opened).toEqual([]);
    // An ended run is asked about its worker once, in the cycle that first sees it ended (a worker may
    // still be finishing); with none alive, never again.
    expect(launcher.calls.filter((c) => c.kind === "statuses")).toHaveLength(1);
  });

  test("t44_agent_edit_needs_a_new_approval in the daemon", async () => {
    await project({
      serve: [
        "serve:",
        "  enabled: true",
        "  max_runs: 4",
        "  max_workers: 4",
        "  start:",
        "    - pipeline: gated",
      ],
    });
    const w = await world();
    const fresh = async (key: string) => (await w.task(key)).updated_at;
    // As `kodel task approve` does: the service, with the version the person was shown.
    const approve = async (key: string) => {
      const answer = await w.service.approve({ key, seen: await fresh(key) });
      expect(answer.ok).toBe(true);
    };
    const agentEdit = async (key: string, title: string) => {
      const answer = await w.service.update({ key, title, by_agent: true });
      expect(answer.ok).toBe(true);
    };
    const made = await w.service.create({ title: "An agent's task", created_by: "agent" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const byAgent = (made.task as Task).key;
    const byPerson = await w.make("A person's task");
    await agentEdit(byPerson, "A person's task, changed by an agent");

    await w.daemon.cycle();
    tick();
    await w.daemon.cycle();
    expect(starts(w.launcher)).toHaveLength(0);
    expect((await w.task(byAgent)).runs).toEqual([]);
    expect((await w.task(byPerson)).runs).toEqual([]);

    // Approved, then changed by an agent again (in the same instant of the clock): it waits.
    await approve(byAgent);
    await agentEdit(byAgent, "An agent's task, changed after the approval");
    tick();
    await w.daemon.cycle();
    expect(starts(w.launcher)).toHaveLength(0);

    await approve(byAgent);
    await approve(byPerson);
    tick();
    await w.daemon.cycle();
    expect(starts(w.launcher)).toHaveLength(2);
    expect((await w.task(byAgent)).runs).toHaveLength(1);
    expect((await w.task(byPerson)).runs).toHaveLength(1);
  });

  test("t44_rule_with_approval_any_starts_an_agents_task_with_its_pipeline", async () => {
    // A required rule alone leaves the agent's task waiting for `kodel task approve`.
    await project({
      serve: ["serve:", "  enabled: true", "  start:", "    - pipeline: gated"],
    });
    // A second pipeline whose first step tells the runs apart.
    await writeFile(
      join(storeRoot(), "pipelines", "triage.yaml"),
      GATED.replace("name: gated", "name: triage")
        .replace("slug: write", "slug: sort")
        .replace("from: write", "from: sort")
        .replace("to: write", "to: sort"),
    );
    git("add", "-A");
    git("commit", "-q", "-m", "triage");
    const w = await world();
    const made = await w.service.create({ title: "An agent's task", created_by: "agent" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const key = (made.task as Task).key;
    await w.daemon.cycle();
    tick();
    await w.daemon.cycle();
    expect(starts(w.launcher)).toHaveLength(0);
    expect((await w.task(key)).runs).toEqual([]);

    // The person adds a later rule that takes tasks an agent wrote: the first rule still skips it.
    await writeConfig({
      serve: [
        "serve:",
        "  enabled: true",
        "  start:",
        "    - pipeline: gated",
        "    - pipeline: triage",
        "      match:",
        "        approval: any",
      ],
    });
    const after = w.newDaemon();
    tick();
    await after.cycle();
    expect(starts(w.launcher)).toHaveLength(1);
    const runId = await w.runOf(key);
    expect((await w.state(runId)).trail[0]).toBe("sort");
    expect((await w.task(key)).approved_at).toBeUndefined();
  });

  test("t44_task_made_in_a_run_is_started", async () => {
    await project();
    const w = await world();
    const first = await w.make("Task A");
    await w.daemon.cycle();
    const runId = await w.runOf(first);
    await w.approve(runId);
    tick();
    await w.daemon.cycle();
    expect((await w.state(runId)).status).toBe("completed");
    // A person's `kodel task add --run <id>`: the run it was found in is not a run that started it.
    const made = await w.service.create({ title: "Found in a run", run: runId });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const key = (made.task as Task).key;
    expect((await w.task(key)).created_in_run).toBe(runId);
    tick();
    await w.daemon.cycle();
    expect(starts(w.launcher)).toHaveLength(2);
    expect((await w.task(key)).runs).toHaveLength(2);
  });

  test("t44_ended_runs_are_read_once on the local host", async () => {
    await project();
    const w = await world();
    const key = await w.make("Task A");
    await w.daemon.cycle();
    const runId = await w.runOf(key);
    await w.approve(runId);
    tick();
    await w.daemon.cycle();
    expect((await w.state(runId)).status).toBe("completed");
    // The first cycle that sees it ended reads it; no later one does.
    tick();
    await w.daemon.cycle();
    const reads: string[] = [];
    const original = FileStore.prototype.readStateRaw;
    const counted = spyOn(FileStore.prototype, "readStateRaw").mockImplementation(function (
      this: FileStore,
      id: string,
    ) {
      reads.push(id);
      return original.call(this, id);
    });
    try {
      for (let i = 0; i < 3; i++) {
        tick();
        expect((await w.daemon.cycle()).kind).toBe("active");
      }
      // Also when a start reads the runs again under the lock.
      await w.make("Task B");
      tick();
      await w.daemon.cycle();
    } finally {
      counted.mockRestore();
    }
    expect(starts(w.launcher)).toHaveLength(2);
    expect(reads.filter((id) => id === runId)).toEqual([]);
    // Its state can no longer be read at all: the daemon does not notice.
    await writeFile(join(storeRoot(), "runs", runId, "state.json"), "{ not json");
    tick();
    expect((await w.daemon.cycle()).kind).toBe("active");
    expect(w.lines.filter((l) => l.includes(runId) && /cannot read/.test(l))).toEqual([]);
  });
});

describe("the start lock (T-44)", () => {
  // Two real processes, each with its own host and daemon, so the lock is decided by its file and a
  // live holder of another pid. Both run the daemon's start path: the TUI's `startTask` lives in the CLI
  // package, which this one cannot import; it takes the same `withWorkerStartLock` of the host.
  test.skipIf(process.platform === "win32")(
    "t44_two_processes_start_a_task_once",
    async () => {
      await project({
        serve: [
          "serve:",
          "  enabled: true",
          "  max_runs: 4",
          "  max_workers: 4",
          "  start:",
          "    - pipeline: gated",
        ],
      });
      const service = await openTasks();
      const make = async (title: string) => {
        const made = await service.create({ title });
        if (!made.ok) throw new Error(JSON.stringify(made));
        return (made.task as Task).key;
      };
      const runsOf = async (key: string) => {
        const got = await service.get({ key });
        if (!got.ok) throw new Error(JSON.stringify(got));
        return (got.task as Task).runs;
      };
      const race = async (round: number): Promise<string[]> => {
        const go = join(tmp, `go-${round}`);
        const children = [0, 1].map((i) => {
          const ready = join(tmp, `ready-${round}-${i}`);
          const proc = Bun.spawn(
            ["bun", CHILD, dir, join(tmp, "integrity"), join(tmp, "records.jsonl"), go, ready, "3"],
            { stdout: "pipe", stderr: "pipe", env: process.env },
          );
          return { ready, proc };
        });
        const deadline = Date.now() + 30_000;
        while (children.some((c) => !existsSync(c.ready))) {
          if (Date.now() > deadline) throw new Error("the children did not get ready");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await writeFile(go, "go");
        const results = await Promise.all(
          children.map(async ({ proc }) => {
            const code = await proc.exited;
            const out = await new Response(proc.stdout).text();
            const err = await new Response(proc.stderr).text();
            if (code !== 0) throw new Error(`a child failed (${code}): ${err}`);
            return JSON.parse(out.trim().split("\n").pop() ?? "") as {
              pid: number;
              started: string[];
            };
          }),
        );
        expect(new Set(results.map((r) => r.pid)).size).toBe(2);
        return results.flatMap((r) => r.started);
      };

      // Room for both: each task is started once, by one of the two.
      const first = [await make("Task A"), await make("Task B")];
      const started = await race(1);
      expect(started).toHaveLength(2);
      for (const key of first) {
        const runs = await runsOf(key);
        expect(runs).toHaveLength(1);
        expect(started.filter((id) => id === runs[0])).toHaveLength(1);
      }
      // Room for one more (both runs wait at their gate): the two together do not pass the limit.
      await writeConfig({
        serve: [
          "serve:",
          "  enabled: true",
          "  max_runs: 3",
          "  max_workers: 4",
          "  start:",
          "    - pipeline: gated",
        ],
      });
      const second = [await make("Task C"), await make("Task D")];
      expect(await race(2)).toHaveLength(1);
      const counts = await Promise.all(second.map(async (key) => (await runsOf(key)).length));
      expect(counts.sort()).toEqual([0, 1]);
    },
    60_000,
  );

  test("t44_start_lock_stale_only_when_gone", async () => {
    await mkdir(storeRoot(), { recursive: true });
    const lock = join(storeRoot(), "worker-start.lock");
    const identity = { method: "ps-lstart" as const, value: "then" };
    const holder = (pid: number) =>
      writeFile(lock, JSON.stringify({ pid, since: 0, token: "x", identity }));
    const store = (alive: (pid: number, id: unknown) => boolean) =>
      new FileStore({ root: storeRoot(), isSame: alive, workerStartWaitMs: 100 });
    // A live slow holder, however old its lock: never taken over.
    await holder(4242);
    const waited = await store(() => true)
      .withWorkerStartLock(async () => "in")
      .catch((e: unknown) => e);
    expect((waited as KodelError).code).toBe("STATE_LOCKED");
    // A dead holder, and a pid that is another process now: taken over.
    await holder(4242);
    expect(await store(() => false).withWorkerStartLock(async () => "in")).toBe("in");
    await holder(4242);
    const reused = (pid: number, id: unknown) =>
      pid === 4242 && (id as { value?: string } | undefined)?.value === "now";
    expect(await store(reused).withWorkerStartLock(async () => "in")).toBe("in");
  });

  test.skipIf(process.platform === "win32")(
    "t44_start_lock_stale_only_when_gone with real processes",
    async () => {
      await mkdir(storeRoot(), { recursive: true });
      const child = spawn("sleep", ["30"], { stdio: "ignore" });
      const pid = child.pid as number;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(
        join(storeRoot(), "worker-start.lock"),
        JSON.stringify({ pid, since: 0, token: "x", identity: processIdentity(pid) }),
      );
      const store = new FileStore({ root: storeRoot(), workerStartWaitMs: 300 });
      const waited = await store.withWorkerStartLock(async () => "in").catch((e: unknown) => e);
      expect((waited as KodelError).code).toBe("STATE_LOCKED");
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      expect(await store.withWorkerStartLock(async () => "in")).toBe("in");
    },
  );

  test("t44_start_lock_waiter_gives_up", async () => {
    await mkdir(storeRoot(), { recursive: true });
    const lock = join(storeRoot(), "worker-start.lock");
    const wait = async (holder: Record<string, unknown>) => {
      await writeFile(lock, JSON.stringify({ pid: 4242, since: 0, token: "x", ...holder }));
      let clock = T0;
      let asked = 0;
      const store = new FileStore({
        root: storeRoot(),
        isSame: () => {
          asked++;
          return true;
        },
        clock: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      });
      const error = (await store
        .withWorkerStartLock(async () => "in")
        .catch((e: unknown) => e)) as KodelError;
      expect(error.code).toBe("STATE_LOCKED");
      expect(clock - T0).toBeGreaterThanOrEqual(15_000);
      expect(clock - T0).toBeLessThan(16_000);
      // The file is polled every 20 ms; its holder is asked about about once a second.
      expect(asked).toBeGreaterThanOrEqual(15);
      expect(asked).toBeLessThanOrEqual(17);
      return error.message;
    };
    expect(await wait({ identity: { method: "ps-lstart", value: "then" } })).toBe(
      "another start is in progress, try again",
    );
    // A holder with no identity: alive, but not known to be the process that took it.
    const unconfirmed = await wait({});
    expect(unconfirmed).toStartWith("another start is in progress, try again (");
    expect(unconfirmed).toContain(`${lock} names pid 4242`);
  });

  test("t44_lock_order_has_no_cycle", async () => {
    await project();
    const host = newHost();
    // Another process holds `start.lock` for a moment; it never asks for `worker-start.lock`.
    const other = new FileStore({ root: storeRoot() });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = other.withStartLock(() => held);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const starting = host.withWorkerStartLock(() =>
      host.start({ pipeline: "gated", task: "ordered", restart: false }),
    );
    setTimeout(release, 100);
    const [, started] = await Promise.all([holding, starting]);
    expect(started.status).toBe("started");
  });
});
