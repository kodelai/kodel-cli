import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { stripAnsi } from "../src/tui/ansi";
import { demoGateDetail, demoRunningDetail, demoSessions } from "../src/tui/demo";
import { MOUSE_OFF, MOUSE_ON, PASTE_OFF, PASTE_ON } from "../src/tui/input";
import {
  type AttachedChild,
  HANDOVER_DROP_MS,
  handoverScreen,
  raiseAgain,
  runTui,
  type TuiOptions,
  terminalSignals,
} from "../src/tui/run";
import { type AttachExit, BUILT_KODEL, createOpenWorker } from "../src/tui/worker-open";
import type { WorkerStatus } from "../src/worker-launcher";
import { FakeLauncher } from "./fake-launcher";

const BASE = Date.UTC(2026, 9, 27, 15, 0, 0);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A terminal that keeps what is written to it and lets a test type. */
function terminal(cols = 120, rows = 32) {
  const written: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => undefined,
    setEncoding: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
  });
  const stdout = Object.assign(new EventEmitter(), {
    columns: cols,
    rows,
    write: (text: string) => {
      written.push(text);
      return true;
    },
  });
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    type: (input: string) => stdin.emit("data", input),
    /** Everything written since `mark`, without the colors. */
    since: (mark = 0) => stripAnsi(written.slice(mark).join("")),
    mark: () => written.length,
    raw: () => written.join(""),
  };
}

const start = (t: ReturnType<typeof terminal>, mouse = false) =>
  runTui(t.stdin, t.stdout, async () => demoSessions(BASE), "demo", {
    mouse,
    loadDetail: async (id) => demoGateDetail(id, BASE) ?? demoRunningDetail(id, BASE),
  });

describe("tui loop", () => {
  test("it opens on the list, reads the card of the run it stops on, and leaves the screen as it found it", async () => {
    const t = terminal();
    const done = start(t);
    await wait(60);
    expect(t.since()).toContain("WAITING FOR YOU");
    expect(t.raw().startsWith("\u001b[?1049h")).toBe(true);
    expect(t.raw()).toContain(PASTE_ON);

    // The newest run that waits is the one that needs an approval, and it is the one selected.
    await wait(80);
    const card = t.since();
    expect(card).toContain("Report");
    // The Report tab opens on the agent's answer; the question is further down the card.
    expect(card).toContain("THE AGENT'S ANSWER");

    t.type("q");
    expect(await done).toBe(0);
    expect(t.raw().endsWith(`${MOUSE_OFF}${PASTE_OFF}\u001b[?25h\u001b[?1049l`)).toBe(true);
  });

  test("Enter, the tabs, a step and Esc work through the real input path", async () => {
    const t = terminal();
    const done = start(t);
    await wait(60);
    await wait(80);

    let mark = t.mark();
    t.type("\r");
    expect(t.since(mark)).toContain("┃");

    mark = t.mark();
    t.type("\t"); // Code
    t.type("\t"); // Steps
    expect(t.since(mark)).toContain("10 entries into steps · Enter opens one");

    mark = t.mark();
    t.type("\u001b[B\u001b[B\u001b[B\u001b[B\u001b[B"); // five keys in one chunk are all heard: down to the first test
    t.type("\r");
    expect(t.since(mark)).toContain("Steps › test");
    expect(t.since(mark)).toContain("1 test failed");

    mark = t.mark();
    t.type("\u001b"); // back to the steps: a lone ESC is held a moment, in case a paste marker follows
    await wait(110);
    expect(t.since(mark)).toContain("10 entries into steps · Enter opens one");

    mark = t.mark();
    t.type("z");
    expect(t.since(mark)).not.toContain("WAITING FOR YOU");
    t.type("q");
    await done;
  });

  test("the mouse is asked for only when it is on, and always turned off on the way out", async () => {
    const off = terminal();
    const offDone = start(off, false);
    await wait(60);
    expect(off.raw()).not.toContain(MOUSE_ON);
    off.type("m");
    expect(off.raw()).toContain(MOUSE_ON);
    off.type("q");
    await offDone;
    expect(off.raw()).toContain(MOUSE_OFF);

    const on = terminal();
    const onDone = start(on, true);
    await wait(60);
    expect(on.raw()).toContain(MOUSE_ON);
    on.type("q");
    await onDone;
    expect(on.raw().lastIndexOf(MOUSE_OFF)).toBeGreaterThan(on.raw().lastIndexOf(MOUSE_ON));
  });

  test("a click on a tab and the wheel are heard when the mouse is on", async () => {
    const t = terminal();
    const done = start(t, true);
    await wait(140);
    // The screen is drawn row by row with a cursor move before each; find the row of the tabs.
    const rowText = (n: number) =>
      (t.since().split(`\u001b[${n};1H`).at(-1) ?? "").split("\u001b[")[0] ?? "";
    const y =
      [3, 4, 5, 6, 7, 8, 9, 10].find(
        (n) => rowText(n).includes("Report") && rowText(n).includes("Comments"),
      ) ?? 0;
    expect(y).toBeGreaterThan(0);
    const x = rowText(y).indexOf("Steps") + 2;
    const mark = t.mark();
    t.type(`\u001b[<0;${x};${y}M`);
    expect(t.since(mark)).toContain("entries into steps");
    t.type("q");
    await done;
  });

  test("a run that is going on has its card read when it is selected", async () => {
    const t = terminal();
    const done = start(t);
    await wait(60);
    // four runs wait before the running ones, the newest of which is the first of them
    t.type("\u001b[B\u001b[B\u001b[B\u001b[B\u001b[B");
    await wait(120);
    const out = t.since();
    expect(out).toContain("running · checks · step 3 of 4");
    expect(out).toMatch(/Steps 4\]?\s+Code 3\s+Log 8/);
    t.type("q");
    await done;
  });

  test("a read that fails does not stop the screen", async () => {
    const t = terminal();
    let reads = 0;
    const done = runTui(
      t.stdin,
      t.stdout,
      async () => {
        reads++;
        return demoSessions(BASE);
      },
      "demo",
      {
        loadDetail: async () => {
          throw new Error("git is gone");
        },
      },
    );
    await wait(60);
    t.type("\u001b[B\u001b[B\u001b[B");
    await wait(80);
    expect(t.since()).toContain("Reading the details…");
    t.type("q");
    expect(await done).toBe(0);
    expect(reads).toBeGreaterThan(0);
  });
});

