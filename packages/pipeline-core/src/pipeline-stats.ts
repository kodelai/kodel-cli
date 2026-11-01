/**
 * How a pipeline fares over many runs: per step, how long it takes, how often it sends the run
 * back and why, what it finds, what a person says at it, and what it costs. Pure, like `summarizeRun`
 * that it reads: a host gathers the reports of the runs and prints the result.
 */
import type { NodeForms } from "./canonical";
import type { AttemptReport, RunReport } from "./report";

/** One run of the pipeline as its report tells it, and when it began. */
export interface StatsRun {
  runId: string;
  at: number;
  report: RunReport;
}

export interface StatsOptions {
  /**
   * `current`: only the attempts that ran on the definition the pipeline has now (the steps whose
   * definition is not known are kept whole). `all`: every attempt there is.
   */
  scope: "current" | "all";
  /** The definition of each step now, as the fingerprints an attempt carries. */
  current?: Record<string, NodeForms>;
  /** The order of the steps in the pipeline now; steps it does not list follow, as they were met. */
  order?: string[];
}

export interface Spread {
  n: number;
  mean: number;
  median: number;
  p90: number;
  max: number;
}

export interface NodeStats {
  node: string;
  gate: boolean;
  /** Runs that reached the step, and attempts it took, over those runs. */
  runs: number;
  attempts: number;
  /** Attempts per run that reached the step; above 1 is rework. */
  perRun: number;
  /** Attempts that ended in a failure (a check, the step's command, or a person's rejection). */
  failed: number;
  /** How the attempts ended, by outcome label. */
  outcomes: Record<string, number>;
  /** Why attempts failed: where it came from and the words, most frequent first. */
  failures: { source: string; reason: string; n: number }[];
  /** Seconds of an attempt: work at a step, waiting for a person at a gate. */
  seconds: Spread;
  /** Attempts that reported findings, how many rows, and how severe. */
  findings: { attempts: number; rows: number; bySeverity: Record<string, number> };
  /** At a gate: what the people decided, and whether they said why. */
  decisions?: {
    approved: number;
    rejected: number;
    rejectedWithReason: number;
    /** The latest words of a rejection, newest last. */
    reasons: string[];
  };
  /** Attempts of the step that the scope left out: they ran on another definition. */
  elsewhere: number;
  /** Over the attempts that recorded their usage. */
  usage: {
    attempts: number;
    /** How many of those attempts have a price (a model without one has none); `usd` is over these. */
    priced: number;
    usd: number;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  };
}

/** One definition of a step, with everything a step shows, counted over the attempts that ran on it. */
export interface NodeVersion extends Omit<NodeStats, "node" | "elsewhere"> {
  /** 1 for the oldest definition seen. */
  index: number;
  /** The definition is the one the pipeline has now. */
  current: boolean;
  /** What differs from the version before: the work, the checks, the routing. */
  changed: ("work" | "checks" | "routing")[];
  firstSeen: number;
  /** The fingerprints of the definition, which a host can look the text of up by. */
  definition: NodeForms;
}

export interface NodeVersions {
  node: string;
  versions: NodeVersion[];
}

export interface PipelineStats {
  scope: StatsOptions["scope"];
  runs: {
    total: number;
    /** Runs with at least one attempt in the scope. */
    used: number;
    byStatus: Record<string, number>;
  };
  attempts: {
    total: number;
    inScope: number;
    /** Attempts that say which definition they ran on; older runs do not. */
    withDefinition: number;
    withUsage: number;
  };
  /** Per finished run, in seconds. */
  seconds: { total: Spread; work: Spread; waiting: Spread };
  nodes: NodeStats[];
  /** The steps whose definition changed, with what the attempts on each version show. */
  versions: NodeVersions[];
}

const EMPTY: Spread = { n: 0, mean: 0, median: 0, p90: 0, max: 0 };

export function spread(values: number[]): Spread {
  if (values.length === 0) return EMPTY;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    n: sorted.length,
    mean: sum / sorted.length,
    median: at(0.5),
    p90: at(0.9),
    max: sorted.at(-1) ?? 0,
  };
}

/** An attempt that came to an end with a verdict; one still going, or cut off by a change, has none. */
const ended = (a: AttemptReport) => a.outcome !== undefined && a.outcome !== "superseded";

