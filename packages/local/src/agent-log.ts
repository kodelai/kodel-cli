/**
 * The agent's conversation log of a run, kept in the run folder (`agent_log/<session>.jsonl`) as redacted normalized
 * events. One pass copies what is new from the sessions that belong to the run; the ticker and the end of a step both
 * make one. See `docs/history.md` ("Capture decisions") for what is kept and why.
 *
 * The rules a pass keeps, in the order they matter:
 *  - A session belongs to the run when its own log holds a call of the run's tools with the run's id (`findRunStart`).
 *    The id of the session comes from the environment of this process and from the hook index; neither is believed
 *    without that proof.
 *  - A pass takes the lock on copying (never the run's lock while it works), asks before every write that it still
 *    holds it, and journals what it stored. The journal is what the files are measured against: bytes past the
 *    journaled length were never vouched for and are cut off by the next pass.
 *  - Only whole responses are copied, and every text has gone through `redact` twice.
 *  - A copy never fails the step or the run. Whatever goes wrong is a reason, journaled once.
 */
import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type AgentHistoryCollector,
  type AgentLogConfig,
  type AgentLogFailure,
  type CaptureOptions,
  cleanExecutorText,
  HISTORY_FORMAT,
  type HistoryEvent,
  historyEventSchema,
  ID_FIELDS,
  KodelError,
  MAX_AGENT_LOG_TICKS,
  type ReadCheckpoint,
  type RedactRule,
  type RunEvent,
  type RunState,
  redactText,
  type SessionRef,
} from "@kodel-ai/pipeline-core";
import { z } from "zod";
import { SESSION_ENV } from "./executor";
import { claudeCodeCollector } from "./history/claude-code/collector";
import {
  claudeConfigDir,
  findSessionLog,
  firstTimestamp,
  subagentLogs,
} from "./history/claude-code/locate";
import { AGENT_ID } from "./history/claude-code/normalize";
import { findRunStart } from "./history/claude-code/window";
import { isInside, realOrSelf } from "./history/scope";
import { SESSIONS_INDEX } from "./hooks/session-registrar";
import type { FileStore } from "./store";

/** A pass stops reading after this long and keeps what it has: a big log catches up over several passes. */
export const PASS_BUDGET_MS = 30_000;
/** Room kept free for the mark that says events were left out. */
const MARKER_RESERVE = 320;
const TAIL_BYTES = 64;
/** The newest sessions of the hook index that are looked at. */
const INDEX_SESSIONS = 20;
const INDEX_BYTES = 1024 * 1024;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ID_OK = /^[A-Za-z0-9._:-]{1,200}$/;
/** A line of the hook index as far as it is used here. */
const INDEX_LINE = z.object({
  session_id: z.string().max(200),
  agent: z.string().max(100),
  transcript_path: z.string().max(4096).optional(),
});
/** Streams kept in memory; the oldest go first. */
const MEMO_CAP = 16;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface AgentLogRun {
  readonly runId: string;
  state(): Promise<RunState>;
  apply(event: RunEvent): Promise<{ ok: boolean; noop?: boolean }>;
  /** Where the run works when that is not the project root. */
  workdir(): Promise<string | undefined>;
}

