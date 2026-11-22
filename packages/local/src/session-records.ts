import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type AgentRecord,
  decodeRecord,
  encodeRecord,
  type NameMarker,
  type RecordKind,
  SESSION_FORMAT_VERSION,
  type SessionRecord,
  type SessionSnapshot,
  type StatusRecord,
} from "@kodel-ai/pipeline-core";
import { sameProcess } from "./process-table";

export type {
  AgentRecord,
  NameMarker,
  SessionRecord,
  StatusRecord,
  StopRecord,
} from "@kodel-ai/pipeline-core";

export const SESSION_FILE = "session.json";
export const STATUS_FILE = "status.json";
export const STOP_FILE = "stop.json";
export const TAIL_FILE = "tail.txt";
export const AGENT_FILE = "agent.json";

const readJson = (path: string): unknown | "missing" | "unreadable" => {
  if (!existsSync(path)) return "missing";
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return "unreadable";
  }
};

type Read<T> = T | "missing" | "unreadable" | "newer";

const readRecord = <K extends RecordKind>(
  kind: K,
  path: string,
): Read<Extract<ReturnType<typeof decodeRecord<K>>, { ok: true }>["record"]> => {
  const value = readJson(path);
  if (value === "missing" || value === "unreadable") return value;
  const decoded = decodeRecord(kind, value);
  if (decoded.ok) return decoded.record;
  return decoded.code === "NEWER_FORMAT" ? "newer" : "unreadable";
};

export const readSession = (dir: string): Read<SessionRecord> =>
  readRecord("session", join(dir, SESSION_FILE));

export const readStatus = (dir: string): Read<StatusRecord> =>
  readRecord("status", join(dir, STATUS_FILE));

export const readStop = (dir: string): "missing" | "unreadable" | "newer" | "present" => {
  const value = readRecord("stop", join(dir, STOP_FILE));
  if (value === "missing") return "missing";
  return typeof value === "string" ? value : "present";
};

/** `missing` for a session from before the record existed, or one that runs no agent. */
export const readAgent = (dir: string): Read<AgentRecord> =>
  readRecord("agent", join(dir, AGENT_FILE));

export const readMarker = (path: string): Read<NameMarker> => readRecord("name", path);

/** Exclusive create: a second writer fails. Used for the first `status.json`, the tombstone and the name marker. */
export const createExclusive = (path: string, text: string): boolean => {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return true;
};

/** Replace a record: a temporary file and a rename, so a reader never sees half a file. */
export const replaceRecord = (path: string, text: string): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
};

/**
 * `session.json` appears with the directory or not at all: written in a temporary directory, then renamed in.
 * The `agent` record is written once, here, before `session.json` (the file that makes the folder a session), so
 * no session exists without the id of its agent's conversation.
 */
export const publishSession = (dir: string, record: SessionRecord, agent?: AgentRecord): void => {
  const tmp = `${dir}.tmp-${process.pid}`;
  mkdirSync(tmp, { mode: 0o700 });
  if (agent !== undefined) {
    writeFileSync(join(tmp, AGENT_FILE), encodeRecord("agent", agent), { mode: 0o600 });
  }
  writeFileSync(join(tmp, SESSION_FILE), encodeRecord("session", record), { mode: 0o600 });
  renameSync(tmp, dir);
};

export const removeDir = (path: string): void => rmSync(path, { recursive: true, force: true });

/**
 * Asked only for a record whose holder is gone and never recorded its child's end, when the recorded child is
 * gone too: does a process of the child's group still run? (`since` is when the session began.)
 */
export type OrphanCheck = (child: NonNullable<StatusRecord["child"]>, since: number) => boolean;

export const snapshotOf = (dir: string, orphans?: OrphanCheck): SessionSnapshot => {
  if (!existsSync(dir)) {
    return {
      exists: false,
      session: "missing",
      status: "missing",
      holderAlive: false,
      childAlive: false,
      stop: "missing",
    };
  }
  const session = readSession(dir);
  const status = readStatus(dir);
  const stop = readStop(dir);
  const agent = readAgent(dir);
  const live =
    status !== "missing" && status !== "unreadable" && status !== "newer" ? status : undefined;
  // A newer format anywhere in the folder is "upgrade kodel", whichever file it is in.
  const newer = session === "newer" || status === "newer" || stop === "newer" || agent === "newer";
  const holderAlive =
    live?.holder !== undefined && sameProcess(live.holder.pid, live.holder.identity);
  let childAlive = live?.child !== undefined && sameProcess(live.child.pid, live.child.identity);
  // A holder that recorded the end (an exit, a stop, its own timeout) answers for its child: what it left behind
  // (a `kodel wait`, say) is not looked at. Only a holder that went away without a word may have left the agent
  // behind a wrapper that died.
  if (
    !childAlive &&
    !holderAlive &&
    orphans !== undefined &&
    live?.child !== undefined &&
    (live.state === "running" || live.state === "starting") &&
    typeof session !== "string"
  ) {
    childAlive = orphans(live.child, session.started);
  }
  return {
    exists: true,
    session: newer
      ? { v: SESSION_FORMAT_VERSION + 1, started: 0 }
      : typeof session === "string"
        ? session
        : { v: session.v, started: session.started },
    status:
      typeof status === "string"
        ? status === "newer"
          ? "unreadable"
          : status
        : {
            state: status.state,
            ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
            ...(status.signal !== undefined ? { signal: status.signal } : {}),
            ...(status.reason !== undefined ? { reason: status.reason } : {}),
          },
    holderAlive,
    childAlive,
    stop: stop === "newer" ? "unreadable" : stop,
  };
};

export const FORMAT = SESSION_FORMAT_VERSION;

/** Frees a name for good. Only a person's command calls this: it reopens an attempt that may have run. */
export const forgetName = (namesDir: string, folded: string): boolean => {
  const path = join(namesDir, `${folded}.json`);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
};
