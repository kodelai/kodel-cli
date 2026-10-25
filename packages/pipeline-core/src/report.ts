/**
 * A summary of one run, read from its journal and state: where the time went, how many attempts
 * each node took, what failed and why. Pure, so a host (a CLI, a server) only has to print it.
 */
import type { JournalRecord, RunState } from "./run";
import { runSlug } from "./slug";

export interface AttemptReport {
  attempt: number;
  /** The label the attempt ended with (`passed`, `failed`, `approved`, ...), if it ended. */
  outcome?: string;
  /** Seconds from entering the node to its outcome (to now, for one still going). */
  seconds: number;
  /** For an attempt that failed: where the failure came from and why. */
  failure?: { source: string; reason: string };
  /** What the agent said it had done when it completed the step. */
  summary?: string;
  /** The node's own command, when it has one. */
  command?: { passed: boolean; exit?: number; ms?: number };
  /** The checks that ran, in order. */
  checks?: { index: number; kind: string; passed: boolean; exit?: number; ms?: number }[];
  /** Reports of findings the agent sent that were accepted. */
  reports?: { completeness: string; rows: number }[];
  /** The hashes of the definition of the node this attempt ran on, when the journal has them. */
  definition?: { work: string; checks: string; routing: string };
  /** Which parts of the node's definition differ from the attempt before this one. */
  definition_changed?: ("work" | "checks" | "routing")[];
}

/** A version of the pipeline a person accepted for the run. */
export interface PipelineChangeReport {
  at: number;
  from: string;
  to: string;
  source: string;
  nodes: { slug: string; changes: string[] }[];
  effect: string;
  reason?: string;
  /** Set when the agent accepted the change on the person's instruction. */
  by?: "agent";
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
  /** The run's name (`{{run.slug}}`); not unique, told apart by `runId`. */
  slug: string;
  status: string;
  /** Seconds from the start to the end (to the last record, for a run still going). */
  total_s: number;
  /** Seconds the engine and the agent spent on nodes that are not gates. */
  work_s: number;
  /** Seconds spent waiting for a person at gates. */
  waiting_s: number;
  nodes: NodeReport[];
  /** Where the run works, when not in the repository root; added by a host that knows. */
  workdir?: string;
  /** The task the run was started for, and whether that task had been done before (a restart). */
  tracker_task?: { key: string; restarted: boolean };
  restarts: number;
  pauses: number;
  feedback: number;
  /** Calls of the agent the engine refused (journaled up to a limit). */
  refused: number;
  /** The refusals that were journaled, in order: what was tried, and why it was not allowed. */
  refusals: { about: string; node?: string; code: string; message: string }[];
  /** Attempts beyond the first, over all nodes: how much rework there was. */
  extra_attempts: number;
  /** The versions of the pipeline a person accepted while the run went, in order. */
  pipeline_changes: PipelineChangeReport[];
}

const seconds = (from: number, to: number) => Math.max(0, Math.round((to - from) / 100) / 10);

