/**
 * What the loop does for `s` (TASK-9PNS): the preflight and the pipelines for the question, the start
 * (the task read again, the run through the host, then the agent through the launcher) and the resume
 * (the decision read again from the journal, then the launcher). A person's acts, reached only from the
 * confirmed questions of the screen; nothing here is agent-callable.
 */
import type { LocalRun } from "@kodel-ai/local";
import type { Caller } from "@kodel-ai/pipeline-core";
import {
  ChoiceNeeded,
  type JournalRecord,
  KodelError,
  type RunState,
  SessionError,
} from "@kodel-ai/pipeline-core";
import type { WorkerLauncher } from "../worker-launcher";
import type { StartCheck, StartResult, TuiOptions } from "./run";
import { loadTask, messageOf, type TasksHandle } from "./tasks-load";
import { decisionOf } from "./worker-resume";

/** The part of a run the start and the resume read; `LocalRun` fits it. */
export interface StartRun {
  readonly runId: string;
  journal(): Promise<JournalRecord[]>;
  state(): Promise<RunState>;
  location(): Promise<{ path: string } | undefined>;
  inProject(worktree: string): Promise<string>;
}

/** The part of the host the start uses; `LocalPipelineHost` fits it. */
export interface StartHost {
  list(): Promise<{ pipelines: { name: string }[] }>;
  taskLink(): Promise<unknown>;
  start(input: {
    pipeline: string;
    task: string;
    restart: boolean;
    task_key?: string;
    caller: Caller;
  }): Promise<{
    status: "started" | "reused" | "terminal";
    run: { runId: string };
    workdir?: { path: string };
  }>;
  open(runId: string): Promise<LocalRun | StartRun | undefined>;
  runSummaries(): Promise<
    { meta: { runId: string; root?: string }; state: RunState | undefined }[]
  >;
  /** The root of another checkout that made the run, when it is not this one. */
  foreignRootOf?(meta: { runId: string; root?: string }): string | undefined;
  /**
   * The lock `kodel serve` takes around its starts (TASK-G8KM, T-44), so the two never start one task
   * twice; throws `STATE_LOCKED` after a wait. A host without it starts without the lock.
   */
  withWorkerStartLock?<T>(fn: () => Promise<T>): Promise<T>;
}

export interface WorkerOptionsInput {
  host: StartHost;
  tasks: TasksHandle;
  launcher: WorkerLauncher;
  /** `decisions.dialog` of the project config: a background agent cannot answer a dialog. */
  dialog: boolean;
  /** The project root: where a run without a worktree works. */
  root: string;
  /** This build's version, for `caller`. */
  version: string;
  /** The folder the worktrees of the runs are made in, for the launcher's trust probe. */
  worktreesDir?: string;
}

/** The task text a run gets: the title, a blank line, the body; the title alone without a body. */
export function taskTextOf(card: { title: string; body?: string }): string {
  const body = card.body?.trim() ?? "";
  return body === "" ? card.title : `${card.title}\n\n${body}`;
}

export interface LaunchRunInput {
  host: Pick<StartHost, "start">;
  launcher: Pick<WorkerLauncher, "start">;
  /** The project root: where a run without a worktree works. */
  root: string;
  caller: Caller;
  pipeline: string;
  /** The task's text, as the run gets it. */
  task: string;
  /** What the agent's first prompt calls the task. */
  title: string;
  /** What the messages call the thing started: a task's key, or words for a run with no task. */
  subject: string;
  /** Absent for a run with no task (`kodel agent start --pipeline`): nothing is written to a tracker. */
  taskKey?: string;
}

/**
 * The launch half of every start by a person: the run through the host, then its agent through the one
 * launcher. The caller holds the start lock. A run that was made stays when its agent could not be
 * started: any agent of the project continues it.
 */
