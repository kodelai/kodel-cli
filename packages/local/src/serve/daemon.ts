/**
 * The loop of `kodel serve` (TASK-G8KM, T-44). Each cycle reads the config, the runs, the worker
 * records and (when a start is possible) the tasks, asks `planServe` what to do and does it, one action
 * at a time: a note that a worker is gone, the end of the terminal session of a run that is over, a
 * resume after a person's decision, a give-up comment, a start of a task. It decides nothing about a
 * run: the host port it is given has no gate, ack, seal, resume of a pause or accept call.
 *
 * Fail closed: a config that does not load, worker records that cannot be read, a tracker that cannot
 * keep the task mark or lists only part of the tasks mean no start (and, for the records, nothing at
 * all) in that cycle.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type Caller,
  ChoiceNeeded,
  capabilitiesOf,
  type JournalRecord,
  KodelError,
  type NextStep,
  needsApproval,
  type RedactRule,
  readinessWords,
  redactText,
  SessionError,
  type Task,
  type TaskProblem,
  type TaskService,
  type TaskState,
  type TaskSummary,
  type ToolFailure,
  type WorkerGoneReason,
} from "@kodel-ai/pipeline-core";
import {
  admitStart,
  DEAD_IN_A_ROW,
  decisionOf,
  giveUpComment,
  lastAgentCallOf,
  planServe,
  type RunDecision,
  resumeVerdict,
  ruleFor,
  type ServeAction,
  type ServeInput,
  type ServeMemory,
  type ServePlan,
  type ServeRules,
  type ServeRunView,
  type ServeStartRule,
  type ServeTaskView,
  type ServeUnreadableRun,
  type ServeWorkerView,
  START_ATTEMPTS,
  servePlaces,
} from "@kodel-ai/pipeline-core/serve";
import { parse } from "yaml";
import { CONFIG_FILE, loadConfig, type ProjectConfig } from "../config";
import type { RunSummary } from "../pipeline-host";
import type { RunMeta } from "../store";
import { type ServeRecordHandle, ServeRecordRefused } from "./files";

/** Time between two cycles. */
export const SERVE_CYCLE_MS = 5_000;
/** The exit code that asks a service manager to start the daemon again (the config or the build changed). */
export const SERVE_EXIT_RESTART = 75;
/** The exit code for what a restart does not fix (another daemon, Windows, `KODEL_ENGINE`). */
export const SERVE_EXIT_REFUSED = 78;
/** How long a preflight of the launcher is believed. */
export const PREFLIGHT_TTL_MS = 60_000;
/** One page of the task list, and how many pages a cycle reads at most. */
export const SERVE_TASK_PAGE = 200;
export const SERVE_TASK_PAGES = 5;
/** How long the journal of a run whose worker is alive is believed: it is read at most this often. */
export const LIVE_JOURNAL_TTL_MS = 60_000;
/** A pause between two cycles longer than this (a sleep of the machine) starts the quiet time of every worker again. */
const GAP_MS = 60_000;

const CALLER = "kodel-serve";
const UNPARSED = "unparsed";

/** A run as the daemon reads and notes it; `LocalRun` fits it. */
export interface ServeRunPort {
  readonly runId: string;
  journal(): Promise<JournalRecord[]>;
  inspect(): Promise<NextStep>;
  /** Whether the state is what kodel last wrote; a run changed outside kodel waits for a person. */
  integrityStatus(): Promise<"ok" | "modified" | "unknown">;
  location(): Promise<{ path: string } | undefined>;
  inProject(worktree: string): Promise<string>;
  noteWorker(input: {
    worker: string;
    id?: string;
    reason: WorkerGoneReason;
    exit_code?: number;
    at?: number;
  }): Promise<{ written: boolean; dropped?: true }>;
}

/** The part of the host the daemon uses; `LocalPipelineHost` fits it. No call here decides anything about a run. */
export interface ServeHostPort {
  open(runId: string): Promise<ServeRunPort | undefined>;
  /** Every run; a run `skip` names comes back `skipped`, its state not read. */
  runSummaries(options?: { skip?: (runId: string) => boolean }): Promise<RunSummary[]>;
  list(): Promise<{ pipelines: { name: string }[] }>;
  taskLink(): Promise<unknown>;
  start(input: {
    pipeline: string;
    task: string;
    restart: boolean;
    task_key: string;
    caller: Caller;
  }): Promise<{
    status: "started" | "reused" | "terminal";
    run: { runId: string };
    workdir?: { path: string };
  }>;
  withWorkerStartLock<T>(fn: () => Promise<T>): Promise<T>;
  /** The root of another checkout that made the run, when it is not this one. */
  foreignRootOf?(meta: RunMeta): string | undefined;
}

/** What the daemon asks of the launcher of background workers; the CLI's `WorkerLauncher` is adapted to it. */
export interface ServeLauncherPort {
  preflight(input: {
    dialog: boolean;
    taskLink: boolean;
    pipelines: number;
    /** The folder the worktrees of the runs are made in: where an agent's question about trust would come. */
    worktreesDir?: string;
    /** Nobody watches the daemon's starts: what would stop at a question is refused. */
    unattended?: boolean;
  }): Promise<{ ok: true; note?: string } | { ok: false; reason: string }>;
  /** Starts the first session of a run (`kw-<run>`); throws with the reason. */
  start(input: { runId: string; workdir: string; title: string }): Promise<{ name: string }>;
  /** Starts `kw-<run>-d<seq>`; a `SessionError` `NAME_TAKEN` means someone did it already. */
  resume(input: {
    runId: string;
    workdir: string;
    sessionId: string;
    decision: RunDecision;
  }): Promise<{ name: string }>;
  /** The latest record of each run named; a run without a record is absent. Throws when the records cannot be read. */
  statuses(runIds: readonly string[]): Promise<Map<string, ServeWorkerView>>;
  /**
   * Ends the live session of a run that is over, with the processes it started. A session that is already
   * stopped or gone is no error; it decides nothing about a run.
   */
  finish(runId: string): Promise<void>;
}

