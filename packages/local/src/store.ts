/**
 * The local state store: one directory per run under `<root>/runs/`.
 *
 *   meta.json       what the run is (pipeline, task, spec hash)
 *   specs/<hash>.yaml  every version of the pipeline the run has had, each checked against its hash
 *   state.json      the run state, replaced atomically
 *   journal.jsonl   append-only records, redacted on the way in
 *   snapshots.json  working-tree snapshots by key (for `diff` baselines)
 *   reports/        result reports, redacted
 *   served/         what the agent was shown at each step
 *   agent_log/      the agent's conversation log, as redacted normalized events (display data, outside the seal)
 *   lock            held while one process changes the run
 *   agent_log.lock  held while one process copies the agent's log
 *
 * Redaction lives here, in the only code that writes the journal and the reports, so no caller can
 * forget it.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import {
  isChangesRef,
  isRunId,
  isTreeId,
  type JournalRecord,
  KodelError,
  proposalNameProblem,
  RECORD_VERSION,
  type RedactRule,
  type ResultReport,
  type RunState,
  redactDeep,
  redactText,
} from "@kodel-ai/pipeline-core";
import { sha256 } from "./integrity";
import { MAX_PATCH_KB, preparePatch } from "./patch-text";
import { CONFIG_FILE } from "./project-locate";
import { ensurePlace, StoragePathsError, type StoragePlace, scrubHome } from "./storage-paths";
import { sameDir } from "./worktree";

/** The most of a patch the report reads: patches are cut at `max_kb`, so a larger file is not ours. */
const MAX_READ_PATCH_BYTES = (MAX_PATCH_KB + 64) * 1024;

/** The layout of a run directory. Runs written before versioned pipelines have no `v: 2`. */
export const META_VERSION = 2;

export interface RunMeta {
  v: 2;
  runId: string;
  pipeline: string;
  task: string;
  /** The run's slug; runs from before it existed have none. */
  slug?: string;
  specHash: string;
  createdAt: number;
  /** Where the run works, when not in the repository root. Runs from before this read as the root. */
  workdir?: string;
  /** The branch made for the run's worktree, when kodel made one. */
  branch?: string;
  /**
   * The project root of the checkout that made the run; written in `home` mode only, where clones of
   * one project share the history. Advisory: this file can be rewritten by the agent, so it keeps
   * honest clones from stepping on each other and is not a security boundary.
   */
  root?: string;
}

export interface StoreOptions {
  /** The `.kodel` directory. */
  root: string;
  /**
   * Where runs, proposals made outside a run and `start.lock` are kept; by default under `root`,
   * which is the project place.
   */
  place?: StoragePlace;
  /** Extra redaction rules from the project config. */
  rules?: RedactRule[];
  lockTimeoutMs?: number;
  /** A lock older than this is taken over even if its holder looks alive. */
  staleLockMs?: number;
  /** The same for the lock on copying the agent's log, which is held longer than a change to the run. */
  agentLogStaleMs?: number;
  /** Test hooks. */
  pid?: number;
  isAlive?: (pid: number) => boolean;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** How long a copy of the agent's log may hold its lock before another process takes it over. */
export const AGENT_LOG_STALE_MS = 300_000;

/** What the holder of a lock can ask: whether it is still the holder (the lock may have been taken over). */
export interface HeldLock {
  stillHeld(): Promise<boolean>;
}

/** A pipeline the agent proposed outside a run; kept until a person accepts it or drops it. */
export interface PipelineProposalRecord {
  v: 1;
  name: string;
  kind: "new" | "change";
  yaml: string;
  summary: string;
  /** For a change: the hash of the pipeline file as it was when this was proposed. */
  base_hash?: string;
  proposed_at: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A session id as the name of a stored log: the guard of the executor record, and no name Windows takes for a device. */
const SAFE_SESSION_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** How many bytes at the end of the stored stream are hashed to tell that it is still the one the journal vouches for. */
export const AGENT_LOG_TAIL_BYTES = 64;

export type AgentLogAppend =
  | { ok: true; length: number; tail_hash: string }
  /** The stored stream is shorter than the journal says, or its end is not the end the journal vouches for. */
  | { ok: false };

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** A lock file that stays empty this long was left by a process that died while creating it. */
const UNFINISHED_LOCK_MS = 5_000;

/** The hash names a file, so it has to be nothing but what `hashSource` makes. */
const specFileName = (hash: string): string => {
  if (!/^[0-9a-f]{16}$/.test(hash)) {
    throw new KodelError("UNKNOWN_RUN", `"${hash}" is not a pipeline hash`);
  }
  return `${hash}.yaml`;
};

/**
 * A node name as a file name: nothing outside `[A-Za-z0-9._-]`, never empty or a dot name. A name
 * that had to change gets a short hash of the original, so two names cannot meet in one file.
 */
export function artifactFileName(node: string): string {
  const clean = node.replace(/[^A-Za-z0-9._-]/g, "_");
  // Names Windows will not take as a file name, and names too long to be one.
  const reserved =
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(clean) || /[. ]$/.test(clean);
  const dots = clean === "" || /^\.+$/.test(clean);
  const short = clean.length > 64;
  const safe = dots ? "_" : short ? clean.slice(0, 64) : clean;
  // Case-insensitive file systems would put `Build` and `build` into one file.
  return safe === node && !reserved && node === node.toLowerCase()
    ? safe
    : `${safe}-${sha256(node).slice(0, 8)}`;
}

/** A name the run machine gives a served file: a node slug, the attempt and the number. */
const SERVED_REF = /^served\/[a-z0-9][a-z0-9-]{0,62}-\d{1,6}-\d{1,6}\.json$/;

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * How the stored stream of a session is opened for writing: for reading and writing and not in append mode, because a
 * handle that appends has no right to truncate on Windows (`EPERM: ftruncate`), and the stream is cut to the length the
 * journal vouches for before anything is added. A file that is not there yet is made, never replaced (`wx+`).
 */
export const agentLogOpenFlags = (exists: boolean): "r+" | "wx+" => (exists ? "r+" : "wx+");

/** Opens the stored stream for writing at any position; a race with another maker of the file is settled by one retry. */
async function openAgentLogForWrite(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await open(path, agentLogOpenFlags(true));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    return await open(path, agentLogOpenFlags(false));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return open(path, agentLogOpenFlags(true));
  }
}

/** The code of an error of the operating system (`EACCES`, `ENOSPC`), not of Node itself (`ERR_...`). */
const SYSTEM_ERROR = /^E(?!RR_)[A-Z0-9]+$/;

/**
 * A file-system error in the home tree as a configuration problem: with a code, and without the
 * folder (the home base and the user's name in it go to an agent through a tool answer). Only an
 * error of the system whose path lies under the home base is taken: the project's own folders, an
 * error of Node and anything else keep the error as it is. An error with no path (a write that
 * failed half way: the disk is full) is taken only where the caller knows the operation was in the
 * home tree (`certain`).
 */
export function placeProblem(
  error: unknown,
  place: StoragePlace | undefined,
  certain = false,
): unknown {
  if (place?.mode !== "home" || place.base === undefined || error instanceof KodelError) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code !== "string" || !SYSTEM_ERROR.test(code)) return error;
  const { path, dest } = error as { path?: unknown; dest?: unknown };
  const named = [path, dest].filter((p): p is string => typeof p === "string");
  const base = place.base;
  const inside = (p: string) => p === base || p.startsWith(base.endsWith(sep) ? base : base + sep);
  if (named.length > 0 ? !named.some(inside) : !certain) return error;
  // A file that is not there is not a place that cannot be used: the folder was removed or moved.
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new KodelError(
      "UNKNOWN_RUN",
      `a file of the history is missing, so the folder may have been removed or moved: ${scrubHome((error as Error).message, place)}`,
    );
  }
  return new KodelError(
    "CONFIG_INVALID",
    `the history in the home folder cannot be used (<home> is ~/.kodel, or KODEL_STATE_DIR when it is set): ${scrubHome((error as Error).message, place)}`,
  );
}

