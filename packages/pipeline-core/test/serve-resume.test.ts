/**
 * The resume rule (TASK-G8KM, T-44): one named case per verdict. The TUI words the same verdicts on
 * its card (`packages/cli/test/worker-resume.test.ts`); `kodel serve` acts on them.
 */
import { describe, expect, test } from "bun:test";
import type { JournalRecord } from "../src";
import {
  decisionOf,
  NOT_A_SIGN_OF_LIFE,
  type ResumeRunView,
  type ResumeVerdict,
  resumeVerdict,
  type ServeWorkerView,
  servePlaces,
} from "../src/serve";

const RUN = "r_0mwplcrq9_pavk";

function build(lines: Partial<JournalRecord>[]): JournalRecord[] {
  return lines.map((l, i) => ({
    v: 2,
    seq: i + 1,
    ts: 1_000 + (i + 1) * 1_000,
    event: "node_entered",
    ...l,
  })) as JournalRecord[];
}

/** Waited at a gate (seq 3, ts 4000), decided (seq 4, ts 5000). */
const GATE = build([
  { event: "run_started" },
  { event: "node_entered", node: "plan" },
  { event: "gate_waiting", node: "plan-approval", attempt: 1 },
  { event: "gate_decided", node: "plan-approval", decision: "approved" },
]);

const run = (over: Partial<ResumeRunView> = {}, journal = GATE): ResumeRunView => ({
  runId: RUN,
  status: "running",
  waitsForPerson: false,
  marks: decisionOf(journal),
  ...over,
});

const worker = (over: Partial<ServeWorkerView> = {}): ServeWorkerView => ({
  id: "a_000000001_0000",
  name: `kw-${RUN}`,
  state: "exited",
  label: "exited (0)",
  exitCode: 0,
  started: 0,
  since: 4_500,
  sessionId: "7f3b2a9c-1d4e-4f6a-9b8c-0d1e2f3a4b5c",
  resumed: [],
  resumes: 0,
  ...over,
});

const why = (v: ResumeVerdict) => (v.kind === "no" ? v.why : "resume");
const verdict = (r: ResumeRunView, w: ServeWorkerView | undefined, refuseMoved = true) =>
  why(resumeVerdict(r, w, { refuseMoved }));

