/**
 * The resume offer (TASK-9PNS, Decision 1c): pure rules over the journal, the run as the screen sees it
 * and the worker's records. The golden journals are real format-2 runs (copied from `fixtures/formats/v2`:
 * a rejected gate and an accepted proposal, a hand-edited pipeline accepted, a pause and its resume), and
 * the format-1 fixture is read as it is.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JournalRecord } from "@kodel-ai/pipeline-core";
import type { Session } from "../src/tui/session";
import {
  type DecisionInfo,
  decisionOf,
  type ResumeOffer,
  resumeOffer,
} from "../src/tui/worker-resume";
import type { WorkerStatus } from "../src/worker-launcher";

const FIXTURES = join(import.meta.dir, "fixtures", "journals");
const V1 = join(import.meta.dir, "../../../fixtures/formats/v1/r_0mviewgvl_i1ig/journal.jsonl");

function journalOf(path: string, upTo = Number.POSITIVE_INFINITY): JournalRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as JournalRecord)
    .filter((r) => r.seq <= upTo);
}

const golden = (name: string, upTo?: number) => journalOf(join(FIXTURES, `${name}.jsonl`), upTo);

/** A journal built line by line: seq and ts grow together (a second apart), unless a line says otherwise. */
function build(lines: Partial<JournalRecord>[]): JournalRecord[] {
  return lines.map((l, i) => ({
    v: 2,
    seq: i + 1,
    ts: 1_000 + (i + 1) * 1_000,
    event: "node_entered",
    ...l,
  })) as JournalRecord[];
}

const RUN = "r_0mw53d7fj_o2lc";

/** What `s` says when there is no offer. */
const whyOf = (o: ResumeOffer): string | undefined => (o.offer === undefined ? o.why : undefined);

function session(info: DecisionInfo, status: Session["status"] = "running"): Session {
  return {
    id: RUN,
    title: "run",
    pipeline: "dev",
    status,
    step: "impl",
    since: 0,
    steps: [],
    log: [],
    ...(info.decision === undefined
      ? {}
      : {
          decision: info.decision,
          moved: info.moved,
          ...(info.lastWait === undefined ? {} : { lastWait: info.lastWait }),
        }),
  };
}

function worker(over: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    id: "a_000000001_0000",
    name: `kw-${RUN}`,
    state: "exited",
    label: "exited (0)",
    exitCode: 0,
    started: 0,
    since: 1_000_000,
    sessionId: "7f3b2a9c-1d4e-4f6a-9b8c-0d1e2f3a4b5c",
    resumed: [],
    resumes: 0,
    ...over,
  };
}

/** A run that waited at a gate (seq 3) and whose person decided (seq 4); the agent exits at the wait. */
const GATE = build([
  { event: "run_started" },
  { event: "node_entered", node: "plan" },
  { event: "gate_waiting", node: "plan-approval", attempt: 1 },
  { event: "gate_decided", node: "plan-approval", decision: "approved" },
]);