export class FileStore {
  private readonly rules: RedactRule[];
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly agentLogStaleMs: number;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly clock: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private writes = 0;
  private readonly held = new Map<string, Promise<unknown>>();
  private readonly runsRoot: string;
  private readonly proposalsRoot: string;
  private readonly lockRoot: string;
  private readonly checkoutRoot: string | undefined;
  private prepared: Promise<void> | undefined;

  constructor(private readonly options: StoreOptions) {
    this.rules = options.rules ?? [];
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.staleLockMs = options.staleLockMs ?? 60_000;
    this.agentLogStaleMs = options.agentLogStaleMs ?? AGENT_LOG_STALE_MS;
    this.pid = options.pid ?? process.pid;
    this.isAlive = options.isAlive ?? processIsAlive;
    this.clock = options.clock ?? Date.now;
    this.wait = options.sleep ?? sleep;
    const place = options.place;
    this.runsRoot = place?.runsRoot ?? join(options.root, "runs");
    this.proposalsRoot = place?.proposalsRoot ?? join(options.root, "proposals");
    this.lockRoot = place?.lockRoot ?? options.root;
    this.checkoutRoot = place?.checkoutRoot;
  }

  /**
   * The folders of the place exist (a `home` place is made once, with mode 0700) before anything is
   * written there. A problem with the place is a configuration problem and says so.
   */
  private ready(): Promise<void> {
    const place = this.options.place;
    if (place === undefined || place.mode === "project") return Promise.resolve();
    this.prepared ??= ensurePlace(place).catch((error: unknown) => {
      this.prepared = undefined;
      if (error instanceof StoragePathsError) {
        throw new KodelError("CONFIG_INVALID", scrubHome(error.message, place));
      }
      throw this.placeProblem(error);
    });
    return this.prepared;
  }

  /**
   * A file-system error in the home tree as a configuration problem: with a code, and without the
   * folder (the home base and the user's name in it go to an agent through a tool answer). The
   * project's own folders keep the error as it is.
   */
  private placeProblem(error: unknown): unknown {
    return placeProblem(error, this.options.place, true);
  }

  runDir(runId: string): string {
    if (!isRunId(runId)) throw new KodelError("UNKNOWN_RUN", `"${runId}" is not a run id`);
    return join(this.runsRoot, runId);
  }

  /** A folder in the home tree is for its owner only; in the project it keeps the usual mode. */
  private folderMode(): { mode?: number } {
    return this.options.place?.mode === "home" ? { mode: 0o700 } : {};
  }

  /**
   * Whether a run was made by another checkout of the same project (clones share a `home` history).
   * A run with no `root` is taken as ours.
   */
  isForeign(meta: RunMeta): boolean {
    // The file can be rewritten by the agent: anything but a path is no claim to be another checkout's.
    return (
      this.checkoutRoot !== undefined &&
      typeof meta.root === "string" &&
      !sameDir(meta.root, this.checkoutRoot)
    );
  }

