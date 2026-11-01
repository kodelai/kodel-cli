/**
 * The records of what a run's agent called: every tool call and every tool result the host's pass reads from the agent's
 * log, one row each, in the run's journal. Types and schemas only; the placing and the join are in `tool-calls.ts`. A row
 * is appended and never rewritten; whoever reads joins a result to its call by id. The state holds numbers and hashes,
 * never text or names: the state is not redacted, the journal is.
 */
import { z } from "zod";

/** The format of the payload of a `tool_calls_recorded` event; any field added to a row or to the payload bumps it. */
export const TOOL_CALLS_RECORD_FORMAT = 1;

/** How many `tool_calls_recorded` events a run journals. */
export const MAX_TOOL_CALL_EVENTS = 1_000;
/** Rows in one record (calls and results together); a pass that has more writes more records. */
export const MAX_ROWS_PER_RECORD = 200;
/** Distinct tool names in the counts of one record; the rest is counted under `other`. */
export const MAX_COUNT_TOOLS = 32;
/** The counts of one record cover at most this many attempts; the rest is counted under the unattributed key. */
export const MAX_COUNT_ATTEMPTS = 64;
/**
 * About how many bytes of rows a run journals (`JSON.stringify` length before the store redacts, so approximate).
 * Past it a record carries counts only, so a loop stays visible while the journal stays small.
 */
export const TOOL_CALL_ROW_BYTES_BUDGET = 768 * 1024;
/** Sessions (the main one, the subagents, others of the project) a run keeps a cursor for. */
export const MAX_TOOL_CALL_SESSIONS = 64;
/** The longest input preview a row may hold; `history.tool_calls.preview_chars` is at most this. */
export const MAX_TOOL_PREVIEW_CHARS = 2_000;

/** The key of the counts for what no attempt owns. */
export const UNATTRIBUTED_KEY = "-";

/** What a tool or server name may look like in a record: the state is not redacted, and the journal is read by people. */
export const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
/** A tool name that does not look like one (or that the store would rewrite) is counted under this name. */
export const OTHER_TOOL = "other";
/** The id of a call in a row: made by the host from the session and the id in the log, so it is the same for a call and its result. */
export const ROW_ID = /^id-[0-9a-f]{12}$/;

/** Why a pass could not record tool calls; each is journaled once per run. */
export const TOOL_CALLS_FAILURES = [
  "session_unknown",
  "log_missing",
  "refused",
  "unreadable",
  "busy",
  "agent_unsupported",
  /**
   * The run has journaled as many `tool_calls_recorded` as it may, or keeps a cursor for as many sessions as it may (a
   * stream past that is skipped): nothing more is recorded for it.
   */
  "cap",
  /** The run's own account refused a record: the pass stopped. */
  "record_refused",
] as const;
export type ToolCallsFailure = (typeof TOOL_CALLS_FAILURES)[number];

/** Why a tool result is an error, as the reader of the log tells it. */
export const TOOL_ERROR_KINDS = ["error", "denied", "interrupted", "hook_blocked"] as const;
export type ToolErrorKind = (typeof TOOL_ERROR_KINDS)[number];

const whole = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ts = z.string().regex(TS);
const name = z.string().regex(TOOL_NAME);
const slug = z.string().min(1).max(200);

/** A tool call the log shows. `node` and `attempt` are the attempt the call belongs to; both or none. */
export const callRowSchema = z
  .object({
    k: z.literal("c"),
    id: z.string().regex(ROW_ID),
    tool: name,
    /** The MCP server of the tool, when it is one. */
    server: name.optional(),
    /** A tool of the engine itself (`pipeline_*`); decided by name, so another server's tool of the same name is marked too. */
    own: z.literal(true).optional(),
    started: ts,
    in_bytes: whole.optional(),
    /** Redacted and cut; only when the run keeps the agent's text. */
    preview: z
      .string()
      .max(MAX_TOOL_PREVIEW_CHARS + 100)
      .optional(),
    /** The id of the subagent's own log, when the call is one of a subagent. */
    subagent: z.string().min(1).max(128).optional(),
    node: slug.optional(),
    attempt: z.number().int().positive().optional(),
    /** More than one agent step was open when the call started: the attempt is the first that was. */
    shared: z.literal(true).optional(),
  })
  .strict();
export type CallRow = z.infer<typeof callRowSchema>;

/** The outcome of a call. It has no attempt: the report takes it from the call it joins. */
export const resultRowSchema = z
  .object({
    k: z.literal("r"),
    id: z.string().regex(ROW_ID),
    ended: ts,
    ms: whole.optional(),
    ok: z.boolean(),
    err: z.enum(TOOL_ERROR_KINDS).optional(),
    out_bytes: whole.optional(),
  })
  .strict();
export type ResultRow = z.infer<typeof resultRowSchema>;

export const toolRowSchema = z.discriminatedUnion("k", [callRowSchema, resultRowSchema]);
export type ToolRow = z.infer<typeof toolRowSchema>;

/** Counts of the calls of a pass: per attempt (`node:attempt`, or `-`), per tool. Exact whatever happens to the rows. */
const counts = z.record(z.string().max(220), z.record(z.string().max(200), whole));

export const toolCallsPayloadSchema = z
  .object({
    v: z.literal(TOOL_CALLS_RECORD_FORMAT),
    rows: z.array(toolRowSchema).max(MAX_ROWS_PER_RECORD),
    counts,
    /** Lines the line reader dropped (over 8 MB) while this record's part of the log was read. */
    skipped: whole.optional(),
    /** The rows of this record were left out: the run's row budget is used. The counts are still there. */
    rows_cut: z.literal(true).optional(),
  })
  .strict();
export type ToolCallsPayload = z.infer<typeof toolCallsPayloadSchema>;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** Where the recorded part of a session ends: `seq` is the same for the same log, so it holds across a restart. */
export const toolCallsCursorSchema = z
  .object({
    last_seq: whole,
    last_key: hex64,
    /** The last pass stopped before the end of the log: more is to come. */
    behind: z.literal(true).optional(),
  })
  .strict();
export type ToolCallsCursor = z.infer<typeof toolCallsCursorSchema>;

export interface ToolCallsState {
  /** Per session: where the recorded part ends. */
  sessions: Record<string, ToolCallsCursor>;
  /** `tool_calls_recorded` events journaled; there is a limit. */
  events: number;
  /** About how many bytes of rows were journaled (see `TOOL_CALL_ROW_BYTES_BUDGET`). */
  rowBytes: number;
  /** The reasons already journaled as a failure. */
  failed: string[];
}

export function newToolCallsState(): ToolCallsState {
  return { sessions: {}, events: 0, rowBytes: 0, failed: [] };
}

/** `node:attempt` as a counts key. */
export const attemptKey = (node: string, attempt: number): string => `${node}:${attempt}`;

/** The node and attempt of a counts key, or `undefined` for the unattributed key and for one that is not an attempt. */
export function parseAttemptKey(key: string): { node: string; attempt: number } | undefined {
  const cut = key.lastIndexOf(":");
  if (cut <= 0) return undefined;
  const attempt = Number(key.slice(cut + 1));
  if (!Number.isInteger(attempt) || attempt < 1) return undefined;
  return { node: key.slice(0, cut), attempt };
}
