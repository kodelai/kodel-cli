/** Task links and readiness (TASK-9RZD, T-45): the pure rules every adapter and the daemon share. */
import { describe, expect, test } from "bun:test";
import {
  applyLinkPatch,
  blockedBy,
  buildGraph,
  cycles,
  type DependencyRef,
  dependencyRefs,
  findCycle,
  KodelError,
  type ReadyInput,
  readinessWords,
  ready,
  spellCycle,
  type TaskPatch,
  validatePatch,
} from "../src";

const dep = (key: string, state: DependencyRef["state"], waits = false): DependencyRef =>
  waits ? { key, state, needs_approval: true } : { key, state };

describe("t45 readiness", () => {
  test("t45_ready_table", () => {
    const openRun = new Map([["T-W", "r_0mvimyn54_tc9o"]]);
    const table: [string, ReadyInput, ReturnType<typeof ready>][] = [
      ["no links", { task: { key: "T-A" } }, { ok: true }],
      [
        "dependency open",
        { task: { key: "T-A", depends_on: ["T-B"], dependencies: [dep("T-B", "open")] } },
        { ok: false, why: "blocked", by: ["T-B"] },
      ],
      [
        "dependency done",
        { task: { key: "T-A", depends_on: ["T-B"], dependencies: [dep("T-B", "done")] } },
        { ok: true },
      ],
      [
        "dependency declined counts as done",
        { task: { key: "T-A", depends_on: ["T-B"], dependencies: [dep("T-B", "declined")] } },
        { ok: true },
      ],
      [
        "dependency missing",
        { task: { key: "T-A", depends_on: ["T-B"], dependencies: [dep("T-B", "missing")] } },
        { ok: false, why: "blocked", by: ["T-B"] },
      ],
      [
        "dependency done but not approved",
        { task: { key: "T-A", depends_on: ["T-B"], dependencies: [dep("T-B", "done", true)] } },
        { ok: false, why: "blocked", by: ["T-B"] },
      ],
      [
        "dependency declined but not approved",
        { task: { key: "T-A", depends_on: ["T-B"], dependencies: [dep("T-B", "declined", true)] } },
        { ok: false, why: "blocked", by: ["T-B"] },
      ],
      [
        "approval waived by the rule",
        {
          task: { key: "T-A", depends_on: ["T-B"], dependencies: [dep("T-B", "done", true)] },
          approval: "any",
        },
        { ok: true },
      ],
      [
        "an open dependency is not waived",
        {
          task: { key: "T-A", depends_on: ["T-B"], dependencies: [dep("T-B", "open", true)] },
          approval: "any",
        },
        { ok: false, why: "blocked", by: ["T-B"] },
      ],
      [
        "a key absent from dependencies blocks (fail closed)",
        { task: { key: "T-A", depends_on: ["T-B", "T-C"], dependencies: [dep("T-B", "done")] } },
        { ok: false, why: "blocked", by: ["T-C"] },
      ],
      [
        "a state the core does not know blocks",
        {
          task: {
            key: "T-A",
            depends_on: ["T-B"],
            dependencies: [{ key: "T-B", state: "later" as DependencyRef["state"] }],
          },
        },
        { ok: false, why: "blocked", by: ["T-B"] },
      ],
      [
        "conflict with an open run",
        { task: { key: "T-A", conflicts_with: ["T-W"] }, openRunTasks: openRun },
        { ok: false, why: "conflict", with: "T-W", run: "r_0mvimyn54_tc9o" },
      ],
      [
        "conflict with an ended run (not among the open ones)",
        { task: { key: "T-A", conflicts_with: ["T-Z"] }, openRunTasks: openRun },
        { ok: true },
      ],
      [
        "conflict with a task started in this cycle",
        { task: { key: "T-A", conflicts_with: ["T-Z"] }, startedNow: ["T-Z"] },
        { ok: false, why: "conflict", with: "T-Z" },
      ],
      [
        "a conflict while a run cannot be read",
        { task: { key: "T-A", conflicts_with: ["T-Z"] }, unreadableRuns: ["r_0mvin1n0q_c91r"] },
        { ok: false, why: "conflict", run: "r_0mvin1n0q_c91r" },
      ],
      [
        "an unreadable run holds back no task without a conflict",
        { task: { key: "T-A" }, unreadableRuns: ["r_0mvin1n0q_c91r"] },
        { ok: true },
      ],
      [
        "a block is told before a conflict",
        {
          task: {
            key: "T-A",
            depends_on: ["T-B"],
            dependencies: [dep("T-B", "open")],
            conflicts_with: ["T-W"],
          },
          openRunTasks: openRun,
        },
        { ok: false, why: "blocked", by: ["T-B"] },
      ],
    ];
    for (const [name, input, expected] of table) {
      expect({ name, verdict: ready(input) }).toEqual({ name, verdict: expected });
    }
  });

  test("t45_readiness_words_hold_keys_and_fixed_words_only", () => {
    const task = {
      key: "T-A",
      depends_on: ["T-B", "T-C", "T-D"],
      dependencies: [dep("T-B", "open"), dep("T-C", "done", true)],
      conflicts_with: ["T-W"],
    };
    expect(readinessWords(task, { ok: false, why: "blocked", by: ["T-B", "T-C", "T-D"] })).toBe(
      "T-A waits for T-B (open), T-C (done, waits for approval), T-D (missing)",
    );
    expect(readinessWords(task, { ok: false, why: "conflict", with: "T-W", run: "r_1" })).toBe(
      "T-A conflicts with T-W (run r_1)",
    );
    expect(readinessWords(task, { ok: false, why: "conflict", run: "r_2" })).toBe(
      "T-A has conflicts and run r_2 cannot be read",
    );
  });

  test("t45_dependency_refs_take_the_trackers_word", () => {
    const facts: Record<string, { closed: boolean; declined?: boolean; needs_approval?: boolean }> =
      {
        open: { closed: false, needs_approval: true },
        done: { closed: true },
        no: { closed: true, declined: true },
        agent: { closed: true, needs_approval: true },
      };
    const refs = dependencyRefs(["open", "done", "no", "agent", "gone"], (key) => facts[key]);
    expect(refs).toEqual([
      // An open dependency blocks whatever its approval: the mark is only said of a closed one.
      { key: "open", state: "open" },
      { key: "done", state: "done" },
      { key: "no", state: "declined" },
      { key: "agent", state: "done", needs_approval: true },
      { key: "gone", state: "missing" },
    ]);
    expect(blockedBy({ depends_on: refs.map((r) => r.key), dependencies: refs })).toEqual([
      "open",
      "agent",
      "gone",
    ]);
  });
});

