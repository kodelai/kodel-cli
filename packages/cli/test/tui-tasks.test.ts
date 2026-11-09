import { describe, expect, test } from "bun:test";
import { KodelError } from "@kodel-ai/pipeline-core";
import { fit, neutralize, stripAnsi } from "../src/tui/ansi";
import { demoSessions } from "../src/tui/demo";
import { demoTaskCard, demoTasks } from "../src/tui/demo-tasks";
import { loadSessions } from "../src/tui/load";
import type { Session } from "../src/tui/session";
import { TASKS_OFF } from "../src/tui/tasks";
import {
  type Answer,
  type CardSlot,
  loadTask,
  loadTasks,
  messageOf,
  type TaskRow,
  type TasksHandle,
  type TasksLoad,
  type TasksSource,
} from "../src/tui/tasks-load";
import { openTasksForTui, tuiTaskOptions } from "../src/tui/tasks-open";
import { createTasksRefresh, TASKS_EVERY_MS } from "../src/tui/tasks-refresh";
import {
  hitTest,
  initialModel,
  type Model,
  mouseUpdate,
  render,
  takeEffects,
  update,
  withData,
  withTask,
  withTasks,
} from "../src/tui/view";

const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
const WIDE = { cols: 120, rows: 30 };
const NARROW = { cols: 70, rows: 30 };
const ESC = "\u001b";

const lines = (m: Model, size = WIDE) => render(m, size).map(stripAnsi);
const screen = (m: Model, size = WIDE) => lines(m, size).join("\n");
const press = (m: Model, keys: string[], size = WIDE) =>
  keys.reduce((acc, k) => update(acc, k, size), m);

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

/** The adapter's order: priority, then oldest first. */
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
  ...(r.parent === undefined ? {} : { parent: r.parent }),
  run_count: r.runCount,
});

/** A source that pages like an adapter: the filter by state, a limit, a cursor that is an offset. */
function pagedSource(
  all: TaskRow[],
  extra: { problems?: unknown[]; calls?: string[] } = {},
): TasksSource {
  return {
    list: async (input): Promise<Answer> => {
      extra.calls?.push("list");
      const rows = all.filter((r) => input.state.includes(r.state));
      const from = input.cursor === undefined ? 0 : Number(input.cursor);
      const page = rows.slice(from, from + input.limit);
      const next = from + input.limit < rows.length ? String(from + input.limit) : undefined;
      return {
        ok: true,
        tasks: page.map(raw),
        truncated: false,
        problems: extra.problems ?? [],
        ...(next === undefined ? {} : { next }),
      } as Answer;
    },
    get: async (input): Promise<Answer> => {
      extra.calls?.push("get");
      const found = all.find((r) => r.key === input.key);
      if (!found) return { ok: false, message: `there is no task "${input.key}"` } as Answer;
      return { ok: true, task: { ...raw(found), runs: [], comments: [] }, subtasks: [] } as Answer;
    },
  };
}

const on = (source: TasksSource): TasksHandle => ({ status: "on", source });

/** The keys shown in the Backlog block, in order. */
const blockKeys = (m: Model, size = WIDE): string[] => {
  const text = lines(m, size);
  const at = text.findIndex((l) => l.includes("BACKLOG ·"));
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of text.slice(at + 1)) {
    const key = /^[ ›]?\s?(T-[A-Z0-9]+)/.exec(l.slice(0, 14))?.[1];
    if (key === undefined) break;
    out.push(key);
  }
  return out;
};