describe("task_g4jy_tui_loop_reads_tasks_apart_from_runs", () => {
  test("task_g4jy_tui_loop_reads_tasks_apart_from_runs: the first paint does not wait, the answer lands, the Tasks screen opens", async () => {
    const { demoTaskCard, demoTasks } = await import("../src/tui/demo-tasks");
    const t = terminal();
    const done = runTui(t.stdin, t.stdout, async () => demoSessions(BASE), "demo", {
      loadDetail: async (id) => demoGateDetail(id, BASE) ?? demoRunningDetail(id, BASE),
      // A tracker that answers slowly.
      loadTasks: async () => {
        await wait(120);
        return demoTasks();
      },
      loadTask: async (key) => demoTaskCard(key, BASE),
    });
    await wait(60);
    const first = t.since();
    expect(first).toContain("WAITING FOR YOU");
    expect(first).toContain("reading tasks…");
    await wait(160);
    expect(t.since()).toContain("BACKLOG · 5 of 7");
    const mark = t.mark();
    t.type("3");
    await wait(60);
    const tasks = t.since(mark);
    expect(tasks).toContain("TODO · 8");
    expect(tasks).toContain("KDL-C3M2");
    t.type("q");
    expect(await done).toBe(0);
  });

  test("task_g4jy_tui_loop_reads_tasks_apart_from_runs: a host that cannot read tasks says so and the runs work", async () => {
    const t = terminal();
    const done = start(t);
    await wait(80);
    expect(t.since()).toContain("Cannot read the tasks: Tasks cannot be read");
    expect(t.since()).toContain("WAITING FOR YOU");
    t.type("q");
    expect(await done).toBe(0);
  });
});

describe("task_g4jy_tui_loop_writes_a_task_comment", () => {
  /** The demo tasks with the writer a test gives; `undefined` leaves the writer out. */
  async function startWith(
    t: ReturnType<typeof terminal>,
    write: ((key: string, text: string) => Promise<void>) | undefined,
  ) {
    const { tuiTaskOptions } = await import("../src/tui/tasks-open");
    const demo = tuiTaskOptions("demo", BASE);
    return runTui(t.stdin, t.stdout, async () => demoSessions(BASE), "demo", {
      loadDetail: async (id) => demoGateDetail(id, BASE) ?? demoRunningDetail(id, BASE),
      loadTasks: demo.loadTasks,
      loadTask: demo.loadTask,
      ...(write === undefined ? {} : { addTaskComment: write }),
    });
  }

  test("task_g4jy_tui_loop_writes_a_task_comment: it is saved, told, and the card is read again", async () => {
    const { tuiTaskOptions } = await import("../src/tui/tasks-open");
    const options = tuiTaskOptions("demo", BASE);
    const t = terminal();
    const sent: [string, string][] = [];
    const done = runTui(t.stdin, t.stdout, async () => demoSessions(BASE), "demo", {
      loadDetail: async (id) => demoGateDetail(id, BASE) ?? demoRunningDetail(id, BASE),
      loadTasks: options.loadTasks,
      loadTask: options.loadTask,
      addTaskComment: async (key, text) => {
        sent.push([key, text]);
        await options.addTaskComment?.(key, text);
      },
    });
    await wait(60);
    t.type("3");
    await wait(60);
    t.type("\r");
    t.type("c");
    t.type("hello there");
    await wait(450);
    t.type("\r");
    await wait(450);
    expect(sent).toEqual([]);
    expect(t.since()).toContain("Save this comment to KDL-2K9M?");
    t.type("y");
    await wait(120);
    expect(sent).toEqual([["KDL-2K9M", "hello there"]]);
    const text = t.since();
    expect(text).toContain("Comment saved.");
    expect(text).toContain("hello there");
    t.type("q");
    expect(await done).toBe(0);
  });

  test("task_g4jy_tui_loop_writes_a_task_comment: a refusal is told with the words of the tracker", async () => {
    const t = terminal();
    const done = startWith(t, async () => {
      throw new Error("the task is closed");
    });
    await wait(60);
    t.type("3");
    await wait(60);
    t.type("\r");
    t.type("c");
    t.type("x");
    await wait(450);
    t.type("\r");
    await wait(450);
    t.type("y");
    await wait(80);
    expect(t.since()).toContain("Could not add the comment: the task is closed");
    t.type("q");
    expect(await done).toBe(0);
  });

  test("task_g4jy_tui_loop_writes_a_task_comment: a host with no writer says so", async () => {
    const t = terminal();
    const done = startWith(t, undefined);
    await wait(60);
    t.type("3");
    await wait(60);
    t.type("\r");
    t.type("c");
    t.type("x");
    await wait(450);
    t.type("\r");
    await wait(450);
    t.type("y");
    await wait(60);
    expect(t.since()).toContain("Comments cannot be written here.");
    t.type("q");
    expect(await done).toBe(0);
  });
});

describe("task_g4jy_bracketed_paste_is_on_while_the_screen_is_open", () => {
  test("task_g4jy_paste_mode_is_turned_off_when_the_person_quits", async () => {
    const t = terminal();
    const done = start(t);
    await wait(60);
    expect(t.raw()).toContain(PASTE_ON);
    expect(t.raw()).not.toContain(PASTE_OFF);
    t.type("q");
    expect(await done).toBe(0);
    expect(t.raw().lastIndexOf(PASTE_OFF)).toBeGreaterThan(t.raw().lastIndexOf(PASTE_ON));
  });

  test("task_g4jy_paste_mode_is_turned_off_on_ctrl_c", async () => {
    const t = terminal();
    const done = start(t);
    await wait(60);
    t.type("\u0003");
    expect(await done).toBe(0);
    expect(t.raw().lastIndexOf(PASTE_OFF)).toBeGreaterThan(t.raw().lastIndexOf(PASTE_ON));
  });

  test("task_g4jy_a_bracketed_paste_in_the_loop_is_not_read_as_keys", async () => {
    const t = terminal();
    const done = start(t);
    await wait(60);
    t.type("\u001b[200~q");
    t.type("qqq 4 m\r");
    t.type("\u001b[201~");
    await wait(60);
    // Still running: the pasted q's did not quit, and the mouse stayed off.
    expect(t.raw()).not.toContain(MOUSE_ON);
    t.type("q");
    expect(await done).toBe(0);
  });
});

