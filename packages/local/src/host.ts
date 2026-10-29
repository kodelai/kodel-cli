/**
 * The local host: carries out the effects of the core state machine with real adapters (file store,
 * git snapshots, shell commands) and saves the state after every decision.
 *
 * Engine work (commands and checks) runs as tasks inside this process. Nothing waits for it: the
 * caller gets the next answer and asks again later. If the process dies, a later `tick` finds the
 * work without a heartbeat and restarts it; the state on disk is all that is needed for that.
 */
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  type AgentDecision,
  type AgentStep,
  type AgentsConfig,
  type Caller,
  type ChangeSet,
  type ChangesRef,
  type CheckVerdict,
  canonicalPipeline,
  claimedStepsOpen,
  cleanExecutorText,
  clientOf,
  DEFAULT_AGENTS,
  type Decision,
  decide,
  defaultRegistry,
  describeEffects,
  diffPipelines,
  type Effect,
  type EngineOptions,
  type ExecutorRecord,
  effectsOf,
  evaluateCommand,
  evaluateDiff,
  evaluateResult,
  type HistoryConfig,
  isRunEnd,
  isTreeId,
  type JournalRecord,
  KodelError,
  liveClaim,
  measurePatch,
  mergeReports,
  type NextStep,
  type NextStepOptions,
  type NextStepRequest,
  nextStep,
  type OutputRef,
  type PendingChange,
  type PipelineChange,
  type PipelineSpec,
  type ProposeOutcome,
  parsePipeline,
  parseSnapshot,
  type RedactRule,
  type RunEvent,
  type RunFacts,
  type RunReport,
  type RunState,
  type RunTaskLink,
  redactText,
  renderContextOf,
  renderDeep,
  resolveMode,
  rowsToCsv,
  runSlug,
  type ServedSurface,
  type StepResult,
  standingOf,
  summarizeRun,
  type TakeOutcome,
  validateReport,
} from "@kodel-ai/pipeline-core";
import { type AgentLogRun, AgentLogWriter } from "./agent-log";
import type { AgentLogTickers } from "./agent-log-ticker";
import { type CommandOptions, type CommandResult, runCommand } from "./command";
import { loadConfig, type WorktreeConfig } from "./config";
import {
  type BuildInfo,
  type ExecutorContext,
  engineRecord,
  observeExecutor,
  SESSION_ENV,
  UNKNOWN_BUILD,
} from "./executor";
import {
  checkTreeId,
  deadlineIn,
  GitSnapshotter,
  readHead,
  readRunCommits,
  repoPrefix,
} from "./git";
import { defaultIntegrityDir, FileIntegrity, type IntegrityStore } from "./integrity";
import { patchBetween } from "./patch";
import { MAX_PATCH_KB, PATCH_READ_MARGIN } from "./patch-text";
import { fitServed, promptHashOf, type ServedNode, servedKeyOf } from "./served";
import { artifactFileName, FileStore, META_VERSION, newRunId, type RunMeta } from "./store";
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
export type CheckRunner = (
  effect: RunCheckEffect,
  context: CheckContext,
) => Promise<CheckVerdict & KeptOutput>;

/** What a check that ran a command tells the event beyond its verdict. */
export interface KeptOutput {
  command?: string;
  output?: OutputRef;
  output_error?: string;
}

export interface HostOptions {
  /** The working directory commands run in; usually the repository root. */
  root: string;
  /** Where runs are kept; defaults to `<root>/.kodel`. */
  storeRoot?: string;
  /**
   * What the server serves the agent to decide on a person's instruction (`decisions.agent` of the
   * config, as read when the server started). The texts of the waiting answers name a tool only
   * when it is here, so they never name one the server does not offer.
   */
  agentDecisions?: { gate?: boolean; pipelineChange?: boolean };
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
  /**
   * Ties a run to the task it was started for; absent when tasks are off or the mode is `disabled`.
   * A function is asked on first use, so a host that never meets a task never reads the task config.
   */
  runTaskLink?: RunTaskLink | (() => Promise<RunTaskLink | undefined>);
  /** The program that serves the runs, for the `engine` record; absent: `unknown`. */
  build?: BuildInfo;
  /** The environment the session id is read from; this process's by default (tests replace it). */
  environment?: NodeJS.ProcessEnv;
  /**
   * What copies the agent's log into the runs. One per process: the hosts of a process share it, so that a run
   * opened through two of them is copied by one. A host makes its own when not given one.
   */
  agentLog?: AgentLogWriter;
  /**
   * The timers that copy the agent's log while runs go: present only in the process that serves the MCP tools, so
   * that a command a person runs (`status`, `report`, `wait`, `gate`) never starts one.
   */
  agentLogTickers?: AgentLogTickers;
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
 * The part of a step that is the step's own: what is recorded as served, and what a worker is handed.
 * Who else works the run (`steps`, `taken_by`, `also_waiting`, the mode) is left out, so the record
 * of a step is the same whatever its siblings do.
 */
export function servedPart(
  step: AgentStep,
  change?: PipelineChange,
): AgentStep & { pipeline_change?: PipelineChange } {
  const out: AgentStep & { pipeline_change?: PipelineChange } = {
    slug: step.slug,
    kind: step.kind,
    attempt: step.attempt,
    prompt: step.prompt,
  };
  // A change of the run's pipeline that waits is shown with every step, and is part of what was shown.
  if (change !== undefined) out.pipeline_change = change;
  if (step.name !== undefined) out.name = step.name;
  if (step.reentry_feedback !== undefined) out.reentry_feedback = step.reentry_feedback;
  if (step.result_spec !== undefined) out.result_spec = step.result_spec;
  if (step.execution !== undefined) out.execution = { instruction: step.execution.instruction };
  if (step.outcomes !== undefined) out.outcomes = step.outcomes;
  if (step.workdir !== undefined) out.workdir = step.workdir;
  return out;
}

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

/**
 * How long recording the changes of a hand-in may take (snapshot and patch together). The agent waits
 * for the call, and the engine then waits for the checks up to its own budget, so this is kept
 * short: a hand-in that cannot be recorded in time is handed in without a patch, and says why.
 */
export const HAND_IN_DEADLINE_MS = 20_000;

/** The same for the end of the run; nobody waits for it on the agent's call. */
export const END_DEADLINE_MS = 120_000;

/** After this many hand-ins in a row that ran out of time, the next ones are not tried. */
const DEADLINE_BACKOFF = 2;

/** The text fields an event carries from outside; the rest is structure and is left alone. */
const FREE_TEXT_FIELDS = [
  "reason",
  "summary",
  "message",
  "suggestion",
  "note",
  "changesError",
] as const;

function redactEvent(event: RunEvent, rules: RedactRule[]): RunEvent {
  const copy = { ...event } as Record<string, unknown>;
  for (const field of FREE_TEXT_FIELDS) {
    const value = copy[field];
    if (typeof value === "string") copy[field] = redactText(value, rules);
  }
  // The words the agent says the person gave it are the agent's input like any other text.
  const by = copy["byAgent"];
  if (typeof by === "object" && by !== null && "instruction" in by) {
    const { instruction } = by as { instruction: unknown };
    if (typeof instruction === "string") {
      copy["byAgent"] = { ...by, instruction: redactText(instruction, rules) };
    }
  }
  return copy as unknown as RunEvent;
}

/** The real path of a folder, or the same text when it cannot be told. */
const realpathOrSame = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

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
  private readonly outputSettingsCache = new Map<
    string,
    { enabled: boolean; maxKb: number } | null
  >();
  readonly integrity: IntegrityStore;
  readonly ownerId: string;
  readonly isOwnerAlive: (owner: string) => boolean;
  readonly agentLog: AgentLogWriter;

