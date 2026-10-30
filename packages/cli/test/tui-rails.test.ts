import { describe, expect, test } from "bun:test";
import { stripAnsi, visibleLength } from "../src/tui/ansi";
import type { PipeStep } from "../src/tui/pipelines";
import { railLines } from "../src/tui/rails";

/** A step whose routes are `to` or `to:when`; a route to an earlier step is a way back. */
function pipeline(...defs: [string, string[]][]): PipeStep[] {
  const slugs = defs.map(([slug]) => slug);
  return defs.map(([slug, routes], at) => ({
    slug,
    kind: "agent",
    gate: false,
    limits: "",
    params: [],
    checks: [],
    routes: routes.map((r) => {
      const [to = "", when = ""] = r.split(":");
      return { to, when, back: slugs.indexOf(to) <= at };
    }),
  }));
}

/** The rows of the steps, without the empty line and the legend under them. */
const draw = (steps: PipeStep[], cursor = 0, width = 80): string[] =>
  (railLines(steps, cursor, width)?.lines ?? []).slice(0, -2).map(stripAnsi);

describe("railLines", () => {
  test("a pipeline that never goes back has no rails", () => {
    const lines = draw(pipeline(["a", ["b"]], ["b", ["c"]], ["c", []]));
    expect(lines.join("\n")).not.toContain("◄");
    expect(lines.slice(0, 3).join("\n")).not.toMatch(/[│┤┘┐]/);
  });

  test("a way back is a rail from the step it returns to down to the step that returns", () => {
    const lines = draw(pipeline(["a", ["b"]], ["b", ["c"]], ["c", ["a:failed"]]));
    expect(lines[0]).toContain("◄");
    expect(lines[0]).toContain("┐");
    expect(lines[1]).toContain("│");
    expect(lines[2]).toContain("┘");
    expect(lines[2]).toContain("failed");
  });

  test("returns to one step share a rail, and each leaves with its own label", () => {
    const lines = draw(
      pipeline(["a", ["b"]], ["b", ["c", "a:rejected"]], ["c", ["d", "a:failed"]], ["d", []]),
    );
    expect(lines.filter((l) => l.includes("◄"))).toHaveLength(1);
    expect(lines[1]).toContain("┤");
    expect(lines[1]).toContain("rejected");
    expect(lines[2]).toContain("┘");
    expect(lines[2]).toContain("failed");
  });

  test("a step that two others return to does not need a second rail for the second one", () => {
    const steps = pipeline(["a", ["b"]], ["b", ["c", "a:x"]], ["c", ["a:y"]]);
    const lines = draw(steps);
    expect(lines.filter((l) => l.includes("◄"))).toHaveLength(1);
  });

  test("a step with two ways back puts the second under itself", () => {
    const lines = draw(
      pipeline(["a", ["b"]], ["b", ["c"]], ["c", ["d"]], ["d", ["a:first", "b:second"]]),
    );
    const text = lines.join("\n");
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(lines.filter((l) => l.includes("◄"))).toHaveLength(2);
  });

  test("a step that is returned to and returns itself keeps both lines apart", () => {
    const lines = draw(
      pipeline(["a", ["b"]], ["b", ["c"]], ["c", ["d", "b:one"]], ["d", ["c:two"]]),
    );
    const text = lines.join("\n");
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(lines.filter((l) => l.includes("◄"))).toHaveLength(2);
  });

  test("a jump forward is told by the number of the step", () => {
    const lines = draw(pipeline(["a", ["b", "c:skip"]], ["b", ["c"]], ["c", []]));
    expect(lines.join("\n")).toContain("skip → 3");
  });

  test("the rails are not drawn through the arrows of another step", () => {
    const lines = draw(
      pipeline(["a", ["b"]], ["b", ["c"]], ["c", ["d", "a:x"]], ["d", ["e"]], ["e", ["d:y"]]),
    );
    // Two separate loops: a..c and d..e. No row has more than one arrow head.
    for (const l of lines) expect(l.split("◄").length - 1).toBeLessThanOrEqual(1);
  });

  test("the cursor is the anchor, and is marked", () => {
    const steps = pipeline(["a", ["b"]], ["b", ["c"]], ["c", []]);
    const found = railLines(steps, 1, 80);
    expect(found?.anchor).toBe(1);
    expect(stripAnsi(found?.lines[1] ?? "")).toContain("❯");
  });

  test("no line is wider than the card", () => {
    const steps = pipeline(
      ["plan", ["plan-critique", "confirm-nothing-to-do:nothing_to_change"]],
      ["plan-critique", ["plan-revise", "plan:blocking_findings"]],
      ["plan-revise", ["impl"]],
      ["confirm-nothing-to-do", ["plan:rejected"]],
      ["impl", ["verify"]],
      ["verify", ["impl:failed"]],
    );
    for (const width of [52, 60, 72, 100, 140]) {
      for (const line of railLines(steps, 2, width)?.lines ?? []) {
        expect(visibleLength(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("a card too narrow for the labels gets nothing, so that the list is drawn", () => {
    const steps = pipeline(["a-long-step-name", ["b"]], ["b", ["a-long-step-name:failed"]]);
    expect(railLines(steps, 0, 24)).toBeUndefined();
  });

  test("no steps is nothing to draw", () => {
    expect(railLines([], 0, 80)).toBeUndefined();
  });
});
