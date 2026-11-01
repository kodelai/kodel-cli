/**
 * Run-state format 1, the format of every run written before forks (the early builds, the published
 * beta, `main` at 12f8578): one pause (`pause`), one visit at a time, one effect per accepted
 * pipeline change (`effect`), no claims.
 *
 * Format 1 is one family: every writer of `v: 1` wrote a subset of the shape below, so one decoder
 * reads all of them. The decoder is closed: a key or a value no writer of format 1 ever wrote is
 * "cannot read", never carried along; a key that belongs to a later format is said so. The encoder
 * is an allow-list: every field of the model is written or the write is refused, and nothing is
 * dropped. A format that cannot hold a state says so before anything is written
 * (`UNSUPPORTED_FORMAT_FEATURE`), so the run stays as it was.
 *
 * `history`, `served`, `agentLog` and `usage` are bookkeeping the source marks as information only
 * ("nothing here feeds a check, a route or a gate"): they are checked to be objects and passed
 * through as they are.
 */
import { KodelError } from "../errors";
import type { BlockedRoute, JournalRecord, NodeRun, Pause, RunState, Visit } from "../run";
import { cannotHoldError, withRunId } from "./messages";
import type { FormatCapabilities, FormatCodec } from "./types";

export const V1_CAPABILITIES: FormatCapabilities = {
  version: 1,
  forks: false,
  claims: false,
  visitSpec: false,
  keepsDeclaredAfterFailedCheck: false,
  firstDuplicateEdgeWins: true,
  pipelineFeatures: [],
};

type Plain = Record<string, unknown>;

const isObject = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ── what format 1 ever wrote ────────────────────────────────────────────────

const RUN_STATUSES = ["running", "paused", "completed", "failed", "canceled"];
const NODE_STATUSES = ["pending", "running", "waiting", "rework", "passed", "failed", "skipped"];
const PHASES = ["agent", "engine", "checks", "human"];
const PAUSE_REASONS = ["consecutive", "total", "restarts"];

/**
 * What format 1 does with each field of the model. The tables are typed by the model, so a field
 * added to it does not compile until someone says what format 1 does with it (AGENTS.md, rule 5):
 * `kept` is stored under its own name, `refused` has no place in the format (a later one), and the
 * one field the format stores under another name is `renamed`.
 */
type Disposition = "kept" | "refused" | "renamed";

const STATE_TABLE = {
  v: "kept",
  runId: "kept",
  task: "kept",
  slug: "kept",
  taskKey: "kept",
  specHash: "kept",
  status: "kept",
  startedAt: "kept",
  finishedAt: "kept",
  nodes: "kept",
  active: "kept",
  trail: "kept",
  pauses: "renamed", // stored as `pause`: one at most
  forks: "refused",
  nextVisitId: "kept",
  seq: "kept",
  refusals: "kept",
  proposals: "kept",
  claimEvents: "refused",
  workdir: "kept",
  pipelineFile: "kept",
  history: "kept",
  engineVersion: "kept",
  served: "kept",
  servedEvents: "kept",
  agentLog: "kept",
  usage: "kept",
} satisfies Record<keyof RunState, Disposition>;

const NODE_TABLE = {
  slug: "kept",
  status: "kept",
  outcome: "kept",
  attempt: "kept",
  consecutiveFailures: "kept",
  extraAttempts: "kept",
  visitId: "kept",
  lastFailure: "kept",
  lastFailures: "refused",
  fork: "refused",
  declared: "refused", // format 1 keeps the declared outcome on the visit only
  removed: "kept",
  claim: "refused",
} satisfies Record<keyof NodeRun, Disposition>;

const VISIT_TABLE = {
  node: "kept",
  attempt: "kept",
  visitId: "kept",
  phase: "kept",
  fork: "refused",
  checkIndex: "kept",
  heartbeatAt: "kept",
  owner: "kept",
  declared: "kept",
  restarts: "kept",
  takeovers: "kept",
  suspended: "kept",
  startedAt: "kept",
  spec: "refused",
} satisfies Record<keyof Visit, Disposition>;

