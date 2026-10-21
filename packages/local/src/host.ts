/**
 * The local host: carries out the effects of the core state machine with real adapters (file store,
 * git snapshots, shell commands) and saves the state after every decision.
 *
 * Engine work (commands and checks) runs as tasks inside this process. Nothing waits for it: the
 * caller gets the next answer and asks again later. If the process dies, a later `tick` finds the
 * work without a heartbeat and restarts it; the state on disk is all that is needed for that.
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  type ChangeSet,
  type CheckVerdict,
  canonicalPipeline,
  type Decision,
  decide,
  defaultRegistry,
  describeEffect,
  diffPipelines,
  type Effect,
  type EngineOptions,
  evaluateCommand,
  evaluateDiff,
  evaluateResult,
  KodelError,
  mergeReports,
  type NextStep,
  nextStep,
  type PendingChange,
  type PipelineSpec,
  parsePipeline,
  parseSnapshot,
  type RedactRule,
  type RunEvent,
  type RunReport,
  type RunState,
  redactText,
  renderDeep,
  rowsToCsv,
  type StepResult,
  summarizeRun,
  validateReport,
} from "@kodel-ai/pipeline-core";
import { type CommandOptions, type CommandResult, runCommand } from "./command";
import type { WorktreeConfig } from "./config";
import { GitSnapshotter } from "./git";
import { defaultIntegrityDir, FileIntegrity, type IntegrityStore } from "./integrity";
import { FileStore, META_VERSION, newRunId, type RunMeta } from "./store";
import { GitWorktreeProvider, type Workdir, type WorkdirProvider } from "./worktree";

export interface CommandContext {
  runId: string;
  node: string;
  attempt: number;
  /** `node`: the node's own command. `check`: a `command` check. */
  source: "node" | "check";
  checkIndex?: number;
  /** True when this is a restart after the process running it stopped answering. */
  restart: boolean;
}

/** How commands are run. Tests replace it; it is never replaced in production. */
export type RunCommandFn = (
  command: string,
  options: CommandOptions,
  context: CommandContext,
) => Promise<CommandResult>;

export type RunCheckEffect = Extract<Effect, { type: "run_check" }>;

export interface CheckContext {
  runId: string;
  signal: AbortSignal;
  store: FileStore;
  /** The run's own: it looks at the run's working directory, not at the root. */
  snapshotter: GitSnapshotter;
  /** The run's working directory, checked just now. */
  cwd: string;
}

/** How a kind of check gathers its facts and reaches a verdict. Plugin kinds add one. */
export type CheckRunner = (effect: RunCheckEffect, context: CheckContext) => Promise<CheckVerdict>;

export interface HostOptions {
  /** The working directory commands run in; usually the repository root. */
  root: string;
  /** Where runs are kept; defaults to `<root>/.kodel`. */
  storeRoot?: string;
  rules?: RedactRule[];
  engine?: EngineOptions;
  clock?: () => number;
  runCommand?: RunCommandFn;
  snapshotter?: GitSnapshotter;
  /** Makes and checks the directories runs work in; by default git worktrees of `root`. */
  workdirs?: WorkdirProvider;
  checkRunners?: Record<string, CheckRunner>;
  /** How often running engine work sends a heartbeat; 0 turns the timer off (tests). */
  heartbeatMs?: number;
  maxTailBytes?: number;
  /** Where the trusted hash of a run's state is kept; by default a file outside the repository. */
  integrity?: IntegrityStore;
  /** The directory for those files; defaults to `defaultIntegrityDir()`. */
  integrityDir?: string;
  /** The YAML the pipeline was read from; a copy is kept with each run so the run is pinned to it. */
  source?: string;
  /** The pipeline file, relative to `root` with `/` separators; kept in the run's state. */
  pipelineFile?: string;
  /** How this process is named as the owner of engine work; `<host>:<pid>` by default. */
  ownerId?: string;
  /** Whether an owner is still alive. Tests replace it; by default a process id on this machine is looked up. */
  isOwnerAlive?: (owner: string) => boolean;
}

/**
 * The environment of a command the engine runs: this process's, except that no `KODEL_*` variable
 * is passed on (a switch meant for kodel or for its tests must not reach the project's own commands:
 * a `bun test` that saw the switch of the real-agent tests started them again), and the command is
 * told it is run by the engine, for which run, node and attempt.
 */
export function engineEnv(
  step: { runId: string; node: string; attempt: number; workdir?: string },
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith("KODEL_")) env[key] = value;
  }
  env.KODEL_ENGINE = "1";
  env.KODEL_RUN_ID = step.runId;
  env.KODEL_NODE = step.node;
  env.KODEL_ATTEMPT = String(step.attempt);
  if (step.workdir !== undefined) env.KODEL_WORKDIR = step.workdir;
  return env;
}

/** `<host>:<pid>` of this process. */
export const processOwnerId = (): string => `${hostname()}:${process.pid}`;

/**
 * Whether the process behind an owner id is alive. Only an owner on this machine can be judged;
 * for any other the answer is "alive" and the heartbeat timeout decides.
 */
export function processIsAlive(owner: string): boolean {
  const split = owner.lastIndexOf(":");
  if (split < 0 || owner.slice(0, split) !== hostname()) return true;
  const pid = Number(owner.slice(split + 1));
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const DEFAULT_COMMAND_TIMEOUT_S = 3_600;

/** The text fields an event carries from outside; the rest is structure and is left alone. */
const FREE_TEXT_FIELDS = ["reason", "summary", "message", "suggestion", "note"] as const;

function redactEvent(event: RunEvent, rules: RedactRule[]): RunEvent {
  const copy = { ...event } as Record<string, unknown>;
  for (const field of FREE_TEXT_FIELDS) {
    const value = copy[field];
    if (typeof value === "string") copy[field] = redactText(value, rules);
  }
  return copy as unknown as RunEvent;
}

/** An error as text for a person or an agent; the code of the engine's own errors goes first. */
const describeError = (error: unknown): string =>
  error instanceof KodelError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);

const REASON_TAIL = 2_000;
const lastChars = (text: string, n: number) => (text.length > n ? `...${text.slice(-n)}` : text);

