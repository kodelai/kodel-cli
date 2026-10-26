/**
 * Putting the tools on an MCP server. The transport (stdio, HTTP), authentication and the choice of
 * SDK version belong to the host; this only says which tools exist and what each one does.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PipelineService, ToolResult } from "../service";
import { invokeTool, type ToolDescriptor, toolsFor } from "./tools";

/** A tool call that has been answered, as the host sees it before the agent does. */
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  result: ToolResult;
  /** Aborted when the client cancels the call or closes the connection. */
  signal: AbortSignal;
}

/**
 * Lets a host change the answer to the agent after a tool ran, for example to ask the person
 * something through the client first. It returns the answer to send instead, or nothing to send the
 * original. A hook that throws is as good as nothing: the original answer is sent.
 */
export type AfterTool = (call: ToolCall) => Promise<ToolResult | undefined>;

export interface RegisterOptions {
  taskLink?: boolean;
  afterTool?: AfterTool;
  /** Tools the host adds to the usual ones (the decisions the config lets the agent make). */
  extraTools?: ToolDescriptor[];
}

export function registerPipelineTools(
  server: McpServer,
  service: PipelineService,
  options: RegisterOptions = {},
): void {
  const tools = [...toolsFor(options), ...(options.extraTools ?? [])];
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.shape,
        annotations: { readOnlyHint: tool.readOnly, idempotentHint: tool.idempotent },
      },
      (async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => {
        let result = await invokeTool(service, tool.name, args, tools);
        if (options.afterTool) {
          const replaced = await options
            .afterTool({ tool: tool.name, args, result, signal: extra.signal })
            .catch(() => undefined);
          if (replaced) result = replaced;
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          isError: !result.ok,
        };
      }) as never,
    );
  }
}
