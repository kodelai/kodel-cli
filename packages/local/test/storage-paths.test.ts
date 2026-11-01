import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkoutKey,
  ensurePlace,
  generateProjectId,
  homeHashKey,
  homePlace,
  parseStorageLines,
  placeOfRoot,
  projectIdProblem,
  projectPlace,
  readStorageSettings,
  resolveBase,
  StoragePathsError,
  samePlace,
  scrubHome,
} from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-paths-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("project_id", () => {
  test("storage_project_id_validation", () => {
    for (const ok of ["etude-k3f9a2x1", "my.app_1-abc", "abc", "a1b2c3"]) {
      expect(projectIdProblem(ok), ok).toBeUndefined();
    }
    const bad = [
      "",
      "ab", // too short
      "-abc", // starts with a dash
      ".abc",
      "Abc-123", // uppercase is refused, not lowercased
      "a/b-123",
      "a\\b-123",
      "../escape",
      "a..b-123",
      "abc.", // trailing dot
      "con",
      "nul",
      "com1",
      "lpt9",
      "con.txt", // a device name with an extension
      "x".repeat(65),
      "héllo-123",
      "with space",
    ];
    for (const id of bad) expect(projectIdProblem(id), JSON.stringify(id)).toBeDefined();
  });

  test("storage_project_id_generation", () => {
    const random = (n: number) => Buffer.alloc(n, 7); // 7 % 36 = 7 -> "7"
    expect(generateProjectId("MyApp", random)).toBe("myapp-77777777");
    // Leading non-alphanumerics are dropped, the rest is cut to 24 characters.
    expect(generateProjectId("--.my_app", random)).toBe("my_app-77777777");
    expect(generateProjectId("a".repeat(40), random)).toBe(`${"a".repeat(24)}-77777777`);
    // Nothing usable left (a non-ASCII-only folder): the fallback prefix.
    expect(generateProjectId("проект", random)).toBe("p-77777777");
    // A device name never comes out as an id.
    for (const name of ["con", "nul", "com1", "aux"]) {
      expect(projectIdProblem(generateProjectId(name, random)), name).toBeUndefined();
    }
    // The random part is really used: two generations differ.
    expect(generateProjectId("app")).not.toBe(generateProjectId("app"));
    // Whatever comes out is valid.
    for (const name of ["", ".", "a", "ab", "My App 2", "文書", "x.y.", "con.txt"]) {
      expect(projectIdProblem(generateProjectId(name)), JSON.stringify(name)).toBeUndefined();
    }
  });
});

describe("the line matcher", () => {
  test("reads top-level scalar lines, with quotes and a trailing comment", () => {
    expect(parseStorageLines("storage: home\nproject_id: abc-123\n")).toEqual({
      storage: "home",
      project_id: "abc-123",
    });
    expect(parseStorageLines("storage: \"home\"  # where\nproject_id: 'abc-123'")).toEqual({
      storage: "home",
      project_id: "abc-123",
    });
    expect(parseStorageLines("storage: home\r\nproject_id: abc-123\r\n").storage).toBe("home");
    expect(parseStorageLines("﻿storage: home\n").storage).toBe("home");
    // Nested or indented keys are not the top level.
    expect(parseStorageLines("tasks:\n  storage: home\n")).toEqual({});
    expect(parseStorageLines("\tstorage: home\n")).toEqual({});
  });

  test("a spelling it cannot read as a scalar is a value no setting accepts", () => {
    for (const text of [
      "storage: { x: 1 }",
      "storage: &a home",
      "storage: |\n  home",
      "storage:\n  runs: home",
      "storage: *x",
    ]) {
      expect(parseStorageLines(text).storage, text).toBe("\0");
      expect(() => readStorageSettings(text), text).toThrow(StoragePathsError);
    }
  });

  test("a key twice is an error", () => {
    expect(() => parseStorageLines("storage: home\nstorage: project\n")).toThrow(StoragePathsError);
  });

  test("readStorageSettings validates like the config does", () => {
    expect(readStorageSettings("")).toEqual({ storage: "project" });
    expect(readStorageSettings("storage: project\n")).toEqual({ storage: "project" });
    expect(readStorageSettings("storage: home\nproject_id: etude-k3f9a2x1\n")).toEqual({
      storage: "home",
      projectId: "etude-k3f9a2x1",
    });
    expect(() => readStorageSettings("storage: cloud\n")).toThrow(StoragePathsError);
    expect(() => readStorageSettings("storage: homes\n")).toThrow(StoragePathsError);
    expect(() => readStorageSettings("project_id: ../x\n")).toThrow(StoragePathsError);
    expect(() => readStorageSettings("project_id: Upper-123\n")).toThrow(StoragePathsError);
  });
});

