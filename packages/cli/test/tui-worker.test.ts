/**
 * The TUI and its background agents (TASK-9PNS): the `s` key, the two questions, the card and the row,
 * and the loop with a fake launcher. No terminal and no process: the model is pure, the loop gets a
 * fake terminal (`tui-run.test.ts`) and the fake launcher.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { SessionError } from "@kodel-ai/pipeline-core";
import { DIGEST_LINES, digest } from "../src/claude-stream";
import { bold, dim, RESET, stripAnsi, visibleLength } from "../src/tui/ansi";
import type { WorkHandle } from "../src/tui/decide";
import { createInputReader } from "../src/tui/input";
import type { Loaded } from "../src/tui/load";
import { boxOf, hardWrap } from "../src/tui/modal";
import { applyEvents, applyInput, runTui, type TuiOptions } from "../src/tui/run";
import type { GateDetail, LogEntry, Session } from "../src/tui/session";
import { LOG } from "../src/tui/tabs";
import type { Answer, TaskRow, TasksLoad, TasksSource } from "../src/tui/tasks-load";
import { openTasksForTui, tuiTaskOptions } from "../src/tui/tasks-open";
import {
  COMMENT_GUARD_MS,
  detailKey,
  type Effect,
  FORM_PRIORITIES,
  initialModel,
  type Model,
  PICKER_MAX,
  render,
  takeEffects,
  update,
  withData,
  withDetail,
  withProgress,
  withResumed,
  withStarted,
  withStartReady,
  withStartRefused,
  withTask,
  withTaskCreated,
  withTasks,
  withWorkers,
} from "../src/tui/view";
import type { DecisionMark, WaitMark } from "../src/tui/worker-resume";
import type { WorkerStatus } from "../src/worker-launcher";
import { FakeLauncher } from "./fake-launcher";

const NOW = Date.UTC(2026, 10, 6, 15, 0, 0);
const WIDE = { cols: 120, rows: 30 };
const WIDER = { cols: 200, rows: 30 };
/** Control characters and the marks that reorder or hide text: nothing of them may reach the screen. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is what is checked
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b\u202e]/;
/** The styles the screens write. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the one escape the screens write
const OWN_STYLE = /\u001b\[(0|1|2|7|3[0-6])m/g;
const ESC = "\u001b";
const UUID = "7f3b2a9c-1d4e-4f6a-9b8c-0d1e2f3a4b5c";

const lines = (m: Model, size = WIDE) => render(m, size).map(stripAnsi);
const screen = (m: Model, size = WIDE) => lines(m, size).join("\n");
const footer = (m: Model, size = WIDE) => lines(m, size).at(-1) ?? "";
/** A person takes a moment between keys. */
const press = (m: Model, ...keys: string[]) => {
  let next = m;
  for (const k of keys) next = update({ ...next, now: next.now + 1000 }, k, WIDE);
  return next;
};
const effects = (m: Model) => takeEffects(m)[1];
const clean = (m: Model) => takeEffects(m)[0];

const row = (key: string, extra: Partial<TaskRow> = {}): TaskRow => ({
  key,
  title: `title of ${key}`,
  state: "todo",
  status: "todo",
  priority: "normal",
  runCount: 0,
  ...extra,
});

const ready = (todo: TaskRow[], rest: TaskRow[] = []): TasksLoad => ({
  status: "ready",
  rows: [...todo, ...rest],
  more: false,
  problems: 0,
  todo,
  todoCut: false,
});

const session = (id: string, status: Session["status"], extra: Partial<Session> = {}): Session => ({
  id,
  title: `run-${id}`,
  pipeline: "dev",
  status,
  step: status === "waiting" ? "approve" : "impl",
  since: NOW - 60_000,
  steps: [],
  log: [],
  ...(status === "waiting" ? { need: "approve" as const } : {}),
  ...extra,
});

const model = (sessions: Session[], load?: TasksLoad): Model => {
  const m = initialModel({ sessions, proposals: 0 }, "project", NOW);
  return load ? withTasks(m, load) : m;
};

const worker = (runId: string, over: Partial<WorkerStatus> = {}): WorkerStatus => ({
  id: "a_000000001_fake",
  name: `kw-${runId}`,
  state: "running",
  label: "running",
  started: NOW - 50_000,
  sessionId: UUID,
  resumed: [],
  resumes: 0,
  ...over,
});

const WAIT: WaitMark = { seq: 10, ts: NOW - 30_000, kind: "gate", node: "plan-approval" };
const DECIDED: DecisionMark = {
  seq: 12,
  ts: NOW - 10_000,
  kind: "gate",
  node: "plan-approval",
  outcome: "approved",
  byAgent: false,
};

const statuses = (...entries: [string, WorkerStatus][]) => new Map(entries);

/** `s` on the first Backlog row, then the loop's answer. */
function asked(m: Model, pipelines = ["dev"]): { m: Model; key: string; seq: number } {
  const pressed = update(m, "s", WIDE);
  const effect = effects(pressed).find((e) => e.type === "prepare_start");
  if (effect?.type !== "prepare_start") throw new Error("no prepare_start");
  return {
    m: withStartReady(clean(pressed), effect.seq, effect.key, pipelines),
    key: effect.key,
    seq: effect.seq,
  };
}

const startOf = (m: Model): Extract<Effect, { type: "start_task" }> | undefined =>
  effects(m).find((e): e is Extract<Effect, { type: "start_task" }> => e.type === "start_task");

