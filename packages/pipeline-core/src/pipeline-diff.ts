/**
 * What changing a run's pipeline means for the run: which nodes differ, whether the change may be
 * accepted now, and what the run does about it. Pure; the host and the machine both use it, so what
 * the person is shown is what the engine does.
 */
import { canonicalNode } from "./canonical";
import type { PipelineSpec } from "./pipeline";
import { type ForkState, type RunState, routeEntersBranch } from "./run";

export type NodeChange = "added" | "removed" | "work" | "checks" | "routing";

export interface NodeDiff {
  slug: string;
  changes: NodeChange[];
}

/** What the run does about one place it stands once the change is accepted. */
export type AcceptEffect =
  /** The attempt in progress is closed as superseded and the node starts again; its work stays. */
  | { kind: "restart"; node: string }
  /** The checks of the node run again on the work that is there. */
  | { kind: "recheck"; node: string }
  /**
   * The run (or a branch) was held back on a route from `node`; the route is taken again under the new
   * pipeline. `to` is where the held route was going and `branch` the branch it stands in: several
   * pauses may share `node` (a join's `restart_failed` into several branches), and the effect lifts
   * exactly one. Both are absent from effects journaled before they were recorded.
   */
  | { kind: "reroute"; node: string; to?: string; branch?: string };

export interface PipelineDiff {
  nodes: NodeDiff[];
  /** Why the change cannot be accepted, when it cannot. */
  refused?: string;
  /**
   * One per standing visit or pause the change touches, in the order of the visits, then of the
   * pauses. Empty: nothing is redone, the new definition is used the next time it is needed.
   */
  effects: AcceptEffect[];
}

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

/**
 * Where the run stands, as one string: every attempt in progress and every pause. A change is worked
 * out for this standing, and accepting it is refused once the standing differs (the run moved on
 * while the person read). Not a hash: the core has none, and the string is short.
 */
export function standingOf(state: RunState): string {
  const visits = state.active.map(
    (v) =>
      `${v.node}#${v.attempt}@${v.visitId}:${v.phase}${v.suspended ? "!" : ""}${v.phase === "checks" ? `/${v.checkIndex}` : ""}`,
  );
  const pauses = state.pauses.map(
    (p) => `pause:${p.node}:${p.reason}${p.blocked ? `:${p.blocked.from}>${p.blocked.to}` : ""}`,
  );
  return [...visits.sort(), ...pauses.sort()].join(" ");
}

/**
 * Whether a fork instance is still what the run is doing. It is left only when nothing of it stands
 * any more: every branch has arrived, no attempt or pause stands in a branch, and none stands at the
 * join. The join's attempt counts until it has been routed on: held back at a limit (a `total` pause
 * of the join, which carries the route into it; a `consecutive` pause of its own rework or of its way
 * out; a pause at a limit on a route the join failed by), a repair can still open it again and judge it anew, and `restart_failed` would then enter
 * the branches as the instance names them. The join is shared by every instance of a fork in a loop,
 * so what stands at it belongs to the latest instance.
 */
function isOpen(fork: ForkState, state: RunState): boolean {
  if (fork.branches.some((branch) => fork.arrived[branch] === undefined)) return true;
  if (state.active.some((v) => v.fork?.id === fork.id)) return true;
  if (state.pauses.some((p) => p.fork?.id === fork.id || p.blocked?.join === fork.id)) return true;
  const instances = Object.values(state.forks ?? {}).filter((f) => f.join === fork.join);
  if (instances.at(-1)?.id !== fork.id) return false;
  // A pause on a route out of the join stands at the join only when the join failed (its rework or
  // failure route, which a repair may reopen); a join that passed has been judged, and a pause at the
  // next node's limit is the run's, after the fork.
  const joinFailed = state.nodes[fork.join]?.status === "failed";
  return (
    state.active.some((v) => v.node === fork.join) ||
    state.pauses.some(
      (p) =>
        p.node === fork.join ||
        p.blocked?.to === fork.join ||
        (joinFailed && p.blocked?.from === fork.join),
    )
  );
}

/** Whether `slug` may be entered once more under `after`, given the attempts it has used. */
function limitLifted(after: PipelineSpec, state: RunState, slug: string): boolean {
  const node = after.nodes.find((n) => n.slug === slug);
  const run = state.nodes[slug];
  return (
    node !== undefined &&
    run !== undefined &&
    run.attempt + 1 <= node.max_attempts + run.extraAttempts
  );
}

/** The targets of the edges a fork fires on, in edge order. */
function forkTargets(spec: PipelineSpec, fork: ForkState): string[] {
  return spec.edges.filter((e) => e.from === fork.from && e.when === fork.label).map((e) => e.to);
}