const sameDefinition = (a: AttemptReport, d: NodeForms | undefined): boolean =>
  d !== undefined &&
  a.definition !== undefined &&
  a.definition.work === d.work &&
  a.definition.checks === d.checks &&
  a.definition.routing === d.routing;

const rowsOf = (a: AttemptReport): number | undefined => {
  if (a.findings) return Object.values(a.findings).reduce((s, n) => s + n, 0);
  if (a.reports && a.reports.length > 0) return a.reports.reduce((s, r) => s + r.rows, 0);
  return undefined;
};

const WORDS = 110;
const brief = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > WORDS ? `${flat.slice(0, WORDS - 1)}…` : flat;
};

/** What the attempts of a step, or of one version of it, show: how they ended, why, what they found, what they cost. */
function describeAttempts(
  node: string,
  gate: boolean,
  runs: number,
  attempts: AttemptReport[],
): Omit<NodeStats, "elsewhere"> {
  const outcomes: Record<string, number> = {};
  const failures = new Map<string, { source: string; reason: string; n: number }>();
  const findings = { attempts: 0, rows: 0, bySeverity: {} as Record<string, number> };
  const usage = {
    attempts: 0,
    priced: 0,
    usd: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
  };
  const decisions = { approved: 0, rejected: 0, rejectedWithReason: 0, reasons: [] as string[] };
  let failed = 0;
  for (const a of attempts) {
    const label = a.outcome ?? "?";
    outcomes[label] = (outcomes[label] ?? 0) + 1;
    if (a.failure) {
      failed++;
      const reason = brief(a.failure.reason);
      const key = `${a.failure.source}\u0000${reason}`;
      const row = failures.get(key) ?? { source: a.failure.source, reason, n: 0 };
      row.n++;
      failures.set(key, row);
    }
    const rows = rowsOf(a);
    if (rows !== undefined) {
      findings.attempts++;
      findings.rows += rows;
      // Rows that a host did not count by severity are still rows: the breakdown adds up to the total.
      for (const [severity, n] of Object.entries(a.findings ?? { unspecified: rows })) {
        findings.bySeverity[severity] = (findings.bySeverity[severity] ?? 0) + n;
      }
    }
    if (a.usage) {
      usage.attempts++;
      if (a.usage.usd !== null) {
        usage.priced++;
        usage.usd += a.usage.usd;
      }
      usage.input += a.usage.input;
      usage.output += a.usage.output;
      usage.cache_read += a.usage.cache_read;
      usage.cache_write += a.usage.cache_write;
    }
    if (a.decision) {
      if (a.decision.outcome === "rejected") {
        decisions.rejected++;
        if (a.decision.reason !== undefined) {
          decisions.rejectedWithReason++;
          decisions.reasons.push(brief(a.decision.reason));
        }
      } else {
        decisions.approved++;
      }
    }
  }
  return {
    node,
    gate,
    runs,
    attempts: attempts.length,
    perRun: runs === 0 ? 0 : attempts.length / runs,
    failed,
    outcomes,
    failures: [...failures.values()].sort((a, b) => b.n - a.n).slice(0, 5),
    seconds: spread(attempts.map((a) => a.seconds)),
    findings,
    ...(gate ? { decisions: { ...decisions, reasons: decisions.reasons.slice(-5) } } : {}),
    usage,
  };
}

