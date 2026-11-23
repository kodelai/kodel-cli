/**
 * When a background worker of a run is resumed after the person's decision (TASK-9PNS, Decision 1c;
 * TASK-G8KM, T-44). Pure: the journal, the run and the worker's latest record in, a verdict out. The
 * TUI words the verdict on the card and offers `s resumes`; `kodel serve` acts on it. Nothing here
 * starts anything: the name of the record (`kw-<run>-d<seq>`) is what makes a resume happen once.
 *
 * The journal only advises. `step_served` and its kin are bookkeeping the engine skips silently
 * (prompts off, the cap on served events, a repeated answer, a command step after a gate), so no
 * line can prove that the person's own agent is not continuing the run; `moved` is true whenever it
 * is set and claims nothing when absent.
 */
import type { JournalRecord, RunStatus } from "../run";
import type { SessionState } from "../session";

/** A decision the person made, as the journal records it: what a resume prompt and a question name. */
export interface RunDecision {
  /** The journal line of the decision; the resume record is named after it. */
  seq: number;
  ts: number;
  kind: "gate" | "pause" | "pipeline_change";
  node: string;
  outcome: "approved" | "rejected" | "resumed" | "accepted" | "dropped";
  reason?: string;
}

/** The last wait of a run that a person has to decide: a gate, a pause or a change of the pipeline. */
export interface WaitMark {
  seq: number;
  ts: number;
  kind: RunDecision["kind"];
  node: string;
}

/** A decision as the journal records it, and whether an agent made it for the person. */
export interface DecisionMark extends RunDecision {
  byAgent: boolean;
}

export interface DecisionInfo {
  /** The wait the decision answered: dated by its own record, or, for a hand-edited pipeline accepted, by the last sign of life before it. */
  lastWait?: WaitMark;
  decision?: DecisionMark;
  /** An agent was served, claimed or completed a step after the decision. */
  moved: boolean;
  /** The time of every wait line of the run, in order: a worker may have stopped at one before the last. */
  waits?: number[];
}

/**
 * Journal events that say nothing about the run's agent being alive: display data the host writes
 * on its own. A reader that dates a wait by the last sign of life leaves them out.
 */
export const NOT_A_SIGN_OF_LIFE: readonly string[] = ["agent_session_named", "worker_note"];

const WAIT_EVENTS: Record<string, RunDecision["kind"]> = {
  gate_waiting: "gate",
  run_paused: "pause",
  pipeline_change_proposed: "pipeline_change",
};

const MOVED_EVENTS = ["step_served", "step_claimed", "agent_completed"];

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
  const waits: number[] = [];
  for (const record of journal) {
    const kind = WAIT_EVENTS[record.event];
    if (kind === undefined) continue;
    if (record.event === "pipeline_change_proposed" && record.withdrawn === true) continue;
    waits.push(record.ts);
    if (record.seq <= previousDecisionSeq) continue;
    lastWait = { seq: record.seq, ts: record.ts, kind, node: text(record.node) ?? "pipeline" };
  }
  const waitList = waits.length === 0 ? {} : { waits };
  if (decision === undefined)
    return { ...(lastWait === undefined ? {} : { lastWait }), moved: false, ...waitList };
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
  return { ...(lastWait === undefined ? {} : { lastWait }), decision, moved, ...waitList };
}

/** When an agent last called the engine for the run (was served, claimed or completed a step), by the journal. */
export function lastAgentCallOf(journal: readonly JournalRecord[]): number | undefined {
  let last: number | undefined;
  for (const record of journal) {
    if (MOVED_EVENTS.includes(record.event) && (last === undefined || record.ts > last)) {
      last = record.ts;
    }
  }
  return last;
}

