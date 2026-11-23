/**
 * The one place the CLI builds the launcher of background workers (TASK-9PNS, TASK-G8KM T-44): `tui`
 * and `serve` both start their agents through what `openWorkerLauncher` returns, so a worker started
 * by the daemon is the same process, with the same lists and the same server, as one started with `s`.
 */
import { randomUUID } from "node:crypto";
import {
  loadMcpRoles,
  openTaskService,
  resolveBase,
  type ServeLauncherPort,
} from "@kodel-ai/local";
import { KodelError, resolveToolSet } from "@kodel-ai/pipeline-core";
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

/**
 * The tools the worker's own server (`kodel mcp --role worker`) serves, which are what the worker may
 * call: worked out the way that server does it, from the config as it is now. A tracker that cannot be
 * opened only drops the task tools, as in the server; an `mcp` block that cannot be used throws
 * (`CONFIG_INVALID`), as the server would not start.
 */
export async function workerServedTools(dataDir: string): Promise<string[]> {
  const { buildTaskTools, HISTORY_TOOLS, MANAGER_TOOLS, toolsFor } = await import(
    "@kodel-ai/pipeline-core/mcp"
  );
  const overrides = await loadMcpRoles(dataDir);
  const opened = await openTaskService({ storeRoot: dataDir }).catch(() => undefined);
  const resolved = resolveToolSet({
    role: "worker",
    overrides,
    available: [
      // Attachments included, as the local host keeps them: a worker that could not call their tools
      // could never satisfy an `attachment` check.
      ...toolsFor({ taskLink: opened?.runLink !== undefined, attachments: true }),
      ...HISTORY_TOOLS,
      ...MANAGER_TOOLS,
      ...(opened === undefined ? [] : buildTaskTools(opened.service.capabilities)),
    ],
  });
  if (resolved.refused !== undefined) throw new KodelError("CONFIG_INVALID", resolved.refused);
  return resolved.names;
}

export async function openWorkerLauncher(input: WorkerLauncherInput): Promise<WorkerLauncher> {
  const { createSessionWorkerLauncher, execChild, findOnPath } = await import(
    "./worker-launcher-session"
  );
  const { root, environment, self } = input;
  // Asked again at every start and resume: the list is what the config says at that moment.
  const servedTools = () => workerServedTools(input.dataDir);
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
