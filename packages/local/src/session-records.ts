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
  type KilledReason,
  SESSION_FORMAT_VERSION,
  type SessionSnapshot,
  type SessionSpec,
  type SessionState,
} from "@kodel-ai/pipeline-core";
import { liveProcess, type ProcessIdentity } from "./process-table";

/** `session.json`: written once by the starter. The spec in it is redacted; the secrets travel only on the holder's stdin. */
export interface SessionRecord {
  v: number;
  id: string;
  name?: string;
  mode: "pipes" | "pty";
  /** Redacted spec. */
  spec: Omit<SessionSpec, "env"> & { envNames: string[] };
  started: number;
  root: string;
  machine?: string;
}

/** `status.json`: written by the holder (or once as a `lost` tombstone by a reader). */
export interface StatusRecord {
  v: number;
  state: SessionState;
  by: "holder" | "reader";
  holder?: { pid: number; identity?: ProcessIdentity };
  child?: { pid: number; identity?: ProcessIdentity };
  exitCode?: number;
  signal?: string;
  reason?: KilledReason | "no_status" | "holder_gone";
  lastOutputAt?: number;
  since: number;
  build?: string;
}

/** `stop.json`: written by `stop`. */
export interface StopRecord {
  v: number;
  by: string;
  at: number;
  identity?: ProcessIdentity;
}

export interface NameMarker {
  v: number;
  name: string;
  id: string;
  started: number;
}

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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readSession = (dir: string): SessionRecord | "missing" | "unreadable" => {
  const value = readJson(join(dir, SESSION_FILE));
  if (value === "missing" || value === "unreadable") return value;
  return isObject(value) && typeof value.v === "number" && typeof value.id === "string"
    ? (value as unknown as SessionRecord)
    : "unreadable";
};

export const readStatus = (dir: string): StatusRecord | "missing" | "unreadable" => {
  const value = readJson(join(dir, STATUS_FILE));
  if (value === "missing" || value === "unreadable") return value;
  return isObject(value) && typeof value.state === "string"
    ? (value as unknown as StatusRecord)
    : "unreadable";
};

export const readStop = (dir: string): "missing" | "unreadable" | "present" => {
  const value = readJson(join(dir, STOP_FILE));
  if (value === "missing" || value === "unreadable") return value;
  return isObject(value) ? "present" : "unreadable";
};

/** Exclusive create: a second writer fails. Used for the first `status.json`, the tombstone and the name marker. */
export const createExclusive = (path: string, value: unknown): boolean => {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify(value));
  } finally {
    closeSync(fd);
  }
  return true;
};

/** Replace a record: a temporary file and a rename, so a reader never sees half a file. */
export const replaceRecord = (path: string, value: unknown): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
};

/** `session.json` appears with the directory or not at all: written in a temporary directory, then renamed in. */
export const publishSession = (dir: string, record: SessionRecord): void => {
  const tmp = `${dir}.tmp-${process.pid}`;
  mkdirSync(tmp, { mode: 0o700 });
  writeFileSync(join(tmp, SESSION_FILE), JSON.stringify(record), { mode: 0o600 });
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
  const holderPid =
    status !== "missing" && status !== "unreadable" ? status.holder?.pid : undefined;
  const childPid = status !== "missing" && status !== "unreadable" ? status.child?.pid : undefined;
  return {
    exists: true,
    session: typeof session === "string" ? session : { v: session.v, started: session.started },
    status:
      typeof status === "string"
        ? status
        : {
            state: status.state,
            ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
            ...(status.signal !== undefined ? { signal: status.signal } : {}),
            ...(status.reason !== undefined ? { reason: status.reason } : {}),
          },
    holderAlive: holderPid !== undefined && liveProcess(holderPid),
    childAlive: childPid !== undefined && liveProcess(childPid),
    stop: readStop(dir),
  };
};

export const FORMAT = SESSION_FORMAT_VERSION;
