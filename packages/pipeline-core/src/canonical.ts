/**
 * The canonical form of a pipeline, for comparing two versions of it: what a node does, what checks
 * it, and where it goes next, with keys in a fixed order. Names, descriptions and the
 * `expected_duration` hint are not in it, and neither are comments or the layout of the YAML, so
 * two files that mean the same thing have the same form.
 *
 * The forms are text, not hashes: hashing needs `node:crypto`, which the core does not import. The
 * host hashes them (see `EngineOptions.fingerprint`).
 */
import { type NodeSpec, type PipelineSpec, parsePipeline } from "./pipeline";

/** JSON with the keys of every object sorted, so the same value always gives the same text. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}

export interface NodeForms {
  /** What the node does: kind, parameters, timeout, what a failure of the node itself is called. */
  work: string;
  /** What is checked after the work. */
  checks: string;
  /** Where the node goes next, and how many attempts it gets. Changing it never redoes work. */
  routing: string;
}

const workOf = (node: NodeSpec) => ({
  kind: node.kind,
  params: node.params,
  timeout: node.timeout ?? null,
  on_fail: node.on_fail,
});

const routingOf = (spec: PipelineSpec, node: NodeSpec) => ({
  edges: spec.edges
    .filter((e) => e.from === node.slug)
    .map((e) => ({ when: e.when, to: e.to }))
    .sort((a, b) => (a.when + a.to < b.when + b.to ? -1 : 1)),
  max_attempts: node.max_attempts,
  max_consecutive_failures: node.max_consecutive_failures,
});

export function canonicalNode(spec: PipelineSpec, node: NodeSpec): NodeForms {
  return {
    work: stableJson(workOf(node)),
    checks: stableJson(node.checks),
    routing: stableJson(routingOf(spec, node)),
  };
}

/** The whole pipeline, in the same terms. Two pipelines with the same form behave the same. */
export function canonicalPipeline(spec: PipelineSpec): string {
  return stableJson({
    name: spec.name,
    entry: spec.entry,
    nodes: spec.nodes.map((node) => ({
      slug: node.slug,
      work: workOf(node),
      checks: node.checks,
      routing: routingOf(spec, node),
    })),
  });
}

/**
 * Read a pipeline kept with a run. It is the one door for that, so that when the user-file format
 * changes, a reader for the old format can be put here and a rule that tightened for new files does
 * not make an old run unreadable. An unknown `version` is said as such ("written in format X"), not
 * as a modified file.
 */
export function parseSnapshot(source: string): PipelineSpec {
  return parsePipeline(source);
}
