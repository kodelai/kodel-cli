/**
 * What the agent called in a run, read from its own log at the end of each agent step and recorded as rows
 * (`tool_calls_recorded`) in the run's journal. Information only: it never feeds a check, a route or a gate. See
 * `docs/history.md` ("Tool calls") for what is recorded and what is not.
 *
 * The rules a pass keeps:
 *  - It has a switch of its own (`history.tool_calls`), so it works with the copy of the agent's log switched off. It shares
 *    with that copy and with the count of usage the lock of the step end (the host runs it as the last part of
 *    `CaptureInput.also`), the way a session is found and, through `RunStartCache`, what was found about where the run begins.
 *  - It pairs nothing. A call and its result are separate rows, each recorded when the reader releases it; the report joins
 *    them by id. So a call whose result comes in a later pass needs no memory in the pass.
 *  - A call belongs to the step of the first hand-in at or after its start (`placeCall`), and the row says so: a later pass
 *    that reads the hand-in call of an earlier step still puts it with that step.
 *  - The cursor (`seq` of the last event recorded, the same for the same log) is in the run's state: after a restart the log is
 *    read again from the run's start and what was recorded is skipped. A pass that runs out of time records only what it read.
 *  - A pass never fails the step: whatever goes wrong is a reason, journaled once.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  type AgentHistoryCollector,
  attemptKey,
  type CallRow,
  type CaptureOptions,
  cleanExecutorText,
  type HistoryEvent,
  isOwnTool,
  KodelError,
  MAX_COUNT_ATTEMPTS,
  MAX_COUNT_TOOLS,
  MAX_ROWS_PER_RECORD,
  MAX_TOOL_CALL_EVENTS,
  MAX_TOOL_PREVIEW_CHARS,
  newReadStats,
  OTHER_TOOL,
  type Placement,
  type PlacementContext,
  placeCall,
  placementFromJournal,
  type ReadCheckpoint,
  type RedactRule,
  type ResultRow,
  type RunState,
  redactText,
  type SessionRef,
  splitToolName,
  TOOL_CALLS_FAILURES,
  TOOL_ERROR_KINDS,
  TOOL_NAME,
  type ToolCallsCursor,
  type ToolCallsFailure,
  type ToolErrorKind,
  type ToolRow,
  UNATTRIBUTED_KEY,
} from "@kodel-ai/pipeline-core";
import type { AgentLogRun } from "./agent-log";
import { SESSION_ENV } from "./executor";
import { claudeCodeCollector } from "./history/claude-code/collector";
import { claudeConfigDir, firstTimestamp, subagentLogs } from "./history/claude-code/locate";
import { AGENT_ID } from "./history/claude-code/normalize";
import {
  proveRunStart,
  type RunStartCache,
  type RunStartMemo,
  SAFE_SESSION,
  SessionFinder,
  sourceTailHash,
} from "./session-finder";
import { outsideSpans, usageEventKey } from "./usage";

/** A pass stops reading after this long and keeps what it has: a big log catches up over several passes. */
export const TOOL_CALLS_BUDGET_MS = 5_000;

/** Bounded like the memos of the usage count, so one busy run cannot make another forget. */
/**
 * A call that began after the pass did, but not by much, is not recorded yet: the pass reads the logs to their end while a
 * worker goes on writing its own, and a row is never rewritten, so such a call is left for the next pass, which places it.
 * A call further in the future than this is a clock that is wrong (or a log that is forged): it is recorded, `unattributed`.
 */
const NEAR_FUTURE_MS = 60_000;

const MAIN_MEMO_CAP = 32;
const CHILD_MEMO_CAP = 48;
const RUN_CAP = 8;

interface StreamMemo extends RunStartMemo {
  checkpoint?: ReadCheckpoint;
  /** The hash of the 64 bytes of the log before `checkpoint.offset`: what the checkpoint was made against. */
  sourceTail?: string;
  /** The `last_seq` the state had for this stream when this process last wrote it. */
  recordedSeq: number;
  stopped?: ToolCallsFailure;
}

interface RunMemos {
  mains: Map<string, StreamMemo>;
  children: Map<string, StreamMemo>;
}

