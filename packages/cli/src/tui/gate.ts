/** Reads what the card of a run waiting at a human step shows. Read-only, and slow enough (git) to be asked for one run at a time. */
import type {
  JournalRecord,
  NextStep,
  PipelineSpec,
  ResultReport,
  RunState,
} from "@kodel-ai/pipeline-core";
import { logLines } from "./load";
import type {
  Attempt,
  ChangeSummary,
  CheckLine,
  Finding,
  GateDetail,
  StepDetail,
  StepState,
} from "./session";

type Changes =
  | { kind: "changes"; files: Record<string, number> }
  | { kind: "unavailable"; reason: string }
  | { kind: "no_repo" };

/** The part of a run the card reads; `LocalRun` fits it. */
export interface GateRun {
  state(): Promise<RunState>;
  currentSpec(state?: RunState): Promise<PipelineSpec>;
  inspect(): Promise<NextStep>;
  journal(): Promise<JournalRecord[]>;
  changesSinceStart(): Promise<Changes>;
  changesSinceGate(node: string): Promise<Changes>;
  resultsOf(node: string, attempt: number): Promise<ResultReport | undefined>;
}

export interface GateSource {
  open(runId: string): Promise<GateRun | undefined>;
}

const NODE_STATE: Record<string, StepState> = {
  pending: "pending",
  running: "running",
  rework: "running",
  waiting: "waiting",
  passed: "done",
  failed: "failed",
  skipped: "pending",
};

/** How many steps after the current one are drawn; a pipeline with a loop must not draw forever. */
const LOOKAHEAD = 6;
const USUAL = ["passed", "approved"];

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
  const visit = state.active.find((v) => v.node === node && v.phase === "human");

  const [since, afterGate, comments, reports] = await Promise.all([
    run.changesSinceStart().catch((e: unknown) => unavailable(e)),
    run.changesSinceGate(node).catch((e: unknown) => unavailable(e)),
    visit ? run.resultsOf(node, visit.attempt).catch(() => undefined) : undefined,
    readReports(run, journal),
  ]);
  const steps = stepsOf(spec, state, journal, reports, node);
  return {
    node,
    position: positionOf(steps, node),
    prompt: waiting.prompt,
    ...(waiting.instructions ? { instructions: waiting.instructions } : {}),
    steps,
    checks: latestChecks(steps),
    changes: summarize(since),
    changedAfterChecks: afterGate.kind === "changes" ? Object.keys(afterGate.files) : [],
    comments: comments?.rows.length ?? 0,
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

/** Every result report a step handed in, by `node:attempt`. */
async function readReports(
  run: GateRun,
  journal: JournalRecord[],
): Promise<Map<string, { completeness: string; findings: Finding[] }>> {
  const out = new Map<string, { completeness: string; findings: Finding[] }>();
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
        findings: report.rows.map((row) => ({
          severity: String(row.severity ?? ""),
          location: String(row.location ?? ""),
          description: String(row.description ?? ""),
        })),
      });
    }),
  );
  return out;
}

/** The steps the run walked, then the ones the usual outcomes lead to. */
function stepsOf(
  spec: PipelineSpec,
  state: RunState,
  journal: JournalRecord[],
  reports: Map<string, { completeness: string; findings: Finding[] }>,
  current: string,
): StepDetail[] {
  const attempts = attemptsOf(journal, reports);
  const kindOf = (slug: string) => spec.nodes.find((n) => n.slug === slug)?.kind ?? "";
  const step = (slug: string, st: StepState): StepDetail => ({
    slug,
    kind: kindOf(slug),
    state: st,
    human: kindOf(slug) === "human",
    attempts: attempts.get(slug) ?? [],
  });
  const seen = new Set<string>();
  const out: StepDetail[] = [];
  for (const slug of state.trail) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const run = state.nodes[slug];
    if (run) out.push(step(slug, NODE_STATE[run.status] ?? "pending"));
  }
  let at = current;
  for (let i = 0; i < LOOKAHEAD; i++) {
    const edge = spec.edges.find((e) => e.from === at && USUAL.includes(e.when));
    if (!edge || seen.has(edge.to)) break;
    seen.add(edge.to);
    out.push(step(edge.to, "pending"));
    at = edge.to;
  }
  return out;
}

/** What the journal says about each try at each step. */
function attemptsOf(
  journal: JournalRecord[],
  reports: Map<string, { completeness: string; findings: Finding[] }>,
): Map<string, Attempt[]> {
  const byNode = new Map<string, Map<number, Attempt & { enteredAt: number }>>();
  const open = new Map<string, number>(); // the attempt a step is on now, for records without one
  const attemptOf = (node: string, n: number) => {
    let tries = byNode.get(node);
    if (!tries) {
      tries = new Map();
      byNode.set(node, tries);
    }
    let attempt = tries.get(n);
    if (!attempt) {
      attempt = { n, checks: [], enteredAt: 0 };
      tries.set(n, attempt);
    }
    return attempt;
  };
  for (const r of journal) {
    if (typeof r.node !== "string") continue;
    const n = typeof r.attempt === "number" ? r.attempt : open.get(r.node);
    if (n === undefined) continue;
    const a = attemptOf(r.node, n);
    switch (r.event) {
      case "node_entered":
        open.set(r.node, n);
        a.enteredAt = r.ts;
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
  const out = new Map<string, Attempt[]>();
  for (const [node, tries] of byNode) {
    out.set(
      node,
      [...tries.values()]
        .sort((x, y) => x.n - y.n)
        .map(({ enteredAt: _entered, ...attempt }) => {
          const review = reports.get(`${node}:${attempt.n}`);
          return review ? { ...attempt, review } : attempt;
        }),
    );
  }
  return out;
}

function positionOf(steps: StepDetail[], node: string): string {
  const gates = steps.filter((s) => s.human);
  const at = gates.findIndex((s) => s.slug === node) + 1;
  return `gate ${at} of ${gates.length}`;
}

/** The engine's own findings for the latest attempt of each step. */
function latestChecks(steps: StepDetail[]): CheckLine[] {
  return steps.flatMap((s) => s.attempts.at(-1)?.checks ?? []);
}
