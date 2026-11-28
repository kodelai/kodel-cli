/**
 * The manager's reads over a real store (decision 5M9D): the inbox, the watch, and that looking
 * changes nothing. The project is made by `helpers/run-states.ts` with the real host; the reads go
 * through the manager tools of `@kodel-ai/pipeline-core/mcp`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANAGER_LIMITS,
  type ManagerHost,
  PipelineService,
  ROLE_TOOLS,
  type Task,
  type TaskSummary,
} from "@kodel-ai/pipeline-core";
import {
  HISTORY_TOOLS,
  invokeHistoryTool,
  invokeManagerTool,
  invokeTool,
  MANAGER_TOOLS,
} from "@kodel-ai/pipeline-core/mcp";
import { createManagerReads, LocalPipelineHost, type ManagerReadsOptions } from "../src";
import { askLink, makeStates, type States, snapshotAll, TASK_KEY } from "./helpers/run-states";

// biome-ignore lint/suspicious/noExplicitAny: the answers are read as loose JSON, each test names what it checks
type Loose = any;

let tmp: string;
let states: States;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "kodel-manager-")));
  states = await makeStates(tmp);
}, 60_000);
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const call = (host: ManagerHost, name: string, args: Record<string, unknown> = {}) =>
  invokeManagerTool(host, name, args) as Promise<Record<string, Loose>>;

const openTask: Task = {
  key: TASK_KEY,
  title: "close me",
  status: "in progress",
  state: "progress",
  runs: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const waiting: TaskSummary = {
  key: "KDL-NEW",
  title: "made by an agent",
  status: "todo",
  state: "todo",
  needs_approval: true,
};
const tasks: NonNullable<ManagerReadsOptions["tasks"]> = {
  list: async () => ({
    tasks: [waiting, { key: "KDL-OK", title: "a person's", status: "todo", state: "todo" }],
    truncated: false,
    problems: [],
  }),
  get: async (key) => (key === TASK_KEY ? openTask : undefined),
};

/** A clock and a timer a test drives: a sleep moves the clock and runs what the test planted. */
function fakeTime() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  let onSleep: ((count: number) => Promise<void> | void) | undefined;
  return {
    clock: () => now,
    sleeps,
    onSleep(fn: (count: number) => Promise<void> | void) {
      onSleep = fn;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
      await onSleep?.(sleeps.length);
    },
  };
}

