/**
 * The resume rule (TASK-G8KM, T-43): one named case per verdict. The TUI words the same verdicts on
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

describe("t43 the resume verdicts", () => {
  test("t43_resume_verdict_resume", () => {
    const v = resumeVerdict(run(), worker(), { refuseMoved: true });
    expect(v).toMatchObject({
      kind: "resume",
      seq: 4,
      decision: { kind: "gate", node: "plan-approval" },
    });
    // a paused run that a person resumed is going again
    expect(verdict(run({ status: "paused" }), worker())).toBe("resume");
  });

  test("t43_resume_verdict_no_worker", () => {
    expect(verdict(run(), undefined)).toBe("no_worker");
  });

  test("t43_resume_verdict_unknown", () => {
    expect(verdict(run(), worker({ state: "unknown", label: "unknown" }))).toBe("unknown");
  });

  test("t43_resume_verdict_active", () => {
    expect(verdict(run(), worker({ state: "running" }))).toBe("active");
    expect(verdict(run(), worker({ state: "starting" }))).toBe("active");
  });

  test("t43_resume_verdict_dead", () => {
    expect(verdict(run(), worker({ state: "lost" }))).toBe("dead");
    expect(verdict(run(), worker({ state: "killed" }))).toBe("dead");
  });

  test("t43_resume_verdict_over", () => {
    for (const status of ["completed", "failed", "canceled"] as const) {
      expect(verdict(run({ status }), worker())).toBe("over");
    }
  });

  test("t43_resume_verdict_not_at_wait", () => {
    // no wait at all, and an exit before the wait began
    expect(verdict(run({}, build([{ event: "run_started" }])), worker())).toBe("not_at_wait");
    expect(verdict(run(), worker({ since: 3_999 }))).toBe("not_at_wait");
  });

  test("t43_resume_verdict_wait_before_start", () => {
    expect(verdict(run(), worker({ started: 4_001, since: 9_000 }))).toBe("wait_before_start");
    // while the run waits it is not that case
    expect(verdict(run({ waitsForPerson: true }), worker({ started: 4_001 }))).toBe("not_at_wait");
  });

  test("t43_resume_verdict_waiting_person", () => {
    expect(verdict(run({ waitsForPerson: true }), worker())).toBe("waiting_person");
    // a wait with no wait line in the journal (a pipeline file edited by hand) is still a wait
    const noWaitLine = build([{ event: "run_started" }]);
    expect(verdict(run({ waitsForPerson: true }, noWaitLine), worker())).toBe("waiting_person");
    // a worker that exited before a later wait did not stop at it, even while the run waits
    expect(verdict(run({ waitsForPerson: true }), worker({ since: 3_999 }))).toBe("not_at_wait");
  });

  test("t43_resume_verdict_undecided", () => {
    const waiting = build([{ event: "run_started" }, { event: "gate_waiting", node: "g" }]);
    expect(verdict(run({}, waiting), worker({ since: 3_500 }))).toBe("undecided");
  });

  test("t43_resume_verdict_agent_decided", () => {
    const byAgent = build([
      { event: "run_started" },
      { event: "node_entered", node: "plan" },
      { event: "gate_waiting", node: "g" },
      { event: "gate_decided", node: "g", decision: "approved", decided_by: "agent" },
    ]);
    expect(verdict(run({}, byAgent), worker())).toBe("agent_decided");
  });

  test("t43_resume_verdict_already_resumed", () => {
    expect(verdict(run(), worker({ resumed: [4] }))).toBe("already_resumed");
  });

  test("t43_resume_verdict_no_session_id", () => {
    const { sessionId: _, ...rest } = worker();
    expect(verdict(run(), rest)).toBe("no_session_id");
  });

  test("t43_resume_verdict_moved", () => {
    const moved = [...GATE, ...build([{ event: "step_served" }]).map((r) => ({ ...r, seq: 5 }))];
    expect(verdict(run({}, moved), worker())).toBe("moved");
    // the TUI does not refuse it: it offers the resume with a warning
    expect(verdict(run({}, moved), worker(), false)).toBe("resume");
  });

  test("t43_worker_note_is_not_a_sign_of_life", () => {
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
