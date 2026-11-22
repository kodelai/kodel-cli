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

/** The card's line for an agent in a terminal of its own that stays alive while its run waits for the person. */
export const WAITS_WITH_YOU_LINE = "agent waits with you";
/** The card's line for a live agent that has not called the engine since the person's decision. */
export const NOT_GONE_ON_LINE = "the agent has not gone on since your decision · o opens it";
/** The card's line for a live agent with a step open that has been quiet for long. */
export const STALLED_LINE = "agent stalled · o opens it";

/** After this long without an agent's line since the decision the card says so (the daemon's `not_moving`). */
export const NOT_MOVING_MS = 120_000;
/**
 * After this long with no output and no engine call a live agent reads `stalled` here: the default of
 * `serve.stalled_after_s`. The screen does not read the `serve` block; the daemon's own line follows it.
 */
export const STALLED_MS = 1_800_000;

/**
 * What a live agent in a terminal of its own reads besides `running`: it waits with the person, it has
 * not gone on since their decision, or it is quiet for long. kodel does not see what an agent runs, so
 * before a decision nothing tells a worker that waits from one whose `kodel wait` was lost.
 */
function liveTerminalLine(
  session: Session,
  worker: WorkerStatus,
  now: number | undefined,
): { line: string; why: string } | undefined {
  if (worker.terminal !== true || worker.state !== "running") return undefined;
  if (session.status === "waiting") {
    return {
      line: WAITS_WITH_YOU_LINE,
      why: "the agent waits with you: it goes on by itself after your decision",
    };
  }
  if (session.status !== "running" || now === undefined) return undefined;
  const { decision, lastWait } = session;
  if (
    decision !== undefined &&
    !decision.byAgent &&
    (lastWait === undefined || decision.seq > lastWait.seq) &&
    session.moved !== true &&
    now - decision.ts >= NOT_MOVING_MS
  ) {
    return {
      line: NOT_GONE_ON_LINE,
      why: "the agent is alive and has not gone on since your decision: o opens it",
    };
  }
  const quiet = now - (worker.lastOutputAt ?? worker.started);
  if ((session.quietMs ?? 0) >= STALLED_MS && (worker.idleWrites === true || quiet >= STALLED_MS)) {
    return {
      line: STALLED_LINE,
      why: "the agent is alive and has been quiet for long: o opens it",
    };
  }
  return undefined;
}

const sessionWord = (worker: WorkerStatus) =>
  worker.resumes > 0 ? ` (session ${worker.resumes + 1})` : "";

const exitWord = (worker: WorkerStatus) =>
  worker.exitCode === undefined ? "agent exited" : `agent exited (${worker.exitCode})`;

const notAtGate = (session: Session, worker: WorkerStatus): ResumeOffer => {
  // A worker in a terminal that was alive at the decision, went on and then ended: it died at work.
  if (worker.terminal === true && session.decision !== undefined && session.moved === true) {
    return {
      line: "agent died after your decision",
      why: `the agent went on after your decision and then ended (${worker.label}); any agent continues the run with pipeline_next_step ${session.id}`,
    };
  }
  return {
    line: `${exitWord(worker)}, not at a gate`,
    why: `the agent exited, not at a gate; any agent continues the run with pipeline_next_step ${session.id}`,
  };
};

/** How a worker that ended at a wait reads: a print worker exited there; one in a terminal ended in its own way. */
const endedWord = (worker: WorkerStatus) =>
  worker.state === "exited" ? "agent exited" : `agent ${worker.label}`;

/**
 * The run as the rule sees it: a run that waits for the person is going. A run that cannot be read is
 * never asked here (`resumeOffer` answers for it first): it is not a run that failed.
 */
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
 * record ended at the last wait (a worker the person stopped there among them: the daemon leaves that
 * one to the person), the person decided after that wait, no record of that decision exists in any
 * state, a session id is known and the TUI's own decision work is not pending. Never while the
 * record's process still runs without a holder.
 */
export function resumeOffer(
  session: Session,
  worker: WorkerStatus | undefined,
  pending: boolean,
  now?: number,
): ResumeOffer {
  if (worker === undefined) return { line: "", why: "no agent of the TUI on this run" };
  // Nothing is known of a run that cannot be read: its agent is neither resumed nor called over.
  if (session.status === "unreadable") {
    return {
      line: `agent ${worker.state === "unknown" ? "unknown (cannot be read)" : worker.label}`,
      why: "the run cannot be read",
    };
  }
  const verdict = resumeVerdict(runView(session), worker, {
    refuseMoved: false,
    resumeStopped: true,
  });
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
      line: `${endedWord(worker)} at your decision · s resumes${moved ? " · an agent was served a step since" : ""}`,
    };
  }
  switch (verdict.why) {
    case "no_worker":
      return { line: "", why: "no agent of the TUI on this run" };
    case "unknown":
      return { line: "agent unknown (cannot be read)", why: "the agent's record cannot be read" };
    case "active": {
      const live = liveTerminalLine(session, worker, now);
      if (live !== undefined) return live;
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
    case "child_alive": {
      // Its process still runs: a second agent would work the same run beside it.
      const line = `agent ${worker.label}`;
      return {
        line,
        why: `${worker.name}: its process still runs without a holder; stop it: kodel agent stop ${worker.id}`,
      };
    }
    case "stopped":
      // not asked for: the TUI resumes a worker the person stopped
      return { line: "agent stopped", why: "you stopped the agent" };
  }
}

/** What the screen knows of `kodel serve` when it asks whether to finish a worker itself. */
export type FinishServe = { kind: "off" | "active" | "silent" };

/**
 * The run whose live agent the screen ends itself, one a read: the daemon's rule (`finish`), for when no
 * daemon is active. Only a run of this checkout whose state was read as ended, and only an agent in a
 * terminal of its own (a print worker is left to print its last line and exit). A run that cannot be
 * read is never one of them. It decides nothing about a run.
 */
export function finishOf(
  sessions: readonly Session[],
  workers: Readonly<Record<string, WorkerStatus>>,
  serve: FinishServe,
): string | undefined {
  if (serve.kind === "active") return undefined;
  for (const session of sessions) {
    if (session.foreignRoot !== undefined) continue;
    if (session.status !== "done" && session.status !== "failed" && session.status !== "canceled") {
      continue;
    }
    const worker = workers[session.id];
    if (worker === undefined || worker.terminal !== true) continue;
    if (worker.state !== "running" && worker.state !== "starting") continue;
    return session.id;
  }
  return undefined;
}
