/**
 * The run state machine: `decide(spec, state, event, now)` returns the next state, the effects a
 * host must carry out, and the journal records to append. It is pure: no clock, file, process or
 * network access, so every host (local CLI, server) runs the same rules.
 *
 * Vocabulary: a node is *entered* (a visit, from the start or from another node); each go at it is
 * an *attempt*. A failed attempt of an agent node with no edge for its label is retried as a new
 * attempt of the same visit (rework). Limits: `max_consecutive_failures` and `max_attempts`.
 */
import { canonicalNode, checkIdOf, type NodeForms, stableJson } from "./canonical";
import { type ChangesRef, changesField, isTreeId, MAX_CHANGES_ERROR } from "./changes";
import { type ErrorCode, KodelError } from "./errors";
import type { EngineRecord, ExecutorRecord } from "./executor";
import type { HistoryConfig } from "./history-config";
import type { NodeSpec, PipelineSpec } from "./pipeline";
import { diffPipelines } from "./pipeline-diff";
import { defaultRegistry, type Registry } from "./registry";
import { renderContextOf, renderDeep, renderTemplate } from "./render";
import { runSlug } from "./slug";
import {
  addDelta,
  MAX_USAGE_ATTEMPTS,
  MAX_USAGE_EVENTS,
  newTotals,
  newUsageState,
  USAGE_FAILURES,
  type UsageCursor,
  type UsageDelta,
  type UsageFailure,
  type UsageState,
  usageCursorSchema,
  usageDeltaSchema,
} from "./usage-record";

export const DEFAULT_STALE_MS = 30_000;
export const DEFAULT_MAX_RESTARTS = 3;
/** How many times work may be taken over from a process known to be gone before the run pauses. */
export const MAX_TAKEOVERS = 10;

export interface EngineOptions {
  registry?: Registry;
  /** How long engine work may go without a heartbeat before it counts as interrupted. */
  staleMs?: number;
  /** How many times interrupted work is restarted before the run pauses. */
  maxRestarts?: number;
  /**
   * Turns the canonical form of a node (`canonicalNode`) into a short stable string. The core does not
   * hash anything itself; without this the journal simply carries no node hashes.
   */
  fingerprint?: (text: string) => string;
}

// ── state ───────────────────────────────────────────────────────────────────

export type RunStatus = "running" | "paused" | "completed" | "failed" | "canceled";
export type NodeStatus =
  | "pending"
  | "running"
  | "waiting"
  | "rework"
  | "passed"
  | "failed"
  | "skipped";

export interface Feedback {
  /** Where the failure came from: `command`, `human` or `check:<kind>`. */
  source: string;
  reason: string;
  /** The node that failed, when the failure was handed to a different node along an edge. */
  from?: string;
  /** The id of the check that failed (`checkIdOf`), when a check did. */
  check_id?: string;
}

/**
 * What git says about the run's directory when the run ends, read by the host: the core reads no
 * file system. Each field is left out when it could not be read.
 */
export interface RunFacts {
  head?: string;
  /** The commits made during the run: those reachable from HEAD first, then amended or reset away ones. */
  commits?: string[];
  /** There were more commits than `commits` holds. */
  commitsTruncated?: boolean;
}

export interface NodeRun {
  slug: string;
  status: NodeStatus;
  /** The label of the last finished attempt. */
  outcome: string | null;
  /** The number of the current or last attempt; 0 until the node is first entered. */
  attempt: number;
  consecutiveFailures: number;
  /** Attempts granted by `resume` on top of `max_attempts`. */
  extraAttempts: number;
  /** The current visit (entry into the node from the start or from another node). */
  visitId: number;
  lastFailure?: Feedback;
  /** The node is no longer in the pipeline; its attempts stay in the history. */
  removed?: boolean;
}

export type Phase = "agent" | "engine" | "checks" | "human";

/** An attempt that is in progress. The state holds a set of them (one at a time in the MVP). */
export interface Visit {
  node: string;
  attempt: number;
  visitId: number;
  phase: Phase;
  /** Which check is running, in the `checks` phase. */
  checkIndex: number;
  /** Last sign of life of the process running engine work. */
  heartbeatAt?: number;
  /** Who is running the engine work (a process id, as the host names it); see `tick`. */
  owner?: string;
  /**
   * The outcome the agent said the step ends with, when it is not the usual one. It is only a claim:
   * it is used as the label once the node's checks have all passed, and not before.
   */
  declared?: string;
  restarts: number;
  /** How many times the work was taken over from a process known to be gone. */
  takeovers?: number;
  /** Engine work that was restarted too often; waits for `resume`. */
  suspended?: boolean;
  startedAt: number;
}

export interface BlockedRoute {
  from: string;
  label: string;
  to: string;
  rework: boolean;
  /** Why the node before failed, handed to the node this route enters (a rejection, a red build). */
  feedback?: Feedback;
}

export interface Pause {
  reason: "consecutive" | "total" | "restarts";
  /** The node whose limit was hit (the one `resume` gives a fresh budget). */
  node: string;
  blocked?: BlockedRoute;
}

export interface RunState {
  v: 1;
  runId: string;
  task: string;
  /**
   * The run's name for `{{run.slug}}`: a label that is not unique (the id is the identity). Runs
   * from before it existed have none, and read as the name their task text would have given.
   */
  slug?: string;
  /** The key of the task this run was started for; absent for a run that is not tied to one. */
  taskKey?: string;
  /** Hash of the pipeline spec this run started with. */
  specHash: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  nodes: Record<string, NodeRun>;
  active: Visit[];
  /** Nodes entered, in order (rework inside a visit adds nothing). */
  trail: string[];
  pause?: Pause;
  nextVisitId: number;
  /** Sequence number of the last journal record. */
  seq: number;
  /** How many refused calls were journaled; there is a limit (`MAX_LOGGED_REFUSALS`). */
  refusals?: number;
  /** How many proposals to change the pipeline were journaled; there is a limit. */
  proposals?: number;
  /**
   * Where the host runs this run's commands, when not in the repository root; opaque to the core.
   * It lives in the state, which the host checks against its trusted hash, because a command must
   * never be run somewhere a file the agent can write has sent it.
   */
  workdir?: string;
  /**
   * The pipeline file of this run, relative to the repository root. Like `workdir` it lives in the
   * state and not in `meta.json`, which an agent can write.
   */
  pipelineFile?: string;
  /** The `history` settings the run was started with. */
  history?: HistoryConfig;
  /** The version of the engine that started the run; a later record from another one says so. */
  engineVersion?: string;
  /**
   * What the agent was shown, per `node:attempt`: a short hash of each answer-and-client already
   * kept (never the client or the session themselves: the state is not redacted). Present only for a
   * run that records prompts, so its absence says "not collected".
   */
  served?: Record<string, string[]>;
  /** How many `step_served` and `served_write_failed` events were journaled; there is a limit. */
  servedEvents?: number;
  /**
   * The agent's conversation log of the run (`agent_log/`): where each stored stream ends and how much was
   * stored. Present only for a run started with `history.agent_log` on, so its absence says "not captured". Holds
   * numbers, ids and hex hashes, never text: the state is not redacted.
   */
  agentLog?: AgentLogState;
  /**
   * What the agent used, per attempt and for the run, summed from the records a pass of the host appended
   * (`usage_recorded`). Present only for a run started with `history.usage` on, so its absence says "not captured".
   * Holds numbers, safe ids and hex hashes, never text: the state is not redacted. Information only: nothing here
   * feeds a check, a route or a gate.
   */
  usage?: UsageState;
}

