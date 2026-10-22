/**
 * A task adapter that keeps its tasks in memory, written to look like a *tracker* and not like the
 * `local` adapter: its own status and priority names, keys that differ from ids, a priority that can
 * be empty, a workflow that can forbid a move, declared fields (one read-only), and hooks to make
 * a call fail or hang. It is what the service and tool tests run on, and the second subject of the
 * adapter conformance suite.
 */
import {
  type CallOptions,
  type Comment,
  type FieldInfo,
  type FieldValue,
  KodelError,
  type NewTask,
  type StatusInfo,
  type SubtaskRef,
  TASK_CONTRACT,
  TASK_LIMITS,
  type Task,
  type TaskAdapter,
  type TaskAdapterCapabilities,
  type TaskFilter,
  type TaskPatch,
  type TaskProblem,
  type TaskSchema,
  type TaskSummary,
} from "@kodel-ai/pipeline-core";

const STATUSES: StatusInfo[] = [
  { name: "Backlog", state: "todo", description: "Not started yet." },
  { name: "In Progress", state: "progress", description: "Somebody is working on it." },
  { name: "Done", state: "done", description: "Finished." },
  { name: "Won't Do", state: "done", description: "Closed without doing it." },
];
const PRIORITIES = [
  { name: "Highest", description: "Drop everything." },
  { name: "High" },
  { name: "Medium" },
  { name: "Low" },
];
const DEFAULT_PRIORITY = "Medium";

const FIELDS: FieldInfo[] = [
  {
    name: "Component",
    kind: "select",
    required: false,
    allowed: ["Backend", "Frontend"],
    summary: true,
    description: "The part of the product.",
  },
  { name: "Reporter", kind: "user", required: false, readonly: true },
];

export interface MemoryTaskOptions {
  capabilities?: Partial<TaskAdapterCapabilities>;
  /** Moves a status allows (by name); a status that is not listed allows every move. */
  workflow?: Record<string, string[]>;
  /** Called first in every method: a test throws or hangs here. */
  before?: (method: string, o: CallOptions) => Promise<void> | void;
}

interface Row {
  seq: number;
  id: string;
  key: string;
  title: string;
  body?: string;
  status: string;
  priority?: string;
  comments: Comment[];
  parent?: string;
  runs: string[];
  fields: Record<string, FieldValue>;
  created_at: string;
  updated_at: string;
}

const invalid = (message: string) => new KodelError("INVALID_TASK", message);

export class MemoryTaskAdapter implements TaskAdapter {
  readonly contract = TASK_CONTRACT;
  readonly kind = "memory";
  readonly capabilities: TaskAdapterCapabilities;
  private readonly rows = new Map<string, Row>();
  private seq = 0;
  private tick = Date.UTC(2026, 0, 1);

  constructor(private readonly options: MemoryTaskOptions = {}) {
    this.capabilities = {
      subtasks: true,
      runs: "full",
      comment: "append",
      fields: true,
      priority: true,
      types: false,
      ...options.capabilities,
    };
  }

  private now(): string {
    this.tick += 1000;
    return new Date(this.tick).toISOString();
  }

  private async enter(method: string, o: CallOptions): Promise<void> {
    await this.options.before?.(method, o);
  }

