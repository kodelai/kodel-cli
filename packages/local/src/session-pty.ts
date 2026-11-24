/**
 * A terminal session: the PTY as a trait, and the holder's branch for `mode: pty`. This package imports no PTY
 * module: whoever starts the holder (the CLI) loads one and hands it in, and a test hands in a fake.
 */
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  renameSync,
  statSync,
  write as writeFd,
  writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  encodeRecord,
  isLocalSessionId,
  type RedactRule,
  type SocketCandidate,
  socketCandidates,
  stripThenRedact,
  type TerminalSize,
} from "@kodel-ai/pipeline-core";
import { AttachServer, type AttachTimers, realAttachTimers } from "./attach-server";
import { KILL_GRACE_MS } from "./command";
import { processIdentity } from "./process-table";
import type { HolderInput } from "./session-holder";
import {
  readStatus,
  replaceRecord,
  STATUS_FILE,
  STOP_FILE,
  type StatusRecord,
  TAIL_FILE,
} from "./session-records";
import {
  type BoundSocket,
  bindSessionSocket,
  type SocketBinder,
  type SocketRoots,
  socketHash,
} from "./session-socket";

// ── the trait ───────────────────────────────────────────────────────────────

export interface PtyExit {
  exitCode: number;
  /** The name of the signal that ended the child, when one did. */
  signal?: string;
}

export interface PtyChild {
  readonly pid: number;
  /**
   * The bytes as they are: what a person types is not always text (a mouse report, a key with the eighth bit).
   * `done` is called when the terminal has taken them: not before, or a child that does not read would let the
   * caller queue input without a bound.
   */
  write(data: Uint8Array, done?: () => void): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: Uint8Array) => void): void;
  onExit(listener: (exit: PtyExit) => void): void;
  /** Signals the child and its process group. */
  kill(signal: NodeJS.Signals): void;
}

export interface PtySpawnRequest extends TerminalSize {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface Pty {
  spawn(request: PtySpawnRequest): PtyChild;
}

/** The part of a PTY module (`@lydell/node-pty`) that is used. It reports a signal as a number, 0 for none. */
export interface RawPtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  /** The typings of the module name a string only; its write hands the value to a socket, which takes bytes. */
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  /**
   * Not part of the module's typings: the stream over the terminal's descriptor, which the module's `write` hands
   * the bytes to and never asks whether they left. It queues without a bound while the child does not read.
   */
  readonly _socket?: unknown;
  /** The descriptor of the terminal (its master side), where the module shows it. */
  readonly fd?: unknown;
}

/** The part of that stream that says when a write has reached the terminal. */
interface TerminalWritable {
  write(data: Uint8Array, done: (error?: Error | null) => void): unknown;
  /** Set as soon as the stream begins to close its descriptor. */
  readonly destroyed?: boolean;
  once?(event: "close", listener: () => void): unknown;
}

const terminalWritable = (raw: RawPtyProcess): TerminalWritable | undefined => {
  const socket = raw._socket;
  return typeof socket === "object" &&
    socket !== null &&
    typeof (socket as { write?: unknown }).write === "function"
    ? (socket as TerminalWritable)
    : undefined;
};

export interface RawPtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ): RawPtyProcess;
}

export type PtyLoad = { ok: true; pty: RawPtyModule } | { ok: false; reason: string };
/** Loads the module in the holder, after its own check; a refusal carries the reason. */
export type PtyLoader = () => Promise<PtyLoad>;

/** The name of a signal number on this system; a number nobody names keeps its number. */
export const signalName = (signal: number | undefined): string | undefined => {
  if (signal === undefined || signal === 0) return undefined;
  for (const [name, value] of Object.entries(osConstants.signals)) {
    if (value === signal) return name;
  }
  return `SIG${signal}`;
};

const encoder = new TextEncoder();

type TerminalWrite = (bytes: Buffer, done: () => void) => void;

/** A writer of a descriptor. After `close` nothing is written; what is queued then is reported as done. */
export type DescriptorWriter = TerminalWrite & { close(): void };

/** How long a write the terminal had no room for waits before it is tried again: the first wait, and the longest. */
const WRITE_RETRY_MS = [2, 50] as const;

/**
 * A second descriptor of the same open file, which only the caller closes: `/dev/fd/N` opens as a duplicate on
 * macOS. (Linux opens the file again, which for a terminal's master side would make another terminal: this is
 * not for Linux.) Undefined when it cannot be had.
 */