describe("task_g4jy_the_terminal_is_put_back_on_a_signal", () => {
  /** A signal handler of the loop is run without killing the test process: `process.kill` is a stub meanwhile. */
  const withKillStub = async (
    work: (kills: [number, string | number | undefined][]) => Promise<void>,
  ) => {
    const original = process.kill;
    const kills: [number, string | number | undefined][] = [];
    process.kill = ((pid: number, signal?: string | number) => {
      kills.push([pid, signal]);
      return true;
    }) as typeof process.kill;
    try {
      await work(kills);
    } finally {
      process.kill = original;
    }
  };

  test("task_g4jy_sigterm_sighup_and_sigint_restore_the_screen_and_raise_the_signal_again", async () => {
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
      await withKillStub(async (kills) => {
        const before = process.listenerCount(signal);
        const t = terminal();
        const done = start(t, true);
        await wait(60);
        expect(process.listenerCount(signal)).toBe(before + 1);
        process.emit(signal, signal);
        expect(t.raw().endsWith(`${MOUSE_OFF}${PASTE_OFF}\u001b[?25h\u001b[?1049l`)).toBe(true);
        expect(kills).toEqual([[process.pid, signal]]);
        // The handlers are gone, so the raised signal takes its default course.
        expect(process.listenerCount(signal)).toBe(before);
        t.type("q");
        expect(await done).toBe(0);
      });
    }
  });

  test("task_g4jy_the_signal_handlers_are_removed_when_the_person_quits", async () => {
    const before = ["SIGTERM", "SIGHUP", "SIGINT"].map((s) => process.listenerCount(s));
    const t = terminal();
    const done = start(t);
    await wait(60);
    t.type("q");
    await done;
    expect(["SIGTERM", "SIGHUP", "SIGINT"].map((s) => process.listenerCount(s))).toEqual(before);
  });
});

describe("task_g4jy_a_lone_escape_is_held_a_moment_in_the_loop", () => {
  test("task_g4jy_a_cut_paste_marker_does_not_press_escape_in_the_loop", async () => {
    const t = terminal();
    const done = start(t);
    await wait(60);
    await wait(80);
    t.type("\r"); // the card has the focus
    t.type("\u001b"); // a lone ESC, with the rest of a paste marker right behind it
    t.type("[200~pasted\u001b[201~");
    await wait(110);
    // The card still has the focus: that ESC was not the Escape key.
    const mark = t.mark();
    t.type("\t");
    expect(t.since(mark)).toContain("┃");
    t.type("q");
    expect(await done).toBe(0);
  });
});

describe("task_g4jy_the_end_of_the_loop_is_safe", () => {
  test("task_g4jy_a_signal_is_raised_again_even_when_the_terminal_cannot_be_restored", async () => {
    const original = process.kill;
    const kills: [number, string | number | undefined][] = [];
    process.kill = ((pid: number, signal?: string | number) => {
      kills.push([pid, signal]);
      return true;
    }) as typeof process.kill;
    try {
      const t = terminal();
      const done = start(t);
      await wait(60);
      // The tty is gone (a hangup): turning raw mode off throws.
      Object.assign(t.stdin, {
        setRawMode: (on: boolean) => {
          if (!on) throw new Error("tty gone");
        },
      });
      const before = process.listenerCount("SIGHUP");
      expect(() => process.emit("SIGHUP", "SIGHUP")).toThrow("tty gone");
      expect(kills).toEqual([[process.pid, "SIGHUP"]]);
      expect(process.listenerCount("SIGHUP")).toBe(before - 1);
      t.type("q");
      expect(await done).toBe(0);
    } finally {
      process.kill = original;
    }
  });

  test("task_g4jy_windows_has_no_sighup_handler_and_ends_with_the_usual_code", () => {
    expect(terminalSignals("win32")).toEqual(["SIGINT", "SIGTERM"]);
    expect(terminalSignals("linux")).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    const killed: unknown[] = [];
    const exited: unknown[] = [];
    const kill = process.kill;
    const exit = process.exit;
    process.kill = ((...args: unknown[]) => killed.push(args)) as unknown as typeof process.kill;
    process.exit = ((code?: number) => exited.push(code)) as unknown as typeof process.exit;
    try {
      raiseAgain("SIGTERM", "win32");
      raiseAgain("SIGINT", "win32");
    } finally {
      process.kill = kill;
      process.exit = exit;
    }
    expect(killed).toEqual([]);
    expect(exited).toEqual([143, 130]);
  });

  test("task_g4jy_q_followed_by_a_held_escape_finishes_once", async () => {
    const exitBefore = process.listenerCount("exit");
    const t = terminal();
    const done = start(t);
    await wait(60);
    t.type("q\u001b");
    expect(await done).toBe(0);
    // The held ESC would have been delivered to a model that already quit, finishing it a second time.
    await wait(150);
    expect(t.raw().split(PASTE_OFF).length - 1).toBe(1);
    expect(process.listenerCount("exit")).toBe(exitBefore);
  });

  test("task_g4jy_a_late_tasks_answer_does_not_draw_after_the_screen_is_given_back", async () => {
    const t = terminal();
    const done = runTui(t.stdin, t.stdout, async () => demoSessions(BASE), "demo", {
      loadDetail: async (id) => demoGateDetail(id, BASE) ?? demoRunningDetail(id, BASE),
      loadTasks: () => new Promise((resolve) => setTimeout(() => resolve({ status: "off" }), 150)),
      loadTask: async () => ({ status: "loading" }),
    });
    await wait(60);
    t.type("q");
    expect(await done).toBe(0);
    const mark = t.mark();
    await wait(300);
    expect(t.since(mark)).toBe("");
  });
});

// ── `o`: the terminal goes to the agent and comes back (TASK-EKAV, T-47) ─────

const SCREEN_OFF = `${MOUSE_OFF}${PASTE_OFF}\u001b[?25h\u001b[?1049l`;
const SCREEN_ON = `\u001b[?1049h\u001b[?25l\u001b[2J${PASTE_ON}`;
const ALT_OFF = "\u001b[?1049l";
const ALT_ON = "\u001b[?1049h";
/** How often a text is in another. */
const count = (text: string, part: string) => text.split(part).length - 1;
const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;

/** A terminal that also keeps the order of what is done to it. */
function tty(cols = 200, rows = 30) {
  const log: string[] = [];
  const written: string[] = [];
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: (on: boolean) => {
      log.push(`raw ${on ? "on" : "off"}`);
    },
    setEncoding: () => undefined,
    resume: () => {
      log.push("resume");
    },
    pause: () => {
      log.push("pause");
    },
  });
  const output = Object.assign(new EventEmitter(), {
    columns: cols,
    rows,
    write: (text: string) => {
      written.push(text);
      log.push(`write ${text}`);
      return true;
    },
  });
  /** The lines of the last whole frame drawn, without colours and with the spinner stilled. */
  const frame = (): string[] => {
    const raw = written.join("");
    return (
      raw
        .slice(raw.lastIndexOf("\u001b[1;1H"))
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the cursor move before each row
        .split(/\u001b\[\d+;1H/)
        .slice(1)
        .map((line) => stripAnsi(line).replace(SPINNER, "*"))
    );
  };
  return {
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: output as unknown as NodeJS.WriteStream,
    input,
    output,
    log,
    type: (text: string) => input.emit("data", text),
    mark: () => written.length,
    raw: (mark = 0) => written.slice(mark).join(""),
    frame,
    /** Where the screen is: everything but the bottom line, which holds the keys or the notice. */
    place: () => frame().slice(0, -1),
    notice: () => frame().at(-1) ?? "",
  };
}

