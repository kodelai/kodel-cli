/**
 * When the tasks are read. Apart from the runs on purpose: a tracker that answers slowly (a read may take
 * `timeout_s`, up to five minutes) must not hold up the list of runs, so nothing here is awaited by the
 * loop that reads them. One read of the list is out at a time, and an answer that is no longer the newest
 * for its card is dropped. The clock and the readers are given, so it is tested without a terminal.
 *
 * The same shape reads the records of the background agents (`createRefresh` with its own types): one
 * list at a time, the digest of the selected run after each list, nothing awaited by the loop.
 */
import { type CardSlot, messageOf, type TasksLoad } from "./tasks-load";

export const TASKS_EVERY_MS = 10_000;

export interface RefreshDeps<L, C> {
  load: () => Promise<L>;
  loadCard: (key: string) => Promise<C>;
  onLoad: (load: L) => void;
  onCard: (key: string, slot: C) => void;
  /** The key whose card is on the screen, if any: it is read again with every list. */
  shownKey: () => string | undefined;
  /** A read that failed, as the value the screen gets. */
  failed: (error: unknown) => L;
  cardFailed: (error: unknown) => C;
  /** How often the list is read. */
  everyMs: number;
}

/** What the tasks need: the readers and the callbacks; the failures and the timer are the tasks' own. */
export type TasksRefreshDeps = Pick<
  RefreshDeps<TasksLoad, CardSlot>,
  "load" | "loadCard" | "onLoad" | "onCard" | "shownKey"
>;

export interface TasksRefresh {
  /** The first read, at launch. */
  start(now: number): void;
  /** Called often; reads when the last read is old enough and none is out. */
  tick(now: number): void;
  /** The Tasks screen was opened: do not wait for the timer. */
  openScreen(now: number): void;
  /** A card was asked for (a task was selected). */
  readCard(key: string): void;
}

export function createRefresh<L, C>(deps: RefreshDeps<L, C>): TasksRefresh {
  let out = false;
  let last = Number.NEGATIVE_INFINITY;
  let listSeq = 0;
  let cardSeq = 0;
  const newest = new Map<string, number>();
  // A read asked for while one is out (a task was just created, the screen was opened) is made once the
  // current one answers, so what it was asked for is not shown only at the next tick. Its `now` is the request's.
  let again: number | undefined;

  const readCard = (key: string): void => {
    const mine = ++cardSeq;
    newest.set(key, mine);
    const done = (slot: C) => {
      if (newest.get(key) === mine) deps.onCard(key, slot);
    };
    deps
      .loadCard(key)
      .then(done)
      .catch((error: unknown) => done(deps.cardFailed(error)));
  };

  const readList = (now: number): void => {
    if (out) {
      again = now;
      return;
    }
    out = true;
    again = undefined;
    last = now;
    const mine = ++listSeq;
    const done = (load: L) => {
      if (mine === listSeq) deps.onLoad(load);
    };
    deps
      .load()
      .then(done)
      .catch((error: unknown) => done(deps.failed(error)))
      .finally(() => {
        out = false;
        const key = deps.shownKey();
        if (key !== undefined) readCard(key);
        if (again !== undefined) readList(again);
      });
  };

  return {
    start: readList,
    openScreen: readList,
    tick(now) {
      // The timer never queues a read: a read older than the interval is made at the next tick anyway.
      if (!out && now - last >= deps.everyMs) readList(now);
    },
    readCard,
  };
}

export function createTasksRefresh(deps: TasksRefreshDeps): TasksRefresh {
  return createRefresh<TasksLoad, CardSlot>({
    ...deps,
    failed: (error) => ({ status: "error", message: messageOf(error) }),
    cardFailed: (error) => ({ status: "failed", message: messageOf(error) }),
    everyMs: TASKS_EVERY_MS,
  });
}
