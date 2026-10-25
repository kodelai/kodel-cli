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
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangeSet } from "@kodel-ai/pipeline-core";

interface GitResult {
  stdout: string;
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

/** Run git with the hardened configuration; the one place the local adapters start it. */
export function git(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  input?: string,
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
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).trim();
          reject(new Error(`git ${args[0]} failed: ${detail}`));
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
export async function readHead(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(["rev-parse", "--verify", "--quiet", "HEAD"], cwd, {
      GIT_OPTIONAL_LOCKS: "0",
    });
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
): Promise<RunCommits> {
  const head = await readHead(cwd);
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
    );
    for (const line of stdout.split("\n")) add(line.trim());
  } catch {
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
  } catch {
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
    private readonly root: string,
    options: SnapshotterOptions = {},
  ) {
    // Relative to `root`, which is the project folder: a package project excludes its own `.kodel`.
    this.exclude = options.exclude ?? [".kodel"];
  }

  async isRepo(): Promise<boolean> {
    try {
      const { stdout } = await git(["rev-parse", "--is-inside-work-tree"], this.root);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private excluded(path: string): boolean {
    return this.exclude.some((dir) => path === dir || path.startsWith(`${dir}/`));
  }

  /** The tree object of the working tree as it is now. */
  async snapshot(): Promise<string> {
    if (!(await this.isRepo())) {
      throw new Error(`the diff check needs a git repository, and ${this.root} is not inside one`);
    }
    // The listing is relative to the directory we are in; the index wants paths from the top of the
    // repository, so the way down to this directory goes in front of each.
    const { stdout: prefixOut } = await git(["rev-parse", "--show-prefix"], this.root);
    const prefix = prefixOut.trim();
    const { stdout: listed } = await git(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      this.root,
      { GIT_OPTIONAL_LOCKS: "0" },
    );
    const paths = [...new Set(listed.split("\0").filter(Boolean))].filter((p) => !this.excluded(p));

    const regular: { path: string; mode: string }[] = [];
    const entries: { mode: string; sha: string; path: string }[] = [];
    for (const path of paths) {
      const info = await lstat(join(this.root, path)).catch(() => undefined);
      if (!info) continue; // tracked, but deleted from the working tree
      if (info.isSymbolicLink()) {
        const target = await readlink(join(this.root, path));
        const { stdout } = await git(
          ["hash-object", "-w", "--no-filters", "--stdin"],
          this.root,
          {},
          target,
        );
        entries.push({ mode: "120000", sha: stdout.trim(), path: `${prefix}${path}` });
      } else if (info.isFile()) {
        regular.push({ path, mode: info.mode & 0o111 ? "100755" : "100644" });
      }
      // directories (a submodule, say) and special files are not part of a snapshot
    }

    const plain = regular.filter((f) => !awkwardPath(f.path));
    if (plain.length > 0) {
      const { stdout } = await git(
        ["hash-object", "-w", "--no-filters", "--stdin-paths"],
        this.root,
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
      const { stdout } = await git(
        ["hash-object", "-w", "--no-filters", "--", join(this.root, f.path)],
        this.root,
      );
      entries.push({ mode: f.mode, sha: stdout.trim(), path: `${prefix}${f.path}` });
    }

    const scratch = await mkdtemp(join(tmpdir(), "kodel-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(scratch, "index"), GIT_OPTIONAL_LOCKS: "0" };
      await git(
        ["update-index", "--add", "-z", "--index-info"],
        this.root,
        env,
        entries.map((e) => `${e.mode} ${e.sha}\t${e.path}\0`).join(""),
      );
      const { stdout: tree } = await git(["write-tree"], this.root, env);
      return tree.trim();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** Changed lines per path between two snapshots; a binary file counts as one line. */
  async changes(from: string, to: string): Promise<ChangeSet> {
    const { stdout } = await git(
      [
        "diff",
        "--numstat",
        "--no-renames",
        "--no-textconv",
        "--no-ext-diff",
        "--relative",
        "-z",
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