describe("task_9pns the s key on a task", () => {
  const backlog = () => model([session("r_1", "running")], ready([row("T-A1"), row("T-A2")]));
  const picked = () => press(backlog(), "down");

  test("task_9pns_backlog_offers_s", () => {
    const base = picked();
    expect(base.pick).toEqual({ kind: "task", key: "T-A1" });
    for (let code = 33; code < 127; code += 1) {
      const key = String.fromCharCode(code);
      if (key === "t" || key === "s") continue;
      const next = update(clean(base), key);
      for (const effect of next.effects) expect(effect.type).toBe("load_task");
    }
    for (const focus of ["list", "card"] as const) {
      const hint = footer({ ...base, focus });
      expect(hint).toContain("s start");
      expect(hint).toContain("t tasks");
    }
  });

  test("task_9pns_s_asks_only_for_a_task_without_an_active_run", () => {
    const onRow = update(clean(picked()), "s");
    expect(effects(onRow)).toEqual([{ type: "prepare_start", key: "T-A1", seq: 1 }]);
    expect(footer(onRow)).toContain("Checking…");
    // On a card (the focus on it) of a task in progress without an active run: the same.
    const progress = row("T-P", { state: "progress", status: "progress" });
    const withProgressTask = withTasks(picked(), ready([row("T-A1")], [progress]));
    const drilled: Model = {
      ...withProgressTask,
      focus: "card",
      tasks: { ...withProgressTask.tasks, drill: ["T-P"] },
    };
    const drilledEffects = effects(update(clean(drilled), "s"));
    expect(drilledEffects.filter((e) => e.type !== "load_task")).toEqual([
      { type: "prepare_start", key: "T-P", seq: 1 },
    ]);
    // With an active run of that task: nothing, and why.
    const active = withData(
      drilled,
      { sessions: [session("r_9", "running", { taskKey: "T-P" })], proposals: 0 },
      NOW,
    );
    const refused = update(clean(active), "s");
    expect(effects(refused)).toEqual([]);
    expect(refused.notice).toBe("T-P is already started: run r_9 (running).");
    // A done and a declined task.
    for (const [status, words] of [
      ["done", "is done"],
      ["declined", "is declined"],
    ] as const) {
      const done = row("T-D", { state: "done", status });
      const m = withTasks(picked(), ready([row("T-A1")], [done]));
      const card: Model = { ...m, focus: "card", tasks: { ...m.tasks, drill: ["T-D"] } };
      const next = update(clean(card), "s");
      expect(effects(next).filter((e) => e.type !== "load_task")).toEqual([]);
      expect(next.notice).toContain(words);
    }
    // On a run row: nothing is started, and the reason is said.
    const onRun = update(clean(backlog()), "s");
    expect(effects(onRun)).toEqual([]);
    expect(onRun.notice).toBe("Nothing to resume: no agent of the TUI on this run.");
    // On sample data: nothing.
    const demo = update({ ...clean(picked()), source: "demo" }, "s");
    expect(effects(demo)).toEqual([]);
    expect(demo.notice).toBe("starting is not available in --demo");
  });

  test("task_9pns_y_confirms_any_other_key_cancels", () => {
    const { m, key, seq } = asked(picked());
    // The question is a window in the middle of the screen, with the task's name and the keys on their own line.
    const shown = screen(m);
    expect(shown).toContain("┌─ Start «T-A1» ");
    expect(shown).toContain("Start T-A1 in a background agent (pipeline dev)?");
    expect(shown).toContain("T-A1 · title of T-A1");
    expect(shown).toContain("y start · Esc or any other key cancels");
    expect(shown).toContain("[y Start]");
    expect(shown).toContain("[Esc Cancel]");
    expect(footer(m)).toContain("y start");
    expect(footer(m)).toContain("Esc cancel");
    const yes = press(m, "y");
    expect(startOf(yes)).toEqual({ type: "start_task", key, pipeline: "dev", seq });
    expect(yes.start).toBeNull();
    expect(yes.starting).toEqual({ "T-A1": true });
    // Only a lowercase `y` starts, as the window says; `Y` cancels like any other key.
    for (const other of ["n", "a", "r", "d", "q", "enter", "escape", "x", "Y"]) {
      const no = press(m, other);
      expect(startOf(no)).toBeUndefined();
      expect(no.start).toBeNull();
      expect(no.notice).toBe("Cancelled.");
      expect(no.quit).toBe(false);
    }
    // A late answer (an older seq) and an answer for another task are dropped.
    const pressed = clean(update(clean(picked()), "s"));
    expect(withStartReady(pressed, 0, "T-A1", ["dev"]).start?.pipelines).toBeUndefined();
    expect(withStartReady(pressed, 1, "T-A2", ["dev"]).start?.pipelines).toBeUndefined();
    expect(withStartRefused(pressed, 0, "T-A1", "no").start).not.toBeNull();
    // A refusal: one notice, no question.
    const refused = withStartRefused(
      pressed,
      1,
      "T-A1",
      "Could not start T-A1: claude was not found on PATH.",
    );
    expect(refused.start).toBeNull();
    expect(footer(refused)).toContain("claude was not found on PATH");
    // The card moving to another task (the task got a run) cancels the question.
    const moved = withData(
      m,
      {
        sessions: [session("r_1", "running"), session("r_2", "running", { taskKey: "T-A1" })],
        proposals: 0,
      },
      NOW,
    );
    expect(moved.start).toBeNull();
    expect(moved.notice).toContain("Cancelled");
  });

  test("task_9pns_guard_refuses_at_399_ms_accepts_at_400", () => {
    const { m } = asked(picked());
    const askedAt = m.start?.askedAt ?? 0;
    const early = update({ ...m, now: askedAt + COMMENT_GUARD_MS - 1 }, "y");
    expect(startOf(early)).toBeUndefined();
    expect(early.start).not.toBeNull();
    expect(footer(early)).toContain("Wait a moment, then press y.");
    const onTime = update({ ...m, now: askedAt + COMMENT_GUARD_MS }, "y");
    expect(startOf(onTime)).toBeDefined();
  });

  /** The rows of the window on a screen, raw (with their styles), from its top border to its bottom one. */
  const boxRows = (m: Model, size: { cols: number; rows: number }): string[] => {
    const raw = render(m, size);
    const top = raw.findIndex((l) => stripAnsi(l).includes("┌─"));
    const bottom = raw.findIndex((l, i) => i > top && stripAnsi(l).includes("└─"));
    if (top < 0 || bottom < 0) throw new Error("no window on the screen");
    return raw.slice(top, bottom + 1);
  };
  /** A row is balanced when every style it opens is closed again before its right border. */
  const balanced = (row: string): boolean => {
    const sequences = row.match(OWN_STYLE) ?? [];
    return sequences.length === 0 || sequences.at(-1) === RESET;
  };
  /** The box width, as the plain row shows it: from its left border to its right one. */
  const plainWidth = (row: string): number => {
    const plain = stripAnsi(row);
    return visibleLength(plain.trimEnd()) - (plain.length - plain.trimStart().length);
  };

  test("task_9pns_window_wraps_styled_text_without_cutting_a_style", () => {
    const ESC1 = `${ESC}[1m`;
    const ESC2 = `${ESC}[2m`;
    // A style open at the cut is closed there and opened again on the next piece; a sequence is no column.
    expect(hardWrap(bold("abcdef"), 4)).toEqual([`${ESC1}abcd${RESET}`, `${ESC1}ef${RESET}`]);
    expect(hardWrap(`${dim("ab")}cdef`, 3)).toEqual([`${ESC2}ab${RESET}c`, "def"]);
    expect(hardWrap(bold(`ab${dim("cd")}ef`), 3)).toEqual([
      `${ESC1}ab${ESC2}c${RESET}`,
      `${ESC1}${ESC2}d${RESET}ef${RESET}`,
    ]);
    expect(hardWrap(bold("abcd"), 4)).toEqual([bold("abcd")]);
    expect(hardWrap("abcdef", 4)).toEqual(["abcd", "ef"]);
    for (const piece of hardWrap(dim("x".repeat(161)), 88)) expect(balanced(piece)).toBe(true);
  });

  test("task_9pns_start_window_shows_a_long_title_and_a_wrapped_question_with_balanced_styles", () => {
    const NARROW = { cols: 100, rows: 30 };
    for (const length of [160, 161, 162]) {
      const title = "a".repeat(length);
      const base = press(
        model([session("r_1", "running")], ready([row("T-A1", { title })])),
        "down",
      );
      const { m } = asked(base);
      const rows = boxRows(m, NARROW);
      const width = plainWidth(rows[0] ?? "");
      expect(width).toBe(92);
      for (const r of rows) {
        expect(balanced(r)).toBe(true);
        expect(plainWidth(r)).toBe(width);
        // No piece of a style sequence shows as text.
        expect(stripAnsi(r)).not.toContain("[0m");
        expect(stripAnsi(r)).not.toContain(ESC);
      }
      // The name is on one row, cut at the box's inner width (as the picker cuts it), and no row of it wraps.
      const content = rows.slice(1, -1).map((r) => stripAnsi(r).replace(/│/g, "").trim());
      const nameRows = content.filter((c) => c.startsWith("T-A1 · a"));
      expect(nameRows).toHaveLength(1);
      expect(nameRows[0]?.endsWith("…")).toBe(true);
      expect(visibleLength(nameRows[0] ?? "")).toBe(88);
      expect(content.filter((c) => /^a+$/.test(c))).toEqual([]);
      for (const c of content.filter((c) => !c.includes("["))) expect(c).not.toMatch(/[0m]/);
    }
    // On a 60-column terminal the bold question wraps, and the bold stays inside each of its rows.
    const { m } = asked(picked(), ["feature-release"]);
    const rows = boxRows(m, { cols: 60, rows: 30 });
    const width = plainWidth(rows[0] ?? "");
    expect(width).toBe(56);
    for (const r of rows) {
      expect(balanced(r)).toBe(true);
      expect(plainWidth(r)).toBe(width);
    }
    const plainRows = rows.map((r) => stripAnsi(r).replace(/│/g, "").trim());
    const at = plainRows.findIndex((r) => r.startsWith("Start T-A1"));
    expect(at).toBeGreaterThan(0);
    expect(`${plainRows[at]}${plainRows[at + 1]}`).toBe(
      "Start T-A1 in a background agent (pipeline feature-release)?",
    );
    expect(plainRows.join("\n")).toContain("y start · Esc or any other key cancels");
  });

  test("task_9pns_start_and_resume_windows_do_not_scroll_and_keep_their_keys_in_view", () => {
    const SHORT = { cols: 120, rows: 14 };
    const many = Array.from({ length: 10 }, (_, i) => `pipe-${i + 1}`);
    const { m } = asked(picked(), many);
    const shown = screen(m, SHORT);
    expect(shown).not.toContain("↑↓ scroll");
    // Two rows fit under the question: the keys offer those two, not the nine.
    expect(shown).toContain("1-2 choose a pipeline · Esc or any other key cancels");
    expect(screen(m)).toContain("1-9 choose a pipeline · Esc or any other key cancels");
    // With one pipeline, the same line of keys; on a tall screen as well.
    const one = asked(picked()).m;
    expect(screen(one, SHORT)).toContain("y start · Esc or any other key cancels");
    expect(screen(one, SHORT)).toContain("[Esc Cancel]");
    expect(screen(one, SHORT)).not.toContain("↑↓ scroll");
    expect(screen(one)).toContain("y start · Esc or any other key cancels");
    // The arrows still cancel the question: they never scroll it.
    expect(press(m, "down").start).toBeNull();
    expect(press(m, "pagedown").start).toBeNull();
    // The resume window, the same.
    const decided = session("r_1", "running", { lastWait: WAIT, decision: DECIDED, moved: true });
    const resumeAsked = update(
      withWorkers(
        model([decided]),
        statuses(["r_1", worker("r_1", { state: "exited", label: "exited (0)" })]),
        false,
      ),
      "s",
    );
    expect(resumeAsked.resume).not.toBeNull();
    const bar = screen(resumeAsked, SHORT);
    expect(bar).toContain("y resume · Esc or any other key cancels");
    expect(bar).not.toContain("↑↓ scroll");
    expect(press(resumeAsked, "down").resume).toBeNull();
  });

  test("task_9pns_a_paste_starts_nothing_a_lone_y_confirms", () => {
    const base = picked();
    // A chunk `sy`: the question opens and the `y` in the same chunk is not an answer.
    const chunk = applyInput(base, "sy", WIDE, undefined, NOW + 1000);
    expect(startOf(chunk)).toBeUndefined();
    const { m } = asked(base);
    // A bracketed paste holding `y` is text, never a key.
    const reader = createInputReader();
    const pasted = applyInput(m, `${ESC}[200~y${ESC}[201~`, WIDE, reader, NOW + 1000);
    expect(startOf(pasted)).toBeUndefined();
    expect(pasted.start).not.toBeNull();
    // `y` with another key in its chunk starts nothing.
    const burst = applyEvents(
      m,
      [
        { type: "key", name: "y" },
        { type: "key", name: "y" },
      ],
      WIDE,
      NOW + 1000,
    );
    expect(startOf(burst)).toBeUndefined();
    // A lone `y`, later, starts.
    const lone = applyEvents(m, [{ type: "key", name: "y" }], WIDE, m.now + 1000);
    expect(startOf(lone)).toBeDefined();
  });

  test("task_9pns_start_question_leaves_a_r_d_alone", () => {
    const waiting = model(
      [
        session("r_1", "waiting", {
          decisions: [
            { kind: "gate", node: "approve", prompt: "ok?", command: "kodel gate approve r_1" },
          ],
        }),
      ],
      ready([row("T-A1")]),
    );
    const { m } = asked(press(waiting, "down"));
    for (const key of ["a", "r", "d"]) {
      const next = press(m, key);
      expect(next.start).toBeNull();
      expect(next.flow).toBeNull();
      expect(next.confirm).toBeNull();
      expect(effects(next)).toEqual([]);
    }
  });

  test("task_9pns_picker_chooses_cancels_and_forgets", () => {
    const { m, key, seq } = asked(picked(), ["dev", "feature", "hotfix"]);
    const bar = screen(m);
    expect(bar).toContain("Start T-A1 in a background agent with:");
    expect(bar).toContain("1 dev");
    expect(bar).toContain("2 feature");
    expect(bar).toContain("3 hotfix");
    expect(bar).toContain("1-3 choose a pipeline · Esc or any other key cancels");
    expect(bar).toContain("[2 feature]");
    expect(footer(m)).toContain("1-3 choose a pipeline");
    expect(startOf(press(m, "2"))).toEqual({ type: "start_task", key, pipeline: "feature", seq });
    for (const other of ["0", "4", "9", "y", "enter"]) {
      const no = press(m, other);
      expect(startOf(no)).toBeUndefined();
      expect(no.notice).toBe("Cancelled.");
    }
    // Not remembered: the next `s` asks again.
    const again = press(press(m, "2"), "s");
    expect(again.start).toBeNull();
    expect(again.notice).toBe("T-A1 is being started.");
  });

  test("task_9pns_picker_offers_nine_at_most", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
    const { m } = asked(picked(), twelve);
    const bar = screen(m, WIDER);
    expect(PICKER_MAX).toBe(9);
    expect(bar).toContain("9 p9");
    expect(bar).not.toContain("10 p10");
    expect(bar).toContain("3 more are not offered here");
    expect(startOf(press(m, "9"))?.pipeline).toBe("p9");
  });

  test("task_9pns_picker_takes_only_the_digits_whose_rows_the_window_shows", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `pipe-${i + 1}`);
    const notice = (n: number) => `Pipeline ${n} is not visible: make the terminal taller.`;
    /** The digits of the pipeline rows the window draws, in order. */
    const drawn = (m: Model, size: { cols: number; rows: number }): number[] =>
      boxRows(m, size).flatMap((r) => {
        const hit = /^\s*│\s+(\d) pipe-\d/.exec(stripAnsi(r));
        return hit ? [Number(hit[1])] : [];
      });
    const check = (m: Model, size: { cols: number; rows: number }, shown: number[]) => {
      const rows = boxRows(m, size).map(stripAnsi);
      expect(drawn(m, size)).toEqual(shown);
      // The keys are in view whatever is cut, offer only the digits whose rows are drawn, and the window
      // never offers to scroll; the bottom line offers the same digits.
      const digits = shown.length === 1 ? "1" : `1-${shown.length}`;
      expect(rows.join("\n")).toContain(
        `${digits} choose a pipeline · Esc or any other key cancels`,
      );
      expect(rows.join("\n")).not.toContain("↑↓ scroll");
      expect(lines(m, size).at(-1)).toContain(`${digits} choose a pipeline`);
      for (let n = 1; n <= 9; n += 1) {
        const next = update({ ...m, now: m.now + 1000 }, String(n), size);
        if (shown.includes(n)) {
          expect(startOf(next)?.pipeline).toBe(`pipe-${n}`);
          expect(next.start).toBeNull();
        } else {
          // A digit whose row is not drawn starts nothing; the window stays and says what to do.
          expect(effects(next)).toEqual([]);
          expect(next.start).not.toBeNull();
          expect(next.notice).toBe(notice(n));
          expect(lines(next, size).at(-1)).toContain(notice(n));
        }
      }
    };
    const { m } = asked(picked(), nine);
    // 120x14: room for two rows under the question.
    check(m, { cols: 120, rows: 14 }, [1, 2]);
    // 120x20: seven rows.
    check(m, { cols: 120, rows: 20 }, [1, 2, 3, 4, 5, 6, 7]);
    // Tall enough: every row, then the task's name.
    check(m, WIDE, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // 80x24 with a title that would wrap to two lines: the rows come first and the name is cut to one row,
    // so all nine are drawn and taken.
    const long = "a".repeat(100);
    const wrapped = asked(
      press(model([session("r_1", "running")], ready([row("T-A1", { title: long })])), "down"),
      nine,
    ).m;
    const SMALL = { cols: 80, rows: 24 };
    check(wrapped, SMALL, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const content = boxRows(wrapped, SMALL).map((r) => stripAnsi(r));
    const name = content.find((r) => r.includes("T-A1 · aaa"));
    expect(name).toBeDefined();
    expect(name).toContain("…");
    expect(content.filter((r) => /^\s*│\s+a+/.test(r))).toEqual([]);
    // A tenth pipeline is said in a line after the rows, which is cut before any row is.
    const ten = asked(picked(), [...nine, "pipe-10"]).m;
    expect(screen(ten)).toContain("1 more are not offered here");
    expect(screen(ten, { cols: 120, rows: 20 })).not.toContain("more are not offered");
    check(ten, { cols: 120, rows: 20 }, [1, 2, 3, 4, 5, 6, 7]);
    // The mouse on a button of a row that is not drawn is refused the same way (short names, so that the
    // row of buttons fits the box and the ninth button is on the screen).
    const SHORT = { cols: 120, rows: 20 };
    const short = asked(
      picked(),
      Array.from({ length: 9 }, (_, i) => `p${i + 1}`),
    ).m;
    const withMouse = { ...short, mouse: true, now: short.now + 1000 };
    const rows = lines(withMouse, SHORT);
    const y = rows.findIndex((l) => l.includes("[9 p9]"));
    expect(y).toBeGreaterThan(0);
    const x = (rows[y] ?? "").indexOf("[9 p9]") + 2;
    const clicked = applyEvents(
      withMouse,
      [{ type: "mouse", action: "press", x, y: y + 1 }],
      SHORT,
      withMouse.now + 1000,
    );
    expect(effects(clicked)).toEqual([]);
    expect(clicked.notice).toBe(notice(9));
    // One pipeline and a resume: `y` counts only when the whole question is on the screen. The task's name
    // is one row whatever its length, so it is the question itself (a long pipeline name) that overflows.
    const TINY = { cols: 60, rows: 14 };
    const named = press(
      model([session("r_1", "running")], ready([row("T-A1", { title: long })])),
      "down",
    );
    expect(startOf(update({ ...asked(named).m, now: NOW + 5000 }, "y", TINY))).toBeDefined();
    const one = asked(named, [`pipeline-${"x".repeat(100)}`]).m;
    const refused = update({ ...one, now: one.now + 1000 }, "y", TINY);
    expect(effects(refused)).toEqual([]);
    expect(refused.start).not.toBeNull();
    expect(refused.notice).toBe("The question is not all visible: make the terminal taller.");
    expect(
      startOf(update({ ...one, now: one.now + 1000 }, "y", { cols: 60, rows: 30 })),
    ).toBeDefined();
    const decided = session("r_1", "running", { lastWait: WAIT, decision: DECIDED, moved: true });
    const resumeAsked = update(
      withWorkers(
        model([decided]),
        statuses(["r_1", worker("r_1", { state: "exited", label: "exited (0)" })]),
        false,
      ),
      "s",
    );
    const resumeRefused = update({ ...resumeAsked, now: resumeAsked.now + 1000 }, "y", TINY);
    expect(effects(resumeRefused)).toEqual([]);
    expect(resumeRefused.resume).not.toBeNull();
    expect(resumeRefused.notice).toBe("The question is not all visible: make the terminal taller.");
    const resumed = update({ ...resumeAsked, now: resumeAsked.now + 1000 }, "y", {
      cols: 60,
      rows: 30,
    });
    expect(effects(resumed).some((e) => e.type === "resume_worker")).toBe(true);
  });

  test("task_9pns_picker_with_no_row_drawn_offers_no_digit", () => {
    // A long task key wraps the question over the whole room (3 rows at these sizes), so with several
    // pipelines no row of the picker is drawn: the window and the bottom line must not promise digits they
    // would refuse, and every digit and click is refused with the same words.
    const key = `LONGKEY-${"x".repeat(40)}`;
    expect(key.length).toBe(48);
    const base = press(model([session("r_1", "running")], ready([row(key)])), "down");
    const notice = (n: number) => `Pipeline ${n} is not visible: make the terminal taller.`;
    const offersDigits = /\b1(-\d)? choose a pipeline/;
    for (const count of [2, 3, 9]) {
      const names = Array.from({ length: count }, (_, i) => `p${i + 1}`);
      const { m } = asked(base, names);
      for (const size of [
        { cols: 40, rows: 12 },
        { cols: 40, rows: 13 },
        { cols: 41, rows: 14 },
      ]) {
        const box = boxRows(m, size).map(stripAnsi);
        expect(box.filter((r) => /^\s*│\s+\d p\d/.test(r))).toEqual([]);
        expect(box.join("\n")).toContain("make the terminal taller");
        expect(box.join("\n")).not.toMatch(offersDigits);
        const bar = lines(m, size).at(-1) ?? "";
        expect(bar).toContain("make the terminal taller");
        expect(bar).toContain("Esc");
        expect(bar).not.toMatch(offersDigits);
        for (let n = 1; n <= 9; n += 1) {
          const next = update({ ...m, now: m.now + 1000 }, String(n), size);
          expect(effects(next)).toEqual([]);
          if (n <= count) {
            expect(next.start).not.toBeNull();
            expect(next.notice).toBe(notice(n));
          } else {
            expect(next.start).toBeNull();
            expect(next.notice).toBe("Cancelled.");
          }
        }
        // The first button is always on the screen; a click on it is refused the same way.
        const withMouse = { ...m, mouse: true, now: m.now + 1000 };
        const rows = lines(withMouse, size);
        const y = rows.findIndex((l) => l.includes("[1 p1]"));
        expect(y).toBeGreaterThan(0);
        const x = (rows[y] ?? "").indexOf("[1 p1]") + 2;
        const clicked = applyEvents(
          withMouse,
          [{ type: "mouse", action: "press", x, y: y + 1 }],
          size,
          withMouse.now + 1000,
        );
        expect(effects(clicked)).toEqual([]);
        expect(clicked.start).not.toBeNull();
        expect(clicked.notice).toBe(notice(1));
      }
      // Tall enough, the same question offers every digit again.
      expect(footer(m)).toContain(`${count === 1 ? "1" : `1-${count}`} choose a pipeline`);
      expect(startOf(press(m, "1"))?.pipeline).toBe("p1");
    }
  });

  test("task_9pns_window_title_is_measured_in_columns", () => {
    // A wide-character title takes two columns a character: the top border is as wide as the box.
    for (const title of [" 任务一二三四 ", ` Start «${"任".repeat(60)}» `, " Start «T-1» "]) {
      const box = boxOf({ title, content: ["x"], buttons: [], scroll: 0 }, 120, 20);
      const widths = box.box.map((l) => visibleLength(l));
      expect(new Set(widths).size).toBe(1);
      expect(widths[0]).toBe(92);
    }
    const cut = boxOf(
      { title: ` ${"任".repeat(60)} `, content: ["x"], buttons: [], scroll: 0 },
      120,
      20,
    );
    expect(stripAnsi(cut.box[0] ?? "")).toContain("…");
    // Through the start window: a CJK task key draws a straight box.
    const { m } = asked(
      press(model([session("r_1", "running")], ready([row("任务一二三四五六七八九十")])), "down"),
    );
    const rows = boxRows(m, WIDE);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(plainWidth(r)).toBe(92);
  });

  test("task_9pns_button_hit_boxes_are_measured_in_columns", () => {
    // Wide (CJK, emoji) and zero-width (combining) characters in a pipeline's name: a click on a visible
    // button starts that pipeline and no other, and the row of buttons is as wide as the box.
    for (const tag of ["流水线甲甲甲甲甲", "pipe-🚀🚀-", "éé-"]) {
      const names = [1, 2, 3].map((n) => `${tag}${n}`);
      const { m, key, seq } = asked(picked(), names);
      const withMouse = { ...m, mouse: true, now: m.now + 1000 };
      for (const r of boxRows(withMouse, WIDE)) expect(plainWidth(r)).toBe(92);
      const raw = render(withMouse, WIDE);
      const y = raw.findIndex((l) => stripAnsi(l).includes(`[1 ${names[0]}]`));
      expect(y).toBeGreaterThan(0);
      const plain = stripAnsi(raw[y] ?? "");
      // What the row shows: the display columns each button's text covers, read off the row itself.
      const drawn = [...names.map((p, i) => `[${i + 1} ${p}]`), "[Esc Cancel]"].map((text) => {
        const at = plain.indexOf(text);
        expect(at).toBeGreaterThan(0);
        const x0 = visibleLength(plain.slice(0, at));
        return { text, x0, x1: x0 + visibleLength(text) };
      });
      for (let x = 0; x < visibleLength(plain); x += 1) {
        const hit = drawn.findIndex((b) => x >= b.x0 && x < b.x1);
        const clicked = applyEvents(
          withMouse,
          [{ type: "mouse", action: "press", x: x + 1, y: y + 1 }],
          WIDE,
          withMouse.now + 1000,
        );
        if (hit === -1) {
          // Between the buttons, on the border or beside the box: nothing.
          expect(effects(clicked)).toEqual([]);
          expect(clicked.start).not.toBeNull();
          expect(clicked.notice).toBe(m.notice);
        } else if (hit === 3) {
          expect(effects(clicked)).toEqual([]);
          expect(clicked.start).toBeNull();
          expect(clicked.notice).toBe("Cancelled.");
        } else {
          expect(startOf(clicked)).toEqual({
            type: "start_task",
            key,
            pipeline: names[hit] ?? "",
            seq,
          });
        }
      }
    }
    // The geometry itself: a button's box is its width in columns, and the rows are as wide as the box.
    const box = boxOf(
      {
        title: " t ",
        content: ["x"],
        buttons: [
          { key: "1", text: "[1 甲甲]" },
          { key: "2", text: "[2 é]" },
        ],
        scroll: 0,
      },
      120,
      20,
    );
    // `[1 甲甲]` is 8 columns (6 characters), `[2 é]` is 5 (6 characters); two columns between them.
    expect(box.buttons.map((b) => [b.x0, b.x1])).toEqual([
      [box.left + 2, box.left + 2 + 8],
      [box.left + 2 + 10, box.left + 2 + 10 + 5],
    ]);
    expect(new Set(box.box.map((l) => visibleLength(l)))).toEqual(new Set([92]));
  });

  test("task_9pns_picker_keys_offer_only_the_digits_whose_rows_are_drawn", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `pipe-${i + 1}`);
    const { m } = asked(picked(), nine);
    // 40x12, the smallest screen: the question takes two rows, one pipeline row is drawn.
    const SMALLEST = { cols: 40, rows: 12 };
    const rows = lines(m, SMALLEST);
    expect(rows.filter((r) => /^\s*│\s+\d pipe-\d/.test(r))).toHaveLength(1);
    // The box is 36 columns here, so the line of keys is cut after `Esc`.
    expect(rows.join("\n")).toContain("1 choose a pipeline · Esc");
    expect(rows.join("\n")).not.toContain("1-9 choose");
    expect(footer(m, SMALLEST)).toContain("1 choose a pipeline");
    expect(footer(m, SMALLEST)).not.toContain("1-9");
    // The promised key works, the one not promised is refused as before.
    expect(startOf(update({ ...m, now: m.now + 1000 }, "1", SMALLEST))?.pipeline).toBe("pipe-1");
    const two = update({ ...m, now: m.now + 1000 }, "2", SMALLEST);
    expect(effects(two)).toEqual([]);
    expect(two.notice).toBe("Pipeline 2 is not visible: make the terminal taller.");
    // Where every row fits, the whole range is offered.
    expect(screen(m)).toContain("1-9 choose a pipeline · Esc or any other key cancels");
    expect(footer(m)).toContain("1-9 choose a pipeline");
  });

  test("task_9pns_one_pipeline_window_cuts_the_name_to_one_row", () => {
    // A long title under the one-pipeline question (and under `Checking…`) is one row, as in the picker, so
    // the question is whole on the smallest screen and `y` counts there.
    const SMALLEST = { cols: 40, rows: 12 };
    const base = press(
      model([session("r_1", "running")], ready([row("T-A1", { title: "a".repeat(300) })])),
      "down",
    );
    const nameRows = (rows: string[]) =>
      rows
        .map((r) => stripAnsi(r).replace(/│/g, "").trim())
        .filter((c) => c.startsWith("T-A1 · a"));
    const checking = clean(update(base, "s", WIDE));
    expect(checking.start?.pipelines).toBeUndefined();
    const checkingRows = boxRows(checking, SMALLEST);
    expect(nameRows(checkingRows)).toHaveLength(1);
    expect(nameRows(checkingRows)[0]?.endsWith("…")).toBe(true);
    const { m } = asked(base);
    const rows = boxRows(m, SMALLEST);
    for (const r of rows) expect(plainWidth(r)).toBe(36);
    expect(nameRows(rows)).toHaveLength(1);
    expect(nameRows(rows)[0]?.endsWith("…")).toBe(true);
    expect(rows.map(stripAnsi).join("\n")).not.toContain("↑↓ scroll");
    const yes = update({ ...m, now: m.now + 1000 }, "y", SMALLEST);
    expect(yes.notice).not.toContain("not all visible");
    expect(startOf(yes)?.pipeline).toBe("dev");
  });

  test("task_9pns_five_pairs_five_starts_and_a_repeat_starts_nothing", () => {
    const five = Array.from({ length: 5 }, (_, i) => row(`T-${i + 1}`));
    let m = press(model([session("r_0", "running")], ready(five)), "down");
    const started: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const key = m.pick.kind === "task" ? m.pick.key : "";
      const q = asked(m);
      const yes = press(q.m, "y");
      const effect = startOf(yes);
      expect(effect?.key).toBe(key);
      started.push(key);
      // The loop: the start answers, and the next read shows the run of the task.
      const runId = `r_${i + 1}`;
      m = withStarted(clean(yes), key, {
        ok: true,
        runId,
        message: `Started ${key}: run ${runId} (agent kw-${runId}).`,
      });
      m = withData(
        m,
        { sessions: [...m.sessions, session(runId, "running", { taskKey: key })], proposals: 0 },
        NOW,
      );
      // The task left the Backlog (its run is going); the person moves on to the next one.
      if (i < 4) {
        expect(m.pick).toEqual({ kind: "run" });
        m = { ...m, pick: { kind: "task", key: `T-${i + 2}` } };
      }
    }
    expect(started).toEqual(["T-1", "T-2", "T-3", "T-4", "T-5"]);
    // `s` on a started task's card says so, with the agent's words.
    const card: Model = {
      ...m,
      pick: { kind: "task", key: "T-1" },
      tasks: { ...m.tasks, drill: ["T-1"] },
    };
    const repeat = update(clean(card), "s");
    expect(effects(repeat)).toEqual([]);
    expect(repeat.notice).toBe("T-1 is already started: run r_1 (agent starting).");
    // While a start is in flight.
    const inFlight = update({ ...clean(picked()), starting: { "T-A1": true } }, "s");
    expect(effects(inFlight)).toEqual([]);
    expect(inFlight.notice).toBe("T-A1 is being started.");
  });

  test("task_9pns_start_outcome_is_told_in_plain_words", () => {
    const { m, key } = asked(picked());
    const yes = clean(press(m, "y"));
    const ok = withStarted(yes, key, {
      ok: true,
      runId: "r_7",
      message: "Started T-A1: run r_7 (agent kw-r_7).",
    });
    expect(footer(ok)).toContain("Started T-A1: run r_7 (agent kw-r_7).");
    expect(ok.starting).toEqual({});
    expect(ok.workerStarting).toEqual({ r_7: true });
    for (const message of [
      "Could not start T-A1: agents are not supported on Windows yet.",
      "Could not start T-A1: the project asks decisions in a dialog (decisions.dialog); a background agent cannot answer one. Turn it off, or wait for TASK-8EP9.",
      "Could not start T-A1: claude is not signed in (claude auth status): run claude auth login.",
      "Could not start T-A1: no pipeline loads.",
      "T-A1 has a run already going: r_7 (started outside the TUI).",
      "Could not start T-A1: the pipeline file .kodel/pipelines/dev.yaml has changes that are not committed. Commit .kodel/pipelines/dev.yaml or start the run from an agent.",
      "run r_7 was made but no agent was started: the holder did not answer. Any agent in the project continues it with pipeline_next_step and this run id.",
    ]) {
      const told = withStarted(yes, key, { ok: false, message });
      expect(footer(told)).toContain(message.slice(0, 60));
      expect(told.workerStarting).toEqual({});
    }
  });
});

