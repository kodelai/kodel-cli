/**
 * The tool handlers, independent of any transport and of any host. A host (the local CLI, the
 * server) supplies a `PipelineHost`: where pipelines come from and how runs are kept and driven.
 * The agent protocol (what the tools return, what they refuse, how long they wait) lives here, so
 * every host answers an agent the same way.
 */

import { docTopics } from "./docs";
import { type ErrorCode, KodelError } from "./errors";
import type { Caller } from "./executor";
import { MAX_WAIT_S, type NextStep, type PipelineChange } from "./next-step";
import type { PipelineSpec } from "./pipeline";
import type { NodeDiff } from "./pipeline-diff";
import { defaultRegistry, type Registry } from "./registry";
import { renderTemplate } from "./render";
import type { Decision, RunState } from "./run";
import { runSlug, validateTitle } from "./slug";
import { BASELINE_VERSION, MAX_SUPPORTED_MAJOR } from "./version";

// ── what a host provides ────────────────────────────────────────────────────

export interface PipelineInfo {
  name: string;
  description?: string;
  version: string;
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
  check?: string;
}

export type ProposeOutcome =
  | { ok: false; code: ErrorCode; message: string }
  | {
      ok: true;
      /** `withdrawn`: there was a proposal and it was taken back. `none`: there was none to take back. */
      status: "proposed" | "withdrawn" | "none";
      change?: PipelineChange;
    };

/** What a person is told about a pipeline the agent proposed outside a run. */
export interface PipelineProposalInfo {
  name: string;
  /** `new`: no such pipeline. `change`: the pipeline of that name exists and this differs from it. */
  kind: "new" | "change";
  /** For a change: what differs, per step. */
  changes?: NodeDiff[];
  /** The command a person runs to accept it. */
  apply: string;
  warnings?: string[];
}

export type PipelineProposalOutcome =
  | { ok: false; code: ErrorCode; message: string }
  | { ok: true; status: "proposed"; proposal: PipelineProposalInfo }
  | { ok: true; status: "withdrawn" | "none"; name: string };

/** One run, as the service sees it. */
export interface RunHandle {
  readonly runId: string;
  state(): Promise<RunState>;
  /**
   * What to do next. Throws `KodelError` (for example when the state was tampered with).
   * `atCompletion`: the agent has just said its step is done; a change of the pipeline that holds
   * the run is answered here, not while the agent is still working.
   * `serve`: the answer goes to the agent, so the host may keep a record of what it was shown (it
   * decides whether, per the run's settings); `caller` is who the transport says is asking. A call
   * without it is the host looking at the run for itself and records nothing.
   */
  nextStep(options?: { atCompletion?: boolean; serve?: { caller?: Caller } }): Promise<NextStep>;
  completeStep(
    node: string,
    attempt: number,
    summary?: string,
    outcome?: string,
    /** Who the transport says is calling; the host adds what else it observes. */
    caller?: Caller,
  ): Promise<Decision>;
  /** `replace` starts the stored report over instead of adding the rows to it. */
  reportResult(
    node: string,
    attempt: number,
    raw: unknown,
    options?: { replace?: boolean },
  ): Promise<StepResult>;
  feedback(input: FeedbackInput): Promise<Decision>;
  /** The pipeline the run is on now: its text as it was kept, parsed, and its hash. */
  pinnedPipeline(): Promise<{ yaml: string; spec: PipelineSpec; hash: string }>;
  /**
   * The agent's proposal to change the run's pipeline; an empty `yaml` takes the proposal back. It
   * changes nothing about the run: a person decides.
   */
  proposeChange(input: { yaml: string; summary: string }): Promise<ProposeOutcome>;
  /** Wait until the engine's work has come to rest, but no longer than `ms`. */
  waitForRest(ms: number): Promise<void>;
}

/** Where a run's commands and checks run, when that is not the directory the agent started in. */
export interface RunLocation {
  /** Absolute. The host decides it; the core never reads or writes there. */
  path: string;
  branch?: string;
  /** Something the agent should know about it (for example, what the directory does not have). */
  note?: string;
}

/** The pipeline file has changes that are not committed, and the run can use either version. */
export interface PipelineChoice {
  reason: "pipeline_uncommitted";
  pipeline: string;
  /** The file, relative to the repository. */
  file: string;
  options: ("working" | "committed")[];
  /** What the working version changes against the committed one, per step. */
  changes: NodeDiff[];
  tell_the_person: string;
}

/**
 * Thrown by a host's `start` when nothing was started because the person has to say which version
 * of the pipeline the run uses. The service turns it into an answer, not a failure.
 */
