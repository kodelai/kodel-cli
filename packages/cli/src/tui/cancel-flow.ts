/**
 * Cancelling a run from the screen (TASK-NE3N): `x` on a run that is going asks for a reason, then a
 * `y` in a window, and only then is the cancel written, by the very function `kodel run cancel` calls
 * (`../cancel-run.ts`). Esc, or any key the question does not take, leaves the run as it was.
 */
import { type CancelAnswer, type CancelPorts, cancelLines, cancelRun } from "../cancel-run";
import { plain } from "../plain";
import { bold, dim, inverse, yellow } from "./ansi";
import { boxOf, hardWrap, innerWidth, type Modal } from "./modal";
import type { Session } from "./session";
import type { Effect } from "./view";

export interface CancelQuestion {
  /** Tells this cancel from an earlier one whose answer arrives late. */
  seq: number;
  runId: string;
  title: string;
  phase: "reason" | "confirm" | "writing";
  /** The reason being typed, then the one that is sent. */
  text: string;
  /** The screen's clock when the question last changed what it asks: a `y` right after it is not an answer. */
  shownAt: number;
}

/** The part of the model the cancel works on. */
export interface CancelFields {
  now: number;
  cancel: CancelQuestion | null;
  cancelSeq: number;
  effects: Effect[];
  notice: string;
}

/** What the loop answers for a cancel: the notice for the person. */
export interface CancelOutcome {
  ok: boolean;
  message: string;
}

/** How long a `y` is not taken after the question appeared: a burst of keys is over by then. */
const GUARD_MS = 400;
/** The longest reason the screen takes; the command refuses a longer one anyway. */
const REASON_MAX = 2_000;

/** A run that is going (running, or waiting for a person) can be canceled; one that has ended cannot. */
export function cancelable(s: Pick<Session, "status">): boolean {
  return s.status === "running" || s.status === "waiting";
}

/** `x` on a run: the reason is asked for, or why nothing is done. */
export function beginCancel<M extends CancelFields>(
  m: M,
  s: Pick<Session, "id" | "title" | "status">,
): M {
  if (!cancelable(s)) {
    return { ...m, notice: `Nothing to cancel: run ${s.id} has ${endedWord(s.status)}.` };
  }
  const seq = m.cancelSeq + 1;
  return {
    ...m,
    cancelSeq: seq,
    cancel: { seq, runId: s.id, title: s.title, phase: "reason", text: "", shownAt: m.now },
    notice: "",
  };
}

const endedWord = (status: Session["status"]): string =>
  status === "done"
    ? "completed"
    : status === "unreadable"
      ? "a state that cannot be read"
      : status === "canceled"
        ? "been canceled"
        : status;

/** A key while the cancel is asked. `alone`: the key was the whole of its chunk of input. */
export function cancelKey<M extends CancelFields>(m: M, key: string, alone: boolean): M {
  const q = m.cancel;
  if (!q) return m;
  const cancelled = { ...m, cancel: null, notice: "Cancelled." };
  switch (q.phase) {
    case "writing":
      // The screen stays for the answer, which is quick: leaving now could cut off the stop of its agents.
      return m;
    case "confirm": {
      if (key !== "y" || !alone) return cancelled;
      if (m.now - q.shownAt < GUARD_MS) return { ...m, notice: "Wait a moment, then press y." };
      return {
        ...m,
        cancel: { ...q, phase: "writing" },
        notice: "",
        effects: [...m.effects, { type: "cancel_run", seq: q.seq, runId: q.runId, reason: q.text }],
      };
    }
    case "reason": {
      if (key === "escape") return cancelled;
      if (key === "enter") {
        // A line break that came with other text is a paste, not the person pressing Enter.
        if (!alone) return m;
        const reason = q.text.trim();
        if (reason === "") {
          return { ...m, cancel: null, notice: "A cancel needs a reason; nothing was written." };
        }
        return { ...m, cancel: { ...q, phase: "confirm", text: reason, shownAt: m.now } };
      }
      if (key === "backspace") {
        return { ...m, cancel: { ...q, text: [...q.text].slice(0, -1).join("") } };
      }
      if ([...key].length === 1 && key >= " " && q.text.length < REASON_MAX) {
        return { ...m, cancel: { ...q, text: q.text + key } };
      }
      return m;
    }
  }
}

/** Text pasted while the reason is typed: it goes into the reason, as one line. */
export function cancelPaste<M extends CancelFields>(m: M, line: string): M {
  const q = m.cancel;
  if (q?.phase !== "reason") return m;
  const room = REASON_MAX - q.text.length;
  return room <= 0
    ? m
    : { ...m, cancel: { ...q, text: q.text + [...line].slice(0, room).join("") } };
}

/** The cancel is written, or refused. An answer for another question is dropped. */
export function withCanceled<M extends CancelFields>(m: M, seq: number, outcome: CancelOutcome): M {
  if (m.cancel?.seq === seq) return { ...m, cancel: null, notice: outcome.message };
  return { ...m, notice: outcome.message };
}

/** New data was read: a question about a run that has ended meanwhile (or is gone) is let go. */
export function cancelKept<M extends CancelFields>(m: M, sessions: Session[]): M {
  const q = m.cancel;
  if (!q || q.phase === "writing") return m;
  const s = sessions.find((x) => x.id === q.runId);
  if (s !== undefined && cancelable(s)) return m;
  return { ...m, cancel: null, notice: "Cancelled: the run has ended; nothing was written." };
}

/** The line at the bottom while the cancel is asked. */
export function cancelBar(q: CancelQuestion, notice = ""): string {
  switch (q.phase) {
    case "reason":
      return `${bold("Reason")} for canceling «${q.title}»: ${q.text}${inverse(" ")}   ${dim("Enter ok · Esc cancel")}`;
    case "confirm":
      return notice !== ""
        ? yellow(notice)
        : `${bold("y")} cancel the run   ${bold("Esc")} keep it`;
    case "writing":
      return dim("Canceling the run…");
  }
}

/** The window of the question `y` answers. */
export function cancelModalOf(q: CancelQuestion, cols: number, height: number): Modal {
  const wrap = (text: string) => hardWrap(text, innerWidth(cols));
  return boxOf(
    {
      title: ` Cancel run «${q.title}» `,
      content: [
        ...wrap(
          bold(`Cancel run ${q.runId}? It ends for good; its task, branch and worktree stay.`),
        ),
        "",
        ...wrap(`Reason: ${plain(q.text)}`),
      ],
      footer: ["", dim("y cancel the run · Esc or any other key keeps it")],
      buttons: [
        { key: "y", text: "[y Cancel run]" },
        { key: "escape", text: "[Esc Keep it]" },
      ],
      scroll: 0,
      scrollable: false,
    },
    cols,
    height,
  );
}

/** The notice of a cancel that was written: what `kodel run cancel` prints, one fact after another. */
export function cancelNotice(answer: CancelAnswer): string {
  return cancelLines(answer).map(plain).join(" · ");
}

/** The option of the loop that cancels a run: the shared cancel, its answer as a notice. */
export function cancelOptions(ports: () => Promise<CancelPorts>): {
  cancelRun: (runId: string, reason: string) => Promise<CancelOutcome>;
} {
  return {
    cancelRun: async (runId, reason) => {
      const answer = await cancelRun(await ports(), { runId, reason });
      if (!answer.ok) {
        return {
          ok: false,
          message: `Could not cancel ${runId}: ${answer.error.code}: ${plain(answer.error.message)}`,
        };
      }
      return { ok: true, message: cancelNotice(answer) };
    },
  };
}
