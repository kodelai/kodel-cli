/**
 * The run state machine: `decide(spec, state, event, now)` returns the next state, the effects a
 * host must carry out, and the journal records to append. It is pure: no clock, file, process or
 * network access, so every host (local CLI, server) runs the same rules.
 *
 * Vocabulary: a node is *entered* (a visit, from the start or from another node); each go at it is
 * an *attempt*. A failed attempt of an agent node with no edge for its label is retried as a new
 * attempt of the same visit (rework). Limits: `max_consecutive_failures` and `max_attempts`.
 *
 * Several edges with the same `from` and `when` *fork*: their targets are entered together, each
 * visit carrying the fork and its branch, and the `join: all` node they all lead to is entered once
 * every branch has *arrived* (settled with any label that has an edge to the join). A branch that
 * stops with no way on is *dead*: the join never starts and the run ends `failed` once the other
 * branches have settled. Pauses are per branch (`pauses[]`); the run is `paused` only when nothing
 * can move.
 */
import { canonicalNode, checkIdOf, type NodeForms, stableJson } from "./canonical";
import { type ChangesRef, changesField, isTreeId, MAX_CHANGES_ERROR } from "./changes";
import { type ErrorCode, KodelError } from "./errors";
import type { EngineRecord, ExecutorRecord } from "./executor";
import type { HistoryConfig } from "./history-config";
import type { NodeSpec, PipelineSpec } from "./pipeline";
import { type AcceptEffect, diffPipelines, standingOf } from "./pipeline-diff";
import { defaultRegistry, labelsOf, RESTART_FAILED, type Registry } from "./registry";
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
import { RECORD_VERSION } from "./version";

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

/** Which branch of which fork a visit, a route or a pause belongs to. */
export interface ForkRef {
  /** The fork instance (`RunState.forks`). */
  id: string;
  /** The branch, named by its first node (the target of the fork edge). */
  branch: string;
}

/** How a branch of a fork settled. */
export interface Arrival {
  /** The node the branch ended at, and the label it ended with. */
  node: string;
  label: string;
  /** Set when the branch arrived by a failure label: what the join is told. */
  failure?: Feedback;
  /** The branch stopped with no way on; the join can never start. */
  dead?: true;
  /**
   * The journal record of the arrival (`seq` of its `branch_settled`). It orders the arrivals: the
   * keys of `arrived` do not, since an integer-like key comes first whenever it was added.
   */
  seq?: number;
}

/** One time a fork fired. A fork in a loop fires once per pass, each pass its own instance. */
export interface ForkState {
  id: string;
  /** The node and label that forked. */
  from: string;
  label: string;
  join: string;
  /** The branches, named by their first nodes, in the order of the edges. */
  branches: string[];
  arrived: Record<string, Arrival>;
  /** How many times the join was entered for this instance (`restart_failed` enters it again). */
  joined: number;
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
  /** For a join: why each branch that arrived failed (empty when none did); kept over its rework. */
  lastFailures?: Feedback[];
  /** The branch the node was last entered in, when it was entered inside a fork. */
  fork?: ForkRef;
  /**
   * The outcome the agent declared for the current or last attempt (`Visit.declared`), kept on the
   * node so that an attempt opened again to be rechecked after its check failed still ends with it.
   * Dropped when the node is entered again or the attempt passes.
   */
  declared?: string;
  /** The node is no longer in the pipeline; its attempts stay in the history. */
  removed?: boolean;
  /**
   * A worker's hold on the node's open agent step. It sits on the node, not on the attempt, so it
   * outlives a restart of the step (an accepted change, a recheck, a resume): the worker that holds
   * it goes on with the new attempt, and no second worker is handed the step meanwhile.
   */
  claim?: StepClaim;
}

export type Phase = "agent" | "engine" | "checks" | "human";

/**
 * A worker's hold on an agent step: a mark, not a lock. The engine never refuses a completion on it;
 * it only keeps two workers from being handed the same step, and says when one was crossed.
 */
export interface StepClaim {
  /** The token, hashed by the host; the token itself is never stored. */
  token: string;
  at: number;
  /** When the claim lapses unless renewed (`at` plus the project's `claim_ttl_s`). */
  until: number;
  /** A short mark of the holder (a prefix of the hash), for the answers; it identifies nobody. */
  by: string;
}

/** The claim on a node's step that still holds at `now`, if any. */
export function liveClaim(run: NodeRun | undefined, now: number): StepClaim | undefined {
  const claim = run?.claim;
  return claim !== undefined && now < claim.until ? claim : undefined;
}

/** How many claim events of each kind a run journals; the claims themselves are not limited. */
export const MAX_LOGGED_CLAIMS = 200;

/** Default `agents.claim_ttl_s`: how long a worker's hold on a step lasts unless renewed. */
export const DEFAULT_CLAIM_TTL_S = 900;

/**
 * Whether the run has open agent steps and every one of them is held by a live claim: then a caller
 * that asks what to do next has nothing to do but wait for the workers, as it does for engine work.
 */
export function claimedStepsOpen(state: RunState, now: number): boolean {
  const open = state.active.filter((v) => v.phase === "agent");
  return open.length > 0 && open.every((v) => liveClaim(state.nodes[v.node], now) !== undefined);
}

/** An attempt that is in progress. The state holds a set of them: one per node, several in a fork. */
export interface Visit {
  node: string;
  attempt: number;
  visitId: number;
  phase: Phase;
  /** The branch this visit belongs to, when it is inside a fork. */
  fork?: ForkRef;
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
  /**
   * The pipeline version the engine work in flight (the command, or the current check) was issued
   * under; set again each time work is issued. A result that names another version is dropped: it
   * came from work issued before a change re-issued it. An accepted change that leaves the node as
   * it is does not re-issue, so a command or check in flight in a sibling branch is kept.
   */
  spec?: string;
}

