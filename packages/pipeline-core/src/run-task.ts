/**
 * The tie between a run and a task: a run started for a task is attached to it and moves it to
 * `progress`; when the run ends the task moves on. Pure rules and the glue to the `TaskService`; the
 * host (which knows when a run starts and ends) calls it. Moving a task is not a trust decision, so
 * the engine may do it by itself; a person picks how much it does with `tasks.on_run.mode`.
 */
import { KodelError } from "./errors";
import { redactText } from "./redact";
import type { RunStatus } from "./run";
import type { TaskService } from "./task-service";
import type { Task } from "./tasks";

/**
 * `auto`: attach at the start, `progress` at the start, `done` when the run completes.
 * `ask`: the same at the start; at the end the agent is told to ask the person and does it with
 * `task_update`. `disabled`: the engine does nothing and `pipeline_start` has no `task_key`.
 */
export const TASK_ON_RUN_MODES = ["auto", "ask", "disabled"] as const;
export type TaskOnRunMode = (typeof TASK_ON_RUN_MODES)[number];
export const DEFAULT_TASK_ON_RUN: TaskOnRunMode = "auto";

export type RunEnd = Extract<RunStatus, "completed" | "failed" | "canceled">;
export const isRunEnd = (status: RunStatus): status is RunEnd =>
  status === "completed" || status === "failed" || status === "canceled";

/** What the engine does to the task when its run ends. */
export type EndAction = "close" | "hint" | "comment" | "none";

export function endAction(mode: TaskOnRunMode, status: RunEnd): EndAction {
  if (mode === "disabled") return "none";
  if (status !== "completed") return "comment";
  return mode === "auto" ? "close" : "hint";
}

export interface PreparedTask {
  /** The key as the tracker resolved it; absent when the tracker could not be asked. */
  key?: string;
  /** The task was `done` and the person allowed starting again. */
  restarting: boolean;
  warning?: string;
}

/** What the host needs from the tie; `createRunTaskLink` builds it on a `TaskService`. */
export interface RunTaskLink {
  readonly mode: TaskOnRunMode;
  /**
   * Before anything is made for the run: look at the task. Throws `TASK_NOT_FOUND`, and
   * `TASK_ALREADY_DONE` for a task in state `done` unless `restart` is set. A tracker that does not
   * answer is a warning, not an error: the run starts without the tie.
   */
  prepare(typed: string, restart: boolean): Promise<PreparedTask>;
  /** The run exists: attach it and move the task to `progress`. Never throws. */
  begin(key: string, runId: string, restarting: boolean): Promise<{ note?: string; failed?: true }>;
  /** The run ended. Never throws. */
  end(
    key: string,
    runId: string,
    status: RunEnd,
  ): Promise<{ what: "closed" | "commented" | "hinted" | "failed"; note?: string }>;
}

const reason = (error: unknown): string =>
  redactText(error instanceof Error ? error.message : String(error));

export function createRunTaskLink(service: TaskService, mode: TaskOnRunMode): RunTaskLink {
  const supported = service.capabilities.runs !== "none";
  return {
    mode,
    async prepare(typed, restart) {
      let task: Task;
      try {
        task = await service.taskForRun(typed);
      } catch (error) {
        if (
          error instanceof KodelError &&
          (error.code === "TASK_NOT_FOUND" || error.code === "INVALID_TASK")
        ) {
          throw error;
        }
        return { restarting: false, warning: `the task was not looked up: ${reason(error)}` };
      }
      if (task.state === "done" && !restart) {
        const runs = task.runs.length > 0 ? `; runs: ${task.runs.join(", ")}` : "";
        throw new KodelError(
          "TASK_ALREADY_DONE",
          `task ${task.key} is already done (status "${task.status}"${runs}). Do not start again on your own: ask the person, and only if they want it, call pipeline_start again with restart_task: true`,
          undefined,
          { task: task.key, status: task.status, runs: task.runs },
        );
      }
      return { key: task.key, restarting: task.state === "done" };
    },
    async begin(key, runId, restarting) {
      try {
        const task = await service.taskForRun(key);
        await service.advanceForRun(task, "progress", {
          comment: restarting ? `restarted by run ${runId}` : `started by run ${runId}`,
          ...(supported ? { add_run: runId } : {}),
        });
        return {};
      } catch (error) {
        return { note: `the task was not updated: ${reason(error)}`, failed: true };
      }
    },
    async end(key, runId, status) {
      const action = endAction(mode, status);
      if (action === "none") return { what: "commented" };
      if (action === "hint") return { what: "hinted" };
      try {
        const task = await service.taskForRun(key);
        if (action === "close") {
          await service.advanceForRun(task, "done", { comment: `done: run ${runId} completed` });
          return { what: "closed" };
        }
        await service.advanceForRun(task, undefined, { comment: `run ${runId} ${status}` });
        return { what: "commented" };
      } catch (error) {
        return { what: "failed", note: reason(error) };
      }
    },
  };
}
