/**
 * Finding the Kodel project an event belongs to. It is the same answer the CLI, the MCP server and
 * the host get (`findProjectRoot` of the package): the nearest project marker, bounded by the git
 * repository, with a linked worktree mapped to the main checkout. A hook never fails, so a place
 * with no project is `undefined` and nothing is written.
 */
import { dirname, join, sep } from "node:path";
import { hasMarker, locateProject } from "../project-locate";

const WORKTREES = join(".kodel", "worktrees");
const MAX_DEPTH = 64;

/**
 * The project root for a working directory. A run works in a worktree inside
 * `<project>/.kodel/worktrees/`, which has a marker of its own (it is committed); its events belong
 * to the project that holds it even where git cannot say so, because the worktree is thrown away
 * with the run.
 */
export async function findProjectRoot(cwd: string): Promise<string | undefined> {
  let nearest: string;
  try {
    const found = await locateProject(cwd, { env: process.env });
    if (found === undefined) return undefined;
    nearest = found.root;
  } catch {
    return undefined;
  }
  let outermost: string | undefined;
  let dir = nearest;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (nearest.startsWith(join(dir, WORKTREES) + sep) && (await hasMarker(dir))) outermost = dir;
  }
  return outermost ?? nearest;
}
