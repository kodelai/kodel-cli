/** The Tasks screen and the Backlog block as lines of text, and the state they keep. Pure: nothing here reads or writes a task. */
import { bold, cyan, dim, fit, green, inverse, red, stripAnsi, wrapText, yellow } from "./ansi";
import type { Session } from "./session";
import { prose } from "./tabs";
import {
  BACKLOG_COUNT,
  type CardSlot,
  SCREEN_LIMIT,
  type TaskCardData,
  type TaskRow,
  type TasksLoad,
} from "./tasks-load";

/** A row of the Sessions list: a run, or a task of the Backlog. */
export type RowId = { kind: "run"; id: string } | { kind: "task"; key: string };

/** What the Sessions selection is on. The run itself is `Model.selected`; a task is never an id of a run. */
export type Picked = { kind: "run" } | { kind: "task"; key: string };

export const TASKS_OFF =
  "Tasks are off: set tasks.enabled in the project config, then start kodel tui again.";

export interface TasksState {
  /** Nothing until the first read answers. */
  load: TasksLoad | undefined;
  /** The latest read failed while an older list is still shown. */
  error: string | undefined;
  /** The key selected on the Tasks screen. */
  selected: string;
  /** Set by a jump from the Backlog: the task may be outside the page that was read, and stays selected. */
  pinned: boolean;
  /** How many lines of the card on the Tasks screen are scrolled off the top. */
  scroll: number;
  /** The cards read so far; the selected one is read again with every list. */
  cards: Record<string, CardSlot>;
  /**
   * The tasks opened from a card (a subtask, a parent), newest last, on top of the task the list is on. Esc takes the
   * last one off. It belongs to the card on the screen and is emptied when the person goes anywhere else.
   */
  drill: string[];
  /** The line of the card's items (the parent, the subtasks, the runs) the cursor is on. */
  item: number;
}

export function initialTasks(): TasksState {
  return {
    load: undefined,
    error: undefined,
    selected: "",
    pinned: false,
    scroll: 0,
    cards: {},
    drill: [],
    item: 0,
  };
}

const GROUPS = [
  { title: "TODO", state: "todo" },
  { title: "IN PROGRESS", state: "progress" },
  { title: "DONE", state: "done" },
] as const;

/** The rows as the Tasks screen lists them: by group, the adapter's order inside each. */
export function orderedRows(rows: TaskRow[]): TaskRow[] {
  return GROUPS.flatMap((g) => rows.filter((r) => r.state === g.state));
}

/** A new answer of the reader. A failed read leaves the list that was shown, with the failure told next to it. */
export function withTasksLoad(s: TasksState, load: TasksLoad): TasksState {
  if (load.status === "error" && s.load?.status === "ready") return { ...s, error: load.message };
  if (load.status !== "ready") return { ...s, load, error: undefined };
  const rows = orderedRows(load.rows);
  const keeps = s.selected !== "" && (s.pinned || rows.some((r) => r.key === s.selected));
  const selected = keeps ? s.selected : (rows[0]?.key ?? "");
  // What was opened from the old card goes with it: a card never shows what the person did not pick.
  const drill = selected === s.selected ? s.drill : [];
  const item = selected === s.selected ? s.item : 0;
  const scroll = selected === s.selected ? s.scroll : 0;
  return { ...s, load, error: undefined, selected, drill, item, scroll };
}

export function withTaskCard(s: TasksState, key: string, slot: CardSlot): TasksState {
  return { ...s, cards: { ...s.cards, [key]: slot } };
}

/** Runs that hold a task: one that is going or waits. A finished or unreadable run holds nothing. */
function activeKeys(sessions: Session[]): Set<string> {
  const keys = new Set<string>();
  for (const s of sessions) {
    if (s.taskKey !== undefined && (s.status === "running" || s.status === "waiting")) {
      keys.add(s.taskKey);
    }
  }
  return keys;
}

export interface Backlog {
  rows: TaskRow[];
  /** Unstarted tasks without an active run; more than `rows` when the block is cut. */
  total: number;
  /** More unstarted tasks exist than were read. */
  cut: boolean;
}

/**
 * The first tasks that are not started and have no active run. Worked out from the sessions as they are
 * now, so a run starting hides its task at the next refresh of the runs, not at the next read of the tasks.
 */
