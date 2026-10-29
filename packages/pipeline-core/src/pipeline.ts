/**
 * Pipeline spec: nodes, checks, edges; parsing and static validation.
 * Kind-specific rules come from the registry, so plugin kinds validate like built-in ones.
 */
import type { Document } from "yaml";
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import { z } from "zod";
import { type ErrorCode, KodelError } from "./errors";
import { defaultRegistry, labelsOf, RESTART_FAILED, type Registry } from "./registry";
import { MAX_SUPPORTED_MAJOR, parseVersion, resolveVersion } from "./version";

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
  /** Seconds per attempt; the node fails when it runs longer. */
  timeout?: number;
  /**
   * How long the node usually takes, in seconds. The agent is told, so it knows how long to wait
   * for engine work instead of guessing. It is a hint, never a limit (`timeout` is the limit).
   */
  expected_duration?: number;
  /**
   * Failed attempts in a row before the run pauses. Counts automatic failures only (a human
   * rejection is not one) and starts over when the node passes.
   */
  max_consecutive_failures: number;
  /** All attempts of this node in one run, re-entries after a human decision included. */
  max_attempts: number;
  /** Label emitted when the node itself fails (meaningful for `command` nodes). */
  on_fail: string;
  checks: CheckSpec[];
  /** Kind-specific parameters (`prompt`, `command`, `instructions`, ...). */
  params: Record<string, unknown>;
  /**
   * The node where the branches of a fork meet: it starts once every branch has arrived. A fork is
   * two or more edges with the same `from` and `when`; nested forks are not supported.
   */
  join?: "all";
}

export interface EdgeSpec {
  from: string;
  to: string;
  /** The outcome label that takes this edge. Several edges with the same `from` and `when` fork. */
  when: string;
}

export interface PipelineSpec {
  version: string;
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
  /** The project's `version`, used when the pipeline has none. */
  configVersion?: string | number;
}

/** Placeholders a pipeline may use in its strings. */
export const PLACEHOLDERS = ["task", "task.slug", "run.slug", "run.start_date"] as const;

const DEFAULT_ON_FAIL = "failed";
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_MAX_ATTEMPTS = 10;
const GENERIC_NODE_FIELDS = new Set([
  "slug",
  "name",
  "kind",
  "timeout",
  "expected_duration",
  "max_consecutive_failures",
  "max_attempts",
  "on_fail",
  "checks",
  "join",
]);

const nonEmpty = z.string().min(1);
const positiveInt = z.number().int().positive();

export const topSchema = z
  .object({
    // Validated by `resolveVersion`, so every bad value gets the same message with the accepted forms.
    version: z
      .unknown()
      .optional()
      .describe(
        'A positive integer (1) or a quoted semver string ("1.0.0"); if absent, the project config\'s, then 1.',
      ),
    name: nonEmpty.describe("The pipeline's name; what the user asks to run."),
    description: z.string().optional().describe("One line on what the pipeline is for."),
    defaults: z
      .object({
        timeout: positiveInt.optional(),
        max_consecutive_failures: positiveInt.optional(),
        max_attempts: positiveInt.optional(),
      })
      .strict()
      .optional()
      .describe(
        "Values for timeout, max_consecutive_failures and max_attempts that a node does not set.",
      ),
    nodes: z.array(z.unknown()).min(1).describe("The steps; the first one is where a run starts."),
    // `edges:` with nothing under it reads as null; that means no edges.
    edges: z
      .array(z.unknown())
      .nullish()
      .describe("Where a run goes after a node: { from, to, when }."),
  })
  .strict();

export const commonNodeShape = {
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "slug must be lowercase letters, digits and dashes")
    .describe("The step's id: lowercase letters, digits and dashes. Edges and reports use it."),
  name: nonEmpty.optional().describe("A title for people; the slug is used if absent."),
  kind: nonEmpty.describe("What the step does; the node kinds are listed below."),
  timeout: positiveInt.optional().describe("Seconds an attempt may take; the limit."),
  expected_duration: positiveInt
    .optional()
    .describe("Seconds a step usually takes; a hint, not a limit."),
  max_consecutive_failures: positiveInt
    .optional()
    .describe("Automatic failures in a row before the run pauses."),
  max_attempts: positiveInt
    .optional()
    .describe("All attempts of the step in a run, rejections included."),
  join: z
    .literal("all")
    .optional()
    .describe(
      "Where the branches of a fork meet (a fork: several edges with the same from and when). The step starts when every branch has arrived; an agent join may finish with restart_failed to run the failed branches again.",
    ),
};

