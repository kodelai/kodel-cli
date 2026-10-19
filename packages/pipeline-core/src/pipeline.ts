/**
 * Pipeline spec: nodes, checks, edges; parsing and static validation.
 * Kind-specific rules come from the registry, so plugin kinds validate like built-in ones.
 */
import type { Document } from "yaml";
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import { z } from "zod";
import { type ErrorCode, KodelError } from "./errors";
import { MAX_SUPPORTED_FORMAT, resolveFormat } from "./format";
import { defaultRegistry, type Registry } from "./registry";

export type Path = (string | number)[];

export interface SpecIssue {
  path: Path;
  message: string;
  line?: number;
  col?: number;
}

export interface CheckSpec {
  kind: string;
  /** Edge label emitted when this check fails. */
  on_fail: string;
  /** Kind-specific parameters. */
  params: Record<string, unknown>;
}

export interface NodeSpec {
  slug: string;
  name?: string;
  kind: string;
  timeout?: number;
  max_attempts?: number;
  /** Label emitted when the node itself fails (meaningful for `command` nodes). */
  on_fail: string;
  checks: CheckSpec[];
  /** Kind-specific parameters (`prompt`, `command`, `files`, ...). */
  params: Record<string, unknown>;
}

export interface EdgeSpec {
  from: string;
  to: string;
  /** The outcome label that takes this edge. */
  when: string;
}

export interface PipelineSpec {
  format: number;
  name: string;
  description?: string;
  /** The node a run starts at: the first node in the file. */
  entry: string;
  nodes: NodeSpec[];
  edges: EdgeSpec[];
}

export type ParseResult =
  | { ok: true; spec: PipelineSpec }
  | { ok: false; code: ErrorCode; message: string; issues: SpecIssue[] };

export interface ParseOptions {
  registry?: Registry;
  /** The project's `format` from `.kodel/config.yaml`, used when the pipeline has none. */
  configFormat?: number;
}

/** Placeholders a pipeline may use in its strings. */
export const PLACEHOLDERS = ["task", "task.slug"] as const;

const DEFAULT_ON_FAIL = "failed";
const GENERIC_NODE_FIELDS = new Set([
  "slug",
  "name",
  "kind",
  "timeout",
  "max_attempts",
  "on_fail",
  "checks",
]);

const nonEmpty = z.string().min(1);
const positiveInt = z.number().int().positive();

const topSchema = z
  .object({
    format: z.number().optional(),
    name: nonEmpty,
    description: z.string().optional(),
    defaults: z
      .object({ timeout: positiveInt.optional(), max_attempts: positiveInt.optional() })
      .strict()
      .optional(),
    nodes: z.array(z.unknown()).min(1),
    edges: z.array(z.unknown()).optional(),
  })
  .strict();

const commonNodeShape = {
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "slug must be lowercase letters, digits and dashes"),
  name: nonEmpty.optional(),
  kind: nonEmpty,
  timeout: positiveInt.optional(),
  max_attempts: positiveInt.optional(),
};

const edgeSchema = z.object({ from: nonEmpty, to: nonEmpty, when: nonEmpty.optional() }).strict();

// ── locations ───────────────────────────────────────────────────────────────

type Range = [number, number, number];

function rangeOf(node: unknown): Range | undefined {
  if (typeof node === "object" && node !== null && "range" in node) {
    const r = (node as { range?: unknown }).range;
    if (Array.isArray(r) && r.length >= 1 && typeof r[0] === "number") return r as Range;
  }
  return undefined;
}

function scalarValue(node: unknown): unknown {
  return isScalar(node) ? node.value : node;
}

function locate(doc: Document.Parsed, lc: LineCounter, path: Path) {
  let node: unknown = doc.contents;
  let range = rangeOf(node);
  for (const seg of path) {
    if (isMap(node) && typeof seg === "string") {
      const pair = node.items.find((p) => scalarValue(p.key) === seg);
      if (!pair) break;
      range = rangeOf(pair.key) ?? range;
      node = pair.value;
    } else if (isSeq(node) && typeof seg === "number") {
      const item = node.items[seg];
      if (item === undefined || item === null) break;
      node = item;
      range = rangeOf(item) ?? range;
    } else {
      break;
    }
  }
  return range ? lc.linePos(range[0]) : undefined;
}