export function backlogOf(
  s: TasksState,
  sessions: Session[],
  count: number = BACKLOG_COUNT,
): Backlog | undefined {
  if (s.load?.status !== "ready") return undefined;
  const active = activeKeys(sessions);
  const eligible = s.load.todo.filter((r) => r.state === "todo" && !active.has(r.key));
  return { rows: eligible.slice(0, count), total: eligible.length, cut: s.load.todoCut };
}

// ── colours ─────────────────────────────────────────────────────────────────

/** A state in the colour its group has in Sessions: waiting for work, going, finished. A declined task is dimmed. */
function stateStyle(state: TaskRow["state"], status: string, text: string): string {
  if (status === "declined") return dim(text);
  if (state === "progress") return cyan(text);
  if (state === "done") return green(text);
  return yellow(text);
}

/** The adapter's own priority names are shown as given; the ones every adapter has get a colour. */
function priorityStyle(priority: string | undefined, text: string): string {
  const name = (priority ?? "").toLowerCase();
  if (name === "high") return red(text);
  if (name === "low") return dim(text);
  return text;
}

const RUN_STYLE: Record<Session["status"], (text: string) => string> = {
  waiting: yellow,
  running: cyan,
  failed: red,
  done: green,
  canceled: dim,
  unreadable: red,
};

// ── rows ────────────────────────────────────────────────────────────────────

const KEY_WIDTH = 10;
const PRIORITY_WIDTH = 6;
const STATUS_WIDTH = 11;

/** Key, title and priority; the rest is in the card. A child of a task on the list has `└` before its key. */
function rowText(row: TaskRow, width: number, child: boolean): string {
  const lead = child ? dim("└ ") : "";
  const titleWidth = Math.max(4, width - 1 - (child ? 2 : 0) - KEY_WIDTH - 1 - PRIORITY_WIDTH - 1);
  return ` ${lead}${dim(fit(row.key, KEY_WIDTH))} ${fit(row.title, titleWidth)} ${priorityStyle(row.priority, fit(row.priority ?? "", PRIORITY_WIDTH))}`;
}

function styledRow(
  row: TaskRow,
  width: number,
  child: boolean,
  selected: boolean,
  listFocus: boolean,
): string {
  const text = rowText(row, width, child);
  if (!selected) return fit(text, width);
  const plainRow = fit(stripAnsi(text), width);
  // With the card in focus the list keeps its place but stops shouting.
  return listFocus ? inverse(plainRow) : bold(`›${plainRow.slice(1)}`);
}

// ── the Backlog block ───────────────────────────────────────────────────────

export interface Block {
  lines: string[];
  /** The row each line shows, or nothing for a heading, a message or a gap. */
  ids: (RowId | undefined)[];
}

/** The block under the runs of Sessions: the tasks, or one line saying why there are none. */
export function backlogBlock(
  s: TasksState,
  sessions: Session[],
  selectedKey: string | undefined,
  listFocus: boolean,
  width: number,
): Block {
  const lines: string[] = [];
  const ids: (RowId | undefined)[] = [];
  const say = (line: string) => {
    lines.push(fit(line, width));
    ids.push(undefined);
  };
  const message = (text: string, style: (t: string) => string) => {
    say(dim("BACKLOG"));
    for (const l of wrapText(text, Math.max(10, width - 2))) say(style(`  ${l}`));
    say("");
  };
  const load = s.load;
  if (load === undefined) {
    message("reading tasks…", dim);
    return { lines, ids };
  }
  if (load.status === "off") {
    message(TASKS_OFF, dim);
    return { lines, ids };
  }
  if (load.status === "error") {
    message(`Cannot read the tasks: ${load.message}`, red);
    return { lines, ids };
  }
  const backlog = backlogOf(s, sessions);
  if (backlog === undefined || (backlog.rows.length === 0 && s.error === undefined)) {
    return { lines, ids };
  }
  say(
    `${bold(yellow("BACKLOG"))}${dim(` · ${backlog.rows.length} of ${backlog.total}${backlog.cut ? "+" : ""}`)}`,
  );
  for (const row of backlog.rows) {
    lines.push(styledRow(row, width, false, row.key === selectedKey, listFocus));
    ids.push({ kind: "task", key: row.key });
  }
  if (s.error !== undefined) say(red(`  Cannot read the tasks now: ${s.error}`));
  say("");
  return { lines, ids };
}

// ── the Tasks screen ────────────────────────────────────────────────────────

