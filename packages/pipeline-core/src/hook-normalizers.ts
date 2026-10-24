/**
 * Per-agent normalizers: the payload an agent sends to a hook becomes a `HookEvent`, or `undefined`
 * when it cannot be one. The payload is untrusted: a field that is missing, of another type, too long
 * or carrying control characters (terminal escapes) is dropped, and without an event name, a session
 * id and a working directory there is no event. Nothing here throws.
 *
 * Claude Code and Codex send the same shape (`hook_event_name`, `session_id`, `cwd`,
 * `transcript_path`, `tool_name`). OpenCode has no command hooks; its plugin builds that shape from
 * the events it gets and passes it to the same entry.
 */
import type { HookAgent, HookEvent } from "./hooks";

const MAX_ID = 200;
const MAX_PATH = 4096;
const MAX_NAME = 64;
const NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
// C0 and C1 controls and DEL: they would reach a file or a terminal as escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value === "" || value.length > max || CONTROL.test(value)) {
    return undefined;
  }
  return value;
}

function normalize(agent: HookAgent, payload: unknown, now: Date): HookEvent | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const raw = payload as Record<string, unknown>;
  const name = text(raw.hook_event_name, MAX_NAME);
  const sessionId = text(raw.session_id, MAX_ID);
  const cwd = text(raw.cwd, MAX_PATH);
  if (name === undefined || !NAME.test(name) || sessionId === undefined || cwd === undefined) {
    return undefined;
  }
  const event: HookEvent = { agent, name, session_id: sessionId, cwd, ts: now.toISOString(), raw };
  const transcript = text(raw.transcript_path, MAX_PATH);
  if (transcript !== undefined) event.transcript_path = transcript;
  const tool = text(raw.tool_name, MAX_NAME);
  if (tool !== undefined) event.tool = tool;
  return event;
}

export const normalizeClaudeCode = (payload: unknown, now: Date) =>
  normalize("claude-code", payload, now);

export const normalizeCodex = (payload: unknown, now: Date) => normalize("codex", payload, now);

export const normalizeOpenCode = (payload: unknown, now: Date) =>
  normalize("opencode", payload, now);

export function normalizeHookPayload(
  agent: HookAgent,
  payload: unknown,
  now: Date,
): HookEvent | undefined {
  switch (agent) {
    case "claude-code":
      return normalizeClaudeCode(payload, now);
    case "codex":
      return normalizeCodex(payload, now);
    case "opencode":
      return normalizeOpenCode(payload, now);
  }
}
