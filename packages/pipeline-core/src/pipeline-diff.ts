/**
 * What changing a run's pipeline means for the run: which nodes differ, whether the change may be
 * accepted now, and what the run does about it. Pure; the host and the machine both use it, so what
 * the person is shown is what the engine does.
 */
import { canonicalNode } from "./canonical";
import type { PipelineSpec } from "./pipeline";
import type { RunState } from "./run";

export type NodeChange = "added" | "removed" | "work" | "checks" | "routing";

export interface NodeDiff {
  slug: string;
  changes: NodeChange[];
}

/** What the run does once the change is accepted. */
export type AcceptEffect =
  /** Nothing is redone: the new definition is used the next time it is needed. */
  | { kind: "none" }
  /** The attempt in progress is closed as superseded and the node starts again; its work stays. */
  | { kind: "restart"; node: string }
  /** The checks of the node run again on the work that is there. */
  | { kind: "recheck"; node: string }
  /** The run was held back at a node's failure; the way on is worked out again from the new pipeline. */
  | { kind: "reroute"; node: string };

export interface PipelineDiff {
  nodes: NodeDiff[];
  /** Why the change cannot be accepted, when it cannot. */
  refused?: string;
  effect: AcceptEffect;
}

const NONE: AcceptEffect = { kind: "none" };

/** The nodes that can be reached from `from` along the edges of `spec`, `from` included. */
function reachable(spec: PipelineSpec, from: string[]): Set<string> {
  const seen = new Set<string>(from);
  const queue = [...from];
  for (let slug = queue.pop(); slug !== undefined; slug = queue.pop()) {
    for (const edge of spec.edges) {
      if (edge.from === slug && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return seen;
}

/** What differs per node between two versions of a pipeline. */
export function diffNodes(before: PipelineSpec, after: PipelineSpec): NodeDiff[] {
  const out: NodeDiff[] = [];
  const old = new Map(before.nodes.map((n) => [n.slug, n]));
  for (const node of after.nodes) {
    const prev = old.get(node.slug);
    if (!prev) {
      out.push({ slug: node.slug, changes: ["added"] });
      continue;
    }
    const a = canonicalNode(before, prev);
    const b = canonicalNode(after, node);
    const changes: NodeChange[] = [];
    if (a.work !== b.work) changes.push("work");
    if (a.checks !== b.checks) changes.push("checks");
    if (a.routing !== b.routing) changes.push("routing");
    if (changes.length > 0) out.push({ slug: node.slug, changes });
  }
  const kept = new Set(after.nodes.map((n) => n.slug));
  for (const node of before.nodes) {
    if (!kept.has(node.slug)) out.push({ slug: node.slug, changes: ["removed"] });
  }
  return out;
}

export function diffPipelines(
  before: PipelineSpec,
  after: PipelineSpec,
  state: RunState,
): PipelineDiff {
  const nodes = diffNodes(before, after);
  const refuse = (refused: string): PipelineDiff => ({ nodes, refused, effect: NONE });
  const changesOf = (slug: string) => nodes.find((n) => n.slug === slug)?.changes ?? [];

  if (state.status !== "running" && state.status !== "paused") {
    return refuse(`the run is ${state.status}`);
  }
  if (before.name !== after.name) {
    return refuse(`the name of the pipeline cannot change (it is "${before.name}")`);
  }
  if (before.entry !== after.entry) {
    return refuse("the first node of the pipeline cannot change in a run that has started");
  }

  // Where the run stands: the nodes with an attempt in progress, or, when it is held back at a
  // failure, the node that failed and the one it was going to.
  const blocked = state.pause?.blocked;
  const standing = state.active.map((v) => v.node);
  if (standing.length === 0 && blocked) standing.push(blocked.from, blocked.to);
  for (const slug of standing) {
    if (changesOf(slug).includes("removed")) {
      return refuse(`node "${slug}" is where the run stands, so it cannot be removed`);
    }
  }

  // A node that has finished and cannot be reached again is part of what already happened.
  const ahead = reachable(after, standing);
  for (const { slug, changes } of nodes) {
    if (changes.includes("added") || changes.includes("removed")) continue;
    const run = state.nodes[slug];
    if (!run || run.attempt === 0 || ahead.has(slug)) continue;
    return refuse(
      `node "${slug}" has already finished and the run does not come back to it, so its ${changes.join(" and ")} cannot change now (re-run the steps from it instead)`,
    );
  }

  for (const visit of state.active) {
    const changes = changesOf(visit.node);
    const touched = changes.includes("work") || changes.includes("checks");
    if (visit.suspended) {
      if (changes.includes("work")) return { nodes, effect: { kind: "restart", node: visit.node } };
      if (changes.includes("checks") && visit.phase === "checks") {
        return { nodes, effect: { kind: "recheck", node: visit.node } };
      }
      return { nodes, effect: NONE };
    }
    if (touched && (visit.phase === "engine" || visit.phase === "checks")) {
      return refuse(
        `node "${visit.node}" is running a command or a check; wait until it ends, then change the pipeline`,
      );
    }
    if (changes.includes("work")) return { nodes, effect: { kind: "restart", node: visit.node } };
    return { nodes, effect: NONE };
  }

  if (blocked) {
    const failure = state.nodes[blocked.from]?.lastFailure;
    const from = changesOf(blocked.from);
    if (from.includes("checks") && failure?.source.startsWith("check:")) {
      return { nodes, effect: { kind: "recheck", node: blocked.from } };
    }
    if (from.length > 0 || changesOf(blocked.to).length > 0) {
      return { nodes, effect: { kind: "reroute", node: blocked.from } };
    }
  }
  return { nodes, effect: NONE };
}

/** What the run will do about a change, in words for a person. */
export function describeEffect(effect: AcceptEffect): string[] {
  switch (effect.kind) {
    case "none":
      return [];
    case "restart":
      return [
        `step "${effect.node}" starts again on its new definition (a new attempt; the work already done stays in the working directory)`,
      ];
    case "recheck":
      return [
        `the checks of step "${effect.node}" run again on the work that is there; the work is not redone`,
      ];
    case "reroute":
      return [
        `the run goes on from the failure of step "${effect.node}", with the way on worked out again from the new pipeline`,
      ];
  }
}