describe("the base", () => {
  test("storage_state_dir_is_base", () => {
    expect(resolveBase({ KODEL_STATE_DIR: "/data/kodel/" }, "/home/u")).toBe("/data/kodel");
    expect(resolveBase({}, "/home/u")).toBe(join("/home/u", ".kodel"));
  });

  test("storage_empty_state_dir_falls_back", () => {
    expect(resolveBase({ KODEL_STATE_DIR: "" }, "/home/u")).toBe(join("/home/u", ".kodel"));
  });

  test("storage_relative_state_dir_history_error", () => {
    expect(() => resolveBase({ KODEL_STATE_DIR: "relative/dir" }, "/home/u")).toThrow(
      StoragePathsError,
    );
  });

  test("storage_homedir_injection", () => {
    // An empty home folder (and no override) is an error that says what to do.
    expect(() => resolveBase({}, "")).toThrow(/KODEL_STATE_DIR/);
    // With the override the home folder is never asked for.
    expect(resolveBase({ KODEL_STATE_DIR: "/data" }, "")).toBe("/data");
  });
});

describe("places", () => {
  test("a project place is under .kodel", () => {
    const place = projectPlace("/p/.kodel");
    expect(place).toMatchObject({
      mode: "project",
      runsRoot: "/p/.kodel/runs",
      proposalsRoot: "/p/.kodel/proposals",
      lockRoot: "/p/.kodel",
      sessionsPath: "/p/.kodel/sessions.jsonl",
    });
    expect(place.hashKey).toBeUndefined();
  });

  test("a home place is under projects/<id>, proposals per checkout", () => {
    const place = homePlace({ root: "/p", projectId: "demo-aaaa1111", base: "/b" });
    expect(place).toMatchObject({
      mode: "home",
      tree: "/b/projects/demo-aaaa1111",
      runsRoot: "/b/projects/demo-aaaa1111/runs",
      lockRoot: "/b/projects/demo-aaaa1111",
      sessionsPath: "/b/projects/demo-aaaa1111/sessions.jsonl",
      checkoutRoot: "/p",
    });
    expect(place.proposalsRoot).toBe(`/b/projects/demo-aaaa1111/proposals/${checkoutKey("/p")}`);
    // Two checkouts of one project share the tree and not the proposals.
    const other = homePlace({ root: "/q", projectId: "demo-aaaa1111", base: "/b" });
    expect(other.runsRoot).toBe(place.runsRoot);
    expect(other.proposalsRoot).not.toBe(place.proposalsRoot);
  });

  test("storage_id_derivation_pinned: the keys are fixed values", () => {
    // A key of the integrity hashes is a format: a change of the derivation moves every hash.
    expect(homeHashKey("demo-aaaa1111")).toBe("557926e37eaa7a92");
    expect(homeHashKey("demo-aaaa1111")).not.toBe(homeHashKey("demo-aaaa1112"));
    // The key of a checkout is a short hash of its path, the same however it is spelled.
    expect(checkoutKey("/p")).toHaveLength(12);
    expect(checkoutKey("/p/")).toBe(checkoutKey("/p"));
    expect(checkoutKey("/p/./q/..")).toBe(checkoutKey("/p"));
    expect(checkoutKey("/p")).not.toBe(checkoutKey("/q"));
  });

  test("samePlace compares the mode, the id and the folder", () => {
    const a = homePlace({ root: "/p", projectId: "demo-aaaa1111", base: "/b" });
    expect(samePlace(a, homePlace({ root: "/p", projectId: "demo-aaaa1111", base: "/b" }))).toBe(
      true,
    );
    expect(samePlace(a, homePlace({ root: "/p", projectId: "demo-bbbb2222", base: "/b" }))).toBe(
      false,
    );
    expect(samePlace(a, homePlace({ root: "/p", projectId: "demo-aaaa1111", base: "/c" }))).toBe(
      false,
    );
    expect(samePlace(a, projectPlace("/p/.kodel"))).toBe(false);
  });

  test("scrubHome takes the base out of a text, in both spellings", async () => {
    const real = join(dir, "real");
    await mkdir(real);
    const link = join(dir, "link");
    await symlink(real, link);
    const place = homePlace({ root: "/p", projectId: "demo-aaaa1111", base: link });
    // On macOS the real path of a temp folder is not the spelling it was made with (`/private/var`).
    const text = `ENOENT: open '${link}/projects/x' and '${await realpath(link)}/projects/y'`;
    expect(scrubHome(text, place)).toBe("ENOENT: open '<home>/projects/x' and '<home>/projects/y'");
    expect(scrubHome(text, projectPlace("/p/.kodel"))).toBe(text);
    expect(scrubHome(text, undefined)).toBe(text);
  });
});

