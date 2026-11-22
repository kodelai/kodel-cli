/**
 * The rules of task links (`depends_on`, `conflicts_with`) that do not depend on the tracker (T-45).
 * Pure: every adapter that declares `capabilities.links` uses these, so the rules exist once.
 *
 * Every walk here is iterative and visits a task once: the graph comes from files or a tracker and
 * may be thousands of tasks that name each other.
 */
import type { DependencyRef, DependencyState, TaskPatch } from "../tasks";

export interface LinkLists {
  depends_on: string[];
  conflicts_with: string[];
}

/** The part of a patch that changes links; the keys are already resolved. */
export type LinkPatch = Pick<
  TaskPatch,
  | "depends_on"
  | "conflicts_with"
  | "add_depends_on"
  | "remove_depends_on"
  | "add_conflicts_with"
  | "remove_conflicts_with"
  | "clear"
>;

export function hasLinkPatch(patch: LinkPatch): boolean {
  return (
    patch.depends_on !== undefined ||
    patch.conflicts_with !== undefined ||
    patch.add_depends_on !== undefined ||
    patch.remove_depends_on !== undefined ||
    patch.add_conflicts_with !== undefined ||
    patch.remove_conflicts_with !== undefined ||
    (patch.clear ?? []).some((name) => name === "depends_on" || name === "conflicts_with")
  );
}

const unique = (keys: readonly string[]): string[] => [...new Set(keys)];

function applyOne(
  current: readonly string[],
  set: readonly string[] | undefined,
  add: readonly string[] | undefined,
  remove: readonly string[] | undefined,
  clear: boolean,
): string[] {
  if (clear) return [];
  if (set !== undefined) return unique(set);
  const gone = new Set(remove ?? []);
  return unique([...current.filter((key) => !gone.has(key)), ...(add ?? [])]);
}

/** The two lists after a patch: set, add, remove or clear; the order of the keys kept is kept. */
export function applyLinkPatch(current: LinkLists, patch: LinkPatch): LinkLists {
  const clear = patch.clear ?? [];
  return {
    depends_on: applyOne(
      current.depends_on,
      patch.depends_on,
      patch.add_depends_on,
      patch.remove_depends_on,
      clear.includes("depends_on"),
    ),
    conflicts_with: applyOne(
      current.conflicts_with,
      patch.conflicts_with,
      patch.add_conflicts_with,
      patch.remove_conflicts_with,
      clear.includes("conflicts_with"),
    ),
  };
}

/** What a tracker knows of one task that another depends on. */
export interface DependencyFact {
  /** The task is finished (`state: done`). */
  closed: boolean;
  /** It was closed without being done; the tracker says so, the core never reads a status name. */
  declined?: boolean;
  needs_approval?: boolean;
}

/** One ref per key; a key the lookup does not know is `missing`. */
export function dependencyRefs(
  keys: readonly string[],
  lookup: (key: string) => DependencyFact | undefined,
): DependencyRef[] {
  return keys.map((key) => {
    const fact = lookup(key);
    if (fact === undefined) return { key, state: "missing" };
    const state: DependencyState = !fact.closed
      ? "open"
      : fact.declined === true
        ? "declined"
        : "done";
    return fact.closed && fact.needs_approval === true
      ? { key, state, needs_approval: true }
      : { key, state };
  });
}

/**
 * The dependencies that hold a task back. Fail closed: a key with no entry in `dependencies` blocks
 * like a missing one. A closed dependency that waits for approval blocks unless approval is waived.
 */
export function blockedBy(
  task: { depends_on?: readonly string[]; dependencies?: readonly DependencyRef[] },
  approval: "required" | "any" = "required",
): string[] {
  const keys = task.depends_on ?? [];
  if (keys.length === 0) return [];
  const refs = new Map((task.dependencies ?? []).map((ref) => [ref.key, ref] as const));
  return keys.filter((key) => {
    const ref = refs.get(key);
    if (ref === undefined) return true;
    if (ref.state === "open" || ref.state === "missing") return true;
    if (ref.state !== "done" && ref.state !== "declined") return true;
    return ref.needs_approval === true && approval !== "any";
  });
}

