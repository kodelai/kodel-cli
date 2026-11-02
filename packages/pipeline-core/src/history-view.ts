/**
 * What the history tools answer: the list of runs, one run on three levels (run, node, attempt) and the stored
 * agent log of one attempt. Pure: the host hands over the data it read (rows, a report, events), this turns it into
 * a bounded, redacted, paged answer. Nothing here reads a file, and nothing here is trusted by the engine: the
 * answers are information about past runs, and what comes from the agent's own log says `unverified`.
 */
import type { HistoryEvent } from "./agent-history";
import { KodelError } from "./errors";
import { type StatsRun, summarizePipeline } from "./pipeline-stats";
import { redactText } from "./redact";
import type { AttemptReport, NodeReport, RunReport } from "./report";
import type { ResultReport } from "./result";
import type { ToolCallsAttempt } from "./tool-calls";

// ── what a host hands over ───────────────────────────────────────────────────

/** One run of the list, as the host read it. A run that cannot be read has `unreadable` and a made-up `status`. */
export interface HistoryRunRow {
  run_id: string;
  pipeline: string;
  slug: string;
  task_key?: string;
  status: string;
  started_at: number;
  workdir?: string;
  active: { node: string; attempt: number; phase: string; branch?: string }[];
  pauses: { reason: string; node: string; branch?: string }[];
  failed_branches?: true;
  unreadable?: { code: string; format?: number };
}

export interface HistoryRunData {
  pipeline: string;
  report: RunReport;
  /** The run-state format the run lives in: a cursor is bound to it, so `kodel migrate` ends a walk. */
  format: number;
  /** Whether the state file is what kodel last wrote, and whether a finished run is as it was sealed. */
  integrity: "ok" | "modified" | "unknown";
  seal: "sealed" | "modified" | "unsealed" | "open";
  /** Whether the pipeline copy kept with the run is the one it is pinned to by its hash. */
  pipeline_copy: "ok" | "modified" | "missing";
}

export type HistoryAgentLogData =
  | { not_collected: true; reason: string }
  | {
      /** The run-state format of the run: the cursor is bound to it, as the details' cursor is. */
      format: number;
      /** The sessions of the attempt, in a fixed order, each with its events in order of `seq`. */
      sessions: {
        session: string;
        parent?: string;
        events: HistoryEvent[];
        /** The stored stream could not be read to its end; `events` are the ones read before that. */
        problem?: { kind: "format" | "damaged" | "missing"; detail: string };
      }[];
      /** `time`: placed by the time of each event against the attempts of the journal. */
      attribution: "time" | "approximate";
    };

/** The reads a host offers for the history tools. All optional: a host without them answers `HISTORY_UNAVAILABLE`. */
export interface HistoryHost {
  /** Every run of this project that is not another checkout's. */
  historyRuns?(): Promise<HistoryRunRow[]>;
  /**
   * One run; `undefined` for one that is not there or belongs to another checkout. `patch: false` leaves out the
   * size of the task, which needs the patch of the run read: the counts over many runs have no use for it.
   */
  historyRun?(runId: string, options?: { patch?: boolean }): Promise<HistoryRunData | undefined>;
  /** The report an attempt stored (findings of a step, the comments a person made at a gate), if it stored one. */
  historyAttemptReport?(
    runId: string,
    node: string,
    attempt: number,
  ): Promise<ResultReport | undefined>;
  /** The events of one attempt; `undefined` for a run that is not there. Refuses an unknown node or attempt. */
  historyAgentLog?(
    runId: string,
    node: string,
    attempt: number,
  ): Promise<HistoryAgentLogData | undefined>;
  /** The redaction of the host, project rules included. */
  historyRedact?(text: string): string;
}

// ── limits ───────────────────────────────────────────────────────────────────

/** An answer is built to at most this many bytes of the JSON the client is sent. */
export const HISTORY_MAX_BYTES = 64 * 1024;
export const HISTORY_TEXT_CHARS = 500;
const SHRUNK_TEXT_CHARS = 100;
const SHRUNK_ARRAY_ITEMS = 5;
const BLOCK_ENTRIES = 20;
const REPORT_ROWS = 50;
const INNER_ENTRIES = 50;
const TOOL_ENTRIES = 30;
/** The room kept for what is added after the items are fitted (the `page` block, a `next` cursor). */
const PAGE_ROOM = 512;

export const HISTORY_LIMITS = {
  runs: { default: 20, max: 100 },
  nodes: { default: 50, max: 200 },
  attempts: { default: 10, max: 200 },
  lines: { default: 50, max: 200 },
  events: { default: 50, max: 200 },
  stats: { default: 50, max: 200 },
} as const;

type Obj = Record<string, unknown>;

const invalid = (message: string, details?: Obj) =>
  new KodelError("INVALID_ARGUMENTS", message, undefined, details);
const badCursor = (
  message = "the cursor is not one this call can continue; start again without it",
) => new KodelError("INVALID_CURSOR", message);

// ── text, size, cursor ───────────────────────────────────────────────────────

