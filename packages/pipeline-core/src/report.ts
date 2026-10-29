/**
 * A summary of one run, read from its journal and state: where the time went, how many attempts
 * each node took, what failed and why. Pure, so a host (a CLI, a server) only has to print it.
 */
import type { JournalRecord, RunState } from "./run";
import { runSlug } from "./slug";
import type { TaskSize } from "./task-size";

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
  /** What the run did about it, per step it stood at; empty when nothing was redone. */
  effects: { kind: string; node: string }[];
  reason?: string;
  /** Set when the agent accepted the change on the person's instruction. */
  by?: "agent";
}

/** A decision a person would make that the agent made on their instruction (the config allowed it). */
export interface AgentDecisionReport {
  at: number;
  what: "gate" | "pipeline_change";
  /** The gate's step, and what was decided there. */
  node?: string;
  decision?: string;
  /** The words the agent says it was given. */
  instruction: string;
}

/** How one check fared over the run, from the journal; a run before `check_id` has none. */
export interface CheckReport {
  check_id: string;
  kind: string;
  node?: string;
  runs: number;
  fails: number;
  /** Notes from the agent that this check fired for nothing (`wrong_check`), one per note. */
  wrong_check: number;
  /** Times the declared params of the check differed from its previous result. */
  params_changes: number;
  /** How the result right after such a change ended. */
  after_change: { passed: number; failed: number };
}

/** The size of the task, or why it is not known (no patch was kept for the run). */
export type TaskSizeReport = TaskSize | { not_collected: true };

/**
 * How many different answers the agent was shown and kept (`served/`), or that the run kept none: it is
 * older than the record, or it was started with `history.prompts` off.
 */
export type PromptsReport = { served: number } | { not_collected: true };

/**
 * The agent's conversation log of the run (`agent_log/`). `not_collected`: the run did not ask for it (it was started
 * before it existed, `not_captured`) or had it switched off (`disabled`). Otherwise the counts come from the journal,
 * never from the files, which are display data outside the seal (`unverified` says so). `failed` are the reasons a
 * copy was not made; with no `sessions` that is the whole story. `final_pass` is for a run that has ended: `true` when
 * it ended after a step of the agent (the copy of that step's end was asked for before the run ended), `false` when it
 * ended in the middle of one (cancelled, a check failed) and the copy ends at the last copy made while the run went;
 * it is absent while the run goes.
 */
export type AgentLogReport =
  | { not_collected: true; reason: "not_captured" | "disabled" }
  | {
      sessions: number;
      entries: number;
      bytes: number;
      /** The mode the run was started with; `unknown` if the run's start does not say. */
      mode: string;
      passes: { tick: number; step: number };
      /** Events left out for want of room. */
      cut: number;
      final_pass?: boolean;
      failed: string[];
      unverified: true;
      /** Bytes stored per visit of a step (`node:attempt`), as the engine counted them. */
      visits?: Record<string, number>;
      /** The steps of the agent that were still going when the run ended. */
      ended_in_step?: string[];
      /**
       * The run had a fork: steps of the agent were open at the same time and wrote to one log, so the
       * share of each visit (and which step the run ended in) cannot be told apart reliably.
       */
      visits_unverified_in_fork?: true;
    };

/** One attempt on the longest chain of a fork, with the seconds it took. */
export interface PathAttempt {
  node: string;
  attempt: number;
  seconds: number;
}

/**
 * The chain of attempts of one fork instance, from the fork to the join, with the longest sum of
 * attempt times: the branch that bounded how soon the join could start. A gate counts as its waiting
 * time; a rework attempt counts in its own branch; ties go to the branch first in trail order.
 */
export interface CriticalPath {
  fork: string;
  branch: string;
  seconds: number;
  attempts: PathAttempt[];
}

