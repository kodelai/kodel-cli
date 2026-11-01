/**
 * What the agent called in a run, as the report shows it: which tool, when, how long, how it ended, per attempt of an
 * agent node. Pure: made from the state and the journal. The rows are what the host's pass read from the agent's own log,
 * which the agent can edit, so everything here is information only and the report says so (`unverified`): nothing here
 * feeds a check, a route or a gate.
 */
import type { JournalRecord, RunState } from "./run";
import {
  attemptKey,
  type CallRow,
  parseAttemptKey,
  type ResultRow,
  TOOL_CALLS_FAILURES,
  TOOL_CALLS_RECORD_FORMAT,
  UNATTRIBUTED_KEY,
} from "./tool-calls-record";

/**
 * The tools of the engine whose names start with `pipeline_` (the tool registry's, and the decision tools), by name: a
 * test in the MCP tests keeps this list equal to what the server registers. The `task_*` tools are not in it.
 */
export const PIPELINE_TOOL_NAMES: readonly string[] = [
  "pipeline_list",
  "pipeline_docs",
  "pipeline_resolve",
  "pipeline_plan",
  "pipeline_start",
  "pipeline_next_step",
  "pipeline_take_step",
  "pipeline_report_result",
  "pipeline_complete_step",
  "pipeline_feedback",
  "pipeline_propose_change",
  "pipeline_decide_gate",
  "pipeline_accept_change",
];

/**
 * The MCP server and the tool of a name as Claude Code writes it, `mcp__<server>__<tool>`, split at the first `__` after the
 * prefix: a server whose own name holds `__` is not told apart (a stated limit). Anything else is a tool of the agent.
 */
export function splitToolName(name: string): { server?: string; tool: string } {
  if (!name.startsWith("mcp__")) return { tool: name };
  const rest = name.slice("mcp__".length);
  const cut = rest.indexOf("__");
  if (cut <= 0 || cut + 2 >= rest.length) return { tool: name };
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
}

/** Whether the tool is one of the engine's own, by the name of the tool and whatever the server is called. */
export function isOwnTool(name: string): boolean {
  return PIPELINE_TOOL_NAMES.includes(splitToolName(name).tool);
}

// ── where a call belongs ────────────────────────────────────────────────────

export interface HandIn {
  ts: number;
  node: string;
  attempt: number;
}

interface Visit {
  node: string;
  attempt: number;
  from: number;
  /** `undefined` while the visit is still open. */
  to?: number;
}

/** What the journal says about where steps began and were handed in. */
export interface PlacementContext {
  /** `agent_completed`, in order of time. */
  handIns: readonly HandIn[];
  /** The agent steps: from their entry to their hand-in (or to the end of the run, or to now if open). */
  visits: readonly Visit[];
  /** The step the pass is handing in now: it counts as handed in at `now`. */
  current: { node: string; attempt: number };
  now: number;
  /** When the run's first call was made; what came before is not the run's. */
  runStart?: number;
  /** The time outside every agent step that a gate or a pause held the run (`outsideSpans`). */
  waits: readonly { from: number; to: number }[];
}

export type Placement =
  | { kind: "step"; node: string; attempt: number; shared: boolean }
  | { kind: "unattributed" };

/**
 * Where a call that started at `startedMs` belongs: to the step of the first hand-in at or after it (usage's rule, by
 * time), or to the step handed in now when no hand-in follows. It is `shared` when more than one agent step was open then:
 * a fork, where the log cannot tell the branches apart. A call in a wait for a person while no agent step was open, before
 * the run's first call, or in the future is the run's and no step's.
 */
export function placeCall(startedMs: number, context: PlacementContext): Placement {
  if (!Number.isFinite(startedMs) || startedMs > context.now) return { kind: "unattributed" };
  if (context.runStart !== undefined && startedMs < context.runStart) {
    return { kind: "unattributed" };
  }
  if (context.waits.some((w) => startedMs >= w.from && startedMs < w.to)) {
    return { kind: "unattributed" };
  }
  const next = context.handIns.find((h) => h.ts >= startedMs);
  const owner = next ?? { ...context.current, ts: context.now };
  const open = context.visits.filter(
    (v) => v.from <= startedMs && (v.to === undefined || startedMs < v.to),
  ).length;
  return { kind: "step", node: owner.node, attempt: owner.attempt, shared: open > 1 };
}

/**
 * The hand-ins and the agent steps of a run, from its journal. A visit is an agent step when the journal has its
 * hand-in, or it is open now as an agent step (the step handed in now and, in a fork, its siblings): the rule `outsideSpans`
 * of the usage count follows.
 */
