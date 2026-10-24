import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRunTaskLink,
  PipelineService,
  type RunState,
  type RunTaskLink,
  summarizeRun,
  type Task,
  type TaskAdapter,
  TaskService,
} from "@kodel-ai/pipeline-core";
import { registerPipelineTools } from "@kodel-ai/pipeline-core/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LocalPipelineHost, LocalTaskAdapter, openTaskService } from "../src";

let dir: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const ONE_STEP = [
  "name: demo",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: do it",
  "",
].join("\n");
const WITH_GATE = [
  "name: gated",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: do it",
  "  - slug: review",
  "    kind: human",
  "    prompt: look at it",
  "edges:",
  "  - { from: write, to: review }",
  "  - { from: review, to: write, when: rejected }",
  "",
].join("\n");

async function config(mode: string | undefined) {
  const lines = ["worktree:", "  mode: off", "tasks:", "  enabled: true"];
  if (mode !== undefined) lines.push("  on_run:", `    mode: ${mode}`);
  await writeFile(join(dir, ".kodel", "config.yaml"), `${lines.join("\n")}\n`);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-runtask-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), ONE_STEP);
  await writeFile(join(dir, ".kodel", "pipelines", "gated.yaml"), WITH_GATE);
  await config(undefined);
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const storeRoot = () => join(dir, ".kodel");

