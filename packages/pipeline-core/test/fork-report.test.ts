/**
 * The report of a run with forks (T-40): wall-clock time while something ran, the critical path of
 * each fork, the overlap of its branches, gates counted once while open together, the flag for a
 * join entered after failed branches, and the per-visit agent-log numbers marked as unreliable.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AGENT_LOG,
  decide,
  defaultHistory,
  type JournalRecord,
  type PipelineSpec,
  parsePipeline,
  type RunEvent,
  type RunState,
  summarizeRun,
} from "../src";

const yaml = (lines: string[]) => `${lines.join("\n")}\n`;

/** Two command branches that a test ends by hand, a join of the agent. */
const COMMANDS = parsePipeline(
  yaml([
    "name: fork",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: a, kind: command, command: a }",
    "  - { slug: b, kind: command, command: b }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: merge }",
    "  - { from: a, to: merge, when: failed }",
    "  - { from: b, to: merge }",
    "  - { from: b, to: merge, when: failed }",
  ]),
);

/** A branch with a rework loop (`b-test` fails back to `b`), the other a gate. */
const MIXED = parsePipeline(
  yaml([
    "name: mixed",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: a, kind: agent, prompt: a }",
    "  - { slug: a-gate, kind: human, prompt: a? }",
    "  - { slug: b, kind: agent, prompt: b }",
    "  - { slug: b-test, kind: command, command: b-test }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: a-gate }",
    "  - { from: a-gate, to: merge, when: approved }",
    "  - { from: a-gate, to: a, when: rejected }",
    "  - { from: b, to: b-test }",
    "  - { from: b-test, to: merge }",
    "  - { from: b-test, to: b, when: failed }",
  ]),
);

/** Two gates side by side, open at the same time. */
const GATES = parsePipeline(
  yaml([
    "name: gates",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: ga, kind: human, prompt: a? }",
    "  - { slug: gb, kind: human, prompt: b? }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: ga }",
    "  - { from: plan, to: gb }",
    "  - { from: ga, to: merge, when: approved }",
    "  - { from: ga, to: merge, when: rejected }",
    "  - { from: gb, to: merge, when: approved }",
    "  - { from: gb, to: merge, when: rejected }",
  ]),
);

const START: RunEvent = { type: "start", runId: "r1", task: "split the work", specHash: "h" };
const done = (node: string, attempt = 1): RunEvent => ({ type: "agent_completed", node, attempt });
const work = (node: string, passed: boolean, attempt = 1): RunEvent => ({
  type: "work_finished",
  node,
  attempt,
  passed,
  reason: passed ? "" : "red",
});
const approve = (node: string): RunEvent => ({ type: "human_decided", node, decision: "approved" });

/** Run the events at the given times (seconds); return the state and the whole journal. */
function play(spec: PipelineSpec, steps: [number, RunEvent][]) {
  let state: RunState | undefined;
  const journal: JournalRecord[] = [];
  for (const [at, event] of steps) {
    const result = decide(spec, state, event, at * 1000);
    if (!result.ok) throw result.error;
    state = result.state;
    journal.push(...result.journal);
  }
  return { state: state as RunState, journal };
}

