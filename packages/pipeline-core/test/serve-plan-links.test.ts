/**
 * Task links in the plan of `kodel serve` (TASK-9RZD, T-45 and T-46): a task whose dependency is open,
 * or closed and not approved, or whose conflicting task has an open run, is not started; the others
 * go in the base order. Kept apart from `serve-plan.test.ts`, whose cases stay as they are.
 */
import { describe, expect, test } from "bun:test";
import type { DependencyRef } from "../src";
import {
  type Admission,
  admitStart,
  decisionOf,
  giveUpComment,
  planServe,
  type ServeAction,
  type ServeInput,
  type ServeMemory,
  type ServeRules,
  type ServeRunView,
  type ServeTaskView,
  type ServeWorkerView,
} from "../src/serve";

const NOW = 10_000_000;
const PRIORITIES = ["high", "normal", "low"];

const rules = (over: Partial<ServeRules> = {}): ServeRules => ({
  enabled: true,
  max_workers: 4,
  max_runs: 4,
  stalled_after_s: 1800,
  start: [{ pipeline: "dev", match: { approval: "required" } }],
  ...over,
});

const memory = (over: Partial<ServeMemory> = {}): ServeMemory => ({
  attempts: {},
  mine: [],
  dead_in_a_row: 0,
  logged: [],
  unlaunched: [],
  ...over,
});

const dep = (key: string, state: DependencyRef["state"], waits = false): DependencyRef =>
  waits ? { key, state, needs_approval: true } : { key, state };

const task = (key: string, over: Partial<ServeTaskView> = {}): ServeTaskView => ({
  key,
  title: key,
  status: "todo",
  state: "todo",
  priority: "normal",
  started_runs: 0,
  ...over,
});

/** A task that waits for others, each in the state given. */
const waiting = (key: string, on: DependencyRef[], over: Partial<ServeTaskView> = {}) =>
  task(key, { depends_on: on.map((d) => d.key), dependencies: on, ...over });

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

const input = (list: ServeTaskView[], over: Partial<ServeInput> = {}): ServeInput => ({
  now: NOW,
  rules: rules(),
  runs: [],
  memory: memory(),
  unreadable: [],
  quietFrom: 0,
  tasks: { list, complete: true, priorities: PRIORITIES },
  environment: { ok: true },
  ...over,
});

const startsOf = (actions: ServeAction[]) =>
  actions.flatMap((a) => (a.kind === "start" ? [a.taskKey] : []));

