/**
 * Working-tree snapshots for `diff` baselines.
 *
 * A snapshot is a git tree object built from the working tree (tracked and untracked files that
 * are not ignored, uncommitted changes included) through a private index. The user's own index,
 * working tree and branches are never touched; the only trace is a few unreferenced objects that
 * `git gc` removes. The changes between two snapshots are `git diff --numstat` between the two
 * trees: added plus removed lines per path.
 *
 * Nothing here may run code the repository's own files ask for. The agent can write
 * `.gitattributes` and `.git/config`, and `git add` and `git diff` would run the clean filters,
 * text conversions and external diff programs those name, as the user, outside any sandbox. So the
 * tree is built from plumbing that does not read attributes (`hash-object --no-filters`,
 * `update-index --index-info`), and the diff is told to use neither text conversion nor an external
 * program. The price is that files are read again for every snapshot.
 */
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readlink, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangeSet } from "@kodel-ai/pipeline-core";

interface GitResult {
  stdout: string;
}

/** How much time is left for work made of several git calls. */
export interface Deadline {
  remainingMs(): number;
}

export const deadlineIn = (ms: number): Deadline => {
  const end = Date.now() + ms;
  return { remainingMs: () => end - Date.now() };
};

/** Thrown when the time ran out; its text starts with `deadline:` so the journal says what it was. */
export class DeadlineError extends Error {
  constructor() {
    super("deadline: git took longer than the time allowed for recording the changes");
  }
}

// The same rule as `isTreeId` of the core. Not imported: this file is also in the bundle of the hook,
// which must stay small, and the core is not.
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** A tree id from a file the agent can write must be one before git sees it as an argument. */
export function checkTreeId(value: unknown, what: string): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) {
    throw new Error(`${what} is not a git object id`);
  }
  return value;
}

/**
 * The way from the top of the repository down to `cwd`, `/`-free at the ends; empty at the top, or
 * when `cwd` is not in a repository (a project then has no folder of its own inside a worktree).
 */
export async function repoPrefix(cwd: string): Promise<string> {
  try {
    const { stdout } = await git(["rev-parse", "--show-prefix"], cwd);
    return stdout.trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** Configuration that would let the repository run something on our behalf, switched off. */
export const SAFE_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  // A log read would otherwise run the `gpg.program` the repository names to show a signature.
  "-c",
  "log.showSignature=false",
];

/**
 * Hooks off, for the calls of a snapshot. Only there: the worktrees kodel makes should still run the
 * hooks of the project the person set up, but a snapshot reads the tree the agent has just been writing.
 */
export const NO_HOOKS = ["-c", `core.hooksPath=${devNull}`];

/** The git command in an argument list, past options such as `-c key=value`: what an error names. */
export function commandName(args: string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "-c") i += 1;
    else if (!arg.startsWith("-")) return arg;
  }
  return args[0] ?? "";
}

/** Run git with the hardened configuration; the one place the local adapters start it. */
export function git(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  input?: string,
  timeoutMs?: number,
): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    const child = execFile(
      "git",
      [...SAFE_CONFIG, ...args],
      {
        cwd,
        env: { ...process.env, ...env },
        maxBuffer: 256 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" as const }),
      },
      (error, stdout, stderr) => {
        if (error) {
          // `killed` is also set when the output outgrew the buffer; that is not the time running out.
          const tooMuch = (error as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          if (timeoutMs !== undefined && (error as { killed?: boolean }).killed && !tooMuch) {
            reject(new DeadlineError());
            return;
          }
          const detail = (stderr || error.message).trim();
          reject(new Error(`git ${commandName(args)} failed: ${detail}`));
        } else {
          resolveResult({ stdout });
        }
      },
    );
    child.stdin?.on("error", () => undefined); // a failing git reports through the callback
    child.stdin?.end(input ?? "");
  });
}

/** The most commits a run's journal names; the rest is counted as cut off. */
export const MAX_RUN_COMMITS = 200;

