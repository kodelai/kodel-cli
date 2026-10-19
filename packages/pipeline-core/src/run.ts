/**
 * The run state machine: `decide(spec, state, event, now)` returns the next state, the effects a
 * host must carry out, and the journal records to append. It is pure: no clock, file, process or
 * network access, so every host (local CLI, server) runs the same rules.
 *
 * Vocabulary: a node is *entered* (a visit, from the start or from another node); each go at it is
 * an *attempt*. A failed attempt of an agent node with no edge for its label is retried as a new
 * attempt of the same visit (rework). Limits: `max_consecutive_failures` and `max_attempts`.
 */
import { type ErrorCode, KodelError } from "./errors";
import type { NodeSpec, PipelineSpec } from "./pipeline";
import { defaultRegistry, type Registry } from "./registry";
import { renderDeep, renderTemplate } from "./render";

export const DEFAULT_STALE_MS = 30_000;
export const DEFAULT_MAX_RESTARTS = 3;
/** How many times work may be taken over from a process known to be gone before the run pauses. */
export const MAX_TAKEOVERS = 10;

export interface EngineOptions {
  registry?: Registry;
  /** How long engine work may go without a heartbeat before it counts as interrupted. */
  staleMs?: number;
  /** How many times interrupted work is restarted before the run pauses. */
  maxRestarts?: number;
}

// ── state ───────────────────────────────────────────────────────────────────

export type RunStatus = "running" | "paused" | "completed" | "failed" | "canceled";
export type NodeStatus =
  | "pending"
  | "running"
  | "waiting"
  | "rework"
  | "passed"
  | "failed"
  | "skipped";

export interface Feedback {
  /** Where the failure came from: `command`, `human` or `check:<kind>`. */
  source: string;
  reason: string;
  /** The node that failed, when the failure was handed to a different node along an edge. */
  from?: string;
}

export interface NodeRun {
  slug: string;
  status: NodeStatus;
  /** The label of the last finished attempt. */
  outcome: string | null;
  /** The number of the current or last attempt; 0 until the node is first entered. */
  attempt: number;
  consecutiveFailures: number;
  /** Attempts granted by `resume` on top of `max_attempts`. */
  extraAttempts: number;
  /** The current visit (entry into the node from the start or from another node). */
  visitId: number;
  lastFailure?: Feedback;
}

export type Phase = "agent" | "engine" | "checks" | "human";

/** An attempt that is in progress. The state holds a set of them (one at a time in the MVP). */
export interface Visit {
  node: string;
  attempt: number;
  visitId: number;
  phase: Phase;
  /** Which check is running, in the `checks` phase. */
  checkIndex: number;
  /** Last sign of life of the process running engine work. */
  heartbeatAt?: number;
  /** Who is running the engine work (a process id, as the host names it); see `tick`. */
  owner?: string;
  /**
   * The outcome the agent said the step ends with, when it is not the usual one. It is only a claim:
   * it is used as the label once the node's checks have all passed, and not before.
   */
  declared?: string;
  restarts: number;
  /** How many times the work was taken over from a process known to be gone. */
  takeovers?: number;
  /** Engine work that was restarted too often; waits for `resume`. */
  suspended?: boolean;
  startedAt: number;
}

export interface BlockedRoute {
  from: string;
  label: string;
  to: string;
  rework: boolean;
  /** Why the node before failed, handed to the node this route enters (a rejection, a red build). */
  feedback?: Feedback;
}

export interface Pause {
  reason: "consecutive" | "total" | "restarts";
  /** The node whose limit was hit (the one `resume` gives a fresh budget). */
  node: string;
  blocked?: BlockedRoute;
}

export interface RunState {
  v: 1;
  runId: string;
  task: string;
  /** Hash of the pipeline spec this run started with. */
  specHash: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  nodes: Record<string, NodeRun>;
  active: Visit[];
  /** Nodes entered, in order (rework inside a visit adds nothing). */
  trail: string[];
  pause?: Pause;
  nextVisitId: number;
  /** Sequence number of the last journal record. */
  seq: number;
  /** How many refused calls were journaled; there is a limit (`MAX_LOGGED_REFUSALS`). */
  refusals?: number;
}

