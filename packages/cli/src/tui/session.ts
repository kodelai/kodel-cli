/** What the screens know about a run: the engine's state boiled down to what a person looks at. */

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

export interface Session {
  id: string;
  title: string;
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

/** Waiting sessions first (the longest wait on top), then running (newest first), then failed, then the rest, then the ones nobody can read. */
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
    return a.status === "waiting" ? a.since - b.since : b.since - a.since;
  });
}

/** One step on the way a run goes, in the order it goes. */
export interface PathStep {
  slug: string;
  state: StepState;
  /** A person decides it. */
  human: boolean;
  /** `×2` for a step that ran twice. */
  note?: string;
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

export interface DecisionLine {
  node: string;
  decision: string;
  reason?: string;
  ts: number;
}

/** Everything the card of a run waiting at a human step shows beyond the list row. */
export interface GateDetail {
  node: string;
  /** `gate 2 of 2` on the way this run takes. */
  position: string;
  prompt: string;
  instructions?: string;
  path: PathStep[];
  checks: CheckLine[];
  review?: { node: string; completeness: string; findings: Finding[] };
  changes: ChangeSummary;
  /** Files that changed after the checks passed: the agent kept working. */
  changedAfterChecks: string[];
  decisions: DecisionLine[];
  /** Comments already recorded at this step. */
  comments: number;
}
