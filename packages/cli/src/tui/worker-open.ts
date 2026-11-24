/**
 * What the loop does for `o` (TASK-EKAV, T-47): the checks made while the screen still stands, and the
 * child that has the terminal while it is away. The child is `kodel agent attach <id> --keep-screen` with
 * the terminal inherited: the screen reads its input as text, and a terminal needs bytes. The flag keeps
 * the child on the alternate screen the TUI is on, so the shell behind is not seen while one program
 * hands the terminal to the other. A person's act, reached only from the key; kodel types nothing into
 * the session.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { plain } from "../plain";
import type { WorkerLauncher } from "../worker-launcher";
import type { AttachedChild, WorkerOpening } from "./run";
import { messageOf } from "./tasks-load";

/** Where this repository's build puts the CLI: what a screen that runs under Bun names. */
export const BUILT_KODEL = "packages/cli/dist/kodel.js";

/** How the child ended: its code, the signal that ended it, or why it never ran. */
export interface AttachExit {
  code: number | null;
  signal: string | null;
  error?: string;
}

/** The started child, as the screen needs it. */
export interface AttachProcess {
  exited: Promise<AttachExit>;
  kill(signal: NodeJS.Signals): void;
}

export interface OpenWorkerDeps {
  launcher: Pick<WorkerLauncher, "attachable" | "statuses" | "progress">;
  platform: string;
  /** The screen runs under Bun: the handover of the terminal is built and tested on Node only. */
  bun: boolean;
  /** This process, so the child is this very build. */
  self: { exec: string; args: string[] };
  root: string;
  environment: Record<string, string | undefined>;
  /** Why the child's program cannot be run, asked before the screen is left; nothing when it can. */
  runnable?: (file: string, args: readonly string[]) => Promise<string | undefined>;
  /** Starts the child with the terminal inherited. */
  spawn?: (
    file: string,
    args: readonly string[],
    environment: Record<string, string | undefined>,
  ) => AttachProcess;
}

const COULD_NOT = "Could not open the agent";

async function canRun(file: string, args: readonly string[]): Promise<string | undefined> {
  try {
    if (isAbsolute(file)) await access(file, constants.X_OK);
    const script = args[0];
    if (script !== undefined && isAbsolute(script)) await access(script, constants.R_OK);
    return undefined;
  } catch (error) {
    return messageOf(error);
  }
}

function spawnInherited(
  file: string,
  args: readonly string[],
  environment: Record<string, string | undefined>,
): AttachProcess {
  const proc = spawn(file, [...args], { stdio: "inherit", env: environment });
  const exited = new Promise<AttachExit>((resolve) => {
    proc.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
    proc.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    exited,
    kill: (signal) => {
      proc.kill(signal);
    },
  };
}

/** The `openWorker` of the loop. */
export function createOpenWorker(
  deps: OpenWorkerDeps,
): (runId: string, id: string) => Promise<WorkerOpening> {
  const { launcher } = deps;
  const runnable = deps.runnable ?? canRun;
  const start = deps.spawn ?? spawnInherited;

  /** The notice of the return: where the agent is now, in kodel's own words and never the child's. */
  const noticeOf = async (runId: string, id: string, end: AttachExit): Promise<string> => {
    if (end.error !== undefined) return `${COULD_NOT}: ${plain(end.error)}`;
    const latest = await launcher.statuses([runId]).then(
      (read) => read.get(runId),
      () => undefined,
    );
    const failed = end.code !== 0;
    if (latest === undefined || latest.state === "unknown") {
      return failed
        ? `${COULD_NOT} ${plain(id)}: the connection ended with an error; kodel agent ls shows its state.`
        : `Back from the agent ${plain(id)}.`;
    }
    const name = plain(latest.name);
    const live = latest.id === id && (latest.state === "running" || latest.state === "starting");
    if (!live) {
      return `Back: agent ${name} ended while you were in it (${plain(latest.label)}). An agent that ended at a wait is resumed after your decision; one you stop with kodel agent stop is resumed only by s here.`;
    }
    if (failed) {
      return `Back from ${name}: the connection ended with an error; the agent still runs (o opens it again).`;
    }
    const last = await launcher.progress(runId).then(
      (progress) => progress.lines.at(-1),
      () => undefined,
    );
    return last === undefined || last.trim() === ""
      ? `Back from ${name}; it still runs.`
      : `Back from ${name} · ${plain(last.trim())}`;
  };

  return async (runId, _id) => {
    if (deps.platform === "win32") {
      return { ok: false, message: `${COULD_NOT}: agents are not supported on Windows yet.` };
    }
    // The record is read again: the run's live one, also when that is `kw-<run>-d<seq>` by now.
    const found = await launcher.attachable(runId);
    if (!found.ok) return { ok: false, message: `${COULD_NOT}: ${plain(found.reason)}` };
    const id = found.id;
    if (deps.bun) {
      return {
        ok: false,
        message: `${COULD_NOT}: a TUI that runs under Bun does not hand its terminal over. In another terminal: node ${BUILT_KODEL} agent attach ${plain(id)}`,
      };
    }
    const args = [...deps.self.args, "--root", deps.root, "agent", "attach", id, "--keep-screen"];
    const problem = await runnable(deps.self.exec, args);
    if (problem !== undefined) {
      return { ok: false, message: `${COULD_NOT}: ${plain(problem)}` };
    }
    return {
      ok: true,
      attach: (): AttachedChild => {
        const proc = start(deps.self.exec, args, deps.environment);
        return {
          done: proc.exited.then((end) => noticeOf(runId, id, end)),
          signal: (signal) => proc.kill(signal),
        };
      },
    };
  };
}
