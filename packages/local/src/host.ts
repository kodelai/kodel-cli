/**
 * The local host: carries out the effects of the core state machine with real adapters (file store,
 * git snapshots, shell commands) and saves the state after every decision.
 *
 * Engine work (commands and checks) runs as tasks inside this process. Nothing waits for it: the
 * caller gets the next answer and asks again later. If the process dies, a later `tick` finds the
 * work without a heartbeat and restarts it; the state on disk is all that is needed for that.
 */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import {
  type ChangeSet,
  type CheckVerdict,
  type Decision,
  decide,
  defaultRegistry,
  type Effect,
  type EngineOptions,
  evaluateCommand,
  evaluateDiff,
  evaluateResult,
  KodelError,
  type NextStep,
  nextStep,
  type PipelineSpec,
  type RedactRule,
  type RunEvent,
  type RunState,
  redactText,
  renderDeep,
  type StepResult,
  validateReport,
} from "@kodel-ai/pipeline-core";
import { type CommandOptions, type CommandResult, runCommand } from "./command";
import { GitSnapshotter } from "./git";
import { defaultIntegrityDir, FileIntegrity, type IntegrityStore } from "./integrity";
import { FileStore, newRunId } from "./store";

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
  snapshotter: GitSnapshotter;
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
  /** How this process is named as the owner of engine work; `<host>:<pid>` by default. */
  ownerId?: string;
  /** Whether an owner is still alive. Tests replace it; by default a process id on this machine is looked up. */
  isOwnerAlive?: (owner: string) => boolean;
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

