/**
 * The start of a task by request (not by `kodel serve`): the one function that the TUI's `s`, the manager's
 * `manager_start_task` and the web UI's Start button call. It takes the start lock, reads everything again
 * inside it (the task, the runs, the environment), admits the task by the rule the daemon keeps (in the mode
 * that reads no approval), makes the run and starts its agent. What only warns (`full`, `blocked`,
 * `conflict`) is a refusal that `force` goes past; what no one gets past (`done`, `has_run`, `not_ready`,
 * `agent_failed`) stays one. `by` and `via` are set by the path of the call, never by an argument of a tool.
 */

import { createRunGatherer, type GatherHostPort, PipelineNotCommitted } from "@kodel-ai/local";
import {
  type Caller,
  ChoiceNeeded,
  type ForcedWarning,
  KodelError,
  type RunOrigin,
  readinessWords,
  type Started,
} from "@kodel-ai/pipeline-core";
import {
  admitStart,
  ruleFor,
  type ServeRules,
  type ServeTaskView,
  type StartWarning,
} from "@kodel-ai/pipeline-core/serve";
import { serveWorkerOf } from "./worker-factory";
import type { WorkerLauncher } from "./worker-launcher";

/** The limits and rules of `serve` that a start by hand reads: places are counted by the daemon's rule. */
export type ManualServe = Pick<ServeRules, "max_workers" | "max_runs" | "start">;

/** The part of the host a start by hand uses; `LocalPipelineHost` fits it. */
export interface ManualStartHost extends GatherHostPort {
  list(): Promise<{ pipelines: { name: string }[] }>;
  taskLink(): Promise<unknown>;
  start(input: {
    pipeline: string;
    task: string;
    restart: boolean;
    task_key?: string;
    title?: string;
    caller: Caller;
    origin: RunOrigin;
    committed_only?: boolean;
  }): Promise<{
    status: "started" | "reused" | "terminal";
    run: { runId: string };
    workdir?: { path: string };
  }>;
  withWorkerStartLock?<T>(fn: () => Promise<T>): Promise<T>;
}

/** What the caller's tracker says about the task, as the start needs it. */
export type ManualTask =
  | {
      status: "ready";
      /** The task as the plan sees it: key, state and links; approval is not read. */
      view: ServeTaskView;
      /** What the agent's first prompt calls the task. */
      title: string;
      /** The task's text, as the run gets it. */
      text: string;
    }
  | { status: "missing" }
  | { status: "failed"; message: string };

export interface ManualStartDeps {
  host: ManualStartHost;
  launcher: Pick<WorkerLauncher, "preflight" | "start" | "statuses">;
  /** Reads the task again at every call: the question may have stood on a screen for a while. */
  readTask(key: string): Promise<ManualTask>;
  /** The `serve` block as it is now; absent: no limit and no rule. A config that cannot be read throws. */
  serve?: () => Promise<ManualServe>;
  caller: Caller;
  /** `decisions.dialog` of the project config: a background agent cannot answer a dialog. */
  dialog: boolean;
  /** The project root: where a run without a worktree works. */
  root: string;
  worktreesDir?: string;
  now?: () => number;
}

export interface ManualStartInput {
  key: string;
  /** Absent: the `serve.start` rule's pipeline, else the only one, else `INVALID_ARGUMENTS` with the list. */
  pipeline?: string;
  /** Set by the path of the call (TUI: person/tui, web: person/web, manager: agent/manager). */
  by: Started["by"];
  via: Started["via"];
  /** What the agent says the person told it; kept in the journal only. */
  agentInstruction?: string;
  /**
   * `true`: go ahead of every warning. A list: only of those (what the person saw before they said yes);
   * a warning that is not in it is a new one and refuses. Never goes ahead of a hard refusal.
   */
  force?: boolean | readonly ForcedWarning[];
}

/** One warning, in words, with the places for `full`. */
export interface ManualWarning {
  why: ForcedWarning;
  reason: string;
  counts?: Extract<StartWarning, { why: "full" }>["counts"];
}

export type ManualRefusalWhy = ForcedWarning | "has_run" | "done" | "not_ready" | "agent_failed";

export type ManualStartResult =
  | {
      status: "started";
      run_id: string;
      agent: string;
      pipeline: string;
      task_key: string;
      /** The warnings that were present and were gone past. */
      forced?: ForcedWarning[];
    }
  | {
      status: "refused";
      why: ManualRefusalWhy;
      reason: string;
      counts?: ManualWarning["counts"];
      /** Every warning that fired, `why` being the first. */
      warnings?: ManualWarning[];
      hint?: string;
      /** `has_run`: the open run; `agent_failed`: the run that was made. */
      run_id?: string;
      /** The lock is held by another start: try again. */
      retry?: true;
    };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The words for a warning; `limit` names the `serve` key that is reached. */