/** A child that has the terminal until the test ends it. */
function fakeChild() {
  const signals: string[] = [];
  let back: (notice: string) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const done = new Promise<string>((resolve, reject) => {
    back = resolve;
    fail = reject;
  });
  const child: AttachedChild = {
    done,
    signal: (signal) => {
      signals.push(signal);
    },
  };
  return { child, signals, back: (notice: string) => back(notice), fail: (e: Error) => fail(e) };
}

const terminalWorker = (runId: string, over: Partial<WorkerStatus> = {}): WorkerStatus => ({
  id: `a_${runId.slice(2)}_fake`,
  name: `kw-${runId}`,
  state: "running",
  label: "running",
  started: BASE,
  resumed: [],
  resumes: 0,
  terminal: true,
  ...over,
});

/**
 * The loop over the sample runs as a project's, each of the first three with an agent in a terminal of its
 * own, and an `openWorker` that hands out fake children.
 */
function opened(over: Partial<TuiOptions> = {}, size?: { cols: number; rows: number }) {
  const t = size === undefined ? tty() : tty(size.cols, size.rows);
  const sessions = [...demoSessions(BASE).sessions];
  const launcher = new FakeLauncher();
  for (const s of sessions.slice(0, 3)) {
    launcher.statusMap.set(s.id, terminalWorker(s.id));
    launcher.progressMap.set(s.id, { lines: ["> working on it"] });
  }
  const children: ReturnType<typeof fakeChild>[] = [];
  const asked: [string, string][] = [];
  const loads: number[] = [];
  let finished = false;
  const done = runTui(
    t.stdin,
    t.stdout,
    async () => {
      loads.push(Date.now());
      return { sessions: [...sessions], proposals: 0 };
    },
    "project",
    {
      refreshMs: 40,
      workerRefreshMs: 30,
      handoverDropMs: 30,
      loadDetail: async (id) => demoGateDetail(id, BASE) ?? demoRunningDetail(id, BASE),
      workers: {
        statuses: (ids) => launcher.statuses(ids),
        progress: (id) => launcher.progress(id),
      },
      openWorker: async (runId, id) => {
        asked.push([runId, id]);
        const next = fakeChild();
        children.push(next);
        return { ok: true, attach: () => next.child };
      },
      ...over,
    },
  ).then((code) => {
    finished = true;
    return code;
  });
  const last = () => {
    const child = children.at(-1);
    if (child === undefined) throw new Error("no child was started");
    return child;
  };
  return {
    t,
    sessions,
    launcher,
    children,
    asked,
    loads,
    done,
    last,
    finished: () => finished,
    /** Types the keys one by one, as a person does, and waits for the reads they start. */
    keys: async (...keys: string[]) => {
      for (const key of keys) {
        t.type(key);
        await wait(30);
      }
      await wait(120);
    },
    /** `o`, and the moment the loop needs to ask and leave. */
    open: async () => {
      t.type("o");
      await wait(40);
    },
    /** The child ends with this notice; the wait covers the dropped input and the reload. */
    back: async (notice: string) => {
      last().back(notice);
      await wait(200);
    },
    quit: async () => {
      t.type("q");
      return done;
    },
  };
}

/** The first line of the card: the glyph and the title of the run it shows. */
const cardTitle = (lines: string[]) => (lines[2] ?? "").split(/[┃│]/)[1]?.trim() ?? "";

/** A signal handler of the loop is run without killing the test process: `process.kill` is a stub meanwhile. */
async function killStub(
  work: (kills: [number, string | number | undefined][]) => Promise<void>,
): Promise<void> {
  const original = process.kill;
  const kills: [number, string | number | undefined][] = [];
  process.kill = ((pid: number, signal?: string | number) => {
    kills.push([pid, signal]);
    return true;
  }) as typeof process.kill;
  try {
    await work(kills);
  } finally {
    process.kill = original;
  }
}

