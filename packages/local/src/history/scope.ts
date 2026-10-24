/**
 * Which files a history collector may open. Everything here is about paths and stays away from file
 * contents: a collector looks only at the sessions of a Kodel project, the project being a directory tree
 * with the Kodel marker (`findProjectRoot`), its worktrees included.
 */
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { KodelError } from "@kodel-ai/pipeline-core";
import { git } from "../git";

const FOLDS_CASE = process.platform === "win32" || process.platform === "darwin";
const comparable = (path: string): string =>
  FOLDS_CASE ? resolve(path).toLowerCase() : resolve(path);

export function isInside(parent: string, child: string): boolean {
  const p = comparable(parent);
  const c = comparable(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Throws `HISTORY_PATH_OUTSIDE_PROJECT` unless the real path of `path` (symlinks followed) is inside one of
 * `allowed`. The check is on the real path, so a link inside the allowed directory that leads out is refused.
 */
export async function assertInside(
  path: string,
  allowed: readonly string[],
  what: string,
): Promise<string> {
  const real = await realOrSelf(path);
  for (const dir of allowed) {
    if (isInside(await realOrSelf(dir), real)) return real;
  }
  throw new KodelError(
    "HISTORY_PATH_OUTSIDE_PROJECT",
    `${what} is outside the project and the agent's own session store: ${basename(path)}`,
    undefined,
    { path },
  );
}

/**
 * The directories whose sessions belong to the project: the root, the run worktrees under
 * `.kodel/worktrees/` and the worktrees git lists (best effort; no git is no error).
 */
export async function projectWorkdirs(root: string): Promise<string[]> {
  const dirs = new Set<string>([await realOrSelf(root)]);
  try {
    const base = join(root, ".kodel", "worktrees");
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.add(await realOrSelf(join(base, entry.name)));
    }
  } catch {
    // no run worktrees yet
  }
  try {
    const { stdout } = await git(["worktree", "list", "--porcelain"], root);
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree "))
        dirs.add(await realOrSelf(line.slice("worktree ".length).trim()));
    }
  } catch {
    // not a git repository, or git is not there
  }
  return [...dirs];
}

/** The marker of a Kodel project: the committed project config (the same file `findProjectRoot` looks for). */
const MARKER = join(".kodel", "config.yaml");

/** A collector looks only at Kodel projects: a directory without the marker is not one, whatever it is called. */
export const isKodelProject = (root: string): Promise<boolean> => isFile(join(root, MARKER));

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