/** Why one dependency holds back, in fixed words: `open`, `missing`, `done, waits for approval`. */
export function dependencyWords(ref: DependencyRef | undefined): string {
  if (ref === undefined) return "missing";
  return ref.needs_approval === true ? `${ref.state}, waits for approval` : ref.state;
}

/**
 * The cycle that starts and ends at `start` when its dependencies are `first`, as the keys in order
 * (`[A, B, A]`), or nothing. `dependsOn` gives the dependencies of every other task.
 */
export function findCycle(
  start: string,
  first: readonly string[],
  dependsOn: (key: string) => readonly string[] | undefined,
): string[] | undefined {
  if (first.includes(start)) return [start, start];
  const cameFrom = new Map<string, string>();
  const stack: string[] = [];
  for (const key of first) {
    if (cameFrom.has(key)) continue;
    cameFrom.set(key, start);
    stack.push(key);
  }
  while (stack.length > 0) {
    const at = stack.pop() as string;
    for (const next of dependsOn(at) ?? []) {
      if (next === start) {
        const path = [start];
        for (let back: string | undefined = at; back !== undefined && back !== start; ) {
          path.push(back);
          back = cameFrom.get(back);
        }
        path.push(start);
        // Collected from the end: turn it so it reads start -> ... -> start.
        return [start, ...path.slice(1, -1).reverse(), start];
      }
      if (cameFrom.has(next)) continue;
      cameFrom.set(next, at);
      stack.push(next);
    }
  }
  return undefined;
}

export const spellCycle = (cycle: readonly string[]): string => cycle.join(" -> ");

export interface LinkNode {
  key: string;
  depends_on?: readonly string[];
}

export interface LinkGraph {
  keys: string[];
  dependsOn: Map<string, string[]>;
  /** The reverse of `dependsOn`, only between tasks of the graph. */
  dependents: Map<string, string[]>;
}

export function buildGraph(tasks: readonly LinkNode[]): LinkGraph {
  const dependsOn = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) dependsOn.set(task.key, unique(task.depends_on ?? []));
  for (const [key, list] of dependsOn) {
    for (const dependency of list) {
      if (!dependsOn.has(dependency)) continue;
      const known = dependents.get(dependency);
      if (known) known.push(key);
      else dependents.set(dependency, [key]);
    }
  }
  return { keys: [...dependsOn.keys()], dependsOn, dependents };
}

/**
 * Every group of tasks that wait for each other, each sorted by key and the groups by their first
 * key. Tarjan's components without recursion; a task that depends on itself is a group of one.
 */
export function cycles(graph: LinkGraph, onVisit?: (key: string) => void): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let counter = 0;
  for (const root of graph.keys) {
    if (index.has(root)) continue;
    const work: { key: string; edge: number }[] = [{ key: root, edge: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1] as { key: string; edge: number };
      const { key } = frame;
      if (frame.edge === 0) {
        onVisit?.(key);
        index.set(key, counter);
        low.set(key, counter);
        counter += 1;
        stack.push(key);
        onStack.add(key);
      }
      const edges = graph.dependsOn.get(key) ?? [];
      let descended = false;
      while (frame.edge < edges.length) {
        const next = edges[frame.edge] as string;
        frame.edge += 1;
        if (!graph.dependsOn.has(next)) continue;
        if (!index.has(next)) {
          work.push({ key: next, edge: 0 });
          descended = true;
          break;
        }
        if (onStack.has(next)) {
          low.set(key, Math.min(low.get(key) as number, index.get(next) as number));
        }
      }
      if (descended) continue;
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.key, Math.min(low.get(parent.key) as number, low.get(key) as number));
      }
      if (low.get(key) !== index.get(key)) continue;
      const group: string[] = [];
      for (;;) {
        const member = stack.pop() as string;
        onStack.delete(member);
        group.push(member);
        if (member === key) break;
      }
      if (group.length > 1 || edges.includes(key)) found.push(group.sort());
    }
  }
  return found.sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));
}