describe("5m9d the inbox", () => {
  test("5m9d_inbox_lists_everything_that_waits_for_a_person", async () => {
    const host = states.reader({ runTaskLink: askLink });
    await host.proposePipeline({
      yaml: "name: fresh\nnodes:\n  - { slug: only, kind: agent, prompt: go }\nedges: []\n",
      summary: "a pipeline for small fixes",
    });
    const reads = createManagerReads({ host, tasks });
    const inbox = await call(reads, "manager_inbox");
    expect(inbox.ok).toBe(true);
    const items = inbox.waiting as Loose[];
    const of = (kind: string, runId?: string) =>
      items.filter((i) => i.kind === kind && (runId === undefined || i.run_id === runId));

    // A gate, with the slug and the attempt the decision names.
    expect(of("gate", states.runs.gate)).toEqual([
      expect.objectContaining({
        pipeline: "gated",
        node_slug: "approve",
        attempt: 1,
        prompt: "Looks fine?",
        command: expect.stringContaining(`kodel gate approve|reject ${states.runs.gate}`),
      }),
    ]);
    // The open run of format 1 is read through its codec like any other.
    expect(of("gate", states.runs.v1)).toEqual([
      expect.objectContaining({ node_slug: "approve", attempt: 1 }),
    ]);
    expect(of("paused", states.runs.paused)).toEqual([
      expect.objectContaining({
        node_slug: "test",
        command: `kodel resume ${states.runs.paused}`,
      }),
    ]);
    // A change of a run's pipeline: its hash, the agent's summary and what differs, as `changes show` prints.
    expect(of("pipeline_change", states.runs.change)).toEqual([
      expect.objectContaining({
        hash: states.changeHash,
        source: "proposal",
        summary: "review twice, the first pass misses things",
        changes: [{ slug: "review", changes: ["work"] }],
        command: `kodel pipeline changes apply ${states.runs.change}`,
      }),
    ]);
    expect(of("proposal")).toEqual([
      expect.objectContaining({
        name: "fresh",
        proposal: "new",
        summary: "a pipeline for small fixes",
        command: "kodel pipeline proposals apply fresh",
      }),
    ]);
    expect(of("task_approval")).toEqual([
      expect.objectContaining({ key: "KDL-NEW", command: "kodel task approve KDL-NEW" }),
    ]);
    // A finished run whose task the engine did not close (tasks.on_run.mode: ask).
    expect(of("task_open", states.runs.tasked)).toEqual([
      expect.objectContaining({
        key: TASK_KEY,
        title: "close me",
        command: expect.stringContaining(`kodel task set ${TASK_KEY}`),
      }),
    ]);
    // Nothing waits in the fork or behind the orphaned command: they are not in the inbox.
    expect(items.filter((i) => i.run_id === states.runs.fork)).toEqual([]);
    expect(items.filter((i) => i.run_id === states.runs.orphan)).toEqual([]);
    expect(inbox.off).toBeUndefined();

    // A background worker the daemon saw gone, while nobody has worked the run since.
    const fork = await host.open(states.runs.fork);
    await fork?.apply({
      type: "worker_note",
      what: "gone",
      worker: `kw-${states.runs.fork}`,
      reason: "lost",
      at: 5,
    } as never);
    const again = (await call(reads, "manager_inbox")).waiting as Loose[];
    expect(again.filter((i) => i.kind === "worker_gone")).toEqual([
      expect.objectContaining({
        run_id: states.runs.fork,
        worker: `kw-${states.runs.fork}`,
        reason: "lost",
      }),
    ]);
  }, 30_000);

  test("5m9d_inbox_and_watch_survive_runs_they_cannot_read", async () => {
    const runFile = (id: string, file: string) => join(states.root, ".kodel", "runs", id, file);
    const rewrite = async (id: string, change: (state: Loose) => Loose | string) => {
      const path = runFile(id, "state.json");
      const next = change(JSON.parse(await readFile(path, "utf8")));
      await writeFile(path, typeof next === "string" ? next : JSON.stringify(next));
    };
    // A newer format, a state that does not fit its format, a state changed outside kodel, a run of
    // another checkout, and a run from before pipelines were kept in versions.
    await rewrite(states.runs.gate, (state) => ({ ...state, v: 99 }));
    await rewrite(states.runs.paused, (state) => ({ ...state, pauses: "none" }));
    await rewrite(states.runs.change, (state) => ({ ...state, slug: "edited-by-hand" }));
    const metaOf = async (id: string) =>
      JSON.parse(await readFile(runFile(id, "meta.json"), "utf8")) as Loose;
    await writeFile(
      runFile(states.runs.fork, "meta.json"),
      JSON.stringify({ ...(await metaOf(states.runs.fork)), root: "/another/checkout" }),
    );
    await writeFile(
      runFile(states.runs.orphan, "meta.json"),
      JSON.stringify({ ...(await metaOf(states.runs.orphan)), v: 1 }),
    );

    const reads = createManagerReads({ host: states.reader() });
    const inbox = await call(reads, "manager_inbox");
    expect(inbox.ok).toBe(true);
    const items = inbox.waiting as Loose[];
    const rows = (id: string) => items.filter((i) => i.run_id === id);

    expect(rows(states.runs.gate)).toEqual([
      expect.objectContaining({
        kind: "unreadable",
        problem: "newer_format",
        message: expect.stringContaining("upgrade kodel"),
      }),
    ]);
    expect(rows(states.runs.paused)).toEqual([
      expect.objectContaining({
        kind: "unreadable",
        problem: "cannot_read",
        message: expect.stringContaining("pauses"),
      }),
    ]);
    expect(rows(states.runs.change)).toEqual([
      expect.objectContaining({ kind: "unreadable", problem: "modified" }),
    ]);
    // Another checkout's run is not shown, as in history_runs.
    expect(rows(states.runs.fork)).toEqual([]);
    // One marked row, never a failed answer.
    expect(rows(states.runs.orphan).every((row) => row.kind === "unreadable")).toBe(true);
    expect(rows(states.runs.orphan).length).toBeLessThanOrEqual(1);
    // The readable run is still answered.
    expect(rows(states.runs.v1)).toEqual([expect.objectContaining({ kind: "gate" })]);

    const watch = await call(reads, "manager_watch", {});
    expect(watch).toMatchObject({ ok: true, events: [], timed_out: true });
    // A run that cannot be read does not turn the next look into an event, or into a failure.
    expect(await call(reads, "manager_watch", { cursor: watch.cursor })).toMatchObject({
      ok: true,
      events: [],
    });
    // The format-1 run was not touched by any of it.
    expect(JSON.parse(await readFile(runFile(states.runs.v1, "state.json"), "utf8")).v).toBe(1);
  }, 30_000);
});