describe("t47 the screen hands its terminal to an agent and takes it back", () => {
  test("t47_tui_returns_to_the_same_place", async () => {
    const table: { name: string; keys: string[]; mouse?: true }[] = [
      { name: "from the list, on the second run", keys: ["j"] },
      { name: "from an open card scrolled down", keys: ["j", "\r", " "] },
      { name: "from a card on another tab", keys: ["\r", "\u001b[C"] },
      { name: "from a zoomed card with the mouse on", keys: ["j", "\r", "z", "m"], mouse: true },
    ];
    for (const row of table) {
      const loop = opened();
      await wait(150);
      await loop.keys(...row.keys);
      const before = loop.t.place();
      const loadsBefore = loop.loads.length;
      const mark = loop.t.mark();
      await loop.open();
      // One child, for the selected run's record. The alternate screen is kept for it, cleared, with
      // one line that names the agent: the shell behind is not shown while the child comes up.
      const selected = row.keys.filter((k) => k === "j").length;
      const run = loop.sessions[selected]?.id ?? "";
      expect(loop.asked, row.name).toEqual([[run, `a_${run.slice(2)}_fake`]]);
      expect(loop.t.raw(mark).endsWith(handoverScreen(`kw-${run}`)), row.name).toBe(true);
      expect(loop.t.raw(mark), row.name).not.toContain(ALT_OFF);
      const away = loop.t.mark();
      await loop.back("Back from the agent · > working on it");
      // The same screen and tab, the same run, card and scroll: only the notice and the data are new.
      expect(loop.t.place(), row.name).toEqual(before);
      expect(loop.t.notice(), row.name).toContain("Back from the agent · > working on it");
      expect(loop.loads.length, row.name).toBeGreaterThan(loadsBefore);
      const since = loop.t.raw(away);
      expect(since.startsWith(SCREEN_ON), row.name).toBe(true);
      expect(since.includes(MOUSE_ON), row.name).toBe(row.mouse === true);
      // From `o` to the redraw the alternate screen was never left: the shell was not seen.
      expect(loop.t.raw(mark), row.name).not.toContain(ALT_OFF);
      // The keys are the screen's again.
      expect(await loop.quit(), row.name).toBe(0);
      expect(loop.t.raw().endsWith(SCREEN_OFF), row.name).toBe(true);
      // The alternate screen is left once, at the very end.
      expect(count(loop.t.raw(), ALT_OFF), row.name).toBe(1);
    }
  });

  test("t47_tui_same_place_when_the_agent_ended", async () => {
    // The agent ended while the person was in it: the child ends by itself, with its own notice.
    const ended = opened();
    await wait(150);
    await ended.keys("j", "\r", " ");
    const before = ended.t.place();
    await ended.open();
    await ended.back("Back: agent kw-x ended while you were in it (exited (0)).");
    expect(ended.t.place()).toEqual(before);
    expect(ended.t.notice()).toContain("ended while you were in it (exited (0))");
    expect(await ended.quit()).toBe(0);

    // The child exits with an error: the same place, and the notice says so.
    const failed = opened();
    await wait(150);
    await failed.keys("j", "\r", " ");
    const place = failed.t.place();
    await failed.open();
    failed.last().fail(new Error("the attach ended with code 1"));
    await wait(200);
    expect(failed.t.place()).toEqual(place);
    expect(failed.t.notice()).toContain("Could not open the agent: the attach ended with code 1");
    // And `o` opens it again: one child at a time, a second one after the first is gone.
    await failed.open();
    expect(failed.children.length).toBe(2);
    await failed.back("Back from the agent.");
    expect(failed.t.place()).toEqual(place);
    expect(await failed.quit()).toBe(0);

    // The words of the real opener for an agent that ended, and for one that still runs.
    const launcher = new FakeLauncher();
    launcher.statusMap.set("r_1", terminalWorker("r_1"));
    launcher.progressMap.set("r_1", { lines: ["> one", "> the last line"] });
    const exits: ((end: AttachExit) => void)[] = [];
    const open = createOpenWorker({
      launcher,
      platform: "darwin",
      bun: false,
      self: { exec: "/usr/local/bin/node", args: ["/opt/kodel/dist/kodel.js"] },
      root: "/proj",
      environment: {},
      runnable: async () => undefined,
      spawn: () => ({
        exited: new Promise<AttachExit>((resolve) => exits.push(resolve)),
        kill: () => undefined,
      }),
    });
    const attach = async () => {
      const opening = await open("r_1", "a_1_fake");
      if (!opening.ok) throw new Error(opening.message);
      return opening.attach();
    };
    const detached = await attach();
    exits.at(-1)?.({ code: 0, signal: null });
    expect(await detached.done).toBe("Back from kw-r_1 · > the last line");
    const gone = await attach();
    launcher.exited("r_1", BASE + 5_000);
    exits.at(-1)?.({ code: 0, signal: null });
    expect(await gone.done).toBe(
      "Back: agent kw-r_1 ended while you were in it (exited (0)). An agent that ended at a wait is resumed after your decision; one you stop with kodel agent stop is resumed only by s here.",
    );
  });

  test("t47_tui_child_that_cannot_start_leaves_the_screen_alone", async () => {
    let spawned = 0;
    const launcher = new FakeLauncher();
    const loop = opened({
      openWorker: createOpenWorker({
        launcher,
        platform: "darwin",
        bun: false,
        self: { exec: "/usr/local/bin/node", args: ["/opt/kodel/dist/kodel.js"] },
        root: "/proj",
        environment: {},
        runnable: async () => "spawn /usr/local/bin/node ENOENT",
        spawn: () => {
          spawned += 1;
          throw new Error("never asked");
        },
      }),
    });
    for (const [id, status] of loop.launcher.statusMap) launcher.statusMap.set(id, status);
    await wait(150);
    await loop.keys("j", "\r", " ");
    const before = loop.t.place();
    const mark = loop.t.mark();
    await loop.open();
    await wait(100);
    // The screen was not left: nothing of the terminal's modes was touched, and the notice says why.
    expect(loop.t.raw(mark)).not.toContain("\u001b[?1049l");
    expect(loop.t.raw(mark)).not.toContain("\u001b[?1049h");
    expect(loop.t.log.filter((l) => l === "raw off")).toEqual([]);
    expect(spawned).toBe(0);
    expect(loop.t.place()).toEqual(before);
    expect(loop.t.notice()).toContain("Could not open the agent: spawn /usr/local/bin/node ENOENT");
    expect(await loop.quit()).toBe(0);

    // The check the build makes when none is given: a program that is not there.
    const missing = createOpenWorker({
      launcher,
      platform: "darwin",
      bun: false,
      self: { exec: "/nonexistent/kodel-test/node", args: ["/nonexistent/kodel-test/kodel.js"] },
      root: "/proj",
      environment: {},
      spawn: () => {
        spawned += 1;
        throw new Error("never asked");
      },
    });
    const run = loop.sessions[0]?.id ?? "";
    const answer = await missing(run, "a_x");
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.message).toContain("ENOENT");
    expect(spawned).toBe(0);

    // A start that fails after the screen was left brings it back at once, with the reason.
    const thrown = opened({
      openWorker: async () => ({
        ok: true,
        attach: () => {
          throw new Error("spawn EAGAIN");
        },
      }),
    });
    await wait(150);
    await thrown.keys("j");
    const place = thrown.t.place();
    await thrown.open();
    await wait(200);
    expect(thrown.t.place()).toEqual(place);
    expect(thrown.t.notice()).toContain("Could not open the agent: spawn EAGAIN");
    expect(thrown.t.raw()).not.toContain(ALT_OFF);
    expect(await thrown.quit()).toBe(0);
    expect(count(thrown.t.raw(), ALT_OFF)).toBe(1);
  });

  test("t47_tui_same_place_when_the_run_is_gone", async () => {
    // The run left the list while the person was in its agent: the selection moves as on any refresh.
    const gone = async (through: "agent" | "refresh") => {
      const loop = opened();
      await wait(150);
      await loop.keys("j", "j");
      const title = cardTitle(loop.t.frame());
      if (through === "agent") await loop.open();
      loop.sessions.splice(2, 1);
      if (through === "agent") await loop.back("");
      else await wait(250);
      const place = loop.t.place();
      expect(await loop.quit()).toBe(0);
      return { title, place };
    };
    const viaAgent = await gone("agent");
    const viaRefresh = await gone("refresh");
    expect(viaAgent.title).not.toBe("");
    expect(cardTitle(viaAgent.place)).not.toBe(viaAgent.title);
    expect(viaAgent.place).toEqual(viaRefresh.place);
  });

  test("t47_tui_suspend_and_return_sequences", async () => {
    const exitListeners = process.listenerCount("exit");
    const loop = opened({ mouse: true });
    await wait(150);
    await loop.keys("j");
    expect(loop.t.input.listenerCount("data")).toBe(1);
    expect(loop.t.output.listenerCount("resize")).toBe(1);
    const leaving = loop.t.log.length;
    await loop.open();
    // Giving the terminal away: mouse off, paste off, cursor shown, the screen cleared and one line
    // that names the agent (one write, in that order), raw off, both listeners off, stdin paused. The
    // alternate screen is not left: the child draws into it.
    const run = loop.sessions[1]?.id ?? "";
    const HANDOVER = handoverScreen(`kw-${run}`);
    const left = loop.t.log.indexOf(`write ${HANDOVER}`, leaving);
    expect(left).toBeGreaterThanOrEqual(leaving);
    expect(loop.t.log.slice(left)).toEqual([`write ${HANDOVER}`, "raw off", "pause"]);
    expect(HANDOVER).toBe(`${MOUSE_OFF}${PASTE_OFF}\u001b[?25h\u001b[2J\u001b[Hopening kw-${run}…`);
    expect(HANDOVER).not.toContain("1049");
    // A name cannot put a switch of its own into that write.
    expect(handoverScreen("x\u001b[?1049l\ny")).toBe(
      `${MOUSE_OFF}${PASTE_OFF}\u001b[?25h\u001b[2J\u001b[Hopening x [?1049l y…`,
    );
    expect(SCREEN_OFF.indexOf(MOUSE_OFF)).toBeLessThan(SCREEN_OFF.indexOf(PASTE_OFF));
    expect(SCREEN_OFF.indexOf(PASTE_OFF)).toBeLessThan(SCREEN_OFF.indexOf("\u001b[?25h"));
    expect(SCREEN_OFF.indexOf("\u001b[?25h")).toBeLessThan(SCREEN_OFF.indexOf("\u001b[?1049l"));
    expect(loop.t.input.listenerCount("data")).toBe(0);
    expect(loop.t.output.listenerCount("resize")).toBe(0);
    const loads = loop.loads.length;
    const returning = loop.t.log.length;
    loop.last().back("Back from the agent.");
    await wait(10);
    // Coming back: the reverse, one listener each (the one on the input throws the handover away).
    expect(loop.t.log.slice(returning, returning + 3)).toEqual([
      `write ${SCREEN_ON}`,
      "raw on",
      "resume",
    ]);
    expect(loop.t.input.listenerCount("data")).toBe(1);
    expect(loop.t.output.listenerCount("resize")).toBe(1);
    await wait(200);
    expect(loop.t.input.listenerCount("data")).toBe(1);
    expect(loop.t.output.listenerCount("resize")).toBe(1);
    // A reload and a full redraw, with the mouse on again as the model has it.
    expect(loop.loads.length).toBeGreaterThan(loads);
    const since = loop.t.log.slice(returning).join("\n");
    expect(since).toContain(MOUSE_ON);
    expect(since).toContain("\u001b[1;1H");
    expect(loop.t.log.slice(returning).filter((l) => l === "raw off" || l === "pause")).toEqual([]);
    // `suspend` did not mark the screen closed: it draws, takes keys, and is given back once at the end.
    const mark = loop.t.mark();
    loop.t.type("j");
    expect(loop.t.raw(mark)).toContain("\u001b[1;1H");
    expect(await loop.quit()).toBe(0);
    expect(loop.t.raw().endsWith(SCREEN_OFF)).toBe(true);
    // Left once, at the end: the handover did not leave it.
    expect(count(loop.t.raw(), ALT_OFF)).toBe(1);
    expect(process.listenerCount("exit")).toBe(exitListeners);
  });

  test("t47_tui_reads_and_draws_nothing_while_away", async () => {
    const loop = opened();
    await wait(150);
    await loop.keys("j");
    await loop.open();
    const mark = loop.t.mark();
    const loads = loop.loads.length;
    const reads = loop.launcher.calls.length;
    // Keys and a resize while the terminal is the agent's: no handler of the screen hears them.
    loop.t.type("jjj");
    loop.t.type("q");
    loop.t.output.emit("resize");
    await wait(300);
    expect(loop.t.raw(mark)).toBe("");
    expect(loop.loads.length).toBe(loads);
    expect(loop.launcher.calls.length).toBe(reads);
    expect(loop.finished()).toBe(false);
    await loop.back("Back from the agent.");
    // Still on the second run; the first key after the return is handled once.
    expect(cardTitle(loop.t.frame())).toContain(loop.sessions[1]?.title ?? "?");
    loop.t.type("j");
    await wait(60);
    expect(cardTitle(loop.t.frame())).toContain(loop.sessions[2]?.title ?? "?");
    // A resize is the screen's again.
    const resized = loop.t.mark();
    loop.t.output.emit("resize");
    expect(loop.t.raw(resized)).toContain("\u001b[2J");
    expect(await loop.quit()).toBe(0);
  });

  test("t47_tui_signal_while_attached_restores_once", async () => {
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
      await killStub(async (kills) => {
        const loop = opened({ mouse: true });
        await wait(150);
        await loop.open();
        const logged = loop.t.log.length;
        process.emit(signal, signal);
        // The child is ended first (it only connects: no session ends). The screen's own modes went
        // off when it gave the terminal away, so one thing is left to put back: the alternate screen
        // the child drew into is left, once, and the keys (not raw while away) are not touched.
        expect(loop.last().signals, signal).toEqual(["SIGTERM"]);
        expect(loop.t.log.slice(logged), signal).toEqual([`write ${ALT_OFF}`]);
        expect(count(loop.t.raw(), ALT_OFF), signal).toBe(1);
        expect(kills, signal).toEqual([[process.pid, signal]]);
        expect(loop.launcher.stopped, signal).toEqual([]);
        expect(loop.launcher.finished, signal).toEqual([]);
        // The child goes: the loop is over and the alternate screen is not entered again.
        loop.last().back("");
        expect(await loop.done, signal).toBe(0);
        expect(count(loop.t.raw(), ALT_ON), signal).toBe(1);
        expect(count(loop.t.raw(), ALT_OFF), signal).toBe(1);
        expect(loop.t.raw().endsWith(ALT_OFF), signal).toBe(true);
      });
    }
    // The process ending while away: the same order.
    const known = new Set(process.listeners("exit"));
    const loop = opened();
    await wait(150);
    const mine = process.listeners("exit").filter((l) => !known.has(l));
    expect(mine.length).toBe(1);
    await loop.open();
    const logged = loop.t.log.length;
    (mine[0] as () => void)();
    expect(loop.last().signals).toEqual(["SIGTERM"]);
    expect(loop.t.log.slice(logged)).toEqual([`write ${ALT_OFF}`]);
    loop.last().back("");
    expect(await loop.done).toBe(0);
    expect(count(loop.t.raw(), ALT_OFF)).toBe(1);
  });

  test("t47_tui_ignores_quit_while_away", async () => {
    const before = process.listenerCount("SIGQUIT");
    const loop = opened();
    await wait(150);
    // With the screen up the terminal is raw and Ctrl+\ is a byte: no handler is needed, none is set.
    expect(process.listenerCount("SIGQUIT")).toBe(before);
    await loop.open();
    expect(process.listenerCount("SIGQUIT")).toBe(before + 1);
    const logged = loop.t.log.length;
    // The detach chord pressed while the terminal is not raw is the terminal's QUIT key.
    process.emit("SIGQUIT", "SIGQUIT");
    process.emit("SIGQUIT", "SIGQUIT");
    expect(loop.t.log.slice(logged)).toEqual([]);
    expect(loop.last().signals).toEqual([]);
    expect(loop.finished()).toBe(false);
    // It is still taken just after the child left, and given up once the keys are the screen's again.
    loop.last().back("Back from the agent.");
    await wait(5);
    expect(process.listenerCount("SIGQUIT")).toBe(before + 1);
    process.emit("SIGQUIT", "SIGQUIT");
    await wait(200);
    expect(process.listenerCount("SIGQUIT")).toBe(before);
    expect(loop.t.notice()).toContain("Back from the agent.");
    expect(await loop.quit()).toBe(0);
    expect(process.listenerCount("SIGQUIT")).toBe(before);
  });

  test("t47_tui_stop_and_continue_while_attached_ends_nothing", async () => {
    await killStub(async (kills) => {
      const counts = () => ["SIGTSTP", "SIGCONT"].map((s) => process.listenerCount(s));
      const before = counts();
      const loop = opened();
      await wait(150);
      await loop.keys("j", "\r");
      const place = loop.t.place();
      await loop.open();
      const logged = loop.t.log.length;
      // A stop from outside stops the child and then the screen; a continue brings both back.
      // The shell has the terminal while both are stopped, so it gets its own screen for that time.
      process.emit("SIGTSTP", "SIGTSTP");
      expect(loop.last().signals).toEqual(["SIGTSTP"]);
      expect(kills).toEqual([[process.pid, "SIGSTOP"]]);
      expect(loop.t.log.slice(logged)).toEqual([`write ${ALT_OFF}`]);
      process.emit("SIGCONT", "SIGCONT");
      expect(loop.last().signals).toEqual(["SIGTSTP", "SIGCONT"]);
      expect(loop.t.log.slice(logged)).toEqual([`write ${ALT_OFF}`, `write ${ALT_ON}`]);
      // Nothing was ended: not the child, not a session.
      expect(loop.launcher.stopped).toEqual([]);
      expect(loop.launcher.finished).toEqual([]);
      expect(loop.finished()).toBe(false);
      await loop.back("Back from the agent.");
      expect(loop.t.place()).toEqual(place);
      expect(counts()).toEqual(before);
      expect(await loop.quit()).toBe(0);
    });
  });

  test("t47_tui_drops_input_of_the_handover", async () => {
    expect(HANDOVER_DROP_MS).toBe(150);
    // The loop's own window, not the short one of the other tests.
    const loop = opened({ handoverDropMs: undefined });
    await wait(150);
    await loop.keys("j");
    const before = loop.t.place();
    await loop.open();
    loop.last().back("Back from the agent.");
    await wait(20);
    // What arrives in the window (a second detach chord, keys meant for the agent) does nothing.
    loop.t.type("\u001c");
    loop.t.type("j");
    loop.t.type("q");
    await wait(60);
    expect(loop.finished()).toBe(false);
    expect(loop.t.place()).toEqual(before);
    expect(cardTitle(loop.t.frame())).toContain(loop.sessions[1]?.title ?? "?");
    // After it a key is a key.
    await wait(150);
    loop.t.type("j");
    await wait(60);
    expect(cardTitle(loop.t.frame())).toContain(loop.sessions[2]?.title ?? "?");
    expect(await loop.quit()).toBe(0);
  });

  test("t47_tui_returns_when_the_child_dies_midway", async () => {
    const ways: {
      name: string;
      end: AttachExit;
      after?: (launcher: FakeLauncher, run: string) => void;
      notice: string;
    }[] = [
      {
        name: "the client crashes",
        end: { code: 1, signal: null },
        notice: "the connection ended with an error; the agent still runs (o opens it again)",
      },
      {
        name: "the client is killed",
        end: { code: null, signal: "SIGKILL" },
        notice: "the connection ended with an error; the agent still runs (o opens it again)",
      },
      {
        name: "the holder dies",
        end: { code: 1, signal: null },
        after: (launcher, run) => {
          const status = launcher.statusMap.get(run);
          if (status) {
            launcher.statusMap.set(run, { ...status, state: "lost", label: "lost (holder gone)" });
          }
        },
        notice: "ended while you were in it (lost (holder gone))",
      },
      {
        name: "the child never ran",
        end: { code: null, signal: null, error: "spawn ENOMEM" },
        notice: "Could not open the agent: spawn ENOMEM",
      },
    ];
    for (const way of ways) {
      const launcher = new FakeLauncher();
      const exits: ((end: AttachExit) => void)[] = [];
      const kills: string[] = [];
      const spawned: string[][] = [];
      const loop = opened({
        openWorker: createOpenWorker({
          launcher,
          platform: "darwin",
          bun: false,
          self: { exec: "/usr/local/bin/node", args: ["/opt/kodel/dist/kodel.js"] },
          root: "/proj",
          environment: { HOME: "/home/u" },
          runnable: async () => undefined,
          spawn: (file, args) => {
            spawned.push([file, ...args]);
            return {
              exited: new Promise<AttachExit>((resolve) => exits.push(resolve)),
              kill: (signal) => {
                kills.push(signal);
              },
            };
          },
        }),
        workers: {
          statuses: (ids) => launcher.statuses(ids),
          progress: (id) => launcher.progress(id),
        },
      });
      for (const [id, status] of loop.launcher.statusMap) {
        launcher.statusMap.set(id, status);
        launcher.progressMap.set(id, { lines: ["> working on it"] });
      }
      await wait(150);
      await loop.keys("j", "\r");
      const title = cardTitle(loop.t.frame());
      const mark = loop.t.mark();
      await loop.open();
      const run = loop.sessions[1]?.id ?? "";
      // The child is this build's `agent attach` of the run's record, and nothing is sent to it.
      expect(spawned, way.name).toEqual([
        [
          "/usr/local/bin/node",
          "/opt/kodel/dist/kodel.js",
          "--root",
          "/proj",
          "agent",
          "attach",
          `a_${run.slice(2)}_fake`,
          // The child draws into the alternate screen the TUI keeps, and does not leave it.
          "--keep-screen",
        ],
      ]);
      expect(loop.t.raw(mark).endsWith(handoverScreen(`kw-${run}`)), way.name).toBe(true);
      way.after?.(launcher, run);
      exits.at(-1)?.(way.end);
      await wait(250);
      // Back on the same card, with the reason; the screen is entered again exactly once.
      expect(cardTitle(loop.t.frame()), way.name).toBe(title);
      expect(loop.t.notice(), way.name).toContain(way.notice);
      expect(count(loop.t.raw(mark), ALT_ON), way.name).toBe(1);
      expect(loop.t.raw(mark), way.name).not.toContain(ALT_OFF);
      expect(kills, way.name).toEqual([]);
      expect(launcher.stopped, way.name).toEqual([]);
      expect(await loop.quit(), way.name).toBe(0);
    }
  });

  test("t47_tui_o_checks_before_leaving", async () => {
    const never = () => {
      throw new Error("the child must not be started");
    };
    const opener = (launcher: FakeLauncher, over: { platform?: string; bun?: boolean } = {}) =>
      createOpenWorker({
        launcher,
        platform: over.platform ?? "darwin",
        bun: over.bun ?? false,
        self: { exec: "/usr/local/bin/node", args: ["/opt/kodel/dist/kodel.js"] },
        root: "/proj",
        environment: {},
        runnable: async () => undefined,
        spawn: never,
      });
    const untouched = (raw: string) =>
      !raw.includes("\u001b[?1049l") && !raw.includes("\u001b[?1049h");

    // Windows: the records are not even read there, and the opener refuses by itself.
    const windows = new FakeLauncher();
    windows.statusMap.set("r_1", terminalWorker("r_1"));
    expect(await opener(windows, { platform: "win32" })("r_1", "a_1_fake")).toEqual({
      ok: false,
      message: "Could not open the agent: agents are not supported on Windows yet.",
    });
    expect(windows.calls).toEqual([]);
    const onWindows = opened({
      platform: "win32",
      openWorker: opener(windows, { platform: "win32" }),
    });
    await wait(150);
    const winMark = onWindows.t.mark();
    await onWindows.open();
    await wait(60);
    expect(untouched(onWindows.t.raw(winMark))).toBe(true);
    expect(onWindows.t.notice()).toContain("Nothing to open: no agent of kodel on this run.");
    expect(await onWindows.quit()).toBe(0);

    // A print worker: the key says so, and so does the opener when the record changed in between.
    const print = new FakeLauncher();
    print.statusMap.set("r_1", terminalWorker("r_1", { terminal: undefined }));
    const refused = await opener(print)("r_1", "a_1_fake");
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.message).toBe("Could not open the agent: kw-r_1 cannot be opened");
    const asked: string[] = [];
    const onPrint = opened({
      openWorker: async (runId) => {
        asked.push(runId);
        return { ok: false, message: "never" };
      },
    });
    for (const [id, status] of onPrint.launcher.statusMap) {
      const { terminal: _terminal, ...rest } = status;
      onPrint.launcher.statusMap.set(id, rest);
    }
    await wait(150);
    const printMark = onPrint.t.mark();
    await onPrint.open();
    await wait(60);
    expect(asked).toEqual([]);
    expect(untouched(onPrint.t.raw(printMark))).toBe(true);
    expect(onPrint.t.notice()).toContain("runs without a terminal (worker: print)");
    expect(await onPrint.quit()).toBe(0);

    // A record that stopped being attachable between the key and the check: not left either.
    const stale = opened({
      openWorker: async () => ({ ok: false, message: "Could not open the agent: it does not run" }),
    });
    await wait(150);
    const staleMark = stale.t.mark();
    await stale.open();
    await wait(60);
    expect(untouched(stale.t.raw(staleMark))).toBe(true);
    expect(stale.t.notice()).toContain("Could not open the agent: it does not run");
    expect(stale.t.input.listenerCount("data")).toBe(1);
    expect(await stale.quit()).toBe(0);

    // With no opener at all (a build without one) the key only says so.
    const none = opened({ openWorker: undefined });
    await wait(150);
    const noneMark = none.t.mark();
    await none.open();
    await wait(60);
    expect(untouched(none.t.raw(noneMark))).toBe(true);
    expect(none.t.notice()).toContain("Could not open the agent: not available here.");
    expect(await none.quit()).toBe(0);
  });

  test("t47_tui_o_under_bun_is_refused_with_the_command", async () => {
    expect(BUILT_KODEL).toBe("packages/cli/dist/kodel.js");
    let spawned = 0;
    const launcher = new FakeLauncher();
    const open = createOpenWorker({
      launcher,
      platform: "darwin",
      bun: true,
      self: { exec: "/usr/local/bin/bun", args: ["/repo/packages/cli/src/main.ts"] },
      root: "/proj",
      environment: {},
      runnable: async () => undefined,
      spawn: () => {
        spawned += 1;
        throw new Error("the child must not be started");
      },
    });
    const loop = opened({ openWorker: open });
    for (const [id, status] of loop.launcher.statusMap) launcher.statusMap.set(id, status);
    await wait(150);
    await loop.keys("j", "\r", " ");
    const before = loop.t.place();
    const mark = loop.t.mark();
    await loop.open();
    await wait(60);
    const run = loop.sessions[1]?.id ?? "";
    const command = `node packages/cli/dist/kodel.js agent attach a_${run.slice(2)}_fake`;
    // The screen is left alone and the notice spells the command to run in another terminal.
    expect(loop.t.raw(mark)).not.toContain("\u001b[?1049l");
    expect(loop.t.place()).toEqual(before);
    expect(loop.t.notice()).toContain(command);
    expect(spawned).toBe(0);
    expect(await open(run, "a_x")).toEqual({
      ok: false,
      message: `Could not open the agent: a TUI that runs under Bun does not hand its terminal over. In another terminal: ${command}`,
    });
    // A print worker under Bun gets its own reason, not a command that would fail.
    const { terminal: _terminal, ...print } = terminalWorker(run);
    launcher.statusMap.set(run, print);
    const refused = await open(run, "a_x");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).not.toContain("agent attach");
    expect(await loop.quit()).toBe(0);
  });
});
