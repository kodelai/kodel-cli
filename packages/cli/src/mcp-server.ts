import { KILL_GRACE_MS } from "@kodel-ai/local";
import {
  type KodelError,
  type PipelineHost,
  PipelineService,
  type RunTaskLink,
  type TaskService,
  toolsFingerprint,
} from "@kodel-ai/pipeline-core";
import {
  CONTRACT_VERSION,
  decisionTools,
  registerPipelineTools,
  registerTaskTools,
  serverInstructions,
  taskInstructions,
  toolsFor,
} from "@kodel-ai/pipeline-core/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentDecider } from "./agent-decisions";
import { createElicitor, type HumanHost, newDialogState } from "./elicit";

/** A host that can also stop the work it started (the local host does); it says how much it stopped. */
export type StoppableHost = PipelineHost & {
  stop?(): number;
  /** Wait for what the host still writes about its runs, but no longer than the given milliseconds. */
  settle?(ms: number): Promise<void>;
};

/** How long leaving the server waits for the changes of a run that has just ended to be recorded. */
export const SHUTDOWN_SETTLE_MS = 30_000;

/** A host for a server started outside a project: every tool answers with the same error. */
export function noProjectHost(error: KodelError): StoppableHost {
  const refuse = (): never => {
    throw error;
  };
  return { list: refuse, resolve: refuse, start: refuse, open: refuse };
}

/**
 * How long a dialog may stay open, from `KODEL_DIALOG_TIMEOUT_S` in the server's environment: for a
 * client that gives up on a call sooner than the default. Anything but a positive number of seconds
 * leaves the default.
 */
export function dialogTimeoutFrom(
  environment: Record<string, string | undefined> | undefined,
): number | undefined {
  const raw = environment?.["KODEL_DIALOG_TIMEOUT_S"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
}

export interface ServerOptions {
  /** Whether the answers offer the agent `kodel wait` (the project config can turn it off). */
  waitHint?: boolean;
  /**
   * A host that can decide for a person (the local one). With `dialog`, a client that can show a
   * form is asked there at a gate, a pause, a change of the pipeline and a state changed outside
   * kodel; a client that cannot is answered as before. Without `dialog` the person decides with the
   * commands, and the agent decides only what `agentDecisions` lets it.
   */
  humans?: HumanHost;
  /** Whether `humans` is asked through the client (`decisions.dialog`); off unless the config says so. */
  dialog?: boolean;
  /** What the config lets the agent decide on the person's instruction; needs `humans`. */
  agentDecisions?: { gate?: boolean; pipelineChange?: boolean };
  /** How long a dialog may stay open, in milliseconds; the default is long enough to read the changes. */
  dialogTimeoutMs?: number;
}

/**
 * Build the MCP server for a host; the transport is the caller's. The task tools and their part of
 * the instructions are there only when `tasks` is given (the config turned them on): with tasks
 * off the agent is told nothing about them. `runLink` (the config asks for runs to be tied to tasks)
 * adds `task_key` to pipeline_start and the rule about it to the instructions.
 */
export function createServer(
  host: PipelineHost,
  version: string,
  tasks?: TaskService,
  runLink?: RunTaskLink,
  options: ServerOptions = {},
): McpServer {
  const { humans } = options;
  const dialog = humans !== undefined && options.dialog === true;
  // Without a host that can decide there is nothing for the agent's tools to do, so none is served.
  const agentDecisions = humans === undefined ? {} : (options.agentDecisions ?? {});
  const base = serverInstructions({ ...options, dialog, decisions: agentDecisions });
  const instructions = tasks
    ? `${base}\n\n${taskInstructions(runLink?.mode ?? "disabled", runLink !== undefined)}`
    : base;
  const server = new McpServer({ name: "kodel", version }, { instructions });
  const taskLink = tasks !== undefined && runLink !== undefined;
  const state = newDialogState();
  const decisions = humans ? decisionTools(agentDecisions, createAgentDecider(humans, state)) : [];
  const service = new PipelineService(host, {
    engineVersion: version,
    // Asked at each call: the client's name comes with the handshake, after the server is built.
    caller: () => {
      const client = server.server.getClientVersion();
      return client === undefined ? undefined : { name: client.name, version: client.version };
    },
    surface: {
      instructions,
      tools: toolsFingerprint([...toolsFor({ taskLink }), ...decisions]),
      contract_version: CONTRACT_VERSION,
    },
  });
  registerPipelineTools(server, service, {
    taskLink,
    ...(humans && dialog
      ? {
          afterTool: createElicitor(server.server, humans, service, {
            state,
            ...(options.dialogTimeoutMs === undefined
              ? {}
              : { timeoutMs: options.dialogTimeoutMs }),
          }),
        }
      : {}),
    extraTools: decisions,
  });
  if (tasks) registerTaskTools(server, tasks);
  return server;
}

/**
 * Stop the commands the server is running and give them the moment they need to be gone: one that
 * ignores the polite request is killed after `KILL_GRACE_MS`, by a timer this process has to stay
 * alive for. Exiting at once would leave that command running with nobody to report to.
 */
export async function stopAndWait(
  host: StoppableHost,
  settleMs = SHUTDOWN_SETTLE_MS,
): Promise<void> {
  const stopped = host.stop?.() ?? 0;
  if (stopped > 0) await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS + 300));
  // The patch of a run that just ended is written in the background; leaving now would cut it off.
  // Bounded twice: the host stops waiting at the deadline, and a host that does not is not waited for.
  if (host.settle) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, settleMs + 1_000);
    });
    try {
      await Promise.race([host.settle(settleMs).catch(() => undefined), late]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Serve over stdio until the agent closes it. Nothing else may write to stdout meanwhile. However
 * the server ends (the agent closes the pipe, or the process is told to stop), the commands it was
 * running are stopped with it; the next session starts them again.
 */
export async function serveStdio(
  host: StoppableHost,
  version: string,
  tasks?: TaskService,
  runLink?: RunTaskLink,
  options: ServerOptions = {},
): Promise<void> {
  const server = createServer(host, version, tasks, runLink, options);
  await server.connect(new StdioServerTransport());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stopAndWait(host).then(() => process.exit(0));
    });
  }
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
    // The SDK does not count the agent's end of the pipe closing as the server closing, so a server
    // whose agent was killed outright would otherwise run for ever.
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  await stopAndWait(host);
}
