/**
 * The plan of one cycle of `kodel serve` (TASK-G8KM, T-44): pure rules over the person's block, the
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
  isGiveUpComment,
  matchesRule,
  NOT_MOVING_MS,
  planServe,
  ruleFor,
  type ServeAction,
  type ServeInput,
  type ServeMemory,
  type ServeRules,
  type ServeRunView,
  type ServeTaskView,
  type ServeWorkerView,
  servePlaces,
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

describe("t44 starting tasks", () => {
  test("t44_matching_task_is_started_at_most_once", () => {
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

  test("t44_rule_matches", () => {
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
        rules: rules({
          start: [{ pipeline: "dev", match: { priority: ["urgent"], approval: "required" } }],
        }),
        tasks: tasks([task("T-A", { priority: "low" })]),
      }),
    );
    expect(startsOf(none.actions)).toEqual([]);
    const noStart = rules({ start: [] });
    expect(
      startsOf(planServe(input({ rules: noStart, tasks: tasks([task("T-A")]) })).actions),
    ).toEqual([]);
  });

  test("t44_rule_approval_required_skips_and_any_takes_an_agents_task", () => {
    const agents = task("T-AGENT", { needs_approval: true });
    // the match: `required` (the default) leaves the task out, `any` takes it
    expect(matchesRule(agents, {})).toBe(false);
    expect(matchesRule(agents, { approval: "required" })).toBe(false);
    expect(matchesRule(agents, { approval: "any" })).toBe(true);
    expect(matchesRule(task("T-P"), { approval: "any" })).toBe(true);
    // the admission: fail closed without a rule's setting
    expect(admitStart({ task: agents, runs: [] })).toEqual({ ok: false, why: "not_approved" });
    expect(admitStart({ task: agents, runs: [], approval: "required" })).toEqual({
      ok: false,
      why: "not_approved",
    });
    expect(admitStart({ task: agents, runs: [], approval: "any" })).toEqual({ ok: true });

    const big = { max_workers: 9, max_runs: 9 };
    const required = planServe(input({ rules: rules(big), tasks: tasks([agents, task("T-P")]) }));
    expect(startsOf(required.actions)).toEqual(["T-P"]);
    const any = planServe(
      input({
        rules: rules({ ...big, start: [{ pipeline: "triage", match: { approval: "any" } }] }),
        tasks: tasks([agents]),
      }),
    );
    expect(of(any.actions, "start")).toEqual([
      { kind: "start", taskKey: "T-AGENT", pipeline: "triage" },
    ]);
  });

  test("t44_first_matching_rule_wins_and_names_the_pipeline", () => {
    const start = [
      { pipeline: "dev", match: { priority: ["high"], approval: "required" as const } },
      { pipeline: "triage", match: { approval: "any" as const } },
    ];
    const high = task("T-HIGH", { priority: "high" });
    const agentsHigh = task("T-AGENT", { priority: "high", needs_approval: true });
    const low = task("T-LOW", { priority: "low" });
    expect(ruleFor(high, start)?.pipeline).toBe("dev");
    // not taken by the `required` rule, so a later `any` rule takes it
    expect(ruleFor(agentsHigh, start)?.pipeline).toBe("triage");
    expect(ruleFor(low, start)?.pipeline).toBe("triage");
    expect(ruleFor(agentsHigh, start.slice(0, 1))).toBeUndefined();

    // one order across the rules: tracker priority, then list order
    const plan = planServe(
      input({
        rules: rules({ max_workers: 9, max_runs: 9, start }),
        tasks: tasks([low, agentsHigh, high]),
      }),
    );
    expect(of(plan.actions, "start")).toEqual([
      { kind: "start", taskKey: "T-AGENT", pipeline: "triage" },
      { kind: "start", taskKey: "T-HIGH", pipeline: "dev" },
      { kind: "start", taskKey: "T-LOW", pipeline: "triage" },
    ]);
    // the give-up names the pipeline of the rule that matched
    const gave = planServe(
      input({
        rules: rules({ start }),
        tasks: tasks([low]),
        memory: memory({
          attempts: { "T-LOW": { count: 3, last_at: NOW - 60_000, reason: "boom" } },
        }),
      }),
    );
    expect(of(gave.actions, "give_up")).toEqual([
      { kind: "give_up", taskKey: "T-LOW", pipeline: "triage", reason: "boom" },
    ]);
  });

  test("t44_incomplete_list_starts_nothing", () => {
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

describe("t44 the two limits", () => {
  test("t44_limits_table", () => {
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

  test("t44_two_limits_hold_and_the_rest_wait", () => {
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

  test("t44_over_the_limit_starts_nothing", () => {
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

  test("t44_resumes_go_before_starts", () => {
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

  test("t44_three_dead_workers_pause_starts", () => {
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

describe("t44 workers that stall or die", () => {
  test("t44_stalled_from_last_output_at", () => {
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

  test("t44_sleep_gap_stalls_no_worker", () => {
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

  test("t44_dead_worker_is_noted_once_per_record", () => {
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

describe("t44 a worker that stopped at a wait with no wait line", () => {
  test("t44_worker_at_a_wait_without_a_wait_line_is_not_dead", () => {
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

describe("t44 a worker whose run another agent took on", () => {
  test("t44_worker_that_stopped_at_an_earlier_wait_is_not_dead", () => {
    const onward = build([
      { event: "run_started" },
      { event: "gate_waiting", node: "g", ts: 200 },
      { event: "gate_decided", node: "g", decision: "approved", ts: 300 },
      { event: "step_served", node: "impl", ts: 400 },
      { event: "agent_completed", node: "impl", ts: 450 },
      { event: "gate_waiting", node: "g2", ts: 500 },
    ]);
    const taken = run("r_on", {
      taskKey: "T-r_on",
      waitsForPerson: true,
      marks: decisionOf(onward),
      worker: worker("r_on", { id: "a1", state: "exited", label: "exited (0)", since: 210 }),
    });
    const plan = planServe(
      input({
        runs: [taken],
        memory: memory({ mine: ["r_on"], dead_in_a_row: 2 }),
        tasks: tasks([task("T-N")]),
      }),
    );
    expect(of(plan.actions, "note")).toEqual([]);
    expect(plan.memory.dead_in_a_row).toBe(0);
    // it will never be resumed, so it frees its place in max_runs (1): the next task starts
    expect(startsOf(plan.actions)).toEqual(["T-N"]);
  });
});

describe("t44 attempts at a start", () => {
  test("t44_gives_up_after_three_attempts", () => {
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
      { kind: "give_up", taskKey: "T-A", pipeline: "dev", reason: "boom" },
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

describe("t44 a give-up that cannot be written", () => {
  test("t44_give_up_comment_fits_the_tracker", () => {
    const comment = giveUpComment("dev", "x".repeat(2_000));
    expect(comment.length).toBeLessThanOrEqual(500);
    expect(isGiveUpComment(comment)).toBe(true);
    expect(comment.endsWith("or start it by its key in the TUI.")).toBe(true);
  });

  test("t44_given_up_in_memory_is_not_planned_again", () => {
    const list = tasks([task("T-A")]);
    const given = memory({
      attempts: { "T-A": { count: 3, last_at: NOW - 60_000, reason: "boom", given_up: true } },
    });
    const plan = planServe(input({ tasks: list, memory: given }));
    expect(of(plan.actions, "give_up")).toEqual([]);
    expect(startsOf(plan.actions)).toEqual([]);
  });
});

describe("t44 a resumed worker at a wait with no wait line", () => {
  test("t44_resumed_worker_at_a_hand_edit_wait_is_not_dead", () => {
    // gate (4000), decision (5000), resumed worker started after it; the pipeline file was edited by hand
    // while it worked, so the run waits with no new wait line
    const resumed = run("r_hand", {
      taskKey: "T-r_hand",
      waitsForPerson: true,
      marks: decisionOf(gateDecided()),
      worker: worker("r_hand", {
        id: "a_d4",
        name: "kw-r_hand-d4",
        state: "exited",
        label: "exited (0)",
        started: 6_000,
        since: 7_000,
        decisionSeq: 4,
      }),
    });
    const plan = planServe(
      input({ runs: [resumed], memory: memory({ mine: ["r_hand"], dead_in_a_row: 2 }) }),
    );
    expect(of(plan.actions, "note")).toEqual([]);
    expect(plan.memory.dead_in_a_row).toBe(0);
  });
});

describe("t44 a resume that keeps failing", () => {
  test("t44_failed_resume_is_retried_then_given_up", () => {
    const run = decided("r_res");
    const key = `r_res:${decisionOf(gateDecided()).decision?.seq}`;
    const list = tasks([task("T-N")]);
    // a failed attempt waits 60 s; meanwhile it goes before any start, as a waiting resume does
    const soon = planServe(
      input({
        runs: [run],
        tasks: list,
        memory: memory({
          resume_attempts: { [key]: { count: 1, last_at: NOW - 1_000, reason: "no claude" } },
        }),
      }),
    );
    expect(of(soon.actions, "resume")).toEqual([]);
    expect(soon.waiting.resumes).toEqual(["r_res"]);
    expect(startsOf(soon.actions)).toEqual([]);
    // after 60 s it is tried again
    const again = planServe(
      input({
        runs: [run],
        tasks: list,
        memory: memory({
          resume_attempts: { [key]: { count: 2, last_at: NOW - 60_000, reason: "no claude" } },
        }),
      }),
    );
    expect(of(again.actions, "resume")).toHaveLength(1);
    // after three: one line, no resume, no place held
    const gave = planServe(
      input({
        runs: [run],
        tasks: list,
        memory: memory({
          resume_attempts: { [key]: { count: 3, last_at: NOW - 60_000, reason: "no claude" } },
        }),
      }),
    );
    expect(of(gave.actions, "resume")).toEqual([]);
    expect(logsOf(gave.actions, "resume_failed")).toHaveLength(1);
    expect(gave.waiting.resumes).toEqual([]);
    expect(
      logsOf(
        planServe(input({ runs: [run], tasks: list, memory: gave.memory })).actions,
        "resume_failed",
      ),
    ).toEqual([]);
  });
});

describe("t44 the plan is pure", () => {
  test("t44_plan_is_pure", () => {
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

/** A step served after the decision at seq 4 (ts 5000): an agent went on. */
const movedAfter = (decidedAt = 5_000) =>
  [...gateDecided(decidedAt), ...build([{ event: "step_served" }])].map((r, i) => ({
    ...r,
    seq: i + 1,
    ...(i === 4 ? { ts: 6_000 } : {}),
  })) as JournalRecord[];

