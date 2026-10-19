/**
 * MCP tool definitions bound to the PipelineService: names, agent-facing descriptions, input
 * schemas, result and error shaping, and `registerPipelineTools(server, service, ctx)`.
 * Transport-free: the CLI adds stdio, the server adds HTTP and auth. Exposed as the
 * `@kodel-ai/pipeline-core/mcp` subpath so the SDK stays out of the main entry's module graph.
 */
export {};
