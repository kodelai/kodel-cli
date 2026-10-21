/**
 * Node and check kinds are adapters registered by `kind`. The engine never matches on a concrete
 * kind: it asks the registry for the parameter schema and for the outcome labels a node can emit.
 * The built-in kinds below are registered the same way a plugin kind would be.
 */
import { z } from "zod";

/** The part of a parsed check the handlers need to know about. */
export interface CheckInfo {
  kind: string;
  on_fail: string;
}

/** The part of a parsed node the handlers need to know about. */
export interface NodeInfo {
  kind: string;
  on_fail: string;
  checks: CheckInfo[];
  /** The kind-specific parameters, for kinds whose labels depend on them (`outcomes`). */
  params?: Record<string, unknown>;
}

export interface Labels {
  /** Labels that mean "the node succeeded". The first one is the default edge label. */
  success: string[];
  /** Labels that mean "the node did not succeed". */
  failure: string[];
}

/** What a node needs in order to do its work. Strings are already rendered (placeholders filled). */
export type Begin =
  | { needs: "agent"; prompt: string }
  | { needs: "engine"; command: string; expect: { exit: number } }
  | {
      needs: "human";
      prompt: string;
      /** What the person is asked to do or look at; the agent passes it on to them. */
      instructions?: string;
      /** The columns of the comments recorded while the person talks to the agent, when the node takes them. */
      results?: Record<string, unknown>;
    };

export interface NodeHandler {
  kind: string;
  /** Kind-specific fields (the common fields and `checks` are added by the parser). */
  shape: z.ZodRawShape;
  /** Whether the node may carry a `checks` array. */
  allowsChecks: boolean;
  /** Whether every failure label must have an outgoing edge (nobody else can retry the node). */
  requiresRoutes: boolean;
  /** Whether a failure counts toward `max_consecutive_failures` (a human rejection does not). */
  automaticFailures: boolean;
  labels(node: NodeInfo): Labels;
  /** How the node starts: who does the work and with what instructions. */
  begin(params: Record<string, unknown>, render: (text: string) => string): Begin;
  /** Extra guidance on *how* the agent does this node (not what), shown with the step. */
  instruction?(params: Record<string, unknown>): string | undefined;
  /** The columns of the report this node takes through `pipeline_report_result`, when it takes one. */
  resultsSpec?(params: Record<string, unknown>): Record<string, unknown> | undefined;
}

export type Baseline = "run" | "node" | "attempt";

export interface CheckHandler {
  kind: string;
  /** Kind-specific fields (`kind` and `on_fail` are added by the parser). */
  shape: z.ZodRawShape;
  /** Cross-field validation; return one message per problem. */
  validate?(params: Record<string, unknown>): string[];
  /** The snapshot this check compares against, if it needs one. */
  baseline?(params: Record<string, unknown>): Baseline | undefined;
  /** Text appended to the agent's prompt, for checks the agent has to feed (a result report). */
  instruction?(params: Record<string, unknown>): string | undefined;
  /** Whether the check's parameters are shown to the agent as the `result_spec`. */
  exposeSpec?: boolean;
}

export class Registry {
  private readonly nodes = new Map<string, NodeHandler>();
  private readonly checks = new Map<string, CheckHandler>();

  registerNode(handler: NodeHandler): this {
    this.nodes.set(handler.kind, handler);
    return this;
  }

  registerCheck(handler: CheckHandler): this {
    this.checks.set(handler.kind, handler);
    return this;
  }

  node(kind: string): NodeHandler | undefined {
    return this.nodes.get(kind);
  }

  check(kind: string): CheckHandler | undefined {
    return this.checks.get(kind);
  }

  nodeKinds(): string[] {
    return [...this.nodes.keys()].sort();
  }

  checkKinds(): string[] {
    return [...this.checks.keys()].sort();
  }
}

const nonEmpty = z.string().min(1);
const positiveInt = z.number().int().positive();
const expect = z.object({ exit: z.number().int() }).strict();

/**
 * Said to the agent when a node must be done by someone who has not seen the work so far. The
 * engine cannot make an agent forget, so this is guidance, and the node's checks still decide.
 */
export const FRESH_CONTEXT_INSTRUCTION =
  "Do this step in a fresh context: give it to a subagent (or a new session) that sees only this " +
  "step's prompt and the repository, not your earlier reasoning, so it is an independent look. " +
  "Take what it finds as it is and send that; do not change it to agree with your own work.";

/** A label an agent may finish a step with, besides `passed`. */
const outcomeLabel = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "an outcome is lowercase letters, digits, - and _")
  .refine((label) => label !== "passed", "passed is always there; do not list it");

/** The extra outcomes an agent node lists (`outcomes:`), in the order they were written. */
export const agentOutcomes = (params: Record<string, unknown> | undefined): string[] => {
  const listed = params?.outcomes;
  return Array.isArray(listed) ? listed.filter((l): l is string => typeof l === "string") : [];
};

const agentNode: NodeHandler = {
  kind: "agent",
  shape: {
    prompt: nonEmpty,
    fresh_context: z.boolean().optional(),
    // Other ways the step may end well, such as "nothing needs changing". The agent says which one
    // when it completes the step; the node's checks still decide, and each needs an edge.
    outcomes: z
      .array(outcomeLabel)
      .refine((all) => new Set(all).size === all.length, "an outcome is listed twice")
      .optional(),
  },
  allowsChecks: true,
  requiresRoutes: false,
  automaticFailures: true,
  labels: (node) => ({
    success: ["passed", ...agentOutcomes(node.params)],
    failure: node.checks.map((c) => c.on_fail),
  }),
  begin: (params, render) => ({ needs: "agent", prompt: render(String(params.prompt)) }),
  instruction: (params) => (params.fresh_context === true ? FRESH_CONTEXT_INSTRUCTION : undefined),
};

