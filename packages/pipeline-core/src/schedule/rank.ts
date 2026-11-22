/**
 * The base order of the tasks `kodel serve` may start (T-46). Pure, and a function of the tasks
 * alone: two daemons that read the same tasks plan the same order, whatever order they read them in.
 *
 * The sort key is (effective priority, how many tasks it unblocks, `created_at`, key). A task's
 * priority is raised to the highest priority of any open task that waits for it, through any number
 * of steps. A task that waits for a person's approval raises nothing and unblocks nothing, and
 * nothing is raised through it: a task an agent made cannot reorder the person's.
 */
import type { TaskState } from "../tasks";

export interface RankTask {
  key: string;
  state: TaskState;
  priority?: string;
  needs_approval?: boolean;
  depends_on?: readonly string[];
  /** Compared as text, never parsed: the order is the same on every machine. */
  created_at?: string;
  /** The task's place in the tracker's list; it orders the tasks that have no `created_at`. */
  order?: number;
}

export interface Rank {
  /** The place in the order of every task given, from 0. */
  place: number;
  /** The index of the effective priority in the tracker's list; its length for none. */
  effective: number;
  /** The task whose priority this one was raised to. */
  raisedBy?: string;
  /** Open tasks that wait for this one, directly or through others. */
  unblocks: number;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function priorityIndex(priorities: readonly string[], priority: string | undefined): number {
  const i = priority === undefined ? -1 : priorities.indexOf(priority);
  return i < 0 ? priorities.length : i;
}

export function rank(tasks: readonly RankTask[], priorities: readonly string[]): Map<string, Rank> {
  const byKey = new Map<string, RankTask>();
  for (const task of tasks) if (!byKey.has(task.key)) byKey.set(task.key, task);
  const own = new Map<string, number>();
  for (const task of byKey.values()) own.set(task.key, priorityIndex(priorities, task.priority));
  const counts = (task: RankTask): boolean => task.state !== "done" && task.needs_approval !== true;
  const dependenciesOf = (task: RankTask): RankTask[] =>
    [...new Set(task.depends_on ?? [])].sort(byText).flatMap((key) => {
      const found = byKey.get(key);
      return found === undefined || found.key === task.key ? [] : [found];
    });

  // The most urgent sources first, so the first priority that reaches a task is the highest one:
  // every task is expanded once, and a cycle ends where it meets a task already expanded.
  const sources = [...byKey.values()]
    .filter(counts)
    .sort(
      (a, b) => (own.get(a.key) as number) - (own.get(b.key) as number) || byText(a.key, b.key),
    );
  const raised = new Map<string, { to: number; by: string }>();
  const expanded = new Set<string>();
  for (const source of sources) {
    if (expanded.has(source.key)) continue;
    const to = own.get(source.key) as number;
    expanded.add(source.key);
    const stack = [source];
    while (stack.length > 0) {
      const at = stack.pop() as RankTask;
      for (const dependency of dependenciesOf(at)) {
        if (dependency.state === "done") continue;
        if (!raised.has(dependency.key) && (own.get(dependency.key) as number) > to) {
          raised.set(dependency.key, { to, by: source.key });
        }
        if (counts(dependency) && !expanded.has(dependency.key)) {
          expanded.add(dependency.key);
          stack.push(dependency);
        }
      }
    }
  }

  const dependents = new Map<string, RankTask[]>();
  for (const task of byKey.values()) {
    if (!counts(task)) continue;
    for (const dependency of dependenciesOf(task)) {
      const known = dependents.get(dependency.key);
      if (known) known.push(task);
      else dependents.set(dependency.key, [task]);
    }
  }
  const unblocks = (key: string): number => {
    if (!dependents.has(key)) return 0;
    const seen = new Set<string>([key]);
    const stack = [key];
    while (stack.length > 0) {
      for (const dependent of dependents.get(stack.pop() as string) ?? []) {
        if (seen.has(dependent.key)) continue;
        seen.add(dependent.key);
        stack.push(dependent.key);
      }
    }
    return seen.size - 1;
  };

  const rows = [...byKey.values()].map((task) => {
    const lift = raised.get(task.key);
    return {
      task,
      effective: lift?.to ?? (own.get(task.key) as number),
      raisedBy: lift?.by,
      unblocks: unblocks(task.key),
    };
  });
  rows.sort(
    (a, b) =>
      a.effective - b.effective ||
      b.unblocks - a.unblocks ||
      // A task without a time goes after those with one, in its list place.
      (a.task.created_at === undefined ? 1 : 0) - (b.task.created_at === undefined ? 1 : 0) ||
      byText(a.task.created_at ?? "", b.task.created_at ?? "") ||
      (a.task.created_at === undefined ? (a.task.order ?? 0) - (b.task.order ?? 0) : 0) ||
      byText(a.task.key, b.task.key),
  );
  const out = new Map<string, Rank>();
  rows.forEach((row, place) => {
    out.set(row.task.key, {
      place,
      effective: row.effective,
      unblocks: row.unblocks,
      ...(row.raisedBy === undefined ? {} : { raisedBy: row.raisedBy }),
    });
  });
  return out;
}
