/**
 * Opens the tasks for the TUI, and builds the part of its options that reads them. The readers (`list`, `get`) cannot
 * write; the two writes are the comment writer, which calls only `update({key, comment})` and is reached only from the
 * confirmed comment input, and the creator, which calls only `create` and is reached only from the confirmed form of
 * a new task.
 */
import { openTaskService } from "@kodel-ai/local";
import { demoTaskCard, demoTasks } from "./demo-tasks";
import type { TuiOptions } from "./run";
import {
  type Answer,
  type CardSlot,
  createdKey,
  failure,
  loadTask,
  loadTasks,
  messageOf,
  type NewTaskInput,
  type TaskComment,
  type TasksHandle,
  type TasksLoad,
  type TasksSource,
} from "./tasks-load";

/** The part of a `TaskService` the TUI uses: two reads, an update that is only ever given a comment, and `create`. */
type Service = TasksSource & {
  update(input: { key: string; comment: string }): Promise<Answer>;
  create(input: NewTaskInput): Promise<Answer>;
};

/** The part of `openTaskService` the TUI uses; given in tests. */
type Open = (options: { storeRoot: string }) => Promise<{ service: Service } | undefined>;

/**
 * The tasks of the project, or why there are none. Unlike `kodel task`, tasks being off is not an error
 * here: the screens say so in a line. The service is opened once, so a changed config is read when the TUI
 * is started again.
 */
export async function openTasksForTui(
  storeRoot: string,
  open: Open = openTaskService,
): Promise<TasksHandle> {
  try {
    const opened = await open({ storeRoot });
    if (!opened) return { status: "off" };
    const { service } = opened;
    return {
      status: "on",
      source: { list: (i) => service.list(i), get: (i) => service.get(i) },
      comment: async (key, text) => {
        const answer = await service.update({ key, comment: text });
        if (!answer.ok) throw failure(answer, "the comment could not be saved");
      },
      create: async (input) => {
        const answer = await service.create(input);
        if (!answer.ok) throw failure(answer, "the task could not be created");
        const key = createdKey(answer);
        if (key === undefined) throw new Error("the tracker answered a task without a key");
        return { key };
      },
    };
  } catch (error) {
    return { status: "error", message: messageOf(error) };
  }
}

/** The readers of tasks for `TuiOptions`: the sample ones for `--demo`, else the project's. */
export function tuiTaskOptions(
  from: "demo" | TasksHandle,
  now: number = Date.now(),
): Pick<TuiOptions, "loadTasks" | "loadTask" | "addTaskComment" | "createTask"> {
  if (from === "demo") {
    // The sample comments live as long as this call: nothing is written anywhere.
    const added = new Map<string, TaskComment[]>();
    return {
      loadTasks: async (): Promise<TasksLoad> => demoTasks(),
      loadTask: async (key): Promise<CardSlot> => demoTaskCard(key, now, added.get(key)),
      addTaskComment: async (key, text) => {
        added.set(key, [
          ...(added.get(key) ?? []),
          { text, at: new Date(Date.now()).toISOString(), by: "you" },
        ]);
      },
    };
  }
  const comment = from.status === "on" ? from.comment : undefined;
  const create = from.status === "on" ? from.create : undefined;
  return {
    loadTasks: () => loadTasks(from),
    loadTask: (key) => loadTask(from, key),
    ...(comment === undefined ? {} : { addTaskComment: comment }),
    ...(create === undefined ? {} : { createTask: create }),
  };
}
