/**
 * Two narrow reads of the Claude Code logs of a project for a person looking at a run: what the agent last
 * wrote (in full, not the preview the history events keep) and what the run cost in tokens. Both only read,
 * both look at the sessions that began in the run's working directory, and nothing here is stored.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type RedactRule, redactText, type SessionRef } from "@kodel-ai/pipeline-core";
import { streamJsonl } from "../jsonl";
import { isInside, isKodelProject, realOrSelf } from "../scope";
import { claudeCodeCollector } from "./collector";
import { claudeConfigDir, firstCwd, locateClaudeSessions } from "./locate";

export interface AgentReport {
  text: string;
  /** When the agent wrote it, in milliseconds. */
  ts: number;
}

export interface AgentUsage {
  /** Input, output and cache, summed the way the history format says they add up. */
  tokens: number;
  /** What the logs reported, when they report a cost at all. */
  cost?: number;
  /** The run shares its directory with other work, so the sessions counted may not all be its own. */
  approx: boolean;
}

export interface LogOptions {
  /** The project root. */
  root: string;
  /** Where the run works. */
  workdir: string;
  /** Claude Code's data directory; `CLAUDE_CONFIG_DIR` or `~/.claude` when not given. */
  configDir?: string;
}

/** Sessions looked at for one run: the most recently written ones are the ones that matter. */
const MAX_SESSIONS = 6;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      isObject(block) && block["type"] === "text" && typeof block["text"] === "string"
        ? block["text"]
        : "",
    )
    .filter((text) => text !== "")
    .join("\n");
}

/** The sessions that began inside `workdir` and were written to at or after `from`, newest first. */
async function sessionsOf(options: LogOptions, from: number): Promise<SessionRef[]> {
  const { root, workdir } = options;
  if (!(await isKodelProject(root))) return [];
  const store = join(options.configDir ?? claudeConfigDir(), "projects");
  const home = await realOrSelf(workdir);
  const found: { ref: SessionRef; mtime: number }[] = [];
  for (const ref of await locateClaudeSessions(root, store)) {
    if (ref.parent_session_id !== undefined) continue;
    const mtime = await stat(ref.path)
      .then((s) => s.mtimeMs)
      .catch(() => 0);
    if (mtime < from) continue;
    const cwd = ref.cwd ?? (await firstCwd(ref.path));
    if (cwd === undefined || !isInside(home, await realOrSelf(cwd))) continue;
    found.push({ ref, mtime });
  }
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_SESSIONS)
    .map((f) => f.ref);
}

/** The last response of the session that has any words in it: its text blocks, joined. */
async function lastResponse(path: string): Promise<AgentReport | undefined> {
  let group: { id: string; parts: string[]; ts: number } | undefined;
  for await (const raw of streamJsonl(path)) {
    if (!isObject(raw) || raw["type"] !== "assistant" || raw["isSidechain"] === true) continue;
    const message = isObject(raw["message"]) ? raw["message"] : {};
    const text = textOf(message["content"]).trim();
    if (text === "") continue;
    const id = typeof message["id"] === "string" ? message["id"] : String(raw["uuid"] ?? "");
    const ts = typeof raw["timestamp"] === "string" ? Date.parse(raw["timestamp"]) : Number.NaN;
    if (Number.isNaN(ts)) continue;
    // A response is written one content block to a line; the lines of one response share an id.
    if (group && group.id === id) {
      group.parts.push(text);
      group.ts = ts;
    } else {
      group = { id, parts: [text], ts };
    }
  }
  return group ? { text: group.parts.join("\n\n"), ts: group.ts } : undefined;
}

/**
 * What the agent last said in the run's directory, if it said it at or after `since`: that is the report
 * it writes to the person when a run reaches a human step. Secrets are taken out like everywhere else.
 */
export async function lastAgentReport(
  options: LogOptions & { since: number; rules?: RedactRule[] },
): Promise<AgentReport | undefined> {
  let best: AgentReport | undefined;
  for (const ref of await sessionsOf(options, options.since)) {
    const found = await lastResponse(ref.path).catch(() => undefined);
    if (found && found.ts >= options.since && (best === undefined || found.ts > best.ts)) {
      best = found;
    }
  }
  return best && { text: redactText(best.text, options.rules ?? []), ts: best.ts };
}

