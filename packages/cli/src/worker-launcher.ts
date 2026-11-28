/**
 * A worker: a background coding agent the TUI starts to drive one run (TASK-9PNS). This is the part
 * that is not about any one agent: the names of the session records, what the screen knows of a
 * worker, and the interface the loop sees. `claude-worker.ts` is the claude profile behind it, and
 * `worker-launcher-session.ts` the one that starts real sessions; tests give the TUI a fake.
 */
import type { JournalRecord, SessionState, Started, StopVia } from "@kodel-ai/pipeline-core";
import type { RunDecision } from "@kodel-ai/pipeline-core/serve";

/** A session lives this long at most; the person's `kodel agent stop` ends it sooner. */
export const WORKER_TIMEOUT_MS = 12 * 3_600_000;
/**
 * A worker in a terminal of its own stays alive at a wait, so it lives this long at most (7 days). The
 * command it watches its run with gives up at the same moment: one constant for both.
 */
export const WORKER_TERMINAL_TIMEOUT_MS = 7 * 24 * 3_600_000;
/** How often the worker records are read while the screen is open. */
export const WORKER_REFRESH_MS = 4_000;

const PREFIX = "kw-";
const RESUME = /^kw-(r_[0-9a-z]+_[0-9a-z]+)(?:-d([1-9][0-9]*))?$/;

/** `kw-<run id>` for the first session of a run, `kw-<run id>-d<seq>` for the resume after the decision at journal line `seq`. */
export function workerNameOf(runId: string, decisionSeq?: number): string {
  return decisionSeq === undefined ? `${PREFIX}${runId}` : `${PREFIX}${runId}-d${decisionSeq}`;
}

/** The run and the decision a record name stands for; nothing for a name that is not a worker's. */
export function workerRunOf(name: string): { runId: string; decisionSeq?: number } | undefined {
  const match = RESUME.exec(name);
  if (!match || match[1] === undefined) return undefined;
  const seq = match[2];
  return seq === undefined ? { runId: match[1] } : { runId: match[1], decisionSeq: Number(seq) };
}

/** A decision the person made, as the journal records it: what the resume prompt and the question name. */
export type WorkerDecision = RunDecision;

/** What the screen knows of the worker of one run: its latest record, read from the session records. */
export interface WorkerStatus {
  /** The latest record: the `-d<seq>` one with the highest seq, else `kw-<run>`. */
  id: string;
  name: string;
  /** `unknown`: the record cannot be read (a `problem` entry, or a read that failed). */
  state: SessionState | "unknown";
  /** The words of `kodel agent ls` for the state. */
  label: string;
  exitCode?: number;
  /** When the latest record's session started (milliseconds). */
  started: number;
  /** When it reached its state (milliseconds), when known. */
  since?: number;
  /** The id of the agent's own conversation, when the records name it. */
  sessionId?: string;
  /** The decisions that have a record, in any state. */
  resumed: number[];
  /** How many `-d` records the run has. */
  resumes: number;
  /** The decision the latest record resumed after; absent for `kw-<run>`. */
  decisionSeq?: number;
  /** When the latest record's session last printed anything (milliseconds); absent when the record does not say. */
  lastOutputAt?: number;
  /**
   * A person stopped the latest record (`kodel agent stop`; the stop record says who asked, whatever end the
   * status record names): it is not a worker that died. A session kodel ended because its run was over
   * (`finish`) is stopped too, but not by the person, and does not carry this.
   */
  stopped?: true;
  /** With `stopped`: the stop came through a manager's server (the note on the stop record); it changes no rule. */
  stoppedVia?: StopVia;
  /**
   * The latest record's session is over (`lost` or `killed`) while its process still runs without a holder: the
   * worker is alive for every rule, and only the person's `kodel agent stop` ends it.
   */
  childAlive?: true;
  /** The latest record is a session in a terminal of its own (`mode: pty`): it stays alive at a wait. */
  terminal?: true;
  /**
   * How the latest record ended: its reason (`stopped`, `timeout`, `holder_error`, `holder_gone`, …), or
   * `signal` for one that names only a signal (a holder told to end by a shutdown, a program that was killed).
   */
  endedBy?: string;
  /** The agent's profile says an idle session keeps writing to its terminal: output is no sign of work. */
  idleWrites?: true;
  /** The process table could not be read for this record: an agent left behind a dead wrapper would not be seen. */
  groupUnread?: true;
}

export interface WorkerProgress {
  /** The digest, oldest first. */
  lines: string[];
}

/** `note`: something the starter is told once though the start may go on. */
export type PreflightResult = { ok: true; note?: string } | { ok: false; reason: string };

