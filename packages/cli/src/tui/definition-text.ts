/** A step of a pipeline as lines of text, so that two versions of it can be read, and compared, line by line. */
import type { NodeForms, NodeSpec, PipelineSpec } from "@kodel-ai/pipeline-core";

/** What the step is told or runs comes first. */
const FIRST = ["prompt", "instructions", "command"];

function value(v: unknown): string[] {
  if (typeof v === "string") return v.replace(/\s+$/, "").split("\n");
  return [JSON.stringify(v) ?? ""];
}

/** A key and its value; a text of several lines goes below the key, indented. */
function entry(key: string, v: unknown, indent: string): string[] {
  const lines = value(v);
  if (lines.length === 1) return [`${indent}${key}: ${lines[0]}`];
  return [`${indent}${key}:`, ...lines.map((l) => (l === "" ? "" : `${indent}  ${l}`))];
}

export function describeNode(spec: PipelineSpec, node: NodeSpec): string[] {
  const out: string[] = [`kind: ${node.kind}`];
  if (node.timeout !== undefined) out.push(`timeout: ${node.timeout}s`);
  out.push(`attempts: ${node.max_attempts}, ${node.max_consecutive_failures} failures in a row`);
  out.push(`on_fail: ${node.on_fail}`);
  const keys = Object.keys(node.params).sort((a, b) => {
    const rank = (k: string) => (FIRST.indexOf(k) === -1 ? FIRST.length : FIRST.indexOf(k));
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  for (const key of keys) out.push(...entry(key, node.params[key], ""));
  for (const check of node.checks) {
    out.push(
      `check: ${check.kind}${check.on_fail === node.on_fail ? "" : ` (on_fail ${check.on_fail})`}`,
    );
    for (const key of Object.keys(check.params).sort()) {
      out.push(...entry(key, check.params[key], "  "));
    }
  }
  for (const edge of spec.edges.filter((e) => e.from === node.slug)) {
    out.push(`→ ${edge.to}${edge.when === "passed" ? "" : `  when ${edge.when}`}`);
  }
  return out;
}

/** The key a definition is kept under: the step and the three fingerprints an attempt carries. */
export const definitionKey = (node: string, d: NodeForms): string =>
  `${node}|${d.work}|${d.checks}|${d.routing}`;