export const edgeSchema = z
  .object({
    from: nonEmpty.describe("The slug of the node the edge leaves."),
    to: nonEmpty.describe("The slug of the node it goes to."),
    when: nonEmpty
      .optional()
      .describe("The label that takes the edge; the node's success label if absent."),
  })
  .strict();

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
          'injected into the shell; use "{{task.slug}}" or "{{run.slug}}" instead',
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

  // The version is checked first: a newer version may legitimately have fields we do not know.
  if (root.version !== undefined) {
    let major = 0;
    try {
      major = parseVersion(root.version).major;
    } catch {
      // Malformed values are reported with the other issues below.
    }
    if (major > MAX_SUPPORTED_MAJOR) {
      const message = `version ${String(root.version)} is newer than this engine supports (max major ${MAX_SUPPORTED_MAJOR}); upgrade kodel`;
      c.add(["version"], message);
      return { ok: false, code: "UNSUPPORTED_FORMAT", message, issues: c.issues };
    }
  }

  const top = topSchema.safeParse(root);
  if (!top.success) {
    c.fromZod(top.error, []);
    return failure(c);
  }
  const { name, description, defaults, nodes: rawNodes } = top.data;
  const rawEdges = top.data.edges ?? [];

  let version = "1.0.0";
  try {
    version = resolveVersion(top.data.version, options.configVersion);
  } catch (e) {
    if (e instanceof KodelError && e.code === "UNSUPPORTED_FORMAT") {
      return { ok: false, code: e.code, message: e.message, issues: [] };
    }
    c.add(["version"], e instanceof Error ? e.message : String(e));
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
    const maxConsecutive =
      (data.max_consecutive_failures as number | undefined) ??
      defaults?.max_consecutive_failures ??
      DEFAULT_MAX_CONSECUTIVE_FAILURES;
    const maxAttempts =
      (data.max_attempts as number | undefined) ?? defaults?.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
    if (maxConsecutive > maxAttempts) {
      c.add(
        [...base, "max_consecutive_failures"],
        `max_consecutive_failures (${maxConsecutive}) must not exceed max_attempts (${maxAttempts})`,
        [
          ...base,
          typeof data.max_consecutive_failures === "number" ? "max_consecutive_failures" : "slug",
        ],
      );
    }
    const node: NodeSpec = {
      slug: data.slug as string,
      kind,
      max_consecutive_failures: maxConsecutive,
      max_attempts: maxAttempts,
      on_fail: (data.on_fail as string | undefined) ?? DEFAULT_ON_FAIL,
      checks,
      params,
    };
    const timeout = (data.timeout as number | undefined) ?? defaults?.timeout;
    const expected = data.expected_duration as number | undefined;
    if (expected !== undefined && timeout !== undefined && expected > timeout) {
      c.add(
        [...base, "expected_duration"],
        `expected_duration (${expected} s) must not exceed the timeout (${timeout} s)`,
        [...base, "expected_duration"],
      );
    }
    if (data.name !== undefined) node.name = data.name as string;
    if (timeout !== undefined) node.timeout = timeout;
    if (expected !== undefined) node.expected_duration = expected;
    if (data.join !== undefined) node.join = data.join as "all";
    nodes.push(node);
  });

  const edges = validateEdges(c, rawEdges, declared, nodes, registry);
  if (nodes.length === rawNodes.length) {
    // Over the valid edges, so one pass reports a bad edge and what the graph lacks besides. The
    // fork rules read the whole shape and would blame it for an edge that was dropped: they wait.
    validateGraph(c, nodes, edges, registry);
    if (edges.length === rawEdges.length) validateParallel(c, nodes, edges, registry);
  }

  if (c.issues.length > 0) return failure(c);

  const first = nodes[0];
  if (!first) return failure(c);
  const spec: PipelineSpec = { version, name, entry: first.slug, nodes, edges };
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
  const seen = new Set<string>();
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
      c.add(
        base,
        `edge from "${from}" to itself is not allowed (agent nodes are retried automatically)`,
      );
      ok = false;
    }
    if (!ok) return;

    const source = bySlug.get(from);
    const labels = source ? labelsOf(registry, source) : undefined;
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
    if (when === RESTART_FAILED) {
      // The engine itself runs the failed branches again on that outcome; `route` never follows an
      // edge for it, so one would be dead.
      c.add(
        [...base, "when"],
        `edge from "${from}" when "${RESTART_FAILED}" is never taken: the engine runs the failed branches again on that outcome itself; leave the edge out`,
      );
      return;
    }
    const key = JSON.stringify([from, to, when]);
    if (seen.has(key)) {
      c.add(base, `edge from "${from}" to "${to}" when "${when}" is listed twice`);
      return;
    }
    seen.add(key);
    edges.push({ from, to, when });
  });
  return edges;
}

