import { describe, expect, test } from "bun:test";
import {
  ATTACH_PROTOCOL_VERSION,
  CLIENT_FRAMES,
  createChordMatcher,
  createFrameDecoder,
  createModeTracker,
  encodeBye,
  encodeChunked,
  encodeFrame,
  encodeHello,
  encodeResize,
  encodeSend,
  encodeSent,
  encodeWelcome,
  FRAME,
  type Frame,
  type FrameType,
  fromBinary,
  HOLDER_FRAMES,
  joinHeldEscape,
  MAX_FRAME_PAYLOAD,
  parseBye,
  parseHello,
  parseSend,
  parseSent,
  parseSize,
  QUERY_STRIP_PASSES,
  SessionError,
  SOCKET_PATH_MAX_BYTES,
  socketCandidates,
  socketNames,
  socketPathQualifies,
  splitOpenEscape,
  splitReplay,
  stripTerminal,
  stripTerminalQueries,
  stripThenRedact,
  TERMINAL_RESET,
  TRACKED_DEC_MODES,
  terminalResetFor,
  toBinary,
} from "../src";

const ESC = "\u001b";
const bytes = (text: string): Uint8Array => fromBinary(text);
const text = (data: Uint8Array): string => toBinary(data);
const concat = (parts: Uint8Array[]): Uint8Array => bytes(parts.map(text).join(""));

const toText = (data: Uint8Array | undefined): string => new TextDecoder().decode(data);

