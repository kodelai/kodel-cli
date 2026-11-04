/**
 * When the tasks are read. Apart from the runs on purpose: a tracker that answers slowly (a read may take
 * `timeout_s`, up to five minutes) must not hold up the list of runs, so nothing here is awaited by the
 * loop that reads them. One read of the list is out at a time, and an answer that is no longer the newest
 * for its card is dropped. The clock and the readers are given, so it is tested without a terminal.
 */
import { type CardSlot, messageOf, type TasksLoad } from "./tasks-load";

export const TASKS_EVERY_MS = 10_000;

export interface RefreshDeps {
  load: () => Promise<TasksLoad>;
  loadCard: (key: string) => Promise<CardSlot>;
  onLoad: (load: TasksLoad) => void;
  onCard: (key: string, slot: CardSlot) => void;
  /** The task whose card is on the screen, if any: it is read again with every list. */
  shownKey: () => string | undefined;
}

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

export function createTasksRefresh(deps: RefreshDeps): TasksRefresh {
  let out = false;
  let last = Number.NEGATIVE_INFINITY;
  let listSeq = 0;
  let cardSeq = 0;
  const newest = new Map<string, number>();

  const readCard = (key: string): void => {
    const mine = ++cardSeq;
    newest.set(key, mine);
    const done = (slot: CardSlot) => {
      if (newest.get(key) === mine) deps.onCard(key, slot);
    };
    deps
      .loadCard(key)
      .then(done)
      .catch((error: unknown) => done({ status: "failed", message: messageOf(error) }));
  };

  const readList = (now: number): void => {
    if (out) return;
    out = true;
    last = now;
    const mine = ++listSeq;
    const done = (load: TasksLoad) => {
      if (mine === listSeq) deps.onLoad(load);
    };
    deps
      .load()
      .then(done)
      .catch((error: unknown) => done({ status: "error", message: messageOf(error) }))
      .finally(() => {
        out = false;
        const key = deps.shownKey();
        if (key !== undefined) readCard(key);
      });
  };

  return {
    start: readList,
    openScreen: readList,
    tick(now) {
      if (now - last >= TASKS_EVERY_MS) readList(now);
    },
    readCard,
  };
}
