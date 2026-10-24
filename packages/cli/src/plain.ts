/**
 * Text that came from the agent (a task, a name, a file name) or from files it can write, with
 * what could mislead a person taking out: control characters (they move the cursor or fake a line),
 * the characters that reorder text (a file name can be made to read backwards), and line and
 * paragraph separators.
 */
export const UNSAFE_CODES: [from: number, to: number][] = [
  [0x00, 0x1f], // control characters
  [0x7f, 0x9f], // delete and the C1 controls
  [0xad, 0xad], // soft hyphen
  [0x34f, 0x34f], // combining grapheme joiner
  [0x61c, 0x61c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width characters and the direction marks
  [0x2028, 0x2029], // line and paragraph separators
  [0x202a, 0x202e], // embeddings and overrides
  [0x2060, 0x2069], // word joiner, invisible operators, isolates
  [0x2800, 0x2800], // blank braille
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // byte order mark, zero-width no-break space
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xe0000, 0xe007f], // tag characters
  [0xe0100, 0xe01ef], // more variation selectors
];

export function plain(text: string): string {
  let out = "";
  let skipped = false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (UNSAFE_CODES.some(([from, to]) => code >= from && code <= to)) {
      if (!skipped) out += " ";
      skipped = true;
    } else {
      out += char;
      skipped = false;
    }
  }
  return out;
}