describe("5m9d the watch", () => {
  test("5m9d_watch_runs_on_the_hosts_clock_and_returns_on_event_timeout_cancel", async () => {
    const time = fakeTime();
    const host = states.reader();
    const reads = createManagerReads({ host, clock: time.clock, sleep: time.sleep });

    // wait_s: 0 answers at once: no timer.
    const first = await call(reads, "manager_watch", { wait_s: 0 });
    expect(first).toMatchObject({ ok: true, events: [], timed_out: true });
    expect(time.sleeps).toEqual([]);

    // Nothing happens: it returns at wait_s, after one look a second.
    const quiet = await call(reads, "manager_watch", { cursor: first.cursor, wait_s: 5 });
    expect(quiet).toMatchObject({ ok: true, events: [], timed_out: true });
    expect(time.sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);

    // An event of any run ends the wait: the person approves the gate during the third second.
    time.sleeps.length = 0;
    time.onSleep(async (count) => {
      if (count !== 3) return;
      const run = await states.reader().open(states.runs.gate);
      const decided = await run?.decideHuman("approve", "approved");
      expect(decided?.ok).toBe(true);
    });
    const moved = await call(reads, "manager_watch", { cursor: quiet.cursor, wait_s: 30 });
    expect(time.sleeps).toHaveLength(3);
    expect(moved.timed_out).toBe(false);
    expect(moved.events).toEqual([
      expect.objectContaining({
        kind: "run_moved",
        run_id: states.runs.gate,
        pipeline: "gated",
        status: "running",
        waits_for_person: false,
        steps: [{ node_slug: "ship", attempt: 1, phase: "agent" }],
      }),
    ]);
    // What happened between two calls is not lost: the cursor of the quiet answer still sees it.
    const replay = await call(reads, "manager_watch", { cursor: quiet.cursor, wait_s: 0 });
    expect(replay.events).toHaveLength(1);
    // And the newest cursor has nothing more to say.
    time.onSleep(() => undefined);
    expect(
      (await call(reads, "manager_watch", { cursor: moved.cursor, wait_s: 0 })).events,
    ).toEqual([]);

    // A proposed pipeline is an event too.
    await host.proposePipeline({
      yaml: "name: fresh\nnodes:\n  - { slug: only, kind: agent, prompt: go }\nedges: []\n",
      summary: "s",
    });
    const proposed = await call(reads, "manager_watch", { cursor: moved.cursor, wait_s: 0 });
    expect(proposed.events).toEqual([expect.objectContaining({ kind: "proposals_changed" })]);

    // The client cancels the call: the wait ends at once, with a cursor to go on from.
    time.sleeps.length = 0;
    const abort = new AbortController();
    time.onSleep((count) => {
      if (count === 2) abort.abort();
    });
    const cancelled = (await invokeManagerTool(
      reads,
      "manager_watch",
      { cursor: proposed.cursor, wait_s: 45 },
      MANAGER_TOOLS,
      abort.signal,
    )) as Record<string, Loose>;
    expect(cancelled).toMatchObject({ ok: true, events: [], cancelled: true, timed_out: false });
    expect(time.sleeps).toHaveLength(2);
    expect(typeof cancelled.cursor).toBe("string");
  }, 30_000);

  test("5m9d_watch_refuses_a_cursor_that_is_not_its_own", async () => {
    const time = fakeTime();
    const make = () =>
      createManagerReads({ host: states.reader(), clock: time.clock, sleep: time.sleep });
    const one = make();
    const cursor = (await call(one, "manager_watch", {})).cursor as string;
    expect(await call(one, "manager_watch", { cursor })).toMatchObject({ ok: true });
    // Another server, or this one started again, has no such snapshot.
    expect(await call(make(), "manager_watch", { cursor })).toMatchObject({
      ok: false,
      code: "INVALID_CURSOR",
    });
    expect(await call(one, "manager_watch", { cursor: "w000000000000-1" })).toMatchObject({
      ok: false,
      code: "INVALID_CURSOR",
    });
    // Only the newest snapshots are kept: an old cursor is refused, a call without one starts afresh.
    for (let i = 0; i < MANAGER_LIMITS.snapshots; i++) await call(one, "manager_watch", {});
    expect(await call(one, "manager_watch", { cursor })).toMatchObject({
      ok: false,
      code: "INVALID_CURSOR",
    });
    expect(await call(one, "manager_watch", {})).toMatchObject({ ok: true, events: [] });
  }, 30_000);

  test("5m9d_watch_does_not_read_ended_runs_or_hold_the_server", async () => {
    // 200 ended runs and one that goes: after the first look no ended run's state is read again.
    const ids = Array.from(
      { length: 201 },
      (_, i) => `r_0aaaaaa${String(i).padStart(3, "0")}_abcd`,
    );
    const live = ids[200] as string;
    const stateReads: string[] = [];
    let liveAttempt = 1;
    const fake = {
      foreignRootOf: () => undefined,
      historyRedact: (text: string) => text,
      pipelineProposals: async () => [],
      pipelineProposal: async () => undefined,
      open: async () => undefined,
      historyRun: async () => undefined,
      runSummaries: async (options: { skip?: (runId: string) => boolean } = {}) =>
        ids.map((runId) => {
          const meta = { runId, pipeline: "demo", task: "t", createdAt: 1 } as Loose;
          if (options.skip?.(runId) === true) return { meta, state: undefined, skipped: true };
          stateReads.push(runId);
          const going = runId === live;
          return {
            meta,
            state: {
              status: going ? "running" : "completed",
              active: going ? [{ node: "write", attempt: liveAttempt, phase: "agent" }] : [],
              pauses: [],
            } as Loose,
          };
        }),
    } as unknown as ManagerReadsOptions["host"];
    const time = fakeTime();
    const reads = createManagerReads({ host: fake, clock: time.clock, sleep: time.sleep });
    const first = await call(reads, "manager_watch", {});
    expect(stateReads).toHaveLength(201);
    stateReads.length = 0;

    // While a watch is open another call is answered: the watch only awaits its timer.
    let other: Record<string, Loose> | undefined;
    time.onSleep(async (count) => {
      if (count === 1) other = await call(reads, "manager_inbox");
      if (count === 4) liveAttempt = 2;
    });
    const moved = await call(reads, "manager_watch", { cursor: first.cursor, wait_s: 40 });
    expect(other).toMatchObject({ ok: true });
    expect(moved.events).toEqual([expect.objectContaining({ kind: "run_moved", run_id: live })]);
    // Five looks of the watch read the one open run each, and no ended one; the inbox read every
    // state once, by its own call.
    expect(stateReads.filter((id) => id === live)).toHaveLength(6);
    expect(stateReads.filter((id) => id !== live)).toHaveLength(200);
  }, 30_000);
});