/** An MCP client on a host; `link` replaces the tie the config asks for. */
async function connect(options: { link?: RunTaskLink; taskKey?: boolean } = {}) {
  const host = new LocalPipelineHost({
    root: dir,
    heartbeatMs: 0,
    ...(options.link === undefined ? {} : { runTaskLink: options.link }),
  });
  const server = new McpServer({ name: "kodel-test", version: "0.0.0" });
  registerPipelineTools(server, new PipelineService(host, { waitBudgetMs: 10_000 }), {
    taskLink: options.taskKey !== false,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const body = JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
    return { body, isError: result.isError === true };
  };
  const tools = async () => (await client.listTools()).tools;
  return { host, call, tools, close: () => Promise.all([client.close(), server.close()]) };
}

async function tasks() {
  const opened = await openTaskService({ storeRoot: storeRoot() });
  if (!opened) throw new Error("tasks are off");
  const { service } = opened;
  const create = async (title = "a task") => {
    const made = await service.create({ title });
    if (!made.ok) throw new Error(JSON.stringify(made));
    return (made.task as Task).key;
  };
  const get = async (key: string) => {
    const got = await service.get({ key });
    if (!got.ok) throw new Error(JSON.stringify(got));
    return got.task as Task;
  };
  return { service, create, get, link: opened.runLink };
}

const stateOf = async (runId: string) =>
  JSON.parse(await readFile(join(dir, ".kodel", "runs", runId, "state.json"), "utf8")) as RunState;
const journalOf = async (runId: string) =>
  (await readFile(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { event: string; [k: string]: unknown });
const taskNotes = async (runId: string) =>
  (await journalOf(runId)).filter((r) => r.event === "task_link");

async function finish(
  c: Awaited<ReturnType<typeof connect>>,
  runId: string,
  node = "write",
): Promise<void> {
  const done = await c.call("pipeline_complete_step", {
    run_id: runId,
    node_slug: node,
    attempt: 1,
  });
  expect(done.body.ok).toBe(true);
  await (await c.host.open(runId))?.waitForRest(10_000);
}

/** The local adapter with some calls made to fail. */
function flaky(fail: { get?: boolean; update?: boolean }): TaskAdapter {
  const real = new LocalTaskAdapter({
    storeRoot: storeRoot(),
    prefix: "KDL",
    clock: Date.now,
    random: Math.random,
  });
  return new Proxy(real, {
    get(target, prop, receiver) {
      if ((prop === "get" && fail.get) || (prop === "update" && fail.update)) {
        return async () => {
          throw new Error("the tracker is down");
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("a run tied to a task", () => {
  test("run_task_auto_links_and_sets_progress_at_start", async () => {
    const t = await tasks();
    const key = await t.create();
    const c = await connect();
    const started = await c.call("pipeline_start", {
      task: "work on it",
      pipeline: "demo",
      task_key: key,
    });
    expect(started.body).toMatchObject({ ok: true, task: { key } });
    const runId = started.body.run_id as string;

    const task = await t.get(key);
    expect(task.state).toBe("progress");
    expect(task.runs).toEqual([runId]);
    expect((await stateOf(runId)).taskKey).toBe(key);
    expect((await taskNotes(runId)).map((r) => r.what)).toEqual(["linked"]);
    await c.close();
  });

  test("run_task_auto_closes_task_when_run_completes", async () => {
    const t = await tasks();
    const key = await t.create();
    const c = await connect();
    const runId = (
      await c.call("pipeline_start", { task: "work", pipeline: "demo", task_key: key })
    ).body.run_id as string;
    await finish(c, runId);

    const task = await t.get(key);
    expect(task.state).toBe("done");
    expect(task.comment).toContain(runId);
    expect((await taskNotes(runId)).map((r) => r.what)).toEqual(["linked", "closed"]);
    await c.close();
  });

  test("run_task_auto_closes_when_person_approves_the_last_gate_in_cli", async () => {
    const t = await tasks();
    const key = await t.create();
    const agent = await connect();
    const runId = (
      await agent.call("pipeline_start", { task: "gated work", pipeline: "gated", task_key: key })
    ).body.run_id as string;
    await finish(agent, runId);
    expect((await t.get(key)).state).toBe("progress");

    // The person decides in the CLI: another process, another host, no MCP.
    const cli = new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
    const run = await cli.open(runId);
    const decision = await run?.decideHuman("review", "approved");
    expect(decision?.ok).toBe(true);

    expect((await t.get(key)).state).toBe("done");
    expect((await taskNotes(runId)).map((r) => r.what)).toEqual(["linked", "closed"]);
    await agent.close();
  });

  test("run_task_canceled_run_only_comments", async () => {
    const t = await tasks();
    const key = await t.create();
    const c = await connect();
    const runId = (
      await c.call("pipeline_start", { task: "work", pipeline: "demo", task_key: key })
    ).body.run_id as string;
    await (await c.host.open(runId))?.cancel();

    const task = await t.get(key);
    expect(task.state).toBe("progress");
    expect(task.comment).toContain("canceled");
    expect((await taskNotes(runId)).map((r) => r.what)).toEqual(["linked", "commented"]);
    await c.close();
  });

  test("run_task_ask_links_at_start_and_hints_at_done_without_closing", async () => {
    await config("ask");
    const t = await tasks();
    const key = await t.create();
    const c = await connect();
    const runId = (
      await c.call("pipeline_start", { task: "work", pipeline: "demo", task_key: key })
    ).body.run_id as string;
    expect((await t.get(key)).state).toBe("progress");
    await finish(c, runId);

    expect((await t.get(key)).state).toBe("progress");
    const next = await c.call("pipeline_next_step", { run_id: runId });
    expect(next.body.next?.done ?? next.body.done).toBeDefined();
    expect(JSON.stringify(next.body)).toContain(`task ${key}`);
    expect(JSON.stringify(next.body)).toContain("task_update");
    expect((await taskNotes(runId)).map((r) => r.what)).toEqual(["linked", "hinted"]);
    await c.close();
  });

  test("run_task_disabled_has_no_task_key_and_touches_nothing", async () => {
    await config("disabled");
    const t = await tasks();
    expect(t.link).toBeUndefined();
    const key = await t.create();
    const c = await connect({ taskKey: false });
    const start = (await c.tools()).find((tool) => tool.name === "pipeline_start");
    expect(Object.keys(start?.inputSchema.properties ?? {})).not.toContain("task_key");

    // A host that is asked anyway refuses, instead of silently not tying.
    const direct = await c.host
      .start({ pipeline: "demo", task: "work", restart: false, task_key: key })
      .catch((error: { code: string }) => error);
    expect((direct as { code: string }).code).toBe("INVALID_ARGUMENTS");
    expect((await t.get(key)).state).toBe("todo");
    await c.close();
  });

  test("run_task_key_is_offered_only_when_the_server_can_tie_runs", async () => {
    const withLink = await connect();
    const offered = (await withLink.tools()).find((tool) => tool.name === "pipeline_start");
    expect(Object.keys(offered?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["task_key", "restart_task"]),
    );
    await withLink.close();
  });

  test("run_task_start_without_task_key_changes_nothing", async () => {
    const t = await tasks();
    const key = await t.create();
    const c = await connect();
    const started = await c.call("pipeline_start", { task: "plain", pipeline: "demo" });
    expect(started.body.task).toBeUndefined();
    const runId = started.body.run_id as string;
    await finish(c, runId);
    expect((await stateOf(runId)).taskKey).toBeUndefined();
    expect(await taskNotes(runId)).toEqual([]);
    expect((await t.get(key)).state).toBe("todo");
    await c.close();
  });

  test("run_task_unknown_task_fails_and_leaves_no_run", async () => {
    await tasks();
    const c = await connect();
    const started = await c.call("pipeline_start", {
      task: "work",
      pipeline: "demo",
      task_key: "KDL-ZZZZ",
    });
    expect(started.body).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
    expect(await readdir(join(dir, ".kodel", "runs")).catch(() => [])).toEqual([]);
    await c.close();
  });
});

describe("a task that is already done", () => {
  async function doneTask() {
    const t = await tasks();
    const key = await t.create();
    const c = await connect();
    const first = (
      await c.call("pipeline_start", { task: "first go", pipeline: "demo", task_key: key })
    ).body.run_id as string;
    await finish(c, first);
    expect((await t.get(key)).state).toBe("done");
    return { t, key, c, first };
  }

  test("run_task_already_done_fails_and_leaves_no_new_run", async () => {
    const { t, key, c, first } = await doneTask();
    const again = await c.call("pipeline_start", {
      task: "second go",
      pipeline: "demo",
      task_key: key,
    });
    expect(again.body).toMatchObject({ ok: false, code: "TASK_ALREADY_DONE" });
    expect(again.body.message).toContain(key);
    expect(again.body.message).toContain(first);
    expect(again.body.message).toContain("restart_task");
    expect(await readdir(join(dir, ".kodel", "runs"))).toEqual([first]);
    expect((await t.get(key)).state).toBe("done");
    await c.close();
  });

  test("run_task_restart_task_moves_back_to_progress_and_keeps_old_runs", async () => {
    const { t, key, c, first } = await doneTask();
    const again = await c.call("pipeline_start", {
      task: "second go",
      pipeline: "demo",
      task_key: key,
      restart_task: true,
    });
    expect(again.body).toMatchObject({ ok: true, task: { key, restarted: true } });
    const second = again.body.run_id as string;
    const task = await t.get(key);
    expect(task.state).toBe("progress");
    expect(task.runs).toEqual([first, second]);
    expect(task.comment).toContain(`restarted by run ${second}`);
    expect((await taskNotes(second)).map((r) => r.what)).toEqual(["restarted"]);
    // A person reading the report sees that the task had been done before.
    const report = summarizeRun(await stateOf(second), (await journalOf(second)) as never);
    expect(report.tracker_task).toEqual({ key, restarted: true });
    await c.close();
  });

  test("run_task_restart_task_starts_a_new_run_even_for_the_same_task_text", async () => {
    const { key, c, first } = await doneTask();
    const again = await c.call("pipeline_start", {
      task: "first go",
      pipeline: "demo",
      task_key: key,
      restart_task: true,
    });
    expect(again.body.ok).toBe(true);
    expect(again.body.run_id).not.toBe(first);
    expect(again.body.terminal).toBe(false);
    await c.close();
  });

  test("run_task_declined_is_blocked_like_done", async () => {
    const t = await tasks();
    const key = await t.create();
    const declined = await t.service.update({ key, status: "declined", comment: "not needed" });
    expect(declined.ok).toBe(true);
    const c = await connect();
    const started = await c.call("pipeline_start", {
      task: "work",
      pipeline: "demo",
      task_key: key,
    });
    expect(started.body).toMatchObject({ ok: false, code: "TASK_ALREADY_DONE" });
    await c.close();
  });
});

describe("a tracker that fails", () => {
  test("run_task_adapter_failure_at_start_is_a_warning_and_the_run_goes_on", async () => {
    const t = await tasks();
    const key = await t.create();
    const link = createRunTaskLink(new TaskService(flaky({ update: true })), "auto");
    const c = await connect({ link });
    const started = await c.call("pipeline_start", {
      task: "work",
      pipeline: "demo",
      task_key: key,
    });
    expect(started.body.ok).toBe(true);
    expect(started.body.task.warning).toContain("the tracker is down");
    expect(started.body.next.node.slug).toBe("write");
    const runId = started.body.run_id as string;
    expect((await taskNotes(runId)).map((r) => r.what)).toEqual(["failed"]);
    await c.close();
  });

  test("run_task_adapter_failure_at_the_end_does_not_change_how_the_run_ended", async () => {
    const t = await tasks();
    const key = await t.create();
    const ok = createRunTaskLink(new TaskService(flaky({})), "auto");
    const c1 = await connect({ link: ok });
    const runId = (
      await c1.call("pipeline_start", { task: "work", pipeline: "demo", task_key: key })
    ).body.run_id as string;
    await c1.close();

    const down = createRunTaskLink(new TaskService(flaky({ get: true })), "auto");
    const c2 = await connect({ link: down });
    await finish(c2, runId);
    expect((await stateOf(runId)).status).toBe("completed");
    expect((await t.get(key)).state).toBe("progress");
    const notes = await taskNotes(runId);
    expect(notes.at(-1)).toMatchObject({ what: "failed" });
    expect(String(notes.at(-1)?.note)).toContain("the tracker is down");
    await c2.close();
  });
});

describe("how the end of a run is told to the task", () => {
  test("run_task_the_tracker_is_called_outside_the_lock_and_the_run_stays_sealed", async () => {
    const t = await tasks();
    const key = await t.create();
    const real = createRunTaskLink(t.service, "auto");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const inEnd = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const slow: RunTaskLink = {
      mode: real.mode,
      prepare: real.prepare,
      begin: real.begin,
      end: async (...args) => {
        reached();
        await gate;
        return real.end(...args);
      },
    };
    const c = await connect({ link: slow });
    const runId = (
      await c.call("pipeline_start", { task: "work", pipeline: "demo", task_key: key })
    ).body.run_id as string;
    const completing = c.call("pipeline_complete_step", {
      run_id: runId,
      node_slug: "write",
      attempt: 1,
    });
    await inEnd;

    // The tracker is still busy, and the run is already over, sealed and free for other readers.
    const run = await c.host.open(runId);
    expect((await run?.state())?.status).toBe("completed");
    expect(await run?.sealStatus()).toBe("sealed");
    expect((await t.get(key)).state).toBe("progress");

    release();
    await completing;
    expect((await t.get(key)).state).toBe("done");
    expect((await taskNotes(runId)).map((r) => r.what)).toEqual(["linked", "closed"]);
    expect(await run?.sealStatus()).toBe("sealed");
    expect(await run?.integrityStatus()).toBe("ok");
    await c.close();
  });
});

describe("starting with a task key", () => {
  test("run_task_restart_task_without_task_key_is_refused_and_forces_nothing", async () => {
    const c = await connect();
    const first = (await c.call("pipeline_start", { task: "same text", pipeline: "demo" })).body
      .run_id as string;
    await finish(c, first);
    const refused = await c.call("pipeline_start", {
      task: "same text",
      pipeline: "demo",
      restart_task: true,
    });
    expect(refused.body).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(await readdir(join(dir, ".kodel", "runs"))).toEqual([first]);
    await c.close();
  });

  test("run_task_a_run_that_was_already_there_is_not_reported_as_tied", async () => {
    const t = await tasks();
    const key = await t.create();
    const other = await t.create("another");
    const c = await connect();
    const first = await c.call("pipeline_start", {
      task: "same text",
      pipeline: "demo",
      task_key: key,
    });
    const again = await c.call("pipeline_start", {
      task: "same text",
      pipeline: "demo",
      task_key: other,
    });
    expect(again.body.reused).toBe(true);
    expect(again.body.task.warning).toContain("was not tied");
    expect((await t.get(other)).runs).toEqual([]);
    expect((await t.get(other)).state).toBe("todo");
    expect((await stateOf(first.body.run_id)).taskKey).toBe(key);
    await c.close();
  });

  test("run_task_a_restart_is_marked_in_the_report_even_when_the_tracker_failed", async () => {
    const t = await tasks();
    const key = await t.create();
    const c1 = await connect();
    const first = (await c1.call("pipeline_start", { task: "go", pipeline: "demo", task_key: key }))
      .body.run_id as string;
    await finish(c1, first);
    await c1.close();

    const link = createRunTaskLink(new TaskService(flaky({ update: true })), "auto");
    const c2 = await connect({ link });
    const again = await c2.call("pipeline_start", {
      task: "go again",
      pipeline: "demo",
      task_key: key,
      restart_task: true,
    });
    expect(again.body.ok).toBe(true);
    const second = again.body.run_id as string;
    expect((await taskNotes(second)).map((r) => r.what)).toEqual(["failed"]);
    const report = summarizeRun(await stateOf(second), (await journalOf(second)) as never);
    expect(report.tracker_task).toEqual({ key, restarted: true });
    await c2.close();
  });
});
