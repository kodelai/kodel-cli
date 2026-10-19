/**
 * The local state store: one directory per run under `<root>/runs/`.
 *
 *   meta.json       what the run is (pipeline, task, spec hash)
 *   state.json      the run state, replaced atomically
 *   journal.jsonl   append-only records, redacted on the way in
 *   snapshots.json  working-tree snapshots by key (for `diff` baselines)
 *   reports/        result reports, redacted
 *   lock            held while one process changes the run
 *
 * Redaction lives here, in the only code that writes the journal and the reports, so no caller can
 * forget it.
 */
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type JournalRecord,
  KodelError,
  RECORD_VERSION,
  type RedactRule,
  type ResultReport,
  type RunState,
  redactDeep,
} from "@kodel-ai/pipeline-core";

export interface RunMeta {
  v: 1;
  runId: string;
  pipeline: string;
  task: string;
  specHash: string;
  createdAt: number;
}

export interface StoreOptions {
  /** The `.kodel` directory. */
  root: string;
  /** Extra redaction rules from the project config. */
  rules?: RedactRule[];
  lockTimeoutMs?: number;
  /** A lock older than this is taken over even if its holder looks alive. */
  staleLockMs?: number;
  /** Test hooks. */
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export class FileStore {
  private readonly rules: RedactRule[];
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private writes = 0;
  private readonly held = new Map<string, Promise<unknown>>();

  constructor(private readonly options: StoreOptions) {
    this.rules = options.rules ?? [];
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.staleLockMs = options.staleLockMs ?? 60_000;
    this.pid = options.pid ?? process.pid;
    this.isAlive = options.isAlive ?? processIsAlive;
  }

  runDir(runId: string): string {
    return join(this.options.root, "runs", runId);
  }

  private redact<T>(value: T): T {
    return redactDeep(value, this.rules);
  }

  /** Write a file so that a reader sees the old content or the new, never half of it. */
  private async writeAtomic(path: string, content: string): Promise<void> {
    this.writes += 1;
    const tmp = `${path}.tmp-${this.pid}-${this.writes}`;
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
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
    await mkdir(join(this.runDir(meta.runId), "reports"), { recursive: true });
    await this.writeAtomic(
      join(this.runDir(meta.runId), "meta.json"),
      `${JSON.stringify(this.redact(meta), null, 2)}\n`,
    );
  }

  async readMeta(runId: string): Promise<RunMeta | undefined> {
    return this.readJson<RunMeta>(join(this.runDir(runId), "meta.json"));
  }

  async listRuns(): Promise<RunMeta[]> {
    let names: string[];
    try {
      names = await readdir(join(this.options.root, "runs"));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const metas: RunMeta[] = [];
    for (const name of names) {
      const meta = await this.readMeta(name);
      if (meta) metas.push(meta);
    }
    return metas.sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  }

  /** The newest run of this pipeline and task that has not finished. */
  async findActive(
    pipeline: string,
    task: string,
  ): Promise<{ meta: RunMeta; state: RunState } | undefined> {
    const redactedTask = this.redact(task);
    const candidates = (await this.listRuns()).filter(
      (m) => m.pipeline === pipeline && m.task === redactedTask,
    );
    for (const meta of candidates.reverse()) {
      const state = await this.readState(meta.runId);
      if (state && (state.status === "running" || state.status === "paused"))
        return { meta, state };
    }
    return undefined;
  }

  // state

  async readState(runId: string): Promise<RunState | undefined> {
    const state = await this.readJson<RunState>(join(this.runDir(runId), "state.json"));
    if (state && state.v > RECORD_VERSION) {
      throw new KodelError(
        "UNSUPPORTED_FORMAT",
        `run ${runId} was written by a newer kodel (state format ${state.v}); upgrade kodel`,
      );
    }
    return state;
  }

  async writeState(runId: string, state: RunState): Promise<void> {
    await this.writeAtomic(
      join(this.runDir(runId), "state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    );
  }

  // journal

  async appendJournal(runId: string, records: JournalRecord[]): Promise<void> {
    if (records.length === 0) return;
    const lines = records.map((r) => `${JSON.stringify(this.redact(r))}\n`).join("");
    const handle = await open(join(this.runDir(runId), "journal.jsonl"), "a");
    try {
      await handle.writeFile(lines);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** All complete records; a torn last line left by a crash is ignored. */
  async readJournal(runId: string): Promise<JournalRecord[]> {
    let text: string;
    try {
      text = await readFile(join(this.runDir(runId), "journal.jsonl"), "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const records: JournalRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as JournalRecord);
      } catch {
        // only the last line can be torn; anything after it would be a different problem
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
    await mkdir(join(this.runDir(runId), "reports"), { recursive: true });
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

  // locking

  /**
   * Run `fn` while this process holds the run's lock. Within one process calls are queued; across
   * processes the lock file decides, and a lock whose holder died is taken over.
   */
  async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.held.get(runId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.lockedRun(runId, fn));
    this.held.set(runId, run);
    return run;
  }

  private async lockedRun<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = join(this.runDir(runId), "lock");
    const deadline = Date.now() + this.lockTimeoutMs;
    await mkdir(this.runDir(runId), { recursive: true });
    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({ pid: this.pid, since: Date.now() }));
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const holder = await this.readJson<{ pid: number; since: number }>(lockPath).catch(
          () => undefined,
        );
        const abandoned =
          holder === undefined
            ? false
            : !this.isAlive(holder.pid) || Date.now() - holder.since > this.staleLockMs;
        if (abandoned) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for the lock on run ${runId}`);
        }
        await sleep(20);
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lockPath, { force: true });
    }
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
