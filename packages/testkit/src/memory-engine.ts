/**
 * The reference host: runs the core state machine with everything in memory. Effects are carried
 * out from the scenario's own data (changed files, exit codes, reports), so a scenario can be
 * replayed without git, processes or a clock. Real hosts differ in how they gather these facts,
 * never in the rules, which live in `decide`.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  type ChangeSet,
  checkIdOf,
  DEFAULT_CLAIM_TTL_S,
  DEFAULT_STALE_MS,
  type Decision,
  decide,
  type Effect,
  type EngineOptions,
  evaluateCommand,
  evaluateDiff,
  evaluateResult,
  KodelError,
  liveClaim,
  nextStep,
  type PipelineSpec,
  type RunEvent,
  type RunState,
  validateReport,
} from "@kodel-ai/pipeline-core";

/** The host's part of a claim: the token is hashed before the core sees it. */
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);

import type {
  Production,
  ScenarioEngine,
  ScenarioEvent,
  ScenarioState,
  StartContext,
  ToolResponse,
} from "./types";

export class MemoryEngine implements ScenarioEngine {
  readonly name = "core-memory";

  private spec!: PipelineSpec;
  private context!: StartContext;
  private state: RunState | undefined;
  private clock = 1_000_000;
  /** Changed lines per path, against the tree as it was before the pipeline started. */
  private tree = new Map<string, number>();
  private snapshots = new Map<string, Map<string, number>>();
  private applied = new Set<string>();
  private hangsUsed = new Set<string>();
  /** Engine work that is still running, and whether its process is alive. */
  private tasks: { node: string; attempt: number; alive: boolean }[] = [];
  private journal: string[] = [];
  private feedbackCount = 0;
  /** Follow-ups the engine refused (a result that came after the run had moved on), as decisions. */
  readonly refused: { event: RunEvent; code: string; message: string }[] = [];
  /** How long a worker's hold on a step lasts; a scenario about lapsing claims sets it short. */
  claimTtlMs = DEFAULT_CLAIM_TTL_S * 1000;

  constructor(private readonly options: EngineOptions = {}) {}

  async start(context: StartContext): Promise<{ runId: string }> {
    this.spec = context.spec;
    this.context = context;
    const result = await this.process({
      type: "start",
      runId: "run-1",
      task: context.task,
      specHash: "memory",
    });
    if (!result.ok) throw result.error;
    return { runId: "run-1" };
  }

