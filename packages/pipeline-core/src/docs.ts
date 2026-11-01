/**
 * The engine's own documentation for the agent (`pipeline_docs`). The prose lives in `agent-docs/*.md`
 * and is embedded in the build; the reference of the fields is read from the same schemas the parser
 * uses, so the two cannot drift apart. Pure data: nothing here reads a file at run time.
 */
import { z } from "zod";
import checks from "../agent-docs/checks.md" with { type: "text" };
import examples from "../agent-docs/examples.md" with { type: "text" };
import design from "../agent-docs/pipeline-design.md" with { type: "text" };
import quality from "../agent-docs/pipeline-quality.md" with { type: "text" };
import spec from "../agent-docs/pipeline-spec.md" with { type: "text" };
import { commonNodeShape, edgeSchema, topSchema } from "./pipeline";
import type { Registry } from "./registry";

export interface DocTopic {
  topic: string;
  summary: string;
  text: string;
}

/** Where the generated reference goes in a topic's prose. */
const MARKER = "<!-- reference -->";

/** A union or an enum inside an array or a map is put in parentheses, or `a | b[]` reads wrongly. */
const grouped = (schema: z.ZodTypeAny): string => {
  const text = type(schema);
  return text.includes(" \\| ") && !/^[({]|\[\]$/.test(text) ? `(${text})` : text;
};

const type = (schema: z.ZodTypeAny): string => {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return type(schema.unwrap());
  }
  if (schema instanceof z.ZodEffects) return type(schema.innerType());
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return schema.isInt ? "integer" : "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodUnknown) return "any";
  if (schema instanceof z.ZodLiteral) return JSON.stringify(schema.value);
  if (schema instanceof z.ZodEnum) return (schema.options as string[]).join(" \\| ");
  if (schema instanceof z.ZodArray) return `${grouped(schema.element)}[]`;
  if (schema instanceof z.ZodRecord) return `map of ${grouped(schema.valueSchema)}`;
  if (schema instanceof z.ZodUnion)
    return (schema.options as z.ZodTypeAny[]).map(type).join(" \\| ");
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as z.ZodRawShape;
    return `{ ${Object.entries(shape)
      .map(([name, field]) => `${name}: ${type(field)}`)
      .join(", ")} }`;
  }
  // A type that is not listed would silently drop out of the docs, so it stops the build instead.
  throw new Error(`docs cannot describe a ${schema.constructor.name}`);
};

/** The fields of a shape that have no description: each one is a hole in the reference. */
export function undescribedFields(shape: z.ZodRawShape): string[] {
  return Object.entries(shape)
    .filter(([, field]) => !field.description)
    .map(([name]) => name);
}

export function fieldTable(shape: z.ZodRawShape): string {
  const rows = Object.entries(shape).map(
    ([name, field]) =>
      `| \`${name}\` | ${type(field)} | ${field.isOptional() ? "no" : "yes"} | ${field.description ?? ""} |`,
  );
  return ["| field | type | required | meaning |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

/** Added by the parser to every node and every check, so no handler's shape has them. */
const nodeChecks: z.ZodRawShape = {
  checks: z
    .array(z.unknown())
    .optional()
    .describe(
      "The checks that decide the step, run in order (for the kinds that take them). See checks.",
    ),
};
const checkCommon: z.ZodRawShape = {
  kind: z.string().describe("Which check: see the kinds below."),
  on_fail: z.string().optional().describe("The edge label when the check fails; failed if absent."),
};

const section = (title: string, shape: z.ZodRawShape) => `### ${title}\n\n${fieldTable(shape)}`;

const specReference = (registry: Registry) =>
  [
    section("Pipeline", topSchema.shape),
    section("Every node", { ...commonNodeShape, ...nodeChecks }),
    ...registry.nodeKinds().map((kind) => {
      const handler = registry.node(kind);
      return section(`Node kind \`${kind}\``, handler?.shape ?? {});
    }),
    section("Edges", edgeSchema.shape),
  ].join("\n\n");

const checkReference = (registry: Registry) =>
  [
    section("Every check", checkCommon),
    ...registry
      .checkKinds()
      .map((kind) => section(`Check kind \`${kind}\``, registry.check(kind)?.shape ?? {})),
  ].join("\n\n");

const fill = (text: string, reference: string) => text.replace(MARKER, reference);

/** The topics, in the order the index lists them. */
export function docTopics(registry: Registry): DocTopic[] {
  return [
    {
      topic: "pipeline-design",
      summary: "How to build a pipeline for a project: what to look at, profiles, modes, traps",
      text: design,
    },
    {
      topic: "pipeline-spec",
      summary: "The pipeline file: nodes, edges, placeholders, and every field",
      text: fill(spec, specReference(registry)),
    },
    {
      topic: "checks",
      summary: "The checks that decide a step: which to use, and their parameters",
      text: fill(checks, checkReference(registry)),
    },
    {
      topic: "examples",
      summary: "Complete pipelines that the parser accepts, small to strict",
      text: examples,
    },
    {
      topic: "pipeline-quality",
      summary:
        "What makes a pipeline good: the balance of background work and the person's control, the report, a checklist",
      text: quality,
    },
  ];
}
