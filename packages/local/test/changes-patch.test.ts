import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DeadlineError, deadlineIn, GitSnapshotter } from "../src/git";
import { patchBetween } from "../src/patch";

// git is slow to start on some systems, and these tests start it many times
setDefaultTimeout(60_000);

// Tests that need a POSIX shell, file modes or links skip on Windows: Node reports no exec bit there,
// a symlink needs a privilege, and a `#!/bin/sh` file is not a program. The hardening they stand for is
// in the code either way.
const posixTest = process.platform === "win32" ? test.skip : test;

// Test ids carry `t36tw` (TASK-36TW) and the number of the plan's decision where there is one.

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-patch-test-"));
  git("init", "-q");
  git("config", "core.autocrlf", "false"); // a Windows runner would check files out with CRLF
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (path: string, content: string, root = dir) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};
const lines = (n: number, prefix = "line") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i}\n`).join("");
const MAX = 10 * 1024 * 1024;
const text = (out: { patch: Buffer }) => out.patch.toString("utf8");

/** The tree the patch applied to `from` gives, as a tree id: the oracle for "the patch says it all". */
const applyToTree = (from: string, patch: string): string => {
  const scratch = join(dir, ".git", `oracle-${Math.random().toString(36).slice(2)}`);
  const env = { ...process.env, GIT_INDEX_FILE: scratch };
  execFileSync("git", ["read-tree", from], { cwd: dir, env });
  execFileSync("git", ["-c", "core.autocrlf=false", "apply", "--cached", "-"], {
    cwd: dir,
    env,
    input: patch,
  });
  const tree = execFileSync("git", ["write-tree"], { cwd: dir, env, encoding: "utf8" }).trim();
  return tree;
};

describe("a patch between two snapshots", () => {
  test("t36tw_patch_is_the_diff_of_the_two_trees", async () => {
    await write("a.txt", lines(3));
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const s = new GitSnapshotter(dir);
    const before = await s.snapshot();
    await write("a.txt", `${lines(3)}added\n`);
    await write("src/new.ts", "export const x = 1;\n");
    const after = await s.snapshot();
    const out = await patchBetween(s.root, before, after, { maxBytes: MAX });
    expect(out.cut).toBe(false);
    const body = text(out);
    expect(body).toContain("diff --git a/a.txt b/a.txt");
    expect(body).toContain("+added");
    expect(body).toContain("diff --git a/src/new.ts b/src/new.ts");
    // The oracle: the patch applied to the first tree gives the second.
    expect(applyToTree(before, body)).toBe(after);
  });

  test("t36tw_patch_of_equal_trees_is_empty", async () => {
    await write("a.txt", lines(2));
    const s = new GitSnapshotter(dir);
    const tree = await s.snapshot();
    expect(text(await patchBetween(s.root, tree, tree, { maxBytes: MAX }))).toBe("");
  });

  test("t36tw_corner_deleted_renamed_mode_symlink_and_odd_names", async () => {
    await write("gone.txt", lines(2));
    await write("old name.txt", lines(4));
    await write("run.sh", "echo hi\n");
    await write("plain.txt", "p\n");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const s = new GitSnapshotter(dir);
    const before = await s.snapshot();
    await rm(join(dir, "gone.txt"));
    await rm(join(dir, "old name.txt"));
    await write("new 'quoted' name.txt", lines(4));
    await write("ünï.txt", "u\n");
    // The mode and the link are skipped on Windows: Node reports no exec bit there and a symlink
    // needs a privilege.
    const modes = process.platform !== "win32";
    if (modes) {
      await chmod(join(dir, "run.sh"), 0o755);
      await symlink("plain.txt", join(dir, "link"));
    }
    const after = await s.snapshot();
    const body = text(await patchBetween(s.root, before, after, { maxBytes: MAX }));
    expect(body).toContain("deleted file mode");
    if (modes) {
      expect(body).toContain("old mode 100644");
      expect(body).toContain("new mode 100755");
      expect(body).toContain("new file mode 120000");
    }
    expect(applyToTree(before, body)).toBe(after);
  });

  test("t36tw_d1_binary_file_is_marked_not_embedded", async () => {
    await write("a.txt", "a\n");
    const s = new GitSnapshotter(dir);
    const before = await s.snapshot();
    await writeFile(join(dir, "pic.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 254]));
    await write("a.txt", "a\nb\n");
    const after = await s.snapshot();
    const body = text(await patchBetween(s.root, before, after, { maxBytes: MAX }));
    expect(body).toContain("Binary files /dev/null and b/pic.bin differ");
    expect(body).not.toContain("GIT binary patch");
    expect(body).toContain("+b"); // a positive control: the text file in the same patch is there
  });

  test("t36tw_project_below_repo_root", async () => {
    await write("outside.txt", "o\n");
    await write("app/inside.txt", "i\n");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const project = join(dir, "app");
    const s = new GitSnapshotter(project);
    const before = await s.snapshot();
    await write("app/inside.txt", "i\nchanged\n");
    await write("app/sub/new.txt", "n\n");
    await write("outside.txt", "o\nchanged\n");
    const after = await s.snapshot();
    const body = text(await patchBetween(s.root, before, after, { maxBytes: MAX }));
    // Paths are relative to the project folder, and nothing outside it is in the patch.
    expect(body).toContain("diff --git a/inside.txt b/inside.txt");
    expect(body).toContain("diff --git a/sub/new.txt b/sub/new.txt");
    expect(body).not.toContain("outside.txt");
  });

  test("t36tw_worktree_off_relative_objects_path: the ordinary checkout has a relative objects path", async () => {
    await write("a.txt", "a\n");
    const s = new GitSnapshotter(dir);
    const before = await s.snapshot();
    await write("a.txt", "a\nb\n");
    // From a subdirectory git prints `../.git/objects`; both ways must work.
    await mkdir(join(dir, "deep", "er"), { recursive: true });
    const deep = new GitSnapshotter(join(dir, "deep", "er"));
    const after = await s.snapshot();
    expect(text(await patchBetween(s.root, before, after, { maxBytes: MAX }))).toContain("+b");
    await write("deep/er/x.txt", "x\n");
    const deepBefore = await deep.snapshot();
    await write("deep/er/x.txt", "x\ny\n");
    const deepAfter = await deep.snapshot();
    expect(text(await patchBetween(deep.root, deepBefore, deepAfter, { maxBytes: MAX }))).toContain(
      "+y",
    );
  });

  test("t36tw_linked_worktree_objects", async () => {
    await write("a.txt", "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const linked = `${dir}-linked`;
    git("worktree", "add", "-q", linked, "-b", "side");
    try {
      const s = new GitSnapshotter(linked);
      const before = await s.snapshot();
      await write("a.txt", "a\nlinked\n", linked);
      const after = await s.snapshot();
      expect(text(await patchBetween(s.root, before, after, { maxBytes: MAX }))).toContain(
        "+linked",
      );
    } finally {
      await rm(linked, { recursive: true, force: true });
    }
  });
});

describe("history.changes.exclude", () => {
  const setup = async () => {
    await write("keep.txt", "k\n");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const s = new GitSnapshotter(dir);
    return { s, before: await s.snapshot() };
  };

  test("t36tw_exclude_dotfile_nested_and_globstar", async () => {
    const { s, before } = await setup();
    await write("keep.txt", "k\nchanged\n");
    await write(".env", "SECRET_VALUE=1\n");
    await write("deep/dir/app.lock", "lock\n");
    await write("deep/dir/src.ts", "ts\n");
    const after = await s.snapshot();
    const out = await patchBetween(s.root, before, after, {
      maxBytes: MAX,
      exclude: [".env", "**/*.lock"],
    });
    const body = text(out);
    expect(body).toContain("+changed"); // the positive control: the rest is there
    expect(body).toContain("deep/dir/src.ts");
    expect(body).not.toContain(".env");
    expect(body).not.toContain("app.lock");
  });

  test("t36tw_exclude_renamed_and_deleted", async () => {
    await write("secret.cfg", "x\n");
    await write("other.cfg", "y\n");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const s = new GitSnapshotter(dir);
    const before = await s.snapshot();
    await rm(join(dir, "secret.cfg"));
    await write("renamed.cfg", "x\n");
    await write("other.cfg", "y\nz\n");
    const after = await s.snapshot();
    const body = text(
      await patchBetween(s.root, before, after, { maxBytes: MAX, exclude: ["secret.cfg"] }),
    );
    expect(body).not.toContain("secret.cfg");
    expect(body).toContain("renamed.cfg");
    expect(body).toContain("+z");
  });

  test("t36tw_exclude_below_repo_root_is_project_relative", async () => {
    await write("app/a.log", "l\n");
    await write("app/keep.txt", "k\n");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const s = new GitSnapshotter(join(dir, "app"));
    const before = await s.snapshot();
    await write("app/a.log", "l\nmore\n");
    await write("app/keep.txt", "k\nmore\n");
    const after = await s.snapshot();
    const body = text(
      await patchBetween(s.root, before, after, { maxBytes: MAX, exclude: ["*.log"] }),
    );
    expect(body).not.toContain("a.log");
    expect(body).toContain("keep.txt");
  });

  test("t36tw_exclude_everything_gives_an_empty_patch", async () => {
    const { s, before } = await setup();
    await write("keep.txt", "k\nchanged\n");
    const after = await s.snapshot();
    expect(
      text(await patchBetween(s.root, before, after, { maxBytes: MAX, exclude: ["**"] })),
    ).toBe("");
  });
});

describe("a patch is not influenced by what the agent wrote into the repository", () => {
  /** A repo whose tree has the same two states; the patch must come out as plain text every time. */
  const states = async () => {
    await write("a.ts", lines(3));
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const s = new GitSnapshotter(dir);
    const before = await s.snapshot();
    await write("a.ts", `${lines(3)}changed\n`);
    const after = await s.snapshot();
    return { s, before, after };
  };
  const isPlain = (body: string) => {
    expect(body).toContain("diff --git a/a.ts b/a.ts");
    expect(body).toContain("+changed");
    expect(body).not.toContain("Binary files");
  };

  test("t36tw_hardening_gitattributes_minus_diff", async () => {
    const { s, before, after } = await states();
    await write(".gitattributes", "* -diff\n");
    // The control: a plain git diff between the same trees is fooled.
    expect(git("diff", "--no-ext-diff", before, after)).toContain("Binary files");
    isPlain(text(await patchBetween(s.root, before, after, { maxBytes: MAX })));
  });

  test("t36tw_hardening_info_attributes_and_diff_driver_binary", async () => {
    const { s, before, after } = await states();
    await write(".git/info/attributes", "*.ts diff=mine\n");
    git("config", "diff.mine.binary", "true");
    expect(git("diff", "--no-ext-diff", before, after)).toContain("Binary files");
    isPlain(text(await patchBetween(s.root, before, after, { maxBytes: MAX })));
  });

  test("t36tw_hardening_core_bigfilethreshold", async () => {
    const { s, before, after } = await states();
    git("config", "core.bigFileThreshold", "1");
    expect(git("diff", "--no-ext-diff", before, after)).toContain("Binary files");
    isPlain(text(await patchBetween(s.root, before, after, { maxBytes: MAX })));
  });

  test("t36tw_hardening_diff_config_keys", async () => {
    const { s, before, after } = await states();
    for (const [key, value] of [
      ["diff.noprefix", "true"],
      ["diff.mnemonicPrefix", "true"],
      ["diff.renames", "copies"],
      ["diff.algorithm", "patience"],
      ["diff.context", "0"],
      ["diff.orderFile", "/nonexistent"],
      ["diff.indentHeuristic", "false"],
      ["core.quotepath", "false"],
      ["diff.relative", "true"],
    ] as const) {
      git("config", key, value);
    }
    const body = text(await patchBetween(s.root, before, after, { maxBytes: MAX }));
    isPlain(body);
    expect(body).toContain(" line 2\n"); // three lines of context, whatever diff.context says
  });

  posixTest("t36tw_hardening_textconv_and_external_diff_never_run", async () => {
    const { s, before, after } = await states();
    const marker = join(dir, "payload-ran");
    const script = join(dir, "payload.sh");
    await writeFile(script, `#!/bin/sh\necho ran > "${marker}"\ncat "$1"\n`);
    await chmod(script, 0o755);
    await write(".gitattributes", "*.ts diff=evil\n");
    git("config", "diff.evil.textconv", script);
    git("config", "diff.external", script);
    // The control: the payload does fire in a git call that takes the configuration.
    git("diff", "--ext-diff", before, after);
    expect(existsSync(marker)).toBe(true);
    await rm(marker);
    isPlain(text(await patchBetween(s.root, before, after, { maxBytes: MAX })));
    expect(existsSync(marker)).toBe(false);
  });

  posixTest("t36tw_hardening_fsmonitor_and_hooks_never_run", async () => {
    const { s, before, after } = await states();
    const marker = join(dir, "payload-ran");
    const script = join(dir, "payload.sh");
    await writeFile(script, `#!/bin/sh\necho ran >> "${marker}"\n`);
    await chmod(script, 0o755);
    git("config", "core.fsmonitor", script);
    await writeFile(
      join(dir, ".git", "hooks", "post-index-change"),
      `#!/bin/sh\necho hook >> "${marker}"\n`,
    );
    await chmod(join(dir, ".git", "hooks", "post-index-change"), 0o755);
    // The control: ordinary git calls in the repository run the payload.
    git("status");
    git("add", "-A");
    expect(existsSync(marker)).toBe(true);
    await rm(marker);
    isPlain(text(await patchBetween(s.root, before, after, { maxBytes: MAX })));
    expect(existsSync(marker)).toBe(false);
  });

  test("t36tw_hardening_environment_git_variables_are_dropped", async () => {
    const { s, before, after } = await states();
    const other = await mkdtemp(join(tmpdir(), "kodel-other-"));
    const saved = { ...process.env };
    try {
      await write(".gitattributes", "* -diff\n");
      process.env.GIT_WORK_TREE = dir;
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "diff.noprefix";
      process.env.GIT_CONFIG_VALUE_0 = "true";
      process.env.GIT_CONFIG_PARAMETERS = "'diff.noprefix=true'";
      process.env.GIT_INDEX_FILE = join(other, "index");
      process.env.GIT_DIFF_OPTS = "--unified=0";
      isPlain(text(await patchBetween(s.root, before, after, { maxBytes: MAX })));
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      await rm(other, { recursive: true, force: true });
    }
  });

  test("t36tw_hardening_init_template_is_not_copied_in", async () => {
    const { s, before, after } = await states();
    const template = await mkdtemp(join(tmpdir(), "kodel-template-"));
    const saved = { ...process.env };
    try {
      await mkdir(join(template, "info"), { recursive: true });
      await writeFile(join(template, "info", "attributes"), "* -diff\n");
      // The control: a repository made with that template is fooled.
      const probe = await mkdtemp(join(tmpdir(), "kodel-probe-"));
      try {
        gitIn(probe, "init", "-q", "--bare", `--template=${template}`, join(probe, "r"));
        expect(await readFile(join(probe, "r", "info", "attributes"), "utf8")).toContain("-diff");
      } finally {
        await rm(probe, { recursive: true, force: true });
      }
      process.env.GIT_TEMPLATE_DIR = template;
      isPlain(text(await patchBetween(s.root, before, after, { maxBytes: MAX })));
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      await rm(template, { recursive: true, force: true });
    }
  });

  test("t36tw_hardening_private_dir_is_removed", async () => {
    const { s, before, after } = await states();
    const listing = () =>
      readdirSync(tmpdir()).filter(
        (n) => n.startsWith("kodel-patch-") && !n.startsWith("kodel-patch-test-"),
      );
    const was = listing();
    await patchBetween(s.root, before, after, { maxBytes: MAX });
    await expect(patchBetween(s.root, before, "0".repeat(40), { maxBytes: MAX })).rejects.toThrow();
    expect(listing()).toEqual(was);
  });

  test("t36tw_hardening_tree_id_option_injection", async () => {
    const { s, before, after } = await states();
    const target = join(dir, "written-by-git");
    // The control: a plain git diff given such an id writes the file.
    try {
      git("diff", `--output=${target}`, before, after);
    } catch {
      // whatever git does with it, the file below is what counts
    }
    expect(existsSync(target)).toBe(true);
    await rm(target);
    await expect(
      patchBetween(s.root, `--output=${target}`, after, { maxBytes: MAX }),
    ).rejects.toThrow("not a git object id");
    await expect(
      patchBetween(s.root, before, `--output=${target}`, { maxBytes: MAX }),
    ).rejects.toThrow("not a git object id");
    await expect(s.changes(`--output=${target}`, after)).rejects.toThrow("not a git object id");
    await expect(s.changes(before, "-p")).rejects.toThrow("not a git object id");
    expect(existsSync(target)).toBe(false);
  });
});

