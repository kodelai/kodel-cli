/**
 * Where the attach socket of a terminal session may be. Pure: strings in, strings out; the directory and file
 * checks, the bind and the unlink are in `packages/local`.
 *
 * A session id is unique only inside one checkout, while the folders a socket can be in are per user, so the
 * file name carries the checkout. A unix socket path is short (`sun_path`), so a path that is too long falls
 * back to a hashed name in a private folder under a temporary root.
 */
import { isLocalSessionId, SessionError } from "./session";

/** The longest socket path used, in bytes (`sun_path` holds 104 on macOS and 108 on Linux, with the end mark). */
export const SOCKET_PATH_MAX_BYTES = 100;

export type SocketPlaceKind = "run" | "tmpdir" | "tmp";

export interface SocketCandidate {
  kind: SocketPlaceKind;
  dir: string;
  path: string;
}

export interface SocketPathInput {
  /** `<state base>/run/<uid>`: private already, shared by every checkout of the user. */
  runDir: string;
  uid: number;
  checkoutKey: string;
  id: string;
  /** Hex digest of a text (sha-256 in the local adapter); the core does not hash by itself. */
  hash: (text: string) => string;
  /** `$TMPDIR` of this process, when it has one. */
  tmpDir?: string;
  /** The last fallback; `/tmp` when absent. */
  systemTmp?: string;
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;
const join = (dir: string, name: string): string => `${dir.replace(/\/+$/, "")}/${name}`;

/** The two file names a session's socket can have: beside the records, and in a fallback folder. */
export const socketNames = (
  input: Pick<SocketPathInput, "checkoutKey" | "id" | "hash">,
): { primary: string; hashed: string } => {
  // The id becomes part of a path that is bound, connected to and unlinked.
  if (!isLocalSessionId(input.id)) {
    throw new SessionError("NOT_FOUND", `no session ${JSON.stringify(input.id)}`);
  }
  return {
    primary: `${input.id}-${input.hash(input.checkoutKey).slice(0, 8)}.sock`,
    hashed: `${input.hash(`${input.checkoutKey}\u0000${input.id}`).slice(0, 16)}.sock`,
  };
};

/** The name of the private fallback folder under a temporary root. */
export const socketTmpDirName = (uid: number): string => `kodel-${uid}`;

/** The places to try, in order; one whose path is longer than the limit is left out. */
export const socketCandidates = (input: SocketPathInput): SocketCandidate[] => {
  const names = socketNames(input);
  const all: SocketCandidate[] = [
    { kind: "run", dir: input.runDir, path: join(input.runDir, names.primary) },
  ];
  const roots: [SocketPlaceKind, string | undefined][] = [
    ["tmpdir", input.tmpDir],
    ["tmp", input.systemTmp ?? "/tmp"],
  ];
  for (const [kind, root] of roots) {
    if (root === undefined || root === "" || !root.startsWith("/")) continue;
    const dir = join(root, socketTmpDirName(input.uid));
    if (all.some((c) => c.dir === dir)) continue;
    all.push({ kind, dir, path: join(dir, names.hashed) });
  }
  return all.filter((c) => bytesOf(c.path) <= SOCKET_PATH_MAX_BYTES);
};

/**
 * Whether a path (from a record, so untrusted) has the name this session's socket would have in a folder a
 * socket may be in. It does not look at today's `$TMPDIR`: a holder and a client with different ones agree.
 * What the folder and the file really are is for the caller to check.
 */
export const socketPathQualifies = (
  path: string,
  input: Pick<SocketPathInput, "runDir" | "uid" | "checkoutKey" | "id" | "hash">,
): { kind: "run" | "fallback"; dir: string } | undefined => {
  if (!path.startsWith("/") || bytesOf(path) > SOCKET_PATH_MAX_BYTES) return undefined;
  const cut = path.lastIndexOf("/");
  const dir = path.slice(0, cut);
  const name = path.slice(cut + 1);
  if (dir.split("/").some((part) => part === "." || part === "..")) return undefined;
  const names = socketNames(input);
  if (name === names.primary && dir === input.runDir.replace(/\/+$/, ""))
    return { kind: "run", dir };
  const folder = dir.slice(dir.lastIndexOf("/") + 1);
  if (name === names.hashed && folder === socketTmpDirName(input.uid)) {
    return { kind: "fallback", dir };
  }
  return undefined;
};