/** Where the stored stream of one session ends, and what the journal vouches for. */
export interface AgentLogSessionState {
  last_seq: number;
  /** The length of the stored stream in bytes: where the next append goes. Bytes past it are not stored. */
  length: number;
  /** sha256 (lowercase hex) of the last 64 bytes of the stored stream at `length`. */
  tail_hash: string;
  /** sha256 of what identifies the event at `last_seq`; a different one means the log itself changed. */
  last_key: string;
  entries: number;
}

export interface AgentLogState {
  /** The nodes of the pipeline the run started with, in order: the share of each step is cut from them. */
  nodes: string[];
  sessions: Record<string, AgentLogSessionState>;
  /** Events journaled by the ticker and by the end of a step; each has a limit. */
  ticks: number;
  steps: number;
  /** Bytes stored by all sessions, and the events left out for want of room. */
  bytes: number;
  cut: number;
  /** The reasons already journaled as a failure: a reason is journaled once. */
  failed: string[];
  /** Set when the run ends: the steps of the agent (`node:attempt`) that were still going. */
  endedInStep?: string[];
  /**
   * Bytes stored per visit of a step (`node:attempt`), so that a step that goes on over many copies is held to
   * its share and a step that comes again is told from it. Runs from before this have none. Bounded.
   */
  visits?: Record<string, number>;
}

/** How many visits are told apart in the account of the bytes; beyond it a visit counts only in the total. */
export const MAX_AGENT_LOG_VISITS = 2_000;

/** How many refused calls a run journals: enough to see what was tried, too few to be a way to fill the disk. */
export const MAX_LOGGED_REFUSALS = 100;

/** How many proposals to change the pipeline a run journals. */
export const MAX_LOGGED_PROPOSALS = 100;

/** How many different answers of one attempt are kept: one per client, so a loop cannot fill the disk. */
export const MAX_SERVED_PER_ATTEMPT = 20;

/** How many `step_served` and `served_write_failed` events a run journals. */
export const MAX_SERVED_EVENTS = 500;

/** How many copies of the agent's log a run journals from the ticker, and from the ends of steps. */
export const MAX_AGENT_LOG_TICKS = 4_000;
export const MAX_AGENT_LOG_STEPS = 1_000;

/** Why a copy of the agent's log was not made; each is journaled once per run. */
export const AGENT_LOG_FAILURES = [
  "session_unknown",
  "log_missing",
  "refused",
  "log_changed",
  "stored_copy_changed",
  "tick_cap",
  "unreadable",
] as const;
export type AgentLogFailure = (typeof AGENT_LOG_FAILURES)[number];

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// ── events in, effects out ──────────────────────────────────────────────────

/**
 * A decision that a person would make, made by the agent because the project's config allows it and
 * the person told it to. The engine cannot check that; it keeps the words the agent says it was given.
 */
export interface AgentDecision {
  instruction: string;
}

/** The journal fields that mark a decision as the agent's; a person's decision has none. */
const decidedBy = (by: AgentDecision | undefined): Record<string, unknown> =>
  by === undefined ? {} : { decided_by: "agent", instruction: by.instruction };

/** A file in the run folder that holds what a command printed; `bytes` counts what is stored. */
export interface OutputRef {
  ref: string;
  bytes: number;
  truncated: boolean;
}

export type RunEvent =
  | {
      type: "start";
      runId: string;
      task: string;
      /** The run's slug, already validated by the host; absent: made from the task text. */
      slug?: string;
      specHash: string;
      /** Where the host runs this run's commands, when not in the repository root. Opaque to the core. */
      workdir?: string;
      /** The branch the host made for the run, when it made one. */
      branch?: string;
      /** The pipeline file, relative to the repository root, when the pipeline was read from one. */
      pipelineFile?: string;
      /** The task the run was started for (its key as the tracker resolved it). */
      taskKey?: string;
      /** The effective `history` settings, fixed for the run. */
      history?: HistoryConfig;
      /** The engine that serves the run; the host leaves it out when `history.executor` is off. */
      engine?: EngineRecord;
      /** Who started the run; same rule as `engine`. */
      executor?: ExecutorRecord;
      /** The commit the run's work began at; absent without a repository or a commit. */
      baseCommit?: string;
    }
  | {
      type: "agent_completed";
      node: string;
      attempt: number;
      summary?: string;
      /** Who completed the step, and the version of the engine if it is not the one that began the run. */
      executor?: ExecutorRecord;
      engineVersion?: string;
      /** One of the node's other outcomes (`outcomes:`), instead of the usual `passed`. */
      outcome?: string;
      /** HEAD of the run's directory when the step was handed in, as the host read it. */
      head?: string;
      /** The patch of the work since the previous hand-in, when the host kept one (`history.changes`). */
      changes?: ChangesRef;
      /** Why there is no patch, when the host tried and could not. */
      changesError?: string;
      /** The work tree at this hand-in; the next hand-in's patch starts there. */
      tree?: string;
    }
  /** The engine work of a node (its own command) finished. The host judged the exit code. */
  | {
      type: "work_finished";
      node: string;
      attempt: number;
      passed: boolean;
      reason: string;
      /** What the command exited with and how long it ran, for the journal. */
      exit?: number;
      duration_ms?: number;
      /** Where the host kept what the command printed, or why it could not. */
      output?: OutputRef;
      output_error?: string;
      /** The pipeline version the work ran under; a result of another version is dropped. */
      specHash?: string;
    }
  | {
      type: "check_finished";
      node: string;
      attempt: number;
      index: number;
      passed: boolean;
      reason: string;
      exit?: number;
      duration_ms?: number;
      /** For a check that ran a command: its text, and where the host kept what it printed. */
      command?: string;
      output?: OutputRef;
      output_error?: string;
      /** The pipeline version the check ran under; a result of another version is dropped. */
      specHash?: string;
    }
  /**
   * A person accepted another version of the pipeline for this run. The event is decided with the
   * new pipeline (`decide`'s first argument); `before` is the one the run was on.
   */
  | {
      type: "pipeline_accepted";
      from: string;
      to: string;
      /** Where the new version came from: the agent's proposal or an edit of the file. */
      source: "proposal" | "file";
      before: PipelineSpec;
      reason?: string;
      byAgent?: AgentDecision;
    }
  /** The host accepted the agent's report of findings. Journaled; it changes nothing else. */
  | {
      type: "report_accepted";
      node: string;
      attempt: number;
      completeness: string;
      rows: number;
    }
  /**
   * A call of the agent was refused (the engine said no). Journaled, up to a limit, so that what was
   * tried can be looked at afterwards; it changes nothing else.
   */
  | {
      type: "call_refused";
      about: string;
      node?: string;
      attempt?: number;
      code: string;
      message: string;
    }
  | {
      type: "human_decided";
      node: string;
      decision: "approved" | "rejected";
      reason?: string;
      byAgent?: AgentDecision;
    }
  | { type: "heartbeat"; node: string; attempt: number; owner?: string }
  /** The agent noticed a problem in a step description. Journaled; it never changes the run. */
  | {
      type: "feedback";
      node?: string;
      attempt?: number;
      category: string;
      message: string;
      suggestion?: string;
      /** The `check_id` of the check the note is about (`wrong_check` only). */
      check?: string;
    }
  /**
   * The agent proposed another version of the pipeline (`withdrawn`: took its proposal back).
   * Journaled; changes nothing else: only a person's `pipeline_accepted` moves the run.
   */
  | { type: "change_proposed"; hash: string; summary: string; withdrawn?: boolean }
  /**
   * The agent was handed the step of this attempt. `key` is a short hash of the answer and the client
   * (the host builds it); the machine decides whether it is new, and gives it a number and a file name.
   */
  | {
      type: "step_served";
      node: string;
      attempt: number;
      key: string;
      promptHash: string;
      executor?: ExecutorRecord;
    }
  /** The file of a `step_served` event could not be written. */
  | { type: "served_write_failed"; node: string; attempt: number; n: number; message: string }
  /**
   * Events of the agent's log were appended to the run's `agent_log/<session>.jsonl`. The stream was
   * `stream_from` bytes long before and is `stream_to` now; `first_seq`..`last_seq` are the events appended.
   * `why` is who asked: the ticker or the end of a step.
   */
  | {
      type: "agent_log_saved";
      why: "tick" | "step";
      session: string;
      parent?: string;
      node: string;
      attempt: number;
      first_seq: number;
      last_seq: number;
      stream_from: number;
      stream_to: number;
      tail_hash: string;
      last_key: string;
      entries: number;
      /** Events left out for want of room. */
      cut?: number;
    }
  /** The agent's log could not be copied, for this reason; journaled once per reason. */
  | { type: "agent_log_failed"; reason: AgentLogFailure; session?: string }
  /**
   * What the agent used since the last record of this session, as a delta. With `node` and `attempt` it is credited to
   * that attempt, which must be the agent step the run is at; without them it is use outside every step. `cursor` is
   * where the credited part of the session's log now ends.
   */
  | {
      type: "usage_recorded";
      session: string;
      node?: string;
      attempt?: number;
      delta: UsageDelta;
      cursor: UsageCursor;
    }
  /** Usage could not be recorded, for this reason; journaled once per reason. */
  | { type: "usage_failed"; reason: UsageFailure; session?: string }
  /** A human accepted a change made to the run's files outside kodel. Journaled; changes nothing else. */
  | { type: "acknowledge"; note?: string }
  /**
   * Look for engine work that was interrupted. `deadOwners` are the owners (see `Visit.owner`) the
   * host knows to be gone, so their work restarts at once instead of after `staleMs`.
   */
  | { type: "tick"; deadOwners?: string[] }
  | { type: "resume" }
  | { type: "cancel" }
  /**
   * The patch of the whole run, or why there is none. Applied once the run has finished, like
   * `task_note`; only journaled.
   */
  | { type: "changes_recorded"; changes?: ChangesRef; changesError?: string }
  /** What the tie between the run and its task did (or could not do); only goes to the journal. */
  | {
      type: "task_note";
      what: "linked" | "restarted" | "closed" | "commented" | "hinted" | "failed";
      task: string;
      note?: string;
      /** The task had been done and the person allowed starting it again. */
      restarting?: true;
    };

