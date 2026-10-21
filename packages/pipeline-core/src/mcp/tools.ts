/**
 * The agent-facing definition of the tools: names, descriptions (which the agent reads, so they are
 * part of the prompt), input schemas, and one dispatcher that validates a call and runs it on the
 * service. Hosts register these on their own MCP server, so every host shows the agent the same
 * tools. Anything extra in a call (a made-up `status`, say) is ignored, never trusted.
 */
import { z } from "zod";
import { MAX_WAIT_S } from "../next-step";
import { RUN_ID_PATTERN } from "../run-id";
import type { PipelineService, ToolResult } from "../service";

/** Bump when a tool is renamed or its arguments change; a snapshot test pins the surface. */
export const CONTRACT_VERSION = 1;

/**
 * What the agent is told about this server when it connects (the MCP `instructions` field), so the
 * rules of working with a pipeline travel with the server and do not depend on a file in the
 * project that someone has to write and keep up to date.
 */
export const SERVER_INSTRUCTIONS = [
  "This server runs the project's pipelines: fixed sequences of steps that the engine, not you, checks.",
  "",
  "When the user asks you to do something through a pipeline (or to run one), work only through the pipeline_* tools:",
  "1. If you do not know the pipeline's name, call pipeline_list. Then call pipeline_start with the task in the user's words.",
  "2. Follow each answer. Never pick, reorder or skip steps yourself, and never decide that a step is done: after you do a step, call pipeline_complete_step and let the engine's checks decide. If a check fails you get the reason and the same step again.",
  "3. pipeline_next_step tells you what is next: `node` (do it), `waiting` (a person has to decide), `running` (the engine is working: pass wait_s to wait, as the hint says), or `done`.",
  "4. At a `waiting` answer, do what `tell_the_person` says: write the person what they are asked to decide, a summary of what was done and changed, what to look at, and the command to decide with. Then end your turn. You cannot approve, reject or resume anything yourself, and you must not try: those commands are for the person and refuse to run for an agent.",
  "5. Do not read or edit the run files in .kodel/runs, and do not edit the pipeline files while a run is going: the only way for you to change the pipeline of a run is pipeline_propose_change, and a person accepts it.",
  "6. If a step's description or a check looks wrong or unclear, say so with pipeline_feedback; it never blocks the run. If you think the pipeline itself should change for this run, first ask the person: change it now (the run stops at the end of the current step until they accept it), or only note it with pipeline_feedback and decide another way. Propose it only if they say now.",
  "7. If the answer to pipeline_start names a `workdir`, do all your work for the run in that directory (read and write files there, not in the directory you started in): the engine runs the commands and checks there.",
  "8. If an answer tells you that the pipeline of the run was changed and a person has to accept it (a `waiting` answer about the change, or a note about it on a `node` answer), do what `tell_the_person` says. If the change was made by editing the pipeline file and not through pipeline_propose_change, put the file back as it was and propose it instead.",
].join("\n");

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

/** Free text from the agent is bounded: everything is scanned for secrets and kept in the history. */
const LIMITS = { name: 200, task: 4_000, text: 4_000, proposal: 256 * 1024 } as const;

/** A POSIX path, a drive path or a UNC path: the core has no `node:path` and no file system. */
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

const runId = z
  .string()
  .regex(RUN_ID_PATTERN, "not a run id")
  .describe("The id returned by pipeline_start.");
