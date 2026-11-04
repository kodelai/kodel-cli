/** What the terminal sends, split into keys, mouse events and pastes. A chunk can hold several of them. */

export type InputEvent =
  | { type: "key"; name: string }
  | { type: "mouse"; action: "press" | "wheel_up" | "wheel_down"; x: number; y: number }
  /**
   * Text the terminal marked as pasted (bracketed paste): never keys, whatever it holds. `givenUp` says the paste was
   * not finished in time (or was too long): this is what came before, and the rest is being dropped.
   */
  | { type: "paste"; text: string; givenUp?: true };

const ESC = "\u001b";

const KEYS: Record<string, string> = {
  "\u001b[A": "up",
  "\u001b[B": "down",
  "\u001b[C": "right",
  "\u001b[D": "left",
  "\u001bOA": "up",
  "\u001bOB": "down",
  "\u001b[Z": "shift-tab",
  "\u001b[5~": "pageup",
  "\u001b[6~": "pagedown",
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  [ESC]: "escape",
  "\u0003": "ctrl-c",
  "\u007f": "backspace",
  "\b": "backspace",
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

function parseKeys(chunk: string): InputEvent[] {
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

/** Bracketed paste: the terminal wraps pasted text in these, so a paste can be told from typing. */
export const PASTE_ON = `${ESC}[?2004h`;
export const PASTE_OFF = `${ESC}[?2004l`;
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
/** A paste longer than this is dropped (the rest is thrown away up to its end marker), not kept in memory. */
export const PASTE_MAX = 64 * 1024;
/**
 * A paste whose end marker does not come within this long of its start is given up, so the keys are not lost for
 * good. It runs from the start of the paste, not from the last chunk: a stream of keys must not keep a paste open.
 * What the paste held so far is handed on as text; the rest is thrown away (see `DISCARD_GAP_MS`), never typed.
 */
export const PASTE_IDLE_MS = 5000;
/**
 * After a paste is given up its rest is dropped up to its end marker. A gap this long between two chunks ends that:
 * a terminal that never sends the end marker must not swallow the keys that come after a pause, while a slow link
 * that dribbles the paste in sends its pieces closer together than this.
 */
export const DISCARD_GAP_MS = 1000;
/** How long the end of a chunk that may be the beginning of the start marker (a lone ESC, `ESC [`) is waited on. */
export const HOLD_MS = 50;

export interface InputReader {
  /** The events in this chunk; what a chunk leaves unfinished (a paste, a cut-off marker) waits for the next one. */
  feed(chunk: string, now?: number): InputEvent[];
  /**
   * What was held back and is not going to be continued: a lone ESC is the Escape key, a longer cut-off marker is
   * dropped. `now` of `Infinity` gives up everything held. Called from a timer after `HOLD_MS`.
   */
  flush(now?: number): InputEvent[];
}

/**
 * A reader that remembers between chunks, because a long paste reaches the program in pieces and the markers
 * that bracket it can be cut anywhere. Inside a paste nothing is read as a key, except Ctrl-C, which always quits.
 */
export function createInputReader(): InputReader {
  let mode: "keys" | "paste" | "discard" = "keys";
  // The paste so far (paste), or the last bytes seen, enough to find the end marker (discard).
  let text = "";
  // The end of the last chunk, when it may be the beginning of a start marker, and when it was seen.
  let held = "";
  let heldAt = 0;
  let pasteAt = 0;
  // When the previous chunk came: the gap between chunks is what ends a discarded paste.
  let lastAt = 0;

  /** The longest end of `data` that is a proper beginning of the start marker (a lone ESC counts). */
  const partialStart = (data: string): number => {
    for (let n = Math.min(PASTE_START.length - 1, data.length); n >= 1; n--) {
      if (PASTE_START.startsWith(data.slice(data.length - n))) return n;
    }
    return 0;
  };

  /** What a held beginning turns into when nothing continues it. */
  const letGo = (): InputEvent[] => {
    const gone = held;
    held = "";
    return gone === ESC ? [{ type: "key", name: "escape" }] : [];
  };

  /**
   * Time passing over a paste: one that is not finished within `PASTE_IDLE_MS` is given up (what came is handed on as
   * text, what comes is dropped), and a dropped rest ends after `DISCARD_GAP_MS` of silence. Called with every chunk
   * and from a timer, so the end does not wait for a key.
   */
  const settle = (now: number): InputEvent[] => {
    const out: InputEvent[] = [];
    if (mode === "paste" && now - pasteAt > PASTE_IDLE_MS) {
      out.push({ type: "paste", text: text.length <= PASTE_MAX ? text : "", givenUp: true });
      mode = "discard";
      text = "";
    }
    if (mode === "discard" && now - lastAt > DISCARD_GAP_MS) {
      mode = "keys";
      text = "";
    }
    return out;
  };

  return {
    feed(chunk, now = Date.now()) {
      const out: InputEvent[] = [];
      if (held !== "" && now - heldAt > HOLD_MS) out.push(...letGo());
      if (mode !== "keys") {
        // Ctrl-C leaves the screen whatever a paste (or its discarded rest) holds.
        if (chunk.includes("\u0003")) {
          mode = "keys";
          text = "";
          held = "";
          lastAt = now;
          return [...out, { type: "key", name: "ctrl-c" }];
        }
        out.push(...settle(now));
      }
      // Terminals send Enter as `\r`, `\n`, `\r\n` (some links) or `\r\0` (telnet). A chunk that is exactly one of the
      // last two is one Enter press, so it can confirm a comment. It is read so only here, where the reader knows it is
      // in the middle of nothing: not inside a paste or its dropped rest, not after a held ESC, not next to another event.
      if (
        mode === "keys" &&
        held === "" &&
        out.length === 0 &&
        (chunk === "\r\n" || chunk === "\r\0")
      ) {
        lastAt = now;
        return [{ type: "key", name: "enter" }];
      }
      lastAt = now;
      let data = held + chunk;
      held = "";
      for (;;) {
        if (mode === "keys") {
          const at = data.indexOf(PASTE_START);
          if (at >= 0) {
            out.push(...parseKeys(data.slice(0, at)));
            data = data.slice(at + PASTE_START.length);
            mode = "paste";
            text = "";
            pasteAt = now;
            continue;
          }
          const keep = partialStart(data);
          const keys = keep > 0 ? data.slice(0, data.length - keep) : data;
          out.push(...parseKeys(keys));
          held = keep > 0 ? data.slice(data.length - keep) : "";
          heldAt = now;
          return out;
        }
        text += data;
        const end = text.indexOf(PASTE_END);
        if (end >= 0) {
          if (mode === "paste" && end <= PASTE_MAX)
            out.push({ type: "paste", text: text.slice(0, end) });
          data = text.slice(end + PASTE_END.length);
          text = "";
          mode = "keys";
          continue;
        }
        if (mode === "paste" && text.length > PASTE_MAX) {
          // Too long to keep: nothing of it is handed on, but the person is told why the keys are dropped.
          mode = "discard";
          text = "";
          out.push({ type: "paste", text: "", givenUp: true });
        }
        if (mode === "discard") text = text.slice(-(PASTE_END.length - 1));
        return out;
      }
    },
    flush(now = Date.now()) {
      // `Infinity` is "give up what is held", not "let the time run out": a paste that is still open is left alone.
      const out = Number.isFinite(now) && mode !== "keys" ? settle(now) : [];
      if (held !== "" && now - heldAt >= HOLD_MS) out.push(...letGo());
      return out;
    },
  };
}

/** The events in one chunk, read with a reader that starts empty: a chunk that stands alone, with nothing held back. */
export function parseInput(chunk: string): InputEvent[] {
  const reader = createInputReader();
  return [...reader.feed(chunk, 0), ...reader.flush(Number.POSITIVE_INFINITY)];
}
