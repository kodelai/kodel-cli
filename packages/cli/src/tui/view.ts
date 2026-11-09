/** The screens as pure functions: a model and a size in, lines out; a key and a model in, a model out. */
import { TASK_LIMITS } from "@kodel-ai/pipeline-core";
import { plain } from "../plain";
import type { WorkerProgress, WorkerStatus } from "../worker-launcher";
import {
  bold,
  clip,
  cyan,
  dim,
  fit,
  green,
  inverse,
  red,
  stripAnsi,
  visibleLength,
  wrapText,
  yellow,
} from "./ansi";
import {
  beginFlow,
  type Flow,
  flowBar,
  flowChecked,
  flowDecided,
  flowGone,
  flowKey,
  flowYieldsQuit,
} from "./decision-flow";
import { firstCode, moveCode, moveHunk, type Prepared, placeOf, prepare } from "./diffview";
import type { InputEvent } from "./input";
import { renderLabel, rowLabels, sessionLine } from "./label";
import type { Loaded } from "./load";
import { boxOf, hardWrap, innerWidth, type Modal, modalOf, modalOverlay } from "./modal";
import {
  emptyPipes,
  entryOf,
  initialPipeState,
  type PipeEntry,
  type PipeState,
  pendingCount,
  pipeCard,
  pipeHead,
  pipeHints,
  pipeKey,
  pipeList,
  sortEntries,
  withEntries,
} from "./pipelines";
import {
  type CheckResult,
  type Comment,
  type DecisionOutcome,
  type DecisionRef,
  type DiffState,
  decisionKey,
  formatAge,
  type GateDetail,
  NEED_KEYS,
  NEED_TAG,
  type Session,
  type StepState,
  sortSessions,
} from "./session";
import {
  emptyReport,
  headHeight,
  initialRepState,
  legendLines,
  type RepState,
  repCard,
  repHints,
  repKey,
  repList,
  repNames,
  type StatsSlot,
  withNames,
} from "./stats";
import {
  activityBlock,
  CODE,
  COMMENTS,
  commentPlace,
  diffKey,
  fileAt,
  headerBand,
  isListTab,
  itemCount,
  LOG,
  REPORT,
  STEPS,
  SUBTABS,
  skeletonBand,
  skeletonStrip,
  startCursor,
  type TabState,
  tabContent,
  tabStrip,
  tabsOf,
  visibleTabs,
  type WorkerLog,
} from "./tabs";
import {
  backlogBlock,
  backlogOf,
  type CardView,
  initialTasks,
  orderedRows,
  type Picked,
  type RowId,
  scrolled,
  scrollTo,
  type TasksState,
  taskCardView,
  taskListLines,
  tasksNotice,
  withTaskCard,
  withTasksLoad,
} from "./tasks";
import type { CardSlot, NewTaskInput, TaskRow, TasksLoad } from "./tasks-load";
import { type ResumeOffer, resumeOffer } from "./worker-resume";

export const SECTIONS = ["Sessions", "Pipeline", "Tasks", "Report"] as const;

export interface Model {
  section: number;
  sessions: Session[];
  /** Pipelines the agent proposed outside a run; they wait on the Pipeline screen. */
  proposals: number;
  /** What the Pipeline screen shows, and where it is. */
  pipelines: PipeEntry[];
  pipe: PipeState;
  /** The Tasks screen and the Backlog block: what was read, and where the Tasks screen is. */
  tasks: TasksState;
  /** What the Sessions selection is on: the run `selected` names, or a task of the Backlog. */
  pick: Picked;
  /** The Report screen: where it is, and what has been read for it, by pipeline. */
  rep: RepState;
  stats: Record<string, StatsSlot>;
  /** The legend of the Report is open, scrolled this many lines; null when it is closed. */
  legend: number | null;
  /** Id of the selected session, so the selection follows it when the list reorders. */
  selected: string;
  /** On a narrow terminal the list and the card take turns. */
  focus: "list" | "card";
  confirm: "a" | "r" | "d" | null;
  /** A decision at a gate or a pause being made for real (project mode); see `decision-flow.ts`. */
  flow: Flow | null;
  flowSeq: number;
  /** Which decision of a run is picked, by run id; a run that has none picked uses its first. */
  picked: Record<string, string>;
  notice: string;
  quit: boolean;
  /** `demo`: sample data, and a decision only moves a sample around. `project`: nothing can be decided here yet. */
  source: "demo" | "project";
  /** Counts the animation steps; the spinner and the blink read it. */
  frame: number;
  now: number;
  /** Whether the terminal is told to send mouse events; off lets the person select text as usual. */
  mouse: boolean;
  /** What the card of a run at a human step shows, by `detailKey`; filled in as it is read. */
  details: Record<string, GateDetail>;
  /** How many lines of the card are scrolled off the top. */
  cardScroll: number;
  /** Which tab of the card is shown, which line of its list is on, and whether that line is open. */
  tab: number;
  cursor: number;
  open: boolean;
  /** The list is put away and the card has the whole width. */
  zoom: boolean;
  /** Which part of an opened step is shown. */
  sub: number;
  /** The Report shows the instructions the pipeline gives the agent for its message. */
  instructions: boolean;
  /** The row of the opened file's diff the cursor is on; -1 until it has been read. */
  line: number;
  /** A comment being typed, or nothing. */
  input: Input | null;
  /** A comment on a task being typed, or nothing. It is the one thing this screen writes to a task. */
  taskInput: TaskInput | null;
  /** Set by a jump from a task card into a run: where Esc in Sessions goes back to. */
  back: Back | undefined;
  /** The diffs read so far, by `diffKey`. */
  diffs: Record<string, DiffState>;
  /** The background agents of the runs, by run id, as the records were last read (`worker-launcher.ts`). */
  workers: Record<string, WorkerView>;
  /** What the card of each run with a worker says, and whether `s` resumes it (`worker-resume.ts`); written by the loop's reads only. */
  offers: Record<string, ResumeOffer>;
  /** The TUI's own decision work is running a step: no resume is offered meanwhile. */
  workPending: boolean;
  /** Tasks whose start is in flight (the run and the agent are being made). */
  starting: Record<string, true>;
  /** Runs whose agent was just started and not yet read: the row says `agent starting`. */
  workerStarting: Record<string, true>;
  /** Runs whose agent is being resumed, with the decision's seq: the row says `agent resuming` until the record is read. */
  resuming: Record<string, number>;
  /** The question `s` asks on a task, or nothing. */
  start: StartQuestion | null;
  /** The question `s` asks on a run whose agent exited at a decision, or nothing. */
  resume: ResumeQuestion | null;
  /** Numbers the start questions, so a late answer of the loop is dropped. */
  startSeq: number;
  /** The form of a new task (`n`), or nothing. It is the other thing the task screens write. */
  taskForm: TaskForm | null;
  /** Numbers the forms, so a late answer of the loop is dropped. */
  formSeq: number;
  /** Things the screen cannot do by itself (write a comment, read a diff); the loop does them. */
  effects: Effect[];
}

/** What the card shows of the worker of a run: its latest record, and the digest read for it. */
export interface WorkerView extends WorkerStatus {
  lines: string[];
}

/** The question `s` asks on a task: `Checking…` until the loop answers, then the pipelines to pick from. */
export interface StartQuestion {
  key: string;
  seq: number;
  /** The pipelines that load, once the loop answered; one is asked with `y`, several with a digit. */
  pipelines?: string[];
  /** The model's clock when the question appeared: `y` is ignored for `COMMENT_GUARD_MS` after it. */
  askedAt?: number;
}

/** The question `s` asks on a run: resume the agent after the decision at journal line `seq`? */
export interface ResumeQuestion {
  runId: string;
  seq: number;
  askedAt: number;
}

/** How many pipelines the picker offers; a project with more is told so. */
export const PICKER_MAX = 9;

/** The fields of the form of a new task, in the order the cursor walks them. */
export const FORM_FIELDS = ["title", "body", "priority", "parent"] as const;
export type FormField = (typeof FORM_FIELDS)[number];
/** The priorities the form offers (the `local` adapter's names); the first entry leaves the tracker's default. */
export const FORM_PRIORITIES = [undefined, "high", "normal", "low"] as const;

/**
 * A new task being filled in. `openedAt` and `confirmAt` (the model's clock when the form opened and when the
 * question "create it?" appeared) are what the time guards measure from; `confirmAt` is set only while the
 * question is up. The status is not a field: `TaskService.create` has none, a new task starts in the tracker's
 * first status (`todo`).
 */
export interface TaskForm {
  seq: number;
  title: string;
  body: string;
  /** An index into `FORM_PRIORITIES`. */
  priority: number;
  parent: string;
  field: FormField;
  openedAt: number;
  confirmAt?: number;
  /**
   * The loop is creating it: the fields are read-only until the answer. Esc closes the window without taking
   * the creation back (the answer is then only reported), `q` quits as elsewhere.
   */
  writing: boolean;
}

/** The card a jump into a run came from: the Tasks screen (2) or the Backlog in Sessions (0), the task it was on, what was opened from it. */
export interface Back {
  section: 0 | 2;
  key: string;
  drill: string[];
}

/**
 * A comment on a task being typed. `openedAt` and `confirmAt` (the model's clock when the input opened and when the
 * question "save it?" appeared) are what the time guards measure from; `confirmAt` is set only while the question is up.
 */
export interface TaskInput {
  key: string;
  text: string;
  openedAt: number;
  confirmAt?: number;
}

export interface Input {
  text: string;
  severity: string;
  /** The file or the step the comment is about. */
  place: string;
  /** The model's clock when the input opened: Enter is ignored for `COMMENT_GUARD_MS` after it. */
  openedAt: number;
}

export type Effect =
  | { type: "add_comment"; runId: string; node: string; attempt: number; comment: Comment }
  | { type: "delete_comment"; runId: string; node: string; attempt: number; index: number }
  | { type: "load_diff"; runId: string; path: string }
  | { type: "load_stats"; pipeline: string }
  | {
      type: "check_decision";
      flow: number;
      runId: string;
      ref: DecisionRef;
      decision: "approve" | "reject" | "resume";
      reason?: string;
    }
  | {
      type: "decide";
      flow: number;
      runId: string;
      ref: DecisionRef;
      decision: "approve" | "reject" | "resume";
      reason?: string;
    }
  | { type: "load_task"; key: string }
  | { type: "add_task_comment"; key: string; text: string }
  /** The person confirmed the form of a new task. A person's act, never an agent's. */
  | { type: "create_task"; seq: number; input: NewTaskInput }
  /** `s` on a task: the loop runs the preflight and lists the pipelines, then answers with `withStartReady`. */
  | { type: "prepare_start"; key: string; seq: number }
  /** The person confirmed: a run for the task and a background agent for the run. A person's act, never an agent's. */
  | { type: "start_task"; key: string; pipeline: string; seq: number }
  /** The person confirmed: the agent of the run goes on after their decision at journal line `seq`. */
  | { type: "resume_worker"; runId: string; seq: number };

/**
 * A run's gate detail is good for the wait it was read for: a new wait is a new key. With several
 * gates waiting, each has its own card, so the picked one's node and attempt are part of the key.
 */
export function detailKey(s: Session, pick?: DecisionRef): string {
  const base = `${s.id}:${s.since}`;
  return pick ? `${base}:${pick.node}:${pick.attempt ?? 0}` : base;
}

/** The decision of a run that `a`, `r` and `c` act on: the one picked, or the first. */
export function pickedDecision(m: Pick<Model, "picked">, s: Session): DecisionRef | undefined {
  const all = s.decisions ?? [];
  const key = m.picked[s.id];
  return all.find((d) => decisionKey(d) === key) ?? all[0];
}

/**
 * What `a` and `r` mean here. On sample data, or for a session that carries no decisions (older
 * callers), what the need says; in a project, what the picked decision says.
 */
function keysOf(m: Model, s: Session | undefined): { a?: string; r?: string } {
  if (!s?.need) return {};
  if (m.source !== "project" || s.decisions === undefined) return NEED_KEYS[s.need];
  const d = pickedDecision(m, s);
  if (!d) return {};
  return d.kind === "gate" ? { a: "approve", r: "reject" } : { a: "resume" };
}

/** Moves the pick of the selected run by one among its decisions, wrapping round. */
function movePick(m: Model, by: 1 | -1): Model {
  const s = selectedSession(m);
  const all = s?.decisions ?? [];
  if (!s || all.length < 2) return m;
  const current = pickedDecision(m, s);
  const at = Math.max(0, current ? all.indexOf(current) : 0);
  const next = all[(at + by + all.length) % all.length];
  if (!next) return m;
  return {
    ...m,
    picked: { ...m.picked, [s.id]: decisionKey(next) },
    notice: "",
    cardScroll: 0,
    tab: 0,
    cursor: 0,
    open: false,
    sub: 0,
  };
}

/** The checks for a decision have answered. */
export function withCheck(m: Model, flow: number, result: CheckResult): Model {
  return flowChecked(m, flow, result);
}

/** The write for a decision has been made, or refused. */
export function withDecided(m: Model, flow: number, outcome: DecisionOutcome): Model {
  return flowDecided(m, flow, outcome);
}

export interface Size {
  cols: number;
  rows: number;
}

/** Below this the list and the card no longer fit side by side. */
export const WIDE_COLS = 96;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Frames per blink phase: a frame is 100 ms, so the agent's dot changes twice a second. */
const BLINK_FRAMES = 5;

const GROUPS: { title: string; of: (s: Session) => boolean; label: string; ago: boolean }[] = [
  { title: "WAITING FOR YOU", of: (s) => s.status === "waiting", label: "waiting for", ago: false },
  { title: "RUNNING", of: (s) => s.status === "running", label: "running for", ago: false },
  {
    title: "FINISHED",
    of: (s) => s.status === "failed" || s.status === "done" || s.status === "canceled",
    label: "",
    ago: true,
  },
  { title: "UNREADABLE", of: (s) => s.status === "unreadable", label: "", ago: true },
];

export function ordered(sessions: Session[]): Session[] {
  return sortSessions(sessions);
}

export function initialModel(
  loaded: Loaded,
  source: Model["source"] = "demo",
  now: number = Date.now(),
  mouse = false,
): Model {
  return {
    section: 0,
    sessions: ordered(loaded.sessions),
    proposals: loaded.proposals,
    pipelines: sortEntries(loaded.pipelines ?? []),
    pipe: initialPipeState(sortEntries(loaded.pipelines ?? [])),
    rep: initialRepState(repNames(sortEntries(loaded.pipelines ?? []))),
    tasks: initialTasks(),
    pick: { kind: "run" },
    stats: {},
    legend: null,
    selected: ordered(loaded.sessions)[0]?.id ?? "",
    focus: "list",
    confirm: null,
    flow: null,
    flowSeq: 0,
    picked: {},
    notice: "",
    quit: false,
    source,
    frame: 0,
    now,
    mouse,
    details: {},
    cardScroll: 0,
    tab: 0,
    cursor: 0,
    open: false,
    zoom: false,
    sub: 0,
    instructions: false,
    line: -1,
    input: null,
    taskInput: null,
    back: undefined,
    diffs: {},
    workers: {},
    offers: {},
    workPending: false,
    starting: {},
    workerStarting: {},
    resuming: {},
    start: null,
    resume: null,
    startSeq: 0,
    taskForm: null,
    formSeq: 0,
    effects: [],
  };
}

export function withDetail(m: Model, key: string, detail: GateDetail): Model {
  const next = { ...m, details: { ...m.details, [key]: detail } };
  // A run that is going on changes under the person's eyes, so what was read of its files may be out
  // of date: a read that failed is forgotten, and the file that is open is read again (what was shown
  // stays until the new text arrives).
  const runId = key.slice(0, key.indexOf(":"));
  if (m.sessions.find((s) => s.id === runId)?.status !== "running") return next;
  const mine = `${runId}:`;
  const diffs = Object.fromEntries(
    Object.entries(m.diffs).filter(([k, d]) => !k.startsWith(mine) || d.kind === "text"),
  );
  const found = detailOf({ ...next, diffs });
  if (next.tab !== CODE || !next.open || found?.s.id !== runId) return { ...next, diffs };
  const path = fileAt(found.d, Math.min(next.cursor, itemCount(found.d, CODE) - 1));
  if (path === undefined) return { ...next, diffs };
  return { ...next, diffs, effects: [...next.effects, { type: "load_diff", runId, path }] };
}

export function withDiff(m: Model, key: string, diff: DiffState): Model {
  return { ...m, diffs: { ...m.diffs, [key]: diff } };
}

