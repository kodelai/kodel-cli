import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { realPath } from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-real-path-"));
  await mkdir(join(dir, "real", "inner"), { recursive: true });
  await writeFile(join(dir, "real", "file.txt"), "x");
  await writeFile(join(dir, "plain.txt"), "x");
  await symlink(join(dir, "real"), join(dir, "to-dir"));
  await symlink(join(dir, "real", "file.txt"), join(dir, "to-file"));
  await symlink(join(dir, "nowhere"), join(dir, "dangling"));
  await symlink(join(dir, "loop-b"), join(dir, "loop-a"));
  await symlink(join(dir, "loop-a"), join(dir, "loop-b"));
});
afterEach(async () => {
  await chmod(join(dir, "closed"), 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const codeOf = (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(
    () => "resolved",
    (error: NodeJS.ErrnoException) => error.code,
  );

describe("task_7bh9 the real path made with the sync call", () => {
  test("task_7bh9_real_path_matches_async_realpath", async () => {
    const shapes = [
      dir,
      join(dir, "to-dir"),
      join(dir, "to-file"),
      join(dir, "to-dir", "inner"),
      `${join(dir, "to-dir")}/`,
      `${dir}/./real/../to-dir/inner/..`,
      relative(process.cwd(), join(dir, "to-dir")),
      ".",
      "",
      ...(process.platform === "darwin"
        ? ["/private", "/tmp", "/var", join(dir, "REAL", "Inner"), join(dir, "TO-DIR")]
        : []),
    ];
    for (const shape of shapes) {
      const [sync, lost] = await Promise.all([codeOf(realPath(shape)), codeOf(realpath(shape))]);
      // the same outcome first (a shape one form refuses, the other refuses too), then the same path
      expect(sync, shape).toBe(lost as string);
      if (sync === "resolved") expect(await realPath(shape), shape).toBe(await realpath(shape));
    }
  });

  test("task_7bh9_real_path_rejects_with_the_same_code", async () => {
    const closed = join(dir, "closed");
    await mkdir(join(closed, "in"), { recursive: true });
    await chmod(closed, 0o000);
    const isRoot = process.getuid?.() === 0;
    const cases: [string, string | undefined][] = [
      [join(dir, "missing"), "ENOENT"],
      [join(dir, "plain.txt", "below"), "ENOTDIR"],
      [join(dir, "dangling"), "ENOENT"],
      [join(dir, "loop-a"), "ELOOP"],
      ...(isRoot || process.platform === "win32"
        ? []
        : ([[join(closed, "in"), "EACCES"]] as [string, string][])),
    ];
    for (const [path, code] of cases) {
      const sync = await codeOf(realPath(path));
      expect(sync, path).toBe(await codeOf(realpath(path)));
      expect(sync, path).toBe(code);
    }
    // a throw of the sync call is a rejection, never a throw of the call itself
    expect(() => realPath(join(dir, "missing")).catch(() => undefined)).not.toThrow();
  });
});

/** Where the name `realpath` is used as an identifier or a property name: comments and strings do not count. */
function realpathUses(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const named =
      (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && node.text === "realpath";
    // `fs["realpath"]` reaches the same call by a string
    const indexed =
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "realpath";
    if (named || indexed) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${file}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

async function sourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("task_7bh9 the async realpath stays out of the sources", () => {
  test("task_7bh9_scan_finds_every_form", () => {
    const forms = [
      'import { realpath } from "node:fs/promises";',
      'import { realpath as real } from "node:fs/promises";',
      'import * as fs from "node:fs/promises"; await fs.realpath("x");',
      'import fs from "node:fs"; await fs.promises.realpath("x");',
      'import fs from "node:fs"; fs.realpath("x", () => undefined);',
      'import fs from "node:fs"; const { realpath } = fs.promises;',
      'import fs from "node:fs"; const { realpath: real } = fs.promises;',
      'import fs from "node:fs"; await fs.promises["realpath"]("x");',
      'const { realpath } = await import("node:fs/promises");',
    ];
    for (const form of forms) expect(realpathUses("sample.ts", form), form).toHaveLength(1);
    const clean = [
      "// realpath is only named in a comment",
      'const text = "realpath";',
      'import { realpathSync } from "node:fs"; realpathSync.native("x");',
      "const realpathOrSame = (path: string) => path;",
      "/** `realpath` of node:fs/promises */ export const realPath = 1;",
    ];
    for (const form of clean) expect(realpathUses("sample.ts", form), form).toEqual([]);
  });

  test("task_7bh9_no_async_realpath_in_src", async () => {
    const packages = join(import.meta.dir, "..", "..");
    const found: string[] = [];
    let scanned = 0;
    for (const name of ["local", "testkit", "cli"]) {
      for (const file of await sourceFiles(join(packages, name, "src"))) {
        scanned += 1;
        found.push(...realpathUses(relative(packages, file), await readFile(file, "utf8")));
      }
    }
    expect(scanned).toBeGreaterThan(50);
    // use `realPath` of `packages/local/src/real-path.ts`: the promise form can be lost by the runtime
    expect(found).toEqual([]);
  });
});
