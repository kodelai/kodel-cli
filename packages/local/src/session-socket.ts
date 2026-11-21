/**
 * The attach socket of a terminal session on this machine: where it may be, what is trusted there, the bind,
 * the connect and the sweep. The names come from the core (`session-socket-path.ts`); this file adds the file
 * system. Nothing here runs at import, so the module is safe to load on Windows.
 */
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
  type AttachStream,
  type SocketCandidate,
  type SocketPlaceKind,
  socketCandidates,
  socketPathQualifies,
} from "@kodel-ai/pipeline-core";
import type { SessionPlace } from "./session-paths";

export const socketHash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The temporary roots a fallback socket may be under; a test gives its own. */
export interface SocketRoots {
  tmpDir?: string;
  systemTmp?: string;
}

const pathInput = (place: SessionPlace, id: string) => ({
  runDir: place.runDir,
  uid: place.uid,
  checkoutKey: place.key,
  id,
  hash: socketHash,
});

/** The places the socket of this session may be bound at, seen from this process (its `$TMPDIR`). */
export const sessionSocketCandidates = (
  place: SessionPlace,
  id: string,
  roots: SocketRoots = {},
): SocketCandidate[] => {
  const tmpDir = "tmpDir" in roots ? roots.tmpDir : process.env.TMPDIR;
  return socketCandidates({
    ...pathInput(place, id),
    ...(tmpDir !== undefined ? { tmpDir } : {}),
    ...(roots.systemTmp !== undefined ? { systemTmp: roots.systemTmp } : {}),
  });
};

/** Why a folder cannot hold a socket, or `undefined`: it must be a real directory of this user with mode 0700. */
export const socketDirProblem = (dir: string, uid: number): string | undefined => {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(dir);
  } catch {
    return `${dir} does not exist`;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return `${dir} is not a real directory`;
  if (info.uid !== uid) return `${dir} is not owned by this user`;
  if ((info.mode & 0o077) !== 0) return `${dir} is not private (mode 0700)`;
  return undefined;
};

/** Why a file is not a socket to connect to, or `undefined`: a socket of this user with mode 0600. */
export const socketFileProblem = (
  path: string,
  uid: number,
  how: "connect" | "unlink" = "connect",
): string | undefined => {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    return `${path} does not exist`;
  }
  if (!info.isSocket()) return `${path} is not a socket`;
  if (info.uid !== uid) return `${path} is not owned by this user`;
  if (how === "connect" && (info.mode & 0o777) !== 0o600) return `${path} does not have mode 0600`;
  return undefined;
};

/**
 * Whether a path, from a record or derived, is this session's socket in a folder that is trusted. The decision
 * does not use `$TMPDIR`: a holder and a client with different ones agree.
 */
export const sessionSocketProblem = (
  path: string,
  place: SessionPlace,
  id: string,
  how: "connect" | "unlink" = "connect",
): string | undefined => {
  const fits = socketPathQualifies(path, pathInput(place, id));
  if (!fits) return `${path} is not a socket path of session ${id}`;
  return socketDirProblem(fits.dir, place.uid) ?? socketFileProblem(path, place.uid, how);
};

export type SocketConnect = (path: string) => Promise<Socket>;

export const connectSocket: SocketConnect = (path) =>
  new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", reject);
  });

/** A socket as the byte stream the attach protocol runs over. */
export const socketStream = (socket: Socket): AttachStream => {
  let closed = false;
  const closers: ((error?: Error) => void)[] = [];
  const finish = (error?: Error) => {
    if (closed) return;
    closed = true;
    for (const listener of closers) listener(error);
  };
  // An error of the peer (a reset, EPIPE) ends this stream and nothing else.
  socket.on("error", (error) => finish(error));
  socket.on("close", () => finish());
  return {
    write(data) {
      if (!closed && !socket.destroyed) socket.write(data);
    },
    pending: () => socket.writableLength,
    onData(listener) {
      socket.on("data", (chunk: Buffer) => listener(new Uint8Array(chunk)));
    },
    onClose(listener) {
      closers.push(listener);
    },
    pause: () => {
      socket.pause();
    },
    resume: () => {
      socket.resume();
    },
    close() {
      if (socket.destroyed) return;
      socket.end();
      // A peer that never reads would keep the socket open for good.
      setTimeout(() => socket.destroy(), 1_000).unref();
    },
  };
};