/** Cut to `max` UTF-16 units without leaving half of a surrogate pair. */
export function cutText(text: string, max = HISTORY_TEXT_CHARS): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Redact every string, then cut it: a cut first could split a secret so its pattern no longer matches. */
function scrub<T>(value: T, redact: (text: string) => string, max = HISTORY_TEXT_CHARS): T {
  if (typeof value === "string") return cutText(redact(value), max) as T;
  if (Array.isArray(value)) return value.map((v) => scrub(v, redact, max)) as T;
  if (typeof value === "object" && value !== null) {
    // The keys too: they are built from stored data (tool names, severities, node:attempt), and a project rule
    // added after the data was written, or the cut, has not been applied to them.
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [cutText(redact(k), max), scrub(v, redact, max)]),
    ) as T;
  }
  return value;
}

const sizeOf = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value, null, 2)).length;

/** What the blocks that are not lists may take together, so the list that follows them has room. */
const HEAD_BYTES = 24 * 1024;

/** Cut the blocks of the head of an answer, the largest first, until it fits: every block has a bound, also a sum. */
function fitHead(head: Obj): Obj {
  if (sizeOf(head) <= HEAD_BYTES) return head;
  const out: Obj = { ...head };
  const bySize = Object.keys(out).sort((a, b) => sizeOf(out[b]) - sizeOf(out[a]));
  for (const name of bySize) {
    if (sizeOf(out) <= HEAD_BYTES) break;
    out[name] = shrink(out[name]);
  }
  for (const name of bySize) {
    if (sizeOf(out) <= HEAD_BYTES) break;
    out[name] = { truncated: true };
  }
  return out;
}

/**
 * The bytes an item adds to the answer: its own JSON, and the indentation of the depth it sits at (the client is sent
 * the answer pretty-printed), which on a long item is a line each. Deep enough for every list of the answers.
 */
const INDENT_PER_LINE = 8;
const itemSize = (value: unknown): number => {
  const text = JSON.stringify(value, null, 2);
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines += 1;
  return new TextEncoder().encode(text).length + lines * INDENT_PER_LINE;
};

/** What an item that alone is over the cap is cut down to, so that a page always makes progress. */
function shrink(value: unknown): unknown {
  if (typeof value === "string") return cutText(value, SHRUNK_TEXT_CHARS);
  if (Array.isArray(value)) return value.slice(0, SHRUNK_ARRAY_ITEMS).map(shrink);
  if (typeof value === "object" && value !== null) {
    return {
      ...Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v)])),
      truncated: true,
    };
  }
  return value;
}

function b64url(text: string): string {
  const bin = Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join("");
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromB64url(text: string): string {
  const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(bin, (c) => c.charCodeAt(0)),
  );
}

/**
 * A digest of an item's key (cyrb53, 53 bits): the cursor names the last item by it, so a slug or an id that holds
 * a secret never reaches the agent through `page.next`, where it would not be redacted.
 */
function digest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The cursor holds what it is bound to (`b`) and the digest of the key of the last item given (`k`), nothing else. */
function makeCursor(bind: string, key: string): string {
  return b64url(JSON.stringify({ b: bind, k: digest(key) }));
}

function readCursor(raw: string, bind: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromB64url(raw));
  } catch {
    throw badCursor();
  }
  const cursor = parsed as { b?: unknown; k?: unknown } | null;
  if (typeof cursor?.b !== "string" || typeof cursor.k !== "string" || cursor.b !== bind) {
    throw badCursor();
  }
  return cursor.k;
}

interface Pager {
  items: unknown[];
  next?: string;
  total: number;
}

/**
 * One page of an ordered list. The cursor names the last item given, so what is added to the list between two
 * calls cannot repeat or hide an item; a key that is no longer there ends the walk. A page always holds at least
 * one item: one that alone is over the cap is cut down (`truncated`), never answered with an empty page.
 */
function page<T>(
  all: readonly T[],
  keyOf: (item: T) => string,
  bind: string,
  cursor: string | undefined,
  limit: number,
  fixedBytes: number,
  wire: (item: T) => unknown,
): Pager {
  let start = 0;
  if (cursor !== undefined) {
    const key = readCursor(cursor, bind);
    const at = all.findIndex((item) => digest(keyOf(item)) === key);
    if (at < 0) throw badCursor();
    start = at + 1;
  }
  const budget = Math.max(1024, HISTORY_MAX_BYTES - fixedBytes - PAGE_ROOM);
  const items: unknown[] = [];
  let used = 0;
  for (const source of all.slice(start, start + limit)) {
    let wired = wire(source);
    let size = itemSize(wired);
    if (items.length === 0 && size > budget) {
      wired = shrink(wired);
      size = itemSize(wired);
    }
    if (items.length > 0 && used + size > budget) break;
    items.push(wired);
    used += size;
  }
  const last = all[start + items.length - 1];
  const more = items.length > 0 && start + items.length < all.length;
  return {
    items,
    total: all.length,
    ...(more && last !== undefined ? { next: makeCursor(bind, keyOf(last)) } : {}),
  };
}