  private find(input: string): Row | undefined {
    const wanted = input.trim().toUpperCase().replace(/^#/, "MEM-");
    for (const row of this.rows.values()) {
      if (row.key === wanted || row.id === input.trim()) return row;
    }
    return undefined;
  }

  async resolveKey(input: string, o: CallOptions): Promise<string | undefined> {
    await this.enter("resolveKey", o);
    const typed = input.trim().toUpperCase().replace(/^#/, "");
    const bare = /^\d+$/.test(typed) ? `MEM-${typed}` : typed;
    return /^MEM-[1-9]\d{0,8}$/.test(bare) ? bare : undefined;
  }

  async schema(query: { key?: string; type?: string }, o: CallOptions): Promise<TaskSchema> {
    await this.enter("schema", o);
    const schema: TaskSchema = {
      statuses: STATUSES,
      fields: this.capabilities.fields ? FIELDS : [],
    };
    if (this.capabilities.priority) schema.priorities = PRIORITIES;
    if (query.key !== undefined) {
      const row = this.find(query.key);
      if (!row) throw new KodelError("TASK_NOT_FOUND", `there is no task "${query.key}"`);
      schema.transitions = STATUSES.filter((s) => this.allows(row.status, s.name)).map((s) => ({
        to: s.name,
      }));
    }
    return schema;
  }

  private allows(from: string, to: string): boolean {
    if (from === to) return true;
    const moves = this.options.workflow?.[from];
    return moves === undefined || moves.includes(to);
  }

  private checkFields(fields: Record<string, FieldValue>): void {
    for (const [name, value] of Object.entries(fields)) {
      const info = FIELDS.find((f) => f.name === name);
      if (!info) {
        throw invalid(
          `there is no field "${name}"; the fields are: ${FIELDS.map((f) => f.name).join(", ")}`,
        );
      }
      if (info.readonly) throw invalid(`the field "${name}" is read-only`);
      if (info.allowed && !info.allowed.includes(String(value))) {
        throw invalid(
          `"${String(value)}" is not allowed for "${name}"; allowed: ${info.allowed.join(", ")}`,
        );
      }
    }
  }

  private checkPriority(name: string): void {
    if (!this.capabilities.priority) {
      throw new KodelError("TASK_UNSUPPORTED", "this tracker has no priorities");
    }
    if (!PRIORITIES.some((p) => p.name === name)) {
      throw invalid(
        `there is no priority "${name}"; the priorities are: ${PRIORITIES.map((p) => p.name).join(", ")}`,
      );
    }
  }

  private checkStatus(name: string): void {
    if (!STATUSES.some((s) => s.name === name)) {
      throw invalid(
        `there is no status "${name}"; the statuses are: ${STATUSES.map((s) => s.name).join(", ")}`,
      );
    }
  }

  private parentOf(key: string): Row {
    const parent = this.find(key);
    if (!parent) throw new KodelError("TASK_NOT_FOUND", `there is no parent task "${key}"`);
    return parent;
  }

  private toTask(row: Row, comments: number = TASK_LIMITS.comments): Task {
    const state = STATUSES.find((s) => s.name === row.status)?.state ?? "todo";
    const task: Task = {
      id: row.id,
      key: row.key,
      title: row.title,
      status: row.status,
      state,
      runs: this.capabilities.runs === "none" ? [] : [...row.runs],
      created_at: row.created_at,
      updated_at: row.updated_at,
      url: `https://tracker.invalid/browse/${row.key}`,
    };
    if (row.body !== undefined) task.body = row.body;
    if (row.priority !== undefined) task.priority = row.priority;
    if (row.parent !== undefined) task.parent = row.parent;
    const last = row.comments[row.comments.length - 1];
    if (last) {
      task.comment = last.text;
      task.comments = row.comments.slice(-comments);
    }
    if (Object.keys(row.fields).length > 0) task.fields = { ...row.fields };
    return task;
  }

  private rank(row: Row): number {
    const at = PRIORITIES.findIndex((p) => p.name === row.priority);
    return at < 0 ? PRIORITIES.length : at;
  }

  private children(key: string): Row[] {
    return [...this.rows.values()].filter((r) => r.parent === key);
  }

  private summary(row: Row): TaskSummary {
    const task = this.toTask(row, 1);
    const s: TaskSummary = {
      id: task.id,
      key: task.key,
      title: task.title,
      status: task.status,
      state: task.state,
    };
    if (task.priority !== undefined) s.priority = task.priority;
    if (task.comment !== undefined) s.comment = task.comment;
    if (task.parent !== undefined) s.parent = task.parent;
    if (task.url !== undefined) s.url = task.url;
    const kids = this.children(row.key);
    if (kids.length > 0) {
      s.subtasks = {
        total: kids.length,
        done: kids.filter((k) => this.stateOf(k) === "done").length,
      };
    }
    if (this.capabilities.runs !== "none") s.run_count = row.runs.length;
    const shown = Object.fromEntries(
      Object.entries(row.fields).filter(([name]) => FIELDS.find((f) => f.name === name)?.summary),
    );
    if (Object.keys(shown).length > 0) s.fields = shown;
    return s;
  }

  private stateOf(row: Row) {
    return STATUSES.find((s) => s.name === row.status)?.state ?? "todo";
  }

  async create(input: NewTask, o: CallOptions): Promise<Task> {
    await this.enter("create", o);
    if (input.type !== undefined)
      throw new KodelError("TASK_UNSUPPORTED", "this tracker has no task types");
    if (input.priority !== undefined) this.checkPriority(input.priority);
    if (input.fields !== undefined) this.checkFields(input.fields);
    if (input.parent !== undefined) this.parentOf(input.parent);
    this.seq += 1;
    const at = this.now();
    const row: Row = {
      seq: this.seq,
      id: String(1000 + this.seq),
      key: `MEM-${this.seq}`,
      title: input.title,
      status: "Backlog",
      comments: input.comment === undefined ? [] : [{ text: input.comment, at }],
      runs: input.run === undefined ? [] : [input.run],
      fields: { ...(input.fields ?? {}) },
      created_at: at,
      updated_at: at,
    };
    if (input.body !== undefined) row.body = input.body;
    if (input.priority !== undefined) row.priority = input.priority;
    else if (this.capabilities.priority) row.priority = DEFAULT_PRIORITY;
    if (input.parent !== undefined) row.parent = this.parentOf(input.parent).key;
    this.rows.set(row.key, row);
    return this.toTask(row);
  }

  async get(
    key: string,
    o: CallOptions,
  ): Promise<{ task: Task; subtasks: SubtaskRef[]; subtasks_truncated?: boolean } | undefined> {
    await this.enter("get", o);
    const row = this.find(key);
    if (!row) return undefined;
    const subtasks = this.children(row.key).map((r) => ({ id: r.id, key: r.key, title: r.title }));
    return { task: this.toTask(row), subtasks };
  }

  private order(a: Row, b: Row): number {
    return this.rank(a) - this.rank(b) || a.seq - b.seq;
  }

  async list(
    filter: TaskFilter,
    o: CallOptions,
  ): Promise<{ tasks: TaskSummary[]; next?: string; truncated: boolean; problems: TaskProblem[] }> {
    await this.enter("list", o);
    let rows = [...this.rows.values()].filter((r) => filter.state.includes(this.stateOf(r)));
    if (filter.status !== undefined) rows = rows.filter((r) => r.status === filter.status);
    if (filter.priority !== undefined) rows = rows.filter((r) => r.priority === filter.priority);
    if (filter.run !== undefined) rows = rows.filter((r) => r.runs.includes(filter.run as string));
    if (filter.parent !== undefined) {
      const parent = this.find(filter.parent)?.key;
      rows = rows.filter((r) => r.parent !== undefined && r.parent === parent);
    }
    if (filter.top_level === true) rows = rows.filter((r) => r.parent === undefined);
    rows.sort((a, b) => this.order(a, b));
    if (filter.cursor !== undefined) {
      const [rank, seq] = filter.cursor.split(".").map(Number) as [number, number];
      if (!Number.isInteger(rank) || !Number.isInteger(seq))
        throw invalid("that cursor is not one of mine");
      rows = rows.filter((r) => this.rank(r) > rank || (this.rank(r) === rank && r.seq > seq));
    }
    const page = rows.slice(0, filter.limit);
    const last = page[page.length - 1];
    const out: {
      tasks: TaskSummary[];
      next?: string;
      truncated: boolean;
      problems: TaskProblem[];
    } = {
      tasks: page.map((r) => this.summary(r)),
      truncated: false,
      problems: [],
    };
    if (rows.length > page.length && last) out.next = `${this.rank(last)}.${last.seq}`;
    return out;
  }

  private isUnder(candidate: Row, ancestor: Row): boolean {
    for (
      let at: Row | undefined = candidate;
      at;
      at = at.parent ? this.rows.get(at.parent) : undefined
    ) {
      if (at.key === ancestor.key) return true;
    }
    return false;
  }

  async update(
    key: string,
    patch: TaskPatch,
    o: CallOptions,
  ): Promise<{ task: Task; open_subtasks?: number } | undefined> {
    await this.enter("update", o);
    const row = this.find(key);
    if (!row) return undefined;
    if (patch.type !== undefined)
      throw new KodelError("TASK_UNSUPPORTED", "this tracker has no task types");
    if (patch.priority !== undefined) this.checkPriority(patch.priority);
    if (patch.fields !== undefined) this.checkFields(patch.fields);
    let newParent: Row | undefined;
    if (patch.parent !== undefined) {
      newParent = this.parentOf(patch.parent);
      if (this.isUnder(newParent, row)) {
        throw invalid(`${newParent.key} is ${row.key} or below it: that would make a cycle`);
      }
    }
    if (patch.status !== undefined) {
      this.checkStatus(patch.status);
      if (!this.allows(row.status, patch.status)) {
        const reachable = STATUSES.filter((s) => this.allows(row.status, s.name)).map(
          (s) => s.name,
        );
        throw new KodelError(
          "TASK_TRANSITION_REFUSED",
          `"${row.status}" cannot move to "${patch.status}"; it can move to: ${reachable.join(", ")}`,
        );
      }
    }
    const wasDone = this.stateOf(row) === "done";
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.body !== undefined) row.body = patch.body;
    if (patch.comment !== undefined) row.comments.push({ text: patch.comment, at: this.now() });
    if (patch.add_run !== undefined && !row.runs.includes(patch.add_run))
      row.runs.push(patch.add_run);
    if (newParent) row.parent = newParent.key;
    if (patch.fields !== undefined) Object.assign(row.fields, patch.fields);
    for (const name of patch.clear ?? []) {
      if (name === "body") delete row.body;
      else if (name === "priority") delete row.priority;
      else if (name === "parent") delete row.parent;
      else if (name === "type")
        throw new KodelError("TASK_UNSUPPORTED", "this tracker has no task types");
      else delete row.fields[name.slice("fields.".length)];
    }
    row.updated_at = this.now();
    const out: { task: Task; open_subtasks?: number } = { task: this.toTask(row) };
    if (!wasDone && this.stateOf(row) === "done") {
      const open = this.children(row.key).filter((k) => this.stateOf(k) !== "done").length;
      if (open > 0) out.open_subtasks = open;
    }
    return out;
  }

  async verify(o: CallOptions): Promise<TaskProblem[]> {
    await this.enter("verify", o);
    return [];
  }
}