/** What a resume needs to know of a worker: its latest session record, as `kodel agent ls` reads it. */
export interface ServeWorkerView {
  /** The latest record: the `-d<seq>` one with the highest seq, else `kw-<run>`. */
  id: string;
  name: string;
  /** `unknown`: the record cannot be read. */
  state: SessionState | "unknown";
  /** The words of `kodel agent ls` for the state. */
  label: string;
  /** When the latest record's session started (milliseconds). */
  started: number;
  /** When it reached its state (milliseconds), when known. */
  since?: number;
  exitCode?: number;
  /** The id of the agent's own conversation, when the records name it. */
  sessionId?: string;
  /** The decisions that have a record, in any state. */
  resumed: number[];
  /** How many `-d` records the run has. */
  resumes: number;
  /** The decision the latest record resumed after; absent for `kw-<run>`. */
  decisionSeq?: number;
  /** The last time the session printed anything (milliseconds), when the record says. */
  lastOutputAt?: number;
  /** A person stopped it (`kodel agent stop`): it is not a worker that died. */
  stopped?: boolean;
  /** The session is over while its process still runs without a holder (`kodel agent ls`: "child still runs"). */
  childAlive?: boolean;
  /** A session in a terminal of its own: it stays alive at a wait, so its end at one is no death (T-47). */
  terminal?: boolean;
  /** How the record ended, as it says (`stopped`, `timeout`, `holder_error`, `holder_gone`, …). */
  endedBy?: string;
  /** The agent keeps writing to its terminal while idle: output is no sign of work, only engine calls are. */
  idleWrites?: boolean;
  /** The process table could not be read for this record: an agent left behind a dead wrapper would not be seen. */
  groupUnread?: boolean;
}

/** What a resume needs to know of a run. */
export interface ResumeRunView {
  runId: string;
  status: RunStatus;
  /** The run waits for a person now (a gate, a pause, a change of the pipeline). */
  waitsForPerson: boolean;
  marks?: DecisionInfo;
}

export type ResumeNo =
  | "no_worker"
  | "unknown"
  | "active"
  | "dead"
  | "over"
  | "not_at_wait"
  | "went_on"
  | "wait_before_start"
  | "waiting_person"
  | "undecided"
  | "agent_decided"
  | "already_resumed"
  | "no_session_id"
  | "moved"
  /** The session is over and its process still runs without a holder: alive for every rule. */
  | "child_alive"
  /** A person stopped it at the wait: the daemon leaves the resume to them. */
  | "stopped";

export type ResumeVerdict =
  | { kind: "resume"; seq: number; decision: DecisionMark }
  | { kind: "no"; why: ResumeNo };

const no = (why: ResumeNo): ResumeVerdict => ({ kind: "no", why });

/** Whether the latest session exited at the wait: the wait began during it, and it ended at or after the wait. */
function exitedAtWait(worker: ServeWorkerView, wait: WaitMark): boolean {
  return wait.ts >= worker.started && (worker.since === undefined || worker.since >= wait.ts);
}

/** Ends of a terminal session that say nothing about its work: the agent may have been waiting when it came. */
const ENDS_AT_A_WAIT: readonly string[] = ["stopped", "timeout", "holder_error"];

/**
 * Whether a worker that is `killed` or `lost` may have ended at a wait. A print worker never: its turn
 * ends at a wait, so it exits there, and any other end is a death. A worker in a terminal stays alive
 * at a wait, so a holder that went away, a timeout or a stop may have found it waiting.
 */
function mayHaveWaited(worker: ServeWorkerView): boolean {
  if (worker.terminal !== true) return false;
  if (worker.state === "lost") return true;
  return worker.endedBy !== undefined && ENDS_AT_A_WAIT.includes(worker.endedBy);
}

/**
 * Whether a terminal worker ended after the decision. An end in the same instant counts as before it.
 * The end of a `lost` record is only when the loss was noticed, an upper bound: such a worker ended
 * after the decision only when it printed something after it.
 */
function endedAfter(worker: ServeWorkerView, decision: DecisionMark): boolean {
  const end = worker.state === "lost" ? worker.lastOutputAt : worker.since;
  return end !== undefined && end > decision.ts;
}

