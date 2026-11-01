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

/** Width on screen. Every glyph the screens use takes one column. */
export function visibleLength(text: string): number {
  return [...stripAnsi(text)].length;
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
      if (count >= width - 1) break;
      out += ch;
      count++;
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