/** How many refused calls a run journals: enough to see what was tried, too few to be a way to fill the disk. */
export const MAX_LOGGED_REFUSALS = 100;

// ── events in, effects out ──────────────────────────────────────────────────

export type RunEvent =
  | { type: "start"; runId: string; task: string; specHash: string }
  | {
      type: "agent_completed";
      node: string;
      attempt: number;
      summary?: string;
      /** One of the node's other outcomes (`outcomes:`), instead of the usual `passed`. */
      outcome?: string;
    }
  /** The engine work of a node (its own command) finished. The host judged the exit code. */
  | {
      type: "work_finished";
      node: string;
      attempt: number;
      passed: boolean;
      reason: string;
      /** What the command exited with and how long it ran, for the journal. */
      exit?: number;
      duration_ms?: number;
    }
  | {
      type: "check_finished";
      node: string;
      attempt: number;
      index: number;
      passed: boolean;
      reason: string;
      exit?: number;
      duration_ms?: number;
    }
  /** The host accepted the agent's report of findings. Journaled; it changes nothing else. */
  | {
      type: "report_accepted";
      node: string;
      attempt: number;
      completeness: string;
      rows: number;
    }
  /**
   * A call of the agent was refused (the engine said no). Journaled, up to a limit, so that what was
   * tried can be looked at afterwards; it changes nothing else.
   */
  | {
      type: "call_refused";
      about: string;
      node?: string;
      attempt?: number;
      code: string;
      message: string;
    }
  | { type: "human_decided"; node: string; decision: "approved" | "rejected"; reason?: string }
  | { type: "heartbeat"; node: string; attempt: number; owner?: string }
  /** The agent noticed a problem in a step description. Journaled; it never changes the run. */
  | {
      type: "feedback";
      node?: string;
      attempt?: number;
      category: string;
      message: string;
      suggestion?: string;
    }
  /** A human accepted a change made to the run's files outside kodel. Journaled; changes nothing else. */
  | { type: "acknowledge"; note?: string }
  /**
   * Look for engine work that was interrupted. `deadOwners` are the owners (see `Visit.owner`) the
   * host knows to be gone, so their work restarts at once instead of after `staleMs`.
   */
  | { type: "tick"; deadOwners?: string[] }
  | { type: "resume" }
  | { type: "cancel" };

export type Effect =
  /** Remember the working tree under this key, so a `diff` check can compare against it. */
  | { type: "take_snapshot"; key: string }
  | { type: "need_agent"; node: string; attempt: number; prompt: string }
  | {
      type: "run_command";
      node: string;
      attempt: number;
      command: string;
      expect: { exit: number };
      timeout?: number;
      restart: boolean;
    }
  | {
      type: "run_check";
      node: string;
      attempt: number;
      index: number;
      kind: string;
      params: Record<string, unknown>;
      /** The snapshot key to compare against, for checks that need one. */
      baseline?: string;
      restart: boolean;
    }
  | { type: "await_human"; node: string; attempt: number; prompt: string; files: string[] };

export interface JournalRecord {
  v: 1;
  seq: number;
  ts: number;
  event: string;
  [field: string]: unknown;
}

export type Decision =
  | { ok: true; state: RunState; effects: Effect[]; journal: JournalRecord[]; noop?: true }
  | { ok: false; error: KodelError };

/** Thrown inside `decide` for a repeat of something that already happened. */
class Repeat extends Error {}

const fail = (code: ErrorCode, message: string) => new KodelError(code, message);

// ── the machine ─────────────────────────────────────────────────────────────

class Machine {
  readonly effects: Effect[] = [];
  readonly journal: JournalRecord[] = [];
  private readonly nodes: Map<string, NodeSpec>;
  private readonly registry: Registry;
  private readonly staleMs: number;
  private readonly maxRestarts: number;

