/**
 * Reads the tasks of a project for the Tasks screen and the Backlog block. Read-only: the source it is
 * given has no way to write. What the tracker answers is not trusted: a row that is not what it should
 * be is dropped and counted, and a failure becomes a state, never a throw into the screen.
 */
import {
  type DependencyRef,
  needsApproval,
  readState,
  TASK_LIMITS,
  type TaskState,
} from "@kodel-ai/pipeline-core";
import { plain } from "../plain";

/** How many tasks the Backlog block shows. A constant for now. */
export const BACKLOG_COUNT = 5;
/** One page of the Tasks screen; the contract's largest page. */
export const SCREEN_LIMIT = 200;
/** The Backlog reads the unstarted tasks page by page, up to this many pages. */
export const BACKLOG_PAGES = 4;

export interface TaskRow {
  key: string;
  title: string;
  state: TaskState;
  status: string;
  priority?: string;
  parent?: string;
  runCount: number;
  /** An agent made or changed the task and no person approved it since (`kodel task approve`). */
  waitsForApproval?: boolean;
  /** The dependencies that hold the task back from `kodel serve`; absent when none does. */
  blockedBy?: string[];
}

/** The links of a task as the card shows them and the start warning reads them. */
export interface TaskLinkData {
  dependsOn?: string[];
  dependencies?: DependencyRef[];
  blocks?: string[];
  conflictsWith?: string[];
}

export interface TaskComment {
  text: string;
  at: string;
  by?: string;
}

/** Everything the card of a task shows. */
export interface TaskCardData extends TaskLinkData {
  key: string;
  title: string;
  state: TaskState;
  status: string;
  priority?: string;
  parent?: string;
  waitsForApproval?: boolean;
  blockedBy?: string[];
  runs: string[];
  body?: string;
  comments: TaskComment[];
  subtasks: { key: string; title: string }[];
}

export type TasksLoad =
  | {
      status: "ready";
      /** Every state, in the adapter's order. */
      rows: TaskRow[];
      /** The adapter has more than the page that was read. */
      more: boolean;
      /** Task files the adapter could not read, and rows it sent that were dropped. */
      problems: number;
      /** The unstarted tasks, in the adapter's order: the Backlog filters and cuts them when it draws. */
      todo: TaskRow[];
      /** There are more unstarted tasks than were read. */
      todoCut: boolean;
    }
  | { status: "off" }
  | { status: "error"; message: string };

export type CardSlot =
  | { status: "loading" }
  | { status: "ready"; card: TaskCardData }
  | { status: "failed"; message: string };

/** What a `TaskService` answers; a failure is a value, and the rest is unchecked. */
export type Answer = { ok: boolean };

/** The part of a `TaskService` the screens read; it has no write in it. */
export interface TasksSource {
  list(input: { state: TaskState[]; limit: number; cursor?: string }): Promise<Answer>;
  get(input: { key: string }): Promise<Answer>;
}

/**
 * The one thing the TUI writes to a task: a note a person typed. Kept apart from `TasksSource` so the readers cannot
 * reach it; it adds a comment and changes nothing else.
 */
export type TaskCommenter = (key: string, text: string) => Promise<void>;

/** What the form of a new task sends: the fields `TaskService.create` takes from a person here. */
export interface NewTaskInput {
  title: string;
  body?: string;
  priority?: string;
  parent?: string;
}

/**
 * The other write of the TUI: a task a person filled in with `n`. It calls only `create` and answers the key
 * the tracker gave; the task starts in the tracker's first status (`todo`), as any task made with `task_create`.
 */
export type TaskCreator = (input: NewTaskInput) => Promise<{ key: string }>;

export type TasksHandle =
  | { status: "on"; source: TasksSource; comment?: TaskCommenter; create?: TaskCreator }
  | { status: "off" }
  | { status: "error"; message: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** A list of keys from a tracker: what is not a short string is dropped, and the list is bounded. */
function keyList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const keys = value
    .filter((k): k is string => typeof k === "string" && k !== "" && k.length <= TASK_LIMITS.key)
    .slice(0, TASK_LIMITS.linksShown)
    // A key is shown as it is: what could mislead a terminal is taken out here, once.
    .map((k) => plain(k))
    .filter((k) => k !== "");
  return keys.length === 0 ? undefined : keys;
}

