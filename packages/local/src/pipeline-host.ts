/**
 * The local `PipelineHost`: pipelines are the YAML files in `.kodel/pipelines`, runs are kept in
 * `.kodel/runs`. A run keeps a copy of the pipeline it started with, so editing a file never
 * changes a run in flight.
 */
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  isRunId,
  KodelError,
  type PipelineHost,
  type PipelineInfo,
  type PipelineProblem,
  type PipelineSpec,
  parsePipeline,
  parseSnapshot,
  type RunState,
  type StartOutcome,
} from "@kodel-ai/pipeline-core";
import { loadConfig, type WorktreeConfig } from "./config";
import { type HostOptions, hashSource, hashSpec, LocalHost, type LocalRun } from "./host";
import { FileStore, META_VERSION, type RunMeta } from "./store";

export interface LocalPipelineHostOptions extends HostOptions {
  /** Where the pipeline files are; defaults to `<root>/.kodel/pipelines`. */
  pipelinesDir?: string;
  /** Instead of the `worktree` section of the project config; mostly for tests. */
  worktree?: WorktreeConfig;
}

interface Loaded {
  file: string;
  spec: PipelineSpec;
  source: string;
}

const isPipelineFile = (name: string) => name.endsWith(".yaml") || name.endsWith(".yml");
const stemOf = (file: string) => file.replace(/\.ya?ml$/, "");

export class LocalPipelineHost implements PipelineHost {
  private readonly dir: string;
  private readonly store: FileStore;
  private readonly storeRoot: string;
  private readonly hosts = new Map<string, LocalHost>();
  /** One handle per run, so that work running in this process is shared by every call. */
  private readonly runs = new Map<string, LocalRun>();

