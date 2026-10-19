import { type PipelineHost, PipelineService } from "@kodel-ai/pipeline-core";
import { registerPipelineTools } from "@kodel-ai/pipeline-core/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** Build the MCP server for a host; the transport is the caller's. */
export function createServer(host: PipelineHost, version: string): McpServer {
  const server = new McpServer({ name: "kodel", version });
  registerPipelineTools(server, new PipelineService(host));
  return server;
}

/** Serve over stdio until the agent closes it. Nothing else may write to stdout meanwhile. */
export async function serveStdio(host: PipelineHost, version: string): Promise<void> {
  const server = createServer(host, version);
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
}