describe("t40 the report of a fork", () => {
  test("t40_report_busy_wall_and_critical_path", () => {
    // plan 0-10; a and b start at 10; a ends at 40 (30 s), b at 25 (15 s); merge 40-50
    const { state, journal } = play(COMMANDS, [
      [0, START],
      [10, done("plan")],
      [25, work("b", true)],
      [40, work("a", true)],
      [50, done("merge")],
    ]);
    const report = summarizeRun(state, journal);
    expect(report.status).toBe("completed");
    // the attempts add up to 10 + 30 + 15 + 10; the clock saw 50 s of work
    expect(report.work_s).toBe(65);
    expect(report.busy_wall_s).toBe(50);
    expect(report.total_s).toBe(50);
    expect(report.forks).toEqual([
      {
        fork: "f1",
        from: "plan",
        label: "passed",
        join: "merge",
        branches: ["a", "b"],
        arrived: ["a", "b"],
        failed: [],
        unfinished: [],
        joined: 1,
        overlaps: [{ branches: ["a", "b"], seconds: 15 }],
      },
    ]);
    expect(report.critical_path).toEqual([
      { fork: "f1", branch: "a", seconds: 30, attempts: [{ node: "a", attempt: 1, seconds: 30 }] },
    ]);
    expect(report.failed_branches).toBe(false);
  });

  test("t40_critical_path_tie_by_trail_order", () => {
    // both branches take 20 s: the first edge's branch is the path
    const { state, journal } = play(COMMANDS, [
      [0, START],
      [10, done("plan")],
      [30, work("b", true)],
      [30, work("a", true)],
      [40, done("merge")],
    ]);
    const report = summarizeRun(state, journal);
    expect(report.critical_path[0]).toMatchObject({ branch: "a", seconds: 20 });
    expect(report.forks[0]?.overlaps).toEqual([{ branches: ["a", "b"], seconds: 20 }]);
  });

  test("t40_rework_counts_in_its_branch", () => {
    // b-test fails once and b is reworked inside its branch: both attempts of b and both of b-test
    // are b's chain; the gate of a counts as its waiting time
    const { state, journal } = play(MIXED, [
      [0, START],
      [10, done("plan")],
      [20, done("a")], // a-gate opens at 20
      [15, done("b")], // b-test 15-
      [30, work("b-test", false)], // back to b at 30
      [45, done("b", 2)], // b-test again 45-
      [50, work("b-test", true, 2)], // b arrives at 50
      [70, approve("a-gate")], // a arrives at 70: the gate waited 50 s
      [80, done("merge")],
    ]);
    const report = summarizeRun(state, journal);
    const path = report.critical_path[0];
    expect(path?.branch).toBe("a");
    expect(path?.seconds).toBe(60); // a 10 + a-gate 50
    expect(path?.attempts).toEqual([
      { node: "a", attempt: 1, seconds: 10 },
      { node: "a-gate", attempt: 1, seconds: 50 },
    ]);
    // the other branch's chain holds its rework, in its own branch
    const bSpans = journal
      .filter((r) => r.event === "node_entered" && r.branch === "b")
      .map((r) => `${r.node}#${r.attempt}`);
    expect(bSpans).toEqual(["b#1", "b-test#1", "b#2", "b-test#2"]);
    expect(report.nodes.find((n) => n.node === "b")?.attempts).toHaveLength(2);
    expect(report.extra_attempts).toBe(2);
    expect(report.waiting_s).toBe(50);
    // work: plan 10, a 10, b 5+15, b-test 15+5, merge 10 = 70; the clock saw 0-80 minus nothing
    expect(report.work_s).toBe(70);
    expect(report.busy_wall_s).toBe(80 - 50 + 30); // 0-30 busy, 30-50 busy (b/b-test), 50-70 only the gate, 70-80 merge
  });

  test("t40_busy_wall_equals_work_without_overlap", () => {
    const { state, journal } = play(COMMANDS, [
      [0, START],
      [10, done("plan")],
      [20, work("a", true)],
      [20, work("b", true)],
      [30, done("merge")],
    ]);
    const report = summarizeRun(state, journal);
    // the branches ran together for the same 10 s: work counts both, the clock once
    expect(report.work_s).toBe(40);
    expect(report.busy_wall_s).toBe(30);
    // a run without a fork: the two are the same number
    const linear = parsePipeline(
      yaml([
        "name: linear",
        "nodes:",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: b, kind: agent, prompt: b }",
        "edges:",
        "  - { from: a, to: b }",
      ]),
    );
    const plain = play(linear, [
      [0, START],
      [10, done("a")],
      [25, done("b")],
    ]);
    const flat = summarizeRun(plain.state, plain.journal);
    expect(flat.work_s).toBe(25);
    expect(flat.busy_wall_s).toBe(25);
    expect(flat.forks).toEqual([]);
    expect(flat.critical_path).toEqual([]);
    expect(flat.failed_branches).toBe(false);
  });

  test("t40_waiting_union_of_gates", () => {
    // both gates open at 10; ga decided at 40, gb at 50: 40 s of waiting, not 70
    const { state, journal } = play(GATES, [
      [0, START],
      [10, done("plan")],
      [40, approve("ga")],
      [50, approve("gb")],
      [60, done("merge")],
    ]);
    const report = summarizeRun(state, journal);
    expect(report.waiting_s).toBe(40);
    expect(report.nodes.filter((n) => n.gate).map((n) => n.seconds)).toEqual([30, 40]);
    expect(report.busy_wall_s).toBe(20);
    expect(report.critical_path[0]).toMatchObject({ branch: "gb", seconds: 40 });
  });

  test("t40_open_fork_lists_unfinished_branches", () => {
    const { state, journal } = play(COMMANDS, [
      [0, START],
      [10, done("plan")],
      [25, work("b", false)],
    ]);
    const report = summarizeRun(state, journal);
    expect(report.status).toBe("running");
    expect(report.forks[0]).toMatchObject({
      arrived: ["b"],
      failed: ["b"],
      unfinished: ["a"],
      joined: 0,
    });
    // the join was not entered yet: nothing stands on the failure so far
    expect(report.failed_branches).toBe(false);
    // the open attempt of `a` runs to the last record the journal has
    expect(report.critical_path[0]).toMatchObject({ branch: "a", seconds: 15 });
  });

  test("t40_report_completed_with_failed_branches", () => {
    const { state, journal } = play(COMMANDS, [
      [0, START],
      [10, done("plan")],
      [20, work("a", true)],
      [25, work("b", false)],
      [30, done("merge")],
    ]);
    const report = summarizeRun(state, journal);
    expect(report.status).toBe("completed");
    expect(report.failed_branches).toBe(true);
    expect(report.forks[0]).toMatchObject({ arrived: ["a", "b"], failed: ["b"], joined: 1 });
    expect(journal.find((r) => r.event === "join_reached")?.failed).toEqual(["b"]);
  });

  test("t40_agent_log_numbers_marked_unverified_in_fork", () => {
    const { state, journal } = play(COMMANDS, [
      [0, START],
      [10, done("plan")],
      [20, work("a", true)],
      [25, work("b", true)],
      [30, done("merge")],
    ]);
    const log = {
      nodes: ["plan", "a", "b", "merge"],
      sessions: {},
      ticks: 1,
      steps: 2,
      bytes: 300,
      cut: 0,
      failed: [],
      visits: { "plan:1": 100, "merge:1": 200 },
    };
    const forked = summarizeRun({ ...state, agentLog: log }, journal).agent_log;
    expect(forked).toMatchObject({
      bytes: 300,
      unverified: true,
      visits: { "plan:1": 100, "merge:1": 200 },
      visits_unverified_in_fork: true,
    });
    // without a fork the per-visit numbers carry no such mark
    const { forks: _forks, ...flat } = state;
    const plain = summarizeRun({ ...flat, agentLog: log }, journal).agent_log;
    expect(plain).toMatchObject({ visits: { "plan:1": 100, "merge:1": 200 } });
    expect(plain).not.toHaveProperty("visits_unverified_in_fork");
  });

  test("t40_agent_log_numbers_unverified_in_fork_include_ended_in_step", () => {
    // the run is cancelled while two agent steps of a fork are open: both are "the step the run ended
    // in", and in a fork that list is as unreliable as the shares
    const agents = parsePipeline(
      yaml([
        "name: agents",
        "nodes:",
        "  - { slug: plan, kind: agent, prompt: plan }",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: b, kind: agent, prompt: b }",
        "  - { slug: merge, kind: agent, prompt: merge, join: all }",
        "edges:",
        "  - { from: plan, to: a }",
        "  - { from: plan, to: b }",
        "  - { from: a, to: merge }",
        "  - { from: b, to: merge }",
      ]),
    );
    const { state, journal } = play(agents, [
      [
        0,
        {
          ...START,
          history: {
            ...defaultHistory(),
            agent_log: { ...DEFAULT_AGENT_LOG, enabled: true },
          },
        },
      ],
      [10, done("plan")],
      [20, { type: "cancel" }],
    ]);
    expect(state.status).toBe("canceled");
    const report = summarizeRun(state, journal).agent_log;
    expect(report).toMatchObject({
      ended_in_step: ["a:1", "b:1"],
      final_pass: false,
      visits_unverified_in_fork: true,
    });
  });
});

