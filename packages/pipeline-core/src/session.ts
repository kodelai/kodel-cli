/**
 * The common Session interface (TASK-KDJS): start, own, observe and stop one long-running process.
 * Pure: no file system, process or clock access. An adapter (local pipes, local PTY, a remote runner)
 * implements `SessionAdapter`; `deriveStatus` is the one place that turns what is stored into a state.
 *
 * Session errors have their own code set, outside the MCP `ERROR_CODES` (which stay pinned).
 */

import { ENGINE_PROFILE_NAME } from "./registry";
import type { AttachStream } from "./session-frames";
import { isTerminalSize } from "./session-frames";

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
  "NOT_ATTACHABLE",
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

/**
 * The coding agent a session runs, as its starter knows it: the engine's profile name, the id of the agent's own
 * conversation (chosen by the starter, never read from what the agent prints) and the session whose conversation
 * this one continues. It names which conversation to continue, never whether anything is done.
 */
export interface SessionAgent {
  engine: string;
  session?: string;
  resumes?: string;
}

/** An engine's profile name, as the `engines` block spells it. */
export const AGENT_ENGINE_PATTERN = ENGINE_PROFILE_NAME;
/** The id of an agent's conversation: one word an argv can carry, never a flag. */
export const AGENT_SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Why an `agent` is refused, or `undefined`. Shared by the spec and by the record that stores it. */
export const agentProblem = (agent: unknown): string | undefined => {
  if (typeof agent !== "object" || agent === null || Array.isArray(agent)) {
    return "agent is not an object";
  }
  const { engine, session, resumes, ...rest } = agent as Record<string, unknown>;
  const unknown = Object.keys(rest)[0];
  if (unknown !== undefined) return `agent.${unknown} is not known`;
  if (typeof engine !== "string" || !AGENT_ENGINE_PATTERN.test(engine)) {
    return "agent.engine is not a profile name";
  }
  if (
    session !== undefined &&
    (typeof session !== "string" || !AGENT_SESSION_PATTERN.test(session))
  ) {
    return "agent.session is not valid";
  }
  if (resumes !== undefined && (typeof resumes !== "string" || !isSessionId(resumes))) {
    return "agent.resumes is not a session id";
  }
  return undefined;
};

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
  /** The first size of the terminal of a `pty` session. Never stored: the size is the attached terminal's. */
  size?: { cols: number; rows: number };
  lifetime?: SessionLifetime;
  origin?: SessionOrigin;
  parent?: string;
  /** Kept in a record of its own (`agent.json`), never in the stored spec. */
  agent?: SessionAgent;
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
  if (spec.agent !== undefined) {
    const problem = agentProblem(spec.agent);
    if (problem !== undefined) return problem;
  }
  if (spec.mode !== undefined && spec.mode !== "pipes" && spec.mode !== "pty")
    return "mode is not valid";
  if (spec.size !== undefined) {
    if (spec.mode !== "pty") return "size needs mode pty";
    if (!isTerminalSize(spec.size)) return "size is not valid";
  }
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

/**
 * Who asked for a stop: a person (`kodel agent stop`), or kodel itself when the run of the session was over
 * (`finish`). A stop record that does not say is a person's: nobody else may be taken for the person's word.
 */
export type StopAsker = "person" | "finish";
/** The `by` of a stop record, per asker. `stop` is what every record said before the askers were told apart. */
export const STOP_BY: Readonly<Record<StopAsker, string>> = { person: "stop", finish: "finish" };
export const stopAskerOf = (by: string): StopAsker => (by === STOP_BY.finish ? "finish" : "person");