describe("task_9pns decisionOf over the golden journals", () => {
  test("task_9pns_decision_of_golden_journals", () => {
    // A rejected gate: the wait is its `gate_waiting`, the reason is carried.
    const rejected = decisionOf(golden("rejected-gate-and-accepted-change", 27));
    expect(rejected.decision).toMatchObject({
      seq: 26,
      kind: "gate",
      node: "plan-approval",
      outcome: "rejected",
      reason: "the plan does not say how the flag is tested",
      byAgent: false,
    });
    expect(rejected.lastWait).toMatchObject({ seq: 25, kind: "gate", node: "plan-approval" });
    expect(rejected.moved).toBe(false);
    // The same run, a few lines on: an agent was served a step after the decision.
    expect(decisionOf(golden("rejected-gate-and-accepted-change", 29)).moved).toBe(true);
    // An accepted proposal: the wait is the proposal, the decision the accept, named by its nodes.
    const accepted = decisionOf(golden("rejected-gate-and-accepted-change", 12));
    expect(accepted.decision).toMatchObject({
      seq: 11,
      kind: "pipeline_change",
      outcome: "accepted",
      node: "plan-critique",
    });
    expect(accepted.lastWait).toMatchObject({ seq: 10, kind: "pipeline_change" });
    // A pipeline file edited by hand: no wait line of its own, dated by the last sign of life before it.
    const hand = decisionOf(golden("hand-edit-accepted", 5));
    expect(hand.decision).toMatchObject({ seq: 4, kind: "pipeline_change", outcome: "accepted" });
    expect(hand.lastWait).toMatchObject({ seq: 3, kind: "pipeline_change" });
    expect(hand.lastWait?.ts).toBe(golden("hand-edit-accepted", 3)[2]?.ts);
    // A pause and its resume.
    const paused = decisionOf(golden("paused-and-resumed", 16));
    expect(paused.decision).toMatchObject({
      seq: 15,
      kind: "pause",
      node: "test",
      outcome: "resumed",
    });
    expect(paused.lastWait).toMatchObject({ seq: 11, kind: "pause", node: "test" });
    // The last decision wins, with its own wait.
    const last = decisionOf(golden("rejected-gate-and-accepted-change"));
    expect(last.decision).toMatchObject({ seq: 73, node: "final-approval", outcome: "approved" });
    expect(last.lastWait).toMatchObject({ seq: 72 });
    // The format-1 fixture reads through the same loader.
    const v1 = decisionOf(journalOf(V1));
    expect(v1.decision?.kind).toBe("gate");
    expect(v1.lastWait?.kind).toBe("gate");
    expect(v1.decision?.seq).toBeGreaterThan(v1.lastWait?.seq ?? Number.POSITIVE_INFINITY);
  });

  test("task_9pns_decision_of_built_lines", () => {
    // A dropped change is a decision; the proposal before it is its wait.
    const dropped = decisionOf(
      build([
        { event: "run_started" },
        { event: "pipeline_change_proposed", hash: "x", summary: "try it" },
        {
          event: "pipeline_change_proposed",
          hash: "x",
          summary: "dropped by a person",
          withdrawn: true,
        },
      ]),
    );
    expect(dropped.decision).toMatchObject({
      seq: 3,
      outcome: "dropped",
      reason: "dropped by a person",
    });
    expect(dropped.lastWait).toMatchObject({ seq: 2 });
    // A withdrawn proposal is not a wait; `manual_edit` is not a decision; an agent's decision is marked.
    const agent = decisionOf(
      build([
        { event: "run_started" },
        { event: "gate_waiting", node: "g" },
        { event: "manual_edit" },
        {
          event: "gate_decided",
          node: "g",
          decision: "approved",
          decided_by: "agent",
          instruction: "go",
        },
      ]),
    );
    expect(agent.decision).toMatchObject({ seq: 4, byAgent: true });
    expect(agent.lastWait).toMatchObject({ seq: 2 });
    expect(
      decisionOf(build([{ event: "run_started" }, { event: "manual_edit" }])).decision,
    ).toBeUndefined();
    // A hostile reason is kept as the journal has it: the question makes it plain when it shows it.
    const hostile = decisionOf(
      build([
        { event: "gate_waiting", node: "g" },
        { event: "gate_decided", node: "g", decision: "rejected", reason: "a\u001b[31mb‮c" },
      ]),
    );
    expect(hostile.decision?.reason).toBe("a\u001b[31mb‮c");
  });
});

