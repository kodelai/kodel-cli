/** Reads what the card of a run waiting at a human step shows. Read-only, and slow enough (git) to be asked for one run at a time. */
import type {
  JournalRecord,
  NextStep,
  PipelineSpec,
  ResultReport,
  RunState,
} from "@kodel-ai/pipeline-core";
import type {
  ChangeSummary,
  CheckLine,
  DecisionLine,
  Finding,
  GateDetail,
  PathStep,
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
): Promise<GateDetail | undefined> {
  const run = await source.open(runId);
  if (!run) return undefined;
  const [state, journal, next] = await Promise.all([run.state(), run.journal(), run.inspect()]);
  if (!("waiting" in next) || next.waiting.reason !== "gate") return undefined;
  const waiting = next.waiting;
  const node = waiting.node_slug;
  const spec = await run.currentSpec(state);
  const path = pathOf(spec, state, node);
  const visit = state.active.find((v) => v.node === node && v.phase === "human");

  const [since, afterGate, comments, review] = await Promise.all([
    run.changesSinceStart().catch((e: unknown) => unavailable(e)),
    run.changesSinceGate(node).catch((e: unknown) => unavailable(e)),
    visit ? run.resultsOf(node, visit.attempt).catch(() => undefined) : undefined,
    reviewOf(run, journal, node),
  ]);
  return {
    node,
    position: positionOf(path, node),
    prompt: waiting.prompt,
    ...(waiting.instructions ? { instructions: waiting.instructions } : {}),
    path,
    checks: checksOf(journal, path),
    ...(review ? { review } : {}),
    changes: summarize(since),
    changedAfterChecks: afterGate.kind === "changes" ? Object.keys(afterGate.files) : [],
    decisions: decisionsOf(journal),
    comments: comments?.rows.length ?? 0,
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

/** The steps the run walked, then the ones the usual outcomes lead to. */
function pathOf(spec: PipelineSpec, state: RunState, current: string): PathStep[] {
  const kindOf = (slug: string) => spec.nodes.find((n) => n.slug === slug)?.kind;
  const step = (slug: string, st: StepState, attempts: number): PathStep => ({
    slug,
    state: st,
    human: kindOf(slug) === "human",
    ...(attempts > 1 ? { note: `×${attempts}` } : {}),
  });
  const seen = new Set<string>();
  const out: PathStep[] = [];
  for (const slug of state.trail) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const run = state.nodes[slug];
    if (run) out.push(step(slug, NODE_STATE[run.status] ?? "pending", run.attempt));
  }
  let at = current;
  for (let i = 0; i < LOOKAHEAD; i++) {
    const edge = spec.edges.find((e) => e.from === at && USUAL.includes(e.when));
    if (!edge || seen.has(edge.to)) break;
    seen.add(edge.to);
    out.push(step(edge.to, "pending", 0));
    at = edge.to;
  }
  return out;
}

function positionOf(path: PathStep[], node: string): string {
  const gates = path.filter((s) => s.human);
  const at = gates.findIndex((s) => s.slug === node) + 1;
  return `gate ${at} of ${gates.length}`;
}

/** The engine's own findings for the latest attempt of each step on the path. */
function checksOf(journal: JournalRecord[], path: PathStep[]): CheckLine[] {
  const latest = new Map<string, number>();
  for (const r of journal) {
    if (r.event === "node_entered" && typeof r.node === "string" && typeof r.attempt === "number") {
      latest.set(r.node, r.attempt);
    }
  }
  const lines: CheckLine[] = [];
  for (const slug of path.map((s) => s.slug)) {
    for (const r of journal) {
      if (r.node !== slug || r.attempt !== latest.get(slug) || typeof r.passed !== "boolean")
        continue;
      if (r.event !== "check_finished" && r.event !== "command_finished") continue;
      lines.push({
        node: slug,
        label: r.event === "check_finished" ? `${slug} ${String(r.kind ?? "check")}` : slug,
        passed: r.passed,
        ...(typeof r.duration_ms === "number" ? { ms: r.duration_ms } : {}),
      });
    }
  }
  return lines;
}

/** The findings of the last step that reported some, as the agent wrote them. */
async function reviewOf(run: GateRun, journal: JournalRecord[], gate: string) {
  const accepted = journal.findLast(
    (r) => r.event === "report_accepted" && r.node !== gate && typeof r.attempt === "number",
  );
  if (!accepted || typeof accepted.node !== "string" || typeof accepted.attempt !== "number") {
    return undefined;
  }
  const report = await run.resultsOf(accepted.node, accepted.attempt).catch(() => undefined);
  if (!report) return undefined;
  const findings: Finding[] = report.rows.map((row) => ({
    severity: String(row.severity ?? ""),
    location: String(row.location ?? ""),
    description: String(row.description ?? ""),
  }));
  return { node: accepted.node, completeness: report.completeness, findings };
}

function decisionsOf(journal: JournalRecord[]): DecisionLine[] {
  return journal
    .filter((r) => r.event === "gate_decided" && typeof r.node === "string")
    .map((r) => ({
      node: String(r.node),
      decision: String(r.decision ?? ""),
      ...(typeof r.reason === "string" && r.reason !== "" ? { reason: r.reason } : {}),
      ts: r.ts,
    }));
}