const BLOCKED_TABLE = {
  from: "kept",
  label: "kept",
  to: "kept",
  rework: "kept",
  feedback: "kept",
  feedbacks: "refused",
  fork: "refused",
  join: "refused",
  heads: "refused",
} satisfies Record<keyof BlockedRoute, Disposition>;

const PAUSE_TABLE = {
  reason: "kept",
  node: "kept",
  blocked: "kept",
  fork: "refused",
} satisfies Record<keyof Pause, Disposition>;

const keysOf = (table: Record<string, Disposition>, ...of: Disposition[]) =>
  Object.entries(table)
    .filter(([, disposition]) => of.includes(disposition))
    .map(([key]) => key);

/** The keys of `state.json` in format 1; `pause` is the one the model calls `pauses`. */
export const V1_STATE_KEYS = [...keysOf(STATE_TABLE, "kept"), "pause"];
export const V1_NODE_KEYS = keysOf(NODE_TABLE, "kept");
export const V1_VISIT_KEYS = keysOf(VISIT_TABLE, "kept");
export const V1_BLOCKED_KEYS = keysOf(BLOCKED_TABLE, "kept");
export const V1_PAUSE_KEYS = keysOf(PAUSE_TABLE, "kept");
const FEEDBACK_KEYS = ["source", "reason", "from", "check_id"];
/** The bookkeeping blobs that pass through unchecked beyond being objects. */
const OPAQUE_KEYS = ["history", "served", "agentLog", "usage"];

/** Keys that belong to a later format; named in the message so the cause is plain. */
const LATER_STATE_KEYS = [...keysOf(STATE_TABLE, "refused"), "pauses"];
const LATER_NODE_KEYS = keysOf(NODE_TABLE, "refused");
const LATER_VISIT_KEYS = keysOf(VISIT_TABLE, "refused");
const LATER_BLOCKED_KEYS = keysOf(BLOCKED_TABLE, "refused");
const LATER_PAUSE_KEYS = keysOf(PAUSE_TABLE, "refused");

/** Events of format 1. A journal record of any other event is not written into a run of format 1. */
export const V1_EVENTS = [
  "agent_completed",
  "agent_log_failed",
  "agent_log_saved",
  "call_refused",
  "changes_recorded",
  "check_finished",
  "checks_rerun",
  "command_finished",
  "feedback_reported",
  "gate_decided",
  "gate_waiting",
  "manual_edit",
  "node_entered",
  "node_finished",
  "node_restarted",
  "node_superseded",
  "pipeline_accepted",
  "pipeline_change_proposed",
  "report_accepted",
  "run_finished",
  "run_paused",
  "run_resumed",
  "run_started",
  "served_write_failed",
  "step_served",
  "task_link",
  "usage_failed",
  "usage_recorded",
];
/** Events that exist only since forks and claims. */
export const V2_ONLY_EVENTS = [
  "run_migrated",
  "fork_started",
  "branch_settled",
  "join_reached",
  "step_claimed",
  "step_claim_conflict",
];
/**
 * The journal field a fork adds to existing events (with `branch`, which the events of format 1 use
 * for a git branch, so `fork` is the mark).
 */
const FORK_RECORD_FIELDS = ["fork"];
const ACCEPT_EFFECT_KINDS = ["restart", "recheck", "reroute"];

// ── errors ──────────────────────────────────────────────────────────────────

function cannotRead(runId: unknown, why: string): KodelError {
  const id = typeof runId === "string" ? ` of run ${runId}` : "";
  return new KodelError(
    "UNSUPPORTED_FORMAT",
    `the state${id} is written in run-state format 1 and cannot be read: ${why}`,
  );
}

function cannotHold(what: string): KodelError {
  return cannotHoldError(1, what);
}

/** Every key of `obj` must be in `allowed`; a key of a later format is named as such. */
function closed(
  obj: Plain,
  allowed: readonly string[],
  later: readonly string[],
  where: string,
  runId: unknown,
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) continue;
    throw cannotRead(
      runId,
      later.includes(key)
        ? `${where} has "${key}", which belongs to a later format`
        : `${where} has "${key}", which format 1 never had`,
    );
  }
}