describe("t45 a task waits for what it depends on", () => {
  test("t45_dependent_waits_then_starts", () => {
    for (const state of ["todo", "progress"] as const) {
      const b = task("T-B", { state, status: state, started_runs: state === "todo" ? 0 : 1 });
      const plan = planServe(input([waiting("T-A", [dep("T-B", "open")]), b]));
      expect(startsOf(plan.actions)).toEqual(state === "todo" ? ["T-B"] : []);
      expect(plan.blocked_tasks).toEqual([{ key: "T-A", reason: "T-A waits for T-B (open)" }]);
      expect(plan.waiting.starts).toEqual([]);
    }
    // The cycle after B is done: A starts, and nothing is said to hold it back.
    const after = planServe(input([waiting("T-A", [dep("T-B", "done")])]));
    expect(startsOf(after.actions)).toEqual(["T-A"]);
    expect(after.blocked_tasks).toEqual([]);
  });

  test("t45_agent_closing_a_dependency_does_not_unblock", () => {
    for (const state of ["done", "declined"] as const) {
      const closedByAgent = waiting("T-A", [dep("T-B", state, true)]);
      const plan = planServe(input([closedByAgent]));
      expect(startsOf(plan.actions)).toEqual([]);
      expect(plan.blocked_tasks).toEqual([
        { key: "T-A", reason: `T-A waits for T-B (${state}, waits for approval)` },
      ]);
      // After `kodel task approve T-B` the tracker no longer says it waits.
      expect(startsOf(planServe(input([waiting("T-A", [dep("T-B", state)])])).actions)).toEqual([
        "T-A",
      ]);
      // A rule that takes tasks without approval waives the approval of their dependencies too.
      const any = rules({ start: [{ pipeline: "dev", match: { approval: "any" } }] });
      expect(startsOf(planServe(input([closedByAgent], { rules: any })).actions)).toEqual(["T-A"]);
    }
  });

  test("t45_run_closing_a_dependency_unblocks", () => {
    // The engine closes a task for a completed run without a mark: the tracker says `done`, no more.
    const plan = planServe(
      input([waiting("T-A", [dep("T-B", "done")])], {
        runs: [run("r_done", { status: "completed", taskKey: "T-B" })],
      }),
    );
    expect(startsOf(plan.actions)).toEqual(["T-A"]);
  });

  test("t45_unapproved_agent_made_dependency_blocks_when_done", () => {
    // B was made by an agent and never approved: its run completing does not release A.
    const plan = planServe(
      input([waiting("T-A", [dep("T-B", "done", true)])], {
        runs: [run("r_done", { status: "completed", taskKey: "T-B" })],
      }),
    );
    expect(startsOf(plan.actions)).toEqual([]);
    expect(plan.blocked_tasks.map((b) => b.key)).toEqual(["T-A"]);
  });

  test("t45_unlisted_closed_dependency_unblocks_and_missing_blocks", () => {
    // Readiness is the tracker's word about each key, not whether the dependency is in the list.
    const plan = planServe(
      input([
        waiting("T-A", [dep("T-DONE", "done")]),
        waiting("T-B", [dep("T-NO", "declined")]),
        waiting("T-C", [dep("T-GONE", "missing")]),
        task("T-D", { depends_on: ["T-UNSAID"] }),
      ]),
    );
    expect(startsOf(plan.actions).sort()).toEqual(["T-A", "T-B"]);
    expect(plan.blocked_tasks).toEqual([
      { key: "T-C", reason: "T-C waits for T-GONE (missing)" },
      { key: "T-D", reason: "T-D waits for T-UNSAID (missing)" },
    ]);
  });

  test("t45_declined_dependency_never_lifts_a_give_up", () => {
    const gaveUp = waiting("T-A", [dep("T-B", "declined")], {
      comment: giveUpComment("dev", "the agent did not start"),
    });
    const plan = planServe(input([gaveUp]));
    // No start, and no action that writes to the task: a give-up stays the task's latest comment.
    expect(plan.actions).toEqual([]);
    expect(plan.blocked_tasks).toEqual([]);
    const kinds = new Set(
      planServe(input([waiting("T-A", [dep("T-B", "declined")])])).actions.map((a) => a.kind),
    );
    expect([...kinds]).toEqual(["start"]);
  });

  test("t45_admit_start_reasons_keep_their_order", () => {
    const why = (a: Admission) => (a.ok ? "ok" : a.why);
    const blocked = { depends_on: ["T-B"], dependencies: [dep("T-B", "open")] };
    const open = [run("r_w", { taskKey: "T-W" })];
    const admit = (over: Partial<ServeTaskView>, runs: ServeRunView[] = []) =>
      why(admitStart({ task: task("T-A", over), runs }));
    // Today's reasons first, in their order; then the links; then the give-up and the limits.
    expect(admit({ ...blocked, state: "done" })).toBe("done");
    expect(admit({ ...blocked, state: "progress" })).toBe("not_todo");
    expect(admit({ ...blocked, started_runs: 1 })).toBe("has_run");
    expect(admit({ ...blocked, needs_approval: true })).toBe("not_approved");
    const gaveUp = { comment: giveUpComment("dev", "no") };
    expect(admit({ ...blocked, ...gaveUp })).toBe("blocked");
    expect(admit({ conflicts_with: ["T-W"], ...gaveUp }, open)).toBe("conflict");
    expect(admit(gaveUp, open)).toBe("gave_up");
    const full = { max_workers: 0, max_runs: 0 };
    expect(why(admitStart({ task: task("T-A", blocked), runs: [], limits: full }))).toBe("blocked");
    expect(why(admitStart({ task: task("T-A"), runs: [], limits: full }))).toBe("max_runs");
    expect(admitStart({ task: task("T-A", blocked), runs: [] })).toEqual({
      ok: false,
      why: "blocked",
      links: { ok: false, why: "blocked", by: ["T-B"] },
    });
  });
});