const DEPENDENCY_STATES = ["open", "done", "declined", "missing"] as const;

/** The link fields of a task; a state the TUI does not know reads as `missing` (it blocks). */
function parseLinks(raw: Record<string, unknown>): TaskLinkData {
  const dependsOn = keyList(raw.depends_on);
  const blocks = keyList(raw.blocks);
  const conflictsWith = keyList(raw.conflicts_with);
  const dependencies: DependencyRef[] = [];
  if (Array.isArray(raw.dependencies)) {
    for (const d of raw.dependencies.slice(0, TASK_LIMITS.linksShown)) {
      if (!isObject(d)) continue;
      const key = keyList([d.key])?.[0];
      if (key === undefined) continue;
      const state = DEPENDENCY_STATES.find((s) => s === d.state) ?? "missing";
      dependencies.push(
        d.needs_approval === true ? { key, state, needs_approval: true } : { key, state },
      );
    }
  }
  return {
    ...(dependsOn === undefined ? {} : { dependsOn }),
    ...(dependencies.length === 0 ? {} : { dependencies }),
    ...(blocks === undefined ? {} : { blocks }),
    ...(conflictsWith === undefined ? {} : { conflictsWith }),
  };
}

export function parseRow(raw: unknown): TaskRow | undefined {
  if (!isObject(raw)) return undefined;
  const key = text(raw.key);
  const title = typeof raw.title === "string" ? raw.title : undefined;
  if (key === undefined || title === undefined || typeof raw.status !== "string") return undefined;
  const priority = text(raw.priority);
  const parent = text(raw.parent);
  const blockedBy = keyList(raw.blocked_by);
  return {
    key,
    title,
    state: readState(raw.state),
    status: raw.status,
    ...(priority === undefined ? {} : { priority }),
    ...(parent === undefined ? {} : { parent }),
    runCount: typeof raw.run_count === "number" ? raw.run_count : 0,
    ...(raw.needs_approval === true ? { waitsForApproval: true } : {}),
    ...(blockedBy === undefined ? {} : { blockedBy }),
  };
}

/** A full task carries the marks, not the summary's flag: the card works it out the same way. */
function cardWaits(raw: Record<string, unknown>): boolean {
  if (raw.needs_approval === true) return true;
  const at = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;
  const marks: Parameters<typeof needsApproval>[0] = { created_at: at(raw.created_at) ?? "" };
  if (raw.created_by === "agent") marks.created_by = "agent";
  const edited = at(raw.agent_edited_at);
  if (edited !== undefined) marks.agent_edited_at = edited;
  const approved = at(raw.approved_at);
  if (approved !== undefined) marks.approved_at = approved;
  return needsApproval(marks);
}

function parseCard(raw: unknown, subtasks: unknown): TaskCardData | undefined {
  if (!isObject(raw)) return undefined;
  const row = parseRow(raw);
  if (row === undefined) return undefined;
  const comments: TaskComment[] = [];
  if (Array.isArray(raw.comments)) {
    for (const c of raw.comments) {
      if (!isObject(c) || typeof c.text !== "string" || typeof c.at !== "string") continue;
      const by = text(c.by);
      comments.push({ text: c.text, at: c.at, ...(by === undefined ? {} : { by }) });
    }
  }
  const kids: { key: string; title: string }[] = [];
  if (Array.isArray(subtasks)) {
    for (const k of subtasks) {
      const kid = isObject(k) ? text(k.key) : undefined;
      if (isObject(k) && kid !== undefined && typeof k.title === "string") {
        kids.push({ key: kid, title: k.title });
      }
    }
  }
  const body = typeof raw.body === "string" && raw.body !== "" ? raw.body : undefined;
  return {
    key: row.key,
    title: row.title,
    state: row.state,
    status: row.status,
    ...(row.priority === undefined ? {} : { priority: row.priority }),
    ...(row.parent === undefined ? {} : { parent: row.parent }),
    ...(cardWaits(raw) ? { waitsForApproval: true } : {}),
    ...(row.blockedBy === undefined ? {} : { blockedBy: row.blockedBy }),
    ...parseLinks(raw),
    runs: Array.isArray(raw.runs)
      ? raw.runs.filter((r): r is string => typeof r === "string" && r !== "")
      : [],
    ...(body === undefined ? {} : { body }),
    comments,
    subtasks: kids,
  };
}

