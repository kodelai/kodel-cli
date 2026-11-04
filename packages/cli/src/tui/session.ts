/** What the screens know about a run: the engine's state boiled down to what a person looks at. */
import type { ExecutorSource } from "@kodel-ai/pipeline-core";

/** `unreadable`: nothing can be decided about it, so it does not wait for anyone. */
export type Status = "waiting" | "running" | "failed" | "done" | "canceled" | "unreadable";

/** What a run needs from a person, in the order the engine itself puts them (the first blocks the rest). */
export type Need = "hand_edit" | "pipeline_edit" | "paused" | "approve";

/** `working`: the engine runs a command or a check. `agent`: the agent's turn. `quiet`: nothing heard for long. */
export type Activity = "working" | "agent" | "quiet";

export type StepState = "done" | "running" | "waiting" | "pending" | "failed";

export interface StepLine {
  name: string;
  state: StepState;
  note?: string;
}

/** The agent session the run was last worked in, as the journal records it (`load.ts`). */
export interface AgentSession {
  id: string;
  /** Where the engine got the id from: only `observed-env` is exact. */
  source: ExecutorSource;
  /** What the session is called in the agent's own log, when the journal has it. */
  name?: string;
  /** The copy of the agent's log found the session to call this run's tools. */
  proven: boolean;
}

/**
 * One decision that waits in a run: a gate or a paused step. A fork can hold several; the screen lets
 * the person pick one, and `a` / `r` / `c` act on the picked one by its node and attempt.
 */
export interface DecisionRef {
  kind: "gate" | "pause";
  node: string;
  /** The attempt of a gate (the one the person looked at); a pause has none. */
  attempt?: number;
  prompt: string;
  /** The command that decides it, as the engine words it. */
  command: string;
}

/** Tells one decision of a run from another. */
export function decisionKey(d: DecisionRef): string {
  return `${d.kind}:${d.node}:${d.attempt ?? 0}`;
}

/** What the checks said before anything is written: the questions to ask, or why not. */
export type CheckResult =
  | { ok: true; questions: string[] }
  | { ok: false; message: string; needsReason?: true };

/** What came of a write: the notice for the person. */
export interface DecisionOutcome {
  ok: boolean;
  message: string;
}

export interface Session {
  id: string;
  title: string;
  /** The session the run was last worked in; absent when the journal names none. */
  agentSession?: AgentSession;
  pipeline: string;
  status: Status;
  need?: Need;
  activity?: Activity;
  /** The step the run is at, or why it ended. */
  step: string;
  /**
   * The start of what the time column counts: when the wait began (waiting), when the run started
   * (running) or when it ended (finished). Milliseconds, like every time the engine keeps.
   */
  since: number;
  /** How long nothing was heard from a run that is `quiet`. */
  quietMs?: number;
  workdir?: string;
  /** The card's lines about what is asked of the person. */
  headline?: string;
  prompt?: string;
  /** What waits behind this need, once it is decided (a pipeline edit that holds an approval). */
  after?: string;
  /** The command that decides it, as the engine words it. */
  command?: string;
  /**
   * Every gate and pause of a waiting run that a key here can decide, the one the engine names first
   * in front. Empty when what waits is not one of them (a change of the pipeline, a hand edit). Not
   * set at all on sample data: the older keys then stand.
   */
  decisions?: DecisionRef[];
  /** What waits for a person in a run shown as running, which a key here cannot decide. */
  besides?: { kind: "gate" | "pause"; node: string; command: string }[];
  /** Why a failed run failed. */
  reason?: string;
  steps: StepLine[];
  log: string[];
}

/** The word in the list for what is asked. */
export const NEED_TAG: Record<Need, string> = {
  hand_edit: "hand edit",
  pipeline_edit: "pipeline edit",
  paused: "paused",
  approve: "approve",
};

/** What `a` and `r` mean for each need; a need without a key has no such decision. */
export const NEED_KEYS: Record<Need, { a?: string; r?: string }> = {
  hand_edit: { a: "accept as it is" },
  pipeline_edit: { a: "accept", r: "discard" },
  paused: { a: "resume" },
  approve: { a: "approve", r: "reject" },
};

