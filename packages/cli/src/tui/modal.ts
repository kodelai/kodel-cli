/**
 * The window a decision is asked in: a box in the middle of the screen over the screen dimmed, as the
 * legend of the Report is shown. It holds the question (what changed, the comments that go back with a
 * rejection), or the reason being typed, and the buttons that answer it. The same geometry draws it and
 * tells a click which button it hit.
 */
import { bold, dim, fit, inverse, neutralize, stripAnsi } from "./ansi";
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
}

const WIDTH = 92;
const VERB = { approve: "Approve", reject: "Reject", resume: "Resume" } as const;

/** Cuts a line into pieces of `width` characters, keeping its indentation on the first piece. */
export function hardWrap(line: string, width: number): string[] {
  const chars = [...neutralize(line)];
  if (chars.length <= width) return [chars.join("")];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += width) out.push(chars.slice(i, i + width).join(""));
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

/** The box for a decision that is being made, on a body `height` rows tall and `cols` wide. */
export function modalOf(f: Flow, cols: number, height: number): Modal {
  const width = Math.max(36, Math.min(cols - 4, WIDTH));
  const inner = width - 4;
  const all = contentOf(f, inner);
  // The title, the borders, a gap and the row of buttons are not content.
  const room = Math.max(3, height - 7);
  const maxScroll = Math.max(0, all.length - room);
  const scroll = Math.min(maxScroll, Math.max(0, f.scroll));
  const shown = all.slice(scroll, scroll + room);
  const title = titleOf(f);
  const hint =
    maxScroll > 0 ? ` ↑↓ scroll ${scroll + 1}-${scroll + shown.length} of ${all.length} ` : "";
  const left = Math.max(0, Math.floor((cols - width) / 2));

  const buttons = buttonsOf(f);
  const rowOf = (text: string) => `│ ${fit(text, inner)} │`;
  const lines = [
    `┌─${bold(title)}${"─".repeat(Math.max(0, width - 3 - title.length))}┐`,
    ...shown.map((line) => rowOf(line)),
  ];
  const buttonRow = lines.length + 1;
  lines.push(rowOf(""));
  let offset = 0;
  const placed: ModalButton[] = [];
  const styled: string[] = [];
  for (const b of buttons) {
    placed.push({
      key: b.key,
      text: b.text,
      row: 0,
      x0: left + 2 + offset,
      x1: left + 2 + offset + b.text.length,
    });
    styled.push(inverse(b.text));
    offset += b.text.length + 2;
  }
  const buttonLine = styled.join("  ");
  lines.push(`│ ${buttonLine}${" ".repeat(Math.max(0, inner - stripAnsi(buttonLine).length))} │`);
  lines.push(`└─${dim(hint)}${"─".repeat(Math.max(0, width - 3 - hint.length))}┘`);

  const top = Math.max(0, Math.floor((height - lines.length) / 2));
  for (const b of placed) b.row = top + buttonRow;
  return { box: lines, top, left, buttons: placed, maxScroll };
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
