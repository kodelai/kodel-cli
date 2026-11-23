/**
 * The queues of `kodel serve` (T-46): what waits, in which order and why it stands where it does.
 * A queue is entries put in order by a policy; the plan orders both of its queues through `order()`
 * and nothing else, so another policy can stand in without the plan changing.
 */
import type { Rank } from "./rank";

export interface QueueContext {
  /** The tracker's priorities, most urgent first. */
  priorities: readonly string[];
  /** The base order of the tasks, by key. */
  ranks: ReadonlyMap<string, Rank>;
}

export interface QueuePolicy<E> {
  readonly name: string;
  /** Compared part by part: numbers as numbers, text by code unit (no locale). */
  key(entry: E, ctx: QueueContext): readonly (number | string)[];
  /** Why the entry stands where it does: keys, priority names and fixed words only. */
  reason(entry: E, ctx: QueueContext): string;
}

export interface Placed<E> {
  entry: E;
  reason: string;
}

function compare(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] as number | string;
    const y = b[i] as number | string;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return a.length - b.length;
}

export function order<B, E extends B>(
  entries: readonly E[],
  policy: QueuePolicy<B>,
  ctx: QueueContext,
): Placed<E>[] {
  return entries
    .map((entry) => ({ entry, key: policy.key(entry, ctx) }))
    .sort((a, b) => compare(a.key, b.key))
    .map(({ entry }) => ({ entry, reason: policy.reason(entry, ctx) }));
}

/** A task that may be started. */
export interface StartEntry {
  key: string;
  priority?: string;
}

/** The start queue: the base order (`rank`); a task the ranks do not know goes last, by key. */
export const startPolicy: QueuePolicy<StartEntry> = {
  name: "base",
  key: (entry, ctx) => [ctx.ranks.get(entry.key)?.place ?? Number.MAX_SAFE_INTEGER, entry.key],
  reason: (entry, ctx) => {
    const place = ctx.ranks.get(entry.key);
    const own = entry.priority === undefined ? "no priority" : `priority ${entry.priority}`;
    if (place === undefined) return own;
    const raised = ctx.priorities[place.effective];
    const parts = [
      place.raisedBy === undefined || raised === undefined
        ? own
        : `priority ${raised} (raised by ${place.raisedBy})`,
    ];
    if (place.unblocks > 0) parts.push(`unblocks ${place.unblocks}`);
    return parts.join(", ");
  },
};

/** A run that waits for a worker place after a person's decision. */
export interface WorkerEntry {
  runId: string;
  /** The time and the journal sequence of the decision. */
  ts: number;
  seq: number;
}

/** The worker queue: the oldest decision first. */
export const workerPolicy: QueuePolicy<WorkerEntry> = {
  name: "oldest-decision",
  key: (entry) => [entry.ts, entry.seq, entry.runId],
  // The time orders the queue, so it is what the reason shows; a journal seq means nothing across runs.
  reason: (entry) => `decided at ${entry.ts}`,
};
