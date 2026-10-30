/** Reads the pipelines of a project for the Pipeline screen. Read-only. */
import type { PipelineSpec } from "@kodel-ai/pipeline-core";
import { type Pending, type PipeEntry, sortEntries, stepsOf, unifiedDiff } from "./pipelines";
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
  const byName = new Map<string, PipeEntry>();
  const entryFor = (name: string, spec: PipelineSpec | undefined): PipeEntry => {
    let entry = byName.get(name);
    if (!entry) {
      entry = {
        id: `pipeline:${name}`,
        name,
        steps: spec ? stepsOf(spec) : [],
        fresh: true,
        pending: [],
      };
      byName.set(name, entry);
    }
    return entry;
  };

  const { pipelines, problems } = await source
    .list()
    .catch(() => ({ pipelines: [], problems: [] }));
  for (const info of pipelines) {
    const found = await source.resolveSource(info.name).catch(() => undefined);
    byName.set(info.name, {
      id: `pipeline:${info.name}`,
      name: info.name,
      ...(info.description === undefined ? {} : { description: flat(info.description) }),
      steps: found ? stepsOf(found.spec) : [],
      pending: [],
    });
  }
  for (const p of problems) {
    byName.set(p.file, {
      id: `pipeline:${p.file}`,
      name: p.file,
      steps: [],
      problem: p.message,
      pending: [],
    });
  }

  const waiting = await source.pipelineProposals().catch(() => []);
  for (const { name } of waiting) {
    const view = await source.pipelineProposal(name).catch(() => undefined);
    if (!view) continue;
    const current = view.current
      ? (await source.resolveSource(view.current.name).catch(() => undefined))?.yaml
      : undefined;
    const entry = entryFor(name, view.spec);
    if (view.record.summary !== "" && entry.description === undefined) {
      entry.description = flat(view.record.summary);
    }
    const item: Pending = {
      id: `proposal:${name}`,
      source: "proposal",
      kind: view.record.kind,
      title: view.record.kind === "new" ? "A new pipeline" : "A change of this pipeline",
      note: [
        view.record.kind === "new"
          ? "The agent proposes this pipeline. Nothing runs it until it is accepted."
          : "The agent proposes to change this pipeline. Runs that are going keep the version they have.",
        ...(view.record.summary === "" ? [] : [flat(view.record.summary)]),
      ],
      diff: unifiedDiff(current ?? "", view.record.yaml),
      commands: view.commands,
      accept: `kodel pipeline proposals apply ${name}`,
      discard: `kodel pipeline proposals discard ${name}`,
      ...(view.refused === undefined ? {} : { problem: view.refused }),
    };
    entry.pending.push(item);
  }

  for (const s of sessions) {
    if (s.need !== "pipeline_edit") continue;
    const run = await source.open(s.id).catch(() => undefined);
    const found = await run?.pendingChange?.().catch(() => undefined);
    if (!run || !found) continue;
    const pinned = await run.pinnedPipeline?.().catch(() => undefined);
    entryFor(s.pipeline, found.spec).pending.push({
      id: `run:${s.id}`,
      source: "run",
      kind: "change",
      title: `A change of the pipeline of the run «${s.title}»`,
      note: [
        found.info.source === "proposal"
          ? "The agent proposes to change the pipeline of this run."
          : "The pipeline file of this run was edited.",
        ...found.info.redo,
      ],
      diff: unifiedDiff(pinned?.yaml ?? "", found.text),
      commands: [],
      accept: found.info.apply,
      discard: found.info.apply.replace(" apply ", " discard "),
      runId: s.id,
      ...(found.info.refused === undefined ? {} : { problem: found.info.refused }),
    });
  }
  return sortEntries([...byName.values()]);
}
