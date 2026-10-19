import type {
  AgentMode,
  Assertion,
  Inject,
  PipelineRef,
  Production,
  Scenario,
  ScenarioEvent,
  Step,
  ToolExpectation,
} from "./types";

// ── helpers ─────────────────────────────────────────────────────────────────

/** What `node` does on each attempt: `inj("build", { 1: { exit: 1 }, 2: {} })`. */
export function inj(node: string, byAttempt: Record<number, Production>): Inject[] {
  return Object.entries(byAttempt).map(([attempt, produce]) => ({
    node,
    attempt: Number(attempt),
    produce,
  }));
}

export const humanApprove = (node: string, reason?: string): ScenarioEvent =>
  reason === undefined ? { kind: "humanApprove", node } : { kind: "humanApprove", node, reason };
export const humanReject = (node: string, reason?: string): ScenarioEvent =>
  reason === undefined ? { kind: "humanReject", node } : { kind: "humanReject", node, reason };
export const interrupt = (): ScenarioEvent => ({ kind: "interrupt" });
export const advanceTime = (ms: number): ScenarioEvent => ({ kind: "advanceTime", ms });
export const cancelRun = (): ScenarioEvent => ({ kind: "cancel" });

export const matcher = (key: string, expected: unknown): Assertion => ({ key, expected });

export const expectOk = (match?: Record<string, unknown>): ToolExpectation =>
  match === undefined ? { ok: true } : { ok: true, match };
export const expectError = (code: string, match?: Record<string, unknown>): ToolExpectation =>
  match === undefined ? { error: code } : { error: code, match };

// ── builder ─────────────────────────────────────────────────────────────────

class ScenarioBuilder {
  private description: string | undefined;
  private pipelineRef: PipelineRef | undefined;
  private taskText: string | undefined;
  private mode: AgentMode = "auto";
  private readonly injects: Inject[] = [];
  private readonly steps: Step[] = [];

  constructor(private readonly id: string) {}

  describe(text: string): this {
    this.description = text;
    return this;
  }

  /** A pipeline file (relative to the repository root) or inline YAML. */
  pipeline(ref: PipelineRef): this {
    this.pipelineRef = ref;
    return this;
  }

  task(text: string): this {
    this.taskText = text;
    return this;
  }

  agent(mode: AgentMode): this {
    this.mode = mode;
    return this;
  }

  /** Input: what happens during node attempts. */
  inject(...entries: Inject[][]): this {
    for (const group of entries) this.injects.push(...group);
    return this;
  }

  /** A step that happens in order: a human decision, an interruption, time passing. */
  on(event: ScenarioEvent): this {
    this.steps.push({ kind: "event", event });
    return this;
  }

  /** A direct tool call and the response it must get. */
  call(tool: string, args: Record<string, unknown>, expect: ToolExpectation): this {
    this.steps.push({ kind: "tool", tool, args, expect });
    return this;
  }

  /** Assertions about the state at this point of the scenario. */
  expect(assertions: Assertion[]): this {
    this.steps.push({ kind: "check", assertions });
    return this;
  }

  build(): Scenario {
    if (!this.pipelineRef) throw new Error(`scenario "${this.id}": pipeline() is required`);
    const scenario: Scenario = {
      id: this.id,
      pipeline: this.pipelineRef,
      task: this.taskText ?? "demo task",
      agentMode: this.mode,
      injects: this.injects,
      steps: this.steps,
    };
    if (this.description !== undefined) scenario.description = this.description;
    return scenario;
  }
}

export function defineScenario(id: string): ScenarioBuilder {
  return new ScenarioBuilder(id);
}
