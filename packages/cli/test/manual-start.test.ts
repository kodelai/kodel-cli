/**
 * The shared start by request (`startManual`) and the TUI's `s` on it, through a real host in a git
 * repository and the fake launcher: the lock, the admission inside it, `force`, the environment, the
 * pipeline from the last commit, the origin and the effect on the task.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost, openTaskService } from "@kodel-ai/local";
import { KodelError } from "@kodel-ai/pipeline-core";
import {
  type ManualServe,
  type ManualStartDeps,
  type ManualStartHost,
  type ManualStartInput,
  type ManualTask,
  startManual,
} from "../src/manual-start";
import { openTasksForTui } from "../src/tui/tasks-open";
import { createWorkerOptions } from "../src/tui/worker-start";
import { FakeLauncher } from "./fake-launcher";

const pipelineText = (name: string, prompt = "write it") =>
  [
    `name: ${name}`,
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    `    prompt: ${prompt}`,
    "    checks:",
    "      - { kind: command, command: 'node -e 0' }",
    "  - slug: approve",
    "    kind: human",
    "    prompt: ok?",
    "edges:",
    "  - { from: write, to: approve }",
    "  - { from: approve, to: write, when: rejected }",
    "",
  ].join("\n");

const config = (extra = "") =>
  `worktree:\n  mode: off\ntasks:\n  enabled: true\n  adapters:\n    local:\n      prefix: KDL\n${extra}`;

let dir: string;
const made: string[] = [];
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kodel-mstart-"));
  made.push(dir);
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  mkdirSync(join(dir, ".kodel", "pipelines"), { recursive: true });
  writeFileSync(join(dir, ".kodel", "pipelines", "one.yaml"), pipelineText("one"));
  writeFileSync(join(dir, ".kodel", "config.yaml"), config());
  writeFileSync(join(dir, ".gitignore"), ".kodel/runs\n.kodel/worktrees\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const storeRoot = () => join(dir, ".kodel");
const host = (extra: Partial<ConstructorParameters<typeof LocalPipelineHost>[0]> = {}) =>
  new LocalPipelineHost({ root: dir, heartbeatMs: 0, environment: {}, ...extra });

async function service() {
  const opened = await openTaskService({ storeRoot: storeRoot() });
  if (!opened) throw new Error("tasks are off");
  return opened.service;
}

async function seed(input: Record<string, unknown> = {}): Promise<string> {
  const made_ = await (await service()).create({ title: "Add a flag", ...input });
  if (!made_.ok) throw new Error(JSON.stringify(made_));
  return (made_.task as { key: string }).key;
}

type TaskShape = {
  key: string;
  title: string;
  status: string;
  state: "todo" | "progress" | "done";
  body?: string;
  runs: string[];
  depends_on?: string[];
  dependencies?: { key: string; state: "open" | "done" | "declined" | "missing" }[];
  conflicts_with?: string[];
  agent_edited_at?: string;
  approved_at?: string;
  comments?: { text: string }[];
};

async function taskOf(key: string): Promise<TaskShape> {
  const read = await (await service()).get({ key });
  if (!read.ok) throw new Error("no task");
  return read.task as TaskShape;
}

/** What the manager's and the web's server give: the task read from the service, nothing about approval. */
const readTask = async (key: string): Promise<ManualTask> => {
  const read = await (await service()).get({ key });
  if (!read.ok) return { status: "missing" };
  const t = read.task as TaskShape;
  return {
    status: "ready",
    title: t.title,
    text: t.body === undefined ? t.title : `${t.title}\n\n${t.body}`,
    view: {
      key: t.key,
      title: t.title,
      status: t.status,
      state: t.state,
      started_runs: t.runs.length,
      ...(t.depends_on === undefined ? {} : { depends_on: t.depends_on }),
      ...(t.dependencies === undefined ? {} : { dependencies: t.dependencies }),
      ...(t.conflicts_with === undefined ? {} : { conflicts_with: t.conflicts_with }),
    },
  };
};

const unlimited: ManualServe = { max_workers: 9, max_runs: 9, start: [] };