/** One time a fork fired, as the report sees it. */
export interface ForkReport {
  fork: string;
  from: string;
  label: string;
  join: string;
  branches: string[];
  /** The branches that have settled, failed ones included. */
  arrived: string[];
  /** The branches that settled by a failure label (or died). */
  failed: string[];
  /** The branches still going (an open fork), in branch order. */
  unfinished: string[];
  /** How many times the join was entered for this instance. */
  joined: number;
  /** Pairs of branches whose attempts ran at the same time, with the seconds they overlapped. */
  overlaps: { branches: [string, string]; seconds: number }[];
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
  /** Seconds the engine and the agent spent on nodes that are not gates, summed over the attempts. */
  work_s: number;
  /**
   * Seconds in which some node that is not a gate was active (wall clock): with a fork two branches
   * that ran together count once here and twice in `work_s`; without one the two are equal.
   */
  busy_wall_s: number;
  /** Seconds spent waiting for a person at gates (wall clock: two gates open at once count once). */
  waiting_s: number;
  nodes: NodeReport[];
  /** Every time a fork fired, in order; empty for a run without forks. */
  forks: ForkReport[];
  /** The longest chain of attempts of each fork instance, in order; empty for a run without forks. */
  critical_path: CriticalPath[];
  /**
   * A join was entered on branches that had failed and were not redone: the run (or its end) stands on
   * failed branches. A branch `restart_failed` ran again and that passed clears it.
   */
  failed_branches: boolean;
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
  /** Gates and pipeline changes the agent decided, in order; empty when a person decided them all. */
  agent_decisions: AgentDecisionReport[];
  /**
   * Per check, in the order each first ran. Checks removed from the pipeline keep their row. A
   * `check_id` is positional, so a check inserted or moved mid-run shares its row with the one it displaced.
   */
  checks: CheckReport[];
  /** Added by a host that can read the run's patch; absent when the report is made from the journal alone. */
  task_size?: TaskSizeReport;
  prompts: PromptsReport;
  agent_log: AgentLogReport;
}

const seconds = (from: number, to: number) => Math.max(0, Math.round((to - from) / 100) / 10);