  async applyEvent(event: ScenarioEvent): Promise<void> {
    switch (event.kind) {
      case "humanApprove":
      case "humanReject": {
        const result = await this.process({
          type: "human_decided",
          node: event.node,
          decision: event.kind === "humanApprove" ? "approved" : "rejected",
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        });
        if (!result.ok) throw result.error;
        return;
      }
      case "interrupt": {
        for (const task of this.tasks) task.alive = false;
        this.clock += (this.options.staleMs ?? DEFAULT_STALE_MS) + 1_000;
        await this.process({ type: "tick" });
        return;
      }
      case "advanceTime": {
        this.clock += event.ms;
        for (const task of this.tasks.filter((t) => t.alive)) {
          await this.process({ type: "heartbeat", node: task.node, attempt: task.attempt });
        }
        await this.process({ type: "tick" });
        return;
      }
      case "resume":
      case "cancel": {
        const result = await this.process({ type: event.kind });
        if (!result.ok) throw result.error;
        return;
      }
    }
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<ToolResponse> {
    switch (tool) {
      case "pipeline_complete_step": {
        const slug = String(args.node_slug);
        const result = await this.process({
          type: "agent_completed",
          node: slug,
          attempt: Number(args.attempt),
          ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
          ...(typeof args.claim_token === "string"
            ? { claimToken: hashToken(args.claim_token) }
            : {}),
        });
        if (!result.ok)
          return { ok: false, code: result.error.code, message: result.error.message };
        const run = this.state?.nodes[slug];
        return { ok: true, advanced: run?.status === "passed", outcome: run?.outcome ?? null };
      }
      case "pipeline_take_step": {
        const state = this.state;
        if (!state)
          return { ok: false, code: "NODE_NOT_RUNNING", message: "the run has not started" };
        const slug =
          typeof args.node_slug === "string"
            ? args.node_slug
            : state.active.find(
                (v) =>
                  v.phase === "agent" && liveClaim(state.nodes[v.node], this.clock) === undefined,
              )?.node;
        if (slug === undefined) return { ok: true, status: "none" };
        const token =
          typeof args.claim_token === "string" ? args.claim_token : randomBytes(16).toString("hex");
        const hash = hashToken(token);
        const result = await this.process({
          type: "step_claimed",
          node: slug,
          token: hash,
          ttlMs: this.claimTtlMs,
        });
        if (!result.ok)
          return { ok: false, code: result.error.code, message: result.error.message };
        const visit = result.state.active.find((v) => v.node === slug && v.phase === "agent");
        if (!visit)
          return { ok: false, code: "NODE_NOT_RUNNING", message: `node "${slug}" is not open` };
        const claim = liveClaim(result.state.nodes[slug], this.clock);
        if (claim === undefined || claim.token !== hash) {
          return {
            ok: true,
            status: "taken",
            node_slug: slug,
            attempt: visit.attempt,
            taken_by: claim?.by ?? "?",
          };
        }
        return {
          ok: true,
          status: "claimed",
          node_slug: slug,
          attempt: visit.attempt,
          claim_token: token,
        };
      }
      case "pipeline_feedback": {
        const slug = args.node_slug;
        if (typeof slug === "string" && !this.spec.nodes.some((n) => n.slug === slug)) {
          return { ok: false, code: "UNKNOWN_NODE", message: `the pipeline has no node "${slug}"` };
        }
        if (typeof args.check === "string") {
          const node = this.spec.nodes.find((n) => n.slug === slug);
          const ids = (node?.checks ?? []).map((_, i) => (node ? checkIdOf(node, i) : undefined));
          if (args.category !== "wrong_check" || !ids.includes(args.check)) {
            return { ok: false, code: "INVALID_ARGUMENTS", message: "not a check of the node" };
          }
        }
        this.journal.push("feedback_reported");
        this.feedbackCount += 1;
        return { ok: true, id: `f-${this.feedbackCount}` };
      }
      case "pipeline_next_step": {
        if (!this.state)
          return { ok: false, code: "NODE_NOT_RUNNING", message: "the run has not started" };
        try {
          return {
            ok: true,
            ...nextStep(this.spec, this.state, this.clock, undefined, {
              ...(typeof args.node_slug === "string" ? { nodeSlug: args.node_slug } : {}),
            }),
          };
        } catch (error) {
          if (error instanceof KodelError) {
            return { ok: false, code: error.code, message: error.message };
          }
          throw error;
        }
      }
      default:
        return { ok: false, code: "UNKNOWN_TOOL", message: `unknown tool "${tool}"` };
    }
  }

  async readState(): Promise<ScenarioState> {
    const state = this.state;
    if (!state) throw new Error("the run has not started");
    return {
      runStatus: state.status,
      waitingGates: state.active.filter((v) => v.phase === "human").map((v) => v.node),
      nodes: this.spec.nodes.map((node) => {
        const run = state.nodes[node.slug];
        return {
          slug: node.slug,
          status: run?.status ?? "pending",
          outcome: run?.outcome ?? null,
          attempt: run?.attempt ?? 0,
        };
      }),
      trail: [...state.trail],
      journal: [...this.journal],
    };
  }

  // ── the host loop ─────────────────────────────────────────────────────────

  /** Apply an event, then carry out the effects until the run comes to rest. */
  private async process(first: RunEvent): Promise<Decision> {
    const queue: RunEvent[] = [first];
    let firstResult: Decision | undefined;
    while (queue.length > 0) {
      const event = queue.shift() as RunEvent;
      const result = decide(this.spec, this.state, event, this.clock, this.options);
      firstResult ??= result;
      if (!result.ok) {
        if (event === first) return result;
        // A follow-up the host built from an effect can be refused once the run has moved on (a
        // branch that died ended the run before a sibling's result came in). It is a decision like
        // any other: kept for the test to look at, and the rest of the queue goes on.
        this.refused.push({ event, code: result.error.code, message: result.error.message });
        this.journal.push(`refused:${result.error.code}`);
        continue;
      }
      this.state = result.state;
      for (const record of result.journal) this.journal.push(record.event);
      for (const effect of result.effects) {
        const next = this.execute(effect);
        if (next) queue.push(next);
      }
    }
    return firstResult as Decision;
  }

  private production(node: string, attempt: number): Production {
    return (
      this.context.injects.find((i) => i.node === node && i.attempt === attempt)?.produce ?? {}
    );
  }

  /** What the agent (or the command) did to the working tree during this attempt. */
  private applyProduction(node: string, attempt: number) {
    const key = `${node}#${attempt}`;
    if (this.applied.has(key)) return;
    this.applied.add(key);
    const production = this.production(node, attempt);
    for (const [path, lines] of Object.entries(production.changes ?? {})) {
      this.tree.set(path, (this.tree.get(path) ?? 0) + lines);
    }
    for (const path of production.restore ?? []) this.tree.delete(path);
  }

  private changesSince(baseline: string | undefined): ChangeSet {
    const base = (baseline ? this.snapshots.get(baseline) : undefined) ?? new Map<string, number>();
    const changes: ChangeSet = {};
    for (const path of new Set([...this.tree.keys(), ...base.keys()])) {
      const lines = Math.abs((this.tree.get(path) ?? 0) - (base.get(path) ?? 0));
      if (lines > 0) changes[path] = lines;
    }
    return changes;
  }

  private execute(effect: Effect): RunEvent | undefined {
    switch (effect.type) {
      case "take_snapshot":
        this.snapshots.set(effect.key, new Map(this.tree));
        return undefined;

      case "need_agent":
        this.applyProduction(effect.node, effect.attempt);
        return this.context.agentMode === "auto"
          ? { type: "agent_completed", node: effect.node, attempt: effect.attempt }
          : undefined;

      case "run_command": {
        this.applyProduction(effect.node, effect.attempt);
        const key = `${effect.node}#${effect.attempt}`;
        const production = this.production(effect.node, effect.attempt);
        this.tasks = this.tasks.filter(
          (t) => !(t.node === effect.node && t.attempt === effect.attempt),
        );
        if (production.hangs && !effect.restart && !this.hangsUsed.has(key)) {
          this.hangsUsed.add(key);
          this.tasks.push({ node: effect.node, attempt: effect.attempt, alive: true });
          return undefined;
        }
        const verdict = evaluateCommand(production.exit ?? 0, { expect: effect.expect });
        return {
          type: "work_finished",
          node: effect.node,
          attempt: effect.attempt,
          passed: verdict.passed,
          reason: verdict.reason,
        };
      }

      case "run_check": {
        const production = this.production(effect.node, effect.attempt);
        const checks = this.spec.nodes.find((n) => n.slug === effect.node)?.checks ?? [];
        const ordinal = checks.slice(0, effect.index).filter((c) => c.kind === effect.kind).length;
        let verdict: { passed: boolean; reason: string };
        if (effect.kind === "diff") {
          verdict = evaluateDiff(this.changesSince(effect.baseline), effect.params);
        } else if (effect.kind === "command") {
          verdict = evaluateCommand(production.checkExits?.[ordinal] ?? 0, effect.params);
        } else if (effect.kind === "result") {
          const sent = production.result;
          const valid = sent === undefined ? undefined : validateReport(sent, effect.params);
          verdict =
            valid && !valid.ok
              ? { passed: false, reason: valid.message }
              : evaluateResult(valid?.ok ? valid.report : undefined, effect.params);
        } else {
          verdict = { passed: true, reason: "" };
        }
        return {
          type: "check_finished",
          node: effect.node,
          attempt: effect.attempt,
          index: effect.index,
          passed: verdict.passed,
          reason: verdict.reason,
        };
      }

      case "await_human":
        return undefined;
    }
  }
}
