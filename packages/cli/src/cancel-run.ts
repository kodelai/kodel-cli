/**
 * Cancelling a run (TASK-NE3N, TASK-KMPB): the one path that `kodel run cancel`, the web UI's button and
 * the manager's `manager_cancel_run` all take, so each ends a run the same way.
 *
 * The cancel is written first, under the run's lock: from then on the engine takes nothing more from a
 * worker of the run. The run's lock is let go, and only then are its agents stopped, under the start lock
 * that `kodel serve` and the TUI start and resume workers under (the store takes that lock before a run's
 * lock, never while holding one). A stop that fails leaves the run canceled and names the agent that is
 * left; a cancel of a run that is already canceled writes nothing and tries the stop again.
 *
 * `host.cancel()` itself stops nothing (T-42: a cancel ends the run, not the engine session of its step);
 * stopping the run's agents is what this command does on top of it.
 */
import {
  type AgentDecision,
  type Decision,
  KodelError,
  MAX_CANCEL_REASON,
} from "@kodel-ai/pipeline-core";
import { plain } from "./plain";

/** What the command needs of a run; `LocalRun` fits it. */
export interface CancelableRun {
  cancel(options: {
    reason?: string;
    byAgent?: AgentDecision;
  }): Promise<Decision & { warning?: string }>;
  location(): Promise<{ path: string; branch?: string } | undefined>;
  /** The root of another checkout that made the run, when it is not this one. */
  foreignRoot?(): Promise<string | undefined>;
}

export interface CancelPorts {
  /** The run, or `undefined` when there is none; throws `UNSUPPORTED_FORMAT` for a run this kodel cannot continue. */
  open(runId: string): Promise<CancelableRun | undefined>;
  withWorkerStartLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Ends every live background session of the run (`kw-<run>`, `kw-<run>-d<n>`); absent where none can be listed. */
  finishWorkers?(runId: string): Promise<void>;
  /** Stops one agent session by its id, as kodel's own end of it (the engine session of a step). */
  stopSession?(id: string): Promise<void>;
}

export interface CancelInput {
  runId: string;
  reason: string;
  /** The agent cancels on the person's instruction (a manager); absent for a person's own cancel. */
  byAgent?: AgentDecision;
}

export interface CancelAnswer {
  ok: true;
  run_id: string;
  status: "canceled";
  /** The run was already canceled: nothing was written, only the stop was tried again. */
  noop: boolean;
  task: { key: string; still_open: true } | null;
  branch?: string;
  worktree?: string;
  /** For the person to run when they no longer want the run's worktree and branch. */
  remove_commands: string[];
  /** Agents of the run that could not be stopped, with why; `kodel agent stop` ends them. */
  agents_left: string[];
  notes: string[];
}

export type CancelResult = CancelAnswer | { ok: false; error: KodelError };

