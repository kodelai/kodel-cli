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
}

export interface Labels {
  /** Labels that mean "the node succeeded". The first one is the default edge label. */
  success: string[];
  /** Labels that mean "the node did not succeed". */
  failure: string[];
}

export interface NodeHandler {
  kind: string;
  /** Kind-specific fields (the common fields and `checks` are added by the parser). */
  shape: z.ZodRawShape;
  /** Whether the node may carry a `checks` array. */
  allowsChecks: boolean;
  /** Whether every failure label must have an outgoing edge (nobody else can retry the node). */
  requiresRoutes: boolean;
  labels(node: NodeInfo): Labels;
}

export interface CheckHandler {
  kind: string;
  /** Kind-specific fields (`kind` and `on_fail` are added by the parser). */
  shape: z.ZodRawShape;
  /** Cross-field validation; return one message per problem. */
  validate?(params: Record<string, unknown>): string[];
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

const agentNode: NodeHandler = {
  kind: "agent",
  shape: { prompt: nonEmpty },
  allowsChecks: true,
  requiresRoutes: false,
  labels: (node) => ({ success: ["passed"], failure: node.checks.map((c) => c.on_fail) }),
};

const commandNode: NodeHandler = {
  kind: "command",
  shape: { command: nonEmpty, expect: expect.optional(), on_fail: nonEmpty.optional() },
  allowsChecks: true,
  requiresRoutes: true,
  labels: (node) => ({
    success: ["passed"],
    failure: [node.on_fail, ...node.checks.map((c) => c.on_fail)],
  }),
};

const humanNode: NodeHandler = {
  kind: "human",
  shape: { prompt: nonEmpty, files: z.array(nonEmpty).optional() },
  allowsChecks: false,
  requiresRoutes: true,
  labels: () => ({ success: ["approved"], failure: ["rejected"] }),
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
};

const commandCheck: CheckHandler = {
  kind: "command",
  shape: { command: nonEmpty, timeout: positiveInt.optional(), expect: expect.optional() },
};

const resultCheck: CheckHandler = {
  kind: "result",
  shape: {
    columns: z.record(nonEmpty, columnType).refine((c) => Object.keys(c).length > 0, {
      message: "at least one column is required",
    }),
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
