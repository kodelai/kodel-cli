/** Reads the pipelines of a project for the Pipeline screen. Read-only. */
import type { PipelineSpec } from "@kodel-ai/pipeline-core";
import { type PipeEntry, sortEntries, stepsOf, unifiedDiff } from "./pipelines";
import type { Session } from "./session";

/** The part of the host this screen reads; `LocalPipelineHost` fits it. */
export interface PipelineSource {
  list(): Promise<{
    pipelines: { name: string; description?: string }[];
    problems: { file: string; message: string }[];
  }>;
  resolveSource(name: string): Promise<{ spec: PipelineSpec; yaml: string } | undefined>;
  pipelineProposals(): Promise<{ name: string }[]>;
  pipelineProposal(name: string): Promise<
    | {
        record: { name: string; kind: "new" | "change"; yaml: string; summary: string };
        spec?: PipelineSpec;
        current?: PipelineSpec;
        commands: { where: string; command: string; isNew: boolean }[];
        refused?: string;
      }
    | undefined
  >;
  open(runId: string): Promise<
    | {
        pendingChange?(): Promise<
          | {
              text: string;
              spec: PipelineSpec;
              info: { redo: string[]; refused?: string; apply: string; source: string };
            }
          | undefined
        >;
        pinnedPipeline?(): Promise<{ yaml: string }>;
      }
    | undefined
  >;
}

export function canReadPipelines(source: object): source is PipelineSource {
  return "list" in source && "resolveSource" in source && "pipelineProposal" in source;
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

export async function loadPipelines(
  source: PipelineSource,
  sessions: Session[],
): Promise<PipeEntry[]> {
  const entries: PipeEntry[] = [];

  const { pipelines, problems } = await source
    .list()
    .catch(() => ({ pipelines: [], problems: [] }));
  for (const info of pipelines) {
    const found = await source.resolveSource(info.name).catch(() => undefined);
    entries.push({
      id: `pipeline:${info.name}`,
      group: "pipeline",
      name: info.name,
      ...(info.description === undefined ? {} : { description: flat(info.description) }),
      steps: found ? stepsOf(found.spec) : [],
    });
  }
  for (const p of problems) {
    entries.push({
      id: `pipeline:${p.file}`,
      group: "pipeline",
      name: p.file,
      steps: [],
      problem: p.message,
    });
  }

  const waiting = await source.pipelineProposals().catch(() => []);
  for (const { name } of waiting) {
    const view = await source.pipelineProposal(name).catch(() => undefined);
    if (!view) continue;
    const current = view.current
      ? (await source.resolveSource(view.current.name).catch(() => undefined))?.yaml
      : undefined;
    entries.push({
      id: `proposal:${name}`,
      group: "proposal",
      name,
      kind: view.record.kind,
      description: flat(view.record.summary),
      steps: view.spec ? stepsOf(view.spec) : [],
      diff: unifiedDiff(current ?? "", view.record.yaml),
      ...(view.refused === undefined ? {} : { problem: view.refused }),
      commands: view.commands,
      note: [
        view.record.kind === "new"
          ? "The agent proposes a new pipeline."
          : "The agent proposes a change of this pipeline.",
      ],
      accept: `kodel pipeline proposals apply ${name}`,
      discard: `kodel pipeline proposals discard ${name}`,
    });
  }

  for (const s of sessions) {
    if (s.need !== "pipeline_edit") continue;
    const run = await source.open(s.id).catch(() => undefined);
    const found = await run?.pendingChange?.().catch(() => undefined);
    if (!run || !found) continue;
    const pinned = await run.pinnedPipeline?.().catch(() => undefined);
    entries.push({
      id: `change:${s.id}`,
      group: "change",
      name: `${s.pipeline} · ${s.title}`,
      kind: "change",
      runId: s.id,
      steps: stepsOf(found.spec),
      diff: unifiedDiff(pinned?.yaml ?? "", found.text),
      ...(found.info.refused === undefined ? {} : { problem: found.info.refused }),
      note: [
        found.info.source === "proposal"
          ? "The agent proposes to change the pipeline of this run."
          : "The pipeline file of this run was edited.",
        ...found.info.redo,
      ],
      accept: found.info.apply,
      discard: found.info.apply.replace(" apply ", " discard "),
    });
  }
  return sortEntries(entries);
}