const REASON_TAIL = 2_000;
const lastChars = (text: string, n: number) => (text.length > n ? `...${text.slice(-n)}` : text);

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
    this.engine = options.engine ?? {};
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
    options: { restart?: boolean } = {},
  ): Promise<{ run: LocalRun; reused: boolean; terminal: boolean }> {
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
    return this.store.withStartLock(async () => {
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
      const specHash = hashSpec(this.spec);
      await this.store.createRun({
        v: 1,
        runId,
        pipeline: this.spec.name,
        task: redactedTask,
        specHash,
        createdAt: now,
      });
      try {
        if (this.options.source !== undefined)
          await this.store.writeSpec(runId, this.options.source);
        // Where the files stood when the run began, so a person at a gate can be shown what changed.
        if (await this.snapshotter.isRepo()) {
          await this.store.writeSnapshot(runId, "run", await this.snapshotter.snapshot());
        }
        const run = new LocalRun(this, runId);
        const result = await run.apply({ type: "start", runId, task: redactedTask, specHash });
        if (!result.ok) throw result.error;
        return { run, reused: false, terminal: false };
      } catch (error) {
        await this.store.removeRun(runId).catch(() => undefined);
        throw error;
      }
    });
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

  constructor(
    private readonly host: LocalHost,
    readonly runId: string,
  ) {}

  async state(): Promise<RunState> {
    const state = await this.host.store.readState(this.runId);
    if (!state) throw new Error(`run ${this.runId} has no state`);
    return state;
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
    const { store, spec, engine, clock, integrity, rules } = this.host;
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
    return nextStep(
      this.host.spec,
      await this.state(),
      this.host.clock(),
      this.host.engine.registry ?? defaultRegistry(),
    );
  }

  /**
   * What changed in the files since the run reached this human step: a person approving should know
   * if the agent kept working after the checks passed. `undefined` when there is no baseline.
   */
  async changesSinceGate(node: string): Promise<ChangeSet | undefined> {
    const visit = (await this.state()).active.find((v) => v.node === node && v.phase === "human");
    if (!visit) return undefined;
    const tree = (await this.host.store.readSnapshots(this.runId))[`gate:${node}:${visit.attempt}`];
    if (!tree) return undefined;
    return this.host.snapshotter.changesSince(tree);
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
        const tree = await this.host.snapshotter.snapshot();
        await this.host.store.writeSnapshot(this.runId, effect.key, tree);
        return;
      }
      case "run_command":
      case "run_check":
        this.spawn(effect);
        return;
      case "await_human": {
        // Where the files stood when the person was asked, so approving can show what changed since.
        if (await this.host.snapshotter.isRepo()) {
          const tree = await this.host.snapshotter.snapshot();
          await this.host.store.writeSnapshot(
            this.runId,
            `gate:${effect.node}:${effect.attempt}`,
            tree,
          );
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
          const reason = `the host could not finish this: ${error instanceof Error ? error.message : String(error)}`;
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

  private commandOptions(signal: AbortSignal, timeout: number | undefined): CommandOptions {
    const { options, rules, maxTailBytes } = this.host;
    return {
      cwd: options.root,
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
    const result = await this.host.runner(
      effect.command,
      this.commandOptions(signal, effect.timeout),
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
    };
  }

  private async runCheck(effect: RunCheckEffect, signal: AbortSignal): Promise<RunEvent> {
    const runner = this.host.checkRunners[effect.kind];
    const verdict: CheckVerdict = runner
      ? await runner(effect, {
          runId: this.runId,
          signal,
          store: this.host.store,
          snapshotter: this.host.snapshotter,
        })
      : { passed: false, reason: `no runner for the check kind "${effect.kind}"` };
    return {
      type: "check_finished",
      node: effect.node,
      attempt: effect.attempt,
      index: effect.index,
      passed: verdict.passed,
      reason: verdict.reason,
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
  async settle(parked: () => number = () => 0): Promise<void> {
    for (;;) {
      await this.queue.catch(() => undefined);
      if (this.pending.size <= parked()) {
        await this.queue.catch(() => undefined);
        if (this.pending.size <= parked()) return;
      }
      await Promise.race([...this.pending]);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    try {
      await Promise.race([this.settle(), timeout]);
    } finally {
      clearTimeout(timer);
    }
    while (Date.now() < deadline && (await this.engineBusy())) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(300, deadline - Date.now())));
    }
  }

  private async engineBusy(): Promise<boolean> {
    const state = await this.state().catch(() => undefined);
    return state?.active.some((v) => v.phase === "engine" || v.phase === "checks") ?? false;
  }

  /** Stop all work in this process without reporting anything, as if the process had died. */
  stop(): void {
    for (const { controller } of this.tasks.values()) controller.abort();
  }

  // what callers do

  /** What the agent should do next. Throws `STATE_MODIFIED_EXTERNALLY` if the files were tampered with. */
  async nextStep(): Promise<NextStep> {
    const tick = await this.tick();
    if (!tick.ok && tick.error.code === "STATE_MODIFIED_EXTERNALLY") throw tick.error;
    if ((await this.sealStatus()) === "modified") {
      throw new KodelError(
        "STATE_MODIFIED_EXTERNALLY",
        `run ${this.runId} finished and was changed afterwards; look at what changed, then accept it with "kodel seal ${this.runId}"`,
      );
    }
    const state = await this.state();
    const step = nextStep(
      this.host.spec,
      state,
      this.host.clock(),
      this.host.engine.registry ?? defaultRegistry(),
    );
    if ("waiting" in step && step.waiting.reason === "gate") {
      const changes = await this.changesSinceStart();
      if (changes && Object.keys(changes).length > 0) step.waiting.changes = changes;
    }
    return step;
  }

  /** Files changed since the run started, with the lines changed; `undefined` without a git baseline. */
  async changesSinceStart(): Promise<ChangeSet | undefined> {
    const tree = (await this.host.store.readSnapshots(this.runId)).run;
    if (!tree) return undefined;
    return this.host.snapshotter.changesSince(tree).catch(() => undefined);
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

  completeStep(node: string, attempt: number, summary?: string) {
    return this.apply({
      type: "agent_completed",
      node,
      attempt,
      ...(summary === undefined ? {} : { summary }),
    });
  }

  decideHuman(node: string, decision: "approved" | "rejected", reason?: string) {
    return this.apply({
      type: "human_decided",
      node,
      decision,
      ...(reason === undefined ? {} : { reason }),
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

  feedback(input: {
    node?: string;
    attempt?: number;
    category: string;
    message: string;
    suggestion?: string;
  }) {
    return this.apply({ type: "feedback", ...input });
  }

  /** Check a result report the agent sent and keep it for the node's `result` check. */
  async reportResult(node: string, attempt: number, raw: unknown): Promise<StepResult> {
    const { spec, engine, store } = this.host;
    const registry = engine.registry ?? defaultRegistry();
    const nodeSpec = spec.nodes.find((n) => n.slug === node);
    if (!nodeSpec)
      return { ok: false, code: "UNKNOWN_NODE", message: `the pipeline has no node "${node}"` };
    const state = await this.state();
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
    if (!check)
      return {
        ok: false,
        code: "PIPELINE_INVALID",
        message: `node "${node}" does not take a result report`,
      };
    const valid = validateReport(raw, renderDeep(check.params, { task: state.task }));
    if (!valid.ok) return { ok: false, code: valid.code, message: valid.message };
    await store.writeReport(this.runId, node, attempt, valid.report);
    return { ok: true };
  }
}

function commandVerdict(
  result: CommandResult,
  expect: { exit: number },
  timeout: number | undefined,
): CheckVerdict {
  const tail = result.tail.trim() ? `\n${lastChars(result.tail.trim(), REASON_TAIL)}` : "";
  if (result.timedOut)
    return { passed: false, reason: `timed out after ${timeout ?? "?"} s${tail}` };
  if (result.aborted) return { passed: false, reason: `the command was stopped${tail}` };
  const verdict = evaluateCommand(result.exit, { expect });
  return verdict.passed ? verdict : { ...verdict, reason: `${verdict.reason}${tail}` };
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
          cwd: host.options.root,
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
