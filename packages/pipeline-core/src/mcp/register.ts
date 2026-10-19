/**
 * Putting the tools on an MCP server. The transport (stdio, HTTP), authentication and the choice of
 * SDK version belong to the host; this only says which tools exist and what each one does.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PipelineService } from "../service";
import { invokeTool, TOOLS } from "./tools";

export function registerPipelineTools(server: McpServer, service: PipelineService): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.shape,
        annotations: { readOnlyHint: tool.readOnly, idempotentHint: tool.idempotent },
      },
      (async (args: Record<string, unknown>) => {
        const result = await invokeTool(service, tool.name, args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          isError: !result.ok,
        };
      }) as never,
    );
  }
}
