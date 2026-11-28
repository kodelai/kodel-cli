/**
 * The stop of a run's agent by request (not by a person's `kodel agent stop`): the one function that the
 * manager's `manager_stop_agent` and the web UI's Stop button call. It takes the start lock (a stop and a
 * start or resume of the same agent never run together), reads the run and the records again inside it
 * (a resume by the daemon may have made a newer record since the caller last looked), and leaves the
 * person's stop record with the note that a manager's server asked. Nothing is cancelled: the run stays
 * open (TASK-9JTV is the cancel).
 */
import { KodelError, SessionError } from "@kodel-ai/pipeline-core";
import type { WorkerLauncher, WorkerStatus } from "./worker-launcher";

/** The part of the host a stop uses; `LocalPipelineHost` fits it. */
export interface ManualStopHost {
  runSummaries(): Promise<
    { meta: { runId: string; root?: string }; state: { status: string } | undefined }[]
  >;
  /** The root of another checkout a run belongs to; such a run is never touched. */
  foreignRootOf?(meta: { runId: string; root?: string }): string | undefined;
  open(
    runId: string,
  ): Promise<
    { noteAgentStopped(input: { instruction?: string }): Promise<{ written: boolean }> } | undefined
  >;
  withWorkerStartLock?<T>(fn: () => Promise<T>): Promise<T>;
}

export interface ManualStopDeps {
  host: ManualStopHost;
  launcher: Pick<WorkerLauncher, "statuses" | "stop">;
}

export interface ManualStopInput {
  runId: string;
  /**
   * Set by the path of the call: `agent` (the manager's tool) leaves the event `agent_stopped` in the
   * journal; `person` (the web button) leaves nothing there, the person's own click is the record.
   */
  by: "person" | "agent";
  /** What the agent says the person told it; kept in the journal event only, never in the session record. */
  instruction?: string;
}

export type ManualStopWhy =
  | "unknown_run"
  | "foreign_checkout"
  | "run_over"
  | "no_agent"
  | "agent_unreadable"
  | "already_stopped"
  | "starting"
  | "busy"
  | "no_lock"
  | "identity_unknown"
  | "not_stopped";

export type ManualStopResult =
  | {
      status: "stopped";
      agent: string;
      run_id: string;
      note: string;
      /** The event `agent_stopped` is in the journal. */
      journaled: boolean;
    }
  | {
      status: "refused";
      why: ManualStopWhy;
      reason: string;
      run_id: string;
      /** Nothing was changed and the same call may work in a moment. */
      retry?: true;
    };

const isLive = (status: WorkerStatus): boolean =>
  status.state === "starting" || status.state === "running";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const ENDED = ["completed", "failed", "canceled"];

/**
 * What the caller is told after a stop: the run stays, and how it goes on. An agent that had already ended
 * at a wait is known to have been waiting; a live one may have been at work or at a wait, so both ways are named.
 */
export function stopNote(wasLive: boolean): string {
  const atWait =
    "if it was waiting for a decision: after the person decides, s in kodel tui starts it again";
  const atWork =
    "if it was at work: any agent of the project goes on with the run through pipeline_next_step with this run id, and it no longer takes a place of serve.max_runs";
  return [
    "the run is still open with its task, and holds the tasks that conflict with it; nothing was cancelled (cancel is TASK-9JTV)",
    wasLive ? `${atWait}; ${atWork}` : atWait,
    "kodel agent start --resume does not continue a stopped agent",
    "a terminal a person had attached to the agent was closed with it",
  ].join(". ");
}

/**
 * Stops the latest agent record of a run (`kw-<run>`). Every refusal is an answer; only a failure the
 * caller cannot act on is thrown. The record of the stop is always the person's (`via: manager` is a note
 * on it), so the daemon, the TUI's auto-resume and an older build never start the agent again.
 */
export async function stopRunAgent(
  deps: ManualStopDeps,
  input: ManualStopInput,
): Promise<ManualStopResult> {
  const { runId } = input;
  const refuse = (why: ManualStopWhy, reason: string, retry?: true): ManualStopResult => ({
    status: "refused",
    why,
    reason,
    run_id: runId,
    ...(retry === undefined ? {} : { retry }),
  });
  const lock = deps.host.withWorkerStartLock?.bind(deps.host);
  if (lock === undefined) {
    return refuse("no_lock", "the start lock is not available here, so no stop is safe");
  }
  try {
    return await lock(() => stopLocked(deps, input, refuse));
  } catch (error) {
    if (error instanceof KodelError && error.code === "STATE_LOCKED") {
      return refuse("busy", "another start or stop is in progress", true);
    }
    throw error;
  }
}

async function stopLocked(
  deps: ManualStopDeps,
  input: ManualStopInput,
  refuse: (why: ManualStopWhy, reason: string, retry?: true) => ManualStopResult,
): Promise<ManualStopResult> {
  const { runId } = input;
  const found = (await deps.host.runSummaries()).find((s) => s.meta.runId === runId);
  if (found === undefined) return refuse("unknown_run", `there is no run ${runId}`);
  if (deps.host.foreignRootOf?.(found.meta) !== undefined) {
    return refuse("foreign_checkout", `run ${runId} belongs to another checkout of the project`);
  }
  const runStatus = found.state?.status;
  if (runStatus !== undefined && ENDED.includes(runStatus)) {
    return refuse(
      "run_over",
      `run ${runId} is ${runStatus}: its agent is ended by kodel, and no event was written`,
    );
  }
  // Read now, not from what a screen remembers: the records may have a newer one since.
  const latest = (await deps.launcher.statuses([runId])).get(runId);
  if (latest === undefined) return refuse("no_agent", `run ${runId} has no agent of kodel`);
  if (latest.state === "unknown") {
    return refuse("agent_unreadable", `the record of the agent of ${runId} cannot be read`);
  }
  if (latest.state === "starting") {
    return refuse("starting", `${latest.name} is still starting; try again in a moment`, true);
  }
  if (latest.stopped === true) {
    return refuse("already_stopped", `${latest.name} is already stopped`);
  }
  const live = isLive(latest);
  try {
    // The record is the person's either way; the note says which door the stop came through.
    await deps.launcher.stop(runId, input.by === "agent" ? "manager" : "web");
  } catch (error) {
    if (error instanceof SessionError && error.code === "IDENTITY_UNKNOWN") {
      return refuse("identity_unknown", `${latest.name} was not signalled: ${error.message}`);
    }
    return refuse("not_stopped", `${latest.name} was not stopped: ${messageOf(error)}`);
  }
  const after = (await deps.launcher.statuses([runId])).get(runId);
  if (after !== undefined && after.state === "starting") {
    return refuse("starting", `${after.name} was still starting; try again in a moment`, true);
  }
  if (after === undefined || after.state === "unknown" || after.stopped !== true) {
    return refuse("not_stopped", `${latest.name} was not recorded as stopped`);
  }
  let journaled = false;
  let journalNote: string | undefined;
  if (input.by === "agent") {
    try {
      const run = await deps.host.open(runId);
      const wrote =
        run === undefined
          ? undefined
          : await run.noteAgentStopped(
              input.instruction === undefined || input.instruction === ""
                ? {}
                : { instruction: input.instruction },
            );
      journaled = wrote?.written === true;
      if (!journaled) journalNote = "no event was written to the journal of the run";
    } catch (error) {
      journalNote = `the event was not written to the journal: ${messageOf(error)}`;
    }
  }
  const note = stopNote(live);
  return {
    status: "stopped",
    agent: after.name,
    run_id: runId,
    note: journalNote === undefined ? note : `${note}; ${journalNote}`,
    journaled,
  };
}
