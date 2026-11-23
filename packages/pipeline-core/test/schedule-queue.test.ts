/** The queues of `kodel serve` and the policy that orders them (TASK-9RZD, T-46). */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { order, type QueuePolicy, rank, startPolicy, workerPolicy } from "../src";

const PRIORITIES = ["high", "normal", "low"];

describe("t46 queues", () => {
  test("t46_queue_order_follows_the_policy", () => {
    const tasks = [
      { key: "A", state: "todo" as const, priority: "low" },
      { key: "B", state: "todo" as const, priority: "high", depends_on: ["A"] },
      { key: "C", state: "todo" as const, priority: "normal" },
    ];
    const ctx = { priorities: PRIORITIES, ranks: rank(tasks, PRIORITIES) };
    const placed = order(tasks, startPolicy, ctx);
    expect(placed.map((p) => p.entry.key)).toEqual(["A", "B", "C"]);
    expect(placed.map((p) => p.reason)).toEqual([
      "priority high (raised by B), unblocks 1",
      "priority high",
      "priority normal",
    ]);

    // Another policy, another order: `order` follows the policy's key and nothing else.
    const reversed: QueuePolicy<{ key: string }> = {
      name: "reversed",
      key: (entry, c) => [-(c.ranks.get(entry.key)?.place ?? 0)],
      reason: () => "reversed",
    };
    expect(order(tasks, reversed, ctx).map((p) => p.entry.key)).toEqual(["C", "B", "A"]);
    // The input is not changed, and what the policy does not know goes last, by key.
    expect(tasks.map((x) => x.key)).toEqual(["A", "B", "C"]);
    expect(
      order([{ key: "Z" }, { key: "Y" }, { key: "C" }], startPolicy, ctx).map((p) => p.entry.key),
    ).toEqual(["C", "Y", "Z"]);
  });

  test("t46_worker_queue_is_oldest_decision_first", () => {
    const ctx = { priorities: [], ranks: new Map() };
    const placed = order(
      [
        { runId: "r_b", ts: 200, seq: 4 },
        { runId: "r_c", ts: 100, seq: 9 },
        { runId: "r_a", ts: 200, seq: 4 },
        { runId: "r_d", ts: 200, seq: 3 },
      ],
      workerPolicy,
      ctx,
    );
    expect(placed.map((p) => p.entry.runId)).toEqual(["r_c", "r_d", "r_a", "r_b"]);
    expect(placed[0]?.reason).toBe("decided at 100");
  });

  test("t46_schedule_is_pure", () => {
    const dir = join(import.meta.dir, "..", "src", "schedule");
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(files.sort()).toEqual(["index.ts", "links.ts", "queue.ts", "rank.ts", "ready.ts"]);
    for (const name of files) {
      const text = readFileSync(join(dir, name), "utf8");
      const sources = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string);
      // Core types and each other: no node module, no clock, no transport.
      for (const source of sources) {
        expect({
          name,
          source,
          ok: /^\.\/(links|queue|rank|ready)$|^\.\.\/tasks$/.test(source),
        }).toEqual({ name, source, ok: true });
      }
      expect(/\bDate\b|Math\.random|process\.|localeCompare/.test(text)).toBe(false);
    }
  });
});