describe("t45 link patches", () => {
  test("t45_link_patch_validation_table", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `T-${i}`);
    const refusedBy = (patch: TaskPatch): string | undefined => {
      try {
        validatePatch(patch);
      } catch (error) {
        expect(error).toBeInstanceOf(KodelError);
        expect((error as KodelError).code).toBe("INVALID_TASK");
        return (error as KodelError).message;
      }
      return undefined;
    };
    expect(refusedBy({ depends_on: many(20) })).toBeUndefined();
    expect(refusedBy({ depends_on: many(21) })).toContain("at most 20");
    expect(refusedBy({ add_conflicts_with: many(21) })).toContain("at most 20");
    expect(refusedBy({ depends_on: ["T-1", "T-1"] })).toContain("listed twice");
    expect(refusedBy({ depends_on: [] })).toContain("at least one");
    expect(refusedBy({ depends_on: ["T-1", 7 as unknown as string] })).toBeDefined();
    expect(refusedBy({ depends_on: "T-1" as unknown as string[] })).toBeDefined();
    expect(refusedBy({ add_depends_on: ["T-1"], remove_depends_on: ["T-1"] })).toContain(
      "both added to and removed from depends_on",
    );
    expect(refusedBy({ add_depends_on: ["T-1"], remove_depends_on: ["T-2"] })).toBeUndefined();
    expect(refusedBy({ depends_on: ["T-1"], add_depends_on: ["T-2"] })).toContain("whole list");
    expect(refusedBy({ conflicts_with: ["T-1"], remove_conflicts_with: ["T-2"] })).toContain(
      "whole list",
    );
    expect(refusedBy({ depends_on: ["T-1"], clear: ["depends_on"] })).toContain("cleared");
    expect(refusedBy({ add_conflicts_with: ["T-1"], clear: ["conflicts_with"] })).toContain(
      "cleared",
    );
    expect(refusedBy({ clear: ["depends_on", "conflicts_with"] })).toBeUndefined();
    // One list may be set while the other is cleared.
    expect(refusedBy({ depends_on: ["T-1"], clear: ["conflicts_with"] })).toBeUndefined();
  });

  test("t45_apply_link_patch_sets_adds_removes_and_clears", () => {
    const current = { depends_on: ["A", "B"], conflicts_with: ["X"] };
    expect(applyLinkPatch(current, { depends_on: ["C"] })).toEqual({
      depends_on: ["C"],
      conflicts_with: ["X"],
    });
    expect(
      applyLinkPatch(current, { add_depends_on: ["B", "C"], remove_conflicts_with: ["X"] }),
    ).toEqual({ depends_on: ["A", "B", "C"], conflicts_with: [] });
    expect(applyLinkPatch(current, { remove_depends_on: ["A", "Z"] }).depends_on).toEqual(["B"]);
    expect(applyLinkPatch(current, { clear: ["depends_on", "body"] })).toEqual({
      depends_on: [],
      conflicts_with: ["X"],
    });
    expect(current).toEqual({ depends_on: ["A", "B"], conflicts_with: ["X"] });
  });
});

