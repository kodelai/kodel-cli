import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  checkIdOf,
  decide,
  defaultRegistry,
  type Effect,
  type EngineOptions,
  type JournalRecord,
  type PipelineSpec,
  parsePipeline,
  type RunEvent,
  type RunState,
} from "../src";

const pipeline = (checks: string[], extra = ""): PipelineSpec =>
  parsePipeline(
    [
      "name: demo",
      "nodes:",
      "  - slug: write",
      "    kind: agent",
      "    prompt: write",
      "    checks:",
      ...checks.map((c) => `      - ${c}`),
      "  - slug: other",
      "    kind: agent",
      "    prompt: other",
      "    checks:",
      "      - { kind: diff, paths: ['src/**'] }",
      "edges:",
      "  - { from: write, to: other }",
      extra,
    ].join("\n"),
  );

const fp: EngineOptions = { fingerprint: (text) => `h(${text})` };
const START: RunEvent = { type: "start", runId: "r1", task: "t", specHash: "h" };

/** Runs the pipeline; every check answers with `passed(attempt, index)`. */
function drive(
  spec: PipelineSpec,
  passed: (attempt: number, index: number) => boolean,
  options: EngineOptions = fp,
) {
  let state: RunState | undefined;
  const journal: JournalRecord[] = [];
  const queue: RunEvent[] = [START];
  while (queue.length > 0) {
    const result = decide(spec, state, queue.shift() as RunEvent, 0, options);
    if (!result.ok) throw result.error;
    state = result.state;
    journal.push(...result.journal);
    for (const effect of result.effects as Effect[]) {
      if (effect.type === "need_agent") {
        queue.push({ type: "agent_completed", node: effect.node, attempt: effect.attempt });
      } else if (effect.type === "run_check") {
        queue.push({
          type: "check_finished",
          node: effect.node,
          attempt: effect.attempt,
          index: effect.index,
          passed: passed(effect.attempt, effect.index),
          reason: "no",
        });
      }
    }
  }
  return { state: state as RunState, journal };
}

const finished = (journal: JournalRecord[], node = "write") =>
  journal.filter((j) => j.event === "check_finished" && j.node === node);

describe("hp9r check ids", () => {
  const diff = (p: string) => `{ kind: diff, paths: ['${p}'] }`;

  test("hp9r_check_id_counts_per_kind", () => {
    const spec = pipeline([
      diff("a/**"),
      "{ kind: diff, paths: ['b/**'], mode: unchanged }",
      diff("c/**"),
    ]);
    const node = spec.nodes[0];
    if (!node) throw new Error("no node");
    expect([0, 1, 2].map((i) => checkIdOf(node, i))).toEqual([
      "write/diff#1",
      "write/diff#2",
      "write/diff#3",
    ]);
    expect(checkIdOf(node, 3)).toBeUndefined();
  });

  test("hp9r_check_id_a_single_check_and_a_node_without_checks", () => {
    const spec = pipeline([diff("a/**")]);
    expect(spec.nodes[0] && checkIdOf(spec.nodes[0], 0)).toBe("write/diff#1");
    const bare = parsePipeline("name: d\nnodes:\n  - { slug: x, kind: agent, prompt: p }\n");
    expect(bare.nodes[0] && checkIdOf(bare.nodes[0], 0)).toBeUndefined();
    const { journal } = drive(bare, () => true);
    expect(journal.filter((j) => j.event === "check_finished")).toEqual([]);
  });

  test("hp9r_check_id_is_stable_when_params_change", () => {
    const a = pipeline([diff("a/**")]).nodes[0];
    const b = pipeline([diff("other/**")]).nodes[0];
    if (!a || !b) throw new Error("no node");
    expect(checkIdOf(a, 0)).toBe(checkIdOf(b, 0));
  });

  test("hp9r_check_id_shifts_when_a_same_kind_check_before_it_is_removed", () => {
    const three = pipeline([diff("a/**"), diff("b/**"), diff("c/**")]).nodes[0];
    const two = pipeline([diff("a/**"), diff("c/**")]).nodes[0];
    if (!three || !two) throw new Error("no node");
    expect(checkIdOf(three, 2)).toBe("write/diff#3");
    expect(checkIdOf(two, 1)).toBe("write/diff#2");
  });

  test("hp9r_check_id_differs_by_node", () => {
    const spec = pipeline([diff("a/**")]);
    const [first, second] = spec.nodes;
    if (!first || !second) throw new Error("no node");
    expect(checkIdOf(first, 0)).toBe("write/diff#1");
    expect(checkIdOf(second, 0)).toBe("other/diff#1");
  });
});

