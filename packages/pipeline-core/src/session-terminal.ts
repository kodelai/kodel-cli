/**
 * What an attached terminal needs besides the bytes: the detach chord, the reset on the way out, the replay
 * without terminal queries, and the modes a program had switched on before the replay begins. Pure: bytes and
 * strings in, bytes and strings out.
 *
 * Terminal bytes are handled as "binary strings" (one char per byte), so a UTF-8 sequence is never decoded or
 * cut by this code.
 */
import { type RedactRule, redactCutPrivateKey, redactText } from "./redact";
import { PASTE_END, PASTE_START } from "./session";

const ESC = "\u001b";

export const toBinary = (bytes: Uint8Array): string => {
  let out = "";
  for (let at = 0; at < bytes.length; at += 8192) {
    out += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }
  return out;
};

export const fromBinary = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

// ── the detach chord ────────────────────────────────────────────────────────

/** Ctrl+\ as a terminal sends it: the raw byte, the kitty keyboard form, xterm's modifyOtherKeys form. */
export const DETACH_CHORDS: readonly string[] = ["\u001c", `${ESC}[92;5u`, `${ESC}[27;5;92~`];

const OUTSIDE_PASTE: readonly string[] = [...DETACH_CHORDS, PASTE_START];
const INSIDE_PASTE: readonly string[] = [PASTE_END];

export interface ChordMatcher {
  /**
   * The bytes to pass on to the session, and whether the chord was found (what follows it is dropped). The end
   * of a chunk that may be the start of a chord or of a paste marker is held until the next call.
   */
  push(chunk: Uint8Array): { pass: Uint8Array; detach: boolean };
  /** Hands out what is held (a lone Escape is a key of its own: the caller flushes after a short wait). */
  flush(): Uint8Array;
}

/**
 * Finds the detach chord in a client's input. It is not matched between the bracketed paste markers: a pasted
 * `0x1c` belongs to the session.
 */
export const createChordMatcher = (): ChordMatcher => {
  let held = "";
  let inPaste = false;
  let detached = false;
  return {
    push(chunk) {
      if (detached) return { pass: new Uint8Array(0), detach: true };
      let pass = "";
      for (const char of toBinary(chunk)) {
        held += char;
        while (held !== "") {
          const patterns = inPaste ? INSIDE_PASTE : OUTSIDE_PASTE;
          if (patterns.includes(held)) {
            if (held === PASTE_START || held === PASTE_END) {
              inPaste = held === PASTE_START;
              pass += held;
              held = "";
              break;
            }
            detached = true;
            held = "";
            return { pass: fromBinary(pass), detach: true };
          }
          if (patterns.some((p) => p.startsWith(held))) break;
          pass += held[0];
          held = held.slice(1);
        }
      }
      return { pass: fromBinary(pass), detach: false };
    },
    flush() {
      const out = fromBinary(held);
      held = "";
      return out;
    },
  };
};

// ── the modes a program switches on, and the reset ──────────────────────────

export type ModeGroup = "screen" | "keys" | "mouse" | "focus" | "paste" | "cursor";

export interface TrackedMode {
  mode: number;
  group: ModeGroup;
  /** The state of a fresh terminal: the reset puts the mode back to it. */
  initial: boolean;
}

/** The DEC private modes the reset puts back; the tracker follows exactly these (and the two below). */
export const TRACKED_DEC_MODES: readonly TrackedMode[] = [
  { mode: 1049, group: "screen", initial: false },
  { mode: 1047, group: "screen", initial: false },
  { mode: 47, group: "screen", initial: false },
  { mode: 1, group: "keys", initial: false },
  { mode: 1000, group: "mouse", initial: false },
  { mode: 1002, group: "mouse", initial: false },
  { mode: 1003, group: "mouse", initial: false },
  { mode: 1005, group: "mouse", initial: false },
  { mode: 1006, group: "mouse", initial: false },
  { mode: 1015, group: "mouse", initial: false },
  { mode: 1016, group: "mouse", initial: false },
  { mode: 1004, group: "focus", initial: false },
  { mode: 2004, group: "paste", initial: false },
  { mode: 25, group: "cursor", initial: true },
];