/** One line saying why the screen has no list, or nothing when it has one. */
export function tasksNotice(s: TasksState): string[] | undefined {
  const load = s.load;
  if (load === undefined) return [dim("  reading tasks…")];
  if (load.status === "off") return wrapText(TASKS_OFF, 70).map((l) => dim(`  ${l}`));
  if (load.status === "error") {
    return wrapText(`Cannot read the tasks: ${load.message}`, 70).map((l) => red(`  ${l}`));
  }
  return undefined;
}

/** The list of the Tasks screen: a summary, the groups, and the part that fits kept around the selected row. */
export function taskListLines(
  s: TasksState,
  width: number,
  height: number,
  listFocus: boolean,
): string[] {
  const load = s.load;
  if (load?.status !== "ready") return [];
  const head: string[] = [];
  const shown = `${load.rows.length} task${load.rows.length === 1 ? "" : "s"}${load.more ? ` · first ${SCREEN_LIMIT} shown` : ""}`;
  head.push(dim(fit(shown, width)));
  if (load.problems > 0) {
    head.push(
      dim(
        fit(
          `${load.problems} task file${load.problems === 1 ? "" : "s"} could not be read (kodel task doctor)`,
          width,
        ),
      ),
    );
  }
  if (s.error !== undefined) head.push(red(fit(`Cannot read the tasks now: ${s.error}`, width)));
  if (load.rows.length === 0) return [...head, "", dim("No tasks.")];
  const keys = new Set(load.rows.map((r) => r.key));
  const lines: string[] = [];
  let selectedAt = 0;
  for (const g of GROUPS) {
    const members = load.rows.filter((r) => r.state === g.state);
    if (members.length === 0) continue;
    lines.push(`${bold(stateStyle(g.state, g.state, g.title))}${dim(` · ${members.length}`)}`);
    for (const row of members) {
      const child = row.parent !== undefined && keys.has(row.parent);
      if (row.key === s.selected) selectedAt = lines.length;
      lines.push(styledRow(row, width, child, row.key === s.selected, listFocus));
    }
    lines.push("");
  }
  const room = Math.max(1, height - head.length);
  const start =
    lines.length <= room
      ? 0
      : Math.min(Math.max(0, selectedAt - Math.floor(room / 2)), lines.length - room);
  return [...head, ...lines.slice(start, start + room)];
}

// ── the card ────────────────────────────────────────────────────────────────

const RUN_WORD: Record<Session["status"], string> = {
  waiting: "waiting for you",
  running: "running",
  failed: "failed",
  done: "done",
  canceled: "canceled",
  unreadable: "unreadable",
};

/** What the cursor of a card can be on, in the order the card shows them. */
export type CardItem =
  | { kind: "parent"; key: string }
  | { kind: "subtask"; key: string }
  | { kind: "run"; id: string };

/** The parent, the subtasks, then the runs that are in Sessions (a run that is not there cannot be jumped to). */
export function cardItems(slot: CardSlot | undefined, sessions: Session[]): CardItem[] {
  if (slot?.status !== "ready") return [];
  const c = slot.card;
  return [
    ...(c.parent === undefined ? [] : [{ kind: "parent" as const, key: c.parent }]),
    ...c.subtasks.map((k) => ({ kind: "subtask" as const, key: k.key })),
    ...c.runs
      .filter((id) => sessions.some((s) => s.id === id))
      .map((id) => ({ kind: "run" as const, id })),
  ];
}

export interface CardView {
  lines: string[];
  /** The line of the item the cursor is on, so the view can keep it in sight. */
  anchor?: number;
  items: CardItem[];
}

export interface CardInput {
  slot: CardSlot | undefined;
  /** What the list knows of the task while its card is read. */
  row: TaskRow | undefined;
  key: string;
  sessions: Session[];
  /** Every row that was read, for the priority and status of a subtask. */
  rows: TaskRow[];
  width: number;
  cursor: number;
  /** The card has the keys: the item the cursor is on then stands out more. */
  focused: boolean;
}

function headLines(
  c: Pick<TaskCardData, "key" | "title" | "state" | "status" | "priority">,
  width: number,
): string[] {
  const out = wrapText(c.title, Math.max(10, width - 2)).map((l) => bold(l));
  const status = c.status === c.state ? c.status : `${c.status} (${c.state})`;
  out.push(
    fit(
      `${dim(c.key)} · ${stateStyle(c.state, c.status, status)} · priority ${priorityStyle(c.priority, c.priority ?? "—")}`,
      width,
    ),
  );
  return out;
}