export function warningOf(task: ServeTaskView, warning: StartWarning): ManualWarning {
  if (warning.why === "full") {
    const c = warning.counts;
    const reason =
      warning.limit === "max_runs"
        ? `serve.max_runs is reached: ${c.runs} of ${c.max_runs} runs are open`
        : `serve.max_workers is reached: ${c.workers} of ${c.max_workers} agents are working`;
    return { why: "full", reason, counts: c };
  }
  return { why: warning.why, reason: readinessWords(task, warning.links) };
}

const refuse = (
  why: ManualRefusalWhy,
  reason: string,
  extra: Partial<Extract<ManualStartResult, { status: "refused" }>> = {},
): ManualStartResult => ({ status: "refused", why, reason, ...extra });

const FORCE_HINT = "start it anyway with force: true, only if the person asked for that";

type Assessed =
  | { ok: false; result: ManualStartResult }
  | {
      ok: true;
      task: Extract<ManualTask, { status: "ready" }>;
      serve: ManualServe | undefined;
      pipelines: string[];
      warnings: { raw: StartWarning; words: ManualWarning }[];
      note?: string;
    };

/**
 * Reads what a start stands on and admits it: the task, the runs, the pipelines and the environment. Nothing
 * is written. The same reads run inside the lock for a start and outside it for the TUI's question.
 */
async function assess(deps: ManualStartDeps, key: string, unattended: boolean): Promise<Assessed> {
  const notReady = (reason: string): Assessed => ({
    ok: false,
    result: refuse("not_ready", reason),
  });
  const task = await deps.readTask(key);
  if (task.status === "missing") throw new KodelError("TASK_NOT_FOUND", `there is no task ${key}`);
  if (task.status === "failed") return notReady(`the task cannot be read: ${task.message}`);
  let serve: ManualServe | undefined;
  try {
    serve = await deps.serve?.();
  } catch (error) {
    return notReady(`the config does not load: ${messageOf(error)}`);
  }
  let gathered: Awaited<ReturnType<ReturnType<typeof createRunGatherer>["gather"]>>;
  try {
    gathered = await createRunGatherer({
      host: deps.host,
      launcher: {
        async statuses(runIds) {
          const out = new Map<string, ReturnType<typeof serveWorkerOf>>();
          for (const [runId, status] of await deps.launcher.statuses(runIds)) {
            out.set(runId, serveWorkerOf(status));
          }
          return out;
        },
      },
      now: deps.now ?? Date.now,
    }).gather();
  } catch (error) {
    return notReady(messageOf(error));
  }
  const admitted = admitStart({
    mode: "manual",
    task: task.view,
    runs: gathered.runs,
    unreadable: gathered.unreadable,
    unreadable_open: gathered.unreadableOpen,
    ...(serve === undefined
      ? {}
      : { limits: { max_workers: serve.max_workers, max_runs: serve.max_runs } }),
  });
  if (!admitted.ok) {
    if (admitted.why === "done") {
      return { ok: false, result: refuse("done", `the task is ${task.view.status}`) };
    }
    const run = admitted.run;
    return {
      ok: false,
      result: refuse(
        "has_run",
        run === undefined
          ? `${key} may have a run that cannot be read`
          : `${key} is already started: run ${run}`,
        run === undefined ? {} : { run_id: run },
      ),
    };
  }
  let listed: string[];
  let linked: boolean;
  try {
    listed = (await deps.host.list()).pipelines.map((p) => p.name);
    linked = (await deps.host.taskLink()) !== undefined;
  } catch (error) {
    return notReady(messageOf(error));
  }
  const check = await deps.launcher.preflight({
    dialog: deps.dialog,
    taskLink: linked,
    pipelines: listed.length,
    ...(deps.worktreesDir === undefined ? {} : { worktreesDir: deps.worktreesDir }),
    ...(unattended ? { unattended: true } : {}),
  });
  if (!check.ok) return notReady(check.reason);
  return {
    ok: true,
    task,
    serve,
    pipelines: listed,
    warnings: admitted.warnings.map((raw) => ({ raw, words: warningOf(task.view, raw) })),
    ...(check.note === undefined ? {} : { note: check.note }),
  };
}

/** Whether nobody would see a question the agent asks: every path but the TUI, where the person is at hand. */
const unattendedFor = (via: Started["via"]): boolean => via !== "tui";

/** What the TUI shows before it asks: the pipelines, what warns, and a note for the person. */
export type ManualCheck =
  | {
      ok: true;
      pipelines: string[];
      warnings: ManualWarning[];
      note?: string;
    }
  | { ok: false; result: Extract<ManualStartResult, { status: "refused" }> };

/**
 * The reads of a start without the lock and without any write: for a question that a person answers
 * (the TUI). The answer is not kept: `startManual` reads everything again under the lock.
 */
export async function checkManualStart(
  deps: ManualStartDeps,
  input: Pick<ManualStartInput, "key" | "via">,
): Promise<ManualCheck> {
  const found = await assess(deps, input.key, unattendedFor(input.via));
  if (!found.ok) {
    return { ok: false, result: found.result as Extract<ManualStartResult, { status: "refused" }> };
  }
  return {
    ok: true,
    pipelines: found.pipelines,
    warnings: found.warnings.map((w) => w.words),
    ...(found.note === undefined ? {} : { note: found.note }),
  };
}

