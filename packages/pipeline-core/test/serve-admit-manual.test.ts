/**
 * The admission of a start by hand (the manager, the web UI, the TUI): the same rule as the daemon's
 * `admitStart`, in the mode that reads no approval, counts only an open run as the task's run, and keeps
 * what only warns (the limits, the links) apart from what no one gets past (a closed task, an open run).
 * The daemon's own mode is pinned here too, so the new mode cannot change it.
 */
import { describe, expect, test } from "bun:test";
import type { DependencyRef } from "../src";
import {
  admitStart,
  giveUpComment,
  type ServeRunView,
  type ServeTaskView,
  type ServeUnreadableRun,
  type ServeWorkerView,
} from "../src/serve";

const LIMITS = { max_workers: 1, max_runs: 1 };

const task = (key: string, over: Partial<ServeTaskView> = {}): ServeTaskView => ({
  key,
  title: key,
  status: "todo",
  state: "todo",
  started_runs: 0,
  ...over,
});

const run = (runId: string, over: Partial<ServeRunView> = {}): ServeRunView => ({
  runId,
  status: "running",
  canNote: true,
  waitsForPerson: false,
  noted: [],
  ...over,
});

const worker = (runId: string, over: Partial<ServeWorkerView> = {}): ServeWorkerView => ({
  id: `a_${runId}`,
  name: `kw-${runId}`,
  state: "running",
  label: "running",
  started: 0,
  sessionId: "s-1",
  resumed: [],
  resumes: 0,
  ...over,
});

const dep = (key: string, state: DependencyRef["state"], waits = false): DependencyRef =>
  waits ? { key, state, needs_approval: true } : { key, state };

const waitingOn = (key: string, on: DependencyRef[], over: Partial<ServeTaskView> = {}) =>
  task(key, { depends_on: on.map((d) => d.key), dependencies: on, ...over });

const manual = (input: Omit<Parameters<typeof admitStart>[0], "mode">) =>
  admitStart({ ...input, mode: "manual" } as Parameters<typeof admitStart>[0] & {
    mode: "manual";
  });

