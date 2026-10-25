/**
 * What the host can observe about who is acting: the client (the transport says it), the session (the
 * environment of this process, else the hook that registered it) and the model (read out of the
 * session's own log). The agent's arguments are not an input to any of it.
 */
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
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

/** How much of the end of a session log is read to find the model: the last answer is near the end. */
const TAIL_BYTES = 512 * 1024;
/** The environment variable Claude Code sets in the processes it starts. */
export const SESSION_ENV = "CLAUDE_CODE_SESSION_ID";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function engineRecord(build: BuildInfo, surface: ServedSurface | undefined): EngineRecord {
  return {
    version: build.version,
    commit: build.commit,
    record_version: RECORD_VERSION,
    meta_version: META_VERSION,
    contract_version: surface?.contract_version ?? 0,
    instructions_hash: surface === undefined ? "unknown" : sha256(surface.instructions),
    tools_hash: surface === undefined ? "unknown" : sha256(surface.tools),
  };
}

/** The model of the last answer in the end of a Claude Code session log, if there is one. */
export async function modelFromLog(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    // The first line of a tail may be cut in the middle.
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: unknown;
      try {
        entry = JSON.parse(lines[i] ?? "");
      } catch {
        continue;
      }
      const message = (entry as { type?: unknown; message?: { model?: unknown } } | null) ?? {};
      if (message.type !== "assistant") continue;
      const model = cleanExecutorText(message.message?.model);
      if (model !== undefined && model !== "<synthetic>") return model;
    }
  } catch {
    // No log, or one that cannot be read: there is no model to record, and that is not an error.
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return undefined;
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
  let text: string;
  try {
    text = await readFile(join(root, SESSIONS_INDEX), "utf8");
  } catch {
    return undefined;
  }
  const real = await Promise.all(dirs.map((dir) => realOrSelf(dir)));
  let found: IndexLine | undefined;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let record: Partial<IndexLine> | null;
    try {
      record = JSON.parse(line) as Partial<IndexLine> | null;
    } catch {
      continue;
    }
    if (typeof record?.session_id !== "string" || typeof record.cwd !== "string") continue;
    const cwd = await realOrSelf(record.cwd);
    if (real.some((dir) => isInside(dir, cwd))) found = record as IndexLine;
  }
  return found;
}

export interface ExecutorContext {
  /** The project root, where the hook index is. */
  root: string;
  /** The directories the run works in or was started from; a session of the agent is looked for there. */
  dirs: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Who is acting now. Each part is left out when it cannot be observed: a record with less in it is
 * true, one with a guess in it is not.
 */
export async function observeExecutor(
  caller: Caller | undefined,
  context: ExecutorContext,
): Promise<ExecutorRecord> {
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
  if (sessionId === undefined) return record;

  const store = join(claudeConfigDir(env), "projects");
  const candidates = [
    ...(transcript === undefined ? [] : [transcript]),
    ...context.dirs.map((dir) => join(store, projectFolderName(dir), `${sessionId}.jsonl`)),
  ];
  for (const path of candidates) {
    // A path from a hook is not trusted to point anywhere but at the agent's own store.
    if (!isInside(await realOrSelf(store), await realOrSelf(path))) continue;
    const model = await modelFromLog(path);
    if (model !== undefined) {
      record.model = sourced(model, "derived");
      break;
    }
  }
  return record;
}
