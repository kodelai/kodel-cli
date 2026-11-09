import { describe, expect, test } from "bun:test";
import { neutralize, stripAnsi, visibleLength } from "../src/tui/ansi";
import {
  createInputReader,
  DISCARD_GAP_MS,
  HOLD_MS,
  PASTE_IDLE_MS,
  PASTE_MAX,
} from "../src/tui/input";
import { applyEvents, applyInput } from "../src/tui/run";
import type { Session } from "../src/tui/session";
import {
  type Answer,
  type CardSlot,
  loadTask,
  type TaskRow,
  type TasksLoad,
  type TasksSource,
} from "../src/tui/tasks-load";
import { openTasksForTui, tuiTaskOptions } from "../src/tui/tasks-open";
import {
  cleanComment,
  initialModel,
  type Model,
  mouseUpdate,
  pasteText,
  render,
  shownTask,
  stripLoneSurrogates,
  takeEffects,
  update,
  withData,
  withTask,
  withTasks,
} from "../src/tui/view";

const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
const WIDE = { cols: 120, rows: 30 };
const NARROW = { cols: 70, rows: 30 };

const lines = (m: Model, size = WIDE) => render(m, size).map(stripAnsi);
const screen = (m: Model, size = WIDE) => lines(m, size).join("\n");
const press = (m: Model, keys: string[], size = WIDE) =>
  keys.reduce((acc, k) => update(acc, k, size), m);

/** The model's clock moved on: the pauses the comment input waits for are over. */
const later = (m: Model, ms = 500): Model => ({ ...m, now: m.now + ms });
/** A key that is the whole of its chunk, after a pause: how a person presses Enter or `y`. */
const lone = (m: Model, chunk: string, ms = 500): Model => applyInput(later(m, ms), chunk, WIDE);
/** Enter (the question), a pause, then `y`: what saves a comment. */
const saved = (m: Model): Model => lone(lone(m, "\r"), "y");

const row = (key: string, priority: string, extra: Partial<TaskRow> = {}): TaskRow => ({
  key,
  title: `title of ${key}`,
  state: "todo",
  status: "todo",
  priority,
  runCount: 0,
  ...extra,
});

const ready = (todo: TaskRow[], rest: TaskRow[] = [], more = false): TasksLoad => ({
  status: "ready",
  rows: [...todo, ...rest],
  more,
  problems: 0,
  todo,
  todoCut: false,
});

const session = (
  id: string,
  status: Session["status"],
  taskKey?: string,
  need?: Session["need"],
): Session => ({
  id,
  title: `run-${id}`,
  pipeline: "dev",
  status,
  ...(need === undefined ? {} : { need }),
  step: "implement",
  since: NOW - 60_000,
  steps: [],
  log: [],
  ...(taskKey === undefined ? {} : { taskKey }),
});

const model = (sessions: Session[], load?: TasksLoad): Model => {
  const m = initialModel({ sessions, proposals: 0 }, "project", NOW);
  return load ? withTasks(m, load) : m;
};

const SEVEN = [
  row("T-A1", "high"),
  row("T-A2", "high"),
  row("T-B1", "normal"),
  row("T-B2", "normal"),
  row("T-B3", "normal"),
  row("T-C1", "low"),
  row("T-C2", "low"),
];

const raw = (r: TaskRow) => ({
  key: r.key,
  title: r.title,
  status: r.status,
  state: r.state,
  priority: r.priority,
  run_count: r.runCount,
});

function pagedSource(all: TaskRow[]): TasksSource {
  return {
    list: async (input): Promise<Answer> =>
      ({
        ok: true,
        tasks: all.filter((r) => input.state.includes(r.state)).map(raw),
        truncated: false,
        problems: [],
      }) as Answer,
    get: async (input): Promise<Answer> => {
      const found = all.find((r) => r.key === input.key);
      if (!found) return { ok: false, message: `there is no task "${input.key}"` } as Answer;
      return { ok: true, task: { ...raw(found), runs: [], comments: [] }, subtasks: [] } as Answer;
    },
  };
}

type Card = Extract<CardSlot, { status: "ready" }>["card"];

const cardOf = (key: string, extra: Partial<Card> = {}): CardSlot => ({
  status: "ready",
  card: {
    key,
    title: `title of ${key}`,
    state: "todo",
    status: "todo",
    priority: "high",
    runs: [],
    comments: [],
    subtasks: [],
    ...extra,
  },
});

/** The Tasks screen with T-A1 (subtasks, runs) read, T-A2 and T-D1 (their parent T-A1) read, and the card in focus. */
function onCard(extra: Partial<Card> = {}): Model {
  const rows = [
    row("T-A1", "high"),
    row("T-A2", "normal", { parent: "T-A1" }),
    row("T-A3", "low"),
    row("T-D1", "normal", { state: "done", status: "done", parent: "T-A1" }),
  ];
  let m = update(
    model(
      [session("r_known", "running", "T-A1"), session("r_other", "done")],
      ready(rows.slice(0, 3), rows.slice(3)),
    ),
    "3",
  );
  m = withTask(
    m,
    "T-A1",
    cardOf("T-A1", {
      subtasks: [
        { key: "T-A2", title: "child" },
        { key: "T-D1", title: "finished child" },
        { key: "T-FAR", title: "far away" },
      ],
      runs: ["r_known", "r_unknown"],
      body: "The body.",
      ...extra,
    }),
  );
  m = withTask(m, "T-A2", cardOf("T-A2", { parent: "T-A1", priority: "normal" }));
  m = withTask(m, "T-D1", cardOf("T-D1", { parent: "T-A1", state: "done", status: "done" }));
  return update(m, "enter");
}

