/**
 * The tool handlers, independent of any transport and of any host. A host (the local CLI, the
 * server) supplies a `PipelineHost`: where pipelines come from and how runs are kept and driven.
 * The agent protocol (what the tools return, what they refuse, how long they wait) lives here, so
 * every host answers an agent the same way.
 */
import { type ErrorCode, KodelError } from "./errors";
import type { NextStep } from "./next-step";
import type { PipelineSpec } from "./pipeline";
import { defaultRegistry, type Registry } from "./registry";
import { renderTemplate } from "./render";
import type { Decision, RunState } from "./run";

// ── what a host provides ────────────────────────────────────────────────────

export interface PipelineInfo {
  name: string;
  description?: string;
  format: number;
}

/** A pipeline file that could not be read; listed so the user can fix it. */
export interface PipelineProblem {
  file: string;
  message: string;
}

export type StepResult = { ok: true } | { ok: false; code: ErrorCode; message: string };

export interface FeedbackInput {
  node?: string;
  attempt?: number;
  category: string;
  message: string;
  suggestion?: string;
}

/** One run, as the service sees it. */
export interface RunHandle {
  readonly runId: string;
  state(): Promise<RunState>;
  /** What to do next. Throws `KodelError` (for example when the state was tampered with). */
  nextStep(): Promise<NextStep>;
  completeStep(node: string, attempt: number, summary?: string): Promise<Decision>;
  reportResult(node: string, attempt: number, raw: unknown): Promise<StepResult>;
  feedback(input: FeedbackInput): Promise<Decision>;
  /** Wait until the engine's work has come to rest, but no longer than `ms`. */
  waitForRest(ms: number): Promise<void>;
}

export interface StartOutcome {
  /** `reused`: the active run for this task. `terminal`: the task already ran to its end. */
  status: "started" | "reused" | "terminal";
  run: RunHandle;
}

export interface PipelineHost {
  list(): Promise<{ pipelines: PipelineInfo[]; problems: PipelineProblem[] }>;
  resolve(name: string): Promise<PipelineSpec | undefined>;
  /** Start or find the run for a task; throws `KodelError`. */
  start(input: { pipeline: string; task: string; restart: boolean }): Promise<StartOutcome>;
  open(runId: string): Promise<RunHandle | undefined>;
}

// ── what a tool returns ─────────────────────────────────────────────────────

export interface ToolFailure {
  ok: false;
  code: ErrorCode;
  message: string;
  issues?: unknown[];
}
export type ToolResult = ({ ok: true } & Record<string, unknown>) | ToolFailure;

const failure = (code: ErrorCode, message: string, issues?: unknown[]): ToolFailure =>
  issues === undefined ? { ok: false, code, message } : { ok: false, code, message, issues };

/** Run a handler and turn the engine's own errors into the failure shape; others are bugs. */
async function guarded(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof KodelError) return failure(error.code, error.message, error.issues);
    throw error;
  }
}

export interface ServiceOptions {
  /** How long `complete_step` waits for the engine's work before answering "still running". */
  waitBudgetMs?: number;
  registry?: Registry;
}

export const DEFAULT_WAIT_BUDGET_MS = 20_000;

export class PipelineService {
  private readonly budget: number;
  private readonly registry: Registry;

  constructor(
    private readonly host: PipelineHost,
    options: ServiceOptions = {},
  ) {
    this.budget = options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS;
    this.registry = options.registry ?? defaultRegistry();
  }

  private async run(runId: string): Promise<RunHandle> {
    const run = await this.host.open(runId);
    if (!run) throw new KodelError("UNKNOWN_RUN", `there is no run "${runId}"`);
    return run;
  }

  private async spec(name: string): Promise<PipelineSpec> {
    const spec = await this.host.resolve(name);
    if (spec) return spec;
    const { pipelines } = await this.host.list();
    const known = pipelines.map((p) => p.name).join(", ") || "none";
    throw new KodelError(
      "UNKNOWN_PIPELINE",
      `there is no pipeline "${name}" (available: ${known})`,
    );
  }

  list(): Promise<ToolResult> {
    return guarded(async () => {
      const { pipelines, problems } = await this.host.list();
      return { ok: true, pipelines, ...(problems.length > 0 ? { problems } : {}) };
    });
  }

  resolve(input: { pipeline: string }): Promise<ToolResult> {
    return guarded(async () => ({ ok: true, spec: await this.spec(input.pipeline) }));
  }

