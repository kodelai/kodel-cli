/**
 * The window a question is asked in: a box in the middle of the screen over the screen dimmed, as the
 * legend of the Report is shown. A decision holds the question (what changed, the comments that go back
 * with a rejection), or the reason being typed, and the buttons that answer it; the start and resume
 * questions of a background agent and the form of a new task are drawn with the same box (`boxOf`). The
 * same geometry draws it and tells a click which button it hit.
 */
import {
  bold,
  clip,
  dim,
  fit,
  inverse,
  neutralize,
  RESET,
  SEQUENCE,
  stripAnsi,
  visibleLength,
} from "./ansi";
import type { Flow } from "./decision-flow";

export interface ModalButton {
  /** The key a click on it stands for. */
  key: string;
  text: string;
  /** Where it is on the body of the screen: the row, and the columns from `x0` up to `x1` (0-based). */
  row: number;
  x0: number;
  x1: number;
}

export interface Modal {
  /** The whole box, one string per row. */
  box: string[];
  top: number;
  left: number;
  buttons: ModalButton[];
  /** How many lines of the content are scrolled off the top at most. */
  maxScroll: number;
  /** How many lines of the content the window shows at once. */
  room: number;
}

const WIDTH = 92;
const VERB = { approve: "Approve", reject: "Reject", resume: "Resume" } as const;

/**
 * Cuts a line into pieces of `width` columns, keeping its indentation on the first piece. The line may be
 * styled: a style sequence takes no column and is never cut in two, and a style that is open where the line
 * is cut is closed at the end of the piece and opened again at the start of the next, so every piece is
 * balanced and nothing bleeds onto the border or the rows after it.
 */
export function hardWrap(line: string, width: number): string[] {
  const text = neutralize(line);
  if (visibleLength(text) <= width) return [text];
  // Cut by display columns: a wide character (CJK, emoji) takes two.
  const out: string[] = [];
  let piece = "";
  let columns = 0;
  // The style sequences in force, in the order they were opened.
  let open: string[] = [];
  for (const [i, part] of text.split(SEQUENCE).entries()) {
    if (i % 2 === 1) {
      piece += part;
      open = part === RESET ? [] : [...open, part];
      continue;
    }
    for (const ch of part) {
      const w = visibleLength(ch);
      if (columns + w > width && columns > 0) {
        out.push(open.length > 0 ? `${piece}${RESET}` : piece);
        piece = open.join("");
        columns = 0;
      }
      piece += ch;
      columns += w;
    }
  }
  if (piece !== "") out.push(piece);
  return out;
}

function contentOf(f: Flow, inner: number): string[] {
  switch (f.phase) {
    case "asking":
      return ["Checking…"];
    case "reason":
      return [
        "Why is it rejected? The agent gets this back with the rejection.",
        "",
        ...hardWrap(`${f.text}▏`, inner),
      ];
    case "confirm":
    case "writing": {
      const question = f.questions[Math.min(f.at, f.questions.length - 1)] ?? "";
      return question.split("\n").flatMap((line) => hardWrap(line, inner));
    }
  }
}

function buttonsOf(f: Flow): { key: string; text: string }[] {
  switch (f.phase) {
    case "asking":
      return [{ key: "escape", text: "[Esc Cancel]" }];
    case "reason":
      return [
        { key: "enter", text: "[Enter OK]" },
        { key: "escape", text: "[Esc Cancel]" },
      ];
    case "confirm":
      return [
        { key: "y", text: "[y Yes]" },
        { key: "n", text: "[n No]" },
      ];
    case "writing":
      return [];
  }
}

function titleOf(f: Flow): string {
  const step =
    f.questions.length > 1 && f.phase === "confirm"
      ? ` (${f.at + 1} of ${f.questions.length})`
      : "";
  return ` ${VERB[f.decision]}${step} «${f.title}» `;
}