describe("mstart admission by hand", () => {
  test("t44_mstart_parallel_start_runs_once", () => {
    // Both attempts read the state before either wrote; what the second reads under the lock is the
    // first's run, and that is a refusal no `force` passes.
    expect(manual({ task: task("T-1"), runs: [] })).toEqual({ ok: true, warnings: [] });
    const after = [run("r_1", { taskKey: "T-1" })];
    expect(manual({ task: task("T-1"), runs: after })).toEqual({
      ok: false,
      why: "has_run",
      run: "r_1",
    });
  });

  test("t44_mstart_start_obeys_limits", () => {
    // A live agent at a gate holds the place, as it does for the daemon.
    const held = [run("r_1", { taskKey: "T-X", worker: worker("r_1") })];
    const full = manual({ task: task("T-1"), runs: held, limits: LIMITS });
    expect(full).toEqual({
      ok: true,
      warnings: [
        {
          why: "full",
          limit: "max_runs",
          counts: { runs: 1, max_runs: 1, workers: 1, max_workers: 1 },
        },
      ],
    });
    // Room: no warning. Without limits given none is made.
    expect(
      manual({ task: task("T-1"), runs: held, limits: { max_workers: 2, max_runs: 2 } }),
    ).toEqual({ ok: true, warnings: [] });
    expect(manual({ task: task("T-1"), runs: held })).toEqual({ ok: true, warnings: [] });
    // Only the agents are full: the worker limit is the one named.
    const workers = manual({
      task: task("T-1"),
      runs: held,
      limits: { max_workers: 1, max_runs: 2 },
    });
    expect(workers).toMatchObject({ warnings: [{ why: "full", limit: "max_workers" }] });
    // An agent that stopped while working frees its places, so it is not counted.
    const stopped = [
      run("r_2", { taskKey: "T-Y", worker: worker("r_2", { state: "killed", label: "stopped" }) }),
    ];
    expect(manual({ task: task("T-1"), runs: stopped, limits: LIMITS })).toEqual({
      ok: true,
      warnings: [],
    });
  });

  test("t44_mstart_links_are_warnings", () => {
    const blocked = waitingOn("T-1", [dep("T-D", "open")]);
    const answer = manual({ task: blocked, runs: [] });
    expect(answer).toMatchObject({ ok: true, warnings: [{ why: "blocked" }] });
    const conflicting = task("T-2", { conflicts_with: ["T-3"] });
    const withRun = manual({ task: conflicting, runs: [run("r_3", { taskKey: "T-3" })] });
    expect(withRun).toMatchObject({ ok: true, warnings: [{ why: "conflict" }] });
    // All the warnings are listed, links first, then the limits.
    const everything = manual({
      task: waitingOn("T-4", [dep("T-D", "open")], { conflicts_with: ["T-3"] }),
      runs: [run("r_3", { taskKey: "T-3", worker: worker("r_3") })],
      limits: LIMITS,
    });
    expect(everything).toMatchObject({ ok: true });
    if (everything.ok) expect(everything.warnings.map((w) => w.why)).toEqual(["blocked", "full"]);
  });

  test("t44_mstart_tui_override_keeps_has_run", () => {
    // Warnings come with an open run too, but the refusal is the answer: nothing is overridden.
    const answer = manual({
      task: waitingOn("T-1", [dep("T-D", "open")]),
      runs: [run("r_1", { taskKey: "T-1", status: "paused" })],
      limits: LIMITS,
    });
    expect(answer).toEqual({ ok: false, why: "has_run", run: "r_1" });
    expect(manual({ task: task("T-1", { state: "done", status: "done" }), runs: [] })).toEqual({
      ok: false,
      why: "done",
    });
  });

  test("t44_mstart_unreadable_run_fails_closed", () => {
    const broken: ServeUnreadableRun = {
      runId: "r_9",
      why: "cannot_read",
      detail: "cannot read: x",
      worker: worker("r_9", { state: "exited", label: "exited (0)" }),
    };
    expect(manual({ task: task("T-1"), runs: [], unreadable: [broken] })).toEqual({
      ok: false,
      why: "has_run",
      run: "r_9",
    });
    // One with no worker record is as closed.
    expect(manual({ task: task("T-1"), runs: [], unreadable_open: ["r_8"] })).toEqual({
      ok: false,
      why: "has_run",
      run: "r_8",
    });
  });

  test("t44_mstart_restart_after_failed_run", () => {
    // A task in progress whose run failed, ended or was canceled starts again; the tracker's run count and
    // the older runs of its key do not hold it.
    const ended = ["failed", "completed", "canceled"].map((status, i) =>
      run(`r_${i}`, { taskKey: "T-1", status: status as ServeRunView["status"] }),
    );
    const again = task("T-1", { state: "progress", status: "progress", started_runs: 2 });
    expect(manual({ task: again, runs: ended })).toEqual({ ok: true, warnings: [] });
    // A run of another checkout does not hold it either, but it still holds a conflicting neighbour.
    const foreign = run("r_f", { taskKey: "T-1", foreign: true });
    expect(manual({ task: task("T-1"), runs: [foreign] })).toEqual({ ok: true, warnings: [] });
    expect(
      manual({ task: task("T-2", { conflicts_with: ["T-1"] }), runs: [foreign] }),
    ).toMatchObject({ warnings: [{ why: "conflict" }] });
    // A give-up comment of the daemon does not stop a start by hand.
    expect(
      manual({ task: task("T-1", { comment: giveUpComment("dev", "no git") }), runs: [] }),
    ).toEqual({ ok: true, warnings: [] });
  });

  test("t44_mstart_daemon_admit_unchanged", () => {
    const limits = { max_workers: 64, max_runs: 64 };
    const ended = [run("r_1", { taskKey: "T-NAMED", status: "completed" })];
    // An ended run of the task still holds it for the daemon, as does the tracker's count.
    expect(admitStart({ task: task("T-NAMED"), runs: ended, limits })).toEqual({
      ok: false,
      why: "has_run",
    });
    expect(admitStart({ task: task("T-T", { started_runs: 1 }), runs: [], limits })).toEqual({
      ok: false,
      why: "has_run",
    });
    expect(
      admitStart({
        task: task("T-P", { state: "progress", status: "progress" }),
        runs: [],
        limits,
      }),
    ).toEqual({ ok: false, why: "not_todo" });
    expect(
      admitStart({ task: task("T-G", { comment: giveUpComment("dev", "no git") }), runs: [] }),
    ).toEqual({ ok: false, why: "gave_up" });
    // `mode: "daemon"` is the same as none.
    expect(admitStart({ task: task("T-1"), runs: [], mode: "daemon", limits })).toEqual({
      ok: true,
    });
  });

  test("t44_mstart_dependency_awaiting_approval_counts_done", () => {
    const awaiting = waitingOn("T-1", [dep("T-D", "done", true)]);
    // By hand it is done; for the daemon, under `approval: required`, it still holds the task back.
    expect(manual({ task: awaiting, runs: [] })).toEqual({ ok: true, warnings: [] });
    expect(admitStart({ task: awaiting, runs: [], approval: "required" })).toMatchObject({
      ok: false,
      why: "blocked",
    });
    // An open or missing dependency is still a warning by hand.
    expect(manual({ task: waitingOn("T-2", [dep("T-D", "missing")]), runs: [] })).toMatchObject({
      warnings: [{ why: "blocked" }],
    });
  });

  test("t44_mstart_start_ignores_approval_everywhere", () => {
    // Admission by hand reads no approval: a task that waits for `task approve` is admitted.
    expect(manual({ task: task("T-A", { needs_approval: true }), runs: [] })).toEqual({
      ok: true,
      warnings: [],
    });
  });

  test("t44_mstart_daemon_still_needs_approval", () => {
    const agentTask = task("T-A", { needs_approval: true });
    expect(admitStart({ task: agentTask, runs: [] })).toEqual({ ok: false, why: "not_approved" });
    expect(admitStart({ task: agentTask, runs: [], approval: "required" })).toEqual({
      ok: false,
      why: "not_approved",
    });
    expect(admitStart({ task: agentTask, runs: [], approval: "any" })).toEqual({ ok: true });
  });
});
