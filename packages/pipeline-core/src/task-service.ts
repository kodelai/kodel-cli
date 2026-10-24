/**
 * The service behind the task tools and the `kodel task` commands. It stands between a caller (an
 * agent through MCP, a person through the CLI) and a `TaskAdapter`, and it is where the rules that
 * do not depend on the tracker live: input limits, `redact` before anything reaches the adapter
 * (principle 3), capability checks, resolving keys, the timeout, and turning every failure into
 * `{ ok:false, code, message, details? }`. Transport-free, like the rest of the core.
 */
import { KodelError } from "./errors";
import { redactDeep, redactText } from "./redact";
import { failure, type ToolResult } from "./service";
import {
  type CallOptions,
  checkKeyInput,
  checkName,
  checkResolvedKey,
  type FieldValue,
  type NewTask,
  OPEN_STATES,
  TASK_LIMITS,
  type Task,
  type TaskAdapter,
  type TaskFilter,
  type TaskPatch,
  type TaskProblem,
  type TaskSchema,
  type TaskState,
  validateFilter,
  validateNewTask,
  validatePatch,
} from "./tasks";

export interface TaskServiceOptions {
  /** How long one call of the adapter may take; the default is 30 seconds. */
  timeoutMs?: number;
  /** A host clock (ms). Without it the schema is not cached: the core has no clock of its own. */
  now?: () => number;
  /** How long a schema is kept; only with `now`. */
  schemaTtlMs?: number;
}

export const DEFAULT_TASK_TIMEOUT_MS = 30_000;
export const DEFAULT_SCHEMA_TTL_MS = 5 * 60_000;

const ok = (data: Record<string, unknown>): ToolResult => ({ ok: true, ...data });

/**
 * What an adapter reports as wrong (`problems`) may carry text from files or a tracker: it is cut,
 * counted and redacted before it goes on to the agent or the terminal.
 */
const MAX_PROBLEMS = 50;
function cleanProblems(problems: TaskProblem[]): TaskProblem[] {
  const out = problems.slice(0, MAX_PROBLEMS).map((p) => {
    const message = redactText(p.message);
    const clean: TaskProblem = {
      message: message.length > 300 ? `${message.slice(0, 299)}…` : message,
    };
    if (p.key !== undefined) clean.key = redactText(p.key).slice(0, TASK_LIMITS.key);
    return clean;
  });
  if (problems.length > MAX_PROBLEMS) {
    out.push({ message: `and ${problems.length - MAX_PROBLEMS} more problems` });
  }
  return out;
}

/** Field names are names, not values: one that redaction would change is a secret in the wrong place. */
function redactFields(fields: Record<string, FieldValue>): Record<string, FieldValue> {
  for (const name of Object.keys(fields)) {
    if (redactText(name) !== name) {
      throw new KodelError(
        "INVALID_TASK",
        "a field name looks like a secret; put values in values",
      );
    }
  }
  return redactDeep(fields);
}

const short = (text: string | undefined): string | undefined =>
  text !== undefined && text.length > TASK_LIMITS.description
    ? `${text.slice(0, TASK_LIMITS.description - 1)}…`
    : text;

/** Bound what `task_schema` answers: a project may have hundreds of values and long texts. */
function limitSchema(schema: TaskSchema): TaskSchema {
  let truncated = schema.truncated === true;
  const cap = <T>(list: T[]): T[] => {
    if (list.length > TASK_LIMITS.schemaValues) truncated = true;
    return list.slice(0, TASK_LIMITS.schemaValues);
  };
  const described = <T extends { description?: string }>(item: T): T => {
    const description = short(item.description);
    return description === item.description || description === undefined
      ? item
      : { ...item, description };
  };
  const out: TaskSchema = {
    statuses: cap(schema.statuses).map(described),
    fields: cap(schema.fields).map((f) => {
      const trimmed = described(f);
      if (trimmed.allowed && trimmed.allowed.length > TASK_LIMITS.schemaValues) {
        truncated = true;
        return { ...trimmed, allowed: trimmed.allowed.slice(0, TASK_LIMITS.schemaValues) };
      }
      return trimmed;
    }),
  };
  if (schema.priorities) out.priorities = cap(schema.priorities).map(described);
  if (schema.types) out.types = cap(schema.types).map(described);
  if (schema.transitions) out.transitions = cap(schema.transitions);
  if (truncated) out.truncated = true;
  return out;
}