  constructor(
    private readonly spec: PipelineSpec,
    readonly s: RunState,
    private readonly now: number,
    options: EngineOptions,
  ) {
    this.nodes = new Map(spec.nodes.map((n) => [n.slug, n]));
    this.registry = options.registry ?? defaultRegistry();
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  }

  // lookups

  private node(slug: string): NodeSpec {
    const node = this.nodes.get(slug);
    if (!node) throw fail("UNKNOWN_NODE", `the pipeline has no node "${slug}"`);
    return node;
  }

  private run(slug: string): NodeRun {
    const run = this.s.nodes[slug];
    if (!run) throw fail("UNKNOWN_NODE", `the run has no node "${slug}"`);
    return run;
  }

  private handler(node: NodeSpec) {
    const handler = this.registry.node(node.kind);
    if (!handler) throw fail("PIPELINE_INVALID", `node kind "${node.kind}" is not registered`);
    return handler;
  }

  private render = (text: string) => renderTemplate(text, { task: this.s.task });

  private log(event: string, data: Record<string, unknown> = {}) {
    this.s.seq += 1;
    this.journal.push({ v: 1, seq: this.s.seq, ts: this.now, event, ...data });
  }

  /** The active visit an event is about, or a precise error, or `Repeat` for a duplicate. */
  private visitFor(slug: string, attempt: number | undefined, phases: Phase[]): Visit {
    this.node(slug);
    const run = this.run(slug);
    const visit = this.s.active.find((v) => v.node === slug);
    if (!visit) {
      const finished = run.status === "passed" || run.status === "failed";
      if (finished && (attempt === undefined || attempt === run.attempt)) throw new Repeat();
      throw fail("NODE_NOT_RUNNING", `node "${slug}" is not running`);
    }
    if (attempt !== undefined && visit.attempt !== attempt) {
      throw fail(
        "ATTEMPT_MISMATCH",
        `node "${slug}" is on attempt ${visit.attempt}, not ${attempt}`,
      );
    }
    if (!phases.includes(visit.phase)) {
      // The agent, or the engine's own command, already reported and the checks are running.
      if (visit.phase === "checks" && (phases.includes("agent") || phases.includes("engine"))) {
        throw new Repeat();
      }
      throw fail(
        "NODE_NOT_RUNNING",
        `node "${slug}" is not waiting for that (it is in the ${visit.phase} phase)`,
      );
    }
    return visit;
  }

  // entering nodes

  private enter(slug: string, rework: boolean, feedback?: Feedback) {
    const node = this.node(slug);
    const run = this.run(slug);
    run.attempt += 1;
    if (feedback) run.lastFailure = feedback;
    if (!rework) {
      run.visitId = this.s.nextVisitId++;
      this.s.trail.push(slug);
    }
    const begin = this.handler(node).begin(node.params, this.render);
    const visit: Visit = {
      node: slug,
      attempt: run.attempt,
      visitId: run.visitId,
      phase: begin.needs === "engine" ? "engine" : begin.needs,
      checkIndex: 0,
      restarts: 0,
      startedAt: this.now,
    };
    this.s.active.push(visit);
    run.status = begin.needs === "human" ? "waiting" : rework ? "rework" : "running";
    this.log("node_entered", { node: slug, attempt: run.attempt, visit: run.visitId, rework });

    for (const check of node.checks) {
      const baseline = this.registry.check(check.kind)?.baseline?.(check.params);
      if (baseline === "node" && !rework) {
        this.effects.push({ type: "take_snapshot", key: `visit:${run.visitId}` });
      } else if (baseline === "attempt") {
        this.effects.push({ type: "take_snapshot", key: `attempt:${run.visitId}:${run.attempt}` });
      }
    }

    if (begin.needs === "agent") {
      this.effects.push({
        type: "need_agent",
        node: slug,
        attempt: run.attempt,
        prompt: begin.prompt,
      });
    } else if (begin.needs === "engine") {
      visit.heartbeatAt = this.now;
      this.effects.push(this.commandEffect(node, visit, false));
    } else {
      this.effects.push({
        type: "await_human",
        node: slug,
        attempt: run.attempt,
        prompt: begin.prompt,
        files: begin.files,
      });
      this.log("gate_waiting", { node: slug, attempt: run.attempt });
    }
  }