const commandNode: NodeHandler = {
  kind: "command",
  shape: { command: nonEmpty, expect: expect.optional(), on_fail: nonEmpty.optional() },
  allowsChecks: true,
  requiresRoutes: true,
  automaticFailures: true,
  labels: (node) => ({
    success: ["passed"],
    failure: [node.on_fail, ...node.checks.map((c) => c.on_fail)],
  }),
  begin: (params, render) => ({
    needs: "engine",
    command: render(String(params.command)),
    expect: (params.expect as { exit: number } | undefined) ?? { exit: 0 },
  }),
};

export const COLUMN_SCALARS = [
  "text",
  "longtext",
  "number",
  "date",
  "location",
  "link",
  "boolean",
] as const;

const columnType = z.union(
  [z.enum(COLUMN_SCALARS), z.object({ enum: z.array(nonEmpty).min(1) }).strict()],
  {
    errorMap: () => ({
      message: `column type must be one of ${COLUMN_SCALARS.join(", ")} or {enum: [values]}`,
    }),
  },
);

const columnsSchema = z.record(nonEmpty, columnType).refine((c) => Object.keys(c).length > 0, {
  message: "at least one column is required",
});

const humanNode: NodeHandler = {
  kind: "human",
  shape: {
    prompt: nonEmpty,
    instructions: nonEmpty.optional(),
    // Where the person's comments are recorded while they talk to the agent; sent back on a rejection.
    results: z.object({ columns: columnsSchema }).strict().optional(),
  },
  allowsChecks: false,
  requiresRoutes: true,
  automaticFailures: false,
  labels: () => ({ success: ["approved"], failure: ["rejected"] }),
  begin: (params, render) => ({
    needs: "human",
    prompt: render(String(params.prompt)),
    ...(params.instructions === undefined
      ? {}
      : { instructions: render(String(params.instructions)) }),
    ...(params.results === undefined ? {} : { results: params.results as Record<string, unknown> }),
  }),
  resultsSpec: (params) => params.results as Record<string, unknown> | undefined,
};

const diffCheck: CheckHandler = {
  kind: "diff",
  shape: {
    paths: z.array(nonEmpty).min(1),
    mode: z.enum(["changed", "changed_only", "only", "unchanged"]).optional(),
    since: z.enum(["run", "node", "attempt"]).optional(),
    min_lines: z.number().int().nonnegative().optional(),
    max_lines: z.number().int().nonnegative().optional(),
  },
  validate: (p) => {
    const min = p.min_lines;
    const max = p.max_lines;
    return typeof min === "number" && typeof max === "number" && min > max
      ? [`min_lines (${min}) must not exceed max_lines (${max})`]
      : [];
  },
  baseline: (p) => (p.since as Baseline | undefined) ?? "node",
};

const commandCheck: CheckHandler = {
  kind: "command",
  shape: { command: nonEmpty, timeout: positiveInt.optional(), expect: expect.optional() },
};

function resultInstruction(p: Record<string, unknown>): string {
  const columns = Object.entries((p.columns ?? {}) as Record<string, unknown>)
    .map(([name, type]) =>
      typeof type === "string"
        ? `${name} (${type})`
        : `${name} (one of ${(type as { enum: string[] }).enum.join(", ")})`,
    )
    .join(", ");
  return (
    "When you are done, send your findings with pipeline_report_result as a complete list for " +
    `this attempt: one row per finding with the columns ${columns}. If you found nothing, send an empty list.`
  );
}

const resultCheck: CheckHandler = {
  kind: "result",
  instruction: resultInstruction,
  exposeSpec: true,
  shape: {
    columns: columnsSchema,
    metrics: z.record(nonEmpty, z.literal("number")).optional(),
    fail_when: z.record(nonEmpty, z.array(z.union([z.string(), z.boolean()])).min(1)).optional(),
  },
  validate: (p) => {
    const columns = (p.columns ?? {}) as Record<string, unknown>;
    const failWhen = (p.fail_when ?? {}) as Record<string, unknown[]>;
    const problems: string[] = [];
    for (const [column, values] of Object.entries(failWhen)) {
      const type = columns[column];
      if (type === undefined) {
        problems.push(`fail_when refers to unknown column "${column}"`);
      } else if (type === "boolean") {
        if (values.some((v) => typeof v !== "boolean")) {
          problems.push(`fail_when values for boolean column "${column}" must be true or false`);
        }
      } else if (typeof type === "object" && type !== null && "enum" in type) {
        const allowed = (type as { enum: string[] }).enum;
        for (const v of values) {
          if (typeof v !== "string" || !allowed.includes(v)) {
            problems.push(
              `fail_when value ${JSON.stringify(v)} is not in the enum of column "${column}"`,
            );
          }
        }
      } else {
        problems.push(`fail_when can only test enum or boolean columns ("${column}" is not)`);
      }
    }
    return problems;
  },
};

/** A registry with the built-in kinds. Hosts may register more on top of it. */
export function defaultRegistry(): Registry {
  return new Registry()
    .registerNode(agentNode)
    .registerNode(commandNode)
    .registerNode(humanNode)
    .registerCheck(diffCheck)
    .registerCheck(commandCheck)
    .registerCheck(resultCheck);
}