describe("hp9r journal", () => {
  const spec = pipeline(["{ kind: diff, paths: ['a/**'] }"]);

  test("hp9r_journal_has_check_id_and_params_hash", () => {
    const { journal } = drive(spec, () => true);
    const [record] = finished(journal);
    expect(record).toMatchObject({ kind: "diff", check_id: "write/diff#1", passed: true });
    expect(typeof record?.params_hash).toBe("string");
    expect(finished(journal, "other")[0]).toMatchObject({ check_id: "other/diff#1" });
  });

  test("hp9r_params_hash_ignores_key_order_and_comments", () => {
    const a = pipeline(["{ kind: diff, paths: ['a/**'], max_lines: 5 }"]);
    const b = pipeline(["{ max_lines: 5, paths: ['a/**'], kind: diff } # a comment"]);
    const hashOf = (s: PipelineSpec) => finished(drive(s, () => true).journal)[0]?.params_hash;
    expect(hashOf(a)).toBeDefined();
    expect(hashOf(a)).toBe(hashOf(b));
  });

  test("hp9r_params_hash_changes_with_any_param", () => {
    const hashOf = (check: string) =>
      finished(drive(pipeline([check]), () => true).journal)[0]?.params_hash;
    const base = hashOf("{ kind: diff, paths: ['a/**'] }");
    expect(hashOf("{ kind: diff, paths: ['b/**'] }")).not.toBe(base);
    expect(hashOf("{ kind: diff, paths: ['a/**'], max_lines: 1 }")).not.toBe(base);
    expect(hashOf("{ kind: diff, paths: ['а/**'] }")).not.toBe(base);
  });

  test("hp9r_params_hash_is_absent_without_a_fingerprint_but_check_id_stays", () => {
    const { journal } = drive(spec, () => true, {});
    const [record] = finished(journal);
    expect(record?.check_id).toBe("write/diff#1");
    expect(record && "params_hash" in record).toBe(false);
  });

  test("hp9r_rework_keeps_the_check_id_and_the_failure_names_it", () => {
    const { journal, state } = drive(spec, (attempt) => attempt > 1);
    const ids = finished(journal).map((j) => j.check_id);
    expect(ids).toEqual(["write/diff#1", "write/diff#1"]);
    expect(finished(journal).map((j) => j.attempt)).toEqual([1, 2]);
    // The node passed on the second attempt, so the failure is gone.
    expect(state.nodes.write?.lastFailure).toBeUndefined();
  });

  test("hp9r_last_failure_keeps_check_id", () => {
    const { state } = drive(spec, () => false);
    expect(state.nodes.write?.lastFailure).toMatchObject({
      source: "check:diff",
      check_id: "write/diff#1",
    });
  });

  test("hp9r_fail_then_changed_then_pass_reads_as_one_chain", () => {
    const before = pipeline(["{ kind: diff, paths: ['a/**'] }"]);
    const after = pipeline(["{ kind: diff, paths: ['a/**', 'b/**'] }"]);
    const journal: JournalRecord[] = [];
    const run = (spec: PipelineSpec, state: RunState | undefined, event: RunEvent) => {
      const result = decide(spec, state, event, 0, fp);
      if (!result.ok) throw result.error;
      journal.push(...result.journal);
      return result;
    };
    let state = run(before, undefined, START).state;
    state = run(before, state, { type: "agent_completed", node: "write", attempt: 1 }).state;
    state = run(before, state, {
      type: "check_finished",
      node: "write",
      attempt: 1,
      index: 0,
      passed: false,
      reason: "no",
    }).state;
    expect(state.nodes.write).toMatchObject({ attempt: 2, status: "rework" });
    state = run(after, state, {
      type: "pipeline_accepted",
      from: state.specHash,
      to: "h2",
      source: "file",
      before,
    }).state;
    // the change of the check keeps the failure, and with it the id of the check that failed
    expect(state.nodes.write?.lastFailure?.check_id).toBe("write/diff#1");
    state = run(after, state, { type: "agent_completed", node: "write", attempt: 2 }).state;
    run(after, state, {
      type: "check_finished",
      node: "write",
      attempt: 2,
      index: 0,
      passed: true,
      reason: "",
    });
    const [failed, passed] = finished(journal);
    expect(failed).toMatchObject({ attempt: 1, passed: false, check_id: "write/diff#1" });
    expect(passed).toMatchObject({ attempt: 2, passed: true, check_id: "write/diff#1" });
    expect(failed?.params_hash).not.toBe(passed?.params_hash);
  });
});