/**
 * What changed in the files, as far as it can be told. `no_repo`: there is no git here, so there is
 * nothing to compare with. `unavailable`: there should be a comparison and there is none, which is
 * different from "nothing changed" and has to be said so.
 */
export type ChangeReport =
  | { kind: "changes"; files: ChangeSet }
  | { kind: "unavailable"; reason: string }
  | { kind: "no_repo" };

/** The most files a gate answer lists; the rest are only counted. */
export const MAX_CHANGES_SHOWN = 200;

/** The files with the most lines changed, up to `MAX_CHANGES_SHOWN`, and how many were left out. */
export function capChanges(files: ChangeSet): { shown: ChangeSet; omitted: number } {
  const all = Object.entries(files).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    shown: Object.fromEntries(all.slice(0, MAX_CHANGES_SHOWN)),
    omitted: Math.max(0, all.length - MAX_CHANGES_SHOWN),
  };
}

/** The hash a run is pinned to: of the pipeline's source text. */
export function hashSource(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

/** The hash older runs are pinned to: of the parsed pipeline (it changes when the parser does). */
export function hashSpec(spec: PipelineSpec): string {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
}

export class LocalHost {
  readonly store: FileStore;
  readonly snapshotter: GitSnapshotter;
  readonly clock: () => number;
  readonly engine: EngineOptions;
  readonly runner: RunCommandFn;
  readonly rules: RedactRule[];
  readonly checkRunners: Record<string, CheckRunner>;
  readonly heartbeatMs: number;
  readonly maxTailBytes: number | undefined;
  readonly integrity: IntegrityStore;
  readonly ownerId: string;
  readonly isOwnerAlive: (owner: string) => boolean;

  constructor(
    readonly spec: PipelineSpec,
    readonly options: HostOptions,
  ) {
    this.rules = options.rules ?? [];
    const storeRoot = options.storeRoot ?? `${options.root}/.kodel`;
    this.store = new FileStore({ root: storeRoot, rules: this.rules });
    this.integrity =
      options.integrity ??
      new FileIntegrity(options.integrityDir ?? defaultIntegrityDir(), storeRoot);
    this.snapshotter = options.snapshotter ?? new GitSnapshotter(options.root);
    this.clock = options.clock ?? Date.now;
    this.engine = { fingerprint: hashSource, ...options.engine };
    this.runner = options.runCommand ?? ((command, opts) => runCommand(command, opts));
    this.heartbeatMs =
      options.heartbeatMs ?? Math.max(1_000, (options.engine?.staleMs ?? 30_000) / 3);
    this.maxTailBytes = options.maxTailBytes;
    this.ownerId = options.ownerId ?? processOwnerId();
    this.isOwnerAlive = options.isOwnerAlive ?? processIsAlive;
    this.checkRunners = { ...builtinCheckRunners(this), ...options.checkRunners };
  }

  /**
   * The active run for this task, or a new one. If the task already ran to its end, that run comes
   * back with `terminal: true` and nothing new starts, unless `restart` says the user wants another.
   */
  async start(
    task: string,
    options: { restart?: boolean; cwd?: string; worktree?: WorktreeConfig } = {},
  ): Promise<{ run: LocalRun; reused: boolean; terminal: boolean; workdir?: Workdir }> {
    const registry = this.engine.registry ?? defaultRegistry();
    const needsGit = this.spec.nodes.some((n) =>
      n.checks.some((c) => registry.check(c.kind)?.baseline?.(c.params)),
    );
    if (needsGit && !(await this.snapshotter.isRepo())) {
      throw new Error(
        `this pipeline has a diff check, which needs a git repository, and ${this.options.root} is not inside one`,
      );
    }
    // Spaces at the ends or doubled are not a different task; otherwise a changed space would
    // slip past the run that is waiting for a person.
    const redactedTask = redactText(task.trim().replace(/\s+/g, " "), this.rules);
    const started = await this.store.withStartLock(async () => {
      const existing = await this.store.findActive(this.spec.name, redactedTask);
      if (existing) {
        return { run: new LocalRun(this, existing.meta.runId), reused: true, terminal: false };
      }
      if (options.restart !== true) {
        const latest = await this.store.findLatest(this.spec.name, redactedTask);
        if (latest) {
          return { run: new LocalRun(this, latest.meta.runId), reused: false, terminal: true };
        }
      }

      const now = this.clock();
      const runId = newRunId(now);
      // Of the text the pipeline was read from, when it is known: that is what a copy is checked
      // against, and it does not change when the parser learns a new field.
      const specHash = this.specHash;
      // The directory first, then the run: a failure after this point takes the directory away
      // again, so no half-made run is left behind.
      const provider =
        this.options.workdirs ??
        (options.worktree
          ? new GitWorktreeProvider(this.options.root, options.worktree)
          : undefined);
      const workdir = await provider?.prepare({
        runId,
        ...(options.cwd === undefined ? {} : { callerCwd: options.cwd }),
      });
      try {
        const meta: RunMeta = {
          v: META_VERSION,
          runId,
          pipeline: this.spec.name,
          task: redactedTask,
          specHash,
          createdAt: now,
          ...(workdir ? { workdir: workdir.path } : {}),
          // The branch only when kodel made it: it is what the hint at the end offers to delete.
          ...(workdir?.branch === undefined ? {} : { branch: workdir.branch }),
        };
        await this.store.createRun(meta);
        if (this.options.source !== undefined)
          await this.store.writeSpec(runId, specHash, this.options.source);
        const run = new LocalRun(this, runId);
        const result = await run.apply({
          type: "start",
          runId,
          task: redactedTask,
          specHash,
          ...(workdir ? { workdir: workdir.path } : {}),
          ...(workdir?.branch === undefined ? {} : { branch: workdir.branch }),
          ...(this.options.pipelineFile === undefined
            ? {}
            : { pipelineFile: this.options.pipelineFile }),
        });
        if (!result.ok) throw result.error;
        return { run, reused: false, terminal: false, ...(workdir ? { workdir } : {}) };
      } catch (error) {
        await this.store.removeRun(runId).catch(() => undefined);
        if (workdir) await provider?.discard(workdir).catch(() => undefined);
        throw error;
      }
    });
    // Where the files stood when the run began, so a person at a gate can be shown what changed.
    // Taken once the run exists and the start lock is let go (it reads the whole working tree), and
    // only if a check did not already take it. It may fail without failing the start; what is then
    // missing is said at the gate, not hidden.
    if (!started.reused && !started.terminal) await started.run.recordRunBaseline();
    return started;
  }

  /** Throws `WORKDIR_MISSING` or `WORKDIR_INVALID` unless `workdir` is still the run's own directory. */
  verifyWorkdir(workdir: string): Promise<void> {
    return (this.options.workdirs ?? new GitWorktreeProvider(this.options.root)).verify(workdir);
  }

  /** The hash a run started with this pipeline is pinned to. */
  get specHash(): string {
    return this.options.source !== undefined
      ? hashSource(this.options.source)
      : hashSpec(this.spec);
  }

  /** A handle on a run that is already on disk (after a restart, or from another process). */
  open(runId: string): LocalRun {
    return new LocalRun(this, runId);
  }

  /**
   * Accept the current files of a finished run after a deliberate change: the change is journaled
   * as a manual edit and the seal is made again.
   */
  async seal(runId: string): Promise<void> {
    const state = await this.store.readState(runId);
    if (!state) throw new Error(`there is no run ${runId}`);
    if (state.status === "running" || state.status === "paused") {
      throw new Error(`run ${runId} is still ${state.status}; only a finished run can be sealed`);
    }
    const result = await this.open(runId).acknowledge("sealed after a manual change");
    if (!result.ok) throw result.error;
  }
}

export class LocalRun {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly tasks = new Map<
    string,
    { controller: AbortController; node: string; attempt: number }
  >();
  private readonly pending = new Set<Promise<void>>();

  private recorded: Promise<RunMeta | undefined> | undefined;

  constructor(
    private readonly host: LocalHost,
    readonly runId: string,
  ) {}

  /** The run's record of where it works (its `meta.json`); read once, it does not change. */
  private meta(): Promise<RunMeta | undefined> {
    if (!this.recorded) {
      this.recorded = this.host.store.readMeta(this.runId);
      // A read that failed is tried again next time, not remembered.
      this.recorded.catch(() => {
        this.recorded = undefined;
      });
    }
    return this.recorded;
  }

  /**
   * Where the run works, if that is not the repository root: the worktree made for it, or one it was
   * started in. The path is read from the run's state and held against the trusted hash like every
   * other read of it: `meta.json` can be rewritten by the agent, and a path taken from it would send
   * commands wherever the agent liked, or, with the field deleted, to the root. Only the branch (for
   * the hint at the end) comes from `meta.json`.
   */
  async location(): Promise<{ path: string; branch?: string } | undefined> {
    const raw = await this.host.store.readStateRaw(this.runId);
    if (raw && (await this.host.integrity.trusts(this.runId, raw.hash)) === false) {
      throw new KodelError(
        "STATE_MODIFIED_EXTERNALLY",
        `the state of run ${this.runId} was changed outside kodel; look at what changed, then accept it with "kodel ack ${this.runId}"`,
      );
    }
    const path = raw?.state.workdir;
    if (!path) return undefined;
    const branch = (await this.meta())?.branch;
    return { path, ...(branch === undefined ? {} : { branch }) };
  }

  /** The same, for a display that must not fail because the files are not as kodel left them. */
  private async locationForDisplay(): Promise<{ path: string; branch?: string } | undefined> {
    return this.location().catch(() => undefined);
  }

  /**
   * The directory commands, checks and snapshots of this run work in, checked just now: a worktree
   * that was removed or swapped since the last command is refused (`WORKDIR_MISSING`,
   * `WORKDIR_INVALID`), never replaced by the root.
   */
  private async cwd(): Promise<string> {
    const where = await this.location();
    if (!where) return this.host.options.root;
    await this.host.verifyWorkdir(where.path);
    return where.path;
  }

  private async snapshotter(): Promise<GitSnapshotter> {
    const cwd = await this.cwd();
    if (this.host.options.snapshotter) return this.host.options.snapshotter;
    return cwd === this.host.options.root ? this.host.snapshotter : new GitSnapshotter(cwd);
  }

  async state(): Promise<RunState> {
    const state = await this.host.store.readState(this.runId);
    if (!state) throw new Error(`run ${this.runId} has no state`);
    return state;
  }

  private readonly versions = new Map<string, PipelineSpec>();

  /**
   * The pipeline of a version the run has had, read from the copy kept with it and held against its
   * hash. The run's state names the version it is on, so what a run does follows what was accepted,
   * not what this process happened to be started with.
   */
  async specFor(hash: string): Promise<PipelineSpec> {
    if (hash === this.host.specHash) return this.host.spec;
    const known = this.versions.get(hash);
    if (known) return known;
    const text = await this.host.store.readSpec(this.runId, hash);
    if (text === undefined || hashSource(text) !== hash) {
      throw new KodelError(
        "STATE_MODIFIED_EXTERNALLY",
        `the pipeline of run ${this.runId} is not the one it is pinned to (its kept copy was changed or is missing); restore it before going on`,
      );
    }
    const spec = parseSnapshot(text);
    this.versions.set(hash, spec);
    return spec;
  }

  /** The pipeline the run is on now. */
  async currentSpec(state?: RunState): Promise<PipelineSpec> {
    return this.specFor((state ?? (await this.state())).specHash);
  }

  /**
   * The file the run's own pipeline is kept in, or none: for a run in a worktree that is the copy
   * there (a change in it reaches only this run, and the other runs after a merge), otherwise the
   * file in the repository. The path comes from the run's state, never from `meta.json`, and has to
   * stay inside the directory it is relative to, links followed.
   */
  private async watched(state: RunState): Promise<{ path: string; relative: string } | undefined> {
    if (state.pipelineFile === undefined) return undefined;
    const base = state.workdir ?? this.host.options.root;
    const path = join(base, state.pipelineFile);
    const inside = (from: string, to: string) => {
      const rel = relative(from, to);
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    };
    if (!inside(base, path)) return undefined;
    try {
      if (!inside(await realpath(base), await realpath(path))) return undefined;
    } catch {
      return undefined;
    }
    return { path, relative: state.pipelineFile };
  }

  /**
   * A change of the pipeline that waits for a person: the run's own file no longer says what the run
   * is pinned to. Only what the pipeline means counts, not comments or layout, and a file that is
   * not a pipeline is not a change. The text and hash come along for `acceptChange`.
   */
  async pendingChange(
    state?: RunState,
  ): Promise<{ info: PendingChange; text: string; hash: string; spec: PipelineSpec } | undefined> {
    const now = state ?? (await this.state());
    if (now.status !== "running" && now.status !== "paused") return undefined;
    const where = await this.watched(now);
    if (!where) return undefined;
    let text: string;
    try {
      text = await readFile(where.path, "utf8");
    } catch {
      return undefined;
    }
    const hash = hashSource(text);
    if (hash === now.specHash) return undefined;
    let spec: PipelineSpec;
    try {
      spec = parsePipeline(text);
    } catch (error) {
      if (error instanceof KodelError) return undefined;
      throw error;
    }
    const current = await this.currentSpec(now);
    if (canonicalPipeline(spec) === canonicalPipeline(current)) return undefined;
    const diff = diffPipelines(current, spec, now);
    return {
      text,
      hash,
      spec,
      info: {
        source: "file",
        watched: where.relative,
        changes: diff.nodes,
        effect: diff.effect,
        redo: describeEffect(diff.effect),
        ...(diff.refused === undefined ? {} : { refused: diff.refused }),
        apply: `kodel pipeline changes apply ${this.runId}`,
        blocking: diff.refused === undefined,
      },
    };
  }

  /**
   * Take another version of the pipeline for this run: keep it with the run, then let the machine
   * move the run onto it. A person decides this (`kodel pipeline changes apply`), never the agent.
   */
  async acceptChange(input: {
    source: "file" | "proposal";
    text: string;
    reason?: string;
  }): Promise<Decision> {
    const state = await this.state();
    const before = await this.currentSpec(state);
    const to = hashSource(input.text);
    try {
      parsePipeline(input.text);
    } catch (error) {
      if (error instanceof KodelError) return { ok: false, error };
      throw error;
    }
    await this.host.store.writeSpec(this.runId, to, input.text);
    return this.apply({
      type: "pipeline_accepted",
      from: state.specHash,
      to,
      source: input.source,
      before,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
  }

  /**
   * Apply one event under the run's lock, save the result and start the work it asks for.
   * If the state file is not what kodel last wrote, nothing is applied (`STATE_MODIFIED_EXTERNALLY`);
   * `trust` skips that check and is only for a human accepting the change.
   */
  apply(event: RunEvent, options: { trust?: boolean } = {}): Promise<Decision> {
    const step = this.queue
      .catch(() => undefined)
      .then(() => this.applyLocked(event, options.trust === true));
    this.queue = step;
    return step;
  }

  private applyLocked(incoming: RunEvent, trust: boolean): Promise<Decision> {
    const { store, engine, clock, integrity, rules } = this.host;
    // Whatever text came with the event (a reason, a message) reaches state and journal redacted.
    const event = redactEvent(incoming, rules);
    return store.withLock(this.runId, async () => {
      let state: RunState | undefined;
      if (event.type !== "start") {
        let raw: Awaited<ReturnType<typeof store.readStateRaw>>;
        try {
          raw = await store.readStateRaw(this.runId);
        } catch (error) {
          if (error instanceof KodelError && error.code === "STATE_MODIFIED_EXTERNALLY") {
            return { ok: false, error } satisfies Decision;
          }
          throw error;
        }
        state = raw?.state;
        if (raw && !trust) {
          const trusted = await integrity.trusts(this.runId, raw.hash);
          if (trusted === undefined) {
            // First time this machine sees the run (a fresh clone, say): take it as it is.
            await integrity.set(this.runId, raw.hash);
          } else if (!trusted) {
            const error = new KodelError(
              "STATE_MODIFIED_EXTERNALLY",
              `the state of run ${this.runId} was changed outside kodel; look at what changed, then accept it with "kodel ack ${this.runId}"`,
            );
            return { ok: false, error } satisfies Decision;
          }
        }
      }
      // An event is decided with the pipeline the run is on; the one that moves it to another version,
      // with that other.
      const spec = !state
        ? this.host.spec
        : await this.specFor(event.type === "pipeline_accepted" ? event.to : state.specHash);
      const decision = decide(spec, state, event, clock(), engine);
      if (!decision.ok || decision.noop) return decision;
      // A tick that found nothing to do changes nothing, so it writes nothing.
      const changed =
        event.type !== "tick" || decision.journal.length > 0 || decision.effects.length > 0;
      if (changed) {
        // The expected hash is recorded before the file changes and confirmed after, so a crash
        // between the two leaves a state that is still accepted, not one that looks tampered with.
        const hash = await store.writeState(this.runId, decision.state, (next) =>
          integrity.stage(this.runId, next),
        );
        await integrity.set(this.runId, hash);
        await store.appendJournal(this.runId, decision.journal);
        const finished = ["completed", "failed", "canceled"].includes(decision.state.status);
        if (finished) {
          const sealHash = await store.writeSeal(this.runId, clock());
          await integrity.set(`${this.runId}.seal`, sealHash);
        }
      }
      for (const effect of decision.effects) await this.dispatch(effect);
      return decision;
    });
  }

  /** Whether the state file is what kodel last wrote. `unknown`: kodel has not seen this run yet. */
  async integrityStatus(): Promise<"ok" | "modified" | "unknown"> {
    const raw = await this.host.store.readStateRaw(this.runId).catch(() => undefined);
    if (!raw) return "modified";
    const trusted = await this.host.integrity.trusts(this.runId, raw.hash);
    if (trusted === undefined) return "unknown";
    return trusted ? "ok" : "modified";
  }

  /**
   * Whether a finished run is as it was when it finished, judged against the seal hash kept outside
   * the repository. `open`: the run has not finished, so there is no seal yet.
   */
  async sealStatus(): Promise<"sealed" | "modified" | "unsealed" | "open"> {
    const state = await this.state();
    if (state.status === "running" || state.status === "paused") return "open";
    const trusted = await this.host.integrity.get(`${this.runId}.seal`);
    return this.host.store.checkSeal(this.runId, trusted);
  }

  /**
   * What to do next, read-only: nothing is written and no work is restarted, so it is safe for a
   * command that only looks (`kodel status`).
   */
  async inspect(): Promise<NextStep> {
    const state = await this.state();
    const pending = await this.pendingChange(state);
    return nextStep(
      await this.currentSpec(state),
      state,
      this.host.clock(),
      this.host.engine.registry ?? defaultRegistry(),
      pending ? { pending: pending.info } : {},
    );
  }

  /** Take the working tree as it is, once, as the baseline of the whole run (not an error if it fails). */
  async recordRunBaseline(): Promise<void> {
    const { store } = this.host;
    try {
      const snapshotter = await this.snapshotter();
      if (!(await snapshotter.isRepo())) return;
      if ((await store.readSnapshots(this.runId)).run !== undefined) return; // a check took it
      await store.writeSnapshot(this.runId, "run", await snapshotter.snapshot());
    } catch (error) {
      await store
        .writeSnapshot(this.runId, "run!", error instanceof Error ? error.message : String(error))
        .catch(() => undefined);
    }
  }

  /**
   * What changed in the files since the run reached this human step: a person approving should know
   * if the agent kept working after the checks passed. When that cannot be told (the baseline is
   * missing, or git fails now), that is said as it is, never as "nothing changed": whoever makes git
   * fail must not get an approval that looks clean.
   */
  async changesSinceGate(node: string): Promise<ChangeReport> {
    const visit = (await this.state()).active.find((v) => v.node === node && v.phase === "human");
    if (!visit) return { kind: "unavailable", reason: `the run is not waiting at "${node}"` };
    const snapshots = await this.host.store.readSnapshots(this.runId);
    const tree = snapshots[`gate:${node}:${visit.attempt}`];
    if (tree === undefined) {
      if (snapshots.run === undefined && snapshots["run!"] === undefined)
        return { kind: "no_repo" };
      const why = snapshots[`gate:${node}:${visit.attempt}!`];
      return {
        kind: "unavailable",
        reason: `the files were not recorded when the run reached this step${why ? ` (${why})` : ""}`,
      };
    }
    try {
      return { kind: "changes", files: await (await this.snapshotter()).changesSince(tree) };
    } catch (error) {
      return { kind: "unavailable", reason: describeError(error) };
    }
  }

  /** Accept the files of this finished run after a deliberate change, and seal them again. */
  seal(): Promise<void> {
    return this.host.seal(this.runId);
  }

  /** A human accepts the files as they are now; this is journaled as a manual edit. */
  acknowledge(note?: string): Promise<Decision> {
    return this.apply(
      { type: "acknowledge", ...(note === undefined ? {} : { note }) },
      { trust: true },
    );
  }

  private async dispatch(effect: Effect): Promise<void> {
    switch (effect.type) {
      case "take_snapshot": {
        const tree = await (await this.snapshotter()).snapshot();
        await this.host.store.writeSnapshot(this.runId, effect.key, tree);
        return;
      }
      case "run_command":
      case "run_check":
        this.spawn(effect);
        return;
      case "await_human": {
        // Where the files stood when the person was asked, so approving can show what changed since.
        // If that cannot be taken, the run still waits for the person (the state is already saved,
        // and a failure here must not turn into an error for the agent that completed the step);
        // what is missing is recorded, so the gate says it cannot tell instead of showing nothing.
        const key = `gate:${effect.node}:${effect.attempt}`;
        try {
          const snapshotter = await this.snapshotter();
          if (await snapshotter.isRepo()) {
            await this.host.store.writeSnapshot(this.runId, key, await snapshotter.snapshot());
          }
        } catch (error) {
          await this.host.store
            .writeSnapshot(
              this.runId,
              `${key}!`,
              error instanceof Error ? error.message : String(error),
            )
            .catch(() => undefined);
        }
        return;
      }
      default:
        return; // need_agent waits for the agent
    }
  }

  // engine work

  private spawn(effect: Extract<Effect, { type: "run_command" | "run_check" }>) {
    // One task per piece of work: the node's command, or one numbered check. The work after this
    // piece (the next check) is started while this task is still being wound up.
    const key =
      effect.type === "run_check"
        ? `${effect.node}#${effect.attempt}#check${effect.index}`
        : `${effect.node}#${effect.attempt}#command`;
    if (this.tasks.has(key)) return;
    const controller = new AbortController();
    const heartbeat = () =>
      this.apply({
        type: "heartbeat",
        node: effect.node,
        attempt: effect.attempt,
        owner: this.host.ownerId,
      }).catch(() => undefined);
    const beat =
      this.host.heartbeatMs > 0
        ? setInterval(() => void heartbeat(), this.host.heartbeatMs)
        : undefined;
    beat?.unref();
    this.tasks.set(key, { controller, node: effect.node, attempt: effect.attempt });
    // Say who is running it right away: if this process goes, the next session sees at once that
    // the owner is gone and starts the work again, without waiting for the heartbeat to go stale.
    void heartbeat();

    const job = (async () => {
      try {
        let event: RunEvent;
        try {
          event =
            effect.type === "run_command"
              ? await this.runNodeCommand(effect, controller.signal)
              : await this.runCheck(effect, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) return;
          const reason = `the host could not finish this: ${describeError(error)}`;
          event =
            effect.type === "run_command"
              ? {
                  type: "work_finished",
                  node: effect.node,
                  attempt: effect.attempt,
                  passed: false,
                  reason,
                }
              : {
                  type: "check_finished",
                  node: effect.node,
                  attempt: effect.attempt,
                  index: effect.index,
                  passed: false,
                  reason,
                };
        }
        if (!controller.signal.aborted) await this.applyWithRetry(event);
      } catch {
        // The result could not be saved (a lock that stayed taken, a full disk). That is the
        // store's failure, not the node's, so the node is not marked failed: without a heartbeat
        // the work looks stale and the next tick runs it again.
      } finally {
        if (beat) clearInterval(beat);
        this.tasks.delete(key);
      }
    })();
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  /** Save a result, trying again a few times: the usual cause is another process holding the lock. */
  private async applyWithRetry(event: RunEvent): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.apply(event);
        return;
      } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
  }

  private commandOptions(
    signal: AbortSignal,
    timeout: number | undefined,
    step: { node: string; attempt: number },
    cwd: string,
  ): CommandOptions {
    const { rules, maxTailBytes } = this.host;
    return {
      cwd,
      // Told only to a run that works somewhere other than the root: for the rest nothing changes.
      env: engineEnv({
        runId: this.runId,
        ...step,
        ...(cwd === this.host.options.root ? {} : { workdir: cwd }),
      }),
      inheritEnv: false,
      signal,
      redact: (text) => redactText(text, rules),
      // A command with no limit of its own gets a long one: it may never hang the run for good.
      timeoutMs: (timeout ?? DEFAULT_COMMAND_TIMEOUT_S) * 1000,
      ...(maxTailBytes === undefined ? {} : { maxTailBytes }),
    };
  }

  private async runNodeCommand(
    effect: Extract<Effect, { type: "run_command" }>,
    signal: AbortSignal,
  ): Promise<RunEvent> {
    const cwd = await this.cwd();
    const { specHash } = await this.state();
    const result = await this.host.runner(
      effect.command,
      this.commandOptions(signal, effect.timeout, effect, cwd),
      {
        runId: this.runId,
        node: effect.node,
        attempt: effect.attempt,
        source: "node",
        restart: effect.restart,
      },
    );
    const verdict = commandVerdict(
      result,
      effect.expect,
      effect.timeout ?? DEFAULT_COMMAND_TIMEOUT_S,
    );
    return {
      type: "work_finished",
      node: effect.node,
      attempt: effect.attempt,
      passed: verdict.passed,
      reason: verdict.reason,
      exit: result.exit,
      duration_ms: result.durationMs,
      specHash,
    };
  }

  private async runCheck(effect: RunCheckEffect, signal: AbortSignal): Promise<RunEvent> {
    const runner = this.host.checkRunners[effect.kind];
    const started = Date.now();
    const cwd = await this.cwd();
    const { specHash } = await this.state();
    const verdict: CheckVerdict = runner
      ? await runner(effect, {
          runId: this.runId,
          signal,
          store: this.host.store,
          snapshotter: await this.snapshotter(),
          cwd,
        })
      : { passed: false, reason: `no runner for the check kind "${effect.kind}"` };
    return {
      type: "check_finished",
      node: effect.node,
      attempt: effect.attempt,
      index: effect.index,
      passed: verdict.passed,
      reason: verdict.reason,
      ...(verdict.exit === undefined ? {} : { exit: verdict.exit }),
      duration_ms: Date.now() - started,
      specHash,
    };
  }

  /** The nodes whose engine work is running in this process. */
  activeWork(): { node: string; attempt: number }[] {
    return [...this.tasks.values()].map(({ node, attempt }) => ({ node, attempt }));
  }

  /**
   * Wait until the work running in this process has finished and its results are applied.
   * `parked` says how many tasks are known to be stuck on purpose (tests), so they are not waited for.
   */
  async settle(parked: () => number = () => 0, deadline = Number.POSITIVE_INFINITY): Promise<void> {
    for (;;) {
      await this.queue.catch(() => undefined);
      if (this.pending.size <= parked()) {
        await this.queue.catch(() => undefined);
        if (this.pending.size <= parked()) return;
      }
      const left = deadline - Date.now();
      if (left <= 0) return;
      // Wake up for the deadline too, so a wait that runs out does not leave a loop behind that
      // goes on until the work is done.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = new Promise<void>((resolve) => {
        timer = Number.isFinite(left) ? setTimeout(resolve, left) : undefined;
      });
      try {
        await Promise.race([...this.pending, wake]);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Wait for the engine's work on this run to come to rest, but no longer than `ms`: the work this
   * process runs, and also work another process owns (a session still going), which is watched in
   * the state on disk.
   */
  async waitForRest(ms: number): Promise<void> {
    if (ms <= 0) return;
    const deadline = Date.now() + ms;
    await this.settle(() => 0, deadline);
    // What is left is work another process owns. It is watched in the state on disk, and looked at
    // with a tick now and then, so work that has gone silent or lost its owner is started again
    // during the wait instead of after it.
    let rounds = 0;
    while (Date.now() < deadline && (await this.engineBusy())) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(300, deadline - Date.now())));
      if (++rounds % 4 === 0) await this.tick().catch(() => undefined);
      await this.settle(() => 0, deadline); // a tick may have started work in this process
    }
  }

  private async engineBusy(): Promise<boolean> {
    const state = await this.state().catch(() => undefined);
    return state?.active.some((v) => v.phase === "engine" || v.phase === "checks") ?? false;
  }

  /**
   * Stop all work in this process without reporting anything, as if the process had died. Returns
   * how many pieces of work were stopped, so a caller that is about to exit knows whether to give
   * them the moment they need to die (see `KILL_GRACE_MS`).
   */
  stop(): number {
    const running = [...this.tasks.values()];
    for (const { controller } of running) controller.abort();
    return running.length;
  }

  // what callers do

  /** What the agent should do next. Throws `STATE_MODIFIED_EXTERNALLY` if the files were tampered with. */
  async nextStep(options: { atCompletion?: boolean } = {}): Promise<NextStep> {
    const tick = await this.tick();
    if (!tick.ok && tick.error.code === "STATE_MODIFIED_EXTERNALLY") throw tick.error;
    if ((await this.sealStatus()) === "modified") {
      throw new KodelError(
        "STATE_MODIFIED_EXTERNALLY",
        `run ${this.runId} finished and was changed afterwards; look at what changed, then accept it with "kodel seal ${this.runId}"`,
      );
    }
    const state = await this.state();
    const pending = await this.pendingChange(state);
    const step = nextStep(
      await this.currentSpec(state),
      state,
      this.host.clock(),
      this.host.engine.registry ?? defaultRegistry(),
      {
        ...(pending ? { pending: pending.info } : {}),
        ...(options.atCompletion === true ? { atCompletion: true } : {}),
      },
    );
    if ("done" in step && step.run_status === "completed") {
      const where = await this.locationForDisplay();
      if (where?.branch !== undefined) {
        step.tell_the_person = doneHint(this.host.options.root, where.path, where.branch);
      }
    }
    if ("waiting" in step && step.waiting.reason === "gate") {
      const comments = await this.gateResults(step.waiting.node_slug);
      if (comments) step.waiting.results = comments.csv;
      const found = await this.changesSinceStart();
      if (found.kind === "unavailable") {
        step.waiting.changes_unavailable = found.reason;
      } else if (found.kind === "changes" && Object.keys(found.files).length > 0) {
        const { shown, omitted } = capChanges(found.files);
        step.waiting.changes = shown;
        if (omitted > 0) step.waiting.changes_omitted = omitted;
      }
    }
    return step;
  }

  /** Where the time went and what was redone, from the run's own state and journal. */
  async report(): Promise<RunReport> {
    const report = summarizeRun(await this.state(), await this.host.store.readJournal(this.runId));
    const where = await this.locationForDisplay();
    return where ? { ...report, workdir: where.path } : report;
  }

  /** Files changed since the run started, with the lines changed, or why that cannot be told. */
  async changesSinceStart(): Promise<ChangeReport> {
    const snapshots = await this.host.store.readSnapshots(this.runId);
    const tree = snapshots.run;
    if (tree === undefined) {
      if (snapshots["run!"] === undefined) return { kind: "no_repo" };
      return {
        kind: "unavailable",
        reason: `the files were not recorded when the run began (${snapshots["run!"]})`,
      };
    }
    try {
      return { kind: "changes", files: await (await this.snapshotter()).changesSince(tree) };
    } catch (error) {
      return { kind: "unavailable", reason: describeError(error) };
    }
  }

  /** Owners of engine work that are gone (their process is dead), so their work can restart at once. */
  private async deadOwners(): Promise<string[]> {
    const state = await this.state().catch(() => undefined);
    const owners = new Set<string>();
    for (const visit of state?.active ?? []) {
      if (visit.owner !== undefined && visit.owner !== this.host.ownerId) owners.add(visit.owner);
    }
    return [...owners].filter((owner) => !this.host.isOwnerAlive(owner));
  }

  async tick() {
    const deadOwners = await this.deadOwners();
    return this.apply(deadOwners.length > 0 ? { type: "tick", deadOwners } : { type: "tick" });
  }

  async completeStep(node: string, attempt: number, summary?: string, outcome?: string) {
    // A change of the pipeline that waits for a person is met here: what the step is judged by may be
    // about to change, so it is not judged yet. The agent is told to wait for the person.
    const held = await this.pendingChange();
    if (held?.info.blocking) {
      return {
        ok: true,
        state: await this.state(),
        effects: [],
        journal: [],
        noop: true,
      } satisfies Decision;
    }
    const decision = await this.apply({
      type: "agent_completed",
      node,
      attempt,
      ...(summary === undefined ? {} : { summary }),
      ...(outcome === undefined ? {} : { outcome }),
    });
    if (!decision.ok) {
      await this.recordRefusal("complete_step", node, attempt, decision.error);
    }
    return decision;
  }

  /**
   * Journal that a call of the agent was refused, so that what was tried can be looked at later. It
   * is left out when the files are not as kodel left them (writing would fail again, or paper over
   * it), when the lock cannot be had, and for a run that has finished (its seal must stay true); and
   * a failure to write it down never replaces the refusal itself.
   */
  private async recordRefusal(
    about: string,
    node: string | undefined,
    attempt: number | undefined,
    error: { code: string; message: string },
  ): Promise<void> {
    if (error.code === "STATE_MODIFIED_EXTERNALLY" || error.code === "STATE_LOCKED") return;
    try {
      const state = await this.state();
      if (state.status !== "running" && state.status !== "paused") return;
      await this.apply({
        type: "call_refused",
        about,
        ...(node === undefined ? {} : { node }),
        ...(attempt === undefined ? {} : { attempt }),
        code: error.code,
        message: error.message,
      });
    } catch {
      // nothing more to do about it
    }
  }

  /**
   * The comments recorded at a human step while the person talked to the agent, as CSV, or
   * nothing when the step takes none or none were made.
   */
  async gateResults(node: string): Promise<{ csv: string; count: number } | undefined> {
    const { engine, store } = this.host;
    const spec = await this.currentSpec();
    const nodeSpec = spec.nodes.find((n) => n.slug === node);
    const columns = (
      (engine.registry ?? defaultRegistry())
        .node(nodeSpec?.kind ?? "")
        ?.resultsSpec?.(nodeSpec?.params ?? {}) as { columns?: Record<string, unknown> } | undefined
    )?.columns;
    const visit = (await this.state()).active.find((v) => v.node === node && v.phase === "human");
    if (!columns || !visit) return undefined;
    const report = await store.readReport(this.runId, node, visit.attempt);
    if (!report || report.rows.length === 0) return undefined;
    return { csv: rowsToCsv(Object.keys(columns), report.rows), count: report.rows.length };
  }

  /**
   * A rejection without a reason of its own carries the comments recorded at the step, so the step
   * it returns to sees them; with both, the person's reason comes first.
   */
  async decideHuman(node: string, decision: "approved" | "rejected", reason?: string) {
    const comments = decision === "rejected" ? await this.gateResults(node) : undefined;
    const parts = [reason, comments ? `Comments (CSV):\n${comments.csv}` : undefined].filter(
      (part): part is string => part !== undefined && part !== "",
    );
    const full = parts.length > 0 ? parts.join("\n\n") : undefined;
    return this.apply({
      type: "human_decided",
      node,
      decision,
      ...(full === undefined ? {} : { reason: full }),
    });
  }

  resume() {
    return this.apply({ type: "resume" });
  }

  async cancel() {
    const decision = await this.apply({ type: "cancel" });
    // The run is over, so a command still going in this process has nothing left to report to.
    if (decision.ok) this.stop();
    return decision;
  }

  async feedback(input: {
    node?: string;
    attempt?: number;
    category: string;
    message: string;
    suggestion?: string;
  }) {
    const decision = await this.apply({ type: "feedback", ...input });
    if (!decision.ok)
      await this.recordRefusal("feedback", input.node, input.attempt, decision.error);
    return decision;
  }

  /**
   * Check a result report the agent sent and keep it: for the node's `result` check, or, at a
   * human step that takes them, as the comments the person makes. Rows are added to what is
   * stored for the attempt unless `replace` is set.
   */
  async reportResult(
    node: string,
    attempt: number,
    raw: unknown,
    options: { replace?: boolean } = {},
  ): Promise<StepResult> {
    const result = await this.acceptReport(node, attempt, raw, options.replace === true);
    if (!result.ok) await this.recordRefusal("report_result", node, attempt, result);
    return result;
  }

  private async acceptReport(
    node: string,
    attempt: number,
    raw: unknown,
    replace: boolean,
  ): Promise<StepResult> {
    const { engine, store } = this.host;
    const registry = engine.registry ?? defaultRegistry();
    const state = await this.state();
    const nodeSpec = (await this.currentSpec(state)).nodes.find((n) => n.slug === node);
    if (!nodeSpec)
      return { ok: false, code: "UNKNOWN_NODE", message: `the pipeline has no node "${node}"` };
    const visit = state.active.find((v) => v.node === node);
    if (!visit)
      return { ok: false, code: "NODE_NOT_RUNNING", message: `node "${node}" is not running` };
    if (visit.attempt !== attempt) {
      return {
        ok: false,
        code: "ATTEMPT_MISMATCH",
        message: `node "${node}" is on attempt ${visit.attempt}, not ${attempt}`,
      };
    }
    const check = nodeSpec.checks.find((c) => registry.check(c.kind)?.exposeSpec);
    // A human step has no verdict to give: its report is the person's comments, which need no
    // completeness, and only while the step waits for them.
    const gateSpec =
      check || visit.phase !== "human"
        ? undefined
        : registry.node(nodeSpec.kind)?.resultsSpec?.(nodeSpec.params);
    const params = check?.params ?? gateSpec;
    if (!params)
      return {
        ok: false,
        code: "PIPELINE_INVALID",
        message: `node "${node}" does not take a result report`,
      };
    const valid = validateReport(
      raw,
      renderDeep(params, { task: state.task }),
      check !== undefined,
    );
    if (!valid.ok) return { ok: false, code: valid.code, message: valid.message };
    const merged = mergeReports(
      replace ? undefined : await store.readReport(this.runId, node, attempt),
      valid.report,
      replace,
    );
    if (!merged.ok) return { ok: false, code: merged.code, message: merged.message };
    await store.writeReport(this.runId, node, attempt, merged.report);
    await this.apply({
      type: "report_accepted",
      node,
      attempt,
      completeness: merged.report.completeness,
      rows: merged.report.rows.length,
    });
    return { ok: true };
  }
}