/** A worker in a terminal of its own. */
const terminal = (runId: string, over: Partial<ServeWorkerView> = {}): ServeWorkerView =>
  worker(runId, { terminal: true, ...over });

/** A run that only waits for the person, its worker alive in its terminal. */
const waitingWith = (runId: string, over: Partial<ServeRunView> = {}): ServeRunView =>
  run(runId, {
    taskKey: `T-${runId}`,
    waitsForPerson: true,
    idleAtWait: true,
    marks: decisionOf(gateWaiting),
    marksAt: NOW,
    worker: terminal(runId),
    ...over,
  });

/** The ends of a terminal session that may have found the agent waiting. */
const ENDS: [string, Partial<ServeWorkerView>][] = [
  ["exited", { state: "exited", label: "exited (0)", exitCode: 0 }],
  ["lost", { state: "lost", label: "lost (holder gone)", endedBy: "holder_gone" }],
  ["timeout", { state: "killed", label: "killed (timeout)", endedBy: "timeout" }],
  ["holder error", { state: "killed", label: "failed (could not start)", endedBy: "holder_error" }],
];

const kinds = (actions: ServeAction[]) => actions.map((a) => a.kind);

describe("t44 a worker that stays alive at a wait (T-45)", () => {
  test("t44_waiting_worker_holds_a_run_place_only", () => {
    const plan = planServe(input({ runs: [waitingWith("r_w")], tasks: tasks([]) }));
    expect(plan.counts).toMatchObject({ workers: 0, alive: 1, runs: ["r_w"] });
    expect(servePlaces([waitingWith("r_w")])).toEqual({ workers: 0, runs: ["r_w"] });
    // The same worker at work holds both.
    const working = run("r_w", { taskKey: "T-r_w", worker: terminal("r_w"), marksAt: NOW });
    expect(servePlaces([working])).toEqual({ workers: 1, runs: ["r_w"] });
    // Nothing is done about a worker that waits with the person.
    expect(plan.actions).toEqual([]);
  });

  test("t44_reviews_are_bounded_by_max_runs", () => {
    const limits = rules({ max_workers: 1, max_runs: 3 });
    // One run at a gate with its worker alive: the worker place is free, a second task starts.
    const one = planServe(
      input({ rules: limits, runs: [waitingWith("r_1")], tasks: tasks([task("T-NEW")]) }),
    );
    expect(startsOf(one.actions)).toEqual(["T-NEW"]);
    // Three open runs that wait: the reviews pile up no further.
    const three = planServe(
      input({
        rules: limits,
        runs: [waitingWith("r_1"), waitingWith("r_2"), waitingWith("r_3")],
        tasks: tasks([task("T-NEW")]),
      }),
    );
    expect(startsOf(three.actions)).toEqual([]);
    expect(three.counts).toMatchObject({ workers: 0, alive: 3 });
    expect(three.counts.runs).toHaveLength(3);
    expect(three.waiting.starts).toEqual(["T-NEW"]);
    expect(admitStart({ task: task("T-NEW"), runs: [waitingWith("r_1")], limits })).toEqual({
      ok: true,
    });
  });

  test("t44_fork_with_work_left_counts_as_working", () => {
    // One branch waits for the person, another has a step for the agent: the answer is no wait.
    const fork = waitingWith("r_f", { idleAtWait: false });
    expect(servePlaces([fork])).toEqual({ workers: 1, runs: ["r_f"] });
    const plan = planServe(
      input({
        rules: rules({ max_workers: 1, max_runs: 3 }),
        runs: [fork],
        tasks: tasks([task("T-NEW")]),
      }),
    );
    expect(startsOf(plan.actions)).toEqual([]);
    expect(plan.counts).toMatchObject({ workers: 1, alive: 1 });
  });

  test("t44_only_a_known_waiting_terminal_worker_frees_its_place", () => {
    const idle = (w: ServeWorkerView) => waitingWith("r_x", { worker: w });
    // A print worker that is alive works, whatever its run's answer is.
    expect(servePlaces([idle(worker("r_x"))]).workers).toBe(1);
    // A record that cannot be read, and a session that is still starting.
    expect(servePlaces([idle(terminal("r_x", { state: "unknown" }))]).workers).toBe(1);
    expect(servePlaces([idle(terminal("r_x", { state: "starting" }))]).workers).toBe(1);
    // A run whose answer was not read is not known to wait.
    const { idleAtWait: _none, ...unread } = waitingWith("r_x");
    expect(servePlaces([unread]).workers).toBe(1);
    // A live worker of a run that cannot be read holds both places.
    const broken = {
      runId: "r_b",
      why: "cannot_read" as const,
      detail: "x",
      worker: terminal("r_b"),
    };
    expect(servePlaces([], [broken])).toEqual({ workers: 1, runs: ["r_b"] });
    // Only this one frees its worker place.
    expect(servePlaces([idle(terminal("r_x"))]).workers).toBe(0);
  });

  test("t44_woken_worker_goes_on_and_the_daemon_adds_nothing", () => {
    const limits = rules({ max_workers: 1, max_runs: 5 });
    // A works; the person's decision woke B, which waited: two agents work under a limit of one.
    const busy = { started: NOW - 1_000, lastOutputAt: NOW };
    const a = run("r_a", {
      taskKey: "T-a",
      worker: terminal("r_a", busy),
      lastAgentAt: NOW,
      marksAt: NOW,
    });
    const b = run("r_b", {
      taskKey: "T-b",
      worker: terminal("r_b", busy),
      marks: decisionOf(movedAfter()),
      lastAgentAt: NOW,
      marksAt: NOW,
    });
    const first = planServe(
      input({
        rules: limits,
        runs: [a, b, decided("r_c")],
        memory: memory({ mine: ["r_a", "r_b", "r_c"] }),
        tasks: tasks([task("T-NEW")]),
      }),
    );
    expect(first.counts).toMatchObject({ workers: 2, alive: 2, max_workers: 1 });
    // No action against the worker, no start, no resume: one line.
    expect(first.actions.filter((action) => action.kind !== "log")).toEqual([]);
    expect(logsOf(first.actions).map((line) => line.problem)).toEqual(["over_limit", "queued"]);
    expect(logsOf(first.actions, "over_limit")[0]?.detail).toContain(
      "over the limit by 1 after your decisions",
    );
    expect(first.waiting).toEqual({ resumes: ["r_c"], starts: ["T-NEW"] });
    expect(first.memory.dead_in_a_row).toBe(0);
    const again = planServe(
      input({
        rules: limits,
        runs: [a, b, decided("r_c")],
        memory: first.memory,
        tasks: tasks([task("T-NEW")]),
      }),
    );
    expect(again.actions).toEqual([]);
  });

  test("t44_count_recovers_and_one_start_follows", () => {
    const limits = rules({ max_workers: 1, max_runs: 5 });
    const working = (id: string) =>
      run(id, { taskKey: `T-${id}`, worker: terminal(id), marksAt: NOW });
    const list = tasks([task("T-1"), task("T-2")]);
    const over = planServe(
      input({ rules: limits, runs: [working("r_a"), working("r_b")], tasks: list }),
    );
    expect(startsOf(over.actions)).toEqual([]);
    // One reaches a wait: the limit is full, not over. Still no start, and the line is forgotten.
    const full = planServe(
      input({
        rules: limits,
        runs: [waitingWith("r_a"), working("r_b")],
        memory: over.memory,
        tasks: list,
      }),
    );
    expect(startsOf(full.actions)).toEqual([]);
    expect(full.memory.logged).not.toContain("over_limit");
    // Both wait: exactly one of the waiting starts goes in that cycle.
    const free = planServe(
      input({
        rules: limits,
        runs: [waitingWith("r_a"), waitingWith("r_b")],
        memory: full.memory,
        tasks: list,
      }),
    );
    expect(startsOf(free.actions)).toEqual(["T-1"]);
    expect(free.waiting.starts).toEqual(["T-2"]);
    // A later excess is said again.
    const later = planServe(
      input({ rules: limits, runs: [working("r_a"), working("r_b")], memory: free.memory }),
    );
    expect(logsOf(later.actions, "over_limit")).toHaveLength(1);
  });

  test("t44_child_alive_is_never_resumed_or_finished", () => {
    const journals: [string, Partial<ServeRunView>][] = [
      ["at a wait", { waitsForPerson: true, marks: decisionOf(gateWaiting) }],
      ["decided", { marks: decisionOf(gateDecided()) }],
      ["decided and moved", { marks: decisionOf(movedAfter()) }],
      ["not at a wait", { marks: decisionOf(build([{ event: "run_started" }])) }],
      ["ended", { status: "completed" }],
    ];
    for (const state of ["lost", "killed"] as const) {
      for (const isTerminal of [true, false]) {
        for (const [what, view] of journals) {
          const w = worker("r_o", {
            state,
            label: `${state} (child still runs)`,
            since: 4_500,
            childAlive: true,
            ...(isTerminal ? { terminal: true, endedBy: "holder_gone" } : {}),
          });
          const r = run("r_o", { taskKey: "T-o", worker: w, ...view });
          const name = `${state}, ${isTerminal ? "terminal" : "print"}, ${what}`;
          const plan = planServe(input({ runs: [r], memory: memory({ mine: ["r_o"] }) }));
          // Nothing is done but one line that names the command.
          expect(kinds(plan.actions), name).toEqual(["log"]);
          const line = logsOf(plan.actions, "child_alive")[0];
          expect(line?.detail, name).toBe(
            `kw-r_o: its process still runs without a holder; stop it: kodel agent stop ${w.id}`,
          );
          expect(plan.memory.dead_in_a_row, name).toBe(0);
          expect(
            plan.memory.logged.some((m) => m === `ended:${w.id}`),
            name,
          ).toBe(false);
          expect(plan.counts.workers, name).toBe(1);
          expect(planServe(input({ runs: [r], memory: plan.memory })).actions, name).toEqual([]);
        }
      }
    }
  });

  test("t44_child_alive_holds_both_places", () => {
    const orphan = (id: string, over: Partial<ServeWorkerView> = {}) =>
      worker(id, { state: "lost", label: "lost (child still runs)", childAlive: true, ...over });
    // A run that reads.
    const readable = run("r_r", {
      taskKey: "T-r",
      marks: decisionOf(gateDecided()),
      worker: orphan("r_r", { since: 4_500 }),
    });
    expect(servePlaces([readable])).toEqual({ workers: 1, runs: ["r_r"] });
    // A run that cannot be read: a `lost` or `killed` worker frees its places only when it is gone.
    const broken = (w: ServeWorkerView) => ({
      runId: "r_b",
      why: "cannot_read" as const,
      detail: "x",
      worker: w,
    });
    for (const state of ["lost", "killed"] as const) {
      expect(servePlaces([], [broken(orphan("r_b", { state }))])).toEqual({
        workers: 1,
        runs: ["r_b"],
      });
      expect(servePlaces([], [broken(worker("r_b", { state }))])).toEqual({ workers: 0, runs: [] });
    }
    // With both places held under limits of one, nothing is started; the line is said for the unreadable run too.
    const plan = planServe(
      input({ unreadable: [broken(orphan("r_b"))], tasks: tasks([task("T-NEW")]) }),
    );
    expect(startsOf(plan.actions)).toEqual([]);
    expect(logsOf(plan.actions, "child_alive")).toHaveLength(1);
    expect(plan.counts).toMatchObject({ workers: 1, alive: 1, runs: ["r_b"] });
  });

  test("t44_child_alive_then_stopped_follows_the_rules", () => {
    const at = (w: Partial<ServeWorkerView>, journal = gateDecided()) =>
      planServe(
        input({
          runs: [
            run("r_o", {
              taskKey: "T-o",
              marks: decisionOf(journal),
              worker: terminal("r_o", { since: 4_500, ...w }),
            }),
          ],
          memory: memory({ mine: ["r_o"] }),
        }),
      );
    // While its process runs: nothing.
    expect(kinds(at({ state: "lost", childAlive: true }).actions)).toEqual(["log"]);
    // The person stopped it (`kodel agent stop`): the daemon leaves the resume to the person and
    // frees its places; no note, no death.
    const stopped = at({ state: "killed", stopped: true, endedBy: "stopped" });
    expect(stopped.actions).toEqual([]);
    expect(stopped.counts).toMatchObject({ workers: 0, runs: [] });
    expect(stopped.memory.dead_in_a_row).toBe(0);
    // It ended by itself at the wait: resumed after the decision, as any worker that ended there.
    const ended = at({ state: "lost", endedBy: "holder_gone" });
    expect(kinds(ended.actions)).toEqual(["resume"]);
    // A print worker whose process is gone at last is a dead worker, as before.
    const print = planServe(
      input({
        runs: [
          run("r_o", {
            taskKey: "T-o",
            marks: decisionOf(gateDecided()),
            worker: worker("r_o", { state: "lost", since: 4_500 }),
          }),
        ],
        memory: memory({ mine: ["r_o"] }),
      }),
    );
    expect(of(print.actions, "note")).toMatchObject([{ reason: "lost" }]);
    expect(print.memory.dead_in_a_row).toBe(1);
  });

  test("t44_worker_that_ended_at_a_wait_is_resumed", () => {
    for (const [what, end] of ENDS) {
      const w = terminal("r_e", { since: 4_500, ...end });
      // While the run waits and nothing is decided: no note, no death, its `max_runs` place kept.
      const waiting = planServe(
        input({
          runs: [
            run("r_e", {
              taskKey: "T-e",
              waitsForPerson: true,
              idleAtWait: true,
              marks: decisionOf(gateWaiting),
              worker: w,
            }),
          ],
          memory: memory({ mine: ["r_e"] }),
        }),
      );
      expect(waiting.actions, what).toEqual([]);
      expect(waiting.memory.dead_in_a_row, what).toBe(0);
      expect(waiting.counts, what).toMatchObject({ workers: 0, alive: 0, runs: ["r_e"] });
      // After the decision: resumed, once.
      const decidedRun = run("r_e", {
        taskKey: "T-e",
        marks: decisionOf(gateDecided()),
        worker: w,
      });
      const after = planServe(input({ runs: [decidedRun], memory: waiting.memory }));
      expect(of(after.actions, "resume"), what).toEqual([
        { kind: "resume", runId: "r_e", seq: 4, sessionId: "s-1" },
      ]);
      expect(of(after.actions, "note"), what).toEqual([]);
      const resumed = planServe(
        input({
          runs: [{ ...decidedRun, worker: { ...w, resumed: [4] } }],
          memory: after.memory,
        }),
      );
      expect(resumed.actions, what).toEqual([]);
    }
    // A terminal session that never came up did not wait: dead, as before.
    for (const endedBy of ["start_late", "rules_unknown"]) {
      const never = planServe(
        input({
          runs: [
            run("r_e", {
              taskKey: "T-e",
              marks: decisionOf(gateDecided()),
              worker: terminal("r_e", { state: "killed", since: 4_500, endedBy }),
            }),
          ],
        }),
      );
      expect(of(never.actions, "note"), endedBy).toMatchObject([{ reason: "killed" }]);
    }
  });

  test("t44_worker_that_died_after_the_decision_is_dead", () => {
    // Waited at W1, the person decided, an agent's line follows the decision, then the worker ended.
    for (const [what, end] of ENDS) {
      const died = run("r_d", {
        taskKey: "T-d",
        marks: decisionOf(movedAfter()),
        worker: terminal("r_d", { since: 7_000, lastOutputAt: 6_500, ...end }),
      });
      const plan = planServe(
        input({ runs: [died], memory: memory({ mine: ["r_d"] }), tasks: tasks([]) }),
      );
      // One `gone` note, counted, its `max_runs` place freed, no resume with that decision's prompt.
      expect(kinds(plan.actions), what).toEqual(["note"]);
      expect(of(plan.actions, "note")[0], what).toMatchObject({
        runId: "r_d",
        reason: end.state,
      });
      expect(plan.memory.dead_in_a_row, what).toBe(1);
      expect(plan.counts, what).toMatchObject({ workers: 0, runs: [] });
      // Noted once.
      const noted = planServe(
        input({ runs: [{ ...died, noted: [died.worker?.id ?? ""] }], memory: plan.memory }),
      );
      expect(noted.actions, what).toEqual([]);
      expect(noted.memory.dead_in_a_row, what).toBe(1);
    }
  });

  test("t44_decision_while_the_holder_dies", () => {
    // The end of the session and the decision around one instant, with and without an agent's line
    // after the decision: one of resume, `moved` or a death; never a resume and a death together.
    for (const [what, end] of ENDS) {
      for (const since of [4_999, 5_000, 5_001]) {
        for (const journal of [gateDecided(), movedAfter()]) {
          const r = run("r_h", {
            taskKey: "T-h",
            marks: decisionOf(journal),
            worker: terminal("r_h", { since, lastOutputAt: since, ...end }),
          });
          const plan = planServe(input({ runs: [r], memory: memory({ mine: ["r_h"] }) }));
          const name = `${what} at ${since}, ${journal.length} lines`;
          const got: string[] = kinds(plan.actions).filter((k) => k !== "log");
          expect(got.length, name).toBeLessThanOrEqual(1);
          const moved = journal.length === 5;
          const expected: string[] = !moved ? ["resume"] : since > 5_000 ? ["note"] : [];
          expect(got, name).toEqual(expected);
          expect(plan.memory.dead_in_a_row, name).toBe(expected[0] === "note" ? 1 : 0);
        }
      }
    }
  });

  test("t44_terminal_stalled_needs_no_output_and_no_call", () => {
    const limit = 1800 * 1000;
    const at = (w: Partial<ServeWorkerView>, r: Partial<ServeRunView> = {}) =>
      planServe(input({ runs: [run("r_s", { worker: terminal("r_s", w), marksAt: NOW, ...r })] }));
    // A step open, nothing printed and nothing called for that long: one line.
    const quiet = at({ started: 0, lastOutputAt: NOW - limit }, { lastAgentAt: NOW - limit });
    expect(logsOf(quiet.actions, "stalled")).toMatchObject([
      { runId: "r_s", detail: "kw-r_s printed nothing and called nothing for 1800 s" },
    ]);
    expect(quiet.stalled).toEqual([
      { runId: "r_s", worker: "kw-r_s", quietS: 1800, holdsWorker: true, holdsRun: true },
    ]);
    // Output alone puts it off, and so does a call alone.
    expect(at({ started: 0, lastOutputAt: NOW - 1_000 }, { lastAgentAt: 1 }).stalled).toEqual([]);
    expect(at({ started: 0, lastOutputAt: 1 }, { lastAgentAt: NOW - 1_000 }).stalled).toEqual([]);
    // The calls are read from the journal: a read that is older than the quiet spell shows nothing yet.
    expect(
      at({ started: 0, lastOutputAt: 1 }, { lastAgentAt: 1, marksAt: limit - 1 }).stalled,
    ).toEqual([]);
    const { marksAt: _none, ...unread } = run("r_s", {
      worker: terminal("r_s", { started: 0 }),
      marksAt: NOW,
    });
    expect(planServe(input({ runs: [unread] })).stalled).toEqual([]);
    // A print worker by its output, as before, whatever was called.
    const print = planServe(
      input({
        runs: [
          run("r_s", {
            worker: worker("r_s", { started: 0, lastOutputAt: NOW - limit }),
            lastAgentAt: NOW,
            marksAt: NOW,
          }),
        ],
      }),
    );
    expect(logsOf(print.actions, "stalled")[0]?.detail).toBe("kw-r_s printed nothing for 1800 s");
    // Once per quiet spell.
    expect(
      logsOf(
        planServe(
          input({
            now: NOW + 5_000,
            runs: [
              run("r_s", {
                worker: terminal("r_s", { started: 0, lastOutputAt: NOW - limit }),
                lastAgentAt: NOW - limit,
                marksAt: NOW + 5_000,
              }),
            ],
            memory: quiet.memory,
          }),
        ).actions,
        "stalled",
      ),
    ).toEqual([]);
  });

  test("t44_long_step_that_prints_is_not_stalled", () => {
    // Hours in one step with no call of the engine: it prints, so it works.
    const plan = planServe(
      input({
        runs: [
          run("r_l", {
            worker: terminal("r_l", { started: 0, lastOutputAt: NOW - 30_000 }),
            lastAgentAt: NOW - 4 * 3_600_000,
            marksAt: NOW,
          }),
        ],
      }),
    );
    expect(plan.stalled).toEqual([]);
    expect(logsOf(plan.actions, "stalled")).toEqual([]);
  });

  test("t44_stalled_skips_a_worker_that_waits_with_the_person", () => {
    // Days at a gate, nothing printed, nothing called: it waits with the person, it is not stalled.
    const waiting = waitingWith("r_g", {
      worker: terminal("r_g", { started: 0, lastOutputAt: 1 }),
    });
    const plan = planServe(input({ runs: [waiting] }));
    expect(plan.stalled).toEqual([]);
    expect(plan.actions).toEqual([]);
    // Nor a session whose run is over (that one is ended).
    const over = planServe(
      input({
        runs: [
          run("r_g", {
            status: "completed",
            worker: terminal("r_g", { started: 0 }),
            marksAt: NOW,
          }),
        ],
      }),
    );
    expect(over.stalled).toEqual([]);
  });

  test("t44_stalled_by_calls_alone_when_idle_writes", () => {
    // An agent that writes to its terminal while idle: its output says nothing, only its calls do.
    const limit = 1800 * 1000;
    const at = (lastAgentAt: number) =>
      planServe(
        input({
          runs: [
            run("r_i", {
              worker: terminal("r_i", { started: 0, lastOutputAt: NOW - 1_000, idleWrites: true }),
              lastAgentAt,
              marksAt: NOW,
            }),
          ],
        }),
      );
    expect(logsOf(at(NOW - limit).actions, "stalled")).toMatchObject([
      { detail: "kw-r_i: no engine call for 1800 s (it may be a long step)" },
    ]);
    expect(at(NOW - limit + 1).stalled).toEqual([]);
  });

  test("t44_finish_at_once_when_the_run_ended", () => {
    for (const status of ["completed", "failed", "canceled"] as const) {
      const ended = run("r_f", { status, worker: terminal("r_f") });
      const plan = planServe(input({ runs: [ended] }));
      expect(plan.actions, status).toEqual([
        { kind: "finish", runId: "r_f", worker: "kw-r_f", id: "a_r_f" },
      ]);
      // Until it has stopped it is alive and holds its worker place.
      expect(plan.counts, status).toMatchObject({ workers: 1, alive: 1, runs: [] });
    }
    // A daemon that is off acts on nothing.
    expect(
      planServe(
        input({
          rules: rules({ enabled: false }),
          runs: [run("r_f", { status: "completed", worker: terminal("r_f") })],
        }),
      ).actions,
    ).toEqual([]);
  });

  test("t44_one_finish_a_cycle", () => {
    // A stop may take seconds under the start lock: one a cycle, so a start that waits for it is served.
    const ended = (id: string) => run(id, { status: "completed", worker: terminal(id) });
    let runs = [ended("r_3"), ended("r_1"), ended("r_2")];
    const finished: string[] = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      const plan = planServe(input({ runs }));
      const finishes = of(plan.actions, "finish");
      expect(finishes.length).toBeLessThanOrEqual(1);
      const [finish] = finishes;
      if (finish === undefined) break;
      finished.push(finish.runId);
      // The session it stopped reads `killed`, stopped, from the next cycle on.
      runs = runs.map((r) =>
        r.runId === finish.runId
          ? {
              ...r,
              worker: terminal(r.runId, { state: "killed", stopped: true, endedBy: "stopped" }),
            }
          : r,
      );
    }
    expect(finished).toEqual(["r_1", "r_2", "r_3"]);
    expect(planServe(input({ runs })).actions).toEqual([]);
  });

  test("t44_no_finish_for_an_open_or_unreadable_run", () => {
    const none = (r: Partial<ServeInput>) => of(planServe(input(r)).actions, "finish");
    expect(none({ runs: [run("r_o", { worker: terminal("r_o"), marksAt: NOW })] })).toEqual([]);
    expect(
      none({ runs: [run("r_o", { status: "paused", worker: terminal("r_o"), marksAt: NOW })] }),
    ).toEqual([]);
    expect(none({ runs: [waitingWith("r_o")] })).toEqual([]);
    // A run that cannot be read is not known to have ended.
    expect(
      none({
        unreadable: [{ runId: "r_u", why: "cannot_read", detail: "x", worker: terminal("r_u") }],
      }),
    ).toEqual([]);
    // A session that is over already.
    expect(
      none({
        runs: [
          run("r_o", {
            status: "completed",
            worker: terminal("r_o", { state: "exited", since: 4_500 }),
          }),
        ],
      }),
    ).toEqual([]);
  });

  test("t44_finish_is_for_terminal_workers_only", () => {
    // A print worker of an ended run is left to print its last line and exit.
    const plan = planServe(
      input({
        runs: [run("r_p", { status: "completed", worker: worker("r_p", { started: NOW }) })],
      }),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.counts).toMatchObject({ workers: 1, alive: 1 });
  });

  test("t44_finish_takes_the_live_record", () => {
    // The run's worker is its latest record: the resumed session is the one that lives and is ended.
    const live = terminal("r_l", {
      id: "a_live",
      name: "kw-r_l-d7",
      decisionSeq: 7,
      resumed: [7],
      resumes: 1,
    });
    const plan = planServe(input({ runs: [run("r_l", { status: "completed", worker: live })] }));
    expect(plan.actions).toEqual([
      { kind: "finish", runId: "r_l", worker: "kw-r_l-d7", id: "a_live" },
    ]);
  });

  test("t44_not_moving_is_logged_and_nothing_is_typed", () => {
    // Decided at 5000, the worker was alive at the decision, no agent's line since.
    const at = (marksAt: number, journal = gateDecided(), w: Partial<ServeWorkerView> = {}) =>
      planServe(
        input({
          now: marksAt,
          runs: [
            run("r_n", {
              taskKey: "T-n",
              marks: decisionOf(journal),
              lastAgentAt: 3_000,
              marksAt,
              worker: terminal("r_n", { started: 1_000, ...w }),
            }),
          ],
        }),
      );
    expect(at(5_000 + NOT_MOVING_MS - 1).actions).toEqual([]);
    const late = at(5_000 + NOT_MOVING_MS);
    // One line, and no other action: nothing is typed, stopped or started for the person.
    expect(late.actions).toEqual([
      {
        kind: "log",
        mark: "not_moving:r_n:4",
        problem: "not_moving",
        runId: "r_n",
        detail:
          "kw-r_n has not gone on since your decision (120 s); nothing is typed for you, open it: kodel agent attach a_r_n",
      },
    ]);
    // Once per decision.
    const again = planServe(
      input({
        now: 5_000 + NOT_MOVING_MS + 5_000,
        runs: [
          run("r_n", {
            taskKey: "T-n",
            marks: decisionOf(gateDecided()),
            lastAgentAt: 3_000,
            marksAt: 5_000 + NOT_MOVING_MS + 5_000,
            worker: terminal("r_n", { started: 1_000 }),
          }),
        ],
        memory: late.memory,
      }),
    );
    expect(again.actions).toEqual([]);
    // It went on: no line. A journal read before the two minutes were over proves nothing yet.
    expect(at(5_000 + NOT_MOVING_MS, movedAfter()).actions).toEqual([]);
    // A print worker, and a decision an agent made, are not this case.
    expect(logsOf(at(5_000 + NOT_MOVING_MS, gateDecided(), { terminal: false }).actions)).toEqual(
      [],
    );
    const byAgent = gateDecided().map((r) =>
      r.event === "gate_decided" ? { ...r, decided_by: "agent" } : r,
    ) as JournalRecord[];
    expect(logsOf(at(5_000 + NOT_MOVING_MS, byAgent).actions, "not_moving")).toEqual([]);
  });

  test("t44_not_moving_skips_a_run_that_waits_again", () => {
    // Two gates in a row: the decision led straight to the next wait, and the worker waits with the person.
    const second = [...gateDecided(), ...build([{ event: "gate_waiting", node: "g2" }])].map(
      (r, i) => ({ ...r, seq: i + 1, ...(i === 4 ? { ts: 5_500 } : {}) }),
    ) as JournalRecord[];
    const plan = planServe(
      input({
        now: 5_000 + 10 * NOT_MOVING_MS,
        runs: [
          run("r_n", {
            taskKey: "T-n",
            waitsForPerson: true,
            idleAtWait: true,
            marks: decisionOf(second),
            lastAgentAt: 3_000,
            marksAt: 5_000 + 10 * NOT_MOVING_MS,
            worker: terminal("r_n", { started: 1_000 }),
          }),
        ],
      }),
    );
    expect(plan.actions).toEqual([]);
  });

  test("t44_no_first_call_is_logged_once", () => {
    const at = (marksAt: number, more: Partial<ServeRunView> = {}, mem = memory()) =>
      planServe(
        input({
          now: marksAt,
          runs: [
            run("r_c", {
              taskKey: "T-c",
              marksAt,
              worker: terminal("r_c", { started: 1_000 }),
              ...more,
            }),
          ],
          memory: mem,
        }),
      );
    expect(at(1_000 + NOT_MOVING_MS - 1).actions).toEqual([]);
    const late = at(1_000 + NOT_MOVING_MS);
    expect(logsOf(late.actions, "no_first_call")).toMatchObject([
      {
        mark: "no_first_call:a_r_c",
        runId: "r_c",
        detail:
          "kw-r_c has not called the engine 120 s after its start; open it: kodel agent attach a_r_c",
      },
    ]);
    expect(kinds(late.actions)).toEqual(["log"]);
    expect(at(1_000 + NOT_MOVING_MS + 5_000, {}, late.memory).actions).toEqual([]);
    // It called: no line. A call before this session started (a resumed one) is not its call.
    expect(at(1_000 + NOT_MOVING_MS, { lastAgentAt: 1_500 }).actions).toEqual([]);
    expect(logsOf(at(1_000 + NOT_MOVING_MS, { lastAgentAt: 900 }).actions)).toHaveLength(1);
  });
});
