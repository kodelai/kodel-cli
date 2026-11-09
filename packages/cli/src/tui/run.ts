/** The terminal loop: alternate screen, raw keys, redraw on a key, a resize, a frame or new data. */
import { plain } from "../plain";
import { WORKER_REFRESH_MS, type WorkerLauncher, type WorkerStatus } from "../worker-launcher";
import { neutralize } from "./ansi";
import type { DecisionRequest, WorkHandle } from "./decide";
import {
  createInputReader,
  HOLD_MS,
  type InputEvent,
  type InputReader,
  MOUSE_OFF,
  MOUSE_ON,
  PASTE_OFF,
  PASTE_ON,
  parseInput,
} from "./input";
import type { Loaded } from "./load";
import type {
  CheckResult,
  Comment,
  DecisionOutcome,
  DecisionRef,
  DiffState,
  GateDetail,
} from "./session";
import type { StatsData } from "./stats-load";
import { diffKey } from "./tabs";
import { type CardSlot, messageOf, type NewTaskInput, type TasksLoad } from "./tasks-load";
import { createRefresh, createTasksRefresh } from "./tasks-refresh";
import {
  cleanComment,
  detailKey,
  type Effect,
  initialModel,
  isAnimated,
  type Model,
  mouseUpdate,
  pasteText,
  pickedDecision,
  render,
  shownTask,
  takeEffects,
  tick,
  update,
  withCheck,
  withData,
  withDecided,
  withDetail,
  withDiff,
  withProgress,
  withResumed,
  withStarted,
  withStartReady,
  withStartRefused,
  withStats,
  withTask,
  withTaskCreated,
  withTasks,
  withWorkers,
  withWorkersUnknown,
} from "./view";

const FRAME_MS = 100;

/** What `prepareStart` answers: the pipelines to offer, or why `s` does nothing. */
export type StartCheck = { ok: true; pipelines: string[] } | { ok: false; message: string };

/** What `startTask` and `resumeWorker` answer: the notice, and the run that got an agent. */
export interface StartResult {
  ok: boolean;
  message: string;
  runId?: string;
}

/** A read of the worker records: the statuses by run id, or a read that failed. */
export type WorkerRead = { ok: true; statuses: Map<string, WorkerStatus> } | { ok: false };
const REFRESH_MS = 2000;
/** How often the card of a run that is going on is read again. */
const DETAIL_REFRESH_MS = 4000;
/** How often the pipeline on the Report screen is read again: it only changes when a run ends. */
const STATS_REFRESH_MS = 60_000;

export interface TuiOptions {
  /** Start with mouse events on; `m` turns them on and off while the screen is open. */
  mouse?: boolean;
  /** How often the list of runs is read again (milliseconds); tests make it long or short. */
  refreshMs?: number;
  /** Reads what the card of a run at a human step shows; called for the selected run only, for the picked gate. */
  loadDetail?: (runId: string, pick?: DecisionRef) => Promise<GateDetail | undefined>;
  /** Looks at a decision before anything is written: the questions to ask, or why not. */
  checkDecision?: (runId: string, request: DecisionRequest) => Promise<CheckResult>;
  /** Writes a decision a person confirmed. A person's act, never an agent's. */
  decide?: (runId: string, request: DecisionRequest) => Promise<DecisionOutcome>;
  /** The engine work the decisions started here, waited for when the screen is left. */
  work?: WorkHandle;
  /** Reads the diff of one changed file of a run. */
  loadDiff?: (runId: string, path: string) => Promise<DiffState>;
  /** Records a comment at the gate of a run, or takes one out. A person's act, never an agent's. */
  addComment?: (runId: string, node: string, attempt: number, comment: Comment) => Promise<void>;
  deleteComment?: (runId: string, node: string, attempt: number, index: number) => Promise<void>;
  /** Sums up the runs of a pipeline for the Report screen. */
  loadStats?: (pipeline: string) => Promise<StatsData>;
  /** Reads the tasks for the Tasks screen and the Backlog; apart from the runs, on a timer of its own. */
  loadTasks?: () => Promise<TasksLoad>;
  /** Reads one task, with its body and comments, for its card. */
  loadTask?: (key: string) => Promise<CardSlot>;
  /** Adds a comment to a task. A person's act, typed with `c`: one of the two writes the task screens make. */
  addTaskComment?: (key: string, text: string) => Promise<void>;
  /** Creates a task from the form opened with `n`. A person's act, never an agent's: the other write of the task screens. */
  createTask?: (input: NewTaskInput) => Promise<{ key: string }>;
  /** `s` on a task: the preflight and the pipelines that load; nothing is made. */
  prepareStart?: (key: string) => Promise<StartCheck>;
  /** The person confirmed a start: a run for the task, then a background agent for the run. A person's act, never an agent's. */
  startTask?: (key: string, pipeline: string) => Promise<StartResult>;
  /** The person confirmed a resume: the agent of the run goes on after their decision at journal line `seq`. */
  resumeWorker?: (runId: string, seq: number, sessionId?: string) => Promise<StartResult>;
  /** Reads the records and the digest of the background agents; on a timer of its own, never on Windows. */
  workers?: Pick<WorkerLauncher, "statuses" | "progress">;
  /** How often the records are read (milliseconds); tests make it short. */
  workerRefreshMs?: number;
  /** The platform, for the one check that skips the worker reads (`win32`); tests set it. */
  platform?: string;
}

