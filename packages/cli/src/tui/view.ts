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
import type { DemoSession, SessionStatus, StepState } from "./demo";

export const SECTIONS = ["Sessions", "Pipeline", "Tasks", "Report"] as const;

export interface Model {
  section: number;
  sessions: DemoSession[];
  /** Id of the selected session, so the selection follows it when the list reorders. */
  selected: string;
  /** On a narrow terminal the list and the card take turns. */
  focus: "list" | "card";
  confirm: "approve" | "reject" | null;
  notice: string;
  quit: boolean;
}

export interface Size {
  cols: number;
  rows: number;
}

/** Below this the list and the card no longer fit side by side. */
export const WIDE_COLS = 96;

const GROUPS: { title: string; of: (s: DemoSession) => boolean }[] = [
  { title: "WAITING FOR YOU", of: (s) => s.status === "waiting" },
  { title: "RUNNING", of: (s) => s.status === "running" },
  { title: "FINISHED", of: (s) => s.status === "failed" || s.status === "done" },
];

/** Waiting sessions first, then running, then finished; the order inside a group is kept. */
export function ordered(sessions: DemoSession[]): DemoSession[] {
  return GROUPS.flatMap((g) => sessions.filter(g.of));
}

export function initialModel(sessions: DemoSession[]): Model {
  return {
    section: 0,
    sessions,
    selected: ordered(sessions)[0]?.id ?? "",
    focus: "list",
    confirm: null,
    notice: "",
    quit: false,
  };
}

function selectedSession(m: Model): DemoSession | undefined {
  return m.sessions.find((s) => s.id === m.selected) ?? ordered(m.sessions)[0];
}

export function update(m: Model, key: string): Model {
  if (key === "ctrl-c") return { ...m, quit: true };
  const current = selectedSession(m);
  if (m.confirm !== null && current) {
    if (key === "y") return decide(m, current, m.confirm);
    return { ...m, confirm: null, notice: "Cancelled." };
  }
  const list = ordered(m.sessions);
  const at = Math.max(
    0,
    list.findIndex((s) => s.id === current?.id),
  );
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
      return { ...m, selected: list[Math.max(0, at - 1)]?.id ?? m.selected, notice: "" };
    case "down":
    case "j":
      return {
        ...m,
        selected: list[Math.min(list.length - 1, at + 1)]?.id ?? m.selected,
        notice: "",
      };
    case "enter":
    case "right":
      return m.section === 0 ? { ...m, focus: "card" } : m;
    case "escape":
    case "left":
      return { ...m, focus: "list" };
    case "a":
    case "r":
      if (current?.status !== "waiting") return m;
      return { ...m, confirm: key === "a" ? "approve" : "reject", notice: "" };
    default:
      return m;
  }
}

function decide(m: Model, s: DemoSession, how: "approve" | "reject"): Model {
  const finishes = s.wait === "PROPOSAL" || s.wait === "ACK";
  const next: DemoSession = {
    ...s,
    status: finishes ? "done" : "running",
    step: finishes ? (how === "approve" ? "accepted" : "discarded") : s.step,
    wait: undefined,
  };
  return {
    ...m,
    confirm: null,
    sessions: m.sessions.map((x) => (x.id === s.id ? next : x)),
    notice: `${how === "approve" ? "Approved" : "Rejected"} ${s.title}. Demo only: nothing was written.`,
  };
}

const GLYPH: Record<SessionStatus, string> = {
  waiting: yellow("◐"),
  running: cyan("●"),
  failed: red("✗"),
  done: green("✓"),
};

const STEP_GLYPH: Record<StepState, string> = {
  done: green("✓"),
  running: cyan("●"),
  waiting: yellow("◐"),
  pending: dim("○"),
  failed: red("✗"),
};

function listLines(m: Model, width: number): { lines: string[]; selectedAt: number } {
  const lines: string[] = [];
  let selectedAt = 0;
  for (const g of GROUPS) {
    const members = m.sessions.filter(g.of);
    if (members.length === 0) continue;
    const head = `${g.title} · ${members.length}`;
    lines.push(g.title === "WAITING FOR YOU" ? bold(yellow(head)) : dim(head));
    for (const s of members) {
      const tag = s.status === "waiting" ? (s.wait ?? "") : s.step;
      const tagWidth = 9;
      const titleWidth = Math.max(8, width - 2 - 2 - tagWidth - 1 - 4 - 1);
      const bar = s.status === "waiting" ? yellow("▌") : " ";
      const row = `${bar}${GLYPH[s.status]} ${fit(s.title, titleWidth)} ${fit(tag, tagWidth)} ${s.age.padStart(4)}`;
      if (s.id === m.selected) {
        selectedAt = lines.length;
        lines.push(inverse(fit(stripAnsi(row), width)));
      } else {
        lines.push(fit(row, width));
      }
    }
    lines.push("");
  }
  return { lines, selectedAt };
}

