/**
 * The common Session interface (TASK-KDJS): start, own, observe and stop one long-running process.
 * Pure: no file system, process or clock access. An adapter (local pipes, local PTY, a remote runner)
 * implements `SessionAdapter`; `deriveStatus` is the one place that turns what is stored into a state.
 *
 * Session errors have their own code set, outside the MCP `ERROR_CODES` (which stay pinned).
 */

export const SESSION_FORMAT_VERSION = 1;

export const SESSION_ERROR_CODES = [
  "UNKNOWN",
  "NOT_FOUND",
  "CANNOT_READ",
  "NEWER_FORMAT",
  "NAME_TAKEN",
  "NAME_USED",
  "SPEC_INVALID",
  "PLATFORM_UNSUPPORTED",
  "IDENTITY_UNKNOWN",
  "HOLDER_BOOT_FAILED",
  "STATE_UNWRITABLE",
  "NOT_RUNNING",
  "STILL_RUNNING",
  "UNSUPPORTED",
] as const;
export type SessionErrorCode = (typeof SESSION_ERROR_CODES)[number];

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

/** The opaque grammar every adapter accepts: no `.`, `..`, separators or a leading dot. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The shape the local adapter makes (`a_<time base 36>_<random>`); it checks this before it builds a path. */
export const LOCAL_SESSION_ID_PATTERN = /^a_[0-9a-z]{9}_[0-9a-z]{4}$/;

export const isSessionId = (value: string): boolean => SESSION_ID_PATTERN.test(value);
export const isLocalSessionId = (value: string): boolean => LOCAL_SESSION_ID_PATTERN.test(value);

/** A session name: the deterministic handle a consumer finds a session again by. */
export const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const isSessionName = (value: string): boolean => SESSION_NAME_PATTERN.test(value);
/** Names are case-folded before they become a marker: `Foo` and `foo` are one name on every file system. */
export const foldSessionName = (name: string): string => name.toLowerCase();

export type SessionMode = "pipes" | "pty";
export type SessionLifetime = "detached" | "with-starter";
export type SessionOrigin = "cli" | "host";

export interface SessionSpec {
  /** One of `command` (run through a shell) or `argv` (no shell). */
  command?: string;
  argv?: string[];
  /** Absolute. The holder's own working directory never leaks into the child. */
  cwd: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  /** Keep the child's stdin open for `send` (off by default: a program that reads stdin would wait for it). */
  input?: boolean;
  timeoutMs?: number;
  name?: string;
  mode?: SessionMode;
  lifetime?: SessionLifetime;
  origin?: SessionOrigin;
  parent?: string;
}

/** The longest timer a process can set (Node fires at once above it). */
export const MAX_SESSION_TIMEOUT_MS = 2 ** 31 - 1;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

const isAbsoluteCwd = (cwd: string): boolean => cwd.startsWith("/") || WINDOWS_ABSOLUTE.test(cwd);

/** Why a spec is refused, or `undefined` when it is valid. Never throws. */
export const validateSpec = (spec: SessionSpec): string | undefined => {
  const hasCommand = typeof spec.command === "string" && spec.command.length > 0;
  const hasArgv = Array.isArray(spec.argv);
  if (hasCommand === hasArgv) return "give exactly one of command or argv";
  if (hasArgv) {
    const argv = spec.argv ?? [];
    if (argv.length === 0 || argv[0] === "") return "argv is empty";
    if (argv.some((a) => typeof a !== "string")) return "argv holds a non-string";
  }
  if (typeof spec.cwd !== "string" || !isAbsoluteCwd(spec.cwd)) return "cwd must be absolute";
  if (spec.timeoutMs !== undefined) {
    if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
      return "timeoutMs must be a positive number";
    }
    if (spec.timeoutMs > MAX_SESSION_TIMEOUT_MS) return "timeoutMs is longer than 24 days";
  }
  if (spec.env !== undefined) {
    for (const [key, value] of Object.entries(spec.env)) {
      if (typeof value !== "string") return `env ${key} is not a string`;
      if (!ENV_NAME.test(key)) return `env name ${key} is not valid`;
      if (key.startsWith("KODEL_")) return `env ${key} is reserved`;
    }
  }
  if (spec.input !== undefined && typeof spec.input !== "boolean") return "input must be a boolean";
  if (spec.name !== undefined && !isSessionName(spec.name)) return "name is not valid";
  if (spec.parent !== undefined && !isSessionId(spec.parent)) return "parent is not a session id";
  if (spec.mode !== undefined && spec.mode !== "pipes" && spec.mode !== "pty")
    return "mode is not valid";
  if (
    spec.lifetime !== undefined &&
    spec.lifetime !== "detached" &&
    spec.lifetime !== "with-starter"
  ) {
    return "lifetime is not valid";
  }
  if (spec.origin !== undefined && spec.origin !== "cli" && spec.origin !== "host") {
    return "origin is not valid";
  }
  if (spec.inheritEnv !== undefined && typeof spec.inheritEnv !== "boolean") {
    return "inheritEnv must be a boolean";
  }
  // A session started for a host outlives its starter, so it must end by itself.
  if (spec.origin === "host" && spec.lifetime !== "with-starter" && spec.timeoutMs === undefined) {
    return "a host session needs timeoutMs";
  }
  return undefined;
};

export type SessionState = "starting" | "running" | "exited" | "killed" | "lost";
export const TERMINAL_STATES: readonly SessionState[] = ["exited", "killed", "lost"];
export const isTerminalState = (state: SessionState): boolean => TERMINAL_STATES.includes(state);

export type KilledReason = "stopped" | "timeout" | "start_late" | "rules_unknown" | "holder_error";

