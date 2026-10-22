/**
 * The `local` task adapter: one YAML file per task in `<store root>/tasks/<KEY>.yaml`.
 *
 * Keys are `<PREFIX>-<4 random characters>` with no counter, so nothing is shared between branches
 * or processes; the `id` is the suffix and is unique whatever the prefix. A task is a file, so
 * two branches that add tasks do not touch one file. `parent` is stored on the child only: the
 * parent's file is not written when a subtask is added.
 *
 * Stored data (AGENTS.md): `v: 1` on every record; a file written in a format this engine does not
 * know is reported, not hidden and not rewritten.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CallOptions,
  type Comment,
  KodelError,
  type NewTask,
  type StatusInfo,
  type SubtaskRef,
  TASK_CONTRACT,
  TASK_LIMITS,
  type Task,
  type TaskAdapter,
  type TaskAdapterCapabilities,
  type TaskAdapterContext,
  type TaskFilter,
  type TaskPatch,
  type TaskProblem,
  type TaskSchema,
  type TaskState,
  type TaskSummary,
} from "@kodel-ai/pipeline-core";
import { parse, stringify } from "yaml";
import { z } from "zod";

/** The format of the task files this engine writes. */
export const LOCAL_TASK_FORMAT = 1;
export const TASKS_DIR = "tasks";
export const DEFAULT_PREFIX = "TASK";

// No 0 O 1 I L U: a key read aloud or from a screen is not mistaken.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const SUFFIX_LENGTH = 4;
const SUFFIX_CLASS = "[2-9A-HJKMNP-TV-Z]{4}";
const KEY = new RegExp(`^([A-Z][A-Z0-9]{1,9})-(${SUFFIX_CLASS})$`);
const SUFFIX_ONLY = new RegExp(`^${SUFFIX_CLASS}$`);
const FILE = new RegExp(`^([A-Z][A-Z0-9]{1,9}-${SUFFIX_CLASS})\\.yaml$`);
const ATTEMPTS = 10;

// The files of a repository are not trusted (a repository may be somebody else's): what is read from
// them is bounded, so a hostile folder cannot freeze the server or flood the agent.
/** A task file is a few hundred bytes; one bigger than this is not read. */
export const MAX_FILE_BYTES = 64 * 1024;
/** The most task files the adapter reads or creates. */
export const MAX_TASKS = 5_000;
/** The most `problems` an answer carries (the rest are counted), and the longest quoted value. */
const MAX_PROBLEMS = 50;
const QUOTE = 40;
/** How long an update waits for another writer of the same task, and when a lock is stale. */
const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 15_000;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
/** A value taken from a file, as a short quoted string for a message. */
const quoted = (value: unknown): string => JSON.stringify(clip(String(value), QUOTE));

const STATUS_NAMES = ["todo", "progress", "done", "declined"] as const;
type StatusName = (typeof STATUS_NAMES)[number];
const STATUSES: (StatusInfo & { name: StatusName })[] = [
  { name: "todo", state: "todo", description: "Not started." },
  { name: "progress", state: "progress", description: "Being worked on." },
  { name: "done", state: "done", description: "Finished." },
  {
    name: "declined",
    state: "done",
    description: "Will not be done; the reason goes in a comment.",
  },
];
const PRIORITY_NAMES = ["high", "normal", "low"] as const;
type PriorityName = (typeof PRIORITY_NAMES)[number];
const PRIORITIES = [
  { name: "high", description: "Do it before the others." },
  { name: "normal", description: "The default." },
  { name: "low", description: "When there is time." },
];
const DEFAULT_PRIORITY: PriorityName = "normal";

const CAPABILITIES: TaskAdapterCapabilities = {
  subtasks: true,
  runs: "full",
  comment: "append",
  fields: false,
  priority: true,
  types: false,
};

const optionsSchema = z
  .object({
    prefix: z
      .string()
      .regex(
        /^[A-Z][A-Z0-9]{1,9}$/,
        "must be 2-10 capital letters or digits, starting with a letter",
      )
      .default(DEFAULT_PREFIX),
  })
  .strict();