export interface BlockedRoute {
  from: string;
  label: string;
  to: string;
  rework: boolean;
  /** Why the node before failed, handed to the node this route enters (a rejection, a red build). */
  feedback?: Feedback;
  /** For a route into a join: why each failed branch failed, in branch order. */
  feedbacks?: Feedback[];
  /** The branch the route stays in, so a node entered later still belongs to it. */
  fork?: ForkRef;
  /** The fork instance whose join this route enters. */
  join?: string;
  /**
   * A fork held back before it fired (`from` failed too often in a row): the heads it will enter, in
   * edge order, `to` being the first. Taking the route forks once, into every head.
   */
  heads?: string[];
}

/**
 * Whether a held-back route enters a branch from outside it: a fork's own edge into a head, or the
 * join's `restart_failed` into a branch. Such a route is taken as it is when the run goes on; working
 * it out again from `from` would fire the fork a second time beside the open instance.
 */
export function routeEntersBranch(state: RunState, route: BlockedRoute): boolean {
  return route.fork !== undefined && state.nodes[route.from]?.fork?.id !== route.fork.id;
}

/** The branch a node stands in: its attempt in progress, else the one it was last entered in. */
export function branchOf(state: RunState, node: string): ForkRef | undefined {
  return state.active.find((v) => v.node === node)?.fork ?? state.nodes[node]?.fork;
}

/**
 * Whether the work of `node` is for whoever decided or completed `decided` to wait for: the work of
 * the same branch, and work outside every branch (the join and what follows it, which the decided
 * branch's own arrival may have started). Only another branch of a fork is somebody else's.
 */
export function inOwnBranch(state: RunState, decided: string, node: string): boolean {
  const own = branchOf(state, decided);
  const other = branchOf(state, node);
  return (
    own === undefined || other === undefined || (own.id === other.id && own.branch === other.branch)
  );
}

export interface Pause {
  reason: "consecutive" | "total" | "restarts";
  /** The node whose limit was hit (the one `resume` gives a fresh budget). */
  node: string;
  blocked?: BlockedRoute;
  /** The branch that paused, when the node is inside a fork; the other branches go on. */
  fork?: ForkRef;
}

export interface RunState {
  v: typeof RECORD_VERSION;
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
  /** Where the run waits for `resume`, one entry per paused branch (or one for a run without forks). */
  pauses: Pause[];
  /** Every time a fork fired, by instance id, in order; absent until the first fork. */
  forks?: Record<string, ForkState>;
  nextVisitId: number;
  /** Sequence number of the last journal record. */
  seq: number;
  /** How many refused calls were journaled; there is a limit (`MAX_LOGGED_REFUSALS`). */
  refusals?: number;
  /** How many proposals to change the pipeline were journaled; there is a limit. */
  proposals?: number;
  /** How many `step_claimed` and `step_claim_conflict` events were journaled; each has a limit. */
  claimEvents?: { claimed: number; conflicts: number };
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

/** The mark of a claim's holder: a prefix of the hash, which gives nothing of the token away. */
const markOf = (tokenHash: string) => `w-${tokenHash.slice(0, 8)}`;

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
      /**
       * The hash of the claim token the worker handed in with, as the host hashed it. A completion
       * is never refused for a missing or wrong one: it is journaled as crossing the live claim.
       */
      claimToken?: string;
      /** HEAD of the run's directory when the step was handed in, as the host read it. */
      head?: string;
      /** The patch of the work since the previous hand-in, when the host kept one (`history.changes`). */
      changes?: ChangesRef;
      /** Why there is no patch, when the host tried and could not. */
      changesError?: string;
      /** The work tree at this hand-in; the next hand-in's patch starts there. */
      tree?: string;
      /** A limit of the patch the host knows of (another branch wrote to the same tree meanwhile). */
      changesNote?: string;
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
      /**
       * Where the run stood when the change was shown (`standingOf`): the change is refused when the
       * run has moved on since, so what is accepted is what was looked at.
       */
      standing?: string;
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
   * A worker takes the open agent step of `node`, or, without one, the first free open step (chosen
   * here, under the run's lock, so two workers never pick the same). `token` is the hash of the
   * token the host made for it (the core has no crypto). A live claim with another hash, or no
   * free step, leaves the state as it is and says so (`noop`): the host reads who holds what from
   * the state it gets back. The same hash renews the claim. `ttlMs` is the project's `claim_ttl_s`.
   */
  | {
      type: "step_claimed";
      node?: string;
      token: string;
      ttlMs: number;
      /**
       * `agents.max_parallel`: while that many steps are held, a take is refused (`noop`), by slug
       * too; only the holder of a step renews it under the cap.
       */
      maxParallel?: number;
    }
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
  | {
      type: "tick";
      deadOwners?: string[];
      /**
       * Only these nodes' work is looked at: a caller that waits for its own chain must not take
       * over (and start in its own process) work of a sibling branch it will not wait for.
       */
      nodes?: string[];
    }
  /** Carry a paused branch on; `node` picks the pause when more than one branch is paused. */
  | { type: "resume"; node?: string }
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
      /** The pipeline version the work is issued under: the host labels the result with it. */
      spec?: string;
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
      /** The pipeline version the check is issued under: the host labels the result with it. */
      spec?: string;
    }
  | { type: "await_human"; node: string; attempt: number; prompt: string; instructions?: string };

export interface JournalRecord {
  v: typeof RECORD_VERSION;
  seq: number;
  ts: number;
  event: string;
  [field: string]: unknown;
}

export type Decision =
  | {
      ok: true;
      state: RunState;
      effects: Effect[];
      journal: JournalRecord[];
      noop?: true;
      /**
       * A `step_claimed` that held a step: which, and whether the same token already held it. Said
       * here, not only in the journal, whose claim records stop at a limit.
       */
      claimed?: { node: string; renewed: boolean };
    }
  | { ok: false; error: KodelError };

/** Thrown inside `decide` for a repeat of something that already happened. */
class Repeat extends Error {}

const fail = (code: ErrorCode, message: string) => new KodelError(code, message);

// ── the machine ─────────────────────────────────────────────────────────────

class Machine {
  readonly effects: Effect[] = [];
  readonly journal: JournalRecord[] = [];
  claimed: { node: string; renewed: boolean } | undefined;
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
    this.journal.push({ v: RECORD_VERSION, seq: this.s.seq, ts: this.now, event, ...data });
  }

