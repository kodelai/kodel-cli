/**
 * The local state store: one directory per run under `<root>/runs/`.
 *
 *   meta.json       what the run is (pipeline, task, spec hash)
 *   spec.yaml       the pipeline the run started with, checked against the state's spec hash
 *   state.json      the run state, replaced atomically
 *   journal.jsonl   append-only records, redacted on the way in
 *   snapshots.json  working-tree snapshots by key (for `diff` baselines)
 *   reports/        result reports, redacted
 *   lock            held while one process changes the run
 *
 * Redaction lives here, in the only code that writes the journal and the reports, so no caller can
 * forget it.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isRunId,
  type JournalRecord,
  KodelError,
  RECORD_VERSION,
  type RedactRule,
  type ResultReport,
  type RunState,
  redactDeep,
} from "@kodel-ai/pipeline-core";
import { sha256 } from "./integrity";

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

/** A lock file that stays empty this long was left by a process that died while creating it. */
const UNFINISHED_LOCK_MS = 5_000;

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
    if (!isRunId(runId)) throw new KodelError("UNKNOWN_RUN", `"${runId}" is not a run id`);
    return join(this.options.root, "runs", runId);
  }

  private redact<T>(value: T): T {
    return redactDeep(value, this.rules);
  }

  /** Write a file so that a reader sees the old content or the new, never half of it. */
  private async writeAtomic(path: string, content: string): Promise<void> {
    this.writes += 1;
    const tmp = `${path}.tmp-${this.pid}-${this.writes}`;
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
      if (!isRunId(name)) continue;
      const meta = await this.readMeta(name);
      // The id inside the file has to be the folder's: otherwise a file an agent can write would
      // put its own text where a run id is shown, and name a run that is not there.
      if (meta && meta.runId === name) metas.push(meta);
    }
    return metas.sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  }

  /** The newest run of this pipeline and task, finished or not. */
  async findLatest(
    pipeline: string,
    task: string,
  ): Promise<{ meta: RunMeta; state: RunState } | undefined> {
    const redactedTask = this.redact(task);
    const candidates = (await this.listRuns()).filter(
      (m) => m.pipeline === pipeline && m.task === redactedTask,
    );
    for (const meta of candidates.reverse()) {
      const state = await this.readState(meta.runId);
      if (state) return { meta, state };
    }
    return undefined;
  }

  /** Keep the pipeline a run started with, so editing the file later does not change a run in flight. */
  async writeSpec(runId: string, source: string): Promise<void> {
    await this.writeAtomic(join(this.runDir(runId), "spec.yaml"), source);
  }

  /** The pipeline source a run started with. It is parsed and checked again by whoever uses it. */
  async readSpec(runId: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.runDir(runId), "spec.yaml"), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
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
    let state: RunState;
    try {
      state = JSON.parse(text) as RunState;
    } catch {
      throw new KodelError(
        "STATE_MODIFIED_EXTERNALLY",
        `the state of run ${runId} is not valid JSON; it was changed outside kodel`,
      );
    }
    if (state.v > RECORD_VERSION) {
      throw new KodelError(
        "UNSUPPORTED_FORMAT",
        `run ${runId} was written by a newer kodel (state format ${state.v}); upgrade kodel`,
      );
    }
    return { state, hash: sha256(text) };
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
    const lines = records.map((r) => `${JSON.stringify(this.redact(r))}\n`).join("");
    const handle = await open(join(this.runDir(runId), "journal.jsonl"), "a");
    try {
      await handle.writeFile(lines);
      await handle.sync();
    } finally {
      await handle.close();
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
    return this.queued(runId, join(this.runDir(runId), "lock"), fn);
  }

  /** Held while a run is looked for and created, so two starts of one task cannot make two runs. */
  async withStartLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.queued("start", join(this.options.root, "start.lock"), fn);
  }

  private queued<T>(key: string, lockPath: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.held.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.lockedRun(key, lockPath, fn));
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
  private async lockAbandoned(lockPath: string, sameAs?: string): Promise<string | undefined> {
    const now = Date.now();
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
      !this.isAlive(holder.pid) ||
      now - holder.since > this.staleLockMs ||
      holder.since > now + this.staleLockMs;
    return gone ? text : undefined;
  }

  /**
   * Remove an abandoned lock. Only one waiter at a time gets to do it (a second lock file guards the
   * removal), and it looks again once it is in, so a lock that someone took in the meantime stays.
   */
  private async takeOverAbandoned(lockPath: string): Promise<boolean> {
    const seen = await this.lockAbandoned(lockPath);
    if (seen === undefined) return false;
    const guardPath = `${lockPath}.takeover`;
    let guard: Awaited<ReturnType<typeof open>>;
    try {
      guard = await open(guardPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const modified = await stat(guardPath).then(
        (s) => s.mtimeMs,
        () => Date.now(),
      );
      if (Date.now() - modified > UNFINISHED_LOCK_MS) await rm(guardPath, { force: true });
      return false;
    }
    try {
      await guard.close();
      // Only the lock that was judged abandoned goes: if its holder let it go and someone took it
      // since, the text is different and it stays.
      if ((await this.lockAbandoned(lockPath, seen)) === undefined) return false;
      await rm(lockPath, { force: true });
      return true;
    } finally {
      await rm(guardPath, { force: true });
    }
  }

  private async lockedRun<T>(name: string, lockPath: string, fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.lockTimeoutMs;
    const token = randomUUID();
    await mkdir(dirname(lockPath), { recursive: true });
    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify({ pid: this.pid, since: Date.now(), token }));
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.takeOverAbandoned(lockPath)) continue;
        if (Date.now() > deadline) {
          throw new KodelError("STATE_LOCKED", `timed out waiting for the lock on ${name}`);
        }
        await sleep(20);
      }
    }
    try {
      return await fn();
    } finally {
      // Not ours any more if someone took it over after it went stale; leave theirs alone.
      const holder = await this.readJson<{ token?: string }>(lockPath).catch(() => undefined);
      if (holder?.token === token) await rm(lockPath, { force: true });
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