  /** A dry run: what would happen, with the task filled in, and nothing started. */
  plan(input: { pipeline: string; task: string }): Promise<ToolResult> {
    return guarded(async () => {
      const spec = await this.spec(input.pipeline);
      const render = (text: string) => renderTemplate(text, { task: input.task });
      const nodes = spec.nodes.map((node) => {
        const begin = this.registry.node(node.kind)?.begin(node.params, render);
        return {
          slug: node.slug,
          kind: node.kind,
          ...(begin?.needs === "agent" || begin?.needs === "human" ? { prompt: begin.prompt } : {}),
          ...(begin?.needs === "engine" ? { command: begin.command } : {}),
          checks: node.checks.map((c) => ({ kind: c.kind, on_fail: c.on_fail })),
          max_consecutive_failures: node.max_consecutive_failures,
          max_attempts: node.max_attempts,
        };
      });
      return {
        ok: true,
        pipeline: spec.name,
        task: input.task,
        entry: spec.entry,
        nodes,
        edges: spec.edges,
      };
    });
  }

  start(input: { task: string; pipeline?: string; restart?: boolean }): Promise<ToolResult> {
    return guarded(async () => {
      let name = input.pipeline;
      if (!name) {
        const { pipelines } = await this.host.list();
        if (pipelines.length === 0) {
          throw new KodelError(
            "UNKNOWN_PIPELINE",
            "there are no pipelines; add one to .kodel/pipelines",
          );
        }
        if (pipelines.length > 1) {
          const names = pipelines.map((p) => p.name).join(", ");
          throw new KodelError(
            "PIPELINE_AMBIGUOUS",
            `several pipelines exist (${names}); say which one`,
          );
        }
        name = (pipelines[0] as PipelineInfo).name;
      }
      await this.spec(name);
      const outcome = await this.host.start({
        pipeline: name,
        task: input.task,
        restart: input.restart === true,
      });
      return {
        ok: true,
        run_id: outcome.run.runId,
        reused: outcome.status === "reused",
        terminal: outcome.status === "terminal",
        next: await outcome.run.nextStep(),
      };
    });
  }

  nextStep(input: { run_id: string }): Promise<ToolResult> {
    return guarded(async () => ({
      ok: true,
      ...(await (await this.run(input.run_id)).nextStep()),
    }));
  }

  reportResult(input: {
    run_id: string;
    node_slug: string;
    attempt: number;
    completeness: string;
    incomplete_reason?: string;
    rows: unknown[];
    metrics?: Record<string, number>;
  }): Promise<ToolResult> {
    return guarded(async () => {
      const run = await this.run(input.run_id);
      const { run_id: _run, node_slug: _node, attempt: _attempt, ...report } = input;
      const result = await run.reportResult(input.node_slug, input.attempt, report);
      return result.ok ? { ok: true } : failure(result.code, result.message);
    });
  }

  completeStep(input: {
    run_id: string;
    node_slug: string;
    attempt: number;
    summary?: string;
  }): Promise<ToolResult> {
    return guarded(async () => {
      const run = await this.run(input.run_id);
      const decision = await run.completeStep(input.node_slug, input.attempt, input.summary);
      if (!decision.ok)
        return failure(decision.error.code, decision.error.message, decision.error.issues);
      await run.waitForRest(this.budget);
      const node = (await run.state()).nodes[input.node_slug];
      const failed = node?.lastFailure;
      const checkFailed =
        node &&
        (node.status === "rework" || node.status === "failed") &&
        failed?.source.startsWith("check:");
      return {
        ok: true,
        advanced: decision.noop !== true && node?.status === "passed",
        outcome: node?.outcome ?? null,
        ...(checkFailed && failed
          ? { failed_check: { kind: failed.source.slice("check:".length), reason: failed.reason } }
          : {}),
        next: await run.nextStep(),
      };
    });
  }

  feedback(input: {
    run_id: string;
    node_slug?: string;
    attempt?: number;
    category: string;
    message: string;
    suggestion?: string;
  }): Promise<ToolResult> {
    return guarded(async () => {
      const run = await this.run(input.run_id);
      const { run_id: _run, node_slug, ...rest } = input;
      const decision = await run.feedback(
        node_slug === undefined ? rest : { node: node_slug, ...rest },
      );
      if (!decision.ok)
        return failure(decision.error.code, decision.error.message, decision.error.issues);
      return { ok: true, id: String(decision.journal[0]?.seq ?? 0) };
    });
  }
}
