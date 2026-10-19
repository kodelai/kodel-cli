import { describe, expect, test } from "bun:test";
import { aggregate, formatTable, parseBunOutput, type RunRecord, unreliable } from "./stats";

const OUTPUT = [
  "bun test v1.3.5 (abc)",
  "",
  "tests/agents/claude-code.test.ts:",
  "(pass) Claude Code > follows the pipeline [24250.12ms]",
  "(fail) Claude Code > cannot be talked into approving its own gate [11.5s]",
  "(skip) Claude Code > a slow one",
  "(pass) group > nested > with a [bracket] in its name [1.00ms]",
  "",
  " 2 pass",
].join("\n");

describe("parseBunOutput", () => {
  const results = parseBunOutput(OUTPUT);

  test("reads one result per test line, with its time in milliseconds", () => {
    expect(results.map((r) => [r.name, r.verdict, r.ms])).toEqual([
      ["Claude Code > follows the pipeline", "pass", 24250.12],
      ["Claude Code > cannot be talked into approving its own gate", "fail", 11500],
      ["Claude Code > a slow one", "skip", undefined],
      ["group > nested > with a [bracket] in its name", "pass", 1],
    ]);
  });

  test("ignores everything that is not a result line", () => {
    expect(parseBunOutput("nothing here\n 3 pass\n")).toEqual([]);
  });
});

const run = (model: string, n: number, verdicts: Record<string, "pass" | "fail" | "skip">) =>
  ({
    model,
    run: n,
    results: Object.entries(verdicts).map(([name, verdict]) => ({
      name,
      verdict,
      ...(verdict === "pass" ? { ms: 10_000 * n } : {}),
    })),
  }) satisfies RunRecord;

describe("aggregate", () => {
  const rows = aggregate([
    run("sonnet", 1, { a: "pass", b: "fail", c: "skip" }),
    run("sonnet", 2, { a: "pass", b: "pass", c: "skip" }),
    run("sonnet", 3, { a: "pass", b: "fail", c: "skip" }),
    run("opus", 1, { a: "fail", b: "pass" }),
  ]);
  const find = (name: string, model: string) =>
    rows.find((r) => r.name === name && r.model === model);

  test("counts passes over the runs, per scenario and per model", () => {
    expect(find("a", "sonnet")).toMatchObject({ runs: 3, passes: 3, rate: 1 });
    expect(find("b", "sonnet")).toMatchObject({ runs: 3, passes: 1 });
    expect(find("a", "opus")).toMatchObject({ runs: 1, passes: 0, rate: 0 });
  });

  test("a scenario that was only skipped has no rate, and is not called unreliable", () => {
    expect(find("c", "sonnet")).toMatchObject({ runs: 0, rate: undefined });
    expect(unreliable(rows).map((r) => `${r.model}:${r.name}`)).toEqual(["opus:a", "sonnet:b"]);
  });

  test("the mean time is of the runs that passed", () => {
    expect(find("a", "sonnet")?.mean_s).toBe(20); // 10, 20, 30 s
    expect(find("b", "sonnet")?.mean_s).toBe(20); // only run 2 passed
    expect(find("a", "opus")?.mean_s).toBeUndefined();
  });

  test("the table puts the least reliable first", () => {
    const lines = formatTable(rows).split("\n").filter(Boolean);
    expect(lines[0]).toContain("a");
    expect(lines[0]).toContain("0/1");
    expect(lines.at(-1)).toContain("skipped");
    expect(formatTable(rows)).toContain("3/3 (100%)");
  });
});
