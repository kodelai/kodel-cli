/**
 * A git worktree for each run: the directory its commands, checks and snapshots work in.
 *
 * The core only carries the directory as a string; making it, finding it again and judging whether
 * it is still the one that was made are effects, and they live here behind `WorkdirProvider`, so a
 * server can answer the same questions with a runner of its own.
 *
 * Nothing the agent says decides where a command runs. The `cwd` it reports is a hint for reusing a
 * worktree it is already in; it is checked against what git itself lists, and a hint that does not
 * check out is not an error, it just means a new worktree is made.
 */
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { KodelError } from "@kodel-ai/pipeline-core";
import { DEFAULT_WORKTREE, type WorktreeConfig } from "./config";
import { git, readHead } from "./git";

export interface Workdir {
  /** Absolute, as the file system names it (symbolic links resolved). */
  path: string;
  /** The branch made for the run; only set when the worktree was made for it. */
  branch?: string;
  /** Whether this call made the directory (and so may take it away again). */
  created: boolean;
  /** Something the agent and the person should know about it. */
  note?: string;
  /** The commit the work began at; none for a directory without commits. */
  base?: string;
}

export interface WorkdirProvider {
  /**
   * The directory for a new run: a worktree made for it, or the one the caller is already in.
   * `undefined`: the run works in the repository root (the feature is off, or there is no git).
   * Throws `WORKDIR_CREATE_FAILED` when a directory was due and could not be made.
   */
  prepare(input: { runId: string; callerCwd?: string }): Promise<Workdir | undefined>;
  /** Throws `WORKDIR_MISSING` or `WORKDIR_INVALID`; called before every command and snapshot. */
  verify(workdir: string): Promise<void>;
  /** Take away what `prepare` made, after a start that did not complete. */
  discard(workdir: Workdir): Promise<void>;
}

const FOLDS_CASE = process.platform === "win32" || process.platform === "darwin";

/** One spelling of a path for comparing: separators as the platform has them, case folded where it is. */
const comparable = (path: string): string => {
  const resolved = resolve(path);
  return FOLDS_CASE ? resolved.toLowerCase() : resolved;
};

export const sameDir = (a: string, b: string): boolean => comparable(a) === comparable(b);

const isInside = (parent: string, child: string): boolean => {
  const p = comparable(parent);
  const c = comparable(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
};

/** A path that may not exist yet, with the part that does exist resolved. */
async function realOfFuture(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = resolve(absolute, "..");
    if (parent === absolute) return absolute;
    return join(await realOfFuture(parent), absolute.slice(parent.length + 1));
  }
}

async function commonDir(cwd: string): Promise<string> {
  const { stdout } = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  return realpath(stdout.trim());
}