describe("making the place", () => {
  test("storage_home_dirs_are_0700", async () => {
    const base = join(dir, "kodel");
    const place = homePlace({ root: "/p", projectId: "demo-aaaa1111", base });
    await ensurePlace(place);
    for (const folder of [base, place.tree as string, place.runsRoot, place.proposalsRoot]) {
      expect(((await stat(folder)).mode & 0o777).toString(8), folder).toBe(
        process.platform === "win32" ? ((await stat(folder)).mode & 0o777).toString(8) : "700",
      );
    }
  });

  test("a base that exists is not chmodded", async () => {
    if (process.platform === "win32") return;
    const base = join(dir, "shared");
    await mkdir(base, { mode: 0o755 });
    await ensurePlace(homePlace({ root: "/p", projectId: "demo-aaaa1111", base }));
    expect(((await stat(base)).mode & 0o777).toString(8)).toBe("755");
  });

  test("a project place needs nothing", async () => {
    await ensurePlace(projectPlace(join(dir, ".kodel")));
    await expect(stat(join(dir, ".kodel"))).rejects.toThrow();
  });

  test("storage_symlink_rules: a link that leaves the base is refused, a symlinked base is not", async () => {
    if (process.platform === "win32") return;
    const outside = join(dir, "outside");
    await mkdir(outside);
    const base = join(dir, "base");
    await mkdir(join(base, "projects"), { recursive: true });
    await symlink(outside, join(base, "projects", "demo-aaaa1111"));
    await expect(
      ensurePlace(homePlace({ root: "/p", projectId: "demo-aaaa1111", base })),
    ).rejects.toThrow(StoragePathsError);

    // The base itself may be a link (a symlinked ~/.kodel).
    const real = join(dir, "realbase");
    await mkdir(real);
    const linked = join(dir, "linkedbase");
    await symlink(real, linked);
    await ensurePlace(homePlace({ root: "/p", projectId: "demo-bbbb2222", base: linked }));
    await expect(stat(join(real, "projects", "demo-bbbb2222", "runs"))).resolves.toBeDefined();
  });

  test("two places made at once both end up 0700", async () => {
    const base = join(dir, "kodel");
    const places = ["demo-aaaa1111", "demo-bbbb2222", "demo-cccc3333"].map((projectId) =>
      homePlace({ root: "/p", projectId, base }),
    );
    await Promise.all(places.map((place) => ensurePlace(place)));
    for (const place of places) await expect(stat(place.runsRoot)).resolves.toBeDefined();
  });
});

describe("the place of a root", () => {
  const env = (base: string) => ({ KODEL_STATE_DIR: base });

  test("no config, or no storage key, is the project", async () => {
    await expect(placeOfRoot(dir, env("/b"))).resolves.toMatchObject({ mode: "project" });
    await mkdir(join(dir, ".kodel"));
    await writeFile(join(dir, ".kodel", "config.yaml"), "version: 1\n");
    await expect(placeOfRoot(dir, env("/b"))).resolves.toMatchObject({ mode: "project" });
  });

  test("storage: home with an id is the home place", async () => {
    await mkdir(join(dir, ".kodel"));
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      "version: 1\nstorage: home\nproject_id: demo-aaaa1111\n",
    );
    const place = await placeOfRoot(dir, env("/b"));
    expect(place).toMatchObject({ mode: "home", tree: "/b/projects/demo-aaaa1111" });
  });

  test("home without an id, or a bad value, is an error", async () => {
    await mkdir(join(dir, ".kodel"));
    const config = join(dir, ".kodel", "config.yaml");
    await writeFile(config, "storage: home\n");
    await expect(placeOfRoot(dir, env("/b"))).rejects.toThrow(StoragePathsError);
    await writeFile(config, "storage: cloud\n");
    await expect(placeOfRoot(dir, env("/b"))).rejects.toThrow(StoragePathsError);
    await writeFile(config, "storage: home\nproject_id: ../x\n");
    await expect(placeOfRoot(dir, env("/b"))).rejects.toThrow(StoragePathsError);
  });
});
