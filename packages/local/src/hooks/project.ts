/**
 * Finding the Kodel project an event belongs to. The marker is `.kodel/config.yaml` (the committed
 * project config); only `stat` is used, so outside a project nothing is read.
 */
import { stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

const MARKER = join(".kodel", "config.yaml");
const WORKTREES = join(".kodel", "worktrees");
const MAX_DEPTH = 64;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The project root for a working directory: the nearest directory upward with a marker. A run works
 * in a worktree inside `<project>/.kodel/worktrees/`, which has a marker of its own (it is committed);
 * its events belong to the project that holds it, because the worktree is thrown away with the run.
 */
export async function findProjectRoot(cwd: string): Promise<string | undefined> {
  const markers: string[] = [];
  let dir = cwd;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (await isFile(join(dir, MARKER))) markers.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const nearest = markers[0];
  if (nearest === undefined) return undefined;
  // The outermost holder wins: a worktree of a worktree is still the project's.
  for (const outer of [...markers.slice(1)].reverse()) {
    if (nearest.startsWith(join(outer, WORKTREES) + sep)) return outer;
  }
  return nearest;
}