const pageBlock = (list: string, pager: Pager): Obj => ({
  list,
  returned: pager.items.length,
  total: pager.total,
  ...(pager.next === undefined ? {} : { next: pager.next }),
});

/** Keep the blocks asked for and the ones that are always there; refuse a name that is not a block of this level. */
function choose(
  answer: Obj,
  fields: readonly string[] | undefined,
  allowed: readonly string[],
  always: readonly string[],
): Obj {
  if (fields === undefined) return answer;
  const unknown = fields.filter((f) => !allowed.includes(f) && !always.includes(f));
  if (unknown.length > 0) {
    throw invalid(`unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`, {
      allowed: [...allowed],
    });
  }
  return Object.fromEntries(
    Object.entries(answer).filter(([name]) => always.includes(name) || fields.includes(name)),
  );
}

const iso = (ms: number): string | undefined =>
  Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;

function limitOf(
  value: number | undefined,
  limits: { default: number; max: number },
  what: string,
): number {
  const limit = value ?? limits.default;
  if (!Number.isInteger(limit) || limit < 1 || limit > limits.max) {
    throw invalid(`limit for ${what} is 1..${limits.max}`);
  }
  return limit;
}

const needHost = <K extends keyof HistoryHost>(
  host: HistoryHost,
  method: K,
): NonNullable<HistoryHost[K]> => {
  const found = host[method];
  if (typeof found !== "function") {
    throw new KodelError("HISTORY_UNAVAILABLE", "this server does not keep a history it can read");
  }
  return found.bind(host) as NonNullable<HistoryHost[K]>;
};

/** The host's redaction, or the built-in rules when it gives none: nothing is sent to an agent unredacted. */
const redactOf = (host: HistoryHost): ((text: string) => string) =>
  host.historyRedact === undefined ? (t) => redactText(t) : (t) => host.historyRedact?.(t) ?? t;

/** The answer of a tool that fails keeps what it says redacted too: it repeats what the caller sent. */
export async function historyGuard(host: HistoryHost, work: () => Promise<Obj>): Promise<Obj> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof KodelError) {
      const redact = redactOf(host);
      throw new KodelError(
        error.code,
        scrub(error.message, redact),
        error.issues === undefined ? undefined : scrub(error.issues, redact),
        error.details === undefined ? undefined : scrub(error.details, redact),
      );
    }
    throw error;
  }
}

// ── history_runs ─────────────────────────────────────────────────────────────

export const RUN_FIELDS = [
  "slug",
  "task_key",
  "status",
  "started_at",
  "workdir",
  "active",
  "pauses",
  "failed_branches",
  "unreadable",
] as const;

const RUN_ALWAYS = ["run_id", "pipeline"] as const;

export interface RunsInput {
  limit?: number;
  cursor?: string;
  status?: string;
  pipeline?: string;
  fields?: string[];
}

/** The statuses a run can have, and what the list shows for one that cannot be read. */
const RUN_STATUSES = [
  "running",
  "paused",
  "completed",
  "failed",
  "canceled",
  "unreadable",
] as const;

/** A run whose start cannot be told sorts as the oldest. */
const startOf = (row: HistoryRunRow): number =>
  Number.isFinite(row.started_at) ? row.started_at : 0;

export async function runsAnswer(host: HistoryHost, input: RunsInput): Promise<Obj> {
  if (
    input.status !== undefined &&
    !(RUN_STATUSES as readonly string[]).includes(input.status) &&
    !/^format \d+$/.test(input.status)
  ) {
    throw invalid(`unknown status: ${input.status}`, {
      allowed: [...RUN_STATUSES, "format <number>"],
    });
  }
  const runs = await needHost(host, "historyRuns")();
  const redact = redactOf(host);
  const limit = limitOf(input.limit, HISTORY_LIMITS.runs, "runs");
  const bind = JSON.stringify(["runs", input.status ?? null, input.pipeline ?? null]);
  if (input.fields !== undefined) choose({}, input.fields, RUN_FIELDS, RUN_ALWAYS);
  const rows = runs
    .filter((r) => input.status === undefined || r.status === input.status)
    .filter((r) => input.pipeline === undefined || r.pipeline === input.pipeline)
    .sort((a, b) => startOf(b) - startOf(a) || (a.run_id < b.run_id ? 1 : -1));
  const pager = page(
    rows,
    (r) => r.run_id,
    bind,
    input.cursor,
    limit,
    0,
    (row) => {
      const wire: Obj = {
        run_id: row.run_id,
        pipeline: row.pipeline,
        slug: row.slug,
        ...(row.task_key === undefined ? {} : { task_key: row.task_key }),
        status: row.status,
        started_at: iso(row.started_at),
        ...(row.workdir === undefined ? {} : { workdir: row.workdir }),
        active: row.active,
        pauses: row.pauses,
        ...(row.failed_branches === true ? { failed_branches: true } : {}),
        ...(row.unreadable === undefined ? {} : { unreadable: row.unreadable }),
      };
      return scrub(choose(wire, input.fields, RUN_FIELDS, RUN_ALWAYS), redact);
    },
  );
  return {
    ok: true,
    level: "runs",
    runs: pager.items,
    page: pageBlock("runs", pager),
  };
}