export const QUIET_MS = 5 * 60_000;
/** Engine work that has not shown a sign of life for this long is not "working". */
export const HEARTBEAT_STALE_MS = 60_000;

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 10) return `${h}h${String(m % 60).padStart(2, "0")}`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Waiting sessions first, then running, then failed, then the rest, then the ones nobody can read; the newest on top in each. */
export function sortSessions(sessions: Session[]): Session[] {
  const rank = (s: Session) =>
    s.status === "waiting"
      ? 0
      : s.status === "running"
        ? 1
        : s.status === "failed"
          ? 2
          : s.status === "unreadable"
            ? 4
            : 3;
  return [...sessions].sort((a, b) => {
    const byGroup = rank(a) - rank(b);
    if (byGroup !== 0) return byGroup;
    return b.since - a.since;
  });
}

/** What the engine itself found out, as opposed to what the agent says. */
export interface CheckLine {
  node: string;
  label: string;
  passed: boolean;
  ms?: number;
}

export interface Finding {
  severity: string;
  location: string;
  description: string;
}

export type ChangeSummary =
  | { kind: "files"; files: [string, number][]; totalFiles: number; totalLines: number }
  | { kind: "none" }
  | { kind: "unavailable"; reason: string }
  | { kind: "no_repo" };

/** One try at a step: what it ended with and everything that was found out about it. */
export interface Attempt {
  n: number;
  /** The label the step ended with, or nothing while it is still going. */
  outcome?: string;
  ok?: boolean;
  ms?: number;
  exit?: number;
  /** Why a command or a check failed, or why a person rejected. */
  reason?: string;
  /** What the agent said it did; it is the agent's word, not checked. */
  summary?: string;
  checks: CheckLine[];
  decision?: { decision: string; reason?: string };
  review?: { completeness: string; findings: Finding[] };
  /** The journal records of this try, formatted. */
  log: string[];
  /** When the try began, and when it ended (nothing while it goes on), in milliseconds. */
  from?: number;
  to?: number;
}

/** One thing the agent said or did, with a tool call joined to its result. */
export interface LogEntry {
  ts: number;
  kind: "text" | "you" | "call" | "subagent";
  text: string;
  tool?: string;
  result?: { ok: boolean; ms?: number; size?: number; text?: string };
}

/** One entry of a run into a step, in the order it happened: the call list of the run. */
export interface Visit {
  slug: string;
  kind: string;
  human: boolean;
  state: StepState;
  /** The step was entered again after something failed. */
  rework: boolean;
  attempt: Attempt;
}

/** One row of the comments a person made at the gate. */
export interface Comment {
  severity: string;
  location: string;
  description: string;
}

export interface Metrics {
  /** Time the run was not waiting for a person, and time it was. */
  workMs: number;
  waitMs: number;
  stepsDone: number;
  stepsTotal: number;
  /** Entries into a step beyond the first. */
  retries: number;
  checksPassed: number;
  checksTotal: number;
  /** From the agent's own logs, when they can be read. */
  tokens?: { total: number; cost?: number; approx: boolean };
}

export interface AgentWords {
  text: string;
  ts: number;
  /** Where it came from: the agent's log, or the summary a step left in the journal. */
  from: "log" | "journal";
  /** For a summary: the step that left it. */
  step?: string;
}

/** Everything the card of a run waiting at a human step shows beyond the list row. */
export interface GateDetail {
  /** A run waiting at a human step, or one that is going on: the second has no question to answer. */
  kind: "gate" | "running";
  /** The step the run waits at, or is at. */
  node: string;
  /** The try the gate is on; comments are kept against it. */
  attempt: number;
  /** `gate 2 of 2` on the way this run takes, or `step 3 of 7` for a run that is going on. */
  position: string;
  prompt: string;
  instructions?: string;
  report?: AgentWords;
  visits: Visit[];
  /** The latest attempt of each step, as the engine judged it. */
  checks: CheckLine[];
  changes: ChangeSummary;
  /** Files that changed after the checks passed: the agent kept working. */
  changedAfterChecks: string[];
  comments: Comment[];
  metrics: Metrics;
  /** What the agent said and the tools it called, when its log can be read. */
  agentLog?: LogEntry[];
  /** The journal of the run, oldest first. */
  journal: string[];
}

/** A file's diff, once it has been read. */
export type DiffState =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "missing" }
  | { kind: "error"; message: string };
