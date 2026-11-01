/** Colors use the 16-color palette so the terminal's own theme decides how they look. */
const ESC = "\u001b[";
export const RESET = `${ESC}0m`;

const wrap = (code: string) => (text: string) => `${ESC}${code}m${text}${RESET}`;
export const bold = wrap("1");
export const dim = wrap("2");
export const inverse = wrap("7");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("34");
export const magenta = wrap("35");
export const cyan = wrap("36");

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape character is the point
const SEQUENCE = /(\u001b\[[0-9;]*m)/;

// What can act on a terminal: an operating-system command (title, clipboard), a control string, a
// control sequence, any other escape, and the control characters themselves.
const ACTS_ON_TERMINAL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape character is the point
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[PX^_][^\u001b]*(?:\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[ -~]?|[\u0000-\u001f\u007f-\u009f]/g;

/** The colours and styles the screens write themselves; no other escape is kept. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape character is the point
const OWN_STYLE = /^\u001b\[(?:0|1|2|7|3[1-6])m$/;

/**
 * Text a person is to read, made safe to write to their terminal. What the screens show includes text
 * that an agent or a file of the project wrote (a diff, a report, a path, a reason), and a terminal
 * obeys escape sequences in it: it can set the clipboard, rewrite the window title, or move the
 * cursor and draw a gate that is not there. Only the styles the screens use themselves stay; every
 * other escape sequence and control character goes, and a tab becomes a space.
 */
export function neutralize(text: string): string {
  return text.replace(ACTS_ON_TERMINAL, (found) =>
    OWN_STYLE.test(found) ? found : found === "\t" ? " " : "",
  );
}

export function stripAnsi(text: string): string {
  return text
    .split(SEQUENCE)
    .filter((_, i) => i % 2 === 0)
    .join("");
}

/**
 * How many terminal columns a character takes: none for a combining mark, a joiner or a variation selector,
 * two for the wide scripts and emoji, one for everything else (every glyph the screens use themselves).
 */
function charWidth(code: number): number {
  if (
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0x200d ||
    code === 0x20e3
  ) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Width on screen, in terminal columns. */
export function visibleLength(text: string): number {
  let columns = 0;
  for (const ch of stripAnsi(text)) columns += charWidth(ch.codePointAt(0) ?? 0);
  return columns;
}

/** Plain text cut to `columns` columns, ending in an ellipsis when something was left out. */
export function clip(text: string, columns: number): string {
  if (columns <= 0) return "";
  if (visibleLength(text) <= columns) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (used + w > columns - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/** Cut to `width` columns (ending in an ellipsis) or pad with spaces, keeping the color codes. */
export function fit(raw: string, width: number): string {
  if (width <= 0) return "";
  // Every line of every screen passes through here on its way to the terminal.
  const text = neutralize(raw);
  const length = visibleLength(text);
  if (length <= width) return text + " ".repeat(width - length);
  let out = "";
  let count = 0;
  for (const [i, part] of text.split(SEQUENCE).entries()) {
    if (i % 2 === 1) {
      out += part;
      continue;
    }
    for (const ch of part) {
      const w = charWidth(ch.codePointAt(0) ?? 0);
      if (count + w > width - 1) break;
      out += ch;
      count += w;
    }
  }
  return `${out}${RESET}…`;
}

/** Break plain text into lines no longer than `width`, at spaces where it can. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of neutralize(text).split(/\s+/).filter(Boolean)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}
