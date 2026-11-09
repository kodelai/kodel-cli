/**
 * When the card of a run offers `s resumes` (TASK-9PNS, Decision 1c). Pure: the journal, the run as
 * the screen sees it and the worker's records in, the offer (or why not, in the card's words) out.
 * Nothing here starts anything: the person's `s` then `y` does, once per decision, and the name of
 * the record (`kw-<run>-d<seq>`) is what makes it once.
 *
 * The journal only advises. `step_served` and its kin are bookkeeping the engine skips silently
 * (prompts off, the cap on served events, a repeated answer, a command step after a gate), so no
 * line can prove that the person's own agent is not continuing the run; the one line shown
 * (`an agent was served a step since`) is true whenever it is shown and claims nothing when absent.
 */
import type { JournalRecord } from "@kodel-ai/pipeline-core";
import type { WorkerDecision, WorkerStatus } from "../worker-launcher";
import { workerNameOf } from "../worker-launcher";
import type { Session } from "./session";

/** The last wait of a run that a person has to decide: a gate, a pause or a change of the pipeline. */
export interface WaitMark {
  seq: number;
  ts: number;
  kind: WorkerDecision["kind"];
  node: string;
}

/** A decision as the journal records it, and whether an agent made it for the person. */
export interface DecisionMark extends WorkerDecision {
  byAgent: boolean;
}

export interface DecisionInfo {
  /** The wait the decision answered: dated by its own record, or, for a hand-edited pipeline accepted, by the last sign of life before it. */
  lastWait?: WaitMark;
  decision?: DecisionMark;
  /** An agent was served, claimed or completed a step after the decision. */
  moved: boolean;
}

const WAIT_EVENTS: Record<string, WorkerDecision["kind"]> = {
  gate_waiting: "gate",
  run_paused: "pause",
  pipeline_change_proposed: "pipeline_change",
};

const MOVED_EVENTS = ["step_served", "step_claimed", "agent_completed"];
const NOT_A_SIGN_OF_LIFE = ["agent_session_named"];

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The slugs a `pipeline_accepted` names, as one word for the question. */
function changedNodes(record: JournalRecord): string {
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  const slugs = nodes
    .map((n) =>
      typeof n === "object" && n !== null ? text((n as Record<string, unknown>).slug) : undefined,
    )
    .filter((s): s is string => s !== undefined);
  if (slugs.length === 0) return "pipeline";
  return slugs.length > 3 ? `${slugs.slice(0, 3).join(", ")}, …` : slugs.join(", ");
}

/** The decision a record is, if it is one. */
function decisionRecord(record: JournalRecord): DecisionMark | undefined {
  const byAgent = record.decided_by === "agent";
  const base = { seq: record.seq, ts: record.ts, byAgent };
  switch (record.event) {
    case "gate_decided": {
      const outcome = record.decision === "approved" ? "approved" : "rejected";
      const reason = text(record.reason);
      return {
        ...base,
        kind: "gate",
        node: text(record.node) ?? "?",
        outcome,
        ...(reason === undefined ? {} : { reason }),
      };
    }
    case "run_resumed":
      return { ...base, kind: "pause", node: text(record.node) ?? "?", outcome: "resumed" };
    case "pipeline_accepted":
      return { ...base, kind: "pipeline_change", node: changedNodes(record), outcome: "accepted" };
    case "pipeline_change_proposed": {
      if (record.withdrawn !== true) return undefined;
      const reason = text(record.summary);
      return {
        ...base,
        kind: "pipeline_change",
        node: "pipeline",
        outcome: "dropped",
        ...(reason === undefined ? {} : { reason }),
      };
    }
    default:
      return undefined;
  }
}

/** What the journal says about the last decision of a run and the wait it answered. */
export function decisionOf(journal: readonly JournalRecord[]): DecisionInfo {
  let decision: DecisionMark | undefined;
  let decisionRecordIndex = -1;
  let previousDecisionSeq = -1;
  for (const [i, record] of journal.entries()) {
    const found = decisionRecord(record);
    if (found === undefined) continue;
    previousDecisionSeq = decision?.seq ?? -1;
    decision = found;
    decisionRecordIndex = i;
  }
  // The last wait of the run, whoever answered it: a wait after the decision is the run waiting again
  // (the resumed worker exits at it), a wait before an older decision belongs to that one and is stale.
  let lastWait: WaitMark | undefined;
  for (const record of journal) {
    if (record.seq <= previousDecisionSeq) continue;
    const kind = WAIT_EVENTS[record.event];
    if (kind === undefined) continue;
    if (record.event === "pipeline_change_proposed" && record.withdrawn === true) continue;
    lastWait = { seq: record.seq, ts: record.ts, kind, node: text(record.node) ?? "pipeline" };
  }
  if (decision === undefined)
    return { ...(lastWait === undefined ? {} : { lastWait }), moved: false };
  const accepted = journal[decisionRecordIndex];
  if (
    lastWait === undefined &&
    accepted !== undefined &&
    accepted.event === "pipeline_accepted" &&
    accepted.source === "file"
  ) {
    // A pipeline file edited by hand has no wait line of its own: only the apply writes. Its wait is
    // dated as the card dates it, by the last sign of life before it.
    const before = journal
      .slice(0, decisionRecordIndex)
      .findLast((r) => !NOT_A_SIGN_OF_LIFE.includes(r.event));
    if (before !== undefined) {
      lastWait = { seq: before.seq, ts: before.ts, kind: "pipeline_change", node: decision.node };
    }
  }
  const moved = journal.some((r) => r.seq > decision.seq && MOVED_EVENTS.includes(r.event));
  return { ...(lastWait === undefined ? {} : { lastWait }), decision, moved };
}

