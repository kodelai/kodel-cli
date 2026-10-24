/**
 * The local `PipelineHost`: pipelines are the YAML files in `.kodel/pipelines`, runs are kept in
 * `.kodel/runs`. A run keeps a copy of the pipeline it started with, so editing a file never
 * changes a run in flight.
 */
import { mkdir, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  ChoiceNeeded,
  canonicalPipeline,
  commandsOf,
  diffNodes,
  hiddenCharacterProblem,
  isRunId,
  KodelError,
  MAX_PIPELINE_PROPOSAL_BYTES,
  MAX_PIPELINE_PROPOSALS,
  type NodeDiff,
  type PipelineChoice,
  type PipelineHost,
  type PipelineInfo,
  type PipelineProblem,
  type PipelineProposalOutcome,
  type PipelineSpec,
  type PreparedTask,
  parsePipeline,
  parseSnapshot,
  proposalNameProblem,
  type RunState,
  type RunTaskLink,
  redactText,
  type StartOutcome,
} from "@kodel-ai/pipeline-core";
import { loadConfig, type WorktreeConfig } from "./config";
import { GitSnapshotter, git } from "./git";
import {
  type HostOptions,
  hashSource,
  hashSpec,
  LocalHost,
  type LocalRun,
  normalizeTask,
} from "./host";
import { FileStore, META_VERSION, type PipelineProposalRecord, type RunMeta } from "./store";
import { openTaskService } from "./tasks";

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
/** Pipeline names are lowercase, but a file system may not tell `Foo.yaml` from `foo.yaml`. */
const sameStem = (file: string, name: string) => stemOf(file).toLowerCase() === name;

/** What the agent is given when the person has to say which version of the pipeline the run uses. */
function askWhich(found: Loaded, file: string, committedText: string): PipelineChoice {
  const changes = diffNodes(parsePipeline(committedText), found.spec);
  const steps = changes.map((c) => `"${c.slug}" (${c.changes.join(", ")})`).join(", ");
  return {
    reason: "pipeline_uncommitted",
    pipeline: found.spec.name,
    file,
    options: ["working", "committed"],
    changes,
    tell_the_person:
      `Nothing was started. Ask the person, in the language they use: the pipeline file ${file} has ` +
      `changes that are not committed${steps ? ` (${steps})` : ""}, and the run works in its own copy of ` +
      "the repository made from the last commit, which does not have them. Should the run use the working " +
      "version (the file as it is now; it is also put into the run's copy, so it goes with the run's changes) " +
      "or the committed version? Do not choose yourself. Then call pipeline_start again with the same " +
      "arguments and pipeline_version set to what they say.",
  };
}

