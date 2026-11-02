import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isLocalSessionId, SessionError } from "@kodel-ai/pipeline-core";
import { checkoutKey } from "./storage-paths";

/**
 * Where the local adapters keep session records: `<state base>/run/<uid>/<checkoutKey>/<id>/`, outside the
 * repository and independent of the `storage` key. Markers that hold a name live in a sibling folder
 * (`<checkoutKey>.names/`), outside the id namespace, so `rm` and `prune` can never reach them.
 */
export interface SessionPlace {
  /** `<base>/run/<uid>` */
  runDir: string;
  /** Session folders of this checkout. */
  dir: string;
  /** Name markers of this checkout. */
  namesDir: string;
  /** Sockets (PTY, M2) are `<runDir>/<id>.sock`. */
  key: string;
}

export interface SessionPlaceInput {
  base: string;
  root: string;
  uid?: number;
}

const currentUid = (): number => (typeof process.getuid === "function" ? process.getuid() : 0);

/** The checkout is keyed on its real path, through one helper for the host and the CLI. */
export const sessionCheckoutKey = (root: string): string => {
  let real = root;
  try {
    real = realpathSync.native(root);
  } catch {
    // a root that does not exist yet keeps its spelling
  }
  return checkoutKey(real);
};

export const sessionPlace = (input: SessionPlaceInput): SessionPlace => {
  const uid = input.uid ?? currentUid();
  const runDir = join(input.base, "run", String(uid));
  const key = sessionCheckoutKey(input.root);
  return { runDir, dir: join(runDir, key), namesDir: join(runDir, `${key}.names`), key };
};

/** The folder of one session. Refuses anything but the shape the local adapter makes. */
export const sessionDirOf = (place: SessionPlace, id: string): string => {
  if (!isLocalSessionId(id))
    throw new SessionError("NOT_FOUND", `no session ${JSON.stringify(id)}`);
  return join(place.dir, id);
};

export const newSessionId = (
  now: number = Date.now(),
  random: () => number = Math.random,
): string => {
  const time = now.toString(36).padStart(9, "0").slice(-9);
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0")
    .slice(-4);
  return `a_${time}_${suffix}`;
};

/** A real directory owned by the user with mode 0700, or `start` refuses (a symlink or a shared folder is not trusted). */
export const ensurePrivateDir = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SessionError("STATE_UNWRITABLE", `${path} is not a real directory`);
  }
  if (process.platform !== "win32") {
    if (info.uid !== currentUid())
      throw new SessionError("STATE_UNWRITABLE", `${path} is not owned by this user`);
    if ((info.mode & 0o077) !== 0)
      throw new SessionError("STATE_UNWRITABLE", `${path} is not private (mode 0700)`);
  }
};
