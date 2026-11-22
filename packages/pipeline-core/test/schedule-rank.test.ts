/** The base order of `kodel serve` (TASK-9RZD, T-46). */
import { describe, expect, test } from "bun:test";
import { type RankTask, rank } from "../src";

const PRIORITIES = ["high", "normal", "low"];

const t = (key: string, over: Partial<RankTask> = {}): RankTask => ({
  key,
  state: "todo",
  priority: "normal",
  ...over,
});

const orderOf = (tasks: RankTask[]): string[] => {
  const ranks = rank(tasks, PRIORITIES);
  return [...ranks.entries()].sort((a, b) => a[1].place - b[1].place).map(([key]) => key);
};

describe("t46 the base order", () => {
  test("t46_rank_table", () => {
    // Own priority first.
    expect(orderOf([t("B", { priority: "low" }), t("A", { priority: "high" }), t("C")])).toEqual([
      "A",
      "C",
      "B",
    ]);

    // Raised through any number of steps: C (high) waits for B, B waits for A.
    const chain = [
      t("A", { priority: "low", created_at: "2026-01-03" }),
      t("B", { priority: "low", depends_on: ["A"], created_at: "2026-01-02" }),
      t("C", { priority: "high", depends_on: ["B"], created_at: "2026-01-01" }),
      t("D", { priority: "normal", created_at: "2026-01-01" }),
    ];
    const ranks = rank(chain, PRIORITIES);
    expect(ranks.get("A")).toMatchObject({ effective: 0, raisedBy: "C", unblocks: 2 });
    expect(ranks.get("B")).toMatchObject({ effective: 0, raisedBy: "C", unblocks: 1 });
    expect(ranks.get("C")).toMatchObject({ effective: 0, unblocks: 0 });
    expect(ranks.get("C")?.raisedBy).toBeUndefined();
    // A dependency stands before its dependents, though it was made last.
    expect(orderOf(chain)).toEqual(["A", "B", "C", "D"]);

    // On equal priority the task that unblocks more goes first, then the older one, then the key.
    expect(
      orderOf([
        t("Z", { created_at: "2026-01-01" }),
        t("Y", { created_at: "2026-01-05" }),
        t("X", { depends_on: ["Y"], created_at: "2026-01-06" }),
        t("B", { created_at: "2026-01-02" }),
        t("A", { created_at: "2026-01-02" }),
      ]),
    ).toEqual(["Y", "Z", "A", "B", "X"]);

    // A done or declined dependent raises nothing and is not counted.
    const closed = rank(
      [t("A", { priority: "low" }), t("B", { priority: "high", state: "done", depends_on: ["A"] })],
      PRIORITIES,
    );
    expect(closed.get("A")).toMatchObject({ effective: 2, unblocks: 0 });

    // A dependent that waits for approval raises nothing, and nothing is raised through it.
    const unapproved = rank(
      [
        t("A", { priority: "low" }),
        t("B", { priority: "high", needs_approval: true, depends_on: ["A"] }),
        t("C", { priority: "low", needs_approval: true, depends_on: ["A"] }),
        t("D", { priority: "high", depends_on: ["C"] }),
      ],
      PRIORITIES,
    );
    expect(unapproved.get("A")).toMatchObject({ effective: 2, unblocks: 0 });
    // The task that waits for approval is itself raised by the approved task that waits for it.
    expect(unapproved.get("C")).toMatchObject({ effective: 0, raisedBy: "D", unblocks: 1 });

    // A task with a priority the tracker does not list goes last.
    expect(orderOf([t("A", { priority: "odd" }), t("B", { priority: "low" })])).toEqual(["B", "A"]);
  });

  test("t46_a_task_that_waits_for_approval_moves_no_other", () => {
    const mine = [
      t("A", { priority: "low", created_at: "2026-01-01" }),
      t("B", { priority: "normal", created_at: "2026-01-02" }),
      t("C", { priority: "normal", created_at: "2026-01-03" }),
    ];
    const before = orderOf(mine);
    const after = orderOf([
      ...mine,
      t("X", { priority: "high", needs_approval: true, depends_on: ["A", "C"] }),
    ]).filter((key) => key !== "X");
    expect(after).toEqual(before);
  });

  test("t46_order_is_reproducible_from_the_tasks", () => {
    const tasks = [
      t("A", { priority: "low", created_at: "2026-01-04" }),
      t("B", { depends_on: ["A"], created_at: "2026-01-03" }),
      t("C", { priority: "high", depends_on: ["B", "E"], created_at: "2026-01-02" }),
      t("D", { created_at: "2026-01-02" }),
      t("E", { created_at: "2026-01-02" }),
      t("F", { priority: "high", needs_approval: true, depends_on: ["D"] }),
      t("G", { state: "done", depends_on: ["D"] }),
      t("H", { state: "progress", priority: "high", depends_on: ["D"] }),
    ];
    const expected = orderOf(tasks);
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 50; round += 1) {
      const shuffled = [...tasks];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j] as RankTask, shuffled[i] as RankTask];
      }
      expect(orderOf(shuffled)).toEqual(expected);
      expect(rank(shuffled, PRIORITIES)).toEqual(rank(tasks, PRIORITIES));
    }
  });

  test("t46_rank_ends_on_a_cycle", () => {
    const cyclic = [
      t("A", { priority: "low", depends_on: ["B"] }),
      t("B", { priority: "normal", depends_on: ["C"] }),
      t("C", { priority: "high", depends_on: ["A", "C"] }),
      t("D", { priority: "low", depends_on: ["A"] }),
    ];
    const ranks = rank(cyclic, PRIORITIES);
    // Every member is raised to the most urgent of the cycle, and each counts the others once.
    expect(ranks.get("A")).toMatchObject({ effective: 0, unblocks: 3 });
    expect(ranks.get("B")).toMatchObject({ effective: 0, unblocks: 3 });
    expect(ranks.get("C")).toMatchObject({ effective: 0, unblocks: 3 });
    expect(rank([...cyclic].reverse(), PRIORITIES)).toEqual(ranks);

    const n = 3000;
    const ring = Array.from({ length: n }, (_, i) =>
      t(`T-${i}`, { depends_on: [`T-${(i + 1) % n}`] }),
    );
    expect(rank(ring, PRIORITIES).size).toBe(n);
  });

  test("t46_created_at_is_compared_as_text", () => {
    // No date is parsed: the same order on every machine, whatever the text is.
    expect(
      orderOf([
        t("A", { created_at: "not a date" }),
        t("B", { created_at: "2026-11-02T10:00:00.000Z" }),
        t("C", { created_at: "2026-11-02T09:00:00.000+05:00" }),
        t("D", { created_at: "10/01/2026" }),
      ]),
    ).toEqual(["D", "C", "B", "A"]);
    // Rows without a time go after those with one and keep their list place among themselves.
    expect(
      orderOf([
        t("Z", { order: 0 }),
        t("B", { created_at: "2026-01-02", order: 1 }),
        t("Y", { order: 2 }),
        t("A", { created_at: "2026-01-01", order: 3 }),
      ]),
    ).toEqual(["A", "B", "Z", "Y"]);
  });

  test("t46_created_at_beats_list_order", () => {
    // The tracker listed the newer task first: the older one still goes first.
    expect(
      orderOf([
        t("NEW", { created_at: "2026-02-01T00:00:00.000Z", order: 0 }),
        t("OLD", { created_at: "2026-01-01T00:00:00.000Z", order: 1 }),
      ]),
    ).toEqual(["OLD", "NEW"]);
  });
});