const KEYPAD_APPLICATION = `${ESC}=`;
const KEYPAD_NUMERIC = `${ESC}>`;
const KITTY_POP = `${ESC}[<u`;
const decSwitch = (mode: number, on: boolean): string => `${ESC}[?${mode}${on ? "h" : "l"}`;

/**
 * Written to a terminal on every way out of an attach, whatever the program had on. The kitty keyboard entry is
 * popped before the alternate screen is left (a terminal keeps one stack per screen); only mode 1049 is switched
 * off for the screen, it leaves the other two forms as well.
 */
export const TERMINAL_RESET: string = [
  KITTY_POP,
  ...TRACKED_DEC_MODES.filter((m) => m.group !== "screen").map((m) => decSwitch(m.mode, m.initial)),
  KEYPAD_NUMERIC,
  decSwitch(1049, false),
].join("");

export interface ModeState {
  /** Only the modes that are not in their initial state. */
  dec: Record<number, boolean>;
  keypad: boolean;
  /** The kitty keyboard flags: the base entry, then one per push. */
  kitty: number[];
}

/**
 * The reset for a terminal whose modes were followed: the alternate screen is left only when the program had
 * entered it. A terminal restores the saved cursor on that switch whatever the screen, which would move the
 * cursor of a program that never left the main one.
 */
export const terminalResetFor = (state: ModeState): string => {
  const screen = TRACKED_DEC_MODES.some((m) => m.group === "screen" && state.dec[m.mode] === true);
  const leave = decSwitch(1049, false);
  // The fixed string pops one entry of the kitty keyboard stack; a program may have pushed more.
  const pops = KITTY_POP.repeat(Math.max(0, state.kitty.length - 2));
  return pops + (screen ? TERMINAL_RESET : TERMINAL_RESET.slice(0, -leave.length));
};

export interface ModeTracker {
  /** Follows the switches in these bytes; a switch cut at the end waits for the next call. */
  feed(bytes: Uint8Array): void;
  state(): ModeState;
  /** The start of a switch that the bytes so far end in; the next bytes complete it. */
  pending(): Uint8Array;
  /** The bytes that put a fresh terminal into this state. Empty when nothing was switched; never a query. */
  prefix(): Uint8Array;
  /** The bytes that take a terminal out of exactly this state. */
  reset(): Uint8Array;
}