function oneOf(value: unknown, allowed: readonly string[], where: string, runId: unknown): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw cannotRead(runId, `${where} is ${JSON.stringify(value)}`);
  }
}

// ── decode ──────────────────────────────────────────────────────────────────

function decodeFeedback(raw: unknown, where: string, runId: unknown): void {
  if (!isObject(raw)) throw cannotRead(runId, `${where} is not an object`);
  closed(raw, FEEDBACK_KEYS, [], where, runId);
}

function decodeBlocked(raw: unknown, runId: unknown): Plain {
  if (!isObject(raw)) throw cannotRead(runId, "a held-back route is not an object");
  closed(raw, V1_BLOCKED_KEYS, LATER_BLOCKED_KEYS, "a held-back route", runId);
  if (raw.feedback !== undefined) decodeFeedback(raw.feedback, "a route's feedback", runId);
  return { ...raw };
}

function decodePause(raw: unknown, runId: unknown): Plain {
  if (!isObject(raw)) throw cannotRead(runId, "the pause is not an object");
  closed(raw, V1_PAUSE_KEYS, LATER_PAUSE_KEYS, "the pause", runId);
  oneOf(raw.reason, PAUSE_REASONS, "the reason of the pause", runId);
  const out: Plain = { ...raw };
  if (raw.blocked !== undefined) out.blocked = decodeBlocked(raw.blocked, runId);
  return out;
}

function encodeChecked(
  obj: Plain,
  allowed: readonly string[],
  later: readonly string[],
  where: string,
): Plain {
  const out: Plain = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (!allowed.includes(key)) {
      throw cannotHold(
        later.includes(key) ? `${where} with "${key}"` : `${where} with the field "${key}"`,
      );
    }
    out[key] = value;
  }
  return out;
}

function encodePause(pause: Plain): Plain {
  const out = encodeChecked(pause, V1_PAUSE_KEYS, LATER_PAUSE_KEYS, "the pause");
  if (isObject(out.blocked)) {
    out.blocked = encodeChecked(
      out.blocked,
      V1_BLOCKED_KEYS,
      LATER_BLOCKED_KEYS,
      "a held-back route",
    );
  }
  return out;
}

export const v1Codec: FormatCodec = {
  version: 1,
  capabilities: V1_CAPABILITIES,

  decodeState(raw) {
    if (!isObject(raw)) throw cannotRead(undefined, "it is not an object");
    const runId = raw.runId;
    if (raw.v !== 1) throw cannotRead(runId, `its format is ${String(raw.v)}`);
    closed(raw, V1_STATE_KEYS, LATER_STATE_KEYS, "the state", runId);
    if (typeof runId !== "string") throw cannotRead(runId, "it has no run id");
    oneOf(raw.status, RUN_STATUSES, "the status", runId);
    if (!isObject(raw.nodes)) throw cannotRead(runId, "it has no nodes");
    if (!Array.isArray(raw.active)) throw cannotRead(runId, "it has no list of active visits");
    if (!Array.isArray(raw.trail)) throw cannotRead(runId, "it has no trail");
    for (const key of OPAQUE_KEYS) {
      if (raw[key] !== undefined && !isObject(raw[key])) {
        throw cannotRead(runId, `"${key}" is not an object`);
      }
    }

    const nodes: Plain = {};
    for (const [slug, node] of Object.entries(raw.nodes)) {
      if (!isObject(node)) throw cannotRead(runId, `the node "${slug}" is not an object`);
      closed(node, V1_NODE_KEYS, LATER_NODE_KEYS, `the node "${slug}"`, runId);
      oneOf(node.status, NODE_STATUSES, `the status of the node "${slug}"`, runId);
      if (node.lastFailure !== undefined) {
        decodeFeedback(node.lastFailure, `the last failure of "${slug}"`, runId);
      }
      nodes[slug] = { ...node };
    }
    const active = raw.active.map((visit: unknown) => {
      if (!isObject(visit)) throw cannotRead(runId, "an active visit is not an object");
      closed(visit, V1_VISIT_KEYS, LATER_VISIT_KEYS, "an active visit", runId);
      oneOf(visit.phase, PHASES, "the phase of an active visit", runId);
      return { ...visit };
    });

    const { pause, ...rest } = raw;
    const pauses = pause === undefined ? [] : [decodePause(pause, runId)];
    return { ...rest, nodes, active, pauses } as unknown as RunState;
  },

  encodeState(state) {
    try {
      return encodeV1State(state);
    } catch (error) {
      throw error instanceof KodelError ? withRunId(error, state.runId) : error;
    }
  },

  decodeRecord(raw) {
    return decodeV1Record(raw);
  },

  encodeRecord(record) {
    return encodeV1Record(record);
  },
};