describe("task_9pns the card and the row of a run with an agent", () => {
  test("task_9pns_card_shows_agent_starting_then_running_with_progress", () => {
    let m = withStarted(model([], ready([row("T-A1")])), "T-A1", {
      ok: true,
      runId: "r_1",
      message: "Started.",
    });
    m = withData(
      m,
      { sessions: [session("r_1", "running", { taskKey: "T-A1" })], proposals: 0 },
      NOW,
    );
    expect(screen(m)).toContain("agent starting");
    expect(screen(m)).toContain("◆ starting");
    // The first read replaces it with the record's state, and the digest lines appear as read.
    m = withWorkers(m, statuses(["r_1", worker("r_1")]), false);
    expect(screen(m)).toContain("agent running");
    expect(screen(m)).not.toContain("agent starting");
    expect(screen(m)).toContain("AGENT · kw-r_1");
    expect(screen(m)).toContain("$ kodel agent logs kw-r_1");
    m = withProgress(m, "r_1", { lines: ["init · 14 tools (kodel 11)", "→ pipeline_next_step"] });
    expect(screen(m)).toContain("init · 14 tools (kodel 11)");
    expect(screen(m)).toContain("→ pipeline_next_step");
    // A run without a record shows nothing of an agent; a finished run with one keeps its mark.
    const two = withWorkers(
      model([session("r_1", "running"), session("r_2", "done")]),
      statuses(["r_2", worker("r_2", { state: "exited", label: "exited (0)", exitCode: 0 })]),
      false,
    );
    expect(screen({ ...two, selected: "r_1" })).not.toContain("agent");
    expect(screen({ ...two, selected: "r_2" })).toContain("agent exited (0)");
    // Every state renders.
    for (const [state, label] of [
      ["starting", "starting"],
      ["running", "running"],
      ["exited", "exited (1)"],
      ["killed", "stopped"],
      ["killed", "killed (timeout)"],
      ["lost", "lost (holder gone)"],
      ["unknown", "unknown (cannot be read)"],
    ] as const) {
      const shown = withWorkers(
        model([session("r_1", "running")]),
        statuses(["r_1", worker("r_1", { state, label, exitCode: 1 })]),
        false,
      );
      expect(screen(shown)).toContain("agent ");
      expect(screen(shown)).toContain(label.split(" ")[0] ?? "");
    }
  });

  test("task_9pns_exit_at_a_gate_reads_as_waiting_for_you", () => {
    const waiting = session("r_1", "waiting", { lastWait: WAIT });
    const m = withWorkers(
      model([waiting]),
      statuses([
        "r_1",
        worker("r_1", { state: "exited", label: "exited (0)", exitCode: 0, since: NOW - 20_000 }),
      ]),
      false,
    );
    expect(screen(m)).toContain("agent waiting for you");
    expect(screen(m)).toContain("◆ for you");
    expect(footer(m)).not.toContain("s resume");
    const s = update(m, "s");
    expect(effects(s)).toEqual([]);
    expect(s.notice).toBe("Nothing to resume: the run waits for your decision.");
  });

  test("task_9pns_card_offers_s_after_the_decision", () => {
    const decided = session("r_1", "running", { lastWait: WAIT, decision: DECIDED, moved: false });
    const exited = worker("r_1", {
      state: "exited",
      label: "exited (0)",
      exitCode: 0,
      since: NOW - 20_000,
    });
    const m = withWorkers(model([decided]), statuses(["r_1", exited]), false);
    expect(screen(m)).toContain("agent exited at your decision · s resumes");
    expect(screen(m)).toContain("◆ s resumes");
    expect(footer(m)).toContain("s resume");
    const warned = withWorkers(
      model([{ ...decided, moved: true }]),
      statuses(["r_1", exited]),
      false,
    );
    expect(screen(warned, WIDER)).toContain("· an agent was served a step since");
    // During a resume, then after it.
    const resuming: Model = { ...m, resuming: { r_1: 12 } };
    expect(screen(resuming)).toContain("agent resuming");
    const after = withWorkers(
      resuming,
      statuses([
        "r_1",
        worker("r_1", { name: "kw-r_1-d12", resumed: [12], resumes: 1, decisionSeq: 12 }),
      ]),
      false,
    );
    expect(after.resuming).toEqual({});
    expect(screen(after)).toContain("agent running (session 2)");
    expect(screen(after)).toContain("AGENT · kw-r_1-d12 (session 2)");
  });

  test("task_9pns_card_says_why_a_decision_is_not_offered", () => {
    const decided = session("r_1", "running", { lastWait: WAIT, decision: DECIDED, moved: false });
    const cases: [WorkerStatus, Session, string][] = [
      [
        worker("r_1", { state: "exited", label: "exited (1)", exitCode: 1, since: NOW - 40_000 }),
        session("r_1", "running"),
        "agent exited (1), not at a gate",
      ],
      [worker("r_1"), decided, "agent running"],
      [worker("r_1", { state: "killed", label: "stopped" }), decided, "agent stopped"],
      [
        worker("r_1", { state: "lost", label: "lost (holder gone)" }),
        decided,
        "agent lost (holder gone)",
      ],
      [
        worker("r_1", { state: "unknown", label: "unknown (cannot be read)" }),
        decided,
        "agent unknown (cannot be read)",
      ],
      [
        worker("r_1", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
        { ...decided, decision: { ...DECIDED, byAgent: true } },
        "agent exited; an agent decided and goes on",
      ],
      [
        worker("r_1", {
          state: "exited",
          label: "exited (0)",
          since: NOW - 20_000,
          name: "kw-r_1-d12",
          resumed: [12],
          resumes: 1,
          decisionSeq: 12,
        }),
        decided,
        "kw-r_1-d12 ended: kodel agent logs kw-r_1-d12",
      ],
      [
        {
          ...worker("r_1", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
          sessionId: undefined,
        } as WorkerStatus,
        decided,
        "no session id",
      ],
    ];
    for (const [w, s, words] of cases) {
      const m = withWorkers(model([s]), statuses(["r_1", w]), false);
      expect(screen(m)).toContain(words);
      expect(footer(m)).not.toContain("s resume");
      const pressed = update(m, "s");
      expect(effects(pressed)).toEqual([]);
      expect(pressed.notice.startsWith("Nothing to resume:")).toBe(true);
    }
    // The crash names the command for any agent.
    const crashed = update(
      withWorkers(
        model([session("r_1", "running")]),
        statuses(["r_1", worker("r_1", { state: "exited", label: "exited (1)", exitCode: 1 })]),
        false,
      ),
      "s",
    );
    expect(crashed.notice).toContain("pipeline_next_step r_1");
    // The TUI's own step running.
    const busy = withWorkers(
      model([decided]),
      statuses([
        "r_1",
        worker("r_1", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
      ]),
      true,
    );
    expect(screen(busy)).toContain("the TUI is running the step");
    expect(busy.offers.r_1?.offer).toBeUndefined();
  });

  test("task_9pns_s_asks_to_resume_y_confirms", () => {
    const decided = session("r_1", "running", {
      lastWait: WAIT,
      decision: { ...DECIDED, reason: "fine" },
      moved: true,
    });
    const m = withWorkers(
      model([decided]),
      statuses([
        "r_1",
        worker("r_1", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
      ]),
      false,
    );
    const askedToResume = update(m, "s");
    expect(effects(askedToResume)).toEqual([]);
    const bar = screen(askedToResume, WIDER);
    expect(bar).toContain("┌─ Resume agent «run-r_1» ");
    expect(bar).toContain(
      'Resume the agent of r_1 after your gate "plan-approval" approved (10s ago)?',
    );
    expect(bar).toContain("y resume · Esc or any other key cancels");
    expect(bar).toContain("[y Resume]");
    expect(bar).toContain("an agent was served a step since your decision");
    expect(footer(askedToResume)).toContain("y resume");
    const yes = press(askedToResume, "y");
    expect(effects(yes)).toEqual([{ type: "resume_worker", runId: "r_1", seq: 12 }]);
    expect(yes.resuming).toEqual({ r_1: 12 });
    expect(screen(yes)).toContain("agent resuming");
    for (const other of ["n", "a", "r", "s", "q", "Y"]) {
      const no = press(askedToResume, other);
      expect(effects(no)).toEqual([]);
      expect(no.notice).toBe("Cancelled.");
      expect(no.quit).toBe(false);
    }
    // Too early: the guard.
    const early = update(
      { ...askedToResume, now: (askedToResume.resume?.askedAt ?? 0) + COMMENT_GUARD_MS - 1 },
      "y",
    );
    expect(effects(early)).toEqual([]);
    expect(early.resume).not.toBeNull();
    // A failure is told once, and the offer stays for the next `s`.
    const failed = withResumed(clean(yes), "r_1", {
      ok: false,
      message:
        "run r_1 was not resumed: boom. Any agent in the project continues it with pipeline_next_step and this run id.",
    });
    expect(footer(failed)).toContain("run r_1 was not resumed: boom.");
    expect(failed.resuming).toEqual({});
    expect(failed.offers.r_1?.offer).toBeDefined();
    const retry = update(failed, "s");
    expect(retry.resume).not.toBeNull();
  });

  test("task_9pns_no_resume_without_a_key", () => {
    const decided = session("r_1", "running", { lastWait: WAIT, decision: DECIDED, moved: false });
    let m = model([decided]);
    for (let i = 0; i < 20; i += 1) {
      m = withWorkers(
        m,
        statuses([
          "r_1",
          worker("r_1", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
        ]),
        false,
      );
      m = withData(m, { sessions: [decided], proposals: 0 }, NOW + i);
      m = withProgress(m, "r_1", { lines: ["result: ok"] });
    }
    expect(effects(m)).toEqual([]);
    expect(m.offers.r_1?.offer).toBeDefined();
    expect(m.resuming).toEqual({});
  });

  test("task_9pns_progress_task_whose_run_ended_offers_s_again", () => {
    const progress = row("T-P", { state: "progress", status: "progress", runCount: 1 });
    const ended = session("r_1", "failed", { taskKey: "T-P" });
    const base = withTasks(model([ended]), ready([], [progress]));
    const card: Model = {
      ...base,
      pick: { kind: "task", key: "T-P" },
      tasks: { ...base.tasks, drill: ["T-P"] },
    };
    const q = asked(
      withTask(card, "T-P", {
        status: "ready",
        card: {
          key: "T-P",
          title: "t",
          state: "progress",
          status: "progress",
          runs: ["r_1"],
          comments: [],
          subtasks: [],
        },
      }),
    );
    const yes = press(q.m, "y");
    expect(startOf(yes)).toEqual({ type: "start_task", key: "T-P", pipeline: "dev", seq: q.seq });
  });

  test("task_9pns_digest_is_plain_bounded_and_names_the_log", () => {
    const hostile = `${ESC}[31mred${ESC}[0m ‮ reversed ​ zero ${ESC}]0;title\u0007`;
    const many = Array.from({ length: 20 }, (_, i) => `line ${i} ${hostile}`);
    const tail = many
      .map((text) =>
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text },
              { type: "tool_use", name: "Bash", input: { command: `echo ${hostile}` } },
            ],
          },
        }),
      )
      .join("\n");
    const parsed = digest(tail);
    const m = withProgress(
      withWorkers(model([session("r_1", "running")]), statuses(["r_1", worker("r_1")]), false),
      "r_1",
      { lines: parsed },
    );
    const shown = lines(m);
    const texts = shown.filter((l) => l.includes("> line "));
    const calls = shown.filter((l) => l.includes("→ Bash: echo"));
    expect(texts.length + calls.length).toBe(DIGEST_LINES);
    expect(shown.some((l) => l.includes("line 19"))).toBe(true);
    expect(shown.some((l) => l.includes("line 10"))).toBe(false);
    for (const l of render(m, WIDE)) {
      // Only the styles the screens write; nothing of the agent's escapes, controls or marks.
      expect(l.replace(OWN_STYLE, "")).not.toMatch(UNSAFE);
    }
    expect(shown.some((l) => l.includes("$ kodel agent logs kw-r_1"))).toBe(true);
  });

  test("task_9pns_digest_redacts_decoded_text", () => {
    const rules = [{ name: "project-secret", pattern: /SECRET-[A-Z0-9]+/g }];
    // A multi-line secret that is JSON-escaped in the raw bytes: the holder's pattern never sees it whole.
    const text = "the key is SECRET-ABC\n123 and more";
    const tail = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    });
    expect(tail).toContain("SECRET-ABC\\n");
    const shown = digest(tail, { rules });
    expect(shown.join("\n")).not.toContain("SECRET-ABC");
    expect(shown.join("\n")).toContain("[REDACTED:project-secret]");
    // A `replace` rule applies to the decoded text as well.
    const replacing = [
      {
        name: "mail",
        pattern: /([a-z]+)@example\.com/g,
        replace: (_m: string, user: string) => `${user}@…`,
      },
    ];
    expect(
      digest(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "mail bob@example.com" }] },
        }),
        { rules: replacing },
      ),
    ).toEqual(["> mail bob@…"]);
  });

  test("task_9pns_digest_spans_two_sessions", () => {
    const first = withProgress(
      withWorkers(model([session("r_1", "running")]), statuses(["r_1", worker("r_1")]), false),
      "r_1",
      { lines: ["init · 3 tools (kodel 1)", "> half of an eve"] },
    );
    const resumed = withWorkers(
      first,
      statuses([
        "r_1",
        worker("r_1", { name: "kw-r_1-d12", resumed: [12], resumes: 1, decisionSeq: 12 }),
      ]),
      false,
    );
    // Until the latest record is read the old digest stays; then the new one replaces it whole.
    expect(screen(resumed)).toContain("half of an eve");
    const read = withProgress(resumed, "r_1", {
      lines: digest(
        `${JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-2222-4333-8444-555555555555", tools: [] })}\n`,
        { resumed: { session: 2, sessionId: UUID } },
      ),
    });
    const text = screen(read);
    expect(text).toContain("· resumed (session 2)");
    expect(text).toContain("· session id changed");
    expect(text).not.toContain("half of an eve");
  });
});

