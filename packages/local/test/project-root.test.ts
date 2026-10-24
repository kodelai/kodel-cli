import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { findProjectRoot, NO_PROJECT_MESSAGE } from "../src";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

const temp = async (): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-root-")));
  cleanup.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });

const initRepo = async (dir: string) => {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
};

const mark = async (dir: string) => {
  await mkdir(join(dir, ".kodel"), { recursive: true });
  await writeFile(join(dir, ".kodel", "config.yaml"), "");
};

const commitAll = (dir: string) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "x");
};

/** A repository with a committed marker, a subfolder, and a linked worktree of it. */
async function repoWithWorktree() {
  const base = await temp();
  const main = join(base, "main");
  await initRepo(main);
  await mark(main);
  await mkdir(join(main, "src", "deep"), { recursive: true });
  await writeFile(join(main, "src", "deep", "a.txt"), "a");
  commitAll(main);
  const linked = join(base, "linked");
  git(main, "worktree", "add", "-q", "-b", "side", linked);
  return { base, main, linked: await realpath(linked) };
}

describe("tXJPC_find_project_root", () => {
  test("the nearest marker above is the root, from the root, a subfolder and a deeper one", async () => {
    const { main } = await repoWithWorktree();
    for (const cwd of [main, join(main, "src"), join(main, "src", "deep")]) {
      const found = await findProjectRoot(cwd, { home: "/nonexistent" });
      expect(found.root).toBe(main);
      expect(found.dataDir).toBe(join(main, ".kodel"));
      expect(found.via).toBe("marker");
      expect(found.climbed).toBeUndefined();
    }
  });

  test("a linked worktree maps to the same place in the main checkout", async () => {
    const { main, linked } = await repoWithWorktree();
    for (const [cwd, root] of [
      [linked, main],
      [join(linked, "src", "deep"), main],
    ] as const) {
      const found = await findProjectRoot(cwd, { home: "/nonexistent" });
      expect(found.root).toBe(root);
      expect(found.via).toBe("worktree");
      expect(found.worktreeOf).toBe(main);
    }
  });

  test("without git the walk goes up to the marker and says it climbed", async () => {
    const base = await temp();
    await mark(base);
    await mkdir(join(base, "a", "b"), { recursive: true });
    const found = await findProjectRoot(join(base, "a", "b"), { home: "/nonexistent" });
    expect(found.root).toBe(base);
    expect(found.climbed).toBe(true);
    const here = await findProjectRoot(base, { home: "/nonexistent" });
    expect(here.climbed).toBeUndefined();
  });

  test("no marker anywhere is NO_PROJECT with the text that says what to do", async () => {
    const base = await temp();
    await initRepo(join(base, "r"));
    for (const cwd of [base, join(base, "r")]) {
      const error = await findProjectRoot(cwd, { home: "/nonexistent" }).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("NO_PROJECT");
      expect((error as Error).message).toBe(NO_PROJECT_MESSAGE);
      expect((error as Error).message).toContain("kodel init");
    }
  });

  test("a .kodel with only pipelines is not a project", async () => {
    const base = await temp();
    await mkdir(join(base, ".kodel", "pipelines"), { recursive: true });
    await writeFile(join(base, ".kodel", "pipelines", "p.yaml"), "name: p\n");
    await expect(findProjectRoot(base, { home: "/nonexistent" })).rejects.toThrow(
      "no Kodel project",
    );
  });

  test("an explicit root and KODEL_ROOT win over everything, --root first, with no remap", async () => {
    const { main, linked, base } = await repoWithWorktree();
    const other = join(base, "elsewhere");
    expect(await findProjectRoot(main, { explicit: other })).toMatchObject({
      root: other,
      via: "explicit",
    });
    expect(await findProjectRoot(main, { env: { KODEL_ROOT: other } })).toMatchObject({
      root: other,
    });
    expect(
      await findProjectRoot(main, { explicit: linked, env: { KODEL_ROOT: other } }),
    ).toMatchObject({ root: linked, dataDir: join(linked, ".kodel"), via: "explicit" });
    const bare = await temp();
    expect((await findProjectRoot(bare, { explicit: bare })).root).toBe(bare);
  });

  test("a symbolic link to the project gives the real path", async () => {
    const { main, base } = await repoWithWorktree();
    const link = join(base, "link");
    await symlink(main, link);
    const found = await findProjectRoot(join(link, "src"), { home: "/nonexistent" });
    expect(found.root).toBe(main);
  });

  test("a .git file that points elsewhere is trusted no further than git reports", async () => {
    const base = await temp();
    const other = join(base, "other");
    await initRepo(other);
    const dir = join(base, "proj");
    await mark(dir);
    // Points at a folder that is no repository: git fails, the project is found in place.
    await writeFile(join(dir, ".git"), "gitdir: /nonexistent/place\n");
    expect((await findProjectRoot(dir, { home: "/nonexistent" })).root).toBe(dir);
    // Points at another repository's git folder: that is no linked worktree, so nothing is mapped.
    await writeFile(join(dir, ".git"), `gitdir: ${join(other, ".git")}\n`);
    const found = await findProjectRoot(dir, { home: "/nonexistent" });
    expect(found.root).toBe(dir);
    expect(found.via).toBe("marker");
  });

  test("the .kodel of the home folder is not a project", async () => {
    const home = await temp();
    await mark(home);
    await mkdir(join(home, "work", "x"), { recursive: true });
    await expect(findProjectRoot(join(home, "work", "x"), { home })).rejects.toThrow(
      "no Kodel project",
    );
    const own = join(home, "work");
    await mark(own);
    expect((await findProjectRoot(join(own, "x"), { home })).root).toBe(own);
  });

  test("a monorepo: the nearest marker wins, from the checkout and from a worktree", async () => {
    const base = await temp();
    const main = join(base, "main");
    await initRepo(main);
    await mark(main);
    await mark(join(main, "packages", "a"));
    await mkdir(join(main, "packages", "b", "src"), { recursive: true });
    await writeFile(join(main, "packages", "b", "src", "f.txt"), "f");
    await writeFile(join(main, "packages", "a", "f.txt"), "f");
    commitAll(main);
    const linked = join(base, "linked");
    git(main, "worktree", "add", "-q", "-b", "side", linked);
    const home = { home: "/nonexistent" };
    expect((await findProjectRoot(join(main, "packages", "a"), home)).root).toBe(
      join(main, "packages", "a"),
    );
    expect((await findProjectRoot(join(main, "packages", "b", "src"), home)).root).toBe(main);
    const fromWorktree = await findProjectRoot(join(await realpath(linked), "packages", "a"), home);
    expect(fromWorktree).toMatchObject({
      root: join(main, "packages", "a"),
      dataDir: join(main, "packages", "a", ".kodel"),
      via: "worktree",
    });
    expect(
      (await findProjectRoot(join(await realpath(linked), "packages", "b", "src"), home)).root,
    ).toBe(main);
    // --root picks another one.
    expect((await findProjectRoot(main, { explicit: join(main, "packages", "a") })).root).toBe(
      join(main, "packages", "a"),
    );
  });

  test("the nearest repository is the boundary: a nested repository does not use the marker above", async () => {
    const base = await temp();
    const outer = join(base, "outer");
    await initRepo(outer);
    await mark(outer);
    const nested = join(outer, "vendor", "lib");
    await initRepo(nested);
    await mkdir(join(nested, "src"), { recursive: true });
    const home = { home: "/nonexistent" };
    await expect(findProjectRoot(join(nested, "src"), home)).rejects.toThrow("no Kodel project");
    await mark(nested);
    expect((await findProjectRoot(join(nested, "src"), home)).root).toBe(nested);
  });

  test("a submodule is not mapped like a linked worktree", async () => {
    const base = await temp();
    const lib = join(base, "lib");
    await initRepo(lib);
    await mark(lib);
    commitAll(lib);
    const outer = join(base, "outer");
    await initRepo(outer);
    await mark(outer);
    commitAll(outer);
    execFileSync(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib"],
      {
        cwd: outer,
        stdio: "ignore",
      },
    );
    const found = await findProjectRoot(join(outer, "lib"), { home: "/nonexistent" });
    expect(found.root).toBe(join(outer, "lib"));
    expect(found.via).toBe("marker");
  });
  test("git missing from PATH: the walk still finds the marker, in place, with no crash", async () => {
    const { main, linked } = await repoWithWorktree();
    const empty = await temp();
    const saved = process.env.PATH;
    process.env.PATH = empty;
    try {
      const found = await findProjectRoot(join(linked, "src"), { home: "/nonexistent" });
      // No git, so no mapping to the main checkout: the worktree's own marker is used.
      expect(found.root).toBe(linked);
      expect(found.via).toBe("marker");
      expect(found.climbed).toBe(true);
      expect((await findProjectRoot(main, { home: "/nonexistent" })).root).toBe(main);
    } finally {
      process.env.PATH = saved;
    }
  });

  test("a common dir that is not a folder named .git (a bare repository) is not mapped", async () => {
    const base = await temp();
    const source = join(base, "source");
    await initRepo(source);
    await mark(source);
    commitAll(source);
    const bare = join(base, "store.git");
    git(base, "clone", "-q", "--bare", source, bare);
    const wt = join(base, "wt");
    git(bare, "worktree", "add", "-q", "-b", "side", wt);
    const found = await findProjectRoot(await realpath(wt), { home: "/nonexistent" });
    expect(found.root).toBe(await realpath(wt));
    expect(found.via).toBe("marker");
    expect(found.worktreeOf).toBeUndefined();
  });

  test("a linked worktree whose place in the main checkout has no marker works in place", async () => {
    const { main, linked } = await repoWithWorktree();
    await rm(join(main, ".kodel"), { recursive: true });
    const found = await findProjectRoot(join(linked, "src"), { home: "/nonexistent" });
    expect(found.root).toBe(linked);
    expect(found.via).toBe("marker");
    expect(found.worktreeOf).toBeUndefined();
  });

  test("--root to another package wins while the cwd is in a worktree, with no remap", async () => {
    const base = await temp();
    const main = join(base, "main");
    await initRepo(main);
    await mark(main);
    await mark(join(main, "packages", "a"));
    await mark(join(main, "packages", "b"));
    commitAll(main);
    const linked = await realpath(
      await (async () => {
        const path = join(base, "linked");
        git(main, "worktree", "add", "-q", "-b", "side", path);
        return path;
      })(),
    );
    const b = join(main, "packages", "b");
    const found = await findProjectRoot(join(linked, "packages", "a"), { explicit: b });
    expect(found).toMatchObject({ root: b, dataDir: join(b, ".kodel"), via: "explicit" });
    const inLinked = join(linked, "packages", "b");
    expect((await findProjectRoot(main, { explicit: inLinked })).root).toBe(inLinked);
  });

  test("a copy of a project made without git is a project of its own", async () => {
    const { main, base } = await repoWithWorktree();
    const copy = join(base, "copy");
    await cp(main, copy, { recursive: true, filter: (path) => !path.endsWith(`${sep}.git`) });
    for (const cwd of [copy, join(copy, "src", "deep")]) {
      const found = await findProjectRoot(cwd, { home: "/nonexistent" });
      expect(found.root).toBe(copy);
      expect(found.worktreeOf).toBeUndefined();
    }
  });

  test("a symbolic link as the marker is not a marker", async () => {
    const base = await temp();
    const real = join(base, "real.yaml");
    await writeFile(real, "");
    const a = join(base, "a");
    await mkdir(join(a, ".kodel"), { recursive: true });
    await symlink(real, join(a, ".kodel", "config.yaml"));
    await expect(findProjectRoot(a, { home: "/nonexistent" })).rejects.toThrow("no Kodel project");
    const b = join(base, "b");
    const store = join(base, "store");
    await mark(store);
    await mkdir(b, { recursive: true });
    await symlink(join(store, ".kodel"), join(b, ".kodel"));
    await expect(findProjectRoot(b, { home: "/nonexistent" })).rejects.toThrow("no Kodel project");
  });

  test("a folder whose name starts with two dots is inside the repository, not outside it", async () => {
    const { main } = await repoWithWorktree();
    const odd = join(main, "..odd", "x");
    await mkdir(odd, { recursive: true });
    const found = await findProjectRoot(odd, { home: "/nonexistent" });
    expect(found.root).toBe(main);
    // The repository bounds the walk, so it did not climb past a git boundary.
    expect(found.climbed).toBeUndefined();
  });
});