function deps(
  h: ManualStartHost,
  launcher: FakeLauncher,
  over: Partial<ManualStartDeps> = {},
): ManualStartDeps {
  return {
    host: h,
    launcher,
    readTask,
    serve: async () => unlimited,
    caller: { name: "test", version: "0.0.0" },
    dialog: false,
    root: dir,
    ...over,
  };
}

const asManual = (h: LocalPipelineHost) => h as unknown as ManualStartHost;
const manager = (key: string, over: Partial<ManualStartInput> = {}): ManualStartInput => ({
  key,
  by: "agent",
  via: "manager",
  ...over,
});

const journalOf = (runId: string) =>
  readFileSync(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const startedEvent = (runId: string) => {
  const first = journalOf(runId)[0];
  if (first?.event !== "run_started") throw new Error("no run_started");
  return first;
};

describe("mstart the start under the lock", () => {
  test("mstart_start_needs_no_daemon", async () => {
    const key = await seed();
    const launcher = new FakeLauncher();
    const h = host();
    const result = await startManual(
      deps(asManual(h), launcher),
      manager(key, { agentInstruction: "the person asked for it" }),
    );
    if (result.status !== "started") throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ pipeline: "one", task_key: key });
    expect(result.forced).toBeUndefined();
    expect(launcher.starts).toEqual([
      {
        runId: result.run_id,
        workdir: dir,
        title: "Add a flag",
        startedBy: { by: "agent", via: "manager" },
      },
    ]);
    expect(await h.runSummaries()).toHaveLength(1);
    expect(startedEvent(result.run_id).origin).toEqual({
      by: "agent",
      via: "manager",
      agent_instruction: "the person asked for it",
    });
  }, 30_000);

  test("mstart_start_refuses_without_lock", async () => {
    const key = await seed();
    const launcher = new FakeLauncher();
    const h = host();
    const noLock = { ...asManual(h), withWorkerStartLock: undefined } as unknown as ManualStartHost;
    // Bound methods: the object spread loses the prototype, so the calls are bound to the host.
    for (const name of ["list", "taskLink", "start", "open", "runSummaries"] as const) {
      (noLock as unknown as Record<string, unknown>)[name] = (
        h[name as "list"] as (...a: unknown[]) => unknown
      ).bind(h);
    }
    const result = await startManual(deps(noLock, launcher), manager(key));
    expect(result).toMatchObject({ status: "refused", why: "not_ready" });
    expect(launcher.starts).toEqual([]);
    expect(await h.runSummaries()).toEqual([]);
  });

  test("mstart_lock_busy_answers_retry", async () => {
    const key = await seed();
    const launcher = new FakeLauncher();
    const h = host({ workerStartLock: { workerStartWaitMs: 50 } });
    let release: () => void = () => undefined;
    const held = h.withWorkerStartLock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise((r) => setTimeout(r, 20));
    const other = host({ workerStartLock: { workerStartWaitMs: 50 } });
    const result = await startManual(deps(asManual(other), launcher), manager(key));
    release();
    await held;
    expect(result).toMatchObject({ status: "refused", why: "not_ready", retry: true });
    expect(launcher.starts).toEqual([]);
  }, 30_000);

  test("mstart_agent_failed_answers_run_id", async () => {
    const key = await seed();
    const launcher = new FakeLauncher();
    launcher.failStart = new Error("no terminal");
    const h = host();
    const result = await startManual(deps(asManual(h), launcher), manager(key, { force: true }));
    if (result.status !== "refused") throw new Error(JSON.stringify(result));
    expect(result.why).toBe("agent_failed");
    const [summary] = await h.runSummaries();
    expect(result.run_id).toBe(summary?.meta.runId);
    expect(result.hint).toContain("pipeline_next_step");
    // The run holds the task now: a second start is `has_run`, which `force` does not go past.
    launcher.failStart = undefined;
    const again = await startManual(deps(asManual(h), launcher), manager(key, { force: true }));
    expect(again).toMatchObject({ status: "refused", why: "has_run", run_id: result.run_id });
  }, 30_000);

  test("mstart_parallel_start_runs_once", async () => {
    const key = await seed();
    const launcher = new FakeLauncher();
    const h = host();
    // Both attempts are at the lock before either takes it: the race the lock has to settle.
    let arrived = 0;
    let open: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      open = resolve;
    });
    const racing = {
      list: () => h.list(),
      taskLink: () => h.taskLink(),
      start: (i: Parameters<ManualStartHost["start"]>[0]) => h.start(i),
      open: (id: string) => h.open(id),
      runSummaries: () => h.runSummaries(),
      foreignRootOf: (m: Parameters<LocalPipelineHost["foreignRootOf"]>[0]) => h.foreignRootOf(m),
      withWorkerStartLock: async <T>(fn: () => Promise<T>): Promise<T> => {
        arrived += 1;
        if (arrived === 2) open();
        await barrier;
        return h.withWorkerStartLock(fn);
      },
    } as unknown as ManualStartHost;
    const results = await Promise.all([
      startManual(deps(racing, launcher), manager(key)),
      startManual(deps(racing, launcher), manager(key)),
    ]);
    expect(results.filter((r) => r.status === "started")).toHaveLength(1);
    const refused = results.find((r) => r.status === "refused");
    expect(refused).toMatchObject({ why: "has_run" });
    expect(launcher.starts).toHaveLength(1);
    expect(await h.runSummaries()).toHaveLength(1);
  }, 30_000);
});