// ── history_run_details ──────────────────────────────────────────────────────

export interface DetailsInput {
  run_id: string;
  node?: string;
  attempt?: number;
  limit?: number;
  cursor?: string;
  fields?: string[];
}

const RUN_LEVEL = [
  "run",
  "task_size",
  "nodes",
  "pipeline_changes",
  "agent_decisions",
  "usage",
  "tool_calls",
  "agent_log",
  "integrity",
] as const;
const NODE_LEVEL = ["node", "checks", "attempts"] as const;
const ATTEMPT_LEVEL = ["attempt", "report_rows", "tool_calls"] as const;

const bounded = <T>(items: readonly T[], max: number): { items: T[]; omitted?: number } => ({
  items: items.slice(0, max),
  ...(items.length > max ? { omitted: items.length - max } : {}),
});

const topTools = (byTool: Record<string, number>): Obj => {
  const entries = Object.entries(byTool).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return {
    by_tool: Object.fromEntries(entries.slice(0, TOOL_ENTRIES)),
    ...(entries.length > TOOL_ENTRIES ? { by_tool_omitted: entries.length - TOOL_ENTRIES } : {}),
  };
};

/** What was called in one attempt, as counters; the rows are for the attempt level. */
function callCounters(attempt: ToolCallsAttempt): Obj {
  return {
    calls: attempt.calls,
    failed: attempt.failed,
    open: attempt.open,
    ...topTools(attempt.by_tool),
    longest: attempt.longest,
  };
}

function attemptOf(report: RunReport, node: string, attempt: number): ToolCallsAttempt | undefined {
  const calls = report.tool_calls;
  if (calls === undefined || !("attempts" in calls)) return undefined;
  return calls.attempts.find((a) => a.node === node && a.attempt === attempt);
}

function checksOf(report: RunReport, node: string): Obj[] {
  return report.checks
    .filter((c) => c.node === node)
    .map((c) => ({
      check_id: c.check_id,
      kind: c.kind,
      runs: c.runs,
      fails: c.fails,
      wrong_check: c.wrong_check,
      params_changes: c.params_changes,
    }));
}

/** An attempt with its lists bounded; the full row of the report is the attempt level. */
function attemptWire(report: RunReport, node: string, a: AttemptReport, full: boolean): Obj {
  const checks = bounded(a.checks ?? [], INNER_ENTRIES);
  const reports = bounded(a.reports ?? [], INNER_ENTRIES);
  const counters = attemptOf(report, node, a.attempt);
  const severities = Object.entries(a.findings ?? {}).sort(([x], [y]) => (x < y ? -1 : 1));
  const findings =
    a.findings === undefined
      ? undefined
      : {
          findings: Object.fromEntries(severities.slice(0, INNER_ENTRIES)),
          ...(severities.length > INNER_ENTRIES
            ? { findings_omitted: severities.length - INNER_ENTRIES }
            : {}),
        };
  return {
    attempt: a.attempt,
    ...(a.outcome === undefined ? {} : { outcome: a.outcome }),
    seconds: a.seconds,
    ...(a.failure === undefined ? {} : { failure: a.failure }),
    ...(a.summary === undefined ? {} : { summary: a.summary }),
    ...(a.checks === undefined
      ? {}
      : { checks: checks.items, ...(checks.omitted ? { checks_omitted: checks.omitted } : {}) }),
    ...(findings === undefined ? {} : findings),
    ...(a.decision === undefined ? {} : { decision: a.decision }),
    ...(a.definition_changed === undefined ? {} : { definition_changed: a.definition_changed }),
    ...(a.usage === undefined ? {} : { usage: a.usage }),
    ...(full && a.command !== undefined ? { command: a.command } : {}),
    ...(full && a.reports !== undefined
      ? {
          reports: reports.items,
          ...(reports.omitted ? { reports_omitted: reports.omitted } : {}),
        }
      : {}),
    ...(!full && counters !== undefined ? { tool_calls: callCounters(counters) } : {}),
  };
}

/** The counters of the agent log of the run: the per-visit table and the long lists are left to `history_agent_log`. */
function agentLogBlock(log: RunReport["agent_log"]): unknown {
  if (!("sessions" in log)) return log;
  const { visits: _visits, failed, ended_in_step: ended, ...counters } = log;
  const failures = bounded(failed, BLOCK_ENTRIES);
  const steps = ended === undefined ? undefined : bounded(ended, BLOCK_ENTRIES);
  return {
    ...counters,
    failed: failures.items,
    ...(failures.omitted ? { failed_omitted: failures.omitted } : {}),
    ...(steps === undefined ? {} : { ended_in_step: steps.items }),
    ...(steps?.omitted ? { ended_in_step_omitted: steps.omitted } : {}),
  };
}

