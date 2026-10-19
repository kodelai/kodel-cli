/**
 * The local host: carries out the effects of the core state machine with real adapters (file store,
 * git snapshots, shell commands) and saves the state after every decision.
 *
 * Engine work (commands and checks) runs as tasks inside this process. Nothing waits for it: the
 * caller gets the next answer and asks again later. If the process dies, a later `tick` finds the
 * work without a heartbeat and restarts it; the state on disk is all that is needed for that.
 */
import { createHash } from "node:crypto";
import {
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
}

const REASON_TAIL = 2_000;
const lastChars = (text: string, n: number) => (text.length > n ? `...${text.slice(-n)}` : text);

function hashSpec(spec: PipelineSpec): string {
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
    const redactedTask = redactText(task, this.rules);
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
    await this.store.writeSpec(runId, this.spec);
    const run = new LocalRun(this, runId);
    const result = await run.apply({ type: "start", runId, task: redactedTask, specHash });
    if (!result.ok) throw result.error;
    return { run, reused: false, terminal: false };
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

  private applyLocked(event: RunEvent, trust: boolean): Promise<Decision> {
    const { store, spec, engine, clock, integrity } = this.host;
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
          const trusted = await integrity.get(this.runId);
          if (trusted === undefined) {
            // First time this machine sees the run (a fresh clone, say): take it as it is.
            await integrity.set(this.runId, raw.hash);
          } else if (trusted !== raw.hash) {
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
        const hash = await store.writeState(this.runId, decision.state);
        await integrity.set(this.runId, hash);
        await store.appendJournal(this.runId, decision.journal);
        const finished = ["completed", "failed", "canceled"].includes(decision.state.status);
        if (finished) await store.writeSeal(this.runId, clock());
      }
      for (const effect of decision.effects) await this.dispatch(effect);
      return decision;
    });
  }

  /** Whether the state file is what kodel last wrote. `unknown`: kodel has not seen this run yet. */
  async integrityStatus(): Promise<"ok" | "modified" | "unknown"> {
    const raw = await this.host.store.readStateRaw(this.runId).catch(() => undefined);
    if (!raw) return "modified";
    const trusted = await this.host.integrity.get(this.runId);
    if (trusted === undefined) return "unknown";
    return trusted === raw.hash ? "ok" : "modified";
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
      default:
        return; // need_agent and await_human wait for a person or an agent
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
    const beat =
      this.host.heartbeatMs > 0
        ? setInterval(() => {
            void this.apply({
              type: "heartbeat",
              node: effect.node,
              attempt: effect.attempt,
            }).catch(() => undefined);
          }, this.host.heartbeatMs)
        : undefined;
    beat?.unref();
    this.tasks.set(key, { controller, node: effect.node, attempt: effect.attempt });

    const job = (async () => {
      try {
        const event =
          effect.type === "run_command"
            ? await this.runNodeCommand(effect, controller.signal)
            : await this.runCheck(effect, controller.signal);
        if (!controller.signal.aborted) await this.apply(event);
      } catch (error) {
        if (controller.signal.aborted) return;
        const reason = `the host could not finish this: ${error instanceof Error ? error.message : String(error)}`;
        await this.apply(
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
              },
        ).catch(() => undefined);
      } finally {
        if (beat) clearInterval(beat);
        this.tasks.delete(key);
      }
    })();
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  private commandOptions(signal: AbortSignal, timeout: number | undefined): CommandOptions {
    const { options, rules, maxTailBytes } = this.host;
    return {
      cwd: options.root,
      signal,
      redact: (text) => redactText(text, rules),
      ...(timeout === undefined ? {} : { timeoutMs: timeout * 1000 }),
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
    const verdict = commandVerdict(result, effect.expect, effect.timeout);
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

  /** Wait for the work running in this process to come to rest, but no longer than `ms`. */
  async waitForRest(ms: number): Promise<void> {
    if (ms <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    try {
      await Promise.race([this.settle(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stop all work in this process without reporting anything, as if the process had died. */
  stop(): void {
    for (const { controller } of this.tasks.values()) controller.abort();
  }

  // what callers do

  /** What the agent should do next. Throws `STATE_MODIFIED_EXTERNALLY` if the files were tampered with. */
  async nextStep(): Promise<NextStep> {
    const tick = await this.apply({ type: "tick" });
    if (!tick.ok && tick.error.code === "STATE_MODIFIED_EXTERNALLY") throw tick.error;
    const state = await this.state();
    return nextStep(
      this.host.spec,
      state,
      this.host.clock(),
      this.host.engine.registry ?? defaultRegistry(),
    );
  }

  tick() {
    return this.apply({ type: "tick" });
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

  cancel() {
    return this.apply({ type: "cancel" });
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
      const timeout = effect.params.timeout as number | undefined;
      const result = await host.runner(
        command,
        {
          cwd: host.options.root,
          signal: context.signal,
          redact: (text) => redactText(text, host.rules),
          ...(timeout === undefined ? {} : { timeoutMs: timeout * 1000 }),
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