function encodeV1State(state: RunState): unknown {
  if (state.v !== 1) {
    throw new KodelError(
      "UNSUPPORTED_FORMAT_FEATURE",
      `a state of format ${state.v} was given to the encoder of format 1`,
    );
  }
  if (state.forks !== undefined) throw cannotHold("a fork");
  if (state.claimEvents !== undefined) throw cannotHold("a worker's claim on a step");
  if (state.pauses.length > 1) throw cannotHold("more than one pause");
  if (state.active.length > 1) throw cannotHold("more than one step at a time");
  // `paused` and the pause go together in this format; the engine of a fork derives the status.
  const open = state.status === "running" || state.status === "paused";
  if (open && (state.pauses.length === 1) !== (state.status === "paused")) {
    throw cannotHold("a pause and a status that do not agree");
  }
  const out: Plain = {};
  for (const [key, value] of Object.entries(state)) {
    if (value === undefined) continue;
    if (key === "pauses") {
      const [pause] = state.pauses;
      if (pause !== undefined) out.pause = encodePause(pause as unknown as Plain);
    } else if (key === "nodes") {
      const nodes: Plain = {};
      for (const [slug, node] of Object.entries(state.nodes)) {
        nodes[slug] = encodeChecked(
          node as unknown as Plain,
          V1_NODE_KEYS,
          LATER_NODE_KEYS,
          `the node "${slug}"`,
        );
      }
      out.nodes = nodes;
    } else if (key === "active") {
      out.active = state.active.map((visit) =>
        encodeChecked(
          visit as unknown as Plain,
          V1_VISIT_KEYS,
          LATER_VISIT_KEYS,
          "an active visit",
        ),
      );
    } else if (V1_STATE_KEYS.includes(key)) {
      out[key] = value;
    } else {
      throw cannotHold(`the field "${key}"`);
    }
  }
  return out;
}

function decodeV1Record(raw: unknown): JournalRecord {
  if (!isObject(raw)) throw cannotRead(undefined, "a journal record is not an object");
  if (raw.event !== "pipeline_accepted" || raw.effects !== undefined) return raw as JournalRecord;
  const { effect, ...rest } = raw;
  const effects = isObject(effect) && effect.kind !== "none" ? [effect] : [];
  return { ...rest, effects } as unknown as JournalRecord;
}

function encodeV1Record(record: JournalRecord): unknown {
  if (record.v !== 1) {
    throw new KodelError(
      "UNSUPPORTED_FORMAT_FEATURE",
      `a journal record of format ${record.v} was given to the encoder of format 1`,
    );
  }
  if (!V1_EVENTS.includes(record.event)) throw cannotHold(`the event "${record.event}"`);
  for (const field of FORK_RECORD_FIELDS) {
    if (record[field] !== undefined) throw cannotHold(`a fork attribution ("${field}")`);
  }
  if (record.event !== "pipeline_accepted") return record;
  const { effects, ...rest } = record;
  if (effects === undefined) return record;
  if (!Array.isArray(effects)) throw cannotHold("a malformed list of effects");
  if (effects.length > 1) throw cannotHold("more than one effect of one change");
  const [effect] = effects;
  if (effect === undefined) return { ...rest, effect: { kind: "none" } };
  if (!isObject(effect) || !ACCEPT_EFFECT_KINDS.includes(String(effect.kind))) {
    throw cannotHold(`the effect ${JSON.stringify(effect)}`);
  }
  return { ...rest, effect };
}
