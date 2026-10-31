/**
 * What the agent used in a run, counted from its own log at the end of each agent step and recorded as deltas
 * (`usage_recorded`) in the run's journal. Tokens per model and an estimated cost; information only, it never feeds a
 * check, a route or a gate. See `docs/history.md` ("Usage and cost") for what is counted and what is not.
 *
 * The rules a pass keeps:
 *  - It has a switch of its own (`history.usage`), so it works with the copy of the agent's log switched off. It shares
 *    with that copy the lock of the step end (the host runs it as `CaptureInput.also`) and the way a session is found.
 *  - What a pass reads is credited to the attempt the pass completes, so every event is counted once and in exactly one
 *    place; events stamped inside a gate wait or a pause go to `unattributed`.
 *  - The cursor (`seq` of the last event credited, which is the same for the same log) is in the run's state: after a
 *    restart the log is read again from the run's start and what was credited is skipped. A pass that runs out of time
 *    credits only what it read.
 *  - Only closed responses are credited from the log. The response still being written (the one that calls
 *    `pipeline_complete_step`) is counted as it stands from a copy of the reader's state, marked `last_open`, and the
 *    next pass adds only the rest when the response is whole.
 *  - A pass never fails the step: whatever goes wrong is a reason, journaled once.
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  type AgentHistoryCollector,
  buildDelta,
  type CaptureOptions,
  cleanExecutorText,
  correctionDelta,
  dedupeUsage,
  defaultPricing,
  type FlushedResponse,
  foldModelId,
  type HistoryEvent,
  isEmptyDelta,
  type JournalRecord,
  KodelError,
  MAX_USAGE_EVENTS,
  mergeDeltas,
  type PricingContext,
  type ReadCheckpoint,
  type RedactRule,
  type RunState,
  type SessionRef,
  splitBySpans,
  type TimeSpan,
  USAGE_FAILURES,
  type UsageCursor,
  type UsageDelta,
  type UsageEvent,
  type UsageFailure,
  usageDedupeKey,
} from "@kodel-ai/pipeline-core";
import type { AgentLogRun } from "./agent-log";
import { SESSION_ENV } from "./executor";
import { claudeCodeCollector } from "./history/claude-code/collector";
import { claudeConfigDir, firstTimestamp, subagentLogs } from "./history/claude-code/locate";
import { AGENT_ID } from "./history/claude-code/normalize";
import { hasStepCall } from "./history/claude-code/window";
import {
  proveRunStart,
  type RunStartMemo,
  SAFE_SESSION,
  SessionFinder,
  sourceTailHash,
} from "./session-finder";

/** A pass stops reading after this long and keeps what it has: a big log catches up over several passes. */
export const USAGE_BUDGET_MS = 10_000;
/**
 * How long the pass at a step end waits for the agent's log to hold the call that hands the step in. The pass runs
 * inside that very call, and the agent writes its log a little behind its work: without the wait the response that
 * makes the call can be missed, and then it is counted in the next step (or, after the last step, not at all). The
 * wait is part of the pass's own time, comes only once per pass whatever the number of sessions, and ends as soon as
 * the call is in the log; if it never is, the pass goes on with what the log has.
 */
export const STEP_END_LOG_WAIT_MS = 2_000;
const STEP_END_LOG_POLL_MS = 100;
/**
 * What is kept in memory, bounded per run so that one busy run cannot make another (or its own main session) forget:
 * a run keeps the memos of its candidate sessions (the one of the environment and the newest of the hook index, 21 at
 * most, with headroom) and of its subagent logs, and only a few runs are kept at all. Inside each bound, and among the
 * runs, what was used least recently goes first (an entry is moved to the end every time it is used, not only when it
 * is made). A run that is pushed out is not lost: its credited work is in the run's state, and its next pass reads on
 * from there, from the start of the run's log.
 */
const MAIN_MEMO_CAP = 32;
const CHILD_MEMO_CAP = 48;
const RUN_CAP = 8;

/** What is kept for one run: its candidate sessions and the subagent logs of them, each by session id. */
interface RunMemos {
  mains: Map<string, StreamMemo>;
  children: Map<string, StreamMemo>;
}

