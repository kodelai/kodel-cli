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
  clientOf,
  type EngineRecord,
  type ExecutorRecord,
  RECORD_VERSION,
  type ServedSurface,
  sourced,
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

/** The last lines of a file (the first of them may be cut), or nothing when it cannot be read. */
async function tailLines(path: string, bytes: number): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** What was read of a log is kept while the file stays as it was: the host asks at every call. */
const models = new Map<string, { size: number; mtimeMs: number; model: string | undefined }>();
const MAX_CACHED_LOGS = 64;

/** The model of the last answer in the end of a Claude Code session log, if there is one. */
export async function modelFromLog(path: string): Promise<string | undefined> {
  let seen: { size: number; mtimeMs: number };
  try {
    const { size, mtimeMs } = await stat(path);
    seen = { size, mtimeMs };
  } catch {
    return undefined;
  }
  const cached = models.get(path);
  if (cached && cached.size === seen.size && cached.mtimeMs === seen.mtimeMs) return cached.model;
  let model: string | undefined;
  const lines = await tailLines(path, TAIL_BYTES);
  for (let i = lines.length - 1; i >= 0 && model === undefined; i--) {
    let entry: { type?: unknown; message?: { model?: unknown } } | null;
    try {
      entry = JSON.parse(lines[i] ?? "") as typeof entry;
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const found = cleanExecutorText(entry.message?.model);
    if (found !== undefined && found !== "<synthetic>") model = found;
  }
  if (models.size >= MAX_CACHED_LOGS) models.clear();
  models.set(path, { ...seen, model });
  return model;
}

interface IndexLine {
  session_id: string;
  agent: string;
  transcript_path?: string;
  cwd: string;
}

/** The newest session the hooks registered for a directory of the project, if any. */
async function registeredSession(
  root: string,
  dirs: readonly string[],
): Promise<IndexLine | undefined> {
  const lines = await tailLines(join(root, SESSIONS_INDEX), INDEX_TAIL_BYTES);
  const real = await Promise.all(dirs.map((dir) => realOrSelf(dir)));
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
  return undefined;
}

export interface ExecutorContext {
  /** The project root, where the hook index is. */
  root: string;
  /**
   * The directories the host itself chose for the run (its working directory, the project root); a
   * session of the agent is looked for there. A directory the agent named is not one of them.
   */
  dirs: readonly string[];
  env?: NodeJS.ProcessEnv;
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
  const hooked = await registeredSession(context.root, context.dirs);
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
  for (const path of candidates) {
    // A path from a hook is not trusted to point anywhere but at the agent's own store.
    if (!isInside(realStore, await realOrSelf(path))) continue;
    const model = await modelFromLog(path);
    if (model !== undefined) {
      record.model = sourced(model, "derived");
      break;
    }
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
