/**
 * `kodel serve` with the real `claude` (TASK-G8KM, T-44): the daemon is the real CLI process from
 * source, its workers are real background sessions, and the person decides the gate through the host,
 * as `kodel gate` does. It covers the two done-when cases of the plan in one run: a matching task is
 * started, its worker stops at the gate, the daemon resumes it after the decision in a later cycle and
 * the run finishes; and with `max_runs: 1` a second matching task starts only after the first run
 * ended. Runs outside the sandbox only (`KODEL_AGENT_TESTS=1`): it needs `claude`, the process table
 * and the API.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { PipesSessionAdapter } from "../../packages/local/src";
import {
  agentEnv,
  decideGate,
  ENABLED,
  humanHost,
  journalRecords,
  MAIN_TS,
  makeSandbox,
  REPO_ROOT,
  type Sandbox,
  TURN_TIMEOUT_MS,
} from "./harness";
import { allTasks, seedTasks, TASKS_ON } from "./tasks-harness";

const scenario = ENABLED ? test : test.skip;
const entry = join(REPO_ROOT, "packages/local/src/session-holder-entry.ts");

/** Two cheap agent steps around a gate; each check only looks at the one file the step makes. */
const TINY_PIPELINE = [
  "name: tiny",
  "description: Create one file, ask a person, create another.",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: |",
  "      Task: {{task}}",
  "      Create the file hello.txt in the repository root containing exactly the word hello.",
  "      Change nothing else.",
  "    checks:",
  '      - { kind: diff, paths: ["hello.txt"], mode: changed_only }',
  "  - slug: approve",
  "    kind: human",
  "    prompt: Is hello.txt right?",
  "  - slug: finish",
  "    kind: agent",
  "    prompt: |",
  "      Create the file done.txt in the repository root containing exactly the word done.",
  "      Change nothing else.",
  "    checks:",
  '      - { kind: diff, paths: ["done.txt"], mode: changed_only }',
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: finish }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

const SERVE_ON = [
  "serve:",
  "  enabled: true",
  "  max_workers: 1",
  "  max_runs: 1",
  "  start:",
  "    - pipeline: tiny",
  "",
].join("\n");

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

const sandboxes: Sandbox[] = [];
const daemons: ChildProcess[] = [];
const adapters: PipesSessionAdapter[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) if (d.exitCode === null) d.kill("SIGKILL");
  // Workers go on after the daemon stops: stop what is left before the folders go.
  for (const adapter of adapters.splice(0)) {
    for (const s of await adapter.list().catch(() => [])) {
      if (s.status.state === "running" || s.status.state === "starting") {
        await adapter.stop(s.id).catch(() => undefined);
      }
    }
  }
  for (const s of sandboxes.splice(0)) s.cleanup();
});

/** Polls `read` until it gives a value, or fails naming `what` and the daemon's log. */
async function until<T>(
  what: string,
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  log: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await pause(1_000);
  }
  throw new Error(`timed out waiting for ${what}; the daemon said:\n${log()}`);
}

describe("t44 kodel serve with the real claude", () => {
  scenario(
    "t44_live_serve_runs_a_task_through_a_gate",
    async () => {
      const sandbox = makeSandbox({
        fixture: { pipeline: TINY_PIPELINE },
        worktree: true,
        config: `${TASKS_ON}${SERVE_ON}`,
      });
      sandboxes.push(sandbox);
      const [first, second] = await seedTasks(sandbox, [
        {
          title: "Say hello",
          body: "Create hello.txt, then done.txt, as the steps say.",
          priority: "high",
        },
        { title: "Say hello again", body: "The same, for a second task.", priority: "normal" },
      ]);
      if (first === undefined || second === undefined) throw new Error("no tasks");
      const environment = agentEnv(sandbox.stateDir);
      const adapter = new PipesSessionAdapter({
        base: sandbox.stateDir,
        root: sandbox.dir,
        baseEnv: environment,
        holder: { exec: process.execPath, args: [entry, "holder"] },
        intermediate: { exec: process.execPath, args: [entry] },
      });
      adapters.push(adapter);

      // The daemon: the real CLI from source, as a person or a service manager starts it.
      let out = "";
      const daemon = spawn(process.execPath, [MAIN_TS, "--root", sandbox.dir, "serve"], {
        cwd: sandbox.dir,
        env: environment as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemons.push(daemon);
      daemon.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      daemon.stderr?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      const log = () => out;
      const taskOf = async (key: string) => (await allTasks(sandbox)).find((t) => t.key === key);
      const host = humanHost(sandbox);
      const statusOf = async (runId: string) => (await (await host.open(runId))?.state())?.status;
      const recordOf = async (name: string) => (await adapter.list({ name }))[0];

      // (a) The first task (the higher priority) is started, and its worker stops at the gate.
      const runA = await until(
        `a run for ${first}`,
        async () => (await taskOf(first))?.runs[0],
        60_000,
        log,
      );
      expect(log()).toContain(`started: ${first}: run ${runA}`);
      const workerA = await until(
        `the record kw-${runA}`,
        () => recordOf(`kw-${runA}`),
        30_000,
        log,
      );
      const exitedA = await adapter.wait(workerA.id, { timeoutMs: TURN_TIMEOUT_MS });
      expect(exitedA.state).toBe("exited");
      expect(journalRecords(sandbox, runA).map((r) => r.event)).toContain("gate_waiting");

      // (b) While the first run holds the one place (`max_runs: 1`), the second task is not started.
      await pause(12_000);
      expect((await taskOf(second))?.runs ?? []).toEqual([]);

      // The person approves the gate, as `kodel gate approve` does.
      expect(await decideGate(sandbox, runA, "approve", "approved")).toBe(true);

      // (a) A later cycle resumes the worker after the decision, and the run finishes.
      const resumedA = await until(
        `a resume of ${runA}`,
        async () => (await adapter.list()).find((s) => s.name?.startsWith(`kw-${runA}-d`) === true),
        60_000,
        log,
      );
      expect(log()).toContain(`resumed: run ${runA} as ${resumedA.name}`);
      await adapter.wait(resumedA.id, { timeoutMs: TURN_TIMEOUT_MS });
      expect(
        await until(
          `${runA} to complete`,
          async () => ((await statusOf(runA)) === "completed" ? true : undefined),
          60_000,
          log,
        ),
      ).toBe(true);
      const endedAt = Math.max(...journalRecords(sandbox, runA).map((r) => Number(r.ts)));

      // (b) The second task starts only now, in a cycle after the first run ended.
      const runB = await until(
        `a run for ${second}`,
        async () => (await taskOf(second))?.runs[0],
        60_000,
        log,
      );
      expect(runB).not.toBe(runA);
      const startedB = journalRecords(sandbox, runB).find((r) => r.event === "run_started");
      expect(Number(startedB?.ts)).toBeGreaterThan(endedAt);
      expect(log()).toContain(`started: ${second}: run ${runB}`);
      // Let its worker reach the gate, so nothing is left half done when the test ends.
      const workerB = await until(
        `the record kw-${runB}`,
        () => recordOf(`kw-${runB}`),
        30_000,
        log,
      );
      await adapter.wait(workerB.id, { timeoutMs: TURN_TIMEOUT_MS });

      // A signal ends the daemon cleanly.
      const exited = new Promise<number | null>((resolve) => daemon.on("exit", resolve));
      daemon.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect(log()).not.toContain("failed:");
    },
    3 * TURN_TIMEOUT_MS + 300_000,
  );
});
