import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type JournalRecord, type RunState, summarizeRun } from "../src";

const V1 = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "formats",
  "v1",
);

const load = (id: string) => ({
  state: JSON.parse(readFileSync(join(V1, id, "state.json"), "utf8")) as RunState,
  journal: readFileSync(join(V1, id, "journal.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as JournalRecord),
});

test("formats_summarize_run_reads_the_v1_journals", () => {
  const accepted = load("r_0mvimyn54_tc9o");
  const report = summarizeRun(accepted.state, accepted.journal);
  expect(report.status).toBe("completed");
  expect(report.nodes.map((n) => [n.node, n.gate, n.attempts.length])).toEqual([
    ["plan", false, 2],
    ["plan-approval", true, 2],
    ["impl", false, 2],
    ["verify", false, 2],
    ["test", false, 2],
    ["build", false, 2],
    ["review", false, 2],
    ["final-approval", true, 1],
  ]);
  expect([report.extra_attempts, report.restarts, report.pauses, report.feedback]).toEqual([
    7, 0, 0, 0,
  ]);

  const feedback = load("r_0mviewgvl_i1ig");
  const second = summarizeRun(feedback.state, feedback.journal);
  expect(second.status).toBe("completed");
  expect([second.extra_attempts, second.restarts, second.pauses, second.feedback]).toEqual([
    9, 0, 0, 1,
  ]);
  expect(second.nodes.find((n) => n.node === "final-approval")?.attempts.length).toBe(2);
});