/** The size of the task, with the lists cut to the first ten; `not_collected` when the run kept no patch. */
function taskSizeBlock(report: RunReport): unknown {
  const size = report.task_size;
  if (size === undefined) return { not_collected: true };
  if ("not_collected" in size) return size;
  const top = bounded(size.top_dirs, 10);
  const kinds = bounded(size.languages, 10);
  return {
    files: size.files,
    added: size.added,
    removed: size.removed,
    binary_files: size.binary_files,
    top_dirs: top.items,
    ...(top.omitted ? { top_dirs_omitted: top.omitted } : {}),
    languages: kinds.items,
    ...(kinds.omitted ? { languages_omitted: kinds.omitted } : {}),
  };
}

/** What an attempt stored as its report, with the rows bounded; the block is left out for an attempt with none. */
async function reportRowsBlock(
  host: HistoryHost,
  runId: string,
  node: string,
  attempt: number,
): Promise<Obj | undefined> {
  const stored = await host.historyAttemptReport?.(runId, node, attempt);
  if (stored === undefined) return undefined;
  const rows = bounded(stored.rows, REPORT_ROWS);
  return {
    completeness: stored.completeness,
    ...(stored.incomplete_reason === undefined
      ? {}
      : { incomplete_reason: stored.incomplete_reason }),
    rows: rows.items,
    ...(rows.omitted ? { omitted: rows.omitted } : {}),
  };
}

function usageBlock(report: RunReport): unknown {
  const usage = report.usage;
  if ("estimate" in usage) {
    return {
      estimate: true,
      complete: usage.complete,
      lower_bound: true,
      total: usage.total,
      // what was used outside every step: a wait at a gate, a pause
      ...(usage.unattributed === undefined ? {} : { unattributed: usage.unattributed }),
    };
  }
  return usage;
}

function toolCallsBlock(report: RunReport): unknown {
  const calls = report.tool_calls;
  if (calls === undefined) return { not_collected: true, reason: "not_captured" };
  if (!("attempts" in calls)) return calls;
  const all =
    calls.unattributed === undefined ? calls.attempts : [...calls.attempts, calls.unattributed];
  return {
    unverified: true,
    calls: all.reduce((n, a) => n + a.calls, 0),
    failed: all.reduce((n, a) => n + a.failed, 0),
    rows_cut: calls.rows_cut,
    complete: calls.complete,
  };
}