export interface SessionStatus {
  state: SessionState;
  exitCode?: number;
  signal?: string;
  reason?: KilledReason | "no_status" | "holder_gone";
  /** True when the child still runs although the session is over (a consumer treats it as unfinished). */
  childAlive?: boolean;
  lastOutputAt?: number;
  since?: number;
}

/** What an adapter hands to `deriveStatus`: facts only, read once. */
export interface SessionSnapshot {
  exists: boolean;
  session: "missing" | "unreadable" | { v: number; started: number };
  status:
    | "missing"
    | "unreadable"
    | { state: SessionState; exitCode?: number; signal?: string; reason?: SessionStatus["reason"] };
  holderAlive: boolean;
  childAlive: boolean;
  stop: "missing" | "unreadable" | "present";
}

export type DerivedStatus =
  | { ok: true; status: SessionStatus }
  | { ok: false; code: "UNKNOWN" | "CANNOT_READ" | "NEWER_FORMAT" };

/** The default time a session may stay `starting` without a `status.json`. */
export const DEFAULT_START_GRACE_MS = 30_000;

/**
 * The one decision table. Order matters: it is the order of the plan's design (no directory,
 * unreadable record, newer format, no status yet, terminal, running).
 */
export const deriveStatus = (
  snap: SessionSnapshot,
  now: number,
  graceMs: number = DEFAULT_START_GRACE_MS,
): DerivedStatus => {
  if (!snap.exists) return { ok: false, code: "UNKNOWN" };
  if (snap.session === "missing" || snap.session === "unreadable") {
    return { ok: false, code: "CANNOT_READ" };
  }
  if (snap.session.v > SESSION_FORMAT_VERSION) return { ok: false, code: "NEWER_FORMAT" };
  if (snap.status === "unreadable") return { ok: false, code: "CANNOT_READ" };
  if (snap.status === "missing") {
    if (now - snap.session.started < graceMs) return { ok: true, status: { state: "starting" } };
    return {
      ok: true,
      status: { state: "lost", reason: "no_status", childAlive: snap.childAlive },
    };
  }
  const recorded = snap.status;
  if (isTerminalState(recorded.state)) {
    const status: SessionStatus = { state: recorded.state };
    if (recorded.exitCode !== undefined) status.exitCode = recorded.exitCode;
    if (recorded.signal !== undefined) status.signal = recorded.signal;
    if (recorded.reason !== undefined) status.reason = recorded.reason;
    if (snap.childAlive) status.childAlive = true;
    return { ok: true, status };
  }
  if (recorded.state === "starting") {
    if (snap.holderAlive) return { ok: true, status: { state: "starting" } };
    return {
      ok: true,
      status: { state: "lost", reason: "holder_gone", childAlive: snap.childAlive },
    };
  }
  // running
  if (snap.holderAlive) return { ok: true, status: { state: "running" } };
  if (snap.stop === "unreadable") return { ok: false, code: "CANNOT_READ" };
  if (snap.stop === "present") {
    return {
      ok: true,
      status: { state: "killed", reason: "stopped", childAlive: snap.childAlive },
    };
  }
  return {
    ok: true,
    status: { state: "lost", reason: "holder_gone", childAlive: snap.childAlive },
  };
};

/**
 * Bytes a `send` writes for a PTY session. A bracketed paste only while the program has DEC mode 2004 on;
 * Enter is a separate write after a pause (the caller sleeps `SEND_PASTE_GAP_MS` between the two).
 */
export const SEND_PASTE_GAP_MS = 200;
export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";

export interface SendPlan {
  paste: string;
  submit: string;
}

export const planSend = (text: string, bracketedPaste: boolean, submit = "\r"): SendPlan => {
  // A pasted ESC[201~ would end the paste early and run the rest as typed keys.
  const safe = text.split(PASTE_END).join("");
  return { paste: bracketedPaste ? `${PASTE_START}${safe}${PASTE_END}` : safe, submit };
};

/** Follows the program's own DEC mode 2004 switches in its output; the last one wins. */
export const trackBracketedPaste = (output: string, current: boolean): boolean => {
  const on = output.lastIndexOf("\u001b[?2004h");
  const off = output.lastIndexOf("\u001b[?2004l");
  if (on < 0 && off < 0) return current;
  return on > off;
};

export interface SessionCapabilities {
  pty: boolean;
  send: boolean;
  attach: boolean;
  lastOutputAt: boolean;
}

export interface StartResult {
  id: string;
  name?: string;
}

export interface TailResult {
  text: string;
  /** False when more output was written than the ring kept. */
  complete: boolean;
}

export interface SessionListEntry {
  id: string;
  name?: string;
  status: SessionStatus;
  /** The entry could not be read (`CANNOT_READ`), was written by a newer kodel (`NEWER_FORMAT`) or by another machine (`FOREIGN`); its status is not real. */
  problem?: "CANNOT_READ" | "NEWER_FORMAT" | "FOREIGN";
}

export interface SessionAdapter {
  capabilities(): SessionCapabilities;
  start(spec: SessionSpec): Promise<StartResult>;
  status(id: string): Promise<SessionStatus>;
  /** Resolves when the session is terminal, or with `timedOut` at the bound. */
  wait(
    id: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SessionStatus & { timedOut?: boolean }>;
  tail(id: string, bytes?: number): Promise<TailResult>;
  stop(id: string): Promise<SessionStatus>;
  remove(id: string): Promise<void>;
  list(filter?: { name?: string }): Promise<SessionListEntry[]>;
  /** Only with `capabilities().send`. Returns the bytes written; promises nothing about a program that does not read. */
  send?(id: string, text: string, opts?: { submit?: boolean }): Promise<{ bytes: number }>;
}