export interface SessionStatus {
  state: SessionState;
  exitCode?: number;
  signal?: string;
  reason?: KilledReason | "no_status" | "holder_gone";
  /**
   * Somebody asked for the session to be stopped, and who (the stop record). It is read beside whatever the
   * record says of the end: a stop that ended only what a holder left behind (a record that was final already)
   * changes no `reason`, and is a stop all the same. Never set while the session is live.
   */
  stoppedBy?: StopAsker;
  /** True when the child still runs although the session is over (a consumer treats it as unfinished). */
  childAlive?: boolean;
  lastOutputAt?: number;
  since?: number;
  /**
   * Only for a session whose holder went away without recording its child's end, with the recorded child gone:
   * what is left of the child's process group could not be looked at (`unread`: the process table, the boot
   * time, or whether the process that has the group's number is the recorded child; `childAlive` is then about the recorded child alone), or the group's number belongs to another
   * process now (`stranger`: nothing of the session is left). Absent when the group was looked at, or need not be.
   */
  group?: "unread" | "stranger";
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
  /** The stop record: who asked, when it is there and can be read. */
  stop: "missing" | "unreadable" | StopAsker;
}

/**
 * Whether a person stopped the session. The stop record says so for any end the status record names (a holder
 * that had recorded its own end before the person stopped what was left is stopped by the person too). A status
 * that says `stopped` and names no asker (an adapter that keeps no stop record) is the person's.
 */
export const stoppedByPerson = (status: SessionStatus): boolean =>
  status.stoppedBy === "person" || (status.reason === "stopped" && status.stoppedBy === undefined);

export type DerivedStatus =
  | { ok: true; status: SessionStatus }
  | { ok: false; code: "UNKNOWN" | "CANNOT_READ" | "NEWER_FORMAT" };

/** The default time a session may stay `starting` without a `status.json`. */
export const DEFAULT_START_GRACE_MS = 30_000;

/**
 * The one decision table. Order matters: it is the order of the plan's design (no directory,
 * unreadable record, newer format, no status yet, terminal, running). Every answer for a session that is
 * over goes through `over`: the stop record is read for each of them, whatever the status record says, so
 * no end hides who asked for a stop; one that cannot be read is `CANNOT_READ`, never "nobody asked".
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
  const over = (status: SessionStatus): DerivedStatus => {
    if (snap.stop === "unreadable") return { ok: false, code: "CANNOT_READ" };
    if (snap.stop !== "missing") status.stoppedBy = snap.stop;
    return { ok: true, status };
  };
  if (snap.status === "missing") {
    if (now - snap.session.started < graceMs) return { ok: true, status: { state: "starting" } };
    return over({ state: "lost", reason: "no_status", childAlive: snap.childAlive });
  }
  const recorded = snap.status;
  if (isTerminalState(recorded.state)) {
    const status: SessionStatus = { state: recorded.state };
    if (recorded.exitCode !== undefined) status.exitCode = recorded.exitCode;
    if (recorded.signal !== undefined) status.signal = recorded.signal;
    if (recorded.reason !== undefined) status.reason = recorded.reason;
    if (snap.childAlive) status.childAlive = true;
    return over(status);
  }
  if (snap.holderAlive) return { ok: true, status: { state: recorded.state } };
  // The holder went away without recording the end: a stop record says it was stopped, else it is lost.
  if (recorded.state === "running" && snap.stop !== "missing") {
    return over({ state: "killed", reason: "stopped", childAlive: snap.childAlive });
  }
  return over({ state: "lost", reason: "holder_gone", childAlive: snap.childAlive });
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

const DEC_SWITCH_START = "\u001b[?";
const isModeChar = (char: string | undefined): boolean =>
  char !== undefined && ((char >= "0" && char <= "9") || char === ";");

/**
 * Follows the program's own DEC mode 2004 switches in its output; the last one wins. A switch may set several
 * modes at once (`ESC[?1049;2004h`).
 */
export const trackBracketedPaste = (output: string, current: boolean): boolean => {
  let on = current;
  let lastSwitch = -1;
  for (
    let at = output.indexOf(DEC_SWITCH_START);
    at >= 0;
    at = output.indexOf(DEC_SWITCH_START, at + 1)
  ) {
    let end = at + DEC_SWITCH_START.length;
    while (isModeChar(output[end])) end++;
    const final = output[end];
    if (final !== "h" && final !== "l") continue;
    const modes = output.slice(at + DEC_SWITCH_START.length, end).split(";");
    if (modes.includes("2004")) {
      on = final === "h";
      lastSwitch = at;
    }
  }
  // A full reset (RIS) after the last switch turns the mode off, as a program that crashed and was `reset` leaves it.
  if (output.lastIndexOf("\u001bc") > lastSwitch) on = false;
  return on;
};