export interface AgentLogWriterOptions {
  store: FileStore;
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

export interface CaptureInput {
  /** Who asks: the ticker, or the end of the step `step`. */
  why: "tick" | "step";
  /** How long to wait for the lock on copying; `0` skips the pass if it is held. */
  waitMs: number;
  /** For `step`: the step being completed, which must be the one the run is at. */
  step?: { node: string; attempt: number };
}

export interface CaptureResult {
  /** The pass did not run, and why. `tick_cap`: the timer has used the copies it may journal. */
  skipped?: "disabled" | "not_running" | "no_step" | "in_flight" | "busy" | "tick_cap";
  /** Something unexpected went wrong (the state could not be read, say): the timer gives up after a few in a row. */
  errored?: true;
  /** Events journaled as saved, and the streams that got some. */
  saved: number;
  streams: string[];
  /** The reasons a stream could not be copied in this pass. */
  failures: AgentLogFailure[];
}

/** What is kept in memory between passes for one stored stream (a session, or a subagent of it). */
interface StreamMemo {
  path: string;
  /** Where the run begins in the log: `null` when the log has no call of this run (yet). */
  start?: { offset: number; ts?: string } | null;
  /** The size of the log when `start` was last looked for, so a log that did not grow is not searched again. */
  searchedSize?: number;
  checkpoint?: ReadCheckpoint;
  /** The hash of the 64 bytes of the log before `checkpoint.offset`: what the checkpoint was made against. */
  sourceTail?: string;
  /** The `last_seq` the journal had for this stream when this process last wrote it. */
  journaledSeq: number;
  stopped?: AgentLogFailure;
}

interface Candidate {
  session: string;
  path: string | undefined;
  /** The log is in the agent's store by name but leads out of it (a link): it is not opened. */
  refused?: true;
}

/** The hash of the 64 bytes of a file that end at `offset`, or `undefined` if the file is shorter. */
async function sourceTailHash(path: string, offset: number): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    if ((await handle.stat()).size < offset) return undefined;
    const size = Math.min(TAIL_BYTES, offset);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, offset - size);
    return createHash("sha256").update(buffer).digest("hex");
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** An id that is not plainly an identifier, or that redaction would change, becomes a stable stand-in. */
export function pseudonymise<E extends HistoryEvent>(
  event: E,
  runId: string,
  rules: readonly RedactRule[] = [],
): E {
  const copy: Record<string, unknown> = { ...event };
  for (const field of ID_FIELDS) {
    const value = copy[field];
    if (typeof value !== "string") continue;
    if (!ID_OK.test(value) || redactText(value, [...rules]) !== value) {
      copy[field] = `id-${sha256(`${value}|${runId}`).slice(0, 16)}`;
    }
  }
  return copy as E;
}

/** What identifies an event without any of its text: a changed log is told from a re-read one by this. */
export function eventKey(event: HistoryEvent, runId: string): string {
  const ids = ID_FIELDS.map((field) => (event as unknown as Record<string, unknown>)[field] ?? "");
  return sha256([event.ts, event.kind, ...ids, runId].join("|"));
}

export class AgentLogWriter {
  private readonly now: () => number;
  private readonly budgetMs: number;
  private readonly memos = new Map<string, StreamMemo>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly collectors = new Map<string, AgentHistoryCollector>();

  constructor(private readonly options: AgentLogWriterOptions) {
    this.now = options.now ?? Date.now;
    this.budgetMs = options.budgetMs ?? PASS_BUDGET_MS;
  }

  /** Let go of what is kept for a run that has ended. */
  forget(runId: string): void {
    for (const key of [...this.memos.keys()])
      if (key.startsWith(`${runId}|`)) this.memos.delete(key);
  }

  /** Whether a pass of this run is going on in this process. */
  busy(runId: string): boolean {
    return this.inFlight.has(runId);
  }

  /** Whether the environment or the hook index names a session at all: with none, there is nothing to copy. */
  async hasCandidates(): Promise<boolean> {
    const own = cleanExecutorText(this.options.env()[SESSION_ENV]);
    if (own !== undefined && SAFE_SESSION.test(own)) return true;
    return (await this.indexSessions()).size > 0;
  }

