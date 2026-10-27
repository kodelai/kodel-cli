/** What the terminal sends, split into keys and mouse events. A chunk can hold several of them. */

export type InputEvent =
  | { type: "key"; name: string }
  | { type: "mouse"; action: "press" | "wheel_up" | "wheel_down"; x: number; y: number };

const ESC = "\u001b";

const KEYS: Record<string, string> = {
  "\u001b[A": "up",
  "\u001b[B": "down",
  "\u001b[C": "right",
  "\u001b[D": "left",
  "\u001bOA": "up",
  "\u001bOB": "down",
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  [ESC]: "escape",
  "\u0003": "ctrl-c",
};

export function keyName(chunk: string): string {
  return KEYS[chunk] ?? chunk;
}

/** The modifier bits (shift, alt, ctrl) a mouse report adds to the button number. */
const MODIFIERS = 4 | 8 | 16;
const MOTION = 32;

/** One report in the SGR format: `ESC [ < button ; column ; row M` (press) or `m` (release). */
function mouseEvent(sequence: string): InputEvent | undefined {
  const final = sequence.at(-1);
  if (final !== "M") return undefined; // a release says nothing a click does not
  const fields = sequence.slice(3, -1).split(";");
  if (fields.length !== 3 || !fields.every((f) => /^\d+$/.test(f))) return undefined;
  const [button = 0, x = 0, y = 0] = fields.map(Number);
  // The terminal counts columns and rows from 1; a 0 is not a place on the screen.
  if (x < 1 || y < 1 || (button & MOTION) !== 0) return undefined;
  const base = button & ~MODIFIERS;
  if (base === 0) return { type: "mouse", action: "press", x, y };
  if (base === 64) return { type: "mouse", action: "wheel_up", x, y };
  if (base === 65) return { type: "mouse", action: "wheel_down", x, y };
  return undefined;
}

export function parseInput(chunk: string): InputEvent[] {
  const out: InputEvent[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === ESC) {
      const next = chunk[i + 1];
      if (next === "[") {
        // parameter and intermediate bytes, then one final byte
        let j = i + 2;
        while (j < chunk.length && chunk.charCodeAt(j) >= 0x20 && chunk.charCodeAt(j) <= 0x3f) j++;
        if (j >= chunk.length) break; // cut off in the middle: nothing useful in the rest
        const sequence = chunk.slice(i, j + 1);
        i = j + 1;
        if (sequence.startsWith(`${ESC}[<`)) {
          const event = mouseEvent(sequence);
          if (event) out.push(event);
        } else {
          const name = KEYS[sequence];
          if (name) out.push({ type: "key", name });
        }
        continue;
      }
      if (next === "O" && i + 2 < chunk.length) {
        const name = KEYS[chunk.slice(i, i + 3)];
        if (name) out.push({ type: "key", name });
        i += 3;
        continue;
      }
      out.push({ type: "key", name: "escape" });
      i++;
      continue;
    }
    const char = String.fromCodePoint(chunk.codePointAt(i) ?? 0);
    i += char.length;
    out.push({ type: "key", name: KEYS[char] ?? char });
  }
  return out;
}

/** Turn mouse reports on (presses and the wheel, in the SGR format) or off. */
export const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
export const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`;