describe("t45 tasks that conflict", () => {
  test("t45_conflicting_tasks_are_never_started_together", () => {
    const a = task("T-A", { conflicts_with: ["T-B"], created_at: "2026-01-01" });
    const b = task("T-B", { conflicts_with: ["T-A"], created_at: "2026-01-02" });
    const c = task("T-C", { created_at: "2026-01-03" });
    const first = planServe(input([b, c, a]));
    expect(startsOf(first.actions)).toEqual(["T-A", "T-C"]);
    expect(first.blocked_tasks).toEqual([
      { key: "T-B", reason: "T-B conflicts with T-A (started in this cycle)" },
    ]);
    // The link written on one task only holds both ways.
    const oneSided = planServe(input([task("T-A", { created_at: "2026-01-01" }), b]));
    expect(startsOf(oneSided.actions)).toEqual(["T-A"]);
    const otherSide = planServe(input([a, task("T-B", { created_at: "2026-01-02" })]));
    expect(startsOf(otherSide.actions)).toEqual(["T-A"]);

    // While A's run is open, whoever started it and whether or not it has a worker: no B.
    for (const status of ["running", "paused"] as const) {
      const going = planServe(input([b, c], { runs: [run("r_a", { status, taskKey: "T-A" })] }));
      expect(startsOf(going.actions)).toEqual(["T-C"]);
      expect(going.blocked_tasks).toEqual([
        { key: "T-B", reason: "T-B conflicts with T-A (run r_a)" },
      ]);
    }
    // An ended run holds nothing back.
    for (const status of ["completed", "failed", "canceled"] as const) {
      const ended = planServe(input([b], { runs: [run("r_a", { status, taskKey: "T-A" })] }));
      expect(startsOf(ended.actions)).toEqual(["T-B"]);
    }
  });

  test("t45_unreadable_run_holds_back_conflicting_tasks", () => {
    const list = [task("T-A", { conflicts_with: ["T-B"] }), task("T-C")];
    // No worker record and not known to have ended: its task is not known.
    const plan = planServe(input(list, { unreadable_open: ["r_bad"] }));
    expect(startsOf(plan.actions)).toEqual(["T-C"]);
    expect(plan.blocked_tasks).toEqual([
      { key: "T-A", reason: "T-A has conflicts and run r_bad cannot be read" },
    ]);
    // An unreadable run that has a worker holds back the same way.
    const withWorker = planServe(
      input(list, {
        unreadable: [
          { runId: "r_w", why: "cannot_read", detail: "cannot read", worker: worker("r_w") },
        ],
      }),
    );
    expect(startsOf(withWorker.actions)).toEqual(["T-C"]);
    expect(startsOf(planServe(input(list)).actions).sort()).toEqual(["T-A", "T-C"]);
  });

  test("t45_daemon_never_starts_over_a_block", () => {
    // Every start of a plan passes `admitStart`, whatever mix of links the tasks carry.
    const list = [
      task("T-1"),
      waiting("T-2", [dep("T-1", "open")]),
      waiting("T-3", [dep("T-X", "done", true)]),
      task("T-4", { conflicts_with: ["T-5"] }),
      task("T-5", { conflicts_with: ["T-4", "T-RUN"] }),
      waiting("T-6", [dep("T-GONE", "missing")], { priority: "high" }),
      task("T-7", { conflicts_with: ["T-RUN"], priority: "high" }),
    ];
    const runs = [run("r_run", { taskKey: "T-RUN" })];
    const plan = planServe(input(list, { runs }));
    const started = startsOf(plan.actions);
    expect(started).toEqual(["T-1", "T-4"]);
    for (const key of started) {
      const view = list.find((t) => t.key === key) as ServeTaskView;
      expect(admitStart({ task: view, runs })).toEqual({ ok: true });
    }
    expect(plan.blocked_tasks.map((b) => b.key).sort()).toEqual([
      "T-2",
      "T-3",
      "T-5",
      "T-6",
      "T-7",
    ]);
  });
});