/** The tracker as the daemon uses it. */
export interface ServeTasksPort {
  readonly capabilities: {
    runs: "none" | "attach" | "full";
    priority: boolean;
    subtasks: boolean;
    provenance?: boolean;
    links?: boolean;
  };
  /** One page; throws when the tracker fails. */
  list(filter: {
    state: TaskState[];
    status?: string;
    priority?: string;
    parent?: string;
    limit: number;
    cursor?: string;
  }): Promise<{ tasks: TaskSummary[]; next?: string; truncated: boolean; problems: TaskProblem[] }>;
  get(key: string): Promise<Task | undefined>;
  /** A comment through the service, so it is redacted like any other. */
  comment(key: string, text: string): Promise<void>;
  /** The tracker's priorities, most urgent first. */
  priorities(): Promise<string[]>;
}

const failed = (answer: ToolFailure): KodelError => new KodelError(answer.code, answer.message);

/** The tracker port over a `TaskService`, so every read and the comment take the service's checks and redaction. */
export function serveTasksOf(service: TaskService): ServeTasksPort {
  return {
    get capabilities() {
      return service.capabilities;
    },
    async list(filter) {
      const answer = await service.list(filter);
      if (!answer.ok) throw failed(answer);
      const out = answer as unknown as {
        tasks: TaskSummary[];
        next?: string;
        truncated: boolean;
        problems: TaskProblem[];
      };
      return {
        tasks: out.tasks,
        truncated: out.truncated,
        problems: out.problems,
        ...(out.next === undefined ? {} : { next: out.next }),
      };
    },
    async get(key) {
      const answer = await service.get({ key });
      if (!answer.ok) {
        if (answer.code === "TASK_NOT_FOUND") return undefined;
        throw failed(answer);
      }
      return answer.task as Task;
    },
    async comment(key, text) {
      const answer = await service.update({ key, comment: text });
      if (!answer.ok) throw failed(answer);
    },
    async priorities() {
      if (!service.capabilities.priority) return [];
      const answer = await service.schema({});
      if (!answer.ok) throw failed(answer);
      const list = (answer as { priorities?: { name: string }[] }).priorities ?? [];
      return list.map((p) => p.name);
    },
  };
}

export interface ServeDaemonDeps {
  /** The checkout the daemon serves. */
  root: string;
  /** Its store root, `<root>/.kodel`. */
  storeRoot: string;
  host: ServeHostPort;
  launcher: ServeLauncherPort;
  /** The tracker; absent when tasks are off (then nothing is started). */
  tasks?: ServeTasksPort;
  /** The record to write after each cycle; `--status` has none. */
  record?: ServeRecordHandle;
  /** One plain line per event; already redacted. */
  log: (line: string) => void;
  /** This build's version, for the caller of a start. */
  version: string;
  /** The project's redaction rules, for log lines and comments. */
  rules?: RedactRule[];
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  cycleMs?: number;
  /** A fingerprint of the kodel build on disk (its size and time); a change ends the daemon with 75. */
  buildStamp?: () => Promise<string | undefined>;
  /** Reads the project config; `loadConfig` by default. */
  loadConfig?: (storeRoot: string) => Promise<ProjectConfig>;
  /**
   * Since when a worker's quiet time counts, in place of this daemon's own start: `--status` gives the
   * start of the daemon that runs (or nothing ever watched), so that it can list the stalled workers.
   */
  quietFrom?: number;
}

export type ServeCycleResult =
  | { kind: "active" }
  | { kind: "idle"; reason: string }
  | { kind: "restart"; reason: string }
  /** The record is no longer this daemon's: it stops, and a restart does not fix that. */
  | { kind: "refused"; reason: string }
  /** The cycle stopped early: the runs or the worker records could not be read. */
  | { kind: "stopped"; reason: string };

export type ServeStatusPlan =
  | { config: "ok"; rules: ServeRules; plan: ServePlan }
  | { config: "error"; reason: string };

export interface ServeDaemon {
  /** Reads and plans; acts on nothing and writes nothing (`kodel serve --status`). */
  plan(): Promise<ServeStatusPlan>;
  /** One cycle; between actions it stops when `signal` is aborted. */
  cycle(signal?: AbortSignal): Promise<ServeCycleResult>;
  /** Cycles until `signal` is aborted (exit 0), the config or the build changed (75) or the record was taken over (78). */
  run(signal: AbortSignal): Promise<{ exit: 0 | 75 | 78; reason?: string }>;
  /** What the daemon keeps in memory; for tests. */
  memory(): ServeMemory;
}

const sleepFor = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const ENDED = ["completed", "failed", "canceled"];

/** Errors of the environment: the start is not the task's fault, so it uses no attempt. */
const ENVIRONMENT_CODES = [
  "UNKNOWN_PIPELINE",
  "CONFIG_INVALID",
  "GIT_REQUIRED",
  "STATE_LOCKED",
  "UNSUPPORTED_FORMAT",
];

function environmentError(error: unknown): string | undefined {
  if (error instanceof ChoiceNeeded) {
    return `the pipeline file ${error.choice.file} has changes that are not committed`;
  }
  if (error instanceof KodelError && ENVIRONMENT_CODES.includes(error.code)) return error.message;
  return undefined;
}

/** Why a run that a worker had cannot be read, in the three words the history rules keep apart. */
function unreadableWhy(code: string, message: string): ServeUnreadableRun["why"] {
  if (code === "STATE_MODIFIED_EXTERNALLY") return "modified";
  if (/newer kodel/.test(message)) return "newer";
  return "cannot_read";
}

const unreadableWords: Record<ServeUnreadableRun["why"], string> = {
  cannot_read: "cannot read",
  newer: "written by a newer kodel, upgrade kodel",
  modified: "was modified",
};

