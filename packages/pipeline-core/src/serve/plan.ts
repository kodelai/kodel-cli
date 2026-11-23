/**
 * What `kodel serve` does in one cycle (TASK-G8KM, T-44). Pure: the person's rules, the runs, the
 * workers, the tasks and the daemon's memory in (`now` is an input), the actions and the new memory
 * out. The daemon acts only on what this returns; `kodel serve --status` shows it and acts on nothing.
 *
 * Nothing here decides anything about a run: the actions are a note that a worker is gone, a resume
 * after a decision a person made, a start of a task, a give-up comment on a task and a log line.
 */
import type { RunStatus } from "../run";
import { order, startPolicy, workerPolicy } from "../schedule/queue";
import { rank } from "../schedule/rank";
import { type Readiness, readinessWords, ready } from "../schedule/ready";
import { type DependencyRef, TASK_LIMITS, type TaskState } from "../tasks";
import {
  type DecisionInfo,
  type ResumeNo,
  type ResumeVerdict,
  resumeVerdict,
  type ServeWorkerView,
} from "./resume";

/** `required`: a task that waits for `kodel task approve` is not taken; `any`: it is taken too. */
export type ServeApproval = "required" | "any";

export interface ServeMatch {
  status?: string[];
  priority?: string[];
  parent?: string;
  approval: ServeApproval;
}

/** One rule of `serve.start`: the first rule whose match fits a task decides whether and with which pipeline it starts. */
export interface ServeStartRule {
  pipeline: string;
  match: ServeMatch;
}

export interface ServeRules {
  enabled: boolean;
  max_workers: number;
  max_runs: number;
  stalled_after_s: number;
  /** Empty: the daemon starts nothing and only resumes and watches. */
  start: ServeStartRule[];
}

export interface ServeTaskView {
  key: string;
  title: string;
  status: string;
  state: TaskState;
  priority?: string;
  parent?: string;
  /** The text of the task's latest comment. */
  comment?: string;
  needs_approval?: boolean;
  /** Runs the tracker lists for the task besides `created_in_run`. */
  started_runs: number;
  /** The links of the task (T-45), as the tracker reads them; absent when it has none. */
  depends_on?: string[];
  dependencies?: DependencyRef[];
  conflicts_with?: string[];
  blocks?: string[];
  created_at?: string;
}

export interface ServeRunView {
  runId: string;
  status: RunStatus;
  /** The format of the run has `workerNotes`. */
  canNote: boolean;
  taskKey?: string;
  waitsForPerson: boolean;
  marks?: DecisionInfo;
  worker?: ServeWorkerView;
  /** Record ids that have a `gone` note. */
  noted: string[];
}

export interface ServeMemory {
  attempts: Record<
    string,
    {
      count: number;
      last_at: number;
      reason: string;
      /** The give-up comment could not be written: this daemon starts the task no more and does not try again. */
      given_up?: boolean;
    }
  >;
  /** Run ids this daemon started, for the count below. */
  mine: string[];
  dead_in_a_row: number;
  /** Marks of log lines already printed, and of workers already counted. */
  logged: string[];
  /**
   * Runs this daemon made whose agent did not start and left no worker record, or whose records could not be
   * read right after the failed launch: each counts once as a worker that ended outside a wait, and gets its
   * `not_started` note (`noted` once it is written), unless a worker record shows up first.
   */
  unlaunched: { runId: string; at: number; noted?: true }[];
  /**
   * Failed resumes by `<run id>:<decision seq>`: tried again `START_RETRY_MS` apart, given up after
   * `START_ATTEMPTS`, so a resume that cannot work neither repeats every cycle nor holds a worker place.
   */
  resume_attempts?: Record<string, { count: number; last_at: number; reason: string }>;
}

export interface ServeUnreadableRun {
  runId: string;
  why: "cannot_read" | "newer" | "modified";
  detail: string;
  /** Its worker's latest record, when there is one: an unreadable run holds the places it has. */
  worker?: ServeWorkerView;
}

