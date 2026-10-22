/**
 * What the task scenarios need besides the general harness: a config that turns tasks on, tasks
 * that exist before the agent starts, and a way to read what it left behind. They go through the
 * same task service the agent's MCP server uses, on the same files, so a scenario asserts on what
 * is stored and never on what the agent said.
 */
import { join } from "node:path";
import { openTaskService } from "../../packages/local/src";
import type { Sandbox } from "./harness";

/** The project config that turns tasks on, with keys like KDL-7K3Q. */
export const TASKS_ON = "tasks:\n  enabled: true\n  adapters:\n    local:\n      prefix: KDL\n";

/** The person's side: the task service on the same files as the agent's server. */
export async function taskService(sandbox: Sandbox) {
  const opened = await openTaskService({ storeRoot: join(sandbox.dir, ".kodel") });
  if (!opened) throw new Error("tasks are not turned on in this sandbox (config: TASKS_ON)");
  return opened.service;
}

export interface SeedTask {
  title: string;
  body?: string;
  priority?: "high" | "normal" | "low";
  status?: "todo" | "progress" | "done" | "declined";
  parent?: string;
}

/** Tasks that exist before the agent starts; returns their keys in order. */
export async function seedTasks(sandbox: Sandbox, tasks: SeedTask[]): Promise<string[]> {
  const service = await taskService(sandbox);
  const keys: string[] = [];
  for (const t of tasks) {
    const input: Parameters<typeof service.create>[0] = { title: t.title };
    if (t.body !== undefined) input.body = t.body;
    if (t.priority !== undefined) input.priority = t.priority;
    if (t.parent !== undefined) input.parent = t.parent;
    const made = await service.create(input);
    if (!made.ok) throw new Error(`could not seed "${t.title}": ${made.message}`);
    const key = (made.task as { key: string }).key;
    if (t.status !== undefined && t.status !== "todo") {
      const moved = await service.update({ key, status: t.status });
      if (!moved.ok) throw new Error(`could not move "${t.title}": ${moved.message}`);
    }
    keys.push(key);
  }
  return keys;
}

export interface TaskRow {
  key: string;
  title: string;
  status: string;
  priority?: string;
  parent?: string;
  comments: string[];
  runs: string[];
}

/** Every task on disk, whatever its state: what the agent left behind. */
export async function allTasks(sandbox: Sandbox): Promise<TaskRow[]> {
  const service = await taskService(sandbox);
  const listed = await service.list({ state: ["todo", "progress", "done"], limit: 200 });
  if (!listed.ok) throw new Error(listed.message);
  const rows: TaskRow[] = [];
  for (const summary of listed.tasks as { key: string }[]) {
    const read = await service.get({ key: summary.key });
    if (!read.ok) throw new Error(read.message);
    const t = read.task as {
      key: string;
      title: string;
      status: string;
      priority?: string;
      parent?: string;
      comments?: { text: string }[];
      runs: string[];
    };
    const row: TaskRow = {
      key: t.key,
      title: t.title,
      status: t.status,
      comments: (t.comments ?? []).map((c) => c.text),
      runs: t.runs,
    };
    if (t.priority !== undefined) row.priority = t.priority;
    if (t.parent !== undefined) row.parent = t.parent;
    rows.push(row);
  }
  return rows;
}