/** The state `trackBracketedPasteChunk` carries from one chunk of output to the next. */
export interface PasteTrack {
  on: boolean;
  carry: string;
}

/** A switch that names more modes than fit in this is not followed across a chunk border. */
const PASTE_SWITCH_CARRY = 64;

/** The start of a switch that `text` ends in, to be finished by the next chunk. */
const openSwitch = (text: string): string => {
  const at = text.lastIndexOf("\u001b");
  if (at < 0 || text.length - at > PASTE_SWITCH_CARRY) return "";
  const tail = text.slice(at);
  if (DEC_SWITCH_START.startsWith(tail)) return tail;
  if (!tail.startsWith(DEC_SWITCH_START)) return "";
  for (let i = DEC_SWITCH_START.length; i < tail.length; i++) {
    if (!isModeChar(tail[i])) return "";
  }
  return tail;
};

/** `trackBracketedPaste` for output that arrives in chunks: a switch cut in two by a chunk border counts. */
export const trackBracketedPasteChunk = (
  chunk: string,
  previous: PasteTrack = { on: false, carry: "" },
): PasteTrack => {
  const text = previous.carry + chunk;
  return { on: trackBracketedPaste(text, previous.on), carry: openSwitch(text) };
};

export type Attachable = { ok: true } | { ok: false; reason: string };

export interface SessionCapabilities {
  pty: boolean;
  send: boolean;
  attach: boolean;
  lastOutputAt: boolean;
  /**
   * `tail` can give stdout and stderr apart. It is about the adapter, not a session: a terminal session of an
   * adapter that says `true` still has one stream and answers `UNSUPPORTED` for one of the two.
   */
  streams: boolean;
}

export interface StartResult {
  id: string;
  name?: string;
}

/** `both` is the interleaved output; `stdout` and `stderr` need `capabilities().streams`. */
export type TailStream = "both" | "stdout" | "stderr";

export interface TailResult {
  text: string;
  /** False when more output was written than the ring kept. */
  complete: boolean;
}

export interface SessionListEntry {
  id: string;
  name?: string;
  /** The command as the starter gave it, redacted (a shell command, or the argv joined by spaces). */
  command?: string;
  status: SessionStatus;
  /** `pipes` or `pty`, as the record says; absent for an entry that could not be read. */
  mode?: SessionMode;
  /** The session's `agent` record, when it has one (an older session has none). Never a prompt or an argv. */
  agent?: SessionAgent & { source?: "chosen" | "observed" };
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
  tail(id: string, bytes?: number, stream?: TailStream): Promise<TailResult>;
  /**
   * `by` says who asks (a person, when absent). A person's stop is never replaced by a `finish`, and it
   * replaces one: the stop record keeps the person's word.
   */
  stop(id: string, opts?: { by?: StopAsker }): Promise<SessionStatus>;
  remove(id: string): Promise<void>;
  list(filter?: { name?: string }): Promise<SessionListEntry[]>;
  /** Only with `capabilities().send`. Returns the bytes written; promises nothing about a program that does not read. */
  send?(id: string, text: string, opts?: { submit?: boolean }): Promise<{ bytes: number }>;
  /**
   * Only with `capabilities().attach`. A byte stream that speaks the attach frames (`session-frames.ts`) with the
   * session's holder; `NOT_ATTACHABLE` when the session does not run, has no terminal or cannot be reached.
   */
  attach?(id: string): Promise<AttachStream>;
  /** Whether `attach` would connect now, with the reason when not. Never throws for a session that exists. */
  attachable?(id: string): Promise<Attachable>;
}
