/**
 * The task contract: what an adapter (the local files, a tracker such as Jira) implements, and what
 * the `TaskService` and the tools built on it rely on. Pure: no file system, clock, network or
 * randomness of its own; all of it comes in through the adapter and its context.
 *
 * Compatibility rules (see the plan): inside a major version everything new is optional. A new
 * capability reads as `caps.x === true` (off by default), a new method or a new field of a type is
 * optional. An unknown `state` counts as `todo`, an unknown capability value as "off".
 */
import { KodelError } from "./errors";
import { RUN_ID_PATTERN } from "./run-id";

/** The version of the adapter contract; an adapter declares the one it was written for. */
export const TASK_CONTRACT = 1;

// ── vocabulary ──────────────────────────────────────────────────────────────

export const TASK_STATES = ["todo", "progress", "done"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** What `task_list` shows when it is not told otherwise: everything that is not finished. */
export const OPEN_STATES: readonly TaskState[] = ["todo", "progress"];

export const isTaskState = (value: unknown): value is TaskState =>
  typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);

/** A consumer that meets a state it does not know (a later contract) treats it as `todo`. */
export const readState = (value: unknown): TaskState => (isTaskState(value) ? value : "todo");

export const FIELD_KINDS = [
  "text",
  "number",
  "boolean",
  "date",
  "select",
  "multiselect",
  "user",
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export type FieldValue = string | number | boolean | string[];

// ── limits (free text from the agent is bounded; it ends up in the history) ──

export const TASK_LIMITS = {
  title: 200,
  body: 4_000,
  comment: 500,
  /** A status, priority, type or field name. */
  name: 100,
  fields: 20,
  fieldName: 64,
  fieldString: 500,
  fieldList: 20,
  /** A key as a person typed it (it may be a URL) and as an adapter resolved it. */
  keyInput: 300,
  key: 64,
  cursor: 1_000,
  listDefault: 50,
  listMax: 200,
  subtasks: 100,
  /** Comments `task_get` returns. */
  comments: 20,
  /** What `task_schema` returns per list, and the length of a description. */
  schemaValues: 50,
  description: 300,
  summaryFields: 5,
  runs: 100,
} as const;

/** What `clear` may name: the optional scalar fields, and `fields.<name>`. */
export const CLEARABLE = ["body", "priority", "type", "parent"] as const;
const CLEAR_FIELD = /^fields\.(.{1,64})$/;

// ── what an adapter describes ───────────────────────────────────────────────

export interface StatusInfo {
  name: string;
  state: TaskState;
  description?: string;
}
export interface PriorityInfo {
  name: string;
  description?: string;
}
export interface TypeInfo {
  name: string;
  description?: string;
}
export interface FieldInfo {
  id?: string;
  name: string;
  kind: FieldKind;
  required: boolean;
  /** The agent cannot write it (an assignee, a sprint). */
  readonly?: boolean;
  /** Its value goes into `TaskSummary`; at most `TASK_LIMITS.summaryFields` per adapter. */
  summary?: boolean;
  allowed?: string[];
  description?: string;
}
export interface TransitionInfo {
  to: string;
  via?: string;
  requires?: string[];
}
export interface TaskSchema {
  statuses: StatusInfo[];
  /** Most important first; absent when the tracker has none. */
  priorities?: PriorityInfo[];
  types?: TypeInfo[];
  /** The fields for creating a task of `type` (if one was asked for). */
  fields: FieldInfo[];
  /** Only when a key was given. */
  transitions?: TransitionInfo[];
  truncated?: boolean;
}

// ── tasks ───────────────────────────────────────────────────────────────────

export interface Comment {
  text: string;
  at: string;
  by?: string;
}

export interface Task {
  /** The tracker's immutable id, when it has one (the `local` adapter: the key suffix). */
  id?: string;
  /** What a person types; opaque to the core. */
  key: string;
  title: string;
  body?: string;
  /** The tracker's own name of the status. */
  status: string;
  state: TaskState;
  priority?: string;
  type?: string;
  /** The latest note: the last entry of `comments`. */
  comment?: string;
  /** Newest last; `get` returns the last `TASK_LIMITS.comments`. */
  comments?: Comment[];
  comments_truncated?: boolean;
  parent?: string;
  /** `[]` when the adapter has no runs. */
  runs: string[];
  fields?: Record<string, FieldValue>;
  url?: string;
  /** ISO 8601, set by the adapter (a tracker has its own clock). */
  created_at: string;
  updated_at: string;
}

/**
 * An explicit list of fields, not "Task minus ...": a heavy field added to `Task` later must not
 * reach the lists without somebody deciding it should.
 */
export interface TaskSummary {
  id?: string;
  key: string;
  title: string;
  status: string;
  state: TaskState;
  priority?: string;
  type?: string;
  comment?: string;
  parent?: string;
  url?: string;
  /** Direct children only. */
  subtasks?: { done: number; total: number };
  run_count?: number;
  /** Only the fields declared with `summary: true`. */
  fields?: Record<string, FieldValue>;
}

export interface SubtaskRef {
  id?: string;
  key: string;
  title: string;
}

/** Already validated and redacted by the service. */
export interface NewTask {
  title: string;
  body?: string;
  priority?: string;
  type?: string;
  comment?: string;
  run?: string;
  parent?: string;
  fields?: Record<string, FieldValue>;
}

/** `undefined` leaves a field alone; `null` is never used: clearing is the explicit `clear`. */
export interface TaskPatch {
  status?: string;
  priority?: string;
  type?: string;
  title?: string;
  body?: string;
  /** Appends a note; a note cannot be removed. */
  comment?: string;
  add_run?: string;
  /** Moves the task under another parent. */
  parent?: string;
  fields?: Record<string, FieldValue>;
  /** `body`, `priority`, `type`, `parent` or `fields.<name>`. */
  clear?: string[];
}

export interface TaskFilter {
  state: TaskState[];
  /** An exact status name from the schema. */
  status?: string;
  priority?: string;
  run?: string;
  parent?: string;
  top_level?: boolean;
  limit: number;
  /** Opaque: the `next` of the previous page. */
  cursor?: string;
}

export interface TaskProblem {
  key?: string;
  message: string;
}

// ── the adapter ─────────────────────────────────────────────────────────────

export interface TaskAdapterCapabilities {
  subtasks: boolean;
  /** `attach`: `add_run` works, filtering by run does not. */
  runs: "none" | "attach" | "full";
  /** Other values may come later; a value the core does not know reads as "none". */
  comment: "none" | "append";
  fields: boolean;
  /** The tracker has priorities (`task_schema` lists them); without them the parameters are not offered. */
  priority: boolean;
  /** The tracker has task types. */
  types: boolean;
}

export interface CallOptions {
  signal: AbortSignal;
}

export interface TaskAdapter {
  /** The task contract this adapter was written for. */
  readonly contract: 1;
  readonly kind: string;
  readonly capabilities: TaskAdapterCapabilities;
  /** Turn what a person typed (a key, an id, a URL) into a key; `undefined` if it cannot be one. */
  resolveKey(input: string, o: CallOptions): Promise<string | undefined>;
  schema(query: { key?: string; type?: string }, o: CallOptions): Promise<TaskSchema>;
  create(input: NewTask, o: CallOptions): Promise<Task>;
  /** `undefined` for an unknown key. The key may be an id too. */
  get(
    key: string,
    o: CallOptions,
  ): Promise<{ task: Task; subtasks: SubtaskRef[]; subtasks_truncated?: boolean } | undefined>;
  list(
    filter: TaskFilter,
    o: CallOptions,
  ): Promise<{ tasks: TaskSummary[]; next?: string; truncated: boolean; problems: TaskProblem[] }>;
  /** `undefined` for an unknown key. */
  update(
    key: string,
    patch: TaskPatch,
    o: CallOptions,
  ): Promise<{ task: Task; open_subtasks?: number } | undefined>;
  /** For `kodel task doctor`: what is wrong with the setup, empty when nothing. */
  verify?(o: CallOptions): Promise<TaskProblem[]>;
}

/**
 * The core context holds no I/O. The host closes over what its adapter needs besides these (the
 * store root, the environment, `fetch`) when it registers the factory.
 */
export interface TaskAdapterContext {
  /** `tasks.adapters.<kind>` of the config, unchecked: the adapter validates it. */
  options: unknown;
  /** Milliseconds since the epoch. */
  clock: () => number;
  random: () => number;
}
export type TaskAdapterFactory = (ctx: TaskAdapterContext) => TaskAdapter | Promise<TaskAdapter>;

export class TaskAdapterRegistry {
  private readonly factories = new Map<string, TaskAdapterFactory>();

  register(kind: string, factory: TaskAdapterFactory): void {
    if (this.factories.has(kind)) {
      throw new KodelError("CONFIG_INVALID", `the task adapter "${kind}" is registered twice`);
    }
    this.factories.set(kind, factory);
  }

  kinds(): string[] {
    return [...this.factories.keys()].sort();
  }

  async create(kind: string, ctx: TaskAdapterContext): Promise<TaskAdapter> {
    const factory = this.factories.get(kind);
    if (!factory) {
      throw new KodelError(
        "CONFIG_INVALID",
        `unknown task adapter "${kind}" (tasks.adapter); known: ${this.kinds().join(", ") || "none"}`,
      );
    }
    const adapter = await factory(ctx);
    // An adapter written for another contract is refused with a message that names both, never
    // run in the hope that it fits.
    const declared: unknown = adapter.contract;
    if (declared !== TASK_CONTRACT) {
      throw new KodelError(
        "CONFIG_INVALID",
        `the task adapter "${kind}" was written for task contract ${String(declared)}; this kodel supports ${TASK_CONTRACT}`,
      );
    }
    if (adapter.kind !== kind) {
      throw new KodelError(
        "CONFIG_INVALID",
        `the task adapter registered as "${kind}" says it is "${adapter.kind}"`,
      );
    }
    return adapter;
  }
}

// ── checks of what the agent (or the CLI) sends ─────────────────────────────

const invalid = (message: string) => new KodelError("INVALID_TASK", message);
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is what the check is for
const CONTROL = /[\u0000-\u001f\u007f]/;

function text(what: string, value: unknown, max: number, oneLine: boolean): string {
  if (typeof value !== "string") throw invalid(`${what} must be text`);
  if (value.trim() === "") throw invalid(`${what} must not be empty`);
  if (value.length > max) throw invalid(`${what} is longer than ${max} characters`);
  if (oneLine && /[\r\n]/.test(value)) throw invalid(`${what} must be one line`);
  return value;
}

/** A name from the schema (a status, a priority, a type), or a field name. */
export function checkName(what: string, value: unknown, max: number = TASK_LIMITS.name): string {
  const name = text(what, value, max, true);
  if (CONTROL.test(name)) throw invalid(`${what} has control characters`);
  return name;
}

/** A key, an id or a URL as a person typed it. */
export function checkKeyInput(what: string, value: unknown): string {
  const input = checkName(what, value, TASK_LIMITS.keyInput);
  return input.trim();
}

/** What an adapter answered: a key the core can hand on. */
export function checkResolvedKey(value: string): string {
  if (value === "" || value.length > TASK_LIMITS.key || CONTROL.test(value)) {
    throw new KodelError(
      "TASK_ADAPTER_FAILED",
      `the adapter returned a key that is not valid (1-${TASK_LIMITS.key} printable characters)`,
    );
  }
  return value;
}

export function checkRunId(what: string, value: unknown): string {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw invalid(`${what} is not a run id`);
  }
  return value;
}

