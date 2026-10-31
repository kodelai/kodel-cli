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
import { definitionKey, describeNode } from "./definition-text";

/** The part of the host this screen reads; `LocalPipelineHost` fits it. */
export interface StatsSource {
  runSummaries(): Promise<
    { meta: { runId: string; pipeline: string; createdAt: number }; state: RunState | undefined }[]
  >;
  open(runId: string): Promise<
    | {
        report(): Promise<RunReport>;
        /** Every version of the pipeline the run has had; a source that cannot say has no texts. */
        keptVersions?(): Promise<PipelineSpec[]>;
      }
    | undefined
  >;
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
  /**
   * The text of each definition of a step that changed, by `definitionKey`. A definition whose text
   * was not found (the run that kept it is gone) has none.
   */
  definitions: Record<string, string[]>;
}

/** A run that is over does not change, so what is read from it is read once. */
const OVER = new Set(["completed", "failed", "canceled"]);

export type StatsLoader = (pipeline: string, now?: number) => Promise<StatsData>;

/** `fingerprint` is the one the engine used for the definitions an attempt carries. */
export function createStatsLoader(
  source: StatsSource,
  fingerprint: (text: string) => string,
): StatsLoader {
  const kept = new Map<string, StatsRun>();
  const texts = new Map<string, Map<string, string[]>>();

  /** Every definition of every step that a run kept, as lines, by `definitionKey`. */
  const textsOf = async (runId: string, over: boolean): Promise<Map<string, string[]>> => {
    const cached = texts.get(runId);
    if (cached) return cached;
    const found = new Map<string, string[]>();
    try {
      const specs = (await (await source.open(runId))?.keptVersions?.()) ?? [];
      for (const spec of specs) {
        for (const node of spec.nodes) {
          const forms = canonicalNode(spec, node);
          const key = definitionKey(node.slug, {
            work: fingerprint(forms.work),
            checks: fingerprint(forms.checks),
            routing: fingerprint(forms.routing),
          });
          if (!found.has(key)) found.set(key, describeNode(spec, node));
        }
      }
    } catch {
      // The text of a definition is a help to reading the numbers; without it they stand alone.
    }
    if (over) texts.set(runId, found);
    return found;
  };

  return async (pipeline, now = Date.now()) => {
    const summaries = (await source.runSummaries()).filter((s) => s.meta.pipeline === pipeline);
    const overOf = new Map(
      summaries.map((s) => [s.meta.runId, !!s.state && OVER.has(s.state.status)]),
    );
    let unreadable = 0;
    const runs = (
      await Promise.all(
        summaries.map(async ({ meta }): Promise<StatsRun | undefined> => {
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
            if (overOf.get(meta.runId)) kept.set(meta.runId, found);
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
    const all = summarizePipeline(runs, { scope: "all", ...options });

    // Only the definitions that some step changed are looked up, newest runs last, and the search
    // ends when every one is found.
    const wanted = new Set(
      all.versions.flatMap((g) => g.versions.map((v) => definitionKey(g.node, v.definition))),
    );
    const definitions: Record<string, string[]> = {};
    for (const run of [...runs].sort((a, b) => a.at - b.at)) {
      if (Object.keys(definitions).length === wanted.size) break;
      for (const [key, lines] of await textsOf(run.runId, overOf.get(run.runId) === true)) {
        if (wanted.has(key) && !(key in definitions)) definitions[key] = lines;
      }
    }

    return {
      pipeline,
      loadedAt: now,
      runs: runs.length,
      unreadable,
      definitionsKnown: current !== undefined,
      current: summarizePipeline(runs, { scope: "current", ...options }),
      all,
      definitions,
    };
  };
}