/** The `effects` of a `pipeline_accepted` record, as written; a record is history and is not trusted to be well-formed. */
export function effectsOf(raw: unknown): { kind: string; node: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const effect = item as { kind?: unknown; node?: unknown } | null;
    return typeof effect?.kind === "string" && typeof effect.node === "string"
      ? [{ kind: effect.kind, node: effect.node }]
      : [];
  });
}

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

  const checks = new Map<string, CheckReport>();
  const lastHash = new Map<string, string>();
  const checkOf = (id: string, kind: string, node?: string): CheckReport => {
    let found = checks.get(id);
    if (!found) {
      found = {
        check_id: id,
        kind,
        ...(node === undefined ? {} : { node }),
        runs: 0,
        fails: 0,
        wrong_check: 0,
        params_changes: 0,
        after_change: { passed: 0, failed: 0 },
      };
      checks.set(id, found);
    }
    return found;
  };

  const refusals: RunReport["refusals"] = [];
  let served = 0;
  let lastAgentStep: string | undefined;
  const pipelineChanges: PipelineChangeReport[] = [];
  const agentDecisions: AgentDecisionReport[] = [];
  const attemptOf = (name: string, attempt: number) =>
    nodes.get(name)?.attempts.find((a) => a.attempt === attempt);
  /** Every attempt as an interval, with the branch it ran in; `to` is filled when it ends. */
  const spans: Span[] = [];
  const spanOf = (name: string, attempt: number) =>
    spans.find((s) => s.node === name && s.attempt === attempt);
  const forks = new Map<string, ForkReport>();
  let failedBranches = false;

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
          spans.push({
            node: name,
            attempt,
            from: record.ts,
            ...(typeof record.fork === "string" && typeof record.branch === "string"
              ? { fork: record.fork, branch: record.branch }
              : {}),
          });
        }
        break;
      case "fork_started":
        if (typeof record.fork === "string") {
          const branches = Array.isArray(record.branches)
            ? record.branches.filter((b): b is string => typeof b === "string")
            : [];
          forks.set(record.fork, {
            fork: record.fork,
            from: name ?? "?",
            label: typeof record.label === "string" ? record.label : "?",
            join: typeof record.join === "string" ? record.join : "?",
            branches,
            arrived: [],
            failed: [],
            unfinished: [...branches],
            joined: 0,
            overlaps: [],
          });
        }
        break;
      case "branch_settled": {
        const fork = typeof record.fork === "string" ? forks.get(record.fork) : undefined;
        if (fork && typeof record.branch === "string") {
          const branch = record.branch;
          if (!fork.arrived.includes(branch)) fork.arrived.push(branch);
          if (record.failed === true && !fork.failed.includes(branch)) fork.failed.push(branch);
          fork.unfinished = fork.unfinished.filter((b) => b !== branch);
        }
        break;
      }
      case "join_reached": {
        const fork = typeof record.fork === "string" ? forks.get(record.fork) : undefined;
        if (fork) fork.joined += 1;
        if (Array.isArray(record.failed) && record.failed.length > 0) failedBranches = true;
        break;
      }
      case "node_superseded":
        // closed without a verdict because the pipeline changed under it
        if (name && attempt !== undefined) {
          const found = attemptOf(name, attempt);
          const from = entered.get(`${name}#${attempt}`) ?? record.ts;
          if (found) {
            found.seconds = seconds(from, record.ts);
            found.outcome = "superseded";
          }
          const span = spanOf(name, attempt);
          if (span) span.to = record.ts;
        }
        break;
      case "pipeline_accepted":
        pipelineChanges.push({
          at: record.ts,
          from: String(record.from),
          to: String(record.to),
          source: String(record.source),
          nodes: (record.nodes as PipelineChangeReport["nodes"] | undefined) ?? [],
          effects: effectsOf(record.effects),
          ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
          ...(record.decided_by === "agent" ? { by: "agent" as const } : {}),
        });
        if (record.decided_by === "agent") {
          agentDecisions.push({
            at: record.ts,
            what: "pipeline_change",
            instruction: String(record.instruction ?? ""),
          });
        }
        break;
      case "gate_waiting":
        if (name) gates.add(name);
        break;
      case "gate_decided":
        if (record.decided_by === "agent") {
          agentDecisions.push({
            at: record.ts,
            what: "gate",
            ...(name ? { node: name } : {}),
            decision: String(record.decision),
            instruction: String(record.instruction ?? ""),
          });
        }
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
          const span = spanOf(name, attempt);
          if (span) span.to = record.ts;
        }
        break;
      case "agent_completed": {
        if (name !== undefined && attempt !== undefined) lastAgentStep = `${name}:${attempt}`;
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
        if (typeof record.check_id === "string") {
          const row = checkOf(
            record.check_id,
            typeof record.kind === "string" ? record.kind : "unknown",
            name,
          );
          if (row.kind === "unknown" && typeof record.kind === "string") row.kind = record.kind;
          row.runs += 1;
          if (record.passed !== true) row.fails += 1;
          if (typeof record.params_hash === "string") {
            const before = lastHash.get(record.check_id);
            if (before !== undefined && before !== record.params_hash) {
              row.params_changes += 1;
              row.after_change[record.passed === true ? "passed" : "failed"] += 1;
            }
            lastHash.set(record.check_id, record.params_hash);
          }
        }
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
      case "step_served":
        served += 1;
        break;
      case "node_restarted":
        restarts += 1;
        break;
      case "run_paused":
        pauses += 1;
        break;
      case "feedback_reported":
        feedback += 1;
        if (record.category === "wrong_check" && typeof record.check === "string") {
          // only a check that ran has a row: a mistyped id is not a check
          const row = checks.get(record.check);
          if (row) row.wrong_check += 1;
        }
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
  // An attempt still going runs until the last thing the journal knows of, as above.
  const withEnd = (span: Span): EndedSpan => ({ ...span, to: span.to ?? last });
  const interval = (span: Span): Interval => ({ from: span.from, to: span.to ?? last });
  // Summed in milliseconds and rounded once, like the union below: rounding each attempt first
  // could leave the sum below the union of the very same spans.
  const sumSeconds = (intervals: Interval[]) =>
    Math.max(0, Math.round(intervals.reduce((total, i) => total + (i.to - i.from), 0) / 100) / 10);
  const working = spans.filter((s) => !gates.has(s.node)).map(interval);
  const forkList = [...forks.values()];
  for (const fork of forkList) {
    // The state knows which branches are still going (a `restart_failed` sends settled ones back),
    // and which arrivals a join stands on now; the journal is the fallback for a state without them.
    const kept = state.forks?.[fork.fork];
    if (kept) {
      fork.arrived = fork.branches.filter((b) => kept.arrived[b] !== undefined);
      fork.failed = fork.branches.filter((b) => kept.arrived[b]?.failure !== undefined);
      fork.unfinished = fork.branches.filter((b) => kept.arrived[b] === undefined);
      fork.joined = kept.joined;
    }
    fork.overlaps = branchOverlaps(fork, spans.filter((s) => s.fork === fork.fork).map(withEnd));
  }
  if (state.forks !== undefined) {
    failedBranches = forkList.some((fork) => fork.joined > 0 && fork.failed.length > 0);
  }
  return {
    runId: state.runId,
    task: state.task,
    slug: state.slug ?? runSlug(undefined, state.task),
    ...(state.taskKey === undefined
      ? {}
      : { tracker_task: { key: state.taskKey, restarted: taskRestarted } }),
    status: state.status,
    total_s: seconds(first, state.finishedAt ?? last),
    work_s: sumSeconds(working),
    busy_wall_s: unionSeconds(working),
    waiting_s: unionSeconds(spans.filter((s) => gates.has(s.node)).map(interval)),
    nodes: all,
    forks: forkList,
    critical_path: forkList.map((fork) =>
      criticalPath(fork, spans.filter((s) => s.fork === fork.fork).map(withEnd)),
    ),
    failed_branches: failedBranches,
    restarts,
    pauses,
    feedback,
    // the number counted by the engine can be higher than the list: only the first are journaled
    refused: Math.max(state.refusals ?? 0, refusals.length),
    refusals,
    extra_attempts: all.reduce((total, n) => total + Math.max(0, n.attempts.length - 1), 0),
    pipeline_changes: pipelineChanges,
    agent_decisions: agentDecisions,
    checks: [...checks.values()],
    // The state key is there from the start of a run that keeps prompts, so a run of zero serves says so.
    prompts: state.served === undefined ? { not_collected: true } : { served },
    agent_log: agentLogReport(state, lastAgentStep),
  };
}