/**
 * What a chunk of input does to the model. A comment is never opened and saved from one chunk: a paste that
 * happens to hold a `c` would otherwise write to the tracker without the person ever seeing the input line, so
 * opening an input ends the chunk, and Enter saves (or asks) only when it is the whole of its chunk. `now` is the
 * clock of the time guards on a comment (the model keeps it as `now`).
 */
export function applyInput(
  start: Model,
  chunk: string,
  size: { cols: number; rows: number },
  reader?: InputReader,
  now?: number,
): Model {
  const events = reader ? reader.feed(chunk, now) : parseInput(chunk);
  return applyEvents(start, events, size, now);
}

/** The events of one chunk (or of a flush of what was held back), applied in order. */
export function applyEvents(
  start: Model,
  events: InputEvent[],
  size: { cols: number; rows: number },
  now?: number,
): Model {
  let model = now === undefined ? start : { ...start, now };
  const opened = (m: Model) => m.input !== null || m.taskInput !== null || m.taskForm !== null;
  const typing = opened(start);
  // Enter and `y` on a comment count only as the whole of their chunk: a line break that arrives with other
  // text is a paste or a burst, not a person pressing the key.
  const alone = events.length === 1;
  for (const event of events) {
    // Text the terminal marked as pasted is only ever text for an input that is already open.
    if (event.type === "paste") {
      model = pasteText(model, event.text, event.givenUp === true);
      continue;
    }
    const before = model.flow;
    model =
      event.type === "key"
        ? update(model, event.name, size, alone)
        : mouseUpdate(model, size, event);
    if (model.quit) break;
    const open = opened(model);
    if (typing && !open) break;
    if (!typing && open) break;
    // A decision moves on only by what comes back, or by a key that has seen what is on the screen:
    // the rest of a pasted chunk ("ay", "yy", "yq") must not answer a question it has not seen.
    const after = model.flow;
    if (
      after !== null &&
      (before === null ||
        after.phase !== before.phase ||
        after.at !== before.at ||
        after.scroll !== before.scroll)
    ) {
      break;
    }
  }
  return model;
}

/** The signals the screen puts the terminal back for. SIGHUP is a POSIX signal: Windows has no such thing to raise again. */
export function terminalSignals(platform: string): readonly NodeJS.Signals[] {
  return platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
}

const EXIT_CODE: Partial<Record<NodeJS.Signals, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

/** Raises the signal again once the terminal is back, where the platform can; elsewhere it ends the process with the usual code. */
export function raiseAgain(signal: NodeJS.Signals, platform: string): void {
  if (platform === "win32") {
    process.exit(EXIT_CODE[signal] ?? 1);
  } else {
    process.kill(process.pid, signal);
  }
}