  /** Waits until no pass of this run is going on in this process. */
  async idle(runId: string): Promise<void> {
    for (
      let running = this.inFlight.get(runId);
      running !== undefined;
      running = this.inFlight.get(runId)
    ) {
      await running.catch(() => undefined);
    }
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

  private memo(runId: string, session: string, path: string): StreamMemo {
    const key = `${runId}|${session}`;
    let found = this.memos.get(key);
    if (found === undefined || found.path !== path) found = { path, journaledSeq: 0 };
    // The map keeps the order of use, so that what is dropped when it is full is what was used longest ago.
    this.memos.delete(key);
    this.memos.set(key, found);
    if (this.memos.size > MEMO_CAP) {
      const oldest = this.memos.keys().next().value;
      if (oldest !== undefined) this.memos.delete(oldest);
    }
    return found;
  }

  /**
   * One pass. Never throws: a copy is display data and must not fail what asked for it. Returns what happened, for
   * tests and for the ticker.
   */
  async capture(run: AgentLogRun, input: CaptureInput): Promise<CaptureResult> {
    const result: CaptureResult = { saved: 0, streams: [], failures: [] };
    // The timer gives way to a pass that is going on; the end of a step waits for it, since that copy must be made.
    if (this.inFlight.has(run.runId)) {
      if (input.why === "tick") return { ...result, skipped: "in_flight" };
      await this.idle(run.runId);
    }
    const work = this.run(run, input, result);
    this.inFlight.set(run.runId, work);
    try {
      return await work;
    } finally {
      if (this.inFlight.get(run.runId) === work) this.inFlight.delete(run.runId);
    }
  }

  private async run(
    run: AgentLogRun,
    input: CaptureInput,
    result: CaptureResult,
  ): Promise<CaptureResult> {
    try {
      const state = await run.state();
      const skipped = this.shouldSkip(state, input);
      if (skipped !== undefined) return { ...result, skipped };
      try {
        return await this.options.store.withAgentLogLock(run.runId, input.waitMs, (lock) =>
          this.pass(run, input, lock, result),
        );
      } catch (error) {
        if (error instanceof KodelError && error.code === "STATE_LOCKED") {
          return { ...result, skipped: "busy" };
        }
        // A store that fails at the end of a step is told once; the timer tells it after three ticks that fail.
        if (input.why === "step") await this.fail(run, result, "unreadable");
        return { ...result, errored: true };
      }
    } catch {
      return { ...result, errored: true };
    }
  }

  private shouldSkip(state: RunState, input: CaptureInput): CaptureResult["skipped"] | undefined {
    if (state.status !== "running") return "not_running";
    const config = state.history?.agent_log;
    if (state.agentLog === undefined || config?.enabled !== true) return "disabled";
    if (input.why === "tick" && state.agentLog.ticks >= MAX_AGENT_LOG_TICKS) return "tick_cap";
    if (input.why === "step") {
      const visit = state.active.find(
        (v) => v.node === input.step?.node && v.attempt === input.step.attempt,
      );
      if (visit === undefined || visit.phase !== "agent") return "no_step";
    }
    return undefined;
  }

  private async pass(
    run: AgentLogRun,
    input: CaptureInput,
    lock: { stillHeld(): Promise<boolean> },
    result: CaptureResult,
  ): Promise<CaptureResult> {
    const started = this.now();
    const state = await run.state();
    const skipped = this.shouldSkip(state, input);
    if (skipped !== undefined) return { ...result, skipped };
    const config = state.history?.agent_log as AgentLogConfig;
    const env = this.options.env();
    const configDir = claudeConfigDir(env);
    const collector = this.collector(configDir);
    const workdir = await run.workdir();
    const node = this.nodeOf(state, input);

    const candidates = await this.candidates(env, configDir, workdir);
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
      const memo = this.memo(run.runId, candidate.session, candidate.path);
      if (memo.stopped !== undefined) {
        proven += 1;
        continue;
      }
      if (!(await this.prove(run.runId, memo))) continue;
      proven += 1;
      const ctx: PassContext = {
        run,
        input,
        lock,
        config,
        collector,
        workdir,
        node,
        started,
        toolLog: state.history?.tool_log.enabled !== false,
        result,
      };
      const main = await this.copy(ctx, candidate.session, undefined, memo);
      if (main === "abort") return result;
      if (!ctx.toolLog) continue;
      for (const log of await subagentLogs(candidate.path, candidate.session)) {
        const id = basename(log, ".jsonl");
        if (!SAFE_SESSION.test(id)) continue;
        const childMemo = this.memo(run.runId, id, log);
        if (childMemo.stopped !== undefined) continue;
        if (childMemo.start === undefined) {
          const born = await firstTimestamp(log);
          const from = memo.start?.ts;
          // A subagent that began before the run's first call belongs to what came before.
          if (born === undefined || (from !== undefined && born < from)) continue;
          childMemo.start = { offset: 0 };
        }
        if ((await this.copy(ctx, id, candidate.session, childMemo)) === "abort") return result;
      }
    }
    if (proven === 0) {
      // Nothing to copy is only a failure at the end of a step: before the agent has had a turn there is no log yet.
      if (input.why === "step") {
        await this.fail(run, result, missing ? "log_missing" : "session_unknown");
      }
    }
    return result;
  }