/** The task text a run gets: the title, a blank line, the body; as the TUI's `s` gives it. */
const taskTextOf = (task: { title: string; body?: string }): string => {
  const body = task.body?.trim() ?? "";
  return body === "" ? task.title : `${task.title}\n\n${body}`;
};

/** The links of a task for the plan (T-45); a task without any adds nothing. */
function linksOf(
  task: Pick<TaskSummary, "depends_on" | "dependencies" | "conflicts_with" | "blocks">,
): Pick<ServeTaskView, "depends_on" | "dependencies" | "conflicts_with" | "blocks"> {
  return {
    ...(task.depends_on?.length ? { depends_on: task.depends_on } : {}),
    ...(task.dependencies?.length ? { dependencies: task.dependencies } : {}),
    ...(task.conflicts_with?.length ? { conflicts_with: task.conflicts_with } : {}),
    ...(task.blocks?.length ? { blocks: task.blocks } : {}),
  };
}

const hasLinks = (task: ServeTaskView): boolean =>
  task.depends_on !== undefined || task.conflicts_with !== undefined || task.blocks !== undefined;

function taskViewOf(task: TaskSummary): ServeTaskView {
  const runs = task.run_count ?? 0;
  return {
    key: task.key,
    title: task.title,
    status: task.status,
    state: task.state,
    ...(task.priority === undefined ? {} : { priority: task.priority }),
    ...(task.parent === undefined ? {} : { parent: task.parent }),
    ...(task.comment === undefined ? {} : { comment: task.comment }),
    ...(task.needs_approval === true ? { needs_approval: true } : {}),
    started_runs: Math.max(0, runs - (task.created_in_run === undefined ? 0 : 1)),
    ...linksOf(task),
    ...(task.created_at === undefined ? {} : { created_at: task.created_at }),
  };
}

function fullTaskViewOf(task: Task): ServeTaskView {
  const last = task.comments?.[task.comments.length - 1]?.text ?? task.comment;
  return {
    key: task.key,
    title: task.title,
    status: task.status,
    state: task.state,
    ...(task.priority === undefined ? {} : { priority: task.priority }),
    ...(task.parent === undefined ? {} : { parent: task.parent }),
    ...(last === undefined ? {} : { comment: last }),
    ...(needsApproval(task) ? { needs_approval: true } : {}),
    started_runs: task.runs.filter((r) => r !== task.created_in_run).length,
    ...linksOf(task),
    created_at: task.created_at,
  };
}

/**
 * The text of the config without its `serve` block: a change of it ends the daemon (75). `undefined`
 * when it does not parse: the daemon stays idle with the parse error, as for a config that does not load.
 */
async function configStamp(storeRoot: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(storeRoot, CONFIG_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw error;
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    return undefined;
  }
  let rest: unknown = raw ?? {};
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const { serve: _serve, ...others } = raw as Record<string, unknown>;
    rest = others;
  }
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

