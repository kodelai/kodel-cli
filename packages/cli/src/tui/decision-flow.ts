/**
 * Deciding a gate or a pause from the screen, as a small state machine over the model: the checks are
 * asked for (`asking`), the person gives a reason for a rejection when there is none (`reason`),
 * answers the questions (`confirm`), and the write is made (`writing`). The model only asks for the
 * checks and the write as effects; the loop does them (`decide.ts`) and hands the answers back here.
 *
 * Nothing is written before the last `y` of the questions of a check that has arrived for this very
 * decision: a `y` while the checks are still being made does nothing.
 */
import { bold, dim, inverse } from "./ansi";
import type { CheckResult, DecisionOutcome, DecisionRef, Session } from "./session";
import { decisionKey } from "./session";
import type { Effect } from "./view";

export type FlowDecision = "approve" | "reject" | "resume";

export interface Flow {
  /** Tells this decision from an earlier one whose answer arrives late. */
  id: number;
  runId: string;
  title: string;
  ref: DecisionRef;
  decision: FlowDecision;
  phase: "asking" | "reason" | "confirm" | "writing";
  /** The reason being typed. */
  text: string;
  /** The reason that was typed and sent with the check. */
  reason?: string;
  questions: string[];
  /** Which question is on the screen. */
  at: number;
  /** How many lines of the question in the window are scrolled off the top. */
  scroll: number;
  /** When the window last changed what it asks (the screen's clock): a click right after it is not an answer. */
  shownAt: number;
  /** When a yes last only read a long question on to its end: a yes right after it is not an answer. */
  readOnAt?: number;
}

/** The part of the model the flow works on. */
export interface FlowFields {
  now: number;
  flow: Flow | null;
  flowSeq: number;
  effects: Effect[];
  notice: string;
}

const VERB: Record<FlowDecision, string> = {
  approve: "Approve",
  reject: "Reject",
  resume: "Resume",
};

const checkEffect = (f: Flow): Effect => ({
  type: "check_decision",
  flow: f.id,
  runId: f.runId,
  ref: f.ref,
  decision: f.decision,
  ...(f.reason === undefined ? {} : { reason: f.reason }),
});

const decideEffect = (f: Flow): Effect => ({
  type: "decide",
  flow: f.id,
  runId: f.runId,
  ref: f.ref,
  decision: f.decision,
  ...(f.reason === undefined ? {} : { reason: f.reason }),
});

/** `a` or `r` was pressed on a decision: the checks are asked for. */
export function beginFlow<M extends FlowFields>(
  m: M,
  run: Pick<Session, "id" | "title">,
  ref: DecisionRef,
  decision: FlowDecision,
): M {
  const id = m.flowSeq + 1;
  const flow: Flow = {
    id,
    runId: run.id,
    title: run.title,
    ref,
    decision,
    phase: "asking",
    text: "",
    questions: [],
    at: 0,
    scroll: 0,
    shownAt: m.now,
  };
  return { ...m, flow, flowSeq: id, notice: "", effects: [...m.effects, checkEffect(flow)] };
}

/** The checks have answered. An answer for a decision that is no longer asked is dropped. */
export function flowChecked<M extends FlowFields>(m: M, id: number, result: CheckResult): M {
  const f = m.flow;
  if (!f || f.id !== id || f.phase !== "asking") return m;
  if (!result.ok) {
    if (result.needsReason) {
      return { ...m, flow: { ...f, phase: "reason", text: "", shownAt: m.now } };
    }
    return { ...m, flow: null, notice: result.message };
  }
  return {
    ...m,
    flow: { ...f, phase: "confirm", questions: result.questions, at: 0, scroll: 0, shownAt: m.now },
  };
}

/** The write has been made, or refused. */
export function flowDecided<M extends FlowFields>(m: M, id: number, outcome: DecisionOutcome): M {
  const f = m.flow;
  if (!f || f.id !== id) return m;
  return { ...m, flow: null, notice: outcome.message };
}

