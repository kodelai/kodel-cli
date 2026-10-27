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
import type { InputEvent } from "./input";
import type { Loaded } from "./load";
import {
  formatAge,
  type GateDetail,
  NEED_KEYS,
  NEED_TAG,
  type PathStep,
  type Session,
  type StepState,
  sortSessions,
} from "./session";

export const SECTIONS = ["Sessions", "Pipeline", "Tasks", "Report"] as const;

export interface Model {
  section: number;
  sessions: Session[];
  /** Pipelines the agent proposed outside a run; they wait on the Pipeline screen. */
  proposals: number;
  /** Id of the selected session, so the selection follows it when the list reorders. */
  selected: string;
  /** On a narrow terminal the list and the card take turns. */
  focus: "list" | "card";
  confirm: "a" | "r" | null;
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
}

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
  };
}

export function withDetail(m: Model, key: string, detail: GateDetail): Model {
  return { ...m, details: { ...m.details, [key]: detail } };
}

/** New data from disk: the selection stays on the same session when it is still there. */
export function withData(m: Model, loaded: Loaded, now: number): Model {
  const sessions = ordered(loaded.sessions);
  const selected = sessions.some((s) => s.id === m.selected) ? m.selected : (sessions[0]?.id ?? "");
  const confirm = sessions.some((s) => s.id === m.selected && s.need !== undefined)
    ? m.confirm
    : null;
  return { ...m, sessions, proposals: loaded.proposals, selected, confirm, now };
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

export function update(m: Model, key: string, size: Size = DEFAULT_SIZE): Model {
  if (key === "ctrl-c") return { ...m, quit: true };
  const current = selectedSession(m);
  if (m.confirm !== null && current) {
    if (key === "y") return decide(m, current, m.confirm);
    return { ...m, confirm: null, notice: "Cancelled." };
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
    case "m":
      return {
        ...m,
        mouse: !m.mouse,
        notice: m.mouse ? "Mouse off." : "Mouse on. Hold Shift (Option in iTerm2) to select text.",
      };
    case "enter":
    case "right":
      return m.section === 0 ? { ...m, focus: "card" } : m;
    case "escape":
    case "left":
      return { ...m, focus: "list" };
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

function moveSelection(m: Model, by: -1 | 1): Model {
  const at = Math.max(
    0,
    m.sessions.findIndex((s) => s.id === selectedSession(m)?.id),
  );
  const next = m.sessions[Math.min(m.sessions.length - 1, Math.max(0, at + by))];
  return { ...m, selected: next?.id ?? m.selected, notice: "", cardScroll: 0 };
}

const DEFAULT_SIZE: Size = { cols: 120, rows: 30 };
const PAGE = 10;

function cardWidthFor({ cols }: Size): number {
  return cols >= WIDE_COLS ? cols - listWidthFor(cols) - 3 : cols - 2;
}

/** Scroll the card, never past its last line. */
function scrollCard(m: Model, size: Size, by: number): Model {
  const height = size.rows - 3;
  const length = cardLines(selectedSession(m), m, cardWidthFor(size)).length;
  const max = Math.max(0, length - height);
  return { ...m, cardScroll: Math.min(max, Math.max(0, m.cardScroll + by)) };
}

function decide(m: Model, s: Session, key: "a" | "r"): Model {
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
        lines.push(inverse(fit(stripAnsi(row), width)));
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

const SEVERITY_RANK: Record<string, number> = {
  blocker: 0,
  critical: 1,
  major: 2,
  minor: 3,
  info: 4,
};

function severityStyle(severity: string, text: string): string {
  const rank = SEVERITY_RANK[severity] ?? 4;
  return rank <= 2 ? red(text) : rank === 3 ? yellow(text) : dim(text);
}

/** The end of a path is the part that tells files apart. */
function tailFit(text: string, width: number): string {
  if (text.length <= width) return text;
  return `…${text.slice(text.length - width + 1)}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return "";
  if (ms < 60_000) return ` ${(ms / 1000).toFixed(1)}s`;
  return ` ${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}`;
}

/** Tokens laid out in lines no wider than `width`, joined by `glue`. */
function flow(tokens: { text: string; plain: number }[], glue: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  let used = 0;
  for (const t of tokens) {
    if (used > 0 && used + glue.length + t.plain > width) {
      lines.push(line);
      line = t.text;
      used = t.plain;
    } else {
      line += used === 0 ? t.text : dim(glue) + t.text;
      used += used === 0 ? t.plain : glue.length + t.plain;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

function pathToken(step: PathStep, current: string): { text: string; plain: number } {
  const note = step.note ? ` ${step.note}` : "";
  if (step.slug === current) {
    const t = `◐ ${step.slug}${note}`;
    return { text: bold(yellow(t)), plain: t.length };
  }
  const plain = `${step.slug}${note} ✓`.length;
  if (step.state === "done") return { text: `${step.slug}${note} ${green("✓")}`, plain };
  if (step.state === "failed") return { text: red(`${step.slug}${note} ✗`), plain };
  return { text: dim(`${step.slug}${note}`), plain: step.slug.length + note.length };
}

const FINDINGS_SHOWN = 3;

function approveCard(s: Session, d: GateDetail, m: Model, width: number): string[] {
  const out: string[] = [];
  const inner = Math.max(10, width - 4);
  const bar = yellow("│");
  out.push(`${glyph(s, m.frame)} ${bold(s.title)}`);
  out.push(dim(`${s.id} · ${s.pipeline}`));
  if (s.workdir) out.push(dim(tailFit(s.workdir, width)));
  out.push("");
  out.push(bold(yellow(`${d.position} · ${d.node} · waiting ${formatAge(m.now - s.since)}`)));
  out.push(
    ...flow(
      d.path.map((p) => pathToken(p, d.node)),
      " → ",
      width,
    ),
  );
  out.push("");
  out.push(yellow("┌ You are asked"));
  for (const line of wrapText(d.prompt, inner)) out.push(`${bar} ${line}`);
  for (const line of wrapText(d.instructions ?? "", inner)) out.push(`${bar} ${dim(line)}`);
  if (d.comments > 0) {
    out.push(
      `${bar} ${dim(`${d.comments} comment${d.comments === 1 ? "" : "s"} recorded at this step`)}`,
    );
  }
  out.push(`${yellow("└")} ${actionLine(s, m.source === "project")}`);
  out.push("");

  const failed = d.checks.filter((c) => !c.passed);
  const passed = d.checks.length - failed.length;
  out.push(
    dim(
      `CHECKED BY THE ENGINE · ${passed} passed${failed.length ? `, ${failed.length} failed` : ""}`,
    ),
  );
  for (const c of failed) out.push(red(`✗ ${c.label}${formatMs(c.ms ?? 0)}`));
  const ok = d.checks
    .filter((c) => c.passed)
    .map((c) => {
      const t = `${c.label}${formatMs(c.ms ?? 0)}`;
      return { text: `${green("✓")} ${t}`, plain: t.length + 2 };
    });
  out.push(...flow(ok, "  ", width));
  if (d.changedAfterChecks.length > 0) {
    const n = d.changedAfterChecks.length;
    const names = d.changedAfterChecks.slice(0, 3).join(", ");
    const more = n > 3 ? ` +${n - 3}` : "";
    const text = `⚠ ${n} file${n === 1 ? "" : "s"} changed after the checks passed: ${names}${more}`;
    out.push(...wrapText(text, width).map(yellow));
  }
  out.push("");

  const c = d.changes;
  if (c.kind === "files") {
    const files = `${c.totalFiles} file${c.totalFiles === 1 ? "" : "s"}`;
    out.push(dim(`CHANGES · ${files} · ${c.totalLines} lines`));
    for (const [file, lines] of c.files.slice(0, 8)) {
      out.push(`${fit(tailFit(file, width - 7), width - 6)}${String(lines).padStart(5)}`);
    }
    if (c.files.length > 8) out.push(dim(`… ${c.files.length - 8} more`));
  } else if (c.kind === "none") {
    out.push(dim("CHANGES"), "No files changed.");
  } else if (c.kind === "unavailable") {
    out.push(
      dim("CHANGES"),
      ...wrapText(`Cannot tell what changed: ${c.reason}`, width).map(yellow),
    );
  } else {
    out.push(dim("CHANGES"), dim("This is not a git repository."));
  }
  out.push("");

  if (d.review) {
    const rows = [...d.review.findings].sort(
      (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
    );
    const counts = new Map<string, number>();
    for (const f of rows) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
    const summary = [...counts.entries()]
      .map(([sev, n]) => severityStyle(sev, `${n} ${sev}`))
      .join(dim(" · "));
    out.push(
      dim(`${d.review.node.toUpperCase()} FINDINGS · the agent's, ${d.review.completeness}`),
    );
    out.push(rows.length === 0 ? green("No findings.") : summary);
    for (const f of rows.slice(0, FINDINGS_SHOWN)) {
      out.push(`${severityStyle(f.severity, fit(f.severity, 8))}${tailFit(f.location, width - 9)}`);
      for (const line of wrapText(f.description, width - 2).slice(0, 2)) out.push(`  ${dim(line)}`);
    }
    if (rows.length > FINDINGS_SHOWN) out.push(dim(`… ${rows.length - FINDINGS_SHOWN} more`));
    out.push("");
  }

  if (d.decisions.length > 0) {
    out.push(dim("EARLIER DECISIONS"));
    for (const x of d.decisions) {
      const mark = x.decision === "approved" ? green("✓") : red("✗");
      const why = x.reason ? ` ${dim(`“${x.reason}”`)}` : "";
      out.push(`${mark} ${x.node} ${x.decision} ${dim(`${formatAge(m.now - x.ts)} ago`)}${why}`);
    }
    out.push("");
  }
  out.push(dim("JOURNAL"));
  for (const l of s.log) out.push(dim(l));
  return out.map((l) => fit(l, width));
}

/** Every line of the card; the screen shows the part from `cardScroll` on. */
function cardLines(s: Session | undefined, m: Model, width: number): string[] {
  if (!s) return [dim("No session selected.")];
  const detail = s.need === "approve" ? m.details[detailKey(s)] : undefined;
  if (detail) return approveCard(s, detail, m, width);
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
  return i === 1 ? m.proposals : 0;
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

function hints(m: Model, wide: boolean): string {
  const current = selectedSession(m);
  if (m.confirm !== null) {
    const label = current?.need ? (NEED_KEYS[current.need][m.confirm] ?? "") : "";
    return `${bold(label)} «${current?.title ?? ""}»?  ${bold("y")} yes   ${bold("n")} no`;
  }
  const move = `${bold("↑↓")} select`;
  const open = wide || m.focus === "card" ? "" : `   ${bold("Enter")} open`;
  const back = !wide && m.focus === "card" ? `   ${bold("Esc")} back` : "";
  const keys = current?.need ? NEED_KEYS[current.need] : {};
  const decide = `${keys.a ? `   ${bold("a")} ${keys.a}` : ""}${keys.r ? `   ${bold("r")} ${keys.r}` : ""}`;
  const proposals =
    m.proposals > 0
      ? dim(`   ${m.proposals} pipeline proposal${m.proposals === 1 ? "" : "s"} wait on 2`)
      : "";
  const mouse = `   ${bold("m")} mouse ${m.mouse ? green("on") : dim("off")}`;
  return `${move}${open}${back}${decide}   ${bold("Tab")} menu${mouse}   ${bold("q")} quit${proposals}`;
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

export function render(m: Model, { cols, rows }: Size): string[] {
  if (cols < 40 || rows < 12) {
    return [fit(`Terminal too small: ${cols}x${rows}, need 40x12.`, cols)];
  }
  const wide = cols >= WIDE_COLS;
  const bodyHeight = rows - 3;
  const rule = dim("─".repeat(cols));
  const out: string[] = [menuLine(m, cols), rule];

  let body: string[];
  if (m.section !== 0) {
    body = [
      "",
      `  ${bold(SECTIONS[m.section] ?? "")}`,
      dim("  Not in this prototype yet. The layout under test is menu, session list and card."),
    ];
  } else if (m.sessions.length === 0) {
    body = emptyState();
  } else {
    const current = selectedSession(m);
    if (wide) {
      const listWidth = listWidthFor(cols);
      const cardWidth = cols - listWidth - 3;
      const left = listView(m, listWidth, bodyHeight).lines;
      const right = cardWindow(
        cardLines(current, m, cardWidth),
        m.cardScroll,
        bodyHeight,
        cardWidth,
      );
      body = Array.from({ length: bodyHeight }, (_, i) => {
        const l = fit(left[i] ?? "", listWidth);
        const r = fit(right[i] ?? "", cardWidth);
        return `${l} ${dim("│")} ${r}`;
      });
    } else if (m.focus === "card") {
      body = cardWindow(cardLines(current, m, cols - 2), m.cardScroll, bodyHeight, cols - 2).map(
        (l) => ` ${l}`,
      );
    } else {
      body = listView(m, cols - 1, bodyHeight).lines.map((l) => ` ${l}`);
    }
  }
  for (let i = 0; i < bodyHeight; i++) out.push(fit(body[i] ?? "", cols));

  const status = m.notice !== "" ? green(m.notice) : hints(m, wide);
  out.push(fit(` ${status}`, cols));
  return out;
}

export type Hit = { kind: "menu"; section: number } | { kind: "session"; id: string };

/** What is under a point of the screen (1-based column and row, as the terminal reports them). */
export function hitTest(m: Model, { cols, rows }: Size, x: number, y: number): Hit | undefined {
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
  const wide = cols >= WIDE_COLS;
  if (wide) {
    if (x > listWidthFor(cols)) return undefined;
    const id = listView(m, listWidthFor(cols), bodyHeight).ids[row];
    return id === undefined ? undefined : { kind: "session", id };
  }
  if (m.focus === "card") return undefined;
  const id = listView(m, cols - 1, bodyHeight).ids[row];
  return id === undefined ? undefined : { kind: "session", id };
}

/**
 * A click selects a session or a menu item and the wheel moves the selection; nothing else. A
 * decision is never made with the mouse: it takes a key and a confirmation.
 */
export function mouseUpdate(
  m: Model,
  size: Size,
  event: Extract<InputEvent, { type: "mouse" }>,
): Model {
  if (!m.mouse || m.confirm !== null) return m;
  const wide = size.cols >= WIDE_COLS;
  if (event.action !== "press") {
    if (m.section !== 0) return m;
    const direction = event.action === "wheel_up" ? -1 : 1;
    const overCard = wide ? event.x > listWidthFor(size.cols) : m.focus === "card";
    return overCard ? scrollCard(m, size, direction * 3) : moveSelection(m, direction);
  }
  const hit = hitTest(m, size, event.x, event.y);
  if (!hit) return m;
  if (hit.kind === "menu") return { ...m, section: hit.section, notice: "" };
  if (!wide && hit.id === m.selected) return { ...m, focus: "card", notice: "" };
  return { ...m, selected: hit.id, notice: "", cardScroll: 0 };
}