export type Effect =
  /** Remember the working tree under this key, so a `diff` check can compare against it. */
  | { type: "take_snapshot"; key: string }
  | { type: "need_agent"; node: string; attempt: number; prompt: string }
  | {
      type: "run_command";
      node: string;
      attempt: number;
      command: string;
      expect: { exit: number };
      timeout?: number;
      restart: boolean;
    }
  | {
      type: "run_check";
      node: string;
      attempt: number;
      index: number;
      kind: string;
      params: Record<string, unknown>;
      /** The snapshot key to compare against, for checks that need one. */
      baseline?: string;
      restart: boolean;
    }
  | { type: "await_human"; node: string; attempt: number; prompt: string; instructions?: string };

export interface JournalRecord {
  v: 1;
  seq: number;
  ts: number;
  event: string;
  [field: string]: unknown;
}

export type Decision =
  | { ok: true; state: RunState; effects: Effect[]; journal: JournalRecord[]; noop?: true }
  | { ok: false; error: KodelError };

/** Thrown inside `decide` for a repeat of something that already happened. */
class Repeat extends Error {}

const fail = (code: ErrorCode, message: string) => new KodelError(code, message);

// ── the machine ─────────────────────────────────────────────────────────────

class Machine {
  readonly effects: Effect[] = [];
  readonly journal: JournalRecord[] = [];
  private readonly nodes: Map<string, NodeSpec>;
  private readonly registry: Registry;
  private readonly staleMs: number;
  private readonly maxRestarts: number;
  private readonly fingerprint: ((text: string) => string) | undefined;

  constructor(
    private readonly spec: PipelineSpec,
    readonly s: RunState,
    private readonly now: number,
    options: EngineOptions,
    private readonly facts: RunFacts = {},
  ) {
    this.nodes = new Map(spec.nodes.map((n) => [n.slug, n]));
    this.registry = options.registry ?? defaultRegistry();
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.fingerprint = options.fingerprint;
  }

  // lookups

  private node(slug: string): NodeSpec {
    const node = this.nodes.get(slug);
    if (!node) throw fail("UNKNOWN_NODE", `the pipeline has no node "${slug}"`);
    return node;
  }

  /** A note names a check only as `wrong_check`, and only one of the checks of its node. */
  private checkOfNote(check: string, category: string, slug: string | undefined) {
    if (category !== "wrong_check")
      throw new KodelError("INVALID_ARGUMENTS", "check is only for the category wrong_check", [
        { field: "check" },
      ]);
    if (slug === undefined)
      throw new KodelError(
        "INVALID_ARGUMENTS",
        "check needs node_slug when no single step is running",
        [{ field: "node_slug" }],
      );
    const node = this.node(slug);
    const ids = node.checks.map((_, i) => checkIdOf(node, i));
    if (!ids.includes(check))
      throw new KodelError(
        "INVALID_ARGUMENTS",
        ids.length === 0
          ? `node "${slug}" has no checks`
          : `"${check}" is not a check of node "${slug}"`,
        [{ field: "check", valid: ids }],
      );
  }

  private run(slug: string): NodeRun {
    const run = this.s.nodes[slug];
    if (!run) throw fail("UNKNOWN_NODE", `the run has no node "${slug}"`);
    return run;
  }

  private handler(node: NodeSpec) {
    const handler = this.registry.node(node.kind);
    if (!handler) throw fail("PIPELINE_INVALID", `node kind "${node.kind}" is not registered`);
    return handler;
  }

  private render = (text: string) => renderTemplate(text, renderContextOf(this.s));

  private log(event: string, data: Record<string, unknown> = {}) {
    this.s.seq += 1;
    this.journal.push({ v: 1, seq: this.s.seq, ts: this.now, event, ...data });
  }