export interface ServeInput {
  now: number;
  rules: ServeRules;
  runs: ServeRunView[];
  memory: ServeMemory;
  unreadable: ServeUnreadableRun[];
  /** The daemon's start or the last gap between two cycles, whichever is later. */
  quietFrom: number;
  tasks?: {
    list: ServeTaskView[];
    complete: boolean;
    priorities: string[];
    /** Every open task, read without the rule filter when a listed task has a link: the order counts them all. */
    graph?: ServeTaskView[];
  };
  /** Runs that cannot be read, have no worker record and are not known to have ended (T-45). */
  unreadable_open?: string[];
  environment: { ok: true } | { ok: false; reason: string };
}

export type ServeLogProblem =
  | "stalled"
  | "dead"
  | "moved"
  | "no_session_id"
  | "unreadable"
  | "queued"
  | "environment"
  | "paused"
  | "resume_failed";

export type ServeAction =
  | {
      kind: "note";
      runId: string;
      worker: string;
      /** The worker record's id; a launch that left no record has none. */
      id?: string;
      reason: "lost" | "killed" | "exited" | "not_started";
      exit_code?: number;
      at?: number;
    }
  | { kind: "resume"; runId: string; seq: number; sessionId: string }
  | { kind: "start"; taskKey: string; pipeline: string }
  | { kind: "give_up"; taskKey: string; pipeline: string; reason: string }
  | { kind: "log"; mark: string; problem: ServeLogProblem; runId?: string; detail?: string };

export interface ServePlan {
  /** In order: notes, resumes, give-ups, starts, then log lines. */
  actions: ServeAction[];
  memory: ServeMemory;
  counts: { workers: number; max_workers: number; runs: string[]; max_runs: number };
  waiting: { resumes: string[]; starts: string[] };
  /** Open runs with a task and no agent; for `--status` only, nothing acts on them. */
  orphans: string[];
  /** Why no task is started: the environment, or the pause after dead workers; for `--status`. */
  blocked?: string;
  /** Both queues in their order, with the reason of each place (T-46); for `--status`. */
  queues: {
    starts: { key: string; reason: string }[];
    workers: { runId: string; reason: string }[];
  };
  /** Tasks a rule takes that their links hold back (T-45), with the reason; keys and run ids only. */
  blocked_tasks: { key: string; reason: string }[];
}

export type Admission =
  | { ok: true }
  | {
      ok: false;
      why:
        | "done"
        | "not_todo"
        | "has_run"
        | "not_approved"
        | "blocked"
        | "conflict"
        | "gave_up"
        | "max_runs"
        | "max_workers";
      /** With `blocked` and `conflict`: what holds the task back. */
      links?: Exclude<Readiness, { ok: true }>;
    };

/** Attempts at a start before the daemon gives up on a task. */
export const START_ATTEMPTS = 3;
/** Time between two attempts at one start. */
export const START_RETRY_MS = 60_000;
/** Workers in a row the daemon started that ended outside a wait before it starts nothing more (Decision 3a). */
export const DEAD_IN_A_ROW = 3;

const GIVE_UP_PREFIX = `kodel serve: not started after ${START_ATTEMPTS} attempts`;

/** The comment the daemon leaves on a task it gave up on; the latest comment of that text stops the starts. */
export function giveUpComment(pipeline: string, reason: string): string {
  const head = `${GIVE_UP_PREFIX} (pipeline ${pipeline}): `;
  const tail = ". A newer comment makes the daemon try again; or start it by its key in the TUI.";
  // A tracker refuses a longer comment, and a give-up that cannot be written would be tried for ever.
  const room = Math.max(0, TASK_LIMITS.comment - head.length - tail.length);
  const clipped = reason.length > room ? `${reason.slice(0, Math.max(0, room - 1))}…` : reason;
  return `${head}${clipped}${tail}`;
}

export const isGiveUpComment = (comment: string | undefined): boolean =>
  comment?.startsWith(GIVE_UP_PREFIX) === true;

const OPEN: readonly RunStatus[] = ["running", "paused"];
const isOpen = (run: { status: RunStatus }) => OPEN.includes(run.status);

