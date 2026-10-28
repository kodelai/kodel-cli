/** Reads what the card of a run waiting at a human step shows, and writes the comments a person makes there. */
import type {
  JournalRecord,
  NextStep,
  PipelineSpec,
  ResultReport,
  RunState,
} from "@kodel-ai/pipeline-core";
import { logLines } from "./load";
import type {
  AgentWords,
  Attempt,
  ChangeSummary,
  CheckLine,
  Comment,
  DiffState,
  Finding,
  GateDetail,
  Metrics,
  StepState,
  Visit,
} from "./session";

type Changes =
  | { kind: "changes"; files: Record<string, number> }
  | { kind: "unavailable"; reason: string }
  | { kind: "no_repo" };

type Written = { ok: true } | { ok: false; code: string; message: string };

/** The part of a run the card reads and writes; `LocalRun` fits it. */
export interface GateRun {
  state(): Promise<RunState>;
  currentSpec(state?: RunState): Promise<PipelineSpec>;
  inspect(): Promise<NextStep>;
  journal(): Promise<JournalRecord[]>;
  changesSinceStart(): Promise<Changes>;
  changesSinceGate(node: string): Promise<Changes>;
  resultsOf(node: string, attempt: number): Promise<ResultReport | undefined>;
  agentReport?(since: number): Promise<{ text: string; ts: number } | undefined>;
  agentTokens?(): Promise<{ tokens: number; cost?: number; approx: boolean } | undefined>;
  diffOf?(path: string): Promise<{ text: string; truncated: boolean } | undefined>;
  reportResult?(
    node: string,
    attempt: number,
    raw: unknown,
    options?: { replace?: boolean },
  ): Promise<Written>;
}

export interface GateSource {
  open(runId: string): Promise<GateRun | undefined>;
}

/** How many steps after the current one are drawn; a pipeline with a loop must not draw forever. */
const LOOKAHEAD = 6;
const USUAL = ["passed", "approved"];

type Report = { completeness: string; findings: Finding[] };

/** The journal's account of one try, while it is being put together. */
interface Open extends Omit<Attempt, "log"> {
  enteredAt: number;
  records: JournalRecord[];
}

export async function loadGateDetail(
  source: GateSource,
  runId: string,
  now: number = Date.now(),
): Promise<GateDetail | undefined> {
  const run = await source.open(runId);
  if (!run) return undefined;
  const [state, journal, next] = await Promise.all([run.state(), run.journal(), run.inspect()]);
  if (!("waiting" in next) || next.waiting.reason !== "gate") return undefined;
  const waiting = next.waiting;
  const node = waiting.node_slug;
  const spec = await run.currentSpec(state);
  const gate = state.active.find((v) => v.node === node && v.phase === "human");
  const attempt = gate?.attempt ?? 1;
  const since = journal.findLast((r) => r.event === "gate_waiting" && r.node === node)?.ts;

  const [changed, afterGate, comments, reports, said, tokens] = await Promise.all([
    run.changesSinceStart().catch((e: unknown) => unavailable(e)),
    run.changesSinceGate(node).catch((e: unknown) => unavailable(e)),
    gate ? run.resultsOf(node, attempt).catch(() => undefined) : undefined,
    readReports(run, journal),
    run.agentReport?.(since ?? state.startedAt).catch(() => undefined),
    run.agentTokens?.().catch(() => undefined),
  ]);
  const visits = visitsOf(spec, journal, reports, node, attempt, now);
  const metrics = metricsOf(visits, state, now, tokens);
  return {
    node,
    attempt,
    position: positionOf(visits, node),
    prompt: waiting.prompt,
    ...(waiting.instructions ? { instructions: waiting.instructions } : {}),
    ...wordsOf(said, visits),
    visits,
    checks: latestChecks(visits),
    changes: summarize(changed),
    changedAfterChecks: afterGate.kind === "changes" ? Object.keys(afterGate.files) : [],
    comments: (comments?.rows ?? []).map(commentOf),
    metrics,
    journal: logLines(journal, now, journal.length),
  };
}

function unavailable(error: unknown): Changes {
  return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
}

function summarize(found: Changes): ChangeSummary {
  if (found.kind === "no_repo") return found;
  if (found.kind === "unavailable") return found;
  const files = Object.entries(found.files).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (files.length === 0) return { kind: "none" };
  return {
    kind: "files",
    files,
    totalFiles: files.length,
    totalLines: files.reduce((sum, [, lines]) => sum + lines, 0),
  };
}

const commentOf = (row: Record<string, unknown>): Comment => ({
  severity: String(row.severity ?? ""),
  location: String(row.location ?? ""),
  description: String(row.description ?? ""),
});