describe("the Backlog block", () => {
  test("task_g4jy_backlog_takes_five_todo_tasks_in_adapter_order", async () => {
    // The adapter's order, every state; a task in progress, a done one and a declined one are among them.
    const all: TaskRow[] = [
      row("T-A1", "high"),
      row("T-A2", "high"),
      row("T-B1", "normal"),
      row("T-P1", "normal", { state: "progress", status: "progress" }),
      row("T-D1", "normal", { state: "done", status: "done" }),
      row("T-B2", "normal"),
      row("T-C1", "low"),
      row("T-X1", "low", { state: "done", status: "declined" }),
      row("T-C2", "low"),
      row("T-C3", "low"),
    ];
    const load = await loadTasks(on(pagedSource(all)));
    const m = model([session("r_1", "running")], load);
    expect(blockKeys(m)).toEqual(["T-A1", "T-A2", "T-B1", "T-B2", "T-C1"]);
    expect(screen(m)).toContain("BACKLOG · 5 of 7");
  });

  test("task_g4jy_backlog_with_few_tasks", () => {
    const m = model([], ready(SEVEN.slice(0, 3)));
    expect(blockKeys(m)).toEqual(["T-A1", "T-A2", "T-B1"]);
    expect(screen(m)).toContain("BACKLOG · 3 of 3");
  });

  test("task_g4jy_backlog_with_no_tasks_has_no_block", () => {
    const m = model(
      [session("r_1", "running")],
      ready([], [row("T-D1", "low", { state: "done", status: "done" })]),
    );
    expect(screen(m)).not.toContain("BACKLOG");
  });

  test("task_g4jy_backlog_active_run_table", () => {
    const hidden: Session["status"][] = ["waiting", "running"];
    const shown: Session["status"][] = ["done", "failed", "canceled", "unreadable"];
    for (const status of [...hidden, ...shown]) {
      const m = model([session("r_1", status, "T-A1")], ready(SEVEN));
      const keys = blockKeys(m);
      if (hidden.includes(status)) {
        expect(keys).not.toContain("T-A1");
        expect(screen(m)).toContain("BACKLOG · 5 of 6");
      } else {
        expect(keys).toContain("T-A1");
        expect(screen(m)).toContain("BACKLOG · 5 of 7");
      }
    }
  });

  test("task_g4jy_backlog_ignores_runs_of_other_tasks", () => {
    const m = model(
      [session("r_1", "running", "T-OTHER"), session("r_2", "running"), session("r_3", "waiting")],
      ready(SEVEN),
    );
    expect(blockKeys(m)).toEqual(["T-A1", "T-A2", "T-B1", "T-B2", "T-B3"]);
    expect(screen(m)).toContain("BACKLOG · 5 of 7");
  });

  test("task_g4jy_backlog_follows_runs_between_reads", () => {
    // Six eligible tasks were read; the block shows five of them.
    let m = model([], ready(SEVEN.slice(0, 6)));
    expect(blockKeys(m)).toEqual(["T-A1", "T-A2", "T-B1", "T-B2", "T-B3"]);
    expect(screen(m)).toContain("BACKLOG · 5 of 6");
    // A run starts for the first one before the tasks are read again: still five rows, one fewer in all.
    m = withData(m, { sessions: [session("r_1", "waiting", "T-A1")], proposals: 0 }, NOW);
    expect(blockKeys(m)).toEqual(["T-A2", "T-B1", "T-B2", "T-B3", "T-C1"]);
    expect(screen(m)).toContain("BACKLOG · 5 of 5");
    // The run ends: the task comes back.
    m = withData(m, { sessions: [session("r_1", "done", "T-A1")], proposals: 0 }, NOW);
    expect(blockKeys(m)[0]).toBe("T-A1");
  });

  test("task_g4jy_finished_tasks_only_on_the_screen", () => {
    const done = row("T-D1", "normal", { state: "done", status: "done" });
    const declined = row("T-X1", "low", { state: "done", status: "declined" });
    const m = model([], ready(SEVEN, [done, declined]));
    expect(blockKeys(m)).not.toContain("T-D1");
    expect(blockKeys(m)).not.toContain("T-X1");
    const text = screen(update(m, "3"));
    expect(text).toContain("T-D1");
    expect(text).toContain("T-X1");
  });

  test("task_g4jy_backlog_right_past_200_tasks", async () => {
    const olderDone = Array.from({ length: 300 }, (_, i) =>
      row(`T-D${String(i).padStart(3, "0")}`, "high", { state: "done", status: "done" }),
    );
    const six = SEVEN.slice(0, 6);
    const load = await loadTasks(on(pagedSource([...olderDone, ...six])));
    if (load.status !== "ready") throw new Error("not ready");
    // The screen's page is cut at 200 and holds only finished tasks; the Backlog has its own query.
    expect(load.more).toBe(true);
    const m = model([], load);
    expect(blockKeys(m)).toEqual(["T-A1", "T-A2", "T-B1", "T-B2", "T-B3"]);
    expect(screen(m)).toContain("BACKLOG · 5 of 6");
    // More unstarted tasks than the pages read: the count says it is a lower bound.
    const many = Array.from({ length: 1000 }, (_, i) =>
      row(`T-M${String(i).padStart(4, "0")}`, "normal"),
    );
    const cut = await loadTasks(on(pagedSource(many)));
    if (cut.status !== "ready") throw new Error("not ready");
    expect(cut.todoCut).toBe(true);
    expect(screen(model([], cut))).toContain("BACKLOG · 5 of 800+");
  });

  test("task_g4jy_unknown_priority_is_shown_as_given", () => {
    const odd = [
      row("T-U1", "Urgent"),
      row("T-U2", "urgent"),
      { ...row("T-U3", ""), priority: undefined } as TaskRow,
    ];
    const m = model([], ready(odd));
    expect(blockKeys(m)).toEqual(["T-U1", "T-U2", "T-U3"]);
    expect(screen(m)).toContain("Urgent");
    expect(() => screen(update(m, "3"))).not.toThrow();
  });
});

