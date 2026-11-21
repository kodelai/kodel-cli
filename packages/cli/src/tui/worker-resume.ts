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
import {
  type DecisionInfo,
  type DecisionMark,
  decisionOf,
  type ResumeRunView,
  resumeVerdict,
  type WaitMark,
} from "@kodel-ai/pipeline-core/serve";
import type { WorkerStatus } from "../worker-launcher";
import { workerNameOf } from "../worker-launcher";
import type { Session } from "./session";

export type { DecisionInfo, DecisionMark, WaitMark };
export { decisionOf };

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

/** The run as the rule sees it: an unreadable run is over, a run that waits for the person is going. */
function runView(session: Session): ResumeRunView {
  const status =
    session.status === "done"
      ? "completed"
      : session.status === "failed" || session.status === "unreadable"
        ? "failed"
        : session.status === "canceled"
          ? "canceled"
          : "running";
  return {
    runId: session.id,
    status,
    waitsForPerson: session.status === "waiting",
    marks: {
      ...(session.lastWait === undefined ? {} : { lastWait: session.lastWait }),
      ...(session.decision === undefined ? {} : { decision: session.decision }),
      moved: session.moved === true,
    },
  };
}

/**
 * The rule (`resumeVerdict`) in the card's words. Offered when the run is `running`, the latest
 * record `exited` at the last wait, the person decided after that wait, no record of that decision
 * exists in any state, a session id is known and the TUI's own decision work is not pending.
 */
export function resumeOffer(
  session: Session,
  worker: WorkerStatus | undefined,
  pending: boolean,
): ResumeOffer {
  if (worker === undefined) return { line: "", why: "no agent of the TUI on this run" };
  const verdict = resumeVerdict(runView(session), worker, { refuseMoved: false });
  if (verdict.kind === "resume") {
    if (pending) {
      return {
        line: `${exitWord(worker)} at your decision; the TUI is running the step`,
        why: "the TUI is running the step; wait for it",
      };
    }
    const moved = session.moved === true;
    return {
      offer: { seq: verdict.seq, decision: verdict.decision, moved },
      line: `agent exited at your decision · s resumes${moved ? " · an agent was served a step since" : ""}`,
    };
  }
  switch (verdict.why) {
    case "no_worker":
      return { line: "", why: "no agent of the TUI on this run" };
    case "unknown":
      return { line: "agent unknown (cannot be read)", why: "the agent's record cannot be read" };
    case "active": {
      const line = `agent ${worker.state}${sessionWord(worker)}`;
      return { line, why: line };
    }
    case "dead": {
      const line = `agent ${worker.label}`;
      return {
        line,
        why: `${line}; any agent continues the run with pipeline_next_step ${session.id}`,
      };
    }
    case "over":
      return { line: `${exitWord(worker)}${sessionWord(worker)}`, why: "the run is over" };
    case "wait_before_start":
      return {
        line: `${exitWord(worker)}, not at a gate`,
        why: `the wait is dated before the agent started; any agent continues the run with pipeline_next_step ${session.id}`,
      };
    case "not_at_wait":
      return notAtGate(session, worker);
    case "went_on":
      return {
        line: `${exitWord(worker)} at a wait; another agent went on`,
        why: `the agent stopped at an earlier wait and another agent took the run on; any agent continues the run with pipeline_next_step ${session.id}`,
      };
    case "waiting_person":
      return { line: "agent waiting for you", why: "the run waits for your decision" };
    case "undecided":
      return {
        line: `${exitWord(worker)} at a wait; nothing decided since`,
        why: `nothing was decided since the agent's wait; any agent continues the run with pipeline_next_step ${session.id}`,
      };
    case "agent_decided":
      return {
        line: "agent exited; an agent decided and goes on",
        why: "an agent decided for you and goes on with the run",
      };
    case "already_resumed": {
      const name = workerNameOf(session.id, session.decision?.seq);
      return {
        line: `${name} ended: kodel agent logs ${name}`,
        why: `${name} ended: kodel agent logs ${name}`,
      };
    }
    case "no_session_id": {
      const name = workerNameOf(session.id);
      return {
        line: `${exitWord(worker)}; no session id`,
        why: `no session id: kodel agent logs ${name}`,
      };
    }
    case "moved":
      // not asked for: the TUI offers the resume and says an agent moved
      return { line: "", why: "an agent was served a step since" };
  }
}
