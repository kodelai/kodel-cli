import { describe, expect, test } from "bun:test";
import {
  canonicalNode,
  canonicalPipeline,
  KodelError,
  type NodeSpec,
  parsePipeline,
  parseSnapshot,
  stableJson,
} from "../src";

const BASE = [
  "name: demo # a comment",
  "description: one",
  "nodes:",
  "  - slug: write",
  "    name: Write it",
  "    kind: agent",
  "    prompt: write",
  "    expected_duration: 60",
  "    checks:",
  "      - kind: diff",
  "        paths: ['src/**']",
  "        max_lines: 800",
  "  - slug: verify",
  "    kind: command",
  "    command: bun test",
  "edges:",
  "  - { from: write, to: verify }",
  "  - { from: verify, to: write, when: failed }",
  "",
].join("\n");

const forms = (text: string, slug: string) => {
  const spec = parsePipeline(text);
  const node = spec.nodes.find((n) => n.slug === slug) as NodeSpec;
  return canonicalNode(spec, node);
};

describe("the canonical form of a pipeline", () => {
  test("stable_json_ignores_key_order", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe(
      stableJson({ a: { c: [{ x: 2, y: 1 }], d: 2 }, b: 1 }),
    );
  });

  test("canonical_pipeline_ignores_comments_names_hints_and_layout", () => {
    const other = BASE.replace("name: demo # a comment", "name: demo")
      .replace("description: one", "description: two")
      .replace("name: Write it", "name: Something else")
      .replace("expected_duration: 60", "expected_duration: 5")
      .replace("  - { from: write, to: verify }\n", "\n  - {from: write,   to: verify}\n");
    expect(canonicalPipeline(parsePipeline(other))).toBe(canonicalPipeline(parsePipeline(BASE)));
  });

  test("a_changed_limit_is_a_change_of_checks_only", () => {
    const before = forms(BASE, "write");
    const after = forms(BASE.replace("max_lines: 800", "max_lines: 1200"), "write");
    expect(after.checks).not.toBe(before.checks);
    expect(after.work).toBe(before.work);
    expect(after.routing).toBe(before.routing);
  });

  test("a_changed_prompt_is_a_change_of_work_only", () => {
    const before = forms(BASE, "write");
    const after = forms(BASE.replace("prompt: write", "prompt: write it well"), "write");
    expect(after.work).not.toBe(before.work);
    expect(after.checks).toBe(before.checks);
    expect(after.routing).toBe(before.routing);
  });

  test("a_changed_edge_is_a_change_of_routing_of_its_source_node_only", () => {
    const three = BASE.replace(
      "edges:",
      ["  - slug: lint", "    kind: command", "    command: bun lint", "edges:"].join("\n"),
    ).replace(
      "  - { from: write, to: verify }\n",
      "  - { from: write, to: verify }\n  - { from: lint, to: write, when: failed }\n  - { from: verify, to: lint }\n",
    );
    const changed = three.replace(
      "{ from: lint, to: write, when: failed }",
      "{ from: lint, to: verify, when: failed }",
    );
    expect(forms(changed, "lint").routing).not.toBe(forms(three, "lint").routing);
    expect(forms(changed, "lint").work).toBe(forms(three, "lint").work);
    expect(forms(changed, "write")).toEqual(forms(three, "write"));
    expect(forms(changed, "verify")).toEqual(forms(three, "verify"));
  });

  test("a_changed_attempt_budget_is_routing_not_work", () => {
    const changed = BASE.replace("    prompt: write\n", "    prompt: write\n    max_attempts: 9\n");
    expect(forms(changed, "write").routing).not.toBe(forms(BASE, "write").routing);
    expect(forms(changed, "write").work).toBe(forms(BASE, "write").work);
  });

  test("a_snapshot_with_an_unknown_format_is_unsupported_not_invalid", () => {
    expect(() => parseSnapshot(BASE.replace("name: demo", "version: 99\nname: demo"))).toThrow(
      KodelError,
    );
    try {
      parseSnapshot(BASE.replace("name: demo", "version: 99\nname: demo"));
    } catch (error) {
      expect((error as KodelError).code).toBe("UNSUPPORTED_FORMAT");
    }
  });
});