export const duplicateDescriptor = (fd: number): number | undefined => {
  try {
    return openSync(`/dev/fd/${fd}`, constants.O_WRONLY | constants.O_NOCTTY);
  } catch {
    return undefined;
  }
};

/**
 * Writes to the terminal's descriptor itself: one at a time, in order, and what the terminal has no room for is
 * tried again later. On macOS the module's stream cannot be used for a program that does not read: its write
 * tries again at once and without end, in the loop's own thread (a raw terminal has room for about a kilobyte),
 * and the holder stands still until the program reads. The same holds on Linux (a `write` that answers `EAGAIN`
 * over and over in the loop's thread, a core busy, and no new client served), and `setBlocking(false)` on the
 * stream's handle does not change it.
 *
 * A write is made by number, in another thread, some time after it was asked for: a number that was closed
 * meanwhile may be another file by then, and typed bytes would land in it. So with `owned` the descriptor is the
 * writer's own (a duplicate): nobody else closes it, and `close` closes it only when no write is on its way.
 * Without `owned` the number is somebody else's, and `gone` is all there is: asked before every write, it says
 * the descriptor is closed. That is the case on Linux, where a terminal's master side cannot be duplicated: what
 * is left is a write that was handed to the system just as the module closed the number, and a terminal is closed
 * when its program is gone and nobody is left to type to.
 */
export const descriptorWriter = (
  fd: number,
  gone: () => boolean,
  owned = false,
): DescriptorWriter => {
  const queue: { bytes: Buffer; done: () => void }[] = [];
  let busy = false;
  /** A write handed to the system that has not come back. */
  let inFlight = false;
  let closed = false;
  let released = false;
  const release = (): void => {
    if (!owned || released || inFlight) return;
    released = true;
    try {
      closeSync(fd);
    } catch {
      // closed already
    }
  };
  const next = (): void => {
    const item = queue.shift();
    if (!item) {
      busy = false;
      return;
    }
    busy = true;
    const finish = (): void => {
      item.done();
      next();
    };
    const step = (bytes: Buffer, wait: number): void => {
      if (closed || gone()) {
        finish();
        return;
      }
      inFlight = true;
      writeFd(fd, bytes, (error, written) => {
        inFlight = false;
        if (closed) {
          // What the write did no longer matters, and no other is made: the number may be given up now.
          release();
          finish();
        } else if (error?.code === "EAGAIN") {
          setTimeout(() => step(bytes, Math.min(wait * 2, WRITE_RETRY_MS[1])), wait);
        } else if (error) {
          finish(); // the terminal is gone, and nothing is owed to it
        } else if (written < bytes.length) step(bytes.subarray(written), WRITE_RETRY_MS[0]);
        else finish();
      });
    };
    step(item.bytes, WRITE_RETRY_MS[0]);
  };
  const write: TerminalWrite = (bytes, done) => {
    queue.push({ bytes, done });
    if (!busy) next();
  };
  return Object.assign(write, {
    close(): void {
      closed = true;
      release();
    },
  });
};

/**
 * A duplicate of the terminal's descriptor where there is one to be had: macOS only. On Linux `/dev/fd/N` of a
 * master side opens another terminal, so the writer there takes the module's own number (see `descriptorWriter`).
 */
const duplicateWhereItIsADuplicate = (fd: number): number | undefined =>
  process.platform === "darwin" ? duplicateDescriptor(fd) : undefined;

/**
 * The trait over a loaded module. `ownWrites` says the module's stream cannot be trusted with a program that
 * does not read (see `descriptorWriter`): it is so on macOS and on Linux alike, because libuv writes to a terminal
 * opened for reading and writing in the loop's own thread and tries again at once and without end.
 */