/** The entry of `map` at `key`, moved to the end as the newest use; `undefined` if it is not there. */
function touched<V>(map: Map<string, V>, key: string): V | undefined {
  const found = map.get(key);
  if (found !== undefined) {
    map.delete(key);
    map.set(key, found);
  }
  return found;
}

/** Keep `map` to `cap` entries, the least recently used going first. */
function trimmed<V>(map: Map<string, V>, cap: number): void {
  while (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The identity of one response of the agent, for telling a response that was open from the same one whole. */
export const responseKey = (event: Pick<UsageEvent, "message_id" | "request_id">): string =>
  sha256(`${event.message_id}\u0000${event.request_id ?? ""}`);

/** What tells an event of the log from a changed one at the same `seq`. */
export function usageEventKey(event: HistoryEvent): string {
  let id = "";
  if (event.kind === "message" || event.kind === "usage") id = event.message_id ?? "";
  else if (event.kind === "tool_call" || event.kind === "tool_result") id = event.id;
  else if (event.kind === "subagent") id = event.agent_id;
  return sha256([event.seq, event.ts, event.kind, id].join("|"));
}

const isoOf = (ms: number): string => new Date(ms).toISOString();

interface Interval {
  from: number;
  to: number;
}

/** `span` less every part of it that one of `cuts` covers. */
function subtract(span: Interval, cuts: readonly Interval[]): Interval[] {
  let pieces = [span];
  for (const cut of cuts) {
    pieces = pieces.flatMap((piece) => {
      if (cut.to <= piece.from || cut.from >= piece.to) return [piece];
      const left = cut.from > piece.from ? [{ from: piece.from, to: cut.from }] : [];
      const right = cut.to < piece.to ? [{ from: cut.to, to: piece.to }] : [];
      return [...left, ...right];
    });
  }
  return pieces;
}

/**
 * The times the run waited for a person and no agent step was being worked: from a gate being reached to the
 * decision, and from a pause to the resume, each kept per node and branch (in a fork every branch has its own), less
 * the times an agent step was open. What the agent and the person say to each other then is not a node's work;
 * while an agent step is open, the session's use is that step's. A span still open lasts to `nowMs`.
 *
 * An agent step is open from its `node_entered` to its hand-in (`agent_completed`) or its end; a visit counts as
 * one when the journal holds its hand-in or when it is among `openAgentSteps` (the visits in the agent phase now).
 * `openPauses`, when given, are the pauses the state holds now: a pause window still open in the journal that is not
 * among them was lifted without a `run_resumed` and is dropped.
 */
export function outsideSpans(
  journal: readonly JournalRecord[],
  nowMs: number,
  openAgentSteps: Iterable<{ node: string; attempt: number }> = [],
  openPauses?: Iterable<{ node: string; fork?: { branch: string } }>,
): TimeSpan[] {
  const visitKey = (node: string, attempt: number) => `${node}\u0000${attempt}`;
  const pauseKey = (node: string, branch: string | undefined) => `${node}\u0000${branch ?? ""}`;
  const agentVisits = new Set<string>();
  for (const step of openAgentSteps) agentVisits.add(visitKey(step.node, step.attempt));
  for (const record of journal) {
    if (
      record.event === "agent_completed" &&
      typeof record.node === "string" &&
      typeof record.attempt === "number"
    ) {
      agentVisits.add(visitKey(record.node, record.attempt));
    }
  }

  const waits: Interval[] = [];
  const working: Interval[] = [];
  const gates = new Map<string, number>();
  const pauses = new Map<string, { node: string; branch?: string; from: number }>();
  const open = new Map<string, number>();
  const closeVisit = (key: string, ts: number) => {
    const from = open.get(key);
    if (from === undefined) return;
    working.push({ from, to: ts });
    open.delete(key);
  };
  for (const record of journal) {
    const node = typeof record.node === "string" ? record.node : "";
    const branch = typeof record.branch === "string" ? record.branch : undefined;
    const key = typeof record.attempt === "number" ? visitKey(node, record.attempt) : undefined;
    switch (record.event) {
      // A gate or a pause reached again (a superseded visit entered anew, a new pause after a change) starts its
      // window over, as it did before forks.
      case "gate_waiting":
        gates.set(node, record.ts);
        break;
      case "gate_decided": {
        const from = gates.get(node);
        if (from !== undefined) waits.push({ from, to: record.ts });
        gates.delete(node);
        break;
      }
      // A fork's branches pause each at their own node; one resume lifts only its own.
      case "run_paused":
        pauses.set(pauseKey(node, branch), {
          node,
          ...(branch === undefined ? {} : { branch }),
          from: record.ts,
        });
        break;
      case "run_resumed": {
        const k = pauseKey(node, branch);
        const pause = pauses.get(k);
        if (pause !== undefined) waits.push({ from: pause.from, to: record.ts });
        pauses.delete(k);
        break;
      }
      // An accepted change lifts the pauses its effects take care of, with no `run_resumed`. Their window is
      // dropped, not closed: the change is the agent's repair of the step, and its time goes to the step handed in
      // next, as it did before forks (where the next pause replaced the window). The effects name the node a pause
      // was held on (`node`, `to`); a pause whose node they do not name (a `total` pause lifted by a recheck of the
      // node it came from) is caught by `openPauses`.
      case "pipeline_accepted":
        for (const item of Array.isArray(record.effects) ? record.effects : []) {
          if (typeof item !== "object" || item === null) continue;
          const effect = item as Record<string, unknown>;
          const named = [effect.node, effect.to].filter((n): n is string => typeof n === "string");
          const only = typeof effect.branch === "string" ? effect.branch : undefined;
          for (const [k, pause] of [...pauses]) {
            if (named.includes(pause.node) && (only === undefined || pause.branch === only))
              pauses.delete(k);
          }
        }
        break;
      case "node_entered":
        if (key !== undefined && agentVisits.has(key)) open.set(key, record.ts);
        break;
      case "agent_completed":
      case "node_finished":
      case "node_superseded":
        if (key !== undefined) closeVisit(key, record.ts);
        break;
      case "run_finished":
        for (const k of [...open.keys()]) closeVisit(k, record.ts);
        break;
    }
  }
  const held =
    openPauses === undefined
      ? undefined
      : new Set([...openPauses].map((p) => pauseKey(p.node, p.fork?.branch)));
  for (const from of gates.values()) waits.push({ from, to: nowMs });
  for (const [k, pause] of pauses) {
    if (held === undefined || held.has(k)) waits.push({ from: pause.from, to: nowMs });
  }
  for (const from of open.values()) working.push({ from, to: nowMs });
  return waits
    .flatMap((wait) => subtract(wait, working))
    .map((span) => ({ from: isoOf(span.from), to: isoOf(span.to) }));
}

export interface UsageWriterOptions {
  /** The project root: where the hook index is, and a place a session of the agent may have started. */
  root: string;
  rules: readonly RedactRule[];
  env: () => NodeJS.ProcessEnv;
  now?: () => number;
  /** How the wait for the step's call in the log sleeps; tests move a fake clock with it. */
  sleep?: (ms: number) => Promise<void>;
  /** How long that wait may last: `STEP_END_LOG_WAIT_MS` unless given; `0` is no wait at all. */
  stepWaitMs?: number;
  /** The collector to read with; the Claude Code one, looking in the config dir of the environment, when not given. */
  collector?: (configDir: string) => AgentHistoryCollector;
  /** How long one pass may read before it keeps what it has. */
  budgetMs?: number;
}

export interface UsageResult {
  /** The pass did not run, and why. */
  skipped?: "disabled" | "not_running" | "no_step";
  /** Events journaled, and the sessions that got some. */
  recorded: number;
  sessions: string[];
  /** The reasons usage could not be recorded in this pass. */
  failures: UsageFailure[];
}

/** What is kept in memory between passes for one stream (a session, or a subagent of it). */
interface StreamMemo extends RunStartMemo {
  checkpoint?: ReadCheckpoint;
  /** The hash of the 64 bytes of the log before `checkpoint.offset`: what the checkpoint was made against. */
  sourceTail?: string;
  /** The `last_seq` the state had for this stream when this process last wrote it. */
  creditedSeq: number;
  stopped?: UsageFailure;
  /**
   * The size of the log when it was last found to be one this reader does not understand (responses and no usage):
   * the log is not read again until it grows, so a log in that state is not read in full at every step end.
   */
  unreadableAt?: number;
}

interface PassContext {
  run: AgentLogRun;
  lock: { stillHeld(): Promise<boolean> };
  collector: AgentHistoryCollector;
  context: PricingContext;
  node: { node: string; attempt: number };
  spans: TimeSpan[];
  started: number;
  workdir: string | undefined;
  /** Repeats across the main log and the subagents' logs of this pass. */
  seen: Set<string>;
  /** How many `usage_recorded` the journal held when the pass began: the pass may add records up to the cap. */
  events: number;
  /** When the wait for the step's call in the log ends; set at the first wait of the pass, shared by all sessions. */
  waitUntil?: number;
  result: UsageResult;
}

/** Counts usage from the agent's log into the runs of one host. One per process, like the copy of the log. */
export class UsageWriter {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly stepWaitMs: number;
  private readonly budgetMs: number;
  /** What is kept for each run, least recently used first; see `RUN_CAP`. */
  private readonly runs = new Map<string, RunMemos>();
  private readonly collectors = new Map<string, AgentHistoryCollector>();
  private readonly finder: SessionFinder;

  constructor(private readonly options: UsageWriterOptions) {
    this.finder = new SessionFinder({ root: options.root, env: options.env });
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.stepWaitMs = Math.max(0, options.stepWaitMs ?? STEP_END_LOG_WAIT_MS);
    this.budgetMs = options.budgetMs ?? USAGE_BUDGET_MS;
  }

  /**
   * Wait until the log of a session that proved the run holds the call that hands in this step, for at most
   * `STEP_END_LOG_WAIT_MS` of the whole pass. Never fails: a log that does not get there is read as it is.
   */
  private async awaitStepCall(ctx: PassContext, path: string): Promise<void> {
    if (this.stepWaitMs === 0) return;
    const there = () => hasStepCall(path, ctx.run.runId, ctx.node.node, ctx.node.attempt);
    if (await there()) return;
    ctx.waitUntil ??= this.now() + this.stepWaitMs;
    // Also bounded by the number of looks, so a clock that does not move cannot make the wait endless.
    for (let looks = 0; looks <= this.stepWaitMs / STEP_END_LOG_POLL_MS; looks += 1) {
      const left = ctx.waitUntil - this.now();
      if (left <= 0) return;
      await this.sleep(Math.min(STEP_END_LOG_POLL_MS, left));
      if (await there()) return;
    }
  }

  /** Let go of what is kept for a run that has ended. */
  forget(runId: string): void {
    this.runs.delete(runId);
  }

  /** What is kept for a run, made if there is none; using it makes the run the newest. */
  private memosOf(runId: string): RunMemos {
    let own = touched(this.runs, runId);
    if (own === undefined) {
      own = { mains: new Map(), children: new Map() };
      this.runs.set(runId, own);
      trimmed(this.runs, RUN_CAP);
    }
    return own;
  }

  private collector(configDir: string): AgentHistoryCollector {
    let found = this.collectors.get(configDir);
    if (found === undefined) {
      found = this.options.collector
        ? this.options.collector(configDir)
        : claudeCodeCollector({ configDir, cacheScope: true });
      this.collectors.set(configDir, found);
    }
    return found;
  }

  /** The memo of a candidate session of a run; the subagent logs of any run do not push it out. */
  private mainMemo(runId: string, session: string, path: string): StreamMemo {
    const own = this.memosOf(runId).mains;
    let found = touched(own, session);
    if (found === undefined || found.path !== path) {
      found = { path, creditedSeq: 0 };
      own.delete(session);
      own.set(session, found);
      trimmed(own, MAIN_MEMO_CAP);
    }
    return found;
  }

  /** The memo of a subagent log if there is one, used now; it takes no slot. */
  private peekChild(runId: string, session: string, path: string): StreamMemo | undefined {
    const own = this.runs.get(runId);
    if (own === undefined) return undefined;
    const found = touched(own.children, session);
    return found !== undefined && found.path === path ? found : undefined;
  }

  /** A memo for a subagent log of a run, kept among the `CHILD_MEMO_CAP` most recently used of that run. */
  private childMemo(runId: string, session: string, path: string): StreamMemo {
    const own = this.memosOf(runId).children;
    const found: StreamMemo = { path, creditedSeq: 0 };
    own.delete(session);
    own.set(session, found);
    trimmed(own, CHILD_MEMO_CAP);
    return found;
  }

  /**
   * One pass for the end of the step `step`, under the lock the host holds. Never throws: usage is display data and
   * must not fail the step that asked for it.
   */
  async capture(
    run: AgentLogRun,
    step: { node: string; attempt: number },
    lock: { stillHeld(): Promise<boolean> },
  ): Promise<UsageResult> {
    const result: UsageResult = { recorded: 0, sessions: [], failures: [] };
    try {
      return await this.pass(run, step, lock, result);
    } catch {
      return result;
    }
  }

  private skipReason(
    state: RunState,
    step: { node: string; attempt: number },
  ): UsageResult["skipped"] | undefined {
    if (state.status !== "running") return "not_running";
    if (state.usage === undefined || state.history?.usage?.enabled !== true) return "disabled";
    const visit = state.active.find((v) => v.node === step.node && v.attempt === step.attempt);
    if (visit === undefined || visit.phase !== "agent") return "no_step";
    return undefined;
  }

  private async pass(
    run: AgentLogRun,
    step: { node: string; attempt: number },
    lock: { stillHeld(): Promise<boolean> },
    result: UsageResult,
  ): Promise<UsageResult> {
    const started = this.now();
    const state = await run.state();
    const skipped = this.skipReason(state, step);
    if (skipped !== undefined) return { ...result, skipped };
    // The journal holds as many records as it may: said once, and the log is no longer read for nothing.
    if ((state.usage?.events ?? 0) >= MAX_USAGE_EVENTS) {
      await this.fail(run, result, "cap");
      return result;
    }
    const env = this.options.env();
    const configDir = claudeConfigDir(env);
    const workdir = await run.workdir();
    const prices = state.history?.usage?.prices;
    const ctx: PassContext = {
      run,
      lock,
      collector: this.collector(configDir),
      context: defaultPricing(
        prices !== undefined && Object.keys(prices).length > 0 ? prices : undefined,
      ),
      node: step,
      spans: outsideSpans(
        await run.journal().catch(() => []),
        started,
        state.active.filter((v) => v.phase === "agent"),
        state.pauses,
      ),
      started,
      workdir,
      seen: new Set(),
      events: state.usage?.events ?? 0,
      result,
    };

    const candidates = await this.finder.candidates(env, configDir, workdir);
    let proven = 0;
    let missing = false;
    for (const candidate of candidates) {
      if (candidate.refused) {
        proven += 1;
        await this.fail(run, result, "refused", candidate.session);
        continue;
      }
      if (candidate.path === undefined) {
        missing = missing || candidate.session === cleanExecutorText(env[SESSION_ENV]);
        continue;
      }
      const memo = this.mainMemo(run.runId, candidate.session, candidate.path);
      if (memo.stopped !== undefined) {
        proven += 1;
        continue;
      }
      if (!(await proveRunStart(run.runId, memo))) continue;
      proven += 1;
      // The response that makes the call of this step may not be in the log yet.
      await this.awaitStepCall(ctx, candidate.path);
      if ((await this.credit(ctx, candidate.session, undefined, memo)) === "abort") return result;
      // Subagents are counted whatever the switch of the tool log says: their use is use.
      for (const log of await subagentLogs(candidate.path, candidate.session)) {
        const id = basename(log, ".jsonl");
        if (!SAFE_SESSION.test(id)) continue;
        let child = this.peekChild(run.runId, id, log);
        if (child?.stopped !== undefined) continue;
        if (child?.start === undefined) {
          const born = await firstTimestamp(log);
          const from = memo.start?.ts;
          // A subagent that began before the run's first call belongs to what came before; it takes no slot.
          if (born === undefined) {
            // Without a time on its first entry it cannot be told from one that began before the run: not guessed.
            await this.fail(run, result, "unreadable", id);
            continue;
          }
          if (from !== undefined && born < from) continue;
          child = this.childMemo(run.runId, id, log);
          child.start = { offset: 0 };
        }
        if ((await this.credit(ctx, id, candidate.session, child)) === "abort") return result;
      }
    }
    if (proven === 0) {
      await this.fail(run, result, await this.noSession(run, missing));
    }
    return result;
  }

  /** Whether the journal cannot take another record: said once as `cap`, not as a record the machine refused. */
  private async capReached(ctx: PassContext): Promise<boolean> {
    if (ctx.events + ctx.result.recorded < MAX_USAGE_EVENTS) return false;
    await this.fail(ctx.run, ctx.result, "cap");
    return true;
  }

  /** Why no log was found: an agent with no collector, a log that is gone, or a session that is not known. */
  private async noSession(run: AgentLogRun, missing: boolean): Promise<UsageFailure> {
    const journal = await run.journal().catch(() => [] as JournalRecord[]);
    let client: string | undefined;
    for (const record of journal) {
      const executor = record.executor as { client?: { value?: { name?: unknown } } } | undefined;
      const name = executor?.client?.value?.name;
      if (typeof name === "string") client = name;
    }
    if (client !== undefined && !client.toLowerCase().includes("claude"))
      return "agent_unsupported";
    return missing ? "log_missing" : "session_unknown";
  }

  private async fail(
    run: AgentLogRun,
    result: UsageResult,
    reason: UsageFailure,
    session?: string,
  ): Promise<void> {
    if (!(USAGE_FAILURES as readonly string[]).includes(reason)) return;
    if (!result.failures.includes(reason)) result.failures.push(reason);
    try {
      await run.apply({
        type: "usage_failed",
        reason,
        ...(session === undefined ? {} : { session }),
      });
    } catch {
      // the account of a failure is not worth a failure
    }
  }

  /**
   * Credit what is new in one stream. `"abort"` means the pass must stop (the lock is no longer ours, or the run went
   * away); anything else is a result for this stream alone.
   */
  private async credit(
    ctx: PassContext,
    session: string,
    parent: string | undefined,
    memo: StreamMemo,
  ): Promise<"done" | "abort"> {
    const { run, collector, lock } = ctx;
    const state = await run.state();
    if (state.status !== "running" || state.usage === undefined) return "abort";
    const stored = state.usage.sessions[session];
    const credited = stored?.last_seq ?? 0;

    if (memo.unreadableAt !== undefined) {
      const size = await stat(memo.path).then(
        (info) => info.size,
        () => undefined,
      );
      if (size === memo.unreadableAt) return "done";
      memo.unreadableAt = undefined;
    }

    // A checkpoint is good only for the stream the state says we left: after another process wrote, or after the log
    // itself changed under us, the pass starts again from the run's beginning and skips what is credited.
    let resume = memo.checkpoint;
    if (resume !== undefined) {
      const same =
        memo.creditedSeq === credited &&
        memo.sourceTail !== undefined &&
        (await sourceTailHash(memo.path, resume.offset)) === memo.sourceTail;
      if (!same) resume = undefined;
    }
    memo.checkpoint = undefined;
    const start = memo.start;
    if (resume === undefined && (start === undefined || start === null)) return "done";

    const capture: CaptureOptions = {
      skipIds: true,
      metadata: true,
      rules: [...this.options.rules],
    };
    const ref: SessionRef = {
      agent: AGENT_ID,
      session_id: session,
      project_root: this.options.root,
      path: memo.path,
      ...(parent === undefined ? {} : { parent_session_id: parent }),
    };
    const holder: { value?: ReadCheckpoint } = {};
    let stoppedEarly = false;
    const shouldStop = () => {
      if (this.now() - ctx.started > this.budgetMs) {
        stoppedEarly = true;
        return true;
      }
      return false;
    };
    const flushedKey = stored?.flushed?.key;
    const fresh: UsageEvent[] = [];
    // What a changed format of the log looks like: responses with no usage at all, or usage that is all zeros.
    let responses = 0;
    let usages = 0;
    let withTokens = 0;
    let correcting: UsageEvent | undefined;
    let lastSeen: HistoryEvent | undefined;
    let sawCredited = credited === 0 || resume !== undefined;
    let changed = false;

    try {
      for await (const event of collector.read(ref, undefined, {
        capture,
        usageDetail: true,
        holdBack: true,
        ...(resume === undefined ? { fromOffset: start?.offset ?? 0 } : { resume }),
        checkpoint: holder,
        shouldStop,
        extraWorkdirs: ctx.workdir === undefined ? [] : [ctx.workdir],
      })) {
        if (event.kind === "message" && event.role === "assistant") responses += 1;
        if (event.kind === "usage") {
          usages += 1;
          if (event.input + event.output + event.cache_read + event.cache_write > 0)
            withTokens += 1;
        }
        if (event.seq <= credited) {
          if (event.seq === credited) {
            sawCredited = true;
            if (stored !== undefined && usageEventKey(event) !== stored.last_key) {
              changed = true;
              break;
            }
          }
          continue;
        }
        lastSeen = event;
        if (event.kind !== "usage") continue;
        if (flushedKey !== undefined && responseKey(event) === flushedKey) correcting = event;
        else fresh.push(event);
      }
    } catch (error) {
      memo.checkpoint = undefined;
      const code = error instanceof KodelError ? error.code : undefined;
      if (code === "HISTORY_PATH_OUTSIDE_PROJECT")
        await this.fail(run, ctx.result, "refused", session);
      else if (code === "HISTORY_SESSION_UNREADABLE") {
        await this.fail(run, ctx.result, "log_missing", session);
      } else await this.fail(run, ctx.result, "unreadable", session);
      return "done";
    }

    const endSeq = holder.value?.seq ?? credited;
    if (changed || (!sawCredited && !stoppedEarly && endSeq < credited)) {
      memo.checkpoint = undefined;
      memo.stopped = "unreadable";
      await this.fail(run, ctx.result, "unreadable", session);
      return "done";
    }

    // A log that has responses and no usage, or only empty usage, is not one this reader understands: said, not zero.
    if (
      credited === 0 &&
      !stoppedEarly &&
      ((responses > 0 && usages === 0) || (usages > 0 && withTokens === 0))
    ) {
      memo.checkpoint = undefined;
      memo.unreadableAt = await stat(memo.path).then(
        (info) => info.size,
        () => undefined,
      );
      await this.fail(run, ctx.result, "unreadable", session);
      return "done";
    }

    // The response still open at the end of the log, counted as it stands. Only when the read reached the end: a read
    // that ran out of time is in the middle of the log, not of a response.
    let provisional: UsageEvent | undefined;
    if (!stoppedEarly && holder.value !== undefined) {
      provisional = await this.openResponse(collector, ref, holder.value, capture, ctx.workdir);
    }

    const deduped = dedupeUsage(fresh, ctx.seen);
    const { credited: toStep, outside } = splitBySpans(deduped.fresh, ctx.spans);
    const subagent = parent !== undefined;
    const options = {
      ...(deduped.overflow ? { dedupeOverflow: true } : {}),
      ...(stoppedEarly ? { incomplete: true } : {}),
      ...(subagent ? { subagent: true } : {}),
    };
    let stepDelta: UsageDelta = buildDelta(toStep, ctx.context, options);
    // The set of repeats holds the key of every response already counted in this pass, from any stream: one that is
    // open here and whole in another file (or already counted from this one) is not counted again.
    if (provisional !== undefined && !ctx.seen.has(usageDedupeKey(provisional))) {
      const key = responseKey(provisional);
      ctx.seen.add(usageDedupeKey(provisional));
      // The same response that was open at the last pass and still is: only what it added since is counted.
      const piece =
        stored?.flushed?.key === key
          ? correctionDelta(provisional, stored.flushed, ctx.context)
          : buildDelta([provisional], ctx.context, options);
      if (piece !== undefined && !isEmptyDelta(piece)) {
        stepDelta = mergeDeltas(stepDelta, { ...piece, last_open: true });
      }
    } else if (provisional !== undefined) {
      provisional = undefined;
    }
    if (correcting !== undefined && stored?.flushed !== undefined) {
      const rest = correctionDelta(correcting, stored.flushed, ctx.context);
      if (rest !== undefined) stepDelta = mergeDeltas(stepDelta, rest);
    }
    const outsideDelta: UsageDelta = buildDelta(outside, ctx.context, options);

    const last = lastSeen ?? undefined;
    const cursorFlushed: FlushedResponse | undefined =
      provisional === undefined || holder.value === undefined
        ? undefined
        : {
            offset: holder.value.offset,
            key: responseKey(provisional),
            model: foldModelId(provisional.model),
            input: provisional.input,
            output: provisional.output,
            cache_read: provisional.cache_read,
            cache_write: provisional.cache_write,
            cache_write_1h: Math.min(provisional.cache_write_1h ?? 0, provisional.cache_write),
          };
    // A flushed response stays to be corrected until it is found whole.
    const keepFlushed = cursorFlushed ?? (correcting === undefined ? stored?.flushed : undefined);
    const worth = !isEmptyDelta(stepDelta) || !isEmptyDelta(outsideDelta);
    // `behind` says the log was not read to its end. It has to change when the pass changes its mind about that, also
    // when there is nothing to credit (a read that ran out of time while it skipped what was credited already, or a
    // log that ends in events that carry no usage).
    const needsMark = stoppedEarly ? stored?.behind !== true : stored?.behind === true;
    let written = credited;
    if ((worth || needsMark) && (last !== undefined || stored !== undefined)) {
      // The cursor never goes back, however far a read that ran out of time got in skipping.
      const cursor: UsageCursor = {
        last_seq: Math.max(endSeq, credited),
        last_key: last === undefined ? (stored?.last_key ?? "") : usageEventKey(last),
        ...(keepFlushed === undefined ? {} : { flushed: keepFlushed }),
        ...(stoppedEarly ? { behind: true as const } : {}),
      };
      if (/^[0-9a-f]{64}$/.test(cursor.last_key)) {
        if (!(await lock.stillHeld())) return "abort";
        // The cursor goes with the step's delta, empty or not, unless the other one carries it.
        if (!isEmptyDelta(stepDelta) || isEmptyDelta(outsideDelta)) {
          if (await this.capReached(ctx)) return "abort";
          const decision = await run.apply({
            type: "usage_recorded",
            session,
            node: ctx.node.node,
            attempt: ctx.node.attempt,
            delta: stepDelta,
            cursor,
          });
          if (!decision.ok || decision.noop === true) {
            // Said once, not left as a pass that ends for no visible reason.
            await this.fail(run, ctx.result, "record_refused", session);
            return "abort";
          }
          ctx.result.recorded += 1;
          if (!ctx.result.sessions.includes(session)) ctx.result.sessions.push(session);
        }
        if (!isEmptyDelta(outsideDelta)) {
          if (!(await lock.stillHeld())) return "abort";
          if (await this.capReached(ctx)) return "abort";
          const decision = await run.apply({
            type: "usage_recorded",
            session,
            delta: outsideDelta,
            cursor,
          });
          if (!decision.ok || decision.noop === true) {
            // Said once, not left as a pass that ends for no visible reason.
            await this.fail(run, ctx.result, "record_refused", session);
            return "abort";
          }
          ctx.result.recorded += 1;
          if (!ctx.result.sessions.includes(session)) ctx.result.sessions.push(session);
        }
        written = cursor.last_seq;
      }
    }
    if (holder.value !== undefined) {
      memo.checkpoint = holder.value;
      memo.sourceTail = await sourceTailHash(memo.path, holder.value.offset);
      memo.creditedSeq = written;
    }
    return "done";
  }

  /**
   * The response the agent is writing at the end of the log, as the reader would give it if it ended there. The
   * reader's state is copied first: the real one still holds the response back and goes on from it next time.
   */
  private async openResponse(
    collector: AgentHistoryCollector,
    ref: SessionRef,
    at: ReadCheckpoint,
    capture: CaptureOptions,
    workdir: string | undefined,
  ): Promise<UsageEvent | undefined> {
    let state: unknown;
    try {
      state = structuredClone(at.state);
    } catch {
      return undefined;
    }
    let found: UsageEvent | undefined;
    try {
      for await (const event of collector.read(ref, undefined, {
        capture,
        resume: { offset: at.offset, seq: at.seq, state },
        // Anything newer than the end of the log the real read reached waits for the next pass.
        shouldStop: () => true,
        extraWorkdirs: workdir === undefined ? [] : [workdir],
      })) {
        if (event.kind === "usage" && event.seq > at.seq) found = event;
      }
    } catch {
      return undefined;
    }
    return found;
  }
}