// Patterns are built from strings: the escape character in a regular expression literal reads as a mistake.
const CSI = /\u001b\[([?<>=]?)([0-9;:]*)([ -/]*)([@-~])/y;
const CSI_PARTIAL = /^\u001b(?:\[[?<>=]?[0-9;:]*[ -/]*)?$/;
/** A switch is short; anything longer that is still not whole is not one. */
const MAX_CARRY = 64;
const MAX_KITTY_DEPTH = 16;

export const createModeTracker = (): ModeTracker => {
  const dec = new Map<number, boolean>();
  let keypad = false;
  let kitty = [0];
  let carry = "";
  const initialOf = new Map(TRACKED_DEC_MODES.map((m) => [m.mode, m.initial]));

  const number = (text: string | undefined, fallback: number): number => {
    const n = Number.parseInt(text ?? "", 10);
    return Number.isFinite(n) ? n : fallback;
  };

  const csi = (lead: string, params: string, between: string, final: string): void => {
    if (lead === "" && params === "" && between === "!" && final === "p") {
      // DECSTR, the soft reset: the cursor shows again, the cursor keys and the keypad are as at the start.
      dec.delete(25);
      dec.delete(1);
      keypad = false;
      return;
    }
    if (between !== "") return;
    const parts = params.split(";");
    if (lead === "?" && (final === "h" || final === "l")) {
      for (const part of parts) {
        const mode = number(part, -1);
        const initial = initialOf.get(mode);
        if (initial === undefined) continue;
        if ((final === "h") === initial) dec.delete(mode);
        else dec.set(mode, final === "h");
      }
      return;
    }
    if (final !== "u") return;
    if (lead === ">") {
      if (kitty.length < MAX_KITTY_DEPTH) kitty.push(number(parts[0], 0));
    } else if (lead === "<") {
      for (let n = Math.max(1, number(parts[0], 1)); n > 0 && kitty.length > 0; n--) kitty.pop();
      // Popping the last entry leaves a stack whose flags are all off.
      if (kitty.length === 0) kitty = [0];
    } else if (lead === "=") {
      const flags = number(parts[0], 0);
      const how = number(parts[1], 1);
      const top = kitty.length - 1;
      const now = kitty[top] ?? 0;
      kitty[top] = how === 2 ? now | flags : how === 3 ? now & ~flags : flags;
    }
  };

  const state = (): ModeState => ({
    dec: Object.fromEntries(dec),
    keypad,
    kitty: [...kitty],
  });

  return {
    state,
    pending: () => fromBinary(carry),
    feed(bytes) {
      const text = carry + toBinary(bytes);
      carry = "";
      let at = text.indexOf(ESC);
      while (at >= 0) {
        const next = text[at + 1];
        if (next === undefined) {
          carry = ESC;
          break;
        }
        if (next === "[") {
          CSI.lastIndex = at;
          const match = CSI.exec(text);
          if (match) {
            csi(match[1] ?? "", match[2] ?? "", match[3] ?? "", match[4] ?? "");
            at = text.indexOf(ESC, CSI.lastIndex);
            continue;
          }
          if (text.length - at <= MAX_CARRY && CSI_PARTIAL.test(text.slice(at))) {
            carry = text.slice(at);
            break;
          }
        } else if (next === "=") keypad = true;
        else if (next === ">") keypad = false;
        else if (next === "c") {
          dec.clear();
          keypad = false;
          kitty = [0];
        }
        at = text.indexOf(ESC, at + 1);
      }
    },
    prefix() {
      let out = "";
      // The screen first: what follows (the kitty stack among it) then lands on the screen the program used.
      for (const { mode } of TRACKED_DEC_MODES) {
        const on = dec.get(mode);
        if (on !== undefined) out += decSwitch(mode, on);
      }
      if (keypad) out += KEYPAD_APPLICATION;
      const [base, ...pushed] = kitty;
      if (base !== undefined && base !== 0) out += `${ESC}[=${base};1u`;
      for (const flags of pushed) out += `${ESC}[>${flags}u`;
      return fromBinary(out);
    },
    reset() {
      let out = "";
      const [base, ...pushed] = kitty;
      for (const _ of pushed) out += KITTY_POP;
      if (base !== undefined && base !== 0) out += `${ESC}[=0;1u`;
      if (keypad) out += KEYPAD_NUMERIC;
      const screens: string[] = [];
      for (const { mode, group, initial } of TRACKED_DEC_MODES) {
        if (!dec.has(mode)) continue;
        if (group === "screen") screens.push(decSwitch(mode, initial));
        else out += decSwitch(mode, initial);
      }
      return fromBinary(out + screens.join(""));
    },
  };
};

// ── terminal queries in a replay ────────────────────────────────────────────

const KITTY_ENDS = "\\u001b_G(?=[^\\u001b]*\\u001b\\\\)";
const QUERY_SOURCES = [
  "\\u001bZ", // DECID, the device attributes of a VT52
  "\\u001b\\[[>=]?0*c", // device attributes (DA1, DA2, DA3)
  "\\u001b\\[\\??[0-9]+n", // device status, cursor position
  "\\u001b\\[\\?u", // kitty keyboard flags
  "\\u001b\\[\\??[0-9]+\\$p", // DECRQM
  "\\u001b\\[>0*q", // XTVERSION
  "\\u001b\\[[01]?x", // DECREQTPARM
  "\\u001b\\[\\?[0-9]*m", // XTQMODKEYS
  "\\u001b\\[[0-9]*\\$w", // DECRQPSR
  "\\u001b\\[#R", // XTREPORTCOLORS
  "\\u001b\\[\\?[0-9]+(?:;[0-9]*)+S", // XTSMGRAPHICS: every action of it is answered
  "\\u001b\\[(?:1[13-9]|2[01])(?:;[0-9]*)*t", // window and text area reports (XTWINOPS, also `14;2t`)
  "\\u001b\\](?:[45](?:;[0-9]+;\\?)+|1[0-9];\\?)(?:\\u0007|\\u001b\\\\)", // OSC 4, 5 and 10-19 with `?`
  "\\u001b\\]52;[a-z0-9]*;\\?(?:\\u0007|\\u001b\\\\)", // OSC 52: the clipboard is read back
  "\\u001bP[+$]q[^\\u001b\\u0007]*\\u001b\\\\", // XTGETTCAP, DECRQSS
  // The two kitty graphics patterns look for a key after any comma of a command that may be a megabyte long. The
  // end of the command is asked for first, once (`KITTY_ENDS`): without it every comma of a command that has no
  // end would be a place to read on from to the end of the text, which is quadratic.
  `${KITTY_ENDS}(?:[^;\\u001b]*,)?a=q[^\\u001b]*\\u001b\\\\`, // kitty graphics query
  // A kitty graphics command that names an image (`i=`, `I=`) is answered, unless it says not to (`q=1`, `q=2`).
  `${KITTY_ENDS}(?!(?:[^;\\u001b]*,)?q=[12](?![0-9]))(?:[^;\\u001b]*,)?[iI]=[^\\u001b]*\\u001b\\\\`,
];
// Every one begins with the escape character, and most go on with `[` or `]`: with each said once, in front, a
// text is searched for the escape character only and a sequence that is no query is left after one look.
const after = (lead: string): string =>
  QUERY_SOURCES.filter((source) => source.startsWith(lead))
    .map((source) => source.slice(lead.length))
    .join("|");
const QUERY_LEADS = ["\\u001b\\[", "\\u001b\\]"] as const;
const OTHER_QUERIES = QUERY_SOURCES.filter(
  (source) => !QUERY_LEADS.some((lead) => source.startsWith(lead)),
)
  .map((source) => source.slice("\\u001b".length))
  .join("|");
const ANY_QUERY = `\\u001b(?:\\[(?:${after(QUERY_LEADS[0])})|\\](?:${after(QUERY_LEADS[1])})|${OTHER_QUERIES})`;
const QUERIES = new RegExp(ANY_QUERY, "g");
const FIRST_QUERY = new RegExp(ANY_QUERY);
/** An escape sequence that has begun and has no end yet (CSI, OSC, DCS or APC), at the end of the text. */
const OPEN_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*|[\]P_][^\u0007\u001b]*\u001b?)?$/;
const EVERY_ESCAPE = /\u001b/g;
/** Passes over a text before it is taken for hostile; output that nests no query needs two. */
export const QUERY_STRIP_PASSES = 16;

