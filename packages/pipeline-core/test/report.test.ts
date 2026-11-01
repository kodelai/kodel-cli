import { describe, expect, test } from "bun:test";
import {
  decide,
  type JournalRecord,
  parsePipeline,
  type RunEvent,
  type RunState,
  summarizeRun,
} from "../src";

const spec = parsePipeline(
  [
    "name: p",
    "nodes:",
    "  - slug: work",
    "    kind: agent",
    "    prompt: do it",
    "  - slug: approve",
    "    kind: human",
    "    prompt: ok?",
    "edges:",
    "  - { from: work, to: approve }",
    "  - { from: approve, to: work, when: rejected }",
    "",
  ].join("\n"),
);

/** Run the events at the given times; return the state and the whole journal. */
function play(steps: [number, RunEvent][]) {
  let state: RunState | undefined;
  const journal: JournalRecord[] = [];
  for (const [now, event] of steps) {
    const result = decide(spec, state, event, now);
    if (!result.ok) throw result.error;
    state = result.state;
    journal.push(...result.journal);
  }
  return { state: state as RunState, journal };
}

const START: RunEvent = { type: "start", runId: "r1", task: "t", specHash: "h" };

describe("the slug of a run in its report", () => {
  test("is the one the run started with, or the name the task text gives a run that has none", () => {
    const titled = play([[0, { ...START, task: "Fix login", slug: "login-fix" }]]);
    expect(summarizeRun(titled.state, titled.journal).slug).toBe("login-fix");
    expect(titled.journal[0]).toMatchObject({ event: "run_started", slug: "login-fix" });

    // A run written before slugs existed: no `slug` in its state.
    const { slug: _slug, ...older } = titled.state;
    expect(summarizeRun(older, []).slug).toBe("fix-login");
  });
});

describe("summarizeRun", () => {
  const { state, journal } = play([
    [0, START],
    [10_000, { type: "agent_completed", node: "work", attempt: 1 }],
    [
      70_000,
      { type: "human_decided", node: "approve", decision: "rejected", reason: "split it up" },
    ],
    [85_000, { type: "agent_completed", node: "work", attempt: 2 }],
    [100_000, { type: "human_decided", node: "approve", decision: "approved" }],
  ]);
  const report = summarizeRun(state, journal);

  test("separates the time spent working from the time spent waiting for a person", () => {
    expect(report.total_s).toBe(100);
    expect(report.work_s).toBe(25); // 10 s, then 15 s again after the rejection
    expect(report.waiting_s).toBe(75); // 60 s the first time, 15 s the second
    expect(report.status).toBe("completed");
  });

  test("counts the attempts of each node and how much was redone", () => {
    const work = report.nodes.find((n) => n.node === "work");
    expect(work?.attempts.map((a) => [a.attempt, a.seconds, a.outcome])).toEqual([
      [1, 10, "passed"],
      [2, 15, "passed"],
    ]);
    expect(report.nodes.find((n) => n.node === "approve")?.gate).toBe(true);
    expect(work?.gate).toBe(false);
    expect(report.extra_attempts).toBe(2);
  });

  test("keeps why an attempt did not pass, and from where", () => {
    const approve = report.nodes.find((n) => n.node === "approve");
    expect(approve?.attempts[0]).toMatchObject({
      outcome: "rejected",
      failure: { source: "human", reason: "split it up" },
    });
    expect(approve?.attempts[1]?.failure).toBeUndefined();
  });

  test("a run still going is measured to the last thing that happened", () => {
    const running = play([
      [0, START],
      [10_000, { type: "agent_completed", node: "work", attempt: 1 }],
      [
        40_000,
        { type: "feedback", node: "work", category: "other", message: "the prompt is vague" },
      ],
    ]);
    const live = summarizeRun(running.state, running.journal);
    expect(live.status).toBe("running");
    expect(live.total_s).toBe(40);
    expect(live.waiting_s).toBe(30); // at the gate since second 10
    expect(live.feedback).toBe(1);
  });

  test("an empty history is a run with nothing in it, not an error", () => {
    const fresh = play([[5_000, START]]);
    const empty = summarizeRun(fresh.state, []);
    expect(empty.nodes).toEqual([]);
    expect(empty.total_s).toBe(0);
  });
});

describe("jspb_report_per_check", () => {
  let last = 0;
  const next = () => {
    last += 1;
    return last;
  };
  const finished = (
    check_id: string | undefined,
    passed: boolean,
    params_hash?: string,
    kind = "command",
  ): JournalRecord =>
    ({
      v: 2,
      seq: next(),
      ts: last * 1000,
      event: "check_finished",
      node: "work",
      attempt: 1,
      index: 0,
      kind,
      ...(check_id === undefined ? {} : { check_id }),
      ...(params_hash === undefined ? {} : { params_hash }),
      passed,
    }) as JournalRecord;
  const note = (category: string, check?: string): JournalRecord =>
    ({
      v: 2,
      seq: next(),
      ts: last * 1000,
      event: "feedback_reported",
      node: "work",
      attempt: 1,
      category,
      message: "m",
      ...(check === undefined ? {} : { check }),
    }) as JournalRecord;
  const state = play([[0, START]]).state;
  const checksOf = (...records: JournalRecord[]) => summarizeRun(state, records).checks;

  test("fail -> condition changed -> pass", () => {
    const [row] = checksOf(finished("t", false, "h1"), finished("t", true, "h2"));
    expect(row).toMatchObject({
      check_id: "t",
      runs: 2,
      fails: 1,
      params_changes: 1,
      after_change: { passed: 1, failed: 0 },
    });
  });

  test("fail -> condition changed -> fail again", () => {
    const [row] = checksOf(finished("t", false, "h1"), finished("t", false, "h2"));
    expect(row).toMatchObject({ params_changes: 1, after_change: { passed: 0, failed: 1 } });
  });

  test("the same hash again is not a change; going back to an earlier hash is", () => {
    const [row] = checksOf(
      finished("t", true, "h1"),
      finished("t", true, "h1"),
      finished("t", true, "h2"),
      finished("t", false, "h1"),
    );
    expect(row?.params_changes).toBe(2);
    expect(row?.after_change).toEqual({ passed: 1, failed: 1 });
  });

  test("two checks of one kind are two rows", () => {
    const rows = checksOf(finished("a", true, "x"), finished("b", false, "y"), finished("a", true));
    expect(rows.map((r) => [r.check_id, r.kind, r.runs, r.fails])).toEqual([
      ["a", "command", 2, 0],
      ["b", "command", 1, 1],
    ]);
  });

  test("wrong_check is counted once per note, for the check it names", () => {
    const rows = checksOf(
      finished("t", false),
      note("wrong_check", "t"),
      note("wrong_check", "t"),
      note("wrong_check"),
      note("other", "t"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.wrong_check).toBe(2);
  });

  test("a note naming a check that never ran is not a check and gets no row", () => {
    const rows = checksOf(note("wrong_check", "typo"), finished("real", true));
    expect(rows.map((r) => [r.check_id, r.wrong_check])).toEqual([["real", 0]]);
  });

  test("a check that is gone from the pipeline keeps its row from the journal", () => {
    const rows = checksOf(finished("old", false, "h1"), finished("new", true, "h9"));
    expect(rows.map((r) => r.check_id)).toEqual(["old", "new"]);
  });

  test("no checks, and a journal from before check_id, give no rows", () => {
    expect(checksOf()).toEqual([]);
    expect(checksOf(finished(undefined, false), finished(undefined, true))).toEqual([]);
  });
});