export interface OfferDetail {
  seq: number;
  decision: DecisionMark;
  moved: boolean;
}

/**
 * The offer, with the card's line for the worker; or no offer, the card's line and what `s` says.
 * The line always starts with `agent` (or the record's name) so the card reads the same way.
 */
export type ResumeOffer =
  | { offer: OfferDetail; line: string }
  | { offer?: undefined; line: string; why: string };

const sessionWord = (worker: WorkerStatus) =>
  worker.resumes > 0 ? ` (session ${worker.resumes + 1})` : "";

const exitWord = (worker: WorkerStatus) =>
  worker.exitCode === undefined ? "agent exited" : `agent exited (${worker.exitCode})`;

const notAtGate = (session: Session, worker: WorkerStatus): ResumeOffer => ({
  line: `${exitWord(worker)}, not at a gate`,
  why: `the agent exited, not at a gate; any agent continues the run with pipeline_next_step ${session.id}`,
});

/** Whether the latest session exited at the wait: the wait began during it, and it ended at or after the wait. */
function exitedAtWait(worker: WorkerStatus, wait: WaitMark): boolean {
  return wait.ts >= worker.started && (worker.since === undefined || worker.since >= wait.ts);
}

/**
 * The rule. Offered when the run is `running`, the latest record `exited` at the last wait, the
 * person decided after that wait, no record of that decision exists in any state, a session id is
 * known and the TUI's own decision work is not pending. Every other case says why on the card.
 */
export function resumeOffer(
  session: Session,
  worker: WorkerStatus | undefined,
  pending: boolean,
): ResumeOffer {
  if (worker === undefined) return { line: "", why: "no agent of the TUI on this run" };
  const over =
    session.status === "done" ||
    session.status === "failed" ||
    session.status === "canceled" ||
    session.status === "unreadable";
  const { lastWait, decision } = session;
  if (worker.state === "unknown") {
    return { line: "agent unknown (cannot be read)", why: "the agent's record cannot be read" };
  }
  if (worker.state === "starting" || worker.state === "running") {
    const line = `agent ${worker.state}${sessionWord(worker)}`;
    return { line, why: line };
  }
  if (worker.state === "killed" || worker.state === "lost") {
    const line = `agent ${worker.label}`;
    return {
      line,
      why: `${line}; any agent continues the run with pipeline_next_step ${session.id}`,
    };
  }
  // exited
  if (over) {
    return { line: `${exitWord(worker)}${sessionWord(worker)}`, why: "the run is over" };
  }
  if (lastWait === undefined || !exitedAtWait(worker, lastWait)) {
    if (lastWait !== undefined && lastWait.ts < worker.started && session.status === "running") {
      return {
        line: `${exitWord(worker)}, not at a gate`,
        why: `the wait is dated before the agent started; any agent continues the run with pipeline_next_step ${session.id}`,
      };
    }
    return notAtGate(session, worker);
  }
  if (session.status === "waiting") {
    return { line: "agent waiting for you", why: "the run waits for your decision" };
  }
  if (decision === undefined || decision.seq <= lastWait.seq) {
    return {
      line: `${exitWord(worker)} at a wait; nothing decided since`,
      why: `nothing was decided since the agent's wait; any agent continues the run with pipeline_next_step ${session.id}`,
    };
  }
  if (decision.byAgent) {
    return {
      line: "agent exited; an agent decided and goes on",
      why: "an agent decided for you and goes on with the run",
    };
  }
  if (worker.resumed.includes(decision.seq)) {
    const name = workerNameOf(session.id, decision.seq);
    return {
      line: `${name} ended: kodel agent logs ${name}`,
      why: `${name} ended: kodel agent logs ${name}`,
    };
  }
  if (worker.sessionId === undefined) {
    const name = workerNameOf(session.id);
    return {
      line: `${exitWord(worker)}; no session id`,
      why: `no session id: kodel agent logs ${name}`,
    };
  }
  if (pending) {
    return {
      line: `${exitWord(worker)} at your decision; the TUI is running the step`,
      why: "the TUI is running the step; wait for it",
    };
  }
  const moved = session.moved === true;
  return {
    offer: { seq: decision.seq, decision, moved },
    line: `agent exited at your decision · s resumes${moved ? " · an agent was served a step since" : ""}`,
  };
}
