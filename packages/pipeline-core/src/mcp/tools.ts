/**
 * The agent-facing definition of the tools: names, descriptions (which the agent reads, so they are
 * part of the prompt), input schemas, and one dispatcher that validates a call and runs it on the
 * service. Hosts register these on their own MCP server, so every host shows the agent the same
 * tools. Anything extra in a call (a made-up `status`, say) is ignored, never trusted.
 */
import { z } from "zod";
import type { PipelineService, ToolResult } from "../service";

/** Bump when a tool is renamed or its arguments change; a snapshot test pins the surface. */
export const CONTRACT_VERSION = 1;

export interface ToolDescriptor {
  name: string;
  title: string;
  /** Written for the agent: when to call it, what the answer means, what to do next. */
  description: string;
  shape: z.ZodRawShape;
  readOnly: boolean;
  idempotent: boolean;
  run(service: PipelineService, input: Record<string, unknown>): Promise<ToolResult>;
}

const runId = z.string().min(1).describe("The id returned by pipeline_start.");
const nodeSlug = z.string().min(1).describe("The slug of the node, as in the step you were given.");
const attempt = z
  .number()
  .int()
  .positive()
  .describe("The attempt number of the step you were given.");

export const TOOLS: ToolDescriptor[] = [
  {
    name: "pipeline_list",
    title: "List pipelines",
    description:
      "List the pipelines available in this project. Call it when the user asks to run a pipeline without naming one.",
    shape: {},
    readOnly: true,
    idempotent: true,
    run: (service) => service.list(),
  },
  {
    name: "pipeline_resolve",
    title: "Read a pipeline",
    description: "Read the full definition of a pipeline: its nodes, checks and edges.",
    shape: { pipeline: z.string().min(1) },
    readOnly: true,
    idempotent: true,
    run: (service, input) => service.resolve(input as { pipeline: string }),
  },
  {
    name: "pipeline_plan",
    title: "Plan a run",
    description:
      "Show what a run of a pipeline would do for a task, step by step, without starting anything.",
    shape: { pipeline: z.string().min(1), task: z.string().min(1) },
    readOnly: true,
    idempotent: true,
    run: (service, input) => service.plan(input as { pipeline: string; task: string }),
  },
  {
    name: "pipeline_start",
    title: "Start a run",
    description:
      "Start a run of a pipeline on a task, or pick up the run that is already active for the same task. " +
      "The answer has a run_id and what to do first (next). If terminal is true the task already ran to " +
      "its end: tell the user, and pass restart: true only if they want to run it again. Work through the " +
      "run by following each answer; never choose steps yourself.",
    shape: {
      task: z.string().min(1).describe("What the user wants done, in their own words."),
      pipeline: z
        .string()
        .min(1)
        .optional()
        .describe("Omit it if the project has only one pipeline."),
      restart: z.boolean().optional(),
    },
    readOnly: false,
    idempotent: true,
    run: (service, input) =>
      service.start(input as { task: string; pipeline?: string; restart?: boolean }),
  },
  {
    name: "pipeline_next_step",
    title: "What to do next",
    description:
      "Ask what to do next in a run. It is safe to repeat. The answer is one of four: `node` (do this work, " +
      "then call pipeline_complete_step), `waiting` (a person has to decide; tell them how and end your turn), " +
      "`running` (the engine is working; tell the user and end your turn, do not ask again in a loop), or " +
      "`done`.",
    shape: { run_id: runId },
    readOnly: true,
    idempotent: true,
    run: (service, input) => service.nextStep(input as { run_id: string }),
  },
  {
    name: "pipeline_report_result",
    title: "Report findings",
    description:
      "Send the findings a node asked for, before you complete it. Send the whole list for this attempt every " +
      "time. If the answer is an error the report was not accepted: fix it and send it again.",
    shape: {
      run_id: runId,
      node_slug: nodeSlug,
      attempt,
      completeness: z
        .enum(["complete", "partial", "not_run", "tool_error"])
        .describe('"complete" only if you looked at everything. "Not checked" is not "clean".'),
      incomplete_reason: z
        .string()
        .optional()
        .describe("Required unless completeness is complete."),
      rows: z
        .array(z.record(z.unknown()))
        .describe("One object per finding, with the columns the step asked for."),
      metrics: z.record(z.number()).optional(),
    },
    readOnly: false,
    idempotent: true,
    run: (service, input) =>
      service.reportResult(input as Parameters<PipelineService["reportResult"]>[0]),
  },
  {
    name: "pipeline_complete_step",
    title: "Finish a step",
    description:
      "Say you have finished the node you were given. The engine then runs the node's checks and decides; " +
      "your word is not the verdict. The answer says whether the run advanced, the outcome, and what to do " +
      "next. If a check failed you get the reason and the same node again to fix.",
    shape: {
      run_id: runId,
      node_slug: nodeSlug,
      attempt,
      summary: z.string().optional().describe("What you did, in a sentence or two."),
    },
    readOnly: false,
    idempotent: true,
    run: (service, input) =>
      service.completeStep(input as Parameters<PipelineService["completeStep"]>[0]),
  },
  {
    name: "pipeline_feedback",
    title: "Report a problem with a step",
    description:
      "Report a problem you noticed in a step description: an unclear or contradictory prompt, a check that " +
      "looks wrong, a missing step, a tool problem. It never blocks the run. Use it when it would help improve " +
      "the pipeline, not for every small remark.",
    shape: {
      run_id: runId,
      node_slug: nodeSlug.optional(),
      attempt: attempt.optional(),
      category: z.enum(["unclear_prompt", "wrong_check", "missing_step", "tool_problem", "other"]),
      message: z.string().min(1).describe("What is wrong, with enough detail to act on."),
      suggestion: z.string().optional().describe("How you would change it."),
    },
    readOnly: false,
    idempotent: false,
    run: (service, input) => service.feedback(input as Parameters<PipelineService["feedback"]>[0]),
  },
];

/** Validate a call against the tool's schema and run it. Never throws for bad input. */
export async function invokeTool(
  service: PipelineService,
  name: string,
  raw: unknown,
): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { ok: false, code: "INVALID_ARGUMENTS", message: `there is no tool "${name}"` };
  }
  const parsed = z.object(tool.shape).safeParse(raw ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".");
    return {
      ok: false,
      code: "INVALID_ARGUMENTS",
      message: `bad arguments for ${name}${where ? ` at "${where}"` : ""}: ${first?.message ?? "invalid"}`,
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    };
  }
  return tool.run(service, parsed.data);
}