export async function launchRun(input: LaunchRunInput): Promise<StartResult & { agent?: string }> {
  const { host, launcher, subject } = input;
  let outcome: Awaited<ReturnType<StartHost["start"]>>;
  try {
    outcome = await host.start({
      pipeline: input.pipeline,
      task: input.task,
      restart: true,
      ...(input.taskKey === undefined ? {} : { task_key: input.taskKey }),
      caller: input.caller,
    });
  } catch (error) {
    if (error instanceof ChoiceNeeded) {
      return {
        ok: false,
        message: `Could not start ${subject}: the pipeline file ${error.choice.file} has changes that are not committed. Commit ${error.choice.file} or start the run from an agent.`,
      };
    }
    return { ok: false, message: `Could not start ${subject}: ${messageOf(error)}` };
  }
  const runId = outcome.run.runId;
  if (outcome.status !== "started") {
    return {
      ok: false,
      message:
        input.taskKey === undefined
          ? `Could not start ${subject}: a run with this very task is already going: ${runId} (kodel status ${runId}).`
          : `${subject} has a run already going: ${runId} (started outside the TUI).`,
    };
  }
  const workdir = outcome.workdir?.path ?? input.root;
  try {
    const { name } = await launcher.start({ runId, workdir, title: input.title });
    return {
      ok: true,
      runId,
      agent: name,
      message: `Started ${subject}: run ${runId} (agent ${name}).`,
    };
  } catch (error) {
    // The run stays as it is: any agent of the project can continue it.
    return {
      ok: false,
      runId,
      message: `run ${runId} was made but no agent was started: ${messageOf(error)}. Any agent in the project continues it with pipeline_next_step and this run id.`,
    };
  }
}