/** The agent's words at the gate: its log first; failing that, the last summary a step handed in. */
function wordsOf(
  said: { text: string; ts: number } | undefined,
  visits: Visit[],
): { report?: AgentWords } {
  if (said) return { report: { text: said.text, ts: said.ts, from: "log" } };
  const last = visits.findLast((v) => v.attempt.summary !== undefined);
  return last?.attempt.summary === undefined
    ? {}
    : { report: { text: last.attempt.summary, ts: 0, from: "journal" } };
}

/** Every result report a step handed in, by `node:attempt`. */
async function readReports(run: GateRun, journal: JournalRecord[]): Promise<Map<string, Report>> {
  const out = new Map<string, Report>();
  const accepted = journal.filter(
    (r) =>
      r.event === "report_accepted" && typeof r.node === "string" && typeof r.attempt === "number",
  );
  await Promise.all(
    accepted.map(async (r) => {
      const report = await run.resultsOf(String(r.node), Number(r.attempt)).catch(() => undefined);
      if (!report) return;
      out.set(`${r.node}:${r.attempt}`, {
        completeness: report.completeness,
        findings: report.rows.map(commentOf),
      });
    }),
  );
  return out;
}

/** What the journal says about each try at each step, in the order the steps were entered. */
function visitsOf(
  spec: PipelineSpec,
  journal: JournalRecord[],
  reports: Map<string, Report>,
  gate: string,
  gateAttempt: number,
  now: number,
): Visit[] {
  const tries = new Map<string, Open>();
  const order: { slug: string; n: number; rework: boolean }[] = [];
  const current = new Map<string, number>(); // the try a step is on now, for records without one
  const keyOf = (slug: string, n: number) => `${slug}:${n}`;
  for (const r of journal) {
    if (typeof r.node !== "string") continue;
    const n = typeof r.attempt === "number" ? r.attempt : current.get(r.node);
    if (n === undefined) continue;
    const key = keyOf(r.node, n);
    let a = tries.get(key);
    if (!a) {
      a = { n, checks: [], enteredAt: 0, records: [] };
      tries.set(key, a);
    }
    a.records.push(r);
    switch (r.event) {
      case "node_entered":
        current.set(r.node, n);
        a.enteredAt = r.ts;
        order.push({ slug: r.node, n, rework: r.rework === true });
        break;
      case "agent_completed":
        if (typeof r.summary === "string" && r.summary !== "") a.summary = r.summary;
        break;
      case "check_finished":
        if (typeof r.passed === "boolean") {
          a.checks.push({
            node: r.node,
            label: `${r.node} ${String(r.kind ?? "check")}`,
            passed: r.passed,
            ...(typeof r.duration_ms === "number" ? { ms: r.duration_ms } : {}),
          });
          if (!r.passed && typeof r.reason === "string") a.reason = r.reason;
        }
        break;
      case "command_finished":
        if (typeof r.passed === "boolean") {
          a.checks.push({
            node: r.node,
            label: r.node,
            passed: r.passed,
            ...(typeof r.duration_ms === "number" ? { ms: r.duration_ms } : {}),
          });
          if (typeof r.exit === "number") a.exit = r.exit;
          if (!r.passed && typeof r.reason === "string") a.reason = r.reason;
        }
        break;
      case "gate_decided":
        a.decision = {
          decision: String(r.decision ?? ""),
          ...(typeof r.reason === "string" && r.reason !== "" ? { reason: r.reason } : {}),
        };
        break;
      case "node_finished":
        a.outcome = String(r.outcome ?? "");
        a.ok = r.status === "passed";
        if (a.enteredAt > 0) a.ms = r.ts - a.enteredAt;
        break;
    }
  }
  const kindOf = (slug: string) => spec.nodes.find((n) => n.slug === slug)?.kind ?? "";
  const finish = ({ enteredAt, records, ...attempt }: Open): Attempt => {
    // A try still going has been going since it was entered.
    const ms = attempt.ms ?? (enteredAt > 0 ? Math.max(0, now - enteredAt) : undefined);
    return {
      ...attempt,
      ...(ms === undefined ? {} : { ms }),
      log: logLines(records, now, records.length),
    };
  };
  const visits: Visit[] = order.map(({ slug, n, rework }) => {
    const open = tries.get(keyOf(slug, n)) as Open;
    const report = reports.get(keyOf(slug, n));
    const attempt = finish(open);
    const withReport = report ? { ...attempt, review: report } : attempt;
    const waiting = slug === gate && n === gateAttempt && attempt.ok === undefined;
    const st: StepState =
      attempt.ok === true
        ? "done"
        : attempt.ok === false
          ? "failed"
          : waiting
            ? "waiting"
            : "running";
    return {
      slug,
      kind: kindOf(slug),
      human: kindOf(slug) === "human",
      state: st,
      rework,
      attempt: withReport,
    };
  });
  // Then where the usual outcomes lead from the gate, not yet entered.
  const seen = new Set(order.map((o) => o.slug));
  let at = gate;
  for (let i = 0; i < LOOKAHEAD; i++) {
    const edge = spec.edges.find((e) => e.from === at && USUAL.includes(e.when));
    if (!edge || seen.has(edge.to)) break;
    seen.add(edge.to);
    visits.push({
      slug: edge.to,
      kind: kindOf(edge.to),
      human: kindOf(edge.to) === "human",
      state: "pending",
      rework: false,
      attempt: { n: 0, checks: [], log: [] },
    });
    at = edge.to;
  }
  return visits;
}

