import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { stripAnsi } from "../src/tui/ansi";
import { demoGateDetail, demoRunningDetail, demoSessions } from "../src/tui/demo";
import { MOUSE_OFF, MOUSE_ON, PASTE_OFF, PASTE_ON } from "../src/tui/input";
import { raiseAgain, runTui, terminalSignals } from "../src/tui/run";

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