/** The things waiting to be done, and the model without them. */
export function takeEffects(m: Model): [Model, Effect[]] {
  return m.effects.length === 0 ? [m, []] : [{ ...m, effects: [] }, m.effects];
}

/** New data from disk: the selection stays on the same session when it is still there. */
export function withData(m: Model, loaded: Loaded, now: number): Model {
  const sessions = ordered(loaded.sessions);
  const selected = sessions.some((s) => s.id === m.selected) ? m.selected : (sessions[0]?.id ?? "");
  const confirm = sessions.some((s) => s.id === m.selected && s.need !== undefined)
    ? m.confirm
    : null;
  const pipelines = sortEntries(loaded.pipelines ?? []);
  // A pick that is no longer among the decisions of its run (decided elsewhere) is forgotten; the run
  // then shows its first decision, and a person who had picked is told.
  const picked = { ...m.picked };
  let moved = false;
  for (const s of sessions) {
    const key = picked[s.id];
    if (key === undefined) continue;
    if (!(s.decisions ?? []).some((d) => decisionKey(d) === key)) {
      delete picked[s.id];
      moved = moved || s.id === m.selected;
    }
  }
  const next: Model = questionsKept(
    withOffers(
      settled(
        reconciled({
          ...m,
          sessions,
          proposals: loaded.proposals,
          pipelines,
          pipe: withEntries(m.pipe, pipelines),
          rep: withNames(m.rep, repNames(pipelines)),
          selected,
          confirm,
          picked,
          now,
        }),
      ),
    ),
  );
  const dropped = flowGone(next, sessions);
  // A comment being typed, or a deletion being asked, is about the card that was on the screen: when
  // that card is another one now (its decision went, a new wait began), it is cancelled, not moved
  // to a card the person did not mean.
  const cardBefore = cardIdentity(m);
  const cardAfter = cardIdentity(dropped);
  if (cardBefore !== cardAfter && (dropped.input !== null || dropped.confirm === "d")) {
    return {
      ...dropped,
      input: null,
      confirm: dropped.confirm === "d" ? null : dropped.confirm,
      notice: "The card changed under the comment; it was cancelled.",
    };
  }
  // The notice of what was just written is not taken over by this one.
  return moved && m.notice === "" && dropped.notice === m.notice
    ? {
        ...dropped,
        notice: "The decision you had picked is gone (decided elsewhere); showing the first one.",
      }
    : dropped;
}

/** Which card the selected run shows (its wait and its picked gate), or nothing. */
function cardIdentity(m: Model): string | undefined {
  const s = selectedSession(m);
  return s ? detailKey(s, pickedDecision(m, s)) : undefined;
}

/** An answer of the tasks reader. The runs are not read with it: a slow tracker never holds them up. */
export function withTasks(m: Model, load: TasksLoad): Model {
  return questionsKept(settled(reconciled({ ...m, tasks: withTasksLoad(m.tasks, load) })));
}

// ── background agents ────────────────────────────────────────────────────────

/**
 * The card's line and the offer of every run with a worker, from what the loop last read. The loop
 * never writes an offer by itself: it is worked out here, from the records and the journal, and only a
 * key of the person acts on it.
 */
function withOffers(m: Model): Model {
  const offers: Record<string, ResumeOffer> = {};
  for (const s of m.sessions) {
    const worker = m.workers[s.id];
    if (worker === undefined) continue;
    offers[s.id] = resumeOffer(s, worker, m.workPending);
  }
  return { ...m, offers };
}

/**
 * A question that stood on the screen is about what was there: the start question goes when its task
 * is no longer the one on the card, the resume question when its offer is no longer there as it was.
 */
function questionsKept(m: Model): Model {
  let next = m;
  if (next.start !== null && shownTask(next) !== next.start.key) {
    next = { ...next, start: null, notice: "Cancelled: the card moved to another task." };
  }
  if (next.resume !== null) {
    const offer = next.offers[next.resume.runId]?.offer;
    if (offer === undefined || offer.seq !== next.resume.seq) {
      next = { ...next, resume: null, notice: "Cancelled: the run moved on." };
    }
  }
  return next;
}

/**
 * A read of the worker records. A run whose record is listed is no longer `agent starting`; a resume
 * whose record is listed is no longer `agent resuming`. The digest read for a run is kept.
 */
export function withWorkers(
  m: Model,
  statuses: ReadonlyMap<string, WorkerStatus>,
  pending: boolean,
): Model {
  const workers: Record<string, WorkerView> = {};
  for (const [runId, status] of statuses) {
    workers[runId] = { ...status, lines: m.workers[runId]?.lines ?? [] };
  }
  const workerStarting = Object.fromEntries(
    Object.entries(m.workerStarting).filter(([runId]) => !statuses.has(runId)),
  );
  const resuming = Object.fromEntries(
    Object.entries(m.resuming).filter(
      ([runId, seq]) => !(statuses.get(runId)?.resumed ?? []).includes(seq),
    ),
  );
  return questionsKept(
    withOffers({ ...m, workers, workPending: pending, workerStarting, resuming }),
  );
}

/** A read of the records that failed: every worker is `unknown` until the next read; the digests stay. */
export function withWorkersUnknown(m: Model): Model {
  const workers: Record<string, WorkerView> = {};
  for (const [runId, w] of Object.entries(m.workers)) {
    workers[runId] = { ...w, state: "unknown", label: "unknown (cannot be read)" };
  }
  return questionsKept(withOffers({ ...m, workers }));
}

/** The digest of the selected run's worker. The session id the tail names wins over the records' argv. */
export function withProgress(m: Model, runId: string, progress: WorkerProgress): Model {
  const w = m.workers[runId];
  if (w === undefined) return m;
  const view: WorkerView = {
    ...w,
    lines: progress.lines,
    ...(progress.sessionId === undefined ? {} : { sessionId: progress.sessionId }),
  };
  return questionsKept(withOffers({ ...m, workers: { ...m.workers, [runId]: view } }));
}

/** The loop answered a `prepare_start`: the pipelines that load. A late answer, or one for another task, is dropped. */
export function withStartReady(m: Model, seq: number, key: string, pipelines: string[]): Model {
  if (m.start === null || m.start.seq !== seq || m.start.key !== key) return m;
  return { ...m, start: { ...m.start, pipelines, askedAt: m.now }, notice: "" };
}

/** The loop refused a `prepare_start` (the preflight): one notice, no question. */
export function withStartRefused(m: Model, seq: number, key: string, message: string): Model {
  if (m.start === null || m.start.seq !== seq || m.start.key !== key) return m;
  return { ...m, start: null, notice: message };
}

/** A `start_task` is done, well or not: the notice, and the row of the new run reads `agent starting` until the records are read. */
export function withStarted(
  m: Model,
  key: string,
  outcome: { ok: boolean; message: string; runId?: string },
): Model {
  const { [key]: _done, ...starting } = m.starting;
  const workerStarting =
    outcome.ok && outcome.runId !== undefined
      ? { ...m.workerStarting, [outcome.runId]: true as const }
      : m.workerStarting;
  return { ...m, starting, workerStarting, notice: outcome.message };
}

/** A `resume_worker` is done: a failure gives the row back its offer; a success keeps `agent resuming` until the record is read. */
export function withResumed(
  m: Model,
  runId: string,
  outcome: { ok: boolean; message: string },
): Model {
  if (outcome.ok) return { ...m, notice: outcome.message };
  const { [runId]: _done, ...resuming } = m.resuming;
  return { ...m, resuming, notice: outcome.message };
}

/** The state and status of a task as the screen knows them: from its card when read, else from the lists. */
function taskStateOf(m: Model, key: string): Pick<TaskRow, "state" | "status"> | undefined {
  const card = m.tasks.cards[key];
  if (card?.status === "ready") return { state: card.card.state, status: card.card.status };
  const load = m.tasks.load?.status === "ready" ? m.tasks.load : undefined;
  const row = [...(load?.rows ?? []), ...(load?.todo ?? [])].find((r) => r.key === key);
  return row === undefined ? undefined : { state: row.state, status: row.status };
}

/** The words of a run for the notice that says a task is already started. */
function runWordOf(m: Model, s: Session): string {
  const line = workerLine(m, s);
  return line ?? (s.status === "waiting" ? "waiting for you" : s.status);
}

/** `s` on a task: the question, or why it does nothing. */
function askStart(m: Model, key: string): Model {
  if (m.starting[key] !== undefined) return { ...m, notice: `${key} is being started.` };
  const active = m.sessions.find(
    (s) => s.taskKey === key && (s.status === "running" || s.status === "waiting"),
  );
  if (active) {
    return {
      ...m,
      notice: `${key} is already started: run ${active.id} (${runWordOf(m, active)}).`,
    };
  }
  const info = taskStateOf(m, key);
  if (info === undefined) {
    return { ...m, notice: `${key} cannot be started yet: the task is still being read.` };
  }
  if (info.state === "done") {
    return {
      ...m,
      notice:
        info.status === "declined"
          ? `${key} is declined: nothing to start.`
          : `${key} is done: nothing to start.`,
    };
  }
  const seq = m.startSeq + 1;
  return {
    ...m,
    startSeq: seq,
    start: { key, seq },
    notice: "",
    effects: [...m.effects, { type: "prepare_start", key, seq }],
  };
}

/** `s` on a run: the resume question when the card offers it, else why not. */
function askResume(m: Model, s: Session): Model {
  if (m.resuming[s.id] !== undefined) return { ...m, notice: `${s.id} is being resumed.` };
  const found = m.offers[s.id];
  if (found === undefined) {
    return { ...m, notice: "Nothing to resume: no agent of the TUI on this run." };
  }
  if (found.offer === undefined) return { ...m, notice: `Nothing to resume: ${found.why}.` };
  return { ...m, resume: { runId: s.id, seq: found.offer.seq, askedAt: m.now }, notice: "" };
}

/** The `s` key: a start on a task, a resume on a run; nothing on sample data. */
function startKey(m: Model): Model {
  if (m.section !== 0) return m;
  if (m.source === "demo") return { ...m, notice: "starting is not available in --demo" };
  if (m.pick.kind === "task") return askStart(m, shownTask(m) ?? m.pick.key);
  const s = selectedSession(m);
  return s === undefined ? m : askResume(m, s);
}

const MAKE_TALLER = "make the terminal taller";

/**
 * A key while the start question is up. `y` (one pipeline) or a digit (several) starts, only alone in its
 * chunk and `COMMENT_GUARD_MS` after the question appeared; `0`, a digit out of range and every other key
 * cancel, and so does any key while the loop is still checking. Nothing is answered that cannot be seen: on
 * a terminal too small to draw the window the answer is not taken, and a digit whose row the window does not
 * show (or `y` under a question that is not whole on the screen) is refused and the window stays. What is
 * shown is read off the very layout the screen draws (`startWindowOf`), so the two cannot disagree.
 */
function startQuestionKey(m: Model, key: string, alone: boolean, size: Size): Model {
  const q = m.start;
  if (q === null) return m;
  const cancelled: Model = { ...m, start: null, notice: "Cancelled." };
  if (q.pipelines === undefined) return cancelled;
  const offered = q.pipelines.slice(0, PICKER_MAX);
  const chosen =
    offered.length === 1
      ? key === "y"
        ? offered[0]
        : undefined
      : /^[1-9]$/.test(key)
        ? offered[Number(key) - 1]
        : undefined;
  if (chosen === undefined || !alone) return cancelled;
  if (tooSmall(size)) return m;
  const window = startWindowOf(m, q, size.cols, size.rows - 3);
  if (offered.length === 1) {
    if (window.modal.maxScroll > 0) {
      return { ...m, notice: `The question is not all visible: ${MAKE_TALLER}.` };
    }
  } else if (Number(key) > window.shown) {
    return { ...m, notice: `Pipeline ${key} is not visible: ${MAKE_TALLER}.` };
  }
  if (m.now - (q.askedAt ?? m.now) < COMMENT_GUARD_MS) return { ...m, notice: WAIT_FOR_Y };
  return {
    ...m,
    start: null,
    starting: { ...m.starting, [q.key]: true },
    notice: `Starting ${q.key}…`,
    effects: [...m.effects, { type: "start_task", key: q.key, pipeline: chosen, seq: q.seq }],
  };
}

/**
 * A key while the resume question is up: `y` alone, after the guard, resumes; any other key cancels. The
 * question and its warning must be whole on the screen for `y` to count (the same rule as the start window).
 */
function resumeQuestionKey(m: Model, key: string, alone: boolean, size: Size): Model {
  const q = m.resume;
  if (q === null) return m;
  if (key !== "y" || !alone) return { ...m, resume: null, notice: "Cancelled." };
  if (tooSmall(size)) return m;
  if (resumeModalOf(m, q, size.cols, size.rows - 3).maxScroll > 0) {
    return { ...m, notice: `The question is not all visible: ${MAKE_TALLER}.` };
  }
  if (m.now - q.askedAt < COMMENT_GUARD_MS) return { ...m, notice: WAIT_FOR_Y };
  return {
    ...m,
    resume: null,
    resuming: { ...m.resuming, [q.runId]: q.seq },
    notice: `Resuming the agent of ${q.runId}…`,
    effects: [...m.effects, { type: "resume_worker", runId: q.runId, seq: q.seq }],
  };
}

/** The card's words for the worker of a run, or nothing for a run without one. */
export function workerLine(m: Model, s: Session): string | undefined {
  if (m.workerStarting[s.id] !== undefined) return "agent starting";
  if (m.resuming[s.id] !== undefined) return "agent resuming";
  const offer = m.offers[s.id];
  if (offer === undefined || offer.line === "") return undefined;
  return offer.line;
}

const WORKER_MARK = "◆";

/** The short form of the worker's state for the row's tag column. */
function workerTag(m: Model, s: Session): string | undefined {
  if (m.workerStarting[s.id] !== undefined) return `${WORKER_MARK} starting`;
  if (m.resuming[s.id] !== undefined) return `${WORKER_MARK} resuming`;
  const w = m.workers[s.id];
  if (w === undefined) return undefined;
  const offer = m.offers[s.id];
  if (offer?.offer !== undefined) return `${WORKER_MARK} s resumes`;
  if (offer?.line === "agent waiting for you") return `${WORKER_MARK} for you`;
  if (w.state === "killed")
    return `${WORKER_MARK} ${w.label.startsWith("stopped") ? "stopped" : "killed"}`;
  return `${WORKER_MARK} ${w.state}`;
}

function workerStyle(m: Model, s: Session, line: string): string {
  if (m.offers[s.id]?.offer !== undefined) return bold(green(line));
  if (line === "agent waiting for you") return yellow(line);
  if (
    line.startsWith("agent starting") ||
    line.startsWith("agent running") ||
    line === "agent resuming"
  ) {
    return cyan(line);
  }
  if (line.startsWith("agent stopped")) return dim(line);
  return red(line);
}

/** The part of a run's worker the tabs read: its name and the digest of its latest record. */
function workerLogOf(m: Model, s: Session): WorkerLog | undefined {
  const w = m.workers[s.id];
  return w === undefined ? undefined : { name: w.name, resumes: w.resumes, lines: w.lines };
}

/**
 * The worker's state line and, for a run that is going on, the tail of what the agent does, in the lines the
 * Log tab shows (`activityBlock`), with the command for the whole log. A run that waits shows no log here: its
 * Report tab opens with the agent's answer, and the lines of the log are under Log.
 */
function workerBlock(m: Model, s: Session, width: number, d?: GateDetail, log = true): string[] {
  const w = workerLogOf(m, s);
  const line = workerLine(m, s);
  if (line === undefined && w === undefined) return [];
  const out: string[] = [];
  if (line !== undefined) out.push(workerStyle(m, s, line));
  if (w !== undefined && log && s.status === "running") out.push(...activityBlock(d, w, width));
  out.push("");
  return out.map((l) => fit(l, width));
}

/** What the Report tab says the keys do at this gate: the decision keys, or the command when there are none. */
function decisionWords(m: Model, s: Session): string {
  // A project whose sessions carry no decisions is decided with a command (as `a` says there).
  if (m.source === "project" && s.decisions === undefined) {
    return dim(`Decided with a command, not from here: $ ${s.command ?? "see the card"}`);
  }
  const keys = keysOf(m, s);
  const parts = [
    ...(keys.a ? [`${bold("a")} ${keys.a.charAt(0).toUpperCase()}${keys.a.slice(1)}`] : []),
    ...(keys.r ? [`${bold("r")} ${keys.r.charAt(0).toUpperCase()}${keys.r.slice(1)}`] : []),
  ];
  if (parts.length > 0) return parts.join(" · ");
  return s.command === undefined
    ? dim("Decided with a command, not from here.")
    : dim(`Decided with a command, not from here: $ ${s.command}`);
}

