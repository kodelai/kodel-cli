/** Reads the runs of one pipeline and sums them up for the Report screen. Read-only. */
import {
  canonicalNode,
  type NodeForms,
  type PipelineSpec,
  type PipelineStats,
  type RunReport,
  type RunState,
  type StatsRun,
  summarizePipeline,
} from "@kodel-ai/pipeline-core";

/** The part of the host this screen reads; `LocalPipelineHost` fits it. */
export interface StatsSource {
  runSummaries(): Promise<
    { meta: { runId: string; pipeline: string; createdAt: number }; state: RunState | undefined }[]
  >;
  open(runId: string): Promise<{ report(): Promise<RunReport> } | undefined>;
  resolveSource(name: string): Promise<{ spec: PipelineSpec } | undefined>;
}

export interface StatsData {
  pipeline: string;
  loadedAt: number;
  /** Runs of the pipeline that were read, and runs that were there but could not be. */
  runs: number;
  unreadable: number;
  /** Whether the pipeline file could be read, so that "the present definition" means something. */
  definitionsKnown: boolean;
  current: PipelineStats;
  all: PipelineStats;
}

/** A run that is over does not change, so its report is read once. */
const OVER = new Set(["completed", "failed", "canceled"]);

export type StatsLoader = (pipeline: string, now?: number) => Promise<StatsData>;

/** `fingerprint` is the one the engine used for the definitions an attempt carries. */
export function createStatsLoader(
  source: StatsSource,
  fingerprint: (text: string) => string,
): StatsLoader {
  const kept = new Map<string, StatsRun>();
  return async (pipeline, now = Date.now()) => {
    const summaries = (await source.runSummaries()).filter((s) => s.meta.pipeline === pipeline);
    let unreadable = 0;
    const runs = (
      await Promise.all(
        summaries.map(async ({ meta, state }): Promise<StatsRun | undefined> => {
          const cached = kept.get(meta.runId);
          if (cached) return cached;
          try {
            const run = await source.open(meta.runId);
            if (!run) throw new Error("no such run");
            const found: StatsRun = {
              runId: meta.runId,
              at: meta.createdAt,
              report: await run.report(),
            };
            if (state && OVER.has(state.status)) kept.set(meta.runId, found);
            return found;
          } catch {
            unreadable++;
            return undefined;
          }
        }),
      )
    ).filter((r): r is StatsRun => r !== undefined);

    const spec = (await source.resolveSource(pipeline).catch(() => undefined))?.spec;
    const current: Record<string, NodeForms> | undefined = spec
      ? Object.fromEntries(
          spec.nodes.map((node) => {
            const forms = canonicalNode(spec, node);
            return [
              node.slug,
              {
                work: fingerprint(forms.work),
                checks: fingerprint(forms.checks),
                routing: fingerprint(forms.routing),
              },
            ];
          }),
        )
      : undefined;
    const options = {
      ...(current ? { current } : {}),
      ...(spec ? { order: spec.nodes.map((n) => n.slug) } : {}),
    };
    return {
      pipeline,
      loadedAt: now,
      runs: runs.length,
      unreadable,
      definitionsKnown: current !== undefined,
      current: summarizePipeline(runs, { scope: "current", ...options }),
      all: summarizePipeline(runs, { scope: "all", ...options }),
    };
  };
}