  /**
   * Take a free run id: the folder is made without `recursive`, so an id that is already there (a
   * clone started in the same millisecond with the same random part) is never reused.
   */
  async reserveRunId(now: number): Promise<string> {
    await this.ready();
    try {
      // With the mode too: the folder may have been taken away while the server ran.
      await mkdir(this.runsRoot, { recursive: true, ...this.folderMode() });
    } catch (error) {
      throw this.placeProblem(error);
    }
    for (let attempt = 0; ; attempt += 1) {
      const runId = newRunId(now);
      try {
        await mkdir(this.runDir(runId), this.folderMode());
        return runId;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 8) {
          throw this.placeProblem(error);
        }
      }
    }
  }

  private redact<T>(value: T): T {
    return redactDeep(value, this.rules);
  }

  /** A value with the project's secrets taken out, as it would be written; for what is hashed and then written. */
  redactAnswer<T>(value: T): T {
    return this.redact(value);
  }

  /** Write a file so that a reader sees the old content or the new, never half of it. */
  private async writeAtomic(path: string, content: string, inHistory = true): Promise<void> {
    this.writes += 1;
    const tmp = `${path}.tmp-${this.pid}-${this.writes}`;
    try {
      // The name is predictable, so something planted there (a link to another file) is removed
      // first and the file is created exclusively; a write never follows a link out of the folder.
      await rm(tmp, { force: true });
      const handle = await open(tmp, "wx");
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, path);
    } catch (error) {
      throw inHistory ? this.placeProblem(error) : error;
    }
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  // runs

  async createRun(meta: RunMeta): Promise<void> {
    await this.ready();
    try {
      await mkdir(this.runDir(meta.runId), { recursive: true, ...this.folderMode() });
    } catch (error) {
      throw this.placeProblem(error);
    }
    // The directory and the branch are made by kodel, not typed by the agent, and a path the rules
    // rewrote (a long random-looking folder name is enough) would no longer name the directory: the
    // run could not find its way back to it. They are kept as they are. So is the root of the
    // checkout that made the run (in `home` mode only).
    const { workdir, branch, root: _root, ...rest } = meta;
    const record: RunMeta = {
      ...this.redact(rest),
      ...(workdir === undefined ? {} : { workdir }),
      ...(branch === undefined ? {} : { branch }),
      ...(this.checkoutRoot === undefined ? {} : { root: this.checkoutRoot }),
    };
    // The record first: a folder with a `meta.json` is a run, and one without is not, so nothing
    // half-made shows up as a run.
    await this.writeAtomic(
      join(this.runDir(meta.runId), "meta.json"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    await mkdir(join(this.runDir(meta.runId), "reports"), {
      recursive: true,
      ...this.folderMode(),
    });
  }

  async readMeta(runId: string): Promise<RunMeta | undefined> {
    return this.readJson<RunMeta>(join(this.runDir(runId), "meta.json"));
  }

  async listRuns(): Promise<RunMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.runsRoot);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const metas: RunMeta[] = [];
    for (const name of names) {
      if (!isRunId(name)) continue;
      const meta = await this.readMeta(name);
      // The id inside the file has to be the folder's: otherwise a file an agent can write would
      // put its own text where a run id is shown, and name a run that is not there.
      if (meta && meta.runId === name) metas.push(meta);
    }
    return metas.sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  }

  /**
   * The newest run of this pipeline and task, finished or not, among those this kodel reads: a run
   * of a format it does not read is passed over (it cannot be reported on or carried on here).
   */
  async findLatest(
    pipeline: string,
    task: string,
  ): Promise<{ meta: RunMeta; state: RunState } | undefined> {
    const redactedTask = this.redact(task);
    const candidates = (await this.listRuns()).filter(
      (m) => m.pipeline === pipeline && m.task === redactedTask && !this.isForeign(m),
    );
    for (const meta of candidates.reverse()) {
      let state: RunState | undefined;
      try {
        state = await this.readState(meta.runId);
      } catch (error) {
        if (error instanceof KodelError && error.code === "UNSUPPORTED_FORMAT") continue;
        throw error;
      }
      if (state) return { meta, state };
    }
    return undefined;
  }

  /** The `v` and `status` fields of a state file as they are, without reading it as a run; nothing when there is no file or no JSON. */
  async peekState(runId: string): Promise<{ v?: number; status?: string } | undefined> {
    let text: string;
    try {
      text = await readFile(join(this.runDir(runId), "state.json"), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null) return {};
      const { v, status } = parsed as { v?: unknown; status?: unknown };
      return {
        ...(typeof v === "number" ? { v } : {}),
        ...(typeof status === "string" ? { status } : {}),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Keep a version of the pipeline a run has had, named by its hash, so editing the file later does
   * not change a run in flight. A version is never rewritten or removed.
   */
  async writeSpec(runId: string, hash: string, source: string): Promise<void> {
    const dir = this.specsDir(runId);
    await mkdir(dir, { recursive: true, ...this.folderMode() });
    await this.writeAtomic(join(dir, specFileName(hash)), source);
  }

  /** A kept version of the pipeline. It is parsed and checked again by whoever uses it. */
  async readSpec(runId: string, hash: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.specsDir(runId), specFileName(hash)), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  /** The hashes of the versions kept with a run. */
  async listSpecs(runId: string): Promise<string[]> {
    try {
      return (await readdir(this.specsDir(runId)))
        .filter((name) => name.endsWith(".yaml"))
        .map((name) => name.slice(0, -".yaml".length))
        .sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private specsDir(runId: string): string {
    return join(this.runDir(runId), "specs");
  }

  // the agent's proposal to change the pipeline: one file, replaced by the next proposal

  private proposalPath(runId: string): string {
    return join(this.runDir(runId), "pending", "proposal.yaml");
  }

  async writeProposal(runId: string, source: string): Promise<void> {
    await mkdir(dirname(this.proposalPath(runId)), { recursive: true, ...this.folderMode() });
    await this.writeAtomic(this.proposalPath(runId), source);
  }

  async readProposal(runId: string): Promise<string | undefined> {
    try {
      return await readFile(this.proposalPath(runId), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async removeProposal(runId: string): Promise<boolean> {
    try {
      await rm(this.proposalPath(runId));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  // proposals of a pipeline outside a run: one record per pipeline name

  private pipelineProposalPath(name: string): string {
    const problem = proposalNameProblem(name);
    if (problem !== undefined) throw new KodelError("INVALID_ARGUMENTS", problem);
    return join(this.proposalsRoot, `${name}.json`);
  }

  async writePipelineProposal(record: PipelineProposalRecord): Promise<void> {
    await this.ready();
    const path = this.pipelineProposalPath(record.name);
    try {
      await mkdir(dirname(path), { recursive: true, ...this.folderMode() });
    } catch (error) {
      throw this.placeProblem(error);
    }
    // The text is the agent's and is kept as it is (the caller refused anything redaction would change).
    await this.writeAtomic(
      path,
      `${JSON.stringify({ ...record, summary: this.redact(record.summary) })}\n`,
    );
  }

  async readPipelineProposal(name: string): Promise<PipelineProposalRecord | undefined> {
    let record: PipelineProposalRecord | undefined;
    try {
      record = await this.readJson<PipelineProposalRecord>(this.pipelineProposalPath(name));
    } catch (error) {
      // A file that is not JSON is not a record this kodel wrote; it can still be dropped.
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
    if (record?.v !== 1 || record.name !== name) return undefined;
    // Anything else in the folder is not a record this kodel wrote, whatever put it there.
    const whole =
      typeof record.yaml === "string" &&
      typeof record.summary === "string" &&
      typeof record.proposed_at === "number" &&
      (record.kind === "new" || (record.kind === "change" && typeof record.base_hash === "string"));
    return whole ? record : undefined;
  }

  /** Whether a record is there, readable or not: a damaged one can still be dropped. */
  async hasPipelineProposal(name: string): Promise<boolean> {
    try {
      await stat(this.pipelineProposalPath(name));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async removePipelineProposal(name: string): Promise<boolean> {
    try {
      await rm(this.pipelineProposalPath(name));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async listPipelineProposals(): Promise<PipelineProposalRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.proposalsRoot);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const found: PipelineProposalRecord[] = [];
    for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
      const record = await this.readPipelineProposal(file.slice(0, -".json".length)).catch(
        () => undefined,
      );
      if (record) found.push(record);
    }
    return found;
  }

  /**
   * Create a file that must not exist yet, all or nothing: false if something is already there. The
   * content is written aside and linked into place, so a file that appears meanwhile is never replaced.
   */
  async createFile(path: string, content: string): Promise<boolean> {
    this.writes += 1;
    const tmp = `${path}.tmp-${this.pid}-${this.writes}`;
    await rm(tmp, { force: true });
    const handle = await open(tmp, "wx");
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(tmp, path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      // Where hard links are not allowed (some mounts, FAT, Windows without the right) the file is
      // still created exclusively, only not all at once.
      if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV" || code === "ENOSYS") {
        try {
          await writeFile(path, content, { flag: "wx" });
          return true;
        } catch (again) {
          if ((again as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw again;
        }
      }
      throw error;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** Write a file that is not the store's own (a pipeline file the person accepted), all or nothing. */
  async replaceFile(path: string, content: string): Promise<void> {
    // Not in the history: a failure here is about the project's own files and is said as it is.
    await this.writeAtomic(path, content, false);
  }

  /**
   * The newest run of this pipeline and task that has not finished. An open run of a format this
   * kodel does not read is not passed over: it is refused with its format, so no second run for the
   * same task is started beside it.
   */
  async findActive(
    pipeline: string,
    task: string,
  ): Promise<{ meta: RunMeta; state: RunState } | undefined> {
    const redactedTask = this.redact(task);
    const candidates = (await this.listRuns()).filter(
      (m) => m.pipeline === pipeline && m.task === redactedTask && !this.isForeign(m),
    );
    for (const meta of candidates.reverse()) {
      let state: RunState | undefined;
      try {
        state = await this.readState(meta.runId);
      } catch (error) {
        if (!(error instanceof KodelError) || error.code !== "UNSUPPORTED_FORMAT") throw error;
        const peek = await this.peekState(meta.runId);
        if (peek?.status === "running" || peek?.status === "paused") {
          throw new KodelError(
            error.code,
            // Left as it is, the run is passed over everywhere but here: a second run beside it is refused.
            `${error.message}; left as it is, it still blocks a new run of this pipeline for this task: run ${meta.runId} must be finished before a new run starts for this task`,
          );
        }
        continue;
      }
      if (state && (state.status === "running" || state.status === "paused"))
        return { meta, state };
    }
    return undefined;
  }

  // state

  async readState(runId: string): Promise<RunState | undefined> {
    return (await this.readStateRaw(runId))?.state;
  }

  /** The state and the hash of the exact bytes it was read from. */
  async readStateRaw(runId: string): Promise<{ state: RunState; hash: string } | undefined> {
    let text: string;
    try {
      text = await readFile(join(this.runDir(runId), "state.json"), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new KodelError(
        "STATE_MODIFIED_EXTERNALLY",
        `the state of run ${runId} is not valid JSON; it was changed outside kodel`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new KodelError(
        "STATE_MODIFIED_EXTERNALLY",
        `the state of run ${runId} is not a JSON object; it was changed outside kodel`,
      );
    }
    const state = parsed as RunState;
    // The format comes first, before anything reads a field: this is the one place a run of another
    // run-state format is refused, and it is refused as such, never as a modified state. "Run-state
    // format" so it is not taken for the format of `meta.json`, which has its own number.
    const v: unknown = state.v;
    if (typeof v !== "number") {
      throw new KodelError(
        "STATE_MODIFIED_EXTERNALLY",
        `the state of run ${runId} has no run-state format version; it was changed outside kodel`,
      );
    }
    if (v > RECORD_VERSION) {
      throw new KodelError(
        "UNSUPPORTED_FORMAT",
        `run ${runId} was written by a newer kodel (run-state format ${v}, this kodel reads ${RECORD_VERSION}); upgrade kodel`,
      );
    }
    if (v < RECORD_VERSION) {
      throw new KodelError(
        "UNSUPPORTED_FORMAT",
        `run ${runId} was written in run-state format ${v} by an older kodel (this kodel reads ${RECORD_VERSION}); finish it with the kodel that started it, or leave it as it is (lists and reports pass it over)${await this.olderKodelNote()}`,
      );
    }
    return { state, hash: sha256(text) };
  }

  /**
   * What stands in the way of the older kodel the person is sent back to: it refuses a project config
   * with an `agents:` block (forks), so the person is told to set it aside while they finish the run.
   * Read from the file's text, not parsed: this is a note on a refusal, never a reason for one.
   */
  private async olderKodelNote(): Promise<string> {
    let text: string;
    try {
      text = await readFile(join(this.options.root, CONFIG_FILE), "utf8");
    } catch {
      return "";
    }
    return /^agents:/m.test(text)
      ? ` (that kodel refuses the project config while it has an \`agents:\` block: take the block out of ${CONFIG_FILE} while you do)`
      : "";
  }

  /**
   * Replace the state; returns the hash of what was written. `beforeWrite` gets the hash first, so
   * the caller can record it as expected before the file changes.
   */
  async writeState(
    runId: string,
    state: RunState,
    beforeWrite?: (hash: string) => Promise<void>,
  ): Promise<string> {
    const text = `${JSON.stringify(state, null, 2)}\n`;
    const hash = sha256(text);
    await beforeWrite?.(hash);
    await this.writeAtomic(join(this.runDir(runId), "state.json"), text);
    return hash;
  }

  // seal: a finished run's state and journal, hashed once so a later change shows

  private async fileHash(path: string): Promise<string> {
    try {
      return sha256(await readFile(path));
    } catch (error) {
      if (isMissing(error)) return sha256("");
      throw error;
    }
  }

  /** Returns the hash of the seal file, which the caller keeps outside the repository. */
  async writeSeal(runId: string, now: number): Promise<string> {
    const dir = this.runDir(runId);
    const seal = {
      v: 1,
      state: await this.fileHash(join(dir, "state.json")),
      journal: await this.fileHash(join(dir, "journal.jsonl")),
      sealedAt: now,
    };
    const text = `${JSON.stringify(seal, null, 2)}\n`;
    await this.writeAtomic(join(dir, "seal.json"), text);
    return sha256(text);
  }

  /**
   * `sealed`: untouched since it finished. `modified`: changed after the seal. `unsealed`: no seal.
   * With `trusted` (the seal's hash kept outside the repository) a rewritten seal shows too.
   */
  async checkSeal(runId: string, trusted?: string): Promise<"sealed" | "modified" | "unsealed"> {
    const dir = this.runDir(runId);
    let text: string;
    try {
      text = await readFile(join(dir, "seal.json"), "utf8");
    } catch (error) {
      if (isMissing(error)) return trusted === undefined ? "unsealed" : "modified";
      throw error;
    }
    if (trusted !== undefined && sha256(text) !== trusted) return "modified";
    let seal: { state: string; journal: string };
    try {
      seal = JSON.parse(text) as { state: string; journal: string };
    } catch {
      return "modified";
    }
    const same =
      seal.state === (await this.fileHash(join(dir, "state.json"))) &&
      seal.journal === (await this.fileHash(join(dir, "journal.jsonl")));
    return same ? "sealed" : "modified";
  }

  // journal

  async appendJournal(runId: string, records: JournalRecord[]): Promise<void> {
    if (records.length === 0) return;
    const lines = records
      .map((r) => {
        const redacted = this.redact(r) as Record<string, unknown>;
        // A tree id carries no secret, and a project rule such as `[0-9a-f]{32,}` would make the
        // chain of patches unreadable from the second hand-in on.
        if (isTreeId(r.tree)) redacted.tree = r.tree;
        // Nor does the path of a patch, and a record that points nowhere is of no use.
        if (isChangesRef(r.changes)) redacted.changes = r.changes;
        return `${JSON.stringify(redacted)}\n`;
      })
      .join("");
    try {
      const handle = await open(join(this.runDir(runId), "journal.jsonl"), "a");
      try {
        await handle.writeFile(lines);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw this.placeProblem(error);
    }
  }

  /** All complete records; a torn last line left by a crash is ignored, a bad line elsewhere is not. */
  async readJournal(runId: string): Promise<JournalRecord[]> {
    let text: string;
    try {
      text = await readFile(join(this.runDir(runId), "journal.jsonl"), "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const lines = text.split("\n").filter((line) => line.trim());
    const records: JournalRecord[] = [];
    for (const [i, line] of lines.entries()) {
      try {
        records.push(JSON.parse(line) as JournalRecord);
      } catch {
        if (i === lines.length - 1) break;
        throw new KodelError(
          "STATE_MODIFIED_EXTERNALLY",
          `the journal of run ${runId} has a damaged record at line ${i + 1}; it was changed outside kodel`,
        );
      }
    }
    return records;
  }

  // snapshots and reports

  async readSnapshots(runId: string): Promise<Record<string, string>> {
    return (
      (await this.readJson<Record<string, string>>(join(this.runDir(runId), "snapshots.json"))) ??
      {}
    );
  }

  /** The patch of the whole run (`changes/run.patch`), or undefined when none was kept. */
  async readRunPatch(runId: string): Promise<string | undefined> {
    try {
      // The folder is the agent's to write in: a link in its place, or a file of any size, is not read.
      const dir = join(this.runDir(runId), "changes");
      const folder = await lstat(dir);
      if (folder.isSymbolicLink() || !folder.isDirectory()) return undefined;
      const file = join(dir, "run.patch");
      const info = await lstat(file);
      if (!info.isFile() || info.size > MAX_READ_PATCH_BYTES) return undefined;
      return await readFile(file, "utf8");
    } catch {
      return undefined;
    }
  }

  async writeSnapshot(runId: string, key: string, tree: string): Promise<void> {
    const all = await this.readSnapshots(runId);
    all[key] = tree;
    await this.writeAtomic(
      join(this.runDir(runId), "snapshots.json"),
      `${JSON.stringify(all, null, 2)}\n`,
    );
  }

  private reportPath(runId: string, node: string, attempt: number) {
    return join(this.runDir(runId), "reports", `${node}-${attempt}.json`);
  }

  async writeReport(
    runId: string,
    node: string,
    attempt: number,
    report: ResultReport,
  ): Promise<void> {
    await mkdir(join(this.runDir(runId), "reports"), { recursive: true, ...this.folderMode() });
    await this.writeAtomic(
      this.reportPath(runId, node, attempt),
      `${JSON.stringify(this.redact(report), null, 2)}\n`,
    );
  }

  async readReport(
    runId: string,
    node: string,
    attempt: number,
  ): Promise<ResultReport | undefined> {
    return this.readJson<ResultReport>(this.reportPath(runId, node, attempt));
  }

  /**
   * Keep what a command printed, redacted, in `artifacts/`. `part` is `command` or `check<i>`; the
   * attempt is in the name, so a retried node does not overwrite the output of the attempt before.
   * Returns the path relative to the run folder and the size of what is stored.
   */
  async writeArtifact(
    runId: string,
    node: string,
    attempt: number,
    part: string,
    text: string,
  ): Promise<{ ref: string; bytes: number }> {
    if (!/^(command|check\d+)$/.test(part)) {
      throw new KodelError("INVALID_ARGUMENTS", `"${part}" is not an artifact part`);
    }
    const ref = `artifacts/${artifactFileName(node)}-${attempt}-${part}.txt`;
    const content = redactText(text, this.rules);
    await mkdir(join(this.runDir(runId), "artifacts"), { recursive: true, ...this.folderMode() });
    await this.writeAtomic(join(this.runDir(runId), ref), content);
    return { ref, bytes: Buffer.byteLength(content) };
  }

  /**
   * Keep the patch of a handed-in attempt or of the whole run in `changes/`. The text is already
   * made fit (`preparePatch`). A node's patch never replaces a file: if the name is taken (a node
   * removed and added again starts at attempt 1, two sessions hand in the same step) the next free
   * `~<n>` is used, and the journal's `ref` says which. The run's patch is one file, replaced whole.
   * Returns the path relative to the run folder and the size of what is stored.
   */
  async writeChanges(
    runId: string,
    name: string,
    raw: Buffer,
    options: { cutByGit: boolean; maxKb: number },
  ): Promise<{ ref: string; bytes: number; truncated: boolean }> {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,150}$/.test(name)) {
      throw new KodelError("INVALID_ARGUMENTS", `"${name}" is not a patch name`);
    }
    const dir = join(this.runDir(runId), "changes");
    await mkdir(dir, { recursive: true });
    // The agent can write here: a link in the place of the folder must not take a patch elsewhere.
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new KodelError("INVALID_ARGUMENTS", "changes/ is not a plain folder");
    }
    // Redaction is here, where everything else that is written is redacted.
    const { text: content, truncated } = preparePatch(raw, { ...options, rules: this.rules });
    const bytes = Buffer.byteLength(content);
    if (name === "run") {
      await this.writeAtomic(join(dir, "run.patch"), content);
      return { ref: "changes/run.patch", bytes, truncated };
    }
    for (let n = 0; n < 50; n++) {
      const file = n === 0 ? `${name}.patch` : `${name}~${n}.patch`;
      if (await this.createFile(join(dir, file), content)) {
        return { ref: `changes/${file}`, bytes, truncated };
      }
    }
    throw new KodelError("INVALID_ARGUMENTS", `too many patches named "${name}"`);
  }

  /** Remove a patch this process made for a call that was then refused. Never throws. */
  async deleteChanges(runId: string, ref: string): Promise<void> {
    try {
      if (!/^changes\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*\.patch$/.test(ref)) return;
      await rm(join(this.runDir(runId), ref), { force: true });
    } catch {
      // a leftover file with no reference in the journal is ignored by everything that reads
    }
  }

  /**
   * Keep what the agent was shown. `ref` is the name the run machine gave (`served/<node>-<attempt>-<n>.json`);
   * it is checked here too, so a record in the journal can never point out of the run's folder. The
   * content is already redacted by whoever hashed it.
   */
  async writeServed(runId: string, ref: string, content: unknown): Promise<void> {
    if (!SERVED_REF.test(ref)) {
      throw new KodelError("INVALID_ARGUMENTS", `"${ref}" is not a served file`);
    }
    await mkdir(join(this.runDir(runId), "served"), { recursive: true, ...this.folderMode() });
    await this.writeAtomic(join(this.runDir(runId), ref), `${JSON.stringify(content, null, 2)}\n`);
  }

  async readServed(runId: string, ref: string): Promise<unknown> {
    if (!SERVED_REF.test(ref)) return undefined;
    return this.readJson<unknown>(join(this.runDir(runId), ref));
  }

  // locking

  /**
   * Run `fn` while this process holds the run's lock. Within one process calls are queued; across
   * processes the lock file decides, and a lock whose holder died is taken over.
   */
  async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    return this.queued(runId, join(this.runDir(runId), "lock"), fn, false);
  }

  /** Held while a run is looked for and created, so two starts of one task cannot make two runs. */
  async withStartLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.queued("start", join(this.lockRoot, "start.lock"), fn, true);
  }

  private queued<T>(
    key: string,
    lockPath: string,
    fn: () => Promise<T>,
    makeFolder: boolean,
  ): Promise<T> {
    const previous = this.held.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.lockedRun(key, lockPath, fn, makeFolder));
    this.held.set(key, run);
    return run;
  }

  /** Remove a run that could not be started, so no half-made run is left behind. */
  async removeRun(runId: string): Promise<void> {
    await rm(this.runDir(runId), { recursive: true, force: true });
  }

  /**
   * Whether the holder is gone: its process is dead, it has held the lock for too long, the lock
   * claims to be from the future, or the file was never filled in (the holder died between creating
   * it and writing it, which shows as an old, empty file).
   */
  private async lockAbandoned(
    lockPath: string,
    staleMs: number,
    sameAs?: string,
  ): Promise<string | undefined> {
    const now = this.clock();
    let text: string;
    try {
      text = await readFile(lockPath, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined; // released meanwhile; the next try takes it
      throw error;
    }
    // Asked about the very lock that was judged before: a different one is somebody else's, taken
    // since, and is not ours to remove.
    if (sameAs !== undefined && text !== sameAs) return undefined;
    let holder: { pid: number; since: number } | undefined;
    try {
      holder = JSON.parse(text) as { pid: number; since: number };
    } catch {
      holder = undefined;
    }
    if (typeof holder?.pid !== "number" || typeof holder.since !== "number") {
      const modified = await stat(lockPath).then(
        (s) => s.mtimeMs,
        () => now,
      );
      return now - modified > UNFINISHED_LOCK_MS ? text : undefined;
    }
    const gone =
      !this.isAlive(holder.pid) || now - holder.since > staleMs || holder.since > now + staleMs;
    return gone ? text : undefined;
  }

  /**
   * Remove an abandoned lock. Only one waiter at a time gets to do it (a second lock file guards the
   * removal), and it looks again once it is in, so a lock that someone took in the meantime stays.
   */
  private async takeOverAbandoned(lockPath: string, staleMs: number): Promise<boolean> {
    const seen = await this.lockAbandoned(lockPath, staleMs);
    if (seen === undefined) return false;
    const guardPath = `${lockPath}.takeover`;
    let guard: Awaited<ReturnType<typeof open>>;
    try {
      guard = await open(guardPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const modified = await stat(guardPath).then(
        (s) => s.mtimeMs,
        () => this.clock(),
      );
      if (this.clock() - modified > UNFINISHED_LOCK_MS) await rm(guardPath, { force: true });
      return false;
    }
    try {
      await guard.close();
      // Only the lock that was judged abandoned goes: if its holder let it go and someone took it
      // since, the text is different and it stays.
      if ((await this.lockAbandoned(lockPath, staleMs, seen)) === undefined) return false;
      await rm(lockPath, { force: true });
      return true;
    } finally {
      await rm(guardPath, { force: true });
    }
  }

  private async lockedRun<T>(
    name: string,
    lockPath: string,
    fn: (lock: HeldLock) => Promise<T>,
    makeFolder: boolean,
    params: { timeoutMs: number; staleMs: number } = {
      timeoutMs: this.lockTimeoutMs,
      staleMs: this.staleLockMs,
    },
  ): Promise<T> {
    const deadline = this.clock() + params.timeoutMs;
    const token = randomUUID();
    // Only the start lock makes its folder. A lock for a run never does: a run that is not there
    // would otherwise get an empty folder, which is how a run could end up split between two places.
    if (makeFolder) {
      await this.ready();
      try {
        await mkdir(dirname(lockPath), { recursive: true, ...this.folderMode() });
      } catch (error) {
        throw this.placeProblem(error);
      }
    }
    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify({ pid: this.pid, since: this.clock(), token }));
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if (!makeFolder && (error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new KodelError("UNKNOWN_RUN", `there is no run "${name}"`);
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.takeOverAbandoned(lockPath, params.staleMs)) continue;
        if (this.clock() >= deadline) {
          throw new KodelError("STATE_LOCKED", `timed out waiting for the lock on ${name}`);
        }
        await this.wait(20);
      }
    }
    const stillHeld = async (): Promise<boolean> =>
      (await this.readJson<{ token?: string }>(lockPath).catch(() => undefined))?.token === token;
    try {
      return await fn({ stillHeld });
    } finally {
      // Not ours any more if someone took it over after it went stale; leave theirs alone.
      if (await stillHeld()) await rm(lockPath, { force: true });
    }
  }

  // the agent's log

  private agentLogFile(runId: string, session: string): string {
    if (!SAFE_SESSION_FILE.test(session) || RESERVED_NAME.test(session) || /[. ]$/.test(session)) {
      throw new KodelError(
        "INVALID_ARGUMENTS",
        `"${session}" is not a session id that can name a file`,
      );
    }
    return join(this.runDir(runId), "agent_log", `${session}.jsonl`);
  }

  /**
   * Hold the lock on copying a run's agent log: one process at a time, whatever it does with the run. A
   * different lock from the one on the run, with its own wait and a longer time before it counts as
   * abandoned; always taken before the run's, never after. Throws `STATE_LOCKED` when it cannot be had in `waitMs`.
   * The holder asks `stillHeld()` before each write: a lock that went stale and was taken over is not its own.
   */
  async withAgentLogLock<T>(
    runId: string,
    waitMs: number,
    fn: (lock: HeldLock) => Promise<T>,
  ): Promise<T> {
    return this.lockedRun(
      `${runId} agent log`,
      join(this.runDir(runId), "agent_log.lock"),
      fn,
      false,
      {
        timeoutMs: waitMs,
        staleMs: this.agentLogStaleMs,
      },
    );
  }

  /** The hash of the last bytes of the first `length` bytes of the file, or `undefined` if it is shorter. */
  private async tailHash(path: string, length: number): Promise<string | undefined> {
    if (length === 0) return sha256("");
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "r");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      if ((await handle.stat()).size < length) return undefined;
      const size = Math.min(AGENT_LOG_TAIL_BYTES, length);
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, length - size);
      return createHash("sha256").update(buffer).digest("hex");
    } finally {
      await handle.close();
    }
  }

  /** The events as lines, each redacted whole with the project's rules: nothing reaches the file unredacted. */
  agentLogLines(events: readonly unknown[]): string {
    return events.map((event) => `${JSON.stringify(this.redact(event))}\n`).join("");
  }

  /**
   * Append to the stored stream of a session. The stream is `expect.length` bytes long as far as the journal
   * knows, ending in bytes that hash to `expect.tail_hash`: anything past that was never vouched for (a pass that
   * died before it was journaled) and is cut off first. A stream that is shorter, or whose end is another, was
   * changed since: it is not extended (a gap of zero bytes would be made up history) and `ok: false` says so.
   * The new length and the hash of the new end are for the next journal record.
   */
  async appendAgentLog(
    runId: string,
    session: string,
    expect: { length: number; tail_hash?: string },
    text: string,
  ): Promise<AgentLogAppend> {
    const path = this.agentLogFile(runId, session);
    if (expect.length > 0) {
      const tail = await this.tailHash(path, expect.length);
      if (tail === undefined || tail !== expect.tail_hash) return { ok: false };
    }
    await mkdir(dirname(path), { recursive: true });
    const handle = await openAgentLogForWrite(path);
    try {
      await handle.truncate(expect.length);
      const bytes = Buffer.from(text, "utf8");
      let written = 0;
      while (written < bytes.length) {
        const { bytesWritten } = await handle.write(
          bytes,
          written,
          bytes.length - written,
          expect.length + written,
        );
        written += bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const length = expect.length + Buffer.byteLength(text, "utf8");
    return { ok: true, length, tail_hash: (await this.tailHash(path, length)) ?? sha256("") };
  }

  /** The stored stream of a session up to `length` bytes, which is as far as the journal vouches for it. */
  async readAgentLog(runId: string, session: string, length: number): Promise<string | undefined> {
    const path = this.agentLogFile(runId, session);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "r");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      const size = Math.min(length, (await handle.stat()).size);
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  }

  /** The size of a stored stream on disk, or `undefined` when there is none. */
  async agentLogSize(runId: string, session: string): Promise<number | undefined> {
    return stat(this.agentLogFile(runId, session)).then(
      (s) => s.size,
      (error) => {
        if (isMissing(error)) return undefined;
        throw error;
      },
    );
  }
}

/** A sortable, readable run id: `r_<time in base 36>_<random>`. */
export function newRunId(now: number = Date.now(), random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  // Fixed width, so that ids sort by time as plain strings.
  return `r_${now.toString(36).padStart(9, "0")}_${suffix}`;
}