export async function detailsAnswer(host: HistoryHost, input: DetailsInput): Promise<Obj> {
  if (input.attempt !== undefined && input.node === undefined) {
    throw invalid("attempt needs node: name the node whose attempt you want");
  }
  const data = await needHost(host, "historyRun")(input.run_id);
  if (data === undefined) {
    throw new KodelError("UNKNOWN_RUN", `there is no run "${input.run_id}"`);
  }
  const redact = redactOf(host);
  const { report } = data;
  const level = input.node === undefined ? "run" : input.attempt === undefined ? "node" : "attempt";
  const bind = JSON.stringify([
    "details",
    input.run_id,
    level,
    input.node ?? null,
    input.attempt ?? null,
    data.format,
  ]);

  if (level === "run") {
    const limit = limitOf(input.limit, HISTORY_LIMITS.nodes, "nodes");
    choose({}, input.fields, RUN_LEVEL, []);
    const first = input.cursor === undefined;
    const rows = report.nodes;
    const rest: Obj = first
      ? {
          run: {
            run_id: report.runId,
            pipeline: data.pipeline,
            slug: report.slug,
            task: report.task,
            status: report.status,
            total_s: report.total_s,
            work_s: report.work_s,
            waiting_s: report.waiting_s,
            restarts: report.restarts,
            pauses: report.pauses,
            feedback: report.feedback,
            refused: report.refused,
            extra_attempts: report.extra_attempts,
            failed_branches: report.failed_branches,
            format: data.format,
            ...(report.workdir === undefined ? {} : { workdir: report.workdir }),
            ...(report.tracker_task === undefined ? {} : { tracker_task: report.tracker_task }),
          },
          task_size: taskSizeBlock(report),
          pipeline_changes: (() => {
            const b = bounded(report.pipeline_changes, BLOCK_ENTRIES);
            return {
              entries: b.items.map((c) => ({
                at: iso(c.at),
                from: c.from,
                to: c.to,
                source: c.source,
                nodes: c.nodes,
                ...(c.by === undefined ? {} : { by: c.by }),
              })),
              ...(b.omitted ? { omitted: b.omitted } : {}),
            };
          })(),
          agent_decisions: (() => {
            const b = bounded(report.agent_decisions, BLOCK_ENTRIES);
            return {
              entries: b.items.map((d) => ({
                at: iso(d.at),
                what: d.what,
                ...(d.node === undefined ? {} : { node: d.node }),
                ...(d.decision === undefined ? {} : { decision: d.decision }),
              })),
              ...(b.omitted ? { omitted: b.omitted } : {}),
            };
          })(),
          usage: usageBlock(report),
          tool_calls: toolCallsBlock(report),
          agent_log: agentLogBlock(report.agent_log),
          integrity: { files: data.integrity, seal: data.seal, pipeline_copy: data.pipeline_copy },
        }
      : {};
    const kept = fitHead(scrub(choose(rest, input.fields, RUN_LEVEL, []), redact));
    const wantNodes = input.fields === undefined || input.fields.includes("nodes");
    const pager = wantNodes
      ? page(
          rows,
          (n) => n.node,
          bind,
          input.cursor,
          limit,
          sizeOf(kept),
          (n) => scrub(nodeRow(report, n), redact),
        )
      : undefined;
    return {
      ok: true,
      level,
      ...kept,
      ...(pager === undefined ? {} : { nodes: pager.items, page: pageBlock("nodes", pager) }),
    };
  }

  const node = report.nodes.find((n) => n.node === input.node);
  if (node === undefined) {
    throw new KodelError("UNKNOWN_NODE", `the run has no node "${input.node}"`, undefined, {
      nodes: report.nodes.map((n) => n.node),
    });
  }

  if (level === "node") {
    const limit = limitOf(input.limit, HISTORY_LIMITS.attempts, "attempts");
    choose({}, input.fields, NODE_LEVEL, []);
    const first = input.cursor === undefined;
    const checks = bounded(checksOf(report, node.node), INNER_ENTRIES);
    const head: Obj = first
      ? {
          node: {
            node: node.node,
            gate: node.gate,
            seconds: node.seconds,
            attempts: node.attempts.length,
          },
          checks: { entries: checks.items, ...(checks.omitted ? { omitted: checks.omitted } : {}) },
        }
      : {};
    const kept = fitHead(scrub(choose(head, input.fields, NODE_LEVEL, []), redact));
    const wantAttempts = input.fields === undefined || input.fields.includes("attempts");
    const pager = wantAttempts
      ? page(
          node.attempts,
          (a) => String(a.attempt),
          bind,
          input.cursor,
          limit,
          sizeOf(kept),
          (a) => scrub(attemptWire(report, node.node, a, false), redact),
        )
      : undefined;
    return {
      ok: true,
      level,
      ...kept,
      ...(pager === undefined ? {} : { attempts: pager.items, page: pageBlock("attempts", pager) }),
    };
  }

  const number = input.attempt ?? 0;
  const found = node.attempts.find((a) => a.attempt === number);
  if (found === undefined) {
    throw invalid(`node "${node.node}" has no attempt ${number}`, {
      attempts: node.attempts.length,
    });
  }
  const limit = limitOf(input.limit, HISTORY_LIMITS.lines, "tool calls");
  choose({}, input.fields, ATTEMPT_LEVEL, []);
  const first = input.cursor === undefined;
  const wantRows = input.fields === undefined || input.fields.includes("report_rows");
  const stored =
    first && wantRows ? await reportRowsBlock(host, input.run_id, node.node, number) : undefined;
  const head: Obj = first
    ? {
        attempt: attemptWire(report, node.node, found, true),
        ...(stored === undefined ? {} : { report_rows: stored }),
      }
    : {};
  const kept = fitHead(scrub(choose(head, input.fields, ATTEMPT_LEVEL, []), redact));
  const wantCalls = input.fields === undefined || input.fields.includes("tool_calls");
  if (!wantCalls) return { ok: true, level, ...kept };
  const calls = report.tool_calls;
  if (calls === undefined) {
    return {
      ok: true,
      level,
      ...kept,
      tool_calls: { not_collected: true, reason: "not_captured" },
    };
  }
  if (!("attempts" in calls)) return { ok: true, level, ...kept, tool_calls: calls };
  const counters = attemptOf(report, node.node, number);
  const lines = counters?.lines ?? [];
  const summary: Obj =
    first && counters !== undefined
      ? { ...callCounters(counters), shared: counters.shared, omitted: counters.omitted }
      : {};
  const pager = page(
    lines,
    (l) => l.id,
    bind,
    input.cursor,
    limit,
    sizeOf(kept) + sizeOf(summary),
    (line) => scrub(line, redact),
  );
  return {
    ok: true,
    level,
    ...kept,
    tool_calls: { unverified: true, ...fitHead(scrub(summary, redact)), lines: pager.items },
    page: pageBlock("tool_calls.lines", pager),
  };
}

/** What the agent used at a node, summed over its attempts that recorded it; none if no attempt did. */
function nodeUsage(n: NodeReport): Obj | undefined {
  const used = n.attempts.flatMap((a) => (a.usage === undefined ? [] : [a.usage]));
  if (used.length === 0) return undefined;
  const sum = (pick: (u: (typeof used)[number]) => number) => used.reduce((t, u) => t + pick(u), 0);
  const priced = used.filter((u) => u.usd !== null);
  return {
    attempts_with_usage: used.length,
    input: sum((u) => u.input),
    output: sum((u) => u.output),
    cache_read: sum((u) => u.cache_read),
    cache_write: sum((u) => u.cache_write),
    calls: sum((u) => u.calls),
    // over the attempts that have a price; null when none has
    usd:
      priced.length === 0
        ? null
        : Math.round(priced.reduce((t, u) => t + (u.usd ?? 0), 0) * 1e4) / 1e4,
  };
}