/** Verdicts of a worker that no longer holds its run's place in `max_runs`. */
const RELEASES_RUN: readonly ResumeNo[] = [
  "dead",
  "not_at_wait",
  "wait_before_start",
  // Another agent took the run on from a later wait: this worker is never resumed again.
  "went_on",
  "already_resumed",
  "no_session_id",
  "agent_decided",
  "over",
];

const holdsWorker = (worker: ServeWorkerView | undefined): boolean =>
  worker !== undefined &&
  (worker.state === "starting" || worker.state === "running" || worker.state === "unknown");

const verdictOf = (run: ServeRunView): ResumeVerdict =>
  resumeVerdict(run, run.worker, { refuseMoved: true });

function holdsRun(run: ServeRunView): boolean {
  if (!isOpen(run) || run.worker === undefined) return false;
  const verdict = verdictOf(run);
  return verdict.kind === "resume" || !RELEASES_RUN.includes(verdict.why);
}

/** A worker of an unreadable run holds its places unless it is gone for good: fail closed. */
const unreadableHoldsRun = (run: ServeUnreadableRun): boolean =>
  run.worker !== undefined && run.worker.state !== "lost" && run.worker.state !== "killed";

/** The worker places and the `max_runs` places held now; every starter and resumer counts them this way. */
export function servePlaces(
  runs: readonly ServeRunView[],
  unreadable: readonly ServeUnreadableRun[] = [],
): { workers: number; runs: string[] } {
  const workers =
    runs.filter((r) => holdsWorker(r.worker)).length +
    unreadable.filter((r) => holdsWorker(r.worker)).length;
  const held = [
    ...runs.filter(holdsRun).map((r) => r.runId),
    ...unreadable.filter(unreadableHoldsRun).map((r) => r.runId),
  ];
  return { workers, runs: held };
}

/** The open runs that name a task, whoever started them: task key to run id. */
export function openRunTasks(runs: readonly ServeRunView[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const run of runs) {
    if (isOpen(run) && run.taskKey !== undefined && !out.has(run.taskKey)) {
      out.set(run.taskKey, run.runId);
    }
  }
  return out;
}

/** Whether the task may be started now: by the rules every starter keeps, and by the limits when given. */
export function admitStart(input: {
  task: ServeTaskView;
  runs: ServeRunView[];
  /** Runs that cannot be read: their workers hold their places, as in `planServe`. */
  unreadable?: ServeUnreadableRun[];
  limits?: { max_workers: number; max_runs: number };
  /** The approval setting of the rule that took the task; without one, approval is required (fail closed). */
  approval?: ServeApproval;
  /** Unreadable runs with no worker record that are not known to have ended. */
  unreadable_open?: readonly string[];
  /** Tasks started earlier in this cycle. */
  started_now?: readonly string[];
}): Admission {
  const { task, runs, limits } = input;
  if (task.state === "done") return { ok: false, why: "done" };
  if (task.state !== "todo") return { ok: false, why: "not_todo" };
  if (task.started_runs > 0 || runs.some((r) => r.taskKey === task.key)) {
    return { ok: false, why: "has_run" };
  }
  if (task.needs_approval === true && input.approval !== "any") {
    return { ok: false, why: "not_approved" };
  }
  const links = ready({
    task,
    approval: input.approval ?? "required",
    openRunTasks: openRunTasks(runs),
    unreadableRuns: [
      ...(input.unreadable ?? []).map((r) => r.runId),
      ...(input.unreadable_open ?? []),
    ],
    startedNow: input.started_now ?? [],
  });
  if (!links.ok) return { ok: false, why: links.why, links };
  if (isGiveUpComment(task.comment)) return { ok: false, why: "gave_up" };
  if (limits !== undefined) {
    const now = servePlaces(runs, input.unreadable);
    if (now.runs.length >= limits.max_runs) return { ok: false, why: "max_runs" };
    if (now.workers >= limits.max_workers) return { ok: false, why: "max_workers" };
  }
  return { ok: true };
}

