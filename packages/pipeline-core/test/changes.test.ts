import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  type ChangesRef,
  decide,
  isChangesRef,
  isTreeId,
  type JournalRecord,
  parsePipeline,
  type RunEvent,
  type RunState,
} from "../src";

// Tests of TASK-36TW: the fields of the events that point to the patches.

const spec = parsePipeline(
  ["name: p", "nodes:", "  - slug: a", "    kind: agent", "    prompt: x", "edges: []", ""].join(
    "\n",
  ),
);
const TREE = "a".repeat(40);

function run(...events: RunEvent[]) {
  let state: RunState | undefined;
  const journal: JournalRecord[] = [];
  const results: ReturnType<typeof decide>[] = [];
  for (const event of events) {
    const result = decide(spec, state, event, 0);
    results.push(result);
    if (!result.ok) continue;
    state = result.state;
    journal.push(...result.journal);
  }
  return { state, journal, results };
}
const START: RunEvent = { type: "start", runId: "r1", task: "t", specHash: "h" };
const ref: ChangesRef = { ref: "changes/a-1.patch", bytes: 12, truncated: false };

describe("the shape of what points to a patch", () => {
  test("t36tw_bad_ref_and_tree_are_recognised", () => {
    expect(isChangesRef(ref)).toBe(true);
    for (const bad of [
      { ...ref, ref: "changes/../state.json" },
      { ...ref, ref: "/etc/passwd" },
      { ...ref, ref: "artifacts/a-1.patch" },
      { ...ref, ref: "changes\\a.patch" },
      { ...ref, bytes: -1 },
      { ...ref, bytes: 1.5 },
      { ...ref, truncated: "no" },
      "changes/a.patch",
      null,
    ]) {
      expect(isChangesRef(bad)).toBe(false);
    }
    expect(isTreeId(TREE)).toBe(true);
    expect(isTreeId("b".repeat(64))).toBe(true);
    for (const bad of ["--output=/x", "-p", "", "A".repeat(40), "a".repeat(39), `${TREE}\n`, 5]) {
      expect(isTreeId(bad)).toBe(false);
    }
  });
});

describe("what a hand-in journals of the host's fields", () => {
  test("t36tw_changes_keeps_only_the_three_keys", () => {
    const { journal } = run(START, {
      type: "agent_completed",
      node: "a",
      attempt: 1,
      // an object with more in it than a reference has: the rest is not journaled
      changes: { ...ref, extra: "AKIAIOSFODNN7EXAMPLE" } as ChangesRef,
    });
    const done = journal.find((r) => r.event === "agent_completed");
    expect(done?.changes).toEqual(ref);
    expect(JSON.stringify(done)).not.toContain("AKIA");
  });
});

describe("the events", () => {
  test("t36tw_event_fields: a hand-in journals its patch, its error and its tree", () => {
    const { journal } = run(START, {
      type: "agent_completed",
      node: "a",
      attempt: 1,
      changes: ref,
      tree: TREE,
    });
    const done = journal.find((r) => r.event === "agent_completed");
    expect(done?.changes).toEqual(ref);
    expect(done?.tree).toBe(TREE);
    expect(done?.changes_error).toBeUndefined();
    const failed = run(START, {
      type: "agent_completed",
      node: "a",
      attempt: 1,
      changesError: "x".repeat(500),
    }).journal.find((r) => r.event === "agent_completed");
    expect(String(failed?.changes_error)).toHaveLength(200);
  });

  test("t36tw_core_drops_invalid_changes_and_tree_and_still_accepts_the_hand_in", () => {
    const { results, journal } = run(START, {
      type: "agent_completed",
      node: "a",
      attempt: 1,
      changes: { ref: "changes/../x", bytes: 1, truncated: false },
      tree: "--output=/tmp/x",
    });
    expect(results[1]?.ok).toBe(true); // a patch is a record, never a verdict
    const done = journal.find((r) => r.event === "agent_completed");
    expect(done?.changes).toBeUndefined();
    expect(done?.tree).toBeUndefined();
  });

  test("t36tw_changes_recorded_is_accepted_on_a_finished_run_and_others_are_not", () => {
    const { results, journal } = run(
      START,
      { type: "agent_completed", node: "a", attempt: 1 },
      { type: "changes_recorded", changes: { ...ref, ref: "changes/run.patch" } },
      { type: "changes_recorded", changesError: "no start" },
      { type: "agent_completed", node: "a", attempt: 1 },
    );
    expect(results[1]?.ok).toBe(true);
    expect(results.at(-3)?.ok).toBe(true);
    expect(results.at(-2)?.ok).toBe(true);
    const recorded = journal.filter((r) => r.event === "changes_recorded");
    expect(recorded.map((r) => (r.changes as ChangesRef | undefined)?.ref)).toEqual([
      "changes/run.patch",
      undefined,
    ]);
    expect(recorded[1]?.changes_error).toBe("no start");
    // A hand-in on a run that has ended is still refused or a repeat, as before.
    const last = results.at(-1);
    expect(last?.ok && last.noop ? true : last?.ok === false).toBe(true);
  });

  test("t36tw_changes_recorded_drops_a_bad_ref", () => {
    const { journal } = run(START, {
      type: "changes_recorded",
      changes: { ref: "/abs", bytes: 1, truncated: false },
    });
    expect(journal.find((r) => r.event === "changes_recorded")?.changes).toBeUndefined();
  });
});

describe("the core stays free of I/O", () => {
  test("t36tw_core_stays_pure", () => {
    const dir = new URL("../src/", import.meta.url);
    const bad =
      /from\s+["'](node:(fs|child_process|os|net|http|https)(\/promises)?|fs|child_process)["']/;
    const walk = (d: URL): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(new URL(`${e.name}/`, d)) : [new URL(e.name, d).pathname],
      );
    for (const file of walk(dir).filter((f) => f.endsWith(".ts"))) {
      expect({ file, imports: bad.test(readFileSync(file, "utf8")) }).toEqual({
        file,
        imports: false,
      });
    }
  });
});