// ── the form of a new task ──────────────────────────────────────────────────

/** The title of a task as the screen knows it: from its card when read, else from the lists. */
function taskTitleOf(m: Model, key: string): string | undefined {
  const card = m.tasks.cards[key];
  if (card?.status === "ready") return card.card.title;
  const load = m.tasks.load?.status === "ready" ? m.tasks.load : undefined;
  return [...(load?.rows ?? []), ...(load?.todo ?? [])].find((r) => r.key === key)?.title;
}

/** `n`: the form of a new task, or why there is none. */
function newTaskKey(m: Model): Model {
  if (m.source === "demo") return { ...m, notice: "creating a task is not available in --demo" };
  const load = m.tasks.load;
  if (load?.status !== "ready") {
    const why =
      load === undefined
        ? "the tasks are still being read"
        : load.status === "off"
          ? "tasks are off (tasks.enabled)"
          : load.message;
    return { ...m, notice: `Cannot create a task: ${why}.` };
  }
  const seq = m.formSeq + 1;
  return {
    ...m,
    formSeq: seq,
    taskForm: {
      seq,
      title: "",
      body: "",
      priority: 0,
      parent: "",
      field: "title",
      openedAt: m.now,
      writing: false,
    },
    notice: "",
  };
}

const FIELD_MAX: Record<FormField, number> = {
  title: TASK_LIMITS.title,
  body: TASK_LIMITS.body,
  priority: 0,
  parent: TASK_LIMITS.keyInput,
};

/** The text of a text field of the form; the priority has none. */
function fieldText(f: TaskForm, field: FormField): string {
  return field === "title"
    ? f.title
    : field === "body"
      ? f.body
      : field === "parent"
        ? f.parent
        : "";
}