describe("colours", () => {
  const sgr = (code: number, text: string) => new RegExp(`\u001b\\[${code}m${text}`);
  const rawScreen = (m: Model, size = WIDE) => render(m, size).join("\n");

  test("task_g4jy_colours_key_and_priority", () => {
    // T-A1 is not selected here, so its row is not drawn inverted.
    const out = rawScreen(press(update(model([], ready(SEVEN)), "3"), ["down", "down"]));
    expect(out).toMatch(sgr(2, "T-A1"));
    expect(out).toMatch(sgr(31, "high"));
    expect(out).toMatch(sgr(2, "low"));
    // A normal priority is plain: no colour sits right in front of it.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: looking for the colour codes is the point
    expect(out).not.toMatch(/\u001b\[3\dmnormal/);
  });

  test("task_g4jy_colours_groups_and_states", () => {
    const rows = [
      row("T-A1", "high"),
      row("T-P1", "normal", { state: "progress", status: "progress" }),
      row("T-D1", "normal", { state: "done", status: "done" }),
      row("T-X1", "low", { state: "done", status: "declined" }),
    ];
    const out = rawScreen(update(model([], ready(rows.slice(0, 1), rows.slice(1))), "3"));
    expect(out).toMatch(sgr(33, "TODO"));
    expect(out).toMatch(sgr(36, "IN PROGRESS"));
    expect(out).toMatch(sgr(32, "DONE"));
    // In the card a declined task is dimmed.
    let m = update(model([], ready(rows.slice(0, 1), rows.slice(1))), "3");
    m = press(m, ["down", "down", "down"]);
    m = withTask(m, "T-X1", cardOf("T-X1", { state: "done", status: "declined" }));
    expect(m.tasks.selected).toBe("T-X1");
    expect(rawScreen(m)).toMatch(sgr(2, "declined \\(done\\)"));
  });

  test("task_g4jy_colours_backlog_header_and_run_states", () => {
    const m = model([session("r_1", "running")], ready(SEVEN.slice(0, 2)));
    expect(rawScreen(m)).toMatch(sgr(33, "BACKLOG"));
    expect(rawScreen(onCard())).toMatch(sgr(36, "running"));
  });

  test("task_g4jy_colours_do_not_change_the_width", () => {
    const screens = [
      model([session("r_1", "running")], ready(SEVEN)),
      update(model([], ready(SEVEN)), "3"),
      onCard(),
      update(onCard(), "escape"),
    ];
    for (const m of screens) {
      for (const size of [WIDE, NARROW]) {
        for (const l of render(m, size)) expect(visibleLength(l)).toBe(size.cols);
      }
    }
  });
});

describe("the child symbol", () => {
  const rows = [
    row("T-A1", "high"),
    row("T-A2", "normal", { parent: "T-A1" }),
    row("T-A3", "low", { parent: "T-GONE" }),
  ];
  const left = (m: Model, key: string) =>
    (lines(m).find((l) => (l.split("│")[0] ?? "").includes(`${key} `)) ?? "").split("│")[0] ?? "";

  test("task_g4jy_child_symbol_in_the_list", () => {
    const m = update(model([], ready(rows)), "3");
    expect(left(m, "T-A2")).toContain("└ T-A2");
    // A top-level task and one whose parent is not listed have none.
    expect(left(m, "T-A1")).not.toContain("└");
    expect(left(m, "T-A3")).not.toContain("└");
  });

  test("task_g4jy_child_symbol_keeps_the_row_to_key_title_and_priority", () => {
    const text = left(update(model([], ready(rows)), "3"), "T-A2");
    expect(text).toContain("title of T-A2");
    expect(text).toContain("normal");
    expect(text).not.toContain("todo");
    expect(text).not.toContain("↳");
  });
});

describe("the subtasks of a card", () => {
  test("task_g4jy_card_shows_subtasks_under_the_body_with_priority_and_status", () => {
    const text = lines(onCard());
    const at = (needle: string) => text.findIndex((l) => l.includes(needle));
    expect(at("The body.")).toBeGreaterThan(-1);
    expect(at("SUBTASKS")).toBeGreaterThan(at("The body."));
    expect(text.join("\n")).toMatch(/T-A2\s+normal\s+todo\s+child/);
    expect(text.join("\n")).toMatch(/T-D1\s+normal\s+done\s+finished child/);
    // One of the three is not on the list, so the counter is not told.
    expect(text[at("SUBTASKS")]).not.toContain("done");
  });

  test("task_g4jy_card_counts_finished_subtasks_when_all_are_known", () => {
    const m = onCard({
      subtasks: [
        { key: "T-A2", title: "child" },
        { key: "T-D1", title: "finished child" },
      ],
    });
    expect(screen(m)).toContain("SUBTASKS · 1/2 done");
  });

  test("task_g4jy_subtask_off_the_page_shows_key_and_title", () => {
    expect(screen(onCard())).toMatch(/T-FAR\s+far away/);
  });

  test("task_g4jy_card_arrows_walk_the_items", () => {
    let m = onCard();
    expect(m.tasks.item).toBe(0);
    expect(screen(m)).toMatch(/› T-A2/);
    m = press(m, ["down"]);
    expect(m.tasks.item).toBe(1);
    expect(screen(m)).toMatch(/› T-D1/);
    // The items are the three subtasks and the one run that is in Sessions: four.
    m = press(m, ["down", "down", "down", "down"]);
    expect(m.tasks.item).toBe(3);
    expect(screen(m)).toMatch(/› r_known/);
    expect(press(m, ["up", "up", "up", "up", "up"]).tasks.item).toBe(0);
  });

  test("task_g4jy_enter_on_a_subtask_opens_its_card_and_esc_comes_back", () => {
    let m = update(onCard(), "enter");
    expect(m.tasks.drill).toEqual(["T-A2"]);
    expect(shownTask(m)).toBe("T-A2");
    expect(m.tasks.selected).toBe("T-A1");
    expect(screen(m)).toContain("title of T-A2");
    expect(screen(m)).toMatch(/› parent: T-A1/);
    m = update(m, "escape");
    expect(m.tasks.drill).toEqual([]);
    expect(shownTask(m)).toBe("T-A1");
    expect(m.focus).toBe("card");
    // Left does the same as Esc, and with nothing opened Esc leaves the card as it always did.
    expect(update(update(onCard(), "enter"), "left").tasks.drill).toEqual([]);
    expect(update(m, "escape").focus).toBe("list");
  });

  test("task_g4jy_enter_on_the_parent_row_goes_back_to_the_parent_on_the_stack", () => {
    let m = update(onCard(), "enter");
    expect(m.tasks.item).toBe(0);
    m = update(m, "enter");
    // The parent is the task the card was opened from: it is taken off the stack, not put on again.
    expect(m.tasks.drill).toEqual([]);
    expect(shownTask(m)).toBe("T-A1");
  });

  test("task_g4jy_enter_on_a_parent_that_is_not_on_the_stack_opens_it", () => {
    let m = update(onCard(), "escape");
    m = press(m, ["down"]);
    expect(m.tasks.selected).toBe("T-A2");
    m = withTask(m, "T-A2", cardOf("T-A2", { parent: "T-A1" }));
    m = press(m, ["enter", "enter"]);
    expect(m.tasks.drill).toEqual(["T-A1"]);
    expect(screen(m)).toContain("title of T-A1");
    // And from there one more level and back, step by step.
    m = press(m, ["down", "enter"]);
    expect(m.tasks.drill).toEqual(["T-A1", "T-D1"]);
    expect(update(m, "escape").tasks.drill).toEqual(["T-A1"]);
    // A subtask that is the task the list is on is the way back, not one level deeper.
    expect(update(update(m, "escape"), "enter").tasks.drill).toEqual([]);
  });

  test("task_g4jy_opening_a_subtask_asks_for_its_card_once", () => {
    const m = onCard();
    const { "T-D1": _gone, ...rest } = m.tasks.cards;
    const unread = { ...m, tasks: { ...m.tasks, cards: rest } };
    const opened = press(takeEffects(unread)[0], ["down", "enter"]);
    expect(opened.tasks.drill).toEqual(["T-D1"]);
    expect(takeEffects(opened)[1]).toEqual([{ type: "load_task", key: "T-D1" }]);
    expect(screen(opened)).toContain("Reading the task…");
  });

  test("task_g4jy_what_was_opened_is_let_go_when_the_person_goes_elsewhere", () => {
    const opened = update(onCard(), "enter");
    expect(opened.tasks.drill).toEqual(["T-A2"]);
    expect(update(opened, "1").tasks.drill).toEqual([]);
    expect(update(opened, "tab").tasks.drill).toEqual([]);
    // Moving the list selection puts it away too.
    const back = update(update(opened, "escape"), "escape");
    expect(update(back, "down").tasks.drill).toEqual([]);
  });

  test("task_g4jy_drill_works_in_the_backlog_card", () => {
    let m = model([session("r_1", "running")], ready(SEVEN.slice(0, 3)));
    m = press(m, ["down"]);
    expect(m.pick).toEqual({ kind: "task", key: "T-A1" });
    m = withTask(m, "T-A1", cardOf("T-A1", { subtasks: [{ key: "T-A2", title: "child" }] }));
    m = withTask(m, "T-A2", cardOf("T-A2", { parent: "T-A1" }));
    m = press(m, ["enter", "enter"]);
    expect(m.pick).toEqual({ kind: "task", key: "T-A1" });
    expect(m.tasks.drill).toEqual(["T-A2"]);
    expect(screen(m)).toContain("title of T-A2");
    // Esc takes the subtask off; the next Esc leaves the card for the list, as before.
    m = update(m, "escape");
    expect(m.tasks.drill).toEqual([]);
    expect(m.focus).toBe("card");
    expect(update(m, "escape").focus).toBe("list");
  });
});

describe("comments on a task", () => {
  const write = (m: Model) => m.effects.filter((e) => e.type === "add_task_comment");
  const onScreen = () => update(update(model([], ready(SEVEN)), "3"), "enter");

  test("task_g4jy_c_opens_the_input_on_the_task_card_of_the_tasks_screen", () => {
    const m = update(onScreen(), "c");
    expect(m.taskInput).toMatchObject({ key: "T-A1", text: "", openedAt: m.now });
    expect(lines(m).at(-1)).toContain("Comment on T-A1:");
  });

  test("task_g4jy_c_opens_the_input_on_the_backlog_card", () => {
    const m = press(model([session("r_1", "running")], ready(SEVEN)), ["down", "enter", "c"]);
    expect(m.taskInput).toMatchObject({ key: "T-A1", text: "" });
  });

  test("task_g4jy_c_comments_on_the_task_that_was_opened_from_the_card", () => {
    expect(press(onCard(), ["enter", "c"]).taskInput?.key).toBe("T-A2");
  });

  test("task_g4jy_c_does_nothing_on_a_run", () => {
    const m = model([session("r_1", "running")], ready(SEVEN));
    expect(update(m, "c").taskInput).toBeNull();
    expect(update(update(m, "enter"), "c").taskInput).toBeNull();
  });

  test("task_g4jy_comment_enter_asks_and_y_saves_it_as_an_effect", () => {
    let m = press(onScreen(), ["c", "h", "i", " ", "t", "h", "e", "r", "e"]);
    expect(lines(m).at(-1)).toContain("Comment on T-A1: hi there");
    m = lone(m, "\r");
    expect(write(m)).toEqual([]);
    expect(m.taskInput?.confirmAt).toBeDefined();
    expect(lines(m).at(-1)).toContain("Save this comment to T-A1?");
    expect(lines(m).at(-1)).toContain("«hi there»");
    m = lone(m, "y");
    expect(m.taskInput).toBeNull();
    expect(write(m)).toEqual([{ type: "add_task_comment", key: "T-A1", text: "hi there" }]);
  });

  test("task_g4jy_comment_escape_cancels", () => {
    const m = press(onScreen(), ["c", "x", "escape"]);
    expect(m.taskInput).toBeNull();
    expect(m.notice).toBe("Cancelled.");
    expect(write(m)).toEqual([]);
  });

  test("task_g4jy_comment_with_no_text_saves_nothing", () => {
    const m = lone(press(onScreen(), ["c", " ", " "]), "\r");
    expect(m.taskInput).toBeNull();
    expect(write(m)).toEqual([]);
  });

  test("task_g4jy_comment_backspace_and_keys_are_text", () => {
    // `q` and the digits are text while a comment is typed, not keys.
    let m = press(onScreen(), ["c", "q", "1", "backspace", "3"]);
    expect(m.taskInput?.text).toBe("q3");
    expect(m.quit).toBe(false);
    expect(m.section).toBe(2);
    // The names of other keys are not text.
    m = press(m, ["up", "tab"]);
    expect(m.taskInput?.text).toBe("q3");
    expect(write(saved(m))).toEqual([{ type: "add_task_comment", key: "T-A1", text: "q3" }]);
  });

  test("task_g4jy_comment_is_at_most_500_characters", () => {
    const m = press(onScreen(), ["c", ...Array.from({ length: 520 }, () => "x")]);
    expect(m.taskInput?.text.length).toBe(500);
  });

  test("task_g4jy_a_line_break_that_comes_with_other_text_is_not_enter", () => {
    let m = update(onScreen(), "c");
    m = applyInput(later(m), "pasted\rq", WIDE);
    expect(m.quit).toBe(false);
    expect(write(m)).toEqual([]);
    expect(m.taskInput?.confirmAt).toBeUndefined();
    expect(m.taskInput?.text).toBe("pastedq");
  });

  test("task_g4jy_the_mouse_is_ignored_while_a_comment_is_typed", () => {
    const m = { ...press(onScreen(), ["c"]), mouse: true };
    const click = { type: "mouse" as const, action: "press" as const, x: 3, y: 1 };
    expect(mouseUpdate(m, WIDE, click).section).toBe(2);
  });

  test("task_g4jy_the_hint_lists_the_new_keys_last", () => {
    const hint = lines(onCard()).at(-1) ?? "";
    expect(hint).toContain("↑↓ select");
    expect(hint).toContain("Enter open");
    expect(hint.indexOf("q quit")).toBeLessThan(hint.indexOf("c comment"));
    // After something was opened, Esc says it goes back.
    expect(lines(update(onCard(), "enter")).at(-1)).toContain("Esc back");
  });

  test("task_g4jy_only_c_writes_a_comment", () => {
    const base = onScreen();
    // No key script without `c` asks for a write, however it wanders over the screens.
    const wander = [
      "down",
      "enter",
      "down",
      "escape",
      "t",
      "z",
      "z",
      "1",
      "down",
      "enter",
      "escape",
      "tab",
      "tab",
      "2",
      "3",
      "up",
      "right",
      "left",
      "a",
      "r",
      "d",
      "y",
      "n",
      "i",
      "m",
      "b",
      " ",
    ];
    let m = base;
    for (const key of wander) {
      m = update(m, key, WIDE);
      expect(write(m)).toEqual([]);
    }
    // With `c`, a text and Enter it is exactly one write of a comment, for the task on the card.
    const typed = saved(press(base, ["c", "o", "k"]));
    expect(write(typed)).toEqual([{ type: "add_task_comment", key: "T-A1", text: "ok" }]);
    // The effect carries no status, priority or delete.
    expect(Object.keys(write(typed)[0] ?? {})).toEqual(["type", "key", "text"]);
  });
});

describe("the writer behind c", () => {
  test("task_g4jy_the_real_writer_updates_only_the_comment", async () => {
    const calls: unknown[] = [];
    const service = {
      ...pagedSource(SEVEN),
      update: async (input: unknown): Promise<Answer> => {
        calls.push(input);
        return { ok: true };
      },
      create: async (): Promise<Answer> => ({ ok: true, task: { key: "T-NEW" } }) as Answer,
    };
    const handle = await openTasksForTui("/nowhere", async () => ({ service }));
    if (handle.status !== "on") throw new Error("not on");
    await handle.comment?.("T-A1", "a note");
    expect(calls).toEqual([{ key: "T-A1", comment: "a note" }]);
    // The readers it hands out have no way to write.
    expect(Object.keys(handle.source).sort()).toEqual(["get", "list"]);
  });

  test("task_g4jy_a_refused_comment_is_an_error_with_the_trackers_words", async () => {
    const service = {
      ...pagedSource(SEVEN),
      update: async (): Promise<Answer> => ({ ok: false, message: "the task is closed" }) as Answer,
      create: async (): Promise<Answer> => ({ ok: false, message: "no" }) as Answer,
    };
    const handle = await openTasksForTui("/nowhere", async () => ({ service }));
    if (handle.status !== "on") throw new Error("not on");
    await expect(handle.comment?.("T-A1", "x")).rejects.toThrow("the task is closed");
  });

  test("task_g4jy_the_options_carry_the_writer_only_when_there_is_one", () => {
    expect(tuiTaskOptions({ status: "off" }).addTaskComment).toBeUndefined();
    expect(tuiTaskOptions("demo", NOW).addTaskComment).toBeDefined();
    expect(
      tuiTaskOptions({ status: "on", source: pagedSource(SEVEN) }).addTaskComment,
    ).toBeUndefined();
    const withWriter = tuiTaskOptions({
      status: "on",
      source: pagedSource(SEVEN),
      comment: async () => undefined,
    });
    expect(withWriter.addTaskComment).toBeDefined();
  });

  test("task_g4jy_demo_comment_shows_on_the_card_and_is_written_nowhere", async () => {
    const options = tuiTaskOptions("demo", NOW);
    await options.addTaskComment?.("KDL-2K9M", "a sample note");
    const slot = await options.loadTask?.("KDL-2K9M");
    expect(slot?.status === "ready" && slot.card.comments.map((c) => c.text)).toEqual([
      "a sample note",
    ]);
    // Another call of the options starts clean: the notes live as long as the options.
    const fresh = await tuiTaskOptions("demo", NOW).loadTask?.("KDL-2K9M");
    expect(fresh?.status === "ready" && fresh.card.comments).toEqual([]);
  });
});

describe("the runs of a task", () => {
  /** Down over the three subtasks to the run that is in Sessions. */
  const toRun = ["down", "down", "down"];

  test("task_g4jy_runs_block_marks_the_runs_that_are_in_sessions", () => {
    const text = screen(onCard());
    expect(text).toContain("RUNS");
    expect(text).toContain("r_known · running");
    expect(text).toContain("run-r_known");
    // A run the list of Sessions does not have is a plain id, without a state and without a jump.
    expect(text).toContain("r_unknown");
    expect(text).not.toContain("r_unknown ·");
  });

  test("task_g4jy_enter_on_a_run_goes_to_it_in_sessions", () => {
    const m = press(onCard(), [...toRun, "enter"]);
    expect(m.section).toBe(0);
    expect(m.pick).toEqual({ kind: "run" });
    expect(m.selected).toBe("r_known");
    expect(m.back).toEqual({ section: 2, key: "T-A1", drill: [] });
    expect(screen(m)).toContain("run-r_known");
    expect(lines(m).at(-1)).toContain("Esc back to T-A1");
  });

  test("task_g4jy_esc_comes_back_to_the_same_task_card_on_the_tasks_screen", () => {
    const m = press(onCard(), [...toRun, "enter", "escape"]);
    expect(m.section).toBe(2);
    expect(m.back).toBeUndefined();
    expect(m.tasks.selected).toBe("T-A1");
    expect(m.focus).toBe("card");
    expect(screen(m)).toContain("title of T-A1");
  });

  test("task_g4jy_esc_brings_back_what_was_opened_from_the_card", () => {
    const rows = [row("T-A1", "high"), row("T-A2", "normal", { parent: "T-A1" })];
    let m = update(model([session("r_known", "running")], ready(rows)), "3");
    m = withTask(m, "T-A1", cardOf("T-A1", { subtasks: [{ key: "T-A2", title: "child" }] }));
    m = withTask(m, "T-A2", cardOf("T-A2", { parent: "T-A1", runs: ["r_known"] }));
    m = press(m, ["enter", "enter"]);
    expect(m.tasks.drill).toEqual(["T-A2"]);
    // The first item of a subtask is its parent, the next is the run.
    m = press(m, ["down", "enter"]);
    expect(m.back).toEqual({ section: 2, key: "T-A1", drill: ["T-A2"] });
    m = update(m, "escape");
    expect(m.section).toBe(2);
    expect(m.tasks.drill).toEqual(["T-A2"]);
    expect(shownTask(m)).toBe("T-A2");
  });

  test("task_g4jy_esc_comes_back_to_the_backlog_card", () => {
    let m = model([session("r_known", "running")], ready(SEVEN.slice(0, 3)));
    m = press(m, ["down"]);
    m = withTask(m, "T-A1", cardOf("T-A1", { runs: ["r_known"] }));
    m = press(m, ["enter", "enter"]);
    expect(m.section).toBe(0);
    expect(m.pick).toEqual({ kind: "run" });
    expect(m.back).toEqual({ section: 0, key: "T-A1", drill: [] });
    m = update(m, "escape");
    expect(m.pick).toEqual({ kind: "task", key: "T-A1" });
    expect(m.focus).toBe("card");
    expect(m.back).toBeUndefined();
  });

  test("task_g4jy_back_is_let_go_when_the_person_goes_elsewhere", () => {
    const jumped = press(onCard(), [...toRun, "enter"]);
    expect(jumped.back).toBeDefined();
    for (const key of ["tab", "1", "2", "3", "4"]) expect(update(jumped, key).back).toBeUndefined();
    // Moving to another row of Sessions too: Esc then no longer returns anywhere.
    const moved = update(jumped, "down");
    expect(moved.back).toBeUndefined();
    expect(update(moved, "escape").section).toBe(0);
    const mouse = { ...jumped, mouse: true };
    const press1 = (x: number, y: number) => ({
      type: "mouse" as const,
      action: "press" as const,
      x,
      y,
    });
    // A click on the menu, and one on another run.
    expect(mouseUpdate(mouse, WIDE, press1(22, 1)).back).toBeUndefined();
    const other = lines(mouse).findIndex((l) => (l.split("│")[0] ?? "").includes("run-r_other"));
    expect(mouseUpdate(mouse, WIDE, press1(3, other + 1)).back).toBeUndefined();
  });

  test("task_g4jy_a_run_the_list_does_not_have_has_no_jump", () => {
    // Only a run that is in Sessions is an item; here there is none, so Enter does nothing.
    const m = onCard({ runs: ["r_unknown"], subtasks: [] });
    expect(update(m, "enter").section).toBe(2);
    expect(update(m, "enter").back).toBeUndefined();
  });

  test("task_g4jy_run_keys_stay_inert_after_a_jump_back_to_a_task", () => {
    const jumped = press(onCard(), [...toRun, "enter", "escape"]);
    expect(jumped.section).toBe(2);
    expect(update(jumped, "a").confirm).toBeNull();
    const backlog = press(
      model([session("r_known", "waiting", undefined, "approve")], ready(SEVEN.slice(0, 2))),
      ["down"],
    );
    expect(backlog.pick.kind).toBe("task");
    expect(update(backlog, "a").confirm).toBeNull();
  });
});

describe("what the review found", () => {
  test("task_g4jy_empty_list_card_says_no_task_selected_and_z_does_nothing", () => {
    const m = update(model([], ready([])), "3");
    expect(m.tasks.selected).toBe("");
    expect(screen(m)).toContain("No task selected.");
    expect(screen(m)).not.toContain("Reading the task");
    expect(update(m, "z").zoom).toBe(false);
    expect(update(m, "c").taskInput).toBeNull();
    expect(update(m, "enter").focus).toBe("list");
  });

  test("task_g4jy_first_backlog_task_is_picked_when_there_are_no_runs", () => {
    const m = model([], ready(SEVEN.slice(0, 3)));
    expect(m.pick).toEqual({ kind: "task", key: "T-A1" });
    expect(shownTask(m)).toBe("T-A1");
    expect(takeEffects(m)[1]).toEqual([{ type: "load_task", key: "T-A1" }]);
    expect(screen(m)).toContain("title of T-A1");
  });

  test("task_g4jy_a_run_arriving_does_not_take_the_pick_from_a_task", () => {
    let m = model([], ready(SEVEN.slice(0, 3)));
    m = press(m, ["down"]);
    m = withData(m, { sessions: [session("r_1", "running")], proposals: 0 }, NOW);
    expect(m.pick).toEqual({ kind: "task", key: "T-A2" });
  });
});

describe("what the second review found", () => {
  const write = (m: Model) => m.effects.filter((e) => e.type === "add_task_comment");
  const onScreen = () => update(update(model([], ready(SEVEN)), "3"), "enter");
  const ESC = "\u001b";
  const hostile = `${ESC}]52;c;ZXZpbA==\u0007${ESC}[2J${ESC}[5A${ESC}c\u009b2J`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: looking for the control characters is the point
  const control = /[\u0000-\u001f\u007f-\u009f]/;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the TUI's own colour codes are allowed
  const own = /\u001b\[(?:0|1|2|7|3[1-6])m/g;

  test("task_g4jy_paste_outside_typing_cannot_write_a_comment", () => {
    // A paste that holds a `c`: the input opens and the chunk ends there, so nothing is saved and nothing else runs.
    const m = applyInput(onScreen(), "fix the c bug\nmore", WIDE);
    expect(write(m)).toEqual([]);
    expect(m.taskInput).toMatchObject({ key: "T-A1", text: "" });
    expect(m.section).toBe(2);
    expect(m.mouse).toBe(false);
  });

  test("task_g4jy_comment_needs_a_lone_enter_and_a_lone_y_after_pauses", () => {
    let m = applyInput(onScreen(), "c", WIDE, undefined, NOW);
    expect(m.taskInput).not.toBeNull();
    // The rest of a paste: a line break among text is no Enter.
    m = applyInput(m, "ok\rq", WIDE, undefined, NOW + 10);
    expect(write(m)).toEqual([]);
    // A lone Enter inside the pause after the input opened is ignored too.
    m = applyInput(m, "\r", WIDE, undefined, NOW + 50);
    expect(m.taskInput?.confirmAt).toBeUndefined();
    // After the pause it asks.
    m = applyInput(m, "\r", WIDE, undefined, NOW + 500);
    expect(m.taskInput?.confirmAt).toBe(NOW + 500);
    // A `y` inside the pause after the question is ignored, one that comes with other text is not a `y`.
    m = applyInput(m, "y", WIDE, undefined, NOW + 600);
    expect(write(m)).toEqual([]);
    expect(m.taskInput?.confirmAt).toBe(NOW + 500);
    const mixed = applyInput(m, "yy", WIDE, undefined, NOW + 1000);
    expect(write(mixed)).toEqual([]);
    expect(mixed.taskInput?.confirmAt).toBeUndefined();
    // A lone `y` after the pause saves.
    m = applyInput(m, "y", WIDE, undefined, NOW + 1000);
    expect(write(m)).toEqual([{ type: "add_task_comment", key: "T-A1", text: "okq" }]);
    expect(m.quit).toBe(false);
  });

  test("task_g4jy_a_reload_that_drops_the_task_drops_what_was_opened_from_it", () => {
    const opened = update(onCard(), "enter");
    expect(opened.tasks.drill).toEqual(["T-A2"]);
    const m = withTasks(opened, ready([row("T-B1", "normal")]));
    expect(m.tasks.selected).toBe("T-B1");
    expect(m.tasks.drill).toEqual([]);
    expect(m.tasks.item).toBe(0);
    expect(shownTask(m)).toBe("T-B1");
  });

  test("task_g4jy_the_sessions_pick_leaving_the_block_keeps_the_tasks_screen_card", () => {
    // No runs: T-A1 is picked at once. The person works on the Tasks screen and opens its subtask.
    let m = model([], ready(SEVEN.slice(0, 3)));
    expect(m.pick).toEqual({ kind: "task", key: "T-A1" });
    m = update(m, "3");
    m = withTask(m, "T-A1", cardOf("T-A1", { subtasks: [{ key: "T-A2", title: "child" }] }));
    m = press(m, ["enter", "enter"]);
    expect(m.tasks.drill).toEqual(["T-A2"]);
    expect(m.focus).toBe("card");
    // T-A1 gets started: it is no longer in the block, but still on the screen.
    const started = row("T-A1", "high", { state: "progress", status: "progress" });
    m = withTasks(m, ready(SEVEN.slice(1, 3), [started]));
    expect(m.pick).toEqual({ kind: "task", key: "T-A2" });
    expect(m.tasks.selected).toBe("T-A1");
    expect(m.tasks.drill).toEqual(["T-A2"]);
    expect(m.focus).toBe("card");
  });

  test("task_g4jy_an_empty_key_is_not_a_subtask_a_run_or_a_place_for_a_comment", async () => {
    const source: TasksSource = {
      list: async () => ({ ok: true, tasks: [], truncated: false, problems: [] }) as Answer,
      get: async () =>
        ({
          ok: true,
          task: { ...raw(row("T-A1", "high")), runs: ["", "r_1"], comments: [] },
          subtasks: [
            { key: "", title: "no key" },
            { key: "T-K", title: "kid" },
          ],
        }) as Answer,
    };
    const slot = await loadTask({ status: "on", source }, "T-A1");
    if (slot.status !== "ready") throw new Error("not ready");
    expect(slot.card.subtasks.map((k) => k.key)).toEqual(["T-K"]);
    expect(slot.card.runs).toEqual(["r_1"]);
    // Even if one got in, Enter and `c` do nothing with it.
    let m = update(onScreen(), "enter");
    m = withTask(m, "T-A1", cardOf("T-A1", { subtasks: [{ key: "", title: "no key" }] }));
    m = update(m, "enter");
    expect(m.tasks.drill).toEqual([]);
    const forced: Model = { ...m, tasks: { ...m.tasks, drill: [""] } };
    expect(update(forced, "c").taskInput).toBeNull();
  });

  test("task_g4jy_new_card_lines_and_notices_are_neutralized", () => {
    const rows = [row("T-A1", "high"), row("T-A2", "normal", { parent: "T-A1" })];
    let m = update(
      model([{ ...session("r_1", "running", "T-A1"), title: `run${hostile}` }], ready(rows)),
      "3",
    );
    m = withTask(
      m,
      "T-A1",
      cardOf("T-A1", {
        parent: `par${hostile}`,
        subtasks: [{ key: `K${hostile}`, title: `kid${hostile}` }],
        runs: [`id${hostile}`, "r_1"],
      }),
    );
    m = update(m, "enter");
    const check = (out: string[]) => {
      for (const l of out) {
        expect(l.replace(own, "")).not.toMatch(control);
        expect(neutralize(l).replace(own, "")).not.toMatch(control);
      }
    };
    check(render(m, WIDE));
    check(render(m, NARROW));
    // The line of the input, with a key as hostile as the rest.
    check(
      render({ ...m, taskInput: { key: `K${hostile}`, text: `t${hostile}`, openedAt: 0 } }, WIDE),
    );
    check(
      render(
        { ...m, taskInput: { key: `K${hostile}`, text: `t${hostile}`, openedAt: 0, confirmAt: 1 } },
        WIDE,
      ),
    );
    // And the notice of a refusal, which words what a tracker said.
    check(render({ ...m, notice: `Could not add the comment: ${hostile}` }, WIDE));
  });

  test("task_g4jy_the_hint_after_a_jump_keeps_the_run_keys", () => {
    let m = update(
      model([session("r_g", "waiting", "T-A1", "approve")], ready([row("T-A1", "high")])),
      "3",
    );
    m = withTask(m, "T-A1", cardOf("T-A1", { runs: ["r_g"] }));
    m = press(m, ["enter", "enter"]);
    expect(m.back).toBeDefined();
    const hint = lines(m).at(-1) ?? "";
    expect(hint).toContain("Esc back to T-A1");
    // what a and r do is on buttons in front of the hints
    expect(hint).toContain("[a Approve]");
    expect(hint).toContain("[r Reject]");
    expect(hint).toContain("Tab menu");
    expect(hint.indexOf("Tab menu")).toBeGreaterThan(hint.indexOf("Esc back"));
    expect(hint).toContain("q quit");
  });

  test("task_g4jy_a_refusal_is_red_and_a_success_is_green", () => {
    const base = onScreen();
    const red = render({ ...base, notice: "Could not add the comment: boom" }, WIDE).at(-1) ?? "";
    const green = render({ ...base, notice: "Comment saved." }, WIDE).at(-1) ?? "";
    expect(red).toContain("\u001b[31m");
    expect(red).not.toContain("\u001b[32m");
    expect(green).toContain("\u001b[32m");
    // The notices of the other screens that tell a failure are red too; a plain one stays green.
    const diff = render({ ...base, notice: "Cannot read the diff: x" }, WIDE).at(-1) ?? "";
    expect(diff).toContain("\u001b[31m");
    const cancelled = render({ ...base, notice: "Cancelled." }, WIDE).at(-1) ?? "";
    expect(cancelled).toContain("\u001b[32m");
  });
});

describe("a paste can never write a comment", () => {
  const ESC = "\u001b";
  const START = `${ESC}[200~`;
  const END = `${ESC}[201~`;
  const write = (m: Model) => m.effects.filter((e) => e.type === "add_task_comment");
  const onList = () => update(model([], ready(SEVEN)), "3");
  const onCard = () => update(onList(), "enter");

  /** The chunks go through one reader, the way the loop reads them. */
  const feedAll = (m: Model, chunks: string[]) => {
    const reader = createInputReader();
    return chunks.reduce((acc, c) => applyInput(acc, c, WIDE, reader), m);
  };

  test("task_g4jy_paste_split_over_three_chunks_outside_typing_does_nothing", () => {
    const start = onList();
    const m = feedAll(start, [
      `${START}error at line 5: c`,
      "abc t m q 3 4\r more c\r",
      `tail c\r${END}`,
    ]);
    expect(m.taskInput).toBeNull();
    expect(m.input).toBeNull();
    expect(m.section).toBe(2);
    expect(m.mouse).toBe(false);
    expect(m.quit).toBe(false);
    // Only what the screen asks for by itself (the card it shows); nothing a key would have done.
    expect(m.effects).toEqual(start.effects);
    expect(m.tasks.selected).toBe(start.tasks.selected);
  });

  test("task_g4jy_paste_on_a_card_does_not_open_a_comment", () => {
    const m = feedAll(onCard(), [`${START}fix the c bug\nmore${END}`]);
    expect(m.taskInput).toBeNull();
    expect(write(m)).toEqual([]);
  });

  test("task_g4jy_probe_without_brackets_cannot_open_a_comment_from_a_list_row", () => {
    // The review's probe: a terminal without bracketed paste delivers a log in pieces.
    for (const start of [onList(), model([], ready(SEVEN))]) {
      const m = feedAll(start, ["error at line 5: abc", "def stack trace\nmore lines\n"]);
      expect(m.taskInput).toBeNull();
      expect(write(m)).toEqual([]);
    }
  });

  test("task_g4jy_c_on_a_list_row_opens_nothing", () => {
    expect(update(onList(), "c").taskInput).toBeNull();
    const backlog = model([], ready(SEVEN));
    expect(backlog.pick.kind).toBe("task");
    expect(backlog.focus).toBe("list");
    expect(update(backlog, "c").taskInput).toBeNull();
    expect(update(update(backlog, "enter"), "c").taskInput).toMatchObject({
      key: "T-A1",
      text: "",
    });
  });

  test("task_g4jy_bracketed_paste_into_an_open_comment_is_one_line_and_does_not_save", () => {
    let m = update(onCard(), "c");
    m = feedAll(m, [`${START}line one\nline two\r\nend${END}`]);
    expect(m.taskInput).toMatchObject({ key: "T-A1", text: "line one line two end" });
    expect(write(m)).toEqual([]);
    // Enter, then `y`, each typed by hand and after a pause, is the only save.
    expect(write(lone(m, "\r"))).toEqual([]);
    expect(write(saved(m))).toEqual([
      { type: "add_task_comment", key: "T-A1", text: "line one line two end" },
    ]);
  });

  test("task_g4jy_pasted_comment_is_cut_at_500_characters", () => {
    let m = update(onCard(), "c");
    m = pasteText(m, "x".repeat(450));
    m = pasteText(m, "y".repeat(100));
    expect(m.taskInput?.text.length).toBe(500);
    expect(pasteText(m, "z")).toBe(m);
  });

  test("task_g4jy_paste_outside_an_input_is_ignored_whole", () => {
    const m = onCard();
    expect(pasteText(m, "q\rc\r")).toBe(m);
  });

  test("task_g4jy_paste_into_a_gate_comment_input_is_text", () => {
    const m = { ...onList(), input: { text: "a", severity: "major", place: "x", openedAt: 0 } };
    expect(pasteText(m, "b\nc").input?.text).toBe("ab c");
  });

  test("task_g4jy_paste_markers_split_anywhere_still_make_one_paste", () => {
    const whole = `x${START}hello c world${END}y`;
    for (let cut = 1; cut < whole.length; cut++) {
      const reader = createInputReader();
      const events = [...reader.feed(whole.slice(0, cut)), ...reader.feed(whole.slice(cut))];
      expect(events).toEqual([
        { type: "key", name: "x" },
        { type: "paste", text: "hello c world" },
        { type: "key", name: "y" },
      ]);
    }
  });

  test("task_g4jy_a_lone_escape_before_the_marker_is_held_and_is_not_an_escape_key", () => {
    const reader = createInputReader();
    expect(reader.feed(ESC, 0)).toEqual([]);
    expect(reader.feed(`[200~q${END}`, 10)).toEqual([{ type: "paste", text: "q" }]);
  });

  test("task_g4jy_a_held_escape_is_the_escape_key_after_a_short_wait", () => {
    const reader = createInputReader();
    expect(reader.feed(ESC, 0)).toEqual([]);
    expect(reader.flush(HOLD_MS - 1)).toEqual([]);
    expect(reader.flush(HOLD_MS)).toEqual([{ type: "key", name: "escape" }]);
    expect(reader.flush(HOLD_MS + 100)).toEqual([]);
    // The next chunk after a long wait gives it up first, then reads on.
    expect(reader.feed(ESC, 1000)).toEqual([]);
    expect(reader.feed("q", 2000)).toEqual([
      { type: "key", name: "escape" },
      { type: "key", name: "q" },
    ]);
  });

  test("task_g4jy_a_held_escape_with_an_arrow_cut_after_it_is_the_arrow", () => {
    const reader = createInputReader();
    expect(reader.feed(ESC, 0)).toEqual([]);
    expect(reader.feed("[A", 5)).toEqual([{ type: "key", name: "up" }]);
  });

  test("task_g4jy_a_cut_marker_does_not_cancel_an_open_comment_or_restore_back", () => {
    let m = update(onCard(), "c");
    m = feedAll(m, ["hi"]);
    const reader = createInputReader();
    m = applyInput(m, ESC, WIDE, reader);
    m = applyInput(m, `[200~pasted${END}`, WIDE, reader);
    expect(m.taskInput?.text).toBe("hipasted");
    expect(m.notice).not.toBe("Cancelled.");
  });

  test("task_g4jy_a_cut_off_marker_that_is_not_continued_is_dropped_and_keys_work_again", () => {
    const reader = createInputReader();
    // Alt+[ and then, a moment later, q: the q is a key.
    expect(reader.feed(`${ESC}[`, 0)).toEqual([]);
    expect(reader.feed("q", 500)).toEqual([{ type: "key", name: "q" }]);
    expect(reader.feed(`${ESC}[2`, 1000)).toEqual([]);
    expect(reader.flush(1000 + HOLD_MS)).toEqual([]);
    expect(reader.feed("q", 1100)).toEqual([{ type: "key", name: "q" }]);
  });

  test("task_g4jy_an_unterminated_paste_is_capped_and_dropped", () => {
    const reader = createInputReader();
    // Too long to keep: nothing of it is handed on, but the person is told why the keys that follow are dropped.
    expect(reader.feed(`${START}${"x".repeat(PASTE_MAX + 10)}`, 0)).toEqual([
      { type: "paste", text: "", givenUp: true },
    ]);
    // Still inside the dropped paste: nothing is read as keys until its end marker.
    expect(reader.feed("qqq", 10)).toEqual([]);
    expect(reader.feed(`${END}q`, 20)).toEqual([{ type: "key", name: "q" }]);
  });

  test("task_g4jy_a_paste_whose_end_never_comes_is_given_up_5_seconds_after_its_start", () => {
    const reader = createInputReader();
    expect(reader.feed(`${START}half`, 0)).toEqual([]);
    // Keys that keep coming do not keep it open: the time runs from the start. What came is kept as pasted text.
    expect(reader.feed("q", 2000)).toEqual([]);
    expect(reader.feed("q", 4000)).toEqual([]);
    expect(reader.feed("q", PASTE_IDLE_MS + 1)).toEqual([
      { type: "paste", text: "halfqq", givenUp: true },
      { type: "key", name: "q" },
    ]);
  });

  test("task_g4jy_ctrl_c_quits_even_inside_a_paste_or_its_discarded_rest", () => {
    const reader = createInputReader();
    expect(reader.feed(`${START}half`, 0)).toEqual([]);
    expect(reader.feed("\u0003", 10)).toEqual([{ type: "key", name: "ctrl-c" }]);
    expect(reader.feed("q", 20)).toEqual([{ type: "key", name: "q" }]);
    expect(reader.feed(`${START}${"x".repeat(PASTE_MAX + 5)}`, 30)).toEqual([
      { type: "paste", text: "", givenUp: true },
    ]);
    expect(reader.feed("more\u0003", 40)).toEqual([{ type: "key", name: "ctrl-c" }]);
    const m = feedAll(onCard(), [`${START}text`, "\u0003"]);
    expect(m.quit).toBe(true);
  });

  /** The chunks go through one reader on one fake clock that the model shares, `gap` ms apart. */
  const feedSpaced = (m: Model, chunks: string[], gap = 1000, from = NOW) => {
    const reader = createInputReader();
    return chunks.reduce((acc, c, i) => applyInput(acc, c, WIDE, reader, from + i * gap), m);
  };

  test("task_g4jy_an_end_marker_inside_the_pasted_text_cannot_save_a_comment", () => {
    // The review's probe: the paste ends early and what follows is read as keys. The pauses are all over, so it is
    // the other layers that hold: the line break arrives with text, and no question was ever asked.
    const m = feedSpaced(onCard(), [`${START}harmless ${END}c`, `pwned\r${END}`, "y"]);
    expect(write(m)).toEqual([]);
    expect(m.taskInput?.confirmAt).toBeUndefined();
    expect(m.taskInput?.text).toBe("pwnedy");
  });

  test("task_g4jy_a_line_break_with_text_after_the_pause_asks_nothing", () => {
    // The time guard is satisfied (1 s after the input opened); the lone-key rule alone holds.
    for (const text of ["evil text\r", "evil\rtext", "\ry"]) {
      const m = feedSpaced(onCard(), ["c", text]);
      expect(m.taskInput?.confirmAt).toBeUndefined();
      expect(write(m)).toEqual([]);
    }
  });

  test("task_g4jy_a_bracketed_paste_with_line_breaks_after_the_pause_asks_nothing", () => {
    // The time guard is satisfied; the brackets alone hold: pasted line breaks are spaces, never Enter.
    const m = feedSpaced(onCard(), ["c", `${START}line one\rline two\r${END}`, `${START}\r${END}`]);
    expect(m.taskInput?.confirmAt).toBeUndefined();
    expect(m.taskInput?.text).toBe("line one line two  ");
    expect(write(m)).toEqual([]);
  });

  test("task_g4jy_a_person_pressing_enter_and_y_at_human_speed_does_save", () => {
    const m = feedSpaced(onCard(), ["c", "hi", "\r", "y"], 600);
    expect(write(m)).toEqual([{ type: "add_task_comment", key: "T-A1", text: "hi" }]);
  });

  test("task_g4jy_a_paste_split_after_c_cannot_save_a_comment_without_brackets", () => {
    // The review's probes: a terminal without bracketed paste delivers a log in pieces.
    for (const chunks of [
      ["c", "evil text\r more"],
      ["see log c", "evil text\r"],
    ]) {
      const m = feedSpaced(onCard(), chunks);
      expect(write(m)).toEqual([]);
    }
    // Pieces that follow each other faster than a person can press anything: the pauses hold.
    const tight = feedSpaced(onCard(), ["c", "x", "\r", "y"], 10);
    expect(write(tight)).toEqual([]);
  });

  test("task_g4jy_a_paste_longer_than_the_cap_in_one_chunk_is_dropped", () => {
    const reader = createInputReader();
    expect(reader.feed(`${START}${"x".repeat(PASTE_MAX + 1)}${END}q`)).toEqual([
      { type: "key", name: "q" },
    ]);
  });

  test("task_g4jy_a_comment_is_let_go_when_the_card_moves_on_to_another_task", () => {
    let m = update(onCard(), "c");
    m = feedAll(m, ["hi"]);
    expect(m.taskInput?.key).toBe("T-A1");
    const gone = withTasks(m, ready([row("T-B1", "normal")]));
    expect(gone.taskInput).toBeNull();
    expect(gone.notice).toContain("Comment cancelled");
    expect(write(applyInput(gone, "\r", WIDE))).toEqual([]);
  });

  test("task_g4jy_a_comment_is_let_go_when_the_backlog_task_leaves_the_block", () => {
    // No runs: T-A1 is picked at once; its card has the focus and a comment is being typed.
    let m = update(model([], ready(SEVEN.slice(0, 3))), "enter");
    m = update(m, "c");
    expect(m.taskInput?.key).toBe("T-A1");
    const started = ready(
      [row("T-A2", "high"), row("T-B1", "normal")],
      [row("T-A1", "high", { state: "progress", status: "progress" })],
    );
    const after = withTasks(m, started);
    expect(after.taskInput).toBeNull();
    expect(after.notice).toContain("Comment cancelled");
  });

  test("task_g4jy_a_comment_stays_while_the_task_stays_on_the_card", () => {
    let m = update(onCard(), "c");
    m = feedAll(m, ["hi"]);
    const same = withTasks(m, ready(SEVEN));
    expect(same.taskInput).toMatchObject({ key: "T-A1", text: "hi" });
  });
});

describe("the layers that make a comment a deliberate act", () => {
  const write = (m: Model) => m.effects.filter((e) => e.type === "add_task_comment");
  const onScreen = () => update(update(model([], ready(SEVEN)), "3"), "enter");
  const typed = (text: string) => press(onScreen(), ["c", ...[...text]]);

  test("task_g4jy_any_key_but_y_on_the_question_goes_back_to_the_text", () => {
    let m = lone(typed("keep me"), "\r");
    expect(m.taskInput?.confirmAt).toBeDefined();
    m = lone(m, "n");
    expect(m.taskInput?.confirmAt).toBeUndefined();
    expect(m.taskInput?.text).toBe("keep me");
    expect(write(m)).toEqual([]);
    // And it can be asked again and answered.
    expect(write(saved(m))).toEqual([{ type: "add_task_comment", key: "T-A1", text: "keep me" }]);
  });

  test("task_g4jy_escape_on_the_question_cancels_everything", () => {
    const m = lone(lone(typed("never sent"), "\r"), "\u001b");
    expect(m.taskInput).toBeNull();
    expect(m.notice).toBe("Cancelled.");
    expect(write(m)).toEqual([]);
  });

  test("task_g4jy_a_y_inside_the_pause_after_the_question_is_ignored", () => {
    const asked = lone(typed("x"), "\r");
    const early = applyInput({ ...asked, now: (asked.taskInput?.confirmAt ?? 0) + 399 }, "y", WIDE);
    expect(write(early)).toEqual([]);
    expect(early.taskInput?.confirmAt).toBeDefined();
    const ok = applyInput({ ...asked, now: (asked.taskInput?.confirmAt ?? 0) + 400 }, "y", WIDE);
    expect(write(ok)).toHaveLength(1);
  });

  test("task_g4jy_enter_inside_the_pause_after_the_input_opened_is_ignored", () => {
    const m = typed("x");
    const open = m.taskInput?.openedAt ?? 0;
    expect(applyInput({ ...m, now: open + 399 }, "\r", WIDE).taskInput?.confirmAt).toBeUndefined();
    expect(applyInput({ ...m, now: open + 400 }, "\r", WIDE).taskInput?.confirmAt).toBeDefined();
  });

  test("task_g4jy_a_paste_while_the_question_is_up_does_not_touch_the_text", () => {
    const asked = lone(typed("abc"), "\r");
    expect(pasteText(asked, "more").taskInput?.text).toBe("abc");
  });

  test("task_g4jy_the_input_line_shows_the_end_of_a_long_text_and_the_cursor", () => {
    const long = `${"head ".repeat(60)}THE-END`;
    const m = pasteText(update(onScreen(), "c"), long);
    for (const size of [WIDE, NARROW, { cols: 50, rows: 30 }]) {
      const line = lines(m, size).at(-1) ?? "";
      expect(line).toContain("THE-END");
      expect(line).toContain("…");
      expect(line).not.toContain("head head head head head head head head head head head head");
      expect(visibleLength(line)).toBeLessThanOrEqual(size.cols);
    }
  });

  test("task_g4jy_the_question_shows_the_end_of_a_long_text", () => {
    const long = `${"head ".repeat(60)}THE-END`;
    const asked = lone(pasteText(update(onScreen(), "c"), long), "\r");
    for (const size of [WIDE, NARROW]) {
      const line = lines(asked, size).at(-1) ?? "";
      expect(line).toMatch(/Save (this comment )?to T-A1\?/);
      expect(line).toContain("y save");
      expect(line).toContain("THE-END»");
      expect(visibleLength(line)).toBeLessThanOrEqual(size.cols);
    }
  });

  test("task_g4jy_the_cut_at_500_never_splits_a_character", () => {
    const m = pasteText(update(onScreen(), "c"), `${"a".repeat(499)}😀`);
    expect(m.taskInput?.text).toBe("a".repeat(499));
    // Typed by hand too: the key that would not fit whole is not taken.
    const t = press(update(onScreen(), "c"), [...Array.from({ length: 499 }, () => "a"), "😀"]);
    expect(t.taskInput?.text.length).toBe(499);
    expect(pasteText(update(onScreen(), "c"), `${"a".repeat(498)}😀`).taskInput?.text.length).toBe(
      500,
    );
  });

  test("task_g4jy_a_lone_surrogate_is_not_text_and_does_not_reach_the_tracker", () => {
    expect(stripLoneSurrogates("a\ud83dxb\ude00c😀")).toBe("axbc😀");
    const m = pasteText(update(onScreen(), "c"), "a\ud83db");
    expect(m.taskInput?.text).toBe("ab");
    expect(update(update(onScreen(), "c"), "\ud83d").taskInput?.text).toBe("");
  });

  test("task_g4jy_a_paste_into_a_gate_comment_is_cut_at_500_characters", () => {
    const m = {
      ...onScreen(),
      input: { text: "a".repeat(490), severity: "major", place: "x", openedAt: 0 },
    };
    expect(pasteText(m, "b".repeat(100)).input?.text.length).toBe(500);
    expect(pasteText(pasteText(m, "b".repeat(100)), "c").input?.text.length).toBe(500);
  });

  test("task_g4jy_c_never_opens_on_a_task_the_person_did_not_pick_on_the_new_screen", () => {
    // Enter on a run card in Sessions gives the card the focus; the focus must not come along to the Tasks screen.
    const runs = model([session("r_1", "running")], ready(SEVEN));
    const inRun = update(runs, "enter");
    expect(inRun.focus).toBe("card");
    for (const go of ["3", "tab"]) {
      const m = update(inRun, go);
      expect(m.section).toBe(go === "3" ? 2 : 1);
      expect(m.focus).toBe("list");
    }
    expect(update(update(inRun, "3"), "c").taskInput).toBeNull();
  });
});

describe("what the fifth review found", () => {
  const ESC = "\u001b";
  const START = `${ESC}[200~`;
  const END = `${ESC}[201~`;
  const write = (m: Model) => m.effects.filter((e) => e.type === "add_task_comment");
  const onScreen = () => update(update(model([], ready(SEVEN)), "3"), "enter");
  const typed = (text: string) => press(onScreen(), ["c", ...[...text]]);

  test("task_g4jy_the_text_the_person_confirmed_is_the_text_that_is_sent", () => {
    // Persian ZWNJ, an emoji ZWJ sequence and a variation selector are parts of words and letters, not noise.
    for (const text of ["می‌خواهم", "family 👨‍👩‍👧 ok", "heart ❤️ done"]) {
      expect(write(saved(typed(text)))).toEqual([{ type: "add_task_comment", key: "T-A1", text }]);
    }
  });

  test("task_g4jy_clean_comment_removes_controls_and_lone_surrogates_and_nothing_else", () => {
    expect(cleanComment("a\u0000b\u001bc\u007fd\u0085e")).toBe("abcde");
    expect(cleanComment("a\ud83db\ude00c")).toBe("abc");
    expect(cleanComment("می‌خواهم ❤️ 👨‍👩‍👧 ​")).toBe("می‌خواهم ❤️ 👨‍👩‍👧 ​");
  });

  test("task_g4jy_a_control_character_is_not_taken_as_typed_text", () => {
    expect(press(update(onScreen(), "c"), ["a", "\u0085", "\u007f", "b"]).taskInput?.text).toBe(
      "ab",
    );
  });

  test("task_g4jy_a_comment_with_nothing_visible_is_refused_at_enter_with_a_notice", () => {
    for (const blank of ["​", "​‌ ﻿", "⁠"]) {
      const m = lone(typed(blank), "\r");
      expect(m.taskInput).toBeNull();
      expect(m.notice).toBe("Nothing to save: the comment is empty.");
      expect(write(m)).toEqual([]);
    }
    // A text with a joiner among letters is not blank.
    expect(lone(typed("a‌b"), "\r").taskInput?.confirmAt).toBeDefined();
  });

  test("task_g4jy_enter_inside_the_pause_says_to_wait_instead_of_dropping_silently", () => {
    const m = typed("x");
    const open = m.taskInput?.openedAt ?? 0;
    const early = applyInput({ ...m, now: open + 100 }, "\r", WIDE);
    expect(early.taskInput?.confirmAt).toBeUndefined();
    expect(lines(early).at(-1)).toContain("Wait a moment, then press Enter again.");
    // The input is still on the line, and typing goes on and clears the notice.
    expect(lines(early).at(-1)).toContain("Comment on T-A1: x");
    expect(update(early, "y").notice).toBe("");
  });

  test("task_g4jy_y_inside_the_pause_says_to_wait_and_saves_after_it_a_capital_y_edits", () => {
    const asked = lone(typed("x"), "\r");
    const at = asked.taskInput?.confirmAt ?? 0;
    const early = applyInput({ ...asked, now: at + 100 }, "y", WIDE);
    expect(write(early)).toEqual([]);
    expect(early.taskInput?.confirmAt).toBeDefined();
    expect(lines(early).at(-1)).toContain("Wait a moment, then press y.");
    expect(write(applyInput({ ...asked, now: at + 400 }, "y", WIDE))).toHaveLength(1);
    // Not alone in its chunk: it is not the key.
    expect(write(applyInput({ ...asked, now: at + 400 }, "yy", WIDE))).toEqual([]);
    // Only a lowercase `y` saves, as the line says: `Y` goes back to the text like any other key.
    const capital = applyInput({ ...asked, now: at + 400 }, "Y", WIDE);
    expect(write(capital)).toEqual([]);
    expect(capital.taskInput?.confirmAt).toBeUndefined();
    expect(capital.taskInput?.text).toBe("x");
  });

  test("task_g4jy_enter_as_crlf_or_cr_nul_is_one_enter_and_confirms", () => {
    for (const enter of ["\r\n", "\r\0"]) {
      const asked = lone(typed("hi"), enter);
      expect(asked.taskInput?.confirmAt).toBeDefined();
      expect(asked.taskInput?.text).toBe("hi");
      expect(write(lone(asked, "y"))).toEqual([
        { type: "add_task_comment", key: "T-A1", text: "hi" },
      ]);
    }
  });

  test("task_g4jy_crlf_with_other_bytes_is_not_the_enter_key", () => {
    for (const chunk of ["\r\nmore", "text\r\n", "\r\n\r\n"]) {
      const m = lone(typed("hi"), chunk);
      expect(m.taskInput?.confirmAt).toBeUndefined();
      expect(write(m)).toEqual([]);
    }
  });

  test("task_g4jy_a_slow_link_that_dribbles_a_paste_in_never_makes_keys", () => {
    const reader = createInputReader();
    const events = [...reader.feed(`${START}a`, 0)];
    // Pieces 700 ms apart for 20 s, full of keys that would quit or press y.
    for (let t = 700; t <= 20_000; t += 700) events.push(...reader.feed("qyd\r", t));
    expect(events.filter((e) => e.type === "key")).toEqual([]);
    // The part that came before the give-up was handed on once, as text.
    expect(events.filter((e) => e.type === "paste")).toHaveLength(1);
    // The end marker ends the dropped rest; keys work again.
    expect(reader.feed(`${END}q`, 20_100)).toEqual([{ type: "key", name: "q" }]);
  });

  test("task_g4jy_a_broken_terminal_with_no_end_marker_gives_the_keys_back_after_a_pause", () => {
    const reader = createInputReader();
    expect(reader.feed(`${START}x`, 0)).toEqual([]);
    for (let t = 600; t <= 4800; t += 600) expect(reader.feed("m", t)).toEqual([]);
    // The give-up: what came is handed on as text; this piece and the following ones are dropped.
    const given = reader.feed("a", 5400);
    expect(given.map((e) => e.type)).toEqual(["paste"]);
    expect(reader.feed("q", 5800)).toEqual([]);
    // A pause longer than DISCARD_GAP_MS ends it: the next chunk is a key.
    expect(reader.feed("q", 5800 + DISCARD_GAP_MS + 1)).toEqual([{ type: "key", name: "q" }]);
  });

  test("task_g4jy_text_that_came_before_the_give_up_stays_in_the_open_comment", () => {
    const reader = createInputReader();
    let m = applyInput(typed(""), `${START}abc`, WIDE, reader, NOW);
    m = applyInput(m, "e", WIDE, reader, NOW + PASTE_IDLE_MS + 1000);
    expect(m.taskInput?.text).toBe("abce");
  });
});

describe("what the sixth review found", () => {
  const ESC = "\u001b";
  const START = `${ESC}[200~`;
  const END = `${ESC}[201~`;
  const T0 = NOW;
  const write = (m: Model) => m.effects.filter((e) => e.type === "add_task_comment");
  const onCard = () => update(update(model([], ready(SEVEN)), "3"), "enter");
  /** A comment on the card, opened at T0 with `hi` typed; the guard has run out at T0 + 500. */
  const open = (): [Model, ReturnType<typeof createInputReader>] => {
    const reader = createInputReader();
    let m = applyInput(onCard(), "c", WIDE, reader, T0);
    m = applyInput(m, "hi", WIDE, reader, T0 + 500);
    return [m, reader];
  };

  test("task_g4jy_crlf_inside_an_open_paste_is_paste_text_and_not_enter", () => {
    for (const enter of ["\r\n", "\r\0"]) {
      const [m0, reader] = open();
      let m = applyInput(m0, `${START}line1`, WIDE, reader, T0 + 1000);
      m = applyInput(m, enter, WIDE, reader, T0 + 1100);
      m = applyInput(m, `line2${END}`, WIDE, reader, T0 + 1200);
      expect(m.taskInput?.confirmAt).toBeUndefined();
      expect(write(m)).toEqual([]);
      expect(m.taskInput?.text.startsWith("hiline1")).toBe(true);
    }
  });

  test("task_g4jy_crlf_in_the_dropped_rest_of_a_paste_is_not_enter", () => {
    const [m0, reader] = open();
    let m = applyInput(m0, `${START}x`, WIDE, reader, T0 + 1000);
    // A burst: pieces 700 ms apart, so the give-up at 5 s leaves the rest being dropped.
    for (let t = 1700; t <= 6600; t += 700) m = applyInput(m, "z", WIDE, reader, T0 + t);
    expect(m.notice).toContain("Paste given up");
    m = applyInput(m, "\r\n", WIDE, reader, T0 + 7000);
    expect(m.taskInput?.confirmAt).toBeUndefined();
    expect(write(m)).toEqual([]);
  });

  test("task_g4jy_crlf_after_a_held_escape_does_not_turn_escape_into_enter", () => {
    const reader = createInputReader();
    expect(reader.feed(ESC, 0)).toEqual([]);
    expect(reader.feed("\r\n", 10)).toEqual([
      { type: "key", name: "escape" },
      { type: "key", name: "enter" },
      { type: "key", name: "enter" },
    ]);
    // Let go by the clock first: the Escape is delivered, and the line break is two keys, not one Enter.
    expect(reader.feed(ESC, 1000)).toEqual([]);
    expect(reader.feed("\r\n", 1000 + HOLD_MS + 20)).toEqual([
      { type: "key", name: "escape" },
      { type: "key", name: "enter" },
      { type: "key", name: "enter" },
    ]);
    // In a comment: Esc cancels it, and nothing asks "save it?".
    const [m0, r2] = open();
    let m = applyInput(m0, ESC, WIDE, r2, T0 + 1000);
    m = applyInput(m, "\r\n", WIDE, r2, T0 + 1010);
    expect(m.taskInput).toBeNull();
    expect(m.notice).toBe("Cancelled.");
    expect(write(m)).toEqual([]);
  });

  test("task_g4jy_a_lone_crlf_in_plain_typing_is_still_one_enter", () => {
    const reader = createInputReader();
    expect(reader.feed("\r\n", 0)).toEqual([{ type: "key", name: "enter" }]);
    expect(reader.feed("\r\0", 10)).toEqual([{ type: "key", name: "enter" }]);
    expect(reader.feed("\r\nx", 20)).toEqual([
      { type: "key", name: "enter" },
      { type: "key", name: "enter" },
      { type: "key", name: "x" },
    ]);
  });

  test("task_g4jy_a_given_up_paste_hands_on_its_text_and_says_why_keys_are_dropped", () => {
    const reader = createInputReader();
    expect(reader.feed(`${START}abc`, 0)).toEqual([]);
    for (let t = 700; t <= 4900; t += 700) expect(reader.feed("x", t)).toEqual([]);
    expect(reader.feed("late", 5600)).toEqual([
      { type: "paste", text: "abcxxxxxxx", givenUp: true },
    ]);
  });

  test("task_g4jy_a_give_up_inside_a_burst_keeps_the_text_before_it_and_tells_the_person", () => {
    const [m0, r2] = open();
    let m = applyInput(m0, `${START}abc`, WIDE, r2, T0 + 1000);
    for (let t = 1700; t <= 5900; t += 700) m = applyInput(m, "x", WIDE, r2, T0 + t);
    // Inside a burst the give-up chunk itself is dropped; the text before it stays in the input, and the person is told.
    m = applyInput(m, "ZZZ", WIDE, r2, T0 + 6600);
    expect(m.taskInput?.text.startsWith("hiabcx")).toBe(true);
    expect(m.taskInput?.text).not.toContain("ZZZ");
    expect(m.notice).toContain("Paste given up");
    // Keys that come while it is still being dropped are dropped, even q.
    m = applyInput(m, "q", WIDE, r2, T0 + 6800);
    expect(m.taskInput).not.toBeNull();
    expect(m.quit).toBe(false);
  });

  test("task_g4jy_with_a_gap_over_a_second_after_the_five_seconds_the_rest_is_typed_as_keys", () => {
    // Said in the plan: a paste that dribbles in with a gap longer than DISCARD_GAP_MS after the give-up is over.
    const reader = createInputReader();
    expect(reader.feed(`${START}a`, 0)).toEqual([]);
    const events = [];
    for (let t = 700; t <= 5600; t += 700) events.push(...reader.feed("x", t));
    expect(events.map((e) => e.type)).toEqual(["paste"]);
    expect(reader.feed("q", 5600 + DISCARD_GAP_MS + 500)).toEqual([{ type: "key", name: "q" }]);
  });

  test("task_g4jy_the_timer_gives_up_a_paste_and_ends_the_dropped_rest_without_a_key", () => {
    const reader = createInputReader();
    expect(reader.feed(`${START}half`, 0)).toEqual([]);
    expect(reader.flush(PASTE_IDLE_MS - 1)).toEqual([]);
    expect(reader.flush(PASTE_IDLE_MS + 1)).toEqual([
      { type: "paste", text: "half", givenUp: true },
    ]);
    // No key came: the silence ends the dropped rest, and the next key is a key.
    expect(reader.feed("q", PASTE_IDLE_MS + 2)).toEqual([{ type: "key", name: "q" }]);
  });

  test("task_g4jy_infinity_gives_up_what_is_held_and_not_an_open_paste", () => {
    const reader = createInputReader();
    expect(reader.feed(`${START}abc`, 0)).toEqual([]);
    expect(reader.flush(Number.POSITIVE_INFINITY)).toEqual([]);
    expect(reader.feed(END, 10)).toEqual([{ type: "paste", text: "abc" }]);
  });

  test("task_g4jy_text_held_by_the_timer_appears_in_the_open_comment_without_a_key", () => {
    const [m0, reader] = open();
    const m1 = applyInput(m0, `${START}half`, WIDE, reader, T0 + 1000);
    const at = T0 + 1000 + PASTE_IDLE_MS + 1;
    const m2 = applyEvents(m1, reader.flush(at), WIDE, at);
    expect(m2.taskInput?.text).toBe("hihalf");
    expect(m2.notice).toContain("Paste given up");
  });

  test("task_g4jy_enter_in_the_list_of_the_give_up_is_not_silent", () => {
    const [m0, reader] = open();
    let m = applyInput(m0, `${START}abc`, WIDE, reader, T0 + 1000);
    // A pause of a few seconds, then Enter: the give-up and the Enter arrive together, so the Enter is not taken.
    m = applyInput(m, "\r", WIDE, reader, T0 + 8000);
    expect(m.taskInput?.text).toBe("hiabc");
    expect(m.taskInput?.confirmAt).toBeUndefined();
    expect(m.notice).toContain("Wait a moment");
  });

  test("task_g4jy_a_paste_while_the_save_question_is_up_says_it_was_ignored", () => {
    const [m0, reader] = open();
    const asked = applyInput(m0, "\r", WIDE, reader, T0 + 1000);
    expect(asked.taskInput?.confirmAt).toBeDefined();
    const m = applyInput(asked, `${START}more text${END}`, WIDE, reader, T0 + 1500);
    expect(m.taskInput?.text).toBe("hi");
    expect(m.taskInput?.confirmAt).toBeDefined();
    expect(m.notice).toContain("pasted text was ignored");
    expect(write(m)).toEqual([]);
  });

  test("task_g4jy_a_non_alone_enter_in_a_task_comment_tells_the_person", () => {
    const [m0, reader] = open();
    const m = applyInput(m0, "more\r", WIDE, reader, T0 + 1000);
    expect(m.taskInput?.confirmAt).toBeUndefined();
    expect(m.notice).toContain("Wait a moment");
  });
});
