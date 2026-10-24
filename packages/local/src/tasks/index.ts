/**
 * The tasks of a project on this machine: the `local` adapter, the registry the host fills, and
 * `openTaskService`, which reads the config and gives the service the tools and the CLI use (or
 * nothing when tasks are off).
 */
import { join } from "node:path";
import {
  createRunTaskLink,
  type RunTaskLink,
  TaskAdapterRegistry,
  TaskService,
} from "@kodel-ai/pipeline-core";
import { loadConfig, type TasksConfig } from "../config";
import { localTaskAdapter } from "./local-adapter";

export * from "./local-adapter";

/** The adapters this host knows. A later one (a tracker) is registered here too. */
export function createTaskRegistry(storeRoot: string): TaskAdapterRegistry {
  const registry = new TaskAdapterRegistry();
  registry.register("local", localTaskAdapter(storeRoot));
  return registry;
}

export interface OpenTasksOptions {
  /** The store root, by default `<root>/.kodel`. */
  storeRoot: string;
  clock?: () => number;
  random?: () => number;
  registry?: TaskAdapterRegistry;
}

export interface OpenedTasks {
  service: TaskService;
  config: TasksConfig;
  /**
   * The tie between a run and a task. Absent when the mode is `disabled` or the adapter cannot
   * attach runs: nothing then offers `task_key`.
   */
  runLink?: RunTaskLink;
}

/**
 * Read the config and build the service for the adapter it names. `undefined` when tasks are off.
 * Throws `CONFIG_INVALID` for a config that cannot be used (an unknown adapter, a bad block).
 */
export async function openTaskService(options: OpenTasksOptions): Promise<OpenedTasks | undefined> {
  const { tasks } = await loadConfig(options.storeRoot);
  if (!tasks.enabled) return undefined;
  const clock = options.clock ?? Date.now;
  const registry = options.registry ?? createTaskRegistry(options.storeRoot);
  const adapter = await registry.create(tasks.adapter, {
    options: tasks.adapters[tasks.adapter] ?? {},
    clock,
    random: options.random ?? Math.random,
  });
  const service = new TaskService(adapter, { timeoutMs: tasks.timeout_s * 1000, now: clock });
  const linkable = tasks.on_run.mode !== "disabled" && service.capabilities.runs !== "none";
  return {
    service,
    config: tasks,
    ...(linkable ? { runLink: createRunTaskLink(service, tasks.on_run.mode) } : {}),
  };
}

/** Where the tasks of a repository live, for messages. */
export const tasksFolder = (storeRoot: string): string => join(storeRoot, "tasks");