describe("the Tasks screen", () => {
  const rows = [
    row("T-A1", "high"),
    row("T-A2", "normal", { parent: "T-A1" }),
    row("T-A3", "low", { parent: "T-GONE" }),
    row("T-P1", "normal", { state: "progress", status: "progress" }),
    row("T-D1", "normal", { state: "done", status: "done" }),
    row("T-X1", "low", { state: "done", status: "declined" }),
  ];
  const withScreen = (load: TasksLoad = ready(rows.slice(0, 3), rows.slice(3))) =>
    update(model([], load), "3");

  test("task_g4jy_tasks_screen_lists_all_groups", () => {
    const text = screen(withScreen());
    expect(text).toContain("TODO · 3");
    expect(text).toContain("IN PROGRESS · 1");
    expect(text).toContain("DONE · 2");
    for (const r of rows) expect(text).toContain(r.key);
    // A declined task is finished, so it is under DONE, after the group's heading.
    const all = lines(withScreen());
    expect(all.findIndex((l) => l.includes("T-X1"))).toBeGreaterThan(
      all.findIndex((l) => l.includes("DONE · 2")),
    );
    expect(screen(withScreen(ready([])))).toContain("No tasks.");
  });

  test("task_g4jy_tasks_screen_lists_only_key_title_and_priority", () => {
    const left =
      lines(withScreen())
        .map((l) => l.split("│")[0] ?? "")
        .find((l) => l.includes("T-A1")) ?? "";
    expect(left).toContain("title of T-A1");
    expect(left).toContain("high");
    expect(left).not.toContain("todo");
    expect(left).not.toContain("↳");
  });

  test("task_g4jy_tasks_screen_parent_mark", () => {
    const col = (key: string) =>
      (
        lines(withScreen())
          .map((l) => l.split("│")[0] ?? "")
          .find((l) => l.includes(`${key} `)) ?? ""
      ).indexOf(key);
    // A child of a task on the list is set in by two spaces; one whose parent is not listed is not.
    expect(col("T-A2")).toBe(col("T-A1") + 2);
    expect(col("T-A3")).toBe(col("T-A1"));
  });

  test("task_g4jy_tasks_screen_says_when_cut", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      row(`T-M${String(i).padStart(3, "0")}`, "normal"),
    );
    const text = screen(update(model([], ready(many, [], true)), "3"));
    expect(text).toContain("200 tasks · first 200 shown");
  });

  test("task_g4jy_tasks_screen_keys", () => {
    let m = withScreen();
    expect(m.tasks.selected).toBe("T-A1");
    m = update(m, "down");
    expect(m.tasks.selected).toBe("T-A2");
    m = update(m, "up");
    expect(m.tasks.selected).toBe("T-A1");
    // At the top it stays.
    expect(update(m, "up").tasks.selected).toBe("T-A1");
    m = update(m, "enter");
    expect(m.focus).toBe("card");
    // With the card in focus the arrows scroll it and do not move the selection.
    expect(update(m, "down").tasks.selected).toBe("T-A1");
    expect(update(m, "escape").focus).toBe("list");
    expect(update(update(m, "escape"), "right").focus).toBe("card");
    expect(update(m, "left").focus).toBe("list");
  });

  test("task_g4jy_tasks_screen_shared_keys", () => {
    const m = withScreen();
    expect(update(m, "q").quit).toBe(true);
    expect(update(m, "1").section).toBe(0);
    expect(update(m, "4").section).toBe(3);
    expect(update(m, "tab").section).toBe(3);
    expect(update(m, "z").zoom).toBe(true);
    expect(update(update(m, "z"), "z").zoom).toBe(false);
    expect(update(m, "m").mouse).toBe(true);
  });

  test("task_g4jy_task_card_content", () => {
    let m = withScreen();
    m = withTask(m, "T-A1", {
      status: "ready",
      card: {
        key: "T-A1",
        title: "title of T-A1",
        state: "todo",
        status: "todo",
        priority: "high",
        runs: ["r_known", "r_unknown"],
        body: "The body of the task.\n\nSecond paragraph.",
        comments: [
          { text: "A comment from the agent.", at: "2026-10-27T12:00:00.000Z", by: "agent" },
        ],
        subtasks: [{ key: "T-A2", title: "child" }],
      },
    });
    const text = screen({ ...m, sessions: [session("r_known", "running")] });
    expect(text).toContain("The body of the task.");
    expect(text).toContain("Second paragraph.");
    expect(text).toContain("A comment from the agent.");
    expect(text).toContain("2026-10-27 12:00 · agent");
    expect(text).toContain("r_known · running");
    expect(text).toContain("r_unknown");
    expect(text).not.toContain("r_unknown ·");
    expect(text).toContain("priority high");
    // A subtask is a row of its own with the priority and status the list knows, then its title.
    expect(text).toMatch(/T-A2\s+normal\s+todo\s+child/);
    // Without comments the card says so.
    const bare = withTask(m, "T-A1", {
      status: "ready",
      card: {
        key: "T-A1",
        title: "t",
        state: "todo",
        status: "todo",
        runs: [],
        comments: [],
        subtasks: [],
      },
    });
    expect(screen(bare)).toContain("No comments.");
  });

  test("task_g4jy_task_card_scrolls", () => {
    const body = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    let m = withTask(withScreen(), "T-A1", {
      status: "ready",
      card: {
        key: "T-A1",
        title: "t",
        state: "todo",
        status: "todo",
        runs: [],
        body,
        comments: [],
        subtasks: [],
      },
    });
    expect(screen(m)).toContain("PgDn for more");
    m = update(m, "enter");
    m = update(m, "pagedown");
    expect(m.tasks.scroll).toBeGreaterThan(0);
    expect(screen(m)).toContain("PgUp for earlier");
    expect(update(m, "pageup").tasks.scroll).toBe(0);
  });
});