describe("task_9pns the resume offer", () => {
  const info = decisionOf(GATE);
  const waitTs = info.lastWait?.ts ?? 0;
  const decisionTs = info.decision?.ts ?? 0;

  test("task_9pns_resume_offer_table", () => {
    const offered = resumeOffer(session(info), worker(), false);
    expect(offered.offer).toMatchObject({ seq: 4, moved: false });
    expect(offered.line).toBe("agent exited at your decision · s resumes");

    // Offered: the person decided while the worker was still finishing its turn.
    expect(
      resumeOffer(session(info), worker({ since: decisionTs + 1 }), false).offer,
    ).toBeDefined();
    expect(resumeOffer(session(info), worker({ since: waitTs + 1 }), false).offer?.seq).toBe(4);
    // Boundaries: the wait at the very start of the session, the exit at the very moment of the wait.
    expect(resumeOffer(session(info), worker({ started: waitTs }), false).offer).toBeDefined();
    expect(resumeOffer(session(info), worker({ since: waitTs }), false).offer).toBeDefined();
    // With the warning when an agent moved since (the journal says so); without it the journal says nothing.
    const movedInfo = decisionOf([
      ...GATE,
      ...build([{ event: "step_served", node: "impl" }]).map((r) => ({ ...r, seq: 5, ts: 6_000 })),
    ]);
    const warned = resumeOffer(session(movedInfo), worker(), false);
    expect(warned.offer?.moved).toBe(true);
    expect(warned.line).toContain("an agent was served a step since");
    // A run that keeps no `served` (prompts off) or is at the cap writes no line: offered, no warning,
    // and the warning cannot be relied on in either case.
    expect(resumeOffer(session(info), worker(), false).offer?.moved).toBe(false);

    // Not offered: a worker that runs or starts, in any session.
    for (const state of ["running", "starting"] as const) {
      const w = worker({ state, label: state });
      expect(resumeOffer(session(info), w, false)).toEqual({
        line: `agent ${state}`,
        why: `agent ${state}`,
      });
    }
    expect(
      resumeOffer(
        session(info),
        worker({ state: "running", label: "running", resumes: 1, resumed: [2] }),
        false,
      ).line,
    ).toBe("agent running (session 2)");
    // Killed (stopped, timeout), lost, a problem record.
    expect(
      resumeOffer(session(info), worker({ state: "killed", label: "stopped" }), false).line,
    ).toBe("agent stopped");
    expect(
      resumeOffer(session(info), worker({ state: "killed", label: "killed (timeout)" }), false)
        .offer,
    ).toBeUndefined();
    expect(
      resumeOffer(session(info), worker({ state: "lost", label: "lost (holder gone)" }), false)
        .line,
    ).toBe("agent lost (holder gone)");
    expect(
      resumeOffer(
        session(info),
        worker({ state: "unknown", label: "unknown (cannot be read)" }),
        false,
      ).line,
    ).toBe("agent unknown (cannot be read)");
    // Exited with no wait begun during the session: a crash, with code 0 and 1.
    const noWait = decisionOf(build([{ event: "run_started" }, { event: "node_entered" }]));
    for (const exitCode of [0, 1]) {
      const crashed = resumeOffer(
        session(noWait),
        worker({ exitCode, label: `exited (${exitCode})` }),
        false,
      );
      expect(crashed.offer).toBeUndefined();
      expect(crashed.line).toBe(`agent exited (${exitCode}), not at a gate`);
      expect(whyOf(crashed)).toContain(`pipeline_next_step ${RUN}`);
    }
    // Wait begun and decided during the session, then an exit before the wait.
    expect(resumeOffer(session(info), worker({ since: waitTs - 1, exitCode: 1 }), false).line).toBe(
      "agent exited (1), not at a gate",
    );
    // A run that is over, in every end state.
    for (const status of ["done", "failed", "canceled", "unreadable"] as const) {
      const over = resumeOffer(session(info, status), worker(), false);
      expect(over.offer).toBeUndefined();
      expect(whyOf(over)).toBe("the run is over");
    }
    // A run waiting again (a worker resumed after gate A reached gate B and exited): waiting for you.
    const again = decisionOf([
      ...GATE,
      ...build([{ event: "gate_waiting", node: "final" }]).map((r) => ({
        ...r,
        seq: 5,
        ts: 6_000,
      })),
    ]);
    const atB = resumeOffer(
      session(again, "waiting"),
      worker({ resumes: 1, resumed: [4], decisionSeq: 4, since: 7_000 }),
      false,
    );
    expect(atB.offer).toBeUndefined();
    expect(atB.line).toBe("agent waiting for you");
    // A fork with one gate decided and one waiting is `waiting`: the same, a limit.
    expect(resumeOffer(session(info, "waiting"), worker(), false).line).toBe(
      "agent waiting for you",
    );
    // An agent decided (`decided_by: agent`), at a gate and at a pipeline change.
    for (const line of [
      {
        event: "gate_decided",
        node: "plan-approval",
        decision: "approved",
        decided_by: "agent",
        instruction: "go",
      },
      {
        event: "pipeline_accepted",
        source: "proposal",
        nodes: [{ slug: "plan" }],
        decided_by: "agent",
        instruction: "go",
      },
    ]) {
      const byAgent = decisionOf([...GATE.slice(0, 3), { ...GATE[3], ...line } as JournalRecord]);
      const refused = resumeOffer(session(byAgent), worker(), false);
      expect(refused.offer).toBeUndefined();
      expect(refused.line).toBe("agent exited; an agent decided and goes on");
    }
    // A record of that decision exists, in any state.
    for (const state of ["exited", "killed", "unknown"] as const) {
      const resumedAlready = worker({
        state,
        label: state,
        resumes: 1,
        resumed: [4],
        decisionSeq: 4,
        name: `kw-${RUN}-d4`,
      });
      const got = resumeOffer(session(info), resumedAlready, false);
      expect(got.offer).toBeUndefined();
      if (state === "exited")
        expect(got.line).toBe(`kw-${RUN}-d4 ended: kodel agent logs kw-${RUN}-d4`);
    }
    // No session id.
    const { sessionId: _none, ...noId } = worker();
    const unknownId = resumeOffer(session(info), noId as WorkerStatus, false);
    expect(unknownId.offer).toBeUndefined();
    expect(whyOf(unknownId)).toBe(`no session id: kodel agent logs kw-${RUN}`);
    // The TUI's own step is running.
    const busy = resumeOffer(session(info), worker(), true);
    expect(busy.offer).toBeUndefined();
    expect(whyOf(busy)).toContain("the TUI is running the step");
    // A wait dated before the agent started: the clock.
    const clock = resumeOffer(session(info), worker({ started: waitTs + 1 }), false);
    expect(clock.offer).toBeUndefined();
    expect(whyOf(clock)).toContain("the wait is dated before the agent started");
    // `manual_edit` after the wait is not a decision: nothing decided since.
    const acked = decisionOf([
      ...GATE.slice(0, 3),
      { ...GATE[3], event: "manual_edit" } as JournalRecord,
    ]);
    expect(acked.decision).toBeUndefined();
    expect(resumeOffer(session(acked), worker(), false).line).toBe(
      "agent exited (0), not at a gate",
    );
    // No worker at all: nothing on the card, and `s` says why.
    expect(resumeOffer(session(info), undefined, false)).toEqual({
      line: "",
      why: "no agent of the TUI on this run",
    });
  });
});
