import { describe, expect, test } from "bun:test";
import {
  type InputEvent,
  MOUSE_OFF,
  MOUSE_ON,
  PASTE_OFF,
  PASTE_ON,
  parseInput,
} from "../src/tui/input";

const key = (name: string): InputEvent => ({ type: "key", name });

describe("tui input", () => {
  test("keys: letters, arrows, enter, tab, escape and ctrl-c are named", () => {
    expect(parseInput("q")).toEqual([key("q")]);
    expect(parseInput("\u001b[A")).toEqual([key("up")]);
    expect(parseInput("\u001b[5~")).toEqual([key("pageup")]);
    expect(parseInput("\u001b[6~")).toEqual([key("pagedown")]);
    expect(parseInput("\u001bOB")).toEqual([key("down")]);
    expect(parseInput("\r")).toEqual([key("enter")]);
    expect(parseInput("\t")).toEqual([key("tab")]);
    expect(parseInput("\u001b")).toEqual([key("escape")]);
    expect(parseInput("\u0003")).toEqual([key("ctrl-c")]);
  });

  test("several keys in one chunk are all heard, in order", () => {
    expect(parseInput("jj\u001b[Bk")).toEqual([key("j"), key("j"), key("down"), key("k")]);
  });

  test("a left click, with its column and row", () => {
    expect(parseInput("\u001b[<0;12;7M")).toEqual([
      { type: "mouse", action: "press", x: 12, y: 7 },
    ]);
  });

  test("the wheel, also with a modifier held", () => {
    expect(parseInput("\u001b[<64;3;4M")).toEqual([
      { type: "mouse", action: "wheel_up", x: 3, y: 4 },
    ]);
    expect(parseInput("\u001b[<65;3;4M")).toEqual([
      { type: "mouse", action: "wheel_down", x: 3, y: 4 },
    ]);
    expect(parseInput("\u001b[<68;3;4M")).toEqual([
      { type: "mouse", action: "wheel_up", x: 3, y: 4 },
    ]);
  });

  test("releases, motion, other buttons and unknown reports say nothing", () => {
    expect(parseInput("\u001b[<0;12;7m")).toEqual([]);
    expect(parseInput("\u001b[<32;12;7M")).toEqual([]);
    expect(parseInput("\u001b[<2;12;7M")).toEqual([]);
    expect(parseInput("\u001b[<0;12M")).toEqual([]);
    expect(parseInput("\u001b[<;;M")).toEqual([]);
    expect(parseInput("\u001b[<0;0;0M")).toEqual([]);
    expect(parseInput("\u001b[I")).toEqual([]);
    expect(parseInput("\u001b[1;2A")).toEqual([]);
  });

  test("a click and a key in one chunk are both heard, and a cut-off report is dropped", () => {
    expect(parseInput("\u001b[<0;1;1Mq")).toEqual([
      { type: "mouse", action: "press", x: 1, y: 1 },
      key("q"),
    ]);
    expect(parseInput("q\u001b[<0;1")).toEqual([key("q")]);
  });

  test("the mode switches ask for presses in the SGR format, and undo exactly that", () => {
    expect(MOUSE_ON).toBe("\u001b[?1000h\u001b[?1006h");
    expect(MOUSE_OFF).toBe("\u001b[?1006l\u001b[?1000l");
  });

  test("task_g4jy_a_bracketed_paste_is_one_paste_event, whatever it holds", () => {
    expect(parseInput("a\u001b[200~q\rc\u001b[A\u001b[201~b")).toEqual([
      key("a"),
      { type: "paste", text: "q\rc\u001b[A" },
      key("b"),
    ]);
  });

  test("task_g4jy_a_cut_off_marker_or_a_lone_escape_in_a_chunk_that_stands_alone_is_not_held_back", () => {
    expect(parseInput("a\u001b")).toEqual([key("a"), key("escape")]);
    expect(parseInput("a\u001b[2")).toEqual([key("a")]);
  });

  test("task_g4jy_the_paste_switches_ask_for_bracketed_paste_and_undo_exactly_that", () => {
    expect(PASTE_ON).toBe("\u001b[?2004h");
    expect(PASTE_OFF).toBe("\u001b[?2004l");
  });
});
