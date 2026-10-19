import { type PipelineHost, PipelineService } from "@kodel-ai/pipeline-core";
import { registerPipelineTools } from "@kodel-ai/pipeline-core/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** A host that can also stop the work it started (the local host does). */
export type StoppableHost = PipelineHost & { stop?(): void };

/** Build the MCP server for a host; the transport is the caller's. */
export function createServer(host: PipelineHost, version: string): McpServer {
  const server = new McpServer({ name: "kodel", version });
  registerPipelineTools(server, new PipelineService(host));
  return server;
}

/**
 * Serve over stdio until the agent closes it. Nothing else may write to stdout meanwhile. However
 * the server ends (the agent closes the pipe, or the process is told to stop), the commands it was
 * running are stopped with it; the next session starts them again.
 */
export async function serveStdio(host: StoppableHost, version: string): Promise<void> {
  const server = createServer(host, version);
  await server.connect(new StdioServerTransport());
  const stop = () => host.stop?.();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stop();
      process.exit(0);
    });
  }
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  stop();
}
