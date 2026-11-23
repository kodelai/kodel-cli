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
