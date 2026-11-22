/**
 * What `kodel serve` does in one cycle (TASK-G8KM, T-44). Pure: the person's rules, the runs, the
 * workers, the tasks and the daemon's memory in (`now` is an input), the actions and the new memory
 * out. The daemon acts only on what this returns; `kodel serve --status` shows it and acts on nothing.
 *
 * Nothing here decides anything about a run: the actions are a note that a worker is gone, the end of
 * the session of a run that is over, a resume after a decision a person made, a start of a task, a
 * give-up comment on a task and a log line.
 */
import type { RunStatus } from "../run";
import { TASK_LIMITS, type TaskState } from "../tasks";
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
  /**
   * The run only waits for the person: its answer is a wait and no step is open for an agent. A live
   * worker in a terminal of such a run is alive and not working (T-45).
   */
  idleAtWait?: boolean;
  /** When an agent last called the engine for this run (served, claimed or completed a step), by the journal. */
  lastAgentAt?: number;
  /** When the journal behind `marks` and `lastAgentAt` was read; absent when it was not read. */
  marksAt?: number;
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
  tasks?: { list: ServeTaskView[]; complete: boolean; priorities: string[] };
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
  | "resume_failed"
  | "child_alive"
  | "not_moving"
  | "no_first_call"
  | "over_limit";

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
  /** The run is over and its worker's terminal session still runs: the session is ended. */
  | { kind: "finish"; runId: string; worker: string; id: string }
  | { kind: "resume"; runId: string; seq: number; sessionId: string }
  | { kind: "start"; taskKey: string; pipeline: string }
  | { kind: "give_up"; taskKey: string; pipeline: string; reason: string }
  | { kind: "log"; mark: string; problem: ServeLogProblem; runId?: string; detail?: string };

export interface ServePlan {
  /** In order: notes, at most one finish, resumes, give-ups, starts, then log lines. */
  actions: ServeAction[];
  memory: ServeMemory;
  /**
   * `workers`: the worker places used, the agents that are working. `alive`: the live worker processes,
   * those that only wait with the person among them.
   */
  counts: {
    workers: number;
    alive: number;
    max_workers: number;
    runs: string[];
    max_runs: number;
  };
  /** Workers that are quiet for `stalled_after_s` now, with the places each holds; for `--status`. */
  stalled: {
    runId: string;
    worker: string;
    /** In a terminal of its own (`kodel agent attach` opens it); a print worker has none. */
    terminal: boolean;
    quietS: number;
    holdsWorker: boolean;
    holdsRun: boolean;
  }[];
  waiting: { resumes: string[]; starts: string[] };
  /** Open runs with a task and no agent; for `--status` only, nothing acts on them. */
  orphans: string[];
  /** Why no task is started: the environment, or the pause after dead workers; for `--status`. */
  blocked?: string;
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
        | "gave_up"
        | "max_runs"
        | "max_workers";
    };

/** Attempts at a start before the daemon gives up on a task. */
export const START_ATTEMPTS = 3;
/** Time between two attempts at one start. */
export const START_RETRY_MS = 60_000;
/** Workers in a row the daemon started that ended outside a wait before it starts nothing more (Decision 3a). */
export const DEAD_IN_A_ROW = 3;
/** How long a live worker may stay without a call of the engine, after its start or a decision, before it is said. */
export const NOT_MOVING_MS = 120_000;

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
  // A person stopped it at the wait and resumes it themselves, or not.
  "stopped",
];

/** Verdicts of a worker that ended outside a wait: noted as gone and counted as dead. */
const DIED: readonly ResumeNo[] = ["dead", "not_at_wait", "wait_before_start"];

const isLive = (worker: ServeWorkerView): boolean =>
  worker.state === "starting" || worker.state === "running";

/** The session is over and its process still runs without a holder: alive for every rule. */
const isOrphan = (worker: ServeWorkerView): boolean =>
  (worker.state === "lost" || worker.state === "killed") && worker.childAlive === true;

/**
 * Whether a worker holds a `max_workers` place: it is an agent that is working. A live worker in a
 * terminal whose run only waits for the person is alive and holds none; everything that cannot be
 * told (an unknown record, a run that cannot be read, a process left without a holder) holds one.
 */
function holdsWorker(worker: ServeWorkerView | undefined, run?: { idleAtWait?: boolean }): boolean {
  if (worker === undefined) return false;
  if (worker.state === "unknown" || isOrphan(worker)) return true;
  if (!isLive(worker)) return false;
  return !(worker.terminal === true && worker.state === "running" && run?.idleAtWait === true);
}