  /** The active visit an event is about, or a precise error, or `Repeat` for a duplicate. */
  private visitFor(slug: string, attempt: number | undefined, phases: Phase[]): Visit {
    this.node(slug);
    const run = this.run(slug);
    const visit = this.s.active.find((v) => v.node === slug);
    if (!visit) {
      const finished = run.status === "passed" || run.status === "failed";
      if (finished && (attempt === undefined || attempt === run.attempt)) throw new Repeat();
      throw fail("NODE_NOT_RUNNING", `node "${slug}" is not running`);
    }
    if (attempt !== undefined && visit.attempt !== attempt) {
      throw fail(
        "ATTEMPT_MISMATCH",
        `node "${slug}" is on attempt ${visit.attempt}, not ${attempt}`,
      );
    }
    if (!phases.includes(visit.phase)) {
      // The agent, or the engine's own command, already reported and the checks are running.
      if (visit.phase === "checks" && (phases.includes("agent") || phases.includes("engine"))) {
        throw new Repeat();
      }
      throw fail(
        "NODE_NOT_RUNNING",
        `node "${slug}" is not waiting for that (it is in the ${visit.phase} phase)`,
      );
    }
    return visit;
  }

  /** The hashes of the definition an attempt runs on, so the history shows which one it was. */
  private definitionOf(node: NodeSpec): { definition?: NodeForms } {
    const fingerprint = this.fingerprint;
    if (!fingerprint) return {};
    const forms = canonicalNode(this.spec, node);
    return {
      definition: {
        work: fingerprint(forms.work),
        checks: fingerprint(forms.checks),
        routing: fingerprint(forms.routing),
      },
    };
  }

  // entering nodes

  private enter(slug: string, rework: boolean, feedback?: Feedback) {
    const node = this.node(slug);
    const run = this.run(slug);
    run.attempt += 1;
    if (feedback) run.lastFailure = feedback;
    if (!rework) {
      run.visitId = this.s.nextVisitId++;
      this.s.trail.push(slug);
    }
    const begin = this.handler(node).begin(node.params, this.render);
    const visit: Visit = {
      node: slug,
      attempt: run.attempt,
      visitId: run.visitId,
      phase: begin.needs === "engine" ? "engine" : begin.needs,
      checkIndex: 0,
      restarts: 0,
      startedAt: this.now,
    };
    this.s.active.push(visit);
    run.status = begin.needs === "human" ? "waiting" : rework ? "rework" : "running";
    this.log("node_entered", {
      node: slug,
      attempt: run.attempt,
      visit: run.visitId,
      rework,
      ...this.definitionOf(node),
    });

    for (const check of node.checks) {
      const baseline = this.registry.check(check.kind)?.baseline?.(check.params);
      if (baseline === "node" && !rework) {
        this.effects.push({ type: "take_snapshot", key: `visit:${run.visitId}` });
      } else if (baseline === "attempt") {
        this.effects.push({ type: "take_snapshot", key: `attempt:${run.visitId}:${run.attempt}` });
      }
    }

    if (begin.needs === "agent") {
      this.effects.push({
        type: "need_agent",
        node: slug,
        attempt: run.attempt,
        prompt: begin.prompt,
      });
    } else if (begin.needs === "engine") {
      visit.heartbeatAt = this.now;
      this.effects.push(this.commandEffect(node, visit, false));
    } else {
      this.effects.push({
        type: "await_human",
        node: slug,
        attempt: run.attempt,
        prompt: begin.prompt,
        ...(begin.instructions === undefined ? {} : { instructions: begin.instructions }),
      });
      this.log("gate_waiting", { node: slug, attempt: run.attempt });
    }
  }

  private commandEffect(node: NodeSpec, visit: Visit, restart: boolean): Effect {
    const begin = this.handler(node).begin(node.params, this.render);
    if (begin.needs !== "engine")
      throw fail("PIPELINE_INVALID", `node "${node.slug}" has no engine work`);
    const effect: Effect = {
      type: "run_command",
      node: node.slug,
      attempt: visit.attempt,
      command: begin.command,
      expect: begin.expect,
      restart,
    };
    if (node.timeout !== undefined) effect.timeout = node.timeout;
    return effect;
  }

  // checks

  private afterWork(visit: Visit) {
    const run = this.run(visit.node);
    run.status = "running";
    visit.phase = "checks";
    visit.checkIndex = 0;
    this.emitCheck(visit, false);
  }

  private emitCheck(visit: Visit, restart: boolean) {
    const node = this.node(visit.node);
    const check = node.checks[visit.checkIndex];
    if (!check) {
      this.finish(visit, visit.declared ?? "passed", undefined);
      return;
    }
    const params = renderDeep(check.params, renderContextOf(this.s));
    const kind = this.registry.check(check.kind)?.baseline?.(params);
    const baseline =
      kind === "run"
        ? "run"
        : kind === "node"
          ? `visit:${visit.visitId}`
          : kind === "attempt"
            ? `attempt:${visit.visitId}:${visit.attempt}`
            : undefined;
    visit.heartbeatAt = this.now;
    const effect: Effect = {
      type: "run_check",
      node: node.slug,
      attempt: visit.attempt,
      index: visit.checkIndex,
      kind: check.kind,
      params,
      restart,
    };
    if (baseline !== undefined) effect.baseline = baseline;
    this.effects.push(effect);
  }

  // outcomes and routing

  private finish(visit: Visit, label: string, failure: Feedback | undefined) {
    const node = this.node(visit.node);
    const run = this.run(visit.node);
    this.s.active = this.s.active.filter((v) => v !== visit);
    run.outcome = label;
    delete visit.heartbeatAt;
    if (failure === undefined) {
      run.status = "passed";
      run.consecutiveFailures = 0;
      delete run.lastFailure;
    } else {
      run.status = "failed";
      if (this.handler(node).automaticFailures) run.consecutiveFailures += 1;
      run.lastFailure = failure;
    }
    this.log("node_finished", {
      node: node.slug,
      attempt: visit.attempt,
      outcome: label,
      status: run.status,
      ...(failure ? { source: failure.source, reason: failure.reason } : {}),
    });
    this.route(node, label, failure !== undefined);
  }

  private route(node: NodeSpec, label: string, failure: boolean) {
    const edge = this.spec.edges.find((e) => e.from === node.slug && e.when === label);
    if (edge) {
      const own = failure ? this.run(node.slug).lastFailure : undefined;
      this.proceed({
        from: node.slug,
        label,
        to: edge.to,
        rework: false,
        ...(own ? { feedback: { ...own, from: node.slug } } : {}),
      });
      return;
    }
    if (!failure) {
      if (this.s.active.length === 0) this.end("completed");
      return;
    }
    if (this.handler(node).requiresRoutes) {
      this.end("failed", `node "${node.slug}" failed with "${label}" and nothing handles that`);
      return;
    }
    this.proceed({ from: node.slug, label, to: node.slug, rework: true });
  }

  /** Take a route unless a limit forbids the next attempt; then the run pauses. */
  private proceed(route: BlockedRoute) {
    const from = this.node(route.from);
    const fromRun = this.run(route.from);
    const automatic = this.handler(from).automaticFailures;
    if (
      fromRun.status === "failed" &&
      automatic &&
      fromRun.consecutiveFailures >= from.max_consecutive_failures
    ) {
      this.pause({ reason: "consecutive", node: route.from, blocked: route });
      return;
    }
    const to = this.node(route.to);
    const toRun = this.run(route.to);
    if (toRun.attempt + 1 > to.max_attempts + toRun.extraAttempts) {
      this.pause({ reason: "total", node: route.to, blocked: route });
      return;
    }
    this.enter(route.to, route.rework, route.feedback);
  }