// ── the loop ─────────────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function terminal(cols = 200, rows = 32) {
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
    since: (mark = 0) => stripAnsi(written.slice(mark).join("")),
    /** The last whole frame drawn. */
    last: () => {
      const raw = written.join("");
      return stripAnsi(raw.slice(raw.lastIndexOf("\u001b[1;1H")));
    },
    mark: () => written.length,
  };
}

/** A loop over a mutable list of sessions and the fake launcher, with short timers. */
function loop(
  sessions: Session[],
  launcher: FakeLauncher,
  options: Partial<TuiOptions> & { loads?: number[] } = {},
) {
  const t = terminal();
  const loads = options.loads ?? [];
  const load = async (): Promise<Loaded> => {
    loads.push(Date.now());
    return { sessions: [...sessions], proposals: 0 };
  };
  const done = runTui(t.stdin, t.stdout, load, "project", {
    refreshMs: 40,
    workerRefreshMs: 30,
    workers: { statuses: (ids) => launcher.statuses(ids), progress: (id) => launcher.progress(id) },
    resumeWorker: async (runId, seq, sessionId) => {
      try {
        const { name } = await launcher.resume({
          runId,
          workdir: "/w",
          sessionId: sessionId ?? "",
          decision: { seq, ts: NOW, kind: "gate", node: "plan-approval", outcome: "approved" },
        });
        return { ok: true, runId, message: `Resumed the agent of ${runId} as ${name}.` };
      } catch (error) {
        if (error instanceof SessionError && error.code === "NAME_TAKEN") {
          return {
            ok: false,
            message: `run ${runId} was not resumed: already resumed (kodel agent ls).`,
          };
        }
        return {
          ok: false,
          message: `run ${runId} was not resumed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    ...options,
  });
  return {
    t,
    done,
    quit: async () => {
      t.type("q");
      await done;
    },
  };
}

const decidedSession = (id = "r_1"): Session =>
  session(id, "running", { lastWait: WAIT, decision: DECIDED, moved: false });

describe("task_9pns the loop and the worker reads", () => {
  test("task_9pns_worker_read_one_at_a_time_and_newest_wins", async () => {
    const launcher = new FakeLauncher();
    launcher.statusMap.set("r_1", worker("r_1"));
    let release: () => void = () => undefined;
    launcher.holdStatuses.push(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const { t, quit } = loop([session("r_1", "running")], launcher);
    await wait(150);
    // The first read hangs: no second read starts meanwhile.
    expect(launcher.calls.filter((c) => c === "statuses").length).toBe(1);
    launcher.statusMap.set(
      "r_1",
      worker("r_1", { state: "exited", label: "exited (0)", exitCode: 0 }),
    );
    release();
    await wait(100);
    // The reads go on, and the newest answer is what the screen shows.
    expect(launcher.calls.filter((c) => c === "statuses").length).toBeGreaterThan(1);
    expect(t.since()).toContain("agent exited (0)");
    await quit();
  });

  test("task_9pns_worker_read_hanging_leaves_reload_completing_and_does_not_block_the_loop", async () => {
    const launcher = new FakeLauncher();
    launcher.statusMap.set("r_1", worker("r_1"));
    launcher.holdStatuses.push(new Promise<void>(() => undefined));
    const loads: number[] = [];
    const { t, quit } = loop([session("r_1", "running")], launcher, { loads });
    await wait(200);
    // The runs are read again and again while the worker read hangs.
    expect(loads.length).toBeGreaterThan(2);
    expect(t.since()).toContain("RUNNING");
    await quit();
  });

  test("task_9pns_worker_read_failure_marks_unknown_keeps_digest", async () => {
    const launcher = new FakeLauncher();
    launcher.statusMap.set("r_1", worker("r_1"));
    launcher.progressMap.set("r_1", { lines: ["init · 3 tools (kodel 1)", "> working on it"] });
    const { t, quit } = loop([session("r_1", "running")], launcher);
    await wait(120);
    expect(t.since()).toContain("> working on it");
    launcher.failStatuses = new Error("kodel agent ls failed");
    const mark = t.mark();
    await wait(120);
    const after = t.since(mark);
    expect(after).toContain("agent unknown (cannot be read)");
    expect(after).toContain("> working on it");
    await quit();
  });

  test("task_9pns_worker_read_tails_selected_run_only_offers_any_run", async () => {
    const launcher = new FakeLauncher();
    launcher.statusMap.set("r_1", worker("r_1"));
    launcher.statusMap.set(
      "r_2",
      worker("r_2", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
    );
    launcher.progressMap.set("r_1", { lines: ["> one"] });
    launcher.progressMap.set("r_2", { lines: ["> two"] });
    // A hanging progress read must not delay the offer of the other run.
    launcher.holdProgress = new Promise<void>(() => undefined);
    const { t, quit } = loop([session("r_1", "running"), decidedSession("r_2")], launcher);
    await wait(150);
    const progressed = launcher.calls.filter((c) => c.startsWith("progress"));
    expect(progressed.length).toBeGreaterThan(0);
    expect(new Set(progressed).size).toBe(1);
    expect(t.since()).toContain("◆ s resumes");
    await quit();
  });

  test("task_9pns_worker_read_skipped_on_win32", async () => {
    const launcher = new FakeLauncher();
    launcher.statusMap.set("r_1", worker("r_1"));
    const { t, quit } = loop([session("r_1", "running")], launcher, { platform: "win32" });
    await wait(150);
    expect(launcher.calls).toEqual([]);
    expect(t.since()).not.toContain("agent");
    await quit();
  });

  test("task_9pns_s_then_y_resumes_once_and_the_same_gate_again_offers_only_after_a_new_decision", async () => {
    const launcher = new FakeLauncher();
    launcher.statusMap.set(
      "r_1",
      worker("r_1", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
    );
    const sessions = [decidedSession()];
    const { t, quit } = loop(sessions, launcher);
    // Twenty refreshes with no key: nothing starts, the card offers.
    await wait(700);
    expect(launcher.resumes).toEqual([]);
    expect(t.since()).toContain("s resumes");
    t.type("s");
    await wait(COMMENT_GUARD_MS + 50);
    t.type("y");
    await wait(100);
    expect(launcher.resumes.length).toBe(1);
    expect(launcher.resumes[0]).toMatchObject({
      runId: "r_1",
      sessionId: UUID,
      decision: { seq: 12 },
    });
    expect(t.since()).toContain("agent running (session 2)");
    // The resumed worker reaches the same gate again and exits: waiting for you, no offer.
    launcher.exited("r_1", Date.now());
    const again = session("r_1", "waiting", {
      lastWait: { ...WAIT, seq: 20, ts: Date.now() - 10 },
      decision: DECIDED,
      moved: false,
    });
    sessions.splice(0, 1, again);
    const mark = t.mark();
    await wait(150);
    expect(t.since(mark)).toContain("agent waiting for you");
    t.type("s");
    await wait(50);
    expect(t.since(mark)).toContain("Nothing to resume");
    // A new decision: the offer returns and `s`+`y` makes exactly one more record, named after it.
    sessions.splice(
      0,
      1,
      session("r_1", "running", {
        lastWait: again.lastWait,
        decision: { ...DECIDED, seq: 22, ts: Date.now() },
        moved: false,
      }),
    );
    await wait(150);
    t.type("s");
    await wait(COMMENT_GUARD_MS + 50);
    t.type("y");
    await wait(100);
    expect(launcher.resumes.map((r) => r.decision.seq)).toEqual([12, 22]);
    expect(launcher.statusMap.get("r_1")?.name).toBe("kw-r_1-d22");
    await quit();
  });

  test("task_9pns_resume_once_under_overlapping_refreshes", async () => {
    const launcher = new FakeLauncher();
    launcher.statusMap.set(
      "r_1",
      worker("r_1", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
    );
    let release: () => void = () => undefined;
    launcher.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { t, quit } = loop([decidedSession()], launcher, { workerRefreshMs: 10, refreshMs: 10 });
    await wait(100);
    t.type("s");
    await wait(COMMENT_GUARD_MS + 50);
    t.type("y");
    await wait(60);
    // A second `s`+`y` during the slow start: the row says it is being resumed, nothing more starts.
    t.type("s");
    await wait(20);
    expect(t.since()).toContain("r_1 is being resumed");
    t.type("y");
    release();
    await wait(100);
    expect(launcher.resumes.length).toBe(1);
    // And after it: already resumed.
    t.type("s");
    await wait(30);
    expect(launcher.resumes.length).toBe(1);
    await quit();
  });

  test("task_9pns_resume_once_with_two_tuis", async () => {
    const launcher = new FakeLauncher();
    launcher.statusMap.set(
      "r_1",
      worker("r_1", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
    );
    const a = loop([decidedSession()], launcher);
    const b = loop([decidedSession()], launcher);
    await wait(100);
    a.t.type("s");
    b.t.type("s");
    await wait(COMMENT_GUARD_MS + 50);
    a.t.type("y");
    b.t.type("y");
    await wait(150);
    expect(launcher.resumes.length).toBe(2);
    expect(launcher.statusMap.get("r_1")?.resumed).toEqual([12]);
    const told = `${a.t.since()}${b.t.since()}`;
    expect(told).toContain("already resumed");
    expect(told).toContain("Resumed the agent of r_1 as kw-r_1-d12.");
    await a.quit();
    await b.quit();
  });

  test("task_9pns_offer_waits_for_the_tuis_own_step", async () => {
    const launcher = new FakeLauncher();
    launcher.statusMap.set(
      "r_1",
      worker("r_1", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
    );
    let pending = true;
    const work: WorkHandle = {
      pending: () => pending,
      wait: async () => undefined,
      stop: async () => undefined,
    };
    const { t, quit } = loop([decidedSession()], launcher, { work });
    await wait(120);
    expect(t.since()).not.toContain("s resumes");
    expect(t.since()).toContain("the TUI is running the step");
    t.type("s");
    await wait(30);
    expect(t.since()).toContain("Nothing to resume: the TUI is running the step");
    pending = false;
    const mark = t.mark();
    await wait(100);
    expect(t.since(mark)).toContain("s resumes");
    await quit();
  });

  test("task_9pns_offer_when_the_tui_opens_later_and_served_after_the_decision_is_a_warning", async () => {
    const launcher = new FakeLauncher();
    launcher.statusMap.set(
      "r_1",
      worker("r_1", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
    );
    // The TUI was closed when the decision was made: a new loop's first refresh offers and starts nothing.
    const first = loop([{ ...decidedSession(), moved: true }], launcher);
    await wait(120);
    expect(launcher.resumes).toEqual([]);
    expect(first.t.since()).toContain("s resumes · an agent was served a");
    first.t.type("s");
    await wait(COMMENT_GUARD_MS + 50);
    expect(first.t.since()).toContain("an agent was served a step since your decision");
    first.t.type("y");
    await wait(100);
    expect(launcher.resumes.length).toBe(1);
    await first.quit();
    // A second new loop: already resumed.
    const second = loop([decidedSession()], launcher);
    await wait(120);
    second.t.type("s");
    await wait(30);
    expect(second.t.since()).toContain("Nothing to resume");
    expect(launcher.resumes.length).toBe(1);
    await second.quit();
  });

  test("task_9pns_crash_stopped_and_lost_are_not_offered_and_a_removed_record_is_offered_once_more", async () => {
    const launcher = new FakeLauncher();
    for (const [id, w] of [
      [
        "r_1",
        worker("r_1", { state: "exited", label: "exited (1)", exitCode: 1, since: NOW - 40_000 }),
      ],
      ["r_2", worker("r_2", { state: "killed", label: "stopped" })],
      ["r_3", worker("r_3", { state: "lost", label: "lost (holder gone)" })],
    ] as const) {
      launcher.statusMap.set(id, w);
    }
    const sessions = [
      session("r_1", "running", { lastWait: WAIT, decision: DECIDED }),
      decidedSession("r_2"),
      decidedSession("r_3"),
    ];
    const { t, quit } = loop(sessions, launcher);
    await wait(150);
    for (const id of ["r_1", "r_2", "r_3"]) {
      t.type("s");
      await wait(30);
      expect(launcher.resumes).toEqual([]);
      t.type("\u001b[B");
      await wait(20);
      void id;
    }
    expect(t.since()).toContain("not at a gate");
    expect(t.since()).toContain("agent stopped");
    expect(t.since()).toContain("agent lost");
    await quit();
    // Decision 5a: `agent rm` of the resume record: the same decision is offered once more.
    const again = new FakeLauncher();
    again.statusMap.set(
      "r_1",
      worker("r_1", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
    );
    const sessions2 = [decidedSession()];
    const l = loop(sessions2, again);
    await wait(100);
    l.t.type("s");
    await wait(COMMENT_GUARD_MS + 50);
    l.t.type("y");
    await wait(100);
    expect(again.resumes.length).toBe(1);
    // The person removed `kw-r_1-d12`: the records are as before the resume.
    again.statusMap.set(
      "r_1",
      worker("r_1", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
    );
    sessions2.splice(0, 1, { ...decidedSession(), moved: true });
    await wait(100);
    expect(l.t.since()).toContain("an agent was served a");
    l.t.type("s");
    await wait(COMMENT_GUARD_MS + 50);
    l.t.type("y");
    await wait(100);
    expect(again.resumes.length).toBe(2);
    // After the second resume, twenty refreshes start nothing.
    await wait(700);
    expect(again.resumes.length).toBe(2);
    await l.quit();
  });

  test("task_9pns_resume_failure_is_told_and_s_retries_name_used_and_a_dead_resume_record", async () => {
    const launcher = new FakeLauncher();
    launcher.statusMap.set(
      "r_1",
      worker("r_1", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
    );
    launcher.failResume = new SessionError("HOLDER_BOOT_FAILED", "the holder did not answer");
    const { t, quit } = loop([decidedSession()], launcher);
    await wait(100);
    t.type("s");
    await wait(COMMENT_GUARD_MS + 50);
    t.type("y");
    await wait(100);
    expect(launcher.resumes.length).toBe(1);
    expect(t.since()).toContain("run r_1 was not resumed: the holder did not answer");
    // Twenty refreshes: nothing more starts; the offer stays, `s`+`y` is the retry.
    await wait(700);
    expect(launcher.resumes.length).toBe(1);
    expect(t.since()).toContain("s resumes");
    launcher.failResume = new SessionError(
      "NAME_USED",
      "the name was used by a session that is gone",
    );
    t.type("s");
    await wait(COMMENT_GUARD_MS + 50);
    t.type("y");
    await wait(100);
    expect(launcher.resumes.length).toBe(2);
    expect(t.since()).toContain("the name was used by a session that is gone");
    // A holder boot that timed out and kept a `-d<seq>` record: not offered, the card says it ended.
    launcher.statusMap.set(
      "r_1",
      worker("r_1", {
        name: "kw-r_1-d12",
        state: "killed",
        label: "failed (could not start)",
        resumed: [12],
        resumes: 1,
        decisionSeq: 12,
      }),
    );
    await wait(150);
    expect(t.last()).toContain("agent failed (could not start)");
    expect(t.last()).not.toContain("s resumes");
    await quit();
  });
});

// ── the form of a new task ──────────────────────────────────────────────────

const createOf = (m: Model): Extract<Effect, { type: "create_task" }> | undefined =>
  effects(m).find((e): e is Extract<Effect, { type: "create_task" }> => e.type === "create_task");

/** Types a text one key at a time, as a person does. */
const typeText = (m: Model, text: string): Model => press(m, ...[...text]);

describe("task_9pns the form of a new task", () => {
  const backlog = () => model([session("r_1", "running")], ready([row("T-A1"), row("T-A2")]));
  const onBacklog = () => clean(press(backlog(), "down"));
  const onTasks = () => clean(press(backlog(), "3"));

  test("task_9pns_n_opens_the_form_from_the_backlog_and_the_tasks_screen", () => {
    for (const base of [onBacklog(), onTasks(), { ...onTasks(), focus: "card" as const }]) {
      const opened = update(clean(base), "n");
      expect(opened.taskForm).not.toBeNull();
      expect(opened.taskForm?.field).toBe("title");
      expect(effects(opened)).toEqual([]);
      const shown = screen(opened);
      expect(shown).toContain("┌─ New task ");
      expect(shown).toContain("▸ Title");
      expect(shown).toContain("Body");
      expect(shown).toContain("Priority");
      expect(shown).toContain("tracker's default");
      expect(shown).toContain("Parent");
      expect(shown).toContain("Status    todo (a new task starts there)");
      expect(shown).toContain("[Enter Create]");
      expect(shown).toContain("[Esc Cancel]");
      expect(footer(opened)).toContain("Enter create");
      expect(footer(opened)).toContain("Esc cancel");
    }
    // The hint names the key on both screens.
    expect(footer(onBacklog())).toContain("n new");
    expect(footer(onTasks())).toContain("n new");
    expect(footer({ ...onBacklog(), focus: "card" })).toContain("n new");
    // On a run row `n` does nothing of the kind; on sample data it says so.
    expect(update(clean(backlog()), "n").taskForm).toBeNull();
    const demo = update({ ...clean(onBacklog()), source: "demo" }, "n");
    expect(demo.taskForm).toBeNull();
    expect(demo.notice).toBe("creating a task is not available in --demo");
    // With the tasks off or not yet read, `n` says why.
    const off = update(press(withTasks(backlog(), { status: "off" }), "3"), "n");
    expect(off.taskForm).toBeNull();
    expect(off.notice).toContain("tasks are off");
    const unread = update(model([session("r_1", "running")]), "3");
    expect(update(unread, "n").notice).toContain("still being read");
    // With no runs and no tasks at all, `n` still works on the first screen.
    const empty = update(model([], ready([])), "n");
    expect(empty.taskForm).not.toBeNull();
  });

  test("task_9pns_form_fields_are_typed_walked_and_bounded", () => {
    let m = update(onBacklog(), "n");
    m = typeText(m, "Fix the login timeout");
    expect(m.taskForm?.title).toBe("Fix the login timeout");
    expect(screen(m)).toContain("▸ Title    Fix the login timeout▏");
    // Tab walks on; Enter in the body is a line break; the arrows cycle the priority; shift-tab walks back.
    m = press(m, "tab");
    expect(m.taskForm?.field).toBe("body");
    m = typeText(m, "first");
    m = press(m, "enter");
    m = typeText(m, "second");
    expect(m.taskForm?.body).toBe("first\nsecond");
    expect(screen(m)).toContain("Enter is a new line here");
    m = press(m, "down");
    expect(m.taskForm?.field).toBe("priority");
    expect(typeText(m, "x").taskForm?.priority).toBe(0);
    m = press(m, "right");
    expect(FORM_PRIORITIES[m.taskForm?.priority ?? 0]).toBe("high");
    expect(screen(m)).toContain("▸ Priority high");
    m = press(m, "right", "right");
    expect(FORM_PRIORITIES[m.taskForm?.priority ?? 0]).toBe("low");
    m = press(m, "left", "left", "left");
    expect(FORM_PRIORITIES[m.taskForm?.priority ?? 0]).toBeUndefined();
    m = press(m, " ");
    expect(FORM_PRIORITIES[m.taskForm?.priority ?? 0]).toBe("high");
    m = press(m, "tab");
    expect(m.taskForm?.field).toBe("parent");
    m = typeText(m, "T-A1");
    m = press(m, "backspace");
    expect(m.taskForm?.parent).toBe("T-A");
    m = press(m, "shift-tab");
    expect(m.taskForm?.field).toBe("priority");
    m = press(m, "up", "up");
    expect(m.taskForm?.field).toBe("title");
    // The title is bounded as the contract bounds it: the 201st character is not taken.
    const long = typeText(update(onBacklog(), "n"), "a".repeat(205));
    expect(long.taskForm?.title.length).toBe(200);
    // Nothing is sent by typing alone.
    expect(effects(m)).toEqual([]);
  });

  test("task_9pns_form_enter_then_y_creates_and_the_text_is_cleaned", () => {
    let m = typeText(update(onBacklog(), "n"), "Fix it");
    m = press(m, "tab");
    m = typeText(m, "a body");
    m = press(m, "tab", "right", "tab");
    m = typeText(m, "T-A1");
    const asked = press(m, "enter");
    expect(asked.taskForm?.confirmAt).toBeDefined();
    expect(screen(asked)).toContain("Create this task?");
    expect(screen(asked)).toContain("[y Create]");
    expect(footer(asked)).toContain("y create");
    // Any other key goes back to the fields, which are kept.
    const back = press(asked, "x");
    expect(back.taskForm?.confirmAt).toBeUndefined();
    expect(back.taskForm?.title).toBe("Fix it");
    const yes = press(asked, "y");
    expect(createOf(yes)).toEqual({
      type: "create_task",
      seq: 1,
      input: { title: "Fix it", body: "a body", priority: "high", parent: "T-A1" },
    });
    expect(yes.taskForm?.writing).toBe(true);
    expect(screen(yes)).toContain("Creating the task…");
    // While it is being made the fields are read-only: nothing is typed, nothing else is sent, and a second
    // Enter or `y` cannot create it again (see task_9pns_form_esc_while_writing_closes_and_the_answer_is_told).
    const held = press(clean(yes), "a", "enter", "y", "tab", "backspace");
    expect(held.effects).toEqual([]);
    expect(held.taskForm).toEqual(yes.taskForm);
    // The answer: the form closes on a success with the key in the notice; a failure keeps the fields.
    const made = withTaskCreated(clean(yes), 1, {
      ok: true,
      key: "T-NEW",
      message: "Created T-NEW: Fix it",
    });
    expect(made.taskForm).toBeNull();
    expect(footer(made)).toContain("Created T-NEW: Fix it");
    const failed = withTaskCreated(clean(yes), 1, {
      ok: false,
      message: "Could not create the task: the tracker is down",
    });
    expect(failed.taskForm?.writing).toBe(false);
    expect(failed.taskForm?.title).toBe("Fix it");
    expect(footer(failed)).toContain("the tracker is down");
    // An answer for another form (an earlier one, closed while it was being created) leaves this one alone and is told.
    const other = withTaskCreated(clean(yes), 7, { ok: true, message: "Created T-X: earlier" });
    expect(other.taskForm).toEqual(yes.taskForm);
    expect(other.notice).toBe("Created T-X: earlier");
    // Empty fields are left out; the title and the parent lose their control characters, the body keeps its lines.
    let plainOne = typeText(update(onBacklog(), "n"), "Only a title");
    plainOne = press(plainOne, "enter");
    expect(createOf(press(plainOne, "y"))?.input).toEqual({ title: "Only a title" });
    const dirty = press(
      update(onBacklog(), "n"),
      ...[..."ok"],
      "\u0007",
      "tab",
      ...[..."l1"],
      "enter",
      ...[..."l2"],
    );
    expect(dirty.taskForm?.title).toBe("ok");
    expect(createOf(press(press(dirty, "shift-tab", "enter"), "y"))?.input).toEqual({
      title: "ok",
      body: "l1\nl2",
    });
  });

  test("task_9pns_form_refuses_an_empty_title_and_esc_cancels", () => {
    const opened = update(onBacklog(), "n");
    const refused = press(opened, "enter");
    expect(refused.taskForm).not.toBeNull();
    expect(refused.taskForm?.confirmAt).toBeUndefined();
    expect(refused.notice).toBe("A task needs a title.");
    expect(effects(refused)).toEqual([]);
    // A title with nothing visible in it is empty too, and the cursor goes back to it.
    let blank = press(opened, "tab");
    blank = typeText(blank, "a body");
    blank = press(blank, "shift-tab");
    blank = typeText(blank, " ​ ");
    // Enter on the priority field (in the body it is a line break) asks, and is refused.
    const back = press(blank, "tab", "tab", "enter");
    expect(back.notice).toBe("A task needs a title.");
    expect(back.taskForm?.field).toBe("title");
    expect(effects(back)).toEqual([]);
    // Esc cancels at every stage.
    expect(press(opened, "escape").taskForm).toBeNull();
    expect(press(opened, "escape").notice).toBe("Cancelled.");
    const asked = press(typeText(opened, "t"), "enter");
    expect(press(asked, "escape").taskForm).toBeNull();
    // While the form is up no other key reaches the screens: `q` does not quit, `s` starts nothing.
    const held = press(typeText(opened, "x"), "q", "s", "1", "tab");
    expect(held.quit).toBe(false);
    expect(held.start).toBeNull();
    expect(held.section).toBe(0);
    expect(held.taskForm?.title).toBe("xqs1");
  });

  test("task_9pns_form_guards_enter_and_y_and_a_paste_creates_nothing", () => {
    const opened = typeText(update(onBacklog(), "n"), "Fix it");
    const openedAt = opened.taskForm?.openedAt ?? 0;
    // Enter too early after the form opened, or with other keys in its chunk, asks nothing.
    const early = update({ ...opened, now: openedAt + COMMENT_GUARD_MS - 1 }, "enter");
    expect(early.taskForm?.confirmAt).toBeUndefined();
    expect(early.notice).toBe("Wait a moment, then press Enter again.");
    expect(update(opened, "enter", WIDE, false).taskForm?.confirmAt).toBeUndefined();
    const asked = update({ ...opened, now: openedAt + COMMENT_GUARD_MS }, "enter");
    expect(asked.taskForm?.confirmAt).toBe(openedAt + COMMENT_GUARD_MS);
    // `y` too early after the question, or not alone, creates nothing.
    const soon = update({ ...asked, now: asked.now + COMMENT_GUARD_MS - 1 }, "y");
    expect(createOf(soon)).toBeUndefined();
    expect(soon.taskForm?.confirmAt).toBeDefined();
    expect(soon.notice).toBe("Wait a moment, then press y.");
    const burst = update({ ...asked, now: asked.now + 1000 }, "y", WIDE, false);
    expect(createOf(burst)).toBeUndefined();
    expect(burst.taskForm?.confirmAt).toBeUndefined();
    expect(createOf(update({ ...asked, now: asked.now + COMMENT_GUARD_MS }, "y"))).toBeDefined();
    // Only a lowercase `y` creates, as the window says: `Y` goes back to the fields like any other key.
    const capital = update({ ...asked, now: asked.now + COMMENT_GUARD_MS }, "Y");
    expect(createOf(capital)).toBeUndefined();
    expect(capital.taskForm?.confirmAt).toBeUndefined();
    expect(capital.taskForm?.title).toBe("Fix it");
    // A bracketed paste is text for the field that has the cursor, and never a key.
    const reader = createInputReader();
    const pasted = applyInput(
      opened,
      `${ESC}[200~ and more\ny${ESC}[201~`,
      WIDE,
      reader,
      NOW + 1000,
    );
    expect(pasted.taskForm?.title).toBe("Fix it and more y");
    expect(pasted.taskForm?.confirmAt).toBeUndefined();
    expect(createOf(pasted)).toBeUndefined();
    // Into the body, a paste keeps its line breaks and loses the other control characters.
    const inBody = applyInput(
      press(opened, "tab"),
      `${ESC}[200~one\r\ntwo\u0007three${ESC}[201~`,
      WIDE,
      createInputReader(),
      NOW + 1000,
    );
    expect(inBody.taskForm?.body).toBe("one\ntwothree");
    // On the question the paste is ignored and the person is told.
    const onQuestion = applyInput(
      asked,
      `${ESC}[200~y${ESC}[201~`,
      WIDE,
      createInputReader(),
      NOW + 1000,
    );
    expect(onQuestion.taskForm?.title).toBe("Fix it");
    expect(onQuestion.notice).toContain("pasted text was ignored");
    // A chunk `ny` opens nothing and creates nothing.
    const chunk = applyInput(onBacklog(), "ny", WIDE, undefined, NOW + 1000);
    expect(createOf(chunk)).toBeUndefined();
    // Nothing hostile reaches the screen from the fields.
    const hostile = typeText(update(onBacklog(), "n"), "a‮b​c");
    for (const l of render(hostile, WIDE)) expect(l.replace(OWN_STYLE, "")).not.toMatch(UNSAFE);
  });

  test("task_9pns_form_esc_while_writing_closes_and_the_answer_is_told", () => {
    const yes = press(press(typeText(update(onBacklog(), "n"), "Fix it"), "enter"), "y");
    expect(createOf(yes)?.seq).toBe(1);
    const writing = clean(yes);
    expect(screen(writing)).toContain("[Esc Close]");
    expect(footer(writing)).toContain("Esc close");
    expect(footer(writing)).toContain("q quit");
    // Esc closes the window; the creation is not taken back, and the person is told so.
    const closed = press(writing, "escape");
    expect(closed.taskForm).toBeNull();
    expect(closed.effects).toEqual([]);
    expect(screen(closed)).not.toContain("New task");
    expect(footer(closed)).toContain("still being created");
    // `q` quits as elsewhere; ctrl-c as before.
    expect(press(writing, "q").quit).toBe(true);
    expect(press(writing, "ctrl-c").quit).toBe(true);
    // The late answer is told, a success and a failure alike, and nothing is sent again.
    const made = withTaskCreated(closed, 1, {
      ok: true,
      key: "T-NEW",
      message: "Created T-NEW: Fix it",
    });
    expect(made.taskForm).toBeNull();
    expect(footer(made)).toContain("Created T-NEW: Fix it");
    expect(made.effects).toEqual([]);
    const failed = withTaskCreated(closed, 1, {
      ok: false,
      message: "Could not create the task: the tracker is down",
    });
    expect(failed.taskForm).toBeNull();
    expect(footer(failed)).toContain("the tracker is down");
    // A second `n` while the first create is out opens a fresh form with its own seq: its `y` is one more
    // create, and the first form's late answer leaves it alone.
    const again = typeText(update(closed, "n"), "Another");
    expect(again.taskForm?.seq).toBe(2);
    const yes2 = press(press(again, "enter"), "y");
    expect(createOf(yes2)).toEqual({ type: "create_task", seq: 2, input: { title: "Another" } });
    const late = withTaskCreated(clean(yes2), 1, {
      ok: true,
      key: "T-NEW",
      message: "Created T-NEW: Fix it",
    });
    expect(late.taskForm?.seq).toBe(2);
    expect(late.taskForm?.writing).toBe(true);
    expect(late.notice).toBe("Created T-NEW: Fix it");
    const own = withTaskCreated(late, 2, {
      ok: true,
      key: "T-N2",
      message: "Created T-N2: Another",
    });
    expect(own.taskForm).toBeNull();
    expect(own.notice).toBe("Created T-N2: Another");
  });

  test("task_9pns_form_keeps_the_focused_field_in_view_and_never_offers_to_scroll", () => {
    const SHORT = { cols: 120, rows: 14 };
    let m = typeText(update(onBacklog(), "n"), "A title");
    m = press(m, "tab");
    for (let i = 1; i <= 20; i += 1) {
      m = typeText(m, `line${i}`);
      if (i < 20) m = press(m, "enter");
    }
    // The cursor is at the end of the body: that line is in view, the window says nothing about scrolling.
    let shown = screen(m, SHORT);
    expect(shown).toContain("line20▏");
    expect(shown).not.toContain("↑↓ scroll");
    expect(shown).not.toContain("▸ Title");
    // Back on the title, the title is in view while it is typed, not the end of the body.
    m = press(m, "shift-tab");
    shown = screen(m, SHORT);
    expect(shown).toContain("▸ Title    A title▏");
    expect(shown).not.toContain("line20");
    m = typeText(m, "!");
    expect(screen(m, SHORT)).toContain("▸ Title    A title!▏");
    // The fields below the body come into view when they have the cursor.
    m = press(m, "tab", "tab");
    expect(screen(m, SHORT)).toContain("▸ Priority");
    m = press(m, "tab");
    expect(screen(m, SHORT)).toContain("▸ Parent");
    // The question is in view once it is asked.
    expect(screen(press(m, "enter"), SHORT)).toContain("Create this task?");
  });

  test("task_9pns_form_mouse_presses_the_buttons_only", () => {
    const opened = { ...typeText(update(onBacklog(), "n"), "Fix it"), mouse: true };
    const findButton = (m: Model, text: string) => {
      const rows = lines(m);
      const y = rows.findIndex((l) => l.includes(text));
      return { x: (rows[y] ?? "").indexOf(text) + 2, y: y + 1 };
    };
    const click = (m: Model, text: string) => {
      const { x, y } = findButton(m, text);
      return applyEvents(m, [{ type: "mouse", action: "press", x, y }], WIDE, m.now + 1000);
    };
    const asked = click(opened, "[Enter Create]");
    expect(asked.taskForm?.confirmAt).toBeDefined();
    const made = click(asked, "[y Create]");
    expect(createOf(made)).toBeDefined();
    expect(click(opened, "[Esc Cancel]").taskForm).toBeNull();
    // A click elsewhere does nothing while the form is up.
    const elsewhere = applyEvents(
      opened,
      [{ type: "mouse", action: "press", x: 3, y: 4 }],
      WIDE,
      opened.now + 1000,
    );
    expect(elsewhere.taskForm?.title).toBe("Fix it");
    expect(elsewhere.pick).toEqual(opened.pick);
  });

  test("task_9pns_form_create_button_asks_in_every_field_and_the_body_keeps_no_line_break", () => {
    const findButton = (m: Model, text: string) => {
      const rows = lines(m);
      const y = rows.findIndex((l) => l.includes(text));
      expect(y).toBeGreaterThan(0);
      return { x: (rows[y] ?? "").indexOf(text) + 2, y: y + 1 };
    };
    const click = (m: Model, text: string, now = m.now + 1000) => {
      const { x, y } = findButton(m, text);
      return applyEvents(m, [{ type: "mouse", action: "press", x, y }], WIDE, now);
    };
    const opened = { ...update(onBacklog(), "n"), mouse: true };
    const titled = typeText(opened, "Fix it");
    // Body focused with typed text: the button asks, and the body gets no line break.
    const inBody = typeText(press(titled, "tab"), "bo");
    expect(inBody.taskForm?.field).toBe("body");
    const asked = click(inBody, "[Enter Create]");
    expect(asked.taskForm?.confirmAt).toBeDefined();
    expect(asked.taskForm?.body).toBe("bo");
    expect(asked.notice).toBe("");
    expect(screen(asked)).toContain("Create this task?");
    expect(createOf(asked)).toBeUndefined();
    // Nothing is created until `[y Create]` or `y`; the body goes as typed.
    const made = click(asked, "[y Create]");
    expect(createOf(made)?.input).toEqual({ title: "Fix it", body: "bo" });
    expect(made.taskForm?.writing).toBe(true);
    const madeByKey = update({ ...asked, now: asked.now + 1000 }, "y");
    expect(createOf(madeByKey)?.input).toEqual({ title: "Fix it", body: "bo" });
    // The keyboard's Enter in the body stays a new line.
    const typedEnter = press(inBody, "enter");
    expect(typedEnter.taskForm?.body).toBe("bo\n");
    expect(typedEnter.taskForm?.confirmAt).toBeUndefined();
    // The button's action is not a key the keyboard can send: typed, its name is text for the field.
    const typedName = applyInput(inBody, "form-create", WIDE, undefined, inBody.now + 1000);
    expect(typedName.taskForm?.body).toBe("boform-create");
    expect(typedName.taskForm?.confirmAt).toBeUndefined();
    // Title, Priority and Parent focused: the button asks all the same, and the fields are untouched.
    for (const [field, walk] of [
      ["title", []],
      ["priority", ["tab", "tab"]],
      ["parent", ["tab", "tab", "tab"]],
    ] as const) {
      const at = press(titled, ...walk);
      expect(at.taskForm?.field).toBe(field);
      const a = click(at, "[Enter Create]");
      expect(a.taskForm?.confirmAt).toBeDefined();
      expect(a.taskForm?.title).toBe("Fix it");
      expect(a.taskForm?.body).toBe("");
      expect(a.taskForm?.parent).toBe("");
      expect(createOf(a)).toBeUndefined();
      // `[Esc Cancel]` while typing cancels in every field.
      const cancelled = click(at, "[Esc Cancel]");
      expect(cancelled.taskForm).toBeNull();
      expect(cancelled.notice).toBe("Cancelled.");
    }
    expect(click(inBody, "[Esc Cancel]").taskForm).toBeNull();
    // An empty title is refused with the notice, from the body as from anywhere, and the body is kept.
    const untitled = typeText(press(opened, "tab"), "bo");
    const refused = click(untitled, "[Enter Create]");
    expect(refused.taskForm?.confirmAt).toBeUndefined();
    expect(refused.taskForm?.field).toBe("title");
    expect(refused.taskForm?.body).toBe("bo");
    expect(refused.notice).toBe("A task needs a title.");
    expect(createOf(refused)).toBeUndefined();
    // The guards of the Enter key hold for the button: a click right after the form opened asks nothing,
    // and `[y Create]` right after the question creates nothing.
    const openedAt = inBody.taskForm?.openedAt ?? 0;
    const early = click(inBody, "[Enter Create]", openedAt + COMMENT_GUARD_MS - 1);
    expect(early.taskForm?.confirmAt).toBeUndefined();
    expect(early.taskForm?.body).toBe("bo");
    expect(early.notice).toBe("Wait a moment, then press Enter again.");
    const soon = click(
      asked,
      "[y Create]",
      (asked.taskForm?.confirmAt ?? 0) + COMMENT_GUARD_MS - 1,
    );
    expect(createOf(soon)).toBeUndefined();
    expect(soon.notice).toBe("Wait a moment, then press y.");
    // While the task is being created, `[Esc Close]` closes the window and the creation goes on.
    const closed = click(made, "[Esc Close]");
    expect(closed.taskForm).toBeNull();
    expect(closed.notice).toContain("still being created");
  });

  test("task_9pns_form_creates_through_the_task_service_and_the_backlog_refreshes", async () => {
    const created: unknown[] = [];
    const rows: TaskRow[] = [row("T-A1")];
    const source: TasksSource & {
      update: () => Promise<Answer>;
      create: (input: unknown) => Promise<Answer>;
    } = {
      list: async (input): Promise<Answer> =>
        ({
          ok: true,
          tasks: rows
            .filter((r) => input.state.includes(r.state))
            .map((r) => ({
              key: r.key,
              title: r.title,
              status: r.status,
              state: r.state,
              priority: r.priority,
              run_count: 0,
            })),
          truncated: false,
          problems: [],
        }) as Answer,
      get: async (input): Promise<Answer> => {
        const found = rows.find((r) => r.key === input.key);
        return found
          ? ({ ok: true, task: { ...found, runs: [], comments: [] }, subtasks: [] } as Answer)
          : ({ ok: false, message: "no" } as Answer);
      },
      update: async (): Promise<Answer> => ({ ok: true }),
      create: async (input): Promise<Answer> => {
        created.push(input);
        // A slow tracker: the second round answers only when the test lets it.
        if (hold) await hold;
        const key = created.length === 1 ? "T-NEW" : `T-NEW${created.length}`;
        const title = (input as { title: string }).title;
        rows.push(row(key, { title }));
        return { ok: true, task: { key } } as Answer;
      },
    };
    let hold: Promise<void> | undefined;
    const handle = await openTasksForTui("/nowhere", async () => ({ service: source }));
    if (handle.status !== "on") throw new Error("not on");
    // The creator calls only `create`; the readers it hands out cannot write.
    expect(Object.keys(handle.source).sort()).toEqual(["get", "list"]);
    expect(await handle.create?.({ title: "x" })).toEqual({ key: "T-NEW" });
    rows.pop();
    created.length = 0;
    const options = tuiTaskOptions(handle);
    expect(options.createTask).toBeDefined();
    expect(tuiTaskOptions({ status: "off" }).createTask).toBeUndefined();
    expect(tuiTaskOptions("demo", NOW).createTask).toBeUndefined();

    const launcher = new FakeLauncher();
    const { t, quit } = loop([session("r_1", "running")], launcher, options);
    await wait(100);
    expect(t.last()).toContain("T-A1");
    t.type("\u001b[B"); // down: the Backlog row
    t.type("n");
    await wait(50);
    expect(t.last()).toContain("New task");
    for (const ch of "Fix it") t.type(ch);
    await wait(COMMENT_GUARD_MS + 50);
    t.type("\r");
    await wait(50);
    expect(t.last()).toContain("Create this task?");
    await wait(COMMENT_GUARD_MS + 50);
    t.type("y");
    await wait(200);
    expect(created).toEqual([{ title: "Fix it" }]);
    expect(t.last()).toContain("Created T-NEW: Fix it");
    expect(t.last()).not.toContain("New task");
    // The list was read again at once: the Backlog shows the new task.
    expect(t.last()).toContain("T-NEW");
    // A slow tracker: Esc closes the window while the task is being created; the late success is told once
    // and the Backlog is read again all the same.
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.type("n");
    await wait(50);
    for (const ch of "Again") t.type(ch);
    await wait(COMMENT_GUARD_MS + 50);
    t.type("\r");
    await wait(COMMENT_GUARD_MS + 50);
    t.type("y");
    await wait(100);
    expect(created).toEqual([{ title: "Fix it" }, { title: "Again" }]);
    expect(t.last()).toContain("Creating the task…");
    t.type("\u001b");
    await wait(200);
    expect(t.last()).not.toContain("New task");
    expect(t.last()).toContain("still being created");
    release();
    await wait(200);
    expect(created).toHaveLength(2);
    expect(t.last()).toContain("Created T-NEW2: Again");
    expect(t.last()).toContain("T-NEW2");
    await quit();
  });

  test("task_9pns_q_waits_for_the_task_being_created_and_a_second_q_leaves_at_once", async () => {
    /** A loop with a tracker that answers a create only when the test lets it. */
    const slow = () => {
      const created: string[] = [];
      let release: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = loop([session("r_1", "running")], new FakeLauncher(), {
        loadTasks: async () => ready([row("T-A1")]),
        loadTask: async () => ({ status: "failed", message: "no" }),
        createTask: async (input) => {
          await hold;
          created.push(input.title);
          return { key: "T-NEW" };
        },
      });
      let left = false;
      void started.done.then(() => {
        left = true;
      });
      return { ...started, created, release, left: () => left };
    };
    const askToCreate = async (t: ReturnType<typeof terminal>) => {
      await wait(100);
      t.type("\u001b[B");
      t.type("n");
      for (const ch of "Fix it") t.type(ch);
      await wait(COMMENT_GUARD_MS + 50);
      t.type("\r");
      await wait(COMMENT_GUARD_MS + 50);
      t.type("y");
      await wait(50);
      expect(t.last()).toContain("Creating the task…");
    };
    // `q` while the create is out: the screen stays and says why; the create's answer leaves with the screen.
    const first = slow();
    await askToCreate(first.t);
    first.t.type("q");
    await wait(100);
    expect(first.left()).toBe(false);
    expect(first.t.last()).toContain(
      "Finishing creating the task… q again to leave now (the task may then not be created, and you will not be told).",
    );
    expect(first.created).toEqual([]);
    const mark = first.t.mark();
    first.release();
    expect(await first.done).toBe(0);
    expect(first.created).toEqual(["Fix it"]);
    // The answer came while the person waited: it is said on the shell, after the screen is given back.
    expect(first.t.since(mark).endsWith("Created T-NEW: Fix it\n")).toBe(true);
    // The same from the Backlog, after Esc closed the window: the create is still waited for.
    const closed = slow();
    await askToCreate(closed.t);
    closed.t.type("\u001b");
    await wait(100);
    expect(closed.t.last()).toContain("still being created");
    closed.t.type("q");
    await wait(100);
    expect(closed.left()).toBe(false);
    expect(closed.t.last()).toContain("Finishing creating the task…");
    closed.release();
    expect(await closed.done).toBe(0);
    expect(closed.created).toEqual(["Fix it"]);
    // A second `q` leaves at once, the create left to the tracker: the screen said that its answer will not
    // come, and nothing about it is said on the shell afterwards.
    const second = slow();
    await askToCreate(second.t);
    second.t.type("q");
    await wait(100);
    expect(second.left()).toBe(false);
    expect(second.t.last()).toContain("you will not be told");
    second.t.type("q");
    expect(await second.done).toBe(0);
    expect(second.created).toEqual([]);
    const after = second.t.mark();
    second.release();
    await wait(100);
    expect(second.created).toEqual(["Fix it"]);
    expect(second.t.since(after)).not.toContain("Created");
    expect(second.t.since(after)).not.toContain("still being created");
  });

  test("task_9pns_form_without_a_creator_says_so", async () => {
    const launcher = new FakeLauncher();
    const { t, quit } = loop([session("r_1", "running")], launcher, {
      loadTasks: async () => ready([row("T-A1")]),
      loadTask: async () => ({ status: "failed", message: "no" }),
    });
    await wait(100);
    t.type("\u001b[B");
    t.type("n");
    for (const ch of "Fix it") t.type(ch);
    await wait(COMMENT_GUARD_MS + 50);
    t.type("\r");
    await wait(COMMENT_GUARD_MS + 50);
    t.type("y");
    await wait(100);
    expect(t.last()).toContain("tasks cannot be created here");
    // The fields are kept for a retry; Esc lets go of them before the screen is left.
    expect(t.last()).toContain("New task");
    t.type("\u001b");
    await wait(200);
    await quit();
  });
});

// ── the Report tab at a human gate ──────────────────────────────────────────

const detail = (over: Partial<GateDetail> = {}): GateDetail => ({
  kind: "gate",
  node: "plan-approval",
  attempt: 1,
  position: "gate 1 of 2",
  prompt: "Read the plan. Approve to go on, or reject with what is wrong.",
  visits: [],
  checks: [],
  changes: {
    kind: "files",
    files: [
      ["docs/plans/a.md", 120],
      ["packages/cli/src/x.ts", 7],
    ],
    totalFiles: 2,
    totalLines: 127,
  },
  changedAfterChecks: [],
  comments: [],
  metrics: {
    workMs: 60_000,
    waitMs: 1000,
    stepsDone: 1,
    stepsTotal: 4,
    retries: 0,
    checksPassed: 1,
    checksTotal: 1,
  },
  journal: ["10:00:00 node_entered plan"],
  ...over,
});

const entry = (minutes: number, over: Partial<LogEntry>): LogEntry => ({
  ts: NOW - minutes * 60_000,
  kind: "text",
  text: "",
  ...over,
});

describe("task_9pns the Report tab of a run waiting at a human gate", () => {
  const TALL = { cols: 120, rows: 60 };
  const show = (m: Model) => render(m, TALL).map(stripAnsi);
  const gate = (over: Partial<Session> = {}) =>
    session("r_1", "waiting", {
      decisions: [
        {
          kind: "gate",
          node: "plan-approval",
          prompt: "Read the plan.",
          command: "kodel gate approve r_1",
        },
      ],
      lastWait: WAIT,
      ...over,
    });
  const withCard = (s: Session, d: GateDetail, lines: string[] = []) => {
    let m = withDetail(
      { ...model([s]), focus: "card" as const },
      detailKey(s, s.decisions?.[0]),
      d,
    );
    if (lines.length === 0) return m;
    m = withWorkers(
      m,
      statuses([
        "r_1",
        worker("r_1", { state: "exited", label: "exited (0)", since: NOW - 20_000 }),
      ]),
      false,
    );
    return withProgress(m, "r_1", { lines });
  };

  test("task_9pns_gate_report_reads_answer_then_changes_then_decision_and_no_agent_block", () => {
    const digest = [
      "init · 14 tools (kodel 11)",
      "→ pipeline_next_step",
      "← ok: node plan",
      "> The plan is in docs/plans/a.md; approve to go on.",
    ];
    const m = withCard(gate(), detail(), digest);
    const out = show(m);
    const joined = out.join("\n");
    const at = (text: string) => out.findIndex((l) => l.includes(text));
    expect(at("THE AGENT'S ANSWER · its last words · kodel agent logs kw-r_1")).toBeGreaterThan(-1);
    expect(joined).toContain("The plan is in docs/plans/a.md; approve to go on.");
    expect(at("CHANGED FILES · 2 files · 127 lines")).toBeGreaterThan(at("THE AGENT'S ANSWER"));
    expect(joined).toMatch(/docs\/plans\/a\.md\s+120/);
    expect(joined).toMatch(/packages\/cli\/src\/x\.ts\s+7/);
    expect(at("YOUR DECISION")).toBeGreaterThan(at("CHANGED FILES"));
    expect(at("❯ Read the plan. Approve to go on")).toBeGreaterThan(at("YOUR DECISION"));
    expect(at("a Approve · r Reject")).toBeGreaterThan(at("❯"));
    // The state line stays; the log of tool calls is not on this card: it is under Log.
    expect(joined).toContain("agent waiting for you");
    expect(joined).not.toContain("AGENT · kw-r_1");
    expect(joined).not.toContain("→ pipeline_next_step");
    expect(joined).not.toContain("$ kodel agent logs");
    // The answer the agent's own log gives wins over the digest.
    const logged = withCard(
      gate(),
      detail({ report: { text: "All done, see the plan.", ts: NOW - 60_000, from: "log" } }),
      digest,
    );
    const said = show(logged).join("\n");
    expect(said).toContain("THE AGENT'S ANSWER · written 1m ago");
    expect(said).toContain("All done, see the plan.");
    expect(said).not.toContain("its last words");
  });

  test("task_9pns_gate_with_no_agent_answer_shows_no_empty_heading", () => {
    const m = withCard(gate(), detail(), ["init · 14 tools (kodel 11)", "→ pipeline_next_step"]);
    const out = show(m);
    const joined = out.join("\n");
    expect(joined).not.toContain("THE AGENT'S ANSWER");
    expect(joined).not.toContain("Not found");
    const tabs = out.findIndex((l) => l.includes("Report") && l.includes("Comments"));
    expect(out[tabs + 2]).toContain("agent waiting for you");
    expect(out[tabs + 4]).toContain("CHANGED FILES · 2 files · 127 lines");
    expect(joined).toContain("YOUR DECISION");
    // No worker at all: the tab opens on what changed.
    const bare = show(withCard(gate(), detail()));
    const strip = bare.findIndex((l) => l.includes("Report") && l.includes("Comments"));
    expect(bare[strip + 2]).toContain("CHANGED FILES");
    // No files, no repository, unknown: each says so in words.
    expect(show(withCard(gate(), detail({ changes: { kind: "none" } }))).join("\n")).toContain(
      "No files changed.",
    );
    expect(
      show(
        withCard(gate(), detail({ changes: { kind: "unavailable", reason: "git is gone" } })),
      ).join("\n"),
    ).toContain("Cannot tell what changed: git is gone");
    // Many files: the first twelve, and where the rest are.
    const many = detail({
      changes: {
        kind: "files",
        files: Array.from({ length: 15 }, (_, i): [string, number] => [`f${i}.ts`, i + 1]),
        totalFiles: 15,
        totalLines: 120,
      },
    });
    const long = show(withCard(gate(), many)).join("\n");
    expect(long).toContain("f11.ts");
    expect(long).not.toContain("f12.ts");
    expect(long).toContain("… 3 more under Code");
    // A gate decided with a command only (no decisions on the session) says so instead of the keys.
    const commandOnly = show(
      withCard(gate({ decisions: undefined, command: "kodel gate approve r_1" }), detail()),
    ).join("\n");
    expect(commandOnly).toContain(
      "Decided with a command, not from here: $ kodel gate approve r_1",
    );
    expect(commandOnly).not.toContain("a Approve · r Reject");
  });

  test("task_9pns_running_run_shows_the_log_block_identical_to_the_log_tab", () => {
    const running = session("r_1", "running");
    const log: LogEntry[] = [
      entry(5, { kind: "text", text: "Reading the plan." }),
      entry(4, {
        kind: "call",
        tool: "Bash",
        text: "bun test packages/cli",
        result: { ok: true, ms: 1200, size: 300, text: "12 pass" },
      }),
      entry(3, { kind: "call", tool: "Edit", text: "packages/cli/src/x.ts" }),
      entry(2, { kind: "text", text: "Done with the step." }),
    ];
    const d = detail({
      kind: "running",
      prompt: "",
      agentLog: log,
      journal: ["10:00 node_entered impl"],
    });
    const base = withDetail({ ...model([running]), focus: "card" as const }, detailKey(running), d);
    const m = withProgress(withWorkers(base, statuses(["r_1", worker("r_1")]), false), "r_1", {
      lines: ["init · 14 tools (kodel 11)", "→ Bash: bun test packages/cli"],
    });
    // The block above the tabs: the agent's name, the tail of the log, the command for the whole of it.
    const steps = show(m);
    const head = steps.findIndex((l) => l.includes("AGENT · kw-r_1"));
    const foot = steps.findIndex((l) => l.includes("$ kodel agent logs kw-r_1"));
    expect(head).toBeGreaterThan(-1);
    expect(foot).toBeGreaterThan(head);
    const block = steps.slice(head + 1, foot).map((l) => l.trimEnd());
    expect(block.length).toBe(5);
    expect(block.length).toBeLessThanOrEqual(DIGEST_LINES);
    expect(block.join("\n")).toContain("Reading the plan.");
    expect(block.join("\n")).toContain("⚙ Bash  bun test packages/cli");
    expect(block.join("\n")).toContain("↳ ok 1.2s · 300 B  12 pass");
    // Not the digest: the one rendering is the Log tab's.
    expect(block.join("\n")).not.toContain("init · 14 tools");
    // The Log tab holds every line of the block, in the same order, drawn the same.
    const onLog = press(m, "right", "right");
    expect(onLog.tab).toBe(LOG);
    const logLines = show(onLog).map((l) => l.trimEnd());
    const found = block.map((l) => logLines.indexOf(l));
    expect(found.every((i) => i >= 0)).toBe(true);
    expect(found).toEqual([...found].sort((a, b) => a - b));
    // On the Log tab itself the block is not drawn a second time; the state line stays.
    expect(logLines.join("\n")).not.toContain("AGENT · kw-r_1");
    expect(logLines.join("\n")).toContain("agent running");
    // Without the agent's own log, both show the digest of the stream, the same way.
    const noLog = withDetail(
      m,
      detailKey(running),
      detail({ kind: "running", prompt: "", journal: [] }),
    );
    const digestBlock = show(noLog);
    const h2 = digestBlock.findIndex((l) => l.includes("AGENT · kw-r_1"));
    const f2 = digestBlock.findIndex((l) => l.includes("$ kodel agent logs kw-r_1"));
    const lines2 = digestBlock.slice(h2 + 1, f2).map((l) => l.trimEnd());
    expect(lines2.join("\n")).toContain("→ Bash: bun test packages/cli");
    const logTab2 = show(press(noLog, "right", "right")).map((l) => l.trimEnd());
    expect(logTab2.join("\n")).toContain(
      "From the background agent's stream · kodel agent logs kw-r_1",
    );
    expect(lines2.every((l) => logTab2.includes(l))).toBe(true);
    // A run that waits shows no such block, even with the same worker.
    const waiting = withCard(gate(), detail(), ["→ pipeline_next_step"]);
    expect(show(waiting).join("\n")).not.toContain("AGENT · kw-r_1");
  });
});