export function checkFields(value: unknown): Record<string, FieldValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("fields must be an object of name → value");
  }
  const entries = Object.entries(value);
  if (entries.length > TASK_LIMITS.fields) {
    throw invalid(`fields has more than ${TASK_LIMITS.fields} entries`);
  }
  // A plain object made with no prototype and no name that could reach one.
  const out: Record<string, FieldValue> = Object.create(null) as Record<string, FieldValue>;
  for (const [name, raw] of entries) {
    checkName("a field name", name, TASK_LIMITS.fieldName);
    if (name === "__proto__" || name === "constructor" || name === "prototype") {
      throw invalid(`"${name}" is not a field name`);
    }
    out[name] = fieldValue(name, raw);
  }
  return { ...out };
}

function fieldValue(name: string, raw: unknown): FieldValue {
  if (typeof raw === "string") {
    if (raw.length > TASK_LIMITS.fieldString) {
      throw invalid(
        `the value of field "${name}" is longer than ${TASK_LIMITS.fieldString} characters`,
      );
    }
    return raw;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "boolean") return raw;
  if (Array.isArray(raw)) {
    if (raw.length > TASK_LIMITS.fieldList) {
      throw invalid(`the value of field "${name}" has more than ${TASK_LIMITS.fieldList} items`);
    }
    return raw.map((item) => {
      if (typeof item !== "string" || item.length > TASK_LIMITS.fieldString) {
        throw invalid(
          `the items of field "${name}" must be text of at most ${TASK_LIMITS.fieldString} characters`,
        );
      }
      return item;
    });
  }
  throw invalid(
    `the value of field "${name}" must be text, a number, true/false or a list of text`,
  );
}