export function failure(answer: Answer, what: string): Error {
  const fields: Record<string, unknown> = answer;
  return new Error(typeof fields.message === "string" ? fields.message : what);
}

/** The key of the task a `create` answered, or nothing when the answer does not carry one. */
export function createdKey(answer: Answer): string | undefined {
  const fields: Record<string, unknown> = answer;
  return isObject(fields.task) ? text(fields.task.key) : undefined;
}

interface Page {
  rows: TaskRow[];
  next?: string;
  cut: boolean;
  problems: number;
}

async function page(
  source: TasksSource,
  input: { state: TaskState[]; limit: number; cursor?: string },
): Promise<Page> {
  const got = await source.list(input);
  if (!got.ok) throw failure(got, "the task list could not be read");
  const answer: Record<string, unknown> = got;
  if (!Array.isArray(answer.tasks)) throw new Error("the task list is not a list");
  const rows: TaskRow[] = [];
  let dropped = 0;
  for (const raw of answer.tasks) {
    const row = parseRow(raw);
    if (row === undefined) dropped += 1;
    else rows.push(row);
  }
  const listed = Array.isArray(answer.problems) ? answer.problems.length : 0;
  const next = typeof answer.next === "string" ? answer.next : undefined;
  return {
    rows,
    ...(next === undefined ? {} : { next }),
    cut: answer.truncated === true || next !== undefined,
    problems: listed + dropped,
  };
}

export function messageOf(error: unknown): string {
  return plain(error instanceof Error ? error.message : String(error)).trim();
}

/** The tasks for both screens. A handle that is off or broken reads as itself; a failed read is an error state. */
export async function loadTasks(handle: TasksHandle): Promise<TasksLoad> {
  if (handle.status === "off") return { status: "off" };
  if (handle.status === "error") return { status: "error", message: plain(handle.message) };
  try {
    const screen = await page(handle.source, {
      state: ["todo", "progress", "done"],
      limit: SCREEN_LIMIT,
    });
    const todo: TaskRow[] = [];
    let cursor: string | undefined;
    let todoCut = false;
    for (let pages = 0; pages < BACKLOG_PAGES; pages += 1) {
      const got = await page(handle.source, {
        state: ["todo"],
        limit: SCREEN_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      });
      todo.push(...got.rows);
      cursor = got.next;
      if (cursor === undefined) break;
      todoCut = pages === BACKLOG_PAGES - 1;
    }
    return {
      status: "ready",
      rows: screen.rows,
      more: screen.cut,
      problems: screen.problems,
      todo,
      todoCut,
    };
  } catch (error) {
    return { status: "error", message: messageOf(error) };
  }
}

/** One task with its body and comments; never throws. */
export async function loadTask(handle: TasksHandle, key: string): Promise<CardSlot> {
  if (handle.status !== "on") {
    return {
      status: "failed",
      message: handle.status === "off" ? "Tasks are off." : plain(handle.message),
    };
  }
  try {
    const got = await handle.source.get({ key });
    if (!got.ok) throw failure(got, "the task could not be read");
    const answer: Record<string, unknown> = got;
    const card = parseCard(answer.task, answer.subtasks);
    if (card === undefined) throw new Error("the tracker answered a task that cannot be read");
    return { status: "ready", card };
  } catch (error) {
    return { status: "failed", message: messageOf(error) };
  }
}