  private commandEffect(node: NodeSpec, visit: Visit, restart: boolean): Effect {
    const begin = this.handler(node).begin(node.params, this.render);
    if (begin.needs !== "engine")
      throw fail("PIPELINE_INVALID", `node "${node.slug}" has no engine work`);
    const effect: Effect = {
      type: "run_command",
      node: node.slug,
      attempt: visit.attempt,
      command: begin.command,
      expect: begin.expect,
      restart,
    };
    if (node.timeout !== undefined) effect.timeout = node.timeout;
    return effect;
  }

  // checks

  private afterWork(visit: Visit) {
    const run = this.run(visit.node);
    run.status = "running";
    visit.phase = "checks";
    visit.checkIndex = 0;
    this.emitCheck(visit, false);
  }

  private emitCheck(visit: Visit, restart: boolean) {
    const node = this.node(visit.node);
    const check = node.checks[visit.checkIndex];
    if (!check) {
      this.finish(visit, visit.declared ?? "passed", undefined);
      return;
    }
    const params = renderDeep(check.params, { task: this.s.task });
    const kind = this.registry.check(check.kind)?.baseline?.(params);
    const baseline =
      kind === "run"
        ? "run"
        : kind === "node"
          ? `visit:${visit.visitId}`
          : kind === "attempt"
            ? `attempt:${visit.visitId}:${visit.attempt}`
            : undefined;
    visit.heartbeatAt = this.now;
    const effect: Effect = {
      type: "run_check",
      node: node.slug,
      attempt: visit.attempt,
      index: visit.checkIndex,
      kind: check.kind,
      params,
      restart,
    };
    if (baseline !== undefined) effect.baseline = baseline;
    this.effects.push(effect);
  }

  // outcomes and routing

  private finish(visit: Visit, label: string, failure: Feedback | undefined) {
    const node = this.node(visit.node);
    const run = this.run(visit.node);
    this.s.active = this.s.active.filter((v) => v !== visit);
    run.outcome = label;
    delete visit.heartbeatAt;
    if (failure === undefined) {
      run.status = "passed";
      run.consecutiveFailures = 0;
      delete run.lastFailure;
    } else {
      run.status = "failed";
      if (this.handler(node).automaticFailures) run.consecutiveFailures += 1;
      run.lastFailure = failure;
    }
    this.log("node_finished", {
      node: node.slug,
      attempt: visit.attempt,
      outcome: label,
      status: run.status,
      ...(failure ? { source: failure.source, reason: failure.reason } : {}),
    });
    this.route(node, label, failure !== undefined);
  }

  private route(node: NodeSpec, label: string, failure: boolean) {
    const edge = this.spec.edges.find((e) => e.from === node.slug && e.when === label);
    if (edge) {
      const own = failure ? this.run(node.slug).lastFailure : undefined;
      this.proceed({
        from: node.slug,
        label,
        to: edge.to,
        rework: false,
        ...(own ? { feedback: { ...own, from: node.slug } } : {}),
      });
      return;
    }
    if (!failure) {
      if (this.s.active.length === 0) this.end("completed");
      return;
    }
    if (this.handler(node).requiresRoutes) {
      this.end("failed", `node "${node.slug}" failed with "${label}" and nothing handles that`);
      return;
    }
    this.proceed({ from: node.slug, label, to: node.slug, rework: true });
  }