/** A proposed pipeline as the person who accepts it needs to see it. */
export interface PipelineProposalView {
  record: PipelineProposalRecord;
  /** Absent when the stored text is not a pipeline this kodel reads; `refused` says so. */
  spec?: PipelineSpec;
  /** For a change: the pipeline as it is now. */
  current?: PipelineSpec;
  changes?: NodeDiff[];
  /** Every shell command the pipeline would run; `isNew` marks the ones the current pipeline does not have. */
  commands: { where: string; command: string; isNew: boolean }[];
  /** Why it cannot be accepted now, when it cannot. */
  refused?: string;
  /** The hash of the proposed text: passed back when accepting, so what is accepted is what was shown. */
  hash: string;
  /** Where accepting would write, as an absolute path. */
  path: string;
}

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

  private linkPromise: Promise<RunTaskLink | undefined> | undefined;

  /**
   * The tie between runs and tasks: the one the host was given, else the one the project config
   * asks for. Asked once, and only when a run meets a task; a config that cannot be used for tasks
   * means no tie (the MCP server says why on stderr when it starts).
   */
  taskLink(): Promise<RunTaskLink | undefined> {
    const given = this.options.runTaskLink;
    if (given !== undefined && typeof given !== "function") return Promise.resolve(given);
    this.linkPromise ??= (given ?? (() => this.linkFromConfig()))();
    return this.linkPromise;
  }

  private async linkFromConfig(): Promise<RunTaskLink | undefined> {
    try {
      return (await openTaskService({ storeRoot: this.storeRoot }))?.runLink;
    } catch {
      return undefined;
    }
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

  async resolveSource(name: string) {
    const found = await this.find(name);
    return found
      ? { spec: found.spec, yaml: found.source, hash: hashSource(found.source) }
      : undefined;
  }

  async proposePipeline(input: {
    yaml: string;
    summary: string;
    name?: string;
  }): Promise<PipelineProposalOutcome> {
    const refuse = (code: "INVALID_ARGUMENTS" | "PIPELINE_CHANGE_REFUSED", message: string) =>
      ({ ok: false, code, message }) as const;
    if (input.yaml.trim() === "") {
      if (input.name === undefined) {
        return refuse("INVALID_ARGUMENTS", "give the name of the proposal to take back");
      }
      const problem = proposalNameProblem(input.name);
      if (problem !== undefined) return refuse("INVALID_ARGUMENTS", problem);
      const had = await this.store.removePipelineProposal(input.name);
      return { ok: true, status: had ? "withdrawn" : "none", name: input.name };
    }
    if (Buffer.byteLength(input.yaml) > MAX_PIPELINE_PROPOSAL_BYTES) {
      return refuse("INVALID_ARGUMENTS", "the pipeline is too large");
    }
    const hidden = hiddenCharacterProblem(input.yaml);
    if (hidden !== undefined) return refuse("INVALID_ARGUMENTS", hidden);
    // A proposal is the agent's text and is kept as it is, so it may not hold what redaction would take out.
    if (redactText(input.yaml, this.options.rules ?? []) !== input.yaml) {
      return refuse(
        "INVALID_ARGUMENTS",
        "the pipeline contains something that looks like a secret (a key, a token, a password); leave it out",
      );
    }
    let spec: PipelineSpec;
    try {
      spec = parsePipeline(input.yaml);
    } catch (error) {
      if (error instanceof KodelError) {
        return { ok: false, code: error.code, message: error.message };
      }
      throw error;
    }
    const problem = proposalNameProblem(spec.name);
    if (problem !== undefined) return refuse("INVALID_ARGUMENTS", problem);
    if (input.name !== undefined && input.name !== spec.name) {
      return refuse(
        "INVALID_ARGUMENTS",
        `name is "${input.name}" but the pipeline is named "${spec.name}"`,
      );
    }
    const { loaded, problems } = await this.load();
    const existing = loaded.find((l) => l.spec.name === spec.name);
    const taken =
      loaded.find((l) => sameStem(l.file, spec.name)) ??
      problems.find((p) => sameStem(p.file, spec.name));
    if (!existing && taken) {
      return refuse(
        "PIPELINE_CHANGE_REFUSED",
        `the file ${taken.file} is already there and is not a pipeline named "${spec.name}"; fix or remove it by hand, or name this pipeline differently`,
      );
    }
    if (existing && canonicalPipeline(spec) === canonicalPipeline(existing.spec)) {
      return refuse(
        "PIPELINE_CHANGE_REFUSED",
        `nothing differs from the pipeline "${spec.name}" as it is`,
      );
    }
    const waiting = await this.store.listPipelineProposals();
    if (waiting.length >= MAX_PIPELINE_PROPOSALS && !waiting.some((r) => r.name === spec.name)) {
      return refuse(
        "PIPELINE_CHANGE_REFUSED",
        `${waiting.length} proposals already wait for a person; they have to accept or drop some first`,
      );
    }
    await this.store.writePipelineProposal({
      v: 1,
      name: spec.name,
      kind: existing ? "change" : "new",
      yaml: input.yaml,
      summary: input.summary,
      ...(existing ? { base_hash: hashSource(existing.source) } : {}),
      proposed_at: (this.options.clock ?? Date.now)(),
    });
    return {
      ok: true,
      status: "proposed",
      proposal: {
        name: spec.name,
        kind: existing ? "change" : "new",
        ...(existing ? { changes: diffNodes(existing.spec, spec) } : {}),
        apply: `kodel pipeline proposals apply ${spec.name}`,
      },
    };
  }

  /** The proposals that wait, by name. */
  pipelineProposals(): Promise<PipelineProposalRecord[]> {
    return this.store.listPipelineProposals();
  }

  /** One proposal as a person sees it before accepting; none if there is no such proposal. */
  async pipelineProposal(name: string): Promise<PipelineProposalView | undefined> {
    const record = await this.store.readPipelineProposal(name);
    if (!record) return undefined;
    const { loaded, problems } = await this.load();
    let path = join(this.dir, `${record.name}.yaml`);
    // The record is a file that anything could have put there: it is looked at again, not trusted.
    let spec: PipelineSpec | undefined;
    let unusable: string | undefined = hiddenCharacterProblem(record.yaml);
    if (unusable === undefined) {
      try {
        spec = parsePipeline(record.yaml);
      } catch (error) {
        if (!(error instanceof KodelError)) throw error;
        unusable = `the stored text is not a pipeline this kodel reads (${error.message}); drop it`;
      }
    }
    if (spec === undefined || spec.name !== record.name) {
      return {
        record,
        commands: [],
        refused:
          unusable ?? `the stored text is named "${spec?.name}", not "${record.name}"; drop it`,
        hash: hashSource(record.yaml),
        path,
      };
    }
    const existing = loaded.find((l) => l.spec.name === spec.name);
    let refused: string | undefined;
    if (record.kind === "change") {
      if (!existing) {
        refused = `the pipeline "${record.name}" is no longer there; this was a change of it`;
      } else if (hashSource(existing.source) !== record.base_hash) {
        refused = `the pipeline file ${existing.file} changed after this was proposed; ask the agent to propose again`;
      } else {
        path = join(this.dir, existing.file);
      }
    } else {
      const taken =
        existing ??
        loaded.find((l) => sameStem(l.file, record.name)) ??
        problems.find((p) => sameStem(p.file, record.name));
      if (taken) {
        refused = `a pipeline or a file named "${record.name}" appeared after this was proposed; ask the agent to propose again`;
      }
    }
    const before = record.kind === "change" ? existing?.spec : undefined;
    const known = new Set(before ? commandsOf(before).map((c) => c.command) : []);
    return {
      record,
      spec,
      ...(before ? { current: before, changes: diffNodes(before, spec) } : {}),
      commands: commandsOf(spec).map((c) => ({ ...c, isNew: !known.has(c.command) })),
      ...(refused === undefined ? {} : { refused }),
      hash: hashSource(record.yaml),
      path,
    };
  }

  /**
   * A person accepts a proposal: the pipeline file is written, all or nothing, and the proposal is
   * dropped. What is written is what `expectedHash` says was shown. Called only by a command that
   * is for a person; the agent has no tool that reaches it.
   */
  async acceptPipelineProposal(
    name: string,
    expectedHash: string,
  ): Promise<{ ok: true; path: string; kind: "new" | "change" } | { ok: false; message: string }> {
    const view = await this.pipelineProposal(name);
    if (!view) return { ok: false, message: `no proposal of a pipeline named "${name}" waits` };
    if (view.hash !== expectedHash) {
      return {
        ok: false,
        message:
          "the proposal was modified while you were looking at it; nothing was accepted. Look at it again",
      };
    }
    if (view.refused !== undefined) return { ok: false, message: view.refused };
    await mkdir(this.dir, { recursive: true });
    if (view.record.kind === "new") {
      // Linked into place, so a file that appeared since the check is never replaced.
      if (!(await this.store.createFile(view.path, view.record.yaml))) {
        return {
          ok: false,
          message: `a file named ${name}.yaml appeared just now; nothing was written`,
        };
      }
    } else {
      // The file is read once more right before it is replaced: it must still be what was proposed against.
      const now = await readFile(view.path, "utf8").catch(() => undefined);
      if (now === undefined || hashSource(now) !== view.record.base_hash) {
        return { ok: false, message: "the pipeline file changed just now; nothing was written" };
      }
      await this.store.replaceFile(view.path, view.record.yaml);
    }
    await this.store.removePipelineProposal(name);
    return { ok: true, path: view.path, kind: view.record.kind };
  }

  /** Whether a proposal is there, readable or not. */
  hasPipelineProposal(name: string): Promise<boolean> {
    return this.store.hasPipelineProposal(name);
  }

  /** A person drops a proposal. */
  discardPipelineProposal(name: string): Promise<boolean> {
    return this.store.removePipelineProposal(name);
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
        runTaskLink: () => this.taskLink(),
        ...(source === undefined ? {} : { source }),
        ...(pipelineFile === undefined ? {} : { pipelineFile }),
      });
      this.hosts.set(key, host);
    }
    return host;
  }

  /**
   * Whether the pipeline file differs from the last commit in what it means. The run's worktree is
   * made from that commit, so it does not have the difference. `committed` is undefined when the
   * commit has no such file (a new pipeline) or it is not a pipeline; the worktree has none then.
   */
  private async uncommitted(
    found: Loaded,
    file: string,
  ): Promise<{ committed: string | undefined } | undefined> {
    try {
      if (!(await new GitSnapshotter(this.options.root).isRepo())) return undefined;
      let committed: string | undefined;
      try {
        committed = (await git(["show", `HEAD:${file}`], this.options.root)).stdout;
      } catch {
        return { committed: undefined };
      }
      if (committed === found.source) return undefined;
      try {
        if (canonicalPipeline(parsePipeline(committed)) === canonicalPipeline(found.spec)) {
          return undefined;
        }
      } catch (error) {
        if (!(error instanceof KodelError)) throw error;
        return { committed: undefined };
      }
      return { committed };
    } catch {
      return undefined;
    }
  }

  async start(input: {
    pipeline: string;
    task: string;
    restart: boolean;
    cwd?: string;
    pipeline_version?: "working" | "committed";
    title?: string;
    task_key?: string;
    restart_task?: boolean;
  }): Promise<StartOutcome> {
    let found = await this.find(input.pipeline);
    if (!found)
      throw new KodelError("UNKNOWN_PIPELINE", `there is no pipeline "${input.pipeline}"`);
    // Looked at before anything is made: a task that cannot be started leaves no worktree behind.
    let prepared: PreparedTask | undefined;
    if (input.restart_task === true && input.task_key === undefined) {
      throw new KodelError("INVALID_ARGUMENTS", "restart_task needs task_key", [
        { path: ["restart_task"], message: "needs task_key" },
      ]);
    }
    if (input.task_key !== undefined) {
      const link = await this.taskLink();
      if (!link) {
        throw new KodelError(
          "INVALID_ARGUMENTS",
          "task_key is not available here: tasks are off, tasks.on_run.mode is disabled, or the tracker cannot attach runs",
        );
      }
      prepared = await link.prepare(input.task_key, input.restart_task === true);
    }
    // Starting a task again means a new run, not the finished one coming back.
    const restart = input.restart || input.restart_task === true;
    // Read at each start, so an edit of the config applies to the next run without a restart.
    const config = this.options.worktree ? undefined : await loadConfig(this.storeRoot);
    const worktree = this.options.worktree ?? (config as NonNullable<typeof config>).worktree;
    let pipelineCopy: { path: string; text: string } | undefined;
    let tellCopy = false;
    const file = this.pipelineFileOf(found.file);
    if (file !== undefined && worktree.mode === "auto" && this.options.workdirs === undefined) {
      const dirt = await this.uncommitted(found, file);
      if (dirt && !(await this.runExists(found.spec.name, { task: input.task, restart }))) {
        if (dirt.committed === undefined) {
          // Only the working version exists: the worktree has none, so it gets this one.
          pipelineCopy = { path: file, text: found.source };
        } else {
          const choice =
            input.pipeline_version ??
            (await (config ? Promise.resolve(config) : loadConfig(this.storeRoot))).pipeline
              .uncommitted;
          if (choice === "ask") {
            throw new ChoiceNeeded(askWhich(found, file, dirt.committed));
          }
          if (choice === "working") {
            pipelineCopy = { path: file, text: found.source };
            // The run's branch will differ from the last commit in this file: the person is told.
            tellCopy = true;
          } else {
            found = {
              file: found.file,
              spec: parsePipeline(dirt.committed),
              source: dirt.committed,
            };
          }
        }
      }
    }
    const { run, reused, terminal, workdir } = await this.hostFor(
      found.spec,
      found.source,
      found.file,
    ).start(input.task, {
      restart,
      ...(prepared?.key === undefined ? {} : { taskKey: prepared.key }),
      ...(input.title === undefined ? {} : { title: input.title }),
      worktree,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(pipelineCopy === undefined ? {} : { pipelineCopy }),
    });
    // An existing run goes on with the pipeline it started with, which may no longer be the file's.
    const known = reused || terminal ? await this.open(run.runId) : run;
    if (!known) throw new KodelError("UNKNOWN_RUN", `there is no run "${run.runId}"`);
    this.runs.set(run.runId, known);
    // Where the run works is what its record says, also for a run picked up again.
    const where = await known.location();
    const copied =
      pipelineCopy && workdir && tellCopy
        ? `The pipeline file ${pipelineCopy.path} was put into the run's directory as it is now, so it goes into the run's branch with its other changes.`
        : undefined;
    const note = [workdir?.note, copied].filter((part) => part !== undefined).join(" ");
    const task = await this.tieStart(input.task_key, prepared, known, !reused && !terminal);
    return {
      status: reused ? "reused" : terminal ? "terminal" : "started",
      run: known,
      ...(where ? { workdir: { ...where, ...(note === "" ? {} : { note }) } } : {}),
      ...(task ? { task } : {}),
    };
  }

  /**
   * The run exists: tie it to its task. A tracker that fails is a warning in the answer and a line in
   * the journal; the run goes on. A run that was only picked up again is not tied a second time.
   */
  private async tieStart(
    typed: string | undefined,
    prepared: PreparedTask | undefined,
    run: LocalRun,
    fresh: boolean,
  ): Promise<StartOutcome["task"]> {
    if (typed === undefined || !prepared) return undefined;
    const link = await this.taskLink();
    if (!link) return undefined;
    const key = prepared.key ?? typed;
    if (prepared.key === undefined) {
      return { key, ...(prepared.warning === undefined ? {} : { warning: prepared.warning }) };
    }
    if (!fresh) {
      // The run was there before: it belongs to whatever it was started for.
      return {
        key,
        warning: `this run already existed and was not tied to task ${prepared.key}`,
      };
    }
    const began = await link.begin(prepared.key, run.runId, prepared.restarting);
    await run.apply({
      type: "task_note",
      what: began.failed ? "failed" : prepared.restarting ? "restarted" : "linked",
      task: key,
      ...(began.note === undefined ? {} : { note: began.note }),
      ...(prepared.restarting ? { restarting: true as const } : {}),
    });
    return {
      key,
      ...(prepared.restarting ? { restarted: true as const } : {}),
      ...(began.note === undefined ? {} : { warning: began.note }),
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

  /** Whether a start for this task would pick up a run that exists, instead of making one. */
  private async runExists(name: string, input: { task: string; restart: boolean }) {
    const task = normalizeTask(input.task, this.options.rules ?? []);
    if (await this.store.findActive(name, task)) return true;
    return !input.restart && (await this.store.findLatest(name, task)) !== undefined;
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