function positionOf(visits: Visit[], node: string): string {
  const gates = [...new Set(visits.filter((v) => v.human).map((v) => v.slug))];
  return `gate ${gates.indexOf(node) + 1} of ${gates.length}`;
}

/** The latest try of each step is the one the verdict rests on. */
function latestOf(visits: Visit[]): Visit[] {
  const last = new Map<string, Visit>();
  for (const v of visits) if (v.attempt.n > 0) last.set(v.slug, v);
  return [...last.values()];
}

function latestChecks(visits: Visit[]): CheckLine[] {
  return latestOf(visits).flatMap((v) => v.attempt.checks);
}

function checkCounts(visits: Visit[]): Pick<Metrics, "checksPassed" | "checksTotal"> {
  const checks = latestChecks(visits);
  return { checksPassed: checks.filter((c) => c.passed).length, checksTotal: checks.length };
}

function metricsOf(
  visits: Visit[],
  state: RunState,
  now: number,
  tokens: { tokens: number; cost?: number; approx: boolean } | undefined,
): Metrics {
  const total = Math.max(0, (state.finishedAt ?? now) - state.startedAt);
  const entered = visits.filter((v) => v.attempt.n > 0);
  const waitMs = entered.filter((v) => v.human).reduce((sum, v) => sum + (v.attempt.ms ?? 0), 0);
  const slugs = [...new Set(visits.map((v) => v.slug))];
  const done = slugs.filter((slug) => visits.findLast((v) => v.slug === slug)?.state === "done");
  return {
    workMs: Math.max(0, total - waitMs),
    waitMs,
    stepsDone: done.length,
    stepsTotal: slugs.length,
    retries: entered.length - new Set(entered.map((v) => v.slug)).size,
    ...checkCounts(visits),
    ...(tokens === undefined
      ? {}
      : {
          tokens: {
            total: tokens.tokens,
            ...(tokens.cost === undefined ? {} : { cost: tokens.cost }),
            approx: tokens.approx,
          },
        }),
  };
}

/** The diff of one file, or why there is none. A failing read is an answer, not a crash. */
export async function loadDiff(
  source: GateSource,
  runId: string,
  path: string,
): Promise<DiffState> {
  try {
    const run = await source.open(runId);
    const found = await run?.diffOf?.(path);
    return found
      ? { kind: "text", text: found.text, truncated: found.truncated }
      : { kind: "missing" };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

async function writer(
  source: GateSource,
  runId: string,
): Promise<GateRun & Required<Pick<GateRun, "reportResult">>> {
  const run = await source.open(runId);
  if (!run?.reportResult) throw new Error(`run ${runId} cannot take comments`);
  return run as GateRun & Required<Pick<GateRun, "reportResult">>;
}

function check(result: Written): void {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
}

/** Records a comment at the gate, the way the agent records the ones it is told: a row of the report. */
export async function addComment(
  source: GateSource,
  runId: string,
  node: string,
  attempt: number,
  comment: Comment,
): Promise<void> {
  const run = await writer(source, runId);
  check(await run.reportResult(node, attempt, { rows: [comment] }));
}

/** Takes one comment out, by its place in the list, by writing the list again without it. */
export async function removeComment(
  source: GateSource,
  runId: string,
  node: string,
  attempt: number,
  index: number,
): Promise<void> {
  const run = await writer(source, runId);
  const rows = (await run.resultsOf(node, attempt))?.rows ?? [];
  if (index < 0 || index >= rows.length) throw new Error("that comment is already gone");
  check(
    await run.reportResult(
      node,
      attempt,
      { rows: rows.filter((_, i) => i !== index) },
      { replace: true },
    ),
  );
}