const MAX_REFLOG_ENTRIES = MAX_RUN_COMMITS * 4;

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The commit HEAD points at in `cwd`; none for no repository, no git, or a branch without commits. */
export async function readHead(cwd: string, timeoutMs?: number): Promise<string | undefined> {
  try {
    const { stdout } = await git(
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      cwd,
      { GIT_OPTIONAL_LOCKS: "0" },
      undefined,
      timeoutMs,
    );
    const sha = stdout.trim();
    return SHA.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

export interface RunCommits {
  head?: string;
  commits?: string[];
  truncated?: boolean;
}

/**
 * HEAD of `cwd` and the commits made since `base`: first those reachable from HEAD, then the ones
 * the HEAD reflog shows were left behind (amended, reset away). The reflog of a worktree is its own;
 * in the repository root it also holds older moves, so only entries from `sinceSeconds` on count.
 * With the reflog off or expired the first part stands alone. The reflog also shows where HEAD went
 * by a checkout or a merge, so commits the agent only moved onto are listed with its own. Nothing
 * here throws: these facts are a record, they never fail a step.
 */
export async function readRunCommits(
  cwd: string,
  base: string | undefined,
  sinceSeconds: number,
  /** When given, every git call is held to it, and a call cut off by it throws `DeadlineError`. */
  deadline?: Deadline,
): Promise<RunCommits> {
  const left = () => {
    if (deadline === undefined) return undefined;
    const ms = deadline.remainingMs();
    if (ms <= 0) throw new DeadlineError();
    return ms;
  };
  const head = await readHead(cwd, left());
  if (head === undefined) return {};
  if (base === undefined || !SHA.test(base)) return { head };
  const env = { GIT_OPTIONAL_LOCKS: "0" };
  const seen = new Set<string>([base]);
  const commits: string[] = [];
  const add = (sha: string | undefined) => {
    if (sha === undefined || !SHA.test(sha) || seen.has(sha)) return;
    seen.add(sha);
    commits.push(sha);
  };
  try {
    const { stdout } = await git(
      ["rev-list", `--max-count=${MAX_RUN_COMMITS + 1}`, `${base}..${head}`],
      cwd,
      env,
      undefined,
      left(),
    );
    for (const line of stdout.split("\n")) add(line.trim());
  } catch (error) {
    if (error instanceof DeadlineError) throw error;
    // base unknown to this repository (a shallow clone, say): the reflog may still tell
  }
  let reflogCut = false;
  try {
    const { stdout } = await git(
      [
        "reflog",
        "show",
        "--date=unix",
        "--format=%H %gd",
        `--max-count=${MAX_REFLOG_ENTRIES}`,
        "HEAD",
      ],
      cwd,
      env,
      undefined,
      left(),
    );
    const rows = stdout.split("\n").filter(Boolean);
    let oldest = Number.POSITIVE_INFINITY;
    for (const line of rows) {
      const [sha, selector] = line.trim().split(" ");
      const at = Number(/@\{(\d+)\}$/.exec(selector ?? "")?.[1]);
      if (!Number.isFinite(at)) continue;
      oldest = Math.min(oldest, at);
      if (at >= sinceSeconds) add(sha);
    }
    // Cut only if what was read still reaches back into the run; older entries are not the run's.
    reflogCut = rows.length >= MAX_REFLOG_ENTRIES && oldest >= sinceSeconds;
  } catch (error) {
    if (error instanceof DeadlineError) throw error;
    // no reflog (core.logAllRefUpdates=false, or nothing yet)
  }
  const truncated = commits.length > MAX_RUN_COMMITS || reflogCut;
  return { head, commits: commits.slice(0, MAX_RUN_COMMITS), ...(truncated ? { truncated } : {}) };
}

export interface SnapshotterOptions {
  /** Directories that are never part of a snapshot (relative to the repository root). */
  exclude?: string[];
}

/** A path that `hash-object --stdin-paths` could misread: it takes one path a line, and unquotes. */
const awkwardPath = (path: string) => /[\n\r]/.test(path) || path.startsWith('"');

export class GitSnapshotter {
  private readonly exclude: string[];

  constructor(
    readonly root: string,
    options: SnapshotterOptions = {},
  ) {
    // Relative to `root`, which is the project folder: a package project excludes its own `.kodel`.
    this.exclude = options.exclude ?? [".kodel"];
  }

  async isRepo(timeoutMs?: number): Promise<boolean> {
    try {
      const { stdout } = await git(
        ["rev-parse", "--is-inside-work-tree"],
        this.root,
        {},
        undefined,
        timeoutMs,
      );
      return stdout.trim() === "true";
    } catch (error) {
      // Out of time is not "not a repository": it is what the deadline is for.
      if (error instanceof DeadlineError) throw error;
      return false;
    }
  }

  private excluded(path: string): boolean {
    return this.exclude.some((dir) => path === dir || path.startsWith(`${dir}/`));
  }

  /** The tree object of the working tree as it is now. */
  async snapshot(deadline?: Deadline): Promise<string> {
    // One deadline for all the git calls and the loop between them: a tree of thousands of files or
    // links is many calls, and a limit on each would not bound the whole.
    // No hooks: `update-index` runs `post-index-change` of the repository even on a private index,
    // and the agent can write that file. A snapshot is now taken at every hand-in.
    const call = (args: string[], env: Record<string, string> = {}, input?: string) => {
      const full = [...NO_HOOKS, ...args];
      if (deadline === undefined) return git(full, this.root, env, input);
      const left = deadline.remainingMs();
      if (left <= 0) return Promise.reject(new DeadlineError());
      return git(full, this.root, env, input, left);
    };
    if (
      !(await this.isRepo(deadline === undefined ? undefined : Math.max(deadline.remainingMs(), 1)))
    ) {
      throw new Error(`the diff check needs a git repository, and ${this.root} is not inside one`);
    }
    // The listing is relative to the directory we are in; the index wants paths from the top of the
    // repository, so the way down to this directory goes in front of each.
    const { stdout: prefixOut } = await call(["rev-parse", "--show-prefix"]);
    const prefix = prefixOut.trim();
    const { stdout: listed } = await call(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        GIT_OPTIONAL_LOCKS: "0",
      },
    );
    const paths = [...new Set(listed.split("\0").filter(Boolean))].filter((p) => !this.excluded(p));

    const regular: { path: string; mode: string }[] = [];
    const entries: { mode: string; sha: string; path: string }[] = [];
    for (const path of paths) {
      if (deadline !== undefined && deadline.remainingMs() <= 0) throw new DeadlineError();
      const info = await lstat(join(this.root, path)).catch(() => undefined);
      if (!info) continue; // tracked, but deleted from the working tree
      if (info.isSymbolicLink()) {
        const target = await readlink(join(this.root, path));
        const { stdout } = await call(["hash-object", "-w", "--no-filters", "--stdin"], {}, target);
        entries.push({ mode: "120000", sha: stdout.trim(), path: `${prefix}${path}` });
      } else if (info.isFile()) {
        regular.push({ path, mode: info.mode & 0o111 ? "100755" : "100644" });
      }
      // directories (a submodule, say) and special files are not part of a snapshot
    }

    const plain = regular.filter((f) => !awkwardPath(f.path));
    if (plain.length > 0) {
      const { stdout } = await call(
        ["hash-object", "-w", "--no-filters", "--stdin-paths"],
        {},
        `${plain.map((f) => join(this.root, f.path)).join("\n")}\n`,
      );
      const shas = stdout.split("\n").filter(Boolean);
      if (shas.length !== plain.length)
        throw new Error("git hash-object answered for fewer files than asked");
      for (const [i, f] of plain.entries()) {
        entries.push({ mode: f.mode, sha: shas[i] as string, path: `${prefix}${f.path}` });
      }
    }
    for (const f of regular.filter((r) => awkwardPath(r.path))) {
      const { stdout } = await call([
        "hash-object",
        "-w",
        "--no-filters",
        "--",
        join(this.root, f.path),
      ]);
      entries.push({ mode: f.mode, sha: stdout.trim(), path: `${prefix}${f.path}` });
    }

    const scratch = await mkdtemp(join(tmpdir(), "kodel-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(scratch, "index"), GIT_OPTIONAL_LOCKS: "0" };
      await call(
        ["update-index", "--add", "-z", "--index-info"],
        env,
        entries.map((e) => `${e.mode} ${e.sha}\t${e.path}\0`).join(""),
      );
      const { stdout: tree } = await call(["write-tree"], env);
      return tree.trim();
    } finally {
      // A folder that cannot be removed (a file still open on Windows) must not replace the tree that
      // was made: a snapshot is taken at every hand-in now.
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => undefined,
      );
    }
  }

  /** Changed lines per path between two snapshots; a binary file counts as one line. */
  async changes(from: string, to: string): Promise<ChangeSet> {
    // The ids come from `snapshots.json`, which the agent can write: one like `--output=...` would
    // make git write a file as the user.
    checkTreeId(from, "the first snapshot");
    checkTreeId(to, "the second snapshot");
    const { stdout } = await git(
      [
        "diff",
        "--numstat",
        "--no-renames",
        "--no-textconv",
        "--no-ext-diff",
        "--relative",
        "-z",
        "--end-of-options",
        from,
        to,
      ],
      this.root,
    );
    const changes: ChangeSet = {};
    for (const entry of stdout.split("\0")) {
      if (!entry) continue;
      const [added, removed, ...rest] = entry.split("\t");
      const path = rest.join("\t");
      if (!path) continue;
      const lines = added === "-" || removed === "-" ? 1 : Number(added) + Number(removed);
      if (lines > 0) changes[path] = lines;
    }
    return changes;
  }

  /** What changed in the working tree since the snapshot `baseline`. */
  async changesSince(baseline: string): Promise<ChangeSet> {
    return this.changes(baseline, await this.snapshot());
  }
}
