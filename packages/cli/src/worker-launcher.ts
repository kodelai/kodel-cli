/**
 * A worker: a background coding agent the TUI starts to drive one run (TASK-9PNS). This is the part
 * that is not about any one agent: the names of the session records, what the screen knows of a
 * worker, and the interface the loop sees. `claude-worker.ts` is the claude profile behind it, and
 * `worker-launcher-session.ts` the one that starts real sessions; tests give the TUI a fake.
 */
import type { SessionState } from "@kodel-ai/pipeline-core";

/** A session lives this long at most; the person's `kodel agent stop` ends it sooner. */
export const WORKER_TIMEOUT_MS = 12 * 3_600_000;
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
export interface WorkerDecision {
  /** The journal line of the decision; the resume record is named after it. */
  seq: number;
  ts: number;
  kind: "gate" | "pause" | "pipeline_change";
  node: string;
  outcome: "approved" | "rejected" | "resumed" | "accepted" | "dropped";
  reason?: string;
}

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
}

export interface WorkerProgress {
  /** The digest, oldest first. */
  lines: string[];
  /** The session id the tail names, when it does: it wins over the one read from the records' argv. */
  sessionId?: string;
}

export type PreflightResult = { ok: true } | { ok: false; reason: string };

export interface PreflightInput {
  /** `decisions.dialog` of the project config: a background agent cannot answer a dialog. */
  dialog: boolean;
  /** Whether the host can tie a run to a task (`host.taskLink()` is defined). */
  taskLink: boolean;
  /** How many pipelines load. */
  pipelines: number;
}

export interface StartInput {
  runId: string;
  workdir: string;
  title: string;
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
  stop(runId: string): Promise<void>;
}