/** A worker process that is alive, working or not; a record that cannot be read counts (fail closed). */
const isAlive = (worker: ServeWorkerView | undefined): boolean =>
  worker !== undefined && (isLive(worker) || worker.state === "unknown" || isOrphan(worker));

const verdictOf = (run: ServeRunView): ResumeVerdict =>
  resumeVerdict(run, run.worker, { refuseMoved: true });

function holdsRun(run: ServeRunView): boolean {
  if (!isOpen(run) || run.worker === undefined) return false;
  const verdict = verdictOf(run);
  return verdict.kind === "resume" || !RELEASES_RUN.includes(verdict.why);
}

/** A worker of an unreadable run holds its places unless it is gone for good: fail closed. */
const unreadableHoldsRun = (run: ServeUnreadableRun): boolean =>
  run.worker !== undefined &&
  ((run.worker.state !== "lost" && run.worker.state !== "killed") || isOrphan(run.worker));

/** The worker places and the `max_runs` places held now; every starter and resumer counts them this way. */
export function servePlaces(
  runs: readonly ServeRunView[],
  unreadable: readonly ServeUnreadableRun[] = [],
): { workers: number; runs: string[] } {
  const workers =
    runs.filter((r) => holdsWorker(r.worker, r)).length +
    unreadable.filter((r) => holdsWorker(r.worker)).length;
  const held = [
    ...runs.filter(holdsRun).map((r) => r.runId),
    ...unreadable.filter(unreadableHoldsRun).map((r) => r.runId),
  ];
  return { workers, runs: held };
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

const died = (verdict: ResumeVerdict): boolean =>
  verdict.kind === "no" && DIED.includes(verdict.why);

/** How a worker of the daemon's own runs ended, for the count of dead workers in a row. */
function endOf(run: ServeRunView, verdict: ResumeVerdict): "dead" | "fine" | undefined {
  const worker = run.worker;
  if (worker === undefined || worker.stopped === true) return undefined;
  if (worker.state !== "lost" && worker.state !== "killed" && worker.state !== "exited") {
    return undefined;
  }
  // Its process still runs: it has not ended.
  if (verdict.kind === "no" && verdict.why === "child_alive") return undefined;
  return died(verdict) ? "dead" : "fine";
}

/** The note for a worker that is gone, if it is one that is noted: it ended outside a wait. */
function goneReason(
  run: ServeRunView,
  verdict: ResumeVerdict,
): "lost" | "killed" | "exited" | undefined {
  const worker = run.worker;
  if (worker === undefined || worker.stopped === true || !isOpen(run)) return undefined;
  if (!died(verdict)) return undefined;
  return worker.state === "lost" || worker.state === "killed" || worker.state === "exited"
    ? worker.state
    : undefined;
}

function priorityRank(priorities: readonly string[], priority: string | undefined): number {
  const i = priority === undefined ? -1 : priorities.indexOf(priority);
  return i < 0 ? priorities.length : i;
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

  // A process left without a holder: said once, and nothing is done about it but by the person.
  for (const run of [...runs, ...input.unreadable]) {
    const worker = run.worker;
    if (worker === undefined || !isOrphan(worker)) continue;
    lines.once(`child_alive:${worker.id}`, {
      problem: "child_alive",
      runId: run.runId,
      detail: `${worker.name}: its process still runs without a holder; stop it: kodel agent stop ${worker.id}`,
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

  // Stalled: running, and quiet for `stalled_after_s`. A print worker by its output. A worker in a
  // terminal with a step open when it printed nothing and called the engine with nothing (by calls
  // alone when its agent writes while idle); never while its run only waits for the person.
  const stalled: ServePlan["stalled"] = [];
  const stalledMs = rules.stalled_after_s * 1000;
  if (stalledMs > 0) {
    for (const run of runs) {
      const worker = run.worker;
      if (worker === undefined || worker.state !== "running") continue;
      const terminal = worker.terminal === true;
      if (terminal && (run.idleAtWait === true || !isOpen(run))) continue;
      const signs = terminal
        ? [worker.idleWrites === true ? 0 : (worker.lastOutputAt ?? 0), run.lastAgentAt ?? 0]
        : [worker.lastOutputAt ?? 0];
      const quietSince = Math.max(...signs, worker.started, input.quietFrom);
      if (now - quietSince < stalledMs) continue;
      // The calls are read from the journal, which is not read every cycle: only a read that is
      // itself late enough shows that none came.
      if (terminal && (run.marksAt === undefined || run.marksAt - quietSince < stalledMs)) continue;
      const quietS = Math.floor((now - quietSince) / 1000);
      stalled.push({
        runId: run.runId,
        worker: worker.name,
        terminal,
        quietS,
        holdsWorker: holdsWorker(worker, run),
        holdsRun: holdsRun(run),
      });
      lines.once(`stalled:${worker.id}:${quietSince}`, {
        problem: "stalled",
        runId: run.runId,
        detail: !terminal
          ? `${worker.name} printed nothing for ${quietS} s`
          : worker.idleWrites === true
            ? `${worker.name}: no engine call for ${quietS} s (it may be a long step)`
            : `${worker.name} printed nothing and called nothing for ${quietS} s`,
      });
    }
  }

  // A live worker in a terminal that does not call the engine: after its start, and after a decision
  // it was alive at. Said once; nothing is typed for the person. Not for a run that only waits again.
  for (const run of runs) {
    const worker = run.worker;
    if (worker === undefined || worker.state !== "running" || worker.terminal !== true) continue;
    if (!isOpen(run) || run.idleAtWait === true || run.marksAt === undefined) continue;
    if ((run.lastAgentAt ?? 0) < worker.started && run.marksAt - worker.started >= NOT_MOVING_MS) {
      lines.once(`no_first_call:${worker.id}`, {
        problem: "no_first_call",
        runId: run.runId,
        detail: `${worker.name} has not called the engine ${Math.floor((now - worker.started) / 1000)} s after its start; open it: kodel agent attach ${worker.id}`,
      });
    }
    const decision = run.marks?.decision;
    const lastWait = run.marks?.lastWait;
    if (
      decision !== undefined &&
      !decision.byAgent &&
      (lastWait === undefined || decision.seq > lastWait.seq) &&
      run.marks?.moved !== true &&
      decision.ts >= worker.started &&
      run.marksAt - decision.ts >= NOT_MOVING_MS
    ) {
      lines.once(`not_moving:${run.runId}:${decision.seq}`, {
        problem: "not_moving",
        runId: run.runId,
        detail: `${worker.name} has not gone on since your decision (${Math.floor((now - decision.ts) / 1000)} s); nothing is typed for you, open it: kodel agent attach ${worker.id}`,
      });
    }
  }

  // The run is over and its worker's terminal session still runs: one is ended a cycle (a stop may
  // take seconds under the start lock, and a start that waits for the lock must be served).
  const finishes: ServeAction[] = runs
    .filter(
      (r): r is ServeRunView & { worker: ServeWorkerView } =>
        !isOpen(r) && r.worker !== undefined && isLive(r.worker) && r.worker.terminal === true,
    )
    .sort((x, y) => x.runId.localeCompare(y.runId))
    .slice(0, 1)
    .map((r) => ({ kind: "finish", runId: r.runId, worker: r.worker.name, id: r.worker.id }));

  const before = servePlaces(runs, input.unreadable);
  // More agents work than the limit: a person's decisions woke workers that waited, a person started
  // one by hand, or the limit was lowered. The line names no cause, since the plan cannot tell which.
  // Nothing is done against them; nothing is started or resumed while the count is over (the checks below).
  const over = before.workers - rules.max_workers;
  if (over > 0) {
    lines.once("over_limit", {
      problem: "over_limit",
      detail: `${before.workers} agents work, over the limit of ${rules.max_workers} by ${over}; nothing is started or resumed until an agent reaches a wait or ends`,
    });
  } else {
    lines.forget("over_limit");
  }
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
  resumable.sort((a, b) => a.ts - b.ts || a.seq - b.seq || a.run.runId.localeCompare(b.run.runId));
  const resumes: ServeAction[] = [];
  const waitingResumes: string[] = [...retrying];
  for (const r of resumable) {
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
    const candidates = input.tasks.list
      .flatMap((task, order) => {
        const rule = ruleFor(task, rules.start);
        return rule !== undefined &&
          admitStart({ task, runs, approval: rule.match.approval }).ok === true
          ? [{ task, order, rule }]
          : [];
      })
      .sort(
        (a, b) =>
          priorityRank(priorities, a.task.priority) - priorityRank(priorities, b.task.priority) ||
          a.order - b.order,
      );
    const queued: string[] = [];
    for (const { task, rule } of candidates) {
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
      if (attempt !== undefined && now - attempt.last_at < START_RETRY_MS) {
        waitingStarts.push(task.key);
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
    actions: rules.enabled
      ? [...notes, ...finishes, ...resumes, ...giveUps, ...starts, ...lines.actions]
      : [],
    memory: rules.enabled ? memory : structuredClone(input.memory),
    counts: {
      workers: before.workers,
      alive:
        runs.filter((r) => isAlive(r.worker)).length +
        input.unreadable.filter((r) => isAlive(r.worker)).length,
      max_workers: rules.max_workers,
      runs: before.runs,
      max_runs: rules.max_runs,
    },
    stalled,
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
  };
}