  constructor(
    readonly spec: PipelineSpec,
    readonly options: HostOptions,
  ) {
    this.rules = options.rules ?? [];
    const storeRoot = options.storeRoot ?? `${options.root}/.kodel`;
    this.store = new FileStore({ root: storeRoot, rules: this.rules });
    this.agentLog =
      options.agentLog ??
      new AgentLogWriter({
        store: this.store,
        root: options.root,
        rules: this.rules,
        env: () => options.environment ?? process.env,
        now: options.clock ?? Date.now,
      });
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
   * What the run recorded for `history.output` when it started, or undefined for a run that recorded
   * nothing (an older run, a test host): then no output is kept. Read once per run; the recorded value
   * is the one in force, so editing the config mid-run changes nothing.
   */
  async outputSettings(runId: string): Promise<{ enabled: boolean; maxKb: number } | undefined> {
    const cached = this.outputSettingsCache.get(runId);
    if (cached !== undefined) return cached ?? undefined;
    const started = (await this.store.readJournal(runId)).find((r) => r.event === "run_started");
    const output = (
      started?.history as { output?: { enabled?: unknown; max_kb?: unknown } } | undefined
    )?.output;
    const settings =
      output &&
      typeof output.enabled === "boolean" &&
      typeof output.max_kb === "number" &&
      output.max_kb >= 1
        ? { enabled: output.enabled, maxKb: output.max_kb }
        : null;
    this.outputSettingsCache.set(runId, settings);
    return settings ?? undefined;
  }

  /** The tail limit for a command of this run: the injected one (tests), else the recorded one. */
  async tailLimit(runId: string): Promise<number | undefined> {
    if (this.maxTailBytes !== undefined) return this.maxTailBytes;
    // A journal that cannot be read must not change the verdict of a command: the default limit
    // applies here, and `keepOutput` records the same failure as `output_error` instead of a file.
    const settings = await this.outputSettings(runId).catch(() => undefined);
    return settings?.enabled ? settings.maxKb * 1024 : undefined;
  }

  /**
   * Keep what a command printed when the run asks for it. A write that fails is reported, never
   * thrown: the verdict of the command stands, whatever happens to the file.
   */
  async keepOutput(
    runId: string,
    node: string,
    attempt: number,
    part: string,
    result: CommandResult,
  ): Promise<{ output?: OutputRef; output_error?: string }> {
    try {
      const settings = await this.outputSettings(runId);
      if (!settings?.enabled) return {};
      const kept = await this.store.writeArtifact(runId, node, attempt, part, result.tail);
      return { output: { ...kept, truncated: result.truncated } };
    } catch (error) {
      // Short and without the folder: the journal is read by people and by other tools.
      return {
        output_error: redactText(
          describeError(error).replaceAll(this.options.root, "."),
          this.rules,
        ).slice(0, 200),
      };
    }
  }

  /**
   * The active run for this task, or a new one. If the task already ran to its end, that run comes
   * back with `terminal: true` and nothing new starts, unless `restart` says the user wants another.
   */
  async start(
    task: string,
    options: {
      restart?: boolean;
      /** The run's slug, validated by the service; absent: made from the task text. */
      title?: string;
      cwd?: string;
      worktree?: WorktreeConfig;
      /** The effective `history` settings of the project config; omitted: not recorded and no git needed for them. */
      history?: HistoryConfig;
      /** A pipeline file to put into the run's directory, when the last commit does not have it as it should be. */
      pipelineCopy?: { path: string; text: string };
      /** The key of the task the run is for, already resolved by the tracker. */
      taskKey?: string;
      /** Who the transport says is calling. */
      caller?: Caller;
      /** What the agent was given when it connected, for the `engine` record. */
      surface?: ServedSurface;
    } = {},
  ): Promise<{ run: LocalRun; reused: boolean; terminal: boolean; workdir?: Workdir }> {
    const registry = this.engine.registry ?? defaultRegistry();
    const { history } = options;
    const needsDiffGit = this.spec.nodes.some((n) =>
      n.checks.some((c) => registry.check(c.kind)?.baseline?.(c.params)),
    );
    const recordsChanges = history?.changes.enabled === true;
    // Only a start that would make a new run needs git: a run that exists is picked up as it is, so
    // this runs inside the start lock after the reuse branches, and before anything is created.
    const requireGit = async () => {
      if (!(needsDiffGit || recordsChanges) || (await this.snapshotter.isRepo())) return;
      // `isRepo` is false for no git binary, a bare repository and a directory outside a repository
      // alike, so the message names the ways out instead of guessing which it was.
      const setting = recordsChanges
        ? `; history.changes.enabled also needs git: set it to false in .kodel/config.yaml, or run kodel inside a git repository`
        : "";
      throw new KodelError(
        "GIT_REQUIRED",
        needsDiffGit
          ? `this pipeline has a diff check, which needs a git repository, and ${this.options.root} is not inside one${setting}`
          : `${this.options.root} is not inside a git work tree (or git is not installed), and this run records changes: set history.changes.enabled to false in .kodel/config.yaml, or run kodel inside a git repository`,
      );
    };
    // Spaces at the ends or doubled are not a different task; otherwise a changed space would
    // slip past the run that is waiting for a person.
    const redactedTask = normalizeTask(task, this.rules);
    // A title is stored and put into paths like the task, so it goes through the same redaction; one
    // that redaction would change is refused, otherwise the slug would not be what the agent chose.
    if (options.title !== undefined && redactText(options.title, this.rules) !== options.title) {
      throw new KodelError("INVALID_ARGUMENTS", "title looks like a secret and cannot be used", [
        { path: ["title"], message: "looks like a secret" },
      ]);
    }
    const slug = runSlug(options.title, redactedTask);
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

      await requireGit();
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
        // The copy is part of the start: if it cannot be made the directory is taken away again.
        if (workdir && options.pipelineCopy) {
          const target = join(workdir.path, await this.projectRel(), options.pipelineCopy.path);
          await mkdir(dirname(target), { recursive: true });
          await this.store.replaceFile(target, options.pipelineCopy.text);
        }
        const meta: RunMeta = {
          v: META_VERSION,
          runId,
          pipeline: this.spec.name,
          task: redactedTask,
          slug,
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
        const recordsExecutor = history?.executor.enabled === true;
        const executor = recordsExecutor
          ? await observeExecutor(options.caller, {
              root: this.options.root,
              dirs: [...(workdir ? [workdir.path] : []), this.options.root],
              ...(this.options.environment === undefined ? {} : { env: this.options.environment }),
            })
          : undefined;
        // None without a repository or before the first commit.
        const baseCommit = workdir
          ? (workdir.base ?? (await readHead(workdir.path)))
          : await readHead(this.options.root);
        const result = await run.apply({
          type: "start",
          runId,
          task: redactedTask,
          slug,
          specHash,
          ...(workdir ? { workdir: workdir.path } : {}),
          ...(workdir?.branch === undefined ? {} : { branch: workdir.branch }),
          ...(this.options.pipelineFile === undefined
            ? {}
            : { pipelineFile: this.options.pipelineFile }),
          ...(options.taskKey === undefined ? {} : { taskKey: options.taskKey }),
          ...(history === undefined ? {} : { history }),
          ...(executor === undefined
            ? {}
            : {
                executor,
                engine: engineRecord(this.options.build ?? UNKNOWN_BUILD, options.surface),
              }),
          ...(baseCommit === undefined ? {} : { baseCommit }),
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

  private linkPromise: Promise<RunTaskLink | undefined> | undefined;

  /** The tie between runs and tasks, when there is one. */
  taskLink(): Promise<RunTaskLink | undefined> {
    const given = this.options.runTaskLink;
    if (typeof given !== "function") return Promise.resolve(given);
    this.linkPromise ??= given();
    return this.linkPromise;
  }

  private rel: Promise<string> | undefined;

  /**
   * Where the project is inside the repository (empty when it is the repository's top, or when the
   * directories come from a provider of the caller's). A worktree is of the whole repository, and a
   * run of a project in a subfolder works in that same subfolder of its worktree.
   */
  projectRel(): Promise<string> {
    this.rel ??= this.options.workdirs ? Promise.resolve("") : repoPrefix(this.options.root);
    return this.rel;
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

/**
 * A task as it is kept and compared: spaces at the ends or doubled are not a different task, and
 * what redaction takes out is gone before anything is compared or stored.
 */
export function normalizeTask(task: string, rules: RedactRule[]): string {
  return redactText(task.trim().replace(/\s+/g, " "), rules);
}

/** The largest pipeline an agent may propose. */
const MAX_PROPOSAL_BYTES = 256 * 1024;

/** A change of the pipeline that waits, with the text it came as (for `acceptChange`). */
export interface PendingFound {
  info: PendingChange;
  text: string;
  hash: string;
  spec: PipelineSpec;
}

export class LocalRun {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly tasks = new Map<
    string,
    { controller: AbortController; node: string; attempt: number }
  >();
  private readonly pending = new Set<Promise<void>>();
  /** The jobs that record the patch of the run after it ended (also in `pending`). */
  private readonly endJobs = new Set<Promise<void>>();
  /** The job that records the patch of the run gave up (the files changed, the state could not be read). */
  private endPatchGaveUp = false;

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
    return this.inProject(where.path);
  }

  /** The place of the project inside a worktree of the repository. */
  async inProject(worktree: string): Promise<string> {
    return join(worktree, await this.host.projectRel());
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

  /**
   * Whether waiting answers offer the agent `kodel wait`: on unless the project's config turns it
   * off. Read at each answer, so an edit of the config applies to the next one. A config that cannot
   * be read leaves the default: this is a hint, and the commands that need the config say what is wrong.
   */
  private async waitHint(): Promise<boolean> {
    return (await this.hints()).wait;
  }

  /**
   * The hints and the `agents` block of the project config, read at each answer like `waitHint` and
   * for the same reason: a config that cannot be read leaves the defaults, so a bad value never
   * fails `pipeline_next_step` or a worker's claim for a run that is going; the commands that need
   * the config say what is wrong.
   */
  private async hints(): Promise<{ wait: boolean; agents: AgentsConfig }> {
    const { options } = this.host;
    try {
      const config = await loadConfig(options.storeRoot ?? `${options.root}/.kodel`);
      return { wait: config.agent_hints.wait, agents: config.agents };
    } catch {
      return { wait: true, agents: { ...DEFAULT_AGENTS } };
    }
  }

  /** The options of an answer that depend on the config and on the request. */
  private async answerOptions(request: NextStepRequest, state: RunState): Promise<NextStepOptions> {
    const hints = await this.hints();
    const mode = resolveMode(hints.agents, request.subagents);
    const where = state.workdir === undefined ? undefined : await this.inProject(state.workdir);
    return {
      waitHint: hints.wait,
      agentDecisions: this.agentDecisions(),
      agents: { mode, maxParallel: hints.agents.max_parallel },
      ...(where === undefined ? {} : { workdir: where }),
      ...(request.nodeSlug === undefined ? {} : { nodeSlug: request.nodeSlug }),
      ...(request.completionOf === undefined ? {} : { completionOf: request.completionOf }),
      ...(request.worker === true ? { worker: true } : {}),
      ...(request.atCompletion === true ? { atCompletion: true } : {}),
    };
  }

  private agentDecisions(): { gate: boolean; pipelineChange: boolean } {
    const { agentDecisions } = this.host.options;
    return {
      gate: agentDecisions?.gate === true,
      pipelineChange: agentDecisions?.pipelineChange === true,
    };
  }

  /** The run's journal, as it is on disk; read-only. */
  journal(): Promise<JournalRecord[]> {
    return this.host.store.readJournal(this.runId);
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
    const base =
      state.workdir === undefined ? this.host.options.root : await this.inProject(state.workdir);
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
    only?: "file" | "proposal",
  ): Promise<PendingFound | undefined> {
    const now = state ?? (await this.state());
    if (now.status !== "running" && now.status !== "paused") return undefined;
    const current = await this.currentSpec(now);
    // The agent's proposal comes first; a change made in the file is looked at when there is none.
    if (only !== "file") {
      const proposal = await this.host.store.readProposal(this.runId);
      if (proposal !== undefined) {
        const found = this.describeChange("proposal", proposal, undefined, now, current);
        if (found) return found;
      }
    }
    if (only === "proposal") return undefined;
    const where = await this.watched(now);
    if (!where) return undefined;
    let text: string;
    try {
      text = await readFile(where.path, "utf8");
    } catch {
      return undefined;
    }
    return this.describeChange("file", text, where.relative, now, current);
  }

  /** Drop the agent's proposal. A person's act; it is journaled like the agent taking it back. */
  async discardProposal(): Promise<boolean> {
    const had = await this.host.store.removeProposal(this.runId);
    if (had) {
      await this.apply({
        type: "change_proposed",
        hash: "",
        summary: "dropped by a person",
        withdrawn: true,
      });
    }
    return had;
  }

  /**
   * Every version of the pipeline the run has had, oldest first, from the journal (which says when,
   * and what a person accepted), and the kept copies that the journal knows nothing about (an `apply`
   * that did not finish).
   */
  async history(): Promise<{
    versions: {
      hash: string;
      at: number;
      how: "started" | "proposal" | "file";
      nodes: { slug: string; changes: string[] }[];
      /** What the run did about the change, per step it stood at; empty when nothing was redone. */
      effects: { kind: string; node: string }[];
      reason?: string;
      current: boolean;
    }[];
    orphans: string[];
  }> {
    const state = await this.state();
    const journal = await this.host.store.readJournal(this.runId);
    const out: Awaited<ReturnType<LocalRun["history"]>>["versions"] = [];
    for (const record of journal) {
      if (record.event === "run_started") {
        out.push({
          hash: String(record.spec),
          at: record.ts,
          how: "started",
          nodes: [],
          effects: [],
          current: false,
        });
      } else if (record.event === "pipeline_accepted") {
        out.push({
          hash: String(record.to),
          at: record.ts,
          how: record.source === "proposal" ? "proposal" : "file",
          nodes: (record.nodes as { slug: string; changes: string[] }[] | undefined) ?? [],
          effects: effectsOf(record.effects),
          ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
          current: false,
        });
      }
    }
    const last = out.at(-1);
    if (last) last.current = last.hash === state.specHash;
    const known = new Set(out.map((v) => v.hash));
    const orphans = (await this.host.store.listSpecs(this.runId)).filter((h) => !known.has(h));
    return { versions: out, orphans };
  }

  /**
   * Write a version the run has had (the one it is on, by default) into the run's own pipeline file.
   * A version the run could not be moved to now is refused before anything is written, so the file is
   * never left in a state that only gets in the way.
   */
  async restoreFile(hash?: string): Promise<{ path: string; hash: string }> {
    const state = await this.state();
    const target = hash ?? state.specHash;
    const where = await this.watched(state);
    if (!where) {
      throw new KodelError(
        "INVALID_ARGUMENTS",
        `run ${this.runId} has no pipeline file of its own`,
      );
    }
    const spec = await this.specFor(target);
    if (target !== state.specHash) {
      const diff = diffPipelines(await this.currentSpec(state), spec, state);
      if (diff.refused !== undefined) throw new KodelError("PIPELINE_CHANGE_REFUSED", diff.refused);
    }
    const text = await this.host.store.readSpec(this.runId, target);
    if (text === undefined) throw new KodelError("UNKNOWN_RUN", `no kept version ${target}`);
    await this.host.store.replaceFile(where.path, text);
    return { path: where.relative, hash: target };
  }

  private describeChange(
    source: "file" | "proposal",
    text: string,
    watched: string | undefined,
    now: RunState,
    current: PipelineSpec,
  ): PendingFound | undefined {
    const hash = hashSource(text);
    if (hash === now.specHash) return undefined;
    let spec: PipelineSpec;
    try {
      spec = parsePipeline(text);
    } catch (error) {
      if (error instanceof KodelError) return undefined;
      throw error;
    }
    if (canonicalPipeline(spec) === canonicalPipeline(current)) return undefined;
    const diff = diffPipelines(current, spec, now);
    return {
      text,
      hash,
      spec,
      info: {
        source,
        ...(watched === undefined ? {} : { watched }),
        changes: diff.nodes,
        effects: diff.effects,
        redo: describeEffects(diff.effects),
        standing: standingOf(now),
        ...(diff.refused === undefined ? {} : { refused: diff.refused }),
        apply: `kodel pipeline changes apply ${this.runId}`,
        hash,
        blocking: diff.refused === undefined,
      },
    };
  }

  /** The pipeline the run is on, as the text it was kept as. */
  async pinnedPipeline(): Promise<{ yaml: string; spec: PipelineSpec; hash: string }> {
    const state = await this.state();
    const spec = await this.currentSpec(state);
    const yaml = await this.host.store.readSpec(this.runId, state.specHash);
    if (yaml === undefined) {
      throw new KodelError("STATE_MODIFIED_EXTERNALLY", `run ${this.runId} has no kept pipeline`);
    }
    return { yaml, spec, hash: state.specHash };
  }

  /**
   * The agent proposes another version of the pipeline. Nothing about the run changes: the proposal
   * is checked, kept apart, and journaled, and a person accepts it or not. What would be refused at
   * the person's command is refused here, so the agent hears it at once.
   */
  async proposeChange(input: { yaml: string; summary: string }): Promise<ProposeOutcome> {
    const { store, rules } = this.host;
    const state = await this.state();
    if (state.status !== "running" && state.status !== "paused") {
      return { ok: false, code: "NODE_NOT_RUNNING", message: `the run is ${state.status}` };
    }
    if (input.yaml.trim() === "") {
      const had = await store.removeProposal(this.runId);
      if (had) {
        await this.apply({
          type: "change_proposed",
          hash: "",
          summary: input.summary,
          withdrawn: true,
        });
      }
      return { ok: true, status: had ? "withdrawn" : "none" };
    }
    if (Buffer.byteLength(input.yaml) > MAX_PROPOSAL_BYTES) {
      return { ok: false, code: "INVALID_ARGUMENTS", message: "the pipeline is too large" };
    }
    // A proposal is the agent's text and is kept as it is, so it may not hold what redaction would
    // take out of anything else the agent writes.
    if (redactText(input.yaml, rules) !== input.yaml) {
      return {
        ok: false,
        code: "INVALID_ARGUMENTS",
        message:
          "the pipeline contains something that looks like a secret (a key, a token, a password); leave it out",
      };
    }
    let spec: PipelineSpec;
    try {
      spec = parsePipeline(input.yaml);
    } catch (error) {
      if (error instanceof KodelError) {
        return { ok: false, code: error.code, message: error.message };
      }
      throw error;
    }
    const current = await this.currentSpec(state);
    if (canonicalPipeline(spec) === canonicalPipeline(current)) {
      return {
        ok: false,
        code: "PIPELINE_CHANGE_REFUSED",
        message: "this is what the run is already on; nothing differs",
      };
    }
    const diff = diffPipelines(current, spec, state);
    if (diff.refused !== undefined) {
      return { ok: false, code: "PIPELINE_CHANGE_REFUSED", message: diff.refused };
    }
    await store.writeProposal(this.runId, input.yaml);
    const logged = await this.apply({
      type: "change_proposed",
      hash: hashSource(input.yaml),
      summary: input.summary,
    });
    if (!logged.ok) return { ok: false, code: logged.error.code, message: logged.error.message };
    const pending = await this.pendingChange();
    const { blocking: _blocking, ...change } = pending?.info ?? {};
    return {
      ok: true,
      status: "proposed",
      ...(pending ? { change: change as PipelineChange } : {}),
    };
  }

  /**
   * Take another version of the pipeline for this run: keep it with the run, then let the machine
   * move the run onto it. A person decides this (`kodel pipeline changes apply`), never the agent.
   * A proposal is also written into the run's pipeline file, so the change is in what the person
   * commits and reaches the next runs with it.
   */
  async acceptChange(input: {
    source: "file" | "proposal";
    text: string;
    reason?: string;
    byAgent?: AgentDecision;
    /** The `standing` of the change as it was shown; the engine refuses once the run has moved on. */
    standing?: string;
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
    if (input.source === "proposal") {
      const where = await this.watched(state);
      if (where) await this.host.store.replaceFile(where.path, input.text);
    }
    const decision = await this.apply({
      type: "pipeline_accepted",
      from: state.specHash,
      to,
      source: input.source,
      before,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.byAgent === undefined ? {} : { byAgent: input.byAgent }),
      ...(input.standing === undefined ? {} : { standing: input.standing }),
    });
    if (decision.ok) await this.host.store.removeProposal(this.runId).catch(() => undefined);
    return decision;
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
    // After the lock is let go: the tracker may be slow, and it must not hold up the run's files.
    return step.then(async (decision) => {
      // Started before the tracker is asked, so the end tree is not taken after a slow call, and
      // not awaited: nobody who ends a run waits for a whole-tree snapshot.
      this.startEndJob(decision);
      await this.tieEnd(decision);
      return decision;
    });
  }

  /** The `history.changes` settings the run recorded when it started; none when it keeps no patches. */
  private async changesSettings(): Promise<{ maxKb: number; exclude: string[] } | undefined> {
    const changes = (await this.state().catch(() => undefined))?.history?.changes;
    // The state is read before anything checks it: a value edited into it is clamped, not believed.
    const maxKb = Math.min(Math.max(Math.trunc(Number(changes?.max_kb)) || 512, 1), MAX_PATCH_KB);
    return changes?.enabled === true
      ? { maxKb, exclude: Array.isArray(changes.exclude) ? changes.exclude : [] }
      : undefined;
  }

  /** An error of the patch machinery as a short, redacted text without the repository's path. */
  private changesErrorText(error: unknown): string {
    // Longest first: the root is often inside the temporary folder or the home folder. Git prints the
    // real path of a folder, which on macOS is not the one `tmpdir()` gives.
    // This runs in the `catch` of code that must never throw: a missing home folder (a container with
    // no `HOME` and no passwd entry makes `homedir()` throw) is not a reason to lose the record.
    const safely = (find: () => string): string => {
      try {
        return find();
      } catch {
        return "";
      }
    };
    const root = this.host.options.root;
    const places: [string, string][] = [
      [root, "."],
      [safely(() => realpathOrSame(root)), "."],
      [safely(tmpdir), "<tmp>"],
      [safely(() => realpathOrSame(tmpdir())), "<tmp>"],
      [safely(homedir), "~"],
    ];
    // Git for Windows prints `C:/Users/x` where Node says `C:\Users\x`: both are named.
    for (const [place, name] of [...places]) {
      if (place.includes("\\")) places.push([place.replaceAll("\\", "/"), name]);
    }
    // Longest first, whichever way they were listed: `/private/var/x` contains `/var/x`.
    places.sort((a, b) => b[0].length - a[0].length);
    // The places are named before the text is redacted: a long path looks like a secret to the entropy
    // rule and would be wiped whole. A place of a few characters (a `HOME` of `/`) would mangle every
    // path and word, so it is left as it is.
    let text = describeError(error);
    for (const [place, name] of places) if (place.length >= 4) text = text.replaceAll(place, name);
    return redactText(text, this.host.rules).slice(0, 200);
  }

  /**
   * Whether the patch of the run is still being written, here or in another process (`kodel gate`
   * ends a run in its own). Another process says it is done in the journal; one that was killed never
   * does, so the wait ends after the time the job is allowed to take.
   */
  private async endPatchPending(state: RunState): Promise<boolean> {
    if (this.endJobs.size > 0) return true;
    if (this.endPatchGaveUp) return false;
    if (state.history?.changes?.enabled !== true) return false;
    const journal = await this.host.store.readJournal(this.runId).catch(() => []);
    if (journal.some((r) => r.event === "changes_recorded")) return false;
    return this.host.clock() - (state.finishedAt ?? 0) < END_DEADLINE_MS + 30_000;
  }

  /**
   * When this event ended the run, record the patch of the whole run in the background. The job is
   * in `pending`, so `settle()` covers it, and in `endJobs`, so the answer that says the run is done
   * does not tell the person to delete the worktree while the end tree is still being read.
   */
  private startEndJob(decision: Decision): void {
    if (!decision.ok || decision.noop) return;
    if (!isRunEnd(decision.state.status)) return;
    if (!decision.journal.some((r) => r.event === "run_finished")) return;
    // A state a person accepted after editing may have no `changes`: not a reason to fail the call.
    if (decision.state.history?.changes?.enabled !== true) return;
    const job = this.recordRunPatch().catch(() => undefined);
    this.pending.add(job);
    this.endJobs.add(job);
    void job.finally(() => {
      this.pending.delete(job);
      this.endJobs.delete(job);
    });
  }

  /** The patch of the run, start tree to now, and the note in the journal that says what came of it. */
  private async recordRunPatch(): Promise<void> {
    const settings = await this.changesSettings();
    if (!settings) {
      this.endPatchGaveUp = true; // nothing will be written, so nothing is waited for
      return;
    }
    const { store } = this.host;
    // A patch that was recorded is not replaced by one taken against a later tree.
    const journal = await store.readJournal(this.runId).catch(() => []);
    if (journal.some((r) => r.event === "changes_recorded")) return;
    // Writing the note seals the run again: a run whose files were changed since it ended gets no note
    // (and no file), so that change is still seen as one.
    // Under the lock, like the check in `applyLocked`: the note of the task is written at the same
    // moment, in three steps (state, journal, seal), and a look in between is not a change.
    const seal = await store
      .withLock(this.runId, () => this.sealStatus())
      .catch(() => "modified" as const);
    if (seal !== "sealed") {
      this.endPatchGaveUp = true;
      return;
    }
    let event: RunEvent;
    try {
      const snapshots = await store.readSnapshots(this.runId);
      const start = snapshots.run;
      if (!isTreeId(start)) {
        const why = snapshots["run!"];
        throw new Error(`the start of the run was not recorded${why ? ` (${why})` : ""}`);
      }
      const snapshotter = await this.snapshotter();
      const deadline = deadlineIn(END_DEADLINE_MS);
      const end = await snapshotter.snapshot(deadline);
      const out = await patchBetween(snapshotter.root, start, end, {
        exclude: settings.exclude,
        maxBytes: settings.maxKb * 1024 + PATCH_READ_MARGIN,
        deadline,
      });
      const kept = await store.writeChanges(this.runId, "run", out.patch, {
        cutByGit: out.cut,
        maxKb: settings.maxKb,
      });
      event = { type: "changes_recorded", changes: kept };
    } catch (error) {
      event = { type: "changes_recorded", changesError: this.changesErrorText(error) };
    }
    const dropFile = async () => {
      if (event.type === "changes_recorded" && event.changes) {
        await store.deleteChanges(this.runId, event.changes.ref);
      }
    };
    try {
      const decision = await this.apply(event);
      if (!decision.ok) {
        // Refused (the files changed while the patch was made): nothing points to the file.
        this.endPatchGaveUp = true;
        await dropFile();
      }
    } catch (error) {
      // The lock could not be had, or the seal could not be read: the same, and the wait ends.
      this.endPatchGaveUp = true;
      await dropFile();
      throw error;
    }
  }

  /**
   * What to put on the `agent_completed` event about the work since the previous hand-in. It runs
   * before the checks, so what a check changes is not in this attempt's patch. It never throws and
   * never decides anything: a failure becomes `changesError`, and the hand-in goes on without a patch.
   */
  private async recordHandIn(
    node: string,
    attempt: number,
  ): Promise<{ changes?: ChangesRef; changesError?: string; tree?: string }> {
    const settings = await this.changesSettings();
    if (!settings) return {};
    try {
      // Only a step that is waiting for this hand-in; anything else is left to `apply` to refuse.
      const state = await this.state();
      const visit = state.active.find((v) => v.node === node && v.attempt === attempt);
      if (visit?.phase !== "agent") return {};
    } catch {
      return {};
    }
    const { store } = this.host;
    try {
      const earlier = (await store.readJournal(this.runId)).filter(
        (r) => r.event === "agent_completed",
      );
      // A skipped hand-in counts too: the back-off holds for the rest of the run, not for one hand-in.
      const timedOut = (r: JournalRecord) =>
        typeof r.changes_error === "string" &&
        (r.changes_error.startsWith("deadline:") || r.changes_error.startsWith("skipped:"));
      if (earlier.length >= DEADLINE_BACKOFF && earlier.slice(-DEADLINE_BACKOFF).every(timedOut)) {
        return { changesError: "skipped: earlier hand-ins ran out of time recording the changes" };
      }
      // The base is the tree of the hand-in just before this one, whatever node it was; the start of
      // the run only for the first. A hand-in before this one that has no tree (its snapshot failed,
      // or it was made before patches existed) leaves no base, never an older one: a patch from an
      // older tree would hold that node's work.
      let base: string | undefined;
      if (earlier.length === 0) {
        const start = (await store.readSnapshots(this.runId)).run;
        base = isTreeId(start) ? start : undefined;
      } else {
        const previous = earlier[earlier.length - 1]?.tree;
        base = isTreeId(previous) ? previous : undefined;
      }
      const snapshotter = await this.snapshotter();
      const deadline = deadlineIn(HAND_IN_DEADLINE_MS);
      // Checked here: core would drop a bad one without a word, and the chain would break unexplained.
      const tree = checkTreeId(await snapshotter.snapshot(deadline), "the snapshot");
      if (base === undefined) return { tree, changesError: "no recorded start" };
      try {
        const out = await patchBetween(snapshotter.root, base, tree, {
          exclude: settings.exclude,
          maxBytes: settings.maxKb * 1024 + PATCH_READ_MARGIN,
          deadline,
        });
        const changes = await store.writeChanges(
          this.runId,
          `${artifactFileName(node)}-${attempt}`,
          out.patch,
          { cutByGit: out.cut, maxKb: settings.maxKb },
        );
        return { changes, tree };
      } catch (error) {
        // The tree was taken: the next hand-in can start from it whatever happened to the patch.
        return { tree, changesError: this.changesErrorText(error) };
      }
    } catch (error) {
      return { changesError: this.changesErrorText(error) };
    }
  }

  /** HEAD and the commits of the run, from its directory; whatever cannot be read is left out. */
  private async runFacts(state: RunState): Promise<RunFacts> {
    try {
      const dir =
        state.workdir === undefined ? this.host.options.root : await this.inProject(state.workdir);
      const started = (await this.host.store.readJournal(this.runId)).find(
        (r) => r.event === "run_started",
      );
      const base = typeof started?.base_commit === "string" ? started.base_commit : undefined;
      const found = await readRunCommits(dir, base, Math.floor(state.startedAt / 1000));
      return {
        ...(found.head === undefined ? {} : { head: found.head }),
        ...(found.commits === undefined ? {} : { commits: found.commits }),
        ...(found.truncated === true ? { commitsTruncated: true } : {}),
      };
    } catch {
      return {};
    }
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
          // A state this kodel cannot read, or one that is not as it was written: the event is
          // refused with that, so a caller (a cancel, a decision) gets the reason and not a crash.
          if (
            error instanceof KodelError &&
            (error.code === "STATE_MODIFIED_EXTERNALLY" || error.code === "UNSUPPORTED_FORMAT")
          ) {
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
      // The note of the run's patch is written long after the run was sealed, and writing it seals the
      // run again over whatever the files are by then: it must not make a change of the journal look
      // like the run's own. Under the lock, so nothing is written between the look and the write.
      if (event.type === "changes_recorded" && !trust && (await this.sealStatus()) !== "sealed") {
        const error = new KodelError(
          "STATE_MODIFIED_EXTERNALLY",
          `the files of run ${this.runId} are not as the run left them; the patch was not recorded`,
        );
        return { ok: false, error } satisfies Decision;
      }
      // An event is decided with the pipeline the run is on; the one that moves it to another version,
      // with that other.
      const spec = !state
        ? this.host.spec
        : await this.specFor(event.type === "pipeline_accepted" ? event.to : state.specHash);
      const now = clock();
      let decision = decide(spec, state, event, now, engine);
      // The core reads no git; when this event ends the run, what git says is read here and the same
      // decision is made again with it. Nothing was written yet, and `decide` is pure.
      if (
        decision.ok &&
        !decision.noop &&
        state &&
        decision.journal.some((r) => r.event === "run_finished")
      ) {
        decision = decide(spec, state, event, now, engine, await this.runFacts(state));
      }
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
          this.host.options.agentLogTickers?.stop(this.runId);
          this.host.agentLog.forget(this.runId);
        }
        if (finished) {
          const sealHash = await store.writeSeal(this.runId, clock());
          await integrity.set(`${this.runId}.seal`, sealHash);
        }
      }
      for (const effect of decision.effects) await this.dispatch(effect);
      return decision;
    });
  }

  /**
   * The run has just ended: tell its task, and note in the journal what came of it. The note is an
   * ordinary event on a finished run, so the state is sealed again with it. If the process dies
   * between the end of the run and the note, the task stays as it was. This never fails the run.
   */
  private async tieEnd(decision: Decision): Promise<void> {
    if (!decision.ok || decision.noop) return;
    const key = decision.state.taskKey;
    const status = decision.state.status;
    if (key === undefined || !isRunEnd(status)) return;
    if (!decision.journal.some((r) => r.event === "run_finished")) return;
    try {
      const link = await this.host.taskLink();
      if (!link) return;
      const out = await link.end(key, this.runId, status);
      await this.apply({
        type: "task_note",
        what: out.what,
        task: key,
        ...(out.note === undefined ? {} : { note: out.note }),
      });
    } catch {
      // The tracker is not the run's business: what could not be noted is only lost from the journal.
    }
  }

  /** Whether the state file is what kodel last wrote. `unknown`: kodel has not seen this run yet. */
  async integrityStatus(): Promise<"ok" | "modified" | "unknown"> {
    // A format this kodel does not read is not a modified state; that error is passed on as it is.
    const raw = await this.host.store.readStateRaw(this.runId).catch((error: unknown) => {
      if (error instanceof KodelError && error.code === "UNSUPPORTED_FORMAT") throw error;
      return undefined;
    });
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
   * The same, for a caller that is not inside the run's lock (`status`, `report`, the next step): a
   * note written after the end of the run rewrites the state, the journal and the seal one after
   * the other, and a look in between would call the run changed. Never from inside `apply`.
   */
  sealStatusSettled(): Promise<"sealed" | "modified" | "unsealed" | "open"> {
    return this.host.store
      .withLock(this.runId, () => this.sealStatus())
      .catch(() => this.sealStatus()); // a busy lock, or a folder that cannot be written: look without it
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
      {
        waitHint: await this.waitHint(),
        agentDecisions: this.agentDecisions(),
        ...(pending ? { pending: pending.info } : {}),
      },
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
    maxTailBytes: number | undefined,
  ): CommandOptions {
    const { rules } = this.host;
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
      this.commandOptions(
        signal,
        effect.timeout,
        effect,
        cwd,
        await this.host.tailLimit(this.runId),
      ),
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
    const kept = await this.host.keepOutput(
      this.runId,
      effect.node,
      effect.attempt,
      "command",
      result,
    );
    return {
      type: "work_finished",
      node: effect.node,
      attempt: effect.attempt,
      passed: verdict.passed,
      reason: verdict.reason,
      exit: result.exit,
      duration_ms: result.durationMs,
      ...kept,
      specHash,
    };
  }

  private async runCheck(effect: RunCheckEffect, signal: AbortSignal): Promise<RunEvent> {
    const runner = this.host.checkRunners[effect.kind];
    const started = Date.now();
    const cwd = await this.cwd();
    const { specHash } = await this.state();
    const verdict: CheckVerdict & KeptOutput = runner
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
      ...keptFields(verdict, this.host.rules),
      specHash,
    };
  }

  /**
   * Wait for the jobs that record the patch of a run that has ended, but no longer than the deadline. Not
   * for anything else in `pending`: a server that is leaving has stopped that work, and work a late call
   * started meanwhile must not be waited for (nor left running by the exit that follows).
   */
  async settleEndJobs(deadline: number): Promise<void> {
    while (this.endJobs.size > 0) {
      const left = deadline - Date.now();
      if (left <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, left);
      });
      try {
        await Promise.race([...this.endJobs, wake]);
      } finally {
        clearTimeout(timer);
      }
    }
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
    // The queue too is waited for no longer than the deadline: it may stand behind another process's lock.
    const queued = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const left = deadline - Date.now();
      const late = new Promise<void>((resolve) => {
        timer = Number.isFinite(left) ? setTimeout(resolve, Math.max(left, 0)) : undefined;
      });
      try {
        await Promise.race([this.queue.catch(() => undefined), late]);
      } finally {
        clearTimeout(timer);
      }
    };
    for (;;) {
      await queued();
      if (this.pending.size <= parked()) {
        await queued();
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

  /**
   * Engine work is going, or every open agent step is in a worker's hands: either way the caller
   * that waits has nothing to do until something hands in.
   */
  private async engineBusy(): Promise<boolean> {
    const state = await this.state().catch(() => undefined);
    if (!state) return false;
    return (
      state.active.some((v) => v.phase === "engine" || v.phase === "checks") ||
      claimedStepsOpen(state, this.host.clock())
    );
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
  async nextStep(options: NextStepRequest = {}): Promise<NextStep> {
    // Only a call of the agent through the MCP tools starts the copy of its log; looking at a run does not.
    if (options.serve !== undefined) this.watchAgentLog();
    const tick = await this.tick();
    if (!tick.ok && tick.error.code === "STATE_MODIFIED_EXTERNALLY") throw tick.error;
    // Under the lock: a note being written after the end of the run (the patch, the task) rewrites the
    // state, the journal and the seal one after the other, and a look in between is not a change.
    const seal = await this.host.store.withLock(this.runId, () => this.sealStatus());
    if (seal === "modified") {
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
        ...(await this.answerOptions(options, state)),
        ...(pending ? { pending: pending.info } : {}),
      },
    );
    if ("done" in step && step.run_status === "completed") {
      const where = await this.locationForDisplay();
      // Only a run with a worktree of its own has something to protect: the end tree is read from it,
      // and removing it now would lose the patch.
      if (where?.branch !== undefined) {
        step.tell_the_person = (await this.endPatchPending(state))
          ? "The changes of the run are still being recorded: do not remove the run's worktree or branch yet. This note goes away by itself once they are written; there is nothing to poll for."
          : doneHint(this.host.options.root, where.path, where.branch);
      }
      if (state.taskKey !== undefined && (await this.host.taskLink())?.mode === "ask") {
        const ask = `The run was started for task ${state.taskKey} and the engine does not close it by itself (tasks.on_run.mode is ask): ask the person whether to close it, and if they agree call task_update with the done status from task_schema.`;
        step.tell_the_person = step.tell_the_person ? `${step.tell_the_person}\n\n${ask}` : ask;
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
    if (options.serve !== undefined && "node" in step) {
      // Every step handed out is recorded, each on its own: what a step says does not depend on its
      // siblings, so the record of one is the same whoever else is working the run.
      for (const handed of step.node.steps ?? [step.node]) {
        await this.recordServed(
          servedPart(handed, step.node.pipeline_change),
          options.serve.caller,
          state,
        );
      }
    }
    return step;
  }

  /**
   * A worker takes a step: the one named, or the next free one. The token is made here and only its
   * hash reaches the state and the journal; the machine decides under the run's lock whether the
   * step is free, so two workers taking at once get one claim between them.
   */
  async takeStep(input: { node?: string; token?: string; caller?: Caller }): Promise<TakeOutcome> {
    const hints = await this.hints();
    const serve = { ...(input.caller === undefined ? {} : { caller: input.caller }) };
    const token = input.token ?? randomBytes(16).toString("hex");
    const hash = hashSource(token);
    const before = await this.state();
    const renewed = Object.values(before.nodes).some(
      (n) => liveClaim(n, this.host.clock())?.token === hash,
    );
    // Which step is free is decided by the machine under the lock, with the claim itself.
    const decision = await this.apply({
      type: "step_claimed",
      ...(input.node === undefined ? {} : { node: input.node }),
      token: hash,
      ttlMs: hints.agents.claim_ttl_s * 1000,
    });
    if (!decision.ok) {
      await this.recordRefusal("take_step", input.node, undefined, decision.error);
      throw decision.error;
    }
    const after = decision.state;
    const now = this.host.clock();
    const mine = Object.values(after.nodes).find((n) => liveClaim(n, now)?.token === hash);
    if (mine === undefined) {
      if (input.node === undefined) return { status: "none", next: await this.nextStep({ serve }) };
      const visit = after.active.find((v) => v.node === input.node && v.phase === "agent");
      if (!visit) {
        throw new KodelError(
          "NODE_NOT_RUNNING",
          `node "${input.node}" is not an open agent step; call pipeline_next_step to see what is open`,
        );
      }
      return {
        status: "taken",
        node_slug: input.node,
        attempt: visit.attempt,
        taken_by: liveClaim(after.nodes[input.node], now)?.by ?? "another worker",
      };
    }
    const answer = await this.nextStep({ nodeSlug: mine.slug, serve });
    if (!("node" in answer)) {
      // The step was taken and is gone already (a sibling died and ended the run, say): say what is.
      return { status: "none", next: answer };
    }
    return {
      status: renewed ? "renewed" : "claimed",
      step: servedPart(answer.node),
      claim_token: token,
    };
  }

  /**
   * Keep what the agent is about to be shown (`served/`), once per answer and client, unless the run was
   * started with `history.prompts` off. It never changes what the agent is told: whatever goes wrong
   * here, the answer still goes out. The run machine numbers the file under the run's lock; the file is
   * written after the event was accepted, so no file is without an event.
   */
  private async recordServed(
    node: ServedNode,
    caller: Caller | undefined,
    state: RunState,
  ): Promise<void> {
    try {
      const served = state.served;
      if (served === undefined) return;
      // The answer as it will be stored; the hash, the key and the file all come from this one value.
      const answer = this.host.store.redactAnswer(node);
      const promptHash = promptHashOf(answer);
      const recordsExecutor = state.history?.executor.enabled === true;
      // The session counts only when the environment gives it: the hook index only knows which session
      // of the directory started last, which changes with the window the person looks at.
      const env = this.host.options.environment ?? process.env;
      const client = recordsExecutor ? clientOf(caller)?.value : undefined;
      const session = recordsExecutor ? cleanExecutorText(env[SESSION_ENV]) : undefined;
      const key = servedKeyOf(promptHash, client, session);
      if (served[`${node.slug}:${node.attempt}`]?.includes(key)) return;
      const executor = recordsExecutor
        ? await observeExecutor(caller, await this.executorContext(state))
        : undefined;
      const decision = await this.apply({
        type: "step_served",
        node: node.slug,
        attempt: node.attempt,
        key,
        promptHash,
        ...(executor === undefined ? {} : { executor }),
      });
      if (!decision.ok || decision.noop) return;
      const record = decision.journal.find((r) => r.event === "step_served");
      if (typeof record?.ref !== "string" || typeof record.n !== "number") return;
      try {
        await this.host.store.writeServed(
          this.runId,
          record.ref,
          fitServed({
            v: 1,
            node: node.slug,
            attempt: node.attempt,
            n: record.n,
            prompt_hash: promptHash,
            answer: answer as unknown as Record<string, unknown>,
          }),
        );
      } catch (error) {
        // Short and without the folder, like `output_error`: the journal is read by people and tools.
        await this.apply({
          type: "served_write_failed",
          node: node.slug,
          attempt: node.attempt,
          n: record.n,
          message: describeError(error).replaceAll(this.host.options.root, "."),
        });
      }
    } catch {
      // The answer is what the agent needs; a record that could not be made is not worth failing it.
    }
  }

  /** Where the time went and what was redone, from the run's own state and journal. */
  async report(): Promise<RunReport> {
    const journal = await this.host.store.readJournal(this.runId);
    const report = summarizeRun(await this.state(), journal);
    // A run that did not record changes has no patch to measure, whatever file may be lying there.
    const started = journal.find((r) => r.event === "run_started");
    const changesOff =
      (started?.history as { changes?: { enabled?: boolean } } | undefined)?.changes?.enabled ===
      false;
    const patch = changesOff ? undefined : await this.host.store.readRunPatch(this.runId);
    const sized: RunReport = {
      ...report,
      task_size: patch === undefined ? { not_collected: true } : measurePatch(patch),
    };
    const where = await this.locationForDisplay();
    return where ? { ...sized, workdir: where.path } : sized;
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

  async completeStep(
    node: string,
    attempt: number,
    summary?: string,
    outcome?: string,
    caller?: Caller,
    claimToken?: string,
  ) {
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
    this.watchAgentLog();
    // The agent's log up to its last closed response, copied before the step is judged: once the last step is
    // completed the run ends, and nothing is written to a run that has ended.
    await this.host.agentLog
      .capture(this.agentLogRun(), { why: "step", waitMs: 5_000, step: { node, attempt } })
      .catch(() => undefined);
    const executor = await this.executorNow(caller);
    // HEAD of the run's own directory: the root may be somewhere else entirely.
    const head = await this.cwd()
      .then(readHead)
      .catch(() => undefined);
    // Before the checks start: what a check writes belongs to no node's patch.
    const recorded = await this.recordHandIn(node, attempt);
    const mine = recorded.changes?.ref;
    const dropPatch = async () => {
      if (mine === undefined) return;
      // `apply` may throw after it has written the journal (a snapshot for a check, the seal): then the
      // record points to the file, and the file stays.
      const journal = await this.host.store.readJournal(this.runId).catch(() => undefined);
      const kept = journal?.some((r) => (r.changes as { ref?: string } | undefined)?.ref === mine);
      if (!kept) await this.host.store.deleteChanges(this.runId, mine);
    };
    let decision: Decision;
    try {
      decision = await this.apply({
        type: "agent_completed",
        node,
        attempt,
        ...(head === undefined ? {} : { head }),
        ...(summary === undefined ? {} : { summary }),
        ...(outcome === undefined ? {} : { outcome }),
        // Only the hash travels: the token itself is the worker's and is written nowhere.
        ...(claimToken === undefined ? {} : { claimToken: hashSource(claimToken) }),
        ...(executor === undefined ? {} : executor),
        ...(recorded.changes === undefined ? {} : { changes: recorded.changes }),
        ...(recorded.changesError === undefined ? {} : { changesError: recorded.changesError }),
        ...(recorded.tree === undefined ? {} : { tree: recorded.tree }),
      });
    } catch (error) {
      // A file no event points to is of no use to anyone.
      await dropPatch();
      throw error;
    }
    if (!decision.ok || decision.noop) await dropPatch();
    if (!decision.ok) {
      await this.recordRefusal("complete_step", node, attempt, decision.error);
    }
    return decision;
  }

  /** Start the timer that copies the agent's log, if this process has timers and the run asked for one. */
  watchAgentLog(): void {
    void this.host.options.agentLogTickers?.ensure(this.agentLogRun());
  }

  /** This run as the copy of the agent's log sees it. */
  agentLogRun(): AgentLogRun {
    return {
      runId: this.runId,
      state: () => this.state(),
      apply: (event) => this.apply(event),
      workdir: async () => {
        const where = await this.location().catch(() => undefined);
        if (where === undefined) return undefined;
        return this.inProject(where.path).catch(() => where.path);
      },
    };
  }

  /**
   * Who is completing the step, and this engine's version, unless the run was started with
   * `history.executor` off. A state that cannot be read here is left to `apply` to refuse.
   */
  private async executorNow(
    caller: Caller | undefined,
  ): Promise<{ executor: ExecutorRecord; engineVersion: string } | undefined> {
    try {
      const state = await this.state();
      if (state.history?.executor.enabled !== true) return undefined;
      return {
        executor: await observeExecutor(caller, await this.executorContext(state)),
        engineVersion: (this.host.options.build ?? UNKNOWN_BUILD).version,
      };
    } catch {
      return undefined;
    }
  }

  /** Where who is acting is looked for: the run's directory first, then the project root. */
  private async executorContext(state: RunState): Promise<ExecutorContext> {
    const options = this.host.options;
    return {
      root: options.root,
      dirs: [
        ...(state.workdir === undefined ? [] : [await this.inProject(state.workdir)]),
        options.root,
      ],
      ...(options.environment === undefined ? {} : { env: options.environment }),
    };
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
  async decideHuman(
    node: string,
    decision: "approved" | "rejected",
    reason?: string,
    byAgent?: AgentDecision,
  ) {
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
      ...(byAgent === undefined ? {} : { byAgent }),
    });
  }

  /** `node`: which paused branch to carry on, when more than one is paused. */
  resume(node?: string) {
    return this.apply({ type: "resume", ...(node === undefined ? {} : { node }) });
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
    check?: string;
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
      renderDeep(params, renderContextOf(state)),
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

/** A file name `writeArtifact` could have made: one level under artifacts/, no dot segments. */
const ARTIFACT_REF = /^artifacts\/[A-Za-z0-9._-]+\.txt$/;
const KEPT_TEXT_MAX = 2000;

/**
 * Only the shapes the journal expects from a check runner, whoever wrote the runner: texts are
 * redacted and bounded, and a `ref` that does not name a file under artifacts/ is dropped.
 */
function keptFields(kept: KeptOutput, rules: RedactRule[]): KeptOutput {
  const out = kept.output;
  const text = (value: string) => redactText(value, rules).slice(0, KEPT_TEXT_MAX);
  return {
    ...(typeof kept.command === "string" ? { command: text(kept.command) } : {}),
    ...(out &&
    typeof out.ref === "string" &&
    ARTIFACT_REF.test(out.ref) &&
    !out.ref.includes("..") &&
    Number.isInteger(out.bytes) &&
    out.bytes >= 0 &&
    typeof out.truncated === "boolean"
      ? { output: { ref: out.ref, bytes: out.bytes, truncated: out.truncated } }
      : {}),
    ...(typeof kept.output_error === "string"
      ? { output_error: text(kept.output_error).slice(0, 200) }
      : {}),
  };
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
      const maxTailBytes = await host.tailLimit(context.runId);
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
          ...(maxTailBytes === undefined ? {} : { maxTailBytes }),
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
      const verdict = commandVerdict(
        result,
        (effect.params.expect as { exit: number } | undefined) ?? { exit: 0 },
        timeout,
      );
      // Only a failed check keeps its output: a passing one has nothing to explain.
      const kept = verdict.passed
        ? {}
        : await host.keepOutput(
            context.runId,
            effect.node,
            effect.attempt,
            `check${effect.index}`,
            result,
          );
      return { ...verdict, command: redactText(command, host.rules), ...kept };
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