export const ptyFromModule = (
  module: RawPtyModule,
  ownWrites = true,
  duplicate: (fd: number) => number | undefined = duplicateWhereItIsADuplicate,
): Pty => ({
  spawn(request) {
    const raw = module.spawn(request.file, request.args, {
      name: request.env.TERM ?? DEFAULT_TERM,
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env: request.env,
    });
    const socket = terminalWritable(raw);
    const throughStream: TerminalWrite = (bytes, done) => {
      if (!socket) {
        // A module that shows no stream cannot say when a write has left: one turn of the loop is all there is.
        raw.write(bytes);
        setImmediate(done);
        return;
      }
      // The stream calls back when the terminal has the bytes (or is gone): until then they are owed.
      try {
        socket.write(bytes, () => done());
      } catch {
        done();
      }
    };
    const ownWriter = (shared: number, stream: TerminalWritable): TerminalWrite => {
      const own = duplicate(shared);
      const writer =
        own !== undefined
          ? descriptorWriter(own, () => false, true)
          : descriptorWriter(shared, () => stream.destroyed !== false);
      // The duplicate keeps the terminal open: it goes as soon as the module has closed its own.
      if (typeof stream.once === "function") stream.once("close", () => writer.close());
      else if (own !== undefined) raw.onExit(() => writer.close());
      return writer;
    };
    const write =
      ownWrites && socket && typeof raw.fd === "number" ? ownWriter(raw.fd, socket) : throughStream;
    return {
      pid: raw.pid,
      write(data, done) {
        write(Buffer.from(data.buffer, data.byteOffset, data.byteLength), done ?? (() => {}));
      },
      resize: (cols, rows) => raw.resize(cols, rows),
      onData(listener) {
        raw.onData((data) => listener(encoder.encode(data)));
      },
      onExit(listener) {
        raw.onExit(({ exitCode, signal }) => {
          const name = signalName(signal);
          listener(name === undefined ? { exitCode } : { exitCode, signal: name });
        });
      },
      kill(signal) {
        // The child leads a session of its own, so its pid is its process group; the module signals the pid alone.
        try {
          process.kill(-raw.pid, signal);
        } catch {
          // the group is gone
        }
        try {
          raw.kill(signal);
        } catch {
          // already gone
        }
      },
    };
  },
});

// ── what the child is started with ──────────────────────────────────────────

export const DEFAULT_TERM = "xterm-256color";

/**
 * The environment of the child of a terminal session. The mark is forced here too (an input that came without
 * `sessionEnv` still gets a marked child); a `TERM` that names no terminal gets the default; the size variables
 * of the starter's terminal are not the size of this one.
 */
export const ptyChildEnv = (env: Record<string, string>): Record<string, string> => {
  const { LINES: _lines, COLUMNS: _columns, ...rest } = env;
  const term = rest.TERM === undefined || rest.TERM === "" || rest.TERM === "dumb";
  return { ...rest, ...(term ? { TERM: DEFAULT_TERM } : {}), KODEL_ENGINE: "1" };
};

/**
 * The file a program name stands for, as the child would find it: a PTY module forks before it executes, so a
 * program that does not exist would show up as a child that ended, not as a start that failed.
 */
export const findExecutable = (
  file: string,
  env: Record<string, string>,
  cwd: string,
): string | undefined => {
  const runs = (path: string): boolean => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };
  if (file.includes("/")) {
    const path = isAbsolute(file) ? file : resolve(cwd, file);
    return runs(path) ? path : undefined;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const path = join(isAbsolute(dir) ? dir : resolve(cwd, dir), file);
    if (runs(path)) return path;
  }
  return undefined;
};

/** What is spawned: the argv as given, or a command string through the shell (as pipes mode runs it). */
export const ptyCommand = (
  input: Pick<HolderInput, "command" | "argv">,
): { file: string; args: string[] } =>
  input.command !== undefined
    ? { file: "/bin/sh", args: ["-c", input.command] }
    : { file: (input.argv ?? [])[0] as string, args: (input.argv ?? []).slice(1) };

// ── the holder's branch ─────────────────────────────────────────────────────

/** What the PTY branch needs of the outside; every part has a real default except the module. */
export interface PtyHolderParts {
  load?: PtyLoader;
  bind?: SocketBinder;
  timers?: AttachTimers;
  roots?: SocketRoots;
  /** How often the tail is written and the folder looked at. */
  watchMs?: number;
  /** How long output is still read after the child has exited. */
  drainMs?: number;
  /** How long the holder waits, at its end, for the clients to take what was queued for them. */
  flushMs?: number;
  /** Registers a listener of a signal sent to the holder; returns what removes it. */
  onSignal?: (signal: HolderSignal, listener: () => void) => () => void;
  /** How long a child that was told to end has before it is killed. */
  killGraceMs?: number;
}