test("t40_report_recheck_opens_a_span_of_its_own", () => {
  // a's check fails and holds the run from 12 s; the check is changed and run again at 100 s and
  // passes at 105 s: the held time between is not work
  const text = yaml([
    "name: recheck",
    "nodes:",
    "  - slug: a",
    "    kind: agent",
    "    prompt: a",
    "    max_consecutive_failures: 1",
    "    checks: [{ kind: command, command: c }]",
    "edges: []",
  ]);
  const before = parsePipeline(text);
  const after = parsePipeline(text.replace("command: c }", "command: c-fixed }"));
  const check = (passed: boolean): RunEvent => ({
    type: "check_finished",
    node: "a",
    attempt: 1,
    index: 0,
    passed,
    reason: passed ? "" : "red",
  });
  const played = play(before, [
    [0, START],
    [10, done("a")],
    [12, check(false)],
  ]);
  let state = played.state;
  const journal = [...played.journal];
  expect(state.pauses).toHaveLength(1);
  for (const [at, spec, event] of [
    [
      100,
      after,
      { type: "pipeline_accepted", from: "h", to: "h2", source: "file", before } as RunEvent,
    ],
    [105, after, check(true)],
  ] as [number, PipelineSpec, RunEvent][]) {
    const result = decide(spec, state, event, at * 1000);
    if (!result.ok) throw result.error;
    state = result.state;
    journal.push(...result.journal);
  }
  expect(journal.map((r) => r.event)).toContain("checks_rerun");
  expect(state.status).toBe("completed");
  expect(summarizeRun(state, journal).busy_wall_s).toBe(12 + 5);
});