describe("limits of the work git does", () => {
  test("t36tw_large_input_cap_stops_git_and_says_so", async () => {
    await write("big.txt", "start\n");
    const s = new GitSnapshotter(dir);
    const before = await s.snapshot();
    await write("big.txt", lines(200_000, "a rather long line of generated text"));
    const after = await s.snapshot();
    const out = await patchBetween(s.root, before, after, { maxBytes: 4096 });
    expect(out.cut).toBe(true);
    expect(out.patch.length).toBeLessThanOrEqual(4096);
    expect(text(out)).toContain("diff --git a/big.txt b/big.txt");
  });

  test("t36tw_deadline_stops_a_snapshot_that_ran_out_of_time", async () => {
    await write("a.txt", "a\n");
    const s = new GitSnapshotter(dir);
    await expect(s.snapshot({ remainingMs: () => 0 })).rejects.toBeInstanceOf(DeadlineError);
    // And a deadline with time left does not get in the way.
    expect(await s.snapshot(deadlineIn(60_000))).toMatch(/^[0-9a-f]{40,64}$/);
  });

  posixTest("t36tw_deadline_kills_a_hung_git", async () => {
    await write("a.txt", "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const s = new GitSnapshotter(dir);
    const tree = await s.snapshot();
    // A git program that never returns, found first on the path.
    const bin = await mkdtemp(join(tmpdir(), "kodel-fakegit-"));
    const saved = process.env.PATH;
    try {
      // `exec`: the kill must reach the program that holds the pipes, not a shell around it.
      await writeFile(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
      await chmod(join(bin, "git"), 0o755);
      process.env.PATH = `${bin}:${saved}`;
      const started = Date.now();
      let left = 400;
      const deadline = { remainingMs: () => left };
      const failed = patchBetween(s.root, tree, tree, { maxBytes: MAX, deadline });
      await expect(failed).rejects.toBeInstanceOf(DeadlineError);
      left = 0;
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      process.env.PATH = saved;
      await rm(bin, { recursive: true, force: true });
    }
  });
});
