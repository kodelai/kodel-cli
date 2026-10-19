/**
 * Conformance scenarios: one declarative description of a pipeline run, executed against any
 * engine (the core with in-memory adapters, the local adapters, the server). The idea and the
 * DSL shape come from the server's orchestrator scenarios (KDL-666); this version is engine
 * independent and models our semantics: outcome labels, checks, visits, tool-level agent steps.
 */
import type { PipelineSpec } from "@kodel-ai/pipeline-core";

// ── inputs: what the world does ─────────────────────────────────────────────

/** The result report an agent sends for a `result` check. */
export interface ResultReport {
  completeness: "complete" | "partial" | "not_run" | "tool_error";
  incomplete_reason?: string;
  rows: Record<string, unknown>[];
  metrics?: Record<string, number>;
}

/** What happens during one attempt of one node. Anything left out is the quiet default. */
export interface Production {
  /** Files the agent changed in this attempt: path -> number of changed lines. Default: none. */
  changes?: Record<string, number>;
  /** The result report the agent sends. Default: none sent. */
  result?: ResultReport;
  /** Exit code of the node's own command (`command` nodes). Default: 0. */
  exit?: number;
  /** Exit codes of the node's `command` checks, in order. Default: 0 each. */
  checkExits?: number[];
  /**
   * The engine work of this attempt is still running when the run comes to rest (a long command).
   * It applies to the first execution only: a restart after an `interrupt` runs normally.
   */
  hangs?: boolean;
}

/** `attempt` counts per node across visits, as in the contract. */
export interface Inject {
  node: string;
  attempt: number;
  produce: Production;
}

export type ScenarioEvent =
  | { kind: "humanApprove"; node: string; reason?: string }
  | { kind: "humanReject"; node: string; reason?: string }
  /** The process running engine work died; the next `next_step` restarts the node. */
  | { kind: "interrupt" }
  | { kind: "advanceTime"; ms: number }
  | { kind: "cancel" };

/** A direct tool call, for scenarios about the agent protocol (adversarial agents). */
export interface ToolStep {
  kind: "tool";
  tool: string;
  /** The string "$run" is replaced by the id of the run under test. */
  args: Record<string, unknown>;
  expect: ToolExpectation;
}

export type ToolExpectation =
  | { ok: true; match?: Record<string, unknown> }
  | { error: string; match?: Record<string, unknown> };

export interface Assertion {
  key: string;
  expected: unknown;
}

export type Step =
  | { kind: "event"; event: ScenarioEvent }
  | ToolStep
  | { kind: "check"; assertions: Assertion[] };

export type PipelineRef = { file: string } | { inline: string };

/**
 * `auto`: the engine plays a disciplined agent and completes every agent node itself using the
 * injected production. `manual`: the agent only acts through tool steps (the production still
 * says what changed in the working tree).
 */
export type AgentMode = "auto" | "manual";

export interface Scenario {
  id: string;
  description?: string;
  pipeline: PipelineRef;
  task: string;
  agentMode: AgentMode;
  injects: Inject[];
  steps: Step[];
}

// ── what the engine shows back ──────────────────────────────────────────────

export type NodeStatus =
  | "pending"
  | "running"
  | "waiting"
  | "rework"
  | "passed"
  | "failed"
  | "skipped";

export interface NodeState {
  slug: string;
  status: NodeStatus;
  outcome: string | null;
  attempt: number;
}

export interface ScenarioState {
  runStatus: "running" | "paused" | "completed" | "failed" | "canceled";
  /** The human node the run is waiting on, if any. */
  waitingGate?: string;
  nodes: NodeState[];
  /** Node slugs in the order they were entered from another node (rework does not add). */
  trail: string[];
  /** Journal event kinds recorded so far, in order. */
  journal: string[];
}

export type ToolResponse =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; code: string; message: string };

export interface StartContext {
  spec: PipelineSpec;
  task: string;
  injects: Inject[];
  agentMode: AgentMode;
}

/** The one thing an engine under test implements. */
export interface ScenarioEngine {
  readonly name: string;
  start(context: StartContext): Promise<{ runId: string }>;
  applyEvent(event: ScenarioEvent): Promise<void>;
  /** Optional: engines that cannot take tool calls leave it out; such steps are reported. */
  callTool?(tool: string, args: Record<string, unknown>): Promise<ToolResponse>;
  readState(): Promise<ScenarioState>;
  dispose?(): Promise<void>;
}