  private pause(pause: Pause) {
    this.s.status = "paused";
    this.s.pause = pause;
    this.log("run_paused", { reason: pause.reason, node: pause.node });
  }

  private end(status: "completed" | "failed" | "canceled", reason?: string) {
    this.s.status = status;
    this.s.finishedAt = this.now;
    if (this.s.agentLog !== undefined) {
      this.s.agentLog.endedInStep = this.s.active
        .filter((visit) => visit.phase === "agent")
        .map((visit) => `${visit.node}:${visit.attempt}`);
    }
    this.s.active = [];
    this.log("run_finished", {
      status,
      ...(reason === undefined ? {} : { reason }),
      ...(this.facts.head === undefined ? {} : { head: this.facts.head }),
      ...(this.facts.commits === undefined ? {} : { commits: this.facts.commits }),
      ...(this.facts.commitsTruncated === true ? { commits_truncated: true } : {}),
    });
  }

  // events

  apply(event: RunEvent) {
    if (event.type === "start") return this.start(event);
    if (event.type === "acknowledge") {
      this.log("manual_edit", { note: event.note ?? null });
      return;
    }
    if (event.type === "changes_recorded") {
      this.log("changes_recorded", {
        ...changesField(event.changes),
        ...(typeof event.changesError === "string"
          ? { changes_error: event.changesError.slice(0, MAX_CHANGES_ERROR) }
          : {}),
      });
      return;
    }
    if (event.type === "task_note") {
      this.log("task_link", {
        what: event.what,
        task: event.task,
        ...(event.note === undefined ? {} : { note: event.note }),
        ...(event.restarting === true ? { restarting: true } : {}),
      });
      return;
    }
    if (event.type === "feedback") {
      if (event.node !== undefined) this.node(event.node);
      // A note is about the pipeline as it was when it was written, and the pipeline may change
      // under a run, so it says which version and, when only one step is going, which step.
      const only = this.s.active.length === 1 ? this.s.active[0]?.node : undefined;
      if (event.check !== undefined)
        this.checkOfNote(event.check, event.category, event.node ?? only);
      this.log("feedback_reported", {
        node: event.node ?? only ?? null,
        attempt: event.attempt ?? null,
        category: event.category,
        message: event.message,
        suggestion: event.suggestion ?? null,
        ...(event.check === undefined ? {} : { check: event.check }),
        spec: this.s.specHash,
      });
      return;
    }
    if (event.type === "change_proposed") {
      // Only the first few are kept, like refused calls: a proposal is one file that is replaced, but
      // every one of them is a line in the journal.
      const so_far = this.s.proposals ?? 0;
      if (so_far >= MAX_LOGGED_PROPOSALS) throw new Repeat();
      this.s.proposals = so_far + 1;
      this.log("pipeline_change_proposed", {
        hash: event.hash,
        summary: event.summary,
        from: this.s.specHash,
        ...(event.withdrawn === true ? { withdrawn: true } : {}),
      });
      return;
    }
    if (event.type === "report_accepted") {
      this.node(event.node);
      this.log("report_accepted", {
        node: event.node,
        attempt: event.attempt,
        completeness: event.completeness,
        rows: event.rows,
      });
      return;
    }
    if (event.type === "call_refused") {
      // Only the first few are kept: an agent that keeps making refused calls must not be able to
      // grow the journal without end.
      const so_far = this.s.refusals ?? 0;
      if (so_far >= MAX_LOGGED_REFUSALS) throw new Repeat();
      this.s.refusals = so_far + 1;
      this.log("call_refused", {
        about: event.about.slice(0, 40),
        node: event.node?.slice(0, 100) ?? null,
        attempt: event.attempt ?? null,
        code: event.code.slice(0, 40),
        message: event.message.slice(0, 300),
      });
      return;
    }
    if (event.type === "step_served") return this.stepServed(event);
    if (event.type === "served_write_failed") return this.servedWriteFailed(event);
    if (event.type === "agent_log_saved") return this.agentLogSaved(event);
    if (event.type === "agent_log_failed") return this.agentLogFailed(event);
    if (event.type === "usage_recorded") return this.usageRecorded(event);
    if (event.type === "usage_failed") return this.usageFailed(event);
    if (event.type === "cancel") {
      if (this.s.status === "running" || this.s.status === "paused") this.end("canceled");
      else throw new Repeat();
      return;
    }
    if (event.type === "resume") return this.resume();
    if (event.type === "pipeline_accepted") return this.acceptPipeline(event);
    if (event.type === "tick" || event.type === "heartbeat") {
      if (this.s.status !== "running") throw new Repeat();
    } else if (this.s.status !== "running") {
      throw fail("NODE_NOT_RUNNING", `the run is ${this.s.status}`);
    }

    switch (event.type) {
      case "agent_completed": {
        let visit: Visit;
        try {
          visit = this.visitFor(event.node, event.attempt, ["agent"]);
        } catch (error) {
          // The step was already completed. Doing it again is a repeat, but not when it asks for a
          // different ending: the agent would think it had changed how the step ended.
          if (error instanceof Repeat && event.outcome !== undefined) {
            const standing = this.s.active.find((v) => v.node === event.node);
            const label = standing ? (standing.declared ?? "passed") : this.run(event.node).outcome;
            if (label !== null && event.outcome !== label) {
              throw fail(
                "NODE_NOT_RUNNING",
                `node "${event.node}" was already completed with "${label}"; it cannot now end with "${event.outcome}"`,
              );
            }
          }
          throw error;
        }
        const node = this.node(event.node);
        if (event.outcome !== undefined && event.outcome !== "passed") {
          const others = this.handler(node).labels(node).success.slice(1);
          if (!others.includes(event.outcome)) {
            throw fail(
              "UNKNOWN_OUTCOME",
              others.length === 0
                ? `node "${node.slug}" has no outcome "${event.outcome}" (it only finishes the usual way)`
                : `node "${node.slug}" has no outcome "${event.outcome}" (it may finish with: ${others.join(", ")})`,
            );
          }
          visit.declared = event.outcome;
        }
        this.log("agent_completed", {
          node: event.node,
          attempt: event.attempt,
          outcome: visit.declared ?? "passed",
          summary: event.summary ?? null,
          ...(event.executor === undefined ? {} : { executor: event.executor }),
          ...(event.engineVersion === undefined || event.engineVersion === this.s.engineVersion
            ? {}
            : { engine_version: event.engineVersion }),
          ...(event.head === undefined ? {} : { head: event.head }),
          // The host made these and checked them; once more here, and a bad value is left out, never a
          // reason to refuse the hand-in (a patch is a record, not a verdict).
          ...changesField(event.changes),
          ...(typeof event.changesError === "string"
            ? { changes_error: event.changesError.slice(0, MAX_CHANGES_ERROR) }
            : {}),
          ...(isTreeId(event.tree) ? { tree: event.tree } : {}),
        });
        this.afterWork(visit);
        return;
      }
      case "work_finished": {
        if (event.specHash !== undefined && event.specHash !== this.s.specHash) throw new Repeat();
        const visit = this.visitFor(event.node, event.attempt, ["engine"]);
        const node = this.node(event.node);
        this.log("command_finished", {
          node: event.node,
          attempt: event.attempt,
          passed: event.passed,
          ...(event.exit === undefined ? {} : { exit: event.exit }),
          ...(event.duration_ms === undefined ? {} : { duration_ms: event.duration_ms }),
          ...(event.output === undefined ? {} : { output: event.output }),
          ...(event.output_error === undefined ? {} : { output_error: event.output_error }),
          ...(event.passed ? {} : { reason: event.reason }),
        });
        if (event.passed) this.afterWork(visit);
        else this.finish(visit, node.on_fail, { source: "command", reason: event.reason });
        return;
      }
      case "check_finished": {
        if (event.specHash !== undefined && event.specHash !== this.s.specHash) throw new Repeat();
        const visit = this.visitFor(event.node, event.attempt, ["checks"]);
        if (event.index !== visit.checkIndex) throw new Repeat();
        const check = this.node(event.node).checks[event.index];
        if (!check) throw new Repeat();
        const checkId = checkIdOf(this.node(event.node), event.index);
        // The declared params, not the rendered ones: the hash follows the condition, not the run.
        const paramsHash = this.fingerprint?.(stableJson(check.params));
        this.log("check_finished", {
          node: event.node,
          attempt: event.attempt,
          index: event.index,
          kind: check.kind,
          ...(checkId === undefined ? {} : { check_id: checkId }),
          ...(paramsHash === undefined ? {} : { params_hash: paramsHash }),
          passed: event.passed,
          ...(event.exit === undefined ? {} : { exit: event.exit }),
          ...(event.duration_ms === undefined ? {} : { duration_ms: event.duration_ms }),
          ...(event.command === undefined ? {} : { command: event.command }),
          ...(event.output === undefined ? {} : { output: event.output }),
          ...(event.output_error === undefined ? {} : { output_error: event.output_error }),
          ...(event.passed ? {} : { reason: event.reason }),
        });
        if (event.passed) {
          visit.checkIndex += 1;
          this.emitCheck(visit, false);
        } else {
          this.finish(visit, check.on_fail, {
            source: `check:${check.kind}`,
            reason: event.reason,
            ...(checkId === undefined ? {} : { check_id: checkId }),
          });
        }
        return;
      }
      case "human_decided": {
        const visit = this.visitFor(event.node, undefined, ["human"]);
        const approved = event.decision === "approved";
        this.log("gate_decided", {
          node: event.node,
          decision: event.decision,
          reason: event.reason ?? null,
          ...decidedBy(event.byAgent),
        });
        this.finish(
          visit,
          approved ? "approved" : "rejected",
          approved
            ? undefined
            : { source: "human", reason: event.reason ?? "rejected without a reason" },
        );
        return;
      }
      case "heartbeat": {
        const visit = this.s.active.find(
          (v) => v.node === event.node && v.attempt === event.attempt,
        );
        if (!visit || (visit.phase !== "engine" && visit.phase !== "checks")) throw new Repeat();
        // Only the process that owns the work may say it is alive. One that stalled, was replaced
        // and woke up again must not take the work back, or its later exit would look like the
        // death of work another process is running.
        if (event.owner !== undefined && visit.owner !== undefined && visit.owner !== event.owner) {
          throw new Repeat();
        }
        visit.heartbeatAt = this.now;
        if (event.owner !== undefined) visit.owner = event.owner;
        return;
      }
      case "tick": {
        const dead = new Set(event.deadOwners ?? []);
        for (const visit of [...this.s.active]) {
          const engineWork = visit.phase === "engine" || visit.phase === "checks";
          if (!engineWork || visit.suspended || visit.heartbeatAt === undefined) continue;
          const gone = visit.owner !== undefined && dead.has(visit.owner);
          if (gone || this.now - visit.heartbeatAt >= this.staleMs) this.restart(visit, gone);
        }
        return;
      }
    }
  }