/** One thing the agent said or did, as the history events tell it, with a tool call joined to its result. */
export interface AgentLogEntry {
  /** In milliseconds. */
  ts: number;
  kind: "text" | "you" | "call" | "subagent";
  /** What was said; for a call, what was asked of the tool. */
  text: string;
  /** For a call: the tool, and how it ended once it did. */
  tool?: string;
  result?: { ok: boolean; ms?: number; size?: number; text?: string };
}

/** Most entries kept for a run: the last ones, which are the ones a person looks for. */
const LOG_LIMIT = 4000;

/**
 * What the agent said and the tools it called in the run's directory between `from` and `to`, in the order it
 * happened. The texts are the previews the history events keep (a few hundred characters each).
 */
export async function agentLog(
  options: LogOptions & { from: number; to: number; limit?: number },
): Promise<AgentLogEntry[] | undefined> {
  const refs = await sessionsOf(options, options.from);
  if (refs.length === 0) return undefined;
  const collector = claudeCodeCollector(
    options.configDir === undefined ? {} : { configDir: options.configDir },
  );
  const window = {
    from: new Date(options.from).toISOString(),
    to: new Date(options.to).toISOString(),
  };
  const entries: AgentLogEntry[] = [];
  const calls = new Map<string, AgentLogEntry>();
  for (const ref of refs) {
    try {
      for await (const event of collector.read(ref, window)) {
        const ts = Date.parse(event.ts);
        if (event.kind === "message") {
          entries.push({
            ts,
            kind: event.role === "assistant" ? "text" : "you",
            text: event.text_preview ?? "",
          });
        } else if (event.kind === "tool_call") {
          const entry: AgentLogEntry = {
            ts,
            kind: "call",
            tool: event.mcp_server === undefined ? event.name : `${event.mcp_server}:${event.name}`,
            text: event.input_preview ?? "",
          };
          calls.set(event.id, entry);
          entries.push(entry);
        } else if (event.kind === "tool_result") {
          const call = calls.get(event.id);
          if (call) {
            call.result = {
              ok: event.ok,
              ...(event.duration_ms === undefined ? {} : { ms: event.duration_ms }),
              ...(event.size === undefined ? {} : { size: event.size }),
              ...(event.output_preview === undefined ? {} : { text: event.output_preview }),
            };
          }
        } else if (event.kind === "subagent") {
          entries.push({ ts, kind: "subagent", text: event.description_preview ?? event.agent_id });
        }
      }
    } catch {
      // A log that cannot be read adds nothing.
    }
  }
  entries.sort((a, b) => a.ts - b.ts);
  return entries.slice(-(options.limit ?? LOG_LIMIT));
}

/** Tokens (and cost, when the logs say) of the sessions in the run's directory between `from` and `to`. */
export async function agentUsage(
  options: LogOptions & { from: number; to: number },
): Promise<AgentUsage | undefined> {
  const refs = await sessionsOf(options, options.from);
  if (refs.length === 0) return undefined;
  const collector = claudeCodeCollector(
    options.configDir === undefined ? {} : { configDir: options.configDir },
  );
  const window = {
    from: new Date(options.from).toISOString(),
    to: new Date(options.to).toISOString(),
  };
  let tokens = 0;
  let cost = 0;
  let priced = false;
  for (const ref of refs) {
    try {
      for await (const event of collector.read(ref, window)) {
        if (event.kind !== "usage") continue;
        const cached = event.semantics === "overlap" ? 0 : event.cache_read;
        tokens += event.input + event.output + event.cache_write + cached;
        const amount = event.cost?.amount;
        if (amount !== undefined) {
          cost += amount;
          priced = true;
        }
      }
    } catch {
      // A log that cannot be read adds nothing; the numbers are an approximation either way.
    }
  }
  const root = await realOrSelf(options.root);
  const approx = (await realOrSelf(options.workdir)) === root;
  return { tokens, ...(priced ? { cost } : {}), approx };
}