/** New data was read: a decision that is no longer there (decided elsewhere) is dropped, not written. */
export function flowGone<M extends FlowFields>(m: M, sessions: Session[]): M {
  const f = m.flow;
  if (!f || f.phase === "writing") return m;
  const s = sessions.find((x) => x.id === f.runId);
  const key = decisionKey(f.ref);
  const now = s?.decisions?.find((d) => decisionKey(d) === key);
  if (now === undefined) {
    return {
      ...m,
      flow: null,
      notice: "That decision is gone (decided elsewhere); nothing was written.",
    };
  }
  if (f.ref.attempt !== undefined && now.attempt !== undefined && now.attempt !== f.ref.attempt) {
    return {
      ...m,
      flow: null,
      notice:
        "That gate was decided and reached again (a new attempt); look again. Nothing was written.",
    };
  }
  return m;
}

/** Whether `q` leaves at once: while the checks or the write are going the person can still quit. */
export function flowYieldsQuit(f: Flow): boolean {
  return f.phase === "asking" || f.phase === "writing";
}

const PAGE = 8;
/** The keys that read on in a long question, and by how many lines. */
const SCROLL: Record<string, number> = {
  up: -1,
  k: -1,
  down: 1,
  j: 1,
  pageup: -PAGE,
  b: -PAGE,
  pagedown: PAGE,
  " ": PAGE,
};

/** A key while a decision is going on. */
export function flowKey<M extends FlowFields>(m: M, key: string): M {
  const f = m.flow;
  if (!f) return m;
  switch (f.phase) {
    case "asking":
      return key === "escape" ? { ...m, flow: null, notice: "Cancelled." } : m;
    case "writing":
      return m;
    case "confirm": {
      // The question can be longer than the window: the arrows read on instead of cancelling it.
      const moved = SCROLL[key];
      if (moved !== undefined) {
        return { ...m, flow: { ...f, scroll: Math.max(0, f.scroll + moved) } };
      }
      if (key !== "y") return { ...m, flow: null, notice: "Cancelled." };
      if (f.at + 1 < f.questions.length) {
        return { ...m, flow: { ...f, at: f.at + 1, scroll: 0, shownAt: m.now } };
      }
      return {
        ...m,
        flow: { ...f, phase: "writing" },
        effects: [...m.effects, decideEffect(f)],
      };
    }
    case "reason": {
      if (key === "escape") return { ...m, flow: null, notice: "Cancelled." };
      if (key === "enter") {
        const reason = f.text.trim();
        if (reason === "") {
          return { ...m, flow: null, notice: "A rejection needs a reason; nothing was written." };
        }
        const asking: Flow = { ...f, phase: "asking", reason, shownAt: m.now };
        return { ...m, flow: asking, effects: [...m.effects, checkEffect(asking)] };
      }
      if (key === "backspace") {
        return { ...m, flow: { ...f, text: [...f.text].slice(0, -1).join("") } };
      }
      return [...key].length === 1 && key >= " " ? { ...m, flow: { ...f, text: f.text + key } } : m;
    }
  }
}

/** The line at the bottom while a decision is going on. */
export function flowBar(f: Flow): string {
  switch (f.phase) {
    case "asking":
      return `${dim("Checking…")}   ${bold("Esc")} cancel`;
    case "writing":
      return dim("Writing the decision…");
    case "confirm": {
      const step = f.questions.length > 1 ? ` (${f.at + 1} of ${f.questions.length})` : "";
      // The keys come first: text that the agent's session wrote must not push them off a narrow screen.
      return `${bold("y")} yes   ${bold("n")} no   ${bold("↑↓")} read on   ${bold(VERB[f.decision])}${step} «${f.title}»?`;
    }
    case "reason":
      return `${bold("Reason")} for rejecting «${f.title}»: ${f.text}${inverse(" ")}   ${dim("Enter ok · Esc cancel")}`;
  }
}