/** What a box holds: its title, its content as lines for `inner` columns, and the buttons under them. */
export interface BoxSpec {
  title: string;
  /** The content for the inner width the box offers (`innerWidth(cols)`). */
  content: string[];
  /**
   * Lines that are always in view, under the content and above the buttons (the keys of a window that
   * cannot scroll); they take their room from the content.
   */
  footer?: string[];
  buttons: { key: string; text: string }[];
  /**
   * How many lines are scrolled off the top; `"end"` keeps the end in view (text being typed);
   * `{ anchor }` keeps that line of the content in view, scrolling no further than it has to.
   */
  scroll: number | "end" | { anchor: number };
  /**
   * Whether the arrows scroll the content: the hint `↑↓ scroll a-b of N` is printed only then. A window whose
   * arrows do something else (cancel the question, move between fields) says nothing about scrolling.
   */
  scrollable?: boolean;
}

/** The columns a box's content has on a screen `cols` wide. */
export function innerWidth(cols: number): number {
  return Math.max(36, Math.min(cols - 4, WIDTH)) - 4;
}

/** A box on a body `height` rows tall and `cols` wide, centred. */
export function boxOf(spec: BoxSpec, cols: number, height: number): Modal {
  const width = Math.max(36, Math.min(cols - 4, WIDTH));
  const inner = width - 4;
  const all = spec.content;
  const footer = spec.footer ?? [];
  // The title, the borders, a gap and the row of buttons are not content; nor is the footer.
  const room = Math.max(3, height - 7 - footer.length);
  const maxScroll = Math.max(0, all.length - room);
  const scroll =
    spec.scroll === "end"
      ? maxScroll
      : typeof spec.scroll === "number"
        ? Math.min(maxScroll, Math.max(0, spec.scroll))
        : Math.min(maxScroll, Math.max(0, spec.scroll.anchor - room + 1));
  const shown = all.slice(scroll, scroll + room);
  // A long title (it is the run's) must not push the corner of the box out; a wide character takes two columns.
  const title = clip(spec.title, width - 6);
  const titleWidth = visibleLength(title);
  const hint =
    maxScroll > 0 && (spec.scrollable ?? true)
      ? ` ↑↓ scroll ${scroll + 1}-${scroll + shown.length} of ${all.length} `
      : "";
  const left = Math.max(0, Math.floor((cols - width) / 2));

  const buttons = spec.buttons;
  const rowOf = (text: string) => `│ ${fit(text, inner)} │`;
  const lines = [
    `┌─${bold(title)}${"─".repeat(Math.max(0, width - 3 - titleWidth))}┐`,
    ...shown.map((line) => rowOf(line)),
    ...footer.map((line) => rowOf(line)),
  ];
  const buttonRow = lines.length + 1;
  lines.push(rowOf(""));
  let offset = 0;
  const placed: ModalButton[] = [];
  const styled: string[] = [];
  for (const b of buttons) {
    // A click is a column, so a button's box is measured in columns, not in characters: a wide one takes two.
    const columns = visibleLength(b.text);
    placed.push({
      key: b.key,
      text: b.text,
      row: 0,
      x0: left + 2 + offset,
      x1: left + 2 + offset + columns,
    });
    styled.push(inverse(b.text));
    offset += columns + 2;
  }
  const buttonLine = styled.join("  ");
  lines.push(`│ ${buttonLine}${" ".repeat(Math.max(0, inner - visibleLength(buttonLine)))} │`);
  lines.push(`└─${dim(hint)}${"─".repeat(Math.max(0, width - 3 - hint.length))}┘`);

  const top = Math.max(0, Math.floor((height - lines.length) / 2));
  for (const b of placed) b.row = top + buttonRow;
  return { box: lines, top, left, buttons: placed, maxScroll, room };
}

/** The box for a decision that is being made, on a body `height` rows tall and `cols` wide. */
export function modalOf(f: Flow, cols: number, height: number): Modal {
  return boxOf(
    {
      title: titleOf(f),
      content: contentOf(f, innerWidth(cols)),
      buttons: buttonsOf(f),
      // A reason being typed is read at its end, where the cursor is.
      scroll: f.phase === "reason" ? "end" : f.scroll,
    },
    cols,
    height,
  );
}

/** The box over the screen dimmed. */
export function modalOverlay(modal: Modal, body: string[], cols: number, height: number): string[] {
  const dimmed = Array.from({ length: height }, (_, i) => dim(stripAnsi(body[i] ?? "")));
  const pad = " ".repeat(modal.left);
  for (const [i, line] of modal.box.entries()) {
    if (modal.top + i < height) dimmed[modal.top + i] = fit(`${pad}${line}`, cols);
  }
  return dimmed;
}
