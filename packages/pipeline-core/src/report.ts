/**
 * A summary of one run, read from its journal and state: where the time went, how many attempts
 * each node took, what failed and why. Pure, so a host (a CLI, a server) only has to print it.
 */
import type { JournalRecord, RunState } from "./run";

export interface AttemptReport {
  attempt: number;
  /** The label the attempt ended with (`passed`, `failed`, `approved`, ...), if it ended. */
  outcome?: string;
  /** Seconds from entering the node to its outcome (to now, for one still going). */
  seconds: number;
  /** For an attempt that failed: where the failure came from and why. */
  failure?: { source: string; reason: string };
}

export interface NodeReport {
  node: string;
  /** A person decides at this node, so its time is waiting for a person, not work. */
  gate: boolean;
  attempts: AttemptReport[];
  seconds: number;
}

export interface RunReport {
  runId: string;
  task: string;
  status: string;
  /** Seconds from the start to the end (to the last record, for a run still going). */
  total_s: number;
  /** Seconds the engine and the agent spent on nodes that are not gates. */
  work_s: number;
  /** Seconds spent waiting for a person at gates. */
  waiting_s: number;
  nodes: NodeReport[];
  restarts: number;
  pauses: number;
  feedback: number;
  /** Attempts beyond the first, over all nodes: how much rework there was. */
  extra_attempts: number;
}

const seconds = (from: number, to: number) => Math.max(0, Math.round((to - from) / 100) / 10);

export function summarizeRun(state: RunState, journal: JournalRecord[]): RunReport {
  const nodes = new Map<string, NodeReport>();
  const entered = new Map<string, number>();
  const gates = new Set<string>();
  let restarts = 0;
  let pauses = 0;
  let feedback = 0;
  const first = journal[0]?.ts ?? state.startedAt;
  const last = journal.at(-1)?.ts ?? first;

  const nodeOf = (name: string): NodeReport => {
    let found = nodes.get(name);
    if (!found) {
      found = { node: name, gate: false, attempts: [], seconds: 0 };
      nodes.set(name, found);
    }
    return found;
  };

  for (const record of journal) {
    const name = typeof record.node === "string" ? record.node : undefined;
    const attempt = typeof record.attempt === "number" ? record.attempt : undefined;
    switch (record.event) {
      case "node_entered":
        if (name && attempt !== undefined) {
          entered.set(`${name}#${attempt}`, record.ts);
          nodeOf(name).attempts.push({ attempt, seconds: 0 });
        }
        break;
      case "gate_waiting":
        if (name) gates.add(name);
        break;
      case "node_finished":
        if (name && attempt !== undefined) {
          const found = nodeOf(name).attempts.find((a) => a.attempt === attempt);
          const from = entered.get(`${name}#${attempt}`) ?? record.ts;
          if (found) {
            found.seconds = seconds(from, record.ts);
            if (typeof record.outcome === "string") found.outcome = record.outcome;
            if (typeof record.reason === "string") {
              found.failure = {
                source: typeof record.source === "string" ? record.source : "unknown",
                reason: record.reason,
              };
            }
          }
        }
        break;
      case "node_restarted":
        restarts += 1;
        break;
      case "run_paused":
        pauses += 1;
        break;
      case "feedback_reported":
        feedback += 1;
        break;
    }
  }

  // An attempt still going has run until the last thing the journal knows of.
  for (const report of nodes.values()) {
    for (const attempt of report.attempts) {
      if (attempt.outcome === undefined) {
        attempt.seconds = seconds(entered.get(`${report.node}#${attempt.attempt}`) ?? last, last);
      }
    }
    report.gate = gates.has(report.node);
    report.seconds = Math.round(report.attempts.reduce((sum, a) => sum + a.seconds, 0) * 10) / 10;
  }

  const all = [...nodes.values()];
  const sum = (items: NodeReport[]) =>
    Math.round(items.reduce((total, n) => total + n.seconds, 0) * 10) / 10;
  return {
    runId: state.runId,
    task: state.task,
    status: state.status,
    total_s: seconds(first, state.finishedAt ?? last),
    work_s: sum(all.filter((n) => !n.gate)),
    waiting_s: sum(all.filter((n) => n.gate)),
    nodes: all,
    restarts,
    pauses,
    feedback,
    extra_attempts: all.reduce((total, n) => total + Math.max(0, n.attempts.length - 1), 0),
  };
}
