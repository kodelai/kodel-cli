/**
 * The manager's acting tools through the real path (`invokeManagerTool` over `managerPorts`, a real host
 * and tracker, the fake launcher): what the journal records comes from the path of the call, `force`
 * goes past warnings only, and the answers are the contract's.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost, openTaskService } from "@kodel-ai/local";
import type { ManagerHost, TaskService } from "@kodel-ai/pipeline-core";
import { invokeManagerTool } from "@kodel-ai/pipeline-core/mcp";
import { managerPorts } from "../src/manager-ports";
import type { ManualServe } from "../src/manual-start";
import { FakeLauncher } from "./fake-launcher";

const pipelineText = (name: string) =>
  [
    `name: ${name}`,
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    "    prompt: write it",
    "    checks:",
    "      - { kind: command, command: 'node -e 0' }",
    "edges: []",
    "",
  ].join("\n");

let dir: string;
const made: string[] = [];
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

function repo(pipelines: string[]) {
  dir = mkdtempSync(join(tmpdir(), "kodel-mact-"));
  made.push(dir);
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  mkdirSync(join(dir, ".kodel", "pipelines"), { recursive: true });
  for (const name of pipelines) {
    writeFileSync(join(dir, ".kodel", "pipelines", `${name}.yaml`), pipelineText(name));
  }
  writeFileSync(
    join(dir, ".kodel", "config.yaml"),
    "worktree:\n  mode: off\ntasks:\n  enabled: true\n  adapters:\n    local:\n      prefix: KDL\n",
  );
  writeFileSync(join(dir, ".gitignore"), ".kodel/runs\n.kodel/worktrees\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
}

beforeEach(() => repo(["one"]));
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function tracker(): Promise<TaskService> {
  const opened = await openTaskService({ storeRoot: join(dir, ".kodel") });
  if (!opened) throw new Error("tasks are off");
  return opened.service;
}

async function seed(title: string): Promise<string> {
  const made_ = await (await tracker()).create({ title });
  if (!made_.ok) throw new Error(JSON.stringify(made_));
  return (made_.task as { key: string }).key;
}

function manager(
  launcher: FakeLauncher,
  tasks: TaskService,
  over: { platform?: string; serve?: ManualServe; keys?: boolean } = {},
): ManagerHost {
  const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0, environment: {} });
  const serve: ManualServe = over.serve ?? { max_workers: 9, max_runs: 9, start: [] };
  return {
    agentKeys: async () => ({
      start_task: over.keys !== false,
      stop_agent: over.keys !== false,
    }),
    ...managerPorts({
      root: dir,
      environment: {},
      launcher: { exec: "kodel", args: [] },
      platform: over.platform ?? "linux",
      acting: {
        // The real host fits both ports; its reads are typed loosely so the fake launcher can stand in.
        host: host as never,
        launcher: async () => launcher,
        tasks,
        serve: async () => serve,
        dialog: async () => false,
        root: dir,
        version: "0.0.0",
      },
    }),
  };
}

const call = async (host: ManagerHost, name: string, args: unknown) =>
  (await invokeManagerTool(host, name, args)) as Record<string, unknown>;

const startOf = (runId: string) => {
  const line = readFileSync(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)[0];
  if (line?.event !== "run_started") throw new Error("no run_started");
  return line;
};

describe("mstart the manager's acting tools on the real path", () => {
  test("mstart_origin_is_set_by_the_path", async () => {
    const key = await seed("Add a flag");
    const launcher = new FakeLauncher();
    const host = manager(launcher, await tracker());
    // By and via are no arguments: a call that names them is refused, whatever it says.
    const sneaky = await call(host, "manager_start_task", {
      key,
      by: "person",
      via: "web",
    });
    expect(sneaky).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(launcher.starts).toEqual([]);
    const answer = await call(host, "manager_start_task", {
      key,
      instruction: "the person asked for it",
    });
    if (answer.ok !== true || answer.started !== true) throw new Error(JSON.stringify(answer));
    expect(answer).toMatchObject({ pipeline: "one", task_key: key });
    expect(startOf(answer.run_id as string).origin).toEqual({
      by: "agent",
      via: "manager",
      agent_instruction: "the person asked for it",
    });
    expect(launcher.starts[0]?.startedBy).toEqual({ by: "agent", via: "manager" });
  }, 30_000);

  test("mstart_force_overrides_only_warnings", async () => {
    const first = await seed("First");
    const second = await seed("Second");
    const launcher = new FakeLauncher();
    const tasks = await tracker();
    const host = manager(launcher, tasks, { serve: { max_workers: 1, max_runs: 1, start: [] } });
    expect(await call(host, "manager_start_task", { key: first })).toMatchObject({
      started: true,
    });
    const full = await call(host, "manager_start_task", { key: second });
    expect(full).toMatchObject({
      ok: true,
      started: false,
      why: "full",
      counts: { runs: 1, max_runs: 1 },
    });
    expect(String(full.hint)).toContain("force");
    expect(Array.isArray(full.warnings)).toBe(true);
    const forced = await call(host, "manager_start_task", {
      key: second,
      force: true,
    });
    expect(forced).toMatchObject({ started: true, forced: ["full"] });
    // A task that has a run stays refused with `force`.
    expect(await call(host, "manager_start_task", { key: first, force: true })).toMatchObject({
      started: false,
      why: "has_run",
    });
    const closed = await seed("Closed");
    await tasks.update({ key: closed, status: "done" });
    expect(await call(host, "manager_start_task", { key: closed, force: true })).toMatchObject({
      started: false,
      why: "done",
    });
  }, 30_000);

  test("mstart_tool_answers_errors_as_the_contract_says", async () => {
    const launcher = new FakeLauncher();
    const host = manager(launcher, await tracker());
    expect(await call(host, "manager_start_task", { key: "KDL-999" })).toMatchObject({
      ok: false,
      code: "TASK_NOT_FOUND",
    });
    repo(["one", "two"]);
    const key = await seed("Pick one");
    const two = manager(launcher, await tracker());
    const asked = await call(two, "manager_start_task", { key });
    expect(asked).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENTS",
      details: { pipelines: ["one", "two"] },
    });
    expect(await call(two, "manager_start_task", { key, pipeline: "two" })).toMatchObject({
      started: true,
      pipeline: "two",
    });
  }, 30_000);

  test("mstart_stop_tool_stops_and_records", async () => {
    const key = await seed("Stop me");
    const launcher = new FakeLauncher();
    const host = manager(launcher, await tracker());
    const started = await call(host, "manager_start_task", { key });
    const runId = started.run_id as string;
    const stopped = await call(host, "manager_stop_agent", {
      run_id: runId,
      instruction: "the person said stop",
    });
    expect(stopped).toMatchObject({ ok: true, stopped: true, run_id: runId });
    expect(String(stopped.note)).toContain("TASK-9JTV");
    expect(launcher.stopVias).toEqual(["manager"]);
    expect(await call(host, "manager_stop_agent", { run_id: runId })).toMatchObject({
      ok: true,
      stopped: false,
      why: "already_stopped",
    });
  }, 30_000);

  test("mstart_tool_not_ready_on_windows", async () => {
    const key = await seed("Nowhere");
    const launcher = new FakeLauncher();
    const host = manager(launcher, await tracker(), { platform: "win32" });
    const start = await call(host, "manager_start_task", { key });
    expect(start).toMatchObject({ ok: true, started: false, why: "not_ready" });
    expect(String(start.reason)).toContain("Windows");
    const stop = await call(host, "manager_stop_agent", {
      run_id: "r_0mwwhh8jl_8hsz",
    });
    expect(stop).toMatchObject({ ok: true, stopped: false, why: "not_ready" });
    expect(launcher.starts).toEqual([]);
  });

  test("mstart_tool_refused_when_the_key_is_off", async () => {
    const key = await seed("Off");
    const launcher = new FakeLauncher();
    const host = manager(launcher, await tracker(), { keys: false });
    expect(await call(host, "manager_start_task", { key })).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENTS",
    });
    expect(launcher.starts).toEqual([]);
  });
});
