import type {
  ScenarioEngine,
  ScenarioEvent,
  ScenarioState,
  StartContext,
  ToolResponse,
} from "./types";

type ToolHandler = (args: Record<string, unknown>) => ToolResponse;

/**
 * An engine with a canned answer, used to test the scenario runner itself (and as a template for
 * real engines). It records what it was given and never runs a pipeline.
 */
export class ScriptedEngine implements ScenarioEngine {
  readonly name = "scripted";
  readonly events: ScenarioEvent[] = [];
  readonly calls: { tool: string; args: Record<string, unknown> }[] = [];
  started: StartContext | undefined;
  disposed = false;

  constructor(
    private readonly state: ScenarioState,
    private readonly tools: Record<string, ToolHandler> = {},
  ) {}

  async start(context: StartContext): Promise<{ runId: string }> {
    this.started = context;
    return { runId: "run-1" };
  }

  async applyEvent(event: ScenarioEvent): Promise<void> {
    this.events.push(event);
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<ToolResponse> {
    this.calls.push({ tool, args });
    const handler = this.tools[tool];
    return handler ? handler(args) : { ok: false, code: "UNKNOWN_TOOL", message: tool };
  }

  async readState(): Promise<ScenarioState> {
    return this.state;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}