/**
 * Longer than the second after which a closed stream that the peer does not read is destroyed
 * (`socketStream`), so the wait ends by itself.
 */
export const ATTACH_FLUSH_MS = 1_500;

export interface PtyHolderContext {
  input: HolderInput;
  boot: (line: string) => void;
  now: () => number;
  /** The `starting` record this holder created exclusively. */
  first: StatusRecord;
  rules: RedactRule[];
  safe: (text: string) => string;
  failBoot: (reason: "holder_error" | "rules_unknown", text: string) => number;
  tailBytes: number;
  marginBytes: number;
  /** The running record is rewritten while output arrives, but not more often than this. */
  statusEveryMs: number;
  lastBytes: (text: string, bytes: number) => string;
  parts: PtyHolderParts;
}

const candidatesOf = (input: HolderInput, roots: SocketRoots): SocketCandidate[] => {
  const socket = input.socket;
  if (!socket) throw new Error("the input names no place for the socket");
  // The id becomes part of a path that is bound and unlinked.
  if (!isLocalSessionId(socket.id)) throw new Error("the session id is not valid");
  const tmpDir = "tmpDir" in roots ? roots.tmpDir : process.env.TMPDIR;
  return socketCandidates({
    ...socket,
    hash: socketHash,
    ...(tmpDir !== undefined ? { tmpDir } : {}),
    ...(roots.systemTmp !== undefined ? { systemTmp: roots.systemTmp } : {}),
  });
};

/**
 * Runs one terminal session to its end, after the holder has created its `starting` record. The order is the
 * point: the module is loaded and the socket bound before a child exists, the executable is looked up before the
 * spawn, `ready` is said only when the socket listens and the child runs, and after the bind every way out goes
 * through `leave`, which tells the clients, closes the server and removes the socket.
 */
export async function runPtyHolder(context: PtyHolderContext): Promise<number> {
  const { input, boot, now, first, failBoot, parts } = context;
  const statusPath = join(input.dir, STATUS_FILE);
  const timers = parts.timers ?? realAttachTimers;

  if (!parts.load) return failBoot("holder_error", "this holder was given no terminal module");
  let pty: Pty;
  try {
    const loaded = await parts.load();
    if (!loaded.ok) return failBoot("holder_error", loaded.reason);
    pty = ptyFromModule(loaded.pty);
  } catch (error) {
    return failBoot("holder_error", (error as Error).message);
  }

  const server = new AttachServer({ timers, ...(input.size ? { size: input.size } : {}) });
  let socket: BoundSocket;
  try {
    socket = await (parts.bind ?? bindSessionSocket)(
      candidatesOf(input, parts.roots ?? {}),
      input.socket?.uid ?? -1,
    );
  } catch (error) {
    return failBoot("holder_error", `the socket could not be bound: ${(error as Error).message}`);
  }
  let left = false;
  const leave = (bye: Parameters<AttachServer["end"]>[0]): void => {
    if (left) return;
    left = true;
    server.end(bye);
    socket.close();
  };
  const live: LiveSession = { cleanups: [], exited: false };
  // From the bind on a signal must not end the holder by itself: the socket would stay bound and the record
  // would say `starting` for good. Before the child exists the signal is only remembered.
  for (const signal of HOLDER_SIGNALS) {
    live.cleanups.push(
      (parts.onSignal ?? onProcessSignal)(signal, () => {
        // A child that ended by itself is not stopped, and its end is not recorded as a stop.
        if (live.exited) return;
        live.signalled ??= signal;
        live.stop?.();
      }),
    );
  }
  let ready = false;
  const said = (line: string): void => {
    ready ||= line === "ready";
    boot(line);
  };
  try {
    return await holdTerminal({ ...context, boot: said }, pty, server, socket, leave, live);
  } catch (error) {
    // Nothing here is expected to throw. If something does, the child does not run on without a holder, the
    // record says so when it can, and the clients and the socket are seen to below.
    // Once the exit was seen its process group may be another program's: nothing signals it then.
    if (!live.exited) live.child?.kill("SIGKILL");
    try {
      const check = readStatus(input.dir);
      if (typeof check !== "string" && check.by === "holder" && check.state !== "killed") {
        const { sock: _sock, ...rest } = check;
        replaceRecord(
          statusPath,
          encodeRecord("status", {
            ...rest,
            state: "killed",
            reason: "holder_error",
            since: now(),
          }),
        );
      }
    } catch {
      // the folder is gone
    }
    // A starter that still waits for the first line gets one.
    if (!ready) boot(`HOLDER_BOOT_FAILED:${context.safe((error as Error).message)}`);
    return 1;
  } finally {
    for (const cleanup of live.cleanups) cleanup();
    leave({ reason: "holder_error", text: "the holder ended" });
  }
}