/**
 * Cutting a query out may join the bytes around it into a new one (`ESC[` + `ESC[6n` + `6n`), so the cut is
 * repeated until nothing is found. A text that still holds one after the last pass loses every escape character:
 * only output written to defeat the filter nests that deep, and without the character there is no query.
 */
const stripQueries = (text: string): string => {
  let out = text;
  for (let pass = 0; pass < QUERY_STRIP_PASSES; pass++) {
    const next = out.replace(QUERIES, "");
    if (next.length === out.length) return out;
    out = next;
  }
  return FIRST_QUERY.test(out) ? out.replace(EVERY_ESCAPE, "") : out;
};

/**
 * Cuts out what would make the attaching terminal answer (the answer would be typed into the session). For the
 * replay only: the live stream keeps its queries.
 */
export const stripTerminalQueries = (bytes: Uint8Array): Uint8Array =>
  fromBinary(stripQueries(toBinary(bytes)));

/** Where the unfinished sequence that `text` ends in begins; the length of `text` when it ends in none. */
const openEscapeAt = (text: string, end = text.length): number => {
  const from = Math.max(0, end - MAX_CARRY);
  const match = OPEN_ESCAPE.exec(text.slice(from, end));
  return !match || match[0] === "" ? end : from + match.index;
};

/**
 * A replay ends where the output ended, which may be inside an escape sequence the live stream then completes:
 * that end is held back (`open`) and joined with the first live bytes by `joinHeldEscape`.
 */
