/**
 * The resume rule (TASK-G8KM, T-44): one named case per verdict. The TUI words the same verdicts on
 * its card (`packages/cli/test/worker-resume.test.ts`); `kodel serve` acts on them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodeJournalRecord, type JournalRecord, readRunState } from "../src";
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

  test("t44_5m9d_a_decision_through_a_manager_is_resumed_like_a_persons", () => {
    // The agent that decided works no step of the run (it is connected as a manager), so nobody goes
    // on by itself: the worker is resumed. The mark alone does it; without `decided_by` it is nothing.
    const decided = (extra: Record<string, unknown>) =>
      build([
        { event: "run_started" },
        { event: "node_entered", node: "plan" },
        { event: "gate_waiting", node: "g" },
        { event: "gate_decided", node: "g", decision: "approved", ...extra },
      ]);
    const viaManager = decided({ decided_by: "agent", decided_via: "manager" });
    expect(decisionOf(viaManager).decision).toMatchObject({ byAgent: true, viaManager: true });
    expect(verdict(run({}, viaManager), worker())).toBe("resume");
    expect(
      verdict(run({}, decided({ decided_by: "agent", decided_via: "worker" })), worker()),
    ).toBe("agent_decided");
    expect(decisionOf(decided({ decided_via: "manager" })).decision?.viaManager).toBeUndefined();
    // A step served since the decision still stops the daemon's resume, as for a person's decision.
    const moved = [
      ...viaManager,
      ...build([{ event: "step_served", node: "impl" }]).map((r) => ({ ...r, seq: 5, ts: 6_000 })),
    ];
    expect(verdict(run({}, moved), worker())).toBe("moved");
  });

  test("t44_5m9d_manager_decision_fixture_is_resumed_like_a_persons", () => {
    // The same rule over the runs real servers wrote (`fixtures/formats/v2-manager/`,
    // `scripts/take-v2-manager-fixture.mjs`): the stored key is what the daemon reads.
    const load = (id: string) => {
      const dir = new URL(`../../../fixtures/formats/v2-manager/${id}/`, import.meta.url).pathname;
      const state = readRunState(readFileSync(`${dir}state.json`, "utf8"), id);
      const journal = readFileSync(`${dir}journal.jsonl`, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => decodeJournalRecord(JSON.parse(line)));
      return { id, state, journal };
    };
    /** The daemon's view of the run, and its worker that exited at the last wait. */
    const planned = (
      { id, state, journal }: ReturnType<typeof load>,
      records: readonly JournalRecord[] = journal,
    ) => {
      const marks = decisionOf(records);
      const view: ResumeRunView = {
        runId: id,
        status: state.status,
        waitsForPerson: false,
        marks,
      };
      const at = worker({
        name: `kw-${id}`,
        started: journal[0]?.ts ?? 0,
        since: marks.lastWait?.ts ?? 0,
      });
      return { marks, verdict: resumeVerdict(view, at, { refuseMoved: true }) };
    };

    // A gate approved through a manager's server: nobody was served since, the worker is resumed.
    const gate = load("r_0mwtbx5bv_kyns");
    const gateDecision = gate.journal.find((r) => r.event === "gate_decided");
    expect(gateDecision).toMatchObject({ decided_by: "agent", decided_via: "manager" });
    const gatePlan = planned(gate);
    expect(gatePlan.marks.decision).toMatchObject({
      kind: "gate",
      node: "approve",
      outcome: "approved",
      byAgent: true,
      viaManager: true,
    });
    expect(gatePlan.marks.moved).toBe(false);
    expect(gatePlan.verdict).toMatchObject({ kind: "resume", seq: gateDecision?.seq });

    // A pipeline change accepted through a manager's server: the same.
    const change = load("r_0mwtbx7v2_cye8");
    const accepted = change.journal.find((r) => r.event === "pipeline_accepted");
    expect(accepted).toMatchObject({ decided_by: "agent", decided_via: "manager" });
    const changePlan = planned(change);
    expect(changePlan.marks.decision).toMatchObject({
      kind: "pipeline_change",
      outcome: "accepted",
      byAgent: true,
      viaManager: true,
    });
    expect(changePlan.verdict).toMatchObject({ kind: "resume", seq: accepted?.seq });

    // A gate an agent approved where the run is worked carries no `decided_via`: that agent goes on
    // itself, and the worker is not resumed.
    const own = load("r_0mwtbx9p5_lbl7");
    const ownDecision = own.journal.find((r) => r.event === "gate_decided");
    expect(ownDecision?.decided_by).toBe("agent");
    expect(ownDecision?.decided_via).toBeUndefined();
    const ownPlan = planned(own);
    expect(ownPlan.marks.decision?.viaManager).toBeUndefined();
    expect(why(ownPlan.verdict)).toBe("agent_decided");

    // What an older kodel reads, which does not know the key: an agent's own decision, no resume.
    const stripped = gate.journal.map((record) => {
      const { decided_via: _via, ...rest } = record;
      return rest as JournalRecord;
    });
    expect(why(planned(gate, stripped).verdict)).toBe("agent_decided");
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
  // The holder was told to end without a stop of the person (a shutdown), or the program was killed.
  ["signal", { state: "killed", label: "killed (SIGTERM)", endedBy: "signal" }],
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
    expect(verdict(run(), worker({ state: "killed", endedBy: "signal" }))).toBe("dead");
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

  test("t44_a_persons_stop_is_never_resumed_by_the_daemon_whatever_the_record_says", () => {
    // The holder had recorded its own end (or was gone) and the person stopped what it left: the record
    // keeps that end, the worker is the person's all the same. Every end at which the agent may have waited.
    for (const [what, end] of ENDS) {
      const stopped = terminal({ ...end, stopped: true });
      // Every time the worker may have ended at: at the wait, and after the decision without going on.
      for (const since of [4_500, 5_000, 5_001, 12_000]) {
        const w = { ...stopped, since, lastOutputAt: 4_200 };
        expect(resumeVerdict(run(), w, { refuseMoved: true }), `${what} at ${since}`).toEqual({
          kind: "no",
          why: "stopped",
        });
        // The same worker without the person's stop is the one the daemon resumes.
        expect(verdict(run(), { ...w, stopped: undefined }), `${what} at ${since}`).toBe("resume");
        // The TUI offers it.
        expect(
          resumeVerdict(run(), w, { refuseMoved: false, resumeStopped: true }),
          `${what} at ${since}`,
        ).toMatchObject({ kind: "resume", seq: 4 });
      }
      // Until the decision it waits like any other, and keeps its run.
      expect(verdict(run({ waitsForPerson: true }, WAITING), stopped), what).toBe("waiting_person");
      expect(verdict(run({}, WAITING), stopped), what).toBe("undecided");
      // Stopped at work, before any wait: a session that is over.
      expect(verdict(run(), { ...stopped, since: 3_000 }), what).toBe("dead");
      // A run that is over is over.
      expect(verdict(run({ status: "completed" }), stopped), what).toBe("over");
    }
    // No option but the TUI's own returns `resume` for a worker the person stopped.
    for (const refuseMoved of [true, false]) {
      for (const [what, end] of ENDS) {
        const v = resumeVerdict(run(), terminal({ ...end, stopped: true }), { refuseMoved });
        expect(v.kind, what).toBe("no");
      }
    }
    // A session kodel ended because its run was over is stopped, but not by the person: the rule reads its
    // end alone (an open run with such a worker is one whose worker ended, and it is resumed at a decision).
    const finished = terminal({ state: "killed", label: "stopped", endedBy: "stopped" });
    expect(verdict(run({ status: "completed" }), finished)).toBe("over");
    expect(verdict(run(), finished)).toBe("resume");
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