/** `stale`: nobody listens (it may be removed). `live`: somebody does. `unknown`: not judged, so not touched. */
export const probeSocket = async (
  path: string,
  connect: SocketConnect = connectSocket,
): Promise<"missing" | "not_socket" | "stale" | "live" | "unknown"> => {
  try {
    if (!lstatSync(path).isSocket()) return "not_socket";
  } catch {
    return "missing";
  }
  try {
    (await connect(path)).destroy();
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED") return "stale";
    if (code !== "ENOENT") return "unknown";
    // Bun reports every failed connect to a unix socket as ENOENT, a refused one too: there, a socket file that
    // is still in place was refused. On Node the two codes are told apart, and ENOENT means what it says.
    if (process.versions.bun === undefined) return "missing";
    try {
      return lstatSync(path).isSocket() ? "stale" : "missing";
    } catch {
      return "missing";
    }
  }
};

export interface BoundSocket {
  path: string;
  kind: SocketPlaceKind;
  onClient(listener: (stream: AttachStream) => void): void;
  /** Stops listening and removes the socket file. Safe to call twice. */
  close(): void;
  /**
   * Done when every client's connection is closed, or after `timeoutMs`: what was queued for a client (its `BYE`
   * last) is lost if the process ends before it has left.
   */
  flushed(timeoutMs: number): Promise<void>;
}

export type SocketBinder = (candidates: SocketCandidate[], uid: number) => Promise<BoundSocket>;

const listen = (server: Server, path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

/**
 * Binds the first candidate whose folder can be used. A folder that exists but is not ours (a symlink, another
 * owner, a shared mode) refuses the whole bind instead of moving on: somebody was there first. A leftover socket
 * nobody listens on is replaced; one that answers, or a file that is no socket, refuses.
 */
export const bindSessionSocket: SocketBinder = async (candidates, uid) => {
  if (candidates.length === 0) {
    throw new Error("no socket path is short enough");
  }
  let missing = "";
  for (const candidate of candidates) {
    if (candidate.kind !== "run") {
      try {
        mkdirSync(candidate.dir, { mode: 0o700 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          missing = `${candidate.dir}: ${(error as Error).message}`;
          continue; // the temporary root is not there or cannot be written: the next one
        }
      }
    }
    const problem = socketDirProblem(candidate.dir, uid);
    if (problem) throw new Error(problem);
    const leftover = await probeSocket(candidate.path);
    if (leftover === "stale") rmSync(candidate.path, { force: true });
    else if (leftover !== "missing") {
      throw new Error(
        leftover === "live"
          ? `somebody listens on ${candidate.path}`
          : `${candidate.path} is in the way and is not a stale socket`,
      );
    }
    const server = createServer();
    server.on("error", () => {});
    // The folder is 0700, so the moment between bind and chmod is not open to another user; no umask is set,
    // because a umask of the holder would be the child's too.
    await listen(server, candidate.path);
    try {
      chmodSync(candidate.path, 0o600);
    } catch (error) {
      server.close();
      rmSync(candidate.path, { force: true });
      throw error;
    }
    let closed = false;
    const open = new Set<Socket>();
    let idle: (() => void) | undefined;
    server.on("connection", (socket) => {
      open.add(socket);
      socket.once("close", () => {
        open.delete(socket);
        if (open.size === 0) idle?.();
      });
    });
    return {
      path: candidate.path,
      kind: candidate.kind,
      onClient(listener) {
        server.on("connection", (socket) => listener(socketStream(socket)));
      },
      flushed(timeoutMs) {
        if (open.size === 0) return Promise.resolve();
        return new Promise((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          idle = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      },
      close() {
        if (closed) return;
        closed = true;
        server.close();
        rmSync(candidate.path, { force: true });
      },
    };
  }
  throw new Error(`no folder for the socket (${missing})`);
};

/**
 * Removes what a holder that could not clean up left: the derived paths of this session and, when it is one of
 * this session's, the path a record names. Only a socket of this user in a trusted folder that nobody listens on
 * goes; everything else stays. It needs no record.
 */
export const sweepSessionSockets = async (
  place: SessionPlace,
  id: string,
  options: { stored?: string; roots?: SocketRoots; connect?: SocketConnect } = {},
): Promise<string[]> => {
  const paths = new Set(sessionSocketCandidates(place, id, options.roots).map((c) => c.path));
  if (options.stored !== undefined) paths.add(options.stored);
  const removed: string[] = [];
  for (const path of paths) {
    if (sessionSocketProblem(path, place, id, "unlink") !== undefined) continue;
    if ((await probeSocket(path, options.connect)) !== "stale") continue;
    rmSync(path, { force: true });
    removed.push(path);
  }
  return removed;
};