export function createServeDaemon(deps: ServeDaemonDeps): ServeDaemon {
  const now = deps.now ?? Date.now;
  const load = deps.loadConfig ?? loadConfig;
  const rules = deps.rules ?? [];
  const say = (line: string) => deps.log(redactText(line, rules));
  const caller: Caller = { name: CALLER, version: deps.version };
  const started = now();

  let memory: ServeMemory = {
    attempts: {},
    mine: [],
    dead_in_a_row: 0,
    logged: [],
    unlaunched: [],
  };
  /** Ended runs, read once: nothing about them changes any more. */
  const ended = new Map<string, ServeRunView>();
  // Ended runs of this checkout whose worker may still be alive (an agent finishing its last answer, a run
  // canceled under it): their records are read until the worker has stopped, so it keeps its worker place.
  const endedWatch = new Set<string>();
  /** What the journal of a run with a live worker said when it was last read, and the run's answer then. */
  const liveJournals = new Map<
    string,
    {
      at: number;
      waiting: boolean;
      marks: ReturnType<typeof decisionOf>;
      noted: string[];
      lastAgentAt?: number;
    }
  >();
  /** `UNPARSED` when the first read of the config did not parse: the first one that does is a change. */
  let baseConfig: string | undefined;
  let baseBuild: string | undefined;
  let lastCycleAt: number | undefined;
  let quietFrom = deps.quietFrom ?? started;
  let preflight:
    | { at: number; result: { ok: true; note?: string } | { ok: false; reason: string } }
    | undefined;
  /** Lines said once per change of a condition outside the plan (idle, a failed write, a start's environment). */
  const said = new Map<string, string>();
  const sayOnChange = (topic: string, line: string | undefined) => {
    if (said.get(topic) === line) return;
    if (line === undefined) said.delete(topic);
    else {
      said.set(topic, line);
      say(line);
    }
  };

  const loadRules = async (): Promise<
    { ok: true; config: ProjectConfig } | { ok: false; reason: string }
  > => {
    try {
      return { ok: true, config: await load(deps.storeRoot) };
    } catch (error) {
      return { ok: false, reason: `the config does not load: ${messageOf(error)}` };
    }
  };

  /** The runs as the plan sees them, and the ones that cannot be read. Throws, naming what, when the runs or the worker records cannot be read. */
  const gatherRuns = async (): Promise<{
    runs: ServeRunView[];
    unreadable: ServeUnreadableRun[];
    /** Runs of this checkout that cannot be read, have no worker record and are not known to have ended. */
    unreadableOpen: string[];
  }> => {
    // An ended run's state is not read again: with many runs that would be every state file every cycle.
    const summaries = await deps.host
      .runSummaries({ skip: (runId) => ended.has(runId) })
      .catch((error: unknown) => {
        throw new Error(`the runs cannot be read: ${messageOf(error)}`);
      });
    const runs: ServeRunView[] = [];
    const own: { summary: RunSummary; runId: string }[] = [];
    const broken: RunSummary[] = [];
    for (const summary of summaries) {
      const runId = summary.meta.runId;
      const known = ended.get(runId);
      if (known !== undefined) {
        if (!endedWatch.has(runId)) runs.push(known);
        continue;
      }
      const state = summary.state;
      if (state === undefined) {
        if (deps.host.foreignRootOf?.(summary.meta) === undefined) broken.push(summary);
        continue;
      }
      const base: ServeRunView = {
        runId,
        status: state.status,
        canNote: false,
        ...(state.taskKey === undefined ? {} : { taskKey: state.taskKey }),
        waitsForPerson: false,
        noted: [],
      };
      if (ENDED.includes(state.status)) {
        ended.set(runId, base);
        if (deps.host.foreignRootOf?.(summary.meta) === undefined) endedWatch.add(runId);
        else runs.push(base);
      } else if (deps.host.foreignRootOf?.(summary.meta) !== undefined) {
        // Another checkout's run: it names its task, but its worker is not this daemon's business.
        runs.push(base);
      } else {
        own.push({ summary, runId });
      }
    }
    const watched = [...endedWatch].filter((id) => ended.has(id));
    const ids = [...own.map((o) => o.runId), ...broken.map((b) => b.meta.runId), ...watched];
    const workers =
      ids.length === 0
        ? new Map<string, ServeWorkerView>()
        : await deps.launcher.statuses(ids).catch((error: unknown) => {
            throw new Error(`the worker records cannot be read: ${messageOf(error)}`);
          });
    // Where the process table cannot be read an agent left behind a wrapper that died is not seen:
    // the recorded process alone answers, and it is said once.
    sayOnChange(
      "process-table",
      [...workers.values()].some((worker) => worker.groupUnread === true)
        ? "environment: cannot read the process table: an agent left behind a dead wrapper would not be seen"
        : undefined,
    );
    for (const runId of watched) {
      const view = ended.get(runId) as ServeRunView;
      const worker = workers.get(runId);
      if (
        worker !== undefined &&
        (worker.state === "starting" ||
          worker.state === "running" ||
          worker.state === "unknown" ||
          // Its process still runs without a holder: alive, until a person stops it.
          worker.childAlive === true)
      ) {
        runs.push({ ...view, worker });
      } else {
        endedWatch.delete(runId);
        runs.push(view);
      }
    }
    const unreadable: ServeUnreadableRun[] = [];
    const unreadableOpen: string[] = [];
    for (const summary of broken) {
      const worker = workers.get(summary.meta.runId);
      if (worker === undefined) {
        // It holds no place, but its task is not known: tasks with a conflict wait for it (T-45).
        unreadableOpen.push(summary.meta.runId);
        continue;
      }
      const code = summary.unreadable?.code ?? "ERROR";
      const message = summary.unreadable?.message ?? "cannot read";
      const why = unreadableWhy(code, message);
      unreadable.push({
        runId: summary.meta.runId,
        why,
        detail: `${unreadableWords[why]}: ${message}`,
        worker,
      });
    }
    for (const { summary, runId } of own) {
      const state = summary.state as NonNullable<RunSummary["state"]>;
      const worker = workers.get(runId);
      const base: ServeRunView = {
        runId,
        status: state.status,
        canNote: capabilitiesOf(state.v).workerNotes,
        ...(state.taskKey === undefined ? {} : { taskKey: state.taskKey }),
        waitsForPerson: false,
        noted: [],
        ...(worker === undefined ? {} : { worker }),
      };
      const settled =
        worker !== undefined &&
        (worker.state === "exited" || worker.state === "lost" || worker.state === "killed");
      // A worker in a terminal stays alive at a wait: whether its run only waits for the person is
      // asked every cycle, because that is what frees its worker place.
      const liveTerminal =
        worker !== undefined &&
        worker.terminal === true &&
        (worker.state === "starting" || worker.state === "running");
      if (!settled && !liveTerminal) {
        liveJournals.delete(runId);
        runs.push(base);
        continue;
      }
      try {
        const run = await deps.host.open(runId);
        if (run === undefined) throw new KodelError("UNKNOWN_RUN", `there is no run "${runId}"`);
        const next = await run.inspect();
        const waiting = "waiting" in next;
        const at = now();
        const kept = liveTerminal ? liveJournals.get(runId) : undefined;
        // The journal of a live worker's run is read at most once a minute, and when its answer changed
        // (a decision, a new wait); a worker that ended is read every cycle, as before.
        let read = kept;
        if (kept === undefined || kept.waiting !== waiting || at - kept.at >= LIVE_JOURNAL_TTL_MS) {
          if ((await run.integrityStatus()) === "modified") {
            throw new KodelError(
              "STATE_MODIFIED_EXTERNALLY",
              `the state of run ${runId} was changed outside kodel`,
            );
          }
          const journal = await run.journal();
          const lastAgentAt = lastAgentCallOf(journal);
          read = {
            at,
            waiting,
            marks: decisionOf(journal),
            noted: journal
              .filter((r) => r.event === "worker_note")
              .map((r) => (typeof r.id === "string" ? r.id : String(r.worker))),
            ...(lastAgentAt === undefined ? {} : { lastAgentAt }),
          };
        }
        if (liveTerminal) liveJournals.set(runId, read as NonNullable<typeof read>);
        else liveJournals.delete(runId);
        const known = read as NonNullable<typeof read>;
        runs.push({
          ...base,
          waitsForPerson: waiting,
          ...(liveTerminal ? { idleAtWait: waiting } : {}),
          marks: known.marks,
          noted: known.noted,
          ...(known.lastAgentAt === undefined ? {} : { lastAgentAt: known.lastAgentAt }),
          marksAt: known.at,
        });
      } catch (error) {
        // A read that failed keeps both places of a live worker (the unreadable path), and is tried again.
        liveJournals.delete(runId);
        const code = error instanceof KodelError ? error.code : "ERROR";
        const why = unreadableWhy(code, messageOf(error));
        unreadable.push({
          runId,
          why,
          detail: `${unreadableWords[why]}: ${messageOf(error)}`,
          ...(worker === undefined ? {} : { worker }),
        });
      }
    }
    // A run that left the list (it ended, or is another checkout's now) is not read here again.
    const listed = new Set(own.map((o) => o.runId));
    for (const runId of liveJournals.keys()) if (!listed.has(runId)) liveJournals.delete(runId);
    return { runs, unreadable, unreadableOpen };
  };

  /** Whether a start can happen at all, and why not. */
  const environment = async (
    config: ProjectConfig,
    start: readonly ServeStartRule[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (config.worktree.mode !== "auto") {
      return {
        ok: false,
        reason: "worktree.mode is off; kodel serve starts tasks only with worktree.mode: auto",
      };
    }
    const tasks = deps.tasks;
    if (tasks === undefined) return { ok: false, reason: "tasks are off; nothing is started" };
    if (tasks.capabilities.runs === "none" || (await deps.host.taskLink()) === undefined) {
      return { ok: false, reason: "the tracker cannot attach runs; nothing is started" };
    }
    if (tasks.capabilities.provenance !== true) {
      return {
        ok: false,
        reason: "the tracker cannot keep the mark of a task an agent made; nothing is started",
      };
    }
    const listed = await deps.host.list();
    // Every rule's pipeline: a rule that cannot start would leave its tasks to a later rule.
    const missing = start.find((rule) => !listed.pipelines.some((p) => p.name === rule.pipeline));
    if (missing !== undefined) {
      return {
        ok: false,
        reason: `the pipeline ${missing.pipeline} does not load; nothing is started`,
      };
    }
    const at = now();
    if (preflight === undefined || at - preflight.at >= PREFLIGHT_TTL_MS) {
      preflight = {
        at,
        result: await deps.launcher.preflight({
          dialog: config.decisions.dialog,
          taskLink: true,
          pipelines: listed.pipelines.length,
          worktreesDir: resolve(deps.root, config.worktree.dir),
          unattended: true,
        }),
      };
    }
    // What the launcher only remarks on (a config git does not track, a trust it cannot tell): said once.
    sayOnChange("preflight-note", preflight.result.ok ? preflight.result.note : undefined);
    return preflight.result.ok
      ? { ok: true }
      : { ok: false, reason: `${preflight.result.reason}; nothing is started` };
  };

  /** The `todo` tasks, read page by page; filtered by the tracker where it can (one rule only). */
  const listTasks = async (
    start: readonly ServeStartRule[],
  ): Promise<
    | {
        ok: true;
        list: ServeTaskView[];
        complete: boolean;
        priorities: string[];
        graph?: ServeTaskView[];
      }
    | { ok: false; reason: string }
  > => {
    const tasks = deps.tasks as ServeTasksPort;
    const caps = tasks.capabilities;
    // With several rules a filter of one would hide the tasks of the others: the plan matches them all.
    const match = start.length === 1 ? start[0]?.match : undefined;
    const filter = {
      state: ["todo"] as TaskState[],
      limit: SERVE_TASK_PAGE,
      ...(match?.status?.length === 1 && match.status[0] !== undefined
        ? { status: match.status[0] }
        : {}),
      ...(caps.priority && match?.priority?.length === 1 && match.priority[0] !== undefined
        ? { priority: match.priority[0] }
        : {}),
      ...(caps.subtasks && match?.parent !== undefined ? { parent: match.parent } : {}),
    };
    const list: ServeTaskView[] = [];
    let complete = true;
    let cursor: string | undefined;
    try {
      for (let page = 0; ; page++) {
        if (page >= SERVE_TASK_PAGES) {
          return {
            ok: false,
            reason: `more than ${SERVE_TASK_PAGE * SERVE_TASK_PAGES} candidates; narrow the rules (serve.start[].match)`,
          };
        }
        const answer = await tasks.list(cursor === undefined ? filter : { ...filter, cursor });
        list.push(...answer.tasks.map(taskViewOf));
        if (answer.problems.length > 0) complete = false;
        if (answer.next === undefined) {
          if (answer.truncated) complete = false;
          break;
        }
        cursor = answer.next;
      }
      const priorities = await tasks.priorities();
      // Only when a link exists: a project without links is read exactly as before. The order counts
      // every open task, so they are read without the rule filter, under the same cap.
      if (caps.links !== true || !list.some(hasLinks)) {
        return { ok: true, list, complete, priorities };
      }
      const graph: ServeTaskView[] = [];
      const open = { state: ["todo", "progress"] as TaskState[], limit: SERVE_TASK_PAGE };
      cursor = undefined;
      for (let page = 0; ; page++) {
        if (page >= SERVE_TASK_PAGES) {
          return {
            ok: false,
            reason: `more than ${SERVE_TASK_PAGE * SERVE_TASK_PAGES} open tasks and some have links; close tasks or remove the links`,
          };
        }
        const answer = await tasks.list(cursor === undefined ? open : { ...open, cursor });
        graph.push(...answer.tasks.map(taskViewOf));
        if (answer.problems.length > 0) complete = false;
        if (answer.next === undefined) {
          if (answer.truncated) complete = false;
          break;
        }
        cursor = answer.next;
      }
      return { ok: true, list, complete, priorities, graph };
    } catch (error) {
      return { ok: false, reason: `the task list cannot be read: ${messageOf(error)}` };
    }
  };

  /** Everything a plan needs; `forStatus` lists the tasks even when the daemon would not start. */
  const gather = async (
    config: ProjectConfig,
    at: number,
    forStatus: boolean,
  ): Promise<ServeInput> => {
    const serve = config.serve;
    const { runs, unreadable, unreadableOpen } = await gatherRuns();
    let env: ServeInput["environment"] = { ok: true };
    let tasks: ServeInput["tasks"];
    const wanted =
      serve.start.length > 0 &&
      (forStatus || (serve.enabled && memory.dead_in_a_row < DEAD_IN_A_ROW));
    if (wanted) {
      try {
        env = await environment(config, serve.start);
      } catch (error) {
        env = { ok: false, reason: `the start conditions cannot be read: ${messageOf(error)}` };
      }
      if (env.ok) {
        const listed = await listTasks(serve.start);
        if (listed.ok) {
          tasks = {
            list: listed.list,
            complete: listed.complete,
            priorities: listed.priorities,
            ...(listed.graph === undefined ? {} : { graph: listed.graph }),
          };
        } else {
          env = { ok: false, reason: listed.reason };
        }
      }
    }
    return {
      now: at,
      rules: serve,
      runs,
      memory,
      unreadable,
      ...(unreadableOpen.length === 0 ? {} : { unreadable_open: unreadableOpen }),
      quietFrom,
      ...(tasks === undefined ? {} : { tasks }),
      environment: env,
    };
  };

  const logLine = (action: Extract<ServeAction, { kind: "log" }>) => {
    const run = action.runId === undefined ? "" : `run ${action.runId}: `;
    say(`${action.problem}: ${run}${action.detail ?? ""}`.trimEnd());
  };

  /** A launch that left no record: its note is kept in memory until it is written. */
  const markNoted = (runId: string) => {
    for (const u of memory.unlaunched) if (u.runId === runId) u.noted = true;
  };

  const writeNote = async (action: Extract<ServeAction, { kind: "note" }>) => {
    const run = await deps.host.open(action.runId);
    if (run === undefined) return;
    const done = await run.noteWorker({
      worker: action.worker,
      ...(action.id === undefined ? {} : { id: action.id }),
      reason: action.reason,
      ...(action.exit_code === undefined ? {} : { exit_code: action.exit_code }),
      ...(action.at === undefined ? {} : { at: action.at }),
    });
    if (done.written) {
      say(`noted: run ${action.runId}: agent ${action.worker} ${action.reason}`);
    } else if (done.dropped === true) {
      // The plan asks again every cycle: said once, not every five seconds.
      sayOnChange(
        `dropped:${action.runId}:${action.id ?? action.worker}`,
        `not noted: run ${action.runId}: agent ${action.worker} ${action.reason}: the run did not take the note`,
      );
    }
  };

  const note = async (action: Extract<ServeAction, { kind: "note" }>) => {
    if (action.reason !== "not_started") return writeNote(action);
    const topic = `note:${action.runId}`;
    try {
      await writeNote(action);
    } catch (error) {
      sayOnChange(
        topic,
        `not noted yet: run ${action.runId}: agent ${action.worker} not_started: ${messageOf(error)}; tried again in the next cycle`,
      );
      return;
    }
    sayOnChange(topic, undefined);
    markNoted(action.runId);
  };

  /**
   * Ends the terminal session of a run that is over, with the processes it started. Under the start
   * lock, with the records read again inside it: only a session that still lives, of a run that has
   * ended, is stopped. It decides nothing about a run.
   */
  const finish = (action: Extract<ServeAction, { kind: "finish" }>) =>
    deps.host.withWorkerStartLock(async () => {
      const fresh = await gatherRuns();
      const view = fresh.runs.find((r) => r.runId === action.runId);
      const worker = view?.worker;
      if (
        view === undefined ||
        worker === undefined ||
        !ENDED.includes(view.status) ||
        worker.id !== action.id ||
        worker.terminal !== true ||
        (worker.state !== "starting" && worker.state !== "running")
      ) {
        return;
      }
      await deps.launcher.finish(action.runId);
      say(`finished: run ${action.runId}: agent ${action.worker} stopped (the run is over)`);
    });

  // Under the start lock, as the TUI's resume is: one of the two resumes a decision, and a worker
  // that went on by itself meanwhile is found by the reads inside.
  const resume = (action: Extract<ServeAction, { kind: "resume" }>, config: ProjectConfig) =>
    deps.host.withWorkerStartLock(() => resumeLocked(action, config));

  const resumeLocked = async (
    action: Extract<ServeAction, { kind: "resume" }>,
    config: ProjectConfig,
  ) => {
    const run = await deps.host.open(action.runId);
    if (run === undefined) return;
    // Read again right before: the plan may be a few seconds old.
    const marks = decisionOf(await run.journal());
    if (marks.decision === undefined || marks.decision.seq !== action.seq || marks.moved) {
      say(`not resumed: run ${action.runId}: the run moved on since the plan`);
      return;
    }
    // The worker records too: a person may have removed the record, the run may have ended, or
    // another worker may have taken the last place since the plan.
    const fresh = await gatherRuns();
    const view = fresh.runs.find((r) => r.runId === action.runId);
    if (view?.worker === undefined) {
      say(`not resumed: run ${action.runId}: its worker record is gone (kodel agent rm)`);
      return;
    }
    const verdict = resumeVerdict(view, view.worker, { refuseMoved: true });
    if (verdict.kind === "no" && (verdict.why === "already_resumed" || verdict.why === "active")) {
      say(`resumed: run ${action.runId} was resumed already (kodel agent ls)`);
      return;
    }
    if (verdict.kind !== "resume" || verdict.seq !== action.seq) {
      say(
        `not resumed: run ${action.runId}: ${verdict.kind === "no" ? verdict.why : "a newer decision"} since the plan`,
      );
      return;
    }
    if (servePlaces(fresh.runs, fresh.unreadable).workers >= config.serve.max_workers) {
      say(`not resumed: run ${action.runId}: max_workers is full; tried again in the next cycle`);
      return;
    }
    const located = await run.location();
    const workdir = located === undefined ? deps.root : await run.inProject(located.path);
    const key = `${action.runId}:${action.seq}`;
    try {
      const { name } = await deps.launcher.resume({
        runId: action.runId,
        workdir,
        sessionId: action.sessionId,
        decision: marks.decision,
      });
      if (memory.resume_attempts !== undefined) delete memory.resume_attempts[key];
      say(`resumed: run ${action.runId} as ${name}`);
    } catch (error) {
      if (error instanceof SessionError && error.code === "NAME_TAKEN") {
        say(`resumed: run ${action.runId} was resumed already (kodel agent ls)`);
        return;
      }
      const tried = memory.resume_attempts?.[key];
      const count = (tried?.count ?? 0) + 1;
      memory.resume_attempts = {
        ...memory.resume_attempts,
        [key]: { count, last_at: now(), reason: messageOf(error) },
      };
      say(
        `not resumed: run ${action.runId} (attempt ${count} of ${START_ATTEMPTS}): ${messageOf(error)}`,
      );
    }
  };

  const giveUp = async (action: Extract<ServeAction, { kind: "give_up" }>) => {
    const tasks = deps.tasks;
    if (tasks === undefined) return;
    try {
      await tasks.comment(
        action.taskKey,
        giveUpComment(action.pipeline, redactText(action.reason, rules)),
      );
    } catch (error) {
      // Without the comment the attempts would plan the give-up again every cycle: this daemon gives
      // up on the task in its memory instead, and says so once.
      const attempt = memory.attempts[action.taskKey];
      if (attempt !== undefined) memory.attempts[action.taskKey] = { ...attempt, given_up: true };
      say(
        `gave up: ${action.taskKey}: not started after 3 attempts: ${action.reason}; the comment could not be written (${messageOf(error)}), so this daemon does not start it again until it restarts`,
      );
      return;
    }
    delete memory.attempts[action.taskKey];
    say(`gave up: ${action.taskKey}: not started after 3 attempts: ${action.reason}`);
  };

  const start = async (action: Extract<ServeAction, { kind: "start" }>, config: ProjectConfig) => {
    const tasks = deps.tasks;
    if (tasks === undefined) return;
    const key = action.taskKey;
    const previous = memory.attempts[key];
    const count = (previous?.count ?? 0) + 1;
    memory.attempts[key] = { count, last_at: now(), reason: previous?.reason ?? "" };
    const takeBack = () => {
      if (previous === undefined) delete memory.attempts[key];
      else memory.attempts[key] = previous;
    };
    const fail = (reason: string) => {
      memory.attempts[key] = { count, last_at: now(), reason };
      say(`not started: ${key} (attempt ${count} of 3): ${reason}`);
    };
    const environmentProblem = (reason: string) => {
      takeBack();
      sayOnChange("start-environment", `environment: ${reason}; nothing is started`);
    };
    try {
      await deps.host.withWorkerStartLock(async () => {
        // Read again under the lock: another starter (the TUI's `s`) may have been here since the plan.
        // A read that fails is the environment's problem, not the task's: it uses no attempt.
        let task: Task | undefined;
        let runs: ServeRunView[] = [];
        let unreadable: ServeUnreadableRun[] = [];
        let unreadableOpen: string[] = [];
        try {
          task = await tasks.get(key).catch((error: unknown) => {
            throw new Error(`the task cannot be read: ${messageOf(error)}`);
          });
          if (task !== undefined) {
            const read = await gatherRuns();
            runs = read.runs;
            unreadable = read.unreadable;
            unreadableOpen = read.unreadableOpen;
          }
        } catch (error) {
          environmentProblem(messageOf(error));
          return;
        }
        if (task === undefined) {
          takeBack();
          return;
        }
        const view = fullTaskViewOf(task);
        // The task may have changed since the plan: the rule that matches it now decides, and only for the
        // pipeline the plan chose.
        const rule = ruleFor(view, config.serve.start);
        if (rule === undefined || rule.pipeline !== action.pipeline) {
          takeBack();
          sayOnChange(
            `start:${key}`,
            `not started: ${key}: ${rule === undefined ? "no start rule matches it now" : `the rule that matches it now names pipeline ${rule.pipeline}`}`,
          );
          return;
        }
        const admitted = admitStart({
          task: view,
          runs,
          unreadable,
          limits: { max_workers: config.serve.max_workers, max_runs: config.serve.max_runs },
          approval: rule.match.approval,
          unreadable_open: unreadableOpen,
        });
        if (!admitted.ok) {
          takeBack();
          sayOnChange(
            `start:${key}`,
            `not started: ${key}: ${admitted.links === undefined ? admitted.why : readinessWords(view, admitted.links)}`,
          );
          return;
        }
        let outcome: Awaited<ReturnType<ServeHostPort["start"]>>;
        try {
          outcome = await deps.host.start({
            pipeline: action.pipeline,
            task: taskTextOf(task),
            restart: true,
            task_key: key,
            caller,
          });
        } catch (error) {
          const problem = environmentError(error);
          if (problem !== undefined) environmentProblem(problem);
          else fail(messageOf(error));
          return;
        }
        sayOnChange("start-environment", undefined);
        const runId = outcome.run.runId;
        if (outcome.status !== "started") {
          takeBack();
          sayOnChange(
            `start:${key}`,
            `not started: ${key}: run ${runId} existed already; no agent was launched`,
          );
          return;
        }
        sayOnChange(`start:${key}`, undefined);
        delete memory.attempts[key];
        memory.mine.push(runId);
        const workdir = outcome.workdir?.path ?? deps.root;
        try {
          const { name } = await deps.launcher.start({ runId, workdir, title: task.title });
          say(`started: ${key}: run ${runId} (agent ${name})`);
          const declined = (view.dependencies ?? []).filter((d) => d.state === "declined");
          if (declined.length > 0) {
            say(
              `started past a declined dependency: ${key}: ${declined.map((d) => d.key).join(", ")} was declined, not done`,
            );
          }
        } catch (error) {
          say(
            `not launched: ${key}: run ${runId} was made but no agent was started: ${messageOf(error)}`,
          );
          let recorded: boolean | undefined;
          try {
            recorded = (await deps.launcher.statuses([runId])).has(runId);
          } catch {
            // Cannot tell: a worker may have started. The run waits in `unlaunched` without a note; the next
            // plan, which runs only once the records read, drops it if a record came and notes it if not.
          }
          if (recorded !== true) {
            // It counts as a worker that ended outside a wait; its note is tried again until written.
            const at = now();
            memory.unlaunched.push({ runId, at });
            if (recorded === false) {
              await note({
                kind: "note",
                runId,
                worker: `kw-${runId}`,
                reason: "not_started",
                at,
              });
            }
          }
        }
      });
    } catch (error) {
      const problem = environmentError(error);
      if (problem !== undefined) environmentProblem(problem);
      else fail(messageOf(error));
    }
  };

  const stamps = async (): Promise<string | undefined> => {
    const config = await configStamp(deps.storeRoot).catch(() => undefined);
    if (config === undefined) baseConfig ??= UNPARSED;
    else {
      baseConfig ??= config;
      if (config !== baseConfig) {
        return "the config outside the serve block changed; kodel serve exits to be started again";
      }
    }
    // A build that cannot be read now is no change: the first stamp read is the base.
    if (deps.buildStamp !== undefined) {
      const build = await deps.buildStamp().catch(() => undefined);
      if (build !== undefined) {
        baseBuild ??= build;
        if (build !== baseBuild) {
          return "the kodel build on disk changed; kodel serve exits to be started again";
        }
      }
    }
    return undefined;
  };

  /** Writes the record; the reason to stop when it is no longer this daemon's. */
  const writeRecord = async (
    update: Parameters<ServeRecordHandle["writeCycle"]>[0],
  ): Promise<string | undefined> => {
    if (deps.record === undefined) return undefined;
    const written = await deps.record.writeCycle(update);
    if (!written.ok && written.error instanceof ServeRecordRefused) {
      say(written.error.message);
      return written.error.message;
    }
    sayOnChange(
      "record",
      written.ok
        ? undefined
        : `the record of kodel serve was not written: ${messageOf(written.error)}`,
    );
    return undefined;
  };
  const refusedBy = (reason: string | undefined): ServeCycleResult | undefined =>
    reason === undefined ? undefined : { kind: "refused", reason };

  const cycle = async (signal?: AbortSignal): Promise<ServeCycleResult> => {
    const at = now();
    if (lastCycleAt !== undefined && at - lastCycleAt > GAP_MS) quietFrom = at;
    lastCycleAt = at;
    const changed = await stamps();
    if (changed !== undefined) {
      say(changed);
      return { kind: "restart", reason: changed };
    }
    const loaded = await loadRules();
    if (!loaded.ok || !loaded.config.serve.enabled) {
      const reason = loaded.ok ? "serve.enabled is not true in the config" : loaded.reason;
      sayOnChange("idle", `idle: ${reason}`);
      return (
        refusedBy(await writeRecord({ state: "idle", reason, cycle_at: now() })) ?? {
          kind: "idle",
          reason,
        }
      );
    }
    if (said.has("idle")) {
      said.delete("idle");
      say("active: the serve block is on");
    }
    const config = loaded.config;
    let input: ServeInput;
    try {
      input = await gather(config, at, false);
    } catch (error) {
      const reason = `${messageOf(error)}; nothing is done in this cycle`;
      sayOnChange("records", reason);
      // Idle, not active: the TUI then offers the resumes the daemon cannot make now.
      return (
        refusedBy(await writeRecord({ state: "idle", reason, cycle_at: now() })) ?? {
          kind: "stopped",
          reason,
        }
      );
    }
    sayOnChange("records", undefined);
    const plan = planServe(input);
    memory = plan.memory;
    for (const action of plan.actions) {
      if (signal?.aborted === true) break;
      try {
        switch (action.kind) {
          case "note":
            await note(action);
            break;
          case "finish":
            await finish(action);
            break;
          case "resume":
            await resume(action, config);
            break;
          case "give_up":
            await giveUp(action);
            break;
          case "start":
            await start(action, config);
            break;
          case "log":
            logLine(action);
            break;
        }
      } catch (error) {
        const what =
          action.kind === "start" || action.kind === "give_up"
            ? action.taskKey
            : "runId" in action
              ? `run ${action.runId}`
              : "";
        say(`failed: ${action.kind} ${what}: ${messageOf(error)}`);
      }
    }
    const refused = await writeRecord({
      state: "active",
      cycle_at: now(),
      counts: {
        workers: plan.counts.workers,
        alive: plan.counts.alive,
        max_workers: plan.counts.max_workers,
        runs: plan.counts.runs.length,
        max_runs: plan.counts.max_runs,
      },
    });
    return refusedBy(refused) ?? { kind: "active" };
  };

  return {
    async plan() {
      const loaded = await loadRules();
      if (!loaded.ok) return { config: "error", reason: loaded.reason };
      const input = await gather(loaded.config, now(), true);
      // `memory` is a copy in the plan; nothing of it is kept.
      return { config: "ok", rules: loaded.config.serve, plan: planServe(input) };
    },
    cycle,
    async run(signal) {
      const sleep = deps.sleep ?? sleepFor;
      for (;;) {
        if (signal.aborted) return { exit: 0 };
        const result = await cycle(signal);
        if (result.kind === "restart") return { exit: SERVE_EXIT_RESTART, reason: result.reason };
        if (result.kind === "refused") return { exit: SERVE_EXIT_REFUSED, reason: result.reason };
        if (signal.aborted) return { exit: 0 };
        await sleep(deps.cycleMs ?? SERVE_CYCLE_MS, signal);
      }
    },
    memory: () => structuredClone(memory),
  };
}
