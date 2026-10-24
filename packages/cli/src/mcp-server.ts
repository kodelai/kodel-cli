import { KILL_GRACE_MS } from "@kodel-ai/local";
import {
  type KodelError,
  type PipelineHost,
  PipelineService,
  type RunTaskLink,
  type TaskService,
} from "@kodel-ai/pipeline-core";
import {
  registerPipelineTools,
  registerTaskTools,
  serverInstructions,
  taskInstructions,
} from "@kodel-ai/pipeline-core/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** A host that can also stop the work it started (the local host does); it says how much it stopped. */
export type StoppableHost = PipelineHost & { stop?(): number };

/** A host for a server started outside a project: every tool answers with the same error. */
export function noProjectHost(error: KodelError): StoppableHost {
  const refuse = (): never => {
    throw error;
  };
  return { list: refuse, resolve: refuse, start: refuse, open: refuse };
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
  options: { waitHint?: boolean } = {},
): McpServer {
  const base = serverInstructions(options);
  const instructions = tasks
    ? `${base}\n\n${taskInstructions(runLink?.mode ?? "disabled", runLink !== undefined)}`
    : base;
  const server = new McpServer({ name: "kodel", version }, { instructions });
  registerPipelineTools(server, new PipelineService(host, { engineVersion: version }), {
    taskLink: tasks !== undefined && runLink !== undefined,
  });
  if (tasks) registerTaskTools(server, tasks);
  return server;
}

/**
 * Stop the commands the server is running and give them the moment they need to be gone: one that
 * ignores the polite request is killed after `KILL_GRACE_MS`, by a timer this process has to stay
 * alive for. Exiting at once would leave that command running with nobody to report to.
 */
async function stopAndWait(host: StoppableHost): Promise<void> {
  const stopped = host.stop?.() ?? 0;
  if (stopped > 0) await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS + 300));
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
  options: { waitHint?: boolean } = {},
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
