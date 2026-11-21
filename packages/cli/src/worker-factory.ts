/**
 * The one place the CLI builds the launcher of background workers (TASK-9PNS, TASK-G8KM T-44): `tui`
 * and `serve` both start their agents through what `openWorkerLauncher` returns, so a worker started
 * by the daemon is the same process, with the same lists and the same server, as one started with `s`.
 */
import { randomUUID } from "node:crypto";
import { openTaskService, resolveBase, type ServeLauncherPort } from "@kodel-ai/local";
import type { ServeWorkerView } from "@kodel-ai/pipeline-core/serve";
import { pipesAdapter } from "./agent-commands";
import type { WorkerLauncher, WorkerStatus } from "./worker-launcher";

export interface WorkerLauncherInput {
  root: string;
  /** The store root (`<root>/.kodel`): the tracker is opened from it for the names of the served tools. */
  dataDir: string;
  environment: Record<string, string | undefined>;
  /** This process, so the children and the worker's server are this very build. */
  self: { exec: string; args: string[] };
  platform?: string;
}

export async function openWorkerLauncher(input: WorkerLauncherInput): Promise<WorkerLauncher> {
  const { createSessionWorkerLauncher, execChild, findOnPath } = await import(
    "./worker-launcher-session"
  );
  const { buildTaskTools, HISTORY_TOOLS, toolsFor } = await import("@kodel-ai/pipeline-core/mcp");
  const { root, environment, self } = input;
  // The tools the worker's own server serves are what the worker may call.
  const opened = await openTaskService({ storeRoot: input.dataDir }).catch(() => undefined);
  const servedTools = [
    ...toolsFor({ taskLink: opened?.runLink !== undefined }).map((t) => t.name),
    ...HISTORY_TOOLS.map((t) => t.name),
    ...(opened === undefined ? [] : buildTaskTools(opened.service.capabilities).map((t) => t.name)),
  ];
  return createSessionWorkerLauncher({
    adapter: pipesAdapter({ root, environment, launcher: self, rules: [] }),
    self,
    root,
    stateBase: resolveBase(environment),
    environment,
    rules: [],
    servedTools,
    which: (name) => findOnPath(name, environment),
    exec: execChild,
    platform: input.platform ?? process.platform,
    clock: Date.now,
    uuid: () => randomUUID(),
  });
}

/** What the daemon reads of a worker: the record as the screen knows it, with its last output and whether a person stopped it. */
export function serveWorkerOf(status: WorkerStatus): ServeWorkerView {
  return {
    id: status.id,
    name: status.name,
    state: status.state,
    label: status.label,
    started: status.started,
    ...(status.since === undefined ? {} : { since: status.since }),
    ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
    ...(status.sessionId === undefined ? {} : { sessionId: status.sessionId }),
    resumed: [...status.resumed],
    resumes: status.resumes,
    ...(status.decisionSeq === undefined ? {} : { decisionSeq: status.decisionSeq }),
    ...(status.lastOutputAt === undefined ? {} : { lastOutputAt: status.lastOutputAt }),
    ...(status.stopped === true ? { stopped: true } : {}),
  };
}

/** The daemon's port over the CLI's launcher: the same calls, and nothing that reads logs or stops a worker. */
export function serveLauncherOf(launcher: WorkerLauncher): ServeLauncherPort {
  return {
    preflight: (input) => launcher.preflight(input),
    start: (input) => launcher.start(input),
    resume: (input) => launcher.resume(input),
    async statuses(runIds) {
      const out = new Map<string, ServeWorkerView>();
      for (const [runId, status] of await launcher.statuses(runIds)) {
        out.set(runId, serveWorkerOf(status));
      }
      return out;
    },
  };
}
