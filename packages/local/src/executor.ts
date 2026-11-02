/**
 * What the host can observe about who is acting: the client (the transport says it), the session (the
 * environment of this process, else the hook that registered it) and the model (read out of the
 * session's own log). The agent's arguments are not an input to any of it.
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type Caller,
  cleanExecutorText,
  cleanSessionName,
  clientOf,
  type EngineRecord,
  type ExecutorRecord,
  RECORD_VERSION,
  type RedactRule,
  redactText,
  SAFE_SESSION_ID,
  type ServedSurface,
  sourced,
  stripSessionName,
} from "@kodel-ai/pipeline-core";
import { claudeConfigDir, projectFolderName } from "./history/claude-code/locate";
import { isInside, realOrSelf } from "./history/scope";
import { SESSIONS_INDEX } from "./hooks/session-registrar";
import { META_VERSION } from "./store";

/** The program that serves the run; the build stamps it. */
export interface BuildInfo {
  version: string;
  commit: string;
}

export const UNKNOWN_BUILD: BuildInfo = { version: "unknown", commit: "unknown" };

/** How much of the end of a file is read: the newest lines of a log or of the hook index are there. */
const TAIL_BYTES = 512 * 1024;
const INDEX_TAIL_BYTES = 64 * 1024;
/** How far back in the hook index a session of this project is looked for. */
const INDEX_SCAN_MAX_BYTES = 1024 * 1024;
/** The environment variable Claude Code sets in the processes it starts. */
export const SESSION_ENV = "CLAUDE_CODE_SESSION_ID";
/** What a session id looks like; anything else is never put into a path. */
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function engineRecord(build: BuildInfo, surface: ServedSurface | undefined): EngineRecord {
  return {
    version: build.version,
    commit: build.commit,
    record_version: RECORD_VERSION,
    meta_version: META_VERSION,
    // Left out when the host was not given what the agent was served: a made-up value would look real.
    ...(surface === undefined
      ? {}
      : {
          contract_version: surface.contract_version,
          instructions_hash: sha256(surface.instructions),
          tools_hash: sha256(surface.tools),
        }),
  };
}

/**
 * The last lines of a file (the first of them may be cut), or nothing when it cannot be read; `whole`
 * says the lines are all of the file.
 */
async function tailOf(path: string, bytes: number): Promise<{ lines: string[]; whole: boolean }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return { lines, whole: start === 0 };
  } catch {
    return { lines: [], whole: true };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function tailLines(path: string, bytes: number): Promise<string[]> {
  return (await tailOf(path, bytes)).lines;
}

/** What was read of a log is kept while the file stays as it was: the host asks at every call. */
interface LogFacts {
  model: string | undefined;
  name: string | undefined;
}
const facts = new Map<string, { size: number; mtimeMs: number; facts: LogFacts }>();
const MAX_CACHED_LOGS = 64;

/** The model of the last answer in the lines, if there is one. */
function modelOfLines(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: unknown; message?: { model?: unknown } } | null;
    try {
      entry = JSON.parse(lines[i] ?? "") as typeof entry;
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const found = cleanExecutorText(entry.message?.model);
    if (found !== undefined && found !== "<synthetic>") return found;
  }
  return undefined;
}

/**
 * The name the session has in its own log: the last `custom-title` (the person's `/rename`), else the
 * last `agent-name` (what the agent shows), else the last `ai-title` (the summary the agent makes of the
 * session; an automatic session of Claude Code may have only that one). Only the records of this session
 * count, a log of a resumed or forked session holds the records of others. A line is parsed only if
 * it holds one of the two words, so the cost of a long tail is a string search.
 */