export class ChoiceNeeded extends Error {
  constructor(readonly choice: PipelineChoice) {
    super("the pipeline file has changes that are not committed");
  }
}

export interface StartOutcome {
  /** `reused`: the active run for this task. `terminal`: the task already ran to its end. */
  status: "started" | "reused" | "terminal";
  run: RunHandle;
  /** Absent when the run works in the agent's own directory. */
  workdir?: RunLocation;
  /** The task the run was tied to. `warning`: the tracker could not be told, the run goes on. */
  task?: { key: string; restarted?: true; warning?: string };
}

export interface PipelineHost {
  list(): Promise<{ pipelines: PipelineInfo[]; problems: PipelineProblem[] }>;
  resolve(name: string): Promise<PipelineSpec | undefined>;
  /** The pipeline as its file has it: the text a change starts from, and the hash of that text. */
  resolveSource?(
    name: string,
  ): Promise<{ spec: PipelineSpec; yaml: string; hash: string } | undefined>;
  /**
   * The agent proposes a pipeline outside a run: a new one, or another version of one that exists.
   * Nothing is put in place; a person accepts it. A host that does not take these leaves it out.
   */
  proposePipeline?(input: {
    yaml: string;
    summary: string;
    name?: string;
  }): Promise<PipelineProposalOutcome>;
  /**
   * Start or find the run for a task; throws `KodelError`. `cwd` is the directory the agent says it
   * is working in: a hint the host may check and use, never a place it has to run anything.
   */
  start(input: {
    pipeline: string;
    task: string;
    restart: boolean;
    cwd?: string;
    /** Which version to use when the pipeline file has uncommitted changes; asked, never guessed. */
    pipeline_version?: "working" | "committed";
    /** The run's slug, as the agent gave it and the service validated it; absent: made from the task. */
    title?: string;
    /** The task to tie the run to, as the person named it; `restart_task` allows a task that is done. */
    task_key?: string;
    restart_task?: boolean;
    /** Who the transport says is calling. Never read from the tool's arguments. */
    caller?: Caller;
    /** What the agent was told and given when it connected, as text for the host to hash. */
    surface?: ServedSurface;
  }): Promise<StartOutcome>;
  open(runId: string): Promise<RunHandle | undefined>;
}

// ── what a tool returns ─────────────────────────────────────────────────────

export interface ToolFailure {
  ok: false;
  code: ErrorCode;
  message: string;
  issues?: unknown[];
  details?: Record<string, unknown>;
}
export type ToolResult = ({ ok: true } & Record<string, unknown>) | ToolFailure;

export const failure = (
  code: ErrorCode,
  message: string,
  issues?: unknown[],
  details?: Record<string, unknown>,
): ToolFailure => {
  const result: ToolFailure = { ok: false, code, message };
  if (issues !== undefined) result.issues = issues;
  if (details !== undefined) result.details = details;
  return result;
};

/** Run a handler and turn the engine's own errors into the failure shape; others are bugs. */
async function guarded(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof KodelError) {
      return failure(error.code, error.message, error.issues, error.details);
    }
    throw error;
  }
}

/** The texts the agent reads when it connects: the instructions and a description of the tools. */
export interface ServedSurface {
  instructions: string;
  tools: string;
  contract_version: number;
}

export interface ServiceOptions {
  /** How long `complete_step` waits for the engine's work before answering "still running". */
  waitBudgetMs?: number;
  registry?: Registry;
  /** The version of the program that serves the tools, shown by `pipeline_docs`. */
  engineVersion?: string;
  /** The client of the connection, asked at each call: the handshake comes after the service is built. */
  caller?: () => Caller | undefined;
  /** What this connection serves; the host hashes it into the run's `engine` record. */
  surface?: ServedSurface;
}

export const DEFAULT_WAIT_BUDGET_MS = 20_000;

export class PipelineService {
  private readonly budget: number;
  private readonly registry: Registry;
  private readonly engineVersion: string;
  private readonly caller: () => Caller | undefined;
  private readonly surface: ServedSurface | undefined;

  constructor(
    private readonly host: PipelineHost,
    options: ServiceOptions = {},
  ) {
    this.budget = options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS;
    this.registry = options.registry ?? defaultRegistry();
    this.engineVersion = options.engineVersion ?? "unknown";
    this.caller = options.caller ?? (() => undefined);
    this.surface = options.surface;
  }

