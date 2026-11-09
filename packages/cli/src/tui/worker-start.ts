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
    task_key: string;
    caller: Caller;
  }): Promise<{
    status: "started" | "reused" | "terminal";
    run: { runId: string };
    workdir?: { path: string };
  }>;
  open(runId: string): Promise<LocalRun | StartRun | undefined>;
  runSummaries(): Promise<{ meta: { runId: string }; state: RunState | undefined }[]>;
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
}

/** The task text a run gets: the title, a blank line, the body; the title alone without a body. */
export function taskTextOf(card: { title: string; body?: string }): string {
  const body = card.body?.trim() ?? "";
  return body === "" ? card.title : `${card.title}\n\n${body}`;
}

/** The options of the loop that start and resume background agents. */
export function createWorkerOptions(
  input: WorkerOptionsInput,
): Pick<TuiOptions, "prepareStart" | "startTask" | "resumeWorker" | "workers"> {
  const { host, tasks, launcher } = input;
  const caller: Caller = { name: "kodel-tui", version: input.version };

  const prepareStart = async (key: string): Promise<StartCheck> => {
    const [link, listed] = await Promise.all([host.taskLink(), host.list()]);
    const pipelines = listed.pipelines.map((p) => p.name);
    const check = await launcher.preflight({
      dialog: input.dialog,
      taskLink: link !== undefined,
      pipelines: pipelines.length,
    });
    if (!check.ok) return { ok: false, message: `Could not start ${key}: ${check.reason}.` };
    return { ok: true, pipelines };
  };

  const startTask = async (key: string, pipeline: string): Promise<StartResult> => {
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
    let outcome: Awaited<ReturnType<StartHost["start"]>>;
    try {
      outcome = await host.start({
        pipeline,
        task: taskTextOf(card),
        restart: true,
        task_key: key,
        caller,
      });
    } catch (error) {
      if (error instanceof ChoiceNeeded) {
        return {
          ok: false,
          message: `Could not start ${key}: the pipeline file ${error.choice.file} has changes that are not committed. Commit ${error.choice.file} or start the run from an agent.`,
        };
      }
      return { ok: false, message: `Could not start ${key}: ${messageOf(error)}` };
    }
    const runId = outcome.run.runId;
    if (outcome.status !== "started") {
      return {
        ok: false,
        message: `${key} has a run already going: ${runId} (started outside the TUI).`,
      };
    }
    const workdir = outcome.workdir?.path ?? input.root;
    try {
      const { name } = await launcher.start({ runId, workdir, title: card.title });
      return { ok: true, runId, message: `Started ${key}: run ${runId} (agent ${name}).` };
    } catch (error) {
      // The run stays as it is: any agent of the project can continue it.
      return {
        ok: false,
        runId,
        message: `run ${runId} was made but no agent was started: ${messageOf(error)}. Any agent in the project continues it with pipeline_next_step and this run id.`,
      };
    }
  };

  const resumeWorker = async (
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
    const id = sessionId ?? (await launcher.statuses([runId])).get(runId)?.sessionId;
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

  return {
    prepareStart,
    startTask,
    resumeWorker,
    workers: { statuses: (ids) => launcher.statuses(ids), progress: (id) => launcher.progress(id) },
  };
}