  private start(event: Extract<RunEvent, { type: "start" }>) {
    for (const node of this.spec.nodes) {
      this.s.nodes[node.slug] = {
        slug: node.slug,
        status: "pending",
        outcome: null,
        attempt: 0,
        consecutiveFailures: 0,
        extraAttempts: 0,
        visitId: 0,
      };
    }
    if (event.history?.prompts.enabled === true) this.s.served = {};
    if (event.history?.agent_log?.enabled === true) {
      this.s.agentLog = {
        nodes: this.spec.nodes.map((node) => node.slug),
        sessions: {},
        ticks: 0,
        steps: 0,
        bytes: 0,
        cut: 0,
        failed: [],
      };
    }
    if (event.history?.usage?.enabled === true) this.s.usage = newUsageState();
    this.log("run_started", {
      run: event.runId,
      task: event.task,
      slug: event.slug ?? runSlug(undefined, event.task),
      spec: event.specHash,
      ...(event.workdir === undefined ? {} : { workdir: event.workdir }),
      ...(event.branch === undefined ? {} : { branch: event.branch }),
      ...(event.pipelineFile === undefined ? {} : { pipelineFile: event.pipelineFile }),
      ...(event.taskKey === undefined ? {} : { task_key: event.taskKey }),
      ...(event.history === undefined ? {} : { history: event.history }),
      ...(event.engine === undefined ? {} : { engine: event.engine }),
      ...(event.executor === undefined ? {} : { executor: event.executor }),
      ...(event.baseCommit === undefined ? {} : { base_commit: event.baseCommit }),
    });
    const needsRunBaseline = this.spec.nodes.some((n) =>
      n.checks.some((c) => this.registry.check(c.kind)?.baseline?.(c.params) === "run"),
    );
    if (needsRunBaseline) this.effects.push({ type: "take_snapshot", key: "run" });
    this.enter(this.spec.entry, false);
  }

  /**
   * Keep a record of what the agent was handed, once per answer and client. Anything that does not
   * hold (the run is not running, the step moved on, a run that does not record prompts, a repeat, a
   * limit) is a quiet no-op: the agent has the answer already and recording must never refuse it.
   */
  private stepServed(event: Extract<RunEvent, { type: "step_served" }>) {
    const served = this.s.served;
    if (served === undefined || this.s.status !== "running") throw new Repeat();
    const visit = this.s.active.find((v) => v.node === event.node);
    if (visit?.attempt !== event.attempt || visit.phase !== "agent") throw new Repeat();
    const so_far = this.s.servedEvents ?? 0;
    if (so_far >= MAX_SERVED_EVENTS) throw new Repeat();
    const id = `${event.node}:${event.attempt}`;
    const keys = served[id] ?? [];
    if (keys.includes(event.key) || keys.length >= MAX_SERVED_PER_ATTEMPT) throw new Repeat();
    served[id] = [...keys, event.key];
    this.s.servedEvents = so_far + 1;
    const n = keys.length + 1;
    this.log("step_served", {
      node: event.node,
      attempt: event.attempt,
      n,
      // A node slug is lowercase letters, digits and dashes (`pipeline.ts`), so it is a safe file name.
      ref: `served/${event.node}-${event.attempt}-${n}.json`,
      prompt_hash: event.promptHash,
      ...(event.executor === undefined ? {} : { executor: event.executor }),
    });
  }