export class TaskService {
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, { at: number; schema: TaskSchema }>();

  constructor(
    readonly adapter: TaskAdapter,
    private readonly options: TaskServiceOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  }

  get capabilities() {
    return this.adapter.capabilities;
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  /** One call of the adapter, bounded in time. An adapter that ignores the signal is not waited for. */
  private async call<T>(work: (o: CallOptions) => Promise<T>): Promise<T> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const timedOut = new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () =>
          reject(
            new KodelError(
              "TASK_ADAPTER_FAILED",
              `the task adapter "${this.adapter.kind}" did not answer within ${Math.round(this.timeoutMs / 1000)} s`,
            ),
          ),
        { once: true },
      );
    });
    // The race may be won by the work; the timer then still fires and must not become an
    // unhandled rejection.
    timedOut.catch(() => undefined);
    return Promise.race([work({ signal }), timedOut]);
  }

  /** Turn anything an adapter threw into the failure shape; the text is redacted either way. */
  private async guarded(work: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof KodelError) {
        return failure(
          error.code,
          redactText(error.message),
          error.issues === undefined ? undefined : redactDeep(error.issues),
          error.details === undefined ? undefined : redactDeep(error.details),
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return failure("TASK_ADAPTER_FAILED", redactText(message));
    }
  }

  /** What an adapter said about the allowed values may have changed; ask it again next time. */
  private dropSchema(error: unknown): void {
    if (error instanceof KodelError && error.code === "INVALID_TASK") this.cache.clear();
  }

  private unsupported(what: string): KodelError {
    return new KodelError(
      "TASK_UNSUPPORTED",
      `the task adapter "${this.adapter.kind}" does not support ${what}`,
    );
  }

  private async resolve(what: string, input: unknown): Promise<string> {
    const typed = checkKeyInput(what, input);
    const key = await this.call((o) => this.adapter.resolveKey(typed, o));
    if (key === undefined) {
      throw new KodelError("TASK_NOT_FOUND", `there is no task "${redactText(typed)}"`);
    }
    return checkResolvedKey(key);
  }

  /** The adapter is not asked for what it has said it cannot do. */
  private requireCapabilities(input: {
    parent?: string;
    run?: string;
    add_run?: string;
    comment?: string;
    fields?: Record<string, unknown>;
    clear?: string[];
    priority?: string;
    type?: string;
  }): void {
    const caps = this.adapter.capabilities;
    if (input.priority !== undefined && !caps.priority) throw this.unsupported("priorities");
    if (input.type !== undefined && !caps.types) throw this.unsupported("task types");
    if (input.parent !== undefined && !caps.subtasks) throw this.unsupported("subtasks (parent)");
    if ((input.run !== undefined || input.add_run !== undefined) && caps.runs === "none") {
      throw this.unsupported("attaching runs");
    }
    if (input.comment !== undefined && caps.comment === "none") {
      throw this.unsupported("comments");
    }
    if (input.fields !== undefined && !caps.fields) throw this.unsupported("fields");
    for (const name of input.clear ?? []) {
      if (name === "parent" && !caps.subtasks) throw this.unsupported("subtasks (parent)");
      if (name === "priority" && !caps.priority) throw this.unsupported("priorities");
      if (name === "type" && !caps.types) throw this.unsupported("task types");
      if (name.startsWith("fields.") && !caps.fields) throw this.unsupported("fields");
    }
  }

  // ── the tools ─────────────────────────────────────────────────────────────

  schema(input: { key?: string; type?: string } = {}): Promise<ToolResult> {
    return this.guarded(async () => {
      const type = input.type === undefined ? undefined : checkName("type", input.type);
      if (type !== undefined && !this.adapter.capabilities.types) {
        throw this.unsupported("task types");
      }
      const key = input.key === undefined ? undefined : await this.resolve("key", input.key);
      const schema = limitSchema(await this.loadSchema(key, type));
      return ok({
        adapter: this.adapter.kind,
        capabilities: this.adapter.capabilities,
        ...schema,
      });
    });
  }

  private async loadSchema(key: string | undefined, type: string | undefined): Promise<TaskSchema> {
    const now = this.options.now;
    // A schema for a task depends on the task's status: not cached.
    const cacheable = now !== undefined && key === undefined;
    const slot = type ?? "";
    if (cacheable) {
      const hit = this.cache.get(slot);
      const ttl = this.options.schemaTtlMs ?? DEFAULT_SCHEMA_TTL_MS;
      if (hit && now() - hit.at < ttl) return hit.schema;
    }
    const query: { key?: string; type?: string } = {};
    if (key !== undefined) query.key = key;
    if (type !== undefined) query.type = type;
    const schema = await this.call((o) => this.adapter.schema(query, o));
    if (cacheable) this.cache.set(slot, { at: now(), schema });
    return schema;
  }

  create(input: NewTask): Promise<ToolResult> {
    return this.guarded(async () => {
      validateNewTask(input);
      this.requireCapabilities(input);
      const next: NewTask = { ...input, title: redactText(input.title) };
      if (input.body !== undefined) next.body = redactText(input.body);
      if (input.comment !== undefined) next.comment = redactText(input.comment);
      if (input.fields !== undefined) next.fields = redactFields(input.fields);
      if (input.parent !== undefined) next.parent = await this.resolve("parent", input.parent);
      try {
        const task = await this.call((o) => this.adapter.create(next, o));
        return ok({ task });
      } catch (error) {
        this.dropSchema(error);
        throw error;
      }
    });
  }

  list(input: Partial<TaskFilter> = {}): Promise<ToolResult> {
    return this.guarded(async () => {
      const filter: TaskFilter = {
        state: [...new Set(input.state ?? OPEN_STATES)] as TaskState[],
        limit: input.limit ?? TASK_LIMITS.listDefault,
      };
      if (input.status !== undefined) filter.status = input.status;
      if (input.priority !== undefined) filter.priority = input.priority;
      if (input.run !== undefined) filter.run = input.run;
      if (input.parent !== undefined) filter.parent = input.parent;
      if (input.top_level !== undefined) filter.top_level = input.top_level;
      if (input.cursor !== undefined) filter.cursor = input.cursor;
      validateFilter(filter);
      const caps = this.adapter.capabilities;
      if (filter.priority !== undefined && !caps.priority) throw this.unsupported("priorities");
      if (filter.run !== undefined && caps.runs !== "full") {
        throw this.unsupported("filtering by run");
      }
      if ((filter.parent !== undefined || filter.top_level !== undefined) && !caps.subtasks) {
        throw this.unsupported("subtasks (parent)");
      }
      if (filter.parent !== undefined) filter.parent = await this.resolve("parent", filter.parent);
      const answer = await this.call((o) => this.adapter.list(filter, o));
      // An adapter that hands back more than it was asked for is bounded, not trusted.
      const over = answer.tasks.length > filter.limit;
      const out: Record<string, unknown> = {
        tasks: over ? answer.tasks.slice(0, filter.limit) : answer.tasks,
        truncated: answer.truncated || over,
        problems: cleanProblems(answer.problems),
      };
      if (answer.next !== undefined && !over) out.next = answer.next;
      return ok(out);
    });
  }

  get(input: { key: string }): Promise<ToolResult> {
    return this.guarded(async () => {
      const key = await this.resolve("key", input.key);
      const found = await this.call((o) => this.adapter.get(key, o));
      if (!found) throw new KodelError("TASK_NOT_FOUND", `there is no task "${redactText(key)}"`);
      const task = { ...found.task };
      if (task.comments && task.comments.length > TASK_LIMITS.comments) {
        task.comments = task.comments.slice(-TASK_LIMITS.comments);
        task.comments_truncated = true;
      }
      const tooMany = found.subtasks.length > TASK_LIMITS.subtasks;
      const out: Record<string, unknown> = {
        task,
        subtasks: tooMany ? found.subtasks.slice(0, TASK_LIMITS.subtasks) : found.subtasks,
      };
      if (tooMany || found.subtasks_truncated) out.subtasks_truncated = true;
      return ok(out);
    });
  }

  update(input: { key: string } & TaskPatch): Promise<ToolResult> {
    return this.guarded(async () => {
      const { key: typed, ...patch } = input;
      validatePatch(patch);
      this.requireCapabilities(patch);
      const next: TaskPatch = { ...patch };
      if (patch.title !== undefined) next.title = redactText(patch.title);
      if (patch.body !== undefined) next.body = redactText(patch.body);
      if (patch.comment !== undefined) next.comment = redactText(patch.comment);
      if (patch.fields !== undefined) next.fields = redactFields(patch.fields);
      const key = await this.resolve("key", typed);
      if (patch.parent !== undefined) next.parent = await this.resolve("parent", patch.parent);
      try {
        const done = await this.call((o) => this.adapter.update(key, next, o));
        if (!done) throw new KodelError("TASK_NOT_FOUND", `there is no task "${redactText(key)}"`);
        const out: Record<string, unknown> = { task: done.task };
        if (done.open_subtasks !== undefined && done.open_subtasks > 0) {
          out.open_subtasks = done.open_subtasks;
        }
        return ok(out);
      } catch (error) {
        this.dropSchema(error);
        throw error;
      }
    });
  }

  // ── for the tie between a run and a task (see run-task.ts) ────────────────
  // These throw `KodelError` instead of answering with the failure shape: the caller decides which
  // failures stop a start and which only become a warning.

  /** The task a person named, as the tracker has it. */
  async taskForRun(typed: string): Promise<Task> {
    const key = await this.resolve("task_key", typed);
    const found = await this.call((o) => this.adapter.get(key, o));
    if (!found) throw new KodelError("TASK_NOT_FOUND", `there is no task "${redactText(key)}"`);
    return found.task;
  }

  /**
   * Move a task to a state and note the run on it. The status is picked by `state` from the schema,
   * never by its name: a tracker names its statuses as it likes. A status the task already has is
   * not sent again; without `state` only the note is added. With a schema that lists the moves allowed, one of those is taken.
   */
  async advanceForRun(
    task: Task,
    state: "progress" | "done" | undefined,
    note: { comment: string; add_run?: string },
  ): Promise<Task> {
    const patch: TaskPatch = {};
    if (this.adapter.capabilities.comment !== "none") patch.comment = redactText(note.comment);
    if (note.add_run !== undefined && this.adapter.capabilities.runs !== "none") {
      patch.add_run = note.add_run;
    }
    if (state !== undefined && task.state !== state) {
      const schema = await this.loadSchema(task.key, undefined);
      const allowed = schema.transitions?.map((t) => t.to);
      const candidates = schema.statuses.filter(
        (s) => s.state === state && (allowed === undefined || allowed.includes(s.name)),
      );
      const chosen = candidates.find((s) => s.name.toLowerCase() === state) ?? candidates[0];
      if (!chosen) {
        throw new KodelError(
          "TASK_TRANSITION_REFUSED",
          `the tracker offers no status in state "${state}" for task ${redactText(task.key)}`,
        );
      }
      patch.status = chosen.name;
    }
    if (patch.status === undefined && patch.comment === undefined && patch.add_run === undefined) {
      return task;
    }
    const done = await this.call((o) => this.adapter.update(task.key, patch, o));
    if (!done) throw new KodelError("TASK_NOT_FOUND", `there is no task "${redactText(task.key)}"`);
    return done.task;
  }

  /** For `kodel task doctor`: what the adapter finds wrong with its setup. */
  verify(): Promise<ToolResult> {
    return this.guarded(async () => {
      const problems = this.adapter.verify
        ? await this.call((o) => (this.adapter.verify as NonNullable<TaskAdapter["verify"]>)(o))
        : [];
      return ok({ adapter: this.adapter.kind, problems: cleanProblems(problems) });
    });
  }
}