export function placementFromJournal(
  journal: readonly JournalRecord[],
  current: { node: string; attempt: number },
  now: number,
  waits: readonly { from: number; to: number }[],
  runStart?: number,
  /** The agent steps open now (the run's active visits in phase agent): siblings in a fork have no hand-in yet. */
  openSteps: readonly { node: string; attempt: number }[] = [],
): PlacementContext {
  const key = (node: string, attempt: number) => `${node}\u0000${attempt}`;
  const agent = new Set<string>([
    key(current.node, current.attempt),
    ...openSteps.map((v) => key(v.node, v.attempt)),
  ]);
  const handIns: HandIn[] = [];
  for (const record of journal) {
    if (
      record.event === "agent_completed" &&
      typeof record.node === "string" &&
      typeof record.attempt === "number"
    ) {
      agent.add(key(record.node, record.attempt));
      handIns.push({ ts: record.ts, node: record.node, attempt: record.attempt });
    }
  }
  const open = new Map<string, Visit>();
  const visits: Visit[] = [];
  const close = (k: string, at: number) => {
    const visit = open.get(k);
    if (visit === undefined) return;
    visit.to = at;
    open.delete(k);
  };
  for (const record of journal) {
    const node = typeof record.node === "string" ? record.node : "";
    const k = typeof record.attempt === "number" ? key(node, record.attempt) : undefined;
    switch (record.event) {
      case "node_entered":
        if (k !== undefined && agent.has(k) && typeof record.attempt === "number") {
          const visit: Visit = { node, attempt: record.attempt, from: record.ts };
          open.set(k, visit);
          visits.push(visit);
        }
        break;
      case "agent_completed":
      case "node_finished":
      case "node_superseded":
        if (k !== undefined) close(k, record.ts);
        break;
      case "run_finished":
        for (const o of [...open.keys()]) close(o, record.ts);
        break;
      default:
        break;
    }
  }
  return {
    handIns: handIns.sort((a, b) => a.ts - b.ts),
    visits,
    current,
    now,
    waits,
    ...(runStart === undefined ? {} : { runStart }),
  };
}

// ── the report ──────────────────────────────────────────────────────────────

export type ToolCallsNotCollected =
  | "not_captured"
  | "disabled"
  | "session_unknown"
  | "log_missing"
  | "refused"
  | "unreadable"
  | "busy"
  | "agent_unsupported"
  | "no_calls";

/** One call as the report shows it: the call joined with its result, when there is one. */
export interface ToolCallLine {
  id: string;
  tool: string;
  server?: string;
  own?: true;
  started: string;
  /** `undefined` while no result row has come: the call is open. */
  ended?: string;
  ms?: number;
  ok?: boolean;
  err?: string;
  in_bytes?: number;
  out_bytes?: number;
  preview?: string;
  subagent?: string;
  shared?: true;
}

export interface ToolCallsAttempt {
  /** `undefined` for the calls no attempt owns. */
  node?: string;
  attempt?: number;
  /** Every call the passes read for this attempt, also those whose rows were cut. */
  calls: number;
  by_tool: Record<string, number>;
  /** Of the calls whose rows are kept: how many ended in an error, and how many have no result. */
  failed: number;
  open: number;
  shared: number;
  /** The longest calls whose rows are kept, longest first. */
  longest: { tool: string; ms: number }[];
  /** The rows kept, in order of start, at most `MAX_LINES_PER_ATTEMPT`; `omitted` counts the rest. */
  lines: ToolCallLine[];
  omitted: number;
}

export const MAX_LINES_PER_ATTEMPT = 200;

export type ToolCallsReport =
  | { not_collected: true; reason: ToolCallsNotCollected }
  | { cannot_read: true; format: string }
  | {
      /** The rows are what the agent's own log said; nothing of this feeds a check, a route or a gate. */
      unverified: true;
      attempts: ToolCallsAttempt[];
      unattributed?: ToolCallsAttempt;
      /** Rows were left out for want of room: durations and failures are then unknown for the rest. */
      rows_cut: boolean;
      /** Lines of the log the reader dropped (over 8 MB). */
      skipped: number;
      /** Results with no call in the journal (their call was cut or never read). */
      unjoined: number;
      /** The log was not read to its end at the last pass. */
      complete: boolean;
      failed: string[];
    };

const NOT_COLLECTED: readonly string[] = [
  "session_unknown",
  "log_missing",
  "refused",
  "unreadable",
  "busy",
  "agent_unsupported",
];

/** The first thing in the journal that this engine cannot read: a record of an unknown format or an unknown reason. */
function unreadable(journal: readonly JournalRecord[]): string | undefined {
  for (const record of journal) {
    if (record.event === "tool_calls_recorded") {
      const calls = record["calls"] as { v?: unknown } | undefined;
      if (calls?.v !== TOOL_CALLS_RECORD_FORMAT) return String(calls?.v ?? "unknown");
    } else if (record.event === "tool_calls_failed") {
      if (!(TOOL_CALLS_FAILURES as readonly string[]).includes(String(record["reason"]))) {
        return `reason ${String(record["reason"])}`;
      }
    }
  }
  return undefined;
}

const MS = (iso: string): number => Date.parse(iso);