function withFieldText(f: TaskForm, field: FormField, text: string): TaskForm {
  return field === "title"
    ? { ...f, title: text }
    : field === "body"
      ? { ...f, body: text }
      : field === "parent"
        ? { ...f, parent: text }
        : f;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: this is what a body is cleaned of
const CONTROLS_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/** A body keeps its line breaks and loses every other control character; the title and the parent are one line. */
function cleanField(field: FormField, text: string): string {
  if (field === "body") return stripLoneSurrogates(text.replace(CONTROLS_BUT_NEWLINE, "")).trim();
  return cleanComment(text).trim();
}

/** What the form sends, as `TaskService.create` takes it: nothing empty, the priority only when one was chosen. */
export function formInput(f: TaskForm): NewTaskInput {
  const body = cleanField("body", f.body);
  const parent = cleanField("parent", f.parent);
  const priority = FORM_PRIORITIES[f.priority];
  return {
    title: cleanField("title", f.title),
    ...(body === "" ? {} : { body }),
    ...(priority === undefined ? {} : { priority }),
    ...(parent === "" ? {} : { parent }),
  };
}

const CREATE_GOES_ON = "Window closed; the task is still being created and you will be told.";

/**
 * The action of the form's `[Enter Create]` button. A click is not the Enter key: in the body Enter is a line
 * break, and a click on the button must ask "create it?" whatever field has the cursor. The keyboard never
 * sends this name (a key is one code point or a name in `input.ts`), so it reaches the form only from a click.
 */
const FORM_CREATE = "form-create";

/**
 * A key while the form of a new task is up. Tab and the arrows walk the fields; Enter in the body is a line
 * break, elsewhere it asks "create it?", only alone in its chunk and `COMMENT_GUARD_MS` after the form opened;
 * `y` on the question creates, under the same guard from the question's own time; any other key goes back to
 * the fields. A paste cannot do all of that: its line breaks arrive with other text, and the question needs a
 * second, later chunk that is exactly `y`. While the task is being created (a tracker may take long) the
 * fields are read-only, but the person is not held: Esc closes the window and `q` quits; the creation is not
 * taken back, its answer is reported when it comes (`withTaskCreated`).
 */
function typingForm(m: Model, key: string, alone: boolean, size: Size): Model {
  const f = m.taskForm;
  if (!f) return m;
  if (f.writing) {
    if (key === "escape") return { ...m, taskForm: null, notice: CREATE_GOES_ON };
    if (key === "q") return { ...m, quit: true };
    return m;
  }
  if (key === "escape") return { ...m, taskForm: null, notice: "Cancelled." };
  if (f.confirmAt !== undefined) {
    // Only a lowercase `y` creates, as the window says; `Y` edits like any other key.
    if (key === "y" && alone) {
      if (tooSmall(size)) return m;
      if (m.now - f.confirmAt < COMMENT_GUARD_MS) return { ...m, notice: WAIT_FOR_Y };
      const effect: Effect = { type: "create_task", seq: f.seq, input: formInput(f) };
      return {
        ...m,
        taskForm: { ...f, writing: true },
        notice: "",
        effects: [...m.effects, effect],
      };
    }
    const { confirmAt: _asked, ...back } = f;
    return { ...m, taskForm: back, notice: "" };
  }
  const at = FORM_FIELDS.indexOf(f.field);
  const move = (by: number): Model => {
    const field = FORM_FIELDS[(at + by + FORM_FIELDS.length) % FORM_FIELDS.length] ?? "title";
    return { ...m, taskForm: { ...f, field }, notice: "" };
  };
  const cycle = (by: number): Model => ({
    ...m,
    taskForm: {
      ...f,
      priority: (f.priority + by + FORM_PRIORITIES.length) % FORM_PRIORITIES.length,
    },
    notice: "",
  });
  const text = fieldText(f, f.field);
  const room = FIELD_MAX[f.field] - text.length;
  const askToCreate = (): Model => {
    // Enter with other bytes in its chunk is a burst, not a press: it is not taken, and the person is told.
    if (!alone || m.now - f.openedAt < COMMENT_GUARD_MS) return { ...m, notice: WAIT_FOR_ENTER };
    // Blank means blank to a reader: the service refuses a title with nothing visible in it.
    if (isBlank(f.title)) {
      return { ...m, taskForm: { ...f, field: "title" }, notice: "A task needs a title." };
    }
    return { ...m, taskForm: { ...f, confirmAt: m.now }, notice: "" };
  };
  switch (key) {
    case "tab":
    case "down":
      return move(1);
    case "shift-tab":
    case "up":
      return move(-1);
    case "left":
      return f.field === "priority" ? cycle(-1) : m;
    case "right":
      return f.field === "priority" ? cycle(1) : m;
    case "enter":
      if (f.field === "body") {
        return room >= 1 ? { ...m, taskForm: { ...f, body: `${f.body}\n` }, notice: "" } : m;
      }
      return askToCreate();
    case FORM_CREATE:
      return askToCreate();
    case "backspace":
      if (f.field === "priority") return m;
      return {
        ...m,
        taskForm: withFieldText(f, f.field, [...text].slice(0, -1).join("")),
        notice: "",
      };
    default:
      if (f.field === "priority") return key === " " ? cycle(1) : m;
      // One printable character is text; the names of other keys (up, enter, ...) are longer.
      return [...key].length === 1 && !CONTROL_OR_LONE.test(key) && key.length <= room
        ? { ...m, taskForm: withFieldText(f, f.field, text + key), notice: "" }
        : m;
  }
}

/**
 * The loop answered a `create_task`: the form closes on a success; a failure keeps the fields for a retry.
 * When the form it was sent from is gone (closed with Esc while the task was being created, or replaced by
 * a later one), the answer is only told: the task was made, or not, all the same.
 */
export function withTaskCreated(
  m: Model,
  seq: number,
  outcome: { ok: boolean; message: string; key?: string },
): Model {
  const f = m.taskForm;
  if (f === null || f.seq !== seq) return { ...m, notice: outcome.message };
  if (outcome.ok) return { ...m, taskForm: null, notice: outcome.message };
  const { confirmAt: _asked, ...back } = f;
  return { ...m, taskForm: { ...back, writing: false }, notice: outcome.message };
}

/**
 * The lines of the form for a box `inner` columns wide, with the cursor on the field that has it; `anchor` is
 * the line the window keeps in view: the cursor's while typing, the question's once it is asked.
 */
function formContent(f: TaskForm, inner: number): { lines: string[]; anchor: number } {
  if (f.writing) {
    return {
      lines: [
        "Creating the task…",
        "",
        dim("Esc closes this window; you will be told when it is made"),
      ],
      anchor: 0,
    };
  }
  const typing = f.confirmAt === undefined;
  const mark = (field: FormField) => (f.field === field ? cyan("▸") : " ");
  const cursor = (field: FormField) => (typing && f.field === field ? "▏" : "");
  const label = (field: FormField, text: string) => `${mark(field)} ${bold(text.padEnd(9))}`;
  const room = Math.max(10, inner - 12);
  const indent = " ".repeat(12);
  const wrapped = (text: string) =>
    hardWrap(text, room).map((l, i) => (i === 0 ? l : `${indent}${l}`));
  const out: string[] = [];
  let anchor = 0;
  const field = (name: FormField, lines: string[]) => {
    out.push(...lines);
    if (f.field === name) anchor = out.length - 1;
  };
  // What was typed (or pasted) is shown as plain text: no mark in it reorders or hides what the person reads.
  field("title", wrapped(`${label("title", "Title")}${plain(f.title)}${cursor("title")}`));
  const body = f.body.split("\n");
  for (const [i, line] of body.entries()) {
    const lead = i === 0 ? label("body", "Body") : indent;
    const tail = i === body.length - 1 ? cursor("body") : "";
    const empty = f.body === "" && !typing ? dim("(none)") : "";
    field("body", wrapped(`${lead}${plain(line)}${tail}${empty}`));
  }
  if (f.field === "body" && typing) out.push(`${indent}${dim("Enter is a new line here")}`);
  const priority = FORM_PRIORITIES[f.priority];
  const choice = priority === undefined ? dim("tracker's default") : priority;
  const arrows = f.field === "priority" && typing ? dim("  ← → change") : "";
  field("priority", [`${label("priority", "Priority")}${choice}${arrows}`]);
  const parentHint =
    f.parent === "" ? dim(typing ? "(optional: the key of the parent task)" : "(none)") : "";
  field(
    "parent",
    wrapped(`${label("parent", "Parent")}${plain(f.parent)}${cursor("parent")}${parentHint}`),
  );
  out.push(`  ${dim("Status    todo (a new task starts there)")}`);
  out.push("");
  out.push(
    typing
      ? dim("Tab/↓ next field · ↑ previous · Enter asks to create · Esc cancels")
      : `${bold("Create this task?")}  ${dim("y creates · any other key edits · Esc cancels")}`,
  );
  return { lines: out, anchor: typing ? anchor : out.length - 1 };
}

/** The box of the form. */
function formModalOf(f: TaskForm, cols: number, height: number): Modal {
  const buttons = f.writing
    ? [{ key: "escape", text: "[Esc Close]" }]
    : f.confirmAt === undefined
      ? [
          { key: FORM_CREATE, text: "[Enter Create]" },
          { key: "escape", text: "[Esc Cancel]" },
        ]
      : [
          { key: "y", text: "[y Create]" },
          { key: "escape", text: "[Esc Cancel]" },
        ];
  const { lines, anchor } = formContent(f, innerWidth(cols));
  // The arrows walk the fields here, so the window follows the field that has the cursor.
  return boxOf(
    { title: " New task ", content: lines, buttons, scroll: { anchor }, scrollable: false },
    cols,
    height,
  );
}

/** The bottom line while the form is up: a notice when there is one, else what the keys do. */
function formLine(f: TaskForm, notice = ""): string {
  if (notice !== "") return yellow(notice);
  if (f.writing) return `${dim("Creating the task…")}   ${bold("Esc")} close   ${bold("q")} quit`;
  if (f.confirmAt !== undefined) {
    return `${bold("y")} create   any other key edits   ${bold("Esc")} cancel`;
  }
  return `${bold("Tab/↓")} next   ${bold("↑")} previous   ${bold("Enter")} create   ${bold("Esc")} cancel`;
}

// ── the start and resume questions as windows ───────────────────────────────

const CANCEL_WORDS = "Esc or any other key cancels";

/**
 * The start window, and how many of the picker's pipeline rows it draws. `shown` counts rows of the picker
 * only: with one pipeline there is no picker (and `y`, not a digit, answers), so it is 0 there and says
 * nothing; with several, 0 means no row fits and no digit is offered.
 */
interface StartWindow {
  modal: Modal;
  shown: number;
}

/**
 * The box of the start question: `Checking…`, then the question with the task's name, or the picker. The
 * arrows cancel the question, so the window does not scroll; the keys are in its footer, always in view.
 * The window is kept short so that it fits where it can: the task's name is cut to one row, and the picker
 * has one row per pipeline (the rows right under the question, before the lines the answer does not need);
 * where it still does not fit, `shown` says how many rows are drawn, and the keys offer only those.
 */
function startWindowOf(m: Model, q: StartQuestion, cols: number, height: number): StartWindow {
  const inner = innerWidth(cols);
  const wrap = (text: string) => hardWrap(text, inner);
  const title = taskTitleOf(m, q.key);
  const named = clip(title === undefined ? q.key : `${q.key} · ${title}`, inner);
  if (q.pipelines === undefined) {
    const modal = boxOf(
      {
        title: ` Start «${q.key}» `,
        content: ["Checking…", dim(named)],
        buttons: [{ key: "escape", text: "[Esc Cancel]" }],
        scroll: 0,
        scrollable: false,
      },
      cols,
      height,
    );
    return { modal, shown: 0 };
  }
  const offered = q.pipelines.slice(0, PICKER_MAX);
  const content: string[] = [];
  const buttons: { key: string; text: string }[] = [];
  let keys: string;
  let firstRow = 0;
  if (offered.length === 1) {
    content.push(
      ...wrap(bold(`Start ${q.key} in a background agent (pipeline ${offered[0]})?`)),
      dim(named),
    );
    keys = `y start · ${CANCEL_WORDS}`;
    buttons.push({ key: "y", text: "[y Start]" });
  } else {
    const more = q.pipelines.length - offered.length;
    content.push(...wrap(bold(`Start ${q.key} in a background agent with:`)));
    firstRow = content.length;
    for (const [i, p] of offered.entries()) {
      content.push(`  ${bold(String(i + 1))} ${clip(p, inner - 4)}`);
      buttons.push({ key: String(i + 1), text: `[${i + 1} ${p}]` });
    }
    if (more > 0) content.push(dim(`  ${more} more are not offered here`));
    content.push(dim(named));
    keys = `${pickerDigits(offered.length)} choose a pipeline · ${CANCEL_WORDS}`;
  }
  buttons.push({ key: "escape", text: "[Esc Cancel]" });
  const box = (footer: string) =>
    boxOf(
      {
        title: ` Start «${q.key}» `,
        content,
        footer: ["", dim(footer)],
        buttons,
        scroll: 0,
        scrollable: false,
      },
      cols,
      height,
    );
  let modal = box(keys);
  const picker = offered.length > 1;
  // The window starts at the top of its content: row `i` is drawn when it is within the room.
  const shown = picker ? Math.max(0, Math.min(offered.length, modal.room - firstRow)) : 0;
  // The keys promise only the digits whose rows are drawn (none, when the question alone fills the room);
  // the footer keeps its height, so the room is the same.
  if (picker && shown < offered.length) {
    modal = box(
      shown > 0
        ? `${pickerDigits(shown)} choose a pipeline · ${CANCEL_WORDS}`
        : `${MAKE_TALLER} to choose a pipeline · ${CANCEL_WORDS}`,
    );
  }
  return { modal, shown };
}

/** The digits the picker takes: `1-N`, or `1` alone. */
function pickerDigits(n: number): string {
  return n <= 1 ? "1" : `1-${n}`;
}

function startModalOf(m: Model, q: StartQuestion, cols: number, height: number): Modal {
  return startWindowOf(m, q, cols, height).modal;
}

/** The box of the resume question: the decision it is about, and the one warning the journal can give. */
function resumeModalOf(m: Model, q: ResumeQuestion, cols: number, height: number): Modal {
  const inner = innerWidth(cols);
  const wrap = (text: string) => hardWrap(text, inner);
  const s = m.sessions.find((x) => x.id === q.runId);
  const offer = m.offers[q.runId]?.offer;
  const content: string[] = [];
  if (offer === undefined) {
    content.push(...wrap(bold(`Resume the agent of ${q.runId}?`)));
  } else {
    const d = offer.decision;
    const kind = d.kind === "pipeline_change" ? "pipeline change" : d.kind;
    const when = `${formatAge(m.now - d.ts)} ago`;
    content.push(
      ...wrap(
        bold(
          `Resume the agent of ${q.runId} after your ${kind} "${plain(d.node)}" ${d.outcome} (${when})?`,
        ),
      ),
    );
    if (offer.moved) {
      content.push("", ...wrap(yellow("an agent was served a step since your decision")));
    }
  }
  return boxOf(
    {
      title: ` Resume agent «${s?.title ?? q.runId}» `,
      content,
      footer: ["", dim(`y resume · ${CANCEL_WORDS}`)],
      buttons: [
        { key: "y", text: "[y Resume]" },
        { key: "escape", text: "[Esc Cancel]" },
      ],
      scroll: 0,
      scrollable: false,
    },
    cols,
    height,
  );
}

/** The window of whichever question is up besides a decision: the start, the resume or the form. */
function questionModal(m: Model, cols: number, height: number): Modal | undefined {
  if (m.start !== null) return startModalOf(m, m.start, cols, height);
  if (m.resume !== null) return resumeModalOf(m, m.resume, cols, height);
  if (m.taskForm !== null) return formModalOf(m.taskForm, cols, height);
  return undefined;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: this is what the pasted text is cleaned of
const PASTE_CONTROLS = /\r\n|[\u0000-\u001f\u007f-\u009f]/g;

/** A comment being typed belongs to the task whose card was open; if the card moves on, the comment is let go, not saved elsewhere. */
function settled(m: Model): Model {
  if (m.taskInput === null || shownTask(m) === m.taskInput.key) return m;
  return { ...m, taskInput: null, notice: "Comment cancelled: the task is no longer on the card." };
}

/**
 * Text the terminal marked as pasted. It only ever goes into an input that is already open, as one line
 * (line breaks and control characters become spaces) and never saves it; with no input open it is ignored whole,
 * so a pasted `c`, `q` or Enter is never read as a key. `givenUp` is a paste that was not finished in time: the text
 * so far is taken like any other, and the person is told why the keys that follow are dropped for a moment.
 */
export function pasteText(m: Model, text: string, givenUp = false): Model {
  const line = stripLoneSurrogates(text.replace(PASTE_CONTROLS, " "));
  const told = (): Model => (givenUp ? { ...m, notice: PASTE_GIVEN_UP } : m);
  if (m.taskForm) {
    const f = m.taskForm;
    // While the question "create it?" is up, or the task is being made, the text is not touched.
    if (f.confirmAt !== undefined || f.writing) {
      return text === "" ? told() : { ...m, notice: PASTE_IGNORED };
    }
    if (f.field === "priority") return told();
    const current = fieldText(f, f.field);
    const room = FIELD_MAX[f.field] - current.length;
    if (room <= 0) return told();
    // A body keeps the line breaks of what was pasted; a title or a key is one line.
    const pasted =
      f.field === "body"
        ? stripLoneSurrogates(text.replace(/\r\n?/g, "\n").replace(CONTROLS_BUT_NEWLINE, ""))
        : line;
    return {
      ...told(),
      taskForm: withFieldText(f, f.field, current + cutChars(pasted, room)),
    };
  }
  if (m.taskInput) {
    // While the question "save it?" is up the text is not touched, and the person is told so.
    if (m.taskInput.confirmAt !== undefined) {
      return text === "" ? told() : { ...m, notice: PASTE_IGNORED };
    }
    const room = TASK_COMMENT_MAX - m.taskInput.text.length;
    if (room <= 0) return told();
    return {
      ...told(),
      taskInput: { ...m.taskInput, text: m.taskInput.text + cutChars(line, room) },
    };
  }
  if (m.input) {
    const room = TASK_COMMENT_MAX - m.input.text.length;
    if (room <= 0) return told();
    return { ...told(), input: { ...m.input, text: m.input.text + cutChars(line, room) } };
  }
  return told();
}

/** The card of a task, as the reader answered. */
export function withTask(m: Model, key: string, slot: CardSlot): Model {
  return { ...m, tasks: withTaskCard(m.tasks, key, slot) };
}

/** The tasks the Backlog shows now, in order. */
function backlogKeys(m: Model): string[] {
  return backlogOf(m.tasks, m.sessions)?.rows.map((r) => r.key) ?? [];
}

/** The card of a task is asked for once: it is marked as being read, and the loop is told to read it. */
function askCard(m: Model, key: string): Model {
  if (key in m.tasks.cards) return m;
  const marked = withTask(m, key, { status: "loading" });
  if (m.effects.some((e) => e.type === "load_task" && e.key === key)) return marked;
  return { ...marked, effects: [...marked.effects, { type: "load_task", key }] };
}

/**
 * The task whose card is on the screen: the one the person opened from a card, else the one the list is on
 * (the Tasks screen's selection, or the Backlog row that is picked). Nothing on the other screens.
 */
export function shownTask(m: Model): string | undefined {
  const base =
    m.section === 2
      ? m.tasks.selected
      : m.section === 0 && m.pick.kind === "task"
        ? m.pick.key
        : "";
  if (base === "") return undefined;
  return m.tasks.drill.at(-1) ?? base;
}

/**
 * A task that is picked in Sessions but has left the block (it got a run, it was finished, the list changed)
 * gives the pick to the first row of the list, and the focus back to the list: a card must never show a row
 * the person did not pick. With no runs at all, the first task of the block is picked at once, so its keys work.
 */
function reconciled(m: Model): Model {
  const first = m.sessions[0];
  const task = backlogKeys(m)[0];
  const pickTask = (base: Model, key: string): Model =>
    askCard({ ...base, pick: { kind: "task", key } }, key);
  if (m.pick.kind === "run" && first === undefined && task !== undefined) {
    return pickTask(m, task);
  }
  if (m.pick.kind !== "task" || backlogKeys(m).includes(m.pick.key)) return m;
  // The Tasks screen has its own selection and card: only Sessions gives up the focus and what was opened.
  const onSessions = m.section === 0;
  const base = {
    ...m,
    ...(onSessions ? { focus: "list" as const } : {}),
    cardScroll: 0,
    tab: 0,
    cursor: 0,
    open: false,
    sub: 0,
    back: undefined,
    tasks: onSessions ? { ...m.tasks, drill: [], item: 0 } : m.tasks,
  };
  if (first) return { ...base, pick: { kind: "run" }, selected: first.id };
  if (task !== undefined) return pickTask(base, task);
  return { ...base, pick: { kind: "run" }, selected: "" };
}

export function tick(m: Model, now: number): Model {
  return { ...m, frame: m.frame + 1, now };
}

/** Whether anything on the list moves, so the loop redraws on a timer only when it must. */
export function isAnimated(m: Model): boolean {
  return (
    m.section === 0 &&
    m.sessions.some(
      (s) => s.status === "running" && (s.activity === "working" || s.activity === "agent"),
    )
  );
}

/** The run the Sessions selection is on; none while it is on a task, so no key or read can reach a run that is not shown. */
function selectedSession(m: Model): Session | undefined {
  if (m.pick.kind === "task") return undefined;
  return m.sessions.find((s) => s.id === m.selected) ?? m.sessions[0];
}

/** What has been read for the Report screen: a pipeline is read when it is first looked at. */
export function withStats(m: Model, pipeline: string, slot: StatsSlot): Model {
  return { ...m, stats: { ...m.stats, [pipeline]: slot } };
}

/** On the Report screen a pipeline that has not been read is asked for, once. */
function wanting(m: Model): Model {
  if (m.section === 2) {
    const key = shownTask(m);
    return key === undefined ? m : askCard(m, key);
  }
  const name = m.rep.selected;
  if (m.section !== 3 || name === "" || m.stats[name]) return m;
  return {
    ...withStats(m, name, { status: "loading" }),
    effects: [...m.effects, { type: "load_stats", pipeline: name }],
  };
}

export function update(input: Model, key: string, size: Size = DEFAULT_SIZE, alone = true): Model {
  return wanting(updateKey(input, key, size, alone));
}

function updateKey(input: Model, key: string, size: Size, alone: boolean): Model {
  const m = normalized(input);
  if (key === "ctrl-c") return { ...m, quit: true };
  if (m.flow) {
    // Leaving is never held back by a decision that is being asked or written.
    if (key === "q" && flowYieldsQuit(m.flow)) return { ...m, quit: true };
    // An answer is for a window that can be seen and has stood still: not on a terminal too small to
    // draw it, and not in the first moment after it changed what it asks (a double tap, a key held down).
    const answers =
      (key === "y" && m.flow.phase === "confirm") || (key === "enter" && m.flow.phase === "reason");
    if (answers) {
      if (tooSmall(size)) return m;
      if (m.now - m.flow.shownAt < CLICK_GUARD_MS) return m;
    }
    // The yes is for a question that has been read: with lines still out of the window it reads on
    // one window further first, and the window then stands still again.
    if (key === "y" && m.flow.phase === "confirm") {
      const modal = modalOf(m.flow, size.cols, size.rows - 3);
      if (m.flow.scroll < modal.maxScroll) {
        const scroll = Math.min(modal.maxScroll, m.flow.scroll + Math.max(1, modal.room - 1));
        return { ...m, flow: { ...m.flow, scroll, shownAt: m.now } };
      }
    }
    return clampFlowScroll(flowKey(m, key), size);
  }
  if (m.legend !== null) return legendKey(m, key, size);
  if (m.input) return typing(m, key, alone);
  if (m.taskInput) return typingTask(m, key, alone);
  if (m.taskForm !== null) return typingForm(m, key, alone, size);
  // A start or a resume being asked: `y` (or a digit) answers it, any other key only cancels it.
  if (m.start !== null) return startQuestionKey(m, key, alone, size);
  if (m.resume !== null) return resumeQuestionKey(m, key, alone, size);
  const current = selectedSession(m);
  if (m.confirm !== null && current) {
    if (key === "y") return decide(m, current, m.confirm);
    return { ...m, confirm: null, notice: "Cancelled." };
  }
  if (m.section === 1 && !SHARED_KEYS.has(key)) return pipesUpdate(m, key, size);
  if (m.section === 2 && !SHARED_KEYS.has(key)) return tasksUpdate(m, key, size);
  if (m.section === 3 && !SHARED_KEYS.has(key)) return reportUpdate(m, key, size);
  if (m.focus === "card" && m.section === 0) {
    const moved = taskCardKey(m, key, size) ?? cardKey(m, key, size);
    if (moved) return moved;
  }
  switch (key) {
    case "q":
      return { ...m, quit: true };
    case "tab":
      return go(m, (m.section + 1) % SECTIONS.length);
    case "1":
    case "2":
    case "3":
    case "4":
      return go(m, Number(key) - 1);
    case "up":
    case "k":
      return moveSelection(m, -1);
    case "down":
    case "j":
      return moveSelection(m, 1);
    case "pagedown":
    case " ":
      return scrollCard(m, size, PAGE);
    case "pageup":
    case "b":
      return scrollCard(m, size, -PAGE);
    case "z":
      if (m.section === 1 || m.section === 3) {
        const any = m.section === 1 ? m.pipelines.length > 0 : m.rep.selected !== "";
        return any ? { ...m, zoom: !m.zoom, focus: m.zoom ? m.focus : "card" } : m;
      }
      if (m.section === 2) {
        // Nothing to zoom into when the list is empty.
        return m.tasks.selected !== ""
          ? { ...m, zoom: !m.zoom, focus: m.zoom ? m.focus : "card" }
          : m;
      }
      if (m.section !== 0 || !canShow(m)) return m;
      return { ...m, zoom: !m.zoom, focus: m.zoom ? m.focus : "card" };
    case "m":
      return {
        ...m,
        mouse: !m.mouse,
        notice: m.mouse ? "Mouse off." : "Mouse on. Hold Shift (Option in iTerm2) to select text.",
      };
    case "enter":
    case "right":
      return m.section === 0 && canShow(m) ? { ...m, focus: "card" } : m;
    case "t": {
      // From a Backlog row to the same task on the Tasks screen. Its card is asked for again there.
      if (m.section !== 0 || m.pick.kind !== "task") return m;
      const key = m.pick.key;
      return {
        ...m,
        section: 2,
        focus: "list",
        zoom: false,
        notice: "",
        // Marked as asked for, so the Tasks screen does not ask for it a second time.
        back: undefined,
        tasks: {
          ...m.tasks,
          selected: key,
          pinned: true,
          scroll: 0,
          drill: [],
          item: 0,
          cards:
            key in m.tasks.cards
              ? m.tasks.cards
              : { ...m.tasks.cards, [key]: { status: "loading" } },
        },
        effects: [...m.effects, { type: "load_task", key }],
      };
    }
    case "c":
      // Only from a card that has the focus: never from a list row, where a stray key could open it.
      return m.focus === "card" ? startTaskComment(m) : m;
    case "s":
      return startKey(m);
    case "n":
      // A new task, from the Backlog (a task picked, or nothing at all to pick yet). Never from a run.
      return m.section === 0 && (m.pick.kind === "task" || m.sessions.length === 0)
        ? newTaskKey(m)
        : m;
    case "escape":
    case "left":
      // After a jump from a task into a run, Esc from the list goes back to that task's card.
      if (m.back !== undefined && m.focus === "list" && m.pick.kind === "run")
        return restoreBack(m);
      return { ...m, focus: "list", zoom: false };
    case "g":
    case "G":
      return movePick(m, key === "g" ? 1 : -1);
    case "a":
    case "r": {
      if (current?.need === undefined || keysOf(m, current)[key] === undefined) return m;
      // A decision is asked in a window over the Sessions screen, which is where it can be seen.
      if (m.section !== 0 || tooSmall(size)) return m;
      if (m.source === "project") {
        const ref = current.decisions === undefined ? undefined : pickedDecision(m, current);
        if (!ref) {
          return {
            ...m,
            notice: `This one is decided with a command, not from here. In a terminal: ${current.command ?? "see the card"}`,
          };
        }
        const decision = ref.kind === "pause" ? "resume" : key === "a" ? "approve" : "reject";
        return beginFlow(m, current, ref, decision);
      }
      return { ...m, confirm: key, notice: "" };
    }
    default:
      return m;
  }
}

/** Goes to a screen. What belonged to the card that was on the screen before (what was opened from it, the way back) is let go. */
function go(m: Model, section: number): Model {
  // The focus does not come along: `c` on the new screen must never find a card the person did not open there.
  return {
    ...m,
    section,
    focus: "list",
    notice: "",
    back: undefined,
    tasks: { ...m.tasks, drill: [], item: 0 },
  };
}

/** `c` on a task's card: a one-line input for a comment on the task the card shows. */
function startTaskComment(m: Model): Model {
  const key = shownTask(m);
  if (key === undefined || key === "") return m;
  return { ...m, taskInput: { key, text: "", openedAt: m.now }, notice: "" };
}

/** Enter on a new input and `y` on the question are ignored for this long: a burst of pasted text is over by then. */
export const COMMENT_GUARD_MS = 400;

/**
 * A comment on a task is being typed. Saving takes three steps, each of them a key alone in its chunk and after a
 * pause: Enter asks "save it?", `y` saves. A paste, however it reaches the program, cannot do all of that: its line
 * breaks arrive with other text, and the question needs a second, later chunk that is exactly `y`. Nothing else about
 * the task can change here.
 */
function typingTask(m: Model, key: string, alone: boolean): Model {
  const input = m.taskInput;
  if (!input) return m;
  if (key === "escape") return { ...m, taskInput: null, notice: "Cancelled." };
  if (input.confirmAt !== undefined) {
    // Only a lowercase `y` saves, as the line says; `Y` goes back to the text like any other key.
    if (key === "y" && alone) {
      // The notice would hide the question, so it is said on the question's own line (see `taskInputLine`).
      if (m.now - input.confirmAt < COMMENT_GUARD_MS) return { ...m, notice: WAIT_FOR_Y };
      const effect: Effect = {
        type: "add_task_comment",
        key: input.key,
        text: cleanComment(input.text).trim(),
      };
      return { ...m, taskInput: null, notice: "", effects: [...m.effects, effect] };
    }
    // Any other key goes back to the text, which is kept.
    const { confirmAt: _asked, ...back } = input;
    return { ...m, taskInput: back, notice: "" };
  }
  switch (key) {
    case "enter": {
      // Enter with other bytes in its chunk is a burst, not a press: it is not taken, and the person is told.
      if (!alone || m.now - input.openedAt < COMMENT_GUARD_MS) {
        return { ...m, notice: WAIT_FOR_ENTER };
      }
      // Blank means blank to a reader: the service refuses a text with nothing visible in it, and the person must
      // not be asked to confirm a text it will refuse.
      if (isBlank(input.text))
        return { ...m, taskInput: null, notice: "Nothing to save: the comment is empty." };
      return { ...m, taskInput: { ...input, confirmAt: m.now }, notice: "" };
    }
    case "backspace":
      return {
        ...m,
        taskInput: { ...input, text: [...input.text].slice(0, -1).join("") },
        notice: "",
      };
    default:
      // One printable character is text; the names of other keys (up, enter, ...) are longer.
      return [...key].length === 1 &&
        !CONTROL_OR_LONE.test(key) &&
        input.text.length + key.length <= TASK_COMMENT_MAX
        ? { ...m, taskInput: { ...input, text: input.text + key }, notice: "" }
        : m;
  }
}

/** The longest comment the contract takes (`TASK_LIMITS.comment`), counted as the contract counts: in UTF-16 units. */
const TASK_COMMENT_MAX = 500;

// A surrogate that has no partner is not a character; it must not reach the tracker.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, "g");

export function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATES, "");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: this is what a comment is cleaned of
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const CONTROL_OR_LONE = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f]|${LONE_SURROGATE.source}`);

/**
 * What a comment is cleaned of before it is sent: the control characters and surrogates with no partner, and nothing
 * else. The joiners and marks that words and emoji are made of (ZWNJ in Persian, ZWJ and VS16 in emoji) stay, so the
 * text the tracker gets is the text the person confirmed. The service validates and redacts it again.
 */
export function cleanComment(text: string): string {
  return stripLoneSurrogates(text.replace(CONTROLS, ""));
}

// Nothing a reader can see: spaces, and the zero-width characters that `trim` keeps.
const BLANK = /^[\s\u200b-\u200d\u2060\ufeff]*$/u;

/** A text with nothing visible in it. */
const isBlank = (text: string): boolean => BLANK.test(text);

const WAIT_FOR_ENTER = "Wait a moment, then press Enter again.";
const PASTE_IGNORED = "Press y to save, any other key to edit; pasted text was ignored.";
const PASTE_GIVEN_UP = "Paste given up; keys dropped until you pause for a second.";
const WAIT_FOR_Y = "Wait a moment, then press y.";

/** `text` cut to at most `room` UTF-16 units without ever splitting a character in two. */
function cutChars(text: string, room: number): string {
  let out = "";
  for (const char of text) {
    if (out.length + char.length > room) break;
    out += char;
  }
  return out;
}

/** The card of the task on the screen as lines, with the line of the item the cursor is on. */
function taskView(m: Model, width: number): CardView | undefined {
  const key = shownTask(m);
  if (key === undefined) return undefined;
  const load = m.tasks.load?.status === "ready" ? m.tasks.load : undefined;
  const rows = load ? [...load.rows, ...load.todo] : [];
  return taskCardView({
    slot: m.tasks.cards[key],
    row: rows.find((r) => r.key === key),
    key,
    sessions: m.sessions,
    rows,
    width,
    cursor: m.tasks.item,
    focused: m.focus === "card",
  });
}

/** Opens a task from the card: on top of the ones already opened. Its card is asked for. */
function drillTo(m: Model, key: string): Model {
  if (key === "") return m;
  const base = m.section === 2 ? m.tasks.selected : m.pick.kind === "task" ? m.pick.key : "";
  // A parent that is already under this card on the way down is the way back: the tasks above it are put away.
  const path = [base, ...m.tasks.drill];
  const at = path.slice(0, -1).lastIndexOf(key);
  const drill = at >= 0 ? path.slice(1, at + 1) : [...m.tasks.drill, key];
  return askCard(
    {
      ...m,
      notice: "",
      cardScroll: 0,
      tasks: { ...m.tasks, drill, item: 0, scroll: 0 },
    },
    key,
  );
}

/** Jumps from a task's card into a run of Sessions, remembering the card so Esc can come back to it. */
function jumpToRun(m: Model, id: string): Model {
  if (id === "") return m;
  const base = m.section === 2 ? m.tasks.selected : m.pick.kind === "task" ? m.pick.key : "";
  if (base === "" || (m.section !== 0 && m.section !== 2)) return m;
  return {
    ...m,
    section: 0,
    pick: { kind: "run" },
    selected: id,
    focus: "list",
    zoom: false,
    notice: "",
    cardScroll: 0,
    tab: 0,
    cursor: 0,
    open: false,
    sub: 0,
    back: { section: m.section, key: base, drill: m.tasks.drill },
    tasks: { ...m.tasks, drill: [], item: 0 },
  };
}

/** Esc in Sessions after such a jump: the task's card again, as it was left. */
function restoreBack(m: Model): Model {
  const back = m.back;
  if (back === undefined) return m;
  const tasks = { ...m.tasks, drill: back.drill, item: 0, scroll: 0 };
  const shown = back.drill.at(-1) ?? back.key;
  const restored: Model =
    back.section === 2
      ? {
          ...m,
          back: undefined,
          section: 2,
          focus: "card",
          zoom: false,
          notice: "",
          tasks: { ...tasks, selected: back.key, pinned: true },
        }
      : {
          ...m,
          back: undefined,
          section: 0,
          pick: { kind: "task", key: back.key },
          focus: "card",
          zoom: false,
          notice: "",
          cardScroll: 0,
          tasks,
        };
  // A Backlog task that has got a run meanwhile is no longer a row; the pick then falls back as it always does.
  return askCard(back.section === 0 ? reconciled(restored) : restored, shown);
}

/**
 * The keys of a task's card that has the focus: the arrows walk its items (the parent, the subtasks, the runs), Enter
 * opens one, Esc or Left takes back what was opened. Anything else goes on to the general keys. A card without items
 * leaves the arrows to scrolling.
 */
function taskCardKey(m: Model, key: string, size: Size): Model | undefined {
  const shown = shownTask(m);
  if (shown === undefined) return undefined;
  const width = layoutOf(m, size.cols).cardWidth;
  const view = taskView(m, width);
  if (!view) return undefined;
  const count = view.items.length;
  const at = Math.min(m.tasks.item, count - 1);
  const room = Math.max(1, size.rows - 3);
  const scrollKey = m.section === 2 ? "scroll" : "cardScroll";
  const current = m.section === 2 ? m.tasks.scroll : m.cardScroll;
  switch (key) {
    case "up":
    case "k":
    case "down":
    case "j": {
      if (count === 0) return undefined;
      const next = Math.min(count - 1, Math.max(0, at + (key === "up" || key === "k" ? -1 : 1)));
      const moved: Model = { ...m, tasks: { ...m.tasks, item: next } };
      const lines = taskView(moved, width);
      if (lines?.anchor === undefined) return moved;
      const to = scrollTo(current, lines.anchor, room, lines.lines.length);
      return scrollKey === "scroll"
        ? { ...moved, tasks: { ...moved.tasks, scroll: to } }
        : { ...moved, cardScroll: to };
    }
    case "enter":
    case "right": {
      const item = view.items[at];
      if (item === undefined) return undefined;
      if (item.kind === "run") return jumpToRun(m, item.id);
      return drillTo(m, item.key);
    }
    case "escape":
    case "left":
      if (m.tasks.drill.length === 0) return undefined;
      return {
        ...m,
        notice: "",
        cardScroll: 0,
        tasks: { ...m.tasks, drill: m.tasks.drill.slice(0, -1), item: 0, scroll: 0 },
      };
    default:
      return undefined;
  }
}

/** The keys every screen reads the same way. */
const SHARED_KEYS = new Set(["q", "tab", "1", "2", "3", "4", "m", "z"]);

/** The window of the legend: as wide as it can be up to this, and as tall as the screen lets it. */
const LEGEND_WIDTH = 78;

function legendFrame(cols: number, rows: number) {
  const width = Math.min(cols - 4, LEGEND_WIDTH);
  const lines = legendLines(width - 4);
  const room = Math.max(1, rows - 3 - 2);
  const shown = Math.min(lines.length, room);
  return { width, lines, shown, max: Math.max(0, lines.length - shown) };
}

/** A key while the legend is open: the arrows scroll it, any other key closes it. */
function legendKey(m: Model, key: string, size: Size): Model {
  if (m.legend === null) return m;
  const frame = legendFrame(size.cols, size.rows);
  const move = (by: number): Model => ({
    ...m,
    legend: Math.max(0, Math.min(frame.max, (m.legend ?? 0) + by)),
  });
  switch (key) {
    case "up":
    case "k":
      return move(-1);
    case "down":
    case "j":
      return move(1);
    case "pagedown":
    case " ":
      return move(Math.max(1, frame.shown - 1));
    case "pageup":
    case "b":
      return move(-Math.max(1, frame.shown - 1));
    default:
      return { ...m, legend: null };
  }
}

/** The legend in a box in the middle of the screen, over the screen dimmed. */
function legendOverlay(m: Model, body: string[], cols: number, height: number): string[] {
  const frame = legendFrame(cols, height + 3);
  const scroll = Math.min(frame.max, Math.max(0, m.legend ?? 0));
  const inner = frame.width - 4;
  const left = " ".repeat(Math.max(0, Math.floor((cols - frame.width) / 2)));
  const title = " What the numbers mean ";
  const hint = frame.max > 0 ? " ↑↓ scroll · any other key closes " : " any key closes ";
  const box = [
    `┌─${bold(title)}${"─".repeat(Math.max(0, frame.width - 3 - title.length))}┐`,
    ...frame.lines.slice(scroll, scroll + frame.shown).map((line) => `│ ${fit(line, inner)} │`),
    `└─${dim(hint)}${"─".repeat(Math.max(0, frame.width - 3 - hint.length))}┘`,
  ];
  const dimmed = Array.from({ length: height }, (_, i) => dim(stripAnsi(body[i] ?? "")));
  const top = Math.max(0, Math.floor((height - box.length) / 2));
  for (const [i, line] of box.entries()) {
    if (top + i < height) dimmed[top + i] = fit(`${left}${line}`, cols);
  }
  return dimmed;
}

/** A key on the Report screen. */
function reportUpdate(m: Model, key: string, size: Size): Model {
  if (key === "?") return { ...m, legend: 0, notice: "" };
  const layout = layoutOf(m, size.cols);
  const slot = m.stats[m.rep.selected];
  const r = repKey(m.rep, key, {
    names: repNames(m.pipelines),
    slot,
    focus: m.focus,
    width: layout.cardWidth,
    room: Math.max(1, size.rows - 3 - headHeight(m.rep, slot, layout.cardWidth)),
  });
  if (!r) return key === "escape" ? { ...m, zoom: false } : m;
  let next: Model = { ...m, rep: r.rep, notice: r.notice ?? "" };
  if (r.focus) next = { ...next, focus: r.focus, zoom: r.focus === "list" ? false : next.zoom };
  return next;
}

/** The card of the task on the Tasks screen, as lines. */
function tasksCardBody(m: Model, width: number): string[] {
  return taskView(m, width)?.lines ?? [dim("No task selected.")];
}

/** A key on the Tasks screen. What can change a task from here: `c`, a comment the person types, and `n`, a task they fill in. */
function tasksUpdate(m: Model, key: string, size: Size): Model {
  const load = m.tasks.load;
  if (key === "n") return newTaskKey(m);
  if (load?.status !== "ready") return key === "escape" ? { ...m, zoom: false } : m;
  if (m.focus === "card") {
    const moved = taskCardKey(m, key, size);
    if (moved) return moved;
  }
  const rows = orderedRows(load.rows);
  const scroll = (by: number): Model => {
    const room = Math.max(1, size.rows - 3);
    const max = Math.max(0, tasksCardBody(m, layoutOf(m, size.cols).cardWidth).length - room);
    return { ...m, tasks: { ...m.tasks, scroll: Math.min(max, Math.max(0, m.tasks.scroll + by)) } };
  };
  switch (key) {
    case "up":
    case "k":
    case "down":
    case "j": {
      const by = key === "up" || key === "k" ? -1 : 1;
      if (m.focus === "card") return scroll(by);
      const at = rows.findIndex((r) => r.key === m.tasks.selected);
      const next = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + by))];
      if (!next || (at >= 0 && next.key === m.tasks.selected)) return m;
      return {
        ...m,
        notice: "",
        tasks: { ...m.tasks, selected: next.key, pinned: false, scroll: 0, drill: [], item: 0 },
        effects: [...m.effects, { type: "load_task", key: next.key }],
      };
    }
    case "pagedown":
    case " ":
      return scroll(PAGE);
    case "pageup":
    case "b":
      return scroll(-PAGE);
    case "enter":
    case "right":
      return m.tasks.selected !== "" ? { ...m, focus: "card" } : m;
    case "c":
      // Only from a card that has the focus: never from a list row, where a stray key could open it.
      return m.focus === "card" ? startTaskComment(m) : m;
    case "escape":
    case "left":
      return { ...m, focus: "list", zoom: false };
    default:
      return m;
  }
}

/** A key on the Pipeline screen. */
function pipesUpdate(m: Model, key: string, size: Size): Model {
  const layout = layoutOf(m, size.cols);
  const entry = entryOf(m.pipelines, m.pipe);
  const head = entry ? pipeHead(entry, m.pipe, layout.cardWidth, true).length : 0;
  const r = pipeKey(m.pipe, key, {
    entries: m.pipelines,
    focus: m.focus,
    source: m.source,
    width: layout.cardWidth,
    room: Math.max(1, size.rows - 3 - head),
  });
  if (!r) return key === "escape" ? { ...m, zoom: false } : m;
  let next: Model = { ...m, pipe: r.p, notice: r.notice ?? "" };
  if (r.focus) next = { ...next, focus: r.focus, zoom: r.focus === "list" ? false : next.zoom };
  if (r.open) {
    next = {
      ...next,
      section: 0,
      pick: { kind: "run" },
      back: undefined,
      selected: r.open,
      focus: "card",
      zoom: false,
      cardScroll: 0,
      tab: 0,
      cursor: 0,
      open: false,
      sub: 0,
    };
  }
  return next;
}

/** Where a comment lands in the middle of being typed. */
const SEVERITIES = ["blocker", "critical", "major", "minor", "info"];

/**
 * A comment is being typed: every key is the comment's, except the few that end it. Enter saves it at once, but,
 * like the one on a task, only as the whole of its chunk and after `COMMENT_GUARD_MS`: Enter that comes with other
 * bytes, or right after the input opened, is a paste or a burst and is not taken.
 */
function typing(m: Model, key: string, alone: boolean): Model {
  const input = m.input;
  if (!input) return m;
  switch (key) {
    case "escape":
      return { ...m, input: null, notice: "Cancelled." };
    case "enter": {
      if (!alone || m.now - input.openedAt < COMMENT_GUARD_MS) {
        return { ...m, notice: WAIT_FOR_ENTER };
      }
      const description = input.text.trim();
      const found = detailOf(m);
      if (description === "" || !found) return { ...m, input: null, notice: "" };
      const comment = { severity: input.severity, location: input.place, description };
      const effect: Effect = {
        type: "add_comment",
        runId: found.s.id,
        node: found.d.node,
        attempt: found.d.attempt,
        comment,
      };
      return { ...m, input: null, notice: "", effects: [...m.effects, effect] };
    }
    case "tab": {
      const next = SEVERITIES[(SEVERITIES.indexOf(input.severity) + 1) % SEVERITIES.length];
      return { ...m, input: { ...input, severity: next ?? "major" } };
    }
    case "backspace":
      return { ...m, input: { ...input, text: [...input.text].slice(0, -1).join("") } };
    default:
      // One printable character is text; the names of other keys (up, enter, ...) are longer.
      return [...key].length === 1 && key >= " "
        ? { ...m, input: { ...input, text: input.text + key } }
        : m;
  }
}

/** The keys of a card that has the focus; anything it does not use goes on to the general ones. */
function cardKey(m: Model, key: string, size: Size): Model | undefined {
  const found = detailOf(m);
  const up = key === "up" || key === "k";
  const down = key === "down" || key === "j";
  if (!found) {
    if (up || down) return scrollCard(m, size, up ? -1 : 1);
    const s = selectedSession(m);
    const kind = s === undefined ? undefined : awaitedKind(m, s);
    return kind === undefined ? undefined : skeletonKey(m, key, tabsOf(kind));
  }
  const tabs = visibleTabs(found.d);
  const onList = isListTab(m.tab) && !m.open;
  const inStep = m.open && m.tab === STEPS;
  const reading = openDiff(m, found);
  if (reading) {
    const moved = readingKey(m, key, reading, found.d.kind === "gate");
    if (moved) return moved;
  }
  switch (key) {
    case "tab":
      return inStep
        ? toSub(m, (m.sub + 1) % SUBTABS.length)
        : toTab(m, around(tabs, m.tab, 1, true));
    case "shift-tab":
      return inStep
        ? toSub(m, (m.sub + SUBTABS.length - 1) % SUBTABS.length)
        : toTab(m, around(tabs, m.tab, -1, true));
    case "right":
      return inStep
        ? toSub(m, Math.min(SUBTABS.length - 1, m.sub + 1))
        : toTab(m, around(tabs, m.tab, 1, false));
    case "left":
      if (inStep) return toSub(m, Math.max(0, m.sub - 1));
      // Left of the first tab is the list.
      return around(tabs, m.tab, -1, false) !== m.tab
        ? toTab(m, around(tabs, m.tab, -1, false))
        : { ...m, focus: "list", zoom: false };
    case "up":
    case "k":
    case "down":
    case "j": {
      const by = up ? -1 : 1;
      return onList ? moveCursor(m, found.d, by) : scrollCard(m, size, by);
    }
    case "pageup":
    case "b":
      return onList ? moveCursor(m, found.d, -PAGE) : scrollCard(m, size, -PAGE);
    case "pagedown":
    case " ":
      return onList ? moveCursor(m, found.d, PAGE) : scrollCard(m, size, PAGE);
    case "enter":
      if (!onList || m.tab === COMMENTS || itemCount(found.d, m.tab) === 0) return m;
      return wantDiff({ ...m, open: true, sub: 0, cardScroll: 0, line: -1 }, found);
    case "n":
    case "p":
      return m.open
        ? wantDiff({ ...moveCursor(m, found.d, key === "n" ? 1 : -1), line: -1 }, found)
        : m;
    case "escape":
      return m.open ? { ...m, open: false, cardScroll: 0 } : { ...m, focus: "list", zoom: false };
    case "i":
      return m.tab === REPORT && found.d.instructions
        ? { ...m, instructions: !m.instructions, cardScroll: 0 }
        : undefined;
    case "c": {
      if (found.d.kind !== "gate") return undefined;
      const place = commentPlace(found.d, tabState(m, found.d));
      return { ...m, input: { text: "", severity: "major", place, openedAt: m.now }, notice: "" };
    }
    case "d":
      return m.tab === COMMENTS && onList && found.d.comments.length > 0
        ? { ...m, confirm: "d", notice: "" }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The tabs of a card that is not read yet: Left and Right only move the mark along the row (the tabs all
 * show the same placeholder), and the mark stays on the tab once the card lands. Tab keeps going to the
 * next screen, as it did before the row was drawn.
 */
function skeletonKey(m: Model, key: string, tabs: number[]): Model | undefined {
  // The mark is drawn on the first tab when the one asked for is not among these (as `normalized` does once the card is read).
  const at = tabs.includes(m.tab) ? m.tab : (tabs[0] ?? m.tab);
  switch (key) {
    case "right":
      return toTab(m, around(tabs, at, 1, false));
    case "left":
      return around(tabs, at, -1, false) !== at
        ? toTab(m, around(tabs, at, -1, false))
        : { ...m, focus: "list", zoom: false };
    default:
      return undefined;
  }
}

/** The diff of the file that is open in the Code tab, once it has been read. */
function openDiff(
  m: Model,
  found: { s: Session; d: GateDetail },
): { p: Prepared; path: string } | undefined {
  if (m.tab !== CODE || !m.open) return undefined;
  // The same file that is drawn: a list that has got shorter since leaves the cursor on the last.
  const path = fileAt(found.d, Math.min(m.cursor, itemCount(found.d, CODE) - 1));
  const diff = path === undefined ? undefined : m.diffs[diffKey(found.s.id, path)];
  return path !== undefined && diff?.kind === "text"
    ? { p: prepare(diff, diff.text, path), path }
    : undefined;
}

/** The keys of a diff that is being read: a cursor over its lines. */
function readingKey(
  m: Model,
  key: string,
  reading: { p: Prepared; path: string },
  canComment: boolean,
): Model | undefined {
  const { p, path } = reading;
  const at = m.line >= 0 ? m.line : firstCode(p);
  const go = (line: number): Model => ({ ...m, line });
  switch (key) {
    case "up":
    case "k":
      return go(moveCode(p, at, -1));
    case "down":
    case "j":
      return go(moveCode(p, at, 1));
    case "pageup":
    case "b":
      return go(moveCode(p, at, -PAGE));
    case "pagedown":
    case " ":
      return go(moveCode(p, at, PAGE));
    case "[":
      return go(moveHunk(p, at, -1));
    case "]":
      return go(moveHunk(p, at, 1));
    case "g":
      return go(firstCode(p));
    case "G":
      return go(moveCode(p, p.rows.length, 0));
    case "c": {
      if (!canComment) return undefined;
      const row = p.rows[at];
      return row
        ? {
            ...m,
            input: { text: "", severity: "major", place: placeOf(path, row), openedAt: m.now },
            notice: "",
          }
        : undefined;
    }
    default:
      return undefined;
  }
}

/** Open on a file in the Code tab: its diff is asked for, once. */
function wantDiff(m: Model, found: { s: Session; d: GateDetail }): Model {
  if (m.tab !== CODE || !m.open) return m;
  const path = fileAt(found.d, Math.min(m.cursor, itemCount(found.d, CODE) - 1));
  if (path === undefined || diffKey(found.s.id, path) in m.diffs) return m;
  return { ...m, effects: [...m.effects, { type: "load_diff", runId: found.s.id, path }] };
}

function toTab(m: Model, tab: number): Model {
  // The log is read from its end: the newest records are the ones people look for.
  const scroll = tab === LOG ? Number.MAX_SAFE_INTEGER : 0;
  const found = detailOf(m);
  const cursor = found ? startCursor(found.d, tab) : 0;
  return { ...m, tab, cursor, open: false, sub: 0, cardScroll: scroll, notice: "" };
}

function toSub(m: Model, sub: number): Model {
  return { ...m, sub, cardScroll: 0 };
}

function moveCursor(m: Model, d: GateDetail, by: number): Model {
  const count = itemCount(d, m.tab);
  return {
    ...m,
    cursor: Math.min(Math.max(0, count - 1), Math.max(0, m.cursor + by)),
    cardScroll: 0,
  };
}

/** The selected run's gate detail, once it has been read. */
function detailOf(m: Model): { s: Session; d: GateDetail } | undefined {
  const s = selectedSession(m);
  const d = s ? m.details[detailKey(s, pickedDecision(m, s))] : undefined;
  return s && d ? { s, d } : undefined;
}

/** The tab the card shows: the one asked for, or the first it has when this kind of card has no such tab. */
function normalized(m: Model): Model {
  const found = detailOf(m);
  if (!found) return m;
  const tabs = visibleTabs(found.d);
  const tab = tabs[0] ?? 0;
  return tabs.includes(m.tab)
    ? m
    : { ...m, tab, cursor: startCursor(found.d, tab), open: false, sub: 0 };
}

/** The tab `by` places from this one among the tabs the card has; at the ends it stops, or wraps round. */
function around(tabs: number[], tab: number, by: 1 | -1, wrap: boolean): number {
  const next = tabs.indexOf(tab) + by;
  if (wrap) return tabs[(next + tabs.length) % tabs.length] ?? tab;
  return tabs[Math.min(tabs.length - 1, Math.max(0, next))] ?? tab;
}

/** The rows the arrows walk in Sessions: the runs, then the tasks of the Backlog. */
function navRows(m: Model): RowId[] {
  return [
    ...m.sessions.map((s): RowId => ({ kind: "run", id: s.id })),
    ...backlogKeys(m).map((key): RowId => ({ kind: "task", key })),
  ];
}

/** Something the Sessions card can show: a run, or a task that is picked. */
function canShow(m: Model): boolean {
  return m.pick.kind === "task" || m.sessions.length > 0;
}

function select(m: Model, row: RowId): Model {
  const base = {
    ...m,
    notice: "",
    cardScroll: 0,
    tab: 0,
    cursor: 0,
    open: false,
    sub: 0,
    back: undefined,
    tasks: { ...m.tasks, drill: [], item: 0 },
  };
  if (row.kind === "run") return { ...base, selected: row.id, pick: { kind: "run" } };
  return {
    ...base,
    pick: { kind: "task", key: row.key },
    effects: [...m.effects, { type: "load_task", key: row.key }],
  };
}

function moveSelection(m: Model, by: -1 | 1): Model {
  const rows = navRows(m);
  const here = m.pick.kind === "task" ? m.pick.key : selectedSession(m)?.id;
  const at = rows.findIndex(
    (r) => (r.kind === "task" ? r.key : r.id) === here && r.kind === m.pick.kind,
  );
  const next = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + by))];
  return next ? select(m, next) : m;
}

const DEFAULT_SIZE: Size = { cols: 120, rows: 30 };
const PAGE = 10;

interface Layout {
  showList: boolean;
  showCard: boolean;
  listWidth: number;
  /** The column (from 1) where the card starts. */
  cardX: number;
  cardWidth: number;
}

function layoutOf(m: Model, cols: number): Layout {
  if (cols >= WIDE_COLS) {
    const listWidth = listWidthFor(cols);
    return m.zoom
      ? { showList: false, showCard: true, listWidth, cardX: 2, cardWidth: cols - 2 }
      : {
          showList: true,
          showCard: true,
          listWidth,
          cardX: listWidth + 4,
          cardWidth: cols - listWidth - 3,
        };
  }
  const card = m.focus === "card";
  return { showList: !card, showCard: card, listWidth: cols - 1, cardX: 2, cardWidth: cols - 2 };
}

interface Panel {
  /** Lines that stay at the top: the band with the run's name and numbers, and the tabs. */
  head: string[];
  body: string[];
  /** The line to keep in sight, in `body`. */
  anchor?: number;
  /** Where each tab's name is in the tab row (columns from 0), and which tab each span is. */
  spans?: [number, number][];
  tabs?: number[];
}

/** The card a selected run is about to get: a gate's or a running run's; nothing when no card is read for it. */
function awaitedKind(m: Model, s: Session): GateDetail["kind"] | undefined {
  if (s.status === "running") return "running";
  if (s.status !== "waiting" || s.need !== "approve") return undefined;
  // A paused step has no card to wait for.
  const picked = s.decisions && s.decisions.length > 0 ? pickedDecision(m, s) : undefined;
  return picked?.kind === "pause" ? undefined : "gate";
}

/** The step a run's band names before its card is read: from the decision, the headline or the row. */
function awaitedNode(m: Model, s: Session, kind: GateDetail["kind"]): string | undefined {
  if (kind === "running") return s.activity === "quiet" ? undefined : s.step;
  const picked = s.decisions && s.decisions.length > 0 ? pickedDecision(m, s) : undefined;
  return picked?.node ?? s.headline?.match(/«(.+?)»/)?.[1];
}

/** The card before it is read, laid out as the read one will be: band, tabs, and a body that says it is reading. */
function skeletonPanel(
  m: Model,
  s: Session,
  kind: GateDetail["kind"],
  width: number,
  height: number,
): Panel {
  const focused = m.focus === "card";
  const tabs = skeletonStrip(kind, m.tab, width, focused);
  const band = skeletonBand(
    s,
    kind,
    awaitedNode(m, s, kind),
    width,
    glyph(s, m.frame),
    m.now,
    height < 22,
  );
  const above = [...workerBlock(m, s, width), ...besideLines(s)];
  const body =
    kind === "gate"
      ? [...above, dim("Reading the details…"), "", ...decisionBox(m, s, width), ""]
      : [...above, dim("Reading the details…")];
  return {
    head: [...band, ...pickerLine(m, s, width), tabs.line, dim("─".repeat(width))],
    body: body.map((l) => fit(l, width)),
    spans: tabs.spans,
    tabs: tabsOf(kind),
  };
}

function tabState(m: Model, d: GateDetail): TabState {
  const count = itemCount(d, m.tab);
  return {
    tab: m.tab,
    cursor: Math.min(m.cursor, Math.max(0, count - 1)),
    open: m.open,
    sub: m.sub,
    line: m.line,
  };
}

/** What the right side shows for the selected run. */
function panel(m: Model, width: number, height: number): Panel {
  if (m.pick.kind === "task") {
    return { head: [], body: taskView(m, width)?.lines ?? [dim("No task selected.")] };
  }
  const s = selectedSession(m);
  if (!s) return { head: [], body: [dim("No session selected.")] };
  const found = detailOf(m);
  if (!found) {
    const kind = awaitedKind(m, s);
    return kind === undefined
      ? { head: [], body: cardLines(s, m, width) }
      : skeletonPanel(m, s, kind, width, height);
  }
  const focused = m.focus === "card";
  const tabs = tabStrip(found.d, m.tab, width, focused);
  const workerLog = workerLogOf(m, s);
  const content = tabContent(found.d, tabState(m, found.d), {
    now: m.now,
    width,
    focused,
    diffs: m.diffs,
    runId: s.id,
    instructions: m.instructions,
    ...(workerLog === undefined ? {} : { worker: workerLog }),
    decide: decisionWords(m, s),
  });
  const band = headerBand(s, found.d, width, glyph(s, m.frame), m.now, height < 22);
  // On the Log tab the whole log is right below: the tail of it is not drawn once more above.
  const above = [...workerBlock(m, s, width, found.d, m.tab !== LOG), ...besideLines(s)];
  return {
    head: [...band, ...pickerLine(m, s, width), tabs.line, dim("─".repeat(width))],
    body: [...above, ...content.lines],
    ...(content.anchor === undefined ? {} : { anchor: content.anchor + above.length }),
    spans: tabs.spans,
    tabs: visibleTabs(found.d),
  };
}

/** Scrolls a question no further than its window lets it. */
function clampFlowScroll(m: Model, size: Size): Model {
  const f = m.flow;
  if (!f) return m;
  const max = modalOf(f, size.cols, size.rows - 3).maxScroll;
  return f.scroll > max ? { ...m, flow: { ...f, scroll: max } } : m;
}

/** Which decision of the run is picked, when the run holds more than one. */
function pickerLine(m: Model, s: Session, width: number): string[] {
  const all = s.decisions ?? [];
  if (all.length < 2) return [];
  const picked = pickedDecision(m, s);
  const at = Math.max(0, picked ? all.indexOf(picked) : 0);
  const what = picked ? `${picked.kind === "gate" ? "gate" : "paused"} «${picked.node}»` : "";
  return [fit(dim(`decision ${at + 1} of ${all.length} · ${what} · g/G pick`), width)];
}

/**
 * What waits for a person in a run that is shown as running (a paused branch beside a branch that
 * still moves): a key here cannot decide it, so the commands are named.
 */
function besideLines(s: Session): string[] {
  const all = s.besides ?? [];
  if (all.length === 0) return [];
  return [
    dim("Also waiting for you (decide in a terminal):"),
    ...all.map((b) => dim(`  $ ${b.command}`)),
    "",
  ];
}

/** The panel as `height` lines: the head, then the part of the body that fits. */
function panelLines(m: Model, p: Panel, width: number, height: number): string[] {
  const room = Math.max(1, height - p.head.length);
  const follow = p.anchor !== undefined;
  const scroll = follow ? (p.anchor ?? 0) - Math.floor(room / 2) : m.cardScroll;
  return [...p.head, ...cardWindow(p.body, scroll, room, width)];
}

/** Scroll the card, never past its last line. */
function scrollCard(m: Model, size: Size, by: number): Model {
  const height = size.rows - 3;
  const p = panel(m, layoutOf(m, size.cols).cardWidth, height);
  const room = Math.max(1, height - p.head.length);
  const max = Math.max(0, p.body.length - room);
  return { ...m, cardScroll: Math.min(max, Math.max(0, m.cardScroll + by)) };
}

function decide(m: Model, s: Session, key: "a" | "r" | "d"): Model {
  if (key === "d") {
    const found = detailOf(m);
    if (!found) return { ...m, confirm: null };
    const effect: Effect = {
      type: "delete_comment",
      runId: s.id,
      node: found.d.node,
      attempt: found.d.attempt,
      index: m.cursor,
    };
    return { ...m, confirm: null, notice: "", effects: [...m.effects, effect] };
  }
  const label = s.need ? (NEED_KEYS[s.need][key] ?? "") : "";
  const next: Session =
    s.need === "hand_edit"
      ? { ...s, status: "done", step: "done", need: undefined, since: m.now }
      : { ...s, status: "running", activity: "agent", step: "…", need: undefined, since: m.now };
  const sessions = ordered(m.sessions.map((x) => (x.id === s.id ? next : x)));
  return {
    ...m,
    confirm: null,
    sessions,
    selected: s.id,
    notice: `${label} ${s.title}. Sample data: nothing was written.`,
  };
}

function glyph(s: Session, frame: number): string {
  switch (s.status) {
    case "waiting":
      return yellow("◐");
    case "running":
      if (s.activity === "working") return cyan(SPINNER[frame % SPINNER.length] ?? "●");
      if (s.activity === "agent")
        return Math.floor(frame / BLINK_FRAMES) % 2 === 0 ? cyan("●") : dim("●");
      return dim("●");
    case "failed":
      return red("✗");
    case "done":
      return green("✓");
    case "canceled":
      return dim("⊘");
    case "unreadable":
      return red("!");
  }
}

const STEP_GLYPH: Record<StepState, string> = {
  done: green("✓"),
  running: cyan("●"),
  waiting: yellow("◐"),
  pending: dim("○"),
  failed: red("✗"),
};

const TIME_WIDTH = 8;

function tagOf(s: Session, m?: Model): string {
  // A run with a background agent: the row says what the agent does; the card has the rest.
  const worker = m === undefined ? undefined : workerTag(m, s);
  if (worker !== undefined) return worker;
  if (s.status !== "waiting" || !s.need) return s.step;
  const more = (s.decisions?.length ?? 0) > 1 ? ` ×${s.decisions?.length}` : "";
  return `${NEED_TAG[s.need]}${more}`;
}

function timeOf(s: Session, now: number, ago: boolean): string {
  const age = formatAge(now - s.since);
  return ago ? `${age} ago` : age;
}

interface ListLines {
  lines: string[];
  /** The run or the task each line shows, or nothing for a group heading or a gap. */
  ids: (RowId | undefined)[];
  selectedAt: number;
}

function listLines(m: Model, width: number): ListLines {
  const lines: string[] = [];
  const ids: (RowId | undefined)[] = [];
  let selectedAt = 0;
  const tagWidth = Math.min(13, Math.max(7, ...m.sessions.map((s) => tagOf(s, m).length)));
  const titleWidth = Math.max(8, width - tagWidth - 13);
  const labels = rowLabels(m.sessions);
  for (const g of GROUPS) {
    const members = m.sessions.filter(g.of);
    if (members.length === 0) continue;
    const head = `${g.title} · ${members.length}`;
    const gap = Math.max(1, width - head.length - g.label.length);
    const text = `${head}${" ".repeat(gap)}${g.label}`;
    lines.push(g.title === "WAITING FOR YOU" ? bold(yellow(text)) : dim(text));
    ids.push(undefined);
    for (const s of members) {
      const bar = s.status === "waiting" ? yellow("▌") : " ";
      const tag = fit(tagOf(s, m), tagWidth);
      const tagStyled =
        m.offers[s.id]?.offer !== undefined
          ? green(tag)
          : s.status === "waiting"
            ? yellow(tag)
            : s.activity === "quiet"
              ? dim(tag)
              : tag;
      const time = timeOf(s, m.now, g.ago).padStart(TIME_WIDTH);
      const label = labels.get(s.id) ?? { name: s.title, guess: false };
      const row = `${bar}${glyph(s, m.frame)} ${fit(renderLabel(label, titleWidth), titleWidth)} ${tagStyled} ${time}`;
      if (m.pick.kind === "run" && s.id === m.selected) {
        selectedAt = lines.length;
        const plain = fit(stripAnsi(row), width);
        // With the card in focus the list keeps its place but stops shouting.
        lines.push(m.focus === "list" ? inverse(plain) : bold(`›${plain.slice(1)}`));
      } else {
        lines.push(fit(row, width));
      }
      ids.push({ kind: "run", id: s.id });
    }
    lines.push("");
    ids.push(undefined);
  }
  const block = backlogBlock(
    m.tasks,
    m.sessions,
    m.pick.kind === "task" ? m.pick.key : undefined,
    m.focus === "list",
    width,
  );
  const picked = m.pick.kind === "task" ? m.pick.key : undefined;
  for (const [i, line] of block.lines.entries()) {
    const id = block.ids[i];
    if (id?.kind === "task" && id.key === picked) selectedAt = lines.length;
    lines.push(line);
    ids.push(id);
  }
  return { lines, ids, selectedAt };
}

/** The part of the list that fits `height` lines, kept around the selected one. */
function listView(m: Model, width: number, height: number) {
  const { lines, ids, selectedAt } = listLines(m, width);
  const start =
    lines.length <= height
      ? 0
      : Math.min(Math.max(0, selectedAt - Math.floor(height / 2)), lines.length - height);
  return { lines: lines.slice(start, start + height), ids: ids.slice(start, start + height) };
}

function listWidthFor(cols: number): number {
  return Math.min(58, Math.max(44, Math.floor(cols * 0.42)));
}

function actionLine(m: Model, s: Session): string {
  const keys = keysOf(m, s);
  const parts = [
    ...(keys.a ? [`${bold("a")} ${keys.a}`] : []),
    ...(keys.r ? [`${bold("r")} ${keys.r}`] : []),
  ];
  if (parts.length === 0) return "";
  // A project whose sessions carry no decisions still only shows the command.
  const commandOnly = m.source === "project" && s.decisions === undefined;
  return `${parts.join("   ")}${commandOnly ? dim("   (shows the command for now)") : ""}`;
}

/** The yellow box of a waiting run: what is asked, that it is ready to decide, and the keys. */
function decisionBox(m: Model, s: Session, width: number): string[] {
  if (!s.need) return [];
  const inner = Math.max(10, width - 4);
  // With several decisions the card is about the picked one, not always the one the engine names first.
  const picked = s.decisions && s.decisions.length > 0 ? pickedDecision(m, s) : undefined;
  const other = picked !== undefined && picked !== s.decisions?.[0];
  const headline = other
    ? picked.kind === "pause"
      ? `Paused at «${picked.node}»`
      : `Step «${picked.node}» waits for your decision`
    : (s.headline ?? "");
  const prompt = other ? picked.prompt : (s.prompt ?? "");
  const command = other ? picked.command : s.command;
  const out: string[] = [];
  out.push(yellow(`┌ ${NEED_TAG[s.need]} · waiting ${formatAge(m.now - s.since)}`));
  out.push(`${yellow("│")} ${bold(headline)}`);
  for (const line of wrapText(prompt, inner)) out.push(`${yellow("│")} ${line}`);
  out.push(`${yellow("│")} ${green("Ready to decide")}`);
  if (s.after) out.push(`${yellow("│")} ${dim(`After that: ${s.after}`)}`);
  if (command) out.push(`${yellow("│")} ${dim(`$ ${command}`)}`);
  out.push(`${yellow("└")} ${actionLine(m, s)}`);
  return out;
}

/** Every line of the card; the screen shows the part from `cardScroll` on. */
function cardLines(s: Session | undefined, m: Model, width: number): string[] {
  if (!s) return [dim("No session selected.")];
  const out: string[] = [];
  out.push(`${glyph(s, m.frame)} ${bold(s.title)}`);
  if (s.agentSession) out.push(dim(sessionLine(s.agentSession, Math.max(20, width - 2))));
  out.push(dim(`${s.id} · ${s.pipeline}`));
  if (s.workdir) out.push(dim(s.workdir));
  out.push("");
  out.push(...workerBlock(m, s, width));
  const inner = Math.max(10, width - 4);
  if (s.status === "waiting" && s.need) {
    out.push(...pickerLine(m, s, width));
    out.push(...decisionBox(m, s, width));
    out.push("");
  } else if (s.status === "failed") {
    out.push(red("┌ failed"));
    for (const line of wrapText(s.reason ?? "", inner)) out.push(`${red("│")} ${line}`);
    for (const line of wrapText(
      "The run is over. To go on, add a route for that outcome to the pipeline and start a new run.",
      inner,
    )) {
      out.push(`${red("│")} ${dim(line)}`);
    }
    out.push(red("└"));
    out.push("");
  } else if (s.status === "unreadable") {
    out.push(red("┌ unreadable"));
    out.push(`${red("│")} ${bold(s.headline ?? "")}`);
    for (const line of wrapText(s.prompt ?? "", inner)) out.push(`${red("│")} ${line}`);
    out.push(`${red("│")} ${dim("Nothing to decide here.")}`);
    out.push(red("└"));
    out.push("");
  }
  if (s.steps.length > 0) {
    out.push(dim("STEPS"));
    for (const st of s.steps) {
      out.push(`${STEP_GLYPH[st.state]} ${fit(st.name, 16)} ${dim(st.note ?? "")}`);
    }
    out.push("");
  }
  out.push(dim("JOURNAL"));
  for (const l of s.log) out.push(dim(l));
  return out.map((l) => fit(l, width));
}

/** The lines of the card that fit, with a mark where more is above or below. */
function cardWindow(lines: string[], scroll: number, height: number, width: number): string[] {
  const start = Math.min(Math.max(0, scroll), Math.max(0, lines.length - height));
  const shown = lines.slice(start, start + height);
  if (start > 0 && shown.length > 0) shown[0] = dim(fit("▲ PgUp for earlier", width));
  if (start + height < lines.length && shown.length > 0) {
    shown[shown.length - 1] = dim(fit("▼ PgDn for more", width));
  }
  return shown;
}

const MENU_BRAND = " kodel ";

function menuCount(m: Model, i: number): number {
  if (i === 0) return m.sessions.filter((s) => s.status === "waiting").length;
  if (i !== 1) return 0;
  return m.pipelines.length > 0 ? pendingCount(m.pipelines) : m.proposals;
}

/** The list and the card side by side, or whichever one has the room. */
function panes(
  m: Model,
  layout: Layout,
  left: string[],
  right: string[],
  height: number,
): string[] {
  if (layout.showList && layout.showCard) {
    const divider = m.focus === "card" ? cyan("┃") : dim("│");
    return Array.from({ length: height }, (_, i) => {
      const l = fit(left[i] ?? "", layout.listWidth);
      const r = fit(right[i] ?? "", layout.cardWidth);
      return `${l} ${divider} ${r}`;
    });
  }
  return (layout.showCard ? right : left).map((l) => ` ${l}`);
}

function reportBody(m: Model, cols: number, height: number): string[] {
  const names = repNames(m.pipelines);
  if (names.length === 0) return emptyReport();
  const layout = layoutOf(m, cols);
  const left = layout.showList
    ? repList(names, m.rep, m.stats, layout.listWidth, height, m.focus === "list")
    : [];
  const right = layout.showCard
    ? repCard(m.rep, m.stats[m.rep.selected], layout.cardWidth, height, m.focus === "card")
    : [];
  return panes(m, layout, left, right, height);
}

function tasksBody(m: Model, cols: number, height: number): string[] {
  const notice = tasksNotice(m.tasks);
  if (notice) return ["", `  ${bold(SECTIONS[2])}`, ...notice];
  const layout = layoutOf(m, cols);
  const left = layout.showList
    ? taskListLines(m.tasks, layout.listWidth, height, m.focus === "list")
    : [];
  const right = layout.showCard
    ? scrolled(tasksCardBody(m, layout.cardWidth), m.tasks.scroll, height, layout.cardWidth)
    : [];
  return panes(m, layout, left, right, height);
}

function pipesBody(m: Model, cols: number, height: number): string[] {
  const entry = entryOf(m.pipelines, m.pipe);
  if (!entry) return emptyPipes();
  const layout = layoutOf(m, cols);
  const left = layout.showList
    ? pipeList(m.pipelines, m.pipe, m.sessions, layout.listWidth, height, m.focus === "list")
    : [];
  const right = layout.showCard
    ? pipeCard(entry, m.pipe, layout.cardWidth, height, m.focus === "card")
    : [];
  return panes(m, layout, left, right, height);
}

function menuLine(m: Model, cols: number): string {
  const items = SECTIONS.map((name, i) => {
    const count = menuCount(m, i);
    const badge = count > 0 ? ` ${yellow(String(count))}` : "";
    const text = ` ${i + 1} ${name}${badge} `;
    return i === m.section ? inverse(stripAnsi(text)) : text;
  });
  const right = dim(m.source === "demo" ? "sample data " : "live ");
  const left = `${bold(MENU_BRAND)}${items.join("")}`;
  const gap = cols - visibleLength(left) - visibleLength(right);
  return fit(gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : left, cols);
}

/**
 * What a gate prompt adds to the slug so that the row the person picked can be told from a look-alike: the
 * end of the id of the run, which only the engine writes, and the label of the row when it is not the slug.
 */
/** How much of the label of a row a gate prompt repeats: it is only there to be compared with the row. */
const ROW_IN_PROMPT = 30;

function rowOf(m: Model, s: Session | undefined): string {
  if (!s) return "";
  const label = rowLabels(m.sessions).get(s.id);
  const shown =
    label === undefined || label.name === s.title
      ? ""
      : ` · row «${clip(label.name, ROW_IN_PROMPT)}»`;
  return dim(` · ${s.id.slice(-8)}${shown}`);
}

interface BarButton {
  key: "a" | "r";
  text: string;
  /** The columns it covers on the bottom line, from `x0` up to `x1` (0-based). */
  x0: number;
  x1: number;
}

/** The buttons in front of the hints, while nothing else holds the bottom line. */
function barButtons(m: Model): BarButton[] {
  if (m.section !== 0 || m.pick.kind !== "run") return [];
  if (m.flow || m.input || m.legend !== null || m.confirm !== null) return [];
  if (m.start !== null || m.resume !== null || m.taskForm !== null) return [];
  if (m.notice !== "") return [];
  const keys = keysOf(m, selectedSession(m));
  const out: BarButton[] = [];
  let x = 1;
  for (const key of ["a", "r"] as const) {
    const label = keys[key];
    if (!label) continue;
    const text = `[${key} ${label.charAt(0).toUpperCase()}${label.slice(1)}]`;
    out.push({ key, text, x0: x, x1: x + text.length });
    x += text.length + 2;
  }
  return out;
}

/** The bottom line when nothing else holds it: the buttons, then the hints. */
function barText(m: Model): string {
  const buttons = barButtons(m);
  const front = buttons.map((b) => inverse(b.text)).join("  ");
  return buttons.length > 0 ? `${front}   ${hints(m)}` : hints(m);
}

/** The hints of a task's card that has the focus: the keys of its items first, `c` last where a narrow screen cuts. */
function taskCardHints(m: Model): string {
  const width = 80;
  const view = taskView(m, width);
  const items = view?.items.length ?? 0;
  const nav = items > 0 ? `${bold("↑↓")} select   ${bold("Enter")} open` : `${bold("↑↓")} scroll`;
  const esc = m.tasks.drill.length > 0 ? "back" : "list";
  return `${nav}   ${bold("Esc")} ${esc}   ${bold("z")} ${m.zoom ? "show list" : "zoom"}   ${bold("q")} quit   ${bold("c")} comment`;
}

function tasksHints(m: Model): string {
  const keys = (s: string) => bold(s);
  if (m.focus === "card") return `${taskCardHints(m)}   ${keys("n")} new`;
  const comment = m.tasks.selected === "" ? "" : `   ${keys("c")} comment`;
  return `${keys("↑↓")} select   ${keys("Enter")} card   ${keys("n")} new   ${keys("z")} zoom   ${keys("Tab")} menu   ${keys("q")} quit${comment}`;
}

function hints(m: Model): string {
  if (m.section === 2) return tasksHints(m);
  if (m.section === 1) return pipeHints(entryOf(m.pipelines, m.pipe), m.pipe, m.focus === "card");
  if (m.legend !== null) return `${bold("↑↓")} scroll   any other key closes the legend`;
  if (m.section === 3) return repHints(m.rep, m.focus === "card");
  const current = selectedSession(m);
  if (m.confirm === "d")
    return `${bold("Delete this comment?")}  ${bold("y")} yes   ${bold("n")} no`;
  if (m.confirm !== null) {
    const label = current?.need ? (NEED_KEYS[current.need][m.confirm] ?? "") : "";
    // The keys come first: text that the agent's session wrote must not push them off a narrow screen.
    return `${bold("y")} yes   ${bold("n")} no   ${bold(label)} «${current?.title ?? ""}»${rowOf(m, current)}?`;
  }
  if (m.back !== undefined && m.pick.kind === "run" && m.focus === "list") {
    return `${bold("Esc")} back to ${cyan(clip(m.back.key, 24))}   ${runHints(m, current)}`;
  }
  if (m.pick.kind === "task") {
    // No key of a run works on a task. `s` starts it in a background agent, after a question; `n` opens the form of a new one. `t` comes last, where a narrow screen cuts.
    return m.focus === "card"
      ? `${taskCardHints(m)}   ${bold("s")} start   ${bold("n")} new   ${bold("t")} tasks`
      : `${bold("↑↓")} select   ${bold("Enter")} card   ${bold("s")} start   ${bold("n")} new   ${bold("Tab")} menu   ${bold("q")} quit   ${bold("t")} tasks   ${bold("c")} comment`;
  }
  const keys = keysOf(m, current);
  const pick = (current?.decisions?.length ?? 0) > 1 ? `   ${bold("g/G")} pick` : "";
  // The buttons in front of these hints already say what a and r do.
  const decide = barButtons(m).length > 0 ? pick : `${pick}${decisionKeys(keys)}`;
  const zoom = `   ${bold("z")} ${m.zoom ? "show list" : "zoom"}`;
  if (m.focus === "card" && m.section === 0) {
    const found = detailOf(m);
    const comment = found?.d.kind === "gate" ? `   ${bold("c")} comment` : "";
    let nav: string;
    if (!found) nav = `${bold("↑↓")} scroll   ${bold("Esc")} list`;
    else if (m.open && m.tab === STEPS) {
      nav = `${bold("←→")} result/changes/log   ${bold("n/p")} next/prev${comment}   ${bold("Esc")} back`;
    } else if (m.open && m.tab === CODE) {
      nav = `${bold("↑↓")} line   ${bold("[ ]")} hunk   ${bold("n/p")} file${comment}   ${bold("Esc")} back`;
    } else if (m.open) {
      nav = `${bold("↑↓")} scroll   ${bold("n/p")} next/prev${comment}   ${bold("Esc")} back`;
    } else if (m.tab === COMMENTS) {
      nav = `${bold("←→")} tabs   ${bold("↑↓")} select   ${bold("c")} add   ${bold("d")} delete   ${bold("Esc")} list`;
    } else if (isListTab(m.tab)) {
      nav = `${bold("←→")} tabs   ${bold("↑↓")} select   ${bold("Enter")} open${comment}   ${bold("Esc")} list`;
    } else {
      const more = m.tab === REPORT && found.d.instructions ? `   ${bold("i")} instructions` : "";
      nav = `${bold("←→")} tabs   ${bold("↑↓")} scroll${comment}${more}   ${bold("Esc")} list`;
    }
    return `${nav}${decide}${zoom}   ${bold("q")} quit`;
  }
  return runHints(m, current);
}

const decisionKeys = (keys: { a?: string; r?: string }): string =>
  `${keys.a ? `   ${bold("a")} ${keys.a}` : ""}${keys.r ? `   ${bold("r")} ${keys.r}` : ""}`;

/** The keys of the run list: select, open, decide, menu. Also what stays on the hint line after a jump from a task. */
function runHints(m: Model, current: Session | undefined): string {
  const pick = (current?.decisions?.length ?? 0) > 1 ? `   ${bold("g/G")} pick` : "";
  const resume =
    current !== undefined && m.offers[current.id]?.offer !== undefined
      ? `   ${bold("s")} resume`
      : "";
  const decide = `${barButtons(m).length > 0 ? pick : `${pick}${decisionKeys(keysOf(m, current))}`}${resume}`;
  const proposals =
    m.proposals > 0
      ? dim(`   ${m.proposals} pipeline proposal${m.proposals === 1 ? "" : "s"} wait on 2`)
      : "";
  const mouse = `   ${bold("m")} mouse ${m.mouse ? green("on") : dim("off")}`;
  return `${bold("↑↓")} select   ${bold("Enter")} details${decide}   ${bold("Tab")} menu${mouse}   ${bold("q")} quit${proposals}`;
}

/** The line at the bottom while a comment is being typed. */
function inputLine(input: Input, notice = ""): string {
  const place = input.place.length > 28 ? `…${input.place.slice(-27)}` : input.place;
  const hint = notice === "" ? dim("Enter save · Tab severity · Esc cancel") : yellow(notice);
  return `${bold("Comment")} on ${cyan(place)} [${yellow(input.severity)}]: ${input.text}${inverse(" ")}   ${hint}`;
}

/** The end of a text that does not fit `room` columns, with a mark where the head was cut: what was typed last is what shows. */
function tailOf(text: string, room: number): string {
  if (room <= 0) return "";
  const chars = [...text];
  return chars.length <= room ? text : `…${chars.slice(chars.length - room + 1).join("")}`;
}

/**
 * The line at the bottom while a comment on a task is being typed, or while the question "save it?" is up. The head
 * of a long text is the part that is cut, never its end or the cursor: the person sees what Enter would send.
 */
function taskInputLine(input: TaskInput, cols: number, notice = ""): string {
  const key = cyan(clip(input.key, 24));
  // A notice on the comment (a key pressed too early) is told here: a notice line would hide the input itself.
  const said = notice === "" ? "" : `${yellow(notice)} `;
  if (input.confirmAt !== undefined) {
    const full = `${bold("Save this comment to")} ${key}${bold("?")}  ${bold("y")} save · any other key edits · Esc cancel  «`;
    const short = `${bold("Save to")} ${key}${bold("?")} ${bold("y")} save · Esc cancel «`;
    // The end of the text matters more than the long wording: on a narrow screen the short lead is used.
    const lead = said === "" && cols - 1 - visibleLength(full) - 1 >= 24 ? full : short;
    const room = cols - 1 - visibleLength(said) - visibleLength(lead) - 1;
    return `${said}${lead}${tailOf(input.text, room)}»`;
  }
  const prefix = `${bold("Comment")} on ${key}: `;
  const hint =
    said === "" ? `   ${dim("Enter then y to save · Esc cancel")}` : `   ${said.trimEnd()}`;
  const full = cols - 1 - visibleLength(prefix) - 1;
  const withHint = full - visibleLength(hint);
  const room = withHint >= 20 ? withHint : full;
  return `${prefix}${tailOf(input.text, room)}${inverse(" ")}${withHint >= 20 ? hint : ""}`;
}

/**
 * The bottom line while the start question is in its window: a notice when there is one, else what the keys
 * do, offering only the digits whose rows the window draws (`cols` and `height` are the body's).
 */
function startLine(m: Model, q: StartQuestion, cols: number, height: number, notice = ""): string {
  if (notice !== "") return yellow(notice);
  if (q.pipelines === undefined) return `${dim("Checking…")}   ${bold("Esc")} cancel`;
  const offered = q.pipelines.slice(0, PICKER_MAX);
  if (offered.length === 1) return `${bold("y")} start   ${bold("Esc")} cancel`;
  const { shown } = startWindowOf(m, q, cols, height);
  // No row of the picker fits: no digit is offered, and the line fits the narrowest terminal (40 columns).
  if (shown === 0) return `${bold(MAKE_TALLER)}   ${bold("Esc")} cancel`;
  return `${bold(pickerDigits(shown))} choose a pipeline   ${bold("Esc")} cancel`;
}

/** The bottom line while the resume question is in its window. */
function resumeLine(notice = ""): string {
  if (notice !== "") return yellow(notice);
  return `${bold("y")} resume   ${bold("Esc")} cancel`;
}

function emptyState(): string[] {
  return [
    "",
    `  ${bold("No runs yet.")}`,
    "",
    dim("  Start one from your coding agent:"),
    `    ${cyan("/kodel-run")} <what to do>`,
    `    ${cyan("/kodel-design")}   ${dim("no pipeline yet? this designs one")}`,
  ];
}

/** The notices that tell a refusal or a failure: the loop words them with these openings. */
const isFailure = (notice: string): boolean =>
  /^(Could not|Cannot|Comments cannot|Tasks cannot|Nothing to save|Nothing to resume|run r_|starting is not available|creating a task is not available|A task needs a title)|( is (already|being) started| cannot be started|nothing to start|was not resumed|was made but no agent)/.test(
    notice,
  );

export function render(model: Model, { cols, rows }: Size): string[] {
  const m = normalized(model);
  if (cols < 40 || rows < 12) {
    return [fit(`Terminal too small: ${cols}x${rows}, need 40x12.`, cols)];
  }
  const bodyHeight = rows - 3;
  const rule = dim("─".repeat(cols));
  const out: string[] = [menuLine(m, cols), rule];

  let body: string[];
  if (m.section === 2) {
    body = tasksBody(m, cols, bodyHeight);
  } else if (m.section === 3) {
    body = reportBody(m, cols, bodyHeight);
  } else if (m.section === 1) {
    body = pipesBody(m, cols, bodyHeight);
  } else if (m.sessions.length === 0 && navRows(m).length === 0) {
    // No runs and no task to pick: the way to start, and the one line about the tasks when they are not there.
    body = [
      ...emptyState(),
      "",
      ...backlogBlock(m.tasks, m.sessions, undefined, true, cols - 2).lines.map((l) => ` ${l}`),
    ];
  } else {
    const layout = layoutOf(m, cols);
    const right = layout.showCard
      ? panelLines(m, panel(m, layout.cardWidth, bodyHeight), layout.cardWidth, bodyHeight)
      : [];
    const left = layout.showList ? listView(m, layout.listWidth, bodyHeight).lines : [];
    body = panes(m, layout, left, right, bodyHeight);
  }
  if (m.legend !== null && m.section === 3) body = legendOverlay(m, body, cols, bodyHeight);
  if (m.flow && m.section === 0) {
    body = modalOverlay(modalOf(m.flow, cols, bodyHeight), body, cols, bodyHeight);
  }
  // The start and resume questions are asked on the Sessions screen, the form wherever it was opened.
  const question = questionModal(m, cols, bodyHeight);
  if (question && (m.section === 0 || m.taskForm !== null)) {
    body = modalOverlay(question, body, cols, bodyHeight);
  }
  for (let i = 0; i < bodyHeight; i++) out.push(fit(body[i] ?? "", cols));

  const status = m.flow
    ? flowBar(m.flow)
    : m.input
      ? inputLine(m.input, m.notice)
      : m.taskInput
        ? taskInputLine(m.taskInput, cols, m.notice)
        : m.taskForm !== null
          ? formLine(m.taskForm, m.notice)
          : m.start !== null
            ? startLine(m, m.start, cols, bodyHeight, m.notice)
            : m.resume !== null
              ? resumeLine(m.notice)
              : m.notice !== ""
                ? (isFailure(m.notice) ? red : green)(m.notice)
                : barText(m);
  out.push(fit(` ${status}`, cols));
  return out;
}

export type Hit =
  | { kind: "menu"; section: number }
  | { kind: "session"; id: string }
  | { kind: "task"; key: string }
  | { kind: "tab"; index: number }
  | { kind: "card" };

/** What is under a point of the screen (1-based column and row, as the terminal reports them). */
export function hitTest(model: Model, { cols, rows }: Size, x: number, y: number): Hit | undefined {
  const m = normalized(model);
  if (cols < 40 || rows < 12) return undefined;
  if (y === 1) {
    let start = MENU_BRAND.length + 1;
    for (const [i, name] of SECTIONS.entries()) {
      const count = menuCount(m, i);
      const width = ` ${i + 1} ${name} `.length + (count > 0 ? ` ${count}`.length : 0);
      if (x >= start && x < start + width) return { kind: "menu", section: i };
      start += width;
    }
    return undefined;
  }
  const bodyHeight = rows - 3;
  const row = y - 3;
  if (m.section !== 0 || navRows(m).length === 0 || row < 0 || row >= bodyHeight) return undefined;
  const layout = layoutOf(m, cols);
  if (layout.showList && x <= layout.listWidth) {
    const id = listView(m, layout.listWidth, bodyHeight).ids[row];
    if (id === undefined) return undefined;
    return id.kind === "run" ? { kind: "session", id: id.id } : { kind: "task", key: id.key };
  }
  if (!layout.showCard || x < layout.cardX) return undefined;
  const p = panel(m, layout.cardWidth, bodyHeight);
  if (p.spans !== undefined && p.tabs !== undefined && row === p.head.length - 2) {
    const at = x - layout.cardX;
    const index = p.spans.findIndex(([from, to]) => at >= from && at < to);
    const tab = p.tabs[index];
    if (tab !== undefined) return { kind: "tab", index: tab };
  }
  return { kind: "card" };
}

/**
 * A click selects a session, a menu item or a tab, presses a button, and the wheel moves the selection
 * or scrolls. A button does what its key does; a decision is only written after the yes in its window.
 */
export function mouseUpdate(
  input: Model,
  size: Size,
  event: Extract<InputEvent, { type: "mouse" }>,
): Model {
  return wanting(mouseEvent(input, size, event));
}

/**
 * How long after the window changes its question a click is not taken as an answer (milliseconds). The
 * clock is the screen's, which moves with the frames (every 100 ms), so in time it is a little less.
 */
const CLICK_GUARD_MS = 400;

/** Whether the screen is too small to draw anything but its warning: nothing is answered there. */
function tooSmall(size: Size): boolean {
  return size.cols < 40 || size.rows < 12;
}

/** A click while a decision is asked: only the buttons of its window answer. */
function modalClick(m: Model, size: Size, event: Extract<InputEvent, { type: "mouse" }>): Model {
  const f = m.flow;
  if (!f || event.action !== "press") return m;
  // Not drawn on a terminal this small, so not answered either.
  if (tooSmall(size)) return m;
  // A click right after the window changed what it asks (a double click on a button, say) lands on
  // the button that took its place, which its maker never saw.
  if (m.now - f.shownAt < CLICK_GUARD_MS) return m;
  const modal = modalOf(f, size.cols, size.rows - 3);
  const row = event.y - 3;
  const col = event.x - 1;
  const hit = modal.buttons.find((b) => b.row === row && col >= b.x0 && col < b.x1);
  return hit ? updateKey(m, hit.key, size, true) : m;
}

function mouseEvent(
  input: Model,
  size: Size,
  event: Extract<InputEvent, { type: "mouse" }>,
): Model {
  const m = normalized(input);
  if (!m.mouse) return m;
  if (m.flow) return modalClick(m, size, event);
  // A start, a resume or the form in its window: only the buttons of the window answer, under the keys' own guards.
  const question = questionModal(m, size.cols, size.rows - 3);
  if (question) {
    if (event.action !== "press" || tooSmall(size)) return m;
    const row = event.y - 3;
    const col = event.x - 1;
    const hit = question.buttons.find((b) => b.row === row && col >= b.x0 && col < b.x1);
    return hit ? updateKey(m, hit.key, size, true) : m;
  }
  if (m.confirm !== null || m.legend !== null || m.taskInput !== null) return m;
  if (event.action === "press" && event.y === size.rows) {
    const col = event.x - 1;
    const hit = barButtons(m).find((b) => col >= b.x0 && col < b.x1);
    return hit ? updateKey(m, hit.key, size, true) : m;
  }
  const layout = layoutOf(m, size.cols);
  if (event.action !== "press") {
    if (m.section !== 0) return m;
    const direction = event.action === "wheel_up" ? -1 : 1;
    const overCard = layout.showCard && (!layout.showList || event.x >= layout.cardX);
    if (!overCard) return moveSelection(m, direction);
    const found = detailOf(m);
    if (found && isListTab(m.tab) && !m.open) return moveCursor(m, found.d, direction);
    return scrollCard(m, size, direction * 3);
  }
  const hit = hitTest(m, size, event.x, event.y);
  if (!hit) return m;
  if (hit.kind === "menu") return go(m, hit.section);
  if (hit.kind === "tab") return toTab({ ...m, focus: "card" }, hit.index);
  if (hit.kind === "card") return { ...m, focus: "card" };
  if (hit.kind === "task") {
    if (m.pick.kind === "task" && m.pick.key === hit.key) {
      return { ...m, focus: size.cols < WIDE_COLS ? "card" : "list", notice: "" };
    }
    return { ...select(m, { kind: "task", key: hit.key }), focus: "list" };
  }
  if (m.pick.kind === "run" && hit.id === m.selected) {
    return { ...m, focus: size.cols < WIDE_COLS ? "card" : "list", notice: "" };
  }
  return { ...select(m, { kind: "run", id: hit.id }), focus: "list" };
}