describe("mstart limits, links and force", () => {
  test("mstart_start_obeys_limits", async () => {
    const first = await seed({ title: "First" });
    const second = await seed({ title: "Second" });
    const launcher = new FakeLauncher();
    const h = host();
    const one: ManualServe = { max_workers: 1, max_runs: 1, start: [] };
    const d = deps(asManual(h), launcher, { serve: async () => one });
    expect((await startManual(d, manager(first))).status).toBe("started");
    const full = await startManual(d, manager(second));
    if (full.status !== "refused") throw new Error(JSON.stringify(full));
    expect(full.why).toBe("full");
    expect(full.reason).toContain("serve.max_runs");
    expect(full.counts).toEqual({ runs: 1, max_runs: 1, workers: 1, max_workers: 1 });
    expect(full.hint).toContain("force");
    expect(launcher.starts).toHaveLength(1);
  }, 30_000);

  test("mstart_force_overrides_limits", async () => {
    const first = await seed({ title: "First" });
    const second = await seed({ title: "Second" });
    const launcher = new FakeLauncher();
    const h = host();
    const d = deps(asManual(h), launcher, {
      serve: async () => ({ max_workers: 1, max_runs: 1, start: [] }),
    });
    await startManual(d, manager(first));
    const forced = await startManual(d, manager(second, { force: true }));
    if (forced.status !== "started") throw new Error(JSON.stringify(forced));
    expect(forced.forced).toEqual(["full"]);
    expect(startedEvent(forced.run_id).origin).toMatchObject({ forced: ["full"] });
  }, 30_000);

  test("mstart_links_are_warnings", async () => {
    const first = await seed({ title: "First" });
    const blocked = await seed({ title: "Waits", depends_on: [first] });
    const launcher = new FakeLauncher();
    const h = host();
    const d = deps(asManual(h), launcher);
    const refused = await startManual(d, manager(blocked));
    if (refused.status !== "refused") throw new Error(JSON.stringify(refused));
    expect(refused.why).toBe("blocked");
    expect(refused.reason).toBe(`${blocked} waits for ${first} (open)`);
    expect(refused.warnings?.map((w) => w.why)).toEqual(["blocked"]);
    expect(launcher.starts).toEqual([]);
    const forced = await startManual(d, manager(blocked, { force: ["blocked"] }));
    expect(forced).toMatchObject({ status: "started", forced: ["blocked"] });
  }, 30_000);

  test("mstart_force_overrides_only_warnings", async () => {
    const closed = await seed({ title: "Closed" });
    await (await service()).update({ key: closed, status: "done" });
    const launcher = new FakeLauncher();
    const h = host();
    const d = deps(asManual(h), launcher);
    expect(await startManual(d, manager(closed, { force: true }))).toMatchObject({
      status: "refused",
      why: "done",
    });
    // The environment is no warning either.
    const key = await seed({ title: "Open" });
    launcher.preflightResult = { ok: false, reason: "claude was not found on PATH" };
    expect(await startManual(d, manager(key, { force: true }))).toMatchObject({
      status: "refused",
      why: "not_ready",
      reason: "claude was not found on PATH",
    });
    launcher.preflightResult = { ok: true };
    const started = await startManual(d, manager(key, { force: true }));
    if (started.status !== "started") throw new Error(JSON.stringify(started));
    // With nothing to go past, `force` names nothing, and a second start is `has_run`.
    expect(started.forced).toBeUndefined();
    expect(await startManual(d, manager(key, { force: true }))).toMatchObject({ why: "has_run" });
    expect(await h.runSummaries()).toHaveLength(1);
  }, 30_000);

  test("mstart_forced_is_set_by_the_engine", async () => {
    const first = await seed({ title: "First" });
    const blocked = await seed({ title: "Waits", depends_on: [first] });
    const launcher = new FakeLauncher();
    const h = host();
    const d = deps(asManual(h), launcher, {
      serve: async () => ({ max_workers: 1, max_runs: 1, start: [] }),
    });
    // Nothing but the warnings that fired can be named: no field of the input carries `forced`.
    const input = manager(blocked, { force: true });
    expect("forced" in input).toBe(false);
    const started = await startManual(d, input);
    if (started.status !== "started") throw new Error(JSON.stringify(started));
    // The limit is not reached (no run is open), and only `blocked` fired.
    expect(startedEvent(started.run_id).origin).toEqual({
      by: "agent",
      via: "manager",
      forced: ["blocked"],
    });
  }, 30_000);

  test("mstart_unreadable_run_fails_closed", async () => {
    const key = await seed();
    const launcher = new FakeLauncher();
    const h = host();
    const made_ = await h.start({ pipeline: "one", task: "another task", restart: true });
    writeFileSync(join(dir, ".kodel", "runs", made_.run.runId, "state.json"), "{ not json");
    const result = await startManual(deps(asManual(h), launcher), manager(key, { force: true }));
    expect(result).toMatchObject({ status: "refused", why: "has_run" });
    expect(launcher.starts).toEqual([]);
  }, 30_000);

  test("mstart_restart_after_failed_run", async () => {
    const key = await seed();
    const launcher = new FakeLauncher();
    const h = host();
    const d = deps(asManual(h), launcher);
    const first = await startManual(d, manager(key));
    if (first.status !== "started") throw new Error(JSON.stringify(first));
    const run = await h.open(first.run_id);
    await run?.cancel();
    const second = await startManual(d, manager(key));
    if (second.status !== "started") throw new Error(JSON.stringify(second));
    expect(second.run_id).not.toBe(first.run_id);
    expect(launcher.starts).toHaveLength(2);
  }, 30_000);
});