describe("attach frames", () => {
  test("tA_attach_frames_roundtrip", () => {
    const all: [FrameType, Uint8Array][] = [
      [FRAME.HELLO, encodeHello({ cols: 120, rows: 40 })],
      [FRAME.INPUT, encodeFrame(FRAME.INPUT, bytes("ls\r"))],
      [FRAME.RESIZE, encodeResize({ cols: 80, rows: 24 })],
      [FRAME.SEND, encodeSend({ text: "hi", submit: false })],
      [FRAME.WELCOME, encodeWelcome({ cols: 80, rows: 24 })],
      [FRAME.OUTPUT, encodeFrame(FRAME.OUTPUT, new Uint8Array([0, 255, 27, 10]))],
      [FRAME.SENT, encodeSent(7)],
      [FRAME.BYE, encodeBye({ reason: "exited", exitCode: 3 })],
      [FRAME.OUTPUT, encodeFrame(FRAME.OUTPUT)],
    ];
    const decoder = createFrameDecoder();
    const { frames, problem } = decoder.push(concat(all.map(([, frame]) => frame)));
    expect(problem).toBeUndefined();
    expect(frames.map((f) => f.type)).toEqual(all.map(([type]) => type));
    const [hello, input, resize, send, welcome, output, sent, bye, empty] = frames as Frame[];
    expect(parseHello((hello as Frame).payload)).toEqual({
      v: ATTACH_PROTOCOL_VERSION,
      size: { cols: 120, rows: 40 },
    });
    // a hello without a size is a client that does not show the terminal
    const quiet = createFrameDecoder().push(encodeHello(undefined)).frames[0] as Frame;
    expect(parseHello(quiet.payload)).toEqual({ v: ATTACH_PROTOCOL_VERSION });
    expect(text((input as Frame).payload)).toBe("ls\r");
    expect(parseSize((resize as Frame).payload)).toEqual({ cols: 80, rows: 24 });
    expect(parseSend((send as Frame).payload)).toEqual({ text: "hi", submit: false });
    expect(parseHello((welcome as Frame).payload)?.size).toEqual({ cols: 80, rows: 24 });
    expect([...(output as Frame).payload]).toEqual([0, 255, 27, 10]);
    expect(parseSent((sent as Frame).payload)).toEqual({ bytes: 7 });
    expect(parseBye((bye as Frame).payload)).toEqual({ reason: "exited", exitCode: 3 });
    expect((empty as Frame).payload.length).toBe(0);
    expect(decoder.buffered()).toBe(0);

    // a partial frame waits, byte by byte
    const slow = createFrameDecoder();
    const frame = encodeFrame(FRAME.INPUT, bytes("abc"));
    for (let i = 0; i < frame.length - 1; i++) {
      expect(slow.push(frame.subarray(i, i + 1)).frames).toEqual([]);
    }
    expect(slow.buffered()).toBe(frame.length - 1);
    expect(text((slow.push(frame.subarray(frame.length - 1)).frames[0] as Frame).payload)).toBe(
      "abc",
    );

    // output of any length is cut into frames within the limit
    const big = new Uint8Array(MAX_FRAME_PAYLOAD * 2 + 5).fill(65);
    const cut = encodeChunked(FRAME.OUTPUT, big);
    expect(cut.length).toBe(3);
    const back = createFrameDecoder().push(concat(cut)).frames;
    expect(back.reduce((sum, f) => sum + f.payload.length, 0)).toBe(big.length);
    for (const type of Object.values(FRAME)) {
      expect(CLIENT_FRAMES.has(type) !== HOLDER_FRAMES.has(type)).toBe(true);
    }
  });

  test("tA_attach_frames_dribbled_stay_linear: a frame that arrives a byte at a time is not copied once per byte", () => {
    const payload = new Uint8Array(MAX_FRAME_PAYLOAD);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const frame = encodeFrame(FRAME.INPUT, payload);
    const decoder = createFrameDecoder();
    const count = 6;
    let got = 0;
    for (let n = 0; n < count; n++) {
      for (let at = 0; at < frame.length; at++) {
        const { frames, problem } = decoder.push(frame.subarray(at, at + 1));
        expect(problem).toBeUndefined();
        if (at < frame.length - 1) {
          if (frames.length > 0) throw new Error("a frame before its last byte");
          continue;
        }
        expect(frames.length).toBe(1);
        expect(frames[0]?.payload).toEqual(payload);
        got++;
      }
      expect(decoder.buffered()).toBe(0);
    }
    expect(got).toBe(count);
    // Copying the whole buffer at every byte moves 2 GiB for each of these frames; appending into a store that
    // doubles moves each byte a few times.
    expect(decoder.moved()).toBeLessThanOrEqual(4 * count * frame.length);
    expect(decoder.moved()).toBeGreaterThanOrEqual(count * frame.length);

    // frames in pieces of every size, and many in one piece, come out the same
    const stream = concat([
      encodeFrame(FRAME.INPUT, bytes("one")),
      encodeFrame(FRAME.RESIZE, bytes('{"cols":1,"rows":2}')),
      frame,
      encodeFrame(FRAME.INPUT),
      encodeFrame(FRAME.INPUT, bytes("last")),
    ]);
    for (const step of [1, 2, 3, 5, 7, 4096, 65_536, stream.length]) {
      const pieces = createFrameDecoder();
      const out: { type: number; payload: Uint8Array }[] = [];
      for (let at = 0; at < stream.length; at += step) {
        out.push(...pieces.push(stream.subarray(at, at + step)).frames);
      }
      expect(out.map((f) => f.payload.length)).toEqual([3, 19, MAX_FRAME_PAYLOAD, 0, 4]);
      expect(toText(out[4]?.payload)).toBe("last");
      expect(out[2]?.payload).toEqual(payload);
      expect(pieces.buffered()).toBe(0);
      expect(pieces.moved(), `pieces of ${step}`).toBeLessThanOrEqual(4 * stream.length);
    }
    // a payload handed out is the caller's own: later bytes do not change it
    const own = createFrameDecoder();
    const first = own.push(encodeFrame(FRAME.INPUT, bytes("aaaa"))).frames[0]?.payload;
    own.push(encodeFrame(FRAME.INPUT, bytes("bbbb")));
    expect(toText(first)).toBe("aaaa");
  });

  test("tA_attach_frames_hostile", () => {
    const unknown = createFrameDecoder();
    expect(unknown.push(new Uint8Array([0x7f])).problem).toBe("unknown_type");
    // fail closed: nothing after the bad byte is read, however valid it looks
    const later = unknown.push(encodeFrame(FRAME.INPUT, bytes("x")));
    expect(later).toEqual({ frames: [], problem: "unknown_type" });

    const oversize = createFrameDecoder();
    const head = new Uint8Array([FRAME.INPUT, 0, 0, 0, 0]);
    new DataView(head.buffer).setUint32(1, MAX_FRAME_PAYLOAD + 1);
    // refused at the header, before any payload is buffered
    expect(oversize.push(head).problem).toBe("oversize");
    expect(oversize.buffered()).toBe(0);
    const atLimit = createFrameDecoder();
    new DataView(head.buffer).setUint32(1, MAX_FRAME_PAYLOAD);
    expect(atLimit.push(head).problem).toBeUndefined();
    expect(() => encodeFrame(FRAME.INPUT, new Uint8Array(MAX_FRAME_PAYLOAD + 1))).toThrow();

    // a good frame before the bad one is still handed out
    const mixed = createFrameDecoder().push(
      concat([encodeFrame(FRAME.INPUT, bytes("ok")), new Uint8Array([0x00])]),
    );
    expect(mixed.frames.length).toBe(1);
    expect(mixed.problem).toBe("unknown_type");

    for (const junk of [
      "",
      "{",
      "[]",
      '{"cols":0,"rows":1,"v":1}',
      '{"cols":80,"rows":24}',
      '{"v":1,"cols":80}',
      '{"v":"1"}',
    ]) {
      expect(parseHello(bytes(junk))).toBeUndefined();
    }
    expect(parseHello(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
    expect(parseSize(bytes('{"cols":80.5,"rows":24}'))).toBeUndefined();
    expect(parseSize(bytes('{"cols":99999,"rows":24}'))).toBeUndefined();
    expect(parseSend(bytes('{"text":1}'))).toBeUndefined();
    expect(parseSend(bytes('{"text":"a","submit":"yes"}'))).toBeUndefined();
    expect(parseBye(bytes("null"))).toBeUndefined();
  });

  test("tA_attach_version_mismatch: the hello of another version is read, so it can be answered with BYE", () => {
    const other = encodeHello({ cols: 80, rows: 24 }, ATTACH_PROTOCOL_VERSION + 1);
    const frame = createFrameDecoder().push(other).frames[0] as Frame;
    expect(parseHello(frame.payload)?.v).toBe(ATTACH_PROTOCOL_VERSION + 1);
    const bye = createFrameDecoder().push(encodeBye({ reason: "version", text: "v 1" }))
      .frames[0] as Frame;
    expect(bye.type).toBe(FRAME.BYE);
    expect(parseBye(bye.payload)).toEqual({ reason: "version", text: "v 1" });
  });
});

describe("detach chord", () => {
  const CHORDS = ["\u001c", `${ESC}[92;5u`, `${ESC}[27;5;92~`];

  test("tA_attach_chord_encodings", () => {
    for (const chord of CHORDS) {
      const matcher = createChordMatcher();
      const result = matcher.push(bytes(`ab${chord}cd`));
      expect(result.detach).toBe(true);
      expect(text(result.pass)).toBe("ab");
      // after the chord nothing passes any more
      expect(matcher.push(bytes("x"))).toEqual({ pass: new Uint8Array(0), detach: true });
    }
    const plain = createChordMatcher();
    const input = `hello ${ESC}[A${ESC}[1;5C éÿ\u0000${ESC}OP${ESC}[92;6u${ESC}[27;5;91~`;
    const passed = plain.push(bytes(input));
    expect(passed.detach).toBe(false);
    expect(text(passed.pass) + text(plain.flush())).toBe(input);
  });

  test("tA_attach_chord_split_read", () => {
    for (const chord of CHORDS.slice(1)) {
      for (let cut = 1; cut < chord.length; cut++) {
        const matcher = createChordMatcher();
        const first = matcher.push(bytes(`a${chord.slice(0, cut)}`));
        expect(first.detach).toBe(false);
        expect(text(first.pass)).toBe("a");
        expect(matcher.push(bytes(chord.slice(cut))).detach).toBe(true);
      }
    }
    // a held start that turns out to be another key is passed on whole, in order
    const matcher = createChordMatcher();
    expect(text(matcher.push(bytes(`${ESC}[9`)).pass)).toBe("");
    expect(text(matcher.push(bytes("1;5u")).pass)).toBe(`${ESC}[91;5u`);
    // a lone Escape is held until the caller flushes it
    expect(text(matcher.push(bytes(ESC)).pass)).toBe("");
    expect(text(matcher.flush())).toBe(ESC);
    expect(text(matcher.flush())).toBe("");
  });

  test("tA_attach_ctrl_bracket_passes_through", () => {
    for (const key of ["\u001d", `${ESC}[93;5u`, `${ESC}[27;5;93~`]) {
      const matcher = createChordMatcher();
      const result = matcher.push(bytes(key));
      expect(result.detach).toBe(false);
      expect(text(result.pass) + text(matcher.flush())).toBe(key);
    }
  });

  test("tA_attach_chord_not_inside_paste", () => {
    const start = `${ESC}[200~`;
    const end = `${ESC}[201~`;
    const pasted = `a\u001cb${ESC}[92;5uc`;
    const whole = createChordMatcher();
    const result = whole.push(bytes(`${start}${pasted}${end}`));
    expect(result.detach).toBe(false);
    expect(text(result.pass)).toBe(`${start}${pasted}${end}`);
    // the paste is over: the chord counts again
    expect(whole.push(bytes("\u001c")).detach).toBe(true);

    // the markers split over two reads, at every place
    for (let cut = 1; cut < start.length; cut++) {
      const matcher = createChordMatcher();
      let out = text(matcher.push(bytes(start.slice(0, cut))).pass);
      const second = matcher.push(bytes(`${start.slice(cut)}\u001c${end.slice(0, cut)}`));
      expect(second.detach).toBe(false);
      out += text(second.pass);
      const third = matcher.push(bytes(`${end.slice(cut)}z`));
      out += text(third.pass);
      expect(out).toBe(`${start}\u001c${end}z`);
      expect(matcher.push(bytes(`${ESC}[27;5;92~`)).detach).toBe(true);
    }
  });
});

describe("terminal reset and mode tracker", () => {
  test("tA_attach_reset_leaves_the_screen_only_when_entered", () => {
    const tracker = createModeTracker();
    const leave = `${ESC}[?1049l`;
    expect(terminalResetFor(tracker.state())).toBe(TERMINAL_RESET.slice(0, -leave.length));
    tracker.feed(bytes(`${ESC}[>1u${ESC}[>3u${ESC}[?1049h`));
    expect(terminalResetFor(tracker.state())).toBe(`${ESC}[<u${TERMINAL_RESET}`);
  });

  test("tA_attach_reset_covers_every_mode", () => {
    const groups = new Set(TRACKED_DEC_MODES.map((m) => m.group));
    expect([...groups].sort()).toEqual(["cursor", "focus", "keys", "mouse", "paste", "screen"]);
    for (const mode of [1000, 1002, 1003, 1005, 1006, 1015, 1016]) {
      expect(TERMINAL_RESET).toContain(`${ESC}[?${mode}l`); // mouse
    }
    expect(TERMINAL_RESET).toContain(`${ESC}[?1004l`); // focus events
    expect(TERMINAL_RESET).toContain(`${ESC}[?2004l`); // bracketed paste
    expect(TERMINAL_RESET).toContain(`${ESC}[<u`); // kitty keyboard
    expect(TERMINAL_RESET).toContain(`${ESC}[?1l`); // application cursor keys
    expect(TERMINAL_RESET).toContain(`${ESC}>`); // application keypad
    expect(TERMINAL_RESET).toContain(`${ESC}[?1049l`); // the alternate screen
    expect(TERMINAL_RESET).toContain(`${ESC}[?25h`); // the cursor is shown again
    // the reset asks the terminal nothing
    expect(text(stripTerminalQueries(bytes(TERMINAL_RESET)))).toBe(TERMINAL_RESET);
    // a tracker that saw every mode switched on is back at the start after the reset
    const tracker = createModeTracker();
    for (const m of TRACKED_DEC_MODES) {
      if (m.group === "screen" && m.mode !== 1049) continue;
      tracker.feed(bytes(`${ESC}[?${m.mode}${m.initial ? "l" : "h"}`));
    }
    tracker.feed(bytes(`${ESC}=${ESC}[>1u`));
    expect(tracker.prefix().length).toBeGreaterThan(0);
    tracker.feed(bytes(TERMINAL_RESET));
    expect(tracker.state()).toEqual({ dec: {}, keypad: false, kitty: [0] });
    expect(tracker.prefix().length).toBe(0);
  });

  test("tA_mode_tracker_follows_switches", () => {
    const tracker = createModeTracker();
    expect(text(tracker.prefix())).toBe("");
    expect(text(tracker.reset())).toBe("");
    for (const m of TRACKED_DEC_MODES) {
      const on = !m.initial;
      tracker.feed(bytes(`text${ESC}[?${m.mode}${on ? "h" : "l"}more`));
      expect(tracker.state().dec[m.mode]).toBe(on);
      tracker.feed(bytes(`${ESC}[?${m.mode}${on ? "l" : "h"}`));
      expect(m.mode in tracker.state().dec).toBe(false);
    }
    // several modes in one switch, an unknown one among them
    tracker.feed(bytes(`${ESC}[?1000;1006;7777h`));
    expect(tracker.state().dec).toEqual({ 1000: true, 1006: true });
    tracker.feed(bytes(`${ESC}=`));
    expect(tracker.state().keypad).toBe(true);
    // kitty keyboard: push, set on the top entry, pop
    tracker.feed(bytes(`${ESC}[>1u${ESC}[>3u`));
    expect(tracker.state().kitty).toEqual([0, 1, 3]);
    expect(tracker.pending().length).toBe(0);
    const cut = createModeTracker();
    cut.feed(bytes(`x${ESC}[?20`));
    expect(text(cut.pending())).toBe(`${ESC}[?20`);
    cut.feed(bytes("04h"));
    expect(cut.pending().length).toBe(0);
    tracker.feed(bytes(`${ESC}[=8;2u`));
    expect(tracker.state().kitty).toEqual([0, 1, 11]);
    tracker.feed(bytes(`${ESC}[<u`));
    expect(tracker.state().kitty).toEqual([0, 1]);
    const prefix = text(tracker.prefix());
    expect(prefix).toBe(`${ESC}[?1000h${ESC}[?1006h${ESC}=${ESC}[>1u`);
    expect(text(stripTerminalQueries(tracker.prefix()))).toBe(prefix);
    // the prefix, given to a fresh tracker, makes the same state; its own reset undoes exactly that
    const fresh = createModeTracker();
    fresh.feed(tracker.prefix());
    expect(fresh.state()).toEqual(tracker.state());
    fresh.feed(tracker.reset());
    expect(fresh.state()).toEqual({ dec: {}, keypad: false, kitty: [0] });
    // what is not a switch of the list changes nothing: colours, a query, a mode outside the list
    const before = tracker.state();
    tracker.feed(bytes(`${ESC}[31m${ESC}[?u${ESC}[?12h${ESC}[2J${ESC}]0;title\u0007`));
    expect(tracker.state()).toEqual(before);
    tracker.feed(bytes(`${ESC}[<5u${ESC}>${ESC}c`));
    expect(tracker.state()).toEqual({ dec: {}, keypad: false, kitty: [0] });
  });

  test("tA_mode_tracker_follows_soft_reset: DECSTR shows the cursor and puts the keypad and cursor keys back", () => {
    const tracker = createModeTracker();
    tracker.feed(bytes(`${ESC}[?25l${ESC}[?1h${ESC}=${ESC}[?1049h${ESC}[?2004h${ESC}[>1u`));
    expect(tracker.state()).toEqual({
      dec: { 25: false, 1: true, 1049: true, 2004: true },
      keypad: true,
      kitty: [0, 1],
    });
    // cut inside the sequence, as the ring may cut it
    tracker.feed(bytes(`${ESC}[!`));
    expect(tracker.state().keypad).toBe(true);
    tracker.feed(bytes("p"));
    // what a soft reset leaves alone stays
    expect(tracker.state()).toEqual({
      dec: { 1049: true, 2004: true },
      keypad: false,
      kitty: [0, 1],
    });
    expect(text(tracker.prefix())).toBe(`${ESC}[?1049h${ESC}[?2004h${ESC}[>1u`);
    // DECRQM and other sequences that end in `p` are no reset
    tracker.feed(bytes(`${ESC}[?25l${ESC}=${ESC}[?25$p${ESC}[1!p${ESC}[62;1"p`));
    expect(tracker.state().dec[25]).toBe(false);
    expect(tracker.state().keypad).toBe(true);
  });

  test("tA_mode_tracker_split_chunk", () => {
    const stream = `a${ESC}[?1049h${ESC}[?2004h${ESC}[>1u${ESC}=b${ESC}[?1004;1002h`;
    const whole = createModeTracker();
    whole.feed(bytes(stream));
    for (let cut = 1; cut < stream.length; cut++) {
      const split = createModeTracker();
      split.feed(bytes(stream.slice(0, cut)));
      split.feed(bytes(stream.slice(cut)));
      expect(split.state()).toEqual(whole.state());
    }
    const byByte = createModeTracker();
    for (const char of stream) byByte.feed(bytes(char));
    expect(byByte.state()).toEqual(whole.state());
    // an escape that never ends is not carried without bound
    const stuck = createModeTracker();
    stuck.feed(bytes(`${ESC}[${"1;".repeat(200)}`));
    stuck.feed(bytes(`${ESC}[?2004h`));
    expect(stuck.state().dec[2004]).toBe(true);
  });
});

describe("replay without terminal queries", () => {
  const QUERIES = [
    `${ESC}[c`,
    `${ESC}[0c`,
    `${ESC}[>c`,
    `${ESC}[>0c`,
    `${ESC}[=c`,
    `${ESC}[5n`,
    `${ESC}[6n`,
    `${ESC}[?6n`,
    `${ESC}]4;1;?\u0007`,
    `${ESC}]10;?\u0007`,
    `${ESC}]11;?${ESC}\\`,
    `${ESC}]12;?\u0007`,
    `${ESC}[?u`,
    `${ESC}[?2026$p`,
    `${ESC}[4$p`,
    `${ESC}[>q`,
    `${ESC}[>0q`,
    `${ESC}[18t`,
    `${ESC}P+q544e${ESC}\\`,
    `${ESC}]52;c;?\u0007`,
    `${ESC}]52;;?${ESC}\\`,
    `${ESC}]52;pc0;?\u0007`,
    `${ESC}[14t`,
    `${ESC}[14;2t`,
    `${ESC}[16t`,
    `${ESC}[19t`,
    `${ESC}[21;0t`,
    `${ESC}_Ga=q;${ESC}\\`,
    `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\`,
    // round 3
    `${ESC}Z`,
    `${ESC}[00c`,
    `${ESC}[>00c`,
    `${ESC}[=0c`,
    `${ESC}[>00q`,
    `${ESC}[x`,
    `${ESC}[0x`,
    `${ESC}[1x`,
    `${ESC}[11t`,
    `${ESC}[?m`,
    `${ESC}[?4m`,
    `${ESC}[$w`,
    `${ESC}[1$w`,
    `${ESC}[2$w`,
    `${ESC}[#R`,
    `${ESC}[?1;1;0S`,
    `${ESC}[?2;4;S`,
    `${ESC}[?3;3;256S`,
    `${ESC}]5;0;?\u0007`,
    `${ESC}]5;1;?;2;?${ESC}\\`,
    `${ESC}_Gi=7,a=T,f=24;AAAA${ESC}\\`,
    `${ESC}_Ga=p,i=7${ESC}\\`,
    `${ESC}_GI=3,a=T,q=0;AAAA${ESC}\\`,
    `${ESC}_Gf=100,i=12,q=10;AAAA${ESC}\\`,
  ];

  test("tA_replay_strips_terminal_queries", () => {
    for (const query of QUERIES) {
      expect(text(stripTerminalQueries(bytes(`a${query}b`))), JSON.stringify(query)).toBe("ab");
    }
    // (a clipboard that is set, not read back, stays)
    const kept = `${ESC}[31mred${ESC}[0m${ESC}[2J${ESC}[1;1H${ESC}]0;title\u0007${ESC}]11;#000000\u0007${ESC}]52;c;aGk=\u0007${ESC}[?2004h${ESC}[>1u${ESC}[8;24;80t${ESC}[22;0t${ESC}_Ga=T,f=24;AAAA${ESC}\\éÿ${ESC}[2x${ESC}[12t${ESC}[10;1t${ESC}[>4;2m${ESC}[1m${ESC}[0;1m${ESC}[3S${ESC}[S${ESC}[R${ESC}[1;2R${ESC}]5;0;#ff0000\u0007${ESC}_Gi=7,q=2,a=T;AAAA${ESC}\\${ESC}_Gq=1,a=p,i=7${ESC}\\${ESC}_Ga=d,d=i${ESC}\\${ESC}[!p${ESC}7${ESC}M`;
    expect(text(stripTerminalQueries(bytes(kept)))).toBe(kept);
    expect(text(splitReplay(bytes(kept)).whole)).toBe(kept);

    // a query that the end of the replay and the first live bytes make together
    for (const query of QUERIES) {
      for (let cut = 1; cut < query.length; cut++) {
        const replay = splitOpenEscape(bytes(`out${query.slice(0, cut)}`));
        expect(text(replay.whole), JSON.stringify([query, cut])).toBe("out");
        const joined = joinHeldEscape(replay.open, bytes(`${query.slice(cut)}live`));
        expect(text(joined.out), JSON.stringify([query, cut])).toBe("live");
        expect(joined.held.length).toBe(0);
      }
    }
    // an open sequence that is no query comes out whole, and stays held while it is still open
    const colour = splitOpenEscape(bytes(`x${ESC}[3`));
    expect(text(colour.whole)).toBe("x");
    const still = joinHeldEscape(colour.open, bytes("8;5"));
    expect(still.out.length).toBe(0);
    expect(text(joinHeldEscape(still.held, bytes(";1mY")).out)).toBe(`${ESC}[38;5;1mY`);
    expect(splitOpenEscape(bytes("plain")).open.length).toBe(0);
    expect(text(splitOpenEscape(bytes(`done${ESC}[0m`)).whole)).toBe(`done${ESC}[0m`);
  });

  test("tA_replay_strips_terminal_queries: a query that the cut of another one makes", () => {
    const BEL = "\u0007";
    for (const [nested, left] of [
      [`${ESC}[${ESC}[6n6n`, ""],
      [`${ESC}]52;c;${ESC}]52;c;?${BEL}?${BEL}`, ""],
      [`${ESC}[${ESC}]52;c;?${BEL}6n`, ""],
      [`${ESC}_Ga=${ESC}[14;2tq;${ESC}\\`, ""],
      [`${ESC}[>${ESC}[${ESC}[6n5nq`, ""],
      [`${ESC}${ESC}[11tZ`, ""],
      [`${ESC}[${ESC}Z0x`, ""],
      [`${ESC}[?${ESC}[#R4m`, ""],
      [`${ESC}[1${ESC}]5;0;?${BEL}$w`, ""],
      [`${ESC}[?1;1${ESC}[00c;0S`, ""],
      [`${ESC}_Gi=${ESC}[?1;1;0S7,a=T;AA${ESC}\\`, ""],
      [`${ESC}]5;0${ESC}_Gi=7;AA${ESC}\\;?${BEL}`, ""],
    ] as const) {
      expect(text(stripTerminalQueries(bytes(`x${nested}y`))), JSON.stringify(nested)).toBe(
        `x${left}y`,
      );
    }
    // as deep as the passes go, each level of another kind
    const wrap = (inner: string, level: number): string =>
      level % 2 === 0 ? `${ESC}[${inner}6n` : `${ESC}]52;c;${inner}?${BEL}`;
    let deep = "";
    for (let level = 0; level < QUERY_STRIP_PASSES - 1; level++) deep = wrap(deep, level);
    expect(text(stripTerminalQueries(bytes(`x${deep}y`)))).toBe("xy");
    // deeper than that the text is hostile: it keeps no escape character, so no query either
    for (const depth of [QUERY_STRIP_PASSES, QUERY_STRIP_PASSES + 1, 500]) {
      let hostile = "";
      for (let level = 0; level < depth; level++) hostile = wrap(hostile, level);
      const out = text(stripTerminalQueries(bytes(`x${hostile}y`)));
      expect(out.includes(ESC), String(depth)).toBe(false);
      expect(out.startsWith("x") && out.endsWith("y"), String(depth)).toBe(true);
    }
    // a megabyte of them is still one bounded piece of work
    const many = `${ESC}[`.repeat(200_000) + "6n".repeat(200_000);
    const began = performance.now();
    expect(text(stripTerminalQueries(bytes(many))).includes(ESC)).toBe(false);
    expect(performance.now() - began).toBeLessThan(5_000);
  });

  // One megabyte of each shape that could make a pattern read the same bytes again and again: a sequence that
  // never ends, its introducer or its separators repeated, queries nested in each other.
  const fill = (unit: string, size: number): string =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const HOSTILE: Record<string, (size: number) => string> = {
    "kitty a=q, no end": (n) => `${ESC}_G${fill("a=q,", n)}`,
    "kitty i=, no end": (n) => `${ESC}_G${fill("i=1,", n)}`,
    "kitty q=, no end": (n) => `${ESC}_G${fill("q=1,", n)}`,
    "kitty introducer": (n) => fill(`${ESC}_Ga=q,i=1,`, n),
    "kitty with an end": (n) => fill(`${ESC}_Gs=1,a=q,i=1;AA${ESC}\\`, n),
    "csi introducer": (n) => fill(`${ESC}[`, n),
    "csi digits": (n) => `${ESC}[?${fill("1", n)}`,
    "csi separators": (n) => `${ESC}[?1${fill(";", n)}`,
    "csi separators, repeated": (n) => fill(`${ESC}[?1${";".repeat(40)}`, n),
    "csi window report": (n) => `${ESC}[14${fill(";1", n)}`,
    "csi between bytes": (n) => fill(`${ESC}[1;2;3 `, n),
    "osc 4 pairs": (n) => `${ESC}]4${fill(";1;?", n)}`,
    "osc 4 introducer": (n) => fill(`${ESC}]4;1;?`, n),
    "osc 52": (n) => `${ESC}]52;${fill("a", n)}`,
    "osc introducer": (n) => fill(`${ESC}]`, n),
    "osc cut by escape": (n) => fill(`${ESC}]0;a${ESC}`, n),
    "dcs, no end": (n) => `${ESC}P+q${fill("a", n)}`,
    "dcs introducer": (n) => fill(`${ESC}P+q`, n),
    "apc introducer": (n) => fill(`${ESC}_`, n),
    "nested, one deep run": (n) => fill(`${ESC}[`, n / 2) + fill("6n", n / 2),
    "nested, many": (n) => fill(`${ESC}[${ESC}[6n6n`, n),
    "escape and spaces": (n) => `${ESC}${fill(" ", n)}`,
    "paste switch": (n) => `${ESC}[?${fill("2004;", n)}`,
    "private key headers": (n) => fill("-----BEGIN PRIVATE KEY-----\n", n),
    "jwt first parts": (n) => fill("-eyJaaaaaaaa", n),
    "jwt first parts, then a long second": (n) =>
      `${fill("eyJaaaaaaaa-", n / 2)}.${fill("b", n / 2)}`,
    "secret names": (n) => fill("token.", n),
    "carriage returns": (n) => fill("\r", n),
  };
  const KIB = 1024;
  const timed = (work: () => void): number => {
    const began = performance.now();
    work();
    return performance.now() - began;
  };
  /** Everything output goes through: the replay, the held end joined with live chunks, the tracker, the chord. */
  const throughTerminal = (source: string): void => {
    const data = bytes(source);
    splitReplay(data);
    stripTerminalQueries(data);
    let held = data.subarray(0, 64);
    const tracker = createModeTracker();
    for (let at = 64; at < data.length; at += 4096) {
      const chunk = data.subarray(at, at + 4096);
      tracker.feed(chunk);
      if (held.length > 0) held = joinHeldEscape(held, chunk).held;
    }
    joinHeldEscape(data.subarray(0, 64), data.subarray(64));
    tracker.prefix();
    createChordMatcher().push(data);
  };

  for (const [label, path] of [
    ["the replay, the held end, the tracker and the chord", throughTerminal],
    ["the tail", (source: string) => void stripThenRedact([source], [], true)],
  ] as const) {
    test(`tA_terminal_patterns_stay_linear: ${label}`, () => {
      for (const [name, make] of Object.entries(HOSTILE)) {
        // Small first: a quadratic pattern fails here in seconds, and is not given the megabyte to chew on.
        const small = timed(() => path(make(64 * KIB)));
        expect(small, `${name}, 64 KiB`).toBeLessThan(1_000);
        // Eight times the bytes may take eight times as long; a quadratic pattern takes sixty-four times.
        const large = timed(() => path(make(512 * KIB)));
        expect(large, `${name}, 512 KiB after ${small} ms for 64 KiB`).toBeLessThan(
          24 * Math.max(small, 10),
        );
      }
    }, 120_000);
  }

  test("tA_terminal_patterns_stay_linear: a megabyte of each is done in seconds", () => {
    for (const [name, make] of Object.entries(HOSTILE)) {
      const source = make(64 * KIB);
      expect(
        timed(() => throughTerminal(source)),
        `${name}, 64 KiB`,
      ).toBeLessThan(1_000);
      const whole = make(1024 * KIB);
      expect(
        timed(() => throughTerminal(whole)),
        name,
      ).toBeLessThan(5_000);
    }
  }, 120_000);

  test("tA_terminal_patterns_stay_linear: the kitty patterns cut what they cut before", () => {
    // a key after many commas, a payload with commas, and a command that only looks like one of the two
    const long = "s=1,v=1,".repeat(2_000);
    for (const query of [
      `${ESC}_G${long}a=q;AAAA${ESC}\\`,
      `${ESC}_G${long}i=5;AA,AA${ESC}\\`,
      `${ESC}_Ga=q,${long}t=d${ESC}\\`,
      `${ESC}_Gq=0,${long}I=5${ESC}\\`,
    ]) {
      expect(text(stripTerminalQueries(bytes(`a${query}b`))).length, query.slice(0, 40)).toBe(2);
    }
    for (const kept of [
      `${ESC}_G${long}q=2,i=5;AAAA${ESC}\\`,
      `${ESC}_Gq=1,${long}i=5${ESC}\\`,
      `${ESC}_Gf=24,${long}xa=q;a=q,i=5${ESC}\\`,
      // no end: nothing is a command yet
      `${ESC}_G${long}a=q,i=5`,
    ]) {
      expect(text(stripTerminalQueries(bytes(`a${kept}b`))), kept.slice(0, 40)).toBe(`a${kept}b`);
    }
  });

  test("tA_replay_strips_terminal_queries: the cut of a query leaves no open sequence for the live bytes", () => {
    const BEL = "\u0007";
    // the query between the two open sequences goes, and the first would then be finished by `?BEL`
    const chain = splitReplay(bytes(`out${ESC}]52;c;${ESC}[6n${ESC}[6`));
    expect(text(chain.whole)).toBe("out");
    expect(text(chain.open)).toBe(`${ESC}[6`);
    expect(text(joinHeldEscape(chain.open, bytes(`n?${BEL}live`)).out)).toBe(`?${BEL}live`);
    // a sequence another one cut short is thrown away, as a terminal does
    const aborted = splitReplay(bytes(`out${ESC}[${ESC}[${ESC}]52;c;${ESC}[`));
    expect(text(aborted.whole)).toBe("out");
    expect(text(aborted.open)).toBe(`${ESC}[`);
    // a query that begins at the last byte of the held end, and the one its cut then makes
    const held = splitOpenEscape(bytes(`${ESC}]52;c;${ESC}`));
    expect(text(held.open)).toBe(`${ESC}]52;c;${ESC}`);
    expect(text(joinHeldEscape(held.open, bytes(`]52;c;?${BEL}?${BEL}live`)).out)).toBe("live");
    // what the cut leaves open stays held for the bytes that follow
    const again = joinHeldEscape(held.open, bytes("[6n"));
    expect(again.out.length).toBe(0);
    expect(text(again.held)).toBe(`${ESC}]52;c;`);
    expect(text(joinHeldEscape(again.held, bytes(`?${BEL}live`)).out)).toBe("live");
    // a query of the live bytes alone is the program asking now: it stays
    expect(text(joinHeldEscape(bytes(`${ESC}[3`), bytes(`1m${ESC}[6nlive`)).out)).toBe(
      `${ESC}[31m${ESC}[6nlive`,
    );
    expect(text(joinHeldEscape(bytes(`${ESC}[6`), bytes(`n${ESC}[6nlive`)).out)).toBe(
      `${ESC}[6nlive`,
    );
  });

  test("tA_tail_strip_then_redact_pure", () => {
    const rules = [{ name: "zz", pattern: /ZZSECRETZZ/g }];
    // an escape sequence inside the secret would hide it from the rule
    const coloured = stripThenRedact([`see ZZSEC${ESC}[1mRETZZ here`], rules);
    expect(coloured).toBe("see [REDACTED:zz] here");
    // the secret split over two chunks, with the cursor moved between the halves
    const split = stripThenRedact(["a ZZSE", `CRE${ESC}[0m`, "TZZ b\r\n"], rules);
    expect(split).toBe("a [REDACTED:zz] b\n");
    expect(
      stripTerminal(`${ESC}]0;title\u0007${ESC}[?25l${ESC}=x\u0007\ty\rz${ESC}P+q1${ESC}\\`),
    ).toBe("x\ty\nz");
    expect(stripThenRedact([])).toBe("");
  });

  test("tA_tail_cut_private_key_after_strip: an escape sequence in the last line of a cut key does not hide it", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\r\n".repeat(3);
    const cut = `${body}-----END ${ESC}[1mRSA PRIVATE${ESC}[0m KEY-----\r\nafter\r\n`;
    expect(stripThenRedact([cut], [], true)).toBe("[REDACTED:private-key]\nafter\n");
    // a text that lost nothing is not cut at the first END line it shows
    expect(stripThenRedact(["see -----END RSA PRIVATE KEY----- above\n"])).toContain("see ");
  });
});

describe("socket path candidates", () => {
  // Not a cryptographic digest (the core takes the function): FNV-1a, run with eight seeds for 64 hex digits.
  const hash = (value: string): string => {
    let out = "";
    for (let seed = 0; seed < 8; seed++) {
      let h = 0x811c9dc5 ^ seed;
      for (const char of value) h = Math.imul(h ^ char.charCodeAt(0), 0x01000193);
      out += (h >>> 0).toString(16).padStart(8, "0");
    }
    return out;
  };
  const id = "a_000000000_0000";
  const base = { uid: 501, checkoutKey: "abcdef012345", id, hash };
  const names = socketNames(base);

  test("tA_socket_path_boundary_100_101", () => {
    expect(names.primary).toBe(`${id}-${hash("abcdef012345").slice(0, 8)}.sock`);
    const pad = (total: number): string => {
      const fixed = "/".length + "/".length + names.primary.length;
      return `/${"r".repeat(total - fixed)}`;
    };
    const at100 = socketCandidates({ ...base, runDir: pad(SOCKET_PATH_MAX_BYTES) });
    expect(at100[0]?.kind).toBe("run");
    expect(at100[0]?.path.length).toBe(100);
    const at101 = socketCandidates({ ...base, runDir: pad(SOCKET_PATH_MAX_BYTES + 1) });
    expect(at101.map((c) => c.kind)).toEqual(["tmp"]);
    // bytes, not characters
    const wide = socketCandidates({ ...base, runDir: `/${"é".repeat(40)}` });
    expect(wide.map((c) => c.kind)).toEqual(["tmp"]);
  });

  test("tA_socket_fallback_order", () => {
    const all = socketCandidates({ ...base, runDir: "/s/run/501", tmpDir: "/var/tmp/x/" });
    expect(all).toEqual([
      { kind: "run", dir: "/s/run/501", path: `/s/run/501/${names.primary}` },
      { kind: "tmpdir", dir: "/var/tmp/x/kodel-501", path: `/var/tmp/x/kodel-501/${names.hashed}` },
      { kind: "tmp", dir: "/tmp/kodel-501", path: `/tmp/kodel-501/${names.hashed}` },
    ]);
    expect(names.hashed.length).toBe(16 + ".sock".length);
    // each candidate is length-checked by itself: a long $TMPDIR is left out, the rest stays in order
    const long = socketCandidates({ ...base, runDir: "/s/run/501", tmpDir: `/${"t".repeat(120)}` });
    expect(long.map((c) => c.kind)).toEqual(["run", "tmp"]);
    for (const c of long) expect(c.path.length).toBeLessThanOrEqual(SOCKET_PATH_MAX_BYTES);
    // $TMPDIR that is /tmp is one place, not two; a relative root is no place
    const same = socketCandidates({ ...base, runDir: "/s/run/501", tmpDir: "/tmp" });
    expect(same.map((c) => c.kind)).toEqual(["run", "tmpdir"]);
    const relative = socketCandidates({ ...base, runDir: "/s/run/501", tmpDir: "tmp" });
    expect(relative.map((c) => c.kind)).toEqual(["run", "tmp"]);
  });

  test("tA_socket_path_rejects_bad_id", () => {
    for (const bad of ["..", "", "a_1_2", "../a_000000000_0000", "a_000000000_0000/x", "names"]) {
      expect(() => socketNames({ ...base, id: bad })).toThrow(SessionError);
      expect(() => socketCandidates({ ...base, id: bad, runDir: "/s/run/501" })).toThrow(
        SessionError,
      );
      expect(() =>
        socketPathQualifies("/tmp/kodel-501/x.sock", { ...base, id: bad, runDir: "/s/run/501" }),
      ).toThrow(SessionError);
    }
  });

  test("tA_socket_name_carries_checkout", () => {
    const other = socketNames({ ...base, checkoutKey: "fedcba543210" });
    expect(other.primary).not.toBe(names.primary);
    expect(other.hashed).not.toBe(names.hashed);
    expect(socketNames({ ...base, id: "a_000000000_0001" }).hashed).not.toBe(names.hashed);

    const mine = { ...base, runDir: "/s/run/501" };
    expect(socketPathQualifies(`/s/run/501/${names.primary}`, mine)).toEqual({
      kind: "run",
      dir: "/s/run/501",
    });
    // any folder named kodel-<uid> qualifies by name, whatever $TMPDIR is today
    expect(socketPathQualifies(`/elsewhere/kodel-501/${names.hashed}`, mine)).toEqual({
      kind: "fallback",
      dir: "/elsewhere/kodel-501",
    });
    const refused = [
      `/s/run/501/${other.primary}`, // the same id in another checkout
      `/tmp/kodel-501/${other.hashed}`,
      `/tmp/kodel-502/${names.hashed}`, // another user's folder
      `/s/run/502/${names.primary}`,
      `/s/run/501/${names.hashed}`, // the hashed name belongs to a fallback folder
      `/tmp/kodel-501/${names.primary}`,
      `/tmp/kodel-501/../kodel-501/${names.hashed}`,
      `tmp/kodel-501/${names.hashed}`,
      "/etc/passwd",
      `/${"x".repeat(100)}/kodel-501/${names.hashed}`,
    ];
    for (const path of refused) expect(socketPathQualifies(path, mine), path).toBeUndefined();
  });
});
