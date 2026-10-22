/**
 * The tasks of a project on this machine: the `local` adapter, the registry the host fills, and
 * `openTaskService`, which reads the config and gives the service the tools and the CLI use (or
 * nothing when tasks are off).
 */
import { join } from "node:path";
import { TaskAdapterRegistry, TaskService } from "@kodel-ai/pipeline-core";
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
  return { service, config: tasks };
}

/** Where the tasks of a repository live, for messages. */
export const tasksFolder = (storeRoot: string): string => join(storeRoot, "tasks");