describe("mstart the environment and the pipeline", () => {
  test("mstart_preflight_claude_and_login", async () => {
    const key = await seed();
    const launcher = new FakeLauncher();
    const h = host();
    for (const reason of [
      "claude was not found on PATH",
      "claude is not signed in (claude auth status): run claude auth login",
    ]) {
      launcher.preflightResult = { ok: false, reason };
      expect(await startManual(deps(asManual(h), launcher), manager(key))).toMatchObject({
        status: "refused",
        why: "not_ready",
        reason,
      });
    }
    expect(await h.runSummaries()).toEqual([]);
  });

  test("mstart_preflight_unattended_trust", async () => {
    const key = await seed();
    const launcher = new FakeLauncher();
    const h = host();
    launcher.preflightResult = {
      ok: false,
      reason: "the folder will first ask whether it is trusted",
    };
    await startManual(deps(asManual(h), launcher), manager(key));
    await startManual(deps(asManual(h), launcher), {
      key,
      by: "person",
      via: "web",
    });
    await startManual(deps(asManual(h), launcher), { key, by: "person", via: "tui" });
    expect(launcher.preflights.map((p) => p.unattended)).toEqual([true, true, undefined]);
  });

  test("mstart_preflight_uncommitted_pipeline", async () => {
    writeFileSync(
      join(dir, ".kodel", "config.yaml"),
      config("pipeline:\n  uncommitted: working\n").replace("mode: off", "mode: auto"),
    );
    git("add", "-A");
    git("commit", "-q", "-m", "config");
    const key = await seed();
    // The file is changed and not committed.
    writeFileSync(join(dir, ".kodel", "pipelines", "one.yaml"), pipelineText("one", "do it"));
    const launcher = new FakeLauncher();
    const h = host();
    const refused = await startManual(deps(asManual(h), launcher), manager(key, { force: true }));
    expect(refused).toMatchObject({ status: "refused", why: "not_ready" });
    expect(await h.runSummaries()).toEqual([]);
    // `ask` is an answer for a person, and nobody is asked here: also `not_ready`.
    writeFileSync(
      join(dir, ".kodel", "config.yaml"),
      config("pipeline:\n  uncommitted: ask\n").replace("mode: off", "mode: auto"),
    );
    git("add", ".kodel/config.yaml");
    git("commit", "-q", "-m", "ask");
    const asked = await startManual(deps(asManual(host()), launcher), manager(key));
    expect(asked).toMatchObject({ status: "refused", why: "not_ready" });
    expect(launcher.starts).toEqual([]);
    // The committed text is what a run of `committed` gets.
    writeFileSync(
      join(dir, ".kodel", "config.yaml"),
      config("pipeline:\n  uncommitted: committed\n").replace("mode: off", "mode: auto"),
    );
    git("add", ".kodel/config.yaml");
    git("commit", "-q", "-m", "committed");
    const started = await startManual(deps(asManual(host()), launcher), manager(key));
    expect(started.status).toBe("started");
  }, 60_000);

  test("mstart_preflight_pipeline_not_in_head", async () => {
    writeFileSync(join(dir, ".kodel", "config.yaml"), config().replace("mode: off", "mode: auto"));
    git("add", "-A");
    git("commit", "-q", "-m", "config");
    writeFileSync(join(dir, ".kodel", "pipelines", "fresh.yaml"), pipelineText("fresh"));
    const key = await seed();
    const launcher = new FakeLauncher();
    const h = host();
    const refused = await startManual(
      deps(asManual(h), launcher),
      manager(key, { pipeline: "fresh", force: true }),
    );
    expect(refused).toMatchObject({ status: "refused", why: "not_ready" });
    if (refused.status === "refused") expect(refused.reason).toContain("not in the last commit");
    expect(await h.runSummaries()).toEqual([]);
    expect(launcher.starts).toEqual([]);
  }, 60_000);

  test("mstart_preflight_pipeline_off_mode_needs_head", async () => {
    // worktree.mode is off (the fixture's default): the run would work in the working copy.
    const key = await seed();
    writeFileSync(join(dir, ".kodel", "pipelines", "fresh.yaml"), pipelineText("fresh"));
    const launcher = new FakeLauncher();
    const h = host();
    const notInHead = await startManual(
      deps(asManual(h), launcher),
      manager(key, { pipeline: "fresh", force: true }),
    );
    expect(notInHead).toMatchObject({ status: "refused", why: "not_ready" });
    // A changed file is refused too, whatever pipeline.uncommitted says.
    writeFileSync(join(dir, ".kodel", "pipelines", "one.yaml"), pipelineText("one", "changed"));
    const changed = await startManual(
      deps(asManual(host()), launcher),
      manager(key, { pipeline: "one" }),
    );
    expect(changed).toMatchObject({ status: "refused", why: "not_ready" });
    expect(await h.runSummaries()).toEqual([]);
    expect(launcher.starts).toEqual([]);
    // The file the last commit has is fine.
    git("add", "-A");
    git("commit", "-q", "-m", "commit pipelines");
    const started = await startManual(
      deps(asManual(host()), launcher),
      manager(key, { pipeline: "one" }),
    );
    expect(started.status).toBe("started");
  }, 60_000);

  test("mstart_start_uses_committed_pipeline", async () => {
    writeFileSync(
      join(dir, ".kodel", "config.yaml"),
      config("pipeline:\n  uncommitted: committed\n").replace("mode: off", "mode: auto"),
    );
    git("add", "-A");
    git("commit", "-q", "-m", "config");
    const key = await seed();
    writeFileSync(
      join(dir, ".kodel", "pipelines", "one.yaml"),
      pipelineText("one", "NOT COMMITTED"),
    );
    const launcher = new FakeLauncher();
    const h = host();
    const started = await startManual(deps(asManual(h), launcher), manager(key));
    if (started.status !== "started") throw new Error(JSON.stringify(started));
    const workdir = launcher.starts[0]?.workdir ?? "";
    expect(workdir).not.toBe(dir);
    expect(readFileSync(join(workdir, ".kodel", "pipelines", "one.yaml"), "utf8")).not.toContain(
      "NOT COMMITTED",
    );
  }, 60_000);

  test("mstart_start_picks_pipeline", async () => {
    writeFileSync(join(dir, ".kodel", "pipelines", "two.yaml"), pipelineText("two"));
    git("add", "-A");
    git("commit", "-q", "-m", "two");
    const key = await seed();
    const launcher = new FakeLauncher();
    const h = host();
    // Two pipelines and nothing to choose by: the caller is told which there are.
    const error = await startManual(deps(asManual(h), launcher), manager(key)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(KodelError);
    expect((error as KodelError).code).toBe("INVALID_ARGUMENTS");
    expect((error as KodelError).details).toEqual({ pipelines: ["one", "two"] });
    const unknown = await startManual(
      deps(asManual(h), launcher),
      manager(key, { pipeline: "x" }),
    ).catch((e: unknown) => e);
    expect((unknown as KodelError).code).toBe("INVALID_ARGUMENTS");
    // The `serve.start` rule's pipeline.
    const ruled = await startManual(
      deps(asManual(h), launcher, {
        serve: async () => ({
          ...unlimited,
          start: [{ pipeline: "two", match: { approval: "required" } }],
        }),
      }),
      manager(key),
    );
    expect(ruled).toMatchObject({ status: "started", pipeline: "two" });
    // The only pipeline needs no name.
    rmSync(join(dir, ".kodel", "pipelines", "two.yaml"));
    const other = await seed({ title: "Other" });
    const only = await startManual(deps(asManual(host()), launcher), manager(other));
    expect(only).toMatchObject({ status: "started", pipeline: "one" });
    // A task that is not there.
    const missing = await startManual(deps(asManual(host()), launcher), manager("KDL-NOPE")).catch(
      (e: unknown) => e,
    );
    expect((missing as KodelError).code).toBe("TASK_NOT_FOUND");
  }, 60_000);
});

describe("mstart approval and the task", () => {
  test("mstart_start_ignores_approval_everywhere", async () => {
    // A task an agent edited waits for `kodel task approve`; a start by request does not ask.
    const key = await seed();
    await (await service()).update({ key, title: "Changed by an agent", by_agent: true });
    const before = await taskOf(key);
    expect(before.agent_edited_at).toBeDefined();
    expect(before.approved_at).toBeUndefined();
    const launcher = new FakeLauncher();
    const h = host();
    const started = await startManual(deps(asManual(h), launcher), manager(key));
    expect(started.status).toBe("started");
    const after = await taskOf(key);
    expect(after.agent_edited_at).toBe(before.agent_edited_at);
    expect(after.approved_at).toBeUndefined();
    // The TUI's `s` too.
    const other = await seed({ title: "Other" });
    await (await service()).update({ key: other, title: "Other, by an agent", by_agent: true });
    const opts = createWorkerOptions({
      host: h,
      tasks: await openTasksForTui(storeRoot()),
      launcher,
      dialog: false,
      root: dir,
      version: "0.0.0",
    });
    expect(await opts.prepareStart?.(other)).toEqual({ ok: true, pipelines: ["one"] });
    expect((await opts.startTask?.(other, "one"))?.ok).toBe(true);
    expect((await taskOf(other)).approved_at).toBeUndefined();
  }, 30_000);

  test("mstart_dependency_awaiting_approval_counts_done", async () => {
    const dependency = await seed({ title: "Dependency" });
    const waits = await seed({ title: "Waits", depends_on: [dependency] });
    await (await service()).update({ key: dependency, status: "done", by_agent: true });
    const launcher = new FakeLauncher();
    const h = host();
    const started = await startManual(deps(asManual(h), launcher), manager(waits));
    expect(started.status).toBe("started");
  }, 30_000);

  test("mstart_task_effect_equals_tui_start", async () => {
    const viaTui = await seed({ title: "By the TUI" });
    const viaManager = await seed({ title: "By the manager" });
    const launcher = new FakeLauncher();
    const h = host();
    const opts = createWorkerOptions({
      host: h,
      tasks: await openTasksForTui(storeRoot()),
      launcher,
      dialog: false,
      root: dir,
      version: "0.0.0",
    });
    const tui = await opts.startTask?.(viaTui, "one");
    const manual = await startManual(deps(asManual(h), launcher), manager(viaManager));
    if (manual.status !== "started" || !tui?.runId) throw new Error("not started");
    const a = await taskOf(viaTui);
    const b = await taskOf(viaManager);
    expect(b.status).toBe(a.status);
    expect(b.status).toBe("progress");
    expect(a.runs).toEqual([tui.runId]);
    expect(b.runs).toEqual([manual.run_id]);
    expect(b.comments?.length).toBe(a.comments?.length);
    expect(b.agent_edited_at).toBeUndefined();
    expect(b.approved_at).toBeUndefined();
    // The TUI's own start says who it was.
    expect(startedEvent(tui.runId).origin).toEqual({ by: "person", via: "tui" });
  }, 30_000);
});

describe("mstart the TUI question", () => {
  const options = async (h: LocalPipelineHost, launcher: FakeLauncher, serve?: ManualServe) =>
    createWorkerOptions({
      host: h,
      tasks: await openTasksForTui(storeRoot()),
      launcher,
      dialog: false,
      root: dir,
      version: "0.0.0",
      ...(serve === undefined ? {} : { serve: async () => serve }),
    });

  test("mstart_tui_override_keeps_has_run", async () => {
    const first = await seed({ title: "First" });
    const blocked = await seed({ title: "Waits", depends_on: [first] });
    const launcher = new FakeLauncher();
    const h = host();
    const opts = await options(h, launcher);
    const check = await opts.prepareStart?.(blocked);
    expect(check).toMatchObject({
      ok: true,
      warning: `${blocked} waits for ${first} (open): start it anyway?`,
    });
    // While the question stands, a run of the task is made elsewhere: "start anyway" is not for that.
    const elsewhere = await h.start({
      pipeline: "one",
      task: "Waits",
      restart: true,
      task_key: blocked,
    });
    const answer = await opts.startTask?.(blocked, "one");
    expect(answer?.ok).toBe(false);
    expect(answer?.message).toBe(`${blocked} is already started: run ${elsewhere.run.runId}.`);
    expect(launcher.starts).toEqual([]);
  }, 30_000);

  test("mstart_new_warning_inside_lock_asks_again", async () => {
    const first = await seed({ title: "First" });
    const beside = await seed({ title: "Beside", conflicts_with: [first] });
    const launcher = new FakeLauncher();
    const h = host();
    const opts = await options(h, launcher);
    expect(await opts.prepareStart?.(beside)).toEqual({ ok: true, pipelines: ["one"] });
    // The first task is started while the person looks at the question: a conflict the person did not see.
    expect((await opts.startTask?.(first, "one"))?.ok).toBe(true);
    const answer = await opts.startTask?.(beside, "one");
    expect(answer?.ok).toBe(false);
    expect(answer?.message).toContain("Press s");
    expect(launcher.starts).toHaveLength(1);
    // Asked again, the question shows it, and a yes goes past it.
    const again = await opts.prepareStart?.(beside);
    expect(again).toMatchObject({ ok: true, warning: expect.stringContaining("conflicts with") });
    expect((await opts.startTask?.(beside, "one"))?.ok).toBe(true);
    expect(launcher.starts).toHaveLength(2);
  }, 30_000);

  test("mstart_tui_limit_asks_with_the_reason", async () => {
    const first = await seed({ title: "First" });
    const second = await seed({ title: "Second" });
    const launcher = new FakeLauncher();
    const h = host();
    const opts = await options(h, launcher, { max_workers: 1, max_runs: 1, start: [] });
    expect((await opts.startTask?.(first, "one"))?.ok).toBe(true);
    const check = await opts.prepareStart?.(second);
    expect(check).toMatchObject({ ok: true });
    if (!check?.ok) throw new Error("refused");
    expect(check.warning).toContain("serve.max_runs");
    expect(check.warning).toEndWith("start it anyway?");
    expect((await opts.startTask?.(second, "one"))?.ok).toBe(true);
  }, 30_000);
});
