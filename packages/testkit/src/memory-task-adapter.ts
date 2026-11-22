/**
 * A task adapter that keeps its tasks in memory, written to look like a *tracker* and not like the
 * `local` adapter: its own status and priority names, keys that differ from ids, a priority that can
 * be empty, a workflow that can forbid a move, declared fields (one read-only), and hooks to make
 * a call fail or hang. It is what the service and tool tests run on, and the second subject of the
 * adapter conformance suite.
 */
import {
  applyLinkPatch,
  blockedBy,
  type CallOptions,
  type Comment,
  dependencyRefs,
  type FieldInfo,
  type FieldValue,
  findCycle,
  hasLinkPatch,
  KodelError,
  type NewTask,
  needsApproval,
  type StatusInfo,
  type SubtaskRef,
  spellCycle,
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
  /** The time in milliseconds; by default a clock that moves one second at every write. */
  clock?: () => number;
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
  created_by?: "agent";
  created_in_run?: string;
  agent_edited_at?: string;
  approved_at?: string;
  depends_on: string[];
  /** The conflicts written on this task; the other side reads them too. */
  conflicts_with: string[];
}

const DECLINED = "Won't Do";

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
      provenance: true,
      links: true,
      ...options.capabilities,
    };
  }

  private now(): string {
    if (this.options.clock !== undefined) return new Date(this.options.clock()).toISOString();
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
    if (this.capabilities.provenance === true) {
      if (row.created_by !== undefined) task.created_by = row.created_by;
      if (row.created_in_run !== undefined) task.created_in_run = row.created_in_run;
      if (row.agent_edited_at !== undefined) task.agent_edited_at = row.agent_edited_at;
      if (row.approved_at !== undefined) task.approved_at = row.approved_at;
    }
    if (this.capabilities.links === true) this.addLinks(task, row);
    return task;
  }

  private conflictsOf(row: Row): string[] {
    const both = new Set(row.conflicts_with);
    for (const other of this.rows.values()) {
      if (other.conflicts_with.includes(row.key)) both.add(other.key);
    }
    both.delete(row.key);
    return [...both].sort();
  }

  private addLinks(task: Task | TaskSummary, row: Row): void {
    if (row.depends_on.length > 0) {
      task.depends_on = [...row.depends_on];
      task.dependencies = dependencyRefs(row.depends_on, (key) => {
        const dependency = this.rows.get(key);
        if (dependency === undefined) return undefined;
        return {
          closed: this.stateOf(dependency) === "done",
          declined: dependency.status === DECLINED,
          needs_approval: this.capabilities.provenance === true && needsApproval(dependency),
        };
      });
      const by = this.stateOf(row) === "done" ? [] : blockedBy(task);
      if (by.length > 0) task.blocked_by = by;
    }
    const blocks = [...this.rows.values()]
      .filter(
        (r) =>
          this.stateOf(row) !== "done" &&
          this.stateOf(r) !== "done" &&
          r.depends_on.includes(row.key),
      )
      .map((r) => r.key)
      .sort();
    if (blocks.length > 0) task.blocks = blocks;
    const conflicts = this.conflictsOf(row);
    if (conflicts.length > 0) task.conflicts_with = conflicts;
  }

  private linkKey(typed: string, what: string): string {
    const row = this.find(typed);
    if (!row) throw new KodelError("TASK_NOT_FOUND", `there is no task "${typed}" (${what})`);
    return row.key;
  }

  private noLinks(): KodelError {
    return new KodelError("TASK_UNSUPPORTED", "this tracker has no task links");
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
    if (needsApproval(task)) s.needs_approval = true;
    if (task.created_in_run !== undefined) s.created_in_run = task.created_in_run;
    s.created_at = task.created_at;
    if (this.capabilities.links === true) this.addLinks(s, row);
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
    const linked = input.depends_on !== undefined || input.conflicts_with !== undefined;
    if (linked && this.capabilities.links !== true) throw this.noLinks();
    const dependsOn = [
      ...new Set((input.depends_on ?? []).map((k) => this.linkKey(k, "depends_on"))),
    ];
    const conflictsWith = [
      ...new Set((input.conflicts_with ?? []).map((k) => this.linkKey(k, "conflicts_with"))),
    ];
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
      depends_on: dependsOn,
      conflicts_with: conflictsWith,
    };
    if (input.body !== undefined) row.body = input.body;
    if (input.priority !== undefined) row.priority = input.priority;
    else if (this.capabilities.priority) row.priority = DEFAULT_PRIORITY;
    if (input.parent !== undefined) row.parent = this.parentOf(input.parent).key;
    if (this.capabilities.provenance === true) {
      if (input.created_by === "agent") row.created_by = "agent";
      if (input.run !== undefined) row.created_in_run = input.run;
    }
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
    let links: { depends_on: string[]; conflicts_with: string[] } | undefined;
    let dropped: string[] = [];
    if (hasLinkPatch(patch)) {
      if (this.capabilities.links !== true) throw this.noLinks();
      const known = (keys: string[] | undefined) => keys?.map((k) => this.find(k)?.key ?? k);
      const shown = this.conflictsOf(row);
      const next = applyLinkPatch(
        { depends_on: row.depends_on, conflicts_with: shown },
        {
          ...(patch.clear === undefined ? {} : { clear: patch.clear }),
          ...Object.fromEntries(
            (
              [
                "depends_on",
                "conflicts_with",
                "add_depends_on",
                "remove_depends_on",
                "add_conflicts_with",
                "remove_conflicts_with",
              ] as const
            ).flatMap((name) => (patch[name] === undefined ? [] : [[name, known(patch[name])]])),
          ),
        },
      );
      const addedDependencies = next.depends_on.filter((k) => !row.depends_on.includes(k));
      const addedConflicts = next.conflicts_with.filter((k) => !shown.includes(k));
      for (const added of [...addedDependencies, ...addedConflicts]) {
        if (added === row.key) throw invalid(`${row.key} cannot be linked to itself`);
        if (!this.rows.has(added)) {
          throw new KodelError("TASK_NOT_FOUND", `there is no task "${added}"`);
        }
      }
      if (
        next.depends_on.length > TASK_LIMITS.links ||
        next.conflicts_with.length > TASK_LIMITS.links
      ) {
        throw invalid(`a link list takes at most ${TASK_LIMITS.links} tasks`);
      }
      if (addedDependencies.length > 0) {
        const cycle = findCycle(row.key, next.depends_on, (k) => this.rows.get(k)?.depends_on);
        if (cycle !== undefined) {
          throw invalid(`that would make a cycle of depends_on: ${spellCycle(cycle)}`);
        }
      }
      links = {
        depends_on: next.depends_on,
        conflicts_with: next.conflicts_with.filter(
          (k) => row.conflicts_with.includes(k) || addedConflicts.includes(k),
        ),
      };
      dropped = shown.filter((k) => !next.conflicts_with.includes(k));
    }
    const wasDone = this.stateOf(row) === "done";
    const before = {
      title: row.title,
      body: row.body,
      status: row.status,
      priority: row.priority,
      parent: row.parent,
    };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.body !== undefined) row.body = patch.body;
    if (patch.comment !== undefined) row.comments.push({ text: patch.comment, at: this.now() });
    if (patch.add_run !== undefined && !row.runs.includes(patch.add_run))
      row.runs.push(patch.add_run);
    if (newParent) row.parent = newParent.key;
    if (patch.fields !== undefined) Object.assign(row.fields, patch.fields);
    if (links !== undefined) {
      row.depends_on = links.depends_on;
      row.conflicts_with = links.conflicts_with;
      for (const key of dropped) {
        const other = this.rows.get(key);
        if (other) other.conflicts_with = other.conflicts_with.filter((k) => k !== row.key);
      }
    }
    for (const name of patch.clear ?? []) {
      if (name === "body") delete row.body;
      else if (name === "priority") delete row.priority;
      else if (name === "parent") delete row.parent;
      else if (name === "type")
        throw new KodelError("TASK_UNSUPPORTED", "this tracker has no task types");
      else if (name !== "depends_on" && name !== "conflicts_with")
        delete row.fields[name.slice("fields.".length)];
    }
    row.updated_at = this.now();
    if (
      patch.by_agent === true &&
      this.capabilities.provenance === true &&
      (row.title !== before.title ||
        row.body !== before.body ||
        row.status !== before.status ||
        row.priority !== before.priority ||
        row.parent !== before.parent)
    ) {
      // Never before an approval, as the local adapter: an edit in the instant of an approval waits.
      const approved = row.approved_at;
      row.agent_edited_at =
        approved !== undefined && Date.parse(approved) > Date.parse(row.updated_at)
          ? approved
          : row.updated_at;
    }
    const out: { task: Task; open_subtasks?: number } = { task: this.toTask(row) };
    if (!wasDone && this.stateOf(row) === "done") {
      const open = this.children(row.key).filter((k) => this.stateOf(k) !== "done").length;
      if (open > 0) out.open_subtasks = open;
    }
    return out;
  }

  async approve(key: string, seen: string, o: CallOptions): Promise<Task | undefined> {
    await this.enter("approve", o);
    if (this.capabilities.provenance !== true) {
      throw new KodelError("TASK_UNSUPPORTED", "this tracker keeps no approvals");
    }
    const row = this.find(key);
    if (!row) return undefined;
    if (row.updated_at !== seen) {
      throw new KodelError(
        "TASK_TRANSITION_REFUSED",
        `${row.key} changed while you were reading; look again`,
      );
    }
    // Strictly later than the last agent edit, also when the clock has not moved since.
    const last = Math.max(
      Date.parse(row.created_at) || 0,
      Date.parse(row.agent_edited_at ?? "") || 0,
    );
    row.approved_at = new Date(Math.max(Date.parse(this.now()), last + 1)).toISOString();
    row.updated_at = row.approved_at;
    return this.toTask(row);
  }

  async verify(o: CallOptions): Promise<TaskProblem[]> {
    await this.enter("verify", o);
    return [];
  }
}
