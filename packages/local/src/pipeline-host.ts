/**
 * The local `PipelineHost`: pipelines are the YAML files in `.kodel/pipelines`, runs are kept in
 * `.kodel/runs`. A run keeps a copy of the pipeline it started with, so editing a file never
 * changes a run in flight.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  KodelError,
  type PipelineHost,
  type PipelineInfo,
  type PipelineProblem,
  type PipelineSpec,
  parsePipeline,
  type RunState,
  type StartOutcome,
} from "@kodel-ai/pipeline-core";
import { type HostOptions, LocalHost, type LocalRun } from "./host";
import { FileStore, type RunMeta } from "./store";

export interface LocalPipelineHostOptions extends HostOptions {
  /** Where the pipeline files are; defaults to `<root>/.kodel/pipelines`. */
  pipelinesDir?: string;
}

interface Loaded {
  file: string;
  spec: PipelineSpec;
}

const isPipelineFile = (name: string) => name.endsWith(".yaml") || name.endsWith(".yml");
const stemOf = (file: string) => file.replace(/\.ya?ml$/, "");

export class LocalPipelineHost implements PipelineHost {
  private readonly dir: string;
  private readonly store: FileStore;
  private readonly hosts = new Map<string, LocalHost>();
  /** One handle per run, so that work running in this process is shared by every call. */
  private readonly runs = new Map<string, LocalRun>();

  constructor(private readonly options: LocalPipelineHostOptions) {
    const storeRoot = options.storeRoot ?? `${options.root}/.kodel`;
    this.dir = options.pipelinesDir ?? join(storeRoot, "pipelines");
    this.store = new FileStore({
      root: storeRoot,
      ...(options.rules ? { rules: options.rules } : {}),
    });
  }

  private async load(): Promise<{ loaded: Loaded[]; problems: PipelineProblem[] }> {
    let files: string[];
    try {
      files = (await readdir(this.dir)).filter(isPipelineFile).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { loaded: [], problems: [] };
      throw error;
    }
    const loaded: Loaded[] = [];
    const problems: PipelineProblem[] = [];
    for (const file of files) {
      try {
        const spec = parsePipeline(await readFile(join(this.dir, file), "utf8"));
        const clash = loaded.find((l) => l.spec.name === spec.name);
        if (clash) {
          problems.push({
            file,
            message: `the name "${spec.name}" is already used by ${clash.file}`,
          });
        } else {
          loaded.push({ file, spec });
        }
      } catch (error) {
        if (!(error instanceof KodelError)) throw error;
        problems.push({ file, message: error.message });
      }
    }
    return { loaded, problems };
  }

  async list(): Promise<{ pipelines: PipelineInfo[]; problems: PipelineProblem[] }> {
    const { loaded, problems } = await this.load();
    return {
      pipelines: loaded.map(({ spec }) => ({
        name: spec.name,
        format: spec.format,
        ...(spec.description === undefined ? {} : { description: spec.description }),
      })),
      problems,
    };
  }

  /** By the name in the file, or by the file's name without its extension. */
  async resolve(name: string): Promise<PipelineSpec | undefined> {
    const { loaded } = await this.load();
    return (loaded.find((l) => l.spec.name === name) ?? loaded.find((l) => stemOf(l.file) === name))
      ?.spec;
  }

  private hostFor(spec: PipelineSpec): LocalHost {
    const key = JSON.stringify(spec);
    let host = this.hosts.get(key);
    if (!host) {
      host = new LocalHost(spec, this.options);
      this.hosts.set(key, host);
    }
    return host;
  }

  async start(input: { pipeline: string; task: string; restart: boolean }): Promise<StartOutcome> {
    const spec = await this.resolve(input.pipeline);
    if (!spec) throw new KodelError("UNKNOWN_PIPELINE", `there is no pipeline "${input.pipeline}"`);
    const { run, reused, terminal } = await this.hostFor(spec).start(input.task, {
      restart: input.restart,
    });
    const known = this.runs.get(run.runId) ?? run;
    this.runs.set(run.runId, known);
    return { status: reused ? "reused" : terminal ? "terminal" : "started", run: known };
  }

  /** Every run on disk, oldest first, with its state when it can be read. */
  async runSummaries(): Promise<{ meta: RunMeta; state: RunState | undefined }[]> {
    const metas = await this.store.listRuns();
    return Promise.all(
      metas.map(async (meta) => ({
        meta,
        state: await this.store.readState(meta.runId).catch(() => undefined),
      })),
    );
  }

  private async specFor(runId: string): Promise<PipelineSpec | undefined> {
    const meta = await this.store.readMeta(runId);
    if (!meta) return undefined;
    // The copy the run started with; a run from before copies were kept falls back to the file.
    const kept = await this.store.readSpec(runId);
    return kept ? (kept as PipelineSpec) : this.resolve(meta.pipeline);
  }

  async open(runId: string): Promise<LocalRun | undefined> {
    const cached = this.runs.get(runId);
    if (cached) return cached;
    const spec = await this.specFor(runId);
    if (!spec) return undefined;
    const run = this.hostFor(spec).open(runId);
    this.runs.set(runId, run);
    return run;
  }

  /** Accept the files of a finished run after a deliberate change (`kodel seal`). */
  async seal(runId: string): Promise<void> {
    const spec = await this.specFor(runId);
    if (!spec) throw new KodelError("UNKNOWN_RUN", `there is no run "${runId}"`);
    await this.hostFor(spec).seal(runId);
  }
}