/** The nodes reachable from `start` along `edges`, not expanding the nodes in `stop` (they are not included). */
function reachFrom(start: string[], edges: EdgeSpec[], stop: (slug: string) => boolean) {
  const seen = new Set<string>();
  const queue = start.filter((slug) => !stop(slug));
  for (const slug of queue) seen.add(slug);
  for (let slug = queue.shift(); slug !== undefined; slug = queue.shift()) {
    for (const edge of edges) {
      if (edge.from !== slug || seen.has(edge.to) || stop(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return seen;
}

/**
 * Forks and joins. Two or more edges with the same `from` and `when` start their targets together;
 * the branches must all lead to one `join: all` node, stay apart from each other and from the rest
 * of the pipeline, and not fork again. The rules are static so a run can never leave a branch open
 * with nobody to wait for it.
 */
function validateParallel(c: Collector, nodes: NodeSpec[], edges: EdgeSpec[], registry: Registry) {
  const index = new Map(nodes.map((n, i) => [n.slug, i]));
  const atNode = (slug: string): Path => ["nodes", index.get(slug) ?? 0, "slug"];
  const joins = new Set(nodes.filter((n) => n.join !== undefined).map((n) => n.slug));

  const groups = new Map<string, number[]>();
  edges.forEach((edge, j) => {
    const key = JSON.stringify([edge.from, edge.when]);
    groups.set(key, [...(groups.get(key) ?? []), j]);
  });
  const forks = [...groups.values()]
    .filter((js) => js.length >= 2)
    .map((js) => {
      const first = edges[js[0] as number] as EdgeSpec;
      return {
        from: first.from,
        when: first.when,
        at: js,
        heads: js.map((j) => (edges[j] as EdgeSpec).to),
      };
    });

  const forkFroms = new Set<string>();
  for (const fork of forks) {
    if (forkFroms.has(fork.from)) {
      c.add(
        atNode(fork.from),
        `node "${fork.from}" forks on more than one label; a node starts branches on one label only`,
      );
    }
    forkFroms.add(fork.from);
  }

  const usedJoins = new Map<string, string>();
  // Joins a fork leads to, even when that fork is refused: they are not "joins without a fork".
  const claimed = new Set<string>();
  for (const fork of forks) {
    const { from, when, heads } = fork;
    const at: Path = ["edges", fork.at[0] as number];
    const where = `the fork at "${from}" ("${when}")`;
    // What the branches reach without passing a join, loops and all: enough to see whether there is
    // a join to speak of, and whether a branch forks again.
    const loose = reachFrom(heads, edges, (slug) => joins.has(slug));
    for (const head of heads) if (joins.has(head)) claimed.add(head);
    for (const edge of edges) if (joins.has(edge.to) && loose.has(edge.from)) claimed.add(edge.to);
    const reached = [...claimed].filter(
      (join) => heads.includes(join) || edges.some((e) => e.to === join && loose.has(e.from)),
    );
    if (reached.length === 0) {
      c.add(
        at,
        `node "${from}" has ${heads.length} edges for "${when}": they start all of those steps together (a fork), which needs a \`join: all\` node where the branches meet (a second edge with the same \`when\` used to be ignored)`,
      );
      continue;
    }
    const nested = [...loose].find((slug) => slug !== from && forkFroms.has(slug));
    if (nested !== undefined) {
      c.add(
        atNode(nested),
        `node "${nested}" forks inside a branch of ${where}; a fork inside a fork is not supported`,
      );
      continue;
    }
    if (reached.length > 1) {
      c.add(
        at,
        `the branches of ${where} lead to several \`join: all\` nodes (${reached.map((j) => `"${j}"`).join(", ")}); a fork has one join`,
      );
      continue;
    }
    const join = reached[0] as string;
    const other = usedJoins.get(join);
    if (other !== undefined) {
      c.add(
        atNode(join),
        `node "${join}" is the join of two forks ("${other}" and "${from}"); a join ends one fork`,
      );
      continue;
    }
    usedJoins.set(join, from);
    // What lies after the join, up to the heads and the fork node (a loop from after the join back
    // to the fork is the normal way to run a fork again). A branch is what its head reaches without
    // passing the join, the fork node or anything after the join; an edge out of that is a branch
    // leaving, said below with the edge.
    const after = reachFrom(
      [join],
      edges,
      (slug) => slug !== join && (heads.includes(slug) || slug === from),
    );
    // A branch whose head is the join itself has no steps: it arrives as soon as the fork starts.
    const branches = heads.map((head) =>
      joins.has(head)
        ? new Set<string>()
        : reachFrom([head], edges, (slug) => joins.has(slug) || after.has(slug) || slug === from),
    );
    const inside = (slug: string) => branches.some((b) => b.has(slug));
    const region = new Set(branches.flatMap((b) => [...b]));
    const forkNode = nodes[index.get(from) ?? -1];
    const onFailure = forkNode ? labelsOf(registry, forkNode)?.failure.includes(when) : false;

    for (const [i, head] of heads.entries()) {
      if (head === join && onFailure === true) {
        // Such a branch arrives failed the moment the fork starts, and `restart_failed` would run
        // the join itself again as a branch.
        c.add(
          ["edges", fork.at[i] as number],
          `edge from "${from}" to "${join}" when "${when}" is a branch with no step of its own; on a failure label every branch of ${where} needs a step before the join`,
        );
      }
      if (head !== join && (after.has(head) || head === from)) {
        c.add(
          ["edges", fork.at[i] as number],
          `edge from "${from}" to "${head}" when "${when}" starts a branch at a step that is reached after the join "${join}" or is the fork node itself`,
        );
      }
      for (let k = 0; k < i; k++) {
        const shared = [...(branches[i] ?? [])].filter(
          (slug) => slug !== join && branches[k]?.has(slug),
        );
        if (shared.length > 0) {
          c.add(
            atNode(shared[0] as string),
            `node "${shared[0]}" is reached by two branches of ${where} ("${heads[k]}" and "${head}"); branches do not share steps`,
          );
        }
      }
    }
    // The nodes of each branch from which the join can still be reached along the branch's own
    // edges: a step that has edges but only loops (a -> b -> a) would hold the fork open for good.
    const reaching = new Set<string>();
    for (const edge of edges)
      if (edge.to === join && region.has(edge.from)) reaching.add(edge.from);
    for (let grew = true; grew; ) {
      grew = false;
      for (const edge of edges) {
        if (!reaching.has(edge.to) || !region.has(edge.from) || reaching.has(edge.from)) continue;
        reaching.add(edge.from);
        grew = true;
      }
    }
    for (const slug of region) {
      const node = nodes[index.get(slug) ?? -1];
      const success = node ? labelsOf(registry, node)?.success[0] : undefined;
      const outs = edges.filter((e) => e.from === slug);
      if (success !== undefined && !outs.some((e) => e.when === success)) {
        c.add(
          atNode(slug),
          `node "${slug}" is in a branch of ${where} and has no edge for "${success}"; every branch must reach the join "${join}"`,
        );
      } else if (!reaching.has(slug)) {
        const head = heads[branches.findIndex((b) => b.has(slug))];
        c.add(
          atNode(slug),
          `node "${slug}" is in the branch "${head}" of ${where} and none of its ways on leads to the join "${join}"; the branch could never arrive`,
        );
      }
      for (const edge of outs) {
        if (edge.to === join || inside(edge.to)) continue;
        c.add(
          ["edges", edges.indexOf(edge)],
          `edge from "${slug}" to "${edge.to}" leaves a branch of ${where}; a branch may only lead on inside itself or to the join "${join}"`,
        );
      }
    }
    for (const edge of edges) {
      const entersBranch = inside(edge.to) || edge.to === join;
      if (!entersBranch || inside(edge.from)) continue;
      if (edge.from === from && edge.when === when) continue;
      c.add(
        ["edges", edges.indexOf(edge)],
        edge.to === join
          ? `edge from "${edge.from}" enters the join "${join}" from outside ${where}; only its branches arrive there`
          : `edge from "${edge.from}" to "${edge.to}" enters a branch of ${where} from outside; a branch starts only at the fork`,
      );
    }
  }

  for (const join of joins) {
    if (usedJoins.has(join) || claimed.has(join)) continue;
    c.add(
      atNode(join),
      `node "${join}" has \`join: all\` but no fork leads to it (a fork is two or more edges with the same from and when)`,
    );
  }
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

  // Every other way a node may end well (an agent's `outcomes`) must lead somewhere, and cannot also
  // be a way to fail: an outcome nobody follows would end the run by accident. The reserved outcome
  // of a join is the exception: the engine itself handles it, and nobody lists it.
  nodes.forEach((node, i) => {
    const handler = registry.node(node.kind);
    if (!handler) return;
    if (handler.labels(node).success.includes(RESTART_FAILED)) {
      c.add(
        ["nodes", i, "slug"],
        `node "${node.slug}": "${RESTART_FAILED}" is reserved for a join (it is there on every \`join: all\` step of this kind); do not list it in outcomes`,
      );
    }
    const { success, failure } = labelsOf(registry, node) ?? handler.labels(node);
    for (const label of success.slice(1)) {
      if (label === RESTART_FAILED) continue;
      if (failure.includes(label)) {
        c.add(
          ["nodes", i, "slug"],
          `node "${node.slug}": "${label}" is both an outcome and a way to fail`,
        );
      } else if (!edges.some((e) => e.from === node.slug && e.when === label)) {
        c.add(
          ["nodes", i, "slug"],
          `node "${node.slug}" can finish with "${label}" but has no outgoing edge for it`,
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