  constructor(private readonly options: LocalPipelineHostOptions) {
    this.storeRoot = options.storeRoot ?? `${options.root}/.kodel`;
    this.dir = options.pipelinesDir ?? join(this.storeRoot, "pipelines");
    this.store = new FileStore({
      root: this.storeRoot,
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
        const source = await readFile(join(this.dir, file), "utf8");
        const spec = parsePipeline(source);
        const clash = loaded.find((l) => l.spec.name === spec.name);
        if (clash) {
          problems.push({
            file,
            message: `the name "${spec.name}" is already used by ${clash.file}`,
          });
        } else {
          loaded.push({ file, spec, source });
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
        version: spec.version,
        ...(spec.description === undefined ? {} : { description: spec.description }),
      })),
      problems,
    };
  }

  /** By the name in the file, or by the file's name without its extension. */
  private async find(name: string): Promise<Loaded | undefined> {
    const { loaded } = await this.load();
    return loaded.find((l) => l.spec.name === name) ?? loaded.find((l) => stemOf(l.file) === name);
  }

  async resolve(name: string): Promise<PipelineSpec | undefined> {
    return (await this.find(name))?.spec;
  }

  /** The path of a pipeline file relative to the repository root, `/`-separated; none outside it. */
  private pipelineFileOf(file: string): string | undefined {
    const path = relative(this.options.root, join(this.dir, file));
    if (path === "" || path.startsWith("..") || isAbsolute(path)) return undefined;
    return path.split(sep).join("/");
  }

  private hostFor(spec: PipelineSpec, source: string | undefined, file?: string): LocalHost {
    const pipelineFile = file === undefined ? undefined : this.pipelineFileOf(file);
    const key = `${hashSpec(spec)}:${pipelineFile ?? ""}`;
    let host = this.hosts.get(key);
    if (!host) {
      host = new LocalHost(spec, {
        ...this.options,
        ...(source === undefined ? {} : { source }),
        ...(pipelineFile === undefined ? {} : { pipelineFile }),
      });
      this.hosts.set(key, host);
    }
    return host;
  }

  async start(input: {
    pipeline: string;
    task: string;
    restart: boolean;
    cwd?: string;
  }): Promise<StartOutcome> {
    const found = await this.find(input.pipeline);
    if (!found)
      throw new KodelError("UNKNOWN_PIPELINE", `there is no pipeline "${input.pipeline}"`);
    // Read at each start, so an edit of the config applies to the next run without a restart.
    const worktree = this.options.worktree ?? (await loadConfig(this.storeRoot)).worktree;
    const { run, reused, terminal, workdir } = await this.hostFor(
      found.spec,
      found.source,
      found.file,
    ).start(input.task, {
      restart: input.restart,
      worktree,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    });
    // An existing run goes on with the pipeline it started with, which may no longer be the file's.
    const known = reused || terminal ? await this.open(run.runId) : run;
    if (!known) throw new KodelError("UNKNOWN_RUN", `there is no run "${run.runId}"`);
    this.runs.set(run.runId, known);
    // Where the run works is what its record says, also for a run picked up again.
    const where = await known.location();
    return {
      status: reused ? "reused" : terminal ? "terminal" : "started",
      run: known,
      ...(where
        ? { workdir: { ...where, ...(workdir?.note === undefined ? {} : { note: workdir.note }) } }
        : {}),
    };
  }

  /**
   * Stop all work this process is running (commands and checks), without reporting anything: the
   * state on disk says the work was interrupted, and a later session starts it again. Called when
   * the server goes away, so no command is left running with nobody to report to.
   */
  stop(): number {
    let stopped = 0;
    for (const run of this.runs.values()) stopped += run.stop();
    return stopped;
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

  /**
   * The pipeline a run is on: the kept version named by the hash in the run's state (which is itself
   * protected), read again and held against that hash. A kept version that was edited or is missing
   * is refused rather than obeyed. A run from before versions were kept is refused by its format.
   */
  private async specFor(
    runId: string,
  ): Promise<{ spec: PipelineSpec; source: string | undefined } | undefined> {
    if (!isRunId(runId)) return undefined;
    const meta = await this.store.readMeta(runId);
    if (!meta) return undefined;
    const state = await this.store.readState(runId);
    if (!state) return undefined;
    if ((meta.v as number) !== META_VERSION) {
      throw new KodelError(
        "UNSUPPORTED_FORMAT",
        `run ${runId} was written before pipelines were kept in versions (format ${meta.v}, this kodel reads ${META_VERSION}); finish it with the kodel that started it, or remove it`,
      );
    }
    const kept = await this.store.readSpec(runId, state.specHash);
    if (kept === undefined || hashSource(kept) !== state.specHash) {
      throw new KodelError(
        "STATE_MODIFIED_EXTERNALLY",
        `the pipeline of run ${runId} is not the one it is pinned to (its kept copy was changed or is missing); restore it before going on`,
      );
    }
    try {
      return { spec: parseSnapshot(kept), source: kept };
    } catch (error) {
      if (!(error instanceof KodelError)) throw error;
      // A version that cannot be read is not a version that was modified; say which.
      if (error.code === "UNSUPPORTED_FORMAT") throw error;
      throw new KodelError(
        "STATE_MODIFIED_EXTERNALLY",
        `the pipeline of run ${runId} is not the one it is pinned to (its kept copy is not a pipeline: ${error.message}); restore it before going on`,
      );
    }
  }

  async open(runId: string): Promise<LocalRun | undefined> {
    // Checked on every call, not only the first: the copy can be edited while the server runs.
    const found = await this.specFor(runId);
    if (!found) return undefined;
    const cached = this.runs.get(runId);
    if (cached) return cached;
    const run = this.hostFor(found.spec, found.source).open(runId);
    this.runs.set(runId, run);
    return run;
  }

  /** Accept the files of a finished run after a deliberate change (`kodel seal`). */
  async seal(runId: string): Promise<void> {
    const run = await this.open(runId);
    if (!run) throw new KodelError("UNKNOWN_RUN", `there is no run "${runId}"`);
    await run.seal();
  }
}