/** The worktrees git lists for the repository at `cwd`, the main one first. */
async function listWorktrees(cwd: string): Promise<string[]> {
  const { stdout } = await git(["worktree", "list", "--porcelain"], cwd);
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function isListed(listed: string[], dir: string): Promise<boolean> {
  for (const path of listed) {
    if (sameDir(await realpath(path).catch(() => path), dir)) return true;
  }
  return false;
}

async function isRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await git(["rev-parse", "--is-inside-work-tree"], cwd);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export class GitWorktreeProvider implements WorkdirProvider {
  constructor(
    private readonly root: string,
    private readonly config: WorktreeConfig = DEFAULT_WORKTREE,
  ) {}

  async prepare(input: { runId: string; callerCwd?: string }): Promise<Workdir | undefined> {
    if (this.config.mode === "off") return undefined;
    // Nothing to isolate in a directory without git; a pipeline without diff checks may well run there.
    if (!(await isRepo(this.root))) return undefined;
    if (input.callerCwd !== undefined) {
      const reused = await this.reusable(input.callerCwd);
      if (reused) return reused;
    }
    return this.create(input.runId);
  }

  /**
   * The worktree the caller is in, when it is a linked worktree of this repository, lies inside
   * `worktree.dir`, and is not the one kodel itself works from (the root may be a linked worktree
   * or a subfolder of one).
   */
  private async reusable(callerCwd: string): Promise<Workdir | undefined> {
    try {
      if (!isAbsolute(callerCwd)) return undefined;
      const { stdout } = await git(["rev-parse", "--show-toplevel"], await realpath(callerCwd));
      const top = await realpath(stdout.trim());
      const [main, ...linked] = await listWorktrees(this.root);
      if (main === undefined || sameDir(top, await realpath(main))) return undefined;
      const { stdout: rootTop } = await git(["rev-parse", "--show-toplevel"], this.root);
      if (sameDir(top, await realpath(rootTop.trim()))) return undefined;
      if (!(await isListed(linked, top))) return undefined;
      if (!sameDir(await commonDir(top), await commonDir(this.root))) return undefined;
      // Only the folder the person set aside for worktrees: their own feature worktrees are not ours to run in.
      if (!isInside(await this.resolveDir(), top)) return undefined;
      const base = await readHead(top);
      return { path: top, created: false, ...(base === undefined ? {} : { base }) };
    } catch {
      return undefined;
    }
  }

  private async resolveDir(): Promise<string> {
    const root = await realpath(this.root);
    const dir = await realOfFuture(
      isAbsolute(this.config.dir) ? this.config.dir : join(root, this.config.dir),
    );
    if (sameDir(dir, root)) {
      throw new KodelError(
        "CONFIG_INVALID",
        `worktree.dir "${this.config.dir}" is the repository root itself`,
      );
    }
    if (isInside(await commonDir(root), dir)) {
      throw new KodelError("CONFIG_INVALID", `worktree.dir "${this.config.dir}" is inside .git`);
    }
    return dir;
  }

  private async create(runId: string): Promise<Workdir> {
    const dir = await this.resolveDir();
    const path = join(dir, runId);
    const branch = `kodel/${runId}`;
    // A hook the repository carries (post-checkout) would run as the person; it is switched off for
    // this one call with an empty hooks directory.
    const hooks = await mkdtemp(join(tmpdir(), "kodel-hooks-"));
    let made = false;
    try {
      await mkdir(dir, { recursive: true });
      // The branch starts at the SHA that is recorded, not at whatever HEAD is a moment later.
      const base = await readHead(this.root);
      await git(["worktree", "add", "-b", branch, path, base ?? "HEAD"], this.root, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: hooks,
      });
      made = true;
      const workdir: Workdir = {
        path: await realpath(path),
        branch,
        created: true,
        ...(base === undefined ? {} : { base }),
      };
      if (await this.rootIsDirty().catch(() => false)) {
        workdir.note =
          "the repository root has uncommitted changes; the worktree starts from HEAD and does not have them";
      }
      return workdir;
    } catch (error) {
      // What this call made is taken away again: `prepare` throwing means nobody else knows of it.
      if (made) await this.discard({ path, branch, created: true });
      throw new KodelError(
        "WORKDIR_CREATE_FAILED",
        `could not make a worktree for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await rm(hooks, { recursive: true, force: true });
    }
  }

  private async rootIsDirty(): Promise<boolean> {
    // The pathspecs are relative to `root`, the project folder, so a package project looks at itself.
    const { stdout } = await git(
      ["status", "--porcelain", "--", ".", ":(exclude).kodel"],
      this.root,
      { GIT_OPTIONAL_LOCKS: "0" },
    );
    return stdout.trim().length > 0;
  }

  async verify(workdir: string): Promise<void> {
    let actual: string;
    try {
      actual = await realpath(workdir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new KodelError(
          "WORKDIR_MISSING",
          `the working directory of this run is gone: ${workdir}`,
        );
      }
      throw new KodelError(
        "WORKDIR_INVALID",
        `the working directory of this run cannot be used: ${workdir} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    // The recorded path is a real one; if it now leads somewhere else, something (a symbolic link,
    // say) was put in its place.
    if (!sameDir(actual, workdir)) {
      throw new KodelError(
        "WORKDIR_INVALID",
        `the working directory of this run is not the one that was made: ${workdir} now leads to ${actual}`,
      );
    }
    let listed = false;
    let sameRepo = false;
    try {
      listed = await isListed(await listWorktrees(this.root), actual);
      sameRepo = sameDir(await commonDir(actual), await commonDir(this.root));
    } catch (error) {
      throw new KodelError(
        "WORKDIR_INVALID",
        `could not check the working directory ${workdir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!listed || !sameRepo) {
      throw new KodelError(
        "WORKDIR_INVALID",
        `${workdir} is not a worktree of this repository (git does not list it, or it belongs to another repository)`,
      );
    }
  }

  async discard(workdir: Workdir): Promise<void> {
    if (!workdir.created) return;
    await git(["worktree", "remove", "--force", workdir.path], this.root).catch(async () => {
      await rm(workdir.path, { recursive: true, force: true });
      await git(["worktree", "prune"], this.root).catch(() => undefined);
    });
    if (workdir.branch) {
      await git(["branch", "-D", workdir.branch], this.root).catch(() => undefined);
    }
  }
}
