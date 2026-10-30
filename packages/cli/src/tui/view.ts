/** The screens as pure functions: a model and a size in, lines out; a key and a model in, a model out. */
import {
  bold,
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
import { firstCode, moveCode, moveHunk, type Prepared, placeOf, prepare } from "./diffview";
import type { InputEvent } from "./input";
import type { Loaded } from "./load";
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
  type Comment,
  type DiffState,
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
  startCursor,
  type TabState,
  tabContent,
  tabStrip,
  visibleTabs,
} from "./tabs";

export const SECTIONS = ["Sessions", "Pipeline", "Tasks", "Report"] as const;

export interface Model {
  section: number;
  sessions: Session[];
  /** Pipelines the agent proposed outside a run; they wait on the Pipeline screen. */
  proposals: number;
  /** What the Pipeline screen shows, and where it is. */
  pipelines: PipeEntry[];
  pipe: PipeState;
  /** The Report screen: where it is, and what has been read for it, by pipeline. */
  rep: RepState;
  stats: Record<string, StatsSlot>;
  /** Id of the selected session, so the selection follows it when the list reorders. */
  selected: string;
  /** On a narrow terminal the list and the card take turns. */
  focus: "list" | "card";
  confirm: "a" | "r" | "d" | null;
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
  /** The diffs read so far, by `diffKey`. */
  diffs: Record<string, DiffState>;
  /** Things the screen cannot do by itself (write a comment, read a diff); the loop does them. */
  effects: Effect[];
}

export interface Input {
  text: string;
  severity: string;
  /** The file or the step the comment is about. */
  place: string;
}

export type Effect =
  | { type: "add_comment"; runId: string; node: string; attempt: number; comment: Comment }
  | { type: "delete_comment"; runId: string; node: string; attempt: number; index: number }
  | { type: "load_diff"; runId: string; path: string }
  | { type: "load_stats"; pipeline: string };

/** A run's gate detail is good for the wait it was read for: a new wait is a new key. */
export function detailKey(s: Session): string {
  return `${s.id}:${s.since}`;
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
    stats: {},
    selected: ordered(loaded.sessions)[0]?.id ?? "",
    focus: "list",
    confirm: null,
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
    diffs: {},
    effects: [],
  };
}

