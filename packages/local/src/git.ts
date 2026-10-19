/**
 * Working-tree snapshots for `diff` baselines.
 *
 * A snapshot is a git tree object built from the working tree (tracked and untracked files that
 * are not ignored, uncommitted changes included) through a private copy of the index. The user's
 * own index, working tree and branches are never touched; the only trace is a few unreferenced
 * objects that `git gc` removes. The changes between two snapshots are `git diff --numstat`
 * between the two trees: added plus removed lines per path.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ChangeSet } from "@kodel-ai/pipeline-core";

interface GitResult {
  stdout: string;
}

function git(args: string[], cwd: string, env: Record<string, string> = {}): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "git",
      args,
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
  });
}

export interface SnapshotterOptions {
  /** Directories that are never part of a snapshot (relative to the repository root). */
  exclude?: string[];
}

export class GitSnapshotter {
  private readonly exclude: string[];

  constructor(
    private readonly root: string,
    options: SnapshotterOptions = {},
  ) {
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

  /** The tree object of the working tree as it is now. */
  async snapshot(): Promise<string> {
    if (!(await this.isRepo())) {
      throw new Error(`the diff check needs a git repository, and ${this.root} is not inside one`);
    }
    const scratch = await mkdtemp(join(tmpdir(), "kodel-index-"));
    try {
      const index = join(scratch, "index");
      const { stdout } = await git(["rev-parse", "--git-path", "index"], this.root);
      const realIndex = isAbsolute(stdout.trim())
        ? stdout.trim()
        : resolve(this.root, stdout.trim());
      // Copying the index keeps its stat cache, so unchanged files are not hashed again.
      const hasIndex = await stat(realIndex).then(
        () => true,
        () => false,
      );
      if (hasIndex) await copyFile(realIndex, index);
      const env = { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" };
      const pathspec = [".", ...this.exclude.map((dir) => `:(exclude)${dir}`)];
      await git(["add", "-A", "--", ...pathspec], this.root, env);
      const { stdout: tree } = await git(["write-tree"], this.root, env);
      return tree.trim();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** Changed lines per path between two snapshots; a binary file counts as one line. */
  async changes(from: string, to: string): Promise<ChangeSet> {
    const { stdout } = await git(
      ["diff", "--numstat", "--no-renames", "--relative", "-z", from, to],
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
