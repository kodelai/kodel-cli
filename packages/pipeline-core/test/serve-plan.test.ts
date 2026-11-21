/**
 * The plan of one cycle of `kodel serve` (TASK-G8KM, T-43): pure rules over the person's block, the
 * runs, their workers, the tasks and the daemon's memory.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JournalRecord } from "../src";
import {
  admitStart,
  decisionOf,
  giveUpComment,
  matchesRule,
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

function build(lines: Partial<JournalRecord>[]): JournalRecord[] {
  return lines.map((l, i) => ({
    v: 2,
    seq: i + 1,
    ts: 1_000 + (i + 1) * 1_000,
    event: "node_entered",
    ...l,
  })) as JournalRecord[];
}

/** Waited at a gate (ts 4000), decided at `decidedAt`. */
const gateDecided = (decidedAt = 5_000) =>
  build([
    { event: "run_started" },
    { event: "node_entered", node: "plan" },
    { event: "gate_waiting", node: "g" },
    { event: "gate_decided", node: "g", decision: "approved", ts: decidedAt },
  ]);
const gateWaiting = build([
  { event: "run_started" },
  { event: "node_entered", node: "plan" },
  { event: "gate_waiting", node: "g" },
]);

const rules = (over: Partial<ServeRules> = {}): ServeRules => ({
  enabled: true,
  max_workers: 1,
  max_runs: 1,
  stalled_after_s: 1800,
  start: { pipeline: "dev", match: {} },
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

const task = (key: string, over: Partial<ServeTaskView> = {}): ServeTaskView => ({
  key,
  title: key,
  status: "todo",
  state: "todo",
  started_runs: 0,
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

const run = (runId: string, over: Partial<ServeRunView> = {}): ServeRunView => ({
  runId,
  status: "running",
  canNote: true,
  waitsForPerson: false,
  noted: [],
  ...over,
});

/** A run at its gate whose worker exited there. */
const atGate = (runId: string): ServeRunView =>
  run(runId, {
    taskKey: `T-${runId}`,
    waitsForPerson: true,
    marks: decisionOf(gateWaiting),
    worker: worker(runId, { state: "exited", label: "exited (0)", since: 4_500 }),
  });

/** A run whose person decided after its worker exited at the gate. */
const decided = (runId: string, decidedAt = 5_000): ServeRunView =>
  run(runId, {
    taskKey: `T-${runId}`,
    marks: decisionOf(gateDecided(decidedAt)),
    worker: worker(runId, { state: "exited", label: "exited (0)", since: 4_500 }),
  });

const input = (over: Partial<ServeInput> = {}): ServeInput => ({
  now: NOW,
  rules: rules(),
  runs: [],
  memory: memory(),
  unreadable: [],
  quietFrom: 0,
  tasks: { list: [], complete: true, priorities: ["urgent", "high", "medium", "low"] },
  environment: { ok: true },
  ...over,
});

const tasks = (list: ServeTaskView[], over: Partial<NonNullable<ServeInput["tasks"]>> = {}) => ({
  list,
  complete: true,
  priorities: ["urgent", "high", "medium", "low"],
  ...over,
});

const of = <K extends ServeAction["kind"]>(actions: ServeAction[], kind: K) =>
  actions.filter((a): a is Extract<ServeAction, { kind: K }> => a.kind === kind);
const startsOf = (actions: ServeAction[]) => of(actions, "start").map((a) => a.taskKey);
const logsOf = (actions: ServeAction[], problem?: string) =>
  of(actions, "log").filter((a) => problem === undefined || a.problem === problem);

describe("t43 starting tasks", () => {
  test("t43_matching_task_is_started_at_most_once", () => {
    const limits = { max_workers: 64, max_runs: 64 };
    const runs = [run("r_1", { taskKey: "T-NAMED", status: "completed" })];
    const cases: [ServeTaskView, string][] = [
      [task("T-DONE", { state: "done", status: "done" }), "done"],
      [task("T-PROG", { state: "progress", status: "progress" }), "not_todo"],
      [task("T-NAMED"), "has_run"],
      [task("T-TRACKED", { started_runs: 1 }), "has_run"],
      [task("T-AGENT", { needs_approval: true }), "not_approved"],
      [task("T-GAVE", { comment: giveUpComment("dev", "no git") }), "gave_up"],
    ];
    for (const [t, why] of cases) {
      expect(admitStart({ task: t, runs, limits })).toEqual({ ok: false, why } as never);
    }
    expect(admitStart({ task: task("T-NEW"), runs, limits })).toEqual({ ok: true });
    // a give-up that is not the latest comment no longer holds
    expect(admitStart({ task: task("T-NEW", { comment: "try again please" }), runs })).toEqual({
      ok: true,
    });
    const plan = planServe(
      input({
        rules: rules({ max_workers: 64, max_runs: 64 }),
        runs,
        tasks: tasks([...cases.map(([t]) => t), task("T-NEW")]),
      }),
    );
    expect(startsOf(plan.actions)).toEqual(["T-NEW"]);
    // the next cycle sees the run the start made, and the task in progress: nothing more
    const after = planServe(
      input({
        rules: rules({ max_workers: 64, max_runs: 64 }),
        runs: [...runs, run("r_2", { taskKey: "T-NEW", worker: worker("r_2") })],
        tasks: tasks([task("T-NEW", { state: "progress", status: "progress" })]),
      }),
    );
    expect(startsOf(after.actions)).toEqual([]);
  });

  test("t43_rule_matches", () => {
    const t = task("T-1", { status: "todo", priority: "high", parent: "T-P" });
    expect(matchesRule(t, {})).toBe(true);
    expect(matchesRule(t, { status: ["todo"] })).toBe(true);
    expect(matchesRule(t, { status: ["ready"] })).toBe(false);
    expect(matchesRule(t, { priority: ["urgent", "high"] })).toBe(true);
    expect(matchesRule(t, { priority: ["low"] })).toBe(false);
    expect(matchesRule(task("T-2"), { priority: ["high"] })).toBe(false);
    expect(matchesRule(t, { parent: "T-P" })).toBe(true);
    // direct children only: a grandchild names its own parent
    expect(matchesRule(task("T-3", { parent: "T-1" }), { parent: "T-P" })).toBe(false);
    expect(matchesRule(t, { status: ["todo"], priority: ["high"], parent: "T-X" })).toBe(false);
    // an empty match is every `todo` task: a task in progress is not started whatever the rule
    const plan = planServe(
      input({
        rules: rules({ max_workers: 9, max_runs: 9 }),
        tasks: tasks([task("T-A"), task("T-B", { state: "progress", status: "progress" })]),
      }),
    );
    expect(startsOf(plan.actions)).toEqual(["T-A"]);
    // a rule that does not match starts nothing; no `start` block starts nothing
    const none = planServe(
      input({
        rules: rules({ start: { pipeline: "dev", match: { priority: ["urgent"] } } }),
        tasks: tasks([task("T-A", { priority: "low" })]),
      }),
    );
    expect(startsOf(none.actions)).toEqual([]);
    const { start: _, ...noStart } = rules();
    expect(
      startsOf(planServe(input({ rules: noStart, tasks: tasks([task("T-A")]) })).actions),
    ).toEqual([]);
  });

  test("t43_incomplete_list_starts_nothing", () => {
    const plan = planServe(input({ tasks: tasks([task("T-A")], { complete: false }) }));
    expect(startsOf(plan.actions)).toEqual([]);
    expect(logsOf(plan.actions, "environment")).toHaveLength(1);
    // logged on change only
    const again = planServe(
      input({ memory: plan.memory, tasks: tasks([task("T-A")], { complete: false }) }),
    );
    expect(logsOf(again.actions)).toEqual([]);
    // an environment problem is no attempt and starts nothing either, one line per change
    const env = planServe(
      input({
        environment: { ok: false, reason: "claude is not installed" },
        tasks: tasks([task("T-A")]),
      }),
    );
    expect(startsOf(env.actions)).toEqual([]);
    expect(env.memory.attempts).toEqual({});
    expect(logsOf(env.actions, "environment")[0]?.detail).toBe("claude is not installed");
    expect(env.blocked).toBe("claude is not installed");
    const fixed = planServe(input({ memory: env.memory, tasks: tasks([task("T-A")]) }));
    expect(startsOf(fixed.actions)).toEqual(["T-A"]);
    expect(fixed.memory.logged.some((m) => m.startsWith("environment:"))).toBe(false);
    expect(fixed.blocked).toBeUndefined();
  });
});

describe("t43 the two limits", () => {
  test("t43_limits_table", () => {
    // one case per row: a run at its gate holds a run place and no worker place; a running worker
    // holds both; `unknown` holds both; a lost worker and an ended run hold neither.
    const rows: [string, ServeRunView, { run: boolean; worker: boolean }][] = [
      ["at a gate", atGate("r_gate"), { run: true, worker: false }],
      ["running", run("r_run", { worker: worker("r_run") }), { run: true, worker: true }],
      [
        "unknown",
        run("r_unk", { worker: worker("r_unk", { state: "unknown", label: "unknown" }) }),
        { run: true, worker: true },
      ],
      [
        "lost",
        run("r_lost", { worker: worker("r_lost", { state: "lost" }), noted: ["a_r_lost"] }),
        { run: false, worker: false },
      ],
      [
        "ended",
        run("r_end", {
          status: "completed",
          worker: worker("r_end", { state: "exited", since: 9_000 }),
        }),
        { run: false, worker: false },
      ],
    ];
    for (const [name, r, want] of rows) {
      const plan = planServe(input({ rules: rules({ max_workers: 9, max_runs: 9 }), runs: [r] }));
      expect({
        name,
        run: plan.counts.runs.includes(r.runId),
        worker: plan.counts.workers === 1,
      }).toEqual({
        name,
        ...want,
      });
    }
  });

  test("t43_two_limits_hold_and_the_rest_wait", () => {
    const list = [
      task("T-LOW", { priority: "low" }),
      task("T-NONE"),
      task("T-URG", { priority: "urgent" }),
      task("T-HIGH", { priority: "high" }),
      task("T-URG2", { priority: "urgent" }),
    ];
    // max_runs 4, max_workers 2: two start, the rest wait in priority order, then list order
    const plan = planServe(
      input({ rules: rules({ max_workers: 2, max_runs: 4 }), tasks: tasks(list) }),
    );
    expect(startsOf(plan.actions)).toEqual(["T-URG", "T-URG2"]);
    expect(plan.waiting.starts).toEqual(["T-HIGH", "T-LOW", "T-NONE"]);
    const queued = logsOf(plan.actions, "queued");
    expect(queued).toHaveLength(1);
    // the same queue next cycle: no line; a changed queue: one line
    const same = planServe(
      input({
        rules: rules({ max_workers: 2, max_runs: 4 }),
        tasks: tasks(list),
        memory: plan.memory,
      }),
    );
    expect(logsOf(same.actions, "queued")).toEqual([]);
    const changed = planServe(
      input({
        rules: rules({ max_workers: 2, max_runs: 4 }),
        tasks: tasks(list.slice(1)),
        memory: plan.memory,
      }),
    );
    expect(logsOf(changed.actions, "queued")).toHaveLength(1);
    // max_runs 1 holds while the first run waits at its gate (no worker alive)
    const gated = planServe(input({ runs: [atGate("r_a")], tasks: tasks([task("T-B")]) }));
    expect(startsOf(gated.actions)).toEqual([]);
    expect(gated.waiting.starts).toEqual(["T-B"]);
    // max_runs 2, max_workers 1: the second starts when the first reaches its gate
    const second = planServe(
      input({ rules: rules({ max_runs: 2 }), runs: [atGate("r_a")], tasks: tasks([task("T-B")]) }),
    );
    expect(startsOf(second.actions)).toEqual(["T-B"]);
  });

  test("t43_over_the_limit_starts_nothing", () => {
    // the person started two by key in the TUI: over both limits, the daemon adds nothing
    const runs = [
      run("r_a", { taskKey: "T-A", worker: worker("r_a") }),
      run("r_b", { taskKey: "T-B", worker: worker("r_b") }),
      decided("r_c"),
    ];
    const plan = planServe(input({ runs, tasks: tasks([task("T-N")]) }));
    expect(of(plan.actions, "start")).toEqual([]);
    expect(of(plan.actions, "resume")).toEqual([]);
    expect(plan.counts.workers).toBe(2);
    expect(plan.counts.runs).toEqual(["r_a", "r_b", "r_c"]);
    expect(
      admitStart({ task: task("T-N"), runs, limits: { max_workers: 1, max_runs: 1 } }),
    ).toEqual({
      ok: false,
      why: "max_runs",
    });
    expect(
      admitStart({ task: task("T-N"), runs, limits: { max_workers: 1, max_runs: 9 } }),
    ).toEqual({
      ok: false,
      why: "max_workers",
    });
    // the TUI passes no limits
    expect(admitStart({ task: task("T-N"), runs })).toEqual({ ok: true });
    // the worker of a run that cannot be read holds its places, as in the plan
    const unreadable = [
      { runId: "r_u", why: "cannot_read" as const, detail: "cannot read", worker: worker("r_u") },
    ];
    const limits = { max_workers: 2, max_runs: 2 };
    expect(admitStart({ task: task("T-N"), runs: [], unreadable, limits })).toEqual({ ok: true });
    expect(
      admitStart({
        task: task("T-N"),
        runs: [run("r_a", { taskKey: "T-A", worker: worker("r_a") })],
        unreadable,
        limits,
      }),
    ).toEqual({ ok: false, why: "max_runs" });
    expect(
      planServe(
        input({
          rules: rules({ max_workers: 2, max_runs: 2 }),
          runs: [run("r_a", { taskKey: "T-A", worker: worker("r_a") })],
          unreadable,
          tasks: tasks([task("T-N")]),
        }),
      ).actions.filter((a) => a.kind === "start"),
    ).toEqual([]);
  });

  test("t43_resumes_go_before_starts", () => {
    // max_workers full: both resumes wait, oldest decision first, and no start
    const runs = [
      decided("r_new", 7_000),
      decided("r_old", 6_000),
      run("r_w", { worker: worker("r_w") }),
    ];
    const full = planServe(
      input({ rules: rules({ max_workers: 1, max_runs: 9 }), runs, tasks: tasks([task("T-N")]) }),
    );
    expect(of(full.actions, "resume")).toEqual([]);
    expect(full.waiting.resumes).toEqual(["r_old", "r_new"]);
    expect(startsOf(full.actions)).toEqual([]);
    // one place: the oldest decision is resumed; the other resume still waits, so no start
    const one = planServe(
      input({ rules: rules({ max_workers: 2, max_runs: 9 }), runs, tasks: tasks([task("T-N")]) }),
    );
    expect(of(one.actions, "resume")).toEqual([
      { kind: "resume", runId: "r_old", seq: 4, sessionId: "s-1" },
    ]);
    expect(one.waiting.resumes).toEqual(["r_new"]);
    expect(startsOf(one.actions)).toEqual([]);
    // a resume never needs `max_runs`: the runs are full and it is resumed all the same
    const runsFull = planServe(
      input({ rules: rules({ max_workers: 2, max_runs: 1 }), runs: [decided("r_old")] }),
    );
    expect(of(runsFull.actions, "resume")).toHaveLength(1);
    // resumes come before starts in the actions
    const both = planServe(
      input({
        rules: rules({ max_workers: 9, max_runs: 9 }),
        runs: [decided("r_old")],
        tasks: tasks([task("T-N")]),
      }),
    );
    expect(both.actions.map((a) => a.kind)).toEqual(["resume", "start"]);
    // an agent moved since the decision: not resumed, one line
    const moved = decided("r_m");
    const movedRun = {
      ...moved,
      marks: decisionOf([
        ...gateDecided(),
        ...build([{ event: "step_served" }]).map((r) => ({ ...r, seq: 5, ts: 6_000 })),
      ]),
    };
    const m = planServe(input({ runs: [movedRun] }));
    expect(of(m.actions, "resume")).toEqual([]);
    expect(logsOf(m.actions, "moved")).toHaveLength(1);
    expect(logsOf(planServe(input({ runs: [movedRun], memory: m.memory })).actions)).toEqual([]);
  });

  test("t43_three_dead_workers_pause_starts", () => {
    const rulesNine = rules({ max_workers: 9, max_runs: 9 });
    const dead = (id: string, since: number) =>
      run(id, { taskKey: `T-${id}`, worker: worker(id, { state: "lost", since }) });
    const mine = ["r_1", "r_2", "r_3", "r_4"];
    // two in a row: still starting
    const two = planServe(
      input({
        rules: rulesNine,
        runs: [dead("r_1", 100), dead("r_2", 200)],
        memory: memory({ mine }),
        tasks: tasks([task("T-N")]),
      }),
    );
    expect(two.memory.dead_in_a_row).toBe(2);
    expect(startsOf(two.actions)).toEqual(["T-N"]);
    // a third: no start, one line; the notes are still written
    const three = planServe(
      input({
        rules: rulesNine,
        runs: [dead("r_1", 100), dead("r_2", 200), dead("r_3", 300)],
        memory: two.memory,
        tasks: tasks([task("T-N")]),
      }),
    );
    expect(three.memory.dead_in_a_row).toBe(3);
    expect(startsOf(three.actions)).toEqual([]);
    expect(logsOf(three.actions, "paused")).toHaveLength(1);
    expect(logsOf(three.actions, "queued")).toEqual([]);
    expect(of(three.actions, "note")).toHaveLength(3);
    // the next cycle: still paused, no second line, a worker counted once
    const still = planServe(
      input({
        rules: rulesNine,
        runs: [dead("r_1", 100), dead("r_2", 200), dead("r_3", 300)],
        memory: three.memory,
        tasks: tasks([task("T-N")]),
      }),
    );
    expect(still.memory.dead_in_a_row).toBe(3);
    expect(startsOf(still.actions)).toEqual([]);
    expect(logsOf(still.actions, "paused")).toEqual([]);
    // a worker of the daemon that reached its wait resets the count
    const reset = planServe(
      input({
        rules: rulesNine,
        runs: [dead("r_1", 100), dead("r_2", 200), dead("r_3", 300), atGate("r_4")],
        memory: three.memory,
        tasks: tasks([task("T-N")]),
      }),
    );
    expect(reset.memory.dead_in_a_row).toBe(0);
    expect(startsOf(reset.actions)).toEqual(["T-N"]);
    // a worker the daemon did not start counts for nothing; a person's stop is not a death
    const foreign = planServe(
      input({
        rules: rulesNine,
        runs: [
          dead("r_x", 100),
          run("r_y", { worker: worker("r_y", { state: "killed", stopped: true }) }),
        ],
        memory: memory({ mine: ["r_y"] }),
      }),
    );
    expect(foreign.memory.dead_in_a_row).toBe(0);
    // a run that ended (done) resets too
    const done = planServe(
      input({
        rules: rulesNine,
        runs: [
          run("r_d", {
            status: "completed",
            worker: worker("r_d", { state: "exited", since: 400 }),
          }),
        ],
        memory: memory({ mine: ["r_d"], dead_in_a_row: 2 }),
      }),
    );
    expect(done.memory.dead_in_a_row).toBe(0);
    // ... also as the daemon reads an ended run (without its worker), and once only
    const endedRead = planServe(
      input({
        rules: rulesNine,
        runs: [run("r_e", { status: "completed" })],
        memory: memory({ mine: ["r_e"], dead_in_a_row: 2 }),
      }),
    );
    expect(endedRead.memory.dead_in_a_row).toBe(0);
    const afterEnded = planServe(
      input({
        rules: rulesNine,
        runs: [run("r_e", { status: "completed" })],
        memory: { ...endedRead.memory, dead_in_a_row: 2 },
      }),
    );
    expect(afterEnded.memory.dead_in_a_row).toBe(2);
    // a run that failed or was canceled is no reset
    const canceled = planServe(
      input({
        rules: rulesNine,
        runs: [run("r_c", { status: "canceled" })],
        memory: memory({ mine: ["r_c"], dead_in_a_row: 2 }),
      }),
    );
    expect(canceled.memory.dead_in_a_row).toBe(2);
    // a launch that left no record counts as a dead worker, once, and gets its note until written
    const failedLaunch = planServe(
      input({
        rules: rulesNine,
        runs: [dead("r_1", 100), dead("r_2", 200), run("r_5", { taskKey: "T-r_5" })],
        memory: memory({ mine: [...mine, "r_5"], unlaunched: [{ runId: "r_5", at: 500 }] }),
        tasks: tasks([task("T-N")]),
      }),
    );
    expect(failedLaunch.memory.dead_in_a_row).toBe(3);
    expect(startsOf(failedLaunch.actions)).toEqual([]);
    expect(logsOf(failedLaunch.actions, "paused")).toHaveLength(1);
    expect(failedLaunch.blocked).toContain("3 workers in a row ended outside a wait");
    expect(of(failedLaunch.actions, "note").filter((n) => n.runId === "r_5")).toEqual([
      { kind: "note", runId: "r_5", worker: "kw-r_5", reason: "not_started", at: 500 },
    ]);
    // the note was not written: asked again, but not counted again
    const again = planServe(
      input({
        rules: rulesNine,
        runs: [dead("r_1", 100), dead("r_2", 200), run("r_5", { taskKey: "T-r_5" })],
        memory: failedLaunch.memory,
      }),
    );
    expect(again.memory.dead_in_a_row).toBe(3);
    expect(of(again.actions, "note").filter((n) => n.runId === "r_5")).toHaveLength(1);
    // written: no note, and the entry is forgotten
    const noted = planServe(
      input({
        rules: rulesNine,
        runs: [run("r_5", { taskKey: "T-r_5" })],
        memory: {
          ...again.memory,
          unlaunched: again.memory.unlaunched.map((u) => ({ ...u, noted: true as const })),
        },
      }),
    );
    expect(of(noted.actions, "note")).toEqual([]);
    expect(noted.memory.unlaunched).toEqual([]);
    expect(noted.memory.dead_in_a_row).toBe(3);
  });
});

describe("t43 workers that stall or die", () => {
  test("t43_stalled_from_last_output_at", () => {
    const at = (w: Partial<ServeWorkerView>, over: Partial<ServeInput> = {}) =>
      logsOf(
        planServe(input({ runs: [run("r_s", { worker: worker("r_s", w) })], ...over })).actions,
        "stalled",
      );
    const limit = 1800 * 1000;
    // from the last output
    expect(at({ started: 0, lastOutputAt: NOW - limit })).toHaveLength(1);
    expect(at({ started: 0, lastOutputAt: NOW - limit + 1 })).toEqual([]);
    // from its start, when it printed nothing
    expect(at({ started: NOW - limit })).toHaveLength(1);
    expect(at({ started: NOW - limit + 1 })).toEqual([]);
    // from the daemon's start
    expect(at({ started: 0 }, { quietFrom: NOW - limit + 1 })).toEqual([]);
    // `0` never
    expect(at({ started: 0 }, { rules: rules({ stalled_after_s: 0 }) })).toEqual([]);
    // only running workers
    expect(at({ started: 0, state: "starting" })).toEqual([]);
    // once per quiet spell: the same spell is not logged again; new output starts a new spell
    const first = planServe(
      input({ runs: [run("r_s", { worker: worker("r_s", { started: 0 }) })] }),
    );
    expect(logsOf(first.actions, "stalled")).toHaveLength(1);
    const again = planServe(
      input({
        now: NOW + 5_000,
        runs: [run("r_s", { worker: worker("r_s", { started: 0 }) })],
        memory: first.memory,
      }),
    );
    expect(logsOf(again.actions, "stalled")).toEqual([]);
    const later = planServe(
      input({
        now: NOW + 2 * limit,
        runs: [run("r_s", { worker: worker("r_s", { started: 0, lastOutputAt: NOW }) })],
        memory: again.memory,
      }),
    );
    expect(logsOf(later.actions, "stalled")).toHaveLength(1);
    // stalled is a log line and nothing else
    expect(first.actions.every((a) => a.kind === "log")).toBe(true);
  });

  test("t43_sleep_gap_stalls_no_worker", () => {
    // the machine slept for hours: the last gap between two cycles is `quietFrom`, so no worker is
    // stalled on waking, though none printed anything for longer than the limit
    const runs = ["r_1", "r_2", "r_3"].map((id) =>
      run(id, { worker: worker(id, { started: 0, lastOutputAt: NOW - 5 * 3_600_000 }) }),
    );
    const woke = planServe(input({ runs, quietFrom: NOW - 5_000 }));
    expect(logsOf(woke.actions, "stalled")).toEqual([]);
    // a spell after the gap counts from it
    const after = planServe(input({ now: NOW + 1800 * 1000, runs, quietFrom: NOW - 5_000 }));
    expect(logsOf(after.actions, "stalled")).toHaveLength(3);
  });

  test("t43_dead_worker_is_noted_once_per_record", () => {
    const runs = [
      run("r_lost", { worker: worker("r_lost", { state: "lost", since: 7_000 }) }),
      run("r_kill", { worker: worker("r_kill", { state: "killed", label: "killed (timeout)" }) }),
      run("r_exit", {
        marks: decisionOf(build([{ event: "run_started" }])),
        worker: worker("r_exit", { state: "exited", exitCode: 1, since: 8_000 }),
      }),
      run("r_stop", {
        worker: worker("r_stop", { state: "killed", label: "stopped", stopped: true }),
      }),
      atGate("r_gate"),
      run("r_end", { status: "completed", worker: worker("r_end", { state: "lost" }) }),
    ];
    const plan = planServe(input({ runs, tasks: undefined }));
    expect(of(plan.actions, "note")).toEqual([
      {
        kind: "note",
        runId: "r_lost",
        worker: "kw-r_lost",
        id: "a_r_lost",
        reason: "lost",
        at: 7_000,
      },
      { kind: "note", runId: "r_kill", worker: "kw-r_kill", id: "a_r_kill", reason: "killed" },
      {
        kind: "note",
        runId: "r_exit",
        worker: "kw-r_exit",
        id: "a_r_exit",
        reason: "exited",
        exit_code: 1,
        at: 8_000,
      },
    ]);
    // the next cycle reads the notes back from the journal: nothing again
    const noted = runs.map((r) => ({ ...r, noted: r.worker === undefined ? [] : [r.worker.id] }));
    expect(of(planServe(input({ runs: noted })).actions, "note")).toEqual([]);
    // a second worker under a reused name has another record id: noted too
    const reused = run("r_lost", {
      noted: ["a_r_lost"],
      worker: worker("r_lost", { id: "a_r_lost_2", state: "lost" }),
    });
    expect(of(planServe(input({ runs: [reused] })).actions, "note")).toMatchObject([
      { id: "a_r_lost_2", worker: "kw-r_lost" },
    ]);
    // a format without notes: one log line per daemon instead
    const v1 = run("r_v1", { canNote: false, worker: worker("r_v1", { state: "lost" }) });
    const logged = planServe(input({ runs: [v1] }));
    expect(of(logged.actions, "note")).toEqual([]);
    expect(logsOf(logged.actions, "dead")).toHaveLength(1);
    expect(logsOf(planServe(input({ runs: [v1], memory: logged.memory })).actions)).toEqual([]);
  });
});

describe("t43 a worker that stopped at a wait with no wait line", () => {
  test("t43_worker_at_a_wait_without_a_wait_line_is_not_dead", () => {
    const rulesNine = rules({ max_workers: 9, max_runs: 9 });
    // the run waits for a person (a pipeline file edited by hand), but the journal has no wait line
    const waiting = (id: string, since: number) =>
      run(id, {
        taskKey: `T-${id}`,
        waitsForPerson: true,
        marks: decisionOf(build([{ event: "run_started" }])),
        worker: worker(id, { state: "exited", label: "exited (0)", since }),
      });
    const plan = planServe(
      input({
        rules: rulesNine,
        runs: [waiting("r_1", 100), waiting("r_2", 200), waiting("r_3", 300)],
        memory: memory({ mine: ["r_1", "r_2", "r_3"], dead_in_a_row: 2 }),
        tasks: tasks([task("T-N")]),
      }),
    );
    expect(of(plan.actions, "note")).toEqual([]);
    expect(plan.memory.dead_in_a_row).toBe(0);
    expect(logsOf(plan.actions, "paused")).toEqual([]);
    expect(startsOf(plan.actions)).toEqual(["T-N"]);
  });
});

describe("t43 attempts at a start", () => {
  test("t43_gives_up_after_three_attempts", () => {
    const list = tasks([task("T-A")]);
    // a failed attempt is tried again 60 s later, not sooner
    const failed = memory({
      attempts: { "T-A": { count: 1, last_at: NOW - 59_999, reason: "boom" } },
    });
    const soon = planServe(input({ tasks: list, memory: failed }));
    expect(startsOf(soon.actions)).toEqual([]);
    expect(soon.waiting.starts).toEqual(["T-A"]);
    const ready = memory({
      attempts: { "T-A": { count: 2, last_at: NOW - 60_000, reason: "boom" } },
    });
    expect(startsOf(planServe(input({ tasks: list, memory: ready })).actions)).toEqual(["T-A"]);
    // after three: the give-up; the attempts stay until the daemon has written the comment
    const third = memory({
      attempts: { "T-A": { count: 3, last_at: NOW - 60_000, reason: "boom" } },
    });
    const gave = planServe(input({ tasks: list, memory: third }));
    expect(of(gave.actions, "give_up")).toEqual([
      { kind: "give_up", taskKey: "T-A", reason: "boom" },
    ]);
    expect(startsOf(gave.actions)).toEqual([]);
    expect(gave.memory.attempts).toEqual(third.attempts);
    // the comment failed: the next cycle gives up again, it does not start the task
    const retried = planServe(input({ tasks: list, memory: gave.memory }));
    expect(of(retried.actions, "give_up")).toHaveLength(1);
    expect(startsOf(retried.actions)).toEqual([]);
    const written = { ...gave.memory, attempts: {} };
    // the comment stops the retries
    const comment = giveUpComment("dev", "boom");
    expect(comment).toBe(
      "kodel serve: not started after 3 attempts (pipeline dev): boom. A newer comment makes the daemon try again; or start it by its key in the TUI.",
    );
    const stopped = planServe(input({ tasks: tasks([task("T-A", { comment })]), memory: written }));
    expect(of(stopped.actions, "give_up")).toEqual([]);
    expect(startsOf(stopped.actions)).toEqual([]);
    // a newer comment re-arms
    const rearmed = planServe(
      input({ tasks: tasks([task("T-A", { comment: "fixed the key" })]), memory: written }),
    );
    expect(startsOf(rearmed.actions)).toEqual(["T-A"]);
  });
});

describe("t43 the plan is pure", () => {
  test("t43_plan_is_pure", () => {
    const given = input({
      rules: rules({ max_workers: 2, max_runs: 3 }),
      runs: [
        decided("r_old"),
        atGate("r_g"),
        run("r_l", { worker: worker("r_l", { state: "lost" }) }),
      ],
      memory: memory({ mine: ["r_l"], attempts: { "T-X": { count: 1, last_at: 0, reason: "r" } } }),
      unreadable: [
        { runId: "r_bad", why: "newer", detail: "written by a newer kodel, upgrade kodel" },
      ],
      tasks: tasks([task("T-A"), task("T-B", { priority: "urgent" }), task("T-X")]),
    });
    const frozen = JSON.stringify(given);
    const a = planServe(given);
    const b = planServe(structuredClone(given));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // the input is not changed
    expect(JSON.stringify(given)).toBe(frozen);
    // off: nothing to do, the memory as it was; `--status` still sees what would start
    const off = planServe({ ...given, rules: { ...given.rules, enabled: false } });
    expect(off.actions).toEqual([]);
    expect(off.memory).toEqual(given.memory);
    expect(off.waiting.starts.length).toBeGreaterThan(0);

    // the subpath imports no `node:` module, directly or through what it imports
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from\s+"node:|require\("node:|import\("node:/);
      for (const m of source.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
        const spec = m[1] as string;
        const base = join(dirname(file), spec);
        if (/\.[a-z]+$/.test(spec)) continue;
        let next = `${base}.ts`;
        try {
          readFileSync(next);
        } catch {
          next = join(base, "index.ts");
        }
        visit(next);
      }
    };
    visit(new URL("../src/serve/index.ts", import.meta.url).pathname);
    expect(seen.size).toBeGreaterThan(3);
  });
});