  /** Take a route unless a limit forbids the next attempt; then the run pauses. */
  private proceed(route: BlockedRoute) {
    const from = this.node(route.from);
    const fromRun = this.run(route.from);
    const automatic = this.handler(from).automaticFailures;
    if (
      fromRun.status === "failed" &&
      automatic &&
      fromRun.consecutiveFailures >= from.max_consecutive_failures
    ) {
      this.pause({ reason: "consecutive", node: route.from, blocked: route });
      return;
    }
    const to = this.node(route.to);
    const toRun = this.run(route.to);
    if (toRun.attempt + 1 > to.max_attempts + toRun.extraAttempts) {
      this.pause({ reason: "total", node: route.to, blocked: route });
      return;
    }
    this.enter(route.to, route.rework, route.feedback);
  }

  private pause(pause: Pause) {
    this.s.status = "paused";
    this.s.pause = pause;
    this.log("run_paused", { reason: pause.reason, node: pause.node });
  }

  private end(status: "completed" | "failed" | "canceled", reason?: string) {
    this.s.status = status;
    this.s.finishedAt = this.now;
    this.s.active = [];
    this.log("run_finished", reason === undefined ? { status } : { status, reason });
  }

  // events

  apply(event: RunEvent) {
    if (event.type === "start") return this.start(event);
    if (event.type === "acknowledge") {
      this.log("manual_edit", { note: event.note ?? null });
      return;
    }
    if (event.type === "feedback") {
      if (event.node !== undefined) this.node(event.node);
      this.log("feedback_reported", {
        node: event.node ?? null,
        attempt: event.attempt ?? null,
        category: event.category,
        message: event.message,
        suggestion: event.suggestion ?? null,
      });
      return;
    }
    if (event.type === "report_accepted") {
      this.node(event.node);
      this.log("report_accepted", {
        node: event.node,
        attempt: event.attempt,
        completeness: event.completeness,
        rows: event.rows,
      });
      return;
    }
    if (event.type === "call_refused") {
      // Only the first few are kept: an agent that keeps making refused calls must not be able to
      // grow the journal without end.
      const so_far = this.s.refusals ?? 0;
      if (so_far >= MAX_LOGGED_REFUSALS) throw new Repeat();
      this.s.refusals = so_far + 1;
      this.log("call_refused", {
        about: event.about.slice(0, 40),
        node: event.node?.slice(0, 100) ?? null,
        attempt: event.attempt ?? null,
        code: event.code.slice(0, 40),
        message: event.message.slice(0, 300),
      });
      return;
    }
    if (event.type === "cancel") {
      if (this.s.status === "running" || this.s.status === "paused") this.end("canceled");
      else throw new Repeat();
      return;
    }
    if (event.type === "resume") return this.resume();
    if (event.type === "tick" || event.type === "heartbeat") {
      if (this.s.status !== "running") throw new Repeat();
    } else if (this.s.status !== "running") {
      throw fail("NODE_NOT_RUNNING", `the run is ${this.s.status}`);
    }

    switch (event.type) {
      case "agent_completed": {
        let visit: Visit;
        try {
          visit = this.visitFor(event.node, event.attempt, ["agent"]);
        } catch (error) {
          // The step was already completed. Doing it again is a repeat, but not when it asks for a
          // different ending: the agent would think it had changed how the step ended.
          if (error instanceof Repeat && event.outcome !== undefined) {
            const standing = this.s.active.find((v) => v.node === event.node);
            const label = standing ? (standing.declared ?? "passed") : this.run(event.node).outcome;
            if (label !== null && event.outcome !== label) {
              throw fail(
                "NODE_NOT_RUNNING",
                `node "${event.node}" was already completed with "${label}"; it cannot now end with "${event.outcome}"`,
              );
            }
          }
          throw error;
        }
        const node = this.node(event.node);
        if (event.outcome !== undefined && event.outcome !== "passed") {
          const others = this.handler(node).labels(node).success.slice(1);
          if (!others.includes(event.outcome)) {
            throw fail(
              "UNKNOWN_OUTCOME",
              others.length === 0
                ? `node "${node.slug}" has no outcome "${event.outcome}" (it only finishes the usual way)`
                : `node "${node.slug}" has no outcome "${event.outcome}" (it may finish with: ${others.join(", ")})`,
            );
          }
          visit.declared = event.outcome;
        }
        this.log("agent_completed", {
          node: event.node,
          attempt: event.attempt,
          outcome: visit.declared ?? "passed",
          summary: event.summary ?? null,
        });
        this.afterWork(visit);
        return;
      }
      case "work_finished": {
        const visit = this.visitFor(event.node, event.attempt, ["engine"]);
        const node = this.node(event.node);
        this.log("command_finished", {
          node: event.node,
          attempt: event.attempt,
          passed: event.passed,
          ...(event.exit === undefined ? {} : { exit: event.exit }),
          ...(event.duration_ms === undefined ? {} : { duration_ms: event.duration_ms }),
          ...(event.passed ? {} : { reason: event.reason }),
        });
        if (event.passed) this.afterWork(visit);
        else this.finish(visit, node.on_fail, { source: "command", reason: event.reason });
        return;
      }
      case "check_finished": {
        const visit = this.visitFor(event.node, event.attempt, ["checks"]);
        if (event.index !== visit.checkIndex) throw new Repeat();
        const check = this.node(event.node).checks[event.index];
        if (!check) throw new Repeat();
        this.log("check_finished", {
          node: event.node,
          attempt: event.attempt,
          index: event.index,
          kind: check.kind,
          passed: event.passed,
          ...(event.exit === undefined ? {} : { exit: event.exit }),
          ...(event.duration_ms === undefined ? {} : { duration_ms: event.duration_ms }),
          ...(event.passed ? {} : { reason: event.reason }),
        });
        if (event.passed) {
          visit.checkIndex += 1;
          this.emitCheck(visit, false);
        } else {
          this.finish(visit, check.on_fail, {
            source: `check:${check.kind}`,
            reason: event.reason,
          });
        }
        return;
      }
      case "human_decided": {
        const visit = this.visitFor(event.node, undefined, ["human"]);
        const approved = event.decision === "approved";
        this.log("gate_decided", {
          node: event.node,
          decision: event.decision,
          reason: event.reason ?? null,
        });
        this.finish(
          visit,
          approved ? "approved" : "rejected",
          approved
            ? undefined
            : { source: "human", reason: event.reason ?? "rejected without a reason" },
        );
        return;
      }
      case "heartbeat": {
        const visit = this.s.active.find(
          (v) => v.node === event.node && v.attempt === event.attempt,
        );
        if (!visit || (visit.phase !== "engine" && visit.phase !== "checks")) throw new Repeat();
        // Only the process that owns the work may say it is alive. One that stalled, was replaced
        // and woke up again must not take the work back, or its later exit would look like the
        // death of work another process is running.
        if (event.owner !== undefined && visit.owner !== undefined && visit.owner !== event.owner) {
          throw new Repeat();
        }
        visit.heartbeatAt = this.now;
        if (event.owner !== undefined) visit.owner = event.owner;
        return;
      }
      case "tick": {
        const dead = new Set(event.deadOwners ?? []);
        for (const visit of [...this.s.active]) {
          const engineWork = visit.phase === "engine" || visit.phase === "checks";
          if (!engineWork || visit.suspended || visit.heartbeatAt === undefined) continue;
          const gone = visit.owner !== undefined && dead.has(visit.owner);
          if (gone || this.now - visit.heartbeatAt >= this.staleMs) this.restart(visit, gone);
        }
        return;
      }
    }
  }