export interface PreflightInput {
  /** `decisions.dialog` of the project config: a background agent cannot answer a dialog. */
  dialog: boolean;
  /** Whether the host can tie a run to a task (`host.taskLink()` is defined). */
  taskLink: boolean;
  /** How many pipelines load. */
  pipelines: number;
  /** The folder the worktrees of the runs are made in: where the agent's question about trust would come. */
  worktreesDir?: string;
  /** Nobody watches the start (the daemon): what would stop at a question is refused. */
  unattended?: boolean;
  /** The run has no task (`kodel agent start --pipeline`): the tracker is not asked. */
  noTask?: boolean;
}

export interface StartInput {
  runId: string;
  workdir: string;
  title: string;
  /** Who started the run, as a kind; kept in the session record (`startedBy`), never with any text. */
  startedBy?: Started;
}

export interface ResumeInput {
  runId: string;
  workdir: string;
  sessionId: string;
  decision: WorkerDecision;
}

/** What the loop asks of a launcher. Nothing here decides anything about a run. */
export interface WorkerLauncher {
  preflight(input: PreflightInput): Promise<PreflightResult>;
  /** Starts the first session of a run; throws `SessionError` or a plain `Error` with the reason. */
  start(input: StartInput): Promise<{ name: string }>;
  /**
   * Starts the resumed session as `kw-<run>-d<seq>`. `NAME_TAKEN` means another TUI (or the person)
   * did it already; any other `SessionError` is the reason the resume did not happen.
   */
  resume(input: ResumeInput): Promise<{ name: string }>;
  /** The worker of every run named, by run id; a run without a record is absent. Throws when the records cannot be read. */
  statuses(runIds: readonly string[]): Promise<Map<string, WorkerStatus>>;
  progress(runId: string): Promise<WorkerProgress>;
  logs(runId: string, bytes?: number): Promise<string>;
  /**
   * Stops the latest record of a run for a person: it reads `stopped` from then on. `via` only notes that
   * a manager's server asked; every reader takes the stop as the person's.
   */
  stop(runId: string, via?: StopVia): Promise<void>;
  /**
   * Ends the live session of a run that is over, with the processes it started. A session that is
   * already stopped or gone is no error. It decides nothing about a run, and it is not the person's
   * stop: the record does not read as one the person stopped.
   */
  finish(runId: string): Promise<void>;
  /** Whether a person's terminal can be connected to the run's live record now, and which record that is. */
  attachable(runId: string): Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
}

/** A worker of a run that `kodel serve` saw gone, as its `worker_note` says (TASK-G8KM, T-44). */
export interface WorkerGone {
  worker: string;
  id?: string;
  reason: string;
  /** When it was seen gone (milliseconds). */
  at: number;
  exit_code?: number;
}

/** The `worker_note`s of a journal, oldest first; a record without the shape is left out (a journal is not trusted). */
export function workerNotesOf(journal: readonly JournalRecord[]): WorkerGone[] {
  return journal.flatMap((r) => {
    if (r.event !== "worker_note" || r.what !== "gone" || typeof r.worker !== "string") return [];
    return [
      {
        worker: r.worker,
        ...(typeof r.id === "string" ? { id: r.id } : {}),
        reason: typeof r.reason === "string" ? r.reason : "unknown",
        at: typeof r.at === "number" ? r.at : r.ts,
        ...(typeof r.exit_code === "number" ? { exit_code: r.exit_code } : {}),
      },
    ];
  });
}

const clockOf = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

/**
 * One line for a worker that is gone: `agent kw-r_… lost at 10:02 (its holder is gone); any agent continues …`.
 * The advice to continue is for a run that is still open only.
 */
export function workerGoneLine(
  note: WorkerGone,
  clean: (text: string) => string = (t) => t,
  open = true,
): string {
  const at = clockOf(note.at);
  const name = clean(note.worker);
  const code = note.exit_code === undefined ? "" : `, code ${note.exit_code}`;
  const what =
    note.reason === "lost"
      ? `lost at ${at} (its holder is gone)`
      : note.reason === "killed"
        ? `killed at ${at}${code === "" ? "" : ` (${code.slice(2)})`}`
        : note.reason === "exited"
          ? `exited at ${at} outside a wait (${code === "" ? "no code" : code.slice(2)})`
          : note.reason === "not_started"
            ? `not started at ${at} (the launch failed)`
            : `gone at ${at} (${clean(note.reason)})`;
  return open
    ? `agent ${name} ${what}; any agent continues the run with pipeline_next_step`
    : `agent ${name} ${what}`;
}
