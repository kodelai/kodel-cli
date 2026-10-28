/**
 * Claude Code log entries to history events, one profile per format of the log. A line of the log is an
 * `entry` with a `type`; only `user`, `assistant` and `system` entries tell what happened in the session.
 * Every other `type` (attachments, API request blobs, file history, bookkeeping) is skipped and counted:
 * the rule for unknown kinds is "skip, never guess", and unknown fields of a known entry are ignored.
 *
 * What the log needs for a correct reading, learned from real sessions:
 *  - the same API message is written once per content block with the same `message.id` and `requestId`,
 *    and its `usage` grows while it streams: one `usage` event per message, with the last usage;
 *  - a tool result comes in a later `user` entry, paired by `tool_use_id`;
 *  - an agent call is answered by a `toolUseResult.agentId` that names the subagent log file.
 */
import {
  type CaptureOptions,
  type DraftEvent,
  type FormatProfile,
  PREVIEW_CAP,
  previewOf,
  toTs,
} from "@kodel-ai/pipeline-core";

export const AGENT_ID = "claude-code";

/** Entries kept in the "already seen" sets before they are cleared; a repeat far apart is not expected. */
const SEEN_CAP = 1_000_000;
/** Calls waiting for a result; an interrupted session leaves some that never get one. */
const CALLS_CAP = 10_000;

type UsageDraft = Extract<DraftEvent, { kind: "usage" }>;

export interface ClaudeState {
  sessionId: string;
  parentSessionId: string | undefined;
  lastTs: string | undefined;
  sessionAnnounced: boolean;
  calls: Map<string, { started: string; description: string | undefined }>;
  pending: { key: string; draft: UsageDraft } | undefined;
  /** Events of `user` and `system` lines that came while a response was still being written, in order. */
  held: DraftEvent[];
  seen: Set<string>;
  skipped: number;
  /** How texts are shaped; without it a text is a 500 character preview with whitespace collapsed. */
  capture: CaptureOptions | undefined;
  /** Events at the start of the last entry's output that ended a response (the rest belong to the open one). */
  flushedCount: number;
  /** How many leading events of the last entry's output are settled: not part of a response still being written. */
  closedCount: number;
}

export function newClaudeState(
  sessionId: string,
  parentSessionId?: string,
  capture?: CaptureOptions,
): ClaudeState {
  return {
    sessionId,
    parentSessionId,
    lastTs: undefined,
    sessionAnnounced: false,
    calls: new Map(),
    pending: undefined,
    held: [],
    seen: new Set(),
    skipped: 0,
    capture,
    flushedCount: 0,
    closedCount: 0,
  };
}

type PreviewKind = "user" | "agent" | "tool_input" | "tool_result" | "detail";

/** A text as the capture options want it, or `undefined` when it is left out (metadata, or a cap of `0`). */
function preview(state: ClaudeState, kind: PreviewKind, text: string): string | undefined {
  const capture = state.capture;
  if (capture === undefined) return previewOf(text);
  if (capture.metadata === true) return undefined;
  const asked = capture.caps?.[kind];
  // A cap that is not a whole number of at least 0 is a mistake of whoever set it; the default is safer than none.
  const cap =
    typeof asked === "number" && Number.isInteger(asked) && asked >= 0 ? asked : PREVIEW_CAP;
  if (cap === 0) return undefined;
  return previewOf(text, cap, {
    ...(capture.keepLineBreaks === true ? { keepLineBreaks: true } : {}),
    ...(capture.rules === undefined ? {} : { rules: capture.rules }),
  });
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Most events held back behind one response; a log that holds more ends the response early instead. */
const HELD_CAP = 5_000;

/**
 * The usage of the message being folded, then what came between its lines, emitted when the next message
 * starts or the log ends. The usage keeps the time of the response and comes before the lines that followed it.
 */
export function flushPending(state: ClaudeState): DraftEvent[] {
  const pending = state.pending;
  state.pending = undefined;
  const held = state.held;
  state.held = [];
  if (pending === undefined) return held;
  state.seen.add(`m:${pending.key}`);
  return [pending.draft, ...held];
}

/** While a response is open the events of other lines wait behind its usage, so the order of events stays that of time. */
function settle(state: ClaudeState, out: DraftEvent[]): DraftEvent[] {
  if (state.pending === undefined) return out;
  state.held.push(...out);
  return state.held.length > HELD_CAP ? flushPending(state) : [];
}

function once(state: ClaudeState, key: string): boolean {
  if (state.seen.has(key)) return false;
  if (state.seen.size >= SEEN_CAP) state.seen.clear();
  state.seen.add(key);
  return true;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isObject(block) && block["type"] === "text" ? (str(block["text"]) ?? "") : ""))
    .filter((text) => text !== "")
    .join("\n");
}