function agentLogReport(state: RunState, lastAgentStep: string | undefined): AgentLogReport {
  const log = state.agentLog;
  if (log === undefined) {
    return {
      not_collected: true,
      reason: state.history?.agent_log?.enabled === false ? "disabled" : "not_captured",
    };
  }
  const sessions = Object.values(log.sessions);
  const ended = state.status !== "running" && state.status !== "paused";
  return {
    sessions: sessions.length,
    entries: sessions.reduce((total, s) => total + s.entries, 0),
    bytes: log.bytes,
    mode: state.history?.agent_log?.mode ?? "unknown",
    passes: { tick: log.ticks, step: log.steps },
    cut: log.cut,
    // Whether the run ended in the middle of a step of the agent (cancelled, a check failed...) and not after one:
    // in the middle, the copy ends at the last copy made while the run went, at most one interval and the response
    // that was open behind what the agent had written.
    ...(ended
      ? { final_pass: (log.endedInStep ?? []).length === 0 && lastAgentStep !== undefined }
      : {}),
    failed: [...log.failed],
    unverified: true,
    ...(log.visits === undefined ? {} : { visits: { ...log.visits } }),
    ...(log.endedInStep === undefined ? {} : { ended_in_step: [...log.endedInStep] }),
    // Steps open at the same time share the log: the per-visit account cannot tell them apart, and
    // the run may have ended in several of them.
    ...(Object.keys(state.forks ?? {}).length > 0
      ? { visits_unverified_in_fork: true as const }
      : {}),
  };
}

/** One attempt as a time interval, with the branch it ran in when it was inside a fork. */
interface Span {
  node: string;
  attempt: number;
  from: number;
  to?: number;
  fork?: string;
  branch?: string;
}

type EndedSpan = Span & { to: number };

interface Interval {
  from: number;
  to: number;
}

/** The seconds covered by the union of the intervals: time two of them share counts once. */
function unionSeconds(intervals: Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  let total = 0;
  let open: Interval | undefined;
  for (const next of sorted) {
    if (open === undefined || next.from > open.to) {
      if (open) total += open.to - open.from;
      open = { from: next.from, to: Math.max(next.from, next.to) };
    } else {
      open.to = Math.max(open.to, next.to);
    }
  }
  if (open) total += open.to - open.from;
  return Math.max(0, Math.round(total / 100) / 10);
}

/** The milliseconds two lists of intervals share. Attempts of one branch never overlap each other. */
function sharedMs(a: Interval[], b: Interval[]): number {
  let total = 0;
  for (const x of a) {
    for (const y of b) total += Math.max(0, Math.min(x.to, y.to) - Math.max(x.from, y.from));
  }
  return Math.max(0, total);
}

/** The pairs of branches that ran at the same time at all; a short overlap reads as 0 seconds. */
function branchOverlaps(fork: ForkReport, spans: EndedSpan[]): ForkReport["overlaps"] {
  const out: ForkReport["overlaps"] = [];
  const of = (branch: string) => spans.filter((s) => s.branch === branch);
  for (const [i, a] of fork.branches.entries()) {
    for (const b of fork.branches.slice(i + 1)) {
      const shared = sharedMs(of(a), of(b));
      if (shared > 0) out.push({ branches: [a, b], seconds: Math.round(shared / 100) / 10 });
    }
  }
  return out;
}

/**
 * The branch whose attempts sum to the most time, its attempts in the order they were entered. The
 * branches are tried in the order of the fork's edges (trail order), and a later one has to be
 * strictly longer to replace an earlier one.
 */
function criticalPath(fork: ForkReport, spans: EndedSpan[]): CriticalPath {
  let best: CriticalPath = {
    fork: fork.fork,
    branch: fork.branches[0] ?? "?",
    seconds: 0,
    attempts: [],
  };
  let first = true;
  for (const branch of fork.branches) {
    const attempts = spans
      .filter((s) => s.branch === branch)
      .map((s) => ({
        node: s.node,
        attempt: s.attempt,
        seconds: Math.max(0, Math.round((s.to - s.from) / 100) / 10),
      }));
    const total = Math.round(attempts.reduce((sum, a) => sum + a.seconds, 0) * 10) / 10;
    if (first || total > best.seconds) {
      best = { fork: fork.fork, branch, seconds: total, attempts };
      first = false;
    }
  }
  return best;
}