  private servedWriteFailed(event: Extract<RunEvent, { type: "served_write_failed" }>) {
    if (this.s.served === undefined || this.s.status !== "running") throw new Repeat();
    const so_far = this.s.servedEvents ?? 0;
    if (so_far >= MAX_SERVED_EVENTS) throw new Repeat();
    this.s.servedEvents = so_far + 1;
    this.log("served_write_failed", {
      node: event.node.slice(0, 100),
      attempt: event.attempt,
      n: event.n,
      message: event.message.slice(0, 200),
    });
  }

  /**
   * Keep the account of a copy of the agent's log. Like `stepServed`, anything that does not hold (the run is not
   * running, a run that does not copy, a limit, a copy that does not continue the stored stream) is a quiet no-op: the
   * copy is display data and must never refuse or fail a step. The stream must continue where the journal says it
   * ends, and the events must be newer than the last ones stored: that is what keeps two writers from storing an
   * event twice or over each other.
   */
  private agentLogSaved(event: Extract<RunEvent, { type: "agent_log_saved" }>) {
    const log = this.s.agentLog;
    if (log === undefined || this.s.status !== "running") throw new Repeat();
    const whole = (n: number) => Number.isSafeInteger(n) && n >= 0;
    if (
      !SAFE_ID.test(event.session) ||
      !(event.parent === undefined || SAFE_ID.test(event.parent)) ||
      !HEX64.test(event.tail_hash) ||
      !HEX64.test(event.last_key) ||
      ![event.first_seq, event.last_seq, event.stream_from, event.stream_to, event.entries].every(
        whole,
      ) ||
      event.first_seq < 1 ||
      event.last_seq < event.first_seq ||
      event.stream_to < event.stream_from
    ) {
      throw new Repeat();
    }
    if (event.why === "tick") {
      if (log.ticks >= MAX_AGENT_LOG_TICKS) throw new Repeat();
    } else if (log.steps >= MAX_AGENT_LOG_STEPS) {
      throw new Repeat();
    }
    const stored = log.sessions[event.session];
    if (event.stream_from !== (stored?.length ?? 0)) throw new Repeat();
    if (event.first_seq <= (stored?.last_seq ?? 0)) throw new Repeat();
    if (event.why === "tick") log.ticks += 1;
    else log.steps += 1;
    log.sessions[event.session] = {
      last_seq: event.last_seq,
      length: event.stream_to,
      tail_hash: event.tail_hash,
      last_key: event.last_key,
      entries: (stored?.entries ?? 0) + event.entries,
    };
    log.bytes += event.stream_to - event.stream_from;
    log.cut += event.cut ?? 0;
    const visit = `${event.node}:${event.attempt}`;
    const counted = log.visits ?? {};
    if (visit in counted || Object.keys(counted).length < MAX_AGENT_LOG_VISITS) {
      counted[visit] = (counted[visit] ?? 0) + (event.stream_to - event.stream_from);
      log.visits = counted;
    }
    this.log("agent_log_saved", {
      why: event.why,
      session: event.session,
      ...(event.parent === undefined ? {} : { parent: event.parent }),
      node: event.node.slice(0, 100),
      attempt: event.attempt,
      first_seq: event.first_seq,
      last_seq: event.last_seq,
      stream_from: event.stream_from,
      stream_to: event.stream_to,
      tail_hash: event.tail_hash,
      last_key: event.last_key,
      entries: event.entries,
      ...(event.cut === undefined || event.cut === 0 ? {} : { cut: event.cut }),
    });
  }

  private agentLogFailed(event: Extract<RunEvent, { type: "agent_log_failed" }>) {
    const log = this.s.agentLog;
    if (log === undefined || this.s.status !== "running") throw new Repeat();
    if (!AGENT_LOG_FAILURES.includes(event.reason) || log.failed.includes(event.reason)) {
      throw new Repeat();
    }
    log.failed.push(event.reason);
    this.log("agent_log_failed", {
      reason: event.reason,
      ...(event.session !== undefined && SAFE_ID.test(event.session)
        ? { session: event.session }
        : {}),
    });
  }

  /**
   * Keep the account of usage. A record with a node is accepted only for the agent step the run is at, so a call that
   * names another node or a future attempt cannot close a record that does not exist; one without a node is use
   * outside every step. Like the copy of the agent's log, anything that does not hold is a quiet no-op: usage is
   * display data and must never refuse or fail a step. A record only adds: the cursor of its session must not go back.
   */
  private usageRecorded(event: Extract<RunEvent, { type: "usage_recorded" }>) {
    const usage = this.s.usage;
    if (usage === undefined || this.s.status !== "running") throw new Repeat();
    const delta = usageDeltaSchema.safeParse(event.delta);
    const cursor = usageCursorSchema.safeParse(event.cursor);
    if (!SAFE_ID.test(event.session) || !delta.success || !cursor.success) throw new Repeat();
    if (usage.events >= MAX_USAGE_EVENTS) throw new Repeat();
    const stored = usage.sessions[event.session];
    if (cursor.data.last_seq < (stored?.last_seq ?? 0)) throw new Repeat();
    let key: string | undefined;
    if (event.node !== undefined || event.attempt !== undefined) {
      const visit = this.s.active.find(
        (v) => v.node === event.node && v.attempt === event.attempt && v.phase === "agent",
      );
      if (visit === undefined) throw new Repeat();
      key = `${visit.node}:${visit.attempt}`;
      // Past the limit a record counts in the run's `unattributed`: the state stays bounded and the sum stays whole.
      if (!(key in usage.attempts) && Object.keys(usage.attempts).length >= MAX_USAGE_ATTEMPTS) {
        key = undefined;
      }
    }
    const totals = key === undefined ? usage.unattributed : (usage.attempts[key] ?? newTotals());
    addDelta(totals, delta.data);
    if (key !== undefined) usage.attempts[key] = totals;
    usage.sessions[event.session] = cursor.data;
    usage.events += 1;
    if (!usage.revisions.includes(delta.data.revision)) usage.revisions.push(delta.data.revision);
    this.log("usage_recorded", {
      session: event.session,
      ...(key === undefined ? {} : { node: event.node, attempt: event.attempt }),
      delta: delta.data,
      cursor: cursor.data,
    });
  }

  private usageFailed(event: Extract<RunEvent, { type: "usage_failed" }>) {
    const usage = this.s.usage;
    if (usage === undefined || this.s.status !== "running") throw new Repeat();
    if (!USAGE_FAILURES.includes(event.reason) || usage.failed.includes(event.reason)) {
      throw new Repeat();
    }
    usage.failed.push(event.reason);
    this.log("usage_failed", {
      reason: event.reason,
      ...(event.session !== undefined && SAFE_ID.test(event.session)
        ? { session: event.session }
        : {}),
    });
  }