/** The block `tasks.adapters.local` of the config; a missing block is an empty one. */
export function parseLocalOptions(options: unknown): { prefix: string } {
  const parsed = optionsSchema.safeParse(options ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const keys = first && "keys" in first ? `: ${(first.keys as string[]).join(", ")}` : "";
    const where = first?.path.join(".");
    throw new KodelError(
      "CONFIG_INVALID",
      `tasks.adapters.local: ${first?.message ?? "invalid"}${keys}${where ? ` (at "${where}")` : ""}`,
    );
  }
  return parsed.data;
}

const recordSchema = z
  .object({
    v: z.number().int().min(1),
    id: z.string().min(1),
    key: z.string().min(1),
    title: z.string().min(1),
    body: z.string().optional(),
    priority: z.enum(PRIORITY_NAMES),
    status: z.enum(STATUS_NAMES),
    comments: z
      .array(z.object({ at: z.string(), text: z.string(), by: z.string().optional() }))
      .optional(),
    parent: z.string().optional(),
    runs: z.array(z.string()).optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  // Keys a later minor of the format adds are kept when a task is rewritten.
  .passthrough();
type Rec = z.infer<typeof recordSchema>;

const FIELD_ORDER = [
  "v",
  "id",
  "key",
  "title",
  "body",
  "priority",
  "status",
  "comments",
  "parent",
  "runs",
  "created_at",
  "updated_at",
];

/** The file as a person reads it: the usual fields in a fixed order, anything extra after them. */
function serialize(record: Rec): string {
  const ordered: Record<string, unknown> = {};
  for (const name of FIELD_ORDER) if (record[name] !== undefined) ordered[name] = record[name];
  for (const [name, value] of Object.entries(record)) {
    if (!(name in ordered) && value !== undefined) ordered[name] = value;
  }
  return stringify(ordered);
}

const stateOf = (status: StatusName): TaskState =>
  STATUSES.find((s) => s.name === status)?.state ?? "todo";

const invalid = (message: string) => new KodelError("INVALID_TASK", message);
const priorityRank = (p: PriorityName) => PRIORITY_NAMES.indexOf(p);

interface Loaded {
  records: Map<string, Rec>;
  problems: TaskProblem[];
  /** The parent a task is shown under: none for an orphan or a member of a cycle. */
  parentOf: Map<string, string | undefined>;
  children: Map<string, Rec[]>;
}

export interface LocalTaskAdapterOptions {
  /** `<store root>/tasks` is where the files are. */
  storeRoot: string;
  prefix?: string;
  clock: () => number;
  random: () => number;
  /** The most tasks it reads or creates; `MAX_TASKS` unless a test says less. */
  maxTasks?: number;
}

export class LocalTaskAdapter implements TaskAdapter {
  readonly contract = TASK_CONTRACT;
  readonly kind = "local";
  readonly capabilities = CAPABILITIES;
  private readonly dir: string;
  private readonly prefix: string;
  private readonly maxTasks: number;

  constructor(private readonly options: LocalTaskAdapterOptions) {
    this.dir = join(options.storeRoot, TASKS_DIR);
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.maxTasks = options.maxTasks ?? MAX_TASKS;
  }

  // ── keys ──────────────────────────────────────────────────────────────────

  private file(key: string): string {
    // Only a key that matched the pattern gets here: no separator can be in it.
    return join(this.dir, `${key}.yaml`);
  }

  /**
   * The folder must be a real folder: one that is a link (a repository can commit one) would send
   * every read and write somewhere else. `undefined` when it is not there yet.
   */
  private async checkDir(): Promise<boolean> {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new KodelError(
        "TASK_ADAPTER_FAILED",
        `the tasks folder cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`,
      );
    }
    if (!info.isDirectory()) {
      throw new KodelError(
        "TASK_ADAPTER_FAILED",
        `the tasks folder (${TASKS_DIR}) is not a plain folder (a link, say); Kodel does not follow it`,
      );
    }
    return true;
  }

  private async ensureDir(): Promise<void> {
    if (!(await this.checkDir())) await mkdir(this.dir, { recursive: true });
  }

  private async names(): Promise<string[]> {
    if (!(await this.checkDir())) return [];
    return (await readdir(this.dir)).filter((n) => FILE.test(n)).sort();
  }

  // The files are local and quick: the call options (a timeout signal) are accepted and unused.
  async resolveKey(input: string, _o?: CallOptions): Promise<string | undefined> {
    const typed = input.trim().toUpperCase();
    if (KEY.test(typed)) return typed;
    if (SUFFIX_ONLY.test(typed)) {
      // A bare suffix is the id; it is unique whatever the prefix, so there is at most one.
      const found = (await this.names()).find((n) => n.endsWith(`-${typed}.yaml`));
      return found?.replace(/\.yaml$/, "");
    }
    return undefined;
  }

  private newSuffix(taken: Set<string>): string {
    for (let i = 0; i < 100; i += 1) {
      let suffix = "";
      for (let c = 0; c < SUFFIX_LENGTH; c += 1) {
        const at = Math.min(
          ALPHABET.length - 1,
          Math.floor(this.options.random() * ALPHABET.length),
        );
        suffix += ALPHABET[at];
      }
      if (!taken.has(suffix)) return suffix;
    }
    throw new KodelError(
      "TASK_KEY_UNAVAILABLE",
      "could not find a free key; is the tasks folder nearly full?",
    );
  }

  private now(): string {
    return new Date(this.options.clock()).toISOString();
  }

  // ── reading ───────────────────────────────────────────────────────────────

  private async readFileRecord(
    key: string,
  ): Promise<{ record: Rec } | { problem: string } | undefined> {
    // What is said about a file here never quotes its content: a problem is reported to the agent
    // and the terminal, and a hostile file must not be able to put its own words there.
    const path = this.file(key);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return { problem: `cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
    }
    // `lstat`, not `stat`: a link (a repository can commit one) is not followed to a file outside it.
    if (!info.isFile()) return { problem: "is not a plain file (a link, say); it is ignored" };
    if (info.size > MAX_FILE_BYTES) {
      return { problem: `is larger than ${MAX_FILE_BYTES / 1024} KB; it is ignored` };
    }
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return { problem: `cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
    }
    let raw: unknown;
    try {
      raw = parse(text);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return { problem: `is not valid YAML (${typeof code === "string" ? code : "syntax error"})` };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { problem: "is not a task record" };
    }
    const v = (raw as { v?: unknown }).v;
    if (typeof v === "number" && v > LOCAL_TASK_FORMAT) {
      return { problem: `was written in task format ${clip(String(v), 12)}; upgrade kodel` };
    }
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return { problem: `is not a valid task (${first?.path.join(".") || "record"})` };
    }
    const record = parsed.data;
    const suffix = key.slice(key.lastIndexOf("-") + 1);
    if (record.key !== key) return { problem: "holds another key than its name says" };
    if (record.id !== suffix) return { problem: "holds another id than its name says" };
    return { record };
  }

  /** Every task file of the folder, with what is wrong with the files that cannot be used. */
  private async load(): Promise<Loaded> {
    const records = new Map<string, Rec>();
    const problems: TaskProblem[] = [];
    const names = await this.names();
    if (names.length > this.maxTasks) {
      problems.push({
        message: `there are more than ${this.maxTasks} task files; only the first ${this.maxTasks} are read`,
      });
    }
    for (const name of names.slice(0, this.maxTasks)) {
      const key = name.replace(/\.yaml$/, "");
      const read = await this.readFileRecord(key);
      if (!read) continue;
      if ("problem" in read) problems.push({ key, message: `${name} ${read.problem}` });
      else records.set(key, read.record);
    }

    // Every chain of parents is walked once, so a long chain costs what it is long: a hostile
    // folder of thousands of files that name each other must not be able to freeze the server.
    const parentOf = new Map<string, string | undefined>();
    const cyclic = new Set<string>();
    const walked = new Set<string>();
    for (const start of records.keys()) {
      if (walked.has(start)) continue;
      const path: string[] = [];
      const onPath = new Set<string>();
      let at: string | undefined = start;
      while (at !== undefined && records.has(at) && !walked.has(at)) {
        if (onPath.has(at)) {
          for (const member of path.slice(path.indexOf(at))) cyclic.add(member);
          break;
        }
        onPath.add(at);
        path.push(at);
        at = records.get(at)?.parent;
      }
      for (const key of path) walked.add(key);
    }
    for (const [key, record] of records) {
      let parent = record.parent;
      if (parent !== undefined && !records.has(parent)) {
        problems.push({
          key,
          message: `${key} names the parent ${quoted(parent)}, which is not here (is its branch merged?); it is shown as a top-level task`,
        });
        parent = undefined;
      } else if (cyclic.has(key)) {
        problems.push({
          key,
          message: `${key} is part of a cycle of parents (two branches may have been merged); it is shown as a top-level task`,
        });
        parent = undefined;
      }
      parentOf.set(key, parent);
    }
    const children = new Map<string, Rec[]>();
    for (const [key, record] of records) {
      const parent = parentOf.get(key);
      if (parent === undefined) continue;
      const kids = children.get(parent);
      if (kids) kids.push(record);
      else children.set(parent, [record]);
    }
    if (problems.length > MAX_PROBLEMS) {
      const more = problems.length - MAX_PROBLEMS;
      problems.length = MAX_PROBLEMS;
      problems.push({ message: `and ${more} more problems` });
    }
    return { records, problems, parentOf, children };
  }

  private order = (a: Rec, b: Rec): number =>
    priorityRank(a.priority) - priorityRank(b.priority) ||
    (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  private toTask(record: Rec, parent: string | undefined): Task {
    // Writes are bounded by the core's limits; what is read is bounded again, because a file a
    // person did not write through the tools may say anything.
    const comments: Comment[] = (record.comments ?? []).map((c) => {
      const text = clip(c.text, TASK_LIMITS.comment);
      return c.by === undefined
        ? { text, at: clip(c.at, 40) }
        : { text, at: clip(c.at, 40), by: clip(c.by, 80) };
    });
    const last = comments[comments.length - 1];
    const task: Task = {
      id: record.id,
      key: record.key,
      title: clip(record.title, TASK_LIMITS.title),
      status: record.status,
      state: stateOf(record.status),
      priority: record.priority,
      runs: (record.runs ?? []).slice(0, TASK_LIMITS.runs).map((r) => clip(r, 40)),
      created_at: clip(record.created_at, 40),
      updated_at: clip(record.updated_at, 40),
    };
    if (record.body !== undefined) task.body = clip(record.body, TASK_LIMITS.body);
    if (last) {
      task.comment = last.text;
      task.comments = comments;
    }
    if (parent !== undefined) task.parent = parent;
    return task;
  }

  private summary(record: Rec, loaded: Loaded): TaskSummary {
    const comments = record.comments ?? [];
    const s: TaskSummary = {
      id: record.id,
      key: record.key,
      title: clip(record.title, TASK_LIMITS.title),
      status: record.status,
      state: stateOf(record.status),
      priority: record.priority,
      run_count: (record.runs ?? []).length,
    };
    const last = comments[comments.length - 1];
    if (last) s.comment = clip(last.text, TASK_LIMITS.comment);
    const parent = loaded.parentOf.get(record.key);
    if (parent !== undefined) s.parent = parent;
    const kids = loaded.children.get(record.key) ?? [];
    if (kids.length > 0) {
      s.subtasks = {
        total: kids.length,
        done: kids.filter((k) => stateOf(k.status) === "done").length,
      };
    }
    return s;
  }

  // ── the contract ──────────────────────────────────────────────────────────

  async schema(query: { key?: string; type?: string }, _o?: CallOptions): Promise<TaskSchema> {
    const schema: TaskSchema = { statuses: STATUSES, priorities: PRIORITIES, fields: [] };
    if (query.key !== undefined) {
      const key = await this.resolveKey(query.key);
      const read = key === undefined ? undefined : await this.readFileRecord(key);
      if (!read || "problem" in read) {
        throw new KodelError("TASK_NOT_FOUND", `there is no task "${query.key}"`);
      }
      schema.transitions = STATUSES.filter((s) => s.name !== read.record.status).map((s) => ({
        to: s.name,
      }));
    }
    return schema;
  }

  private checkPriority(name: string): PriorityName {
    if (!(PRIORITY_NAMES as readonly string[]).includes(name)) {
      throw invalid(
        `there is no priority "${name}"; the priorities are: ${PRIORITY_NAMES.join(", ")}`,
      );
    }
    return name as PriorityName;
  }

  private checkStatus(name: string): StatusName {
    if (!(STATUS_NAMES as readonly string[]).includes(name)) {
      throw invalid(`there is no status "${name}"; the statuses are: ${STATUS_NAMES.join(", ")}`);
    }
    return name as StatusName;
  }

  private unsupported(what: string): KodelError {
    return new KodelError("TASK_UNSUPPORTED", `the local task adapter has no ${what}`);
  }

  async create(input: NewTask, _o?: CallOptions): Promise<Task> {
    if (input.type !== undefined) throw this.unsupported("task types");
    if (input.fields !== undefined) throw this.unsupported("fields");
    const priority =
      input.priority === undefined ? DEFAULT_PRIORITY : this.checkPriority(input.priority);
    let parentKey: string | undefined;
    if (input.parent !== undefined) {
      parentKey = await this.resolveKey(input.parent);
      const read = parentKey === undefined ? undefined : await this.readFileRecord(parentKey);
      if (!read || "problem" in read) {
        throw new KodelError("TASK_NOT_FOUND", `there is no parent task "${input.parent}"`);
      }
    }
    const at = this.now();
    await this.ensureDir();
    const existing = await this.names();
    // A steered or runaway agent must not be able to fill the repository with tasks.
    if (existing.length >= this.maxTasks) {
      throw invalid(
        `the backlog already has ${this.maxTasks} tasks, the most the local adapter keeps; finish or decline some first`,
      );
    }
    const taken = new Set(existing.map((n) => n.slice(-"XXXX.yaml".length, -".yaml".length)));
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const suffix = this.newSuffix(taken);
      const key = `${this.prefix}-${suffix}`;
      const record: Rec = {
        v: LOCAL_TASK_FORMAT,
        id: suffix,
        key,
        title: input.title,
        priority,
        status: "todo",
        created_at: at,
        updated_at: at,
      };
      if (input.body !== undefined) record.body = input.body;
      if (input.comment !== undefined) record.comments = [{ at, text: input.comment }];
      if (parentKey !== undefined) record.parent = parentKey;
      if (input.run !== undefined) record.runs = [input.run];
      try {
        // `wx`: a key somebody took meanwhile is never overwritten.
        await writeFile(this.file(key), serialize(record), { flag: "wx" });
        return this.toTask(record, record.parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        taken.add(suffix);
      }
    }
    throw new KodelError("TASK_KEY_UNAVAILABLE", `no free key after ${ATTEMPTS} attempts`);
  }

  async get(
    input: string,
    _o?: CallOptions,
  ): Promise<{ task: Task; subtasks: SubtaskRef[]; subtasks_truncated?: boolean } | undefined> {
    const key = await this.resolveKey(input);
    if (key === undefined) return undefined;
    const read = await this.readFileRecord(key);
    if (!read) return undefined;
    if ("problem" in read) {
      throw new KodelError("TASK_ADAPTER_FAILED", `${key}.yaml ${read.problem}`);
    }
    const loaded = await this.load();
    const kids = [...(loaded.children.get(key) ?? [])].sort(this.order);
    return {
      task: this.toTask(read.record, loaded.parentOf.get(key)),
      subtasks: kids
        .slice(0, TASK_LIMITS.subtasks)
        .map((k) => ({ id: k.id, key: k.key, title: k.title })),
      ...(kids.length > TASK_LIMITS.subtasks ? { subtasks_truncated: true } : {}),
    };
  }

  private encodeCursor(record: Rec): string {
    return Buffer.from(
      JSON.stringify([priorityRank(record.priority), record.created_at, record.key]),
    ).toString("base64url");
  }

  private decodeCursor(cursor: string): [number, string, string] {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (
        Array.isArray(parsed) &&
        parsed.length === 3 &&
        typeof parsed[0] === "number" &&
        typeof parsed[1] === "string" &&
        typeof parsed[2] === "string"
      ) {
        return [parsed[0], parsed[1], parsed[2]];
      }
    } catch {
      // fall through
    }
    throw invalid("that cursor is not one this adapter gave out");
  }

  async list(
    filter: TaskFilter,
    _o?: CallOptions,
  ): Promise<{ tasks: TaskSummary[]; next?: string; truncated: boolean; problems: TaskProblem[] }> {
    const loaded = await this.load();
    let rows = [...loaded.records.values()].filter((r) => filter.state.includes(stateOf(r.status)));
    if (filter.status !== undefined) rows = rows.filter((r) => r.status === filter.status);
    if (filter.priority !== undefined) rows = rows.filter((r) => r.priority === filter.priority);
    if (filter.run !== undefined)
      rows = rows.filter((r) => (r.runs ?? []).includes(filter.run as string));
    if (filter.parent !== undefined) {
      rows = rows.filter((r) => loaded.parentOf.get(r.key) === filter.parent);
    }
    if (filter.top_level === true)
      rows = rows.filter((r) => loaded.parentOf.get(r.key) === undefined);
    rows.sort(this.order);
    if (filter.cursor !== undefined) {
      const [rank, created, key] = this.decodeCursor(filter.cursor);
      // Everything strictly after the last item of the previous page: an insert in between
      // neither repeats nor skips a task.
      rows = rows.filter(
        (r) =>
          priorityRank(r.priority) > rank ||
          (priorityRank(r.priority) === rank &&
            (r.created_at > created || (r.created_at === created && r.key > key))),
      );
    }
    const page = rows.slice(0, filter.limit);
    const last = page[page.length - 1];
    const out: {
      tasks: TaskSummary[];
      next?: string;
      truncated: boolean;
      problems: TaskProblem[];
    } = {
      tasks: page.map((r) => this.summary(r, loaded)),
      truncated: false,
      problems: loaded.problems,
    };
    if (rows.length > page.length && last) out.next = this.encodeCursor(last);
    return out;
  }

  /**
   * One writer of a task at a time: an update reads the file, changes it and writes it back, so two
   * at once (the agent's server and `kodel task set`, say) would lose one of the changes, and a
   * comment is never to be lost. The lock is a file made with `wx` next to the task; a lock a crashed
   * process left is taken over once it is old.
   */
  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const lock = `${this.file(key)}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await writeFile(lock, String(process.pid), { flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const held = await lstat(lock).catch(() => undefined);
        if (!held || Date.now() - held.mtimeMs > LOCK_STALE_MS) {
          await unlink(lock).catch(() => undefined);
          continue;
        }
        if (Date.now() > deadline) {
          throw new KodelError(
            "TASK_ADAPTER_FAILED",
            `${key} is being changed by another process; try again in a moment`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      return await work();
    } finally {
      await unlink(lock).catch(() => undefined);
    }
  }

  async update(
    input: string,
    patch: TaskPatch,
    _o?: CallOptions,
  ): Promise<{ task: Task; open_subtasks?: number } | undefined> {
    const key = await this.resolveKey(input);
    if (key === undefined) return undefined;
    // No lock (and no file) for a task that is not there.
    if (
      !(await lstat(this.file(key)).then(
        () => true,
        () => false,
      ))
    )
      return undefined;
    return this.withLock(key, () => this.applyUpdate(key, patch));
  }

  private async applyUpdate(
    key: string,
    patch: TaskPatch,
  ): Promise<{ task: Task; open_subtasks?: number } | undefined> {
    const read = await this.readFileRecord(key);
    if (!read) return undefined;
    if ("problem" in read) {
      throw new KodelError("TASK_ADAPTER_FAILED", `${key}.yaml ${read.problem}`);
    }
    if (patch.type !== undefined) throw this.unsupported("task types");
    if (patch.fields !== undefined) throw this.unsupported("fields");
    const record: Rec = { ...read.record };
    const wasDone = stateOf(record.status) === "done";

    if (patch.status !== undefined) record.status = this.checkStatus(patch.status);
    if (patch.priority !== undefined) record.priority = this.checkPriority(patch.priority);
    if (patch.title !== undefined) record.title = patch.title;
    if (patch.body !== undefined) record.body = patch.body;
    const at = this.now();
    if (patch.comment !== undefined)
      record.comments = [...(record.comments ?? []), { at, text: patch.comment }];
    if (patch.add_run !== undefined && !(record.runs ?? []).includes(patch.add_run)) {
      if ((record.runs ?? []).length >= TASK_LIMITS.runs) {
        throw invalid(`a task keeps at most ${TASK_LIMITS.runs} runs`);
      }
      record.runs = [...(record.runs ?? []), patch.add_run];
    }
    let loaded: Loaded | undefined;
    if (patch.parent !== undefined) {
      const parent = await this.resolveKey(patch.parent);
      loaded = await this.load();
      if (parent === undefined || !loaded.records.has(parent)) {
        throw new KodelError("TASK_NOT_FOUND", `there is no parent task "${patch.parent}"`);
      }
      // Walk up from the new parent: reaching this task means the move would close a cycle.
      for (let at2: string | undefined = parent, hops = 0; at2 !== undefined; hops += 1) {
        if (at2 === key) throw invalid(`${parent} is ${key} or below it: that would make a cycle`);
        if (hops > loaded.records.size) break;
        at2 = loaded.records.get(at2)?.parent;
      }
      record.parent = parent;
    }
    for (const name of patch.clear ?? []) {
      if (name === "body") delete record.body;
      else if (name === "priority") record.priority = DEFAULT_PRIORITY;
      else if (name === "parent") delete record.parent;
      else if (name === "type") throw this.unsupported("task types");
      else throw this.unsupported("fields");
    }
    record.updated_at = at;

    // Through a temp file: a reader never sees half of a task. The name does not match FILE, so a
    // listing ignores it.
    const text = serialize(record);
    // A task that outgrew what is read back would silently turn into a problem: refuse the change.
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
      throw invalid(
        `${key} has reached the size limit of ${MAX_FILE_BYTES / 1024} KB (too many comments?); nothing more can be added to it`,
      );
    }
    const temp = `${this.file(key)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, text, { flag: "wx" });
      await rename(temp, this.file(key));
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }

    const out: { task: Task; open_subtasks?: number } = {
      task: this.toTask(record, record.parent),
    };
    if (!wasDone && stateOf(record.status) === "done") {
      loaded = await this.load();
      const open = (loaded.children.get(key) ?? []).filter(
        (k) => stateOf(k.status) !== "done",
      ).length;
      if (open > 0) out.open_subtasks = open;
    }
    return out;
  }

  async verify(_o?: CallOptions): Promise<TaskProblem[]> {
    try {
      await this.ensureDir();
    } catch (error) {
      const why =
        error instanceof KodelError
          ? error.message
          : `the tasks folder cannot be created (${(error as NodeJS.ErrnoException).code ?? "error"})`;
      return [{ message: why }];
    }
    return (await this.load()).problems;
  }
}

/** The factory the host registers for the `local` kind; it closes over the store root. */
export function localTaskAdapter(storeRoot: string) {
  return (ctx: TaskAdapterContext): TaskAdapter => {
    const { prefix } = parseLocalOptions(ctx.options);
    return new LocalTaskAdapter({ storeRoot, prefix, clock: ctx.clock, random: ctx.random });
  };
}