  private start(event: Extract<RunEvent, { type: "start" }>) {
    for (const node of this.spec.nodes) {
      this.s.nodes[node.slug] = {
        slug: node.slug,
        status: "pending",
        outcome: null,
        attempt: 0,
        consecutiveFailures: 0,
        extraAttempts: 0,
        visitId: 0,
      };
    }
    this.log("run_started", { run: event.runId, task: event.task, spec: event.specHash });
    const needsRunBaseline = this.spec.nodes.some((n) =>
      n.checks.some((c) => this.registry.check(c.kind)?.baseline?.(c.params) === "run"),
    );
    if (needsRunBaseline) this.effects.push({ type: "take_snapshot", key: "run" });
    this.enter(this.spec.entry, false);
  }

  private restart(visit: Visit, ownerGone = false) {
    // Work whose process went silent counts against `maxRestarts`. Work whose process is known to be
    // gone is counted apart and allowed more: closing the agent in the middle of a build is a normal
    // thing to do, and the next session picks the build up again; it is not a crash.
    if (ownerGone) {
      visit.takeovers = (visit.takeovers ?? 0) + 1;
      if (visit.takeovers > MAX_TAKEOVERS) {
        visit.suspended = true;
        this.pause({ reason: "restarts", node: visit.node });
        return;
      }
    } else {
      visit.restarts += 1;
      if (visit.restarts > this.maxRestarts) {
        visit.suspended = true;
        this.pause({ reason: "restarts", node: visit.node });
        return;
      }
    }
    visit.heartbeatAt = this.now;
    delete visit.owner;
    this.log("node_restarted", {
      node: visit.node,
      attempt: visit.attempt,
      restarts: visit.restarts,
      ...(ownerGone ? { takeovers: visit.takeovers } : {}),
      reason: ownerGone
        ? "the process running it is gone"
        : "the process running it stopped answering",
    });
    this.reissue(visit);
  }