export function toolCallsReport(
  state: RunState,
  journal: readonly JournalRecord[],
): ToolCallsReport {
  const bad = unreadable(journal);
  if (bad !== undefined) return { cannot_read: true, format: bad };
  // A state that lost the key (an older engine wrote it back) does not hide what the journal holds.
  const recorded = journal.some((r) => r.event === "tool_calls_recorded");
  if (state.toolCalls === undefined && !recorded) {
    return {
      not_collected: true,
      reason: state.history?.tool_calls?.enabled === false ? "disabled" : "not_captured",
    };
  }
  const tc = state.toolCalls ?? { sessions: {}, events: 0, rowBytes: 0, failed: [] };

  const calls = new Map<string, CallRow & { session: string }>();
  const results = new Map<string, ResultRow>();
  const counts = new Map<string, Record<string, number>>();
  let skipped = 0;
  let rowsCut = false;
  for (const record of journal) {
    if (record.event !== "tool_calls_recorded") continue;
    const session = String(record["session"]);
    const payload = record["calls"] as {
      rows?: (CallRow | ResultRow)[];
      counts?: Record<string, Record<string, number>>;
      skipped?: number;
      rows_cut?: true;
    };
    for (const row of payload.rows ?? []) {
      const id = `${session}\u0000${row.id}`;
      if (row.k === "c") {
        if (!calls.has(id)) calls.set(id, { ...row, session });
      } else if (!results.has(id)) results.set(id, row);
    }
    for (const [key, tools] of Object.entries(payload.counts ?? {})) {
      const into = counts.get(key) ?? {};
      for (const [tool, n] of Object.entries(tools)) into[tool] = (into[tool] ?? 0) + n;
      counts.set(key, into);
    }
    skipped += payload.skipped ?? 0;
    if (payload.rows_cut === true) rowsCut = true;
  }

  let unjoined = 0;
  for (const id of results.keys()) if (!calls.has(id)) unjoined += 1;

  const lines = new Map<string, ToolCallLine[]>();
  for (const [id, call] of calls) {
    const result = results.get(id);
    const owner =
      call.node !== undefined && call.attempt !== undefined
        ? attemptKey(call.node, call.attempt)
        : UNATTRIBUTED_KEY;
    const line: ToolCallLine = {
      id: call.id,
      tool: call.tool,
      ...(call.server === undefined ? {} : { server: call.server }),
      ...(call.own === undefined ? {} : { own: call.own }),
      started: call.started,
      ...(call.in_bytes === undefined ? {} : { in_bytes: call.in_bytes }),
      ...(call.preview === undefined ? {} : { preview: call.preview }),
      ...(call.subagent === undefined ? {} : { subagent: call.subagent }),
      ...(call.shared === undefined ? {} : { shared: call.shared }),
      ...(result === undefined
        ? {}
        : {
            ended: result.ended,
            ok: result.ok,
            ...(result.ms === undefined ? {} : { ms: result.ms }),
            ...(result.err === undefined ? {} : { err: result.err }),
            ...(result.out_bytes === undefined ? {} : { out_bytes: result.out_bytes }),
          }),
    };
    const list = lines.get(owner) ?? [];
    list.push(line);
    lines.set(owner, list);
  }

  const build = (key: string): ToolCallsAttempt => {
    const kept = (lines.get(key) ?? []).sort((a, b) => MS(a.started) - MS(b.started));
    const byTool = counts.get(key) ?? {};
    const total = Object.values(byTool).reduce((sum, n) => sum + n, 0);
    const where = parseAttemptKey(key);
    const timed = kept
      .filter((l): l is ToolCallLine & { ms: number } => l.ms !== undefined)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 3)
      .map((l) => ({ tool: l.tool, ms: l.ms }));
    return {
      ...(where === undefined ? {} : { node: where.node, attempt: where.attempt }),
      calls: Math.max(total, kept.length),
      by_tool: { ...byTool },
      failed: kept.filter((l) => l.ok === false).length,
      open: kept.filter((l) => l.ok === undefined).length,
      shared: kept.filter((l) => l.shared === true).length,
      longest: timed,
      lines: kept.slice(0, MAX_LINES_PER_ATTEMPT),
      omitted: Math.max(0, kept.length - MAX_LINES_PER_ATTEMPT),
    };
  };

  const keys = new Set<string>([...counts.keys(), ...lines.keys()]);
  const attempts = [...keys]
    .filter((k) => k !== UNATTRIBUTED_KEY)
    .map((k) => build(k))
    .sort(
      (a, b) => (a.node ?? "").localeCompare(b.node ?? "") || (a.attempt ?? 0) - (b.attempt ?? 0),
    );
  if (attempts.length === 0 && !keys.has(UNATTRIBUTED_KEY)) {
    const reason = tc.failed.find((r) => NOT_COLLECTED.includes(r));
    return { not_collected: true, reason: (reason ?? "no_calls") as ToolCallsNotCollected };
  }
  const behind = Object.values(tc.sessions).some((cursor) => cursor.behind === true);
  return {
    unverified: true,
    attempts,
    ...(keys.has(UNATTRIBUTED_KEY) ? { unattributed: build(UNATTRIBUTED_KEY) } : {}),
    rows_cut: rowsCut,
    skipped,
    unjoined,
    complete: !behind,
    failed: [...tc.failed],
  };
}
