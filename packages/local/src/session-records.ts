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

export type { NameMarker, SessionRecord, StatusRecord, StopRecord } from "@kodel-ai/pipeline-core";

export const SESSION_FILE = "session.json";
export const STATUS_FILE = "status.json";
export const STOP_FILE = "stop.json";
export const TAIL_FILE = "tail.txt";

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

/** `session.json` appears with the directory or not at all: written in a temporary directory, then renamed in. */
export const publishSession = (dir: string, record: SessionRecord): void => {
  const tmp = `${dir}.tmp-${process.pid}`;
  mkdirSync(tmp, { mode: 0o700 });
  writeFileSync(join(tmp, SESSION_FILE), encodeRecord("session", record), { mode: 0o600 });
  renameSync(tmp, dir);
};

export const removeDir = (path: string): void => rmSync(path, { recursive: true, force: true });

export const snapshotOf = (dir: string): SessionSnapshot => {
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
  const live =
    status !== "missing" && status !== "unreadable" && status !== "newer" ? status : undefined;
  // A newer format anywhere in the folder is "upgrade kodel", whichever file it is in.
  const newer = session === "newer" || status === "newer" || stop === "newer";
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
    holderAlive: live?.holder !== undefined && sameProcess(live.holder.pid, live.holder.identity),
    childAlive: live?.child !== undefined && sameProcess(live.child.pid, live.child.identity),
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