function pipelineFor(
  task: ServeTaskView,
  asked: string | undefined,
  pipelines: readonly string[],
  serve: ManualServe | undefined,
): string {
  const refused = (message: string) =>
    new KodelError("INVALID_ARGUMENTS", message, [{ path: ["pipeline"], message }], {
      pipelines: [...pipelines],
    });
  if (asked !== undefined) {
    if (!pipelines.includes(asked)) throw refused(`there is no pipeline "${asked}"`);
    return asked;
  }
  const ruled = serve === undefined ? undefined : ruleFor(task, serve.start)?.pipeline;
  if (ruled !== undefined && pipelines.includes(ruled)) return ruled;
  const only = pipelines.length === 1 ? pipelines[0] : undefined;
  if (only !== undefined) return only;
  throw refused(
    pipelines.length === 0 ? "no pipeline loads" : `say which pipeline: ${pipelines.join(", ")}`,
  );
}

const forcedSet = (force: ManualStartInput["force"]): ((why: ForcedWarning) => boolean) => {
  if (force === true) return () => true;
  if (force === undefined || force === false) return () => false;
  return (why) => force.includes(why);
};

/**
 * Starts a task: the lock, then every read again, the admission, the run and its agent. Throws `KodelError`
 * `TASK_NOT_FOUND` for a task that is not there and `INVALID_ARGUMENTS` (the pipelines in `details`) when the
 * pipeline is not given and cannot be chosen; everything else is an answer.
 */
export async function startManual(
  deps: ManualStartDeps,
  input: ManualStartInput,
): Promise<ManualStartResult> {
  const lock = deps.host.withWorkerStartLock?.bind(deps.host);
  if (lock === undefined) {
    return refuse("not_ready", "the start lock is not available here, so no start is safe");
  }
  try {
    return await lock(() => startLocked(deps, input));
  } catch (error) {
    if (error instanceof KodelError && error.code === "STATE_LOCKED") {
      return refuse("not_ready", "another start is in progress", { retry: true });
    }
    throw error;
  }
}

async function startLocked(
  deps: ManualStartDeps,
  input: ManualStartInput,
): Promise<ManualStartResult> {
  const { key } = input;
  const found = await assess(deps, key, unattendedFor(input.via));
  if (!found.ok) return found.result;
  const { task, serve } = found;
  const pipeline = pipelineFor(task.view, input.pipeline, found.pipelines, serve);
  const allowed = forcedSet(input.force);
  const fresh = found.warnings.filter((w) => !allowed(w.raw.why));
  const head = fresh[0];
  if (head !== undefined) {
    return refuse(head.words.why, head.words.reason, {
      ...(head.words.counts === undefined ? {} : { counts: head.words.counts }),
      warnings: found.warnings.map((w) => w.words),
      hint: FORCE_HINT,
    });
  }
  const forced = found.warnings.map((w) => w.raw.why);
  const origin: RunOrigin = {
    by: input.by,
    via: input.via,
    ...(input.agentInstruction === undefined || input.agentInstruction === ""
      ? {}
      : { agent_instruction: input.agentInstruction }),
    ...(forced.length === 0 ? {} : { forced }),
  };
  let outcome: Awaited<ReturnType<ManualStartHost["start"]>>;
  try {
    outcome = await deps.host.start({
      pipeline,
      task: task.text,
      restart: true,
      task_key: key,
      title: task.title,
      caller: deps.caller,
      origin,
      // What nobody watches never runs a version the person has not committed.
      ...(input.via === "manager" || input.via === "web" ? { committed_only: true } : {}),
    });
  } catch (error) {
    if (error instanceof PipelineNotCommitted) {
      return refuse("not_ready", error.message);
    }
    if (error instanceof ChoiceNeeded) {
      return refuse(
        "not_ready",
        `the pipeline file ${error.choice.file} has changes that are not committed. Commit ${error.choice.file} or start the run from an agent`,
      );
    }
    return refuse("not_ready", messageOf(error));
  }
  const runId = outcome.run.runId;
  if (outcome.status !== "started") {
    return refuse("has_run", `${key} has a run already going: ${runId}`, { run_id: runId });
  }
  try {
    const { name } = await deps.launcher.start({
      runId,
      workdir: outcome.workdir?.path ?? deps.root,
      title: task.title,
      startedBy: { by: input.by, via: input.via },
    });
    return {
      status: "started",
      run_id: runId,
      agent: name,
      pipeline,
      task_key: key,
      ...(forced.length === 0 ? {} : { forced }),
    };
  } catch (error) {
    // The run stays and holds the task (`has_run`): any agent of the project continues it.
    return refuse(
      "agent_failed",
      `run ${runId} was made but no agent was started: ${messageOf(error)}`,
      {
        run_id: runId,
        hint: `continue it from a person's TUI with s on this run, or with any agent of the project: pipeline_next_step with run id ${runId}`,
      },
    );
  }
}