/**
 * Whether a task matches a start rule: every key given holds, and a task that waits for approval only
 * under `approval: any`; a match with no other key is every task.
 */
export function matchesRule(
  task: ServeTaskView,
  match: Omit<ServeMatch, "approval"> & { approval?: ServeApproval },
): boolean {
  if (task.needs_approval === true && match.approval !== "any") return false;
  if (match.status !== undefined && !match.status.includes(task.status)) return false;
  if (
    match.priority !== undefined &&
    (task.priority === undefined || !match.priority.includes(task.priority))
  ) {
    return false;
  }
  if (match.parent !== undefined && task.parent !== match.parent) return false;
  return true;
}

/** The first rule whose match fits the task: it decides whether and with which pipeline the task starts. */
export function ruleFor(
  task: ServeTaskView,
  start: readonly ServeStartRule[],
): ServeStartRule | undefined {
  return start.find((rule) => matchesRule(task, rule.match));
}

/** Log lines printed once: a mark is remembered until the condition is gone. */
class Lines {
  readonly actions: ServeAction[] = [];
  constructor(readonly logged: string[]) {}

  once(mark: string, line: Omit<Extract<ServeAction, { kind: "log" }>, "kind" | "mark">) {
    if (this.logged.includes(mark)) return;
    this.logged.push(mark);
    this.actions.push({ kind: "log", mark, ...line });
  }

  /** One line per change of a condition that has one value at a time (`prefix:<value>`). */
  onChange(
    prefix: string,
    value: string | undefined,
    line: Omit<Extract<ServeAction, { kind: "log" }>, "kind" | "mark">,
  ) {
    const mark = value === undefined ? undefined : `${prefix}:${value}`;
    const stale = this.logged.filter((m) => m.startsWith(`${prefix}:`) && m !== mark);
    for (const m of stale) this.logged.splice(this.logged.indexOf(m), 1);
    if (mark !== undefined) this.once(mark, line);
  }

  forget(mark: string) {
    const i = this.logged.indexOf(mark);
    if (i >= 0) this.logged.splice(i, 1);
  }
}

/** How a worker of the daemon's own runs ended, for the count of dead workers in a row. */
function endOf(run: ServeRunView, verdict: ResumeVerdict): "dead" | "fine" | undefined {
  const worker = run.worker;
  if (worker === undefined || worker.stopped === true) return undefined;
  if (worker.state === "lost" || worker.state === "killed") return "dead";
  if (worker.state !== "exited") return undefined;
  if (verdict.kind === "resume") return "fine";
  if (verdict.why === "not_at_wait" || verdict.why === "wait_before_start") return "dead";
  return "fine";
}

/** The note for a worker that is gone, if it is one that is noted. */
function goneReason(
  run: ServeRunView,
  verdict: ResumeVerdict,
): "lost" | "killed" | "exited" | undefined {
  const worker = run.worker;
  if (worker === undefined || worker.stopped === true || !isOpen(run)) return undefined;
  if (worker.state === "lost") return "lost";
  if (worker.state === "killed") return "killed";
  if (
    worker.state === "exited" &&
    verdict.kind === "no" &&
    (verdict.why === "not_at_wait" || verdict.why === "wait_before_start")
  ) {
    return "exited";
  }
  return undefined;
}