/** A path as one word for the shell the person types into. */
function shellQuote(path: string): string {
  if (/^[\w@%+=:,./-]+$/.test(path)) return path;
  return process.platform === "win32"
    ? `"${path.replace(/"/g, '\\"')}"`
    : `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * What the agent tells the person when a run in its own worktree is done. Nothing is removed by
 * kodel: the agent has no tool for it, and the person runs these commands when they have looked.
 */
export function doneHint(root: string, workdir: string, branch: string): string {
  const dir = shellQuote(workdir);
  const repo = shellQuote(root);
  return [
    "Tell the person, in the language they use, where the work is and how to take it on. Do not run these commands yourself:",
    `The work is in ${workdir} on branch ${branch}.`,
    `Commit:  git -C ${dir} add -A && git -C ${dir} commit -s`,
    `Remove:  git -C ${repo} worktree remove ${dir} && git -C ${repo} branch -d ${branch}  (branch -d refuses while the branch is not merged)`,
  ].join("\n");
}

function commandVerdict(
  result: CommandResult,
  expect: { exit: number },
  timeout: number | undefined,
): CheckVerdict {
  const tail = result.tail.trim() ? `\n${lastChars(result.tail.trim(), REASON_TAIL)}` : "";
  if (result.timedOut)
    return {
      passed: false,
      reason: `timed out after ${timeout ?? "?"} s${tail}`,
      exit: result.exit,
    };
  if (result.aborted)
    return { passed: false, reason: `the command was stopped${tail}`, exit: result.exit };
  const verdict = evaluateCommand(result.exit, { expect });
  return verdict.passed
    ? { ...verdict, exit: result.exit }
    : { ...verdict, reason: `${verdict.reason}${tail}`, exit: result.exit };
}

function builtinCheckRunners(host: LocalHost): Record<string, CheckRunner> {
  return {
    async diff(effect, context) {
      const tree = effect.baseline
        ? (await context.store.readSnapshots(context.runId))[effect.baseline]
        : undefined;
      if (!tree)
        return {
          passed: false,
          reason: `there is no snapshot "${effect.baseline}" to compare with`,
        };
      return evaluateDiff(await context.snapshotter.changesSince(tree), effect.params);
    },

    async command(effect, context) {
      const command = String(effect.params.command);
      const timeout = (effect.params.timeout as number | undefined) ?? DEFAULT_COMMAND_TIMEOUT_S;
      const result = await host.runner(
        command,
        {
          cwd: context.cwd,
          env: engineEnv({
            runId: context.runId,
            node: effect.node,
            attempt: effect.attempt,
            ...(context.cwd === host.options.root ? {} : { workdir: context.cwd }),
          }),
          inheritEnv: false,
          signal: context.signal,
          redact: (text) => redactText(text, host.rules),
          timeoutMs: timeout * 1000,
          ...(host.maxTailBytes === undefined ? {} : { maxTailBytes: host.maxTailBytes }),
        },
        {
          runId: context.runId,
          node: effect.node,
          attempt: effect.attempt,
          source: "check",
          checkIndex: effect.index,
          restart: effect.restart,
        },
      );
      return commandVerdict(
        result,
        (effect.params.expect as { exit: number } | undefined) ?? { exit: 0 },
        timeout,
      );
    },

    async result(effect, context) {
      const report = await context.store.readReport(context.runId, effect.node, effect.attempt);
      if (!report) return evaluateResult(undefined, effect.params);
      const valid = validateReport(report, effect.params);
      return valid.ok
        ? evaluateResult(valid.report, effect.params)
        : { passed: false, reason: valid.message };
    },
  };
}