  private nodeOf(state: RunState, input: CaptureInput): { node: string; attempt: number } {
    if (input.step !== undefined) return input.step;
    const visit = state.active[0];
    if (visit !== undefined) return { node: visit.node, attempt: visit.attempt };
    const last = state.trail[state.trail.length - 1] ?? "";
    return { node: last, attempt: state.nodes[last]?.attempt ?? 0 };
  }

  /** Whether the log has a call of this run, and where the run begins in it. */
  private async prove(runId: string, memo: StreamMemo): Promise<boolean> {
    if (memo.start) return true;
    let size: number;
    try {
      size = (await stat(memo.path)).size;
    } catch {
      return false;
    }
    if (memo.start === null && memo.searchedSize === size) return false;
    memo.searchedSize = size;
    memo.start = (await findRunStart(memo.path, runId)) ?? null;
    return memo.start !== null;
  }

  /** The sessions to look at: the environment's, and the newest of the hook index. */
  private async candidates(
    env: NodeJS.ProcessEnv,
    configDir: string,
    workdir: string | undefined,
  ): Promise<Candidate[]> {
    const store = join(configDir, "projects");
    const realStore = await realOrSelf(store);
    const dirs = [...(workdir === undefined ? [] : [workdir]), this.options.root];
    const wanted = new Map<string, string | undefined>();
    const own = cleanExecutorText(env[SESSION_ENV]);
    if (own !== undefined && SAFE_SESSION.test(own)) wanted.set(own, undefined);
    for (const [session, transcript] of await this.indexSessions()) {
      if (!wanted.has(session) || wanted.get(session) === undefined)
        wanted.set(session, transcript);
    }
    const found: Candidate[] = [];
    for (const [session, transcript] of wanted) {
      let path: string | undefined;
      // A path from a hook is not trusted to point anywhere but at the agent's own store.
      if (transcript !== undefined && isInside(realStore, await realOrSelf(transcript)))
        path = transcript;
      path ??= await findSessionLog(store, dirs, session);
      // Not even to look for the run in it: a link in the store to a file elsewhere is not a session log.
      if (path !== undefined && !isInside(realStore, await realOrSelf(path))) {
        found.push({ session, path: undefined, refused: true });
        continue;
      }
      found.push({ session, path });
    }
    return found;
  }

  private async indexSessions(): Promise<Map<string, string | undefined>> {
    const out = new Map<string, string | undefined>();
    let text: string;
    try {
      text = await readFile(join(this.options.root, SESSIONS_INDEX), "utf8");
    } catch {
      return out;
    }
    const lines =
      text.length > INDEX_BYTES ? text.slice(-INDEX_BYTES).split("\n").slice(1) : text.split("\n");
    for (const line of lines.reverse()) {
      if (out.size >= INDEX_SESSIONS) break;
      let parsed: ReturnType<typeof INDEX_LINE.safeParse>;
      try {
        parsed = INDEX_LINE.safeParse(JSON.parse(line));
      } catch {
        continue;
      }
      // The index is written by hooks of an agent: only what is plainly a session of this agent is believed.
      if (
        !parsed.success ||
        parsed.data.agent !== AGENT_ID ||
        !SAFE_SESSION.test(parsed.data.session_id)
      ) {
        continue;
      }
      if (!out.has(parsed.data.session_id))
        out.set(parsed.data.session_id, parsed.data.transcript_path);
    }
    return out;
  }