export function withDetail(m: Model, key: string, detail: GateDetail): Model {
  return { ...m, details: { ...m.details, [key]: detail } };
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
  return {
    ...m,
    sessions,
    proposals: loaded.proposals,
    pipelines,
    pipe: withEntries(m.pipe, pipelines),
    rep: withNames(m.rep, repNames(pipelines)),
    selected,
    confirm,
    now,
  };
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

function selectedSession(m: Model): Session | undefined {
  return m.sessions.find((s) => s.id === m.selected) ?? m.sessions[0];
}

/** What has been read for the Report screen: a pipeline is read when it is first looked at. */
export function withStats(m: Model, pipeline: string, slot: StatsSlot): Model {
  return { ...m, stats: { ...m.stats, [pipeline]: slot } };
}

/** On the Report screen a pipeline that has not been read is asked for, once. */
function wanting(m: Model): Model {
  const name = m.rep.selected;
  if (m.section !== 3 || name === "" || m.stats[name]) return m;
  return {
    ...withStats(m, name, { status: "loading" }),
    effects: [...m.effects, { type: "load_stats", pipeline: name }],
  };
}

export function update(input: Model, key: string, size: Size = DEFAULT_SIZE): Model {
  return wanting(updateKey(input, key, size));
}

function updateKey(input: Model, key: string, size: Size): Model {
  const m = normalized(input);
  if (key === "ctrl-c") return { ...m, quit: true };
  if (m.input) return typing(m, key);
  const current = selectedSession(m);
  if (m.confirm !== null && current) {
    if (key === "y") return decide(m, current, m.confirm);
    return { ...m, confirm: null, notice: "Cancelled." };
  }
  if (m.section === 1 && !SHARED_KEYS.has(key)) return pipesUpdate(m, key, size);
  if (m.section === 3 && !SHARED_KEYS.has(key)) return reportUpdate(m, key, size);
  if (m.focus === "card" && m.section === 0) {
    const moved = cardKey(m, key, size);
    if (moved) return moved;
  }
  switch (key) {
    case "q":
      return { ...m, quit: true };
    case "tab":
      return { ...m, section: (m.section + 1) % SECTIONS.length, notice: "" };
    case "1":
    case "2":
    case "3":
    case "4":
      return { ...m, section: Number(key) - 1, notice: "" };
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
      if (m.section !== 0 || m.sessions.length === 0) return m;
      return { ...m, zoom: !m.zoom, focus: m.zoom ? m.focus : "card" };
    case "m":
      return {
        ...m,
        mouse: !m.mouse,
        notice: m.mouse ? "Mouse off." : "Mouse on. Hold Shift (Option in iTerm2) to select text.",
      };
    case "enter":
    case "right":
      return m.section === 0 && m.sessions.length > 0 ? { ...m, focus: "card" } : m;
    case "escape":
    case "left":
      return { ...m, focus: "list", zoom: false };
    case "a":
    case "r": {
      if (current?.need === undefined || NEED_KEYS[current.need][key] === undefined) return m;
      if (m.source === "project") {
        return {
          ...m,
          notice: `Deciding from here comes later. In a terminal: ${current.command ?? "see the card"}`,
        };
      }
      return { ...m, confirm: key, notice: "" };
    }
    default:
      return m;
  }
}

/** The keys every screen reads the same way. */
const SHARED_KEYS = new Set(["q", "tab", "1", "2", "3", "4", "m", "z"]);

/** A key on the Report screen. */
function reportUpdate(m: Model, key: string, size: Size): Model {
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

/** A comment is being typed: every key is the comment's, except the few that end it. */
function typing(m: Model, key: string): Model {
  const input = m.input;
  if (!input) return m;
  switch (key) {
    case "escape":
      return { ...m, input: null, notice: "Cancelled." };
    case "enter": {
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
  if (!found) return up || down ? scrollCard(m, size, up ? -1 : 1) : undefined;
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
        : toTab(m, around(found.d, m.tab, 1, true));
    case "shift-tab":
      return inStep
        ? toSub(m, (m.sub + SUBTABS.length - 1) % SUBTABS.length)
        : toTab(m, around(found.d, m.tab, -1, true));
    case "right":
      return inStep
        ? toSub(m, Math.min(SUBTABS.length - 1, m.sub + 1))
        : toTab(m, around(found.d, m.tab, 1, false));
    case "left":
      if (inStep) return toSub(m, Math.max(0, m.sub - 1));
      // Left of the first tab is the list.
      // Left of the first tab is the list.
      return around(found.d, m.tab, -1, false) !== m.tab
        ? toTab(m, around(found.d, m.tab, -1, false))
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
      return { ...m, input: { text: "", severity: "major", place }, notice: "" };
    }
    case "d":
      return m.tab === COMMENTS && onList && found.d.comments.length > 0
        ? { ...m, confirm: "d", notice: "" }
        : undefined;
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
  const path = fileAt(found.d, m.cursor);
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
        ? { ...m, input: { text: "", severity: "major", place: placeOf(path, row) }, notice: "" }
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
  const d = s ? m.details[detailKey(s)] : undefined;
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
function around(d: GateDetail, tab: number, by: 1 | -1, wrap: boolean): number {
  const tabs = visibleTabs(d);
  const next = tabs.indexOf(tab) + by;
  if (wrap) return tabs[(next + tabs.length) % tabs.length] ?? tab;
  return tabs[Math.min(tabs.length - 1, Math.max(0, next))] ?? tab;
}

function moveSelection(m: Model, by: -1 | 1): Model {
  const at = Math.max(
    0,
    m.sessions.findIndex((s) => s.id === selectedSession(m)?.id),
  );
  const next = m.sessions[Math.min(m.sessions.length - 1, Math.max(0, at + by))];
  return {
    ...m,
    selected: next?.id ?? m.selected,
    notice: "",
    cardScroll: 0,
    tab: 0,
    cursor: 0,
    open: false,
    sub: 0,
  };
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
  spans?: [number, number][];
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
  const s = selectedSession(m);
  if (!s) return { head: [], body: [dim("No session selected.")] };
  const found = detailOf(m);
  if (!found) return { head: [], body: cardLines(s, m, width) };
  const focused = m.focus === "card";
  const tabs = tabStrip(found.d, m.tab, width, focused);
  const content = tabContent(found.d, tabState(m, found.d), {
    now: m.now,
    width,
    focused,
    diffs: m.diffs,
    runId: s.id,
    instructions: m.instructions,
  });
  const band = headerBand(s, found.d, width, glyph(s, m.frame), m.now, height < 22);
  return {
    head: [...band, tabs.line, dim("─".repeat(width))],
    body: content.lines,
    ...(content.anchor === undefined ? {} : { anchor: content.anchor }),
    spans: tabs.spans,
  };
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

function tagOf(s: Session): string {
  return s.status === "waiting" && s.need ? NEED_TAG[s.need] : s.step;
}

function timeOf(s: Session, now: number, ago: boolean): string {
  const age = formatAge(now - s.since);
  return ago ? `${age} ago` : age;
}

interface ListLines {
  lines: string[];
  /** The session each line shows, or nothing for a group heading or a gap. */
  ids: (string | undefined)[];
  selectedAt: number;
}

function listLines(m: Model, width: number): ListLines {
  const lines: string[] = [];
  const ids: (string | undefined)[] = [];
  let selectedAt = 0;
  const tagWidth = Math.min(13, Math.max(7, ...m.sessions.map((s) => tagOf(s).length)));
  const titleWidth = Math.max(8, width - tagWidth - 13);
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
      const tag = fit(tagOf(s), tagWidth);
      const tagStyled =
        s.status === "waiting" ? yellow(tag) : s.activity === "quiet" ? dim(tag) : tag;
      const time = timeOf(s, m.now, g.ago).padStart(TIME_WIDTH);
      const row = `${bar}${glyph(s, m.frame)} ${fit(s.title, titleWidth)} ${tagStyled} ${time}`;
      if (s.id === m.selected) {
        selectedAt = lines.length;
        const plain = fit(stripAnsi(row), width);
        // With the card in focus the list keeps its place but stops shouting.
        lines.push(m.focus === "list" ? inverse(plain) : bold(`›${plain.slice(1)}`));
      } else {
        lines.push(fit(row, width));
      }
      ids.push(s.id);
    }
    lines.push("");
    ids.push(undefined);
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

function actionLine(s: Session, project: boolean): string {
  const keys = s.need ? NEED_KEYS[s.need] : {};
  const parts = [
    ...(keys.a ? [`${bold("a")} ${keys.a}`] : []),
    ...(keys.r ? [`${bold("r")} ${keys.r}`] : []),
  ];
  if (parts.length === 0) return "";
  return `${parts.join("   ")}${project ? dim("   (shows the command for now)") : ""}`;
}

/** Every line of the card; the screen shows the part from `cardScroll` on. */
function cardLines(s: Session | undefined, m: Model, width: number): string[] {
  if (!s) return [dim("No session selected.")];
  const out: string[] = [];
  out.push(`${glyph(s, m.frame)} ${bold(s.title)}`);
  out.push(dim(`${s.id} · ${s.pipeline}`));
  if (s.workdir) out.push(dim(s.workdir));
  out.push("");
  const inner = Math.max(10, width - 4);
  if (s.status === "waiting" && s.need) {
    out.push(yellow(`┌ ${NEED_TAG[s.need]} · waiting ${formatAge(m.now - s.since)}`));
    out.push(`${yellow("│")} ${bold(s.headline ?? "")}`);
    for (const line of wrapText(s.prompt ?? "", inner)) out.push(`${yellow("│")} ${line}`);
    out.push(`${yellow("│")} ${green("Ready to decide")}`);
    if (s.after) out.push(`${yellow("│")} ${dim(`After that: ${s.after}`)}`);
    if (s.command) out.push(`${yellow("│")} ${dim(`$ ${s.command}`)}`);
    out.push(`${yellow("└")} ${actionLine(s, m.source === "project")}`);
    if (s.need === "approve") out.push(dim("Reading the details…"));
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
  } else if (s.activity === "quiet") {
    out.push(
      dim(`Nothing heard for ${formatAge(s.quietMs ?? 0)}. The agent may be stuck or gone.`),
    );
    out.push("");
  }
  if (s.status === "running") out.push(dim("Reading the details…"), "");
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

function hints(m: Model): string {
  if (m.section === 1) return pipeHints(entryOf(m.pipelines, m.pipe), m.pipe, m.focus === "card");
  if (m.section === 3) return repHints(m.rep, m.focus === "card");
  const current = selectedSession(m);
  if (m.confirm === "d")
    return `${bold("Delete this comment?")}  ${bold("y")} yes   ${bold("n")} no`;
  if (m.confirm !== null) {
    const label = current?.need ? (NEED_KEYS[current.need][m.confirm] ?? "") : "";
    return `${bold(label)} «${current?.title ?? ""}»?  ${bold("y")} yes   ${bold("n")} no`;
  }
  const keys = current?.need ? NEED_KEYS[current.need] : {};
  const decide = `${keys.a ? `   ${bold("a")} ${keys.a}` : ""}${keys.r ? `   ${bold("r")} ${keys.r}` : ""}`;
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
  const open = `   ${bold("Enter")} details`;
  const proposals =
    m.proposals > 0
      ? dim(`   ${m.proposals} pipeline proposal${m.proposals === 1 ? "" : "s"} wait on 2`)
      : "";
  const mouse = `   ${bold("m")} mouse ${m.mouse ? green("on") : dim("off")}`;
  return `${bold("↑↓")} select${open}${decide}   ${bold("Tab")} menu${mouse}   ${bold("q")} quit${proposals}`;
}

/** The line at the bottom while a comment is being typed. */
function inputLine(input: Input): string {
  const place = input.place.length > 28 ? `…${input.place.slice(-27)}` : input.place;
  return `${bold("Comment")} on ${cyan(place)} [${yellow(input.severity)}]: ${input.text}${inverse(" ")}   ${dim("Enter save · Tab severity · Esc cancel")}`;
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
    body = [
      "",
      `  ${bold(SECTIONS[m.section] ?? "")}`,
      dim("  Not in this prototype yet. The layout under test is menu, session list and card."),
    ];
  } else if (m.section === 3) {
    body = reportBody(m, cols, bodyHeight);
  } else if (m.section === 1) {
    body = pipesBody(m, cols, bodyHeight);
  } else if (m.sessions.length === 0) {
    body = emptyState();
  } else {
    const layout = layoutOf(m, cols);
    const right = layout.showCard
      ? panelLines(m, panel(m, layout.cardWidth, bodyHeight), layout.cardWidth, bodyHeight)
      : [];
    const left = layout.showList ? listView(m, layout.listWidth, bodyHeight).lines : [];
    body = panes(m, layout, left, right, bodyHeight);
  }
  for (let i = 0; i < bodyHeight; i++) out.push(fit(body[i] ?? "", cols));

  const status = m.input ? inputLine(m.input) : m.notice !== "" ? green(m.notice) : hints(m);
  out.push(fit(` ${status}`, cols));
  return out;
}

export type Hit =
  | { kind: "menu"; section: number }
  | { kind: "session"; id: string }
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
  if (m.section !== 0 || m.sessions.length === 0 || row < 0 || row >= bodyHeight) return undefined;
  const layout = layoutOf(m, cols);
  if (layout.showList && x <= layout.listWidth) {
    const id = listView(m, layout.listWidth, bodyHeight).ids[row];
    return id === undefined ? undefined : { kind: "session", id };
  }
  if (!layout.showCard || x < layout.cardX) return undefined;
  const found = detailOf(m);
  if (found) {
    const head = panel(m, layout.cardWidth, bodyHeight).head;
    if (row === head.length - 2) {
      const { spans } = tabStrip(found.d, m.tab, layout.cardWidth, m.focus === "card");
      const at = x - layout.cardX;
      const index = spans.findIndex(([from, to]) => at >= from && at < to);
      const tab = visibleTabs(found.d)[index];
      if (tab !== undefined) return { kind: "tab", index: tab };
    }
  }
  return { kind: "card" };
}

/**
 * A click selects a session, a menu item or a tab, and the wheel moves the selection or scrolls;
 * nothing else. A decision is never made with the mouse: it takes a key and a confirmation.
 */
export function mouseUpdate(
  input: Model,
  size: Size,
  event: Extract<InputEvent, { type: "mouse" }>,
): Model {
  return wanting(mouseEvent(input, size, event));
}

function mouseEvent(
  input: Model,
  size: Size,
  event: Extract<InputEvent, { type: "mouse" }>,
): Model {
  const m = normalized(input);
  if (!m.mouse || m.confirm !== null) return m;
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
  if (hit.kind === "menu") return { ...m, section: hit.section, notice: "" };
  if (hit.kind === "tab") return toTab({ ...m, focus: "card" }, hit.index);
  if (hit.kind === "card") return { ...m, focus: "card" };
  if (hit.id === m.selected) {
    return { ...m, focus: size.cols < WIDE_COLS ? "card" : "list", notice: "" };
  }
  return {
    ...m,
    selected: hit.id,
    focus: "list",
    notice: "",
    cardScroll: 0,
    tab: 0,
    cursor: 0,
    open: false,
  };
}