class Collector {
  readonly issues: SpecIssue[] = [];

  constructor(
    private readonly doc: Document.Parsed,
    private readonly lc: LineCounter,
  ) {}

  /** `at` is where the problem is shown; `path` is the full path of the offending value. */
  add(path: Path, message: string, at: Path = path) {
    const pos = locate(this.doc, this.lc, at);
    this.issues.push(pos ? { path, message, line: pos.line, col: pos.col } : { path, message });
  }

  fromZod(error: z.ZodError, base: Path, hint = "") {
    for (const issue of error.issues) {
      const path = [...base, ...issue.path];
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          this.add([...path, key], `field "${key}" is not allowed${hint}`);
        }
      } else if (issue.code === "invalid_type" && issue.received === "undefined") {
        const field = String(path[path.length - 1]);
        this.add(path, `field "${field}" is required${hint}`, path.slice(0, -1));
      } else {
        const label = issue.path.map(String).join(".");
        this.add(path, label ? `${label}: ${issue.message}` : issue.message);
      }
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function walkStrings(value: unknown, path: Path, visit: (s: string, path: Path) => void) {
  if (typeof value === "string") visit(value, path);
  else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) walkStrings(v, [...path, i], visit);
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) walkStrings(v, [...path, k], visit);
  }
}

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