function touched<V>(map: Map<string, V>, key: string): V | undefined {
  const found = map.get(key);
  if (found !== undefined) {
    map.delete(key);
    map.set(key, found);
  }
  return found;
}

function trimmed<V>(map: Map<string, V>, cap: number): void {
  while (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The id of a call or a result in a row: from the session and the id in the log, so the same call always has the same id. */
export const rowId = (session: string, id: string): string =>
  `id-${sha256(`${session}\u0000${id}`).slice(0, 12)}`;

export interface ToolCallsWriterOptions {
  /** The project root: where the hook index is, and a place a session of the agent may have started. */
  root: string;
  rules: readonly RedactRule[];
  env: () => NodeJS.ProcessEnv;
  now?: () => number;
  /** The collector to read with; the Claude Code one, looking in the config dir of the environment, when not given. */
  collector?: (configDir: string) => AgentHistoryCollector;
  /** How long one pass may read before it keeps what it has. */
  budgetMs?: number;
  /** What was found about where a run begins in a log, shared with the count of usage so a log is not searched twice. */
  runStarts?: RunStartCache;
}

export interface ToolCallsResult {
  /** The pass did not run, and why. */
  skipped?: "disabled" | "not_running" | "no_step";
  /** Records journaled, and the sessions that got some. */
  recorded: number;
  sessions: string[];
  /** The reasons tool calls could not be recorded in this pass. */
  failures: ToolCallsFailure[];
}

interface PassContext {
  run: AgentLogRun;
  lock: { stillHeld(): Promise<boolean> };
  collector: AgentHistoryCollector;
  node: { node: string; attempt: number };
  placement: PlacementContext;
  started: number;
  workdir: string | undefined;
  /** The longest input preview that may be stored (`0`: none). */
  previewChars: number;
  /** `tool_calls_recorded` events the journal held when the pass began. */
  events: number;
  /**
   * The ids (as the log has them) of the calls and the results given in this pass, whatever the stream: a call that the main
   * log and a subagent's own file both hold is recorded once.
   */
  seenCalls: Set<string>;
  seenResults: Set<string>;
  result: ToolCallsResult;
}

/** A row with where it sits in the log, so a record that holds only part of what a pass read gets the cursor of its part. */
interface Positioned {
  row: ToolRow;
  seq: number;
  key: string;
  /** The key of the counts this call is in; results have none. */
  owner?: string;
  tool?: string;
}

export class ToolCallsWriter {
  private readonly now: () => number;
  private readonly budgetMs: number;
  private readonly runs = new Map<string, RunMemos>();
  private readonly collectors = new Map<string, AgentHistoryCollector>();
  private readonly finder: SessionFinder;

  constructor(private readonly options: ToolCallsWriterOptions) {
    this.finder = new SessionFinder({ root: options.root, env: options.env });
    this.now = options.now ?? Date.now;
    this.budgetMs = options.budgetMs ?? TOOL_CALLS_BUDGET_MS;
  }

  /** Let go of what is kept for a run that has ended. */
  forget(runId: string): void {
    this.runs.delete(runId);
  }

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

  private mainMemo(runId: string, session: string, path: string): StreamMemo {
    const own = this.memosOf(runId).mains;
    let found = touched(own, session);
    if (found === undefined || found.path !== path) {
      found = { path, recordedSeq: 0 };
      own.delete(session);
      own.set(session, found);
      trimmed(own, MAIN_MEMO_CAP);
    }
    return found;
  }

  private peekChild(runId: string, session: string, path: string): StreamMemo | undefined {
    const own = this.runs.get(runId);
    if (own === undefined) return undefined;
    const found = touched(own.children, session);
    return found !== undefined && found.path === path ? found : undefined;
  }

  private childMemo(runId: string, session: string, path: string): StreamMemo {
    const own = this.memosOf(runId).children;
    const found: StreamMemo = { path, recordedSeq: 0 };
    own.delete(session);
    own.set(session, found);
    trimmed(own, CHILD_MEMO_CAP);
    return found;
  }

  /**
   * One pass for the end of the step `step`, under the lock the host holds. Never throws: this is display data and must not
   * fail the step that asked for it.
   */
  async capture(
    run: AgentLogRun,
    step: { node: string; attempt: number },
    lock: { stillHeld(): Promise<boolean> },
  ): Promise<ToolCallsResult> {
    const result: ToolCallsResult = { recorded: 0, sessions: [], failures: [] };
    try {
      return await this.pass(run, step, lock, result);
    } catch {
      return result;
    }
  }

  private skipReason(
    state: RunState,
    step: { node: string; attempt: number },
  ): ToolCallsResult["skipped"] | undefined {
    if (state.status !== "running") return "not_running";
    if (state.toolCalls === undefined || state.history?.tool_calls?.enabled !== true) {
      return "disabled";
    }
    const visit = state.active.find((v) => v.node === step.node && v.attempt === step.attempt);
    if (visit === undefined || visit.phase !== "agent") return "no_step";
    return undefined;
  }

  /** The longest preview that may be stored: only when the agent's own text is kept in full, and never more than asked. */
  private previewCharsOf(state: RunState): number {
    const log = state.history?.agent_log;
    if (log?.enabled !== true || log.mode !== "full") return 0;
    const asked = state.history?.tool_calls?.preview_chars ?? 0;
    return Math.max(0, Math.min(asked, MAX_TOOL_PREVIEW_CHARS));
  }

  private async pass(
    run: AgentLogRun,
    step: { node: string; attempt: number },
    lock: { stillHeld(): Promise<boolean> },
    result: ToolCallsResult,
  ): Promise<ToolCallsResult> {
    const started = this.now();
    const state = await run.state();
    const skipped = this.skipReason(state, step);
    if (skipped !== undefined) return { ...result, skipped };
    if ((state.toolCalls?.events ?? 0) >= MAX_TOOL_CALL_EVENTS) {
      await this.fail(run, result, "cap");
      return result;
    }
    const env = this.options.env();
    const configDir = claudeConfigDir(env);
    const workdir = await run.workdir();
    const journal = await run.journal().catch(() => []);
    const spans = outsideSpans(
      journal,
      started,
      state.active.filter((v) => v.phase === "agent"),
      state.pauses,
    ).map((s) => ({ from: Date.parse(s.from), to: Date.parse(s.to) }));
    const ctx: PassContext = {
      run,
      lock,
      collector: this.collector(configDir),
      node: step,
      // The start of the run is set below, from the log that proves it.
      placement: placementFromJournal(
        journal,
        step,
        started,
        spans,
        undefined,
        state.active.filter((v) => v.phase === "agent"),
      ),
      started,
      workdir,
      previewChars: this.previewCharsOf(state),
      events: state.toolCalls?.events ?? 0,
      seenCalls: new Set(),
      seenResults: new Set(),
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
      if (!(await proveRunStart(run.runId, memo, this.options.runStarts))) continue;
      proven += 1;
      // The start of the run is this log's own: one that has none leaves the placement without it, never with another log's.
      const { runStart: _previous, ...base } = ctx.placement;
      const runStart = memo.start?.ts === undefined ? undefined : Date.parse(memo.start.ts);
      ctx.placement = runStart === undefined ? base : { ...base, runStart };
      if ((await this.record(ctx, candidate.session, undefined, memo)) === "abort") return result;
      // Subagents are read whatever the switch of the tool log says: their calls are calls.
      for (const log of await subagentLogs(candidate.path, candidate.session)) {
        const id = basename(log, ".jsonl");
        if (!SAFE_SESSION.test(id)) continue;
        let child = this.peekChild(run.runId, id, log);
        if (child?.stopped !== undefined) continue;
        if (child?.start === undefined) {
          const born = await firstTimestamp(log);
          const from = memo.start?.ts;
          if (born === undefined) {
            // Without a time on its first entry it cannot be told from one that began before the run: not guessed.
            await this.fail(run, result, "unreadable", id);
            continue;
          }
          if (from !== undefined && born < from) continue;
          child = this.childMemo(run.runId, id, log);
          child.start = { offset: 0 };
        }
        if ((await this.record(ctx, id, candidate.session, child)) === "abort") return result;
      }
    }
    if (proven === 0) {
      await this.fail(run, result, await this.noSession(run, missing));
    }
    return result;
  }

  private async noSession(run: AgentLogRun, missing: boolean): Promise<ToolCallsFailure> {
    const journal = await run.journal().catch(() => []);
    let client: string | undefined;
    for (const record of journal) {
      const executor = record["executor"] as
        | { client?: { value?: { name?: unknown } } }
        | undefined;
      const name = executor?.client?.value?.name;
      if (typeof name === "string") client = name;
    }
    if (client !== undefined && !client.toLowerCase().includes("claude")) {
      return "agent_unsupported";
    }
    return missing ? "log_missing" : "session_unknown";
  }

  private async fail(
    run: AgentLogRun,
    result: ToolCallsResult,
    reason: ToolCallsFailure,
    session?: string,
  ): Promise<void> {
    if (!(TOOL_CALLS_FAILURES as readonly string[]).includes(reason)) return;
    if (!result.failures.includes(reason)) result.failures.push(reason);
    try {
      await run.apply({
        type: "tool_calls_failed",
        reason,
        ...(session === undefined ? {} : { session }),
      });
    } catch {
      // the account of a failure is not worth a failure
    }
  }

  private async capReached(ctx: PassContext): Promise<boolean> {
    if (ctx.events + ctx.result.recorded < MAX_TOOL_CALL_EVENTS) return false;
    await this.fail(ctx.run, ctx.result, "cap");
    return true;
  }

  /** A name the store would rewrite, or that is not a plain name, is not stored as it is. */
  private safeName(name: string): string | undefined {
    if (!TOOL_NAME.test(name)) return undefined;
    return redactText(name, [...this.options.rules]) === name ? name : undefined;
  }

  private callRow(
    ctx: PassContext,
    session: string,
    parent: string | undefined,
    event: Extract<HistoryEvent, { kind: "tool_call" }>,
  ): { row: CallRow; owner: string; tool: string } {
    const split = splitToolName(event.name);
    const tool = this.safeName(split.tool) ?? OTHER_TOOL;
    const server = split.server === undefined ? undefined : this.safeName(split.server);
    const placed: Placement = placeCall(Date.parse(event.started), ctx.placement);
    const where = placed.kind === "step" ? placed : undefined;
    const row: CallRow = {
      k: "c",
      id: rowId(session, event.id),
      tool,
      ...(server === undefined ? {} : { server }),
      ...(isOwnTool(event.name) ? { own: true as const } : {}),
      started: event.started,
      ...(event.input_bytes === undefined ? {} : { in_bytes: event.input_bytes }),
      ...(event.input_preview === undefined || ctx.previewChars === 0
        ? {}
        : { preview: event.input_preview.slice(0, ctx.previewChars) }),
      ...(parent === undefined ? {} : { subagent: session }),
      ...(where === undefined ? {} : { node: where.node, attempt: where.attempt }),
      ...(where?.shared === true ? { shared: true as const } : {}),
    };
    return {
      row,
      tool,
      owner: where === undefined ? UNATTRIBUTED_KEY : attemptKey(where.node, where.attempt),
    };
  }

  private resultRow(
    session: string,
    event: Extract<HistoryEvent, { kind: "tool_result" }>,
  ): ResultRow {
    const kind = (TOOL_ERROR_KINDS as readonly string[]).includes(event.error_type ?? "")
      ? (event.error_type as ToolErrorKind)
      : undefined;
    return {
      k: "r",
      id: rowId(session, event.id),
      ended: event.ended,
      ...(event.duration_ms === undefined ? {} : { ms: event.duration_ms }),
      ok: event.ok,
      ...(event.ok ? {} : { err: kind ?? "error" }),
      ...(event.size === undefined ? {} : { out_bytes: event.size }),
    };
  }

  /**
   * Record what is new in one stream. `"abort"` means the pass must stop (the lock is no longer ours, or the run went away);
   * anything else is a result for this stream alone.
   */
  private async record(
    ctx: PassContext,
    session: string,
    parent: string | undefined,
    memo: StreamMemo,
  ): Promise<"done" | "abort"> {
    const { run, collector, lock } = ctx;
    const state = await run.state();
    if (state.status !== "running" || state.toolCalls === undefined) return "abort";
    const stored: ToolCallsCursor | undefined = Object.hasOwn(state.toolCalls.sessions, session)
      ? state.toolCalls.sessions[session]
      : undefined;
    const recorded = stored?.last_seq ?? 0;

    // A checkpoint is good only for the stream the state says we left: after another process wrote, or after the log itself
    // changed under us, the pass starts again from the run's beginning and skips what is recorded.
    let resume = memo.checkpoint;
    if (resume !== undefined) {
      const same =
        memo.recordedSeq === recorded &&
        memo.sourceTail !== undefined &&
        (await sourceTailHash(memo.path, resume.offset)) === memo.sourceTail;
      if (!same) resume = undefined;
    }
    memo.checkpoint = undefined;
    const start = memo.start;
    if (resume === undefined && (start === undefined || start === null)) return "done";

    // With no preview wanted the read is metadata only; otherwise only the input of a call is kept as text.
    const capture: CaptureOptions = {
      skipIds: true,
      rules: [...this.options.rules],
      ...(ctx.previewChars === 0
        ? { metadata: true }
        : {
            caps: {
              user: 0,
              agent: 0,
              tool_result: 0,
              detail: 0,
              tool_input: ctx.previewChars,
            },
          }),
    };
    const ref: SessionRef = {
      agent: AGENT_ID,
      session_id: session,
      project_root: this.options.root,
      path: memo.path,
      ...(parent === undefined ? {} : { parent_session_id: parent }),
    };
    const holder: { value?: ReadCheckpoint } = {};
    const stats = newReadStats();
    let stoppedEarly = false;
    const shouldStop = () => {
      if (this.now() - ctx.started > this.budgetMs) {
        stoppedEarly = true;
        return true;
      }
      return false;
    };
    const fresh: Positioned[] = [];
    let lastSeen: HistoryEvent | undefined;
    let held = false;
    let sawRecorded = recorded === 0 || resume !== undefined;
    let changed = false;
    // The names of the tools seen in this pass, so the counts stay within their bound.
    const tools = new Set<string>();
    const owners = new Set<string>();

    try {
      for await (const event of collector.read(ref, undefined, {
        capture,
        toolDetail: true,
        holdBack: true,
        stats,
        ...(resume === undefined ? { fromOffset: start?.offset ?? 0 } : { resume }),
        checkpoint: holder,
        shouldStop,
        extraWorkdirs: ctx.workdir === undefined ? [] : [ctx.workdir],
      })) {
        if (event.seq <= recorded) {
          if (event.seq === recorded) {
            sawRecorded = true;
            if (stored !== undefined && usageEventKey(event) !== stored.last_key) {
              changed = true;
              break;
            }
          }
          continue;
        }
        if (event.kind === "tool_call") {
          const began = Date.parse(event.started);
          if (began > ctx.started && began <= ctx.started + NEAR_FUTURE_MS) {
            // From here on nothing is recorded: the cursor stays before this call and the next pass reads it again.
            held = true;
            break;
          }
        }
        lastSeen = event;
        const key = usageEventKey(event);
        if (event.kind === "tool_call") {
          if (ctx.seenCalls.has(event.id)) continue;
          ctx.seenCalls.add(event.id);
          const made = this.callRow(ctx, session, parent, event);
          const tool =
            tools.has(made.tool) || tools.size < MAX_COUNT_TOOLS ? made.tool : OTHER_TOOL;
          tools.add(tool);
          const owner =
            owners.has(made.owner) || owners.size < MAX_COUNT_ATTEMPTS
              ? made.owner
              : UNATTRIBUTED_KEY;
          owners.add(owner);
          // The counts and the row say the same: a call counted under the unattributed key has no attempt on its row.
          let row: CallRow = made.row;
          if (owner !== made.owner) {
            const { node: _node, attempt: _attempt, shared: _shared, ...rest } = made.row;
            row = rest;
          }
          fresh.push({ row, seq: event.seq, key, owner, tool });
        } else if (event.kind === "tool_result") {
          if (ctx.seenResults.has(event.id)) continue;
          ctx.seenResults.add(event.id);
          fresh.push({ row: this.resultRow(session, event), seq: event.seq, key });
        }
      }
    } catch (error) {
      memo.checkpoint = undefined;
      const code = error instanceof KodelError ? error.code : undefined;
      if (code === "HISTORY_PATH_OUTSIDE_PROJECT") {
        await this.fail(run, ctx.result, "refused", session);
      } else if (code === "HISTORY_SESSION_UNREADABLE") {
        await this.fail(run, ctx.result, "log_missing", session);
      } else await this.fail(run, ctx.result, "unreadable", session);
      return "done";
    }

    // A held pass ends where it stopped, not where the reader's state went on to.
    const endSeq = held ? (lastSeen?.seq ?? recorded) : (holder.value?.seq ?? recorded);
    if (changed || (!sawRecorded && !stoppedEarly && endSeq < recorded)) {
      memo.checkpoint = undefined;
      memo.stopped = "unreadable";
      await this.fail(run, ctx.result, "unreadable", session);
      return "done";
    }

    const skipped = stats.invalid_lines;
    const behind = stoppedEarly || held;
    const needsMark = behind ? stored?.behind !== true : stored?.behind === true;
    let written = recorded;
    if (
      (fresh.length > 0 || skipped > 0 || needsMark) &&
      (lastSeen !== undefined || stored !== undefined)
    ) {
      // The last record of the pass carries the cursor of the whole read; one that holds only part carries the cursor of
      // its last row, so a record the run refuses never moves the cursor past rows that were not recorded.
      const finalCursor: ToolCallsCursor = {
        last_seq: Math.max(endSeq, recorded),
        last_key: lastSeen === undefined ? (stored?.last_key ?? "") : usageEventKey(lastSeen),
        ...(behind ? { behind: true as const } : {}),
      };
      if (/^[0-9a-f]{64}$/.test(finalCursor.last_key)) {
        const chunks: Positioned[][] = [];
        for (let i = 0; i < fresh.length; i += MAX_ROWS_PER_RECORD) {
          chunks.push(fresh.slice(i, i + MAX_ROWS_PER_RECORD));
        }
        if (chunks.length === 0) chunks.push([]);
        for (let n = 0; n < chunks.length; n++) {
          const part = chunks[n] ?? [];
          const lastPart = n === chunks.length - 1;
          const tail = part[part.length - 1];
          const cursor: ToolCallsCursor =
            lastPart || tail === undefined
              ? finalCursor
              : // More of this pass follows: say so, so a record the run refuses does not leave a cursor that looks complete.
                { last_seq: tail.seq, last_key: tail.key, behind: true as const };
          const counts: Record<string, Record<string, number>> = {};
          for (const item of part) {
            if (item.row.k !== "c" || item.owner === undefined || item.tool === undefined) continue;
            const into = counts[item.owner] ?? {};
            into[item.tool] = (into[item.tool] ?? 0) + 1;
            counts[item.owner] = into;
          }
          if (!(await lock.stillHeld())) return "abort";
          if (await this.capReached(ctx)) return "abort";
          const decision = await run.apply({
            type: "tool_calls_recorded",
            session,
            node: ctx.node.node,
            attempt: ctx.node.attempt,
            calls: {
              v: 1,
              rows: part.map((item) => item.row),
              counts,
              ...(n === 0 && skipped > 0 ? { skipped } : {}),
            },
            cursor,
          });
          if (!decision.ok || decision.noop === true) {
            // Said once, not left as a pass that ends for no visible reason.
            await this.fail(run, ctx.result, "record_refused", session);
            return "abort";
          }
          ctx.result.recorded += 1;
          if (!ctx.result.sessions.includes(session)) ctx.result.sessions.push(session);
          written = cursor.last_seq;
        }
      }
    }
    // Everything the read gave was recorded (a failed record returns above), so the read can go on from where it stopped.
    if (held) {
      memo.checkpoint = undefined;
    } else if (holder.value !== undefined) {
      memo.checkpoint = holder.value;
      memo.sourceTail = await sourceTailHash(memo.path, holder.value.offset);
      memo.recordedSeq = written;
    }
    return "done";
  }
}