export async function runTui(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  load: () => Promise<Loaded>,
  source: Model["source"],
  options: TuiOptions = {},
): Promise<number> {
  // Read before the screen is taken over, so a project that cannot be read ends with a plain error.
  let model: Model = initialModel(await load(), source, Date.now(), options.mouse === true);
  let mouseSent = false;
  const loadTasks = options.loadTasks;
  const loadTask = options.loadTask;
  if (!loadTasks || !loadTask) {
    model = withTasks(model, { status: "error", message: "Tasks cannot be read here." });
  }
  // The tasks are read apart from the runs: nothing below waits for them.
  const tasksRefresh =
    loadTasks && loadTask
      ? createTasksRefresh({
          load: loadTasks,
          loadCard: loadTask,
          onLoad: (tasks) => {
            model = withTasks(model, tasks);
            draw();
          },
          onCard: (key, slot) => {
            model = withTask(model, key, slot);
            draw();
          },
          shownKey: () => shownTask(model),
        })
      : undefined;

  // The background agents are read apart from the runs too: each read is a child process of this one,
  // and a slow one must not hold up the list. The offer of a resume is worked out from each read and
  // the state of the TUI's own decision work, and only written into the model: a key starts it.
  const workers = options.workers;
  const workersRefresh =
    workers && (options.platform ?? process.platform) !== "win32"
      ? createRefresh<WorkerRead, boolean>({
          load: async () => ({
            ok: true,
            statuses: await workers.statuses(model.sessions.map((s) => s.id)),
          }),
          loadCard: async (runId) => {
            model = withProgress(model, runId, await workers.progress(runId));
            return true;
          },
          onLoad: (read) => {
            model = read.ok
              ? withWorkers(model, read.statuses, options.work?.pending() ?? false)
              : withWorkersUnknown(model);
            draw();
          },
          onCard: () => draw(),
          shownKey: () => {
            if (model.pick.kind !== "run") return undefined;
            return model.workers[model.selected] === undefined ? undefined : model.selected;
          },
          failed: () => ({ ok: false }),
          cardFailed: () => false,
          everyMs: options.workerRefreshMs ?? WORKER_REFRESH_MS,
        })
      : undefined;

  const size = () => ({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
  // One reader for the whole session: a paste reaches the program in pieces and must be followed across them.
  const reader = createInputReader();
  // The card of a run at a human step, or of one that is going on, is read when the run is selected
  // (it asks git), one at a time. A run that is going on is read again from time to time, since it
  // changes under the person's eyes; a failed read is not retried until the selection moves.
  const reading = new Set<string>();
  const readAt = new Map<string, number>();
  const ensureDetail = (again = false) => {
    // A task in the Backlog is picked: no run is shown, so no run is read.
    const wanted =
      model.pick.kind === "task" ? undefined : model.sessions.find((x) => x.id === model.selected);
    if (!options.loadDetail || !wanted) return;
    if (wanted.need !== "approve" && wanted.status !== "running") return;
    const pick = pickedDecision(model, wanted);
    const key = detailKey(wanted, pick);
    const stale =
      wanted.status === "running" && Date.now() - (readAt.get(key) ?? 0) > DETAIL_REFRESH_MS;
    if (reading.has(key) || (!again && !stale && key in model.details)) return;
    reading.add(key);
    readAt.set(key, Date.now());
    options
      .loadDetail(wanted.id, pick)
      .then((detail) => {
        if (detail) {
          model = withDetail(model, key, detail);
          // A file that is open is read again with the card: the effect is done at once.
          flush();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        reading.delete(key);
        draw();
      });
  };
  /** What the screen asked for and cannot do itself: a diff to read, a comment to write. */
  const perform = (effect: Effect) => {
    const failed = (what: string) => (error: unknown) => {
      model = {
        ...model,
        notice: `${what}: ${error instanceof Error ? error.message : String(error)}`,
      };
    };
    if (effect.type === "load_stats") {
      const read = options.loadStats?.(effect.pipeline);
      if (!read) {
        model = withStats(model, effect.pipeline, {
          status: "failed",
          error: "not available here",
        });
        return;
      }
      read
        .then((data) => {
          model = withStats(model, effect.pipeline, { status: "ready", data });
        })
        .catch((error: unknown) => {
          // A report that was read stays on the screen when the next read fails.
          if (model.stats[effect.pipeline]?.status === "ready") return;
          model = withStats(model, effect.pipeline, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(draw);
      return;
    }
    if (effect.type === "load_task") {
      if (!(effect.key in model.tasks.cards)) {
        model = withTask(model, effect.key, { status: "loading" });
      }
      tasksRefresh?.readCard(effect.key);
      return;
    }
    if (effect.type === "add_task_comment") {
      const write = options.addTaskComment?.(effect.key, cleanComment(effect.text));
      if (!write) {
        model = { ...model, notice: "Comments cannot be written here." };
        return;
      }
      write
        .then(() => {
          model = { ...model, notice: "Comment saved." };
          // The card shows the comment as soon as it is read again.
          tasksRefresh?.readCard(effect.key);
        })
        .catch((error: unknown) => {
          model = { ...model, notice: `Could not add the comment: ${messageOf(error)}` };
        })
        .finally(draw);
      return;
    }
    if (effect.type === "create_task") {
      const create = options.createTask;
      if (!create) {
        model = withTaskCreated(model, effect.seq, {
          ok: false,
          message: "Could not create the task: tasks cannot be created here.",
        });
        return;
      }
      // Leaving the screen waits for it, as for the work of a decision: a create cut off by the exit could
      // leave the tracker half-written, and its answer would never be told.
      const pending = create(effect.input)
        .then(
          ({ key }) => ({ ok: true, key, message: `Created ${key}: ${effect.input.title}` }),
          (error: unknown) => ({
            ok: false,
            message: `Could not create the task: ${messageOf(error)}`,
          }),
        )
        .then((outcome) => {
          model = withTaskCreated(model, effect.seq, outcome);
          if (closed || leaving) told.push(outcome.message);
          // The Backlog and the Tasks screen show the new task as soon as the list is read again.
          if (outcome.ok) tasksRefresh?.openScreen(Date.now());
        })
        .finally(() => {
          creating.delete(pending);
          draw();
        });
      creating.add(pending);
      return;
    }
    if (effect.type === "prepare_start") {
      const prepare = options.prepareStart;
      if (!prepare) {
        model = withStartRefused(
          model,
          effect.seq,
          effect.key,
          "Could not start: starting is not available here.",
        );
        return;
      }
      prepare(effect.key)
        .then((check) => {
          model = check.ok
            ? withStartReady(model, effect.seq, effect.key, check.pipelines)
            : withStartRefused(model, effect.seq, effect.key, check.message);
        })
        .catch((error: unknown) => {
          model = withStartRefused(
            model,
            effect.seq,
            effect.key,
            `Could not start ${effect.key}: ${messageOf(error)}`,
          );
        })
        .finally(draw);
      return;
    }
    if (effect.type === "start_task") {
      const start = options.startTask;
      if (!start) {
        model = withStarted(model, effect.key, {
          ok: false,
          message: "Could not start: starting is not available here.",
        });
        return;
      }
      start(effect.key, effect.pipeline)
        .then(
          (outcome) => outcome,
          (error: unknown): StartResult => ({
            ok: false,
            message: `Could not start ${effect.key}: ${messageOf(error)}`,
          }),
        )
        .then((outcome) => {
          model = withStarted(model, effect.key, outcome);
          // The new run is read at once, and so are the records: the row says `agent starting` until then.
          return reload();
        })
        .finally(() => {
          workersRefresh?.openScreen(Date.now());
          draw();
        });
      return;
    }
    if (effect.type === "resume_worker") {
      const resume = options.resumeWorker;
      if (!resume) {
        model = withResumed(model, effect.runId, {
          ok: false,
          message: `run ${effect.runId} was not resumed: resuming is not available here.`,
        });
        return;
      }
      resume(effect.runId, effect.seq, model.workers[effect.runId]?.sessionId)
        .then(
          (outcome) => outcome,
          (error: unknown): StartResult => ({
            ok: false,
            message: `run ${effect.runId} was not resumed: ${messageOf(error)}`,
          }),
        )
        .then((outcome) => {
          model = withResumed(model, effect.runId, outcome);
        })
        .finally(() => {
          workersRefresh?.openScreen(Date.now());
          draw();
        });
      return;
    }
    if (effect.type === "check_decision") {
      const checking = options.checkDecision;
      if (!checking) {
        model = withCheck(model, effect.flow, { ok: false, message: "Cannot decide here." });
        return;
      }
      checking(effect.runId, effect)
        .catch(
          (error: unknown): CheckResult => ({
            ok: false,
            message: `Could not check: ${plain(error instanceof Error ? error.message : String(error))}`,
          }),
        )
        .then((result) => {
          model = withCheck(model, effect.flow, result);
          // A refusal usually means the run moved on: it is read again at once.
          if (!result.ok) return reload();
        })
        .finally(draw);
      return;
    }
    if (effect.type === "decide") {
      const writing = options.decide;
      if (!writing) {
        model = withDecided(model, effect.flow, { ok: false, message: "Cannot decide here." });
        return;
      }
      writing(effect.runId, effect)
        .catch(
          (error: unknown): DecisionOutcome => ({
            ok: false,
            message: `Not written: ${plain(error instanceof Error ? error.message : String(error))}`,
          }),
        )
        .then((outcome) => {
          model = withDecided(model, effect.flow, outcome);
          return reload();
        })
        .finally(() => {
          ensureDetail(true);
          draw();
        });
      return;
    }
    if (effect.type === "load_diff") {
      const read = options.loadDiff?.(effect.runId, effect.path);
      if (!read) return;
      read
        .then((diff) => {
          model = withDiff(model, diffKey(effect.runId, effect.path), diff);
        })
        .catch(failed("Cannot read the diff"))
        .finally(draw);
      return;
    }
    const write =
      effect.type === "add_comment"
        ? options.addComment?.(effect.runId, effect.node, effect.attempt, effect.comment)
        : options.deleteComment?.(effect.runId, effect.node, effect.attempt, effect.index);
    if (!write) {
      model = { ...model, notice: "Comments cannot be written here." };
      return;
    }
    write
      .then(() => {
        model = {
          ...model,
          notice: effect.type === "add_comment" ? "Comment saved." : "Comment deleted.",
        };
        ensureDetail(true);
      })
      .catch(failed("Could not change the comments"))
      .finally(draw);
  };
  // Several reads can be in flight (the timer's, one after a decision): the latest to start wins.
  let loadSeq = 0;
  const reload = (): Promise<void> => {
    const mine = ++loadSeq;
    return load()
      .then((loaded) => {
        if (mine === loadSeq) model = withData(model, loaded, Date.now());
      })
      .catch((error: unknown) => {
        model = {
          ...model,
          notice: `Cannot read the runs: ${error instanceof Error ? error.message : String(error)}`,
        };
      });
  };
  const flush = () => {
    const [clean, effects] = takeEffects(model);
    model = clean;
    for (const effect of effects) perform(effect);
  };
  // Set when the screen is given back: an answer that comes later (a tasks read, a write) must not draw on the shell.
  let closed = false;
  // The creates of tasks that are out, and what the ones that answered while the screen was being left (or
  // after) have to say: a frame drawn right before the exit is not read, so it is said on the shell instead.
  const creating = new Set<Promise<void>>();
  const told: string[] = [];
  let leaving = false;
  const draw = () => {
    if (closed) return;
    if (model.mouse !== mouseSent) {
      stdout.write(model.mouse ? MOUSE_ON : MOUSE_OFF);
      mouseSent = model.mouse;
    }
    // The screens make their lines safe as they fit them; this is the last look before the terminal.
    const lines = render(model, size()).map(neutralize);
    stdout.write(lines.map((line, i) => `\u001b[${i + 1};1H${line}`).join(""));
  };
  // Always turned off on the way out, whatever was sent: a terminal left reporting the mouse
  // fills the person's shell with escape codes.
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    closed = true;
    stdout.write(`${MOUSE_OFF}${PASTE_OFF}\u001b[?25h\u001b[?1049l`);
    if (stdin.isTTY) stdin.setRawMode(false);
  };

  stdout.write(`\u001b[?1049h\u001b[?25l\u001b[2J${PASTE_ON}`);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  process.once("exit", restore);
  // A signal that ends the process does not run the `exit` handler's work for us in every case (SIGTERM and
  // SIGHUP kill it outright), so the terminal is put back first and the signal is raised again. The tty may be gone
  // (a hangup), so a failing restore must not stop the signal from being raised.
  const SIGNALS = terminalSignals(process.platform);
  const onSignal = (signal: NodeJS.Signals) => {
    try {
      restore();
    } finally {
      for (const name of SIGNALS) process.off(name, onSignal);
      raiseAgain(signal, process.platform);
    }
  };
  for (const name of SIGNALS) process.on(name, onSignal);

  return await new Promise<number>((resolve) => {
    let refreshing = false;
    const frames = setInterval(() => {
      // A paste that never ended is given up, and its dropped rest ends, with the clock and not only with the next
      // key: what the paste held so far then appears in the input without a keypress.
      const late = reader.flush(Date.now());
      if (late.length > 0) handle(late);
      tasksRefresh?.tick(Date.now());
      workersRefresh?.tick(Date.now());
      model = tick(model, Date.now());
      if (isAnimated(model)) draw();
    }, FRAME_MS);
    const refresh = setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      reload().finally(() => {
        refreshing = false;
        ensureDetail();
        draw();
      });
    }, options.refreshMs ?? REFRESH_MS);

    const statsRefresh = setInterval(() => {
      if (model.section === 3 && model.rep.selected !== "") {
        perform({ type: "load_stats", pipeline: model.rep.selected });
      }
    }, STATS_REFRESH_MS);

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(frames);
      clearInterval(refresh);
      clearInterval(statsRefresh);
      if (holdTimer) clearTimeout(holdTimer);
      for (const name of SIGNALS) process.off(name, onSignal);
      stdin.off("data", onData);
      stdout.off("resize", onResize);
      stdin.pause();
      try {
        restore();
      } finally {
        process.off("exit", restore);
        resolve(0);
      }
    };
    // Leaving while a decision's work goes on, or while a task is being created: the screen stays for it,
    // and a second request to leave stops the work (the step is then started again by whoever asks next)
    // and leaves the create to the tracker: its answer comes to no screen, so the notice says so.
    let stopRequested: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      stopRequested = resolve;
    });
    const leave = async () => {
      const work = options.work?.pending() ? options.work : undefined;
      if (work === undefined && creating.size === 0) {
        finish();
        return;
      }
      leaving = true;
      model = {
        ...model,
        quit: false,
        flow: null,
        notice:
          work === undefined
            ? "Finishing creating the task… q again to leave now (the task may then not be created, and you will not be told)."
            : `Finishing the work of the run (it may grow while waiting)${creating.size > 0 ? " and the task being created" : ""}. q again stops it; the step is then started again by the next caller${creating.size > 0 ? ", and whether the task was created is not told" : ""}.`,
      };
      draw();
      const outcome = await Promise.race([
        Promise.allSettled([...(work === undefined ? [] : [work.wait()]), ...creating]).then(
          () => "done" as const,
        ),
        stopped.then(() => "stop" as const),
      ]);
      if (outcome === "stop" && work !== undefined) await work.stop().catch(() => undefined);
      finish();
      // The screen is back to the shell: what a create answered while the person waited is said there.
      for (const line of told) stdout.write(`${line}\n`);
    };
    const handle = (events: InputEvent[]) => {
      if (finished) return;
      // While the screen waits for the work of a decision, a second q (or Ctrl-C) is what stops it.
      if (leaving) {
        const again = events.some(
          (e) => e.type === "key" && (e.name === "q" || e.name === "ctrl-c"),
        );
        if (again) stopRequested();
        return;
      }
      const before = model.selected;
      const sectionBefore = model.section;
      model = applyEvents(model, events, size(), Date.now());
      if (model.section === 2 && sectionBefore !== 2) tasksRefresh?.openScreen(Date.now());
      if (model.quit) {
        void leave();
        return;
      }
      flush();
      ensureDetail(model.selected !== before);
      // The digest is read for the selected run only: a new selection with a worker is read at once.
      if (model.selected !== before && model.pick.kind === "run" && model.workers[model.selected]) {
        workersRefresh?.readCard(model.selected);
      }
      draw();
    };
    // The end of a chunk that may start a paste marker (a lone ESC) is held back; if nothing continues it, it
    // is the Escape key, and this timer is what delivers it.
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    const onData = (chunk: string) => {
      if (finished) return;
      if (holdTimer) clearTimeout(holdTimer);
      handle(reader.feed(chunk, Date.now()));
      if (finished) return;
      holdTimer = setTimeout(() => {
        const late = reader.flush(Date.now());
        if (late.length > 0) handle(late);
      }, HOLD_MS + 10);
    };
    const onResize = () => {
      stdout.write("\u001b[2J");
      draw();
    };
    stdin.on("data", onData);
    stdout.on("resize", onResize);
    tasksRefresh?.start(Date.now());
    workersRefresh?.start(Date.now());
    ensureDetail();
    draw();
  });
}