function checkPlaceholders(c: Collector, text: string, path: Path) {
  const stripped = text.replace(/\\\{\{/g, "");
  for (const m of stripped.matchAll(PLACEHOLDER)) {
    const name = m[1] ?? "";
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) {
      c.add(path, `unknown placeholder "{{${name}}}" (available: ${PLACEHOLDERS.join(", ")})`);
    } else if (name === "task" && path[path.length - 1] === "command") {
      // The task text is free input; substituted into a shell command it would be an injection.
      c.add(
        path,
        '"{{task}}" is not allowed in a command: the task text is free input and would be ' +
          'injected into the shell; use "{{task.slug}}" instead',
      );
    }
  }
  if (stripped.replace(PLACEHOLDER, "").includes("{{")) {
    c.add(
      path,
      'unclosed placeholder: "{{" without a matching "}}" (escape a literal one as \\{{)',
    );
  }
}

// ── parsing ─────────────────────────────────────────────────────────────────

/** Parse and validate pipeline YAML. Does not throw for invalid input; see `parsePipeline`. */
export function validatePipeline(text: string, options: ParseOptions = {}): ParseResult {
  const registry = options.registry ?? defaultRegistry();
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });

  if (doc.errors.length > 0) {
    const issues = doc.errors.map((e) => {
      const pos = e.linePos?.[0];
      return pos
        ? { path: [], message: e.message.split("\n")[0] ?? e.message, line: pos.line, col: pos.col }
        : { path: [], message: e.message };
    });
    return { ok: false, code: "PIPELINE_INVALID", message: summarize(issues), issues };
  }

  const c = new Collector(doc, lc);
  const root: unknown = doc.toJS();
  if (!isRecord(root)) {
    c.add([], "a pipeline must be a YAML mapping with name, nodes and edges");
    return failure(c);
  }

  // The format is checked first: a newer format may legitimately have fields we do not know.
  if (typeof root.format === "number" && root.format > MAX_SUPPORTED_FORMAT) {
    const message = `format ${root.format} is newer than this engine supports (max ${MAX_SUPPORTED_FORMAT}); upgrade kodel`;
    c.add(["format"], message);
    return { ok: false, code: "UNSUPPORTED_FORMAT", message, issues: c.issues };
  }

  const top = topSchema.safeParse(root);
  if (!top.success) {
    c.fromZod(top.error, []);
    return failure(c);
  }
  const { name, description, defaults, nodes: rawNodes, edges: rawEdges = [] } = top.data;

  let format = 1;
  try {
    format = resolveFormat(top.data.format, options.configFormat);
  } catch (e) {
    if (e instanceof KodelError && e.code === "UNSUPPORTED_FORMAT") {
      return { ok: false, code: e.code, message: e.message, issues: [] };
    }
    c.add(["format"], e instanceof Error ? e.message : String(e));
  }

  const nodes: NodeSpec[] = [];
  const declared = new Map<string, number>();

  rawNodes.forEach((raw, i) => {
    const base: Path = ["nodes", i];
    if (!isRecord(raw)) {
      c.add(base, "a node must be a mapping");
      return;
    }
    if (typeof raw.slug === "string") {
      if (declared.has(raw.slug)) {
        c.add([...base, "slug"], `duplicate node slug "${raw.slug}"`);
      } else {
        declared.set(raw.slug, i);
      }
    }
    walkStrings(raw, base, (s, p) => checkPlaceholders(c, s, p));

    const kind = raw.kind;
    if (typeof kind !== "string") {
      c.add(base, `field "kind" is required (one of: ${registry.nodeKinds().join(", ")})`);
      return;
    }
    const handler = registry.node(kind);
    if (!handler) {
      c.add(
        [...base, "kind"],
        `unknown node kind "${kind}" (registered: ${registry.nodeKinds().join(", ")})`,
      );
      return;
    }
    const shape = {
      ...commonNodeShape,
      ...handler.shape,
      ...(handler.allowsChecks ? { checks: z.array(z.unknown()).optional() } : {}),
    };
    const parsed = z.object(shape).strict().safeParse(raw);
    if (!parsed.success) {
      c.fromZod(parsed.error, base, ` for node kind "${kind}"`);
      return;
    }
    const data = parsed.data as Record<string, unknown>;

    const checks: CheckSpec[] = [];
    const rawChecks = Array.isArray(data.checks) ? data.checks : [];
    rawChecks.forEach((rawCheck, j) => {
      const cpath: Path = [...base, "checks", j];
      if (!isRecord(rawCheck)) {
        c.add(cpath, "a check must be a mapping");
        return;
      }
      const ckind = rawCheck.kind;
      if (typeof ckind !== "string") {
        c.add(cpath, `field "kind" is required (one of: ${registry.checkKinds().join(", ")})`);
        return;
      }
      const ch = registry.check(ckind);
      if (!ch) {
        c.add(
          [...cpath, "kind"],
          `unknown check kind "${ckind}" (registered: ${registry.checkKinds().join(", ")})`,
        );
        return;
      }
      const cparsed = z
        .object({ kind: nonEmpty, on_fail: nonEmpty.optional(), ...ch.shape })
        .strict()
        .safeParse(rawCheck);
      if (!cparsed.success) {
        c.fromZod(cparsed.error, cpath, ` for check kind "${ckind}"`);
        return;
      }
      const cdata = cparsed.data as Record<string, unknown>;
      for (const problem of ch.validate?.(cdata) ?? []) c.add(cpath, problem);
      const { kind: _kind, on_fail, ...params } = cdata;
      checks.push({
        kind: ckind,
        on_fail: (on_fail as string | undefined) ?? DEFAULT_ON_FAIL,
        params,
      });
    });

    const params = Object.fromEntries(
      Object.entries(data).filter(([key]) => !GENERIC_NODE_FIELDS.has(key)),
    );
    const node: NodeSpec = {
      slug: data.slug as string,
      kind,
      on_fail: (data.on_fail as string | undefined) ?? DEFAULT_ON_FAIL,
      checks,
      params,
    };
    const timeout = (data.timeout as number | undefined) ?? defaults?.timeout;
    const maxAttempts = (data.max_attempts as number | undefined) ?? defaults?.max_attempts;
    if (data.name !== undefined) node.name = data.name as string;
    if (timeout !== undefined) node.timeout = timeout;
    if (maxAttempts !== undefined) node.max_attempts = maxAttempts;
    nodes.push(node);
  });

  const edges = validateEdges(c, rawEdges, declared, nodes, registry);
  if (nodes.length === rawNodes.length) validateGraph(c, nodes, edges, registry);

  if (c.issues.length > 0) return failure(c);

  const first = nodes[0];
  if (!first) return failure(c);
  const spec: PipelineSpec = { format, name, entry: first.slug, nodes, edges };
  if (description !== undefined) spec.description = description;
  return { ok: true, spec };
}