export function diffPipelines(
  before: PipelineSpec,
  after: PipelineSpec,
  state: RunState,
): PipelineDiff {
  const nodes = diffNodes(before, after);
  const refuse = (refused: string): PipelineDiff => ({ nodes, refused, effects: [] });
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

  // Where the run stands: the nodes with an attempt in progress, and, where a branch is held back
  // at a failure, the node that failed and the one it was going to.
  const standing = state.active.map((v) => v.node);
  for (const visit of state.active) {
    if (changesOf(visit.node).includes("removed")) {
      return refuse(`node "${visit.node}" is where the run stands, so it cannot be removed`);
    }
  }
  for (const pause of state.pauses) {
    if (!pause.blocked) continue;
    const ahead = pause.blocked.heads ?? [pause.blocked.to];
    standing.push(pause.blocked.from, ...ahead);
    if (changesOf(pause.blocked.from).includes("removed")) {
      return refuse(
        `node "${pause.blocked.from}" is where the run is held back, so it cannot be removed`,
      );
    }
    for (const to of ahead) {
      if (changesOf(to).includes("removed")) {
        return refuse(
          `node "${to}" is the one a paused step is about to enter, so it cannot be removed`,
        );
      }
    }
  }

  // A node that has finished and cannot be reached again is part of what already happened. The
  // branches of an open fork are not: a branch that arrived failed can be run again from the join
  // (`restart_failed`), so its steps may still be repaired. The shape of the open fork itself
  // (which branches it has, where they meet) is what the run is doing right now and cannot change.
  const ahead = reachable(after, standing);
  for (const fork of Object.values(state.forks ?? {})) {
    if (!isOpen(fork, state)) continue;
    const was = forkTargets(before, fork);
    const now = forkTargets(after, fork);
    if (was.length !== now.length || was.some((to, i) => to !== now[i])) {
      return refuse(
        `the fork at "${fork.from}" is open (its branches have not all met at "${fork.join}" and gone on from there), so its edges cannot change now`,
      );
    }
    const joinBefore = before.nodes.find((n) => n.slug === fork.join)?.join;
    const joinAfter = after.nodes.find((n) => n.slug === fork.join)?.join;
    if (joinBefore !== joinAfter) {
      return refuse(
        `node "${fork.join}" is the join of an open fork, so its \`join\` cannot change now`,
      );
    }
    for (const slug of reachable(after, fork.branches)) {
      if (slug !== fork.join) ahead.add(slug);
    }
  }
  for (const { slug, changes } of nodes) {
    if (changes.includes("added") || changes.includes("removed")) continue;
    const run = state.nodes[slug];
    if (!run || run.attempt === 0 || ahead.has(slug)) continue;
    return refuse(
      `node "${slug}" has already finished and the run does not come back to it, so its ${changes.join(" and ")} cannot change now (re-run the steps from it instead)`,
    );
  }

  const effects: AcceptEffect[] = [];
  for (const visit of state.active) {
    const changes = changesOf(visit.node);
    const touched = changes.includes("work") || changes.includes("checks");
    if (visit.suspended) {
      if (changes.includes("work")) effects.push({ kind: "restart", node: visit.node });
      else if (changes.includes("checks") && visit.phase === "checks") {
        effects.push({ kind: "recheck", node: visit.node });
      }
      continue;
    }
    if (touched && (visit.phase === "engine" || visit.phase === "checks")) {
      return refuse(
        `node "${visit.node}" is running a command or a check; wait until it ends, then change the pipeline`,
      );
    }
    if (changes.includes("work")) effects.push({ kind: "restart", node: visit.node });
  }

  for (const pause of state.pauses) {
    const blocked = pause.blocked;
    if (!blocked) continue;
    const failure = state.nodes[blocked.from]?.lastFailure;
    const from = changesOf(blocked.from);
    const ahead = blocked.heads ?? [blocked.to];
    // A head held back at the fork's own edge is not rechecked: the fork fired on that verdict and
    // its other branches are going; the route into the head is taken again instead.
    if (
      from.includes("checks") &&
      failure?.source.startsWith("check:") &&
      !routeEntersBranch(state, blocked)
    ) {
      effects.push({ kind: "recheck", node: blocked.from });
      continue;
    }
    // A route into the join, or into a head from outside its branch, is taken as it is when the run
    // goes on (`applyEffect`), so it enters its node only once that node's attempt limit lets it: a
    // change that leaves the limit where it is leaves the pause where it is, and says nothing.
    const takenAsIs = blocked.join !== undefined || routeEntersBranch(state, blocked);
    if (takenAsIs && pause.reason === "total" && !limitLifted(after, state, blocked.to)) continue;
    if (from.length > 0 || ahead.some((to) => changesOf(to).length > 0)) {
      effects.push({
        kind: "reroute",
        node: blocked.from,
        to: blocked.to,
        ...(blocked.fork === undefined ? {} : { branch: blocked.fork.branch }),
      });
    }
  }
  return { nodes, effects };
}

function describeEffect(effect: AcceptEffect): string {
  switch (effect.kind) {
    case "restart":
      return `step "${effect.node}" starts again on its new definition (a new attempt; the work already done stays in the working directory)`;
    case "recheck":
      return `the checks of step "${effect.node}" run again on the work that is there; the work is not redone`;
    case "reroute": {
      const who = effect.branch === undefined ? "the run" : `branch "${effect.branch}"`;
      const held =
        effect.to === undefined || effect.to === effect.node
          ? ""
          : `, where it was held back on its way to step "${effect.to}",`;
      return `${who} goes on from step "${effect.node}"${held} under the new pipeline`;
    }
  }
}

/** What the run will do about a change, in words for a person; one line per effect. */
export function describeEffects(effects: AcceptEffect[]): string[] {
  return effects.map(describeEffect);
}