describe("5m9d reading changes nothing", () => {
  test("5m9d_manager_read_tools_only_read", async () => {
    const host = states.reader({ runTaskLink: askLink });
    const reads = createManagerReads({ host, tasks });
    const service = new PipelineService(host);
    const before = await snapshotAll(tmp);

    const answers: Record<string, Loose>[] = [];
    answers.push(await call(reads, "manager_inbox"));
    const cursor = (await call(reads, "manager_watch", {})).cursor as string;
    answers.push(await call(reads, "manager_watch", { cursor }));
    for (const runId of Object.values(states.runs)) {
      answers.push(await call(reads, "manager_run_report", { run_id: runId }));
      answers.push(await call(reads, "manager_gate_changes", { run_id: runId }));
      // The reads a `--read-only` server has besides: the pipelines and the history.
      await invokeTool(service, "pipeline_resolve", { pipeline: "gated", run_id: runId });
      for (const tool of HISTORY_TOOLS) {
        await invokeHistoryTool(service, tool.name, {
          ...(tool.name === "history_stats" ? { pipeline: "gated" } : {}),
          ...(tool.name === "history_run_details" || tool.name === "history_agent_log"
            ? { run_id: runId }
            : {}),
          ...(tool.name === "history_agent_log" ? { node: "write", attempt: 1 } : {}),
        });
      }
    }
    await invokeTool(service, "pipeline_list", {});
    await invokeTool(service, "pipeline_docs", {});
    await invokeTool(service, "pipeline_plan", { pipeline: "gated", task: "x" });
    expect(answers.every((answer) => answer.ok === true)).toBe(true);

    // The whole run folders (state, journal, served/, snapshots), the proposals, the integrity
    // records, the git refs, index and working tree: byte for byte, with their times.
    expect(await snapshotAll(tmp)).toEqual(before);
    // The orphaned work was not taken over, the claim not renewed, the format-1 run still format 1.
    const orphan = await (await host.open(states.runs.orphan))?.state();
    expect(orphan?.active[0]).toMatchObject({ node: "slow", phase: "engine", owner: "ghost:1" });
    const v1 = JSON.parse(
      await readFile(join(states.root, ".kodel", "runs", states.runs.v1, "state.json"), "utf8"),
    );
    expect(v1.v).toBe(1);

    // The run report names what the history knows, and the changes say why when they cannot be told.
    const report = await call(reads, "manager_run_report", { run_id: states.runs.gate });
    expect(report).toMatchObject({
      run_id: states.runs.gate,
      pipeline: "gated",
      status: "running",
      nodes: [
        { node: "write", gate: false, attempts: 1 },
        { node: "approve", gate: true, attempts: 1 },
      ],
    });
    const changes = await call(reads, "manager_gate_changes", { run_id: states.runs.gate });
    expect(changes).toMatchObject({
      kind: "changes",
      gates: [{ node_slug: "approve", attempt: 1 }],
    });
    expect(await call(reads, "manager_run_report", { run_id: "r_0zzzzzzzz_zzzz" })).toMatchObject({
      ok: false,
      code: "UNKNOWN_RUN",
    });
  }, 60_000);
});

