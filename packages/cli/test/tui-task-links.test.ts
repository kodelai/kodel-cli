/** Task links in the TUI (TASK-9RZD, T-45): the card, the rows without a link mark, and what is taken from a tracker. */
import { describe, expect, test } from "bun:test";
import { stripAnsi } from "../src/tui/ansi";
import {
  backlogBlock,
  cardItems,
  initialTasks,
  taskCardView,
  taskListLines,
  withTasksLoad,
} from "../src/tui/tasks";
import {
  type Answer,
  loadTask,
  loadTasks,
  parseRow,
  type TasksHandle,
  type TasksSource,
} from "../src/tui/tasks-load";

const WIDTH = 100;
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is what is checked
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​‮]/;

const raw = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `title of ${key}`,
  status: "todo",
  state: "todo",
  priority: "normal",
  runs: [],
  created_at: "2026-11-20T10:00:00.000Z",
  updated_at: "2026-11-20T10:00:00.000Z",
  ...extra,
});

const handleOf = (tasks: Record<string, unknown>[]): TasksHandle => {
  const source: TasksSource = {
    list: async () => {
      const answer: Answer & Record<string, unknown> = {
        ok: true,
        tasks,
        truncated: false,
        problems: [],
      };
      return answer;
    },
    get: async ({ key }) => {
      const task = tasks.find((t) => t.key === key);
      const answer: Answer & Record<string, unknown> = task
        ? { ok: true, task, subtasks: [] }
        : { ok: false, message: "no" };
      return answer;
    },
  };
  return { status: "on", source };
};

describe("t45 links in the TUI", () => {
  test("t45_tui_card_shows_links", async () => {
    const handle = handleOf([
      raw("T-A", {
        parent: "T-P",
        depends_on: ["T-B", "T-C", "T-D", "T-E"],
        dependencies: [
          { key: "T-B", state: "open" },
          { key: "T-C", state: "done", needs_approval: true },
          { key: "T-D", state: "declined" },
        ],
        blocked_by: ["T-B", "T-C", "T-E"],
        blocks: ["T-X"],
        conflicts_with: ["T-Y", "T-Z"],
      }),
    ]);
    const slot = await loadTask(handle, "T-A");
    const view = taskCardView({
      slot,
      row: undefined,
      key: "T-A",
      sessions: [],
      rows: [],
      width: WIDTH,
      cursor: 2,
      focused: true,
    });
    const text = view.lines.map((l) => stripAnsi(l).trimEnd());
    const at = (line: string) => text.indexOf(line);
    expect(at("DEPENDS ON")).toBeGreaterThan(0);
    // Each dependency with its state; one the tracker said nothing about is missing.
    expect(text.slice(at("DEPENDS ON") + 1, at("BLOCKS"))).toEqual([
      "  T-B (open)",
      "› T-C (done, waits for approval)",
      "  T-D (declined)",
      "  T-E (missing)",
    ]);
    expect(text.slice(at("BLOCKS") + 1, at("CONFLICTS WITH"))).toEqual(["  T-X"]);
    expect(text.slice(at("CONFLICTS WITH") + 1, at("CONFLICTS WITH") + 3)).toEqual([
      "  T-Y",
      "  T-Z",
    ]);
    // The cursor walks them in the order they are shown, after the parent: Enter opens the task.
    expect(cardItems(slot, [])).toEqual([
      { kind: "parent", key: "T-P" },
      ...["T-B", "T-C", "T-D", "T-E", "T-X", "T-Y", "T-Z"].map((key) => ({
        kind: "link" as const,
        key,
      })),
    ]);
    expect(view.anchor).toBe(at("› T-C (done, waits for approval)"));

    // A task without links has none of the headings.
    const plain = await loadTask(handleOf([raw("T-N")]), "T-N");
    const none = taskCardView({
      slot: plain,
      row: undefined,
      key: "T-N",
      sessions: [],
      rows: [],
      width: WIDTH,
      cursor: 0,
      focused: false,
    }).lines.map(stripAnsi);
    for (const heading of ["DEPENDS ON", "BLOCKS", "CONFLICTS WITH"]) {
      expect(none.some((l) => l.startsWith(heading))).toBe(false);
    }
  });

  test("t45_tui_backlog_rows_carry_no_blocked_mark", async () => {
    const load = await loadTasks(
      handleOf([
        raw("T-A", { blocked_by: ["T-B"] }),
        raw("T-B"),
        raw("T-C", { blocked_by: ["T-A", "T-B", "T-D"], needs_approval: true }),
      ]),
    );
    const state = withTasksLoad(initialTasks(), load);
    const backlog = backlogBlock(state, [], undefined, true, WIDTH).lines.map(stripAnsi);
    const list = taskListLines(state, WIDTH, 30, true).map(stripAnsi);
    // The person asked for the rows without the mark: the links are on the card.
    for (const lines of [backlog, list]) {
      const of = (key: string) => lines.find((l) => l.includes(key)) ?? "";
      expect(of("T-A ")).toContain("title of T-A");
      expect(of("T-C ")).toContain("[waits for approval] title of T-C");
      expect(lines.join("\n")).not.toContain("blocked");
    }
  });

  test("t45_tui_bounds_link_fields", async () => {
    const many = Array.from({ length: 500 }, (_, i) => `T-${i}`);
    const hostile = raw("T-H", {
      depends_on: ["T-OK", 7, null, "", "K".repeat(65), { key: "T-X" }, "T-\u001b[2J‮BAD"],
      dependencies: [
        { key: "T-OK", state: "later" },
        { key: 7, state: "done" },
        "nonsense",
        { key: "T-DONE", state: "done", needs_approval: "yes" },
      ],
      blocked_by: "T-OK",
      blocks: many,
      conflicts_with: { 0: "T-Y" },
    });
    const slot = await loadTask(handleOf([hostile]), "T-H");
    if (slot.status !== "ready") throw new Error("the card was not read");
    const { card } = slot;
    // What is not a short string is dropped; what could mislead a terminal is taken out.
    expect(card.dependsOn).toHaveLength(2);
    expect(card.dependsOn?.[0]).toBe("T-OK");
    expect(card.dependsOn?.[1]).not.toMatch(UNSAFE);
    // A state the TUI does not know reads as missing (it blocks); a flag that is not `true` is not set.
    expect(card.dependencies).toEqual([
      { key: "T-OK", state: "missing" },
      { key: "T-DONE", state: "done" },
    ]);
    expect(card.blockedBy).toBeUndefined();
    expect(card.conflictsWith).toBeUndefined();
    expect(card.blocks).toHaveLength(100);
    expect(parseRow(hostile)?.blockedBy).toBeUndefined();
    expect(parseRow(raw("T-R", { blocked_by: [...many, 3] }))?.blockedBy).toHaveLength(100);
    const view = taskCardView({
      slot,
      row: undefined,
      key: "T-H",
      sessions: [],
      rows: [],
      width: WIDTH,
      cursor: 0,
      focused: true,
    });
    for (const line of view.lines) expect(stripAnsi(line)).not.toMatch(UNSAFE);
  });
});