/** The rule for a worker whose session is over and whose end may have been at a wait. */
function settledVerdict(
  run: ResumeRunView,
  worker: ServeWorkerView,
  opts: { refuseMoved: boolean },
): ResumeVerdict {
  if (run.status !== "running" && run.status !== "paused") return no("over");
  const lastWait = run.marks?.lastWait;
  const decision = run.marks?.decision;
  // A wait that left no wait line in the journal (a pipeline file edited by hand) is still a wait:
  // the worker stopped there, it did not die before one.
  if (lastWait === undefined) return no(run.waitsForPerson ? "waiting_person" : "not_at_wait");
  if (!exitedAtWait(worker, lastWait)) {
    // It stopped at an earlier wait and another agent took the run on to a later one: not a death.
    const stoppedAtOne = (run.marks?.waits ?? []).some(
      (ts) =>
        ts < lastWait.ts &&
        ts >= worker.started &&
        (worker.since === undefined || worker.since >= ts),
    );
    if (stoppedAtOne) return no("went_on");
    if (lastWait.ts < worker.started) {
      // The run waits now, but no wait line came after this worker started: a pipeline file edited by
      // hand while it worked. It stopped at that wait.
      if (run.waitsForPerson) return no("waiting_person");
      if (run.status === "running") return no("wait_before_start");
    }
    return no("not_at_wait");
  }
  if (run.waitsForPerson) return no("waiting_person");
  if (decision === undefined || decision.seq <= lastWait.seq) return no("undecided");
  if (decision.byAgent) return no("agent_decided");
  if (worker.resumed.includes(decision.seq)) return no("already_resumed");
  // `moved` is any agent's step, not this worker's. A terminal worker that was alive at the decision
  // and ended after an agent went on is the one that went on: it died at work, not at the wait.
  if (run.marks?.moved === true && worker.terminal === true && endedAfter(worker, decision)) {
    return no("not_at_wait");
  }
  if (worker.sessionId === undefined) return no("no_session_id");
  if (opts.refuseMoved && run.marks?.moved === true) return no("moved");
  return { kind: "resume", seq: decision.seq, decision };
}

/** What a person's stop leaves of a verdict: the waits stay waits, everything else is a session that is over. */
const KEPT_WHEN_STOPPED: readonly ResumeNo[] = ["over", "waiting_person", "undecided", "moved"];

/**
 * The rule. A worker is resumed when the run is going, the latest record ended at the last wait (a
 * print worker `exited` there; a worker in a terminal ended there in any way but a start that never
 * came), the person decided after that wait, no record of that decision exists in any state and a
 * session id is known. A record whose process still runs without a holder is alive for every rule
 * (`child_alive`). With `refuseMoved` an agent that was served a step since the decision also stops
 * it; the TUI passes `false` and words that case itself. A worker a person stopped at the wait is
 * resumed only with `resumeStopped` (the TUI's offer); the daemon answers `stopped`.
 */
export function resumeVerdict(
  run: ResumeRunView,
  worker: ServeWorkerView | undefined,
  opts: { refuseMoved: boolean; resumeStopped?: boolean },
): ResumeVerdict {
  if (worker === undefined) return no("no_worker");
  if (worker.state === "unknown") return no("unknown");
  if (worker.state === "starting" || worker.state === "running") return no("active");
  const gone = worker.state === "killed" || worker.state === "lost";
  if (gone && worker.childAlive === true) return no("child_alive");
  if (gone && !mayHaveWaited(worker)) return no("dead");
  const verdict = settledVerdict(run, worker, opts);
  if (gone && worker.stopped === true) {
    if (verdict.kind === "resume") return opts.resumeStopped === true ? verdict : no("stopped");
    return KEPT_WHEN_STOPPED.includes(verdict.why) ? verdict : no("dead");
  }
  return verdict;
}