describe("5m9d the answers of a worker", () => {
  test("5m9d_worker_done_answer_names_no_task_update", async () => {
    const served = (servedTools?: readonly string[]) =>
      new LocalPipelineHost({
        root: states.root,
        heartbeatMs: 0,
        integrityDir: states.integrityDir,
        runTaskLink: askLink,
        ...(servedTools === undefined ? {} : { servedTools }),
      });
    const done = async (host: LocalPipelineHost) => {
      const run = await host.open(states.runs.tasked);
      const step = await run?.nextStep({ serve: {} });
      return step !== undefined && "done" in step ? (step.tell_the_person ?? "") : "";
    };
    // A worker's server does not serve task_update: the person closes the task.
    const worker = await done(served(ROLE_TOOLS.worker));
    expect(worker).toContain(`task ${TASK_KEY}`);
    expect(worker).toContain("tell the person the task is still open");
    expect(worker).toContain("kodel task set");
    expect(worker).not.toContain("task_update");
    expect(worker).not.toContain("task_schema");
    // A server that serves it says what it always said.
    for (const host of [served(), served([...ROLE_TOOLS.worker, "task_update"])]) {
      const text = await done(host);
      expect(text).toContain("call task_update with the done status");
    }
  }, 30_000);
});

describe("tne3n the inbox after a cancel", () => {
  test("tne3n_inbox_does_not_list_a_canceled_run_as_waiting", async () => {
    const host = states.reader({ runTaskLink: askLink });
    const reads = createManagerReads({ host, tasks });
    const ids = [states.runs.gate, states.runs.paused, states.runs.change, states.runs.v1];
    const before = (await call(reads, "manager_inbox")).waiting as Loose[];
    // Each of them waits for a person before the cancel.
    for (const id of ids) expect(before.some((i) => i.run_id === id)).toBe(true);
    for (const id of ids) {
      const decision = await (await host.open(id))?.cancel({ reason: "not wanted" });
      expect(decision?.ok).toBe(true);
    }
    const inbox = await call(reads, "manager_inbox");
    expect(inbox.ok).toBe(true);
    const after = inbox.waiting as Loose[];
    for (const id of ids) {
      expect(
        after.filter(
          (i) =>
            i.run_id === id &&
            ["gate", "paused", "pipeline_change", "worker_gone"].includes(i.kind),
        ),
      ).toEqual([]);
    }
    // What else waits is still there.
    expect(after.some((i) => i.kind === "task_open" && i.run_id === states.runs.tasked)).toBe(true);
  }, 30_000);
});
