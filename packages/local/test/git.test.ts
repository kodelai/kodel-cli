import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitSnapshotter } from "../src";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-git-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (path: string, content: string) => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
};
const lines = (n: number, prefix = "line") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i}\n`).join("");
const commitAll = () => {
  git("add", "-A");
  git("commit", "-q", "-m", "x");
};

describe("snapshots", () => {
  test("a snapshot is a tree id, and an unchanged tree gives the same one", async () => {
    await write("a.txt", lines(3));
    const s = new GitSnapshotter(dir);
    const first = await s.snapshot();
    expect(first).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await s.snapshot()).toBe(first);
  });

  test("works in a repository with no commits at all", async () => {
    const s = new GitSnapshotter(dir);
    const empty = await s.snapshot();
    await write("new.txt", lines(4));
    expect(await s.changesSince(empty)).toEqual({ "new.txt": 4 });
  });

  test("a directory that is not a repository is reported clearly", async () => {
    const plain = await mkdtemp(join(tmpdir(), "kodel-plain-"));
    try {
      const s = new GitSnapshotter(plain);
      expect(await s.isRepo()).toBe(false);
      await expect(s.snapshot()).rejects.toThrow("needs a git repository");
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe("changes since a snapshot", () => {
  test("an untracked file counts all its lines", async () => {
    await write("keep.txt", "x\n");
    commitAll();
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    await write("src/new.ts", lines(5));
    expect(await s.changesSince(base)).toEqual({ "src/new.ts": 5 });
  });

  test("a modified file counts added plus removed lines", async () => {
    await write("a.txt", lines(10));
    commitAll();
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    await write(
      "a.txt",
      lines(10).replace("line 3\n", "changed 3\n").replace("line 4\n", "changed 4\n"),
    );
    expect(await s.changesSince(base)).toEqual({ "a.txt": 4 });
  });

  test("a deleted file counts its lines", async () => {
    await write("gone.txt", lines(7));
    commitAll();
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    await rm(join(dir, "gone.txt"));
    expect(await s.changesSince(base)).toEqual({ "gone.txt": 7 });
  });

  test("a renamed file is a deletion plus an addition", async () => {
    await write("old.txt", lines(10));
    commitAll();
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    await rename(join(dir, "old.txt"), join(dir, "new.txt"));
    expect(await s.changesSince(base)).toEqual({ "old.txt": 10, "new.txt": 10 });
  });

  test("nothing changed means no entries", async () => {
    await write("a.txt", lines(3));
    commitAll();
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    expect(await s.changesSince(base)).toEqual({});
  });

  test("a file created and then removed leaves no trace", async () => {
    await write("keep.txt", "x\n");
    commitAll();
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    await write("temp.txt", lines(9));
    await rm(join(dir, "temp.txt"));
    expect(await s.changesSince(base)).toEqual({});
  });

  test("uncommitted work before the baseline is part of the baseline, not a change", async () => {
    await write("a.txt", lines(3));
    commitAll();
    await write("a.txt", lines(8)); // uncommitted edit
    await write("b.txt", lines(2)); // uncommitted new file
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    expect(await s.changesSince(base)).toEqual({});
    await write("b.txt", lines(5));
    expect(await s.changesSince(base)).toEqual({ "b.txt": 3 });
  });

  test("staged and unstaged changes are counted once", async () => {
    await write("a.txt", lines(4));
    commitAll();
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    await write("a.txt", lines(6));
    git("add", "a.txt");
    expect(await s.changesSince(base)).toEqual({ "a.txt": 2 });
  });

  test("ignored files and the .kodel directory are not part of a snapshot", async () => {
    await write(".gitignore", "build/\n*.log\n");
    commitAll();
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    await write("build/out.js", lines(50));
    await write("debug.log", lines(50));
    await write(".kodel/runs/r1/state.json", lines(50));
    expect(await s.changesSince(base)).toEqual({});
  });

  test("a binary file counts as one line", async () => {
    await write("keep.txt", "x\n");
    commitAll();
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    await writeFile(join(dir, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
    expect(await s.changesSince(base)).toEqual({ "image.bin": 1 });
  });

  test("paths with spaces and non-ASCII letters are reported as they are", async () => {
    await write("keep.txt", "x\n");
    commitAll();
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    await write("my docs/план.md", lines(3));
    expect(await s.changesSince(base)).toEqual({ "my docs/план.md": 3 });
  });

  test("two snapshots compare with each other, not only with the present", async () => {
    await write("a.txt", lines(2));
    commitAll();
    const s = new GitSnapshotter(dir);
    const first = await s.snapshot();
    await write("a.txt", lines(5));
    const second = await s.snapshot();
    await write("a.txt", lines(9));
    expect(await s.changes(first, second)).toEqual({ "a.txt": 3 });
    expect(await s.changes(second, first)).toEqual({ "a.txt": 3 });
  });

  test("inside a subdirectory of the repository the paths are relative to it", async () => {
    await write("pkg/keep.txt", "x\n");
    await write("other/keep.txt", "x\n");
    commitAll();
    const s = new GitSnapshotter(join(dir, "pkg"));
    const base = await s.snapshot();
    await write("pkg/src/a.ts", lines(4));
    expect(await s.changesSince(base)).toEqual({ "src/a.ts": 4 });
  });
});

describe("the repository is left alone", () => {
  test("the index, the working tree and the branches are exactly as they were", async () => {
    await write("a.txt", lines(3));
    commitAll();
    await write("a.txt", lines(5));
    await write("untracked.txt", lines(2));
    git("add", "a.txt");
    const before = {
      status: git("status", "--porcelain"),
      head: git("rev-parse", "HEAD"),
      stash: git("stash", "list"),
    };
    const s = new GitSnapshotter(dir);
    await s.snapshot();
    await s.snapshot();
    expect({
      status: git("status", "--porcelain"),
      head: git("rev-parse", "HEAD"),
      stash: git("stash", "list"),
    }).toEqual(before);
    expect(await readdir(join(dir, ".git"))).not.toContain("index.lock");
  });

  test("a snapshot of a larger tree is quick", async () => {
    for (let i = 0; i < 150; i++) await write(`src/f${i}.ts`, lines(20, `f${i}`));
    commitAll();
    const s = new GitSnapshotter(dir);
    const started = Date.now();
    const base = await s.snapshot();
    await write("src/f7.ts", lines(25, "changed"));
    await s.changesSince(base);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("a repository cannot make a snapshot run its programs", () => {
  const marker = (name: string) => join(dir, `..`, `${name}-${process.pid}`);
  const ran = async (path: string) =>
    (await readdir(dirname(path))).includes(path.split("/").pop() ?? "");

  test("a clean filter named by .gitattributes and .git/config is never run", async () => {
    const mark = marker("filter-ran");
    git("config", "filter.evil.clean", `touch ${mark}; cat`);
    await write(".gitattributes", "* filter=evil\n");
    await write("a.txt", lines(2));
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    await write("a.txt", lines(5));
    expect(await s.changesSince(base)).toEqual({ "a.txt": 3 }); // the work still gets measured
    expect(await ran(mark)).toBe(false);
    await rm(mark, { force: true });
  });

  test("a text conversion for the diff is never run", async () => {
    const mark = marker("textconv-ran");
    git("config", "diff.evil.textconv", `touch ${mark}; cat`);
    await write(".gitattributes", "*.txt diff=evil\n");
    await write("a.txt", lines(2));
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    await write("a.txt", lines(4));
    expect(await s.changesSince(base)).toEqual({ "a.txt": 2 });
    expect(await ran(mark)).toBe(false);
    await rm(mark, { force: true });
  });

  test("an external diff program and a file system monitor are never run either", async () => {
    const mark = marker("external-ran");
    git("config", "diff.external", `touch ${mark}; true`);
    git("config", "core.fsmonitor", `touch ${mark}; true`);
    await write("a.txt", lines(2));
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    await write("a.txt", lines(3));
    await s.changesSince(base);
    expect(await ran(mark)).toBe(false);
    await rm(mark, { force: true });
  });
});

describe("what a snapshot sees", () => {
  test("files with names that are awkward to pass around: a newline, a quote, a space, a dash", async () => {
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    for (const name of ["new\nline.txt", '"quoted".txt', "with space.txt", "-dash.txt"]) {
      await write(name, "x\n");
    }
    expect(Object.keys(await s.changesSince(base)).sort()).toEqual(
      ['"quoted".txt', "-dash.txt", "new\nline.txt", "with space.txt"].sort(),
    );
  });

  test("a symbolic link counts as a file of its own, and a change of its target as a change", async () => {
    await write("target-a.txt", "a\n");
    await write("target-b.txt", "b\n");
    await symlink("target-a.txt", join(dir, "link"));
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    expect(await s.changesSince(base)).toEqual({});
    await rm(join(dir, "link"));
    await symlink("target-b.txt", join(dir, "link"));
    expect(await s.changesSince(base)).toEqual({ link: 2 });
  });

  test("making a file executable is a change of the tree, and a file deleted from disk is gone from it", async () => {
    await write("run.sh", "echo\n");
    await write("gone.txt", "bye\n");
    commitAll();
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    await chmod(join(dir, "run.sh"), 0o755);
    await rm(join(dir, "gone.txt"));
    expect(await s.snapshot()).not.toBe(base);
    expect(await s.changesSince(base)).toEqual({ "gone.txt": 1 });
  });

  test("ignored files are not in it, and neither is the directory that is left out", async () => {
    await write(".gitignore", "ignored.txt\n");
    await write("ignored.txt", "x\n");
    await write(".kodel/runs/state.json", "{}\n");
    const s = new GitSnapshotter(dir);
    const base = await s.snapshot();
    await write("ignored.txt", lines(9));
    await write(".kodel/runs/state.json", lines(9));
    expect(await s.changesSince(base)).toEqual({});
  });
});