  private async fail(
    run: AgentLogRun,
    result: CaptureResult,
    reason: AgentLogFailure,
    session?: string,
  ): Promise<void> {
    if (!result.failures.includes(reason)) result.failures.push(reason);
    try {
      await run.apply({
        type: "agent_log_failed",
        reason,
        ...(session === undefined ? {} : { session }),
      });
    } catch {
      // the account of a failure is not worth a failure
    }
  }

  /**
   * Copy what is new in one stream. `"abort"` means the pass must stop (the lock is no longer ours, or the run
   * went away); anything else is a result for this stream alone.
   */
  private async copy(
    ctx: PassContext,
    session: string,
    parent: string | undefined,
    memo: StreamMemo,
  ): Promise<"done" | "abort"> {
    const { run, config, collector, lock } = ctx;
    const store = this.options.store;
    const state = await run.state();
    if (state.status !== "running" || state.agentLog === undefined) return "abort";
    const stored = state.agentLog.sessions[session];
    const journaled = stored?.last_seq ?? 0;

    // A checkpoint is good only for the stream the journal says we left: after another process wrote, or after the
    // log itself changed under us, the pass starts again from the beginning and takes what is newer than the journal.
    let resume = memo.checkpoint;
    if (resume !== undefined) {
      const same =
        memo.journaledSeq === journaled &&
        memo.sourceTail !== undefined &&
        (await sourceTailHash(memo.path, resume.offset)) === memo.sourceTail;
      if (!same) resume = undefined;
    }
    // Starting again from the beginning also forgets what the collector remembered about where the project is.
    if (resume === undefined && journaled > 0) this.collectors.clear();
    // The checkpoint is the collector's live state, and a pass that reads moves it. It is taken here and given back
    // only when the pass ends well: a pass that fails after reading leaves none, so the next one starts from the
    // journal and takes what this one read but never stored.
    memo.checkpoint = undefined;
    let journaledNow = journaled;
    const start = memo.start;
    if (resume === undefined && (start === undefined || start === null)) return "done";

    const capture: CaptureOptions = {
      skipIds: true,
      rules: [...this.options.rules],
      ...(config.mode === "metadata"
        ? { metadata: true }
        : { keepLineBreaks: true, caps: { ...config.preview_chars, detail: 500 } }),
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

    const room = agentLogRoom(state, config, ctx.node);
    const lines: string[] = [];
    let kept = 0;
    let firstSeq: number | undefined;
    let entries = 0;
    let dropped = 0;
    let lastDropped: HistoryEvent | undefined;
    let lastSeen: HistoryEvent | undefined;
    let sawJournaled = journaled === 0 || resume !== undefined;
    let changed = false;

    try {
      for await (const raw of collector.read(ref, undefined, {
        capture,
        holdBack: true,
        ...(resume === undefined ? { fromOffset: start?.offset ?? 0 } : { resume }),
        checkpoint: holder,
        shouldStop,
        extraWorkdirs: ctx.workdir === undefined ? [] : [ctx.workdir],
      })) {
        // What is stored has its ids made safe by every rule the host has; what tells a changed log from a re-read one
        // is made with the built-in ones only, so that a rule added or removed during the run does not look like one.
        const event = pseudonymise(raw, run.runId, this.options.rules);
        if (raw.seq <= journaled) {
          if (raw.seq === journaled) {
            sawJournaled = true;
            if (
              stored !== undefined &&
              eventKey(pseudonymise(raw, run.runId), run.runId) !== stored.last_key
            ) {
              changed = true;
              break;
            }
          }
          continue;
        }
        lastSeen = raw;
        if (
          !ctx.toolLog &&
          (event.kind === "tool_call" || event.kind === "tool_result" || event.kind === "subagent")
        ) {
          continue;
        }
        const line = store.agentLogLines([event]);
        const size = Buffer.byteLength(line);
        if (kept + size <= room - MARKER_RESERVE) {
          lines.push(line);
          kept += size;
          entries += 1;
          firstSeq ??= event.seq;
        } else {
          dropped += 1;
          lastDropped = event;
        }
      }
    } catch (error) {
      memo.checkpoint = undefined;
      const code = error instanceof KodelError ? error.code : undefined;
      if (code === "HISTORY_PATH_OUTSIDE_PROJECT") {
        // Not stopped for good: whether a log is the project's depends on directories that can come and go.
        await this.fail(run, ctx.result, "refused", session);
      } else if (code === "HISTORY_SESSION_UNREADABLE") {
        await this.fail(run, ctx.result, "log_missing", session);
      } else {
        await this.fail(run, ctx.result, "unreadable", session);
      }
      return "done";
    }

    const endSeq = holder.value?.seq ?? 0;
    if (changed || (!sawJournaled && !stoppedEarly && endSeq < journaled)) {
      memo.checkpoint = undefined;
      memo.stopped = "log_changed";
      await this.fail(run, ctx.result, "log_changed", session);
      return "done";
    }

    let marker = "";
    // Events left out are counted also when there is no room even for the mark that says so.
    if (dropped > 0 && lastDropped !== undefined) firstSeq ??= lastDropped.seq;
    if (dropped > 0 && lastDropped !== undefined && room >= MARKER_RESERVE) {
      marker = store.agentLogLines([
        {
          v: HISTORY_FORMAT,
          agent: lastDropped.agent,
          agent_version: lastDropped.agent_version,
          session_id: lastDropped.session_id,
          ...(lastDropped.parent_session_id === undefined
            ? {}
            : { parent_session_id: lastDropped.parent_session_id }),
          seq: lastDropped.seq,
          ts: lastDropped.ts,
          kind: "system",
          subtype: "agent_log_cut",
          detail: `${dropped} event(s) left out`,
        } satisfies HistoryEvent,
      ]);
      entries += 1;
    }

    if (lastSeen !== undefined && firstSeq !== undefined) {
      const text = lines.join("") + marker;
      if (!(await lock.stillHeld())) return "abort";
      const expect = {
        length: stored?.length ?? 0,
        ...(stored === undefined ? {} : { tail_hash: stored.tail_hash }),
      };
      const appended = await store.appendAgentLog(run.runId, session, expect, text);
      if (!appended.ok) {
        memo.checkpoint = undefined;
        memo.stopped = "stored_copy_changed";
        await this.fail(run, ctx.result, "stored_copy_changed", session);
        return "done";
      }
      if (!(await lock.stillHeld())) return "abort";
      const decision = await run.apply({
        type: "agent_log_saved",
        why: ctx.input.why,
        session,
        ...(parent === undefined ? {} : { parent }),
        node: ctx.node.node,
        attempt: ctx.node.attempt,
        first_seq: firstSeq,
        last_seq: lastSeen.seq,
        stream_from: expect.length,
        stream_to: appended.length,
        tail_hash: appended.tail_hash,
        last_key: eventKey(pseudonymise(lastSeen, run.runId), run.runId),
        entries,
        ...(dropped > 0 ? { cut: dropped } : {}),
      });
      if (!decision.ok || decision.noop === true) {
        // The journal did not take it (the run moved on, or somebody else wrote): start from the journal next time.
        memo.checkpoint = undefined;
        return "abort";
      }
      journaledNow = lastSeen.seq;
      ctx.result.saved += 1;
      ctx.result.streams.push(session);
    }
    if (holder.value !== undefined) {
      memo.checkpoint = holder.value;
      memo.sourceTail = await sourceTailHash(memo.path, holder.value.offset);
      // What the journal has for this stream as of this pass: the checkpoint is good for exactly that.
      memo.journaledSeq = journaledNow;
    }
    return "done";
  }
}

/**
 * How many bytes a visit of a step may still store: the share of its node among the nodes the run started with (the
 * part of the bound up to the node, less what the other visits used, so that nodes that never copy pass their share on),
 * less what this visit has stored already, and never more than what is left of the bound. A step that comes again (a
 * loop, a retry) is a visit of its own and may use the share of its node again; the passes of one visit share one
 * allowance, so a timer cannot spend a step's share and then the next. A node the run did not start with (one a change
 * of the pipeline added) may use what is left. Nothing here looks at what kind of node it is.
 */
export function agentLogRoom(
  state: Pick<RunState, "agentLog">,
  config: Pick<AgentLogConfig, "max_kb">,
  at: { node: string; attempt?: number },
): number {
  const log = state.agentLog;
  const total = config.max_kb * 1024;
  const used = log?.bytes ?? 0;
  const nodes = log?.nodes ?? [];
  const mine = log?.visits?.[`${at.node}:${at.attempt ?? 0}`] ?? 0;
  const others = Math.max(0, used - mine);
  const index = nodes.indexOf(at.node);
  const own = Math.floor(total / Math.max(1, nodes.length));
  const budget =
    index < 0
      ? total - others
      : Math.max(Math.floor((total * (index + 1)) / nodes.length) - others, own);
  return Math.max(0, Math.min(total - used, budget - mine));
}

/** What a stored stream holds, and what is wrong with it if something is. */
export type StoredAgentLog =
  | { ok: true; events: HistoryEvent[] }
  | {
      ok: false;
      /**
       * `format`: a line written in a format this reader does not know (it says which). `damaged`: a line that is not
       * an event of any format. A stored stream has no hash, so "modified" is never what is told.
       */
      problem: "format" | "damaged" | "missing";
      detail: string;
      events: HistoryEvent[];
    };

/**
 * The events of a stored stream, up to the length the journal vouches for and not a byte further: what comes after is
 * a pass that never reached the journal, which is neither damage nor change.
 */
export async function readStoredAgentLog(
  store: FileStore,
  runId: string,
  session: string,
  length: number,
): Promise<StoredAgentLog> {
  const text = await store.readAgentLog(runId, session, length);
  if (text === undefined)
    return { ok: false, problem: "missing", detail: "no stored stream", events: [] };
  const events: HistoryEvent[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return { ok: false, problem: "damaged", detail: `line ${i + 1} is not JSON`, events };
    }
    const version = (value as { v?: unknown } | null)?.v;
    if (version !== HISTORY_FORMAT) {
      return typeof version === "number" && Number.isInteger(version) && version > HISTORY_FORMAT
        ? {
            ok: false,
            problem: "format",
            detail: `written in format ${version}, upgrade kodel`,
            events,
          }
        : { ok: false, problem: "damaged", detail: `line ${i + 1} has no format`, events };
    }
    const parsed = historyEventSchema.safeParse(value);
    if (!parsed.success) {
      return { ok: false, problem: "damaged", detail: `line ${i + 1} is not an event`, events };
    }
    events.push(parsed.data);
  }
  return { ok: true, events };
}

interface PassContext {
  run: AgentLogRun;
  input: CaptureInput;
  lock: { stillHeld(): Promise<boolean> };
  config: AgentLogConfig;
  collector: AgentHistoryCollector;
  workdir: string | undefined;
  node: { node: string; attempt: number };
  started: number;
  toolLog: boolean;
  result: CaptureResult;
}
