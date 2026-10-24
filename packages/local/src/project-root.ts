/**
 * Where the project is: the one place that answers it for the CLI, the MCP server and the host.
 *
 * A project is a directory with a committed `.kodel/config.yaml`. The nearest one above the working
 * directory wins (a monorepo may have one per package). Git is used for two things only: the walk
 * does not leave the repository it starts in, and a linked worktree is mapped to the same place in
 * the main checkout, where the runs, the tasks and the config live. Whatever git says is trusted no
 * further than that: a `gitdir:` file is never read here, and anything unexpected means "work in place".
 */
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { KodelError } from "@kodel-ai/pipeline-core";
import { CONFIG_FILE } from "./config";
import { git } from "./git";

export const DATA_DIR = ".kodel";

export const NO_PROJECT_MESSAGE =
  "no Kodel project here (no .kodel/config.yaml in this folder or above); run `kodel init` here, or pass --root";

export interface ProjectRoot {
  /** The project directory. */
  root: string;
  /** Where the project keeps its data (runs, tasks, pipelines, config); `<root>/.kodel` for now. */
  dataDir: string;
  via: "explicit" | "marker" | "worktree";
  /** The main checkout, when the project was found in a linked worktree of it. */
  worktreeOf?: string;
  /** The walk went above the working directory, with no git repository to bound it. */
  climbed?: boolean;
}

export interface FindProjectOptions {
  /** `--root`: used as is. */
  explicit?: string | undefined;
  /** The environment; `KODEL_ROOT` is looked at. */
  env?: Record<string, string | undefined>;
  /** The home folder, whose `.kodel` belongs to another product; defaults to the user's. */
  home?: string;
}

const dataDirOf = (root: string): string => join(root, DATA_DIR);

/** A real file or folder, not a link: a repository must not be able to point the marker elsewhere. */
async function isReal(path: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const info = await lstat(path);
    return kind === "file" ? info.isFile() : info.isDirectory();
  } catch {
    return false;
  }
}

const hasMarker = async (dir: string) =>
  (await isReal(join(dir, DATA_DIR), "directory")) &&
  (await isReal(join(dir, DATA_DIR, CONFIG_FILE), "file"));

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function gitOut(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(args, cwd);
    const text = stdout.trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

export async function findProjectRoot(
  cwd: string,
  options: FindProjectOptions = {},
): Promise<ProjectRoot> {
  const named = options.explicit || options.env?.KODEL_ROOT;
  if (named) {
    const root = resolve(cwd, named);
    return { root, dataDir: dataDirOf(root), via: "explicit" };
  }

  const start = await realOrSelf(cwd);
  const topText = await gitOut(["rev-parse", "--show-toplevel"], start);
  const top = topText === undefined ? undefined : await realOrSelf(topText);
  // A top that is not above where we are (an odd answer) is no boundary.
  const bounded = top !== undefined && isInside(top, start) ? top : undefined;
  const home = await realOrSelf(options.home ?? homedir());

  let found: string | undefined;
  for (let dir = start; ; dir = dirname(dir)) {
    if (dir !== home && (await hasMarker(dir))) {
      found = dir;
      break;
    }
    if (dir === bounded || dirname(dir) === dir) break;
  }
  if (found === undefined) throw new KodelError("NO_PROJECT", NO_PROJECT_MESSAGE);

  if (bounded !== undefined) {
    const main = await mainCheckout(start);
    if (main !== undefined) {
      const mapped = join(main, relative(bounded, found));
      if (await hasMarker(mapped)) {
        return { root: mapped, dataDir: dataDirOf(mapped), via: "worktree", worktreeOf: main };
      }
    }
  }
  return {
    root: found,
    dataDir: dataDirOf(found),
    via: "marker",
    ...(bounded === undefined && found !== start ? { climbed: true } : {}),
  };
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The main checkout, when `cwd` is in a linked worktree of it: git's common directory is not the
 * worktree's own, and it is a folder named `.git` (a submodule's, or a bare repository's, is not).
 */
async function mainCheckout(cwd: string): Promise<string | undefined> {
  const common = await gitOut(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  const own = await gitOut(["rev-parse", "--path-format=absolute", "--absolute-git-dir"], cwd);
  if (common === undefined || own === undefined) return undefined;
  const commonDir = await realOrSelf(common);
  if (commonDir === (await realOrSelf(own))) return undefined;
  if (basename(commonDir) !== ".git") return undefined;
  return dirname(commonDir);
}
