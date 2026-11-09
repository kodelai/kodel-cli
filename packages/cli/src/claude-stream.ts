/**
 * Claude-specific: reads the `stream-json` lines `claude -p --output-format stream-json --verbose`
 * writes and turns them into one plain line per event for the card of a run (the digest), and finds
 * the session id in them (`system/init` and `result` carry it). Pure: the tail is a string, the rules
 * are given. Everything the agent wrote goes through the redaction rules and `plain` before it is a
 * line, and the screen neutralizes it once more when it draws.
 */
import { type RedactRule, redactText } from "@kodel-ai/pipeline-core";
import { plain } from "./plain";

/** How many digest lines the card shows. */
export const DIGEST_LINES = 8;
/** How much of the latest record's stdout is read for the digest. */
export const DIGEST_TAIL_BYTES = 256 * 1024;

const TEXT_CHARS = 120;
const COMMAND_CHARS = 60;
const RESULT_CHARS = 80;

/** The one line for every event the parser cannot show; written once per digest. */
export const UNSHOWN_EVENT = "· (an event the TUI cannot show)";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The id in a `session_id` field, when it has the shape `claude` gives; anything else is no id. */
export const sessionIdField = (value: unknown): string | undefined =>
  typeof value === "string" && UUID.test(value) ? value : undefined;

/** The lines of a tail: a tail starts mid-event, so the first line is only taken when it parses. */
function* events(
  tail: string,
): Generator<{ event: Record<string, unknown> | undefined; first: boolean }> {
  // A tail cut inside a UTF-8 character starts with replacement characters: they are no event.
  const text = tail.replace(/^�+/, "");
  let first = true;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    yield { event: isObject(parsed) ? parsed : undefined, first };
    first = false;
  }
}

/** The session id the tail names: the last `result`'s, else the last `system/init`'s, else none. */
export function sessionIdOf(tail: string): string | undefined {
  let fromInit: string | undefined;
  let fromResult: string | undefined;
  for (const { event } of events(tail)) {
    if (event === undefined) continue;
    if (event.type === "result") fromResult = sessionIdField(event.session_id) ?? fromResult;
    if (event.type === "system" && event.subtype === "init") {
      fromInit = sessionIdField(event.session_id) ?? fromInit;
    }
  }
  return fromResult ?? fromInit;
}

export interface DigestOptions {
  rules?: RedactRule[];
  /**
   * A resumed session: its number (2 for the first resume), and the session id the launcher asked
   * `claude` to resume. The digest opens with `· resumed (session N)`, and says when the `init` of
   * the tail names another id (a fork: the card keeps the launcher's id).
   */
  resumed?: { session: number; sessionId?: string };
}

/** One line of text as the card shows it: redacted, made plain, on one line, cut. */
function oneLine(text: string, rules: RedactRule[], chars: number): string {
  const flat = plain(redactText(text, rules)).replace(/\s+/g, " ").trim();
  const all = [...flat];
  return all.length > chars ? `${all.slice(0, chars).join("")}…` : flat;
}

const toolArgument = (name: string, input: unknown): string | undefined => {
  if (!isObject(input)) return undefined;
  if (name === "Bash" && typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  return undefined;
};

/** The text of a `tool_result` block: a string, or the text parts of a list. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
    .filter((part) => part !== "")
    .join(" ");
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * The lines of a tail, oldest first; the caller shows the last `DIGEST_LINES`. Never a cost: the
 * person's account is theirs. An event the parser does not know, or a line that does not parse (apart
 * from the first, which a tail cuts), is one `UNSHOWN_EVENT` line for the whole digest.
 */
export function digest(tail: string, options: DigestOptions = {}): string[] {
  const rules = options.rules ?? [];
  const out: string[] = [];
  let unshown = false;
  const cannotShow = () => {
    if (unshown) return;
    unshown = true;
    out.push(UNSHOWN_EVENT);
  };
  if (options.resumed !== undefined) out.push(`· resumed (session ${options.resumed.session})`);
  for (const { event, first } of events(tail)) {
    if (event === undefined) {
      if (!first) cannotShow();
      continue;
    }
    const type = event.type;
    if (type === "system" && event.subtype === "init") {
      const tools = Array.isArray(event.tools)
        ? event.tools.filter((t) => typeof t === "string")
        : [];
      const kodel = tools.filter((t) => String(t).startsWith("mcp__kodel__")).length;
      out.push(`init · ${tools.length} tools (kodel ${kodel})`);
      const resumed = options.resumed;
      const id = sessionIdField(event.session_id);
      if (resumed?.sessionId !== undefined && id !== undefined && id !== resumed.sessionId) {
        out.push("· session id changed");
      }
      continue;
    }
    if (type === "assistant" || type === "user") {
      const message = isObject(event.message) ? event.message : undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      let shown = false;
      for (const block of blocks) {
        if (!isObject(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          if (block.text.trim() === "") continue;
          out.push(`> ${oneLine(block.text, rules, TEXT_CHARS)}`);
          shown = true;
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const name = oneLine(block.name.replace(/^mcp__kodel__/, ""), rules, COMMAND_CHARS);
          const argument = toolArgument(block.name, block.input);
          out.push(
            argument === undefined
              ? `→ ${name}`
              : `→ ${name}: ${oneLine(argument, rules, COMMAND_CHARS)}`,
          );
          shown = true;
        } else if (block.type === "tool_result") {
          const text = oneLine(resultText(block.content), rules, RESULT_CHARS);
          out.push(
            `${block.is_error === true ? "← error" : "← ok"}${text === "" ? "" : `: ${text}`}`,
          );
          shown = true;
        }
      }
      // A message with nothing to show (a thinking block, say) is not an event the person misses.
      if (!shown && blocks.length === 0) cannotShow();
      continue;
    }
    if (type === "result") {
      const parts = [event.is_error === true ? "result: error" : "result: ok"];
      if (typeof event.num_turns === "number") {
        parts.push(`${event.num_turns} turn${event.num_turns === 1 ? "" : "s"}`);
      }
      if (typeof event.duration_ms === "number") parts.push(duration(event.duration_ms));
      out.push(parts.join(" · "));
      continue;
    }
    cannotShow();
  }
  return out;
}