describe("hp9r more cases", () => {
  const extra = defaultRegistry().registerCheck({
    kind: "extra",
    shape: { a: z.unknown().optional() },
  });
  const withExtra = (checks: string[]) =>
    parsePipeline(
      [
        "name: demo",
        "nodes:",
        "  - slug: write",
        "    kind: agent",
        "    prompt: write",
        "    checks:",
        ...checks.map((c) => `      - ${c}`),
        "",
      ].join("\n"),
      { registry: extra },
    );

  test("hp9r_check_id_counts_each_kind_from_one", () => {
    const node = withExtra([
      "{ kind: diff, paths: ['a'] }",
      "{ kind: extra }",
      "{ kind: diff, paths: ['b'] }",
      "{ kind: extra }",
    ]).nodes[0];
    if (!node) throw new Error("no node");
    expect([0, 1, 2, 3].map((i) => checkIdOf(node, i))).toEqual([
      "write/diff#1",
      "write/extra#1",
      "write/diff#2",
      "write/extra#2",
    ]);
  });

  test("hp9r_a_kind_the_registry_does_not_know_still_gets_an_id", () => {
    const spec = withExtra(["{ kind: extra }"]);
    // the engine runs with the default registry, which has never heard of "extra"
    const { journal } = drive(spec, () => true);
    expect(finished(journal)[0]).toMatchObject({ kind: "extra", check_id: "write/extra#1" });
  });

  test("hp9r_params_hash_follows_nested_values_null_unicode_and_size", () => {
    const hashOf = (params: string) =>
      finished(drive(withExtra([`{ kind: extra, ${params} }`]), () => true).journal)[0]
        ?.params_hash;
    const hashes = [
      hashOf("a: { b: [1, 2, { c: 3 }] }"),
      hashOf("a: { b: [1, 2, { c: 4 }] }"),
      hashOf("a: null"),
      hashOf("a: ''"),
      hashOf("a: 'ключ'"),
      hashOf(`a: '${"x".repeat(200_000)}'`),
    ];
    for (const h of hashes) expect(typeof h).toBe("string");
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(hashOf("a: { z: 1, b: 2 }")).toBe(hashOf("a: { b: 2, z: 1 }"));
  });

  test("hp9r_an_attempt_that_fails_and_one_that_passes_have_the_same_id", () => {
    const spec = pipeline(["{ kind: diff, paths: ['a/**'] }", "{ kind: diff, paths: ['b/**'] }"]);
    const { journal } = drive(spec, (attempt) => attempt > 1);
    const rows = finished(journal).map((j) => [j.attempt, j.index, j.check_id, j.passed]);
    expect(rows).toEqual([
      [1, 0, "write/diff#1", false],
      [2, 0, "write/diff#1", true],
      [2, 1, "write/diff#2", true],
    ]);
  });
});