/**
 * One entry to events, and how many leading ones are settled. A response is open from its first line until the
 * next response starts, and what the entry gives after the end of the previous response belongs to the new one;
 * a consumer that stores whole responses holds the rest back (`closedCount`).
 */
function normalizeV2(entry: unknown, state: ClaudeState): DraftEvent[] {
  state.flushedCount = 0;
  const out = normalizeEntry(entry, state);
  state.closedCount =
    state.pending === undefined ? out.length : Math.min(state.flushedCount, out.length);
  return out;
}

function normalizeEntry(entry: unknown, state: ClaudeState): DraftEvent[] {
  if (!isObject(entry)) return [];
  const type = str(entry["type"]);
  if (type !== "user" && type !== "assistant" && type !== "system") {
    state.skipped += 1;
    return [];
  }
  const stamped = toTs(entry["timestamp"]) ?? state.lastTs;
  if (stamped === undefined) {
    state.skipped += 1;
    return [];
  }
  // An entry stamped before the one above it takes that one's time, here and not later, so that `started`,
  // `ended` and `duration_ms` agree with `ts`: time does not go back, and windows rely on it.
  const ts = state.lastTs !== undefined && stamped < state.lastTs ? state.lastTs : stamped;
  state.lastTs = ts;
  const uuid = str(entry["uuid"]);
  if (uuid !== undefined && !once(state, `u:${uuid}`)) return [];

  const message = isObject(entry["message"]) ? entry["message"] : {};
  const requestId = str(entry["requestId"]);
  const messageId = str(message["id"]);
  const key =
    type === "assistant" && messageId !== undefined ? `${messageId}|${requestId ?? ""}` : undefined;

  const out: DraftEvent[] = [];
  // A response is written in several lines, and a `user` or `system` line (a tool result, a hook summary) can
  // come between them; only the start of another response ends it.
  if (state.pending !== undefined && key !== undefined && state.pending.key !== key) {
    out.push(...flushPending(state));
    state.flushedCount = out.length;
  }

  const base = {
    agent: AGENT_ID,
    agent_version: str(entry["version"]) ?? "",
    session_id: state.sessionId,
    ...(state.parentSessionId === undefined ? {} : { parent_session_id: state.parentSessionId }),
    ts,
  };

  if (!state.sessionAnnounced) {
    state.sessionAnnounced = true;
    const cwd = state.capture?.metadata === true ? undefined : str(entry["cwd"]);
    const branch = state.capture?.metadata === true ? undefined : str(entry["gitBranch"]);
    out.push({
      ...base,
      kind: "session",
      ...(cwd === undefined ? {} : { cwd }),
      ...(branch === undefined ? {} : { git_branch: branch }),
    });
  }

  if (type === "system") {
    const subtype = str(entry["subtype"]);
    if (subtype === undefined) {
      state.skipped += 1;
      return out;
    }
    const duration = entry["durationMs"];
    const content = str(entry["content"]);
    const detail =
      state.capture?.metadata === true
        ? undefined
        : typeof duration === "number"
          ? `${Math.round(duration)}ms`
          : content === undefined
            ? undefined
            : preview(state, "detail", content);
    out.push({ ...base, kind: "system", subtype, ...(detail === undefined ? {} : { detail }) });
    return settle(state, out);
  }

  const blocks = Array.isArray(message["content"]) ? message["content"] : [];

  if (type === "assistant") {
    const usage = isObject(message["usage"]) ? message["usage"] : undefined;
    const model = str(message["model"]);
    if (
      key !== undefined &&
      usage !== undefined &&
      model !== undefined &&
      model !== "<synthetic>"
    ) {
      if (!state.seen.has(`m:${key}`)) {
        const details = isObject(usage["output_tokens_details"])
          ? usage["output_tokens_details"]
          : {};
        state.pending = {
          key,
          draft: {
            ...base,
            kind: "usage",
            model,
            input: count(usage["input_tokens"]),
            output: count(usage["output_tokens"]),
            cache_read: count(usage["cache_read_input_tokens"]),
            cache_write: count(usage["cache_creation_input_tokens"]),
            reasoning: count(details["thinking_tokens"]),
            semantics: "additive",
            message_id: messageId ?? key,
            ...(requestId === undefined ? {} : { request_id: requestId }),
            cost: { basis: "unknown" },
          },
        };
      }
    }
    for (const block of blocks) {
      if (!isObject(block)) continue;
      if (block["type"] === "text") {
        const text = str(block["text"]);
        if (text !== undefined && text.trim() !== "") {
          const shown = preview(state, "agent", text);
          out.push({
            ...base,
            kind: "message",
            role: "assistant",
            ...(shown === undefined ? {} : { text_preview: shown }),
            ...(messageId === undefined ? {} : { message_id: messageId }),
          });
        }
      } else if (block["type"] === "tool_use") {
        const id = str(block["id"]);
        const name = str(block["name"]);
        if (id === undefined || name === undefined || !once(state, `c:${id}`)) continue;
        const input = block["input"];
        const description = isObject(input) ? str(input["description"]) : undefined;
        if (state.calls.size >= CALLS_CAP) {
          const oldest = state.calls.keys().next().value;
          if (oldest !== undefined) state.calls.delete(oldest);
        }
        state.calls.set(id, { started: ts, description });
        const server = name.startsWith("mcp__") ? name.split("__")[1] : undefined;
        const shownInput =
          input === undefined
            ? undefined
            : preview(state, "tool_input", JSON.stringify(input) ?? "");
        out.push({
          ...base,
          kind: "tool_call",
          id,
          name,
          ...(server === undefined || server === "" ? {} : { mcp_server: server }),
          ...(shownInput === undefined ? {} : { input_preview: shownInput }),
          started: ts,
        });
      }
    }
    return out;
  }

  // user
  if (entry["isMeta"] !== true) {
    const text = textOf(message["content"]);
    if (text.trim() !== "") {
      const shown = preview(state, "user", text);
      out.push({
        ...base,
        kind: "message",
        role: "user",
        ...(shown === undefined ? {} : { text_preview: shown }),
      });
    }
  }
  for (const block of blocks) {
    if (!isObject(block) || block["type"] !== "tool_result") continue;
    const id = str(block["tool_use_id"]);
    if (id === undefined || !once(state, `r:${id}`)) continue;
    const output = textOf(block["content"]);
    const call = state.calls.get(id);
    state.calls.delete(id);
    const duration = call === undefined ? undefined : Date.parse(ts) - Date.parse(call.started);
    const shownOutput = output === "" ? undefined : preview(state, "tool_result", output);
    out.push({
      ...base,
      kind: "tool_result",
      id,
      ok: block["is_error"] !== true,
      ended: ts,
      ...(duration === undefined || duration < 0 ? {} : { duration_ms: duration }),
      size: Buffer.byteLength(output),
      ...(shownOutput === undefined ? {} : { output_preview: shownOutput }),
    });
    const result = entry["toolUseResult"];
    const agentId = isObject(result) ? str(result["agentId"]) : undefined;
    if (agentId !== undefined && once(state, `s:${agentId}`)) {
      const described =
        call?.description ?? (isObject(result) ? str(result["description"]) : undefined);
      const shownDescription =
        described === undefined ? undefined : preview(state, "detail", described);
      out.push({
        ...base,
        kind: "subagent",
        agent_id: agentId,
        child_session_id: `agent-${agentId}`,
        ...(shownDescription === undefined ? {} : { description_preview: shownDescription }),
      });
    }
  }
  return settle(state, out);
}

/**
 * The profiles of the Claude Code log, ascending. All real logs seen so far (2.1.x) have one shape, so there
 * is one profile; a format change gets a second profile here with its fixture, and the reader picks by the
 * `version` of each entry.
 */
export const CLAUDE_PROFILES: readonly FormatProfile<unknown, ClaudeState, DraftEvent>[] = [
  { id: "cc-2", versions: ">=2.0.0 <3.0.0", normalize: normalizeV2 },
];