function nameOfLines(lines: readonly string[], sessionId: string): string | undefined {
  let custom: string | undefined;
  let shown: string | undefined;
  let summary: string | undefined;
  for (let i = lines.length - 1; i >= 0 && custom === undefined; i--) {
    const line = lines[i] ?? "";
    const isCustom = line.includes('"custom-title"');
    const isShown = !isCustom && line.includes('"agent-name"');
    const isSummary = !isCustom && !isShown && line.includes('"ai-title"');
    if (!isCustom && !isShown && !isSummary) continue;
    // Only the newest of the two weaker kinds counts, but an older `custom-title` still beats them.
    if (isShown && shown !== undefined) continue;
    if (isSummary && summary !== undefined) continue;
    let entry: {
      type?: unknown;
      sessionId?: unknown;
      customTitle?: unknown;
      agentName?: unknown;
      aiTitle?: unknown;
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object" || entry.sessionId !== sessionId) continue;
    if (entry.type === "custom-title") custom = stripSessionName(entry.customTitle);
    else if (entry.type === "agent-name") shown ??= stripSessionName(entry.agentName);
    else if (entry.type === "ai-title") summary ??= stripSessionName(entry.aiTitle);
  }
  return custom ?? shown ?? summary;
}

/**
 * The model of the last answer and, when the session is named, its name, read once from the end of a
 * Claude Code session log. The result is kept per file and session while the file stays as it was.
 */
export async function logFacts(path: string, sessionId?: string): Promise<LogFacts> {
  const none: LogFacts = { model: undefined, name: undefined };
  let seen: { size: number; mtimeMs: number };
  try {
    const { size, mtimeMs } = await stat(path);
    seen = { size, mtimeMs };
  } catch {
    return none;
  }
  const key = `${path}\0${sessionId ?? ""}`;
  const cached = facts.get(key);
  if (cached && cached.size === seen.size && cached.mtimeMs === seen.mtimeMs) return cached.facts;
  const lines = await tailLines(path, TAIL_BYTES);
  const found: LogFacts = {
    model: modelOfLines(lines),
    name: sessionId === undefined ? undefined : nameOfLines(lines, sessionId),
  };
  if (facts.size >= MAX_CACHED_LOGS) facts.clear();
  facts.set(key, { ...seen, facts: found });
  return found;
}

/** The model of the last answer in the end of a Claude Code session log, if there is one. */
export async function modelFromLog(path: string): Promise<string | undefined> {
  return (await logFacts(path)).model;
}

interface IndexLine {
  session_id: string;
  agent: string;
  transcript_path?: string;
  cwd: string;
}

/**
 * The newest session the hooks registered for a directory of the project, if any. The end of the
 * index is read first and, when no line there fits, further back (up to `INDEX_SCAN_MAX_BYTES`):
 * with clones sharing one index, the lines of another checkout can fill the end of it.
 */
async function registeredSession(
  indexPath: string,
  dirs: readonly string[],
): Promise<IndexLine | undefined> {
  const real = await Promise.all(dirs.map((dir) => realOrSelf(dir)));
  for (let bytes = INDEX_TAIL_BYTES; ; bytes *= 4) {
    const { lines, whole } = await tailOf(indexPath, bytes);
    // Newest first: the index only grows, so the first line that fits is the answer.
    for (let i = lines.length - 1; i >= 0; i--) {
      let record: Partial<IndexLine> | null;
      try {
        record = JSON.parse(lines[i] ?? "") as Partial<IndexLine> | null;
      } catch {
        continue;
      }
      if (typeof record?.session_id !== "string" || typeof record.cwd !== "string") continue;
      const cwd = await realOrSelf(record.cwd);
      if (real.some((dir) => isInside(dir, cwd))) return record as IndexLine;
    }
    if (whole || bytes >= INDEX_SCAN_MAX_BYTES) return undefined;
  }
}

export interface ExecutorContext {
  /** The project root, where the hook index is (unless `indexPath` says otherwise). */
  root: string;
  /** The hook index, when it is not `<root>/.kodel/sessions.jsonl` (`storage: home`). */
  indexPath?: string;
  /**
   * The directories the host itself chose for the run (its working directory, the project root); a
   * session of the agent is looked for there. A directory the agent named is not one of them.
   */
  dirs: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** The redaction rules of the project: the name of the session is redacted before it is cut. */
  rules?: readonly RedactRule[];
}

async function observe(caller: Caller | undefined, context: ExecutorContext) {
  const env = context.env ?? process.env;
  const record: ExecutorRecord = {};
  const client = clientOf(caller);
  if (client) record.client = client;

  // The environment is exact: the agent starts one server per session. The hook index lists every
  // session of the project, so with several open it can only say which one started last.
  let sessionId = cleanExecutorText(env[SESSION_ENV]);
  let transcript: string | undefined;
  const hooked = await registeredSession(
    context.indexPath ?? join(context.root, SESSIONS_INDEX),
    context.dirs,
  );
  if (sessionId !== undefined) {
    record.session = sourced(sessionId, "observed-env");
    if (hooked?.session_id === sessionId) transcript = hooked.transcript_path;
  } else if (hooked) {
    sessionId = cleanExecutorText(hooked.session_id);
    if (sessionId !== undefined) record.session = sourced(sessionId, "observed-hook");
    transcript = hooked.transcript_path;
  }
  if (sessionId === undefined || !SAFE_SESSION.test(sessionId)) return record;

  const store = join(claudeConfigDir(env), "projects");
  const realStore = await realOrSelf(store);
  const candidates = [
    ...(transcript === undefined ? [] : [transcript]),
    ...context.dirs.map((dir) => join(store, projectFolderName(dir), `${sessionId}.jsonl`)),
  ];
  // The name is read only for an id of the strict form: it is the one every reader of the logs trusts.
  const nameOf = SAFE_SESSION_ID.test(sessionId) ? sessionId : undefined;
  for (const path of candidates) {
    // A path from a hook is not trusted to point anywhere but at the agent's own store.
    if (!isInside(realStore, await realOrSelf(path))) continue;
    const read = await logFacts(path, nameOf);
    if (record.model === undefined && read.model !== undefined) {
      record.model = sourced(read.model, "derived");
    }
    if (record.session_name === undefined && read.name !== undefined) {
      // Redacted before it is cut, so that a secret is whole when the rules meet it.
      const name = cleanSessionName(redactText(read.name, [...(context.rules ?? [])]));
      if (name !== undefined) record.session_name = sourced(name, "derived");
    }
    if (record.model !== undefined && (nameOf === undefined || read.name !== undefined)) break;
  }
  return record;
}

/**
 * Who is acting now. Each part is left out when it cannot be observed: a record with less in it is
 * true, one with a guess in it is not. It never fails the call it is written for: whatever cannot be
 * read leaves a record with less in it.
 */
export async function observeExecutor(
  caller: Caller | undefined,
  context: ExecutorContext,
): Promise<ExecutorRecord> {
  try {
    return await observe(caller, context);
  } catch {
    const client = clientOf(caller);
    return client ? { client } : {};
  }
}