  private who(): { caller?: Caller } {
    const caller = this.caller();
    return caller === undefined ? {} : { caller };
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

  /** The engine's documentation for the agent: an index, or one topic. Needs no host and no run. */
  docs(input: { topic?: string }): Promise<ToolResult> {
    return guarded(async () => {
      const topics = docTopics(this.registry);
      if (input.topic === undefined) {
        return {
          ok: true,
          kodel: "Spec-driven pipelines that the engine, not the agent, checks.",
          engine_version: this.engineVersion,
          pipeline_file_version: { baseline: BASELINE_VERSION, max_major: MAX_SUPPORTED_MAJOR },
          topics: topics.map(({ topic, summary }) => ({ topic, summary })),
          note: "Call pipeline_docs again with `topic` to read one.",
        };
      }
      const found = topics.find((t) => t.topic === input.topic);
      if (!found) {
        const known = topics.map((t) => t.topic).join(", ");
        throw new KodelError(
          "UNKNOWN_TOPIC",
          `there is no topic "${input.topic}" (topics: ${known})`,
        );
      }
      return { ok: true, topic: found.topic, text: found.text };
    });
  }

  list(): Promise<ToolResult> {
    return guarded(async () => {
      const { pipelines, problems } = await this.host.list();
      return {
        ok: true,
        pipelines,
        ...(problems.length > 0 ? { problems } : {}),
        ...(pipelines.length === 0
          ? {
              note: "There are no pipelines. To write one, read pipeline_docs (topic pipeline-design).",
            }
          : {}),
      };
    });
  }

  /**
   * The definition of a pipeline. With a run, the one that run is on: its text as kept, which is what a
   * proposal to change it starts from (the file in the project may be another version). Without one, the
   * file's text and its hash, which is what a change outside a run starts from.
   */
  resolve(input: { pipeline: string; run_id?: string }): Promise<ToolResult> {
    return guarded(async () => {
      if (input.run_id !== undefined) {
        const pinned = await (await this.run(input.run_id)).pinnedPipeline();
        return { ok: true, spec: pinned.spec, yaml: pinned.yaml, version: pinned.hash };
      }
      const source = await this.host.resolveSource?.(input.pipeline);
      if (source) return { ok: true, spec: source.spec, yaml: source.yaml, version: source.hash };
      return { ok: true, spec: await this.spec(input.pipeline) };
    });
  }

  proposeChange(input: {
    run_id?: string;
    pipeline: string;
    summary: string;
    name?: string;
  }): Promise<ToolResult> {
    return guarded(async () => {
      if (input.run_id === undefined) return this.proposePipeline(input);
      const run = await this.run(input.run_id);
      const outcome = await run.proposeChange({ yaml: input.pipeline, summary: input.summary });
      if (!outcome.ok) return failure(outcome.code, outcome.message);
      return {
        ok: true,
        status: outcome.status,
        ...(outcome.change ? { pipeline_change: outcome.change } : {}),
        note:
          outcome.status === "proposed"
            ? "The run does not change until the person accepts it. Tell the person what you propose and why, which steps run again (`redo`), and the command in `pipeline_change.apply`; do not run it. Then end your turn, or go on if the next step is not affected."
            : outcome.status === "withdrawn"
              ? "The proposal was taken back."
              : "There was no proposal to take back.",
      };
    });
  }

  private async proposePipeline(input: {
    pipeline: string;
    summary: string;
    name?: string;
  }): Promise<ToolResult> {
    if (!this.host.proposePipeline) {
      return failure(
        "PIPELINE_CHANGE_REFUSED",
        "this server takes a proposal only for the pipeline of a run; pass run_id",
      );
    }
    const outcome = await this.host.proposePipeline({
      yaml: input.pipeline,
      summary: input.summary,
      ...(input.name === undefined ? {} : { name: input.name }),
    });
    if (!outcome.ok) return failure(outcome.code, outcome.message);
    if (outcome.status !== "proposed") {
      return {
        ok: true,
        status: outcome.status,
        name: outcome.name,
        note:
          outcome.status === "withdrawn"
            ? "The proposal was taken back."
            : "There was no proposal of that name to take back.",
      };
    }
    return {
      ok: true,
      status: "proposed",
      pipeline_proposal: outcome.proposal,
      note:
        "Nothing is in place: a person has to accept it. Tell the person what you propose (and, for a change, " +
        "what differs) and your assumptions, and the command in `pipeline_proposal.apply`; do not run it. " +
        "To change your proposal, propose again with the same name: it replaces this one.",
    };
  }

  /** A dry run: what would happen, with the task filled in, and nothing started. */
  plan(input: { pipeline: string; task: string }): Promise<ToolResult> {
    return guarded(async () => {
      const spec = await this.spec(input.pipeline);
      // No run exists, so there is no start date to give: the placeholder shows its form.
      const render = (text: string) =>
        renderTemplate(text, {
          task: input.task,
          run: { slug: runSlug(undefined, input.task), startDate: "YYYY-MM-DD" },
        });
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

  start(input: {
    task: string;
    pipeline?: string;
    restart?: boolean;
    cwd?: string;
    pipeline_version?: "working" | "committed";
    title?: string;
    task_key?: string;
    restart_task?: boolean;
  }): Promise<ToolResult> {
    return guarded(async () => {
      // First of all: the host makes a worktree and a branch before it writes the run, and a title
      // that is refused must leave nothing of either behind.
      if (input.title !== undefined) validateTitle(input.title);
      // The flag means "start this task again": without a task it would only force a new run.
      if (input.restart_task === true && input.task_key === undefined) {
        throw new KodelError("INVALID_ARGUMENTS", "restart_task needs task_key", [
          { path: ["restart_task"], message: "needs task_key" },
        ]);
      }
      let name = input.pipeline;
      if (!name) {
        const { pipelines } = await this.host.list();
        if (pipelines.length === 0) {
          throw new KodelError(
            "UNKNOWN_PIPELINE",
            "there are no pipelines; add one to .kodel/pipelines (pipeline_docs, topic pipeline-design, says how)",
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
      let outcome: StartOutcome;
      try {
        outcome = await this.host.start({
          pipeline: name,
          task: input.task,
          restart: input.restart === true,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.pipeline_version === undefined
            ? {}
            : { pipeline_version: input.pipeline_version }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.task_key === undefined ? {} : { task_key: input.task_key }),
          ...(input.restart_task === true ? { restart_task: true } : {}),
          ...this.who(),
          ...(this.surface === undefined ? {} : { surface: this.surface }),
        });
      } catch (error) {
        // No run exists yet: the answer has no run_id, only what the person has to decide.
        if (error instanceof ChoiceNeeded)
          return { ok: true, started: false, choice: error.choice };
        throw error;
      }
      return {
        ok: true,
        run_id: outcome.run.runId,
        reused: outcome.status === "reused",
        terminal: outcome.status === "terminal",
        // null: work in the directory you are in, as before.
        workdir: outcome.workdir?.path ?? null,
        ...(outcome.workdir?.branch === undefined ? {} : { branch: outcome.workdir.branch }),
        ...(outcome.workdir?.note === undefined ? {} : { note: outcome.workdir.note }),
        ...(outcome.task === undefined ? {} : { task: outcome.task }),
        next: await outcome.run.nextStep({ serve: this.who() }),
      };
    });
  }

  /**
   * What to do next. With `wait_s`, and engine work going, it waits (up to `MAX_WAIT_S`) for that
   * work to finish before answering, so the agent does not have to guess how long to wait.
   */
  nextStep(input: { run_id: string; wait_s?: number }): Promise<ToolResult> {
    return guarded(async () => {
      const run = await this.run(input.run_id);
      let step = await run.nextStep({ serve: this.who() });
      if (input.wait_s !== undefined && input.wait_s > 0 && "running" in step) {
        await run.waitForRest(Math.min(input.wait_s, MAX_WAIT_S) * 1000);
        step = await run.nextStep({ serve: this.who() });
      }
      return { ok: true, ...step };
    });
  }

  reportResult(input: {
    run_id: string;
    node_slug: string;
    attempt: number;
    completeness?: string;
    incomplete_reason?: string;
    rows: unknown[];
    metrics?: Record<string, number>;
    replace?: boolean;
  }): Promise<ToolResult> {
    return guarded(async () => {
      const run = await this.run(input.run_id);
      const { run_id: _run, node_slug: _node, attempt: _attempt, replace, ...report } = input;
      const result = await run.reportResult(input.node_slug, input.attempt, report, {
        replace: replace === true,
      });
      return result.ok ? { ok: true } : failure(result.code, result.message);
    });
  }

  completeStep(input: {
    run_id: string;
    node_slug: string;
    attempt: number;
    summary?: string;
    outcome?: string;
  }): Promise<ToolResult> {
    return guarded(async () => {
      const run = await this.run(input.run_id);
      const decision = await run.completeStep(
        input.node_slug,
        input.attempt,
        input.summary,
        input.outcome,
        this.caller(),
      );
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
        next: await run.nextStep({ atCompletion: true, serve: this.who() }),
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
    check?: string;
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
