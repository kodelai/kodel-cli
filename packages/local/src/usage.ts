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
 * What is kept in memory, bounded three ways so that one busy run cannot make another (or its own main session) forget:
 * the main sessions of all runs, the subagent logs of one run, and the runs that have subagent logs at all. The oldest go
 * first inside each.
 */
const MAIN_MEMO_CAP = 32;
const CHILD_MEMO_CAP = 48;
const CHILD_RUN_CAP = 8;

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

/**
 * The times the run waited for a person: from a gate being reached to the decision, and from a pause to the resume.
 * What the agent and the person say to each other then is not a node's work. A span still open lasts to `nowMs`.
 */
export function outsideSpans(journal: readonly JournalRecord[], nowMs: number): TimeSpan[] {
  const spans: TimeSpan[] = [];
  const gates = new Map<string, number>();
  let paused: number | undefined;
  const close = (from: number, to: number) => spans.push({ from: isoOf(from), to: isoOf(to) });
  for (const record of journal) {
    const node = typeof record.node === "string" ? record.node : "";
    if (record.event === "gate_waiting") gates.set(node, record.ts);
    else if (record.event === "gate_decided") {
      const from = gates.get(node);
      if (from !== undefined) close(from, record.ts);
      gates.delete(node);
    } else if (record.event === "run_paused") paused = record.ts;
    else if (record.event === "run_resumed") {
      if (paused !== undefined) close(paused, record.ts);
      paused = undefined;
    }
  }
  for (const from of gates.values()) close(from, nowMs);
  if (paused !== undefined) close(paused, nowMs);
  return spans;
}

export interface UsageWriterOptions {
  /** The project root: where the hook index is, and a place a session of the agent may have started. */
  root: string;
  rules: readonly RedactRule[];
  env: () => NodeJS.ProcessEnv;
  now?: () => number;
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
  result: UsageResult;
}

/** Counts usage from the agent's log into the runs of one host. One per process, like the copy of the log. */
export class UsageWriter {
  private readonly now: () => number;
  private readonly budgetMs: number;
  /** The main session of each run, by `runId|session`. */
  private readonly mains = new Map<string, StreamMemo>();
  /** The subagent logs of each run, by run and then by session. */
  private readonly children = new Map<string, Map<string, StreamMemo>>();
  private readonly collectors = new Map<string, AgentHistoryCollector>();
  private readonly finder: SessionFinder;

  constructor(private readonly options: UsageWriterOptions) {
    this.finder = new SessionFinder({ root: options.root, env: options.env });
    this.now = options.now ?? Date.now;
    this.budgetMs = options.budgetMs ?? USAGE_BUDGET_MS;
  }

  /** Let go of what is kept for a run that has ended. */
  forget(runId: string): void {
    for (const key of [...this.mains.keys()])
      if (key.startsWith(`${runId}|`)) this.mains.delete(key);
    this.children.delete(runId);
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

  /** The memo of a main session; it is never pushed out by the subagent logs of any run. */
  private mainMemo(runId: string, session: string, path: string): StreamMemo {
    const key = `${runId}|${session}`;
    let found = this.mains.get(key);
    if (found === undefined || found.path !== path) found = { path, creditedSeq: 0 };
    this.mains.delete(key);
    this.mains.set(key, found);
    if (this.mains.size > MAIN_MEMO_CAP) {
      const oldest = this.mains.keys().next().value;
      if (oldest !== undefined) this.mains.delete(oldest);
    }
    return found;
  }

  /** The memo of a subagent log if there is one; it takes no slot. */
  private peekChild(runId: string, session: string, path: string): StreamMemo | undefined {
    const found = this.children.get(runId)?.get(session);
    return found !== undefined && found.path === path ? found : undefined;
  }

  /** A memo for a subagent log of a run, kept among the newest `CHILD_MEMO_CAP` of that run. */
  private childMemo(runId: string, session: string, path: string): StreamMemo {
    const own = this.children.get(runId) ?? new Map<string, StreamMemo>();
    // Touched runs go last, and the oldest run's logs are forgotten when too many runs have any.
    this.children.delete(runId);
    this.children.set(runId, own);
    if (this.children.size > CHILD_RUN_CAP) {
      const oldest = this.children.keys().next().value;
      if (oldest !== undefined) this.children.delete(oldest);
    }
    let found = own.get(session);
    if (found === undefined || found.path !== path) found = { path, creditedSeq: 0 };
    own.delete(session);
    own.set(session, found);
    if (own.size > CHILD_MEMO_CAP) {
      const oldest = own.keys().next().value;
      if (oldest !== undefined) own.delete(oldest);
    }
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
      spans: outsideSpans(await run.journal().catch(() => []), started),
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