export function summarizePipeline(runs: StatsRun[], options: StatsOptions): PipelineStats {
  const ordered = [...runs].sort((a, b) => a.at - b.at);
  const inScope = (node: string, a: AttemptReport) =>
    options.scope === "all" ||
    options.current?.[node] === undefined ||
    sameDefinition(a, options.current[node]);

  const byNode = new Map<string, { run: StatsRun; gate: boolean; attempts: AttemptReport[] }[]>();
  const met: string[] = [];
  /** Per step: the attempts the scope left out, and whether a person decides there. */
  const elsewhere = new Map<string, number>();
  const gateNodes = new Set<string>();
  const byStatus: Record<string, number> = {};
  let total = 0;
  let withDefinition = 0;
  let withUsage = 0;
  let used = 0;
  let scoped = 0;

  for (const run of ordered) {
    byStatus[run.report.status] = (byStatus[run.report.status] ?? 0) + 1;
    let any = false;
    for (const node of run.report.nodes) {
      const attempts = node.attempts.filter(ended);
      total += attempts.length;
      withDefinition += attempts.filter((a) => a.definition).length;
      withUsage += attempts.filter((a) => a.usage).length;
      const mine = attempts.filter((a) => inScope(node.node, a));
      scoped += mine.length;
      if (node.gate) gateNodes.add(node.node);
      elsewhere.set(node.node, (elsewhere.get(node.node) ?? 0) + attempts.length - mine.length);
      if (mine.length === 0) continue;
      any = true;
      if (!byNode.has(node.node)) {
        byNode.set(node.node, []);
        met.push(node.node);
      }
      byNode.get(node.node)?.push({ run, gate: node.gate, attempts: mine });
    }
    if (any) used++;
  }

  const order = [...(options.order ?? []), ...met.filter((n) => !options.order?.includes(n))];
  const nodes: NodeStats[] = order.flatMap((name) => {
    const visits = byNode.get(name);
    if (!visits) {
      // A step the pipeline has is listed even when nothing has run on its present definition yet.
      if (!options.order?.includes(name)) return [];
      return [
        {
          node: name,
          gate: gateNodes.has(name),
          runs: 0,
          attempts: 0,
          perRun: 0,
          failed: 0,
          outcomes: {},
          failures: [],
          seconds: EMPTY,
          findings: { attempts: 0, rows: 0, bySeverity: {} },
          usage: {
            attempts: 0,
            priced: 0,
            usd: 0,
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
          },
          elsewhere: elsewhere.get(name) ?? 0,
        },
      ];
    }
    const gate = visits.some((v) => v.gate);
    return [
      {
        ...describeAttempts(
          name,
          gate,
          visits.length,
          visits.flatMap((v) => v.attempts),
        ),
        elsewhere: elsewhere.get(name) ?? 0,
      },
    ];
  });

  const finished = ordered.filter((r) =>
    ["completed", "failed", "canceled"].includes(r.report.status),
  );
  return {
    scope: options.scope,
    runs: { total: ordered.length, used, byStatus },
    attempts: { total, inScope: scoped, withDefinition, withUsage },
    seconds: {
      total: spread(finished.map((r) => r.report.total_s)),
      work: spread(finished.map((r) => r.report.work_s)),
      waiting: spread(finished.map((r) => r.report.waiting_s)),
    },
    nodes,
    versions: versionsOf(ordered, order, options),
  };
}

/** The attempts of each step grouped by the definition they ran on, oldest definition first. */
function versionsOf(ordered: StatsRun[], order: string[], options: StatsOptions): NodeVersions[] {
  type Group = {
    key: string;
    definition: NonNullable<AttemptReport["definition"]>;
    firstSeen: number;
    gate: boolean;
    runs: Set<string>;
    attempts: AttemptReport[];
  };
  const groups = new Map<string, Map<string, Group>>();
  for (const run of ordered) {
    for (const node of run.report.nodes) {
      for (const a of node.attempts.filter(ended)) {
        if (!a.definition) continue;
        const key = `${a.definition.work}|${a.definition.checks}|${a.definition.routing}`;
        const forNode = groups.get(node.node) ?? new Map<string, Group>();
        groups.set(node.node, forNode);
        const group = forNode.get(key) ?? {
          key,
          definition: a.definition,
          firstSeen: run.at,
          gate: false,
          runs: new Set<string>(),
          attempts: [],
        };
        group.runs.add(run.runId);
        group.gate ||= node.gate;
        group.attempts.push(a);
        forNode.set(key, group);
      }
    }
  }
  const names = [...groups.keys()].sort((a, b) => {
    const rank = (n: string) => (order.indexOf(n) === -1 ? order.length : order.indexOf(n));
    return rank(a) - rank(b);
  });
  return names.flatMap((node) => {
    const list = [...(groups.get(node)?.values() ?? [])].sort((a, b) => a.firstSeen - b.firstSeen);
    if (list.length < 2) return [];
    const now = options.current?.[node];
    return [
      {
        node,
        versions: list.map((g, i): NodeVersion => {
          const before = list[i - 1]?.definition;
          return {
            ...describeAttempts(node, g.gate, g.runs.size, g.attempts),
            index: i + 1,
            current:
              now !== undefined &&
              g.definition.work === now.work &&
              g.definition.checks === now.checks &&
              g.definition.routing === now.routing,
            changed: before
              ? (["work", "checks", "routing"] as const).filter(
                  (part) => before[part] !== g.definition[part],
                )
              : [],
            firstSeen: g.firstSeen,
            definition: g.definition,
          };
        }),
      },
    ];
  });
}
