/** Sample tasks for `kodel tui --demo`: mixed priorities and dates, a child, one tied to a sample run, a declined one. */
import type { CardSlot, TaskCardData, TaskComment, TaskRow, TasksLoad } from "./tasks-load";

const row = (
  key: string,
  title: string,
  state: TaskRow["state"],
  status: string,
  priority: string,
  extra: Partial<TaskRow> = {},
): TaskRow => ({ key, title, state, status, priority, runCount: 0, ...extra });

/** In the order the `local` adapter gives them: priority, then oldest first. */
const TODO: TaskRow[] = [
  row("KDL-2K9M", "Show the agent session of a run in the TUI", "todo", "todo", "high"),
  // Tied to the sample run `report-html-export`, so the Backlog leaves it out.
  row("KDL-4H7P", "Export the report as HTML", "todo", "todo", "high", { runCount: 1 }),
  row("KDL-6QX3", "Start a task from the TUI in a background agent", "todo", "todo", "high"),
  row("KDL-7R2D", "Print a table header in task list", "todo", "todo", "normal"),
  row("KDL-8W5T", "Plural aliases for the command groups", "todo", "todo", "normal"),
  row("KDL-9B4N", "Aliases in the docs", "todo", "todo", "normal", { parent: "KDL-8W5T" }),
  row("KDL-3F6V", "Rename the wait flag", "todo", "todo", "low"),
  row("KDL-5C8J", "Try a second agent on the same task", "todo", "todo", "low"),
];

const PROGRESS: TaskRow[] = [
  row("KDL-A2E4", "Run title from the agent", "progress", "progress", "normal", { runCount: 1 }),
];

const DONE: TaskRow[] = [
  row("KDL-B7H9", "Fix the wait timeout", "done", "done", "normal", { runCount: 2 }),
  row("KDL-C3M2", "A very old idea", "done", "declined", "low"),
  // A finished child of a task in the Backlog: its card shows `1/2 done`.
  row("KDL-9D1Q", "Plural alias for the run commands", "done", "done", "low", {
    parent: "KDL-8W5T",
  }),
];

export function demoTasks(): TasksLoad {
  return {
    status: "ready",
    rows: [...TODO, ...PROGRESS, ...DONE],
    more: false,
    problems: 0,
    todo: TODO,
    todoCut: false,
  };
}

const BODIES: Record<string, string> = {
  "KDL-2K9M":
    "The card of a run names the agent session it was last worked in. Show the same in the list.\n\nDone when the session shows with its name.",
  "KDL-4H7P": "The report as a standalone HTML file, one page, no scripts.",
  "KDL-6QX3": "A key on a Backlog row that starts the task in a background agent. A later task.",
};

/** Children of the sample tasks: the same keys as the rows that name them as their parent. */
const SUBTASKS: Record<string, { key: string; title: string }[]> = {
  "KDL-8W5T": [
    { key: "KDL-9B4N", title: "Aliases in the docs" },
    { key: "KDL-9D1Q", title: "Plural alias for the run commands" },
  ],
};

export function demoTaskCard(key: string, now: number, added: TaskComment[] = []): CardSlot {
  const found = [...TODO, ...PROGRESS, ...DONE].find((r) => r.key === key);
  if (!found) return { status: "failed", message: `there is no task "${key}"` };
  const card: TaskCardData = {
    key: found.key,
    title: found.title,
    state: found.state,
    status: found.status,
    ...(found.priority === undefined ? {} : { priority: found.priority }),
    ...(found.parent === undefined ? {} : { parent: found.parent }),
    runs: key === "KDL-4H7P" ? ["r_1kd8aa019"] : [],
    body: BODIES[key] ?? "A sample task. Nothing here is written anywhere.",
    comments: [
      ...(found.status === "declined"
        ? [
            {
              text: "Will not be done: the idea was dropped.",
              at: new Date(now - 86_400_000).toISOString(),
            },
          ]
        : []),
      ...added,
    ],
    subtasks: SUBTASKS[key] ?? [],
  };
  return { status: "ready", card };
}