describe("t44 the resume verdicts", () => {
  test("t44_resume_verdict_resume", () => {
    const v = resumeVerdict(run(), worker(), { refuseMoved: true });
    expect(v).toMatchObject({
      kind: "resume",
      seq: 4,
      decision: { kind: "gate", node: "plan-approval" },
    });
    // a paused run that a person resumed is going again
    expect(verdict(run({ status: "paused" }), worker())).toBe("resume");
  });

  test("t44_resume_verdict_no_worker", () => {
    expect(verdict(run(), undefined)).toBe("no_worker");
  });

  test("t44_resume_verdict_unknown", () => {
    expect(verdict(run(), worker({ state: "unknown", label: "unknown" }))).toBe("unknown");
  });

  test("t44_resume_verdict_active", () => {
    expect(verdict(run(), worker({ state: "running" }))).toBe("active");
    expect(verdict(run(), worker({ state: "starting" }))).toBe("active");
  });

  test("t44_resume_verdict_dead", () => {
    expect(verdict(run(), worker({ state: "lost" }))).toBe("dead");
    expect(verdict(run(), worker({ state: "killed" }))).toBe("dead");
  });

  test("t44_resume_verdict_over", () => {
    for (const status of ["completed", "failed", "canceled"] as const) {
      expect(verdict(run({ status }), worker())).toBe("over");
    }
  });

  test("t44_resume_verdict_not_at_wait", () => {
    // no wait at all, and an exit before the wait began
    expect(verdict(run({}, build([{ event: "run_started" }])), worker())).toBe("not_at_wait");
    expect(verdict(run(), worker({ since: 3_999 }))).toBe("not_at_wait");
  });

  test("t44_resume_verdict_went_on", () => {
    // The worker exited at the gate (4000), the person decided, another agent took the run on to its
    // next gate (8000): the worker stopped correctly, it did not die outside a wait.
    const onward = build([
      { event: "run_started" },
      { event: "node_entered", node: "plan" },
      { event: "gate_waiting", node: "plan-approval", attempt: 1 },
      { event: "gate_decided", node: "plan-approval", decision: "approved" },
      { event: "step_served", node: "impl" },
      { event: "agent_completed", node: "impl" },
      { event: "gate_waiting", node: "final-approval", attempt: 1 },
    ]);
    expect(verdict(run({ waitsForPerson: true }, onward), worker())).toBe("went_on");
    expect(verdict(run({}, onward), worker(), false)).toBe("went_on");
    // an exit before any wait of its life is still not at a wait
    expect(verdict(run({}, onward), worker({ since: 3_999 }))).toBe("not_at_wait");
  });

  test("t44_resume_verdict_wait_before_start", () => {
    expect(verdict(run(), worker({ started: 4_001, since: 9_000 }))).toBe("wait_before_start");
    // while the run waits it is not that case
    // while the run waits with no wait line since the worker started (a hand-edited pipeline file), it
    // stopped at that wait
    expect(verdict(run({ waitsForPerson: true }), worker({ started: 4_001 }))).toBe(
      "waiting_person",
    );
  });

  test("t44_resume_verdict_waiting_person", () => {
    expect(verdict(run({ waitsForPerson: true }), worker())).toBe("waiting_person");
    // a wait with no wait line in the journal (a pipeline file edited by hand) is still a wait
    const noWaitLine = build([{ event: "run_started" }]);
    expect(verdict(run({ waitsForPerson: true }, noWaitLine), worker())).toBe("waiting_person");
    // a worker that exited before a later wait did not stop at it, even while the run waits
    expect(verdict(run({ waitsForPerson: true }), worker({ since: 3_999 }))).toBe("not_at_wait");
  });

  test("t44_resume_verdict_undecided", () => {
    const waiting = build([{ event: "run_started" }, { event: "gate_waiting", node: "g" }]);
    expect(verdict(run({}, waiting), worker({ since: 3_500 }))).toBe("undecided");
  });

  test("t44_resume_verdict_agent_decided", () => {
    const byAgent = build([
      { event: "run_started" },
      { event: "node_entered", node: "plan" },
      { event: "gate_waiting", node: "g" },
      { event: "gate_decided", node: "g", decision: "approved", decided_by: "agent" },
    ]);
    expect(verdict(run({}, byAgent), worker())).toBe("agent_decided");
  });

  test("t44_resume_verdict_already_resumed", () => {
    expect(verdict(run(), worker({ resumed: [4] }))).toBe("already_resumed");
  });

  test("t44_resume_verdict_no_session_id", () => {
    const { sessionId: _, ...rest } = worker();
    expect(verdict(run(), rest)).toBe("no_session_id");
  });

  test("t44_resume_verdict_moved", () => {
    const moved = [...GATE, ...build([{ event: "step_served" }]).map((r) => ({ ...r, seq: 5 }))];
    expect(verdict(run({}, moved), worker())).toBe("moved");
    // the TUI does not refuse it: it offers the resume with a warning
    expect(verdict(run({}, moved), worker(), false)).toBe("resume");
  });

  test("t44_worker_note_is_not_a_sign_of_life", () => {
    expect(NOT_A_SIGN_OF_LIFE).toContain("worker_note");
    expect(NOT_A_SIGN_OF_LIFE).toContain("agent_session_named");
    // a hand-edited pipeline accepted is dated by the last line before it that is a sign of life
    const journal = build([
      { event: "run_started" },
      { event: "node_entered", node: "impl" },
      { event: "worker_note", what: "gone", worker: `kw-${RUN}`, reason: "lost" },
      { event: "pipeline_accepted", source: "file", nodes: [] },
    ]);
    expect(decisionOf(journal).lastWait).toMatchObject({ seq: 2, kind: "pipeline_change" });
  });
});