/** The options of the loop that start and resume background agents. */
export function createWorkerOptions(
  input: WorkerOptionsInput,
): Pick<TuiOptions, "prepareStart" | "startTask" | "resumeWorker" | "workers" | "finishWorker"> {
  const { host, tasks, launcher } = input;
  const caller: Caller = { name: "kodel-tui", version: input.version };

  const prepareStart = async (key: string): Promise<StartCheck> => {
    const [link, listed] = await Promise.all([host.taskLink(), host.list()]);
    const pipelines = listed.pipelines.map((p) => p.name);
    const check = await launcher.preflight({
      dialog: input.dialog,
      taskLink: link !== undefined,
      pipelines: pipelines.length,
      ...(input.worktreesDir === undefined ? {} : { worktreesDir: input.worktreesDir }),
    });
    if (!check.ok) {
      return {
        ok: false,
        message: `Could not start ${key}: ${check.reason}.`,
        reason: check.reason,
      };
    }
    // What a person's start is told once though it may go on (a folder whose trust is not known).
    return { ok: true, pipelines, ...(check.note === undefined ? {} : { note: check.note }) };
  };

  const startLocked = async (key: string, pipeline: string): Promise<StartResult> => {
    // Read again: the question may have stood on the screen for a while.
    const slot = await loadTask(tasks, key);
    if (slot.status !== "ready") {
      const why = slot.status === "failed" ? slot.message : "the task cannot be read";
      return { ok: false, message: `Could not start ${key}: ${why}.` };
    }
    const { card } = slot;
    if (card.state === "done") {
      return { ok: false, message: `Could not start ${key}: the task is ${card.status}.` };
    }
    const active = (await host.runSummaries()).find(
      (s) =>
        s.state?.taskKey === key && (s.state.status === "running" || s.state.status === "paused"),
    );
    if (active) {
      return { ok: false, message: `${key} is already started: run ${active.meta.runId}.` };
    }
    const { agent: _agent, ...result } = await launchRun({
      host,
      launcher,
      root: input.root,
      caller,
      pipeline,
      task: taskTextOf(card),
      title: card.title,
      subject: key,
      taskKey: key,
    });
    return result;
  };

  // From the check that the task is not started to the agent's launch, under the daemon's lock.
  const startTask = async (key: string, pipeline: string): Promise<StartResult> => {
    if (host.withWorkerStartLock === undefined) return startLocked(key, pipeline);
    try {
      return await host.withWorkerStartLock(() => startLocked(key, pipeline));
    } catch (error) {
      if (error instanceof KodelError && error.code === "STATE_LOCKED") {
        return {
          ok: false,
          message: `Could not start ${key}: another start is in progress, try again.`,
        };
      }
      throw error;
    }
  };

  const resumeLocked = async (
    runId: string,
    seq: number,
    sessionId?: string,
  ): Promise<StartResult> => {
    const notResumed = (why: string) => `run ${runId} was not resumed: ${why}`;
    const run = await host.open(runId);
    if (!run) return { ok: false, message: notResumed("the run is gone.") };
    // The decision is read again from the journal: the question is about this one and no other.
    const { decision } = decisionOf(await run.journal());
    if (decision === undefined || decision.seq !== seq) {
      return { ok: false, message: notResumed("the run moved on.") };
    }
    // The records too, under the lock: the daemon may have resumed it, or the agent went on by itself.
    const now = (await launcher.statuses([runId])).get(runId);
    if (now !== undefined && (now.state === "starting" || now.state === "running")) {
      return { ok: false, message: notResumed(`its agent ${now.name} is alive (kodel agent ls).`) };
    }
    const id = now?.sessionId ?? sessionId;
    if (id === undefined) return { ok: false, message: notResumed("no session id is known.") };
    const located = await run.location();
    const workdir = located === undefined ? input.root : await run.inProject(located.path);
    try {
      const { name } = await launcher.resume({ runId, workdir, sessionId: id, decision });
      return { ok: true, runId, message: `Resumed the agent of ${runId} as ${name}.` };
    } catch (error) {
      if (error instanceof SessionError && error.code === "NAME_TAKEN") {
        return { ok: false, message: notResumed("already resumed (kodel agent ls).") };
      }
      return {
        ok: false,
        message: `${notResumed(messageOf(error))}. Any agent in the project continues it with pipeline_next_step and this run id.`,
      };
    }
  };

  // Under the lock the daemon takes for its starts and resumes: one of the two resumes a decision.
  const resumeWorker = async (
    runId: string,
    seq: number,
    sessionId?: string,
  ): Promise<StartResult> => {
    if (host.withWorkerStartLock === undefined) return resumeLocked(runId, seq, sessionId);
    try {
      return await host.withWorkerStartLock(() => resumeLocked(runId, seq, sessionId));
    } catch (error) {
      if (error instanceof KodelError && error.code === "STATE_LOCKED") {
        return {
          ok: false,
          message: `run ${runId} was not resumed: another start is in progress, try again.`,
        };
      }
      throw error;
    }
  };

  /** Whether the run is one of this checkout that has ended, as read now. */
  const endedHere = async (runId: string): Promise<boolean> => {
    const found = (await host.runSummaries()).find((s) => s.meta.runId === runId);
    if (found === undefined || host.foreignRootOf?.(found.meta) !== undefined) return false;
    const status = found.state?.status;
    return status === "completed" || status === "failed" || status === "canceled";
  };

  // The daemon's `finish`, for when none is active: under the same lock, the state and the records
  // read again inside it. A run that cannot be read, or another checkout's, is never touched.
  const finishWorker = async (runId: string): Promise<void> => {
    const finishLocked = async () => {
      if (await endedHere(runId)) await launcher.finish(runId);
    };
    if (host.withWorkerStartLock === undefined) return finishLocked();
    try {
      await host.withWorkerStartLock(finishLocked);
    } catch (error) {
      // Another start holds the lock: the next read of the records asks again.
      if (error instanceof KodelError && error.code === "STATE_LOCKED") return;
      throw error;
    }
  };

  return {
    prepareStart,
    startTask,
    resumeWorker,
    finishWorker,
    workers: { statuses: (ids) => launcher.statuses(ids), progress: (id) => launcher.progress(id) },
  };
}