export function validateNewTask(input: NewTask): void {
  text("title", input.title, TASK_LIMITS.title, true);
  if (input.body !== undefined) {
    if (typeof input.body !== "string" || input.body.length > TASK_LIMITS.body) {
      throw invalid(`body must be text of at most ${TASK_LIMITS.body} characters`);
    }
  }
  if (input.comment !== undefined) text("comment", input.comment, TASK_LIMITS.comment, false);
  if (input.priority !== undefined) checkName("priority", input.priority);
  if (input.type !== undefined) checkName("type", input.type);
  if (input.run !== undefined) checkRunId("run", input.run);
  if (input.parent !== undefined) checkKeyInput("parent", input.parent);
  if (input.fields !== undefined) checkFields(input.fields);
}

export function validatePatch(patch: TaskPatch): void {
  const keys = Object.keys(patch).filter(
    (k) => (patch as Record<string, unknown>)[k] !== undefined,
  );
  if (keys.length === 0) {
    throw invalid("nothing to change: give at least one field besides the key");
  }
  if (patch.status !== undefined) checkName("status", patch.status);
  if (patch.priority !== undefined) checkName("priority", patch.priority);
  if (patch.type !== undefined) checkName("type", patch.type);
  if (patch.title !== undefined) text("title", patch.title, TASK_LIMITS.title, true);
  if (patch.body !== undefined) {
    if (typeof patch.body !== "string" || patch.body.length > TASK_LIMITS.body) {
      throw invalid(`body must be text of at most ${TASK_LIMITS.body} characters`);
    }
  }
  if (patch.comment !== undefined) text("comment", patch.comment, TASK_LIMITS.comment, false);
  if (patch.add_run !== undefined) checkRunId("add_run", patch.add_run);
  if (patch.parent !== undefined) checkKeyInput("parent", patch.parent);
  if (patch.fields !== undefined) checkFields(patch.fields);
  if (patch.clear !== undefined) {
    if (!Array.isArray(patch.clear) || patch.clear.length === 0 || patch.clear.length > 20) {
      throw invalid("clear must be a list of 1-20 names");
    }
    const seen = new Set<string>();
    for (const name of patch.clear) {
      const known =
        typeof name === "string" &&
        ((CLEARABLE as readonly string[]).includes(name) || CLEAR_FIELD.test(name));
      if (!known) {
        throw invalid(
          `cannot clear "${String(name)}"; clear takes ${CLEARABLE.join(", ")} or fields.<name>`,
        );
      }
      if (seen.has(name)) throw invalid(`"${name}" is listed twice in clear`);
      seen.add(name);
      const set =
        name === "body"
          ? patch.body
          : name === "priority"
            ? patch.priority
            : name === "type"
              ? patch.type
              : name === "parent"
                ? patch.parent
                : undefined;
      if (set !== undefined) throw invalid(`"${name}" is both set and cleared`);
      if (
        name.startsWith("fields.") &&
        patch.fields &&
        name.slice("fields.".length) in patch.fields
      ) {
        throw invalid(`"${name}" is both set and cleared`);
      }
    }
  }
}

export function validateFilter(filter: TaskFilter): void {
  if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > TASK_LIMITS.listMax) {
    throw invalid(`limit must be a whole number from 1 to ${TASK_LIMITS.listMax}`);
  }
  if (!filter.state.every(isTaskState) || filter.state.length === 0) {
    throw invalid(`state must be a list of ${TASK_STATES.join(", ")}`);
  }
  if (filter.status !== undefined) checkName("status", filter.status);
  if (filter.priority !== undefined) checkName("priority", filter.priority);
  if (filter.run !== undefined) checkRunId("run", filter.run);
  if (filter.parent !== undefined) checkKeyInput("parent", filter.parent);
  if (filter.cursor !== undefined) {
    if (
      typeof filter.cursor !== "string" ||
      filter.cursor === "" ||
      filter.cursor.length > TASK_LIMITS.cursor
    ) {
      throw invalid("cursor must be the `next` of a previous answer");
    }
  }
}