describe("t46 the order and the queues of a plan", () => {
  test("t45_tasks_outside_the_rule_raise_priority_but_are_not_started", () => {
    const only = rules({
      max_workers: 1,
      max_runs: 1,
      start: [{ pipeline: "dev", match: { priority: ["low", "normal"], approval: "required" } }],
    });
    const low = task("T-LOW", { priority: "low", created_at: "2026-01-02" });
    const normal = task("T-NORMAL", { created_at: "2026-01-01" });
    // The rule does not take high tasks, but the high task that waits for T-LOW raises it.
    const high = waiting("T-HIGH", [dep("T-LOW", "open")], { priority: "high" });
    const plan = planServe(
      input([normal, low], {
        rules: only,
        tasks: {
          list: [normal, low],
          complete: true,
          priorities: PRIORITIES,
          graph: [high, normal, low],
        },
      }),
    );
    expect(startsOf(plan.actions)).toEqual(["T-LOW"]);
    expect(plan.queues.starts).toEqual([
      { key: "T-LOW", reason: "priority high (raised by T-HIGH), unblocks 1" },
      { key: "T-NORMAL", reason: "priority normal" },
    ]);
    expect(plan.waiting.starts).toEqual(["T-NORMAL"]);
    // Without the wider read the order is by the listed tasks alone.
    expect(startsOf(planServe(input([normal, low], { rules: only })).actions)).toEqual([
      "T-NORMAL",
    ]);
  });

  test("t46_plan_orders_both_queues_through_the_interface", () => {
    const gate = (decidedAt: number) =>
      decisionOf(
        [
          { event: "run_started" },
          { event: "node_entered", node: "plan" },
          { event: "gate_waiting", node: "g" },
          { event: "gate_decided", node: "g", decision: "approved", ts: decidedAt },
        ].map((l, i) => ({ v: 2, seq: i + 1, ts: 1_000 + (i + 1) * 1_000, ...l })) as never,
      );
    const decided = (runId: string, at: number) =>
      run(runId, {
        taskKey: `T-${runId}`,
        marks: gate(at),
        worker: worker(runId, { state: "exited", label: "exited (0)", since: 4_500 }),
      });
    const plan = planServe(
      input(
        [
          task("T-B", { created_at: "2026-01-02" }),
          task("T-A", { created_at: "2026-01-01", priority: "low" }),
          task("T-C", { created_at: "2026-01-01" }),
        ],
        {
          rules: rules({ max_workers: 1, max_runs: 9 }),
          runs: [decided("r_new", 7_000), decided("r_old", 5_000)],
        },
      ),
    );
    // Resumes stay oldest decision first and before any start.
    expect(plan.actions.filter((a) => a.kind === "resume")).toEqual([
      { kind: "resume", runId: "r_old", seq: 4, sessionId: "s-1" },
    ]);
    expect(plan.queues.workers).toEqual([
      { runId: "r_old", reason: "decided at 5000" },
      { runId: "r_new", reason: "decided at 7000" },
    ]);
    expect(plan.waiting.resumes).toEqual(["r_new"]);
    expect(startsOf(plan.actions)).toEqual([]);
    expect(plan.queues.starts.map((s) => s.key)).toEqual(["T-C", "T-B", "T-A"]);
    expect(plan.waiting.starts).toEqual(["T-C", "T-B", "T-A"]);
  });

  test("t46_plan_reports_queues_and_blocked_tasks", () => {
    // Shaped like a token so that redaction would catch it; put together here so no file holds one.
    const secret = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
    const plan = planServe(
      input(
        [
          task("T-A", { title: `token ${secret}`, priority: "high" }),
          waiting("T-B", [dep("T-A", "open")], { title: secret }),
          task("T-C", { title: secret, conflicts_with: ["T-RUN"] }),
        ],
        { runs: [run("r_run", { taskKey: "T-RUN" })] },
      ),
    );
    expect(plan.queues.starts).toEqual([{ key: "T-A", reason: "priority high, unblocks 1" }]);
    expect(plan.blocked_tasks).toEqual([
      { key: "T-B", reason: "T-B waits for T-A (open)" },
      { key: "T-C", reason: "T-C conflicts with T-RUN (run r_run)" },
    ]);
    // Keys, run ids, priority names and fixed words only: never a title.
    expect(JSON.stringify([plan.queues, plan.blocked_tasks])).not.toContain(secret);
    // Disabled, the plan acts on nothing and still says what it would do.
    const off = planServe({
      ...input([task("T-A"), waiting("T-B", [dep("T-A", "open")])]),
      rules: rules({ enabled: false }),
    });
    expect(off.actions).toEqual([]);
    expect(off.queues.starts.map((s) => s.key)).toEqual(["T-A"]);
    expect(off.blocked_tasks.map((b) => b.key)).toEqual(["T-B"]);
  });

  test("t46_no_links_keeps_the_order_of_the_list_within_a_priority", () => {
    // A tracker that gives no `created_at`: priority, then the list order, as before the links.
    const plan = planServe(
      input([
        task("T-Z"),
        task("T-A", { priority: "low" }),
        task("T-M"),
        task("T-H", { priority: "high" }),
      ]),
    );
    expect(startsOf(plan.actions)).toEqual(["T-H", "T-Z", "T-M", "T-A"]);
  });
});