/** A word for a POSIX shell: single-quoted unless it is plain. */
export function shellWord(text: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

const refused = (error: KodelError): CancelResult => ({ ok: false, error });

/** The reason as the commands and the tool take it: some words, not too many. */
export function checkReason(reason: string): KodelError | undefined {
  const text = reason.trim();
  if (text === "") return new KodelError("INVALID_ARGUMENTS", "a cancel needs a reason");
  if (text.length > MAX_CANCEL_REASON) {
    return new KodelError(
      "INVALID_ARGUMENTS",
      `the reason is longer than ${MAX_CANCEL_REASON} characters`,
    );
  }
  return undefined;
}

export async function cancelRun(ports: CancelPorts, input: CancelInput): Promise<CancelResult> {
  const bad = checkReason(input.reason);
  if (bad) return refused(bad);
  let run: CancelableRun | undefined;
  try {
    run = await ports.open(input.runId);
  } catch (error) {
    if (!(error instanceof KodelError)) throw error;
    if (error.code === "UNSUPPORTED_FORMAT" && /before pipelines were kept/.test(error.message)) {
      // No engine can decide anything about such a run, a cancel included; what it still blocks is
      // said by `kodel status`.
      return refused(
        new KodelError(
          "UNSUPPORTED_FORMAT",
          `run ${input.runId} was written before pipelines were kept in versions: no kodel can continue it, and it cannot be canceled either`,
        ),
      );
    }
    return refused(error);
  }
  if (!run) return refused(new KodelError("UNKNOWN_RUN", `there is no run ${plain(input.runId)}`));
  // An agent cancels only the runs of its own checkout; a person may cancel another clone's run.
  if (input.byAgent !== undefined) {
    const root = await run.foreignRoot?.();
    if (root !== undefined) {
      return refused(
        new KodelError(
          "WORKDIR_INVALID",
          `run ${plain(input.runId)} belongs to the checkout at ${plain(root)}; it is canceled from there, not from this one`,
        ),
      );
    }
  }
  const decision = await run.cancel({
    reason: input.reason.trim(),
    ...(input.byAgent === undefined ? {} : { byAgent: input.byAgent }),
  });
  if (!decision.ok) return refused(decision.error);
  if (decision.state.status !== "canceled") {
    // Ended otherwise between the look and the write: the host answers that, but never as canceled.
    return refused(
      new KodelError(
        "RUN_FINISHED",
        `run ${input.runId} has already ${decision.state.status}; a finished run cannot be canceled`,
      ),
    );
  }
  const notes: string[] = [];
  const left: string[] = [];
  // The run's lock was let go when `cancel` answered; the start lock is taken only now. The cancel is
  // written: a stop that cannot happen now (the start lock held past its wait by a start or a resume,
  // say) leaves the run canceled and is named, never answered as a failed cancel.
  try {
    await ports.withWorkerStartLock(async () => {
      if (ports.finishWorkers) {
        try {
          await ports.finishWorkers(input.runId);
        } catch (error) {
          left.push(
            `the background agent of the run (kw-${input.runId}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        notes.push(
          `the background agents of the run were not looked at here; kodel agent ls lists any kw-${input.runId} still running`,
        );
      }
      const engine = decision.state.engineSession;
      if (engine === undefined) return;
      if (engine.id === undefined || ports.stopSession === undefined) {
        left.push(
          `the engine session of step "${engine.node}"${engine.id === undefined ? ` (${engine.name}, not recorded as started)` : ` ${engine.id}`}`,
        );
        return;
      }
      try {
        await ports.stopSession(engine.id);
      } catch (error) {
        left.push(
          `the engine session ${engine.id} of step "${engine.node}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  } catch (error) {
    left.push(
      `the agents of the run were not stopped (${error instanceof Error ? error.message : String(error)}); cancel the run again to try once more`,
    );
  }
  const where = await run.location().catch(() => undefined);
  const remove: string[] = [];
  if (where !== undefined) remove.push(`git worktree remove ${shellWord(where.path)}`);
  if (where?.branch !== undefined) remove.push(`git branch -d ${shellWord(where.branch)}`);
  const key = decision.state.taskKey;
  return {
    ok: true,
    run_id: input.runId,
    status: "canceled",
    noop: decision.noop === true,
    task: key === undefined ? null : { key, still_open: true },
    ...(where?.branch === undefined ? {} : { branch: where.branch }),
    ...(where === undefined ? {} : { worktree: where.path }),
    remove_commands: remove,
    agents_left: left,
    notes,
  };
}

/** What `kodel run cancel` prints after the cancel, one fact a line. */
export function cancelLines(answer: CancelAnswer): string[] {
  const lines = [
    answer.noop ? `run ${answer.run_id} was already canceled` : `canceled ${answer.run_id}`,
  ];
  if (answer.task) {
    lines.push(
      `task ${answer.task.key} is still open (kodel task set ${answer.task.key} --status <status> moves it)`,
    );
  }
  if (answer.branch !== undefined) lines.push(`branch ${answer.branch}`);
  if (answer.worktree !== undefined) lines.push(`worktree ${answer.worktree}`);
  for (const command of answer.remove_commands) lines.push(`remove: ${command}`);
  for (const agent of answer.agents_left) {
    lines.push(`agent left running: ${agent}; stop it with kodel agent stop`);
  }
  for (const note of answer.notes) lines.push(note);
  return lines;
}
