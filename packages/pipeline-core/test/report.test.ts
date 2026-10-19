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
