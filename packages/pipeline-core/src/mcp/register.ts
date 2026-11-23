/**
 * Putting the tools on an MCP server. The transport (stdio, HTTP), authentication and the choice of
 * SDK version belong to the host; this only says which tools exist and what each one does.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PipelineService, ToolResult } from "../service";
import type { ServerRole } from "../tool-roles";
import { invokeTool, keepOnly, type ToolDescriptor, toolsFor } from "./tools";

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
  /** The role the server was started with: some tools read differently on the manager. */
  role?: ServerRole;
  /**
   * The names the server serves (5M9D). A tool outside it is not registered and is not in the list the
   * dispatcher searches, so a call that names it is refused whether the client listed it or not.
   * Absent: every tool.
   */
  only?: readonly string[];
}

/** Registers the pipeline tools the server serves and returns exactly those. */
export function registerPipelineTools(
  server: McpServer,
  service: PipelineService,
  options: RegisterOptions = {},
): ToolDescriptor[] {
  const tools = keepOnly(
    [
      ...toolsFor({
        ...(options.taskLink === undefined ? {} : { taskLink: options.taskLink }),
        ...(options.role === undefined ? {} : { role: options.role }),
        ...(options.only === undefined ? {} : { served: options.only }),
      }),
      ...(options.extraTools ?? []),
    ],
    options.only,
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.strict === true ? z.object(tool.shape).strict() : tool.shape,
        annotations: { readOnlyHint: tool.readOnly, idempotentHint: tool.idempotent },
      } as never,
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
  return tools;
}