describe("t45 cycles", () => {
  const graph: Record<string, string[]> = { A: ["B"], B: ["C"], C: [], D: ["A"] };
  const at = (key: string) => graph[key];

  test("t45_find_cycle_spells_the_way_round", () => {
    expect(findCycle("A", ["A"], at)).toEqual(["A", "A"]);
    expect(spellCycle(findCycle("B", ["A"], at) ?? [])).toBe("B -> A -> B");
    expect(spellCycle(findCycle("C", ["D"], at) ?? [])).toBe("C -> D -> A -> B -> C");
    expect(findCycle("C", ["X"], at)).toBeUndefined();
    expect(findCycle("D", ["A", "C"], at)).toBeUndefined();
  });

  test("t45_link_walks_visit_each_task_once", () => {
    const n = 5000;
    const key = (i: number) => `T-${String(i).padStart(4, "0")}`;
    // Every task names the next three (the last ones wrap round): one group of all of them.
    const tasks = Array.from({ length: n }, (_, i) => ({
      key: key(i),
      depends_on: [key((i + 1) % n), key((i + 2) % n), key((i + 3) % n)],
    }));
    let visits = 0;
    const found = cycles(buildGraph(tasks), () => {
      visits += 1;
    });
    expect(visits).toBe(n);
    expect(found.length).toBe(1);
    expect(found[0]?.length).toBe(n);

    // A chain as long has no cycle, and the walk that looks for one asks for each task once.
    const chain = new Map(tasks.map((t, i) => [t.key, i + 1 < n ? [key(i + 1)] : []] as const));
    let asked = 0;
    const none = findCycle("T-NEW", [key(0)], (k) => {
      asked += 1;
      return chain.get(k);
    });
    expect(none).toBeUndefined();
    expect(asked).toBe(n);
    expect(cycles(buildGraph([...chain].map(([k, d]) => ({ key: k, depends_on: d }))))).toEqual([]);
  });

  test("t45_cycles_names_every_group", () => {
    const found = cycles(
      buildGraph([
        { key: "A", depends_on: ["B"] },
        { key: "B", depends_on: ["A"] },
        { key: "C", depends_on: ["C"] },
        { key: "D", depends_on: ["A", "GONE"] },
        { key: "E" },
      ]),
    );
    expect(found).toEqual([["A", "B"], ["C"]]);
  });
});