/** The gate journal with an agent's line after the decision (seq 5, ts 6000). */
const MOVED = [...GATE, ...build([{ event: "step_served" }]).map((r) => ({ ...r, seq: 5 }))];
/** The gate journal before the decision. */
const WAITING = GATE.slice(0, 3);

/** A worker in a terminal of its own, ended at 4500 (after the wait at 4000, before the decision at 5000). */
const terminal = (over: Partial<ServeWorkerView> = {}): ServeWorkerView =>
  worker({ terminal: true, ...over });

/** The ends of a terminal session that may have found the agent waiting. */
const ENDS: [string, Partial<ServeWorkerView>][] = [
  ["exited", { state: "exited" }],
  ["lost", { state: "lost", label: "lost (holder gone)", endedBy: "holder_gone" }],
  ["timeout", { state: "killed", label: "killed (timeout)", endedBy: "timeout" }],
  ["holder error", { state: "killed", label: "failed (could not start)", endedBy: "holder_error" }],
];

describe("t44 a worker in a terminal that ended (T-47)", () => {
  test("t44_ended_after_the_decision_without_going_on_is_resumed", () => {
    // It was alive at the decision and ended after it, and no agent called the engine since: it never
    // went on, so it is resumed like one that ended at the wait. The same second, seconds, days later.
    for (const [what, end] of ENDS) {
      for (const since of [5_000, 5_001, 12_000, 5_000 + 3 * 86_400_000]) {
        const w = terminal({ since, lastOutputAt: 4_200, ...end });
        expect(verdict(run(), w), `${what} at ${since}`).toBe("resume");
      }
      // And one that ended at the wait, before any decision: it waits, then it is resumed.
      const w = terminal(end);
      expect(verdict(run({ waitsForPerson: true }, WAITING), w), what).toBe("waiting_person");
      expect(verdict(run({}, WAITING), w), what).toBe("undecided");
      expect(verdict(run(), w), what).toBe("resume");
    }
    // A print worker that is `lost` or `killed` is dead, as before: its turn ends at a wait by an exit.
    expect(verdict(run(), worker({ state: "lost" }))).toBe("dead");
    expect(verdict(run(), worker({ state: "killed", endedBy: "timeout" }))).toBe("dead");
    // A terminal session that never came up did not wait.
    expect(verdict(run(), terminal({ state: "killed", endedBy: "start_late" }))).toBe("dead");
    expect(verdict(run(), terminal({ state: "killed" }))).toBe("dead");
  });

  test("t44_stopped_at_a_wait_is_left_to_the_person", () => {
    const stopped = terminal({
      state: "killed",
      label: "stopped",
      stopped: true,
      endedBy: "stopped",
    });
    // The daemon does not resume a worker a person stopped.
    expect(resumeVerdict(run(), stopped, { refuseMoved: true })).toEqual({
      kind: "no",
      why: "stopped",
    });
    // The TUI offers it (`s resumes`).
    expect(
      resumeVerdict(run(), stopped, { refuseMoved: false, resumeStopped: true }),
    ).toMatchObject({ kind: "resume", seq: 4 });
    // Until the decision it waits like any other.
    expect(verdict(run({ waitsForPerson: true }, WAITING), stopped)).toBe("waiting_person");
    // Stopped outside a wait, and a print worker that was stopped: a session that is over.
    expect(verdict(run(), { ...stopped, since: 3_000 })).toBe("dead");
    expect(verdict(run(), worker({ state: "killed", stopped: true, endedBy: "stopped" }))).toBe(
      "dead",
    );
    expect(
      why(
        resumeVerdict(run(), worker({ state: "killed", stopped: true }), {
          refuseMoved: false,
          resumeStopped: true,
        }),
      ),
    ).toBe("dead");
  });

  test("t44_ended_before_the_decision_and_moved_is_not_a_death", () => {
    // It ended at W1 before D1; then another agent worked the run (an agent's line after D1).
    for (const [what, end] of ENDS) {
      const w = terminal({ since: 4_500, lastOutputAt: 4_400, ...end });
      expect(verdict(run({}, MOVED), w), what).toBe("moved");
      // The TUI words that case itself and still offers the resume.
      expect(verdict(run({}, MOVED), w, false), what).toBe("resume");
    }
  });

  test("t44_same_instant_end_and_decision", () => {
    // The order is the journal's and the record's end; an end in the instant of the decision is before it.
    for (const [what, end] of ENDS) {
      const at = (since: number) => terminal({ since, lastOutputAt: since, ...end });
      expect(verdict(run({}, MOVED), at(5_000)), what).toBe("moved");
      expect(verdict(run({}, MOVED), at(5_001)), what).toBe("not_at_wait");
      expect(verdict(run({}, MOVED), at(4_999)), what).toBe("moved");
    }
  });

  test("t44_lost_noticed_late_is_not_a_death", () => {
    // A `lost` record has no known end: `since` is when the loss was noticed. Noticed long after the
    // decision, with no output after it, and an agent's line after the decision: it is taken as ended
    // before the decision, so another agent went on. No death.
    const late = terminal({
      state: "lost",
      endedBy: "holder_gone",
      since: 900_000,
      lastOutputAt: 4_200,
    });
    expect(verdict(run({}, MOVED), late)).toBe("moved");
    // The same record with output after the decision did end after it: it died at work.
    expect(verdict(run({}, MOVED), { ...late, lastOutputAt: 5_500 })).toBe("not_at_wait");
    // A record that names no output at all is taken as ended before the decision.
    const { lastOutputAt: _none, ...silent } = late;
    expect(verdict(run({}, MOVED), silent)).toBe("moved");
    // With no agent's line after the decision either is resumed.
    expect(verdict(run(), late)).toBe("resume");
  });

  test("t44_child_alive_verdict", () => {
    // `lost` or `killed` while its process still runs: alive for every rule, whatever else holds.
    for (const state of ["lost", "killed"] as const) {
      for (const isTerminal of [true, false]) {
        for (const journal of [WAITING, GATE, MOVED]) {
          const w = worker({ state, childAlive: true, ...(isTerminal ? { terminal: true } : {}) });
          expect(verdict(run({}, journal), w)).toBe("child_alive");
          expect(verdict(run({ status: "completed" }, journal), w)).toBe("child_alive");
          expect(
            why(resumeVerdict(run({}, journal), w, { refuseMoved: false, resumeStopped: true })),
          ).toBe("child_alive");
        }
      }
    }
    // A live session is `active` whatever the flag says.
    expect(verdict(run(), worker({ state: "running", childAlive: true }))).toBe("active");
  });

  test("t44_older_print_worker_at_a_gate_keeps_its_place", () => {
    // A `claude -p` worker from before the `agent` record: exited at its gate, its id read from its
    // argv. It keeps its `max_runs` place while the run waits and is resumed once after the decision.
    const old = worker();
    expect(old.terminal).toBeUndefined();
    const view = (journal: JournalRecord[], waitsForPerson: boolean) => ({
      ...run({ waitsForPerson }, journal),
      canNote: true,
      noted: [],
      worker: old,
    });
    expect(verdict(view(WAITING, true), old)).toBe("waiting_person");
    expect(servePlaces([view(WAITING, true)])).toEqual({ workers: 0, runs: [RUN] });
    expect(verdict(view(GATE, false), old)).toBe("resume");
    expect(servePlaces([view(GATE, false)])).toEqual({ workers: 0, runs: [RUN] });
    // Without the id from its argv it would be released for good: that is the case the reader avoids.
    const { sessionId: _none, ...noId } = old;
    expect(verdict(view(GATE, false), noId)).toBe("no_session_id");
    expect(servePlaces([{ ...view(GATE, false), worker: noId }])).toEqual({ workers: 0, runs: [] });
    // Resumed once: the record of the decision exists.
    expect(verdict(view(GATE, false), { ...old, resumed: [4] })).toBe("already_resumed");
  });
});
