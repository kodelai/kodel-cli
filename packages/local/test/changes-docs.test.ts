import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

// Tests of TASK-36TW: every limit written in docs/changes.md names a test that exists.

const root = new URL("../../../", import.meta.url);
const testSources = (): string => {
  const out: string[] = [];
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const next = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, dir);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".test.ts")) out.push(readFileSync(next, "utf8"));
    }
  };
  for (const folder of ["packages/", "tests/"]) walk(new URL(folder, root));
  return out.join("\n");
};

test("t36tw_docs_limits_have_tests", () => {
  const docs = readFileSync(new URL("docs/changes.md", root), "utf8");
  const named = [...docs.matchAll(/`(t36tw_[a-z0-9_]+\*?)`/g)].map((m) => m[1] as string);
  expect(named.length).toBeGreaterThan(10);
  const sources = testSources();
  for (const name of named) {
    // `name_*` names a family of tests
    const stem = name.endsWith("*") ? name.slice(0, -1) : name;
    expect({ name, found: sources.includes(stem) }).toEqual({ name, found: true });
  }
  // and the lines of the table of limits all say which: a test, or that it is policy
  const start = docs.indexOf("## What is not in a patch");
  const section = docs.slice(start, docs.indexOf("\n## ", start + 5));
  const table = section.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| ---"));
  expect(table.length).toBeGreaterThan(10);
  for (const row of table.slice(1)) {
    expect({ row, ok: /t36tw_|policy/.test(row) }).toEqual({ row, ok: true });
  }
});