describe("the card of a task", () => {
  test("task_g4jy_task_card_reread_and_failure", async () => {
    // A failed read (the task was deleted between the list and the card) is a line; the list stays.
    const source = pagedSource([row("T-A1", "high")]);
    const slot = await loadTask(on(source), "T-GONE");
    expect(slot).toEqual({ status: "failed", message: 'there is no task "T-GONE"' });
    const m = withTask(update(model([], ready([row("T-A1", "high")])), "3"), "T-A1", slot);
    const text = screen(m);
    expect(text).toContain('Cannot read this task: there is no task "T-GONE"');
    expect(text).toContain("T-A1");
    // The card of the selected task is read again with every list.
    const reads: string[] = [];
    const refresh = createTasksRefresh({
      load: async () => ready([]),
      loadCard: async (key) => {
        reads.push(key);
        return { status: "loading" };
      },
      onLoad: () => undefined,
      onCard: () => undefined,
      shownKey: () => "T-A1",
    });
    refresh.start(0);
    await Bun.sleep(5);
    refresh.tick(TASKS_EVERY_MS);
    await Bun.sleep(5);
    expect(reads).toEqual(["T-A1", "T-A1"]);
  });

  test("task_g4jy_card_read_is_an_effect_not_per_refresh", () => {
    // With no runs the first task of the block is picked at once, and its card is asked for.
    const m = model([], ready(SEVEN));
    expect(m.pick).toEqual({ kind: "task", key: "T-A1" });
    const [clean, effects] = takeEffects(m);
    expect(effects).toEqual([{ type: "load_task", key: "T-A1" }]);
    // A refresh of the runs asks for nothing.
    const [, again] = takeEffects(withData(clean, { sessions: [], proposals: 0 }, NOW + 2000));
    expect(again).toEqual([]);
    // The Tasks screen asks for its selected card once: not again when the card is already asked for.
    const fresh = update(model([], ready(SEVEN)), "3");
    expect(takeEffects(fresh)[1]).toEqual([{ type: "load_task", key: "T-A1" }]);
    const asked = takeEffects(fresh)[0];
    expect(takeEffects(update(asked, "1"))[1]).toEqual([]);
    expect(takeEffects(update(update(asked, "1"), "3"))[1]).toEqual([]);
    expect(takeEffects(update(asked, "down"))[1]).toEqual([{ type: "load_task", key: "T-A2" }]);
  });
});

describe("selecting in Sessions", () => {
  const two = () => [session("r_1", "running"), session("r_2", "running")];

  test("task_g4jy_selection_walks_runs_then_backlog", () => {
    let m = model(two(), ready(SEVEN.slice(0, 2)));
    expect(m.pick.kind).toBe("run");
    m = press(m, ["down"]);
    expect(m.selected).toBe(m.sessions[1]?.id ?? "");
    m = press(m, ["down"]);
    expect(m.pick).toEqual({ kind: "task", key: "T-A1" });
    m = press(m, ["down"]);
    expect(m.pick).toEqual({ kind: "task", key: "T-A2" });
    // The last row: it stays.
    expect(press(m, ["down"]).pick).toEqual({ kind: "task", key: "T-A2" });
    m = press(m, ["up", "up"]);
    expect(m.pick.kind).toBe("run");
    expect(m.selected).toBe(m.sessions[1]?.id ?? "");
  });

  test("task_g4jy_backlog_works_with_no_runs", () => {
    const m = model([], ready(SEVEN.slice(0, 2)));
    // The block is there and not the empty state.
    expect(screen(m)).toContain("BACKLOG · 2 of 2");
    expect(screen(m)).not.toContain("No runs yet.");
    const listRow = lines(m).findIndex((l) => (l.split("│")[0] ?? "").includes("T-A1")) + 1;
    expect(hitTest(m, WIDE, 3, listRow)).toEqual({ kind: "task", key: "T-A1" });
    // The keys work at once, without a first press of Down.
    expect(m.pick).toEqual({ kind: "task", key: "T-A1" });
    expect(update(m, "enter").focus).toBe("card");
    expect(update(m, "z").zoom).toBe(true);
    expect(update(m, "t").section).toBe(2);
  });

  test("task_g4jy_pick_falls_back_when_task_leaves", () => {
    let m = model([], ready(SEVEN.slice(0, 3)));
    m = update(m, "enter");
    expect(m.pick).toEqual({ kind: "task", key: "T-A1" });
    expect(m.focus).toBe("card");
    // The picked task gets a run: the pick goes to the first row and the focus to the list.
    m = withData(m, { sessions: [session("r_1", "running", "T-A1")], proposals: 0 }, NOW);
    expect(m.pick).toEqual({ kind: "run" });
    expect(m.selected).toBe("r_1");
    expect(m.focus).toBe("list");
  });

  test("task_g4jy_pick_falls_back_when_run_leaves", () => {
    let m = model(two(), ready(SEVEN.slice(0, 2)));
    m = press(m, ["down"]);
    const gone = m.selected;
    m = withData(m, { sessions: [session("r_9", "running")], proposals: 0 }, NOW);
    expect(m.pick).toEqual({ kind: "run" });
    expect(m.selected).not.toBe(gone);
    expect(m.selected).toBe("r_9");
    // The last task leaving with no run to fall back to leaves nothing picked.
    let t = update(model([], ready(SEVEN.slice(0, 1))), "down");
    expect(t.pick.kind).toBe("task");
    t = withTasks(t, ready([]));
    expect(t.pick).toEqual({ kind: "run" });
    expect(t.selected).toBe("");
  });
});

