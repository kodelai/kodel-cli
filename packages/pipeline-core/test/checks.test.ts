import { describe, expect, test } from "bun:test";
import { evaluateCommand, evaluateDiff } from "../src";

const diff = (changes: Record<string, number>, params: Record<string, unknown>) =>
  evaluateDiff(changes, params);

describe("diff modes", () => {
  const paths = ["src/**"];

  test("changed: at least one change inside, anything outside", () => {
    expect(diff({ "src/a.ts": 3 }, { paths }).passed).toBe(true);
    expect(diff({ "src/a.ts": 3, "README.md": 9 }, { paths }).passed).toBe(true);
    expect(diff({ "README.md": 9 }, { paths }).passed).toBe(false);
    expect(diff({}, { paths }).passed).toBe(false);
  });

  test("changed is the default mode", () => {
    expect(diff({}, { paths }).reason).toContain("nothing changed in src/**");
  });

  test("changed_only: at least one change inside and nothing outside", () => {
    const params = { paths, mode: "changed_only" };
    expect(diff({ "src/a.ts": 1 }, params).passed).toBe(true);
    const outside = diff({ "src/a.ts": 1, "x.md": 2 }, params);
    expect(outside.passed).toBe(false);
    expect(outside.reason).toContain("changes outside src/**: x.md");
    expect(diff({}, params).passed).toBe(false);
  });

  test("only: nothing outside, changes inside are not required", () => {
    const params = { paths, mode: "only" };
    expect(diff({}, params).passed).toBe(true);
    expect(diff({ "src/a.ts": 1 }, params).passed).toBe(true);
    expect(diff({ "x.md": 1 }, params).passed).toBe(false);
  });

  test("unchanged: nothing inside, anything outside", () => {
    const params = { paths, mode: "unchanged" };
    expect(diff({ "x.md": 5 }, params).passed).toBe(true);
    const inside = diff({ "src/a.ts": 1 }, params);
    expect(inside.passed).toBe(false);
    expect(inside.reason).toContain("must stay untouched: src/a.ts");
  });

  test("paths with zero changed lines count as unchanged", () => {
    expect(diff({ "src/a.ts": 0 }, { paths }).passed).toBe(false);
    expect(diff({ "src/a.ts": 0 }, { paths, mode: "unchanged" }).passed).toBe(true);
  });

  test("globs match nested paths and dotfiles", () => {
    expect(diff({ "src/deep/er/a.ts": 1 }, { paths }).passed).toBe(true);
    expect(diff({ ".kodel/runs/x.json": 1 }, { paths: [".kodel/**"] }).passed).toBe(true);
    expect(
      diff({ "docs/plans/x.md": 1 }, { paths: ["docs/plans/x.md"], mode: "changed_only" }).passed,
    ).toBe(true);
  });
});

describe("diff line limits", () => {
  test("min_lines and max_lines count only the files that match paths", () => {
    const paths = ["src/**"];
    const changes = { "src/a.ts": 6, "src/b.ts": 6, "docs/x.md": 1000 };
    expect(diff(changes, { paths, min_lines: 12, max_lines: 12 }).passed).toBe(true);
    expect(diff(changes, { paths, min_lines: 13 }).reason).toContain(
      "12 changed lines in src/**, at least 13 required",
    );
    expect(diff(changes, { paths, max_lines: 11 }).reason).toContain("at most 11 allowed");
  });

  test("a total is expressed with a catch-all path", () => {
    expect(diff({ "a.ts": 5, "b.ts": 5 }, { paths: ["**"], max_lines: 9 }).passed).toBe(false);
  });

  test("the mode is checked before the limits", () => {
    const verdict = diff({ "x.md": 1 }, { paths: ["src/**"], mode: "changed", min_lines: 5 });
    expect(verdict.reason).toContain("nothing changed");
  });

  test("long lists of paths are shortened in the reason", () => {
    const changes = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`x/f${i}.ts`, 1]));
    const reason = diff(changes, { paths: ["src/**"], mode: "only" }).reason;
    expect(reason).toContain("x/f0.ts");
    expect(reason).toContain("...");
    expect(reason).not.toContain("x/f8.ts");
  });
});

describe("command verdict", () => {
  test("passes on the expected exit code, 0 by default", () => {
    expect(evaluateCommand(0, {}).passed).toBe(true);
    expect(evaluateCommand(1, {}).reason).toContain("exited with 1, expected 0");
    expect(evaluateCommand(2, { expect: { exit: 2 } }).passed).toBe(true);
    expect(evaluateCommand(0, { expect: { exit: 2 } }).passed).toBe(false);
  });
});