function cardLines(s: DemoSession | undefined, width: number, height: number): string[] {
  if (!s) return [dim("No session selected.")];
  const out: string[] = [];
  out.push(`${GLYPH[s.status]} ${bold(s.title)}`);
  out.push(dim(`${s.id} · ${s.pipeline} · ${s.agent}`));
  out.push(dim(`${s.workdir} · ${s.age} · ${s.cost}`));
  out.push("");
  if (s.status === "waiting") {
    out.push(yellow(`┌ ${s.wait} · waiting ${s.age}`));
    for (const line of wrapText(s.summary ?? "", width - 4)) out.push(`${yellow("│")} ${line}`);
    for (const f of s.files ?? []) out.push(`${yellow("│")} ${dim(f)}`);
    out.push(`${yellow("└")} ${bold("a")} approve   ${bold("r")} reject`);
    out.push("");
  }
  if (s.steps.length > 0) {
    out.push(dim("STEPS"));
    for (const st of s.steps) {
      out.push(`${STEP_GLYPH[st.state]} ${fit(st.name, 14)} ${dim(st.took ?? "")}`);
    }
    out.push("");
  }
  // The journal is the tail: when the card is short, the newest records stay.
  const room = Math.max(1, height - out.length - 1);
  out.push(dim("JOURNAL"));
  for (const l of s.log.slice(-room)) out.push(dim(l));
  return out.map((l) => fit(l, width));
}

function menuLine(m: Model, cols: number): string {
  const waiting = m.sessions.filter((s) => s.status === "waiting").length;
  const items = SECTIONS.map((name, i) => {
    const badge = i === 0 && waiting > 0 ? ` ${yellow(String(waiting))}` : "";
    const text = ` ${i + 1} ${name}${badge} `;
    return i === m.section ? inverse(stripAnsi(text)) : text;
  });
  const right = dim("main · sample data ");
  const left = `${bold(" kodel ")}${items.join("")}`;
  const gap = cols - visibleLength(left) - visibleLength(right);
  return fit(gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : left, cols);
}

function hints(m: Model, wide: boolean): string {
  if (m.confirm !== null) {
    return `${bold(m.confirm === "approve" ? "Approve" : "Reject")} this decision?  ${bold("y")} yes   ${bold("n")} no`;
  }
  const move = `${bold("↑↓")} select`;
  const open = wide || m.focus === "card" ? "" : `   ${bold("Enter")} open`;
  const back = !wide && m.focus === "card" ? `   ${bold("Esc")} back` : "";
  return `${move}${open}${back}   ${bold("a")} approve   ${bold("r")} reject   ${bold("Tab")} menu   ${bold("q")} quit`;
}

function window(lines: string[], height: number, anchor: number): string[] {
  if (lines.length <= height) return lines;
  const start = Math.min(Math.max(0, anchor - Math.floor(height / 2)), lines.length - height);
  return lines.slice(start, start + height);
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
  } else {
    const current = selectedSession(m);
    if (wide) {
      const listWidth = Math.min(54, Math.max(40, Math.floor(cols * 0.42)));
      const cardWidth = cols - listWidth - 3;
      const { lines, selectedAt } = listLines(m, listWidth);
      const left = window(lines, bodyHeight, selectedAt);
      const right = cardLines(current, cardWidth, bodyHeight).slice(0, bodyHeight);
      body = Array.from({ length: bodyHeight }, (_, i) => {
        const l = fit(left[i] ?? "", listWidth);
        const r = fit(right[i] ?? "", cardWidth);
        return `${l} ${dim("│")} ${r}`;
      });
    } else if (m.focus === "card") {
      body = cardLines(current, cols - 2, bodyHeight).map((l) => ` ${l}`);
    } else {
      const { lines, selectedAt } = listLines(m, cols - 1);
      body = window(lines, bodyHeight, selectedAt).map((l) => ` ${l}`);
    }
  }
  for (let i = 0; i < bodyHeight; i++) out.push(fit(body[i] ?? "", cols));

  const status = m.notice !== "" ? green(m.notice) : hints(m, wide);
  out.push(fit(` ${status}`, cols));
  return out;
}