describe("a task is not a run", () => {
  const waiting = () => {
    const base = model([session("r_w", "waiting", undefined, "approve")], ready(SEVEN.slice(0, 2)));
    return press(base, ["down"]);
  };

  test("task_g4jy_run_keys_are_inert_on_a_task", () => {
    for (const focus of ["list", "card"] as const) {
      const m = { ...waiting(), focus };
      expect(m.pick.kind).toBe("task");
      const [clean] = takeEffects(m);
      for (const key of ["a", "r", "y", "n", "c", "d", "i", "[", "]", "g"]) {
        const next = update(clean, key);
        expect(next.confirm).toBeNull();
        expect(next.input).toBeNull();
        expect(next.effects).toEqual([]);
        expect(next.notice).toBe("");
        expect(next.sessions).toEqual(clean.sessions);
        expect(next.pick).toEqual(clean.pick);
      }
    }
  });

  test("task_g4jy_backlog_enter_and_escape", () => {
    let m = waiting();
    m = update(m, "enter");
    expect(m.focus).toBe("card");
    expect(screen(m)).toContain("title of T-A1");
    m = update(m, "escape");
    expect(m.focus).toBe("list");
  });

  test("task_g4jy_backlog_t_jumps_even_off_page", () => {
    // The Tasks screen's page holds no rows at all; the task is only in the unstarted read.
    const base = ready(SEVEN.slice(0, 2));
    if (base.status !== "ready") throw new Error("not ready");
    const load: TasksLoad = { ...base, rows: [] };
    let m = model([], load);
    expect(m.pick).toEqual({ kind: "task", key: "T-A1" });
    m = update(takeEffects(m)[0], "t");
    expect(m.section).toBe(2);
    expect(m.tasks.selected).toBe("T-A1");
    expect(takeEffects(m)[1]).toEqual([{ type: "load_task", key: "T-A1" }]);
    // A later list does not move the selection away from it.
    expect(withTasks(m, load).tasks.selected).toBe("T-A1");
    expect(screen(m)).toContain("T-A1");
  });

  test("task_g4jy_backlog_t_with_tasks_off", () => {
    let m = press(model([], ready(SEVEN.slice(0, 2))), ["down"]);
    m = withTasks(m, { status: "off" });
    expect(m.pick).toEqual({ kind: "run" });
    expect(update(m, "t").section).toBe(0);
    for (const section of ["1", "2", "3", "4"])
      expect(() => screen(update(m, section))).not.toThrow();
    const broken = withTasks(m, { status: "error", message: "boom" });
    expect(update(broken, "t").section).toBe(0);
    expect(() => screen(update(broken, "3"))).not.toThrow();
  });

  // `s` starts a task in a background agent (TASK-9PNS): `task_9pns_backlog_offers_s` in
  // tui-worker.test.ts replaced `task_g4jy_backlog_has_no_start_key` and walks the other keys.
});

describe("the mouse over the Backlog", () => {
  const mouse = (m: Model): Model => ({ ...m, mouse: true });
  const press1 = (x: number, y: number) => ({
    type: "mouse" as const,
    action: "press" as const,
    x,
    y,
  });
  const at = (m: Model, size: { cols: number; rows: number }, text: string) =>
    lines(m, size).findIndex((l) => l.includes(text)) + 1;

  test("task_g4jy_backlog_click_picks_the_task", () => {
    const m = mouse(model([session("r_1", "running")], ready(SEVEN.slice(0, 3))));
    const y = at(m, WIDE, "T-A2");
    expect(hitTest(m, WIDE, 3, y)).toEqual({ kind: "task", key: "T-A2" });
    const next = mouseUpdate(m, WIDE, press1(3, y));
    expect(next.pick).toEqual({ kind: "task", key: "T-A2" });
    expect(next.selected).toBe("r_1");
    expect(takeEffects(next)[1]).toEqual([{ type: "load_task", key: "T-A2" }]);
    // A click on a run goes back to the run.
    const back = mouseUpdate(next, WIDE, press1(3, at(next, WIDE, "run-r_1")));
    expect(back.pick).toEqual({ kind: "run" });
  });

  test("task_g4jy_backlog_wheel_and_layouts", () => {
    const body = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    let m = mouse(model([session("r_1", "running")], ready(SEVEN.slice(0, 3))));
    m = press(m, ["down"]);
    m = withTask(m, "T-A1", {
      status: "ready",
      card: {
        key: "T-A1",
        title: "t",
        state: "todo",
        status: "todo",
        runs: [],
        body,
        comments: [],
        subtasks: [],
      },
    });
    // The wheel over the card scrolls the task's card.
    const over = mouseUpdate(m, WIDE, { type: "mouse", action: "wheel_down", x: 100, y: 8 });
    expect(over.cardScroll).toBeGreaterThan(0);
    expect(over.pick).toEqual({ kind: "task", key: "T-A1" });
    // On a narrow screen the list is the block's; a click opens the card.
    const narrow = mouse(model([session("r_1", "running")], ready(SEVEN.slice(0, 3))));
    expect(screen(narrow, NARROW)).toContain("BACKLOG · 3 of 3");
    const picked = mouseUpdate(narrow, NARROW, press1(3, at(narrow, NARROW, "T-A2")));
    expect(picked.pick).toEqual({ kind: "task", key: "T-A2" });
    expect(mouseUpdate(picked, NARROW, press1(3, at(picked, NARROW, "T-A2"))).focus).toBe("card");
    // Zoomed: the list is put away and the task's card has the width.
    expect(screen(update(press(narrow, ["down", "down"]), "z"), WIDE)).toContain("title of T-A2");
  });
});