/** The card of a task: what is known of it from the list while the task is read, then everything. */
export function taskCardView(a: CardInput): CardView {
  const { slot, row, key, width } = a;
  const items = cardItems(slot, a.sessions);
  const at = Math.min(Math.max(0, a.cursor), items.length - 1);
  const head = slot?.status === "ready" ? slot.card : row;
  const top = head ? headLines(head, width) : [bold(fit(key, width))];
  if (slot === undefined || slot.status === "loading") {
    if (row?.parent !== undefined) top.push(dim(fit(`parent: ${row.parent}`, width)));
    return { lines: [...top, "", dim("Reading the task…")], items };
  }
  if (slot.status === "failed") {
    return {
      lines: [...top, "", ...wrapText(`Cannot read this task: ${slot.message}`, width).map(red)],
      items,
    };
  }
  const { card } = slot;
  const out = [...top];
  let anchor: number | undefined;
  let n = 0;
  /** The two columns in front of an item: the cursor on the item it is on. */
  const mark = (): string => {
    const here = n === at;
    if (here) anchor = out.length;
    n += 1;
    if (!here) return "  ";
    return a.focused ? bold(cyan("› ")) : dim("› ");
  };
  if (card.parent !== undefined) out.push(`${mark()}parent: ${cyan(card.parent)}`);
  out.push("");
  if (card.body !== undefined) out.push(...prose(card.body, width), "");
  if (card.subtasks.length > 0) {
    const known = card.subtasks.map((k) => a.rows.find((r) => r.key === k.key));
    const done = known.filter((r) => r?.state === "done").length;
    const counter = known.every((r) => r !== undefined)
      ? ` · ${done}/${card.subtasks.length} done`
      : "";
    out.push(dim(`SUBTASKS${counter}`));
    for (const [i, k] of card.subtasks.entries()) {
      const info = known[i];
      const priority = info
        ? priorityStyle(info.priority, fit(info.priority ?? "", PRIORITY_WIDTH))
        : " ".repeat(PRIORITY_WIDTH);
      const status = info
        ? stateStyle(info.state, info.status, fit(info.status, STATUS_WIDTH))
        : " ".repeat(STATUS_WIDTH);
      out.push(
        fit(`${mark()}${dim(fit(k.key, KEY_WIDTH))} ${priority} ${status} ${k.title}`, width),
      );
    }
    out.push("");
  }
  if (card.runs.length > 0) {
    out.push(dim("RUNS"));
    for (const id of card.runs) {
      const known = a.sessions.find((s) => s.id === id);
      if (!known) {
        out.push(fit(`  ${dim(id)}`, width));
        continue;
      }
      out.push(
        fit(
          `${mark()}${id} · ${RUN_STYLE[known.status](RUN_WORD[known.status])}  ${dim(known.title)}`,
          width,
        ),
      );
    }
    out.push("");
  }
  out.push(dim("COMMENTS"));
  if (card.comments.length === 0) out.push(dim("  No comments."));
  for (const c of card.comments) {
    out.push(
      dim(
        fit(
          `${c.at.slice(0, 16).replace("T", " ")}${c.by === undefined ? "" : ` · ${c.by}`}`,
          width,
        ),
      ),
    );
    out.push(...prose(c.text, width));
  }
  return {
    lines: out.map((l) => fit(l, width)),
    ...(anchor === undefined ? {} : { anchor }),
    items,
  };
}

/** The part of the card that fits, with a mark where more is above or below. */
export function scrolled(lines: string[], scroll: number, height: number, width: number): string[] {
  const start = Math.min(Math.max(0, scroll), Math.max(0, lines.length - height));
  const shown = lines.slice(start, start + height);
  if (start > 0 && shown.length > 0) shown[0] = dim(fit("▲ PgUp for earlier", width));
  if (start + height < lines.length && shown.length > 0) {
    shown[shown.length - 1] = dim(fit("▼ PgDn for more", width));
  }
  return shown;
}

/**
 * The scroll that keeps the line `anchor` in sight, nearest to `scroll`. The first and last line of a window
 * that is cut are taken by the marks of `scrolled`, so the line must lie between them.
 */
export function scrollTo(scroll: number, anchor: number, room: number, total: number): number {
  const max = Math.max(0, total - room);
  let start = Math.min(Math.max(0, scroll), max);
  if (anchor < start + 1 && start > 0) start = Math.max(0, anchor - 1);
  if (anchor > start + room - 2 && start < max) start = Math.min(max, anchor - room + 2);
  return start;
}