/** What the session has open, for the one place that sees every way out of it. */
interface LiveSession {
  child?: PtyChild;
  cleanups: (() => void)[];
  /** The signal that told the holder to end (`HOLDER_SIGNALS`) while its child had not ended. */
  signalled?: HolderSignal;
  /** The child's exit was seen: from here on nothing signals it (its process group may be another's by now). */
  exited: boolean;
  /** Stops the child as `stop` does; there is none before the spawn. */
  stop?: () => void;
}

/**
 * The signals that end a holder as `stop` ends its session: the child is stopped, and the end is recorded. The
 * record names the signal, not `stopped`: that reason is a person's `stop` (it leaves `stop.json`), and a
 * shutdown of the machine sends these signals to every holder without anybody having asked for a stop.
 */
export const HOLDER_SIGNALS = ["SIGTERM", "SIGHUP"] as const;
export type HolderSignal = (typeof HOLDER_SIGNALS)[number];

const onProcessSignal = (signal: HolderSignal, listener: () => void): (() => void) => {
  process.on(signal, listener);
  return () => process.off(signal, listener);
};

async function holdTerminal(
  context: PtyHolderContext,
  pty: Pty,
  server: AttachServer,
  socket: BoundSocket,
  leave: (bye: Parameters<AttachServer["end"]>[0]) => void,
  live: LiveSession,
): Promise<number> {
  const { input, boot, now, first, failBoot, parts } = context;
  const statusPath = join(input.dir, STATUS_FILE);
  socket.onClient((stream) => server.accept(stream));

  const command = ptyCommand(input);
  const env = ptyChildEnv(input.env);
  if (findExecutable(command.file, env, input.cwd) === undefined) {
    leave({ reason: "holder_error", text: "the command was not found" });
    return failBoot("holder_error", `${command.file}: command not found`);
  }

  // The holder was told to end before it had a child: it starts none.
  if (live.signalled !== undefined) {
    leave({ reason: "killed", text: "the holder was stopped" });
    try {
      replaceRecord(
        statusPath,
        encodeRecord("status", {
          ...first,
          state: "killed",
          ...(existsSync(join(input.dir, STOP_FILE))
            ? { reason: "stopped" as const }
            : { signal: live.signalled }),
          since: now(),
        }),
      );
    } catch {
      // the folder was removed
    }
    boot(`HOLDER_BOOT_FAILED:${context.safe("the holder was stopped before the command started")}`);
    return 1;
  }

  let child: PtyChild;
  try {
    child = pty.spawn({ ...command, cwd: input.cwd, env, ...server.size() });
  } catch (error) {
    leave({ reason: "holder_error", text: "the terminal could not be started" });
    return failBoot("holder_error", (error as Error).message);
  }
  live.child = child;

  // Listen for the exit at once: a child that ends before it is recorded as running would be missed.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let escalate: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<PtyExit>((done) => {
    child.onExit((exit) => {
      live.exited = true;
      if (timer) clearTimeout(timer);
      if (escalate) clearTimeout(escalate);
      setTimeout(() => done(exit), parts.drainMs ?? 100);
    });
  });
  const stopChild = (): void => {
    if (live.exited) return;
    child.kill("SIGTERM");
    escalate ??= setTimeout(() => child.kill("SIGKILL"), parts.killGraceMs ?? KILL_GRACE_MS);
  };
  live.cleanups.push(() => {
    if (timer) clearTimeout(timer);
    if (escalate) clearTimeout(escalate);
  });
  // A holder that is told to end does not just end (no `BYE`, the socket left, the record `running`): it stops
  // the child, and the session ends the way it does after `stop`.
  live.stop = stopChild;

  const keep = context.tailBytes + context.marginBytes;
  let tail = Buffer.alloc(0);
  let tailCut = false;
  let tailDirty = true;
  let lastOutputAt: number | undefined;
  child.onData((data) => {
    tail = Buffer.concat([tail, data]);
    if (tail.length > keep) {
      tail = tail.subarray(tail.length - keep);
      tailCut = true;
    }
    tailDirty = true;
    lastOutputAt = now();
  });
  server.setChild(child);
  // One stream, stripped of its escape sequences and then redacted; the raw bytes never reach a file.
  const flush = (): void => {
    if (!tailDirty) return;
    tailDirty = false;
    const text = tail.toString("utf8").replace(/^�+/, "");
    const plain = stripThenRedact([text], context.rules, tailCut);
    // A cut tail may begin inside a secret no rule knows the second half of. The margin is counted in the text
    // that is written: the raw bytes kept may be mostly escape sequences, and then nothing else drops that start.
    const whole = tailCut
      ? context.lastBytes(plain, Math.max(0, Buffer.byteLength(plain) - context.marginBytes))
      : plain;
    try {
      const target = join(input.dir, TAIL_FILE);
      writeFileSync(`${target}.tmp`, context.lastBytes(whole, context.tailBytes), { mode: 0o600 });
      renameSync(`${target}.tmp`, target);
    } catch {
      // the directory may be gone; the watcher below handles that
    }
  };

  const childId = processIdentity(child.pid);
  const withoutSock: StatusRecord = {
    ...first,
    state: "running",
    child: childId ? { pid: child.pid, identity: childId } : { pid: child.pid },
    since: now(),
  };
  const running: StatusRecord = { ...withoutSock, sock: socket.path };
  const current = readStatus(input.dir);
  if (typeof current === "string" || current.by !== "holder") {
    child.kill("SIGKILL");
    leave({ reason: "holder_error", text: "the session was given up" });
    boot("HOLDER_BOOT_FAILED:tombstone");
    return 1;
  }
  try {
    replaceRecord(statusPath, encodeRecord("status", running));
  } catch {
    // The folder was removed under us (the starter gave up): the child must not run on with no record.
    child.kill("SIGKILL");
    leave({ reason: "holder_error", text: "the session was given up" });
    return 1;
  }
  boot("ready");

  let timedOut = false;
  if (input.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, input.timeoutMs);
  }
  let lastWritten = now();
  const watcher = setInterval(() => {
    flush();
    if (!existsSync(input.dir)) {
      stopChild(); // the directory was removed under a live child
      return;
    }
    if (lastOutputAt !== undefined && now() - lastWritten >= context.statusEveryMs) {
      lastWritten = now();
      try {
        replaceRecord(statusPath, encodeRecord("status", { ...running, lastOutputAt }));
      } catch {
        // gone
      }
    }
  }, parts.watchMs ?? 1_000);
  live.cleanups.push(() => clearInterval(watcher));

  const exit = await exited;
  clearInterval(watcher);
  flush();

  const stopped = existsSync(join(input.dir, STOP_FILE));
  const end: Pick<StatusRecord, "state" | "reason" | "signal" | "exitCode"> = timedOut
    ? { state: "killed", reason: "timeout" }
    : stopped
      ? { state: "killed", reason: "stopped" }
      : live.signalled !== undefined
        ? { state: "killed", signal: live.signalled }
        : exit.signal !== undefined
          ? { state: "killed", signal: exit.signal }
          : { state: "exited", exitCode: exit.exitCode };
  // The clients hear of the end, and the socket is gone, before the record says the session is over: whoever
  // reads a final record never finds a client still attached.
  leave(
    end.state === "exited"
      ? { reason: "exited", exitCode: exit.exitCode }
      : { reason: "killed", ...(exit.signal !== undefined ? { signal: exit.signal } : {}) },
  );
  // The process ends when this returns: a client that was slow to read would lose the last output and the `BYE`.
  await socket.flushed(parts.flushMs ?? ATTACH_FLUSH_MS);
  // Built from the record without `sock`: a final record names no socket.
  const final: StatusRecord = {
    ...withoutSock,
    since: now(),
    ...(lastOutputAt !== undefined ? { lastOutputAt } : {}),
    ...end,
  };
  try {
    const check = readStatus(input.dir);
    if (typeof check !== "string" && check.by === "holder") {
      replaceRecord(statusPath, encodeRecord("status", final));
    }
  } catch {
    // the folder was removed while the holder waited for its clients: there is no record to end
  }
  return 0;
}