  private restart(visit: Visit, ownerGone = false) {
    // Work whose process went silent counts against `maxRestarts`. Work whose process is known to be
    // gone is counted apart and allowed more: closing the agent in the middle of a build is a normal
    // thing to do, and the next session picks the build up again; it is not a crash.
    if (ownerGone) {
      visit.takeovers = (visit.takeovers ?? 0) + 1;
      if (visit.takeovers > MAX_TAKEOVERS) {
        visit.suspended = true;
        this.pause({ reason: "restarts", node: visit.node });
        return;
      }
    } else {
      visit.restarts += 1;
      if (visit.restarts > this.maxRestarts) {
        visit.suspended = true;
        this.pause({ reason: "restarts", node: visit.node });
        return;
      }
    }
    visit.heartbeatAt = this.now;
    delete visit.owner;
    this.log("node_restarted", {
      node: visit.node,
      attempt: visit.attempt,
      restarts: visit.restarts,
      ...(ownerGone ? { takeovers: visit.takeovers } : {}),
      reason: ownerGone
        ? "the process running it is gone"
        : "the process running it stopped answering",
    });
    this.reissue(visit);
  }

  private reissue(visit: Visit) {
    if (visit.phase === "engine")
      this.effects.push(this.commandEffect(this.node(visit.node), visit, true));
    else this.emitCheck(visit, true);
  }

  /** Clear a pause that the change takes care of. */
  private unpause() {
    if (this.s.status !== "paused") return;
    this.s.status = "running";
    delete this.s.pause;
  }

  private acceptPipeline(event: Extract<RunEvent, { type: "pipeline_accepted" }>) {
    if (this.s.specHash === event.to) throw new Repeat();
    if (this.s.specHash !== event.from) {
      throw fail(
        "PIPELINE_CHANGE_REFUSED",
        "the run is no longer on the version this change was made from",
      );
    }
    const diff = diffPipelines(event.before, this.spec, this.s);
    if (diff.refused !== undefined) throw fail("PIPELINE_CHANGE_REFUSED", diff.refused);

    for (const { slug, changes } of diff.nodes) {
      if (changes.includes("added")) {
        this.s.nodes[slug] = {
          slug,
          status: "pending",
          outcome: null,
          attempt: 0,
          consecutiveFailures: 0,
          extraAttempts: 0,
          visitId: 0,
        };
      } else if (changes.includes("removed")) {
        this.run(slug).removed = true;
      }
    }
    this.s.specHash = event.to;
    this.log("pipeline_accepted", {
      from: event.from,
      to: event.to,
      source: event.source,
      nodes: diff.nodes,
      effect: diff.effect,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      ...decidedBy(event.byAgent),
    });

    const effect = diff.effect;
    if (effect.kind === "restart") {
      const visit = this.s.active.find((v) => v.node === effect.node);
      if (!visit) return;
      // The attempt is closed without a verdict: it is not routed, it does not count as a failure,
      // and it does not use up an attempt of the node.
      this.s.active = this.s.active.filter((v) => v !== visit);
      this.log("node_superseded", { node: visit.node, attempt: visit.attempt });
      this.unpause();
      this.run(visit.node).extraAttempts += 1;
      this.enter(visit.node, true, {
        source: "pipeline",
        reason:
          "the definition of this step was changed; the work done so far is still in the working directory",
      });
    } else if (effect.kind === "recheck") {
      this.unpause();
      const visit = this.s.active.find((v) => v.node === effect.node);
      if (visit) {
        visit.suspended = false;
        visit.restarts = 0;
        visit.checkIndex = 0;
        visit.heartbeatAt = this.now;
        delete visit.owner;
        this.log("checks_rerun", { node: visit.node, attempt: visit.attempt });
        this.emitCheck(visit, true);
        return;
      }
      // The attempt failed a check and the run was held back: it is opened again to be checked.
      const run = this.run(effect.node);
      run.status = "running";
      run.consecutiveFailures = Math.max(0, run.consecutiveFailures - 1);
      const reopened: Visit = {
        node: effect.node,
        attempt: run.attempt,
        visitId: run.visitId,
        phase: "checks",
        checkIndex: 0,
        restarts: 0,
        heartbeatAt: this.now,
        startedAt: this.now,
      };
      this.s.active.push(reopened);
      this.log("checks_rerun", { node: effect.node, attempt: run.attempt });
      this.emitCheck(reopened, false);
    } else if (effect.kind === "reroute") {
      const blocked = this.s.pause?.blocked;
      if (!blocked) return;
      this.unpause();
      this.route(this.node(blocked.from), blocked.label, true);
    }
  }

  private resume() {
    const pause = this.s.pause;
    if (this.s.status !== "paused" || !pause) throw new Repeat();
    this.s.status = "running";
    delete this.s.pause;
    this.log("run_resumed", { reason: pause.reason, node: pause.node });

    if (pause.reason === "restarts") {
      const visit = this.s.active.find((v) => v.suspended);
      if (visit) {
        visit.suspended = false;
        visit.restarts = 0;
        visit.heartbeatAt = this.now;
        this.reissue(visit);
      }
      return;
    }
    // A human saying "go on" gives a fresh budget: the node that caused the pause starts its failure
    // count over, and every node that has used up its attempts gets another `max_attempts` (a loop
    // runs through several nodes, so topping up only one would just pause again at the next).
    this.run(pause.node).consecutiveFailures = 0;
    for (const node of this.spec.nodes) {
      const run = this.run(node.slug);
      if (run.attempt >= node.max_attempts + run.extraAttempts)
        run.extraAttempts += node.max_attempts;
    }
    if (pause.blocked) this.proceed(pause.blocked);
  }
}

/** A run that has not started yet; `decide` fills it in on the `start` event. */
function emptyState(now: number): RunState {
  return {
    v: 1,
    runId: "",
    task: "",
    specHash: "",
    status: "running",
    startedAt: now,
    nodes: {},
    active: [],
    trail: [],
    nextVisitId: 1,
    seq: 0,
  };
}

/**
 * Apply one event to a run. A repeat of something that already happened changes nothing and says
 * so (`noop`); a request that makes no sense is an error and also changes nothing.
 */
export function decide(
  spec: PipelineSpec,
  state: RunState | undefined,
  event: RunEvent,
  now: number,
  options: EngineOptions = {},
  facts?: RunFacts,
): Decision {
  if (event.type === "start") {
    if (state) return { ok: false, error: fail("NODE_NOT_RUNNING", "the run has already started") };
  } else if (!state) {
    return { ok: false, error: fail("NODE_NOT_RUNNING", "the run has not started") };
  }

  const draft: RunState = state ? structuredClone(state) : emptyState(now);
  if (event.type === "start") {
    draft.runId = event.runId;
    draft.task = event.task;
    draft.slug = event.slug ?? runSlug(undefined, event.task);
    draft.specHash = event.specHash;
    if (event.workdir !== undefined) draft.workdir = event.workdir;
    if (event.pipelineFile !== undefined) draft.pipelineFile = event.pipelineFile;
    if (event.taskKey !== undefined) draft.taskKey = event.taskKey;
    if (event.history !== undefined) draft.history = event.history;
    if (event.engine !== undefined) draft.engineVersion = event.engine.version;
  }
  const machine = new Machine(spec, draft, now, options, facts);
  try {
    machine.apply(event);
  } catch (error) {
    if (error instanceof KodelError) return { ok: false, error };
    if (error instanceof Repeat && state) {
      return { ok: true, state, effects: [], journal: [], noop: true };
    }
    throw error;
  }
  return { ok: true, state: draft, effects: machine.effects, journal: machine.journal };
}