describe("tasks off, broken, slow", () => {
  test("task_g4jy_tasks_off_says_so", async () => {
    const handle = await openTasksForTui("/nowhere", async () => undefined);
    expect(handle).toEqual({ status: "off" });
    const m = withTasks(model([session("r_1", "running")]), await loadTasks(handle));
    expect(screen(m)).toContain("Tasks are off");
    expect(screen(update(m, "3"))).toContain("Tasks are off");
    expect(TASKS_OFF).toContain("tasks.enabled");
    // No runs: the one line is still there, under the way to start.
    expect(screen(model([], { status: "off" }))).toContain("Tasks are off");
  });

  test("task_g4jy_bad_config_is_one_line", async () => {
    const handle = await openTasksForTui("/nowhere", async () => {
      throw new KodelError("CONFIG_INVALID", 'unknown task adapter "jira" (tasks.adapter)');
    });
    expect(handle.status).toBe("error");
    const m = withTasks(model([session("r_1", "running")]), await loadTasks(handle));
    expect(screen(m)).toContain("unknown task adapter");
    expect(screen(update(m, "3"))).toContain('unknown task adapter "jira"');
  });

  test("task_g4jy_first_tasks_read_fails", async () => {
    const source: TasksSource = {
      list: async () => ({ ok: false, message: "the tracker is down" }) as Answer,
      get: async () => ({ ok: false }) as Answer,
    };
    const load = await loadTasks(on(source));
    expect(load).toEqual({ status: "error", message: "the tracker is down" });
    const m = withTasks(model([session("r_1", "running")]), load);
    expect(screen(m)).toContain("Cannot read the tasks: the tracker is down");
    expect(screen(m)).toContain("run-r_1");
    expect(screen(update(m, "3"))).toContain("Cannot read the tasks: the tracker is down");
    // A source that throws is the same.
    const throwing: TasksSource = {
      list: async () => {
        throw new Error("timed out");
      },
      get: async () => ({ ok: true }),
    };
    expect(await loadTasks(on(throwing))).toEqual({ status: "error", message: "timed out" });
  });

  test("task_g4jy_failure_keeps_the_last_list", () => {
    let m = model([session("r_1", "running")], ready(SEVEN.slice(0, 2)));
    m = withTasks(m, { status: "error", message: "the tracker is down" });
    expect(blockKeys(m)).toEqual(["T-A1", "T-A2"]);
    expect(screen(m)).toContain("Cannot read the tasks now: the tracker is down");
    expect(screen(update(m, "3"))).toContain("T-A2");
    expect(screen(update(m, "3"))).toContain("Cannot read the tasks now: the tracker is down");
    // The next good answer clears it.
    m = withTasks(m, ready(SEVEN.slice(0, 2)));
    expect(screen(m)).not.toContain("Cannot read");
  });

  test("task_g4jy_error_message_is_cleaned", () => {
    const rtl = String.fromCharCode(0x202e);
    const hostile = `down${ESC}]0;gate approved\u0007${ESC}[2J${ESC}c${rtl}`;
    expect(messageOf(new Error(hostile))).not.toContain(rtl);
    const m = withTasks(model([session("r_1", "running")]), { status: "error", message: hostile });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: looking for the control characters is the point
    const own = /\u001b\[(?:0|1|2|7|3[1-6])m/g;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: looking for the control characters is the point
    const control = /[\u0000-\u001f\u007f-\u009f]/;
    for (const l of render(m, WIDE)) expect(l.replace(own, "")).not.toMatch(control);
  });

  test("task_g4jy_block_says_reading_before_first_answer", () => {
    const m = model([session("r_1", "running")]);
    expect(screen(m)).toContain("reading tasks…");
    expect(screen(update(m, "3"))).toContain("reading tasks…");
    // The runs are all there: the first paint did not wait.
    expect(screen(m)).toContain("run-r_1");
  });
});

describe("what the tracker sends", () => {
  test("task_g4jy_loader_validates_rows", async () => {
    const good = raw(row("T-OK", "high"));
    const source: TasksSource = {
      list: async () =>
        ({
          ok: true,
          tasks: [
            good,
            null,
            { key: 7, title: "x", status: "todo" },
            { key: "T-NT", title: 5, status: "todo" },
            "text",
          ],
          problems: [],
        }) as Answer,
      get: async () => ({ ok: true, task: { key: "T-OK", title: 3 }, subtasks: [] }) as Answer,
    };
    const load = await loadTasks(on(source));
    if (load.status !== "ready") throw new Error("not ready");
    expect(load.rows.map((r) => r.key)).toEqual(["T-OK"]);
    expect(load.problems).toBe(4);
    expect(() => screen(update(model([], load), "3"))).not.toThrow();
    // A task that cannot be read gives a line, not a throw.
    const slot = await loadTask(on(source), "T-OK");
    expect(slot.status).toBe("failed");
    // A state the contract does not know reads as todo.
    const odd = await loadTasks(
      on({
        list: async () =>
          ({ ok: true, tasks: [{ ...good, state: "someday" }], problems: [] }) as Answer,
        get: async () => ({ ok: true }) as Answer,
      }),
    );
    if (odd.status !== "ready") throw new Error("not ready");
    expect(odd.rows[0]?.state).toBe("todo");
  });

  test("task_g4jy_problems_line", async () => {
    const load = await loadTasks(
      on(pagedSource([row("T-A1", "high")], { problems: [{ message: "a" }, { message: "b" }] })),
    );
    expect(screen(update(model([], load), "3"))).toContain(
      "2 task files could not be read (kodel task doctor)",
    );
  });

  test("task_g4jy_task_text_is_neutralized", () => {
    const hostile = `${ESC}]52;c;ZXZpbA==\u0007${ESC}[2J${ESC}[5A${ESC}c\u009b2J`;
    const bad = row("T-EV", "high", { title: `title${hostile}`, parent: `par${hostile}` });
    let m = model(
      [session("r_1", "running")],
      ready([bad], [row("T-CH", "low", { parent: "T-EV", title: `kid${hostile}` })]),
    );
    m = withTask(m, "T-EV", {
      status: "ready",
      card: {
        key: "T-EV",
        title: `title${hostile}`,
        state: "todo",
        status: "todo",
        runs: [],
        body: `body${hostile}`,
        comments: [
          { text: `comment${hostile}`, at: "2026-10-27T12:00:00.000Z", by: `by${hostile}` },
        ],
        subtasks: [],
      },
    });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: looking for the control characters is the point
    const own = /\u001b\[(?:0|1|2|7|3[1-6])m/g;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: looking for the control characters is the point
    const control = /[\u0000-\u001f\u007f-\u009f]/;
    const screens = [
      render(m, WIDE), // the block
      render(press(m, ["down", "down"]), WIDE), // the card of a picked task
      render(update(m, "3"), WIDE), // the list and the card of the Tasks screen
    ];
    for (const out of screens) {
      for (const l of out) {
        expect(l.replace(own, "")).not.toMatch(control);
        // And after the last look before the terminal.
        expect(neutralize(l).replace(own, "")).not.toMatch(control);
      }
    }
    expect(fit(`x${hostile}`, 20)).not.toMatch(control);
  });

  test("task_g4jy_tui_never_writes_tasks", async () => {
    const calls: string[] = [];
    const base = pagedSource(SEVEN, { calls });
    const writes = Object.fromEntries(
      ["create", "update", "setStatus", "transition", "delete", "comment"].map((name) => [
        name,
        () => {
          calls.push(`WRITE ${name}`);
          throw new Error("a write");
        },
      ]),
    );
    const source = { ...base, ...writes } as TasksSource;
    const handle = on(source);
    let m = withTasks(
      model([session("r_1", "waiting", undefined, "approve")]),
      await loadTasks(handle),
    );
    const keys = [
      "down",
      "down",
      "enter",
      "t",
      "a",
      "r",
      "d",
      "y",
      "n",
      "1",
      "tab",
      "tab",
      "tab",
      "tab",
      "down",
      "enter",
      "escape",
      "z",
      "z",
    ];
    for (const key of keys) {
      m = update(m, key, WIDE);
      for (const effect of takeEffects(m)[1]) {
        if (effect.type === "load_task") await loadTask(handle, effect.key);
      }
      m = takeEffects(m)[0];
      screen(m);
    }
    expect(calls.filter((c) => c.startsWith("WRITE"))).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("sessions and the demo", () => {
  test("task_g4jy_demo_tasks", () => {
    let m = initialModel(demoSessions(NOW), "demo", NOW);
    m = withTasks(m, demoTasks());
    // Seven are not started; one has a sample run, so five of the other six... of seven minus one.
    expect(screen(m)).toContain("BACKLOG · 5 of 7");
    const text = screen(m);
    expect(text).toContain("KDL-2K9M");
    expect(text).not.toContain("KDL-4H7P");
    const tasksScreen = screen(update(m, "3"));
    expect(tasksScreen).toContain("KDL-C3M2");
    expect(tasksScreen).toContain("KDL-4H7P");
    const grouped = demoTasks();
    if (grouped.status !== "ready") throw new Error("not ready");
    const priorities = new Set(grouped.rows.map((r) => r.priority));
    expect(priorities).toEqual(new Set(["high", "normal", "low"]));
    expect(grouped.rows.some((r) => r.status === "declined")).toBe(true);
    expect(grouped.rows.some((r) => r.parent !== undefined)).toBe(true);
    // The tied task is tied to a sample run that exists.
    expect(demoSessions(NOW).sessions.some((s) => s.taskKey === "KDL-4H7P")).toBe(true);
    const card = demoTaskCard("KDL-4H7P", NOW);
    expect(card.status === "ready" && card.card.runs).toEqual(["r_1kd8aa019"]);
    expect(demoTaskCard("KDL-NOPE", NOW).status).toBe("failed");
  });

  test("task_g4jy_tui_options_pick_demo_or_real", async () => {
    const demo = tuiTaskOptions("demo", NOW);
    const demoLoad = await demo.loadTasks?.();
    expect(demoLoad?.status === "ready" && demoLoad.rows.some((r) => r.key === "KDL-4H7P")).toBe(
      true,
    );
    const calls: string[] = [];
    const real = tuiTaskOptions(on(pagedSource(SEVEN, { calls })));
    const realLoad = await real.loadTasks?.();
    expect(realLoad?.status === "ready" && realLoad.rows.map((r) => r.key)).toEqual(
      SEVEN.map((r) => r.key),
    );
    expect(calls).toContain("list");
    const card = await real.loadTask?.("T-A1");
    expect(card?.status).toBe("ready");
    expect(calls).toContain("get");
    // A project with tasks off reads as off, and a card as failed.
    const off = tuiTaskOptions({ status: "off" });
    expect(await off.loadTasks?.()).toEqual({ status: "off" });
    expect((await off.loadTask?.("T-A1"))?.status).toBe("failed");
    // Nothing of the demo is read from the project, and the other way round.
    expect(calls.every((c) => c === "list" || c === "get")).toBe(true);
  });
});

describe("when the tasks are read", () => {
  /** A read that ends when the test says so. */
  function later<T>() {
    let resolve: (value: T) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const flush = () => Bun.sleep(1);

  test("task_g4jy_scheduler_one_read_at_a_time_newest_wins", async () => {
    const lists: ReturnType<typeof later<TasksLoad>>[] = [];
    const cards = new Map<string, ReturnType<typeof later<CardSlot>>[]>();
    const answers: TasksLoad[] = [];
    const slots: [string, CardSlot][] = [];
    const refresh = createTasksRefresh({
      load: () => {
        const d = later<TasksLoad>();
        lists.push(d);
        return d.promise;
      },
      loadCard: (key) => {
        const d = later<CardSlot>();
        cards.set(key, [...(cards.get(key) ?? []), d]);
        return d.promise;
      },
      onLoad: (l) => answers.push(l),
      onCard: (k, s) => slots.push([k, s]),
      shownKey: () => undefined,
    });
    // The first read is at the start.
    refresh.start(0);
    expect(lists.length).toBe(1);
    // While it is out, the timer starts no other.
    refresh.tick(TASKS_EVERY_MS * 5);
    expect(lists.length).toBe(1);
    lists[0]?.resolve({ status: "off" });
    await flush();
    expect(answers).toEqual([{ status: "off" }]);
    expect(lists.length).toBe(1);
    // After it, the timer waits the interval; the screen does not.
    refresh.tick(TASKS_EVERY_MS - 1);
    expect(lists.length).toBe(1);
    refresh.tick(TASKS_EVERY_MS);
    expect(lists.length).toBe(2);
    lists[1]?.resolve({ status: "off" });
    await flush();
    refresh.openScreen(TASKS_EVERY_MS + 1);
    expect(lists.length).toBe(3);
    // Two reads of one card: the older answer, arriving last, does not overwrite the newer.
    refresh.readCard("T-A");
    refresh.readCard("T-A");
    const [older, newer] = cards.get("T-A") ?? [];
    newer?.resolve({ status: "failed", message: "newer" });
    await flush();
    older?.resolve({ status: "failed", message: "older" });
    await flush();
    expect(slots).toEqual([["T-A", { status: "failed", message: "newer" }]]);
  });

  test("task_9pns_a_list_read_asked_for_while_one_is_out_is_made_once_after_it", async () => {
    const lists: ReturnType<typeof later<TasksLoad>>[] = [];
    const answers: TasksLoad[] = [];
    const cards: string[] = [];
    const refresh = createTasksRefresh({
      load: () => {
        const d = later<TasksLoad>();
        lists.push(d);
        return d.promise;
      },
      loadCard: async () => ({ status: "loading" }),
      onLoad: (l) => answers.push(l),
      onCard: (k) => cards.push(k),
      shownKey: () => "T-A",
    });
    refresh.start(0);
    // The screen asks twice while the read is out (a task was created, the screen was opened): one read is
    // kept for after it, not two, and none goes out meanwhile.
    refresh.openScreen(5);
    refresh.openScreen(6);
    expect(lists.length).toBe(1);
    expect(answers).toEqual([]);
    lists[0]?.resolve({ status: "off" });
    await flush();
    expect(lists.length).toBe(2);
    // The first answer is shown (it was the newest when it came), and the kept read is out at once.
    expect(answers).toEqual([{ status: "off" }]);
    // The card of the shown task is read after each list, the kept read as well.
    expect(cards).toEqual(["T-A"]);
    // Nothing was asked while the kept read is out: nothing follows it, and its answer, the newest, is kept.
    lists[1]?.resolve({ status: "error", message: "second" });
    await flush();
    expect(lists.length).toBe(2);
    expect(answers).toEqual([{ status: "off" }, { status: "error", message: "second" }]);
    expect(cards).toEqual(["T-A", "T-A"]);
    // The kept read counts as the latest request's: the timer waits the interval from there.
    refresh.tick(6 + TASKS_EVERY_MS - 1);
    expect(lists.length).toBe(2);
    refresh.tick(6 + TASKS_EVERY_MS);
    expect(lists.length).toBe(3);
    // The timer itself keeps no read: a read older than the interval is made at the next tick anyway.
    refresh.tick(6 + TASKS_EVERY_MS * 3);
    lists[2]?.resolve({ status: "off" });
    await flush();
    expect(lists.length).toBe(3);
    refresh.tick(6 + TASKS_EVERY_MS * 3 + 1);
    expect(lists.length).toBe(4);
  });

  test("task_g4jy_tasks_read_is_detached_from_runs", async () => {
    // A tasks reader that never answers.
    const answers: TasksLoad[] = [];
    const refresh = createTasksRefresh({
      load: () => new Promise<TasksLoad>(() => undefined),
      loadCard: () => new Promise<CardSlot>(() => undefined),
      onLoad: (l) => answers.push(l),
      onCard: () => undefined,
      shownKey: () => undefined,
    });
    expect(refresh.start(0)).toBeUndefined();
    // The runs are read meanwhile, and they do not wait for it.
    const loaded = await loadSessions(
      {
        runSummaries: async () => [],
        open: async () => undefined,
        pipelineProposals: async () => [],
      },
      NOW,
    );
    expect(loaded.sessions).toEqual([]);
    // A reader that fails is the tasks' error, in the words of the tracker, not a failure of the runs.
    const failing = createTasksRefresh({
      load: async () => {
        throw new Error("the tracker timed out");
      },
      loadCard: async () => ({ status: "loading" }),
      onLoad: (l) => answers.push(l),
      onCard: () => undefined,
      shownKey: () => undefined,
    });
    failing.start(0);
    await flush();
    expect(answers).toEqual([{ status: "error", message: "the tracker timed out" }]);
    expect(JSON.stringify(answers)).not.toContain("Cannot read the runs");
  });
});