const nodeSlug = z
  .string()
  .min(1)
  .max(LIMITS.name)
  .describe("The slug of the node, as in the step you were given.");
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
    description:
      "Read the full definition of a pipeline: its nodes, checks and edges. With run_id you get the version " +
      "that run is on, with its YAML text (`yaml`); start from that text when you propose a change with " +
      "pipeline_propose_change, because the file in the project may be another version.",
    shape: {
      pipeline: z.string().min(1).max(LIMITS.name),
      run_id: runId.optional(),
    },
    readOnly: true,
    idempotent: true,
    run: (service, input) => service.resolve(input as { pipeline: string; run_id?: string }),
  },
  {
    name: "pipeline_plan",
    title: "Plan a run",
    description:
      "Show what a run of a pipeline would do for a task, step by step, without starting anything.",
    shape: {
      pipeline: z.string().min(1).max(LIMITS.name),
      task: z.string().min(1).max(LIMITS.task),
    },
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
      "its end: tell the user, and pass restart: true only if they want to run it again. Pass cwd, the " +
      "directory you are working in. If the answer has a workdir, do the run's work there. Work through the " +
      "run by following each answer; never choose steps yourself. If the answer has a `choice` and no run_id, " +
      "nothing was started: the pipeline file has changes that are not committed, and the person has to say " +
      "whether the run uses the working version or the committed one. Ask them (do what `tell_the_person` " +
      "says), never choose yourself, then call pipeline_start again with the same arguments and pipeline_version.",
    shape: {
      task: z
        .string()
        .min(1)
        .max(LIMITS.task)
        .describe("What the user wants done, in their own words."),
      pipeline: z
        .string()
        .min(1)
        .max(LIMITS.name)
        .optional()
        .describe("Omit it if the project has only one pipeline."),
      restart: z.boolean().optional(),
      pipeline_version: z
        .enum(["working", "committed"])
        .optional()
        .describe(
          "Only after a `choice` answer, and only what the person said: `working` (the file as it is now) or `committed` (as it is in the last commit).",
        ),
      cwd: z
        .string()
        .min(1)
        .max(4_096)
        .refine((value) => ABSOLUTE_PATH.test(value), "must be an absolute path")
        .optional()
        .describe(
          "The directory you are working in, as an absolute path. If it is a git worktree of this project, the run uses it; otherwise the engine makes one and the answer names it.",
        ),
    },
    readOnly: false,
    idempotent: true,
    run: (service, input) => service.start(input as Parameters<PipelineService["start"]>[0]),
  },
  {
    name: "pipeline_next_step",
    title: "What to do next",
    description:
      "Ask what to do next in a run. It is safe to repeat. The answer is one of four: `node` (do this work, " +
      "then call pipeline_complete_step), `waiting` (a person has to decide: do what `tell_the_person` says, " +
      "then end your turn), `running` (the engine is working: pass wait_s to wait for it, as the hint says, " +
      "or tell the user and end your turn; never ask again in a tight loop), or `done`.",
    shape: {
      run_id: runId,
      wait_s: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_S)
        .optional()
        .describe(
          `If the engine is working, wait up to this many seconds (at most ${MAX_WAIT_S}) for it to finish before answering.`,
        ),
    },
    readOnly: true,
    idempotent: true,
    run: (service, input) => service.nextStep(input as { run_id: string; wait_s?: number }),
  },
  {
    name: "pipeline_report_result",
    title: "Report findings",
    description:
      "Send the findings a step asked for (before you complete it), or the comments a person makes at a gate. " +
      "Rows are added to what is already reported for this attempt; a row with an `id` that is there replaces " +
      "that row, and a row identical to one there is not added twice. Pass `replace: true` to start the list " +
      "over. The last call decides completeness. If the answer is an error the report was not accepted: fix " +
      "it and send it again.",
    shape: {
      run_id: runId,
      node_slug: nodeSlug,
      attempt,
      completeness: z
        .enum(["complete", "partial", "not_run", "tool_error"])
        .optional()
        .describe(
          '"complete" only if you looked at everything. "Not checked" is not "clean". Required for a step\'s findings, not for a person\'s comments at a gate.',
        ),
      incomplete_reason: z
        .string()
        .max(2_000)
        .optional()
        .describe("Required unless completeness is complete."),
      rows: z
        .array(z.record(z.unknown()))
        .describe(
          "One object per finding, with the columns the step asked for, and optionally an `id` (up to 64 characters) so a later call can replace the row.",
        ),
      replace: z
        .boolean()
        .optional()
        .describe("Start the list over with these rows instead of adding to it."),
      metrics: z
        .record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.number())
        .optional()
        .describe("Counts by short name, such as files_checked."),
    },
    readOnly: false,
    // Rows are added, so a repeated call is not harmless to a client that retries on its own.
    idempotent: false,
    run: (service, input) =>
      service.reportResult(input as Parameters<PipelineService["reportResult"]>[0]),
  },
  {
    name: "pipeline_complete_step",
    title: "Finish a step",
    description:
      "Say you have finished the node you were given. The engine then runs the node's checks and decides; " +
      "your word is not the verdict. The answer says whether the run advanced, the outcome, and what to do " +
      "next. If a check failed you get the reason and the same node again to fix. If the step lists other " +
      "`outcomes`, you may pass `outcome` to finish with one of them (the step's prompt says when); the checks " +
      "still apply, and anything else is refused.",
    shape: {
      run_id: runId,
      node_slug: nodeSlug,
      attempt,
      summary: z
        .string()
        .max(LIMITS.text)
        .optional()
        .describe("What you did, in a sentence or two."),
      outcome: z
        .string()
        .max(64)
        .optional()
        .describe("One of the step's `outcomes`, when the prompt says to finish it that way."),
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
      message: z
        .string()
        .min(1)
        .max(LIMITS.text)
        .describe("What is wrong, with enough detail to act on."),
      suggestion: z.string().max(LIMITS.text).optional().describe("How you would change it."),
    },
    readOnly: false,
    idempotent: false,
    run: (service, input) => service.feedback(input as Parameters<PipelineService["feedback"]>[0]),
  },
  {
    name: "pipeline_propose_change",
    title: "Propose a change of the run's pipeline",
    description:
      "Propose another version of the pipeline this run is on, as the full YAML (start from pipeline_resolve " +
      "with run_id). Ask the person first whether to change it now or only note it with pipeline_feedback. " +
      "Nothing changes by itself: the engine checks that the change can be taken, keeps it, and stops the run " +
      "at the end of the current step until the person accepts it with a command they run. Never edit the " +
      "pipeline file yourself and never run that command. The answer says what differs and which steps run " +
      "again; tell the person. A proposal that cannot be taken is refused with the reason. A new proposal " +
      "replaces the previous one; an empty `pipeline` takes your proposal back.",
    shape: {
      run_id: runId,
      pipeline: z
        .string()
        .max(LIMITS.proposal)
        .describe("The whole pipeline as YAML, or an empty string to take the proposal back."),
      summary: z
        .string()
        .max(LIMITS.text)
        .describe("What you change and why, in a sentence or two, for the person."),
    },
    readOnly: false,
    idempotent: true,
    run: (service, input) =>
      service.proposeChange(input as Parameters<PipelineService["proposeChange"]>[0]),
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