function nodeRow(report: RunReport, n: NodeReport): Obj {
  const checks = report.checks.filter((c) => c.node === n.node);
  const last = n.attempts[n.attempts.length - 1];
  const usage = nodeUsage(n);
  return {
    node: n.node,
    gate: n.gate,
    seconds: n.seconds,
    attempts: n.attempts.length,
    ...(last?.outcome === undefined ? {} : { last_outcome: last.outcome }),
    checks_run: checks.reduce((sum, c) => sum + c.runs, 0),
    checks_failed: checks.reduce((sum, c) => sum + c.fails, 0),
    ...(usage === undefined ? {} : { usage }),
  };
}

// ── history_agent_log ────────────────────────────────────────────────────────

export interface AgentLogInput {
  run_id: string;
  node: string;
  attempt: number;
  kind?: string[];
  tool?: string;
  include_messages?: boolean;
  limit?: number;
  cursor?: string;
  fields?: string[];
}

export const EVENT_KINDS = [
  "session",
  "message",
  "usage",
  "tool_call",
  "tool_result",
  "subagent",
  "system",
] as const;

/** The keys of an event that `fields` may ask for; `session_id`, `seq` and `kind` are always there. */
export const EVENT_FIELDS = [
  "ts",
  "agent",
  "agent_version",
  "parent_session_id",
  "cwd",
  "git_branch",
  "role",
  "text_preview",
  "message_id",
  "model",
  "input",
  "output",
  "cache_read",
  "cache_write",
  "cache_write_1h",
  "reasoning",
  "semantics",
  "request_id",
  "cost",
  "id",
  "name",
  "mcp_server",
  "input_preview",
  "started",
  "ok",
  "ended",
  "duration_ms",
  "size",
  "output_preview",
  "agent_id",
  "child_session_id",
  "description_preview",
  "subtype",
  "detail",
] as const;

const EVENT_ALWAYS = ["session_id", "seq", "kind"] as const;

export async function agentLogAnswer(host: HistoryHost, input: AgentLogInput): Promise<Obj> {
  const limit = limitOf(input.limit, HISTORY_LIMITS.events, "events");
  const kinds = input.kind;
  if (kinds !== undefined) {
    const unknown = kinds.filter((k) => !(EVENT_KINDS as readonly string[]).includes(k));
    if (unknown.length > 0) {
      throw invalid(`unknown kind: ${unknown.join(", ")}`, { allowed: [...EVENT_KINDS] });
    }
    if (kinds.includes("message") && input.include_messages !== true) {
      throw invalid(
        "kind message needs include_messages: true; conversation text is left out unless you ask for it",
      );
    }
  }
  if (input.fields !== undefined) choose({}, input.fields, EVENT_FIELDS, EVENT_ALWAYS);
  const data = await needHost(host, "historyAgentLog")(input.run_id, input.node, input.attempt);
  if (data === undefined) {
    throw new KodelError("UNKNOWN_RUN", `there is no run "${input.run_id}"`);
  }
  const redact = redactOf(host);
  if ("not_collected" in data) {
    return {
      ok: true,
      level: "agent_log",
      node: input.node,
      attempt: input.attempt,
      unverified: true,
      not_collected: true,
      reason: data.reason,
    };
  }
  const order = data.sessions.map((s) => s.session);
  const flat = data.sessions.flatMap((s) => s.events);
  const callIds =
    input.tool === undefined
      ? undefined
      : new Set(
          flat.flatMap((e) => (e.kind === "tool_call" && e.name === input.tool ? [e.id] : [])),
        );
  let skipped = 0;
  const events = flat.filter((e) => {
    if (e.kind === "message" && input.include_messages !== true) {
      skipped += 1;
      return false;
    }
    if (kinds !== undefined && !kinds.includes(e.kind)) return false;
    if (callIds !== undefined) {
      if (e.kind === "tool_call") return e.name === input.tool;
      if (e.kind === "tool_result") return callIds.has(e.id);
      return false;
    }
    return true;
  });
  const key = (e: HistoryEvent) => `${order.indexOf(e.session_id)}:${e.seq}`;
  const bind = JSON.stringify([
    "agent_log",
    input.run_id,
    input.node,
    input.attempt,
    kinds ?? null,
    input.tool ?? null,
    input.include_messages === true,
    data.format,
  ]);
  const problems = data.sessions.flatMap((s) =>
    s.problem === undefined ? [] : [{ session: s.session, ...s.problem }],
  );
  const head: Obj = {
    ok: true,
    level: "agent_log",
    node: input.node,
    attempt: input.attempt,
    unverified: true,
    attribution: data.attribution,
    ...(skipped > 0 ? { skipped: { message: skipped } } : {}),
    ...(problems.length > 0 ? { partial: true, problems: scrub(problems, redact) } : {}),
  };
  const pager = page(events, key, bind, input.cursor, limit, sizeOf(head), (e) => {
    const { v: _version, ...rest } = e as HistoryEvent & { v?: unknown };
    return scrub(choose(rest as Obj, input.fields, EVENT_FIELDS, EVENT_ALWAYS), redact);
  });
  return { ...head, events: pager.items, page: pageBlock("events", pager) };
}

