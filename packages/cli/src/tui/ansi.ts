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
export const cyan = wrap("36");

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape character is the point
const SEQUENCE = /(\u001b\[[0-9;]*m)/;

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
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
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
  for (const word of text.split(/\s+/).filter(Boolean)) {
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