  private get ended(): boolean {
    return this.s.status !== "running" && this.s.status !== "paused";
  }

  /** The journal fields that say which branch something belongs to. */
  private forkFields(fork: ForkRef | undefined): Record<string, unknown> {
    return fork === undefined ? {} : { fork: fork.id, branch: fork.branch };
  }

  private forkState(ref: ForkRef): ForkState {
    const fork = this.s.forks?.[ref.id];
    if (!fork) {
      throw fail(
        "STATE_MODIFIED_EXTERNALLY",
        `the state names a fork "${ref.id}" that it does not hold`,
      );
    }
    return fork;
  }

  /** The instance whose join `slug` is: the latest one, since a join belongs to one fork and a fork in a loop fires again. */
  private forkOfJoin(slug: string): ForkState | undefined {
    const all = Object.values(this.s.forks ?? {});
    for (let i = all.length - 1; i >= 0; i--) {
      const fork = all[i];
      if (fork?.join === slug) return fork;
    }
    return undefined;
  }

  /** The join the branches starting at `heads` lead to: the first `join: all` node reached without passing another. */
  private joinOf(heads: string[]): string | undefined {
    const seen = new Set<string>();
    const queue = [...heads];
    for (let slug = queue.shift(); slug !== undefined; slug = queue.shift()) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      if (this.nodes.get(slug)?.join !== undefined) return slug;
      for (const edge of this.spec.edges) if (edge.from === slug) queue.push(edge.to);
    }
    return undefined;
  }

  /** The nodes of a branch: what its first node reaches without passing the join. */
  private branchNodes(ref: ForkRef): Set<string> {
    const { join } = this.forkState(ref);
    const seen = new Set<string>();
    const queue = [ref.branch];
    for (let slug = queue.shift(); slug !== undefined; slug = queue.shift()) {
      if (seen.has(slug) || slug === join) continue;
      seen.add(slug);
      for (const edge of this.spec.edges) if (edge.from === slug) queue.push(edge.to);
    }
    return seen;
  }

  /**
   * The nodes that are not in a branch of a fork that joins at `join`; every node when no fork that
   * fired joins there (the node is not a join, or its fork has not fired yet).
   */
  private outsideBranchesOf(join: string): Set<string> | undefined {
    const forks = Object.values(this.s.forks ?? {}).filter((f) => f.join === join);
    if (forks.length === 0) return undefined;
    const inside = new Set<string>();
    for (const fork of forks) {
      for (const branch of fork.branches) {
        for (const slug of this.branchNodes({ id: fork.id, branch })) inside.add(slug);
      }
    }
    return new Set(this.spec.nodes.map((n) => n.slug).filter((slug) => !inside.has(slug)));
  }

  /**
   * The branches of a fork that `restart_failed` runs again: failed, not by a person's rejection, and
   * with a step of their own (a branch that is the join itself has nothing to run again).
   */
  private restartable(fork: ForkState | undefined): string[] {
    if (!fork) return [];
    return fork.branches.filter((branch) => {
      const failure = fork.arrived[branch]?.failure;
      return branch !== fork.join && failure !== undefined && failure.source !== "human";
    });
  }

  /**
   * A result that names the pipeline version it was made under, and that version is not the one the
   * node's work was issued under (`Visit.spec`): it ran against another definition and is dropped.
   */
  private staleResult(event: { node: string; specHash?: string }): boolean {
    if (event.specHash === undefined) return false;
    const visit = this.s.active.find((v) => v.node === event.node);
    return event.specHash !== (visit?.spec ?? this.s.specHash);
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

  /**
   * `fork`: the branch the node is entered in. `feedbacks`: for a join, why each failed branch failed
   * (given on every fresh entry of a join, empty when none failed; a rework keeps the last ones).
   */
  private enter(
    slug: string,
    rework: boolean,
    feedback?: Feedback,
    fork?: ForkRef,
    feedbacks?: Feedback[],
  ) {
    const node = this.node(slug);
    const run = this.run(slug);
    if (this.s.active.some((v) => v.node === slug)) {
      // One attempt of a node at a time is what every reader of the state relies on. The validator
      // keeps the branches of a fork apart, so this is a defect of the pipeline or the state, and the
      // run says so instead of going on with two visits of one node.
      this.end("failed", `node "${slug}" was entered while an attempt of it was still going`);
      return;
    }
    run.attempt += 1;
    if (feedback) run.lastFailure = feedback;
    if (fork) run.fork = fork;
    else delete run.fork;
    if (feedbacks !== undefined) {
      run.lastFailures = feedbacks;
      const first = feedbacks[0];
      if (first) run.lastFailure = first;
      else delete run.lastFailure;
    } else if (!rework) {
      delete run.lastFailures;
    }
    // A new attempt: what the agent declared for the last one is not what this one ends with.
    delete run.declared;
    if (!rework) {
      run.visitId = this.s.nextVisitId++;
      this.s.trail.push(slug);
      // A new visit is new work; a rework or a restart of the step stays with its worker.
      delete run.claim;
    }
    const begin = this.handler(node).begin(node.params, this.render);
    const visit: Visit = {
      node: slug,
      attempt: run.attempt,
      visitId: run.visitId,
      phase: begin.needs === "engine" ? "engine" : begin.needs,
      ...(fork === undefined ? {} : { fork }),
      checkIndex: 0,
      restarts: 0,
      startedAt: this.now,
      spec: this.s.specHash,
    };
    this.s.active.push(visit);
    run.status = begin.needs === "human" ? "waiting" : rework ? "rework" : "running";
    this.log("node_entered", {
      node: slug,
      attempt: run.attempt,
      visit: run.visitId,
      rework,
      ...this.forkFields(fork),
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
    visit.spec = this.s.specHash;
    effect.spec = visit.spec;
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
    visit.spec = this.s.specHash;
    const effect: Effect = {
      type: "run_check",
      node: node.slug,
      attempt: visit.attempt,
      index: visit.checkIndex,
      kind: check.kind,
      params,
      restart,
      spec: visit.spec,
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
      delete run.declared;
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
      ...this.forkFields(visit.fork),
      ...(failure ? { source: failure.source, reason: failure.reason } : {}),
    });
    this.route(node, label, failure !== undefined);
  }

  private route(node: NodeSpec, label: string, failure: boolean) {
    const run = this.run(node.slug);
    const fork = run.fork;
    const own = failure ? run.lastFailure : undefined;
    // Only a declared outcome that passed its checks runs the failed branches again; a failure label
    // of that name (a pipeline written before it was refused) is routed like any other failure.
    if (node.join !== undefined && label === RESTART_FAILED && !failure) {
      this.restartFailed(node);
      return;
    }
    const edges = this.spec.edges.filter((e) => e.from === node.slug && e.when === label);
    if (edges.length >= 2) {
      this.fork(
        node,
        label,
        edges.map((e) => e.to),
        own,
      );
      return;
    }
    const edge = edges[0];
    if (edge) {
      if (fork && this.forkState(fork).join === edge.to) {
        this.arrive(fork, node.slug, label, own);
        return;
      }
      this.proceed({
        from: node.slug,
        label,
        to: edge.to,
        rework: false,
        ...(own ? { feedback: { ...own, from: node.slug } } : {}),
        ...(fork ? { fork } : {}),
      });
      return;
    }
    if (!failure) {
      if (fork) {
        // The validator does not let a branch end anywhere but at the join; said here all the same.
        this.die(fork, node.slug, label, {
          source: "pipeline",
          reason: `node "${node.slug}" finished with "${label}" and its branch has no way on`,
        });
      } else if (this.s.active.length === 0 && this.s.pauses.length === 0) {
        this.end("completed");
      }
      return;
    }
    if (this.handler(node).requiresRoutes) {
      const reason = `node "${node.slug}" failed with "${label}" and nothing handles that`;
      if (fork) this.die(fork, node.slug, label, own ?? { source: "pipeline", reason });
      else this.end("failed", reason);
      return;
    }
    this.proceed({
      from: node.slug,
      label,
      to: node.slug,
      rework: true,
      ...(fork ? { fork } : {}),
    });
  }

  /** Take a route unless a limit forbids the next attempt; then the branch (or the run) pauses. */
  private proceed(route: BlockedRoute) {
    const fromRun = this.run(route.from);
    if (route.heads !== undefined) {
      // A fork held back before it fired: it fires now, once, into every head.
      this.fork(this.node(route.from), route.label, route.heads, fromRun.lastFailure);
      return;
    }
    const pauseFields = route.fork === undefined ? {} : { fork: route.fork };
    // A route into a join comes from arrivals that are settled; a branch that failed too often in a
    // row paused itself before it arrived, or arrived by a failure label the join is told about. Its
    // `from` is not looked up: a change may have removed that branch node meanwhile.
    if (route.join === undefined) {
      const from = this.node(route.from);
      if (
        fromRun.status === "failed" &&
        this.handler(from).automaticFailures &&
        fromRun.consecutiveFailures >= from.max_consecutive_failures
      ) {
        this.pause({ reason: "consecutive", node: route.from, blocked: route, ...pauseFields });
        return;
      }
    }
    const to = this.nodes.get(route.to);
    if (to === undefined) {
      // The pipeline the run is on lost the node (a change accepted on a state that still named
      // it). A route is taken on a check path, where a refusal would stall the branch for good, so
      // the branch dies with the missing node named, and the run ends by the dead-branch rule.
      const reason = `node "${route.to}" is no longer in the pipeline`;
      if (route.fork) this.die(route.fork, route.from, route.label, { source: "pipeline", reason });
      else this.end("failed", reason);
      return;
    }
    const toRun = this.run(route.to);
    if (toRun.attempt + 1 > to.max_attempts + toRun.extraAttempts) {
      this.pause({ reason: "total", node: route.to, blocked: route, ...pauseFields });
      return;
    }
    if (route.join !== undefined) {
      // Said only when the join is really entered: a route held back at the join's attempt limit
      // enters it later, by `resume` or a change, and is counted then.
      const fork = this.forkState({ id: route.join, branch: route.to });
      fork.joined += 1;
      this.log("join_reached", {
        fork: fork.id,
        join: fork.join,
        failed: fork.branches.filter((branch) => fork.arrived[branch]?.failure !== undefined),
        ...(route.feedbacks === undefined || route.feedbacks.length === 0
          ? {}
          : { feedbacks: route.feedbacks }),
      });
    }
    this.enter(route.to, route.rework, route.feedback, route.fork, route.feedbacks);
  }

  private pause(pause: Pause) {
    this.s.pauses.push(pause);
    this.log("run_paused", {
      reason: pause.reason,
      node: pause.node,
      ...this.forkFields(pause.fork),
    });
  }

  /** Drop the pause a change or a resume takes care of, and say which it was. */
  private takePause(matches: (pause: Pause) => boolean): Pause | undefined {
    const index = this.s.pauses.findIndex(matches);
    if (index < 0) return undefined;
    const [pause] = this.s.pauses.splice(index, 1);
    return pause;
  }

  // forks

  private fork(node: NodeSpec, label: string, heads: string[], own: Feedback | undefined) {
    const join = this.joinOf(heads);
    if (join === undefined) {
      this.end(
        "failed",
        `node "${node.slug}" has several edges for "${label}" but no \`join: all\` node where the branches meet`,
      );
      return;
    }
    const fromRun = this.run(node.slug);
    const [first] = heads;
    if (
      first !== undefined &&
      fromRun.status === "failed" &&
      this.handler(node).automaticFailures &&
      fromRun.consecutiveFailures >= node.max_consecutive_failures
    ) {
      // Judged once for the fork, not once per head: one pause, and the resume or the repair that
      // lifts it enters every head under one instance. Each head's own attempt limit stays its own.
      this.pause({
        reason: "consecutive",
        node: node.slug,
        blocked: {
          from: node.slug,
          label,
          to: first,
          rework: false,
          ...(own ? { feedback: { ...own, from: node.slug } } : {}),
          heads,
        },
      });
      return;
    }
    const forks = this.s.forks ?? {};
    this.s.forks = forks;
    const id = `f${Object.keys(forks).length + 1}`;
    const fork: ForkState = {
      id,
      from: node.slug,
      label,
      join,
      branches: heads,
      arrived: {},
      joined: 0,
    };
    forks[id] = fork;
    this.log("fork_started", { fork: id, node: node.slug, label, branches: heads, join });
    for (const head of heads) {
      const ref: ForkRef = { id, branch: head };
      if (head === join) {
        // A branch with no step of its own: it has arrived as soon as the fork starts.
        this.arrive(ref, node.slug, label, own);
      } else {
        this.proceed({
          from: node.slug,
          label,
          to: head,
          rework: false,
          ...(own ? { feedback: { ...own, from: node.slug } } : {}),
          fork: ref,
        });
      }
      if (this.ended) return;
    }
  }

  /** A branch settled at a node with an edge to the join. */
  private arrive(ref: ForkRef, node: string, label: string, failure: Feedback | undefined) {
    const fork = this.forkState(ref);
    this.log("branch_settled", {
      fork: fork.id,
      branch: ref.branch,
      node,
      label,
      failed: failure !== undefined,
      ...(failure ? { source: failure.source, reason: failure.reason } : {}),
    });
    fork.arrived[ref.branch] = {
      node,
      label,
      ...(failure ? { failure: { ...failure, from: node } } : {}),
      seq: this.s.seq,
    };
    this.tryJoin(fork);
  }

  /** A branch stopped with nothing to handle its failure: it is settled, but the join cannot start. */
  private die(ref: ForkRef, node: string, label: string, failure: Feedback) {
    const fork = this.forkState(ref);
    this.log("branch_settled", {
      fork: fork.id,
      branch: ref.branch,
      node,
      label,
      failed: true,
      dead: true,
      source: failure.source,
      reason: failure.reason,
    });
    fork.arrived[ref.branch] = {
      node,
      label,
      failure: { ...failure, from: node },
      dead: true,
      seq: this.s.seq,
    };
  }

  /**
   * The arrival that came last, by the order of the arrivals (`seq`); arrivals without one (a state
   * written before it was recorded) tie, and the later branch in branch order wins.
   */
  private lastArrival(fork: ForkState): Arrival {
    let last: Arrival | undefined;
    for (const branch of fork.branches) {
      const arrival = fork.arrived[branch];
      if (arrival && (last === undefined || (arrival.seq ?? 0) >= (last.seq ?? 0))) last = arrival;
    }
    return last as Arrival;
  }

  /** Enter the join once every branch has arrived and none is dead. */
  private tryJoin(fork: ForkState) {
    const arrivals = fork.branches.map((branch) => fork.arrived[branch]);
    if (arrivals.some((a) => a === undefined || a.dead)) return;
    const failed = fork.branches.filter((branch) => fork.arrived[branch]?.failure !== undefined);
    const feedbacks = failed.map((branch) => fork.arrived[branch]?.failure as Feedback);
    const last = this.lastArrival(fork);
    this.proceed({
      from: last.node,
      label: last.label,
      to: fork.join,
      rework: false,
      feedbacks,
      join: fork.id,
    });
  }

  /** The join finished with `restart_failed`: its failed branches start again, and it waits for them. */
  private restartFailed(node: NodeSpec) {
    const fork = this.forkOfJoin(node.slug);
    const branches = this.restartable(fork);
    if (!fork || branches.length === 0) {
      // The completion was checked for this; here nothing can be refused, so the run says what happened.
      this.end(
        "failed",
        `node "${node.slug}" finished with "${RESTART_FAILED}" but no branch of its fork had failed`,
      );
      return;
    }
    for (const branch of branches) {
      const arrival = fork.arrived[branch] as Arrival;
      delete fork.arrived[branch];
      this.proceed({
        from: node.slug,
        label: RESTART_FAILED,
        to: branch,
        rework: false,
        ...(arrival.failure ? { feedback: arrival.failure } : {}),
        fork: { id: fork.id, branch },
      });
      if (this.ended) return;
    }
  }

  /** The dead branches of every fork, each with why, in branch order. */
  private deadBranches(): { branch: string; arrival: Arrival }[] {
    return Object.values(this.s.forks ?? {}).flatMap((fork) =>
      fork.branches.flatMap((branch) => {
        const arrival = fork.arrived[branch];
        return arrival?.dead ? [{ branch, arrival }] : [];
      }),
    );
  }

  /**
   * After every event: the status follows what can move, and a run left with nothing to do because a
   * branch died ends `failed` with every dead branch named. Nothing else ends a run here.
   */
  settle() {
    if (this.ended) return;
    // A `restarts` pause is lifted by issuing its suspended work again; one whose work is gone (a state
    // written before late results of suspended work were refused) has nothing to resume and would
    // hold the run for good.
    this.s.pauses = this.s.pauses.filter(
      (p) => p.reason !== "restarts" || this.s.active.some((v) => v.suspended && v.node === p.node),
    );
    const { active, pauses } = this.s;
    if (active.length === 0 && pauses.length === 0) {
      const dead = this.deadBranches();
      if (dead.length > 0) {
        this.end(
          "failed",
          dead
            .map(({ branch, arrival }) => {
              const failure = arrival.failure;
              return `branch "${branch}" failed at "${arrival.node}" (${failure?.source ?? "unknown"}): ${failure?.reason ?? arrival.label}`;
            })
            .join("; "),
        );
        return;
      }
      // Nothing is left to move and nothing waits: the run ends here, not `paused` with nothing to
      // resume. A branch that never arrived has nothing to bring it to its join.
      const stranded = Object.values(this.s.forks ?? {}).flatMap((fork) =>
        fork.branches.filter((branch) => fork.arrived[branch] === undefined),
      );
      if (stranded.length > 0) {
        this.end(
          "failed",
          stranded
            .map((branch) => `branch "${branch}" stopped with nothing running and nothing paused`)
            .join("; "),
        );
      } else {
        this.end("completed");
      }
      return;
    }
    const movable = active.some((v) => v.phase === "agent" || v.phase === "human" || !v.suspended);
    this.s.status = movable ? "running" : "paused";
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
    this.s.pauses = [];
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
    if (event.type === "step_claimed") return this.claim(event);
    if (event.type === "agent_log_saved") return this.agentLogSaved(event);
    if (event.type === "agent_log_failed") return this.agentLogFailed(event);
    if (event.type === "usage_recorded") return this.usageRecorded(event);
    if (event.type === "usage_failed") return this.usageFailed(event);
    if (event.type === "cancel") {
      if (this.s.status === "running" || this.s.status === "paused") this.end("canceled");
      else throw new Repeat();
      return;
    }
    if (event.type === "resume") return this.resume(event.node);
    if (event.type === "pipeline_accepted") return this.acceptPipeline(event);
    if (event.type === "tick" || event.type === "heartbeat") {
      if (this.s.status !== "running") throw new Repeat();
    } else if (this.s.status !== "running") {
      // A late result of suspended work is the same repeat whether a sibling keeps the run going
      // or the run is paused: only `resume` issues that work again.
      if (
        (event.type === "work_finished" || event.type === "check_finished") &&
        this.s.active.some(
          (v) => v.node === event.node && v.attempt === event.attempt && v.suspended === true,
        )
      ) {
        throw new Repeat();
      }
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
          // The step was started again under its worker (a change was accepted, a check was rerun,
          // the branch was resumed): the claim is still the worker's, and the new attempt is one
          // call away.
          if (
            error instanceof KodelError &&
            error.code === "ATTEMPT_MISMATCH" &&
            event.claimToken !== undefined &&
            liveClaim(this.s.nodes[event.node], this.now)?.token === event.claimToken
          ) {
            throw fail(
              "ATTEMPT_MISMATCH",
              `${error.message}; the step was restarted; call pipeline_take_step with your token to continue`,
            );
          }
          throw error;
        }
        this.claimCrossed(event);
        const node = this.node(event.node);
        if (event.outcome !== undefined && event.outcome !== "passed") {
          const others = (
            labelsOf(this.registry, node) ?? this.handler(node).labels(node)
          ).success.slice(1);
          if (!others.includes(event.outcome)) {
            throw fail(
              "UNKNOWN_OUTCOME",
              others.length === 0
                ? `node "${node.slug}" has no outcome "${event.outcome}" (it only finishes the usual way)`
                : `node "${node.slug}" has no outcome "${event.outcome}" (it may finish with: ${others.join(", ")})`,
            );
          }
          // The reserved outcome is a claim like any other, checked here where a refusal reaches the
          // agent; once the checks have passed, `route` can only act on it.
          if (event.outcome === RESTART_FAILED) {
            const fork = this.forkOfJoin(node.slug);
            if (this.restartable(fork).length === 0) {
              const rejected = fork?.branches.some(
                (b) => fork.arrived[b]?.failure?.source === "human",
              );
              throw fail(
                "INVALID_ARGUMENTS",
                `node "${node.slug}" cannot finish with "${RESTART_FAILED}": no branch of its fork failed${
                  rejected
                    ? " (a branch a person sent back is not run again by the agent; the person decides at its gate or with kodel resume)"
                    : ""
                }`,
              );
            }
          }
          visit.declared = event.outcome;
          this.run(event.node).declared = event.outcome;
        } else {
          delete this.run(event.node).declared;
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
          ...(typeof event.changesNote === "string"
            ? { changes_note: event.changesNote.slice(0, MAX_CHANGES_ERROR) }
            : {}),
        });
        this.afterWork(visit);
        return;
      }
      case "work_finished": {
        if (this.staleResult(event)) throw new Repeat();
        const visit = this.visitFor(event.node, event.attempt, ["engine"]);
        // Work suspended after too many restarts waits for `resume`, which issues it again; a late
        // result of the run given up on is a repeat, as it was when a suspension paused the whole run.
        if (visit.suspended) throw new Repeat();
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
        if (this.staleResult(event)) throw new Repeat();
        const visit = this.visitFor(event.node, event.attempt, ["checks"]);
        if (visit.suspended || event.index !== visit.checkIndex) throw new Repeat();
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
        if (!visit || visit.suspended || (visit.phase !== "engine" && visit.phase !== "checks")) {
          throw new Repeat();
        }
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
          if (event.nodes !== undefined && !event.nodes.includes(visit.node)) continue;
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

  /**
   * A worker takes a step. The hold is on the node and keyed by the token's hash, so the worker
   * that holds it may renew it and go on after a restart of the step, and another worker meets a
   * live claim as a quiet no-op (the host reads the holder from the state). A lapsed claim is free.
   */
  private claim(event: Extract<RunEvent, { type: "step_claimed" }>) {
    if (this.s.status !== "running") throw fail("NODE_NOT_RUNNING", `the run is ${this.s.status}`);
    const open = this.s.active.filter((v) => v.phase === "agent");
    const held = open.filter((v) => liveClaim(this.s.nodes[v.node], this.now) !== undefined);
    // Judged against the requested step's own claim: a worker holding two steps renews either.
    const own = held.find(
      (v) =>
        liveClaim(this.s.nodes[v.node], this.now)?.token === event.token &&
        (event.node === undefined || v.node === event.node),
    );
    // The cap `pipeline_next_step` hands steps out under caps the steps in flight: a take meets it
    // whether it names a step or asks for the next free one, so a worker that knows a slug cannot
    // get past it; only the holder of a step renews it under the cap.
    if (own === undefined && event.maxParallel !== undefined && held.length >= event.maxParallel) {
      throw new Repeat();
    }
    const slug = event.node ?? own?.node ?? open.find((v) => !held.includes(v))?.node;
    if (slug === undefined) throw new Repeat();
    const visit = this.visitFor(slug, undefined, ["agent"]);
    const run = this.run(slug);
    const live = liveClaim(run, this.now);
    if (live !== undefined && live.token !== event.token) throw new Repeat();
    const ttl = Math.max(1_000, Math.trunc(event.ttlMs) || DEFAULT_CLAIM_TTL_S * 1000);
    run.claim = {
      token: event.token,
      at: this.now,
      until: this.now + ttl,
      by: markOf(event.token),
    };
    this.claimed = { node: slug, renewed: live !== undefined };
    const events = this.s.claimEvents ?? { claimed: 0, conflicts: 0 };
    this.s.claimEvents = events;
    if (events.claimed >= MAX_LOGGED_CLAIMS) return;
    events.claimed += 1;
    this.log("step_claimed", {
      node: slug,
      attempt: visit.attempt,
      by: run.claim.by,
      ttl_s: Math.round(ttl / 1000),
      ...(live === undefined ? {} : { renewed: true }),
      ...this.forkFields(visit.fork),
    });
  }

  /**
   * A completion that does not carry the token of the live claim on its step is accepted all the
   * same (the checks decide, not the claim) and journaled, so a run worked by two workers at once
   * can be read afterwards. The claim is released: the step is handed in.
   */
  private claimCrossed(event: Extract<RunEvent, { type: "agent_completed" }>) {
    const run = this.run(event.node);
    const live = liveClaim(run, this.now);
    if (live !== undefined && live.token !== event.claimToken) {
      const events = this.s.claimEvents ?? { claimed: 0, conflicts: 0 };
      this.s.claimEvents = events;
      if (events.conflicts < MAX_LOGGED_CLAIMS) {
        events.conflicts += 1;
        this.log("step_claim_conflict", {
          node: event.node,
          attempt: event.attempt,
          holder: live.by,
          // Whether the completion named a token at all; whose it was is not recorded.
          token_given: event.claimToken !== undefined,
        });
      }
    }
    delete run.claim;
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
    const suspend = () => {
      visit.suspended = true;
      this.pause({
        reason: "restarts",
        node: visit.node,
        ...(visit.fork === undefined ? {} : { fork: visit.fork }),
      });
    };
    if (ownerGone) {
      visit.takeovers = (visit.takeovers ?? 0) + 1;
      if (visit.takeovers > MAX_TAKEOVERS) {
        suspend();
        return;
      }
    } else {
      visit.restarts += 1;
      if (visit.restarts > this.maxRestarts) {
        suspend();
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
    visit.spec = this.s.specHash;
    if (visit.phase === "engine")
      this.effects.push(this.commandEffect(this.node(visit.node), visit, true));
    else this.emitCheck(visit, true);
  }

  /** Clear the pause of a node that the change takes care of. */
  private unpause(node: string) {
    this.takePause((p) => p.node === node || p.blocked?.from === node);
  }

  private acceptPipeline(event: Extract<RunEvent, { type: "pipeline_accepted" }>) {
    if (this.s.specHash === event.to) throw new Repeat();
    if (this.s.specHash !== event.from) {
      throw fail(
        "PIPELINE_CHANGE_REFUSED",
        "the run is no longer on the version this change was made from",
      );
    }
    // Before the change itself is judged: a change worked out for another standing may well be
    // acceptable still, but it is not the one the person looked at.
    if (event.standing !== undefined && event.standing !== standingOf(this.s)) {
      throw fail(
        "PIPELINE_CHANGE_REFUSED",
        "the run moved on since the change was shown; look at it again before accepting it",
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
      effects: diff.effects,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      ...decidedBy(event.byAgent),
    });

    // Each effect names its own node, and no node is standing in two places at once (a branch is
    // its own set of nodes), so they apply one after the other without stepping on each other. A
    // branch that ends the run on the way (a reroute into a dead end) ends it for all of them.
    for (const effect of diff.effects) {
      if (this.ended) return;
      this.applyEffect(effect);
    }
    // What is still running was not touched by the change (a touched running step is refused, a
    // suspended one restarted or rechecked above): its work keeps the version it was issued under
    // (`Visit.spec`), so its result is not dropped for naming that version.
  }

  private applyEffect(effect: AcceptEffect) {
    if (effect.kind === "restart") {
      const visit = this.s.active.find((v) => v.node === effect.node);
      if (!visit) return;
      // The attempt is closed without a verdict: it is not routed, it does not count as a failure,
      // and it does not use up an attempt of the node.
      this.s.active = this.s.active.filter((v) => v !== visit);
      this.log("node_superseded", { node: visit.node, attempt: visit.attempt });
      this.unpause(visit.node);
      this.run(visit.node).extraAttempts += 1;
      this.enter(
        visit.node,
        true,
        {
          source: "pipeline",
          reason:
            "the definition of this step was changed; the work done so far is still in the working directory",
        },
        visit.fork,
      );
    } else if (effect.kind === "recheck") {
      this.unpause(effect.node);
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
      // The attempt failed a check and the run was held back: it is opened again to be checked. It
      // is the same attempt, so it ends with the outcome the agent declared for it, not "passed".
      const run = this.run(effect.node);
      run.status = "running";
      run.consecutiveFailures = Math.max(0, run.consecutiveFailures - 1);
      // A branch that arrived by this attempt runs again: its arrival is gone until it arrives anew,
      // as with `restart_failed`. The join was not entered on it (a held route into the join counts
      // only when taken), so `joined` stays.
      if (run.fork !== undefined) {
        const fork = this.s.forks?.[run.fork.id];
        if (fork?.arrived[run.fork.branch]?.node === effect.node)
          delete fork.arrived[run.fork.branch];
      }
      const reopened: Visit = {
        node: effect.node,
        attempt: run.attempt,
        visitId: run.visitId,
        phase: "checks",
        ...(run.fork === undefined ? {} : { fork: run.fork }),
        ...(run.declared === undefined ? {} : { declared: run.declared }),
        checkIndex: 0,
        restarts: 0,
        heartbeatAt: this.now,
        startedAt: this.now,
        spec: this.s.specHash,
      };
      this.s.active.push(reopened);
      this.log("checks_rerun", { node: effect.node, attempt: run.attempt });
      this.emitCheck(reopened, false);
    } else {
      const pause = this.takePause(
        (p) =>
          p.blocked?.from === effect.node &&
          (effect.to === undefined || p.blocked.to === effect.to),
      );
      const blocked = pause?.blocked;
      if (!blocked) return;
      if (blocked.join !== undefined || routeEntersBranch(this.s, blocked)) {
        // The join was held back at its attempt limit; the branches have arrived and stay arrived,
        // so the way into the join is taken again, not the last branch's way out. The same for a
        // head held back at the fork's own edge: the instance is open, and must not fire again.
        this.proceed(blocked);
        return;
      }
      // The person accepted a repair of this very failure: like `resume`, that starts the failure
      // count over, or a branch held back for failing in a row would pause again before the new
      // definition got its turn. The attempt limit is not touched: a raised one is in the pipeline.
      this.run(blocked.from).consecutiveFailures = 0;
      this.route(this.node(blocked.from), blocked.label, true);
    }
  }

  private resume(node: string | undefined) {
    if (this.ended) throw fail("NODE_NOT_RUNNING", `the run is ${this.s.status}`);
    const { pauses } = this.s;
    if (pauses.length === 0) throw new Repeat();
    const named = pauses.map((p) => `"${p.node}"`).join(", ");
    const details = [{ field: "node", valid: pauses.map((p) => p.node) }];
    const pause = node === undefined ? pauses[0] : pauses.find((p) => p.node === node);
    if (node === undefined && pauses.length > 1) {
      throw new KodelError(
        "INVALID_ARGUMENTS",
        `the run is paused at several steps (${named}); say which one to resume`,
        details,
      );
    }
    if (!pause) {
      throw new KodelError(
        "INVALID_ARGUMENTS",
        `the run is not paused at "${node}" (it is paused at ${named})`,
        details,
      );
    }
    this.s.pauses = pauses.filter((p) => p !== pause);
    this.log("run_resumed", {
      reason: pause.reason,
      node: pause.node,
      ...this.forkFields(pause.fork),
    });

    if (pause.reason === "restarts") {
      const visit = this.s.active.find((v) => v.suspended && v.node === pause.node);
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
    // runs through several nodes, so topping up only one would just pause again at the next). In a
    // fork only the paused branch is meant: its sibling did not ask for anything; and a pause at the
    // join is the join's, not the branches' that arrived at it.
    this.run(pause.node).consecutiveFailures = 0;
    const scope =
      pause.fork === undefined ? this.outsideBranchesOf(pause.node) : this.branchNodes(pause.fork);
    for (const spec of this.spec.nodes) {
      if (scope !== undefined && !scope.has(spec.slug) && spec.slug !== pause.node) continue;
      const run = this.run(spec.slug);
      if (run.attempt >= spec.max_attempts + run.extraAttempts)
        run.extraAttempts += spec.max_attempts;
    }
    if (pause.blocked) this.proceed(pause.blocked);
  }
}

/** A run that has not started yet; `decide` fills it in on the `start` event. */
function emptyState(now: number): RunState {
  return {
    v: RECORD_VERSION,
    runId: "",
    task: "",
    specHash: "",
    status: "running",
    startedAt: now,
    nodes: {},
    active: [],
    trail: [],
    pauses: [],
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
    machine.settle();
  } catch (error) {
    if (error instanceof KodelError) return { ok: false, error };
    if (error instanceof Repeat && state) {
      return { ok: true, state, effects: [], journal: [], noop: true };
    }
    throw error;
  }
  return {
    ok: true,
    state: draft,
    effects: machine.effects,
    journal: machine.journal,
    ...(machine.claimed === undefined ? {} : { claimed: machine.claimed }),
  };
}