export function summarizeRun(state: RunState, journal: JournalRecord[]): RunReport {
  const nodes = new Map<string, NodeReport>();
  const entered = new Map<string, number>();
  const gates = new Set<string>();
  let restarts = 0;
  let pauses = 0;
  let feedback = 0;
  let taskRestarted = false;
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

  const refusals: RunReport["refusals"] = [];
  const pipelineChanges: PipelineChangeReport[] = [];
  const attemptOf = (name: string, attempt: number) =>
    nodes.get(name)?.attempts.find((a) => a.attempt === attempt);

  for (const record of journal) {
    const name = typeof record.node === "string" ? record.node : undefined;
    const attempt = typeof record.attempt === "number" ? record.attempt : undefined;
    switch (record.event) {
      case "node_entered":
        if (name && attempt !== undefined) {
          entered.set(`${name}#${attempt}`, record.ts);
          const definition = record.definition as AttemptReport["definition"] | undefined;
          nodeOf(name).attempts.push({
            attempt,
            seconds: 0,
            ...(definition ? { definition } : {}),
          });
        }
        break;
      case "node_superseded":
        // closed without a verdict because the pipeline changed under it
        if (name && attempt !== undefined) {
          const found = attemptOf(name, attempt);
          const from = entered.get(`${name}#${attempt}`) ?? record.ts;
          if (found) {
            found.seconds = seconds(from, record.ts);
            found.outcome = "superseded";
          }
        }
        break;
      case "pipeline_accepted":
        pipelineChanges.push({
          at: record.ts,
          from: String(record.from),
          to: String(record.to),
          source: String(record.source),
          nodes: (record.nodes as PipelineChangeReport["nodes"] | undefined) ?? [],
          effect: String((record.effect as { kind?: string } | undefined)?.kind ?? "none"),
          ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
          ...(record.decided_by === "agent" ? { by: "agent" as const } : {}),
        });
        break;
      case "gate_waiting":
        if (name) gates.add(name);
        break;
      case "task_link":
        if (record.what === "restarted" || record.restarting === true) taskRestarted = true;
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
      case "agent_completed": {
        const found = name && attempt !== undefined ? attemptOf(name, attempt) : undefined;
        if (found && typeof record.summary === "string") found.summary = record.summary;
        break;
      }
      case "command_finished": {
        const found = name && attempt !== undefined ? attemptOf(name, attempt) : undefined;
        if (found) {
          found.command = {
            passed: record.passed === true,
            ...(typeof record.exit === "number" ? { exit: record.exit } : {}),
            ...(typeof record.duration_ms === "number" ? { ms: record.duration_ms } : {}),
          };
        }
        break;
      }
      case "check_finished": {
        const found = name && attempt !== undefined ? attemptOf(name, attempt) : undefined;
        if (found && typeof record.index === "number") {
          found.checks = [
            ...(found.checks ?? []),
            {
              index: record.index,
              kind: typeof record.kind === "string" ? record.kind : "unknown",
              passed: record.passed === true,
              ...(typeof record.exit === "number" ? { exit: record.exit } : {}),
              ...(typeof record.duration_ms === "number" ? { ms: record.duration_ms } : {}),
            },
          ];
        }
        break;
      }
      case "report_accepted": {
        const found = name && attempt !== undefined ? attemptOf(name, attempt) : undefined;
        if (found) {
          found.reports = [
            ...(found.reports ?? []),
            {
              completeness: typeof record.completeness === "string" ? record.completeness : "?",
              rows: typeof record.rows === "number" ? record.rows : 0,
            },
          ];
        }
        break;
      }
      case "call_refused":
        refusals.push({
          about: typeof record.about === "string" ? record.about : "?",
          ...(name ? { node: name } : {}),
          code: typeof record.code === "string" ? record.code : "?",
          message: typeof record.message === "string" ? record.message : "",
        });
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
    // Which attempts ran on another definition than the one before them.
    for (const [i, attempt] of report.attempts.entries()) {
      const before = report.attempts[i - 1]?.definition;
      if (!before || !attempt.definition) continue;
      const parts = (["work", "checks", "routing"] as const).filter(
        (part) => before[part] !== attempt.definition?.[part],
      );
      if (parts.length > 0) attempt.definition_changed = parts;
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
    slug: state.slug ?? runSlug(undefined, state.task),
    ...(state.taskKey === undefined
      ? {}
      : { tracker_task: { key: state.taskKey, restarted: taskRestarted } }),
    status: state.status,
    total_s: seconds(first, state.finishedAt ?? last),
    work_s: sum(all.filter((n) => !n.gate)),
    waiting_s: sum(all.filter((n) => n.gate)),
    nodes: all,
    restarts,
    pauses,
    feedback,
    // the number counted by the engine can be higher than the list: only the first are journaled
    refused: Math.max(state.refusals ?? 0, refusals.length),
    refusals,
    extra_attempts: all.reduce((total, n) => total + Math.max(0, n.attempts.length - 1), 0),
    pipeline_changes: pipelineChanges,
  };
}