export const splitOpenEscape = (bytes: Uint8Array): { whole: Uint8Array; open: Uint8Array } => {
  const base = Math.max(0, bytes.length - MAX_CARRY);
  const cut = base + openEscapeAt(toBinary(bytes.subarray(base)));
  if (cut >= bytes.length) return { whole: bytes, open: new Uint8Array(0) };
  return { whole: bytes.subarray(0, cut), open: bytes.slice(cut) };
};

/**
 * The history as an attaching terminal gets it: `whole` holds no query and does not end inside an escape
 * sequence, `open` is the unfinished end for `joinHeldEscape`. A sequence left unfinished in front of that end
 * (another one began before it closed, or the cut of a query laid it bare) is dropped: a terminal throws such a
 * sequence away, but what follows the replay could finish it into a query.
 */
export const splitReplay = (bytes: Uint8Array): { whole: Uint8Array; open: Uint8Array } => {
  const split = splitOpenEscape(bytes);
  const whole = stripQueries(toBinary(split.whole));
  let end = whole.length;
  for (let at = openEscapeAt(whole, end); at < end; at = openEscapeAt(whole, end)) end = at;
  return { whole: fromBinary(whole.slice(0, end)), open: split.open };
};

/**
 * The held end of a replay plus the live bytes that follow it. A query that begins in the held part is cut out,
 * and so is one that the rest of the held part then makes with the live bytes; while the sequence is still open
 * (and short) it stays held. A query of the live bytes alone stays.
 */
export const joinHeldEscape = (
  held: Uint8Array,
  live: Uint8Array,
): { out: Uint8Array; held: Uint8Array } => {
  let text = toBinary(held) + toBinary(live);
  // Where the held bytes end. Every cut moves it to the start of what was cut, so the loop ends.
  let border = held.length;
  while (border > 0) {
    const match = FIRST_QUERY.exec(text);
    if (!match || match.index >= border) break;
    text = text.slice(0, match.index) + text.slice(match.index + match[0].length);
    border = match.index;
  }
  if (border > 0 && text.length <= MAX_CARRY && OPEN_ESCAPE.exec(text)?.[0] === text) {
    return { out: new Uint8Array(0), held: fromBinary(text) };
  }
  return { out: fromBinary(text), held: new Uint8Array(0) };
};

// ── the tail that is written to disk ────────────────────────────────────────

const STRIP = [
  "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)", // OSC
  "\\u001b[PX^_][^\\u001b]*\\u001b\\\\", // DCS, SOS, PM, APC
  "\\u001b\\[[0-?]*[ -/]*[@-~]", // CSI
  "\\u001b[ -/]*[0-~]", // the short escapes
].map((source) => new RegExp(source, "g"));
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Terminal output as plain text: no escape sequences, no control characters but the newline and the tab. */
export const stripTerminal = (text: string): string => {
  let out = text;
  for (const pattern of STRIP) out = out.replace(pattern, "");
  return out.replace(/\r\n?/g, "\n").replace(CONTROLS, "");
};

/**
 * The one way terminal output reaches a file: the chunks are joined, stripped, then redacted. The order matters:
 * an escape sequence inside a secret would hide it from every rule. `cut` says the text lost its beginning: the
 * rule for a private key whose first line is gone runs too, and also after the strip (an escape sequence in the
 * last line of the key would hide that line).
 */
export const stripThenRedact = (
  chunks: readonly string[],
  rules: RedactRule[] = [],
  cut = false,
): string => {
  const plain = stripTerminal(chunks.join(""));
  return redactText(cut ? redactCutPrivateKey(plain) : plain, rules);
};