  private reissue(visit: Visit) {
    if (visit.phase === "engine")
      this.effects.push(this.commandEffect(this.node(visit.node), visit, true));
    else this.emitCheck(visit, true);
  }

  private resume() {
    const pause = this.s.pause;
    if (this.s.status !== "paused" || !pause) throw new Repeat();
    this.s.status = "running";
    delete this.s.pause;
    this.log("run_resumed", { reason: pause.reason, node: pause.node });

    if (pause.reason === "restarts") {
      const visit = this.s.active.find((v) => v.suspended);
      if (visit) {
        visit.suspended = false;
        visit.restarts = 0;
        visit.heartbeatAt = this.now;
        this.reissue(visit);
      }
      return;
    }
    // A human saying "go on" gives a fresh budget: the node that caused the pause starts its failure
    // count over, and every node that has used up its attempts gets another `max_attempts` (a loop
    // runs through several nodes, so topping up only one would just pause again at the next).
    this.run(pause.node).consecutiveFailures = 0;
    for (const node of this.spec.nodes) {
      const run = this.run(node.slug);
      if (run.attempt >= node.max_attempts + run.extraAttempts)
        run.extraAttempts += node.max_attempts;
    }
    if (pause.blocked) this.proceed(pause.blocked);
  }
}

/** A run that has not started yet; `decide` fills it in on the `start` event. */
function emptyState(now: number): RunState {
  return {
    v: 1,
    runId: "",
    task: "",
    specHash: "",
    status: "running",
    startedAt: now,
    nodes: {},
    active: [],
    trail: [],
    nextVisitId: 1,
    seq: 0,
  };
}

/**
 * Apply one event to a run. A repeat of something that already happened changes nothing and says
 * so (`noop`); a request that makes no sense is an error and also changes nothing.
 */
export function decide(
  spec: PipelineSpec,
  state: RunState | undefined,
  event: RunEvent,
  now: number,
  options: EngineOptions = {},
): Decision {
  if (event.type === "start") {
    if (state) return { ok: false, error: fail("NODE_NOT_RUNNING", "the run has already started") };
  } else if (!state) {
    return { ok: false, error: fail("NODE_NOT_RUNNING", "the run has not started") };
  }

  const draft: RunState = state ? structuredClone(state) : emptyState(now);
  if (event.type === "start") {
    draft.runId = event.runId;
    draft.task = event.task;
    draft.specHash = event.specHash;
  }
  const machine = new Machine(spec, draft, now, options);
  try {
    machine.apply(event);
  } catch (error) {
    if (error instanceof KodelError) return { ok: false, error };
    if (error instanceof Repeat && state) {
      return { ok: true, state, effects: [], journal: [], noop: true };
    }
    throw error;
  }
  return { ok: true, state: draft, effects: machine.effects, journal: machine.journal };
}