// ── history_stats ────────────────────────────────────────────────────────────

export interface StatsInput {
  pipeline: string;
  limit?: number;
  fields?: string[];
}

/** The blocks of the statistics; `versions` is left out unless it is asked for by name. */
export const STATS_FIELDS = ["runs", "attempts", "seconds", "nodes", "versions"] as const;
const STATS_DEFAULT_BLOCKS = ["runs", "attempts", "seconds", "nodes"] as const;
/** What the statistics may take of the answer: more than the head of a run, since the nodes are the point. */
const STATS_BYTES = 56 * 1024;
const STATS_OUTCOMES = 20;
const STATS_FAILURES = 10;
const STATS_REASONS = 5;
const STATS_NODES = 100;
const STATS_VERSIONS = 30;

/**
 * How a pipeline fared over its newest runs, counted on the server so that an agent does not add up hundreds of
 * answers itself: per node the time, the rework and why, the findings, what people decided and what it cost. It
 * reads the report of each run, the same data as `history_run_details`, so the same things are `unverified`.
 */
export async function statsAnswer(host: HistoryHost, input: StatsInput): Promise<Obj> {
  const limit = limitOf(input.limit, HISTORY_LIMITS.stats, "runs");
  choose({}, input.fields, STATS_FIELDS, []);
  const blocks: readonly string[] = input.fields ?? STATS_DEFAULT_BLOCKS;
  const list = await needHost(host, "historyRuns")();
  const read = needHost(host, "historyRun");
  const redact = redactOf(host);
  const rows = list
    .filter((r) => r.pipeline === input.pipeline && r.unreadable === undefined)
    .sort((a, b) => startOf(b) - startOf(a) || (a.run_id < b.run_id ? 1 : -1))
    .slice(0, limit);
  const runs: StatsRun[] = [];
  let skipped = 0;
  for (const row of rows) {
    try {
      // the size of the task needs the patch of the run read, and a count over many runs has no use for it
      const data = await read(row.run_id, { patch: false });
      if (data === undefined) skipped += 1;
      else runs.push({ runId: row.run_id, at: startOf(row), report: data.report });
    } catch {
      skipped += 1;
    }
  }
  const stats = summarizePipeline(runs, { scope: "all" });
  const nodes = stats.nodes.slice(0, STATS_NODES).map((n) => {
    const outcomes = Object.entries(n.outcomes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, STATS_OUTCOMES);
    return {
      node: n.node,
      gate: n.gate,
      runs: n.runs,
      attempts: n.attempts,
      per_run: Math.round(n.perRun * 100) / 100,
      failed: n.failed,
      outcomes: Object.fromEntries(outcomes),
      failures: n.failures.slice(0, STATS_FAILURES),
      seconds: n.seconds,
      findings: n.findings,
      ...(n.decisions === undefined
        ? {}
        : {
            decisions: {
              approved: n.decisions.approved,
              rejected: n.decisions.rejected,
              rejected_with_reason: n.decisions.rejectedWithReason,
              reasons: n.decisions.reasons.slice(-STATS_REASONS),
            },
          }),
      usage: n.usage,
    };
  });
  const times = rows.map(startOf);
  const answer: Obj = {
    runs: {
      pipeline: input.pipeline,
      considered: rows.length,
      read: runs.length,
      skipped,
      total_of_pipeline: list.filter((r) => r.pipeline === input.pipeline).length,
      by_status: stats.runs.byStatus,
      ...(times.length === 0
        ? {}
        : { newest: iso(Math.max(...times)), oldest: iso(Math.min(...times)) }),
    },
    attempts: stats.attempts,
    seconds: stats.seconds,
    nodes,
    versions: stats.versions.slice(0, STATS_VERSIONS).map((v) => ({
      node: v.node,
      versions: v.versions.slice(-STATS_REASONS).map((x) => ({
        index: x.index,
        current: x.current,
        changed: x.changed,
        first_seen: iso(x.firstSeen),
        attempts: x.attempts,
        failed: x.failed,
        usd: x.usage.usd,
      })),
    })),
  };
  let kept = scrub(
    Object.fromEntries(Object.entries(answer).filter(([name]) => blocks.includes(name))),
    redact,
  );
  // the nodes are the point of the answer, so what does not fit is dropped from their end, with a count
  let left = Array.isArray(kept.nodes) ? kept.nodes.length : 0;
  while (left > 1 && sizeOf(kept) > STATS_BYTES) {
    left -= 1;
    kept = { ...kept, nodes: (kept.nodes as unknown[]).slice(0, left) };
  }
  const omitted = stats.nodes.length - left;
  return {
    ok: true,
    level: "stats",
    scope: "all",
    ...kept,
    ...(omitted > 0 && Array.isArray(kept.nodes) ? { nodes_omitted: omitted } : {}),
  };
}