function validateEdges(
  c: Collector,
  rawEdges: unknown[],
  declared: Map<string, number>,
  nodes: NodeSpec[],
  registry: Registry,
): EdgeSpec[] {
  const bySlug = new Map(nodes.map((n) => [n.slug, n]));
  const edges: EdgeSpec[] = [];
  rawEdges.forEach((raw, j) => {
    const base: Path = ["edges", j];
    const parsed = edgeSchema.safeParse(raw);
    if (!parsed.success) {
      c.fromZod(parsed.error, base);
      return;
    }
    const { from, to } = parsed.data;
    let ok = true;
    for (const [field, slug] of [
      ["from", from],
      ["to", to],
    ] as const) {
      if (!declared.has(slug)) {
        c.add([...base, field], `edge ${field} refers to unknown node "${slug}"`);
        ok = false;
      }
    }
    if (from === to) {
      c.add(base, `edge from "${from}" to itself: use max_attempts to retry a node`);
      ok = false;
    }
    if (!ok) return;

    const source = bySlug.get(from);
    const handler = source ? registry.node(source.kind) : undefined;
    const labels = source && handler ? handler.labels(source) : undefined;
    const when = parsed.data.when ?? labels?.success[0] ?? "passed";
    if (labels) {
      const emits = [...new Set([...labels.success, ...labels.failure])];
      if (!emits.includes(when)) {
        c.add(
          [...base, "when"],
          `node "${from}" (kind ${source?.kind}) cannot emit "${when}" (it emits: ${emits.join(", ")})`,
        );
        return;
      }
    }
    edges.push({ from, to, when });
  });
  return edges;
}

function validateGraph(c: Collector, nodes: NodeSpec[], edges: EdgeSpec[], registry: Registry) {
  const index = new Map(nodes.map((n, i) => [n.slug, i]));

  // Every failure label of a node nobody else can retry must lead somewhere.
  nodes.forEach((node, i) => {
    const handler = registry.node(node.kind);
    if (!handler?.requiresRoutes) return;
    const { failure } = handler.labels(node);
    for (const label of new Set(failure)) {
      if (!edges.some((e) => e.from === node.slug && e.when === label)) {
        c.add(
          ["nodes", i, "slug"],
          `node "${node.slug}" (kind ${node.kind}) can fail with "${label}" but has no outgoing edge for it`,
        );
      }
    }
  });

  // Everything must be reachable from the first node.
  const entry = nodes[0];
  if (!entry) return;
  const seen = new Set([entry.slug]);
  const queue = [entry.slug];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const e of edges) {
      if (e.from === current && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  for (const node of nodes) {
    if (!seen.has(node.slug)) {
      c.add(
        ["nodes", index.get(node.slug) ?? 0, "slug"],
        `node "${node.slug}" is unreachable from the first node "${entry.slug}"`,
      );
    }
  }
}

function summarize(issues: SpecIssue[]): string {
  const first = issues[0];
  if (!first) return "pipeline is invalid";
  const where = first.line !== undefined ? ` (line ${first.line})` : "";
  const more = issues.length > 1 ? `, and ${issues.length - 1} more` : "";
  return `pipeline is invalid: ${first.message}${where}${more}`;
}

function failure(c: Collector): ParseResult {
  const issues = [...c.issues].sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9));
  return { ok: false, code: "PIPELINE_INVALID", message: summarize(issues), issues };
}

/** Parse and validate pipeline YAML; throws `KodelError` (`PIPELINE_INVALID` / `UNSUPPORTED_FORMAT`). */
export function parsePipeline(text: string, options: ParseOptions = {}): PipelineSpec {
  const result = validatePipeline(text, options);
  if (!result.ok) throw new KodelError(result.code, result.message, result.issues);
  return result.spec;
}