export function planServe(input: ServeInput): ServePlan {
  const { now, rules, runs } = input;
  const memory: ServeMemory = {
    attempts: structuredClone(input.memory.attempts),
    mine: [...input.memory.mine],
    dead_in_a_row: input.memory.dead_in_a_row,
    logged: [...input.memory.logged],
    unlaunched: input.memory.unlaunched.map((u) => ({ ...u })),
    ...(input.memory.resume_attempts === undefined
      ? {}
      : { resume_attempts: structuredClone(input.memory.resume_attempts) }),
  };
  const lines = new Lines(memory.logged);
  const notes: ServeAction[] = [];
  const verdicts = new Map(runs.map((r) => [r.runId, verdictOf(r)] as const));

  for (const run of input.unreadable) {
    lines.once(`unreadable:${run.runId}:${run.why}`, {
      problem: "unreadable",
      runId: run.runId,
      detail: run.detail,
    });
  }

  // Workers that are gone: a note once per record id, or a log line where the format has no place.
  for (const run of runs) {
    const worker = run.worker;
    const verdict = verdicts.get(run.runId);
    if (worker === undefined || verdict === undefined) continue;
    const reason = goneReason(run, verdict);
    if (reason === undefined || run.noted.includes(worker.id)) continue;
    if (run.canNote) {
      notes.push({
        kind: "note",
        runId: run.runId,
        worker: worker.name,
        id: worker.id,
        reason,
        ...(worker.exitCode === undefined ? {} : { exit_code: worker.exitCode }),
        ...(worker.since === undefined ? {} : { at: worker.since }),
      });
    } else {
      lines.once(`dead:${worker.id}`, {
        problem: "dead",
        runId: run.runId,
        detail: `${worker.name} ${reason}`,
      });
    }
  }

  // A launch that left no record: its note until it is written; a worker that came since makes it moot.
  const views = new Map(runs.map((r) => [r.runId, r] as const));
  memory.unlaunched = memory.unlaunched.filter((u) => {
    const view = views.get(u.runId);
    if (view?.worker !== undefined || (view !== undefined && !isOpen(view))) return false;
    if (u.noted === true) return true;
    if (view !== undefined && !view.canNote) {
      lines.once(`dead:launch:${u.runId}`, {
        problem: "dead",
        runId: u.runId,
        detail: `kw-${u.runId} not_started`,
      });
      u.noted = true;
    } else {
      notes.push({
        kind: "note",
        runId: u.runId,
        worker: `kw-${u.runId}`,
        reason: "not_started",
        at: u.at,
      });
    }
    return true;
  });

  // Decision 3a: workers this daemon started that ended outside a wait, in the order they ended;
  // a launch that left no record is one of them.
  const unlaunchedEnds = memory.unlaunched
    .filter((u) => memory.mine.includes(u.runId))
    .map((u) => ({ id: `launch:${u.runId}`, end: "dead" as const, at: u.at }))
    .filter((u) => !memory.logged.includes(`ended:${u.id}`));
  // A run that reached its end resets the count too, though an ended run is read without its worker.
  const completedEnds = runs
    .filter(
      (r) =>
        memory.mine.includes(r.runId) &&
        r.status === "completed" &&
        !memory.logged.includes(`ended:run:${r.runId}`),
    )
    .map((r) => ({
      id: `run:${r.runId}`,
      end: "fine" as const,
      at: r.worker?.since ?? r.worker?.started ?? now,
    }));
  const ends = runs
    .filter((r) => memory.mine.includes(r.runId) && r.worker !== undefined)
    .flatMap((r) => {
      const worker = r.worker as ServeWorkerView;
      const verdict = verdicts.get(r.runId);
      const end = verdict === undefined ? undefined : endOf(r, verdict);
      return end === undefined || memory.logged.includes(`ended:${worker.id}`)
        ? []
        : [{ id: worker.id, end, at: worker.since ?? worker.started }];
    })
    .concat(unlaunchedEnds, completedEnds)
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const { id, end } of ends) {
    memory.logged.push(`ended:${id}`);
    memory.dead_in_a_row = end === "dead" ? memory.dead_in_a_row + 1 : 0;
  }
  memory.unlaunched = memory.unlaunched.filter(
    (u) =>
      u.noted !== true ||
      (memory.mine.includes(u.runId) && !memory.logged.includes(`ended:launch:${u.runId}`)),
  );
  const paused = memory.dead_in_a_row >= DEAD_IN_A_ROW;
  const pausedDetail = `${memory.dead_in_a_row} workers in a row ended outside a wait; kodel serve starts nothing more until it is restarted`;
  if (paused) {
    lines.once("paused", { problem: "paused", detail: pausedDetail });
  } else {
    lines.forget("paused");
  }

  // Stalled: running, and quiet since the latest of its last output, its start and `quietFrom`.
  if (rules.stalled_after_s > 0) {
    for (const run of runs) {
      const worker = run.worker;
      if (worker === undefined || worker.state !== "running") continue;
      const quietSince = Math.max(worker.lastOutputAt ?? 0, worker.started, input.quietFrom);
      if (now - quietSince < rules.stalled_after_s * 1000) continue;
      lines.once(`stalled:${worker.id}:${quietSince}`, {
        problem: "stalled",
        runId: run.runId,
        detail: `${worker.name} printed nothing for ${Math.floor((now - quietSince) / 1000)} s`,
      });
    }
  }

  const before = servePlaces(runs, input.unreadable);
  let workers = before.workers;
  const heldRuns = [...before.runs];

  // Resumes, oldest decision first; each needs a worker place only.
  const resumable: { run: ServeRunView; seq: number; ts: number; sessionId: string }[] = [];
  const retrying: string[] = [];
  for (const run of runs) {
    const verdict = verdicts.get(run.runId);
    if (verdict === undefined) continue;
    if (verdict.kind === "resume") {
      const sessionId = run.worker?.sessionId;
      const tried = memory.resume_attempts?.[`${run.runId}:${verdict.seq}`];
      if (tried !== undefined && tried.count >= START_ATTEMPTS) {
        lines.once(`resume_failed:${run.runId}:${verdict.seq}`, {
          problem: "resume_failed",
          runId: run.runId,
          detail: `not resumed after ${START_ATTEMPTS} attempts: ${tried.reason}; continue the run with any agent, or stop kodel serve and resume it in the TUI`,
        });
        continue;
      }
      if (tried !== undefined && now - tried.last_at < START_RETRY_MS) {
        // It goes before any start, as a waiting resume does: a start must not take its worker place.
        retrying.push(run.runId);
        continue;
      }
      if (sessionId !== undefined) {
        resumable.push({ run, seq: verdict.seq, ts: verdict.decision.ts, sessionId });
      }
    } else if (verdict.why === "moved" || verdict.why === "no_session_id") {
      const seq = run.marks?.decision?.seq;
      lines.once(`${verdict.why}:${run.runId}:${seq ?? "?"}`, {
        problem: verdict.why,
        runId: run.runId,
        ...(verdict.why === "moved"
          ? { detail: "an agent was served a step since the decision; not resumed" }
          : { detail: "the worker's session id is not known; not resumed" }),
      });
    }
  }
  const workerQueue = order(
    resumable.map((r) => ({ ...r, runId: r.run.runId })),
    workerPolicy,
    { priorities: [], ranks: new Map() },
  );
  const resumes: ServeAction[] = [];
  const waitingResumes: string[] = [...retrying];
  for (const { entry: r } of workerQueue) {
    if (rules.enabled && workers < rules.max_workers) {
      resumes.push({ kind: "resume", runId: r.run.runId, seq: r.seq, sessionId: r.sessionId });
      workers += 1;
    } else {
      waitingResumes.push(r.run.runId);
    }
  }

  // Starts.
  const giveUps: ServeAction[] = [];
  const starts: ServeAction[] = [];
  const waitingStarts: string[] = [];
  const startQueue: { key: string; reason: string }[] = [];
  const blockedTasks: { key: string; reason: string }[] = [];
  const starting = rules.start.length > 0;
  const incomplete =
    starting && input.tasks !== undefined && input.environment.ok && !input.tasks.complete;
  const problem = !input.environment.ok
    ? input.environment.reason
    : incomplete
      ? "the task list is incomplete; nothing is started"
      : undefined;
  lines.onChange("environment", problem, {
    problem: "environment",
    ...(problem === undefined ? {} : { detail: problem }),
  });
  if (starting && input.tasks !== undefined && input.environment.ok && !incomplete) {
    const priorities = input.tasks.priorities;
    // One order across every rule: the rule decides only whether the task is taken and its pipeline.
    // Tasks no rule takes still count for the order (they raise a priority); they are not started.
    const ranks = rank(
      (input.tasks.graph ?? input.tasks.list).map((task, place) => ({ ...task, order: place })),
      priorities,
    );
    const admitted: {
      key: string;
      priority?: string;
      task: ServeTaskView;
      rule: ServeStartRule;
    }[] = [];
    for (const task of input.tasks.list) {
      const rule = ruleFor(task, rules.start);
      if (rule === undefined) continue;
      const admission = admitStart({
        task,
        runs,
        unreadable: input.unreadable,
        approval: rule.match.approval,
        ...(input.unreadable_open === undefined ? {} : { unreadable_open: input.unreadable_open }),
      });
      if (admission.ok) {
        admitted.push({
          key: task.key,
          ...(task.priority === undefined ? {} : { priority: task.priority }),
          task,
          rule,
        });
      } else if (admission.links !== undefined) {
        blockedTasks.push({ key: task.key, reason: readinessWords(task, admission.links) });
      }
    }
    const candidates = order(admitted, startPolicy, { priorities, ranks });
    /** Tasks started in this cycle and the tasks they must not run beside, to the task that holds them back. */
    const startedNow: string[] = [];
    const heldBack = new Map<string, string>();
    const queued: string[] = [];
    for (const { entry, reason } of candidates) {
      const { task, rule } = entry;
      const attempt = memory.attempts[task.key];
      if (attempt !== undefined && attempt.count >= START_ATTEMPTS) {
        // The attempts stay until the comment is written (the daemon clears them then).
        if (rules.enabled && attempt.given_up !== true) {
          giveUps.push({
            kind: "give_up",
            taskKey: task.key,
            pipeline: rule.pipeline,
            reason: attempt.reason,
          });
        }
        continue;
      }
      startQueue.push({ key: task.key, reason });
      if (attempt !== undefined && now - attempt.last_at < START_RETRY_MS) {
        waitingStarts.push(task.key);
        continue;
      }
      // Two tasks that conflict are never started in one cycle, whichever of them names the other.
      const beside =
        heldBack.get(task.key) ?? task.conflicts_with?.find((key) => startedNow.includes(key));
      if (beside !== undefined) {
        startQueue.pop();
        blockedTasks.push({
          key: task.key,
          reason: readinessWords(task, { ok: false, why: "conflict", with: beside }),
        });
        continue;
      }
      const room =
        rules.enabled &&
        !paused &&
        waitingResumes.length === 0 &&
        heldRuns.length < rules.max_runs &&
        workers < rules.max_workers;
      if (room) {
        starts.push({ kind: "start", taskKey: task.key, pipeline: rule.pipeline });
        workers += 1;
        heldRuns.push(`task:${task.key}`);
        startedNow.push(task.key);
        for (const other of task.conflicts_with ?? []) {
          if (!heldBack.has(other)) heldBack.set(other, task.key);
        }
      } else {
        waitingStarts.push(task.key);
        queued.push(task.key);
      }
    }
    const queuedValue =
      rules.enabled && !paused && queued.length > 0 ? queued.join(",") : undefined;
    lines.onChange("queued", queuedValue, {
      problem: "queued",
      detail: `waiting for a place: ${queued.join(", ")}`,
    });
  }

  // Off: the daemon is idle and acts on nothing; the rest is what `--status` shows.
  return {
    actions: rules.enabled ? [...notes, ...resumes, ...giveUps, ...starts, ...lines.actions] : [],
    memory: rules.enabled ? memory : structuredClone(input.memory),
    counts: {
      workers: before.workers,
      max_workers: rules.max_workers,
      runs: before.runs,
      max_runs: rules.max_runs,
    },
    waiting: { resumes: waitingResumes, starts: waitingStarts },
    orphans: runs
      .filter((r) => isOpen(r) && r.taskKey !== undefined && r.worker === undefined)
      .map((r) => r.runId),
    ...(!starting
      ? {}
      : problem !== undefined
        ? { blocked: problem }
        : paused
          ? { blocked: pausedDetail }
          : {}),
    queues: {
      starts: startQueue,
      workers: workerQueue.map(({ entry, reason }) => ({ runId: entry.runId, reason })),
    },
    blocked_tasks: blockedTasks,
  };
}
